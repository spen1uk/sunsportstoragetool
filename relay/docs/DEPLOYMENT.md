# Deployment

Two supported shapes: **Docker Compose** (`docker-compose.yml`, Caddy for TLS) or **systemd on a Linux host** (`deploy/*.service`, `deploy/relay-backup.timer`, your own reverse proxy).

## Prerequisites you must supply
A host (≈1 vCPU / 1–2 GB is enough for one dealership: not benchmarked, see COST_MODEL.md), DNS for the hostname, PostgreSQL 16 (or the compose `db`), and the secrets in `.env.example` (`openssl rand -hex 32` for each). Nothing here has been purchased or created.

## Production guard
In `RELAY_ENV=production` both processes **refuse to start** (exit 78, listing every problem) if: DATABASE_URL has the dev password; no `CREDENTIAL_KEYS`; `MEDIA_SIGNING_KEY`/`SIM_WEBHOOK_SECRET` default or short; `PUBLIC_BASE_URL` not https; test jobs enabled; `ALLOW_SANDBOX=1`; `TRUST_PROXY=true`. Also in production: the simulator webhook route is 404, `/api/dev/*` is 404, cookies are `Secure`, HSTS is sent.

## Reverse proxy
Set `TRUST_PROXY=1` when exactly one proxy (Caddy/nginx) is in front; leave `false` otherwise (spoofable `X-Forwarded-For` would defeat rate limits). The proxy must not buffer `/api/events` (server-sent events). Body limit 12 MB (media). Block `/metrics` publicly.

## Compose
```
cp .env.example .env   # fill every value, remove inline comments
docker compose up -d --build
docker compose logs -f server worker
```
Edit `deploy/Caddyfile` hostname first. The compose file mounts `./backups` read-only into the server for the backup-age indicator; run the backup timer on the host (or a cron container) writing there.

## systemd
Install Node 22 and unpack to `/opt/relay` (`npm ci && npm run build`), create user `relay`, `/etc/relay/relay.env` (no inline comments — systemd does not support them), copy `deploy/*.service|timer` to `/etc/systemd/system`, fix the `node` path if needed, `systemctl enable --now relay-server relay-worker relay-backup.timer`.

## What has and hasn't been verified (honest status)
| Item | Status |
|---|---|
| `npm run build` (tsc → `dist`, Vite → `web/dist`) | ✅ built |
| Built server boots in `RELAY_ENV=production`, guard rejects dev defaults, `/ready`, HSTS, `/metrics` token, simulator webhook 404 | ✅ run on this machine |
| Worker/server crash recovery, backup/restore, SSE reconnect | ✅ real processes (`npm run drill:recovery`, `drill:restore`) |
| `docker compose config` parses | ✅ |
| **Docker image build/run** | ❌ **not run**: no container daemon in the build environment. Dockerfile follows the verified build steps but is untested. |
| systemd units | ⚠️ parsed by `systemd-analyze verify` (only the host-specific node path/user complaints); not started under systemd |
| Caddyfile | ❌ not run (Caddy not installed) |
| TLS, DNS, offsite backup, monitoring/alerting wiring, load testing | ❌ need your infrastructure |
