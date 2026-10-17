# Threat model (slice 1)

**Assets:** owner passphrase/session, approval integrity, the database (conversations, memory, drafts), future provider keys and account connections, budget.
**Actors:** remote attacker (if ever exposed), malicious web content fetched for research, malicious local web page in Luke's browser, a compromised dependency, a future prompt-injected model.
**Trust boundaries:** browser ↔ API · API ↔ worker/tools ↔ network · API ↔ future adapters (calendar, SMS, Sandra, Mac).

| Threat | Mitigation in code | Residual / next |
|---|---|---|
| Remote access to API | Binds `127.0.0.1` by default; warns otherwise; no public deployment made | TLS + reverse proxy + passkeys before any exposure |
| DNS-rebinding / hostile local page driving the API | Host header allow-list (421), SameSite=Strict cookie, Origin check, per-session CSRF header, JSON-only bodies, no CORS | — |
| Credential guessing | 160-bit random passphrase, scrypt (N=2^15), lockout with exponential backoff; optional passkeys (WebAuthn ES256, user verification required) that can replace the passphrase for sign-in | In-memory throttle resets on restart; passkey code is custom and awaits independent review |
| Session theft | HttpOnly+SameSite=Strict, 12h expiry, hashed token at rest, `Secure` when non-loopback | Device list/revocation UI |
| High-risk approval by stolen session | Step-up passphrase (5 min window) for high-risk approvals | Hardware key step-up |
| Approval tampering / replay / double execution | Canonical-JSON digest, digest echoed by client and re-verified at execute, status transition as lock, expiry, pause blocks execution | Tested |
| Voice/phone spoofing ("yes", caller ID) | Phone/SMS channels rejected outright; chat can never approve | Verified-identity step-up design needed before enabling |
| SSRF via research fetch | https-only, per-host approval, allow-list re-checked on every redirect, DNS result must be public, connection pinned to vetted IP, no creds in URL, size/time/redirect caps, text types only | Proxy-aware egress policy if deployed behind one |
| Prompt injection in fetched content | Content is data: quoted, flagged, no instruction path; tools/permissions are server-side; injected "add to allow-list" produced no approval/state change (test) | Re-test with each new tool/model |
| XSS from untrusted documents | Documents rendered as React text nodes only (no `dangerouslySetInnerHTML`); CSP `script-src 'self'`, `frame-ancestors 'none'` | — |
| Provider API key theft/leak | Key only in env var or `data/secrets.json` (0600); set via hidden-input CLI; no API route returns it (canary test over `/api/*`); used only server-side by the SDK; audit redacts key-shaped strings | Any process running as you can read the file; Keychain storage is a later hardening |
| Model output used to act (prompt injection via chat/memory/documents) | Model gets **no tools** and its output is rendered as text; fixed rules precede persona; memories and pasted text are labelled `<data>` with angle brackets stripped; commands and approvals are separate server-side paths | Re-review before ever giving the model tools |
| Persona/preferences used to weaken rules | Persona is a strict schema, sent after the fixed rules, as "style only" | — |
| Content sent to a model provider | Private mode keeps the model off by default; opt-in toggle is audited; memories/history are not sent in private mode | **Provider retention terms are unverified**: review Anthropic's before adding a key |
| Runaway model spend | Reserve-before-call, daily ceiling ($1 default; raise = high-risk approval), 90%/100% monthly gates, usage table | Provider-side spend limit in the Anthropic console (do this when creating the key) |
| Secrets in logs/memory | Audit redacts secret-shaped strings; memory refuses secrets; server logs error messages only, never bodies | Pattern-based, not perfect |
| Tampering with history | Hash-chained audit log, verified on the Activity page and in backup verification | Chain protects against edits by casual tampering, not an attacker with DB write + recompute; anchor head hash off-box later |
| Runaway spend | Reserve-before-dispatch, 75/90/cap gates, fixed costs first, cap changes need high-risk approval | Provider-side limits when providers exist |
| Dependency compromise | 4 runtime deps pinned exactly; `npm audit` clean at install; no install scripts needed | Add lockfile review + update cadence (DEPENDENCIES.md) |
| Private-mode leakage | Server creates no message/audit/memory/task rows in private mode (test) | Provider-side retention must be documented per provider before one is added |
| Data at rest | DB file `0600`, data dir `0700` | Disk encryption relies on the OS (FileVault); encrypted backups built (public-key, `npm run backup`); off-site copy job still manual |
| Standing permission abused (prompt injection making the model propose something that then auto-runs) | Only 4 low-impact, undoable kinds can be granted; daily cap; expiry; per-interface; paused = off; granted only with step-up on the dashboard; uses counted and audited | An injected suggestion could still add a few junk tasks or tick a habit within the cap; all are visible and undoable. Residual risk accepted by choosing to grant |
| Weather feed used to inject instructions or reach internal hosts | Two fixed hosts, https only, public-IP pinned, no redirects, 200 KB cap; response parsed against a strict numeric schema; the model only sees text we build from numbers and a fixed word table; place names cleaned | If Open-Meteo itself were compromised it could report false weather; labelled with its source and age |
| Web pages (via web search) used to inject instructions or to steal private data | Off by default; explicit "search:" only; search turns carry no calendar/tasks/memories/history and cannot create proposals or actions; web fetch tool not enabled (no arbitrary URL for exfiltration); search runs on Anthropic's servers (our server never connects to pages); output cleaned, https-only sources, labelled unverified; stored flagged and later shown clipped; per-question and daily caps | A page can still make the answer wrong or misleading, or make the model search for something odd (costs a cent; no private data is in the prompt to leak). Luke should verify anything important via the sources |

## Retention note (forget/backups)
`forget` deletes the memory row. Prior snapshots made with **Create local snapshot** still contain it until deleted by you. Policy: keep the 7 most recent snapshots; delete older ones; off-box copies must be encrypted and age out on the same schedule. (Automated pruning is not built yet.)

## Explicitly out of scope today
Screen observation, Mac companion, telephony, third-party OAuth connections — none exist, so none of their threats are mitigated yet; each needs its own model before building.
