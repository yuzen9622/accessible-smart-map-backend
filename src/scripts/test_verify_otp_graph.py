#!/usr/bin/env python3
"""Offline acceptance checks for the TRA geometry promotion gate."""
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


if __name__ == "__main__":
    unittest.main()
