/**
 * Scenes for depth-epoch tests: the §9.7 worked proofs and the §19.3 engine. Inputs are built
 * directly from the contract types (`PartMove` → `toLoopMoves`), since A2-3 (which will produce
 * the moves) is not built yet. Distances follow §6.3 stacking by hand.
 */
import type { Box3, PartMove, Vec3 } from "../src/contracts/index.js";
import type { DepthItemInput, LoopMove } from "../src/depth/epochs.js";
import { toLoopMoves } from "../src/depth/epochs.js";
import { TRAY_WALL_RATIO, trayParts } from "../src/geometry/parts.js";
import type { Scene } from "./depth-zbuffer.js";
import { box, v } from "./depth-zbuffer.js";

function pm(
  path: string,
  offset: Vec3,
  start: number,
  duration: number,
  easing: PartMove["easing"] = "ease-in-out",
): PartMove {
  return { path, offset, start, duration, easing };
}

/** A program segment played as explode at `at` and, mirrored, as implode at `back`. */
function segment(moves: PartMove[], at: number, back: number, length: number): LoopMove[] {
  return [
    ...toLoopMoves(moves, { at, kind: "explode", length }),
    ...toLoopMoves(moves, { at: back, kind: "implode", length }),
  ];
}

// ---------------------------------------------------------------------------------------------
// Rack drawer (§9.7): a 1 × 1.2 × 3 rack, 8 devices, front door moved first, device s3 pulled.
// ---------------------------------------------------------------------------------------------

export function rackItems(withServerTray = false): DepthItemInput[] {
  const items: DepthItemInput[] = [];
  const add = (key: string, b: Box3, extra: Partial<DepthItemInput> = {}): void => {
    items.push({ key, path: key, box: b, solid: true, ...extra });
  };
  add("rack/post-fl", box(0, 1.1, 0.1, 0.08, 0.1, 2.8));
  add("rack/post-fr", box(0.92, 1.1, 0.1, 0.08, 0.1, 2.8));
  add("rack/post-rl", box(0, 0, 0.1, 0.08, 0.1, 2.8));
  add("rack/post-rr", box(0.92, 0, 0.1, 0.08, 0.1, 2.8));
  add("rack/cap", box(0, 0, 2.9, 1, 1.2, 0.1));
  add("rack/plinth", box(0, 0, 0, 1, 1.2, 0.1));
  add("rack/rear", box(0.08, 0, 0.1, 0.84, 0.02, 2.8));
  add("rack/door", box(0, 1.2, 0.1, 1, 0.04, 2.8));
  for (let k = 0; k < 8; k++) {
    const key = `rack/s${k}`;
    const b = box(0.08, 0.15, 0.2 + 0.33 * k, 0.84, 0.95, 0.25);
    if (k === 3 && withServerTray) {
      const parts = trayParts(b);
      items.push({
        key: `${key}__back`,
        path: key,
        leaf: key,
        box: b,
        boxes: parts.filter((p) => p.half === "back").map((p) => p.box),
      });
      items.push({
        key: `${key}__front`,
        path: key,
        leaf: key,
        box: b,
        boxes: parts.filter((p) => p.half === "front").map((p) => p.box),
      });
      // On the floor: the tray floor is as thick as its walls (TRAY_WALL_RATIO).
      const z = b.origin.z + Math.min(TRAY_WALL_RATIO * Math.min(b.size.x, b.size.y), b.size.z / 2);
      add(`${key}/board`, box(0.2, 0.3, z, 0.6, 0.65, 0.02));
      add(`${key}/cpu`, box(0.3, 0.4, z + 0.02, 0.15, 0.15, 0.08));
      add(`${key}/dimm`, box(0.55, 0.35, z + 0.02, 0.05, 0.3, 0.1));
      add(`${key}/fan`, box(0.3, 0.8, z + 0.02, 0.4, 0.08, 0.15));
    } else {
      add(key, b);
    }
  }
  return items;
}

/** Door out [0,1], s3 out [1,2] (drawer distance clears the front plane), back in [2,4]. */
export function rackDrawer(): Scene {
  const door = 1.19 + 0.1 + 0.1;
  const drawer = 1.24 - 0.15 + 0.1;
  return {
    items: rackItems(),
    moves: [
      ...segment([pm("rack/door", v(0, door, 0), 0, 1)], 0, 3, 1),
      ...segment([pm("rack/s3", v(0, drawer, 0), 0, 1)], 1, 2, 1),
    ],
    loop: 4,
  };
}

const lift = (at: number, back: number): LoopMove[] =>
  segment(
    [
      pm("rack/s3/board", v(0, 0, 0.3), 0, 1),
      pm("rack/s3/cpu", v(0, 0, 0.6), 0, 1),
      pm("rack/s3/dimm", v(0, 0, 0.6), 0, 1),
      pm("rack/s3/fan", v(0, 0, 0.75), 0, 1),
    ],
    at,
    back,
    1,
  );

/**
 * §9.7 "server internals on a pulled drawer": s3 is an open tray, the drawer is pulled and the
 * door open in the base pose (instant moves at t = 0, spec `pose`); the internals lift [0,1] and
 * settle [1,2].
 */
export function serverInternals(): Scene {
  const door = 1.19 + 0.1 + 0.1;
  const drawer = 1.24 - 0.15 + 0.1;
  const base = (path: string, to: Vec3): LoopMove => ({
    path,
    t0: 0,
    t1: 0,
    from: v(0, 0, 0),
    to,
    easing: "linear",
  });
  return {
    items: rackItems(true),
    moves: [base("rack/door", v(0, door, 0)), base("rack/s3", v(0, drawer, 0)), ...lift(0, 1)],
    loop: 2,
  };
}

/**
 * The same with the pull in the loop (rest → pulled → lifted). At rest the open tray's internals
 * are behind s4 (below it, z); lifted on the pulled drawer they are in front of it (y): an order
 * swap that needs a depth copy (Phase 3).
 */
export function serverInternalsFullLoop(): Scene {
  const door = 1.19 + 0.1 + 0.1;
  const drawer = 1.24 - 0.15 + 0.1;
  return {
    items: rackItems(true),
    moves: [
      ...segment([pm("rack/door", v(0, door, 0), 0, 1)], 0, 5, 1),
      ...segment([pm("rack/s3", v(0, drawer, 0), 0, 1)], 1, 4, 1),
      ...lift(2, 3),
    ],
    loop: 6,
  };
}

// ---------------------------------------------------------------------------------------------
// Engine (§19.3), mm → tiles at 1/80 (fit 6 tiles over 480 mm)
// ---------------------------------------------------------------------------------------------

const S = 1 / 80;
function mm(x: number, y: number, z: number, sx: number, sy: number, sz: number): Box3 {
  return box(x * S, y * S, z * S, sx * S, sy * S, sz * S);
}
function up(dz: number): Vec3 {
  return v(0, 0, dz * S);
}

export function engine(): Scene {
  const items: DepthItemInput[] = [];
  const add = (path: string, b: Box3, extra: Partial<DepthItemInput> = {}): void => {
    items.push({ key: `engine/${path}`, path: `engine/${path}`, box: b, solid: true, ...extra });
  };
  add("oil-pan", mm(20, 20, 0, 440, 180, 80));
  add("block", mm(0, 0, 80, 480, 220, 260));
  add("crankshaft", mm(10, 85, 100, 460, 50, 50));
  for (let k = 1; k <= 4; k++) {
    const dx = 110 * (k - 1);
    add(`pr-${k}/piston`, mm(45 + dx, 70, 250, 80, 80, 70));
    add(`pr-${k}/rod`, mm(75 + dx, 100, 140, 20, 20, 110));
  }
  add("head/casting", mm(0, 0, 340, 480, 220, 90));
  for (let k = 1; k <= 8; k++) {
    add(`head/valve-${k}`, mm(50 + 55 * (k - 1), 95, 380, 12, 12, 70), {
      inserts: "engine/head/casting",
    });
  }
  add("cam-intake", mm(10, 60, 450, 460, 30, 30));
  add("cam-exhaust", mm(10, 130, 450, 460, 30, 30));
  add("valve-cover", mm(10, 10, 430, 460, 200, 90));
  add("intake", mm(40, 220, 300, 400, 80, 100));
  add("exhaust", mm(40, -70, 300, 400, 70, 80));
  add("timing-belt", mm(-20, 30, 120, 20, 160, 330));

  // Stacking by max_z (§6.3, gap 40 mm): pistons 140 → max 460; head 160 → valves max 610;
  // cams 200 → 680; cover 290 → min 720. Crankshaft drops 110 below the block bottom.
  const stage1 = [
    pm("engine/valve-cover", up(290), 0, 0.8),
    pm("engine/timing-belt", v(-100 * S, 0, 0), 0.3, 0.8),
    pm("engine/oil-pan", up(-120), 0.6, 0.8),
  ];
  const stage2 = [
    pm("engine/head", up(160), 0, 1.5),
    pm("engine/cam-intake", up(200), 0, 1.5),
    pm("engine/cam-exhaust", up(200), 0, 1.5),
  ];
  const stage3 = [
    ...[1, 2, 3, 4].map((k) => pm(`engine/pr-${k}`, up(140), 0.1 * (k - 1), 1.5)),
    pm("engine/crankshaft", up(-110), 0, 1.5),
    pm("engine/intake", v(0, 120 * S, 0), 0, 1.5),
    pm("engine/exhaust", v(0, -110 * S, 0), 0, 1.5),
  ];
  return {
    items,
    moves: [
      ...segment(stage1, 2, 14.5, 1.4),
      ...segment(stage2, 4, 13, 1.5),
      ...segment(stage3, 7, 11, 1.8),
    ],
    loop: 16,
  };
}

// ---------------------------------------------------------------------------------------------
// Build drop (§9.7): three parts dropped from above, one per build step.
// ---------------------------------------------------------------------------------------------

export function buildDrop(): Scene {
  const drop = (path: string, at: number): LoopMove[] =>
    toLoopMoves([pm(path, v(0, 0, -2), 0, 1, "ease-in")], { at, kind: "build" });
  return {
    items: [
      { key: "kit/plate", path: "kit/plate", box: box(0, 0, 0, 3, 2, 0.2), solid: true },
      {
        key: "kit/a",
        path: "kit/a",
        box: box(0.2, 0.2, 0.2, 1, 1, 0.5),
        solid: true,
        present: [[1, 4]],
      },
      {
        key: "kit/b",
        path: "kit/b",
        box: box(0.2, 0.2, 0.7, 1, 1, 0.5),
        solid: true,
        present: [[2, 4]],
      },
      {
        key: "kit/c",
        path: "kit/c",
        box: box(1.6, 0.4, 0.2, 1, 1, 0.8),
        solid: true,
        present: [[3, 4]],
      },
    ],
    moves: [...drop("kit/a", 1), ...drop("kit/b", 2), ...drop("kit/c", 3)],
    loop: 4,
  };
}
