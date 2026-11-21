---
name: export
description: Re-export an existing PlatformCosmo spec (*.cosmo.json or *.cosmo.yaml) to other formats or themes: static SVG, per-step SVGs, PNG, interactive SVG, GIF or MP4. Use when the user already has a spec and wants a different output, size, theme or speed without redrawing it.
argument-hint: <spec file> [--static --steps --interactive --png --gif --mp4 --theme dark --speed 2 --motion css]
allowed-tools: Bash(pcosmo build *) Bash(pcosmo validate *) Bash(node ${CLAUDE_PLUGIN_ROOT}/bin/pcosmo.mjs build *) Bash(node ${CLAUDE_PLUGIN_ROOT}/bin/pcosmo.mjs validate *) Read
---

# PlatformCosmo export

Re-render an existing spec: `pcosmo build $ARGUMENTS --packs-dir "${CLAUDE_PLUGIN_DATA}/icons"` (the flag points at the
user's installed icon packs; Bash commands do not see `CLAUDE_PLUGIN_DATA`). Treat `$ARGUMENTS` as a spec path plus the
flags listed below; do not pass anything else through. Do not edit the spec unless the user asks; this skill only
exports. If the spec fails validation, run `pcosmo validate <spec> --packs-dir "${CLAUDE_PLUGIN_DATA}/icons"`, report the diagnostics and offer to fix the
spec with `/platformcosmo:diagram`.

## Outputs

The animated `<name>.svg` is always written unless `--no-animated` is given. Flags add outputs:

| Flag            | Output                     | Notes                                                                                   |
| --------------- | -------------------------- | --------------------------------------------------------------------------------------- |
| (default)       | `<name>.svg`               | Animated, looping, self-contained; works in `<img>`, inline and CSS backgrounds         |
| `--static`      | `<name>.static.svg`        | First frame, no animation (docs, print)                                                 |
| `--steps`       | `<name>.steps/step-NN.svg` | One SVG per step (slides, tutorials)                                                    |
| `--interactive` | `<name>.interactive.svg`   | Play/Pause/Step; the controls work only when the SVG is inlined in HTML                 |
| `--png`         | `<name>.png`               | `--scale 2` by default; `--time <s>` picks a moment, `--png-step <n>` the end of step n |
| `--gif`         | `<name>.gif`               | Rendered from frames; `--fps`, `--duration`                                             |
| `--mp4`         | `<name>.mp4`               | Needs `ffmpeg` on PATH; if it is missing, say so and offer `--gif`                      |

Other options: `--theme light|dark|blueprint|mono|<file>`, `--font embed|outline|system`, `--speed <n>`,
`--motion smil|css`, `-o <dir>` (output directory), `--name <base>`, `--no-optimize`.

`--motion css` moves the flow particles with CSS `offset-path` instead of SMIL (`<animateMotion>`), so the SVG
contains no SMIL elements at all. Use it when the host strips SMIL but keeps `<style>` (some sanitizers, markdown
renderers and wikis); keep the default `smil` otherwise. Timing, particle counts and reduced-motion behaviour are
the same; static, PNG and GIF/MP4 output do not change.

## Rules

1. Run the build, then report every path printed on a `wrote` line, with sizes.
2. Choose flags from what the user wants to do with the result ("for a slide" is `--png`, "for the README" is the
   default SVG plus `--static`, "walk through it" is `--steps`).
3. Never write SVG by hand and never post-process the output files.
4. A spec with more than about 5000 SVG elements is slow to export; if `build` warns, suggest splitting the diagram.
5. Embedding tip for the user: the default SVG works as `<img src="name.svg">`; use `--interactive` only for inlined SVG.
