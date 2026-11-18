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
const PACK_ID_RE = /^[a-z][a-z0-9-]{0,30}$/;

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
  const host = u.hostname.toLowerCase();
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

function unsafeName(name: string): boolean {
  if (name.length === 0 || name.length > 512) return true;
  if (name.includes("\0") || name.includes("\\") || name.startsWith("/")) return true;
  if (/^[A-Za-z]:/.test(name)) return true;
  return name.split("/").some((seg) => seg === "..");
}

/** Reads the central directory without inflating anything. */
export function readZipDirectory(buf: Uint8Array): ZipEntry[] {
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
    if (unsafeName(name)) {
      throw new ArchiveError(
        "zip-slip",
        `unsafe entry name in archive: ${JSON.stringify(name.slice(0, 80))}`,
      );
    }
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
  for (const r of [...raws].sort((a, b) =>
    a.sourcePath < b.sourcePath ? -1 : a.sourcePath > b.sourcePath ? 1 : 0,
  )) {
    const res = sanitizeSvg(r.svg, { maxBytes: FETCH_LIMITS.svgBytes });
    if (!res.ok || res.svg.body.length > FETCH_LIMITS.sanitizedBytes) {
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
    files[file] =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${res.svg.viewBox}">${res.svg.body.replaceAll("__PCID__-", "i")}</svg>`;
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
  icons.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const manifest: IconManifest = { manifestVersion: 1, pack: info, icons };
  return { pack: { manifest, files }, diagnostics };
}

// --- zip -> icons --------------------------------------------------------------------

type Selector = (path: string) => { id: string; category: IconCategory } | undefined;

function extractSvgs(buf: Uint8Array, select: Selector, diagnostics: Diagnostic[]): RawIcon[] {
  const entries = readZipDirectory(buf);
  const selected: { e: ZipEntry; id: string; category: IconCategory }[] = [];
  for (const e of entries) {
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
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i] as T);
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
  const treeUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
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
  paths.sort((a, b) => (a.path < b.path ? -1 : 1));
  if (paths.length > MAX_LISTED_FILES) {
    throw new ArchiveError(
      "archive-too-many-files",
      `listing has more than ${MAX_LISTED_FILES} matching files`,
    );
  }
  const base = `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(ref)}/`;
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
  const sha =
    typeof tree.sha === "string" ? tree.sha.replace(/[^0-9a-f]/g, "").slice(0, 12) : "unknown";
  return { raws, resolved: treeUrl, version: `${repo}@${sha}` };
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
    async fetch(ctx) {
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
      const diagnostics: Diagnostic[] = [];
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
    async fetch(ctx) {
      const zip = await guardedGet(ctx, AZURE_URL, FETCH_LIMITS.archiveBytes, [
        "azureedge.net",
        "microsoft.com",
        "azure.com",
      ]);
      if (!isZip(zip.body))
        throw new FetchError("archive-invalid", "Azure download is not a zip archive");
      const raws = extractSvgs(zip.body, azureSelect, []);
      // Prefer category folders over `other`/`new` when an icon appears in several.
      raws.sort((a, b) => (azureOrder(a.sourcePath) < azureOrder(b.sourcePath) ? -1 : 1));
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
    async fetch(ctx) {
      const raws: RawIcon[] = [];
      for (const url of GCP_URLS) {
        const zip = await guardedGet(ctx, url, FETCH_LIMITS.archiveBytes, ["google.com"]);
        if (!isZip(zip.body))
          throw new FetchError("archive-invalid", "Google download is not a zip archive");
        raws.push(...extractSvgs(zip.body, gcpSelect, []));
      }
      return { raws, resolved: GCP_URLS.join(" "), version: "current" };
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
  const fail = (code: string, message: string, terms?: string) => ({
    diagnostics: [...diagnostics, diag("error", code, message)],
    ...(terms ? { terms } : {}),
  });
  try {
    const ctx: HttpCtx = { http: options.http };
    const provider =
      typeof source === "string" ? PROVIDERS[source.trim().toLowerCase()] : undefined;
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
    const id = packId ?? deriveId(chk.url, "pack");
    if (RESERVED_PACK_IDS.has(id))
      return fail("reserved-pack-id", `pack id "${id}" is reserved; pass --id`);
    const info = (version: string): IconPackInfo => ({
      id,
      name: id,
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
