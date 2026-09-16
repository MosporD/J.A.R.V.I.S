"""
The assistant behind the prompt.

J.A.R.V.I.S. has always had a directive registry: a fixed set of verbs, matched
by name. This puts a model in front of it, so a sentence that is not a verb
still reaches the right one — and so a question that is not a directive at all
gets an answer instead of "that is outside my directive set".

Three things are deliberate.

**The dashboard runs the tools, not this module.** The directives live in the
browser and act on the browser: they redraw panels, clear the log, re-hue the
interface. So this is a pure turn — transcript and tools in, a reply or a tool
call out — and the dashboard executes and calls back with the result. Nothing
here holds conversation state, which also means no session store, no expiry,
and no way for two tabs to corrupt each other.

**The tool list comes from the caller.** The registry is the dashboard's, and
duplicating it here would mean two lists that drift. The cost is that this
endpoint will describe whatever tools it is handed, which is acceptable for
something bound to localhost and running against a local model.

**The key never reaches the browser.** That is the whole reason this lives in
forge rather than in the page: the provider is configured here, and a dashboard
on a work machine never holds a credential. With the default local provider
there is no credential at all and no request leaves the box.
"""

from __future__ import annotations

from typing import Any

from .providers import ProviderError, get_llm

# Enough for a directive to be chosen and explained, not enough for an essay.
MAX_TOKENS = 800

# Low, not zero. Tool choice wants to be nearly deterministic; a flat zero makes
# a small model repeat itself when a turn does not go well.
TEMPERATURE = 0.2

SYSTEM = """You are J.A.R.V.I.S., the assistant running a holographic command \
dashboard. You address the operator as "sir".

You have tools. Each one is a directive the dashboard can carry out. Use them:

- When the operator asks for something a directive does, call that directive \
rather than describing it. "How are we doing?" is a request for the status \
directive, not for a paragraph about status.
- When several directives are needed, call them.
- When no directive fits, just answer. You are allowed to hold a conversation.
- Never invent a directive that is not in your tool list, and never claim to \
have done something you did not call a tool for.

Keep replies to a sentence or two unless asked for more. You are a heads-up \
display, not a chat window — the operator is reading you out of the corner of \
an eye. Dry wit is in character; padding is not."""


def _context_note(context: dict[str, Any] | None) -> str:
    """Fold the dashboard's live state into a line the model can read."""
    if not context:
        return ""
    parts = []
    for key in ("mode", "threat", "reactor", "online"):
        if key in context:
            parts.append(f"{key}={context[key]}")
    telemetry = context.get("telemetry") or {}
    for name, value in list(telemetry.items())[:8]:
        parts.append(f"{name}={value}")
    if not parts:
        return ""
    return "\n\nCurrent dashboard state: " + ", ".join(str(p) for p in parts)


def think(
    *,
    messages: list[dict],
    tools: list[dict] | None = None,
    context: dict[str, Any] | None = None,
) -> dict:
    """
    Take one turn.

    Returns ``{"reply": str, "tool_calls": [...], "provider": str, "model": str}``.
    A turn with tool calls is not finished: the caller runs them, appends the
    results, and calls again.
    """
    client = get_llm()
    result = client.converse(
        system=SYSTEM + _context_note(context),
        messages=messages,
        tools=tools,
        max_tokens=MAX_TOKENS,
        temperature=TEMPERATURE,
    )
    return {
        "reply": result.get("content", ""),
        "tool_calls": result.get("tool_calls", []),
        "provider": getattr(client, "name", "unknown"),
        "model": getattr(client, "model", ""),
    }


__all__ = ["think", "SYSTEM", "ProviderError"]
