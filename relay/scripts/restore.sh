#!/usr/bin/env bash
# Restore a Relay backup into a NEW, EMPTY database. Refuses to overwrite a database that already has tables.
# Usage: scripts/restore.sh <backup-dir> <target DATABASE_URL> [media target dir]
# Typical drill: create an empty database, run this, point a throwaway Relay at it, check it, drop it. See docs/RUNBOOK.md.
set -euo pipefail
BK="${1:?backup dir}"; TARGET="${2:?target database url}"; MEDIA_TARGET="${3:-}"
[ -f "$BK/db.dump" ] && [ -f "$BK/MANIFEST.json" ] || { echo "not a Relay backup directory: $BK" >&2; exit 2; }
want="$(sed -n 's/.*"dbDumpSha256": "\([0-9a-f]*\)".*/\1/p' "$BK/MANIFEST.json")"; got="$(sha256sum "$BK/db.dump" | cut -d' ' -f1)"
[ "$want" = "$got" ] || { echo "CHECKSUM MISMATCH on db.dump — backup is damaged; not restoring" >&2; exit 3; }
wantm="$(sed -n 's/.*"mediaTarSha256": "\([0-9a-f]*\)".*/\1/p' "$BK/MANIFEST.json")"; gotm="$(sha256sum "$BK/media.tar.gz" | cut -d' ' -f1)"
[ "$wantm" = "$gotm" ] || { echo "CHECKSUM MISMATCH on media.tar.gz — backup is damaged; not restoring" >&2; exit 3; }
existing="$(psql "$TARGET" -At -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")"
[ "$existing" = "0" ] || { echo "target database is not empty ($existing tables). Restore into a fresh database." >&2; exit 4; }
pg_restore --no-owner --no-privileges --exit-on-error --dbname="$TARGET" "$BK/db.dump"
if [ -n "$MEDIA_TARGET" ]; then mkdir -p "$MEDIA_TARGET"; tar -C "$MEDIA_TARGET" -xzf "$BK/media.tar.gz"; fi
echo "restored $(basename "$BK") into target database"
