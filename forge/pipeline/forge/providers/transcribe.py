"""
Captions.

Most of your audience watches muted, so burned-in subtitles are not an
accessibility extra — they are the difference between a view and a scroll. The
transcript comes back too, because descriptions, tags and the search-facing
metadata are all cheaper to derive from it than to generate again.
"""

from __future__ import annotations

from pathlib import Path

import httpx

from ..config import ProviderChoice
from .base import CaptionResult, ProviderError


def _srt_timestamp(seconds: float) -> str:
    ms = int(round(seconds * 1000))
    hours, ms = divmod(ms, 3_600_000)
    minutes, ms = divmod(ms, 60_000)
    secs, ms = divmod(ms, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{ms:03d}"


def segments_to_srt(segments: list[dict]) -> str:
    """
    Build SRT from whatever shape the backend returned.

    Both supported backends emit start/end/text per segment; the key names are
    the only thing that varies, so normalising here keeps the providers thin.
    """
    lines = []
    for index, segment in enumerate(segments, start=1):
        start = float(segment.get("start", 0))
        end = float(segment.get("end", start + 2))
        text = (segment.get("text") or "").strip()
        if not text:
            continue
        lines.append(f"{index}\n{_srt_timestamp(start)} --> {_srt_timestamp(end)}\n{text}\n")
    return "\n".join(lines)


class WhisperASRService:
    """The self-hosted webservice wrapper around faster-whisper."""

    name = "whisper_asr"

    def __init__(self, choice: ProviderChoice):
        self.base_url = choice.base_url.rstrip("/")

    def transcribe(self, *, audio: Path, out_dir: Path) -> CaptionResult:
        out_dir.mkdir(parents=True, exist_ok=True)
        srt_path = out_dir / f"{audio.stem}.srt"
        try:
            with audio.open("rb") as handle:
                response = httpx.post(
                    f"{self.base_url}/asr",
                    params={"output": "srt", "task": "transcribe"},
                    files={"audio_file": (audio.name, handle, "application/octet-stream")},
                    timeout=900,
                )
            response.raise_for_status()
        except httpx.HTTPError as exc:
            raise ProviderError(self.name, str(exc)) from exc

        srt = response.text
        srt_path.write_text(srt, encoding="utf-8")
        # Strip indices and timecodes to recover the plain transcript.
        text = " ".join(
            line for line in srt.splitlines()
            if line.strip() and "-->" not in line and not line.strip().isdigit()
        )
        return CaptionResult(srt_path=srt_path, text=text, provider=self.name)


class OpenAITranscribe:
    name = "openai"

    def __init__(self, choice: ProviderChoice):
        self.base_url = choice.base_url.rstrip("/")
        self._headers = {"Authorization": f"Bearer {choice.api_key}"}

    def transcribe(self, *, audio: Path, out_dir: Path) -> CaptionResult:
        out_dir.mkdir(parents=True, exist_ok=True)
        srt_path = out_dir / f"{audio.stem}.srt"
        try:
            with audio.open("rb") as handle:
                response = httpx.post(
                    f"{self.base_url}/audio/transcriptions",
                    headers=self._headers,
                    files={"file": (audio.name, handle, "application/octet-stream")},
                    data={"model": "whisper-1", "response_format": "verbose_json",
                          "timestamp_granularities[]": "segment"},
                    timeout=900,
                )
            response.raise_for_status()
            payload = response.json()
        except httpx.HTTPError as exc:
            raise ProviderError(self.name, str(exc)) from exc

        srt_path.write_text(segments_to_srt(payload.get("segments", [])), encoding="utf-8")
        return CaptionResult(srt_path=srt_path, text=payload.get("text", ""), provider=self.name)


class NoTranscription:
    """Explicitly off — renders simply carry no burned-in captions."""

    name = "none"

    def transcribe(self, *, audio: Path, out_dir: Path) -> CaptionResult:
        out_dir.mkdir(parents=True, exist_ok=True)
        srt_path = out_dir / f"{audio.stem}.srt"
        srt_path.write_text("", encoding="utf-8")
        return CaptionResult(srt_path=srt_path, text="", provider=self.name)


def build(choice: ProviderChoice):
    if choice.name == "openai":
        return OpenAITranscribe(choice)
    if choice.name == "none":
        return NoTranscription()
    return WhisperASRService(choice)
