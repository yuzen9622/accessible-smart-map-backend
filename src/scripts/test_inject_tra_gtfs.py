#!/usr/bin/env python3
"""Deterministic unit tests for inject-tra-gtfs.py's native/inject modes.

Stdlib only (unittest); no network. Fixtures are built in a tmp dir with zipfile.

Covers the 2026-10-02 finding: the TDX national feed now ships a dated TRA
timetable (one trip per train per date, with shapes), and the old
"idempotency strip" deleted every TRA_ row — replacing ~59 days of dated
service with a 45-day weekly pattern that cannot express holidays.

    python3 src/scripts/test_inject_tra_gtfs.py
"""
import csv
import io
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
import zipfile
from datetime import datetime, timedelta, timezone

from tra_shape_geometry import Shape, load_tra_geometry, find_misaligned_patterns

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "inject-tra-gtfs.py")
TAIPEI = timezone(timedelta(hours=8))


def ymd(days: int) -> str:
    return (datetime.now(TAIPEI) + timedelta(days=days)).strftime("%Y%m%d")


TIMETABLE = {
    "EffectiveDate": datetime.now(TAIPEI).strftime("%Y-%m-%d"),
    "TrainTimetables": [{
        "TrainInfo": {"TrainNo": "431", "Direction": 1, "TrainTypeID": "110G",
                      "TrainTypeCode": "1", "TrainTypeName": {"Zh_tw": "自強(3000)"},
                      "WheelChairFlag": 1},
        "ServiceDay": {d: 1 for d in ("Monday", "Tuesday", "Wednesday", "Thursday",
                                      "Friday", "Saturday", "Sunday")},
        "StopTimes": [
            {"StopSequence": 1, "StationID": "1000", "ArrivalTime": "08:00", "DepartureTime": "08:00"},
            {"StopSequence": 2, "StationID": "1100", "ArrivalTime": "08:40", "DepartureTime": "08:41"},
        ],
    }],
}


def build_feed(path: str, native_days: int, with_stale_injection: bool) -> None:
    trips = "route_id,service_id,trip_id,shape_id\n"
    routes = "route_id,agency_id,route_short_name,route_long_name,route_type\n"
    cal_dates = "service_id,date,exception_type\n"
    stop_times = "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n"
    shapes = "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\nTRA_4340_1040_1,25.0478,121.5170,1\nTRA_4340_1040_1,24.8017,120.9716,2\n"
    if native_days:
        routes += "TRA_431_1_110G,TRA,臺北-新竹,臺北-新竹,2\n"
        for d in range(native_days):
            date = ymd(d)
            sid = f"TRA_431_1_110G_{date}"
            tid = f"{sid}_080000"
            trips += f"TRA_431_1_110G,{sid},{tid},TRA_4340_1040_1\n"
            cal_dates += f"{sid},{date},1\n"
            stop_times += f"{tid},08:00:00,08:00:00,TRA_1000,1\n{tid},08:40:00,08:41:00,TRA_1100,2\n"
    calendar = "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n"
    if with_stale_injection:
        routes += "TRA_1,TRA,自強,自強,2\n"
        trips += "TRA_1,TRA_SVC_1111111,TRA_431,TRA_SHP_1\n"
        calendar += f"TRA_SVC_1111111,1,1,1,1,1,1,1,{ymd(-60)},{ymd(-15)}\n"
        stop_times += "TRA_431,08:00:00,08:00:00,TRA_1000,1\nTRA_431,08:40:00,08:41:00,TRA_1100,2\n"
        shapes += "TRA_SHP_1,25.0,121.5,1\nTRA_SHP_1,25.1,121.4,2\n"
    files = {
        "routes.txt": routes, "trips.txt": trips, "calendar.txt": calendar,
        "calendar_dates.txt": cal_dates, "stop_times.txt": stop_times, "shapes.txt": shapes,
        "stops.txt": "stop_id,stop_name,stop_lat,stop_lon\nTRA_1000,臺北,25.0478,121.5170\nTRA_1100,新竹,24.8017,120.9716\n",
    }
    with zipfile.ZipFile(path, "w") as zf:
        for name, body in files.items():
            zf.writestr(name, body)


def table(path: str, name: str):
    with zipfile.ZipFile(path) as zf, zf.open(name) as f:
        return list(csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig")))


class InjectTraTest(unittest.TestCase):
    def run_script(self, native_days: int, stale: bool):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        tmp = temp.name
        feed = os.path.join(tmp, "feed.zip")
        timetable = os.path.join(tmp, "tt.json")
        build_feed(feed, native_days, stale)
        with open(timetable, "w", encoding="utf-8") as f:
            json.dump(TIMETABLE, f, ensure_ascii=False)
        out = subprocess.run([sys.executable, SCRIPT, feed, timetable], cwd=tmp,
                             check=True, capture_output=True, text=True).stdout
        return feed, out

    def test_keeps_a_native_timetable_and_enriches_it(self):
        feed, out = self.run_script(native_days=30, stale=True)

        self.assertIn("native TRA timetable kept", out)
        trips = table(feed, "trips.txt")
        self.assertEqual(len(trips), 30)
        self.assertTrue(all(t["trip_id"].startswith("TRA_431_1_110G_") for t in trips))
        self.assertTrue(all(t["wheelchair_accessible"] == "1" for t in trips))
        routes = table(feed, "routes.txt")
        self.assertEqual([(r["route_id"], r["route_long_name"]) for r in routes],
                         [("TRA_431_1_110G", "自強(3000)")])
        self.assertEqual(len(table(feed, "calendar_dates.txt")), 30)
        self.assertEqual(table(feed, "calendar.txt"), [])
        self.assertFalse(any(r["trip_id"] == "TRA_431" for r in table(feed, "stop_times.txt")))
        self.assertEqual({r["shape_id"] for r in table(feed, "shapes.txt")}, {"TRA_4340_1040_1"})

    def test_falls_back_to_injection_when_native_service_is_too_short(self):
        feed, out = self.run_script(native_days=5, stale=False)

        self.assertNotIn("native TRA timetable kept", out)
        trips = table(feed, "trips.txt")
        self.assertEqual([t["trip_id"] for t in trips], ["TRA_431"])
        self.assertTrue(table(feed, "calendar.txt")[0]["service_id"].startswith("TRA_SVC_"))


class NativeShapeRepairTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.feed = os.path.join(self.temp.name, "feed.zip")
        self.tt = os.path.join(self.temp.name, "tt.json")
        self.rail = os.path.join(self.temp.name, "rail.json")
        with open(self.tt, "w") as f:
            json.dump(TIMETABLE, f)
        with open(self.rail, "w") as f:
            json.dump({"Shapes": [{"Geometry": "LINESTRING (121 24, 121.05 24.05, 121.1 24.1, 121.15 24.05, 121.2 24)"}]}, f)
        self.files = {
            "routes.txt": "route_id,agency_id,route_short_name,route_long_name,route_type\nTRA_431_1_110G,TRA,TRA,TRA,2\nBUS,BUS,Bus,Bus,3\n",
            "trips.txt": "route_id,service_id,trip_id,shape_id\nTRA_431_1_110G,native,TRA_bad1,coast\nTRA_431_1_110G,native,TRA_bad2,coast\nTRA_431_1_110G,native,TRA_good,coast\nTRA_431_1_110G,native,TRA_reverse,coast\nBUS,bus,BUS_1,bus_shape\n",
            "calendar.txt": "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n",
            "calendar_dates.txt": f"service_id,date,exception_type\nnative,{ymd(30)},1\n",
            "stops.txt": "stop_id,stop_lat,stop_lon\nTRA_A,24,121\nTRA_M,24.1,121.1\nTRA_C,23.9,121.1\nTRA_B,24,121.2\nBUS_A,25,121\nBUS_B,25.1,121\n",
            # Extra columns and non-metre distances must survive on unchanged rows.
            "shapes.txt": "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence,shape_dist_traveled\ncoast,24,121,1,0\ncoast,23.9,121.1,2,15\ncoast,24,121.2,3,30\nbus_shape,25,121,1,0\nbus_shape,25.1,121,2,11\n",
            "stop_times.txt": "trip_id,arrival_time,departure_time,stop_id,stop_sequence,shape_dist_traveled,pickup_type\n",
        }
        for tid, seq in [("TRA_bad1", "AMB"), ("TRA_bad2", "AMB"), ("TRA_good", "ACB"), ("TRA_reverse", "BMA")]:
            # Deliberately non-row order: numeric stop_sequence decides travel order.
            for index in (2, 0, 1):
                self.files["stop_times.txt"] += f"{tid},08:00:00,08:00:00,TRA_{seq[index]},{index + 1},{index * 15},0\n"
        self.files["stop_times.txt"] += "BUS_1,09:00:00,09:00:00,BUS_A,1,0,0\nBUS_1,10:00:00,10:00:00,BUS_B,2,11,0\n"

    def write_feed(self):
        with zipfile.ZipFile(self.feed, "w") as zf:
            for name, body in self.files.items():
                zf.writestr(name, body)

    def run_script(self, shape=True):
        return subprocess.run([sys.executable, SCRIPT, self.feed, self.tt] + ([self.rail] if shape else []),
                              cwd=self.temp.name, capture_output=True, text=True)

    def test_repairs_branches_preserves_timetable_and_is_idempotent(self):
        self.write_feed()
        before_stops = table(self.feed, "stop_times.txt")
        before_shapes = table(self.feed, "shapes.txt")
        with zipfile.ZipFile(self.feed) as zf:
            self.assertEqual(len(find_misaligned_patterns(*load_tra_geometry(zf))), 2)
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        trips = {t["trip_id"]: t for t in table(self.feed, "trips.txt")}
        forward_id = trips["TRA_bad1"]["shape_id"]
        self.assertTrue(forward_id.startswith("TRA_REPAIRED_"))
        self.assertEqual(trips["TRA_bad2"]["shape_id"], forward_id)
        self.assertNotEqual(trips["TRA_reverse"]["shape_id"], forward_id)
        self.assertEqual(trips["TRA_good"]["shape_id"], "coast")
        self.assertEqual(trips["BUS_1"]["shape_id"], "bus_shape")
        for before, after in zip(before_stops, table(self.feed, "stop_times.txt")):
            if before["trip_id"] in ("TRA_bad1", "TRA_bad2", "TRA_reverse"):
                before["shape_dist_traveled"] = ""
            self.assertEqual(before, after)
        after_shapes = table(self.feed, "shapes.txt")
        self.assertEqual([r for r in after_shapes if r["shape_id"] in ("coast", "bus_shape")], before_shapes)
        points = [r for r in after_shapes if r["shape_id"] == forward_id]
        self.assertGreater(len(points), 3)
        self.assertTrue(all(float(r["shape_pt_lat"]) >= 24 for r in points))
        with zipfile.ZipFile(self.feed) as zf:
            self.assertEqual(find_misaligned_patterns(*load_tra_geometry(zf)), [])
            first_pass = {n: zf.read(n) for n in zf.namelist()}
        result = self.run_script(shape=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        with zipfile.ZipFile(self.feed) as zf:
            self.assertEqual(first_pass, {n: zf.read(n) for n in zf.namelist()})

    def test_missing_shape_file_is_repaired(self):
        del self.files["shapes.txt"]
        # All remaining TRA trips use the available mountain line.
        self.files["stop_times.txt"] = self.files["stop_times.txt"].replace("TRA_C", "TRA_M")
        self.write_feed()
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        with zipfile.ZipFile(self.feed) as zf:
            self.assertEqual(find_misaligned_patterns(*load_tra_geometry(zf)), [])

    def test_connects_track_lines_via_a_shared_non_stopping_station(self):
        self.files["stops.txt"] += "TRA_J,24.05,121.05\n"
        with open(self.rail, "w") as f:
            json.dump({"Shapes": [
                {"Geometry": "LINESTRING (121 24, 121.025 24.03, 121.05 24.05)"},
                {"Geometry": "LINESTRING (121.05 24.05, 121.075 24.08, 121.1 24.1, 121.15 24.05, 121.2 24)"},
            ]}, f)
        self.write_feed()
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        with zipfile.ZipFile(self.feed) as zf:
            self.assertEqual(find_misaligned_patterns(*load_tra_geometry(zf)), [])
        shapes = table(self.feed, "shapes.txt")
        repaired = [r for r in shapes if r["shape_id"].startswith("TRA_REPAIRED_")]
        self.assertTrue(any(float(r["shape_pt_lon"]) == 121.025 for r in repaired))
        self.assertTrue(any(float(r["shape_pt_lon"]) == 121.075 for r in repaired))
        self.assertFalse(any(r["stop_id"] == "TRA_J" for r in table(self.feed, "stop_times.txt")))

    def test_disconnected_multilinestring_must_not_create_a_straight_bridge(self):
        with open(self.rail, "w") as f:
            json.dump({"Shapes": [{"Geometry": "MULTILINESTRING ((121 24, 121.01 24.01), (121.09 24.09, 121.1 24.1, 121.2 24))"}]}, f)
        self.write_feed()
        result = self.run_script()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("no track geometry", result.stderr)

    def test_connects_multiline_parts_at_a_track_junction_between_stations(self):
        with open(self.rail, "w") as f:
            json.dump({"Shapes": [{"Geometry": "MULTILINESTRING ((121 24, 121.025 24.03, 121.05 24.05), (121.05 24.05, 121.075 24.08, 121.1 24.1, 121.15 24.05, 121.2 24))"}]}, f)
        self.write_feed()
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        with zipfile.ZipFile(self.feed) as zf:
            self.assertEqual(find_misaligned_patterns(*load_tra_geometry(zf)), [])

    def test_failed_write_preserves_input_and_removes_temporary_zip(self):
        spec = importlib.util.spec_from_file_location("inject_tra", SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.write_feed()
        with open(self.feed, "rb") as f:
            original = f.read()
        with self.assertRaises(OSError):
            with module.native_feed_output(self.feed) as temp_path:
                with open(temp_path, "wb") as f:
                    f.write(b"partial zip")
                raise OSError("disk full")
        self.assertFalse(os.path.exists(temp_path))
        with open(self.feed, "rb") as f:
            self.assertEqual(f.read(), original)

    def test_unrepairable_input_fails_without_replacing_zip(self):
        for issue in ("missing_source", "unsupported_hop", "missing_stop"):
            with self.subTest(issue=issue):
                if issue == "unsupported_hop":
                    with open(self.rail, "w") as f:
                        json.dump({"Shapes": [{"Geometry": "LINESTRING (122 25, 123 26)"}]}, f)
                if issue == "missing_stop":
                    self.files["stops.txt"] = self.files["stops.txt"].replace("TRA_M,24.1,121.1\n", "")
                self.write_feed()
                with open(self.feed, "rb") as f:
                    before = f.read()
                result = self.run_script(shape=issue != "missing_source")
                self.assertNotEqual(result.returncode, 0)
                with open(self.feed, "rb") as f:
                    self.assertEqual(f.read(), before)

    def test_alignment_uses_segments_and_500_metre_boundary(self):
        shape = Shape([(121, 24), (122, 24)])
        patterns = {("line", ("a", "b")): ["TRA_test"]}
        from tra_shape_geometry import MY
        for metres, expected in [(499, False), (501, True)]:
            coord = {"a": (121, 24), "b": (121.5, 24 + metres / MY)}
            self.assertEqual(bool(find_misaligned_patterns(coord, patterns, {"line": shape})), expected)


if __name__ == "__main__":
    unittest.main()
