"""
The HTTP surface.

Two consumers, deliberately one API. n8n drives the stages on a schedule; a
J.A.R.V.I.S panel reads the same /health and /pipeline endpoints to show what
the workshop is doing. Neither gets its own bespoke route — a dashboard that
reads a different source of truth than the thing doing the work eventually
disagrees with it.

Every stage endpoint is idempotent at the row level: the state machine refuses a
transition it has already made, so a retried n8n node cannot double-post.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from . import db, stages
from .config import _env
from .providers import ProviderError, describe

app = FastAPI(title="forge", version="1.0.0")

# The J.A.R.V.I.S dashboard is a separate origin — Vite serves it on :5173 while
# this runs on :8000 — so without these headers the browser drops every reply
# before the panel sees it, silently and with no server-side error to find.
# Kept to an explicit list rather than "*" because the stage endpoints are not
# read-only.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        origin for origin in _env(
            "CORS_ORIGINS",
            "http://localhost:5173,http://127.0.0.1:5173,"
            "http://localhost:4173,http://127.0.0.1:4173",
        ).split(",") if origin
    ],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


# --- Request bodies ---------------------------------------------------------


class HarvestBody(BaseModel):
    source: str = Field(..., description="rss | reddit | manual | …")
    topic: str = ""
    items: list[dict[str, Any]]


class ScoreBody(BaseModel):
    topic: str
    limit: int = 20


class ScriptBody(BaseModel):
    idea_id: str
    seconds: int = 90
    # The channel's voice document. Injected rather than stored in code because
    # it is the single thing that stops output reading like everyone else's.
    voice_doc: str = ""
    targets: list[tuple[str, str]] | None = None


class ApproveBody(BaseModel):
    piece_id: str
    reason: str = ""


class AssetsBody(BaseModel):
    variant_id: str


class ScheduleBody(BaseModel):
    slots_per_day: int = 3
    days: int = 7
    start_hour: int = 9
    jitter_minutes: int = 25


class PublishBody(BaseModel):
    limit: int = 5


class MetricsBody(BaseModel):
    readings: list[dict[str, Any]]


def _guard(fn, *args, **kwargs):
    """
    Turn provider failures into 502s and bad references into 404s.

    The distinction matters to n8n: a 5xx is worth retrying on a schedule, a 4xx
    never is, and a workflow that retries a missing row forever is worse than
    one that stops.
    """
    try:
        return fn(*args, **kwargs)
    except ProviderError as exc:
        raise HTTPException(status_code=502 if exc.retryable else 400, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


# --- Observability ----------------------------------------------------------


@app.get("/health")
def health() -> dict:
    """
    Liveness plus the configuration question worth asking daily: how much of
    this depends on someone else's uptime, and is the buffer deep enough that a
    failure today would not break the posting streak.
    """
    try:
        counts = db.pipeline_counts()
        database = "up"
    except Exception as exc:  # a dead database must still return a readable body
        counts, database = {}, f"down: {exc}"

    return {
        "status": "ok" if database == "up" else "degraded",
        "database": database,
        "providers": describe(),
        "pipeline": counts,
    }


@app.get("/pipeline")
def pipeline() -> dict:
    return {"counts": db.pipeline_counts(), "failures": db.recent_failures(limit=10)}


@app.get("/review")
def review(limit: int = 20) -> dict:
    """The morning queue: pieces waiting on the human gate."""
    return {"pieces": db.query("select * from review_queue limit %s", (limit,))}


@app.get("/pieces/{piece_id}")
def piece(piece_id: str) -> dict:
    row = db.one("select * from pieces where id = %s", (piece_id,))
    if not row:
        raise HTTPException(status_code=404, detail=f"no piece {piece_id}")
    return {"piece": row, "variants": db.variants_for(piece_id)}


# --- Stages -----------------------------------------------------------------


@app.post("/harvest")
def harvest(body: HarvestBody) -> dict:
    return _guard(stages.harvest, body.items, source=body.source, topic=body.topic)


@app.post("/score")
def score(body: ScoreBody) -> dict:
    return _guard(stages.score_ideas, topic=body.topic, limit=body.limit)


@app.post("/script")
def script(body: ScriptBody) -> dict:
    return _guard(stages.script_idea, body.idea_id, seconds=body.seconds,
                  voice_doc=body.voice_doc, targets=body.targets)


@app.post("/approve")
def approve(body: ApproveBody) -> dict:
    return _guard(stages.approve_piece, body.piece_id)


@app.post("/reject")
def reject(body: ApproveBody) -> dict:
    return _guard(stages.reject_piece, body.piece_id, body.reason)


@app.post("/assets")
def assets(body: AssetsBody) -> dict:
    return _guard(stages.build_assets, body.variant_id)


@app.post("/schedule")
def schedule(body: ScheduleBody) -> dict:
    return _guard(stages.fill_schedule, slots_per_day=body.slots_per_day, days=body.days,
                  start_hour=body.start_hour, jitter_minutes=body.jitter_minutes)


@app.post("/publish")
def publish(body: PublishBody) -> dict:
    return _guard(stages.publish_due, limit=body.limit)


@app.post("/metrics")
def metrics(body: MetricsBody) -> dict:
    return _guard(stages.collect_metrics, body.readings)


# --- Queues n8n polls -------------------------------------------------------


@app.get("/queue/{status}")
def queue(status: str, platform: str = "", limit: int = 20) -> dict:
    """
    Rows sitting in one status.

    The asset workflow polls `approved`, the publisher polls `queued`. Exposing
    the queue rather than pushing work keeps n8n in charge of concurrency, which
    is where the retry and rate-limit settings already live.
    """
    allowed = {"draft", "approved", "rendering", "ready", "queued",
               "publishing", "published", "failed"}
    if status not in allowed:
        raise HTTPException(status_code=400, detail=f"unknown status {status!r}")
    return {"status": status,
            "variants": db.variants_by_status(status, platform=platform, limit=limit)}


@app.get("/due")
def due(limit: int = 10) -> dict:
    """What the publisher would ship right now. Safe to poll; changes nothing."""
    return {"variants": db.query(
        "select * from variants where status = 'queued' and scheduled_at <= now() "
        "order by scheduled_at limit %s", (limit,),
    ), "now": datetime.now(timezone.utc).isoformat()}
