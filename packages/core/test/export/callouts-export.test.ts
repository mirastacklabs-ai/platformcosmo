import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { render, validate, type RenderOptions, type RenderResult } from "../../src/index.js";
import { decodePng } from "../../src/export/png.js";
import { UNRENDERED } from "../../src/schema/unsupported.js";
import { fixtureTheme } from "../fixtures/theme.js";

// A2-7: the design examples that use callout flights and sub-builds (assemblies.md 19.5, plus a
// flight that is taken off again) through render(), in every output (section 12).

vi.setConfig({ testTimeout: 180_000 });

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const THEME = fixtureTheme();

// Build programs are still behind the Phase 2 guard (W-1 lifts it): lift it for this file, so the
// test runs the same code the lifted guard will. It is a plain object; restored afterwards.
const guard = UNRENDERED as unknown as Record<string, boolean>;
const was = { ...guard };
beforeAll(() => {
  guard.phase2 = false;
});
afterAll(() => {
  Object.assign(guard, was);
});

/** The brick rover of 19.5, with boxes for bricks (core has no brick pack). */
const rover = (): Obj => {
  const md = readFileSync(
    new URL("../../../../docs/design/assemblies.md", import.meta.url),
    "utf8",
  );
  const s = [...md.matchAll(/```json\n([\s\S]*?)```/g)]
    .map((m) => JSON.parse(m[1] as string) as Obj)
    .find((x) => x.meta?.title === "Brick rover") as Obj;
  const strip = (o: unknown): void => {
    if (Array.isArray(o)) o.forEach(strip);
    else if (o !== null && typeof o === "object") {
      delete (o as Obj).shape;
      for (const v of Object.values(o)) strip(v);
    }
  };
  strip(s.assemblies);
  return s;
};

/** Two parts fly in from the callout, then fly out again (unbuild), then back. */
const flyer = (): Obj => ({
  meta: { version: "1", title: "Callout flights" },
  assemblies: [
    {
      id: "k",
      units: "tile",
      parts: [
        { id: "base", at: [0, 0, 0], size: [4, 4, 1] },
        { id: "a", at: [0, 0, 1], size: [1, 1, 1] },
        { id: "b", at: [2, 2, 1], size: [1, 1, 2] },
      ],
      programs: [
        {
          id: "bd",
          kind: "build",
          steps: [{ add: ["base"] }, { add: ["a", "b"], from: "callout" }],
        },
      ],
    },
  ],
  steps: [
    { duration: 4, assembly: [{ build: "k", program: "bd", to: 1 }] },
    { duration: 5, assembly: [{ build: "k", program: "bd" }] },
    { duration: 5, assembly: [{ unbuild: "k", program: "bd", to: 1 }] },
    { duration: 5, assembly: [{ build: "k", program: "bd" }] },
  ],
});

const run = (spec: Obj, o: RenderOptions = {}): Promise<RenderResult> =>
  render(spec, { theme: THEME, font: "system", ...o });
const text = (r: RenderResult, kind: string): string =>
  r.outputs.find((o) => o.kind === kind)!.data as string;
const pixels = (r: RenderResult): Uint8Array =>
  decodePng(r.outputs.find((o) => o.kind === "png")!.data as Uint8Array).data;
const same = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

describe("the examples are valid once the build guard is lifted", () => {
  test.each([
    ["Brick rover", rover],
    ["Callout flights", flyer],
  ])("%s", (_t, make) => {
    const r = validate(make());
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(r.diagnostics.filter((d) => d.code === "assembly/unsupported")).toEqual([]);
  });
});

describe("callouts and sub-builds in every output", () => {
  test.each([
    ["Brick rover", rover],
    ["Callout flights", flyer],
  ])("%s: animated, static, steps, interactive, png and gif", async (_t, make) => {
    const spec = make();
    const stepCount = (spec.steps as unknown[]).length;
    const r = await run(spec, {
      outputs: ["animated", "static", "steps", "interactive", "png", "gif"],
      png: { scale: 1 },
      video: { fps: 2, durationSec: 4 },
    });
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(r.outputs.map((o) => o.kind).sort()).toEqual(
      [
        "animated",
        "static",
        "interactive",
        "png",
        "gif",
        ...Array.from({ length: stepCount }, () => "steps"),
      ].sort(),
    );
    const animated = text(r, "animated");
    expect(animated).toMatch(/-fy_/); // the overlay copies
    expect(animated).toContain("@keyframes");
    expect(animated).toContain("prefers-reduced-motion");
    // the static output is the rest frame: the copies are there, hidden, and nothing moves
    const staticSvg = text(r, "static");
    expect(staticSvg).not.toContain("@keyframes");
    for (const m of staticSvg.matchAll(/<g[^>]*id="[^"]*-fy_[^"]*"[^>]*>/g)) {
      expect(m[0]).toContain('visibility="hidden"');
    }
    expect(text(r, "interactive")).toContain("@keyframes");
    const steps = r.outputs.filter((o) => o.kind === "steps");
    expect(steps).toHaveLength(stepCount);
    for (const s of steps) {
      // a step's end pose: every copy has landed, so every flight wrapper is hidden
      expect(s.data as string).not.toContain("@keyframes");
      for (const m of (s.data as string).matchAll(/<g[^>]*id="[^"]*-fy_[^"]*"[^>]*>/g)) {
        expect(m[0]).toContain('visibility="hidden"');
      }
    }
    const gif = r.outputs.find((o) => o.kind === "gif")!.data as Uint8Array;
    expect(String.fromCharCode(...gif.subarray(0, 6))).toBe("GIF89a");
    expect(
      decodePng(r.outputs.find((o) => o.kind === "png")!.data as Uint8Array).width,
    ).toBeGreaterThan(100);
  });

  test("a png taken during a flight shows the copy; before and after it does not", async () => {
    const spec = flyer();
    const at = async (time: number) =>
      pixels(await run(spec, { outputs: ["png"], png: { scale: 1, time } }));
    // the build step starts at 4 s: the copies fly [4, 4.7], then drop to the seat
    const before = await at(3.9);
    const flying = await at(4.3);
    const landed = await at(6);
    expect(same(before, flying)).toBe(false);
    expect(same(flying, landed)).toBe(false);
    // png.step N is the end pose: step 2 (copies seated) is the rest frame, step 3 (taken off) is
    // not (no captions in this spec, so only the model can differ)
    const rest = pixels(await run(spec, { outputs: ["png"], png: { scale: 1 } }));
    const s2 = pixels(await run(spec, { outputs: ["png"], png: { scale: 1, step: 2 } }));
    const s3 = pixels(await run(spec, { outputs: ["png"], png: { scale: 1, step: 3 } }));
    expect(same(s2, rest)).toBe(true);
    expect(same(s3, rest)).toBe(false);
  });

  test("the rover's cab: a png during the sub-build differs from the one after docking", async () => {
    const spec = rover();
    // action `to 6` plays in step 3 (loop 8 .. 14 s); the cab's own steps run first
    const during = pixels(await run(spec, { outputs: ["png"], png: { scale: 1, time: 9.5 } }));
    const docked = pixels(await run(spec, { outputs: ["png"], png: { scale: 1, step: 3 } }));
    expect(same(during, docked)).toBe(false);
  });

  test("deterministic: two renders are byte-identical", async () => {
    const a = await run(flyer(), { outputs: ["animated", "static", "steps"] });
    const b = await run(flyer(), { outputs: ["animated", "static", "steps"] });
    expect(a.outputs.map((o) => o.data)).toEqual(b.outputs.map((o) => o.data));
  });
});
