/**
 * Durations are physical, never constant tick counts. A constant `MoveTo: 24` makes
 * the world advance the same amount whether an agent walks 1 unit or 60, which breaks
 * both realism and the decision budget in plan §7.
 */

import type { Action, MotionProfile, Vec3 } from "@whisperwind/core";

/** Distance between two points. */
export function distance(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Horizontal distance, used for reach checks where height is irrelevant. */
export function distanceXZ(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dz * dz);
}

export function ticksFor(action: Action, motion: MotionProfile, from: Vec3, to?: Vec3): number {
  const rate = motion.tickRate;
  switch (action.type) {
    case "MoveTo": {
      const target = action.position;
      const metres = distance(from, target);
      return Math.max(1, Math.ceil(metres / motion.walkSpeed * rate));
    }
    case "Jump":
      return Math.max(1, Math.round(motion.jumpSeconds * rate));
    case "Stop":
      return 1;
    case "Pickup":
      return Math.max(1, Math.round(motion.pickupSeconds * rate));
    case "Place":
      return Math.max(1, Math.round(motion.placeSeconds * rate));
    case "Throw":
      return Math.max(1, Math.round(motion.throwSeconds * rate));
    default: {
      // Exhaustiveness: adding an action to the union fails here until handled.
      const never: never = action;
      void never;
      void to;
      return 1;
    }
  }
}

/** Reach for Pickup, in metres, measured horizontally from body centre. */
export const PICKUP_REACH = 3;

/** How far above the agent's feet an object can be grabbed. */
export const PICKUP_REACH_Y = 2.5;
