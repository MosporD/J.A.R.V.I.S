"""
Render worker tests.

These need real ffmpeg and produce real files — they are the only way to catch
the class of bug that lives here. Two examples found by this suite: captions
rendering mid-frame because ffmpeg converts SRT against a fixed 384x288 script
resolution, and long overlay text running off both edges because drawtext does
not wrap. Neither is visible in the filter graph; both are obvious in a frame.

    pip install -r requirements.txt && pytest tests/ -v
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from forge.providers.base import ProviderError
from forge.render.ffmpeg import FFmpegRenderer
from forge.render.spec import Clip, Overlay, RenderSpec
from forge.render.subtitles import parse_srt, srt_to_ass, wrap_for_width

SRT = """1
00:00:00,200 --> 00:00:03,000
First caption line

2
00:00:03,200 --> 00:00:08,500
Second caption line here
"""


def _ffmpeg_available() -> bool:
    try:
        subprocess.run(["ffmpeg", "-version"], capture_output=True, check=True)
        return True
    except (FileNotFoundError, subprocess.CalledProcessError):
        return False


needs_ffmpeg = pytest.mark.skipif(not _ffmpeg_available(), reason="ffmpeg not installed")


def probe(path: Path) -> dict:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries",
         "format=duration:stream=codec_type,width,height", "-of", "json", str(path)],
        capture_output=True, text=True, check=True,
    )
    return json.loads(out.stdout)


@pytest.fixture(scope="module")
def media(tmp_path_factory) -> dict:
    """Synthetic fixtures — no network, no committed binaries."""
    root = tmp_path_factory.mktemp("media")
    gen = [
        (["-f", "lavfi", "-i", "color=c=navy:s=1600x900:d=1", "-frames:v", "1"], "a.jpg"),
        (["-f", "lavfi", "-i", "color=c=darkgreen:s=1200x1600:d=1", "-frames:v", "1"], "b.jpg"),
        (["-f", "lavfi", "-i", "testsrc=s=1280x720:d=3:r=30", "-pix_fmt", "yuv420p"], "clip.mp4"),
        (["-f", "lavfi", "-i", "sine=frequency=300:duration=9"], "voice.mp3"),
        (["-f", "lavfi", "-i", "sine=frequency=90:duration=4"], "music.mp3"),
    ]
    for args, name in gen:
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *args, str(root / name)], check=True)
    (root / "subs.srt").write_text(SRT)
    return {name: root / name for _, name in gen} | {"subs.srt": root / "subs.srt", "root": root}


# --- subtitle unit tests (no ffmpeg needed) ---------------------------------


def test_parse_srt_reads_every_cue():
    cues = parse_srt(SRT)
    assert len(cues) == 2
    assert cues[0][0] == "0:00:00.20"
    assert cues[0][2] == "First caption line"


def test_parse_srt_skips_malformed_blocks():
    assert parse_srt("1\nnot a timing line\ntext\n\n") == []


def test_ass_playres_matches_the_frame(tmp_path):
    """The whole point: style numbers must be real pixels at output resolution."""
    from forge.render.spec import CaptionStyle

    srt = tmp_path / "s.srt"
    srt.write_text(SRT)
    ass = srt_to_ass(srt, tmp_path / "s.ass", width=1080, height=1920, style=CaptionStyle())
    body = ass.read_text()
    assert "PlayResX: 1080" in body
    assert "PlayResY: 1920" in body
    assert body.count("Dialogue:") == 2


def test_wrap_breaks_text_that_would_overflow():
    wrapped = wrap_for_width("Why your KPIs lie: a 3-minute proof",
                             frame_width=1080, font_size=56)
    assert "\n" in wrapped
    assert max(len(line) for line in wrapped.splitlines()) <= 30


def test_wrap_leaves_short_text_alone():
    assert "\n" not in wrap_for_width("Short hook", frame_width=1080, font_size=56)


def test_wrap_never_loses_words():
    text = "one two three four five six seven eight nine ten eleven twelve"
    assert wrap_for_width(text, frame_width=1080, font_size=64).split() == text.split()


# --- render integration tests -----------------------------------------------


@needs_ffmpeg
@pytest.mark.parametrize("platform,expect", [
    ("tiktok", (1080, 1920)),
    ("youtube", (1920, 1080)),
    ("instagram_feed", (1080, 1350)),
])
def test_renders_at_platform_dimensions(media, tmp_path, platform, expect):
    out = FFmpegRenderer().render(RenderSpec.for_platform(
        platform, output=tmp_path / f"{platform}.mp4",
        voice=media["voice.mp3"], duration=9.0,
        clips=[Clip(src=media["a.jpg"], kind="image")],
    ))
    video = next(s for s in probe(out)["streams"] if s["codec_type"] == "video")
    assert (video["width"], video["height"]) == expect


@needs_ffmpeg
def test_narration_sets_the_duration(media, tmp_path):
    """Background is fitted to the voice, never the other way round."""
    out = FFmpegRenderer().render(RenderSpec.for_platform(
        "tiktok", output=tmp_path / "d.mp4", voice=media["voice.mp3"], duration=9.0,
        clips=[Clip(src=media["a.jpg"], seconds=999), Clip(src=media["b.jpg"], seconds=999)],
    ))
    assert abs(float(probe(out)["format"]["duration"]) - 9.0) < 0.5


@needs_ffmpeg
def test_concat_mixes_stills_and_video(media, tmp_path):
    out = FFmpegRenderer().render(RenderSpec.for_platform(
        "tiktok", output=tmp_path / "c.mp4", voice=media["voice.mp3"], duration=9.0,
        clips=[Clip(src=media["a.jpg"], kind="image"),
               Clip(src=media["b.jpg"], kind="image"),
               Clip(src=media["clip.mp4"], kind="video", kenburns=False)],
    ))
    assert out.stat().st_size > 0


@needs_ffmpeg
def test_captions_and_overlays_render_together(media, tmp_path):
    out = FFmpegRenderer().render(RenderSpec.for_platform(
        "tiktok", output=tmp_path / "t.mp4", voice=media["voice.mp3"], duration=9.0,
        captions=media["subs.srt"], clips=[Clip(src=media["a.jpg"])],
        overlays=[Overlay(text="Why your KPIs lie: a 3-minute proof",
                          start=0, end=3.5, position="top", size=56)],
    ))
    assert out.stat().st_size > 0


@needs_ffmpeg
def test_punctuation_does_not_break_the_filter_graph(media, tmp_path):
    """Colons and quotes in a headline are what break naive drawtext escaping."""
    out = FFmpegRenderer().render(RenderSpec.for_platform(
        "youtube", output=tmp_path / "p.mp4", voice=media["voice.mp3"], duration=9.0,
        clips=[Clip(src=media["a.jpg"])],
        overlays=[Overlay(text="Text with: colons, commas & an apostrophe's tail",
                          start=0, end=4, position="bottom", size=40)],
    ))
    assert out.stat().st_size > 0


@needs_ffmpeg
@pytest.mark.parametrize("duck", [False, True])
def test_music_mixes_under_narration(media, tmp_path, duck):
    out = FFmpegRenderer().render(RenderSpec.for_platform(
        "tiktok", output=tmp_path / f"m{duck}.mp4", voice=media["voice.mp3"],
        music=media["music.mp3"], duck_music=duck, duration=9.0,
        clips=[Clip(src=media["a.jpg"])],
    ))
    assert any(s["codec_type"] == "audio" for s in probe(out)["streams"])


@needs_ffmpeg
def test_silent_render_has_no_audio_stream(media, tmp_path):
    out = FFmpegRenderer().render(RenderSpec.for_platform(
        "instagram", output=tmp_path / "s.mp4",
        clips=[Clip(src=media["a.jpg"], seconds=3.0)],
    ))
    assert not any(s["codec_type"] == "audio" for s in probe(out)["streams"])


@needs_ffmpeg
def test_spec_without_clips_is_rejected(tmp_path):
    with pytest.raises(ProviderError):
        FFmpegRenderer().render(RenderSpec.for_platform(
            "tiktok", output=tmp_path / "e.mp4", clips=[]))


def test_spec_round_trips_through_json(media, tmp_path):
    spec = RenderSpec.for_platform(
        "tiktok", output=tmp_path / "r.mp4", voice=media["voice.mp3"], duration=9.0,
        clips=[Clip(src=media["a.jpg"])],
        overlays=[Overlay(text="hook", start=0, end=2)],
    )
    restored = RenderSpec.from_dict(json.loads(spec.to_json()))
    assert restored.width == spec.width
    assert restored.clips[0].src == spec.clips[0].src
    assert restored.overlays[0].text == "hook"
