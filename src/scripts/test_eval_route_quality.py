#!/usr/bin/env python3
"""Offline regression tests for route-evaluation reference identity and recall."""
import contextlib
import copy
import importlib.util
import io
import json
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, date
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

SCRIPT = Path(__file__).with_name("eval-route-quality.py")
spec = importlib.util.spec_from_file_location("eval_route_quality", SCRIPT)
evaluation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evaluation)


def outcome(ok=True):
    checks = [{"constraint": [], "geometry": [], "boarding": [], "timing": [],
               "walk_m": 140, "unknown_walk_m": 140, "confidence": "low",
               "transit_legs": 3, "minutes": 154}] if ok else []
    return {"status": 200 if ok else 422, "latency": 2.7,
            "reason": None if ok else "NO_ROUTE", "routes": int(ok), "usable_routes": int(ok),
            "fallback": None, "has_transit": ok, "checks": checks}


class EvaluationReferenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.cases = json.loads(evaluation.REGRESSION_CASES.read_text())["cases"]

    def directory(self, name, records, oracle=None):
        path = self.root / name
        path.mkdir()
        (path / "records.jsonl").write_text("".join(json.dumps(r) + "\n" for r in records))
        if oracle is not None:
            (path / "oracle.jsonl").write_text("".join(json.dumps(o) + "\n" for o in oracle))
        return path

    def report(self, path, **kwargs):
        with contextlib.redirect_stdout(io.StringIO()):
            return evaluation.report(path, 30, 90, **kwargs)

    def test_lost_historical_success_remains_in_denominator_when_oracle_empty(self):
        records = [dict(c, first=outcome(False)) for c in self.cases]
        baseline = self.directory("baseline", [dict(c, first=outcome()) for c in self.cases])
        current = self.directory("current", records, [{"id": c["id"], "feasible": False} for c in self.cases])
        summary = self.report(current, baselines=[baseline])
        self.assertEqual(len(summary["reference_losses"]), 2)
        self.assertEqual(summary["matched_references"], 2)
        text = (current / "report.md").read_text()
        self.assertIn("已測已知可行樣本召回率（未測另列） | 0/2", text)
        self.assertIn("固定參照退步", text)
        self.assertNotIn("oracle 判定不可行", text)
        self.assertTrue(all(len(s["sha256"]) == 64 for s in summary["reference_sources"]))

    def test_success_and_oracle_none_do_not_change_fixed_denominator(self):
        current = self.directory("current", [dict(c, first=outcome()) for c in self.cases])
        summary = self.report(current)
        self.assertEqual(summary["reference_losses"], [])
        self.assertEqual(summary["missing_required"], 0)
        self.assertIn("已測已知可行樣本召回率（未測另列） | 2/2", (current / "report.md").read_text())

    def test_partial_baseline_success_has_full_reference_coverage_denominator(self):
        first = dict(self.cases[0], id=10, first=outcome())
        second = dict(self.cases[1], id=20, first=outcome())
        baseline = self.directory("baseline", [first, second])
        current = self.directory("current", [first])
        empty_fixture = self.root / "empty-fixed.json"
        empty_fixture.write_text(json.dumps({"cases": []}))
        with patch.object(evaluation, "REGRESSION_CASES", empty_fixture):
            summary = self.report(current, baselines=[baseline])
        self.assertEqual(summary["reference_total"], 2)
        self.assertEqual(summary["reference_usable"], 1)
        self.assertEqual(summary["matched_references"], 1)
        self.assertEqual(summary["reference_losses"], [])
        self.assertEqual(summary["missing_required"], 0)
        self.assertEqual(len(summary["unmeasured_references"]), 1)
        text = (current / "report.md").read_text()
        self.assertIn("已測已知可行樣本召回率（未測另列） | 1/1", text)
        self.assertIn("固定參照成功覆蓋率（全集含未測） | 1/2", text)

    def test_external_baseline_matches_request_not_id_and_reference_set_is_frozen(self):
        normal = dict(self.cases[0], id=10, mode="normal", need="normal", first=outcome())
        baseline = self.directory("baseline", [normal])
        candidate = dict(normal, id=999, first=outcome(False))
        current = self.directory("current", [candidate])
        summary = self.report(current, baselines=[baseline / "records.jsonl"])
        self.assertEqual([r["id"] for r in summary["reference_losses"]], [999])
        self.assertEqual(summary["matched_references"], 1)
        with patch.object(evaluation, "REGRESSION_CASES", self.root / "missing-fixture.json"):
            rerun = self.report(current)
        self.assertEqual(rerun, summary)
        other_date = dict(candidate, departure="2026-10-12T12:30:00+08:00")
        different = self.directory("other-date", [other_date])
        summary = self.report(different, baselines=[baseline])
        self.assertEqual(summary["matched_references"], 0)
        self.assertEqual(summary["reference_losses"], [])

    def test_missing_known_reference_fails_and_explicit_collection_is_loaded(self):
        with self.assertRaises(FileNotFoundError):
            evaluation.load_references(known_paths=[self.root / "missing.json"])
        custom = dict(self.cases[0], id="custom", mode="normal", need="normal")
        collection = self.root / "known.json"
        collection.write_text(json.dumps({"cases": [custom]}))
        refs = evaluation.load_references(known_paths=[collection])
        self.assertEqual(len(evaluation.include_fixed_cases([], refs)), 3)
        self.assertIn(evaluation.request_identity(custom), refs["entries"])

    def test_identity_ignores_sample_id_but_not_date_mode_or_constraints(self):
        c = self.cases[0]
        self.assertEqual(evaluation.request_identity(c), evaluation.request_identity(dict(c, id=900)))
        for change in ({"departure": "2026-10-12T12:30:00+08:00"}, {"mode": "normal"}, {"avoidStairs": True}):
            self.assertNotEqual(evaluation.request_identity(c), evaluation.request_identity(dict(c, **change)))
        changed = dict(c, departure="2026-10-12T12:30:00+08:00", first=outcome(False))
        current = self.directory("current", [changed])
        summary = self.report(current)
        self.assertEqual(summary["matched_references"], 0)
        self.assertEqual(summary["reference_losses"], [])
        self.assertEqual(summary["missing_required"], 2)

    def test_current_success_does_not_self_certify_unknown_request(self):
        c = dict(self.cases[0], departure="2026-10-12T12:30:00+08:00", first=outcome())
        current = self.directory("current", [c])
        self.report(current)
        self.assertIn("已測已知可行樣本召回率（未測另列） | —", (current / "report.md").read_text())

    def test_oracle_empty_and_error_are_unknown_not_infeasible(self):
        with patch.object(evaluation, "post_json", return_value=(200, {"data": {"plan": {"itineraries": []}}}, .1)):
            result = evaluation.oracle("unused", self.cases[0], 90)
        self.assertIsNone(result["feasible"])
        self.assertEqual(result["observation"], "observed_no_candidates")
        with patch.object(evaluation, "post_json", return_value=(503, None, .1)):
            self.assertIsNone(evaluation.oracle("unused", self.cases[0], 90)["feasible"])
        with patch.object(evaluation, "post_json", return_value=(200, {"data": {"plan": {
                "itineraries": [{"legs": [{"mode": "BUS"}]}]}}}, .1)):
            self.assertTrue(evaluation.oracle("unused", self.cases[0], 90)["feasible"])

    def test_permanent_cases_are_sent_even_when_random_sample_is_empty(self):
        args = SimpleNamespace(out=str(self.root / "run"), feed="unused", n=0, seed=7, bands=None,
                               baseline=[], known_feasible=[], repeat=0, timeout=90, min_n=30,
                               base="unused", otp="unused", oracle_workers=1)
        class Clock(datetime):
            @classmethod
            def now(cls, tz=None):
                return cls(2026, 10, 2, 12, tzinfo=tz)
        with patch.object(evaluation, "datetime", Clock), patch.object(evaluation, "load_stops", return_value=[]), \
                patch.object(evaluation, "build_sample", return_value=[]), \
                patch.object(evaluation, "feed_service_range", return_value=(date(2026, 10, 1), date(2026, 10, 31))), \
                patch.object(evaluation, "call_backend", return_value=(200, {}, .1)) as call, \
                patch.object(evaluation, "evaluate", return_value=outcome()), \
                patch.object(evaluation, "run_oracle"), contextlib.redirect_stdout(io.StringIO()):
            result = evaluation.run(args)
        self.assertEqual(call.call_count, 2)
        self.assertEqual({evaluation.request_identity(c.args[1]) for c in call.call_args_list},
                         {evaluation.request_identity(c) for c in self.cases})
        self.assertEqual(result["reference_losses"], [])
        refs = evaluation.load_references()
        self.assertEqual(len(evaluation.include_fixed_cases([self.cases[0]], refs)), 2)

    def test_fixed_dates_expire_or_exceed_feed_without_rebasing(self):
        c = copy.deepcopy(self.cases[0])
        now = datetime(2026, 10, 7, tzinfo=evaluation.TAIPEI)
        self.assertEqual(evaluation.fixed_case_unavailable(c, now, None), "expired_departure_not_rebased")
        now = datetime(2026, 10, 2, tzinfo=evaluation.TAIPEI)
        self.assertEqual(evaluation.fixed_case_unavailable(c, now, (date(2026, 10, 7), date(2026, 10, 31))),
                         "outside_feed_service_dates")
        self.assertEqual(c["departure"], self.cases[0]["departure"])

    def test_legacy_cli_and_report_exit_on_loss(self):
        help_result = subprocess.run([sys.executable, str(SCRIPT), "--help"], capture_output=True, text=True)
        self.assertEqual(help_result.returncode, 0)
        for flag in ["--oracle-only", "--bands", "--report-only", "--baseline", "--known-feasible"]:
            self.assertIn(flag, help_result.stdout)
        current = self.directory("current", [dict(c, first=outcome(False)) for c in self.cases])
        result = subprocess.run([sys.executable, str(SCRIPT), "--report-only", str(current)],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(len(json.loads((current / "regression-summary.json").read_text())["reference_losses"]), 2)


if __name__ == "__main__":
    unittest.main()
