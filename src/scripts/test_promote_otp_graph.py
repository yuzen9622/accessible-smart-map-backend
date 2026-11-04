"""promote-otp-graph.sh release swap and rollback, with docker/curl/sleep/npx stubbed.

The stubbed PostGIS holds one ACTIVE CSR source_hash in $STUB_CSR_STATE; the npx
stub stands in for promote-ped-graph.ts and writes the new PBF hash there when it
"commits" the CSR candidate.
"""

import hashlib
import json
import os
import shutil
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("promote-otp-graph.sh")

DOCKER_STUB = """#!/usr/bin/env bash
case "$*" in
  *"config --format json"*) echo '{"services":{"otp":{"image":"otp:test"}}}' ;;
  *"container inspect"*) echo false ;;
  *"psql"*"WHERE id ="*) echo "${STUB_CSR_ID_SHA:-$STUB_NEW_SHA}" ;;
  *"psql"*) cat "$STUB_CSR_STATE" ;;
  *"restart otp"*|*"up -d otp"*) [ "${STUB_START_FAIL:-0}" = 1 ] && exit 1 ; exit 0 ;;
  *) exit 0 ;;
esac
"""
CURL_STUB = '#!/usr/bin/env bash\n[ "${STUB_HEALTHY:-1}" = 1 ]\n'
SLEEP_STUB = "#!/usr/bin/env bash\nexit 0\n"
NPX_STUB = """#!/usr/bin/env bash
echo "$*" >> "$STUB_NPX_LOG"
case "${STUB_CSR:-ok}" in
  ok) echo "$STUB_NEW_SHA" > "$STUB_CSR_STATE" ;;
  fail) exit 1 ;;
  commit-then-fail) echo "$STUB_NEW_SHA" > "$STUB_CSR_STATE" ; exit 1 ;;
  noop) exit 0 ;;
esac
"""
NEW_SHA = hashlib.sha256(b"new pbf").hexdigest()
OLD_SHA = hashlib.sha256(b"old pbf").hexdigest()


def executable(path, text):
    path.write_text(text)
    path.chmod(path.stat().st_mode | stat.S_IEXEC)


class PromoteReleaseTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        scripts = self.root / "repo" / "src" / "scripts"
        scripts.mkdir(parents=True)
        shutil.copy(SCRIPT, scripts / SCRIPT.name)
        executable(scripts / "verify-otp-graph.py", "import sys\nsys.exit(0)\n")
        self.script = scripts / SCRIPT.name
        self.bin = self.root / "bin"
        self.bin.mkdir()
        executable(self.bin / "docker", DOCKER_STUB)
        executable(self.bin / "curl", CURL_STUB)
        executable(self.bin / "sleep", SLEEP_STUB)
        executable(self.bin / "npx", NPX_STUB)
        self.csr_state = self.root / "csr-active-sha"
        self.csr_state.write_text(NEW_SHA + "\n")
        self.npx_log = self.root / "npx.log"
        self.data = self.root / "data"
        self.data.mkdir()
        self.candidate = self.root / "candidate"
        self.candidate.mkdir()
        (self.candidate / "graph.obj").write_text("new graph")
        (self.candidate / "taiwan-otp.osm.pbf").write_text("new pbf")
        self.index = self.root / "index.json"
        digest = hashlib.sha256(b"new pbf").hexdigest()
        self.index.write_text(json.dumps({"version": 2, "sourcePbfSha256": digest, "segments": [], "crossings": []}))

    def tearDown(self):
        shutil.rmtree(self.root)

    def run_promote(self, *extra_args, **env):
        full = {
            **os.environ,
            "PATH": f"{self.bin}:{os.environ['PATH']}",
            "OTP_DATA_DIR": str(self.data),
            "OTP_CANDIDATE_SIDEWALK_INDEX": str(self.index),
            "PED_PG_USER": "ped",
            "STUB_CSR_STATE": str(self.csr_state),
            "STUB_NPX_LOG": str(self.npx_log),
            "STUB_NEW_SHA": NEW_SHA,
            **env,
        }
        return subprocess.run(
            ["bash", str(self.script), str(self.candidate), *extra_args], env=full, capture_output=True, text=True
        )

    def csr_active(self):
        return self.csr_state.read_text().strip()

    def npx_calls(self):
        return self.npx_log.read_text().splitlines() if self.npx_log.exists() else []

    def files(self):
        return {p.name: p.read_text() for p in self.data.iterdir() if not p.name.startswith("feed-")}

    def seed_release(self):
        (self.data / "graph.obj").write_text("old graph")
        (self.data / "taiwan-otp.osm.pbf").write_text("old pbf")
        (self.data / "sidewalk-index.json").write_text("old index")

    def test_healthy_release_swaps_all_three_and_leaves_no_backups(self):
        self.seed_release()
        result = self.run_promote()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(
            self.files(),
            {"graph.obj": "new graph", "taiwan-otp.osm.pbf": "new pbf", "sidewalk-index.json": self.index.read_text()},
        )

    def test_failed_start_restores_the_previous_release(self):
        self.seed_release()
        result = self.run_promote(STUB_START_FAIL="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(
            self.files(),
            {"graph.obj": "old graph", "taiwan-otp.osm.pbf": "old pbf", "sidewalk-index.json": "old index"},
        )

    def test_failed_healthcheck_restores_the_previous_release(self):
        self.seed_release()
        result = self.run_promote(STUB_HEALTHY="0")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.files()["sidewalk-index.json"], "old index")
        self.assertEqual(self.files()["graph.obj"], "old graph")

    def test_failed_first_release_leaves_no_candidate_files(self):
        result = self.run_promote(STUB_HEALTHY="0")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.files(), {})

    def test_index_of_another_pbf_is_refused_before_any_swap(self):
        self.seed_release()
        self.index.write_text(json.dumps({"version": 2, "sourcePbfSha256": "0" * 64, "segments": [], "crossings": []}))
        result = self.run_promote()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.files()["graph.obj"], "old graph")

    def test_without_csr_version_refuses_when_active_csr_is_from_another_pbf(self):
        self.seed_release()
        self.csr_state.write_text(OLD_SHA + "\n")
        result = self.run_promote()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ACTIVE CSR graph was not built from the candidate PBF", result.stdout + result.stderr)
        self.assertEqual(self.files()["graph.obj"], "old graph")
        self.assertEqual(self.npx_calls(), [])

    def test_csr_candidate_is_activated_after_a_healthy_otp(self):
        self.seed_release()
        self.csr_state.write_text(OLD_SHA + "\n")
        result = self.run_promote("42")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.files()["graph.obj"], "new graph")
        self.assertEqual(self.csr_active(), NEW_SHA)
        self.assertEqual(len(self.npx_calls()), 1)
        self.assertIn("promote-ped-graph.ts --version-id 42", self.npx_calls()[0])

    def test_failed_csr_activation_rolls_otp_back(self):
        self.seed_release()
        self.csr_state.write_text(OLD_SHA + "\n")
        result = self.run_promote("42", STUB_CSR="fail")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(
            self.files(),
            {"graph.obj": "old graph", "taiwan-otp.osm.pbf": "old pbf", "sidewalk-index.json": "old index"},
        )
        self.assertEqual(self.csr_active(), OLD_SHA)

    def test_csr_commit_with_a_lost_reply_keeps_the_new_release(self):
        self.seed_release()
        self.csr_state.write_text(OLD_SHA + "\n")
        result = self.run_promote("42", STUB_CSR="commit-then-fail")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.files()["graph.obj"], "new graph")
        self.assertEqual(self.csr_active(), NEW_SHA)

    def test_unhealthy_otp_never_activates_the_csr_candidate(self):
        self.seed_release()
        self.csr_state.write_text(OLD_SHA + "\n")
        result = self.run_promote("42", STUB_HEALTHY="0")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.npx_calls(), [])
        self.assertEqual(self.csr_active(), OLD_SHA)

    def test_csr_version_from_another_pbf_is_refused_before_any_swap(self):
        self.seed_release()
        self.csr_state.write_text(OLD_SHA + "\n")
        result = self.run_promote("7", STUB_CSR_ID_SHA=OLD_SHA)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("was not built from the candidate PBF", result.stdout + result.stderr)
        self.assertEqual(self.files()["graph.obj"], "old graph")
        self.assertEqual(self.npx_calls(), [])

    def test_csr_success_that_leaves_an_old_active_graph_rolls_otp_back(self):
        self.seed_release()
        self.csr_state.write_text(OLD_SHA + "\n")
        result = self.run_promote("42", STUB_CSR="noop")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.files()["graph.obj"], "old graph")

    def test_malformed_csr_version_is_refused_before_any_swap(self):
        self.seed_release()
        result = self.run_promote("0x2")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.files()["graph.obj"], "old graph")


if __name__ == "__main__":
    unittest.main()
