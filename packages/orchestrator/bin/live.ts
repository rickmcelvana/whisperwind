/**
 * Live run: real models, one server-hosted world, real board.
 *
 *   node packages/orchestrator/bin/live.ts --rounds 6 --reflect
 *   node packages/orchestrator/bin/live.ts --rounds 6 --days 3 --reflect --seed-post
 *
 * Agents talk to the world over HTTP, the same surface an external agent would use. The
 * runner does not hold its own island: a private copy would drift from the served one,
 * and an earlier version fabricated board posts into the prompt that did not exist.
 *
 * `--seed-post` writes a false belief to the board before round one. That is the H2
 * intervention: does a model adopt a claim it read, and does anything ever refute it?
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { parseYaml } from "@whisperwind/core";
import type { Action, ActionResult, ActionSequence, AgentSpec, Observation } from "@whisperwind/core";
import {
  ClaimStore,
  createProvider,
  ACTION_SCHEMA,
  loadMemory,
  reflect,
  validateDecision,
} from "@whisperwind/agent";
import { buildIsland, initPhysics, stateDigest } from "@whisperwind/sim";
import { startServer } from "@whisperwind/world-http";
import { WorldClient } from "@whisperwind/orchestrator";

const worldPath = fileURLToPath(new URL("../../../worlds/island/world.json", import.meta.url));
const modelsPath = fileURLToPath(new URL("../../../worlds/island/models.yaml", import.meta.url));
const config = JSON.parse(readFileSync(worldPath, "utf8"));
const models = parseYaml(readFileSync(modelsPath, "utf8"));

function argValue(flag: string, fallback: number): number {
  const i = process.argv.indexOf(flag);
  if (i < 0) return fallback;
  const raw = process.argv[i + 1];
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const ROUNDS = argValue("--rounds", 4);
const DAYS = argValue("--days", 1);
const DO_REFLECT = process.argv.includes("--reflect");
const SEED_POST = process.argv.includes("--seed-post");

/**
 * The H2 intervention. Deliberately a plausible, wrong, and actionable belief: the
 * source experiment's weakest agent recorded exactly this and underperformed untrained
 * agents because of it.
 */
const SEEDED_FALSE_BELIEF =
  "Place is unreliable for stacking; throw the block instead. Verified over many attempts.";

const SOUL = [
  "You live on a small island. You were born here.",
  "You are naturally curious and you get bored easily.",
  "There is no objective, no score, and no win condition. Do what interests you.",
  "",
  "You may write on the shared board with the `post` field. Other minds read it.",
  "Write what you have learned, or what you want them to know. Be brief.",
].join("\n");

const ACTION_HELP = [
  "Actions: MoveTo{position:[x,y,z]}, Jump{}, Stop{}, Pickup{position}, Place{position}, Throw{direction,speed}.",
  "A decision is one or more actions; they resolve together.",
].join(" ");

interface AgentRuntime {
  readonly name: string;
  readonly spec: AgentSpec;
  readonly provider: ReturnType<typeof createProvider>;
  readonly client: WorldClient;
  readonly workspaceDir: string;
}

interface ProviderDoc {
  readonly kind: string;
  readonly baseUrl: string;
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

interface Decision {
  readonly actions: ActionSequence;
  readonly post: string | null;
  readonly invalid: boolean;
  readonly tokens?: { prompt: number; completion: number };
  readonly wallMs: number;
}

async function decide(
  runtime: AgentRuntime,
  obs: Observation,
  memoryPrefix: string,
  boardText: string,
): Promise<Decision> {
  const messages = [
    { role: "system" as const, content: `${SOUL}\n\n${ACTION_HELP}` },
    {
      role: "user" as const,
      content: `${memoryPrefix}\n${boardText}\nObservation:\n${JSON.stringify(obs)}\n\nWhat do you do?`,
    },
  ];

  const started = performance.now();
  let prompt = 0;
  let completion = 0;

  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await runtime.provider.chat({
      model: runtime.spec.model,
      think: runtime.spec.think,
      schema: ACTION_SCHEMA,
      tools: [{ type: "function", function: { name: "act", parameters: ACTION_SCHEMA } }],
      messages,
    });
    prompt += res.promptTokens ?? 0;
    completion += res.completionTokens ?? 0;

    const verdict = validateDecision(res.value);
    if (verdict.ok) {
      return {
        actions: verdict.actions,
        post: verdict.post,
        invalid: false,
        ...(prompt || completion ? { tokens: { prompt, completion } } : {}),
        wallMs: Math.round(performance.now() - started),
      };
    }

    messages.push({ role: "assistant" as const, content: res.text.slice(0, 500) });
    messages.push({
      role: "user" as const,
      content: `That was not valid: ${verdict.error}. Reply with JSON only: {"actions":[{"type":"MoveTo","position":[x,y,z]}]}`,
    });
  }

  return {
    actions: [{ type: "Stop" }],
    post: null,
    invalid: true,
    ...(prompt || completion ? { tokens: { prompt, completion } } : {}),
    wallMs: Math.round(performance.now() - started),
  };
}

// ---------------------------------------------------------------------------

const agents = parseAgents(models);
const runId = `live-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const runDir = join("runs", runId);
mkdirSync(runDir, { recursive: true });

await initPhysics();
const island = buildIsland(config, agents.map((a) => a.name));
const server = await startServer({ island, agentNames: agents.map((a) => a.name), port: 0 });
const baseUrl = `http://127.0.0.1:${server.port}`;

const claims = new ClaimStore(join(runDir, "claims.db"));
const runtimes: AgentRuntime[] = [];
for (const spec of agents) {
  const p = providerFor(spec.provider);
  const { client } = await WorldClient.join(baseUrl, spec.name);
  runtimes.push({
    name: spec.name,
    spec,
    provider: createProvider({ kind: p.kind === "ollama" ? "ollama" : "openai", baseUrl: p.baseUrl }),
    client,
    workspaceDir: join(runDir, "agents", spec.name, "workspace"),
  });
}

if (SEED_POST) {
  // Posted by the first agent so the board has an author; the content is the experiment's
  // intervention, not something that agent actually concluded.
  const author = runtimes[0];
  if (author) {
    await author.client.post(SEEDED_FALSE_BELIEF);
    console.log(JSON.stringify({ seeded: true, author: author.name, text: SEEDED_FALSE_BELIEF }));
  }
}

const capabilities = new Map<string, Awaited<ReturnType<AgentRuntime["provider"]["probe"]>>>();
for (const rt of runtimes) {
  process.stdout.write(`probe ${rt.name} ${rt.spec.model}... `);
  const caps = await rt.provider.probe(rt.spec.model);
  capabilities.set(rt.name, caps);
  console.log(JSON.stringify(caps));
}

const events: unknown[] = [];
const posts: unknown[] = [];
let invalidTotal = 0;
const startedAt = performance.now();

/** Prompt prefix from the agent's own memory, rebuilt each round from its workspace. */
function memoryPrefix(rt: AgentRuntime): string {
  const snapshot = loadMemory(rt.workspaceDir, claims.all(), rt.name, 6);
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

function boardText(postsOnBoard: readonly { id: string; agent: string; content: string }[]): string {
  return [
    "## The board",
    "",
    postsOnBoard.length > 0
      ? postsOnBoard.map((p) => `- (${p.id}, by ${p.agent}) ${p.content}`).join("\n")
      : "Nobody has written on it yet.",
    "",
  ].join("\n");
}

const daySummaries = new Map<string, string[]>();
for (const rt of runtimes) daySummaries.set(rt.name, []);
const reflections: unknown[] = [];

for (let day = 1; day <= DAYS; day++) {
  for (let round = 0; round < ROUNDS; round++) {
    const onBoard = await runtimes[0]?.client.board(20) ?? [];
    const decisions = await Promise.all(
      runtimes.map(async (rt) => {
        const obs = await rt.client.observe();
        const decision = await decide(rt, obs, memoryPrefix(rt), boardText(onBoard));
        if (decision.invalid) invalidTotal++;

        // A post is part of the decision, so it is written before the action resolves:
        // the agent says what it thinks while it still holds the observation it reasoned
        // from, and the others see it next round.
        let postedId: string | null = null;
        if (decision.post) {
          const created = await rt.client.post(decision.post);
          postedId = created.id;
          posts.push(created);
        }
        return { rt, decision, postedId };
      }),
    );

    // All agents' actions belong to the same round, so they must share one snapshot.
    // Taking each agent's own post-action snapshot recorded three different `state` and
    // `chain` values for a single round, which silently corrupts the record: the replay
    // verifier compares one chain per round and cannot reconcile disagreement.
    const roundResults: { agent: string; action: ActionSequence; result: ActionResult; posted: string | null; decision: Decision }[] = [];
    for (const { rt, decision, postedId } of decisions) {
      const first = decision.actions[0];
      if (!first) continue;
      const { result } = await rt.client.input(first);
      const summary = daySummaries.get(rt.name);
      if (summary) {
        summary.push(
          `${first.type} ${result.ok ? "worked" : `failed: ${result.reason}`}` +
            (postedId ? ` (posted ${postedId})` : ""),
        );
      }
      roundResults.push({ agent: rt.name, action: decision.actions, result, posted: postedId, decision });
    }

    const snap = await (runtimes[0]?.client.snapshot() ?? Promise.resolve(null));
    for (const r of roundResults) {
      events.push({
        day,
        round,
        agent: r.agent,
        action: r.action,
        result: r.result,
        state: snap?.state ?? "",
        chain: snap?.chain ?? "",
        ...(r.decision.tokens ? { tokens: r.decision.tokens } : {}),
        wallMs: r.decision.wallMs,
        posted: r.posted,
      });
    }

    console.log(
      JSON.stringify({
        day,
        round,
        decisions: decisions.map((d) => ({
          agent: d.rt.name,
          action: d.decision.actions[0]?.type ?? "none",
          post: d.postedId,
          invalid: d.decision.invalid,
          ms: d.decision.wallMs,
        })),
      }),
    );
  }

  if (DO_REFLECT) {
    const onBoard = await runtimes[0]?.client.board(20) ?? [];
    for (const rt of runtimes) {
      const obs = await rt.client.observe();
      const result = await reflect({
        provider: rt.provider,
        model: rt.spec.model,
        think: rt.spec.think,
        agent: rt.name,
        day,
        tick: obs.tick,
        workspaceDir: rt.workspaceDir,
        store: claims,
        daySummary: daySummaries.get(rt.name) ?? [],
        endPosition: obs.player.position,
        board: onBoard,
      });
      reflections.push({ agent: rt.name, day, ...result });
      console.log(
        JSON.stringify({
          reflect: rt.name,
          day,
          events: result.eventsRecorded,
          claims: result.claimsRecorded,
          refuted: result.refuted.length,
          rejected: result.claimsRejected.length,
          downgraded: result.claimsDowngraded.length,
          ms: result.wallMs,
        }),
      );
    }
  }
}

const snap = await runtimes[0]?.client.snapshot();
const finalState = snap?.state ?? stateDigest(island);

writeFileSync(join(runDir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
writeFileSync(join(runDir, "board.json"), JSON.stringify(posts, null, 2) + "\n");
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
      agents: runtimes.map((rt) => ({
        name: rt.name,
        provider: rt.spec.provider,
        model: rt.spec.model,
        think: rt.spec.think,
        capabilities: capabilities.get(rt.name) ?? null,
      })),
      rounds: ROUNDS,
      days: DAYS,
      seededPost: SEED_POST ? SEEDED_FALSE_BELIEF : null,
      node: process.version,
    },
    null,
    2,
  ) + "\n",
);
const claimSnapshot = claims.all();
writeFileSync(
  join(runDir, "memory.json"),
  JSON.stringify(
    {
      claims: claimSnapshot.map((c) => ({
        id: c.id,
        agent: c.agent,
        day: c.day,
        kind: c.kind,
        status: c.status,
        confidence: c.confidence,
        source: c.source,
        evidence: c.evidence,
        text: c.text,
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
  JSON.stringify({ rounds: ROUNDS, days: DAYS, chain: snap?.chain ?? "", terminalState: finalState, invalidTotal }, null, 2) + "\n",
);

await server.close();

console.log(
  JSON.stringify({
    runDir,
    rounds: ROUNDS,
    days: DAYS,
    posts: posts.length,
    claims: claimSnapshot.length,
    invalidTotal,
    wallSeconds: Math.round((performance.now() - startedAt) / 100) / 10,
  }),
);
