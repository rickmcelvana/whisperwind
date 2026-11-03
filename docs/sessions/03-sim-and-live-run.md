# Session 03 — sim to live run

- **Date:** 2026-11-01
- **Branch:** master
- **Base commit:** `ce9f85f` (bootstrap)
- **Committed:** yes — "Add deterministic sim core with M0 record and replay" and
  "Add agent, HTTP and orchestrator layers; live three-model run"

## Goal

Plan §11 steps 2–5: the sim, then HTTP, agent layer, and orchestrator, ending with a
real run whose recording replays.

## What was done

- `packages/sim` — `world.ts` (island from `world.json`), `motion/duration.ts`
  (distance-derived durations), `actions/apply.ts` (six verbs, typed rejections),
  `state/digest.ts` (sorted-handle digest + chain), `observe.ts`, `tick.ts` (round
  barrier), `bin/m0.ts` (record → replay acceptance).
- `packages/world-http` — `server.ts` (eight endpoints on `node:http`), `store.ts`
  (append-only chat/board with stable sequence numbers).
- `packages/agent` — `provider.ts` (interface, NDJSON and fence parsing), `ollama.ts`
  (native `/api/chat`), `openai.ts`, `decision.ts` (schema + validation), `factory.ts`.
- `packages/orchestrator` — `loop.ts` (day loop with a `Decider` interface so tests
  need no network), `manifest.ts`, `bin/live.ts` (probe → run → record),
  `bin/replay.ts` (verify any run directory).
- `.omp/RULES.md` — added the no-race rule after the coordination failure below.

## Verified

| Claim | Command or scenario | Observed |
|---|---|---|
| Sim is deterministic | two identical 12-round, 2-agent runs | identical chain and every per-round state |
| Physics actually moves | digest before/after 30 steps | differs |
| **M0 acceptance** | `node packages/sim/bin/m0.ts` then `... replay` | 20 rounds, 3 agents, `ok: true` |
| Chain catches mid-run tampering | change one round-7 action, replay | fails at round 7, exit 1; passes again when restored |
| **Terminal digest cannot** | same tamper, compare end states | both `10266893ce1ac5d6`; only the chain differed |
| Durations are physical | MoveTo 20 units from a known position | 187 ticks, equal to `ceil(dist/4.5*60)`, and a 1-unit step costs less |
| Round barrier | one agent walks far, other stops | both records share one state, so the world advanced once |
| Actions reject rather than no-op | Place with empty hands | `not_holding`, 1 tick |
| Agent layer against real models | 6 live tests on `qwen3.5:9b` | valid decisions, probe reports schema+thinking, thinking-off uses fewer tokens |
| HTTP surface | 11 tests against a real server on port 0 | join/observe/input/chat/board/snapshot all behave; 401 and 409 enforced |
| Invalid input handling | malformed JSON, unknown action | 400 and a typed rejection respectively, never a 500 |
| **Live three-model run** | `node packages/orchestrator/bin/live.ts --rounds 3` | glm-5.2:cloud + qwen3.5:9b + gemma4:12b, 0 invalid decisions, 18.3 s wall |
| That live run replays | `node packages/orchestrator/bin/replay.ts runs/live-…` | `ok: true`, chain and state match |
| Both run writers share one format | record with `sim/bin/m0.ts`, replay with the orchestrator's replayer | `ok: true`, 20 rounds |

## Failed / rejected

- **Parallel delegation on `packages/world-http`.** I spawned a sub-agent for it, then
  began writing the same files myself. Both wrote `src/server.ts`; its version
  overwrote a passing implementation and broke the module's exports. Restored mine and
  added the rule to `.omp/RULES.md`. The lesson is process, not code: an architect who
  delegates a directory must not edit it.
- **Sub-agent's `Store.getChat`** renumbered entries as `after + i + 1`, which silently
  loses messages when a cursor skips any. Kept the class, fixed the numbering to use the
  entry's own id, and kept the tests that cover the cursor.
- **Constant action durations.** The first draft used tick counts; a 1-unit step and a
  60-unit walk cost the same. Replaced with distance/speed.
- **My own test arithmetic.** Asserted ~267 ticks for "20 units", but the agent spawns
  at x=6, so the walk is 14 units. The test now computes the expected value from the
  actual position.
- **Rejected inputs freezing the clock.** A malformed `/input` still runs a Stop round,
  so an agent cannot stall the world by sending garbage.
- **Two writers of one run format.** `sim/bin/m0.ts` wrote `events.jsonl`,
  `digest.json` and a snapshot but no `manifest.json`, so the shared replayer threw
  ENOENT on a perfectly valid run. A test now records with the scripted writer and
  replays with the orchestrator's replayer.
- **An unused `worldName` server option**, removed. It was never read.
- **A false alarm from my own probe script:** a duplicate object key printed the second
  join's `agentId` under the first join's label, which looked like nondeterministic
  assignment. Eight repeats and a permanent test confirm join assigns bodies in island
  order.

## Decisions changed

- `plan.md` §2.1 toolchain: unchanged, now exercised.
- No §1 decision changed. The per-round chain is now verified against a live run, not
  only a synthetic one.

## Docs touched

- `.omp/RULES.md` — no-race rule.
- `docs/plan.md` — no changes needed this session; every claim held.
- `AGENTS.md` — status line.

## Next

1. **`run(code)` or sequences?** A live run shows models choosing single actions; none
   tried to batch. Before adding a sandbox, check whether sequences in the prompt
   encourage pattern-laying. This is the open question §14 item 5.
2. **Memory layer** — `EPISODIC.jsonl`, `SEMANTIC.md`, `claims.db`, and the
   `memory.claim` tool with declared provenance. Needed for M2.
3. **Board-mediated belief exchange** — seeded false post, adoption tracking,
   falsification latency. This is the actual experiment (H2).
4. **Viewer** (M1) — can proceed in parallel with memory work since it consumes the
   spectator payload, not the agent API.
5. **Day loop in the live runner** — `bin/live.ts` currently runs one day; the day loop
   exists in `loop.ts` but is not wired to real deciders.

## Open questions

1. `gemma4:12b-it-qat` took 4.8–7.0 s per decision versus 0.9–1.5 s for the cloud model.
   It is usable but slow; whether it earns a slot is an experiment question.
2. Probe latency was 6–10 s per model because the probe issues three requests. It runs
   once per run, so it is acceptable, but a `--skip-probe` flag would speed iteration.
