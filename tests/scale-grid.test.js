import assert from "node:assert/strict";

function createGrid(size, code = "O") {
  return Array.from({ length: size }, () => Array.from({ length: size }, () => code));
}

function upscaleGrid(grid, sourceSize, factor) {
  const targetSize = sourceSize * factor;
  const next = createGrid(targetSize, "O");
  for (let sy = 0; sy < sourceSize; sy++) {
    for (let sx = 0; sx < sourceSize; sx++) {
      const code = grid[sy][sx];
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          next[sy * factor + dy][sx * factor + dx] = code;
        }
      }
    }
  }
  return next;
}

const source = createGrid(2, "O");
source[0][0] = "B";
source[1][1] = "P";

const upscaled = upscaleGrid(source, 2, 2);
assert.equal(upscaled.length, 4);
assert.equal(upscaled[0][0], "B");
assert.equal(upscaled[0][1], "B");
assert.equal(upscaled[1][0], "B");
assert.equal(upscaled[1][1], "B");
assert.equal(upscaled[2][2], "P");
assert.equal(upscaled[3][3], "P");
assert.equal(upscaled[0][2], "O");

console.log("scale-grid: all tests passed");
