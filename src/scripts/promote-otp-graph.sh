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
#
# Required env:
#   OTP_CANDIDATE_SIDEWALK_INDEX  sidewalk-index.json built from the candidate's
#                         taiwan-otp.osm.pbf (build-otp-graph.sh passes it). PBF,
#                         index and graph are one release: all three are staged
#                         before any is swapped, swapped together, and rolled back
#                         together. The backend re-reads the index when it changes.
set -euo pipefail

CANDIDATE_DIR="${1:?usage: promote-otp-graph.sh CANDIDATE_DIR}"
CANDIDATE_DIR="$(cd "$CANDIDATE_DIR" && pwd)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
OTP_IMAGE="$(docker compose --project-directory "$REPO_DIR" config --format json |
  python3 -c 'import json, sys; print(json.load(sys.stdin)["services"]["otp"]["image"])')"
OTP_DATA_DIR="${OTP_DATA_DIR:-/var/otp}"
OTP_SERVE_XMX="${OTP_SERVE_XMX:-12g}"
OTP_CANDIDATE_PORT="${OTP_CANDIDATE_PORT:-18081}"
CANDIDATE_NAME="otp-candidate"

log() { echo "[promote-otp-graph] $(date '+%F %T') $*"; }
die() {
  log "FATAL: $*"
  exit 1
}

[ -f "$CANDIDATE_DIR/graph.obj" ] || die "no graph.obj in $CANDIDATE_DIR"
[ -f "$CANDIDATE_DIR/taiwan-otp.osm.pbf" ] || die "no taiwan-otp.osm.pbf in $CANDIDATE_DIR"
CANDIDATE_INDEX="${OTP_CANDIDATE_SIDEWALK_INDEX:?OTP_CANDIDATE_SIDEWALK_INDEX is required (sidewalk-index.json of the candidate PBF)}"
[ -f "$CANDIDATE_INDEX" ] || die "OTP_CANDIDATE_SIDEWALK_INDEX $CANDIDATE_INDEX does not exist"
python3 - "$CANDIDATE_INDEX" "$CANDIDATE_DIR/taiwan-otp.osm.pbf" <<'PY' ||
import hashlib, json, sys
index = json.load(open(sys.argv[1]))
with open(sys.argv[2], "rb") as stream:
    digest = hashlib.file_digest(stream, "sha256").hexdigest()
sys.exit(0 if index.get("version") == 2 and index.get("sourcePbfSha256") == digest else 1)
PY
  die "candidate sidewalk index is not a v2 index of the candidate PBF"
[ -d "$OTP_DATA_DIR" ] || die "OTP_DATA_DIR $OTP_DATA_DIR does not exist"
docker info >/dev/null 2>&1 || die "docker daemon is not responding"

start_serving() {
  docker compose --project-directory "$REPO_DIR" restart otp ||
    docker restart otp ||
    docker compose --project-directory "$REPO_DIR" up -d otp
}

# One release unit, staged/swapped/rolled back together.
RELEASE_FILES=(graph.obj taiwan-otp.osm.pbf sidewalk-index.json)

# Put back whatever the swap replaced: `.prev` copies are restored, and files the
# previous release did not have (`.absent` markers) are removed again.
rollback_release() {
  local file
  for file in "${RELEASE_FILES[@]}"; do
    if [ -f "$OTP_DATA_DIR/$file.prev" ]; then
      mv "$OTP_DATA_DIR/$file.prev" "$OTP_DATA_DIR/$file"
    elif [ -f "$OTP_DATA_DIR/$file.absent" ]; then
      rm -f "$OTP_DATA_DIR/$file" "$OTP_DATA_DIR/$file.absent"
    fi
  done
}

SERVING_STOPPED_HERE=0
SWAPPED=0
PROMOTED=0
cleanup() {
  status=$?
  trap - EXIT INT TERM
  docker rm -f "$CANDIDATE_NAME" >/dev/null 2>&1 || true
  # Any exit after the swap but before a healthy restart (start failure,
  # healthcheck failure, signal) restores the previous release.
  if [ "$SWAPPED" -eq 1 ] && [ "$PROMOTED" -eq 0 ]; then
    log "rolling back the release files to the previous graph"
    rollback_release || log "WARN: rollback incomplete — check $OTP_DATA_DIR/*.prev"
  fi
  if [ "$PROMOTED" -eq 0 ] && { [ "$SERVING_STOPPED_HERE" -eq 1 ] || [ "$SWAPPED" -eq 1 ]; }; then
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
verify_args=(--otp "http://127.0.0.1:$OTP_CANDIDATE_PORT" --wait 900 --expect-feeds "$feeds"
  --feed "$CANDIDATE_DIR/feed-1.gtfs.zip")
if [ -f "$OTP_DATA_DIR/feed-1.gtfs.zip" ]; then
  verify_args+=(--baseline "$OTP_DATA_DIR/feed-1.gtfs.zip")
fi
log "verifying candidate graph"
if ! python3 "$SCRIPT_DIR/verify-otp-graph.py" "${verify_args[@]}"; then
  docker logs --tail 30 "$CANDIDATE_NAME" 2>&1 | sed 's/^/[otp-candidate] /' || true
  die "candidate graph failed verification — not promoted, the old graph keeps serving"
fi
docker rm -f "$CANDIDATE_NAME" >/dev/null 2>&1 || true

log "verification passed — swapping graph.obj into $OTP_DATA_DIR"
# Stage every file first, so a failed copy changes nothing.
release_source() {
  case "$1" in
  sidewalk-index.json) echo "$CANDIDATE_INDEX" ;;
  *) echo "$CANDIDATE_DIR/$1" ;;
  esac
}
for file in "${RELEASE_FILES[@]}"; do
  cp "$(release_source "$file")" "$OTP_DATA_DIR/$file.new" ||
    die "could not stage $file — nothing was swapped, the old graph keeps serving"
done
for file in "${RELEASE_FILES[@]}"; do
  rm -f "$OTP_DATA_DIR/$file.prev" "$OTP_DATA_DIR/$file.absent"
  if [ -f "$OTP_DATA_DIR/$file" ]; then
    cp "$OTP_DATA_DIR/$file" "$OTP_DATA_DIR/$file.prev" || die "could not back up $file — nothing was swapped"
  else
    : >"$OTP_DATA_DIR/$file.absent"
  fi
done
SWAPPED=1
for file in "${RELEASE_FILES[@]}"; do
  mv "$OTP_DATA_DIR/$file.new" "$OTP_DATA_DIR/$file"
done

log "starting otp on the new graph"
start_serving || die "container restart failed (the previous release is restored)"

log "waiting for healthcheck"
for _ in $(seq 1 30); do
  if curl -fsS "http://localhost:18080/otp/actuators/health" >/dev/null 2>&1; then
    log "OTP healthy — new graph promoted"
    PROMOTED=1
    # The feeds here are only the record of what is serving (the next run's
    # --baseline); the graph carries the transit data. Update them only once the
    # release is live, so a failed promote keeps auditing against the real feed.
    cp "$CANDIDATE_DIR"/feed-*.gtfs.zip "$OTP_DATA_DIR/" 2>/dev/null || true
    for file in "${RELEASE_FILES[@]}"; do
      rm -f "$OTP_DATA_DIR/$file.prev" "$OTP_DATA_DIR/$file.absent"
    done
    exit 0
  fi
  sleep 10
done

die "new graph failed healthcheck (the previous release is restored)"
