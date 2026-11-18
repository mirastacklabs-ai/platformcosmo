Statically linked Rust crates in `@resvg/resvg-wasm` 2.6.2 (`index_bg.wasm`)

Sources, fetched at development time and recorded here (the npm package ships no license or dependency listing):

- https://raw.githubusercontent.com/yisibl/resvg-js/v2.6.2/Cargo.toml (resvg-js 2.6.2: resvg 0.34.0 and the direct dependencies)
- https://raw.githubusercontent.com/RazrFalcon/resvg/v0.34.0/crates/{resvg,usvg,usvg-parser,usvg-tree,usvg-text-layout}/Cargo.toml
- https://raw.githubusercontent.com/RazrFalcon/tiny-skia/v0.10.0/Cargo.toml

The wasm binary links these crates (license expressions as the crates publish them). Where a crate offers a
choice ("OR"), PlatformCosmo redistributes it under the MIT or Apache-2.0 option; the full texts of MPL-2.0,
Apache-2.0, MIT and BSD-3-Clause are included in this file. The exact transitive set is fixed by resvg-js's
Cargo.lock, which the npm package does not publish; additional transitive crates are under MIT, Apache-2.0,
BSD or Zlib terms.

| Crate | License |
|---|---|
| resvg, usvg, usvg-parser, usvg-tree, usvg-text-layout (0.34.0) | MPL-2.0 |
| tiny-skia, tiny-skia-path (0.10) | BSD-3-Clause |
| svgtypes, kurbo, ttf-parser, unicode-bidi, unicode-script, unicode-vo, data-url, roxmltree, simplecss, siphasher, flate2, png, jpeg-decoder, gif, base64, log, once_cell, arrayvec, serde, serde_json, thiserror, futures, wasm-bindgen, js-sys, pathfinder_geometry, pathfinder_content, pathfinder_simd | MIT OR Apache-2.0 |
| rustybuzz, fontdb, rctree, strict-num, imagesize, rgb, xmlwriter, woff2 | MIT |
| arrayref | BSD-2-Clause |
| bytemuck | Zlib OR Apache-2.0 OR MIT |

BSD-2-Clause and Zlib crates are redistributed under their own terms (BSD-2-Clause: the BSD-3-Clause text without
clause 3; Zlib: the crate chooses MIT or Apache-2.0 above where offered).
