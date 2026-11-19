# Themes and fonts

The default look is the MiraStack Labs brand: Oswald for display text, JetBrains Mono for
technical text, a white or near-black base, neutral ink/grey solids with teal accents, and an
iso ground grid in the brand line colour. Orange (`#ff671f`, the brand signal colour) is reserved for
emphasis: the `highlighted` state and power flows and cables.

## Themes

| Theme       | Scheme | Notes                                                       |
| ----------- | ------ | ----------------------------------------------------------- |
| `light`     | light  | Brand light: `#ffffff` base, `#e4e2dc` grid, teal `#00695f` |
| `dark`      | dark   | Brand dark: `#0a0a0a` base, `#272727` grid, teal `#2bd4bf`  |
| `blueprint` | dark   | Blue drafting look; brand fonts, its own colours            |
| `mono`      | light  | Greyscale; brand fonts                                      |

Set one with `canvas.theme` in the spec or `--theme` on the CLI. A custom theme file is validated
by `validateTheme`; `font.family` (display) is required and `font.mono` (technical text) is
optional and falls back to `font.family`.

## Grid

`canvas.grid` defaults to `true`: the iso ground grid is drawn in the theme's grid colour. Set
`"grid": false` for a plain background.

## Fonts

| Role                                                    | Family         | Faces                              |
| ------------------------------------------------------- | -------------- | ---------------------------------- |
| Node labels, group pills, titles, legend, step captions | Oswald         | 400, 500 (node labels), 600 (bold) |
| Badges, metric labels and values, edge labels           | JetBrains Mono | 400, 700 (bold)                    |

Both are SIL OFL 1.1, bundled as Latin subsets (`packages/core/assets/fonts/PROVENANCE.txt`).
`--font` modes:

- `embed` (default): one WOFF2 subset per family and weight, containing only the glyphs the
  diagram uses.
- `outline`: text becomes paths, using the same two families.
- `system`: no font data; the theme stacks apply (`Oswald, "Arial Narrow", Arial, sans-serif` and
  `"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`).

PNG, GIF and MP4 export load both faces, so raster output matches the SVG. Oswald has no arrow
glyphs (`→`): such characters are drawn, measured and embedded with JetBrains Mono, and raster
output outlines those labels so all targets match. `render/missing-glyph` warns only when neither
face has the character. Label, badge, metric, caption and legend sizes grow with the scene width
(about width / 100 px, up to 2.2x) so wide diagrams stay legible when shown small.

## Node category colours (light / dark)

Teal is the primary family, neutral ink and greys fill the rest; no category uses orange.

| Category        | Light     | Dark      | Reads as            |
| --------------- | --------- | --------- | ------------------- |
| `compute`       | `#00695f` | `#14867a` | brand teal          |
| `network`       | `#4fb3a8` | `#2bd4bf` | light teal          |
| `data`          | `#3a3a3a` | `#555555` | charcoal            |
| `client`        | `#b9b7b0` | `#a0a0a0` | light warm grey     |
| `observability` | `#7a7a76` | `#747474` | mid grey            |
| `cicd`          | `#1f8f82` | `#4fa89d` | medium teal         |
| `security`      | `#0a0a0a` | `#d9d9d9` | ink (white in dark) |
| `ai`            | `#2f5f5a` | `#2f7d74` | dark slate teal     |
| `dc`            | `#a4aaa6` | `#8a928e` | cool grey           |

State colours: `degraded` is a signal-orange outline with an orange tint, `down` red, `highlighted` an ink (light) or white (dark) outline. `heavy` flows are signal orange (`#fa5f14` on light, where `#ff671f` is just under 3:1 on white); `power` flows are amber.
