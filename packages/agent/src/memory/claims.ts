/**
 * Claim store: the research substrate.
 *
 * A claim is something an agent believes about the world, together with where the
 * belief came from. Provenance is *declared* by the agent, never inferred: measured
 * cosine similarity between agreeing and contradicting sentence pairs differed by
 * 0.017, below the spread within each group, so a similarity threshold would classify
 * contradictions as agreement and corrupt the headline metric (plan §6).
 *
 * What this makes answerable, as SQL rather than an LLM judge over transcripts:
 *   - adoption: how many agents hold a claim traceable to another agent's claim
 *   - falsification latency: retired_tick - created_tick
 *   - entrenchment: adopted false claims still active at the end of a run
 *   - propagation depth: a recursive walk over source_claim
 */

import { DatabaseSync } from "node:sqlite";

import {
  CLAIM_KINDS,
  CLAIM_STATUS,
  type Claim,
  type ClaimKind,
  type ClaimSource,
  type ClaimStatus,
} from "@whisperwind/core";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS claims (
  id            TEXT PRIMARY KEY,
  agent         TEXT NOT NULL,
  day           INTEGER NOT NULL,
  text          TEXT NOT NULL,
  kind          TEXT NOT NULL,
  confidence    REAL NOT NULL,
  source_kind   TEXT NOT NULL,
  source_agent  TEXT,
  source_claim  TEXT,
  source_post   TEXT,
  evidence      TEXT NOT NULL,
  inferred_by   TEXT,
  status        TEXT NOT NULL,
  created_tick  INTEGER NOT NULL,
  retired_tick  INTEGER
);
CREATE INDEX IF NOT EXISTS claims_by_agent ON claims(agent, status);
CREATE INDEX IF NOT EXISTS claims_by_source ON claims(source_claim);
CREATE INDEX IF NOT EXISTS claims_by_status ON claims(status);
`;

interface ClaimRow {
  readonly id: string;
  readonly agent: string;
  readonly day: number;
  readonly text: string;
  readonly kind: string;
  readonly confidence: number;
  readonly source_kind: string;
  readonly source_agent: string | null;
  readonly source_claim: string | null;
  readonly source_post: string | null;
  readonly evidence: string;
  readonly inferred_by: string | null;
  readonly status: string;
  readonly created_tick: number;
  readonly retired_tick: number | null;
}

export interface ClaimInput {
  readonly agent: string;
  readonly day: number;
  readonly text: string;
  readonly kind: ClaimKind;
  readonly confidence: number;
  readonly source: ClaimSource;
  readonly evidence: readonly string[];
  readonly createdTick: number;
  /** Only set when a judge model inferred the relationship instead of the agent declaring it. */
  readonly inferredBy?: string | null;
}

export class ClaimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaimError";
  }
}

function isClaimKind(v: string): v is ClaimKind {
  return (CLAIM_KINDS as readonly string[]).includes(v);
}

function isClaimStatus(v: string): v is ClaimStatus {
  return (CLAIM_STATUS as readonly string[]).includes(v);
}

function rowToClaim(row: ClaimRow): Claim {
  if (!isClaimKind(row.kind)) throw new ClaimError(`row ${row.id} has unknown kind ${row.kind}`);
  if (!isClaimStatus(row.status)) throw new ClaimError(`row ${row.id} has unknown status ${row.status}`);

  let source: ClaimSource;
  switch (row.source_kind) {
    case "self":
      source = { kind: "self" };
      break;
    case "board":
      if (!row.source_post) throw new ClaimError(`row ${row.id} is a board claim with no post id`);
      source = { kind: "board", postId: row.source_post };
      break;
    case "agent":
      if (!row.source_agent || !row.source_claim) {
        throw new ClaimError(`row ${row.id} is an agent claim with no agent or claim id`);
      }
      source = { kind: "agent", agent: row.source_agent, claimId: row.source_claim };
      break;
    default:
      throw new ClaimError(`row ${row.id} has unknown source kind ${row.source_kind}`);
  }

  return {
    id: row.id,
    agent: row.agent,
    day: row.day,
    text: row.text,
    kind: row.kind,
    confidence: row.confidence,
    source,
    evidence: JSON.parse(row.evidence) as string[],
    status: row.status,
    createdTick: row.created_tick,
    retiredTick: row.retired_tick,
    inferredBy: row.inferred_by,
  };
}

export interface AdoptionRow {
  readonly id: string;
  readonly agent: string;
  readonly sourceAgent: string;
  readonly sourceClaim: string;
  readonly status: ClaimStatus;
  readonly day: number;
}

export interface LatencyRow {
  readonly id: string;
  readonly agent: string;
  readonly kind: ClaimKind;
  readonly hoursHeld: number;
}

export interface PropagationRow {
  readonly id: string;
  readonly agent: string;
  readonly depth: number;
}

export class ClaimStore {
  private readonly db: DatabaseSync;

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /** Insert a claim. Returns the stored record, including its generated id. */
  add(input: ClaimInput, id?: string): Claim {
    if (input.text.trim().length === 0) throw new ClaimError("claim text is empty");
    if (input.confidence < 0 || input.confidence > 1) {
      throw new ClaimError(`confidence must be within [0,1], got ${input.confidence}`);
    }
    // An unevidenced belief self-attributed as verified or fact is downgraded to
    // hypothesis rather than rejected. Measured: models routinely omit evidence even
    // when instructed, so rejecting the claim loses the belief entirely and leaves a
    // stale false one in force — strictly worse than recording it honestly as weak.
    // The downgrade is visible in the stored kind, so analysis can still tell how much
    // of an agent's knowledge was asserted without support.
    let kind: ClaimKind = input.kind;
    if (input.source.kind === "self" && input.evidence.length === 0 && (kind === "verified" || kind === "fact")) {
      kind = "hypothesis";
    }

    const claimId = id ?? `c_${randomSuffix()}`;
    const sourceAgent = input.source.kind === "agent" ? input.source.agent : null;
    const sourceClaim = input.source.kind === "agent" ? input.source.claimId : null;
    const sourcePost = input.source.kind === "board" ? input.source.postId : null;

    // A declared agent source must point at a claim that exists, otherwise adoption
    // counts would include fabricated provenance.
    if (input.source.kind === "agent") {
      const parent = this.db.prepare("SELECT id FROM claims WHERE id = ?").get(input.source.claimId);
      if (!parent) {
        throw new ClaimError(
          `source claim ${input.source.claimId} does not exist; cite an id you actually read`,
        );
      }
    }

    this.db
      .prepare(
        `INSERT INTO claims
         (id, agent, day, text, kind, confidence, source_kind, source_agent, source_claim,
          source_post, evidence, inferred_by, status, created_tick, retired_tick)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL)`,
      )
      .run(
        claimId,
        input.agent,
        input.day,
        input.text,
        kind,
        input.confidence,
        input.source.kind,
        sourceAgent,
        sourceClaim,
        sourcePost,
        JSON.stringify(input.evidence),
        input.inferredBy ?? null,
        input.createdTick,
      );

    const claim = this.get(claimId);
    if (!claim) throw new ClaimError(`claim ${claimId} disappeared after insert`);
    return claim;
  }

  get(id: string): Claim | null {
    const row = this.db.prepare("SELECT * FROM claims WHERE id = ?").get(id);
    return row ? rowToClaim(row as unknown as ClaimRow) : null;
  }

  byAgent(agent: string, status?: ClaimStatus): readonly Claim[] {
    const rows = status
      ? this.db.prepare("SELECT * FROM claims WHERE agent = ? AND status = ? ORDER BY created_tick").all(agent, status)
      : this.db.prepare("SELECT * FROM claims WHERE agent = ? ORDER BY created_tick").all(agent);
    return rows.map((r) => rowToClaim(r as unknown as ClaimRow));
  }

  all(status?: ClaimStatus): readonly Claim[] {
    const rows = status
      ? this.db.prepare("SELECT * FROM claims WHERE status = ? ORDER BY created_tick").all(status)
      : this.db.prepare("SELECT * FROM claims ORDER BY created_tick").all();
    return rows.map((r) => rowToClaim(r as unknown as ClaimRow));
  }

  /**
   * Retire a claim. `refuted` means the agent tested it and the world disagreed;
   * `superseded` means it was replaced by a better belief. Both end its life, and the
   * difference matters: only `refuted` contributes to falsification latency.
   */
  retire(id: string, status: "refuted" | "superseded", tick: number): Claim {
    const existing = this.get(id);
    if (!existing) throw new ClaimError(`no claim ${id}`);
    if (existing.status !== "active") {
      throw new ClaimError(`claim ${id} is already ${existing.status}`);
    }
    if (tick < existing.createdTick) {
      throw new ClaimError(`cannot retire claim ${id} at tick ${tick} before it was created (${existing.createdTick})`);
    }
    this.db.prepare("UPDATE claims SET status = ?, retired_tick = ? WHERE id = ?").run(status, tick, id);
    const updated = this.get(id);
    if (!updated) throw new ClaimError(`claim ${id} disappeared`);
    return updated;
  }

  /**
   * Claims acquired from another agent, i.e. the adoption relation.
   * Only declared sources appear here; inferred ones are marked by inferred_by.
   */
  adoptions(): readonly AdoptionRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, agent, source_agent, source_claim, status, day
         FROM claims WHERE source_kind = 'agent' ORDER BY created_tick`,
      )
      .all();
    return rows.map((raw) => {
      const r = raw as Record<string, unknown>;
      const status = String(r["status"]);
      if (!isClaimStatus(status)) throw new ClaimError(`adoption row has unknown status ${status}`);
      return {
        id: String(r["id"]),
        agent: String(r["agent"]),
        sourceAgent: String(r["source_agent"]),
        sourceClaim: String(r["source_claim"]),
        status,
        day: Number(r["day"]),
      };
    });
  }

  /**
   * Falsification latency in sim hours, for refuted claims only.
   * This is the number the source experiment never measured: its weakest agent held a
   * false belief for the entire 30 hours.
   */
  falsificationLatency(hoursPerTick: number): readonly LatencyRow[] {
    if (hoursPerTick <= 0) throw new ClaimError("hoursPerTick must be positive");
    const rows = this.db
      .prepare(
        `SELECT id, agent, kind, created_tick, retired_tick
         FROM claims WHERE status = 'refuted' AND retired_tick IS NOT NULL
         ORDER BY (retired_tick - created_tick)`,
      )
      .all();
    return rows.map((raw) => {
      const r = raw as Record<string, unknown>;
      const kind = String(r["kind"]);
      if (!isClaimKind(kind)) throw new ClaimError(`latency row has unknown kind ${kind}`);
      const ticks = Number(r["retired_tick"]) - Number(r["created_tick"]);
      return {
        id: String(r["id"]),
        agent: String(r["agent"]),
        kind,
        hoursHeld: Math.round(ticks * hoursPerTick * 100) / 100,
      };
    });
  }

  /** Adopted `mistake` claims still active at `endTick`, with how long they survived. */
  entrenchment(endTick: number, hoursPerTick: number): readonly LatencyRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, agent, kind, created_tick, retired_tick
         FROM claims
         WHERE source_kind = 'agent' AND kind = 'mistake' AND status = 'active'
         ORDER BY created_tick`,
      )
      .all();
    return rows.map((raw) => {
      const r = raw as Record<string, unknown>;
      const ticks = endTick - Number(r["created_tick"]);
      return {
        id: String(r["id"]),
        agent: String(r["agent"]),
        kind: "mistake",
        hoursHeld: Math.round(ticks * hoursPerTick * 100) / 100,
      };
    });
  }

  /** Who holds a belief traceable to `rootId`, by hop count. */
  propagation(rootId: string): readonly PropagationRow[] {
    const rows = this.db
      .prepare(
        `WITH RECURSIVE tree(id, agent, depth) AS (
           SELECT id, agent, 0 FROM claims WHERE id = ?
           UNION ALL
           SELECT c.id, c.agent, t.depth + 1
           FROM claims c JOIN tree t ON c.source_claim = t.id
         )
         SELECT id, agent, depth FROM tree ORDER BY depth, agent`,
      )
      .all(rootId);
    return rows.map((raw) => {
      const r = raw as Record<string, unknown>;
      return { id: String(r["id"]), agent: String(r["agent"]), depth: Number(r["depth"]) };
    });
  }

  get size(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM claims").get();
    return row ? Number((row as Record<string, unknown>)["n"]) : 0;
  }
}

function randomSuffix(): string {
  // Deterministic tests pass an explicit id; this is only for live runs.
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
