"""
The render contract.

A spec is a plain description of a finished video — sources, timings, text,
output — with no knowledge of ffmpeg. Keeping it separate is what lets the
renderer be swapped for a hosted one without touching the stages that build
specs, and lets a spec be dumped to JSON, replayed, and diffed when a render
comes out wrong.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path

# Per-platform output shapes. Duration caps are the conservative figure across
# the platforms that share an aspect, since a cut is reused across all three.
PLATFORM_SPECS: dict[str, dict] = {
    "youtube":        {"width": 1920, "height": 1080, "fps": 30, "max_seconds": 3600},
    "youtube_short":  {"width": 1080, "height": 1920, "fps": 30, "max_seconds": 180},
    "tiktok":         {"width": 1080, "height": 1920, "fps": 30, "max_seconds": 600},
    "instagram":      {"width": 1080, "height": 1920, "fps": 30, "max_seconds": 90},
    "instagram_feed": {"width": 1080, "height": 1350, "fps": 30, "max_seconds": 90},
    "linkedin":       {"width": 1920, "height": 1080, "fps": 30, "max_seconds": 600},
    "x":              {"width": 1280, "height": 720,  "fps": 30, "max_seconds": 140},
}


@dataclass
class Clip:
    """One background segment. A still and a video differ only in `kind`."""

    src: Path
    kind: str = "image"        # image | video
    seconds: float = 5.0
    # Slow push on stills. Static images read as dead air on a feed; the motion
    # is doing real work, not decoration.
    kenburns: bool = True


@dataclass
class Overlay:
    text: str
    start: float
    end: float
    position: str = "top"      # top | center | bottom
    size: int = 64
    color: str = "white"
    box: bool = True           # legibility over arbitrary footage


@dataclass
class CaptionStyle:
    """
    Burned-in subtitle styling, in libass terms.

    Every value here is a real pixel at the output resolution. That is only true
    because the renderer builds the ASS itself with a matching PlayRes — see
    `render/subtitles.py` for why ffmpeg's own SRT handling makes these numbers
    mean something else entirely.

    Defaults are tuned for a muted vertical feed: large, heavy, high contrast,
    and sat above the platform's own UI chrome at the bottom of the frame.
    """

    font: str = "DejaVu Sans"
    size: int = 64
    primary: str = "&H00FFFFFF"   # &HAABBGGRR — libass order, not RGB
    outline_colour: str = "&H00000000"
    outline: int = 4
    shadow: int = 0
    bold: int = 1
    margin_v: int = 220
    alignment: int = 2            # bottom-centre


@dataclass
class RenderSpec:
    output: Path
    voice: Path | None = None
    width: int = 1080
    height: int = 1920
    fps: int = 30
    clips: list[Clip] = field(default_factory=list)
    music: Path | None = None
    music_gain_db: float = -22.0
    # Sidechain ducking sounds better under narration but adds a filter that can
    # fail on odd inputs; plain gain is the dependable default.
    duck_music: bool = False
    captions: Path | None = None
    caption_style: CaptionStyle = field(default_factory=CaptionStyle)
    overlays: list[Overlay] = field(default_factory=list)
    # Set from the voiceover when there is one. The background is stretched or
    # trimmed to match, never the other way round.
    duration: float | None = None

    @classmethod
    def for_platform(cls, platform: str, output: Path, **kwargs) -> RenderSpec:
        preset = PLATFORM_SPECS.get(platform, PLATFORM_SPECS["tiktok"])
        return cls(
            output=output,
            width=kwargs.pop("width", preset["width"]),
            height=kwargs.pop("height", preset["height"]),
            fps=kwargs.pop("fps", preset["fps"]),
            **kwargs,
        )

    def to_json(self) -> str:
        def encode(value):
            if isinstance(value, Path):
                return str(value)
            raise TypeError(f"not serialisable: {type(value)}")

        return json.dumps(asdict(self), default=encode, indent=2)

    @classmethod
    def from_dict(cls, data: dict) -> RenderSpec:
        payload = dict(data)
        payload["output"] = Path(payload["output"])
        for key in ("voice", "music", "captions"):
            if payload.get(key):
                payload[key] = Path(payload[key])
        payload["clips"] = [
            Clip(**{**clip, "src": Path(clip["src"])}) for clip in payload.get("clips", [])
        ]
        payload["overlays"] = [Overlay(**o) for o in payload.get("overlays", [])]
        if isinstance(payload.get("caption_style"), dict):
            payload["caption_style"] = CaptionStyle(**payload["caption_style"])
        return cls(**payload)
