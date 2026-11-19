# From-image E2E results

Manual run (no LLM in CI). A fresh Sonnet subagent that had not seen the ground truth, the checker or earlier specs
Read each PNG in `inputs/`, followed only `plugin/skills/diagram/SKILL.md` and its references, wrote the spec, and
validated and built it with the bundled CLI in `node:24.21-bookworm-slim`. `check.mjs` then scored it (strict
scorer: directed edge recall, node and edge precision, steps must equal the expected count, step i must animate
truth edge i). Generated specs and SVGs are not committed.

| Image                                | Labels | Directed edges | Undirected | Node prec. | Edge prec. | Groups | Steps (have / expected) | Validate attempts |
| ------------------------------------ | ------ | -------------- | ---------- | ---------- | ---------- | ------ | ----------------------- | ----------------- |
| `web-app.png` (flat boxes)           | 100%   | 100%           | 100%       | 100%       | 100%       | n/a    | 0 / 0                   | 1                 |
| `k8s-sequence.png` (cluster, 1 to 4) | 100%   | 100%           | 100%       | 100%       | 100%       | 100%   | 4 / 4, order ok         | 1                 |
| `whiteboard-rag.png` (sketch)        | 100%   | 100%           | 100%       | 100%       | 100%       | n/a    | 0 / 0                   | 1                 |

## Assumptions the model listed

- web-app: server for the app boxes, `cache` for Redis, dashed edges read as optional cache access (rate 0.5); title became `meta.title`.
- k8s-sequence: Web Service typed `lb` (a guess); the unnumbered Service to Pod 2 arrow drawn but not animated; step captions are the model's wording.
- whiteboard-rag: Documents as `object-store`, Chunker as `function`, Question and Answer as `client`; the underlined heading is a title, not a node.

## Skill gaps found and fixed

The run reported no deviations but flagged unclear points, now covered in `references/from-image.md`: top-level
`flows` when steps exist, unnumbered arrows inside a numbered sequence, and which of two paths is `heavy`. Not
fixed: type choice for non-infrastructure boxes (documents, processing steps, outputs) stays a judgement call.
The final report format was given in chat rather than written to a file, as designed.

## Limits

- All three scores are 100%, so the thresholds are not stressed; the inputs are clean synthetic images, and the
  scorer is structural only (not layout or type choice). Real screenshots and photos are untested.
- Same model family wrote the skill, the inputs and ran the test, so results are likely optimistic.
- Auto-layout does not keep the image's left-to-right tiers (the k8s render came out diagonal); the `pos` path is not exercised.
