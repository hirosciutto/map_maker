import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const PORT = 8877;
const BASE = `http://127.0.0.1:${PORT}`;
const AUTOSAVE_KEY = "blockland-map-maker-autosave";
const APP_IDB_NAME = "blockland-map-maker-files";
const AUTOSAVE_IDB_STORE = "autosave";
const AUTOSAVE_IDB_KEY = "current";

async function clearAutosaveStorage(page) {
  await page.evaluate(async ({ lsKey, dbName, store, key }) => {
    localStorage.removeItem(lsKey);
    await new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName);
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(store)) {
          db.close();
          resolve();
          return;
        }
        const tx = db.transaction(store, "readwrite");
        tx.objectStore(store).delete(key);
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
  }, {
    lsKey: AUTOSAVE_KEY,
    dbName: APP_IDB_NAME,
    store: AUTOSAVE_IDB_STORE,
    key: AUTOSAVE_IDB_KEY,
  });
}

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
  await clearAutosaveStorage(page);
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
  assert.deepEqual(
    await page.evaluate(() => {
      const canvas = document.getElementById("mapCanvas");
      return { width: canvas.width, height: canvas.height, cssWidth: canvas.style.width };
    }),
    { width: 256, height: 256, cssWidth: "1024px" },
    "Canvas内部は地図解像度のままCSS拡大する",
  );

  await paintAtCell(page, 20, 20);
  await page.waitForFunction(() => window.__mapMakerTest.getCell(20, 20) === "PLN");
  const renderedColor = await page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const canvas = document.getElementById("mapCanvas");
    const actual = [...canvas.getContext("2d").getImageData(20, 20, 1, 1).data.slice(0, 3)];
    const swatch = document.querySelector('.palette-row[data-code="PLN"] .swatch');
    const expected = getComputedStyle(swatch).backgroundColor.match(/\d+/g).slice(0, 3).map(Number);
    return { actual, expected };
  });
  assert.deepEqual(renderedColor.actual, renderedColor.expected, "差分描画後のCanvas色がパレットと一致する");

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

  await page.evaluate(() => {
    const biomeRows = Array(512).fill("OCN".repeat(512));
    const zoneRows = Array(512).fill("___".repeat(512));
    window.__mapMakerTest.setGrids(biomeRows, zoneRows);
    document.getElementById("layerBiomeBtn").click();
  });
  assert.deepEqual(
    await page.evaluate(() => {
      const canvas = document.getElementById("mapCanvas");
      return { width: canvas.width, height: canvas.height, cssWidth: canvas.style.width };
    }),
    { width: 512, height: 512, cssWidth: "2048px" },
    "512マップでも内部Canvasを2048pxへ拡大しない",
  );

  console.log("paint-e2e: all tests passed");
} finally {
  if (browser) await browser.close();
  server.kill("SIGTERM");
}
