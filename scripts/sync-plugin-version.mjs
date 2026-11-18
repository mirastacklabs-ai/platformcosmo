// Sync the version in plugin.json and marketplace.json from packages/cli/package.json.
// Usage: node scripts/sync-plugin-version.mjs [--check] [--root <dir>]
// Edits the files textually so existing Prettier formatting is preserved.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";

const usage = "Usage: sync-plugin-version.mjs [--check] [--root <dir>]";
const args = process.argv.slice(2);
let check = false;
let root = fileURLToPath(new URL("..", import.meta.url));
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--check") check = true;
  else if (args[i] === "--root") {
    const v = args[++i];
    if (v === undefined || v.startsWith("--")) {
      console.error(`--root requires a directory\n${usage}`);
      process.exit(2);
    }
    root = v;
  } else {
    console.error(`unknown argument: ${args[i]}\n${usage}`);
    process.exit(2);
  }
}

const version = JSON.parse(readFileSync(join(root, "packages/cli/package.json"), "utf8")).version;
const pluginPath = join(root, "plugin/.claude-plugin/plugin.json");
const marketPath = join(root, ".claude-plugin/marketplace.json");

// Index of the closing quote of the string literal starting at `i`.
function strEnd(text, i) {
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === "\\") j++;
    else if (text[j] === '"') return j;
  }
  throw new Error("unterminated string");
}

// Direct children of the object/array starting at `start`:
// objects give {key, keyStart, valStart}; arrays give {valStart} for each object element.
function children(text, start) {
  const isObj = text[start] === "{";
  const out = [];
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const j = strEnd(text, i);
      if (isObj && depth === 1) {
        let k = j + 1;
        while (/\s/.test(text[k] ?? "")) k++;
        if (text[k] === ":") {
          k++;
          while (/\s/.test(text[k] ?? "")) k++;
          out.push({ key: JSON.parse(text.slice(i, j + 1)), keyStart: i, valStart: k });
        }
      }
      i = j;
    } else if (c === "{" || c === "[") {
      if (!isObj && depth === 1 && c === "{") out.push({ valStart: i });
      depth++;
    } else if ((c === "}" || c === "]") && --depth === 0) return out;
  }
  throw new Error("unbalanced JSON");
}

// Index of the "}" matching the "{" at `start`.
function matchEnd(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === '"') i = strEnd(text, i);
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  throw new Error("unbalanced JSON object");
}

// Set the top-level "version" of the object starting at `start`.
function setVersion(text, start) {
  const kids = children(text, start);
  const ver = kids.find((x) => x.key === "version");
  const lit = JSON.stringify(version);
  if (ver) {
    if (text[ver.valStart] !== '"') throw new Error('"version" is not a string');
    return text.slice(0, ver.valStart) + lit + text.slice(strEnd(text, ver.valStart) + 1);
  }
  const name = kids.find((x) => x.key === "name");
  if (!name) throw new Error('object has no top-level "name"');
  const lineStart = text.lastIndexOf("\n", name.keyStart - 1) + 1;
  const lead = text.slice(lineStart, name.keyStart);
  return lead.trim() === ""
    ? text.slice(0, lineStart) + `${lead}"version": ${lit},\n` + text.slice(lineStart)
    : text.slice(0, name.keyStart) + `"version": ${lit}, ` + text.slice(name.keyStart);
}

function updatePlugin(text) {
  return setVersion(text, text.indexOf("{"));
}

function updateMarketplace(text) {
  const plugins = children(text, text.indexOf("{")).find((x) => x.key === "plugins");
  if (!plugins || text[plugins.valStart] !== "[") {
    throw new Error("marketplace.json: no plugins[] array");
  }
  for (const el of children(text, plugins.valStart)) {
    const obj = JSON.parse(text.slice(el.valStart, matchEnd(text, el.valStart) + 1));
    if (obj.name === "platformcosmo") return setVersion(text, el.valStart);
  }
  throw new Error("marketplace.json: no plugins[] entry named platformcosmo");
}

const targets = [
  { path: pluginPath, update: updatePlugin, read: (t) => JSON.parse(t).version },
  {
    path: marketPath,
    update: updateMarketplace,
    read: (t) => JSON.parse(t).plugins?.find((x) => x.name === "platformcosmo")?.version,
  },
];

if (check) {
  let bad = 0;
  for (const t of targets) {
    const cur = t.read(readFileSync(t.path, "utf8"));
    if (cur !== version) {
      console.error(
        `${t.path}: version is ${cur ?? "missing"}, expected ${version} (packages/cli). Run: pnpm run sync:versions`,
      );
      bad++;
    }
  }
  process.exit(bad ? 1 : 0);
}

// Compute and verify every new content before writing any file.
const planned = targets.map((t) => {
  const before = readFileSync(t.path, "utf8");
  const after = t.update(before);
  if (t.read(after) !== version) throw new Error(`${t.path}: update failed`);
  return { path: t.path, before, after };
});
for (const p of planned) if (p.after !== p.before) writeFileSync(p.path, p.after);
