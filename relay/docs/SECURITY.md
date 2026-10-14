# Security notes (Phase 6 state)

**Authn/z:** argon2 passwords, DB-backed sessions (httpOnly, SameSite=Lax, Secure in prod), CSRF header on all non-GET `/api` calls, department-scoped visibility enforced in SQL, role gates in the domain layer. Assistant: separate machine identities, hashed keys (sha256, shown once, prefix lookup, constant-time compare), instant revocation, scopes + autonomy + departments, per-identity rate limit, audit with `actor_type='service'` and correlation ids.
**Transport/headers:** `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, COOP, CSP on HTML (`default-src 'self'`, inline styles allowed for React style attributes), HSTS in production, `Cache-Control: no-store` on `/api`.
**Secrets:** integration credentials/webhook secrets AES-GCM encrypted with key versions and AAD binding; logs redact `Authorization`, cookies, signatures and signed-URL query tokens (tested). Production boot guard refuses dev defaults.
**Outbound requests:** SSRF-guarded (public addresses only, pinned, https, no redirects) for webhooks and assistant push.
**Abuse limits:** global per-IP limiter, tighter on login/invitation, per-identity API limiter. `TRUST_PROXY` defaults to false.
**Known gaps / non-goals:** no MFA/SSO; no automatic secret rotation; per-process rate limits; CSP allows inline styles; no WAF; no penetration test; no formal dependency audit job; keyword authority rules are a heuristic; the Docker image is untested; backups are not encrypted by the script (encrypt the offsite copy).
**Reporting:** treat a leaked assistant key like a leaked password: revoke in Settings → Assistant.
