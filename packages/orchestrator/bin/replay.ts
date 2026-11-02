/**
 * Replay a recorded run and verify its chain.
 *
 *   node packages/orchestrator/bin/replay.ts runs/<id>
 *
 * Rebuilds the world from world.json, re-applies the recorded actions round by round,
 * and asserts the chain after each round. Exits non-zero at the first mismatch. Works
 * for both scripted (sim/bin/m0.ts) and live runs, because both write the same
 * events.jsonl shape.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildIsland,
  initPhysics,
  runRound,
  startChain,
  stateDigest,
} from "@whisperwind/sim";
import type { ActionSequence } from "@whisperwind/core";

const runDir = process.argv[2];
if (!runDir) {
  console.error("usage: node packages/orchestrator/bin/replay.ts <run-dir>");
  process.exit(2);
}

const worldPath = new URL("../../../worlds/island/world.json", import.meta.url);
const config = JSON.parse(readFileSync(worldPath, "utf8"));

interface EventLine {
  readonly day: number;
  readonly round: number;
  readonly agent: string;
  readonly action: ActionSequence;
  readonly state: string;
  readonly chain: string;
}

const raw = readFileSync(join(runDir, "events.jsonl"), "utf8");
const events: EventLine[] = raw
  .split("\n")
  .filter(Boolean)
  .map((line, i) => {
    try {
      return JSON.parse(line) as EventLine;
    } catch {
      throw new Error(`${runDir}/events.jsonl line ${i + 1} is not valid JSON`);
    }
  });

if (events.length === 0) throw new Error(`${runDir}/events.jsonl is empty`);

const digest = JSON.parse(readFileSync(join(runDir, "digest.json"), "utf8")) as {
  chain: string;
  terminalState: string;
};
const manifest = JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8")) as {
  agents?: { name: string }[];
};

const agentNames = manifest.agents?.map((a) => a.name) ?? [...new Set(events.map((e) => e.agent))].sort();

/**
 * Days are replayed independently. A day begins from a freshly built world (the same
 * reset the server performs), so replaying day 2's round 0 against day 1's world would
 * compare two different states that happen to share a round number.
 */
const days = [...new Set(events.map((e) => e.day))].sort((a, b) => a - b);

await initPhysics();
let island = buildIsland(config, agentNames);
let chain = startChain();
let mismatched: { day: number; round: number } | null = null;
let currentDay = days[0] ?? 1;

for (const day of days) {
  if (day !== currentDay) {
    // The server resets between days; the replay does the same thing, from the same
    // config, which is deterministic.
    island = buildIsland(config, agentNames);
    chain = startChain();
    currentDay = day;
  }

  const roundsThisDay = [...new Set(events.filter((e) => e.day === day).map((e) => e.round))].sort(
    (a, b) => a - b,
  );

  for (const round of roundsThisDay) {
    const forRound = events.filter((e) => e.day === day && e.round === round);
    const submissions = agentNames.map((agent) => {
      const rec = forRound.find((e) => e.agent === agent);
      // An agent absent from a round is valid only if it never joined; substituting Stop
      // would hide a broken recording.
      if (!rec) throw new Error(`day ${day} round ${round}: no record for agent ${agent}`);
      return { agent, actions: rec.action };
    });

    const out = runRound(island, { day, round, chain, submissions });
    chain = out.chain;
    const recorded = forRound[0]?.chain;
    if (chain !== recorded) {
      mismatched = { day, round };
      console.log(
        JSON.stringify({
          ok: false,
          message: `day ${day} round ${round}: chain ${chain.slice(0, 16)} != recorded ${String(recorded).slice(0, 16)}`,
          mismatchedDay: day,
          mismatchedRound: round,
        }),
      );
      process.exit(1);
    }
  }
}

const state = stateDigest(island);
if (chain !== digest.chain) {
  console.log(
    JSON.stringify({
      ok: false,
      message: "terminal chain mismatch: digest.json records the chain of the final day",
    }),
  );
  process.exit(1);
}
if (state !== digest.terminalState) {
  console.log(JSON.stringify({ ok: false, message: "terminal state mismatch" }));
  process.exit(1);
}

console.log(
  JSON.stringify({
    ok: true,
    runDir,
    days: days.length,
    agents: agentNames,
    chain: chain.slice(0, 16),
    state: state.slice(0, 16),
  }),
);
