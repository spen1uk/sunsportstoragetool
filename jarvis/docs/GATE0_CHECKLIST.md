# Gate 0: a week of normal use on your Mac

**Goal:** find the annoying or broken things on your own Mac, where it costs nothing, before a server is bought. About 5 minutes a day. Nothing here spends money beyond your normal Anthropic usage.

## Day 0: set up once (30 minutes)
- [ ] Update to the latest code: in Terminal, go to the project folder and run `git pull origin claude/magical-heisenberg-ce1m2m`, then `cd jarvis` and start Jarvis (`npm run launch`, or your `Jarvis.command`).
- [ ] Open **`http://localhost:8788`** (not `127.0.0.1`; passkeys need the word localhost). If a VPN blocks it, turn the VPN off for now.
- [ ] Settings → **Passkeys**: confirm you have one. Sign out (Lock) and sign back in with it.
- [ ] Settings → **Encrypted backups**: if it says "no key yet", run `npm run backup:keygen` and **save the recovery key in your password manager right now** (it is shown once). Then make a backup: `npm run backup -- --to ~/Documents/Jarvis-Backups`.
- [ ] Do the **restore drill**: `npm run backup:drill -- <that backup file>`. It should say it passed.
- [ ] Settings → **Health**: everything should be a tick. Note anything with a warning.
- [ ] Settings → **Devices**: add a test device called "Test phone" (kind: phone, limit $2). Copy the key. Open `http://localhost:8788/go`, paste it, tap **Greeting**, then ask it something. Then remove the device.
- [ ] Optional: turn on the start-at-login option (`bash scripts/autostart.sh`) so Jarvis is just there each morning.

## Every day (5 minutes)
- [ ] **Morning:** open the Command Center. Is the greeting right (appointments, urgent items)? Anything wrong or missing?
- [ ] **Calendar and Notes:** do today's events match your real calendar? (Calendar page; it says if the copy is stale.)
- [ ] **Use it for real, three times:** add a task by chat, check off a habit, ask a question about your day. Click Confirm on any suggestion it makes.
- [ ] **Settings → Health:** all ticks? Last backup less than a day old?
- [ ] **Settings → AI models:** glance at today's spend. Anything surprising?
- [ ] **Write down one thing** that annoyed, confused or surprised you (even small). Paste the list into the chat any time.

## Specific things to try (one or two per day)
| Day | Try this |
|---|---|
| 1 | Ask Jarvis something it should **not** be able to do (send a text, buy something). It should say it can't. |
| 2 | Make a standing permission for "Check off a habit" (Approvals page, 7 days, 5/day, dashboard only). Tell Jarvis you did your habit. Then revoke it. |
| 3 | Try the **driving** view of `/go` on your phone over your Wi-Fi if you can (typing works; voice may need the server). Notice what's too small or too slow. |
| 4 | Turn on **Private** mode in chat, say something, and confirm nothing about it shows in the history. |
| 5 | Pause Jarvis, confirm nothing new runs, then resume. |
| 6 | Make a fresh backup and restore drill again. Check the file really is in your backup folder. |
| 7 | Rearrange the Workspace, set a panel's ⚙ options, save the layout, reload, confirm it stuck. |

## Stop and tell me right away if
- A Confirm card says one thing and the result is another.
- Jarvis claims to have done something (sent, bought, booked) that it can't have.
- The spend number jumps by more than a couple of dollars in a day.
- Health shows a red/urgent item that doesn't clear.
- Sign-in stops working (you can reset with `npm run setup -- --reset-passphrase`).

## Gate 0 passes when
- [ ] Seven days of normal use with no "stop and tell me" events (or each one was fixed and then ran clean for 2 days)
- [ ] At least 3 backups made and 1 restore drill passed after the last key change
- [ ] Your annoyance list is empty or I've fixed/decided each item
- [ ] You're happy to move on: then pick the server provider (docs/SERVER_MOVE.md, Gate 1)
