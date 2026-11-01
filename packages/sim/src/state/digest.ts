/**
 * Deterministic state digest and the per-round chain.
 *
 * A terminal digest alone cannot verify a replay: a mid-day action change can be
 * overwritten by a later one and leave the end state byte-identical. Measured in
 * plan §8. So every round contributes its own hash, chained.
 */

import { createHash } from "node:crypto";

import type { Island } from "../world.ts";

const DIGEST_DECIMALS = 6;

/**
 * Hash every body's transform, sorted by handle so the digest does not depend on set
 * iteration order. Handles are printed, never used arithmetically.
 */
export function stateDigest(island: Island): string {
  const rows: string[] = [];
  island.world.forEachRigidBody((body) => {
    const t = body.translation();
    const r = body.rotation();
    rows.push(
      [
        String(body.handle),
        t.x.toFixed(DIGEST_DECIMALS),
        t.y.toFixed(DIGEST_DECIMALS),
        t.z.toFixed(DIGEST_DECIMALS),
        r.x.toFixed(DIGEST_DECIMALS),
        r.y.toFixed(DIGEST_DECIMALS),
        r.z.toFixed(DIGEST_DECIMALS),
        r.w.toFixed(DIGEST_DECIMALS),
      ].join(","),
    );
  });
  rows.sort();
  const h = createHash("sha256");
  for (const row of rows) h.update(row).update("|");
  return h.digest("hex");
}

/** Append a state hash to a running chain. */
export function extendChain(chain: string, state: string): string {
  return createHash("sha256").update(chain).update(":").update(state).digest("hex");
}

/** The chain's initial value: no rounds yet. */
export const GENESIS_CHAIN = "0".repeat(64);
