/**
 * Shape-pack registry wiring (assemblies.md section 5, like icon packs in DECISIONS D4): one
 * registry over every installed pack, so validation and render resolve `hw:`, `brick:` and
 * `auto:` shapes the same way. `dc:` shapes come from the DC pack (`RenderOptions.dc`), which
 * core consults for refs the registry does not name.
 */
import type { PartShapeDef, PartShapeRegistry } from "@platformcosmo/core";

/** Merges registries in precedence order; `list` is the sorted union (did-you-mean). */
export function combineRegistries(regs: readonly PartShapeRegistry[]): PartShapeRegistry {
  const refs = [...new Set(regs.flatMap((r) => r.list()))].sort();
  return {
    get(ref: string): PartShapeDef | undefined {
      for (const r of regs) {
        const d = r.get(ref);
        if (d !== undefined) return d;
      }
      return undefined;
    },
    list: () => refs,
  };
}
