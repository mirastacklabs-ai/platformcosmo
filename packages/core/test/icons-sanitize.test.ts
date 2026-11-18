import { describe, expect, test } from "vitest";
import { sanitizeSvg } from "../src/icons/index.js";

const wrap = (inner: string, attrs = 'viewBox="0 0 24 24"') =>
  `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${inner}</svg>`;

function body(input: string, opts?: Parameters<typeof sanitizeSvg>[1]): string {
  const r = sanitizeSvg(input, opts);
  if (!r.ok) throw new Error(`rejected: ${r.reason}`);
  return r.svg.body;
}

/** Output must never contain anything executable or external. */
function assertSafe(b: string): void {
  expect(b).not.toMatch(/<script|<style|<foreignObject|<iframe|<a[ >]|<animate|<set[ >]/i);
  expect(b).not.toMatch(/\son\w+\s*=/i);
  expect(b).not.toMatch(/javascript:|vbscript:|@import|<!ENTITY|<!DOCTYPE|<\?/i);
  for (const m of b.matchAll(/href="([^"]*)"/g)) {
    expect(m[1]).toMatch(/^(#__PCID__-\d+|data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=\s]*)$/);
  }
  for (const m of b.matchAll(/url\(([^)]*)\)/g)) expect(m[1]).toMatch(/^#__PCID__-\d+$/);
}

describe("sanitizeSvg basics", () => {
  test("keeps geometry and returns viewBox + body", () => {
    const r = sanitizeSvg(wrap('<path d="M0 0L10 10" stroke="red"/><circle cx="5" cy="5" r="2"/>'));
    expect(r).toMatchObject({ ok: true, svg: { viewBox: "0 0 24 24", monochrome: false } });
    if (r.ok)
      expect(r.svg.body).toBe('<path d="M0 0L10 10" stroke="red"/><circle cx="5" cy="5" r="2"/>');
  });

  test("deterministic", () => {
    const s = wrap('<g id="a"><path id="b" d="M0 0"/></g><use href="#b"/>');
    expect(body(s)).toBe(body(s));
  });

  test("root presentation attrs move to a wrapper group (lucide style)", () => {
    const b = body(
      wrap(
        '<path d="M1 1"/>',
        'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="24" height="24"',
      ),
    );
    expect(b).toBe('<g fill="none" stroke="currentColor" stroke-width="2"><path d="M1 1"/></g>');
  });

  test("width/height fallback for viewBox, missing viewBox rejected", () => {
    const r = sanitizeSvg('<svg width="32px" height="16"><path d="M0 0"/></svg>');
    expect(r.ok && r.svg.viewBox).toBe("0 0 32 16");
    expect(sanitizeSvg("<svg><path/></svg>")).toMatchObject({ ok: false });
    expect(sanitizeSvg('<svg viewBox="0 0 0 5"><path/></svg>')).toMatchObject({ ok: false });
    expect(sanitizeSvg('<svg viewBox="0 0 NaN 5"><path/></svg>')).toMatchObject({ ok: false });
  });

  test("monochrome rewrites fills and strokes to currentColor", () => {
    const b = body(
      wrap('<path fill="#ff0000" stroke="blue" d="M0 0"/><path fill="none" d="M1 1"/>'),
      {
        monochrome: true,
      },
    );
    expect(b).toBe(
      '<g fill="currentColor"><path fill="currentColor" stroke="currentColor" d="M0 0"/><path fill="none" d="M1 1"/></g>',
    );
  });

  test("rewrites ids and internal refs to __PCID__", () => {
    const b = body(
      wrap(
        '<defs><linearGradient id="g1"><stop offset="0" stop-color="#fff"/></linearGradient><clipPath id="c"><rect width="1" height="1"/></clipPath></defs><path fill="url(#g1)" clip-path="url(&quot;#c&quot;)" d="M0 0"/><use xlink:href="#c"/>',
      ),
    );
    expect(b).toContain('id="__PCID__-0"');
    expect(b).toContain('id="__PCID__-1"');
    expect(b).toContain('fill="url(#__PCID__-0)"');
    expect(b).toContain('clip-path="url(#__PCID__-1)"');
    expect(b).toContain('href="#__PCID__-1"');
    assertSafe(b);
  });

  test("dangling references are dropped, dangling use is removed", () => {
    const b = body(wrap('<path fill="url(#nope)" d="M0 0"/><use href="#nope"/>'));
    expect(b).toBe('<path d="M0 0"/>');
  });

  test("duplicate ids: first wins, later id dropped", () => {
    const b = body(wrap('<g id="x"/><g id="x"/>'));
    expect(b).toBe('<g id="__PCID__-0"/><g/>');
  });

  test("inline <style> becomes presentation attributes", () => {
    const b = body(
      wrap(
        '<style>.a{fill:#123456;stroke-width:2}path{opacity:.5}</style><path class="a" d="M0 0"/>',
      ),
    );
    expect(b).toContain('fill="#123456"');
    expect(b).toContain('stroke-width="2"');
    expect(b).toContain('opacity=".5"');
    assertSafe(b);
  });

  test("style attribute is parsed into allowed attributes only", () => {
    const b = body(wrap('<path style="fill:red;position:fixed;behavior:url(x)" d="M0 0"/>'));
    expect(b).toBe('<path d="M0 0" fill="red"/>');
  });

  test("allowed data:image/png survives, svg+xml does not", () => {
    const ok = body(
      wrap('<image href="data:image/png;base64,iVBORw0KGgo=" width="4" height="4"/>'),
    );
    expect(ok).toContain("data:image/png;base64,iVBORw0KGgo=");
    for (const bad of [
      "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
      "data:image/svg+xml,%3Csvg%3E",
      "data:text/html;base64,PHNjcmlwdD4=",
      "https://evil.example/x.png",
      "//evil.example/x.png",
      'data:image/png;base64,AAAA"onload="x',
    ]) {
      const b = body(wrap(`<image href="${bad.replace(/"/g, "&quot;")}" width="4" height="4"/>`));
      expect(b).not.toContain("href");
      assertSafe(b);
    }
  });

  test("ids that start with digits or contain slashes survive (provider exports)", () => {
    const b = body(
      wrap(
        '<defs><linearGradient id="0a1b-2c"><stop offset="0" stop-color="red"/></linearGradient></defs><g id="Icon/64/x"><path fill="url(#0a1b-2c)" d="M0 0"/></g><use href="#Icon/64/x"/>',
      ),
    );
    expect(b).toContain('fill="url(#__PCID__-0)"');
    expect(b).toContain('<use href="#__PCID__-1"/>');
  });

  test("illustrator style sheet with classes is inlined", () => {
    const b = body(
      wrap(
        '<defs><style>\n.st0 { fill: none; }\n.st1, .st2 { fill: #4285f4; }\n</style></defs><path class="st1" d="M0 0"/><path class="st0 st2" d="M1 1"/>',
      ),
    );
    expect(b).toContain('<path d="M0 0" fill="#4285f4"/>');
    expect(b).toContain('fill="#4285f4"');
    expect(b).not.toContain("class");
  });

  test("root xmlns/viewBox/width/height are not reported as removed", () => {
    const r = sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="24" height="24" viewBox="0 0 24 24" version="1.1"><path d="M0 0"/></svg>',
    );
    expect(r.ok && r.removed).toEqual([]);
  });

  test("size limits", () => {
    expect(sanitizeSvg(wrap("<path/>"), { maxBytes: 10 })).toMatchObject({ ok: false });
    const huge = wrap(`<path d="${"M0 0 ".repeat(30000)}"/>`);
    expect(sanitizeSvg(huge)).toMatchObject({ ok: false });
    // Multi-byte characters count in bytes.
    expect(sanitizeSvg(wrap(`<g id="${"é".repeat(40)}"/>`), { maxBytes: 100 })).toMatchObject({
      ok: false,
    });
  });
});

describe("sanitizeSvg adversarial inputs", () => {
  const payloads: Record<string, string> = {
    script: wrap('<script>alert(1)</script><path d="M0 0"/>'),
    "script in CDATA": wrap("<script><![CDATA[alert(1)]]></script>"),
    "uppercase script": wrap("<SCRIPT>alert(1)</SCRIPT>"),
    "on* handlers": wrap('<path d="M0 0" onclick="alert(1)" onload="x()" OnMouseOver="y()"/>'),
    "on* on root": '<svg viewBox="0 0 1 1" onload="alert(1)"><path d="M0 0"/></svg>',
    foreignObject: wrap(
      '<foreignObject><iframe src="https://evil"/><body xmlns="http://www.w3.org/1999/xhtml" onload="x"/></foreignObject>',
    ),
    "javascript href": wrap(
      '<a href="javascript:alert(1)"><path d="M0 0"/></a><use href="javascript:alert(1)"/>',
    ),
    "entity-encoded javascript": wrap('<use href="&#106;avascript:alert(1)"/>'),
    "external use": wrap(
      '<use href="https://evil.example/x.svg#a"/><use xlink:href="//evil/x.svg#a"/><use href="x.svg#a"/>',
    ),
    "svg data uri": wrap(
      '<image href="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+" width="1" height="1"/>',
    ),
    "css import": wrap('<style>@import url("https://evil.example/x.css");</style><path d="M0 0"/>'),
    "css url": wrap('<style>path{fill:url(https://evil.example/a.png)}</style><path d="M0 0"/>'),
    "css url in attr": wrap('<path fill="url(https://evil.example/a)" d="M0 0"/>'),
    "css url data": wrap('<path style="fill:url(data:image/svg+xml,x)" d="M0 0"/>'),
    "css escape": wrap('<style>path{fill:u\\72l(https://evil)}</style><path d="M0 0"/>'),
    "css expression": wrap('<path style="fill:expression(alert(1))" d="M0 0"/>'),
    "css behavior": wrap(
      '<style>path{-moz-binding:url(http://evil/x.xml#b)}</style><path d="M0 0"/>',
    ),
    "animate set": wrap(
      '<path d="M0 0"><animate attributeName="href" to="javascript:alert(1)"/><set attributeName="onclick" to="x"/></path>',
    ),
    "filter url": wrap('<path d="M0 0" filter="url(https://evil/f.svg#f)"/>'),
    "quote breakout": wrap('<path d="M0 0" fill="red&quot; onload=&quot;alert(1)"/>'),
    "tag breakout in attr": wrap('<path d="M0 0" fill="&lt;script&gt;alert(1)&lt;/script&gt;"/>'),
    "text with script entity": wrap("<text>&lt;script&gt;alert(1)&lt;/script&gt;</text>"),
    "comment trick": wrap("<!-- --><script>alert(1)</script><!-- -->"),
    "PI xml-stylesheet":
      '<?xml-stylesheet href="https://evil/x.css"?><svg viewBox="0 0 1 1"><path d="M0 0"/></svg>',
    "nested svg": wrap('<svg onload="alert(1)"><path d="M0 0"/></svg>'),
    "namespaced attrs": wrap(
      '<path d="M0 0" xlink:href="javascript:x" xml:base="https://evil" sodipodi:foo="1"/>',
    ),
    "gradient external href": wrap(
      '<linearGradient id="g" xlink:href="https://evil/g.svg#g"/><path fill="url(#g)" d="M0 0"/>',
    ),
    "use cycle": wrap('<g id="a"><use href="#a"/></g>'),
  };
  for (const [name, input] of Object.entries(payloads)) {
    test(name, () => {
      const r = sanitizeSvg(input);
      if (r.ok) assertSafe(r.svg.body);
    });
  }

  test("script content never leaks", () => {
    expect(body(wrap('<script>alert(1)</script><path d="M0 0"/>'))).toBe('<path d="M0 0"/>');
  });

  test("css @import removed, style gone, no url left", () => {
    const r = sanitizeSvg(
      wrap('<style>@import url("https://evil.example/x.css");</style><path d="M0 0"/>'),
    );
    expect(r.ok && r.removed).toContain("style:unsafe-css");
    expect(r.ok && r.svg.body).toBe('<path d="M0 0"/>');
  });

  test("reports what was removed", () => {
    const r = sanitizeSvg(wrap('<script/><path d="M0 0" onclick="x"/>'));
    expect(r.ok && r.removed).toEqual(expect.arrayContaining(["element:script", "attr:onclick"]));
  });

  test("xlink:href javascript removed from use", () => {
    expect(body(wrap('<use xlink:href="javascript:alert(1)"/>'))).toBe("");
  });

  test("attribute values with markup are rejected, not escaped through", () => {
    expect(body(wrap('<path d="M0 0" fill="&lt;script&gt;"/>'))).toBe('<path d="M0 0"/>');
  });
});

describe("sanitizeSvg rejections", () => {
  const rejected: Record<string, string> = {
    "billion laughs": `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;&a;">]><svg viewBox="0 0 1 1"><text>&b;</text></svg>`,
    "external entity": `<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg viewBox="0 0 1 1"><text>&x;</text></svg>`,
    "parameter entity DTD": `<!DOCTYPE svg SYSTEM "https://evil/x.dtd" [%x;]><svg viewBox="0 0 1 1"/>`,
    "undefined entity": wrap("<text>&nbsp;</text>"),
    "entity in attribute": wrap('<path d="M0 0" fill="&evil;"/>'),
    "bare ampersand": wrap('<path d="M0 0" fill="a&b"/>'),
    "bad char ref": wrap('<g id="&#0;"/>'),
    "huge char ref": wrap('<g id="&#99999999;"/>'),
    "mismatched tags": wrap("<g><path></g></path>"),
    unclosed: '<svg viewBox="0 0 1 1"><g>',
    "no root": "",
    "not svg": '<html viewBox="0 0 1 1"/>',
    "two roots": '<svg viewBox="0 0 1 1"/><svg viewBox="0 0 1 1"/>',
    "text outside root": '<svg viewBox="0 0 1 1"/>trailing',
    "duplicate attributes": wrap('<path d="M0 0" d="M1 1"/>'),
    garbage: "\u0000\u0001<<<>>>",
    "unterminated comment": '<svg viewBox="0 0 1 1"><!-- x</svg>',
    "unterminated cdata": '<svg viewBox="0 0 1 1"><![CDATA[x</svg>',
    "unsupported declaration": '<svg viewBox="0 0 1 1"><!ELEMENT x></svg>',
    "doctype inside": '<svg viewBox="0 0 1 1"><!DOCTYPE x></svg>',
  };
  for (const [name, input] of Object.entries(rejected)) {
    test(name, () => {
      expect(sanitizeSvg(input)).toMatchObject({ ok: false });
    });
  }

  test("deep nesting", () => {
    const deep = wrap("<g>".repeat(200) + "</g>".repeat(200));
    expect(sanitizeSvg(deep)).toMatchObject({ ok: false });
  });

  test("too many elements", () => {
    expect(sanitizeSvg(wrap("<g/>".repeat(4500)), { maxBytes: 1_000_000 })).toMatchObject({
      ok: false,
    });
  });

  test("too many attributes", () => {
    const attrs = Array.from({ length: 80 }, (_, i) => `a${i}="1"`).join(" ");
    expect(sanitizeSvg(wrap(`<g ${attrs}/>`))).toMatchObject({ ok: false });
  });

  test("use amplification is capped", () => {
    const r = sanitizeSvg(wrap('<g id="a"/>' + '<use href="#a"/>'.repeat(200)), {
      maxBytes: 1_000_000,
    });
    expect(r.ok && (r.svg.body.match(/<use /g) ?? []).length).toBeLessThanOrEqual(48);
  });

  test("never throws on random mutations", () => {
    const seed = wrap(
      '<defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs><path fill="url(#g)" d="M0 0L5 5"/>',
    );
    let state = 12345;
    const rnd = () => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const chars = "<>\"'&;/=!?-[]() \n\\#:";
    for (let n = 0; n < 500; n++) {
      let s = seed;
      for (let k = 0; k < 1 + Math.floor(rnd() * 6); k++) {
        const pos = Math.floor(rnd() * s.length);
        s =
          s.slice(0, pos) +
          chars[Math.floor(rnd() * chars.length)] +
          s.slice(pos + Math.floor(rnd() * 3));
      }
      const r = sanitizeSvg(s);
      if (r.ok) assertSafe(r.svg.body);
    }
  });
});
