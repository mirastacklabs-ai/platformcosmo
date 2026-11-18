// Copy LICENSE and NOTICE into each package so published tarballs carry them.
import { copyFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

for (const d of readdirSync("packages", { withFileTypes: true })) {
  if (!d.isDirectory()) continue;
  for (const f of ["LICENSE", "NOTICE"]) copyFileSync(f, join("packages", d.name, f));
}
