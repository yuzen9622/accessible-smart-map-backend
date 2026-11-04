import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("export-otp-sidewalk-index.py")
spec = importlib.util.spec_from_file_location("sidewalk_index_export", SCRIPT)
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)


class SidewalkIndexTests(unittest.TestCase):
    def test_generic_paths_and_generated_connectors_are_not_sidewalk_evidence(self):
        for tags in (
            {"highway": "path"},
            {"highway": "footway", "footway": "crossing"},
            {"highway": "footway", "footway": "sidewalk", "source": "MOI sidewalk"},
            {"highway": "footway", "footway": "sidewalk", "a11y:inferred_connection": "yes"},
        ):
            self.assertFalse(exporter.sidewalk(tags))

    def test_mapped_sidewalks_require_ground_level_public_geometry(self):
        tags = {"highway": "footway", "footway": "sidewalk"}
        self.assertTrue(exporter.sidewalk(tags))
        self.assertTrue(exporter.sidewalk({**tags, "source": "MOI sidewalk", "ref:moi_sidewalk": "A-1"}))
        for extra in ({"foot": "no"}, {"access": "private"}, {"bridge": "yes"}, {"tunnel": "yes"}, {"layer": "1"}, {"indoor": "yes"}):
            self.assertFalse(exporter.sidewalk({**tags, **extra}))

    def test_export_preserves_source_and_keeps_competing_road_evidence(self):
        try:
            import osmium
        except ImportError:
            self.skipTest("pyosmium required for the actual PBF round trip")
        import hashlib
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "tiny.osm.pbf"
            output = Path(folder) / "index.json"
            writer = osmium.SimpleWriter(str(source))
            for node_id, location in enumerate(((121, 25), (121.001, 25), (121, 25.00005), (121.001, 25.00005)), 1):
                writer.add_node(osmium.osm.mutable.Node(id=node_id, location=location))
            writer.add_way(osmium.osm.mutable.Way(id=1, nodes=[1, 2], tags={"highway": "residential"}))
            writer.add_way(osmium.osm.mutable.Way(id=2, nodes=[3, 4], tags={"highway": "footway", "footway": "sidewalk"}))
            writer.close()
            before = source.read_bytes()
            subprocess.run([sys.executable, str(SCRIPT), str(source), str(output)], check=True, capture_output=True)
            result = json.loads(output.read_text())
            self.assertEqual(result["sourcePbfSha256"], hashlib.sha256(before).hexdigest())
            self.assertEqual(source.read_bytes(), before)
            self.assertEqual({segment[0] for segment in result["segments"]}, {"sidewalk", "other"})
            self.assertEqual(result["version"], 2)
            self.assertEqual(result["crossings"], [])

    def test_kerb_ramp_ends_tag_is_parsed_strictly(self):
        self.assertEqual(exporter.kerb_ramp_ends({"tp:kerb_ramp_ends": "1/1/0"}), [1, 1, 0])
        for value in (None, "", "1/1", "a/b/c", "2/1/0"):
            self.assertIsNone(exporter.kerb_ramp_ends({"tp:kerb_ramp_ends": value}))

    def test_classified_crossings_are_exported_once_per_way(self):
        try:
            import osmium
        except ImportError:
            self.skipTest("pyosmium required for the actual PBF round trip")
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "tiny.osm.pbf"
            output = Path(folder) / "index.json"
            writer = osmium.SimpleWriter(str(source))
            for node_id, location in enumerate(((121, 25), (121, 25.0002), (121.001, 25), (121.001, 25.0002), (121.0005, 25.0001)), 1):
                writer.add_node(osmium.osm.mutable.Node(id=node_id, location=location))
            writer.add_way(osmium.osm.mutable.Way(id=7, nodes=[1, 5, 2], tags={"highway": "footway", "footway": "crossing", "tp:kerb_ramp_ends": "1/1/0"}))
            writer.add_way(osmium.osm.mutable.Way(id=8, nodes=[3, 4], tags={"highway": "footway", "footway": "crossing"}))
            writer.close()
            subprocess.run([sys.executable, str(SCRIPT), str(source), str(output)], check=True, capture_output=True)
            crossings = json.loads(output.read_text())["crossings"]
            self.assertEqual(len(crossings), 1)
            self.assertEqual(crossings[0][:4], [7, 1, 1, 0])
            self.assertEqual(len(crossings[0][4]), 3)


if __name__ == "__main__":
    unittest.main()
