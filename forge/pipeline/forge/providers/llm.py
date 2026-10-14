"""
Writing.

Two clients cover the field: almost everything speaks OpenAI's chat-completions
shape, and Anthropic does not. Ollama, vLLM, LM Studio, Groq, OpenRouter and
OpenAI itself all fall into the first client and differ only by base URL — which
is why moving scripting from a local model to a paid one is a config change.
"""

from __future__ import annotations

import json

import httpx

from ..config import ProviderChoice
from .base import ProviderError


class OpenAICompatibleLLM:
    """Anything serving /chat/completions — local or hosted."""

    def __init__(self, choice: ProviderChoice):
        self.name = choice.name
        self.base_url = choice.base_url.rstrip("/")
        self.model = choice.model
        self.timeout = choice.options.get("timeout", 120)
        self._headers = {"Content-Type": "application/json"}
        if choice.api_key:
            self._headers["Authorization"] = f"Bearer {choice.api_key}"

    def complete(self, *, system: str, prompt: str, max_tokens: int = 2000,
                 temperature: float = 0.7, json_mode: bool = False) -> str:
        body = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": prompt},
            ],
            "max_tokens": max_tokens,
            "temperature": temperature,
        }
        if json_mode:
            body["response_format"] = {"type": "json_object"}

        try:
            response = httpx.post(
                f"{self.base_url}/chat/completions",
                headers=self._headers,
                json=body,
                timeout=self.timeout,
            )
            response.raise_for_status()
            payload = response.json()
        except httpx.HTTPStatusError as exc:
            # 4xx is a bad request or an exhausted quota; retrying won't help.
            retryable = exc.response.status_code >= 500 or exc.response.status_code == 429
            raise ProviderError(self.name, f"{exc.response.status_code} {exc.response.text[:300]}",
                                retryable=retryable) from exc
        except httpx.HTTPError as exc:
            raise ProviderError(self.name, str(exc)) from exc

        try:
            return payload["choices"][0]["message"]["content"].strip()
        except (KeyError, IndexError, AttributeError) as exc:
            raise ProviderError(self.name, f"unexpected response shape: {json.dumps(payload)[:300]}",
                                retryable=False) from exc


class AnthropicLLM:
    """Anthropic's messages API — different envelope, same job."""

    def __init__(self, choice: ProviderChoice):
        self.name = choice.name
        self.base_url = choice.base_url.rstrip("/")
        self.model = choice.model
        self.timeout = choice.options.get("timeout", 120)
        self._headers = {
            "content-type": "application/json",
            "x-api-key": choice.api_key,
            "anthropic-version": "2023-06-01",
        }

    def complete(self, *, system: str, prompt: str, max_tokens: int = 2000,
                 temperature: float = 0.7, json_mode: bool = False) -> str:
        # No response_format here; asking for JSON in the system prompt and
        # prefilling the opening brace is the equivalent move.
        messages = [{"role": "user", "content": prompt}]
        if json_mode:
            messages.append({"role": "assistant", "content": "{"})

        try:
            response = httpx.post(
                f"{self.base_url}/v1/messages",
                headers=self._headers,
                json={
                    "model": self.model,
                    "system": system,
                    "messages": messages,
                    "max_tokens": max_tokens,
                    "temperature": temperature,
                },
                timeout=self.timeout,
            )
            response.raise_for_status()
            payload = response.json()
        except httpx.HTTPStatusError as exc:
            retryable = exc.response.status_code >= 500 or exc.response.status_code == 429
            raise ProviderError(self.name, f"{exc.response.status_code} {exc.response.text[:300]}",
                                retryable=retryable) from exc
        except httpx.HTTPError as exc:
            raise ProviderError(self.name, str(exc)) from exc

        try:
            text = "".join(block.get("text", "") for block in payload["content"]).strip()
        except (KeyError, TypeError) as exc:
            raise ProviderError(self.name, f"unexpected response shape: {json.dumps(payload)[:300]}",
                                retryable=False) from exc
        # Put back the brace we prefilled so the caller gets parseable JSON.
        return "{" + text if json_mode else text


def build(choice: ProviderChoice):
    if choice.name == "anthropic":
        return AnthropicLLM(choice)
    return OpenAICompatibleLLM(choice)
