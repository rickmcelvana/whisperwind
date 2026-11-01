/**
 * OpenAI-compatible provider: llama.cpp, vLLM, any hosted API.
 *
 * No `think` flag exists on this surface, so `think` is ignored rather than sent as a
 * guessed parameter. Schema-constrained decoding goes through `response_format`.
 */

import type { Capabilities, ChatResponse } from "@whisperwind/core";

import {
  type ChatOptions,
  type Provider,
  type ProviderConfig,
  asRecord,
  readNumber,
  readString,
  stripFence,
} from "./provider.ts";

export class OpenAIProvider implements Provider {
  readonly kind = "openai" as const;
  readonly baseUrl: string;
  private readonly apiKey: string | undefined;

  constructor(config: ProviderConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.apiKey = config.apiKey;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) h["authorization"] = `Bearer ${this.apiKey}`;
    return h;
  }

  async chat(opts: ChatOptions): Promise<ChatResponse> {
    const started = performance.now();

    const body: Record<string, unknown> = {
      model: opts.model,
      messages: opts.messages,
      stream: false,
    };
    if (opts.maxTokens) body["max_tokens"] = opts.maxTokens;
    if (opts.schema) {
      body["response_format"] = {
        type: "json_schema",
        json_schema: { name: "action", schema: opts.schema, strict: true },
      };
    }
    if (opts.tools) body["tools"] = opts.tools;

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`openai-compatible ${res.status}: ${text.slice(0, 300)}`);

    const parsed = asRecord(JSON.parse(text) as unknown);
    const choices = parsed ? parsed["choices"] : undefined;
    const first = Array.isArray(choices) ? asRecord(choices[0]) : null;
    const message = first ? asRecord(first["message"]) : null;

    let value: unknown = null;
    let content = "";
    if (message) {
      content = readString(message, "content") ?? "";
      const calls = message["tool_calls"];
      if (Array.isArray(calls) && calls.length > 0) {
        const call = asRecord(calls[0]);
        const fn = call ? asRecord(call["function"]) : null;
        const args = fn ? fn["arguments"] : undefined;
        if (typeof args === "string") {
          try {
            value = JSON.parse(args);
          } catch {
            value = args;
          }
        } else {
          value = args;
        }
      } else {
        const cleaned = stripFence(content);
        try {
          value = JSON.parse(cleaned);
        } catch {
          value = cleaned;
        }
      }
    }

    const usage = parsed ? asRecord(parsed["usage"]) : null;
    const promptTokens = usage ? readNumber(usage, "prompt_tokens") : undefined;
    const completionTokens = usage ? readNumber(usage, "completion_tokens") : undefined;

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
    try {
      const base = await this.chat({
        model,
        messages: [{ role: "user", content: "Return one action: stop at [0,0,0]." }],
      });
      responds = base.text.length > 0 || base.value !== null;
    } catch {
      return {
        responds: false,
        tools: false,
        schema: false,
        thinking: false,
        streaming: false,
        probeMs: performance.now() - started,
      };
    }

    try {
      const withSchema = await this.chat({
        model,
        schema,
        messages: [{ role: "user", content: "Return one action: stop at [0,0,0]." }],
      });
      const v = asRecord(withSchema.value);
      schemaOk = v !== null && v["type"] === "Stop";
    } catch {
      schemaOk = false;
    }

    return {
      responds,
      tools: schemaOk,
      schema: schemaOk,
      thinking: false,
      streaming: false,
      probeMs: performance.now() - started,
    };
  }
}
