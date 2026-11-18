import { describe, expect, test } from "vitest";
import { createIconResolver, iconRejections, sanitizeSvg } from "../src/icons/index.js";
import type { LoadedIconPack } from "../src/index.js";

const wrap = (inner: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${inner}</svg>`;

function ok(input: string, opts?: Parameters<typeof sanitizeSvg>[1]) {
  const r = sanitizeSvg(input, opts);
  if (!r.ok) throw new Error(`rejected: ${r.reason}`);
  return r;
}

describe("nested <use> amplification", () => {
  test("8 levels x 6 uses does not expand (nested uses are dropped)", () => {
    let inner = '<g id="l0"><rect width="1" height="1"/></g>';
    for (let i = 1; i <= 8; i++) {
      inner += `<g id="l${i}">${`<use href="#l${i - 1}"/>`.repeat(6)}</g>`;
    }
    inner += '<use href="#l8"/>';
    const r = ok(wrap(inner));
    expect(r.removed).toContain("element:use-limit");
    // Anything that survives references a target without uses: no multiplication possible.
    const uses = r.svg.body.match(/<use /g)?.length ?? 0;
    expect(uses).toBeLessThanOrEqual(48);
    expect(r.svg.body).toContain('<g id="__PCID__-2"/>');
  });

  test("a use that targets another use, or a pattern, is dropped; a plain use is kept", () => {
    const b = ok(
      wrap(
        '<g id="a"><rect width="1" height="1"/></g><use id="u" href="#a"/><use href="#u"/><pattern id="p" width="2" height="2"><rect width="1" height="1"/></pattern><use href="#p"/>',
      ),
    ).svg.body;
    expect(b.match(/<use /g)?.length).toBe(1);
    expect(b).toContain('<use id="__PCID__-1" href="#__PCID__-0"/>');
  });

  test("self and mutual references are dropped", () => {
    expect(ok(wrap('<g id="a"><use href="#a"/></g>')).svg.body).toBe('<g id="__PCID__-0"/>');
    const b = ok(wrap('<g id="a"><use href="#b"/></g><g id="b"><use href="#a"/></g>')).svg.body;
    expect(b).not.toContain("<use");
  });
});

describe("CSS worst cases are linear", () => {
  const timeIt = (s: string): number => {
    // Best of three: the bound is about algorithmic cost, not scheduler or JIT noise.
    let best = Infinity;
    for (let k = 0; k < 3; k++) {
      const t = performance.now();
      sanitizeSvg(s, { maxBytes: 70_000 });
      best = Math.min(best, performance.now() - t);
    }
    return best;
  };
  const style = (css: string, extra = "") => wrap(`<style>${css}</style>${extra}`).slice(0, 60_000);

  test("60 KB of rules, comments and classes finish quickly", { timeout: 30_000 }, () => {
    const cases = [
      style(".a{fill:red}".repeat(5000), '<path class="a" d="M0 0"/>'),
      style("/*".repeat(30000)),
      style("/* x */".repeat(8000) + "a{fill:red}"),
      style("a{".repeat(30000)),
      style("}".repeat(60000)),
      style(".a.a.a.a.a.a.a.a.a.a.a.a{fill:red}".repeat(1500), '<path class="a" d="M0 0"/>'),
      style(`${"a,".repeat(25000)}b{fill:red}`),
      style("a{fill:red !important   ".repeat(2000) + "}"),
      wrap(`<path class="${"a ".repeat(25000)}" d="M0 0"/>`).slice(0, 60_000),
      wrap(
        "<style>.c0{fill:red}</style>" +
          Array.from({ length: 1500 }, (_, i) => `<path class="c0 c${i}" d="M0 0"/>`).join(""),
      ),
    ];
    for (const [i, c] of cases.entries()) {
      const ms = timeIt(c);
      expect(ms, `case ${i}`).toBeLessThan(200);
    }
  });

  test("rule and selector caps apply", () => {
    const r = ok(wrap(`<style>${".a{fill:red}".repeat(2000)}</style><path class="a" d="M0 0"/>`), {
      maxBytes: 100_000,
    });
    expect(r.removed).toContain("style:rule-limit");
    const s = ok(wrap(`<style>${"a,".repeat(40)}b{fill:red}</style>`));
    expect(s.removed).toContain("style:selector-limit");
  });
});

describe("obfuscated payloads", () => {
  const safe = (body: string) => {
    expect(body).not.toMatch(/<script|<style|on\w+=|javascript|@import|https?:|data:image\/svg/i);
    for (const m of body.matchAll(/href="([^"]*)"/g)) {
      expect(m[1]).toMatch(/^(#__PCID__-\d+|data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]*)$/);
    }
  };

  test("namespaced script element (svg:script)", () => {
    const r = ok(wrap('<svg:script>alert(1)</svg:script><path d="M0 0"/>'));
    expect(r.svg.body).toBe('<path d="M0 0"/>');
    expect(r.removed).toContain("element:svg_script");
  });

  test("tab-split javascript: in use href (java&#x09;script)", () => {
    const r = ok(wrap('<use href="java&#x09;script:alert(1)"/><path d="M0 0"/>'));
    expect(r.svg.body).toBe('<path d="M0 0"/>');
  });

  test("upper-case DATA:image/png is not accepted as a passthrough", () => {
    const r = ok(wrap('<image href="DATA:image/png;base64,iVBORw0KGgo=" width="1" height="1"/>'));
    safe(r.svg.body);
    expect(r.svg.body).not.toContain("href");
  });

  test("image with data:image/svg+xml is stripped of its href", () => {
    const r = ok(wrap('<image href="data:image/svg+xml;base64,PHN2Zz4=" width="1" height="1"/>'));
    expect(r.svg.body).toBe('<image width="1" height="1"/>');
  });

  test("entity-obfuscated event handler (on&#x6c;oad)", () => {
    // Entities are not valid in attribute names, so the whole document is refused.
    expect(sanitizeSvg(wrap('<path d="M0 0" on&#x6c;oad="alert(1)"/>'))).toMatchObject({
      ok: false,
    });
    // The decoded form of an on* handler in a *value* position is plain data and never executes.
    const r = ok(wrap('<path d="M0 0" onload="alert(1)"/>'));
    expect(r.svg.body).toBe('<path d="M0 0"/>');
  });

  test("entity-obfuscated @import in a style (&#64;import)", () => {
    const r = ok(wrap('<style>&#64;import url(https://x/a.css);</style><path d="M0 0"/>'));
    expect(r.svg.body).toBe('<path d="M0 0"/>');
    expect(r.removed).toContain("style:unsafe-css");
  });

  test("entity-obfuscated url( in fill (u&#114;l(https://x))", () => {
    const r = ok(wrap('<path d="M0 0" fill="u&#114;l(https://x/a)"/>'));
    expect(r.svg.body).toBe('<path d="M0 0"/>');
  });
});

describe("monochrome and reporting", () => {
  test("transparent and currentColor are kept; stop-color follows the monochrome rule", () => {
    const b = ok(
      wrap(
        '<defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/></linearGradient></defs><path fill="transparent" stroke="currentColor" d="M0 0"/><path fill="url(#g)" d="M1 1"/><path fill="#123" d="M2 2"/>',
      ),
      { monochrome: true },
    ).svg.body;
    expect(b).toContain('fill="transparent"');
    expect(b).toContain('stroke="currentColor"');
    expect(b).toContain('stop-color="currentColor"');
    expect(b).toContain('fill="currentColor" d="M2 2"');
    expect(b).not.toContain("#f00");
  });

  test("removed entries only contain [\\w:-] characters", () => {
    const r = ok(wrap('<weird.el/><path d="M0 0" on-click="x" data-x="1" style="--x:1;weird:1"/>'));
    for (const e of r.removed) expect(e).toMatch(/^[\w-]+:[\w-]*(?:\([\w-]*\))?$|^[\w-]+$/);
  });
});

describe("resolver additions", () => {
  const mk = (id: string, icons: string[], defaults?: Record<string, string>): LoadedIconPack => ({
    manifest: {
      manifestVersion: 1,
      pack: { id, name: id, version: "1", license: "MIT", source: "x", redistributable: true },
      icons: icons.map((i) => ({
        id: i,
        aliases: [],
        category: "general",
        file: `${i}.svg`,
        monochrome: true,
      })),
      ...(defaults ? { defaults } : {}),
    },
    files: Object.fromEntries(icons.map((i) => [`${i}.svg`, wrap('<path d="M0 0"/>')])),
  });

  test("defaultFor honours cross-pack defaults and skips uninstalled packs", () => {
    const base = mk("cosmo", ["server"], { server: "aws:ec2", lb: "cosmo:server" });
    const aws = mk("aws", ["ec2"]);
    expect(createIconResolver([base, aws], sanitizeSvg).defaultFor("server")).toBe("aws:ec2");
    expect(createIconResolver([base], sanitizeSvg).defaultFor("server")).toBeUndefined();
    expect(createIconResolver([base], sanitizeSvg).defaultFor("lb")).toBe("cosmo:server");
    const fallback = mk("other", ["x"], { server: "other:x" });
    expect(createIconResolver([base, fallback], sanitizeSvg).defaultFor("server")).toBe("other:x");
  });

  test("search truncates very long queries", () => {
    const r = createIconResolver([mk("cosmo", ["server"])], sanitizeSvg);
    const t = Date.now();
    r.search("server".repeat(100_000));
    expect(Date.now() - t).toBeLessThan(200);
  });

  test("sanitizer rejection reasons are kept for callers", () => {
    const p = mk("bad", ["x"]);
    const broken: LoadedIconPack = { ...p, files: { "x.svg": "<svg><path/></svg>" } };
    const r = createIconResolver([broken], sanitizeSvg);
    expect(r.resolve("bad:x")).toBeUndefined();
    expect(iconRejections(r).get("bad:x")).toBe("missing or invalid viewBox");
  });
});
