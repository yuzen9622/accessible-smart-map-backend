"""Lossless staging, directed topology, and stage ownership regression checks."""

import copy
import dataclasses
import importlib.util
import io
import json
import pickle
import sqlite3
import sys
import tempfile
import types
import unittest
import zlib
from contextlib import redirect_stderr
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).with_name("build-ped-graph.py")
SPEC = importlib.util.spec_from_file_location("edge_store_test_api", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load {SCRIPT}")
API = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = API
SPEC.loader.exec_module(API)
STORE = API.load_local_module("edge_store_product_tests", "ped-edge-store.py")
NETWORK = API.load_local_module("edge_store_network_tests", "ped-sidewalk-network.py")


def edge(start=1, end=2, meta=None):
    return API.EdgeRecord(
        start,
        end,
        ((121.5, 25.0), (121.501, 25.0)),
        100.0,
        1,
        0.0,
        None,
        0,
        0.0,
        None,
        0,
        None,
        False,
        True,
        "gov_sidewalk:1:source:cell/1",
        meta or {},
    )


def node(identifier, index=0):
    return API.NodeRecord(
        identifier,
        121.5 + index * 0.0005,
        25.0,
        1,
        None,
        None,
        None,
        None,
        str(identifier),
        {},
    )


class DiskEdgeStoreTests(unittest.TestCase):
    def test_compressed_bytes_hash_original_metadata_and_roundtrip(self):
        record = edge(
            meta={"payload": "evidence" * 4096, "grade": ("0", None, "no", "no")}
        )
        store = STORE.DiskEdgeStore(API.EdgeRecord, batch_size=1)
        try:
            store.append(record)
            key, metadata = store._connection.execute(
                "SELECT key,payload FROM metadata"
            ).fetchone()
            original = pickle.dumps(record.attr_meta, protocol=5)
            self.assertEqual(key, STORE.hashlib.sha256(original).digest())
            self.assertEqual(zlib.decompress(metadata), original)
            self.assertLess(len(metadata), len(original) // 10)
            payload = store._connection.execute("SELECT payload FROM edges").fetchone()[
                0
            ]
            self.assertEqual(
                STORE._decode(zlib.decompress(payload)),
                tuple(getattr(record, name) for name in store._fields),
            )
            self.assertEqual(list(store), [record])
        finally:
            store.close()

    def test_collision_uses_original_bytes_even_if_compressed_encoding_differs(self):
        record = edge(meta={"payload": "x" * 4096})
        store = STORE.DiskEdgeStore(API.EdgeRecord, batch_size=1)
        try:
            store.append(record)
            key = STORE.hashlib.sha256(
                pickle.dumps(record.attr_meta, protocol=5)
            ).digest()
            # Equal bytes with a different compression level are not a collision.
            store._connection.execute(
                "UPDATE metadata SET payload=? WHERE key=?",
                (zlib.compress(pickle.dumps(record.attr_meta, protocol=5), 0), key),
            )
            store.append(record)
            self.assertEqual(list(store), [record, record])
            store._connection.execute(
                "UPDATE metadata SET payload=? WHERE key=?",
                (zlib.compress(pickle.dumps({"different": True}, protocol=5)), key),
            )
            with self.assertRaisesRegex(ValueError, "hash collision"):
                store.append(record)
        finally:
            store.close()
        self.assertFalse(Path(store.path).exists())

    def test_corrupt_compressed_replay_and_globals_remain_fatal_and_cleanup(self):
        for column, payload in (
            ("metadata", b"corrupt"),
            ("edges", b"corrupt"),
            ("metadata", zlib.compress(pickle.dumps(Path("unsafe")))),
        ):
            with (
                self.subTest(column=column),
                tempfile.TemporaryDirectory() as directory,
            ):
                sentinel = Path(directory) / "untouched"
                sentinel.write_text("preserve")
                store = STORE.DiskEdgeStore(API.EdgeRecord, batch_size=1)
                try:
                    store.append(edge())
                    if column == "metadata":
                        store._connection.execute(
                            "UPDATE metadata SET payload=?", (payload,)
                        )
                    else:
                        store._connection.execute(
                            "UPDATE edges SET payload=?", (payload,)
                        )
                    with self.assertRaises((zlib.error, ValueError)):
                        list(store)
                finally:
                    store.close()
                self.assertFalse(Path(store.path).exists())
                self.assertEqual(sentinel.read_text(), "preserve")
        with self.assertRaisesRegex(ValueError, "cannot load globals"):
            STORE._decode(pickle.dumps(Path("unsafe")))

    def test_cli_staging_is_explicit_and_requires_a_qualified_source(self):
        args = ["--pbf", str(SCRIPT), "--bbox", "taiwan", "--db-url", "owned-test"]
        self.assertFalse(API.parse_args(args).disk_stage_edges)
        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as raised:
            API.parse_args([*args, "--disk-stage-edges"])
        self.assertEqual(raised.exception.code, 2)
        qualified = API.parse_args(
            [*args, "--sidewalk-source-version", "1", "--disk-stage-edges"]
        )
        self.assertTrue(qualified.disk_stage_edges)

    def test_close_with_partial_replay_cleans_the_private_stage(self):
        store = STORE.DiskEdgeStore(API.EdgeRecord)
        store.extend([edge(), edge()])
        replay = iter(store)
        self.assertEqual(next(replay), edge())
        store.close()
        replay.close()
        self.assertFalse(Path(store.path).exists())

    def test_ordered_partial_flush_replay_and_primitive_shape(self):
        store = STORE.DiskEdgeStore(API.EdgeRecord, batch_size=2)
        try:
            records = [
                dataclasses.replace(
                    edge(),
                    length_m=index,
                    attr_meta={
                        "grade": ("0", "0", "no", "no"),
                        "source_properties": {
                            "zero": 0,
                            "unknown": None,
                            "flags": [False, True],
                        },
                    },
                )
                for index in range(7)
            ]
            store.extend(records)
            self.assertEqual(len(store), 7)
            self.assertEqual(list(store), records)
            replay = iter(store)
            self.assertEqual(next(replay), records[0])
            replay.close()
            self.assertEqual(list(store), records)
            self.assertEqual(list(store.iter_endpoints()), [(1, 2)] * 7)
            decoded = next(iter(store))
            decoded.attr_meta["source_properties"]["zero"] = 5
            self.assertEqual(next(iter(store)), records[0])
        finally:
            store.close()
        self.assertFalse(Path(store.path).exists())
        store.close()
        with self.assertRaisesRegex(ValueError, "closed"):
            list(store)

    def test_metadata_deduplication_and_append_snapshot(self):
        store = STORE.DiskEdgeStore(API.EdgeRecord, batch_size=3)
        try:
            record = edge(meta={"source_properties": {"payload": "x" * 4096}})
            for index in range(200):
                store.append(dataclasses.replace(record, from_osm_node=index))
            record.attr_meta["source_properties"]["payload"] = "changed"
            store.flush()
            with sqlite3.connect(store.path) as connection:
                self.assertEqual(
                    connection.execute("SELECT count(*) FROM metadata").fetchone()[0], 1
                )
                self.assertEqual(
                    connection.execute("SELECT count(*) FROM edges").fetchone()[0], 200
                )
            self.assertEqual(
                next(iter(store)).attr_meta["source_properties"]["payload"], "x" * 4096
            )
        finally:
            store.close()

    def test_serialization_and_disk_errors_are_fatal(self):
        store = STORE.DiskEdgeStore(API.EdgeRecord)
        try:
            with self.assertRaises(pickle.PicklingError):
                store.append(edge(meta={"invalid": lambda: None}))
            self.assertEqual(len(store), 0)
            store._connection.execute("DROP TABLE edges")
            store.append(edge())
            with self.assertRaises(sqlite3.OperationalError):
                store.flush()
        finally:
            store.close()
        self.assertFalse(Path(store.path).exists())

    def test_qualified_build_exception_removes_owned_stage_only(self):
        owned = []

        def fail(api, pbf, bbox, snapshot, dem, exclude, edges):
            owned.append(Path(edges.path))
            edges.append(edge())
            raise RuntimeError("software failure")

        with tempfile.TemporaryDirectory() as directory:
            sentinel = Path(directory) / "unrelated"
            sentinel.write_text("preserve")
            with (
                patch.object(NETWORK, "_build_network", side_effect=fail),
                self.assertRaisesRegex(RuntimeError, "software failure"),
            ):
                NETWORK.build_network(API, None, None, None, stage_edges=True)
            self.assertEqual(sentinel.read_text(), "preserve")
            self.assertFalse(owned[0].exists())

    def test_main_closes_stage_after_reporting_or_persistence_failure(self):
        for fail_at in ("connectivity_sample", "write_graph_to_postgis", None):
            with self.subTest(fail_at=fail_at):
                store = STORE.DiskEdgeStore(API.EdgeRecord)
                store.append(edge())
                graph = API.GraphBuild({1: node(1), 2: node(2)}, store, 1, 0, 1)
                args = types.SimpleNamespace(
                    bbox="taiwan",
                    pbf=SCRIPT,
                    dem_file=None,
                    sidewalk_geojson=None,
                    sidewalk_source_version=None,
                    exclude_invalid_osm_areas=False,
                    disk_stage_edges=False,
                    db_url="owned-test",
                )
                with (
                    patch.object(API, "parse_args", return_value=args),
                    patch.object(API, "build_graph", return_value=graph),
                    patch.object(
                        API, "connectivity_sample", return_value={"sampled": 100}
                    ),
                    patch.object(API, "write_graph_to_postgis", return_value=1),
                    patch.object(API, "print_report"),
                ):
                    if fail_at:
                        with (
                            patch.object(
                                API, fail_at, side_effect=RuntimeError("failure")
                            ),
                            self.assertRaisesRegex(RuntimeError, "failure"),
                        ):
                            API.main([])
                    else:
                        self.assertEqual(API.main([]), 0)
                self.assertFalse(Path(store.path).exists())


class CompactTopologyTests(unittest.TestCase):
    def test_shared_generated_metadata_is_immutable_and_json_compatible(self):
        metadata = NETWORK._GENERATED_NODE_IDENTITY
        self.assertEqual(
            json.loads(json.dumps(metadata)),
            {
                "source": "generated:sidewalk-mesh",
                "namespace": "policy-local-ordinal",
            },
        )
        self.assertIs(copy.deepcopy(metadata), metadata)
        with self.assertRaises(TypeError):
            metadata["source"] = "changed"
        with self.assertRaises(TypeError):
            metadata.update(source="changed")
        with self.assertRaises(TypeError):
            NETWORK._EMPTY_NODE_TAGS.setdefault("access", "no")
        self.assertEqual(NETWORK._EMPTY_NODE_TAGS, {})

    def test_seeded_hundred_pair_sample_matches_pre_staging_directed_oracle(self):
        base = 10_000_000_000
        nodes = {base + index: node(base + index, index) for index in range(32)}
        records = [
            edge(base + index, base + index + 1) for index in range(31) if index != 15
        ]
        expected = {
            "requested": 100,
            "sampled": 100,
            "reachable": 12,
            "unreachable": 88,
            "rate_pct": 12.0,
            "distance_min_m": 302.33,
            "distance_max_m": 1562.041,
            "seed": 20260820,
        }
        store = STORE.DiskEdgeStore(API.EdgeRecord)
        try:
            store.extend(records)
            self.assertEqual(API.connectivity_sample(nodes, records), expected)
            self.assertEqual(API.connectivity_sample(nodes, store), expected)
        finally:
            store.close()

    def test_directed_paths_and_weak_components_for_dense_and_legacy_ids(self):
        for ids in (
            (1, 2, 3, 4, 5),
            (9454749084, 9454749999, 9454755000, 9999999999, 10000000000),
        ):
            nodes = {identifier: node(identifier) for identifier in ids}
            records = [edge(ids[0], ids[1]), edge(ids[1], ids[2]), edge(ids[3], ids[2])]
            store = STORE.DiskEdgeStore(API.EdgeRecord)
            try:
                store.extend(records)
                for edges in (records, store):
                    compact = API.CompactDirectedGraph(nodes, edges)
                    adjacency = {ids[0]: [ids[1]], ids[1]: [ids[2]], ids[3]: [ids[2]]}
                    for start in ids:
                        for target in ids:
                            self.assertEqual(
                                compact.is_reachable(start, target),
                                API.is_reachable(adjacency, start, target),
                            )
                    graph = API.GraphBuild(nodes, edges, 3, 0, 0)
                    self.assertEqual(
                        NETWORK.component_statistics(graph),
                        {
                            "weak_component_count": 2,
                            "largest_component_nodes": 4,
                            "surface_cell_count": 0,
                            "source_member_count": 0,
                        },
                    )
            finally:
                store.close()

    def test_streamed_report_preserves_zero_known_and_null_unknown(self):
        store = STORE.DiskEdgeStore(API.EdgeRecord)
        try:
            records = [
                edge(),
                dataclasses.replace(
                    edge(),
                    edge_type=6,
                    width_m=None,
                    slope_longitudinal=None,
                    wheelchair=None,
                    smoothness=None,
                ),
            ]
            store.extend(records)
            graph = API.GraphBuild({1: node(1), 2: node(2)}, store, 1, 0, 1)
            report = API.graph_report(graph, {})
            self.assertEqual(
                report["coverage_pct"],
                {
                    "slope_longitudinal": 50.0,
                    "surface": 0.0,
                    "smoothness": 50.0,
                    "width_m": 50.0,
                    "effective_width_m": 0.0,
                    "wheelchair": 50.0,
                },
            )
            self.assertEqual(report["edge_type_distribution"], {1: 1, 6: 1})
            self.assertEqual(json.loads(json.dumps(report))["directed_edge_count"], 2)
        finally:
            store.close()


if __name__ == "__main__":
    unittest.main()
