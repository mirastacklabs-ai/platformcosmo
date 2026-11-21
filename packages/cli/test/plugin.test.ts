import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { tmp } from "./helpers.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const launcher = join(root, "plugin/bin/pcosmo");

describe("plugin launcher (POSIX sh)", () => {
  test("is executable and starts with a sh shebang", () => {
    expect(statSync(launcher).mode & 0o111).not.toBe(0);
    expect(readFileSync(launcher, "utf8").startsWith("#!/bin/sh\n")).toBe(true);
  });

  async function withNode(version: string | null): Promise<string> {
    const dir = await tmp();
    if (version) {
      const node = join(dir, "node");
      writeFileSync(
        node,
        `#!/bin/sh\n[ "$1" = "-p" ] && echo ${version} && exit 0\necho "ran-node $*"\n`,
      );
      chmodSync(node, 0o755);
    }
    return dir;
  }
  const runLauncher = (pathDir: string) =>
    spawnSync("/bin/sh", [launcher, "--version"], {
      encoding: "utf8",
      env: { PATH: `${pathDir}:/usr/bin:/bin`, HOME: "/nonexistent" },
    });

  test.each(["22.12.0", "22.20.1", "24.0.0", "30.1.2"])(
    "accepts Node %s and execs the bundle",
    async (v) => {
      const r = runLauncher(await withNode(v));
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("ran-node");
      expect(r.stdout).toContain("pcosmo.mjs --version");
    },
  );

  test.each(["20.18.0", "22.11.9", "18.0.0", "22.0.0"])("rejects Node %s", async (v) => {
    const r = runLauncher(await withNode(v));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("22.12 or newer is required");
    expect(r.stdout).toBe("");
  });

  test("rejects an unparseable version", async () => {
    const r = runLauncher(await withNode("v-banana"));
    expect(r.status).toBe(1);
  });

  test("explains a missing node", async () => {
    const dir = await withNode(null);
    const r = spawnSync("/bin/sh", [launcher], {
      encoding: "utf8",
      env: { PATH: `${dir}:/usr/bin:/bin`, HOME: "/nonexistent" },
    });
    expect(r.status).toBe(127);
    expect(r.stderr).toContain("Node.js 22.12 or newer is required");
  });

  test("gives up on a symlink loop", async () => {
    const dir = await withNode("24.0.0");
    execFileSync("ln", ["-s", join(dir, "b"), join(dir, "a")]);
    execFileSync("ln", ["-s", join(dir, "a"), join(dir, "b")]);
    // Run the launcher text with $0 pointing at the loop (a looping symlink cannot be exec'd directly).
    const r = spawnSync("/bin/sh", ["-c", readFileSync(launcher, "utf8"), join(dir, "a")], {
      encoding: "utf8",
      env: { PATH: `${dir}:/usr/bin:/bin`, HOME: "/nonexistent" },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("too many levels of symbolic links");
  });

  test("follows a symlink to the real location", async () => {
    const dir = await withNode("24.0.0");
    execFileSync("ln", ["-s", launcher, join(dir, "pcosmo")]);
    const r = spawnSync(join(dir, "pcosmo"), ["x"], {
      encoding: "utf8",
      env: { PATH: `${dir}:/usr/bin:/bin`, HOME: "/nonexistent" },
    });
    expect(r.stdout).toContain(join(root, "plugin/bin/pcosmo.mjs"));
  });
});

describe("plugin contents", () => {
  const skills = join(root, "plugin/skills");
  test("three skills with the required frontmatter", () => {
    expect(readdirSync(skills).sort()).toEqual(["diagram", "export", "icons"]);
    for (const s of ["diagram", "export", "icons"]) {
      const text = readFileSync(join(skills, s, "SKILL.md"), "utf8");
      const fm = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "";
      expect(fm, s).toContain(`name: ${s}`);
      expect(fm, s).toMatch(/^description: .{40,}/m);
      expect(fm, s).toContain("Bash(pcosmo ");
      expect(text.split("\n").length, s).toBeLessThan(500);
    }
    const icons = readFileSync(join(skills, "icons/SKILL.md"), "utf8");
    expect(icons).toContain("disable-model-invocation: true");
    expect(readFileSync(join(skills, "diagram/SKILL.md"), "utf8")).not.toContain(
      "disable-model-invocation",
    );
  });

  test("allowed-tools are narrow and every pack-resolving command passes --packs-dir", () => {
    for (const s of ["diagram", "export", "icons"]) {
      const text = readFileSync(join(skills, s, "SKILL.md"), "utf8");
      const tools = /^allowed-tools: (.*)$/m.exec(text)?.[1] ?? "";
      expect(tools, s).not.toMatch(/Bash\(pcosmo \*\)/);
      expect(tools, s).not.toMatch(/pcosmo\.mjs \*\)/);
      expect(tools, s).not.toMatch(/icons (remove|\*)/);
      expect(text, s).toContain('--packs-dir "${CLAUDE_PLUGIN_DATA}/icons"');
      // Fenced or inline command examples for validate/build must carry the flag.
      for (const m of text.matchAll(/`(pcosmo (?:validate|build) [^`]*)`/g)) {
        if (m[1]!.includes("<spec>") || m[1]!.includes("<name>")) {
          expect(m[1], `${s}: ${m[1]}`).toContain("--packs-dir");
        }
      }
    }
    const exp = readFileSync(join(skills, "export/SKILL.md"), "utf8");
    expect(/^allowed-tools: (.*)$/m.exec(exp)?.[1]).not.toMatch(/init|examples|icons/);
  });

  test("skill example specs are identical to /examples", () => {
    for (const f of readdirSync(join(skills, "diagram/examples"))) {
      expect(readFileSync(join(skills, "diagram/examples", f), "utf8")).toBe(
        readFileSync(join(root, "examples", f), "utf8"),
      );
    }
  });

  test("relative links in SKILL.md resolve", () => {
    for (const s of ["diagram", "export", "icons"]) {
      const text = readFileSync(join(skills, s, "SKILL.md"), "utf8");
      for (const m of text.matchAll(/\]\(((?:references|examples)\/[^)]+)\)/g)) {
        expect(existsSync(join(skills, s, m[1]!)), `${s}: ${m[1]}`).toBe(true);
      }
    }
  });

  test("plugin ships no package.json (a self-contained bundle)", () => {
    expect(existsSync(join(root, "plugin/package.json"))).toBe(false);
  });

  test("the bundle includes the shape packs and validates pack shapes", async () => {
    const bundle = join(root, "plugin/bin/pcosmo.mjs");
    const text = readFileSync(bundle, "utf8");
    for (const id of ["hw:dimm", "brick:brick", "auto:piston", "brick/off-grid"]) {
      expect(text.includes(id) || text.includes(id.replace(":", '"'))).toBe(true);
    }
    const dir = await tmp();
    const spec = join(dir, "x.cosmo.json");
    writeFileSync(
      spec,
      JSON.stringify({
        meta: { version: "1" },
        assemblies: [
          {
            id: "a",
            parts: [
              { id: "x", shape: "hw:dimn" },
              { id: "y", shape: "box" },
            ],
          },
        ],
      }),
    );
    const r = spawnSync(process.execPath, [bundle, "validate", spec], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("hw:dimm");
  });
});
