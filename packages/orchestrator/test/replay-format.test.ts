import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

/**
 * The two run writers must produce directories the same replayer can read. They
 * disagreed once: the scripted M0 run had no manifest, so the shared replayer threw
 * ENOENT while the run itself was perfectly valid.
 */
test("both run writers produce a replayable directory", () => {
  execFileSync(process.execPath, ["packages/sim/bin/m0.ts"], { stdio: "pipe" });

  for (const field of ["manifest.json", "events.jsonl", "digest.json"]) {
    assert.ok(existsSync(`runs/m0/${field}`), `runs/m0 is missing ${field}`);
  }

  const manifest = JSON.parse(readFileSync("runs/m0/manifest.json", "utf8")) as {
    schemaVersion: number;
    agents: { name: string }[];
  };
  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(
    manifest.agents.map((a) => a.name),
    ["A", "B", "C"],
  );

  // The shared replayer, not the writer's own verifier.
  const out = execFileSync(process.execPath, ["packages/orchestrator/bin/replay.ts", "runs/m0"], {
    encoding: "utf8",
  });
  const verdict = JSON.parse(out.trim().split("\n").pop() ?? "{}") as { ok: boolean; days: number };
  assert.equal(verdict.ok, true);
  // The scripted M0 run is a single day; replay reports days, not rounds, since a day
  // boundary resets the world and the chain.
  assert.equal(verdict.days, 1);
});
