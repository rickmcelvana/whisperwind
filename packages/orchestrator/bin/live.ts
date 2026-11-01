/**
 * Live smoke: three real models, one world, over HTTP.
 *
 *   node packages/orchestrator/bin/live.ts            # ~6 rounds, small budget
 *   node packages/orchestrator/bin/live.ts --rounds 20
 *
 * This is not the M0 acceptance test (that is packages/sim/bin/m0.ts, which uses
 * scripted actions and proves the sim and recording). This proves the agent layer
 * against real providers: that decisions validate, that the world advances, and that
 * a live run records a chain that replays.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { parseYaml } from "@whisperwind/core";
import {
  ClaimStore,
  createProvider,
  ACTION_SCHEMA,
  loadMemory,
  reflect,
  validateDecision,
} from "@whisperwind/agent";
import { buildIsland, initPhysics, observe, runRound, startChain, stateDigest } from "@whisperwind/sim";
import type { ActionSequence, AgentSpec, Observation } from "@whisperwind/core";

const worldPath = fileURLToPath(new URL("../../../worlds/island/world.json", import.meta.url));
const modelsPath = fileURLToPath(new URL("../../../worlds/island/models.yaml", import.meta.url));
const config = JSON.parse(readFileSync(worldPath, "utf8"));
const models = parseYaml(readFileSync(modelsPath, "utf8"));

const roundsArg = process.argv.indexOf("--rounds");
const ROUNDS = roundsArg >= 0 ? Number(process.argv[roundsArg + 1]) : 4;
/** Reflection costs one extra request per agent per day; opt in with --reflect. */
const DO_REFLECT = process.argv.includes("--reflect");

const agents = parseAgents(models);
const runId = `live-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const runDir = join("runs", runId);

interface ProviderDoc {
  kind: string;
  baseUrl: string;
}

function parseAgents(doc: Record<string, unknown>): AgentSpec[] {
  const list = doc["agents"];
  if (!Array.isArray(list)) throw new Error("models.yaml has no agents list");
  return list.map((raw) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error("agent entry is not a mapping");
    }
    const rec = raw as Record<string, unknown>;
    const name = rec["name"];
    const provider = rec["provider"];
    const model = rec["model"];
    const think = rec["think"];
    if (typeof name !== "string" || typeof provider !== "string" || typeof model !== "string") {
      throw new Error("agent entry needs name, provider and model");
    }
    return { name, provider, model, think: think === true };
  });
}

function providerFor(name: string): ProviderDoc {
  const providers = models["providers"];
  if (typeof providers !== "object" || providers === null || Array.isArray(providers)) {
    throw new Error("models.yaml has no providers mapping");
  }
  const entry = (providers as Record<string, unknown>)[name];
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new Error(`unknown provider ${name}`);
  }
  const rec = entry as Record<string, unknown>;
  const kind = rec["kind"];
  const baseUrl = rec["baseUrl"];
  if (typeof kind !== "string" || typeof baseUrl !== "string") {
    throw new Error(`provider ${name} needs kind and baseUrl`);
  }
  return { kind, baseUrl };
}

const SYSTEM = [
  "You live on a small island. You were born here.",
  "You are naturally curious and you get bored easily.",
  "There is no objective, no score, and no win condition. Do what interests you.",
  "Respond with JSON: {\"actions\":[{\"type\":..., ...}], \"reason\":\"...\"}.",
  "Available actions: MoveTo{position}, Jump{}, Stop{}, Pickup{position}, Place{position}, Throw{direction,speed}.",
  "You may chain several actions if they follow from one decision.",
].join(" ");

interface Decider {
  name: string;
  provider: ReturnType<typeof createProvider>;
  spec: AgentSpec;
}

async function decide(
  d: Decider,
  obs: Observation,
  memoryPrefix: string,
  maxRepairs = 1,
): Promise<{
  actions: ActionSequence;
  invalid: boolean;
  tokens?: { prompt: number; completion: number };
  wallMs: number;
}> {
  // Stable prefix first (soul + memory), volatile tail last, so provider prompt caching
  // can hit on the part that does not change between rounds.
  const messages = [
    { role: "system" as const, content: SYSTEM },
    { role: "user" as const, content: `${memoryPrefix}\nObservation:\n${JSON.stringify(obs)}\n\nWhat do you do?` },
  ];

  let totalPrompt = 0;
  let totalCompletion = 0;
  const started = performance.now();

  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    const res = await d.provider.chat({
      model: d.spec.model,
      think: d.spec.think,
      schema: ACTION_SCHEMA,
      tools: [{ type: "function", function: { name: "act", parameters: ACTION_SCHEMA } }],
      messages,
    });
    totalPrompt += res.promptTokens ?? 0;
    totalCompletion += res.completionTokens ?? 0;

    const verdict = validateDecision(res.value);
    if (verdict.ok) {
      return {
        actions: verdict.actions,
        invalid: false,
        ...(totalPrompt || totalCompletion ? { tokens: { prompt: totalPrompt, completion: totalCompletion } } : {}),
        wallMs: Math.round(performance.now() - started),
      };
    }

    // One repair retry, with the validator's own words. Measured to recover the
    // provider that ignores `format` on its own.
    messages.push({ role: "assistant" as const, content: res.text.slice(0, 500) });
    messages.push({
      role: "user" as const,
      content: `That was not a valid decision: ${verdict.error}. Reply with JSON only: {"actions":[{"type":"MoveTo","position":[x,y,z]}]}`,
    });
  }

  return {
    actions: [{ type: "Stop" }],
    invalid: true,
    ...(totalPrompt || totalCompletion ? { tokens: { prompt: totalPrompt, completion: totalCompletion } } : {}),
    wallMs: Math.round(performance.now() - started),
  };
}

await initPhysics();

const deciders: Decider[] = agents.map((spec) => {
  const p = providerFor(spec.provider);
  return {
    name: spec.name,
    spec,
    provider: createProvider({ kind: p.kind === "ollama" ? "ollama" : "openai", baseUrl: p.baseUrl }),
  };
});

// Probe each model before the run, and record what it actually does.
const caps = new Map<string, Awaited<ReturnType<Decider["provider"]["probe"]>>>();
for (const d of deciders) {
  process.stdout.write(`probe ${d.name} ${d.spec.model}... `);
  const c = await d.provider.probe(d.spec.model);
  caps.set(d.name, c);
  console.log(JSON.stringify(c));
}

const island = buildIsland(config, deciders.map((d) => d.name));
let chain = startChain();
const events: unknown[] = [];
const lastResults = new Map<string, string | null>();
let tick = 0;

// One claims database per run, one workspace per agent. The store is shared because
// adoption is a relation between agents, not a per-agent fact.
mkdirSync(runDir, { recursive: true });
const claims = new ClaimStore(join(runDir, "claims.db"));
const workspaceFor = (name: string): string => join(runDir, "agents", name, "workspace");

/** Prompt prefix: the agent's memory as it stands now. Rebuilt each round. */
function memoryPrefix(name: string): string {
  const all = claims.all();
  const snapshot = loadMemory(workspaceFor(name), all, name, 8);
  return [
    "## Your memory",
    "",
    snapshot.semantic.trim(),
    "",
    "## Recently, in your own words",
    "",
    snapshot.recent.length > 0
      ? snapshot.recent.map((e) => `- (day ${e.day}) ${e.summary}`).join("\n")
      : "Nothing recorded yet.",
    "",
  ].join("\n");
}

/** What each agent did today, for the reflection pass. */
const daySummaries = new Map<string, string[]>();
for (const d of deciders) daySummaries.set(d.name, []);

let invalidTotal = 0;
const startedAt = performance.now();

for (let round = 0; round < ROUNDS; round++) {
  const submissions = await Promise.all(
    deciders.map(async (d, idx) => {
      const obs = observe(island, idx, {
        tick,
        day: 1,
        boardPosts: 0,
        boardLatestTick: null,
        unreadChat: 0,
        lastResults,
      });
      const decision = await decide(d, obs, memoryPrefix(d.name));
      if (decision.invalid) invalidTotal++;
      return { agent: d.name, decision, action: decision.actions[0]?.type ?? "none" };
    }),
  );

  const out = runRound(island, {
    day: 1,
    round,
    chain,
    submissions: submissions.map((s) => ({
      agent: s.agent,
      actions: s.decision.actions,
      ...(s.decision.tokens ? { tokens: s.decision.tokens } : {}),
      wallMs: s.decision.wallMs,
    })),
  });

  chain = out.chain;
  tick += out.ticks;
  for (const rec of out.records) {
    const first = rec.result[0];
    lastResults.set(
      rec.agent,
      first ? `${rec.action[0]?.type ?? "?"} ${first.ok ? "ok" : first.reason}` : null,
    );
    const summary = daySummaries.get(rec.agent);
    if (summary && rec.action[0]) {
      const outcome = first ? (first.ok ? "worked" : `failed: ${first.reason}`) : "no result";
      summary.push(`${rec.action.map((a) => a.type).join(" then ")} ${outcome}`);
    }
    events.push(rec);
  }

  console.log(
    JSON.stringify({
      round,
      ticks: out.ticks,
      decisions: submissions.map((s) => ({
        agent: s.agent,
        action: s.action,
        invalid: s.decision.invalid,
        ms: s.decision.wallMs,
      })),
    }),
  );
}

// Reflection at end of day. Opt-in because it costs one extra request per agent, and
// deliberately not per-action: measured, a model asked to record beliefs after every
// action narrates instead of calling a tool, and the request count doubles.
const reflections: unknown[] = [];
if (DO_REFLECT) {
  const boardFor = deciders.map((_, i) => ({
    id: `post_${i + 1}`,
    agent: deciders[i]?.name ?? "?",
    content: "(no posts yet this run)",
  }));
  for (const [i, d] of deciders.entries()) {
    const idx = i;
    const pos = island.agents[idx]?.body.translation();
    const result = await reflect({
      provider: d.provider,
      model: d.spec.model,
      think: d.spec.think,
      agent: d.name,
      day: 1,
      tick,
      workspaceDir: workspaceFor(d.name),
      store: claims,
      daySummary: daySummaries.get(d.name) ?? [],
      endPosition: pos ? [pos.x, pos.y, pos.z] : [0, 0, 0],
      board: boardFor,
    });
    reflections.push({ agent: d.name, ...result });
    console.log(JSON.stringify({ reflect: d.name, events: result.eventsRecorded, claims: result.claimsRecorded, refuted: result.refuted.length, rejected: result.claimsRejected.length, ms: result.wallMs }));
  }
}

const state = stateDigest(island);
writeFileSync(join(runDir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
writeFileSync(join(runDir, "day-1.snap"), island.world.takeSnapshot());
writeFileSync(
  join(runDir, "manifest.json"),
  JSON.stringify(
    {
      schemaVersion: 1,
      runId,
      createdAt: new Date().toISOString(),
      world: { name: config.name, seed: config.seed },
      motion: { tickRate: config.motion.tickRate, walkSpeed: config.motion.walkSpeed },
      agents: deciders.map((d) => ({
        name: d.name,
        provider: d.spec.provider,
        model: d.spec.model,
        think: d.spec.think,
        capabilities: caps.get(d.name) ?? null,
      })),
      rounds: ROUNDS,
      node: process.version,
    },
    null,
    2,
  ) + "\n",
);
writeFileSync(
  join(runDir, "memory.json"),
  JSON.stringify(
    {
      claims: claims.all().map((c) => ({
        id: c.id, agent: c.agent, day: c.day, kind: c.kind, status: c.status,
        confidence: c.confidence, source: c.source, evidence: c.evidence, text: c.text,
      })),
      reflections,
    },
    null,
    2,
  ) + "\n",
);
claims.close();
writeFileSync(
  join(runDir, "digest.json"),
  JSON.stringify({ rounds: ROUNDS, chain, terminalState: state, invalidTotal }, null, 2) + "\n",
);

console.log(
  JSON.stringify({
    runDir,
    rounds: ROUNDS,
    chain: chain.slice(0, 16),
    state: state.slice(0, 16),
    invalidTotal,
    wallSeconds: Math.round((performance.now() - startedAt) / 100) / 10,
  }),
);
