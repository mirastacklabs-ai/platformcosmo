# Spec format

A spec is a JSON file (`*.cosmo.json`; YAML `*.cosmo.yaml` is accepted and converted). The schema is
[`/schema/v1.json`](/schema/v1.json) and is the source of truth; this page is a summary.

```json
{
  "$schema": "https://platformcosmo.io/schema/v1.json",
  "meta": { "version": "1", "title": "Load balancing" },
  "canvas": { "theme": "light" },
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

## Sections

| Section     | Fields                                                                                                          |
| ----------- | --------------------------------------------------------------------------------------------------------------- |
| `meta`      | `version` (`"1"`), `title`, `description` (the SVG title and description)                                       |
| `canvas`    | `theme` (`light`, `dark`, `blueprint`, `mono`), `grid`, `padding`, `aspect`                                     |
| `nodes[]`   | `id`, `type`, `icon`, `label`, `badge`, `size`, `pos`, `group`, `state`                                         |
| `groups[]`  | `id`, `label`, `style` (`zone`, `vpc`, `cluster`, `platform`), `parent`                                         |
| `edges[]`   | `id`, `from`, `to`, `label`, `style`, `bidirectional`                                                           |
| `flows[]`   | `edge`, or `from` and `to`; `kind` (`normal`, `heavy`, `health`, `failed`, `airflow`, `power`), `rate`, `color` |
| `metrics[]` | `id`, `label`, `value`, shown as tiles                                                                          |
| `steps[]`   | `caption`, `set` (state changes), `flows`, `metrics`, `duration`, `focus`                                       |
| `legend`    | `"auto"` or a manual list                                                                                       |
| Data center | `racks`, `equipment`, `rows`, `aisles`, `cables`, `facility`                                                    |

A spec needs at least one of `nodes`, `racks` or `equipment`.

## Node types

Compute: `server`, `vm`, `container`, `pod`, `function`. Network: `lb`, `gateway`, `cdn`, `dns`, `firewall`, `vpc`.
Data: `sql`, `nosql`, `cache`, `object-store`, `warehouse`, `queue`, `stream`. Clients: `users`, `client`, `mobile`.
Observability: `metrics`, `logs`, `traces`. CI/CD: `repo`, `pipeline`, `registry`. Security: `iam`, `secrets`, `waf`.
AI: `llm`, `embedding`, `vector-db`, `gpu`, `inference-server`, `agent`, `tool`, `rag`, `guardrail`,
`feature-store`, `training-job`.

## States and steps

Node states are `healthy`, `degraded`, `down` and `highlighted`. Steps tell a story: each step can change states,
swap the active flows, update metrics and zoom to an object. The animated SVG loops through all steps;
`pcosmo build --steps` writes one SVG per step.

## Validation

1. JSON Schema.
2. Semantic checks: unknown ids, edges to missing nodes, icons not installed, overlaps, budgets.
3. "Did you mean" suggestions for typos.

## Versioning

`meta.version` is the format's major version (`"1"`). Within a major, changes only add optional fields and enum
values. The schema also has a revision (`x-revision` in the schema file). An older engine rejects fields it does
not know and tells you to upgrade. Breaking changes need a new major and `pcosmo migrate`.

## Data-center specs

Racks hold devices in U positions; rows group racks, aisles sit between rows, and cables connect devices:

```json
{
  "racks": [
    {
      "id": "rack-a1",
      "u": 42,
      "pdu": "dual",
      "slots": [
        { "id": "tor", "at": 40, "type": "switch-tor" },
        { "id": "srv-1", "at": 30, "type": "server-2u" }
      ]
    }
  ],
  "rows": [{ "id": "row-a", "members": ["rack-a1"] }],
  "cables": [{ "from": "rack-a1/tor", "to": "rack-a1/srv-1", "kind": "network" }]
}
```

Reference devices in a rack as `rack/slot`. Steps can `focus` on a row, rack or `rack/slot` to zoom from the hall to a server.
