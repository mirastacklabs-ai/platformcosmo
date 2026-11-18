---
name: diagram
description: Draw an animated isometric architecture diagram (cloud, platform engineering, AI, data center) from a description. Use when the user asks for an architecture diagram, system or network diagram, request-flow or data-flow picture, load balancer, RAG, Kubernetes, CDN or GPU cluster visual, or a data-center rack/row layout. You write a small JSON spec; the pcosmo CLI renders the SVG.
argument-hint: <what to draw, e.g. "RAG pipeline with a vector DB and a guardrail">
allowed-tools: Bash(pcosmo validate *) Bash(pcosmo build *) Bash(pcosmo init *) Bash(pcosmo examples list*) Bash(pcosmo examples show *) Bash(pcosmo examples copy *) Bash(pcosmo icons search *) Bash(pcosmo icons list*) Bash(node ${CLAUDE_PLUGIN_ROOT}/bin/pcosmo.mjs validate *) Bash(node ${CLAUDE_PLUGIN_ROOT}/bin/pcosmo.mjs build *) Bash(node ${CLAUDE_PLUGIN_ROOT}/bin/pcosmo.mjs init *) Bash(node ${CLAUDE_PLUGIN_ROOT}/bin/pcosmo.mjs examples list*) Bash(node ${CLAUDE_PLUGIN_ROOT}/bin/pcosmo.mjs examples show *) Bash(node ${CLAUDE_PLUGIN_ROOT}/bin/pcosmo.mjs examples copy *) Bash(node ${CLAUDE_PLUGIN_ROOT}/bin/pcosmo.mjs icons search *) Bash(node ${CLAUDE_PLUGIN_ROOT}/bin/pcosmo.mjs icons list*) Read Write(*.cosmo.json)
---

# PlatformCosmo diagram

Turn a description into a spec (`*.cosmo.json`), validate it, and render an animated, self-contained
isometric SVG with `pcosmo`. You only write the spec. All geometry, layout and drawing is
deterministic code.

Request: $ARGUMENTS

## Hard rules

1. **Never hand-write SVG.** The only files you write are `*.cosmo.json` specs in the user's working directory.
2. **Prefer auto-layout.** Do not set `pos` unless the user asks for a specific arrangement.
3. **Always validate, fix, then build:** `pcosmo validate <spec> --packs-dir "${CLAUDE_PLUGIN_DATA}/icons"`; fix every error; then `pcosmo build <spec> --packs-dir "${CLAUDE_PLUGIN_DATA}/icons"`.
4. **Report the output paths** printed by `pcosmo build` (lines starting `wrote`).
5. Keep it readable: 5 to 20 nodes, labels under about 24 characters, one idea per diagram.
6. Never pass `--force` to `pcosmo init` or `pcosmo examples copy` without asking the user first; it overwrites files.
7. Do not invent fields. If the CLI says a field is unknown, remove it or use the suggestion.

Pass `--packs-dir "${CLAUDE_PLUGIN_DATA}/icons"` to every `validate`, `build` and `icons search`/`icons list`
command: it is where the user's installed icon packs live (Bash commands do not see `CLAUDE_PLUGIN_DATA`).

If `pcosmo` is not found, the plugin's `bin/` is not on PATH: run
`node ${CLAUDE_PLUGIN_ROOT}/bin/pcosmo.mjs <args>` instead. It needs Node 22.12 or newer.

## Workflow

1. Decide the story: what flows where, and what changes over time (a failure, a scale-out, a cache hit).
2. Write `<name>.cosmo.json` in the user's working directory (ask only if the location is unclear).
   Start from `pcosmo init <name>.cosmo.json` or `pcosmo examples copy <example>` when it saves effort.
3. `pcosmo validate <name>.cosmo.json --packs-dir "${CLAUDE_PLUGIN_DATA}/icons"` (add `--json` for machine-readable output). Each diagnostic has
   a code, a JSON pointer and often a "did you mean" suggestion. Apply the fix and re-run until it prints `valid`.
4. `pcosmo build <name>.cosmo.json --packs-dir "${CLAUDE_PLUGIN_DATA}/icons"`. Add `--static`, `--steps`, `--png` or `--theme dark` only when asked.
5. Tell the user the file paths, in one or two lines, and offer one concrete tweak (theme, steps, export).

## Spec in one screen

```json
{
  "$schema": "https://platformcosmo.io/schema/v1.json",
  "meta": { "version": "1", "title": "Short title", "description": "One sentence." },
  "canvas": { "theme": "light" },
  "nodes": [{ "id": "web", "type": "server", "label": "Web", "group": "pool" }],
  "groups": [{ "id": "pool", "label": "App pool", "style": "cluster" }],
  "edges": [{ "id": "users-web", "from": "users", "to": "web", "label": "HTTPS" }],
  "flows": [{ "edge": "users-web", "kind": "heavy" }],
  "metrics": [{ "id": "rps", "label": "Requests/s", "value": 1200 }],
  "steps": [{ "caption": "What happens now", "set": { "web": "down" }, "metrics": { "rps": 0 } }],
  "legend": "auto"
}
```

- Ids: lowercase kebab-case (`^[a-z][a-z0-9-]*$`), unique across nodes, groups and edges.
- `nodes[].type` picks the glyph and default icon (full list in [node types](references/node-types.md)).
- `icon: "pack:name"` overrides the glyph with a provider or brand icon; check `pcosmo icons search <term> --packs-dir "${CLAUDE_PLUGIN_DATA}/icons"`
  first. Use an icon only if it is installed (the validator warns when it is not).
- Flows are the animated particles: `kind` is `normal | heavy | health | failed | airflow | power`.
- Steps tell a story in order. `set` changes states (`healthy | degraded | down | highlighted`),
  `flows` replaces the active flows for that step, `metrics` updates tiles, `focus` zooms to an object.
- Text is plain text only (no markup, max 200 characters).

Full field reference: [spec reference](references/spec-reference.md).
Data-center halls (racks, rows, aisles, cables): [data-center reference](references/data-center.md).

## Worked examples

Read the one closest to the request, then adapt it:

- [Load balancing with failover](examples/load-balancing.cosmo.json): groups, flows, 4 steps, a node going down.
- [RAG pipeline](examples/rag-pipeline.cosmo.json): a linear story told entirely through steps and highlights.
- [Kubernetes deployment](examples/kubernetes-deployment.cosmo.json): a cluster group, a rollout with degraded pods.

More gallery specs ship with the CLI: `pcosmo examples list` lists them, `pcosmo examples copy <name>` copies one.

## When validation fails

- `schema/additional-property`: a field the spec does not have; the message names it. Remove it, or the
  CLI is older than the spec (tell the user to upgrade the plugin).
- `semantic/unknown-node` and friends: an edge, flow or step references an id that does not exist. Fix the id.
- `semantic/icon-not-installed`: drop `icon` (the semantic `type` still draws a glyph) or ask the user to run
  `/platformcosmo:icons add <pack>`.
- `budget/*`: the diagram is too big or has too many particles. Remove flows or split it into two diagrams.
