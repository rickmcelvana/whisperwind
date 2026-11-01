/**
 * Provider abstraction.
 *
 * One interface over Ollama (locals and `:cloud` models), any OpenAI-compatible
 * endpoint, and future providers. Nothing here may assume a specific model.
 *
 * Behaviours measured on this hardware and encoded below (plan §5.1, §5.5):
 * - Ollama's `think` flag only works on the native `/api/chat` endpoint; `/v1`
 *   accepts and ignores it (937 tokens / 13.9 s versus 2 tokens / 0.31 s).
 * - Ollama cloud models can return NDJSON even with `stream:false`.
 * - `tools` alone does not enforce a schema: one model emitted a missing required
 *   field in 8/8 samples without raising an error.
 * - `format` alone is ignored by another model, which answers in prose.
 * - Sending both is the only combination measured to work on every model here.
 */

import type { Capabilities, ChatRequest, ChatResponse } from "@whisperwind/core";

export type ProviderKind = "ollama" | "openai";

export interface ProviderConfig {
  readonly kind: ProviderKind;
  readonly baseUrl: string;
  readonly apiKey?: string;
}

export interface ChatOptions extends ChatRequest {
  readonly model: string;
}

export interface Provider {
  readonly kind: ProviderKind;
  readonly baseUrl: string;
  chat(opts: ChatOptions): Promise<ChatResponse>;
  /** Cheap single request establishing what this model actually does. */
  probe(model: string): Promise<Capabilities>;
}

/** Strip a markdown code fence if the model wrapped its JSON. */
export function stripFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
}

/**
 * Parse a response body that may be a single JSON object or newline-delimited JSON
 * frames (observed from Ollama cloud models with `stream:false`).
 */
export function parseMaybeNdjson(text: string): unknown[] {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const objects: unknown[] = [];
  for (const line of lines) {
    try {
      objects.push(JSON.parse(line));
    } catch {
      // A partially written frame is a real failure, not something to guess at.
      throw new Error(`unparseable response line: ${line.slice(0, 120)}`);
    }
  }
  return objects;
}

/** Narrow an unknown to a record without casting. */
export function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function readNumber(rec: Record<string, unknown>, key: string): number | undefined {
  const v = rec[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function readString(rec: Record<string, unknown>, key: string): string | undefined {
  const v = rec[key];
  return typeof v === "string" ? v : undefined;
}

export { readNumber, readString };
