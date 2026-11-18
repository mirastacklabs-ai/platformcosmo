import { describe, expect, test } from "vitest";
import { fetchIconPack } from "@platformcosmo/core";
import {
  type Resolver,
  type Transport,
  type TransportResponse,
  createIconHttpClient,
} from "../src/http.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const bodyOf = (text: string): AsyncIterable<Uint8Array> =>
  (async function* () {
    yield new TextEncoder().encode(text);
  })();
const okRes = (text: string): TransportResponse => ({
  status: 200,
  headers: {},
  body: bodyOf(text),
});

describe("many requests (an icon listing of ~300 files)", () => {
  test("the timeout is per request, not a shared budget", async () => {
    const pub: Resolver = () => Promise.resolve(["93.184.216.34"]);
    const transport: Transport = async () => {
      await sleep(15);
      return okRes("<svg/>");
    };
    const c = createIconHttpClient({ resolve: pub, transport });
    const t0 = Date.now();
    // 300 requests, 6 at a time like core's listing fetch; each has a 400 ms budget of its own.
    let next = 0;
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        while (next < 300) {
          next++;
          await c.get(`https://raw.example/f${next}.svg`, { maxBytes: 1000, timeoutMs: 400 });
        }
      }),
    );
    // Far more than one request's 400 ms budget in total, and nothing timed out.
    expect(Date.now() - t0).toBeGreaterThan(400);
  });

  test("IPv4 is tried before IPv6, so an unroutable IPv6 address is never paid for", async () => {
    const dual: Resolver = () => Promise.resolve(["2606:50c0:8000::154", "185.199.110.133"]);
    const tried: string[] = [];
    const transport: Transport = ({ ip, signal }) => {
      tried.push(ip);
      if (ip.includes(":")) {
        return new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error("connect aborted"))),
        );
      }
      return Promise.resolve(okRes("<svg/>"));
    };
    const c = createIconHttpClient({ resolve: dual, transport, connectTimeoutMs: 40 });
    for (let i = 0; i < 5; i++) {
      await c.get(`https://raw.example/f${i}.svg`, { maxBytes: 1000, timeoutMs: 2000 });
    }
    // IPv4 is tried first anyway; and even when IPv6 is listed first it is never retried after success.
    expect(tried.filter((a) => a.includes(":")).length).toBe(0);
    expect(tried.filter((a) => !a.includes(":")).length).toBe(5);
  });

  test("falls back from a hanging IPv4 to the next address within the attempt timeout", async () => {
    const two: Resolver = () => Promise.resolve(["185.199.110.133", "185.199.109.133"]);
    const tried: string[] = [];
    const transport: Transport = ({ ip, signal }) => {
      tried.push(ip);
      if (ip === "185.199.110.133") {
        return new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error("connect aborted"))),
        );
      }
      return Promise.resolve(okRes("<svg/>"));
    };
    const c = createIconHttpClient({ resolve: two, transport, connectTimeoutMs: 30 });
    await c.get("https://raw.example/a.svg", { maxBytes: 1000, timeoutMs: 2000 });
    await c.get("https://raw.example/b.svg", { maxBytes: 1000, timeoutMs: 2000 });
    expect(tried).toEqual(["185.199.110.133", "185.199.109.133", "185.199.109.133"]);
  });

  test("core's GitHub listing fetch of 300 files completes through the client (no shared deadline)", async () => {
    const files = Array.from({ length: 300 }, (_, i) => `icons/i${String(i).padStart(3, "0")}.svg`);
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M1 1h22v22H1z"/></svg>';
    const sha = "a".repeat(40);
    let raw = 0;
    const http = {
      async get(url: string) {
        const u = new URL(url);
        await sleep(2);
        if (u.hostname === "api.github.com" && u.pathname.endsWith(`/commits/main`)) {
          return { url, contentType: "application/json", body: enc(JSON.stringify({ sha })) };
        }
        if (u.hostname === "api.github.com") {
          const tree = files.map((path) => ({ path, type: "blob" }));
          return { url, contentType: "application/json", body: enc(JSON.stringify({ sha, tree })) };
        }
        raw++;
        return { url, contentType: "image/svg+xml", body: enc(svg) };
      },
    };
    const r = await fetchIconPack("https://github.com/acme/icons/tree/main/icons", {
      http,
      packId: "acme",
    });
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(r.pack?.manifest.icons.length).toBe(300);
    expect(raw).toBe(300);
  });
});

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
