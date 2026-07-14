import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chunkString, detectMapGeometry } from "../map-io.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const geoPath = path.join(__dirname, "../output/geo_biome_world_512x256.json");

// app.js LEGACY_CODE_MAP と同じ（廃止 ISL を含む）
const LEGACY_CODE_MAP = {
  T: "TWN", P: "PLN", Y: "MDW", V: "SAV", A: "PLT",
  R: "FOR", F: "WDH", 1: "SUB", C: "TGA", H: "CTG",
  J: "JGL", G: "MJG", M: "MTN", K: "VOL", L: "RPL", E: "MSA",
  3: "ALG", 4: "ALT", X: "SNM",
  D: "DSR", Q: "DPL", Z: "HDS",
  S: "SNW", I: "GLC", U: "TND",
  W: "WET", 2: "MOR",
  O: "OCN", B: "BCH", N: "JGL",
  ISL: "JGL",
};

// 現行 BIOMES（app.js から code だけ抜く）
const appSrc = fs.readFileSync(path.join(__dirname, "../app.js"), "utf8");
const biomesBlock = appSrc.slice(appSrc.indexOf("const BIOMES"), appSrc.indexOf("];", appSrc.indexOf("const BIOMES")) + 1);
const biomeCodes = new Set([...biomesBlock.matchAll(/code: "([A-Z0-9]{3})"/g)].map((m) => m[1]));

assert.ok(fs.existsSync(geoPath), "sample geo json exists");
const data = JSON.parse(fs.readFileSync(geoPath, "utf8"));

assert.equal(data.scheme, "map-maker-v2");
assert.equal(data.width, 512);
assert.equal(data.height, 256);
assert.ok(Array.isArray(data.rows));
assert.equal(data.rows.length, 256);

const geometry = detectMapGeometry(data.rows);
assert.ok(geometry);
assert.equal(geometry.cellWidth, 3);
assert.equal(geometry.width, 512);
assert.equal(geometry.height, 256);

let islCount = 0;
for (const row of data.rows) {
  assert.equal(typeof row, "string");
  assert.equal(row.length, 512 * 3);
  for (const raw of chunkString(row, 3)) {
    const code = LEGACY_CODE_MAP[raw] ?? raw;
    if (raw === "ISL") {
      islCount++;
      assert.equal(code, "JGL");
    }
    assert.ok(biomeCodes.has(code), `unknown after migrate: ${raw} → ${code}`);
  }
}
assert.ok(islCount > 0, "sample still contains retired ISL cells to migrate");

console.log(`import-geo-json: ok (ISL×${islCount} → JGL, ${biomeCodes.size} biomes)`);
