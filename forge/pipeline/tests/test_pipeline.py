"""
The whole pipeline, end to end.

Providers are replaced with fakes so nothing leaves the machine, but every
stage, every state transition and the real renderer all run. What this proves is
the part that unit tests cannot: that an idea can travel from harvest to a
published row without a stage dropping it, and that the human gate genuinely
blocks — a piece nobody approved must not be renderable.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from forge.providers.base import AudioResult, CaptionResult, ImageResult, PublishResult

from .conftest import needs_db

pytestmark = needs_db


def _ffmpeg_available() -> bool:
    try:
        subprocess.run(["ffmpeg", "-version"], capture_output=True, check=True)
        return True
    except (FileNotFoundError, subprocess.CalledProcessError):
        return False


MASTER = {
    "title": "Why your KPI dashboard lies",
    "hook": "Your availability counter has been rounding in your favour for months.",
    "script": "Every counter on that dashboard is an average of an average. "
              "Here is the arithmetic, and here is what it hides.",
}

CUTS = {"cuts": [
    {"platform": "tiktok", "format": "short", "script": "Short narration here.",
     "caption": "The rounding error nobody checks", "hashtags": ["telecom", "kpi"]},
    {"platform": "youtube", "format": "long", "script": "Long narration here.",
     "caption": "Full breakdown", "hashtags": ["networkengineering"]},
    {"platform": "linkedin", "format": "text", "script": "",
     "caption": "Three paragraphs about rounding errors.", "hashtags": ["telecom"]},
]}


class FakeLLM:
    """Returns a canned payload per prompt shape, and counts its calls."""

    name = "fake"

    def __init__(self):
        self.calls = 0

    def complete(self, *, system, prompt, max_tokens=2000, temperature=0.7, json_mode=False):
        self.calls += 1
        if "MASTER SCRIPT:" in prompt:
            return json.dumps(CUTS)
        if "search queries" in system:
            return json.dumps({"queries": ["server room blue lights", "hands typing laptop"]})
        if "Score each idea" in prompt:
            return json.dumps({"scores": []})
        return json.dumps(MASTER)


class FakeTTS:
    name = "fake"

    def synthesize(self, *, text, voice, out_path):
        out_path.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi",
                        "-i", "sine=frequency=300:duration=4", str(out_path)], check=True)
        return AudioResult(path=out_path, duration_ms=4000, provider=self.name)


class FakeImages:
    name = "fake"

    def fetch(self, *, query, count, orientation, out_dir):
        out_dir.mkdir(parents=True, exist_ok=True)
        path = out_dir / f"{abs(hash(query))}.jpg"
        if not path.exists():
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi",
                            "-i", "color=c=navy:s=1600x900:d=1", "-frames:v", "1",
                            str(path)], check=True)
        return [ImageResult(path=path, provider=self.name)]


class FakeTranscriber:
    name = "fake"

    def transcribe(self, *, audio, out_dir):
        srt = out_dir / "captions.srt"
        srt.write_text("1\n00:00:00,000 --> 00:00:03,000\nA caption line\n\n")
        return CaptionResult(srt_path=srt, text="A caption line", provider=self.name)


class RecordingPublisher:
    """Stands in for dry_run so the test can assert what would have shipped."""

    name = "fake"

    def __init__(self):
        self.posted = []

    def publish(self, *, platform, caption, media, scheduled_at=None, extra=None):
        self.posted.append({"platform": platform, "caption": caption,
                            "media": str(media) if media else None})
        return PublishResult(platform=platform, provider=self.name,
                             external_id=f"ext-{len(self.posted)}",
                             url=f"https://example.test/{len(self.posted)}")


@pytest.fixture
def wired(clean, tmp_path, monkeypatch):
    """Swap every network-touching provider for a local fake."""
    from forge import providers, stages

    monkeypatch.setenv("WORK_DIR", str(tmp_path / "work"))
    monkeypatch.setenv("MEDIA_ROOT", str(tmp_path / "media"))
    monkeypatch.setenv("STORAGE_PROVIDER", "local")
    monkeypatch.setenv("PLATFORMS", "tiktok,youtube,linkedin")

    from forge.config import settings
    settings.cache_clear()
    for getter in (providers.get_llm, providers.get_script_llm, providers.get_tts,
                   providers.get_images, providers.get_transcriber,
                   providers.get_publisher, providers.get_storage, providers.get_renderer):
        getter.cache_clear()

    llm, publisher = FakeLLM(), RecordingPublisher()
    monkeypatch.setattr(stages, "get_llm", lambda: llm)
    monkeypatch.setattr(stages, "get_script_llm", lambda: llm)
    monkeypatch.setattr(stages, "get_tts", lambda: FakeTTS())
    monkeypatch.setattr(stages, "get_images", lambda: FakeImages())
    monkeypatch.setattr(stages, "get_transcriber", lambda: FakeTranscriber())
    monkeypatch.setattr(stages, "get_publisher", lambda: publisher)

    return {"db": clean, "stages": stages, "llm": llm, "publisher": publisher}


def test_harvest_deduplicates_across_sources(wired):
    stages = wired["stages"]
    first = stages.harvest([
        {"title": "Why KPIs lie", "url": "https://a.test/1"},
        {"title": "Something else", "url": "https://a.test/2"},
    ], source="rss")
    assert first["added"] == 2

    # The same two stories arriving again the next morning.
    second = stages.harvest([
        {"title": "Why KPIs lie", "url": "https://a.test/1"},
        {"title": "A third thing", "url": "https://a.test/3"},
    ], source="rss")
    assert second["added"] == 1
    assert second["duplicates"] == 1


def test_harvest_ignores_untitled_items(wired):
    assert wired["stages"].harvest(
        [{"url": "https://a.test/1"}, {"title": "   "}], source="rss")["added"] == 0


def test_script_fans_one_idea_into_many_cuts(wired):
    db, stages = wired["db"], wired["stages"]
    idea = db.insert_idea(source="manual", title="Why KPIs lie", fingerprint="fp")

    result = stages.script_idea(idea, seconds=60)

    assert len(result["variants"]) == 3
    assert result["title"] == MASTER["title"]
    # One call for the master, one for the fan-out — not one per platform.
    assert wired["llm"].calls == 2
    assert db.one("select status from ideas where id=%s", (idea,))["status"] == "consumed"

    platforms = {v["platform"] for v in db.variants_for(result["piece_id"])}
    assert platforms == {"tiktok", "youtube", "linkedin"}


def test_cuts_start_as_drafts_behind_the_human_gate(wired):
    db, stages = wired["db"], wired["stages"]
    idea = db.insert_idea(source="manual", title="t", fingerprint="fp")
    result = stages.script_idea(idea)

    assert all(v["status"] == "draft" for v in db.variants_for(result["piece_id"]))


def test_unapproved_cuts_cannot_be_rendered(wired):
    """The gate has to actually block, not merely be documented."""
    db, stages = wired["db"], wired["stages"]
    idea = db.insert_idea(source="manual", title="t", fingerprint="fp")
    result = stages.script_idea(idea)

    outcome = stages.build_assets(result["variants"][0])
    assert "skipped" in outcome


def test_approval_releases_every_cut(wired):
    db, stages = wired["db"], wired["stages"]
    idea = db.insert_idea(source="manual", title="t", fingerprint="fp")
    result = stages.script_idea(idea)

    assert stages.approve_piece(result["piece_id"])["approved_variants"] == 3
    assert all(v["status"] == "approved" for v in db.variants_for(result["piece_id"]))


def test_rejection_stops_the_piece(wired):
    db, stages = wired["db"], wired["stages"]
    idea = db.insert_idea(source="manual", title="t", fingerprint="fp")
    result = stages.script_idea(idea)

    stages.reject_piece(result["piece_id"], "thin argument")
    assert all(v["status"] == "rejected" for v in db.variants_for(result["piece_id"]))
    assert stages.build_assets(result["variants"][0]).get("skipped")


def test_text_cuts_need_no_assets(wired):
    """A LinkedIn post is ready the moment it is approved."""
    db, stages = wired["db"], wired["stages"]
    idea = db.insert_idea(source="manual", title="t", fingerprint="fp")
    result = stages.script_idea(idea)
    stages.approve_piece(result["piece_id"])

    text_cut = next(v for v in db.variants_for(result["piece_id"]) if v["format"] == "text")
    outcome = stages.build_assets(str(text_cut["id"]))

    assert outcome["assets"] == 0
    assert db.one("select status from variants where id=%s",
                  (text_cut["id"],))["status"] == "ready"


@pytest.mark.skipif(not _ffmpeg_available(), reason="ffmpeg not installed")
def test_video_cut_renders_and_stores_its_assets(wired):
    db, stages = wired["db"], wired["stages"]
    idea = db.insert_idea(source="manual", title="t", fingerprint="fp")
    result = stages.script_idea(idea)
    stages.approve_piece(result["piece_id"])

    video_cut = next(v for v in db.variants_for(result["piece_id"]) if v["platform"] == "tiktok")
    outcome = stages.build_assets(str(video_cut["id"]))

    assert outcome["seconds"] == pytest.approx(4.0, abs=0.5)
    kinds = {a["kind"] for a in db.assets_for(str(video_cut["id"]))}
    assert kinds == {"audio", "caption", "video"}
    assert db.one("select status from variants where id=%s",
                  (video_cut["id"],))["status"] == "ready"
    # The spec is kept so a bad render can be replayed without re-deriving it.
    assert db.one("select render_spec from variants where id=%s",
                  (video_cut["id"],))["render_spec"] is not None


@pytest.mark.skipif(not _ffmpeg_available(), reason="ffmpeg not installed")
def test_full_run_from_harvest_to_published(wired):
    db, stages, publisher = wired["db"], wired["stages"], wired["publisher"]

    stages.harvest([{"title": "Why KPIs lie", "url": "https://a.test/1"}], source="rss")
    idea = db.query("select id::text from ideas")[0]["id"]

    result = stages.script_idea(idea, seconds=45)
    stages.approve_piece(result["piece_id"])
    for variant_id in result["variants"]:
        stages.build_assets(variant_id)

    assert stages.fill_schedule(slots_per_day=3, days=2)["scheduled"] >= 1

    # Everything scheduled is in the future, so nothing is due yet.
    assert stages.publish_due()["posted"] == 0

    db.execute("update variants set scheduled_at = now() - interval '1 minute' "
               "where status = 'queued'")
    outcome = stages.publish_due(limit=10)

    assert outcome["posted"] >= 1
    assert outcome["failed"] == 0
    assert len(publisher.posted) == outcome["posted"]
    # Hashtags are appended to the caption at publish time, not stored in it.
    assert any("#telecom" in post["caption"] for post in publisher.posted)

    published = db.query("select * from publications")
    assert len(published) == outcome["posted"]
    assert all(row["published_at"] is not None for row in published)


def test_platforms_are_not_scheduled_simultaneously(wired):
    """
    Simultaneous cross-platform posting is a louder bot signal than an exact
    cron minute — no human publishes to three places on the same second.
    """
    db, stages = wired["db"], wired["stages"]
    idea = db.insert_idea(source="manual", title="t", fingerprint="fp")
    result = stages.script_idea(idea)
    stages.approve_piece(result["piece_id"])
    db.execute("update variants set status='ready' where piece_id=%s", (result["piece_id"],))

    stages.fill_schedule(slots_per_day=3, days=3)
    times = [r["scheduled_at"] for r in
             db.query("select scheduled_at from variants where status='queued'")]

    assert len(times) >= 2, "expected several cuts to be scheduled"
    assert len(set(times)) == len(times), "every post must land at its own time"


def test_scheduled_posts_are_all_in_the_future(wired):
    from datetime import datetime, timezone

    db, stages = wired["db"], wired["stages"]
    idea = db.insert_idea(source="manual", title="t", fingerprint="fp")
    result = stages.script_idea(idea)
    stages.approve_piece(result["piece_id"])
    db.execute("update variants set status='ready' where piece_id=%s", (result["piece_id"],))

    stages.fill_schedule(slots_per_day=3, days=2)
    times = [r["scheduled_at"] for r in
             db.query("select scheduled_at from variants where status='queued'")]

    assert times
    assert all(t > datetime.now(timezone.utc) for t in times)


def test_metrics_attach_to_the_right_publication(wired):
    db, stages = wired["db"], wired["stages"]
    piece = db.insert_piece(idea_id=None, title="t", script="s")
    variant = db.insert_variant(piece_id=piece, platform="tiktok", format="short",
                                width=1080, height=1920)
    db.record_publication(variant_id=variant, platform="tiktok",
                          provider="fake", external_id="ext-1")

    outcome = stages.collect_metrics([
        {"platform": "tiktok", "external_id": "ext-1", "views": 1200, "likes": 40},
        {"platform": "tiktok", "external_id": "does-not-exist", "views": 999},
    ])

    assert outcome["recorded"] == 1
    assert db.query("select views from metrics")[0]["views"] == 1200
