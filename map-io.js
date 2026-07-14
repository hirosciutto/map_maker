/**
 * Map JSON row parsing / normalization helpers.
 * Supports v2 (3-char codes), legacy (1-char), and mixed rows corrupted by
 * writing legacy "O" into a v2 grid.
 */

export function chunkString(str, chunkSize) {
  const chunks = [];
  for (let i = 0; i < str.length; i += chunkSize) chunks.push(str.slice(i, i + chunkSize));
  return chunks;
}

export function detectMapGeometry(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  if (!rows.every((row) => typeof row === "string")) return null;
  const height = rows.length;
  const len = rows[0].length;
  if (!rows.every((row) => row.length === len)) return null;

  if (len === height) return { cellWidth: 1, width: height, height };
  if (len === height * 3) return { cellWidth: 3, width: height, height };
  if (len % 3 === 0) return { cellWidth: 3, width: len / 3, height };
  return { cellWidth: 1, width: len, height };
}

export function buildCodeMatchers(validCodes, legacyCodes = []) {
  const codes = new Set([...validCodes, ...legacyCodes]);
  return [...codes].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

/**
 * Greedy-parse a row into raw biome tokens (legacy or v2).
 * @returns {string[] | null}
 */
export function parseRowRawCodes(row, matchers) {
  if (typeof row !== "string") return null;
  const codes = [];
  let i = 0;
  while (i < row.length) {
    let matched = null;
    for (const code of matchers) {
      if (row.startsWith(code, i)) {
        matched = code;
        break;
      }
    }
    if (!matched) return null;
    codes.push(matched);
    i += matched.length;
  }
  return codes;
}

/**
 * Recover rows that mix v2 codes with legacy single-char codes (esp. "O").
 * @returns {{ rows: string[], geometry: { cellWidth: number, width: number, height: number } } | null}
 */
export function recoverMixedCodeRows(rows, options = {}) {
  const {
    width: expectedWidth = null,
    height: expectedHeight = null,
    validCodes,
    legacyCodes = [],
    migrateCode,
  } = options;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  if (!validCodes || typeof migrateCode !== "function") return null;

  const validSet = validCodes instanceof Set ? validCodes : new Set(validCodes);
  const height = Number.isFinite(expectedHeight) && expectedHeight > 0 ? expectedHeight : rows.length;
  if (rows.length !== height) return null;

  const matchers = buildCodeMatchers(validSet, legacyCodes);
  const normalizedRows = [];
  let width = null;

  for (const row of rows) {
    const rawCodes = parseRowRawCodes(row, matchers);
    if (!rawCodes) return null;
    if (width === null) width = rawCodes.length;
    if (rawCodes.length !== width) return null;
    if (Number.isFinite(expectedWidth) && expectedWidth > 0 && rawCodes.length !== expectedWidth) {
      return null;
    }

    const migrated = [];
    for (const rawCode of rawCodes) {
      const code = migrateCode(rawCode);
      if (!validSet.has(code)) return null;
      migrated.push(code);
    }
    normalizedRows.push(migrated.join(""));
  }

  return {
    rows: normalizedRows,
    geometry: { cellWidth: 3, width, height },
  };
}

export function sanitizeGridCodes(grid, migrateCode, isValidCode, fallbackCode = "OCN") {
  return grid.map((row) =>
    row.map((code) => {
      const migrated = migrateCode(code);
      return isValidCode(migrated) ? migrated : fallbackCode;
    }),
  );
}
