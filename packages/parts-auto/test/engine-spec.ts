import { engineLayout } from "../src/index.js";

type V3 = readonly [number, number, number];

/** The engine spec from the layout: default sizes, a three-stage explode, as the skill writes it. */
export function engineSpec(n: number): unknown {
  const L = engineLayout(n);
  const part = (id: string, shape: string, at: V3, size?: V3, extra: object = {}): object => ({
    id,
    shape,
    at,
    ...(size ? { size } : {}),
    ...extra,
  });
  const pr = Array.from({ length: n }, (_, i) => ({
    id: `pr-${i + 1}`,
    label: `Piston and rod ${i + 1}`,
    parts: [
      part("rod", "auto:rod", L.at.rod[i]!, L.size.rod),
      part("piston", "auto:piston", L.at.piston[i]!, L.size.piston),
    ],
  }));
  return {
    $schema: "https://platformcosmo.io/schema/v1.json",
    meta: { version: "1", title: "Default engine" },
    assemblies: [
      {
        id: "engine",
        units: "mm",
        parts: [
          part("block", "auto:block-i4", L.at.block, undefined, { params: { cylinders: n } }),
          part("crankshaft", "auto:crankshaft", L.at.crankshaft, undefined, {
            params: { cylinders: n },
          }),
          part("oil-pan", "auto:oil-pan", L.at["oil-pan"]),
          part("head-gasket", "plate", L.at["head-gasket"], L.size["head-gasket"], {
            tone: "muted",
          }),
          part("head", "auto:head", L.at.head, undefined, { params: { cylinders: n } }),
          part("valve-cover", "auto:valve-cover", L.at["valve-cover"], undefined, {
            params: { cylinders: n },
          }),
          part("intake", "auto:intake", L.at.intake, undefined, { params: { cylinders: n } }),
          part("exhaust", "auto:exhaust", L.at.exhaust, undefined, { params: { cylinders: n } }),
          ...pr,
        ],
        programs: [
          {
            id: "teardown",
            stages: [
              {
                label: "Top end",
                parts: ["valve-cover", "head", "head-gasket", "intake", "exhaust"],
                direction: "lift",
                overrides: { intake: { direction: "+y" }, exhaust: { direction: "-y" } },
              },
              { label: "Pistons and rods", parts: ["pr-*"], direction: "+z" },
              {
                label: "Crankshaft and oil pan",
                parts: ["crankshaft", "oil-pan"],
                direction: "-z",
              },
            ],
          },
        ],
        program: "teardown",
      },
    ],
    steps: [
      { caption: "Assembled" },
      { caption: "Top end", assembly: [{ explode: "engine", to: 1 }] },
      { caption: "Pistons", assembly: [{ explode: "engine", to: 2 }] },
      { caption: "Crankshaft", assembly: [{ explode: "engine", to: 3 }] },
      { caption: "Back", assembly: [{ implode: "engine" }] },
    ],
  };
}
