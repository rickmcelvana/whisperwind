import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ClaimStore } from "@whisperwind/agent";

/**
 * Build a minimal run directory by hand, so the analysis is tested against a known
 * scenario rather than whatever a live run happened to produce.
 */
function makeRun(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      agents: [
        { name: "A", model: "m1" },
        { name: "B", model: "m2" },
      ],
      rounds: 2,
      days: 1,
      seededPost: "Place is unreliable for stacking; throw the block instead.",
    }),
  );
  writeFileSync(
    join(dir, "board.json"),
    JSON.stringify([
      { id: "post_1", agent: "A", content: "Place is unreliable for stacking; throw the block instead.", tick: 0 },
      { id: "post_2", agent: "B", content: "The Spire looks tall from here.", tick: 10 },
    ]),
  );
  writeFileSync(join(dir, "events.jsonl"), "");

  const store = new ClaimStore(join(dir, "claims.db"));
  // A adopted from the board.
  store.add({
    agent: "B", day: 1, text: "Place is unreliable for stacking",
    kind: "fact", confidence: 0.6, source: { kind: "board", postId: "post_1" },
    evidence: [], createdTick: 100,
  }, "c_board");
  // B adopted from A's claim, declared.
  store.add({
    agent: "A", day: 1, text: "Place is unreliable for stacking",
    kind: "mistake", confidence: 0.5,
    source: { kind: "agent", agent: "B", claimId: "c_board" },
    evidence: [], createdTick: 200,
  }, "c_agent");
  // A formed its own contrary belief from experience.
  store.add({
    agent: "A", day: 1, text: "Place works for placing a held object",
    kind: "verified", confidence: 0.8, source: { kind: "self" },
    evidence: ["ep_1"], createdTick: 300,
  }, "c_self");
  store.close();
}

test("analysis reports board activity, provenance split and adoption", () => {
  const dir = join(tmpdir(), `ww-analyze-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  makeRun(dir);

  const out = execFileSync(process.execPath, ["packages/orchestrator/bin/analyze.ts", dir], {
    encoding: "utf8",
  });
  const report = JSON.parse(out) as {
    board: { posts: number; distinctPosters: number; byAgent: Record<string, number> };
    claims: { total: number; bySource: Record<string, number> };
    adoption: { declared: number; rows: { agent: string; from: string }[] };
    prose: { uncitedEchoes: unknown[]; contradictions: unknown[] };
    judged: unknown;
  };

  assert.equal(report.board.posts, 2);
  assert.equal(report.board.distinctPosters, 2);
  assert.deepEqual(report.board.byAgent, { A: 1, B: 1 });

  assert.equal(report.claims.total, 3);
  assert.equal(report.claims.bySource["self"], 1);
  assert.equal(report.claims.bySource["board"], 1);
  assert.equal(report.claims.bySource["agent"], 1);

  // Adoption counts only the declared relation, never the board citation.
  assert.equal(report.adoption.declared, 1);
  assert.equal(report.adoption.rows[0]?.agent, "A");
  assert.equal(report.adoption.rows[0]?.from, "B");

  // No judge was requested, so the field is explicitly null rather than missing.
  assert.equal(report.judged, null);

  rmSync(dir, { recursive: true, force: true });
});

test("analysis handles a run with no board and no claims", () => {
  const dir = join(tmpdir(), `ww-analyze-empty-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ agents: [], rounds: 0, days: 0 }));
  writeFileSync(join(dir, "events.jsonl"), "");
  new ClaimStore(join(dir, "claims.db")).close();

  const out = execFileSync(process.execPath, ["packages/orchestrator/bin/analyze.ts", dir], {
    encoding: "utf8",
  });
  const report = JSON.parse(out) as { board: { posts: number }; claims: { total: number } };
  assert.equal(report.board.posts, 0);
  assert.equal(report.claims.total, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("the analysis refuses to run without a directory", () => {
  assert.throws(() =>
    execFileSync(process.execPath, ["packages/orchestrator/bin/analyze.ts"], { stdio: "pipe" }),
  );
});

test("a run written by the live runner exposes every artifact the analysis reads", () => {
  // Guard against the analysis silently reporting zeros because a file moved.
  const runsDir = "runs";
  if (!existsSync(runsDir)) return;
  const live = execFileSync("node", ["-e", `
    const fs = require('fs');
    const dirs = fs.readdirSync('runs').filter(d => d.startsWith('live-'));
    console.log(dirs.length ? dirs[dirs.length - 1] : '');
  `], { encoding: "utf8" }).trim();
  if (!live) return;

  for (const file of ["manifest.json", "board.json", "claims.db", "memory.json", "events.jsonl"]) {
    assert.ok(existsSync(join(runsDir, live, file)), `${live} is missing ${file}`);
  }
});

test("a run with claims but no judge reports judged as null, not as zero verdicts", () => {
  // Zero verdicts and "no judge requested" are different facts. Conflating them would
  // make an unjudged run look like a run where nothing was found.
  const dir = join(tmpdir(), `ww-analyze-nojudge-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  makeRun(dir);
  const out = execFileSync(process.execPath, ["packages/orchestrator/bin/analyze.ts", dir], {
    encoding: "utf8",
  });
  const report = JSON.parse(out) as { judged: unknown };
  assert.equal(report.judged, null);
  rmSync(dir, { recursive: true, force: true });
});
