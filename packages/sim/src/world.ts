/**
 * World construction from `worlds/island/world.json`.
 *
 * Pure: same config in, same world out — no clock, no randomness beyond the seed, no
 * file or network access beyond the config object the caller passes in.
 *
 * Identity: every entity is addressed by its `name`. Rapier handles are raw bit
 * patterns and must never be compared, sorted as numbers, or persisted.
 */

import RAPIER from "@dimforge/rapier3d-compat";

import {
  type EntityKind,
  type MotionProfile,
  type Vec3,
  DEFAULT_MOTION,
} from "@whisperwind/core";

export interface MesaConfig {
  readonly name: string;
  readonly position: Vec3;
  readonly halfExtents: Vec3;
}

export interface EntityConfig {
  readonly name: string;
  readonly kind: EntityKind;
  readonly position: Vec3;
  readonly halfExtents: Vec3;
}

export interface CubesConfig {
  readonly count: number;
  readonly halfExtents: Vec3;
  readonly firstPosition: Vec3;
  readonly spacing: Vec3;
  readonly perRow: number;
}

export interface WorldFile {
  readonly name: string;
  readonly seed: number;
  readonly motion: MotionProfile;
  readonly spawnRadius: number;
  readonly bounds: { readonly halfExtent: number; readonly groundY: number };
  readonly mesas: readonly MesaConfig[];
  readonly entities: readonly EntityConfig[];
  readonly cubes: CubesConfig;
}

/** A body the sim tracks by name. */
export interface Tracked {
  readonly name: string;
  readonly kind: EntityKind;
  readonly body: RAPIER.RigidBody;
  /** Half extents, for reach and stacking maths. */
  readonly half: Vec3;
}

export interface AgentBody {
  readonly name: string;
  readonly body: RAPIER.RigidBody;
  /** Name of the held entity, or null. Mutated by Pickup/Place/Throw. */
  held: string | null;
}

export interface Island {
  readonly world: RAPIER.World;
  readonly motion: MotionProfile;
  readonly mesas: readonly Tracked[];
  readonly entities: readonly Tracked[];
  /** Entities agents can pick up (cubes, rock, ring). Keyed by name. */
  readonly items: ReadonlyMap<string, Tracked>;
  readonly agents: readonly AgentBody[];
  readonly bounds: { readonly halfExtent: number; readonly groundY: number };
  readonly spawnRadius: number;
  /** Deterministic counter for entities created at run time (impact cubes). */
  nextImpactBlockId: number;
}

const CUBE_COLORS: readonly [number, number, number][] = [
  [0.784, 0.627, 0.392],
  [0.6, 0.7, 0.5],
  [0.7, 0.55, 0.45],
];

let initialised = false;

/** Rapier's WASM module must be initialised once per process. */
export async function initPhysics(): Promise<void> {
  if (initialised) return;
  await RAPIER.init();
  initialised = true;
}

function cuboid(half: Vec3): RAPIER.ColliderDesc {
  return RAPIER.ColliderDesc.cuboid(half[0], half[1], half[2]);
}

/**
 * Build the island. `agentNames` fixes the number and order of bodies, which is part
 * of the replay contract: the same names in the same order must always produce the
 * same world.
 */
export function buildIsland(config: WorldFile, agentNames: readonly string[]): Island {
  const motion = config.motion ?? DEFAULT_MOTION;
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = 1 / motion.tickRate;

  // Ground: a slab whose top surface sits at groundY.
  const groundHalf: Vec3 = [config.bounds.halfExtent, 1, config.bounds.halfExtent];
  const ground = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(0, config.bounds.groundY - 1, 0),
  );
  world.createCollider(cuboid(groundHalf).setFriction(0.9), ground);
  const groundTracked: Tracked = { name: "Ground", kind: "ground", body: ground, half: groundHalf };

  const mesas: Tracked[] = [];
  for (const m of config.mesas) {
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(...m.position));
    world.createCollider(cuboid(m.halfExtents).setFriction(0.9), body);
    mesas.push({ name: m.name, kind: "mesa", body, half: m.halfExtents });
  }

  const items = new Map<string, Tracked>();
  const entities: Tracked[] = [];

  // Cubes are laid out deterministically from the config, never from RNG.
  const cubeHalf = config.cubes.halfExtents;
  for (let i = 0; i < config.cubes.count; i++) {
    const row = Math.floor(i / config.cubes.perRow);
    const col = i % config.cubes.perRow;
    const pos: Vec3 = [
      config.cubes.firstPosition[0] + col * config.cubes.spacing[0],
      config.cubes.firstPosition[1],
      config.cubes.firstPosition[2] + row * config.cubes.spacing[2],
    ];
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(...pos)
        .setLinearDamping(0.05)
        .setAngularDamping(0.3),
    );
    world.createCollider(cuboid(cubeHalf).setRestitution(0.2).setFriction(0.8), body);
    const tracked: Tracked = { name: `Cube_${i + 1}`, kind: "block", body, half: cubeHalf };
    entities.push(tracked);
    items.set(tracked.name, tracked);
  }

  for (const e of config.entities) {
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(...e.position)
        .setLinearDamping(0.02)
        .setAngularDamping(0.2),
    );
    // The rock is heavy: it is the only object that generates cubes on impact.
    const density = e.kind === "rock" ? 8 : 1;
    world.createCollider(cuboid(e.halfExtents).setRestitution(0.2).setDensity(density), body);
    const tracked: Tracked = { name: e.name, kind: e.kind, body, half: e.halfExtents };
    entities.push(tracked);
    items.set(tracked.name, tracked);
  }

  // Agents spawn on a circle, evenly spaced, from the first angle. No RNG.
  const agents: AgentBody[] = agentNames.map((name, i) => {
    const angle = (i / Math.max(agentNames.length, 1)) * Math.PI * 2;
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(
        Math.cos(angle) * config.spawnRadius,
        config.bounds.groundY + 5,
        Math.sin(angle) * config.spawnRadius,
      ),
    );
    world.createCollider(RAPIER.ColliderDesc.capsule(0.75, 0.4).setFriction(0.5), body);
    return { name, body, held: null };
  });

  return {
    world,
    motion,
    mesas: [groundTracked, ...mesas],
    entities,
    items,
    agents,
    bounds: config.bounds,
    spawnRadius: config.spawnRadius,
    nextImpactBlockId: 0,
  };
}

export { CUBE_COLORS };
