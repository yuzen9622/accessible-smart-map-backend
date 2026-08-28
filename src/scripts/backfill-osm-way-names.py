#!/usr/bin/env python3
"""Backfill OSM way names into a standalone lookup table for CSR street-name steps.

`build-ped-graph.py` never reads the OSM `name` tag, so `ped_edge` carries no
street names and CSR `WalkStep`s always report `streetName: "" / bogusName:
true`. Rebuilding the graph to add names is unnecessary: `ped_edge.source_ref`
already records `osm:way/<id>` for every OSM-derived edge, so this script
scans the same PBF a second time for just those way ids and writes their
names into `ped_osm_way_name`, a table the CSR graph loader joins against at
read time. This table is intentionally outside the graph version lifecycle —
a name is an OSM-attribute fact independent of which graph version is
ACTIVE, so writing it here never touches an immutable graph version's rows.
"""

from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence

NAME_TAG_PREFERENCE = ("name", "name:zh", "name:zh-Hant")

CREATE_TABLE_SQL = """
    CREATE TABLE IF NOT EXISTS ped_osm_way_name (
      osm_way_id     BIGINT PRIMARY KEY,
      name           TEXT NOT NULL,
      source_version TEXT NOT NULL
    )
"""

WAY_ID_QUERY = """
    SELECT DISTINCT split_part(source_ref, '/', 2)::bigint AS osm_way_id
    FROM ped_edge
    WHERE source_ref LIKE 'osm:way/%'
"""

UPSERT_SQL = """
    INSERT INTO ped_osm_way_name (osm_way_id, name, source_version)
    VALUES %s
    ON CONFLICT (osm_way_id) DO UPDATE SET
      name = EXCLUDED.name,
      source_version = EXCLUDED.source_version
"""


def name_for_tags(tags: Mapping[str, str]) -> str | None:
    """Return the first present, non-blank name tag in preference order.

    Preference order is `name` -> `name:zh` -> `name:zh-Hant`. A way with no
    matching tag, or only blank values, returns None so the caller never
    writes an empty or placeholder name.
    """
    for tag in NAME_TAG_PREFERENCE:
        value = tags.get(tag)
        if value is None:
            continue
        text = str(value).strip()
        if text:
            return text
    return None


def source_updated_at(path: Path) -> str:
    """Return the UTC calendar date of an input file for provenance metadata."""
    return (
        datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).date().isoformat()
    )


def import_osmium() -> Any:
    """Import pyosmium only for PBF work so pure-function tests remain dependency-light."""
    try:
        import osmium
    except ImportError as error:
        raise SystemExit(
            "pyosmium is required to backfill OSM way names"
        ) from error
    return osmium


def collect_way_names(pbf_path: Path, way_ids: set[int]) -> dict[int, str]:
    """Scan a PBF once for the names of exactly the requested way ids.

    Only tags are needed (no node locations), so this reads directly off
    `SimpleHandler.apply_file`, the same tag-only pattern `build-ped-graph.py`
    already uses for its low-memory node-tag pass. That call is stable across
    both the legacy and the newer pyosmium API generation (the newer one has
    no `__version__` attribute), so no additional capability probing is
    required for this tag-only scan.
    """
    osmium = import_osmium()

    class WayNameCollector(osmium.SimpleHandler):
        def __init__(self) -> None:
            super().__init__()
            self.names: dict[int, str] = {}

        def way(self, way: Any) -> None:
            try:
                way_id = int(way.id)
            except (TypeError, ValueError):
                return
            if way_id not in way_ids:
                return
            name = name_for_tags(dict(way.tags))
            if name is not None:
                self.names[way_id] = name

    collector = WayNameCollector()
    collector.apply_file(str(pbf_path))
    return collector.names


def ensure_way_name_table(cursor: Any) -> None:
    """Idempotently create `ped_osm_way_name` if it does not exist yet."""
    cursor.execute(CREATE_TABLE_SQL)


def fetch_requested_way_ids(cursor: Any) -> set[int]:
    """Return the distinct OSM way ids the active graph's edges reference."""
    cursor.execute(WAY_ID_QUERY)
    return {int(row[0]) for row in cursor.fetchall()}


def write_way_names(
    cursor: Any, names: Mapping[int, str], source_version: str
) -> None:
    """Bulk upsert way names, keyed by OSM way id."""
    from psycopg2.extras import execute_values

    if not names:
        return
    rows = [
        (way_id, name, source_version) for way_id, name in names.items()
    ]
    execute_values(cursor, UPSERT_SQL, rows, page_size=1_000)


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    """Parse the documented PBF and database backfill contract."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pbf", type=Path, required=True, help="Input Taiwan OSM PBF")
    parser.add_argument(
        "--db-url",
        default=os.environ.get("PED_GRAPH_DATABASE_URL"),
        help="PostGIS URL; defaults to PED_GRAPH_DATABASE_URL",
    )
    args = parser.parse_args(argv)
    if not args.pbf.is_file():
        parser.error(f"PBF not found: {args.pbf}")
    if not args.db_url:
        parser.error("--db-url or PED_GRAPH_DATABASE_URL is required")
    return args


def main(argv: Sequence[str] | None = None) -> int:
    """Run the complete offline PBF-to-PostGIS OSM way name backfill."""
    args = parse_args(argv)
    try:
        import psycopg2
    except ImportError as error:
        raise SystemExit(
            "psycopg2 is required to backfill OSM way names"
        ) from error

    connection = psycopg2.connect(args.db_url)
    try:
        with connection, connection.cursor() as cursor:
            ensure_way_name_table(cursor)
            requested_ids = fetch_requested_way_ids(cursor)
            print(f"[backfill-osm-way-names] requested_way_ids={len(requested_ids)}")
            if not requested_ids:
                print("[backfill-osm-way-names] no osm:way/ edges found; nothing to do")
                return 0
            names = collect_way_names(args.pbf, requested_ids)
            source_version = source_updated_at(args.pbf)
            write_way_names(cursor, names, source_version)
            coverage_pct = (
                round(len(names) / len(requested_ids) * 100.0, 3)
                if requested_ids
                else 0.0
            )
            print(f"[backfill-osm-way-names] pbf_hits={len(names)}")
            print(f"[backfill-osm-way-names] rows_written={len(names)}")
            print(f"[backfill-osm-way-names] coverage_pct={coverage_pct}")
    finally:
        connection.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
