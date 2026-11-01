/**
 * Memory tools exposed to the agent, and the prompt assembled from them.
 *
 * The tools are the agent's only way to change its own memory, which keeps the schema
 * enforceable. An agent cannot invent a belief with no evidence, cannot cite a claim
 * that does not exist, and cannot silently delete a belief it now rejects: it records
 * the refutation, and the history stays for analysis.
 */

import {
  CLAIM_KINDS,
  type Claim,
  type ClaimKind,
  type ClaimSource,
} from "@whisperwind/core";

import type { ClaimStore } from "./claims.ts";
import { appendEpisodic, type EpisodicEntry, renderSemantic } from "./files.ts";

export const MEMORY_TOOL_NAMES = ["remember_event", "remember_claim", "refute_claim"] as const;
export type MemoryToolName = (typeof MEMORY_TOOL_NAMES)[number];

export interface ToolOutcome {
  readonly ok: boolean;
  /** Model-facing text. On failure this is the validator's reason, which the agent can act on. */
  readonly message: string;
  readonly claimId?: string;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

function parseSource(raw: unknown): ClaimSource | string {
  if (raw === undefined || raw === null) return { kind: "self" };
  const rec = asRecord(raw);
  if (!rec) return "source must be an object";
  const kind = rec["kind"];
  switch (kind) {
    case "self":
      return { kind: "self" };
    case "board": {
      const postId = rec["postId"];
      if (typeof postId !== "string" || postId.length === 0) return "a board source needs postId";
      return { kind: "board", postId };
    }
    case "agent": {
      const agent = rec["agent"];
      const claimId = rec["claimId"];
      if (typeof agent !== "string" || typeof claimId !== "string") {
        return "an agent source needs agent and claimId";
      }
      return { kind: "agent", agent, claimId };
    }
    default:
      return `unknown source kind ${JSON.stringify(kind)}; use self, board or agent`;
  }
}

export interface MemoryContext {
  readonly store: ClaimStore;
  readonly agent: string;
  readonly workspaceDir: string;
  readonly day: number;
  readonly tick: number;
}

/**
 * Run a memory tool. Returns an outcome rather than throwing: a rejected claim is
 * information the agent needs, not a crash.
 */
export function runMemoryTool(ctx: MemoryContext, tool: string, args: unknown): ToolOutcome {
  const rec = asRecord(args);
  if (!rec) return { ok: false, message: "arguments must be an object" };

  switch (tool) {
    case "remember_event": {
      const summary = rec["summary"];
      const detail = rec["detail"];
      if (typeof summary !== "string") return { ok: false, message: "event needs a summary string" };
      if (typeof detail !== "string") return { ok: false, message: "event needs a detail string" };
      const entry: EpisodicEntry = {
        t: ctx.tick,
        day: ctx.day,
        summary,
        detail,
      };
      try {
        appendEpisodic(ctx.workspaceDir, entry);
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
      return { ok: true, message: "recorded" };
    }

    case "remember_claim": {
      const text = rec["text"];
      const kindRaw = rec["kind"];
      if (typeof text !== "string" || text.trim().length === 0) {
        return { ok: false, message: "a claim needs text" };
      }
      if (typeof kindRaw !== "string" || !(CLAIM_KINDS as readonly string[]).includes(kindRaw)) {
        return { ok: false, message: `kind must be one of ${CLAIM_KINDS.join(", ")}` };
      }
      const source = parseSource(rec["source"]);
      if (typeof source === "string") return { ok: false, message: source };

      const confidenceRaw = rec["confidence"];
      const confidence = typeof confidenceRaw === "number" ? confidenceRaw : 0.5;

      const evidenceRaw = rec["evidence"];
      const evidence = Array.isArray(evidenceRaw)
        ? evidenceRaw.filter((e): e is string => typeof e === "string")
        : [];

      try {
        const claim = ctx.store.add({
          agent: ctx.agent,
          day: ctx.day,
          text,
          kind: kindRaw as ClaimKind,
          confidence,
          source,
          evidence,
          createdTick: ctx.tick,
        });
        return { ok: true, message: `recorded as ${claim.id}`, claimId: claim.id };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    }

    case "refute_claim": {
      const id = rec["id"];
      if (typeof id !== "string") return { ok: false, message: "refute needs the claim id" };
      const existing = ctx.store.get(id);
      if (!existing) return { ok: false, message: `no claim ${id}` };
      if (existing.agent !== ctx.agent) {
        // An agent may hold a belief it took from another, but it may only retire its
        // own record of it. Otherwise one agent could rewrite another's history.
        return { ok: false, message: `claim ${id} belongs to ${existing.agent}, not you` };
      }
      try {
        ctx.store.retire(id, "refuted", ctx.tick);
        return { ok: true, message: `refuted ${id}` };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    }

    default:
      return { ok: false, message: `unknown memory tool ${tool}` };
  }
}

export interface PromptInput {
  readonly agent: string;
  readonly day: number;
  readonly soul: string;
  readonly claims: readonly Claim[];
  readonly recentEvents: readonly string[];
  /** Board posts visible to everyone, newest last. */
  readonly board: readonly { readonly id: string; readonly agent: string; readonly content: string }[];
}

/**
 * Assemble the prompt.
 *
 * Ordered stable-prefix first: the soul and the semantic memory change rarely, while
 * the observation arrives in the volatile tail. Measured prompt caching on this
 * hardware hit 4725/4729 tokens on a repeat, so ordering is worth designing for.
 */
export function buildPrompt(input: PromptInput): string {
  const semantic = renderSemantic(input.claims, input.agent);
  const parts: string[] = [];

  parts.push(input.soul.trim());

  parts.push(
    [
      "",
      "## Your memory",
      "",
      semantic.trim(),
      "",
      "## Recently, in your own words",
      "",
      input.recentEvents.length > 0 ? input.recentEvents.map((e) => `- ${e}`).join("\n") : "Nothing recorded yet.",
    ].join("\n"),
  );

  parts.push(
    [
      "",
      "## The board",
      "",
      input.board.length > 0
        ? input.board.map((p) => `- (${p.id}, by ${p.agent}) ${p.content}`).join("\n")
        : "Nobody has written on it.",
    ].join("\n"),
  );

  parts.push(
    [
      "",
      "## Today",
      "",
      `Day ${input.day}. There is no objective, no score, and no win condition.`,
      "",
    ].join("\n"),
  );

  return parts.join("\n");
}

/** Tool schemas, sent to the provider alongside the action schema. */
export const MEMORY_TOOLS: readonly object[] = [
  {
    type: "function",
    function: {
      name: "remember_event",
      description: "Append one thing that happened to your episodic log.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", maxLength: 120 },
          detail: { type: "string", maxLength: 600 },
        },
        required: ["summary", "detail"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remember_claim",
      description:
        "Record a belief for future sessions. Cite the evidence for a belief you formed yourself; cite the claim id or board post when you took it from somewhere.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", maxLength: 300 },
          kind: { type: "string", enum: [...CLAIM_KINDS] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          source: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["self", "board", "agent"] },
              postId: { type: "string" },
              agent: { type: "string" },
              claimId: { type: "string" },
            },
            required: ["kind"],
            additionalProperties: false,
          },
          evidence: { type: "array", items: { type: "string" } },
        },
        required: ["text", "kind"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "refute_claim",
      description: "Mark one of your own beliefs as shown wrong. The record is kept, not deleted.",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
];
