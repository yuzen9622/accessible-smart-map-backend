#!/usr/bin/env python3
"""Deterministic unit tests for clean-gtfs-feed.py.

Stdlib only (unittest); no network. Fixtures are built in a tmp dir with zipfile.

Covers the 2026-10-02 build abort: TDX listed one AirLine service_id twice in
calendar.txt (a one-day row inside a multi-week row) and OTP refused the whole
feed with MultipleCalendarsForServiceIdException.

    python3 src/scripts/test_clean_gtfs_feed.py
"""
import csv
import io
import os
import subprocess
import sys
import tempfile
import unittest
import zipfile

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "clean-gtfs-feed.py")

FILES = {
    "routes.txt": "route_id,route_type\nR1,3\n",
    "stops.txt": "stop_id,stop_name,stop_lat,stop_lon\nS1,A,25.0,121.0\nS2,B,25.1,121.1\n",
    "trips.txt": "route_id,service_id,trip_id\nR1,SVC_DUP,T1\nR1,SVC_ONE,T2\n",
    "stop_times.txt": (
        "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n"
        "T1,08:00:00,08:00:00,S1,1\nT1,08:10:00,08:10:00,S2,2\n"
        "T2,09:00:00,09:00:00,S1,1\nT2,09:10:00,09:10:00,S2,2\n"
    ),
    "calendar.txt": (
        "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n"
        "SVC_DUP,1,0,0,0,0,0,0,20261005,20261005\n"
        "SVC_DUP,1,0,0,0,0,0,0,20261005,20261026\n"
        "SVC_ONE,1,1,1,1,1,1,1,20261001,20261231\n"
    ),
}


def calendar_rows(path):
    with zipfile.ZipFile(path) as zf, zf.open("calendar.txt") as f:
        return list(csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig")))


class CleanCalendarTest(unittest.TestCase):
    def test_duplicate_service_ids_collapse_to_the_widest_range(self):
        with tempfile.TemporaryDirectory() as tmp:
            feed = os.path.join(tmp, "feed.zip")
            with zipfile.ZipFile(feed, "w") as zf:
                for name, body in FILES.items():
                    zf.writestr(name, body)

            subprocess.run([sys.executable, SCRIPT, feed], cwd=tmp, check=True,
                           capture_output=True, text=True)

            rows = calendar_rows(feed)
            self.assertEqual([r["service_id"] for r in rows], ["SVC_DUP", "SVC_ONE"])
            dup = rows[0]
            self.assertEqual((dup["start_date"], dup["end_date"]), ("20261005", "20261026"))


if __name__ == "__main__":
    unittest.main()
