import test from "node:test";
import assert from "node:assert/strict";

import {
  ACTION_TYPES,
  DEFAULT_MOTION,
  REJECT_REASONS,
  CLAIM_KINDS,
  CLAIM_STATUS,
} from "@whisperwind/core";

test("action set is exactly the six verbs", () => {
  assert.deepEqual([...ACTION_TYPES], ["MoveTo", "Jump", "Stop", "Pickup", "Place", "Throw"]);
});

test("every action type has a distinct name and no duplicates", () => {
  assert.equal(new Set(ACTION_TYPES).size, ACTION_TYPES.length);
});

test("motion profile is physical, not tick counts", () => {
  // A humanoid walking speed. If someone writes `MoveTo: 24` ticks again, this fails.
  assert.ok(DEFAULT_MOTION.walkSpeed > 1 && DEFAULT_MOTION.walkSpeed < 10);
  assert.equal(DEFAULT_MOTION.tickRate, 60);
  assert.ok(DEFAULT_MOTION.jumpSeconds > 0 && DEFAULT_MOTION.jumpSeconds < 2);
});

test("reject reasons are a closed set the adapter can switch on", () => {
  assert.ok(REJECT_REASONS.includes("out_of_reach"));
  assert.equal(new Set(REJECT_REASONS).size, REJECT_REASONS.length);
});

test("claim enums match the storage schema", () => {
  // These strings are written to claims.db; renaming one silently breaks queries.
  assert.deepEqual([...CLAIM_KINDS], ["verified", "fact", "hypothesis", "mistake"]);
  assert.deepEqual([...CLAIM_STATUS], ["active", "refuted", "superseded"]);
});
