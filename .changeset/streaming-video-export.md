---
"@platformcosmo/core": patch
"platformcosmo": patch
---

Fix `pcosmo build --gif` and `--mp4` failing with `export/too-large` on default options: GIF and MP4 frames are now rendered and encoded one at a time (GIF encoder and ffmpeg stdin), so memory is bounded by one frame. New limits: one frame at most 256 MiB of RGBA, at most fps x 120 s frames.
