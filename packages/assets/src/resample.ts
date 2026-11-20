/** Resampling shared by shrink and locate (internal, not exported from the package). */
import { createRaster, type Raster } from "./raster.js";

/** Area-average resample to `nw` x `nh` (premultiplied accumulation). Callers validate the sizes. */
export function boxResample(r: Raster, nw: number, nh: number): Raster {
  const { width: w, height: h, data } = r;
  const sx = w / nw;
  const sy = h / nh;
  const area = sx * sy;
  const out = createRaster(nw, nh);
  const acc = new Float64Array(nw * 4);
  for (let oy = 0; oy < nh; oy++) {
    acc.fill(0);
    const y0 = oy * sy;
    const y1 = (oy + 1) * sy;
    for (let y = Math.floor(y0); y < Math.min(h, Math.ceil(y1)); y++) {
      const wy = Math.min(y + 1, y1) - Math.max(y, y0);
      if (wy <= 0) continue;
      for (let ox = 0; ox < nw; ox++) {
        const x0 = ox * sx;
        const x1 = (ox + 1) * sx;
        for (let x = Math.floor(x0); x < Math.min(w, Math.ceil(x1)); x++) {
          const wx = Math.min(x + 1, x1) - Math.max(x, x0);
          if (wx <= 0) continue;
          const wgt = wx * wy;
          const i = (y * w + x) * 4;
          const a = data[i + 3]!;
          acc[ox * 4] = acc[ox * 4]! + data[i]! * a * wgt;
          acc[ox * 4 + 1] = acc[ox * 4 + 1]! + data[i + 1]! * a * wgt;
          acc[ox * 4 + 2] = acc[ox * 4 + 2]! + data[i + 2]! * a * wgt;
          acc[ox * 4 + 3] = acc[ox * 4 + 3]! + a * wgt;
        }
      }
    }
    for (let ox = 0; ox < nw; ox++) {
      const a = acc[ox * 4 + 3]!;
      const o = (oy * nw + ox) * 4;
      if (a > 0) {
        out.data[o] = Math.round(acc[ox * 4]! / a);
        out.data[o + 1] = Math.round(acc[ox * 4 + 1]! / a);
        out.data[o + 2] = Math.round(acc[ox * 4 + 2]! / a);
        out.data[o + 3] = Math.round(a / area);
      }
    }
  }
  return out;
}

/** Bilinear resample (used for scales above 1). */
export function bilinear(r: Raster, nw: number, nh: number): Raster {
  const out = new Uint8Array(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    const fy = Math.min(r.height - 1, Math.max(0, ((y + 0.5) * r.height) / nh - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(r.height - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < nw; x++) {
      const fx = Math.min(r.width - 1, Math.max(0, ((x + 0.5) * r.width) / nw - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(r.width - 1, x0 + 1);
      const tx = fx - x0;
      for (let c = 0; c < 4; c++) {
        const v =
          r.data[(y0 * r.width + x0) * 4 + c]! * (1 - tx) * (1 - ty) +
          r.data[(y0 * r.width + x1) * 4 + c]! * tx * (1 - ty) +
          r.data[(y1 * r.width + x0) * 4 + c]! * (1 - tx) * ty +
          r.data[(y1 * r.width + x1) * 4 + c]! * tx * ty;
        out[(y * nw + x) * 4 + c] = Math.round(v);
      }
    }
  }
  return { width: nw, height: nh, data: out };
}
