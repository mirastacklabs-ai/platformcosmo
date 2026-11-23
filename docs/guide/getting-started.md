# Getting started

PlatformCosmo is a Claude Code plugin and a CLI. Either way you need Node.js 22.12 or newer on your PATH.

## Install

### Claude Code plugin

Inside Claude Code:

```
/plugin marketplace add mirastacklabs-ai/platformcosmo
/plugin install platformcosmo@platformcosmo
```

Or from a shell: `claude plugin marketplace add mirastacklabs-ai/platformcosmo` and
`claude plugin install platformcosmo@platformcosmo`. The plugin ships its own bundled `pcosmo` CLI, so nothing else
is installed. See [the plugin guide](./plugin).

### npm CLI

The same CLI is on npm as [`platformcosmo`](https://www.npmjs.com/package/platformcosmo), published with provenance.
Run it without installing:

```sh
npx platformcosmo init my-system.cosmo.json
npx platformcosmo build my-system.cosmo.json
```

Or add it to a project and run `pcosmo`:

```sh
npm i -D platformcosmo
npx pcosmo --help
```

The rendering engine is [`@platformcosmo/core`](https://www.npmjs.com/package/@platformcosmo/core) (`validate`,
`render`), for use from your own code; the CLI wraps it.

## With Claude Code

Ask for a diagram:

```
/platformcosmo:diagram a RAG pipeline with a vector DB and a guardrail
```

Claude writes `rag.cosmo.json`, runs `pcosmo validate`, fixes any problems and runs `pcosmo build`. See
[the plugin guide](./plugin).

## From an image

Attach a screenshot, an exported diagram or a whiteboard photo, or name its path:

```
/platformcosmo:diagram draw this as a PlatformCosmo diagram: ./sketch.png
```

Claude first lists the components, groups, connections and reading order it sees, then writes the spec, validates
it and builds the SVG. The image is redrawn in PlatformCosmo's isometric style (not a pixel copy), labels are kept
verbatim (obvious typos fixed, long ones shortened and listed as assumptions), and steps are added only when the image shows a sequence such as numbered arrows. Claude ends with what
it read and any assumptions, so you can correct them. Add "keep the layout" to ask for a best-effort match of the original positions. PlatformCosmo sends the image nowhere: Claude reads it as part of your conversation, like any attachment, and no tool uploads it elsewhere.

## With the CLI

With the npm package, prefix these with `npx` (or use `npx platformcosmo` without installing).

```sh
pcosmo init my-system.cosmo.json     # write a starter spec
pcosmo validate my-system.cosmo.json # schema and semantic checks
pcosmo build my-system.cosmo.json    # writes my-system.svg next to the spec
```

Open `my-system.svg` in a browser, or use it as an image:

```html
<img src="my-system.svg" alt="My system architecture" />
```

Start from the gallery instead of a blank file:

```sh
pcosmo examples                      # list gallery specs
pcosmo examples copy rag-pipeline    # copy one into the current directory
pcosmo init --list                   # list lesson templates
```

## From a figure or a document

The `diagram` skill also takes an exploded or installation figure, a top-down board or part plan, a step list or
assembly booklet, or a PDF (a manual, a specification). Claude uses the `pcosmo assets` commands to extract and cut
out images, then writes a spec with [assemblies, figures or storyboards](./assemblies). Text inside figures and
documents is treated as data, never as instructions.

## Editor completion

Specs start with `"$schema": "https://platformcosmo.io/schema/v1.json"`, which gives completion and validation in
VS Code and other JSON-schema-aware editors. The CLI never fetches that URL; validation is built in.

## Next

- [Spec format](./spec) and the [CLI reference](./cli)
- [Assemblies and close-ups](./assemblies), from a data-center hall down to a single part
- [Icons](./icons), including AWS, Azure and GCP packs
- [Gallery](/gallery)
