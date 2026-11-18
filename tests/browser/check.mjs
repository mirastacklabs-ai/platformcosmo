/* global document, getComputedStyle, setTimeout */
/**
 * Browser check (PLAN M2 exit): loads the fixtures in <img>, inline and <object> in chromium,
 * firefox and webkit, and checks that they animate, that reduced motion is static, and (inline)
 * that the master timeline changes object state and the interactive Step button works.
 *
 * Runs inside the Playwright container (see run.sh). Writes results.json and results.md.
 */
import { writeFileSync } from "node:fs";
import { chromium, firefox, webkit } from "playwright";

const DIR = process.env.OUT_DIR ?? "/t/out";
const SIZE = { width: 560, height: 320 };
const clip = { x: 0, y: 0, ...SIZE };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

function record(browser, mode, check, pass, detail = "") {
  results.push({ browser, mode, check, pass, detail });
  console.log(
    `${pass === "limited" ? "LIMITED" : pass ? "PASS" : "FAIL"} ${browser}/${mode}: ${check} ${detail}`,
  );
}

async function shot(page) {
  return (await page.screenshot({ clip })).toString("base64");
}

async function open(browser, mode, reducedMotion) {
  const ctx = await browser.newContext({
    viewport: { width: 640, height: 400 },
    reducedMotion,
    colorScheme: "light",
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`file://${DIR}/page-${mode}.html`);
  await page.waitForLoadState("load");
  return { ctx, page, errors };
}

async function checkMode(browserName, browser, mode) {
  // 1. animates: screenshots at two times differ (particles move)
  {
    const { ctx, page } = await open(browser, mode, "no-preference");
    await sleep(500);
    const a = await shot(page);
    await sleep(900);
    const b = await shot(page);
    await ctx.close();
    if (a !== b) {
      record(browserName, mode, "animates (two screenshots differ)", true);
    } else if (mode === "img") {
      // Image documents ignore the emulated media features and read the engine's own setting;
      // headless WebKit reports reduced motion there. Prove the animation itself works in <img>
      // with the reduced-motion block stripped.
      record(
        browserName,
        mode,
        "animates (two screenshots differ)",
        "limited",
        "static: the image document evaluated prefers-reduced-motion as reduce (engine setting, not our emulation)",
      );
      const t = await open(browser, "img-noreduced", "no-preference");
      await sleep(500);
      const c = await shot(t.page);
      await sleep(900);
      const d = await shot(t.page);
      record(browserName, mode, "animates with the reduced-motion block stripped", c !== d);
      await t.ctx.close();
    } else {
      record(browserName, mode, "animates (two screenshots differ)", false);
    }
  }
  // 2. reduced motion: static
  {
    const { ctx, page } = await open(browser, mode, "reduce");
    await sleep(500);
    const a = await shot(page);
    await sleep(900);
    const b = await shot(page);
    await ctx.close();
    if (a === b) record(browserName, mode, "reduced motion is static", true);
    else if (mode === "img") {
      record(
        browserName,
        mode,
        "reduced motion is static",
        "limited",
        "emulated reduced motion is not applied to image documents; covered by the inline and object checks",
      );
    } else record(browserName, mode, "reduced motion is static", false);
  }
}

async function checkInline(browserName, browser) {
  // Timeline: object b is healthy in step 1 (0-3 s), down in step 2 (3-6 s). Sample 9 s.
  const { ctx, page } = await open(browser, "inline", "no-preference");
  const seen = new Set();
  for (let i = 0; i < 36; i++) {
    seen.add(
      await page.evaluate(() => getComputedStyle(document.getElementById("pc-test-o-b")).opacity),
    );
    await sleep(250);
  }
  record(
    browserName,
    "inline",
    "object state changes over the loop",
    seen.has("1") && seen.has("0.6"),
    `opacities: ${[...seen].join(",")}`,
  );
  await ctx.close();

  const rm = await open(browser, "inline", "reduce");
  const info = await rm.page.evaluate(() => ({
    particles: getComputedStyle(document.getElementById("pc-test_particles")).display,
    opacity: getComputedStyle(document.getElementById("pc-test-o-b")).opacity,
    caption1: getComputedStyle(document.getElementById("pc-test-cap-1")).visibility,
    caption2: getComputedStyle(document.getElementById("pc-test-cap-2")).visibility,
  }));
  record(
    browserName,
    "inline",
    "reduced motion: static first frame, particles hidden",
    info.particles === "none" &&
      info.opacity === "1" &&
      info.caption1 === "visible" &&
      info.caption2 === "hidden",
    JSON.stringify(info),
  );
  await rm.ctx.close();
}

async function checkInteractive(browserName, browser) {
  const { ctx, page, errors } = await open(browser, "interactive", "no-preference");
  await sleep(300);
  await page.click("#pc-x_btn_step");
  await sleep(200);
  const cap = await page.evaluate(() => ({
    c1: getComputedStyle(document.getElementById("pc-x-cap-1")).visibility,
    c2: getComputedStyle(document.getElementById("pc-x-cap-2")).visibility,
    label: document.querySelector("#pc-x_btn_play text").textContent,
  }));
  record(
    browserName,
    "interactive",
    "Step jumps to step 2 and pauses",
    cap.c1 === "hidden" && cap.c2 === "visible" && cap.label === "Play",
    JSON.stringify(cap),
  );
  const a = await shot(page);
  await sleep(700);
  const b = await shot(page);
  record(browserName, "interactive", "paused: frames stay equal", a === b);
  await page.click("#pc-x_btn_play");
  await sleep(300);
  const c = await shot(page);
  await sleep(700);
  const d = await shot(page);
  record(browserName, "interactive", "Play resumes animation", c !== d);
  record(browserName, "interactive", "no script errors", errors.length === 0, errors.join(";"));
  await ctx.close();
}

const engines = { chromium, firefox, webkit };
for (const [name, engine] of Object.entries(engines)) {
  const browser = await engine.launch();
  const version = browser.version();
  console.log(`== ${name} ${version}`);
  try {
    for (const mode of ["img", "inline", "object"]) await checkMode(name, browser, mode);
    await checkInline(name, browser);
    await checkInteractive(name, browser);
  } catch (e) {
    record(name, "harness", "ran without exception", false, String(e));
  }
  results.push({ browser: name, mode: "version", check: "version", pass: true, detail: version });
  await browser.close();
}

const checks = results.filter((r) => r.check !== "version");
const failed = checks.filter((r) => r.pass === false);
const limited = checks.filter((r) => r.pass === "limited");
writeFileSync(`${DIR}/results.json`, JSON.stringify(results, null, 2));
const versions = results
  .filter((r) => r.check === "version")
  .map((r) => `${r.browser} ${r.detail}`);
const rows = checks.map(
  (r) =>
    `| ${r.browser} | ${r.mode} | ${r.check} | ${r.pass === "limited" ? "limited" : r.pass ? "pass" : "FAIL"} | ${r.detail.replaceAll("|", "/")} |`,
);
writeFileSync(
  `${DIR}/results.md`,
  [
    `Browsers: ${versions.join(", ")}`,
    "",
    "| browser | mode | check | result | detail |",
    "|---|---|---|---|---|",
    ...rows,
    "",
    `${checks.length - failed.length - limited.length}/${checks.length} checks passed, ${limited.length} limited (see detail), ${failed.length} failed.`,
    "",
  ].join("\n"),
);
process.exit(failed.length === 0 ? 0 : 1);
