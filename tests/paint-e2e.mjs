import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const PORT = 8877;
const BASE = `http://127.0.0.1:${PORT}`;
const AUTOSAVE_KEY = "blockland-map-maker-autosave";

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(url, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // retry
    }
    await wait(100);
  }
  throw new Error(`server not ready: ${url}`);
}

function cellPosition(x, y, zoom) {
  return { x: x * zoom + zoom / 2, y: y * zoom + zoom / 2 };
}

async function paintAtCell(page, x, y) {
  const zoom = Number(await page.locator("#zoomRange").inputValue());
  await page.locator("#mapCanvas").click({ position: cellPosition(x, y, zoom) });
}

async function dragCells(page, fromX, fromY, toX, toY) {
  const zoom = Number(await page.locator("#zoomRange").inputValue());
  const canvas = page.locator("#mapCanvas");
  await canvas.hover({ position: cellPosition(fromX, fromY, zoom) });
  await page.mouse.down();
  await canvas.hover({ position: cellPosition(toX, toY, zoom) });
  await page.mouse.up();
}

const server = spawn("python3", ["-m", "http.server", String(PORT)], {
  cwd: new URL("..", import.meta.url).pathname,
  stdio: "ignore",
});

let browser;
try {
  await waitForServer(`${BASE}/index.html`);
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto(`${BASE}/index.html?test=1`);
  await page.evaluate((key) => localStorage.removeItem(key), AUTOSAVE_KEY);
  await page.reload();
  await page.waitForFunction(() => window.__mapMakerTest?.ready);
  await page.evaluate(() => {
    const wrap = document.getElementById("canvasWrap");
    wrap.scrollLeft = 0;
    wrap.scrollTop = 0;
  });

  await page.locator('input[name="tool"][value="paint"]').check();
  await page.locator('[data-brush-size="1"]').click();

  assert.equal(await page.evaluate(() => window.__mapMakerTest.getTool()), "paint");
  assert.equal(await page.evaluate(() => window.__mapMakerTest.getCell(20, 20)), "OCN");

  await paintAtCell(page, 20, 20);
  await page.waitForFunction(() => window.__mapMakerTest.getCell(20, 20) === "PLN");

  const cursor = await page.evaluate(() => window.__mapMakerTest.getCursor());
  assert.deepEqual(cursor, { x: 20, y: 20 }, "カーソル位置と描画位置が一致");

  await page.locator('[data-brush-size="4"]').click();
  await paintAtCell(page, 30, 30);
  const brush4 = await page.evaluate(() => ({
    a: window.__mapMakerTest.getCell(30, 30),
    b: window.__mapMakerTest.getCell(31, 30),
    c: window.__mapMakerTest.getCell(30, 31),
    d: window.__mapMakerTest.getCell(31, 31),
    outside: window.__mapMakerTest.getCell(29, 30),
  }));
  assert.equal(brush4.a, "PLN");
  assert.equal(brush4.b, "PLN");
  assert.equal(brush4.c, "PLN");
  assert.equal(brush4.d, "PLN");
  assert.equal(brush4.outside, "OCN", "2x2 ブラシはカーソル位置を左上基準に塗る");

  await page.locator('[data-brush-size="1"]').click();
  await dragCells(page, 40, 40, 46, 40);
  await page.waitForFunction(() => {
    const api = window.__mapMakerTest;
    return [40, 41, 42, 43, 44, 45, 46].every((x) => api.getCell(x, 40) === "PLN");
  });

  console.log("paint-e2e: all tests passed");
} finally {
  if (browser) await browser.close();
  server.kill("SIGTERM");
}
