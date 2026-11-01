import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseYaml, YamlError } from "@whisperwind/core";

test("parses the real models.yaml into the shape the orchestrator expects", () => {
  const path = fileURLToPath(new URL("../../../worlds/island/models.yaml", import.meta.url));
  const doc = parseYaml(readFileSync(path, "utf8"));

  assert.ok(doc.providers && typeof doc.providers === "object" && !Array.isArray(doc.providers));
  const providers = doc.providers;
  assert.ok("ollama" in providers && "llamacpp" in providers);
  const ollama = providers["ollama"];
  assert.ok(ollama && typeof ollama === "object" && !Array.isArray(ollama));
  assert.equal(ollama["kind"], "ollama");
  assert.equal(ollama["baseUrl"], "http://127.0.0.1:11434");

  assert.ok(Array.isArray(doc.agents));
  assert.equal(doc.agents.length, 3);
  const first = doc.agents[0];
  assert.ok(first && typeof first === "object" && !Array.isArray(first));
  assert.equal(first["name"], "A");
  assert.equal(first["model"], "glm-5.2:cloud");
  assert.equal(first["think"], false);
});

test("handles nested maps, sequences of maps, and scalars", () => {
  const doc = parseYaml(`
# leading comment
top: value
nested:
  a: 1
  b: two
list:
  - name: x
    n: 2
  - name: y
    n: 3
flag: true
empty:
quoted: "has: colon # not comment"
`);
  assert.equal(doc["top"], "value");
  assert.deepEqual(doc["nested"], { a: 1, b: "two" });
  assert.deepEqual(doc["list"], [
    { name: "x", n: 2 },
    { name: "y", n: 3 },
  ]);
  assert.equal(doc["flag"], true);
  assert.equal(doc["empty"], null);
  assert.equal(doc["quoted"], "has: colon # not comment");
});

test("a '#' inside a URL is not treated as a comment", () => {
  const doc = parseYaml("baseUrl: http://host:1234/path#frag");
  assert.equal(doc["baseUrl"], "http://host:1234/path#frag");
});

test("rejects unsupported constructs loudly rather than mis-parsing", () => {
  assert.throws(() => parseYaml("a: {b: 1}"), YamlError);
  assert.throws(() => parseYaml("a: |\n  text"), YamlError);
  assert.throws(() => parseYaml("a: &anchor 1"), YamlError);
  const err = (() => {
    try {
      parseYaml("a: {b: 1}");
    } catch (e) {
      return e;
    }
    return null;
  })();
  assert.ok(err instanceof YamlError);
  assert.equal(err.line, 1);
});

test("does not silently accept a line that is not key: value", () => {
  assert.throws(() => parseYaml("just a bare line"), YamlError);
});
