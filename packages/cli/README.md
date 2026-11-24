# platformcosmo

**Prompt in, animated isometric architecture diagram out.**

`pcosmo` turns a small JSON spec into a living 2.5D diagram of cloud, AI, platform-engineering and
data-center systems: requests flow, servers fail, traffic fails over, racks slide open, parts explode
and snap back. One self-contained SVG, no JavaScript, works anywhere an image does.

<p align="center">
  <img src="https://raw.githubusercontent.com/mirastacklabs-ai/platformcosmo/main/examples/gallery/load-balancing.svg" alt="Animated diagram: a load balancer spreads requests across three app servers, a health check catches a failure and traffic fails over" width="760">
</p>

Built by the engineering team at [MIRASTACK LABS](https://www.mirastacklabs.ai). Docs and gallery:
**[platformcosmo.io](https://platformcosmo.io)**.

## Install

Node.js >= 22.12.

```sh
npx platformcosmo init my.cosmo.json     # write a starter spec
npx platformcosmo build my.cosmo.json    # writes my.svg next to the spec
```

Or add it to a project and run `pcosmo`:

```sh
npm i -D platformcosmo
npx pcosmo --help
```

With Claude Code, install the plugin instead and let Claude write the spec from a prompt, an image or
a PDF:

```
/plugin marketplace add mirastacklabs-ai/platformcosmo
/plugin install platformcosmo@platformcosmo
/platformcosmo:diagram a RAG pipeline with a vector DB and a guardrail
```

## Commands

| Command                  | Does                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------- |
| `pcosmo init [file]`     | Write a starter spec or a lesson template (`--template`, `--list`)                    |
| `pcosmo validate <spec>` | Schema and semantic checks with did-you-mean fixes (`--strict`, `--json`)             |
| `pcosmo build <spec>`    | Render the outputs below                                                              |
| `pcosmo watch <spec>`    | Rebuild on change                                                                     |
| `pcosmo examples`        | List, show or copy the gallery specs                                                  |
| `pcosmo icons`           | Add, list, search or remove icon packs (AWS, Azure, GCP, CNCF, any SVG folder or URL) |
| `pcosmo assets`          | Offline image and PDF tools for turning figures and manuals into specs                |

## Outputs

| Output                  | Flag             |
| ----------------------- | ---------------- |
| Animated, looping SVG   | (default)        |
| First-frame SVG         | `--static`       |
| One SVG per step        | `--steps`        |
| Play / Pause / Step SVG | `--interactive`  |
| PNG                     | `--png`          |
| GIF, MP4 (with ffmpeg)  | `--gif`, `--mp4` |

Themes: `light`, `dark`, `blueprint`, `mono` or your own theme file (`--theme`). The same spec and
options always produce byte-identical files.

## A spec

```json
{
  "$schema": "https://platformcosmo.io/schema/v1.json",
  "meta": { "version": "1", "title": "Load balancing" },
  "nodes": [
    { "id": "users", "type": "users", "label": "Users" },
    { "id": "lb", "type": "lb", "label": "Load balancer" },
    { "id": "app", "type": "server", "label": "App" }
  ],
  "edges": [
    { "id": "users-lb", "from": "users", "to": "lb" },
    { "id": "lb-app", "from": "lb", "to": "app" }
  ],
  "flows": [{ "edge": "users-lb" }, { "edge": "lb-app" }]
}
```

Full format: [platformcosmo.io/guide/spec](https://platformcosmo.io/guide/spec). The engine is
[`@platformcosmo/core`](https://www.npmjs.com/package/@platformcosmo/core).

## License

Apache-2.0, Copyright 2026 MIRASTACK LABS PRIVATE LIMITED. Bundled fonts and icons keep their own
licenses (see `NOTICE`). Source: [github.com/mirastacklabs-ai/platformcosmo](https://github.com/mirastacklabs-ai/platformcosmo).
