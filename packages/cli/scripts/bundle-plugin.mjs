// Builds the single-file CLI the Claude Code plugin ships: plugin/bin/pcosmo.mjs, plus the
// third-party license file generated from the packages that actually went into it.
// Bundles the CLI and every @platformcosmo/* package from source (no build order needed) plus
// all third-party deps, so the installed plugin needs nothing but Node >= 22.12.
//
//   node packages/cli/scripts/bundle-plugin.mjs            rebuild plugin/bin/pcosmo.mjs and plugin/THIRD_PARTY_NOTICES.md
//   node packages/cli/scripts/bundle-plugin.mjs --check    fail when either committed file is stale
//
// The output is minified with no path comments, so it is byte-stable for identical sources.
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
    "@platformcosmo/core": src("core"),
    "@platformcosmo/themes": src("themes"),
    "@platformcosmo/dc-pack": src("dc-pack"),
    "@platformcosmo/icons-base": src("icons-base"),
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
  names.sort();
  return names.map((n) => readFileSync(join(dir, n), "utf8").replace(/\r\n/g, "\n").trim());
}

function notices() {
  const pkgs = packageRoots()
    .map((rel) => {
      const dir = join(root, rel);
      const pj = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      return { dir, pj };
    })
    .filter(({ pj }) => !String(pj.name).startsWith("@platformcosmo/"))
    .sort((a, b) =>
      `${a.pj.name}@${a.pj.version}`.localeCompare(`${b.pj.name}@${b.pj.version}`, "en"),
    );
  const lines = [
    "# Third-party notices",
    "",
    "`bin/pcosmo.mjs` is a single-file bundle of PlatformCosmo (Apache-2.0, Copyright 2026 MiraStack Labs) and",
    "the third-party packages listed below, in full with their copyright and license text. This file is",
    "generated from the bundle's inputs (`scripts/pc run bundle:plugin`); do not edit it.",
    "",
    "Packages such as `@resvg/resvg-wasm` (MPL-2.0, covers the WebAssembly binary only) and SVGO (MIT) are",
    "included, with their full text, only once they are part of the bundle.",
    "",
  ];
  for (const { dir, pj } of pkgs) {
    const license =
      typeof pj.license === "string"
        ? pj.license
        : (pj.license?.type ??
          (pj.licenses ? pj.licenses.map((l) => l.type).join(" OR ") : "UNKNOWN"));
    const repo = typeof pj.repository === "string" ? pj.repository : (pj.repository?.url ?? "");
    lines.push(`## ${pj.name} ${pj.version}`, "", `License: ${license}`);
    if (repo) lines.push(`Source: ${repo.replace(/^git\+/, "")}`);
    lines.push("");
    const texts = licenseText(dir);
    if (texts.length === 0) {
      lines.push(
        `(The package ships no license file; its package.json declares ${license}.` +
          `${pj.author ? ` Author: ${typeof pj.author === "string" ? pj.author : pj.author.name}.` : ""})`,
        "",
      );
    }
    for (const t of texts) lines.push("~~~~text", t, "~~~~", "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
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
