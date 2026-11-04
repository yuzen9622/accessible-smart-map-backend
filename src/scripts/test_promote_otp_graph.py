"""promote-otp-graph.sh release swap and rollback, with docker/curl/sleep stubbed."""

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
  *"restart otp"*|*"up -d otp"*) [ "${STUB_START_FAIL:-0}" = 1 ] && exit 1 ; exit 0 ;;
  *) exit 0 ;;
esac
"""
CURL_STUB = '#!/usr/bin/env bash\n[ "${STUB_HEALTHY:-1}" = 1 ]\n'
SLEEP_STUB = "#!/usr/bin/env bash\nexit 0\n"


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

    def run_promote(self, **env):
        full = {
            **os.environ,
            "PATH": f"{self.bin}:{os.environ['PATH']}",
            "OTP_DATA_DIR": str(self.data),
            "OTP_CANDIDATE_SIDEWALK_INDEX": str(self.index),
            **env,
        }
        return subprocess.run(["bash", str(self.script), str(self.candidate)], env=full, capture_output=True, text=True)

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


if __name__ == "__main__":
    unittest.main()
