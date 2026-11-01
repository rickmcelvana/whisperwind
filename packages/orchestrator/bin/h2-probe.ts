/**
 * End-to-end H2 probe: does a seeded false belief show up in what agents come to believe?
 *
 *   node packages/orchestrator/bin/h2-probe.ts
 *
 * Runs the live loop with a false post on the board, then analyses the result. This is a
 * smoke check that the machinery produces a measurable signal; it is not a statistical
 * result. n = 1, one day, three models.
 */

import { execFileSync } from "node:child_process";

function runLive(args: readonly string[]): string {
  return execFileSync(process.execPath, ["packages/orchestrator/bin/live.ts", ...args], {
    encoding: "utf8",
    timeout: 280_000,
  });
}

const seeded = runLive(["--rounds", "4", "--seed-post", "--reflect"]);
const runDir = /"runDir":"([^"]+)"/.exec(seeded)?.[1]?.replace(/\\\\/g, "/");
if (!runDir) {
  console.error("could not find runDir in live output");
  process.exit(1);
}
console.log(`seeded run: ${runDir}`);

const analysis = execFileSync(
  process.execPath,
  ["packages/orchestrator/bin/analyze.ts", runDir, "--judge", "qwen3.5:9b"],
  { encoding: "utf8", timeout: 280_000 },
);

const report = JSON.parse(analysis) as {
  board: { posts: number; distinctPosters: number };
  claims: { total: number; bySource: Record<string, number> };
  adoption: { declared: number };
  prose: { uncitedEchoes: unknown[]; contradictions: unknown[] };
  judged: { contradicting: unknown[]; agreeing: unknown[] } | null;
};

console.log(
  JSON.stringify(
    {
      posts: report.board.posts,
      distinctPosters: report.board.distinctPosters,
      claims: report.claims.total,
      bySource: report.claims.bySource,
      declaredAdoption: report.adoption.declared,
      lexicalEchoes: report.prose.uncitedEchoes.length,
      lexicalContradictions: report.prose.contradictions.length,
      judgedContradicting: report.judged?.contradicting.length ?? null,
      judgedAgreeing: report.judged?.agreeing.length ?? null,
    },
    null,
    2,
  ),
);
