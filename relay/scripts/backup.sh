#!/usr/bin/env bash
# Relay backup: a consistent PostgreSQL dump + the media directory + a manifest with checksums.
# Usage: DATABASE_URL=postgres://… MEDIA_DIR=./data/media scripts/backup.sh [output-dir]
# Output: <output-dir>/relay-backup-<UTC timestamp>/{db.dump,media.tar.gz,MANIFEST.json}
# Keep the CREDENTIAL_KEYS / CREDENTIAL_KEY_HEX values SEPARATELY (password manager): stored integration credentials are encrypted with them
# and are unreadable without the same key. The key is intentionally NOT part of the backup.
set -euo pipefail
: "${DATABASE_URL:?set DATABASE_URL}"
OUT_ROOT="${1:-./backups}"; MEDIA_DIR="${MEDIA_DIR:-./data/media}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"; DIR="$OUT_ROOT/relay-backup-$STAMP"
mkdir -p "$DIR"
pg_dump --format=custom --no-owner --no-privileges --file="$DIR/db.dump" "$DATABASE_URL"
if [ -d "$MEDIA_DIR" ]; then tar -C "$MEDIA_DIR" -czf "$DIR/media.tar.gz" .; else tar -czf "$DIR/media.tar.gz" -T /dev/null; fi
# Row counts let a restore be verified without trusting file integrity alone.
COUNTS="$(psql "$DATABASE_URL" -At -F: -c "SELECT 'contacts', count(*) FROM contacts UNION ALL SELECT 'conversations', count(*) FROM conversations UNION ALL SELECT 'messages', count(*) FROM messages UNION ALL SELECT 'audit_events', count(*) FROM audit_events UNION ALL SELECT 'consent_events', count(*) FROM consent_events UNION ALL SELECT 'media_assets', count(*) FROM media_assets" | awk -F: 'BEGIN{printf "{"} {printf "%s\"%s\":%s", (NR>1?",":""), $1, $2} END{printf "}"}')"
MIG="$(psql "$DATABASE_URL" -At -c "SELECT coalesce(max(name),'') FROM schema_migrations")"
DUMP_SHA="$(sha256sum "$DIR/db.dump" | cut -d' ' -f1)"; MEDIA_SHA="$(sha256sum "$DIR/media.tar.gz" | cut -d' ' -f1)"
cat > "$DIR/MANIFEST.json" <<JSON
{ "createdAt": "$STAMP", "latestMigration": "$MIG", "dbDumpSha256": "$DUMP_SHA", "mediaTarSha256": "$MEDIA_SHA", "rowCounts": $COUNTS }
JSON
echo "$DIR"
