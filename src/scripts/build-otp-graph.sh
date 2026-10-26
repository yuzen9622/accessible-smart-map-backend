#!/usr/bin/env bash
# Complete transport enrichment + government sidewalk compilation, followed by
# native OTP build, candidate verification and atomic active-release publication.
# Persistent data is always repository-local otp-data; no data-path env setup.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_DIR"
DATA_ROOT="$REPO_DIR/otp-data"
OTP_JAVA_XMX="${OTP_JAVA_XMX:-6g}"
OTP_OSM_PBF_URL="${OTP_OSM_PBF_URL:-https://download.geofabrik.de/asia/taiwan-latest.osm.pbf}"
OTP_OSM_BBOX="${OTP_OSM_BBOX:-}"
OTP_GTFS_URLS="${OTP_GTFS_URLS:-https://tdx.transportdata.tw/api/gtfs/V3/Map/GTFS/Static}"
export OTP_GTFS_URLS OTP_JAVA_XMX
OSM_MAX_AGE_DAYS=30
log() { echo "[build-otp-graph] $(date '+%F %T') $*"; }
die() { log "FATAL: $*"; exit 1; }

# A separate session lock serializes the whole build without blocking the source
# importer's (724193,1) transaction. Signals reach the owned shell and its cleanup.
if [ "${1:-}" != "--under-build-lock" ]; then
  [ "$#" -eq 0 ] || die "usage: build-otp-graph.sh"
  bash "$SCRIPT_DIR/otp-preflight.sh" || die "preflight failed — nothing was built"
  exec python3 - "$SCRIPT_DIR/build-otp-graph.sh" <<'BUILD_LOCK'
import os, signal, subprocess, sys, time
import psycopg2
child = None
connection = None
def stop(signum, _frame):
    if child is not None:
        try: os.killpg(child.pid, signum)
        except ProcessLookupError: pass
        try: child.wait(timeout=30)
        except subprocess.TimeoutExpired: os.killpg(child.pid, signal.SIGKILL)
    raise SystemExit(128 + signum)
signal.signal(signal.SIGINT, stop)
signal.signal(signal.SIGTERM, stop)
try:
    connection = psycopg2.connect(os.environ['PED_GRAPH_DATABASE_URL'], connect_timeout=10)
    connection.autocommit = True
    with connection.cursor() as cursor:
        cursor.execute("SET statement_timeout='10s'")
        cursor.execute('SELECT pg_try_advisory_lock(724193,2)')
        if not cursor.fetchone()[0]: raise RuntimeError('another OTP build is running')
    child = subprocess.Popen(['bash', sys.argv[1], '--under-build-lock'], start_new_session=True)
    until = time.monotonic() + 6 * 60 * 60
    while child.poll() is None:
        with connection.cursor() as cursor: cursor.execute('SELECT 1')
        if time.monotonic() >= until: raise TimeoutError('build exceeded six hours')
        time.sleep(5)
    raise SystemExit(child.wait())
except Exception:
    if child is not None and child.poll() is None:
        os.killpg(child.pid, signal.SIGTERM)
        try: child.wait(timeout=30)
        except subprocess.TimeoutExpired: os.killpg(child.pid, signal.SIGKILL)
    print('[build-otp-graph] Cannot acquire or retain the OTP build lock; verify PostGIS and other builds.', file=sys.stderr)
    raise SystemExit(1)
finally:
    if connection is not None: connection.close()
BUILD_LOCK
fi
shift
[ "$#" -eq 0 ] || die "unexpected build arguments"
mkdir -p "$DATA_ROOT/releases"
RELEASE_DIR="$(mktemp -d "$DATA_ROOT/releases/release-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")"
WORK_DIR="$RELEASE_DIR/inputs"
EVIDENCE_DIR="$RELEASE_DIR/evidence"
AUX_DIR="$RELEASE_DIR/sources"
ARTIFACT_DIR="$RELEASE_DIR/artifacts"
VALIDATION_DIR="$EVIDENCE_DIR/validation"
mkdir "$WORK_DIR" "$EVIDENCE_DIR" "$AUX_DIR" "$ARTIFACT_DIR" "$VALIDATION_DIR"
RELEASE_NAME="$(basename "$RELEASE_DIR")"
BUILD_CONTAINER="otp-build-$RELEASE_NAME"
EXPORT_CONTAINER="otp-artifacts-$RELEASE_NAME"
OTP_STOPPED_BY_SCRIPT=0
OTP_RESTART_HANDLED=0
cleanup() {
  exit_status=$?
  trap - EXIT INT TERM
  docker rm -f "$BUILD_CONTAINER" "$EXPORT_CONTAINER" >/dev/null 2>&1 || true
  if [ "$OTP_STOPPED_BY_SCRIPT" -eq 1 ] && [ "$OTP_RESTART_HANDLED" -eq 0 ]; then
    log "attempting to restart the previous serving container"
    docker start otp >/dev/null 2>&1 || log "WARN: OTP could not be restarted; release files are retained"
  fi
  log "release retained at $RELEASE_DIR"
  exit "$exit_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

SOURCE_VERSION="$(python3 - <<'SOURCE'
import os, sys, psycopg2
try:
    with psycopg2.connect(os.environ['PED_GRAPH_DATABASE_URL'], connect_timeout=10) as connection:
        with connection.cursor() as cursor:
            cursor.execute("SET statement_timeout='10s'")
            cursor.execute("SELECT id::text FROM ped_sidewalk_source_version WHERE lifecycle_status='ACTIVE'")
            rows=cursor.fetchall()
            if len(rows)!=1: raise ValueError('expected one ACTIVE source')
            print(rows[0][0])
except Exception:
    print('Cannot read the unique ACTIVE sidewalk source; run pnpm import:sidewalks first.', file=sys.stderr)
    sys.exit(1)
SOURCE
)" || die "cannot select government sidewalk source"

log "building the reviewed native OTP image"
docker compose build otp || die "native OTP image build failed"
OTP_IMAGE="$(docker image inspect accessible-smart-map-otp:local --format '{{.Id}}')"
printf '%s\n' "$OTP_IMAGE" > "$EVIDENCE_DIR/runtime-image-id.txt"
docker create --name "$EXPORT_CONTAINER" "$OTP_IMAGE" >/dev/null
docker cp "$EXPORT_CONTAINER:/opt/otp-policy/." "$ARTIFACT_DIR/"
docker rm "$EXPORT_CONTAINER" >/dev/null
cmp "$REPO_DIR/src/otp/reviewed-policies.json" "$ARTIFACT_DIR/reviewed-policies.json" || die "native image differs from backend reviewed policies"

# ── 1. GTFS feeds (TDX OAuth2 client_credentials, same flow as TdxTokenManger) ──
log "fetching TDX access token"
TOKEN=$(curl -fsS -X POST \
  "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials&client_id=${TDX_CLIENT_ID}&client_secret=${TDX_CLIENT_SECRET}" |
  python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])") ||
  die "TDX token acquisition failed"

i=0
for url in $OTP_GTFS_URLS; do
  i=$((i + 1))
  out="$WORK_DIR/feed-${i}.gtfs.zip"
  log "downloading GTFS feed $i: $url"
  curl -fsSL -H "Authorization: Bearer $TOKEN" -o "$out" "$url" ||
    die "GTFS download failed: $url"
  unzip -l "$out" >/dev/null 2>&1 || die "GTFS feed $i is not a valid zip"
  # TDX feed quality fixes (duplicate ids, broken refs, self-loop pathways —
  # the latter build a graph that NPEs on load). See clean-gtfs-feed.py.
  if [ "$i" -eq 1 ]; then
    log "patching feed $i with general (weekly) timetables"
    python3 "$SCRIPT_DIR/patch_gtfs.py" "$out" || die "patch_gtfs.py failed, so bus schedule backfill is entirely missing; continuing would produce a graph with unusable bus data that step 5 auto-promotes to production — aborting and keeping the old graph"
  else
    log "skipping timetable patching for feed $i (city-specific static feed)"
  fi
  log "cleaning feed $i"
  python3 "$SCRIPT_DIR/clean-gtfs-feed.py" "$out" || die "feed cleaning failed: $out"
done

# ── 1b. TRA timetable injection (Phase 16.5) — the national feed carries TRA
# stops but no timetable, and TDX's rail GTFS endpoint only serves TRTC, so
# the TRA schedule is converted from the v3 JSON API into feed-1. Fail-soft:
# a build without TRA legs (MaaS planner covers them) beats no build at all.
log "fetching TRA general timetable"
if curl -fsSL --compressed -H "Authorization: Bearer $TOKEN" \
  -o "$AUX_DIR/tra-timetable.json" \
  "https://tdx.transportdata.tw/api/basic/v3/Rail/TRA/GeneralTrainTimetable?%24format=JSON"; then
  # Track geometry (Rail/TRA/Shape — WKT LINESTRING per line) so injected TRA
  # trips follow the rails instead of drawing station-to-station straight lines.
  # Fail-soft: a missing/failed Shape just leaves trips shapeless (legacy).
  sleep 3 # TDX 429s on bursts
  TRA_SHAPE_ARGS=()
  if curl -fsSL --compressed -H "Authorization: Bearer $TOKEN" \
    -o "$AUX_DIR/tra-shape.json" \
    "https://tdx.transportdata.tw/api/basic/v3/Rail/TRA/Shape?%24format=JSON"; then
    TRA_SHAPE_ARGS=("$AUX_DIR/tra-shape.json")
  else
    log "WARN: TRA Shape download failed — injecting TRA without track geometry"
  fi
  python3 "$SCRIPT_DIR/inject-tra-gtfs.py" \
    "$WORK_DIR/feed-1.gtfs.zip" "$AUX_DIR/tra-timetable.json" "${TRA_SHAPE_ARGS[@]}" ||
    log "WARN: TRA injection failed — continuing without TRA legs"
else
  log "WARN: TRA timetable download failed — continuing without TRA legs"
fi

# Fail before OSM processing / graph build, including when the fail-soft TRA
# enrichment above could not repair the native feed. Promotion repeats this
# check against the actual candidate feed and does not rely on a baseline.
log "checking TRA stop-to-shape alignment"
python3 "$SCRIPT_DIR/verify-otp-graph.py" --feed-only --feed "$WORK_DIR/feed-1.gtfs.zip" ||
  die "TRA shape alignment failed — keeping the old graph"

# ── 1b-bis. Official TRTC (Taipei Metro) GTFS injection — must run BEFORE the
# metro block (1c). TDX's V3 GTFS-static rail endpoint serves an official per-trip
# feed ONLY for TRTC (every other operator 400s), including 文湖線(Brown), which the
# national feed ships with ZERO trips. This grafts the official Brown frequency
# schedule + its own service calendar onto the feed so 文湖線 uses real operator
# data instead of inject-metro-gtfs.py's synthetic headway fill. Because Brown then
# has trips, the metro block's 0-trip gap-detection skips it (no duplicate line).
# Fail-soft and additive: it never touches pathways/levels/other lines, and any
# gap (download fail, unmatched direction) leaves the feed unchanged for the metro
# fallback. See inject-trtc-official-gtfs.py.
sleep 3 # TDX 429s on bursts
if curl -fsSL --compressed -H "Authorization: Bearer $TOKEN" \
  -o "$AUX_DIR/trtc-official.gtfs.zip" \
  "https://tdx.transportdata.tw/api/gtfs/V3/Map/GTFS/Static/Rail/TRTC"; then
  if unzip -l "$AUX_DIR/trtc-official.gtfs.zip" >/dev/null 2>&1; then
    python3 "$SCRIPT_DIR/inject-trtc-official-gtfs.py" \
      "$WORK_DIR/feed-1.gtfs.zip" "$AUX_DIR/trtc-official.gtfs.zip" ||
      log "WARN: official TRTC injection failed — continuing (metro block synthesizes 文湖線)"
  else
    log "WARN: official TRTC GTFS is not a valid zip — skipping (metro block synthesizes 文湖線)"
  fi
else
  log "WARN: official TRTC GTFS download failed — continuing (metro block synthesizes 文湖線)"
fi

# ── 1c. Metro/LRT frequency injection — same gap as TRA, one tier down: the
# national feed defines these lines' routes + stops but ships ZERO trips for
# 文湖線(TRTC BR)、環狀線(NTMC Y)、台中綠線(TMRT G)、機捷一方向, so OTP can't
# board them and the leg falls back to the MaaS planner (which returns bus).
# TDX has no per-train metro timetable — it runs on headways — so the schedule
# is synthesised from S2STravelTime (ride pattern) + Frequency (headway) into a
# frequency-based GTFS, injected into feed-1. 淡海/安坑輕軌、貓空纜車 are NOT
# gap-filled by design: TDX serves no S2STravelTime for them (the gondola has
# none; the LRTs aren't valid Metro RailSystem codes), so they stay 0-trips on
# the MaaS fallback — the injector still lists them under "skipped". Calls are
# spaced (TDX 429s on bursts); each is fail-soft and the injector skips any line
# whose TDX data is absent — a build missing some metro lines beats no build.
METRO_DIR="$AUX_DIR/metro"
mkdir -p "$METRO_DIR"
METRO_SYSTEMS="${OTP_METRO_SYSTEMS:-TRTC NTMC TMRT TYMC}"
METRO_BASE="https://tdx.transportdata.tw/api/basic/v2/Rail/Metro"
log "fetching metro S2STravelTime + Frequency + Shape: $METRO_SYSTEMS"
for sys in $METRO_SYSTEMS; do
  curl -fsSL --compressed -H "Authorization: Bearer $TOKEN" \
    -o "$METRO_DIR/$sys.s2s.json" \
    "$METRO_BASE/S2STravelTime/$sys?%24format=JSON" ||
    log "WARN: metro S2STravelTime fetch failed for $sys"
  sleep 3
  curl -fsSL --compressed -H "Authorization: Bearer $TOKEN" \
    -o "$METRO_DIR/$sys.freq.json" \
    "$METRO_BASE/Frequency/$sys?%24format=JSON" ||
    log "WARN: metro Frequency fetch failed for $sys"
  sleep 3
  curl -fsSL --compressed -H "Authorization: Bearer $TOKEN" \
    -o "$METRO_DIR/$sys.shape.json" \
    "$METRO_BASE/Shape/$sys?%24format=JSON" ||
    log "WARN: metro Shape fetch failed for $sys"
  sleep 3
done
python3 "$SCRIPT_DIR/inject-metro-gtfs.py" \
  "$WORK_DIR/feed-1.gtfs.zip" "$METRO_DIR" ||
  log "WARN: metro injection failed — continuing without metro gap-fill"

# ── 1d. Stop wheelchair_boarding injection — the TDX feed ships no
# wheelchair_boarding column, so OTP treats every stop as unknown accessibility
# (stop.unknownCost applies flat to all 160k+ stops, no differentiation). The TDX
# Metro StationFacility API lists each station's Elevators; this sets
# wheelchair_boarding=1 on stations that have one, so OTP's wheelchair routing
# prefers them. See inject-station-wheelchair.py for the (top-level Elevators list,
# StationID-keyed) response shape. Coverage: KRTC/TYMC/TMRT/NTMC carry data;
# TRTC returns 0 (known gap → OSM backfill later); 高雄輕軌 (KLRT) has NO
# StationFacility (400 — not in that endpoint's RailSystem enum) so it's dropped
# and left to OSM backfill; TRA/THSR StationFacility 404 (no such API) so rail
# stations aren't covered here. FACILITY_SYSTEMS is its own list (NOT
# OTP_METRO_SYSTEMS, which is only the 0-trips gap-fill set and omits KRTC).
# Fail-soft: a build without these flags (today's behaviour) beats no build at all.
FACILITY_SYSTEMS="${OTP_FACILITY_SYSTEMS:-TRTC KRTC TYMC TMRT NTMC}"
FACILITY_DIR="$AUX_DIR/facility"
mkdir -p "$FACILITY_DIR"
log "fetching Metro StationFacility (wheelchair): $FACILITY_SYSTEMS"
for sys in $FACILITY_SYSTEMS; do
  curl -fsSL --compressed -H "Authorization: Bearer $TOKEN" \
    -o "$FACILITY_DIR/$sys.facility.json" \
    "$METRO_BASE/StationFacility/$sys?%24format=JSON" ||
    log "WARN: metro StationFacility fetch failed for $sys"
  sleep 3
done
python3 "$SCRIPT_DIR/inject-station-wheelchair.py" \
  "$WORK_DIR/feed-1.gtfs.zip" "$FACILITY_DIR" ||
  log "WARN: station wheelchair injection failed — continuing"

# ── 1e. TRTC local database wheelchair injection ──
log "injecting TRTC station wheelchair flags from local MongoDB accessibilities"
pnpm exec ts-node "$SCRIPT_DIR/inject-db-a11y-stops.ts" "$WORK_DIR/feed-1.gtfs.zip" ||
  log "WARN: TRTC local database injection failed — continuing"

# ── 1f. Trip wheelchair accessibility injection ──
# route_type==1 (metro/light rail/gondola) gets wheelchair_accessible=1;
# route_type==3 (bus) stays 0 (unknown); an existing 1 (TRA WheelChairFlag,
# official TRTC feed) and a 2 the source feed published are preserved. Never
# infers 2 (inaccessible) — router-config sets trip.inaccessibleCost=3600, which
# would push wheelchair journeys off an entire city's bus network. Bus route
# low-floor history is a ranking signal in the backend, not a trip flag here.
# Pure CSV transform; no MongoDB needed.
log "injecting trip wheelchair accessibility flags (route_type based)"
pnpm exec ts-node "$SCRIPT_DIR/inject-tdx-bus-trips-a11y.ts" "$WORK_DIR/feed-1.gtfs.zip" ||
  die "trip accessibility injection failed — keeping the previous release"

# ── 1g. Merge co-located duplicate bus stops ──
# TDX ships one stop per route at a shared pole (~156k boarding stops at ~66k
# places), which saturates OTP's access/egress stop cap and multiplies transfer
# work. The merge is all-or-nothing (atomic zip replace): if it fails the feed
# is unchanged and the build continues unmerged. Once merged, the aliases that
# map each route back to its own TDX StopUID MUST be stored, or the backend
# would return merged ids — so an alias import failure aborts the build and
# keeps the old graph. See merge-gtfs-duplicate-stops.py.
STOP_ALIASES="$EVIDENCE_DIR/stop-aliases.json"
log "merging co-located duplicate bus stops"
if python3 "$SCRIPT_DIR/merge-gtfs-duplicate-stops.py" "$WORK_DIR/feed-1.gtfs.zip" "$STOP_ALIASES"; then
  pnpm exec ts-node "$SCRIPT_DIR/import-gtfs-stop-aliases.ts" "$STOP_ALIASES" ||
    die "stop alias import failed — a merged graph without aliases would return wrong stop ids; keeping the old graph"
else
  log "WARN: duplicate stop merge failed — continuing with the unmerged feed"
fi

# ── 2. OSM extract (monthly refresh, spec §5) ──
OSM_CACHE="$DATA_ROOT/taiwan-latest.osm.pbf"
OSM_CLIPPED="$AUX_DIR/taiwan-clipped.osm.pbf"
OSM_WALK_SAFE="${OSM_CLIPPED%.osm.pbf}.walk-safe.osm.pbf"
if [ ! -f "$OSM_CACHE" ] || [ -n "$(find "$OSM_CACHE" -mtime +$OSM_MAX_AGE_DAYS 2>/dev/null)" ]; then
  log "refreshing OSM pbf from Geofabrik"
  curl -fsSL -o "$OSM_CACHE.tmp" "$OTP_OSM_PBF_URL" || die "OSM download failed"
  mv "$OSM_CACHE.tmp" "$OSM_CACHE"
else
  log "OSM pbf is fresh (< ${OSM_MAX_AGE_DAYS}d), skipping download"
fi
if [ -z "$OTP_OSM_BBOX" ]; then
  log "no OTP_OSM_BBOX set — building with the full Taiwan pbf"
  cp "$OSM_CACHE" "$OSM_CLIPPED"
elif command -v osmium >/dev/null 2>&1; then
  log "clipping OSM to bbox $OTP_OSM_BBOX"
  osmium extract -b "$OTP_OSM_BBOX" -o "$OSM_CLIPPED" --overwrite "$OSM_CACHE" ||
    die "osmium extract failed"
else
  log "WARN: osmium not installed — building with the full Taiwan pbf"
  cp "$OSM_CACHE" "$OSM_CLIPPED"
fi

# ── 2b. National 20 m DTM for OTP's own elevation module ──
# OTP derives street slopes only from GeoTIFFs in its build directory (OSM
# `incline` tags are ignored), and without them wheelchair maxSlope and the
# slope-aware walk time are inert. The copy into WORK_DIR happens in step 4.
DEM_DIR="$DATA_ROOT/dem"
log "refreshing the national 20 m DTM in $DEM_DIR"
python3 "$SCRIPT_DIR/fetch-otp-dem.py" "$DEM_DIR" ||
  log "WARN: DTM refresh failed — building with whatever DEM is already in $DEM_DIR"

log "hardening pedestrian access tags for expressways and stairs"
python3 "$SCRIPT_DIR/deny-foot-on-expressways.py" \
  "$OSM_CLIPPED" "$OSM_WALK_SAFE" ||
  die "pedestrian access hardening failed — keeping old graph"
[ -f "$OSM_WALK_SAFE" ] ||
  die "pedestrian access hardening produced no PBF — keeping old graph"
mv "$OSM_WALK_SAFE" "$OSM_CLIPPED"

# ── 3. Feed validation gate (red light = abort, old graph keeps serving) ──
# Reports MUST land outside WORK_DIR: OTP scans its data directory and classifies
# anything named *.gtfs as a transit bundle, so a `validation-feed-1.gtfs` report
# directory sitting next to the feed makes `otp --build` abort on the report's
# missing agency.txt.
if command -v gtfs-validator >/dev/null 2>&1; then
  for zip in "$WORK_DIR"/feed-*.gtfs.zip; do
    log "validating $(basename "$zip")"
    gtfs-validator -i "$zip" -o "$VALIDATION_DIR/$(basename "$zip" .zip)" ||
      die "gtfs-validator reported errors for $zip — keeping old graph"
  done
else
  log "WARN: gtfs-validator not installed — skipping validation gate"
fi

# Rail/metro calendars only cover the window TDX publishes and the injection
# steps above are fail-soft, so a feed can validate cleanly yet carry no TRA at
# all, or end within days. Promoting it would silently decay routing to
# bus-only; keep the old graph instead (the backend's freshness check alerts).
for zip in "$WORK_DIR"/feed-*.gtfs.zip; do
  log "checking rail/metro service window of $(basename "$zip")"
  python3 "$SCRIPT_DIR/check-feed-service-window.py" "$zip" \
    --min-days "${OTP_MIN_RAIL_DAYS:-14}" ||
    die "rail/metro timetables in $(basename "$zip") are missing or end within ${OTP_MIN_RAIL_DAYS:-14} days — keeping old graph"
done


# ── 4. Freeze the exact native inputs before Java sees them ──
cp "$DATA_ROOT/otp-config.json" "$DATA_ROOT/router-config.json" "$WORK_DIR/"
python3 - "$DATA_ROOT/build-config.json" "$WORK_DIR/build-config.json" <<'CONFIG'
import json, sys
from pathlib import Path
config=json.loads(Path(sys.argv[1]).read_text())
config.update(readCachedElevations=False, writeCachedElevations=False,
              islandPruning={'islandWithStopsMaxSize':0,'islandWithoutStopsMaxSize':0})
Path(sys.argv[2]).write_text(json.dumps(config,ensure_ascii=False,indent=2)+'\n')
CONFIG
[ -f "$DEM_DIR/taiwan-dtm-20m.tif" ] || die "national DEM is required for wheelchair slope evaluation"
python3 - "$DEM_DIR/taiwan-dtm-20m.tif" <<'DEM'
import rasterio, sys
with rasterio.open(sys.argv[1]) as raster:
    assert raster.crs.to_epsg()==4326 and raster.count==1 and raster.width>0 and raster.height>0
DEM
cp "$DEM_DIR/taiwan-dtm-20m.tif" "$WORK_DIR/"
log "compiling government sidewalk source $SOURCE_VERSION into the OTP PBF"
python3 "$SCRIPT_DIR/otp-sidewalk-layer.py" --pbf "$OSM_CLIPPED" \
  --db-url-env PED_GRAPH_DATABASE_URL --source-version "$SOURCE_VERSION" \
  --output "$WORK_DIR/merged.osm.pbf" --report "$EVIDENCE_DIR/layer-report.json" ||
  die "government sidewalk compilation failed"

# macOS can create AppleDouble metadata on exFAT; only candidate-owned metadata
# is removed, before the manifest freezes the complete input inventory.
find "$WORK_DIR" -name '._*' -type f -delete
while IFS= read -r zip; do
  case "${zip#"$WORK_DIR"/}" in
    feed-*.gtfs.zip) ;;
    *) die "unexpected ZIP in OTP inputs: ${zip#"$WORK_DIR"/}" ;;
  esac
done < <(find "$WORK_DIR" -type f -name '*.zip')
POLICY_MANIFEST_PIN="$(python3 - "$ARTIFACT_DIR/reviewed-policies.json" <<'PIN'
import json,sys
print(json.load(open(sys.argv[1]))[0]['manifestSha256'])
PIN
)"
python3 "$SCRIPT_DIR/otp-build-manifest.py" prepare --inputs "$WORK_DIR" \
  --report "$EVIDENCE_DIR/layer-report.json" --compiler-root "$SCRIPT_DIR" \
  --policy-manifest "$ARTIFACT_DIR/policy-manifest.json" \
  --policy-manifest-sha256 "$POLICY_MANIFEST_PIN" \
  --out "$EVIDENCE_DIR/prepared-build-manifest.json" > "$EVIDENCE_DIR/prepare-result.json"
PREPARED_PIN="$(python3 - "$EVIDENCE_DIR/prepare-result.json" <<'PIN'
import json,sys
print(json.load(open(sys.argv[1]))['sha256'])
PIN
)"

# Keep the existing service interruption for memory headroom. The old graph and
# active pointer remain untouched until both candidate verification gates pass.
docker info >/dev/null 2>&1 || die "Docker daemon is unavailable"
if docker container inspect otp >/dev/null 2>&1; then
  OTP_WAS_RUNNING="$(docker container inspect -f '{{.State.Running}}' otp)"
else
  OTP_WAS_RUNNING=absent
fi
if [ "$OTP_WAS_RUNNING" = true ]; then
  OTP_STOPPED_BY_SCRIPT=1
  docker stop otp >/dev/null || die "failed to stop OTP before building"
fi
log "building native graph with pinned image $OTP_IMAGE (heap $OTP_JAVA_XMX)"
docker run --rm --name "$BUILD_CONTAINER" --pull=never --network=none \
  -e JAVA_TOOL_OPTIONS="-Xmx${OTP_JAVA_XMX}" \
  -v "$WORK_DIR:/var/opentripplanner" \
  "$OTP_IMAGE" --build --save --abortOnUnknownConfig || die "native OTP graph build failed"
[ -f "$WORK_DIR/graph.obj" ] || die "build produced no graph.obj"
python3 "$SCRIPT_DIR/otp-build-manifest.py" finish \
  --prepared "$EVIDENCE_DIR/prepared-build-manifest.json" --expected-pin "$PREPARED_PIN" \
  --out "$EVIDENCE_DIR/build-manifest.json" > "$EVIDENCE_DIR/finish-result.json"

# ── 5. Existing transit gates + real backend native walk gates, then publish ──
bash "$SCRIPT_DIR/promote-otp-graph.sh" "$RELEASE_DIR" "$OTP_IMAGE" --under-build-lock ||
  die "candidate could not be promoted; previous release files are retained"
OTP_RESTART_HANDLED=1
log "native OTP release is serving"
