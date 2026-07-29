#!/usr/bin/env bash
set -Eeuo pipefail

# Restore a bundle produced by backup-data.sh onto a fresh host. Run from a
# clean checkout of this repo (git clone first). Brings up only mongo + chroma,
# loads the data, then starts the full stack.
#
#   src/scripts/restore-data.sh <bundle-dir>

cd "$(dirname "$0")/../.."

fail() { printf 'restore-data: %s\n' "$*" >&2; exit 1; }

BUNDLE="${1:-}"
[ -n "$BUNDLE" ] || fail "usage: src/scripts/restore-data.sh <bundle-dir>"
[ -d "$BUNDLE" ] || fail "bundle dir not found: $BUNDLE"
# Canonicalize to an absolute path so the docker -v mount works whether the
# caller passed a relative or absolute bundle dir.
BUNDLE="$(cd "$BUNDLE" && pwd)"
[ -f "$BUNDLE/.env" ] || fail "bundle is missing .env"
[ -f "$BUNDLE/mongo.archive.gz" ] || fail "bundle is missing mongo.archive.gz"

echo "==> Restoring .env + secrets"
cp "$BUNDLE/.env" .env
set -a; source .env; set +a
: "${MONGO_ROOT_USER:?MONGO_ROOT_USER missing in restored .env}"
: "${MONGO_ROOT_PASSWORD:?MONGO_ROOT_PASSWORD missing in restored .env}"
if [ -f "$BUNDLE/gcs-key.json" ]; then
  GCS=$(grep -E '^GCS_KEY_FILE=' .env | cut -d= -f2- || true)
  [ -n "${GCS:-}" ] && { mkdir -p "$(dirname "$GCS")"; cp "$BUNDLE/gcs-key.json" "$GCS"; }
fi

PROJECT="${COMPOSE_PROJECT_NAME:-$(basename "$PWD")}"
CHROMA_VOLUME="${PROJECT}_chroma-data"

echo "==> Starting mongo only"
# Chroma is intentionally left DOWN: we overwrite its volume below, and a
# running chroma would initialize (and keep serving) an empty store, so the
# restored volume would never be read. It comes up fresh in the final step.
docker compose up -d mongo
echo "    waiting for mongo to accept connections..."
until docker exec mongo mongosh --quiet --eval "db.adminCommand('ping')" >/dev/null 2>&1; do
  sleep 3
done

echo "==> 1/2 Restoring MongoDB (--drop replaces existing collections)"
docker exec -i mongo mongorestore \
  --username "$MONGO_ROOT_USER" --password "$MONGO_ROOT_PASSWORD" \
  --authenticationDatabase admin --archive --gzip --drop \
  < "$BUNDLE/mongo.archive.gz"

echo "==> 2/2 Restoring Chroma (chroma is down; volume filled before it starts)"
if [ -f "$BUNDLE/chroma-data.tar.gz" ]; then
  docker run --rm \
    -v "$CHROMA_VOLUME":/vol \
    -v "$BUNDLE":/backup alpine \
    sh -c "cd /vol && tar xzf /backup/chroma-data.tar.gz"
else
  echo "    (no chroma-data.tar.gz in bundle, skipped)"
fi

echo "==> Starting full stack"
docker compose up -d

echo
echo "OK  restore complete."
echo "    If you did NOT copy otp-data/ and valhalla-data/, rebuild them:"
echo "    src/scripts/build-otp-graph.sh  &&  pnpm build:valhalla-tiles"
