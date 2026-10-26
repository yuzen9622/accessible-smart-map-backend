import importlib.util
import os
import tempfile
import unittest
import zipfile
from datetime import date


SCRIPT = os.path.join(os.path.dirname(__file__), "audit-gtfs-feed.py")
SPEC = importlib.util.spec_from_file_location("audit_gtfs_feed", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

ROUTES = [
    ("TRA_1", "TRA", "2"),
    ("TXG_30", "TXG_30", "3"),
    ("AirLine_B7_1", "AirLine_B7", "1102"),
    ("PEN_BR1", "PEN_BR1", "4"),
]


def feed(directory, name, trips):
    """Write a minimal GTFS zip with `trips[route_id]` trips per route."""
    path = os.path.join(directory, name)
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr(
            "routes.txt",
            "route_id,agency_id,route_type\n"
            + "".join(f"{rid},{agency},{rtype}\n" for rid, agency, rtype in ROUTES),
        )
        zf.writestr(
            "trips.txt",
            "route_id,service_id,trip_id\n"
            + "".join(
                f"{rid},S,{rid}_{i}\n" for rid, count in trips.items() for i in range(count)
            ),
        )
        zf.writestr("stops.txt", "stop_id,stop_name,stop_lat,stop_lon\nA,A,24.1,120.6\n")
    return MODULE.measure(path, date(2026, 10, 26))


BASE = {"TRA_1": 100, "TXG_30": 100, "AirLine_B7_1": 924, "PEN_BR1": 50}


class AuditTests(unittest.TestCase):
    def test_fewer_flights_and_ferries_do_not_block_a_rebuild(self):
        with tempfile.TemporaryDirectory() as tmp:
            old = feed(tmp, "old.zip", BASE)
            new = feed(tmp, "new.zip", {**BASE, "AirLine_B7_1": 678, "PEN_BR1": 0})
            self.assertEqual(MODULE.compare(new, old, MODULE.DEFAULT_TOLERANCE), [])

    def test_a_rail_drop_still_blocks_a_rebuild(self):
        with tempfile.TemporaryDirectory() as tmp:
            old = feed(tmp, "old.zip", BASE)
            new = feed(tmp, "new.zip", {**BASE, "TRA_1": 50})
            regressions = MODULE.compare(new, old, MODULE.DEFAULT_TOLERANCE)
            self.assertIn("trips [TRA]: 100 -> 50 (-50%)", regressions)

    def test_unserved_trips_are_not_counted(self):
        with tempfile.TemporaryDirectory() as tmp:
            metrics = feed(tmp, "feed.zip", BASE)
            self.assertEqual(metrics["total_trips"], 200)
            self.assertEqual(set(metrics["rail_trips"]), {"TRA"})


if __name__ == "__main__":
    unittest.main()
