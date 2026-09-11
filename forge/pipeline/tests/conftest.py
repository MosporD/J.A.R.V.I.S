"""
Shared fixtures.

Database tests need a real Postgres — the things worth testing here (concurrent
claims, upsert semantics, cascades, triggers) are exactly the things a fake
would get wrong. They skip cleanly when FORGE_TEST_DATABASE_URL is unset:

    createdb forge_test
    FORGE_TEST_DATABASE_URL=postgresql://localhost/forge_test pytest tests/ -v
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

SCHEMA = Path(__file__).resolve().parents[2] / "db" / "schema.sql"


def _database_url() -> str | None:
    return os.environ.get("FORGE_TEST_DATABASE_URL")


needs_db = pytest.mark.skipif(
    not _database_url(), reason="set FORGE_TEST_DATABASE_URL to run database tests"
)


@pytest.fixture(scope="session")
def database():
    """Apply the schema once, then hand every test a clean set of tables."""
    url = _database_url()
    if not url:
        pytest.skip("no test database")

    os.environ["DATABASE_URL"] = url
    import psycopg

    with psycopg.connect(url, autocommit=True) as conn:
        conn.execute(
            "drop schema public cascade; create schema public;"
        )
        conn.execute(SCHEMA.read_text())

    from forge import db as db_module

    yield db_module


@pytest.fixture
def clean(database):
    """Truncate between tests so ordering cannot leak state."""
    database.execute(
        "truncate ideas, pieces, variants, assets, publications, metrics, runs cascade"
    )
    return database
