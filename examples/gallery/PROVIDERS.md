# Provider icon renders

Only the **rendered diagrams** of provider examples are committed (DECISIONS D12), and only for providers whose terms
have been confirmed. The icon packs themselves are fetched on the machine that renders and are never committed or
redistributed.

AWS, Azure, Google Cloud, Kubernetes and the brands in Simple Icons are trademarks of their owners; use does not imply
endorsement.

## AWS (rendered: `aws-three-tier`)

Terms, checked 2026-11-18 at https://aws.amazon.com/architecture/icons/:

> We allow customers and partners to use these toolkits and assets to create architecture diagrams.

The same page adds that the icons can also be put in materials such as whitepapers, presentations, data sheets and
posters. Read the page for the complete terms.

Pack the render was made from (`pcosmo icons add aws` into a temporary directory, never committed):

| Item                                    | Value                                                                                                                                                                 |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pack / version                          | `aws` / `07312026` (797 icons)                                                                                                                                        |
| Zip                                     | https://d1.awsstatic.com/onedam/marketing-channels/website/public/shared/architecture-icon-release/Icon-package_07312026.5846e92413caa21490223536cc97f1269e44fa92.zip |
| Last-Modified                           | Thu, 06 Aug 2026 07:01:09 GMT                                                                                                                                         |
| ETag                                    | `"06ce0fa0fe50fb7ca17782f07824faeb"`                                                                                                                                  |
| Size                                    | 13,988,918 bytes                                                                                                                                                      |
| SHA-256 of the zip                      | `d2d166c453526471749d520e0db022c459abef759d2946cf2dd1d1c992dc6526`                                                                                                    |
| Lockfile integrity (`pcosmo icons add`) | `sha256-uroF89FYhYPvGvphGZEOD60jgTilTFObW7Ibfd4b7ZU=`                                                                                                                 |

Re-rendered 2026-11-18 on main 1538908 with a fresh `pcosmo icons add aws` (same pack version and lock integrity as
above; the render bytes changed with the engine).

Refs used: `aws:amazon-route-53`, `aws:amazon-cloudfront`, `aws:elastic-load-balancing`, `aws:amazon-ec2`,
`aws:amazon-elasticache`, `aws:amazon-rds`, `aws:amazon-simple-storage-service`. All resolve (`pcosmo validate --packs-dir`
passes).

`gen:gallery` prints each pack's lockfile integrity when `--packs-dir` is given, so a re-render can be compared with the
values above.

## Azure (not rendered: `azure-web-app`)

Terms require human confirmation (`pcosmo icons add azure --accept-terms` is a human decision). Not rendered;
`gen:gallery` skips the example with a message.

## Google Cloud (not rendered: `gcp-data-pipeline`)

Terms require human confirmation (decision D30). Not rendered; `gen:gallery` skips the example with a message. The
spec is kept and its icon refs were corrected against the pack manifest (`gcp:cloud-run`, `gcp:bigquery`,
`gcp:cloud-storage`, `gcp:looker`; the pack has no Pub/Sub or Dataflow icon, so Pub/Sub keeps the semantic queue glyph).

## How icons are drawn

Provider icons are drawn upright and unskewed on the front face of an object (PLAN section 8), as the committed AWS
render shows; they are never skewed onto the top face.

## Reproducing

```sh
scripts/pc run build
docker run --rm -v "$PWD":/work -w /work node:24.21-bookworm-slim sh -c '
  node packages/cli/dist/bin.js icons add aws --packs-dir /tmp/packs
  node packages/cli/scripts/gen-gallery.mjs --only aws-three-tier --packs-dir /tmp/packs'
```

The output is deterministic for a given engine and pack version (two consecutive runs produce identical bytes).
`scripts/pc run check:gallery` re-renders the bundled-icon examples and compares them with any committed renders.
