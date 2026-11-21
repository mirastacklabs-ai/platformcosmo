import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { buildModelWithDiagnostics } from "../src/render/model.js";
import { buildScene, type PlatformCosmoSpec, type Rect, type RenderModel } from "../src/index.js";
import type { SvgElement, SvgNode } from "../src/index.js";
import { zoomFor } from "../src/anim/timeline.js";
import { assemblyStepEnd } from "../src/anim/assembly.js";
import type { AssemblyRenderModelX } from "../src/render/assembly/types.js";
import { evalOffset, evalOpacity, stepEndTime } from "../src/render/assembly/tracks.js";
import { fixtureTheme } from "./fixtures/theme.js";

// Labels must lie inside the frame in every pose and under every step camera (assemblies §10),
// and a requested label is either drawn or reported.

const fixture = (name: string): PlatformCosmoSpec =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/assembly/${name}.cosmo.json`, import.meta.url), "utf8"),
  ) as PlatformCosmoSpec;

function build(spec: PlatformCosmoSpec) {
  const scene = buildScene(spec, {});
  return buildModelWithDiagnostics({
    scene,
    theme: fixtureTheme(),
    font: "system",
    prefix: "pc-t",
    spec,
  });
}
const X = (m: RenderModel): AssemblyRenderModelX => m.assembly as AssemblyRenderModelX;
const isEl = (n: SvgNode): n is SvgElement => typeof n === "object" && "tag" in n;

/** Label (and leader) rect of a leader label group, in its own rest coordinates. */
function restRects(g: SvgElement): Rect[] {
  const out: Rect[] = [];
  for (const c of g.children ?? []) {
    if (!isEl(c)) continue;
    if (c.tag === "rect") {
      out.push({
        x: Number(c.attrs!.x),
        y: Number(c.attrs!.y),
        width: Number(c.attrs!.width),
        height: Number(c.attrs!.height),
      });
    } else if (c.tag === "path") {
      const n = String(c.attrs!.d)
        .match(/-?\d+(\.\d+)?/g)!
        .map(Number);
      // "M x y L x y", "M x y h dx", "M x y v dy" (compact forms)
      const d = String(c.attrs!.d);
      const [x0, y0] = n as [number, number];
      let x1 = n[2] as number;
      let y1 = n[3] as number;
      if (/[Hh]/.test(d)) {
        x1 = x0 + (n[2] as number);
        y1 = y0;
      } else if (/[Vv]/.test(d)) {
        x1 = x0;
        y1 = y0 + (n[2] as number);
      } else if (/[ml]/.test(d)) {
        x1 = x0 + (n[2] as number);
        y1 = y0 + (n[3] as number);
      }
      out.push({
        x: Math.min(x0, x1),
        y: Math.min(y0, y1),
        width: Math.abs(x1 - x0),
        height: Math.abs(y1 - y0),
      });
    }
  }
  return out;
}

function labelGroups(m: RenderModel): Map<string, SvgElement> {
  const groups = new Map<string, SvgElement>();
  const walk = (nodes: readonly SvgNode[]): void => {
    for (const n of nodes)
      if (isEl(n)) {
        if (typeof n.attrs?.id === "string") groups.set(n.attrs.id, n);
        walk(n.children ?? []);
      }
  };
  walk(m.layers.labels);
  return groups;
}

const inside = (r: Rect, v: Rect, slack = 0.5): boolean =>
  r.x >= v.x - slack &&
  r.y >= v.y - slack &&
  r.x + r.width <= v.x + v.width + slack &&
  r.y + r.height <= v.y + v.height + slack;

describe("labels stay inside the frame", () => {
  const m = build(fixture("engine-labels")).model;
  const a = X(m);
  const groups = labelGroups(m);
  const leader = a.labelTracks.filter((t) => !t.id.endsWith("__top"));

  test("every visible leader label and leader line lies inside the viewBox, at every instant", () => {
    let checked = 0;
    for (const lt of leader) {
      const rects = restRects(groups.get(lt.id)!);
      for (let k = 0; k <= 400; k++) {
        const t = (a.loop * k) / 400;
        if (evalOpacity(lt.opacity, t) <= 0) continue;
        const o = evalOffset(lt.motion, t);
        for (const r of rects) {
          expect(inside({ ...r, x: r.x + o.x, y: r.y + o.y }, m.viewBox)).toBe(true);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  test("under every step camera, the labels shown during the step are inside it", () => {
    let seen = 0;
    for (let n = 1; n <= m.scene.timeline.length; n++) {
      const cam = zoomFor(m, m.scene.timeline[n - 1])?.viewBox ?? m.viewBox;
      const c = a.clock[n - 1]!;
      // from the camera's arrival (the step's start) to the end of its hold, at several fractions
      for (const frac of [0, 0.25, 0.5, 0.75, 1]) {
        const t = c.start + (stepEndTime(c.end) - c.start) * frac;
        for (const lt of leader) {
          if (evalOpacity(lt.opacity, t) <= 0) continue;
          const o = evalOffset(lt.motion, t);
          for (const r of restRects(groups.get(lt.id)!)) {
            expect(inside({ ...r, x: r.x + o.x, y: r.y + o.y }, cam), `step ${n} @${frac}`).toBe(
              true,
            );
          }
          seen++;
        }
      }
    }
    expect(seen).toBeGreaterThan(20);
  });
});

describe("labels: always never drops a label silently", () => {
  const { model, diagnostics } = build(fixture("board-labels"));
  const a = X(model);

  test("the label of a part that starts moving exactly where a step ends is shown in that step", () => {
    // USB starts its lift at t = 4 s, the end of step 2 (the assembled pose)
    const top = a.labelTracks.find((t) => t.id.endsWith("pl_board.usb__top"))!;
    expect(top).toBeDefined();
    const attrs = assemblyStepEnd(model.assembly, 1, 2)!;
    expect(attrs[top.id]?.opacity).toBe(1);
  });

  test("every labelled leaf has a top-face label or an assembly/label-omitted diagnostic", () => {
    const omitted = new Set(
      diagnostics
        .filter((d) => d.code === "assembly/label-omitted")
        .map((d) => (d.params as { part: string }).part),
    );
    const tops = new Set(
      a.labelTracks
        .filter((t) => t.id.endsWith("__top"))
        .map((t) =>
          t.id
            .replace(/^.*pl_/, "")
            .replace(/__top$/, "")
            .replace(".", "/"),
        ),
    );
    const labelled = ["power", "cpu-1", "dimm-a", "usb", "jp1", "sata", "battery", "bios"];
    for (const id of labelled)
      expect(tops.has(`board/${id}`) || omitted.has(`board/${id}`)).toBe(true);
  });

  test("a label that cannot fit is reported, naming the part", () => {
    const spec = fixture("board-labels") as unknown as {
      assemblies: { parts: { id: string; size: number[]; label?: string }[] }[];
    };
    spec.assemblies[0]!.parts.push({
      id: "tiny",
      size: [2, 2, 2],
      label: "A rather long label",
      at: [5, 5, 2],
    } as never);
    const r = build(spec as unknown as PlatformCosmoSpec);
    const d = r.diagnostics.find((x) => x.code === "assembly/label-omitted");
    expect(d).toBeDefined();
    expect(d!.params).toMatchObject({ part: "board/tiny" });
  });
});

describe("a part image that cannot be placed is reported", () => {
  test("an image whose asset was not provided is image/not-found (error), with or without a crop", () => {
    const spec = {
      meta: { version: "1" },
      images: [{ id: "photo", src: "img/card.png" }],
      assemblies: [
        {
          id: "a",
          parts: [
            { id: "card", shape: "box", at: [0, 0, 0], size: [4, 4, 4], image: "photo" },
            {
              id: "cropped",
              shape: "box",
              at: [9, 0, 0],
              size: [4, 4, 4],
              image: { ref: "photo", crop: [0, 0, 8, 4] },
            },
          ],
        },
      ],
    } as unknown as PlatformCosmoSpec;
    const scene = buildScene(spec, {});
    const d = scene.diagnostics.filter((x) => x.code === "image/not-found");
    expect(d.map((x) => [x.severity, x.path])).toEqual([
      ["error", "/assemblies/0/parts/0/image"],
      ["error", "/assemblies/0/parts/1/image"],
    ]);
  });
});
