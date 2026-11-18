# Provider icon renders

The provider examples in this folder (`aws-three-tier`, `gcp-data-pipeline`) use icons from provider packs. Only the
**rendered diagrams** are committed (DECISIONS D12). The packs themselves are fetched on the machine that renders and
are never committed or redistributed. Provider terms allow using these icons in architecture diagrams, training and
documentation; see each provider's terms.

AWS, Azure, Google Cloud, Kubernetes and the brands in Simple Icons are trademarks of their owners; use does not imply
endorsement.

## What was rendered from

Rendered 2026-11-18 with `pcosmo icons add <provider>` into a temporary directory, then
`scripts/pc run gen:gallery -- --only aws-three-tier,gcp-data-pipeline --packs-dir <dir>` semantics (see
`packages/cli/scripts/gen-gallery.mjs`).

| Pack                       | Icons | Source (resolved by `pcosmo icons add`)                                                                                                                                                                                          | License / terms                                                                 |
| -------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `aws` (version `07312026`) | 797   | https://d1.awsstatic.com/onedam/marketing-channels/website/public/shared/architecture-icon-release/Icon-package_07312026.5846e92413caa21490223536cc97f1269e44fa92.zip (landing page: https://aws.amazon.com/architecture/icons/) | `LicenseRef-aws-architecture-icons`: https://aws.amazon.com/architecture/icons/ |
| `gcp` (version `current`)  | 45    | https://services.google.com/fh/files/misc/core-products-icons.zip and https://services.google.com/fh/files/misc/category-icons.zip                                                                                               | `LicenseRef-google-cloud-icons`: https://cloud.google.com/icons                 |

Lockfile integrity at render time: `aws` `sha256-uroF89FYhYPvGvphGZEOD60jgTilTFObW7Ibfd4b7ZU=`, `gcp`
`sha256-5LDNrZ3KP6woH1duJ7ew3mlCMdkqC+G+OWZf+9ds7vU=`.

## Icon refs used

- `aws-three-tier`: `aws:amazon-route-53`, `aws:amazon-cloudfront`, `aws:elastic-load-balancing`, `aws:amazon-ec2`,
  `aws:amazon-elasticache`, `aws:amazon-rds`, `aws:amazon-simple-storage-service`. All resolve (`pcosmo validate` passes).
- `gcp-data-pipeline`: `gcp:cloud-run`, `gcp:bigquery`, `gcp:cloud-storage`, `gcp:looker`. The pack has no Pub/Sub or
  Dataflow icon, so the earlier refs `gcp:pub-sub` and `gcp:dataflow` were replaced and the example now uses a
  Cloud Run ingest service; Pub/Sub keeps its semantic queue glyph.

## Azure

`azure-web-app` is intentionally **not rendered**. Azure's icon terms must be accepted by a human
(`pcosmo icons add azure --accept-terms`); `gen:gallery` skips it with a message until that is done.

## Reproducing

```sh
scripts/pc run build
docker run --rm -v "$PWD":/work -w /work node:24.21-bookworm-slim sh -c '
  node packages/cli/dist/bin.js icons add aws --packs-dir /tmp/packs
  node packages/cli/dist/bin.js icons add gcp --packs-dir /tmp/packs
  node packages/cli/scripts/gen-gallery.mjs --only aws-three-tier,gcp-data-pipeline --packs-dir /tmp/packs'
```

The output is deterministic for a given engine and pack version (two consecutive runs produce identical bytes).
