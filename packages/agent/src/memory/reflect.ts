/**
 * Reflection: the agent consolidates a day's experience into its memory.
 *
 * Deliberately *not* per-action. Writing memory after every action doubles the request
 * count and produces a log nobody reads, whereas the source experiment found that a
 * consolidation pass before each reset is what carried knowledge across sessions.
 *
 * Implemented as schema-constrained extraction, not a tool loop. Measured: asking a
 * model to record beliefs through tools produced narration ("I will record two
 * beliefs") without calling anything, because claim extraction is a structured
 * transform rather than an agentic decision. Constrained JSON produced valid claims on
 * every model tested.
 *
 * Both `tools` and `format` are sent. Measured earlier: `format` alone is ignored by one
 * model, and `tools` alone does not enforce the schema.
 */

import type { Claim, ClaimKind, ClaimSource } from "@whisperwind/core";
import { CLAIM_KINDS } from "@whisperwind/core";

import type { Provider } from "../provider.ts";
import { asRecord } from "../provider.ts";
import type { ClaimStore } from "./claims.ts";
import { appendEpisodic, readEpisodic } from "./files.ts";

export interface BoardItem {
  readonly id: string;
  readonly agent: string;
  readonly content: string;
}

export interface ReflectInput {
  readonly provider: Provider;
  readonly model: string;
  readonly think: boolean;
  readonly agent: string;
  readonly day: number;
  readonly tick: number;
  readonly workspaceDir: string;
  readonly store: ClaimStore;
  /** What happened to this agent today, in its own words or the run's. */
  readonly daySummary: readonly string[];
  /** Where it ended the day. Never recorded as a belief: it is transient. */
  readonly endPosition: readonly [number, number, number];
  readonly board: readonly BoardItem[];
  readonly maxRepairs?: number;
}

export interface ReflectResult {
  readonly eventsRecorded: number;
  readonly claimsRecorded: number;
  readonly claimsRejected: readonly string[];
  /** Claims recorded as weaker than asserted, because no evidence was cited. */
  readonly claimsDowngraded: readonly string[];
  readonly refuted: readonly string[];
  readonly wallMs: number;
  readonly repaired: boolean;
  /** False when the model never produced a valid extraction. */
  readonly ok: boolean;
}

/** The extraction schema. Deliberately flat and closed. */
export const REFLECT_SCHEMA = {
  type: "object",
  properties: {
    events: {
      type: "array",
      maxItems: 6,
      items: {
        type: "object",
        properties: {
          summary: { type: "string", maxLength: 160 },
          detail: { type: "string", maxLength: 600 },
        },
        required: ["summary", "detail"],
        additionalProperties: false,
      },
    },
    claims: {
      type: "array",
      maxItems: 6,
      items: {
        type: "object",
        properties: {
          text: { type: "string", maxLength: 300 },
          kind: { type: "string", enum: [...CLAIM_KINDS] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          evidence: { type: "array", items: { type: "string" }, maxItems: 4 },
          fromAgent: { type: "string" },
          fromClaim: { type: "string" },
        },
        required: ["text", "kind", "confidence", "evidence"],
        additionalProperties: false,
      },
    },
    refute: {
      type: "array",
      maxItems: 6,
      items: { type: "string" },
    },
  },
  required: ["events", "claims"],
  additionalProperties: false,
} as const;

const SYSTEM = [
  "You are consolidating a day on an island into memory, for a future self that wakes",
  "with none of today's context. Extract two things and return them as JSON.",
  "",
  "events: what happened today. One line per distinct thing worth remembering. Do not",
  "narrate step by step, and do not record your current position: it is transient.",
  "",
  "claims: what you now believe about this world, durable enough to act on tomorrow.",
  "For each, set kind to verified (you tested it), fact (stable and observed),",
  "hypothesis (unverified), or mistake (you believed it and it proved wrong).",
  "",
  "evidence: what you actually observed that supports it.",
  "",
  "If you took a belief from the board instead of working it out, set fromClaim to the",
  "exact post id shown on the board (for example post_1) and leave evidence empty. If",
  "you took it from another agent's claim, set fromAgent and fromClaim to ids that",
  "appear above. Never present a borrowed belief as your own discovery: a cite that",
  "does not exist is rejected.",
  "",
  "refute: ids of YOUR OWN earlier claims that today showed to be wrong. Use the exact",
  "id in brackets above. Do not write a new claim to say an old one was wrong; refute it.",
  "",
  "If today taught you nothing durable, return empty arrays. That is a valid answer.",
].join("\n");

interface ParsedClaim {
  readonly text: string;
  readonly kind: ClaimKind;
  readonly confidence: number;
  readonly evidence: readonly string[];
  readonly fromAgent: string | null;
  readonly fromClaim: string | null;
}

interface Parsed {
  readonly events: readonly { summary: string; detail: string }[];
  readonly claims: readonly ParsedClaim[];
  readonly refute: readonly string[];
}

function isClaimKind(v: string): v is ClaimKind {
  return (CLAIM_KINDS as readonly string[]).includes(v);
}

/** Parse and validate the extraction. Returns the parsed value or a model-facing error. */
export function parseExtraction(value: unknown): Parsed | string {
  const rec = asRecord(value);
  if (!rec) return "response was not a JSON object";

  const rawEvents = rec["events"];
  if (!Array.isArray(rawEvents)) return 'missing "events" array';
  const events: { summary: string; detail: string }[] = [];
  for (const raw of rawEvents) {
    const e = asRecord(raw);
    if (!e) return "an event is not an object";
    const summary = e["summary"];
    const detail = e["detail"];
    if (typeof summary !== "string" || typeof detail !== "string") {
      return "an event needs summary and detail strings";
    }
    if (summary.trim().length > 0) events.push({ summary, detail });
  }

  const rawClaims = rec["claims"];
  if (!Array.isArray(rawClaims)) return 'missing "claims" array';
  const claims: ParsedClaim[] = [];
  for (const raw of rawClaims) {
    const c = asRecord(raw);
    if (!c) return "a claim is not an object";
    const text = c["text"];
    const kind = c["kind"];
    const confidence = c["confidence"];
    if (typeof text !== "string" || text.trim().length === 0) return "a claim needs text";
    if (typeof kind !== "string" || !isClaimKind(kind)) {
      return `claim kind must be one of ${CLAIM_KINDS.join(", ")}`;
    }
    if (typeof confidence !== "number" || confidence < 0 || confidence > 1) {
      return "claim confidence must be a number between 0 and 1";
    }
    const rawEvidence = c["evidence"];
    const evidence = Array.isArray(rawEvidence)
      ? rawEvidence.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      : [];
    const fromAgent = c["fromAgent"];
    const fromClaim = c["fromClaim"];
    claims.push({
      text: text.trim(),
      kind,
      confidence,
      evidence,
      fromAgent: typeof fromAgent === "string" && fromAgent.length > 0 ? fromAgent : null,
      fromClaim: typeof fromClaim === "string" && fromClaim.length > 0 ? fromClaim : null,
    });
  }

  const rawRefute = rec["refute"];
  const refute = Array.isArray(rawRefute)
    ? rawRefute.filter((x): x is string => typeof x === "string")
    : [];

  return { events, claims, refute };
}

export async function reflect(input: ReflectInput): Promise<ReflectResult> {
  const started = performance.now();
  const maxRepairs = input.maxRepairs ?? 1;

  const episodes = readEpisodic(input.workspaceDir);
  const existing: readonly Claim[] = input.store.byAgent(input.agent);

  const userContent = [
    `Day ${input.day}.`,
    "",
    "## What happened today",
    "",
    input.daySummary.length > 0 ? input.daySummary.map((s) => `- ${s}`).join("\n") : "- (nothing notable)",
    "",
    "## What you already believe (with the ids you must cite to refute)",
    "",
    existing.length > 0
      ? existing
          .filter((c) => c.status === "active")
          .map((c) => `- [${c.id}] (${c.kind}, ${c.confidence.toFixed(2)}) ${c.text}`)
          .join("\n") || "Nothing yet."
      : "Nothing yet.",
    "",
    "## Your earlier episode summaries",
    "",
    episodes.length > 0
      ? episodes.slice(-10).map((e) => `- (day ${e.day}) ${e.summary}`).join("\n")
      : "Nothing recorded yet.",
    "",
    "## Where you ended the day",
    "",
    `position ${JSON.stringify(input.endPosition)} — do not record this, it is transient.`,
    "",
    "## The board",
    "",
    input.board.length > 0
      ? input.board.map((p) => `- (${p.id}, by ${p.agent}) ${p.content}`).join("\n")
      : "Nothing on it.",
  ].join("\n");

  const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: userContent },
  ];

  let parsed: Parsed | null = null;
  let repaired = false;
  let lastError = "";

  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    const res = await input.provider.chat({
      model: input.model,
      think: input.think,
      messages,
      schema: REFLECT_SCHEMA,
      tools: [
        { type: "function", function: { name: "consolidate", parameters: REFLECT_SCHEMA } },
      ],
    });

    const outcome = parseExtraction(res.value);
    if (typeof outcome !== "string") {
      parsed = outcome;
      break;
    }
    lastError = outcome;
    messages.push({ role: "assistant", content: res.text.slice(0, 600) });
    messages.push({
      role: "user",
      content: `That was not valid: ${outcome}. Return JSON with "events" and "claims" arrays as specified.`,
    });
    repaired = true;
  }

  if (!parsed) {
    return {
      eventsRecorded: 0,
      claimsRecorded: 0,
      claimsRejected: [lastError],
      claimsDowngraded: [],
      refuted: [],
      wallMs: Math.round(performance.now() - started),
      repaired,
      ok: false,
    };
  }

  for (const event of parsed.events) {
    appendEpisodic(input.workspaceDir, {
      t: input.tick,
      day: input.day,
      summary: event.summary,
      detail: event.detail,
    });
  }

  const rejected: string[] = [];
  const downgraded: string[] = [];
  let recorded = 0;

  // Resolve provenance by what the id actually refers to, not by which fields the model
  // filled in. Models routinely write `fromAgent: "B"` next to a board post id, which
  // is a correct description of the source and would be wrongly rejected if the code
  // assumed that pair always means a claim.
  const boardIds = new Set(input.board.map((b) => b.id));
  const resolveSource = (claim: ParsedClaim): ClaimSource | string => {
    const cite = claim.fromClaim;
    if (!cite) return { kind: "self" };
    if (boardIds.has(cite)) return { kind: "board", postId: cite };
    const existingClaim = input.store.get(cite);
    if (existingClaim) {
      return { kind: "agent", agent: claim.fromAgent ?? existingClaim.agent, claimId: cite };
    }
    return `source ${cite} is neither a board post on the board nor a known claim id`;
  };

  for (const claim of parsed.claims) {
    const resolved = resolveSource(claim);
    if (typeof resolved === "string") {
      rejected.push(`${claim.text.slice(0, 60)}: ${resolved}`);
      continue;
    }
    const source = resolved;

    try {
      const stored = input.store.add({
        agent: input.agent,
        day: input.day,
        text: claim.text,
        kind: claim.kind,
        confidence: claim.confidence,
        source,
        // A self-sourced claim with no evidence is rejected by the store. That is the
        // point at which confabulation shows up, so the reason is kept.
        evidence: claim.evidence,
        createdTick: input.tick,
      });
      if (stored.kind !== claim.kind) {
        downgraded.push(`${claim.text.slice(0, 60)}: asked ${claim.kind}, stored ${stored.kind} (no evidence cited)`);
      }
      recorded++;
    } catch (err) {
      rejected.push(`${claim.text.slice(0, 60)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const refuted: string[] = [];
  for (const id of parsed.refute) {
    try {
      const claim = input.store.get(id);
      if (claim && claim.agent === input.agent && claim.status === "active") {
        input.store.retire(id, "refuted", input.tick);
        refuted.push(id);
      }
    } catch {
      // An unknown or already-retired id is the model's mistake, not a run failure.
    }
  }

  return {
    eventsRecorded: parsed.events.length,
    claimsRecorded: recorded,
    claimsRejected: rejected,
    claimsDowngraded: downgraded,
    refuted,
    wallMs: Math.round(performance.now() - started),
    repaired,
    ok: true,
  };
}
