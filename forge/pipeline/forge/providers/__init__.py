"""
The registry.

One place that turns configuration into working objects, so no stage ever names
a concrete provider. Instances are cached because several of them open
connections or verify buckets on construction and the stages run in a loop.

Every submodule is imported inside its getter, never at module level. That is
load-bearing, not style: each provider pulls its own client library, and eager
imports here would mean a render box — which needs ffmpeg and an HTTP client and
nothing else — could not start without boto3 and a Postgres driver installed.
Only `base` is imported eagerly, and it depends on nothing.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from .base import (
    AudioResult,
    CaptionResult,
    ImageResult,
    ProviderError,
    PublishResult,
)

__all__ = [
    "AudioResult",
    "CaptionResult",
    "ImageResult",
    "ProviderError",
    "PublishResult",
    "get_llm",
    "get_script_llm",
    "get_tts",
    "get_images",
    "get_transcriber",
    "get_publisher",
    "get_storage",
    "get_renderer",
    "describe",
]


@lru_cache(maxsize=1)
def get_llm():
    """The workhorse: scoring, tagging, dedupe, metadata. High volume, low stakes."""
    from ..config import settings
    from . import llm as llm_mod

    return llm_mod.build(settings().llm)


@lru_cache(maxsize=1)
def get_script_llm():
    """The one the audience hears. Falls back to the workhorse when unset."""
    from ..config import settings
    from . import llm as llm_mod

    return llm_mod.build(settings().llm_script)


@lru_cache(maxsize=1)
def get_tts():
    from ..config import settings
    from . import tts as tts_mod

    return tts_mod.build(settings().tts)


@lru_cache(maxsize=1)
def get_images():
    from ..config import settings
    from . import image as image_mod

    return image_mod.build(settings().image, Path(settings().media_root) / "library")


@lru_cache(maxsize=1)
def get_transcriber():
    from ..config import settings
    from . import transcribe as transcribe_mod

    return transcribe_mod.build(settings().transcribe)


@lru_cache(maxsize=1)
def get_publisher():
    from ..config import settings
    from . import publish as publish_mod

    return publish_mod.build(settings().publish)


@lru_cache(maxsize=1)
def get_storage():
    from ..config import settings
    from . import storage as storage_mod

    return storage_mod.build(settings().storage, settings().bucket, Path(settings().media_root))


@lru_cache(maxsize=1)
def get_renderer():
    from ..config import settings
    from ..render.ffmpeg import build as build_renderer

    return build_renderer(settings().render)


def describe() -> dict:
    """
    What is actually wired up, and how much of it is yours.

    Surfaced by `forge doctor` and by /health, so the question "how much of this
    depends on someone else's uptime" has a one-line answer at any moment.
    """
    from ..config import settings

    config = settings()
    local, total = config.local_share
    slots = {
        "llm": config.llm,
        "llm_script": config.llm_script,
        "tts": config.tts,
        "image": config.image,
        "render": config.render,
        "publish": config.publish,
        "storage": config.storage,
        "transcribe": config.transcribe,
    }
    return {
        "self_hosted": f"{local}/{total}",
        "slots": {
            name: {
                "provider": choice.name,
                "local": choice.is_local,
                "model": choice.model or None,
                "endpoint": choice.base_url or None,
            }
            for name, choice in slots.items()
        },
    }
