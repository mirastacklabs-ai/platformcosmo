// Light, deterministic whitespace minification shared by gen-pack.mjs and the drift tests.
export const minify = (s) =>
  (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s)
    .replace(/<\?xml[\s\S]*?\?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/>\s+</g, "><")
    .replace(/\s+/g, " ")
    .replace(/ ?\/>/g, "/>")
    .trim();
