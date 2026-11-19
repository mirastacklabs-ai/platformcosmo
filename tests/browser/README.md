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
in the Playwright image pinned by digest (the version is fixed in `run.sh`; override only the whole
`PW_IMAGE` reference, with the same version; the playwright npm package comes from the committed
`package-lock.json` through `npm ci` and must equal the image version). The "nothing leaves
localhost" check is Playwright only.
Output: `tests/browser/out/results.json` and `RESULTS.md` (commit, image digest, versions, date,
counts). The exit code is non-zero on any FAIL.

### Checking real `render()` output

Write the animated SVGs to a directory (and optionally `name.expected.png` plus a `fixture.json`
if you want the fixture-specific checks) and pass it to `run.sh`. Generic checks run on every SVG:
animates in each embedding (deterministic time control for inline and `<object>`, a sampled retry
budget for `<img>`), not blank, reduced motion static (inline and `<object>`), dark mode changes
the rendering, no request leaves localhost. A static `<img>` is a hard FAIL unless the engine is in
the printed allowlist in `check.mjs` and the media probe proves the cause.

CI renders every example twice: the default (`<name>.svg`) and the CSS `offset-path` motion
variant (`pcosmo build --motion css --name <name>.css-motion`, D32), so the same animates and
reduced-motion checks run on both in every engine and embedding.

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
    - run: scripts/pc install --frozen-lockfile
    - run: tests/browser/run.sh
    - uses: actions/upload-artifact@v4
      if: always()
      with:
        name: browser-check
        path: tests/browser/out/
```

macOS, real Safari (takes the fixtures from the Ubuntu job's artifact; `setup-node` only runs the
dependency-free scripts):

```yaml
safari-check:
  needs: browser-check
  runs-on: macos-latest
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with: { node-version: 24 }
    - uses: actions/download-artifact@v4
      with:
        name: browser-check
        path: tests/browser/out
    - run: sudo safaridriver --enable
    - run: |
        safaridriver -p 4444 &
        for i in $(seq 1 30); do
          curl -sf http://127.0.0.1:4444/status >/dev/null && break
          [ "$i" = 30 ] && { echo "safaridriver did not start" >&2; exit 1; }
          sleep 1
        done
        INPUT_DIR=tests/browser/out/fixtures GIT_SHA=$(git describe --always --dirty) \
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
