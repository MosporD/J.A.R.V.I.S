"""
Spec to file.

Everything here builds one ffmpeg invocation and runs it. A single pass matters:
chaining intermediate files multiplies encode time and quality loss, and the
whole reason rendering is self-hosted is that fifteen cuts a day should cost
minutes of CPU rather than a subscription.

The filter graph is assembled as a list of labelled stages so a failure prints a
readable graph instead of one unbroken line, which is the difference between
debugging this in minutes and in an afternoon.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import httpx

from ..config import ProviderChoice
from ..providers.base import ProviderError
from .spec import RenderSpec
from .subtitles import srt_to_ass, wrap_for_width

# ffmpeg needs a real font file; the woff2 the dashboard ships cannot be used
# here. Overridable so a branded face can be dropped in.
DEFAULT_FONT = os.environ.get(
    "FONT_FILE", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
)

# zoompan steps in integer pixels, which visibly stutters at output resolution.
# Oversampling the source first is what makes the push look smooth.
KENBURNS_OVERSAMPLE = 2
KENBURNS_MAX_ZOOM = 1.15


def _escape_path(path: Path) -> str:
    """Filter arguments treat ':' as a separator, so paths must be escaped."""
    return str(path).replace("\\", "\\\\").replace(":", r"\:").replace("'", r"\'")


class FFmpegRenderer:
    """The self-hosted default."""

    name = "ffmpeg"

    def __init__(self, choice: ProviderChoice | None = None):
        if not shutil.which("ffmpeg"):
            raise ProviderError(self.name, "ffmpeg is not on PATH", retryable=False)

    # --- graph construction -------------------------------------------------

    def _plan_clips(self, spec: RenderSpec) -> list[tuple]:
        """
        Fit the background to the narration.

        The voiceover is the master clock. When a spec carries a duration, clip
        lengths are redistributed to fill it exactly — callers supply footage and
        a script, not a stopwatch.
        """
        clips = list(spec.clips)
        if not clips:
            raise ProviderError(self.name, "spec has no background clips", retryable=False)

        if spec.duration:
            share = spec.duration / len(clips)
            for clip in clips:
                clip.seconds = share
        return clips

    def _video_chain(self, spec: RenderSpec, clips: list) -> tuple[list[str], list[str], str]:
        inputs: list[str] = []
        stages: list[str] = []

        for index, clip in enumerate(clips):
            if clip.kind == "image":
                inputs += ["-loop", "1", "-t", f"{clip.seconds:.3f}", "-i", str(clip.src)]
            else:
                # Loop the source so a four-second stock clip can back a
                # thirty-second cut rather than freezing on its last frame.
                inputs += ["-stream_loop", "-1", "-t", f"{clip.seconds:.3f}", "-i", str(clip.src)]

            cover = (
                f"scale={{w}}:{{h}}:force_original_aspect_ratio=increase,"
                f"crop={{w}}:{{h}}"
            )

            if clip.kind == "image" and clip.kenburns:
                big_w = spec.width * KENBURNS_OVERSAMPLE
                big_h = spec.height * KENBURNS_OVERSAMPLE
                frames = max(1, int(clip.seconds * spec.fps))
                step = (KENBURNS_MAX_ZOOM - 1.0) / frames
                stages.append(
                    f"[{index}:v]"
                    + cover.format(w=big_w, h=big_h)
                    + f",zoompan=z='min(zoom+{step:.6f},{KENBURNS_MAX_ZOOM})'"
                    f":d={frames}"
                    f":x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'"
                    f":s={spec.width}x{spec.height}:fps={spec.fps}"
                    f",setsar=1[v{index}]"
                )
            else:
                stages.append(
                    f"[{index}:v]"
                    + cover.format(w=spec.width, h=spec.height)
                    + f",setsar=1,fps={spec.fps},format=yuv420p"
                    f",trim=duration={clip.seconds:.3f},setpts=PTS-STARTPTS[v{index}]"
                )

        if len(clips) == 1:
            label = "v0"
        else:
            joined = "".join(f"[v{i}]" for i in range(len(clips)))
            stages.append(f"{joined}concat=n={len(clips)}:v=1:a=0[bg]")
            label = "bg"

        return inputs, stages, label

    def _text_chain(self, spec: RenderSpec, label: str, work: Path) -> tuple[list[str], str]:
        stages: list[str] = []

        if spec.captions and spec.captions.exists() and spec.captions.stat().st_size > 0:
            # Converted rather than passed straight to the subtitles filter:
            # ffmpeg's own SRT handling renders against a fixed 384x288 script
            # resolution, so styles set in frame pixels come out ~6x too large
            # and positioned against the wrong axis entirely.
            ass = srt_to_ass(
                spec.captions, work / "captions.ass",
                width=spec.width, height=spec.height, style=spec.caption_style,
            )
            stages.append(f"[{label}]subtitles='{_escape_path(ass)}'[cap]")
            label = "cap"

        for index, overlay in enumerate(spec.overlays):
            # Text goes through a file rather than inline: drawtext's escaping
            # rules turn any apostrophe or colon in a headline into a broken
            # filter graph, and headlines contain both.
            text_file = work / f"overlay-{index}.txt"
            # drawtext does not wrap. Without this a hook longer than the frame
            # loses its first and last words off the edges.
            text_file.write_text(
                wrap_for_width(overlay.text, frame_width=spec.width, font_size=overlay.size),
                encoding="utf-8",
            )

            y = {
                "top": f"h*0.12",
                "center": "(h-text_h)/2",
                "bottom": f"h*0.74",
            }.get(overlay.position, "h*0.12")

            box = f":box=1:boxcolor=black@0.55:boxborderw={max(8, overlay.size // 4)}" if overlay.box else ""
            stages.append(
                f"[{label}]drawtext=fontfile='{_escape_path(Path(DEFAULT_FONT))}'"
                f":textfile='{_escape_path(text_file)}'"
                f":fontcolor={overlay.color}:fontsize={overlay.size}"
                f":x=(w-text_w)/2:y={y}{box}"
                f":enable='between(t,{overlay.start:.2f},{overlay.end:.2f})'[ov{index}]"
            )
            label = f"ov{index}"

        return stages, label

    def _audio_chain(self, spec: RenderSpec, first_audio_index: int) -> tuple[list[str], list[str], str]:
        inputs: list[str] = []
        stages: list[str] = []

        if not spec.voice:
            return inputs, stages, ""

        inputs += ["-i", str(spec.voice)]
        voice_idx = first_audio_index

        if not (spec.music and spec.music.exists()):
            return inputs, stages, f"{voice_idx}:a"

        inputs += ["-stream_loop", "-1", "-i", str(spec.music)]
        music_idx = voice_idx + 1

        if spec.duck_music:
            stages.append(f"[{voice_idx}:a]asplit=2[vc][sc]")
            stages.append(f"[{music_idx}:a]volume={spec.music_gain_db}dB[musraw]")
            stages.append(
                "[musraw][sc]sidechaincompress="
                "threshold=0.05:ratio=8:attack=20:release=400[mus]"
            )
            voice_label = "[vc]"
        else:
            stages.append(f"[{music_idx}:a]volume={spec.music_gain_db}dB[mus]")
            voice_label = f"[{voice_idx}:a]"

        # normalize=0 keeps the gains exactly as set; amix otherwise divides by
        # the input count and buries the narration under its own music bed.
        stages.append(
            f"{voice_label}[mus]amix=inputs=2:duration=first"
            ":dropout_transition=0:normalize=0[aout]"
        )
        return inputs, stages, "[aout]"

    # --- execution ----------------------------------------------------------

    def render(self, spec: RenderSpec) -> Path:
        spec.output.parent.mkdir(parents=True, exist_ok=True)
        work = Path(tempfile.mkdtemp(prefix="forge-render-"))

        try:
            clips = self._plan_clips(spec)
            video_inputs, video_stages, label = self._video_chain(spec, clips)
            text_stages, label = self._text_chain(spec, label, work)
            audio_inputs, audio_stages, audio_label = self._audio_chain(spec, len(clips))

            graph = ";".join(video_stages + text_stages + audio_stages)

            command = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error"]
            command += video_inputs + audio_inputs
            command += ["-filter_complex", graph, "-map", f"[{label}]"]

            if audio_label:
                # Either a bare stream index (voice only) or a filter label
                # (mixed); -map accepts both spellings unchanged.
                command += ["-map", audio_label, "-c:a", "aac", "-b:a", "192k"]
            else:
                command += ["-an"]

            total = spec.duration or sum(clip.seconds for clip in clips)
            command += [
                "-c:v", "libx264", "-preset", "medium", "-crf", "20",
                "-pix_fmt", "yuv420p", "-r", str(spec.fps),
                "-t", f"{total:.3f}",
                # Without faststart the moov atom lands at the end of the file
                # and several platforms reject or stall on the upload.
                "-movflags", "+faststart",
                str(spec.output),
            ]

            result = subprocess.run(command, capture_output=True, text=True)
            if result.returncode != 0:
                readable = "\n  ".join(graph.split(";"))
                raise ProviderError(
                    self.name,
                    f"ffmpeg exited {result.returncode}\n"
                    f"graph:\n  {readable}\n"
                    f"stderr: {result.stderr[-1500:]}",
                    retryable=False,
                )

            if not spec.output.exists() or spec.output.stat().st_size == 0:
                raise ProviderError(self.name, "ffmpeg produced no output", retryable=False)

            return spec.output
        finally:
            shutil.rmtree(work, ignore_errors=True)


class RemoteRenderer:
    """
    Rendering on someone else's machine.

    Posts the spec and collects the file. This covers a second box of your own
    running the same worker as easily as a hosted service — the point is that
    rendering can move off the orchestrator when CPU becomes the bottleneck.
    A vendor with its own template schema needs a thin adapter here rather than
    a change anywhere upstream.
    """

    name = "remote"

    def __init__(self, choice: ProviderChoice):
        self.base_url = choice.base_url.rstrip("/")
        if not self.base_url:
            raise ProviderError(self.name, "RENDER_BASE_URL is not set", retryable=False)
        self._headers = {"Content-Type": "application/json"}
        if choice.api_key:
            self._headers["Authorization"] = f"Bearer {choice.api_key}"

    def render(self, spec: RenderSpec) -> Path:
        spec.output.parent.mkdir(parents=True, exist_ok=True)
        try:
            response = httpx.post(f"{self.base_url}/render", headers=self._headers,
                                  content=spec.to_json(), timeout=1800)
            response.raise_for_status()
            payload = response.json()
            media = httpx.get(payload["url"], timeout=1800, follow_redirects=True)
            media.raise_for_status()
            spec.output.write_bytes(media.content)
        except (httpx.HTTPError, KeyError) as exc:
            raise ProviderError(self.name, str(exc)) from exc
        return spec.output


def build(choice: ProviderChoice):
    if choice.name in {"remote", "creatomate", "json2video", "shotstack"}:
        return RemoteRenderer(choice)
    return FFmpegRenderer(choice)
