/**
 * Byte identity of every 1.1 DC spec (assemblies.md 8.1): the fragment `buildScene` returns is
 * pinned by hash, taken before assembly mode existed, and calling `buildAssembly` (for any rack)
 * must not change a single byte of it. Rendered output (gallery + visual goldens) is pinned
 * separately by `check:gallery` and `tests/visual`.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { PlatformCosmoSpec } from "@platformcosmo/core";
import { dcPack, slotTypes, equipmentTypes } from "../src/index.js";

const spec = (extra: Record<string, unknown>): PlatformCosmoSpec =>
  ({ meta: { version: "1" }, ...extra }) as unknown as PlatformCosmoSpec;

const server = (at: number, id?: string): Record<string, unknown> => ({
  ...(id ? { id } : {}),
  at,
  type: "server-1u",
});

const example = (name: string): PlatformCosmoSpec =>
  JSON.parse(
    readFileSync(new URL(`../../../examples/${name}`, import.meta.url), "utf8"),
  ) as PlatformCosmoSpec;

/** Two facing rows around a cold aisle (mirrored), a hot aisle, equipment and cables. */
const hall = (): PlatformCosmoSpec =>
  spec({
    racks: [
      { id: "a1", slots: [{ at: 1, type: "switch-tor", id: "tor" }, server(2), server(3, "s3")] },
      { id: "a2", u: 45, pdu: "dual", slots: [server(1), { at: 5, type: "storage-flash" }] },
      {
        id: "b1",
        u: 48,
        rearDoorHeatExchanger: true,
        slots: [server(1), { at: 10, type: "gpu-node" }],
      },
      { id: "b2", slots: [{ at: 1, type: "switch-spine" }] },
    ],
    equipment: [
      { id: "ups1", type: "ups" },
      { id: "pdu1", type: "pdu-floor" },
      { id: "crah1", type: "crah" },
    ],
    rows: [
      { id: "row-a", label: "Row A", members: ["a1", "a2"] },
      { id: "row-b", members: ["b1", "b2"] },
    ],
    aisles: [
      { id: "cold-1", kind: "cold", rows: ["row-a", "row-b"], contained: true },
      { id: "hot-1", kind: "hot", rows: ["row-b"] },
    ],
    cables: [
      { from: "a1/tor", to: "b2/u1", kind: "fiber" },
      { from: "a1/u2", to: "a1/tor", kind: "network", label: "uplink" },
      { from: "ups1", to: "pdu1", kind: "power", id: "feed" },
      { from: "pdu1", to: "a1", kind: "power" },
    ],
    facility: { raisedFloor: true, perforatedTiles: true, cableTrays: "overhead" },
  });

/** One slot of every device type, one piece of every equipment type. */
const everything = (): PlatformCosmoSpec => {
  let at = 1;
  const slots = slotTypes.map((type) => {
    const s = { at, type };
    at += type === "blade-chassis" ? 10 : type === "gpu-node" || type === "server-4u" ? 4 : 2;
    return s;
  });
  return spec({
    racks: [{ id: "all", u: 48, slots }],
    equipment: equipmentTypes.map((type) => ({ id: `e-${type}`, type })),
  });
};

/** 1.2 fields on racks are ignored by `buildScene` (assemblies.md 19.1). */
const loaded = (): PlatformCosmoSpec =>
  spec({
    racks: [
      {
        id: "r1",
        label: "Rack R1",
        slots: [
          { id: "tor", at: 41, type: "switch-tor" },
          { id: "gpu", at: 30, type: "gpu-node", size: 4 },
          { id: "c1", at: 20, type: "server-2u", assembly: "srv" },
          { id: "pdu", at: 1, type: "pdu-1u" },
        ],
        programs: [
          { id: "service", stages: [{ parts: ["frame/role:cover"], direction: "drawer" }] },
        ],
      },
    ],
    steps: [{ assembly: [{ explode: "r1", program: "service" }] }],
  });

const hash = (s: PlatformCosmoSpec): string =>
  createHash("sha256")
    .update(JSON.stringify(dcPack.buildScene(s)))
    .digest("hex");

const PINS: Record<string, [() => PlatformCosmoSpec, string]> = {
  "examples/dc-hall": [
    () => example("dc-hall.cosmo.json"),
    "51a490284d24ae1856e2cce070e28a297585ac581548bf555c8c2dc58144802b",
  ],
  hall: [hall, "a4c97135920a8470165bcd6629a292687825f9a87a34b22e186cf8bd99b8b8aa"],
  everything: [everything, "0508819791aba119dd15df71482805f4f2989b00c3bec0849329020a59fc5e9e"],
  loaded: [loaded, "a5a03e7f98f490072be3f31b87367f841c6b95d2ccc4af8aad41b21440543ff3"],
  empty: [
    () => spec({ racks: [{ id: "p" }, { id: "q", u: 45 }] }),
    "b9a2d7aafdab2bf6c7593362ec4437ac1159654fd93094cca2084ea28c249ece",
  ],
};

describe("1.1 DC specs are byte-identical", () => {
  for (const [name, [make, expected]] of Object.entries(PINS)) {
    it(`${name}: buildScene output is unchanged`, () => {
      expect(hash(make())).toBe(expected);
    });

    it(`${name}: buildAssembly does not touch the fragment`, () => {
      const s = make();
      const before = hash(s);
      const f = dcPack.buildScene(s);
      for (const r of s.racks ?? []) {
        dcPack.buildAssembly?.(s, r.id, f, {});
      }
      expect(JSON.stringify(f)).toBe(JSON.stringify(dcPack.buildScene(s)));
      expect(hash(s)).toBe(before);
    });
  }
});
