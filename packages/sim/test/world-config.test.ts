import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ACTION_TYPES, DEFAULT_MOTION } from "@whisperwind/core";

const worldUrl = new URL("../../../worlds/island/world.json", import.meta.url);
const rulesUrl = new URL("../../../worlds/island/rules.json", import.meta.url);
const world = JSON.parse(readFileSync(fileURLToPath(worldUrl), "utf8"));
const rules = JSON.parse(readFileSync(fileURLToPath(rulesUrl), "utf8"));

test("world config parses and has the fields the sim requires", () => {
  assert.equal(typeof world.seed, "number");
  assert.equal(typeof world.spawnRadius, "number");
  assert.ok(Array.isArray(world.mesas) && world.mesas.length > 0);
  assert.ok(Array.isArray(world.entities));
  assert.equal(world.cubes.count, 12);
});

test("motion in the world file matches the shared default", () => {
  // Two sources of truth for physics constants would be a silent divergence.
  for (const [k, v] of Object.entries(DEFAULT_MOTION)) {
    assert.equal(world.motion[k], v, `world.motion.${k} drifted from DEFAULT_MOTION`);
  }
});

test("named high points exist and the Spire is the tallest", () => {
  const top = (name: string): number => {
    const mesa = world.mesas.find((m: { name: string }) => m.name === name);
    assert.ok(mesa, `${name} missing`);
    return mesa.position[1] + mesa.halfExtents[1];
  };
  assert.ok(
    top("Spire") > top("Peak"),
    "Spire must be taller than Peak for the climb arc to make sense",
  );
});

test("no mesa or entity overlaps a spawn point", () => {
  // Agents spawn on a circle of spawnRadius; a mesa there walls them in at tick 0.
  const r = world.spawnRadius;
  const points: [number, number][] = [];
  const agentCount = 5; // plan allows 1-5
  for (let i = 0; i < agentCount; i++) {
    const a = (i / agentCount) * Math.PI * 2;
    points.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  const solids = [
    ...world.mesas.map((m: { name: string; position: number[]; halfExtents: number[] }) => ({
      name: m.name,
      x: m.position[0],
      z: m.position[2],
      hx: m.halfExtents[0],
      hz: m.halfExtents[2],
    })),
    ...world.entities.map((e: { name: string; position: number[]; halfExtents: number[] }) => ({
      name: e.name,
      x: e.position[0],
      z: e.position[2],
      hx: e.halfExtents[0],
      hz: e.halfExtents[2],
    })),
  ];
  for (const [px, pz] of points) {
    for (const s of solids) {
      const inside = Math.abs(px - s.x) < s.hx + 1 && Math.abs(pz - s.z) < s.hz + 1;
      assert.ok(!inside, `spawn (${px.toFixed(1)}, ${pz.toFixed(1)}) is inside ${s.name}`);
    }
  }
});

test("every entity outside the cubes has an id-able unique name", () => {
  const names = [...world.mesas, ...world.entities].map((m: { name: string }) => m.name);
  assert.equal(new Set(names).size, names.length, "duplicate entity names break name-based identity");
});

test("rule ledger is well formed and every rule is distinct", () => {
  assert.equal(rules.version, 1);
  assert.ok(Array.isArray(rules.rules) && rules.rules.length > 0);
  const ids = rules.rules.map((r: { id: string }) => r.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate rule ids");
  for (const rule of rules.rules) {
    for (const field of ["id", "name", "status", "observable", "provenance", "probe"]) {
      assert.ok(rule[field] !== undefined, `${rule.id} missing ${field}`);
    }
    assert.ok(
      ["designed", "emergent", "new"].includes(rule.status),
      `${rule.id} has unknown status ${rule.status}`,
    );
  }
});

test("action types referenced by the ledger exist in the contract", () => {
  const used = new Set<string>();
  for (const rule of rules.rules) {
    const seq = rule.discovery?.sequence;
    if (Array.isArray(seq)) for (const a of seq) used.add(a);
  }
  for (const a of used) {
    assert.ok(
      (ACTION_TYPES as readonly string[]).includes(a),
      `ledger references unknown action ${a}`,
    );
  }
});
