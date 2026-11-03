# Session 01 — research and plan

- **Date:** 2026-10-31
- **Branch:** master
- **Base commit:** none — first commit
- **Committed:** yes — "Add project plan, session protocol, and standing rules"
  (single initial commit). Docs only; no code yet.

## Goal

Turn `docs/ideas.md` into a buildable design for an "AI childhood / stranded on an
island" experiment, from scratch on this machine's hardware, with no dependency on
an existing engine. Establish the architecture and retire the unknowns that would
otherwise be discovered mid-build.

## What was done

- Read the source paper (arXiv 2610.07130, full text including appendices) and the
  MIT Technology Review coverage; inspected the released dataset layout on Hugging
  Face and the reference implementation.
- Decided against adopting the reference engine — from scratch, per the owner.
- Chose the simulation core: TypeScript on Node 24 with Rapier 3D (WASM), headless.
- Probed every model endpoint available here and measured the properties the agent
  loop depends on: tool calls, schema enforcement, thinking toggle, streaming shape,
  latency, prompt caching, embeddings.
- Sampled the released recordings to calibrate the decision budget against what the
  paper's agents actually did.
- Wrote `docs/plan.md` (architecture, world, agent runtime, day loop, recording,
  experiments, milestones, risks) with a verification log.
- Wrote the standing rules and this session protocol.

## Verified

All measurements on 2026-10-31. Throwaway scripts, not committed.

| Claim | Command or scenario | Observed |
|---|---|---|
| Rapier is deterministic | SHA-256 over all body transforms after 600 ticks, 3 processes | identical digest each run |
| Snapshot/restore is exact | snapshot at tick 300, continue; restore and continue | MATCH |
| M0 acceptance achievable | 30 rounds × 90 actions → record, replay from scratch, replay from snapshot | all digests equal, PASS |
| Terminal digest alone is insufficient | tamper one mid-day action, compare end state | end state identical, only a per-round chain caught it |
| Local model emits valid tool calls | native `/api/chat` with a tool | valid on qwen3.5, gemma4, glm-5.2:cloud |
| `think` only works natively | `think:false` on `/v1` vs `/api/chat` | 937 tokens/13.9 s vs 2 tokens/0.31 s |
| Schema is not enforced by `tools` | gemma4, 8 samples | 100% invalid; `format` fixed it to 0% |
| `format` alone is not portable | glm-5.2 with `format` only | ignored, returned prose in a fence |
| Embeddings cannot detect contradiction | 6 labelled pairs, `embeddinggemma-2` | agree 0.889 vs contradict 0.872 |
| Real Eko action rate | `inputs` table, agent 9 hours 01/05/20/30 | 240/446/491/368 actions per hour |
| Agents batch actions | hour 10 gap statistics | 7 clusters, median gap 7.5 s |
| Three providers in one M0 run | Rapier world + glm/qwen/gemma, 5 rounds | all valid, ~1.8 s/round |
| That run's replay | from scratch twice, plus mid-run snapshot | chain and terminal matched, PASS |

## Failed / rejected

- **Clawblox as a base.** Rejected by the owner. Also carried `max_players = 1`, a
  tmux-only agent runner, and a closed three-agent-set backend list.
- **Terminal-digest-only replay verification.** Failed a tampering control: a mid-day
  action change produced a byte-identical end state. Replaced by a per-round chain.
- **`tools`-only decisions.** 100% invalid output on one model with no error raised.
- **`format`-only decisions.** Silently produced prose on another model; in the first
  M0 loop that agent did nothing for five rounds.
- **`think` on the `/v1` endpoint.** Accepted and ignored.
- **Embedding cosine similarity for belief adoption.** Signal (0.017) is below the
  within-group variance; rejected in favour of declared provenance.
- **Estimating action counts from transcripts.** Undercounted by ~6×; recordings are
  authoritative.
- **A 20-sim-minute day.** Needed ~2,100 rounds and ~4.7 wall-hours; replaced by a
  decision budget.

## Decisions changed

`plan.md` decisions D1–D11 were written this session. Two were revised after
measurement: D3 (from a specific model to a provider-agnostic layer) and D11 (from
embeddings to declared provenance plus an optional judge).

## Docs touched

- `docs/plan.md` — created, then revised five times as measurements or review
  invalidated assumptions: day budget, replay verification, provider layer, adoption
  detection, and the wall-cost table (which had quoted only the slow arm and then
  miscomputed its own range).
- `docs/sessions/README.md`, `docs/sessions/TEMPLATE.md` — created, then corrected
  after a dry run: session-doc lookup, clean-tree wording, and the commit-hash rule.
- `.omp/RULES.md`, `AGENTS.md` — created.

Process defects found by actually running the protocol against this repository, all
fixed before the first commit:

1. `git rev-parse --abbrev-ref HEAD` exits non-zero on a repository with no commits;
   the checklist now uses `git branch --show-current`.
2. `ls docs/sessions/` sorts `README.md` after the numbered docs, so step 2 pointed at
   the wrong file; it now globs `[0-9]*.md`.
3. Requiring a commit hash inside the session doc was unfollowable — a hash cannot be
   written into the commit that creates it. Docs now name work by commit subject.
4. The staleness rule flagged *planned* paths as missing; it now says "presents as
   existing", and `AGENTS.md` marks its tree as planned.
5. The wall-cost table's own arithmetic was wrong: 5.7–11.8 s per round gives
   19–39 min/day and 4.8–9.8 h per study, not the 27 min / 7 h first written.

## Next

1. **Bootstrap the repository.** `package.json` with workspaces, TypeScript config,
   test runner, and the five package skeletons from `plan.md` §3. No behaviour.
2. **`packages/sim` M0 slice**: world construction from `world.json`, the six actions
   with distance-derived durations, the tick loop, observation formatting, snapshot
   and per-round digest chain. Acceptance: a headless script runs two agents against
   a scripted action list and produces `events.jsonl` + `snapshot` + matching replay.
3. **`packages/world-http`**: `/api.md`, `/join`, `/observe`, `/input`, `/snapshot`,
   `/chat`, `/board`. Acceptance: `curl` drives one agent through a full round.
4. **`packages/agent`**: the provider layer from `plan.md` §5.1–5.5, including the
   capability probe, tools+format decoding, validation, and one repair retry.
   Acceptance: the three-provider mixed round reproduces at or below the measured
   2 s wall.
5. **`packages/orchestrator`**: day loop, resets, manifests, `claims.db`.
6. Defer until a milestone needs it: viewer, `run(code)`, multiple worlds.

## Open questions

1. `run(code)` — build it, or prove action sequences suffice first? Currently deferred
   to M1–M2 with a measured trigger for adding it.
2. Context growth over 5-day runs: ~200 × 1.5k tokens of volatile observation will
   need compaction or summarisation before M3. Measure at M2.
3. Third diversity arm: both `qwen3.5:9b` and `gemma4:12b-it-qat` are verified; pick
   after one comparison day rather than by intuition.
