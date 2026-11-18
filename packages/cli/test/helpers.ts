import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Diagnostic, IconResolver, LoadedIconPack, RenderOptions } from "@platformcosmo/core";
import { afterEach } from "vitest";
import type { CoreApi, Deps } from "../src/deps.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

export async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "pcosmo-test-"));
  dirs.push(d);
  return d;
}

export const noNetwork = {
  get: () => Promise.reject(new Error("network used in a test")),
};

export const fakeResolver: IconResolver = {
  resolve: () => undefined,
  defaultFor: () => undefined,
  search: (q) => (q === "nothing" ? [] : [{ ref: `cosmo:${q}`, score: 0.9 }]),
  packs: () => ["cosmo"],
};

export interface Calls {
  render: { spec: unknown; options: RenderOptions | undefined }[];
}

export function makeCore(over: Partial<CoreApi> = {}, calls?: Calls): CoreApi {
  return {
    parseSpec: (text, format) => {
      if (format === "json") {
        try {
          return { spec: JSON.parse(text), diagnostics: [] };
        } catch (e) {
          return {
            diagnostics: [
              { severity: "error", code: "parse/json", path: "", message: (e as Error).message },
            ],
          };
        }
      }
      return {
        diagnostics: [
          { severity: "error", code: "parse/yaml", path: "", message: "no yaml in fake" },
        ],
      };
    },
    validate: (spec) => {
      const bad = (spec as { bad?: boolean }).bad;
      const diagnostics: Diagnostic[] = bad
        ? [
            {
              severity: "error",
              code: "semantic/unknown-node",
              path: "/edges/0/to",
              message: "unknown node",
              suggestion: 'did you mean "web"?',
            },
          ]
        : [{ severity: "warning", code: "layout/tight", path: "", message: "tight" }];
      return { valid: !bad, diagnostics };
    },
    render: (spec, options) => {
      calls?.render.push({ spec, options });
      const name = options?.name ?? "diagram";
      return Promise.resolve({
        outputs: [{ kind: "animated", path: `${name}.svg`, mime: "image/svg+xml", data: "<svg/>" }],
        diagnostics: [],
        stats: { elements: 1, bytes: { [`${name}.svg`]: 6 } },
      });
    },
    createIconResolver: () => fakeResolver,
    sanitizeSvg: () => ({ ok: false, reason: "fake" }),
    fetchIconPack: () => Promise.reject(new Error("fetch not faked")),
    ...over,
  };
}

export function makeDeps(cwd: string, over: Partial<Deps> = {}): Deps {
  return {
    core: makeCore(),
    bundledPacks: [] as readonly LoadedIconPack[],
    http: noNetwork,
    env: {},
    cwd,
    homedir: join(cwd, "home"),
    createMp4Encoder: () => Promise.resolve(undefined),
    watch: () => ({ close: () => undefined }),
    watchDebounceMs: 5,
    ...over,
  };
}

export const SPEC = JSON.stringify({
  meta: { version: "1" },
  nodes: [{ id: "a", type: "server" }],
});

export function iconPack(id = "mine", svg = "<svg viewBox='0 0 1 1'/>"): LoadedIconPack {
  return {
    manifest: {
      manifestVersion: 1,
      pack: {
        id,
        name: "Mine",
        version: "1.0.0",
        license: "MIT",
        source: "local",
        redistributable: true,
      },
      icons: [
        { id: "dot", aliases: [], category: "general", file: "svg/dot.svg", monochrome: true },
      ],
    },
    files: { "svg/dot.svg": svg },
  };
}
