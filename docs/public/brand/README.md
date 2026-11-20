# MIRASTACK LABS brand assets

`mirastack-labs-mark.svg` is the MIRASTACK LABS logo mark (three slanted bars), unmodified.

- Source: https://www.mirastacklabs.ai/assets/img/favicon.svg (the site's own favicon and header mark)
- Retrieved: 2026-11-19
- SHA-256: `359a5fe959e272ddc89353a797569c761218721d5a532eec5d163ac8bf81521b`
- The wordmark ("MIRASTACK LABS") is live text set in JetBrains Mono by the docs theme, as on the sponsor site;
  there is no separate wordmark file.
- In the docs theme the teal bar follows the site's `--logo-teal` token (`#007a6e` light, `#00c9b1` dark), as on
  mirastacklabs.ai. The committed file keeps the favicon colours (`#00C9B1`, `#FF671F`, `#CED4DA`), which read on
  both light and dark backgrounds (used by the README and as the favicon).

© MIRASTACK LABS, used by the project's sponsor. The logo is a trademark of MIRASTACK LABS and is not covered by
the Apache-2.0 license of this repository.

`mirastack-labs-lockup-light.svg` and `-dark.svg` are the header lockup (mark plus wordmark) for the README, which cannot
load the site's fonts. They are built from the same three polygons and the site's wordmark spec (JetBrains Mono 16 px,
bold MIRASTACK in ink, LABS regular in muted, letter-spacing .08em), using the site's light and dark tokens
(`--logo-teal`, `--ink`, `--muted`). The mirastacklabs.ai site serves no standalone lockup file; it is inline markup there.
The docs site itself uses the exact inline markup and CSS of the site header (`theme/MiraLogo.vue`).
