import { relative, resolve } from "node:path";
import type { LoadedIconPack } from "@platformcosmo/core";
import { flag, num, parse, str } from "../args.js";
import { makeResolver } from "../common.js";
import { type Ctx, EXIT, Failure, UsageError } from "../deps.js";
import { formatDiagnostics, hasErrors, plural } from "../format.js";
import {
  PACK_ID_RE,
  loadUserPacks,
  packsDirFor,
  readLocalPack,
  removePack,
  savePack,
} from "../packs.js";

export const HELP = `Usage: pcosmo icons <add|list|search|remove> ...

  add <source>        Install a pack: a folder with icons.json, an https URL (single SVG,
                      zip or listing), or a provider id (aws, azure, gcp, cncf). Provider
                      packs download from the official source to this machine and are never
                      redistributed; their terms are shown and Azure needs --accept-terms.
  list                List installed packs (bundled and user)
  search <query>      Fuzzy search icon ids, aliases and tags
  remove <pack-id>    Remove a user pack

Options:
  --id <pack-id>      Pack id to assign on add
  --accept-terms      Accept the provider's terms (add)
  --force             Replace an already installed pack with the same id (add)
  --limit <n>         Max search results (default 20)
  --packs-dir <dir>   Pack directory (default: $CLAUDE_PLUGIN_DATA/icons or ~/.platformcosmo/icons)
  -h, --help          Show this help

The only network access in pcosmo is \`icons add\` with a URL or provider id (https, public
addresses only, size and time limited).
`;

const PROVIDERS = new Set(["aws", "azure", "gcp", "cncf"]);

export async function iconsCommand(ctx: Ctx, args: string[]): Promise<number> {
  const p = parse(args, {
    id: { type: "string" },
    "accept-terms": { type: "boolean" },
    force: { type: "boolean" },
    limit: { type: "string" },
  });
  const [sub, ...rest] = p.positionals;
  const dir = packsDirFor(ctx.deps, str(p, "packs-dir") ?? ctx.packsDir);
  switch (sub) {
    case "list":
      return list(ctx, dir);
    case "search": {
      if (rest.length === 0) throw new UsageError("search needs a query");
      const limit = num(p, "limit") ?? 20;
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        throw new UsageError("--limit must be an integer from 1 to 500");
      }
      const { resolver } = await makeResolver(ctx);
      const hits = resolver.search(rest.join(" "), limit);
      if (hits.length === 0) ctx.out("no matches\n");
      for (const h of hits) ctx.out(`${h.ref.padEnd(40)} ${h.score.toFixed(2)}\n`);
      return EXIT.ok;
    }
    case "remove": {
      const id = rest[0];
      if (!id || rest.length !== 1) throw new UsageError("remove needs exactly one pack id");
      if (ctx.deps.bundledPacks.some((b) => b.manifest.pack.id === id)) {
        throw new Failure(`"${id}" is a bundled pack and cannot be removed`);
      }
      if (!PACK_ID_RE.test(id)) throw new UsageError(`invalid pack id "${id}"`);
      const had = await userError(() => removePack(dir, id));
      ctx.out(had ? `removed ${id}\n` : `${id} is not installed\n`);
      return had ? EXIT.ok : EXIT.failed;
    }
    case "add": {
      if (rest.length !== 1) throw new UsageError("add needs exactly one source");
      return userError(() =>
        add(ctx, dir, rest[0]!, str(p, "id"), flag(p, "accept-terms"), flag(p, "force")),
      );
    }
    default:
      throw new UsageError(sub ? `unknown icons subcommand "${sub}"` : "icons needs a subcommand");
  }
}

async function list(ctx: Ctx, dir: string): Promise<number> {
  const user = await loadUserPacks(dir);
  const row = (kind: string, pk: LoadedIconPack) => {
    const i = pk.manifest.pack;
    ctx.out(
      `${i.id.padEnd(14)} ${kind.padEnd(8)} ${i.version.padEnd(10)} ${i.license.padEnd(20)} ${plural(pk.manifest.icons.length, "icon")}  ${i.name}\n`,
    );
  };
  for (const b of ctx.deps.bundledPacks) row("bundled", b);
  for (const u of user.packs) row("user", u);
  if (user.diagnostics.length > 0) ctx.err(formatDiagnostics(user.diagnostics));
  return hasErrors(user.diagnostics) ? EXIT.failed : EXIT.ok;
}

async function add(
  ctx: Ctx,
  dir: string,
  source: string,
  packId: string | undefined,
  acceptTerms: boolean,
  force: boolean,
): Promise<number> {
  if (packId !== undefined && !PACK_ID_RE.test(packId)) {
    throw new UsageError("--id must match ^[a-z][a-z0-9-]{0,31}$");
  }
  const remote = PROVIDERS.has(source) || source.includes("://");
  let pack: LoadedIconPack | undefined;
  let resolved: string;
  let license: string | undefined;
  let redistributable: boolean | undefined;

  if (remote) {
    const r = await ctx.deps.core.fetchIconPack(source, {
      http: ctx.deps.http,
      ...(packId ? { packId } : {}),
      ...(acceptTerms ? { acceptTerms } : {}),
    });
    if (r.diagnostics.length > 0) ctx.err(formatDiagnostics(r.diagnostics));
    if (r.terms) ctx.out(`Terms for ${source}:\n${r.terms}\n`);
    if (!r.pack || !r.lock || hasErrors(r.diagnostics)) {
      if (r.terms && !acceptTerms)
        ctx.err("Re-run with --accept-terms to accept these terms and install.\n");
      return EXIT.failed;
    }
    pack = r.pack;
    resolved = r.lock.resolved;
    license = r.lock.license;
    redistributable = r.lock.redistributable;
  } else {
    const abs = resolve(ctx.deps.cwd, source);
    pack = await readLocalPack(abs);
    if (packId) {
      pack = {
        ...pack,
        manifest: { ...pack.manifest, pack: { ...pack.manifest.pack, id: packId } },
      };
    }
    resolved = relative(dir, abs).split("\\").join("/");
    license = pack.manifest.pack.license;
    redistributable = pack.manifest.pack.redistributable;
  }

  const id = pack.manifest.pack.id;
  if (ctx.deps.bundledPacks.some((b) => b.manifest.pack.id === id)) {
    throw new Failure(`"${id}" is a bundled pack id; choose another with --id`);
  }
  const entry = await savePack(
    dir,
    pack,
    {
      source,
      resolved,
      license: license ?? pack.manifest.pack.license,
      redistributable: redistributable ?? pack.manifest.pack.redistributable,
    },
    force,
  );
  ctx.out(`installed ${id} (${plural(entry.iconCount, "icon")}, ${entry.license}) in ${dir}\n`);
  if (!entry.redistributable) {
    ctx.out(
      "This pack is for your own diagrams on this machine; do not commit or redistribute it.\n",
    );
  }
  return EXIT.ok;
}

/** Expected failures (bad folder, existing pack, invalid manifest) are exit 1 messages, not internal errors. */
async function userError<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof Failure || e instanceof UsageError) throw e;
    throw new Failure((e as Error).message, { cause: e });
  }
}
