# Payments: sources of truth and reconciliation rules

| Question | Source of truth | Rule |
|---|---|---|
| Was this payment made / refunded / did the link expire? | **The payment provider** | Relay changes status only on (a) a **signature-verified webhook** or (b) an **authenticated** fetch of the provider's totals. A browser success/return URL never changes anything. |
| What is the customer's invoice balance? | **The accounting system (QuickBooks)** | Relay does **not** read or write balances (no QuickBooks connection exists). "Paid" in Relay never clears, adjusts or marks an invoice. The `accounting_ref`/`accounting_note` fields are manual text only, and the UI says the balance is not verified. |
| Who is the customer / what was it for? | Relay (contact + request) | `reference` is free text for matching to an invoice by a person. |

## How status is derived (deterministic, order-independent)
- `paid` = max( sum of verified `succeeded` webhook events , latest provider snapshot's cumulative paid ); `refunded` likewise. Because both are cumulative totals of the same thing, a missed webhook is filled by reconciliation and a late webhook after reconciliation **cannot double-count**.
- paid ≥ amount → **paid** (overpayment is noted); 0 < paid < amount → **partially_paid**; refunds → **partially_refunded / refunded**; a refund seen *before* its payment never concludes anything (state is held with an explanation until the payment is known).
- A non-final failure keeps the link usable; a final failure only counts when nothing was paid; local cancel never hides money (a later verified payment still shows as paid).
- Duplicate deliveries (same provider event id) are no-ops; old captured webhooks fail the 5-minute timestamp check.

## Reconciliation (every ~10 minutes, and on demand)
For open/partial requests, Relay asks the provider for totals. Higher than ours → record the difference (audited). **Lower than ours → flagged `MISMATCH`, never auto-corrected**; a person investigates. Expiry is learned only from the provider, not from our clock.

## Link creation and refunds
- Creating a link uses the request id as the **idempotency key**, so an uncertain outcome (timeout) can be retried safely and cannot produce a second link. Not-sent failures leave a draft.
- A refund request does not change local state; the provider's verified event does.
- The text containing the link is a **draft in the composer**; a person reviews and sends it (normal consent/pipeline rules apply).
- Write access to the provider is a separate admin-controlled permission, and creating/refunding is manager-only.

## What is still unverified
No real provider is connected. The sandbox provider exercises these exact code paths; real providers will each need their own adapter, verified against current official docs, then sandbox-tested with test-mode credentials before any live use. Stripe's webhook signature scheme is implemented and tested; its API client is not.
