#!/usr/bin/env python3
"""Extract conservative direction/exception rules from one frozen OSM snapshot."""
import argparse
import hashlib
import importlib.metadata
import json
import math
import re
from pathlib import Path
from tempfile import TemporaryDirectory

SCHEMA_VERSION = 1
EXTRACTOR_VERSION = "2"


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def parse_speed(raw):
    value = raw.strip().lower()
    if value == "none":
        return {"kind": "unlimited", "limitKph": None, "rawValue": raw}
    match = re.fullmatch(r"([0-9]+(?:\.[0-9]+)?)\s*(km/h|kmh|kph|mph|knots)?", value)
    if match:
        speed = float(match[1]) * {"mph": 1.609344, "knots": 1.852}.get(match[2], 1)
        if math.isfinite(speed) and 0 < speed <= 300:
            return {"kind": "known", "limitKph": speed, "rawValue": raw}
    return {"kind": "invalid", "limitKph": None, "rawValue": raw}


def way_rules(tags):
    speeds = {key: value for key, value in tags.items() if key == "maxspeed" or key.startswith("maxspeed:")}
    if not speeds:
        return None
    rule: dict[str, object] = {"unresolvedConditional": False, "unresolvedLaneSpecific": False}
    for key in speeds:
        parts = key.split(":")[1:]
        if "lanes" in parts:
            rule["unresolvedLaneSpecific"] = True
        elif key not in ("maxspeed", "maxspeed:forward", "maxspeed:backward"):
            # Vehicle/conditional/unsupported qualifiers cannot be evaluated for both profiles.
            rule["unresolvedConditional"] = True
    general = parse_speed(speeds["maxspeed"]) if "maxspeed" in speeds else None
    for direction in ("forward", "backward"):
        key = "maxspeed:" + direction
        if key in speeds:
            rule[direction] = parse_speed(speeds[key])
        elif general and general["kind"] == "invalid":
            rule[direction] = general
    return rule if len(rule) > 2 or any(rule.values()) else None


def write_json(path, value):
    path = Path(path)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n", encoding="utf-8")
    temporary.replace(path)


def extract(source, output, expected_hash, metadata_output=None):
    import osmium
    from osmium.io import Reader

    if sha256(source) != expected_hash:
        raise ValueError("source PBF hash mismatch before extraction")
    ways = {}

    class Handler(osmium.SimpleHandler):
        def way(self, way):
            rule = way_rules(dict(way.tags))
            if rule is not None:
                if way.id <= 0:
                    raise ValueError("OSM way ID must be positive")
                geometry = []
                for node in way.nodes:
                    if not node.location.valid():
                        geometry = []
                        break
                    geometry.append([node.lon, node.lat])
                if len(geometry) >= 2:
                    rule["osmGeometry"] = geometry
                ways[str(way.id)] = rule

    with Reader(str(source)) as reader:
        timestamp = reader.header().get("osmosis_replication_timestamp") or None
    # Disk-backed node cache stays beside the output on the configured data volume.
    with TemporaryDirectory(prefix="speed-rule-nodes-", dir=Path(output).parent) as temporary:
        Handler().apply_file(str(source), locations=True, idx="sparse_file_array," + str(Path(temporary) / "nodes.idx"))
    if sha256(source) != expected_hash:
        raise ValueError("source PBF changed during extraction")
    write_json(output, {"schemaVersion": SCHEMA_VERSION, "sourcePbfSha256": expected_hash, "ways": ways})
    if metadata_output:
        write_json(metadata_output, {"sourcePbfTimestamp": timestamp, "extractorVersion": EXTRACTOR_VERSION, "pyosmiumVersion": importlib.metadata.version("osmium")})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--source-sha256", required=True)
    parser.add_argument("--metadata-output", type=Path)
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9a-f]{64}", args.source_sha256):
        parser.error("source-sha256 must be a lowercase SHA256")
    extract(args.input, args.output, args.source_sha256, args.metadata_output)


if __name__ == "__main__":
    main()
