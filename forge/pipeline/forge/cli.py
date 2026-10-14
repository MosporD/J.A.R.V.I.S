"""
Driving the pipeline by hand.

Every stage n8n calls is also a command here. That is not a convenience: the
fastest way to debug a workflow is to run its stage in a terminal and read the
traceback, and the fastest way to start posting is to run these by hand for a
few weeks before automating anything.

    python -m forge.cli doctor
    python -m forge.cli render spec.json
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import typer

from . import db, stages
from .config import settings
from .providers import ProviderError, describe

cli = typer.Typer(add_completion=False, help="forge — content pipeline")


def _print(payload) -> None:
    typer.echo(json.dumps(payload, indent=2, default=str))


@cli.command()
def doctor() -> None:
    """
    Check what is wired up and whether it answers.

    Run this first. It reports which slots are self-hosted, whether the database
    is reachable, and how deep the buffer is — the three things that determine
    whether the channel keeps posting tomorrow.
    """
    config = settings()
    local, total = config.local_share
    typer.echo(f"self-hosted slots: {local}/{total}\n")

    for name, slot in describe()["slots"].items():
        mark = "local " if slot["local"] else "remote"
        model = f" [{slot['model']}]" if slot["model"] else ""
        typer.echo(f"  {mark}  {name:<11} {slot['provider']}{model}")

    typer.echo("")
    try:
        counts = db.pipeline_counts()
        typer.echo(f"  database   up")
        typer.echo(f"  buffer     {counts['buffer']} cuts ready or queued")
        for stage, rows in counts.items():
            if stage != "buffer" and rows:
                typer.echo(f"  {stage:<10} {rows}")
    except Exception as exc:
        typer.secho(f"  database   DOWN — {exc}", fg="red")
        raise typer.Exit(1)

    # A shallow buffer is the failure that actually ends channels: the pipeline
    # is fine right up until a bad week means nothing goes out.
    if counts["buffer"] < 7:
        typer.secho(f"\n  buffer is thin ({counts['buffer']}). Aim for 7-14 days ahead.",
                    fg="yellow")


@cli.command()
def harvest(source: str, file: Path = typer.Argument(..., help="JSON array of candidates"),
            topic: str = "") -> None:
    """Load harvested candidates from a JSON file."""
    items = json.loads(file.read_text())
    _print(stages.harvest(items, source=source, topic=topic))


@cli.command()
def score(topic: str, limit: int = 20) -> None:
    """Rank unscored ideas on the cheap model."""
    _print(stages.score_ideas(topic=topic, limit=limit))


@cli.command()
def script(idea_id: str, seconds: int = 90,
           voice_file: Path = typer.Option(None, help="channel voice document")) -> None:
    """Write the master script for an idea and cut it into variants."""
    voice = voice_file.read_text() if voice_file and voice_file.exists() else ""
    _print(stages.script_idea(idea_id, seconds=seconds, voice_doc=voice))


@cli.command()
def review(limit: int = 20) -> None:
    """List pieces waiting on the human gate."""
    rows = db.query("select * from review_queue limit %s", (limit,))
    if not rows:
        typer.echo("nothing waiting for review.")
        return
    for row in rows:
        typer.secho(f"\n{row['piece_id']}  {row['title']}", bold=True)
        typer.echo(f"  hook: {row['hook']}")
        typer.echo(f"  cuts: {row['variant_count']} — {', '.join(row['platforms'] or [])}")


@cli.command()
def approve(piece_id: str) -> None:
    """Approve a piece and every cut derived from it."""
    _print(stages.approve_piece(piece_id))


@cli.command()
def reject(piece_id: str, reason: str = "") -> None:
    _print(stages.reject_piece(piece_id, reason))


@cli.command()
def assets(variant_id: str) -> None:
    """Build narration, footage, captions and the final render for one cut."""
    _print(stages.build_assets(variant_id))


@cli.command("assets-all")
def assets_all(limit: int = 10) -> None:
    """Build every approved cut. What the nightly asset workflow does."""
    built, failed = [], []
    for variant in db.variants_by_status("approved", limit=limit):
        variant_id = str(variant["id"])
        try:
            built.append(stages.build_assets(variant_id))
        except (ProviderError, ValueError) as exc:
            # One bad cut must not stop the batch; it is already marked failed.
            typer.secho(f"  failed {variant_id}: {exc}", fg="red")
            failed.append(variant_id)
    _print({"built": len(built), "failed": len(failed)})


@cli.command()
def schedule(slots_per_day: int = 3, days: int = 7, start_hour: int = 9) -> None:
    """Assign ready cuts to jittered posting slots."""
    _print(stages.fill_schedule(slots_per_day=slots_per_day, days=days, start_hour=start_hour))


@cli.command()
def publish(limit: int = 5) -> None:
    """Ship everything currently due."""
    _print(stages.publish_due(limit=limit))


@cli.command()
def render(spec_file: Path) -> None:
    """
    Render a spec JSON straight to a file.

    The spec of any variant is stored on its row, so a render that came out
    wrong can be dumped, edited, and replayed here without touching the rest of
    the pipeline.
    """
    from .providers import get_renderer
    from .render.spec import RenderSpec

    spec = RenderSpec.from_dict(json.loads(spec_file.read_text()))
    typer.echo(f"rendering {spec.width}x{spec.height} -> {spec.output}")
    output = get_renderer().render(spec)
    typer.secho(f"wrote {output} ({output.stat().st_size // 1024} KB)", fg="green")


@cli.command("dump-spec")
def dump_spec(variant_id: str, out: Path = Path("spec.json")) -> None:
    """Write a variant's stored render spec to a file for editing."""
    row = db.one("select render_spec from variants where id = %s", (variant_id,))
    if not row or not row["render_spec"]:
        typer.secho("no stored spec for that variant", fg="red")
        raise typer.Exit(1)
    out.write_text(json.dumps(row["render_spec"], indent=2))
    typer.echo(f"wrote {out}")


@cli.command()
def failures(limit: int = 20) -> None:
    """What broke, where, and why."""
    rows = db.recent_failures(limit=limit)
    if not rows:
        typer.secho("no failures.", fg="green")
        return
    for row in rows:
        typer.secho(f"{row['kind']} {row['id']}", fg="red")
        typer.echo(f"  {row['last_error']}")


def main() -> None:
    try:
        cli()
    except ProviderError as exc:
        typer.secho(str(exc), fg="red")
        sys.exit(1)


if __name__ == "__main__":
    main()
