"""Lossless node snapshots, insertion order, retention and namespace contracts."""

import dataclasses
import importlib.util
import sys
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    "node_store_test_api", Path(__file__).with_name("build-ped-graph.py")
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Unable to load graph builder")
API = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = API
SPEC.loader.exec_module(API)
STORE = API.load_local_module("node_store_product_tests", "ped-node-store.py")
NETWORK = API.load_local_module("node_store_network_tests", "ped-sidewalk-network.py")


def prototype():
    return API.NodeRecord(
        0, 121.0, 25.0, 1, None, None, None, None, "generated:sidewalk-mesh",
        {"identity": NETWORK._GENERATED_NODE_IDENTITY, "osm_tags": NETWORK._EMPTY_NODE_TAGS},
    )


class CompactNodeStoreTests(unittest.TestCase):
    def test_full_payload_order_overwrite_and_retention(self):
        store = STORE.CompactNodeStore(API.NodeRecord, prototype())
        expected = {}
        for key in (4, 23, 1, 9):
            record = dataclasses.replace(prototype(), osm_node_id=key, lon=121.1234567890123)
            expected[key] = record
            store[key] = record
        custom = API.NodeRecord(
            23, 121.9876543210123, 25.0000000000123, 12, 255, False, True, None,
            "osm:node/23", {"osm_members": {"osm:node/23": {"name": "名稱", "x": None}},
                             "list": [False, 0, None], "tuple": (True, None)},
        )
        expected[23] = custom
        store[23] = custom
        self.assertEqual(list(store.items()), list(expected.items()))
        self.assertIsNone(store.get(2))
        with self.assertRaises(KeyError):
            store[2]
        store.retain_nodes({1, 23, 999})
        self.assertEqual(list(store.items()), [(key, value) for key, value in expected.items() if key in {1, 23}])
        store[23] = dataclasses.replace(prototype(), osm_node_id=23)
        self.assertEqual(store[23], dataclasses.replace(prototype(), osm_node_id=23))

    def test_input_and_output_metadata_are_deeply_isolated(self):
        proto = prototype()
        store = STORE.CompactNodeStore(API.NodeRecord, proto)
        for key in (1, 4):
            store[key] = dataclasses.replace(proto, osm_node_id=key)
        first = store[1]
        first.attr_meta["identity"]["source"] = "changed"
        first.attr_meta["osm_tags"]["kerb"] = "flush"
        self.assertEqual(store[1], dataclasses.replace(proto, osm_node_id=1))
        self.assertEqual(store[4], dataclasses.replace(proto, osm_node_id=4))
        first.attr_meta["osm_members"] = {"osm:node/9": {"tags": [None, False]}}
        store[1] = first
        first.attr_meta["osm_members"]["osm:node/9"]["tags"].append(True)
        read = store[1]
        self.assertEqual(read.attr_meta["osm_members"]["osm:node/9"]["tags"], [None, False])
        read.attr_meta["osm_members"]["osm:node/9"]["tags"].append(0)
        self.assertEqual(store[1].attr_meta["osm_members"]["osm:node/9"]["tags"], [None, False])

    def test_alias_keys_advance_ordinal_and_members_survive_writeback(self):
        store = STORE.CompactNodeStore(API.NodeRecord, prototype())
        keys = {"mesh": 1}
        store[1] = dataclasses.replace(prototype(), osm_node_id=1)
        for alias, tags in (("osm:node/9", {"kerb": "flush"}), ("osm:node/10", {"audible": None})):
            keys[alias] = keys["mesh"]
            node = store[keys[alias]]
            node.attr_meta.setdefault("osm_members", {})[alias] = tags
            store[keys[alias]] = dataclasses.replace(node, tactile_paving=False)
        next_id = len(keys) + 1
        store[next_id] = dataclasses.replace(prototype(), osm_node_id=next_id)
        self.assertEqual(list(store), [1, 4])
        self.assertEqual(store[1].attr_meta["osm_members"], {
            "osm:node/9": {"kerb": "flush"}, "osm:node/10": {"audible": None},
        })
        self.assertIs(store[1].tactile_paving, False)
        self.assertNotIn("osm_members", store[4].attr_meta)

    def test_bool_and_integer_metadata_do_not_collapse(self):
        proto = dataclasses.replace(prototype(), attr_meta={"value": False})
        store = STORE.CompactNodeStore(API.NodeRecord, proto)
        store[1] = dataclasses.replace(proto, osm_node_id=1, attr_meta={"value": 0})
        self.assertIs(type(store[1].attr_meta["value"]), int)

    def test_lazy_namespace_exact_mapping_and_all_guards(self):
        nodes = {key: dataclasses.replace(prototype(), osm_node_id=key) for key in (1, 4, 23)}
        mapping = API.ScopedNodeIdentifiers(7, nodes)
        self.assertEqual(dict(mapping), {key: API.scoped_identifier(7, key, API.NODE_ID_SCALE, "node") for key in nodes})
        self.assertEqual(list(mapping), list(nodes))
        self.assertEqual(len(mapping), 3)
        with self.assertRaises(KeyError):
            mapping[2]
        for key in (-1, API.NODE_ID_SCALE):
            with self.assertRaises(ValueError):
                API.ScopedNodeIdentifiers(7, {key: prototype()})
        with self.assertRaises(ValueError):
            API.ScopedNodeIdentifiers(2**63 // API.NODE_ID_SCALE + 1, nodes)


if __name__ == "__main__":
    unittest.main()
