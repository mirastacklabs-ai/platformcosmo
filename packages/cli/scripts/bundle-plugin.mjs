// Builds the single-file CLI the Claude Code plugin ships: plugin/bin/pcosmo.mjs, plus the
// third-party license file generated from the packages that actually went into it.
// Bundles the CLI and every @platformcosmo/* package from source (no build order needed) plus
// all third-party deps, so the installed plugin needs nothing but Node >= 22.12.
//
//   node packages/cli/scripts/bundle-plugin.mjs            rebuild plugin/bin/pcosmo.mjs and plugin/THIRD_PARTY_NOTICES.md
//   node packages/cli/scripts/bundle-plugin.mjs --check    fail when either committed file is stale
//
// The output is minified with no path comments, so it is byte-stable for identical sources.
import { Buffer } from "node:buffer";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const outfile = `${root}plugin/bin/pcosmo.mjs`;
const noticesFile = `${root}plugin/THIRD_PARTY_NOTICES.md`;
const src = (pkg) => `${root}packages/${pkg}/src/index.ts`;

// CommonJS deps (ajv) call require() on Node builtins; give the ESM bundle a require.
const BANNER =
  '/* eslint-disable */\nimport{createRequire as __pcRequire}from"node:module";const require=__pcRequire(import.meta.url);';

// css-tree (via SVGO/csso) loads JSON with createRequire(import.meta.url).require(...), which cannot
// work once everything is one file. Rewrite those few modules to static JSON imports.
const inlineRequires = {
  name: "inline-css-tree-requires",
  setup(b) {
    b.onLoad(
      { filter: /[\\/](?:css-tree|csso)[\\/]lib[\\/](version|data-patch|data)\.js$/ },
      (args) => {
        let code = readFileSync(args.path, "utf8");
        code = code
          .replace(/import \{ createRequire \} from ['"]module['"];\n?/, "")
          .replace(/const require = createRequire\(import\.meta\.url\);\n?/, "");
        const imports = [];
        code = code.replace(/require\((['"])([^'"]+)\1\)/g, (_m, _q, spec) => {
          const name = `__req${imports.length}`;
          imports.push(`import ${name} from ${JSON.stringify(spec)};`);
          return name;
        });
        if (imports.length === 0)
          throw new Error(`css-tree rewrite found no require() in ${args.path}`);
        if (/\brequire\b/.test(code)) {
          throw new Error(`css-tree rewrite left a require in ${args.path}; extend the rewrite`);
        }
        return {
          contents: `${imports.join("\n")}\n${code}`,
          loader: "js",
          resolveDir: dirname(args.path),
        };
      },
    );
    // core reads the resvg wasm from node_modules unless setResvgWasm ran first (the entry below does).
    b.onLoad({ filter: /[\\/]export[\\/]rasterize\.ts$/ }, (args) => {
      const code = readFileSync(args.path, "utf8");
      const re =
        /createRequire\(import\.meta\.url\)\.resolve\(\s*"@resvg\/resvg-wasm\/index_bg\.wasm"\s*\)/;
      if (!re.test(code)) throw new Error("core rasterize.ts changed; update the bundle rewrite");
      return {
        contents: code.replace(re, '"<bundled>"'),
        loader: "ts",
        resolveDir: dirname(args.path),
      };
    });
  },
};

const result = await build({
  // Virtual entry: inline the resvg wasm (core would otherwise read it from node_modules at runtime)
  // and hand it to core before the CLI starts.
  stdin: {
    contents: [
      `import wasm from ${JSON.stringify(`${root}packages/core/node_modules/@resvg/resvg-wasm/index_bg.wasm`)};`,
      'import { setResvgWasm } from "@platformcosmo/core";',
      "setResvgWasm(wasm);",
      'await import("./bin.ts");',
    ].join("\n"),
    resolveDir: `${root}packages/cli/src`,
    sourcefile: "plugin-entry.ts",
    loader: "ts",
  },
  outfile,
  absWorkingDir: root,
  write: false,
  metafile: true,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: true,
  legalComments: "none",
  charset: "ascii",
  // Assets (resvg wasm, fonts) must be inlined: the plugin ships exactly one file.
  loader: { ".wasm": "binary", ".woff2": "binary", ".ttf": "binary", ".otf": "binary" },
  logLevel: "warning",
  alias: {
    "@platformcosmo/core/internal": `${root}packages/core/src/internal.ts`,
    "@platformcosmo/core/node": `${root}packages/core/src/node.ts`,
    "@platformcosmo/core": src("core"),
    "@platformcosmo/themes": src("themes"),
    "@platformcosmo/assets": src("assets"),
    "@platformcosmo/pdf": src("pdf"),
    "@platformcosmo/dc-pack": src("dc-pack"),
    "@platformcosmo/icons-base": src("icons-base"),
    "@platformcosmo/icons-lucide": src("icons-lucide"),
    "@platformcosmo/icons-k8s": src("icons-k8s"),
    "@platformcosmo/icons-simple": src("icons-simple"),
    "@platformcosmo/parts-auto": src("parts-auto"),
    "@platformcosmo/parts-base": src("parts-base"),
    "@platformcosmo/parts-brick": src("parts-brick"),
  },
  plugins: [inlineRequires],
  banner: { js: BANNER },
});

if (result.outputFiles.length !== 1) {
  console.error(`expected one output file, esbuild produced ${result.outputFiles.length}`);
  process.exit(1);
}
const text = result.outputFiles[0].text;
// esbuild keeps the entry's shebang first; the launcher runs `node pcosmo.mjs`, so drop it.
const out = text.startsWith("#!") ? text.slice(text.indexOf("\n") + 1) : text;

// A runtime file read relative to the bundle would break once the plugin is copied. The banner's own
// import.meta.url (for createRequire) is the only allowed use.
const body = out.startsWith(BANNER) ? out.slice(BANNER.length) : out;
const bad = /import\.meta\.(url|dirname|filename)|require\.resolve/.exec(body);
if (bad) {
  console.error(
    `bundle uses ${bad[0]} outside the banner (…${body.slice(Math.max(0, bad.index - 120), bad.index + 80)}…); inline that asset with a loader or avoid the call`,
  );
  process.exit(1);
}

// ---- third-party notices from the packages that were actually bundled ----
function packageRoots() {
  const roots = new Set();
  for (const file of Object.keys(result.metafile.inputs)) {
    const i = file.lastIndexOf("node_modules/");
    if (i < 0) continue;
    const m = /^((?:@[^/]+\/)?[^/]+)\//.exec(file.slice(i + "node_modules/".length));
    if (m) roots.add(file.slice(0, i + "node_modules/".length) + m[1]);
  }
  return [...roots];
}

function licenseText(dir) {
  const names = readdirSync(dir).filter((n) => /^(licen[sc]e|copying|notice)(\.|$)/i.test(n));
  names.sort(cmp);
  return names.map((n) => readFileSync(join(dir, n), "utf8").replace(/\r\n/g, "\n").trim());
}

// Plain code-unit order (locale independent, byte-stable across machines).
function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

const licensesDir = fileURLToPath(new URL("./licenses/", import.meta.url));
const spdx = (id) => readFileSync(`${licensesDir}${id}.txt`, "utf8").replace(/\r\n/g, "\n").trim();
const VENDORED = new Set(["MIT", "ISC", "BSD-3-Clause", "Apache-2.0", "MPL-2.0"]);

// Packages that may ship no usable license information; each needs a reason. Everything else must
// either ship a license file or declare one of the vendored SPDX ids plus an author.
const ALLOWLIST = {};

// Embedded binary assets that carry their own license obligations (they are not JS inputs).
const WASM_NOTICE = {
  "@resvg/resvg-wasm": {
    // The version this notice and licenses/resvg-wasm-rust-crates.md were written for.
    version: "2.6.2",
    source:
      "Source Code Form: https://github.com/yisibl/resvg-js/tree/v2.6.2 (unmodified); license: https://mozilla.org/MPL/2.0/",
    license: "MPL-2.0",
    extra: () => readFileSync(`${licensesDir}resvg-wasm-rust-crates.md`, "utf8").trim(),
  },
};

function normalizeRepo(r) {
  let u = typeof r === "string" ? r : (r?.url ?? "");
  u = u
    .trim()
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/^ssh:\/\/git@/, "https://");
  u = u
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/^github:/, "https://github.com/");
  if (/^[\w.-]+\/[\w.-]+$/.test(u)) u = `https://github.com/${u}`;
  return u.replace(/\.git$/, "").replace(/\/$/, "");
}

function authorName(pj) {
  const a = pj.author ?? pj.contributors?.[0];
  if (!a) return "";
  const n = typeof a === "string" ? a : (a.name ?? "");
  return n.replace(/\s*[<(].*$/, "").trim();
}

function notices() {
  const problems = [];
  const pkgs = packageRoots()
    .map((rel) => {
      const dir = join(root, rel);
      const pj = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      return { dir, pj };
    })
    .filter(({ pj }) => !String(pj.name).startsWith("@platformcosmo/"))
    .sort((x, y) => cmp(`${x.pj.name}@${x.pj.version}`, `${y.pj.name}@${y.pj.version}`));
  const lines = [
    "# Third-party notices",
    "",
    "`bin/pcosmo.mjs` is a single-file bundle of PlatformCosmo (Apache-2.0, Copyright 2026 MIRASTACK LABS PRIVATE LIMITED) and",
    "the third-party packages listed below, in full with their copyright and license text. This file is",
    "generated from the bundle's inputs (`scripts/pc run bundle:plugin`); do not edit it.",
    "",
  ];
  for (const { dir, pj } of pkgs) {
    const id = `${pj.name}@${pj.version}`;
    const wasm = WASM_NOTICE[pj.name];
    if (wasm && wasm.version !== pj.version) {
      problems.push(
        `${id}: the bundled ${pj.name} is ${pj.version} but the notice was written for ${wasm.version}; update the resvg notice (WASM_NOTICE) and regenerate the crate list (scripts/gen-resvg-notices.sh)`,
      );
    }
    const license =
      wasm?.license ??
      (typeof pj.license === "string"
        ? pj.license
        : (pj.license?.type ??
          (pj.licenses ? pj.licenses.map((l) => l.type).join(" OR ") : "UNKNOWN")));
    const repo = normalizeRepo(pj.repository);
    lines.push(`## ${pj.name} ${pj.version}`, "", `License: ${license}`);
    if (repo) lines.push(`Source: ${repo}`);
    if (wasm) lines.push(wasm.source);
    lines.push("");
    let texts = licenseText(dir);
    if (wasm) texts = [spdx(wasm.license), wasm.extra()];
    if (texts.length === 0) {
      const author = authorName(pj);
      if (ALLOWLIST[id]) {
        lines.push(`(No license text; allowlisted: ${ALLOWLIST[id]})`, "");
      } else if (VENDORED.has(license) && author) {
        texts = [spdx(license).replace("{{copyright}}", author)];
      } else {
        problems.push(
          `${id}: no license file and cannot derive one (license "${license}", author "${author}")`,
        );
      }
    } else if (license === "UNKNOWN" && !ALLOWLIST[id]) {
      problems.push(`${id}: no license declared in package.json`);
    }
    for (const t of texts) lines.push("~~~~text", t, "~~~~", "");
  }
  if (problems.length > 0) {
    console.error(
      `third-party notices cannot be generated:\n  ${problems.join("\n  ")}\nAdd a vendored license text or an ALLOWLIST entry (with a reason) in bundle-plugin.mjs.`,
    );
    process.exit(1);
  }
  // Icon packs and the font that are compiled into the bundle (their text lives in /LICENSES).
  const BUNDLED_ASSETS = [
    ["cosmo", "PlatformCosmo original glyphs (icon pack `cosmo`)"],
    ["lucide", "Lucide icons (icon pack `lucide`): ISC, plus MIT for the Feather-derived icons"],
    ["k8s", "Kubernetes icons (icon pack `k8s`): Apache-2.0; Linux Foundation trademark note"],
    ["simple-icons", "Simple Icons (icon pack `simple`): license summary and trademark notice"],
    ["NOTICE-SIMPLE-ICONS", "Simple Icons: per-icon notices for the Apache-2.0 icons"],
    [
      "Oswald-OFL-1.1",
      "Oswald font subsets embedded for text rendering (display text): SIL OFL 1.1",
    ],
    [
      "JetBrainsMono-OFL-1.1",
      "JetBrains Mono font subsets embedded for text rendering (technical text): SIL OFL 1.1",
    ],
  ];
  lines.push("# Bundled icon packs and fonts", "");
  for (const [file, title] of BUNDLED_ASSETS) {
    const path = join(root, "LICENSES", `${file}.txt`);
    lines.push(
      `## ${title}`,
      "",
      "~~~~text",
      readFileSync(path, "utf8").replace(/\r\n/g, "\n").trim(),
      "~~~~",
      "",
    );
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
// Size guard. Baseline: 6,052,234 bytes (R-2 storyboards, +15 KB on top of 6,036,917, which the
// assemblies Phase 2/3 work had reached: depth copies, the levels/views/builds animator, close-up
// checks, label and image fixes, suggest heuristics, definePack; 5,968,158 for D-2b; 5,842,308 for
// D-1 on top of D-2a; 5,382,188 with the brand fonts before those). The guard sits about 1.3%
// above, so any growth needs a decision: raise it only with a PR note that lists what grew and why.
const MAX_BUNDLE_BYTES = 6_130_000;
if (Buffer.byteLength(out) > MAX_BUNDLE_BYTES) {
  console.error(
    `plugin/bin/pcosmo.mjs is ${Buffer.byteLength(out)} bytes, over the ${MAX_BUNDLE_BYTES} guard; check for an accidental dependency or asset.`,
  );
  process.exit(1);
}
const noticesText = notices();

const targets = [
  { file: outfile, text: out, label: "plugin/bin/pcosmo.mjs" },
  { file: noticesFile, text: noticesText, label: "plugin/THIRD_PARTY_NOTICES.md" },
];

if (process.argv.includes("--check")) {
  let stale = 0;
  for (const t of targets) {
    const cur = existsSync(t.file) ? readFileSync(t.file, "utf8") : "";
    if (cur !== t.text) {
      console.error(
        `${t.label} is stale (sources changed). Run: scripts/pc run bundle:plugin and commit it.`,
      );
      stale++;
    } else console.log(`${t.label} is up to date`);
  }
  process.exit(stale ? 1 : 0);
} else {
  mkdirSync(`${root}plugin/bin`, { recursive: true });
  for (const t of targets) {
    writeFileSync(t.file, t.text);
    console.log(`wrote ${t.label} (${t.text.length} bytes)`);
  }
}
