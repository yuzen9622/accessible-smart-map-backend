#!/usr/bin/env python3
import importlib.util
import json
import os
import shutil
import subprocess
import tempfile
import textwrap
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

SCRIPT_DIR = Path(__file__).resolve().parent
ROOT = SCRIPT_DIR.parents[1]
spec = importlib.util.spec_from_file_location("speed_rules", SCRIPT_DIR / "extract-road-speed-rules.py")
assert spec and spec.loader
rules = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rules)


class SpeedRulesTests(unittest.TestCase):
    def test_units_unlimited_and_invalid_are_retained(self):
        for raw, kind, limit in [("30", "known", 30), ("50 km/h", "known", 50), ("10 mph", "known", 16.09344), ("10 knots", "known", 18.52), ("none", "unlimited", None), ("50|40", "invalid", None), ("signals", "invalid", None), ("0", "invalid", None), ("9999", "invalid", None), ("NaN", "invalid", None)]:
            with self.subTest(raw=raw):
                parsed = rules.parse_speed(raw)
                self.assertEqual(parsed["kind"], kind)
                self.assertEqual(parsed["rawValue"], raw)
                if limit is None:
                    self.assertIsNone(parsed["limitKph"])
                else:
                    self.assertAlmostEqual(parsed["limitKph"], limit)

    def test_direction_and_exception_tags(self):
        self.assertIsNone(rules.way_rules({"maxspeed": "50"}))
        directional = rules.way_rules({"maxspeed:forward": "30", "maxspeed:backward": "50|40"})
        self.assertEqual(directional["forward"]["limitKph"], 30)
        self.assertEqual(directional["backward"]["kind"], "invalid")
        for tag in ("maxspeed:conditional", "maxspeed:forward:conditional", "maxspeed:conditional:backward", "maxspeed:motorcar", "maxspeed:motorcycle:forward", "maxspeed:hgv"):
            with self.subTest(tag=tag):
                self.assertTrue(rules.way_rules({"maxspeed": "50", tag: "30"})["unresolvedConditional"])
        for tag in ("maxspeed:lanes", "maxspeed:lanes:forward", "maxspeed:backward:lanes:conditional"):
            self.assertTrue(rules.way_rules({tag: "50|40"})["unresolvedLaneSpecific"])
        invalid = rules.way_rules({"maxspeed": "50;40"})
        self.assertEqual(invalid["forward"]["kind"], "invalid")
        self.assertEqual(invalid["backward"]["kind"], "invalid")

    def test_same_source_geometry_preserves_original_way_node_order(self):
        import osmium
        from osmium.osm.mutable import Node, Way

        with tempfile.TemporaryDirectory(dir=ROOT / ".pi") as temporary:
            directory = Path(temporary)
            source = directory / "oriented.osm.pbf"
            with osmium.SimpleWriter(str(source)) as writer:
                writer.add_node(Node(id=1, location=(121.0, 25.0)))
                writer.add_node(Node(id=2, location=(121.0, 25.001)))
                writer.add_node(Node(id=3, location=(121.001, 25.001)))
                writer.add_way(Way(id=137085105, tags={"maxspeed:forward": "30", "maxspeed:backward": "50"}, nodes=[3, 2, 1]))
                writer.add_way(Way(id=137085106, tags={"maxspeed:forward": "40"}, nodes=[1, 2, 1]))
            output = directory / "rules.json"
            rules.extract(source, output, rules.sha256(source))
            ways = json.loads(output.read_text())["ways"]
            self.assertEqual(ways["137085105"]["osmGeometry"], [[121.001, 25.001], [121.0, 25.001], [121.0, 25.0]])
            self.assertEqual(ways["137085106"]["osmGeometry"], [[121.0, 25.0], [121.0, 25.001], [121.0, 25.0]])
            self.assertEqual(ways["137085105"]["forward"]["limitKph"], 30)
            self.assertEqual(ways["137085105"]["backward"]["limitKph"], 50)
            self.assertFalse(list(directory.glob("speed-rule-nodes-*")))

    def test_real_pbf_determinism_large_ids_and_hash_integrity(self):
        import osmium
        from osmium.osm.mutable import Way

        with tempfile.TemporaryDirectory(dir=ROOT / ".pi") as temporary:
            directory = Path(temporary)
            source = directory / "source.osm.pbf"
            with osmium.SimpleWriter(str(source)) as writer:
                writer.add_way(Way(id=137085105, tags={"maxspeed:forward": "30", "maxspeed:backward": "50"}, nodes=[1, 2]))
                writer.add_way(Way(id=9007199254740993, tags={"maxspeed:forward": "50|40", "maxspeed:conditional": "30 @ wet"}, nodes=[1, 2]))
            digest = rules.sha256(source)
            first, second = directory / "first.json", directory / "second.json"
            rules.extract(source, first, digest)
            rules.extract(source, second, digest)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            artifact = json.loads(first.read_text())
            self.assertEqual(artifact["sourcePbfSha256"], digest)
            self.assertEqual(artifact["ways"]["137085105"]["backward"]["limitKph"], 50)
            self.assertIn("9007199254740993", artifact["ways"])
            self.assertNotIn("osmGeometry", artifact["ways"]["137085105"])
            with self.assertRaisesRegex(ValueError, "hash mismatch"):
                rules.extract(source, second, "0" * 64)
            calls = 0

            def changing_hash(path):
                nonlocal calls
                calls += 1
                return digest if calls == 1 else "0" * 64

            with patch.object(rules, "sha256", changing_hash):
                with self.assertRaisesRegex(ValueError, "changed during"):
                    rules.extract(source, directory / "never-written.json", digest)
                self.assertFalse((directory / "never-written.json").exists())


class OfflineBuildSafetyTests(unittest.TestCase):
    def test_bad_ids_and_existing_releases_never_delete_data(self):
        with tempfile.TemporaryDirectory(dir=ROOT / ".pi") as temporary:
            data = Path(temporary)
            release = data / "releases/existing"
            release.mkdir(parents=True)
            sentinel = release / "keep"
            sentinel.write_text("existing data")
            source = data / "input.osm.pbf"
            source.write_text("not executed")
            for build_id in ("../escape", "existing"):
                result = subprocess.run(["bash", str(SCRIPT_DIR / "build-valhalla-tiles.sh")], env={**os.environ, "VALHALLA_DATA_DIR": str(data), "VALHALLA_PBF_PATH": str(source), "VALHALLA_BUILD_ID": build_id}, capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(sentinel.read_text(), "existing data")
                self.assertFalse((data / ".build.lock").exists())

    def test_build_entrypoint_candidate_only_and_cleanup(self):
        with tempfile.TemporaryDirectory(dir=ROOT / ".pi") as temporary:
            data = Path(temporary)
            binary = data / "bin"
            binary.mkdir()
            fake = binary / "fake"
            fake.write_text('''#!/usr/bin/env python3
import hashlib, json, os, pathlib, signal, subprocess, sys
args=sys.argv[1:]
root=pathlib.Path(os.environ['VALHALLA_DATA_DIR'])
release=root/'releases'/os.environ['VALHALLA_BUILD_ID']
image='ghcr.io/valhalla/valhalla:3.9.1@sha256:'+'4'*64
with (root/'calls').open('a') as log: log.write(pathlib.Path(sys.argv[0]).name+' '+str(args)+'\\n')
if pathlib.Path(sys.argv[0]).name == 'docker':
 if 'config' in args:
  print(json.dumps({'services':{name:{'image':image,'environment':{'VALHALLA_IMAGE_DIGEST':'sha256:'+'4'*64}} for name in ['valhalla','valhalla-build','valhalla-candidate']}}))
 elif 'road-speed-rules' in args:
  source=pathlib.Path(os.environ['VALHALLA_PBF_PATH'])
  a=args[args.index('road-speed-rules')+1:]
  a=[str(root/x.removeprefix('/custom_files/')) if x.startswith('/custom_files/') else str(source) if x=='/data/input.osm.pbf' else x for x in a]
  sys.exit(subprocess.call([sys.executable,os.environ['EXTRACTOR']]+a))
 elif args[-2] == 'valhalla-build' and 'run' in args:
  traffic='/custom_files/releases/'+os.environ['VALHALLA_BUILD_ID']+'/traffic/traffic.tar'
  assert '--mjolnir-traffic-extract '+traffic in args[-1]
  (release/'valhalla.json').write_text(json.dumps({'mjolnir':{'traffic_extract':traffic}}))
  (release/'valhalla_tiles/tile.gph').write_text('' if os.environ.get('FAIL_MODE') == 'emptytiles' else 'tiles')
  if os.environ.get('FAIL_MODE') == 'mutate':
   source=pathlib.Path(os.environ['VALHALLA_PBF_PATH']); source.chmod(0o644)
   with source.open('ab') as stream: stream.write(b'changed')
 elif 'inspect' in args:
  print(args[-1] if 'valhalla.build-owner' in ' '.join(args) else image)
 elif 'valhalla-candidate' in args: print('fake-candidate')
 elif 'restart' in args or 'up' in args or 'stop' in args:
  assert os.environ.get('SIGNAL_MODE') and 'up' not in args, 'unexpected production effect'
elif pathlib.Path(sys.argv[0]).name == 'pnpm':
 assert 'verify-valhalla-release.ts' in ' '.join(args)
 if os.environ.get('REAL_VERIFIER'):
  sys.exit(subprocess.call([os.environ['REAL_NODE'], os.environ['TS_NODE']]+args[2:]))
 if os.environ.get('FAIL_MODE') == 'trace': sys.exit(7)
 source_hash=args[-2]
 rules_path=pathlib.Path(args[-3])
 checks={key:True for key in ['candidateRouting','airportSigns','exactGeometry','speedPartition','speedTransition','lanes','laneApproach','directionalLimits']}
 if os.environ.get('FAIL_MODE') == 'gate': checks['directionalLimits']=False
 pathlib.Path(args[-1]).write_text(json.dumps({'schemaVersion':1,'sourcePbfSha256':source_hash,'speedRulesSha256':hashlib.sha256(rules_path.read_bytes()).hexdigest(),'checks':checks}))
 if os.environ.get('FAIL_MODE') == 'verify-mutate':
  source=pathlib.Path(os.environ['VALHALLA_PBF_PATH']); source.chmod(0o644)
  with source.open('ab') as stream: stream.write(b'changed')
elif pathlib.Path(sys.argv[0]).name == 'mv':
 result=subprocess.run(['/bin/mv']+args).returncode
 if result == 0 and args[-2] == str(root/'active.next') and args[-1] == str(root/'active') and os.environ.get('SIGNAL_MODE'):
  (root/'signal-record').write_text(os.readlink(root/'active'))
  if os.environ['SIGNAL_MODE'] == 'external':
   (root/'active').unlink(); (root/'active').symlink_to('releases/external')
  os.kill(os.getppid(), signal.SIGTERM)
 sys.exit(result)
else:
 url=' '.join(args)
 if '/status' in url: print(json.dumps({'version':'3.9.1','tileset_last_modified':123}))
 else: print(json.dumps({'trip':{'legs':[{'shape':'shape'}]}}))
''')
            fake.chmod(0o755)
            for name in ("docker", "curl", "pnpm", "mv"):
                (binary / name).symlink_to(fake)
            import osmium
            from osmium.osm.mutable import Node, Way

            source = data / "input.osm.pbf"
            with osmium.SimpleWriter(str(source)) as writer:
                writer.add_node(Node(id=1, location=(121.4445444, 25.0258893)))
                writer.add_node(Node(id=2, location=(121.443164, 25.0244344)))
                writer.add_way(Way(id=137085105, tags={"maxspeed:forward": "30", "maxspeed:backward": "50"}, nodes=[1, 2]))
            old = data / "releases/old"
            old.mkdir(parents=True)
            (old / "valhalla.json").write_text("{}")
            (data / "active").symlink_to("releases/old")
            (data / "traffic").mkdir()
            (data / "traffic/traffic.tar").write_text("unrelated old graph traffic")
            airport = json.loads((ROOT / "src/adapters/__fixtures__/road-navigation/airport-native.json").read_text())
            lanes = json.loads((ROOT / "src/adapters/__fixtures__/road-navigation/jiachang-native.json").read_text())

            def polyline(points):
                encoded, previous = [], [0, 0]
                for point in points:
                    for axis, coordinate in enumerate(point):
                        current = int(coordinate * 1_000_000 + 0.5)
                        delta = current - previous[axis]
                        previous[axis] = current
                        number = ~(delta << 1) if delta < 0 else delta << 1
                        while number >= 32:
                            encoded.append(chr((32 | (number & 31)) + 63))
                            number >>= 5
                        encoded.append(chr(number + 63))
                return "".join(encoded)

            forward = polyline([(25.0258893, 121.4445444), (25.0244344, 121.443164)])
            backward = polyline([(25.0244344, 121.443164), (25.0258893, 121.4445444)])

            class FakeUpstream(BaseHTTPRequestHandler):
                def log_message(self, format, *args):
                    pass

                def do_POST(self):
                    body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                    if self.path == "/route":
                        points = body["locations"]
                        if points[0]["lat"] < 23:
                            response = lanes
                        elif points[0]["lat"] < 25.02:
                            response = airport
                        else:
                            shape = forward if points[0]["lat"] > points[1]["lat"] else backward
                            response = {"trip": {"summary": {"length": 1, "time": 60}, "legs": [{"summary": {"length": 1, "time": 60}, "shape": shape, "maneuvers": []}]}}
                    else:
                        shape = body["encoded_polyline"]
                        is_airport = shape == airport["trip"]["legs"][0]["shape"]
                        is_lanes = shape == lanes["trip"]["legs"][0]["shape"]
                        count = 22 if is_airport else 14 if is_lanes else 1
                        boundary = 7 if is_airport else 8 if is_lanes else count
                        intervals = [(0, boundary), (boundary, count)] if boundary != count else [(0, count)]
                        edges = [{"id": str(index + 1), "way_id": "999" if is_airport or is_lanes else "137085105", "forward": False, "begin_shape_index": begin, "end_shape_index": end} for index, (begin, end) in enumerate(intervals)]
                        response = {"shape": shape, "edges": edges, "shape_attributes": {"speed_limit": [100 if index < 7 else 60 for index in range(count)] if is_airport else [99] * count}}
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(json.dumps(response).encode())

            node = shutil.which("node")
            self.assertIsNotNone(node)
            assert node is not None
            server = ThreadingHTTPServer(("127.0.0.1", 0), FakeUpstream)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                result = subprocess.run(["bash", str(SCRIPT_DIR / "build-valhalla-tiles.sh")], env={**os.environ, "PATH": str(binary) + os.pathsep + os.environ["PATH"], "VALHALLA_DATA_DIR": str(data), "VALHALLA_PBF_PATH": str(source), "VALHALLA_BUILD_ID": "test", "EXTRACTOR": str(SCRIPT_DIR / "extract-road-speed-rules.py"), "REAL_VERIFIER": "1", "REAL_NODE": node, "TS_NODE": str(ROOT / "node_modules/ts-node/dist/bin.js"), "VALHALLA_CANDIDATE_PORT": str(server.server_port)}, capture_output=True, text=True, timeout=30)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("not promoted", result.stdout)
            self.assertEqual(os.readlink(data / "active"), "releases/old")
            self.assertFalse((data / ".build.lock").exists())
            self.assertFalse((data / "serving-release.json").exists())
            manifest = json.loads((data / "releases/test/manifest.json").read_text())
            self.assertEqual(manifest["sourcePbfSha256"], rules.sha256(source))
            self.assertEqual(manifest["speedRulesSha256"], rules.sha256(data / "releases/test/road-speed-rules.json"))
            self.assertEqual(manifest["expectedServingStatus"]["version"], "3.9.1")
            required = {"candidateRouting", "airportSigns", "lanes", "speedTransition", "directionalSourceRules", "sourceIntegrity", "tileFilesPresent"}
            self.assertTrue(all(manifest["validation"][field] is True for field in required))
            (data / "active").unlink()
            (data / "active").symlink_to("releases/test")
            marker = {"buildId": "test", "manifestSha256": rules.sha256(data / "releases/test/manifest.json"), "valhallaImageDigest": manifest["valhallaImageDigest"], "startedAt": "2026-11-08T00:00:00Z", "instanceId": "offline-producer-consumer"}
            (data / "serving-release.json").write_text(json.dumps(marker))
            consumer = """
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.VALHALLA_DATA_DIR;
const release = path.join(root, 'releases/test');
require('axios').default.get = async () => ({data: JSON.parse(fs.readFileSync(path.join(release, 'candidate-status.json'), 'utf8'))});
const {getValhallaReleaseSnapshot} = require('./src/adapters/valhalla-release.adapter');
(async () => {
 const snapshot = await getValhallaReleaseSnapshot(5000);
 assert.equal(snapshot?.roadNetwork.provenance, 'verified');
 assert.deepEqual(snapshot.rules, JSON.parse(fs.readFileSync(path.join(release, 'road-speed-rules.json'), 'utf8')));
 assert.equal(snapshot.rules.ways['137085105'].forward.limitKph, 30);
 assert.equal(snapshot.rules.ways['137085105'].backward.limitKph, 50);
 console.log('PRODUCER_CONSUMER_VERIFIED');
})().catch(error => {console.error(error); process.exitCode = 1;});
"""
            loaded = subprocess.run(["pnpm", "exec", "ts-node", "--compiler-options", '{"module":"CommonJS","moduleResolution":"node"}', "-e", consumer], cwd=ROOT, env={**os.environ, "VALHALLA_DATA_DIR": str(data)}, capture_output=True, text=True, timeout=20)
            self.assertEqual(loaded.returncode, 0, loaded.stdout + loaded.stderr)
            self.assertIn("PRODUCER_CONSUMER_VERIFIED", loaded.stdout)
            print(loaded.stdout.strip())
            (data / "serving-release.json").unlink()
            (data / "active").unlink()
            (data / "active").symlink_to("releases/old")

            self.assertIn("docker ['rm', '-f', 'valhalla-candidate-test-", (data / "calls").read_text())
            config = json.loads((data / "releases/test/valhalla.json").read_text())
            self.assertEqual(config["mjolnir"]["traffic_extract"], "/custom_files/releases/test/traffic/traffic.tar")
            self.assertFalse((data / "releases/test/traffic/traffic.tar").exists())
            self.assertIn("pnpm ['exec', 'ts-node'", (data / "calls").read_text())
            for mode in ("mutate", "trace", "verify-mutate", "gate", "emptytiles"):
                build_id = "failure-" + mode
                failed = subprocess.run(["bash", str(SCRIPT_DIR / "build-valhalla-tiles.sh")], env={**os.environ, "PATH": str(binary) + os.pathsep + os.environ["PATH"], "VALHALLA_DATA_DIR": str(data), "VALHALLA_PBF_PATH": str(source), "VALHALLA_BUILD_ID": build_id, "EXTRACTOR": str(SCRIPT_DIR / "extract-road-speed-rules.py"), "FAIL_MODE": mode}, capture_output=True, text=True)
                self.assertNotEqual(failed.returncode, 0)
                self.assertFalse((data / ".build.lock").exists())
                self.assertEqual(os.readlink(data / "active"), "releases/old")
                self.assertFalse((data / "releases" / build_id / "manifest.json").exists())
                if mode == "mutate":
                    self.assertIn("source changed during build", failed.stderr)
                elif mode == "emptytiles":
                    self.assertIn("no nonempty .gph files", failed.stderr)
                else:
                    self.assertIn("docker ['rm', '-f', 'valhalla-candidate-" + build_id + "-", (data / "calls").read_text())
                if mode == "verify-mutate":
                    self.assertIn("source changed during verification", failed.stderr)
                if mode == "gate":
                    self.assertIn("candidate verification result is invalid", failed.stderr)

            for mode in ("old", "first", "external"):
                external = data / "releases/external"
                external.mkdir(exist_ok=True)
                (external / "keep").write_text("unrelated")
                if (data / "active").is_symlink():
                    (data / "active").unlink()
                if mode != "first":
                    (data / "active").symlink_to("releases/old")
                build_id = "signal-" + mode
                interrupted = subprocess.run(["bash", str(SCRIPT_DIR / "build-valhalla-tiles.sh"), "--promote-authorized"], env={**os.environ, "PATH": str(binary) + os.pathsep + os.environ["PATH"], "VALHALLA_DATA_DIR": str(data), "VALHALLA_PBF_PATH": str(source), "VALHALLA_BUILD_ID": build_id, "EXTRACTOR": str(SCRIPT_DIR / "extract-road-speed-rules.py"), "SIGNAL_MODE": mode}, capture_output=True, text=True, timeout=20)
                self.assertEqual(interrupted.returncode, 143, interrupted.stderr)
                self.assertEqual((data / "signal-record").read_text(), "releases/" + build_id)
                if mode == "first":
                    self.assertFalse((data / "active").exists())
                    self.assertFalse((data / "active").is_symlink())
                else:
                    self.assertEqual(os.readlink(data / "active"), "releases/external" if mode == "external" else "releases/old")
                self.assertEqual((external / "keep").read_text(), "unrelated")
                self.assertEqual((data / "traffic/traffic.tar").read_text(), "unrelated old graph traffic")
                self.assertFalse((data / ".build.lock").exists())


class RuntimeIdentityTests(unittest.TestCase):
    def test_wrapper_binds_immutable_config_and_clears_marker_on_exit(self):
        compose = (ROOT / "docker-compose.yml").read_text()
        body = compose.split("  valhalla:\n", 1)[1].split("      - |\n", 1)[1].split("    environment:\n", 1)[0]
        body = textwrap.dedent(body).replace("$$", "$").replace("${VALHALLA_THREADS:-2}", "2")
        for with_manifest, route_healthy in ((False, True), (True, True), (True, False)):
            with self.subTest(with_manifest=with_manifest, route_healthy=route_healthy), tempfile.TemporaryDirectory(dir=ROOT / ".pi") as temporary:
                data = Path(temporary)
                legacy = {"mjolnir": {"tile_dir": "/custom_files/active/valhalla_tiles", "tile_extract": "/custom_files/shared/tiles.tar", "traffic_extract": "/custom_files/traffic/traffic.tar", "concurrency": 3}, "service_limits": {"auto": {"max_distance": 12345}}}
                for name in ("old", "new"):
                    release = data / "releases" / name
                    release.mkdir(parents=True)
                    (release / "valhalla_tiles").mkdir()
                    (release / "valhalla.json").write_text(json.dumps(legacy))
                original_config = (data / "releases/old/valhalla.json").read_bytes()
                runtime_config = data / "valhalla-test-instance.json"
                if with_manifest:
                    (data / "releases/old/manifest.json").write_text('{"buildId":"old"}')
                (data / "active").symlink_to("releases/old")
                marker = data / "serving-release.json"
                marker.write_text('{"instanceId":"stale"}')
                binary = data / "bin"
                binary.mkdir()
                (binary / "curl").write_text('#!/bin/sh\ntest -s "$TEST_CONFIG_RECORD" || exit 1\ncase "$*" in *"/route"*) [ "$TEST_ROUTE_HEALTHY" = 1 ] || exit 1; printf "route" >"$TEST_ROUTE_RECORD"; printf \'{"trip":{"legs":[{"shape":"shape"}]}}\';; esac\n')
                (binary / "valhalla_service").write_text('#!/bin/sh\nprintf "%s" "$1" >"$TEST_CONFIG_RECORD"\nexec sleep 30\n')
                for file in binary.iterdir():
                    file.chmod(0o755)
                uuid = data / "uuid"
                uuid.write_text("test-instance\n")
                executable = body.replace("/custom_files", str(data)).replace("/proc/sys/kernel/random/uuid", str(uuid)).replace("attempt<120", "attempt<2").replace("runtime_config=/tmp/valhalla-", "runtime_config=" + str(data) + "/valhalla-")
                process = subprocess.Popen(["bash", "-c", executable], env={**os.environ, "PATH": str(binary) + os.pathsep + os.environ["PATH"], "TEST_CONFIG_RECORD": str(data / "config-record"), "TEST_ROUTE_RECORD": str(data / "route-record"), "TEST_ROUTE_HEALTHY": "1" if route_healthy else "0", "VALHALLA_IMAGE_DIGEST": "sha256:" + "4" * 64}, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                try:
                    if not route_healthy:
                        process.communicate(timeout=5)
                        self.assertNotEqual(process.returncode, 0)
                        self.assertFalse(marker.exists())
                        continue
                    deadline = time.monotonic() + 5
                    while time.monotonic() < deadline:
                        if marker.exists() and "test-instance" in marker.read_text():
                            break
                        if process.poll() is not None:
                            self.fail(process.communicate()[1])
                        time.sleep(0.01)
                    value = json.loads(marker.read_text())
                    self.assertEqual(value["buildId"], "old")
                    self.assertEqual((data / "route-record").read_text(), "route")
                    self.assertEqual(value["manifestSha256"], rules.sha256(data / "releases/old/manifest.json") if with_manifest else None)
                    self.assertEqual(value["instanceId"], "test-instance")
                    self.assertEqual(value["valhallaImageDigest"], "sha256:" + "4" * 64)
                    (data / "active").unlink()
                    (data / "active").symlink_to("releases/new")
                    self.assertEqual((data / "config-record").read_text(), str(runtime_config))
                    expected = {**legacy, "mjolnir": {**legacy["mjolnir"], "tile_dir": str(data / "releases/old/valhalla_tiles"), "tile_extract": "", "traffic_extract": str(data / "releases/old/traffic/traffic.tar")}}
                    self.assertEqual(json.loads(runtime_config.read_text()), expected)
                    self.assertEqual((data / "releases/old/valhalla.json").read_bytes(), original_config)
                    self.assertEqual(json.loads(marker.read_text())["buildId"], "old")
                finally:
                    process.terminate()
                    process.communicate(timeout=5)
                    self.assertFalse(runtime_config.exists())
                    self.assertEqual((data / "releases/old/valhalla.json").read_bytes(), original_config)
                self.assertFalse(marker.exists())


if __name__ == "__main__":
    unittest.main()
