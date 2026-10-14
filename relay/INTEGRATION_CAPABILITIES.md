# Integration capability matrix
**The authoritative, always-current matrix is in code (`src/integrations/catalog.ts`) and is shown in the app under Connections** (capabilities, evidence state, scopes, account requirements, costs, tests, blockers, sources). This file summarises it as of 2026-10-13.

States: **verified-docs** · **sandbox-tested** · **production-tested** · **unsupported** · **pending-investigation**. **Nothing is production-tested.** No real provider adapter exists; only sandbox adapters (`demo_pay`, `demo_reviews`) can be connected, and they are refused in production.

**Research limits:** official docs were reachable only through search summaries (the docs sites could not be fetched from this environment), so API request/response shapes are NOT verified and no HTTP client was written from memory. Each item below says what the docs summary established and what remains.

| Integration | Implementation | What the official docs established | Owner action / blocker |
|---|---|---|---|
| Generic webhooks (out/in) | **complete** (sandbox-tested transport) | n/a — built to the documented timestamped-HMAC scheme | Public HTTPS hosting for real traffic |
| Sandbox payments / reviews | sandbox | n/a | none (demo) |
| Stripe | helper only | Webhook signature scheme (t=,v1=; HMAC-SHA256 of `t.payload`; raw body; 5-min default tolerance) | Choose provider; credentials; fetch + verify API docs |
| Google Business Profile (reviews) | not built | Reviews API v4 lists/replies; **access is application-gated** (verified profile active 60+ days, live website, contact form, ~14-day review, quota>0 = approved); replying for a client needs their authorization | Owner/manager of the profile applies for API access; Cloud project + OAuth client |
| Gmail | not built | Read/modify/compose scopes are **restricted** (server-stored data → independent security assessment, repeated ≥ every 12 months; in-organization-only apps are said to be exempt — verify); `gmail.send` is **sensitive** | Decide scope/verification path; OAuth client |
| Google Calendar / Drive | not built | Independent from Gmail; Drive whole-drive scopes are restricted-class; classifications for Calendar not confirmed | OAuth client; confirm scopes |
| QuickBooks Online | not built | Accounting scope `com.intuit.quickbooks.accounting` covers Invoice/Payment; Payments API is a separate scope; webhooks (Invoice, Payment; connected companies only; fetch entity by id after) and Change Data Capture exist | Intuit developer app + company admin OAuth; source-of-truth decisions (see docs/PAYMENTS_RECONCILIATION.md) |
| Facebook/Instagram | not built | Business Pages / professional accounts only; Page access tokens; Standard vs **Advanced Access** (App Review + Business Verification for people without an app role; own-Page use may skip review); **personal Marketplace messaging: no verified API — not promised, never scraped** | Meta app; Business Verification; Page admin authorization |
| TikTok | not built | Business Messaging API (DMs, webhooks) exists but is gated: **data security & privacy review, US data security review, USDS addendum**; not available in EEA/CH/UK; lead webhooks + lead retrieval exist; **no universal DM inbox promised** | Access approval/reviews |
| RingCentral (calls only) | not built | Telephony-session notifications (account/extension level; per-party missed-call flag and missed-call filter; may arrive out of order; link by `telephonySessionId`); Call Log API is a heavy-usage API; subscriptions via the Subscription API | App credentials + admin authorization. **SMS routing on 262-269-0081 will not be touched.** |
| Zoho CRM | not built | Change notifications via `POST /actions/watch` (scope pattern `ZohoCRM.notifications.{op}`); confirm exact scopes via List Available APIs | OAuth client; data-centre region; field mapping |
| OpenAI / Anthropic | not built (adapter interfaces exist) | n/a | API key + approval; see docs/AI_DATA_SHARING.md |
| Twilio / Telnyx SMS (Hosted SMS) | not built | Both: **US/CA landline (Twilio also toll-free); mobile numbers excluded**; number already SMS-enabled can't be hosted (Twilio); LOA must match the voice provider's records; ownership verification (Twilio: code call or phone bill) or recent bill (Telnyx); Telnyx needs Level 2 verified account; wireless/Google Voice numbers are a problem | **Eligibility of 262-269-0081 is UNKNOWN** (carrier/line type unverified); provider choice; account; spend approval |
| Sandra | **API built (`/api/v1`), tested with a fake client only; not connected** | Own contract: docs/SANDRA_API.md | Owner creates access in Settings → Assistant after Sandra's runtime is ready |
| Inventory / service / storage / website | partial | Inventory CSV import ✓; website → signed inbound lead endpoint ✓ | System access details for live feeds; storage tool adapter |

## Live-number unknowns (unchanged)
1. Who is the SMS provider/owner of 262-269-0081 today and how does Kenect text on it?
2. Line type per carrier lookup (landline/VoIP/mobile) and whether it is already messaging-enabled.
3. Can Kenect export contacts/history/templates/media/consents?
Until answered, use a separate temporary test number (needs a provider account and spend approval).

## Automation trigger sources
| Trigger | State | Notes |
|---|---|---|
| Inbound customer text | sandbox-tested | Internal event from the verified webhook path. |
| No response (follow-up) | sandbox-tested | Internal scan of conversation state. |
| Inventory update | sandbox-tested | Internal event; only customers who marked interest. |
| Appointment / service / storage / invoice events | **unsupported until adapters exist** | Drafts and previews work; activation is refused with an explanation. |
