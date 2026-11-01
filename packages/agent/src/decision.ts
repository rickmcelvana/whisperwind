/**
 * Decision layer: turn a model response into a validated ActionSequence.
 *
 * Validation is mandatory because schema violations are silent. Measured on this
 * hardware: one model returned a missing required field in 8/8 samples over `tools`
 * alone, and no layer raised an error; another ignored `format` and answered in prose.
 * A malformed decision that is executed anyway would corrupt the experiment rather
 * than fail it.
 */

import {
  ACTION_TYPES,
  type Action,
  type ActionSequence,
  type Vec3,
} from "@whisperwind/core";

import { asRecord } from "./provider.ts";

export interface ValidationResult {
  readonly ok: boolean;
  readonly actions: ActionSequence;
  /** Text the agent wants to put on the shared board, if any. */
  readonly post: string | null;
  /** Human-readable reason when `ok` is false; used in the repair prompt. */
  readonly error?: string;
}

const VALID_TYPES: readonly string[] = ACTION_TYPES;

/** JSON Schema for one action, sent to providers as both `tools` and `format`. */
export const ACTION_SCHEMA = {
  type: "object",
  properties: {
    actions: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: [...ACTION_TYPES] },
          position: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
          direction: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
          speed: { type: "number", minimum: 0, maximum: 100 },
          rotation: {
            type: "object",
            properties: {
              yaw: { type: "number" },
              pitch: { type: "number" },
              roll: { type: "number" },
            },
            required: ["yaw", "pitch", "roll"],
            additionalProperties: false,
          },
        },
        required: ["type"],
        additionalProperties: false,
      },
    },
    reason: { type: "string", maxLength: 200 },
    /**
     * Optional note for the shared board. A post is the substrate of the belief-exchange
     * experiment, so it is part of the decision rather than a separate request: an extra
     * call per post would double the request count for a behaviour that should be cheap.
     */
    post: { type: "string", maxLength: 280 },
  },
  required: ["actions"],
  additionalProperties: false,
} as const;

function isVec3(v: unknown): v is Vec3 {
  return (
    Array.isArray(v) &&
    v.length === 3 &&
    v.every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

/** Validate one action object. Returns the action or an error string. */
function validateOne(raw: unknown): Action | string {
  const rec = asRecord(raw);
  if (!rec) return "action is not an object";
  const type = rec["type"];
  if (typeof type !== "string" || !VALID_TYPES.includes(type)) {
    return `unknown action type ${JSON.stringify(type)}; use one of ${VALID_TYPES.join(", ")}`;
  }

  switch (type) {
    case "MoveTo":
    case "Pickup":
    case "Place": {
      const position = rec["position"];
      if (!isVec3(position)) return `${type} requires position as [x,y,z]`;
      if (type === "Place") {
        const rotation = rec["rotation"];
        if (rotation !== undefined) {
          const r = asRecord(rotation);
          if (!r || typeof r["yaw"] !== "number" || typeof r["pitch"] !== "number" || typeof r["roll"] !== "number") {
            return "Place rotation must be {yaw,pitch,roll} numbers";
          }
          return { type: "Place", position, rotation: { yaw: r["yaw"], pitch: r["pitch"], roll: r["roll"] } };
        }
      }
      if (type === "MoveTo") return { type: "MoveTo", position };
      if (type === "Pickup") return { type: "Pickup", position };
      return { type: "Place", position };
    }
    case "Throw": {
      const direction = rec["direction"];
      const speed = rec["speed"];
      if (!isVec3(direction)) return "Throw requires direction as [x,y,z]";
      if (typeof speed !== "number" || !Number.isFinite(speed)) return "Throw requires numeric speed";
      return { type: "Throw", direction, speed };
    }
    case "Jump":
      return { type: "Jump" };
    case "Stop":
      return { type: "Stop" };
    default:
      return `unhandled action ${type}`;
  }
}

/**
 * Validate a model's parsed value as an action sequence.
 *
 * Accepts either `{ actions: [...] }` or a bare action object, because models do both
 * regardless of the schema.
 */
export function validateDecision(value: unknown): ValidationResult {
  const rec = asRecord(value);
  if (!rec) {
    return { ok: false, actions: [], post: null, error: "response was not a JSON object" };
  }

  const rawPost = rec["post"];
  const post = typeof rawPost === "string" && rawPost.trim().length > 0 ? rawPost.trim() : null;

  let list: unknown[];
  const maybeActions = rec["actions"];
  if (Array.isArray(maybeActions)) {
    list = maybeActions;
  } else if (typeof rec["type"] === "string") {
    list = [rec];
  } else {
    return {
      ok: false,
      actions: [],
      post,
      error: 'missing "actions" array (or a single action object with "type")',
    };
  }

  if (list.length === 0) return { ok: false, actions: [], post, error: "actions array is empty" };

  const out: Action[] = [];
  for (const raw of list) {
    const one = validateOne(raw);
    if (typeof one === "string") return { ok: false, actions: [], post, error: one };
    out.push(one);
  }
  return { ok: true, actions: out, post };
}
