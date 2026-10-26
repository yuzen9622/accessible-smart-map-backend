"""Native OSM footprint assembly, not a source of traversable walking ways.

Semantic rules: CC0 osm-polygon-features, commit
4cf8126babeb6c7a2fb756d2a9441a1b93353c30 (sibling JSON/license).
Incomplete required negative geometry rejects, except the pinned, logged omission.
"""

import hashlib
import json
import sys
from collections.abc import Mapping
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory
from types import MappingProxyType
from typing import Any

import osmium
from osmium.geom import WKBFactory
from shapely import from_wkb
from shapely.geometry import LineString, box

POLICY_VERSION = "osm-areas-v1"
OMISSION_POLICY_VERSION = "osm-area-omissions-v1"
_APPROVED_OMISSION = {
    "source_ref": "osm:relation/13730976",
    "osm_version": 1,
    "raw_tags": {"building": "yes", "tourism": "hotel", "type": "multipolygon"},
    "member_refs": [["n", 9454749084, "inner"]],
    "reason": "missing_outer_geometry",
    "decision": "user-approved-single-record-omission-2026-10-25",
    "spatial_extent": None,
}
_OMISSION_JSON = json.dumps(_APPROVED_OMISSION, sort_keys=True, separators=(",", ":"))
OMISSION_POLICY_SHA256 = hashlib.sha256(_OMISSION_JSON.encode()).hexdigest()
EXCLUSION_POLICY_VERSION = "osm-area-omissions-v2"
_EXCLUSION_POLICY = {
    "version": EXCLUSION_POLICY_VERSION,
    "decision": "user-approved-invalid-source-exclusion-2026-10-25",
    "scope": "identifiable invalid OSM area geometry, membership or semantics only",
    "preserve": "independently valid members; fatal IO, software and resource failures",
}
EXCLUSION_POLICY_SHA256 = hashlib.sha256(
    json.dumps(_EXCLUSION_POLICY, sort_keys=True, separators=(",", ":")).encode()
).hexdigest()
RULES_SHA256 = "cf81018ba820557c59c2c27de7ea6b314009abed040cd11249e94ed1a3a10583"
_RULE_BYTES = Path(__file__).with_name("osm-area-polygon-features.json").read_bytes()
if hashlib.sha256(_RULE_BYTES).hexdigest() != RULES_SHA256:
    raise ValueError("OSM area rules checksum mismatch")
try:
    RULES = tuple(json.loads(_RULE_BYTES))
except (ValueError, TypeError) as error:
    raise ValueError("Invalid pinned OSM area rules") from error


def is_area(tags):
    if tags.get("area") == "no":
        return False
    if tags.get("area") == "yes":
        return True
    return any(
        tags.get(rule["key"]) not in (None, "no")
        and (
            rule["polygon"] == "all"
            or (rule["polygon"] == "whitelist" and tags[rule["key"]] in rule["values"])
            or (
                rule["polygon"] == "blacklist"
                and tags[rule["key"]] not in rule["values"]
            )
        )
        for rule in RULES
    )


def is_building(tags):
    return any(
        tags.get(key) not in (None, "no") for key in ("building", "building:part")
    )


def has_area_theme(tags):
    return any(
        rule["key"] != "area" and tags.get(rule["key"]) not in (None, "no")
        for rule in RULES
    )


def semantics(tags):
    # Identity includes permissions and grade, not arbitrary descriptive labels.
    keys = {r["key"] for r in RULES} | {
        "access",
        "foot",
        "highway",
        "layer",
        "level",
        "bridge",
        "tunnel",
    }
    values = {k: v for k, v in tags.items() if k in keys and k != "area"}
    for key in ("building", "building:part"):
        if values.get(key) not in (None, "no"):
            values[key] = "yes"
    values["layer"] = tags.get("layer", "0")
    values["level"] = tags.get("level", "0")
    for key in ("bridge", "tunnel"):
        values[key] = "yes" if tags.get(key) not in (None, "no", "0", "false") else "no"
    return values


@dataclass(frozen=True)
class AreaRecord:
    osm_id: int
    source_kind: str
    raw_tags: Mapping[str, str]
    tags: Mapping[str, str]
    geometry: Any
    member_refs: tuple[tuple[str, int, str], ...] = ()
    qualification: str = "native_footprint"

    @property
    def source_ref(self):
        return f"osm:{self.source_kind}/{self.osm_id}"


@dataclass(frozen=True)
class AreaCollection:
    records: tuple[AreaRecord, ...]
    delegated_outer_ids: frozenset[int]
    statistics: Mapping[str, Any]
    excluded_way_ids: frozenset[int] = frozenset()


def collect_areas(pbf_path, bbox, denied, vehicle_highways=(), *, exclude_invalid=False):
    """Copy metadata, then use libosmium's two-pass multipolygon assembler.

    Validation intentionally precedes bbox filtering: missing geometry has no
    trustworthy spatial bound and therefore cannot be dismissed as outside.
    """

    def required_negative(tags):
        return (
            is_building(tags)
            or denied(tags)
            or tags.get("highway") in vehicle_highways
            or tags.get("area:highway") in vehicle_highways
        )

    ways, relations = {}, {}
    expected, validated = {}, {}
    omissions = []
    omitted_keys = set()

    def omit(key, reason, detail, *, raw=None, version=None):
        if not exclude_invalid:
            raise ValueError(detail)
        if key in omitted_keys:
            return
        kind, identifier = key
        if raw is None:
            entry = (ways if kind == "way" else relations)[identifier]
            raw, version = entry[0], entry[2]
        members = relations[identifier][1] if kind == "relation" else ()
        record = {
            "source_ref": f"osm:{kind}/{identifier}",
            "osm_version": version,
            "raw_tags": dict(raw),
            "member_refs": [list(m) for m in members],
            "reason": reason,
            "detail": detail,
            "decision": _EXCLUSION_POLICY["decision"],
            "spatial_extent": None,
        }
        omitted_keys.add(key)
        expected.pop(key, None)
        validated.pop(key, None)
        omissions.append(record)
        print(
            "WARNING OSM_AREA_OMISSION " + json.dumps(record, sort_keys=True),
            file=sys.stderr,
            flush=True,
        )

    previous_way_id = 0
    unordered_ways = False

    class Metadata(osmium.SimpleHandler):
        def way(self, way):
            nonlocal previous_way_id, unordered_ways
            if way.id <= 0:
                raise ValueError("OSM area input requires positive way IDs")
            unordered_ways |= way.id <= previous_way_id
            previous_way_id = way.id
            tags = dict(way.tags)
            # Retain area-semantic witnesses, not every national highway outline.
            if is_area(tags):
                closed = len(way.nodes) >= 4 and way.is_closed()
                ways[way.id] = (tags, closed, way.version)
                if (
                    exclude_invalid
                    and not closed
                    and required_negative(tags)
                    and (is_building(tags) or tags.get("area") == "yes")
                ):
                    omit(
                        ("way", way.id),
                        "invalid_geometry",
                        f"Unclosed required area way: {way.id}",
                    )

        def relation(self, relation):
            if relation.id <= 0:
                raise ValueError("OSM area input requires positive relation IDs")
            tags = dict(relation.tags)
            members = tuple((m.type, m.ref, m.role) for m in relation.members)
            if (
                not exclude_invalid
                and f"osm:relation/{relation.id}" == _APPROVED_OMISSION["source_ref"]
                and relation.version == _APPROVED_OMISSION["osm_version"]
                and tags == _APPROVED_OMISSION["raw_tags"]
                and members
                == tuple(tuple(m) for m in _APPROVED_OMISSION["member_refs"])
            ):
                omissions.append(deepcopy(_APPROVED_OMISSION))
                print(
                    f"WARNING OSM_AREA_OMISSION {_OMISSION_JSON}",
                    file=sys.stderr,
                    flush=True,
                )
                return
            if tags.get("type") in {"multipolygon", "boundary", "building", "site"}:
                relations[relation.id] = (tags, members, relation.version)

    Metadata().apply_file(str(pbf_path))
    for identifier, (tags, closed, _) in ways.items():
        if closed and required_negative(tags):
            expected[("way", identifier)] = (tags, tags, ())
    building_groups = []
    site_count = 0
    for identifier, (raw, members, _) in relations.items():
        relation_type = raw.get("type")
        if relation_type == "site":
            site_count += 1
            if denied(raw):
                omit(
                    ("relation", identifier),
                    "unqualified_group",
                    f"Denied site has no qualified area boundary: {identifier}",
                )
            continue
        if relation_type == "building":
            building_groups.append((identifier, raw, members))
            continue
        if raw.get("area") == "no":
            continue
        outer_tags = [
            ways[ref][0]
            for kind, ref, role in members
            if kind == "w" and role in ("outer", "") and ref in ways
        ]
        effective = dict(raw)
        if not has_area_theme(effective) and outer_tags:
            signatures = [semantics(tags) for tags in outer_tags]
            if all(s == signatures[0] for s in signatures):
                inherited = dict(outer_tags[0])
                for key in ("building", "building:part"):
                    variants = {tags.get(key) for tags in outer_tags}
                    if (
                        key not in raw
                        and len(variants) > 1
                        and all(v not in (None, "no") for v in variants)
                    ):
                        inherited[key] = "yes"
                effective = {**inherited, **raw}
            elif any(required_negative(t) for t in outer_tags):
                omit(
                    ("relation", identifier),
                    "conflicting_semantics",
                    f"Conflicting multipolygon outer area tags: {identifier}",
                )
                continue
        relevant = is_area(effective) and required_negative(effective)
        if (relation_type == "multipolygon" and denied(effective)) or relevant:
            if any(
                kind != "w" or role not in ("outer", "inner", "")
                for kind, _, role in members
            ):
                omit(
                    ("relation", identifier),
                    "unsupported_members",
                    f"Unsupported required multipolygon member: {identifier}",
                )
                continue
            if not any(role in ("outer", "") for _, _, role in members):
                omit(
                    ("relation", identifier),
                    "missing_outer_geometry",
                    f"Missing required multipolygon outer: {identifier}",
                )
                continue
            expected[("relation", identifier)] = (raw, effective, members)

    verified_groups = []
    for identifier, raw, members in building_groups:
        footprints = [member for member in members if member[2] in {"outline", "part"}]
        if not any(role == "outline" for _, _, role in footprints):
            omit(
                ("relation", identifier),
                "unqualified_group",
                f"Missing building area outline: {identifier}",
            )
            continue
        member_tags = []
        for kind, reference, _ in footprints:
            key = ({"w": "way", "r": "relation"}.get(kind), reference)
            if key not in expected or not is_building(expected[key][1]):
                omit(
                    ("relation", identifier),
                    "unqualified_group",
                    f"Missing or unqualified building area member {key}: {identifier}",
                )
                break
            member_tags.append(expected[key][1])
        if ("relation", identifier) in omitted_keys:
            continue
        if denied(raw) and not all(denied(tags) for tags in member_tags):
            omit(
                ("relation", identifier),
                "unqualified_group",
                f"Unsupported building group denial not represented by members: {identifier}",
            )
            continue
        verified_groups.append((identifier, footprints))
    required_members = {
        ref
        for (kind, _), (_, _, members) in expected.items()
        if kind == "relation"
        for _, ref, _ in members
    }
    member_lines = {}
    factory = WKBFactory()

    class Assembler(osmium.SimpleHandler):
        def way(self, way):
            if way.id in required_members:
                try:
                    coordinates = [(n.lon, n.lat) for n in way.nodes]
                    if len(coordinates) < 2:
                        raise ValueError("Area member has fewer than two nodes")
                    member_lines[way.id] = LineString(coordinates)
                except (RuntimeError, ValueError) as error:
                    omit(
                        ("way", way.id),
                        "invalid_geometry",
                        f"Invalid area member geometry {way.id}: {error}",
                        raw=dict(way.tags),
                        version=way.version,
                    )

        def area(self, area):
            key = ("way" if area.from_way() else "relation", area.orig_id())
            if key not in expected:
                return
            try:
                geometry = from_wkb(bytes.fromhex(factory.create_multipolygon(area)))
            except (RuntimeError, ValueError) as error:
                omit(key, "invalid_geometry", f"Invalid OSM area geometry {key}: {error}")
                return
            if (
                geometry.is_empty
                or not geometry.is_valid
                or geometry.geom_type not in {"Polygon", "MultiPolygon"}
            ):
                omit(key, "invalid_geometry", f"Invalid OSM polygon geometry: {key}")
                return
            validated[key] = geometry

    def assemble(path):
        try:
            Assembler().apply_file(str(path), locations=True)
        except RuntimeError as error:
            raise ValueError(
                f"OSM area input geometry validation failed: {error}"
            ) from error

    if unordered_ways:
        # AreaManager requires increasing way IDs. Preserve collector support
        # for unordered extracts via a task-external temporary sorted copy.
        with TemporaryDirectory(prefix="ped-osm-areas-") as directory:
            sorted_path = str(Path(directory) / "sorted.osm.pbf")
            writer = osmium.SimpleWriter(sorted_path)

            class Copy(osmium.SimpleHandler):
                def node(self, node):
                    writer.add_node(node)

                def way(self, way):
                    writer.add_way(way)

                def relation(self, relation):
                    writer.add_relation(relation)

            reader = osmium.MergeInputReader()
            reader.add_file(str(pbf_path))
            try:
                reader.apply(Copy(), simplify=False)
            finally:
                writer.close()
            assemble(sorted_path)
    else:
        assemble(pbf_path)
    for key in sorted(expected.keys() - validated.keys()):
        omit(key, "missing_geometry", f"Missing required OSM area/member geometry: {key}")
    for (kind, identifier), (_, _, members) in list(expected.items()):
        if kind != "relation":
            continue
        if any(ref not in member_lines for _, ref, _ in members):
            omit(
                (kind, identifier),
                "missing_geometry",
                f"Missing required area member way geometry: {identifier}",
            )
        elif any(
            not validated[(kind, identifier)].boundary.covers(member_lines[ref])
            for _, ref, _ in members
        ):
            omit(
                (kind, identifier),
                "invalid_geometry",
                f"Incomplete area polygon member boundary: {identifier}",
            )
    for identifier, footprints in verified_groups:
        if any(
            ({"w": "way", "r": "relation"}[kind], reference) not in expected
            for kind, reference, _ in footprints
        ):
            omit(
                ("relation", identifier),
                "unqualified_group",
                f"Invalid building group member geometry: {identifier}",
            )
    delegated = set()
    for (kind, _), (_, tags, members) in expected.items():
        if kind != "relation":
            continue
        for member_kind, ref, role in members:
            if (
                member_kind == "w"
                and role in ("outer", "")
                and ("way", ref) in expected
                and all(
                    semantics(tags).get(k) == v
                    for k, v in semantics(expected[("way", ref)][1]).items()
                )
            ):
                delegated.add(ref)
    extent = box(*bbox)
    records = tuple(
        AreaRecord(
            identifier,
            kind,
            MappingProxyType(dict(raw)),
            MappingProxyType(dict(tags)),
            validated[(kind, identifier)],
            members,
        )
        for (kind, identifier), (raw, tags, members) in sorted(expected.items())
        if not (kind == "way" and identifier in delegated)
        and validated[(kind, identifier)].intersects(extent)
    )
    return AreaCollection(
        records,
        frozenset(delegated),
        MappingProxyType(
            {
                "osm_area_policy_version": POLICY_VERSION,
                "osm_area_rules_sha256": RULES_SHA256,
                "osm_area_omission_policy_version": (
                    EXCLUSION_POLICY_VERSION if exclude_invalid else OMISSION_POLICY_VERSION
                ),
                "osm_area_omission_policy_sha256": (
                    EXCLUSION_POLICY_SHA256 if exclude_invalid else OMISSION_POLICY_SHA256
                ),
                "osm_area_exclude_invalid": exclude_invalid,
                "osm_area_omitted_count": len(omissions),
                "osm_area_omissions": omissions,
                "osm_area_has_known_omissions": bool(omissions),
                "osm_area_validated_count": len(validated),
                "osm_area_sorted_input_copy": unordered_ways,
                "osm_area_records_in_extent": len(records),
                "osm_area_delegated_outer_count": len(delegated),
                "osm_area_unsupported_group_count": sum(
                    ("relation", identifier) in omitted_keys
                    for identifier, _, _ in building_groups
                ),
                "osm_area_non_areal_site_group_count": site_count,
                "osm_area_verified_building_group_count": sum(
                    ("relation", identifier) not in omitted_keys
                    for identifier, _ in verified_groups
                ),
            }
        ),
        frozenset(identifier for kind, identifier in omitted_keys if kind == "way"),
    )
