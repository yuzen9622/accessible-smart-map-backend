#!/usr/bin/env python3
"""Unit tests for merge-gtfs-duplicate-stops.py. Stdlib only, no network.

    python3 src/scripts/test_merge_gtfs_duplicate_stops.py
"""
import csv
import importlib.util
import io
import json
import os
import tempfile
import unittest
import zipfile

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "merge-gtfs-duplicate-stops.py")
spec = importlib.util.spec_from_file_location("merge_stops", SCRIPT)
merge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(merge)


def csv_text(fields, rows):
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=fields, lineterminator="\n")
    w.writeheader()
    w.writerows(rows)
    return buf.getvalue()


def stop(sid, lat="25.0400000", lon="121.5000000", name="中央站", **extra):
    return {"stop_id": sid, "stop_name": name, "stop_lat": lat, "stop_lon": lon,
            "location_type": extra.get("location_type", ""),
            "parent_station": extra.get("parent_station", "")}


def build_feed(path, stops, routes, trips, stop_times, extra=None):
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("stops.txt", csv_text(
            ["stop_id", "stop_name", "stop_lat", "stop_lon", "location_type", "parent_station"], stops))
        z.writestr("routes.txt", csv_text(["route_id", "route_type"], routes))
        z.writestr("trips.txt", csv_text(["route_id", "trip_id"], trips))
        z.writestr("stop_times.txt", csv_text(["trip_id", "stop_sequence", "stop_id"], stop_times))
        for name, text in (extra or {}).items():
            z.writestr(name, text)


def read(path, name):
    with zipfile.ZipFile(path) as z, z.open(name) as f:
        return list(csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig")))


class MergeDuplicateStopsTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.feed = os.path.join(self.dir, "feed.zip")
        self.aliases = os.path.join(self.dir, "aliases.json")

    def run_merge(self):
        merge.main(self.feed, self.aliases)
        with open(self.aliases, encoding="utf-8") as f:
            return json.load(f)

    def test_merges_co_located_bus_stops_and_records_each_routes_alias(self):
        build_feed(
            self.feed,
            [stop("TPE1"), stop("TPE2"), stop("TPE3", lat="25.0500000")],
            [{"route_id": "R1_0", "route_type": "3"}, {"route_id": "R2_0", "route_type": "3"}],
            [{"route_id": "R1_0", "trip_id": "t1"}, {"route_id": "R2_0", "trip_id": "t2"}],
            [{"trip_id": "t1", "stop_sequence": "1", "stop_id": "TPE1"},
             {"trip_id": "t1", "stop_sequence": "2", "stop_id": "TPE3"},
             {"trip_id": "t2", "stop_sequence": "1", "stop_id": "TPE2"},
             {"trip_id": "t2", "stop_sequence": "2", "stop_id": "TPE3"}],
        )
        aliases = self.run_merge()

        self.assertEqual([s["stop_id"] for s in read(self.feed, "stops.txt")], ["TPE1", "TPE3"])
        self.assertEqual([r["stop_id"] for r in read(self.feed, "stop_times.txt")],
                         ["TPE1", "TPE3", "TPE1", "TPE3"])
        self.assertEqual(aliases, [{"routeId": "R2_0", "stopId": "TPE1", "originalStopId": "TPE2"}])

    def test_keeps_stops_apart_that_differ_in_name_city_or_place(self):
        build_feed(
            self.feed,
            [stop("TPE1"), stop("TPE2", name="別站"), stop("NWT3"), stop("TPE4", lon="121.5000001")],
            [{"route_id": "R1_0", "route_type": "3"}],
            [{"route_id": "R1_0", "trip_id": f"t{i}"} for i in range(4)],
            [{"trip_id": f"t{i}", "stop_sequence": "1", "stop_id": sid}
             for i, sid in enumerate(["TPE1", "TPE2", "NWT3", "TPE4"])],
        )
        self.assertEqual(self.run_merge(), [])
        self.assertEqual(len(read(self.feed, "stops.txt")), 4)

    def test_never_merges_stops_of_the_same_route(self):
        # A loop route serves both poles; merging would make a trip visit one stop twice.
        build_feed(
            self.feed,
            [stop("TPE1"), stop("TPE2"), stop("TPE3")],
            [{"route_id": "LOOP_0", "route_type": "3"}, {"route_id": "R2_0", "route_type": "3"}],
            [{"route_id": "LOOP_0", "trip_id": "loop"}, {"route_id": "R2_0", "trip_id": "t2"}],
            [{"trip_id": "loop", "stop_sequence": "1", "stop_id": "TPE1"},
             {"trip_id": "loop", "stop_sequence": "2", "stop_id": "TPE2"},
             {"trip_id": "t2", "stop_sequence": "1", "stop_id": "TPE3"}],
        )
        aliases = self.run_merge()

        times = read(self.feed, "stop_times.txt")
        loop = [r["stop_id"] for r in times if r["trip_id"] == "loop"]
        self.assertEqual(len(set(loop)), 2)
        self.assertEqual(aliases, [{"routeId": "R2_0", "stopId": "TPE1", "originalStopId": "TPE3"}])

    def test_leaves_rail_stations_and_unserved_stops_alone(self):
        build_feed(
            self.feed,
            [stop("TRTC1"), stop("TPE2"), stop("TPE3", parent_station="ST1"), stop("TPE4")],
            [{"route_id": "M_0", "route_type": "1"}, {"route_id": "B_0", "route_type": "3"}],
            [{"route_id": "M_0", "trip_id": "m"}, {"route_id": "B_0", "trip_id": "b"}],
            [{"trip_id": "m", "stop_sequence": "1", "stop_id": "TRTC1"},
             {"trip_id": "b", "stop_sequence": "1", "stop_id": "TPE2"},
             {"trip_id": "b", "stop_sequence": "2", "stop_id": "TPE3"}],
        )
        self.assertEqual(self.run_merge(), [])
        self.assertEqual(len(read(self.feed, "stops.txt")), 4)

    def test_rewrites_stop_areas_and_drops_translations_of_removed_stops(self):
        build_feed(
            self.feed,
            [stop("TPE1"), stop("TPE2")],
            [{"route_id": "R1_0", "route_type": "3"}, {"route_id": "R2_0", "route_type": "3"}],
            [{"route_id": "R1_0", "trip_id": "t1"}, {"route_id": "R2_0", "trip_id": "t2"}],
            [{"trip_id": "t1", "stop_sequence": "1", "stop_id": "TPE1"},
             {"trip_id": "t2", "stop_sequence": "1", "stop_id": "TPE2"}],
            extra={
                "stop_areas.txt": csv_text(["area_id", "stop_id"],
                                           [{"area_id": "A", "stop_id": "TPE1"},
                                            {"area_id": "A", "stop_id": "TPE2"}]),
                "translations.txt": csv_text(
                    ["table_name", "field_name", "language", "translation", "record_id"],
                    [{"table_name": "stops", "field_name": "stop_name", "language": "en",
                      "translation": "Central", "record_id": "TPE1"},
                     {"table_name": "stops", "field_name": "stop_name", "language": "en",
                      "translation": "Central", "record_id": "TPE2"}]),
            },
        )
        self.run_merge()

        self.assertEqual(read(self.feed, "stop_areas.txt"), [{"area_id": "A", "stop_id": "TPE1"}])
        self.assertEqual([r["record_id"] for r in read(self.feed, "translations.txt")], ["TPE1"])


if __name__ == "__main__":
    unittest.main()
