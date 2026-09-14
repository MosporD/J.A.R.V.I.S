"""
The hybrid switchboard.

Every capability in the pipeline — writing, narration, imagery, rendering,
publishing, storage — is a slot with a self-hosted default and a third-party
alternative. Swapping one is an environment variable, never a code change, so
the stack can start free and buy its way out of whichever bottleneck actually
shows up rather than the one that seemed likely on day one.

The defaults are deliberately the ones that cost nothing to run.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from functools import lru_cache


def _env(key: str, default: str = "") -> str:
    return os.environ.get(key, default).strip()


def _flag(key: str, default: bool = False) -> bool:
    raw = _env(key).lower()
    if not raw:
        return default
    return raw in {"1", "true", "yes", "on"}


def _int(key: str, default: int) -> int:
    try:
        return int(_env(key) or default)
    except ValueError:
        return default


@dataclass(frozen=True)
class ProviderChoice:
    """A slot's selection plus the connection details it needs."""

    name: str
    base_url: str = ""
    api_key: str = ""
    model: str = ""
    options: dict = field(default_factory=dict)

    @property
    def is_local(self) -> bool:
        """True when nothing leaves the box."""
        return self.name in LOCAL_PROVIDERS


# Which provider names run entirely on your own hardware. Used by `forge doctor`
# to report how much of the pipeline is actually self-hosted, and by the API so
# a J.A.R.V.I.S panel can show it at a glance.
LOCAL_PROVIDERS = {
    "ollama",
    "kokoro",
    "piper",
    "comfyui",
    "ffmpeg",
    "postiz",
    "mixpost",
    "minio",
    "local",
    "whisper_asr",
    "dry_run",
}


@dataclass(frozen=True)
class Settings:
    database_url: str

    llm: ProviderChoice
    # Scripting is the one place where a weak model is visible to the audience,
    # so it gets its own slot. The pattern that actually pays: a local model for
    # the mechanical volume — scoring, tagging, dedupe, metadata — and an API
    # for the handful of calls a day that produce something people watch.
    llm_script: ProviderChoice
    tts: ProviderChoice
    image: ProviderChoice
    render: ProviderChoice
    publish: ProviderChoice
    storage: ProviderChoice
    transcribe: ProviderChoice

    media_root: str
    bucket: str
    work_dir: str

    default_voice: str
    music_gain_db: float
    platforms: tuple[str, ...]

    @property
    def local_share(self) -> tuple[int, int]:
        """(self-hosted slots, total slots) — what `doctor` reports."""
        slots = [
            self.llm,
            self.llm_script,
            self.tts,
            self.image,
            self.render,
            self.publish,
            self.storage,
            self.transcribe,
        ]
        return sum(1 for s in slots if s.is_local), len(slots)


def _llm(prefix: str, fallback_provider: str) -> ProviderChoice:
    """
    Resolve an LLM slot.

    Ollama, LM Studio, vLLM, OpenAI and most gateways all speak the same
    chat-completions shape, so they share one client and differ only in base
    URL. Anthropic gets its own client because its message API does not.
    """
    name = _env(f"{prefix}_PROVIDER", fallback_provider)
    defaults = {
        "ollama": ("http://ollama:11434/v1", "", "qwen2.5:7b-instruct"),
        "openai": ("https://api.openai.com/v1", _env("OPENAI_API_KEY"), "gpt-4o-mini"),
        "anthropic": ("https://api.anthropic.com", _env("ANTHROPIC_API_KEY"), "claude-sonnet-5"),
        "openai_compatible": (_env(f"{prefix}_BASE_URL"), _env(f"{prefix}_API_KEY"), ""),
    }
    base, key, model = defaults.get(name, defaults["ollama"])
    return ProviderChoice(
        name=name,
        base_url=_env(f"{prefix}_BASE_URL", base),
        api_key=_env(f"{prefix}_API_KEY", key),
        model=_env(f"{prefix}_MODEL", model),
        options={"timeout": _int(f"{prefix}_TIMEOUT", 120)},
    )


def _tts() -> ProviderChoice:
    """
    Resolve the narration slot.

    Kokoro is the default because it serves an OpenAI-shaped speech endpoint
    from a CPU container, which means the self-hosted path and the paid path
    run identical client code — the only honest way to offer a real choice.
    """
    name = _env("TTS_PROVIDER", "kokoro")
    defaults = {
        "kokoro": ("http://kokoro:8880/v1", "", "kokoro"),
        "openai": ("https://api.openai.com/v1", _env("OPENAI_API_KEY"), "gpt-4o-mini-tts"),
        "elevenlabs": ("https://api.elevenlabs.io/v1", _env("ELEVENLABS_API_KEY"), "eleven_multilingual_v2"),
        "piper": (_env("PIPER_URL", "http://piper:5000"), "", ""),
    }
    base, key, model = defaults.get(name, defaults["kokoro"])
    return ProviderChoice(
        name=name,
        base_url=_env("TTS_BASE_URL", base),
        api_key=_env("TTS_API_KEY", key),
        model=_env("TTS_MODEL", model),
        options={"format": _env("TTS_FORMAT", "mp3")},
    )


def _image() -> ProviderChoice:
    """
    Resolve the imagery slot.

    Stock footage is the default on purpose. Most successful faceless content is
    stock B-roll with motion and text over it, not generated imagery — and a
    library downloaded once to your own bucket has no ongoing dependency at all.
    Generation is worth buying only where a specific shot cannot be found.
    """
    name = _env("IMAGE_PROVIDER", "pexels")
    defaults = {
        "pexels": ("https://api.pexels.com/v1", _env("PEXELS_API_KEY"), ""),
        "comfyui": (_env("COMFYUI_URL", "http://comfyui:8188"), "", _env("COMFYUI_WORKFLOW", "flux_schnell")),
        "openai": ("https://api.openai.com/v1", _env("OPENAI_API_KEY"), "gpt-image-1"),
        "library": ("", "", ""),  # your own bucket, no network at all
    }
    base, key, model = defaults.get(name, defaults["pexels"])
    return ProviderChoice(
        name=name,
        base_url=_env("IMAGE_BASE_URL", base),
        api_key=_env("IMAGE_API_KEY", key),
        model=_env("IMAGE_MODEL", model),
    )


def _publish() -> ProviderChoice:
    """
    Resolve the publishing slot.

    This is the slot where self-hosting buys you the least. Postiz and Mixpost
    remove the scheduling and token-refresh work, but you still register your
    own developer app with every platform and survive their review — that cost
    is structural and no provider here avoids it. `dry_run` writes the payload
    to the runs table and posts nothing, which is how you test the pipeline
    before any of that is in place.
    """
    name = _env("PUBLISH_PROVIDER", "dry_run")
    defaults = {
        "postiz": (_env("POSTIZ_URL", "http://postiz:5000/api/public/v1"), _env("POSTIZ_API_KEY")),
        "mixpost": (_env("MIXPOST_URL", "http://mixpost/api"), _env("MIXPOST_API_KEY")),
        "ayrshare": ("https://api.ayrshare.com/api", _env("AYRSHARE_API_KEY")),
        "blotato": ("https://backend.blotato.com/v2", _env("BLOTATO_API_KEY")),
        "dry_run": ("", ""),
    }
    base, key = defaults.get(name, defaults["dry_run"])
    return ProviderChoice(
        name=name,
        base_url=_env("PUBLISH_BASE_URL", base),
        api_key=_env("PUBLISH_API_KEY", key),
    )


def _storage() -> ProviderChoice:
    name = _env("STORAGE_PROVIDER", "minio")
    return ProviderChoice(
        name=name,
        base_url=_env("S3_ENDPOINT", "http://minio:9000"),
        api_key=_env("S3_SECRET_KEY", "forge-secret"),
        options={
            "access_key": _env("S3_ACCESS_KEY", "forge"),
            "region": _env("S3_REGION", "us-east-1"),
            "public_base": _env("S3_PUBLIC_BASE", ""),
        },
    )


def _transcribe() -> ProviderChoice:
    """Captions. Burned-in subtitles measurably lift retention on muted feeds."""
    name = _env("TRANSCRIBE_PROVIDER", "whisper_asr")
    defaults = {
        "whisper_asr": (_env("WHISPER_URL", "http://whisper:9000"), ""),
        "openai": ("https://api.openai.com/v1", _env("OPENAI_API_KEY")),
        "none": ("", ""),
    }
    base, key = defaults.get(name, defaults["whisper_asr"])
    return ProviderChoice(
        name=name,
        base_url=_env("TRANSCRIBE_BASE_URL", base),
        api_key=_env("TRANSCRIBE_API_KEY", key),
        model=_env("TRANSCRIBE_MODEL", "base"),
    )


@lru_cache(maxsize=1)
def settings() -> Settings:
    return Settings(
        database_url=_env("DATABASE_URL", "postgresql://forge:forge@postgres:5432/forge"),
        llm=_llm("LLM", "ollama"),
        # Falls back to the general slot, so the hybrid split is opt-in rather
        # than something you must configure twice to get started.
        llm_script=_llm("LLM_SCRIPT", _env("LLM_PROVIDER", "ollama")),
        tts=_tts(),
        image=_image(),
        render=ProviderChoice(
            name=_env("RENDER_PROVIDER", "ffmpeg"),
            base_url=_env("RENDER_BASE_URL", ""),
            api_key=_env("RENDER_API_KEY", ""),
        ),
        publish=_publish(),
        storage=_storage(),
        transcribe=_transcribe(),
        media_root=_env("MEDIA_ROOT", "/data/media"),
        bucket=_env("S3_BUCKET", "forge"),
        work_dir=_env("WORK_DIR", "/tmp/forge"),
        default_voice=_env("DEFAULT_VOICE", "af_heart"),
        music_gain_db=float(_env("MUSIC_GAIN_DB", "-22")),
        platforms=tuple(p for p in _env("PLATFORMS", "youtube,tiktok,instagram").split(",") if p),
    )
