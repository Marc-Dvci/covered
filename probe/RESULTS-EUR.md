# Sandbox probe pmvh66vcy

Run 2026-10-20T21:03:47.628Z, currency EUR.

| Step | Result | Time | Detail |
|---|---|---|---|
| hold 30.00 (buyer absent, vaulted PayPal) | PASS | 2569 ms | auth 43K10178L6412070M CREATED expires 2026-11-18T21:03:07Z |
| same hold again with the same request id (idempotent) | PASS | 1057 ms | auth 43K10178L6412070M (same: true) |
| partial capture 15.00, final (late-cancel fee) | PASS | 1870 ms | capture 53679535LD998001T COMPLETED gross 1500 fee 76 net 1424 |
| capture retried with the same request id | PASS | 1077 ms | capture 53679535LD998001T (same: true) |
| second capture on the released remainder | PASS (refused) | 588 ms | 422 AUTHORIZATION_ALREADY_CAPTURED f874537122211 |
| hold 20.00 | PASS | 2270 ms | auth 5LT567301A856380X |
| void the hold | PASS | 1290 ms | VOIDED |
| hold 35.00 (30.00 + allowance) | PASS | 1901 ms | auth 3E664361WJ174104T |
| capture 32.50, final | PASS | 1863 ms | capture 94H43355LF8734911 gross 3250 fee 136 |
| payout 10.00 to a PayPal email | PASS | 1057 ms | batch WXBKWAHTXMD6J PENDING |
| payout batch reaches a final state | PASS | 25226 ms | SUCCESS |
| same payout batch id again | PASS (refused) | 782 ms | 400 Batch with given sender_batch_id already exists f183516eba9bc |
| transaction search, last 3 days | FAIL | 282 ms | 403 NOT_AUTHORIZED f343991008e11 |
