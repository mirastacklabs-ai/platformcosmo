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
const PROVIDER = new Set(["aws-three-tier", "azure-web-app", "gcp-data-pipeline"]);

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
        const meta = (JSON.parse(text) as { meta?: { title?: string; description?: string } }).meta;
        return {
          name,
          title: meta?.title ?? name,
          description: meta?.description ?? "",
          group: PROVIDER.has(name) ? "provider" : name === "dc-hall" ? "datacenter" : "launch",
          preview: existsSync(here(`./public/gallery/${name}.svg`)),
          spec: text,
        } satisfies GalleryItem;
      });
  },
};
