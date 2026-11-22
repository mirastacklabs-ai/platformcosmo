// D-4a: the end-to-end story of document ingestion §7.3 ("From the hall to the heat sink") through
// the real CLI with phase 2 lifted: validate, build every output, and PNGs at key times that show
// each level (hall, rack, server close-up, board, heat-sink figure close-up) and its cross-fades.
// Pixel checks count colours that only one level draws, so a level that renders empty, a figure
// drawn in the main scene, or a level pinned against the camera fails here.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import * as core from "@platformcosmo/core";
import { dcPack } from "@platformcosmo/dc-pack";
import { themeRegistry } from "@platformcosmo/themes";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { defaultDeps, run } from "../src/index.js";
import { badLabels } from "../../core/test/label-boxes.js";
// @ts-expect-error -- plain ESM script without types (the generator of the example's images)
import { stale } from "../../../scripts/gen-example-figures.mjs";

const SPEC = new URL("../../../examples/hall-to-heatsink.cosmo.json", import.meta.url);
const INSTANCE = "r2/srv/closeup/board/cpu-1/closeup";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pcosmo-story-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const deps = (): ReturnType<typeof defaultDeps> => ({ ...defaultDeps(), env: {}, cwd: dir });

interface Raster {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/** Decodes an 8-bit RGB/RGBA non-interlaced PNG (what resvg writes). */
function decode(bytes: Uint8Array): Raster {
  const b = Buffer.from(bytes);
  const width = b.readUInt32BE(16);
  const height = b.readUInt32BE(20);
  const bpp = b[25] === 6 ? 4 : 3;
  const idat: Buffer[] = [];
  for (let p = 8; p < b.length;) {
    const len = b.readUInt32BE(p);
    if (b.toString("latin1", p + 4, p + 8) === "IDAT") idat.push(b.subarray(p + 8, p + 8 + len));
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const data = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)] as number;
    const line = Uint8Array.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? (line[x - bpp] as number) : 0;
      const up = prev[x] as number;
      const c = x >= bpp ? (prev[x - bpp] as number) : 0;
      let v = line[x] as number;
      if (f === 1) v += a;
      else if (f === 2) v += up;
      else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) {
        const p = a + up - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      }
      line[x] = v & 255;
    }
    for (let x = 0; x < width; x++) {
      data.set(line.subarray(x * bpp, x * bpp + 3), (y * width + x) * 4);
      data[(y * width + x) * 4 + 3] = bpp === 4 ? (line[x * bpp + 3] as number) : 255;
    }
    prev = line;
  }
  return { width, height, data };
}

/** Pixels within `tol` (per channel) of an RGB colour. */
function count(r: Raster, rgb: readonly [number, number, number], tol = 6): number {
  let n = 0;
  for (let i = 0; i < r.width * r.height; i++) {
    const k = i * 4;
    if (
      Math.abs((r.data[k] as number) - rgb[0]) <= tol &&
      Math.abs((r.data[k + 1] as number) - rgb[1]) <= tol &&
      Math.abs((r.data[k + 2] as number) - rgb[2]) <= tol
    )
      n++;
  }
  return n;
}

// Colours only one level draws (light theme): the figure's synthetic board and heat-sink top
// (scripts/gen-example-figures.mjs), the board plan's green PCB in the server close-up, and the
// hall's floor tiles.
const FIG_BOARD = [214, 233, 214] as const;
const FIG_TOP = [232, 236, 241] as const;

async function png(args: string[], name: string): Promise<Raster> {
  const r = await run(
    ["build", SPEC.pathname, "-o", dir, "--name", name, "--png", "--no-animated", ...args],
    deps(),
  );
  expect(r.code, r.stderr).toBe(0);
  return decode(await readFile(join(dir, `${name}.png`)));
}

describe("From the hall to the heat sink (ingestion §7.3) through the CLI", () => {
  test("validate: exit 0, no errors and no warnings", async () => {
    const r = await run(["validate", SPEC.pathname, "--json"], deps());
    const j = JSON.parse(r.stdout) as { valid: boolean; diagnostics: core.Diagnostic[] };
    expect(r.code).toBe(0);
    expect(j.valid).toBe(true);
    expect(j.diagnostics.filter((d) => d.severity !== "info")).toEqual([]);
  });

  test("build: animated, static, steps, interactive and PNG, deterministic", async () => {
    const args = ["build", SPEC.pathname, "-o", dir, "--static", "--steps", "--interactive"];
    const a = await run([...args, "--name", "a"], deps());
    expect(a.code, a.stderr).toBe(0);
    expect(a.stderr).not.toMatch(/^(warning|error) /m);
    const b = await run([...args, "--name", "b"], deps());
    expect(b.code).toBe(0);
    for (const ext of ["svg", "static.svg", "interactive.svg"]) {
      const x = await readFile(join(dir, `a.${ext}`), "utf8");
      expect(x === (await readFile(join(dir, `b.${ext}`), "utf8")), ext).toBe(true);
    }
    // one SVG per step
    const steps = JSON.parse(await readFile(SPEC, "utf8")).steps as unknown[];
    for (let i = 1; i <= steps.length; i++) {
      const f = join(dir, "a.steps", `step-${String(i).padStart(2, "0")}.svg`);
      expect((await readFile(f, "utf8")).startsWith("<svg"), f).toBe(true);
    }
  }, 300000);

  test("PNG at key times: each level shows, and only at its own steps", async () => {
    // t = 0: the hall (no level, no figure panel in the main scene)
    const hall = await png(["--time", "0"], "t0");
    expect(count(hall, FIG_BOARD)).toBe(0);
    // t = 12: building the server (its close-up level); no figure yet
    const server = await png(["--time", "12"], "t12");
    expect(count(server, FIG_BOARD)).toBe(0);
    // t = 21: the heat-sink figure close-up, heat sinks seated on the synthetic board
    const sink = await png(["--time", "21"], "t21");
    expect(count(sink, FIG_BOARD)).toBeGreaterThan(20000);
    expect(count(sink, FIG_TOP)).toBeGreaterThan(2000);
    // t = 29: back in the hall, the figure has gone again
    const back = await png(["--time", "29"], "t29");
    expect(count(back, FIG_BOARD)).toBe(0);
  }, 300000);

  test("PNG at step ends: the board step zooms inside the server close-up", async () => {
    // the level group sits in the camera (§8.4): the board step's zoom magnifies it, so its
    // pixels differ from the build step's end; a level pinned against the camera would not move
    const built = await png(["--png-step", "4"], "s4");
    const board = await png(["--png-step", "5"], "s5");
    let diff = 0;
    for (let i = 0; i < built.data.length; i += 4) {
      if (Math.abs((built.data[i] as number) - (board.data[i] as number)) > 24) diff++;
    }
    expect(diff).toBeGreaterThan(built.width * built.height * 0.2);
  }, 300000);
});

/** The top-left pixel (RGB) of every frame of a GIF this CLI wrote (full frames, gifenc). */
function gifCorners(bytes: Uint8Array): [number, number, number][] {
  const b = Buffer.from(bytes);
  let p = 6;
  const packed = b[p + 4] as number;
  p += 7;
  let global: Buffer | undefined;
  if (packed & 0x80) {
    const n = 3 * 2 ** ((packed & 7) + 1);
    global = b.subarray(p, p + n);
    p += n;
  }
  const out: [number, number, number][] = [];
  while (p < b.length) {
    const tag = b[p];
    if (tag === 0x3b) break;
    if (tag === 0x21) {
      p += 2;
      while ((b[p] as number) > 0) p += (b[p] as number) + 1;
      p += 1;
      continue;
    }
    if (tag !== 0x2c) throw new Error(`unexpected GIF block ${tag}`);
    const ip = b[p + 9] as number;
    p += 10;
    let table = global;
    if (ip & 0x80) {
      const n = 3 * 2 ** ((ip & 7) + 1);
      table = b.subarray(p, p + n);
      p += n;
    }
    const min = b[p] as number;
    p += 1;
    const data: Buffer[] = [];
    while ((b[p] as number) > 0) {
      data.push(b.subarray(p + 1, p + 1 + (b[p] as number)));
      p += (b[p] as number) + 1;
    }
    p += 1;
    // the first LZW codes: a clear code, then the first pixel's index
    const d = Buffer.concat(data);
    const clear = 1 << min;
    let bit = 0;
    const code = (): number => {
      let v = 0;
      for (let i = 0; i <= min; i++, bit++) v |= ((d[bit >> 3]! >> (bit & 7)) & 1) << i;
      return v;
    };
    let c = code();
    while (c === clear) c = code();
    const t = table as Buffer;
    out.push([t[3 * c]!, t[3 * c + 1]!, t[3 * c + 2]!]);
  }
  return out;
}

describe("the canvas background never fades behind a close-up (#121 re-check P1)", () => {
  test("PNG frames in a close-up are opaque, light and dark", async () => {
    for (const theme of ["light", "dark"]) {
      const rest = await png(["--time", "0", "--theme", theme], `bg0-${theme}`);
      const corner = Array.from(rest.data.subarray(0, 4));
      expect(corner[3]).toBe(255);
      for (const t of ["12", "20", "7.8", "18.6"]) {
        const r = await png(["--time", t, "--theme", theme], `bg${t}-${theme}`);
        let clear = 0;
        for (let i = 3; i < r.data.length; i += 4) if ((r.data[i] as number) < 255) clear++;
        expect(clear, `${theme} t=${t}: pixels with alpha < 255`).toBe(0);
        expect(Array.from(r.data.subarray(0, 4)), `${theme} t=${t} corner`).toEqual(corner);
      }
    }
  }, 300000);

  test("every GIF frame keeps the canvas colour in its corner", async () => {
    const r = await run(
      ["build", SPEC.pathname, "-o", dir, "--name", "gif", "--gif", "--fps", "1", "--no-animated"],
      deps(),
    );
    expect(r.code, r.stderr).toBe(0);
    const corners = gifCorners(await readFile(join(dir, "gif.gif")));
    expect(corners.length).toBeGreaterThan(30);
    for (const [i, c] of corners.entries()) expect(c, `frame ${i}`).toEqual(corners[0]);
  }, 300000);
});

describe("the story's model (core + DC pack)", () => {
  const images = (spec: core.PlatformCosmoSpec): core.ImageAssetResolver => {
    const map = new Map<string, core.ImageAsset>();
    for (const im of spec.images ?? []) {
      const bytes = Buffer.from(im.src.slice(im.src.indexOf(",") + 1), "base64");
      const r = core.prepareImage(
        { key: im.id, src: `${im.id}.png`, bytes },
        core.DEFAULT_IMAGE_LIMITS,
      );
      if (r.asset !== undefined) map.set(im.id, r.asset);
    }
    return { get: (k) => map.get(k), keys: () => [...map.keys()].sort() };
  };
  const model = async (): Promise<core.RenderModel> => {
    const spec = JSON.parse(await readFile(SPEC, "utf8")) as core.PlatformCosmoSpec;
    const imgs = images(spec);
    return core.buildModel({
      scene: core.buildScene(spec, { dc: dcPack, images: imgs }),
      theme: themeRegistry.get("light")!,
      font: "system",
      prefix: "pc-t",
      spec,
      images: imgs,
    });
  };

  test("the figure is a close-up only, and its instance has its own pose", async () => {
    const m = await model();
    const sa = m.scene.assemblies!;
    expect(sa.boards).toEqual([]);
    const step = sa.plan[5]!;
    expect(step.actions.map((a) => [a.target, a.kind, a.from, a.to])).toEqual([
      [INSTANCE, "implode", 1, 0],
    ]);
    expect(sa.plan[4]!.poses[INSTANCE]).toEqual([{ program: "stages", level: 1 }]);
    expect(step.poses[INSTANCE]).toEqual([{ program: "stages", level: 0 }]);
  });

  test("the figure level draws the figure; levels are drawn at their own scale", async () => {
    const m = await model();
    const A = m.assembly!;
    const fig = A.levels!.find((l) => l.path === INSTANCE)!;
    const group = JSON.stringify(
      m.layers.overlay.find((n) => JSON.stringify(n).includes(fig.group)),
    );
    expect(group).toContain(A.ids.boardItem(INSTANCE, "s.hs-1"));
    // one socket, one heat sink: the close-up depicts exactly its host (cpu-1)
    expect(group).not.toContain(A.ids.boardItem(INSTANCE, "s.hs-2"));
    const poses = m.boards!.tracks(1).poses.map((p) => p.id);
    expect(poses).toContain(A.ids.boardItem(INSTANCE, "s.hs-1"));
    // the server level is magnified in its own projection; its overview places it about 1:1
    const srv = A.levels!.find((l) => l.path === "r2/srv/closeup")!;
    expect(srv.projection.tileWidth).toBeGreaterThan(4 * m.projection.tileWidth);
    expect(srv.overview.scale).toBeGreaterThan(0.8);
    expect(srv.overview.scale).toBeLessThanOrEqual(1);
    expect(fig.overview.scale).toBeGreaterThan(0.8);
  });

  test("the camera: no zoom on a level root, a zoom on a node inside a level", async () => {
    const m = await model();
    const v = (k: number): core.Rect | undefined =>
      core.createAnimator().animate(m, { speed: 1, mode: "step", step: k }).viewBox;
    expect(v(4)).toBeUndefined(); // r2/srv/closeup: the level at its overview
    expect(v(5)).toBeDefined(); // r2/srv/closeup/board: zoomed inside the level
    expect(v(5)!.width).toBeLessThan(m.viewBox.width);
    expect(v(6)).toBeUndefined(); // the figure close-up
  });

  test("level entries: the camera moves first, then the level grows with the camera still", async () => {
    const m = await model();
    const A = m.assembly!;
    const srv = A.levels!.find((l) => l.path === "r2/srv/closeup")!;
    const anim = core.createAnimator();
    const view = (t: number) => anim.animate(m, { speed: 1, mode: "frame", time: t }).viewBox;
    const op = (t: number) => A.frameAt(t).opacity[srv.group] ?? 0;
    // step 3 (zoomed on r2) -> step 4 (the server level): transition [7.2, 8.0], halves at 7.6
    expect(view(7.21)).toBeDefined(); // still zoomed on r2
    for (const t of [7.3, 7.45, 7.55]) expect(op(t), `level at ${t}`).toBe(0); // camera moves
    expect(view(7.6)).toBeUndefined(); // the camera is home before the level shows
    for (const t of [7.7, 7.8, 7.9]) {
      expect(view(t), `camera at ${t}`).toBeUndefined();
      expect(op(t)).toBeGreaterThan(0);
    }
    // step 7 (server level) -> step 8 (zoomed on r2): the level shrinks first, then the camera
    // moves: transition [26.25, 27.0], halves at 26.625
    for (const t of [26.3, 26.5, 26.6]) expect(view(t), `camera at ${t}`).toBeUndefined();
    expect(op(26.3)).toBeGreaterThan(0);
    for (const t of [26.7, 26.9]) expect(op(t)).toBe(0);
    expect(view(26.9)).toBeDefined();
  });

  test("a parent level holds its pose while a child grows out of it, and on the way back", async () => {
    const m = await model();
    const A = m.assembly!;
    const srv = A.levels!.find((l) => l.path === "r2/srv/closeup")!;
    const fig = A.levels!.find((l) => l.path === INSTANCE)!;
    const tf = (t: number) => A.frameAt(t).transforms[srv.group];
    const hold = tf(18.0);
    // step 5 -> 6 (into the figure): [18.25, 19.0]; step 6 -> 7 (back): [23.25, 24.0]
    for (const t of [18.3, 18.45, 18.6, 18.75, 18.9, 23.3, 23.45, 23.5, 23.75, 23.9])
      expect(tf(t), `server placement at ${t}`).toBe(hold);
    // ...while the figure grows (its placement changes) and the server fades out
    expect(A.frameAt(18.7).transforms[fig.group]).not.toBe(A.frameAt(18.9).transforms[fig.group]);
    expect(A.frameAt(18.9).opacity[srv.group]!).toBeLessThan(1);
  });

  test("labels: the board names its CPUs; a DIMM bank has one label; none is cut or under the caption", async () => {
    const m = await model();
    const A = m.assembly!;
    const srv = A.levels!.find((l) => l.path === "r2/srv/closeup")!;
    type LT = { id: string; path: string; kind: string; opacity: { t: number; opacity: number }[] };
    const tracks = (srv.model as unknown as { labelTracks: LT[] }).labelTracks;
    const top = tracks.filter((t) => t.kind === "top");
    const cpu1 = top.find((t) => t.path === "r2/srv/closeup/board/cpu-1")!;
    expect(cpu1).toBeDefined();
    // shown at the board step (17 s), as the level draws it
    expect(srv.model!.frameAt(17).opacity[cpu1.id] ?? 1).toBe(1);
    const dimms = top.filter((t) => t.path.startsWith("r2/srv/closeup/board/dimm-bank-"));
    expect(dimms).toHaveLength(1);
    // every step, measured on the drawn labels: none visible is cut by the camera window or
    // covered by the caption (mid-step and at the settled end, camera still)
    const anim = core.createAnimator();
    for (const c of A.clock) {
      for (const t of [(c.start + c.end) / 2, c.end - 0.01]) {
        const v = anim.animate(m, { speed: 1, mode: "frame", time: t }).viewBox;
        expect(badLabels(m, t, v), `step ${c.step} at ${t}`).toEqual([]);
      }
    }
  });

  test("the example's synthetic images are what the committed generator draws", async () => {
    expect(stale(await readFile(SPEC, "utf8"))).toEqual([]);
  });
});
