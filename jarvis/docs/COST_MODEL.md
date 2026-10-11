# Cost model (monthly, USD) — DRAFT, prices unverified

⚠ Researched 2026-10-10 mostly from **third-party** summaries; official pages could not be confirmed. Re-verify every line on the vendor's own pricing page and **get approval before buying anything.** The $100 cap is *total* operating cost; Claude Code development usage is **not included** (open question #6).

## Unit prices found (source quality in brackets)
- Language model: Claude Haiku 5.5 $0.10 in / $0.50 out per MTok (≤100K prompt); Sonnet 5.5 $2 / $10; batch −50% [aggregators; check [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing)].
- Hosting: Hetzner CX22 ≈ €4.59; Fly shared-1x ≈ $2–11 depending on size; Railway Hobby $5 + usage; managed Postgres ≈ $15–20 [third-party comparisons, conflicting].
- SMS (Twilio): $0.0083/segment on [Twilio's page](https://www.twilio.com/en-us/sms/pricing/us) + carrier fees ≈ $0.003–0.005 [blog]; US local number ≈ $1.15/mo; A2P 10DLC campaign ≈ $10/mo + one-time brand fee $4–40 [third-party]; voice ≈ $0.0085/min in, $0.014/min out [aggregator].
- LiveKit Cloud: Build $0 (≈1,000 agent min), Ship $50 (≈5,000), overage ≈ $0.01/agent-min [third-party]; STT/TTS/LLM inference billed separately — **not found**.

## Scenarios
| Scenario | Fixed | Variable | Total (est.) | Fits $100? |
|---|---|---|---|---|
| **A. Today's slice, run on your Mac** | $0 | $0 (extractive, no model) | **$0** | ✅ |
| **B. Always-on VM + model for chat/briefings** (Haiku-heavy, ~1M in/150k out per day, 10% Sonnet) | VM $5–12 | ≈ $15–25 | **$20–37** | ✅ |
| **C. B + dedicated number, ~10 SMS/day** | +$11–12 (number + 10DLC) | +$3–5 | **$35–55** | ✅ |
| **D. C + 30 min/day voice** (≈900 agent-min; TTS/STT est. $0.03–0.06/min unverified) | +$0–50 (LiveKit tier) | +$27–54 | **$65–160** | ⚠ borderline → gate |
| **E. D + heavy 24/7 research, image generation, frequent calls** | — | open-ended | **> $100** | ❌ gated visibly |

## How the budget code behaves against this
Fixed costs (VM, number, plan fees) are entered under **Settings → Budget** and reserved first. Every billable job reserves its estimate before dispatch; 75% flags burn rate, 90% blocks optional work (deep research/extra content), the cap blocks all billable work, and raising the cap needs a high-risk approval. Stopping jobs does not stop fixed fees — that is why they are counted first. Provider bills lag; local reservations are deliberately conservative.

## Recommendation — cheap-first (decided 2026-10-10: voice deferred, never above $100)
Scenarios D and E are **shelved**. The plan is:

1. **Now ($0):** run on your Mac. No hosting, no model, no phone. This is the current slice.
2. **Next (≈ $5–20/mo):** add a model provider, **Haiku-class only** by default (≈ $0.10/$0.50 per MTok, unverified). Sonnet-class only for jobs you explicitly flag. A per-day token ceiling on top of the monthly cap, so one runaway loop cannot eat the month.
3. **Optional (≈ +$5–7/mo):** a small always-on VM ($5–12) only if you need Jarvis running while your Mac is off. Skip it otherwise; local tasks simply wait.
4. **Optional, only on your approval (≈ +$12–16/mo):** SMS number. Notifications can use desktop alerts and email first at ~$0, so SMS is the first thing to skip if cost matters.
5. **Voice, calls, continuous vision, heavy 24/7 research, image generation:** off, and marked gated in the UI.

Expected steady state: **≈ $10–35/mo**, with the $100 cap as the backstop rather than the target. Nothing is purchased or deployed.

## Model layer: what Jarvis will actually spend (estimates, prices unverified)
- **Chat reply, Haiku 5.5, effort low:** ≈ 1,500 input + ≈ 200 output tokens ≈ **$0.0003**. 100 messages a day ≈ $0.03/day ≈ **$1/month**.
- **"deep:" reply, Sonnet 5.5:** ≈ 3,000 in + 800 out ≈ **$0.014** each.
- **Guards:** every call reserves its worst-case cost first; a **$1.00/day** ceiling (editable; raising it needs your approval); 90% of the monthly cap blocks optional "analysis" calls; the $100 cap blocks everything billable.
- **Not counted:** thinking tokens are billed as output and can exceed these figures; effort `low` keeps them small. Re-check after a week of real use in Settings → AI models.
- **Setup cost today: $0.** No key is configured, so nothing can be billed.
