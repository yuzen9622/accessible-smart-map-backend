#!/usr/bin/env python3
"""Export conservative sidewalk evidence from the same PBF used to build OTP.

Version 2 adds `crossings`: every crossing way that otp-kerb-ramps.py classified
(`tp:kerb_ramp_ends=<ramped>/<unramped>/<unknown>`), as
`[wayId, ramped, unramped, unknown, [[lon, lat], ...]]`, one row per OSM way so
the backend counts each crossing once.
"""
import hashlib
import json
import math
from pathlib import Path
import sys

CELL = 0.001
DENIED = {"no", "private", "restricted"}
INDEX_VERSION = 2


def kerb_ramp_ends(tags):
    """Parse `tp:kerb_ramp_ends`, or None when absent/invalid."""
    parts = (tags.get("tp:kerb_ramp_ends") or "").split("/")
    if len(parts) != 3 or not all(part.isdigit() for part in parts):
        return None
    counts = [int(part) for part in parts]
    return counts if sum(counts) == 2 else None


def sidewalk(tags):
    return (
        tags.get("highway") == "footway"
        and tags.get("a11y:inferred_connection") != "yes"
        and tags.get("footway") == "sidewalk"
        and tags.get("foot") not in DENIED
        and tags.get("access") not in DENIED
        and tags.get("indoor", "no") == "no"
        and tags.get("layer", "0") == "0"
        and tags.get("bridge", "no") == "no"
        and tags.get("tunnel", "no") == "no"
        and (tags.get("source") != "MOI sidewalk" or bool(tags.get("ref:moi_sidewalk")))
    )


def cells(ax, ay, bx, by):
    for x in range(math.floor((min(ax, bx) - 0.00003) / CELL), math.floor((max(ax, bx) + 0.00003) / CELL) + 1):
        for y in range(math.floor((min(ay, by) - 0.00003) / CELL), math.floor((max(ay, by) + 0.00003) / CELL) + 1):
            yield x, y


def main():
    import osmium

    source, output = map(Path, sys.argv[1:])
    if source.resolve() == output.resolve():
        raise SystemExit("Output must not replace the source PBF")
    segments = []
    crossings = []
    covered_cells = set()

    class Reader(osmium.SimpleHandler):
        def __init__(self, first):
            super().__init__()
            self.first = first

        def way(self, way):
            if not way.tags.get("highway"):
                return
            tags = dict(way.tags)
            is_sidewalk = sidewalk(tags)
            if not self.first:
                ends = kerb_ramp_ends(tags)
                if ends is not None:
                    points = [[n.lon, n.lat] for n in way.nodes if n.location.valid()]
                    if len(points) >= 2:
                        crossings.append([way.id, *ends, points])
            if is_sidewalk != self.first:
                return
            nodes = [node for node in way.nodes if node.location.valid()]
            for a, b in zip(nodes, nodes[1:]):
                length = math.hypot((b.lon - a.lon) * math.cos(math.radians(a.lat)), b.lat - a.lat) * 111320
                count = max(1, math.ceil(length / 100))
                for part in range(count):
                    ax = a.lon + (b.lon - a.lon) * part / count
                    ay = a.lat + (b.lat - a.lat) * part / count
                    bx = a.lon + (b.lon - a.lon) * (part + 1) / count
                    by = a.lat + (b.lat - a.lat) * (part + 1) / count
                    buckets = set(cells(ax, ay, bx, by))
                    if self.first:
                        covered_cells.update(buckets)
                    elif not buckets.intersection(covered_cells):
                        continue
                    segments.append(["sidewalk" if is_sidewalk else "other", ax, ay, bx, by, way.id])

    for first in (True, False):
        Reader(first).apply_file(str(source), locations=True)
    with source.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(".tmp")
    temporary.write_text(json.dumps({"version": INDEX_VERSION, "sourcePbfSha256": digest, "segments": segments, "crossings": crossings}, separators=(",", ":")))
    temporary.replace(output)
    print(json.dumps({"sourcePbfSha256": digest, "segments": len(segments), "sidewalkSegments": sum(segment[0] == "sidewalk" for segment in segments), "crossings": len(crossings), "bytes": output.stat().st_size}))


if __name__ == "__main__":
    main()
