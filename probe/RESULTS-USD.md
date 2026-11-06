# Sandbox probe pmw4tl6jh

Run 2026-11-06T10:17:32.526Z, currency USD.

| Step | Result | Time | Detail |
|---|---|---|---|
| hold 30.00 (buyer absent, vaulted PayPal) | PASS | 2769 ms | auth 04U67118TG908363E CREATED expires 2026-12-05T10:16:48Z |
| same hold again with the same request id (idempotent) | PASS | 2288 ms | auth 04U67118TG908363E (same: true) |
| partial capture 15.00, final (late-cancel fee) | PASS | 2274 ms | capture 7HF69883710200053 COMPLETED gross 1500 fee 101 net 1399 |
| capture retried with the same request id | PASS | 853 ms | capture 7HF69883710200053 (same: true) |
| second capture on the released remainder | PASS (refused) | 985 ms | 422 AUTHORIZATION_ALREADY_CAPTURED f269760adb2e4 |
| hold 20.00 | PASS | 2064 ms | auth 51N75347AN234404H |
| void the hold | PASS | 1888 ms | VOIDED |
| hold 35.00 (30.00 + allowance) | PASS | 2467 ms | auth 1P674408EC173471L |
| capture 32.50, final | PASS | 1873 ms | capture 0JC004455C691315J gross 3250 fee 162 |
| payout 10.00 to a PayPal email | PASS | 1267 ms | batch L86Y5N9SHPP6G PENDING |
| payout batch reaches a final state | PASS | 25770 ms | SUCCESS |
| same payout batch id again | PASS (refused) | 961 ms | 400 Batch with given sender_batch_id already exists f510396ce2d10 |
| transaction search, last 3 days | PASS | 382 ms | 0 records; newest none; this run's invoices seen: 0 |
