#!/usr/bin/env bash
#
# Pre-build checks for build-otp-graph.sh. Every check here guards a failure
# that has already cost a full 25–50 minute rebuild, and each one can be
# answered in seconds before any TDX call is made:
#
#   - a stale checkout builds "successfully" without the fixes (the patch and
#     inject scripts run from this checkout, not from an image)
#   - an unreachable Mongo only WARNs at step 1e, silently dropping the
#     wheelchair flags of every TRTC station
#   - a full disk kills the build at the very end and can corrupt Docker's
#     content store
#   - a missing pyosmium or node_modules fails the build half way through
#
# Runs standalone (`pnpm otp:preflight`) or as step 0 of build-otp-graph.sh.
# Exits non-zero when any check FAILs; WARNs never block.
#
# Optional env:
#   OTP_DATA_DIR                 (default /var/otp)
#   OTP_WORK_ROOT                where the build's temp dirs go (default /tmp)
#   OTP_JAVA_XMX                 build heap (default 12g)
#   OTP_DEM_DIR                  DEM GeoTIFF dir (default $OTP_DATA_DIR/dem)
#   OTP_PREFLIGHT_ALLOW_DIRTY=1  downgrade an uncommitted pipeline change to WARN
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
OTP_DATA_DIR="${OTP_DATA_DIR:-/var/otp}"
OTP_WORK_ROOT="${OTP_WORK_ROOT:-/tmp}"
OTP_JAVA_XMX="${OTP_JAVA_XMX:-12g}"
OTP_DEM_DIR="${OTP_DEM_DIR:-$OTP_DATA_DIR/dem}"
OTP_IMAGE="opentripplanner/opentripplanner:2.9.0"
EXPECTED_CITIES=22
MIN_CALENDAR_DAYS=180

FAILS=0
WARNS=0
ok() { printf '[otp-preflight] ok    %s\n' "$*"; }
warn() {
  printf '[otp-preflight] WARN  %s\n' "$*"
  WARNS=$((WARNS + 1))
}
fail() {
  printf '[otp-preflight] FAIL  %s\n' "$*"
  FAILS=$((FAILS + 1))
}

free_gib() { df -Pk "$1" 2>/dev/null | awk 'NR==2 {printf "%.1f", $4 / 1048576}'; }
device_of() { df -P "$1" 2>/dev/null | awk 'NR==2 {print $1}'; }
gib_ge() { awk -v a="$1" -v b="$2" 'BEGIN {exit !(a >= b)}'; }

for var in TDX_CLIENT_ID TDX_CLIENT_SECRET OTP_GTFS_URLS; do
  if [ -n "${!var:-}" ]; then ok "$var is set"; else fail "$var is not set"; fi
done

if [ -d "$OTP_DATA_DIR" ]; then
  missing=""
  for f in otp-config.json build-config.json router-config.json; do
    [ -f "$OTP_DATA_DIR/$f" ] || missing="$missing $f"
  done
  if [ -z "$missing" ]; then ok "OTP_DATA_DIR $OTP_DATA_DIR has the OTP config files"; else fail "OTP_DATA_DIR is missing:$missing"; fi
else
  fail "OTP_DATA_DIR $OTP_DATA_DIR does not exist"
fi
[ -d "$OTP_WORK_ROOT" ] && [ -w "$OTP_WORK_ROOT" ] || fail "OTP_WORK_ROOT $OTP_WORK_ROOT is not a writable directory"

# The pipeline runs this checkout's patch/inject scripts, so building from a
# checkout that is behind origin silently ships a graph without the fixes.
if git -C "$REPO_DIR" rev-parse --git-dir >/dev/null 2>&1; then
  head="$(git -C "$REPO_DIR" rev-parse --short HEAD)"
  if GIT_TERMINAL_PROMPT=0 git -C "$REPO_DIR" fetch --quiet 2>/dev/null; then
    if upstream="$(git -C "$REPO_DIR" rev-parse --short '@{u}' 2>/dev/null)"; then
      behind="$(git -C "$REPO_DIR" rev-list --count 'HEAD..@{u}')"
      if [ "$behind" -gt 0 ]; then
        fail "checkout $head is $behind commit(s) behind upstream $upstream — git pull first"
      else
        ok "checkout $head is up to date with upstream $upstream"
      fi
    else
      warn "branch has no upstream — cannot tell whether checkout $head is stale"
    fi
  else
    warn "git fetch failed — cannot tell whether checkout $head is stale"
  fi
  dirty="$(git -C "$REPO_DIR" status --porcelain -- src/scripts otp-data | head -5)"
  if [ -n "$dirty" ]; then
    msg="uncommitted changes in the build pipeline: $(echo "$dirty" | tr '\n' ' ')"
    if [ "${OTP_PREFLIGHT_ALLOW_DIRTY:-0}" = "1" ]; then warn "$msg"; else fail "$msg(set OTP_PREFLIGHT_ALLOW_DIRTY=1 to build anyway)"; fi
  else
    ok "build pipeline has no uncommitted changes"
  fi
else
  warn "$REPO_DIR is not a git checkout — cannot verify the pipeline version"
fi

# Free space. Work dir peak: feed + three pbf copies + new graph (~5 GiB).
# Data dir: OSM cache + promoted feed/pbf/graph, plus graph.obj.prev — a copy
# of the graph being replaced.
if [ -d "$OTP_DATA_DIR" ] && [ -d "$OTP_WORK_ROOT" ]; then
  graph_gib=0
  [ -f "$OTP_DATA_DIR/graph.obj" ] &&
    graph_gib="$(du -k "$OTP_DATA_DIR/graph.obj" | awk '{printf "%.1f", $1 / 1048576}')"
  need_data="$(awk -v g="$graph_gib" 'BEGIN {printf "%.1f", 3 + g}')"
  need_work=5
  data_free="$(free_gib "$OTP_DATA_DIR")"
  work_free="$(free_gib "$OTP_WORK_ROOT")"
  if [ "$(device_of "$OTP_DATA_DIR")" = "$(device_of "$OTP_WORK_ROOT")" ]; then
    need="$(awk -v a="$need_data" -v b="$need_work" 'BEGIN {printf "%.1f", a + b}')"
    if gib_ge "$data_free" "$need"; then
      ok "disk: ${data_free} GiB free (need ${need} GiB, data and work share a disk)"
    else
      fail "disk: only ${data_free} GiB free, need ${need} GiB — a full disk can corrupt Docker's store; free space or point OTP_WORK_ROOT at another disk"
    fi
  else
    if gib_ge "$data_free" "$need_data"; then ok "disk (data): ${data_free} GiB free (need ${need_data})"; else fail "disk (data): only ${data_free} GiB free on $OTP_DATA_DIR, need ${need_data}"; fi
    if gib_ge "$work_free" "$need_work"; then ok "disk (work): ${work_free} GiB free (need ${need_work})"; else fail "disk (work): only ${work_free} GiB free on $OTP_WORK_ROOT, need ${need_work}"; fi
  fi
fi

if docker info >/dev/null 2>&1; then
  ok "docker daemon is responding"
  mem_gib="$(docker info --format '{{.MemTotal}}' | awk '{printf "%.1f", $1 / 1073741824}')"
  xmx_gib="$(echo "$OTP_JAVA_XMX" | awk '/[gG]$/ {print $0 + 0; next} /[mM]$/ {print ($0 + 0) / 1024; next} {print 0}')"
  if gib_ge "$mem_gib" "$(awk -v x="$xmx_gib" 'BEGIN {print x + 2}')"; then
    ok "docker memory ${mem_gib} GiB fits build heap ${OTP_JAVA_XMX}"
  else
    fail "docker memory ${mem_gib} GiB cannot hold build heap ${OTP_JAVA_XMX} plus overhead — lower OTP_JAVA_XMX"
  fi
  if docker image inspect "$OTP_IMAGE" >/dev/null 2>&1; then ok "image $OTP_IMAGE is present"; else warn "image $OTP_IMAGE is not pulled yet — the build will pull it"; fi
else
  fail "docker daemon is not responding"
fi

if python3 -c 'import osmium' 2>/dev/null; then
  ok "pyosmium is importable (pedestrian access hardening)"
else
  fail "python3 cannot import osmium — pedestrian access hardening (fatal step) would fail; pip install osmium"
fi

if python3 -c 'import rasterio' 2>/dev/null; then
  ok "rasterio is importable (national DTM reprojection)"
elif ls "$OTP_DEM_DIR"/*.tif >/dev/null 2>&1; then
  warn "python3 cannot import rasterio — the DTM cannot be refreshed; building with the cached $OTP_DEM_DIR"
else
  warn "python3 cannot import rasterio and $OTP_DEM_DIR has no DEM — the graph will carry no elevation (wheelchair slope limits inert); pip install rasterio"
fi

if command -v gtfs-validator >/dev/null 2>&1; then ok "gtfs-validator is installed"; else warn "gtfs-validator not installed — the validation gate will be skipped"; fi

if [ -x "$REPO_DIR/node_modules/.bin/ts-node" ]; then
  ok "node_modules has ts-node (steps 1e–1g)"
else
  fail "node_modules/.bin/ts-node missing — run pnpm install"
fi

# Step 1e connects exactly like this (dotenvx in the caller's cwd), so a
# reachable Mongo here means the TRTC wheelchair flags will be injected.
if [ -x "$REPO_DIR/node_modules/.bin/ts-node" ]; then
  if (cd "$REPO_DIR" && npx dotenvx run --quiet -- node -e '
    require("mongoose")
      .connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 5000 })
      .then((m) => m.connection.db.admin().ping().then(() => m.disconnect()))
      .then(() => process.exit(0), (e) => { console.error(e.message); process.exit(1); });
  ') >/dev/null 2>&1; then
    ok "MongoDB at DATABASE_URL is reachable (step 1e wheelchair flags)"
  else
    fail "MongoDB at DATABASE_URL is unreachable — step 1e would silently drop the TRTC wheelchair flags"
  fi
fi

# patch_gtfs deletes every bus trip in the base feed and rebuilds only CITIES,
# so a shortened list silently deletes whole counties.
cities="$(sed -n '/^CITIES = \[/,/^\]/p' "$SCRIPT_DIR/patch_gtfs.py" | grep -o '"[A-Za-z]*"' | wc -l | tr -d ' ')"
if [ "$cities" -eq "$EXPECTED_CITIES" ]; then ok "patch_gtfs.py CITIES lists $cities cities"; else fail "patch_gtfs.py CITIES lists $cities cities, expected $EXPECTED_CITIES — a shorter list deletes those counties' buses"; fi
cal_days="$(sed -n 's/^CALENDAR_VALID_DAYS = \([0-9]*\).*/\1/p' "$SCRIPT_DIR/patch_gtfs.py")"
if [ "${cal_days:-0}" -ge "$MIN_CALENDAR_DAYS" ]; then ok "patch_gtfs.py CALENDAR_VALID_DAYS = $cal_days"; else fail "patch_gtfs.py CALENDAR_VALID_DAYS = ${cal_days:-unset}, expected >= $MIN_CALENDAR_DAYS"; fi

echo "[otp-preflight] $FAILS FAIL, $WARNS WARN"
[ "$FAILS" -eq 0 ]
