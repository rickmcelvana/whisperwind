/**
 * Live provider tests. These hit real endpoints and are skipped when they are not
 * reachable, so `npm test` still passes on a machine without them.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createProvider } from "@whisperwind/agent";
import { ACTION_SCHEMA, validateDecision } from "@whisperwind/agent";

const OLLAMA = process.env["OLLAMA_URL"] ?? "http://127.0.0.1:11434";

async function reachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

const ollamaUp = await reachable(`${OLLAMA}/api/version`);

test("validation rejects the exact malformed shapes measured in the wild", () => {
  // gemma4 returned this with the required field missing, and no layer raised an error.
  const missingType = validateDecision({ position: [2, 1, 3] });
  assert.equal(missingType.ok, false);
  assert.match(missingType.error ?? "", /actions|type/);

  // gemma4 also invented an enum member.
  const badEnum = validateDecision({ type: "move_to_ring", position: [2, 1, 3] });
  assert.equal(badEnum.ok, false);
  assert.match(badEnum.error ?? "", /unknown action type/);

  // glm returned prose plus a differently-shaped object.
  const prose = validateDecision({ act: "MoveTo", p: [0, 1, 5] });
  assert.equal(prose.ok, false);

  // No layer should accept an empty list as a decision.
  assert.equal(validateDecision({ actions: [] }).ok, false);
});

test("validation accepts both documented reply shapes", () => {
  const wrapped = validateDecision({ actions: [{ type: "Jump" }] });
  assert.equal(wrapped.ok, true);
  assert.deepEqual(wrapped.actions, [{ type: "Jump" }]);

  const bare = validateDecision({ type: "MoveTo", position: [1, 2, 3] });
  assert.equal(bare.ok, true);
  assert.deepEqual(bare.actions, [{ type: "MoveTo", position: [1, 2, 3] }]);

  const seq = validateDecision({
    actions: [
      { type: "MoveTo", position: [1, 5, 1] },
      { type: "Pickup", position: [1, 1.5, 1] },
      { type: "Throw", direction: [1, 1, 0], speed: 6 },
    ],
  });
  assert.equal(seq.ok, true);
  assert.equal(seq.actions.length, 3);
});

test("validation rejects malformed fields rather than coercing them", () => {
  assert.equal(validateDecision({ type: "MoveTo", position: [1, 2] }).ok, false);
  assert.equal(validateDecision({ type: "MoveTo", position: "here" }).ok, false);
  assert.equal(validateDecision({ type: "Throw", direction: [1, 1, 0] }).ok, false);
  assert.equal(validateDecision({ type: "Throw", direction: [1, 1, 0], speed: "fast" }).ok, false);
});

test("ollama provider produces schema-valid decisions", { skip: !ollamaUp }, async () => {
  // Sampled rather than single-shot. Measured: the same model occasionally returns a
  // non-conforming action even with tools+format, so a one-sample assertion fails
  // intermittently. Three samples with a majority requirement tests the path without
  // turning model noise into a red suite.
  const provider = createProvider({ kind: "ollama", baseUrl: OLLAMA });
  const samples: boolean[] = [];
  const errors: string[] = [];

  for (let i = 0; i < 3; i++) {
    const res = await provider.chat({
      model: "qwen3.5:9b",
      think: false,
      schema: ACTION_SCHEMA,
      tools: [{ type: "function", function: { name: "act", parameters: ACTION_SCHEMA } }],
      messages: [
        { role: "system", content: "You are a body on an island. Decide one action." },
        { role: "user", content: "You are at [0,5,0]. A cube is at [3,1.5,6]. Act." },
      ],
    });
    const decision = validateDecision(res.value);
    samples.push(decision.ok);
    if (!decision.ok) errors.push(res.text.slice(0, 120));
  }

  const valid = samples.filter(Boolean).length;
  assert.ok(valid >= 2, `only ${valid}/3 valid decisions; samples: ${errors.join(" | ")}`);
});

test("the capability probe reports what this model actually does", { skip: !ollamaUp }, async () => {
  const provider = createProvider({ kind: "ollama", baseUrl: OLLAMA });
  const caps = await provider.probe("qwen3.5:9b");

  assert.equal(caps.responds, true);
  assert.equal(caps.schema, true, "tools+format should yield a schema-valid action");
  assert.equal(caps.thinking, true, "qwen3.5 emits a thinking field on native /api/chat");
  assert.ok(caps.probeMs > 0);
});

test("thinking off is dramatically cheaper than thinking on", { skip: !ollamaUp }, async () => {
  const provider = createProvider({ kind: "ollama", baseUrl: OLLAMA });
  const prompt = [{ role: "user" as const, content: "Reply with one word: hello" }];

  const on = await provider.chat({ model: "qwen3.5:9b", think: true, messages: prompt, maxTokens: 512 });
  const off = await provider.chat({ model: "qwen3.5:9b", think: false, messages: prompt, maxTokens: 512 });

  assert.equal((off.completionTokens ?? 0) > 0, true);
  // Measured ratio was ~180x in tokens; require only that off is clearly cheaper.
  assert.ok(
    (off.completionTokens ?? 0) < (on.completionTokens ?? 0),
    `thinking off should use fewer tokens: off=${off.completionTokens} on=${on.completionTokens}`,
  );
});
