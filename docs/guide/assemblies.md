# Assemblies: racks, close-ups and builds

Schema revision 1.2.0 adds **assemblies**: units made of parts that a step can explode, implode,
build or unbuild. This page covers the data-center side (Phase 2): racks whose devices slide out,
servers with internals, close-ups that go from the hall down to a single part, build programs and
the parts callouts. The full design is in `docs/design/assemblies.md` in the repository; this page
is the working summary.

The gallery example **From the hall to the heat sink** (`pcosmo examples show hall-to-heatsink`)
uses everything on this page: a hall, a rack, a server built from its board plan, and a heat-sink
installation figure as the deepest close-up.

## Steps drive everything

Assemblies move only when a step says so, in `steps[].assembly`:

```json
{
  "caption": "Rack R2: the app server slides out",
  "assembly": [{ "explode": "r2" }],
  "focus": "r2",
  "duration": 4
}
```

| Action    | Moves                                                                       |
| --------- | --------------------------------------------------------------------------- |
| `explode` | an explode program forward, to stage `to` (default: the last one)           |
| `implode` | the exact time reverse, back to stage `to` (default 0)                      |
| `build`   | a build program forward: `to` a step, or `advance` some steps (default one) |
| `unbuild` | the reverse of a build                                                      |

Each action may name a `program` (default: the target's default program) and a `start` (seconds
into the step's motion window). Actions in one step play one after the other. If they do not fit
the step, they are compressed and `validate` says which `duration` would fit
(`assembly/compressed`). Levels are cumulative across steps, so an implode in step 6 undoes the
explode of step 3.

## Racks as assemblies

A rack becomes an assembly **only when a step action targets it** (or one of its slots). Every
other rack keeps its usual drawing, so existing specs render byte for byte as before.

- `explode: "r1"` plays the built-in `drawers` program: stage 1 opens the doors, stage 2 slides
  every device out of the front. `racks[].programs` can replace it with your own explode programs
  that select slot ids, `type:<slot type>` or `frame/...` parts.
- `explode: "r1/srv"` on a slot plays its access move first (the drawer slides out), then the
  slot's own program. A plain slot has no program of its own: target the rack, or give the slot
  internals.
- Cables and their particles hide while a slot they touch is out and come back with it.

### Slot internals

`racks[].slots[].assembly` names a **template** (`template: true`) that is the device's inside. The
device gets a tray, a removable lid and its face plate, and the template's parts sit inside at
true scale (the 450 mm interior of a 19-inch device). Its program `internals` lifts the lid, then
plays the template's default program:

```json
{ "id": "srv", "at": 20, "type": "server-2u", "assembly": "srv-internals" }
```

A template larger than the interior by more than 10% is shrunk to fit and reported
(`assembly/size-mismatch`, warning).

## Close-ups: levels of detail

The camera zooms at most 3x, so a hall cannot zoom down to a heat sink. A **close-up** is a finer
drawing of one node, shown as its own level when a step focuses it. Set `closeup` on a rack slot,
an assembly or a part; it names a template assembly or a figure (storyboard close-ups are not
drawn yet, so `validate` refuses them):

```json
{ "id": "srv", "at": 20, "type": "server-2u", "closeup": "srv-2u" }
```

The close-up is addressed explicitly through the reserved path segment `closeup`:

| Path                                 | What it is                                    |
| ------------------------------------ | --------------------------------------------- |
| `r2/srv`                             | the slot's device as the rack draws it        |
| `r2/srv/closeup`                     | the close-up instance (the `srv-2u` template) |
| `r2/srv/closeup/board/cpu-1`         | a part inside the close-up                    |
| `r2/srv/closeup/board/cpu-1/closeup` | that part's own close-up (a figure here)      |

- `focus: "r2/srv/closeup"` shows the level: it cross-fades in from the node's place on screen
  and grows to fill the view; leaving the focus reverses it. The level is drawn at its own
  scale, so lines and labels keep their normal width. If the camera has to move as well, it
  moves first (going in) or last (coming out), never while the level grows; a parent level stays
  still while a child level grows out of it.
- `focus` on a node inside a level (`r2/srv/closeup/board`) zooms onto that node.
- Actions name the instance: `build: "r2/srv/closeup"`, `implode: "r2/srv/closeup/board/cpu-1/closeup"`.
  Each instance keeps its own pose, also two hosts of the same template or figure.
- A figure or template that a `closeup` names is drawn **only** in its close-ups: it is not a
  panel of the main scene, and its bare id is not a target.
- Levels nest at most 4 deep, with at most 8 instances per spec (`budget/levels`); a path has at
  most 8 segments (`assembly/too-deep`).
- `closeup` is reserved as a path segment in 1.2.0 specs: a part id `closeup` is an error. In a
  plain 1.1 spec it stays an ordinary id, with a warning.

### Sizes

Physical units (`mm`, `cm`, `in`) are true scale in a data-center context (one floor tile is
600 mm). A template close-up of a physical host is reconciled with the host's interior: more than
10% too large on an axis is a warning and the template is shrunk; much smaller is an info and it
is drawn at true scale. Figures are pixel drawings and are not reconciled.

### Figure close-ups

A figure (a document drawing replayed with cut-out sprites, see the figure workflow) can be the
deepest level. In the example, both CPU sockets of the board plan show the heat-sink installation
figure as their close-up; the figure is drawn exploded (`pose: "exploded"`), so
`implode: "r2/srv/closeup/board/cpu-1/closeup"` seats the heat sinks. A figure close-up moves as a
whole: explode and implode only, no `program`, no path below the instance.

## Build programs

A build program adds parts step by step instead of moving them apart:

```json
{
  "id": "assemble",
  "kind": "build",
  "steps": [
    { "caption": "Board", "add": ["board/pcb", "board/cpu-*"] },
    { "caption": "Fans, PSU, drives", "add": ["fan-*", "psu", "sled-*"] },
    { "caption": "Cover", "add": ["lid"] }
  ]
}
```

- `build` and `unbuild` play it (`to`, or `advance`). Parts no step adds are the base and are
  there from the start.
- `from` says where added parts come from: `above` their seat (default), `outside` the model,
  an axis, a vector, or `callout`.
- `view` turns the view a quarter turn from that step on (assembly-only specs).
- `subBuild` builds a sub-assembly first at a staging spot, then docks it.
- `pose: "empty"` starts the assembly empty; the loop fades parts in and out so it restarts
  without a jump.

### Parts callouts

`from: "callout"` steps show a parts box (a thumbnail and `<count>x` per kind) inside the step's
camera window, and each part flies from the box to its hover point before it drops into its seat.
The box never widens the zoom; thumbnails shrink when space is short (`layout/callout-truncated`
when a step has more kinds than fit). `callout: true` shows the box without flights.

## Labels

A stage with `labels: "show"` shows the label of each part it moves, with a leader line. Instances
of one counted part (`count`) moved together share one label. `labels: "always"` on an assembly
prints each part's label on its top face while the part is seated (for board plans); a part placed
with `use` follows the template it uses, and a bank of counted parts gets one label. A zoom never
cuts a label: it widens once to hold the step's labels, and a label it still cannot hold (or that
would sit under the caption) is hidden for that step. A labelled part that is not drawn is always
reported (`assembly/label-omitted`, info) with the reason and a pointer to the part.

## Checking a spec

`pcosmo validate` runs every check of this page before anything is drawn: unknown targets and
programs (with a did-you-mean), stages out of range, explode or build backwards, close-up sizes and
depths, figure close-up actions. `pcosmo build` reports depth-order and timing notes as infos; an
info about a part hidden while it crosses another (`assembly/clip-fallback`) names the part.

```sh
pcosmo examples copy hall-to-heatsink
pcosmo validate hall-to-heatsink.cosmo.json
pcosmo build hall-to-heatsink.cosmo.json --static --steps --png --time 21
```
