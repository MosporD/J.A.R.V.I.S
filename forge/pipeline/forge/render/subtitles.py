"""
SRT to ASS, with a coordinate space that means something.

ffmpeg's built-in SRT conversion hardcodes a 384x288 script resolution, so every
number in `force_style` is interpreted in that space and then scaled to the real
frame. On a 1080x1920 cut that silently multiplies font sizes by 6.7 and turns a
160px bottom margin into 55% of the frame height — captions land mid-screen at
roughly 150px tall, which looks like a styling mistake but is a unit mismatch.

Building the ASS here with PlayRes set to the output size makes every style
value a real pixel at the resolution it will actually be rendered at.
"""

from __future__ import annotations

import re
from pathlib import Path

SRT_TIME = re.compile(r"(\d+):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d+):(\d{2}):(\d{2})[,.](\d{1,3})")


def _ass_time(hours: str, minutes: str, seconds: str, millis: str) -> str:
    """ASS uses centiseconds and a single-digit hour."""
    centis = int(millis.ljust(3, "0")) // 10
    return f"{int(hours)}:{int(minutes):02d}:{int(seconds):02d}.{centis:02d}"


def parse_srt(text: str) -> list[tuple[str, str, str]]:
    """Return (start, end, text) with ASS timestamps. Malformed blocks are skipped."""
    cues: list[tuple[str, str, str]] = []
    for block in re.split(r"\n\s*\n", text.strip()):
        lines = [line for line in block.strip().splitlines() if line.strip()]
        if len(lines) < 2:
            continue
        # A cue may or may not carry a leading index, so find the timing line.
        timing_index = next((i for i, line in enumerate(lines) if "-->" in line), None)
        if timing_index is None:
            continue
        match = SRT_TIME.search(lines[timing_index])
        if not match:
            continue
        g = match.groups()
        body = lines[timing_index + 1:]
        if not body:
            continue
        # \N is ASS's hard line break; libass wraps the rest itself.
        cues.append((_ass_time(*g[:4]), _ass_time(*g[4:]), r"\N".join(body)))
    return cues


def srt_to_ass(srt_path: Path, out_path: Path, *, width: int, height: int, style) -> Path:
    """
    Write an ASS whose script resolution matches the frame.

    Left and right margins are what make libass wrap rather than run off the
    edges, so they are derived from the width instead of left at the default.
    """
    cues = parse_srt(srt_path.read_text(encoding="utf-8", errors="replace"))
    side_margin = max(40, int(width * 0.06))

    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
ScaledBorderAndShadow: yes
WrapStyle: 0

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Default,{style.font},{style.size},{style.primary},{style.primary},{style.outline_colour},&H00000000,{style.bold},0,0,0,100,100,0,0,1,{style.outline},{style.shadow},{style.alignment},{side_margin},{side_margin},{style.margin_v},1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
"""
    events = "\n".join(
        f"Dialogue: 0,{start},{end},Default,,0,0,0,,{text}" for start, end, text in cues
    )
    out_path.write_text(header + events + "\n", encoding="utf-8")
    return out_path


# DejaVu Sans Bold averages a little under 0.6em per character across mixed-case
# text. Used to wrap, not to typeset, so an approximation is fine — it only has
# to keep a headline inside the frame.
AVERAGE_ADVANCE = 0.58
SAFE_WIDTH = 0.88


def wrap_for_width(text: str, *, frame_width: int, font_size: int) -> str:
    """
    Break overlay text into lines that fit.

    drawtext has no wrapping of its own: a long hook renders as one line and
    runs off both edges, losing the first and last words entirely. It does
    honour newlines, so wrapping here is the whole fix.
    """
    max_chars = max(8, int((frame_width * SAFE_WIDTH) / (font_size * AVERAGE_ADVANCE)))
    words, lines, current = text.split(), [], ""

    for word in words:
        candidate = f"{current} {word}".strip()
        if len(candidate) <= max_chars:
            current = candidate
        else:
            if current:
                lines.append(current)
            current = word
    if current:
        lines.append(current)
    return "\n".join(lines)
