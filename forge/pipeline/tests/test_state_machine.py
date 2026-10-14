"""
State machine behaviour.

The transitions here are the ones that stop the pipeline doing something twice —
posting the same cut from two workers, republishing an idea that arrived under a
second headline, cloning a variant on a re-run. Each is enforced in SQL rather
than in Python, so these tests exercise the constraint, not the caller.
"""

from __future__ import annotations

import pytest

from .conftest import needs_db

pytestmark = needs_db


def test_duplicate_fingerprint_is_dropped(clean):
    first = clean.insert_idea(source="rss", title="Why KPIs lie", fingerprint="fp-1")
    second = clean.insert_idea(source="reddit", title="Why KPIs lie (repost)", fingerprint="fp-1")
    assert first is not None
    assert second is None, "the same story under a new headline must not enter twice"


def test_variant_upserts_instead_of_cloning(clean):
    piece = clean.insert_piece(idea_id=None, title="t", script="s")
    first = clean.insert_variant(piece_id=piece, platform="tiktok", format="short",
                                 width=1080, height=1920, caption="original")
    again = clean.insert_variant(piece_id=piece, platform="tiktok", format="short",
                                 width=1080, height=1920, caption="updated")
    assert first == again
    assert len(clean.variants_for(piece)) == 1
    assert clean.one("select caption from variants where id=%s", (first,))["caption"] == "updated"


def test_only_one_worker_can_claim_a_row(clean):
    """The guard that stops two asset workers rendering — and billing — twice."""
    piece = clean.insert_piece(idea_id=None, title="t", script="s")
    variant = clean.insert_variant(piece_id=piece, platform="tiktok", format="short",
                                   width=1080, height=1920)
    clean.execute("update variants set status='approved' where id=%s", (variant,))

    assert clean.claim("variants", variant, from_status="approved", to_status="rendering") is True
    assert clean.claim("variants", variant, from_status="approved", to_status="rendering") is False
    assert clean.one("select status from variants where id=%s", (variant,))["status"] == "rendering"


@pytest.mark.parametrize("table", ["users", "variants; drop table pieces", ""])
def test_claim_rejects_tables_off_the_allowlist(clean, table):
    with pytest.raises(ValueError):
        clean.claim(table, "00000000-0000-0000-0000-000000000000",
                    from_status="a", to_status="b")


def test_failure_is_recorded_with_its_reason(clean):
    piece = clean.insert_piece(idea_id=None, title="t", script="s")
    variant = clean.insert_variant(piece_id=piece, platform="tiktok", format="short",
                                   width=1080, height=1920)
    clean.fail("variants", variant, "tts provider timed out")

    row = clean.one("select status, last_error from variants where id=%s", (variant,))
    assert row["status"] == "failed"
    assert "tts provider" in row["last_error"]
    assert any(str(f["id"]) == variant for f in clean.recent_failures())


def test_republishing_updates_rather_than_duplicates(clean):
    piece = clean.insert_piece(idea_id=None, title="t", script="s")
    variant = clean.insert_variant(piece_id=piece, platform="tiktok", format="short",
                                   width=1080, height=1920)
    first = clean.record_publication(variant_id=variant, platform="tiktok",
                                     provider="dry_run", external_id="x1")
    second = clean.record_publication(variant_id=variant, platform="tiktok",
                                      provider="dry_run", external_id="x2")
    assert first == second
    assert clean.one("select external_id from publications where id=%s",
                     (first,))["external_id"] == "x2"


def test_metrics_append_so_curves_survive(clean):
    """Snapshots, not counters — shape is the signal, not the final total."""
    piece = clean.insert_piece(idea_id=None, title="t", script="s")
    variant = clean.insert_variant(piece_id=piece, platform="tiktok", format="short",
                                   width=1080, height=1920)
    publication = clean.record_publication(variant_id=variant, platform="tiktok",
                                           provider="dry_run", external_id="x")
    clean.record_metrics(publication_id=publication, views=100)
    clean.record_metrics(publication_id=publication, views=250)

    snapshots = clean.query(
        "select views from metrics where publication_id=%s order by captured_at", (publication,))
    assert [s["views"] for s in snapshots] == [100, 250]


def test_deleting_a_piece_cascades_to_its_cuts(clean):
    piece = clean.insert_piece(idea_id=None, title="t", script="s")
    variant = clean.insert_variant(piece_id=piece, platform="tiktok", format="short",
                                   width=1080, height=1920)
    clean.insert_asset(variant_id=variant, kind="video", storage_key="k/v.mp4")

    clean.execute("delete from pieces where id=%s", (piece,))
    assert clean.query("select 1 from variants where piece_id=%s", (piece,)) == []
    assert clean.query("select 1 from assets where variant_id=%s", (variant,)) == []


def test_updated_at_trigger_fires(clean):
    piece = clean.insert_piece(idea_id=None, title="t", script="s")
    before = clean.one("select updated_at from pieces where id=%s", (piece,))["updated_at"]
    clean.execute("update pieces set title='changed' where id=%s", (piece,))
    after = clean.one("select updated_at from pieces where id=%s", (piece,))["updated_at"]
    assert after > before


def test_review_queue_summarises_a_draft(clean):
    piece = clean.insert_piece(idea_id=None, title="Why KPIs lie", script="s", hook="A hook")
    clean.insert_variant(piece_id=piece, platform="tiktok", format="short",
                         width=1080, height=1920)
    clean.insert_variant(piece_id=piece, platform="youtube", format="long",
                         width=1920, height=1080)

    rows = clean.query("select * from review_queue")
    assert len(rows) == 1
    assert rows[0]["variant_count"] == 2
    assert sorted(rows[0]["platforms"]) == ["tiktok", "youtube"]


def test_pipeline_counts_reports_the_buffer(clean):
    """Buffer depth is the figure that predicts whether posting stops."""
    piece = clean.insert_piece(idea_id=None, title="t", script="s")
    variant = clean.insert_variant(piece_id=piece, platform="tiktok", format="short",
                                   width=1080, height=1920)
    clean.execute("update variants set status='ready' where id=%s", (variant,))

    counts = clean.pipeline_counts()
    assert counts["buffer"] == 1
    assert set(counts) >= {"ideas", "pieces", "variants", "buffer"}
