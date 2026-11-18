// Dev-time vendoring script (not part of the build). Fetch lucide-static 1.75.0 (curl -sL https://registry.npmjs.org/lucide-static/-/lucide-static-1.75.0.tgz | tar xz into a scratch dir -> ./package), then from the repo root:
//   docker run --rm -v "$PWD":/work -w /work node:24.21-bookworm-slim node packages/icons-lucide/scripts/vendor.mjs <scratch>/package packages/icons-lucide
//   docker run --rm -v "$PWD":/work -w /work node:24.21-bookworm-slim node packages/icons-base/scripts/gen-pack.mjs packages/icons-lucide
import { readFileSync, readdirSync, writeFileSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";

const up = process.argv[2]; // lucide-static package dir
const out = process.argv[3]; // packages/icons-lucide
const version = JSON.parse(readFileSync(`${up}/package.json`, "utf8")).version;

const groups = {
  compute:
    "server server-cog server-crash cpu microchip hard-drive container box boxes package layers terminal square-terminal code braces workflow cog settings binary memory-stick hard-drive-download hard-drive-upload",
  network:
    "network globe cloud cloud-upload cloud-download cloud-cog cloud-off router wifi radio-tower cable plug unplug waypoints split merge route signal satellite-dish earth link share-2 ethernet-port antenna",
  data: "database database-zap database-backup archive folder folder-open file file-text file-json file-code table table-2 layout-grid sheet hash list-ordered import funnel arrow-down-up shuffle",
  client:
    "monitor laptop smartphone tablet user users user-round user-check tv watch keyboard mouse-pointer headphones app-window",
  observability:
    "activity chart-line chart-bar chart-pie chart-area gauge scroll-text bell siren eye search telescope radar bug timer clock history list-checks",
  cicd: "git-branch git-commit-horizontal git-merge git-pull-request git-fork play rocket refresh-cw repeat hammer wrench package-check package-open flag tag test-tube flask-conical circle-check",
  security:
    "shield shield-check shield-alert shield-off lock lock-open key key-round fingerprint-pattern scan-face badge-check ban eye-off vault id-card",
  ai: "brain brain-circuit sparkles bot message-square message-circle wand-sparkles scan-search atom bot-message-square",
  general:
    "arrow-right arrow-left arrow-up arrow-down arrow-left-right check x circle-alert info triangle-alert plus minus star heart house calendar mail send phone map-pin map zap flame battery power download upload external-link circle-help lightbulb book-open bookmark building building-2 factory store shopping-cart credit-card wallet banknote truck",
};

const license = readFileSync(`${up}/LICENSE`, "utf8");
const featherBlock =
  /derived from the Feather project:\s*([^]*?)\n\nThe MIT License/.exec(license)?.[1] ?? "";
const feather = new Set(
  featherBlock
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
if (feather.size < 100) throw new Error("could not parse Feather list");

const norm = (s) =>
  s
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\sclass="[^"]*"/, "")
    .replace(/\s+/g, " ")
    .trim();
const files = readdirSync(`${up}/icons`)
  .filter((f) => f.endsWith(".svg"))
  .sort();
const byHash = new Map();
for (const f of files) {
  const h = createHash("sha256")
    .update(norm(readFileSync(`${up}/icons/${f}`, "utf8")))
    .digest("hex");
  (byHash.get(h) ?? byHash.set(h, []).get(h)).push(f.slice(0, -4));
}
const tags = JSON.parse(readFileSync(`${up}/tags.json`, "utf8"));

rmSync(`${out}/svg`, { recursive: true, force: true });
mkdirSync(`${out}/svg`, { recursive: true });
const icons = [];
const missing = [];
const seen = new Set();
for (const [category, list] of Object.entries(groups)) {
  for (const id of list.split(/\s+/)) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (!files.includes(`${id}.svg`)) {
      missing.push(id);
      continue;
    }
    copyFileSync(`${up}/icons/${id}.svg`, `${out}/svg/${id}.svg`);
    const h = createHash("sha256")
      .update(norm(readFileSync(`${up}/icons/${id}.svg`, "utf8")))
      .digest("hex");
    const same = (byHash.get(h) ?? []).filter((n) => n !== id).sort();
    const mit = feather.has(id) || same.some((n) => feather.has(n));
    icons.push({
      id,
      aliases: same,
      category,
      tags: (tags[id] ?? []).slice(0, 8).map((t) => t.toLowerCase()),
      file: `svg/${id}.svg`,
      ...(mit ? { license: "MIT" } : {}),
      sourceUrl: `https://unpkg.com/lucide-static@${version}/icons/${id}.svg`,
      monochrome: true,
    });
  }
}
if (missing.length) throw new Error(`missing from lucide-static: ${missing.join(" ")}`);
icons.sort((a, b) => (a.id < b.id ? -1 : 1));
const manifest = {
  manifestVersion: 1,
  pack: {
    id: "lucide",
    name: "Lucide",
    version,
    license: "ISC",
    licenseUrl: "https://lucide.dev/license",
    attribution:
      "Lucide Icons and Contributors (ISC). Icons derived from Feather are Copyright (c) 2013-present Cole Bemis (MIT).",
    source: "https://github.com/lucide-icons/lucide",
    redistributable: true,
  },
  icons,
};
writeFileSync(`${out}/icons.json`, JSON.stringify(manifest, null, 2) + "\n");
writeFileSync(`${out}/LICENSE-LUCIDE`, license);
console.log(`${icons.length} icons, ${icons.filter((i) => i.license).length} MIT`);
