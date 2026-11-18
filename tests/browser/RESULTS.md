# Browser check results (M2 exit evidence)

Run: `tests/browser/run.sh` (fixtures built in the pnpm container, checks in
`mcr.microsoft.com/playwright:v1.64.0-noble`, nothing installed on the host). Fixtures come from the
fixture RenderModel and the test-only emitter until Track A1's `render()` lands; re-run against
`render()` output then.

Browsers: chromium 156.0.8078.4, firefox 157.0, webkit 27.2. **34/37 checks pass, 3 limited, 0 failed.**

Limitations found:

- Image documents ignore Playwright's emulated media features, so reduced motion cannot be emulated
  for `<img>` in Chromium and Firefox; it is covered by the inline and `<object>` checks.
- Headless WebKit (Playwright build, Linux) evaluates `prefers-reduced-motion` as `reduce` inside
  `<img>` SVGs even with nothing emulated, so the full SVG shows its static frame there. With the
  reduced-motion block stripped, the same SVG animates in `<img>` (checked). This needs a
  confirmation in real Safari on macOS.

| browser  | mode                         | check                                                | result                                  |
| -------- | ---------------------------- | ---------------------------------------------------- | --------------------------------------- |
| chromium | img                          | animates (two screenshots differ)                    | pass                                    |
| chromium | img                          | reduced motion is static                             | limited                                 |
| chromium | inline                       | animates                                             | pass                                    |
| chromium | inline                       | reduced motion is static                             | pass                                    |
| chromium | object                       | animates                                             | pass                                    |
| chromium | object                       | reduced motion is static                             | pass                                    |
| chromium | inline                       | object state changes over the loop (opacity 1, 0.6)  | pass                                    |
| chromium | inline                       | reduced motion: static first frame, particles hidden | pass                                    |
| chromium | interactive                  | Step jumps to step 2 and pauses                      | pass                                    |
| chromium | interactive                  | paused: frames stay equal                            | pass                                    |
| chromium | interactive                  | Play resumes animation                               | pass                                    |
| chromium | interactive                  | no script errors                                     | pass                                    |
| firefox  | (same 12 checks as chromium) |                                                      | 11 pass, 1 limited (img reduced motion) |
| webkit   | img                          | animates (two screenshots differ)                    | limited                                 |
| webkit   | img                          | animates with the reduced-motion block stripped      | pass                                    |
| webkit   | (other 12 checks)            |                                                      | pass                                    |
