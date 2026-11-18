# Claude Code plugin

## Install

```
/plugin marketplace add mirastacklabs-ai/platformcosmo
/plugin install platformcosmo@platformcosmo
```

From a shell: `claude plugin marketplace add mirastacklabs-ai/platformcosmo` and
`claude plugin install platformcosmo@platformcosmo`. The plugin ships a self-contained CLI, so no npm install is
needed; it only needs Node.js 22.12 or newer on your PATH.

## Skills

| Command                                            | Does                                                                                                                                   |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `/platformcosmo:diagram <description>`             | Writes a spec, validates it, fixes errors, builds the SVG. Claude also uses it automatically when you ask for an architecture diagram. |
| `/platformcosmo:export <spec> [flags]`             | Re-exports an existing spec: static, steps, PNG, interactive, GIF, MP4, other themes.                                                  |
| `/platformcosmo:icons [add\|list\|search\|remove]` | Manages icon packs. Runs only when you invoke it, because adding a pack downloads files.                                               |

## What Claude does

1. Writes `<name>.cosmo.json`. It never writes SVG by hand.
2. Runs `pcosmo validate` and fixes every error using the suggestions.
3. Runs `pcosmo build` and reports the output paths.

## The `pcosmo` command

While the plugin is enabled, `pcosmo` is on the PATH of Claude's Bash tool. It is the same CLI as the npm package,
bundled into one file. Outside Claude Code you can run it with
`node <plugin dir>/bin/pcosmo.mjs`.

## Updates

Claude Code caches plugins by version, so you get a new CLI and new skills when the plugin version is bumped
(`/plugin update platformcosmo`). Icon packs you installed live in a separate user directory and survive updates.
