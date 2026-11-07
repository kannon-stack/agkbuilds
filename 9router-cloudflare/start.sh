#!/bin/sh
# Restore the 9router SQLite DB from R2 (if a replica exists), then run 9router under
# `litestream replicate -exec` so every change streams to R2 and SIGTERM triggers a final sync.
set -eu

DATA_DIR="${DATA_DIR:-/app/data}"
export DATA_DIR
DB="$DATA_DIR/db/data.sqlite"

if [ -z "${LITESTREAM_ACCESS_KEY_ID:-}" ] || [ -z "${R2_BUCKET:-}" ]; then
  echo "[start] R2 credentials/bucket not set - running WITHOUT persistence (data is lost on restart)" >&2
  exec /entrypoint.sh "$@"
fi

mkdir -p "$DATA_DIR/db"

echo "[start] restoring $DB from R2 (if a replica exists)"
litestream restore -config /etc/litestream.yml -if-db-not-exists -if-replica-exists "$DB"

echo "[start] starting 9router under litestream"
exec litestream replicate -config /etc/litestream.yml -exec "/entrypoint.sh $*"
