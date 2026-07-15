import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const PORT = 8881;
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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(url, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // retry
    }
    await wait(100);
  }
  throw new Error(`server not ready: ${url}`);
}

function cellPos(x, y, zoom) {
  return { x: x * zoom + zoom / 2, y: y * zoom + zoom / 2 };
}

async function paintAt(page, x, y) {
  const zoom = Number(await page.locator("#zoomRange").inputValue());
  await page.locator("#mapCanvas").click({ position: cellPos(x, y, zoom) });
}

async function dragCrop(page, x0, y0, x1, y1) {
  const zoom = Number(await page.locator("#zoomRange").inputValue());
  const canvas = page.locator("#mapCanvas");
  await canvas.hover({ position: cellPos(x0, y0, zoom) });
  await page.mouse.down();
  await canvas.hover({ position: cellPos(x1, y1, zoom) });
  await page.mouse.up();
}

const server = spawn("python3", ["-m", "http.server", String(PORT)], {
  cwd: "/Users/nakashima/works/map_maker",
  stdio: "ignore",
});

let browser;
try {
  await waitForServer(`${BASE}/index.html`);
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(`${BASE}/index.html?test=1`);
  await clearAutosaveStorage(page);
  await page.reload();
  await page.waitForFunction(() => window.__mapMakerTest?.ready);
  await page.evaluate(() => {
    document.getElementById("canvasWrap").scrollLeft = 0;
    document.getElementById("canvasWrap").scrollTop = 0;
  });

  // Clear masks explicitly (regression: bug happened with masks cleared)
  await page.locator("#clearMaskBtn").click();

  async function setTool(tool) {
    await page.evaluate((value) => {
      const input = document.querySelector(`input[name="tool"][value="${value}"]`);
      input.checked = true;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, tool);
  }

  await setTool("crop");
  await dragCrop(page, 10, 10, 80, 60);
  await page.locator("#selectionConfirmBtn").click();
  assert.equal(await page.evaluate(() => window.__mapMakerTest.getTool()), "paint");

  await page.locator('.palette-row[data-code="PLN"]').click();
  await page.locator('[data-brush-size="1"]').click();
  await paintAt(page, 5, 5);
  assert.equal(await page.evaluate(() => window.__mapMakerTest.getCell(5, 5)), "PLN");

  // Cancel path also restores paint tool
  await setTool("crop");
  await dragCrop(page, 2, 2, 20, 20);
  await page.locator("#selectionCancelBtn").click();
  assert.equal(await page.evaluate(() => window.__mapMakerTest.getTool()), "paint");

  // Layer 2 fill must stop at the layer-1 biome boundary under the cursor.
  // PLN and FOR are separate biomes but share the same unpainted zone code (___),
  // so filling on a PLN cell must not spill into the adjacent FOR cells.
  await page.evaluate(() => {
    window.__mapMakerTest.setGrids(
      ["PLNPLNFOR", "PLNPLNFOR", "FORFORFOR"],
      ["_________", "_________", "_________"],
    );
  });
  await setTool("fill");
  await page.locator('.palette-row[data-code="EUR"]').click();
  await paintAt(page, 0, 0);
  assert.equal(await page.evaluate(() => window.__mapMakerTest.getZoneCell(0, 0)), "EUR");
  assert.equal(await page.evaluate(() => window.__mapMakerTest.getZoneCell(1, 1)), "EUR");
  assert.equal(await page.evaluate(() => window.__mapMakerTest.getZoneCell(2, 0)), "___");
  assert.equal(await page.evaluate(() => window.__mapMakerTest.getZoneCell(0, 2)), "___");

  // Two GLC islands separated by FOR must not cross-fill.
  await page.evaluate(() => {
    window.__mapMakerTest.setGrids(
      ["GLCFORGLC", "GLCFORGLC", "GLCFORGLC"],
      ["_________", "_________", "_________"],
    );
  });
  await page.locator('.palette-row.zone-row[data-code="JPN"]').click();
  await paintAt(page, 0, 0);
  assert.equal(await page.evaluate(() => window.__mapMakerTest.getZoneCell(0, 0)), "JPN");
  assert.equal(await page.evaluate(() => window.__mapMakerTest.getZoneCell(0, 1)), "JPN");
  assert.equal(await page.evaluate(() => window.__mapMakerTest.getZoneCell(2, 0)), "___");
  assert.equal(await page.evaluate(() => window.__mapMakerTest.getZoneCell(2, 2)), "___");

  assert.equal(errors.length, 0, errors.join("; "));
  console.log("layer-paint-e2e: all tests passed");
} finally {
  if (browser) await browser.close();
  server.kill("SIGKILL");
}
