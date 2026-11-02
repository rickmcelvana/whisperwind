# Session 06 — day reset

- **Date:** 2026-11-02
- **Branch:** master
- **Base commit:** `74d0e44` (judge precision)
- **Committed:** yes — "Add day reset and fix round recording"

## Goal

Session 05's `Next` item 1: `--days` with proper resets — geometry resets, memory persists.
This is the prerequisite for any adoption rate with meaning.

## What was done

- `packages/world-http/src/server.ts` — `rebuild` option, `POST /day/next` behind
  `X-Operator-Token`, staged rounds, per-agent verdict reporting.
- `packages/orchestrator/src/client.ts` — `nextDay()`, operator token.
- `packages/orchestrator/bin/live.ts` — day loop wired to reset; records sent actions.
- `packages/orchestrator/bin/replay.ts` — day-aware: rebuilds per day, reports `days`.
- `packages/orchestrator/test/day-reset.test.ts` — 8 tests.
- `packages/agent/test/provider.test.ts` — sampled instead of single-shot.

## Verified

| Claim | Command or scenario | Observed |
|---|---|---|
| A new day resets geometry and the round clock | move, then `nextDay` | round 0, tick 0, day 2, body back at spawn |
| Board and chat survive a reset | post + chat, then reset | both still present |
| Reset requires the operator token | no token, wrong token, session header, right token | 401, 401, 401, 200 |
| Operator endpoints fail closed | server with no token configured | 403, not open access |
| Each day begins from an identical state | snapshot day 1 start vs day 2 start | identical state digest |
| A reset does not free session bodies | reset, then `Jump` | accepted; body still named A |
| Rebuild is deterministic | two builds | identical digest |
| **Multi-day run replays** | `--rounds 2 --days 2`, then `replay.ts` | `ok: true`, 2 days, chain and state match |
| Full suite | `npm test` | 112 pass, typecheck clean |

## Failed / rejected

- **Restoring a snapshot into a fresh world.** Leaves the wrapper's named bodies pointing
  at freed handles. Rebuild from config instead — deterministic, and it re-binds by name.
- **`/day/next` placed after the session gate.** Unreachable: every call returned 401
  because the session check ran first. Moved ahead of it.
- **An operator endpoint with no token.** My comment claimed it was gated before it was.
  Now implemented and failing closed with 403 when unconfigured.
- **A round advancing per `/input`.** Three agents in "round 0" silently produced three
  rounds, so the recorded chain could not be reproduced. Actions are staged; the round
  commits when every joined agent has submitted.
- **Recording the proposed sequence, not the sent action.** A model emitted
  Jump+Pickup+MoveTo, the server applied one action, the event claimed three, and replay
  diverged at that exact round. Events now record what was sent.
- **A rejection reported as success.** A rejected action is staged as a `Stop` to let the
  round commit, which made the response read `ok: true`. The rejection branch now supplies
  the verdict.
- **A single-shot provider assertion.** The model intermittently returns a
  non-conforming action; a one-sample test made the suite flaky. Now three samples with a
  majority requirement — model noise is not a red suite.
- **A test asserting the old replay field** (`rounds` renamed to `days`).

## Decisions changed

`plan.md` §6.6 added: day reset mechanics and the two recording bugs it exposed.

## Docs touched

- `docs/plan.md` — §6.6.

## Next

1. **The H2 comparison.** `--seed-post` and `--days` both exist. What is missing is an
   unseeded control arm and the comparison between them. `analyze.ts` already reports every
   field the comparison needs; a small driver that runs `{seeded, unseeded} × N seeds` and
   tabulates the results is the remaining piece.
2. **Run length.** 2 rounds × 2 days is a plumbing test, not an experiment. A meaningful
   adoption measurement needs ~4–8 days and enough rounds per day for agents to read the
   board between actions.
3. **Viewer (M1)** — unblocked.
4. **`run(code)`** — still deferred; agents continue to choose single actions.

## Open questions

1. **How long a run needs to be is unknown.** Two runs at 4 rounds produced one adoption
   and one none. The number of days needed for a board belief to take hold has not been
   measured, and guessing it would make the H2 result meaningless.
2. **Reset timing relative to reflection.** Reflection currently runs before the reset,
   which is right. Whether an agent should *see* that a reset is coming (the source
   experiment told agents five minutes before) is untested here; without it, agents may
   write memories that assume a world that no longer exists.
3. **Board volume.** Three posts per round filled the board with narration. A rate limit or
   a stronger "only if it would change someone's mind" instruction is needed before a long
   run, or the board becomes a chat log that no one reads.
