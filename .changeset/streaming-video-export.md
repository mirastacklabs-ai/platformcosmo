---
"@platformcosmo/core": patch
"platformcosmo": patch
---

Fix `pcosmo build --gif` and `--mp4` failing with `export/too-large` on default options: GIF and MP4 frames are now rendered and encoded one at a time (GIF encoder and ffmpeg stdin), so memory is bounded by one frame plus the encoded output. Limits: one frame (and a PNG) at most 256 MiB of RGBA, encoded output at most 1 GiB, and an encoder without streaming support keeps the 1 GiB whole-clip cap. Ctrl-C now stops ffmpeg and removes its temp files; a hung ffmpeg is killed after the timeout, and a wedged `ffmpeg -version` probe no longer hangs the build.

MP4 output changes: the CLI now uses core's ffmpeg encoder, so mp4 is encoded at x264 crf 18 with bit-exact flags (reproducible bytes for one ffmpeg build) instead of x264's default quality. The file grows accordingly (263 KB to 355 KB on the load-balancing example); odd-sized frames are still padded with white.
