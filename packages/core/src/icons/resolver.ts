/** Icon resolver: aliases, precedence, lazy deterministic sanitizing and fuzzy search. */
import type {
  CreateIconResolverFn,
  IconEntry,
  IconMatch,
  IconResolver,
  LoadedIconPack,
  ResolvedIcon,
} from "../contracts/index.js";
import type { SpecNodeType } from "../schema/types.gen.js";

interface PackIndex {
  readonly pack: LoadedIconPack;
  readonly byId: Map<string, IconEntry>;
  readonly byAlias: Map<string, IconEntry>;
}

const norm = (s: string): string =>
  s
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, "-");

/** Levenshtein similarity in 0..1. */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0] as number;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j] as number;
      prev[j] = Math.min(
        (prev[j] as number) + 1,
        (prev[j - 1] as number) + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diag = tmp;
    }
  }
  return 1 - (prev[b.length] as number) / Math.max(a.length, b.length);
}

function scoreTerm(q: string, term: string): number {
  if (term === q) return 1;
  if (term.startsWith(q)) return 0.9 - Math.min(0.1, (term.length - q.length) * 0.005);
  if (term.includes(q)) return 0.75 - Math.min(0.1, (term.length - q.length) * 0.005);
  // Token-level match ("load balancer" vs "load-balancer-icon").
  const qt = q.split("-");
  const tt = term.split("-");
  if (qt.length > 1 && qt.every((t) => tt.includes(t))) return 0.7;
  const sim = similarity(q, term);
  return sim >= 0.6 ? sim * 0.6 : 0;
}

const round4 = (n: number): number => Math.round(n * 10000) / 10000;

export const createIconResolver: CreateIconResolverFn = (packs, sanitize) => {
  const indexes: PackIndex[] = [];
  const seen = new Set<string>();
  for (const pack of packs) {
    const id = pack.manifest.pack.id;
    if (seen.has(id)) continue; // earlier packs win on duplicate pack ids
    seen.add(id);
    const byId = new Map<string, IconEntry>();
    const byAlias = new Map<string, IconEntry>();
    for (const e of pack.manifest.icons) {
      if (!byId.has(norm(e.id))) byId.set(norm(e.id), e);
    }
    for (const e of [...pack.manifest.icons].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    )) {
      for (const a of e.aliases) {
        const k = norm(a);
        if (!byId.has(k) && !byAlias.has(k)) byAlias.set(k, e);
      }
    }
    indexes.push({ pack, byId, byAlias });
  }

  const cache = new Map<string, ResolvedIcon | undefined>();

  const lookup = (idx: PackIndex, name: string): IconEntry | undefined => {
    const k = norm(name);
    return idx.byId.get(k) ?? idx.byAlias.get(k);
  };

  const build = (idx: PackIndex, entry: IconEntry): ResolvedIcon | undefined => {
    const ref = `${idx.pack.manifest.pack.id}:${entry.id}`;
    if (cache.has(ref)) return cache.get(ref);
    let out: ResolvedIcon | undefined;
    const raw = idx.pack.files[entry.file];
    if (raw !== undefined) {
      const r = sanitize(raw, { monochrome: entry.monochrome });
      if (r.ok) {
        const attribution = idx.pack.manifest.pack.attribution;
        out = {
          ref,
          svg: r.svg,
          license: entry.license ?? idx.pack.manifest.pack.license,
          ...(attribution !== undefined ? { attribution } : {}),
        };
      }
    }
    cache.set(ref, out);
    return out;
  };

  const resolver: IconResolver = {
    resolve(ref) {
      const c = ref.indexOf(":");
      if (c === -1) {
        for (const idx of indexes) {
          const e = lookup(idx, ref);
          if (e) return build(idx, e);
        }
        return undefined;
      }
      const packId = norm(ref.slice(0, c));
      const idx = indexes.find((p) => p.pack.manifest.pack.id === packId);
      if (!idx) return undefined;
      const e = lookup(idx, ref.slice(c + 1));
      return e ? build(idx, e) : undefined;
    },
    defaultFor(type: SpecNodeType) {
      for (const idx of indexes) {
        const d = idx.pack.manifest.defaults?.[type];
        if (d === undefined) continue;
        const c = d.indexOf(":");
        const e = lookup(idx, c === -1 ? d : d.slice(c + 1));
        if (e) return `${idx.pack.manifest.pack.id}:${e.id}`;
      }
      return undefined;
    },
    search(query, limit = 10) {
      let q = norm(query);
      let only: string | undefined;
      const c = q.indexOf(":");
      if (c !== -1) {
        only = q.slice(0, c);
        q = q.slice(c + 1);
      }
      if (!q) return [];
      const matches: IconMatch[] = [];
      for (const idx of indexes) {
        if (only !== undefined && idx.pack.manifest.pack.id !== only) continue;
        for (const e of idx.pack.manifest.icons) {
          let best = scoreTerm(q, norm(e.id));
          for (const a of e.aliases) best = Math.max(best, scoreTerm(q, norm(a)) * 0.97);
          for (const t of e.tags ?? []) best = Math.max(best, scoreTerm(q, norm(t)) * 0.8);
          if (e.provider) best = Math.max(best, scoreTerm(q, norm(e.provider)) * 0.6);
          if (best > 0)
            matches.push({ ref: `${idx.pack.manifest.pack.id}:${e.id}`, score: round4(best) });
        }
      }
      matches.sort((a, b) => b.score - a.score || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
      return matches.slice(0, Math.max(0, limit));
    },
    packs() {
      return indexes.map((i) => i.pack.manifest.pack.id);
    },
  };
  return resolver;
};
