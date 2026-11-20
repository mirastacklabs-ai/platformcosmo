---
"@platformcosmo/core": minor
---

Image assets: `prepareImage` validates PNG, JPEG and SVG bytes (magic bytes, header dimensions, caps, APNG rejection, metadata stripped without re-encoding, EXIF orientation read first) and returns a hashed `ImageAsset`; `decodeImageDataUri` and `DEFAULT_IMAGE_LIMITS` are exported with it.
