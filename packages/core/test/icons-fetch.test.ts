import { createHash } from "node:crypto";
import { strToU8, zipSync } from "fflate";
import { describe, expect, test } from "vitest";
import type { IconHttpClient } from "../src/index.js";
import {
  FETCH_LIMITS,
  checkHttpsUrl,
  computeIconIntegrity,
  createIconResolver,
  fetchIconPack,
  readZipDirectory,
  sanitizeSvg,
  sha256,
  verifyIconIntegrity,
} from "../src/icons/index.js";

const svg = (inner = '<path d="M0 0L10 10" stroke="red"/>') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${inner}</svg>`;

type Route = { body: Uint8Array | string; url?: string; contentType?: string } | Error;

function fakeHttp(routes: Record<string, Route>) {
  const calls: { url: string; maxBytes: number; timeoutMs: number }[] = [];
  const http: IconHttpClient = {
    async get(url, options) {
      calls.push({ url, ...options });
      const r = routes[url];
      if (r === undefined) throw new Error(`no route for ${url}`);
      if (r instanceof Error) throw r;
      return {
        url: r.url ?? url,
        contentType: r.contentType ?? "application/octet-stream",
        body: typeof r.body === "string" ? strToU8(r.body) : r.body,
      };
    },
  };
  return { http, calls };
}

const zip = (files: Record<string, string | Uint8Array>, level: 0 | 6 = 6): Uint8Array =>
  zipSync(
    Object.fromEntries(
      Object.entries(files).map(([k, v]) => [k, typeof v === "string" ? strToU8(v) : v]),
    ),
    { level },
  );

const codes = (r: { diagnostics: readonly { code: string }[] }) => r.diagnostics.map((d) => d.code);

describe("checkHttpsUrl", () => {
  test.each([
    "http://example.com/a.svg",
    "ftp://example.com/a.svg",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:image/svg+xml,<svg/>",
    "https://user:pw@example.com/a.svg",
    "https://127.0.0.1/a.svg",
    "https://169.254.169.254/latest/meta-data",
    "https://10.0.0.1/a.svg",
    "https://[::1]/a.svg",
    "https://[::ffff:127.0.0.1]/a.svg",
    "https://2130706433/a.svg",
    "https://0x7f000001/a.svg",
    "https://localhost/a.svg",
    "https://intranet/a.svg",
    "https://metadata.internal/a.svg",
    "https://printer.local/a.svg",
    "https://example.com:8443/a.svg",
    "https://exa mple.com/a.svg",
    "https://example.com\\@evil.com/",
    "",
    `https://example.com/${"a".repeat(3000)}`,
  ])("rejects %s", (u) => {
    expect(checkHttpsUrl(u).ok).toBe(false);
  });

  test("accepts public https and honours host allowlists", () => {
    expect(checkHttpsUrl("https://example.com/a.svg").ok).toBe(true);
    expect(checkHttpsUrl("https://example.com:443/a.svg").ok).toBe(true);
    expect(checkHttpsUrl("https://d1.awsstatic.com/x.zip", ["awsstatic.com"]).ok).toBe(true);
    expect(checkHttpsUrl("https://evilawsstatic.com/x.zip", ["awsstatic.com"]).ok).toBe(false);
    expect(checkHttpsUrl("https://awsstatic.com.evil.io/x.zip", ["awsstatic.com"]).ok).toBe(false);
  });
});

describe("fetchIconPack: single SVG", () => {
  test("builds a sanitized pack, lock entry and passes limits to the client", async () => {
    const url = "https://example.com/icons/My-Logo.svg";
    const { http, calls } = fakeHttp({
      [url]: { body: svg('<script>alert(1)</script><path d="M0 0"/>') },
    });
    const r = await fetchIconPack(url, { http });
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(r.pack?.manifest.pack).toMatchObject({
      id: "my-logo",
      license: "LicenseRef-user-supplied",
      redistributable: false,
    });
    const file = Object.values(r.pack?.files ?? {})[0] as string;
    expect(file).not.toContain("script");
    expect(file).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 24 24">/);
    expect(r.lock).toMatchObject({
      source: url,
      resolved: url,
      redistributable: false,
      iconCount: 1,
    });
    expect(r.lock?.integrity).toBe(computeIconIntegrity(r.pack as never));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.maxBytes).toBeGreaterThan(0);
    expect(calls[0]?.timeoutMs).toBeGreaterThan(0);
  });

  test("stored icon is stable under re-sanitizing (idempotent)", async () => {
    const url = "https://example.com/a.svg";
    const { http } = fakeHttp({
      [url]: {
        body: svg(
          '<defs><linearGradient id="g"><stop stop-color="red"/></linearGradient></defs><path fill="url(#g)" d="M0 0"/>',
        ),
      },
    });
    const r = await fetchIconPack(url, { http });
    const stored = Object.values(r.pack?.files ?? {})[0] as string;
    const again = sanitizeSvg(stored);
    expect(again.ok && again.removed).toEqual([]);
    const first = sanitizeSvg(
      svg(
        '<defs><linearGradient id="g"><stop stop-color="red"/></linearGradient></defs><path fill="url(#g)" d="M0 0"/>',
      ),
    );
    expect(again.ok && first.ok && again.svg.body).toBe(first.ok ? first.svg.body : "");
  });

  test("rejected input yields no pack", async () => {
    const url = "https://example.com/a.svg";
    const { http } = fakeHttp({ [url]: { body: "<html>not an svg</html>" } });
    const r = await fetchIconPack(url, { http });
    expect(r.pack).toBeUndefined();
    expect(codes(r)).toContain("icons/no-icons");
  });

  test("invalid or unsafe URLs never reach the client", async () => {
    const { http, calls } = fakeHttp({});
    for (const u of [
      "http://example.com/a.svg",
      "https://127.0.0.1/a.svg",
      "https://[::1]/x",
      "./local.svg",
      "/etc/passwd",
      "file:///x",
    ]) {
      const r = await fetchIconPack(u, { http });
      expect(r.pack, u).toBeUndefined();
      expect(codes(r), u).toEqual(["icons/invalid-url"]);
    }
    expect(calls).toHaveLength(0);
  });

  test("redirect to a private address or http is rejected after the fetch", async () => {
    for (const final of [
      "https://127.0.0.1/a.svg",
      "https://169.254.169.254/x",
      "http://example.com/a.svg",
      "https://localhost/a.svg",
      "https://[::1]/a.svg",
    ]) {
      const { http } = fakeHttp({ "https://example.com/a.svg": { body: svg(), url: final } });
      const r = await fetchIconPack("https://example.com/a.svg", { http });
      expect(r.pack, final).toBeUndefined();
      expect(codes(r), final).toEqual(["icons/unsafe-redirect"]);
    }
  });

  test("oversized responses and client errors are reported, never thrown", async () => {
    const big = new Uint8Array(FETCH_LIMITS.svgBytes + 1).fill(32);
    const { http } = fakeHttp({
      "https://example.com/big.svg": { body: big },
      "https://example.com/boom.svg": new Error("connect ECONNREFUSED 10.0.0.1:443 ".repeat(20)),
    });
    expect(codes(await fetchIconPack("https://example.com/big.svg", { http }))).toEqual([
      "icons/archive-too-large",
    ]);
    const r = await fetchIconPack("https://example.com/boom.svg", { http });
    expect(codes(r)).toEqual(["icons/fetch-failed"]);
    expect(r.diagnostics[0]?.message.length ?? 0).toBeLessThan(400);
    const liar = {
      get: () => Promise.resolve({ url: "https://example.com/x.svg", contentType: "", body: big }),
    } as IconHttpClient;
    expect(
      codes(await fetchIconPack("https://example.com/x.svg", { http: liar, packId: "x" })),
    ).toEqual(["icons/archive-too-large"]);
  });

  test("pack id validation", async () => {
    const { http } = fakeHttp({ "https://example.com/a.svg": { body: svg() } });
    expect(
      codes(await fetchIconPack("https://example.com/a.svg", { http, packId: "Bad Id" })),
    ).toEqual(["icons/invalid-pack-id"]);
    expect(
      codes(await fetchIconPack("https://example.com/a.svg", { http, packId: "lucide" })),
    ).toEqual(["icons/reserved-pack-id"]);
    const ok = await fetchIconPack("https://example.com/a.svg", { http, packId: "mine" });
    expect(ok.pack?.manifest.pack.id).toBe("mine");
  });
});

describe("fetchIconPack: zip archives", () => {
  const url = "https://example.com/pack.zip";

  test("extracts svgs, skips junk, dedupes ids, drops malicious icons with a warning", async () => {
    const z = zip({
      "icons/Web Server.svg": svg(),
      "icons/web-server.svg": svg('<circle r="3"/>'),
      "icons/readme.txt": "hi",
      "icons/logo.png": "png",
      "__MACOSX/icons/._Web Server.svg": "junk",
      "icons/._hidden.svg": "junk",
      "icons/evil.svg": '<!DOCTYPE svg [<!ENTITY a "b">]><svg viewBox="0 0 1 1"/>',
      "icons/scripted.svg": svg("<script>alert(1)</script>"),
    });
    const { http } = fakeHttp({ [url]: { body: z, contentType: "application/zip" } });
    const r = await fetchIconPack(url, { http });
    const ids = r.pack?.manifest.icons.map((i) => i.id);
    expect(ids).toEqual(["scripted", "web-server", "web-server-2"]);
    expect(r.diagnostics.filter((d) => d.code === "icons/svg-rejected")).toHaveLength(1);
    expect(r.lock?.iconCount).toBe(3);
    for (const f of Object.values(r.pack?.files ?? {})) expect(f).not.toContain("script");
  });

  test("deterministic: identical input gives identical pack and integrity", async () => {
    const files = { "b.svg": svg(), "a.svg": svg('<rect width="2" height="2"/>') };
    const run = async () => {
      const { http } = fakeHttp({ [url]: { body: zip(files) } });
      return fetchIconPack(url, { http });
    };
    const [x, y] = [await run(), await run()];
    expect(JSON.stringify(x)).toBe(JSON.stringify(y));
    expect(Object.keys(x.pack?.files ?? {})).toEqual(["svg/a.svg", "svg/b.svg"]);
  });

  test.each([
    ["parent traversal", "../evil.svg"],
    ["nested traversal", "icons/../../evil.svg"],
    ["absolute path", "/etc/evil.svg"],
    ["backslash traversal", "..\\evil.svg"],
    ["windows drive", "C:/evil.svg"],
    ["backslash inside", "icons\\evil.svg"],
  ])("zip-slip: %s", async (_n, name) => {
    const { http } = fakeHttp({ [url]: { body: zip({ [name]: svg(), "ok.svg": svg() }) } });
    const r = await fetchIconPack(url, { http });
    expect(r.pack).toBeUndefined();
    expect(codes(r)).toEqual(["icons/zip-slip"]);
  });

  test("zip bomb: a header that lies about the uncompressed size is detected without inflating it all", async () => {
    const z = zip({ "a.svg": new Uint8Array(5_000_000).fill(32) });
    const dv = new DataView(z.buffer, z.byteOffset, z.byteLength);
    let cd = -1;
    for (let i = 0; i < z.length - 4; i++) if (dv.getUint32(i, true) === 0x02014b50) cd = i;
    expect(cd).toBeGreaterThan(0);
    dv.setUint32(cd + 24, 100, true);
    const { http } = fakeHttp({ [url]: { body: z } });
    const r = await fetchIconPack(url, { http });
    expect(r.pack).toBeUndefined();
    expect(codes(r)).toEqual(["icons/zip-bomb"]);
  });

  test("honest oversized entries are skipped; nothing left means no pack", async () => {
    const { http } = fakeHttp({
      [url]: { body: zip({ "big.svg": new Uint8Array(FETCH_LIMITS.svgBytes + 10).fill(32) }) },
    });
    const r = await fetchIconPack(url, { http });
    expect(r.pack).toBeUndefined();
    expect(codes(r)).toEqual(["icons/svg-rejected", "icons/no-icons"]);
  });

  test("too many entries", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i <= FETCH_LIMITS.zipEntries; i++) files[`f${i}.txt`] = "";
    const { http } = fakeHttp({ [url]: { body: zip(files, 0) } });
    expect(codes(await fetchIconPack(url, { http }))).toEqual(["icons/archive-too-many-files"]);
  });

  test("too many svg files", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i <= FETCH_LIMITS.svgFiles; i++) files[`i${i}.svg`] = "";
    const { http } = fakeHttp({ [url]: { body: zip(files, 0) } });
    expect(codes(await fetchIconPack(url, { http }))).toEqual(["icons/archive-too-many-files"]);
  });

  test("total inflated size cap", async () => {
    const pad = " ".repeat(FETCH_LIMITS.svgBytes - 200);
    const files: Record<string, string> = {};
    for (let i = 0; i < 210; i++) files[`i${i}.svg`] = svg() + pad;
    const { http } = fakeHttp({ [url]: { body: zip(files) } });
    expect(codes(await fetchIconPack(url, { http }))).toEqual(["icons/archive-too-large"]);
  });

  test("corrupt archives", async () => {
    const good = zip({ "a.svg": svg() });
    const cases: Uint8Array[] = [
      new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3, 4, 5, 6, 7, 8]),
      good.subarray(0, good.length - 10),
      (() => {
        const c = good.slice();
        c[40] = (c[40] as number) ^ 0xff; // corrupt compressed data / headers
        c[41] = (c[41] as number) ^ 0xff;
        return c;
      })(),
    ];
    for (const body of cases) {
      const { http } = fakeHttp({ [url]: { body } });
      const r = await fetchIconPack(url, { http });
      expect(r.pack === undefined || (r.pack.manifest.icons.length ?? 0) >= 0).toBe(true);
      expect(r.diagnostics.length).toBeGreaterThan(0);
    }
    const { http } = fakeHttp({ [url]: { body: cases[0] as Uint8Array } });
    expect(codes(await fetchIconPack(url, { http }))).toEqual(["icons/archive-invalid"]);
    expect(() => readZipDirectory(new Uint8Array(100))).toThrow();
  });
});

describe("fetchIconPack: providers", () => {
  test("azure requires accepted terms and makes no request before that", async () => {
    const { http, calls } = fakeHttp({});
    const r = await fetchIconPack("azure", { http });
    expect(r.pack).toBeUndefined();
    expect(codes(r)).toEqual(["icons/terms-not-accepted"]);
    expect(r.terms).toMatch(/architectural diagrams, training materials, or documentation/);
    expect(calls).toHaveLength(0);
    const explicit = await fetchIconPack("azure", { http, acceptTerms: false });
    expect(codes(explicit)).toEqual(["icons/terms-not-accepted"]);
  });

  test("azure: ids, categories, prefers category folders over `other`", async () => {
    const z = zip({
      "Azure_Public_Service_Icons/Icons/compute/10021-icon-service-Virtual-Machine.svg": svg(),
      "Azure_Public_Service_Icons/Icons/other/10021-icon-service-Virtual-Machine.svg":
        svg('<circle r="1"/>'),
      "Azure_Public_Service_Icons/Icons/databases/10121-icon-service-SQL-Database.svg": svg(),
      "Azure_Public_Service_Icons/Microsoft_Terms_of_Use.pdf": "pdf",
    });
    const { http, calls } = fakeHttp({
      "https://arch-center.azureedge.net/icons/Azure_Public_Service_Icons_V25.zip": { body: z },
    });
    const r = await fetchIconPack("azure", { http, acceptTerms: true });
    expect(r.pack?.manifest.icons.map((i) => [i.id, i.category])).toEqual([
      ["sql-database", "data"],
      ["virtual-machine", "compute"],
    ]);
    expect(r.pack?.manifest.pack).toMatchObject({ id: "azure", redistributable: false });
    expect(r.pack?.files["svg/virtual-machine.svg"]).not.toContain("circle");
    expect(r.terms).toBeDefined();
    expect(r.lock).toMatchObject({ source: "azure", redistributable: false, iconCount: 2 });
    expect(calls).toHaveLength(1);
  });

  test("aws resolves the current zip from the landing page", async () => {
    const zipUrl =
      "https://d1.awsstatic.com/x/architecture-icon-release/Icon-package_07312026.abc123.zip";
    const html = `<a href="https://d1.awsstatic.com/x/architecture-icon-release/Microsoft-PPTx-toolkits_07312026.zzz.zip">ppt</a><a href="${zipUrl}">icons</a>`;
    const z = zip({
      "Architecture-Service-Icons_07312026/Arch_Compute/64/Arch_Amazon-EC2_64.svg": svg(),
      "Architecture-Service-Icons_07312026/Arch_Compute/48/Arch_Amazon-EC2_48.svg": svg(),
      "Category-Icons_07312026/Arch-Category_64/Arch-Category_Compute_64.svg": svg(),
      "Resource-Icons_07312026/Res_Storage/Res_Amazon-Simple-Storage-Service_Bucket_48.svg": svg(),
      "Resource-Icons_07312026/Res_General-Icons/Res_48_Light/Res_Server_48_Light.svg": svg(),
      "Resource-Icons_07312026/Res_General-Icons/Res_48_Dark/Res_Server_48_Dark.svg": svg(),
      "__MACOSX/Architecture-Service-Icons_07312026/Arch_Compute/64/Arch_Amazon-EC2_64.svg": "junk",
    });
    const { http, calls } = fakeHttp({
      "https://aws.amazon.com/architecture/icons/": { body: html },
      [zipUrl]: { body: z },
    });
    const r = await fetchIconPack("aws", { http });
    expect(r.pack?.manifest.icons.map((i) => i.id)).toEqual([
      "amazon-ec2",
      "category-compute",
      "res-amazon-simple-storage-service-bucket",
      "res-server",
    ]);
    expect(r.lock).toMatchObject({ source: "aws", resolved: zipUrl, redistributable: false });
    expect(r.terms).toMatch(/architecture diagrams/);
    expect(calls.map((c) => c.url)).toEqual(["https://aws.amazon.com/architecture/icons/", zipUrl]);
  });

  test("aws: zip links to other hosts are refused; redirects off-host are refused", async () => {
    const evil = "https://evil.example/Icon-package_1.zip";
    const bad = fakeHttp({
      "https://aws.amazon.com/architecture/icons/": { body: `<a href="${evil}">x</a>` },
    });
    expect(codes(await fetchIconPack("aws", { http: bad.http }))).toEqual(["icons/fetch-failed"]);
    const zipUrl = "https://d1.awsstatic.com/x/Icon-package_1.zip";
    const redir = fakeHttp({
      "https://aws.amazon.com/architecture/icons/": { body: `<a href="${zipUrl}">x</a>` },
      [zipUrl]: { body: zip({ "a.svg": svg() }), url: "https://evil.example/a.zip" },
    });
    expect(codes(await fetchIconPack("aws", { http: redir.http }))).toEqual([
      "icons/unsafe-redirect",
    ]);
  });

  test("gcp merges the product and category archives", async () => {
    const { http } = fakeHttp({
      "https://services.google.com/fh/files/misc/core-products-icons.zip": {
        body: zip({
          "Unique Icons/Compute Engine/SVG/ComputeEngine-512-color.svg": svg(),
          "Unique Icons/Compute Engine/PNG/ComputeEngine.png": "png",
        }),
      },
      "https://services.google.com/fh/files/misc/category-icons.zip": {
        body: zip({
          "Category Icons/AI _ Machine Learning/SVG/AIMachineLearning-512-color.svg": svg(),
        }),
      },
    });
    const r = await fetchIconPack("gcp", { http });
    expect(r.pack?.manifest.icons.map((i) => i.id)).toEqual([
      "category-ai-machine-learning",
      "compute-engine",
    ]);
    expect(r.terms).toMatch(/check Google's terms/);
  });

  test("cncf lists the artwork tree and fetches each svg", async () => {
    const tree = {
      sha: "d26cd4f9de255a4ec017ce617c7fc8c5600407f1",
      truncated: false,
      tree: [
        { path: "projects/agones/icon/color/agones-icon-color.svg", type: "blob" },
        { path: "projects/agones/icon/black/agones-icon-black.svg", type: "blob" },
        { path: "projects/akri/icon/color/akri-icon-color.svg", type: "blob" },
        { path: "projects/../etc/icon/color/x-icon-color.svg", type: "blob" },
        { path: "projects/dir/icon/color/dir-icon-color.svg", type: "tree" },
      ],
    };
    const raw = "https://raw.githubusercontent.com/cncf/artwork/main/";
    const { http, calls } = fakeHttp({
      "https://api.github.com/repos/cncf/artwork/git/trees/main?recursive=1": {
        body: JSON.stringify(tree),
      },
      [`${raw}projects/agones/icon/color/agones-icon-color.svg`]: { body: svg() },
      [`${raw}projects/akri/icon/color/akri-icon-color.svg`]: { body: svg() },
    });
    const r = await fetchIconPack("cncf", { http });
    expect(r.pack?.manifest.icons.map((i) => i.id)).toEqual(["agones", "akri"]);
    expect(r.pack?.manifest.pack.version).toBe("artwork@d26cd4f9de25");
    expect(r.terms).toMatch(/trademark/);
    expect(calls).toHaveLength(3);
  });

  test("github tree URLs work as an SVG folder listing", async () => {
    const tree = {
      sha: "abc",
      tree: [
        { path: "icons/a.svg", type: "blob" },
        { path: "icons/sub/b.svg", type: "blob" },
        { path: "other/c.svg", type: "blob" },
        { path: "icons/readme.md", type: "blob" },
      ],
    };
    const raw = "https://raw.githubusercontent.com/acme/set/v1/";
    const { http } = fakeHttp({
      "https://api.github.com/repos/acme/set/git/trees/v1?recursive=1": {
        body: JSON.stringify(tree),
      },
      [`${raw}icons/a.svg`]: { body: svg() },
      [`${raw}icons/sub/b.svg`]: { body: svg() },
    });
    const r = await fetchIconPack("https://github.com/acme/set/tree/v1/icons", { http });
    expect(r.pack?.manifest.icons.map((i) => i.id)).toEqual(["a", "b"]);
    expect(r.pack?.manifest.pack.id).toBe("icons");
  });
});

describe("integrity", () => {
  test("sha256 matches node:crypto", () => {
    const enc = new TextEncoder();
    for (const s of [
      "",
      "abc",
      "a".repeat(55),
      "a".repeat(56),
      "a".repeat(64),
      "héllo wörld".repeat(100),
    ]) {
      const expected = createHash("sha256").update(s).digest();
      expect(Buffer.from(sha256(enc.encode(s))).equals(expected), s.slice(0, 10)).toBe(true);
    }
  });

  test("integrity covers manifest and every file, independent of key order", () => {
    const base = {
      manifest: {
        manifestVersion: 1 as const,
        pack: {
          id: "p",
          name: "p",
          version: "1",
          license: "MIT",
          source: "x",
          redistributable: false,
        },
        icons: [
          {
            id: "a",
            aliases: [],
            category: "general" as const,
            file: "svg/a.svg",
            monochrome: false,
          },
        ],
      },
      files: { "svg/a.svg": svg(), "svg/b.svg": svg() },
    };
    const i1 = computeIconIntegrity(base);
    expect(i1).toMatch(/^sha256-[A-Za-z0-9+/]{43}=$/);
    const reordered = {
      files: { "svg/b.svg": svg(), "svg/a.svg": svg() },
      manifest: JSON.parse(JSON.stringify(base.manifest)),
    };
    expect(computeIconIntegrity(reordered)).toBe(i1);
    expect(verifyIconIntegrity(base, i1)).toBe(true);
    expect(
      verifyIconIntegrity({ ...base, files: { ...base.files, "svg/a.svg": svg("<g/>") } }, i1),
    ).toBe(false);
    expect(verifyIconIntegrity({ ...base, files: { "svg/a.svg": svg() } }, i1)).toBe(false);
    const m2 = { ...base.manifest, pack: { ...base.manifest.pack, license: "ISC" } };
    expect(verifyIconIntegrity({ ...base, manifest: m2 }, i1)).toBe(false);
  });

  test("a fetched pack round-trips through the resolver", async () => {
    const { http } = fakeHttp({ "https://example.com/p.zip": { body: zip({ "x.svg": svg() }) } });
    const r = await fetchIconPack("https://example.com/p.zip", { http, packId: "mine" });
    expect(verifyIconIntegrity(r.pack as never, r.lock?.integrity as string)).toBe(true);
    const resolver = createIconResolver([r.pack as never], sanitizeSvg);
    expect(resolver.resolve("mine:x")?.svg.viewBox).toBe("0 0 24 24");
  });
});
