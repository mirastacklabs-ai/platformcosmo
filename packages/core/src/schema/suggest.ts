/** Edit-distance helpers for "did you mean" suggestions (PLAN §5 validation layer 3). */

/** Optimal-string-alignment (Damerau-Levenshtein) distance. Pure, deterministic. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  const d: number[][] = [];
  for (let i = 0; i <= al; i++) {
    const row = new Array<number>(bl + 1).fill(0);
    row[0] = i;
    d.push(row);
  }
  for (let j = 0; j <= bl; j++) d[0]![j] = j;
  for (let i = 1; i <= al; i++) {
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, d[i - 2]![j - 2]! + 1);
      }
      d[i]![j] = v;
    }
  }
  return d[al]![bl]!;
}

/**
 * Candidates ranked by closeness to `input` (best first), limited to plausible typos:
 * distance <= max(1, floor(len / 3)) or one string containing the other (len >= 3).
 * Ties break alphabetically so output is deterministic.
 */
export function closestMatches(input: string, candidates: Iterable<string>, limit = 3): string[] {
  const needle = input.toLowerCase();
  const scored: { c: string; s: number }[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (seen.has(c) || c === input) continue;
    seen.add(c);
    const hay = c.toLowerCase();
    const dist = editDistance(needle, hay);
    const max = Math.max(1, Math.floor(Math.max(needle.length, hay.length) / 3));
    const contains = needle.length >= 3 && (hay.includes(needle) || needle.includes(hay));
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
