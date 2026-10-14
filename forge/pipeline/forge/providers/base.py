"""
What every slot must answer to.

These protocols are deliberately narrow. A provider is asked for one artefact
and returns it; nothing here knows about the database, the state machine, or
what stage is calling. That is what makes a self-hosted and a paid provider
interchangeable — neither can grow a dependency the other cannot satisfy.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol, runtime_checkable


class ProviderError(RuntimeError):
    """
    A provider failed in a way the pipeline should record, not crash on.

    Stages catch this, write it to `last_error`, and move the row to `failed`
    so the item can be retried from that stage alone.
    """

    def __init__(self, provider: str, message: str, *, retryable: bool = True):
        super().__init__(f"[{provider}] {message}")
        self.provider = provider
        self.retryable = retryable


@dataclass
class AudioResult:
    path: Path
    duration_ms: int
    provider: str
    meta: dict = field(default_factory=dict)


@dataclass
class ImageResult:
    path: Path
    provider: str
    width: int = 0
    height: int = 0
    # Stock libraries require attribution; generated imagery does not. Carried
    # here so the caption builder can honour it without asking who produced it.
    credit: str = ""
    meta: dict = field(default_factory=dict)


@dataclass
class CaptionResult:
    """Subtitles as SRT, plus the plain transcript for descriptions and tags."""

    srt_path: Path
    text: str
    provider: str


@dataclass
class PublishResult:
    platform: str
    provider: str
    external_id: str = ""
    url: str = ""
    scheduled: bool = False
    response: dict = field(default_factory=dict)


@runtime_checkable
class LLMProvider(Protocol):
    name: str

    def complete(self, *, system: str, prompt: str, max_tokens: int = 2000,
                 temperature: float = 0.7, json_mode: bool = False) -> str: ...


@runtime_checkable
class TTSProvider(Protocol):
    name: str

    def synthesize(self, *, text: str, voice: str, out_path: Path) -> AudioResult: ...


@runtime_checkable
class ImageProvider(Protocol):
    name: str

    def fetch(self, *, query: str, count: int, orientation: str,
              out_dir: Path) -> list[ImageResult]: ...


@runtime_checkable
class TranscribeProvider(Protocol):
    name: str

    def transcribe(self, *, audio: Path, out_dir: Path) -> CaptionResult: ...


@runtime_checkable
class PublishProvider(Protocol):
    name: str

    def publish(self, *, platform: str, caption: str, media: Path | None,
                scheduled_at=None, extra: dict | None = None) -> PublishResult: ...


@runtime_checkable
class StorageProvider(Protocol):
    name: str

    def put(self, local: Path, key: str) -> str: ...
    def get(self, key: str, dest: Path) -> Path: ...
    def url(self, key: str, expires: int = 3600) -> str: ...
