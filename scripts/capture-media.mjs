// Takes the screenshots and records the demo that the README shows, from the real 3D view of
// this repository: `npm run media` after `npm run build` and `npx playwright install chromium`.
// With `ffmpeg` on the PATH the screenshots are saved as WebP and the demo as a GIF and an MP4;
// without it they stay PNG and WebM, which the README does not link to.
//
//   node scripts/capture-media.mjs [--out docs/media] [--only shots|video] [--software]
//
// `--software` draws WebGL without a graphics card (slower, and the demo will stutter).
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Project } from "@vertskim/core";
import { startUiServer } from "@vertskim/server";
import { chromium } from "playwright";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({
  options: { out: { type: "string" }, only: { type: "string" }, software: { type: "boolean" } },
});
const OUT = resolve(ROOT, values.out ?? "docs/media");

/** Nodes of this repository the pictures are taken on. */
const STORE = "packages/core/src/store/store.ts#GraphStore";
const SPEC = "packages/core/src/extract/spec.ts#LanguageSpec";
const PROJECT = "packages/core/src/project.ts#Project";
const ASKED = [
  PROJECT,
  "packages/core/src/indexer.ts",
  "packages/core/src/resolve/resolver.ts",
  "packages/core/src/query/search.ts",
];

// Everything is made in a temporary folder and copied over at the end, so that the watched
// project does not change under the pictures.
const work = mkdtempSync(join(tmpdir(), "vertskim-media-"));
const dataDir = join(work, "data");
const made = join(work, "made");
mkdirSync(made);

const project = Project.open({ root: ROOT, dataDir });
await project.sync();
await project.watch();
project.addNote(STORE, "Every write goes through one prepared statement per shape; add new ones with stmt().", "demo");
const server = await startUiServer(project, { port: 0 });
const browser = await chromium.launch({
  args: values.software
    ? ["--enable-unsafe-swiftshader"]
    : ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"],
});

const ffmpeg = (args) => spawnSync("ffmpeg", ["-y", "-loglevel", "error", ...args], { stdio: "inherit" });
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
if (!hasFfmpeg) console.warn("ffmpeg was not found: keeping PNG screenshots and a WebM recording");

const pause = (page, ms) => page.waitForTimeout(ms);
const inspector = (page) => page.getByRole("complementary", { name: "Selected node" });

/** A page on the view, once the graph is drawn and has stopped moving. */
async function open(options) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  page.on("pageerror", (error) => console.error(`page error: ${error.message}`));
  await page.goto(server.link());
  await page.locator('.statusbar [data-item="counts"]').filter({ hasText: /nodes/ }).waitFor();
  await page.locator("canvas").first().waitFor();
  await pause(page, 7000);
  return page;
}

/** Step back from the selected node, so that its surroundings are in the picture. */
async function zoomOut(page, amount) {
  const canvas = await page.locator("canvas").first().boundingBox();
  await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
  for (let done = 0; done < amount; done += 100) {
    await page.mouse.wheel(0, 100);
    await pause(page, 40);
  }
  await pause(page, 1200);
}

async function search(page, text, delay = 0) {
  const box = page.locator("#search");
  await box.click();
  if (delay) await box.pressSequentially(text, { delay });
  else await box.fill(text);
  await page.locator(".results button").first().waitFor();
}

/** A screenshot, as WebP when ffmpeg can make one: a fifth of the size of the PNG. */
async function shoot(page, name) {
  const png = join(hasFfmpeg ? work : made, `${name}.png`);
  await page.screenshot({ path: png });
  if (hasFfmpeg) ffmpeg(["-i", png, "-c:v", "libwebp", "-q:v", "90", join(made, `${name}.webp`)]);
}

async function shots() {
  const size = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 };

  let page = await open({ ...size, colorScheme: "dark" });
  await shoot(page, "overview-dark");

  await search(page, "GraphStore");
  await pause(page, 600);
  await shoot(page, "search-dark");

  await page.locator(`.results button[title="${STORE}"]`).click();
  await inspector(page).locator("code", { hasText: STORE }).first().waitFor();
  await pause(page, 4500);
  await zoomOut(page, 500);
  await shoot(page, "inspector-dark");

  // What the page shows while an assistant works: the nodes its tools were asked about.
  await page.keyboard.press("Escape");
  server.trail("graph_impact", ASKED);
  await pause(page, 2500);
  await shoot(page, "trail-dark");
  await page.context().close();

  page = await open({ ...size, colorScheme: "light" });
  await search(page, "Project");
  await page.locator(`.results button[title="${PROJECT}"]`).click();
  await inspector(page).locator("code", { hasText: PROJECT }).first().waitFor();
  await pause(page, 4500);
  await zoomOut(page, 500);
  await shoot(page, "inspector-light");
  await page.context().close();
}

async function video() {
  const size = { width: 1280, height: 720 };
  const started = Date.now();
  const page = await open({ viewport: size, colorScheme: "dark", recordVideo: { dir: work, size } });
  // The recording began with the page; the demo begins here.
  const lead = (Date.now() - started) / 1000 - 1.5;
  const canvas = await page.locator("canvas").first().boundingBox();
  const centre = { x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height / 2 };

  // Look round the whole project.
  await page.mouse.move(centre.x - 120, centre.y);
  await page.mouse.down();
  await page.mouse.move(centre.x + 140, centre.y + 30, { steps: 70 });
  await page.mouse.up();
  await pause(page, 500);

  // Find a class by name and fly to it.
  await search(page, "GraphStore", 110);
  await pause(page, 900);
  await page.locator(`.results button[title="${STORE}"]`).click();
  await inspector(page).locator("code", { hasText: STORE }).first().waitFor();
  await pause(page, 4200);

  // An assistant asks what a change would affect: the page lights up what it looked at.
  server.trail("graph_impact", ASKED);
  await pause(page, 2600);

  // It then points at one node, as graph_open_ui does.
  server.focus(SPEC);
  await inspector(page).locator("code", { hasText: SPEC }).first().waitFor();
  await pause(page, 4200);

  await page.mouse.move(centre.x + 60, centre.y - 40);
  await page.mouse.down();
  await page.mouse.move(centre.x - 160, centre.y + 20, { steps: 70 });
  await page.mouse.up();
  await pause(page, 1200);

  const length = (Date.now() - started) / 1000 - lead;
  const recording = page.video();
  await page.context().close();
  const webm = await recording.path();

  if (!hasFfmpeg) {
    cpSync(webm, join(made, "demo.webm"));
    return;
  }
  const cut = ["-ss", lead.toFixed(2), "-t", length.toFixed(2), "-i", webm];
  const mp4 = ["-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-movflags", "+faststart"];
  ffmpeg([...cut, ...mp4, join(made, "demo.mp4")]);
  // A GIF small enough for a README: a little faster, 10 frames a second, 96 colours.
  const gif =
    "setpts=PTS/1.25,fps=10,scale=800:-1:flags=lanczos,split[a][b];" +
    "[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle";
  ffmpeg([...cut, "-vf", gif, "-loop", "0", join(made, "demo.gif")]);
}

try {
  if (values.only !== "video") await shots();
  if (values.only !== "shots") await video();
  mkdirSync(OUT, { recursive: true });
  for (const name of readdirSync(made)) {
    cpSync(join(made, name), join(OUT, name));
    console.log(`${values.out ?? "docs/media"}/${name}`);
  }
} finally {
  await browser.close();
  await server.close();
  await project.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
