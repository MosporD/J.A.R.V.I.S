"""
Where artefacts live.

MinIO speaks S3, so the self-hosted and cloud paths are one client pointed at
different endpoints. The database stores keys rather than URLs precisely because
of this: the bucket can move and signed links expire, but a key stays valid.
"""

from __future__ import annotations

import shutil
from pathlib import Path

import boto3
from botocore.client import Config
from botocore.exceptions import BotoCoreError, ClientError

from ..config import ProviderChoice
from .base import ProviderError


class S3Storage:
    """MinIO, S3, R2, Spaces — whichever the endpoint points at."""

    def __init__(self, choice: ProviderChoice, bucket: str):
        self.name = choice.name
        self.bucket = bucket
        self.public_base = choice.options.get("public_base", "").rstrip("/")
        self._client = boto3.client(
            "s3",
            endpoint_url=choice.base_url or None,
            aws_access_key_id=choice.options.get("access_key"),
            aws_secret_access_key=choice.api_key,
            region_name=choice.options.get("region", "us-east-1"),
            # MinIO needs path-style addressing; virtual-host style assumes DNS
            # per bucket, which a local container does not have.
            config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
        )
        self._ensure_bucket()

    def _ensure_bucket(self) -> None:
        try:
            self._client.head_bucket(Bucket=self.bucket)
        except ClientError:
            try:
                self._client.create_bucket(Bucket=self.bucket)
            except (ClientError, BotoCoreError) as exc:
                raise ProviderError(self.name, f"cannot create bucket {self.bucket}: {exc}",
                                    retryable=False) from exc

    def put(self, local: Path, key: str) -> str:
        try:
            self._client.upload_file(str(local), self.bucket, key)
        except (ClientError, BotoCoreError) as exc:
            raise ProviderError(self.name, f"upload of {key} failed: {exc}") from exc
        return key

    def get(self, key: str, dest: Path) -> Path:
        dest.parent.mkdir(parents=True, exist_ok=True)
        try:
            self._client.download_file(self.bucket, key, str(dest))
        except (ClientError, BotoCoreError) as exc:
            raise ProviderError(self.name, f"download of {key} failed: {exc}") from exc
        return dest

    def url(self, key: str, expires: int = 3600) -> str:
        # A publisher that fetches media by URL needs a link reachable from
        # outside this network, which a signed MinIO URL on an internal host is
        # not — hence the explicit public base.
        if self.public_base:
            return f"{self.public_base}/{self.bucket}/{key}"
        try:
            return self._client.generate_presigned_url(
                "get_object", Params={"Bucket": self.bucket, "Key": key}, ExpiresIn=expires,
            )
        except (ClientError, BotoCoreError) as exc:
            raise ProviderError(self.name, f"could not sign {key}: {exc}") from exc


class LocalStorage:
    """A directory on disk. Useful for a first run before MinIO is up."""

    name = "local"

    def __init__(self, choice: ProviderChoice, bucket: str, root: Path):
        self.root = root / bucket
        self.root.mkdir(parents=True, exist_ok=True)
        self.public_base = choice.options.get("public_base", "").rstrip("/")

    def put(self, local: Path, key: str) -> str:
        dest = self.root / key
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(local, dest)
        return key

    def get(self, key: str, dest: Path) -> Path:
        source = self.root / key
        if not source.exists():
            raise ProviderError(self.name, f"{key} not found", retryable=False)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, dest)
        return dest

    def url(self, key: str, expires: int = 3600) -> str:
        if self.public_base:
            return f"{self.public_base}/{key}"
        return (self.root / key).as_uri()


def build(choice: ProviderChoice, bucket: str, media_root: Path):
    if choice.name == "local":
        return LocalStorage(choice, bucket, media_root)
    return S3Storage(choice, bucket)
