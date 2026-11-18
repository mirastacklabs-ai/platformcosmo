// Sync the version in plugin.json and marketplace.json from packages/cli/package.json.
// Usage: node scripts/sync-plugin-version.mjs [--check] [--root <dir>]
// Edits the files textually so existing Prettier formatting is preserved.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const check = args.includes("--check");
const ri = args.indexOf("--root");
const root = ri >= 0 ? args[ri + 1] : ".";

const version = JSON.parse(readFileSync(join(root, "packages/cli/package.json"), "utf8")).version;
const pluginPath = join(root, "plugin/.claude-plugin/plugin.json");
const marketPath = join(root, ".claude-plugin/marketplace.json");

// Index of the "}" matching the "{" at `start` (skips string contents).
function matchEnd(text, start) {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  throw new Error("unbalanced JSON object");
}

// Set "version" in the object starting at `start`, keyed at the indent of its "name" line.
function setVersion(text, start) {
  const end = matchEnd(text, start);
  const body = text.slice(start, end + 1);
  const m = /\n([ \t]+)"name":[^\n]*\n/.exec(body);
  if (!m) throw new Error("object has no name line");
  const indent = m[1];
  const verRe = new RegExp(`(\\n${indent}"version":\\s*)"[^"]*"`);
  const next = verRe.test(body)
    ? body.replace(verRe, `$1${JSON.stringify(version)}`)
    : body.slice(0, m.index + m[0].length) +
      `${indent}"version": ${JSON.stringify(version)},\n` +
      body.slice(m.index + m[0].length);
  return text.slice(0, start) + next + text.slice(end + 1);
}

function updatePlugin(text) {
  return setVersion(text, text.indexOf("{"));
}

function updateMarketplace(text) {
  const p = text.indexOf('"plugins"');
  const nameIdx = text.indexOf('"name": "platformcosmo"', p);
  if (p < 0 || nameIdx < 0) {
    throw new Error("marketplace.json: no plugins[] entry named platformcosmo");
  }
  return setVersion(text, text.lastIndexOf("{", nameIdx));
}

const targets = [
  { path: pluginPath, update: updatePlugin, read: (t) => JSON.parse(t).version },
  {
    path: marketPath,
    update: updateMarketplace,
    read: (t) => JSON.parse(t).plugins?.find((x) => x.name === "platformcosmo")?.version,
  },
];

let bad = 0;
for (const t of targets) {
  const before = readFileSync(t.path, "utf8");
  if (check) {
    const cur = t.read(before);
    if (cur !== version) {
      console.error(
        `${t.path}: version is ${cur ?? "missing"}, expected ${version} (packages/cli). Run: pnpm run sync:versions`,
      );
      bad++;
    }
    continue;
  }
  const after = t.update(before);
  if (t.read(after) !== version) throw new Error(`${t.path}: update failed`);
  if (after !== before) writeFileSync(t.path, after);
}
process.exit(bad ? 1 : 0);
