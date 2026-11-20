/**
 * Linear wildcard matching for selector globs (`*` any run, `?` one character). Two pointers
 * with single-star backtracking: O(n * m) worst case, no regular expression, so adversarial
 * patterns such as `*a*a*a*a*b` cannot backtrack exponentially or polynomially.
 *
 * The segment alphabet check is the schema's own (selectors only contain `a-z 0-9 - * ?`), so
 * `*` and `?` match any character here: ids are already restricted by the schema.
 */
export function globMatch(pattern: string, text: string): boolean {
  if (!pattern.includes("*") && !pattern.includes("?")) return pattern === text;
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    const c = pattern.charCodeAt(p);
    if (p < pattern.length && c === 42 /* * */) {
      star = p++;
      mark = t;
    } else if (p < pattern.length && (c === 63 /* ? */ || c === text.charCodeAt(t))) {
      p++;
      t++;
    } else if (star >= 0) {
      p = star + 1;
      t = ++mark;
    } else return false;
  }
  while (pattern.charCodeAt(p) === 42) p++;
  return p === pattern.length;
}
