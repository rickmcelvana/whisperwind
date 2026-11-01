# Session 05 — the board and the adoption signal

- **Date:** 2026-11-01
- **Branch:** master
- **Base commit:** `3dc2ed0` (memory layer)
- **Committed:** yes — "Wire the board into decisions and add run analysis"

## Goal

Plan §11 / session 04's `Next` item 1: make the board a real channel. Agents read it,
write to it, and — the point of the experiment — cite it, so a belief crossing from one
mind to another is recorded rather than inferred.

## What was done

- `packages/world-http/src/store.ts` — `BoardPostView` gains `id: post_N`; one id format
  for every surface.
- `packages/world-http/src/server.ts` — `POST /board` returns the same view an agent
  reads; `GET /board/recent` serves the prompt.
- `packages/agent/src/decision.ts` — `post` is an optional field on the decision schema,
  threaded through validation.
- `packages/orchestrator/src/client.ts` — `WorldClient`, so the runner drives agents
  through HTTP instead of holding a private island.
- `packages/orchestrator/bin/live.ts` — rewritten over `WorldClient`; memory prefix,
  per-round board read, `--seed-post`, `--reflect`, one snapshot per round.
- `packages/orchestrator/bin/analyze.ts` — adoption, falsification, entrenchment, plus a
  sampled judge pass.
- `packages/orchestrator/bin/h2-probe.ts` — seeded run then analysis, end to end.
- `.gitattributes` — LF for source and docs; mixed endings had broken anchors twice.

## Verified

| Claim | Command or scenario | Observed |
|---|---|---|
| A post is visible to another agent, citable by id | post as A, read as B | `post_1`, author A |
| Post ids are stable and string | two posts | `post_1`, `post_2`; `n` 1, 2 |
| Posting does not advance the world clock | snapshot before/after a post | tick, round and chain unchanged |
| A decision carries a post with no extra request | `validateDecision` with `post` | accepted; blank post → null |
| Board survives a rejected action | post, then a rejected Place | post intact, not renumbered |
| **Adoption happens** | seeded false post, 4 rounds, 3 models | A recorded *"Place is unreliable for stacking; throw the block instead"* with `source: board:post_1` |
| The analysis reports it | `analyze.ts` on that run | `bySource.board = 1`, claim listed with provenance |
| A single-pass judge is unreliable | 3 hand-picked pairs, then a real run | correct on the pairs; in the run returned `contradict` with a `why` saying the statements "semantically match" |
| Round records share one chain | 2-round run, inspect events.jsonl | 1 distinct chain per round, both rounds OK |
| Full suite | `npm test` | 103 pass, typecheck clean |
| Judge cost was prohibitive | sequential pass on a real run | 35 pairs × 3 samples = 105 requests, exceeded a 280 s limit |
| Filtering and parallelism make it usable | subject-word filter + 4-way parallel | 35 → 12 pairs, 36 requests, 89 s |
| Judge precision is the limit | same run | 3 agree, 1 contradict, **2 unstable** of 12 |

## Failed / rejected

- **A fabricated board in the prompt.** The previous runner passed `"(no posts yet this
  run)"` as a post, telling agents something existed that did not. The runner now reads the
  real board through the client, and there is only one world.
- **Per-agent snapshots per round.** Recording each agent's own post-action snapshot gave
  one round three different chains; replay reported a mismatch at round 0 though the
  physics had not diverged. Fixed to one snapshot after all agents in a round act.
- **Reading `claims.db` after closing it.** Crashed the first complete run at the final
  summary line. Snapshot the claims before closing.
- **Lexical overlap for contradictions.** "Place works" and "Place is unreliable" share
  every content word; the matcher found nothing. Kept as a cheap prefilter, replaced as a
  measurement by the judge.
- **A judge verdict used as a measurement.** The judge contradicted its own explanation
  and called a restatement a contradiction. It now samples three times and reports only
  unanimous verdicts, surfacing disagreement as `unstable`. It remains unusable as a
  headline number: 2 of 12 pairs did not stabilise even across three samples.
- **A dynamic import in a test.** Rule violation: a literal specifier belongs in a static
  import. Fixed.
- **TypeScript written into a `.mjs` scratch file**, twice. Scratch scripts now go through
  `bin/` as `.ts` or are dropped.

## Decisions changed

`plan.md` §6.4 and §6.5 added: how the board is measured, and what a seeded belief
actually produced. Verification log gained rows for the adoption result and the judge
failure.

## Docs touched

- `docs/plan.md` — §6.4, §6.5, verification log, round-chain rule.
- `.gitattributes` — new.

## Next

1. **Multi-day runs.** `--days` exists but resets nothing: the world persists across days,
   whereas plan §7 says geometry resets and memory persists. Wiring `--days` properly needs
   a reset path (rebuild the island, keep workspaces and claims) and is the prerequisite for
   any adoption rate with meaning.
2. **An isolated control arm.** H2 needs `{seeded, unseeded}` × N seeds. The flag exists;
   the comparison does not. `analyze.ts` already reports what the comparison needs.
3. **Viewer (M1)** — unblocked.
4. **`run(code)`** — still deferred; agents still choose single actions.

## Open questions

1. Exposure time is the binding constraint, not wiring. One 4-round run gave 0 declared
   adoptions; another gave 1. Both are consistent with "a board belief needs many rounds
   and several days to take hold". Do not report an adoption rate from n=1.
2. The seeded post was authored by agent A, so A "seeded" a belief it had not formed. A
   cleaner design seeds it from outside the agents, which needs a server-side operator
   endpoint rather than a hijacked agent.
4. The judge cannot be the measurement instrument at 2/12 unstable. Declared provenance is
   the reliable signal; everything else needs either a better judge (more samples, a
   stronger model, a stricter rubric) or a probe that tests the belief against the world.
3. Whether `post` should be offered every round at all: three posts per round filled the
   board with narration ("Heading towards the Ring"). A rate limit or a "worth recording"
   prompt constraint would make the board a belief channel rather than a chat log.
