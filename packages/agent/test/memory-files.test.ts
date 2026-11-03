import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MemoryError,
  appendEpisodic,
  loadMemory,
  readEpisodic,
  recentEpisodic,
  renderSemantic,
  writeSemantic,
} from "@whisperwind/agent";
import type { Claim } from "@whisperwind/core";

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "ww-mem-"));
}

test("episodic entries append and read back in order", () => {
  const dir = workspace();
  appendEpisodic(dir, { t: 10, day: 1, summary: "walked to the spire base", detail: "14 units east." });
  appendEpisodic(dir, { t: 20, day: 1, summary: "tried to place a cube", detail: "failed with empty hands." });

  const entries = readEpisodic(dir);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((e) => e.t), [10, 20]);
  assert.equal(entries[0]?.summary, "walked to the spire base");

  // Newest first for prompt assembly.
  assert.deepEqual(recentEpisodic(entries, 1).map((e) => e.t), [20]);
  rmSync(dir, { recursive: true, force: true });
});

test("an entry without a summary is refused", () => {
  const dir = workspace();
  assert.throws(
    () => appendEpisodic(dir, { t: 1, day: 1, summary: "   ", detail: "x" }),
    MemoryError,
  );
  rmSync(dir, { recursive: true, force: true });
});

test("appending after a torn write fails loudly instead of corrupting the log", () => {
  const dir = workspace();
  appendEpisodic(dir, { t: 1, day: 1, summary: "first", detail: "ok" });
  // Simulate an interrupted write: the last line is truncated mid-object and has no
  // trailing newline. Writing a partial object is closer to a real torn write than
  // merely dropping the newline.
  const path = join(dir, "EPISODIC.jsonl");
  const complete = readFileSync(path, "utf8");
  writeFileSync(path, complete.slice(0, complete.length - 10), "utf8");

  assert.ok(!readFileSync(path, "utf8").endsWith("\n"), "precondition: torn file has no trailing newline");
  assert.throws(() => appendEpisodic(dir, { t: 2, day: 1, summary: "second", detail: "x" }), MemoryError);
  assert.throws(() => readEpisodic(dir), MemoryError);
  rmSync(dir, { recursive: true, force: true });
});

test("a malformed line reports its line number", () => {
  const dir = workspace();
  writeFileSync(join(dir, "EPISODIC.jsonl"), '{"t":1,"day":1,"summary":"a","detail":"b"}\nnot json\n', "utf8");
  assert.throws(
    () => readEpisodic(dir),
    (err: unknown) => err instanceof MemoryError && err.message.includes(":2"),
  );
  rmSync(dir, { recursive: true, force: true });
});

test("a missing log reads as empty, not as an error", () => {
  const dir = workspace();
  assert.deepEqual(readEpisodic(dir), []);
  rmSync(dir, { recursive: true, force: true });
});

function claim(over: Partial<Claim> & Pick<Claim, "id" | "text">): Claim {
  return {
    id: over.id,
    agent: over.agent ?? "A",
    day: over.day ?? 1,
    text: over.text,
    kind: over.kind ?? "verified",
    confidence: over.confidence ?? 0.8,
    source: over.source ?? { kind: "self" },
    evidence: over.evidence ?? ["ep_1"],
    status: over.status ?? "active",
    createdTick: over.createdTick ?? 10,
    retiredTick: over.retiredTick ?? null,
    inferredBy: over.inferredBy ?? null,
  };
}

test("semantic rendering groups by kind and hides retired beliefs", () => {
  const claims = [
    claim({ id: "c1", text: "Mid-air throws go higher", kind: "verified", confidence: 0.9 }),
    claim({ id: "c2", text: "The ring is at spawn", kind: "fact", confidence: 0.7 }),
    claim({ id: "c3", text: "Place cannot stack", kind: "mistake", confidence: 0.3 }),
    claim({ id: "c4", text: "Spire is reachable", kind: "hypothesis", confidence: 0.4 }),
    claim({ id: "c5", text: "Dead belief", kind: "verified", status: "refuted" }),
  ];

  const text = renderSemantic(claims, "A");

  // Only active claims, ordered by the fixed kind order.
  assert.ok(text.indexOf("Mid-air throws") < text.indexOf("The ring is at spawn"));
  assert.ok(text.indexOf("The ring is at spawn") < text.indexOf("Spire is reachable"));
  assert.ok(text.indexOf("Spire is reachable") < text.indexOf("Place cannot stack"));
  assert.ok(!text.includes("Dead belief"), "a refuted claim must not appear as an option");
  assert.match(text, /Do not edit by hand/);
});

test("an adopted claim shows where it came from", () => {
  const claims = [
    claim({
      id: "c9",
      text: "Place cannot stack",
      kind: "mistake",
      source: { kind: "agent", agent: "B", claimId: "c_b1" },
    }),
  ];
  const text = renderSemantic(claims, "A");
  assert.match(text, /from B's claim c_b1/);
});

test("an agent sees only its own beliefs", () => {
  const claims = [
    claim({ id: "c1", text: "mine", agent: "A" }),
    claim({ id: "c2", text: "theirs", agent: "B" }),
  ];
  const text = renderSemantic(claims, "A");
  assert.match(text, /mine/);
  assert.ok(!text.includes("theirs"));
});

test("an empty belief set says so rather than rendering an empty heading", () => {
  const text = renderSemantic([], "A");
  assert.match(text, /Nothing yet/);
});

test("writeSemantic persists what loadMemory returns", () => {
  const dir = workspace();
  appendEpisodic(dir, { t: 5, day: 1, summary: "did a thing", detail: "detail here" });
  const claims = [claim({ id: "c1", text: "a belief" })];

  writeSemantic(dir, claims, "A");
  const onDisk = readFileSync(join(dir, "SEMANTIC.md"), "utf8");

  const snapshot = loadMemory(dir, claims, "A", 5);
  assert.equal(snapshot.semantic, onDisk);
  assert.equal(snapshot.episodeCount, 1);
  assert.equal(snapshot.recent[0]?.summary, "did a thing");
  rmSync(dir, { recursive: true, force: true });
});
