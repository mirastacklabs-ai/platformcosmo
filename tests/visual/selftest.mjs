/** Self-check of the diff helpers (runs before the comparison): synthetic images, no CLI. */
import { compare, decodePng, encodePng } from "./png.mjs";

function image(w, h, fill) {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < data.length; i += 4) data.set(fill(i / 4), i);
  return { width: w, height: h, data };
}

const fail = (msg) => {
  console.error(`visual selftest FAILED: ${msg}`);
  process.exit(1);
};

const white = image(20, 10, () => [255, 255, 255, 255]);
if (compare(white, white).differing !== 0) fail("identical images differ");

const dot = image(20, 10, (p) => (p === 25 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
const r = compare(white, dot);
if (r.differing !== 1 || r.diff.data[25 * 4] !== 255) fail("a single changed pixel is not found");

const near = image(20, 10, () => [254, 255, 255, 255]);
if (compare(white, near).differing !== 0) fail("a 1-level difference is over the threshold");

if (
  compare(
    white,
    image(21, 10, () => [255, 255, 255, 255]),
  ).sameSize
)
  fail("size change missed");

const back = decodePng(encodePng(dot));
if (back.width !== 20 || compare(dot, back).differing !== 0) fail("PNG encode/decode round trip");

console.log("visual selftest ok");
