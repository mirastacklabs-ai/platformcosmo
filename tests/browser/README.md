# Browser check

Checks that a diagram animates in `<img>`, inline and `<object>` in Chromium, Firefox and WebKit
(Playwright) and in real Safari (WebDriver), that reduced motion is static, that dark mode applies,
and that nothing leaves localhost. Nothing is installed on the host.

## Run (Playwright, containers)

```
tests/browser/run.sh                 # generated fixtures
tests/browser/run.sh path/to/svgs    # every *.svg in that directory (e.g. real render() output)
UPDATE_RESULTS=1 tests/browser/run.sh   # also refresh tests/browser/RESULTS.md
```

`run.sh` typechecks and runs the fixture generator in the pnpm container, then runs `check.mjs`
in the Playwright image pinned by digest (`PW_VERSION` selects the tag; the playwright npm package
comes from the committed `package-lock.json` through `npm ci` and must equal the image version).
Output: `tests/browser/out/results.json` and `RESULTS.md` (commit, image digest, versions, date,
counts). The exit code is non-zero on any FAIL.

### Checking real `render()` output

Write the animated SVGs to a directory (and optionally `name.expected.png` plus a `fixture.json`
if you want the fixture-specific checks) and pass it to `run.sh`. Generic checks run on every SVG:
animates in each embedding (deterministic time control for inline and `<object>`, a sampled retry
budget for `<img>`), not blank, reduced motion static (inline and `<object>`), dark mode changes
the rendering, no request leaves localhost. A static `<img>` is a hard FAIL unless the engine is in
the printed allowlist in `check.mjs` and the media probe proves the cause.

## Real Safari

`safari.mjs` is a dependency-free WebDriver client (plain `fetch` to safaridriver on
127.0.0.1) that serves the same pages and checks animation in the three embeddings. Safari cannot
emulate reduced motion or dark mode, so those are recorded, not switched. It writes
`results-safari.json` with the Safari version. Never run it with `safaridriver` on a developer
machine you use; it takes over Safari. It is meant for CI.

## CI job snippets

Ubuntu, Playwright engines (Docker is preinstalled; the script needs bash, docker and git):

```yaml
browser-check:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - run: tests/browser/run.sh
    - uses: actions/upload-artifact@v4
      if: always()
      with:
        name: browser-check
        path: tests/browser/out/
```

macOS, real Safari (generate the fixtures in the Ubuntu job or locally and upload them, or use
`actions/setup-node` here only to run the dependency-free scripts):

```yaml
safari-check:
  runs-on: macos-latest
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with: { node-version: 24 }
    # fixtures: download the browser-check artifact into tests/browser/out/fixtures
    - run: sudo safaridriver --enable
    - run: |
        safaridriver -p 4444 &
        sleep 2
        INPUT_DIR=tests/browser/out/fixtures GIT_SHA=$(git rev-parse --short HEAD) \
          node tests/browser/safari.mjs
    - uses: actions/upload-artifact@v4
      if: always()
      with:
        name: safari-check
        path: tests/browser/out/results-safari.json
```

## Files

- `run.sh` driver; `generate.test.ts` fixture generator (vitest, not in the normal run)
- `check.mjs` Playwright checks and report; `safari.mjs` Safari checks
- `server.mjs` shared local http server and embedding pages
- `package.json`, `package-lock.json` pinned playwright (container only)
