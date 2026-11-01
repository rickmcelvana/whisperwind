import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ACTION_TYPES, type Observation } from "@whisperwind/core";
import { buildIsland, initPhysics } from "@whisperwind/sim";
import { startServer, wireToAction } from "@whisperwind/world-http";

const config = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../worlds/island/world.json", import.meta.url)), "utf8"),
);
const AGENTS = ["A", "B"] as const;

async function withServer(
  fn: (base: string) => Promise<void>,
): Promise<void> {
  await initPhysics();
  const island = buildIsland(config, [...AGENTS]);
  const server = await startServer({
    island,
    worldName: "island",
    agentNames: [...AGENTS],
    port: 0,
  });
  try {
    await fn(`http://127.0.0.1:${server.port}`);
  } finally {
    await server.close();
  }
}

async function join(base: string, name: string): Promise<{ session: string; agentId: string }> {
  const res = await fetch(`${base}/join?name=${name}`, { method: "POST" });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { session: string; agentId: string };
  assert.ok(body.session);
  return body;
}

test("/api.md lists every action from the contract", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api.md`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/markdown/);
    const text = await res.text();
    for (const action of ACTION_TYPES) {
      assert.ok(text.includes(action), `/api.md is missing ${action}`);
    }
    assert.match(text, /no objective/i);
  });
});

test("join gives each session a distinct body, and observe reflects it", async () => {
  await withServer(async (base) => {
    const a = await join(base, "first");
    const b = await join(base, "second");
    assert.notEqual(a.agentId, b.agentId);

    const res = await fetch(`${base}/observe`, { headers: { "x-session": a.session } });
    assert.equal(res.status, 200);
    const obs = (await res.json()) as Observation;
    assert.equal(obs.player.name, a.agentId);
    assert.equal(obs.others.length, 1);
    assert.equal(obs.others[0]?.name, b.agentId);
  });
});

test("observe without a session is rejected", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/observe`);
    assert.equal(res.status, 401);
  });
});

test("a third join is refused when the world has two bodies", async () => {
  await withServer(async (base) => {
    await join(base, "one");
    await join(base, "two");
    const res = await fetch(`${base}/join?name=three`, { method: "POST" });
    assert.equal(res.status, 409);
  });
});

test("/input moves the world and the observation follows", async () => {
  await withServer(async (base) => {
    const { session } = await join(base, "mover");

    const before = (await (await fetch(`${base}/observe`, { headers: { "x-session": session } })).json()) as Observation;

    const res = await fetch(`${base}/input`, {
      method: "POST",
      headers: { "x-session": session, "content-type": "application/json" },
      body: JSON.stringify({ type: "MoveTo", data: { position: [20, 5, 20] } }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { observation: Observation; result: { ok: boolean; ticks: number } };

    assert.equal(body.result.ok, true);
    assert.ok(body.result.ticks > 1, "a MoveTo must consume a physical number of ticks");
    assert.notDeepEqual(body.observation.player.position, before.player.position);
    assert.match(body.observation.player.last ?? "", /MoveTo ok/);
    // tick advanced in step with the action's duration
    assert.equal(body.observation.tick, body.result.ticks);
  });
});

test("Place with empty hands is reported, not silently accepted", async () => {
  await withServer(async (base) => {
    const { session } = await join(base, "placer");
    const res = await fetch(`${base}/input`, {
      method: "POST",
      headers: { "x-session": session, "content-type": "application/json" },
      body: JSON.stringify({ type: "Place", data: { position: [0, 1, 0] } }),
    });
    const body = (await res.json()) as { result: { ok: boolean; reason?: string; ticks: number } };
    assert.equal(body.result.ok, false);
    assert.equal(body.result.reason, "not_holding");
    assert.equal(body.result.ticks, 1);
  });
});

test("an unknown action type is rejected as a result, not a 500", async () => {
  await withServer(async (base) => {
    const { session } = await join(base, "typo");
    const res = await fetch(`${base}/input`, {
      method: "POST",
      headers: { "x-session": session, "content-type": "application/json" },
      body: JSON.stringify({ type: "Fly", data: {} }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { result: { ok: boolean; reason?: string } };
    assert.equal(body.result.ok, false);
    assert.equal(body.result.reason, "unknown_action");
  });
});

test("invalid JSON is a 400, not a crash", async () => {
  await withServer(async (base) => {
    const { session } = await join(base, "bad");
    const res = await fetch(`${base}/input`, {
      method: "POST",
      headers: { "x-session": session, "content-type": "application/json" },
      body: "{not json",
    });
    assert.equal(res.status, 400);
  });
});

test("chat and board are append-only and readable with a cursor", async () => {
  await withServer(async (base) => {
    const a = await join(base, "talker");
    const b = await join(base, "listener");

    await fetch(`${base}/chat`, {
      method: "POST",
      headers: { "x-session": a.session, "content-type": "application/json" },
      body: JSON.stringify({ content: "hello island" }),
    });

    const first = (await (await fetch(`${base}/chat/messages?after=0`, { headers: { "x-session": b.session } })).json()) as {
      messages: { n: number; content: string; agent: string }[];
    };
    assert.equal(first.messages.length, 1);
    assert.equal(first.messages[0]?.content, "hello island");
    assert.equal(first.messages[0]?.agent, a.agentId);
    const cursor = first.messages[0]?.n ?? 0;

    // Reading again past the cursor yields nothing: n is stable, not re-derived.
    const again = (await (await fetch(`${base}/chat/messages?after=${cursor}`, { headers: { "x-session": b.session } })).json()) as {
      messages: unknown[];
    };
    assert.equal(again.messages.length, 0);

    await fetch(`${base}/board`, {
      method: "POST",
      headers: { "x-session": a.session, "content-type": "application/json" },
      body: JSON.stringify({ content: "Place is unreliable" }),
    });
    const posts = (await (await fetch(`${base}/board/posts`, { headers: { "x-session": b.session } })).json()) as {
      posts: { content: string; agent: string; n: number }[];
    };
    assert.equal(posts.posts.length, 1);
    assert.equal(posts.posts[0]?.content, "Place is unreliable");

    // The observation advertises counts, not contents.
    const obs = (await (await fetch(`${base}/observe`, { headers: { "x-session": b.session } })).json()) as Observation;
    assert.equal(obs.board.posts, 1);
    assert.equal(obs.chat.unread, 1);
  });
});

test("snapshot carries a chain and base64 state", async () => {
  await withServer(async (base) => {
    const { session } = await join(base, "snapper");
    const res = await fetch(`${base}/snapshot`, { headers: { "x-session": session } });
    const body = (await res.json()) as { format: string; chain: string; data: string; state: string };
    assert.equal(body.format, "rapier-snapshot-v1");
    assert.equal(body.chain.length, 64);
    assert.equal(body.state.length, 64);
    assert.ok(body.data.length > 100);
    // Round-trips to bytes Rapier accepts.
    assert.ok(Buffer.from(body.data, "base64").byteLength > 100);
  });
});

test("wireToAction maps the documented wire shape", () => {
  const move = wireToAction({ type: "MoveTo", data: { position: [1, 2, 3] } });
  assert.ok("action" in move);
  assert.deepEqual(move.action, { type: "MoveTo", position: [1, 2, 3] });

  const bad = wireToAction({ type: "MoveTo", data: { position: [1, 2] } });
  assert.ok("rejected" in bad);

  const unknown = wireToAction({ type: "Teleport" });
  assert.ok("rejected" in unknown);
  assert.equal(unknown.rejected.ok, false);
});
