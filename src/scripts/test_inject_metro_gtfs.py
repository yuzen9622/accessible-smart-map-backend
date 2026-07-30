#!/usr/bin/env python3
"""Deterministic unit tests for inject-metro-gtfs.py's shape backfill.

Stdlib only (unittest); no network. Fixtures are built in a tmp dir with zipfile.

Covers the regression that made 文湖線 render as station-to-station straight
lines: the official TRTC graft writes trips with an EMPTY shape_id, which the
backfill used to skip outright, and the shapes.txt writer never flushed its
buffer, so freshly injected shape points could be dropped on the way out.

    python3 src/scripts/test_inject_metro_gtfs.py
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

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(SCRIPT_DIR, "inject-metro-gtfs.py")

ROUTES = (
    "route_id,route_short_name,route_long_name,route_type\n"
    "TRTC_BR_BR-1_0,動物園－南港展覽館,動物園－南港展覽館,1\n"
)
# The official TRTC graft (inject-trtc-official-gtfs.py) emits shape_id="".
TRIPS = (
    "route_id,service_id,trip_id,shape_id,direction_id\n"
    "TRTC_BR_BR-1_0,TRTC_OFF_SVC,TRTC_OFF_brownTripN3_UP,,0\n"
)
STOPS = (
    "stop_id,stop_name,stop_lat,stop_lon\n"
    "TRTC_BR01,動物園,24.9982,121.5794\n"
    "TRTC_BR02,木柵,24.9982,121.5730\n"
)
STOP_TIMES = (
    "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n"
    "TRTC_OFF_brownTripN3_UP,06:00:00,06:00:00,TRTC_BR01,1\n"
    "TRTC_OFF_brownTripN3_UP,06:02:00,06:02:00,TRTC_BR02,2\n"
)
CALENDAR = (
    "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n"
    "TRTC_OFF_SVC,1,1,1,1,1,1,1,20260101,20261231\n"
)
FREQUENCIES = "trip_id,start_time,end_time,headway_secs,exact_times\n"
PRIOR_SHAPES = (
    "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n"
    "NATIVE_R,25.0,121.5,1\n"
    "NATIVE_R,25.1,121.6,2\n"
)
SHAPE_JSON = [{
    "RouteID": "BR-1",
    "LineID": "BR",
    "Direction": 0,
    "Geometry": "LINESTRING(121.5794 24.9982, 121.5760 24.9985, 121.5730 24.9982)",
}]


def build_feed(tmp, with_prior_shapes):
    """Minimal national-feed slice: one shapeless official Brown trip."""
    feed = os.path.join(tmp, "feed-1.gtfs.zip")
    with zipfile.ZipFile(feed, "w") as z:
        z.writestr("routes.txt", ROUTES)
        z.writestr("trips.txt", TRIPS)
        z.writestr("stops.txt", STOPS)
        z.writestr("stop_times.txt", STOP_TIMES)
        z.writestr("calendar.txt", CALENDAR)
        z.writestr("frequencies.txt", FREQUENCIES)
        if with_prior_shapes:
            z.writestr("shapes.txt", PRIOR_SHAPES)
    metro_dir = os.path.join(tmp, "metro")
    os.makedirs(metro_dir, exist_ok=True)
    with open(os.path.join(metro_dir, "TRTC.shape.json"), "w") as f:
        json.dump(SHAPE_JSON, f)
    return feed, metro_dir


def run_injector(feed, metro_dir):
    subprocess.run([sys.executable, SCRIPT, feed, metro_dir],
                   check=True, capture_output=True)


def rows(feed, name):
    with zipfile.ZipFile(feed) as z:
        if name not in z.namelist():
            return None
        return list(csv.DictReader(io.StringIO(z.read(name).decode("utf-8-sig"))))


def build_blank_direction_feed(tmp):
    """Same slice on the direction-1 route, with a BLANK direction_id column —
    the shape fixture is direction-agnostic, so it must come back reversed."""
    feed = os.path.join(tmp, "feed-1.gtfs.zip")
    with zipfile.ZipFile(feed, "w") as z:
        z.writestr("routes.txt", ROUTES.replace("BR-1_0", "BR-1_1"))
        z.writestr("trips.txt", TRIPS.replace("BR-1_0", "BR-1_1").replace("_UP,,0", "_DN,,"))
        z.writestr("stops.txt", STOPS)
        z.writestr("stop_times.txt", STOP_TIMES.replace("_UP,", "_DN,"))
        z.writestr("calendar.txt", CALENDAR)
        z.writestr("frequencies.txt", FREQUENCIES)
    metro_dir = os.path.join(tmp, "metro")
    os.makedirs(metro_dir, exist_ok=True)
    with open(os.path.join(metro_dir, "TRTC.shape.json"), "w") as f:
        json.dump(SHAPE_JSON, f)
    return feed, metro_dir


def build_sibling_feed(tmp):
    """Shapeless official trip sitting next to a national trip that already
    carries a real, stop-fitting shape for the same route+direction."""
    feed = os.path.join(tmp, "feed-1.gtfs.zip")
    trips = TRIPS + "TRTC_BR_BR-1_0,NAT_SVC,TRTC_BR_BR-1_0_F_1,TRTC_BR01_BR24_0,0\n"
    stop_times = STOP_TIMES + (
        "TRTC_BR_BR-1_0_F_1,07:00:00,07:00:00,TRTC_BR01,1\n"
        "TRTC_BR_BR-1_0_F_1,07:02:00,07:02:00,TRTC_BR02,2\n"
    )
    with zipfile.ZipFile(feed, "w") as z:
        z.writestr("routes.txt", ROUTES)
        z.writestr("trips.txt", trips)
        z.writestr("stops.txt", STOPS)
        z.writestr("stop_times.txt", stop_times)
        z.writestr("calendar.txt", CALENDAR + "NAT_SVC,1,1,1,1,1,1,1,20260101,20261231\n")
        z.writestr("frequencies.txt", FREQUENCIES)
        z.writestr("shapes.txt",
                   "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n"
                   "TRTC_BR01_BR24_0,24.9982,121.5794,1\n"
                   "TRTC_BR01_BR24_0,24.9985,121.5760,2\n"
                   "TRTC_BR01_BR24_0,24.9982,121.5730,3\n")
    metro_dir = os.path.join(tmp, "metro")
    os.makedirs(metro_dir, exist_ok=True)
    with open(os.path.join(metro_dir, "TRTC.shape.json"), "w") as f:
        json.dump(SHAPE_JSON, f)
    return feed, metro_dir


class ShapeBackfill(unittest.TestCase):
    def _assert_backfilled(self, feed):
        trip = rows(feed, "trips.txt")[0]
        shape_id = trip["shape_id"]
        self.assertTrue(shape_id, "shapeless metro trip was left without a shape_id")
        pts = [r for r in rows(feed, "shapes.txt") if r["shape_id"] == shape_id]
        self.assertEqual(len(pts), 3, "minted shape points missing from shapes.txt")
        return shape_id

    def test_mints_shape_for_shapeless_trip_when_feed_has_no_shapes(self):
        with tempfile.TemporaryDirectory() as tmp:
            feed, metro_dir = build_feed(tmp, with_prior_shapes=False)
            run_injector(feed, metro_dir)
            self._assert_backfilled(feed)

    def test_mints_shape_and_preserves_existing_shapes(self):
        with tempfile.TemporaryDirectory() as tmp:
            feed, metro_dir = build_feed(tmp, with_prior_shapes=True)
            run_injector(feed, metro_dir)
            self._assert_backfilled(feed)
            native = [r for r in rows(feed, "shapes.txt") if r["shape_id"] == "NATIVE_R"]
            self.assertEqual(len(native), 2, "pre-existing shapes were clobbered")

    def test_blank_direction_id_falls_back_to_the_route_id_direction(self):
        with tempfile.TemporaryDirectory() as tmp:
            feed, metro_dir = build_blank_direction_feed(tmp)
            run_injector(feed, metro_dir)
            shape_id = self._assert_backfilled(feed)
            self.assertTrue(shape_id.endswith("_1"),
                            f"blank direction_id was not resolved to the route's direction: {shape_id}")
            pts = [r for r in rows(feed, "shapes.txt") if r["shape_id"] == shape_id]
            # Direction-agnostic source geometry runs 動物園→木柵; direction 1 is
            # the return trip, so the points must be reversed.
            self.assertEqual(pts[0]["shape_pt_lon"], "121.573")
            self.assertEqual(pts[-1]["shape_pt_lon"], "121.5794")

    def test_adopts_sibling_shape_instead_of_minting(self):
        with tempfile.TemporaryDirectory() as tmp:
            feed, metro_dir = build_sibling_feed(tmp)
            run_injector(feed, metro_dir)
            trips = {t["trip_id"]: t["shape_id"] for t in rows(feed, "trips.txt")}
            self.assertEqual(trips["TRTC_OFF_brownTripN3_UP"], "TRTC_BR01_BR24_0",
                             "shapeless trip did not adopt its sibling's proven shape")
            self.assertEqual(trips["TRTC_BR_BR-1_0_F_1"], "TRTC_BR01_BR24_0",
                             "sibling's own shape_id was altered")
            minted = [r for r in rows(feed, "shapes.txt") if r["shape_id"].startswith("MRT_NAT_")]
            self.assertEqual(minted, [], "minted a shape despite a usable sibling shape existing")

    def test_rerun_is_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp:
            feed, metro_dir = build_feed(tmp, with_prior_shapes=True)
            run_injector(feed, metro_dir)
            first = self._assert_backfilled(feed)
            run_injector(feed, metro_dir)
            second = self._assert_backfilled(feed)
            self.assertEqual(first, second)
            self.assertEqual(len(rows(feed, "shapes.txt")), 5)


if __name__ == "__main__":
    unittest.main(verbosity=2)
