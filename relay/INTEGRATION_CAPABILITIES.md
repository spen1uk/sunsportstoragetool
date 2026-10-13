# Integration capability matrix
States: **verified-docs** · **sandbox-tested** · **production-tested** · **unsupported** · **pending-investigation**. Nothing is production-tested yet.

| Integration | State | Evidence / notes (researched 2026-10-13, secondary sources — re-verify against official docs before building) |
|---|---|---|
| Twilio Hosted SMS | pending-investigation | Docs describe Hosted Numbers (US/CA landline/toll-free; LOA + ownership call; voice stays with current carrier). Mobile numbers unsupported; API was labelled Developer Preview. Whether 262-269-0081 (RingCentral VoIP) is eligible is UNKNOWN. |
| RingCentral | pending-investigation | RingCentral docs: numbers are not SMS-enabled by default; US local needs brand + campaign (10DLC), toll-free needs verification. Kenect currently texts this number — mechanism unknown. DO NOT change. |
| Telnyx | pending-investigation | Secondary sources: ~$0.004/SMS part + carrier fees, MMS ~$0.015 out. Unverified. |
| Simulator SMS | sandbox-tested (to do) | Built-in, DEMO-labelled. |
| OpenAI / Anthropic | pending | Adapter planned; needs API key. |
| Google (Gmail/Calendar/Drive/Business Profile) | pending | Needs OAuth client. Independent scopes. |
| QuickBooks, Facebook/Instagram, TikTok, Zoho, generic webhooks | pending | Needs credentials; no Marketplace/personal-account scraping. |
| Sandra | interface only | Fake client + contract tests; live connection after owner approval. |

## Live-number unknowns (owner/account questions)
1. Who is the SMS provider/owner of 262-269-0081 today (Kenect-hosted via Twilio-like carrier? RingCentral-native?).
2. Is the number landline/VoIP/mobile type per Lookup? Is it already messaging-enabled somewhere?
3. Can Kenect export contacts/history/templates/media/consents?
Until answered, use a **separate temporary test number** (needs provider account + approval for spend).
