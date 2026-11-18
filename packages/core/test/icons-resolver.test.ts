import { describe, expect, test } from "vitest";
import type { IconEntry, LoadedIconPack } from "../src/index.js";
import { createIconResolver, sanitizeSvg } from "../src/icons/index.js";

const svg = (inner: string) => `<svg viewBox="0 0 24 24">${inner}</svg>`;

function entry(id: string, extra: Partial<IconEntry> = {}): IconEntry {
  return { id, aliases: [], category: "general", file: `${id}.svg`, monochrome: true, ...extra };
}

function pack(
  id: string,
  icons: IconEntry[],
  extra: { defaults?: Record<string, string>; license?: string; attribution?: string } = {},
): LoadedIconPack {
  return {
    manifest: {
      manifestVersion: 1,
      pack: {
        id,
        name: id,
        version: "1.0.0",
        license: extra.license ?? "MIT",
        source: "https://example.com",
        redistributable: true,
        ...(extra.attribution ? { attribution: extra.attribution } : {}),
      },
      icons,
      ...(extra.defaults ? { defaults: extra.defaults } : {}),
    },
    files: Object.fromEntries(icons.map((e) => [e.file, svg('<path d="M0 0L1 1"/>')])),
  };
}

const base = pack(
  "cosmo",
  [
    entry("server", { aliases: ["host", "machine"], tags: ["compute"] }),
    entry("load-balancer", { aliases: ["lb"], category: "network" }),
    entry("database", { aliases: ["db", "sql"], tags: ["storage"] }),
  ],
  { defaults: { server: "cosmo:server", lb: "cosmo:load-balancer", sql: "cosmo:db" } },
);
const lucide = pack(
  "lucide",
  [entry("server"), entry("database"), entry("cloud", { aliases: ["remote"] })],
  {
    license: "ISC",
    attribution: "Lucide Contributors",
  },
);

describe("createIconResolver", () => {
  const r = createIconResolver([base, lucide], sanitizeSvg);

  test("resolves ids and aliases to the canonical ref", () => {
    expect(r.resolve("cosmo:server")?.ref).toBe("cosmo:server");
    expect(r.resolve("cosmo:lb")?.ref).toBe("cosmo:load-balancer");
    expect(r.resolve("cosmo:DB")?.ref).toBe("cosmo:database");
    expect(r.resolve("lucide:remote")?.ref).toBe("lucide:cloud");
  });

  test("returns sanitized svg, license and attribution", () => {
    const x = r.resolve("lucide:cloud");
    expect(x?.license).toBe("ISC");
    expect(x?.attribution).toBe("Lucide Contributors");
    expect(x?.svg.viewBox).toBe("0 0 24 24");
    expect(x?.svg.monochrome).toBe(true);
    expect(x?.svg.body).toContain("currentColor");
  });

  test("per-icon license overrides the pack license", () => {
    const p = pack("simple", [entry("x", { license: "CC0-1.0" })], { license: "LicenseRef-mixed" });
    expect(createIconResolver([p], sanitizeSvg).resolve("simple:x")?.license).toBe("CC0-1.0");
  });

  test("unknown refs resolve to undefined", () => {
    expect(r.resolve("cosmo:nope")).toBeUndefined();
    expect(r.resolve("nope:server")).toBeUndefined();
    expect(r.resolve("")).toBeUndefined();
  });

  test("bare ids use pack precedence", () => {
    expect(r.resolve("server")?.ref).toBe("cosmo:server");
    expect(r.resolve("cloud")?.ref).toBe("lucide:cloud");
    expect(createIconResolver([lucide, base], sanitizeSvg).resolve("server")?.ref).toBe(
      "lucide:server",
    );
  });

  test("ids beat aliases; first pack wins on duplicate pack ids", () => {
    const p = pack("a", [entry("x", { aliases: ["y"] }), entry("y")]);
    expect(createIconResolver([p], sanitizeSvg).resolve("a:y")?.ref).toBe("a:y");
    const dup = pack("cosmo", [entry("only-here")]);
    const rr = createIconResolver([base, dup], sanitizeSvg);
    expect(rr.resolve("cosmo:only-here")).toBeUndefined();
    expect(rr.packs()).toEqual(["cosmo"]);
  });

  test("packs() keeps precedence order", () => {
    expect(r.packs()).toEqual(["cosmo", "lucide"]);
  });

  test("defaultFor resolves aliases to canonical refs and honours precedence", () => {
    expect(r.defaultFor("server")).toBe("cosmo:server");
    expect(r.defaultFor("sql")).toBe("cosmo:database");
    expect(r.defaultFor("cdn")).toBeUndefined();
    const override = pack("mine", [entry("srv")], { defaults: { server: "mine:srv" } });
    expect(createIconResolver([override, base], sanitizeSvg).defaultFor("server")).toBe("mine:srv");
  });

  test("icons whose SVG fails to sanitize resolve to undefined", () => {
    const p = pack("bad", [entry("x")]);
    const broken: LoadedIconPack = { ...p, files: { "x.svg": "<svg><script/></svg>" } };
    expect(createIconResolver([broken], sanitizeSvg).resolve("bad:x")).toBeUndefined();
  });

  test("sanitizes lazily and caches", () => {
    let calls = 0;
    const counting: typeof sanitizeSvg = (i, o) => (calls++, sanitizeSvg(i, o));
    const rr = createIconResolver([base], counting);
    expect(calls).toBe(0);
    rr.resolve("cosmo:server");
    rr.resolve("cosmo:host");
    expect(calls).toBe(1);
  });
});

describe("search", () => {
  const r = createIconResolver([base, lucide], sanitizeSvg);

  test("exact beats prefix beats substring; ties by ref", () => {
    const m = r.search("server");
    expect(m.map((x) => x.ref).slice(0, 2)).toEqual(["cosmo:server", "lucide:server"]);
    expect(m[0]?.score).toBe(1);
  });

  test("aliases, tags and typos", () => {
    expect(r.search("lb")[0]?.ref).toBe("cosmo:load-balancer");
    expect(r.search("storage")[0]?.ref).toBe("cosmo:database");
    expect(r.search("databse")[0]?.ref).toMatch(/database$/);
    expect(r.search("load balancer")[0]?.ref).toBe("cosmo:load-balancer");
  });

  test("pack prefix filters; limit applies; empty query and no match", () => {
    expect(r.search("lucide:data").every((x) => x.ref.startsWith("lucide:"))).toBe(true);
    expect(r.search("e", 2)).toHaveLength(2);
    expect(r.search("")).toEqual([]);
    expect(r.search("zzzzzzzz")).toEqual([]);
  });

  test("scores are 0..1 and deterministic", () => {
    const a = r.search("serv");
    expect(a).toEqual(r.search("serv"));
    for (const x of a) {
      expect(x.score).toBeGreaterThan(0);
      expect(x.score).toBeLessThanOrEqual(1);
    }
  });
});
