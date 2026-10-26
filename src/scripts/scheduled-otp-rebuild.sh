#!/usr/bin/env bash
# Unattended OTP graph rebuild for cron / systemd timers.
#
# Rail and metro timetables in the graph cover only the 4–8 weeks TDX
# publishes, so the graph must be rebuilt at least weekly or transit planning
# silently decays to bus-only. This wrapper makes that rebuild safe to run
# unattended:
#   - one run at a time (a stale lock left by a crashed run is reclaimed)
#   - fast-forwards the checkout first, because build-otp-graph.sh runs the
#     patch/inject scripts from this checkout, not from an image
#   - loads .env from the repo root
#   - one log file per run under OTP_REBUILD_LOG_DIR, keeping the last 8
#   - exactly one build attempt; failures exit non-zero for cron mail /
#     systemd OnFailure, and the backend's freshness check keeps alerting
#
# Suggested schedule (weekly, Sunday 04:00 Asia/Taipei):
#   cron:     0 4 * * 0  /path/to/repo/src/scripts/scheduled-otp-rebuild.sh
#   systemd:  see docs/manuals/OTP_OPERATIONS.md §7
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_DIR="${OTP_REBUILD_LOG_DIR:-$REPO_DIR/logs/otp-rebuild}"
LOCK_DIR="${OTP_REBUILD_LOCK_DIR:-${TMPDIR:-/tmp}/otp-rebuild.lock}"

mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/otp-rebuild-$(date +%Y%m%d-%H%M%S).log"
log() { printf '[scheduled-otp-rebuild] %s %s\n' "$(date '+%F %T')" "$*" | tee -a "$LOG_FILE"; }

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  holder="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  if [[ -n "$holder" ]] && kill -0 "$holder" 2>/dev/null; then
    log "another rebuild (pid $holder) is still running — skipping this run"
    exit 0
  fi
  log "reclaiming stale lock left by pid ${holder:-unknown}"
  rm -rf "$LOCK_DIR"
  mkdir "$LOCK_DIR" || { log "FATAL: cannot take lock $LOCK_DIR"; exit 1; }
fi
echo $$ > "$LOCK_DIR/pid"
trap 'rm -rf "$LOCK_DIR"' EXIT

cd "$REPO_DIR" || exit 1

if ! git pull --ff-only >> "$LOG_FILE" 2>&1; then
  log "FATAL: git pull --ff-only failed — refusing to build from a stale or diverged checkout"
  exit 1
fi
log "checkout at $(git rev-parse --short HEAD)"

if [[ ! -f .env ]]; then
  log "FATAL: $REPO_DIR/.env not found"
  exit 1
fi
set -a
# shellcheck disable=SC1091
. ./.env
set +a

runner=()
if command -v caffeinate > /dev/null 2>&1; then
  runner=(caffeinate -dims)
fi

log "starting build-otp-graph.sh (log: $LOG_FILE)"
${runner[@]+"${runner[@]}"} bash src/scripts/build-otp-graph.sh >> "$LOG_FILE" 2>&1
status=$?
if [[ $status -eq 0 ]]; then
  log "rebuild succeeded"
else
  log "FATAL: rebuild failed with exit $status — the previous graph is still serving"
fi

ls -1t "$LOG_DIR"/otp-rebuild-*.log 2>/dev/null | tail -n +9 | xargs -r rm -f
exit $status
