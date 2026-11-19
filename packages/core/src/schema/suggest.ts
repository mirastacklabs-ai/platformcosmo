/** Edit-distance helpers for "did you mean" suggestions (PLAN §5 validation layer 3). */

/** Optimal-string-alignment (Damerau-Levenshtein) distance. Pure, deterministic. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  // Three rolling rows (previous-previous, previous, current): O(min) memory, no |a|x|b| table.
  let pp = new Array<number>(bl + 1).fill(0);
  let prev = Array.from({ length: bl + 1 }, (_, j) => j);
  let cur = new Array<number>(bl + 1).fill(0);
  for (let i = 1; i <= al; i++) {
    cur[0] = i;
    for (let j = 1; j <= bl; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, pp[j - 2]! + 1);
      }
      cur[j] = v;
    }
    [pp, prev, cur] = [prev, cur, pp];
  }
  return prev[bl]!;
}

/** Inputs longer than this are never typos of a real name; compare only this prefix. */
export const MAX_COMPARE = 64;

/**
 * Candidates ranked by closeness to `input` (best first), limited to plausible typos:
 * distance <= max(1, floor(len / 3)) or one string containing the other (len >= 3).
 * Ties break alphabetically so output is deterministic.
 */
export function closestMatches(input: string, candidates: Iterable<string>, limit = 3): string[] {
  const needle = input.slice(0, MAX_COMPARE).toLowerCase();
  const scored: { c: string; s: number }[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (seen.has(c) || c === input) continue;
    seen.add(c);
    const hay = c.slice(0, MAX_COMPARE).toLowerCase();
    const max = Math.max(1, Math.floor(Math.max(needle.length, hay.length) / 3));
    const contains = needle.length >= 3 && (hay.includes(needle) || needle.includes(hay));
    // |len diff| is a lower bound on the distance: skip the table when it cannot be a typo
    const dist = Math.abs(needle.length - hay.length) > max ? max + 1 : editDistance(needle, hay);
    if (dist <= max) scored.push({ c, s: dist });
    else if (contains) scored.push({ c, s: max + 1 });
  }
  scored.sort((x, y) => x.s - y.s || (x.c < y.c ? -1 : x.c > y.c ? 1 : 0));
  return scored.slice(0, limit).map((x) => x.c);
}

export function closest(input: string, candidates: Iterable<string>): string | undefined {
  return closestMatches(input, candidates, 1)[0];
}

/** `Did you mean "x"?` or undefined. */
export function didYouMean(input: string, candidates: Iterable<string>): string | undefined {
  const m = closest(input, candidates);
  return m === undefined ? undefined : `Did you mean "${m}"?`;
}

/** JSON-quoted, truncated user text for diagnostic messages (never raw-interpolated). */
export function q(value: unknown, max = 64): string {
  const s = typeof value === "string" ? value : String(value);
  return JSON.stringify(s.length > max ? `${s.slice(0, max)}...` : s);
}
