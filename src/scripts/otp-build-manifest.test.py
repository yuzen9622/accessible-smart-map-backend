import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
import zipfile


SCRIPT = Path(__file__).with_name("otp-build-manifest.py")
SPEC = importlib.util.spec_from_file_location("otp_build_manifest_test_api", SCRIPT)
API = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(API)


class BuildManifestTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def fixture(self, name="case"):
        root = self.root / name
        root.mkdir()
        inputs, compiler, delivery = (root / part for part in ("inputs", "compiler", "delivery"))
        for directory in (inputs, compiler, delivery):
            directory.mkdir()
        self.write_json(inputs / "build-config.json", {
            "readCachedElevations": False, "writeCachedElevations": False,
            "islandPruning": {"islandWithStopsMaxSize": 0, "islandWithoutStopsMaxSize": 0},
        })
        self.write_json(inputs / "otp-config.json", {"otpFeatures": {"ActuatorAPI": True}})
        (inputs / "merged.osm.pbf").write_bytes(b"compiler output input bytes")
        (inputs / "feed.gtfs.zip").write_bytes(b"local transit input bytes")
        hashes = {}
        for filename in ("otp-sidewalk-layer.py", "otp-sidewalk-topology.py", *API.DEPENDENCIES):
            (compiler / filename).write_text("frozen fixture source: " + filename)
            hashes[filename] = API.digest(compiler / filename)
        report = root / "report.json"
        self.write_json(report, {
            "compiler_source_sha256": hashes["otp-sidewalk-layer.py"],
            "topology_source_sha256": hashes["otp-sidewalk-topology.py"],
            "dependency_source_sha256": {name: hashes[name] for name in API.DEPENDENCIES},
            "source_version": "1", "source_batch": "202606", "source_archive_sha256": "a" * 64,
            "output_pbf_sha256": API.digest(inputs / "merged.osm.pbf"),
        })
        artifacts = {}
        for component in ("policy", "observer", "api"):
            jar = delivery / f"{component}.jar"
            with zipfile.ZipFile(jar, "w") as archive:
                archive.writestr("artifact.txt", component + " manifest fixture; no runtime policy claim")
            artifacts[component] = {"path": jar.name, "sha256": API.digest(jar),
                                    "class_count": 1, "reviewed_class_bytes_equal": True}
        manifest = delivery / "policy-manifest.json"
        self.write_json(manifest, {"schema_version": 1, "artifacts": artifacts})
        return SimpleNamespace(root=root, inputs=inputs, compiler=compiler, report=report,
                               delivery=delivery, policy=manifest, prepared=root / "prepared.json",
                               built=root / "built.json")

    @staticmethod
    def write_json(path, value):
        path.write_text(json.dumps(value) + "\n")

    def prepare(self, case):
        return API.prepare(case.inputs, case.report, case.compiler, case.policy, case.prepared,
                           policy_manifest_sha256=API.digest(case.policy))

    @staticmethod
    def new_graph(case):
        (case.inputs / "graph.obj").write_bytes(b"new graph bytes produced after prepare")

    def test_portable_prepare_finish_binds_real_files_without_changing_built_schema(self):
        case = self.fixture()
        pin = self.prepare(case)
        state = json.loads(case.prepared.read_text())
        self.assertEqual({item["role"] for item in state["policyArtifacts"]}, {"POLICY", "OBSERVER", "API"})
        self.assertEqual(len(state["compilerArtifacts"]), 6)
        self.new_graph(case)
        result_pin = API.finish(case.prepared, pin, case.built)
        result = json.loads(case.built.read_text())
        self.assertEqual(result_pin, API.digest(case.built))
        self.assertEqual(result["graph"], {"sha256": API.digest(case.inputs / "graph.obj"),
                                           "byteCount": (case.inputs / "graph.obj").stat().st_size})
        self.assertEqual(result["declaredBuildPolicyJarSha256"], API.digest(case.delivery / "policy.jar"))
        self.assertEqual(result["preparedManifestSha256"], pin)
        self.assertEqual(set(result), {
            "schemaVersion", "buildInputMode", "phase", "graph", "inputs", "compilerArtifacts",
            "source", "layerReportSha256", "mergedPbfSha256", "declaredBuildPolicyJarSha256",
            "preparedManifestSha256",
        })
        self.assertEqual(result["schemaVersion"], 2)
        self.assertEqual(result["phase"], "BUILT")

    def test_portable_metadata_does_not_replace_external_manifest_pin(self):
        case = self.fixture()
        with self.assertRaisesRegex(ValueError, "independently supplied"):
            API.prepare(case.inputs, case.report, case.compiler, case.policy, case.prepared)
        self.assertFalse(case.prepared.exists())
        with self.assertRaisesRegex(ValueError, "independently supplied"):
            API.prepare(case.inputs, case.report, case.compiler, case.policy, case.prepared,
                        policy_manifest_sha256="0" * 64)
        expected = API.digest(case.policy)
        case.policy.write_text(case.policy.read_text() + " ")
        with self.assertRaisesRegex(ValueError, "independently supplied"):
            API.prepare(case.inputs, case.report, case.compiler, case.policy, case.prepared,
                        policy_manifest_sha256=expected)

    def test_portable_paths_reject_absolute_traversal_and_ambiguous_components(self):
        values = ("../policy.jar", "nested/../policy.jar", "./policy.jar", "nested//policy.jar",
                  "C:/policy.jar", "nested\\policy.jar", "", "/policy.jar")
        for index, value in enumerate(values):
            with self.subTest(path=value):
                case = self.fixture(str(index))
                policy = json.loads(case.policy.read_text())
                policy["artifacts"]["policy"]["path"] = value
                self.write_json(case.policy, policy)
                with self.assertRaisesRegex(ValueError, "relative without traversal"):
                    self.prepare(case)
                self.assertFalse(case.prepared.exists())

    def test_portable_symlink_and_parent_symlink_are_rejected_even_if_internal(self):
        for mode in ("file", "directory"):
            with self.subTest(mode=mode):
                case = self.fixture(mode)
                policy = json.loads(case.policy.read_text())
                if mode == "file":
                    (case.delivery / "link.jar").symlink_to(case.delivery / "policy.jar")
                    policy["artifacts"]["policy"]["path"] = "link.jar"
                else:
                    (case.delivery / "alias").symlink_to(case.delivery, target_is_directory=True)
                    policy["artifacts"]["policy"]["path"] = "alias/policy.jar"
                self.write_json(case.policy, policy)
                with self.assertRaisesRegex(ValueError, "symlink"):
                    self.prepare(case)

    def test_portable_schema_and_jar_bytes_are_checked(self):
        mutations = (
            lambda p: p.update(schema_version=True),
            lambda p: p.update(schema_version=2),
            lambda p: p["artifacts"]["policy"].update(sha256="0" * 64),
            lambda p: p["artifacts"]["policy"].update(reviewed=True),
            lambda p: p["artifacts"]["policy"].update(class_count=True),
            lambda p: p["artifacts"].update(unknown=p["artifacts"]["policy"]),
            lambda p: p["artifacts"].update(observer=p["artifacts"]["policy"]),
        )
        for index, mutate in enumerate(mutations):
            with self.subTest(index=index):
                case = self.fixture(str(index))
                policy = json.loads(case.policy.read_text())
                mutate(policy)
                self.write_json(case.policy, policy)
                with self.assertRaises(ValueError):
                    self.prepare(case)
                self.assertFalse(case.prepared.exists())
        case = self.fixture("duplicates")
        case.policy.write_text('{"schema_version":1,"schema_version":1,"artifacts":{}}')
        with self.assertRaisesRegex(ValueError, "Duplicate JSON key"):
            self.prepare(case)

    def test_finish_rejects_changed_added_removed_inputs_and_changed_bundle(self):
        mutations = {
            "changed_input": lambda c: (c.inputs / "feed.gtfs.zip").write_bytes(b"changed"),
            "added_input": lambda c: (c.inputs / "extra.txt").write_text("late input"),
            "removed_input": lambda c: (c.inputs / "feed.gtfs.zip").unlink(),
            "compiler": lambda c: (c.compiler / "ped-osm-areas.py").write_text("new implementation"),
            "report": lambda c: c.report.write_text(c.report.read_text() + " "),
            "policy": lambda c: (c.delivery / "policy.jar").write_bytes(b"changed"),
            "api": lambda c: (c.delivery / "api.jar").write_bytes(b"changed"),
            "observer": lambda c: (c.delivery / "observer.jar").write_bytes(b"changed"),
            "manifest": lambda c: c.policy.write_text(c.policy.read_text() + " "),
        }
        for name, mutate in mutations.items():
            with self.subTest(mutation=name):
                case = self.fixture(name)
                pin = self.prepare(case)
                self.new_graph(case)
                mutate(case)
                with self.assertRaises(ValueError):
                    API.finish(case.prepared, pin, case.built)
                self.assertFalse(case.built.exists())

    def test_prepare_cannot_backfill_existing_graph_or_dangling_graph_link(self):
        for mode in ("file", "link"):
            with self.subTest(mode=mode):
                case = self.fixture(mode)
                if mode == "file":
                    self.new_graph(case)
                else:
                    (case.inputs / "graph.obj").symlink_to(case.root / "missing-graph")
                with self.assertRaisesRegex(ValueError, "fresh input directory"):
                    self.prepare(case)
                self.assertFalse(case.prepared.exists())

    def test_finish_requires_prepared_pin_and_new_regular_graph(self):
        case = self.fixture()
        pin = self.prepare(case)
        with self.assertRaisesRegex(ValueError, "regular nonsymlink"):
            API.finish(case.prepared, pin, case.built)
        self.new_graph(case)
        with self.assertRaisesRegex(ValueError, "pin mismatch"):
            API.finish(case.prepared, "0" * 64, case.built)
        state = json.loads(case.prepared.read_text())
        state["phase"] = "BUILT"
        self.write_json(case.prepared, state)
        with self.assertRaisesRegex(ValueError, "Not a supported local input freeze"):
            API.finish(case.prepared, API.digest(case.prepared), case.built)

    def test_existing_outputs_are_not_overwritten_and_cannot_enter_inputs(self):
        case = self.fixture()
        with self.assertRaisesRegex(ValueError, "outside the frozen input"):
            API.prepare(case.inputs, case.report, case.compiler, case.policy, case.inputs / "prepared.json",
                        policy_manifest_sha256=API.digest(case.policy))
        pin = self.prepare(case)
        original = case.prepared.read_bytes()
        with self.assertRaises(FileExistsError):
            self.prepare(case)
        self.assertEqual(case.prepared.read_bytes(), original)
        self.new_graph(case)
        with self.assertRaisesRegex(ValueError, "outside the frozen input"):
            API.finish(case.prepared, pin, case.inputs / "built.json")
        API.finish(case.prepared, pin, case.built)
        original = case.built.read_bytes()
        with self.assertRaises(FileExistsError):
            API.finish(case.prepared, pin, case.built)
        self.assertEqual(case.built.read_bytes(), original)

    def test_legacy_overlay_aliases_and_old_prepared_state_remain_compatible(self):
        for jar_key, sha_key in (("overlay_jar", "overlay_jar_sha256"), ("overlay", "overlay_sha256")):
            with self.subTest(key=jar_key):
                case = self.fixture(jar_key)
                jar = case.delivery / "policy.jar"
                self.write_json(case.policy, {"frozen": True, jar_key: str(jar), sha_key: API.digest(jar)})
                API.prepare(case.inputs, case.report, case.compiler, case.policy, case.prepared)
                state = json.loads(case.prepared.read_text())
                state.pop("policyArtifacts")
                self.write_json(case.prepared, state)
                self.new_graph(case)
                API.finish(case.prepared, API.digest(case.prepared), case.built)
                self.assertEqual(json.loads(case.built.read_text())["declaredBuildPolicyJarSha256"], API.digest(jar))

    def test_real_cli_returns_unverified_runtime_status_and_consistent_pins(self):
        case = self.fixture()
        process = subprocess.run([
            sys.executable, str(SCRIPT), "prepare", "--inputs", str(case.inputs),
            "--report", str(case.report), "--compiler-root", str(case.compiler),
            "--policy-manifest", str(case.policy), "--policy-manifest-sha256", API.digest(case.policy),
            "--out", str(case.prepared),
        ], capture_output=True, text=True, check=True)
        prepared = json.loads(process.stdout)
        self.assertEqual(prepared["sha256"], API.digest(case.prepared))
        self.assertEqual(prepared["runtimePolicyIdentityStatus"], "UNVERIFIED")
        self.new_graph(case)
        process = subprocess.run([
            sys.executable, str(SCRIPT), "finish", "--prepared", str(case.prepared),
            "--expected-pin", prepared["sha256"], "--out", str(case.built),
        ], capture_output=True, text=True, check=True)
        built = json.loads(process.stdout)
        self.assertEqual(built["sha256"], API.digest(case.built))
        self.assertEqual(built["runtimePolicyIdentityStatus"], "UNVERIFIED")


if __name__ == "__main__":
    unittest.main()
