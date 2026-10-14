"""
Distribution.

The one slot where self-hosting buys the least. Postiz and Mixpost remove the
scheduling and token-refresh work, but every path here still requires your own
developer app on each platform and survival of its review — that cost is
structural, not a tooling choice.

`dry_run` is the default for exactly that reason: the pipeline must be provable
end to end before any of that approval work starts. It records the payload it
would have sent and posts nothing.
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

import httpx

from ..config import ProviderChoice
from .base import ProviderError, PublishResult


class DryRunPublisher:
    """Posts nothing; reports what it would have posted."""

    name = "dry_run"

    def __init__(self, choice: ProviderChoice):
        pass

    def publish(self, *, platform: str, caption: str, media: Path | None,
                scheduled_at: datetime | None = None, extra: dict | None = None) -> PublishResult:
        return PublishResult(
            platform=platform,
            provider=self.name,
            external_id="",
            scheduled=scheduled_at is not None,
            response={
                "would_post": {
                    "platform": platform,
                    "caption": caption,
                    "media": str(media) if media else None,
                    "scheduled_at": scheduled_at.isoformat() if scheduled_at else None,
                    **(extra or {}),
                }
            },
        )


class PostizPublisher:
    """
    Self-hosted scheduling.

    Media is uploaded first and referenced by id — the same two-step every
    platform enforces underneath, surfaced here rather than hidden.
    """

    name = "postiz"

    def __init__(self, choice: ProviderChoice):
        self.base_url = choice.base_url.rstrip("/")
        self.api_key = choice.api_key
        if not self.api_key:
            raise ProviderError(self.name, "PUBLISH_API_KEY is not set", retryable=False)
        self._headers = {"Authorization": self.api_key}

    def _upload(self, media: Path) -> str:
        with media.open("rb") as handle:
            response = httpx.post(
                f"{self.base_url}/upload",
                headers=self._headers,
                files={"file": (media.name, handle, "application/octet-stream")},
                timeout=900,
            )
        response.raise_for_status()
        return response.json().get("id", "")

    def publish(self, *, platform: str, caption: str, media: Path | None,
                scheduled_at: datetime | None = None, extra: dict | None = None) -> PublishResult:
        try:
            media_ids = [self._upload(media)] if media else []
            body = {
                "type": "schedule" if scheduled_at else "now",
                "posts": [{
                    "integration": {"id": (extra or {}).get("integration_id", platform)},
                    "value": [{"content": caption, "image": media_ids}],
                }],
            }
            if scheduled_at:
                body["date"] = scheduled_at.isoformat()

            response = httpx.post(f"{self.base_url}/posts", headers=self._headers,
                                  json=body, timeout=300)
            response.raise_for_status()
            payload = response.json()
        except httpx.HTTPStatusError as exc:
            raise ProviderError(self.name, f"{exc.response.status_code} {exc.response.text[:300]}",
                                retryable=exc.response.status_code >= 500) from exc
        except httpx.HTTPError as exc:
            raise ProviderError(self.name, str(exc)) from exc

        return PublishResult(
            platform=platform, provider=self.name,
            external_id=str(payload.get("id", "")),
            url=payload.get("releaseURL", ""),
            scheduled=scheduled_at is not None,
            response=payload,
        )


class AyrsharePublisher:
    """Hosted, one integration for every platform — the shortest path to live."""

    name = "ayrshare"

    def __init__(self, choice: ProviderChoice):
        self.base_url = choice.base_url.rstrip("/")
        if not choice.api_key:
            raise ProviderError(self.name, "PUBLISH_API_KEY is not set", retryable=False)
        self._headers = {"Authorization": f"Bearer {choice.api_key}",
                         "Content-Type": "application/json"}

    def publish(self, *, platform: str, caption: str, media: Path | None,
                scheduled_at: datetime | None = None, extra: dict | None = None) -> PublishResult:
        body: dict = {"post": caption, "platforms": [platform]}
        # Ayrshare fetches media by URL rather than accepting an upload, so the
        # storage provider must expose something publicly reachable here.
        media_url = (extra or {}).get("media_url")
        if media_url:
            body["mediaUrls"] = [media_url]
        if scheduled_at:
            body["scheduleDate"] = scheduled_at.isoformat()

        try:
            response = httpx.post(f"{self.base_url}/post", headers=self._headers,
                                  json=body, timeout=300)
            response.raise_for_status()
            payload = response.json()
        except httpx.HTTPStatusError as exc:
            raise ProviderError(self.name, f"{exc.response.status_code} {exc.response.text[:300]}",
                                retryable=exc.response.status_code >= 500) from exc
        except httpx.HTTPError as exc:
            raise ProviderError(self.name, str(exc)) from exc

        posts = payload.get("postIds", [])
        first = posts[0] if posts else {}
        return PublishResult(
            platform=platform, provider=self.name,
            external_id=str(first.get("id", "")),
            url=first.get("postUrl", ""),
            scheduled=scheduled_at is not None,
            response=payload,
        )


def build(choice: ProviderChoice):
    if choice.name == "postiz":
        return PostizPublisher(choice)
    if choice.name in {"ayrshare", "blotato"}:
        return AyrsharePublisher(choice)
    return DryRunPublisher(choice)
