// Dev-time vendoring script (not part of the build). See the header of icons.json for the pinned upstream.
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
for (const d of data) {
  const lic = d.license?.type;
  if (!ALLOWED.has(lic)) continue;
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
      "All brand names, logos and marks are trademarks of their respective owners. Their inclusion implies no affiliation or endorsement. See https://github.com/simple-icons/simple-icons/blob/develop/DISCLAIMER.md.",
    source: "https://github.com/simple-icons/simple-icons",
    redistributable: true,
  },
  icons,
};
writeFileSync(`${out}/icons.json`, JSON.stringify(manifest, null, 2) + "\n");
copyFileSync(`${up}/LICENSE.md`, `${out}/LICENSE-SIMPLE-ICONS.txt`);
copyFileSync(`${up}/DISCLAIMER.md`, `${out}/DISCLAIMER-SIMPLE-ICONS.txt`);
console.log(`${icons.length} icons; skipped over budget: ${skipped.join(" ") || "none"}`);
