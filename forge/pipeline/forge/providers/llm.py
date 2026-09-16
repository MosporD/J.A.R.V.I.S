"""
Writing, and conversation.

Two clients cover the field: almost everything speaks OpenAI's chat-completions
shape, and Anthropic does not. Ollama, vLLM, LM Studio, Groq, OpenRouter and
OpenAI itself all fall into the first client and differ only by base URL — which
is why moving scripting from a local model to a paid one is a config change.

`complete()` is one question and one answer, which is what the pipeline stages
want. `converse()` carries a transcript and a set of tools, which is what the
dashboard's assistant wants: the model is given the directives J.A.R.V.I.S.
already has and asks for the ones it needs.
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

    def converse(self, *, system: str, messages: list[dict], tools: list[dict] | None = None,
                 max_tokens: int = 1024, temperature: float = 0.2) -> dict:
        """
        One turn of a tool-using conversation.

        Returns ``{"content": str, "tool_calls": [...]}``. The caller decides
        what to do with a tool call and sends the result back as another
        message — this client holds no conversation state, which is what lets
        the dashboard own the transcript and run the tools itself.
        """
        body = {
            "model": self.model,
            "messages": [{"role": "system", "content": system}, *messages],
            "max_tokens": max_tokens,
            "temperature": temperature,
        }
        if tools:
            body["tools"] = [{"type": "function", "function": tool} for tool in tools]

        payload = self._post("/chat/completions", body)
        try:
            message = payload["choices"][0]["message"]
        except (KeyError, IndexError) as exc:
            raise ProviderError(self.name, f"unexpected response shape: {json.dumps(payload)[:300]}",
                                retryable=False) from exc

        return {
            "content": (message.get("content") or "").strip(),
            "tool_calls": _normalise_tool_calls(message.get("tool_calls"), self.name),
        }

    def _post(self, path: str, body: dict) -> dict:
        """The shared request, so the two methods cannot drift on error handling."""
        try:
            response = httpx.post(
                f"{self.base_url}{path}",
                headers=self._headers,
                json=body,
                timeout=self.timeout,
            )
            response.raise_for_status()
            return response.json()
        except httpx.HTTPStatusError as exc:
            # 4xx is a bad request or an exhausted quota; retrying won't help.
            retryable = exc.response.status_code >= 500 or exc.response.status_code == 429
            raise ProviderError(self.name, f"{exc.response.status_code} {exc.response.text[:300]}",
                                retryable=retryable) from exc
        except httpx.HTTPError as exc:
            raise ProviderError(self.name, str(exc)) from exc

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

        payload = self._post("/chat/completions", body)
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

    def converse(self, *, system: str, messages: list[dict], tools: list[dict] | None = None,
                 max_tokens: int = 1024, temperature: float = 0.2) -> dict:
        """
        Not implemented.

        Anthropic's tool envelope differs from the chat-completions one in
        shape, not just in field names, so it is a second implementation rather
        than a translation. The dashboard assistant is built against a local
        model and there is no way to exercise this path here; a clear refusal
        beats an untested one that fails in front of the operator.
        """
        raise ProviderError(
            self.name,
            "the assistant needs a chat-completions provider — set LLM_PROVIDER to "
            "ollama, openai_compatible or openai",
            retryable=False,
        )

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


def _normalise_tool_calls(raw, provider: str) -> list[dict]:
    """
    Turn the wire's tool calls into ``{"id", "name", "arguments"}``.

    Arguments arrive as a JSON *string*, and a small local model will sometimes
    produce one that does not parse. That is a bad turn, not a crash: hand the
    caller the raw text under ``_raw`` and let it answer the model with an
    error, which is usually enough for the next attempt to come back valid.
    """
    calls = []
    for index, call in enumerate(raw or []):
        function = call.get("function") or {}
        name = function.get("name")
        if not name:
            continue
        arguments = function.get("arguments")
        if isinstance(arguments, str):
            try:
                arguments = json.loads(arguments or "{}")
            except json.JSONDecodeError:
                calls.append({
                    "id": call.get("id") or f"{provider}-{index}",
                    "name": name,
                    "arguments": {},
                    "_raw": arguments[:500],
                    "_error": "arguments were not valid JSON",
                })
                continue
        if not isinstance(arguments, dict):
            arguments = {}
        calls.append({
            "id": call.get("id") or f"{provider}-{index}",
            "name": name,
            "arguments": arguments,
        })
    return calls


def build(choice: ProviderChoice):
    if choice.name == "anthropic":
        return AnthropicLLM(choice)
    return OpenAICompatibleLLM(choice)
