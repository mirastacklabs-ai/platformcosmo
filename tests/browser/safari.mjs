/* global setTimeout, fetch */
/**
 * Real Safari check over WebDriver (safaridriver on 127.0.0.1), dependency-free (plain fetch).
 * Same pages and server as the Playwright check. Runs on macOS only (CI: macos-latest after
 * `sudo safaridriver --enable`; see README.md). Never started by run.sh.
 *
 * Safari cannot emulate reduced motion or dark mode, so those are recorded (matchMedia values
 * and what an SVG image document sees), not switched.
 *
 * Env: SAFARIDRIVER_PORT (default 4444, start `safaridriver -p 4444` first), INPUT_DIR (default
 * tests/browser/out/fixtures), OUT_DIR (default tests/browser/out), GIT_SHA.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { MODES, listSvgs, startServer } from "./server.mjs";

const PORT = process.env.SAFARIDRIVER_PORT ?? "4444";
const IN = process.env.INPUT_DIR ?? "tests/browser/out/fixtures";
const OUT = process.env.OUT_DIR ?? "tests/browser/out";
const base = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

function rec(file, mode, check, status, detail = "") {
  results.push({ browser: "safari", file, mode, check, status, detail });
  console.log(`${status.toUpperCase().padEnd(8)} safari/${file}/${mode}: ${check} ${detail}`);
}

async function wd(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok || json.value?.error) {
    throw new Error(
      `${method} ${path}: ${json.value?.error ?? res.status} ${json.value?.message ?? ""}`,
    );
  }
  return json.value;
}

const server = await startServer(IN);
const session = await wd("POST", "/session", {
  capabilities: { alwaysMatch: { browserName: "safari" } },
});
const sid = session.sessionId;
const safariVersion = session.capabilities?.browserVersion ?? "(unknown)";
const s = (p) => `/session/${sid}${p}`;
const go = (path) => wd("POST", s("/url"), { url: `${server.origin}${path}` });
const exec = (script, args = []) => wd("POST", s("/execute/sync"), { script, args });
const shot = () => wd("GET", s("/screenshot"));

try {
  await wd("POST", s("/window/rect"), { width: 1280, height: 900, x: 0, y: 0 });

  // What a page and an SVG image document see (Safari cannot emulate, so this is the real value).
  await go("/ref/green");
  const green = await shot();
  await go("/ref/red");
  const red = await shot();
  const host = await exec(
    "return {reduce: matchMedia('(prefers-reduced-motion: reduce)').matches, dark: matchMedia('(prefers-color-scheme: dark)').matches}",
  );
  const image = {};
  for (const key of ["reduce", "no-preference", "dark"]) {
    await go(`/probe-page/${key}`);
    await sleep(300);
    const got = await shot();
    image[key] = got === red ? "matches" : got === green ? "no match" : "unknown";
  }
  rec(
    "-",
    "-",
    "probe",
    "info",
    `host reduce=${host.reduce}, dark=${host.dark}; <img> document matches reduce: ${image.reduce}, no-preference: ${image["no-preference"]}, dark: ${image.dark}`,
  );

  for (const file of listSvgs(IN)) {
    for (const mode of MODES) {
      await go(`/page/${mode}/${encodeURIComponent(file)}`);
      await sleep(400);
      let animated = false;
      if (mode === "img") {
        const seen = new Set();
        for (let i = 0; i < 10 && !animated; i++) {
          seen.add(await shot());
          animated = seen.size > 1;
          if (!animated) await sleep(450);
        }
      } else {
        const at = async (t) => {
          await exec(
            `const m = arguments[0], t = arguments[1];
             const root = m === 'object' ? document.getElementById('el').contentDocument.documentElement : document.querySelector('#host svg');
             root.pauseAnimations(); root.setCurrentTime(t);
             for (const a of root.ownerDocument.getAnimations()) { a.pause(); a.currentTime = t * 1000; }`,
            [mode, t],
          );
          await sleep(100);
          return shot();
        };
        const a = await at(0.5);
        const b = await at(1.7);
        const c = await at(0.5);
        animated = a !== b;
        rec(
          file,
          mode,
          "time control is deterministic (0.5 s twice is identical)",
          a === c ? "pass" : "fail",
        );
      }
      rec(
        file,
        mode,
        "animates",
        animated ? "pass" : "fail",
        animated ? "" : "static in real Safari",
      );
    }
  }
} finally {
  await wd("DELETE", s("")).catch(() => undefined);
  await server.close();
}

const failed = results.filter((r) => r.status === "fail").length;
const summary = `${results.filter((r) => r.status === "pass").length} pass, ${failed} FAIL`;
mkdirSync(OUT, { recursive: true });
writeFileSync(
  `${OUT}/results-safari.json`,
  JSON.stringify(
    {
      commit: process.env.GIT_SHA ?? "(unknown)",
      safari: safariVersion,
      date: new Date().toISOString(),
      summary,
      results,
    },
    null,
    2,
  ),
);
console.log(`Safari ${safariVersion}: ${summary}`);
process.exit(failed === 0 ? 0 : 1);
