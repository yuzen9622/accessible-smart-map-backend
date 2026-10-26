#!/usr/bin/env bash
# Read-only prerequisite checks for OTP rebuild, also available as otp:preflight.
# Prerequisites can be checked before import; the rebuild requires an ACTIVE source.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
DATA_ROOT="$REPO_DIR/otp-data"
OTP_JAVA_XMX="${OTP_JAVA_XMX:-6g}"
FAILS=0
WARNS=0
ok() { printf '[otp-preflight] ok    %s\n' "$*"; }
warn() { printf '[otp-preflight] WARN  %s\n' "$*"; WARNS=$((WARNS + 1)); }
fail() { printf '[otp-preflight] FAIL  %s\n' "$*"; FAILS=$((FAILS + 1)); }
gib_ge() { awk -v a="$1" -v b="$2" 'BEGIN {exit !(a >= b)}'; }

for tool in docker python3 node pnpm curl unzip zip git; do
  if command -v "$tool" >/dev/null 2>&1; then ok "$tool is available"; else fail "required tool missing: $tool"; fi
done
for variable in TDX_CLIENT_ID TDX_CLIENT_SECRET PED_GRAPH_DATABASE_URL DATABASE_URL; do
  if [ -n "${!variable:-}" ]; then ok "$variable is set"; else fail "$variable is not set"; fi
done
if [ -d "$DATA_ROOT" ] && [ -w "$DATA_ROOT" ] && [ ! -L "$DATA_ROOT" ]; then
  for config in otp-config.json build-config.json router-config.json; do
    if [ -f "$DATA_ROOT/$config" ] && [ ! -L "$DATA_ROOT/$config" ]; then ok "$config is available"; else fail "missing or linked config: $config"; fi
  done
  free_gib="$(df -Pk "$DATA_ROOT" 2>/dev/null | awk 'NR==2 {printf "%.1f", $4 / 1048576}')"
  if gib_ge "${free_gib:-0}" 10; then ok "disk: $free_gib GiB free for a new release"; else fail "at least 10 GiB free required in otp-data; found ${free_gib:-0}"; fi
else
  fail "repository otp-data must be a writable regular directory"
fi

# Hashes in the native manifest bind the actual checkout; do not fetch Git or
# require a commit merely to use local implementation changes.
if git -C "$REPO_DIR" rev-parse --git-dir >/dev/null 2>&1; then
  if [ -n "$(git -C "$REPO_DIR" status --porcelain -- src/scripts src/otp otp-data Dockerfile)" ]; then
    warn "local pipeline changes will be built and bound to this release's manifest"
  else
    ok "pipeline checkout is clean"
  fi
fi
if docker info >/dev/null 2>&1; then
  ok "Docker daemon is responding"
  if (cd "$REPO_DIR" && docker compose config --quiet) >/dev/null 2>&1; then ok "Compose configuration is valid"; else fail "Compose configuration is invalid; check existing deployment settings"; fi
  mem_gib="$(docker info --format '{{.MemTotal}}' | awk '{printf "%.1f", $1 / 1073741824}')"
  xmx_gib="$(printf '%s\n' "$OTP_JAVA_XMX" | awk '/^[0-9]+[gG]$/ {print $0+0; next} /^[0-9]+[mM]$/ {print ($0+0)/1024; next} {print 0}')"
  if gib_ge "$xmx_gib" 1 && gib_ge "$mem_gib" "$(awk -v x="$xmx_gib" 'BEGIN {print x+2}')"; then
    ok "Docker memory $mem_gib GiB fits build heap $OTP_JAVA_XMX plus overhead"
  else
    fail "Docker memory $mem_gib GiB does not fit heap $OTP_JAVA_XMX plus overhead"
  fi
else
  fail "Docker daemon is unavailable"
fi

if node -e 'if(Number(process.versions.node.split(".")[0])<22)process.exit(1)' >/dev/null 2>&1; then ok "Node >=22"; else fail "Node 22 or newer is required"; fi
if python3 - <<'PYTHON'
import importlib, sys

print(f'[otp-preflight] Python {sys.version.split()[0]}: {sys.executable}')
errors = []
if sys.version_info < (3, 12):
    errors.append('Python 3.12 or newer is required')
for name in ('osmium', 'shapely', 'rasterio', 'numpy', 'psycopg2'):
    try:
        importlib.import_module(name)
        if name == 'shapely':
            from shapely import constrained_delaunay_triangles
    except Exception as error:
        errors.append(f'{name}: {type(error).__name__}: {error}')
for error in errors:
    print(f'[otp-preflight]       {error}')
sys.exit(1 if errors else 0)
PYTHON
then
  ok "Python >=3.12 with osmium, Shapely, rasterio, numpy and psycopg2"
else
  fail "Python prerequisites failed above; activate the intended Conda/venv environment and install missing dependencies in that environment"
fi
if [ -x "$REPO_DIR/node_modules/.bin/ts-node" ]; then ok "project Node dependencies are installed"; else fail "run pnpm install --frozen-lockfile first"; fi
if command -v gtfs-validator >/dev/null 2>&1; then ok "gtfs-validator is installed"; else warn "optional gtfs-validator absent; mandatory feed/shape/service-window and runtime gates still run"; fi

if ! python3 -c 'import psycopg2' >/dev/null 2>&1; then
  warn "PostGIS check skipped: python3 cannot import psycopg2; Conda psycopg2 or pip psycopg2-binary can provide it"
elif python3 - <<'POSTGIS' >/dev/null 2>&1
import os, psycopg2
with psycopg2.connect(os.environ['PED_GRAPH_DATABASE_URL'],connect_timeout=5) as connection:
    with connection.cursor() as cursor:
        cursor.execute("SET statement_timeout='5s'")
        cursor.execute('SELECT PostGIS_Version()')
        assert cursor.fetchone()[0]
POSTGIS
then ok "PostGIS is reachable (source tables may be initialized by import)"; else fail "PED_GRAPH_DATABASE_URL must reach a database with PostGIS enabled"; fi
if (cd "$REPO_DIR" && node - <<'MONGO'
const mongoose = require('mongoose');
mongoose.connect(process.env.DATABASE_URL,{serverSelectionTimeoutMS:5000})
 .then(() => mongoose.connection.db.admin().ping())
 .then(() => mongoose.disconnect())
 .then(() => process.exit(0), () => process.exit(1));
MONGO
) >/dev/null 2>&1; then ok "MongoDB is reachable for wheelchair flags and stop aliases"; else fail "DATABASE_URL must reach MongoDB before transport enrichment"; fi

cities="$(sed -n '/^CITIES = \[/,/^\]/p' "$SCRIPT_DIR/patch_gtfs.py" | grep -o '"[A-Za-z]*"' | wc -l | tr -d ' ')"
if [ "$cities" -eq 22 ]; then ok "bus timetable patch retains all 22 upstream city datasets"; else fail "patch_gtfs.py CITIES must retain all 22 source datasets"; fi
calendar_days="$(sed -n 's/^CALENDAR_VALID_DAYS = \([0-9]*\).*/\1/p' "$SCRIPT_DIR/patch_gtfs.py")"
if [ "${calendar_days:-0}" -ge 180 ]; then ok "bus calendar window is at least 180 days"; else fail "patch_gtfs.py CALENDAR_VALID_DAYS must be >=180"; fi
printf '[otp-preflight] %s FAIL, %s WARN\n' "$FAILS" "$WARNS"
[ "$FAILS" -eq 0 ]
