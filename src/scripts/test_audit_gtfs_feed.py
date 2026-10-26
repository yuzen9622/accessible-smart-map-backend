#!/usr/bin/env python3
"""Offline regressions for the GTFS service audit and its promotion caller."""
import contextlib
import csv
from datetime import date
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile


def load_script(name):
    path = Path(__file__).with_name(name)
    spec = importlib.util.spec_from_file_location(path.stem, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


audit = load_script("audit-gtfs-feed.py")
verify = load_script("verify-otp-graph.py")
DAY = date(2026, 10, 26)


def write_feed(path, routes, *, trip_prefix=""):
    """Write the GTFS tables audited here; routes are (id, type, agency, trips)."""
    tables = {
        "routes.txt": (
            ["route_id", "route_type", "agency_id"],
            [(rid, rtype, agency) for rid, rtype, agency, _ in routes],
        ),
        "trips.txt": (
            ["route_id", "service_id", "trip_id"],
            [(rid, "daily", f"{trip_prefix}{rid}_{i}")
             for rid, _, _, count in routes for i in range(count)],
        ),
        "calendar.txt": (
            ["service_id", "start_date", "end_date"],
            [("daily", "20260101", "20261231")],
        ),
        "stops.txt": (
            ["stop_id", "stop_name", "stop_lat", "stop_lon", "wheelchair_boarding"],
            [("A", "A", "25.0", "121.0", "1"), ("B", "B", "25.1", "121.1", "1")],
        ),
        "pathways.txt": (["pathway_id"], [("P1",)]),
        "levels.txt": (["level_id"], [("L1",)]),
        "frequencies.txt": (["trip_id"], []),
    }
    with zipfile.ZipFile(path, "w") as zf:
        for name, (headers, rows) in tables.items():
            contents = io.StringIO()
            writer = csv.writer(contents)
            writer.writerow(headers)
            writer.writerows(rows)
            zf.writestr(name, contents.getvalue())


class AuditGtfsFeedTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.old = self.root / "old.zip"
        self.new = self.root / "new.zip"

    def metrics(self, path):
        return audit.measure(path, DAY)

    def compare_feeds(self):
        return audit.compare(self.metrics(self.new), self.metrics(self.old), audit.DEFAULT_TOLERANCE)

    def run_cli(self, *args):
        return subprocess.run(
            [sys.executable, "-B", str(Path(audit.__file__)), str(self.new),
             "--date", DAY.isoformat(), *map(str, args)],
            capture_output=True, text=True, timeout=15,
        )

    def test_only_air_types_are_removed_from_non_bus_counters(self):
        for rtype in ("1100", "1102", "1199", "1099", "1200", "0", "1", "2", "12", "4"):
            with self.subTest(route_type=rtype):
                write_feed(self.new, [("R1", rtype, "ANY_AGENCY", 12)])
                metrics = self.metrics(self.new)
                aviation = rtype in {"1100", "1102", "1199"}
                self.assertEqual(metrics["rail_trips"], {} if aviation else {"ANY_AGENCY": 12})
                self.assertEqual(metrics["rail_routes_live"], {} if aviation else {"ANY_AGENCY": 1})
                self.assertEqual(metrics["total_trips"], 12)
                self.assertEqual(metrics["backfill"], {"upstream": 12})
                self.assertEqual(metrics["active_services"], 1)

    def test_mixed_agency_keeps_rail_and_does_not_filter_agency_names(self):
        write_feed(self.new, [("R1", "2", "MIXED", 40), ("A1", "1102", "MIXED", 60),
                              ("R2", "2", "AirLine_B7", 20)])
        metrics = self.metrics(self.new)
        self.assertEqual(metrics["rail_trips"], {"MIXED": 40, "AirLine_B7": 20})
        self.assertEqual(metrics["rail_routes_live"], {"MIXED": 1, "AirLine_B7": 1})

    def test_airline_drop_or_removal_is_not_a_rail_regression(self):
        stable = [("TPE001", "3", "BUS", 5000)]
        write_feed(self.old, stable + [("A1", "1102", "AirLine_B7", 924)])
        for remaining in (678, 0):
            with self.subTest(remaining=remaining):
                routes = stable + ([("A1", "1102", "AirLine_B7", remaining)] if remaining else [])
                write_feed(self.new, routes)
                self.assertEqual(self.compare_feeds(), [])
                result = self.run_cli("--baseline", self.old)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn("PASS — no dimension regressed", result.stdout)

    def test_rail_and_metro_drops_still_fail_at_the_original_threshold(self):
        stable = [("TPE001", "3", "BUS", 1000)]
        for agency, rtype in (("TRA", "2"), ("THSR", "101"), ("TRTC", "1"),
                              ("KRTC", "1"), ("NTMC", "0"), ("TYMC", "1"), ("MONO", "12")):
            with self.subTest(agency=agency):
                write_feed(self.old, stable + [("R1", rtype, agency, 100)])
                write_feed(self.new, stable + [("R1", rtype, agency, 80)])
                self.assertEqual(self.compare_feeds(), [])
                write_feed(self.new, stable + [("R1", rtype, agency, 79)])
                self.assertIn(f"trips [{agency}]: 100 -> 79 (-21%)", self.compare_feeds())
                result = self.run_cli("--baseline", self.old)
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)

    def test_airline_growth_cannot_hide_mixed_agency_rail_loss(self):
        write_feed(self.old, [("R1", "2", "MIXED", 100), ("A1", "1102", "MIXED", 100)])
        write_feed(self.new, [("R1", "2", "MIXED", 70), ("A1", "1102", "MIXED", 130)])
        self.assertEqual(self.compare_feeds(), ["trips [MIXED]: 100 -> 70 (-30%)"])

    def test_small_rail_operator_disappearance_still_fails(self):
        stable = [("TPE001", "3", "BUS", 1000)]
        write_feed(self.old, stable + [("R1", "2", "SMALL", 3)])
        write_feed(self.new, stable)
        self.assertIn("trips [SMALL]: 3 -> 0 (vanished)", self.compare_feeds())

    def test_bus_coverage_and_usable_service_drops_still_fail(self):
        stable = [("R1", "2", "TRA", 1000)]
        buses = [(f"TPE{i:03}", "3", "BUS", 6) for i in range(10)]
        write_feed(self.old, stable + buses)
        for count in (0, 1):
            with self.subTest(trips_per_degraded_route=count):
                degraded = [(rid, rtype, agency, 6 if i < 7 else count)
                            for i, (rid, rtype, agency, _) in enumerate(buses)]
                write_feed(self.new, stable + degraded)
                failures = self.compare_feeds()
                self.assertIn("bus usable [TPE]: 10 -> 7 (-30%)", failures)
                if count == 0:
                    self.assertIn("bus with service [TPE]: 10 -> 7 (-30%)", failures)

    def test_existing_total_and_backfill_checks_are_preserved(self):
        for prefix, channel in (("", "upstream"), ("patched_", "tdx_timetable"),
                                ("freqpatched_", "frequency_template")):
            with self.subTest(channel=channel):
                write_feed(self.old, [("R1", "2", "TRA", 100)], trip_prefix=prefix)
                write_feed(self.new, [("R1", "2", "TRA", 70)], trip_prefix=prefix)
                failures = self.compare_feeds()
                self.assertIn("total trips: 100 -> 70 (-30%)", failures)
                self.assertIn(f"backfill channel [{channel}]: 100 -> 70 (-30%)", failures)

    def test_aviation_is_still_in_existing_feed_wide_integrity_checks(self):
        write_feed(self.old, [("A1", "1102", "AIR", 100)])
        write_feed(self.new, [("A1", "1102", "AIR", 70)])
        failures = self.compare_feeds()
        self.assertIn("total trips: 100 -> 70 (-30%)", failures)
        self.assertFalse(any("trips [AIR]" in failure for failure in failures))

    def test_calendar_stops_pathways_and_levels_checks_are_preserved(self):
        write_feed(self.old, [("R1", "2", "TRA", 100)])
        old = self.metrics(self.old)
        for field, label in (("active_services", "services active today"),
                             ("stop_places", "stop places"), ("pathways", "pathways"),
                             ("levels", "levels")):
            with self.subTest(field=field):
                new = {**old, field: 0}
                self.assertIn(f"{label}: {old[field]} -> 0 (vanished)",
                              audit.compare(new, old, audit.DEFAULT_TOLERANCE))

    def test_json_export_can_be_used_as_baseline(self):
        write_feed(self.new, [("R1", "2", "TRA", 100), ("A1", "1102", "AIR", 10)])
        baseline = self.root / "baseline.json"
        result = self.run_cli("--json", baseline)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        exported = json.loads(baseline.read_text())
        self.assertEqual(exported["metrics_version"], audit.METRICS_VERSION)
        self.assertNotIn("AIR", exported["rail_trips"])
        result = self.run_cli("--baseline", baseline)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_legacy_or_unknown_json_baseline_fails_with_recovery_instructions(self):
        write_feed(self.new, [("R1", "2", "TRA", 100)])
        baseline = self.root / "baseline.json"
        for version in (None, 1, 999):
            with self.subTest(version=version):
                metrics = self.metrics(self.new)
                if version is None:
                    del metrics["metrics_version"]
                else:
                    metrics["metrics_version"] = version
                baseline.write_text(json.dumps(metrics))
                result = self.run_cli("--baseline", baseline)
                self.assertEqual(result.returncode, 2)
                self.assertIn("original GTFS ZIP", result.stderr)
                self.assertNotIn("Traceback", result.stderr)
                self.assertNotIn("PASS", result.stdout)

    def test_promotion_audit_uses_real_cli_and_preserves_failure(self):
        stable = [("TPE001", "3", "BUS", 5000)]
        write_feed(self.old, stable + [("R1", "2", "TRA", 100), ("A1", "1102", "AIR", 924)])
        for rail_count, should_pass in ((100, True), (70, False)):
            with self.subTest(rail_count=rail_count):
                write_feed(self.new, stable + [("R1", "2", "TRA", rail_count),
                                               ("A1", "1102", "AIR", 678)])
                gate = verify.Gate()
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    verify.check_audit(gate, str(self.new), str(self.old))
                self.assertEqual(not gate.failures, should_pass, output.getvalue())
                if not should_pass:
                    self.assertIn("trips [TRA]", output.getvalue())


if __name__ == "__main__":
    unittest.main()
