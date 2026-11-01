/**
 * Tuning constants for hidden mechanics. Each is referenced by an id in
 * `worlds/island/rules.json`; changing one changes a documented rule, so update the
 * ledger and re-run its probe in the same commit.
 */

/** R1: fraction of the thrower's velocity inherited by a thrown object. */
export const CARRY_FACTOR = 0.35;

/** R2: minimum impact speed for the rock to generate cubes, in m/s. */
export const IMPACT_MIN_SPEED = 9;
/** R2: maximum cubes generated per impact. */
export const IMPACT_MAX_CUBES = 6;

/** R4: maximum gap at which adjacent cubes transmit a push on an incline, in metres. */
export const CONTACT_MAX_GAP = 0.4;
/** R4: maximum incline angle, in degrees, at which that push still transfers. */
export const CONTACT_MAX_ANGLE_DEG = 20;

/** R5: height above which a landing keeps extra bounce. */
export const HIGH_LANDING_MIN_HEIGHT = 12;
/** R5: extra restitution applied to such a landing. */
export const HIGH_LANDING_BONUS = 0.25;
