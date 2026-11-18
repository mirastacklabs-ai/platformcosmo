# PlatformCosmo: Implementation Plan

**PlatformCosmo by MiraStack Labs.** A Claude Code plugin and CLI that turns a prompt into an animated 2.5D isometric SVG diagram for cloud, platform engineering, AI and data-center architectures. Open source under Apache-2.0.

---

## 1. Identity

| Item | Value |
|---|---|
| Product | PlatformCosmo |
| Publisher | MiraStack Labs |
| GitHub repo | `mirastacklabs-ai/platformcosmo` |
| Claude Code plugin | `platformcosmo` |
| Commands | `/platformcosmo:diagram`, `/platformcosmo:icons`, `/platformcosmo:export` |
| CLI binary | `pcosmo` (npm package `platformcosmo`) |
| npm scope | `@platformcosmo/*` |
| Docs | `platformcosmo.io` |
| Schema URL | `https://platformcosmo.io/schema/v1.json` |
| Spec file | `*.cosmo.json` (YAML `*.cosmo.yaml` accepted, converted to JSON) |
| License | Apache-2.0, `Copyright 2026 MiraStack Labs`; DCO sign-off for contributions |
| Runtime | Node >= 22.12 (Node 20 is EOL as of 2026-04-30 and the toolchain dropped it), TypeScript, ESM; CI tests Node 22 and 24 |

---

## 2. Goals

**Goal:** prompt → spec → deterministic engine → self-contained animated SVG. The SVG works in `<img>`, inline, `<object>` and CSS backgrounds, with no JS.

**Core principle:** Claude only writes the spec. All geometry, layout and drawing is deterministic code.

**Non-goals for v1:**
- A WYSIWYG editor
- A true 3D camera
- A hosted service
- Redistributing the AWS/Azure/GCP icon packs

---

## 3. Pipeline

```
prompt → Skill → spec (.cosmo.json)
  → validate (JSON Schema + semantic checks)
  → layout (auto, iso grid)
  → scene graph (3D boxes, edges, labels, particles)
  → depth sort → SVG emit (+ CSS/SMIL animation)
  → optimize (SVGO, animation-safe config)
  → outputs: animated / static / steps / png / interactive
```

---

## 4. Repo layout

```
platformcosmo/
├── packages/
│   ├── core/          @platformcosmo/core       engine + programmatic API
│   ├── cli/           platformcosmo (bin: pcosmo)
│   ├── icons-base/    @platformcosmo/icons-base
│   ├── themes/        @platformcosmo/themes
│   └── dc-pack/       @platformcosmo/dc-pack     (v1.1)
├── plugin/
│   ├── .claude-plugin/plugin.json
│   └── skills/
│       ├── diagram/SKILL.md  (+ references/, examples/)
│       ├── icons/SKILL.md
│       └── export/SKILL.md
├── .claude-plugin/marketplace.json
├── .claude/           settings.json + hooks/ (container-only guard for agents)
├── schema/v1.json
├── scripts/           pc (container wrapper), version sync, codegen
├── examples/          launch gallery (specs + rendered outputs)
├── docs/              platformcosmo.io source
├── LICENSE  NOTICE  LICENSES/
├── CONTRIBUTING.md  CODE_OF_CONDUCT.md  SECURITY.md  .github/CODEOWNERS
└── .github/workflows/ ci.yml, release.yml, visual-regression.yml (M1)
```

**Tooling:** pnpm workspaces, tsup/esbuild, Vitest, Changesets, ESLint + Prettier. All of it runs in Docker via `scripts/pc`; nothing is installed on the host.

---

## 5. Spec v1

| Section | Fields |
|---|---|
| `$schema` | Root-level (where editors look): `https://platformcosmo.io/schema/v1.json` |
| `meta` | `version`, `title`, `description` (become the SVG `<title>`/`<desc>`) |
| `canvas` | `theme`, `grid`, `padding`, `aspect` |
| `nodes[]` | `id`, `type` (semantic), `icon` (optional, e.g. `aws:rds`), `label`, `badge`, `size`, `pos` (optional override), `group` |
| `groups[]` | `id`, `label`, `style` (zone / vpc / cluster / platform) |
| `edges[]` | `from`, `to`, `label`, `style`, `bidirectional` |
| `flows[]` | `edge`, `kind` (normal / heavy / health / failed), `rate`, `color` |
| `metrics[]` | `id`, `label`, `value` (rendered as tiles) |
| `steps[]` | `caption`, `set` (state changes), `flows`, `metrics`, `duration` |
| `legend` | `auto`, or a manual list |

**Validation layers:**
1. JSON Schema
2. Semantic checks: unknown ids, edges to missing nodes, icons not installed, overlapping manual positions
3. Fuzzy "did you mean" suggestions

**Version policy:**
- `meta.version` is the spec format's **major** version, a string (`"1"`). The schema URL is per major (`/schema/v1.json`) and never moves.
- Within a major, changes are **additive only**: new optional fields, new enum values, looser limits. `meta.version` stays `"1"`; v1.1's DC fields (`racks[]`, `rows[]`, `aisles[]`, `cables[]`) land in `v1.json` as optional fields.
- The schema also has a semver **revision** (`1.0.0`, `1.1.0`, …) kept in the schema file and exported by core. The engine's revision decides which fields it accepts.
- Specs fail closed: root `additionalProperties: false` means an older engine rejects fields it doesn't know, and the error names the field and says to upgrade `platformcosmo`.
- Breaking changes need a new major: `meta.version: "2"`, `schema/v2.json`, and `migrate()` in core (exposed as `pcosmo migrate`) that rewrites v1 specs. Core keeps validating every supported major. A field is deprecated (validator warning) for at least one minor release before a major removes it.

**Schema export:**
- `@platformcosmo/core` ships the schema as `@platformcosmo/core/schema/v1.json`, the raw file copied into `dist`. It also exports `specSchema`, `SCHEMA_ID` and `SCHEMA_REVISION`.
- The docs site serves the same file at the `$id` URL (M5), and CI checks that the two copies are byte-identical.
- Editors get completion from the spec's root `$schema`. Validation never fetches the URL.

---

## 6. Engine modules (`@platformcosmo/core`)

| Module | Responsibility |
|---|---|
| `schema/` | Load, validate, convert YAML to JSON, migrate spec versions; export the bundled schema (see §5) |
| `layout/` | Layered left-to-right layout on the iso grid; group packing; collision avoidance; manual position overrides |
| `geometry/` | 2:1 dimetric projection; primitives (cube, hex prism, slab, platform, cylinder) built from top/left/right faces |
| `scene/` | Scene graph of boxes, edges, labels and badges |
| `depth/` | Depth ordering by box overlap comparison; edges split into segments |
| `routing/` | Orthogonal edge paths along the iso axes; arrowheads; label placement |
| `text/` | Font subset embedding (base64 WOFF2) or text-to-path; label measurement |
| `anim/` | Particles along paths; step timeline; state transitions |
| `emit/` | SVG writer: per-diagram id prefixes, `role="img"`, `<title>`/`<desc>`, `viewBox` only |
| `optimize/` | SVGO with a config that keeps the animations |
| `export/` | Static frame, per-step SVGs, PNG via resvg-js (no browser) |

**Budgets:**
- Typical diagram: under 150 KB, built in under 500 ms
- Hard limit: 5k elements, with a warning to split the diagram

---

## 7. Animation (no JS)

- **Particles:** SMIL `<animateMotion>` along edge paths; CSS `offset-path` as the fallback.
- **Steps (animated output):** one looping CSS master timeline; each step's changes become keyframes.
- **Steps (per-step output):** one static SVG per step, each with its own particle loops.
- **States:** healthy / degraded / down / highlighted, via CSS classes and color tokens.
- **Media queries inside the SVG:**
  - `prefers-reduced-motion`: static frame
  - `prefers-color-scheme`: dark theme
- **`--interactive`:** adds a small inline script for Play/Pause/Step. Only works when the SVG is inlined.

---

## 8. Icon system

**Manifest:** `icons.json` with id, aliases, category, provider, license, source URL and SVG path for each icon.

**Rules:**
- Semantic node type → default glyph; the `icon` field overrides it with a provider or brand icon
- Icons sit flat on the front face, never skewed onto the top face
- The build inlines only the icons a diagram uses

| Pack | Content | Distribution |
|---|---|---|
| `icons-base` | Lucide (ISC), K8s/CNCF (CC-BY 4.0, with attribution), Simple Icons (CC0, with trademark notice), original PlatformCosmo AI/platform glyphs | Bundled |
| Provider packs (AWS, Azure, GCP) | Official architecture icons | `pcosmo icons add aws`: the user's machine downloads from the official source and shows the provider's terms; never redistributed |
| Custom packs | Folder of SVGs + `icons.json` | `pcosmo icons add ./path` |

**Semantic types in v1:**
- Compute: server, vm, container, pod, function
- Network: lb, gateway, cdn, dns, firewall, vpc
- Data: sql, nosql, cache, object-store, warehouse, queue, stream
- Clients: users, client, mobile
- Observability: metrics, logs, traces
- CI/CD: repo, pipeline, registry
- Security: iam, secrets, waf
- AI: llm, embedding, vector-db, gpu, inference-server, agent, tool, rag, guardrail, feature-store, training-job

---

## 9. Data-center pack (v1.1, `@platformcosmo/dc-pack`)

- **Units:** rack height in U (1U = 44.45 mm); 600 mm floor tile grid.
- **Components (parametric, vendor-neutral):**
  - Rack (42/45/48U)
  - Servers (1U/2U/4U), blade chassis, generic 8-GPU node
  - ToR, spine and leaf switches; patch panel
  - Storage: shelf, all-flash array, JBOD, tape library
  - Power: PDU, UPS, busway
  - Cooling: CRAH, in-row cooler, rear-door heat exchanger, CDU
  - Facility: raised floor, perforated tiles, aisle containment, cable trays
- **Spec additions:** `racks[]` (`u`, `slots[]` with `at`/`size`/`type`); `rows[]`; `aisles[]`; `cables[]` (auto-routed, colored by type)
- **Flows:** airflow (cold aisle → hot aisle), power (utility → UPS → PDU → server), network (server → ToR → spine)
- **Zoom levels as steps:** hall → row → rack → server
- **No vendor trade dress:** generic shapes with text labels only

---

## 10. Outputs and flags

| Flag | Output |
|---|---|
| default | `name.svg` (animated, looping) |
| `--static` | `name.static.svg` (first frame) |
| `--steps` | `steps/step-NN.svg` |
| `--interactive` | `name.interactive.svg` |
| `--png` | `name.png` |
| `--gif` / `--mp4` (v1.2) | Optional; needs Puppeteer + ffmpeg |

**Other options:**
- `--theme light|dark|blueprint|mono|<file>`
- `--font embed|outline|system`
- `--speed <n>`

---

## 11. CLI (`pcosmo`)

| Command | Does |
|---|---|
| `init` | Write a starter spec |
| `validate <spec>` | Schema and semantic checks, with fix suggestions |
| `build <spec> [flags]` | Render outputs |
| `watch <spec>` | Rebuild on change |
| `icons add/list/search/remove` | Manage icon packs |
| `examples` | List and copy gallery specs |

---

## 12. Claude Code plugin

**`SKILL.md`:**
- When to trigger
- Condensed spec reference, with detail in `references/`
- 3 worked examples
- Hard rules:
  1. Never hand-write SVG; only write the spec
  2. Prefer auto-layout
  3. Always run `pcosmo validate`, fix errors, then `pcosmo build`
  4. Report the output paths

**Slash commands are skills.** Current Claude Code docs prefer `skills/` over the legacy `commands/` for new plugins; each skill directory becomes `/<plugin>:<skill>`.
| Skill | Slash command | Does |
|---|---|---|
| `skills/diagram/` | `/platformcosmo:diagram <description>` | Spec → validate → build (model-invocable) |
| `skills/icons/` | `/platformcosmo:icons [add/list/search]` | Manage icon packs (`disable-model-invocation: true`; it can touch the network) |
| `skills/export/` | `/platformcosmo:export <spec> [flags]` | Re-export an existing spec |

**Distribution (verified in M0, Claude Code 2.1.327):**
- `.claude-plugin/marketplace.json` (marketplace `platformcosmo`, plugin source `./plugin`).
- Install: `/plugin marketplace add mirastacklabs-ai/platformcosmo`, then `/plugin install platformcosmo@platformcosmo` (shell: `claude plugin marketplace add …` / `claude plugin install …`).
- CI runs `claude plugin validate . --strict` and `claude plugin validate ./plugin --strict`.
- Version sync: `packages/cli/package.json` is the source of truth. `scripts/sync-plugin-version.mjs` writes it into `plugin.json` and the marketplace entry during `changeset version`, and CI fails if they drift. Claude Code caches plugins by version, so this sync is how users get updates.

---

## 13. Quality and security

- **Tests:**
  - Unit tests: projection, layout, depth ordering, routing
  - SVG snapshot tests
  - Visual regression: resvg PNG diffs of the example gallery
  - Schema fuzz tests
- **Browser matrix:** Chrome, Firefox, Safari × `<img>`, inline, `<object>`.
- **Security:**
  - No network access except `icons add`, and only when asked
  - Escape all labels
  - No external references inside output SVGs
  - Dependabot, secret scanning, private vulnerability reporting
- **Supply chain:** npm publish from GitHub Actions with `--provenance`; branch protection; required CI.
- **Versioning:** semver on packages and on the schema; migrations for older specs.

---

## 14. Milestones

| Phase | Deliverable | Exit criteria |
|---|---|---|
| **M0 Setup** | Monorepo, tooling, CI, schema v0, governance files, marketplace syntax verified | CI green; publish dry run passes |
| **M1 Engine** | Projection, primitives, layout, depth, routing, static SVG; schema export (§5); visual-regression workflow | Load-balancer example renders correctly; snapshot tests pass |
| **M2 Animation** | Particles, step timeline, reduced motion, dark mode | Animates inside `<img>` in Chrome, Firefox and Safari |
| **M3 Icons** | `icons-base`, manifest, tree-shaking, fuzzy matching | 150+ icons; size budget met |
| **M4 Plugin + CLI** | 3 skills (`diagram`, `icons`, `export`), `pcosmo` | Claude builds all 5 launch examples from prompts without manual fixes |
| **M5 Outputs + docs** | Static/steps/PNG/interactive, themes, docs site, gallery | Gallery live on `platformcosmo.io` |
| **v1.0** | Public release | Checklist (section 16) done |
| **v1.1** | DC pack; AWS/Azure/GCP icon fetch | DC hall example plus 3 provider examples |
| **v1.2** | GIF/MP4 export; more lesson templates | Works on macOS and Linux |

**Launch examples:**
1. Load balancing (round robin, health checks, failover)
2. RAG pipeline
3. Kubernetes deployment
4. CDN + cache
5. GPU inference cluster

---

## 15. Risks

| Risk | Mitigation |
|---|---|
| Overlaps from LLM-placed nodes | Auto-layout by default; validator rejects collisions |
| Depth-sort artifacts | Box overlap comparison plus edge splitting; regression gallery |
| Icon licensing | Bundle only permissive sets; provider packs fetched by users; license recorded per icon |
| SVG bloat | Tree-shaking, font subsetting, SVGO, CI size budgets |
| Browser differences in SMIL/CSS | Browser test matrix; `offset-path` fallback |
| Scope creep | DC pack → v1.1; video → v1.2 |

---

## 16. Pre-launch checklist

- [ ] npm org `@platformcosmo` created; `platformcosmo` package claimed
- [ ] Repo `mirastacklabs-ai/platformcosmo` with branch protection, required CI and security features on
- [ ] npm provenance publishing via GitHub Actions
- [ ] Trademark search for "PlatformCosmo"
- [ ] Renew `platformbuilds.*` domains
- [ ] Redirect README in the `platformcosmo` GitHub org
- [ ] LICENSE, NOTICE, `LICENSES/` per icon pack; trademark notice in the README
- [ ] Plugin install tested end to end on a clean machine

---

## 17. Working rules for Claude Code

1. Work milestone by milestone (M0 → M5). Don't start the next milestone until the current one's exit criteria pass.
2. Every engine module ships with unit tests. Rendering changes update snapshots deliberately, never blindly.
3. Output must stay deterministic: same spec, byte-identical SVG.
4. No runtime network access in `core` or `cli`, except `icons add`.
5. Keep the schema in `schema/v1.json` as the single source of truth; generate TypeScript types from it.
6. Keep dependencies minimal; justify any new one in its PR.
7. Commit messages: Conventional Commits with DCO sign-off.
8. Run all Node tooling in containers through `scripts/pc`. A project PreToolUse hook (`.claude/hooks/container-only.sh`) blocks host `node`/`npm`/`pnpm` and similar for agents. It is a guardrail, not a sandbox.
