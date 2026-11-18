# Node types

Pick the most specific `type`; it decides the glyph and the default icon.

| Area          | Types                                                                                                                            |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Compute       | `server`, `vm`, `container`, `pod`, `function`                                                                                   |
| Network       | `lb`, `gateway`, `cdn`, `dns`, `firewall`, `vpc`                                                                                 |
| Data          | `sql`, `nosql`, `cache`, `object-store`, `warehouse`, `queue`, `stream`                                                          |
| Clients       | `users`, `client`, `mobile`                                                                                                      |
| Observability | `metrics`, `logs`, `traces`                                                                                                      |
| CI/CD         | `repo`, `pipeline`, `registry`                                                                                                   |
| Security      | `iam`, `secrets`, `waf`                                                                                                          |
| AI            | `llm`, `embedding`, `vector-db`, `gpu`, `inference-server`, `agent`, `tool`, `rag`, `guardrail`, `feature-store`, `training-job` |

## Choosing

- A user or browser: `users` (a crowd) or `client` (one app). A phone app: `mobile`.
- An API gateway, ingress, service mesh entry: `gateway`. A load balancer: `lb`.
- A database: `sql` (relational), `nosql` (document/key-value), `warehouse` (analytics), `vector-db`.
- Object storage (S3, GCS, Blob): `object-store`. A message broker: `queue`. A log or event stream: `stream`.
- A GPU box serving a model: `inference-server`; the accelerator itself: `gpu`.
- Anything that does not fit: `server` with a clear `label`.

## Provider and brand icons

`icon: "pack:name"` overrides the glyph. Bundled packs include `cosmo` (originals), Lucide, Kubernetes and a
filtered Simple Icons set. AWS, Azure, GCP and CNCF icons are not bundled: the user installs them with
`/platformcosmo:icons add aws` (they download from the official source to the user's machine).
Always search before using one: `pcosmo icons search "load balancer"` prints valid `pack:name` refs.
