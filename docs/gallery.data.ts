import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface GalleryItem {
  name: string;
  title: string;
  description: string;
  group: "launch" | "datacenter" | "provider";
  /** True when scripts/prepare.mjs rendered a preview. */
  preview: boolean;
  spec: string;
}

declare const data: GalleryItem[];
export { data };

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const PROVIDER_PREFIXES = ["aws:", "azure:", "gcp:"];

interface SpecShape {
  meta?: { title?: string; description?: string };
  nodes?: { icon?: string }[];
  racks?: unknown;
  equipment?: unknown;
}

function groupOf(spec: SpecShape): GalleryItem["group"] {
  if (spec.nodes?.some((n) => PROVIDER_PREFIXES.some((p) => n.icon?.startsWith(p)))) {
    return "provider";
  }
  return spec.racks !== undefined || spec.equipment !== undefined ? "datacenter" : "launch";
}

export default {
  watch: [here("../examples/*.cosmo.json")],
  load(): GalleryItem[] {
    const dir = here("../examples/");
    return readdirSync(dir)
      .filter((f) => f.endsWith(".cosmo.json"))
      .sort()
      .map((f) => {
        const name = f.replace(/\.cosmo\.json$/, "");
        const text = readFileSync(dir + f, "utf8");
        let spec: SpecShape;
        try {
          spec = JSON.parse(text) as SpecShape;
        } catch (e) {
          throw new Error(`examples/${f}: ${(e as Error).message}`, { cause: e });
        }
        const meta = spec.meta;
        return {
          name,
          title: meta?.title ?? name,
          description: meta?.description ?? "",
          group: groupOf(spec),
          preview: existsSync(here(`./public/gallery/${name}.svg`)),
          spec: text,
        } satisfies GalleryItem;
      });
  },
};
