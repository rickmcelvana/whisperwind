/**
 * The day loop from plan §7.
 *
 * A day is a budget of decisions per agent. Rounds synchronise: every agent submits,
 * then the world advances by the slowest. Wall clock never enters the simulation, and
 * a slow model stalls the loop rather than the physics.
 *
 * This module owns orchestration only. It talks to models through a `Decider`
 * interface so run tests use scripted decisions instead of network calls.
 */

import type {
  ActionSequence,
  AgentSpec,
  Observation,
  RoundRecord,
} from "@whisperwind/core";

import {
  type Island,
  observe,
  runRound,
  startChain,
  stateDigest,
} from "@whisperwind/sim";

export interface Decision {
  readonly actions: ActionSequence;
  readonly tokens?: { readonly prompt: number; readonly completion: number };
  readonly wallMs?: number;
  /** Set when the model produced nothing valid even after a repair retry. */
  readonly invalid?: boolean;
}

/** One agent's model. Implemented by the live adapter and by test doubles. */
export interface Decider {
  decide(observation: Observation, context: DecisionContext): Promise<Decision>;
}

export interface DecisionContext {
  readonly agent: string;
  readonly day: number;
  readonly round: number;
}

export interface DayConfig {
  readonly days: number;
  readonly decisionBudget: number;
  /** Rounds before the end at which the dusk message is delivered. */
  readonly duskLead: number;
}

export interface RunResult {
  readonly records: readonly RoundRecord[];
  readonly chain: string;
  readonly days: readonly DaySummary[];
}

export interface DaySummary {
  readonly day: number;
  readonly rounds: number;
  readonly chain: string;
  readonly state: string;
  /** Per-agent count of decisions that produced no valid action. */
  readonly invalidByAgent: Readonly<Record<string, number>>;
}

export interface DayHooks {
  /** Called at the start of each day, after the world is reset. */
  readonly onDayStart?: (day: number, island: Island) => void | Promise<void>;
  /** Called after the last round of each day. */
  readonly onDayEnd?: (summary: DaySummary, island: Island) => void | Promise<void>;
  /** Called after each round, for recording. */
  readonly onRound?: (records: readonly RoundRecord[]) => void | Promise<void>;
}

/**
 * Run the loop. The island is rebuilt per day by `resetDay`, which the caller supplies
 * so memory can persist while geometry is restored (plan §7 reset semantics).
 */
export async function runDays(
  config: DayConfig,
  agents: readonly AgentSpec[],
  deciders: ReadonlyMap<string, Decider>,
  resetDay: (day: number) => Island,
  hooks: DayHooks = {},
): Promise<RunResult> {
  const allRecords: RoundRecord[] = [];
  const summaries: DaySummary[] = [];
  let chain = startChain();

  for (let day = 1; day <= config.days; day++) {
    const island = resetDay(day);
    await hooks.onDayStart?.(day, island);

    const invalidByAgent: Record<string, number> = {};
    for (const a of agents) invalidByAgent[a.name] = 0;

    let round = 0;
    for (; round < config.decisionBudget; round++) {
      const isDusk = round >= config.decisionBudget - config.duskLead;

      const submissions = await Promise.all(
        agents.map(async (agent) => {
          const decider = deciders.get(agent.name);
          if (!decider) throw new Error(`no decider for agent ${agent.name}`);
          const index = island.agents.findIndex((b) => b.name === agent.name);
          if (index < 0) throw new Error(`agent ${agent.name} has no body in the world`);

          const observation = observe(island, index, {
            tick: round,
            day,
            boardPosts: 0,
            boardLatestTick: null,
            unreadChat: 0,
            lastResults: new Map<string, string | null>(),
          });

          const decision = await decider.decide(observation, { agent: agent.name, day, round });
          if (decision.invalid) invalidByAgent[agent.name] = (invalidByAgent[agent.name] ?? 0) + 1;
          return {
            agent: agent.name,
            actions: decision.actions,
            ...(decision.tokens ? { tokens: decision.tokens } : {}),
            ...(decision.wallMs !== undefined ? { wallMs: decision.wallMs } : {}),
          };
        }),
      );

      const out = runRound(island, { day, round, chain, submissions });
      chain = out.chain;
      allRecords.push(...out.records);
      await hooks.onRound?.(out.records);
      void isDusk;
    }

    const summary: DaySummary = {
      day,
      rounds: round,
      chain,
      state: stateDigest(island),
      invalidByAgent,
    };
    summaries.push(summary);
    await hooks.onDayEnd?.(summary, island);
  }

  return { records: allRecords, chain, days: summaries };
}
