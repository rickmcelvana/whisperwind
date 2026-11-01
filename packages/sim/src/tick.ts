/**
 * The tick loop and the round barrier.
 *
 * A round is: every agent submits an action sequence, all sequences are applied, then
 * the world advances by the maximum duration among them. This is what makes the world
 * turn-synchronised rather than wall-clock: a slow model stalls a paused world, not
 * the others' physics.
 *
 * Pure with respect to the clock: no Date, no timers. `wallMs` is supplied by callers
 * that measure it, never read here.
 */

import type {
  Action,
  ActionResult,
  ActionSequence,
  RoundRecord,
} from "@whisperwind/core";

import { applyAction } from "./actions/apply.ts";
import { GENESIS_CHAIN, extendChain, stateDigest } from "./state/digest.ts";
import type { Island } from "./world.ts";

export interface AgentSubmission {
  readonly agent: string;
  readonly actions: ActionSequence;
  /** Optional metrics attached by the caller (tokens, latency). Never used by the sim. */
  readonly tokens?: { readonly prompt: number; readonly completion: number };
  readonly wallMs?: number;
}

export interface RoundInput {
  readonly day: number;
  readonly round: number;
  readonly chain: string;
  readonly submissions: readonly AgentSubmission[];
}

export interface RoundOutput {
  readonly records: readonly RoundRecord[];
  readonly chain: string;
  readonly state: string;
  readonly ticks: number;
}

/**
 * Apply one round. Agent order is the island's body order, fixed at construction, so
 * the same submissions in the same order always produce the same result.
 */
export function runRound(island: Island, input: RoundInput): RoundOutput {
  const byName = new Map<string, number>();
  island.agents.forEach((a, i) => byName.set(a.name, i));

  const perAgent: { name: string; actions: Action[]; results: ActionResult[]; ticks: number }[] = [];

  for (const agent of island.agents) {
    const sub = input.submissions.find((s) => s.agent === agent.name);
    const actions: Action[] = sub ? [...sub.actions] : [{ type: "Stop" }];
    const results: ActionResult[] = [];
    let ticks = 0;

    // A sequence executes atomically within the round: durations are summed for the
    // agent, and the world advances by the slowest agent's total.
    for (const action of actions) {
      const idx = byName.get(agent.name);
      if (idx === undefined) throw new Error(`unknown agent ${agent.name}`);
      const result = applyAction(island, idx, action);
      results.push(result);
      ticks += result.ticks;
    }

    perAgent.push({ name: agent.name, actions, results, ticks });
  }

  const ticks = Math.max(1, ...perAgent.map((p) => p.ticks));
  for (let t = 0; t < ticks; t++) island.world.step();

  const state = stateDigest(island);
  const chain = extendChain(input.chain, state);

  const records: RoundRecord[] = perAgent.map((p) => {
    const sub = input.submissions.find((s) => s.agent === p.name);
    return {
      day: input.day,
      round: input.round,
      agent: p.name,
      action: p.actions,
      result: p.results,
      state,
      chain,
      ...(sub?.tokens ? { tokens: sub.tokens } : {}),
      ...(sub?.wallMs !== undefined ? { wallMs: sub.wallMs } : {}),
    };
  });

  return { records, chain, state, ticks };
}

/** Convenience for a fresh run. */
export function startChain(): string {
  return GENESIS_CHAIN;
}
