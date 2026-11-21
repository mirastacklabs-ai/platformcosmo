import type {
  CreateIconResolverFn,
  DcPack,
  FetchIconPackFn,
  IconHttpClient,
  LoadedIconPack,
  ParseSpecFn,
  RenderFn,
  SvgSanitizer,
  ThemeRegistry,
  ValidateFn,
  ValidateThemeFn,
  VideoEncoder,
} from "@platformcosmo/core";

/** Engine entry points the CLI calls (all from `@platformcosmo/core`). */
export interface CoreApi {
  parseSpec: ParseSpecFn;
  validate: ValidateFn;
  render: RenderFn;
  createIconResolver: CreateIconResolverFn;
  sanitizeSvg: SvgSanitizer;
  fetchIconPack: FetchIconPackFn;
  /** Built-in GIF encoder; passed to render for `--gif` when the core does not use it implicitly. */
  gifEncoder?: VideoEncoder;
}

export interface Watcher {
  close(): void;
}

/** Everything with side effects or from other packages, injectable so tests never touch the network. */
export interface Deps {
  core: CoreApi;
  themes?: ThemeRegistry | undefined;
  /** Tests only: tighter limits and tool directories for the external PDF renderer (`assets pdf render`). */
  pdfRender?: import("./pdftool.js").RenderSeam | undefined;
  validateTheme?: ValidateThemeFn | undefined;
  dcPack?: DcPack | undefined;
  /** Packs shipped inside the CLI (icons-base, …); they win over user packs on duplicate ids. */
  bundledPacks: readonly LoadedIconPack[];
  http: IconHttpClient;
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  homedir: string;
  /** Returns an mp4 encoder, or undefined when ffmpeg is not installed. */
  createMp4Encoder: () => Promise<VideoEncoder | undefined>;
  /** Watches a directory; `onChange` receives the changed file name. */
  watch: (dir: string, onChange: (fileName: string | null) => void) => Watcher;
  watchDebounceMs: number;
  /** Aborts a running `watch`. */
  signal?: AbortSignal | undefined;
  /** When set, output is streamed here as it happens and RunResult strings stay empty. */
  io?: { out(text: string): void; err(text: string): void } | undefined;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Per-invocation context handed to commands. */
export interface Ctx {
  deps: Deps;
  out(text: string): void;
  err(text: string): void;
  /** Global `--packs-dir`. */
  packsDir?: string | undefined;
  /** `pcosmo assets`: the directory explicit input and output paths are confined to. */
  assetsRoot?: string | undefined;
}

/** Exit codes: 0 ok, 1 spec/build problems, 2 usage, 3 internal or I/O failure. */
export const EXIT = { ok: 0, failed: 1, usage: 2, internal: 3 } as const;

/** Thrown by commands for a usage error (printed with the command help, exit 2). */
export class UsageError extends Error {}
/** Thrown for an expected failure that needs no stack (exit 1). */
export class Failure extends Error {}
