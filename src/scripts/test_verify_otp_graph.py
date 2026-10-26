#!/usr/bin/env python3
"""Offline acceptance checks for transport promotion gates and diagnostics."""
import contextlib
import importlib.util
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import zipfile

SCRIPT = Path(__file__).with_name("verify-otp-graph.py")
spec = importlib.util.spec_from_file_location("verify_otp_graph", SCRIPT)
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)


def build_feed(path, *, wrong_branch=False, missing_shape=False, missing_stop=False):
    # Same endpoints, different intermediate stop: the coastal shape is valid
    # for one train but not the train taking the mountain branch.
    middle_lon = 121.1 if wrong_branch else 121.0
    files = {
        "trips.txt": "trip_id,route_id,shape_id\nTRA_2005,TRA_R,TRA_SHARED\n"
                     "TRA_2005_NEXT_DAY,TRA_R,TRA_SHARED\nTRA_COAST,TRA_R,TRA_SHARED\n",
        "stops.txt": "stop_id,stop_lon,stop_lat\nTRA_A,121,24\nTRA_C,121,24.2\n"
                     f"TRA_B,{middle_lon},24.1\nTRA_COAST_B,121,24.1\n",
        "stop_times.txt": "trip_id,stop_id,stop_sequence\n"
                          "TRA_2005,TRA_A,1\nTRA_2005,TRA_B,2\nTRA_2005,TRA_C,3\n"
                          "TRA_2005_NEXT_DAY,TRA_A,1\nTRA_2005_NEXT_DAY,TRA_B,2\n"
                          "TRA_2005_NEXT_DAY,TRA_C,3\n"
                          "TRA_COAST,TRA_A,1\nTRA_COAST,TRA_COAST_B,2\nTRA_COAST,TRA_C,3\n",
        "shapes.txt": "shape_id,shape_pt_lon,shape_pt_lat,shape_pt_sequence\n"
                      "TRA_SHARED,121,24,1\nTRA_SHARED,121,24.2,2\n",
    }
    if missing_shape:
        del files["shapes.txt"]
    if missing_stop:
        files["stops.txt"] = files["stops.txt"].replace(f"TRA_B,{middle_lon},24.1\n", "")
    with zipfile.ZipFile(path, "w") as zf:
        for name, body in files.items():
            zf.writestr(name, body)


class VerifyTraShapeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.feed = Path(self.tmp.name) / "feed.zip"

    def run_cli(self, *args):
        return subprocess.run(
            [sys.executable, str(SCRIPT), *args], capture_output=True, text=True,
            timeout=10, env={**os.environ, "OTP_VERIFY_SKIP_AUDIT": "1"},
        )

    def test_feed_only_passes_good_geometry_without_otp(self):
        build_feed(self.feed)
        result = self.run_cli("--feed", str(self.feed), "--feed-only", "--otp", "invalid://no-network")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("0/2 TRA patterns", result.stdout)
        self.assertIn("RESULT PASS", result.stdout)
        self.assertNotIn("ready:", result.stdout)

    def test_wrong_branch_fails_even_with_shared_endpoints_and_skip_audit(self):
        build_feed(self.feed, wrong_branch=True)
        result = self.run_cli("--feed", str(self.feed), "--feed-only")
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("1/2 TRA patterns", result.stdout)
        self.assertIn("trip=TRA_2005 stop=TRA_B", result.stdout)
        self.assertIn("(2 trips)", result.stdout)
        self.assertIn("RESULT FAIL", result.stdout)

    def test_missing_shape_and_stop_fail(self):
        for options in ({"missing_shape": True}, {"missing_stop": True}):
            with self.subTest(options=options):
                build_feed(self.feed, **options)
                result = self.run_cli("--feed", str(self.feed), "--feed-only")
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                self.assertIn("distance=inf", result.stdout)

    def test_feed_only_requires_feed(self):
        result = self.run_cli("--feed-only")
        self.assertEqual(result.returncode, 2)
        self.assertIn("--feed-only requires --feed", result.stderr)

    def test_unreadable_feed_fails_with_gate_diagnostic(self):
        result = self.run_cli("--feed", str(self.feed), "--feed-only")
        self.assertEqual(result.returncode, 1)
        self.assertIn("FAIL tra-shape: cannot validate", result.stdout)

    def test_live_gate_cannot_skip_shape_check_when_skipping_service_audit(self):
        build_feed(self.feed, wrong_branch=True)
        output = io.StringIO()
        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.object(sys, "argv", [str(SCRIPT), "--feed", str(self.feed),
                                                               "--baseline", "unused.zip"]))
            stack.enter_context(mock.patch.dict(os.environ, {"OTP_VERIFY_SKIP_AUDIT": "1"}))
            stack.enter_context(mock.patch.object(verify, "wait_ready", return_value=["1"]))
            for name in ("check_geometry", "check_bus_coverage", "check_freshness", "check_trips"):
                stack.enter_context(mock.patch.object(verify, name))
            audit = stack.enter_context(mock.patch.object(verify, "check_audit"))
            stack.enter_context(contextlib.redirect_stdout(output))
            self.assertEqual(verify.main(), 1)
            audit.assert_not_called()
        self.assertIn("FAIL tra-shape", output.getvalue())
        self.assertIn("audit: skipped", output.getvalue())


class VerifyTripDiagnosticsTest(unittest.TestCase):
    CASE = ("fixture rail", (25.0, 121.0), (25.1, 121.1), "false", {"RAIL"}, "TRA", ("RAIL", 10))
    ERROR = {"code": "NO_STOPS_IN_RANGE", "inputField": "TO_PLACE",
             "description": "終點附近沒有可達車站"}

    def probe(self, legs, errors=()):
        return mock.Mock(
            MODES="WALK,BUS,TROLLEYBUS,RAIL,SUBWAY,TRAM,MONORAIL",
            post=mock.Mock(return_value={"data": {"plan": {
                "routingErrors": list(errors), "itineraries": [{"legs": legs}] if legs else [],
            }}}),
        )

    def check(self, probe):
        gate = verify.Gate()
        with mock.patch.object(verify, "TRIP_CASES", [self.CASE]), contextlib.redirect_stdout(io.StringIO()):
            verify.check_trips(gate, probe, "http://unused", "2026-10-26", "10:00", 120)
        return gate

    def test_plan_legs_preserves_its_list_result_and_existing_request_modes(self):
        legs = [{"mode": "WALK"}, {"mode": "RAIL"}]
        probe = self.probe(legs, [self.ERROR])
        result = verify.plan_legs(probe, "http://unused", (25.0, 121.0), (25.1, 121.1),
                                  "false", "2026-10-26", "10:00", 120)
        self.assertEqual(result, legs)
        query = probe.post.call_args.args[1]
        self.assertIn("routingErrors{ code inputField description }", query)
        for mode in probe.MODES.split(","):
            self.assertIn("{mode:" + mode + "}", query)
        self.assertIn("wheelchair:false, walkSpeed:1.3", query)

    def test_missing_itinerary_reports_all_routing_error_fields_and_endpoints(self):
        errors = [self.ERROR, {**self.ERROR, "inputField": "FROM_PLACE"}]
        gate = self.check(self.probe([], errors))
        self.assertEqual(len(gate.failures), 1)
        for value in ("modes=[]", "no RAIL leg", "NO_STOPS_IN_RANGE", "TO_PLACE", "FROM_PLACE",
                      self.ERROR["description"]):
            self.assertIn(value, gate.failures[0])

    def test_wrong_agency_or_straight_geometry_still_fails_with_diagnostics(self):
        for agency, length, expected in (("OTHER", 20, "no TRA leg"),
                                         ("TRA", 2, "RAIL legs drawn straight")):
            with self.subTest(agency=agency, length=length):
                leg = {"mode": "RAIL", "route": {"agency": {"gtfsId": "1:" + agency}},
                       "legGeometry": {"length": length}}
                gate = self.check(self.probe([leg], [self.ERROR]))
                self.assertEqual(len(gate.failures), 1)
                self.assertIn(expected, gate.failures[0])
                self.assertIn("NO_STOPS_IN_RANGE", gate.failures[0])

    def test_routing_warnings_do_not_change_a_passing_gate(self):
        leg = {"mode": "RAIL", "route": {"agency": {"gtfsId": "1:TRA"}},
               "legGeometry": {"length": 20}}
        self.assertEqual(self.check(self.probe([leg], [self.ERROR])).failures, [])

    def test_missing_routing_errors_keeps_existing_failure_behavior(self):
        probe = self.probe([])
        del probe.post.return_value["data"]["plan"]["routingErrors"]
        gate = self.check(probe)
        self.assertIn("no RAIL leg", gate.failures[0])
        self.assertIn("routingErrors=[]", gate.failures[0])

    def test_graphql_request_error_remains_a_failure(self):
        probe = self.probe([])
        probe.post.return_value = {"errors": [{"message": "query rejected"}]}
        self.assertIn("request failed: query rejected", self.check(probe).failures[0])


class PromotionVerificationLogTest(unittest.TestCase):
    def test_logs_keep_both_streams_and_pipeline_failures_block_promotion(self):
        script = SCRIPT.with_name("promote-otp-graph.sh").read_text()
        block = script[script.index('VERIFY_RUN_ID='):script.index('docker rm -f "$CANDIDATE_NAME" >/dev/null\nCANDIDATE_CREATED=0')]
        setup = r'''
set -euo pipefail
SCRIPT_DIR=unused
RELEASE_DIR=unused
OTP_CANDIDATE_PORT=18081
CANDIDATE_NAME=unused
verify_args=()
log() { printf '%s\n' "$*"; }
die() { printf 'FATAL: %s\n' "$*"; exit 1; }
python3() { printf 'transport stdout\n'; printf 'transport stderr\n' >&2; return "$TRANSPORT_STATUS"; }
pnpm() { printf 'native stdout\n'; printf 'native stderr\n' >&2; return "$NATIVE_STATUS"; }
docker() { return 0; }
tee() { command tee "$@"; return "$TEE_STATUS"; }
'''
        for transport_status, native_status, tee_status in ((0, 0, 0), (7, 0, 0), (0, 8, 0), (0, 0, 9)):
            with self.subTest(transport=transport_status, native=native_status, tee=tee_status), tempfile.TemporaryDirectory() as tmp:
                result = subprocess.run(
                    ["bash", "-c", setup + block + "\nprintf 'VERIFIED\\n'\n"],
                    capture_output=True, text=True, timeout=10,
                    env={**os.environ, "EVIDENCE": tmp, "TRANSPORT_STATUS": str(transport_status),
                         "NATIVE_STATUS": str(native_status), "TEE_STATUS": str(tee_status)},
                )
                should_pass = transport_status == native_status == tee_status == 0
                self.assertEqual(result.returncode, 0 if should_pass else 1, result.stdout + result.stderr)
                self.assertEqual("VERIFIED" in result.stdout, should_pass)
                logs = list(Path(tmp).glob("transport-verification-*.log"))
                self.assertEqual(len(logs), 1)
                self.assertEqual(logs[0].read_text(), "transport stdout\ntransport stderr\n")
                native_logs = list(Path(tmp).glob("native-verification-*.log"))
                self.assertEqual(len(native_logs), int(transport_status == tee_status == 0))
                if native_logs:
                    self.assertEqual(native_logs[0].read_text(), "native stdout\nnative stderr\n")
                if not should_pass:
                    self.assertIn("previous release pointer retained; see " + tmp, result.stdout)


if __name__ == "__main__":
    unittest.main()
