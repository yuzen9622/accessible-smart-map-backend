#!/usr/bin/env bash
set -Eeuo pipefail

PROMOTE=false
case "${1:-}" in
  '') ;;
  --promote-authorized) PROMOTE=true ;;
  *) printf 'Usage: %s [--promote-authorized]\n' "$0" >&2; exit 64 ;;
esac
[ "$#" -le 1 ] || exit 64
DATA_DIR=${VALHALLA_DATA_DIR:-./valhalla-data}
PBF_PATH=${VALHALLA_PBF_PATH:-./otp-data/taiwan-latest.osm.pbf}
BUILD_ID=${VALHALLA_BUILD_ID:-$(date -u +%Y%m%dT%H%M%SZ)}
[[ "$BUILD_ID" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$ ]] || { echo 'invalid build ID' >&2; exit 64; }
RELEASE_REL="releases/$BUILD_ID"
RELEASE_DIR="$DATA_DIR/$RELEASE_REL"
LOCK_DIR="$DATA_DIR/.build.lock"
ACTIVE_LINK="$DATA_DIR/active"
PREVIOUS_LINK="$DATA_DIR/previous"
CANDIDATE_NAME="valhalla-candidate-$BUILD_ID-$$"
CANDIDATE_URL="http://127.0.0.1:${VALHALLA_CANDIDATE_PORT:-18002}"
LOCK_ACQUIRED=false
CANDIDATE_STARTED=false
PROMOTION_PENDING=false
COMMITTED=false
FIRST_DEPLOY=true
OLD_ACTIVE_TARGET=

fail() { printf 'valhalla-build: %s\n' "$*" >&2; exit 1; }
hash_file() { shasum -a 256 "$1" | cut -d ' ' -f 1; }

# GNU mv needs -T while macOS mv needs -h for a symlink-to-directory.
replace_link() {
  mv -Tf "$1" "$2" 2>/dev/null || mv -fh "$1" "$2"
}
new_link() {
  [ ! -e "$2" ] && [ ! -L "$2" ] && ln -s "$1" "$2"
}
validate_release_target() {
  [[ "$1" =~ ^releases/[A-Za-z0-9][A-Za-z0-9_-]{0,95}$ ]] &&
    [ ! -L "$DATA_DIR/$1" ] && [ -f "$DATA_DIR/$1/valhalla.json" ]
}
probe() {
  curl -fsS --max-time 5 "$1/status" >/dev/null &&
    curl -fsS --max-time 15 -X POST "$1/route" -H 'Content-Type: application/json' \
      -d '{"locations":[{"lat":25.0478,"lon":121.5170},{"lat":25.0421,"lon":121.5079}],"costing":"auto"}' |
      jq -e '.trip.legs[0].shape | type == "string" and length > 0' >/dev/null
}
wait_ready() {
  for _ in $(seq 1 40); do probe "$1" && return 0; sleep 3; done
  return 1
}
wait_identity() {
  for _ in $(seq 1 40); do
    jq -e --arg id "$BUILD_ID" --arg hash "$(hash_file "$RELEASE_DIR/manifest.json")" --arg image "$IMAGE_DIGEST" \
      '.buildId == $id and .manifestSha256 == $hash and .valhallaImageDigest == $image' \
      "$DATA_DIR/serving-release.json" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}
rollback() {
  [ -L "$ACTIVE_LINK" ] && [ "$(readlink "$ACTIVE_LINK")" = "$RELEASE_REL" ] || return 0
  if [ "$FIRST_DEPLOY" = true ]; then
    rm -f "$ACTIVE_LINK"
    docker compose stop valhalla >/dev/null
    return
  fi
  validate_release_target "$OLD_ACTIVE_TARGET" || return 1
  new_link "$OLD_ACTIVE_TARGET" "$DATA_DIR/active.rollback" || return 1
  replace_link "$DATA_DIR/active.rollback" "$ACTIVE_LINK"
  docker compose restart valhalla >/dev/null || return 1
  wait_ready http://127.0.0.1:8002
}
cleanup() {
  status=$?
  trap - EXIT INT TERM
  set +e
  if [ "$PROMOTION_PENDING" = true ] && [ "$COMMITTED" = false ]; then
    rollback || { echo 'valhalla-build: rollback health check failed' >&2; status=1; }
  fi
  if [ "$CANDIDATE_STARTED" = true ] &&
    [ "$(docker inspect --format '{{index .Config.Labels "valhalla.build-owner"}}' "$CANDIDATE_NAME" 2>/dev/null)" = "$CANDIDATE_NAME" ]; then
    docker rm -f "$CANDIDATE_NAME" >/dev/null || status=1
  fi
  if [ "$LOCK_ACQUIRED" = true ]; then rm -f "$LOCK_DIR/owner"; rmdir "$LOCK_DIR"; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for command in docker curl jq shasum pnpm; do command -v "$command" >/dev/null || fail "$command is required"; done
[ -f "$PBF_PATH" ] || fail "PBF not found: $PBF_PATH"
mkdir -p "$DATA_DIR/releases"
DATA_DIR=$(cd "$DATA_DIR" && pwd -P)
PBF_PATH=$(cd "$(dirname "$PBF_PATH")" && pwd -P)/$(basename "$PBF_PATH")
RELEASE_DIR="$DATA_DIR/$RELEASE_REL"
LOCK_DIR="$DATA_DIR/.build.lock"
ACTIVE_LINK="$DATA_DIR/active"
PREVIOUS_LINK="$DATA_DIR/previous"
[ ! -L "$DATA_DIR/releases" ] || fail 'releases must not be a symlink'
mkdir "$LOCK_DIR" || fail "another build is active: $LOCK_DIR"
LOCK_ACQUIRED=true
printf 'pid=%s\nhost=%s\nbuild_id=%s\nstarted_at=%s\n' "$$" "$(hostname)" "$BUILD_ID" "$(date -u +%FT%TZ)" >"$LOCK_DIR/owner"
if [ -L "$ACTIVE_LINK" ]; then
  OLD_ACTIVE_TARGET=$(readlink "$ACTIVE_LINK")
  validate_release_target "$OLD_ACTIVE_TARGET" || fail 'active link is not a valid relative release'
  FIRST_DEPLOY=false
elif [ -e "$ACTIVE_LINK" ]; then fail 'active exists but is not a symlink'; fi
[ ! -e "$RELEASE_DIR" ] && [ ! -L "$RELEASE_DIR" ] || fail "release already exists: $RELEASE_REL"
mkdir "$RELEASE_DIR"
mkdir "$RELEASE_DIR/valhalla_tiles" "$RELEASE_DIR/traffic"
SOURCE_HASH=$(hash_file "$PBF_PATH")
cp "$PBF_PATH" "$RELEASE_DIR/source.osm.pbf"
SNAPSHOT_HASH=$(hash_file "$RELEASE_DIR/source.osm.pbf")
[ "$SOURCE_HASH" = "$SNAPSHOT_HASH" ] && [ "$SOURCE_HASH" = "$(hash_file "$PBF_PATH")" ] || fail 'source changed while snapshotting'
chmod a-w "$RELEASE_DIR/source.osm.pbf"
export VALHALLA_DATA_DIR="$DATA_DIR" VALHALLA_PBF_PATH="$RELEASE_DIR/source.osm.pbf" VALHALLA_CANDIDATE_RELEASE="$RELEASE_REL"
COMPOSE_CONFIG=$(docker compose --profile valhalla-build config --format json)
IMAGE=$(printf '%s' "$COMPOSE_CONFIG" | jq -er '.services["valhalla-build"].image')
IMAGE_DIGEST=${IMAGE##*@}
[[ "$IMAGE_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || fail 'Valhalla image must be digest pinned'
printf '%s' "$COMPOSE_CONFIG" | jq -e --arg image "$IMAGE" --arg digest "$IMAGE_DIGEST" '.services.valhalla.image == $image and .services["valhalla-candidate"].image == $image and .services.valhalla.environment.VALHALLA_IMAGE_DIGEST == $digest' >/dev/null || fail 'build/candidate/runtime image mismatch'
docker compose --profile valhalla-build run --build --rm --no-deps road-speed-rules \
  --input /data/input.osm.pbf --output "/custom_files/$RELEASE_REL/road-speed-rules.json" \
  --source-sha256 "$SOURCE_HASH" --metadata-output "/custom_files/$RELEASE_REL/source-metadata.json"
docker compose --profile valhalla-build run --rm --no-deps valhalla-build \
  "valhalla_build_config --mjolnir-tile-dir /custom_files/$RELEASE_REL/valhalla_tiles --mjolnir-traffic-extract /custom_files/$RELEASE_REL/traffic/traffic.tar > /custom_files/$RELEASE_REL/valhalla.json && valhalla_build_tiles -c /custom_files/$RELEASE_REL/valhalla.json /data/input.osm.pbf"
[ "$SOURCE_HASH" = "$(hash_file "$RELEASE_DIR/source.osm.pbf")" ] && [ "$SOURCE_HASH" = "$(hash_file "$PBF_PATH")" ] || fail 'source changed during build'
[ -s "$RELEASE_DIR/valhalla.json" ] || fail 'missing valhalla.json'
jq -e --arg traffic "/custom_files/$RELEASE_REL/traffic/traffic.tar" '.mjolnir.traffic_extract == $traffic' "$RELEASE_DIR/valhalla.json" >/dev/null || fail 'traffic extract must belong to this release'
find "$RELEASE_DIR/valhalla_tiles" -type f -name '*.gph' -size +0c -print -quit | grep -q . || fail 'tile build produced no nonempty .gph files'
TILE_FILES_PRESENT=true
CANDIDATE_STARTED=true
docker compose --profile valhalla-build run --rm -d --no-deps --service-ports --name "$CANDIDATE_NAME" \
  --label "valhalla.build-owner=$CANDIDATE_NAME" valhalla-candidate >/dev/null
[ "$(docker inspect --format '{{.Config.Image}}' "$CANDIDATE_NAME")" = "$IMAGE" ] || fail 'candidate image mismatch'
wait_ready "$CANDIDATE_URL" || fail 'candidate failed readiness'
curl -fsS --max-time 5 "$CANDIDATE_URL/status" >"$RELEASE_DIR/candidate-status.json"
jq -e '.version == "3.9.1" and (.tileset_last_modified | type == "number")' "$RELEASE_DIR/candidate-status.json" >/dev/null || fail 'candidate status is invalid'
VALHALLA_BASE_URL="$CANDIDATE_URL" pnpm exec ts-node --compiler-options '{"module":"CommonJS","moduleResolution":"node"}' \
  src/scripts/verify-valhalla-release.ts "$CANDIDATE_URL" "$RELEASE_DIR/road-speed-rules.json" "$SOURCE_HASH" "$RELEASE_DIR/candidate-verification.json"
[ "$SOURCE_HASH" = "$(hash_file "$RELEASE_DIR/source.osm.pbf")" ] && [ "$SOURCE_HASH" = "$(hash_file "$PBF_PATH")" ] || fail 'source changed during verification'
RULES_HASH=$(hash_file "$RELEASE_DIR/road-speed-rules.json")
jq -e --arg source "$SOURCE_HASH" --arg rules "$RULES_HASH" '.schemaVersion == 1 and .sourcePbfSha256 == $source and .speedRulesSha256 == $rules and (.checks | [.candidateRouting, .airportSigns, .exactGeometry, .speedPartition, .speedTransition, .lanes, .laneApproach, .directionalLimits] | all(. == true))' "$RELEASE_DIR/candidate-verification.json" >/dev/null || fail 'candidate verification result is invalid'

SOURCE_INTEGRITY=true
jq -ncS --argjson sourceIntegrity "$SOURCE_INTEGRITY" --argjson tileFilesPresent "$TILE_FILES_PRESENT" --arg build "$BUILD_ID" --arg built "$(date -u +%FT%TZ)" --arg source "$SOURCE_HASH" --arg image "$IMAGE_DIGEST" --arg rules "$RULES_HASH" \
  --slurpfile metadata "$RELEASE_DIR/source-metadata.json" --slurpfile status "$RELEASE_DIR/candidate-status.json" --slurpfile verified "$RELEASE_DIR/candidate-verification.json" \
  '{schemaVersion:1,buildId:$build,builtAt:$built,sourcePbfSha256:$source,sourcePbfTimestamp:$metadata[0].sourcePbfTimestamp,valhallaImageDigest:$image,speedRulesSha256:$rules,speedRulesSchemaVersion:1,expectedServingStatus:$status[0],validation:($verified[0].checks + {directionalSourceRules:$verified[0].checks.directionalLimits,sourceIntegrity:$sourceIntegrity,tileFilesPresent:$tileFilesPresent,tools:$metadata[0]})}' >"$RELEASE_DIR/manifest.json.tmp"
mv "$RELEASE_DIR/manifest.json.tmp" "$RELEASE_DIR/manifest.json"
if [ "$PROMOTE" = false ]; then printf 'valhalla-build: candidate=%s (not promoted)\n' "$RELEASE_REL"; exit 0; fi
new_link "$RELEASE_REL" "$DATA_DIR/active.next" || fail 'active.next already exists'
[ "$SOURCE_HASH" = "$(hash_file "$RELEASE_DIR/source.osm.pbf")" ] && [ "$SOURCE_HASH" = "$(hash_file "$PBF_PATH")" ] && [ "$RULES_HASH" = "$(hash_file "$RELEASE_DIR/road-speed-rules.json")" ] || fail 'artifacts changed before promotion'
PROMOTION_PENDING=true
replace_link "$DATA_DIR/active.next" "$ACTIVE_LINK"
docker compose up -d valhalla
docker compose restart valhalla >/dev/null
wait_ready http://127.0.0.1:8002 || fail 'new release failed readiness probe'
wait_identity || fail 'runtime serving identity mismatch'
if [ "$FIRST_DEPLOY" = false ]; then
  new_link "$OLD_ACTIVE_TARGET" "$DATA_DIR/previous.next" || fail 'previous.next already exists'
  replace_link "$DATA_DIR/previous.next" "$PREVIOUS_LINK"
fi
COMMITTED=true
printf 'valhalla-build: active=%s\n' "$RELEASE_REL"
