# Live order test log — 2026-08-03

Real customer order, TikTok Shop "Gozaindonesia" (new app, service_id 7667887191834150664).
Tracking every Accurate document created and every relevant TikTok webhook payload
(order status + inventory changes) so this can be reversed/audited later if needed.

Reversal notes:
- Sales Order: reversible via `manualClosed: true` (close, not delete).
- Delivery Order: reversible via `delivery-order/delete.do` (reverses stock decrement exactly).
- Sales Invoice: **NOT auto-reversible** — requires a manual credit note / sales return in Accurate.

Infra for this test:
- Server: http://127.0.0.1:8000
- Tunnel: https://wrongful-lurch-magnolia.ngrok-free.dev
- Live Mode: turned ON by user at 2026-08-03 (confirmed via GET /api/settings/live-mode → {"live":true}). Watching for the first real order webhook.

---

## Pre-test state

(filled in once the order is placed)
