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
  await page.goto(`${BASE}/index.html`);
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
  await page.locator('input[name="tool"][value="fill"]').check();

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

  console.log("tabs-e2e: all tests passed");
} finally {
  await browser?.close();
  server.kill("SIGTERM");
}
