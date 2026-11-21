# Assemblies and programmable explode/implode (schema 1.2.0)

Status: design, for review. Schema and contract types land with this document, together with
the merge guard: `validate` rejects every 1.2.0 field with `assembly/unsupported` until the
phase that renders it lands ([tracks](./assemblies-tracks.md) §0). No engine code otherwise.
Companion documents: [document ingestion](./document-ingestion.md) (PDFs, booklets, figures,
`pcosmo assets`) and [tracks](./assemblies-tracks.md) (implementation split, PR sizes, tests).
Section numbers (§) are referenced from `packages/core/src/contracts/assembly.ts`.

Contents: 1 concepts · 2 tour · 3 spec surface · 4 frames and units · 5 parts · 6 programs ·
7 timing · 8 racks, nesting and close-ups · 9 depth order · 10 bounds · 11 images ·
12 outputs and motion · 13 budgets · 14 storyboards · 15 figures · 16 TypeScript builder ·
17 suggestion heuristics · 18 diagnostics · 19 examples · 20 out of scope · 21 open questions

---

## 1. Concepts

| Term           | Meaning                                                                                                                                                                                                                                |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Assembly**   | A component-driven unit (`assemblies[]`): a rack, a server, an engine, a brick model. Drawn assembled in the iso view; its parts move under programs.                                                                                  |
| **Part**       | A node of the assembly tree. A **leaf** is drawn (a primitive, a pack shape, an image card or sprite). A **sub-assembly** (a part with `parts` or `use`) only groups: it moves as one rigid unit unless a selector picks its children. |
| **Path**       | Scene id of a part: `<assembly>/<part>/<child>…` (up to 8 segments). Racks use `<rack>/<slot>/…`. Paths are valid `focus` targets and `set` keys.                                                                                      |
| **Template**   | An assembly with `template: true`, never drawn by itself; instanced by `parts[].use`, `racks[].slots[].assembly` or `closeup`.                                                                                                         |
| **Program**    | `explode` (ordered **stages**) or `build` (ordered **build steps**), owned by an assembly or a sub-assembly.                                                                                                                           |
| **Pose**       | Per program a **level**: stages applied (explode) or build steps done (build). Poses are cumulative across spec steps, like states.                                                                                                    |
| **Action**     | A pose change in a spec step (`steps[].assembly[]`): `explode`, `implode`, `build`, `unbuild`.                                                                                                                                         |
| **Base pose**  | `assemblies[].pose` (default `assembled`): what the static output, poster, default PNG and reduced-motion rest frame show (D27).                                                                                                       |
| **Storyboard** | Tier A of document ingestion: the document's own step renders and part thumbnails, played as a flat build (no 3D, no explode).                                                                                                         |
| **Figure**     | Figure mode: a document figure animated in its own drawn plane with cut-out sprites (exploded ↔ seated).                                                                                                                               |
| **Close-up**   | A finer representation (template assembly, figure or storyboard) of a part, shown as its own level when a step focuses it (hall → rack → server → board).                                                                              |

Engine rules carried over unchanged: deterministic output (byte-identical), no runtime network,
labels escaped, no external references, the schema is the source of truth, Claude only writes
the spec.

## 2. Tour

```json
{
  "meta": { "version": "1", "title": "Two-part box" },
  "assemblies": [
    {
      "id": "box",
      "units": "mm",
      "parts": [
        { "id": "base", "shape": "tray", "size": [300, 200, 80], "role": "shell" },
        { "id": "lid", "at": [0, 0, 80], "size": [300, 200, 10], "role": "cover", "label": "Lid" }
      ],
      "programs": [{ "id": "open", "stages": [{ "parts": ["lid"], "direction": "up" }] }]
    }
  ],
  "steps": [
    { "caption": "Closed", "duration": 2 },
    { "caption": "Lid off", "assembly": [{ "explode": "box" }], "focus": "box" },
    { "caption": "Closed again", "assembly": [{ "implode": "box" }] }
  ]
}
```

## 3. Spec surface (additive, schema revision 1.2.0)

New root fields: `assemblies[]` (≤ 50), `images[]` (≤ 256), `storyboards[]` (≤ 10),
`figures[]` (≤ 20). A spec now needs at least one of `nodes`, `racks`, `equipment`,
`assemblies`, `storyboards`, `figures`. Changed fields (all loosening, so additive):

| Field                                                                | Change                                                                         |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `steps[].assembly`                                                   | new: up to 20 actions per step                                                 |
| `steps[].focus`                                                      | now `SpecPartPath` (any id path), was `SpecEndpoint` (one `/`)                 |
| `steps[].set` keys                                                   | now `SpecPartPath`, so part states can change (`"engine/head": "highlighted"`) |
| `racks[].programs`                                                   | new: explode programs only (no build programs) for a rack as an assembly       |
| `racks[].slots[].assembly`                                           | new: template assembly as the device's internals                               |
| `racks[].slots[].closeup`, `parts[].closeup`, `assemblies[].closeup` | new: close-up level, addressed through the reserved path segment `closeup`     |

`edges`, `flows` and `cables` endpoints are unchanged: they may name an assembly, storyboard or
figure id (attached at its rest bounds), never a part path (§20). `pcosmo migrate` is
unaffected (no major change). Older engines reject the new root fields with the existing
"upgrade platformcosmo" diagnostic.

Field semantics are in the schema descriptions (`schema/v1.json`); the rules that need more
than a sentence follow.

## 4. Frames, units, coordinates

- **Local frame.** Each assembly has a right-handed frame matching the world axes: `x` to the
  lower right, `y` to the lower left, `z` up. `at` is the minimum corner of a part's box in
  its parent's frame (children of a sub-assembly are relative to the sub-assembly's `at`).
- **Units** (`units`, default `mm`): `mm`, `cm`, `in`, `tile` (one world grid tile, 600 mm in
  the DC pack) and `stud` (x, y in 8 mm studs; z in 3.2 mm plates; a brick is 3 plates).
- **Scale.** `world = origin + R(rotate) · (scale ⊙ local)`, `scale` per axis
  (`AssemblyFrame`). Top-level assemblies with physical units are scaled so the assembled
  unit's largest horizontal extent is `fit` tiles (default 6). Inside a DC rack slot and in a
  close-up of a physical part, physical units use **true scale** (1 tile = 600 mm, `fit`
  ignored) so sizes reconcile across levels (§8.5).
- **Rotations** are quarter turns about `z` only: `parts[].rotate` turns the part about its
  own box centre (90/270 swap width and depth; `at` is the minimum corner of the rotated box);
  `assemblies[].rotate` turns the whole unit. Cylinder, ring and shaft axes are `x`, `y` or `z`.
  Nothing else rotates, so every face stays axis-aligned and every motion is a translation.
- **Screen mapping** (default tile 64): a world vector `(dx, dy, dz)` moves a group by
  `((dx − dy)·32, (dx + dy)·16 − dz·32)` user units; `+x` → `(32, 16)`, `+y` → `(−32, 16)`,
  `+z` → `(0, −32)` per tile. The projection is linear, so a part's motion is exactly a CSS or
  attribute `translate` of its group.
- **Placement.** Non-template assemblies are laid out like nodes by A2 using their **reach
  bounds** footprint (every reachable pose, §10), so an exploded unit never lands on a
  neighbour; `pos` overrides. With DC content they go beyond the DC bounds in `+x` (as nodes).

## 5. Parts

| Field                      | Default                   | Semantics                                                                                                                            |
| -------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `shape`                    | `box`                     | Primitive (`box`, `plate`, `cylinder`, `ring`, `shaft`, `stud`, `prism`, `wedge`, `tray`, `card`, `sprite`) or `pack:id`             |
| `at` / `size`              | `[0,0,0]` / shape default | Box in the parent frame; sub-assemblies default to the bounds of their parts                                                         |
| `axis`                     | `z`                       | Cylinder, ring, shaft                                                                                                                |
| `rotate`                   | `0`                       | Quarter turn about z                                                                                                                 |
| `tone` / `color`           | `base`                    | Theme part tone, or a spec color (hex, palette or flow name)                                                                         |
| `image`                    | none                      | Billboard (upright, never skewed, scaled to the silhouette) or decal on `top`, `left` (+y), `right` (+x)                             |
| `count` / `pitch`          | `1`                       | Repeat: copies `<id>-1 … <id>-n` when count > 1 (count 1 keeps `<id>`), offset by `pitch` (a sub-assembly repeats with its children) |
| `role`                     | inferred                  | `body`, `cover`, `fastener`, `internal`, `cable`, `shell` (§17)                                                                      |
| `mates`                    | inferred                  | Sibling it sits on or in; `away` leaves the contact face                                                                             |
| `inserts`                  | inferred                  | Solid sibling it passes into (valve through a head): clipped at the entry face, never a collision (§9.5)                             |
| `type`, `tags`             | none                      | For `type:` / `tag:` selectors, callouts and heuristics                                                                              |
| `label`, `detail`, `badge` | none                      | Shown per stage settings once exploded (§6.6)                                                                                        |
| `state`                    | parent's                  | Healthy/degraded/down/highlighted, same CSS as objects                                                                               |
| `use`                      | none                      | Instance a template as this part's sub-assembly (scaled to `size` when set)                                                          |
| `closeup`                  | none                      | Close-up level (§8.4)                                                                                                                |
| `source`                   | none                      | Document provenance (§11.6)                                                                                                          |

**Primitives** (`PartPrimitiveKind`): `box`, `plate` (thin box), `prism` (vertical hexagonal),
`wedge` (45°-class slope, a right-triangle prism, high side at `−x` before `rotate`), `card`
(thin upright plate carrying an image billboard on its visible face), `cylinder`, `shaft` (thin
cylinder), `stud`, `ring` (hollow cylinder, two depth items), `tray` (open-top box, two depth
items), `sprite` (no solid: the image covers the box's screen silhouette, depth from the box).
Faces use four-tone shading from `ThemeTokens.parts` (or the spec color with the theme's
top/left/right lightness offsets). Circular primitives along `x`/`y` are new geometry (A1); the
existing `PrimitiveKind` union is untouched so its exhaustive maps stay source-compatible.

**Pack shapes** (`PartShapeDef`, wired through `RenderOptions.parts` like icons, D4): `dc:`
(rack devices, from dc-pack), `hw:` (server internals: `board`, `cpu`, `heatsink`, `dimm`,
`gpu-card`, `nic-ocp3`, `nvme-m2`, `e1s`, `psu`, `fan`, `riser`, `pcie-card`, `chassis-2u`,
`lid`), `auto:` (engine starter set: `block-i4`, `head`, `valve-cover`, `crankshaft`,
`camshaft`, `piston`, `rod`, `valve`, `oil-pan`, `intake`, `exhaust`, `timing-belt`) and
`brick:` (stud grid, §5.1). A shape's `build` returns `PartGeometry` (primitives in its local
frame, `bounds`, `depthBox`, `solid`, optional `split`). Shapes are generic and vendor-neutral
(no trade dress, no trademarks, no vendor names); standards-body interface and form-factor names
(M.2, E1.S, OCP 3.0, PCIe, NVMe, CRPS) may be used descriptively in ids, labels and docs.
`hw:` shapes have one canonical orientation (x width, y depth, z height, mm), devices with a
front put it at +y, and `depthBox` is the solid core (fingers, ears, handles, sockets and
connectors are drawn but excluded, like brick studs). Use the part's `rotate` to turn a shape;
`hw:e1s` also takes `params.orientation` (`flat` | `upright`).

### 5.1 Stud-grid bricks (`@platformcosmo/parts-brick`, Track E)

`brick:brick`, `brick:plate`, `brick:tile` (no studs), `brick:round` (cylinder, `axis` any),
`brick:slope` (a wedge; 45°-class only: the sloped face is a planar quad, so it projects to a
parallelogram and sorts as a convex solid), with `params.studs` (default true; false for
tiles), `params.inverted` (slopes). Sizes in `units: "stud"`: `[w, d, plates]` (brick height 3,
plate 1). Positions are integers on the stud/plate grid (non-integers: warning
`brick/off-grid`). Studs are drawn as small iso cylinders, emitted as two compound paths per
part (sides, tops): with pitch 8 mm, diameter 4.8 mm and height 1.7 mm no stud overlaps another
on screen (in `hh` = tile/4 units a stud spans x ±6.79 and y [−6.79, 3.39]; the nearest
neighbours are offset (±16, 8) and (0, 16)), so merging cannot break painter's order. `depthBox`
excludes studs, so stacked bricks do not interpenetrate (§9.6). Colors: spec `color`
(palette names or hex). Out of scope: hinges, non-90° rotations, flexible parts, Technic pins
and axles at angles, curved slopes; the skill says so and approximates or skips with an
assumption note.

## 6. Programs

### 6.1 Selectors

```
selector = *( scope "/" ) term            ; at most 7 scope segments
scope    = "**" / glob                    ; glob: 1*( a-z / 0-9 / "-" / "*" / "?" )
term     = "**" / glob / kind ":" glob    ; kind: tag | type | role
```

Selectors are evaluated against the **program owner** (the assembly or sub-assembly that owns
the program; for racks, the rack). A term with no scope matches the owner's **direct children
only**: `cyl-*`, `type:dimm`, `role:cover`. Scopes reach deeper: `head/valve-*` (children of
`head`), `**/type:dimm` (any depth), `frame/role:cover` (rack doors). `*` matches within one
segment, `?` one character, `**` any number of segments (as a term: every descendant). `parts`
is a union; `except` subtracts. A selected sub-assembly moves as one unit with its subtree.
Matching runs over the expanded tree (after `count` and `use`), in depth-first spec order.
The scene matches roles as resolved (explicit, pack shape, inferred), while validation sees explicit roles only, so a `role:` selector can select more parts in the scene than validation can prove; a part selected by two stages that way is reported as `assembly/moved-twice` (info) and moves once, in the first stage.
A rack's selectors match over the rack as the DC pack builds it (§8.1: frame parts, device parts, and around a slot template the pack's `tray`, `lid`, `faceplate/…`, `rear/…`); `validate` given the DC pack checks them over that same tree, and without it treats the frame and plain slots as opaque (nothing below them is reported).
Empty match: warning `assembly/selector-empty` with did-you-mean over candidate paths (the
existing bounded edit distance; deeper matches are suggested as `**/…`). A node may be moved by
at most one stage per program (`assembly/moved-twice`); a descendant of a node moved earlier
may move again (moves compose by addition, §9.3). `overrides` keys are paths relative to the
program owner.

### 6.2 Direction presets

Computed in the owner's local frame, then rotated to world. `c` = part centre − owner centre.

| Preset                    | Unit vector                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `up`, `+z` / `down`, `-z` | `(0,0,1)` / `(0,0,−1)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `+x` `-x` `+y` `-y`       | axis vectors                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `away` (default)          | leaves the mate: a part with `inserts` goes along the outward normal of the entry face it crosses; otherwise the direction from the contact face of its mate (spec `mates`, else the touching sibling with the largest contact area) toward the part; else, enclosed by a sibling, the shortest exit; else, interpenetrating a sibling without a face contact (generic push-out), the axis of least penetration on the side of its centre; else `out`. Ties prefer `+z, +y, +x, −x, −y, −z` (visible directions first). The mate and `inserts` checks are always made; the full sibling scan is skipped in groups over 400 siblings (reported as `budget/time`). |
| `out`                     | the horizontal axis with the larger `                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | c   | `, signed; ties follow the visible-first order in every quadrant (`+y`before`+x`before`−x`before`−y`); `c = 0`: up |
| `radial`                  | `normalize(c.x, c.y, 0)`; `c = 0`: up                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `axis`                    | the part's `axis`, signed by `c` on that axis (+ when 0)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `drawer`                  | the owner assembly's `front` (world `front` after `rotate`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `lift`                    | `+z`, every selected part on its own layer (§6.3)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `[x,y,z]`                 | normalized vector                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

Overrides (`stage.overrides[path].direction`) replace the stage direction for one part.

### 6.3 Distance and automatic stacking

`distance` is a number (owner units), `"auto"` (default) or `"<k>x"` (k × auto). Auto
distances are computed **per program**, before timing, so every stage's final positions nest.

1. Group the program's moves by world direction `u`. For each axis-aligned `u`, sort movers by
   `(max_u, min_u, path)` ascending (inner first).
2. `clear(p)` = the larger of `extent_u(p) + gap` and, over static parts `e` overlapping `p` in
   the plane ⊥ `u` and along `u`, `e.max_u − p.min_u + gap`; for `drawer`, also
   `owner.max_u − p.min_u + gap` (the part leaves the unit completely).
3. `D(p)` = the larger of `k·clear(p)` and, over earlier movers `q` overlapping `p` ⊥ `u`,
   `q.max_u + D(q) + gap − p.min_u`. For `lift`, every earlier mover counts as overlapping (one
   layer per part; parts with equal rest `min_z` share a layer).
4. Non-axis directions: `D(p) = k·(extent along u + gap)`, no stacking. Numbers: `D(p) = n`.

`gap` is `programs[].gap`, default 10% of the owner's largest extent. Result: for any two
footprint-overlapping movers along `u`, the outer one ends at least `gap` beyond the inner one,
and every mover clears its seat.

- **Collisions.** A final pose with interpenetrating leaves (not explained by `inserts` or
  enclosure) is a warning `assembly/collision` (defined here, not emitted yet). Leaves whose boxes interpenetrate at any
  sampled time of a transition (the bisection samples of §9.3) are a warning
  `assembly/transit-collision` naming both paths and the time: moves are straight lines and
  the engine does not plan paths around obstacles.
- **Below ground.** Every pose must keep leaves at `z ≥ 0` (the ground and group slabs are
  drawn in a layer below objects, so a part under them would be painted on top). For spec
  assemblies the frame is lifted so the reach bounds start at `z = 0` (the oil pan's drop is
  absorbed by raising the whole unit, rest pose included). DC racks stand on the floor and are
  not lifted: a rack or slot move with negative world `z` beyond the floor is an error
  `assembly/below-ground`.

### 6.4 Order, stagger, overrides

Within a stage, movers are ranked by `overrides[path].order` first, then by `order`: `spec`
(depth-first spec order), `outside-in` / `inside-out` (distance from the owner centre),
`top-down` / `bottom-up` (`max_z` / `min_z`), `front-first` / `back-first` (centre depth key
`x + y + z`, nearer the viewer first); ties by path. Rank `r` starts at
`S + r·stagger + overrides.delay`.

### 6.5 Build programs

A build step makes `add` leaves visible and moves them from an origin to their seats. Leaves no
step adds are the **base** (always present). Origins (`from`, default `above`):

- `above`: `+z` by the auto distance that clears every placed part over the seat footprint;
  blocked paths (a placed part above the seat) give `assembly/build-path-blocked`, suggesting a
  side origin.
- `outside`: along the horizontal axis with the shortest path out of the current model bounds.
- `+x`, `-x`, `+y`, `-y`, `[x,y,z]`: that direction, auto distance as §6.3.
- `callout`: a screen-space flight from the step's callout slot to a hover point above the
  seat, drawn in the overlay layer (no depth issue there), then a world drop from the hover
  point (§7.6).

`subBuild` builds a sub-assembly at a **staging** offset first (beside the current model along
`+x` by `gap`, or `−y` when `+x` leaves the canvas reach), using its own build program
(`program`, default its first), then attaches it as one unit along the straight line from
staging to seat. The parts **callout** groups the step's leaves by (shape, size, color, image)
as `count × thumbnail` (thumbnail = the leaf drawn at a fixed callout scale, or its image).
`view` rotates the view a quarter turn from that step on (§7.7). `unbuild` plays steps in
reverse (time-reversed, §7.2).

Animation (B-3, `render/assembly/builds.ts`): a built leaf is hidden until its move starts, then
fades in over 0.2 s while it travels from its origin to its seat; an unbuilt leaf fades out over
the last 0.2 s of its reversed move and vanishes when it ends (the exact mirror, easing mirrored
like an implode's). The depth order sees the same windows (`DepthItemInput.present`), so an absent
part takes no part. The loop-start fades are the contract's (`SceneAssembly.loopStart`); a part
whose own build starts before its fade-out ends is cut at its build start (never shorter than
1e-4 s, so time 0 still shows the base pose). The loop closure fades parts present at rest but
not at the end in, and the others out, over the last step's closing window.

Within a step the added nodes move **bottom-up**: ordered by their lowest face, ties by spec
order, then path; each starts `stagger` after the previous. Distances stack as in §6.3 against
the parts placed so far (the base and earlier steps), so a part never starts inside one that is
already seated. A node added by a later step that overlaps an earlier step's selection by
ancestor or descendant (a sub-assembly after one of its parts, or the reverse) adds only the
leaves not yet added, which move together as one rigid unit; validation reports it as
`assembly/moved-twice`. `build-path-blocked` tests each moving node's footprint box against the
placed parts entirely above its seat, so a sub-assembly whose footprint is L-shaped can be
reported although a clear column exists (a false positive; use a side origin).

### 6.6 Labels, leaders, details, fade

When a stage has `labels: "show"`, each moved leaf (or moved sub-assembly) shows its `label`
(and `detail` lines when `details`) once it arrives (fade in over the last 20% of its move),
and hides at the start of the reverse move. Placement is computed once per final pose: eight
candidate boxes around the part's screen bounding box at 18 px, preferring the side of the
part's screen motion vector, then clockwise from it; the first box not overlapping placed
labels or other parts' final boxes wins, else the first candidate nudged by the existing
`nudgeLabel`. Leader: a 1 px line from the nearest point of the part's silhouette box to the
label box, `leaders: false` removes it. Labels move with copy 0 of their part (same track) and
sit in the `labels` layer. `assemblies[].labels: "always"` also prints every leaf's label
upright on its projected top face at rest (truncated to fit, never skewed, like icons; for plans
and board layouts), switching to leader labels while exploded; `never` disables part labels.
`fade: "unselected"` dims (opacity 0.25) the owner's leaves not
moved by the stage while the stage's pose is shown; `fade: "others"` dims everything outside
the assembly (non-assembly objects get a `fadeWrap` group only when some stage uses it, so
other specs are byte-identical).

## 7. Timing

### 7.1 Program time

Stage `s` starts at `S_s = (with = after ? E_{s−1} : S_{s−1}) + delay_s` (`E_0 = 0`) and ends
at `E_s = max` end of its moves. A build step is a stage with its `add` leaves (sub-builds play
their own program first). All times are seconds at speed 1; B divides by `--speed`.

### 7.2 Actions and poses

An action moves a program from its current level `a` to a target `b`:

- `explode` (`to`, default all stages): stages `a+1 … b`, shifted so stage `a+1` starts at 0 (so its own `delay` has no effect; use the
  action's `start` to wait).
- `implode` (`to`, default 0): the **exact time reverse** of the explode segment `b+1 … a`:
  a move `[st, en]` becomes `[L − en, L − st]` with the mirrored easing
  (`cubic-bezier(x1,y1,x2,y2)` → `(1−x2, 1−y2, 1−x1, 1−y1)`). Depth epochs (§9) of an implode
  are therefore the explode's epochs reversed.
- `build` (`to`, or `advance` more steps, default 1 step): steps `a+1 … b`; `unbuild`: the time
  reverse. A build target below the current level is an error (`assembly/build-backwards`;
  use `unbuild`).
- A step's actions play in array order, each after the previous one, unless `start` places it.
- An action that does not change the level (implode at level 0, explode to the current stage)
  is kept with zero length and reported as `assembly/no-op-action` (info).
- Levels are cumulative across steps. The **timeline start** level of a program is the base
  pose's level, except for build programs whose first action starts at level `k − advance`:
  the timeline starts there (usually 0).

### 7.3 Step windows and compression

Step `i` spans `[T_i, T_i + d_i]`. Its **motion window** opens at `m_i = T_i + lead_i`
(`lead_1` = the opening camera transition when step 1 zooms, else 0; the other camera
transitions sit at the end of the previous step, D27) and closes at
`c_i = T_i + d_i − tr_i − 0.2` where `tr_i = min(0.8, 0.25·d_i)` is the closing camera
transition (0 when the next view is the same) and 0.2 s is a hold so the settled pose is seen.
For the last step `tr_n` also applies when the end pose of any program differs from its base pose and no camera transition follows (the loop closure of §7.4 needs that window). All times use the output clock: `tr` and `lead` are `min(0.8, 0.25·d/speed)` seconds of output, i.e. that many times `speed` loop seconds.
If the step's actions need `L_i > c_i − m_i`, all of them are compressed uniformly by
`scale = (c_i − m_i)/L_i` (`ResolvedAction.scale`), with `assembly/compressed` (info; warning
below 0.5) whose suggestion gives the duration that fits: `"duration": D`, the smallest whole
number of seconds with `D − lead(D) − tr(D) − 0.2 ≥ L_i`, where `lead(D)` and `tr(D)` are
`min(0.8, 0.25·D)` under the same conditions as above (0 when they do not apply). Step durations are never changed by the engine.

### 7.4 Rest frame, loop start and loop closure (D27 extended)

- **Rest frame** (static, poster, default PNG, `png.time = 0`, interactive before Play):
  every assembly in its base pose (default `assembled`; `pose: "exploded"` gives an exploded
  poster), full view, step-1 states.
- **Loop start**: when a build program's timeline start level differs from the base pose,
  the parts not present at that level fade out during `[0, max(lead_1, 0.4)]`, and the parts
  present at that level but not in the base pose (`pose: "empty"` with a build starting at 3)
  fade in over the same window. The scene lists these as `SceneAssembly.loopStart`, computed
  with the plan's own `lead_1`.
- **Loop closure**: during the last step's closing transition `tr_n` (with the camera's ease
  back to the overview) every program returns to its base level: explode levels by a fast
  implode (all moves reversed together, no stagger, compressed into `tr_n`); build levels by
  fades (parts present at rest but not at the end fade in, others out). Ending with an
  explicit implode step avoids the fast return; the skill does that. When the last step is not zoomed the window `tr_n = min(0.8, 0.25·d_n)` is still reserved at its end for the fast return, so the loop restart never snaps.
- **Focus on assemblies**: `focus` on an assembly, sub-assembly or part frames its box at the
  END pose of the step (`AssemblyRenderModel.focusRect(step, id)`), so an exploded unit fits
  the zoom; B uses it instead of `RenderModel.focusRects` when present.

### 7.5 Interactive Play/Step

The Step button pauses at each step's **settled** time (end of its motion, `settled[]`)
instead of its start when the step has actions; other steps are unchanged.

### 7.6 Callout flights

`from: "callout"` moves have `overlayDuration`: a copy of the leaf in the overlay layer flies
(screen translate, pinned against the camera like captions) from its callout slot to the
screen point of the hover pose, then the world copy appears at the hover pose (opacity swap at
the same instant and position) and drops to its seat.

### 7.7 Quarter-turn views

`view` (build steps, assembly-only specs: `assembly/view-needs-assembly-only` otherwise) rotates
the scene by −v about the centre of the union of the assemblies' rest bounds (one assembly: its own rest centre). Each used view is projected and depth-sorted
separately into its own `view(v)` group; at the build step's start the views cross-fade over
0.3 s. Decals on faces turned away are not drawn; billboards and sprites are view-independent
(pre-rendered sprites keep their drawn angle, which the skill notes). Cost: elements × views
(`budget/views` warning above 5000 total; the scene reports a lower bound, one element per primitive, and the renderer applies the same threshold to its real count). The per-view viewBox comes from the rotated `reachBounds`. Views need an assembly-only spec: figures and storyboards are refused too (`assembly/view-needs-assembly-only`). Decal faces are assembly-local data and are kept in every view; the renderer maps them through `frame.rotate`. Render model (A1-4): `AssemblyRenderModel.views` has one entry per view (0 included) with its own
model (projection, depth epochs, tracks, frames), group `ids.view(turn)` (objects, then labels;
views other than 0 rest at opacity 0) and `viewBox`; ids of a view other than 0 carry the
suffix `__v<turn>`, images keep one definition. Caps run before any build: at most 4 views, and
2 x 2000 leaves built over main, levels and views (`budget/views`, error); the real element count
over all views above 5000 gives `budget/views` (warning).

## 8. Racks, nesting, close-ups

### 8.1 Racks as assemblies (byte-identical by construction)

A rack becomes an assembly **only when a step action targets it or one of its slots** (a path
through a close-up, `r2/srv/closeup/…`, targets the close-up instance, not the rack; `programs`,
slot internals or close-ups alone do not either). All other racks keep the 1.1 objects
(`rackId`, `rackId_front`, `rackId/slot`) and their forced depth ranks, so every existing spec
and gallery render stays byte-identical. Validation (`assembly/reserved-id` for a slot `frame`),
the scene and the DC pack share this rule. For a targeted rack, `DcPack.buildAssembly` returns
a `SceneAssembly` (source `dc`), which the scene draws instead of the rack's 1.1 objects (their
boxes still serve routing, overlaps and focus). The scene resolves the racks, the spec
assemblies and the close-up instances with **one** planner (one work budget, one level machine,
one step plan): the DC pack registers each rack's synthetic `drawers` and `internals` programs
with it.

- `<rack>/frame/<part>`: one leaf per rack part (posts, side panels, base, top cap, doors,
  PDUs, rear-door heat exchanger) with roles (`shell`, doors and panels `cover`). No `_front`
  union object and no forced ranks: geometry decides (§9.7 proves this is needed).
- `<rack>/<slot>`: one sub-assembly per occupied slot, leaves = the device's parts
  (faceplate, body, LEDs). Slot ids `frame` are reserved in assembly mode
  (`assembly/reserved-id`).
- `front` = the rack's front side in world (mirrored rows: `−y`), so `drawer` slides devices
  out of the front. A rack in a mirrored row is **turned half a turn** (a row facing the other
  way), not reflected: asymmetric details (a single PDU, a device's LED side) change sides
  relative to the 1.1 look, which reflected only `y`. The DC pack records which racks it
  mirrored (`buildDcScene` keeps the flag beside the fragment, so the fragment's bytes do not
  change).
- A **cover** (door, panel, lid) given `direction: "drawer"` leaves along its own outward normal,
  not the owner's front: the rear-door heat exchanger goes rear (`−front`), a cover on the front
  side goes front, so a door never slides through the devices.
- Built-in program `drawers` (when `racks[].programs` has none): stage 1 doors (`frame/role:cover`,
  `drawer`), stage 2 every slot (`drawer`, `top-down`, stagger 0.1 s). Custom `programs` are
  explode programs only (the schema refuses build programs on racks) and select slot ids,
  `type:<slot type>` and `frame/…`; `to` is checked against their stage count.
- Cables (and their flows) touching a displaced slot are hidden while it is displaced
  (opacity track on the cable segments), and reappear when it is back.

### 8.2 Slot internals

`racks[].slots[].assembly: "<template>"` makes the device a sub-assembly with internals: the DC
pack builds the device as `tray` + `lid` (role `cover`) + faceplate, and the template's parts
are placed inside at true scale (template units must be physical; a template larger than the
interior by more than 10% is a warning `assembly/size-mismatch`; it is always scaled down
uniformly to fit, as in §8.5). The interior is
the 19-inch one, 450 mm wide and centred in the chassis (§8.5); devices are front-mounted, so
the template's front (its maximum `y`) meets the interior's front and its minimum `x` and `z`
meet the interior's side and floor. A template with no parts keeps a lid-only `internals`
program (1 stage) and a `assembly/size-mismatch` warning. The slot's own
program is `internals`: lid up, then the template's default program (its `program`, else its
first explode program), so it has 1 + that many stages; if the template's `program` is a build
program, `internals` has 1 + its step count. Templates do not carry their own chassis or lid.
Internals exist only in assembly mode (§8.1): a rack no action targets draws its 1.1 device, so
its slot `assembly` is never built and gets no size check (validation still checks the reference
and the path depth); the size check runs, in `validate` and in the scene, once the rack is
targeted.

### 8.3 Nested targets and implicit access

Exploding a nested target (`explode: "r1/srv"`) whose ancestors are not displaced first plays
the target's **access move**: its own move in the parent's default program (a slot's drawer).
The access move is ONLY the target's own move in the parent's default program (a single slot drawer), not every move of the stages up to it. It is listed in `ResolvedAction.implied` (with `only`, the moved path; `accessLength` is its share of the action's length, first on an explode, last on an implode), reported as `assembly/implicit-access` (info) and reversed by the matching implode, unless an explicit action on that parent program has taken it over in between. Nesting depth ≤ 8 path segments.

### 8.4 Close-ups (levels of detail)

Camera zoom is capped at 3× (timeline `MAX_ZOOM`), so hall → heat sink cannot be one zoom.
`closeup` names an assembly (template), figure or storyboard drawn **instead of** the node when
a step focuses the node's close-up. Each close-up is an **instance** with its own pose and its
own path, addressed **explicitly** through the reserved segment `closeup`:

| Path                                 | Addresses                                           |
| ------------------------------------ | --------------------------------------------------- |
| `r2/srv`                             | the coarse slot device (DC 2U box)                  |
| `r2/srv/closeup`                     | the close-up instance (the `srv-2u` template)       |
| `r2/srv/closeup/board/cpu-1`         | a part inside the close-up                          |
| `r2/srv/closeup/board/cpu-1/closeup` | the heat-sink figure instance shown for that socket |

`focus` on a `…/closeup` path (or a path inside it) shows that level; actions name the instance
by its path (`build: "r2/srv/closeup"`), never implicitly through the coarse node. `closeup`
is reserved only after the first path segment and only in specs with 1.2.0 content: a child id
`closeup` (under any part) is an error (`assembly/reserved-id`); in a plain 1.1
spec `closeup` stays an ordinary id (a node `closeup`, a slot `r1/closeup`) with a warning
(`semantic/reserved-id`) suggesting a rename before close-ups are added. Two parts
using the same figure as close-up get two independent instances. A close-up's pose persists
while it is not shown.

Each level is a sibling group of the main camera (`ids.level(id)`) with its own camera and
overview transform. Entering runs during the focus transition: the parent camera zooms toward
the node (≤ 3×) while the level cross-fades in, starting with its rest bounds mapped onto the
node's zoomed screen rect and easing to its own overview; leaving reverses it. Levels nest
(≤ 4 deep, ≤ 8 instances per spec). Per-step outputs and frames render the level in effect.
Element and byte budgets count every level.

**Render model (A1-4).** `AssemblyRenderModel.levels` has one entry per level, sorted by path.
The level group (`ids.level(path)`) sits in the overlay layer inside the camera group, with
`transform = overview` and `opacity 0` at rest. All rects are screen rects;
a level has its own coordinates (its world projected), `overview` places them in the main
viewport (its reach contained in the main overview area), `hostRect` is the host box seen
through the parent's overview and `hostFocus` the camera rect that frames it. The cross-fade
starts at `enter` (the level's rest bounds contained in the host's rect, centred, so there is
no jump; `fromHost(zoomed)` gives the same for the camera's zoomed rect) and eases to
`overview`; `hostAt(step)` follows a host that moved. Focus ids inside a level resolve in the
level's own world through its overview (`focusRect`), margins in viewport pixels. Figure and
storyboard levels carry the geometry and an empty group; their fit is a placeholder for R-2.
`frameAt`/`stepEnd` merge the states of the main scene, every view and every level, including
the opacity of each view group (linear over 0.3 s at the build step's start) and of each level
group (linear over the camera transition into its step), and the level groups' placement
(zoom 1). **Animation (B-3).** The cross-fades are keys on the loop clock
(`AssemblyRenderModelX.groups`, `render/assembly/groups.ts`): opacity per view and level group,
placement per level group. `frameAt` and `stepEnd` evaluate them and the animator writes them as CSS
(`opacity` and `matrix(s,0,0,s,tx,ty)` keyframes on the group, retimed by the camera windows like
every other track), so a frame equals the CSS pose at the same time; a group whose keys never change
(a level that is never shown) gets no animation. Reduced motion snaps each group to its step-end
state. The models of every view and level are animated under their own ids (`views[].model`,
`levels[].model`), on the same loop clock. The level group sits inside the camera group, so the parent camera composes the zoom: its
placement keys are the zoom-1 ones (entry from `fromHost(hostAt(k - 1))` to `overview`, leaving
reverses it, and the closing window of the last step leaves the level too, so the loop restarts
without a pop; while invisible it waits at the next entry pose). The main world's layer groups
(objects, labels, flows) cross-fade against the level over the same windows, emitted only when
levels exist. The
top-level `focusRect` answers world ids in the view in effect (`plan[step - 1].view`); ids
inside a level are answered by `levelFocusRect(step, id)` in overlay coordinates and are not in
`RenderModel.focusRects`. Close-ups and views do not combine (`assembly/view-needs-assembly-only`).

### 8.5 Size reconciliation

Physical units are true scale in DC context (1 tile = 600 mm; 19-inch rack interior 450 mm
wide, 2U = 88.9 mm). A close-up of a physical part with a physical template is reconciled by
**containment in the part's interior** (a DC slot: the 450 mm interior of the 540 mm device
box; any other host: its box), per axis in world axes. A rack slot's `closeup` hosts a level
whether or not the rack is targeted (`DcPack.slotHosts`): the host box is the slot's 1.1 object
(a targeted rack: its drawn slot device), the interior is the one slot internals use (450 mm
wide, inside the walls, under the lid) and the front is the rack's front in world (`-y` in a
mirrored row, so the template is turned half a turn). The template front is turned onto the
host front in world axes (the host assembly's `rotate` included); the scene never turns a
template to fit its footprint. Only a template larger than the interior by more than 10% on an
axis gives `assembly/size-mismatch` (warning) and is shrunk uniformly (contain); a template
shorter in z never warns; a template under 50% of the interior in x or y gets an info and is
drawn at true scale, never enlarged. A footprint that would match better turned a quarter is
reported (`assembly/closeup-turned`, info) and left alone. Close-ups the scene cannot build
within the 8-segment path limit (host path plus template height) or the level caps are skipped
with `assembly/too-deep` or `budget/levels`, at the host's pointer. The host path accumulates
along a chain of close-ups (`r2/srv/closeup/board/cpu-1/closeup/…`), and validation measures
each reference along every chain that reaches it, so it reports the same `too-deep` at the same
pointer before the scene is built. `pcosmo validate` and `build` report these checks only when the spec has no errors (a gated or invalid spec never reaches the scene). Figures and
storyboards (pixel units) are fitted to the part's zoomed screen rect. The skill takes real
dimensions from documents (a 13-inch board is 330 mm) and states assumptions when a figure is
"not drawn to scale" (keep relative layout, scale from the stated board size).

## 9. Depth order

### 9.1 Items

The objects layer of a spec with assemblies is ordered by this algorithm over **items**:
leaves (or the `back`/`front` halves of split leaves: `tray`, `ring`), plus every other scene
object and cable segment (static). Items use `depthBox` in world space at the current pose.
Without assemblies, the 1.1 `depthOrder` path is used unchanged.

### 9.2 Static rule

For one pose the order is the existing algorithm: pairs overlapping on screen get an edge from
`compareBoxes` (behind on an axis, else containment), else centre depth, then a deterministic
Kahn sort with id tiebreak; plus the forced edges of §9.5. Hidden items take no part.

### 9.3 Transitions: certified epochs

A leaf's displacement at time `t` is the sum of the moves of itself and its ancestors
(`d(t) = Σ_m o_m(t)`). Each move `m` runs along a fixed vector with a monotonic easing, so over
any interval `[t0, t1]` its offset stays on the segment between `o_m(t0)` and `o_m(t1)`, whose
AABB is the interval `I_m = [min, max]` per axis. Moves that overlap in time (a drawer and its
lid, `with: previous`, overlapping stagger, nested actions) compose **concurrently**, so the
leaf's path is not a straight segment; the **swept box** is therefore the rest box plus the
Minkowski sum of the per-move intervals: `sweep = box ⊕ Σ_m I_m` (per axis: add the interval
ends). This is sound for any number of concurrent composed moves (the Minkowski sum of
segments contains every point of the composed path) and equals the hull of the endpoints when
only one move is active.

1. Split the loop at every move start and end of every node (phases).
2. For each pair of items whose swept screen rects overlap in the phase, try to **certify** a
   relation for the whole phase with the swept boxes, using only the separating test (`a`
   behind `b` if `max_a(axis) ≤ min_b(axis)` on some axis). Proof: if
   `sweep(a).max_x ≤ sweep(b).min_x` then for all t in the phase
   `a(t).max_x ≤ sweep(a).max_x ≤ sweep(b).min_x ≤ b(t).min_x`. Containment is never inferred
   from swept boxes.
3. Pairs that cannot be certified split the phase at its midpoint (bisection, ≤ 6 levels,
   intervals ≥ 1/120 s). At the limit the static rule at the sub-interval midpoint decides and
   the epoch is marked `approximate` (`assembly/depth-approx`, info, naming the pair).
4. Each sub-interval gets a total order by the static algorithm with the certified relations as
   edges; adjacent sub-intervals with equal orders merge into an epoch (`DepthEpoch`, cyclic
   over the loop, ≤ 64 per transition; beyond: merged, approximate).

**Cycles.** Edges have three strengths: forced (enclosure, `inserts`, face-exit rules of §9.5),
certified (step 2) and heuristic (centre depth). A cycle is broken deterministically: first drop
heuristic edges, then certified ones, each time the edge whose endpoints have the smallest
centre-depth difference (ties by the item keys); a forced edge is dropped only when a cycle has
nothing else left (no single interval can form one, but forced edges of different intervals can
close a cycle in the one DOM order of Phase 1b), by the same rule. The existing Kahn release
rule (lowest depth key, then id) then emits the order. Every broken certified or forced edge is
reported as `assembly/depth-cycle` (info) and marks the epoch `approximate`.

### 9.4 One DOM for all epochs: duplicate copies

SVG has one paint order, so order changes are realized with **copies**: an item may appear
in the DOM more than once, and exactly one copy is visible per epoch. Construction:

1. `D` = order of epoch 1, copy 0 of every item.
2. For each next epoch `k`: take each item's position in `D` (the copy used in `k−1`); compute
   the longest increasing subsequence of these positions in epoch-`k` order (LIS, O(n log n),
   ties by item key), with static items (never moving in the loop) always kept, so static
   objects never get copies. Items outside the LIS reuse an existing copy that lies between
   their epoch-`k` neighbours, else get a new copy inserted right after their predecessor.
3. Copy `c` of item `x` is visible exactly in the epochs whose embedding uses it. Insertions
   never reorder existing entries, so earlier epochs (and the wrap back to epoch 1) stay valid.

**Emission.** Copy 0 uses the part's normal ids (`ids.object(path)`, faces, overlay). A copy
k ≥ 1 is a full duplicate subtree in which every id is suffixed `__c<k>` (spec ids never contain
`_`, so the suffix cannot collide); `ids.copyIds(id)` lists an element's ids across copies, and
B emits each per-id state or track rule for all of them. Each copy is a chain of wrappers, one
animated property per element, so CSS animations never fight and opacities multiply:

```
<g id=partHost(item, k)>            clipped copies only: the clipping SOLID's transform track
  <g clip-path=…>                   static clip, defined in the solid's frame
    <g id=partMotion(item, k)>      transform track; relative to the solid when clipped
      <g id=partVisible(item, k)>   visibility track: copy swaps, enclosure, build appearance
        <g id=partFade(item, k)>    opacity track: stage fades, build fade-in/out, cross-fades
          <g id=object(path)…>      object-like part group: state class, faces, overlay
```

The clip must not move with the leaf: a `userSpaceOnUse` clip inside the leaf's translated
group would travel with it, so a piston rising out of a static block would carry its clip
upward and lose its visible section. The clip is therefore defined in the clipping solid's
frame and placed **outside** the leaf's motion, on `partHost`, which carries the solid's track:
omitted when the solid is static (piston leaving a static block, valves pulled out of a static
head); equal to the solid's **total** track when they move together (valves inserted in a head
that lifts), in which case `partMotion` is the leaf's motion relative to the solid (zero for the
valves). The solid's total track is its own `partHost` track (when the solid is itself clipped by
another solid) plus its own motion, so nested inserts compose: a valve in a head inserted in a
block gets the head's total track. Unclipped copies have no `partHost` and no clip wrapper. Wrappers without a track are
omitted. Both copies sit at the same place when they swap, so the
swap is invisible except for the occlusion change it is meant to cause. Copies ≤ 0.5 × items
(beyond: epochs merged, `budget/depth-copies` warning). Frame, static and per-step outputs use
the same DOM with static visibility for their time, so every output agrees with the animation.
The DOM itself carries the rest frame (`frameAt(0)`) as attributes (hidden, translated and dimmed
wrappers), so a bare emit shows the rest pose; frame and step overrides write the FULL state of
every registered wrapper (`AssemblyFrameState` lists every id, `translate(0 0)` and opacity 1
included). CSS animations override presentation attributes, so loop mode is unaffected.
Implementation (A1-2b, [tracks](./assemblies-tracks.md)): a pair whose certified or forced
direction changes in the loop is what needs a copy (a heuristic direction yields, as before). The
final intervals are grouped greedily into maximal runs in which no such pair changes direction;
each group is ordered by the static algorithm over the loop-wide edges, its own directions and a
chain that keeps the static items in one fixed order (taken from the loop-wide edges alone; the
chain is never dropped by the cycle rule), so static items never need a copy. Epochs then break
at group boundaries too, and the construction above embeds every epoch. A clipped item's copies
all carry its clip (one shared `clipPath`). A spec without such a pair takes the one-order path
unchanged (byte-identical to Phase 1b). Beyond the copy budget, or when the orders would exceed
the work budget (`budget/time`), the epochs are merged into one order as in Phase 1b: the
direction held shorter (then later) is dropped and its intervals are approximate
(`assembly/depth-approx` with `copy: true`).

### 9.5 Enclosure, insertion and face-exit clipping

Containment is **closed** with a tolerance `ε = 1e-6` world units: `a ⊆ b` when every face
of `a` lies inside or on `b` (flush faces count, so camshafts flush with a cover's ends are
inside it).

Every rule of this section reasons about the faces of a solid's `depthBox`, so only solids that
**fill** their box take part: a solid fills its `depthBox` when ANY single `box`, `plate` or
`card` primitive has a box equal to the `depthBox`. Other primitives (studs, bores, lugs, decals,
flush cylinders) may exist alongside it: the solid region still contains the whole `depthBox`, so
detailed housings occlude like plain boxes. A solid without such a primitive (a cylinder, shaft,
wedge, prism or an assembly of smaller pieces) leaves empty box corners where a crossing leaf can
be visible in front of it, so it never encloses, hides, clips or orders by the hidden-face rule;
it is ordered by separation or bisection only (approximate where those cannot decide).

- **Enclosed** leaf: its `depthBox` lies inside a `solid` leaf's `depthBox`, or inside the
  **union of touching solids** (solids whose boxes share a face, merged into connected blocks;
  a valve inside a head casting plus the valve cover above it is enclosed by their union) →
  hidden in that pose. A closed solid is opaque; drawing its contents on top would show
  through. Contents of non-solid shells (`tray`, `ring`) are not enclosed (they sort between
  the halves, §9.6).
- **Inserted** leaf (`inserts`, or inferred when the leaf crosses exactly one face plane of
  exactly one solid block and its footprint ⊥ that face lies inside the face): a seated
  relation, not a collision. A **block** is a set of touching solids that do not move relative
  to each other (in the loop, for a static clip); its face planes are its exterior faces. A leaf
  that crosses exactly one exterior face plane of a block (a seam pin across two halves, a pin
  through two stacked members, a head bolt through cover and casting) is clipped at the
  **block's** exit face: the part of the leaf below that plane lies inside the union of the
  members and the part beyond it meets no member; the clip solid is the member that carries the
  face, and the leaf is drawn after every member it interpenetrates (forced). When no single
  block face qualifies (a leaf crossing faces of two different blocks, or several faces of one),
  the leaf is hidden while it crosses (`assembly/clip-fallback`), never left to the static
  heuristic. The inside portion is clipped at the **entry face**: entry face
  visible (`+x`, `+y`, `+z`): forced edge leaf after the solid, with the static footprint-prism
  clip below; hidden (`−x`, `−y`, `−z`): forced edge leaf before the solid, no clip. Inserted
  leaves keep the relation while both move together (a head and its valves) and while the leaf
  moves along the face normal.
- **Crossing** a solid block `e` (relative motion along an axis `u` while partially inside) is
  the same rule with the exit face: `u ∈ {−x, −y, −z}`: forced edge before `e`, no clip (every
  ray from the inside portion toward the viewer hits `e`, so `e` covers exactly that portion);
  `u ∈ {+x, +y, +z}`: forced edge after `e`, with a static clip = the screen projection of the
  prism `footprint_⊥u(p) + s·u, s ≥ 0`, starting at the face plane. Proof for `u = +z` (the
  others are symmetric): a visible side-face point of `p` lies on the front boundary of `p`'s
  footprint for its screen column, so a point below the face projects strictly below the
  prism's lower boundary (outside the clip) and a point above projects inside. The leaf's
  footprint ⊥ `u` is invariant in the solid's frame under relative motion along `u`, so the clip
  is static **in the solid's frame**: `clipPathUnits="userSpaceOnUse"` on the clip wrapper
  inside `partHost`, which carries the solid's track (none when the solid is static), with the
  leaf's motion relative to the solid inside it (§9.4). Exact for convex prisms along `u`
  (boxes, cylinders, shafts). The proof covers side-face points and needs the leaf's own `+u`
  face at or beyond the face plane (`p.max_u ≥ e.max_u`): a `+u` face still below the plane
  projects inside the prism and would show through. While `p.max_u ≤ e.max_u` the leaf lies
  inside `e` (its footprint is inside the face and it never passes the hidden `−u` face), so
  the enclosure rule takes precedence: it is hidden, and the clip applies only while it crosses.
  The instants where `p.max_u(t) = e.max_u(t)` are epoch boundaries, like presence changes, so
  both sides certify.
- **Validity of a static clip.** The clip is one fixed region for the whole loop, so a copy may
  be clipped only if its motion relative to the solid has **no component ⊥ `u` at any time in
  the loop** (only motion along `u`, the axis that leaves through the clipped face). Then its
  footprint ⊥ `u` never leaves the clip prism, which is what the proof above needs. The solid
  itself may move (its total track rides on `partHost`). If the relative motion has a ⊥ `u`
  component anywhere in the loop (the piston later slides sideways once clear, or an insert is
  pulled out obliquely): Phase 1b falls back to hiding the leaf until clear for the crossing
  epochs (`assembly/clip-fallback`, info); Phase 3 is to use two copies instead, a clipped copy
  visible only during the crossing epochs and an unclipped copy for the rest of the loop,
  swapped by visibility like any other copy (§9.4). A1-2b does not do this yet: such leaves keep
  the hidden-until-clear fallback (follow-up track A1-2c).
- Regression fixture: the engine example (§19.3) exercises all three: valves inserted in the
  casting and enclosed by casting ∪ cover at rest, camshafts flush in the cover, pistons
  crossing the block deck.
- **Note for A1-3 (Phase 1b):** a drawer that moves inside the loop (the built-in `drawers`
  program, §19.4) needs copies (A1-2b): an open device at rest is behind the device above it,
  and its internals lifted on the pulled drawer are in front of it, which no single DOM order
  satisfies. The internals get depth copies; beyond the copy budget the epochs are merged and
  approximate (`assembly/depth-approx` with `copy: true`).

### 9.6 Split items

`tray`: `back` = floor and the `−x`, `−y` walls; `front` = the `+x`, `+y` walls. Contents above
the floor and inside the walls are behind `front` on x or y and in front of `back` on z, x or
y, so the static rule certifies them without forced ranks. `ring`: halves split along the
viewer diagonal plane through the axis. Brick studs are outside `depthBox`: a lower brick is
behind the brick stacked on it (`lower.max_z = upper.min_z`), so the upper brick covers the
lower brick's studs, which is what a real stacked brick looks like.

### 9.7 Worked proofs

- **Rack drawer** (device `S` slides `+y`): vs front-left post `P` (x ∈ [0, w]):
  `P.max_x ≤ S.min_x` for all t (x does not change), so `P` before `S`; front-right post:
  `S.max_x ≤ P.min_x`, `S` before it; top cap and devices above/below: separated on z; rear
  panel: `rear.max_y ≤ S.min_y`, growing; front door (moved first by `drawer` beyond every
  device's final position, §6.3): `S.max_y(t) ≤ S.max_y(final) ≤ door.min_y − gap`. All pairs
  are certified for the whole move: one epoch, no copies. The 1.1 `rackId_front` union draws
  both front posts after every device; with the device pulled out in front of the left post,
  that union would wrongly cover it, which is why assembly mode splits the rack into leaves.
- **Server internals on a pulled drawer**: `drawer` auto distance clears the rack's front plane
  (`owner.max_y − S.min_y + gap`), so every internal of `S` has `min_y ≥ rack.max_y + gap`
  during its own lift and is y-separated from all rack parts and other devices.
- **Engine lift**: every `+z` mover ends above every inner footprint-overlapping mover by `gap`
  (§6.3, sorted by `max_z`: pistons, head, cams, valve cover), so during a stage a mover `p`
  stays below every outer part already lifted (`p(t).max_z ≤ p(final).max_z < q.min_z`) and
  above every inner part at rest; parts with disjoint footprints keep their x or y separation;
  pistons leave the block through its top face (clip, §9.5), the crankshaft through its bottom
  (before the block); manifolds move along `±y` and keep their y separation. The valves are
  inserted in the casting (they move with the head and stay clipped at its top face) and,
  at rest, enclosed by casting ∪ valve cover; the camshafts are flush with the cover's ends,
  which closed containment treats as inside. One epoch per stage, no copies.
- **Build drop** (`above`): the seat footprint has only placed parts below it (else
  `build-path-blocked`), so the falling part stays z-separated from them; other parts keep x/y
  separation. One epoch per build step.

### 9.8 Cost

Pairs are pruned by a sweep over screen x (only overlapping swept rects are compared). Target:
300 leaves and 20 transitions under 2 s; 2000 leaves under 10 s (`budget/time` warning).

## 10. Bounds and viewBox

Reach bounds = union over every phase of the swept boxes of §9.3 (rest box ⊕ the Minkowski
sum of the active moves' offset intervals; straight segments with monotonic easings never leave
their interval, and overshoot easings are not offered), plus labels and leaders at their end
poses, callout flights (hull of slot and hover point), boards and every quarter-turn view. The
viewBox covers the reach bounds of everything plus padding, so no exploded state and no
concurrent composed motion is clipped; the rest frame therefore shows the assembled unit with the
room its explosion needs (D27 overview). A reach area over 4× the rest area gives
`assembly/bounds-growth` (info), suggesting smaller distances or `fade`.

## 11. Images

### 11.1 Sources

`images[].src` is a path relative to the spec's directory (schema forbids absolute paths, `..`
segments, backslashes, `:` and therefore URLs) or an inline
`data:image/(png|jpeg|svg+xml);base64,…` URI (≤ about 256 KiB). Core does no I/O: the CLI
resolves files and passes bytes as `ImageAssetInput`; C's `PrepareImageFn` returns
`ImageAsset`s, collected into `RenderOptions.images`. CLI reads (D-1): resolve the directory
with realpath, walk the relative path one component at a time with `lstat` (no symlink
components), then `open` the file **once** with `O_RDONLY | O_NOFOLLOW`, `fstat` that same file
descriptor (regular file, size ≤ cap) and read from it up to cap + 1 bytes, so there is no
check-then-use race between the checks and the read.
After the open the path must still name that file (`lstat` dev/ino, `realpath`), and on Linux the
kernel's path for the descriptor (`/proc/self/fd/N`) must equal the expected path; elsewhere the
read is refused when a directory above the file is writable by another user (and not sticky) or
owned by someone other than the reader or root. A read whose length differs from the `fstat` size
is refused (`image/unsafe-path`, changed while reading). Components ending in `.` or a space,
Windows device names, and a `realpath` that differs only by case or Unicode normalization
(`image/not-found` with a spelling hint) are refused. Residual race: Node has no `openat`, so on a
platform without `/proc` an owner of a directory above the file can still rename directories
between the walk and the open; `pcosmo assets doctor` states which guard is active.

### 11.2 Validation (Track C, pure)

- Format by **magic bytes**, never by extension (a mismatch is an error): PNG
  (`89 50 4E 47 0D 0A 1A 0A`, IHDR first, chunk CRCs verified, APNG rejected), JPEG
  (`FF D8 FF`, SOF0/1/2 dimensions; CMYK flagged as a warning, browsers render it, resvg may
  not), SVG (text, `<svg` root, through the icon sanitizer with `maxBytes` 256 KiB). **WebP is
  rejected** (`image/format`, hint: convert it to PNG or JPEG), as are GIF, AVIF, HEIC, TIFF.
- Dimensions from the header only (no decoding in core), so a decompression bomb cannot be
  triggered; caps apply to the declared size.
- **Metadata removed without re-encoding**: PNG keeps IHDR, PLTE, tRNS, IDAT, IEND; JPEG drops
  APP1–APP15 (EXIF, XMP, IPTC, ICC) except APP14 Adobe, and COM. ICC profiles are ignored
  (sRGB assumed, `image/icc-ignored` info).
- **EXIF orientation** is read before the EXIF segment is dropped and kept as
  `ImageAsset.orientation` (1–8); width and height are reported as displayed (5–8 swap them).
  Emit applies it as a fixed rotate/flip `transform` on the `<image>` in `<defs>`, so every use,
  crop and decal sees the upright image. A malformed EXIF block is ignored (orientation 1) with
  `image/exif-ignored` (info).
- Text in images is pixels: never OCR'd, never interpreted, never placed in the SVG.

### 11.3 Emit

Each distinct asset (by hash) is embedded once in `<defs>`: raster as
`<image id=image(hash) href="data:image/…;base64,…" width height preserveAspectRatio="none">`,
SVG as `<symbol id=image(hash)>` with the sanitizer's `__PCID__` rewrite (like icons). Uses are
`<use href="#…">`: billboards upright in screen space (contain within the silhouette box,
bottom-aligned), decals with an affine `matrix()` mapping the crop rect onto the face
parallelogram, crops via a nested `<svg viewBox=crop>`. The emitter accepts a `data:` href only
on `<image>` elements in `<defs>`, only matching `^data:image/(png|jpeg);base64,[A-Za-z0-9+/]+=*$`,
and only from asset bytes it base64-encodes itself (spec data URIs are decoded and re-encoded,
never copied). `url(` still requires `#`. No external references.

### 11.4 Caps (`ImageLimits`)

Per raster file 2 MiB; per SVG 256 KiB; ≤ 8192 px per side and ≤ 16.7 MP; ≤ 256 distinct
images; total embedded ≤ 8 MiB (error), warning `budget/images` above 1 MiB (4 MiB for the
document class, §13). Duplicates by hash are embedded once.

### 11.5 Raster outputs

resvg-wasm renders the PNG and JPEG data URIs and SVG symbols used by every image placement, so
PNG, GIF and MP4 frames match the browser output. WebP never reaches the renderer (rejected at
input, §11.2).

### 11.6 Provenance and credits

`source` (on images, parts, assemblies, storyboards, figures) records document, page, figure,
license, attribution and URL (text only). When any used source has `attribution` or `license`,
a credits line pinned like the legend lists up to 3 entries ("Images: <attribution>, <document>
p. <page> (<license>)", then "and N more"); the SVG `<desc>` lists all. Strings are escaped.

## 12. Outputs and motion

| Output                  | Assemblies                                                                                                                                                                                                                         |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| animated (loop)         | CSS keyframes per motion group: `transform: translate(Xpx,Ypx)` with per-keyframe `animation-timing-function` (cubic-bezier), opacity tracks for copies, enclosure, builds, labels, fades; identical tracks share one `@keyframes` |
| `--steps`               | end pose of step k, static (`AnimationLayer.attrs`), zoomed per step as today                                                                                                                                                      |
| `--static`, PNG default | rest frame: base pose                                                                                                                                                                                                              |
| `--interactive`         | loop + Step pausing at settled times (§7.5)                                                                                                                                                                                        |
| PNG `time`, GIF, MP4    | `frame` mode: `frameAt(t)` gives exact transforms and visibility, written as attributes (`AnimationLayer.attrs`), because resvg does not apply CSS transforms or animations                                                        |

**Motion modes (D32).** Pose motion is CSS (or attributes in frame mode) in both `smil` and
`css` modes; `--motion` still affects particles only, so `css` output keeps zero SMIL
elements (D32, merged in #57).

**Reduced motion.** For specs with assembly actions, `prefers-reduced-motion: reduce` switches
pose tracks to discrete keyframes (each step shows its end pose for the whole step, no tween),
keeps captions, states and metrics on their step-end keyframes, fixes the camera at the overview
and hides particles. Specs without assembly actions keep the 1.1 rule (everything paused at the
rest frame), so their bytes do not change (user decision; proposed D56).

**Determinism.** Easing evaluation is the existing bisection (`ease()`), generalized to any
cubic-bezier; keyframe percentages 4 decimals, coordinates 2; copies, epochs, labels and
keyframe names are derived from sorted inputs only.

## 13. Budgets

| Limit                                        | Value                                            | Diagnostic                      |
| -------------------------------------------- | ------------------------------------------------ | ------------------------------- |
| leaf parts per spec (after `count`, `use`)   | ≤ 2000 (warn > 500)                              | `budget/assembly-parts`         |
| nesting                                      | ≤ 8 path segments                                | `assembly/too-deep`             |
| stages per program / build steps per program | ≤ 32 / ≤ 500                                     | schema                          |
| depth copies                                 | ≤ 0.5 × items                                    | `budget/depth-copies`           |
| epochs per transition                        | ≤ 64                                             | `assembly/depth-approx`         |
| views / levels                               | ≤ 4 / ≤ 4 deep, ≤ 8 total                        | `budget/views`, `budget/levels` |
| elements                                     | existing warn > 5000 (all levels, views, copies) | `budget/elements`               |
| images                                       | §11.4                                            | `budget/images`                 |
| build time                                   | 2 s at 300 leaves, 10 s at 2000                  | `budget/time`                   |

**Size classes.** `typical` (PLAN §6, under 150 KB); `assembly` (no images, ≤ 300 leaves:
about 2–4 KB per leaf incl. keyframes, target under 600 KB); `document` (embedded images:
dominated by image bytes; warning above 4 MiB, error above 8 MiB). For large document outputs
the skill: dedupes sprites by hash, skips decorations under 8 px, downsizes with
`pcosmo assets shrink` (deterministic, see ingestion §5), prefers pack shapes and bricks over
images, and summarizes: bags or sub-builds instead of single parts, `advance: N` build steps
per spec step, sub-assemblies explode as units with close-ups for detail, labels only on
stages with ≤ 24 parts.

## 14. Storyboards (tier A)

A storyboard is an upright panel (`width` tiles, sorted as one depth item at its `pos`) that
replays a document's steps faithfully: per frame the model image (`model`), the parts callout
(`parts`: thumbnail + `<count>x`), an optional sub-build (`sub`: mini-step images, the last one
docks at `attach`) and the caption with the document's step number. `build` on a storyboard
plays frames forward: callout appears, thumbnails fly (screen translate) to `attach`, then the
model image changes (`transition`: fade, wipe via an animated clip rect, or cut); `unbuild`
plays backward. Explode is not available (`assembly/storyboard-no-explode`). All motion is
2D inside the panel, so no depth questions arise. Details and the skill flow:
[document ingestion](./document-ingestion.md).

## 15. Figures (figure mode)

A figure replays a drawn exploded and/or assembled figure in its own plane: `base` (the figure
with every moving part erased and arrows removed, prepared with `pcosmo assets cutout
--erase-from`) plus sprites (`parts[].image`, silhouette-cut, transparent outside) that move
between `seat` and `exploded` (pixel positions, from `pcosmo assets locate`). `explode` moves
seat → exploded by stages (`figureStage`: selectors, order, stagger, timing, labels);
`implode` reverses. Draw order: by the seat's bottom edge (lower on screen = nearer), `z`
overrides. Motion arrows are redrawn by us and fade (`arrow`). No 3D inference and no
projection change: the figure's own (near-isometric) drawing plane is used as is.

## 16. TypeScript builder

`@platformcosmo/core` exports `spec`, `assembly`, `explode`, `build` and `figure` builders
(contract `AssemblyBuilders`; implementation A2). `spec()` also takes racks (with `programs`,
slot `assembly` and `closeup`), figures and storyboards, so every 1.2.0 construct can be built.
They produce plain spec JSON, never a scene, and fill in no defaults. Equality is defined on
RFC 8785 (JCS) canonical JSON (the same canonicalization as the id-prefix hash), so tests
compare `jcs(builder.toJSON())` with `jcs(expected)` and key order never matters; arrays keep
call order.

```ts
import { assembly, explode, render, spec, validate } from "@platformcosmo/core";

const engine = assembly("engine", { label: "Inline-4", units: "mm" })
  .part("block", { size: [480, 220, 260], at: [0, 0, 80], role: "body" })
  .sub("pr", { count: 4, pitch: [110, 0, 0] }, (b) =>
    b.part("piston", { shape: "cylinder", at: [45, 70, 170], size: [80, 80, 70] }),
  )
  .part("valve-cover", { at: [10, 10, 430], size: [460, 200, 90], role: "cover" })
  .program(
    explode("service")
      .stage({ label: "Covers", parts: ["role:cover"] })
      .stage({ label: "Pistons", parts: ["pr-*"], direction: "lift" }),
  );

const doc = spec({ title: "Engine" })
  .assembly(engine)
  .step({ caption: "Assembled", duration: 2 })
  .step({ caption: "Exploded", assembly: [{ explode: "engine" }], focus: "engine" })
  .toJSON();
const report = validate(doc); // same checks as pcosmo validate
```

## 17. Suggestion heuristics (skill; `pcosmo validate --suggest` prints the same)

When the user gives no program, Claude (and `pcosmo validate --suggest`, Track D) proposes one
and explains it:

1. **Body**: the part with `role: body`, else the one most others mate with, else the largest
   volume (a pack's default role `body` does not count). It never moves. Boxes are the
   **effective** placement the resolved tree gives (`pcosmo validate --suggest` reads it,
   including a pack shape's default size and `dc:` shapes), not only the `at`/`size` the spec
   states, so omitting `at` or `size` does not hand the pick to a small lid. The volume of a
   counted part is that of one instance (`id-1`), never of the whole row.
2. **Classify** the rest (per part; a counted part is judged by one instance, but placed,
   enclosed and carried by the union of its instances):
   - covers: a type or role of lid, panel, cover, pan, door or a compound `...-cap`
     (a bare `cap` is a capacitor), or a thin part (smallest extent at most 20% of the
     largest) lying flat against the body: its thin axis is the side's axis, it touches
     that face of the body and spans at least half of it. A flat part on a board (a DIMM, a
     chip, a row of them) is thin but covers nothing, and a thin sheet floating above the body
     is not a cover;
   - fasteners (small, repeated, `type` screw, bolt, clip, pin);
   - shells (open containers), sub-assemblies;
   - internals: enclosed or seated inside a shell, or inside the body on another part;
   - components: parts sitting on the body's top face (a board's chips, DIMMs, connectors),
     and anything stacked above them.
3. **Stage order**: fasteners first (along their `axis`), then covers (`away` from their
   mating surface), then sub-assemblies as units (`drawer` for rack devices, `away` or `out`
   otherwise), then each sub-assembly's internals (nested program, `lift` when they stack),
   then components, then remaining loose parts (`out`), then covers on a hidden side. One
   stage per class (and per direction); split a class larger than 24 leaf parts into
   consecutive stages in spec order. Each sub-assembly's own parts get their own nested
   program, so a class never has to be split across sub-assemblies. Nested owners are
   imploded before the root.
   - **Mounting depth.** A part carried by another (its bottom touches the carrier's top,
     over its footprint, the carrier having height: a heat sink on a CPU on a board; a card on
     a board in a case; a sensor on a lid) leaves before its carrier, top-most first, so the
     carrier never passes through it (`assembly/transit-collision`). A part carried by a cover,
     internal or component is never left in a later class than its carrier: it joins the
     carrier's class (a component on a lid is a cover; a part on a component that overhangs the
     body is a component). Carriers that are sub-assemblies or shells, loose parts, fasteners,
     or covers on a hidden side (which leave last anyway) do not fold. Contact is the carried
     part's bottom at the carrier's top within 1% of the carrier's height, either way (a part
     sunk into a recess, or a small gap). Within a class the stages are split by level and
     named `Internals (level n)`, `Components (level n)`, `Covers (level n)` (level 0 sits on
     the body or a seat; levels are counted among the parts of the class). With several levels
     the internals use `+z` instead of `lift` (`lift` layers equal-height parts together and
     can sort a board below its heat sinks).
   - **Moving as one.** Parts of an internals level that interpenetrate at rest (a crank
     through its rods) form a separate stage, `Internals (moving as one)` or `Internals (level n, moving as one)`
     with several levels: `+z`, one number
     (the top of the body and of every shell over them, above the lowest of them, plus the
     default gap), `stagger: 0`, never split into chunks of 24, so no transit collision can
     arise between them. The other parts of the level move normally.
   - **Components** are one `+z` lift with a clearly visible distance, nothing sideways, named
     "Components" (not "Covers"). The distance is a number (§6.3): a quarter of the body's
     larger footprint extent, or 1.5 times the tallest component if more; each mounting level
     adds one step (`(n + 1)` steps for level n), so a part ends clear above its carrier. The
     `auto` distance stays tiny for flat parts, which is what made board lifts barely visible.
4. **Directions**: away from the mating surface; prefer visible directions (`+z`, `+x`, `+y`)
   because parts that travel into hidden directions are covered by the body; when only a
   hidden direction is free (oil pan down, PSU to the rear), use it, stage it late and fade
   others.
5. **Timing**: stagger 0.06–0.12 s `outside-in` (0 for a stage of parts that move as one,
   §17.3), durations 0.6–1.0 s, and a step `duration` that fits (validator
   `assembly/compressed` tells).
6. **Labels**: a stage's labels are `show` when it moves ≤ 12 parts, or when every part in it has
   a `label` (the author named them to be read; §6.6 hides labels only where the stage says
   `hide`); `hide` otherwise. Details only on the focused stage.
7. **Story**: assembled overview → one step per stage → nested explodes with focus on the
   nested owner → implode in one step at the end (avoids the fast loop closure). Steps for the
   root owner carry **no `focus`**: focusing a part zooms the camera onto it and crops the
   assembly (a board lost most of its area); a nested owner is focused as a whole.
8. **Builds**: base first, bottom-up, sub-builds for anything the document builds separately,
   `advance: 2–4` when a booklet has many tiny steps.

## 18. Diagnostics

New codes (namespaced like existing ones; unknown ids and refs carry did-you-mean
suggestions):

| Code                                                                                                            | Severity                                          | When                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `assembly/unsupported`                                                                                          | error                                             | 1.2.0 field not rendered by this build yet (merge guard, until its phase lands)                                                                                       |
| `assembly/no-op-action`                                                                                         | info                                              | action that does not change the level                                                                                                                                 |
| `assembly/transit-collision`                                                                                    | warning                                           | leaves interpenetrate during a transition                                                                                                                             |
| `assembly/below-ground`                                                                                         | error                                             | rack or slot move below the floor                                                                                                                                     |
| `assembly/depth-cycle`                                                                                          | info                                              | a certified (or, in an all-forced cycle, forced) depth edge was dropped to break a cycle                                                                              |
| `image/exif-ignored`                                                                                            | info                                              | malformed EXIF block; orientation 1 assumed                                                                                                                           |
| `assembly/unknown-target`                                                                                       | error                                             | action, focus, `set`, `overrides`, `mates`, `inserts`, `use`, `closeup` matches nothing                                                                               |
| `assembly/unknown-program`                                                                                      | error                                             | program id not found on the target (action, `program`, `subBuild`) or of the wrong kind                                                                               |
| `assembly/selector-empty`                                                                                       | warning                                           | selector matches no part                                                                                                                                              |
| `assembly/moved-twice`                                                                                          | error (info in the scene, through inferred roles) | a node moved by two stages of one program, or added by two build steps (also by ancestor or descendant)                                                               |
| `assembly/stage-out-of-range`                                                                                   | error                                             | `to` beyond the program's stages or steps                                                                                                                             |
| `assembly/build-backwards`                                                                                      | error                                             | `build` to a lower level                                                                                                                                              |
| `assembly/unbuild-forwards`                                                                                     | error                                             | `unbuild` to a higher level (use `build`)                                                                                                                             |
| `assembly/explode-backwards`                                                                                    | error                                             | `explode` of a figure, assembly, rack or slot to a lower stage (use `implode`)                                                                                        |
| `assembly/implode-forwards`                                                                                     | error                                             | `implode` of a figure, assembly, rack or slot to a higher stage (use `explode`)                                                                                       |
| `assembly/figure-no-build`                                                                                      | error                                             | build or unbuild on a figure (figures explode and implode)                                                                                                            |
| `assembly/part-not-staged`                                                                                      | info                                              | a figure part that no stage moves (it stays seated)                                                                                                                   |
| `assembly/build-path-blocked`                                                                                   | warning                                           | `above` origin blocked                                                                                                                                                |
| `assembly/collision`                                                                                            | warning                                           | interpenetrating leaves in a final pose (not emitted yet)                                                                                                             |
| `assembly/compressed`                                                                                           | info / warning (< 0.5)                            | actions compressed to fit the step (reported by validation, from the plan the scene uses)                                                                             |
| `assembly/implicit-access`                                                                                      | info                                              | access move prepended (§8.3)                                                                                                                                          |
| `assembly/depth-approx`                                                                                         | info                                              | an epoch could not be certified                                                                                                                                       |
| `assembly/clip-fallback`                                                                                        | info                                              | enclosed part hidden until clear                                                                                                                                      |
| `assembly/depth-input`                                                                                          | error                                             | internal: invalid depth-order input (non-finite box, move or loop); that input is ignored                                                                             |
| `assembly/bounds-growth`                                                                                        | info                                              | reach bounds > 4× rest                                                                                                                                                |
| `assembly/closeup-turned`                                                                                       | info                                              | a close-up's footprint would match its host better turned a quarter; not turned (fronts stay aligned) (also by `validate`)                                            |
| `assembly/size-mismatch`                                                                                        | warning (info: much smaller)                      | template or close-up does not fit at true scale (also reported by `pcosmo validate`, `closeupDiagnostics`)                                                            |
| `assembly/reserved-id`                                                                                          | error                                             | slot id `frame` on a rack in assembly mode; any part id `closeup` (reserved segment)                                                                                  |
| `semantic/reserved-id`                                                                                          | warning                                           | a 1.1 id `closeup` (still valid; rename before adding close-ups)                                                                                                      |
| `assembly/too-deep`                                                                                             | error                                             | path longer than 8 segments (also through `use` and `closeup` templates, accumulated along close-up chains)                                                           |
| `assembly/template-cycle`                                                                                       | error                                             | assemblies reference each other through `use` or `closeup` in a cycle                                                                                                 |
| `assembly/use-ignored`                                                                                          | warning                                           | `use` is ignored because `parts` is set                                                                                                                               |
| `assembly/diagnostics-capped`                                                                                   | info                                              | a program reported more than 50 warnings, a part's placement check more than 8 diagnostics, or placement checks stopped after 20,000 parts; the rest are omitted      |
| `assembly/view-conflict`                                                                                        | info                                              | two actions of one step set different views; the last wins                                                                                                            |
| `assembly/view-needs-assembly-only`                                                                             | error                                             | `view` with nodes or DC content                                                                                                                                       |
| `assembly/storyboard-no-explode`                                                                                | error                                             | explode on a storyboard                                                                                                                                               |
| `assembly/edge-to-part`                                                                                         | error                                             | edge, flow or cable endpoint is a part path                                                                                                                           |
| `assembly/unknown-shape`                                                                                        | error                                             | `pack:id` shape not installed or in the DC pack (validate: only with a registry; `render()` always refuses)                                                           |
| `assembly/shape-params`                                                                                         | error                                             | unknown or invalid `params` for a shape                                                                                                                               |
| `assembly/duplicate-part`                                                                                       | error                                             | sibling ids collide (also after `count` expansion)                                                                                                                    |
| `brick/off-grid`                                                                                                | warning                                           | non-integer stud or plate position                                                                                                                                    |
| `assembly/image-unresolved`                                                                                     | info                                              | a pack shape's decal (`left`/`right`) faces away from the viewer after the part's turn and is not drawn; reported once per spec part, not per copy or `use` instance  |
| `assembly/label-omitted`                                                                                        | info                                              | a `labels: always` top-face label whose text does not fit the part's top face is not drawn                                                                            |
| `image/not-found`, `image/unsafe-path`                                                                          | error                                             | CLI path resolution (did-you-mean over files in the directory); also a part image whose asset the renderer was not given (with or without `crop`; once per spec part) |
| `image/format`, `image/format-mismatch`                                                                         | error                                             | not PNG, JPEG or SVG by magic bytes (WebP: convert to PNG or JPEG) / differ from extension                                                                            |
| `image/too-large`, `image/too-many`                                                                             | error                                             | §11.4 caps                                                                                                                                                            |
| `image/animated`                                                                                                | error                                             | APNG                                                                                                                                                                  |
| `image/sanitized`                                                                                               | info / warning (active content removed)           | SVG elements removed by the sanitizer                                                                                                                                 |
| `image/icc-ignored`, `image/cmyk`                                                                               | info / warning                                    | colour handling                                                                                                                                                       |
| `image/unknown`                                                                                                 | error                                             | part references an image id not in `images`                                                                                                                           |
| `asset/annotation-erased`                                                                                       | info                                              | figure end moved onto its drawn stroke, or ink inside a mask erased (ingestion §6.4)                                                                                  |
| `asset/rim-stroke`                                                                                              | info / warning (undecided)                        | figure template rim pixels a board stroke touches: peeled, or undecided (ingestion §6.4)                                                                              |
| `budget/assembly-parts`, `budget/depth-copies`, `budget/views`, `budget/levels`, `budget/images`, `budget/time` | warning / error                                   | §13                                                                                                                                                                   |
| `options/invalid-png-step`                                                                                      | error                                             | `png.step` is not a positive integer, is given with `png.time`, or is beyond the timeline                                                                             |

## 19. Examples

All examples validate against `schema/v1.json` (checked when this design was written).

### 19.1 Loaded rack: compute, storage, GPU, ToR, PDU

```json
{
  "$schema": "https://platformcosmo.io/schema/v1.json",
  "meta": { "version": "1", "title": "Loaded rack: service view" },
  "racks": [
    {
      "id": "r1",
      "label": "Rack R1",
      "u": 42,
      "slots": [
        { "id": "tor", "at": 41, "type": "switch-tor", "label": "ToR switch" },
        { "id": "gpu", "at": 30, "type": "gpu-node", "size": 4, "label": "8-GPU node" },
        { "id": "c1", "at": 20, "type": "server-2u", "label": "Compute 1" },
        { "id": "c2", "at": 18, "type": "server-2u", "label": "Compute 2" },
        { "id": "st", "at": 10, "type": "storage-flash", "label": "Flash array" },
        { "id": "pdu", "at": 1, "type": "pdu-1u", "label": "PDU" }
      ],
      "programs": [
        {
          "id": "service",
          "label": "Service view",
          "stages": [
            {
              "label": "Doors",
              "parts": ["frame/role:cover"],
              "direction": "drawer",
              "labels": "hide"
            },
            {
              "label": "Network and power",
              "parts": ["tor", "pdu"],
              "direction": "drawer",
              "order": "top-down"
            },
            {
              "label": "Compute and GPU",
              "parts": ["type:server-2u", "gpu"],
              "direction": "drawer",
              "order": "top-down",
              "stagger": 0.15
            },
            { "label": "Storage", "parts": ["st"], "direction": "drawer", "details": true }
          ]
        }
      ]
    }
  ],
  "steps": [
    { "caption": "Rack R1, fully loaded", "duration": 2 },
    {
      "caption": "Doors off; ToR and PDU slide out",
      "assembly": [{ "explode": "r1", "program": "service", "to": 2 }],
      "focus": "r1",
      "duration": 4
    },
    {
      "caption": "Compute, GPU and storage drawers",
      "assembly": [{ "explode": "r1", "program": "service" }],
      "focus": "r1",
      "duration": 5
    },
    { "caption": "Everything back in", "assembly": [{ "implode": "r1" }], "duration": 4 }
  ]
}
```

The first stage's `drawer` on `frame/role:cover` moves the rear-door heat exchanger out of the
rear (its own outward normal, §8.1), not through the devices; the other stages' slots slide out
of the front.

### 19.2 GPU server internals with an image-fed GPU card

```json
{
  "$schema": "https://platformcosmo.io/schema/v1.json",
  "meta": { "version": "1", "title": "2U GPU server internals" },
  "images": [
    {
      "id": "gpu-photo",
      "src": "img/gpu-card.png",
      "crop": [0, 0, 640, 240],
      "alt": "GPU card, side view",
      "source": { "document": "GPU card datasheet", "page": 2, "license": "used with permission" }
    }
  ],
  "assemblies": [
    {
      "id": "srv",
      "label": "2U GPU server",
      "units": "mm",
      "fit": 7,
      "front": "+y",
      "parts": [
        { "id": "chassis", "shape": "tray", "size": [438, 750, 80], "role": "shell" },
        {
          "id": "lid",
          "at": [0, 0, 80],
          "size": [438, 750, 7],
          "role": "cover",
          "label": "Top cover"
        },
        {
          "id": "board",
          "shape": "plate",
          "at": [10, 300, 4],
          "size": [418, 400, 3],
          "label": "Motherboard"
        },
        {
          "id": "psu",
          "type": "psu",
          "count": 2,
          "at": [0, 0, 7],
          "pitch": [0, 115, 0],
          "size": [85, 110, 40],
          "tone": "metal",
          "label": "PSU",
          "detail": ["2000 W", "hot-swap"]
        },
        {
          "id": "gpu",
          "type": "gpu",
          "shape": "card",
          "count": 4,
          "at": [120, 20, 7],
          "pitch": [60, 0, 0],
          "size": [20, 190, 70],
          "image": { "ref": "gpu-photo", "face": "right", "fit": "cover" },
          "label": "GPU",
          "detail": ["PCIe Gen5 x16", "350 W"]
        },
        {
          "id": "nic",
          "type": "nic",
          "shape": "hw:nic-ocp3",
          "at": [350, 0, 7],
          "size": [76, 115, 12],
          "label": "OCP NIC 3.0"
        },
        {
          "id": "fan",
          "type": "fan",
          "shape": "hw:fan",
          "count": 6,
          "at": [10, 240, 7],
          "pitch": [70, 0, 0],
          "size": [62, 40, 70],
          "label": "Fan"
        },
        { "id": "cpu-1", "type": "cpu", "at": [80, 440, 7], "size": [70, 70, 8], "label": "CPU 1" },
        {
          "id": "hs-1",
          "type": "heatsink",
          "shape": "hw:heatsink",
          "at": [70, 430, 15],
          "size": [90, 90, 50],
          "mates": "cpu-1",
          "label": "Heat sink 1"
        },
        {
          "id": "cpu-2",
          "type": "cpu",
          "at": [280, 440, 7],
          "size": [70, 70, 8],
          "label": "CPU 2"
        },
        {
          "id": "hs-2",
          "type": "heatsink",
          "shape": "hw:heatsink",
          "at": [270, 430, 15],
          "size": [90, 90, 50],
          "mates": "cpu-2",
          "label": "Heat sink 2"
        },
        {
          "id": "dimm-a",
          "type": "dimm",
          "shape": "hw:dimm",
          "count": 8,
          "at": [175, 410, 7],
          "pitch": [11, 0, 0],
          "rotate": 90,
          "size": [133, 7, 31],
          "label": "DIMM"
        },
        {
          "id": "dimm-b",
          "type": "dimm",
          "shape": "hw:dimm",
          "count": 4,
          "at": [370, 410, 7],
          "pitch": [11, 0, 0],
          "rotate": 90,
          "size": [133, 7, 31],
          "label": "DIMM"
        },
        {
          "id": "nvme",
          "type": "nvme",
          "shape": "hw:e1s",
          "count": 8,
          "at": [20, 632, 7],
          "pitch": [14, 0, 0],
          "params": { "orientation": "upright" },
          "size": [10, 118, 34],
          "label": "E1.S NVMe"
        }
      ],
      "programs": [
        {
          "id": "service",
          "stages": [
            { "label": "Top cover", "parts": ["lid"], "direction": "up" },
            { "label": "Fans", "parts": ["type:fan"], "direction": "up", "order": "outside-in" },
            { "label": "Power", "parts": ["type:psu"], "direction": "-y", "with": "previous" },
            {
              "label": "GPUs",
              "parts": ["type:gpu"],
              "direction": "lift",
              "details": true,
              "fade": "unselected"
            },
            {
              "label": "Coolers and memory",
              "parts": ["type:heatsink", "type:dimm"],
              "direction": "lift",
              "order": "outside-in",
              "stagger": 0.05
            },
            { "label": "Drives", "parts": ["type:nvme"], "direction": "drawer" }
          ]
        }
      ]
    }
  ],
  "steps": [
    { "caption": "2U GPU server", "duration": 2 },
    {
      "caption": "Cover off, cooling and power out",
      "assembly": [{ "explode": "srv", "to": 3 }],
      "focus": "srv",
      "duration": 5
    },
    {
      "caption": "Four GPUs on risers",
      "assembly": [{ "explode": "srv", "to": 4 }],
      "focus": "srv/gpu-2",
      "duration": 4
    },
    {
      "caption": "CPUs, memory and drives",
      "assembly": [{ "explode": "srv" }],
      "focus": "srv",
      "duration": 5
    },
    { "caption": "Reassembled", "assembly": [{ "implode": "srv" }], "duration": 5 }
  ]
}
```

### 19.3 Four-cylinder engine, three stages

```json
{
  "$schema": "https://platformcosmo.io/schema/v1.json",
  "meta": { "version": "1", "title": "Inline-4 engine teardown" },
  "assemblies": [
    {
      "id": "engine",
      "label": "Inline-4 engine",
      "units": "mm",
      "parts": [
        {
          "id": "oil-pan",
          "type": "oil-pan",
          "at": [20, 20, 0],
          "size": [440, 180, 80],
          "role": "cover",
          "mates": "block",
          "label": "Oil pan"
        },
        {
          "id": "block",
          "type": "block",
          "at": [0, 0, 80],
          "size": [480, 220, 260],
          "role": "body",
          "tone": "metal",
          "label": "Cylinder block"
        },
        {
          "id": "crankshaft",
          "type": "crankshaft",
          "shape": "shaft",
          "axis": "x",
          "at": [10, 85, 100],
          "size": [460, 50, 50],
          "role": "internal",
          "label": "Crankshaft"
        },
        {
          "id": "pr",
          "count": 4,
          "pitch": [110, 0, 0],
          "label": "Piston and rod",
          "parts": [
            {
              "id": "piston",
              "type": "piston",
              "shape": "cylinder",
              "at": [45, 70, 250],
              "size": [80, 80, 70],
              "tone": "metal",
              "label": "Piston"
            },
            {
              "id": "rod",
              "type": "rod",
              "shape": "shaft",
              "at": [75, 100, 140],
              "size": [20, 20, 110],
              "label": "Connecting rod"
            }
          ]
        },
        {
          "id": "head",
          "type": "head",
          "at": [0, 0, 340],
          "label": "Cylinder head",
          "parts": [
            { "id": "casting", "size": [480, 220, 90], "tone": "metal" },
            {
              "id": "valve",
              "type": "valve",
              "shape": "shaft",
              "count": 8,
              "at": [50, 95, 40],
              "pitch": [55, 0, 0],
              "size": [12, 12, 70],
              "inserts": "casting",
              "label": "Valve"
            }
          ]
        },
        {
          "id": "cam-intake",
          "type": "camshaft",
          "shape": "shaft",
          "axis": "x",
          "at": [10, 60, 450],
          "size": [460, 30, 30],
          "label": "Intake camshaft"
        },
        {
          "id": "cam-exhaust",
          "type": "camshaft",
          "shape": "shaft",
          "axis": "x",
          "at": [10, 130, 450],
          "size": [460, 30, 30],
          "label": "Exhaust camshaft"
        },
        {
          "id": "valve-cover",
          "type": "valve-cover",
          "at": [10, 10, 430],
          "size": [460, 200, 90],
          "role": "cover",
          "tone": "accent",
          "label": "Valve cover"
        },
        {
          "id": "intake",
          "type": "intake",
          "at": [40, 220, 300],
          "size": [400, 80, 100],
          "label": "Intake manifold"
        },
        {
          "id": "exhaust",
          "type": "exhaust",
          "at": [40, -70, 300],
          "size": [400, 70, 80],
          "tone": "muted",
          "label": "Exhaust manifold"
        },
        {
          "id": "timing-belt",
          "type": "timing-belt",
          "shape": "plate",
          "at": [-20, 30, 120],
          "size": [20, 160, 330],
          "role": "cover",
          "label": "Timing belt"
        }
      ],
      "programs": [
        {
          "id": "teardown",
          "stages": [
            {
              "label": "Covers and belt",
              "parts": ["role:cover"],
              "direction": "away",
              "order": "top-down"
            },
            {
              "label": "Top end",
              "parts": ["type:camshaft", "head"],
              "direction": "lift",
              "details": true
            },
            {
              "label": "Bottom end",
              "parts": ["pr-*", "crankshaft", "intake", "exhaust"],
              "direction": "lift",
              "stagger": 0.1,
              "overrides": {
                "crankshaft": { "direction": "down" },
                "intake": { "direction": "+y", "order": 0 },
                "exhaust": { "direction": "-y", "order": 0 }
              }
            }
          ]
        }
      ]
    }
  ],
  "steps": [
    { "caption": "Assembled inline-4", "duration": 2 },
    {
      "caption": "Valve cover, timing belt and oil pan off",
      "assembly": [{ "explode": "engine", "to": 1 }],
      "focus": "engine"
    },
    {
      "caption": "Camshafts and cylinder head lift",
      "assembly": [{ "explode": "engine", "to": 2 }],
      "focus": "engine",
      "duration": 4
    },
    {
      "caption": "Pistons up, crankshaft down, manifolds out",
      "assembly": [{ "explode": "engine" }],
      "set": { "engine/pr-3/piston": "highlighted" },
      "focus": "engine",
      "duration": 4
    },
    { "caption": "Back together", "assembly": [{ "implode": "engine" }], "duration": 5 }
  ]
}
```

Pistons and rods are enclosed by the block at rest (hidden); in stage 3 they leave through its
top face (face-exit clip, §9.5), the crankshaft through its bottom face; the valves move with
the head (sub-assembly). The program-level stacking (§6.3) orders the `+z` movers by `max_z`:
pistons, head, camshafts, valve cover, so the cover (moved first) ends highest.

### 19.4 Nested: rack → server → internals

```json
{
  "$schema": "https://platformcosmo.io/schema/v1.json",
  "meta": { "version": "1", "title": "Rack to server to internals" },
  "assemblies": [
    {
      "id": "srv-internals",
      "template": true,
      "units": "mm",
      "parts": [
        {
          "id": "board",
          "shape": "hw:board",
          "at": [10, 260, 0],
          "size": [418, 400, 12],
          "label": "Motherboard"
        },
        {
          "id": "cpu",
          "type": "cpu",
          "shape": "hw:heatsink",
          "count": 2,
          "at": [70, 430, 3],
          "pitch": [200, 0, 0],
          "size": [90, 90, 50],
          "label": "CPU and cooler"
        },
        {
          "id": "dimm",
          "type": "dimm",
          "shape": "hw:dimm",
          "count": 8,
          "at": [175, 410, 3],
          "pitch": [11, 0, 0],
          "rotate": 90,
          "size": [133, 7, 31],
          "label": "DIMM"
        },
        {
          "id": "fan",
          "type": "fan",
          "shape": "hw:fan",
          "count": 5,
          "at": [20, 200, 0],
          "pitch": [80, 0, 0],
          "size": [62, 40, 60],
          "label": "Fan"
        },
        {
          "id": "psu",
          "type": "psu",
          "shape": "hw:psu",
          "at": [0, 0, 0],
          "size": [85, 190, 40],
          "label": "PSU"
        }
      ],
      "programs": [
        {
          "id": "internals",
          "stages": [
            { "label": "Fans and PSU", "parts": ["type:fan", "type:psu"], "direction": "up" },
            {
              "label": "CPUs and memory",
              "parts": ["type:cpu", "type:dimm"],
              "direction": "lift",
              "details": true
            }
          ]
        }
      ]
    }
  ],
  "racks": [
    {
      "id": "r1",
      "label": "Rack R1",
      "slots": [
        { "id": "tor", "at": 41, "type": "switch-tor", "label": "ToR" },
        {
          "id": "srv",
          "at": 20,
          "type": "server-2u",
          "label": "App server",
          "assembly": "srv-internals"
        },
        { "id": "db", "at": 16, "type": "server-2u", "label": "DB server" }
      ]
    }
  ],
  "steps": [
    { "caption": "Rack R1", "duration": 2 },
    {
      "caption": "The app server slides out",
      "assembly": [{ "explode": "r1", "to": 2 }],
      "focus": "r1/srv",
      "duration": 4
    },
    {
      "caption": "Lid off, fans and PSU up",
      "assembly": [{ "explode": "r1/srv", "to": 2 }],
      "focus": "r1/srv",
      "duration": 4
    },
    {
      "caption": "CPUs and memory",
      "assembly": [{ "explode": "r1/srv" }],
      "focus": "r1/srv/cpu-1",
      "duration": 4
    },
    {
      "caption": "Closed and racked",
      "assembly": [{ "implode": "r1/srv" }, { "implode": "r1" }],
      "duration": 5
    }
  ]
}
```

`r1/srv`'s own program is `internals` (lid, then the template's two stages, so `to: 2` is lid
plus fans and PSU). Step 2 uses the rack's built-in `drawers` program; with `to: 2` all slots
slide, so a real spec would select one slot with a custom program; step 3 alone would also work
(implicit access, §8.3).

### 19.5 Generic brick rover: build in 8 steps with a sub-build, then explode and implode

Synthetic model (no third-party content). 33 leaves, `stud` units (x, y studs; z plates).

```json
{
  "$schema": "https://platformcosmo.io/schema/v1.json",
  "meta": { "version": "1", "title": "Brick rover" },
  "assemblies": [
    {
      "id": "rover",
      "label": "Brick rover",
      "units": "stud",
      "fit": 5,
      "parts": [
        {
          "id": "plate",
          "shape": "brick:plate",
          "at": [0, 0, 2],
          "size": [6, 10, 1],
          "color": "gray"
        },
        {
          "id": "side",
          "shape": "brick:brick",
          "count": 2,
          "at": [0, 2, 3],
          "pitch": [5, 0, 0],
          "size": [1, 6, 3],
          "color": "blue"
        },
        {
          "id": "rear-wall",
          "shape": "brick:brick",
          "at": [1, 0, 3],
          "size": [4, 1, 3],
          "color": "blue"
        },
        {
          "id": "wheel-l",
          "type": "wheel",
          "shape": "brick:round",
          "axis": "x",
          "count": 2,
          "at": [-1, 1, 0],
          "pitch": [0, 6, 0],
          "size": [1, 2, 5],
          "color": "#222222"
        },
        {
          "id": "wheel-r",
          "type": "wheel",
          "shape": "brick:round",
          "axis": "x",
          "count": 2,
          "at": [6, 1, 0],
          "pitch": [0, 6, 0],
          "size": [1, 2, 5],
          "color": "#222222"
        },
        {
          "id": "tile",
          "shape": "brick:tile",
          "count": 3,
          "at": [1, 2, 3],
          "pitch": [0, 2, 0],
          "size": [4, 2, 1],
          "color": "gray"
        },
        {
          "id": "lamp",
          "shape": "brick:round",
          "count": 2,
          "at": [0, 9, 3],
          "pitch": [5, 0, 0],
          "size": [1, 1, 1],
          "color": "yellow"
        },
        {
          "id": "nose",
          "shape": "brick:slope",
          "rotate": 90,
          "at": [1, 8, 3],
          "size": [2, 4, 3],
          "color": "red"
        },
        {
          "id": "cab",
          "at": [1, 2, 4],
          "label": "Cab",
          "parts": [
            { "id": "base", "shape": "brick:plate", "size": [4, 4, 1], "color": "gray" },
            {
              "id": "wall",
              "shape": "brick:brick",
              "count": 2,
              "at": [0, 0, 1],
              "pitch": [3, 0, 0],
              "size": [1, 4, 3],
              "color": "red"
            },
            {
              "id": "back",
              "shape": "brick:brick",
              "at": [1, 0, 1],
              "size": [2, 1, 3],
              "color": "red"
            },
            {
              "id": "windshield",
              "shape": "brick:tile",
              "at": [1, 3, 1],
              "size": [2, 1, 3],
              "tone": "glass"
            },
            {
              "id": "roof",
              "shape": "brick:plate",
              "at": [0, 0, 4],
              "size": [4, 4, 1],
              "color": "red"
            },
            {
              "id": "roof-a",
              "shape": "brick:tile",
              "count": 2,
              "at": [0, 0, 5],
              "pitch": [2, 0, 0],
              "size": [2, 2, 1],
              "color": "#eeeeee"
            },
            {
              "id": "roof-b",
              "shape": "brick:tile",
              "count": 2,
              "at": [0, 2, 5],
              "pitch": [2, 0, 0],
              "size": [2, 2, 1],
              "color": "#eeeeee"
            }
          ],
          "programs": [
            {
              "id": "cab-build",
              "kind": "build",
              "steps": [
                { "number": 1, "add": ["base"] },
                { "number": 2, "add": ["wall-*", "back", "windshield"] },
                { "number": 3, "add": ["roof", "roof-a-*", "roof-b-*"] }
              ]
            }
          ]
        },
        {
          "id": "cargo",
          "shape": "brick:brick",
          "count": 2,
          "at": [1, 6, 4],
          "pitch": [2, 0, 0],
          "size": [2, 2, 3],
          "color": "orange"
        },
        {
          "id": "rail",
          "shape": "brick:tile",
          "count": 2,
          "at": [0, 2, 6],
          "pitch": [5, 0, 0],
          "size": [1, 6, 1],
          "color": "gray"
        },
        {
          "id": "lid",
          "shape": "brick:tile",
          "count": 2,
          "at": [1, 6, 7],
          "pitch": [2, 0, 0],
          "size": [2, 2, 1],
          "color": "orange"
        },
        {
          "id": "antenna",
          "shape": "brick:round",
          "count": 3,
          "at": [4, 7, 8],
          "pitch": [0, 0, 3],
          "size": [1, 1, 3],
          "color": "#eeeeee"
        }
      ],
      "programs": [
        {
          "id": "build",
          "kind": "build",
          "steps": [
            { "number": 1, "caption": "Base plate", "add": ["plate"] },
            { "number": 2, "caption": "Sides and rear wall", "add": ["side-*", "rear-wall"] },
            { "number": 3, "caption": "Wheels", "add": ["wheel-*"], "from": "outside" },
            { "number": 4, "caption": "Floor tiles and lamps", "add": ["tile-*", "lamp-*"] },
            { "number": 5, "caption": "Nose", "add": ["nose"], "view": 90 },
            {
              "number": 6,
              "caption": "Cab (sub-build)",
              "add": ["cab"],
              "subBuild": "cab",
              "program": "cab-build",
              "view": 0
            },
            {
              "number": 7,
              "caption": "Cargo and rails",
              "add": ["cargo-*", "rail-*"],
              "from": "callout"
            },
            { "number": 8, "caption": "Lids and antenna", "add": ["lid-*", "antenna-*"] }
          ]
        },
        {
          "id": "explode",
          "stages": [
            { "label": "Cab and antenna", "parts": ["cab", "antenna-*"], "direction": "up" },
            { "label": "Wheels", "parts": ["type:wheel"], "direction": "out" },
            {
              "label": "Everything else",
              "parts": ["*"],
              "except": ["plate", "cab", "antenna-*", "type:wheel"],
              "direction": "lift",
              "labels": "hide"
            }
          ]
        }
      ]
    }
  ],
  "steps": [
    {
      "caption": "Steps 1-2",
      "assembly": [{ "build": "rover", "program": "build", "advance": 2 }],
      "duration": 4
    },
    { "caption": "Steps 3-4", "assembly": [{ "build": "rover", "advance": 2 }], "duration": 4 },
    {
      "caption": "Steps 5-6: nose and cab",
      "assembly": [{ "build": "rover", "advance": 2 }],
      "duration": 6
    },
    { "caption": "Steps 7-8", "assembly": [{ "build": "rover", "advance": 2 }], "duration": 4 },
    {
      "caption": "Exploded",
      "assembly": [{ "explode": "rover", "program": "explode" }],
      "focus": "rover",
      "duration": 5
    },
    {
      "caption": "Imploded",
      "assembly": [{ "implode": "rover", "program": "explode" }],
      "duration": 4
    }
  ]
}
```

The rest frame shows the finished rover (`pose: assembled`); the loop starts at build level 0
(first action `advance: 2` from 0), so the unbuilt parts fade out during the opening 0.4 s.

The OCP-style 2OU server and the figure-mode heat-sink example are in
[document ingestion](./document-ingestion.md#7-examples).

## 20. Out of scope (1.2)

- Rotations other than quarter turns about z; tilted, hinged, flexible or animated-rotation
  parts (doors swing as slides; fans do not spin); perspective cameras; free view rotation
  (quarter-turn views only, assembly-only specs).
- Edges, flows and cables attached to part paths (they attach to the assembly; DC cables to
  displaced slots hide).
- Physics, collision-free path planning (moves are straight; collisions only warned),
  overshoot or spring easings.
- Booleans, fillets, curved surfaces beyond cylinders/rings, curved slopes; texture mapping
  other than planar decals on box faces; reading text in images; OCR.
- Remote images, image fetching of any kind; WebP, GIF, AVIF, HEIC, TIFF, BMP inputs; animated
  images.
- Automatic 3D reconstruction from images (Claude places parts; the engine only renders).
- Editing or re-encoding images inside `render` (crop is an SVG viewport; resizing and
  cut-outs are `pcosmo assets` commands).
- Technic-style angled connections, stickers as separate geometry (use decals), minifigures.
- Bundling third-party documents, booklets, artwork or trademarks in packs, tests or the gallery.

## 21. Decisions taken and open questions

Decided by the user (review of #60): reduced motion jumps between per-step poses for specs with
assembly actions only (§12); the poster is `assembled` by default, `pose: "exploded"` opts in
(§7.4); the merge guard ships with the schema (§0 of the tracks); WebP is rejected with a PNG/JPEG
hint (§11.2); no `jpeg-js`: JPEG is passed through, only PNG is re-encoded (ingestion §5);
encrypted PDFs with an empty user password are supported in the PDF phase, others refused
(ingestion §4.1); close-ups and quarter-turn views ship in Phase 2; image caps 2 MiB per image,
8 MiB total, warning at 1 MiB (4 MiB for document outputs).

Interpretations taken in A2-3 (scene): `away` leaves the mate, i.e. the direction from the mate's
contact face toward the part; `inserts` leaves through the entry face; generic interpenetration
leaves along the axis of least penetration (before the `out` fallback); a descendant
selected in the same stage as its selected ancestor is not a separate mover; `overrides[].order`
ranks before the stage `order`; `ProgramLevel.program` of a sub-assembly program is
`<owner path below the assembly>/<program id>` (a root program is its plain id); implicit access
is one move (`ProgramLevel.only`, `ResolvedAction.accessLength`); reach covers the programs the
actions (and the base pose) play, added together (programs of one owner can be exploded together);
levels come from one machine shared by validation and the plan (`schema/assembly-levels.ts`).

Open: none blocking the schema; implementation-level questions are listed per PR in the tracks.
