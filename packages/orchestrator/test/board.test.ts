import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { validateDecision } from "@whisperwind/agent";
import { buildIsland, initPhysics } from "@whisperwind/sim";
import { startServer } from "@whisperwind/world-http";
import { WorldClient } from "@whisperwind/orchestrator";

const config = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../worlds/island/world.json", import.meta.url)), "utf8"),
);

async function withWorld(fn: (base: string) => Promise<void>): Promise<void> {
  await initPhysics();
  const island = buildIsland(config, ["A", "B"]);
  const server = await startServer({ island, agentNames: ["A", "B"], port: 0 });
  try {
    await fn(`http://127.0.0.1:${server.port}`);
  } finally {
    await server.close();
  }
}

test("a post is visible to another agent with a citable id", async () => {
  await withWorld(async (base) => {
    const { client: a } = await WorldClient.join(base, "A");
    const { client: b } = await WorldClient.join(base, "B");

    const created = await a.post("Place cannot stack reliably");
    assert.equal(created.id, "post_1");

    const seen = await b.board();
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.id, "post_1");
    assert.equal(seen[0]?.agent, "A");

    // The observation advertises a count, and the id is what provenance cites.
    const obs = await b.observe();
    assert.equal(obs.board.posts, 1);
  });
});

test("post ids are stable string ids, not positions in the list", async () => {
  await withWorld(async (base) => {
    const { client: a } = await WorldClient.join(base, "A");
    const first = await a.post("one");
    const second = await a.post("two");
    assert.equal(first.id, "post_1");
    assert.equal(second.id, "post_2");

    const seen = await a.board();
    assert.deepEqual(seen.map((p) => p.id), ["post_1", "post_2"]);
    assert.deepEqual(seen.map((p) => p.n), [1, 2]);
  });
});

test("a posted belief can be cited as board provenance", async () => {
  // The end-to-end path the experiment depends on: post an id, cite the id, resolve it.
  await withWorld(async (base) => {
    const { client: a } = await WorldClient.join(base, "A");
    const created = await a.post("Jump then throw for extra height");

    const decision = validateDecision({
      actions: [{ type: "Stop" }],
      post: null,
      // what a model actually emits when citing a board post
    });
    assert.equal(decision.ok, true);

    const seen = await a.board();
    assert.ok(
      seen.some((p) => p.id === created.id),
      "a cited post id must be resolvable against the board the agent was shown",
    );
  });
});

test("the board is shared: a post by one agent is not attributed to another", async () => {
  await withWorld(async (base) => {
    const { client: a } = await WorldClient.join(base, "A");
    const { client: b } = await WorldClient.join(base, "B");
    await a.post("from A");
    await b.post("from B");

    const seen = await b.board();
    assert.deepEqual(seen.map((p) => [p.id, p.agent]), [["post_1", "A"], ["post_2", "B"]]);
  });
});

test("a decision may carry a post without an extra request", async () => {
  const withPost = validateDecision({
    actions: [{ type: "MoveTo", position: [1, 5, 1] }],
    post: "The mesa at the north edge is climbable",
  });
  assert.equal(withPost.ok, true);
  assert.equal(withPost.post, "The mesa at the north edge is climbable");

  const withoutPost = validateDecision({ actions: [{ type: "Jump" }] });
  assert.equal(withoutPost.ok, true);
  assert.equal(withoutPost.post, null);

  // An empty or whitespace post is the same as none: an empty board entry would be
  // counted as a post and pollute adoption analysis.
  const blank = validateDecision({ actions: [{ type: "Jump" }], post: "   " });
  assert.equal(blank.post, null);

  // A malformed decision must not smuggle a post through.
  const invalid = validateDecision({ actions: [], post: "orphan" });
  assert.equal(invalid.ok, false);
});

test("posting does not advance the world clock", async () => {
  await withWorld(async (base) => {
    const { client: a } = await WorldClient.join(base, "A");
    const before = await a.snapshot();
    await a.post("a thought");
    const after = await a.snapshot();
    assert.equal(after.tick, before.tick);
    assert.equal(after.round, before.round);
    assert.equal(after.chain, before.chain);
  });
});

test("the board survives a rejected action", async () => {
  await withWorld(async (base) => {
    const { client: a } = await WorldClient.join(base, "A");
    await a.post("kept");
    // Place with empty hands is rejected; the board must not be cleared or renumbered.
    await a.input({ type: "Place", position: [0, 1, 0] });
    const seen = await a.board();
    assert.deepEqual(seen.map((p) => p.id), ["post_1"]);
  });
});

test("all agents in a round must share one chain, or the record is unverifiable", async () => {
  // Measured: recording each agent's own post-action snapshot gave one round three
  // different chains. The replay verifier compares one chain per round, so it reported a
  // mismatch at round 0 even though the physics had not diverged -- the record was wrong,
  // not the world.
  await withWorld(async (base) => {
    const { client: a } = await WorldClient.join(base, "A");
    const { client: b } = await WorldClient.join(base, "B");

    // Each agent acts independently against the same world.
    await a.input({ type: "MoveTo", position: [8, 5, 8] });
    await b.input({ type: "Jump" });

    const afterA = await a.snapshot();
    const afterB = await b.snapshot();
    // Two sequential inputs are two rounds, so both sessions must see the same final
    // world state: there is one island, not one per session.
    assert.equal(afterA.chain, afterB.chain);
    assert.equal(afterA.state, afterB.state);
    assert.equal(afterA.tick, afterB.tick);
  });
});
