// 被覆チェック(zone_map の「動物が出現しないピクセル」検査 & 近傍zone塗替)の純粋ロジック。
// blockland/tools/check_zone_coverage.py と同型。生息域データは habitat-data.js(draft から生成)。

// 生息域から高速判定用の構造を作る。
//   alive: Set("<biome>|<zone>")  … その組に出現する種族が1つ以上ある
//   zok:   { biome: Set(zone) }   … その biome を復活させられる zone 集合
export function buildCoverage(species) {
  const alive = new Set();
  const zok = {};
  for (const s of species) {
    for (const b of s.biomes) {
      if (!zok[b]) zok[b] = new Set();
      for (const z of s.zones) {
        zok[b].add(z);
        alive.add(b + "|" + z);
      }
    }
  }
  return { alive, zok };
}

// 未塗りセンチネル(app.js の ZONE_UNPAINTED と一致させること)。
export const UNPAINTED = "___";

// roam_weight>0 の陸ピクセルを検査。
//   unpainted: 地理圏が未塗り(___)= まだ塗っていないだけ。塗れば消える。
//   dead:      塗り済みだが (biome,zone) に出現種族が無い = 生息域の穴。
export function findDead(biomeGrid, zoneGrid, w, h, roam, alive) {
  const dead = [];
  const unpainted = [];
  let checked = 0;
  const byBiome = {};
  const byPair = {};
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const b = biomeGrid[y][x];
      if (!(roam[b] > 0)) continue; // 意図的に空(海・街・最高峰)
      checked++;
      const z = zoneGrid[y][x];
      if (z === UNPAINTED) {
        unpainted.push([x, y]); // 未塗り(要塗り。デッドとは別)
        continue;
      }
      if (!alive.has(b + "|" + z)) {
        dead.push([x, y]);
        byBiome[b] = (byBiome[b] || 0) + 1;
        const k = b + "×" + z;
        byPair[k] = (byPair[k] || 0) + 1;
      }
    }
  }
  return { dead, unpainted, checked, byBiome, byPair };
}

// デッドピクセルの zone を、その biome を復活させられる最寄り zone へ。
// biome 単位の多源BFS(行優先で源を積む=決定論)。changes=[[x,y,newZone],...]。
export function repaint(biomeGrid, zoneGrid, w, h, dead, zok) {
  const byB = new Map();
  for (const [x, y] of dead) {
    const b = biomeGrid[y][x];
    if (!byB.has(b)) byB.set(b, []);
    byB.get(b).push([x, y]);
  }
  const changes = [];
  const unfixable = {};
  for (const [b, cells] of byB) {
    const okz = zok[b];
    if (!okz || okz.size === 0) {
      unfixable[b] = "この biome を含む種族が存在しない(生息域表の穴)";
      continue;
    }
    const src = new Array(h);
    for (let y = 0; y < h; y++) src[y] = new Array(w).fill(null);
    const q = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (okz.has(zoneGrid[y][x])) {
          src[y][x] = zoneGrid[y][x];
          q.push([x, y]);
        }
      }
    }
    if (q.length === 0) {
      unfixable[b] = "復活可能な zone がマップ上に1つも存在しない";
      continue;
    }
    let head = 0;
    while (head < q.length) {
      const [x, y] = q[head++];
      const sz = src[y][x];
      const nbrs = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
      for (const [nx, ny] of nbrs) {
        if (nx >= 0 && ny >= 0 && nx < w && ny < h && src[ny][nx] === null) {
          src[ny][nx] = sz;
          q.push([nx, ny]);
        }
      }
    }
    for (const [x, y] of cells) {
      const nz = src[y][x];
      if (nz && nz !== zoneGrid[y][x]) changes.push([x, y, nz]);
    }
  }
  return { changes, unfixable };
}
