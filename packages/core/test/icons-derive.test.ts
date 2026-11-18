import { strToU8 } from "fflate";
import { describe, expect, test } from "vitest";
import type { IconHttpClient } from "../src/index.js";
import { derivePackSource, fetchIconPack } from "../src/icons/index.js";

const d = (u: string) => derivePackSource(new URL(u));

describe("derivePackSource", () => {
  test.each([
    [
      "https://github.com/feathericons/feather/tree/main/icons",
      "feather",
      "feathericons/feather (icons)",
    ],
    ["https://github.com/feathericons/feather", "feather", "feathericons/feather"],
    [
      "https://github.com/tabler/tabler-icons/tree/main/icons/outline",
      "tabler-icons",
      "tabler/tabler-icons (icons/outline)",
    ],
    [
      "https://github.com/acme/Set.Of.Icons/blob/v1/svg/a.svg",
      "set-of-icons",
      "acme/Set.Of.Icons (svg/a)",
    ],
    [
      "https://raw.githubusercontent.com/feathericons/feather/main/icons/users.svg",
      "feather",
      "feathericons/feather (icons/users)",
    ],
    [
      "https://codeload.github.com/feathericons/feather/zip/refs/heads/main",
      "feather",
      "feathericons/feather",
    ],
    [
      "https://github.com/feathericons/feather/archive/refs/heads/main.zip",
      "feather",
      "feathericons/feather",
    ],
    ["https://github.com/9icons/zero.git/tree/main", "zero", "9icons/zero"],
    ["https://github.com/123/456/tree/main", "p-456", "123/456"],
  ])("github-style %s -> %s", (u, id, description) => {
    expect(d(u)).toEqual({ id, description });
  });

  test.each([
    ["https://example.com/downloads/acme-icons.zip", "acme-icons"],
    ["https://example.com/acme/icons/svg/", "acme"],
    ["https://example.com/assets/dist/", "example"],
    ["https://cdn.example.org/pkg/v2/Brand Logo.svg", "brand-logo"],
    ["https://example.com/icons.zip", "example"],
    ["https://example.com/", "example"],
    ["https://example.com/%E0%A4%A", "e0-a4-a"],
  ])("generic segments are skipped: %s -> %s", (u, id) => {
    expect(d(u).id).toBe(id);
  });

  test("ids always satisfy the pack id rule", () => {
    for (const u of [
      "https://example.com/" + "x".repeat(80) + ".zip",
      "https://example.com/Ünïcode%20Name/",
      "https://example.com/123/",
      "https://github.com/o/" + "r".repeat(60),
    ]) {
      expect(d(u).id, u).toMatch(/^[a-z][a-z0-9-]{0,30}$/);
    }
  });
});

describe("fetchIconPack derives the pack id", () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0"/></svg>';
  const commit = "0123456789abcdef0123456789abcdef01234567";
  const routes: Record<string, string> = {
    "https://api.github.com/repos/feathericons/feather/commits/main": JSON.stringify({
      sha: commit,
    }),
    [`https://api.github.com/repos/feathericons/feather/git/trees/${commit}?recursive=1`]:
      JSON.stringify({
        tree: [
          { path: "icons/users.svg", type: "blob" },
          { path: "icons/user.svg", type: "blob" },
        ],
      }),
    [`https://raw.githubusercontent.com/feathericons/feather/${commit}/icons/users.svg`]: svg,
    [`https://raw.githubusercontent.com/feathericons/feather/${commit}/icons/user.svg`]: svg,
  };
  const http: IconHttpClient = {
    get(url) {
      const body = routes[url];
      if (body === undefined) return Promise.reject(new Error(`no route ${url}`));
      return Promise.resolve({ url, contentType: "text/plain", body: strToU8(body) });
    },
  };

  test("the feather tree URL becomes pack `feather`, not `icons`", async () => {
    const r = await fetchIconPack("https://github.com/feathericons/feather/tree/main/icons", {
      http,
    });
    expect(r.pack?.manifest.pack.id).toBe("feather");
    expect(r.pack?.manifest.pack.name).toBe("feathericons/feather (icons)");
    expect(r.pack?.manifest.icons.map((i) => i.id)).toEqual(["user", "users"]);
  });

  test("an explicit packId still wins", async () => {
    const r = await fetchIconPack("https://github.com/feathericons/feather/tree/main/icons", {
      http,
      packId: "feather-icons",
    });
    expect(r.pack?.manifest.pack.id).toBe("feather-icons");
  });
});
