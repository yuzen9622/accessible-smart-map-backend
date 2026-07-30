#!/usr/bin/env bash
#
# Phase 16 OTP2 graph build pipeline (spec §5) — cron-driven, weekly:
#   1. fetch the TDX GTFS static feed(s)        (every run)
#   2. refresh + clip the Taiwan OSM extract    (only when older than 30 days)
#   3. gate on gtfs-validator errors            (abort keeps the old graph)
#   4. stop serving briefly; otp --build --save offline in a temp dir
#   5. atomic swap of graph.obj + container restart + healthcheck
#
# Required env:
#   TDX_CLIENT_ID / TDX_CLIENT_SECRET   TDX OAuth2 client credentials
#   OTP_GTFS_URLS                       space-separated GTFS zip URLs (TDX)
# Optional env:
#   OTP_DATA_DIR     (default /var/otp)
#   OTP_OSM_PBF_URL  (default Geofabrik Taiwan)
#   OTP_OSM_BBOX     osmium extract bbox "minLng,minLat,maxLng,maxLat".
#                    UNSET (default) = no clipping, full Taiwan coverage.
#                    Taichung-only example: 120.40,23.95,121.05,24.45
#   OTP_JAVA_XMX     build heap (default 12g — national feed + full Taiwan OSM;
#                    a single-city clip builds fine with 8g)
#   OTP_METRO_SYSTEMS  space-separated TDX metro systems to gap-fill (default
#                    "TRTC NTMC TMRT TYMC" — the feed's 0-trips systems that the
#                    TDX Metro S2STravelTime API actually serves). Deliberately
#                    dropped — no usable TDX data, so they stay 0-trips and the
#                    MaaS planner covers the leg: 貓空纜車 (TRTCMG — has no
#                    S2STravelTime/Frequency, only static endpoints) and 淡海/安坑
#                    輕軌 (feed prefix NTDLRT/NTALRT are not valid Metro RailSystem
#                    codes). See inject-metro-gtfs.py.
#
# Suggested cron (spec §9):  0 4 * * 0  /path/to/build-otp-graph.sh
set -euo pipefail

OTP_DATA_DIR="${OTP_DATA_DIR:-/var/otp}"
OTP_OSM_PBF_URL="${OTP_OSM_PBF_URL:-https://download.geofabrik.de/asia/taiwan-latest.osm.pbf}"
OTP_OSM_BBOX="${OTP_OSM_BBOX:-}" # empty = full Taiwan (no clipping)
OTP_JAVA_XMX="${OTP_JAVA_XMX:-12g}"
OTP_IMAGE="opentripplanner/opentripplanner:2.9.0"
OSM_MAX_AGE_DAYS=30

WORK_DIR="$(mktemp -d /tmp/otp-build.XXXXXX)"
VALIDATION_DIR="$(mktemp -d /tmp/otp-validation.XXXXXX)"
# Injection *inputs* (raw upstream bundles that are read, grafted into feed-1 and
# then thrown away) MUST live outside WORK_DIR: OTP scans its data directory and
# ingests every *.zip it finds there as a transit feed of its own. A raw bundle
# left beside feed-1 therefore loads as a full duplicate network — and since those
# bundles carry no shapes.txt, whichever trip the planner picks from the duplicate
# renders as station-to-station straight lines.
AUX_DIR="$(mktemp -d /tmp/otp-aux.XXXXXX)"
log() { echo "[build-otp-graph] $(date '+%F %T') $*"; }
die() { log "FATAL: $*"; exit 1; }

OTP_STOPPED_BY_SCRIPT=0
OTP_RESTART_HANDLED=0

cleanup() {
  exit_status=$?
  trap - EXIT INT TERM
  if [ "$OTP_STOPPED_BY_SCRIPT" -eq 1 ] && [ "$OTP_RESTART_HANDLED" -eq 0 ]; then
    log "restarting otp container during cleanup"
    docker compose restart otp || docker restart otp || true
  fi
  rm -rf "$WORK_DIR" "$VALIDATION_DIR" "$AUX_DIR" || true
  exit "$exit_status"
}

on_signal() {
  exit "$1"
}

trap cleanup EXIT
trap 'on_signal 130' INT
trap 'on_signal 143' TERM

[ -n "${TDX_CLIENT_ID:-}" ] || die "TDX_CLIENT_ID not set"
[ -n "${TDX_CLIENT_SECRET:-}" ] || die "TDX_CLIENT_SECRET not set"
[ -n "${OTP_GTFS_URLS:-}" ] || die "OTP_GTFS_URLS not set"
[ -d "$OTP_DATA_DIR" ] || die "OTP_DATA_DIR $OTP_DATA_DIR does not exist"

# ── 1. GTFS feeds (TDX OAuth2 client_credentials, same flow as TdxTokenManger) ──
log "fetching TDX access token"
TOKEN=$(curl -fsS -X POST \
  "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials&client_id=${TDX_CLIENT_ID}&client_secret=${TDX_CLIENT_SECRET}" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])") \
  || die "TDX token acquisition failed"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
i=0
for url in $OTP_GTFS_URLS; do
  i=$((i + 1))
  out="$WORK_DIR/feed-${i}.gtfs.zip"
  log "downloading GTFS feed $i: $url"
  curl -fsSL -H "Authorization: Bearer $TOKEN" -o "$out" "$url" \
    || die "GTFS download failed: $url"
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
  -o "$WORK_DIR/tra-timetable.json" \
  "https://tdx.transportdata.tw/api/basic/v3/Rail/TRA/GeneralTrainTimetable?%24format=JSON"; then
  # Track geometry (Rail/TRA/Shape — WKT LINESTRING per line) so injected TRA
  # trips follow the rails instead of drawing station-to-station straight lines.
  # Fail-soft: a missing/failed Shape just leaves trips shapeless (legacy).
  sleep 3 # TDX 429s on bursts
  TRA_SHAPE_ARG=""
  if curl -fsSL --compressed -H "Authorization: Bearer $TOKEN" \
    -o "$WORK_DIR/tra-shape.json" \
    "https://tdx.transportdata.tw/api/basic/v3/Rail/TRA/Shape?%24format=JSON"; then
    TRA_SHAPE_ARG="$WORK_DIR/tra-shape.json"
  else
    log "WARN: TRA Shape download failed — injecting TRA without track geometry"
  fi
  python3 "$SCRIPT_DIR/inject-tra-gtfs.py" \
    "$WORK_DIR/feed-1.gtfs.zip" "$WORK_DIR/tra-timetable.json" $TRA_SHAPE_ARG \
    || log "WARN: TRA injection failed — continuing without TRA legs"
else
  log "WARN: TRA timetable download failed — continuing without TRA legs"
fi

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
      "$WORK_DIR/feed-1.gtfs.zip" "$AUX_DIR/trtc-official.gtfs.zip" \
      || log "WARN: official TRTC injection failed — continuing (metro block synthesizes 文湖線)"
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
METRO_DIR="$WORK_DIR/metro"
mkdir -p "$METRO_DIR"
METRO_SYSTEMS="${OTP_METRO_SYSTEMS:-TRTC NTMC TMRT TYMC}"
METRO_BASE="https://tdx.transportdata.tw/api/basic/v2/Rail/Metro"
log "fetching metro S2STravelTime + Frequency + Shape: $METRO_SYSTEMS"
for sys in $METRO_SYSTEMS; do
  curl -fsSL --compressed -H "Authorization: Bearer $TOKEN" \
    -o "$METRO_DIR/$sys.s2s.json" \
    "$METRO_BASE/S2STravelTime/$sys?%24format=JSON" \
    || log "WARN: metro S2STravelTime fetch failed for $sys"
  sleep 3
  curl -fsSL --compressed -H "Authorization: Bearer $TOKEN" \
    -o "$METRO_DIR/$sys.freq.json" \
    "$METRO_BASE/Frequency/$sys?%24format=JSON" \
    || log "WARN: metro Frequency fetch failed for $sys"
  sleep 3
  curl -fsSL --compressed -H "Authorization: Bearer $TOKEN" \
    -o "$METRO_DIR/$sys.shape.json" \
    "$METRO_BASE/Shape/$sys?%24format=JSON" \
    || log "WARN: metro Shape fetch failed for $sys"
  sleep 3
done
python3 "$SCRIPT_DIR/inject-metro-gtfs.py" \
  "$WORK_DIR/feed-1.gtfs.zip" "$METRO_DIR" \
  || log "WARN: metro injection failed — continuing without metro gap-fill"

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
FACILITY_DIR="$WORK_DIR/facility"
mkdir -p "$FACILITY_DIR"
log "fetching Metro StationFacility (wheelchair): $FACILITY_SYSTEMS"
for sys in $FACILITY_SYSTEMS; do
  curl -fsSL --compressed -H "Authorization: Bearer $TOKEN" \
    -o "$FACILITY_DIR/$sys.facility.json" \
    "$METRO_BASE/StationFacility/$sys?%24format=JSON" \
    || log "WARN: metro StationFacility fetch failed for $sys"
  sleep 3
done
python3 "$SCRIPT_DIR/inject-station-wheelchair.py" \
  "$WORK_DIR/feed-1.gtfs.zip" "$FACILITY_DIR" \
  || log "WARN: station wheelchair injection failed — continuing"

# ── 1e. TRTC local database wheelchair injection ──
log "injecting TRTC station wheelchair flags from local MongoDB accessibilities"
npx dotenvx run -- ts-node "$SCRIPT_DIR/inject-db-a11y-stops.ts" "$WORK_DIR/feed-1.gtfs.zip" \
  || log "WARN: TRTC local database injection failed — continuing"

# ── 1f. Bus trip wheelchair accessibility injection ──
log "injecting bus trip wheelchair accessibility flags from TDX schedules"
npx dotenvx run -- ts-node "$SCRIPT_DIR/inject-tdx-bus-trips-a11y.ts" "$WORK_DIR/feed-1.gtfs.zip" \
  || log "WARN: bus trip accessibility injection failed — continuing"

# ── 1g. Bus stop logical clustering (parent_station) ──
log "generating logical parent stations for nearby bus stops"
npx dotenvx run -- ts-node "$SCRIPT_DIR/generate-gtfs-parents.ts" "$WORK_DIR/feed-1.gtfs.zip" \
  || log "WARN: parent station generation failed — continuing"



# ── 2. OSM extract (monthly refresh, spec §5) ──
OSM_CACHE="$OTP_DATA_DIR/taiwan-latest.osm.pbf"
OSM_CLIPPED="$WORK_DIR/taiwan-clipped.osm.pbf"
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
  osmium extract -b "$OTP_OSM_BBOX" -o "$OSM_CLIPPED" --overwrite "$OSM_CACHE" \
    || die "osmium extract failed"
else
  log "WARN: osmium not installed — building with the full Taiwan pbf"
  cp "$OSM_CACHE" "$OSM_CLIPPED"
fi

# ── 2b. Inject road slopes from DEM GeoTIFFs ──
log "injecting road slopes from DEM GeoTIFFs..."
python3 "$SCRIPT_DIR/inject-osm-dem-slopes.py" \
  "$OSM_CLIPPED" "$OSM_CLIPPED.enriched" "${OTP_DEM_DIR:-$OTP_DATA_DIR/dem}" \
  || log "WARN: DEM slope injection failed — continuing"
if [ -f "$OSM_CLIPPED.enriched" ]; then
  mv "$OSM_CLIPPED.enriched" "$OSM_CLIPPED"
fi

# ── 3. Feed validation gate (red light = abort, old graph keeps serving) ──
# Reports MUST land outside WORK_DIR: OTP scans its data directory and classifies
# anything named *.gtfs as a transit bundle, so a `validation-feed-1.gtfs` report
# directory sitting next to the feed makes `otp --build` abort on the report's
# missing agency.txt.
if command -v gtfs-validator >/dev/null 2>&1; then
  for zip in "$WORK_DIR"/feed-*.gtfs.zip; do
    log "validating $(basename "$zip")"
    gtfs-validator -i "$zip" -o "$VALIDATION_DIR/$(basename "$zip" .zip)" \
      || die "gtfs-validator reported errors for $zip — keeping old graph"
  done
else
  log "WARN: gtfs-validator not installed — skipping validation gate"
fi

# ── 4. Brief service interruption: stop OTP for the offline temp-dir build ──
cp "$OTP_DATA_DIR"/otp-config.json "$OTP_DATA_DIR"/build-config.json \
  "$OTP_DATA_DIR"/router-config.json "$WORK_DIR/" 2>/dev/null \
  || die "OTP config files missing in $OTP_DATA_DIR"
mv "$OSM_CLIPPED" "$WORK_DIR/taiwan-otp.osm.pbf"

# Nothing but the feeds we validated may be visible to the scanner: OTP loads
# every *.zip in the data directory as its own transit feed, so a stray bundle
# silently duplicates a whole network (and duplicates without shapes.txt draw
# straight lines). Assert positively rather than trusting each download site.
# Recursive on purpose: the injection steps write working files into WORK_DIR
# subdirectories, so a future zip-producing step there must trip this too.
while IFS= read -r zip; do
  case "${zip#"$WORK_DIR"/}" in
    feed-*.gtfs.zip) ;;
    *) die "unexpected zip in the build directory: ${zip#"$WORK_DIR"/} — OTP would ingest it as a duplicate transit feed; injection inputs belong in AUX_DIR" ;;
  esac
done < <(find "$WORK_DIR" -type f -name '*.zip')

# The official image's entrypoint hardcodes /var/opentripplanner as the data
# directory — mount there and pass flags only, never a path.
log "building graph (this takes a while; heap ${OTP_JAVA_XMX})"
# An absent container (fresh machine, or after `docker compose down`) is not an
# error — there is simply no serving heap to reclaim before the build.
OTP_WAS_RUNNING="$(docker inspect -f '{{.State.Running}}' otp 2>/dev/null || echo absent)"
if [ "$OTP_WAS_RUNNING" = "true" ]; then
  log "stopping otp container for graph build"
  # Claim responsibility BEFORE stopping: `docker stop` takes seconds (graceful
  # SIGTERM), and a signal arriving during it would otherwise reach cleanup with
  # the flag still unset, leaving the service stopped with nobody to restart it.
  # A failed stop then costs one harmless restart of an already-running container.
  OTP_STOPPED_BY_SCRIPT=1
  docker stop otp || die "failed to stop otp before graph build — keeping old graph"
fi
docker run --rm \
  -e JAVA_TOOL_OPTIONS="-Xmx${OTP_JAVA_XMX}" \
  -v "$WORK_DIR:/var/opentripplanner" \
  "$OTP_IMAGE" --build --save \
  || die "otp --build failed — keeping old graph"
[ -f "$WORK_DIR/graph.obj" ] || die "build produced no graph.obj — keeping old graph"

# ── 5. Atomic swap + restart + healthcheck before declaring success ──
log "swapping graph.obj into $OTP_DATA_DIR"
cp "$WORK_DIR"/feed-*.gtfs.zip "$OTP_DATA_DIR/" 2>/dev/null || true
cp "$WORK_DIR/taiwan-otp.osm.pbf" "$OTP_DATA_DIR/" 2>/dev/null || true
[ -f "$OTP_DATA_DIR/graph.obj" ] && cp "$OTP_DATA_DIR/graph.obj" "$OTP_DATA_DIR/graph.obj.prev"
mv "$WORK_DIR/graph.obj" "$OTP_DATA_DIR/graph.obj.new"
mv "$OTP_DATA_DIR/graph.obj.new" "$OTP_DATA_DIR/graph.obj"

log "restarting otp container"
docker compose restart otp || docker restart otp || die "container restart failed"
OTP_RESTART_HANDLED=1

log "waiting for healthcheck"
for attempt in $(seq 1 30); do
  if curl -fsS "http://localhost:18080/otp/actuators/health" >/dev/null 2>&1; then
    log "OTP healthy — build complete"
    rm -f "$OTP_DATA_DIR/graph.obj.prev"
    exit 0
  fi
  sleep 10
done

# Health never came up: roll back to the previous graph.
log "healthcheck failed after restart — rolling back to previous graph"
if [ -f "$OTP_DATA_DIR/graph.obj.prev" ]; then
  mv "$OTP_DATA_DIR/graph.obj.prev" "$OTP_DATA_DIR/graph.obj"
  docker compose restart otp || docker restart otp || true
fi
die "new graph failed healthcheck (rolled back)"
