"""
The five stages.

Each is a pure function of the database plus the providers: it claims rows in
one status, does one thing, and leaves them in another. Nothing here calls
anything else here. That is what lets n8n run them on separate schedules, retry
one without re-running the rest, and lets a stage be replaced wholesale later.

The human gate sits between `script` and `assets` and is the only transition no
stage performs. Automating generation and distribution is leverage; automating
judgement is how a channel ends up indistinguishable from every other one.
"""

from __future__ import annotations

import hashlib
import json
import random
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import db, prompts
from .config import settings
from .providers import (
    ProviderError,
    get_images,
    get_llm,
    get_publisher,
    get_renderer,
    get_script_llm,
    get_storage,
    get_transcriber,
    get_tts,
)
from .render.spec import PLATFORM_SPECS, Clip, Overlay, RenderSpec

# What one piece fans out into. Platform and format; the renderer reads
# dimensions from PLATFORM_SPECS so this stays a distribution decision.
DEFAULT_TARGETS: list[tuple[str, str]] = [
    ("youtube", "long"),
    ("youtube_short", "short"),
    ("tiktok", "short"),
    ("instagram", "short"),
    ("linkedin", "text"),
    ("x", "text"),
]

VIDEO_FORMATS = {"short", "long"}


def fingerprint(*parts: str) -> str:
    return hashlib.sha256("|".join(p.strip().lower() for p in parts if p).encode()).hexdigest()


def _work_dir(*parts: str) -> Path:
    path = Path(settings().work_dir).joinpath(*parts)
    path.mkdir(parents=True, exist_ok=True)
    return path


# --- 1. Harvest -------------------------------------------------------------


def harvest(items: list[dict], *, source: str, topic: str = "") -> dict:
    """
    Take raw candidates and keep the ones not already seen.

    Fetching is the caller's job — n8n's RSS and HTTP nodes do it better than
    Python would, and keeping it out here means a new source is a workflow
    change rather than a deploy.
    """
    added, skipped = [], 0
    for item in items:
        title = (item.get("title") or "").strip()
        if not title:
            continue
        idea_id = db.insert_idea(
            source=source,
            source_ref=item.get("url", ""),
            title=title,
            summary=item.get("summary", ""),
            topic=item.get("topic") or topic,
            fingerprint=fingerprint(title, item.get("url", "")),
            payload=item,
        )
        if idea_id:
            added.append(idea_id)
        else:
            skipped += 1

    db.record_run("harvest", status="ok", detail={"source": source, "added": len(added),
                                                 "duplicates": skipped})
    return {"added": len(added), "duplicates": skipped, "ids": added}


def score_ideas(*, topic: str, limit: int = 20) -> dict:
    """
    Rank the backlog on the cheap model.

    High call volume, no audience exposure — precisely the work that belongs on
    hardware you already pay for rather than a metered API.
    """
    ideas = db.query(
        "select id::text, title, summary from ideas where status = 'new' "
        "order by created_at limit %s", (limit,),
    )
    if not ideas:
        return {"scored": 0}

    system, prompt = prompts.score_messages(ideas=ideas, topic=topic)
    llm = get_llm()
    try:
        payload = prompts.parse_json(
            llm.complete(system=system, prompt=prompt, max_tokens=1500,
                         temperature=0.2, json_mode=True)
        )
    except (ProviderError, ValueError) as exc:
        db.record_run("score", status="error", provider=llm.name, detail={"error": str(exc)})
        raise

    scored = 0
    for entry in payload.get("scores", []):
        if db.execute("update ideas set score = %s where id = %s and status = 'new'",
                      (float(entry.get("score", 0)), entry["id"])):
            scored += 1

    db.record_run("score", status="ok", provider=llm.name, detail={"scored": scored})
    return {"scored": scored}


# --- 2. Script --------------------------------------------------------------


def script_idea(idea_id: str, *, seconds: int = 90, voice_doc: str = "",
                targets: list[tuple[str, str]] | None = None) -> dict:
    """
    One idea becomes one master script, then every cut in a second call.

    Two calls rather than one per platform: the derivation has to see the whole
    argument to pick a different strongest moment for each cut, and a shared
    master is what stops the day's output fragmenting.
    """
    idea = db.one("select * from ideas where id = %s", (idea_id,))
    if not idea:
        raise ValueError(f"no idea {idea_id}")

    targets = targets or DEFAULT_TARGETS
    llm = get_script_llm()

    system, prompt = prompts.script_messages(
        title=idea["title"], summary=idea.get("summary") or "",
        seconds=seconds, voice=voice_doc,
    )
    try:
        master = prompts.parse_json(
            llm.complete(system=system, prompt=prompt, max_tokens=3000,
                         temperature=0.8, json_mode=True)
        )
    except (ProviderError, ValueError) as exc:
        db.record_run("script", subject_type="idea", subject_id=idea_id,
                      status="error", provider=llm.name, detail={"error": str(exc)})
        raise

    piece_id = db.insert_piece(
        idea_id=idea_id,
        title=master.get("title") or idea["title"],
        script=master.get("script", ""),
        hook=master.get("hook", ""),
        topic=idea.get("topic") or "",
        llm_provider=llm.name,
    )
    db.execute("update ideas set status = 'consumed' where id = %s", (idea_id,))

    derive_system, derive_prompt = prompts.derive_messages(
        script=master.get("script", ""), targets=targets, voice=voice_doc,
    )
    try:
        cuts = prompts.parse_json(
            llm.complete(system=derive_system, prompt=derive_prompt,
                         max_tokens=4000, temperature=0.8, json_mode=True)
        ).get("cuts", [])
    except (ProviderError, ValueError) as exc:
        # The master survived; only the fan-out failed. Leaving the piece in
        # 'failed' means a retry re-derives without paying for the script again.
        db.fail("pieces", piece_id, f"derive failed: {exc}")
        raise

    variant_ids = []
    for cut in cuts:
        platform = cut.get("platform", "")
        fmt = cut.get("format", "short")
        preset = PLATFORM_SPECS.get(platform, PLATFORM_SPECS["tiktok"])
        variant_ids.append(db.insert_variant(
            piece_id=piece_id, platform=platform, format=fmt,
            width=preset["width"], height=preset["height"],
            script=cut.get("script", ""), caption=cut.get("caption", ""),
            hashtags=cut.get("hashtags", []),
        ))

    db.record_run("script", subject_type="piece", subject_id=piece_id,
                  status="ok", provider=llm.name, detail={"cuts": len(variant_ids)})
    return {"piece_id": piece_id, "variants": variant_ids, "title": master.get("title")}


def approve_piece(piece_id: str) -> dict:
    """
    The human gate.

    Approving a piece approves its cuts — reviewing the argument is the decision
    that matters; re-reading five paraphrases of it is not a second judgement.
    """
    db.execute("update pieces set status = 'approved' where id = %s and status = 'draft'",
               (piece_id,))
    changed = db.execute(
        "update variants set status = 'approved' where piece_id = %s and status = 'draft'",
        (piece_id,),
    )
    return {"piece_id": piece_id, "approved_variants": changed}


def reject_piece(piece_id: str, reason: str = "") -> dict:
    db.execute("update pieces set status = 'rejected', last_error = %s where id = %s",
               (reason or None, piece_id))
    db.execute("update variants set status = 'rejected' where piece_id = %s and status = 'draft'",
               (piece_id,))
    return {"piece_id": piece_id, "rejected": True}


# --- 3. Assets --------------------------------------------------------------


def build_assets(variant_id: str) -> dict:
    """
    Narration, footage, captions, render — then everything to storage.

    Claimed with a status transition so two workers on the same queue cannot
    both render the same cut and pay for it twice.
    """
    variant = db.one("select * from variants where id = %s", (variant_id,))
    if not variant:
        raise ValueError(f"no variant {variant_id}")

    if not db.claim("variants", variant_id, from_status="approved", to_status="rendering"):
        return {"variant_id": variant_id, "skipped": "not approved, or already claimed"}

    # Text cuts have no assets to build; they are ready the moment they are
    # approved. Still routed through here so the publisher has one queue.
    if variant["format"] not in VIDEO_FORMATS:
        db.execute("update variants set status = 'ready' where id = %s", (variant_id,))
        db.record_run("assets", subject_type="variant", subject_id=variant_id,
                      status="ok", detail={"format": variant["format"], "assets": 0})
        return {"variant_id": variant_id, "format": variant["format"], "assets": 0}

    work = _work_dir(variant_id)
    storage = get_storage()
    config = settings()

    try:
        narration = (variant.get("script") or "").strip()
        if not narration:
            raise ProviderError("assets", "variant has no narration script", retryable=False)

        # 1. Voice first — it sets the duration everything else is cut to.
        tts = get_tts()
        audio = tts.synthesize(
            text=narration,
            voice=config.default_voice,
            out_path=work / f"voice.{config.tts.options.get('format', 'mp3')}",
        )
        seconds = audio.duration_ms / 1000

        # 2. Footage, one beat per ~6 seconds of narration.
        beats = max(1, min(8, round(seconds / 6)))
        llm = get_llm()
        broll_system, broll_prompt = prompts.broll_messages(script=narration, count=beats)
        try:
            queries = prompts.parse_json(
                llm.complete(system=broll_system, prompt=broll_prompt,
                             max_tokens=500, temperature=0.5, json_mode=True)
            ).get("queries", [])
        except (ProviderError, ValueError):
            # Visual direction is a nicety; the piece title is a workable
            # fallback and is far better than failing a finished voiceover.
            queries = [variant.get("caption") or narration[:60]]

        images = get_images()
        orientation = "portrait" if variant["height"] > variant["width"] else "landscape"
        clips: list[Clip] = []
        for query in queries[:beats]:
            try:
                found = images.fetch(query=query, count=1, orientation=orientation,
                                     out_dir=work / "broll")
            except ProviderError:
                continue
            for item in found:
                clips.append(Clip(
                    src=item.path,
                    kind="video" if item.path.suffix.lower() in {".mp4", ".mov", ".webm"} else "image",
                    seconds=seconds / max(1, beats),
                ))

        if not clips:
            raise ProviderError("assets", "no usable background footage", retryable=True)

        # 3. Captions from the rendered voice, not the script — what was
        #    actually said and exactly when it was said.
        captions = get_transcriber().transcribe(audio=audio.path, out_dir=work)

        # 4. Render.
        spec = RenderSpec.for_platform(
            variant["platform"],
            output=work / f"{variant['platform']}-{variant['format']}.mp4",
            voice=audio.path,
            clips=clips,
            captions=captions.srt_path if captions.srt_path.stat().st_size else None,
            duration=seconds,
            music_gain_db=config.music_gain_db,
        )
        hook = db.one("select hook from pieces where id = %s", (variant["piece_id"],))
        if hook and hook.get("hook"):
            # A title card over the opening seconds: the hook has to land
            # visually as well as audibly on a muted autoplay.
            spec.overlays.append(Overlay(text=hook["hook"], start=0.0,
                                         end=min(3.5, seconds), position="top", size=56))

        db.set_render_spec(variant_id, json.loads(spec.to_json()))
        rendered = get_renderer().render(spec)

        # 5. Everything worth keeping goes to storage; work dirs are disposable.
        prefix = f"{variant['piece_id']}/{variant_id}"
        stored = []
        for kind, path, duration in (
            ("audio", audio.path, audio.duration_ms),
            ("caption", captions.srt_path, None),
            ("video", rendered, audio.duration_ms),
        ):
            if not path.exists() or path.stat().st_size == 0:
                continue
            key = f"{prefix}/{path.name}"
            storage.put(path, key)
            db.insert_asset(variant_id=variant_id, kind=kind, storage_key=key,
                            provider=getattr(storage, "name", "storage"),
                            duration_ms=duration, size_bytes=path.stat().st_size)
            stored.append(key)

        db.execute("update variants set status = 'ready', last_error = null where id = %s",
                   (variant_id,))
        db.record_run("assets", subject_type="variant", subject_id=variant_id,
                      status="ok", detail={"assets": len(stored), "seconds": round(seconds, 2)})
        return {"variant_id": variant_id, "assets": stored, "seconds": round(seconds, 2)}

    except Exception as exc:
        db.fail("variants", variant_id, str(exc))
        db.record_run("assets", subject_type="variant", subject_id=variant_id,
                      status="error", detail={"error": str(exc)})
        raise


# --- 4. Publish -------------------------------------------------------------


# Minutes between platforms inside one slot. Posting the same batch to every
# platform on the same second is a stronger automation signal than an exact cron
# minute, because no human publishes three places simultaneously.
PLATFORM_STAGGER_MINUTES = 9


def fill_schedule(*, slots_per_day: int = 3, days: int = 7,
                  start_hour: int = 9, jitter_minutes: int = 25) -> dict:
    """
    Assign ready cuts to posting slots.

    Three things this deliberately does, all of them about not looking like a
    bot. It spreads a platform's posts across days rather than emptying the
    queue at once, because same-platform bursts are a ban pattern. It jitters
    each slot, because an exact cron minute is a fingerprint. And it staggers
    the platforms within a slot, because simultaneous cross-platform posting is
    a louder fingerprint still.
    """
    now = datetime.now(timezone.utc)
    scheduled = []
    spacing = max(1, 12 // max(1, slots_per_day))

    for day in range(days):
        for slot in range(slots_per_day):
            base = (now + timedelta(days=day)).replace(
                hour=min(23, start_hour + slot * spacing),
                minute=random.randint(0, 59), second=0, microsecond=0,
            ) + timedelta(minutes=random.randint(-jitter_minutes, jitter_minutes))

            # Shuffled so the platform order is not itself a pattern across days.
            platforms = list(settings().platforms)
            random.shuffle(platforms)

            # One post per platform per slot, oldest first, so no platform ever
            # receives two pieces back to back.
            for index, platform in enumerate(platforms):
                when = base + timedelta(
                    minutes=index * PLATFORM_STAGGER_MINUTES
                    + random.randint(0, PLATFORM_STAGGER_MINUTES - 1)
                )
                if when <= now:
                    continue

                ready = db.variants_by_status("ready", platform=platform, limit=1)
                if not ready:
                    continue
                # Only count it if the row was still ready; another scheduler
                # running concurrently may have taken it.
                if db.schedule_variant(ready[0]["id"], when):
                    scheduled.append({"variant_id": str(ready[0]["id"]),
                                      "platform": platform, "at": when.isoformat()})

    db.record_run("schedule", status="ok", detail={"scheduled": len(scheduled)})
    return {"scheduled": len(scheduled), "slots": scheduled}


def publish_due(*, limit: int = 5) -> dict:
    """
    Ship whatever is due.

    Never generates anything — it only posts what a human already approved and
    the asset stage already rendered. That separation is what makes the buffer
    meaningful: a broken generator does not break the posting streak.
    """
    due = db.query(
        "select * from variants where status = 'queued' and scheduled_at <= now() "
        "order by scheduled_at limit %s",
        (limit,),
    )
    publisher = get_publisher()
    storage = get_storage()
    posted, failed = [], []

    for variant in due:
        variant_id = str(variant["id"])
        if not db.claim("variants", variant_id, from_status="queued", to_status="publishing"):
            continue  # another publisher took it

        try:
            media_path, media_url = None, ""
            videos = db.assets_for(variant_id, "video")
            if videos:
                key = videos[0]["storage_key"]
                media_path = storage.get(key, _work_dir("publish", variant_id) / Path(key).name)
                # Hosted publishers fetch by URL rather than accepting an upload.
                try:
                    media_url = storage.url(key)
                except ProviderError:
                    media_url = ""

            caption = variant.get("caption") or ""
            tags = variant.get("hashtags") or []
            if tags:
                caption = f"{caption}\n\n" + " ".join(f"#{t.lstrip('#')}" for t in tags)

            result = publisher.publish(
                platform=variant["platform"], caption=caption.strip(),
                media=media_path, extra={"media_url": media_url} if media_url else None,
            )

            db.record_publication(
                variant_id=variant_id, platform=variant["platform"],
                provider=result.provider, external_id=result.external_id,
                url=result.url, response=result.response,
                published_at=datetime.now(timezone.utc),
            )
            db.execute("update variants set status = 'published' where id = %s", (variant_id,))
            posted.append({"variant_id": variant_id, "platform": variant["platform"],
                           "url": result.url, "provider": result.provider})
            db.record_run("publish", subject_type="variant", subject_id=variant_id,
                          status="ok", provider=result.provider)
        except Exception as exc:
            db.fail("variants", variant_id, str(exc))
            db.record_run("publish", subject_type="variant", subject_id=variant_id,
                          status="error", detail={"error": str(exc)})
            failed.append({"variant_id": variant_id, "error": str(exc)})

    return {"posted": len(posted), "failed": len(failed),
            "details": posted, "errors": failed}


# --- 5. Metrics -------------------------------------------------------------


def collect_metrics(readings: list[dict]) -> dict:
    """
    Fold performance back in.

    Readings come from n8n, which holds the platform analytics credentials —
    the same reason harvesting lives there. Snapshots are appended rather than
    overwritten so idea scoring can eventually learn from the shape of a curve,
    not just its final total.
    """
    recorded = 0
    for reading in readings:
        publication = db.one(
            "select id::text from publications where platform = %s and external_id = %s",
            (reading.get("platform"), reading.get("external_id")),
        )
        if not publication:
            continue
        db.record_metrics(
            publication_id=publication["id"],
            views=int(reading.get("views", 0)),
            likes=int(reading.get("likes", 0)),
            comments=int(reading.get("comments", 0)),
            shares=int(reading.get("shares", 0)),
            watch_seconds=int(reading.get("watch_seconds", 0)),
            raw=reading,
        )
        recorded += 1

    db.record_run("metrics", status="ok", detail={"recorded": recorded})
    return {"recorded": recorded}
