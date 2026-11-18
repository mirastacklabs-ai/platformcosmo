/**
 * Small authoring kit for component builds. Builds are written in millimetres in a
 * component-local frame (origin = minimum corner, +y is the FRONT of the device, +z up)
 * and converted to world units here. Everything is generic geometry: boxes with theme
 * tones, no vendor shapes or marks.
 */
import type {
  DcBuildResult,
  DcPort,
  DcPortKind,
  PartTone,
  PrimitiveKind,
  ScenePart,
} from "@platformcosmo/core";
import { box, mm, vec } from "../units.js";

export class Kit {
  readonly parts: ScenePart[] = [];
  readonly ports: DcPort[] = [];

  constructor(
    readonly widthMm: number,
    readonly depthMm: number,
    readonly heightMm: number,
  ) {}

  /** Adds a part; coordinates are the minimum corner and extent, in mm. */
  part(
    id: string,
    primitive: PrimitiveKind,
    tone: PartTone,
    x: number,
    y: number,
    z: number,
    w: number,
    d: number,
    h: number,
  ): this {
    this.parts.push({ id, primitive, tone, box: box(mm(x), mm(y), mm(z), mm(w), mm(d), mm(h)) });
    return this;
  }

  /** Adds a port at a mm position (component-local). */
  port(id: string, kind: DcPortKind, x: number, y: number, z: number): this {
    this.ports.push({ id, kind, at: vec(mm(x), mm(y), mm(z)) });
    return this;
  }

  /** A row of `n` equal small parts along x on the front face. */
  row(
    prefix: string,
    n: number,
    tone: PartTone,
    x0: number,
    x1: number,
    z: number,
    w: number,
    h: number,
    depth = 6,
    primitive: PrimitiveKind = "cube",
  ): this {
    const pitch = n > 1 ? (x1 - x0 - w) / (n - 1) : 0;
    for (let i = 0; i < n; i++) {
      this.part(
        `${prefix}-${i}`,
        primitive,
        tone,
        x0 + i * pitch,
        this.depthMm - depth,
        z,
        w,
        depth,
        h,
      );
    }
    return this;
  }

  /** Front-face intake and rear exhaust airflow ports at mid height. */
  airflow(): this {
    this.port("intake", "airflow-in", this.widthMm / 2, this.depthMm, this.heightMm / 2);
    this.port("exhaust", "airflow-out", this.widthMm / 2, 0, this.heightMm / 2);
    return this;
  }

  /** Bounds cover the declared size and any part that sticks out of it (fans, pipes). */
  done(): DcBuildResult {
    let x = mm(this.widthMm);
    let y = mm(this.depthMm);
    let z = mm(this.heightMm);
    for (const p of this.parts) {
      x = Math.max(x, p.box.origin.x + p.box.size.x);
      y = Math.max(y, p.box.origin.y + p.box.size.y);
      z = Math.max(z, p.box.origin.z + p.box.size.z);
    }
    return { parts: this.parts, ports: this.ports, bounds: box(0, 0, 0, x, y, z) };
  }
}
