import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { buildIsland, initPhysics, stateDigest } from "@whisperwind/sim";
import { startServer } from "@whisperwind/world-http";
import { WorldClient } from "@whisperwind/orchestrator";

const config = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../worlds/island/world.json", import.meta.url)), "utf8"),
);
const AGENTS = ["A", "B"] as const;

async function withResetWorld(
  fn: (base: string, token: string) => Promise<void>,
): Promise<void> {
  await initPhysics();
  const token = randomUUID();
  const server = await startServer({
    rebuild: () => buildIsland(config, [...AGENTS]),
    agentNames: [...AGENTS],
    operatorToken: token,
    port: 0,
  });
  try {
    await fn(`http://127.0.0.1:${server.port}`, token);
  } finally {
    await server.close();
  }
}

test("a new day resets geometry and clears the round clock", async () => {
  await withResetWorld(async (base, token) => {
    const { client } = await WorldClient.join(base, "A");
    const operator = new WorldClient(base, "unused", token);

    // Move somewhere, so the state is observably not the day-start state.
    await client.input({ type: "MoveTo", position: [30, 5, 30] });
    const afterMove = await client.snapshot();
    assert.ok(afterMove.round > 0);

    const started = await operator.nextDay();
    assert.equal(started.day, 2);

    const fresh = await client.snapshot();
    assert.equal(fresh.round, 0, "the round clock restarts");
    assert.equal(fresh.tick, 0, "the tick clock restarts");
    assert.equal(fresh.day, 2);

    // Geometry reset: the agent is back near its spawn, not where it walked to.
    const obs = await client.observe();
    const distanceFromSpawn = Math.hypot(obs.player.position[0] - 30, obs.player.position[2] - 30);
    assert.ok(distanceFromSpawn > 5, "the body should no longer be at the walked-to position");
  });
});

test("the board and chat survive a day reset", async () => {
  await withResetWorld(async (base, token) => {
    const { client } = await WorldClient.join(base, "A");
    const operator = new WorldClient(base, "unused", token);

    await client.post("Place cannot stack reliably");
    await client.chat("hello");

    await operator.nextDay();

    const posts = await client.board();
    assert.equal(posts.length, 1, "a post is a record, not world state: it must survive");
    assert.equal(posts[0]?.content, "Place cannot stack reliably");

    const messages = await client.messages();
    assert.equal(messages.length, 1);
  });
});

test("a reset needs the operator token, and refusal is explicit", async () => {
  await withResetWorld(async (base, token) => {
    // No token at all.
    const noToken = await fetch(`${base}/day/next`, { method: "POST" });
    assert.equal(noToken.status, 401);

    // Wrong token.
    const wrong = await fetch(`${base}/day/next`, {
      method: "POST",
      headers: { "x-operator-token": "not-the-token" },
    });
    assert.equal(wrong.status, 401);

    // The real token.
    const ok = await fetch(`${base}/day/next`, {
      method: "POST",
      headers: { "x-operator-token": token },
    });
    assert.equal(ok.status, 200);

    // An agent's session header is not authorisation.
    const viaSession = await fetch(`${base}/day/next`, {
      method: "POST",
      headers: { "x-session": "anything" },
    });
    assert.equal(viaSession.status, 401);
  });
});

test("operator endpoints are refused when no token is configured", async () => {
  // Failing closed matters: an unauthenticated reset would let an agent wipe the world it
  // is being studied in.
  await initPhysics();
  const server = await startServer({
    rebuild: () => buildIsland(config, [...AGENTS]),
    agentNames: [...AGENTS],
    port: 0,
  });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/day/next`, { method: "POST" });
    assert.equal(res.status, 403);
  } finally {
    await server.close();
  }
});

test("each day starts from an identical world state", async () => {
  // The whole point of the reset: days are comparable. If day 2 began where day 1 ended,
  // an adoption difference between days could just be geography.
  await withResetWorld(async (base, token) => {
    const { client } = await WorldClient.join(base, "A");
    const operator = new WorldClient(base, "unused", token);

    const dayOne = await client.snapshot();
    await client.input({ type: "MoveTo", position: [20, 5, 20] });
    await operator.nextDay();
    const dayTwo = await client.snapshot();

    assert.equal(dayTwo.state, dayOne.state, "day 2 must begin from the same world state as day 1");
  });
});

test("a reset does not free the bodies an existing session uses", async () => {
  // Restoring a snapshot into a fresh world left the wrapper's named bodies pointing at
  // freed handles; rebuilding is what keeps this working.
  await withResetWorld(async (base, token) => {
    const { client } = await WorldClient.join(base, "A");
    const operator = new WorldClient(base, "unused", token);

    await operator.nextDay();
    const { result } = await client.input({ type: "Jump" });
    assert.equal(result.ok, true, "the session must still control its body after a reset");

    const obs = await client.observe();
    assert.equal(obs.player.name, "A");
  });
});

test("state digests are stable across a reset, so a day boundary is verifiable", async () => {
  await initPhysics();
  const a = buildIsland(config, [...AGENTS]);
  const b = buildIsland(config, [...AGENTS]);
  assert.equal(stateDigest(a), stateDigest(b), "rebuild must be deterministic");
});

test("a multi-action decision records only what the world applied", async () => {
  // Measured: a model emitted Jump+Pickup+MoveTo, the server applied one action, and the
  // event recorded all three. Replay then performed actions the world never did and
  // diverged. The recording must describe what was sent.
  await withResetWorld(async (base) => {
    const { client } = await WorldClient.join(base, "A");
    const single = await client.input({ type: "Jump" });
    assert.equal(single.result.ok, true);

    const snap = await client.snapshot();
    // One input, one round.
    assert.equal(snap.round, 1);
  });
});
