// The 3D view in a real browser (Chromium, through Playwright). Kept apart from `npm test`, which
// needs no browser: run with `npm run test:browser` after `npx playwright install chromium`.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Project } from "@vertskim/core";
import { type Browser, chromium, type Page } from "playwright";
import { startUiServer, type UiServer } from "./server.js";

const FIXTURE = fileURLToPath(new URL("../../../fixtures/sample", import.meta.url));
/** The built page, copied next to the server by the build. */
const ASSETS = fileURLToPath(new URL("./ui", import.meta.url));
const SESSION = "src/auth/session.ts#Session";

describe("the 3D view in a browser", () => {
  const temps: string[] = [];
  let root: string;
  let project: Project;
  let server: UiServer;
  let browser: Browser;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "vertskim-browser-"));
    const dataDir = mkdtempSync(join(tmpdir(), "vertskim-browser-data-"));
    temps.push(root, dataDir);
    cpSync(FIXTURE, root, { recursive: true });
    project = Project.open({ root, dataDir });
    await project.sync();
    server = await startUiServer(project, { port: 0, assetsDir: ASSETS });
    // Headless Chromium draws WebGL in software.
    browser = await chromium.launch({ args: ["--enable-unsafe-swiftshader"] });
  });
  after(async () => {
    await browser?.close();
    await server?.close();
    await project?.close();
    for (const dir of temps) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  /** A page in a fresh browser context, with every error it reports collected. */
  async function open(url: string, colorScheme: "light" | "dark" = "dark"): Promise<{ page: Page; errors: string[] }> {
    const context = await browser.newContext({ colorScheme, viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.goto(url);
    return { page, errors };
  }

  /** The node count in the status bar, once it is there. */
  async function nodeCount(page: Page): Promise<number> {
    const counts = page.locator('.statusbar [data-item="counts"]');
    await counts.filter({ hasText: /nodes/ }).waitFor();
    return Number(/([\d,]+) nodes/.exec((await counts.textContent()) ?? "")![1]!.replace(/,/g, ""));
  }

  test("draws the graph and says what it holds", async () => {
    const { page, errors } = await open(server.link());
    assert.equal(await nodeCount(page), project.status().nodes);
    const canvas = page.locator("canvas").first();
    await canvas.waitFor();
    const box = await canvas.boundingBox();
    assert.ok(box && box.width > 600 && box.height > 400, `canvas is ${box?.width}x${box?.height}`);
    assert.equal(await page.getByText("This browser cannot draw the 3D graph").count(), 0);
    assert.deepEqual(errors, []);
    await page.context().close();
  });

  test("finds a symbol by name and opens it", async () => {
    const { page, errors } = await open(server.link());
    await page.locator("#search").fill("Session");
    await page.locator(`.results button[title="${SESSION}"]`).click();
    const details = page.getByRole("complementary", { name: "Selected node" });
    await details.locator("code", { hasText: SESSION }).waitFor();
    await details.locator("pre.signature", { hasText: "interface Session" }).waitFor();
    assert.deepEqual(errors, []);
    await page.context().close();
  });

  test("lists the files with their icons and opens one from the explorer", async () => {
    const { page, errors } = await open(server.link());
    const tree = page.getByRole("tree", { name: "Files of the project" });
    // Folders open one level at a time, and every row has the picture of its file type.
    await tree.locator('button[title="src/"]').click();
    await tree.locator('button[title="src/auth/"]').click();
    const row = tree.locator('button[title="src/auth/session.ts"]');
    assert.match((await row.locator("img").getAttribute("src")) ?? "", /^blob:/);
    await row.click();
    const details = page.getByRole("complementary", { name: "Selected node" });
    await details.locator("code", { hasText: "src/auth/session.ts" }).waitFor();
    // The file has a tab of its own beside the graph's.
    await page.getByRole("tab", { name: "session.ts" }).waitFor();
    assert.deepEqual(errors, []);
    await page.context().close();
  });

  test("opens on the node a link names, as graph_open_ui does", async () => {
    const { page, errors } = await open(server.link(SESSION));
    const details = page.getByRole("complementary", { name: "Selected node" });
    await details.locator("code", { hasText: SESSION }).waitFor();
    assert.deepEqual(errors, []);
    await page.context().close();
  });

  test("shows Luau's name, file icon and highlighted source", async () => {
    const path = "src/greeting.luau";
    writeFileSync(
      join(root, path),
      "--[=[ A greeting. ]=]\nlocal message = [=[hello]=]\nexport type Greeting = string\nlocal function greet(): string\n  return `message: {message}`\nend\nreturn greet\n",
    );
    await project.sync();
    const { page, errors } = await open(server.link(path));
    const details = page.getByRole("complementary", { name: "Selected node" });
    await details.locator("code", { hasText: path }).waitFor();
    await details.locator(".hero-facts", { hasText: "Luau" }).waitFor();
    await details.locator(".tok-keyword", { hasText: /^export$/ }).waitFor();
    await details.locator(".tok-comment", { hasText: "A greeting." }).waitFor();
    await details.locator(".tok-string", { hasText: "[=[hello]=]" }).waitFor();
    await details.locator(".tok-string", { hasText: "message: {message}" }).waitFor();
    const tree = page.getByRole("tree", { name: "Files of the project" });
    // Opening a link to this file may already have expanded its folder.
    if ((await tree.locator(`button[title="${path}"]`).count()) === 0) {
      await tree.locator('button[title="src/"]').click();
    }
    const icon = tree.locator(`button[title="${path}"] img`);
    assert.match((await icon.getAttribute("src")) ?? "", /^blob:/);
    assert.deepEqual(errors, []);
    await page.context().close();
  });

  test("keeps a note written in the page", async () => {
    const { page, errors } = await open(server.link(SESSION));
    const details = page.getByRole("complementary", { name: "Selected node" });
    await details.locator("code", { hasText: SESSION }).waitFor();
    await details.locator("#note-draft").fill("Sessions expire after an hour of no use.");
    await details.getByRole("button", { name: "Add note" }).click();
    await details.getByText("Sessions expire after an hour of no use.").waitFor();
    const kept = project.notesFor([SESSION]).get(SESSION) ?? [];
    assert.ok(kept.some((note) => note.text === "Sessions expire after an hour of no use."));
    assert.deepEqual(errors, []);
    await page.context().close();
  });

  test("follows the system's choice of light or dark", async () => {
    const dark = await open(server.link(), "dark");
    const light = await open(server.link(), "light");
    // Code run in the page is passed as text: this package is type-checked for Node, not the DOM.
    const background = (page: Page) => page.evaluate<string>("getComputedStyle(document.body).backgroundColor");
    assert.notEqual(await background(dark.page), await background(light.page));
    assert.deepEqual([...dark.errors, ...light.errors], []);
    await dark.page.context().close();
    await light.page.context().close();
  });

  test("shows a change to the project without being reloaded", async () => {
    const { page, errors } = await open(server.link());
    const before = await nodeCount(page);
    writeFileSync(join(root, "src/clock.ts"), "export function now(): number {\n  return Date.now();\n}\n");
    await project.sync();
    // Polled from here: the page's content security policy rightly refuses the eval a page-side wait needs.
    const deadline = Date.now() + 15_000;
    while ((await nodeCount(page)) <= before) {
      if (Date.now() > deadline) assert.fail("the page did not show the new file within 15 s");
      await page.waitForTimeout(100);
    }
    assert.deepEqual(errors, []);
    await page.context().close();
  });
});
