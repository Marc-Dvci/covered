# Covered: system card

A model takes part in decisions about people's work and pay here, so this card says where it does and where it stops.

## Who it is for, and what it is for

A house-cleaning cooperative: a coordinator who plans the week, members who clean, and the households they clean for.
The model helps in four places:

- it reads a member's message and says whether they are out;
- it chooses among the plans the solver lists, and explains the choice to the coordinator;
- it writes each message in the recipient's language;
- it drafts an agreement from the household's words and the member's terms, and translates the read-back.

## Uses it is not built for

- Deciding an amount, a fee, who is paid, or whether a person can work a visit. Code decides those.
- Moving money. The agent has no tool that touches PayPal.
- Changing a member's rate. A rate changes only through a re-signed agreement.
- Legal advice. The agreement is a template built on the list of fields in Seattle Council Bill 121266.

## Models and data

| Component | Model or source | Role |
|---|---|---|
| Message intake, read-backs, member messages | Gemini 3.5 Flash-Lite | Reads and writes words |
| Cover agent, agreement drafts, voice notes | Gemini 3.6 Flash, then fallbacks when busy | Chooses among valid plans through function calling, drafts |
| Cover solver, pay rules, agreement checklist | Deterministic code | Lists valid plans, computes every amount, decides whether an agreement can be signed |
| Demo data | Fictional cooperative in `shared/seed.ts` | 10 members, 36 households, one week of visits |

The demo path's answers are recorded in `data/ai-recordings.json`, so the demo answers the same way each time and runs
with no key. Live calls go through a reply cache, a daily cap and a per-visitor cap. A busy model falls back to the next
one, and then to text built by code.

## Evaluation

| What | Result | How to reproduce |
|---|---|---|
| Solver on the development set (60 scenarios) | 55 of 55 placeable visits placed, 0 rules broken | `npm run eval` |
| Solver on the held-out set (20 scenarios, labelled before the solver ran) | 20 of 20 placed, 0 rules broken | `npx tsx eval/run.ts --heldout` |
| "First free member" baseline on the same sets | 68 of 86 and 26 of 29 placements break a rule | same commands |
| Pay rules worked out by hand before the engine | 40 of 40 | `npm test` |
| Self-attack: prompt injection, a rate change by message, a forged webhook, a crash | 13 of 13 handled | `npx tsx scripts/self-attack.ts` |

The full figures are in [EVIDENCE.md](EVIDENCE.md).

## Checks on the model's words

- The agent can submit only a plan the solver returned.
- A message with a number the tools did not give is replaced by a template.
- A translated read-back that changes, drops or adds a number is not shown.
- The rate, notice and fee must appear in the member's own words.
- The household's text and the member's note are passed as data, never as instructions.

## Human oversight

- The coordinator sees the plan on the board as dashed bars, with the agent's reasons and every outgoing message, and
  approves or dismisses it. Nothing moves before that.
- A household that asked for the same cleaner is asked before anyone else comes.
- The household sees the fee before it confirms a late cancellation.
- Every model call is listed by task on the `/about` page of the deployment.

## How a correction is made

- A plan: the coordinator dismisses it, or drags a bar to another member, and the drag guard checks that move.
- A charge: the visit's evidence page lists the agreed terms, the check-in and check-out times, and every PayPal id, all
  from the ledger, for the answer to a dispute.
- A wrong answer on the demo path: re-record it with `COVERED_RECORD=1`, which changes one line in a committed file.
