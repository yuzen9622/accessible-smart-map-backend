import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("wheelroute", Path(__file__).with_name("prepare-wheelroute-data.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class WheelrouteTests(unittest.TestCase):
    def test_preserves_uncertain_units_and_does_not_invent_live_status(self):
        row = {"kind": "7", "kname": "出口", "lon": "121.55", "lat": "25.05", "width": 1.5, "slope": -1}
        result = module.normalize(row, 7)
        self.assertEqual(result["geometry"]["type"], "Point")
        self.assertEqual(result["properties"]["width_raw"], 1.5)
        self.assertEqual(result["properties"]["width_unit"], "unresolved")
        self.assertEqual(result["properties"]["operational_status"], "unknown")
        self.assertFalse(result["properties"]["routing_eligible"])
        self.assertEqual(result["id"], module.normalize(dict(reversed(list(row.items()))), 7)["id"])

    def test_rejects_out_of_coverage_and_nonfinite_coordinates(self):
        for lon, lat in [(118.7, 0), (float("nan"), 25), (121.55, float("inf"))]:
            with self.assertRaisesRegex(ValueError, "outside_graph_coverage"):
                module.normalize({"kind": "1", "lon": lon, "lat": lat}, 1)

    def test_requires_a_closed_valid_polygon(self):
        ring = "121.55|25.05|121.551|25.05|121.551|25.051|121.55|25.05|"
        self.assertEqual(module.normalize({"kind": "11", "location": ring}, 11)["geometry"]["type"], "Polygon")
        for bad in ["121.55|25.05|", ring.replace("25.05|", "25.06|", 1)]:
            with self.assertRaises(ValueError):
                module.normalize({"kind": "11", "location": bad}, 11)


if __name__ == "__main__":
    unittest.main()
