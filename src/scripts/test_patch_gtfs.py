#!/usr/bin/env python3
"""Deterministic unit/integration tests for patch_gtfs.py.

Runs with the stdlib only (unittest + unittest.mock); no network, no new deps.
Run from the repo root:

    python3 src/scripts/test_patch_gtfs.py
"""
import csv
import datetime
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import http.client
import urllib.error
import zipfile
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import patch_gtfs  # noqa: E402

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "patch_gtfs.py")


def _ok(payload):
    """A urlopen() context manager whose .read() yields json-encoded payload."""
    resp = mock.MagicMock()
    resp.read.return_value = json.dumps(payload).encode("utf-8")
    cm = mock.MagicMock()
    cm.__enter__.return_value = resp
    cm.__exit__.return_value = False
    return cm


def _raw(raw_bytes):
    resp = mock.MagicMock()
    resp.read.return_value = raw_bytes
    cm = mock.MagicMock()
    cm.__enter__.return_value = resp
    cm.__exit__.return_value = False
    return cm


def _http(code, body=""):
    """A transport-layer HTTPError (what a mocked urlopen raises)."""
    return urllib.error.HTTPError(
        "http://test/url", code, "Test Reason", {}, io.BytesIO(body.encode("utf-8")))


def _tdx_http(status, body=""):
    """A TdxHttpError (what the real fetch_paginated_api raises for 4xx)."""
    return patch_gtfs.TdxHttpError(status, "Test Reason", "http://test/url", body)


def _origin_only_route(route_uid="TEST01", direction=0, dep="06:00"):
    return {
        "RouteUID": route_uid, "SubRouteUID": route_uid, "RouteID": route_uid,
        "RouteName": {"Zh_tw": route_uid}, "Direction": direction,
        "Timetables": [{
            "TripID": f"{route_uid}-t1",
            "ServiceDay": {"Monday": 1},
            "StopTimes": [{"StopUID": "S1", "StopSequence": 1, "ArrivalTime": dep, "DepartureTime": dep}],
        }],
    }


def _usable_route(route_uid="TEST01", direction=0):
    return {
        "RouteUID": route_uid, "SubRouteUID": route_uid, "Direction": direction,
        "Timetables": [{"StopTimes": [
            {"StopUID": "S1", "StopSequence": 1, "ArrivalTime": "06:00", "DepartureTime": "06:00"},
            {"StopUID": "S2", "StopSequence": 2, "ArrivalTime": "06:10", "DepartureTime": "06:10"},
        ]}],
    }


def _sor_route(route_uid="TEST01", n_stops=2, direction=0):
    return {
        "RouteUID": route_uid, "SubRouteUID": route_uid, "Direction": direction,
        "Stops": [
            {"StopUID": f"S{i}", "StopSequence": i,
             "StopPosition": {"PositionLat": 25.0 + i * 0.001, "PositionLon": 121.5 + i * 0.001}}
            for i in range(1, n_stops + 1)
        ],
    }


def _freq_route(route_uid="FREQ01", direction=0, windows=None, service_day=None):
    """A headway-only Schedule record: Frequencys, no Timetables."""
    if windows is None:
        windows = [{"StartTime": "05:00", "EndTime": "22:00",
                    "MinHeadwayMins": 15, "MaxHeadwayMins": 20}]
    if service_day is None:
        service_day = {"Monday": 1, "Tuesday": 1, "Wednesday": 1,
                       "Thursday": 1, "Friday": 1}
    freqs = []
    for w in windows:
        entry = dict(w)
        entry.setdefault("ServiceDay", service_day)
        freqs.append(entry)
    return {
        "RouteUID": route_uid, "SubRouteUID": route_uid, "RouteID": route_uid,
        "RouteName": {"Zh_tw": route_uid}, "Direction": direction,
        "Frequencys": freqs,
    }


def _scheduled_route(route_uid, sub_route_uid=None, route_id=None, name=None,
                     direction=0, trip_id=None, stop_ids=("S1", "S2")):
    sub_route_uid = sub_route_uid if sub_route_uid is not None else route_uid
    return {
        "RouteUID": route_uid,
        "SubRouteUID": sub_route_uid,
        "RouteID": route_id or route_uid,
        "RouteName": {"Zh_tw": name or route_uid},
        "Direction": direction,
        "Timetables": [{
            "TripID": trip_id or f"{sub_route_uid}-trip",
            "ServiceDay": {"Monday": 1},
            "StopTimes": [
                {"StopUID": stop_id, "StopSequence": index,
                 "ArrivalTime": f"06:{(index - 1) * 10:02d}",
                 "DepartureTime": f"06:{(index - 1) * 10:02d}"}
                for index, stop_id in enumerate(stop_ids, start=1)
            ],
        }],
    }


def _full_stats():
    return {"freq_only": 0, "no_service_day": 0, "dup_trip": 0, "short_trip": 0,
            "synthesized": 0, "sor_synth": 0, "missing_shape": 0, "freq_trips": 0,
            "freq_windows": 0, "freq_valhalla_fail": 0, "freq_no_stops": 0,
            "route_match_subroute_exact": 0, "route_match_route_exact": 0,
            "route_match_prefix": 0, "route_match_prefix_ambiguous": 0,
            "route_match_name": 0, "route_unmatched": 0,
            "shape_from_subroute": 0, "shape_from_route_uid": 0,
            "shape_from_reversed": 0, "shape_from_static": 0,
            "shape_rejected_unfit": 0}


def _shape_assigner(stats, route_shapes=None, tdx_shapes=None,
                    static_shapes=None, stop_coords=None):
    return patch_gtfs.ShapeAssigner(
        route_shapes or {}, tdx_shapes or {}, static_shapes or {},
        stop_coords or {}, stats)


def _write_fixture_zip(path, with_frequencies=False, with_stops=True):
    """A minimal GTFS feed: one preserved non-bus (metro) trip, one bus trip that
    patch_gtfs deletes, and the calendar/shapes scaffolding patch_gtfs_zip reads."""
    files = {
        "agency.txt": "agency_id,agency_name\nA,Test\n",
        "routes.txt": "route_id,route_type\nFREQ01_0,3\nM1,1\n",
        "trips.txt": ("route_id,service_id,trip_id,direction_id,shape_id\n"
                      "M1,svcM,mtrip1,0,mshape\n"
                      "FREQ01_0,svcOld,oldbus,0,\n"),
        "stop_times.txt": ("trip_id,arrival_time,departure_time,stop_id,stop_sequence\n"
                           "mtrip1,08:00:00,08:00:00,MS1,1\n"
                           "mtrip1,08:05:00,08:05:00,MS2,2\n"
                           "oldbus,09:00:00,09:00:00,S1,1\n"),
        "calendar.txt": ("service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n"
                         "svcM,1,1,1,1,1,0,0,20260101,20261231\n"),
        "calendar_dates.txt": "service_id,date,exception_type\n",
        "shapes.txt": ("shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n"
                       "mshape,25.0,121.5,1\nmshape,25.01,121.51,2\n"),
    }
    if with_stops:
        files["stops.txt"] = (
            "stop_id,stop_name,stop_lat,stop_lon\n"
            "S1,Stop 1,25.001,121.501\n"
            "S2,Stop 2,25.002,121.502\n"
            "S3,Stop 3,25.003,121.503\n"
            "MS1,Metro 1,25.0,121.5\n"
            "MS2,Metro 2,25.01,121.51\n")
    if with_frequencies:
        files["frequencies.txt"] = ("trip_id,start_time,end_time,headway_secs,exact_times\n"
                                    "mtrip1,08:00:00,20:00:00,600,0\n")
    with zipfile.ZipFile(path, "w") as z:
        for name, content in files.items():
            z.writestr(name, content)


@mock.patch("patch_gtfs.time.sleep", lambda *a, **k: None)
class FetchPaginatedApiTests(unittest.TestCase):
    def test_400_fails_fast_with_body(self):
        body = '{"Message":"City: \'Taipei\' is not accepted but Taichung..."}'
        with mock.patch("patch_gtfs.urllib.request.urlopen", side_effect=[_http(400, body)]) as up:
            with self.assertRaises(patch_gtfs.TdxHttpError) as ctx:
                patch_gtfs.fetch_paginated_api("tok", "http://x?a=b", strict=True)
        self.assertEqual(ctx.exception.status, 400)
        self.assertIn("not accepted", ctx.exception.body)
        self.assertEqual(up.call_count, 1)  # no retry on 4xx

    def test_403_is_fatal(self):
        with mock.patch("patch_gtfs.urllib.request.urlopen", side_effect=[_http(403)]):
            with self.assertRaises(patch_gtfs.TdxHttpError) as ctx:
                patch_gtfs.fetch_paginated_api("tok", "http://x", strict=True)
        self.assertEqual(ctx.exception.status, 403)
        self.assertIsInstance(ctx.exception, patch_gtfs.TdxFetchError)

    def test_429_retries_then_succeeds(self):
        with mock.patch("patch_gtfs.urllib.request.urlopen",
                        side_effect=[_http(429), _ok([{"x": 1}])]) as up:
            recs = patch_gtfs.fetch_paginated_api("tok", "http://x", strict=True)
        self.assertEqual(recs, [{"x": 1}])
        self.assertEqual(up.call_count, 2)

    def test_5xx_exhaust_strict_raises(self):
        with mock.patch("patch_gtfs.urllib.request.urlopen", side_effect=[_http(503)] * 5):
            with self.assertRaises(patch_gtfs.TdxFetchError):
                patch_gtfs.fetch_paginated_api("tok", "http://x", strict=True)

    def test_5xx_exhaust_non_strict_returns_empty(self):
        with mock.patch("patch_gtfs.urllib.request.urlopen", side_effect=[_http(503)] * 5):
            self.assertEqual(patch_gtfs.fetch_paginated_api("tok", "http://x"), [])

    def test_transport_exhaust_strict_raises(self):
        for exc in (urllib.error.URLError("down"), TimeoutError("read timed out")):
            with mock.patch("patch_gtfs.urllib.request.urlopen", side_effect=[exc] * 5):
                with self.assertRaises(patch_gtfs.TdxFetchError):
                    patch_gtfs.fetch_paginated_api("tok", "http://x", strict=True)

    def test_incomplete_read_is_retried(self):
        truncated = _ok([])
        truncated.__enter__.return_value.read.side_effect = http.client.IncompleteRead(b"partial")
        with mock.patch(
                "patch_gtfs.urllib.request.urlopen",
                side_effect=[truncated, _ok([{"x": 1}])]) as up:
            recs = patch_gtfs.fetch_paginated_api("tok", "http://x", strict=True)
        self.assertEqual(recs, [{"x": 1}])
        self.assertEqual(up.call_count, 2)

    def test_incomplete_read_exhausts_retries_raises_fetch_error(self):
        truncated = _ok([])
        truncated.__enter__.return_value.read.side_effect = http.client.IncompleteRead(b"partial")
        with mock.patch(
                "patch_gtfs.urllib.request.urlopen",
                side_effect=[truncated] * 5) as up:
            with self.assertRaises(patch_gtfs.TdxFetchError):
                patch_gtfs.fetch_paginated_api("tok", "http://x", strict=True)
        self.assertEqual(up.call_count, 5)

    def test_invalid_json_strict_raises_once(self):
        with mock.patch("patch_gtfs.urllib.request.urlopen", side_effect=[_raw(b"<html>oops")]) as up:
            with self.assertRaises(patch_gtfs.TdxFetchError):
                patch_gtfs.fetch_paginated_api("tok", "http://x", strict=True)
        self.assertEqual(up.call_count, 1)  # deterministic error, not retried

    def test_v3_unwrap_and_pagination(self):
        page1 = _ok({"DailyTimeTables": [{"i": n} for n in range(1000)]})
        page2 = _ok({"DailyTimeTables": [{"i": 1}, {"i": 2}, {"i": 3}]})
        with mock.patch("patch_gtfs.urllib.request.urlopen", side_effect=[page1, page2]):
            recs = patch_gtfs.fetch_paginated_api("tok", "http://x", page_key="DailyTimeTables", strict=True)
        self.assertEqual(len(recs), 1003)

    def test_v3_missing_key_or_wrong_type_fatal(self):
        for payload in ({"WrongKey": []}, {"DailyTimeTables": "notalist"}):
            with mock.patch("patch_gtfs.urllib.request.urlopen", side_effect=[_ok(payload)]):
                with self.assertRaises(patch_gtfs.TdxFetchError):
                    patch_gtfs.fetch_paginated_api("tok", "http://x", page_key="DailyTimeTables", strict=True)

    def test_non_dict_element_fatal_strict_only(self):
        payload = {"DailyTimeTables": [{"a": 1}, None, "s"]}
        with mock.patch("patch_gtfs.urllib.request.urlopen", side_effect=[_ok(payload)]):
            with self.assertRaises(patch_gtfs.TdxFetchError):
                patch_gtfs.fetch_paginated_api("tok", "http://x", page_key="DailyTimeTables", strict=True)
        with mock.patch("patch_gtfs.urllib.request.urlopen", side_effect=[_ok(payload)]):
            recs = patch_gtfs.fetch_paginated_api("tok", "http://x", page_key="DailyTimeTables")
            self.assertEqual(len(recs), 3)  # non-strict does not validate elements

    def test_v2_top_level_non_list(self):
        with mock.patch("patch_gtfs.urllib.request.urlopen", side_effect=[_ok({"d": 1})]):
            with self.assertRaises(patch_gtfs.TdxFetchError):
                patch_gtfs.fetch_paginated_api("tok", "http://x", strict=True)
        with mock.patch("patch_gtfs.urllib.request.urlopen", side_effect=[_ok({"d": 1})]):
            self.assertEqual(patch_gtfs.fetch_paginated_api("tok", "http://x"), [])


@mock.patch("patch_gtfs.time.sleep", lambda *a, **k: None)
class VersionCascadeTests(unittest.TestCase):
    def test_v2_usable_skips_v3(self):
        with mock.patch("patch_gtfs.fetch_paginated_api", side_effect=[[{"a": 1}]]) as f:
            recs, src = patch_gtfs.fetch_with_version("t", "v2", "v3", "K")
        self.assertEqual((recs, src), ([{"a": 1}], "v2"))
        self.assertEqual(f.call_count, 1)

    def test_v2_400_falls_to_v3(self):
        with mock.patch("patch_gtfs.fetch_paginated_api",
                        side_effect=[_tdx_http(400, "v2body"), [{"a": 1}]]):
            recs, src = patch_gtfs.fetch_with_version("t", "v2", "v3", "K")
        self.assertEqual(src, "v3")

    def test_v2_non_400_fatal_no_v3(self):
        with mock.patch("patch_gtfs.fetch_paginated_api", side_effect=[_tdx_http(403)]) as f:
            with self.assertRaises(patch_gtfs.TdxHttpError):
                patch_gtfs.fetch_with_version("t", "v2", "v3", "K")
        self.assertEqual(f.call_count, 1)

    def test_both_400_keeps_v3_body(self):
        with mock.patch("patch_gtfs.fetch_paginated_api",
                        side_effect=[_tdx_http(400, "v2body"), _tdx_http(400, "v3body")]):
            with self.assertRaises(patch_gtfs.TdxHttpError) as ctx:
                patch_gtfs.fetch_with_version("t", "v2", "v3", "K")
        self.assertEqual(ctx.exception.status, 400)
        self.assertEqual(ctx.exception.body, "v3body")

    def test_schedule_both_400_fatal_with_body(self):
        with mock.patch("patch_gtfs.fetch_paginated_api",
                        side_effect=[_tdx_http(400), _tdx_http(400, "v3body")]):
            with self.assertRaises(patch_gtfs.TdxFetchError) as ctx:
                patch_gtfs.fetch_city_schedule("t", "Ghost")
        self.assertNotIsInstance(ctx.exception, patch_gtfs.TdxHttpError)
        self.assertIn("v3body", str(ctx.exception))

    def test_schedule_403_propagates(self):
        with mock.patch("patch_gtfs.fetch_paginated_api", side_effect=[_tdx_http(403)]):
            with self.assertRaises(patch_gtfs.TdxHttpError):
                patch_gtfs.fetch_city_schedule("t", "Taichung")

    def test_schedule_v2_usable(self):
        with mock.patch("patch_gtfs.fetch_paginated_api", side_effect=[[{"RouteUID": "X"}]]):
            recs, src = patch_gtfs.fetch_city_schedule("t", "Taichung")
        self.assertEqual(src, "v2")


@mock.patch("patch_gtfs.time.sleep", lambda *a, **k: None)
class DailyCascadeTests(unittest.TestCase):
    def test_v2_usable_skips_v3(self):
        with mock.patch("patch_gtfs.fetch_paginated_api", side_effect=[[_usable_route()]]) as f:
            recs, src = patch_gtfs.fetch_daily_timetable("t", "Taichung")
        self.assertEqual(src, "v2")
        self.assertEqual(f.call_count, 1)

    def test_v2_unusable_falls_to_v3_usable(self):
        # v2 returns a legal but origin-only batch -> must still try v3 (regression guard)
        with mock.patch("patch_gtfs.fetch_paginated_api",
                        side_effect=[[_origin_only_route()], [_usable_route()]]) as f:
            recs, src = patch_gtfs.fetch_daily_timetable("t", "Tainan")
        self.assertEqual(src, "v3")
        self.assertEqual(f.call_count, 2)

    def test_v2_400_v3_usable(self):
        with mock.patch("patch_gtfs.fetch_paginated_api",
                        side_effect=[_tdx_http(400), [_usable_route()]]):
            recs, src = patch_gtfs.fetch_daily_timetable("t", "Tainan")
        self.assertEqual(src, "v3")

    def test_both_unusable_raises_unavailable(self):
        with mock.patch("patch_gtfs.fetch_paginated_api",
                        side_effect=[[_origin_only_route()], []]):
            with self.assertRaises(patch_gtfs.DailyTimetableUnavailable):
                patch_gtfs.fetch_daily_timetable("t", "Taipei")

    def test_both_400_raises_unavailable(self):
        with mock.patch("patch_gtfs.fetch_paginated_api",
                        side_effect=[_tdx_http(400), _tdx_http(400)]):
            with self.assertRaises(patch_gtfs.DailyTimetableUnavailable):
                patch_gtfs.fetch_daily_timetable("t", "Taipei")

    def test_v2_403_fatal_no_v3(self):
        with mock.patch("patch_gtfs.fetch_paginated_api", side_effect=[_tdx_http(403)]) as f:
            with self.assertRaises(patch_gtfs.TdxHttpError):
                patch_gtfs.fetch_daily_timetable("t", "Taipei")
        self.assertEqual(f.call_count, 1)

    def test_v3_drift_propagates_not_degraded(self):
        with mock.patch("patch_gtfs.fetch_paginated_api",
                        side_effect=[_tdx_http(400), patch_gtfs.TdxFetchError("v3 drift")]):
            with self.assertRaises(patch_gtfs.TdxFetchError) as ctx:
                patch_gtfs.fetch_daily_timetable("t", "Tainan")
        self.assertNotIsInstance(ctx.exception, patch_gtfs.DailyTimetableUnavailable)

    def test_intercity_400_degrades(self):
        with mock.patch("patch_gtfs.fetch_paginated_api", side_effect=[_tdx_http(400)]):
            with self.assertRaises(patch_gtfs.DailyTimetableUnavailable):
                patch_gtfs.fetch_intercity_daily("t")

    def test_intercity_403_fatal(self):
        with mock.patch("patch_gtfs.fetch_paginated_api", side_effect=[_tdx_http(403)]):
            with self.assertRaises(patch_gtfs.TdxHttpError):
                patch_gtfs.fetch_intercity_daily("t")


@mock.patch("patch_gtfs.time.sleep", lambda *a, **k: None)
class ShapeAndStopOfRouteTests(unittest.TestCase):
    def test_shape_400_tolerated(self):
        with mock.patch("patch_gtfs.fetch_paginated_api", side_effect=[_tdx_http(400)]):
            self.assertEqual(patch_gtfs.fetch_shape("t", "u"), [])

    def test_shape_403_fatal(self):
        with mock.patch("patch_gtfs.fetch_paginated_api", side_effect=[_tdx_http(403)]):
            with self.assertRaises(patch_gtfs.TdxHttpError):
                patch_gtfs.fetch_shape("t", "u")

    def test_shape_5xx_and_transport_fatal(self):
        for exc in ([_http(503)] * 5, [urllib.error.URLError("x")] * 5):
            with mock.patch("patch_gtfs.urllib.request.urlopen", side_effect=exc):
                with self.assertRaises(patch_gtfs.TdxFetchError):
                    patch_gtfs.fetch_shape("t", "http://x")

    def test_stop_of_route_400_tolerated_else_fatal(self):
        with mock.patch("patch_gtfs.fetch_paginated_api", side_effect=[_tdx_http(400)]):
            self.assertEqual(patch_gtfs.fetch_stop_of_route("t", "u"), [])
        with mock.patch("patch_gtfs.fetch_paginated_api", side_effect=[_tdx_http(403)]):
            with self.assertRaises(patch_gtfs.TdxHttpError):
                patch_gtfs.fetch_stop_of_route("t", "u")


class RouteMatchingPrecedenceTests(unittest.TestCase):
    """R1/R2: exact subroute matching precedes deterministic prefix fallback."""

    def _process(self, route, route_ids, route_list=None):
        trips, stop_times, stats = [], [], _full_stats()
        assigner = _shape_assigner(stats)
        patch_gtfs.process_schedule_records_to_gtfs(
            [route], trips, stop_times, [], set(),
            route_list or [{"route_id": route_id} for route_id in route_ids],
            set(route_ids), set(), stats, {}, assigner, {})
        return trips, stats

    def test_subroute_exact_wins_over_route_uid_prefix(self):
        route_ids = {"HSQ008101_0", "HSQ0081A1_0", "HSQ0081B1_0"}
        route = _scheduled_route("HSQ0081", "HSQ008101", trip_id="0909_1")
        trips, stats = self._process(route, route_ids)
        self.assertEqual([trip["route_id"] for trip in trips], ["HSQ008101_0"])
        self.assertFalse(any(trip["route_id"] == "HSQ0081B1_0" for trip in trips))
        self.assertEqual(stats["route_match_subroute_exact"], 1)

    def test_route_uid_exact_used_when_no_subroute_route_id(self):
        route = _scheduled_route("HSQ0081", "HSQ008101")
        trips, stats = self._process(route, {"HSQ0081_0"})
        self.assertEqual(trips[0]["route_id"], "HSQ0081_0")
        self.assertEqual(stats["route_match_route_exact"], 1)

    def test_prefix_match_is_deterministic_and_flagged(self):
        route = _scheduled_route("HSQ0081", "MISSING")
        orders = [
            ["HSQ0081B1_0", "HSQ008101_0", "HSQ0081A1_0"],
            ["HSQ0081A1_0", "HSQ0081B1_0", "HSQ008101_0"],
        ]
        results = []
        for route_ids in orders:
            trips, stats = self._process(route, route_ids)
            results.append(trips[0]["route_id"])
            self.assertEqual(stats["route_match_prefix"], 1)
            self.assertEqual(stats["route_match_prefix_ambiguous"], 1)
        self.assertEqual(results, ["HSQ008101_0", "HSQ008101_0"])

    def test_unmatched_route_counted(self):
        route = _scheduled_route("UNKNOWN", "UNKNOWN01")
        trips, stats = self._process(route, {"HSQ008101_0"})
        self.assertEqual(trips, [])
        self.assertEqual(stats["route_unmatched"], 1)


class ShapeIndexTests(unittest.TestCase):
    """R3: TDX shape indexing keeps exact subroutes and first-seen route fallback."""

    def test_subroute_key_is_primary_and_route_uid_is_first_wins(self):
        first = {
            "RouteUID": "HSQ0081", "SubRouteUID": "HSQ008101", "Direction": 0,
            "Geometry": "LINESTRING (121.0 24.0, 121.1 24.1)",
        }
        second = {
            "RouteUID": "HSQ0081", "SubRouteUID": "HSQ0081B1", "Direction": 0,
            "Geometry": "LINESTRING (122.0 25.0, 122.1 25.1)",
        }
        index = patch_gtfs.build_shape_index([first, second])
        self.assertEqual(index[("HSQ008101", 0)][0], (24.0, 121.0))
        self.assertEqual(index[("HSQ0081B1", 0)][0], (25.0, 122.0))
        self.assertEqual(index[("HSQ0081", 0)], index[("HSQ008101", 0)])


class ShapeFitTests(unittest.TestCase):
    """R4/R5/R6: candidate order, fit validation, and collision-free IDs."""

    LINE = [(25.0, 121.5), (25.0, 121.52)]
    STOP_COORDS = {"S1": (25.0, 121.501), "S2": (25.0, 121.519)}
    OPPOSITE_LINE = [(25.0, 121.52), (25.002, 121.51), (25.0, 121.5)]

    def test_unfit_shape_is_rejected_and_not_emitted(self):
        stats = _full_stats()
        assigner = _shape_assigner(
            stats, tdx_shapes={("SUB", 0): self.LINE},
            stop_coords={"S1": (25.003, 121.51)})
        shape_id = assigner.select("ROUTE_0", "SUB", "ROUTE", 0, ["S1"])
        self.assertEqual(shape_id, "")
        self.assertEqual(stats["shape_rejected_unfit"], 1)
        self.assertEqual(assigner.new_shapes, {})

    def test_subroute_shape_preferred_over_inherited_static(self):
        stats = _full_stats()
        assigner = _shape_assigner(
            stats,
            route_shapes={"ROUTE_0": "static_wrong"},
            tdx_shapes={("SUB", 0): self.LINE},
            static_shapes={"static_wrong": [(25.01, 121.5), (25.01, 121.52)]},
            stop_coords=self.STOP_COORDS)
        shape_id = assigner.select("ROUTE_0", "SUB", "ROUTE", 0, ["S1", "S2"])
        self.assertEqual(shape_id, "patched_shp_SUB_0")
        self.assertEqual(stats["shape_from_subroute"], 1)
        self.assertIn(shape_id, assigner.new_shapes)

    def test_reversed_opposite_direction_shape_gets_distinct_id(self):
        """R6: the opposite-direction geometry is emitted with its point sequence
        reversed, under an ID distinct from the direct candidate's."""
        stats = _full_stats()
        assigner = _shape_assigner(
            stats, tdx_shapes={("SUB", 1): list(self.OPPOSITE_LINE)},
            stop_coords=self.STOP_COORDS)
        shape_id = assigner.select("ROUTE_0", "SUB", "ROUTE", 0, ["S1", "S2"])
        self.assertEqual(shape_id, "patched_shp_SUB_0r")
        self.assertEqual(stats["shape_from_reversed"], 1)
        self.assertEqual(assigner.new_shapes[shape_id],
                         list(reversed(self.OPPOSITE_LINE)))
        self.assertNotEqual(assigner.new_shapes[shape_id], self.OPPOSITE_LINE)

    def test_missing_stop_coords_does_not_reject(self):
        stats = _full_stats()
        assigner = _shape_assigner(stats, tdx_shapes={("SUB", 0): self.LINE})
        shape_id = assigner.select("ROUTE_0", "SUB", "ROUTE", 0, ["S1", "S2"])
        self.assertEqual(shape_id, "patched_shp_SUB_0")
        self.assertEqual(stats["shape_from_subroute"], 1)

    def test_fit_uses_segment_distance_not_vertex_distance(self):
        stats = _full_stats()
        long_line = [(25.0, 121.49), (25.0, 121.51)]
        assigner = _shape_assigner(
            stats, tdx_shapes={("SUB", 0): long_line},
            stop_coords={"MID": (25.00018, 121.5)})
        shape_id = assigner.select("ROUTE_0", "SUB", "ROUTE", 0, ["MID"])
        self.assertEqual(shape_id, "patched_shp_SUB_0")

    def test_inherited_static_shape_used_when_fit(self):
        stats = _full_stats()
        assigner = _shape_assigner(
            stats, route_shapes={"ROUTE_0": "static_fit"},
            static_shapes={"static_fit": patch_gtfs.array(
                "d", [25.0, 121.5, 25.0, 121.52])},
            stop_coords=self.STOP_COORDS)
        shape_id = assigner.select("ROUTE_0", "SUB", "ROUTE", 0, ["S1", "S2"])
        self.assertEqual(shape_id, "static_fit")
        self.assertNotIn(shape_id, assigner.new_shapes)
        self.assertEqual(stats["shape_from_static"], 1)

    def test_route_uid_tdx_shape_used_when_no_subroute_shape(self):
        stats = _full_stats()
        assigner = _shape_assigner(
            stats, tdx_shapes={("ROUTE", 0): self.LINE},
            stop_coords=self.STOP_COORDS)
        shape_id = assigner.select("ROUTE_0", "SUB", "ROUTE", 0, ["S1", "S2"])
        self.assertEqual(shape_id, "patched_shp_ROUTE_0")
        self.assertEqual(stats["shape_from_route_uid"], 1)

    def test_subroutes_sharing_route_id_do_not_overwrite_each_other(self):
        stats = _full_stats()
        assigner = _shape_assigner(
            stats,
            tdx_shapes={("SUB_A", 0): self.LINE,
                        ("SUB_B", 0): [(25.001, 121.5), (25.001, 121.52)]})
        first = assigner.select("SHARED_0", "SUB_A", "ROUTE", 0, ["S1"])
        second = assigner.select("SHARED_0", "SUB_B", "ROUTE", 0, ["S1"])
        self.assertEqual({first, second}, {"patched_shp_SUB_A_0", "patched_shp_SUB_B_0"})
        self.assertEqual(len(assigner.new_shapes), 2)


class MatchAndShapeCountersTests(unittest.TestCase):
    """R7: route-match summary counters reflect every matching branch."""

    def test_all_new_counters_are_populated(self):
        routes = [
            _scheduled_route("ROUTE1", "SUB01", trip_id="sub"),
            _scheduled_route("REX", "NO_SUB", trip_id="route"),
            _scheduled_route("NO_ROUTE", "PFX", trip_id="prefix"),
            _scheduled_route("UNKNOWN", "UNKNOWN_SUB", route_id="BY_NAME",
                             name="Display Name", trip_id="name"),
        ]
        route_ids = {"SUB01_0", "REX_0", "PFX_BRANCH_0", "NAME_0"}
        route_list = [
            {"route_id": "SUB01_0"},
            {"route_id": "REX_0"},
            {"route_id": "PFX_BRANCH_0"},
            {"route_id": "NAME_0", "route_short_name": "Display Name"},
        ]
        stats = _full_stats()
        assigner = _shape_assigner(stats)
        trips, stop_times = [], []
        patch_gtfs.process_schedule_records_to_gtfs(
            routes, trips, stop_times, [], set(), route_list, route_ids, set(),
            stats, {}, assigner, {})
        self.assertEqual(stats["route_match_subroute_exact"], 1)
        self.assertEqual(stats["route_match_route_exact"], 1)
        self.assertEqual(stats["route_match_prefix"], 1)
        self.assertEqual(stats["route_match_name"], 1)


@mock.patch("patch_gtfs.time.sleep", lambda *a, **k: None)
class FetchSourceTests(unittest.TestCase):
    def _run(self, schedule, daily_fetcher, sor_fetcher, shape_fetcher=lambda: []):
        sched, daily, shape, sor = [], [], [], []
        summary = patch_gtfs.fetch_source(
            "t", "City", sched, daily, shape, sor,
            schedule_fetcher=lambda: (schedule, "v3"),
            daily_fetcher=daily_fetcher,
            stop_of_route_fetcher=sor_fetcher,
            shape_fetcher=shape_fetcher,
        )
        return summary, daily

    def test_daily_usable_still_fetches_stoproute(self):
        # StopOfRoute is now always fetched (freq-only subroute stop index), even
        # when the daily timetable is usable and no synthesis fallback runs.
        sor = mock.MagicMock(return_value=[])
        summary, daily = self._run([_origin_only_route()], lambda: ([_usable_route()], "v3"), sor)
        self.assertEqual(summary["daily_source"], "v3")
        self.assertEqual(summary["schedule"], 1)
        sor.assert_called_once()

    def test_daily_unavailable_uses_stoproute(self):
        def daily():
            raise patch_gtfs.DailyTimetableUnavailable("x")
        summary, daily_recs = self._run([_origin_only_route()], daily, lambda: [_sor_route(n_stops=3)])
        self.assertEqual(summary["daily_source"], "stoproute")
        self.assertGreaterEqual(summary["synth_profiles"], 1)
        self.assertGreaterEqual(len(daily_recs), 1)

    def test_stoproute_fatal_propagates(self):
        def daily():
            raise patch_gtfs.DailyTimetableUnavailable("x")

        def sor():
            raise _tdx_http(403)
        with self.assertRaises(patch_gtfs.TdxHttpError):
            self._run([_origin_only_route()], daily, sor)

    def test_frequency_only_skips_daily_still_fetches_stoproute(self):
        daily = mock.MagicMock()
        sor = mock.MagicMock(return_value=[])
        freq_route = {"RouteUID": "F1", "Frequencys": [{"MinHeadwayMins": 10}]}
        summary, _ = self._run([freq_route], daily, sor)
        self.assertEqual(summary["daily_source"], "none")
        daily.assert_not_called()
        sor.assert_called_once()

    def test_empty_schedule_is_fatal_before_any_fetch(self):
        daily, sor, shape = mock.MagicMock(), mock.MagicMock(), mock.MagicMock()
        sched, drecs, shp, sorr = [], [], [], []
        with self.assertRaises(patch_gtfs.TdxFetchError):
            patch_gtfs.fetch_source(
                "t", "Ghost", sched, drecs, shp, sorr,
                schedule_fetcher=lambda: ([], "v2"),
                daily_fetcher=daily, stop_of_route_fetcher=sor, shape_fetcher=shape)
        daily.assert_not_called()
        sor.assert_not_called()
        shape.assert_not_called()


class SynthTests(unittest.TestCase):
    def test_only_ge2_stops_emitted(self):
        out = patch_gtfs._synthesize_from_stop_of_route([_sor_route("A", 2), _sor_route("B", 1)])
        uids = {r["RouteUID"] for r in out}
        self.assertIn("A", uids)
        self.assertNotIn("B", uids)


class NeedsDailyFallbackTests(unittest.TestCase):
    def test_all_full_false(self):
        self.assertFalse(patch_gtfs.needs_daily_fallback([_usable_route()]))

    def test_origin_only_true(self):
        self.assertTrue(patch_gtfs.needs_daily_fallback([_origin_only_route()]))

    def test_frequency_only_false(self):
        self.assertFalse(patch_gtfs.needs_daily_fallback([{"Frequencys": [{"x": 1}]}]))


class GtfsOutputTests(unittest.TestCase):
    """R4/R18: prove degraded profiles actually reach the public GTFS output, and
    that a route lacking a profile is skipped (short_trip) rather than aborting."""

    def _base_stats(self):
        return _full_stats()

    def test_partial_coverage_short_trip_and_trip(self):
        schedule = [_origin_only_route("TEST01"), _origin_only_route("TEST02")]
        daily_profiles = patch_gtfs.build_daily_profiles(
            patch_gtfs._synthesize_from_stop_of_route([_sor_route("TEST01", 3)]))
        new_trips, new_stop_times, stats = [], [], self._base_stats()
        shape_assigner = _shape_assigner(stats)
        patch_gtfs.process_schedule_records_to_gtfs(
            schedule, new_trips, new_stop_times, [], set(),
            [{"route_id": "TEST01_0"}, {"route_id": "TEST02_0"}],
            {"TEST01_0", "TEST02_0"}, set(), stats, daily_profiles,
            shape_assigner, {})
        trip_routes = {t["route_id"] for t in new_trips}
        self.assertIn("TEST01_0", trip_routes)          # had a profile -> trip produced
        self.assertNotIn("TEST02_0", trip_routes)        # no profile -> skipped
        self.assertEqual(stats["short_trip"], 1)
        self.assertGreaterEqual(len(new_stop_times), 2)


class SorSynthFallbackTests(unittest.TestCase):
    """Origin-only timetable buses with no >=2-stop daily profile are rescued via
    the StopOfRoute + Valhalla fallback (Valhalla mocked, no network)."""

    def _process(self, schedule, sor_index, daily_profiles=None,
                 route_ids=("TEST01_0",), profile_ctx=None):
        new_trips, new_stop_times = [], []
        stats = _full_stats()
        ctx = profile_ctx or mock.patch("patch_gtfs.build_travel_profile", side_effect=_FIXED_PROFILE)
        with ctx:
            shape_assigner = _shape_assigner(stats)
            patch_gtfs.process_schedule_records_to_gtfs(
                schedule, new_trips, new_stop_times, [], set(),
                [{"route_id": r} for r in route_ids], set(route_ids), set(), stats,
                daily_profiles or {}, shape_assigner, sor_index)
        return new_trips, new_stop_times, stats

    @staticmethod
    def _times_by_trip(stimes):
        by_trip = {}
        for r in stimes:
            by_trip.setdefault(r["trip_id"], []).append(r["departure_time"])
        return by_trip

    def test_origin_only_no_daily_rescued_by_sor(self):
        sor_index = patch_gtfs.build_stop_of_route_index([_sor_route("TEST01", n_stops=3)])
        trips, stimes, stats = self._process([_origin_only_route("TEST01", dep="06:00")], sor_index)
        self.assertEqual(len(trips), 1)
        self.assertEqual((stats["sor_synth"], stats["short_trip"], stats["synthesized"]), (1, 0, 0))
        rows = [r for r in stimes if r["trip_id"] == trips[0]["trip_id"]]
        self.assertEqual([r["stop_id"] for r in rows], ["S1", "S2", "S3"])
        self.assertEqual([r["stop_sequence"] for r in rows], ["1", "2", "3"])
        times = [r["departure_time"] for r in rows]
        self.assertEqual(times[0], "06:00:00")                  # anchored at origin
        self.assertEqual(times, ["06:00:00", "06:02:00", "06:04:00"])  # profile 0/120/240s
        self.assertTrue(all(times[i] < times[i + 1] for i in range(len(times) - 1)))

    def test_origin_only_no_sor_stays_short_trip(self):
        # <2 resolvable StopOfRoute stops -> not indexed -> genuinely no data.
        sor_index = patch_gtfs.build_stop_of_route_index([_sor_route("TEST01", n_stops=1)])
        self.assertEqual(sor_index, {})
        trips, stimes, stats = self._process([_origin_only_route("TEST01")], sor_index)
        self.assertEqual(trips, [])
        self.assertEqual(stimes, [])
        self.assertEqual((stats["short_trip"], stats["sor_synth"]), (1, 0))

    def test_empty_sor_index_no_crash(self):
        trips, _, stats = self._process([_origin_only_route("TEST01")], {})
        self.assertEqual(trips, [])
        self.assertEqual((stats["short_trip"], stats["sor_synth"]), (1, 0))

    def test_daily_profile_takes_precedence_over_sor(self):
        daily_profiles = patch_gtfs.build_daily_profiles(
            patch_gtfs._synthesize_from_stop_of_route([_sor_route("TEST01", 3)]))
        sor_index = patch_gtfs.build_stop_of_route_index([_sor_route("TEST01", n_stops=3)])
        with mock.patch("patch_gtfs.build_travel_profile", side_effect=_FIXED_PROFILE) as m:
            trips, _, stats = self._process(
                [_origin_only_route("TEST01")], sor_index, daily_profiles=daily_profiles)
        self.assertEqual(len(trips), 1)
        self.assertEqual((stats["synthesized"], stats["sor_synth"]), (1, 0))
        m.assert_not_called()  # daily path took precedence; no StopOfRoute profile built

    def test_profile_cache_computes_once_for_shared_subroute(self):
        route = {
            "RouteUID": "TEST01", "SubRouteUID": "TEST01", "RouteID": "TEST01",
            "RouteName": {"Zh_tw": "TEST01"}, "Direction": 0,
            "Timetables": [
                {"TripID": "t1", "ServiceDay": {"Monday": 1}, "StopTimes": [
                    {"StopUID": "S1", "StopSequence": 1, "ArrivalTime": "06:00", "DepartureTime": "06:00"}]},
                {"TripID": "t2", "ServiceDay": {"Monday": 1}, "StopTimes": [
                    {"StopUID": "S1", "StopSequence": 1, "ArrivalTime": "08:30", "DepartureTime": "08:30"}]},
            ],
        }
        sor_index = patch_gtfs.build_stop_of_route_index([_sor_route("TEST01", n_stops=3)])
        new_trips, stimes, stats = [], [], _full_stats()
        with mock.patch("patch_gtfs.build_travel_profile", side_effect=_FIXED_PROFILE) as mocked:
            shape_assigner = _shape_assigner(stats)
            patch_gtfs.process_schedule_records_to_gtfs(
                [route], new_trips, stimes, [], set(),
                [{"route_id": "TEST01_0"}], {"TEST01_0"}, set(), stats,
                {}, shape_assigner, sor_index)
        trips = new_trips
        self.assertEqual(mocked.call_count, 1)     # one geometry per subroute
        self.assertEqual(stats["sor_synth"], 2)    # both origin-only trips rescued
        by_trip = self._times_by_trip(stimes)
        self.assertEqual(len(by_trip), 2)
        firsts = sorted(t[0] for t in by_trip.values())
        self.assertEqual(firsts, ["06:00:00", "08:30:00"])  # distinct anchors

        def offsets(times):
            base = patch_gtfs.parse_hhmm(times[0][:5])
            return [patch_gtfs.parse_hhmm(t[:5]) - base for t in times]
        offs = [offsets(t) for t in by_trip.values()]
        self.assertEqual(offs[0], offs[1])   # identical relative offsets
        self.assertEqual(offs[0], [0, 2, 4])


class MainExitTests(unittest.TestCase):
    def test_main_does_not_swallow_fatal(self):
        argv = ["patch_gtfs.py", "feed.zip"]
        env = {"TDX_CLIENT_ID": "x", "TDX_CLIENT_SECRET": "y"}
        with mock.patch.object(sys, "argv", argv), \
             mock.patch.dict(os.environ, env, clear=False), \
             mock.patch("patch_gtfs.os.path.exists", return_value=True), \
             mock.patch("patch_gtfs.get_tdx_token", return_value="tok"), \
             mock.patch("patch_gtfs.fetch_source", side_effect=patch_gtfs.TdxFetchError("boom")):
            with self.assertRaises(patch_gtfs.TdxFetchError):
                patch_gtfs.main()

    def test_cli_missing_args_nonzero_exit(self):
        # No production test bypass: use the existing CLI error paths.
        r = subprocess.run([sys.executable, SCRIPT], capture_output=True, env={})
        self.assertNotEqual(r.returncode, 0)


class BuildTravelProfileTests(unittest.TestCase):
    """Chunk/stitch correctness for build_travel_profile with a mocked Valhalla
    leg-time source (constant 60s per consecutive pair)."""

    @staticmethod
    def _legs(seconds=60):
        def fake(locations):
            return [seconds] * (len(locations) - 1)
        return fake

    @staticmethod
    def _coords(n):
        return [(25.0 + i * 0.001, 121.5 + i * 0.001) for i in range(n)]

    def _assert_profile(self, profile, n):
        self.assertEqual(len(profile), n)
        self.assertEqual(profile[0], 0)
        self.assertTrue(all(profile[i] <= profile[i + 1] for i in range(n - 1)))
        # boundary counted exactly once => every step is one 60s leg, total = (n-1)*60
        self.assertEqual(profile[-1], (n - 1) * 60)
        self.assertTrue(all(profile[i + 1] - profile[i] == 60 for i in range(n - 1)))

    def test_single_call_at_limit(self):
        n = patch_gtfs.VALHALLA_MAX_LOCATIONS
        with mock.patch("patch_gtfs._valhalla_route_times", side_effect=self._legs()) as vt:
            profile = patch_gtfs.build_travel_profile(self._coords(n))
        self.assertEqual(vt.call_count, 1)
        self._assert_profile(profile, n)

    def test_two_chunks_limit_plus_one(self):
        n = patch_gtfs.VALHALLA_MAX_LOCATIONS + 1
        with mock.patch("patch_gtfs._valhalla_route_times", side_effect=self._legs()) as vt:
            profile = patch_gtfs.build_travel_profile(self._coords(n))
        self.assertEqual(vt.call_count, 2)
        self._assert_profile(profile, n)

    def test_67_stops(self):
        n = 67
        with mock.patch("patch_gtfs._valhalla_route_times", side_effect=self._legs()) as vt:
            profile = patch_gtfs.build_travel_profile(self._coords(n))
        self.assertEqual(vt.call_count, 2)  # [0:40] + [39:67]
        self._assert_profile(profile, n)

    def test_more_than_two_chunks(self):
        n = 100
        with mock.patch("patch_gtfs._valhalla_route_times", side_effect=self._legs()) as vt:
            profile = patch_gtfs.build_travel_profile(self._coords(n))
        self.assertEqual(vt.call_count, 3)  # [0:40] + [39:79] + [78:100]
        self._assert_profile(profile, n)

    def test_fallback_on_error_counts(self):
        counter = [0]
        with mock.patch("patch_gtfs._valhalla_route_times", side_effect=RuntimeError("down")):
            profile = patch_gtfs.build_travel_profile(self._coords(5), counter)
        self.assertEqual(profile, [0, 120, 240, 360, 480])  # 2-min/stop fallback
        self.assertEqual(counter[0], 1)


_FIXED_PROFILE = lambda coords, fc=None: [i * 120 for i in range(len(coords))]


class FrequencyTripGenerationTests(unittest.TestCase):
    def _process(self, schedule, sor_index, route_ids=("FREQ01_0",), profile_ctx=None):
        new_trips, new_stop_times, new_freqs = [], [], []
        patterns = set()
        stats = _full_stats()
        ctx = profile_ctx or mock.patch("patch_gtfs.build_travel_profile", side_effect=_FIXED_PROFILE)
        with ctx:
            shape_assigner = _shape_assigner(stats)
            patch_gtfs.process_schedule_records_to_gtfs(
                schedule, new_trips, new_stop_times, new_freqs, set(),
                [{"route_id": r} for r in route_ids], set(route_ids), patterns, stats,
                {}, shape_assigner, sor_index)
        return new_trips, new_stop_times, new_freqs, patterns, stats

    def test_basic_frequency_trip_and_window(self):
        sor_index = patch_gtfs.build_stop_of_route_index([_sor_route("FREQ01", n_stops=4)])
        trips, stimes, freqs, patterns, stats = self._process([_freq_route("FREQ01")], sor_index)
        self.assertEqual(len(trips), 1)
        trip_id = trips[0]["trip_id"]
        self.assertTrue(trip_id.startswith("freqpatched_FREQ01_0_"))
        self.assertEqual(trips[0]["service_id"], patch_gtfs.service_id_for_pattern((1, 1, 1, 1, 1, 0, 0)))
        rows = [r for r in stimes if r["trip_id"] == trip_id]
        self.assertEqual(len(rows), 4)
        times = [r["departure_time"] for r in rows]
        self.assertTrue(all(times[i] < times[i + 1] for i in range(len(times) - 1)))
        self.assertEqual(times[0], "05:00:00")
        self.assertEqual(len(freqs), 1)
        self.assertEqual(freqs[0]["headway_secs"], round((15 + 20) / 2 * 60))
        self.assertEqual(freqs[0]["start_time"], "05:00:00")
        self.assertEqual(freqs[0]["end_time"], "22:00:00")
        self.assertEqual(freqs[0]["exact_times"], "0")
        self.assertIn((1, 1, 1, 1, 1, 0, 0), patterns)
        self.assertEqual((stats["freq_trips"], stats["freq_windows"]), (1, 1))

    def test_valhalla_fallback_still_plannable(self):
        sor_index = patch_gtfs.build_stop_of_route_index([_sor_route("FREQ01", n_stops=3)])
        ctx = mock.patch("patch_gtfs._valhalla_route_times", side_effect=RuntimeError("down"))
        trips, stimes, freqs, patterns, stats = self._process(
            [_freq_route("FREQ01")], sor_index, profile_ctx=ctx)
        self.assertEqual(len(trips), 1)
        self.assertEqual(stats["freq_valhalla_fail"], 1)
        rows = [r for r in stimes if r["trip_id"] == trips[0]["trip_id"]]
        self.assertEqual([r["departure_time"] for r in rows],
                         ["05:00:00", "05:02:00", "05:04:00"])

    def test_no_stoproute_skipped_counted(self):
        trips, stimes, freqs, patterns, stats = self._process([_freq_route("FREQ01")], {})
        self.assertEqual(trips, [])
        self.assertEqual(freqs, [])
        self.assertEqual(stats["freq_no_stops"], 1)

    def test_under_two_stops_not_indexed_and_skipped(self):
        sor_index = patch_gtfs.build_stop_of_route_index([_sor_route("FREQ01", n_stops=1)])
        self.assertEqual(sor_index, {})  # <2 resolvable stops are never indexed
        trips, _, freqs, _, stats = self._process([_freq_route("FREQ01")], sor_index)
        self.assertEqual(trips, [])
        self.assertEqual(stats["freq_no_stops"], 1)

    def test_fixed_and_frequency_both_survive_same_pattern(self):
        route = {
            "RouteUID": "MIX01", "SubRouteUID": "MIX01", "RouteID": "MIX01",
            "RouteName": {"Zh_tw": "MIX01"}, "Direction": 0,
            "Timetables": [
                {"TripID": "t-0600", "ServiceDay": {"Monday": 1}, "StopTimes": [
                    {"StopUID": "S1", "StopSequence": 1, "ArrivalTime": "06:00", "DepartureTime": "06:00"},
                    {"StopUID": "S2", "StopSequence": 2, "ArrivalTime": "06:10", "DepartureTime": "06:10"}]},
                {"TripID": "t-0700", "ServiceDay": {"Monday": 1}, "StopTimes": [
                    {"StopUID": "S1", "StopSequence": 1, "ArrivalTime": "07:00", "DepartureTime": "07:00"},
                    {"StopUID": "S2", "StopSequence": 2, "ArrivalTime": "07:10", "DepartureTime": "07:10"}]},
            ],
            "Frequencys": [
                {"StartTime": "16:00", "EndTime": "22:00", "MinHeadwayMins": 15,
                 "MaxHeadwayMins": 15, "ServiceDay": {"Monday": 1}}],
        }
        sor_index = patch_gtfs.build_stop_of_route_index([_sor_route("MIX01", n_stops=2)])
        trips, _, freqs, _, _ = self._process([route], sor_index, route_ids=("MIX01_0",))
        fixed = [t for t in trips if t["trip_id"].startswith("patched_")]
        freq = [t for t in trips if t["trip_id"].startswith("freqpatched_")]
        self.assertEqual(len(fixed), 2)   # both fixed trips kept
        self.assertEqual(len(freq), 1)    # frequency template also emitted
        self.assertEqual(len(freqs), 1)   # window NOT dropped for sharing the pattern
        self.assertEqual((freqs[0]["start_time"], freqs[0]["end_time"]), ("16:00:00", "22:00:00"))

    def test_overlapping_frequency_windows_merged(self):
        route = _freq_route("FREQ01", windows=[
            {"StartTime": "06:00", "EndTime": "10:00", "MinHeadwayMins": 10, "MaxHeadwayMins": 10},
            {"StartTime": "09:00", "EndTime": "12:00", "MinHeadwayMins": 20, "MaxHeadwayMins": 20},
        ], service_day={"Monday": 1})
        sor_index = patch_gtfs.build_stop_of_route_index([_sor_route("FREQ01", n_stops=2)])
        _, _, freqs, _, _ = self._process([route], sor_index)
        self.assertEqual(len(freqs), 1)  # overlap merged within one trip_id
        self.assertEqual((freqs[0]["start_time"], freqs[0]["end_time"]), ("06:00:00", "12:00:00"))

    def test_disjoint_frequency_windows_both_kept(self):
        route = _freq_route("FREQ01", windows=[
            {"StartTime": "06:00", "EndTime": "09:00", "MinHeadwayMins": 10, "MaxHeadwayMins": 10},
            {"StartTime": "16:00", "EndTime": "20:00", "MinHeadwayMins": 20, "MaxHeadwayMins": 20},
        ], service_day={"Monday": 1})
        sor_index = patch_gtfs.build_stop_of_route_index([_sor_route("FREQ01", n_stops=2)])
        _, _, freqs, _, _ = self._process([route], sor_index)
        self.assertEqual(len(freqs), 2)  # disjoint windows both survive on one trip


class FrequencyZipEmissionTests(unittest.TestCase):
    def _run_patch(self, with_frequencies, with_stops=True, tdx_shapes=None):
        tmpdir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmpdir, ignore_errors=True)
        zip_path = os.path.join(tmpdir, "feed.zip")
        _write_fixture_zip(
            zip_path, with_frequencies=with_frequencies, with_stops=with_stops)
        with mock.patch("patch_gtfs.build_travel_profile", side_effect=_FIXED_PROFILE):
            patch_gtfs.patch_gtfs_zip(
                zip_path,
                schedule_records=[_freq_route("FREQ01")],
                daily_records=[],
                tdx_shapes=tdx_shapes or {},
                sor_records=[_sor_route("FREQ01", n_stops=3)],
                start_date=datetime.date(2026, 7, 20),
            )
        return zip_path

    @staticmethod
    def _read(zip_path, name):
        with zipfile.ZipFile(zip_path, "r") as z:
            with z.open(name) as f:
                return list(csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig")))

    def test_emits_frequencies_when_input_has_none(self):
        zip_path = self._run_patch(with_frequencies=False)
        rows = self._read(zip_path, "frequencies.txt")
        bus = [r for r in rows if r["trip_id"].startswith("freqpatched_FREQ01_0_")]
        self.assertEqual(len(bus), 1)
        self.assertEqual(bus[0]["start_time"], "05:00:00")
        self.assertEqual(bus[0]["end_time"], "22:00:00")
        self.assertEqual(bus[0]["headway_secs"], str(round((15 + 20) / 2 * 60)))
        self.assertEqual(bus[0]["exact_times"], "0")

        trips = self._read(zip_path, "trips.txt")
        tids = {t["trip_id"] for t in trips}
        freq_trip = next((t for t in tids if t.startswith("freqpatched_FREQ01_0_")), None)
        self.assertIsNotNone(freq_trip)
        self.assertIn("mtrip1", tids)      # non-bus preserved
        self.assertNotIn("oldbus", tids)   # old bus trip deleted

        st = self._read(zip_path, "stop_times.txt")
        self.assertEqual(len([r for r in st if r["trip_id"] == freq_trip]), 3)

        cal = self._read(zip_path, "calendar.txt")
        svc_ids = {c["service_id"] for c in cal}
        self.assertIn(patch_gtfs.service_id_for_pattern((1, 1, 1, 1, 1, 0, 0)), svc_ids)

    def test_preserves_upstream_frequencies_and_appends_bus(self):
        zip_path = self._run_patch(with_frequencies=True)
        rows = self._read(zip_path, "frequencies.txt")
        tids = [r["trip_id"] for r in rows]
        self.assertIn("mtrip1", tids)  # upstream metro row preserved
        self.assertTrue(any(t.startswith("freqpatched_FREQ01_0_") for t in tids))  # bus appended

    def test_missing_stops_file_does_not_crash_or_reject_shape(self):
        line = [(25.001, 121.501), (25.003, 121.503)]
        zip_path = self._run_patch(
            with_frequencies=False, with_stops=False,
            tdx_shapes={("FREQ01", 0): line})
        trips = self._read(zip_path, "trips.txt")
        trip = next(row for row in trips if row["trip_id"].startswith("freqpatched_"))
        self.assertEqual(trip["shape_id"], "patched_shp_FREQ01_0")
        shapes = self._read(zip_path, "shapes.txt")
        self.assertEqual(len([row for row in shapes
                              if row["shape_id"] == trip["shape_id"]]), 2)


class BusShapeGeometryZipTests(unittest.TestCase):
    """R1/R3/R4/R6: realistic 61-series output keeps trip and shape aligned."""

    def test_hsq_main_subroute_trip_uses_its_own_shape(self):
        tmpdir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmpdir, ignore_errors=True)
        zip_path = os.path.join(tmpdir, "hsq-feed.zip")
        files = {
            "routes.txt": (
                "route_id,route_type\n"
                "HSQ008101_0,3\nHSQ0081A1_0,3\nHSQ0081B1_0,3\nM1,1\n"),
            "trips.txt": (
                "route_id,service_id,trip_id,direction_id,shape_id\n"
                "HSQ0081B1_0,old,oldbus,0,old_branch\n"
                "M1,metro,mtrip,0,mshape\n"),
            "stop_times.txt": (
                "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n"
                "oldbus,06:00:00,06:00:00,S1,1\n"
                "mtrip,07:00:00,07:00:00,M1,1\n"),
            "stops.txt": (
                "stop_id,stop_name,stop_lat,stop_lon\n"
                "S1,Main 1,24.8000,121.0000\n"
                "S2,Main 2,24.8000,121.0100\n"
                "M1,Metro,25.0000,121.5000\n"),
            "shapes.txt": (
                "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n"
                "old_branch,24.8100,121.0000,1\n"
                "old_branch,24.8100,121.0100,2\n"
                "mshape,25.0000,121.5000,1\n"
                "mshape,25.0100,121.5100,2\n"),
            "calendar.txt": (
                "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n"
                "metro,1,1,1,1,1,0,0,20260101,20261231\n"),
            "calendar_dates.txt": "service_id,date,exception_type\n",
        }
        with zipfile.ZipFile(zip_path, "w") as archive:
            for name, content in files.items():
                archive.writestr(name, content)

        tdx_shapes = patch_gtfs.build_shape_index([
            {"RouteUID": "HSQ0081", "SubRouteUID": "HSQ008101", "Direction": 0,
             "Geometry": "LINESTRING (121.0000 24.8000, 121.0100 24.8000)"},
            {"RouteUID": "HSQ0081", "SubRouteUID": "HSQ0081B1", "Direction": 0,
             "Geometry": "LINESTRING (121.0000 24.8100, 121.0100 24.8100)"},
        ])
        patch_gtfs.patch_gtfs_zip(
            zip_path,
            schedule_records=[
                _scheduled_route(
                    "HSQ0081", "HSQ008101", trip_id="0909_1",
                    stop_ids=("S1", "S2"))],
            daily_records=[],
            tdx_shapes=tdx_shapes,
            sor_records=[],
            start_date=datetime.date(2026, 7, 20),
        )

        with zipfile.ZipFile(zip_path, "r") as archive:
            trips = list(csv.DictReader(io.TextIOWrapper(
                archive.open("trips.txt"), encoding="utf-8-sig")))
            shapes = list(csv.DictReader(io.TextIOWrapper(
                archive.open("shapes.txt"), encoding="utf-8-sig")))
            stop_times = list(csv.DictReader(io.TextIOWrapper(
                archive.open("stop_times.txt"), encoding="utf-8-sig")))

        trip = next(row for row in trips if row["trip_id"].endswith("_0909_1"))
        self.assertEqual(trip["route_id"], "HSQ008101_0")
        self.assertEqual(trip["shape_id"], "patched_shp_HSQ008101_0")
        shape_rows = [row for row in shapes if row["shape_id"] == trip["shape_id"]]
        self.assertEqual(
            [(row["shape_pt_lat"], row["shape_pt_lon"]) for row in shape_rows],
            [("24.8", "121.0"), ("24.8", "121.01")])
        trip_stops = [row["stop_id"] for row in stop_times
                      if row["trip_id"] == trip["trip_id"]]
        self.assertEqual(trip_stops, ["S1", "S2"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
