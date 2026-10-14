"""
What the models are actually asked.

Kept in one file because these are the highest-leverage strings in the system —
the difference between content worth watching and the mass-produced output that
platforms now explicitly demote is almost entirely here, not in the plumbing.

Two rules shape all of them:
  - The voice document is injected, never hardcoded. A pipeline that writes in
    nobody's voice produces exactly the interchangeable content this is meant
    to avoid.
  - Derivatives are cut from one master script in a single call, so a day's
    posts say one coherent thing instead of five unrelated things.
"""

from __future__ import annotations

import json

# Overridable per channel; this is the fallback when no voice document is set.
DEFAULT_VOICE_DOC = """\
You write for practitioners, not beginners. Concrete over abstract. You use
real numbers and real examples. You never open with a rhetorical question,
never say "in today's video", and never pad. If a sentence could appear in any
other piece on the topic, it is cut.
"""

SCRIPT_SYSTEM = """\
You are a scriptwriter for a single creator's channel. You write in their voice,
which is described below. You are not writing generic content — you are writing
the piece only this person could write.

VOICE:
{voice}

Hard rules:
- Open with a concrete claim, tension, or number. Never a question, never a greeting.
- One idea per piece. Depth beats breadth.
- Every claim gets a specific example. No filler transitions.
- Write spoken narration: short sentences, no bullet points, no markdown.
- Do not mention being an AI, a script, or a video.
"""

SCRIPT_PROMPT = """\
Write the master script for a piece on this topic.

TOPIC: {title}
CONTEXT: {summary}
TARGET LENGTH: {seconds} seconds of narration (roughly {words} words)

Return JSON with exactly these keys:
  "title"  — the piece title, under 70 characters, specific not clickbait
  "hook"   — the first spoken line, under 20 words, the strongest thing you have
  "script" — the full narration, plain text, no markdown, no speaker labels
"""

# The atomiser. One call, because separate calls per platform lose the through
# line and produce five posts that happen to share a subject.
DERIVE_SYSTEM = """\
You cut one master script into platform-native pieces. You are not summarising —
each cut must stand alone and be worth watching or reading on its own terms.

VOICE:
{voice}

Per-platform reality:
- Short video (tiktok, instagram, youtube_short): 30-50 seconds spoken. The
  first three seconds decide everything; lead with the sharpest moment in the
  master script, not with context.
- Long video (youtube): keep the full argument, add a spoken title card line.
- Text (linkedin, x): no narration. Write the post body. LinkedIn takes 3-5
  short paragraphs; x takes under 270 characters.

Never reuse the same opening line across two cuts.
"""

DERIVE_PROMPT = """\
MASTER SCRIPT:
{script}

Produce one cut for each of these platform/format pairs: {targets}

Return JSON: {{"cuts": [{{"platform": "...", "format": "...", "script": "...",
"caption": "...", "hashtags": ["..."]}}]}}

For text formats leave "script" empty and put the post in "caption".
For video formats "script" is the narration and "caption" is the post
description. Hashtags: 3-5, lowercase, no spaces, specific to the subject.
"""

# Cheap, high-volume, and runs on the local model — exactly the work that has no
# business being billed per token.
SCORE_SYSTEM = """\
You rank content ideas for one channel. You are strict. Most ideas are mediocre
and should score below 50.

The channel covers: {topic}

Score on: specificity (is there a real claim?), whether the creator has genuine
standing to say it, and whether anyone would stop scrolling for it.
"""

SCORE_PROMPT = """\
Score each idea from 0 to 100.

{ideas}

Return JSON: {{"scores": [{{"id": "...", "score": 0, "reason": "under 15 words"}}]}}
"""

# Visual direction. Asked for separately because a script written to be heard
# describes nothing a stock search can use.
BROLL_SYSTEM = """\
You turn narration into stock footage search queries. Queries must be literal
and visual — things a camera can point at. Never abstract nouns, never brand
names, never text-on-screen descriptions.

Good: "server room blue lights", "hands typing laptop night", "city traffic aerial"
Bad: "innovation", "the future of work", "data flowing"
"""

BROLL_PROMPT = """\
Narration:
{script}

Produce {count} search queries, one per visual beat, in narration order.
Return JSON: {{"queries": ["...", "..."]}}
"""


def script_messages(*, title: str, summary: str, seconds: int, voice: str = "") -> tuple[str, str]:
    # ~150 words per minute is the usual spoken pace; the model overshoots
    # without a word target and the render then outruns the narration.
    words = int(seconds * 2.5)
    return (
        SCRIPT_SYSTEM.format(voice=voice or DEFAULT_VOICE_DOC),
        SCRIPT_PROMPT.format(title=title, summary=summary or "none given",
                             seconds=seconds, words=words),
    )


def derive_messages(*, script: str, targets: list[tuple[str, str]], voice: str = "") -> tuple[str, str]:
    readable = ", ".join(f"{platform}/{fmt}" for platform, fmt in targets)
    return (
        DERIVE_SYSTEM.format(voice=voice or DEFAULT_VOICE_DOC),
        DERIVE_PROMPT.format(script=script, targets=readable),
    )


def score_messages(*, ideas: list[dict], topic: str) -> tuple[str, str]:
    listing = "\n".join(
        f'- id={idea["id"]}: {idea["title"]} — {(idea.get("summary") or "")[:200]}'
        for idea in ideas
    )
    return SCORE_SYSTEM.format(topic=topic), SCORE_PROMPT.format(ideas=listing)


def broll_messages(*, script: str, count: int) -> tuple[str, str]:
    return BROLL_SYSTEM, BROLL_PROMPT.format(script=script, count=count)


def parse_json(raw: str) -> dict:
    """
    Recover JSON from a model that wrapped it in prose or a fence.

    Smaller local models do this constantly, and failing the whole stage over a
    stray ```json is not worth it.
    """
    text = raw.strip()
    if text.startswith("```"):
        text = text.split("```")[1] if "```" in text[3:] else text[3:]
        if text.startswith("json"):
            text = text[4:]
    text = text.strip()

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start, end = text.find("{"), text.rfind("}")
        if start >= 0 and end > start:
            try:
                return json.loads(text[start:end + 1])
            except json.JSONDecodeError:
                pass
    raise ValueError(f"no JSON object in model output: {raw[:300]}")
