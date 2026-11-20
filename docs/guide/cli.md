# CLI reference

```
pcosmo <command> [options]
```

Exit codes: `0` ok, `1` spec or build errors, `2` usage error, `3` internal error.

## init

`pcosmo init [file] [--template <name>] [--list] [--force]` writes a starter spec (default `diagram.cosmo.json`).
Templates include the starter and the [lesson templates](./lessons).

## validate

`pcosmo validate <spec> [--json] [--strict]` runs schema and semantic checks. Diagnostics have a stable code, a
JSON pointer into the spec and, where possible, a suggestion. `--strict` treats warnings as errors.

## build

`pcosmo build <spec> [options]` writes `<name>.svg` (animated) next to the spec. Output flags add to it:

| Flag            | Output                                                                  |
| --------------- | ----------------------------------------------------------------------- |
| `--static`      | `<name>.static.svg`, the first frame                                    |
| `--steps`       | `<name>.steps/step-NN.svg`, one per step                                |
| `--interactive` | `<name>.interactive.svg` with Play, Pause and Step (works when inlined) |
| `--png`         | `<name>.png` (`--scale`, `--time`)                                      |
| `--gif`         | `<name>.gif` (`--fps`, `--duration`)                                    |
| `--mp4`         | `<name>.mp4`, needs `ffmpeg` on PATH                                    |
| `--no-animated` | skip `<name>.svg`                                                       |

| Option                                         |                                                          |
| ---------------------------------------------- | -------------------------------------------------------- |
| `--theme light\|dark\|blueprint\|mono\|<file>` | built-in theme or a custom theme JSON file               |
| `--font embed\|outline\|system`                | how text is embedded (default `embed`)                   |
| `--speed <n>`                                  | animation speed multiplier, `0 < n <= 10`                |
| `--motion smil\|css`                           | particle motion: `smil` (default) or CSS `offset-path`   |
| `-o, --out <dir>`, `--name <name>`             | where and under what name to write                       |
| `--no-optimize`                                | skip the SVGO pass                                       |
| `--id-prefix <p>`                              | prefix for SVG ids; the default is derived from the spec |
| `--json`                                       | machine-readable result                                  |

`--motion css` replaces the SMIL particle animation (`<animateMotion>`) with CSS `offset-path` keyframes, so the SVG has no
SMIL elements. Use it when the host strips SMIL but keeps `<style>`; timing, particle counts and reduced-motion
behaviour match `smil`, and static, PNG and GIF/MP4 output are unchanged.

The same spec and options always produce byte-identical files.

## watch

`pcosmo watch <spec> [build options]` builds, then rebuilds when the spec changes. Press Ctrl+C to stop.

## icons

`pcosmo icons add|list|search|remove`, see [Icons](./icons).

## examples

`pcosmo examples` lists the gallery; `pcosmo examples show <name>` prints a spec; `pcosmo examples copy <name|all> [-o dir]` copies specs.

## migrate

`pcosmo migrate <spec>` migrates a spec to the current format major. Only major 1 exists, so it confirms the version.

## assets

`pcosmo assets doctor | crop | cutout | locate | align | figure | check | shrink` are offline, deterministic image operations for turning a drawn figure into sprites and a spec fragment (`images[]` and `figures[]`). `pcosmo assets figure <manifest.json> -d out/` writes `base.png`, `sprite-N.png`, `report.json` and `fragment.json` and exits 1 when the quality gate finds errors; `--show-exclusions` also writes `exclusions-<state>.png`; `pcosmo assets check <manifest.json> -d out/` re-runs the gate on those outputs. The manifest format is `schema/figure-manifest.v1.json`. Input files must be plain files (symbolic links, FIFOs and devices are refused with `image/unsafe-path`); outputs are written only below the working directory. Run `pcosmo assets --help` for every flag.

`pcosmo build` and `pcosmo validate` read the files a spec's `images[]` names (relative to the spec's directory, no `..`, no symbolic links) and report `image/not-found`, `image/unsafe-path` or `image/too-large` instead of rendering.

## Environment

| Variable             | Effect                                                               |
| -------------------- | -------------------------------------------------------------------- |
| `PCOSMO_PACKS_DIR`   | user icon pack directory (also `--packs-dir`)                        |
| `CLAUDE_PLUGIN_DATA` | when set (by Claude Code), packs live in `$CLAUDE_PLUGIN_DATA/icons` |

The default pack directory is `~/.platformcosmo/icons`.
