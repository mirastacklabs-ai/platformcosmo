import { describe, expect, test } from "vitest";
import { optimize } from "../src/optimize/index.js";

const svg = [
  '<svg xmlns="http://www.w3.org/2000/svg" id="pc-a" role="img" viewBox="0 0 100 50" aria-labelledby="pc-a-title pc-a-desc">',
  '<title id="pc-a-title">T</title><desc id="pc-a-desc">D</desc>',
  '<defs><path id="pc-a-ep_e_x_y" d="M0 0L10.123456 10.987654"/></defs>',
  "<style><![CDATA[#pc-a{--pc-x:#fff}.pc-a-s-down>.pc-a-overlay{fill:var(--pc-x)}@keyframes k{0%{opacity:0}100%{opacity:1}}]]></style>",
  '<g id="pc-a-cam"><g id="pc-a-ly_flows" class="pc-a-layer"></g>',
  '<g id="pc-a-o_n" class="pc-a-s-healthy"><path id="pc-a-f_n_top" class="pc-a-face" d="M 0 0 L 10.00 0 L 10 10.126 Z"/>',
  '<path id="pc-a-ov_n" class="pc-a-overlay" d="M0 0Z"/></g>',
  '<text id="pc-a-cap_1" x="1" y="2" visibility="hidden">Hi</text>',
  '<rect id="pc-a-r" x="1" y="2" width="3" height="4"/>',
  '<circle id="pc-a-c" r="2"><animateMotion dur="2s" repeatCount="indefinite"><mpath href="#pc-a-ep_e_x_y"/></animateMotion></circle>',
  "</g></svg>",
].join("");

describe("optimize", () => {
  const out = optimize(svg);

  test("shrinks and rounds path data to two decimals", () => {
    expect(out.length).toBeLessThan(svg.length);
    expect(out).not.toMatch(/\d\.\d{3}/);
  });

  test("keeps every id, class, the CDATA style and SMIL intact", () => {
    for (const id of svg.match(/id="[^"]+"/g) ?? []) expect(out).toContain(id);
    expect(out).toContain(
      "<![CDATA[#pc-a{--pc-x:#fff}.pc-a-s-down>.pc-a-overlay{fill:var(--pc-x)}@keyframes k{0%{opacity:0}100%{opacity:1}}]]>",
    );
    expect(out).toContain("<animateMotion");
    expect(out).toContain('href="#pc-a-ep_e_x_y"');
    expect(out).toContain('visibility="hidden"');
    expect(out).toContain('class="pc-a-layer"');
    expect(out).toContain('viewBox="0 0 100 50"');
    expect(out).toContain("<title");
    expect(out).toContain("<desc");
  });

  test("keeps shapes and empty groups (animation targets)", () => {
    expect(out).toContain("<rect");
    expect(out).toContain("<circle");
    expect(out).toMatch(/id="pc-a-ly_flows"/);
  });

  test("deterministic and stable when run twice", () => {
    expect(optimize(svg)).toBe(out);
    expect(optimize(out)).toBe(out);
  });
});
