# Session 04 — memory layer

- **Date:** 2026-11-01
- **Branch:** master
- **Base commit:** `0f3f517` (run format unification)
- **Committed:** yes — "Add claim store, episodic memory and reflection"

## Goal

Plan §11 memory layer: `EPISODIC.jsonl`, `SEMANTIC.md`, `claims.db`, and the reflection
pass that fills them. Prerequisite for the H2 experiment (belief exchange).

## What was done

- `packages/agent/src/memory/claims.ts` — `ClaimStore` over `node:sqlite`: add, get,
  retire, adoptions, falsification latency, entrenchment, recursive propagation.
- `packages/agent/src/memory/files.ts` — append-only episodic log with torn-write
  detection, and `SEMANTIC.md` rendered from claims rather than authored.
- `packages/agent/src/memory/tools.ts` — the three memory tools, prompt assembly.
- `packages/agent/src/memory/reflect.ts` — day-end consolidation as schema extraction.
- `packages/core/src/contracts.ts` — `ChatResponse.toolCall`, so a provider reports
  *which* tool was called, not just its arguments.
- `packages/agent/src/ollama.ts`, `openai.ts` — carry the tool name.
- `packages/orchestrator/bin/live.ts` — per-agent workspaces, one shared `claims.db`,
  memory in the prompt prefix, `--reflect` for the day-end pass, `memory.json` output.

## Verified

| Claim | Command or scenario | Observed |
|---|---|---|
| Claim store answers the research questions | 9 tests: add/cite/retire/adopt/propagate/latency/entrench | adoption rows, latency in hours, recursive depth all correct |
| A claim survives a reopen | write, close, reopen the same file | record intact |
| Episodic log refuses to append after a torn write | truncate the last line, then append | `MemoryError` naming the file; a silent append would kill every later read |
| Semantic view hides retired beliefs | render with one refuted claim | absent, while claims.db keeps it |
| An agent sees only its own beliefs | render for A with claims by A and B | B's absent |
| **Reflection works on real models** | `reflect` with qwen3.5, gemma4, glm-5.2 | events and claims on all three, zero rejections, refutation honoured |
| Schema extraction beats the tool loop | same task both ways | tool loop: narration, 0 calls. Schema: valid output |
| Unevidenced claims are downgraded | seeded false belief, empty evidence | stored `hypothesis`, not discarded, stale belief replaced |
| Board-vs-agent provenance resolved by id | `fromAgent:"B"` + `fromClaim:"post_1"` | recorded as `board:post_1` |
| Memory does not break replay | live run, 3 models, 3 rounds, `--reflect` | 3 claims, `replay.ts` → `ok: true` |
| Full suite | `npm test` | 91 pass, typecheck clean |

## Failed / rejected

- **Memory tools for belief recording.** The model narrated ("I will record two verified
  beliefs") and called nothing. Claim extraction is a structured transform, so it became
  one schema-constrained request plus a repair retry.
- **Rejecting unevidenced claims.** Measured consequence: four correct claims discarded,
  the stale false belief survived, nothing replaced it. Downgrading to `hypothesis`
  keeps the belief and records its weakness.
- **Trusting `fromAgent` to mean "another agent's claim".** Models write
  `fromAgent:"B"` beside a board post id. Provenance is now resolved by looking the id up.
- **Refuting without ids in the prompt.** The model wrote a claim complaining that an id
  did not exist. The prompt now lists every active claim with its id in brackets.
- **`ChatResponse.value` carrying tool arguments only.** With three tools available that
  is ambiguous: every call looked like whichever tool the caller assumed. Added
  `toolCall: {name, arguments}`.
- **A per-agent read cursor for chat.** Not built: the server reports a count and the
  agent fetches explicitly. A cursor nobody advances is a lie about what "unread" means.

## Decisions changed

`plan.md` §6 gained three subsections recording what measurement changed: reflection is
schema extraction (6.1), unevidenced claims are downgraded (6.2), provenance is resolved
by id (6.3). The verification log gained six rows.

## Docs touched

- `docs/plan.md` — §6 rewritten, §6.1–6.3 added, verification log extended.

## Next

1. **Board-mediated belief exchange (H2).** The board exists but the live runner posts
   nothing to it; agents can read it and cite it, but no one writes. Next step: wire
   `board` writes into decisions, then seed a false post and measure adoption.
2. **Day loop in the live runner.** `--reflect` runs one day. `loop.ts` already carries
   the chain across days; the live runner needs resets and per-day reflection to produce
   multi-day histories.
3. **Viewer (M1)** — unblocked, consumes the spectator payload rather than the agent API.
4. **`run(code)`** — still deferred; a live run shows single actions only.

## Open questions

1. Reflection costs one request per agent per day (~2–9 s each here). At 200 decisions
   that is negligible; for a 5-day × 3-seed study it is 45 extra requests, also
   negligible. No change needed.
2. Claim quality is uneven: `gemma4` recorded one board-derived claim where `qwen3.5`
   recorded two of its own. Whether that is model capability or prompt sensitivity is an
   experiment question, and H4 (tier divergence) is where it belongs.
