/**
 * Agent workspace memory: an append-only episodic log and a rendered semantic view.
 *
 * Both files live in the agent's own workspace and are read by the agent at the start
 * of every session, so they must stay small enough to be useful and honest enough to
 * be trusted:
 *
 *   EPISODIC.jsonl   append-only events. Never rewritten, never deleted.
 *   SEMANTIC.md      rendered from the claim store, never hand-edited.
 *
 * SEMANTIC.md being *generated* rather than authored is the deliberate difference from
 * the source experiment, where agents wrote freeform prose and a judge model had to
 * reconstruct what they knew. Prose is unauditable: an agent can quietly contradict
 * itself, and the researcher cannot tell a correction from a second belief.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Claim, ClaimKind } from "@whisperwind/core";

export interface EpisodicEntry {
  readonly t: number;
  readonly day: number;
  readonly summary: string;
  readonly detail: string;
  /** Ids of claims this event supports or contradicts, if any. */
  readonly claims?: readonly string[];
}

export class MemoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryError";
  }
}

/** Append one event. The log is a file of JSON lines; a torn last line is reported. */
export function appendEpisodic(workspaceDir: string, entry: EpisodicEntry): void {
  if (entry.summary.trim().length === 0) {
    throw new MemoryError("an episodic entry needs a summary; without one it cannot be scanned");
  }
  mkdirSync(workspaceDir, { recursive: true });
  const path = join(workspaceDir, "EPISODIC.jsonl");

  // Refuse to append to a file whose last line is corrupt: silently adding after a torn
  // write would make every later read fail, and the corruption would look like the
  // agent's fault.
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8");
    if (existing.length > 0 && !existing.endsWith("\n")) {
      throw new MemoryError(
        `${path} does not end with a newline; the previous write was interrupted. Repair or truncate it before appending.`,
      );
    }
  }

  appendFileSync(path, JSON.stringify(entry) + "\n", "utf8");
}

export function readEpisodic(workspaceDir: string): readonly EpisodicEntry[] {
  const path = join(workspaceDir, "EPISODIC.jsonl");
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const out: EpisodicEntry[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      out.push(validateEntry(parsed, i + 1));
    } catch (err) {
      if (err instanceof MemoryError) throw err;
      throw new MemoryError(`${path}:${i + 1} is not valid JSON: ${(err as Error).message}`);
    }
  }
  return out;
}

function validateEntry(raw: unknown, line: number): EpisodicEntry {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new MemoryError(`line ${line} is not an object`);
  }
  const rec = raw as Record<string, unknown>;
  const t = rec["t"];
  const day = rec["day"];
  const summary = rec["summary"];
  const detail = rec["detail"];
  if (typeof t !== "number") throw new MemoryError(`line ${line} has no numeric t`);
  if (typeof day !== "number") throw new MemoryError(`line ${line} has no numeric day`);
  if (typeof summary !== "string") throw new MemoryError(`line ${line} has no summary`);
  if (typeof detail !== "string") throw new MemoryError(`line ${line} has no detail`);
  const claims = rec["claims"];
  if (claims !== undefined && !Array.isArray(claims)) {
    throw new MemoryError(`line ${line} has a non-array claims field`);
  }
  return {
    t,
    day,
    summary,
    detail,
    ...(Array.isArray(claims) ? { claims: claims.filter((c): c is string => typeof c === "string") } : {}),
  };
}

/** Newest entries first, for a prompt prefix that mentions recent experience. */
export function recentEpisodic(entries: readonly EpisodicEntry[], limit: number): readonly EpisodicEntry[] {
  return [...entries].reverse().slice(0, limit);
}

const KIND_ORDER: readonly ClaimKind[] = ["verified", "fact", "hypothesis", "mistake"];

const KIND_HEADING: Record<ClaimKind, string> = {
  verified: "Tested, trust it",
  fact: "Stable environmental truth",
  hypothesis: "Unverified; evidence weak",
  mistake: "Believed before, shown wrong",
};

/**
 * Render claims into the agent-facing SEMANTIC.md.
 *
 * Ordered by kind, then by confidence. Retired claims are omitted rather than marked,
 * because a file the agent reads to decide what to do should not present a dead belief
 * as a live option; the history stays in claims.db for analysis.
 */
export function renderSemantic(claims: readonly Claim[], agent: string): string {
  const active = claims.filter((c) => c.agent === agent && c.status === "active");
  const lines: string[] = [
    `# What I Know`,
    "",
    "Generated from my recorded beliefs. Do not edit by hand: correct a belief by",
    "recording that it was refuted, not by deleting the line.",
    "",
  ];

  if (active.length === 0) {
    lines.push("Nothing yet.", "");
    return lines.join("\n");
  }

  for (const kind of KIND_ORDER) {
    const group = active
      .filter((c) => c.kind === kind)
      .sort((a, b) => b.confidence - a.confidence);
    if (group.length === 0) continue;
    lines.push(`## ${kind} — ${KIND_HEADING[kind]}`, "");
    for (const claim of group) {
      const conf = claim.confidence.toFixed(2);
      lines.push(`- (${conf}) ${claim.text}` + sourceSuffix(claim));
    }
    lines.push("");
  }
  return lines.join("\n");
}

function sourceSuffix(claim: Claim): string {
  switch (claim.source.kind) {
    case "self":
      return "";
    case "board":
      return ` [from board post ${claim.source.postId}]`;
    case "agent":
      return ` [from ${claim.source.agent}'s claim ${claim.source.claimId}]`;
    default:
      return "";
  }
}

export function writeSemantic(workspaceDir: string, claims: readonly Claim[], agent: string): string {
  mkdirSync(workspaceDir, { recursive: true });
  const path = join(workspaceDir, "SEMANTIC.md");
  const text = renderSemantic(claims, agent);
  writeFileSync(path, text, "utf8");
  return text;
}

/** The workspace's memory, as the agent sees it at session start. */
export interface MemorySnapshot {
  readonly semantic: string;
  readonly recent: readonly EpisodicEntry[];
  readonly episodeCount: number;
}

export function loadMemory(workspaceDir: string, claims: readonly Claim[], agent: string, recentLimit = 20): MemorySnapshot {
  const entries = readEpisodic(workspaceDir);
  return {
    semantic: renderSemantic(claims, agent),
    recent: recentEpisodic(entries, recentLimit),
    episodeCount: entries.length,
  };
}
