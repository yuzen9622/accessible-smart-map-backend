#!/usr/bin/env bash
# Verify one immutable native release, atomically select it, then reload OTP.
# Usage: promote-otp-graph.sh RELEASE_DIR [PINNED_IMAGE_ID]
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_DIR"
DATA_ROOT="$REPO_DIR/otp-data"
RELEASE_DIR="$(cd "${1:?usage: promote-otp-graph.sh RELEASE_DIR [PINNED_IMAGE_ID]}" && pwd)"
OTP_IMAGE="${2:-$(cat "$RELEASE_DIR/evidence/runtime-image-id.txt")}"
OTP_SERVE_XMX="${OTP_SERVE_XMX:-6g}"
OTP_CANDIDATE_PORT="${OTP_CANDIDATE_PORT:-18081}"
log() { echo "[promote-otp-graph] $(date '+%F %T') $*"; }
die() { log "FATAL: $*"; exit 1; }

# Standalone promotion shares the same build lock. The normal build caller
# already holds it in its parent Python process and supplies the internal flag.
if [ "${3:-}" != --under-build-lock ]; then
  [ "$#" -le 2 ] || die "unexpected promotion arguments"
  exec python3 - "$SCRIPT_DIR/promote-otp-graph.sh" "$RELEASE_DIR" "$OTP_IMAGE" <<'LOCK'
import os, signal, subprocess, sys, time
import psycopg2
child=None
connection=None
def stop(signum,_frame):
    if child is not None:
        try: os.killpg(child.pid,signum)
        except ProcessLookupError: pass
        try: child.wait(timeout=30)
        except subprocess.TimeoutExpired: os.killpg(child.pid,signal.SIGKILL)
    raise SystemExit(128+signum)
signal.signal(signal.SIGINT,stop)
signal.signal(signal.SIGTERM,stop)
try:
    connection=psycopg2.connect(os.environ['PED_GRAPH_DATABASE_URL'],connect_timeout=10)
    connection.autocommit=True
    with connection.cursor() as cursor:
        cursor.execute("SET statement_timeout='10s'")
        cursor.execute('SELECT pg_try_advisory_lock(724193,2)')
        if not cursor.fetchone()[0]: raise RuntimeError('another build is running')
    child=subprocess.Popen(['bash',*sys.argv[1:],'--under-build-lock'],start_new_session=True)
    until=time.monotonic()+60*60
    while child.poll() is None:
        with connection.cursor() as cursor: cursor.execute('SELECT 1')
        if time.monotonic()>=until: raise TimeoutError('promotion exceeded one hour')
        time.sleep(5)
    raise SystemExit(child.wait())
except Exception:
    if child is not None and child.poll() is None:
        os.killpg(child.pid,signal.SIGTERM)
        try: child.wait(timeout=30)
        except subprocess.TimeoutExpired: os.killpg(child.pid,signal.SIGKILL)
    print('[promote-otp-graph] Cannot acquire the OTP build lock.',file=sys.stderr)
    raise SystemExit(1)
finally:
    if connection is not None: connection.close()
LOCK
fi
[ "$#" -eq 3 ] || die "unexpected promotion arguments"
RELEASE_NAME="$(basename "$RELEASE_DIR")"
[[ "$RELEASE_NAME" =~ ^[A-Za-z0-9_-]+$ ]] || die "invalid release name"
[ "$RELEASE_DIR" = "$DATA_ROOT/releases/$RELEASE_NAME" ] || die "release must be under repository otp-data/releases"
[[ "$OTP_IMAGE" =~ ^sha256:[0-9a-f]{64}$ ]] || die "promotion requires an immutable image ID"
for directory in "$DATA_ROOT/releases" "$RELEASE_DIR" "$RELEASE_DIR/inputs" "$RELEASE_DIR/evidence"; do
  [ -d "$directory" ] && [ ! -L "$directory" ] || die "linked or missing release directory"
done
INPUTS="$RELEASE_DIR/inputs"
EVIDENCE="$RELEASE_DIR/evidence"
[ -f "$INPUTS/graph.obj" ] && [ ! -L "$INPUTS/graph.obj" ] || die "missing regular graph.obj"
[ -f "$EVIDENCE/build-manifest.json" ] && [ ! -L "$EVIDENCE/build-manifest.json" ] || die "missing regular build-manifest.json"
docker info >/dev/null 2>&1 || die "Docker daemon is unavailable"
[ "$(docker image inspect accessible-smart-map-otp:local --format '{{.Id}}')" = "$OTP_IMAGE" ] || die "native image changed since graph build"

# A container-local bind for the pointer selects the candidate without touching
# the host pointer or adding a second deployment configuration.
CANDIDATE_ROOT="$EVIDENCE/candidate-root"
mkdir -p "$CANDIDATE_ROOT/releases/$RELEASE_NAME"
printf '%s\n' "$RELEASE_NAME" > "$CANDIDATE_ROOT/active-release"
PREVIOUS_STATE="$EVIDENCE/previous-release-state.json"
python3 - "$DATA_ROOT" "$PREVIOUS_STATE" <<'PREVIOUS'
import json,re,sys
from pathlib import Path
root=Path(sys.argv[1]); pointer=root/'active-release'
if pointer.is_symlink(): raise SystemExit('active-release must not be a symlink')
value=pointer.read_text() if pointer.exists() else None
if value is not None and not re.fullmatch(r'[A-Za-z0-9_-]+\n?',value): raise SystemExit('invalid active-release pointer')
Path(sys.argv[2]).write_text(json.dumps({'pointer':value})+'\n')
PREVIOUS
MANIFEST_SHA="$(python3 - "$EVIDENCE/build-manifest.json" <<'HASH'
import hashlib,sys
print(hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest())
HASH
)"
CANDIDATE_NAME="otp-candidate-$RELEASE_NAME"
CANDIDATE_CREATED=0
SERVING_STOPPED_HERE=0
PUBLISH_ATTEMPTED=0
SUCCESS=0
start_serving() { docker compose up -d --force-recreate --no-deps otp; }
rollback_pointer() {
  python3 - "$DATA_ROOT" "$RELEASE_NAME" "$PREVIOUS_STATE" <<'ROLLBACK'
import json,os,sys,tempfile
from pathlib import Path
root=Path(sys.argv[1]); pointer=root/'active-release'
if pointer.is_symlink() or not pointer.is_file() or pointer.read_text().strip()!=sys.argv[2]:
    raise SystemExit('pointer changed externally; refusing rollback overwrite')
previous=json.loads(Path(sys.argv[3]).read_text())['pointer']
if previous is None:
    pointer.unlink()
else:
    fd,name=tempfile.mkstemp(prefix='.active-release-rollback-',dir=root)
    with os.fdopen(fd,'w') as output: output.write(previous)
    os.replace(name,pointer)
ROLLBACK
}
pointer_is_candidate() {
  python3 - "$DATA_ROOT/active-release" "$RELEASE_NAME" <<'CURRENT'
import sys
from pathlib import Path
pointer=Path(sys.argv[1])
try:
    matches=not pointer.is_symlink() and pointer.is_file() and pointer.read_text().strip()==sys.argv[2]
except OSError:
    matches=False
raise SystemExit(0 if matches else 1)
CURRENT
}
cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [ "$CANDIDATE_CREATED" -eq 1 ]; then docker rm -f "$CANDIDATE_NAME" >/dev/null 2>&1 || true; fi
  if [ "$SUCCESS" -eq 0 ] && [ "$PUBLISH_ATTEMPTED" -eq 1 ] && pointer_is_candidate; then
    log "activation failed; restoring the previous release pointer"
    if rollback_pointer; then
      start_serving || log "WARN: previous service could not start with current Compose/image; its release files remain intact"
    else
      log "WARN: pointer rollback refused; inspect current state before retrying"
    fi
  elif [ "$SUCCESS" -eq 0 ] && [ "$SERVING_STOPPED_HERE" -eq 1 ]; then
    docker start otp >/dev/null 2>&1 || log "WARN: previous container could not be restarted"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ "$(docker container inspect -f '{{.State.Running}}' otp 2>/dev/null || echo absent)" = true ]; then
  SERVING_STOPPED_HERE=1
  docker stop otp >/dev/null || die "failed to stop serving OTP for memory headroom"
fi
log "loading candidate on 127.0.0.1:$OTP_CANDIDATE_PORT"
docker create --name "$CANDIDATE_NAME" --pull=never \
  -p "127.0.0.1:$OTP_CANDIDATE_PORT:8080" \
  -e JAVA_TOOL_OPTIONS="-Xmx${OTP_SERVE_XMX}" \
  -v "$CANDIDATE_ROOT:/var/otp-data:ro" \
  -v "$RELEASE_DIR:/var/otp-data/releases/$RELEASE_NAME:ro" \
  "$OTP_IMAGE" --load >/dev/null || die "candidate container could not be created"
CANDIDATE_CREATED=1
docker start "$CANDIDATE_NAME" >/dev/null || die "candidate container failed to start"
feeds="$(find "$INPUTS" -maxdepth 1 -name 'feed-*.gtfs.zip' | wc -l | tr -d ' ')"
verify_args=(--otp "http://127.0.0.1:$OTP_CANDIDATE_PORT" --wait 900 --expect-feeds "$feeds" --feed "$INPUTS/feed-1.gtfs.zip")
PREVIOUS_RELEASE="$(python3 - "$PREVIOUS_STATE" <<'NAME'
import json,sys
print((json.load(open(sys.argv[1]))['pointer'] or '').strip())
NAME
)"
if [ -n "$PREVIOUS_RELEASE" ] && [ -f "$DATA_ROOT/releases/$PREVIOUS_RELEASE/inputs/feed-1.gtfs.zip" ]; then
  verify_args+=(--baseline "$DATA_ROOT/releases/$PREVIOUS_RELEASE/inputs/feed-1.gtfs.zip")
elif [ -f "$DATA_ROOT/feed-1.gtfs.zip" ]; then
  verify_args+=(--baseline "$DATA_ROOT/feed-1.gtfs.zip")
fi
VERIFY_RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
TRANSPORT_LOG="$EVIDENCE/transport-verification-$VERIFY_RUN_ID.log"
NATIVE_LOG="$EVIDENCE/native-verification-$VERIFY_RUN_ID.log"
log "checking existing transport geometry, coverage, freshness and route gates; log: $TRANSPORT_LOG"
if ! python3 -u "$SCRIPT_DIR/verify-otp-graph.py" "${verify_args[@]}" 2>&1 | tee "$TRANSPORT_LOG"; then
  docker logs --tail 30 "$CANDIDATE_NAME" 2>&1 || true
  die "candidate failed transport verification; previous release pointer retained; see $TRANSPORT_LOG"
fi
log "checking backend source/policy identity and normal/wheelchair waypoint routes; log: $NATIVE_LOG"
if ! pnpm exec ts-node "$SCRIPT_DIR/verify-otp-native.ts" \
  --otp "http://127.0.0.1:$OTP_CANDIDATE_PORT" --release "$RELEASE_DIR" 2>&1 | tee "$NATIVE_LOG"; then
  die "candidate failed native walking verification; previous release pointer retained; see $NATIVE_LOG"
fi
docker rm -f "$CANDIDATE_NAME" >/dev/null
CANDIDATE_CREATED=0
[ "$(docker image inspect accessible-smart-map-otp:local --format '{{.Id}}')" = "$OTP_IMAGE" ] || die "image changed during candidate verification"

# Check graph bytes again and serialize the final source read + pointer rename
# against the existing importer. The session lock is released on connection close.
PUBLISH_ATTEMPTED=1
python3 - "$DATA_ROOT" "$RELEASE_DIR" "$MANIFEST_SHA" "$PREVIOUS_STATE" "$SCRIPT_DIR/otp-build-manifest.py" <<'PUBLISH'
import hashlib,importlib.util,json,os,sys,tempfile
from pathlib import Path
import psycopg2
root,release=map(Path,sys.argv[1:3]); manifest_path=release/'evidence/build-manifest.json'
raw=manifest_path.read_bytes()
if hashlib.sha256(raw).hexdigest()!=sys.argv[3]: raise SystemExit('candidate manifest changed during verification')
manifest=json.loads(raw)
spec=importlib.util.spec_from_file_location('otp_build_manifest',sys.argv[5])
compiler=importlib.util.module_from_spec(spec); spec.loader.exec_module(compiler)
if compiler.inventory(release/'inputs')!=manifest['inputs']:
    raise SystemExit('candidate inputs changed after manifest finish')
graph=release/'inputs/graph.obj'; digest=hashlib.sha256()
with graph.open('rb') as stream:
    for block in iter(lambda:stream.read(1024*1024),b''): digest.update(block)
if digest.hexdigest()!=manifest['graph']['sha256'] or graph.stat().st_size!=manifest['graph']['byteCount']:
    raise SystemExit('candidate graph changed during verification')
previous=json.loads(Path(sys.argv[4]).read_text())['pointer']
connection=None
try:
    connection=psycopg2.connect(os.environ['PED_GRAPH_DATABASE_URL'],connect_timeout=10)
    connection.autocommit=True
    with connection.cursor() as cursor:
        cursor.execute("SET statement_timeout='15s'")
        cursor.execute('SELECT pg_advisory_lock(724193,1)')
        cursor.execute("SELECT id::text,source_batch,archive_sha256 FROM ped_sidewalk_source_version WHERE lifecycle_status='ACTIVE'")
        rows=cursor.fetchall()
        if len(rows)!=1 or dict(zip(('version','batch','archiveSha256'),rows[0]))!=manifest['source']:
            raise RuntimeError('ACTIVE sidewalk source changed')
        pointer=root/'active-release'
        if pointer.is_symlink() or (pointer.read_text() if pointer.exists() else None)!=previous:
            raise RuntimeError('active release changed externally')
        fd,name=tempfile.mkstemp(prefix='.active-release-',dir=root)
        with os.fdopen(fd,'w') as output: output.write(release.name+'\n')
        os.replace(name,pointer)
except Exception:
    print('Refusing publication: source or active release changed, or PostGIS is unavailable.',file=sys.stderr)
    raise SystemExit(1)
finally:
    if connection is not None: connection.close()
PUBLISH
log "starting OTP with the verified native release"
start_serving || die "could not start OTP after publication"
for attempt in $(seq 1 90); do
  if curl --max-time 5 -fsS http://127.0.0.1:18080/otp/actuators/health >/dev/null 2>&1; then
    pnpm exec ts-node "$SCRIPT_DIR/verify-otp-native.ts" \
      --otp http://127.0.0.1:18080 --release "$RELEASE_DIR" --identity-only ||
      die "serving OTP identity differs from the verified candidate"
    SUCCESS=1
    log "verified release $RELEASE_NAME is serving; previous releases retained"
    exit 0
  fi
  sleep 10
done
die "serving OTP did not become healthy after publication"
