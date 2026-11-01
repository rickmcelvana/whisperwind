/**
 * Run manifest: everything needed to explain what a run was, recorded once at start.
 *
 * A run whose model ids, probe results, or code version are unknown is not evidence.
 * This is written to `runs/<id>/manifest.json` before the first round.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type { AgentSpec, Capabilities } from "@whisperwind/core";

export interface ProviderEntry {
  readonly kind: string;
  readonly baseUrl: string;
}

export interface ManifestAgent {
  readonly name: string;
  readonly provider: string;
  readonly model: string;
  readonly think: boolean;
  /** Probe result recorded before the run, or null when it was skipped. */
  readonly capabilities: Capabilities | null;
}

export interface Manifest {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly createdAt: string;
  readonly world: { readonly name: string; readonly seed: number; readonly sha256: string };
  readonly rules: { readonly sha256: string; readonly ids: readonly string[] };
  readonly motion: { readonly tickRate: number; readonly walkSpeed: number };
  readonly agents: readonly ManifestAgent[];
  readonly providers: Readonly<Record<string, ProviderEntry>>;
  readonly decisionBudget: number;
  readonly days: number;
  readonly node: string;
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export interface BuildManifestInput {
  readonly runId: string;
  readonly now: Date;
  readonly worldPath: string;
  readonly worldName: string;
  readonly seed: number;
  readonly rulesPath: string;
  readonly ruleIds: readonly string[];
  readonly tickRate: number;
  readonly walkSpeed: number;
  readonly agents: readonly ManifestAgent[];
  readonly providers: Readonly<Record<string, ProviderEntry>>;
  readonly decisionBudget: number;
  readonly days: number;
}

export function buildManifest(input: BuildManifestInput): Manifest {
  return {
    schemaVersion: 1,
    runId: input.runId,
    createdAt: input.now.toISOString(),
    world: {
      name: input.worldName,
      seed: input.seed,
      sha256: sha256File(input.worldPath),
    },
    rules: { sha256: sha256File(input.rulesPath), ids: input.ruleIds },
    motion: { tickRate: input.tickRate, walkSpeed: input.walkSpeed },
    agents: input.agents,
    providers: input.providers,
    decisionBudget: input.decisionBudget,
    days: input.days,
    node: process.version,
  };
}

/** Resolve the agent specs from parsed models.yaml into manifest entries. */
export function agentsFromSpecs(
  specs: readonly AgentSpec[],
  capabilities: ReadonlyMap<string, Capabilities | null>,
): readonly ManifestAgent[] {
  return specs.map((s) => ({
    name: s.name,
    provider: s.provider,
    model: s.model,
    think: s.think,
    capabilities: capabilities.get(s.name) ?? null,
  }));
}
