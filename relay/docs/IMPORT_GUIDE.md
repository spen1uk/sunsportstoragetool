# Import guide (contacts, message history, opt-outs, templates)

Where: **Kenect Migration → Import data** (owner/admin). API: `/api/migration/imports…`. Synthetic examples with every edge case: `fixtures/kenect-synthetic/` (**not** a real Kenect export; real headers will differ — that is what the mapping step is for).

## Flow
1. **Upload** a CSV (≤ 25 MB, ≤ 200 000 rows; comma/semicolon/tab, UTF-8, quotes and embedded newlines OK). The original bytes are stored untouched with a SHA-256 (also in `import_batches`) and are included in backups.
2. **Map** columns (Relay suggests from header names; you confirm). Required fields are marked. Dates without a time zone are read in the zone you give (default: business timezone); the preview repeats which zone was assumed. A column that looks like an opt-out flag but isn’t mapped triggers a warning so opt-outs are not silently dropped.
3. **Check** (“stage”): every row is validated into `import_rows`; **no customer data is written**. Preview: counts (will import / need a look / duplicates / errors), reasons, new vs matching contacts, opt-outs, date range, contacts with no history. Re-check with a different mapping as often as needed.
4. **Commit** (typed `COMMIT`): one transaction; all or nothing. A failure leaves nothing behind.
5. **Reconcile**: download the “not imported” CSV (original columns + outcome + reason); account for every row against the source.
6. **Rollback** (typed `ROLLBACK`) if needed.

## Rules the importer follows
- **Phone numbers** are normalized (US default) and the original text is kept. Unparseable → error row.
- **Duplicates** in a file (same number, compatible name) merge into the first row; an opt-out on a duplicate row is never lost.
- **Shared numbers**: same number but a different name is **not merged** — it becomes a separate contact tagged `needs-review`. A number belonging to several existing contacts is never guessed: those rows are skipped and listed.
- **Existing contacts** (matched by number) only have **blank** fields filled and tags added; nothing is overwritten.
- **Opt-outs**: contact-list flags, the consents file, and **STOP / START keywords inside imported history** are recorded as consent events with their **original dates**. The latest event wins (tie → STOP); an imported START can never override a newer STOP; “yes” is not treated as START. An opt-out for an unknown number creates a contact so the number stays blocked. A STOP applies to every contact sharing that number. Opt-outs are **never rolled back**.
- **Consent is never granted by import**: a phone number alone is not consent; marketing opt-in rows require evidence text and never override an opt-out.
- **History** lands as **closed, unassigned** conversations with original timestamps/direction; imported inbound messages are not unread, create no notifications, start no automations/follow-ups/auto-replies, never send anything, and are excluded from analytics so Relay’s response-time/volume numbers stay honest. Threads display in time order (imported older messages sort before live ones). A new inbound text reopens a thread normally. Re-importing a file is idempotent (messages are keyed by original id, or by number+time+direction+text).
- **Templates**: common merge-token styles (`[First Name]`, `{first_name}`, `%FIRST_NAME%`, `{{first_name}}`) are converted; anything unrecognized is left as-is, the template is imported **inactive** and flagged for review. Existing names are skipped.
- **Media/attachments** are not fetched (needs an authenticated export): message rows keep a placeholder and the count is reported; upload needed files to the Media library.
- **Summaries**: after history import the summary rebuilds over it (with a note “includes N imported messages dated …”). Contacts imported without history say “earlier text history was not imported”.

## Rollback semantics
Removes messages and (empty) conversations the batch created, contacts it created, templates it created (deactivated instead if edited), fields it filled and tags/notes it added. **Kept and reported**: contacts with an opt-out (`keptForOptOut`) and anything staff have used since (`keptBecauseUsed`: notes, tasks, replies, payments, other consent).

## Limits / not built
No Kenect API connection; no automatic fetching of attachments; no XLSX/JSON (CSV only); no contact-merge tool (shared numbers are flagged for manual review); very large files are processed in memory (200k-row cap); the real export layout and completeness are **unverified**.
