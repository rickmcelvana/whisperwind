# Session 02 — bootstrap

- **Date:** 2026-11-01
- **Branch:** master
- **Base commit:** `e95a735` (initial docs commit)
- **Committed:** yes — "Bootstrap workspace with shared contracts and world config"

## Goal

Plan §11 step 1: a working repository skeleton with the shared contracts fixed, so
sub-agents can implement packages 2–5 in parallel without drifting. No world behaviour.

## What was done

- Chose the toolchain by measurement, not preference: Node 24 type stripping, npm
  workspaces, no build step. Recorded in `plan.md` §2.1.
- `package.json` (workspaces, test = typecheck + node test), `tsconfig.json` (strict,
  `erasableSyntaxOnly`, `noUncheckedIndexedAccess`), `.gitignore`.
- `packages/core/src/contracts.ts` — the fixed interface: action union, `ActionSequence`,
  `MotionProfile`, `Observation`, `ActionResult`/`RejectReason`, `RoundRecord`,
  `Capabilities`, `ChatRequest`/`ChatResponse`, `Claim`.
- `packages/core/src/yaml.ts` — dependency-free YAML subset parser for `models.yaml`.
- `worlds/island/world.json` — island geometry, 12 cubes, rock, ring, spawn radius.
- `worlds/island/rules.json` — rule ledger R1–R5 with provenance and probe paths.
- `worlds/island/models.yaml` — three providers/models, no model name in code.
- Six package skeletons with entry points and `package.json` each.
- Tests: contracts (5), YAML parser (5), world config + ledger (7).

## Verified

| Claim | Command or scenario | Observed |
|---|---|---|
| No build step needed | `node packages/app/main.ts` importing a workspace `.ts` package | runs |
| Rapier WASM loads this way | new `World`, `step()` | `rapier-ok` |
| Clean install works | `rm -rf node_modules && npm ci` | 10 packages, then tests pass |
| Typecheck catches real errors | inject `const x: number = "bad"` | exit 2; clean tree exit 0 |
| Typecheck bans non-erasable syntax | inject `export enum E { A }` | `TS1294: This syntax is not allowed when 'erasableSyntaxOnly' is enabled` |
| Test runner works | `npm test` | 17 pass |
| Tests catch world bugs | spawn-overlap check | found Mesa_6 covering two spawn points; moved to (-18, 0) and re-ran clean |
| YAML parser handles the real config | parse `models.yaml` | 2 providers, 3 agents, correct model ids and `think: false`; URL `#` fragment not treated as a comment |
| YAML parser rejects silently-wrong input | flow mapping, block scalar, anchor, bare line | all throw `YamlError` with a line number |

## Failed / rejected

- **`node --test <directory>`** — fails on Windows with `MODULE_NOT_FOUND`. Only the
  glob form works; the npm script uses a glob.
- **`enum` and parameter properties** — both pass a careless read and fail at runtime.
  `tsconfig` now forbids them, and `npm test` runs `tsc` first so they fail before
  running.
- **Hand-rolled YAML with an inline cast** to mutate a `readonly` field — replaced with
  a private mutable array; the cast was suppressing a real type error.
- **Dropping YAML for JSON** — considered, rejected: agent configs want comments, and
  comments carrying probe caveats are the point.
- **A `dist/` build step** — unnecessary given type stripping; would have added a
  second source of truth for module resolution.

## Decisions changed

New: `plan.md` §2.1 Toolchain. No design decisions in §1 changed.

## Docs touched

- `docs/plan.md` — added §2.1.
- `AGENTS.md` — status line updated (code now exists).

## Next

1. **`packages/sim`** (M0 slice):
   - `world.ts` — build the Rapier world from `world.json`: ground, mesas as fixed
     cuboids, cubes, rock, ring, one kinematic capsule per agent.
   - `motion/` — one module per action, durations from `MotionProfile`, `Throw`
     applying `carryFactor` from R1, `impact` for R2.
   - `tick.ts` — advance N ticks, deterministic, no clock.
   - `observe.ts` — `Observation` from state, radius filter, sorted by id.
   - `snapshot.ts` — Rapier snapshot plus a state digest over bodies sorted by handle,
     and the per-round chain.
   - Acceptance: two agents driven by scripted action lists produce `events.jsonl`,
     a snapshot, and a replay that reproduces the chain. This is the M0 criterion
     from `plan.md` §11.
2. **`packages/world-http`** — `/api.md`, `/join`, `/observe`, `/input`, `/snapshot`,
   `/chat`, `/board`. Acceptance: `curl` drives one agent through a full round.
3. **`packages/agent`** — provider layer per `plan.md` §5.1–5.5. Acceptance: the
   three-provider mixed round reproduces at or below the measured ~2 s wall.
4. **`packages/orchestrator`** — day loop, resets, manifests, `claims.db`.

Interfaces for all four are frozen in `packages/core/src/contracts.ts`. Sub-agents
implement against it; changes to it come back to the architect.

## Open questions

1. `rules.json` R4 and R5 are new mechanics with no probe implemented yet. Their probes
   are written when the sim can express them; until then they are ledger entries with
   no verification, which the ledger's own note forbids shipping. Do not claim them as
   implemented.
2. `worlds/island/models.yaml` lists three ollama models. Whether `gemma4:12b-it-qat`
   is a useful arm is an experiment question, not a config question.
