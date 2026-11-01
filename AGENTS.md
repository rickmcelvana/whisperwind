# Whisperwind

A from-scratch island sandbox for LLM agents, and the experiment it exists to run.

An agent is placed on a small 3D island with six verbs, no objective, no score, and a
text workspace that persists. Then it is observed. The design follows
*Is this machine playing?* (Clawson et al., arXiv 2610.07130), which showed that a
capable agent left without a task invents its own activities — and that the memory it
writes in the process becomes a real capability substrate, including its false
beliefs.

The question this project adds: **when several agents can read each other's beliefs,
do false beliefs get corrected or entrenched?** The paper named that direction and
did not run it.

## Read first

- [`docs/sessions/README.md`](docs/sessions/README.md) — session protocol. Start here.
- [`docs/plan.md`](docs/plan.md) — design of record: decisions, measurements, risks.
- [`.omp/RULES.md`](.omp/RULES.md) — standing rules: roles, commits, delegation.

## Shape of the system

Planned layout. Nothing below exists yet except `docs/`; the tree is the target the
session docs build toward.

```
packages/
  sim/            deterministic world: (state, action, tick) -> state. No I/O.
  world-http/     HTTP server exposing one sim instance to agents
  agent/          provider-agnostic model client, tool loop, memory, claims
  orchestrator/   day loop, resets, recording, manifests
  viewer/         React + Three.js: live tail and replay scrubbing
worlds/island/    world.json (seed, terrain, spawns) + rules.json (hidden mechanics)
prompts/          soul.md, system.md, begin.md, dusk.md
probes/           executable assertions for each ledger rule
runs/             one directory per run; gitignored
```

Two invariants that the rest of the design leans on:

- **`packages/sim` performs no I/O and no wall-clock reads.** Replay is re-simulation,
  so determinism is a correctness requirement, not a preference.
- **No component knows a model name.** Models are configuration (`worlds/island/
  models.yaml`) with probed capabilities, because the model is an experimental
  variable.

## Environment

| | |
|---|---|
| Node | 24.x (uses built-in `node:sqlite`, no native build step) |
| Sim | `@dimforge/rapier3d-compat` 0.21, pinned |
| Local models | ollama at `http://127.0.0.1:11434` (locals and `:cloud` models), llama.cpp at `http://192.168.40.247:8080` |
| Language | TypeScript throughout; no other runtime |

Both model endpoints are optional. A run records which were reachable.

## Status

Core loop is working end to end. The sim, HTTP surface, agent layer and orchestrator
exist and are tested; a live run of three different models records a chain that
replays. Memory, claims and the viewer are not built.

`docs/sessions/` holds the current state; the newest session doc's `Next` section is
the task queue.
