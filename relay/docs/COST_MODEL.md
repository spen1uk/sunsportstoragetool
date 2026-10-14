# Cost model (formulas and assumptions only — NO prices have been verified)

Provider prices change and none were fetched or confirmed. Fill the **bold unknowns** from current vendor pages/quotes before deciding anything. Nothing was purchased.

Monthly total = Hosting + Database + Storage/backups + Domain/TLS + SMS + (Email/other providers) + AI usage + Monitoring + Your time.

| Component | Quantity driver | Formula | Unknown to fill |
|---|---|---|---|
| Host (server+worker+Caddy) | 1 small VM | `vm_price` | **VM price/month** |
| PostgreSQL | self-hosted on the VM or managed | `0` or `managed_price` | **managed price** |
| Media + backups | `media_GB + 14 × (db_GB + media_GB)` stored; offsite copies | `GB × price_per_GB` | **storage $/GB-month, egress** |
| Domain / TLS | 1 domain; Caddy certs free | `domain/12` | **domain price** |
| SMS (when a provider is connected) | `outbound_segments + inbound_segments` per month (a segment ≈ 160 GSM-7 chars or 70 UCS-2; MMS billed separately) | `segments × per_segment + carrier/10DLC registration + number rental` | **provider per-segment, MMS, number, 10DLC/registration fees** |
| AI (summaries/cleanup/assistant) | currently **zero**: rule-based only | `tokens_in×p_in + tokens_out×p_out` once a provider is enabled | **model prices**, usage (see `ai_usage` table) |
| Payments | only if a processor is connected | `% + fixed per transaction` | **processor fees** |
| Monitoring/alerting | optional | `0` to `tool_price` | **tool** |

Measure instead of guessing: segments/month are countable from `messages` (`SELECT date_trunc('month',created_at), direction, count(*), sum(ceil(length(body)/160.0))`), storage from `media_assets.size_bytes` + `pg_database_size`, and Kenect's current bill is the comparison baseline (**get the figure from the invoice**). Capacity has **not** been load-tested; the design (single Postgres, SKIP LOCKED queue) is expected to suit one dealership's volume, not validated.
