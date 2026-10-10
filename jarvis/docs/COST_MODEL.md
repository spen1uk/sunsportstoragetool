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

## Recommendation
Stay on **A** while polishing; move to **B** (smallest paid step, ≈$20–37) when you approve a model provider and host; add SMS (**C**) next; treat voice (**D**) as the first feature that needs an explicit budget decision. Nothing is purchased or deployed.
