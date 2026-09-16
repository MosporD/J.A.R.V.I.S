"""The assistant layer: tool-call parsing, the turn, and the HTTP surface."""

from __future__ import annotations

import pytest

from forge import brain
from forge.providers.base import ProviderError
from forge.providers.llm import _normalise_tool_calls


# --- tool call parsing ------------------------------------------------------


def test_a_well_formed_tool_call_is_passed_through():
    calls = _normalise_tool_calls([
        {"id": "call_1", "function": {"name": "status", "arguments": '{"verbose": true}'}},
    ], "ollama")
    assert calls == [{"id": "call_1", "name": "status", "arguments": {"verbose": True}}]


def test_arguments_may_arrive_already_decoded():
    calls = _normalise_tool_calls([
        {"id": "c", "function": {"name": "theme", "arguments": {"name": "amber"}}},
    ], "ollama")
    assert calls[0]["arguments"] == {"name": "amber"}


def test_empty_arguments_become_an_empty_mapping():
    calls = _normalise_tool_calls([
        {"id": "c", "function": {"name": "diag", "arguments": ""}},
    ], "ollama")
    assert calls[0]["arguments"] == {}


def test_unparseable_arguments_are_reported_rather_than_raised():
    """A small local model will sometimes emit broken JSON. That is a bad turn."""
    calls = _normalise_tool_calls([
        {"id": "c", "function": {"name": "status", "arguments": "{oh dear"}},
    ], "ollama")
    assert calls[0]["name"] == "status"
    assert calls[0]["arguments"] == {}
    assert calls[0]["_error"]
    assert "oh dear" in calls[0]["_raw"]


def test_a_call_without_a_name_is_dropped():
    assert _normalise_tool_calls([{"id": "c", "function": {}}], "ollama") == []


def test_a_missing_id_is_synthesised_so_results_can_be_matched_back():
    calls = _normalise_tool_calls([{"function": {"name": "diag", "arguments": "{}"}}], "ollama")
    assert calls[0]["id"] == "ollama-0"


def test_no_tool_calls_at_all_is_not_an_error():
    assert _normalise_tool_calls(None, "ollama") == []
    assert _normalise_tool_calls([], "ollama") == []


def test_a_non_mapping_argument_is_treated_as_empty():
    calls = _normalise_tool_calls([
        {"id": "c", "function": {"name": "status", "arguments": "[1, 2]"}},
    ], "ollama")
    assert calls[0]["arguments"] == {}


# --- the turn ---------------------------------------------------------------


class FakeLLM:
    name = "fake"
    model = "fake-7b"

    def __init__(self, result=None, error=None):
        self.result = result or {"content": "Very good, sir.", "tool_calls": []}
        self.error = error
        self.seen = None

    def converse(self, **kwargs):
        self.seen = kwargs
        if self.error:
            raise self.error
        return self.result


@pytest.fixture
def fake_llm(monkeypatch):
    def install(client):
        monkeypatch.setattr(brain, "get_llm", lambda: client)
        return client
    return install


def test_a_plain_answer_comes_back_as_a_reply(fake_llm):
    fake_llm(FakeLLM())
    out = brain.think(messages=[{"role": "user", "content": "how are you"}])
    assert out["reply"] == "Very good, sir."
    assert out["tool_calls"] == []
    assert out["model"] == "fake-7b"


def test_tool_calls_are_handed_back_for_the_caller_to_run(fake_llm):
    fake_llm(FakeLLM({"content": "", "tool_calls": [
        {"id": "c1", "name": "status", "arguments": {}},
    ]}))
    out = brain.think(messages=[{"role": "user", "content": "how are we doing"}])
    assert [c["name"] for c in out["tool_calls"]] == ["status"]


def test_the_dashboard_state_reaches_the_system_prompt(fake_llm):
    client = fake_llm(FakeLLM())
    brain.think(
        messages=[{"role": "user", "content": "hi"}],
        context={"mode": "idle", "threat": "critical", "telemetry": {"cpu": 42}},
    )
    system = client.seen["system"]
    assert "threat=critical" in system
    assert "cpu=42" in system


def test_no_context_leaves_the_system_prompt_alone(fake_llm):
    client = fake_llm(FakeLLM())
    brain.think(messages=[{"role": "user", "content": "hi"}])
    assert client.seen["system"] == brain.SYSTEM


def test_tools_are_forwarded_verbatim(fake_llm):
    client = fake_llm(FakeLLM())
    tools = [{"name": "status", "description": "report", "parameters": {"type": "object"}}]
    brain.think(messages=[{"role": "user", "content": "hi"}], tools=tools)
    assert client.seen["tools"] == tools


# --- the HTTP surface -------------------------------------------------------


@pytest.fixture
def client():
    from fastapi.testclient import TestClient
    from forge.api import app
    return TestClient(app)


def test_status_reports_the_configured_provider(client):
    body = client.get("/brain").json()
    assert set(body) == {"ready", "provider", "model", "local"}


def test_a_turn_returns_the_reply(client, fake_llm):
    fake_llm(FakeLLM())
    response = client.post("/brain", json={"messages": [{"role": "user", "content": "hi"}]})
    assert response.status_code == 200
    assert response.json()["reply"] == "Very good, sir."


def test_an_empty_transcript_is_rejected(client):
    assert client.post("/brain", json={"messages": []}).status_code == 400


def test_an_over_long_transcript_is_rejected(client):
    messages = [{"role": "user", "content": "hi"}] * 41
    assert client.post("/brain", json={"messages": messages}).status_code == 422


def test_an_unreachable_provider_is_a_503_not_a_500(client, fake_llm):
    """The model being down is not this service being broken."""
    fake_llm(FakeLLM(error=ProviderError("ollama", "connection refused")))
    response = client.post("/brain", json={"messages": [{"role": "user", "content": "hi"}]})
    assert response.status_code == 503
    assert "connection refused" in response.json()["detail"]


def test_a_tool_result_message_is_accepted(client, fake_llm):
    """The shape the dashboard sends back after running a directive."""
    fake_llm(FakeLLM())
    response = client.post("/brain", json={"messages": [
        {"role": "user", "content": "status"},
        {"role": "assistant", "tool_calls": [
            {"id": "c1", "type": "function", "function": {"name": "status", "arguments": "{}"}},
        ]},
        {"role": "tool", "tool_call_id": "c1", "content": "all nominal"},
    ]})
    assert response.status_code == 200


def test_the_anthropic_client_refuses_the_tool_path_clearly():
    """Rather than shipping a second, untested envelope."""
    from forge.config import ProviderChoice
    from forge.providers.llm import AnthropicLLM

    client = AnthropicLLM(ProviderChoice(name="anthropic", base_url="https://x", api_key="k"))
    with pytest.raises(ProviderError) as caught:
        client.converse(system="s", messages=[{"role": "user", "content": "hi"}])
    assert "chat-completions" in str(caught.value)
