/**
 * Shared contracts. Every package imports from here and nowhere else for these types.
 *
 * Rules for this file:
 * - Pure types and pure constants. No I/O, no clock, no randomness, no imports.
 * - Every change is a breaking change across packages. Update callers in the same
 *   commit, or do not change it.
 * - Enums are `as const` unions, never `enum`: Node strips types without emitting
 *   code, and `enum` is not erasable syntax.
 */

// ---------------------------------------------------------------------------
// World: geometry, entities, actions
// ---------------------------------------------------------------------------

/** The six verbs. Extending this set is a world change, not an adapter change. */
export const ACTION_TYPES = ["MoveTo", "Jump", "Stop", "Pickup", "Place", "Throw"] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export type Vec3 = readonly [number, number, number];

export interface MoveToAction {
  readonly type: "MoveTo";
  readonly position: Vec3;
}
export interface JumpAction {
  readonly type: "Jump";
}
export interface StopAction {
  readonly type: "Stop";
}
export interface PickupAction {
  readonly type: "Pickup";
  readonly position: Vec3;
}
export interface PlaceAction {
  readonly type: "Place";
  readonly position: Vec3;
  readonly rotation?: { readonly yaw: number; readonly pitch: number; readonly roll: number };
}
export interface ThrowAction {
  readonly type: "Throw";
  readonly direction: Vec3;
  readonly speed: number;
}

export type Action = MoveToAction | JumpAction | StopAction | PickupAction | PlaceAction | ThrowAction;

/**
 * A decision is 1..n actions executed atomically within one round.
 * Measured motivation: real agents batch (7 bursts carried 233 actions in an hour),
 * and pattern-laying is unreachable without sequences. See plan §7.
 */
export type ActionSequence = readonly Action[];

/** Physical constants that action durations derive from. Never per-action tick counts. */
export interface MotionProfile {
  /** Metres per second for MoveTo. */
  readonly walkSpeed: number;
  /** Seconds a Jump stays airborne. */
  readonly jumpSeconds: number;
  /** Seconds to reach and close a grip. */
  readonly pickupSeconds: number;
  /** Seconds to orient and release a held object. */
  readonly placeSeconds: number;
  /** Seconds of wind-up before a Throw releases. */
  readonly throwSeconds: number;
  /** Simulation ticks per second. Fixed: replay depends on it. */
  readonly tickRate: number;
}

export const DEFAULT_MOTION: MotionProfile = {
  walkSpeed: 4.5,
  jumpSeconds: 0.5,
  pickupSeconds: 2,
  placeSeconds: 2,
  throwSeconds: 1,
  tickRate: 60,
};

// ---------------------------------------------------------------------------
// Entities and observation
// ---------------------------------------------------------------------------

export type EntityKind = "block" | "rock" | "ring" | "mesa" | "ground" | "body";

/**
 * Entity names are the identity. Rapier handles are raw bit patterns that print as
 * subnormals; never key anything on them. See plan §1 "Body identity".
 */
export interface EntityView {
  readonly id: number;
  readonly name: string;
  readonly kind: EntityKind;
  readonly position: Vec3;
  readonly size: Vec3;
  /** True for static terrain. */
  readonly anchored: boolean;
}

export interface PlayerView {
  readonly name: string;
  readonly position: Vec3;
  readonly held: string | null;
  /** Result of the agent's previous action, e.g. "MoveTo ok". */
  readonly last: string | null;
}

/** What one agent receives. Textual JSON only; no images. */
export interface Observation {
  readonly tick: number;
  readonly day: number;
  /** This agent's own state. */
  readonly player: PlayerView;
  /** Radius-filtered, sorted by id, so the prompt prefix stays cache-stable. */
  readonly nearby: readonly EntityView[];
  /** Other agents. Position and held item only; never their memory. */
  readonly others: readonly PlayerView[];
  /** Counts, not contents: the agent fetches posts explicitly through a tool. */
  readonly board: { readonly posts: number; readonly latestTick: number | null };
  readonly chat: { readonly unread: number };
}

// ---------------------------------------------------------------------------
// Actions as applied to the world, and their results
// ---------------------------------------------------------------------------

/**
 * Why an action was rejected. Rejections are normal, not errors: an agent that walks
 * into a wall should learn that, and the turn still consumes a decision.
 */
export const REJECT_REASONS = [
  "not_holding", // Place/Throw with empty hands
  "holding", // Pickup while already holding
  "out_of_reach", // Pickup target farther than reach
  "unknown_action", // not one of the six
  "invalid_args", // malformed position/direction/speed
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

export type ActionResult =
  | { readonly ok: true; readonly ticks: number; readonly note?: string }
  | { readonly ok: false; readonly reason: RejectReason; readonly ticks: 1 };

// ---------------------------------------------------------------------------
// Rounds, days, runs
// ---------------------------------------------------------------------------

export interface AgentSpec {
  readonly name: string;
  readonly provider: string;
  readonly model: string;
  /** Disable model reasoning by default; it dominated cost 18x. See plan §5.2. */
  readonly think: boolean;
}

export interface WorldConfig {
  readonly seed: number;
  readonly motion: MotionProfile;
  /** Spawn points, one per agent, on a circle around the origin. */
  readonly spawnRadius: number;
}

/**
 * One agent's decision within one round. This is the unit written to events.jsonl,
 * so its shape is a storage format: changing it invalidates existing runs.
 */
export interface RoundRecord {
  readonly day: number;
  readonly round: number;
  readonly agent: string;
  readonly action: ActionSequence;
  readonly result: readonly ActionResult[];
  /** Hash of world state after this round, and the chain up to here. See plan §8. */
  readonly state: string;
  readonly chain: string;
  readonly tokens?: { readonly prompt: number; readonly completion: number };
  readonly wallMs?: number;
}

// ---------------------------------------------------------------------------
// Model providers
// ---------------------------------------------------------------------------

/**
 * What a provider/model can actually do, established by probe at run start and
 * recorded in the manifest. Never assume: measured behaviour differs per model, and
 * some failures are silent (a missing required field, an ignored format flag).
 */
export interface Capabilities {
  readonly responds: boolean;
  /** Accepts `tools`. */
  readonly tools: boolean;
  /** Accepts `format` (JSON Schema) and enforces it. */
  readonly schema: boolean;
  /** Accepts a thinking on/off toggle. */
  readonly thinking: boolean;
  readonly streaming: boolean;
  /** Measured round-trip for the probe request. */
  readonly probeMs: number;
}

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
}

export interface ChatRequest {
  readonly messages: readonly ChatMessage[];
  /** JSON Schema for the reply. Sent with `tools` on every provider that supports it. */
  readonly schema?: object;
  readonly tools?: readonly object[];
  readonly think?: boolean;
  readonly maxTokens?: number;
}

export interface ToolCall {
  readonly name: string;
  /** Parsed arguments when the provider returned them as an object, else the raw string. */
  readonly arguments: unknown;
}

export interface ChatResponse {
  /** Parsed JSON if the reply was JSON; otherwise the raw text. */
  readonly value: unknown;
  /**
   * The tool the model asked to call, when it made one.
   *
   * Kept separate from `value` because a model with several tools available must be
   * able to say *which*; collapsing this to arguments alone silently turns every call
   * into whichever tool the caller assumes.
   */
  readonly toolCall: ToolCall | null;
  readonly text: string;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly cachedTokens?: number;
  readonly ms: number;
  /** True when the provider needed a repair retry to produce a valid value. */
  readonly repaired: boolean;
}

// ---------------------------------------------------------------------------
// Claims: the research substrate
// ---------------------------------------------------------------------------

export const CLAIM_KINDS = ["verified", "fact", "hypothesis", "mistake"] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

export const CLAIM_STATUS = ["active", "refuted", "superseded"] as const;
export type ClaimStatus = (typeof CLAIM_STATUS)[number];

/**
 * Provenance is declared, never inferred by embedding similarity: measured cosine
 * separation between agreement and contradiction was 0.017. See plan §6.
 */
export type ClaimSource =
  | { readonly kind: "self" }
  | { readonly kind: "board"; readonly postId: string }
  | { readonly kind: "agent"; readonly agent: string; readonly claimId: string };

export interface Claim {
  readonly id: string;
  readonly agent: string;
  readonly day: number;
  readonly text: string;
  readonly kind: ClaimKind;
  readonly confidence: number;
  readonly source: ClaimSource;
  readonly evidence: readonly string[];
  readonly status: ClaimStatus;
  readonly createdTick: number;
  readonly retiredTick: number | null;
  /** Null when the relationship was declared; else the judge model that inferred it. */
  readonly inferredBy: string | null;
}
