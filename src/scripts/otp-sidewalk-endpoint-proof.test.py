import base64
from copy import deepcopy
import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch
import zlib

import osmium
from shapely import from_wkb, from_wkt
from shapely.geometry import GeometryCollection, LineString, MultiLineString, MultiPoint, MultiPolygon, Point, Polygon, box


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


FIXTURE = load("endpoint_fixture", Path(__file__).with_name("otp-sidewalk-layer.test.py"))
API = FIXTURE.API
BASELINE_DATA = json.loads(
    (Path(__file__).resolve().parents[2] / "tests/fixtures/otp-sidewalk-endpoint-baseline.json").read_text(encoding="utf-8")
)


class EndpointProofTests(FIXTURE.SidewalkLayerTests):
    def baseline(self, scenario):
        expected = deepcopy(BASELINE_DATA["cases"][scenario])
        for source in expected["sources"].values():
            for port in source["ports"]:
                for field in ("coordinate", "source_contact_coordinate"):
                    port[field] = tuple(port[field])
        for closure in expected["node_closures"] or []:
            closure["seeds"] = {int(ident): seed for ident, seed in closure["seeds"].items()}
        return expected, SimpleNamespace(
            nodes={int(ident): tuple(coords) for ident, coords in expected["nodes"].items()},
            node_tags={int(ident): tags for ident, tags in expected["node_tags"].items()},
            ways={int(ident): way for ident, way in expected["ways"].items()},
            relations={
                int(ident): [tuple(member) for member in members]
                for ident, members in expected["relations"].items()
            },
        )

    def snapshot(self, sources):
        return API.NETWORK.SourceSnapshot("7", "a" * 64, tuple(sources), "202606")

    def proof(self, source=None, observations=(), closures=(), plane=None):
        source = source or self.source()
        region = API.Region(source, source.geometry, plane or ("0", "0", "no", "no"), source)
        region.width_observations = observations
        return API.endpoint_proof(region, self.snapshot([source]), closures)

    def mutate(self, value, change):
        _, payload = API.decode_endpoint_proof(value)
        change(payload)
        text = API.canonical_json(payload)
        return API.canonical_json(dict(schema_version=1, region_id=hashlib.sha256(text.encode()).hexdigest(), payload_json=text))

    def test_proof_retains_exact_holes_width_overlay_and_unknown_baseline(self):
        hole = box(121.0018, 25.0003, 121.0022, 25.0007)
        shape = box(121.001, 25, 121.003, 25.001).difference(hole)
        source = self.source(shape, width=None)
        narrow = self.source(box(121.0025, 25, 121.003, 25.001), source_id="narrow", width=0.4)
        envelope, payload = API.decode_endpoint_proof(self.proof(source, ((narrow.geometry, narrow),)))
        self.assertEqual(bytes.fromhex(payload["surface_wkb_hex"]), shape.wkb)
        self.assertFalse(from_wkb(bytes.fromhex(payload["surface_wkb_hex"])).covers(hole.representative_point()))
        self.assertEqual(payload["width_base"], dict(known=False, width_m=None, source_refs=[source.source_id]))
        observation = payload["width_observations"][0]
        self.assertEqual(bytes.fromhex(observation["geometry_wkb_hex"]), narrow.geometry.wkb)
        self.assertEqual(observation["source_refs"], ["narrow"])
        self.assertEqual(observation["width_m"], 0.4)
        self.assertEqual(envelope["region_id"], hashlib.sha256(envelope["payload_json"].encode()).hexdigest())

    def test_mixed_width_overlay_retains_linear_witness_and_baseline_routes(self):
        self.write(nodes=[], ways=[])
        wide = self.source(MultiPolygon([
            box(121.001, 24.99998, 121.002, 25.00002),
            box(121.003, 24.99998, 121.004, 25.00002),
        ]), source_id="wide", width=2)
        narrow = self.source(box(121.0015, 24.99998, 121.003, 25.00002), source_id="narrow", width=.4)
        overlay = wide.geometry.intersection(narrow.geometry)
        boundary = LineString([(121.003, 24.99999), (121.003, 25.00001)])
        self.assertEqual(overlay.geom_type, "GeometryCollection")
        self.assertGreater(overlay.intersection(boundary).length, 0)
        report, result = self.compile([wide, narrow])
        found = False
        for way in self.generated(result).values():
            if way["tags"]["source:ref"] != "wide":
                continue
            _, payload = API.decode_endpoint_proof_tags(way["tags"])
            for observation in payload["width_observations"]:
                raw = bytes.fromhex(observation["geometry_wkb_hex"])
                if raw == overlay.wkb:
                    found = True
                    self.assertEqual(observation["source_refs"], ["narrow"])
                    self.assertEqual(observation["width_m"], .4)
                    self.assertGreater(from_wkb(raw).intersection(boundary).length, 0)
        self.assertTrue(found)
        original_report, original = self.baseline("mixed_width")
        for way in result.ways.values():
            way["tags"] = {key: value for key, value in way["tags"].items() if not key.startswith(API.ENDPOINT_PROOF_TAG)}
        self.assertEqual(result.nodes, original.nodes)
        self.assertEqual(result.node_tags, original.node_tags)
        self.assertEqual(result.ways, original.ways)
        self.assertEqual(result.relations, original.relations)
        self.assertEqual(report["counts"], original_report["counts"])
        self.assertEqual(report["sources"], original_report["sources"])
        self.assertEqual(report["counts"]["generated_ways"], 8)

    def test_generic_width_geometry_is_preserved_but_surface_remains_polygonal(self):
        point = Point(121.0015, 25)
        line = LineString([(121.001, 25), (121.002, 25)])
        polygon = box(121.001, 25, 121.002, 25.001)
        samples = (point, line, polygon, MultiPoint([point, Point(121.002, 25)]),
                   MultiLineString([line]), MultiPolygon([polygon]),
                   GeometryCollection([polygon, line, point]))
        narrow = self.source(source_id="narrow", width=.4)
        for sample in samples:
            with self.subTest(geometry=sample.geom_type):
                value = self.proof(observations=((sample, narrow),))
                _, payload = API.decode_endpoint_proof_tags(API.endpoint_proof_tags(value))
                self.assertEqual(bytes.fromhex(payload["width_observations"][0]["geometry_wkb_hex"]), sample.wkb)
                if sample.geom_type not in {"Polygon", "MultiPolygon"}:
                    def replace_surface(p):
                        p.update(surface_wkb_hex=sample.wkb.hex(), surface_sha256=hashlib.sha256(sample.wkb).hexdigest())
                    with self.assertRaisesRegex(ValueError, "2D polygon"):
                        API.decode_endpoint_proof(self.mutate(value, replace_surface))
        region = API.Region(self.source(), self.source().geometry, ("0", "0", "no", "no"), self.source())
        region.width_observations = ((point, narrow),)
        tags = API.derived_tags(region, self.snapshot([region.surface, narrow]), list(line.coords))
        self.assertEqual(tags["width"], "2.0")
        self.assertNotIn("narrow", tags.get("source:width:refs", ""))

    def test_width_geometry_still_rejects_invalid_dimensions_coordinates_and_hash(self):
        narrow = self.source(source_id="narrow", width=.4)
        for sample in (Point(), Point(181, 25), Point(float("inf"), 25),
                       Point(121, 25, 1), from_wkt("POINT M (121 25 1)"),
                       GeometryCollection([Point(121, 25), Point(121, 25, 1)])):
            with self.subTest(geometry=sample.wkt), self.assertRaises(ValueError):
                self.proof(observations=((sample, narrow),))
        value = self.proof(observations=((LineString([(121.001, 25), (121.002, 25)]), narrow),))
        with self.assertRaisesRegex(ValueError, "hash mismatch"):
            API.decode_endpoint_proof(self.mutate(value, lambda p: p["width_observations"][0].update(geometry_sha256="f" * 64)))

    def test_region_identity_binds_geometry_grade_source_width_and_closure(self):
        value = self.proof()
        original, _ = API.decode_endpoint_proof(value)
        mutations = [
            lambda p: p.update(source_batch="next"),
            lambda p: p.update(source_version="8"),
            lambda p: p.update(source_sha256="b" * 64),
            lambda p: p.update(source_refs=["different"]),
            lambda p: p.update(grade=["1", "0", "yes", "no"]),
            lambda p: p["width_base"].update(width_m=1.5),
            lambda p: p.update(closure_node_ids=[123], eligibility="closure_affected"),
        ]
        for change in mutations:
            envelope, _ = API.decode_endpoint_proof(self.mutate(value, change))
            self.assertNotEqual(envelope["region_id"], original["region_id"])
        changed_shape = self.source(box(121.001, 24.99998, 121.0031, 25.00002))
        changed, _ = API.decode_endpoint_proof(self.proof(changed_shape))
        self.assertNotEqual(changed["region_id"], original["region_id"])
        bad = json.loads(value)
        bad["payload_json"] = bad["payload_json"].replace('"width_m":2.0', '"width_m":1.0')
        with self.assertRaisesRegex(ValueError, "identity mismatch"):
            API.decode_endpoint_proof(API.canonical_json(bad))

    def test_corrupt_schema_hash_crs_geometry_and_nonfinite_width_are_rejected(self):
        value = self.proof()
        for change in (
            lambda p: p.update(crs="EPSG:3857"),
            lambda p: p.update(rule_version="new"),
            lambda p: p.update(surface_sha256="0" * 64),
            lambda p: p.update(extra=True),
            lambda p: p.update(grade_known=False),
            lambda p: p["width_base"].update(known=False),
            lambda p: p["width_base"].update(width_m=-1),
            lambda p: p["width_base"].update(width_m=True),
            lambda p: p.update(eligibility="closure_affected"),
        ):
            with self.subTest(change=change), self.assertRaises(ValueError):
                API.decode_endpoint_proof(self.mutate(value, change))
        for shape in (box(181, 25, 182, 26), Polygon([(121, 25, 1), (122, 25, 1), (122, 26, 1), (121, 26, 1)])):
            with self.assertRaises(ValueError):
                self.proof(self.source(shape))
        for number in (float("nan"), float("inf"), float("-inf")):
            raw = bytearray(self.source().geometry.wkb)
            raw[13:21] = struct.pack("<d", number)
            def broken(p):
                p.update(surface_wkb_hex=raw.hex(), surface_sha256=hashlib.sha256(raw).hexdigest())
            with self.assertRaises(ValueError):
                API.decode_endpoint_proof(self.mutate(value, broken))

    def test_long_value_and_repeated_ways_roundtrip_with_bounded_chunks(self):
        source = self.source(Point(121, 25).buffer(0.001, quad_segs=1024))
        value = self.proof(source)
        tags = API.endpoint_proof_tags(value)
        manifest = json.loads(tags[API.ENDPOINT_PROOF_TAG])
        self.assertGreater(manifest["payload_bytes"], 65535)
        self.assertGreater(manifest["chunk_count"], 10)
        self.assertTrue(all(len(value.encode()) <= 1024 for value in tags.values()))
        writer = osmium.SimpleWriter(str(self.output))
        for ident in range(1, 17001):
            writer.add_way(osmium.osm.mutable.Way(id=ident, nodes=[1, 2], tags=tags))
        writer.close()
        unique = set()
        count = 0
        class Reader(osmium.SimpleHandler):
            def way(_, item):
                nonlocal count
                actual = dict(item.tags)
                self.assertEqual(actual, tags)
                unique.add(actual[API.ENDPOINT_PROOF_TAG])
                count += 1
        Reader().apply_file(str(self.output))
        self.assertEqual((count, len(unique)), (17000, 1))
        actual_manifest, actual_payload = API.decode_endpoint_proof_tags(tags)
        self.assertEqual(actual_manifest, manifest)
        self.assertEqual(bytes.fromhex(actual_payload["surface_wkb_hex"]), source.geometry.wkb)

    def test_chunk_corruption_and_trailing_compressed_data_fail_closed(self):
        tags = API.endpoint_proof_tags(self.proof(self.source(Point(121, 25).buffer(.001, quad_segs=64))))
        chunks = sorted(key for key in tags if key != API.ENDPOINT_PROOF_TAG)
        self.assertGreater(len(chunks), 1)
        variants = []
        missing = dict(tags); missing.pop(chunks[0]); variants.append(missing)
        extra = dict(tags); extra[API.ENDPOINT_PROOF_TAG + ":999999"] = "AAAA"; variants.append(extra)
        broken = dict(tags); broken[chunks[0]] = "!" + broken[chunks[0]][1:]; variants.append(broken)
        short = dict(tags); short[chunks[0]] = short[chunks[0]][:-4]; variants.append(short)
        for key, value in (("payload_bytes", 1), ("compressed_bytes", 1), ("region_id", "f" * 64), ("schema_version", True), ("chunk_count", 0)):
            broken = dict(tags); manifest = json.loads(tags[API.ENDPOINT_PROOF_TAG]); manifest[key] = value
            broken[API.ENDPOINT_PROOF_TAG] = API.canonical_json(manifest); variants.append(broken)
        manifest = json.loads(tags[API.ENDPOINT_PROOF_TAG])
        raw = base64.b64decode("".join(tags[key] for key in chunks)) + b"trailing"
        encoded = base64.b64encode(raw).decode()
        new_chunks = [encoded[i:i + 1000] for i in range(0, len(encoded), 1000)]
        manifest.update(compressed_bytes=len(raw), chunk_count=len(new_chunks))
        variants.append({API.ENDPOINT_PROOF_TAG: API.canonical_json(manifest), **{f"{API.ENDPOINT_PROOF_TAG}:{i:06d}": value for i, value in enumerate(new_chunks)}})
        for broken in variants:
            with self.subTest(broken=broken[API.ENDPOINT_PROOF_TAG]), self.assertRaises(ValueError):
                API.decode_endpoint_proof_tags(broken)

    def test_over_limit_metadata_retains_all_original_routing_geometry(self):
        self.write()
        with patch.object(API, "ENDPOINT_PROOF_MAX_BYTES", 100):
            report, result = self.compile()
            self.assertGreater(report["endpoint_proof"]["unsupported_regions"], 0)
            self.assertIn(4, self.reachable(result, 1))
            for way in self.generated(result).values():
                manifest, payload = API.decode_endpoint_proof_tags(way["tags"])
                self.assertEqual(manifest["status"], "unsupported")
                self.assertIsNone(payload)
                self.assertEqual(manifest["reason"], "payload_limits")

    def test_all_affected_region_ways_disable_endpoint_even_without_closure_tag(self):
        self.write(
            nodes=[(1, 121, 25), (2, 121.001, 25), (3, 121.002, 25, {"barrier": "gate", "foot": "no"}), (4, 121.003, 25), (5, 121.004, 25)],
            ways=[(10, [1, 2, 3, 4, 5], {"highway": "footway"})],
        )
        left = self.source(box(121.001, 24.99998, 121.00200004, 25.00002), source_id="left")
        right = self.source(box(121.00200004, 24.99998, 121.003, 25.00002), source_id="right")
        other = self.source(box(121.001, 25.001, 121.003, 25.00102), source_id="other")
        _, result = self.compile([left, right, other])
        self.assertNotIn(5, self.reachable(result, 1))
        no_closure_tag = False
        for way in self.generated(result).values():
            _, payload = API.decode_endpoint_proof_tags(way["tags"])
            if payload["source_refs"] == ["other"]:
                self.assertEqual(payload["eligibility"], "eligible")
            else:
                self.assertEqual(payload["closure_node_ids"], [3])
                self.assertNotEqual(payload["eligibility"], "eligible")
                no_closure_tag |= "source:closure" not in way["tags"]
                if payload["region_kind"] == "shared_surface_precision_connector":
                    self.assertEqual(payload["eligibility"], "shared_precision_connector")
        self.assertTrue(no_closure_tag)

    def test_unknown_grade_is_explicitly_ineligible(self):
        self.write(nodes=[], ways=[])
        _, result = self.compile([self.source(raw={})])
        for way in self.generated(result).values():
            _, payload = API.decode_endpoint_proof_tags(way["tags"])
            self.assertEqual(payload["eligibility"], "unknown_grade")
            self.assertFalse(payload["grade_known"])

    def test_original_osm_cannot_impersonate_private_derived_proof(self):
        self.write(ways=[(10, [1, 4], {"highway": "footway", **API.endpoint_proof_tags(self.proof())})])
        original = self.pbf.read_bytes()
        with self.assertRaisesRegex(ValueError, "reserved endpoint proof namespace"):
            self.compile()
        self.assertEqual(self.pbf.read_bytes(), original)
        self.assertFalse(self.output.exists())

    def test_closed_node_disables_endpoint_without_existing_cross_gate_ports(self):
        self.write(
            nodes=[(1, 121, 25), (2, 121.001, 25), (3, 121.002, 25, {"barrier": "gate", "foot": "no"})],
            ways=[(10, [1, 2, 3], {"highway": "footway"})],
        )
        report, result = self.compile()
        self.assertFalse(report.get("node_closures"))
        for way in self.generated(result).values():
            self.assertNotIn("source:closure", way["tags"])
            _, payload = API.decode_endpoint_proof_tags(way["tags"])
            self.assertEqual(payload["eligibility"], "closure_affected")
            self.assertEqual(payload["closure_node_ids"], [3])

    def test_closed_nodes_disable_endpoint_without_any_authorized_ports(self):
        self.write(
            nodes=[(3, 121.002, 25, {"barrier": "gate", "foot": "no"}), (4, 121.0021, 25, {"barrier": "gate", "foot": "no"})],
            ways=[(10, [3, 4], {"highway": "footway"})],
        )
        report, result = self.compile()
        self.assertFalse(report.get("node_closures"))
        self.assertEqual(report["counts"]["sources_with_osm_ports"], 0)
        self.assertEqual(report["endpoint_proof"]["observed_closure_affected_regions"], 1)
        self.assertGreater(report["counts"]["generated_ways"], 0)
        for way in self.generated(result).values():
            _, payload = API.decode_endpoint_proof_tags(way["tags"])
            self.assertEqual(payload["eligibility"], "closure_affected")
            self.assertEqual(payload["closure_node_ids"], [3, 4])

    def test_baseline_geometry_ids_original_tags_and_source_accounting_are_identical(self):
        for scenario in ("simple", "width", "hole", "gate", "precision"):
            self.pbf = self.root / (scenario + ".osm.pbf")
            self.output = self.root / (scenario + "-proof.osm.pbf")
            self.report = self.root / (scenario + "-proof.json")
            if scenario == "gate":
                self.write(nodes=[(1, 121, 25), (2, 121.001, 25), (3, 121.002, 25, {"barrier": "gate", "foot": "no"}), (4, 121.003, 25), (5, 121.004, 25)], ways=[(10, [1, 2, 3, 4, 5], {"highway": "footway"})])
            else:
                self.write()
            surfaces = [self.source()]
            if scenario == "width":
                surfaces.append(self.source(box(121.0015, 24.99998, 121.0025, 25.00002), source_id="narrow", width=.4))
            if scenario == "hole":
                surfaces = [self.source(box(121.001, 24.9998, 121.003, 25.0002).difference(box(121.0018, 24.9999, 121.0022, 25.0001)))]
            if scenario == "precision":
                surfaces = [self.source(box(121.001, 24.99998, 121.00200004, 25.00002), source_id="left"), self.source(box(121.00200004, 24.99998, 121.003, 25.00002), source_id="right")]
            report, actual = self.compile(surfaces)
            baseline_report, baseline = self.baseline(scenario)
            self.assertEqual(actual.nodes, baseline.nodes)
            self.assertEqual(actual.node_tags, baseline.node_tags)
            self.assertEqual(actual.relations, baseline.relations)
            for way in actual.ways.values():
                way["tags"] = {key: value for key, value in way["tags"].items() if not key.startswith(API.ENDPOINT_PROOF_TAG)}
            self.assertEqual(actual.ways, baseline.ways)
            self.assertEqual(report["counts"], baseline_report["counts"])
            self.assertEqual(report["sources"], baseline_report["sources"])
            self.assertEqual(report.get("node_closures"), baseline_report.get("node_closures"))


if __name__ == "__main__":
    unittest.main()
