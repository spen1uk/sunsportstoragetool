# "Ask Jarvis": a Siri Shortcut for your iPhone 17 Pro Max and the Velar

**Status: written, not yet tried.** I can't run Shortcuts or CarPlay from here, so the steps below come from how Jarvis's device API works (tested) and Apple's Shortcuts app as I know it. Menu wording may differ slightly on your iOS version; if a step doesn't match your screen, tell me what you see. Whether Siri runs a Shortcut cleanly *inside CarPlay* is the thing this test is meant to find out (see docs/CARPLAY_RESEARCH.md).

It is **not an app**: it's a Shortcut in Apple's built-in Shortcuts app. Nothing to install, sign or pay for.

## Before you start (needs Jarvis reachable from the phone)
1. Tailscale installed and signed in on the **iPhone** and on whatever runs Jarvis (your Mac for now, the server later), with **Tailscale turned on** on the phone.
2. Jarvis reachable over **HTTPS** at the machine's Tailscale name, e.g. `https://your-mac.your-tailnet.ts.net` (run `tailscale serve --bg 8788` on that machine).
3. That name added to Jarvis's allowed hosts: set `JARVIS_ALLOWED_HOSTS=your-mac.your-tailnet.ts.net` and restart Jarvis. (Without this Jarvis answers "unexpected host".)
4. In Jarvis: **Settings → Devices → Add device**: name `Luke's iPhone (Siri)`, kind **car**, monthly limit **$3**. Confirm with your passphrase or passkey. **Copy the key (starts `jvd_`)**. It is shown once.

Quick check in Safari on the phone: open `https://<your-name>/go`, paste the key, tap Greeting. If that works, the Shortcut will.

## Build the Shortcut "Ask Jarvis"
Shortcuts app → **+** → name it exactly **Ask Jarvis**. Add these actions in order:
1. **Dictate Text**. Open its options: Language *English*, Stop Listening *After Pause*.
2. **Get Contents of URL**. URL: `https://<your-name>/api/device/chat`. Tap **Show More**:
   - Method: **POST**
   - Headers: `Authorization` = `Bearer jvd_…your key…` (the word Bearer, a space, then the key) and `Content-Type` = `application/json`
   - Request Body: **JSON**, with two fields: `text` (type Text, value: the *Dictated Text* variable) and `mode` (type Text, value `driving`)
3. **Get Dictionary Value**: Get *Value* for key `speak` in *Contents of URL*.
4. **Speak Text**: the *Dictionary Value*.
Optional: turn off "Show When Run" on each action so nothing needs your eyes.

Test it by tapping ▶ in the app: say "what's on my calendar today", you should hear Jarvis answer.

## Build a second one, "Jarvis Greeting" (optional, simple)
1. **Get Contents of URL**: `https://<your-name>/api/device/greeting?profile=glance`, method **GET**, header `Authorization` = `Bearer jvd_…`.
2. **Get Dictionary Value** for `speak`. 3. **Speak Text**.
Say "Hey Siri, Jarvis Greeting" for the short driving greeting.

## Ways to start it (you don't need the steering-wheel button)
| Way | How | Notes |
|---|---|---|
| Voice | "Hey Siri, Ask Jarvis" | Test in the car with the phone plugged in; "Hey Siri" support in CarPlay is the thing to verify |
| CarPlay screen | Hold the Siri/voice control on the CarPlay home screen, say "Ask Jarvis" | Same Siri path |
| **Action Button** | Settings → **Action Button** → swipe to **Shortcut** → choose *Ask Jarvis* | Phone-side, reliable, no Siri needed; one press then speak |
| Steering-wheel button | Only if it starts Siri (you think it doesn't) | Skip |

## What to try, and what to tell me
In the driveway first, then on a short drive (passenger or parked; **don't fiddle while driving**):
- [ ] "Hey Siri, Ask Jarvis" then "what's on my calendar today": does it listen, answer, and speak through the car speakers?
- [ ] Same with the Action Button.
- [ ] Does Siri say it can't do that while driving, or ask you to look at the phone?
- [ ] How long from asking to hearing the answer (seconds)?
- [ ] Ask it to add a task: confirm it says it left a suggestion for you to confirm later (it never confirms by itself).
Report back which of these worked, and any exact wording Siri used when it failed.

## Safety and cleanup
- The key lives **inside the Shortcut**. Don't share the Shortcut (iCloud link) with anyone. It can only chat, hear the greeting and see the status line; it can **never approve anything**, and it is capped at $3 a month.
- Phone lost, or Shortcut shared by mistake: **Settings → Devices → Remove** that device. It stops working at once; make a new key and edit the Shortcut.
- Private mode isn't used here: every question is saved in your normal history (like any chat).

## If something fails
| What you see | Likely cause |
|---|---|
| "Unexpected host" / error 421 | the Tailscale name isn't in `JARVIS_ALLOWED_HOSTS`, or Jarvis wasn't restarted |
| Error 401 | key typed wrong, missing "Bearer ", or the device was removed |
| Error 402 | the device used its monthly limit (raise it in Settings → Devices → Limit) |
| Error 429 | more than 30 questions in a minute |
| Nothing happens / times out | Tailscale is off on the phone, or the Mac is asleep |
| Siri says it can't run it in the car | CarPlay limit: use the Action Button, and tell me; then option A (real app) is the next candidate |
