/**
 * Observation: what an agent sees. Textual JSON only.
 *
 * Two constraints that matter for cost and determinism:
 * - `nearby` is filtered by radius and sorted by id, so the prompt prefix stays stable
 *   and the provider's prompt cache can hit (measured 4725/4729 tokens cached).
 * - No clock, no wall time, no tick rate derived from the host.
 */

import type { EntityKind, Observation, PlayerView, Vec3 } from "@whisperwind/core";

import type { Island } from "./world.ts";

export const OBSERVATION_RADIUS = 40;
/** Cap on nearby entities so the prompt stays bounded as agents litter the island. */
export const MAX_NEARBY = 60;

function v3(t: { x: number; y: number; z: number }): Vec3 {
  return [round2(t.x), round2(t.y), round2(t.z)];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function dist2(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
}

export interface ObserveOptions {
  readonly tick: number;
  readonly day: number;
  readonly boardPosts: number;
  readonly boardLatestTick: number | null;
  readonly unreadChat: number;
  /** Last action result string per agent name, e.g. "MoveTo ok". */
  readonly lastResults: ReadonlyMap<string, string | null>;
}

export function observe(island: Island, agentIndex: number, opts: ObserveOptions): Observation {
  const agent = island.agents[agentIndex];
  if (!agent) throw new Error(`no agent at index ${agentIndex}`);

  const at = v3(agent.body.translation());

  const nearby = island.entities
    .map((e, id) => ({ e, id, pos: v3(e.body.translation()) }))
    .filter(({ pos }) => dist2(at, pos) <= OBSERVATION_RADIUS * OBSERVATION_RADIUS)
    .sort((a, b) => a.id - b.id)
    .slice(0, MAX_NEARBY)
    .map(({ e, id, pos }) => ({
      id,
      name: e.name,
      kind: e.kind satisfies EntityKind,
      position: pos,
      size: [e.half[0] * 2, e.half[1] * 2, e.half[2] * 2] as Vec3,
      anchored: false,
    }));

  const others: PlayerView[] = island.agents
    .filter((a) => a !== agent)
    .map((a) => ({
      name: a.name,
      position: v3(a.body.translation()),
      held: a.held,
      last: opts.lastResults.get(a.name) ?? null,
    }));

  return {
    tick: opts.tick,
    day: opts.day,
    player: {
      name: agent.name,
      position: at,
      held: agent.held,
      last: opts.lastResults.get(agent.name) ?? null,
    },
    nearby,
    others,
    board: { posts: opts.boardPosts, latestTick: opts.boardLatestTick },
    chat: { unread: opts.unreadChat },
  };
}
