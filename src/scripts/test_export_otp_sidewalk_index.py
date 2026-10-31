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


if __name__ == "__main__":
    unittest.main()
