import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ClaimStore, reflect, readEpisodic } from "@whisperwind/agent";
import type { Capabilities, ChatResponse } from "@whisperwind/core";
import type { Provider } from "@whisperwind/agent";

/**
 * A provider that replays canned replies, so reflection can be tested without a
 * network. `calls` records what was asked, which is how the tests check that the
 * prompt carried the claim ids and the board.
 */
class FakeProvider implements Provider {
  readonly kind = "ollama" as const;
  readonly baseUrl = "http://fake";
  readonly calls: string[] = [];
  private index = 0;
  private readonly replies: readonly unknown[];

  constructor(replies: readonly unknown[]) {
    this.replies = replies;
  }

  async chat(opts: { messages: readonly { content: string }[] }): Promise<ChatResponse> {
    this.calls.push(opts.messages.map((m) => m.content).join("\n---\n"));
    const reply = this.replies[Math.min(this.index, this.replies.length - 1)];
    this.index++;
    return {
      value: reply,
      toolCall: null,
      text: JSON.stringify(reply),
      ms: 1,
      repaired: false,
    };
  }

  async probe(): Promise<Capabilities> {
    return { responds: true, tools: true, schema: true, thinking: false, streaming: false, probeMs: 1 };
  }
}

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "ww-reflect-"));
}

const baseInput = (provider: Provider, dir: string, store: ClaimStore) => ({
  provider,
  model: "fake",
  think: false,
  agent: "A",
  day: 2,
  tick: 7200,
  workspaceDir: dir,
  store,
  daySummary: ["MoveTo walked toward the mesa", "Pickup picked up Cube_3"],
  endPosition: [3, 5, 6] as const,
  board: [{ id: "post_1", agent: "B", content: "Place cannot stack reliably" }],
});

test("a valid extraction writes events and claims", async () => {
  const dir = workspace();
  const store = new ClaimStore();
  const provider = new FakeProvider([
    {
      events: [{ summary: "walked to the mesa", detail: "about 14 units." }],
      claims: [
        { text: "Cube_3 sits near the mesa", kind: "fact", confidence: 0.7, evidence: ["saw it"] },
      ],
    },
  ]);

  const result = await reflect(baseInput(provider, dir, store));

  assert.equal(result.ok, true);
  assert.equal(result.eventsRecorded, 1);
  assert.equal(result.claimsRecorded, 1);
  assert.equal(result.repaired, false);
  assert.equal(readEpisodic(dir).length, 1);
  assert.equal(store.size, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("a malformed reply is repaired once, then accepted", async () => {
  const dir = workspace();
  const store = new ClaimStore();
  const provider = new FakeProvider([
    { events: "not an array" },
    { events: [], claims: [] },
  ]);

  const result = await reflect(baseInput(provider, dir, store));

  assert.equal(result.ok, true);
  assert.equal(result.repaired, true);
  assert.equal(provider.calls.length, 2);
  // The repair prompt must name the field that was wrong, or the model cannot fix it.
  assert.match(provider.calls[1] ?? "", /events/);
  rmSync(dir, { recursive: true, force: true });
});

test("a reply that never becomes valid reports failure rather than inventing memory", async () => {
  const dir = workspace();
  const store = new ClaimStore();
  const provider = new FakeProvider([{ nope: true }]);

  const result = await reflect(baseInput(provider, dir, store));

  assert.equal(result.ok, false);
  assert.equal(result.claimsRecorded, 0);
  assert.equal(result.eventsRecorded, 0);
  assert.equal(store.size, 0);
  assert.equal(readEpisodic(dir).length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("the prompt carries existing claim ids, so the model can refute one", async () => {
  const dir = workspace();
  const store = new ClaimStore();
  store.add({
    agent: "A", day: 1, text: "Place can stack", kind: "fact", confidence: 0.7,
    source: { kind: "self" }, evidence: ["ep_1"], createdTick: 100,
  }, "c_old");

  const provider = new FakeProvider([
    { events: [], claims: [], refute: ["c_old"] },
  ]);
  const result = await reflect(baseInput(provider, dir, store));

  assert.deepEqual(result.refuted, ["c_old"]);
  assert.equal(store.get("c_old")?.status, "refuted");
  // Without the id in the prompt there is nothing to cite.
  assert.match(provider.calls[0] ?? "", /c_old/);
  rmSync(dir, { recursive: true, force: true });
});

test("a board post id resolves to board provenance even when fromAgent is set", async () => {
  // Measured: models write fromAgent:"B" next to a board post id, which is an accurate
  // description of the source. Judging provenance by the field rather than the id
  // rejected correct citations.
  const dir = workspace();
  const store = new ClaimStore();
  const provider = new FakeProvider([
    {
      events: [],
      claims: [
        {
          text: "Place cannot stack",
          kind: "fact",
          confidence: 0.6,
          evidence: [],
          fromAgent: "B",
          fromClaim: "post_1",
        },
      ],
    },
  ]);

  const result = await reflect(baseInput(provider, dir, store));
  assert.equal(result.claimsRecorded, 1);
  const claim = store.all()[0];
  assert.deepEqual(claim?.source, { kind: "board", postId: "post_1" });
  rmSync(dir, { recursive: true, force: true });
});

test("a claim cited against an id that is neither a post nor a claim is rejected", async () => {
  const dir = workspace();
  const store = new ClaimStore();
  const provider = new FakeProvider([
    {
      events: [],
      claims: [
        { text: "borrowed", kind: "fact", confidence: 0.5, evidence: [], fromClaim: "post_999" },
      ],
    },
  ]);

  const result = await reflect(baseInput(provider, dir, store));
  assert.equal(result.claimsRecorded, 0);
  assert.equal(result.claimsRejected.length, 1);
  assert.match(result.claimsRejected[0] ?? "", /neither a board post/);
  rmSync(dir, { recursive: true, force: true });
});

test("an unevidenced self-claim is recorded as weaker and reported as downgraded", async () => {
  const dir = workspace();
  const store = new ClaimStore();
  const provider = new FakeProvider([
    {
      events: [],
      claims: [{ text: "The Spire is reachable", kind: "fact", confidence: 0.8, evidence: [] }],
    },
  ]);

  const result = await reflect(baseInput(provider, dir, store));
  assert.equal(result.claimsRecorded, 1);
  assert.equal(result.claimsDowngraded.length, 1);
  assert.equal(store.all()[0]?.kind, "hypothesis");
  rmSync(dir, { recursive: true, force: true });
});

test("refuting another agent's claim is refused and does not change it", async () => {
  const dir = workspace();
  const store = new ClaimStore();
  store.add({
    agent: "B", day: 1, text: "someone else's belief", kind: "fact", confidence: 0.5,
    source: { kind: "self" }, evidence: ["ep_b"], createdTick: 100,
  }, "c_b");

  const provider = new FakeProvider([{ events: [], claims: [], refute: ["c_b"] }]);
  const result = await reflect(baseInput(provider, dir, store));

  assert.deepEqual(result.refuted, []);
  assert.equal(store.get("c_b")?.status, "active");
  rmSync(dir, { recursive: true, force: true });
});
