import { describe, expect, test } from "vitest";
import {
  HttpPolicyError,
  type Resolver,
  type Transport,
  type TransportResponse,
  createIconHttpClient,
  isBlockedAddress,
} from "../src/http.js";

function body(...parts: string[]): AsyncIterable<Uint8Array> {
  return (async function* () {
    for (const p of parts) yield new TextEncoder().encode(p);
  })();
}
const ok = (data: string, headers: Record<string, string> = {}): TransportResponse => ({
  status: 200,
  headers,
  body: body(data),
});
const redirect = (to: string): TransportResponse => ({
  status: 302,
  headers: { location: to },
  body: body(""),
});
const OPTS = { maxBytes: 1000, timeoutMs: 1000 };
const pub: Resolver = () => Promise.resolve(["93.184.216.34"]);
const client = (resolve: Resolver, transport: Transport, maxRedirects?: number) =>
  createIconHttpClient({ resolve, transport, ...(maxRedirects ? { maxRedirects } : {}) });

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpPolicyError) return e.code;
    throw e;
  }
  return "no-error";
}

describe("IPv6 default deny", () => {
  test.each([
    "64:ff9b:1::1",
    "5f00::1",
    "2001:2::1",
    "3fff::1",
    "1::1",
    "100::1",
    "64:ff9b::a00:1",
  ])("blocks %s", (ip) => expect(isBlockedAddress(ip)).toBe(true));

  test("64:ff9b::/96 judges the embedded v4 address", () => {
    expect(isBlockedAddress("64:ff9b::808:808")).toBe(false);
  });
});

describe("client hardening", () => {
  test("the overall timeout also covers a stalled DNS lookup", async () => {
    const c = client(
      () => new Promise<string[]>(() => undefined),
      () => Promise.resolve(ok("x")),
    );
    expect(await code(c.get("https://slow.example/a", { maxBytes: 10, timeoutMs: 20 }))).toBe(
      "timeout",
    );
  });

  test("oversized, redirecting and failing responses are destroyed, not drained", async () => {
    let destroyed = 0;
    const d = (r: TransportResponse): TransportResponse => ({
      ...r,
      destroy: () => void destroyed++,
    });
    const big = client(pub, () => Promise.resolve(d(ok("x", { "content-length": "5000" }))));
    expect(await code(big.get("https://good.example/a", OPTS))).toBe("too-large");
    const bad = client(pub, () => Promise.resolve(d({ status: 500, headers: {}, body: body("") })));
    expect(await code(bad.get("https://good.example/a", OPTS))).toBe("status");
    const loop = client(pub, () => Promise.resolve(d(redirect("https://good.example/b"))), 1);
    expect(await code(loop.get("https://good.example/a", OPTS))).toBe("redirects");
    expect(destroyed).toBeGreaterThanOrEqual(3);
  });

  test("rejects a non-identity Content-Encoding", async () => {
    const c = client(pub, () => Promise.resolve(ok("x", { "content-encoding": "gzip" })));
    expect(await code(c.get("https://good.example/a", OPTS))).toBe("status");
    const id = client(pub, () => Promise.resolve(ok("x", { "content-encoding": "identity" })));
    expect((await id.get("https://good.example/a", OPTS)).body.byteLength).toBe(1);
  });

  test("maxBytes and timeoutMs must be positive and finite", async () => {
    const c = client(pub, () => Promise.resolve(ok("x")));
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(await code(c.get("https://good.example/a", { maxBytes: bad, timeoutMs: 100 }))).toBe(
        "too-large",
      );
      expect(await code(c.get("https://good.example/a", { maxBytes: 10, timeoutMs: bad }))).toBe(
        "timeout",
      );
    }
  });
});
