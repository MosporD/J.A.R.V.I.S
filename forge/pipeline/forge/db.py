"""
Database access.

Deliberately plain SQL over a connection pool rather than an ORM. The state
machine is the point of this system, and reading a transition as the exact
UPDATE that performs it — including which statuses it will refuse to move from —
is worth more here than model classes would be.
"""

from __future__ import annotations

import json
from contextlib import contextmanager
from typing import Any, Iterator

import psycopg
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from .config import settings

_pool: ConnectionPool | None = None


def pool() -> ConnectionPool:
    global _pool
    if _pool is None:
        _pool = ConnectionPool(settings().database_url, min_size=1, max_size=8, open=True)
    return _pool


@contextmanager
def connection() -> Iterator[psycopg.Connection]:
    with pool().connection() as conn:
        conn.row_factory = dict_row
        yield conn


def query(sql: str, params: tuple = ()) -> list[dict]:
    with connection() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchall()


def one(sql: str, params: tuple = ()) -> dict | None:
    rows = query(sql, params)
    return rows[0] if rows else None


def execute(sql: str, params: tuple = ()) -> int:
    with connection() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            return cur.rowcount


# --- Stage transitions ------------------------------------------------------
#
# Each of these names a source status in its WHERE clause. That is not defensive
# padding: two workers polling the same queue will both try to claim a row, and
# the one whose UPDATE matches zero rows must know it lost rather than proceed to
# render something twice.


def claim(table: str, row_id: str, *, from_status: str, to_status: str) -> bool:
    """Move a row forward. False when another worker got there first."""
    if table not in {"pieces", "variants"}:
        raise ValueError(f"refusing to claim from unknown table {table!r}")
    changed = execute(
        f"update {table} set status = %s where id = %s and status = %s",
        (to_status, row_id, from_status),
    )
    return changed == 1


def fail(table: str, row_id: str, error: str) -> None:
    if table not in {"pieces", "variants"}:
        raise ValueError(f"refusing to fail unknown table {table!r}")
    execute(
        f"update {table} set status = 'failed', last_error = %s where id = %s",
        (error[:2000], row_id),
    )


def record_run(workflow: str, *, subject_type: str = "", subject_id: str | None = None,
               status: str = "ok", provider: str = "", detail: dict | None = None) -> None:
    """
    Append to the audit log.

    Written even on success: performance questions ("why did yesterday's batch
    take an hour") are answered from this table, not just failures.
    """
    execute(
        """
        insert into runs (workflow, subject_type, subject_id, status, provider, detail, finished_at)
        values (%s, %s, %s, %s, %s, %s, now())
        """,
        (workflow, subject_type or None, subject_id, status, provider or None,
         json.dumps(detail or {})),
    )


# --- Ideas ------------------------------------------------------------------


def insert_idea(*, source: str, title: str, fingerprint: str, summary: str = "",
                topic: str = "", source_ref: str = "", score: float = 0,
                payload: dict | None = None) -> str | None:
    """
    Returns the new id, or None when the fingerprint is already known.

    Harvesters run daily over overlapping feeds, so silently dropping a repeat
    is the expected path rather than an error worth raising.
    """
    with connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                insert into ideas (source, source_ref, title, summary, topic, fingerprint, score, payload)
                values (%s, %s, %s, %s, %s, %s, %s, %s)
                on conflict (fingerprint) do nothing
                returning id
                """,
                (source, source_ref or None, title, summary or None, topic or None,
                 fingerprint, score, json.dumps(payload or {})),
            )
            row = cur.fetchone()
            return str(row["id"]) if row else None


def next_ideas(limit: int = 5) -> list[dict]:
    return query(
        "select * from ideas where status = 'approved' order by score desc, created_at limit %s",
        (limit,),
    )


# --- Pieces and variants ----------------------------------------------------


def insert_piece(*, idea_id: str | None, title: str, script: str, hook: str = "",
                 topic: str = "", llm_provider: str = "") -> str:
    row = one(
        """
        insert into pieces (idea_id, title, script, hook, topic, llm_provider)
        values (%s, %s, %s, %s, %s, %s)
        returning id
        """,
        (idea_id, title, script, hook or None, topic or None, llm_provider or None),
    )
    return str(row["id"])


def insert_variant(*, piece_id: str, platform: str, format: str, width: int, height: int,
                   script: str = "", caption: str = "", hashtags: list[str] | None = None) -> str:
    """Upserts: re-running the script stage refreshes a cut rather than cloning it."""
    row = one(
        """
        insert into variants (piece_id, platform, format, width, height, script, caption, hashtags)
        values (%s, %s, %s, %s, %s, %s, %s, %s)
        on conflict (piece_id, platform, format) do update
          set script = excluded.script,
              caption = excluded.caption,
              hashtags = excluded.hashtags
        returning id
        """,
        (piece_id, platform, format, width, height, script or None,
         caption or None, hashtags or []),
    )
    return str(row["id"])


def variants_for(piece_id: str) -> list[dict]:
    return query("select * from variants where piece_id = %s order by platform", (piece_id,))


def variants_by_status(status: str, *, platform: str = "", limit: int = 20) -> list[dict]:
    if platform:
        return query(
            "select * from variants where status = %s and platform = %s "
            "order by scheduled_at nulls last, created_at limit %s",
            (status, platform, limit),
        )
    return query(
        "select * from variants where status = %s order by scheduled_at nulls last, created_at limit %s",
        (status, limit),
    )


def set_render_spec(variant_id: str, spec: dict) -> None:
    execute("update variants set render_spec = %s where id = %s",
            (json.dumps(spec), variant_id))


def schedule_variant(variant_id: str, when) -> bool:
    """False when the row was no longer 'ready' — another scheduler took it."""
    return execute(
        "update variants set status = 'queued', scheduled_at = %s "
        "where id = %s and status = 'ready'",
        (when, variant_id),
    ) == 1


# --- Assets and publications ------------------------------------------------


def insert_asset(*, variant_id: str, kind: str, storage_key: str, provider: str = "",
                 duration_ms: int | None = None, size_bytes: int | None = None,
                 meta: dict | None = None) -> str:
    row = one(
        """
        insert into assets (variant_id, kind, storage_key, provider, duration_ms, bytes, meta)
        values (%s, %s, %s, %s, %s, %s, %s)
        returning id
        """,
        (variant_id, kind, storage_key, provider or None, duration_ms, size_bytes,
         json.dumps(meta or {})),
    )
    return str(row["id"])


def assets_for(variant_id: str, kind: str = "") -> list[dict]:
    if kind:
        return query(
            "select * from assets where variant_id = %s and kind = %s order by created_at",
            (variant_id, kind),
        )
    return query("select * from assets where variant_id = %s order by created_at", (variant_id,))


def record_publication(*, variant_id: str, platform: str, provider: str,
                       external_id: str = "", url: str = "",
                       response: dict | None = None, published_at=None) -> str:
    row = one(
        """
        insert into publications (variant_id, platform, provider, external_id, url, response, published_at)
        values (%s, %s, %s, %s, %s, %s, %s)
        on conflict (variant_id, platform) do update
          set external_id = excluded.external_id,
              url = excluded.url,
              response = excluded.response,
              published_at = excluded.published_at
        returning id
        """,
        (variant_id, platform, provider, external_id or None, url or None,
         json.dumps(response or {}), published_at),
    )
    return str(row["id"])


def record_metrics(*, publication_id: str, views: int = 0, likes: int = 0, comments: int = 0,
                   shares: int = 0, watch_seconds: int = 0, raw: dict | None = None) -> None:
    execute(
        """
        insert into metrics (publication_id, views, likes, comments, shares, watch_seconds, raw)
        values (%s, %s, %s, %s, %s, %s, %s)
        """,
        (publication_id, views, likes, comments, shares, watch_seconds, json.dumps(raw or {})),
    )


def active_publications(days: int = 30) -> list[dict]:
    """What the metrics collector walks — recent posts still worth re-sampling."""
    return query(
        """
        select p.*, v.platform as variant_platform, v.piece_id
        from publications p
        join variants v on v.id = p.variant_id
        where p.published_at > now() - make_interval(days => %s)
        order by p.published_at desc
        """,
        (days,),
    )


# --- Dashboard --------------------------------------------------------------


def pipeline_counts() -> dict[str, Any]:
    """Rows per status, per stage. What /health and a J.A.R.V.I.S panel read."""
    pieces = query("select status::text as status, count(*) as n from pieces group by status")
    variants = query("select status::text as status, count(*) as n from variants group by status")
    ideas = query("select status::text as status, count(*) as n from ideas group by status")
    buffer_row = one(
        "select count(*) as n from variants where status in ('ready', 'queued')"
    )
    return {
        "ideas": {r["status"]: r["n"] for r in ideas},
        "pieces": {r["status"]: r["n"] for r in pieces},
        "variants": {r["status"]: r["n"] for r in variants},
        # The number that actually predicts whether posting stops: how many days
        # of approved, rendered content sit ahead of the schedule.
        "buffer": buffer_row["n"] if buffer_row else 0,
    }


def recent_failures(limit: int = 20) -> list[dict]:
    return query(
        """
        select 'variant' as kind, id::text, platform, last_error, updated_at
        from variants where status = 'failed'
        union all
        select 'piece', id::text, topic, last_error, updated_at
        from pieces where status = 'failed'
        order by updated_at desc
        limit %s
        """,
        (limit,),
    )
