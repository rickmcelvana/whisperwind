/**
 * Ollama provider. Always uses the native `/api/chat` endpoint, because that is the
 * only one where `think` is honoured.
 */

import type { Capabilities, ChatResponse } from "@whisperwind/core";

import {
  type ChatOptions,
  type Provider,
  type ProviderConfig,
  asRecord,
  parseMaybeNdjson,
  readNumber,
  readString,
  stripFence,
} from "./provider.ts";

export class OllamaProvider implements Provider {
  readonly kind = "ollama" as const;
  readonly baseUrl: string;

  constructor(config: Pick<ProviderConfig, "baseUrl">) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
  }

  private async post(path: string, body: unknown): Promise<{ status: number; text: string }> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, text: await res.text() };
  }

  async chat(opts: ChatOptions): Promise<ChatResponse> {
    const started = performance.now();

    const body: Record<string, unknown> = {
      model: opts.model,
      messages: opts.messages,
      stream: false,
      think: opts.think ?? false,
      options: opts.maxTokens ? { num_predict: opts.maxTokens } : {},
    };
    // Both together: `tools` alone does not enforce the schema, `format` alone is
    // ignored by some models. Measured in plan §5.5.
    if (opts.schema) body["format"] = opts.schema;
    if (opts.tools) body["tools"] = opts.tools;

    const { status, text } = await this.post("/api/chat", body);
    if (status !== 200) {
      throw new Error(`ollama ${status}: ${text.slice(0, 300)}`);
    }

    const frames = parseMaybeNdjson(text);
    let content = "";
    let toolArgs: unknown = undefined;
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;

    for (const frame of frames) {
      const rec = asRecord(frame);
      if (!rec) continue;
      const message = asRecord(rec["message"]);
      if (message) {
        content += readString(message, "content") ?? "";
        const calls = message["tool_calls"];
        if (Array.isArray(calls) && calls.length > 0) {
          const first = asRecord(calls[0]);
          const fn = first ? asRecord(first["function"]) : null;
          if (fn) toolArgs = fn["arguments"];
        }
      }
      if (rec["error"]) throw new Error(`ollama error: ${String(rec["error"])}`);
      promptTokens = readNumber(rec, "prompt_eval_count") ?? promptTokens;
      completionTokens = readNumber(rec, "eval_count") ?? completionTokens;
      const cached = readNumber(rec, "prompt_eval_cached_count");
      if (cached !== undefined) promptTokens = promptTokens;
    }

    const value = toolArgs ?? parseContent(content);

    return {
      value,
      text: content,
      ...(promptTokens !== undefined ? { promptTokens } : {}),
      ...(completionTokens !== undefined ? { completionTokens } : {}),
      ms: performance.now() - started,
      repaired: false,
    };
  }

  async probe(model: string): Promise<Capabilities> {
    const started = performance.now();
    const schema = {
      type: "object",
      properties: {
        type: { type: "string", enum: ["Stop"] },
        position: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
      },
      required: ["type", "position"],
      additionalProperties: false,
    };

    let responds = false;
    let schemaOk = false;
    let toolsOk = false;
    let thinking = false;

    try {
      const base = await this.chat({
        model,
        messages: [{ role: "user", content: "Return one action: stop at [0,0,0]." }],
      });
      responds = base.text.length > 0 || base.value !== null;
    } catch {
      return { responds: false, tools: false, schema: false, thinking: false, streaming: true, probeMs: performance.now() - started };
    }

    try {
      const withSchema = await this.chat({
        model,
        schema,
        tools: [{ type: "function", function: { name: "act", parameters: schema } }],
        messages: [{ role: "user", content: "Return one action: stop at [0,0,0]." }],
      });
      const v = asRecord(withSchema.value);
      schemaOk = v !== null && v["type"] === "Stop";
      toolsOk = schemaOk;
    } catch {
      schemaOk = false;
    }

    try {
      const thinkingRes = await this.post("/api/chat", {
        model,
        stream: false,
        think: true,
        messages: [{ role: "user", content: "Think briefly." }],
        options: { num_predict: 64 },
      });
      const frames = parseMaybeNdjson(thinkingRes.text);
      const first = asRecord(frames[0]);
      const message = first ? asRecord(first["message"]) : null;
      const thinkText = message ? readString(message, "thinking") : undefined;
      thinking = (thinkText ?? "").length > 0;
    } catch {
      thinking = false;
    }

    return {
      responds,
      tools: toolsOk,
      schema: schemaOk,
      thinking,
      streaming: true,
      probeMs: performance.now() - started,
    };
  }
}

/** Parse content that should be JSON, tolerating a code fence. */
export function parseContent(content: string): unknown {
  const cleaned = stripFence(content);
  if (!cleaned) return null;
  try {
    return JSON.parse(cleaned);
  } catch {
    return cleaned;
  }
}
