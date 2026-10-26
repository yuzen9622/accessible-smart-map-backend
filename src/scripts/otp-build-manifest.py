"""Freeze new OTP build inputs and bind the resulting graph bytes.

This records declared artifacts, not policy review or runtime attestation. Portable
policy manifests require an independently supplied manifest SHA-256. The legacy
frozen overlay format remains supported for existing build callers.
"""

import argparse
import hashlib
import json
import re
from pathlib import Path


BUILD_KEYS = {
    "transitServiceStart", "transitServiceEnd", "osmDefaults", "subwayAccessTime",
    "multiThreadElevationCalculations", "transferRequests", "islandPruning",
    "readCachedElevations", "writeCachedElevations",
}
INPUT_MODE = "LOCAL_AUTO_DISCOVERY_NO_CACHE"
DEPENDENCIES = (
    "build-ped-graph.py", "ped-sidewalk-network.py", "ped-osm-areas.py",
    "osm-area-polygon-features.json",
)
PORTABLE_FIELDS = {
    "schema_version", "policy_revision", "api_revision", "official_commit",
    "official_image", "reviewed_lock_sha256", "compiler_version", "java_release",
    "artifacts", "policy_classes", "observed_class_digest_sha256", "class_count",
    "trust_boundary",
}


def digest(path):
    value = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def encoded(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True) + "\n").encode()


def write_new(path, value):
    data = encoded(value)
    with Path(path).open("xb") as output:
        output.write(data)
    return hashlib.sha256(data).hexdigest()


def sha(value):
    if not isinstance(value, str) or not re.fullmatch("[0-9a-f]{64}", value):
        raise ValueError("Invalid SHA-256")
    return value


def regular_file(path):
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        raise ValueError("Only regular nonsymlink artifact files are accepted: " + str(path))
    return path


def artifact(path, relative, role):
    path = regular_file(path)
    return {"path": relative, "role": role, "sha256": digest(path), "byteCount": path.stat().st_size}


def unique_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON key: " + key)
        result[key] = value
    return result


def parse_json(raw):
    return json.loads(raw, object_pairs_hook=unique_keys)


def inventory(root):
    root = Path(root)
    result = []
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ValueError("Input tree contains symlink: " + str(path))
        if not path.is_file():
            continue
        relative = path.relative_to(root).as_posix()
        if relative == "graph.obj":
            continue
        role = ("OSM" if path.suffix == ".pbf" else "GTFS" if path.suffix == ".zip"
                else "DEM" if path.suffix.lower() in (".tif", ".tiff")
                else "CONFIG" if path.name.endswith("config.json") else "OTHER")
        result.append(artifact(path, relative, role))
    return result


def validate_build_config(inputs):
    inputs = Path(inputs)
    config = parse_json(regular_file(inputs / "build-config.json").read_bytes())
    if not isinstance(config, dict) or set(config) - BUILD_KEYS:
        raise ValueError("Only approved local automatic-discovery build-config keys are supported")
    if config.get("readCachedElevations") is not False or config.get("writeCachedElevations") is not False:
        raise ValueError("External elevation cache reads and writes must be explicitly disabled")
    defaults = config.get("osmDefaults", {})
    if not isinstance(defaults, dict) or set(defaults) - {"timeZone", "osmTagMapping"}:
        raise ValueError("Unsupported osmDefaults configuration")
    for path in inputs.rglob("*config.json"):
        if path.relative_to(inputs).as_posix() not in ("build-config.json", "router-config.json", "otp-config.json"):
            raise ValueError("Unsupported config source: " + str(path))
    otp = inputs / "otp-config.json"
    if otp.exists() or otp.is_symlink():
        otp_config = parse_json(regular_file(otp).read_bytes())
        if not isinstance(otp_config, dict) or set(otp_config) != {"otpFeatures"}:
            raise ValueError("Unsupported OTP configuration keys")
        features = otp_config["otpFeatures"]
        if (not isinstance(features, dict) or set(features) != {"ActuatorAPI"}
                or not isinstance(features["ActuatorAPI"], bool)):
            raise ValueError("Only a boolean ActuatorAPI feature is supported")
    return config


def validate_report(report_path, compiler_root):
    report = parse_json(regular_file(report_path).read_bytes())
    required = ("compiler_source_sha256", "topology_source_sha256", "dependency_source_sha256",
                "source_version", "source_batch", "source_archive_sha256", "output_pbf_sha256")
    if not isinstance(report, dict) or any(key not in report for key in required):
        raise ValueError("Compiler report lacks frozen source/helper identity; historical hashes cannot be reconstructed")
    dependencies = report["dependency_source_sha256"]
    if not isinstance(dependencies, dict) or set(dependencies) != set(DEPENDENCIES):
        raise ValueError("Incomplete or unknown compiler dependency set")
    expected = {"otp-sidewalk-layer.py": report["compiler_source_sha256"],
                "otp-sidewalk-topology.py": report["topology_source_sha256"], **dependencies}
    sources = []
    for name, value in sorted(expected.items()):
        role = ("COMPILER" if name == "otp-sidewalk-layer.py"
                else "TOPOLOGY" if name == "otp-sidewalk-topology.py" else "DEPENDENCY")
        item = artifact(Path(compiler_root) / name, name, role)
        if item["sha256"] != sha(value):
            raise ValueError("Compiler source differs from loaded compiler report: " + name)
        sources.append(item)
    for key in ("source_version", "source_batch"):
        if not isinstance(report[key], str) or not report[key].strip():
            raise ValueError("Empty source identity")
    sha(report["source_archive_sha256"])
    sha(report["output_pbf_sha256"])
    return report, sources


def portable_path(parent, value):
    if (not isinstance(value, str) or not value or "\\" in value or "\0" in value
            or re.match(r"^[A-Za-z]:", value) or Path(value).is_absolute()
            or any(part in ("", ".", "..") for part in value.split("/"))):
        raise ValueError("Portable artifact path must be relative without traversal")
    path = parent
    for part in value.split("/"):
        path = path / part
        if path.is_symlink():
            raise ValueError("Portable artifact path contains a symlink")
    if not path.resolve().is_relative_to(parent):
        raise ValueError("Portable artifact path escapes manifest directory")
    return regular_file(path).resolve()


def validate_policy_manifest(policy_manifest, expected_manifest_sha256=None):
    policy_manifest = regular_file(policy_manifest).resolve()
    raw = policy_manifest.read_bytes()
    actual_manifest_sha256 = hashlib.sha256(raw).hexdigest()
    if expected_manifest_sha256 is not None and actual_manifest_sha256 != sha(expected_manifest_sha256):
        raise ValueError("Policy manifest differs from independently supplied SHA-256")
    policy = parse_json(raw)
    if not isinstance(policy, dict):
        raise ValueError("Policy manifest must be an object")
    if "schema_version" in policy or "artifacts" in policy:
        if type(policy.get("schema_version")) is not int or policy["schema_version"] != 1 or set(policy) - PORTABLE_FIELDS:
            raise ValueError("Unsupported portable policy manifest schema")
        if expected_manifest_sha256 is None:
            raise ValueError("Portable policy manifest requires an independently supplied SHA-256")
        declared = policy.get("artifacts")
        if (not isinstance(declared, dict) or "policy" not in declared
                or set(declared) - {"policy", "observer", "api"}):
            raise ValueError("Invalid portable policy artifact set")
        artifacts = []
        paths = set()
        for name, item in sorted(declared.items()):
            if (not isinstance(item, dict) or not {"path", "sha256"} <= set(item)
                    or set(item) - {"path", "sha256", "class_count", "reviewed_class_bytes_equal"}):
                raise ValueError("Invalid portable artifact declaration")
            if "class_count" in item and (type(item["class_count"]) is not int or item["class_count"] < 1):
                raise ValueError("Invalid portable class count")
            if "reviewed_class_bytes_equal" in item and type(item["reviewed_class_bytes_equal"]) is not bool:
                raise ValueError("Invalid portable class comparison metadata")
            path = portable_path(policy_manifest.parent, item["path"])
            if path in paths:
                raise ValueError("Duplicate portable artifact path")
            paths.add(path)
            observed = artifact(path, str(path), name.upper())
            if observed["sha256"] != sha(item["sha256"]):
                raise ValueError("Portable artifact differs from declared SHA-256: " + name)
            artifacts.append(observed)
        selected = next(item for item in artifacts if item["role"] == "POLICY")
    else:
        jar_value = policy.get("overlay_jar", policy.get("overlay"))
        if not isinstance(jar_value, str) or not jar_value or policy.get("frozen") is not True:
            raise ValueError("Invalid legacy frozen build policy declaration")
        jar = regular_file(jar_value).resolve()
        expected = sha(policy.get("overlay_jar_sha256", policy.get("overlay_sha256")))
        if not jar.is_relative_to(policy_manifest.parent) or digest(jar) != expected:
            raise ValueError("Build policy artifact mismatch")
        selected = artifact(jar, str(jar), "POLICY")
        artifacts = [selected]
    return Path(selected["path"]), selected["sha256"], actual_manifest_sha256, artifacts


def outside_inputs(out, inputs):
    if Path(out).resolve().is_relative_to(inputs):
        raise ValueError("Build manifests must be written outside the frozen input directory")


def prepare(inputs, report_path, compiler_root, policy_manifest, out, *, policy_manifest_sha256=None):
    inputs = Path(inputs).resolve()
    report_path = regular_file(report_path).resolve()
    compiler_root = Path(compiler_root).resolve()
    policy_manifest = regular_file(policy_manifest).resolve()
    if not inputs.is_dir() or (inputs / "graph.obj").exists() or (inputs / "graph.obj").is_symlink():
        raise ValueError("Prepare requires a fresh input directory without graph.obj")
    outside_inputs(out, inputs)
    validate_build_config(inputs)
    report, sources = validate_report(report_path, compiler_root)
    files = inventory(inputs)
    merged = [item for item in files if item["path"] == "merged.osm.pbf" and item["role"] == "OSM"]
    if len(merged) != 1 or merged[0]["sha256"] != report["output_pbf_sha256"]:
        raise ValueError("Merged PBF does not match compiler report")
    jar, expected, manifest_sha256, policy_artifacts = validate_policy_manifest(policy_manifest, policy_manifest_sha256)
    state = {
        "schemaVersion": 2, "buildInputMode": INPUT_MODE, "phase": "PREPARED",
        "inputsRoot": str(inputs), "reportPath": str(report_path), "compilerRoot": str(compiler_root),
        "policyManifestPath": str(policy_manifest), "policyJarPath": str(jar), "inputs": files,
        "compilerArtifacts": sources, "layerReportSha256": digest(report_path),
        "declaredBuildPolicyJarSha256": expected, "policyManifestSha256": manifest_sha256,
        "policyArtifacts": policy_artifacts,
        "source": {"version": report["source_version"], "batch": report["source_batch"],
                   "archiveSha256": report["source_archive_sha256"]},
        "mergedPbfSha256": report["output_pbf_sha256"],
    }
    return write_new(out, state)


def finish(prepared, expected_pin, out):
    raw = regular_file(prepared).read_bytes()
    if hashlib.sha256(raw).hexdigest() != sha(expected_pin):
        raise ValueError("Prepared input manifest pin mismatch")
    state = parse_json(raw)
    if state.get("schemaVersion") != 2 or state.get("buildInputMode") != INPUT_MODE or state.get("phase") != "PREPARED":
        raise ValueError("Not a supported local input freeze")
    inputs = Path(state["inputsRoot"])
    outside_inputs(out, inputs)
    validate_build_config(inputs)
    current = inventory(inputs)
    if current != state["inputs"]:
        raise ValueError("Build input files changed, added, or removed")
    _, sources = validate_report(state["reportPath"], state["compilerRoot"])
    if sources != state["compilerArtifacts"] or digest(state["reportPath"]) != state["layerReportSha256"]:
        raise ValueError("Compiler report/source artifacts changed during build")
    jar, policy_sha256, manifest_sha256, policy_artifacts = validate_policy_manifest(
        state["policyManifestPath"], state["policyManifestSha256"])
    if (str(jar) != state["policyJarPath"] or policy_sha256 != state["declaredBuildPolicyJarSha256"]
            or manifest_sha256 != state["policyManifestSha256"]
            or ("policyArtifacts" in state and policy_artifacts != state["policyArtifacts"])):
        raise ValueError("Declared build policy artifacts changed")
    graph = artifact(inputs / "graph.obj", "graph.obj", "GRAPH")
    result = {
        "schemaVersion": 2, "buildInputMode": INPUT_MODE, "phase": "BUILT",
        "graph": {"sha256": graph["sha256"], "byteCount": graph["byteCount"]},
        "inputs": current, "compilerArtifacts": sources, "source": state["source"],
        "layerReportSha256": state["layerReportSha256"], "mergedPbfSha256": state["mergedPbfSha256"],
        "declaredBuildPolicyJarSha256": state["declaredBuildPolicyJarSha256"],
        "preparedManifestSha256": expected_pin,
    }
    return write_new(out, result)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="action", required=True)
    command = subparsers.add_parser("prepare")
    for name in ("inputs", "report", "compiler-root", "policy-manifest", "out"):
        command.add_argument("--" + name, required=True)
    command.add_argument("--policy-manifest-sha256", help="Independent reviewed manifest pin; required for portable manifests")
    command = subparsers.add_parser("finish")
    for name in ("prepared", "expected-pin", "out"):
        command.add_argument("--" + name, required=True)
    args = vars(parser.parse_args())
    action = args.pop("action")
    if action == "prepare":
        pin = prepare(args["inputs"], args["report"], args["compiler_root"], args["policy_manifest"],
                      args["out"], policy_manifest_sha256=args["policy_manifest_sha256"])
    else:
        pin = finish(args["prepared"], args["expected_pin"], args["out"])
    print(json.dumps({"manifest": str(Path(args["out"]).resolve()), "sha256": pin,
                      "runtimePolicyIdentityStatus": "UNVERIFIED"}))


if __name__ == "__main__":
    main()
