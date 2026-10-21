# Evidence

Each section names the command that reproduces it and the file it writes.

## 1. Pay rules

`shared/rules/cases.json` holds 40 cases worked out by hand from the agreement terms, each with the expected capture, release, cooperative share and member payouts in cents. They cover:
- on-time visits and extra time, approved or not;
- late cancellations at several notice times, and cancellations with notice;
- lock-outs, and a member absent with and without cover;
- two and three members on one visit, odd rates and rounding;
- a failed hold.

`npm test` runs the engine (`shared/rules/settle.ts`) against all 40: **40 / 40**.

Property tests (`tests/rules.test.ts`, fast-check) on random terms and outcomes:

| Property | Random cases |
|---|---|
| capture + release = hold; cooperative + members = capture; nothing negative; capture never above the hold | 5,000 |
| the same input always gives the same split | 1,000 |
| a split hands out exactly the amount, each part within a cent of its fair share | 3,000 |

## 2. Cover solver

`npm run eval` and `npx tsx eval/run.ts --heldout`. Labels come from `eval/oracle.ts`, which enumerates every assignment with its own constraint checks. The held-out set was generated and labelled before the solver ran on it, and was run once.

| | Development set (60 scenarios) | Held-out set (20 scenarios) |
|---|---|---|
| Visits placed by the solver, of the oracle's maximum | 55 / 55 | 20 / 20 |
| Scenarios at the oracle maximum | 60 / 60 | 20 / 20 |
| Solver placements breaking a rule | 0 | 0 |
| "First free member" baseline: placements breaking a rule | 68 of 86 | 26 of 29 |
| Same-cleaner households asked first | 2 (oracle minimum 2) | 2 (oracle minimum 2) |
| Proposals on ordinary days | 0 | 0 |
| Mean solve time | 0.1 ms | 0.3 ms |

Rules checked: member availability, skills (pets, deep clean, fragrance-free), travel time between homes, weekly hours cap, and the household's same-cleaner consent. Per-scenario tables: `eval/disruptions/RESULTS.md`, `eval/heldout/RESULTS.md`. CI re-runs the development set and fails if any count changes.

## 3. PayPal sandbox

### 3.1 Money primitives (`probe/probe.ts`, `probe/RESULTS-EUR.md`)

| Step | Result |
|---|---|
| Hold of 30.00 on a vaulted PayPal, buyer absent | CREATED, valid 29 days |
| Same hold again with the same `PayPal-Request-Id` | Same authorization returned |
| Partial capture of 15.00 with `final_capture` (late-cancel fee) | COMPLETED; remainder released |
| Capture retried with the same request id | Same capture returned |
| Second capture on the released remainder | Refused: `AUTHORIZATION_ALREADY_CAPTURED` |
| Void of a hold | VOIDED |
| Capture of 32.50 from a 35.00 hold (visit plus allowance) | COMPLETED |
| Payout of 10.00 to a PayPal email | Batch final (SUCCESS) in 25 s |
| Same payout batch id again | Refused: "Batch with given sender_batch_id already exists" |

### 3.2 The demo day on the sandbox (20 Oct 2026, EUR sandbox app)

The full story was driven through the browser against the live sandbox (`scripts/walk.ts`).

| Visit | Hold | Capture | Released | Payout | PayPal transaction |
|---|---|---|---|---|---|
| The Okafors, covered by Marek | 157.50 | 140.00 (`0MC29840XV352471U`) | 17.50 | 133.00, final in 25.6 s | `11N48929L9385980P` |
| Mr. Lindqvist, late cancellation | 87.50 | 35.00 (`1TK182895N616772W`) | 52.50 | 33.25, final in 24.6 s | `1M9731757E285944T` |
| The Santoses, covered by Teresa | 87.50 | 70.00 (`3YX31050L09458745`) | 17.50 | 66.50, final in 25.2 s | `3FK124853A3503335` |

The sweep placed 30 holds for the visits inside their notice window. The member payouts arrived with their transaction ids, and the income statement shows them.

### 3.3 Crash between capture and payout (`scripts/durability.ts`, `docs/durability-sandbox.json`, 21 Oct 2026)

The settlement task was made to fail once after the capture and before the payout.

| | |
|---|---|
| Task runs | placeHold succeeded; settleVisit failed ("injected crash after capture"), retried, succeeded |
| Captures in the ledger | 1 (`98F41007M7301961K`, 105.00 of a 122.50 hold, 17.50 released) |
| Payout batches | 1 (`9KR5TTRAMHEW8`, SUCCESS, transaction `8YV16471BU867844W`) |
| PayPal, asked for a second capture with a new request id | `422 AUTHORIZATION_ALREADY_CAPTURED` |
| PayPal, asked for a second payout batch | `400 Batch with given sender_batch_id already exists` |

The task reads the visit and does only the steps not yet recorded, so the retry captured nothing and paid once. The same code runs as a Render Workflows task (`server/workflows.ts`) with the same retry policy. Each demo reset draws a new run tag for every PayPal id, so the week can be replayed on the sandbox without colliding with an earlier run.

## 4. The model's limits

### 4.1 Self-attack (`scripts/self-attack.ts`, `docs/self-attack.json`)

Hostile inputs go through the same functions the API calls, with the live Gemini model. Each line records which model answered.

SELF_ATTACK_TABLE

### 4.2 Read-back check

Every translated agreement read-back must keep every number and every amount of the English text. On 21 Oct 2026, Gemini 3.5 Flash-Lite translated the Parks' agreement into Portuguese with the $133.00 hold written as $114.00. The check refused it, and the household saw the English read-back. That answer is kept as a test fixture (`tests/fixtures/readback-pt-changed-hold.json`), and `tests/agent.test.ts` asserts it stays refused.

## 5. The interface

`npm run e2e` builds the app, runs it with no keys, and drives the demo story in Chromium:
- Sam's message, the proposal and approval;
- the household's consent;
- check-in and check-out in Polish;
- the late cancellation;
- the statement, the landlord link and the dispute evidence;
- sign-up from the recorded answer and by hand.

axe-core (WCAG 2.0 A/AA, 2.1 AA) runs on each screen; the report is `docs/axe-report.json`.

| Screen | Violations |
|---|---|
| Home, board, board with proposal, household phone, member phone, statement, landlord link, dispute evidence, sign-up, about | 0 |
