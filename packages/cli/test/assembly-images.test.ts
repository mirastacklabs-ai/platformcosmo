import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodePng } from "@platformcosmo/assets";
import { describe, expect, test } from "vitest";
import { tmp } from "./helpers.js";

// An image on an assembly part is drawn by `pcosmo build` (assemblies §11): the CLI reads the
// file, core places it. Runs the built bin (requires `pnpm build`).
const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

const png = (): Uint8Array => {
  const data = new Uint8Array(8 * 4 * 4);
  for (let i = 0; i < 8 * 4; i++) data.set([20 + i, 60, 200, 255], i * 4);
  return encodePng({ width: 8, height: 4, data });
};

const spec = (part: Record<string, unknown>): string =>
  JSON.stringify({
    meta: { version: "1" },
    images: [{ id: "photo", src: "img/card.png", alt: "card" }],
    assemblies: [
      {
        id: "srv",
        units: "mm",
        parts: [
          { id: "base", shape: "box", at: [0, 0, 0], size: [100, 100, 10] },
          { id: "card", shape: "box", at: [10, 10, 10], size: [8, 60, 40], ...part },
        ],
      },
    ],
  });

async function build(
  part: Record<string, unknown>,
  withFile = true,
): Promise<{ svg: string; stderr: string; status: number | null }> {
  const dir = await tmp();
  await mkdir(join(dir, "img"));
  if (withFile) await writeFile(join(dir, "img", "card.png"), png());
  await writeFile(join(dir, "a.cosmo.json"), spec(part));
  const r = spawnSync(process.execPath, [bin, "build", "a.cosmo.json", "-o", "out", "--static"], {
    cwd: dir,
    encoding: "utf8",
  });
  let svg = "";
  try {
    svg = await readFile(join(dir, "out", "a.static.svg"), "utf8");
  } catch {
    // a failed build writes nothing
  }
  return { svg, stderr: r.stderr, status: r.status };
}

describe("assembly part images through the CLI", () => {
  const forms: [string, Record<string, unknown>][] = [
    ["object, face right", { image: { ref: "photo", face: "right", fit: "contain" } }],
    ["object, face billboard", { image: { ref: "photo", face: "billboard" } }],
    ["object, face top", { image: { ref: "photo", face: "top" } }],
    ["plain string", { image: "photo" }],
    ["sprite shape", { shape: "sprite", image: "photo" }],
  ];
  for (const [name, part] of forms) {
    test(`is drawn: ${name}`, async () => {
      const r = await build(part);
      expect(r.status).toBe(0);
      expect(r.svg).toContain("<image");
      expect(r.svg).toContain("data:image/png;base64,");
    });
  }

  test("a part image that cannot be read fails the build with a diagnostic, never silently", async () => {
    const r = await build({ image: "photo" }, false);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("image/not-found");
    expect(r.svg).toBe("");
  });
});
