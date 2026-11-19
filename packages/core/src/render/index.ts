import { createHash } from "node:crypto";
import type { PlatformCosmoSpec } from "../schema/types.gen.js";
import type {
  Animator,
  Diagnostic,
  EmitFn,
  ExportFn,
  OptimizeFn,
  OutputKind,
  RasterizeFn,
  RenderFn,
  RenderModel,
  RenderOptions,
  RenderOutput,
  RenderResult,
  SceneGraph,
  ThemeTokens,
  ValidateFn,
  BuildSceneFn,
} from "../contracts/index.js";
import { createAnimator } from "../anim/index.js";
import { countElements, emit, themeVars } from "../emit/index.js";
import { exportOutputs, rasterize } from "../export/index.js";
import { validateRenderOptions } from "../export/options.js";
import { optimize } from "../optimize/index.js";
import { buildScene } from "../scene/index.js";
import { validate } from "../schema/index.js";
import { buildModel, buildModelWithDiagnostics, inputsOf } from "./model.js";

export { buildModel } from "./model.js";
export type { ModelInputs } from "./model.js";
export { specSchema } from "./spec-schema.js";

/** Stage implementations `render()` orchestrates; tests and other tracks can swap any of them. */
export interface RenderDeps {
  readonly validate: ValidateFn;
  readonly buildScene: BuildSceneFn;
  readonly createAnimator: () => Animator;
  readonly exportOutputs: ExportFn;
  readonly rasterize: RasterizeFn;
  readonly emit: EmitFn;
  readonly optimize: OptimizeFn;
  /** Option checks; defaults to `validateRenderOptions` (export/options.ts). */
  readonly validateOptions?: (options: RenderOptions) => readonly Diagnostic[];
}

const VARIANT_RE = /^-[a-z0-9]{1,7}$/;
const ELEMENT_BUDGET = 5000;
const DC_KEYS = ["racks", "equipment", "rows", "aisles", "cables", "facility"] as const;

function err(code: string, path: string, message: string, suggestion?: string): Diagnostic {
  return { severity: "error", code, path, message, ...(suggestion ? { suggestion } : {}) };
}

/** RFC 8785 (JCS) canonical JSON. Numbers use ECMAScript serialization, which JCS mandates. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("cannot canonicalize a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  }
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  throw new Error(`cannot canonicalize ${typeof value}`);
}

/** `pc-` + first 8 hex chars of SHA-256 over the JCS of the spec and the render-affecting options. */
export function defaultIdPrefix(
  spec: unknown,
  options: {
    readonly theme: ThemeTokens;
    readonly darkTheme?: ThemeTokens;
    readonly font: string;
    readonly speed: number;
    readonly optimize: boolean;
    /** Only hashed when not the default `smil`, so existing prefixes stay unchanged (D32). */
    readonly motion?: string;
  },
): string {
  const { motion, ...rest } = options;
  const hashed = motion !== undefined && motion !== "smil" ? { ...rest, motion } : rest;
  const digest = createHash("sha256")
    .update(canonicalJson({ spec, options: hashed }))
    .digest("hex");
  return `pc-${digest.slice(0, 8)}`;
}

/** Option checks live in Track B's `export/options.ts`; kept under this name for callers and tests. */
export const validateOptions = validateRenderOptions;

function sortDiagnostics(d: readonly Diagnostic[]): Diagnostic[] {
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return [...d].sort((a, b) => cmp(a.path, b.path) || cmp(a.code, b.code));
}

function hasDcContent(spec: unknown): boolean {
  if (!spec || typeof spec !== "object") return false;
  const o = spec as Record<string, unknown>;
  return DC_KEYS.some((k) => {
    const v = o[k];
    return Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null;
  });
}

function byteLength(data: string | Uint8Array): number {
  return typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.byteLength;
}

/**
 * Same model with every id re-prefixed `prefix + variant` (ExportFn `deps.withVariant`).
 * `variant` must match `^-[a-z0-9]{1,7}$`. Works for any model made by `buildModel`.
 */
export function withVariant(model: RenderModel, variant: string): RenderModel {
  if (!VARIANT_RE.test(variant)) throw new Error(`invalid id variant: ${variant}`);
  const inputs = inputsOf(model);
  if (!inputs) throw new Error("withVariant: model was not built by buildModel");
  return buildModel({ ...inputs, prefix: `${model.ids.prefix}${variant}` });
}

export function createRender(deps: RenderDeps): RenderFn {
  return async function render(spec: unknown, options: RenderOptions = {}): Promise<RenderResult> {
    const emptyStats = { elements: 0, bytes: {} };
    const fail = (d: readonly Diagnostic[], scene?: SceneGraph): RenderResult => ({
      outputs: [],
      diagnostics: sortDiagnostics(d),
      stats: emptyStats,
      ...(scene ? { scene } : {}),
    });

    const optionDiagnostics = (deps.validateOptions ?? validateRenderOptions)(options);
    if (optionDiagnostics.some((d) => d.severity === "error")) return fail(optionDiagnostics);
    const kinds: readonly OutputKind[] = options.outputs ?? ["animated"];
    if (kinds.includes("mp4") && !options.video?.encoder) {
      throw new Error("render: the mp4 output requires options.video.encoder");
    }

    const diagnostics: Diagnostic[] = [...optionDiagnostics];
    try {
      return await run();
    } catch (e) {
      return fail([
        ...diagnostics,
        err("render/internal-error", "", `Unexpected error: ${(e as Error).message}`),
      ]);
    }

    async function run(): Promise<RenderResult> {
      const report = deps.validate(spec, {
        ...(options.icons ? { icons: options.icons } : {}),
        ...(options.dc ? { dc: options.dc } : {}),
      });
      diagnostics.push(...report.diagnostics);
      if (!options.dc && hasDcContent(spec)) {
        diagnostics.push(
          err(
            "render/dc-pack-required",
            "",
            "The spec has data-center content but no DC pack was provided.",
            "Pass the @platformcosmo/dc-pack `dcPack` as options.dc.",
          ),
        );
      }
      if (!report.valid || !report.spec || diagnostics.some((d) => d.severity === "error")) {
        return fail(diagnostics);
      }
      const parsed: PlatformCosmoSpec = report.spec;

      const themeId = parsed.canvas?.theme ?? "light";
      const theme = options.theme ?? options.themes?.get(themeId);
      if (!theme) {
        return fail([
          ...diagnostics,
          err(
            "render/theme-unavailable",
            "/canvas/theme",
            `Theme "${themeId}" is not available.`,
            options.themes
              ? `Available: ${options.themes.list().join(", ")}`
              : "Pass options.theme or options.themes.",
          ),
        ]);
      }
      const darkTheme =
        options.darkTheme === null
          ? undefined
          : (options.darkTheme ??
            (theme.colorScheme === "light" ? options.themes?.get("dark") : undefined));

      // Custom themes are untrusted: reject bad values here so emit never throws on user input.
      const themePath = options.theme ? "/theme" : "/canvas/theme";
      const darkPath = options.darkTheme ? "/darkTheme" : "/canvas/theme";
      for (const [t, path] of [
        [theme, themePath],
        [darkTheme, darkPath],
      ] as const) {
        if (!t) continue;
        try {
          themeVars(t);
        } catch (e) {
          return fail([
            ...diagnostics,
            err("render/invalid-theme", path, `The theme is invalid: ${(e as Error).message}.`),
          ]);
        }
      }

      const scene = deps.buildScene(parsed, {
        labelSize: theme.font.label,
        ...(options.icons ? { icons: options.icons } : {}),
        ...(options.dc ? { dc: options.dc } : {}),
      });
      diagnostics.push(...scene.diagnostics);
      if (diagnostics.some((d) => d.severity === "error")) return fail(diagnostics, scene);

      const font = options.font ?? "embed";
      const speed = options.speed ?? 1;
      const motion = options.motion ?? "smil";
      const doOptimize = options.optimize !== false;
      const prefix =
        options.idPrefix ??
        defaultIdPrefix(spec, {
          theme,
          ...(darkTheme ? { darkTheme } : {}),
          font,
          speed,
          optimize: doOptimize,
          ...(motion === "css" ? { motion } : {}),
        });

      const built = buildModelWithDiagnostics({
        scene,
        theme,
        ...(darkTheme ? { darkTheme } : {}),
        font,
        prefix,
        ...(options.icons ? { icons: options.icons } : {}),
      });
      diagnostics.push(...built.diagnostics);
      const model = built.model;

      const name = options.name ?? "diagram";
      const finish = (svg: string) => (doOptimize ? deps.optimize(svg) : svg);
      const animator = deps.createAnimator();
      const outputs: RenderOutput[] = [];
      let elements = 0;

      if (kinds.includes("animated")) {
        const layer = animator.animate(model, { speed, motion, mode: "loop" });
        const raw = deps.emit(model, layer, { font });
        elements = countElements(raw);
        outputs.push({
          kind: "animated",
          path: `${name}.svg`,
          mime: "image/svg+xml",
          data: finish(raw),
        });
      }

      const others = kinds.filter((k) => k !== "animated");
      if (others.length > 0) {
        const exported = await deps.exportOutputs(
          model,
          others,
          {
            animator,
            emit: deps.emit,
            optimize: finish,
            rasterize: deps.rasterize,
            withVariant,
          },
          { ...options, idPrefix: prefix, name },
        );
        outputs.push(...exported.outputs);
        diagnostics.push(...exported.diagnostics);
        if (elements === 0) {
          const first = exported.outputs.find((o) => typeof o.data === "string");
          if (first) elements = countElements(first.data as string);
        }
      }

      if (elements > ELEMENT_BUDGET) {
        diagnostics.push({
          severity: "warning",
          code: "budget/elements",
          path: "",
          message: `The diagram has ${elements} SVG elements (budget ${ELEMENT_BUDGET}).`,
          suggestion: "Split the diagram into several smaller ones.",
        });
      }

      const bytes: Record<string, number> = {};
      for (const o of outputs) bytes[o.path] = byteLength(o.data);
      const hasError = diagnostics.some((d) => d.severity === "error");
      return {
        outputs: hasError ? [] : outputs,
        diagnostics: sortDiagnostics(diagnostics),
        stats: hasError ? emptyStats : { elements, bytes },
        scene,
      };
    }
  };
}

export const render: RenderFn = createRender({
  validate,
  buildScene,
  createAnimator,
  exportOutputs,
  rasterize,
  emit,
  optimize,
});
