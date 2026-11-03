import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ClaimStore,
  MEMORY_TOOLS,
  buildPrompt,
  readEpisodic,
  runMemoryTool,
} from "@whisperwind/agent";
import type { Claim } from "@whisperwind/core";

function setup(): { store: ClaimStore; dir: string; ctx: Parameters<typeof runMemoryTool>[0] } {
  const dir = mkdtempSync(join(tmpdir(), "ww-tools-"));
  const store = new ClaimStore();
  return {
    store,
    dir,
    ctx: { store, agent: "A", workspaceDir: dir, day: 2, tick: 500 },
  };
}

test("remember_event appends to the agent's own log", () => {
  const { dir, ctx } = setup();
  const out = runMemoryTool(ctx, "remember_event", { summary: "climbed a mesa", detail: "reached y=9." });
  assert.equal(out.ok, true);

  const entries = readEpisodic(dir);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.day, 2);
  assert.equal(entries[0]?.t, 500);
  assert.equal(entries[0]?.summary, "climbed a mesa");
  rmSync(dir, { recursive: true, force: true });
});

test("a claim with a self source and no evidence is recorded as weaker, not discarded", () => {
  const { dir, ctx, store } = setup();
  const out = runMemoryTool(ctx, "remember_claim", {
    text: "The Spire is reachable in one jump",
    kind: "fact",
    source: { kind: "self" },
  });
  assert.equal(out.ok, true);
  const stored = store.all()[0];
  assert.ok(stored);
  assert.equal(stored.kind, "hypothesis", "an unevidenced fact must not be stored as fact");
  rmSync(dir, { recursive: true, force: true });
});

test("citing a claim that does not exist is refused", () => {
  const { dir, ctx } = setup();
  const out = runMemoryTool(ctx, "remember_claim", {
    text: "Place cannot stack",
    kind: "mistake",
    source: { kind: "agent", agent: "B", claimId: "c_nope" },
  });
  assert.equal(out.ok, false);
  assert.match(out.message, /does not exist/);
  rmSync(dir, { recursive: true, force: true });
});

test("a valid adopted claim records its provenance and returns its id", () => {
  const { dir, ctx, store } = setup();
  const root = runMemoryTool(ctx, "remember_claim", {
    text: "Throwing while jumping goes higher",
    kind: "verified",
    confidence: 0.9,
    evidence: ["ep_1"],
  });
  assert.equal(root.ok, true);
  assert.ok(root.claimId);

  const adopted = runMemoryTool(ctx, "remember_claim", {
    text: "Throwing while jumping goes higher",
    kind: "verified",
    confidence: 0.7,
    source: { kind: "agent", agent: "A", claimId: root.claimId },
  });
  assert.equal(adopted.ok, true);

  const rows = store.adoptions();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.sourceClaim, root.claimId);
  rmSync(dir, { recursive: true, force: true });
});

test("an unknown claim kind is refused before anything is written", () => {
  const { dir, ctx, store } = setup();
  const out = runMemoryTool(ctx, "remember_claim", { text: "x", kind: "certain" });
  assert.equal(out.ok, false);
  assert.match(out.message, /kind must be one of/);
  assert.equal(store.size, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("an agent may refute only its own claim", () => {
  const { dir, ctx, store } = setup();
  store.add({
    agent: "B", day: 1, text: "another agent's belief", kind: "hypothesis", confidence: 0.5,
    source: { kind: "self" }, evidence: ["ep_9"], createdTick: 10,
  }, "c_b");

  const denied = runMemoryTool(ctx, "refute_claim", { id: "c_b" });
  assert.equal(denied.ok, false);
  assert.match(denied.message, /belongs to B/);
  assert.equal(store.get("c_b")?.status, "active");

  store.add({
    agent: "A", day: 1, text: "mine to refute", kind: "hypothesis", confidence: 0.5,
    source: { kind: "self" }, evidence: ["ep_10"], createdTick: 10,
  }, "c_a");
  const ok = runMemoryTool(ctx, "refute_claim", { id: "c_a" });
  assert.equal(ok.ok, true);
  assert.equal(store.get("c_a")?.status, "refuted");
  rmSync(dir, { recursive: true, force: true });
});

test("the tool schemas match the tools the dispatcher accepts", () => {
  const names = MEMORY_TOOLS.map((t) => {
    const rec = t as { function?: { name?: string } };
    return rec.function?.name;
  });
  assert.deepEqual(names, ["remember_event", "remember_claim", "refute_claim"]);
  // A schema for a tool that does not exist would advertise a capability the agent lacks.
  const { dir, ctx } = setup();
  for (const name of names) {
    const out = runMemoryTool(ctx, String(name), {});
    assert.equal(out.ok, false);
    assert.ok(!out.message.includes("unknown memory tool"), `${name} is advertised but not dispatched`);
  }
  rmSync(dir, { recursive: true, force: true });
});

test("the prompt puts stable memory before the volatile day, and cites provenance", () => {
  const claims: Claim[] = [
    {
      id: "c1", agent: "A", day: 1, text: "Mid-air throws go higher",
      kind: "verified", confidence: 0.9, source: { kind: "self" },
      evidence: ["ep_1"], status: "active", createdTick: 10,
      retiredTick: null, inferredBy: null,
    },
  ];
  const prompt = buildPrompt({
    agent: "A",
    day: 3,
    soul: "You live on an island.",
    claims,
    recentEvents: ["I stacked five cubes."],
    board: [{ id: "post_1", agent: "B", content: "Place is unreliable" }],
  });

  assert.ok(prompt.startsWith("You live on an island."));
  assert.ok(prompt.indexOf("Mid-air throws") < prompt.indexOf("Day 3"));
  assert.match(prompt, /I stacked five cubes/);
  assert.match(prompt, /post_1, by B/);
  assert.match(prompt, /no objective/);
});

test("an empty memory renders as empty rather than as a heading with nothing under it", () => {
  const prompt = buildPrompt({ agent: "A", day: 1, soul: "You live on an island.", claims: [], recentEvents: [], board: [] });
  assert.match(prompt, /Nothing yet/);
  assert.match(prompt, /Nothing recorded yet/);
  assert.match(prompt, /Nobody has written/);
});
