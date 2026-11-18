/* global fetch */
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
import { URL } from "node:url";
import { sanitizeSvg } from "../../core/src/icons/sanitize.ts";

const up = process.argv[2]; // simple-icons package dir
const out = process.argv[3]; // packages/icons-simple
const version = JSON.parse(readFileSync(`${up}/package.json`, "utf8")).version;
const data = JSON.parse(readFileSync(`${up}/data/simple-icons.json`, "utf8"));

// Only icons whose own data entry carries an explicit permissive license. Absence of a
// license field is NOT treated as permissive.
// MIT icons are NOT bundled (ruling D26: MIT requires the copyright notice to travel, and the
// data carries no holder). Apache-2.0 icons are kept only when the upstream repository at the
// pinned commit is verified (below) to have no NOTICE file, or its NOTICE is shipped verbatim.
const ALLOWED = new Set(["CC0-1.0", "Apache-2.0"]);
const CHECKED_ON = new Date().toISOString().slice(0, 10);
const gh = (url) =>
  fetch(url, {
    headers: {
      "user-agent": "platformcosmo-vendor",
      ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    },
  });
const upstreamCache = new Map();
/** Dev-time check of the upstream repo root at the pinned commit; `undefined` = unverifiable. */
async function upstreamNotice(source) {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([0-9a-f]{40})\//.exec(source ?? "");
  if (!m) return undefined;
  const [, owner, repo, sha] = m;
  const listing = `https://api.github.com/repos/${owner}/${repo}/contents/?ref=${sha}`;
  if (upstreamCache.has(listing)) return upstreamCache.get(listing);
  let result;
  try {
    const res = await gh(listing);
    if (res.ok) {
      const files = await res.json();
      const n = files.find((f) => f.type === "file" && /^NOTICE(\.|$)/i.test(f.name));
      if (n) {
        const t = await gh(n.download_url);
        if (t.ok) result = { checked: listing, notice: { name: n.name, text: await t.text() } };
      } else {
        result = { checked: listing, notice: null };
      }
    }
  } catch {
    result = undefined;
  }
  upstreamCache.set(listing, result);
  return result;
}
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
const verified = new Map();
const titles = new Map();
for (const d of data) {
  titles.set(d.slug, d.title);
  const lic = d.license?.type;
  if (!ALLOWED.has(lic)) continue;
  if (lic === "Apache-2.0") {
    const up = await upstreamNotice(d.source);
    if (!up) {
      noNotice.push(d.slug); // unverifiable (not a pinned GitHub blob URL, or the check failed)
      continue;
    }
    verified.set(d.slug, up);
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
      "Simple Icons contributors. Only icons whose data entry declares CC0-1.0, or Apache-2.0 with a verified upstream NOTICE status, are included (MIT icons are excluded); each icon's license is recorded in icons.json.",
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

// --- NOTICE for the Apache-2.0 icons -------------------------------------------------------
const APACHE_TEXT = readFileSync(new URL("../../../LICENSE", import.meta.url), "utf8").trim();
const apache = icons.filter((i) => i.license === "Apache-2.0");
const entry = (i) => {
  const v = verified.get(i.id);
  const status = v.notice
    ? `upstream NOTICE reproduced verbatim below (${v.notice.name}; checked ${CHECKED_ON}, ${v.checked})`
    : `no upstream NOTICE (checked ${CHECKED_ON}, ${v.checked})`;
  return `  - ${titles.get(i.id)} (simple:${i.id})\n    Upstream source: ${i.sourceUrl}\n    ${status}`;
};
const upstreamNotices = [
  ...new Map(apache.map((i) => [verified.get(i.id).checked, verified.get(i.id)])).values(),
]
  .filter((v) => v.notice)
  .map((v) => `--- ${v.checked} :: ${v.notice.name} ---\n${v.notice.text.trim()}`)
  .join("\n\n");
const notice = `Simple Icons: notices for Apache-2.0 licensed icons (pack id "simple")

Only icons that Simple Icons' data marks CC0-1.0 or Apache-2.0 are bundled; MIT-licensed icons are
not, because MIT requires the copyright notice to travel and the data names no holder. Icons
licensed CC0-1.0 need no notice. Each Apache-2.0 icon below was checked at development time:
the root of its upstream repository at the pinned commit in its source URL was listed for a
NOTICE file. Icons whose upstream could not be verified this way were left out. Each icon is
copyright its original authors and is redistributed unmodified under Apache-2.0.

Brand names, logos and marks remain trademarks of their owners; marks of CNCF or Linux Foundation
hosted projects (for example Rook) are also subject to the Linux Foundation trademark usage
guidelines (https://www.linuxfoundation.org/legal/trademark-usage).

Apache-2.0 icons:
${apache.map(entry).join("\n")}
${upstreamNotices ? `\nUpstream NOTICE files (verbatim):\n\n${upstreamNotices}\n` : ""}
================================================================================
Apache License, Version 2.0
================================================================================

${APACHE_TEXT}
`;
writeFileSync(`${out}/NOTICE-SIMPLE-ICONS.txt`, notice);
writeFileSync(new URL("../../../LICENSES/NOTICE-SIMPLE-ICONS.txt", import.meta.url), notice);
console.log(
  `${icons.length} icons (${apache.length} Apache-2.0); skipped over budget: ${skipped.join(" ") || "none"}; dropped as unverifiable: ${noNotice.join(" ") || "none"}`,
);
