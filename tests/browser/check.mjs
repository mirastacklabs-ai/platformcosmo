/* global document, matchMedia, getComputedStyle, Image, setTimeout, fetch, URL, Buffer */
/**
 * Browser check (PLAN M2 exit): loads each SVG of the input directory in <img>, inline and
 * <object> in chromium, firefox and webkit (over http://127.0.0.1) and checks that it animates,
 * that reduced motion is static, that dark mode applies, and that nothing leaves localhost.
 * Fixture-specific checks (object state over time, expected first frame, interactive controls)
 * run when the input directory has a fixture.json.
 *
 * Runs inside the Playwright container (see run.sh). Env: INPUT_DIR (default /in), OUT_DIR
 * (default /out), PW_VERSION, PW_IMAGE, GIT_SHA. Writes results.json and RESULTS.md.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { chromium, firefox, webkit } from "playwright";
import { MODES, listSvgs, readFixtureInfo, startServer } from "./server.mjs";

const IN = process.env.INPUT_DIR ?? "/in";
const OUT = process.env.OUT_DIR ?? "/out";
const PW_IMAGE = process.env.PW_IMAGE ?? "(unknown)";

/**
 * Explicit allowlist: engines whose <img> is allowed to show the static frame, with the reason.
 * It only applies when the probe proves the cause (image documents match reduced motion although
 * the page emulates no-preference). Everything else that is static in <img> is a hard FAIL.
 */
const ALLOW_IMG_STATIC = {
  webkit:
    "headless WebKit (Playwright, Linux) reports prefers-reduced-motion: reduce as its system setting and SVG image documents read that setting instead of the emulated value",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function rec(browser, file, mode, check, status, detail = "") {
  results.push({ browser, file, mode, check, status, detail });
  console.log(`${status.toUpperCase().padEnd(11)} ${browser}/${file}/${mode}: ${check} ${detail}`);
}

// Playwright version must equal the image version and the pinned version.
const pwVersion = JSON.parse(
  readFileSync(new URL("./node_modules/playwright/package.json", import.meta.url), "utf8"),
).version;
const imageVersion = /:v(\d+\.\d+\.\d+)/.exec(PW_IMAGE)?.[1];
if (process.env.PW_VERSION && process.env.PW_VERSION !== pwVersion) {
  console.error(`playwright npm ${pwVersion} != PW_VERSION ${process.env.PW_VERSION}`);
  process.exit(2);
}
if (imageVersion && imageVersion !== pwVersion) {
  console.error(`playwright npm ${pwVersion} != image ${imageVersion}: browsers would not match`);
  process.exit(2);
}
console.log("allowlist (static <img> allowed):", JSON.stringify(ALLOW_IMG_STATIC));

const info = readFixtureInfo(IN);
const files = listSvgs(IN);
const server = await startServer(IN);
const origin = server.origin;

// -- helpers ---------------------------------------------------------------------------------

async function withPage(browser, blocked, opts, fn) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...opts });
  try {
    await ctx.route("**/*", (route) => {
      const u = route.request().url();
      if (u.startsWith(origin) || u.startsWith("data:") || u.startsWith("blob:")) {
        return route.continue();
      }
      blocked.push(u);
      return route.abort();
    });
    const page = await ctx.newPage();
    return await fn(page);
  } finally {
    await ctx.close();
  }
}

async function open(page, mode, file, strip = false) {
  await page.goto(`${origin}/page/${mode}/${encodeURIComponent(file)}${strip ? "?strip=1" : ""}`);
  await page.waitForLoadState("load");
  if (mode === "img") await page.evaluate(() => document.getElementById("el").decode());
  if (mode === "object") {
    await page.waitForFunction(
      () => document.getElementById("el").contentDocument?.documentElement,
    );
  }
  await page.evaluate(() => document.fonts.ready);
  return page.locator("#host").boundingBox();
}

const shot = async (page, box) =>
  (
    await page.screenshot({
      clip: { x: box.x, y: box.y, width: box.width, height: box.height },
    })
  ).toString("base64");

/** Deterministic time for inline and <object>: pause SMIL and CSS animations at `t` seconds. */
async function seek(page, mode, t) {
  await page.evaluate(
    ([m, time]) => {
      const root =
        m === "object"
          ? document.getElementById("el").contentDocument.documentElement
          : document.querySelector("#host svg");
      root.pauseAnimations();
      root.setCurrentTime(time);
      for (const a of root.ownerDocument.getAnimations()) {
        a.pause();
        a.currentTime = time * 1000;
      }
    },
    [mode, t],
  );
  await sleep(250);
}

/** Pixel analysis in a scratch page of the same browser (decodes PNG via canvas). */
async function pixels(scratch, a, b) {
  return scratch.evaluate(
    async ([x, y]) => {
      const load = async (b64) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const g = c.getContext("2d");
        g.drawImage(img, 0, 0);
        return g.getImageData(0, 0, c.width, c.height);
      };
      const A = await load(x);
      const corner = [A.data[0], A.data[1], A.data[2]];
      let ink = 0;
      for (let i = 0; i < A.data.length; i += 4) {
        const d = Math.max(
          Math.abs(A.data[i] - corner[0]),
          Math.abs(A.data[i + 1] - corner[1]),
          Math.abs(A.data[i + 2] - corner[2]),
        );
        if (d > 24) ink++;
      }
      const out = { w: A.width, h: A.height, corner, ink: ink / (A.width * A.height) };
      if (y) {
        const B = await load(y);
        out.sameSize = A.width === B.width && A.height === B.height;
        let diff = 0;
        if (out.sameSize) {
          for (let i = 0; i < A.data.length; i += 4) {
            const d = Math.max(
              Math.abs(A.data[i] - B.data[i]),
              Math.abs(A.data[i + 1] - B.data[i + 1]),
              Math.abs(A.data[i + 2] - B.data[i + 2]),
            );
            if (d > 64) diff++;
          }
        }
        out.diff = diff / (A.width * A.height);
      }
      return out;
    },
    [a, b ?? null],
  );
}

async function expectedPng() {
  if (!info?.expected) return undefined;
  const r = await fetch(`${origin}/expected/${info.expected}`);
  return Buffer.from(await r.arrayBuffer()).toString("base64");
}

async function scratchOf(page) {
  const scratch = await page.context().newPage();
  await scratch.goto(`${origin}/blank`);
  return scratch;
}

// -- per-browser checks ----------------------------------------------------------------------

async function probeMedia(name, browser, blocked) {
  const out = { host: {}, image: {} };
  await withPage(browser, blocked, { reducedMotion: "no-preference" }, async (page) => {
    const clip = { x: 0, y: 0, width: 40, height: 40 };
    await page.goto(`${origin}/ref/green`);
    const green = (await page.screenshot({ clip })).toString("base64");
    await page.goto(`${origin}/ref/red`);
    const red = (await page.screenshot({ clip })).toString("base64");
    out.host = await page.evaluate(() => ({
      reduce: matchMedia("(prefers-reduced-motion: reduce)").matches,
      dark: matchMedia("(prefers-color-scheme: dark)").matches,
    }));
    for (const key of ["reduce", "no-preference", "dark"]) {
      await page.goto(`${origin}/probe-page/${key}`);
      await page.evaluate(() => document.images[0].decode());
      const s = (await page.screenshot({ clip })).toString("base64");
      out.image[key] = s === red ? "matches" : s === green ? "no match" : "unknown";
    }
  });
  // Host value with no emulation at all = the engine's own system setting.
  await withPage(browser, blocked, { reducedMotion: null }, async (page) => {
    await page.goto(`${origin}/blank`);
    out.system = await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  });
  rec(
    name,
    "-",
    "-",
    "probe",
    "info",
    `host matchMedia(reduce) with no override: ${out.system}; page emulating no-preference: ${out.host.reduce}; <img> document matches reduce: ${out.image.reduce}, no-preference: ${out.image["no-preference"]}, dark (page emulating light): ${out.image.dark}`,
  );
  return out;
}

async function sampleImg(browser, blocked, file, strip) {
  let animated = false;
  await withPage(browser, blocked, { reducedMotion: "no-preference" }, async (page) => {
    const box = await open(page, "img", file, strip);
    const seen = new Set();
    for (let i = 0; i < 10 && !animated; i++) {
      seen.add(await shot(page, box));
      animated = seen.size > 1;
      if (!animated) await sleep(450);
    }
  });
  return animated;
}

async function checkAnimates(name, browser, blocked, file, mode, probe) {
  if (mode === "img") {
    // No clock access to image documents: sample with a retry budget.
    if (await sampleImg(browser, blocked, file, false)) {
      return rec(name, file, mode, "animates", "pass");
    }
    const reason = ALLOW_IMG_STATIC[name];
    if (reason && probe.image["no-preference"] === "no match" && probe.image.reduce === "matches") {
      rec(name, file, mode, "animates", "allowlisted", reason);
      // Prove the animation itself works in <img> with the reduced-motion block removed.
      const works = await sampleImg(browser, blocked, file, true);
      return rec(
        name,
        file,
        mode,
        "animates with the reduced-motion block stripped",
        works ? "pass" : "fail",
      );
    }
    return rec(name, file, mode, "animates", "fail", "static in <img> and not allowlisted");
  }
  return withPage(browser, blocked, { reducedMotion: "no-preference" }, async (page) => {
    const box = await open(page, mode, file);
    // Assembly diagrams (B-2) carry two times known to differ (rest vs mid-move) in fixture.json.
    const [ta, tb] = info?.assemblies?.[file]?.animate ?? [0.5, 1.7];
    await seek(page, mode, ta);
    const a = await shot(page, box);
    await seek(page, mode, tb);
    const b = await shot(page, box);
    await seek(page, mode, ta);
    const c = await shot(page, box);
    const scratch = await scratchOf(page);
    rec(
      name,
      file,
      mode,
      `animates (frames at ${ta} s and ${tb} s differ)`,
      a !== b ? "pass" : "fail",
    );
    // Same time, same frame (Chromium SMIL can move a particle by a sub-pixel between seeks).
    const same = await pixels(scratch, a, c);
    rec(
      name,
      file,
      mode,
      "time control is deterministic (same time twice: <0.1% of pixels differ, assembly diagrams <0.5%)",
      same.diff < (info?.assemblies?.[file] ? 0.005 : 0.001) ? "pass" : "fail",
      `${(same.diff * 100).toFixed(3)}% differ`,
    );
    const px = await pixels(scratch, a);
    rec(
      name,
      file,
      mode,
      "not blank",
      px.ink > 0.01 ? "pass" : "fail",
      `ink ${(px.ink * 100).toFixed(1)}%`,
    );
  });
}

async function checkReduced(name, browser, blocked, file, mode, expected) {
  if (mode === "img") {
    return rec(
      name,
      file,
      mode,
      "reduced motion is static",
      "limited",
      "image documents ignore emulated reduced motion (see probe); covered by inline and object",
    );
  }
  const steps = info?.assemblies?.[file];
  if (steps) return checkReducedDiscrete(name, browser, blocked, file, mode, steps.mids);
  return withPage(browser, blocked, { reducedMotion: "reduce" }, async (page) => {
    const box = await open(page, mode, file);
    await sleep(500);
    // The first paint after load can still settle (fonts, layout); a continuous animation never
    // does: the last two of three frames must be identical.
    await shot(page, box);
    await sleep(700);
    const a = await shot(page, box);
    await sleep(700);
    const b = await shot(page, box);
    rec(name, file, mode, "reduced motion is static", a === b ? "pass" : "fail");
    if (expected && file === info?.loop) {
      const px = await pixels(await scratchOf(page), a, expected);
      rec(
        name,
        file,
        mode,
        "static frame matches the expected first frame",
        px.sameSize && px.diff < 0.04 ? "pass" : "fail",
        `size match ${px.sameSize}, ${(px.diff * 100).toFixed(2)}% of pixels differ (limit 4%)`,
      );
    }
  });
}

/**
 * Assembly diagrams under reduced motion (assemblies.md 12): each step shows its end pose for the
 * whole step, so two frames inside one step are equal (no tween), the poses of different steps
 * differ somewhere (the discrete poses are really shown), and there is content.
 */
async function checkReducedDiscrete(name, browser, blocked, file, mode, mids) {
  return withPage(browser, blocked, { reducedMotion: "reduce" }, async (page) => {
    const box = await open(page, mode, file);
    const scratch = await scratchOf(page);
    const poses = [];
    const tweened = [];
    let worst = 0;
    for (const [k, mid] of mids.entries()) {
      await seek(page, mode, mid);
      const a = await shot(page, box);
      await seek(page, mode, mid + 0.15);
      const b = await shot(page, box);
      poses.push(a);
      // Equal frames; WebKit may repaint an image or antialiased edge by a few pixels, so up to
      // 0.1% of the pixels may differ (a tween over 0.15 s moves far more than that).
      const d = a === b ? 0 : (await pixels(scratch, a, b)).diff;
      worst = Math.max(worst, d);
      if (d >= 0.001) tweened.push(k + 1);
    }
    rec(
      name,
      file,
      mode,
      "reduced motion: discrete poses (frames inside a step are equal)",
      tweened.length === 0 ? "pass" : "fail",
      tweened.length
        ? `steps that change inside: ${tweened.join(",")}`
        : `largest difference inside a step: ${(worst * 100).toFixed(3)}% of pixels`,
    );
    const distinct = new Set(poses).size;
    rec(
      name,
      file,
      mode,
      "reduced motion: step poses differ (not a single frozen frame)",
      distinct > 1 ? "pass" : "fail",
      `${distinct} distinct poses over ${poses.length} steps`,
    );
    const px = await pixels(scratch, poses[0]);
    rec(name, file, mode, "reduced motion: has content", px.ink > 0.01 ? "pass" : "fail");
  });
}

const themeCache = new Map();

/** Light-theme `--pc-background` of a diagram as [r, g, b], or undefined when it has none. */
async function themeBackground(browser, blocked, file) {
  if (!themeCache.has(file)) {
    const value = await withPage(
      browser,
      blocked,
      { colorScheme: "light", reducedMotion: "reduce" },
      async (page) => {
        await open(page, "inline", file);
        return page.evaluate(() =>
          getComputedStyle(document.querySelector("#host svg"))
            .getPropertyValue("--pc-background")
            .trim(),
        );
      },
    );
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
    let rgb;
    if (m) {
      const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
      rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    }
    themeCache.set(file, rgb);
  }
  return themeCache.get(file);
}

async function checkDark(name, browser, blocked, file, mode) {
  const corner = (scheme) =>
    withPage(browser, blocked, { colorScheme: scheme, reducedMotion: "reduce" }, async (page) => {
      const box = await open(page, mode, file);
      await sleep(200);
      const img = await shot(page, box);
      const px = await pixels(await scratchOf(page), img);
      let fill;
      if (mode === "inline" && info?.bg && file === info.loop) {
        fill = await page.evaluate(
          (sel) => getComputedStyle(document.querySelector(sel)).fill,
          info.bg,
        );
      }
      return { corner: px.corner.join(","), fill, img };
    });
  const light = await corner("light");
  const dark = await corner("dark");
  // Whole frames, not a corner: a dark theme recolours most of the diagram, so a large share of
  // pixels must change.
  const frames = await withPage(browser, blocked, {}, async (page) =>
    pixels(await scratchOf(page), light.img, dark.img),
  );
  // A diagram whose own theme is already dark (spec theme "dark"/"blueprint") has no light/dark
  // pair to compare: prefers-color-scheme changes nothing. The theme is read from the diagram's
  // data (its light-theme --pc-background variable), not guessed from rendered pixels.
  const bg = await themeBackground(browser, blocked, file);
  const ownDark = bg !== undefined && 0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2] < 90;
  const changed = frames.sameSize && frames.diff > 0.2;
  rec(
    name,
    file,
    mode,
    "dark mode changes the rendering (whole-frame diff > 20% of pixels)",
    changed ? "pass" : ownDark && frames.diff < 0.01 ? "limited" : "fail",
    `${(frames.diff * 100).toFixed(1)}% of pixels differ; corner pixel light ${light.corner}, dark ${dark.corner}${ownDark ? " (the diagram's own theme is dark)" : ""}`,
  );
  if (info?.bg && mode === "inline" && file === info.loop) {
    rec(
      name,
      file,
      mode,
      "dark token applied (computed fill of the background element)",
      dark.fill === info.dark && light.fill === info.light ? "pass" : "fail",
      `light ${light.fill}, dark ${dark.fill}`,
    );
  }
}

async function checkFixtureInline(name, browser, blocked) {
  await withPage(browser, blocked, { reducedMotion: "no-preference" }, async (page) => {
    await open(page, "inline", info.loop);
    const at = async (t) => {
      await seek(page, "inline", t);
      return page.evaluate(
        (sel) => getComputedStyle(document.querySelector(sel)).opacity,
        info.objectB,
      );
    };
    const s1 = await at(1);
    const s2 = await at(4);
    rec(
      name,
      info.loop,
      "inline",
      "object state changes over the timeline (t=1 s vs t=4 s)",
      s1 === "1" && s2 === "0.6" ? "pass" : "fail",
      `opacity ${s1} then ${s2}`,
    );
  });
  await withPage(browser, blocked, { reducedMotion: "reduce" }, async (page) => {
    await open(page, "inline", info.loop);
    const r = await page.evaluate(
      (i) => ({
        particles: getComputedStyle(document.querySelector(i.particles)).display,
        opacity: getComputedStyle(document.querySelector(i.objectB)).opacity,
        caption1: getComputedStyle(document.querySelector(i.caption1)).visibility,
      }),
      info,
    );
    rec(
      name,
      info.loop,
      "inline",
      "reduced motion: static first frame, particles hidden",
      r.particles === "none" && r.opacity === "1" && r.caption1 === "visible" ? "pass" : "fail",
      JSON.stringify(r),
    );
  });
}

async function checkInteractive(name, browser, blocked) {
  const file = info.interactive;
  await withPage(browser, blocked, { reducedMotion: "no-preference" }, async (page) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    const box = await open(page, "inline", file);
    await sleep(300);
    await page.click(info.stepButton);
    await sleep(200);
    const r = await page.evaluate(
      (i) => ({
        c1: getComputedStyle(document.querySelector(i.icaption1)).visibility,
        c2: getComputedStyle(document.querySelector(i.icaption2)).visibility,
        label: document.querySelector(`${i.playButton} text`).textContent,
      }),
      info,
    );
    rec(
      name,
      file,
      "inline",
      "Step jumps to step 2 and pauses",
      r.c1 === "hidden" && r.c2 === "visible" && r.label === "Play" ? "pass" : "fail",
      JSON.stringify(r),
    );
    const a = await shot(page, box);
    await sleep(700);
    rec(
      name,
      file,
      "inline",
      "paused: frames stay equal",
      a === (await shot(page, box)) ? "pass" : "fail",
    );
    await page.click(info.playButton);
    await sleep(300);
    const c = await shot(page, box);
    await sleep(700);
    rec(
      name,
      file,
      "inline",
      "Play resumes animation",
      c !== (await shot(page, box)) ? "pass" : "fail",
    );
    rec(
      name,
      file,
      "inline",
      "no script errors",
      errors.length === 0 ? "pass" : "fail",
      errors.join(";"),
    );
  });
}

// -- main ------------------------------------------------------------------------------------

const versions = {};
const probes = {};
const expected = await expectedPng();
for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
  const browser = await engine.launch();
  versions[name] = browser.version();
  const blocked = [];
  console.log(`== ${name} ${versions[name]}`);
  try {
    probes[name] = await probeMedia(name, browser, blocked);
    for (const file of files) {
      if (file === info?.interactive) continue; // controls checked below
      for (const mode of MODES) {
        await checkAnimates(name, browser, blocked, file, mode, probes[name]);
        await checkReduced(name, browser, blocked, file, mode, expected);
        await checkDark(name, browser, blocked, file, mode);
      }
    }
    if (info) {
      await checkFixtureInline(name, browser, blocked);
      await checkInteractive(name, browser, blocked);
    }
  } catch (e) {
    rec(name, "-", "-", "ran without exception", "fail", String(e?.stack ?? e));
  } finally {
    rec(
      name,
      "-",
      "-",
      "no request left localhost",
      blocked.length === 0 ? "pass" : "fail",
      blocked.join(" "),
    );
    await browser.close();
  }
}
await server.close();

// -- report ----------------------------------------------------------------------------------

const count = (s) => results.filter((r) => r.status === s).length;
const checks = results.filter((r) => r.status !== "info");
const summary = `${count("pass")} pass, ${count("allowlisted")} allowlisted, ${count("limited")} limited, ${count("fail")} FAIL (of ${checks.length} checks)`;
const date = new Date().toISOString();
writeFileSync(
  `${OUT}/results.json`,
  JSON.stringify(
    {
      commit: process.env.GIT_SHA ?? "(unknown)",
      image: PW_IMAGE,
      playwright: pwVersion,
      date,
      versions,
      probes,
      allowlist: ALLOW_IMG_STATIC,
      summary,
      results,
    },
    null,
    2,
  ),
);
const row = (r) =>
  `| ${r.browser} | ${r.file} | ${r.mode} | ${r.check} | ${r.status} | ${r.detail.replaceAll("|", "/").slice(0, 400)} |`;
writeFileSync(
  `${OUT}/RESULTS.md`,
  [
    "# Browser check results",
    "",
    `- commit: ${process.env.GIT_SHA ?? "(unknown)"}`,
    `- image: ${PW_IMAGE}`,
    `- playwright: ${pwVersion}; browsers: ${Object.entries(versions)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ")}`,
    `- run: ${date}`,
    `- input: ${files.join(", ")}${info ? " (fixtures)" : ""}`,
    `- **${summary}**`,
    "",
    "Allowlist for a static <img> (printed, with reason):",
    ...Object.entries(ALLOW_IMG_STATIC).map(([k, v]) => `- ${k}: ${v}`),
    "",
    "Media probe (what an SVG image document sees):",
    ...Object.keys(probes).map(
      (k) => `- ${k}: ${results.find((r) => r.browser === k && r.check === "probe")?.detail}`,
    ),
    "",
    "| browser | file | mode | check | result | detail |",
    "|---|---|---|---|---|---|",
    ...results.filter((r) => r.status !== "info").map(row),
    "",
  ]
    .join("\n")
    .replaceAll("<img>", "`<img>`")
    .replaceAll("<object>", "`<object>`")
    .replaceAll("<svg>", "`<svg>`"),
);
console.log(summary);
process.exit(count("fail") === 0 ? 0 : 1);
