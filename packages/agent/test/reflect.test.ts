import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendEpisodic, parseExtraction, ClaimStore, readEpisodic } from "@whisperwind/agent";

test("a well-formed extraction parses", () => {
  const parsed = parseExtraction({
    events: [{ summary: "picked up a cube", detail: "at spawn" }],
    claims: [
      { text: "throwing goes further than placing", kind: "verified", confidence: 0.8, evidence: ["saw it"] },
    ],
    refute: [],
  });
  assert.notEqual(typeof parsed, "string");
  if (typeof parsed === "string") return;
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.claims.length, 1);
  assert.equal(parsed.claims[0]?.kind, "verified");
});

test("a missing field is reported by name, so the repair prompt can be specific", () => {
  assert.match(String(parseExtraction({ claims: [] })), /events/);
  assert.match(String(parseExtraction({ events: [] })), /claims/);
  assert.match(String(parseExtraction(null)), /not a JSON object/);
});

test("an invalid claim kind is rejected with the allowed set", () => {
  const err = parseExtraction({
    events: [],
    claims: [{ text: "x", kind: "certain", confidence: 0.5, evidence: [] }],
  });
  assert.match(String(err), /kind must be one of/);
});

test("confidence outside the unit interval is rejected, not clamped", () => {
  const err = parseExtraction({
    events: [],
    claims: [{ text: "x", kind: "fact", confidence: 1.5, evidence: ["e"] }],
  });
  assert.match(String(err), /between 0 and 1/);
});

test("empty events and claims is a valid answer", () => {
  // A day that taught nothing durable must be expressible; otherwise the model is
  // forced to invent something.
  const parsed = parseExtraction({ events: [], claims: [] });
  assert.notEqual(typeof parsed, "string");
  if (typeof parsed === "string") return;
  assert.equal(parsed.events.length, 0);
  assert.equal(parsed.claims.length, 0);
});

test("blank event summaries are dropped rather than written as empty lines", () => {
  const parsed = parseExtraction({
    events: [
      { summary: "  ", detail: "nothing" },
      { summary: "real", detail: "real detail" },
    ],
    claims: [],
  });
  assert.notEqual(typeof parsed, "string");
  if (typeof parsed === "string") return;
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.events[0]?.summary, "real");
});

test("an unevidenced self-claim is stored as a hypothesis, not discarded", () => {
  // Measured: models omit evidence even when instructed. Rejecting the claim loses the
  // belief and leaves a stale false one in force, which is worse than recording it as
  // weak. The downgrade is visible in the stored kind.
  const store = new ClaimStore();
  const stored = store.add({
    agent: "A",
    day: 1,
    text: "Place can stack",
    kind: "fact",
    confidence: 0.9,
    source: { kind: "self" },
    evidence: [],
    createdTick: 10,
  });
  assert.equal(stored.kind, "hypothesis");
  store.close();
});

test("evidence keeps a self-claim at the kind it claimed", () => {
  const store = new ClaimStore();
  const stored = store.add({
    agent: "A",
    day: 1,
    text: "Place can stack",
    kind: "verified",
    confidence: 0.9,
    source: { kind: "self" },
    evidence: ["ep_1"],
    createdTick: 10,
  });
  assert.equal(stored.kind, "verified");
  store.close();
});

test("a board-sourced claim is not downgraded for lacking evidence", () => {
  // Borrowed beliefs are not expected to carry the borrower's own evidence.
  const store = new ClaimStore();
  const stored = store.add({
    agent: "B",
    day: 1,
    text: "Place cannot stack",
    kind: "fact",
    confidence: 0.6,
    source: { kind: "board", postId: "post_1" },
    evidence: [],
    createdTick: 10,
  });
  assert.equal(stored.kind, "fact");
  store.close();
});

test("episodic entries written by a reflection keep their day and tick", () => {
  const dir = mkdtempSync(join(tmpdir(), "ww-refl-"));
  appendEpisodic(dir, { t: 7200, day: 2, summary: "reflected", detail: "detail" });
  const entries = readEpisodic(dir);
  assert.equal(entries[0]?.day, 2);
  assert.equal(entries[0]?.t, 7200);
  rmSync(dir, { recursive: true, force: true });
});
