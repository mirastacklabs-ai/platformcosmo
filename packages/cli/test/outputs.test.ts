import { execFileSync } from "node:child_process";
import { link, mkdir, readFile, readdir, rename, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { staleOutputs, writeSet } from "../src/outputs.js";
import { tmp } from "./helpers.js";

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

async function setup() {
  const root = await tmp();
  const outside = await tmp();
  await writeFile(join(outside, "victim"), "VICTIM");
  return { root, outside };
}

describe("writeSet", () => {
  test("writes the set, creates the directory, leaves no temp directory", async () => {
    const { root } = await setup();
    const r = await writeSet(root, "a/b", [
      { name: "base.png", data: bytes("B") },
      { name: "report.json", data: bytes("R") },
    ]);
    expect(r).toEqual({
      ok: true,
      written: [
        { name: "base.png", bytes: 1 },
        { name: "report.json", bytes: 1 },
      ],
    });
    expect((await readdir(join(root, "a/b"))).sort()).toEqual(["base.png", "report.json"]);
    expect(await readFile(join(root, "a/b/base.png"), "utf8")).toBe("B");
  });

  test("a hard link at an output name: the link target is untouched, the name is replaced", async () => {
    const { root, outside } = await setup();
    await mkdir(join(root, "d"));
    await link(join(outside, "victim"), join(root, "d", "base.png"));
    const r = await writeSet(root, "d", [{ name: "base.png", data: bytes("NEW") }]);
    expect(r.ok).toBe(true);
    expect(await readFile(join(outside, "victim"), "utf8")).toBe("VICTIM");
    expect(await readFile(join(root, "d", "base.png"), "utf8")).toBe("NEW");
    expect((await stat(join(root, "d", "base.png"))).nlink).toBe(1);
  });

  test("a FIFO at an output name does not hang and is replaced", async () => {
    const { root } = await setup();
    await mkdir(join(root, "d"));
    execFileSync("mkfifo", [join(root, "d", "report.json")]);
    const r = await writeSet(root, "d", [{ name: "report.json", data: bytes("OK") }]);
    expect(r.ok).toBe(true);
    expect((await stat(join(root, "d", "report.json"))).isFile()).toBe(true);
  });

  test("a symlink at an output name is replaced, its target untouched", async () => {
    const { root, outside } = await setup();
    await mkdir(join(root, "d"));
    await symlink(join(outside, "victim"), join(root, "d", "base.png"));
    expect((await writeSet(root, "d", [{ name: "base.png", data: bytes("X") }])).ok).toBe(true);
    expect(await readFile(join(outside, "victim"), "utf8")).toBe("VICTIM");
  });

  test("a directory at an output name refuses the whole set", async () => {
    const { root } = await setup();
    await mkdir(join(root, "d/base.png"), { recursive: true });
    const r = await writeSet(root, "d", [
      { name: "report.json", data: bytes("R") },
      { name: "base.png", data: bytes("B") },
    ]);
    expect(r.ok).toBe(false);
    expect(await readdir(join(root, "d"))).toEqual(["base.png"]); // nothing else appeared
  });

  test("symlinked directories are refused", async () => {
    const { root, outside } = await setup();
    await symlink(outside, join(root, "link"));
    for (const dir of ["link", "link/sub"]) {
      expect((await writeSet(root, dir, [{ name: "a.png", data: bytes("A") }])).ok, dir).toBe(
        false,
      );
    }
    expect(await readdir(outside)).toEqual(["victim"]);
  });

  test("the directory swapped for a symlink after the files were staged: nothing lands outside", async () => {
    const { root, outside } = await setup();
    await mkdir(join(root, "d"));
    const r = await writeSet(
      root,
      "d",
      [
        { name: "base.png", data: bytes("B") },
        { name: "report.json", data: bytes("R") },
      ],
      {
        beforeRename: async () => {
          await rename(join(root, "d"), join(root, "d-moved"));
          await symlink(outside, join(root, "d"));
        },
      },
    );
    expect(r.ok).toBe(false);
    expect(await readdir(outside)).toEqual(["victim"]);
    // the set was never moved into place: the original directory has no final names
    const left = (await readdir(join(root, "d-moved"))).filter((n) => !n.startsWith(".pcosmo-"));
    expect(left).toEqual([]);
  });

  test("a refusal leaves earlier final names unchanged (no partial set)", async () => {
    const { root } = await setup();
    await mkdir(join(root, "d"));
    await writeFile(join(root, "d", "base.png"), "OLD");
    await mkdir(join(root, "d", "fragment.json"));
    const r = await writeSet(root, "d", [
      { name: "base.png", data: bytes("NEW") },
      { name: "fragment.json", data: bytes("F") },
    ]);
    expect(r.ok).toBe(false);
    expect(await readFile(join(root, "d", "base.png"), "utf8")).toBe("OLD");
  });

  test("odd names are refused", async () => {
    const { root } = await setup();
    for (const name of ["", ".", "..", "a/b", "a\\b", "a\0b", "x".repeat(300)]) {
      expect((await writeSet(root, "", [{ name, data: bytes("") }])).ok, JSON.stringify(name)).toBe(
        false,
      );
    }
    expect((await writeSet(root, "../x", [{ name: "a", data: bytes("") }])).ok).toBe(false);
    expect(
      (
        await writeSet(root, "", [
          { name: "a", data: bytes("") },
          { name: "a", data: bytes("") },
        ])
      ).ok,
    ).toBe(false);
  });
});

describe("staleOutputs", () => {
  test("lists earlier outputs this run did not write, deletes nothing", async () => {
    const { root } = await setup();
    for (const n of [
      "base.png",
      "sprite-1.png",
      "sprite-2.png",
      "report.json",
      "notes.txt",
      "sprite-x.png",
    ]) {
      await writeFile(join(root, n), "");
    }
    expect(await staleOutputs(root, new Set(["base.png", "sprite-1.png", "report.json"]))).toEqual([
      "sprite-2.png",
    ]);
    expect((await readdir(root)).length).toBe(6);
    expect(await staleOutputs(join(root, "missing"), new Set())).toEqual([]);
  });
});
