---
"platformcosmo": minor
"@platformcosmo/core": minor
---

CLI wiring for assemblies (D-1): the CLI passes the `hw:`, `brick:` and `auto:` shape registry (and the `dc:` pack) to validation and render, so pack shapes and their `params` are checked with did-you-mean and `brick:` placement gives `brick/off-grid`. `build --png-step N` writes the PNG of the end pose of step N (`options/invalid-png-step`, exit 2). `validate --suggest` prints the explode program and story proposed by assemblies section 17, as text and under `suggestions` with `--json`. Core gains a generic `placement` callback (`PartPlacement`) on `validate` and `render`, and `render` forwards `parts`. Specs without assemblies behave as before.
