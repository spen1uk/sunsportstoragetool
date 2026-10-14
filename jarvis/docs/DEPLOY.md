# Moving Jarvis to a cloud server (private link)

**Status: written, not executed.** Nothing has been bought, created or deployed. Every step below needs Luke's go-ahead, and the checklist at the end says what is still unbuilt.

## Decisions made
- Runs on a small cloud Linux server (about $5–12/month; 1 vCPU, 1–2 GB RAM is plenty).
- Reached over a **private Tailscale link only**: the server exposes nothing to the public internet.
- Calendar and Notes come from a **helper on the Mac** that pushes a read-only copy (`npm run bridge`).

## Shape of the setup
```
your Mac / phone ──(Tailscale, encrypted)──▶ server: tailscale serve (HTTPS) ──▶ Jarvis on 127.0.0.1:8788
your Mac helper ───(same private link, bearer credential)──▶ /api/bridge/*  (Calendar + Notes copy)
```
Jarvis itself still listens on `127.0.0.1` only. Tailscale is the only thing that talks to it, so there is no open port to attack.

## Steps (when Luke says go)
1. **Create the server** (Ubuntu 24.04 LTS, smallest size). Turn on the provider's automatic security updates; no password logins, SSH keys only.
2. **Firewall:** deny all incoming (`ufw default deny incoming; ufw allow OpenSSH` until Tailscale SSH is on, then remove it).
3. **Tailscale:** install on the server, the Mac and the phone (`tailscale up`). Note the server's name, e.g. `jarvis.your-tailnet.ts.net`. Then `tailscale serve --bg 8788` gives it HTTPS on that name (tailnet-only; do **not** use `funnel`).
4. **Node 22.18+:** install from NodeSource. Create a user: `useradd --system --home /opt/jarvis jarvis`.
5. **Code:** clone the repo into `/opt/jarvis` (branch `claude/magical-heisenberg-ce1m2m` until merged), `cd jarvis`-folder, `npm ci && npm run build`.
6. **Config:** `cp deploy/jarvis.env.example /etc/jarvis.env`, edit the Tailscale name, `chmod 600`. `mkdir /var/lib/jarvis; chown jarvis /var/lib/jarvis; chmod 700`.
7. **First run:** as the jarvis user with `JARVIS_DATA_DIR=/var/lib/jarvis`: `npm run setup` (new passphrase, shown once) and `npm run secret:set -- anthropic`.
8. **Service:** `cp deploy/jarvis.service /etc/systemd/system/; systemctl enable --now jarvis`. It restarts on crash and at boot. `curl http://127.0.0.1:8788/api/health` should say `{"ok":true}`.
9. **Move your data (optional):** on the Mac stop Jarvis, then copy `data/jarvis.db` (a verified snapshot from `npm run backup:verify` first) to `/var/lib/jarvis/jarvis.db`, owned by jarvis, mode 600. Move `secrets.json` too, or re-enter the key.
10. **Mac helper:** on the Calendar page create the helper credential (step-up), then on the Mac `npm run bridge:setup` (server address + credential) and `npm run bridge`. When it works: `bash scripts/bridge-autostart.sh install`.
11. **Retire the Mac copy:** `bash scripts/autostart.sh uninstall` so two Jarvises never both run reminders.

## What Jarvis already enforces on a server
- Answers only to hosts listed in `JARVIS_ALLOWED_HOSTS` (DNS-rebinding defence); cookies `Secure` + HSTS when `JARVIS_PUBLIC_HTTPS=1`.
- The helper credential opens only the `/api/bridge/*` doors, is stored as a hash, creating one needs step-up, replacing it revokes the old one, repeated wrong guesses lock it briefly. The server discards anything outside the calendars/folders Luke ticked.
- The systemd unit can only write `/var/lib/jarvis`.

## Passkeys and backups (built)
- **Passkeys** (Settings → Passkeys): Face ID / Touch ID sign-in and step-up, ES256 only, user verification required. A passkey belongs to the address it was made on: make one at `http://localhost:8788` for the Mac now, and another at `https://jarvis.<your-tailnet>.ts.net` once the server is up (the browser needs a *name*, so use `localhost`, not `127.0.0.1`). "Require a passkey to sign in" turns the passphrase off for sign-in; if every passkey is lost, `npm run setup -- --allow-passphrase` on the machine turns it back on.
- **Encrypted backups:** `npm run backup:keygen` (once; **save the recovery key it prints**), then `npm run backup -- --to <folder>`; `npm run backup:drill -- <file>` proves a backup opens; `npm run backup:restore -- <file> <new.db>` restores into a *new* file. On the server: `deploy/jarvis-backup.service` + `.timer` run it daily at ~03:15 into `/var/backups/jarvis`, keeping 14. Copy that folder off-site with anything you like (rclone, a synced folder): the files are useless without your recovery key. The server holds only the public key.
- Do a restore drill **before** relying on any of it, and again after changing keys.

## NOT built yet (do before real use on the server)
| Item | Why it matters |
|---|---|
| Independent security review of the server setup and of `server/passkey.ts` (custom WebAuthn code) | Fresh eyes before it leaves the Mac |
| Uptime alert (e.g. a free external pinger on the private link, or a daily "I'm alive" notification) | You should hear if it stops |
| Off-site copy of the backup folder (rclone/sync job) | The timer writes on the same server; copy it elsewhere |
| Decision: Anthropic data-retention terms | Luke's call; see docs/DEPENDENCIES.md |
| Test run on the Mac for a few days | Cheapest place to find mistakes |
