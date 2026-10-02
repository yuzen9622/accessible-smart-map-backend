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
import json
import os
import subprocess
import sys
import tempfile
import unittest
import zipfile
from datetime import datetime, timedelta, timezone

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
    shapes = "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\nTRA_4340_1040_1,25.0,121.5,1\nTRA_4340_1040_1,25.1,121.4,2\n"
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
        tmp = tempfile.mkdtemp()
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


if __name__ == "__main__":
    unittest.main()
