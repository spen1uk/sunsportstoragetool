# Data retention, export and erasure

Relay is a system of record for customer conversations and consent evidence. Retention periods are **business/legal decisions** for the owner (and counsel); Relay provides mechanisms, not legal advice.

| Data | Current behavior |
|---|---|
| Messages, notes, contacts, tasks | Kept until an admin erases the contact. No automatic expiry. |
| Consent / opt-out history | Kept (proof we honoured STOP), even after erasure of the contact; free-text evidence is blanked on erase. |
| Media: inbound MMS / voice | Expiry/purge job exists (`maintenance`); library files kept until deleted. |
| Assistant event feed | Pruned after 30 days once every active consumer acknowledged it. |
| Audit log | Kept indefinitely (IDs and actions, not message text). |
| Sessions / jobs / webhook ledgers | Operational; sessions expire (`SESSION_TTL_HOURS`). |
| Backups | Contain everything at backup time; age out by your backup retention (14 days local by default). |

**Export** (access request): `GET /api/contacts/:id/export` (owner/admin) → JSON with identities, consent, conversations, messages, notes, boats, preferences, tasks, payments, timeline, attachment metadata. Audited.
**Erase** (`POST /api/contacts/:id/erase {"confirm":"ERASE"}`, owner/admin): anonymizes in place — name/company/email/tags, all message text, notes, boats, preferences, summaries, voice transcripts, drafts, attachments (files deleted), free text on tasks/timeline/payments. Kept: consent history; payment amounts/status (financial records; description cleared); message metadata and the audit trail. The phone number is kept only if the person had opted out or was do-not-text (so a later text can’t silently re-enable messaging); otherwise deleted. The contact is permanently outbound-blocked. Refused while a payment request is open. Queued sends are cancelled.
**Not covered:** team-chat messages that mention the person; older backups; copies at SMS/payment/AI providers; the audit log; any export a staff member already made. Decide a policy for these.
