/**
 * Depth copies (assemblies §9.4; track A1-2b): one DOM order for every epoch. SVG has one paint
 * order, so an item whose order changes between epochs gets a duplicate subtree (a copy) at its
 * new place; exactly one copy of an item is visible per epoch.
 *
 * Construction (`planCopies`):
 * 1. `D` = the full order of the first epoch's group (every item, copy 0).
 * 2. For each epoch `k` in time order: each visible item's position in `D` is the position of the
 *    copy it used last (copy 0 before its first use). The heaviest increasing subsequence of these
 *    positions in epoch-`k` order keeps its copies (weighted LIS, O(m log |D|); static items weigh
 *    more than all moving items together, so they are always kept and never get copies; ties go
 *    to the smaller item index, i.e. the smaller item key). Every other item, in epoch-`k` order,
 *    reuses an existing copy that lies between its predecessor (as placed) and the next kept item,
 *    else gets a new copy inserted right after its predecessor.
 * 3. Insertions never reorder existing entries, so every earlier epoch's embedding (and the wrap
 *    back to the first epoch) stays valid. Copy `c` of an item is visible exactly in the epochs
 *    whose embedding uses it.
 *
 * Pure and deterministic: inputs are item indices (sorted by key by the caller), all iteration is
 * by index, every tie is broken by index.
 */

/** `__c<k>` copy key of copy `k` of an item (copy 0 is the item key itself). */
export const copyKey = (item: string, copy: number): string =>
  copy > 0 ? `${item}__c${copy}` : item;

const COPY_RE = /^(.*)__c([1-9][0-9]*)$/;

/** Inverse of `copyKey` (spec ids never contain `_`, so the suffix is unambiguous). */
export function parseCopyKey(key: string): { readonly item: string; readonly copy: number } {
  const m = COPY_RE.exec(key);
  return m === null ? { item: key, copy: 0 } : { item: m[1] as string, copy: Number(m[2]) };
}

export interface CopyPlan {
  /** The one DOM order, back to front: `[item, copy]`. */
  readonly dom: readonly (readonly [number, number])[];
  /** Per epoch, parallel to its order: the copy each entry uses. */
  readonly use: readonly (readonly number[])[];
  /** Copies per item (≥ 1). */
  readonly copies: readonly number[];
  /** Copies beyond the first, over all items. */
  readonly extra: number;
}

export type CopyPlanResult =
  | { readonly ok: true; readonly plan: CopyPlan }
  /** More than `maxExtra` copies would be needed (`extra` counts up to the first one over). */
  | { readonly ok: false; readonly reason: "budget"; readonly extra: number }
  /** A static item would need a copy (its order is not the same in every epoch). */
  | { readonly ok: false; readonly reason: "static"; readonly item: number };

/**
 * Plans the copies of `n` items for `epochs` (each an order of distinct item indices, back to
 * front, visible items only). `initial` is a full order of all `n` items of which `epochs[0]` is
 * a subsequence. `isStatic(i)`: the item never moves in the loop. `maxExtra`: copies allowed
 * beyond the first of each item.
 */
export function planCopies(
  n: number,
  initial: readonly number[],
  epochs: readonly (readonly number[])[],
  isStatic: (i: number) => boolean,
  maxExtra: number,
): CopyPlanResult {
  // D as entries; pos[item][copy] = index in D.
  let dom: [number, number][] = initial.map((i) => [i, 0]);
  const pos: number[][] = Array.from({ length: n }, () => []);
  const reindex = (): void => {
    dom.forEach(([i, c], q) => {
      pos[i]![c] = q;
    });
  };
  reindex();
  const cur = new Int32Array(n); // copy used last (0 before the first use)
  const copies = new Int32Array(n).fill(1);
  let extra = 0;
  const heavy = n + 1;
  const use: number[][] = [];

  for (const order of epochs) {
    const m = order.length;
    const p = order.map((i) => pos[i]![cur[i]!]!);
    const keep = heaviestIncreasing(
      p,
      order.map((i) => (isStatic(i) ? heavy : 1)),
      order,
      dom.length,
    );
    // Next kept position after each index (Infinity at the end).
    const nextKept = new Array<number>(m + 1);
    nextKept[m] = Infinity;
    for (let q = m - 1; q >= 0; q--) nextKept[q] = keep[q] ? p[q]! : nextKept[q + 1]!;
    // Pending insertions per D index (after it; -1 = before everything), in insertion order.
    const inserts = new Map<number, [number, number][]>();
    let predIdx = -1;
    const used: number[] = [];
    for (let q = 0; q < m; q++) {
      const i = order[q]!;
      if (keep[q]) {
        used.push(cur[i]!);
        predIdx = p[q]!;
        continue;
      }
      if (isStatic(i)) return { ok: false, reason: "static", item: i };
      const succ = nextKept[q + 1]!;
      // Reuse: the existing copy with the smallest position in (pred, succ).
      let best = -1;
      for (let c = 0; c < copies[i]!; c++) {
        const at = pos[i]![c];
        if (at === undefined || at <= predIdx || at >= succ) continue;
        if (best < 0 || at < pos[i]![best]!) best = c;
      }
      if (best >= 0) {
        cur[i] = best;
        used.push(best);
        predIdx = pos[i]![best]!;
        continue;
      }
      if (++extra > maxExtra) return { ok: false, reason: "budget", extra };
      const c = copies[i]!;
      copies[i] = c + 1;
      cur[i] = c;
      used.push(c);
      const list = inserts.get(predIdx);
      if (list === undefined) inserts.set(predIdx, [[i, c]]);
      else list.push([i, c]);
      // predIdx stays: the next new copy goes right after this one (same anchor, later in list).
    }
    use.push(used);
    if (inserts.size > 0) {
      const next: [number, number][] = [...(inserts.get(-1) ?? [])];
      dom.forEach((e, q) => {
        next.push(e);
        const l = inserts.get(q);
        if (l !== undefined) next.push(...l);
      });
      dom = next;
      reindex();
    }
  }
  return { ok: true, plan: { dom, use, copies: [...copies], extra } };
}

/**
 * Flags of a heaviest strictly increasing subsequence of `pos` (distinct values in [0, size)).
 * Ties: the larger total weight, then the predecessor with the smaller item index; the end with
 * the smaller item index. Fenwick tree over positions for prefix maxima: O(m log size).
 */
function heaviestIncreasing(
  pos: readonly number[],
  weight: readonly number[],
  item: readonly number[],
  size: number,
): Uint8Array {
  const m = pos.length;
  const best = new Float64Array(m);
  const prev = new Int32Array(m).fill(-1);
  const tree = new Int32Array(size + 1).fill(-1); // index into the sequence, -1 empty
  const better = (a: number, b: number): boolean =>
    b < 0 || best[a]! > best[b]! || (best[a] === best[b] && item[a]! < item[b]!);
  for (let q = 0; q < m; q++) {
    let top = -1;
    for (let x = pos[q]!; x > 0; x -= x & -x) {
      const c = tree[x]!;
      if (c >= 0 && better(c, top)) top = c;
    }
    best[q] = weight[q]! + (top >= 0 ? best[top]! : 0);
    prev[q] = top;
    for (let x = pos[q]! + 1; x <= size; x += x & -x) {
      const c = tree[x]!;
      if (c < 0 || better(q, c)) tree[x] = q;
    }
  }
  let end = -1;
  for (let q = 0; q < m; q++) if (better(q, end)) end = q;
  const keep = new Uint8Array(m);
  for (let q = end; q >= 0; q = prev[q]!) keep[q] = 1;
  return keep;
}
