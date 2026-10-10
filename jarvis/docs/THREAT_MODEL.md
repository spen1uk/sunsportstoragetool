# Threat model (slice 1)

**Assets:** owner passphrase/session, approval integrity, the database (conversations, memory, drafts), future provider keys and account connections, budget.
**Actors:** remote attacker (if ever exposed), malicious web content fetched for research, malicious local web page in Luke's browser, a compromised dependency, a future prompt-injected model.
**Trust boundaries:** browser ↔ API · API ↔ worker/tools ↔ network · API ↔ future adapters (calendar, SMS, Sandra, Mac).

| Threat | Mitigation in code | Residual / next |
|---|---|---|
| Remote access to API | Binds `127.0.0.1` by default; warns otherwise; no public deployment made | TLS + reverse proxy + passkeys before any exposure |
| DNS-rebinding / hostile local page driving the API | Host header allow-list (421), SameSite=Strict cookie, Origin check, per-session CSRF header, JSON-only bodies, no CORS | — |
| Credential guessing | 160-bit random passphrase, scrypt (N=2^15), lockout with exponential backoff | In-memory throttle resets on restart; passkeys later |
| Session theft | HttpOnly+SameSite=Strict, 12h expiry, hashed token at rest, `Secure` when non-loopback | Device list/revocation UI |
| High-risk approval by stolen session | Step-up passphrase (5 min window) for high-risk approvals | Hardware key step-up |
| Approval tampering / replay / double execution | Canonical-JSON digest, digest echoed by client and re-verified at execute, status transition as lock, expiry, pause blocks execution | Tested |
| Voice/phone spoofing ("yes", caller ID) | Phone/SMS channels rejected outright; chat can never approve | Verified-identity step-up design needed before enabling |
| SSRF via research fetch | https-only, per-host approval, allow-list re-checked on every redirect, DNS result must be public, connection pinned to vetted IP, no creds in URL, size/time/redirect caps, text types only | Proxy-aware egress policy if deployed behind one |
| Prompt injection in fetched content | Content is data: quoted, flagged, no instruction path; tools/permissions are server-side; injected "add to allow-list" produced no approval/state change (test) | Re-test with each new tool/model |
| XSS from untrusted documents | Documents rendered as React text nodes only (no `dangerouslySetInnerHTML`); CSP `script-src 'self'`, `frame-ancestors 'none'` | — |
| Secrets in logs/memory | Audit redacts secret-shaped strings; memory refuses secrets; server logs error messages only, never bodies | Pattern-based, not perfect |
| Tampering with history | Hash-chained audit log, verified on the Activity page and in backup verification | Chain protects against edits by casual tampering, not an attacker with DB write + recompute; anchor head hash off-box later |
| Runaway spend | Reserve-before-dispatch, 75/90/cap gates, fixed costs first, cap changes need high-risk approval | Provider-side limits when providers exist |
| Dependency compromise | 4 runtime deps pinned exactly; `npm audit` clean at install; no install scripts needed | Add lockfile review + update cadence (DEPENDENCIES.md) |
| Private-mode leakage | Server creates no message/audit/memory/task rows in private mode (test) | Provider-side retention must be documented per provider before one is added |
| Data at rest | DB file `0600`, data dir `0700` | Disk encryption relies on the OS (FileVault); encrypted off-box backups TODO |

## Retention note (forget/backups)
`forget` deletes the memory row. Prior snapshots made with **Create local snapshot** still contain it until deleted by you. Policy: keep the 7 most recent snapshots; delete older ones; off-box copies must be encrypted and age out on the same schedule. (Automated pruning is not built yet.)

## Explicitly out of scope today
Screen observation, Mac companion, telephony, third-party OAuth connections — none exist, so none of their threats are mitigated yet; each needs its own model before building.
