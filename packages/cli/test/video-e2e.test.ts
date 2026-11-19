import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

vi.setConfig({ testTimeout: 240_000 });

const run = promisify(execFile);
const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const spec = fileURLToPath(new URL("../../../examples/load-balancing.cosmo.json", import.meta.url));

let dir = "";
let fakeBin = "";
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pcosmo-e2e-"));
  fakeBin = join(dir, "bin");
  await run("mkdir", [fakeBin]);
  // Fake ffmpeg: `-version` succeeds; otherwise it drains stdin, records the byte count and
  // writes the output file (the last argument). Needs only sh and wc.
  const script = [
    "#!/bin/sh",
    'if [ "$1" = "-version" ]; then echo fake; exit 0; fi',
    "for last; do :; done",
    `wc -c > "${dir}/stdin-bytes"`,
    'echo fake-mp4 > "$last"',
    "",
  ].join("\n");
  await writeFile(join(fakeBin, "ffmpeg"), script);
  await chmod(join(fakeBin, "ffmpeg"), 0o755);
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const pcosmo = (args: string[], env: NodeJS.ProcessEnv = process.env) =>
  run(process.execPath, [bin, "build", spec, ...args], { env, maxBuffer: 1 << 24 });

describe("default video exports on the launch examples (D33)", () => {
  test("--gif with default options succeeds and is deterministic", async () => {
    const a = join(dir, "a");
    const b = join(dir, "b");
    await pcosmo(["--gif", "-o", a]);
    await pcosmo(["--gif", "-o", b, "--duration", "3"]);
    // Determinism on the shared prefix: the 3 s clip equals a fresh 3 s clip.
    await pcosmo(["--gif", "-o", join(dir, "c"), "--duration", "3"]);
    expect(
      (await readFile(join(b, "load-balancing.gif"))).equals(
        await readFile(join(dir, "c", "load-balancing.gif")),
      ),
    ).toBe(true);
    const ga = await readFile(join(a, "load-balancing.gif"));
    expect(ga.subarray(0, 6).toString()).toBe("GIF89a");
  });

  test("--mp4 with default options streams every frame to ffmpeg stdin", async () => {
    const out = join(dir, "m");
    await pcosmo(["--mp4", "-o", out], { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` });
    expect((await readFile(join(out, "load-balancing.mp4"), "utf8")).trim()).toBe("fake-mp4");
    const bytes = Number((await readFile(join(dir, "stdin-bytes"), "utf8")).trim());
    // 336 PNG frames of 1129x748 arrived; each is far smaller than raw RGBA but never empty.
    expect(bytes).toBeGreaterThan(336 * 1000);
  });
});
