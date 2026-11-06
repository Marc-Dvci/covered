# Sandbox probe pmw4s77fv

Run 2026-11-06T09:38:41.333Z, currency USD.

| Step | Result | Time | Detail |
|---|---|---|---|
| hold 30.00 (buyer absent, vaulted PayPal) | PASS | 3128 ms | auth 4YG918347H133562D CREATED expires 2026-12-05T09:37:57Z |
| same hold again with the same request id (idempotent) | PASS | 2095 ms | auth 4YG918347H133562D (same: true) |
| partial capture 15.00, final (late-cancel fee) | PASS | 2076 ms | capture 76E66969DL484002R COMPLETED gross 1500 fee 101 net 1399 |
| capture retried with the same request id | PASS | 951 ms | capture 76E66969DL484002R (same: true) |
| second capture on the released remainder | PASS (refused) | 981 ms | 422 AUTHORIZATION_ALREADY_CAPTURED f9539811ebc3d |
| hold 20.00 | PASS | 2089 ms | auth 1LK34734X7434370S |
| void the hold | PASS | 1316 ms | VOIDED |
| hold 35.00 (30.00 + allowance) | PASS | 2283 ms | auth 3Y484768DS394143T |
| capture 32.50, final | PASS | 2069 ms | capture 4T565240Y5192802J gross 3250 fee 162 |
| payout 10.00 to a PayPal email | PASS | 1263 ms | batch S43G3828SZCDW PENDING |
| payout batch reaches a final state | PASS | 26426 ms | SUCCESS |
| same payout batch id again | PASS (refused) | 375 ms | 400 Batch with given sender_batch_id already exists f814834b8f78c |
| payout 5.00 to a Venmo phone | FAIL | 839 ms | 400 Recipient wallet not supported in sandbox. f814834605f66 |
| transaction search, last 3 days | PASS | 389 ms | 0 records; newest none; this run's invoices seen: 0 |
