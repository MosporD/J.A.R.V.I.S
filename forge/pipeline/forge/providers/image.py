"""
Visuals.

Ordered by what actually earns its cost. `library` reads clips you already own
and touches no network at all; `pexels` pulls stock once and should be cached
into that library; `comfyui` runs a local diffusion model; `openai` buys a shot
you cannot otherwise get. Most faceless content never needs past the second.
"""

from __future__ import annotations

import base64
import hashlib
import random
from pathlib import Path

import httpx

from ..config import ProviderChoice
from .base import ImageResult, ProviderError

# Stills and clips alike — the render worker treats a video background the same
# way, so the library can mix both.
MEDIA_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".mp4", ".mov", ".webm"}


class LibraryImages:
    """
    Your own bucket, sampled.

    The endpoint of the sensible path: download a few hundred clips once, keep
    them, and never depend on a third party for B-roll again. Selection is a
    stable hash of the query so the same topic keeps a consistent look instead
    of flickering between unrelated stock on every render.
    """

    name = "library"

    def __init__(self, choice: ProviderChoice, root: Path):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)

    def fetch(self, *, query: str, count: int, orientation: str, out_dir: Path) -> list[ImageResult]:
        pool = [p for p in sorted(self.root.rglob("*")) if p.suffix.lower() in MEDIA_SUFFIXES]
        if not pool:
            raise ProviderError(self.name, f"no media in {self.root}", retryable=False)

        seed = int(hashlib.sha256(query.encode()).hexdigest()[:8], 16)
        picker = random.Random(seed)
        chosen = picker.sample(pool, min(count, len(pool)))
        return [ImageResult(path=p, provider=self.name, credit="local library") for p in chosen]


class PexelsImages:
    """Stock, free tier, attribution carried through to the caption."""

    name = "pexels"

    def __init__(self, choice: ProviderChoice):
        self.base_url = choice.base_url.rstrip("/")
        self.api_key = choice.api_key
        if not self.api_key:
            raise ProviderError(self.name, "PEXELS_API_KEY is not set", retryable=False)

    def fetch(self, *, query: str, count: int, orientation: str, out_dir: Path) -> list[ImageResult]:
        out_dir.mkdir(parents=True, exist_ok=True)
        try:
            response = httpx.get(
                f"{self.base_url}/search",
                headers={"Authorization": self.api_key},
                params={"query": query, "per_page": count, "orientation": orientation},
                timeout=60,
            )
            response.raise_for_status()
            photos = response.json().get("photos", [])
        except httpx.HTTPError as exc:
            raise ProviderError(self.name, str(exc)) from exc

        results: list[ImageResult] = []
        for photo in photos:
            src = photo.get("src", {}).get("large2x") or photo.get("src", {}).get("original")
            if not src:
                continue
            dest = out_dir / f"pexels-{photo['id']}.jpg"
            try:
                dest.write_bytes(httpx.get(src, timeout=120, follow_redirects=True).content)
            except httpx.HTTPError:
                continue  # one bad image should not fail a whole render
            results.append(ImageResult(
                path=dest, provider=self.name,
                width=photo.get("width", 0), height=photo.get("height", 0),
                credit=f"Photo by {photo.get('photographer', 'unknown')} on Pexels",
            ))

        if not results:
            raise ProviderError(self.name, f"no usable results for {query!r}")
        return results


class ComfyUIImages:
    """
    Local diffusion.

    Worth running as a batch job on a rented GPU that spins up, drains the
    queue and dies — twenty minutes a day of GPU time rather than an always-on
    box, which is the difference between a few dollars a month and a few
    hundred. Expects a saved API-format workflow with a `prompt` input.
    """

    name = "comfyui"

    def __init__(self, choice: ProviderChoice):
        self.base_url = choice.base_url.rstrip("/")
        self.workflow = choice.model

    def fetch(self, *, query: str, count: int, orientation: str, out_dir: Path) -> list[ImageResult]:
        out_dir.mkdir(parents=True, exist_ok=True)
        try:
            response = httpx.post(
                f"{self.base_url}/prompt",
                json={"prompt": {"workflow": self.workflow, "text": query, "batch_size": count}},
                timeout=600,
            )
            response.raise_for_status()
            images = response.json().get("images", [])
        except httpx.HTTPError as exc:
            raise ProviderError(self.name, str(exc)) from exc

        results = []
        for index, blob in enumerate(images):
            dest = out_dir / f"comfy-{index}.png"
            dest.write_bytes(base64.b64decode(blob))
            results.append(ImageResult(path=dest, provider=self.name))
        return results


class OpenAIImages:
    name = "openai"

    def __init__(self, choice: ProviderChoice):
        self.base_url = choice.base_url.rstrip("/")
        self.model = choice.model
        self._headers = {"Authorization": f"Bearer {choice.api_key}"}

    def fetch(self, *, query: str, count: int, orientation: str, out_dir: Path) -> list[ImageResult]:
        out_dir.mkdir(parents=True, exist_ok=True)
        size = {"portrait": "1024x1536", "landscape": "1536x1024"}.get(orientation, "1024x1024")
        try:
            response = httpx.post(
                f"{self.base_url}/images/generations",
                headers=self._headers,
                json={"model": self.model, "prompt": query, "n": count, "size": size},
                timeout=300,
            )
            response.raise_for_status()
            data = response.json().get("data", [])
        except httpx.HTTPError as exc:
            raise ProviderError(self.name, str(exc)) from exc

        results = []
        for index, item in enumerate(data):
            dest = out_dir / f"openai-{index}.png"
            if item.get("b64_json"):
                dest.write_bytes(base64.b64decode(item["b64_json"]))
            elif item.get("url"):
                dest.write_bytes(httpx.get(item["url"], timeout=120).content)
            else:
                continue
            results.append(ImageResult(path=dest, provider=self.name))
        return results


def build(choice: ProviderChoice, library_root: Path):
    if choice.name == "library":
        return LibraryImages(choice, library_root)
    if choice.name == "comfyui":
        return ComfyUIImages(choice)
    if choice.name == "openai":
        return OpenAIImages(choice)
    return PexelsImages(choice)
