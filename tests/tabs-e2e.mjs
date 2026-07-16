import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const PORT = 8879;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_NAME = "blockland-map-maker-files";

const server = spawn("python3", ["-m", "http.server", String(PORT)], {
  cwd: new URL("..", import.meta.url).pathname,
  stdio: "ignore",
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/index.html`)).ok) return;
    } catch {
      // 起動待ち
    }
    await wait(100);
  }
  throw new Error("server did not start");
}

let browser;
try {
  await waitForServer();
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto(`${BASE}/index.html?test`);
  await page.evaluate(async (dbName) => {
    localStorage.clear();
    await new Promise((resolve) => {
      const request = indexedDB.deleteDatabase(dbName);
      request.onsuccess = request.onerror = request.onblocked = () => resolve();
    });
  }, DB_NAME);
  await page.reload();
  await page.waitForSelector(".document-tab");

  assert.equal(await page.locator(".document-tab").count(), 1);
  await page.getByRole("button", { name: "ツール" }).click();
  await page.locator("#zoomRange").fill("6");
  await page.locator("#showGridToggle").check();
  await page.getByRole("button", { name: "パレット" }).click();
  await page.locator('.tool-option:has(input[name="tool"][value="fill"])').click();

  await page.getByRole("button", { name: "新しいマップ" }).click();
  assert.equal(await page.locator(".document-tab").count(), 2);
  await page.getByRole("button", { name: "ツール" }).click();
  await page.locator("#zoomRange").fill("3");
  await page.locator("#showGridToggle").uncheck();
  await page.getByRole("button", { name: "パレット" }).click();
  await page.getByRole("button", { name: "レイヤー2: 地理圏" }).click();

  await page.getByRole("tab", { name: "新規マップ" }).click();
  assert.equal(await page.locator("#zoomRange").inputValue(), "6");
  assert.equal(await page.locator("#showGridToggle").isChecked(), true);
  assert.equal(await page.locator("#layerBiomeBtn").getAttribute("class"), "layer-btn active");
  assert.equal(await page.locator('input[name="tool"]:checked').getAttribute("value"), "fill");

  await page.getByRole("tab", { name: "新規 256×256" }).click();
  assert.equal(await page.locator("#zoomRange").inputValue(), "3");
  assert.equal(await page.locator("#showGridToggle").isChecked(), false);
  assert.equal(await page.locator("#layerZoneBtn").getAttribute("class"), "layer-btn active");

  await wait(600);
  await page.reload();
  await page.waitForSelector(".document-tab");
  assert.equal(await page.locator(".document-tab").count(), 2);
  assert.equal(await page.locator("#zoomRange").inputValue(), "3");
  assert.equal(await page.locator("#layerZoneBtn").getAttribute("class"), "layer-btn active");
  assert.equal(await page.locator('input[name="tool"]:checked').getAttribute("value"), "fill");

  const tabs = await page.evaluate(() => window.__mapMakerTest.getTabs());
  const sourceTab = tabs[0];
  const targetTab = tabs[1];
  const oceanRow = "OCN".repeat(8);
  await page.evaluate(({ targetId, rows }) => {
    window.__mapMakerTest.activateTab(targetId);
    window.__mapMakerTest.setBiomeRows(rows);
    window.__mapMakerTest.setZoom(20);
  }, { targetId: targetTab.id, rows: Array(8).fill(oceanRow) });
  await page.evaluate(({ sourceId, rows }) => {
    window.__mapMakerTest.activateTab(sourceId);
    window.__mapMakerTest.setBiomeRows(rows);
    window.__mapMakerTest.setZoom(20);
    window.__mapMakerTest.selectCells([{ x: 3, y: 3 }]);
  }, {
    sourceId: sourceTab.id,
    rows: Array.from({ length: 8 }, (_, y) => (
      y === 3 ? `${"OCN".repeat(3)}PLN${"OCN".repeat(4)}` : oceanRow
    )),
  });
  const sourceCanvas = await page.locator("#mapCanvas").boundingBox();
  const targetTabBox = await page.locator(`.document-tab[data-document-id="${targetTab.id}"]`).boundingBox();
  assert.ok(sourceCanvas && targetTabBox);
  await page.mouse.move(sourceCanvas.x + 3.5 * 20, sourceCanvas.y + 3.5 * 20);
  await page.mouse.down();
  await page.mouse.move(targetTabBox.x + targetTabBox.width / 2, targetTabBox.y + targetTabBox.height / 2);
  await wait(1100);
  assert.equal((await page.evaluate(() => window.__mapMakerTest.getTabs())).find((tab) => tab.active).id, targetTab.id);

  const targetCanvas = await page.locator("#mapCanvas").boundingBox();
  assert.ok(targetCanvas);
  await page.mouse.move(targetCanvas.x + 4.5 * 20, targetCanvas.y + 4.5 * 20);
  await page.mouse.up();
  await page.locator("#selectionConfirmBtn").click();
  assert.equal(await page.evaluate(() => window.__mapMakerTest.getCell(4, 4)), "PLN");
  await page.evaluate((sourceId) => window.__mapMakerTest.activateTab(sourceId), sourceTab.id);
  assert.equal(await page.evaluate(() => window.__mapMakerTest.getCell(3, 3)), "OCN");
  await page.locator("#undoBtn").click();
  assert.equal(await page.evaluate(() => window.__mapMakerTest.getCell(3, 3)), "PLN");
  await page.evaluate((targetId) => window.__mapMakerTest.activateTab(targetId), targetTab.id);
  await page.locator("#undoBtn").click();
  assert.equal(await page.evaluate(() => window.__mapMakerTest.getCell(4, 4)), "OCN");

  console.log("tabs-e2e: all tests passed");
} finally {
  await browser?.close();
  server.kill("SIGTERM");
}
