# Spec reference (format major 1, schema revision 1.1.0)

Source of truth: `https://platformcosmo.io/schema/v1.json`. Unknown fields are rejected.
A spec needs at least one of `nodes`, `racks`, `equipment`.

## Root

| Field     | Notes                                                                                                           |
| --------- | --------------------------------------------------------------------------------------------------------------- |
| `$schema` | `https://platformcosmo.io/schema/v1.json` (editor completion only)                                              |
| `meta`    | required. `version: "1"` (string), `title`, `description` (become SVG title and description)                    |
| `canvas`  | `theme` (`light`, `dark`, `blueprint`, `mono`), `grid` (bool), `padding` (0..1000), `aspect` (`auto` or `16:9`) |
| `nodes`   | 1..500                                                                                                          |
| `groups`  | up to 200                                                                                                       |
| `edges`   | up to 1000                                                                                                      |
| `flows`   | up to 200                                                                                                       |
| `metrics` | up to 50                                                                                                        |
| `steps`   | up to 99                                                                                                        |
| `legend`  | `"auto"` or `[{ "label", "color" }]`                                                                            |
| DC fields | `racks`, `equipment`, `rows`, `aisles`, `cables`, `facility` (see data-center.md)                               |

## nodes[]

`id` (required), `type` (required, see node-types.md), `icon` (`pack:name`), `label`, `badge` (short tag such
as `round robin`), `size` (`sm | md | lg`), `pos` (`{x, y}` integer grid tiles; avoid), `group` (a group id),
`state` (initial: `healthy | degraded | down | highlighted`).

## groups[]

`id` (required), `label`, `style` (`zone | vpc | cluster | platform`), `parent` (another group id, for nesting).

## edges[]

`from`, `to` (required; node ids), `id` (give one when a flow or step refers to it), `label`,
`style` (`solid | dashed | dotted`), `bidirectional` (bool). Edges are drawn on the ground plane.

## flows[]

Either `{ "edge": "<edge id>" }` or `{ "from": "<id>", "to": "<id>" }`, plus optional:
`kind` (`normal | heavy | health | failed | airflow | power`), `rate` (0 < rate <= 20, relative particle rate;
default 1), `color` (`#rgb`, `#rrggbb`, a palette name such as `blue`, or a flow kind).
Top-level `flows` are active from the start; `steps[].flows` replaces them for that step.

## metrics[]

`id`, `label`, `value` (string up to 64 chars or a number). A step changes it with `"metrics": { "<id>": value }`.

## steps[]

At least one of: `caption`, `set`, `flows`, `metrics`, `focus`; plus `duration` (seconds, default chosen by the engine).

- `set`: `{ "<node id or rack/slot>": "<state>" }`
- `focus`: an object id to zoom to (use for large diagrams and DC hall to rack to server drill-downs)
- Per-step SVGs: `pcosmo build x.cosmo.json --steps` writes `x.steps/step-01.svg`, ...

## Endpoints

An object id, or `rackId/slotId` for a device in a rack (DC specs).

## Limits

Text 200 chars, ids 64 chars, total particle estimate 2000, 5000 SVG elements (the build warns and suggests splitting).
