# Drawing from an image

Use this when the request includes an image: an attachment, or a path the user names (use `Read` on the path;
it shows you the image). The image is the source of truth for **what** exists and connects. PlatformCosmo
redraws it in its isometric style; it is not a pixel copy. Never upload the image anywhere and do not try to
OCR it with a tool: you read it yourself.

## 1. Transcribe first (before writing any JSON)

Write a short inventory in your reply or reasoning. Keep it terse; one line per item.

- **Components**: label exactly as shown, your inferred `type` from [node types](node-types.md), and an icon only
  if a provider or product logo is clearly recognisable (then `pcosmo icons search` it; skip if not installed).
- **Groups**: any boundary box (VPC, cluster, availability zone, subnet, rack, "Platform"). Which components sit
  inside, and any nesting. A dashed or shaded rectangle around components is a group, not a node.
- **Connections**: `from -> to`, direction (arrowheads; no arrowhead means draw it one way along the reading
  order), label on the line, style (solid, dashed or dotted for async/optional), numbers on arrows.
- **Order**: the reading order and tiers, usually left to right or top to bottom (clients, edge, services, data).
- **Unclear parts**: anything you cannot read or classify. Note it; do not silently drop or invent it.

## 2. Map to the spec

- **Labels**: copy verbatim. Fix only obvious OCR-level typos ("Postgre SQL" to "PostgreSQL"). A label over about
  24 characters: shorten it keeping the meaning and list the change in the assumptions. Text is plain text.
- **Types**: the closest specific type. Unknown or ambiguous shape: `server` with the image's label, and list it
  as an assumption. A person icon is `users`; a browser or phone is `client` or `mobile`; a cylinder is `sql`
  unless labelled Redis/cache/Mongo/S3 etc.
- **Ids**: kebab-case from the label (`app-server-1`), unique across nodes, groups and edges.
- **Groups**: `groups[]` plus `node.group`; nested boundaries use `parent`. Style: `vpc`, `cluster`, `zone` or
  `platform`, whichever matches the label.
- **Edges**: one per arrow. Give an `id` to every edge that a flow or step refers to. Dashed line: `"style":
"dashed"`. Double-headed arrow: `"bidirectional": true`. Edge label as shown.
- **Layout**: auto-layout. Add `pos` (integer grid tiles) only when the user asks to "keep the layout" or "same
  positions": approximate the image's grid, one tile per box-width, left-to-right as `x`, top-to-bottom as `y`,
  and keep relative order and alignment. Otherwise never set `pos`.
- **Too big**: an image with more than about 20 components: keep the main path, merge repeated identical boxes
  ("3 x worker") into one node with a `badge`, and say what you merged.

## 3. Animate from a static image

- **Flows**: from the arrow directions. Put the request path (user to data) first, as `heavy` or `normal`
  flows on those edges; secondary or dashed edges are `normal` with a lower `rate` (for example 0.5).
- **Steps**: add `steps` only when the image implies a sequence (numbered arrows, "1 -> 2 -> 3", step badges) or
  the user asks. One step per number, in order, each with a `caption` taken from the labels (for example "1. Client
  calls Ingress") and `flows` set to that edge only. Otherwise no steps: one looping animation.
- Do not invent failures, scaling or metrics that the image does not show.

## 4. Finish

Validate, fix, build as in the main workflow (never hand-write SVG). Then report in this shape:

```
Wrote <name>.cosmo.json and <name>.svg (paths from pcosmo build).
What I read from the image: <n> components (<names>), <n> groups (<names>), <n> connections, <sequence or not>.
Assumptions: <each guess: unreadable label, type chosen for an unclear shape, direction chosen for a plain line,
anything merged or left out>.
```

Offer to correct any assumption, keep the original layout, or add steps.
