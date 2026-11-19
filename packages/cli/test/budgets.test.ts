/**
 * CI size and time budgets (PLAN section 6 "Budgets", section 15 "CI size budgets").
 * Renders through the same path as gallery generation (`pcosmo build` with the real bundled
 * packs, themes and DC pack, an empty user pack directory) so the numbers match examples/gallery.
 * Lives in the CLI package because the packs depend on core, so core's tests cannot load them.
 * No wall-clock flakiness: time is only asserted against a generous ceiling.
 */
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { defaultDeps, run } from "../src/index.js";

const examples = fileURLToPath(new URL("../../../examples/", import.meta.url));
const KB = 1024;
const TYPICAL_MAX = 150 * KB; // PLAN section 6: typical diagram under 150 KB
const DC_MAX = 300 * KB; // PLAN section 6 note: dc-hall is accepted at about 260 KB
const TIME_CEILING_MS = 2000; // PLAN says 500 ms; the test ceiling is generous on purpose
const ELEMENT_LIMIT = 5000; // PLAN section 6 hard limit

const LAUNCH = [
  "load-balancing",
  "rag-pipeline",
  "kubernetes-deployment",
  "cdn-cache",
  "gpu-inference-cluster",
] as const;

let work = "";
let packs = "";
beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "pcosmo-budget-out-"));
  packs = await mkdtemp(join(tmpdir(), "pcosmo-budget-packs-"));
  // Warm-up: the first build pays module init and font/WASM setup, which is not what we budget.
  const t0 = performance.now();
  await buildOnce("load-balancing");
  void t0;
}, 60_000);
afterAll(async () => {
  await Promise.all([work, packs].map((d) => rm(d, { recursive: true, force: true })));
});

const builds = new Map<string, ReturnType<typeof buildOnce>>();
/** Each example is built once per file; every test shares the result. */
const build = (name: string) => {
  let b = builds.get(name);
  if (!b) builds.set(name, (b = buildOnce(name)));
  return b;
};

async function buildOnce(name: string) {
  const out = join(work, name);
  const t0 = performance.now();
  const r = await run(
    ["build", `${examples}${name}.cosmo.json`, "-o", out, "--name", name, "--packs-dir", packs],
    { ...defaultDeps(), env: {} },
  );
  const ms = performance.now() - t0;
  expect(r.code, `${name}: ${r.stdout}${r.stderr}`).toBe(0);
  const svg = await readFile(join(out, `${name}.svg`));
  return { svg, ms };
}

/** Gallery files are the same render; they must stay within the same budget. */
const galleryBytes = (name: string) => stat(`${examples}gallery/${name}.svg`).then((s) => s.size);

describe("size budgets (PLAN section 6)", () => {
  test.each(LAUNCH)(
    "%s: animated SVG under 150 KB, element count under the hard limit",
    async (name) => {
      const { svg, ms } = await build(name);
      expect(svg.byteLength).toBeGreaterThan(1 * KB);
      expect(svg.byteLength, `${name} is ${(svg.byteLength / KB).toFixed(1)} KB`).toBeLessThan(
        TYPICAL_MAX,
      );
      // elements: count opening tags, a cheap proxy for the renderer's own element stat
      const elements = (svg.toString("utf8").match(/<[a-zA-Z]/g) ?? []).length;
      expect(elements).toBeLessThan(ELEMENT_LIMIT);
      // generous ceiling only; PLAN's 500 ms target is a measurement, not a CI assertion
      expect(ms, `${name} took ${ms.toFixed(0)} ms`).toBeLessThan(TIME_CEILING_MS);
    },
  );

  test("dc-hall: under 300 KB (accepted deviation, PLAN section 6 note)", async () => {
    const { svg, ms } = await build("dc-hall");
    expect(svg.byteLength, `dc-hall is ${(svg.byteLength / KB).toFixed(1)} KB`).toBeLessThan(
      DC_MAX,
    );
    expect((svg.toString("utf8").match(/<[a-zA-Z]/g) ?? []).length).toBeLessThan(ELEMENT_LIMIT);
    expect(ms, `dc-hall took ${ms.toFixed(0)} ms`).toBeLessThan(TIME_CEILING_MS * 4);
  });

  test.each([...LAUNCH, "dc-hall"])(
    "%s: the build matches the committed gallery render byte for byte",
    async (name) => {
      const { svg } = await build(name);
      expect(svg.byteLength).toBe(await galleryBytes(name));
      expect(svg.equals(await readFile(`${examples}gallery/${name}.svg`))).toBe(true);
    },
  );

  test("committed gallery renders respect the budgets too", async () => {
    for (const name of LAUNCH) expect(await galleryBytes(name), name).toBeLessThan(TYPICAL_MAX);
    expect(await galleryBytes("dc-hall")).toBeLessThan(DC_MAX);
  });
});
