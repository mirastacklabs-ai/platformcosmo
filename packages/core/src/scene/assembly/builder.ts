/**
 * Programmatic spec builders (assemblies design §16; contract `AssemblyBuilders`).
 *
 * Pure: no I/O, no scene, no defaults. Every builder produces plain spec JSON typed by
 * `schema/types.gen.ts`; `toJSON()` returns a fresh deep copy each call (determinism: same calls,
 * same JSON; later builder calls never mutate an earlier result). Nothing here throws: an
 * incomplete or wrong spec (empty assembly, duplicate ids, bad selectors) is reported by
 * `validate`, not by the builder. Equality is defined on RFC 8785 canonical JSON, so key order is
 * not significant; arrays keep call order.
 */
import type {
  AssemblyBuilder,
  AssemblyBuilders,
  BuildProgramBuilder,
  FigureBuilder,
  PartsBuilder,
  ProgramBuilder,
  SpecBuilder,
} from "../../contracts/assembly.js";
import type {
  PlatformCosmoSpec,
  SpecAssembly,
  SpecBuildProgram,
  SpecBuildStep,
  SpecExplodeProgram,
  SpecFigure,
  SpecFigurePart,
  SpecFigureStage,
  SpecImage,
  SpecPart,
  SpecProgram,
  SpecRack,
  SpecStage,
  SpecStep,
  SpecStoryboard,
} from "../../schema/types.gen.js";

type Json = unknown;

/** Deep copy of plain JSON data (specs hold only objects, arrays, strings, numbers, booleans). */
function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map(clone) as unknown as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(value as Record<string, Json>)) out[k] = clone(v);
    return out as T;
  }
  return value;
}

/** A builder (anything with `toJSON()`) or a plain spec object, as a fresh plain object. */
const resolve = <T>(v: T | { toJSON(): T }): T =>
  clone(
    typeof (v as { toJSON?: unknown }).toJSON === "function"
      ? (v as { toJSON(): T }).toJSON()
      : (v as T),
  );

class PartsImpl implements PartsBuilder {
  protected readonly parts: SpecPart[] = [];
  protected readonly programs: SpecProgram[] = [];

  part(id: string, fields: Omit<SpecPart, "id"> = {}): this {
    this.parts.push({ ...clone(fields), id } as SpecPart);
    return this;
  }

  sub(id: string, fields: Omit<SpecPart, "id" | "parts">, build: (b: PartsBuilder) => void): this {
    const child = new PartsImpl();
    build(child);
    this.parts.push({ ...clone(fields), id, ...child.collect() } as SpecPart);
    return this;
  }

  program(program: SpecProgram | ProgramBuilder | BuildProgramBuilder): this {
    this.programs.push(resolve<SpecProgram>(program));
    return this;
  }

  /** `parts` and `programs` fields, each present only when non-empty (no defaults). */
  protected collect(): { parts?: SpecPart[]; programs?: SpecProgram[] } {
    const out: { parts?: SpecPart[]; programs?: SpecProgram[] } = {};
    if (this.parts.length) out.parts = clone(this.parts);
    if (this.programs.length) out.programs = clone(this.programs);
    return out;
  }
}

class AssemblyImpl extends PartsImpl implements AssemblyBuilder {
  constructor(
    private readonly id: string,
    private readonly fields: Omit<SpecAssembly, "id" | "parts" | "programs">,
  ) {
    super();
  }

  toJSON(): SpecAssembly {
    // An assembly with no parts is invalid; emit `parts: []` so `validate` reports it.
    return { ...clone(this.fields), id: this.id, parts: [], ...this.collect() } as SpecAssembly;
  }
}

class ExplodeImpl implements ProgramBuilder {
  private readonly stages: SpecStage[] = [];
  constructor(
    private readonly id: string,
    private readonly fields: Omit<SpecExplodeProgram, "id" | "stages" | "kind">,
  ) {}

  stage(stage: SpecStage): this {
    this.stages.push(clone(stage));
    return this;
  }

  toJSON(): SpecExplodeProgram {
    return { ...clone(this.fields), id: this.id, stages: clone(this.stages) } as SpecExplodeProgram;
  }
}

class BuildImpl implements BuildProgramBuilder {
  private readonly steps: SpecBuildStep[] = [];
  constructor(
    private readonly id: string,
    private readonly fields: Omit<SpecBuildProgram, "id" | "steps" | "kind">,
  ) {}

  step(step: SpecBuildStep): this {
    this.steps.push(clone(step));
    return this;
  }

  toJSON(): SpecBuildProgram {
    return {
      ...clone(this.fields),
      id: this.id,
      kind: "build",
      steps: clone(this.steps),
    } as SpecBuildProgram;
  }
}

class FigureImpl implements FigureBuilder {
  private readonly parts: SpecFigurePart[] = [];
  private readonly stages: SpecFigureStage[] = [];
  constructor(
    private readonly id: string,
    private readonly fields: Omit<SpecFigure, "id" | "parts" | "stages">,
  ) {}

  part(part: SpecFigurePart): this {
    this.parts.push(clone(part));
    return this;
  }

  stage(stage: SpecFigureStage): this {
    this.stages.push(clone(stage));
    return this;
  }

  toJSON(): SpecFigure {
    const out: Record<string, Json> = { ...clone(this.fields), id: this.id };
    out.parts = clone(this.parts);
    if (this.stages.length) out.stages = clone(this.stages);
    return out as unknown as SpecFigure;
  }
}

class SpecImpl implements SpecBuilder {
  private readonly assemblies: SpecAssembly[] = [];
  private readonly racks: SpecRack[] = [];
  private readonly figures: SpecFigure[] = [];
  private readonly storyboards: SpecStoryboard[] = [];
  private readonly images: SpecImage[] = [];
  private readonly steps: SpecStep[] = [];
  constructor(private readonly meta: Omit<PlatformCosmoSpec["meta"], "version">) {}

  assembly(a: SpecAssembly | AssemblyBuilder): this {
    this.assemblies.push(resolve(a));
    return this;
  }
  rack(rack: SpecRack): this {
    this.racks.push(clone(rack));
    return this;
  }
  figure(f: SpecFigure | FigureBuilder): this {
    this.figures.push(resolve(f));
    return this;
  }
  storyboard(s: SpecStoryboard): this {
    this.storyboards.push(clone(s));
    return this;
  }
  image(image: SpecImage): this {
    this.images.push(clone(image));
    return this;
  }
  step(step: SpecStep): this {
    this.steps.push(clone(step));
    return this;
  }

  toJSON(): PlatformCosmoSpec {
    const out: Record<string, Json> = { meta: { ...clone(this.meta), version: "1" } };
    const add = (key: string, list: Json[]) => {
      if (list.length) out[key] = clone(list);
    };
    add("images", this.images);
    add("figures", this.figures);
    add("storyboards", this.storyboards);
    add("assemblies", this.assemblies);
    add("racks", this.racks);
    add("steps", this.steps);
    return out as unknown as PlatformCosmoSpec;
  }
}

export const spec: AssemblyBuilders["spec"] = (meta) => new SpecImpl(meta);
export const assembly: AssemblyBuilders["assembly"] = (id, fields = {}) =>
  new AssemblyImpl(id, fields);
export const explode: AssemblyBuilders["explode"] = (id, fields = {}) =>
  new ExplodeImpl(id, fields);
export const build: AssemblyBuilders["build"] = (id, fields = {}) => new BuildImpl(id, fields);
export const figure: AssemblyBuilders["figure"] = (id, fields) => new FigureImpl(id, fields);
