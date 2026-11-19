# Getting started

PlatformCosmo needs Node.js 22.12 or newer.

## With Claude Code

```
/plugin marketplace add mirastacklabs-ai/platformcosmo
/plugin install platformcosmo@platformcosmo
```

Then ask for a diagram:

```
/platformcosmo:diagram a RAG pipeline with a vector DB and a guardrail
```

Claude writes `rag.cosmo.json`, runs `pcosmo validate`, fixes any problems and runs `pcosmo build`. See
[the plugin guide](./plugin).

## From an image

Attach a screenshot, an exported diagram or a whiteboard photo, or name its path:

```
/platformcosmo:diagram draw this as a PlatformCosmo diagram, keep the layout: ./sketch.png
```

Claude first lists the components, groups, connections and reading order it sees, then writes the spec, validates
it and builds the SVG. The image is redrawn in PlatformCosmo's isometric style (not a pixel copy), labels are kept
verbatim, and steps are added only when the image shows a sequence such as numbered arrows. Claude ends with what
it read and any assumptions, so you can correct them. The image is read locally and never uploaded.

## With the CLI

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

## Editor completion

Specs start with `"$schema": "https://platformcosmo.io/schema/v1.json"`, which gives completion and validation in
VS Code and other JSON-schema-aware editors. The CLI never fetches that URL; validation is built in.

## Next

- [Spec format](./spec) and the [CLI reference](./cli)
- [Icons](./icons), including AWS, Azure and GCP packs
- [Gallery](/gallery)
