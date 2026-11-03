/**
 * Action application. Pure state transitions on the Rapier world; no I/O, no clock.
 *
 * Every action returns an `ActionResult` with the number of ticks it occupies. A
 * rejected action still costs one tick: an agent that tries to place with empty hands
 * learns something, and the turn is still spent.
 */

import {
  type Action,
  type ActionResult,
  type RejectReason,
  type Vec3,
} from "@whisperwind/core";

import RAPIER from "@dimforge/rapier3d-compat";

import type { AgentBody, Island, Tracked } from "../world.ts";
import { PICKUP_REACH, PICKUP_REACH_Y, distanceXZ, ticksFor } from "../motion/duration.ts";
import { CARRY_FACTOR } from "../motion/constants.ts";

function pos(t: { translation(): { x: number; y: number; z: number } }): Vec3 {
  const t0 = t.translation();
  return [t0.x, t0.y, t0.z];
}

function reject(reason: RejectReason): ActionResult {
  return { ok: false, reason, ticks: 1 };
}

function isVec3(v: unknown): v is Vec3 {
  return (
    Array.isArray(v) &&
    v.length === 3 &&
    v.every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

/** Find a held item's tracked body, if any. */
export function heldItem(island: Island, agent: AgentBody): Tracked | null {
  if (!agent.held) return null;
  return island.items.get(agent.held) ?? null;
}

/**
 * Apply one action for `agent`. Returns how many ticks the world should advance.
 * The caller is responsible for actually stepping the physics world.
 */
export function applyAction(island: Island, agentIndex: number, action: Action): ActionResult {
  const agent = island.agents[agentIndex];
  if (!agent) return reject("invalid_args");

  switch (action.type) {
    case "Stop":
      return { ok: true, ticks: 1 };

    case "Jump": {
      const ticks = ticksFor(action, island.motion, pos(agent.body));
      // Kinematic jump: move the body up over the flight time, then back down.
      // A full integration is unnecessary and would add a source of divergence.
      const start = pos(agent.body);
      agent.body.setNextKinematicTranslation({ x: start[0], y: start[1] + 2.2, z: start[2] });
      return { ok: true, ticks };
    }

    case "MoveTo": {
      if (!isVec3(action.position)) return reject("invalid_args");
      const target = action.position;
      const start = pos(agent.body);
      const ticks = ticksFor(action, island.motion, start, target);
      // Clamp to the world so an agent cannot walk out of the finite ground slab.
      const limit = island.bounds.halfExtent - 2;
      const x = Math.min(limit, Math.max(-limit, target[0]));
      const z = Math.min(limit, Math.max(-limit, target[2]));
      agent.body.setNextKinematicTranslation({ x, y: start[1], z });
      return { ok: true, ticks };
    }

    case "Pickup": {
      if (!isVec3(action.position)) return reject("invalid_args");
      if (agent.held) return reject("holding");
      const at = pos(agent.body);
      const target: Vec3 = action.position;
      if (distanceXZ(at, target) > PICKUP_REACH || target[1] > at[1] + PICKUP_REACH_Y) {
        return reject("out_of_reach");
      }
      // Nearest item within reach of the requested point.
      let best: Tracked | null = null;
      let bestDist = Number.POSITIVE_INFINITY;
      for (const item of island.items.values()) {
        const d = distanceXZ(pos(item.body), target);
        if (d < bestDist && d <= 1.5) {
          best = item;
          bestDist = d;
        }
      }
      if (!best) return reject("out_of_reach");
      // Teleport the item to the body and make it kinematic while held, so physics
      // cannot drop it before the next action.
      best.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
      best.body.setNextKinematicTranslation({ x: at[0], y: at[1] + 1.5, z: at[2] });
      agent.held = best.name;
      return { ok: true, ticks: ticksFor(action, island.motion, at) };
    }

    case "Place": {
      if (!isVec3(action.position)) return reject("invalid_args");
      const item = heldItem(island, agent);
      if (!item) return reject("not_holding");
      const target = action.position;
      item.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
      item.body.setTranslation({ x: target[0], y: target[1], z: target[2] }, true);
      item.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      item.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      agent.held = null;
      return { ok: true, ticks: ticksFor(action, island.motion, pos(agent.body)) };
    }

    case "Throw": {
      if (!isVec3(action.direction)) return reject("invalid_args");
      if (typeof action.speed !== "number" || !Number.isFinite(action.speed) || action.speed <= 0) {
        return reject("invalid_args");
      }
      const item = heldItem(island, agent);
      if (!item) return reject("not_holding");
      const at = pos(agent.body);
      const bodyVel = agent.body.linvel();
      const dir = action.direction;
      const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
      // R1: a thrown object inherits a fraction of the thrower's velocity. This is the
      // mechanic the source experiment's designers did not know existed.
      item.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
      item.body.setTranslation({ x: at[0], y: at[1] + 1.5, z: at[2] }, true);
      item.body.setLinvel(
        {
          x: (dir[0] / len) * action.speed + bodyVel.x * CARRY_FACTOR,
          y: (dir[1] / len) * action.speed + bodyVel.y * CARRY_FACTOR,
          z: (dir[2] / len) * action.speed + bodyVel.z * CARRY_FACTOR,
        },
        true,
      );
      item.body.setAngvel({ x: 0, y: 8, z: 0 }, true);
      agent.held = null;
      return { ok: true, ticks: ticksFor(action, island.motion, at) };
    }

    default: {
      const never: never = action;
      void never;
      return reject("unknown_action");
    }
  }
}
