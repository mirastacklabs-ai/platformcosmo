import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { buildModelWithDiagnostics } from "../src/render/model.js";
import { buildScene, type PlatformCosmoSpec, type RenderModel, type Vec2 } from "../src/index.js";
import { createProjection, boxCorners } from "../src/geometry/index.js";
import type { Box3 } from "../src/contracts/index.js";
import type { AssemblyRenderModelX, LabelTrack } from "../src/render/assembly/types.js";
import {
  MoveIndex,
  evalOffset,
  evalOpacity,
  round2,
  stepEndTime,
} from "../src/render/assembly/tracks.js";
import { worldLeaves } from "../src/render/assembly/world.js";
import { fixtureTheme } from "./fixtures/theme.js";

// A leader label's leader ends ON its part's visible geometry at every instant the label shows
// (assemblies §6.6); a requested label is drawn or reported (§18).

const fixture = (name: string): PlatformCosmoSpec =>
  JSON.parse(
    readFileSync(
      new URL(`./fixtures/assembly/label-anchors-${name}.cosmo.json`, import.meta.url),
      "utf8",
    ),
  ) as PlatformCosmoSpec;

function build(name: string) {
  const spec = fixture(name);
  const scene = buildScene(spec, {});
  const r = buildModelWithDiagnostics({
    scene,
    theme: fixtureTheme(),
    font: "system",
    prefix: "pc-t",
    spec,
  });
  return { ...r, scene, a: r.model.assembly as AssemblyRenderModelX };
}

const projection = createProjection();
const tracksOf = (a: AssemblyRenderModelX): readonly LabelTrack[] =>
  a.labelTracks as unknown as readonly LabelTrack[];

/** Convex hull (monotone chain) of the projected corners of boxes. */
function hull(boxes: readonly Box3[], d: { x: number; y: number; z: number }): Vec2[] {
  const pts = boxes
    .flatMap((b) =>
      boxCorners({
        origin: { x: b.origin.x + d.x, y: b.origin.y + d.y, z: b.origin.z + d.z },
        size: b.size,
      }),
    )
    .map((c) => projection.project(c))
    .sort((p, q) => p.x - q.x || p.y - q.y);
  const cross = (o: Vec2, p: Vec2, q: Vec2): number =>
    (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const half = (list: Vec2[]): Vec2[] => {
    const out: Vec2[] = [];
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2]!, out[out.length - 1]!, p) <= 0)
        out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...half(pts), ...half([...pts].reverse())];
}

/** Distance-tolerant point-in-convex-polygon (inside or within `slack` of the outline). */
function inHull(poly: readonly Vec2[], p: Vec2, slack = 0.6): boolean {
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    if (((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / len < -slack) return false;
  }
  return true;
}

function anchored(name: string, partsOf?: (path: string) => boolean) {
  const { a, scene, model } = build(name) as ReturnType<typeof build> & { model: RenderModel };
  const index = new MoveIndex(a.moves);
  const leaves = worldLeaves(scene.assemblies!.assemblies);
  let checked = 0;
  const bad: string[] = [];
  for (const lt of tracksOf(a)) {
    if (lt.kind !== "leader" || lt.anchor === undefined) continue;
    if (partsOf !== undefined && !partsOf(lt.path)) continue;
    const own = leaves.filter((l) => l.path === lt.path || l.path.startsWith(`${lt.path}/`));
    for (let n = 1; n <= model.scene.timeline.length; n++) {
      const c = a.clock[n - 1]!;
      const t = stepEndTime(c.end);
      if (evalOpacity(lt.opacity, t) < 1) continue;
      const o = evalOffset(lt.motion, t);
      const p = { x: lt.anchor.x + o.x, y: lt.anchor.y + o.y };
      checked++;
      const on = own.some((l) =>
        inHull(
          hull(
            l.geometry.primitives.map((q) => q.box),
            index.displacement(l.path, t),
          ),
          p,
        ),
      );
      if (!on) bad.push(`${lt.path} step ${n}`);
    }
  }
  return { checked, bad, a, leaves, index, model };
}

describe("leader ends lie on the part's projected geometry at every step end", () => {
  for (const name of ["board", "engine", "gpu"]) {
    test(name, () => {
      const r = anchored(name);
      expect(r.checked).toBeGreaterThan(10);
      expect(r.bad).toEqual([]);
    });
  }
});

describe("leaders end on what shows, not on what covers it", () => {
  test("engine: the piston leaders end outside the head and gasket outlines in the last explode step", () => {
    const { a, leaves, index, model } = anchored("engine");
    const steps = model.scene.timeline.length;
    const t = stepEndTime(a.clock[steps - 2]!.end); // "Crankshaft and oil pan"
    let seen = 0;
    for (const lt of tracksOf(a)) {
      if (!/pl_engine\.pr-\d$/.test(lt.id)) continue;
      const o = evalOffset(lt.motion, t);
      const p = { x: lt.anchor!.x + o.x, y: lt.anchor!.y + o.y };
      for (const cover of ["engine/head", "engine/head-gasket"]) {
        const l = leaves.find((q) => q.path === cover)!;
        expect(
          inHull(hull([l.geometry.bounds], index.displacement(cover, t)), p, 0),
          `${lt.id} under ${cover}`,
        ).toBe(false);
      }
      seen++;
    }
    expect(seen).toBe(4);
  });

  test("gpu: the lid leader ends on the lid, however far it slid", () => {
    const r = anchored("gpu", (p) => p === "srv/lid");
    expect(r.checked).toBeGreaterThan(0);
    expect(r.bad).toEqual([]);
  });
});

describe("a requested label is drawn or reported", () => {
  test("gpu: the chassis tray never moves, so its label is reported", () => {
    const { diagnostics, a } = build("gpu");
    const d = diagnostics.find(
      (x) =>
        x.code === "assembly/label-omitted" &&
        (x.params as { part?: string }).part === "srv/chassis",
    );
    expect(d).toBeDefined();
    expect(tracksOf(a).some((t) => t.path === "srv/chassis")).toBe(false);
  });

  test("every labelled node is shown or reported", () => {
    for (const name of ["board", "engine", "gpu"]) {
      const { diagnostics, a, scene } = build(name);
      const reported = new Set(
        diagnostics
          .filter((x) => x.code === "assembly/label-omitted")
          .map((x) => (x.params as { part: string }).part),
      );
      const shown = new Set(tracksOf(a).map((t) => t.path));
      const walk = (
        n: NonNullable<typeof scene.assemblies>["assemblies"][number]["root"],
      ): void => {
        if (
          n.label !== undefined &&
          n.label !== "" &&
          n.path !== scene.assemblies!.assemblies[0]!.id
        )
          expect(shown.has(n.path) || reported.has(n.path), `${name} ${n.path}`).toBe(true);
        n.children.forEach(walk);
      };
      scene.assemblies!.assemblies.forEach((x) => walk(x.root));
    }
  });
});

describe("frame and track agree", () => {
  test("label transforms and opacities at sampled times", () => {
    const { a } = build("gpu");
    for (let k = 0; k <= 40; k++) {
      const t = (a.loop * k) / 40;
      const f = a.frameAt(t);
      for (const lt of tracksOf(a)) {
        expect(f.opacity[lt.id]).toBe(round2(evalOpacity(lt.opacity, t)));
        if (lt.motion.length > 0) {
          const v = evalOffset(lt.motion, t);
          expect(f.transforms[lt.id]).toBe(`translate(${round2(v.x)} ${round2(v.y)})`);
        }
      }
    }
  });
});
