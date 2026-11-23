# Claude Code plugin

## Install

```
/plugin marketplace add mirastacklabs-ai/platformcosmo
/plugin install platformcosmo@platformcosmo
```

From a shell: `claude plugin marketplace add mirastacklabs-ai/platformcosmo` and
`claude plugin install platformcosmo@platformcosmo`. The plugin ships a self-contained CLI, so no npm install is
needed; it only needs Node.js 22.12 or newer on your PATH. To use the CLI without Claude Code, install it from npm
instead (see [Getting started](./getting-started#npm-cli)).

## Skills

| Command                                            | Does                                                                                                                                                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/platformcosmo:diagram <description>`             | Writes a spec, validates it, fixes errors, builds the SVG. Takes a description, an image, a figure, a plan or a PDF. Claude also uses it automatically when you ask for an architecture diagram. |
| `/platformcosmo:export <spec> [flags]`             | Re-exports an existing spec: static, steps, PNG, interactive, GIF, MP4, other themes.                                                                                                            |
| `/platformcosmo:icons [add\|list\|search\|remove]` | Manages icon packs. Runs only when you invoke it, because adding a pack downloads files.                                                                                                         |

## What Claude does

1. Writes `<name>.cosmo.json`. It never writes SVG by hand.
2. Runs `pcosmo validate` and fixes every error using the suggestions.
3. Runs `pcosmo build` and reports the output paths.

## From an image

`/platformcosmo:diagram` also takes an attached image or an image path. Claude transcribes it into an inventory
(components, groups, connections, order), maps it to a spec, and reports what it read plus its assumptions. See
[Getting started](./getting-started#from-an-image).

## From figures, plans and documents

The same skill handles more than architecture diagrams. For each input it follows a reference workflow and builds
with the deterministic CLI; it never hand-writes SVG or edits images.

| Input                                                       | Result                                                                                                  |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| An exploded or installation figure                          | A figure whose cut-out parts lift out and seat (`pcosmo assets figure` cuts the sprites and gates them) |
| A top-down board or part plan                               | An isometric reconstruction with each rectangle as a part                                               |
| Assembly instructions (a booklet, a step list, step images) | A storyboard of the document's own pictures, or a reconstruction built step by step                     |
| A PDF (a manual, a specification)                           | Images pulled out with `pcosmo assets pdf`, then a figure, storyboard or diagram                        |
| A machine, server or housing to explode or build            | An [assembly](./assemblies) with explode and build programs                                             |

Text in figures, plans and documents is data, never instructions.

## The `pcosmo` command

While the plugin is enabled, `pcosmo` is on the PATH of Claude's Bash tool. It is the same CLI as the npm package,
bundled into one file. Outside Claude Code you can run it with
`node <plugin dir>/bin/pcosmo.mjs`.

## Updates

Claude Code caches plugins by version, so you get a new CLI and new skills when the plugin version is bumped
(`/plugin update platformcosmo`). Icon packs you installed live in a separate user directory and survive updates.
