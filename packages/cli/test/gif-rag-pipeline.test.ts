/**
 * Regression: `build --gif` of the rag-pipeline example failed with export/encode-failed
 * ("recursive use of an object ... rust"): the camera zooms in during the loop, and resvg-wasm
 * panics on node icons (clipped symbol uses) far outside the zoomed canvas.
 */
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";
import { defaultDeps, run } from "../src/index.js";

const spec = fileURLToPath(new URL("../../../examples/rag-pipeline.cosmo.json", import.meta.url));
const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function gif(): Promise<Buffer> {
  const out = await mkdtemp(join(tmpdir(), "pcosmo-gif-"));
  const packs = await mkdtemp(join(tmpdir(), "pcosmo-gif-packs-"));
  dirs.push(out, packs);
  const r = await run(["build", spec, "--gif", "-o", out, "--name", "rag", "--packs-dir", packs], {
    ...defaultDeps(),
    env: {},
  });
  expect(r.code, `${r.stdout}${r.stderr}`).toBe(0);
  expect(await readdir(out)).toContain("rag.gif");
  return readFile(join(out, "rag.gif"));
}

test("rag-pipeline exports a deterministic GIF at the default fps", async () => {
  const a = await gif();
  expect(a.subarray(0, 6).toString("latin1")).toBe("GIF89a");
  expect(Buffer.compare(a, await gif())).toBe(0);
}, 600_000);
