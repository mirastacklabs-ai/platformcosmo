/**
 * `pcosmo icons add`: fetch an icon source through the injected `IconHttpClient`, build a pack,
 * sanitize every SVG. Security-sensitive. The client owns SSRF defense at connect time; this
 * module validates URL syntax and the final URL, enforces archive limits (entry count, declared
 * and actual inflated sizes, zip-slip names) and never trusts archive metadata.
 */
import { Inflate } from "fflate";
import type {
  Diagnostic,
  FetchIconPackFn,
  IconCategory,
  IconEntry,
  IconHttpClient,
  IconManifest,
  IconPackInfo,
  LoadedIconPack,
} from "../contracts/index.js";
import { computeIconIntegrity } from "./integrity.js";
import { sanitizeSvg } from "./sanitize.js";

// --- limits ---------------------------------------------------------------------

export const FETCH_LIMITS = {
  /** Largest single SVG accepted (raw input). */
  svgBytes: 262_144,
  /** Largest sanitized body kept per icon. */
  sanitizedBytes: 65_536,
  /** Largest archive download. */
  archiveBytes: 67_108_864,
  /** Largest HTML/JSON helper document (landing pages, listings). */
  documentBytes: 8_388_608,
  /** Maximum central-directory entries. */
  zipEntries: 20_000,
  /** Maximum SVG files extracted from an archive or listing. */
  svgFiles: 4_000,
  /** Maximum inflated bytes across all extracted entries. */
  inflatedTotal: 50_331_648,
  timeoutMs: 60_000,
} as const;

const RESERVED_PACK_IDS = new Set(["cosmo", "lucide", "k8s", "simple"]);
/** The one pack id rule (CLI and core): lowercase kebab-case, at most 32 characters. */
export const PACK_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

class ArchiveError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// --- URL checks -------------------------------------------------------------------

/** Syntax-level checks only; DNS/IP policy is enforced by the injected client. */
export function checkHttpsUrl(
  raw: string,
  allowedHostSuffixes?: readonly string[],
): { ok: true; url: URL } | { ok: false; reason: string } {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) {
    return { ok: false, reason: "URL is empty or too long" };
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f\\]/.test(raw))
    return { ok: false, reason: "URL contains forbidden characters" };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  if (u.protocol !== "https:") return { ok: false, reason: "only https URLs are allowed" };
  if (u.username || u.password)
    return { ok: false, reason: "URLs with credentials are not allowed" };
  if (u.port && u.port !== "443")
    return { ok: false, reason: "non-standard ports are not allowed" };
  // `localhost.` and `127.0.0.1.` name the same hosts: strip one trailing dot before checking.
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (
    !host ||
    host.startsWith("[") ||
    host.includes(":") ||
    /^[\d.]+$/.test(host) ||
    /^0x/i.test(host)
  ) {
    return { ok: false, reason: "IP-address hosts are not allowed" };
  }
  if (
    !host.includes(".") ||
    host === "localhost" ||
    /\.(localhost|local|internal|lan|home|corp)\.?$/.test(host)
  ) {
    return { ok: false, reason: "host is not a public DNS name" };
  }
  if (
    allowedHostSuffixes &&
    !allowedHostSuffixes.some((s) => host === s || host.endsWith(`.${s}`))
  ) {
    return { ok: false, reason: `host ${host} is not allowed for this source` };
  }
  return { ok: true, url: u };
}

// --- helpers ----------------------------------------------------------------------

const kebab = (s: string): string =>
  s
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const diag = (
  severity: Diagnostic["severity"],
  code: string,
  message: string,
  extra: Partial<Diagnostic> = {},
): Diagnostic => ({ severity, code: `icons/${code}`, path: "", message, ...extra });

const short = (e: unknown): string => String(e instanceof Error ? e.message : e).slice(0, 200);

const utf8 = new TextDecoder("utf-8");

// --- zip reading --------------------------------------------------------------------

interface ZipEntry {
  readonly name: string;
  readonly method: number;
  readonly flags: number;
  readonly csize: number;
  readonly usize: number;
  readonly offset: number;
}

const u16 = (b: Uint8Array, o: number): number => (b[o] as number) | ((b[o + 1] as number) << 8);
const u32 = (b: Uint8Array, o: number): number => (u16(b, o) | (u16(b, o + 2) << 16)) >>> 0;

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return true;
  }
  return false;
}

/** Why an archive or listing path must be refused, or `undefined` when it is acceptable. */
function nameProblem(name: string): "zip-slip" | "unsafe-entry-name" | undefined {
  if (name.length === 0 || name.length > 512) return "unsafe-entry-name";
  if (hasControlChars(name)) return "unsafe-entry-name";
  if (name.includes("\\") || name.startsWith("/") || /^[A-Za-z]:/.test(name)) return "zip-slip";
  return name.split("/").some((seg) => seg === "..") ? "zip-slip" : undefined;
}

const unsafeName = (name: string): boolean => nameProblem(name) !== undefined;

/** Reads the central directory without inflating anything. */
export function readZipDirectory(buf: Uint8Array, duplicates?: string[]): ZipEntry[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (u32(buf, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0)
    throw new ArchiveError(
      "archive-invalid",
      "not a zip archive (no end-of-central-directory record)",
    );
  const total = u16(buf, eocd + 10);
  const cdSize = u32(buf, eocd + 12);
  const cdOffset = u32(buf, eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ArchiveError("archive-invalid", "zip64 archives are not supported");
  }
  if (total > FETCH_LIMITS.zipEntries) {
    throw new ArchiveError(
      "archive-too-many-files",
      `archive has more than ${FETCH_LIMITS.zipEntries} entries`,
    );
  }
  if (cdOffset + cdSize > eocd)
    throw new ArchiveError("archive-invalid", "central directory out of bounds");
  const entries: ZipEntry[] = [];
  const seenNames = new Set<string>();
  let p = cdOffset;
  for (let n = 0; n < total; n++) {
    if (p + 46 > buf.length || u32(buf, p) !== 0x02014b50) {
      throw new ArchiveError("archive-invalid", "corrupt central directory");
    }
    const nameLen = u16(buf, p + 28);
    const extraLen = u16(buf, p + 30);
    const commentLen = u16(buf, p + 32);
    if (p + 46 + nameLen + extraLen + commentLen > buf.length) {
      throw new ArchiveError("archive-invalid", "central directory entry out of bounds");
    }
    const name = utf8.decode(buf.subarray(p + 46, p + 46 + nameLen));
    const problem = nameProblem(name);
    if (problem) {
      throw new ArchiveError(
        problem,
        `unsafe entry name in archive: ${JSON.stringify(name.slice(0, 80))}`,
      );
    }
    // Unix mode in the high 16 bits of the external attributes: refuse symbolic links.
    if (((u32(buf, p + 38) >>> 16) & 0o170000) === 0o120000) {
      throw new ArchiveError(
        "zip-symlink",
        `archive contains a symbolic link: ${name.slice(0, 80)}`,
      );
    }
    if (seenNames.has(name)) duplicates?.push(name);
    seenNames.add(name);
    entries.push({
      name,
      flags: u16(buf, p + 8),
      method: u16(buf, p + 10),
      csize: u32(buf, p + 20),
      usize: u32(buf, p + 24),
      offset: u32(buf, p + 42),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Extracts one entry. Memory is bounded by `cap` regardless of what the archive claims. */
export function readZipEntry(buf: Uint8Array, e: ZipEntry, cap: number): Uint8Array {
  if (e.usize > cap)
    throw new ArchiveError("archive-too-large", `entry ${e.name} exceeds ${cap} bytes`);
  if (e.offset + 30 > buf.length || u32(buf, e.offset) !== 0x04034b50) {
    throw new ArchiveError("archive-invalid", `bad local header for ${e.name}`);
  }
  const start = e.offset + 30 + u16(buf, e.offset + 26) + u16(buf, e.offset + 28);
  if (start + e.csize > buf.length)
    throw new ArchiveError("archive-invalid", `entry ${e.name} out of bounds`);
  const data = buf.subarray(start, start + e.csize);
  if (e.method === 0) {
    if (e.csize !== e.usize)
      throw new ArchiveError("archive-invalid", `size mismatch for ${e.name}`);
    return data;
  }
  if (e.method !== 8)
    throw new ArchiveError("archive-invalid", `unsupported compression in ${e.name}`);
  const chunks: Uint8Array[] = [];
  let produced = 0;
  let over = false;
  const inf = new Inflate((chunk) => {
    produced += chunk.length;
    if (produced > e.usize) over = true;
    else chunks.push(chunk);
  });
  try {
    // Small input slices bound the output per push (deflate expands at most ~1032x).
    for (let o = 0; o < data.length || o === 0; o += 512) {
      const last = o + 512 >= data.length;
      inf.push(data.subarray(o, o + 512), last);
      if (over) {
        break;
      }
      if (last) break;
    }
  } catch (err) {
    throw new ArchiveError(
      "archive-invalid",
      `corrupt compressed data in ${e.name}: ${short(err)}`,
    );
  }
  if (over) throw new ArchiveError("zip-bomb", `entry ${e.name} inflates beyond its declared size`);
  if (produced !== e.usize)
    throw new ArchiveError("archive-invalid", `size mismatch for ${e.name}`);
  const out = new Uint8Array(produced);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

// --- pack building -------------------------------------------------------------------

interface RawIcon {
  /** Desired id (kebab-case, deduplicated later). */
  readonly id: string;
  readonly category: IconCategory;
  readonly sourcePath: string;
  readonly svg: string;
}

interface BuiltPack {
  readonly pack: LoadedIconPack;
  readonly diagnostics: Diagnostic[];
}

const MAX_REPORTED = 10;

function buildPack(
  info: IconPackInfo,
  provider: string | undefined,
  raws: readonly RawIcon[],
): BuiltPack {
  const diagnostics: Diagnostic[] = [];
  const files: Record<string, string> = {};
  const icons: IconEntry[] = [];
  const used = new Set<string>();
  let rejected = 0;
  for (const r of [...raws].sort((a, b) => cmp(a.sourcePath, b.sourcePath))) {
    const res = sanitizeSvg(r.svg, { maxBytes: FETCH_LIMITS.svgBytes });
    // The stored file (with its <svg> wrapper) is what is bounded, not just the body.
    const stored = res.ok
      ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${res.svg.viewBox}">${res.svg.body.replaceAll("__PCID__-", "i")}</svg>`
      : "";
    if (!res.ok || stored.length > FETCH_LIMITS.sanitizedBytes) {
      rejected++;
      if (rejected <= MAX_REPORTED) {
        diagnostics.push(
          diag(
            "warning",
            "svg-rejected",
            `skipped ${r.sourcePath.slice(0, 120)}: ${res.ok ? "sanitized icon too large" : res.reason}`,
          ),
        );
      }
      continue;
    }
    let id = r.id || "icon";
    for (let n = 2; used.has(id); n++) id = `${r.id}-${n}`;
    used.add(id);
    const file = `svg/${id}.svg`;
    // Store the sanitized form so persisted packs never contain unsanitized markup.
    files[file] = stored;
    icons.push({
      id,
      aliases: [],
      category: r.category,
      ...(provider ? { provider } : {}),
      file,
      monochrome: false,
    });
  }
  if (rejected > MAX_REPORTED) {
    diagnostics.push(
      diag("warning", "svg-rejected", `${rejected - MAX_REPORTED} more SVG files were skipped`),
    );
  }
  icons.sort((a, b) => cmp(a.id, b.id));
  const manifest: IconManifest = { manifestVersion: 1, pack: info, icons };
  return { pack: { manifest, files }, diagnostics };
}

// --- zip -> icons --------------------------------------------------------------------

type Selector = (path: string) => { id: string; category: IconCategory } | undefined;

function extractSvgs(buf: Uint8Array, select: Selector, diagnostics: Diagnostic[]): RawIcon[] {
  const duplicates: string[] = [];
  const entries = readZipDirectory(buf, duplicates);
  if (duplicates.length) {
    diagnostics.push(
      diag(
        "warning",
        "duplicate-entry",
        `archive lists ${duplicates.length} entry name(s) more than once (first occurrence kept): ${duplicates
          .slice(0, 3)
          .map((n) => n.slice(0, 60))
          .join(", ")}`,
      ),
    );
  }
  const selected: { e: ZipEntry; id: string; category: IconCategory }[] = [];
  const takenNames = new Set<string>();
  for (const e of entries) {
    if (takenNames.has(e.name)) continue;
    takenNames.add(e.name);
    if (e.name.endsWith("/") || e.name.startsWith("__MACOSX/") || !/\.svg$/i.test(e.name)) continue;
    const base = e.name.slice(e.name.lastIndexOf("/") + 1);
    if (base.startsWith("._")) continue;
    const s = select(e.name);
    if (s) selected.push({ e, ...s });
  }
  if (selected.length > FETCH_LIMITS.svgFiles) {
    throw new ArchiveError(
      "archive-too-many-files",
      `archive has more than ${FETCH_LIMITS.svgFiles} SVG files`,
    );
  }
  const out: RawIcon[] = [];
  let total = 0;
  for (const s of selected) {
    if (s.e.flags & 1) {
      diagnostics.push(
        diag("warning", "svg-rejected", `skipped encrypted entry ${s.e.name.slice(0, 120)}`),
      );
      continue;
    }
    if (s.e.usize > FETCH_LIMITS.svgBytes) {
      diagnostics.push(
        diag(
          "warning",
          "svg-rejected",
          `skipped ${s.e.name.slice(0, 120)}: larger than ${FETCH_LIMITS.svgBytes} bytes`,
        ),
      );
      continue;
    }
    total += s.e.usize;
    if (total > FETCH_LIMITS.inflatedTotal) {
      throw new ArchiveError("archive-too-large", "archive expands beyond the allowed total size");
    }
    const bytes = readZipEntry(buf, s.e, FETCH_LIMITS.svgBytes);
    out.push({ id: s.id, category: s.category, sourcePath: s.e.name, svg: utf8.decode(bytes) });
  }
  return out;
}

const isZip = (b: Uint8Array): boolean =>
  b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 3 && b[3] === 4;

// --- providers ---------------------------------------------------------------------

interface HttpCtx {
  readonly http: IconHttpClient;
}

type Get = Awaited<ReturnType<IconHttpClient["get"]>>;

class FetchError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function guardedGet(
  ctx: HttpCtx,
  url: string,
  maxBytes: number,
  hosts?: readonly string[],
): Promise<Get> {
  const c = checkHttpsUrl(url, hosts);
  if (!c.ok) throw new FetchError("invalid-url", `${c.reason}: ${url.slice(0, 120)}`);
  let res: Get;
  try {
    res = await ctx.http.get(url, { maxBytes, timeoutMs: FETCH_LIMITS.timeoutMs });
  } catch (e) {
    throw new FetchError("fetch-failed", `could not fetch ${url.slice(0, 120)}: ${short(e)}`);
  }
  const f = checkHttpsUrl(res.url, hosts);
  if (!f.ok)
    throw new FetchError(
      "unsafe-redirect",
      `final URL rejected (${f.reason}): ${String(res.url).slice(0, 120)}`,
    );
  if (!(res.body instanceof Uint8Array) || res.body.length > maxBytes) {
    throw new FetchError(
      "archive-too-large",
      `response from ${url.slice(0, 120)} exceeds ${maxBytes} bytes`,
    );
  }
  return res;
}

interface ProviderResult {
  readonly raws: RawIcon[];
  readonly resolved: string;
  readonly version: string;
}

interface Provider {
  readonly id: string;
  readonly info: Omit<IconPackInfo, "id" | "version">;
  readonly terms: string;
  readonly requiresAcceptance: boolean;
  fetch(ctx: HttpCtx, diagnostics: Diagnostic[]): Promise<ProviderResult>;
}

const AWS_LANDING = "https://aws.amazon.com/architecture/icons/";

function awsSelect(path: string): { id: string; category: IconCategory } | undefined {
  let m = /^Architecture-Service-Icons_[^/]*\/Arch_[^/]*\/64\/Arch_(.+)_64\.svg$/.exec(path);
  if (m?.[1]) return { id: kebab(m[1]), category: "general" };
  m = /^Category-Icons_[^/]*\/Arch-Category_64\/Arch-Category_(.+)_64\.svg$/.exec(path);
  if (m?.[1]) return { id: `category-${kebab(m[1])}`, category: "general" };
  m = /^Resource-Icons_[^/]*\/Res_[^/]*\/(?:Res_48_Light\/)?Res_(.+)_48(?:_Light)?\.svg$/.exec(
    path,
  );
  if (m?.[1]) return { id: `res-${kebab(m[1])}`, category: "general" };
  return undefined;
}

const AZURE_URL = "https://arch-center.azureedge.net/icons/Azure_Public_Service_Icons_V25.zip";
const AZURE_CATEGORY: Record<string, IconCategory> = {
  compute: "compute",
  containers: "compute",
  networking: "network",
  databases: "data",
  storage: "data",
  analytics: "data",
  identity: "security",
  security: "security",
  ai: "ai",
  "ai + machine learning": "ai",
  devops: "cicd",
  monitor: "observability",
  management: "general",
};

function azureSelect(path: string): { id: string; category: IconCategory } | undefined {
  const m = /^Azure_Public_Service_Icons\/Icons\/([^/]+)\/\d+-icon-service-(.+)\.svg$/.exec(path);
  if (!m?.[1] || !m[2]) return undefined;
  return { id: kebab(m[2]), category: AZURE_CATEGORY[m[1].toLowerCase()] ?? "general" };
}

const GCP_URLS = [
  "https://services.google.com/fh/files/misc/core-products-icons.zip",
  "https://services.google.com/fh/files/misc/category-icons.zip",
] as const;

function gcpSelect(path: string): { id: string; category: IconCategory } | undefined {
  let m = /^Unique Icons\/([^/]+)\/SVG\/[^/]+\.svg$/.exec(path);
  if (m?.[1]) return { id: kebab(m[1]), category: "general" };
  m = /^Category Icons\/([^/]+)\/SVG\/[^/]+\.svg$/.exec(path);
  if (m?.[1]) return { id: `category-${kebab(m[1])}`, category: "general" };
  return undefined;
}

/** Azure lists many icons under both a category folder and `other`/`new`; prefer the category. */
function azureOrder(path: string): string {
  return /\/Icons\/(other|new)\//.test(path) ? `~${path}` : path;
}

const CNCF_RE = /^projects\/([^/]+)\/icon\/color\/[^/]+-icon-color\.svg$/;
const GITHUB_HOSTS = ["api.github.com", "raw.githubusercontent.com"] as const;
const MAX_LISTED_FILES = 400;

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (t: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  let aborted = false; // after the first failure no further requests are started
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length && !aborted) {
        const i = next++;
        try {
          out[i] = await fn(items[i] as T);
        } catch (e) {
          aborted = true;
          throw e;
        }
      }
    }),
  );
  return out;
}

/** Lists a GitHub repository tree and fetches matching SVGs from raw.githubusercontent.com. */
async function fetchGithubSvgs(
  ctx: HttpCtx,
  owner: string,
  repo: string,
  ref: string,
  match: (path: string) => { id: string; category: IconCategory } | undefined,
  diagnostics: Diagnostic[],
): Promise<{ raws: RawIcon[]; resolved: string; version: string }> {
  if (
    !/^[\w.-]+$/.test(owner) ||
    !/^[\w.-]+$/.test(repo) ||
    !/^[\w./-]+$/.test(ref) ||
    ref.includes("..")
  ) {
    throw new FetchError("invalid-url", "unsupported GitHub owner, repository or ref");
  }
  // Pin everything to one commit: resolve a branch/tag to its sha so the listing and every file
  // come from the same snapshot and the lock entry is reproducible.
  let commit = ref;
  if (!/^[0-9a-f]{40}$/.test(ref)) {
    const c = await guardedGet(
      ctx,
      `https://api.github.com/repos/${owner}/${repo}/commits/${ref.split("/").map(encodeURIComponent).join("/")}`,
      FETCH_LIMITS.documentBytes,
      GITHUB_HOSTS,
    );
    let sha: unknown;
    try {
      sha = (JSON.parse(utf8.decode(c.body)) as { sha?: unknown }).sha;
    } catch {
      sha = undefined;
    }
    if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) {
      throw new FetchError("fetch-failed", "could not resolve the GitHub ref to a commit");
    }
    commit = sha;
  }
  const treeUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/${commit}?recursive=1`;
  const res = await guardedGet(ctx, treeUrl, FETCH_LIMITS.documentBytes, GITHUB_HOSTS);
  let tree: { sha?: unknown; truncated?: unknown; tree?: unknown };
  try {
    tree = JSON.parse(utf8.decode(res.body)) as typeof tree;
  } catch {
    throw new FetchError("fetch-failed", "GitHub tree listing is not valid JSON");
  }
  if (!Array.isArray(tree.tree))
    throw new FetchError("fetch-failed", "unexpected GitHub tree listing");
  if (tree.truncated === true)
    diagnostics.push(
      diag(
        "warning",
        "listing-truncated",
        "GitHub truncated the tree listing; the pack may be incomplete",
      ),
    );
  const paths: { path: string; id: string; category: IconCategory }[] = [];
  for (const n of tree.tree as { path?: unknown; type?: unknown }[]) {
    if (n.type !== "blob" || typeof n.path !== "string" || unsafeName(n.path)) continue;
    const m = match(n.path);
    if (m) paths.push({ path: n.path, ...m });
  }
  paths.sort((a, b) => cmp(a.path, b.path));
  if (paths.length > MAX_LISTED_FILES) {
    throw new ArchiveError(
      "archive-too-many-files",
      `listing has more than ${MAX_LISTED_FILES} matching files`,
    );
  }
  const base = `https://raw.githubusercontent.com/${owner}/${repo}/${commit}/`;
  const raws = await mapLimit(paths, 6, async (p) => {
    const r = await guardedGet(
      ctx,
      base + p.path.split("/").map(encodeURIComponent).join("/"),
      FETCH_LIMITS.svgBytes,
      GITHUB_HOSTS,
    );
    return {
      id: p.id,
      category: p.category,
      sourcePath: p.path,
      svg: utf8.decode(r.body),
    } satisfies RawIcon;
  });
  return { raws, resolved: res.url, version: `${repo}@${commit.slice(0, 12)}` };
}

const PROVIDERS: Record<string, Provider> = {
  aws: {
    id: "aws",
    info: {
      name: "AWS Architecture Icons",
      license: "LicenseRef-aws-architecture-icons",
      licenseUrl: AWS_LANDING,
      attribution: "AWS Architecture Icons, Amazon Web Services, Inc.",
      trademarkNotice: "AWS and the AWS logo are trademarks of Amazon.com, Inc. or its affiliates.",
      source: AWS_LANDING,
      redistributable: false,
    },
    terms:
      "AWS Architecture Icons: AWS allows customers and partners to use these toolkits and assets to create architecture diagrams. Review the current terms at https://aws.amazon.com/architecture/icons/. The icons are downloaded to your machine and are never redistributed by PlatformCosmo.",
    requiresAcceptance: false,
    async fetch(ctx, diagnostics) {
      const hosts = ["amazon.com", "awsstatic.com"];
      const page = await guardedGet(ctx, AWS_LANDING, FETCH_LIMITS.documentBytes, hosts);
      const html = utf8.decode(page.body);
      const m =
        /https:\/\/[a-z0-9.-]+\.awsstatic\.com\/[A-Za-z0-9./_-]*Icon-package[A-Za-z0-9._-]*\.zip/.exec(
          html,
        );
      if (!m)
        throw new FetchError(
          "fetch-failed",
          "could not find the icon package link on the AWS icons page",
        );
      const zip = await guardedGet(ctx, m[0], FETCH_LIMITS.archiveBytes, hosts);
      if (!isZip(zip.body))
        throw new FetchError("archive-invalid", "AWS download is not a zip archive");
      const raws = extractSvgs(zip.body, awsSelect, diagnostics);
      return { raws, resolved: zip.url, version: /_(\d{8})\./.exec(zip.url)?.[1] ?? "current" };
    },
  },
  azure: {
    id: "azure",
    info: {
      name: "Azure Architecture Icons",
      license: "LicenseRef-azure-architecture-icons",
      licenseUrl: "https://learn.microsoft.com/azure/architecture/icons/",
      attribution: "Azure Architecture Icons, Microsoft Corporation.",
      trademarkNotice: "Microsoft and Azure are trademarks of the Microsoft group of companies.",
      source: "https://learn.microsoft.com/azure/architecture/icons/",
      redistributable: false,
    },
    terms:
      "Azure Architecture Icons are provided by Microsoft. Per Microsoft's terms of use you may use the icons in architectural diagrams, training materials, or documentation, and may copy, distribute, and display them only for that permitted use. Read the full terms at https://learn.microsoft.com/azure/architecture/icons/ (Microsoft_Terms_of_Use.pdf in the download). Continuing means you have read and accept them.",
    requiresAcceptance: true,
    async fetch(ctx, diagnostics) {
      const zip = await guardedGet(ctx, AZURE_URL, FETCH_LIMITS.archiveBytes, [
        "azureedge.net",
        "microsoft.com",
        "azure.com",
      ]);
      if (!isZip(zip.body))
        throw new FetchError("archive-invalid", "Azure download is not a zip archive");
      const raws = extractSvgs(zip.body, azureSelect, diagnostics);
      // Prefer category folders over `other`/`new` when an icon appears in several.
      raws.sort((a, b) => cmp(azureOrder(a.sourcePath), azureOrder(b.sourcePath)));
      const seen = new Set<string>();
      const unique = raws.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
      return { raws: unique, resolved: zip.url, version: "V25" };
    },
  },
  gcp: {
    id: "gcp",
    info: {
      name: "Google Cloud icons",
      license: "LicenseRef-google-cloud-icons",
      licenseUrl: "https://cloud.google.com/icons",
      attribution: "Google Cloud icons, Google LLC.",
      trademarkNotice: "Google Cloud and the Google Cloud logo are trademarks of Google LLC.",
      source: "https://cloud.google.com/icons",
      redistributable: false,
    },
    terms:
      "Google Cloud icons: check Google's terms at https://cloud.google.com/icons before using them. The icons are downloaded to your machine and are never redistributed by PlatformCosmo.",
    requiresAcceptance: false,
    async fetch(ctx, diagnostics) {
      const raws: RawIcon[] = [];
      const finals: string[] = [];
      for (const url of GCP_URLS) {
        const zip = await guardedGet(ctx, url, FETCH_LIMITS.archiveBytes, ["google.com"]);
        if (!isZip(zip.body))
          throw new FetchError("archive-invalid", "Google download is not a zip archive");
        finals.push(zip.url);
        raws.push(...extractSvgs(zip.body, gcpSelect, diagnostics));
      }
      // Both archives, as the final URLs actually fetched (space separated).
      return { raws, resolved: finals.join(" "), version: "current" };
    },
  },
  cncf: {
    id: "cncf",
    info: {
      name: "CNCF artwork (project icons)",
      license: "LicenseRef-cncf-artwork",
      licenseUrl: "https://github.com/cncf/artwork#license",
      attribution: "CNCF project artwork, The Linux Foundation and respective project authors.",
      trademarkNotice:
        "CNCF artwork is made available under the Linux Foundation trademark usage guidelines (https://www.linuxfoundation.org/legal/trademark-usage). Marks must not be altered.",
      source: "https://github.com/cncf/artwork",
      redistributable: false,
    },
    terms:
      "CNCF artwork has no copyright license; it is made available under the Linux Foundation trademark usage guidelines (https://www.linuxfoundation.org/legal/trademark-usage) and the marks must not be altered. PlatformCosmo normalizes the SVG markup for safety but does not change the artwork. The icons are downloaded to your machine and are never redistributed by PlatformCosmo.",
    requiresAcceptance: false,
    async fetch(ctx, diagnostics) {
      return fetchGithubSvgs(
        ctx,
        "cncf",
        "artwork",
        "main",
        (p) => {
          const m = CNCF_RE.exec(p);
          return m?.[1] ? { id: kebab(m[1]), category: "general" } : undefined;
        },
        diagnostics,
      );
    },
  },
};

export const PROVIDER_IDS: readonly string[] = Object.keys(PROVIDERS);
/** Terms text per provider id (for `icons list`/docs). */
export const PROVIDER_TERMS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(PROVIDERS).map(([k, v]) => [k, v.terms]),
);

// --- entry point -------------------------------------------------------------------

const GENERIC_SEGMENTS = new Set([
  "icons",
  "icon",
  "svg",
  "svgs",
  "assets",
  "asset",
  "dist",
  "src",
  "lib",
  "images",
  "image",
  "img",
  "imgs",
  "public",
  "static",
  "build",
  "files",
  "download",
  "downloads",
  "raw",
  "archive",
  "zip",
  "release",
  "releases",
  "latest",
  "main",
  "master",
  "head",
  "tree",
  "blob",
  "refs",
  "heads",
  "tags",
]);

/** Removes C0/C1 control characters and bidirectional overrides/isolates from display text. */
function cleanText(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f)) continue;
    if (
      c === 0x200e ||
      c === 0x200f ||
      (c >= 0x202a && c <= 0x202e) ||
      (c >= 0x2066 && c <= 0x2069)
    ) {
      continue;
    }
    out += ch;
  }
  return out;
}

function packIdFrom(s: string): string | undefined {
  const id = kebab(s);
  if (!id) return undefined;
  return (/^[a-z]/.test(id) ? id : `p-${id}`).slice(0, 31).replace(/-+$/, "");
}

/**
 * Pack id and description for a URL source. GitHub-style URLs (tree/blob, raw, codeload,
 * archive) use the repository name; otherwise the last path segment that is not generic
 * (`icons`, `svg`, `dist`, ...), then the host's first label.
 */
export function derivePackSource(url: URL): { id: string; description: string } {
  const segs = url.pathname
    .split("/")
    .filter(Boolean)
    .map((s) => {
      try {
        return cleanText(decodeURIComponent(s));
      } catch {
        return cleanText(s);
      }
    });
  const host = url.hostname.toLowerCase();
  let owner: string | undefined;
  let repo: string | undefined;
  let rest: string[] = [];
  if (
    host === "github.com" ||
    host === "raw.githubusercontent.com" ||
    host === "codeload.github.com"
  ) {
    owner = segs[0];
    repo = segs[1]?.replace(/\.git$/i, "");
    rest =
      host === "github.com"
        ? segs.slice(4)
        : host === "raw.githubusercontent.com"
          ? segs.slice(3)
          : [];
    if (host === "github.com" && (segs[2] === "archive" || segs[2] === "releases")) rest = [];
  }
  if (owner && repo) {
    const id = packIdFrom(repo);
    if (id) {
      const path = rest.join("/").replace(/\.(zip|svg)$/i, "");
      return { id, description: `${owner}/${repo}${path ? ` (${path})` : ""}` };
    }
  }
  const stripped = segs.map((s) => s.replace(/\.(zip|svg|tar|tgz|gz)$/i, ""));
  for (let i = stripped.length - 1; i >= 0; i--) {
    const s = stripped[i] as string;
    if (GENERIC_SEGMENTS.has(s.toLowerCase())) continue;
    const id = packIdFrom(s);
    if (id) return { id, description: `${host}/${segs.slice(0, i + 1).join("/")}` };
  }
  return { id: packIdFrom(host.split(".")[0] ?? "") ?? "pack", description: host };
}

function deriveId(url: URL, fallback: string): string {
  const last = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() ?? "").replace(
    /\.(zip|svg)$/i,
    "",
  );
  const id = kebab(last) || kebab(url.hostname.split(".")[0] ?? "") || fallback;
  return /^[a-z]/.test(id) ? id.slice(0, 31) : `p-${id}`.slice(0, 31);
}

const GITHUB_TREE_RE = /^\/([^/]+)\/([^/]+)\/tree\/([^/]+)(?:\/(.*))?$/;

export const fetchIconPack: FetchIconPackFn = async (source, options) => {
  const diagnostics: Diagnostic[] = [];
  const key = typeof source === "string" ? source.trim().toLowerCase() : "";
  const provider = Object.hasOwn(PROVIDERS, key) ? PROVIDERS[key] : undefined;
  // Provider terms accompany every outcome, including failures, so the CLI can always show them.
  const fail = (code: string, message: string, terms: string | undefined = provider?.terms) => ({
    diagnostics: [...diagnostics, diag("error", code, message)],
    ...(terms ? { terms } : {}),
  });
  try {
    const ctx: HttpCtx = { http: options.http };
    const packId = options.packId ?? provider?.id;
    if (options.packId !== undefined && !PACK_ID_RE.test(options.packId)) {
      return fail("invalid-pack-id", `pack id must match ${PACK_ID_RE.source}`);
    }
    if (provider) {
      if (RESERVED_PACK_IDS.has(packId as string))
        return fail("reserved-pack-id", `pack id "${packId}" is reserved`);
      if (provider.requiresAcceptance && options.acceptTerms !== true) {
        return fail(
          "terms-not-accepted",
          `${provider.info.name} require accepting Microsoft's terms (pass --accept-terms).`,
          provider.terms,
        );
      }
      const r = await provider.fetch(ctx, diagnostics);
      return finish(
        { ...provider.info, id: packId as string, version: r.version },
        provider.id,
        r,
        provider.terms,
        source,
        diagnostics,
      );
    }

    const chk = checkHttpsUrl(source);
    if (!chk.ok) return fail("invalid-url", `${chk.reason}`);
    const gh = chk.url.hostname === "github.com" ? GITHUB_TREE_RE.exec(chk.url.pathname) : null;
    const derived = derivePackSource(chk.url);
    const id = packId ?? derived.id;
    // URL packs must not shadow a bundled pack or a provider id (aws, azure, gcp, cncf).
    if (RESERVED_PACK_IDS.has(id) || Object.hasOwn(PROVIDERS, id))
      return fail("reserved-pack-id", `pack id "${id}" is reserved; pass --id`);
    const info = (version: string): IconPackInfo => ({
      id,
      name: derived.description.slice(0, 80),
      version,
      license: "LicenseRef-user-supplied",
      source,
      redistributable: false,
    });
    if (gh?.[1] && gh[2] && gh[3]) {
      const dir = (gh[4] ?? "").replace(/\/+$/, "");
      const r = await fetchGithubSvgs(
        ctx,
        gh[1],
        gh[2],
        gh[3],
        (p) => {
          if (dir && !p.startsWith(`${dir}/`)) return undefined;
          if (!/\.svg$/i.test(p)) return undefined;
          return {
            id: kebab(p.slice(p.lastIndexOf("/") + 1).replace(/\.svg$/i, "")),
            category: "general",
          };
        },
        diagnostics,
      );
      return finish(info(r.version), undefined, r, undefined, source, diagnostics);
    }
    const res = await guardedGet(ctx, source, FETCH_LIMITS.archiveBytes);
    if (isZip(res.body)) {
      const raws = extractSvgs(
        res.body,
        (p) => {
          const base = kebab(p.slice(p.lastIndexOf("/") + 1).replace(/\.svg$/i, ""));
          return base ? { id: base, category: "general" } : undefined;
        },
        diagnostics,
      );
      return finish(
        info("1.0.0"),
        undefined,
        { raws, resolved: res.url, version: "1.0.0" },
        undefined,
        source,
        diagnostics,
      );
    }
    if (res.body.length > FETCH_LIMITS.svgBytes)
      return fail("archive-too-large", `SVG exceeds ${FETCH_LIMITS.svgBytes} bytes`);
    const finalUrl = new URL(res.url);
    const raws: RawIcon[] = [
      {
        id: deriveId(finalUrl, id),
        category: "general",
        sourcePath: res.url,
        svg: utf8.decode(res.body),
      },
    ];
    return finish(
      info("1.0.0"),
      undefined,
      { raws, resolved: res.url, version: "1.0.0" },
      undefined,
      source,
      diagnostics,
    );
  } catch (e) {
    if (e instanceof FetchError || e instanceof ArchiveError) return fail(e.code, e.message);
    return fail("fetch-failed", short(e));
  }
};

function finish(
  info: IconPackInfo,
  provider: string | undefined,
  r: ProviderResult,
  terms: string | undefined,
  source: string,
  diagnostics: Diagnostic[],
) {
  const built = buildPack(info, provider, r.raws);
  const all = [...diagnostics, ...built.diagnostics];
  if (built.pack.manifest.icons.length === 0) {
    return {
      diagnostics: [...all, diag("error", "no-icons", "no usable SVG icons were found")],
      ...(terms ? { terms } : {}),
    };
  }
  return {
    pack: built.pack,
    lock: {
      source,
      resolved: r.resolved,
      integrity: computeIconIntegrity(built.pack),
      license: info.license,
      redistributable: false,
      iconCount: built.pack.manifest.icons.length,
    },
    ...(terms ? { terms } : {}),
    diagnostics: all,
  };
}
