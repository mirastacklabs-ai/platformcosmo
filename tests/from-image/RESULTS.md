# From-image E2E results

Manual run (no LLM in CI). The model (Sonnet 5.5) Read each PNG in `inputs/`, followed only
`plugin/skills/diagram/SKILL.md` and `references/from-image.md`, wrote the spec, then validated and built with the
bundled CLI in `node:24.21-bookworm-slim` and scored with `check.mjs`. Generated specs and SVGs are not committed
(`tests/from-image/out/`). Re-run: `plugin/bin/pcosmo validate|build <spec>`, then
`node tests/from-image/check.mjs <spec> inputs/<name>.truth.json`.

| Image                                | Labels | Edges | Groups | Steps (have / expected) | Validate attempts | Build |
| ------------------------------------ | ------ | ----- | ------ | ----------------------- | ----------------- | ----- |
| `web-app.png` (flat boxes)           | 100%   | 100%  | n/a    | 0 / 0                   | 1                 | ok    |
| `k8s-sequence.png` (cluster, 1 to 4) | 100%   | 100%  | 100%   | 4 / 4                   | 1                 | ok    |
| `whiteboard-rag.png` (sketch)        | 100%   | 100%  | n/a    | 0 / 0                   | 1                 | ok    |

## Assumptions the model listed

- web-app: person icon as `users`; cylinder labelled PostgreSQL as `sql`; Redis Cache as `cache`; dashed arrows to
  the cache kept as `style: dashed` flows at rate 0.5; "HTTPS" kept as the Users to CDN edge label.
- k8s-sequence: Ingress as `gateway`, Web Service as `lb` (closest to a service VIP); the unnumbered Service to
  Pod 2 arrow kept as an edge but not given a step; steps follow the badges 1 to 4.
- whiteboard-rag: Documents as `object-store`, Chunker as `function`; Question and Answer both as `client`
  (no better type); no steps because the sketch has no numbering.

## Deviations from the skill text

None. The skill text was sufficient on all three images; no changes were needed after the first run.

## Limits observed

- Scoring is structural (labels, edges, group membership, step count). It does not judge layout or type choice.
- The inputs are clean synthetic images. Real screenshots (dense, low resolution, rotated whiteboard photos,
  provider logos) are not covered and may need more assumptions than these runs did.
- Auto-layout does not keep the image's left-to-right tiers: the k8s render came out diagonal, and some edges route
  around nodes. That is why the skill offers `pos` overrides ("keep the layout"); that path is not exercised here.
- Hand-drawn shapes are matched by label only; the model never had to guess an unlabelled shape.
