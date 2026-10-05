#!/usr/bin/env python3
"""Normalize official Wheelroute snapshots into a reviewable map layer.

No width/slope conversion or routing assertion is made: published units conflict
with observed values, and the feed has no device ID, update time or live status.
The optional PostGIS destination receives a reference table, never ped_edge edits.
"""
import argparse
from collections import Counter
import hashlib
import json
import math
from pathlib import Path

from shapely.geometry import Point, Polygon, mapping

KINDS = (1, 3, 7, 11, 12, 13)
TAIPEI_BBOX = (121.43, 24.95, 121.68, 25.22)
SOURCE_BASE = "https://wheelroute.gov.taipei/wheelrouteApi/api/facility/Get/"


def normalize(row, kind):
    """Return a valid in-coverage feature or raise ValueError with a reason."""
    if str(row.get("kind")) != str(kind):
        raise ValueError("kind_mismatch")
    try:
        if kind in (1, 3, 7):
            coordinates = [(float(row["lon"]), float(row["lat"]))]
            geometry = Point(coordinates[0])
        else:
            parts = str(row["location"]).strip("|").split("|")
            if len(parts) < 8 or len(parts) % 2:
                raise ValueError("malformed_ring")
            coordinates = [(float(parts[i]), float(parts[i + 1])) for i in range(0, len(parts), 2)]
            if coordinates[0] != coordinates[-1]:
                raise ValueError("unclosed_ring")
            geometry = Polygon(coordinates)
    except (KeyError, TypeError, OverflowError) as error:
        raise ValueError("malformed_coordinates") from error
    west, south, east, north = TAIPEI_BBOX
    if not all(math.isfinite(x) and math.isfinite(y) and west <= x <= east and south <= y <= north
               for x, y in coordinates):
        raise ValueError("outside_graph_coverage")
    if geometry.is_empty or not geometry.is_valid:
        raise ValueError("invalid_geometry")
    canonical = json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    # Content identity only: not a fabricated stable government facility ID.
    digest = hashlib.sha256(canonical.encode()).hexdigest()
    return {
        "type": "Feature", "id": f"wheelroute:{kind}:{digest}",
        "geometry": mapping(geometry),
        "properties": {
            "kind": kind, "name": row.get("kname"), "source_url": SOURCE_BASE + str(kind),
            "identity_type": "snapshot_content_hash", "source_updated_at": None,
            "operational_status": "unknown", "routing_eligible": False,
            "width_raw": row.get("width"), "width_unit": "unresolved",
            "slope_raw": row.get("slope"), "raw": row,
        },
    }


def prepare(input_dir, output_dir, database_url=None):
    output_dir.mkdir(parents=True, exist_ok=True)
    features, report, seen = [], {}, set()
    for kind in KINDS:
        source = input_dir / f"facility-{kind}.json"
        raw = source.read_bytes()
        snapshot_hash = hashlib.sha256(raw).hexdigest()
        rows = json.loads(raw)
        if not isinstance(rows, list):
            raise ValueError(f"kind {kind}: expected an array")
        counts = Counter()
        for row in rows:
            try:
                feature = normalize(row, kind)
                if feature["id"] in seen:
                    counts["duplicate_content"] += 1
                    continue
                seen.add(feature["id"])
                feature["properties"]["snapshot_sha256"] = snapshot_hash
                feature["properties"]["attribution"] = "臺北市政府交通局／輪行臺北"
                features.append(feature)
                counts["accepted"] += 1
            except (ValueError, AttributeError) as error:
                reason = str(error)
                counts[reason if reason in {"kind_mismatch", "malformed_ring", "unclosed_ring",
                                           "malformed_coordinates", "outside_graph_coverage",
                                           "invalid_geometry"} else "malformed_record"] += 1
        report[str(kind)] = {"rows": len(rows), "sha256": snapshot_hash, **counts}
    output = output_dir / "wheelroute-reference.geojson"
    output.write_text(json.dumps({"type": "FeatureCollection", "features": features},
                                 ensure_ascii=False, separators=(",", ":")))
    if database_url:
        import psycopg2
        from psycopg2.extras import execute_values
        with psycopg2.connect(database_url) as connection, connection.cursor() as cursor:
            cursor.execute("""CREATE TABLE IF NOT EXISTS wheelroute_reference (
                content_id text PRIMARY KEY, kind integer NOT NULL,
                geom geometry(Geometry,4326) NOT NULL, properties jsonb NOT NULL,
                imported_at timestamptz NOT NULL DEFAULT now())""")
            # All six snapshots have parsed successfully. Replace atomically so
            # changed/deleted facilities do not survive as stale content hashes.
            cursor.execute("DELETE FROM wheelroute_reference")
            execute_values(cursor, """INSERT INTO wheelroute_reference(content_id,kind,geom,properties)
                VALUES %s ON CONFLICT(content_id) DO UPDATE SET
                properties=EXCLUDED.properties, imported_at=now()""",
                [(f["id"], f["properties"]["kind"], json.dumps(f["geometry"]), json.dumps(f["properties"]))
                 for f in features], template="(%s,%s,ST_SetSRID(ST_GeomFromGeoJSON(%s),4326),%s::jsonb)",
                page_size=500)
            cursor.execute("CREATE INDEX IF NOT EXISTS wheelroute_reference_geom_idx ON wheelroute_reference USING gist(geom)")
    (output_dir / "wheelroute-validation.json").write_text(json.dumps(report, indent=2))
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--db-url")
    args = parser.parse_args()
    print(json.dumps(prepare(args.input_dir, args.output_dir, args.db_url)))
