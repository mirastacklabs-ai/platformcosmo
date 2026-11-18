import { describe, expect, it } from "vitest";
import type { ThemeTokens } from "@platformcosmo/core";
import { contrastOn, contrastRatio, over, parseColor, toHex } from "../src/color.js";
import { themeNames, themeRegistry, validateTheme } from "../src/index.js";

const all = themeNames.map((n) => themeRegistry.get(n)!);

/** Collects every string/number leaf path of a token tree. */
function leaves(v: unknown, path = ""): [string, unknown][] {
  if (typeof v === "object" && v !== null) {
    return Object.entries(v).flatMap(([k, x]) => leaves(x, `${path}/${k}`));
  }
  return [[path, v]];
}

describe("registry", () => {
  it("lists the four built-ins in order and resolves them", () => {
    expect(themeRegistry.list()).toEqual(["light", "dark", "blueprint", "mono"]);
    for (const n of themeNames) expect(themeRegistry.get(n)?.id).toBe(n);
    expect(themeRegistry.get("nope")).toBeUndefined();
    expect(themeRegistry.get("__proto__")).toBeUndefined();
    expect(themeRegistry.get("toString")).toBeUndefined();
  });

  it("themes pass validateTheme and are structurally identical afterwards", () => {
    for (const t of all) {
      const r = validateTheme(t);
      expect(r.diagnostics).toEqual([]);
      expect(r.theme).toEqual(t);
    }
  });

  it("is deterministic", () => {
    expect(JSON.stringify(themeRegistry.get("blueprint"))).toBe(
      JSON.stringify(themeRegistry.get("blueprint")),
    );
  });

  it("uses distinct color schemes where expected", () => {
    expect(themeRegistry.get("light")?.colorScheme).toBe("light");
    expect(themeRegistry.get("dark")?.colorScheme).toBe("dark");
    expect(themeRegistry.get("blueprint")?.colorScheme).toBe("dark");
  });
});

describe.each(all.map((t) => [t.id, t] as const))("contrast: %s", (_id, t: ThemeTokens) => {
  const bg = t.background;
  const min = 4.5;
  const pairs: [string, string, string, string][] = [
    ["text.primary", t.text.primary, bg, bg],
    ["text.secondary", t.text.secondary, bg, bg],
    ["badge", t.badge.text, t.badge.fill, bg],
    ["caption", t.caption.text, t.caption.fill, bg],
    ["metric.label", t.metric.label, t.metric.fill, bg],
    ["metric.value", t.metric.value, t.metric.fill, bg],
    ["edge.label", t.edge.labelText, t.edge.labelFill, bg],
    ["icon", t.icon.color, t.icon.plate, bg],
  ];
  it.each(pairs)("%s >= 4.5:1", (_n, fg, fill, base) => {
    expect(contrastOn(fg, fill, base)).toBeGreaterThanOrEqual(min);
  });

  it("group labels are readable over every group style", () => {
    for (const g of Object.values(t.groups)) {
      const c = toHex(over(g.fill, bg, g.opacity));
      expect(contrastOn(g.label, c, bg)).toBeGreaterThanOrEqual(min);
    }
  });

  it("text on the DC hall surface is readable", () => {
    expect(contrastOn(t.text.primary, t.dc.hall, bg)).toBeGreaterThanOrEqual(min);
  });

  it("flow colors (>= 3:1) and LEDs (>= 2:1) are visible against the background", () => {
    const b = parseColor(bg)!;
    for (const c of Object.values(t.flows)) {
      expect(contrastRatio(over(c, bg), b)).toBeGreaterThanOrEqual(3);
    }
    for (const c of Object.values(t.dc.led)) {
      expect(contrastRatio(over(c, bg), b)).toBeGreaterThanOrEqual(2);
    }
  });

  it("face tones keep top lighter than right", () => {
    const lum = (c: string): number => {
      const p = parseColor(c)!;
      return p.r + p.g + p.b;
    };
    for (const tone of [...Object.values(t.categories), ...Object.values(t.parts)]) {
      expect(lum(tone.top)).toBeGreaterThan(lum(tone.right));
    }
  });
});

describe("validateTheme trust rules", () => {
  const good = (): Record<string, unknown> => structuredClone(themeRegistry.get("light")) as never;
  const codes = (input: unknown): string[] => validateTheme(input).diagnostics.map((d) => d.code);

  it("rejects non-objects", () => {
    for (const v of [null, undefined, 3, "x", [], () => 1]) {
      expect(validateTheme(v).theme).toBeUndefined();
      expect(codes(v)).toContain("theme/invalid-type");
    }
  });

  it.each([
    "red",
    "url(#x)",
    "#12",
    "#123456789",
    "#ggg",
    "rgb(0,0,0); background:url(x)",
    "rgba(1,2,3,0.5) !important",
    "var(--x)",
    "expression(1)",
    "",
  ])("rejects color %j", (c) => {
    const t = good();
    (t.text as Record<string, unknown>).primary = c;
    const r = validateTheme(t);
    expect(r.theme).toBeUndefined();
    expect(r.diagnostics[0]).toMatchObject({ code: "theme/invalid-color", path: "/text/primary" });
  });

  it.each([
    "#fff",
    "#ffff",
    "#ffffff",
    "#ffffff80",
    "rgb(1, 2, 3)",
    "rgba(10,20,30,0.5)",
    "rgb(10% 20% 30%)",
  ])("accepts color %j", (c) => {
    const t = good();
    (t.text as Record<string, unknown>).primary = c;
    expect(validateTheme(t).diagnostics).toEqual([]);
  });

  it.each([
    "Inter; background:red",
    "Inter, 'Bad",
    "Inter, \"Bad'",
    "Inter}</style><script>",
    "url(x)",
    "",
    "Inter\n",
  ])("rejects font family %j", (f) => {
    const t = good();
    (t.font as Record<string, unknown>).family = f;
    expect(codes(t)).toContain("theme/invalid-font");
  });

  it.each(["Inter, sans-serif", "'Fira Sans', \"Segoe UI\", sans-serif"])(
    "accepts font family %j",
    (f) => {
      const t = good();
      (t.font as Record<string, unknown>).family = f;
      expect(validateTheme(t).diagnostics).toEqual([]);
    },
  );

  it("validates dash values", () => {
    for (const d of ["6 4", "1.5,4", "", "3"]) {
      const t = good();
      ((t.edge as Record<string, unknown>).dash as Record<string, unknown>).dashed = d;
      expect(validateTheme(t).diagnostics).toEqual([]);
    }
    for (const d of ["a", "6 4;", "-1", "6  ,", "1e3x"]) {
      const t = good();
      ((t.edge as Record<string, unknown>).dash as Record<string, unknown>).dashed = d;
      expect(codes(t)).toContain("theme/invalid-dash");
    }
  });

  it("validates id and name", () => {
    for (const id of ["Light", "1a", "a_b", "", "a".repeat(65), "x y"]) {
      const t = good();
      t.id = id;
      expect(codes(t)).toContain("theme/invalid-id");
    }
    const ok = good();
    ok.id = "my-theme-2";
    ok.name = "My <b>Theme</b> & co";
    expect(validateTheme(ok).diagnostics).toEqual([]);
    const bad = good();
    bad.name = "a\u0000b";
    expect(codes(bad)).toContain("theme/invalid-name");
  });

  it("rejects non-finite and out-of-range numbers", () => {
    for (const v of [NaN, Infinity, -Infinity, "1", null]) {
      const t = good();
      (t.grid as Record<string, unknown>).opacity = v;
      expect(codes(t)).toContain("theme/invalid-number");
    }
    const t = good();
    (t.font as Record<string, unknown>).label = 0;
    expect(codes(t)).toContain("theme/invalid-number");
  });

  it("reports missing and unknown keys with JSON pointers", () => {
    const t = good();
    delete (t.dc as Record<string, unknown>).hall;
    (t.badge as Record<string, unknown>).extra = "#fff";
    t.evil = "x";
    const d = validateTheme(t).diagnostics;
    expect(d.map((x) => [x.code, x.path])).toEqual([
      ["theme/unknown-key", "/badge/extra"],
      ["theme/missing-key", "/dc/hall"],
      ["theme/unknown-key", "/evil"],
    ]);
  });

  it("requires every token (deleting any leaf fails)", () => {
    const base = good();
    for (const [p] of leaves(base)) {
      const t = structuredClone(base);
      const parts = p.split("/").slice(1);
      let o: Record<string, unknown> = t;
      for (const k of parts.slice(0, -1)) o = o[k] as Record<string, unknown>;
      delete o[parts.at(-1)!];
      const r = validateTheme(t);
      expect(r.theme, p).toBeUndefined();
      expect(r.diagnostics.some((x) => x.code === "theme/missing-key" && x.path === p)).toBe(true);
    }
  });

  it("returns a fresh copy without foreign keys", () => {
    const t = good();
    const r = validateTheme(t);
    expect(r.theme).toEqual(t);
    expect(r.theme).not.toBe(t);
    expect(r.theme?.palette).not.toBe((t as { palette: unknown }).palette);
  });

  it("ignores prototype pollution style keys", () => {
    const t = JSON.parse(JSON.stringify(good())) as Record<string, unknown>;
    (t as Record<string, unknown>)["__proto__"] = { polluted: true };
    Object.defineProperty(t, "__proto__", { value: { polluted: true }, enumerable: true });
    const r = validateTheme(t);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(r.theme).toBeUndefined();
  });
});
