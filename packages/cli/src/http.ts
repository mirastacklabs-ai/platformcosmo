/**
 * IconHttpClient with SSRF defense (the only network code in the CLI; used by `icons add`).
 * Rules: https only (port 443), no URL credentials, redirects followed manually (max 5), DNS
 * resolved here and every address checked (loopback, private, link-local, CGNAT, multicast,
 * reserved, cloud metadata) on every hop, the request then connects to the vetted IP (no second
 * lookup, so DNS rebinding cannot swap it), `maxBytes` enforced while streaming, one overall timeout.
 */
import { lookup } from "node:dns/promises";
import { Agent, request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { IconHttpClient } from "@platformcosmo/core";

export class HttpPolicyError extends Error {
  constructor(
    readonly code:
      | "scheme"
      | "credentials"
      | "port"
      | "blocked-address"
      | "dns"
      | "redirects"
      | "too-large"
      | "timeout"
      | "status"
      | "network",
    message: string,
  ) {
    super(message);
    this.name = "HttpPolicyError";
  }
}

/** Parses an IPv4 dotted quad into 4 octets, or undefined. */
function v4(ip: string): number[] | undefined {
  const parts = ip.split(".");
  if (parts.length !== 4) return undefined;
  const o = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return o.every((n) => n >= 0 && n <= 255) ? o : undefined;
}

function blockedV4(o: readonly number[]): boolean {
  const [a, b, c] = o as [number, number, number, number];
  return (
    a === 0 || // "this" network
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) || // IETF protocol assignments
    (a === 192 && b === 0 && c === 2) || // TEST-NET-1
    (a === 192 && b === 88 && c === 99) || // 6to4 relay
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224 // multicast, reserved, broadcast
  );
}

/** Expands an IPv6 address into 8 16-bit groups, or undefined when malformed. */
function v6groups(ip: string): number[] | undefined {
  let s = ip;
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  const tail = s.lastIndexOf(":");
  if (tail >= 0 && s.slice(tail + 1).includes(".")) {
    const o = v4(s.slice(tail + 1));
    if (!o) return undefined;
    s = `${s.slice(0, tail + 1)}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return undefined;
  const parse = (h: string): number[] | undefined => {
    if (h === "") return [];
    const g = h.split(":").map((x) => (/^[0-9a-fA-F]{1,4}$/.test(x) ? parseInt(x, 16) : NaN));
    return g.some(Number.isNaN) ? undefined : g;
  };
  const head = parse(halves[0]!);
  if (!head) return undefined;
  if (halves.length === 1) return head.length === 8 ? head : undefined;
  const rest = parse(halves[1]!);
  if (!rest || head.length + rest.length > 7) return undefined;
  return [...head, ...Array<number>(8 - head.length - rest.length).fill(0), ...rest];
}

function embeddedV4(g: readonly number[], hi: number, lo: number): number[] {
  return [g[hi]! >> 8, g[hi]! & 255, g[lo]! >> 8, g[lo]! & 255];
}

/** True when connecting to `ip` must be refused (non-public or unparseable). */
export function isBlockedAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const o = v4(ip);
    return !o || blockedV4(o);
  }
  if (kind !== 6) return true;
  const g = v6groups(ip);
  if (!g) return true;
  const first = g[0]!;
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): judge the embedded address.
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    return blockedV4(embeddedV4(g, 6, 7));
  }
  // NAT64 64:ff9b::/96 and 64:ff9b:1::/48: judge the embedded address.
  if (first === 0x64 && g[1] === 0xff9b) {
    if (g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) return blockedV4(embeddedV4(g, 6, 7));
    return true; // 64:ff9b:1::/48 local-use NAT64 and anything else under 64:ff9b::
  }
  if (first === 0x2002) return blockedV4(embeddedV4(g, 1, 2)); // 6to4
  if (first === 0x2001 && g[1]! < 0x200) return true; // 2001::/23 IETF assignments (Teredo, ORCHID, ...)
  if (first === 0x2001 && g[1] === 0xdb8) return true; // documentation
  if (first === 0x3fff && (g[1]! & 0xf000) === 0) return true; // documentation 3fff::/20
  // Default deny: only global unicast 2000::/3 is reachable. This also drops fc00::/7 (ULA, incl.
  // the fd00:ec2::254 metadata address), fe80::/10, fec0::/10, ff00::/8, 100::/64 and the rest.
  return (first & 0xe000) !== 0x2000;
}

export interface TransportRequest {
  readonly url: URL;
  /** Vetted address to connect to. */
  readonly ip: string;
  readonly signal: AbortSignal;
  readonly headers: Readonly<Record<string, string>>;
}
export interface TransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: AsyncIterable<Uint8Array>;
  /** Tears the connection down without reading the rest of the body. */
  readonly destroy?: () => void;
}
export type Transport = (req: TransportRequest) => Promise<TransportResponse>;
export type Resolver = (hostname: string) => Promise<readonly string[]>;

const defaultResolver: Resolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

/** Connects to the vetted IP while keeping SNI and certificate checks on the hostname. */
export const defaultTransport: Transport = ({ url, ip, signal, headers }) =>
  new Promise((resolve, reject) => {
    const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
    const req = httpsRequest(
      {
        host: ip,
        port: 443,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        servername: isIP(host) ? undefined : host,
        headers: { ...headers, host: url.host },
        signal,
        agent: new Agent({ keepAlive: false }),
      },
      (res) => {
        const h: Record<string, string | undefined> = {};
        for (const [k, v] of Object.entries(res.headers)) h[k] = Array.isArray(v) ? v[0] : v;
        resolve({
          status: res.statusCode ?? 0,
          headers: h,
          body: res,
          destroy: () => void res.destroy(),
        });
      },
    );
    req.on("error", reject);
    req.end();
  });

export interface HttpClientOptions {
  resolve?: Resolver;
  transport?: Transport;
  /** Default 5. */
  maxRedirects?: number;
  /** Time allowed for one connection attempt to produce response headers, default 5000 ms. */
  connectTimeoutMs?: number;
}

const REDIRECT = new Set([301, 302, 303, 307, 308]);

/** Validates scheme/credentials/port; returns the parsed URL. */
export function checkUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpPolicyError("scheme", `not a valid URL: ${raw.slice(0, 200)}`);
  }
  if (url.protocol !== "https:") {
    throw new HttpPolicyError("scheme", `only https URLs are allowed (got ${url.protocol})`);
  }
  if (url.username || url.password) {
    throw new HttpPolicyError("credentials", "URLs with embedded credentials are not allowed");
  }
  if (url.port !== "" && url.port !== "443") {
    throw new HttpPolicyError("port", `only port 443 is allowed (got ${url.port})`);
  }
  return url;
}

async function vet(
  url: URL,
  resolve: Resolver,
): Promise<{ host: string; addrs: readonly string[] }> {
  const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  let addrs: readonly string[];
  if (isIP(host)) addrs = [host];
  else {
    try {
      addrs = await resolve(host);
    } catch (e) {
      throw new HttpPolicyError("dns", `cannot resolve ${host}: ${(e as Error).message}`);
    }
  }
  if (addrs.length === 0) throw new HttpPolicyError("dns", `no addresses for ${host}`);
  const bad = addrs.find(isBlockedAddress);
  if (bad !== undefined) {
    throw new HttpPolicyError(
      "blocked-address",
      `${host} resolves to a non-public address (${bad}); refusing to connect`,
    );
  }
  return { host, addrs };
}

/** Rejects when `signal` aborts, so a stalled DNS lookup cannot outlive the overall timeout. */
function aborted(signal: AbortSignal, make: () => Error): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) return reject(make());
    signal.addEventListener("abort", () => reject(make()), { once: true });
  });
}

export function createIconHttpClient(options: HttpClientOptions = {}): IconHttpClient {
  const resolve = options.resolve ?? defaultResolver;
  const transport = options.transport ?? defaultTransport;
  const maxRedirects = options.maxRedirects ?? 5;
  const connectTimeoutMs = options.connectTimeoutMs ?? 5000;
  // Last address that worked per host: a dead first address (typically unroutable IPv6) is paid for once,
  // not once per request.
  const preferred = new Map<string, string>();

  return {
    async get(rawUrl, { maxBytes, timeoutMs }) {
      if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
        throw new HttpPolicyError("too-large", "maxBytes must be a positive finite number");
      }
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new HttpPolicyError("timeout", "timeoutMs must be a positive finite number");
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const timedOut = () => new HttpPolicyError("timeout", `request exceeded ${timeoutMs} ms`);
      const cleanups: (() => void)[] = [];
      try {
        let url = checkUrl(rawUrl);
        for (let hop = 0; ; hop++) {
          const { host, addrs } = await Promise.race([
            vet(url, resolve),
            aborted(controller.signal, timedOut),
          ]);
          // Every address was vetted. Try the one that last worked, then IPv4, then IPv6; an attempt that
          // cannot produce headers within connectTimeoutMs moves on to the next address.
          const first = preferred.get(host);
          const ordered = [
            ...addrs.filter((a) => a === first),
            ...addrs.filter((a) => a !== first && isIP(a) === 4),
            ...addrs.filter((a) => a !== first && isIP(a) !== 4),
          ];
          let res: TransportResponse | undefined;
          let lastError: unknown;
          for (const ip of ordered) {
            const attempt = new AbortController();
            const link = () => attempt.abort();
            controller.signal.addEventListener("abort", link, { once: true });
            cleanups.push(() => controller.signal.removeEventListener("abort", link));
            const headerTimer = setTimeout(
              () => attempt.abort(),
              Math.min(connectTimeoutMs, timeoutMs),
            );
            try {
              res = await transport({
                url,
                ip,
                signal: attempt.signal,
                headers: { "user-agent": "pcosmo", accept: "*/*", "accept-encoding": "identity" },
              });
              preferred.set(host, ip);
              break;
            } catch (e) {
              if (controller.signal.aborted) throw timedOut();
              lastError = e;
            } finally {
              clearTimeout(headerTimer);
            }
          }
          if (!res) {
            throw new HttpPolicyError(
              "network",
              `request failed: ${lastError instanceof Error ? lastError.message : "no address reachable"}`,
            );
          }
          if (REDIRECT.has(res.status)) {
            res.destroy?.();
            const loc = res.headers["location"];
            if (!loc)
              throw new HttpPolicyError("status", `redirect ${res.status} without Location`);
            if (hop >= maxRedirects) {
              throw new HttpPolicyError("redirects", `more than ${maxRedirects} redirects`);
            }
            res.destroy?.();
            try {
              url = checkUrl(new URL(loc, url).toString());
            } catch (e) {
              if (e instanceof HttpPolicyError) {
                throw new HttpPolicyError(e.code, `redirect target refused: ${e.message}`);
              }
              throw e;
            }
            continue;
          }
          if (res.status < 200 || res.status > 299) {
            res.destroy?.();
            throw new HttpPolicyError("status", `HTTP ${res.status} from ${url.host}`);
          }
          const encoding = res.headers["content-encoding"]?.trim().toLowerCase();
          if (encoding && encoding !== "identity") {
            res.destroy?.();
            throw new HttpPolicyError(
              "status",
              `unsupported Content-Encoding "${encoding.slice(0, 40)}"`,
            );
          }
          const declared = Number(res.headers["content-length"]);
          if (Number.isFinite(declared) && declared > maxBytes) {
            res.destroy?.();
            throw new HttpPolicyError(
              "too-large",
              `response is ${declared} bytes (limit ${maxBytes})`,
            );
          }
          const chunks: Uint8Array[] = [];
          let total = 0;
          try {
            for await (const chunk of res.body) {
              total += chunk.byteLength;
              if (total > maxBytes) {
                controller.abort();
                res.destroy?.();
                throw new HttpPolicyError("too-large", `response exceeds ${maxBytes} bytes`);
              }
              chunks.push(chunk);
            }
          } catch (e) {
            if (e instanceof HttpPolicyError) throw e;
            if (controller.signal.aborted) throw timedOut();
            throw new HttpPolicyError("network", `download failed: ${(e as Error).message}`);
          }
          const body = new Uint8Array(total);
          let off = 0;
          for (const c of chunks) {
            body.set(c, off);
            off += c.byteLength;
          }
          return { url: url.toString(), contentType: res.headers["content-type"] ?? "", body };
        }
      } finally {
        clearTimeout(timer);
        for (const c of cleanups) c();
      }
    },
  };
}
