/**
 * Test helper (D-4a, §7.4): the leader labels a frame SHOWS and where, measured from the drawn
 * model (each label group's pill rect and leader path) and the frame state at `t` (the label's
 * translation and opacity, and the placement of the close-up level it sits in), independent of
 * the renderer's own label bookkeeping. With the frame's camera window and the caption rect it
 * tells whether a visible label is cut or covered.
 */
interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
interface El {
  readonly tag: string;
  readonly attrs?: Readonly<Record<string, string | number>> | null;
  readonly children?: readonly unknown[];
}
interface FrameState {
  readonly transforms: Readonly<Record<string, string>>;
  readonly opacity: Readonly<Record<string, number>>;
}
export interface LabelModel {
  readonly viewBox: Rect;
  readonly captionRect?: Rect;
  readonly layers: Readonly<Record<string, readonly unknown[]>>;
  readonly assembly?: {
    frameAt(t: number): FrameState;
    readonly levels?: readonly { readonly group: string }[];
  };
}

const isEl = (n: unknown): n is El => typeof n === "object" && n !== null && "tag" in n;
const num = (v: unknown): number => Number(v ?? 0);

/** `translate(x y)` or `matrix(s 0 0 s tx ty)` as [s, tx, ty]. */
function affine(tf: string | undefined): [number, number, number] {
  if (tf === undefined) return [1, 0, 0];
  const t = /translate\(([-\d.e]+)[ ,]+([-\d.e]+)\)/.exec(tf);
  if (t) return [1, Number(t[1]), Number(t[2])];
  const m =
    /matrix\(([-\d.e]+)[ ,]+[-\d.e]+[ ,]+[-\d.e]+[ ,]+[-\d.e]+[ ,]+([-\d.e]+)[ ,]+([-\d.e]+)\)/.exec(
      tf,
    );
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [1, 0, 0];
}

/** The box of a label group's pill rects and leader paths, in its own coordinates. */
function boxOf(g: El): Rect | undefined {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const add = (x: number, y: number): void => {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  };
  const walk = (n: unknown): void => {
    if (!isEl(n)) return;
    if (n.tag === "rect") {
      const x = num(n.attrs?.x);
      const y = num(n.attrs?.y);
      add(x, y);
      add(x + num(n.attrs?.width), y + num(n.attrs?.height));
    } else if (n.tag === "path") {
      const d = String(n.attrs?.d ?? "");
      for (const m of d.matchAll(/[ML]\s*([-\d.e]+)[ ,]+([-\d.e]+)/g))
        add(Number(m[1]), Number(m[2]));
    }
    for (const c of n.children ?? []) walk(c);
  };
  walk(g);
  return x1 >= x0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : undefined;
}

/** Leader labels visible (opacity above 0.01) at `t`, with their box in the main camera's world. */
export function visibleLabels(m: LabelModel, t: number): { id: string; rect: Rect }[] {
  const A = m.assembly;
  if (A === undefined) return [];
  const st = A.frameAt(t);
  const levels = new Set((A.levels ?? []).map((l) => l.group));
  const out: { id: string; rect: Rect }[] = [];
  const walk = (
    nodes: readonly unknown[],
    level: [number, number, number],
    levelOpacity: number,
  ) => {
    for (const n of nodes) {
      if (!isEl(n)) continue;
      const id = typeof n.attrs?.id === "string" ? n.attrs.id : undefined;
      if (id !== undefined && levels.has(id)) {
        walk(n.children ?? [], affine(st.transforms[id]), st.opacity[id] ?? 0);
        continue;
      }
      if (id !== undefined && id.includes("-pl_") && !id.endsWith("__top")) {
        const op = (st.opacity[id] ?? num(n.attrs?.opacity ?? 1)) * levelOpacity;
        const box = boxOf(n);
        if (op > 0.01 && box !== undefined) {
          const [, tx, ty] = affine(st.transforms[id] ?? String(n.attrs?.transform ?? ""));
          const [s, lx, ly] = level;
          out.push({
            id,
            rect: {
              x: s * (box.x + tx) + lx,
              y: s * (box.y + ty) + ly,
              width: s * box.width,
              height: s * box.height,
            },
          });
        }
        continue;
      }
      walk(n.children ?? [], level, levelOpacity);
    }
  };
  walk(m.layers.labels ?? [], [1, 0, 0], 1);
  walk(m.layers.overlay ?? [], [1, 0, 0], 1);
  return out;
}

/** Visible labels the window `v` (the frame's view box) cuts or the caption covers. */
export function badLabels(m: LabelModel, t: number, v: Rect | undefined): string[] {
  const w = v ?? m.viewBox;
  const s = m.viewBox.width / w.width;
  const cap = m.captionRect;
  const c =
    cap === undefined
      ? undefined
      : {
          x: w.x + (cap.x - m.viewBox.x) / s,
          y: w.y + (cap.y - m.viewBox.y) / s,
          width: cap.width / s,
          height: cap.height / s,
        };
  const hit = (a: Rect, b: Rect): boolean =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  const out: string[] = [];
  for (const l of visibleLabels(m, t)) {
    const q = l.rect;
    if (!hit(q, w)) continue;
    const inside =
      q.x >= w.x - 0.5 &&
      q.y >= w.y - 0.5 &&
      q.x + q.width <= w.x + w.width + 0.5 &&
      q.y + q.height <= w.y + w.height + 0.5;
    if (!inside) out.push(`${l.id} cut`);
    else if (c !== undefined && hit(q, c)) out.push(`${l.id} under the caption`);
  }
  return out;
}
