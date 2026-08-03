#!/usr/bin/env python3
"""Harden OSM pedestrian tags before an OTP graph build."""

import os
import sys


EXPRESSWAY_HIGHWAYS = {
    "motorway",
    "motorway_link",
    "trunk",
    "trunk_link",
}


def rewritten_tags(source):
    """Return updated tags and the applied hardening rule names."""
    tags = dict(source)
    applied = []
    highway = tags.get("highway")
    if (
        highway in EXPRESSWAY_HIGHWAYS
        and "foot" not in tags
        and (tags.get("sidewalk") == "no" or tags.get("bridge") == "yes")
    ):
        tags["foot"] = "no"
        applied.append("expressway")
    if (
        highway == "steps"
        and tags.get("ramp:wheelchair") != "yes"
        and tags.get("wheelchair") != "yes"
    ):
        tags["wheelchair"] = "no"
        applied.append("steps")
    return tags, applied


def make_handler(osmium, writer):
    """Build the pyosmium handler that rewrites ways and preserves other entities."""
    class WalkSafetyHandler(osmium.SimpleHandler):
        def __init__(self):
            super().__init__()
            self.expressway_count = 0
            self.steps_count = 0

        def node(self, node):
            writer.add_node(node)

        def way(self, way):
            tags, applied = rewritten_tags(way.tags)
            if "expressway" in applied:
                self.expressway_count += 1
            if "steps" in applied:
                self.steps_count += 1
            writer.add_way(way.replace(tags=tags) if applied else way)

        def relation(self, relation):
            writer.add_relation(relation)

    return WalkSafetyHandler()


def main(argv=None):
    """Rewrite one input PBF to one new output PBF."""
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 2:
        raise SystemExit(
            f"Usage: {sys.argv[0]} <input.osm.pbf> <output.osm.pbf>"
        )
    input_pbf, output_pbf = args
    if not os.path.isfile(input_pbf):
        raise SystemExit(f"Input PBF not found: {input_pbf}")
    if os.path.abspath(input_pbf) == os.path.abspath(output_pbf):
        raise SystemExit("Input and output PBF paths must differ")
    if os.path.exists(output_pbf):
        raise SystemExit(f"Output PBF already exists: {output_pbf}")
    try:
        import osmium
    except ImportError as error:
        raise SystemExit(
            "pyosmium is required for walk-safety preprocessing"
        ) from error

    writer = osmium.SimpleWriter(osmium.io.File(output_pbf, "pbf"))
    handler = make_handler(osmium, writer)
    try:
        handler.apply_file(input_pbf)
    finally:
        writer.close()
    print(
        "[deny-foot-on-expressways] "
        f"foot=no ways={handler.expressway_count} "
        f"wheelchair=no steps={handler.steps_count}"
    )


if __name__ == "__main__":
    main()
