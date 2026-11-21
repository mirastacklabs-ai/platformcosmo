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
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { diffFraction as pixelDiff, ink as inkOf } from "./pngdiff.mjs";
import { MODES, listSvgs, startServer } from "./server.mjs";

const INFO = (() => {
  try {
    return JSON.parse(
      readFileSync(`${process.env.INPUT_DIR ?? "tests/browser/out/fixtures"}/fixture.json`, "utf8"),
    );
  } catch {
    return undefined;
  }
})();
/** B-2: assembly diagrams show discrete step poses under reduced motion (assemblies.md 12). */
const discreteOf = (file) => INFO?.assemblies?.[file] !== undefined;
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
let blankRun = false; // WebDriver screenshots were blank: the caller may retry with a fresh session
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
    }).catch((e) => console.log("settle failed (screenshot may predate the paint):", e.message));
  // Every SVG <image> decoded (bounded, 5 s) in the document that renders it, before any frame is
  // taken: data-URI rasters decode lazily. Logs a timeout; never fails the run.
  const decodeImages = async (mode) => {
    const timedOut = await wd("POST", s("/execute/async"), {
      script: `const m = arguments[0], done = arguments[arguments.length - 1];
        const doc = m === 'object' ? document.getElementById('el').contentDocument : document;
        const win = doc.defaultView;
        const waits = [...doc.querySelectorAll('image')].map((el) => {
          if (typeof el.decode === 'function') return el.decode().catch(() => undefined);
          const h = el.getAttribute('href') || el.getAttribute('xlink:href');
          if (!h || !h.startsWith('data:')) return Promise.resolve();
          const i = new win.Image(); i.src = h; return i.decode().catch(() => undefined);
        });
        Promise.race([Promise.all(waits).then(() => false), new Promise((r) => setTimeout(() => r(true), 5000))]).then(done);`,
      args: [mode],
    }).catch(() => undefined);
    if (timedOut) console.log(`SVG images were not decoded within 5 s (${mode})`);
  };
  // Element screenshot of the page's box (#box on probe pages, #host on diagram pages): it
  // snapshots the web view itself, so it does not depend on the Safari window being painted on
  // screen (the full-window screenshot was blank on small-display runners). SAFARI_SHOT=window
  // switches back to the window screenshot.
  const shot = async () => {
    await settle();
    if (process.env.SAFARI_SHOT === "window") return wd("GET", s("/screenshot"));
    const el = await wd("POST", s("/element"), { using: "css selector", value: "#box, #host" });
    const id = el["element-6066-11e4-a52e-4f735466cecf"] ?? Object.values(el)[0];
    return wd("GET", s(`/element/${id}/screenshot`));
  };

  console.log("session capabilities:", JSON.stringify(session.capabilities));
  // Root cause of the intermittent blank screenshots on the macOS runner: its display can be only
  // 1024x768, and a Safari window larger than the screen is not painted (blank WebDriver
  // screenshots). Size the window to the screen, never beyond.
  await go("/blank");
  const screenSize = await exec("return [screen.availWidth, screen.availHeight]").catch(() => [
    1280, 900,
  ]);
  console.log("screen available size:", JSON.stringify(screenSize));
  const rect = {
    width: Math.min(1280, screenSize[0] - 20),
    height: Math.min(900, screenSize[1] - 60),
    x: 0,
    y: 0,
  };
  await wd("POST", s("/window/rect"), rect).catch((e) =>
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
  // The window can stay unpainted for a while after the session starts: wait (bounded) until a
  // page with a red square renders differently from the empty page.
  await go("/blank");
  const w0 = await shot();
  for (let i = 0; i < 10; i++) {
    await go("/ref/red");
    if ((await shot()) !== w0) {
      console.log(`window painted after ${i} retries`);
      break;
    }
    console.log(`window not painted yet (attempt ${i + 1}); maximizing and waiting`);
    await wd("POST", s("/window/maximize"), {}).catch((e) =>
      console.log("maximize failed:", e.message),
    );
    await sleep(2000);
    await go("/blank");
  }
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
  // Keep the evidence: what WebDriver actually returned.
  mkdirSync(OUT, { recursive: true });
  for (const [n, b64] of [
    ["blank", blank],
    ["green", green],
    ["red", red],
  ]) {
    writeFileSync(`${OUT}/probe-${n}.png`, Buffer.from(b64, "base64"));
  }
  const pairs = [
    ["blank", "green", blank === green],
    ["blank", "red", blank === red],
    ["green", "red", green === red],
  ].filter((p) => p[2]);
  rec(
    "-",
    "-",
    "screenshots of blank, green and red pages all differ",
    pairs.length === 0 ? "pass" : "fail",
    pairs.length === 0
      ? ""
      : `identical: ${pairs.map((p) => `${p[0]}=${p[1]}`).join(", ")} (window not rendering?)`,
  );
  if (pairs.length > 0) {
    // Nothing below can be judged on blank screenshots: stop and let the caller retry once.
    blankRun = true;
    throw new Error("blank WebDriver screenshots (window not painted)");
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

  // The probe must match the macOS setting this pass was started for.
  const expectReduce = process.env.SAFARI_REDUCED === "1";
  const probeOk = expectReduce
    ? host.reduce === true && image.reduce === "matches" && image["no-preference"] === "no match"
    : host.reduce === false && image.reduce === "no match" && image["no-preference"] === "matches";
  rec(
    "-",
    "-",
    `probe matches the expected setting (reduced motion ${expectReduce ? "ON" : "OFF"})`,
    probeOk ? "pass" : "fail",
  );

  // Share of pixels that differ clearly between two PNG screenshots (decoded in Node).
  const diffFraction = async (a, b) => pixelDiff(a, b);

  if (expectReduce) {
    // Second pass (macOS Reduce Motion ON): every embedding must show the static rest frame, and
    // the <img> must equal the inline rest frame (overview).
    for (const file of listSvgs(IN)) {
      let rest;
      for (const mode of ["inline", "img", "object"]) {
        try {
          await go(`/page/${mode}/${encodeURIComponent(file)}`);
          if (mode === "img") {
            await exec("return document.getElementById('el').decode().then(() => true)");
          } else if (mode === "object") {
            for (let i = 0; i < 40; i++) {
              if (
                await exec(
                  "const d = document.getElementById('el').contentDocument; return !!(d && d.documentElement)",
                )
              )
                break;
              await sleep(150);
            }
          }
          await decodeImages(mode);
          await sleep(400);
          const frames = [];
          for (let i = 0; i < 3; i++) {
            frames.push(await shot());
            await sleep(600);
          }
          // Assembly diagrams (assemblies.md 12) show each step's end pose for the whole step: the
          // frames may change at a step boundary but never continuously (a tween changes them all).
          const discrete = discreteOf(file);
          const still = discrete
            ? frames[0] === frames[1] || frames[1] === frames[2]
            : frames.every((f) => f === frames[0]);
          let moved = "";
          if (!still) {
            // Evidence of what moves: the first and last frame, and how much differs.
            const last = frames[frames.length - 1];
            const d = await diffFraction(frames[0], last);
            moved =
              typeof d === "number"
                ? `${(d * 100).toFixed(3)}% of pixels differ between the first and last frame`
                : String(d);
            for (const [n, f] of [
              ["a", frames[0]],
              ["b", last],
            ]) {
              writeFileSync(`${OUT}/moving-${file}-${mode}-${n}.png`, Buffer.from(f, "base64"));
            }
            await go(`/page/${mode}/${encodeURIComponent(file)}`); // restore the page for later steps
          }
          rec(
            file,
            mode,
            discrete ? "reduced motion: discrete poses (no tween)" : "reduced motion: static",
            still ? "pass" : "fail",
            moved,
          );
          // Real content, not just a different element size: >1% of pixels differ from the
          // background colour (a diagram hidden by its reduced-motion CSS has none).
          const inkShare = inkOf(frames[0]);
          rec(
            file,
            mode,
            "has content (ink > 1% of pixels)",
            typeof inkShare === "number" && inkShare > 0.01 ? "pass" : "fail",
            typeof inkShare === "number" ? `${(inkShare * 100).toFixed(1)}% ink` : String(inkShare),
          );
          if (discrete) continue; // no single rest frame to compare: poses follow the steps
          if (mode === "inline") {
            rest = frames[0];
            // The rest frame must match the motion pass's t=0 frame of the same diagram.
            const t0Dir = process.env.SAFARI_T0_DIR;
            const t0Path = t0Dir ? `${t0Dir}/t0-${file}.png` : undefined;
            if (t0Path && existsSync(t0Path)) {
              const d = await diffFraction(readFileSync(t0Path).toString("base64"), frames[0]);
              rec(
                file,
                mode,
                "rest frame matches the motion pass t=0 frame (<4% of pixels differ)",
                typeof d === "number" && d < 0.04 ? "pass" : "fail",
                typeof d === "number" ? `${(d * 100).toFixed(2)}% differ` : String(d),
              );
            } else {
              rec(
                file,
                mode,
                "rest frame matches the motion pass t=0 frame",
                "fail",
                "no t=0 frame from the motion pass",
              );
            }
          } else if (rest) {
            const d = await diffFraction(rest, frames[0]);
            rec(
              file,
              mode,
              "matches the inline rest frame (<4% of pixels differ)",
              typeof d === "number" && d < 0.04 ? "pass" : "fail",
              typeof d === "number" ? `${(d * 100).toFixed(2)}% differ` : String(d),
            );
          }
        } catch (e) {
          rec(file, mode, "ran without error", "fail", String(e?.message ?? e));
        }
      }
    }
  }

  for (const file of expectReduce ? [] : listSvgs(IN)) {
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
        await decodeImages(mode);
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
          if (mode === "inline") {
            // The t=0 frame: the reduced-motion pass compares its rest frame with this one.
            writeFileSync(`${OUT}/t0-${file}.png`, Buffer.from(await at(0), "base64"));
          }
          const [ta, tb] = INFO?.assemblies?.[file]?.animate ?? [0.5, 1.7];
          const a = await at(ta);
          const b = await at(tb);
          const c = await at(ta);
          first = a;
          animated = a !== b;
          // Safari may move a particle by a sub-pixel between seeks: identical bytes are not
          // required, only a record of whether they happen to be.
          rec(file, mode, "time control repeats (0.5 s twice)", "info", `identical: ${a === c}`);
          // A1-2b depth copies: one copy visible on both sides of each swap, frames that agree.
          const swaps = INFO?.copies?.[file]?.swaps ?? [];
          if (swaps.length > 0) {
            const bad = [];
            let worst = 0;
            for (const { t, ids } of swaps) {
              const frames = [];
              for (const x of [t - 1 / 60, t, t + 1 / 60]) {
                frames.push(await at(x));
                const shown = await exec(
                  `const m = arguments[0], list = arguments[1];
                   const doc = m === 'object' ? document.getElementById('el').contentDocument : document;
                   return list.filter((id) => doc.defaultView.getComputedStyle(doc.getElementById(id)).visibility === 'visible').length;`,
                  [mode, ids],
                );
                if (shown !== 1) bad.push(`t=${x.toFixed(4)}: ${shown} copies visible`);
              }
              for (const [p, q] of [
                [0, 1],
                [1, 2],
              ]) {
                const d = frames[p] === frames[q] ? 0 : pixelDiff(frames[p], frames[q]);
                if (typeof d !== "number") bad.push(`t=${t}: ${d}`);
                else {
                  worst = Math.max(worst, d);
                  if (d >= 0.005) bad.push(`t=${t}: ${(d * 100).toFixed(3)}% of pixels change`);
                }
              }
            }
            rec(
              file,
              mode,
              `depth copies: one copy visible and no flicker at ${swaps.length} swap(s)`,
              bad.length === 0 ? "pass" : "fail",
              bad.length
                ? bad.join("; ")
                : `largest change: ${(worst * 100).toFixed(3)}% of pixels`,
            );
          }
        }
        rec(file, mode, "animates", animated ? "pass" : "fail", animated ? "" : "static in Safari");
        const inkShare = inkOf(first);
        rec(
          file,
          mode,
          "has content (ink > 1% of pixels)",
          typeof inkShare === "number" && inkShare > 0.01 ? "pass" : "fail",
          typeof inkShare === "number" ? `${(inkShare * 100).toFixed(1)}% ink` : String(inkShare),
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
  exitCode = writeResults() === 0 ? 0 : blankRun ? 3 : 1;
}
process.exit(exitCode);
