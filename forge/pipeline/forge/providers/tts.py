"""
Narration.

Self-hosted TTS crossed the "good enough for narration" line recently, which is
what makes the whole economics of this pipeline work: voiceover was the largest
recurring cost and it is now a container. Kokoro serves an OpenAI-shaped speech
endpoint, so the local and paid paths share a client and the choice is genuinely
free rather than a downgrade you have to rewrite around.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import httpx

from ..config import ProviderChoice
from .base import AudioResult, ProviderError


def probe_duration_ms(path: Path) -> int:
    """
    Ask ffprobe how long the narration is.

    Everything downstream is timed off this: the background loops to it, the
    captions align to it, the render stops with it. Guessing from word count
    drifts by seconds over a minute, which is enough to truncate an outro.
    """
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
            capture_output=True, text=True, check=True,
        )
        return int(float(out.stdout.strip()) * 1000)
    except (subprocess.CalledProcessError, ValueError) as exc:
        raise ProviderError("ffprobe", f"could not read duration of {path.name}: {exc}",
                            retryable=False) from exc


class OpenAICompatibleTTS:
    """Kokoro, OpenAI, or any other /audio/speech endpoint."""

    def __init__(self, choice: ProviderChoice):
        self.name = choice.name
        self.base_url = choice.base_url.rstrip("/")
        self.model = choice.model
        self.fmt = choice.options.get("format", "mp3")
        self._headers = {"Content-Type": "application/json"}
        if choice.api_key:
            self._headers["Authorization"] = f"Bearer {choice.api_key}"

    def synthesize(self, *, text: str, voice: str, out_path: Path) -> AudioResult:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            # Long scripts take a while on CPU; the timeout is generous on
            # purpose because a truncated voiceover is worse than a slow one.
            with httpx.stream(
                "POST",
                f"{self.base_url}/audio/speech",
                headers=self._headers,
                json={
                    "model": self.model,
                    "input": text,
                    "voice": voice,
                    "response_format": self.fmt,
                },
                timeout=600,
            ) as response:
                response.raise_for_status()
                with out_path.open("wb") as handle:
                    for chunk in response.iter_bytes():
                        handle.write(chunk)
        except httpx.HTTPStatusError as exc:
            raise ProviderError(self.name, f"{exc.response.status_code} {exc.response.text[:200]}",
                                retryable=exc.response.status_code >= 500) from exc
        except httpx.HTTPError as exc:
            raise ProviderError(self.name, str(exc)) from exc

        return AudioResult(
            path=out_path,
            duration_ms=probe_duration_ms(out_path),
            provider=self.name,
            meta={"voice": voice, "model": self.model},
        )


class ElevenLabsTTS:
    """Its own envelope, kept because the voice quality still leads."""

    def __init__(self, choice: ProviderChoice):
        self.name = choice.name
        self.base_url = choice.base_url.rstrip("/")
        self.model = choice.model
        self._headers = {"xi-api-key": choice.api_key, "Content-Type": "application/json"}

    def synthesize(self, *, text: str, voice: str, out_path: Path) -> AudioResult:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            response = httpx.post(
                f"{self.base_url}/text-to-speech/{voice}",
                headers=self._headers,
                json={"text": text, "model_id": self.model},
                timeout=600,
            )
            response.raise_for_status()
            out_path.write_bytes(response.content)
        except httpx.HTTPStatusError as exc:
            raise ProviderError(self.name, f"{exc.response.status_code} {exc.response.text[:200]}",
                                retryable=exc.response.status_code >= 500) from exc
        except httpx.HTTPError as exc:
            raise ProviderError(self.name, str(exc)) from exc

        return AudioResult(
            path=out_path,
            duration_ms=probe_duration_ms(out_path),
            provider=self.name,
            meta={"voice": voice, "model": self.model},
        )


class PiperTTS:
    """
    The floor option: a small CPU model behind an HTTP wrapper.

    Noticeably more robotic than Kokoro, but it runs anywhere and costs nothing,
    which makes it the right thing to fall back to rather than stopping.
    """

    def __init__(self, choice: ProviderChoice):
        self.name = choice.name
        self.base_url = choice.base_url.rstrip("/")

    def synthesize(self, *, text: str, voice: str, out_path: Path) -> AudioResult:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            response = httpx.post(self.base_url, content=text.encode("utf-8"), timeout=600)
            response.raise_for_status()
            out_path.write_bytes(response.content)
        except httpx.HTTPError as exc:
            raise ProviderError(self.name, str(exc)) from exc

        return AudioResult(path=out_path, duration_ms=probe_duration_ms(out_path),
                           provider=self.name, meta={"voice": voice})


def build(choice: ProviderChoice):
    if choice.name == "elevenlabs":
        return ElevenLabsTTS(choice)
    if choice.name == "piper":
        return PiperTTS(choice)
    return OpenAICompatibleTTS(choice)
