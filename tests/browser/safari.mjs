/* global setTimeout, fetch */
/**
 * Real Safari check over WebDriver (safaridriver on 127.0.0.1), dependency-free (plain fetch).
 * Same pages and server as the Playwright check. Runs on macOS only (CI: macos-latest after
 * `sudo safaridriver --enable`; see README.md). Never started by run.sh.
 *
 * Safari cannot emulate reduced motion or dark mode, so those are recorded (matchMedia values
 * and what an SVG image document sees), not switched. The "nothing leaves localhost" check is
 * Playwright only (Safari has no request interception here).
 *
 * Env: SAFARIDRIVER_PORT (default 4444, start `safaridriver -p 4444` first), INPUT_DIR (default
 * tests/browser/out/fixtures), OUT_DIR (default tests/browser/out), GIT_SHA.
 * Results JSON is always written, also after a failure.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { MODES, listSvgs, startServer } from "./server.mjs";

const PORT = process.env.SAFARIDRIVER_PORT ?? "4444";
const IN = process.env.INPUT_DIR ?? "tests/browser/out/fixtures";
const OUT = process.env.OUT_DIR ?? "tests/browser/out";
const base = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let safariVersion = "(unknown)";

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

function writeResults() {
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
  return failed;
}

let server;
let sid;
let exitCode;
try {
  server = await startServer(IN);
  const session = await wd("POST", "/session", {
    capabilities: { alwaysMatch: { browserName: "safari" } },
  });
  sid = session.sessionId;
  safariVersion = session.capabilities?.browserVersion ?? "(unknown)";
  const s = (p) => `/session/${sid}${p}`;
  const go = (path) => wd("POST", s("/url"), { url: `${server.origin}${path}` });
  const exec = (script, args = []) => wd("POST", s("/execute/sync"), { script, args });
  // Paint first (two animation frames), then screenshot: a screenshot taken before the first
  // paint after navigation is a blank window.
  const settle = () =>
    wd("POST", s("/execute/async"), {
      script:
        "const done = arguments[arguments.length - 1]; requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 50)));",
      args: [],
    }).catch(() => undefined);
  const shot = async () => {
    await settle();
    return wd("GET", s("/screenshot"));
  };

  console.log("session capabilities:", JSON.stringify(session.capabilities));
  await wd("POST", s("/window/rect"), { width: 1280, height: 900, x: 0, y: 0 }).catch((e) =>
    console.log("window/rect failed:", e.message),
  );
  // Why a screenshot may be blank: what the page and window actually are.
  const diag = (label) =>
    exec(
      `const img = document.getElementById('el');
       return {
         href: location.href, readyState: document.readyState, title: document.title,
         visibility: document.visibilityState, hasFocus: document.hasFocus(),
         inner: [innerWidth, innerHeight], outer: [outerWidth, outerHeight], dpr: devicePixelRatio,
         body: document.body ? document.body.innerHTML.length : -1,
         img: img && img.tagName === 'IMG' ? [img.complete, img.naturalWidth] : null,
         reduce: matchMedia('(prefers-reduced-motion: reduce)').matches,
       }`,
    ).then(
      (d) => console.log(`diag ${label}:`, JSON.stringify(d)),
      (e) => console.log(`diag ${label} failed:`, e.message),
    );
  const hash = (b64) => createHash("sha1").update(b64).digest("hex").slice(0, 10);
  await wd("GET", s("/window/rect")).then((r) => console.log("window rect:", JSON.stringify(r)));
  await go("/blank");
  await diag("blank");
  const blank = await shot();
  console.log(`blank screenshot: ${blank.length} bytes b64, sha ${hash(blank)}`);

  // What a page and an SVG image document see (Safari cannot emulate, so this is the real value).
  await go("/ref/green");
  await diag("ref-green");
  const green = await shot();
  await go("/ref/red");
  await diag("ref-red");
  const red = await shot();
  console.log(`screenshots: blank ${hash(blank)}, green ${hash(green)}, red ${hash(red)}`);
  if (green === red || green === blank) {
    rec(
      "-",
      "-",
      "screenshots reflect the page",
      "fail",
      "WebDriver screenshots of different pages are identical (window not rendering?)",
    );
  }
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
      try {
        await go(`/page/${mode}/${encodeURIComponent(file)}`);
        if (mode === "img") {
          await exec("return document.getElementById('el').decode().then(() => true)");
        } else if (mode === "object") {
          // Wait (bounded) until the object's document exists.
          let ready = false;
          for (let i = 0; i < 40 && !ready; i++) {
            ready = await exec(
              "const d = document.getElementById('el').contentDocument; return !!(d && d.documentElement)",
            );
            if (!ready) await sleep(150);
          }
          if (!ready) throw new Error("object document did not load");
        }
        await sleep(300);
        await diag(`${file}/${mode}`);
        let animated = false;
        let first;
        if (mode === "img") {
          // No clock access to image documents: sample with a retry budget.
          const seen = new Set();
          for (let i = 0; i < 10 && !animated; i++) {
            const f = await shot();
            first ??= f;
            seen.add(f);
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
            await sleep(250);
            return shot();
          };
          const a = await at(0.5);
          const b = await at(1.7);
          const c = await at(0.5);
          first = a;
          animated = a !== b;
          // Safari may move a particle by a sub-pixel between seeks: identical bytes are not
          // required, only a record of whether they happen to be.
          rec(file, mode, "time control repeats (0.5 s twice)", "info", `identical: ${a === c}`);
        }
        rec(file, mode, "animates", animated ? "pass" : "fail", animated ? "" : "static in Safari");
        rec(
          file,
          mode,
          "not blank (differs from the empty page)",
          first !== blank ? "pass" : "fail",
        );
      } catch (e) {
        rec(file, mode, "ran without error", "fail", String(e?.message ?? e));
      }
    }
  }
} catch (e) {
  rec("-", "-", "harness", "fail", String(e?.message ?? e));
} finally {
  if (sid) await wd("DELETE", `/session/${sid}`).catch(() => undefined);
  if (server) await server.close();
  exitCode = writeResults() === 0 ? 0 : 1;
}
process.exit(exitCode);
