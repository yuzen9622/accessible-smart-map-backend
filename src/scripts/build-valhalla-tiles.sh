#!/usr/bin/env bash
set -Eeuo pipefail

DATA_DIR=${VALHALLA_DATA_DIR:-./valhalla-data}
PBF_PATH=${VALHALLA_PBF_PATH:-./otp-data/taiwan-latest.osm.pbf}
BUILD_ID=${VALHALLA_BUILD_ID:-$(date -u +%Y%m%dT%H%M%SZ)}
RELEASE_REL="releases/$BUILD_ID"
RELEASE_DIR="$DATA_DIR/$RELEASE_REL"
LOCK_DIR="$DATA_DIR/.build.lock"
ACTIVE_LINK="$DATA_DIR/active"
PREVIOUS_LINK="$DATA_DIR/previous"
SWITCHED=false
COMMITTED=false
CLEANUP_RUNNING=false
LOCK_ACQUIRED=false
FIRST_DEPLOY=true
OLD_ACTIVE_TARGET=

fail() {
  printf 'valhalla-build: %s\n' "$*" >&2
  exit 1
}

# GNU mv needs -T while macOS mv needs -h to replace a symlink-to-directory
# instead of treating it as the destination directory.
replace_link() {
  source_link=$1
  destination_link=$2
  mv -Tf "$source_link" "$destination_link" 2>/dev/null ||
    mv -fh "$source_link" "$destination_link"
}

validate_release_target() {
  target=$1
  case "$target" in releases/*) ;; *) return 1 ;; esac
  [ -d "$DATA_DIR/$target" ] && [ -f "$DATA_DIR/$target/valhalla.json" ]
}

probe() {
  curl -fsS --max-time 5 http://localhost:8002/status >/dev/null &&
    curl -fsS --max-time 15 -X POST http://localhost:8002/route \
      -H 'Content-Type: application/json' \
      -d '{"locations":[{"lat":25.0478,"lon":121.5170},{"lat":25.0421,"lon":121.5079}],"costing":"pedestrian"}' |
    jq -e '.trip.legs[0].shape | type == "string" and length > 0' >/dev/null
}

wait_ready() {
  for _ in $(seq 1 40); do
    probe && return 0
    sleep 3
  done
  return 1
}

rollback() {
  if [ "$FIRST_DEPLOY" = true ]; then
    rm -f "$ACTIVE_LINK"
    return 0
  fi
  validate_release_target "$OLD_ACTIVE_TARGET" || return 1
  ln -s "$OLD_ACTIVE_TARGET" "$DATA_DIR/active.rollback"
  replace_link "$DATA_DIR/active.rollback" "$ACTIVE_LINK"
  docker compose restart valhalla >/dev/null || return 1
  wait_ready
}

terminal_handler() {
  original_status=$?
  signal_status=${1:-$original_status}
  if [ "$CLEANUP_RUNNING" = true ]; then exit "$signal_status"; fi
  CLEANUP_RUNNING=true
  trap - EXIT INT TERM
  set +e
  if [ "$SWITCHED" = true ] && [ "$COMMITTED" = false ]; then
    rollback
    rollback_status=$?
    [ "$rollback_status" -eq 0 ] || printf 'valhalla-build: rollback health check failed\n' >&2
  elif [ "$SWITCHED" = false ]; then
    rm -rf "$RELEASE_DIR"
  fi
  if [ "$LOCK_ACQUIRED" = true ]; then rm -rf "$LOCK_DIR"; fi
  [ "$signal_status" -eq 0 ] && signal_status=1
  exit "$signal_status"
}

trap 'terminal_handler $?' EXIT
trap 'terminal_handler 130' INT
trap 'terminal_handler 143' TERM

command -v docker >/dev/null || fail "docker is required"
command -v curl >/dev/null || fail "curl is required"
command -v jq >/dev/null || fail "jq is required"
[ -f "$PBF_PATH" ] || fail "PBF not found: $PBF_PATH"
mkdir -p "$DATA_DIR/releases"
mkdir "$LOCK_DIR" || fail "another build is active: $LOCK_DIR"
LOCK_ACQUIRED=true
printf 'pid=%s\nhost=%s\nbuild_id=%s\nstarted_at=%s\n' "$$" "$(hostname)" "$BUILD_ID" "$(date -u +%FT%TZ)" >"$LOCK_DIR/owner"

if [ -L "$ACTIVE_LINK" ]; then
  OLD_ACTIVE_TARGET=$(readlink "$ACTIVE_LINK")
  validate_release_target "$OLD_ACTIVE_TARGET" || fail "active link is not a valid relative release"
  FIRST_DEPLOY=false
elif [ -e "$ACTIVE_LINK" ]; then
  fail "active exists but is not a symlink"
fi

[ ! -e "$RELEASE_DIR" ] || fail "release already exists: $RELEASE_REL"
mkdir -p "$RELEASE_DIR/valhalla_tiles"
mkdir -p "$DATA_DIR/traffic"

export VALHALLA_DATA_DIR="$DATA_DIR" VALHALLA_PBF_PATH="$PBF_PATH"
docker compose --profile valhalla-build run --rm --no-deps valhalla-build \
  "valhalla_build_config --mjolnir-tile-dir /custom_files/$RELEASE_REL/valhalla_tiles --mjolnir-traffic-extract /custom_files/traffic/traffic.tar > /custom_files/$RELEASE_REL/valhalla.json && valhalla_build_tiles -c /custom_files/$RELEASE_REL/valhalla.json /data/input.osm.pbf"

[ -s "$RELEASE_DIR/valhalla.json" ] || fail "missing valhalla.json"
find "$RELEASE_DIR/valhalla_tiles" -type f -print -quit | grep -q . || fail "tile build produced no files"

ln -s "$RELEASE_REL" "$DATA_DIR/active.next"
replace_link "$DATA_DIR/active.next" "$ACTIVE_LINK"
SWITCHED=true
docker compose up -d valhalla
wait_ready || fail "new release failed readiness probe"

if [ "$FIRST_DEPLOY" = false ]; then
  ln -s "$OLD_ACTIVE_TARGET" "$DATA_DIR/previous.next"
  replace_link "$DATA_DIR/previous.next" "$PREVIOUS_LINK"
fi
COMMITTED=true
trap - EXIT INT TERM
rm -rf "$LOCK_DIR"
printf 'valhalla-build: active=%s\n' "$RELEASE_REL"
