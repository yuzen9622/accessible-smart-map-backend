#!/usr/bin/env bash
#
# Verify a freshly built OTP graph, then promote it — or refuse and keep the
# old graph serving.
#
#   promote-otp-graph.sh CANDIDATE_DIR
#
# CANDIDATE_DIR is an OTP build directory: graph.obj, feed-*.gtfs.zip,
# taiwan-otp.osm.pbf and the three config files. Steps:
#   1. load the candidate in its own container on OTP_CANDIDATE_PORT
#   2. run verify-otp-graph.py against it (geometry, coverage, freshness,
#      fixed trips, and a service audit against the deployed feed)
#   3. on PASS only: atomic swap into OTP_DATA_DIR, restart, healthcheck,
#      roll back if the healthcheck never comes up
#
# The serving and candidate containers each need the full serve heap, and
# this machine cannot hold both (Docker VM 15.6 GiB, 12g each), so the serving
# container is stopped while the candidate loads and restarted on the old
# graph if verification fails. build-otp-graph.sh calls this as its last step
# with the serving container already stopped.
#
# Optional env:
#   OTP_DATA_DIR          (default /var/otp)
#   OTP_SERVE_XMX         candidate heap (default 12g)
#   OTP_CANDIDATE_PORT    (default 18081)
#   OTP_VERIFY_SKIP_AUDIT=1  passed to verify-otp-graph.py (see its audit check)
set -euo pipefail

CANDIDATE_DIR="${1:?usage: promote-otp-graph.sh CANDIDATE_DIR}"
CANDIDATE_DIR="$(cd "$CANDIDATE_DIR" && pwd)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
OTP_DATA_DIR="${OTP_DATA_DIR:-/var/otp}"
OTP_SERVE_XMX="${OTP_SERVE_XMX:-12g}"
OTP_CANDIDATE_PORT="${OTP_CANDIDATE_PORT:-18081}"
OTP_IMAGE="opentripplanner/opentripplanner:2.9.0"
CANDIDATE_NAME="otp-candidate"

log() { echo "[promote-otp-graph] $(date '+%F %T') $*"; }
die() {
  log "FATAL: $*"
  exit 1
}

[ -f "$CANDIDATE_DIR/graph.obj" ] || die "no graph.obj in $CANDIDATE_DIR"
[ -d "$OTP_DATA_DIR" ] || die "OTP_DATA_DIR $OTP_DATA_DIR does not exist"
docker info >/dev/null 2>&1 || die "docker daemon is not responding"

start_serving() {
  docker compose --project-directory "$REPO_DIR" restart otp ||
    docker restart otp ||
    docker compose --project-directory "$REPO_DIR" up -d otp
}

SERVING_STOPPED_HERE=0
PROMOTED=0
cleanup() {
  status=$?
  trap - EXIT INT TERM
  docker rm -f "$CANDIDATE_NAME" >/dev/null 2>&1 || true
  if [ "$SERVING_STOPPED_HERE" -eq 1 ] && [ "$PROMOTED" -eq 0 ]; then
    log "restarting otp on the old graph"
    start_serving || true
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ "$(docker container inspect -f '{{.State.Running}}' otp 2>/dev/null || echo absent)" = "true" ]; then
  log "stopping serving otp so the candidate fits in memory"
  SERVING_STOPPED_HERE=1
  docker stop otp >/dev/null || die "failed to stop serving otp"
fi

docker rm -f "$CANDIDATE_NAME" >/dev/null 2>&1 || true
log "loading candidate graph on 127.0.0.1:$OTP_CANDIDATE_PORT (heap $OTP_SERVE_XMX)"
docker run -d --name "$CANDIDATE_NAME" \
  -p "127.0.0.1:$OTP_CANDIDATE_PORT:8080" \
  -e JAVA_TOOL_OPTIONS="-Xmx${OTP_SERVE_XMX}" \
  -v "$CANDIDATE_DIR:/var/opentripplanner" \
  "$OTP_IMAGE" --load >/dev/null ||
  die "could not start the candidate container"

feeds="$(find "$CANDIDATE_DIR" -maxdepth 1 -name 'feed-*.gtfs.zip' | wc -l | tr -d ' ')"
verify_args=(--otp "http://127.0.0.1:$OTP_CANDIDATE_PORT" --wait 900 --expect-feeds "$feeds")
if [ -f "$OTP_DATA_DIR/feed-1.gtfs.zip" ] && [ -f "$CANDIDATE_DIR/feed-1.gtfs.zip" ]; then
  verify_args+=(--feed "$CANDIDATE_DIR/feed-1.gtfs.zip" --baseline "$OTP_DATA_DIR/feed-1.gtfs.zip")
fi
log "verifying candidate graph"
if ! python3 "$SCRIPT_DIR/verify-otp-graph.py" "${verify_args[@]}"; then
  docker logs --tail 30 "$CANDIDATE_NAME" 2>&1 | sed 's/^/[otp-candidate] /' || true
  die "candidate graph failed verification — not promoted, the old graph keeps serving"
fi
docker rm -f "$CANDIDATE_NAME" >/dev/null 2>&1 || true

log "verification passed — swapping graph.obj into $OTP_DATA_DIR"
cp "$CANDIDATE_DIR"/feed-*.gtfs.zip "$OTP_DATA_DIR/" 2>/dev/null || true
cp "$CANDIDATE_DIR/taiwan-otp.osm.pbf" "$OTP_DATA_DIR/" 2>/dev/null || true
[ -f "$OTP_DATA_DIR/graph.obj" ] && cp "$OTP_DATA_DIR/graph.obj" "$OTP_DATA_DIR/graph.obj.prev"
mv "$CANDIDATE_DIR/graph.obj" "$OTP_DATA_DIR/graph.obj.new"
mv "$OTP_DATA_DIR/graph.obj.new" "$OTP_DATA_DIR/graph.obj"
PROMOTED=1

log "starting otp on the new graph"
start_serving || die "container restart failed"

log "waiting for healthcheck"
for _ in $(seq 1 30); do
  if curl -fsS "http://localhost:18080/otp/actuators/health" >/dev/null 2>&1; then
    log "OTP healthy — new graph promoted"
    rm -f "$OTP_DATA_DIR/graph.obj.prev"
    exit 0
  fi
  sleep 10
done

log "healthcheck failed after restart — rolling back to previous graph"
if [ -f "$OTP_DATA_DIR/graph.obj.prev" ]; then
  mv "$OTP_DATA_DIR/graph.obj.prev" "$OTP_DATA_DIR/graph.obj"
  start_serving || true
fi
die "new graph failed healthcheck (rolled back)"
