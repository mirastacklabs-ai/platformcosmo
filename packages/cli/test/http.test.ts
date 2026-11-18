import { describe, expect, test } from "vitest";
import {
  HttpPolicyError,
  type Resolver,
  type Transport,
  type TransportResponse,
  createIconHttpClient,
  isBlockedAddress,
} from "../src/http.js";

describe("isBlockedAddress", () => {
  const blocked = [
    "0.0.0.0",
    "10.1.2.3",
    "127.0.0.1",
    "127.255.255.254",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "100.64.0.1",
    "100.127.255.255",
    "224.0.0.1",
    "239.1.1.1",
    "255.255.255.255",
    "192.0.0.1",
    "198.18.0.1",
    "240.0.0.1",
    "::",
    "::1",
    "fe80::1",
    "fc00::1",
    "fd00:ec2::254",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:169.254.169.254",
    "64:ff9b::7f00:1",
    "2002:7f00:1::1",
    "2001:db8::1",
    "fec0::1",
    "not-an-ip",
    "1.2.3",
  ];
  const allowed = [
    "8.8.8.8",
    "1.1.1.1",
    "93.184.216.34",
    "172.15.0.1",
    "172.32.0.1",
    "100.63.255.255",
    "100.128.0.1",
    "198.20.0.1",
    "223.255.255.255",
    "2606:4700:4700::1111",
    "2a00:1450:4009::200e",
    "::ffff:8.8.8.8",
  ];
  test.each(blocked)("blocks %s", (ip) => expect(isBlockedAddress(ip)).toBe(true));
  test.each(allowed)("allows %s", (ip) => expect(isBlockedAddress(ip)).toBe(false));
});

function body(...parts: string[]): AsyncIterable<Uint8Array> {
  return (async function* () {
    for (const p of parts) yield new TextEncoder().encode(p);
  })();
}
const ok = (data: string, headers: Record<string, string> = {}): TransportResponse => ({
  status: 200,
  headers: { "content-type": "image/svg+xml", ...headers },
  body: body(data),
});
const redirect = (to: string): TransportResponse => ({
  status: 302,
  headers: { location: to },
  body: body(""),
});
const OPTS = { maxBytes: 1000, timeoutMs: 1000 };

function client(resolve: Resolver, transport: Transport, maxRedirects?: number) {
  return createIconHttpClient({ resolve, transport, ...(maxRedirects ? { maxRedirects } : {}) });
}
const pub: Resolver = () => Promise.resolve(["93.184.216.34"]);

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpPolicyError) return e.code;
    throw e;
  }
  return "no-error";
}

describe("createIconHttpClient", () => {
  test("fetches over https and connects to the vetted IP", async () => {
    const seen: string[] = [];
    const c = client(pub, (r) => {
      seen.push(r.ip);
      return Promise.resolve(ok("<svg/>"));
    });
    const r = await c.get("https://icons.example.com/a.svg", OPTS);
    expect(new TextDecoder().decode(r.body)).toBe("<svg/>");
    expect(r.url).toBe("https://icons.example.com/a.svg");
    expect(r.contentType).toBe("image/svg+xml");
    expect(seen).toEqual(["93.184.216.34"]);
  });

  test("rejects non-https, credentials and odd ports before any lookup", async () => {
    let looked = 0;
    const c = client(
      () => {
        looked++;
        return Promise.resolve(["93.184.216.34"]);
      },
      () => Promise.resolve(ok("x")),
    );
    expect(await code(c.get("http://example.com/a.svg", OPTS))).toBe("scheme");
    expect(await code(c.get("ftp://example.com/a.svg", OPTS))).toBe("scheme");
    expect(await code(c.get("https://user:pw@example.com/a.svg", OPTS))).toBe("credentials");
    expect(await code(c.get("https://example.com:8443/a.svg", OPTS))).toBe("port");
    expect(await code(c.get("nonsense", OPTS))).toBe("scheme");
    expect(looked).toBe(0);
  });

  test("rejects hostnames that resolve to private ranges (any address in the answer)", async () => {
    const c = client(
      () => Promise.resolve(["93.184.216.34", "10.0.0.5"]),
      () => Promise.resolve(ok("x")),
    );
    expect(await code(c.get("https://example.com/a.svg", OPTS))).toBe("blocked-address");
  });

  test.each([
    "https://127.0.0.1/a.svg",
    "https://[::1]/a.svg",
    "https://169.254.169.254/latest/meta-data",
    "https://2130706433/a.svg", // decimal loopback, normalized by URL
    "https://0x7f.1/a.svg",
    "https://[::ffff:7f00:1]/a.svg",
    "https://[fd00:ec2::254]/",
  ])("rejects IP literal %s", async (url) => {
    let called = false;
    const c = client(pub, () => {
      called = true;
      return Promise.resolve(ok("x"));
    });
    expect(await code(c.get(url, OPTS))).toBe("blocked-address");
    expect(called).toBe(false);
  });

  test("DNS failure is reported", async () => {
    const c = client(
      () => Promise.reject(new Error("ENOTFOUND")),
      () => Promise.resolve(ok("x")),
    );
    expect(await code(c.get("https://nope.example/a.svg", OPTS))).toBe("dns");
  });

  test("re-vets every redirect hop (public → private)", async () => {
    const resolve: Resolver = (h) =>
      Promise.resolve(h === "evil.example" ? ["192.168.0.10"] : ["93.184.216.34"]);
    const c = client(resolve, () => Promise.resolve(redirect("https://evil.example/x")));
    expect(await code(c.get("https://good.example/a.svg", OPTS))).toBe("blocked-address");
  });

  test("redirect to http or to an IP literal is refused", async () => {
    const t1 = client(pub, () => Promise.resolve(redirect("http://good.example/x")));
    expect(await code(t1.get("https://good.example/a.svg", OPTS))).toBe("scheme");
    const t2 = client(pub, () => Promise.resolve(redirect("https://10.0.0.1/x")));
    expect(await code(t2.get("https://good.example/a.svg", OPTS))).toBe("blocked-address");
  });

  test("follows relative redirects and stops after 5", async () => {
    let n = 0;
    const c = client(pub, (r) => {
      n++;
      return Promise.resolve(r.url.pathname === "/final" ? ok("done") : redirect("/final"));
    });
    const r = await c.get("https://good.example/a", OPTS);
    expect(r.url).toBe("https://good.example/final");
    expect(n).toBe(2);

    let hops = 0;
    const loop = client(pub, () => {
      hops++;
      return Promise.resolve(redirect(`https://good.example/${hops}`));
    });
    expect(await code(loop.get("https://good.example/start", OPTS))).toBe("redirects");
    expect(hops).toBe(6); // initial request + 5 followed redirects, the 6th redirect is refused
  });

  test("a redirect without Location and non-2xx statuses fail", async () => {
    const c1 = client(pub, () => Promise.resolve({ status: 302, headers: {}, body: body("") }));
    expect(await code(c1.get("https://good.example/a", OPTS))).toBe("status");
    const c2 = client(pub, () => Promise.resolve({ status: 404, headers: {}, body: body("") }));
    expect(await code(c2.get("https://good.example/a", OPTS))).toBe("status");
  });

  test("enforces maxBytes while streaming and via content-length", async () => {
    let pulled = 0;
    const big: TransportResponse = {
      status: 200,
      headers: {},
      body: (async function* () {
        for (let i = 0; i < 100; i++) {
          pulled++;
          yield new Uint8Array(100);
        }
      })(),
    };
    const c = client(pub, () => Promise.resolve(big));
    expect(await code(c.get("https://good.example/a", OPTS))).toBe("too-large");
    expect(pulled).toBeLessThanOrEqual(11);

    const declared = client(pub, () => Promise.resolve(ok("x", { "content-length": "5000" })));
    expect(await code(declared.get("https://good.example/a", OPTS))).toBe("too-large");
  });

  test("times out a stalled request", async () => {
    const c = client(
      pub,
      ({ signal }) =>
        new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted"))),
        ),
    );
    expect(await code(c.get("https://good.example/a", { maxBytes: 10, timeoutMs: 20 }))).toBe(
      "timeout",
    );
  });

  test("times out a stalled body", async () => {
    const stalled: TransportResponse = {
      status: 200,
      headers: {},
      body: {
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
        }),
      },
    };
    // The body never yields; the overall timer cannot interrupt a pending next() by itself,
    // so the transport must honor the signal. Model that with a signal-aware iterator.
    const c = client(pub, ({ signal }) =>
      Promise.resolve({
        ...stalled,
        body: {
          [Symbol.asyncIterator]: () => ({
            next: () =>
              new Promise<IteratorResult<Uint8Array>>((_, reject) =>
                signal.addEventListener("abort", () => reject(new Error("aborted"))),
              ),
          }),
        },
      }),
    );
    expect(await code(c.get("https://good.example/a", { maxBytes: 10, timeoutMs: 20 }))).toBe(
      "timeout",
    );
  });
});
