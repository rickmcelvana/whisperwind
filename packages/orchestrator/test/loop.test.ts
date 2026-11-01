import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { buildIsland, initPhysics, startChain } from "@whisperwind/sim";
import { runDays, type Decider } from "@whisperwind/orchestrator";
import type { ActionSequence, AgentSpec } from "@whisperwind/core";

const config = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../worlds/island/world.json", import.meta.url)), "utf8"),
);

const AGENTS: readonly AgentSpec[] = [
  { name: "A", provider: "test", model: "scripted", think: false },
  { name: "B", provider: "test", model: "scripted", think: false },
];

/** A decider that walks a deterministic path, no network. */
function scripted(name: string): Decider {
  return {
    async decide(_obs, ctx) {
      const actions: ActionSequence =
        ctx.round % 2 === 0
          ? [{ type: "MoveTo", position: [(ctx.round % 10) * (name === "A" ? 1 : -1), 5, 0] }]
          : [{ type: "Jump" }];
      return { actions, wallMs: 0 };
    },
  };
}

/** A decider that never produces a valid action, to exercise the invalid counter. */
const broken: Decider = {
  async decide() {
    return { actions: [{ type: "Stop" }], invalid: true };
  },
};

test("the day loop resets geometry per day and carries the chain", async () => {
  await initPhysics();
  let built = 0;
  const resetDay = (): ReturnType<typeof buildIsland> => {
    built++;
    return buildIsland(config, AGENTS.map((a) => a.name));
  };

  const result = await runDays(
    { days: 3, decisionBudget: 5, duskLead: 1 },
    AGENTS,
    new Map([
      ["A", scripted("A")],
      ["B", scripted("B")],
    ]),
    resetDay,
  );

  assert.equal(built, 3, "the world must be rebuilt once per day");
  assert.equal(result.days.length, 3);
  assert.equal(result.records.length, 3 * 5 * AGENTS.length);
  // The chain continues across days; a reset must not restart verification.
  assert.notEqual(result.chain, startChain());
  // Every day's chain differs, because the chain accumulates.
  const chains = result.days.map((d) => d.chain);
  assert.equal(new Set(chains).size, 3);
});

test("invalid decisions are counted per agent, not silently dropped", async () => {
  await initPhysics();
  const result = await runDays(
    { days: 1, decisionBudget: 4, duskLead: 1 },
    AGENTS,
    new Map([
      ["A", scripted("A")],
      ["B", broken],
    ]),
    () => buildIsland(config, AGENTS.map((a) => a.name)),
  );

  const day = result.days[0];
  assert.ok(day);
  assert.equal(day.invalidByAgent["B"], 4);
  assert.equal(day.invalidByAgent["A"], 0);
});

test("a round advances physics by the slowest agent's action", async () => {
  await initPhysics();

  const longWalk: Decider = {
    async decide() {
      return { actions: [{ type: "MoveTo", position: [40, 5, 0] }] };
    },
  };
  const stop: Decider = {
    async decide() {
      return { actions: [{ type: "Stop" }] };
    },
  };

  const result = await runDays(
    { days: 1, decisionBudget: 1, duskLead: 0 },
    AGENTS,
    new Map([
      ["A", longWalk],
      ["B", stop],
    ]),
    () => buildIsland(config, AGENTS.map((a) => a.name)),
  );

  // Both agents' records share the round's state, so the world advanced once by the
  // longest action. A per-agent advance would give two different states.
  const states = new Set(result.records.map((r) => r.state));
  assert.equal(states.size, 1, "all agents in a round must observe the same post-round state");
});

test("the loop is deterministic for identical decisions", async () => {
  await initPhysics();

  const run = async (): Promise<string> => {
    const result = await runDays(
      { days: 2, decisionBudget: 3, duskLead: 1 },
      AGENTS,
      new Map([
        ["A", scripted("A")],
        ["B", scripted("B")],
      ]),
      () => buildIsland(config, AGENTS.map((a) => a.name)),
    );
    return result.chain;
  };

  assert.equal(await run(), await run());
});
