import { EventEmitter } from "node:events";
import { describe, expect, test, vi } from "vitest";

const calls: { options: Record<string, unknown> }[] = [];
vi.mock("node:https", () => ({
  Agent: class {
    constructor(readonly opts: unknown) {}
  },
  request: (options: Record<string, unknown>, cb: (res: unknown) => void) => {
    calls.push({ options });
    const req = new EventEmitter() as EventEmitter & { end: () => void };
    req.end = () => {
      const res = new EventEmitter() as EventEmitter & {
        statusCode: number;
        headers: Record<string, string | string[]>;
        destroy: () => void;
      };
      res.statusCode = 200;
      res.headers = { "content-type": "image/svg+xml", "set-cookie": ["a=1", "b=2"] };
      res.destroy = () => undefined;
      cb(res);
    };
    return req;
  },
}));

const { defaultTransport } = await import("../src/http.js");

describe("defaultTransport (node:https mocked, no network)", () => {
  test("connects to the vetted IP on 443 with SNI and Host of the hostname", async () => {
    const ac = new AbortController();
    const res = await defaultTransport({
      url: new URL("https://icons.example.com/a/b.svg?x=1"),
      ip: "93.184.216.34",
      signal: ac.signal,
      headers: { "user-agent": "pcosmo" },
    });
    const o = calls[0]!.options as {
      host: string;
      port: number;
      path: string;
      servername: string;
      headers: Record<string, string>;
      signal: AbortSignal;
      agent: { opts: { keepAlive: boolean } };
    };
    expect(o.host).toBe("93.184.216.34");
    expect(o.port).toBe(443);
    expect(o.path).toBe("/a/b.svg?x=1");
    expect(o.servername).toBe("icons.example.com");
    expect(o.headers.host).toBe("icons.example.com");
    expect(o.headers["user-agent"]).toBe("pcosmo");
    expect(o.signal).toBe(ac.signal);
    expect(o.agent.opts.keepAlive).toBe(false);
    expect(res.status).toBe(200);
    expect(res.headers["set-cookie"]).toBe("a=1");
    expect(typeof res.destroy).toBe("function");
  });

  test("an IP-literal URL sends no SNI (the certificate is checked against the IP)", async () => {
    await defaultTransport({
      url: new URL("https://[2606:4700:4700::1111]/x"),
      ip: "2606:4700:4700::1111",
      signal: new AbortController().signal,
      headers: {},
    });
    const o = calls.at(-1)!.options as { host: string; servername?: string };
    expect(o.host).toBe("2606:4700:4700::1111");
    expect(o.servername).toBeUndefined();
  });
});
