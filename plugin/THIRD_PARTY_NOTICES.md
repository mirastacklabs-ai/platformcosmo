# Third-party notices

`bin/pcosmo.mjs` is a single-file bundle of PlatformCosmo (Apache-2.0, Copyright 2026 MiraStack Labs) and the
third-party packages below. Each keeps its own license.

| Package                                                           | License      | Source                                                                     |
| ----------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------- |
| ajv                                                               | MIT          | https://github.com/ajv-validator/ajv                                       |
| fast-deep-equal                                                   | MIT          | https://github.com/epoberezkin/fast-deep-equal                             |
| fast-uri                                                          | BSD-3-Clause | https://github.com/fastify/fast-uri                                        |
| json-schema-traverse                                              | MIT          | https://github.com/epoberezkin/json-schema-traverse                        |
| require-from-string                                               | MIT          | https://github.com/floatdrop/require-from-string                           |
| @resvg/resvg-wasm (added to the bundle when PNG/GIF export lands) | MPL-2.0      | https://github.com/yisibl/resvg-js and https://github.com/RazrFalcon/resvg |
| SVGO (added with the optimizer)                                   | MIT          | https://github.com/svg/svgo                                                |

The MPL-2.0 covers the resvg WebAssembly binary only. Its source is available at the links above, and the
unmodified binary is embedded in the bundle. Icon packs shipped with the CLI carry their own licenses and notices
(see each pack's `icons.json`).

Update this file whenever a bundled dependency changes (`scripts/pc run bundle:plugin` rebuilds the bundle).
