# Relay operations runbook

## Processes
- **server** (`node dist/server/main.js`): web app, REST, realtime, webhooks. Runs migrations on boot.
- **worker** (`node dist/worker/main.js`): sends texts, scheduled sends, automations, summaries, webhook deliveries, reconciliation. **If the worker is down, queued texts do not go out** (they wait durably and go out, once, when a worker returns).
- **PostgreSQL 16**: the only stateful dependency besides the media directory.

## Is it healthy?
- `GET /health` liveness · `GET /ready` DB reachable and every migration applied (503 otherwise).
- Settings → **System health** (owner/admin) or `GET /api/admin/status`: worker heartbeats, queue depth/oldest due job, permanently failed jobs, messages with unknown outcome, dead webhook deliveries, assistant event backlog, backup age. `problems[]` is plain English.
- `GET /metrics` (404 unless `METRICS_TOKEN` set; send `Authorization: Bearer <token>`): Prometheus text. Suggested alerts: `relay_workers_alive == 0 for 2m`; `relay_job_oldest_due_seconds > 300`; `relay_ready == 0`; `relay_messages_unknown > 0`; `relay_backup_age_hours > 36`.

## Common situations
| Symptom | Meaning / action |
|---|---|
| "No worker heartbeat" | Start/restart the worker (`systemctl restart relay-worker` / `docker compose restart worker`). No data is lost. Jobs it held when it died are reclaimed after `JOB_LEASE_SECONDS` (default 60 s). Verified by `npm run drill:recovery`. |
| Messages with status **unknown** | The provider may or may not have received it (worker died mid-send, network cut). Relay never auto-resends. Check the provider's dashboard/logs, then resend manually if needed. |
| Live updates stop in browsers | Browsers reconnect by themselves; after a reconnect or a database listener reset the app reloads what it shows (`resync`). If it persists: check `/ready`, proxy buffering (Caddy `flush_interval -1`). |
| Dead webhook deliveries | Settings → Webhooks → fix the destination, then Redeliver. |
| Job failed permanently | `GET /api/admin/status` → `queue.failedKinds[].last_error`. |
| Assistant misbehaving | Settings → Assistant → **Disable now**; or global automation pause. |
| Key leaked | Revoke the key (immediate); create a new one. |

## Backups
- Nightly: `scripts/backup.sh <dir>` (systemd timer `deploy/relay-backup.timer`). Output: `relay-backup-<UTC>/{db.dump, media.tar.gz, MANIFEST.json}` (checksums + row counts + latest migration). Set `BACKUP_DIR` so System health reports age.
- **Copy the newest backup off the machine** (object storage / another host). A backup on the same disk is not a backup. *Not automated here: needs your storage choice and credentials.*
- **Store `CREDENTIAL_KEYS` separately** (password manager). Stored integration credentials and webhook secrets are encrypted with it; a restored database is useless for those without it. Verified: wrong key does not decrypt.
- Retention: 14 days local in the timer; decide offsite retention yourself. Backups contain customer data: encrypt the offsite copy and restrict access. Erased contacts remain in older backups until those age out.

## Restore (and rehearsal — do this quarterly)
```
createdb relay_restore                         # must be EMPTY
scripts/restore.sh /path/relay-backup-… postgres://…/relay_restore /path/media-restore
DATABASE_URL=postgres://…/relay_restore MEDIA_DIR=/path/media-restore PORT=4100 node dist/server/main.js   # check it, log in, look around
```
`restore.sh` refuses damaged backups (checksum) and non-empty targets. For a real disaster: restore into the new database, point `DATABASE_URL` at it, start server and worker. **Automated rehearsal:** `npm run drill:restore` (seeds data, backs up, restores into a fresh DB, boots a real server on it, compares counts/fingerprints/media bytes, decrypts a stored secret). Last result: see BUILD_STATUS.md.
RPO = time since last backup (≤ 24 h with the nightly timer). RTO is whatever it takes to provision a host + restore; the rehearsal restores a small dataset in seconds, a large one will take longer — measure it on your real size.

## Upgrades
`git pull && npm ci && npm run build`, restart server then worker. Migrations are forward-only SQL applied under an advisory lock on boot (safe with several instances). Take a backup first. There is no automated down-migration: rollback = restore the backup.

## Scaling notes
Several workers are safe (`FOR UPDATE SKIP LOCKED`). Several servers are safe; per-identity assistant rate limits and the login limiter are per process. Sandbox adapters hold state in-process and are refused in production.
