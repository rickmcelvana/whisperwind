import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  buildIsland,
  initPhysics,
  observe,
  runRound,
  startChain,
  stateDigest,
} from "@whisperwind/sim";
import type { ActionSequence, RoundRecord } from "@whisperwind/core";

const worldUrl = new URL("../../../worlds/island/world.json", import.meta.url);
const config = JSON.parse(readFileSync(fileURLToPath(worldUrl), "utf8"));

const AGENTS = ["A", "B"] as const;
const ROUNDS = 12;

/** Two agents with deterministic, distinct action lists. No model involved. */
function scriptFor(round: number, agent: "A" | "B"): ActionSequence {
  if (agent === "A") {
    return round % 3 === 0
      ? [{ type: "MoveTo", position: [round, 5, round] }]
      : [{ type: "Jump" }];
  }
  return [
    { type: "MoveTo", position: [-round, 5, round] },
    { type: "Stop" },
  ];
}

interface RunResult {
  readonly records: RoundRecord[];
  readonly chain: string;
  readonly state: string;
  readonly digests: string[];
}

function runOnce(): RunResult {
  const island = buildIsland(config, AGENTS);
  let chain = startChain();
  const records: RoundRecord[] = [];
  const digests: string[] = [];

  for (let round = 0; round < ROUNDS; round++) {
    const submissions = AGENTS.map((agent) => ({ agent, actions: scriptFor(round, agent) }));
    const out = runRound(island, { day: 1, round, chain, submissions });
    chain = out.chain;
    digests.push(out.state);
    records.push(...out.records);
  }

  return { records, chain, state: stateDigest(island), digests };
}

test("M0: a scripted run records a chain that replays exactly", async () => {
  await initPhysics();

  const first = runOnce();
  const second = runOnce();

  // Same inputs, same outputs. This is the property the whole design rests on.
  assert.equal(first.chain, second.chain, "chain must be reproducible");
  assert.equal(first.state, second.state, "terminal state must be reproducible");
  assert.deepEqual(first.digests, second.digests, "every round's state must match");

  // And the chain must actually depend on the rounds, not be a constant.
  assert.equal(new Set(first.digests).size, ROUNDS, "each round should reach a distinct state");
});

test("M0: physics actually moves bodies", async () => {
  await initPhysics();
  const island = buildIsland(config, ["A"]);
  const before = stateDigest(island);
  for (let i = 0; i < 30; i++) island.world.step();
  const after = stateDigest(island);
  assert.notEqual(before, after, "a digest that never changes verifies nothing");
});

test("the chain detects a tampered mid-run action", async () => {
  await initPhysics();

  const baseline = runOnce();

  // Change exactly one mid-run action in a way a later action overwrites.
  const island = buildIsland(config, AGENTS);
  let chain = startChain();
  const digests: string[] = [];
  for (let round = 0; round < ROUNDS; round++) {
    const submissions = AGENTS.map((agent) => ({
      agent,
      actions:
        round === 4 && agent === "A"
          ? ([{ type: "MoveTo", position: [99, 5, 99] }] as ActionSequence)
          : scriptFor(round, agent),
    }));
    const out = runRound(island, { day: 1, round, chain, submissions });
    chain = out.chain;
    digests.push(out.state);
  }

  assert.notEqual(chain, baseline.chain, "tampering must change the chain");
  // The divergence must be visible at the tampered round, not only at the end.
  const firstDiff = digests.findIndex((d, i) => d !== baseline.digests[i]);
  assert.equal(firstDiff, 4, "divergence should appear exactly at the tampered round");
});

test("observation is stable and bounded", async () => {
  await initPhysics();
  const island = buildIsland(config, AGENTS);
  const opts = {
    tick: 0,
    day: 1,
    boardPosts: 0,
    boardLatestTick: null,
    unreadChat: 0,
    lastResults: new Map<string, string | null>(),
  };
  const a = observe(island, 0, opts);
  const b = observe(island, 0, opts);

  assert.deepEqual(a, b, "observation must be deterministic");
  assert.equal(a.player.name, "A");
  assert.equal(a.others.length, 1);
  assert.equal(a.others[0]?.name, "B");
  assert.ok(a.nearby.length <= 60);
  // Sorted by id, so the prompt prefix is byte-stable for provider prompt caching.
  const sortable = a.nearby.map((n) => n.id);
  assert.deepEqual(sortable, [...sortable].sort((x, y) => x - y));
  // Nearby entities must actually be near: this is a radius filter, not everything.
  assert.ok(a.nearby.every((n) => Math.abs(n.position[0]) <= 40 && Math.abs(n.position[2]) <= 40));
});

test("actions reject impossible requests instead of silently succeeding", async () => {
  await initPhysics();
  const island = buildIsland(config, ["A"]);
  const nameToIndex = new Map(island.agents.map((a, i) => [a.name, i]));
  const idx = nameToIndex.get("A");
  assert.equal(idx, 0);

  // Place with empty hands is rejected but still costs a tick.
  const place = runRound(island, {
    day: 1,
    round: 0,
    chain: startChain(),
    submissions: [{ agent: "A", actions: [{ type: "Place", position: [0, 1, 0] }] }],
  });
  const result = place.records[0]?.result[0];
  assert.ok(result && result.ok === false);
  assert.equal(result.reason, "not_holding");
  assert.equal(result.ticks, 1);

  // Moving somewhere is accepted and takes a physical number of ticks, derived from
  // the distance actually travelled -- not a constant.
  const agent = island.agents[0];
  assert.ok(agent);
  const from = agent.body.translation();
  const target: [number, number, number] = [20, from.y, 0];
  const metres = Math.hypot(target[0] - from.x, target[2] - from.z);
  const expected = Math.ceil((metres / island.motion.walkSpeed) * island.motion.tickRate);

  const move = runRound(island, {
    day: 1,
    round: 1,
    chain: place.chain,
    submissions: [{ agent: "A", actions: [{ type: "MoveTo", position: target }] }],
  });
  const moveResult = move.records[0]?.result[0];
  assert.ok(moveResult && moveResult.ok === true);
  assert.equal(moveResult.ticks, expected, `${metres.toFixed(2)}m at 4.5m/s should be ${expected} ticks`);
  // A short hop must be cheaper than a long walk: the duration is distance-derived.
  const near = runRound(island, {
    day: 1,
    round: 2,
    chain: move.chain,
    submissions: [{ agent: "A", actions: [{ type: "MoveTo", position: [target[0], target[1], target[2] + 1] }] }],
  });
  const nearResult = near.records[0]?.result[0];
  assert.ok(nearResult && nearResult.ok === true);
  assert.ok(nearResult.ticks < moveResult.ticks, "a 1m step must cost fewer ticks than a long walk");
});
