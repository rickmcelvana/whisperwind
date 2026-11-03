/**
 * M0 acceptance CLI.
 *
 *   node packages/sim/bin/m0.ts            # record a run
 *   node packages/sim/bin/m0.ts replay     # replay and verify the chain
 *
 * Records `events.jsonl`, a Rapier snapshot and `digest.json` under `runs/m0/`, then
 * replays from the recording and asserts the per-round chain. This is the M0 criterion
 * from plan §11: the replay must reproduce the chain and stop at the first mismatch.
 *
 * Uses a scripted action list, not a model: this proves the sim and the recording, not
 * the agent layer.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildIsland,
  initPhysics,
  runRound,
  startChain,
  stateDigest,
} from "@whisperwind/sim";
import type { ActionSequence } from "@whisperwind/core";

const RUN_DIR = "runs/m0";
const AGENTS = ["A", "B", "C"] as const;
const ROUNDS = 20;

const worldUrl = new URL("../../../worlds/island/world.json", import.meta.url);
const config = JSON.parse(readFileSync(fileURLToPath(worldUrl), "utf8"));

interface EventLine {
  readonly day: number;
  readonly round: number;
  readonly agent: string;
  readonly action: ActionSequence;
  readonly state: string;
  readonly chain: string;
}

/** A scripted agent: deterministic, distinct per agent, exercises every verb. */
function script(agent: string, round: number): ActionSequence {
  const k = agent.charCodeAt(0) - 65;
  switch ((round + k) % 6) {
    case 0:
      return [{ type: "MoveTo", position: [((round * 3) % 40) - 20, 5, ((round * 5) % 30) - 15] }];
    case 1:
      return [{ type: "Jump" }];
    case 2:
      return [{ type: "MoveTo", position: [0, 5, 6] }, { type: "Pickup", position: [0, 1.5, 6] }];
    case 3:
      return [{ type: "MoveTo", position: [4, 5, 10] }, { type: "Place", position: [4, 2, 10] }];
    case 4:
      return [{ type: "Throw", direction: [1, 1, 0], speed: 6 }];
    default:
      return [{ type: "Stop" }];
  }
}

interface RecordedRun {
  readonly events: EventLine[];
  readonly chain: string;
  readonly state: string;
}

async function record(): Promise<RecordedRun> {
  await initPhysics();
  const island = buildIsland(config, AGENTS);
  let chain = startChain();
  const events: EventLine[] = [];

  for (let round = 0; round < ROUNDS; round++) {
    const submissions = AGENTS.map((agent) => ({ agent, actions: script(agent, round) }));
    const out = runRound(island, { day: 1, round, chain, submissions });
    chain = out.chain;
    for (const record of out.records) {
      events.push({
        day: record.day,
        round: record.round,
        agent: record.agent,
        action: record.action,
        state: record.state,
        chain: record.chain,
      });
    }
  }

  const state = stateDigest(island);

  mkdirSync(RUN_DIR, { recursive: true });
  writeFileSync(join(RUN_DIR, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  writeFileSync(join(RUN_DIR, "day-1.snap"), island.world.takeSnapshot());
  writeFileSync(
    join(RUN_DIR, "digest.json"),
    JSON.stringify({ day: 1, rounds: ROUNDS, agents: AGENTS, terminalState: state, chain }, null, 2) + "\n",
  );
  // A manifest makes this run readable by the shared replayer. Two writers of one run
  // format is the bug this prevents: the same directory must be replayable by the
  // orchestrator, not only by this script.
  writeFileSync(
    join(RUN_DIR, "manifest.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        runId: "m0-scripted",
        createdAt: new Date().toISOString(),
        world: { name: config.name, seed: config.seed },
        motion: { tickRate: config.motion.tickRate, walkSpeed: config.motion.walkSpeed },
        agents: AGENTS.map((name) => ({
          name,
          provider: "scripted",
          model: "none",
          think: false,
          capabilities: null,
        })),
        rounds: ROUNDS,
        node: process.version,
      },
      null,
      2,
    ) + "\n",
  );

  return { events, chain, state };
}

/**
 * Replay from the recording. Rebuilds the world from config and re-applies the
 * recorded actions, then asserts each round's chain prefix against the recording.
 */
async function replay(): Promise<{ ok: boolean; message: string; mismatchedRound: number | null }> {
  await initPhysics();

  const raw = readFileSync(join(RUN_DIR, "events.jsonl"), "utf8");
  const events: EventLine[] = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as EventLine);
  const expected = JSON.parse(readFileSync(join(RUN_DIR, "digest.json"), "utf8")) as {
    chain: string;
    terminalState: string;
  };

  const island = buildIsland(config, AGENTS);
  let chain = startChain();
  let mismatchedRound: number | null = null;

  for (let round = 0; round < ROUNDS; round++) {
    // Group the recorded actions for this round back into submissions.
    const forRound = events.filter((e) => e.round === round);
    if (forRound.length !== AGENTS.length) {
      return { ok: false, message: `round ${round}: expected ${AGENTS.length} records, found ${forRound.length}`, mismatchedRound: round };
    }
    const submissions = AGENTS.map((agent) => {
      const rec = forRound.find((e) => e.agent === agent);
      if (!rec) throw new Error(`round ${round}: missing ${agent}`);
      return { agent, actions: rec.action };
    });

    const out = runRound(island, { day: 1, round, chain, submissions });
    chain = out.chain;

    const recorded = forRound[0]?.chain;
    if (chain !== recorded) {
      mismatchedRound = round;
      return {
        ok: false,
        message: `round ${round}: chain ${chain.slice(0, 16)} != recorded ${String(recorded).slice(0, 16)}`,
        mismatchedRound,
      };
    }
  }

  const finalState = stateDigest(island);
  if (chain !== expected.chain) {
    return { ok: false, message: `terminal chain mismatch`, mismatchedRound };
  }
  if (finalState !== expected.terminalState) {
    return { ok: false, message: `terminal state mismatch`, mismatchedRound };
  }

  return { ok: true, message: `chain and terminal state match across ${ROUNDS} rounds`, mismatchedRound: null };
}

const mode = process.argv[2] ?? "record";
if (mode === "record") {
  const run = await record();
  console.log(JSON.stringify({ mode, rounds: ROUNDS, events: run.events.length, chain: run.chain.slice(0, 16), state: run.state.slice(0, 16) }));
} else if (mode === "replay") {
  const result = await replay();
  console.log(JSON.stringify({ mode, ...result }));
  if (!result.ok) process.exit(1);
} else {
  console.error(`unknown mode ${mode}; use "record" or "replay"`);
  process.exit(2);
}
