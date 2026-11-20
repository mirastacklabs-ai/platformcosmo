import type { AssetSource } from "../../contracts/index.js";
import type { SpecSource } from "../../schema/types.gen.js";

const SOURCE_KEYS = ["document", "page", "figure", "license", "attribution", "url"] as const;

/** Provenance of a spec `source` as an `AssetSource` (known keys only); undefined when empty. */
export function toSource(s: SpecSource | undefined): AssetSource | undefined {
  if (s === undefined) return undefined;
  const out: Record<string, unknown> = {};
  for (const k of SOURCE_KEYS) if (s[k] !== undefined) out[k] = s[k];
  return Object.keys(out).length > 0 ? (out as AssetSource) : undefined;
}
