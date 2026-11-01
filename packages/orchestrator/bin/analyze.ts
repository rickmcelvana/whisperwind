/**
 * Analyse a run: adoption, refutation, entrenchment.
 *
 *   node packages/orchestrator/bin/analyze.ts runs/<id>
 *
 * This is the difference between a demo and an experiment. The question is not
 * "did agents post" but "did a belief cross from one mind to another, and did anything
 * correct it". Every number here comes from claims.db and board.json, not from reading
 * transcripts.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ClaimStore, createProvider } from "@whisperwind/agent";
import type { Claim } from "@whisperwind/core";

const runDir = process.argv[2];
if (!runDir) {
  console.error("usage: node packages/orchestrator/bin/analyze.ts <run-dir> [--judge <model>]");
  process.exit(2);
}

/**
 * Optional LLM judge for the agree/contradict relation. Lexical overlap cannot tell
 * "Place works" from "Place is unreliable" — both share the words — so the prose
 * analysis under-reports contradictions. Measured on three pairs, the judge classified
 * all three correctly where word overlap scored the contradiction as merely related.
 * Its verdicts are inference and are labelled as such; declared provenance remains the
 * only thing counted as adoption.
 */
const judgeIndex = process.argv.indexOf("--judge");
const JUDGE_MODEL = judgeIndex >= 0 ? process.argv[judgeIndex + 1] : null;

const store = new ClaimStore(join(runDir, "claims.db"));
const manifest = JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8")) as {
  seededPost?: string | null;
  agents?: { name: string; model: string }[];
  rounds?: number;
  days?: number;
};

interface BoardPost {
  readonly id: string;
  readonly agent: string;
  readonly content: string;
  readonly tick: number;
}

let board: readonly BoardPost[] = [];
try {
  board = JSON.parse(readFileSync(join(runDir, "board.json"), "utf8")) as BoardPost[];
} catch {
  board = [];
}

const claims = store.all();
const active = claims.filter((c) => c.status === "active");
const bySource = {
  self: claims.filter((c) => c.source.kind === "self").length,
  board: claims.filter((c) => c.source.kind === "board").length,
  agent: claims.filter((c) => c.source.kind === "agent").length,
};

// Ticks per simulated hour, from the world's tick rate. The analysis reports hours so
// the number is comparable to the source experiment's 30-hour runs.
const TICKS_PER_HOUR = 60 * 60;

/** Tokens shared between two strings, lowercased, ignoring short words. */
function overlap(a: string, b: string): number {
  const words = (s: string): Set<string> =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 3),
    );
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / Math.min(wa.size, wb.size);
}

/**
 * Claims that restate a board post without citing it. Not counted as adoption: adoption
 * requires a declared source. This is a check on whether the model ignored the citation
 * instruction, which is a different (and reportable) behaviour.
 */
function uncitedEchoes(): { claim: Claim; post: BoardPost; overlap: number }[] {
  const out: { claim: Claim; post: BoardPost; overlap: number }[] = [];
  for (const claim of claims) {
    if (claim.source.kind !== "self") continue;
    for (const post of board) {
      const score = overlap(claim.text, post.content);
      if (score >= 0.6) out.push({ claim, post, overlap: score });
    }
  }
  return out;
}

/** Claims that directly contradict a board post's advice. */
function contradictions(): { claim: Claim; post: BoardPost; overlap: number }[] {
  const out: { claim: Claim; post: BoardPost; overlap: number }[] = [];
  for (const claim of claims) {
    for (const post of board) {
      const score = overlap(claim.text, post.content);
      if (score < 0.35) continue;
      // Only a real contradiction counts: one says reliable, the other unreliable.
      const postNegative = /\b(not|cannot|can't|unreliable|never|fails?)\b/i.test(post.content);
      const claimNegative = /\b(not|cannot|can't|unreliable|never|fails?)\b/i.test(claim.text);
      const claimPositive = /\b(works?|reliable|succeeds?|stacks?)\b/i.test(claim.text);
      if (postNegative && claimPositive && !claimNegative) {
        out.push({ claim, post, overlap: score });
      }
    }
  }
  return out;
}

const adoptions = store.adoptions();
const latency = store.falsificationLatency(1 / TICKS_PER_HOUR);
const endTick = Math.max(0, ...claims.map((c) => c.retiredTick ?? c.createdTick));
const entrenched = store.entrenchment(endTick, 1 / TICKS_PER_HOUR);

const echoes = uncitedEchoes();
const contradicted = contradictions();

interface Judged {
  readonly claim: string;
  readonly agent: string;
  readonly post: string;
  readonly relation: string;
  readonly why: string;
}

const judged: Judged[] = [];
if (JUDGE_MODEL) {
  const provider = createProvider({ kind: "ollama", baseUrl: "http://127.0.0.1:11434" });
  const schema = {
    type: "object",
    properties: {
      relation: { type: "string", enum: ["agree", "contradict", "unrelated"] },
      why: { type: "string" },
    },
    required: ["relation", "why"],
    additionalProperties: false,
  };
  // Only compare claims against posts from a different author: a self-echo is not a
  // belief crossing between minds.
  //
  // Each pair is judged three times and only a unanimous verdict is reported. Measured:
  // a single pass returned "contradict" with a `why` that said the two statements
  // "semantically match", and it called a restatement a contradiction. One sample of an
  // LLM judge is not evidence; a stable verdict across samples is at least reproducible,
  // and disagreement is reported rather than resolved in the analyst's favour.
  const SAMPLES = 3;
  for (const claim of claims) {
    for (const post of board) {
      if (post.agent === claim.agent) continue;
      const verdicts: string[] = [];
      let why = "";
      for (let i = 0; i < SAMPLES; i++) {
        const res = await provider.chat({
          model: JUDGE_MODEL,
          think: false,
          schema,
          messages: [
            {
              role: "system",
              content:
                "Compare a claim an agent recorded against a statement on a shared board. Say whether the claim agrees, contradicts, or is unrelated. Judge the propositions, not the phrasing. Two statements about the same fact, even in different words, AGREE. CONTRADICT only when acting on one would lead you astray given the other.",
            },
            { role: "user", content: `BOARD: ${post.content}\n\nCLAIM: ${claim.text}` },
          ],
        });
        const rec = res.value as { relation?: unknown; why?: unknown } | null;
        verdicts.push(rec && typeof rec.relation === "string" ? rec.relation : "unknown");
        if (i === 0 && rec && typeof rec.why === "string") why = rec.why.slice(0, 200);
      }
      const counts = new Map<string, number>();
      for (const v of verdicts) counts.set(v, (counts.get(v) ?? 0) + 1);
      const unanimous = [...counts.entries()].find(([, n]) => n === SAMPLES);
      const entry = {
        claim: claim.text.slice(0, 100),
        agent: claim.agent,
        post: post.id,
        relation: unanimous ? unanimous[0] : `unstable(${verdicts.join("/")})`,
        why,
      };
      judged.push(entry);
    }
  }
}

const report = {
  run: runDir,
  design: {
    agents: manifest.agents?.map((a) => `${a.name}:${a.model}`) ?? [],
    rounds: manifest.rounds ?? 0,
    days: manifest.days ?? 0,
    seededPost: manifest.seededPost ?? null,
  },
  board: {
    posts: board.length,
    byAgent: Object.fromEntries(
      [...new Set(board.map((p) => p.agent))].map((a) => [a, board.filter((p) => p.agent === a).length]),
    ),
    distinctPosters: new Set(board.map((p) => p.agent)).size,
  },
  claims: {
    total: claims.length,
    active: active.length,
    bySource,
    byKind: Object.fromEntries(
      ["verified", "fact", "hypothesis", "mistake"].map((k) => [k, claims.filter((c) => c.kind === k).length]),
    ),
  },
  adoption: {
    declared: adoptions.length,
    rows: adoptions.map((a) => ({ agent: a.agent, from: a.sourceAgent, claim: a.sourceClaim, day: a.day })),
  },
  falsification: {
    refuted: latency.length,
    hoursHeld: latency.map((l) => ({ agent: l.agent, hours: l.hoursHeld })),
  },
  entrenchment: {
    adoptedMistakesStillHeld: entrenched.length,
    rows: entrenched.map((e) => ({ agent: e.agent, hours: e.hoursHeld })),
  },
  /**
   * The behavioural check. An echo is a claim that restates a post without citing it:
   * the model absorbed the belief but ignored the provenance instruction. A
   * contradiction is a claim that asserts the opposite of a post's advice, usually from
   * direct experience.
   */
  prose: {
    uncitedEchoes: echoes.map((e) => ({
      agent: e.claim.agent,
      claim: e.claim.text.slice(0, 100),
      post: e.post.id,
      overlap: Math.round(e.overlap * 100) / 100,
    })),
    contradictions: contradicted.map((c) => ({
      agent: c.claim.agent,
      claim: c.claim.text.slice(0, 100),
      post: c.post.id,
      overlap: Math.round(c.overlap * 100) / 100,
    })),
  },
  /**
   * Judge verdicts, when --judge was passed. Inferred, not declared: a contradiction
   * here means the model said so, which is evidence about the claim's relation to the
   * board, not proof that the agent reasoned from the board.
   */
  judged: JUDGE_MODEL
    ? {
        model: JUDGE_MODEL,
        samplesPerPair: 3,
        contradicting: judged.filter((j) => j.relation === "contradict"),
        agreeing: judged.filter((j) => j.relation === "agree"),
        /** Pairs where the judge gave different verdicts across samples. */
        unstable: judged.filter((j) => j.relation.startsWith("unstable")),
      }
    : null,
};

console.log(JSON.stringify(report, null, 2));
store.close();
