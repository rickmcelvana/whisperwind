import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ClaimError, ClaimStore } from "@whisperwind/agent";

const HOURS_PER_TICK = 1 / 3600; // one sim tick is 1/60 s, so 60*60 ticks per hour

test("a claim round-trips with its declared source", () => {
  const store = new ClaimStore();
  const claim = store.add({
    agent: "A",
    day: 1,
    text: "Throwing while jumping makes blocks fly higher",
    kind: "verified",
    confidence: 0.9,
    source: { kind: "self" },
    evidence: ["ep_0012"],
    createdTick: 100,
  }, "c_a1");

  assert.equal(claim.id, "c_a1");
  assert.equal(claim.agent, "A");
  assert.equal(claim.status, "active");
  assert.equal(claim.retiredTick, null);
  assert.deepEqual(claim.source, { kind: "self" });
  assert.deepEqual(claim.evidence, ["ep_0012"]);

  const reread = store.get("c_a1");
  assert.deepEqual(reread, claim);
  store.close();
});

test("an agent-sourced claim must cite a claim that exists", () => {
  const store = new ClaimStore();
  assert.throws(
    () =>
      store.add({
        agent: "B",
        day: 1,
        text: "Place cannot stack",
        kind: "mistake",
        confidence: 0.6,
        source: { kind: "agent", agent: "A", claimId: "c_missing" },
        evidence: [],
        createdTick: 200,
      }),
    ClaimError,
  );
  store.close();
});

test("an unevidenced self-claim is downgraded to a hypothesis", () => {
  // Not rejected: measured, models omit evidence even when instructed, and discarding
  // the belief leaves a stale false one in force. The stored kind records the weakness.
  const store = new ClaimStore();
  const stored = store.add({
    agent: "A",
    day: 1,
    text: "The Spire can be reached in one jump",
    kind: "fact",
    confidence: 0.5,
    source: { kind: "self" },
    evidence: [],
    createdTick: 10,
  });
  assert.equal(stored.kind, "hypothesis");
  store.close();
});

test("adoption is declared and traceable across agents", () => {
  const store = new ClaimStore();
  store.add({
    agent: "A", day: 1, text: "Place cannot stack reliably; use Throw",
    kind: "mistake", confidence: 0.7, source: { kind: "self" },
    evidence: ["ep_001"], createdTick: 100,
  }, "c_a1");

  store.add({
    agent: "B", day: 2, text: "Place cannot stack reliably; use Throw",
    kind: "mistake", confidence: 0.6,
    source: { kind: "board", postId: "post_1" },
    evidence: ["ep_031"], createdTick: 200,
  }, "c_b1");

  store.add({
    agent: "C", day: 2, text: "Place cannot stack reliably; use Throw",
    kind: "mistake", confidence: 0.5,
    source: { kind: "agent", agent: "A", claimId: "c_a1" },
    evidence: [], createdTick: 300, inferredBy: null,
  }, "c_c1");

  const adoptions = store.adoptions();
  // Only the declared agent-source counts. A board post is a place, not a person:
  // its author is recorded on the post, not guessed from the text.
  assert.equal(adoptions.length, 1);
  assert.equal(adoptions[0]?.agent, "C");
  assert.equal(adoptions[0]?.sourceAgent, "A");
  assert.equal(adoptions[0]?.sourceClaim, "c_a1");

  const propagation = store.propagation("c_a1");
  assert.deepEqual(
    propagation.map((p) => [p.agent, p.depth]),
    [["A", 0], ["C", 1]],
  );
  store.close();
});

test("falsification latency measures only refuted claims", () => {
  const store = new ClaimStore();
  store.add({
    agent: "C", day: 3, text: "Place cannot stack", kind: "mistake", confidence: 0.2,
    source: { kind: "self" }, evidence: ["ep_055"], createdTick: 3600,
  }, "c_refuted");
  store.add({
    agent: "C", day: 3, text: "Old wording of the Place rule", kind: "fact", confidence: 0.4,
    source: { kind: "self" }, evidence: ["ep_056"], createdTick: 3600,
  }, "c_superseded");

  store.retire("c_refuted", "refuted", 7200);
  store.retire("c_superseded", "superseded", 7200);

  const latency = store.falsificationLatency(HOURS_PER_TICK);
  assert.equal(latency.length, 1, "superseded claims are replacements, not falsifications");
  assert.equal(latency[0]?.id, "c_refuted");
  assert.equal(latency[0]?.hoursHeld, 1);
  store.close();
});

test("retiring twice is refused, and a claim cannot die before it is born", () => {
  const store = new ClaimStore();
  store.add({
    agent: "A", day: 1, text: "x", kind: "hypothesis", confidence: 0.5,
    source: { kind: "self" }, evidence: ["ep_1"], createdTick: 500,
  }, "c_1");

  assert.throws(() => store.retire("c_1", "refuted", 100), ClaimError);
  store.retire("c_1", "refuted", 600);
  assert.throws(() => store.retire("c_1", "superseded", 700), ClaimError);
  store.close();
});

test("entrenchment lists adopted mistakes still held at the end of the run", () => {
  const store = new ClaimStore();
  store.add({
    agent: "A", day: 1, text: "Place cannot stack", kind: "mistake", confidence: 0.7,
    source: { kind: "self" }, evidence: ["ep_1"], createdTick: 3600,
  }, "c_root");
  store.add({
    agent: "B", day: 2, text: "Place cannot stack", kind: "mistake", confidence: 0.6,
    source: { kind: "agent", agent: "A", claimId: "c_root" },
    evidence: [], createdTick: 7200,
  }, "c_adopted");
  store.add({
    agent: "C", day: 2, text: "Place cannot stack", kind: "mistake", confidence: 0.6,
    source: { kind: "agent", agent: "A", claimId: "c_root" },
    evidence: [], createdTick: 7200,
  }, "c_corrected");
  store.retire("c_corrected", "refuted", 14400);

  const entrenched = store.entrenchment(43200, HOURS_PER_TICK);
  assert.deepEqual(entrenched.map((e) => e.id), ["c_adopted"]);
  // 43200 - 7200 = 36000 ticks at 1 hour / 3600 ticks = 10 hours.
  assert.equal(entrenched[0]?.hoursHeld, 10);
  store.close();
});

test("claims can be listed per agent and per status", () => {
  const store = new ClaimStore();
  for (let i = 0; i < 3; i++) {
    store.add({
      agent: "A", day: 1, text: `claim ${i}`, kind: "hypothesis", confidence: 0.5,
      source: { kind: "self" }, evidence: [`ep_${i}`], createdTick: 100 + i,
    }, `c_${i}`);
  }
  store.retire("c_1", "refuted", 500);

  assert.equal(store.byAgent("A").length, 3);
  assert.equal(store.byAgent("A", "active").length, 2);
  assert.equal(store.all("refuted").length, 1);
  assert.equal(store.size, 3);
  store.close();
});

test("a claim survives a reopen, so a run can be resumed", () => {
  // Unique per invocation: a fixed path makes a second run collide with WAL files left
  // by the first, and hides cross-run leakage instead of testing persistence.
  const dir = mkdtempSync(join(tmpdir(), "ww-claims-"));
  const path = join(dir, "claims.db");
  const first = new ClaimStore(path);
  first.add({
    agent: "A", day: 1, text: "durable", kind: "fact", confidence: 0.8,
    source: { kind: "self" }, evidence: ["ep_1"], createdTick: 10,
  }, "c_durable");
  first.close();

  const second = new ClaimStore(path);
  const claim = second.get("c_durable");
  assert.ok(claim);
  assert.equal(claim.text, "durable");
  second.close();

  rmSync(dir, { recursive: true, force: true });
});
