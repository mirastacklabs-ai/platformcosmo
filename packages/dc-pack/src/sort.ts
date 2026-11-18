/**
 * Back-to-front ordering of axis-aligned parts. Part A is drawn before part B when A lies
 * entirely behind B along one iso axis (smaller x, smaller y, or lower z) and B is not
 * behind A along another. Ambiguous or overlapping pairs keep their authored order, so
 * authors control front details (LEDs on a bezel) while mirrored placement is re-sorted
 * correctly. Kahn's algorithm with index tie-breaking; cycles break on the lowest index.
 */
import type { ScenePart } from "@platformcosmo/core";

const EPS = 1e-6;

function behind(a: ScenePart, b: ScenePart): boolean {
  const ao = a.box.origin;
  const as = a.box.size;
  const bo = b.box.origin;
  return ao.x + as.x <= bo.x + EPS || ao.y + as.y <= bo.y + EPS || ao.z + as.z <= bo.z + EPS;
}

export function depthSort(parts: readonly ScenePart[]): ScenePart[] {
  const n = parts.length;
  const before: number[][] = Array.from({ length: n }, () => []);
  const indeg: number[] = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const ij = behind(parts[i]!, parts[j]!);
      const ji = behind(parts[j]!, parts[i]!);
      if (ij && !ji) {
        before[i]!.push(j);
        indeg[j]!++;
      } else if (ji && !ij) {
        before[j]!.push(i);
        indeg[i]!++;
      }
    }
  }
  const done: boolean[] = new Array<boolean>(n).fill(false);
  const out: ScenePart[] = [];
  for (let k = 0; k < n; k++) {
    let pick = -1;
    for (let i = 0; i < n; i++) {
      if (!done[i] && indeg[i] === 0) {
        pick = i;
        break;
      }
    }
    if (pick < 0) pick = done.findIndex((d) => !d);
    done[pick] = true;
    out.push(parts[pick]!);
    for (const j of before[pick]!) indeg[j]!--;
  }
  return out;
}
