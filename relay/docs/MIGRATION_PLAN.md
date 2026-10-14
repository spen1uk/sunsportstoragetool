# Kenect → Relay migration plan (preparation state)

**Nothing in this plan has been executed.** No provider account exists, no test number was obtained, no live text was sent, 262-269-0081 and RingCentral are untouched, Kenect is untouched, nothing was spent. Relay has no code path that changes routing, ports a number, or cancels a service. Everything marked ☐ needs the owner and/or an external account. Track progress in the app: **Kenect Migration → Cutover checklist** (records evidence; enforces order, owner-only items, the validation window, and Relay’s own data checks).

## What we do NOT know (resolve first; checklist “Discovery”)
1. Who provides SMS for 262-269-0081 today, and how Kenect texts on a number whose voice is on RingCentral (Kenect-supplied provider? hosted/“text-enabled” landline? a port?). Not assumed.
2. The number’s line type and whether it is already messaging-enabled somewhere (affects every option below).
3. What Kenect can export (contacts, history, templates, media, opt-outs) and in what format. **Availability is unknown.** Kenect’s export layout has not been seen; the import tool therefore maps columns instead of assuming a layout.
4. Kenect’s contract term, renewal date, notice period and data-return clause.
5. What RingCentral does on the number today (hours routing, voicemail, any SMS use).

## SMS-only migration: feasibility paths (to be verified, not chosen)
The aim is to move **text handling only**, keeping RingCentral voice exactly as is. Per the research summaries recorded in INTEGRATION_CAPABILITIES.md (docs were not fetchable here; **re-verify on each provider’s current official pages before relying on any of it**):
- **Hosted/“text-enable” the existing number at an SMS provider** (Twilio / Telnyx style): both summaries say US/CA **landline** numbers can be hosted while mobile numbers are excluded; a number already SMS-enabled elsewhere may be ineligible; a letter of authorization must match the voice provider’s records; ownership verification (code call or recent phone bill); wireless/VoIP/Google-Voice numbers are a problem. **Eligibility of 262-269-0081 is UNKNOWN** until its line type and current messaging status are confirmed.
- **Keep Kenect for the business number, run Relay on a different number** (parallel run / permanent): no routing change at all; customers would see two numbers. Lowest risk; savings depend on whether Kenect can be dropped.
- **Port the whole number to a messaging provider**: would move voice too → **excluded** by the owner’s rule (“never port the entire number”). The checklist item `v_plan_no_voice_change` makes the owner confirm the plan does not do this.
- Carrier/registration requirements for A2P messaging (e.g., brand/campaign registration) and their lead times: **not verified**; they may dominate the schedule.
The choice, any provider account and any spend are **owner decisions** (checklist `t_provider`).

## RingCentral voice preservation checks (checklist “Voice”)
Before any change: record a baseline (inbound call rings the expected phones, hours-based routing, after-hours/voicemail greeting, caller ID on outbound) from two different carriers. After any SMS-side change in the test window **and** again after cutover: repeat and compare. A voice regression at any step = stop and roll back SMS handling first; do not “fix” voice by touching the number’s configuration without the owner.

## Data migration (built; see docs/IMPORT_GUIDE.md)
Staged CSV imports for contacts, history, opt-outs, templates: map → preview → commit (typed confirmation) → reconcile via the “not imported” list → rollback if needed. Opt-outs are retained and enforced by the normal send pipeline; imported history is silent and closed. If Kenect cannot export history, summaries say so on the customer record (“earlier text history was not imported”) and staff must be told; checklist `e_history` requires either an import or a written disclosure.

## Test number gates (all ☐, all need a provider + owner spend approval)
Inbound received with verified signature and no duplicate on retry · outbound accepted then delivered with honest statuses · STOP/START/HELP · scheduled and broadcast sends suppressed after STOP · MMS · Sandra not sending. No adapter for a real SMS provider exists yet; it is built after the provider decision (Phase-2 live gate is still BLOCKED).

## Staff pilot (☐)
Train everyone who texts customers (takeover, opt-outs, templates, notes). Pilot on the test number (suggested at least a week; owner decides). Log issues; no open blocker before cutover. Keep Kenect fully active throughout.

## Cutover timing (☐ — owner decides; suggestions only)
Outside business hours, a weekday morning so staff and provider support are available, not around a holiday or a boat show, with a backup taken immediately before and the rollback owner reachable. Exact steps depend on the chosen path and provider portal; they are written into the checklist item `c_plan` once known. Provider lead times and revert times are **unverified** and must be written down before the go decision.

## Rollback / fallback (☐ rehearsed before go)
Kenect remains active and untouched until the owner approves cancelling it. Rollback = revert SMS handling to Kenect via the provider/portal path documented in `c_rollback_plan` (time-to-revert at the provider is unknown today), staff meanwhile use the Kenect app; Relay’s imported data is retained, opt-outs added in Relay during the window are exported back to Kenect by hand (Relay has no Kenect connection). Data side: import rollback is built and tested; backup/restore is built and rehearsed (`npm run drill:restore`).

## Go / no-go and cancellation (owner only)
`c_go` (change SMS handling) requires every earlier item. `c_done` records that it happened (outside Relay). A validation window (default 14 days, owner-adjustable 1–90) must pass before `c_validation`; `c_kenect_cancel` is last and requires it. Relay never cancels anything; before cancelling with Kenect export a final copy of everything.
