// Dev-time vendoring script (not part of the build); regenerates svg/, icons.json, the license
// files and NOTICE-SIMPLE-ICONS.txt (also mirrored to LICENSES/). Needs the simple-icons npm
// package, e.g. `curl -sL https://registry.npmjs.org/simple-icons/-/simple-icons-16.38.0.tgz | tar xz`
// into a scratch dir (creates ./package), then from the repo root (Node 24 strips the TS types):
//   docker run --rm -v "$PWD":/work -w /work node:24.21-bookworm-slim \
//     node packages/icons-simple/scripts/vendor.mjs <scratch>/package packages/icons-simple
// then regenerate the embedded module:
//   docker run --rm -v "$PWD":/work -w /work node:24.21-bookworm-slim \
//     node packages/icons-base/scripts/gen-pack.mjs packages/icons-simple
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { sanitizeSvg } from "../../core/src/icons/sanitize.ts";

const up = process.argv[2]; // simple-icons package dir
const out = process.argv[3]; // packages/icons-simple
const version = JSON.parse(readFileSync(`${up}/package.json`, "utf8")).version;
const data = JSON.parse(readFileSync(`${up}/data/simple-icons.json`, "utf8"));

// Only icons whose own data entry carries an explicit permissive license. Absence of a
// license field is NOT treated as permissive.
const ALLOWED = new Set(["CC0-1.0", "MIT", "Apache-2.0"]);
const kebab = (s) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

rmSync(`${out}/svg`, { recursive: true, force: true });
mkdirSync(`${out}/svg`, { recursive: true });
const icons = [];
const skipped = [];
const noNotice = [];
const titles = new Map();
for (const d of data) {
  titles.set(d.slug, d.title);
  const lic = d.license?.type;
  if (!ALLOWED.has(lic)) continue;
  // MIT/Apache icons must carry an identifiable notice: the data has no license URL or holder,
  // so the upstream `source` URL is the notice pointer and is required.
  if (lic !== "CC0-1.0" && !/^https:\/\//.test(d.source ?? "")) {
    noNotice.push(d.slug);
    continue;
  }
  // Size budget: sanitized body must stay within 8 KB; larger brand logos are left out.
  const san = sanitizeSvg(readFileSync(`${up}/icons/${d.slug}.svg`, "utf8"), { monochrome: true });
  if (!san.ok || san.svg.body.length > 8192) {
    skipped.push(d.slug);
    continue;
  }
  copyFileSync(`${up}/icons/${d.slug}.svg`, `${out}/svg/${d.slug}.svg`);
  const aliases = new Set([kebab(d.title), ...(d.aliases?.aka ?? []).map(kebab)]);
  aliases.delete(d.slug);
  aliases.delete("");
  icons.push({
    id: d.slug,
    aliases: [...aliases].sort(),
    category: "brand",
    provider: d.slug,
    tags: [],
    file: `svg/${d.slug}.svg`,
    license: lic,
    sourceUrl: d.source,
    monochrome: true,
  });
}
icons.sort((a, b) => (a.id < b.id ? -1 : 1));
// Aliases must be unique across the pack and must not shadow ids.
const taken = new Set(icons.map((i) => i.id));
for (const i of icons) {
  i.aliases = i.aliases.filter((a) => {
    if (taken.has(a)) return false;
    taken.add(a);
    return true;
  });
}
const manifest = {
  manifestVersion: 1,
  pack: {
    id: "simple",
    name: "Simple Icons (permissively licensed subset)",
    version,
    license: "CC0-1.0",
    licenseUrl: "https://github.com/simple-icons/simple-icons/blob/develop/LICENSE.md",
    attribution:
      "Simple Icons contributors. Only icons whose data entry declares CC0-1.0, MIT or Apache-2.0 are included; each icon's license is recorded in icons.json.",
    trademarkNotice:
      "All brand names, logos and marks are trademarks of their respective owners. Their inclusion implies no affiliation or endorsement. See https://github.com/simple-icons/simple-icons/blob/develop/DISCLAIMER.md. Marks of projects hosted by the CNCF or the Linux Foundation (for example Fluentd and Rook) are also subject to the Linux Foundation trademark usage guidelines (https://www.linuxfoundation.org/legal/trademark-usage).",
    source: "https://github.com/simple-icons/simple-icons",
    redistributable: true,
  },
  icons,
};
writeFileSync(`${out}/icons.json`, JSON.stringify(manifest, null, 2) + "\n");
copyFileSync(`${up}/LICENSE.md`, `${out}/LICENSE-SIMPLE-ICONS.txt`);
copyFileSync(`${up}/DISCLAIMER.md`, `${out}/DISCLAIMER-SIMPLE-ICONS.txt`);

// --- NOTICE for the non-CC0 icons (MIT and Apache-2.0 require their notice to travel) ---------
const MIT_TEXT = `Permission is hereby granted, free of charge, to any person obtaining a copy of this
software and associated documentation files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;
const APACHE_TEXT = readFileSync(new URL("../../../LICENSE", import.meta.url), "utf8").trim();
const entry = (i) =>
  `  - ${titles.get(i.id)} (simple:${i.id})\n    Upstream source and copyright holders: ${i.sourceUrl}`;
const byLicense = (l) =>
  icons
    .filter((i) => i.license === l)
    .map(entry)
    .join("\n");
const notice = `Simple Icons: notices for MIT and Apache-2.0 licensed icons (pack id "simple")

The Simple Icons data declares an explicit license for each icon listed below, but gives no
license URL or copyright holder. Each icon is copyright its original authors (see the upstream
source URL listed with it, which is where the authoritative copyright notice lives) and is
redistributed here, unmodified, under the stated license. Brand names, logos and marks remain
trademarks of their owners; marks of CNCF or Linux Foundation hosted projects (for example
Fluentd and Rook) are also subject to the Linux Foundation trademark usage guidelines
(https://www.linuxfoundation.org/legal/trademark-usage). Icons licensed CC0-1.0 need no notice.

================================================================================
MIT License: "Copyright (c) the authors of each work listed under the upstream source"
================================================================================

Icons:
${byLicense("MIT")}

${MIT_TEXT}

================================================================================
Apache License 2.0: copyright held by the authors of each work listed below
================================================================================

Icons:
${byLicense("Apache-2.0")}

${APACHE_TEXT}
`;
writeFileSync(`${out}/NOTICE-SIMPLE-ICONS.txt`, notice);
writeFileSync(new URL("../../../LICENSES/NOTICE-SIMPLE-ICONS.txt", import.meta.url), notice);
console.log(
  `${icons.length} icons; skipped over budget: ${skipped.join(" ") || "none"}; dropped for no notice: ${noNotice.join(" ") || "none"}`,
);
