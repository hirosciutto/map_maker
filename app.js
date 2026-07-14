import {
  brushOrigin,
  brushPaintCells,
  getBrushShape,
  normalizeBrushSize,
  PEN_BRUSH_SIZES,
} from "./brush-shapes.js";
import { HABITAT } from "./habitat-data.js";
import { buildCoverage, findDead, repaint as repaintCoverage } from "./coverage-logic.js";
import {
  applySelectionContentReplace,
  applySelectionMove,
  applySelectionRotate,
  applySelectionScale,
  buildSelectionCells,
  cellsFromEntries,
  cellsInsidePolygon,
  computeScaleFromCorner,
  computeScaleFromEdge,
  cropGridToRect,
  entriesFromCells,
  getSelectionBoxHandles,
  hitHandlePoint,
  hitRotateHandleOutside,
  resizeGrid,
  resizeGridCanvas,
  rotateEntries,
  scaleEntries,
  selectionBounds,
  selectionMapsEqual,
} from "./lasso-logic.js";
import {
  chunkString,
  detectMapGeometry,
  recoverMixedCodeRows,
  sanitizeGridCodes,
} from "./map-io.js";
import {
  ADJACENT_REPLACE_TARGET,
  LAND_SELECTOR,
  chooseAdjacentReplacement,
  cellMatchesReplaceRule as cellMatchesReplaceRuleAt,
  collectReplacePreviewCells as collectReplacePreviewCellsAt,
  familyKeyFromSelector,
  getReplaceTargetsForRule as getReplaceTargetsForRuleAt,
  hasAdjacentBiome as hasAdjacentBiomeAt,
  isFamilySelector,
  makeFamilySelector,
} from "./replace-logic.js";

// バイオーム定義の追加フィールド（配置の基準）:
//   category    : 地形カテゴリ（hub/grassland/forest/jungle/mountain/alpine/arid/frozen/wetland/coastal）
//   elevation   : 標高の基準点（メートル実値の目安。海面=0）
//   temp        : 気温（cold=寒 / temperate=温 / hot=暑）
//   humidity    : 湿度（dry=乾 / mid=普通 / wet=湿）
//   relief      : 起伏（flat/rolling/rugged/peak。3D生成時の起伏振幅の目安）
//   colorFamily : 配色ファミリー（COLOR_FAMILIES のキー。色相・彩度を共有するグループ）
//   note        : 特徴の自由記述メモ
// パレットは基本 category → elevation 昇順で並べる。
// コードは固定3文字の大文字ニーモニック（docs/geo-reproduction-design.md 付録A準拠）。

// 配色ファミリー定義: 同じファミリー内は色相(h)・彩度(s)を固定し、
// 標高をファミリー内の最小〜最大で正規化して明度(l: lmin〜lmax)を振る。
// 単一メンバーのファミリーは lmin === lmax（固定の明度）。
const COLOR_FAMILIES = {
  ocean_deep:        { jp: "深海・海洋",           h: 210, s: 55,  lmin: 14, lmax: 44 },
  beach:             { jp: "砂浜",                 h: 37,  s: 100, lmin: 85, lmax: 85 },
  wetland_mangrove:  { jp: "マングローブ・湿地",   h: 170, s: 35,  lmin: 32, lmax: 72 },
  grassland_low:     { jp: "草原(低地)",           h: 90,  s: 55,  lmin: 32, lmax: 72 },
  steppe_highland:   { jp: "ステップ・高原草原",   h: 58,  s: 32,  lmin: 32, lmax: 72 },
  temperate_forest:  { jp: "温帯林",               h: 110, s: 45,  lmin: 24, lmax: 64 },
  boreal_forest:     { jp: "針葉樹林・寒地林",     h: 155, s: 38,  lmin: 26, lmax: 66 },
  rainforest:        { jp: "ジャングル・熱帯林",   h: 150, s: 65,  lmin: 24, lmax: 64 },
  arid_warm:         { jp: "温暖乾燥地",           h: 45,  s: 55,  lmin: 48, lmax: 80 },
  arid_cold:         { jp: "寒冷乾燥地",           h: 30,  s: 30,  lmin: 32, lmax: 72 },
  rock_volcanic:     { jp: "岩石台地・火山",       h: 15,  s: 60,  lmin: 38, lmax: 62 },
  alpine_grass:      { jp: "高山草原・寒冷高地",   h: 75,  s: 25,  lmin: 32, lmax: 72 },
  ice_flat:          { jp: "氷床・平坦氷雪",       h: 185, s: 35,  lmin: 68, lmax: 92 },
  glacier:           { jp: "氷河",                 h: 208, s: 24,  lmin: 72, lmax: 84 },
  // 山岳・雪峰: 岩の山岳(暗いL帯)と万年雪の峰(明るいL帯)を同じ寒色相(h210)で束ねた複合ファミリー。
  // 岩=lmin18〜38、雪=lmin78〜96 の2帯に分かれるため、各メンバーの明度は手動配置。
  mountain_snowpeak: { jp: "山岳・雪峰",           h: 210, s: 6,   lmin: 18, lmax: 96 },
  hub:               { jp: "拠点",                 h: 0,   s: 0,   lmin: 50, lmax: 50 },
};

const BIOMES = [
  // 拠点
  { code: "TWN", name: "town", jp: "セントラルシティ", color: "#808080", category: "hub", elevation: 50, temp: "temperate", humidity: "mid", relief: "flat", colorFamily: "hub", note: "プレイヤー拠点となる都市" },
  // 草原・平地
  { code: "PLN", name: "plains", jp: "平原", color: "#527e25", category: "grassland", elevation: 100, temp: "temperate", humidity: "mid", relief: "flat", colorFamily: "grassland_low", note: "基本となる開けた平地" },
  { code: "MDW", name: "meadow", jp: "花畑メドウ", color: "#73b234", category: "grassland", elevation: 150, temp: "temperate", humidity: "mid", relief: "flat", colorFamily: "grassland_low", note: "花が咲く明るい草原" },
  { code: "SAV", name: "savanna", jp: "サバンナ", color: "#b8df90", category: "grassland", elevation: 250, temp: "hot", humidity: "dry", relief: "flat", colorFamily: "grassland_low", note: "乾いた熱帯の草原" },
  { code: "SHR", name: "shrubland", jp: "地中海性低木", color: "#6c6a37", category: "grassland", elevation: 300, temp: "temperate", humidity: "dry", relief: "rolling", colorFamily: "steppe_highland", note: "乾いた低木がまばらに茂る土地" },
  { code: "STP", name: "steppe", jp: "温帯ステップ", color: "#76743d", category: "grassland", elevation: 400, temp: "temperate", humidity: "dry", relief: "flat", colorFamily: "steppe_highland", note: "乾いた広大な温帯草原" },
  { code: "PLT", name: "plateau", jp: "高原", color: "#97954e", category: "grassland", elevation: 800, temp: "temperate", humidity: "mid", relief: "rolling", colorFamily: "steppe_highland", note: "標高の高い平坦な草地" },
  { code: "SVH", name: "highland_savanna", jp: "高地サバンナ", color: "#a8a657", category: "grassland", elevation: 1000, temp: "hot", humidity: "dry", relief: "rolling", colorFamily: "steppe_highland", note: "標高のある乾いた草原" },
  { code: "HST", name: "highland_steppe", jp: "高原ステップ", color: "#b4b26e", category: "grassland", elevation: 1300, temp: "cold", humidity: "dry", relief: "rolling", colorFamily: "steppe_highland", note: "標高の高い乾いた草地" },
  { code: "SST", name: "subalpine_steppe", jp: "亜高山ステップ", color: "#cecda1", category: "grassland", elevation: 1900, temp: "cold", humidity: "dry", relief: "rolling", colorFamily: "steppe_highland", note: "森林限界に近い乾いた草地" },
  // 森林
  { code: "FOR", name: "forest", jp: "森林", color: "#2b5922", category: "forest", elevation: 200, temp: "temperate", humidity: "mid", relief: "rolling", colorFamily: "temperate_forest", note: "温帯の広葉樹林" },
  { code: "WDH", name: "wooded_hills", jp: "山林", color: "#428934", category: "forest", elevation: 500, temp: "temperate", humidity: "mid", relief: "rugged", colorFamily: "temperate_forest", note: "丘陵地の森" },
  { code: "TGA", name: "taiga", jp: "タイガ", color: "#295b46", category: "forest", elevation: 600, temp: "cold", humidity: "mid", relief: "rolling", colorFamily: "boreal_forest", note: "寒冷な針葉樹林" },
  { code: "CTG", name: "cold_taiga", jp: "寒冷タイガ", color: "#3e896a", category: "forest", elevation: 900, temp: "cold", humidity: "mid", relief: "rolling", colorFamily: "boreal_forest", note: "より寒冷な針葉樹林" },
  { code: "MFR", name: "montane_forest", jp: "山地林", color: "#88cd7a", category: "forest", elevation: 1100, temp: "temperate", humidity: "mid", relief: "rugged", colorFamily: "temperate_forest", note: "斜面に広がる山地の森" },
  { code: "SUB", name: "subalpine_forest", jp: "亜高山林", color: "#87c9ae", category: "forest", elevation: 1500, temp: "cold", humidity: "mid", relief: "rugged", colorFamily: "boreal_forest", note: "高標高帯の針葉樹林" },
  // ジャングル
  { code: "JGL", name: "lowland_jungle", jp: "平地ジャングル", color: "#15653d", category: "jungle", elevation: 100, temp: "hot", humidity: "wet", relief: "flat", colorFamily: "rainforest", note: "低地の熱帯雨林" },
  { code: "DRF", name: "dry_forest", jp: "熱帯季節林", color: "#197647", category: "jungle", elevation: 300, temp: "hot", humidity: "mid", relief: "rolling", colorFamily: "rainforest", note: "乾季に落葉する熱帯林" },
  { code: "DRU", name: "monsoon_upland", jp: "丘陵季節林", color: "#23a463", category: "jungle", elevation: 800, temp: "hot", humidity: "mid", relief: "rolling", colorFamily: "rainforest", note: "季節風が吹く丘陵の疎林" },
  { code: "MJG", name: "montane_jungle", jp: "山地ジャングル", color: "#25ad69", category: "jungle", elevation: 900, temp: "hot", humidity: "wet", relief: "rugged", colorFamily: "rainforest", note: "高地の熱帯林" },
  { code: "RFM", name: "montane_rainforest", jp: "中山ジャングル", color: "#31d382", category: "jungle", elevation: 1400, temp: "hot", humidity: "wet", relief: "rugged", colorFamily: "rainforest", note: "霧の少ない中標高の熱帯林" },
  { code: "CLF", name: "cloud_forest", jp: "雲霧林", color: "#68dfa3", category: "jungle", elevation: 2000, temp: "hot", humidity: "wet", relief: "rugged", colorFamily: "rainforest", note: "霧に包まれた山地の熱帯林" },
  // 山岳・岩地
  { code: "MSA", name: "mesa", jp: "メサ", color: "#9b4427", category: "mountain", elevation: 1000, temp: "hot", humidity: "dry", relief: "rugged", colorFamily: "rock_volcanic", note: "赤い岩層の台地" },
  { code: "RPL", name: "rocky_plateau", jp: "岩石高原", color: "#b44f2d", category: "mountain", elevation: 1200, temp: "temperate", humidity: "dry", relief: "rolling", colorFamily: "rock_volcanic", note: "岩がちの高原" },
  { code: "VOL", name: "volcano", jp: "火山", color: "#d88164", category: "mountain", elevation: 1800, temp: "hot", humidity: "dry", relief: "peak", colorFamily: "rock_volcanic", note: "溶岩・火山灰の山" },
  { code: "MTN", name: "mountain", jp: "山岳", color: "#2b2e31", category: "mountain", elevation: 2000, temp: "cold", humidity: "mid", relief: "rugged", colorFamily: "mountain_snowpeak", note: "岩肌の山地" },
  { code: "ARK", name: "alpine_rock", jp: "高山岩稜", color: "#43474c", category: "mountain", elevation: 2800, temp: "cold", humidity: "mid", relief: "rugged", colorFamily: "mountain_snowpeak", note: "森林限界を超えた岩の稜線" },
  { code: "HRK", name: "high_rock", jp: "高峰岩壁", color: "#5b6167", category: "mountain", elevation: 3600, temp: "cold", humidity: "dry", relief: "rugged", colorFamily: "mountain_snowpeak", note: "切り立った岩壁の山肌" },
  // 高山帯
  { code: "ALG", name: "alpine_grassland", jp: "高山草原", color: "#5c663d", category: "alpine", elevation: 2500, temp: "cold", humidity: "mid", relief: "rolling", colorFamily: "alpine_grass", note: "森林限界上の草地" },
  { code: "ALT", name: "alpine_tundra", jp: "高山ツンドラ", color: "#7e8c54", category: "alpine", elevation: 3000, temp: "cold", humidity: "dry", relief: "rolling", colorFamily: "alpine_grass", note: "高山の凍土帯" },
  { code: "SNM", name: "snowy_mtn", jp: "雪の山岳", color: "#c4c7ca", category: "alpine", elevation: 3500, temp: "cold", humidity: "mid", relief: "peak", colorFamily: "mountain_snowpeak", note: "万年雪の高峰" },
  { code: "AFF", name: "alpine_fell", jp: "高山荒原", color: "#acb889", category: "alpine", elevation: 3800, temp: "cold", humidity: "dry", relief: "rolling", colorFamily: "alpine_grass", note: "低木もまばらな高山の荒地" },
  { code: "CHL", name: "cold_highland", jp: "寒冷高原", color: "#c1c9a6", category: "alpine", elevation: 4200, temp: "cold", humidity: "dry", relief: "flat", colorFamily: "alpine_grass", note: "広く平坦な乾いた高地" },
  { code: "HMT", name: "high_mountain", jp: "高山", color: "#d1d4d6", category: "alpine", elevation: 4800, temp: "cold", humidity: "mid", relief: "rugged", colorFamily: "mountain_snowpeak", note: "雪を頂く高標高の山地" },
  { code: "PSN", name: "permanent_snow", jp: "万年雪冠", color: "#d6d9db", category: "alpine", elevation: 5500, temp: "cold", humidity: "wet", relief: "peak", colorFamily: "mountain_snowpeak", note: "一年中溶けない雪を頂く峰" },
  { code: "XPK", name: "extreme_peak", jp: "超高山峰", color: "#e4e6e7", category: "alpine", elevation: 6800, temp: "cold", humidity: "dry", relief: "peak", colorFamily: "mountain_snowpeak", note: "空気の薄い超高標高の峰" },
  { code: "HIM", name: "himalaya", jp: "極高山・ヒマラヤ", color: "#f4f5f5", category: "alpine", elevation: 8500, temp: "cold", humidity: "dry", relief: "peak", colorFamily: "mountain_snowpeak", note: "世界最高クラスの山頂" },
  // 乾燥地
  { code: "DEP", name: "depression", jp: "海面下盆地", color: "#be9c37", category: "arid", elevation: -200, temp: "hot", humidity: "dry", relief: "flat", colorFamily: "arid_warm", note: "海面より低い乾いた盆地" },
  { code: "DSR", name: "desert", jp: "砂漠", color: "#cdae51", category: "arid", elevation: 200, temp: "hot", humidity: "dry", relief: "rolling", colorFamily: "arid_warm", note: "砂の乾燥地" },
  { code: "THN", name: "thorn_scrub", jp: "半乾燥低木", color: "#d0b35d", category: "arid", elevation: 400, temp: "hot", humidity: "dry", relief: "flat", colorFamily: "arid_warm", note: "棘のある低木がまばらな乾燥地" },
  { code: "DPL", name: "dry_plateau", jp: "乾燥高原", color: "#dec98c", category: "arid", elevation: 1000, temp: "temperate", humidity: "dry", relief: "rolling", colorFamily: "arid_warm", note: "乾いた高原" },
  { code: "CDS", name: "cold_desert", jp: "寒冷砂漠", color: "#7e6144", category: "arid", elevation: 1000, temp: "cold", humidity: "dry", relief: "rolling", colorFamily: "arid_cold", note: "寒冷で乾いた砂礫の大地" },
  { code: "HDS", name: "highland_desert", jp: "高地砂漠", color: "#e8dab0", category: "arid", elevation: 1500, temp: "temperate", humidity: "dry", relief: "rolling", colorFamily: "arid_warm", note: "標高の高い砂漠" },
  { code: "CDM", name: "montane_cold_desert", jp: "山地寒冷砂漠", color: "#b18f6d", category: "arid", elevation: 2200, temp: "cold", humidity: "dry", relief: "rolling", colorFamily: "arid_cold", note: "斜面に広がる寒冷な乾燥地" },
  { code: "CDH", name: "high_cold_desert", jp: "高地寒冷砂漠", color: "#cdb7a2", category: "arid", elevation: 3200, temp: "cold", humidity: "dry", relief: "flat", colorFamily: "arid_cold", note: "標高の高い乾いた不毛の大地" },
  { code: "SLT", name: "salt_flat", jp: "塩原", color: "#cdb8a2", category: "arid", elevation: 3600, temp: "cold", humidity: "dry", relief: "flat", colorFamily: "arid_cold", note: "塩の結晶が広がる乾いた平地" },
  // 寒冷・氷雪
  { code: "PLR", name: "polar_desert", jp: "極地砂漠", color: "#91c5ca", category: "frozen", elevation: 100, temp: "cold", humidity: "dry", relief: "flat", colorFamily: "ice_flat", note: "雪の少ない極地の裸地" },
  { code: "SNW", name: "snowfield", jp: "雪原", color: "#94c7cc", category: "frozen", elevation: 300, temp: "cold", humidity: "mid", relief: "flat", colorFamily: "ice_flat", note: "積雪した平地" },
  { code: "TND", name: "tundra", jp: "ツンドラ", color: "#98c9cd", category: "frozen", elevation: 400, temp: "cold", humidity: "dry", relief: "flat", colorFamily: "ice_flat", note: "低地の凍土帯" },
  { code: "ICE", name: "ice_sheet", jp: "氷床", color: "#9bcbcf", category: "frozen", elevation: 500, temp: "cold", humidity: "wet", relief: "flat", colorFamily: "ice_flat", note: "極地を覆う分厚い氷の層" },
  { code: "IFD", name: "icefield", jp: "氷原", color: "#acd4d7", category: "frozen", elevation: 1200, temp: "cold", humidity: "wet", relief: "rolling", colorFamily: "ice_flat", note: "起伏のある氷の広がり" },
  { code: "GLC", name: "glacier", jp: "氷河", color: "#a6b9c9", category: "frozen", elevation: 2000, temp: "cold", humidity: "wet", relief: "rugged", colorFamily: "glacier", note: "氷の大地" },
  { code: "IDM", name: "ice_dome", jp: "氷冠高原", color: "#e3f1f2", category: "frozen", elevation: 3500, temp: "cold", humidity: "wet", relief: "flat", colorFamily: "ice_flat", note: "高く平らな氷の高原" },
  { code: "HGL", name: "high_glacier", jp: "高地氷河", color: "#ccd7e0", category: "frozen", elevation: 4500, temp: "cold", humidity: "wet", relief: "rugged", colorFamily: "glacier", note: "高標高に広がる険しい氷河" },
  // 湿地
  { code: "WET", name: "wetland", jp: "湿地", color: "#38756b", category: "wetland", elevation: 50, temp: "temperate", humidity: "wet", relief: "flat", colorFamily: "wetland_mangrove", note: "低地の湿った土地" },
  { code: "MOR", name: "high_moor", jp: "高層湿原", color: "#9fd1c8", category: "wetland", elevation: 1200, temp: "cold", humidity: "wet", relief: "flat", colorFamily: "wetland_mangrove", note: "高地の湿原" },
  // 水辺・海洋
  { code: "TRN", name: "ocean_trench", jp: "海溝", color: "#102437", category: "coastal", elevation: -8000, temp: "cold", humidity: "wet", relief: "rugged", colorFamily: "ocean_deep", note: "深海底の裂け目" },
  { code: "DPO", name: "deep_ocean", jp: "深海", color: "#1e4267", category: "coastal", elevation: -4000, temp: "cold", humidity: "wet", relief: "rolling", colorFamily: "ocean_deep", note: "光の届かない深海底" },
  { code: "SHF", name: "shelf_sea", jp: "浅海・大陸棚", color: "#2c6196", category: "coastal", elevation: -100, temp: "temperate", humidity: "wet", relief: "flat", colorFamily: "ocean_deep", note: "陸に近い浅い海域" },
  { code: "OCN", name: "ocean", jp: "海", color: "#3270ae", category: "coastal", elevation: 0, temp: "temperate", humidity: "wet", relief: "flat", colorFamily: "ocean_deep", note: "海洋" },
  { code: "MNG", name: "mangrove", jp: "マングローブ", color: "#356e65", category: "coastal", elevation: 0, temp: "hot", humidity: "wet", relief: "flat", colorFamily: "wetland_mangrove", note: "熱帯の汽水域に茂る林" },
  { code: "BCH", name: "beach", jp: "浜", color: "#ffe1b2", category: "coastal", elevation: 5, temp: "temperate", humidity: "wet", relief: "flat", colorFamily: "beach", note: "砂浜・海岸線" },
];

// 旧コード → 現行3文字コードの移行表（docs/geo-reproduction-design.md 付録A準拠）。
// - 1文字: 旧形式マップ（1セル=1文字）
// - 3文字: 廃止コード（例: ISL 南国の島 → 2026-07-14 廃止。既存 geo_biome_world_*.json 互換）
const LEGACY_CODE_MAP = {
  T: "TWN", P: "PLN", Y: "MDW", V: "SAV", A: "PLT",
  R: "FOR", F: "WDH", 1: "SUB", C: "TGA", H: "CTG",
  J: "JGL", G: "MJG", M: "MTN", K: "VOL", L: "RPL", E: "MSA",
  3: "ALG", 4: "ALT", X: "SNM",
  D: "DSR", Q: "DPL", Z: "HDS",
  S: "SNW", I: "GLC", U: "TND",
  W: "WET", 2: "MOR",
  O: "OCN", B: "BCH", N: "JGL",
  // 廃止3文字コード（旧「南国の島」。旧1文字 N と同じく平地ジャングルへ）
  ISL: "JGL",
};

const biomeByCode = new Map(BIOMES.map((biome) => [biome.code, biome]));
const biomeByColor = new Map(BIOMES.map((biome) => [biome.color.toLowerCase(), biome]));

// ---- 地理圏レイヤー(レイヤー2 / zone_map)。docs/zone-layer-spec.md v0.3(30圏) ----
// 未塗り陸セルのセンチネル(固定3文字を保つことで既存の行シリアライズ/undo/autosaveを流用)。
const ZONE_UNPAINTED = "___";
const ZONES = [
  // 北米
  { code: "NEW", jp: "西部北米", color: "#e6194b", group: "北米" },
  { code: "NEE", jp: "東部北米", color: "#f03e5e", group: "北米" },
  // 中米・カリブ
  { code: "PAN", jp: "中米", color: "#fabed4", group: "中米・カリブ" },
  { code: "CAR", jp: "カリブ諸島", color: "#ff8fb0", group: "中米・カリブ" },
  // 南米
  { code: "AMZ", jp: "アマゾン・ギアナ", color: "#ffe119", group: "南米" },
  { code: "AND", jp: "アンデス高地", color: "#b5532a", group: "南米" },
  { code: "CHC", jp: "チャコ・セラード", color: "#e6a83a", group: "南米" },
  { code: "PAT", jp: "パンパ・パタゴニア", color: "#7fb0a3", group: "南米" },
  // アフリカ
  { code: "AFW", jp: "中央西アフリカ", color: "#9a6324", group: "アフリカ" },
  { code: "AFE", jp: "東アフリカ", color: "#b87333", group: "アフリカ" },
  { code: "AFS", jp: "南部アフリカ", color: "#7a4a15", group: "アフリカ" },
  { code: "MDG", jp: "マダガスカル", color: "#808000", group: "アフリカ" },
  // 砂漠帯
  { code: "SAH", jp: "サハラ", color: "#f58231", group: "砂漠帯" },
  { code: "ARB", jp: "アラビア・イラン", color: "#d96a1a", group: "砂漠帯" },
  // 欧州
  { code: "EUR", jp: "欧州", color: "#3cb44b", group: "欧州" },
  { code: "MED", jp: "地中海", color: "#6abf5a", group: "欧州" },
  // 中央アジア
  { code: "SIB", jp: "シベリア", color: "#469990", group: "中央アジア" },
  { code: "CAS", jp: "中央アジア", color: "#2f7d76", group: "中央アジア" },
  // 東アジア
  { code: "SIN", jp: "中国東部・朝鮮", color: "#4363d8", group: "東アジア" },
  { code: "JPN", jp: "日本", color: "#6a82e8", group: "東アジア" },
  // 南・東南アジア
  { code: "ISU", jp: "インド亜大陸", color: "#35cdf0", group: "南・東南アジア" },
  { code: "IIC", jp: "インドシナ", color: "#17b26e", group: "南・東南アジア" },
  { code: "SUN", jp: "スンダ", color: "#8b57e6", group: "南・東南アジア" },
  { code: "WLC", jp: "ワラセア", color: "#0e6e8c", group: "南・東南アジア" },
  // 豪州・オセアニア
  { code: "AUS", jp: "オーストラリア本土", color: "#f032e6", group: "豪州・オセアニア" },
  { code: "NGU", jp: "ニューギニア", color: "#d020c8", group: "豪州・オセアニア" },
  { code: "NZL", jp: "ニュージーランド", color: "#dcbeff", group: "豪州・オセアニア" },
  { code: "PAC", jp: "太平洋諸島", color: "#c8a0ff", group: "豪州・オセアニア" },
  // 極地
  { code: "ARC", jp: "北極圏", color: "#aaaaaa", group: "極地" },
  { code: "ANT", jp: "南極圏", color: "#eeeeee", group: "極地" },
];
const zoneByCode = new Map(ZONES.map((zone) => [zone.code, zone]));

// 被覆チェック(生息域データは habitat-data.js = draft から生成)
const COV = buildCoverage(HABITAT.species);

// アクティブレイヤー抽象化(A方針: 描画先グリッド+パレットを差し替えて既存コードパスを共用)
function isZoneLayer() {
  return state.activeLayer === "zone";
}
function activeGrid() {
  return isZoneLayer() ? state.zoneGrid : state.grid;
}
function activePalette() {
  return isZoneLayer() ? ZONES : BIOMES;
}
function activeByCode() {
  return isZoneLayer() ? zoneByCode : biomeByCode;
}
function getSelectedCode() {
  return isZoneLayer() ? state.selectedZoneCode : state.selectedCode;
}
function setSelectedCode(code) {
  if (isZoneLayer()) state.selectedZoneCode = code;
  else state.selectedCode = code;
}
function isWaterCell(x, y) {
  return isOceanDeepBiome(biomeByCode.get(state.grid?.[y]?.[x]));
}
// zoneGrid をレイヤー1の寸法に合わせる(重なる範囲は保持・不足は未塗りで補う)。
function ensureZoneGrid() {
  const next = [];
  for (let y = 0; y < state.height; y++) {
    const row = [];
    for (let x = 0; x < state.width; x++) {
      const prev = state.zoneGrid?.[y]?.[x];
      row.push(zoneByCode.has(prev) ? prev : ZONE_UNPAINTED);
    }
    next.push(row);
  }
  state.zoneGrid = next;
}

const AUTOSAVE_KEY = "blockland-map-maker-autosave";
const AUTOSAVE_VERSION = 2;
const EYEDROPPER_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><path fill="#fff" stroke="#111" stroke-width="1.2" d="M2 18l2-2 9-9 2 2-9 9H2v-2zm12-11 1.4-1.4a1.4 1.4 0 0 1 2 2L15 9l-2-2z"/></svg>',
)}") 2 18, crosshair`;
const REPLACE_MODES = [
  { value: "touching", label: "面している" },
  { value: "not_touching", label: "面していない" },
  { value: "always", label: "条件なし" },
];
const TOOL_VALUES = new Set(["paint", "fill", "picker", "guide", "pan", "select", "crop"]);
let autosaveTimer = null;

const state = {
  width: 256,
  height: 256,
  grid: [],
  selectedCode: "PLN",
  activeLayer: "biome",
  zoneGrid: [],
  selectedZoneCode: "NEW",
  zoneTransparent: false,
  zoneBiomeFilter: "", // "" = 制限なし。biomeコードを入れるとそのバイオームのセルにのみ塗れる

  coverage: { dead: [], unpainted: [], showDead: false, checked: 0 },
  highlight: new Set(),
  mask: new Set(),
  zoom: 4,
  brushSize: 1,
  tool: "paint",
  isDrawing: false,
  lastCell: null,
  guidePoints: [],
  showGrid: false,
  replaceRules: [],
  replacePreviewActive: false,
  optionKeyHeld: false,
  selection: null,
  selectInteraction: null,
  pendingSelectionEdit: null,
  cropInteraction: null,
  pendingCrop: null,
  undoStack: [],
  redoStack: [],
  panStart: null,
  wrapScrollStart: null,
  isPinching: false,
  lastCanvasPoint: null,
  lastCanvasPointFloat: null,
  aspectRatioLocked: false,
  aspectRatio: 1,
};

const canvas = document.getElementById("mapCanvas");
const ctx = canvas.getContext("2d", { alpha: false });
const guideCanvas = document.getElementById("guideCanvas");
const guideCtx = guideCanvas.getContext("2d");
const wrap = document.getElementById("canvasWrap");
const brushCursor = document.getElementById("brushCursor");

const els = {
  mapInfo: document.getElementById("mapInfo"),
  cursorInfo: document.getElementById("cursorInfo"),
  selectedInfo: document.getElementById("selectedInfo"),
  message: document.getElementById("message"),
  paletteList: document.getElementById("paletteList"),
  paletteHeading: document.getElementById("paletteHeading"),
  paletteHint: document.getElementById("paletteHint"),
  layerBiomeBtn: document.getElementById("layerBiomeBtn"),
  layerZoneBtn: document.getElementById("layerZoneBtn"),
  zoneTransRow: document.getElementById("zoneTransRow"),
  zoneTransToggle: document.getElementById("zoneTransToggle"),
  zoneFilterRow: document.getElementById("zoneFilterRow"),
  zoneBiomeFilter: document.getElementById("zoneBiomeFilter"),
  exportZoneJsonBtn: document.getElementById("exportZoneJsonBtn"),
  importZoneInput: document.getElementById("importZoneInput"),
  exportMapSetBtn: document.getElementById("exportMapSetBtn"),
  exportMapSetAsBtn: document.getElementById("exportMapSetAsBtn"),
  importMapSetBtn: document.getElementById("importMapSetBtn"),
  importMapSetInput: document.getElementById("importMapSetInput"),
  blmapPathInfo: document.getElementById("blmapPathInfo"),
  coveragePanel: document.getElementById("coveragePanel"),
  coverageCheckBtn: document.getElementById("coverageCheckBtn"),
  coverageFixBtn: document.getElementById("coverageFixBtn"),
  coverageShowToggle: document.getElementById("coverageShowToggle"),
  coverageResult: document.getElementById("coverageResult"),
  toolField: document.getElementById("toolField"),
  brushSizeField: document.getElementById("brushSizeField"),
  brushSizeLabel: document.getElementById("brushSizeLabel"),
  zoomRange: document.getElementById("zoomRange"),
  zoomLabel: document.getElementById("zoomLabel"),
  noiseRadius: document.getElementById("noiseRadius"),
  noiseRadiusLabel: document.getElementById("noiseRadiusLabel"),
  noiseDensity: document.getElementById("noiseDensity"),
  noiseDensityLabel: document.getElementById("noiseDensityLabel"),
  noiseJitter: document.getElementById("noiseJitter"),
  noiseJitterLabel: document.getElementById("noiseJitterLabel"),
  showGridToggle: document.getElementById("showGridToggle"),
  replaceRulesList: document.getElementById("replaceRulesList"),
  importScale: document.getElementById("importScale"),
  canvasWidthInput: document.getElementById("canvasWidthInput"),
  canvasHeightInput: document.getElementById("canvasHeightInput"),
  canvasSizeCurrent: document.getElementById("canvasSizeCurrent"),
  aspectLockBtn: document.getElementById("aspectLockBtn"),
  selectionConfirmActions: document.getElementById("selectionConfirmActions"),
  selectionConfirmBtn: document.getElementById("selectionConfirmBtn"),
  selectionCancelBtn: document.getElementById("selectionCancelBtn"),
};

function hexToRgb(hex) {
  const value = hex.replace("#", "");
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

function rgbToHex(r, g, b) {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

const paletteRgb = BIOMES.map((biome) => ({ ...biome, rgb: hexToRgb(biome.color) }));

function nearestBiome(r, g, b) {
  let best = paletteRgb[0];
  let bestDistance = Infinity;
  for (const biome of paletteRgb) {
    const dr = r - biome.rgb.r;
    const dg = g - biome.rgb.g;
    const db = b - biome.rgb.b;
    const distance = dr * dr + dg * dg + db * db;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = biome;
    }
  }
  return best;
}

function mapDims() {
  return { width: state.width, height: state.height };
}

function createGrid(width, height = width, code = "OCN") {
  return Array.from({ length: height }, () => Array.from({ length: width }, () => code));
}

function upscaleGrid(grid, factor) {
  const sourceH = grid.length;
  const sourceW = grid[0].length;
  const next = createGrid(sourceW * factor, sourceH * factor, "OCN");
  for (let sy = 0; sy < sourceH; sy++) {
    for (let sx = 0; sx < sourceW; sx++) {
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

function downscaleGrid(grid, factor) {
  const sourceH = grid.length;
  const sourceW = grid[0].length;
  const targetW = sourceW / factor;
  const targetH = sourceH / factor;
  const next = createGrid(targetW, targetH, "OCN");
  for (let ty = 0; ty < targetH; ty++) {
    for (let tx = 0; tx < targetW; tx++) {
      next[ty][tx] = grid[ty * factor][tx * factor];
    }
  }
  return next;
}

function applyImportScale(grid, scaleMode) {
  const height = grid.length;
  const width = grid[0].length;
  if (scaleMode === "2") {
    return { grid: upscaleGrid(grid, 2), width: width * 2, height: height * 2 };
  }
  if (scaleMode === "half") {
    if (width % 2 !== 0 || height % 2 !== 0) {
      throw new Error("半分に縮小するには幅・高さが偶数である必要があります");
    }
    return { grid: downscaleGrid(grid, 2), width: width / 2, height: height / 2 };
  }
  return { grid, width, height };
}

function biomeSelectOptions(selectedCode = "PLN") {
  return BIOMES.map(
    (biome) => `<option value="${biome.code}"${biome.code === selectedCode ? " selected" : ""}>${biome.jp}</option>`,
  ).join("");
}

function isOceanDeepBiome(biome) {
  return Boolean(biome && biome.colorFamily === "ocean_deep");
}

function isOceanDeepCode(code) {
  return isOceanDeepBiome(biomeByCode.get(code));
}

function getReplaceMatchContext() {
  const familyCodes = new Map();
  for (const biome of BIOMES) {
    if (!familyCodes.has(biome.colorFamily)) familyCodes.set(biome.colorFamily, new Set());
    familyCodes.get(biome.colorFamily).add(biome.code);
  }
  const landCodes = new Set(BIOMES.filter((biome) => !isOceanDeepBiome(biome)).map((biome) => biome.code));
  return { familyCodes, landCodes };
}

function replaceSelectorOptions(selectedValue = "PLN") {
  const groupOptions = [
    `<option value="${LAND_SELECTOR}"${selectedValue === LAND_SELECTOR ? " selected" : ""}>陸地全て</option>`,
    ...biomesGroupedByColorFamily().map(
      (group) => {
        const value = makeFamilySelector(group.key);
        return `<option value="${value}"${selectedValue === value ? " selected" : ""}>${group.label} 全て</option>`;
      },
    ),
  ].join("");
  return [
    `<optgroup label="まとめて">${groupOptions}</optgroup>`,
    `<optgroup label="個別">${biomeSelectOptions(selectedValue)}</optgroup>`,
  ].join("");
}

function replaceTargetOptions(selectedCode = "PLN") {
  return [
    `<option value="${ADJACENT_REPLACE_TARGET}"${selectedCode === ADJACENT_REPLACE_TARGET ? " selected" : ""}>面したバイオーム</option>`,
    biomeSelectOptions(selectedCode),
  ].join("");
}

function normalizeReplaceRule(rule) {
  if (!rule || typeof rule !== "object") return null;
  const mode = REPLACE_MODES.some((item) => item.value === rule.mode) ? rule.mode : "touching";

  const normalizeSelector = (raw, fallback) => {
    if (raw === LAND_SELECTOR) return LAND_SELECTOR;
    if (typeof raw === "string" && isFamilySelector(raw) && COLOR_FAMILIES[familyKeyFromSelector(raw)]) {
      return raw;
    }
    const migrated = migrateLegacyCode(raw);
    return biomeByCode.has(migrated) ? migrated : fallback;
  };

  const rawTo = rule.to === ADJACENT_REPLACE_TARGET ? ADJACENT_REPLACE_TARGET : migrateLegacyCode(rule.to);
  const from = normalizeSelector(rule.from, "BCH");
  const to = rawTo === ADJACENT_REPLACE_TARGET || biomeByCode.has(rawTo) ? rawTo : "PLN";
  const adjacent = normalizeSelector(rule.adjacent, "OCN");
  return { mode, adjacent, from, to };
}

function createReplaceRule() {
  return { mode: "touching", adjacent: "OCN", from: "BCH", to: "PLN" };
}

function labelForReplaceSelector(selector) {
  if (selector === LAND_SELECTOR) return "陸地全て";
  if (isFamilySelector(selector)) {
    const family = COLOR_FAMILIES[familyKeyFromSelector(selector)];
    return family ? `${family.jp} 全て` : selector;
  }
  return biomeByCode.get(selector)?.jp ?? selector;
}

function setMessage(text) {
  els.message.textContent = text;
}

function serializeAutosave() {
  sanitizeStateGrid();
  return {
    version: AUTOSAVE_VERSION,
    width: state.width,
    height: state.height,
    size: state.width === state.height ? state.width : undefined,
    rows: state.grid.map((row) => row.join("")),
    selectedCode: state.selectedCode,
    activeLayer: state.activeLayer,
    selectedZoneCode: state.selectedZoneCode,
    zoneRows: (state.zoneGrid.length ? state.zoneGrid : []).map((row) => row.join("")),
    highlight: [...state.highlight],
    mask: [...state.mask],
    zoom: state.zoom,
    brushSize: state.brushSize,
    tool: state.tool,
    guidePoints: state.guidePoints,
    showGrid: state.showGrid,
    replaceRules: state.replaceRules,
    noiseRadius: Number(els.noiseRadius.value),
    noiseDensity: Number(els.noiseDensity.value),
    noiseJitter: Number(els.noiseJitter.value),
  };
}

function saveAutosave() {
  try {
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(serializeAutosave()));
    return true;
  } catch (error) {
    console.warn("autosave failed", error);
    if (error instanceof DOMException && error.name === "QuotaExceededError") {
      setMessage("オートセーブ失敗: 保存容量の上限に達しました");
    }
    return false;
  }
}

function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(saveAutosave, 400);
}

function flushAutosave() {
  clearTimeout(autosaveTimer);
  saveAutosave();
}

function isLegacyJungleIsleLegend(legend) {
  const entry = legend?.G;
  if (!entry) return false;
  return entry.name === "jungle_isle" || entry.jp === "ジャングル島";
}

function isLegacyVolcanoIsleLegend(legend) {
  const entry = legend?.R;
  if (!entry) return false;
  return entry.name === "volcano_isle" || entry.jp === "火山島" || entry.jp === "火山島(旧互換)";
}

function normalizeBiomeCode(code, { legacyJungleIsle = false, legacyVolcanoIsle = false } = {}) {
  if (legacyJungleIsle && code === "G") return "J";
  if (legacyVolcanoIsle && code === "R") return "K";
  return code;
}

// 旧1文字コードを新3文字コードへ移行する（新形式のコードはそのまま通過する）。
function migrateLegacyCode(code, options = {}) {
  const fixed = normalizeBiomeCode(code, options);
  return LEGACY_CODE_MAP[fixed] ?? fixed;
}

function normalizeRows(rows, options = {}) {
  const geometry = options.geometry || detectMapGeometry(rows);
  if (!geometry) return null;
  const { cellWidth } = geometry;

  const normalizedRows = [];
  for (const row of rows) {
    const rawCodes = cellWidth === 1 ? row.split("") : chunkString(row, 3);
    let normalizedRow = "";
    for (const rawCode of rawCodes) {
      const code = migrateLegacyCode(rawCode, options);
      if (!biomeByCode.has(code)) return null;
      normalizedRow += code;
    }
    normalizedRows.push(normalizedRow);
  }
  return normalizedRows;
}

function tryRecoverMixedRows(rows, data, options = {}) {
  return recoverMixedCodeRows(rows, {
    width: data?.width,
    height: data?.height,
    validCodes: biomeByCode.keys(),
    legacyCodes: Object.keys(LEGACY_CODE_MAP),
    migrateCode: (code) => migrateLegacyCode(code, options),
  });
}

// normalizeRows が返す行文字列は常に新形式（3文字/マス）。グリッド配列へ分解する。
function rowsToGrid(rows) {
  return rows.map((row) => chunkString(row, 3));
}

function sanitizeStateGrid() {
  state.grid = sanitizeGridCodes(
    state.grid,
    (code) => migrateLegacyCode(code),
    (code) => biomeByCode.has(code),
    "OCN",
  );
}

function loadAutosave() {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (typeof data.version !== "number" || data.version > AUTOSAVE_VERSION) return false;

    const rows = data.rows;
    if (!Array.isArray(rows) || rows.length === 0) return false;
    let geometry = detectMapGeometry(rows);
    let normalizedRows = geometry ? normalizeRows(rows, { geometry }) : null;
    if (!normalizedRows) {
      const recovered = tryRecoverMixedRows(rows, data);
      if (!recovered) return false;
      geometry = recovered.geometry;
      normalizedRows = recovered.rows;
    }

    state.width = geometry.width;
    state.height = geometry.height;
    state.grid = rowsToGrid(normalizedRows);
    sanitizeStateGrid();
    state.zoneGrid = [];
    ensureZoneGrid();
    if (Array.isArray(data.zoneRows)) {
      for (let y = 0; y < state.height; y++) {
        const row = data.zoneRows[y];
        if (typeof row !== "string") continue;
        for (let x = 0; x < state.width; x++) {
          const code = row.slice(x * 3, x * 3 + 3);
          if (zoneByCode.has(code)) state.zoneGrid[y][x] = code;
        }
      }
    }
    state.selectedZoneCode = zoneByCode.has(data.selectedZoneCode) ? data.selectedZoneCode : "NEW";
    state.activeLayer = data.activeLayer === "zone" ? "zone" : "biome";
    const selectedCode = migrateLegacyCode(data.selectedCode);
    state.selectedCode = biomeByCode.has(selectedCode) ? selectedCode : "PLN";
    state.highlight = new Set(
      Array.isArray(data.highlight)
        ? data.highlight.map((code) => migrateLegacyCode(code)).filter((code) => biomeByCode.has(code))
        : [],
    );
    state.mask = new Set(
      Array.isArray(data.mask)
        ? data.mask.map((code) => migrateLegacyCode(code)).filter((code) => biomeByCode.has(code))
        : [],
    );
    state.zoom = typeof data.zoom === "number" ? Math.min(32, Math.max(1, data.zoom)) : 4;
    state.brushSize = normalizeBrushSize(data.brushSize);
    state.tool = TOOL_VALUES.has(data.tool) ? data.tool : "paint";
    state.guidePoints = Array.isArray(data.guidePoints) ? data.guidePoints : [];
    state.showGrid = Boolean(data.showGrid);
    state.replaceRules = Array.isArray(data.replaceRules)
      ? data.replaceRules.map(normalizeReplaceRule).filter(Boolean)
      : [];
    state.undoStack = [];
    state.redoStack = [];
    state.replacePreviewActive = false;

    els.zoomRange.value = String(state.zoom);
    if (typeof data.noiseRadius === "number") els.noiseRadius.value = String(data.noiseRadius);
    if (typeof data.noiseDensity === "number") els.noiseDensity.value = String(data.noiseDensity);
    if (typeof data.noiseJitter === "number") els.noiseJitter.value = String(data.noiseJitter);
    els.showGridToggle.checked = state.showGrid;
    return true;
  } catch {
    return false;
  }
}

function updateInfo() {
  els.mapInfo.textContent = `${state.width}×${state.height}`;
  if (els.canvasSizeCurrent) {
    els.canvasSizeCurrent.textContent = `${state.width}×${state.height}`;
  }
  const editingSize =
    document.activeElement === els.canvasWidthInput ||
    document.activeElement === els.canvasHeightInput;
  if (els.canvasWidthInput && !editingSize) {
    els.canvasWidthInput.value = String(state.width);
  }
  if (els.canvasHeightInput && !editingSize) {
    els.canvasHeightInput.value = String(state.height);
  }
  if (!editingSize && state.aspectRatioLocked && state.height > 0) {
    state.aspectRatio = state.width / state.height;
  }
  const selectedCode = getSelectedCode();
  const selected = activeByCode().get(selectedCode);
  els.selectedInfo.textContent = selected
    ? `選択: ${selectedCode} ${selected.jp}`
    : `選択: ${selectedCode ?? "-"}`;
  const shape = getBrushShape(state.brushSize);
  els.brushSizeLabel.textContent = `${state.brushSize} (${shape.label})`;
  els.zoomLabel.textContent = `${state.zoom}x`;
  els.noiseRadiusLabel.textContent = els.noiseRadius.value;
  els.noiseDensityLabel.textContent = `${els.noiseDensity.value}%`;
  els.noiseJitterLabel.textContent = els.noiseJitter.value;
}

const CANVAS_INSET = 24;
const pinchZoomActivePointers = new Map();

function touchDistance(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.hypot(dx, dy);
}

function touchMidpoint(touches) {
  return {
    x: (touches[0].clientX + touches[1].clientX) / 2,
    y: (touches[0].clientY + touches[1].clientY) / 2,
  };
}

function bindPinchZoom() {
  let pointerPinchStart = null;
  let touchPinchStart = null;
  let gestureStartZoom = null;
  let trackpadPinchZoom = null;
  let trackpadPinchTimer = null;

  function stopPinch() {
    pointerPinchStart = null;
    touchPinchStart = null;
    gestureStartZoom = null;
    state.isPinching = false;
  }

  function beginPinch() {
    state.isPinching = true;
    state.isDrawing = false;
    state.lastCell = null;
  }

  function isOverCanvasArea(clientX, clientY) {
    const rect = wrap.getBoundingClientRect();
    return clientX >= rect.left && clientX <= rect.right
      && clientY >= rect.top && clientY <= rect.bottom;
  }

  function wheelPinchDelta(event) {
    let delta = -event.deltaY;
    if (event.deltaMode === 1) delta *= 16;
    else if (event.deltaMode === 2) delta *= 800;
    return delta;
  }

  function zoomFromPinch(baseZoom, scale, anchorX, anchorY) {
    if (applyZoom(baseZoom * scale, anchorX, anchorY)) render();
  }

  function resetTrackpadPinch() {
    trackpadPinchZoom = null;
    clearTimeout(trackpadPinchTimer);
  }

  function onWheelPinch(event) {
    const isPinch = event.ctrlKey;
    if (!isPinch) {
      resetTrackpadPinch();
      return;
    }
    if (!isOverCanvasArea(event.clientX, event.clientY)) return;

    event.preventDefault();
    event.stopPropagation();

    if (trackpadPinchZoom == null) trackpadPinchZoom = state.zoom;
    trackpadPinchZoom *= Math.exp(wheelPinchDelta(event) * 0.01);
    if (applyZoom(trackpadPinchZoom, event.clientX, event.clientY)) render();

    clearTimeout(trackpadPinchTimer);
    trackpadPinchTimer = setTimeout(resetTrackpadPinch, 180);
  }

  document.addEventListener("wheel", onWheelPinch, { passive: false, capture: true });

  wrap.addEventListener("gesturestart", (event) => {
    event.preventDefault();
    gestureStartZoom = state.zoom;
    beginPinch();
  }, { passive: false });

  wrap.addEventListener("gesturechange", (event) => {
    event.preventDefault();
    if (gestureStartZoom == null) return;
    zoomFromPinch(gestureStartZoom, event.scale, event.clientX, event.clientY);
  }, { passive: false });

  wrap.addEventListener("gestureend", (event) => {
    event.preventDefault();
    stopPinch();
  }, { passive: false });

  wrap.addEventListener("touchstart", (event) => {
    if (event.touches.length !== 2) return;
    event.preventDefault();
    beginPinch();
    touchPinchStart = {
      distance: touchDistance(event.touches),
      zoom: state.zoom,
    };
  }, { passive: false });

  wrap.addEventListener("touchmove", (event) => {
    if (event.touches.length !== 2 || !touchPinchStart) return;
    event.preventDefault();
    const midpoint = touchMidpoint(event.touches);
    const scale = touchDistance(event.touches) / touchPinchStart.distance;
    zoomFromPinch(touchPinchStart.zoom, scale, midpoint.x, midpoint.y);
  }, { passive: false });

  wrap.addEventListener("touchend", (event) => {
    if (event.touches.length >= 2) return;
    if (touchPinchStart) stopPinch();
  });

  wrap.addEventListener("touchcancel", () => {
    if (touchPinchStart) stopPinch();
  });

  function syncPointerPinch() {
    if (pinchZoomActivePointers.size !== 2) {
      pointerPinchStart = null;
      if (!touchPinchStart && gestureStartZoom == null) state.isPinching = false;
      return;
    }
    const [a, b] = [...pinchZoomActivePointers.values()];
    pointerPinchStart = {
      distance: Math.hypot(a.x - b.x, a.y - b.y),
      zoom: state.zoom,
    };
    beginPinch();
  }

  wrap.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "touch") return;
    pinchZoomActivePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pinchZoomActivePointers.size === 2) syncPointerPinch();
  }, { capture: true });

  wrap.addEventListener("pointermove", (event) => {
    if (event.pointerType === "touch") return;
    if (!pinchZoomActivePointers.has(event.pointerId)) return;
    pinchZoomActivePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pinchZoomActivePointers.size !== 2 || !pointerPinchStart) return;
    event.preventDefault();
    const [a, b] = [...pinchZoomActivePointers.values()];
    const scale = Math.hypot(a.x - b.x, a.y - b.y) / pointerPinchStart.distance;
    const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    zoomFromPinch(pointerPinchStart.zoom, scale, midpoint.x, midpoint.y);
  }, { capture: true });

  function releasePointer(event) {
    if (event.pointerType === "touch") return;
    pinchZoomActivePointers.delete(event.pointerId);
    if (pinchZoomActivePointers.size === 2) syncPointerPinch();
    else if (pointerPinchStart) stopPinch();
  }

  wrap.addEventListener("pointerup", releasePointer, { capture: true });
  wrap.addEventListener("pointercancel", (event) => {
    releasePointer(event);
    pinchZoomActivePointers.delete(event.pointerId);
  }, { capture: true });
}

function applyZoom(nextZoom, anchorClientX, anchorClientY) {
  const clamped = Math.min(32, Math.max(1, Math.round(nextZoom)));
  if (clamped === state.zoom) return false;

  const wrapRect = wrap.getBoundingClientRect();
  const oldZoom = state.zoom;
  const viewX = anchorClientX - wrapRect.left + wrap.scrollLeft;
  const viewY = anchorClientY - wrapRect.top + wrap.scrollTop;
  const mapX = (viewX - CANVAS_INSET) / oldZoom;
  const mapY = (viewY - CANVAS_INSET) / oldZoom;

  state.zoom = clamped;
  els.zoomRange.value = String(state.zoom);
  resizeCanvases(false);

  const newViewX = mapX * state.zoom + CANVAS_INSET;
  const newViewY = mapY * state.zoom + CANVAS_INSET;
  wrap.scrollLeft = Math.max(0, newViewX - (anchorClientX - wrapRect.left));
  wrap.scrollTop = Math.max(0, newViewY - (anchorClientY - wrapRect.top));
  updateInfo();
  return true;
}

function resizeCanvases(centerScroll = true) {
  const pxW = state.width * state.zoom;
  const pxH = state.height * state.zoom;
  canvas.width = pxW;
  canvas.height = pxH;
  canvas.style.width = `${pxW}px`;
  canvas.style.height = `${pxH}px`;
  guideCanvas.width = pxW;
  guideCanvas.height = pxH;
  guideCanvas.style.width = `${pxW}px`;
  guideCanvas.style.height = `${pxH}px`;
  if (centerScroll) {
    wrap.scrollLeft = Math.max(0, (pxW + CANVAS_INSET * 2 - wrap.clientWidth) / 2);
    wrap.scrollTop = Math.max(0, (pxH + CANVAS_INSET * 2 - wrap.clientHeight) / 2);
  }
}

function renderZoneImage(image) {
  // 海=暗くマスク / 未塗り陸=バイオームを淡色下敷き / 塗り済み=地理圏色
  for (let y = 0; y < state.height; y++) {
    for (let x = 0; x < state.width; x++) {
      const biome = biomeByCode.get(state.grid[y][x]) ?? biomeByCode.get("OCN");
      const offset = (y * state.width + x) * 4;
      const zoneCode = state.zoneGrid?.[y]?.[x];
      const zone = zoneByCode.get(zoneCode);
      let r, g, b;
      if (isOceanDeepBiome(biome)) {
        const rgb = hexToRgb(biome.color); // 水域: 暗くマスク
        r = Math.round(rgb.r * 0.35);
        g = Math.round(rgb.g * 0.35);
        b = Math.round(rgb.b * 0.35);
      } else if (zone) {
        const rgb = hexToRgb(zone.color); // 塗り済み陸: 地理圏色
        if (state.zoneTransparent) {
          // 透過: バイオーム(レイヤー1)を透かして重ねる
          const bm = hexToRgb(biome.color);
          r = Math.round(rgb.r * 0.5 + bm.r * 0.5);
          g = Math.round(rgb.g * 0.5 + bm.g * 0.5);
          b = Math.round(rgb.b * 0.5 + bm.b * 0.5);
        } else {
          r = rgb.r; g = rgb.g; b = rgb.b;
        }
      } else {
        const rgb = hexToRgb(biome.color); // 未塗り陸: 淡色下敷き
        r = Math.round(rgb.r * 0.5 + 128 * 0.5);
        g = Math.round(rgb.g * 0.5 + 128 * 0.5);
        b = Math.round(rgb.b * 0.5 + 128 * 0.5);
      }
      image.data[offset] = r;
      image.data[offset + 1] = g;
      image.data[offset + 2] = b;
      image.data[offset + 3] = 255;
    }
  }
}

function render() {
  const image = ctx.createImageData(state.width, state.height);
  if (isZoneLayer()) {
    renderZoneImage(image);
  } else {
    const activeHighlight = state.highlight.size > 0;
    for (let y = 0; y < state.height; y++) {
      for (let x = 0; x < state.width; x++) {
        const code = state.grid[y][x];
        const biome = biomeByCode.get(code) ?? biomeByCode.get("OCN");
        const rgb = hexToRgb(biome.color);
        const offset = (y * state.width + x) * 4;
        const dim = activeHighlight && !state.highlight.has(code);
        image.data[offset] = dim ? Math.round(rgb.r * 0.32) : rgb.r;
        image.data[offset + 1] = dim ? Math.round(rgb.g * 0.32) : rgb.g;
        image.data[offset + 2] = dim ? Math.round(rgb.b * 0.32) : rgb.b;
        image.data[offset + 3] = 255;
      }
    }
  }
  const offscreen = document.createElement("canvas");
  offscreen.width = state.width;
  offscreen.height = state.height;
  offscreen.getContext("2d").putImageData(image, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(offscreen, 0, 0, canvas.width, canvas.height);
  renderGuide();
  updateInfo();
  scheduleAutosave();
  if (state.lastCanvasPoint) updateBrushCursor(state.lastCanvasPoint);
}

function renderGuide() {
  guideCtx.clearRect(0, 0, guideCanvas.width, guideCanvas.height);
  if (state.showGrid) {
    guideCtx.save();
    guideCtx.strokeStyle = "rgba(255, 255, 255, 0.18)";
    guideCtx.lineWidth = 1;
    const w = state.width * state.zoom;
    const h = state.height * state.zoom;
    const step = state.zoom;
    guideCtx.beginPath();
    for (let x = 0; x <= state.width; x++) {
      const px = x * step + 0.5;
      guideCtx.moveTo(px, 0);
      guideCtx.lineTo(px, h);
    }
    for (let y = 0; y <= state.height; y++) {
      const py = y * step + 0.5;
      guideCtx.moveTo(0, py);
      guideCtx.lineTo(w, py);
    }
    guideCtx.stroke();
    guideCtx.restore();
  }
  renderReplacePreview();
  renderBrushCursor();
  renderSelection();
  renderDeadOverlay();
  renderCropOverlay();
  if (state.guidePoints.length < 2) return;
  guideCtx.save();
  guideCtx.scale(state.zoom, state.zoom);
  guideCtx.strokeStyle = "rgba(255, 50, 210, 0.9)";
  guideCtx.lineWidth = Math.max(1, 2 / state.zoom);
  guideCtx.lineCap = "round";
  guideCtx.lineJoin = "round";
  guideCtx.beginPath();
  guideCtx.moveTo(state.guidePoints[0].x + 0.5, state.guidePoints[0].y + 0.5);
  for (const point of state.guidePoints.slice(1)) {
    guideCtx.lineTo(point.x + 0.5, point.y + 0.5);
  }
  guideCtx.stroke();
  guideCtx.restore();
}

function renderCropOverlay() {
  const rect = getActiveCropRect();
  if (!rect) return;

  const step = state.zoom;
  const px = rect.x0 * step;
  const py = rect.y0 * step;
  const pw = rect.width * step;
  const ph = rect.height * step;
  const fullW = state.width * step;
  const fullH = state.height * step;

  guideCtx.save();
  guideCtx.fillStyle = "rgba(10, 14, 20, 0.55)";
  // dim outside crop rect
  guideCtx.fillRect(0, 0, fullW, py);
  guideCtx.fillRect(0, py, px, ph);
  guideCtx.fillRect(px + pw, py, fullW - px - pw, ph);
  guideCtx.fillRect(0, py + ph, fullW, fullH - py - ph);

  guideCtx.strokeStyle = "rgba(255, 210, 80, 0.95)";
  guideCtx.lineWidth = 2;
  guideCtx.setLineDash([6, 4]);
  guideCtx.strokeRect(px + 1, py + 1, pw - 2, ph - 2);
  guideCtx.setLineDash([]);

  const label = `${rect.width}×${rect.height}`;
  guideCtx.font = "12px sans-serif";
  guideCtx.fillStyle = "rgba(20, 24, 32, 0.85)";
  const textW = guideCtx.measureText(label).width + 10;
  const labelX = Math.min(px + 6, fullW - textW - 4);
  const labelY = Math.max(16, py - 6);
  guideCtx.fillRect(labelX, labelY - 12, textW, 16);
  guideCtx.fillStyle = "#ffe08a";
  guideCtx.fillText(label, labelX + 5, labelY);
  guideCtx.restore();
}

function getReplaceTargetsForRule(rule) {
  return getReplaceTargetsForRuleAt(
    rule,
    state.grid,
    mapDims(),
    (x, y) => canPaint(x, y),
    getReplaceMatchContext(),
  );
}

function collectReplacePreviewCells() {
  return collectReplacePreviewCellsAt(
    state.replaceRules,
    state.grid,
    mapDims(),
    (x, y) => canPaint(x, y),
    getReplaceMatchContext(),
  );
}

function renderReplacePreview() {
  if (!state.replacePreviewActive) return;
  const cells = collectReplacePreviewCells();
  if (!cells.size) return;

  guideCtx.save();
  guideCtx.imageSmoothingEnabled = false;
  const step = state.zoom;
  guideCtx.fillStyle = "rgba(255, 210, 60, 0.5)";
  guideCtx.strokeStyle = "rgba(255, 160, 0, 0.85)";
  guideCtx.lineWidth = 1;
  for (const key of cells) {
    const [x, y] = key.split(",").map(Number);
    const px = x * step;
    const py = y * step;
    guideCtx.fillRect(px, py, step, step);
    if (step > 1) {
      guideCtx.strokeRect(px + 0.5, py + 0.5, step - 1, step - 1);
    }
  }
  guideCtx.restore();
}

function previewReplaceRules() {
  if (!state.replaceRules.length) {
    setMessage("置換ルールがありません");
    return;
  }
  state.replacePreviewActive = true;
  syncCanvasCursor();
  renderGuide();
  const count = collectReplacePreviewCells().size;
  setMessage(count > 0 ? `プレビュー: ${count} マスが置換対象` : "置換対象はありません");
}

function clearReplacePreview() {
  if (!state.replacePreviewActive) return;
  state.replacePreviewActive = false;
  syncCanvasCursor();
  renderGuide();
  setMessage("プレビューを解除しました");
}

function refreshReplacePreviewIfActive() {
  if (!state.replacePreviewActive) return;
  renderGuide();
}

function clearSelection() {
  state.selection = null;
  state.selectInteraction = null;
  clearPendingSelectionEdit({ silent: true });
  clearPendingCrop({ silent: true });
}

function syncSelectionConfirmUi() {
  if (!els.selectionConfirmActions) return;
  els.selectionConfirmActions.hidden = !(state.pendingSelectionEdit || state.pendingCrop);
}

function clearPendingSelectionEdit({ silent = false } = {}) {
  if (!state.pendingSelectionEdit) {
    syncSelectionConfirmUi();
    return;
  }
  state.pendingSelectionEdit = null;
  syncSelectionConfirmUi();
  if (!silent) setMessage("変形をキャンセルしました");
}

function setPendingSelectionEdit(edit) {
  clearPendingCrop({ silent: true });
  state.pendingSelectionEdit = edit;
  syncSelectionConfirmUi();
  setMessage("変形を確認: ○で確定、×でキャンセル");
}

function normalizeCropRect(a, b) {
  const x0 = Math.max(0, Math.min(state.width - 1, Math.min(a.x, b.x)));
  const x1 = Math.max(0, Math.min(state.width - 1, Math.max(a.x, b.x)));
  const y0 = Math.max(0, Math.min(state.height - 1, Math.min(a.y, b.y)));
  const y1 = Math.max(0, Math.min(state.height - 1, Math.max(a.y, b.y)));
  return {
    x0,
    y0,
    x1,
    y1,
    width: x1 - x0 + 1,
    height: y1 - y0 + 1,
  };
}

function getActiveCropRect() {
  if (state.cropInteraction) {
    return normalizeCropRect(state.cropInteraction.start, state.cropInteraction.current);
  }
  return state.pendingCrop;
}

function clearPendingCrop({ silent = false } = {}) {
  if (!state.pendingCrop && !state.cropInteraction) {
    syncSelectionConfirmUi();
    return;
  }
  state.pendingCrop = null;
  state.cropInteraction = null;
  syncSelectionConfirmUi();
  if (!silent) setMessage("切り取りをキャンセルしました");
}

function restorePaintToolAfterCrop() {
  if (state.tool === "crop") {
    state.tool = "paint";
    syncToolUi();
  }
}

function setPendingCrop(rect) {
  clearPendingSelectionEdit({ silent: true });
  state.pendingCrop = rect;
  syncSelectionConfirmUi();
  setMessage(`切り取り確認 ${rect.width}×${rect.height}: ○で確定、×でキャンセル`);
}

function cancelPendingCrop() {
  if (!state.pendingCrop && !state.cropInteraction) return;
  clearPendingCrop();
  restorePaintToolAfterCrop();
  renderGuide();
}

function confirmPendingCrop() {
  const rect = state.pendingCrop;
  if (!rect) return;
  if (rect.width === state.width && rect.height === state.height && rect.x0 === 0 && rect.y0 === 0) {
    clearPendingCrop({ silent: true });
    restorePaintToolAfterCrop();
    setMessage("キャンバス全体と同じため切り取りませんでした");
    renderGuide();
    return;
  }
  state.pendingCrop = null;
  state.cropInteraction = null;
  syncSelectionConfirmUi();
  pushUndo();
  const prevZone = state.zoneGrid;
  const cropped = cropGridToRect(state.grid, rect);
  const zoneCropped =
    prevZone?.length === state.height && prevZone[0]?.length === state.width
      ? cropGridToRect(prevZone, rect)
      : null;
  state.grid = cropped.grid;
  state.width = cropped.width;
  state.height = cropped.height;
  state.zoneGrid = zoneCropped?.grid ?? [];
  ensureZoneGrid();
  clearSelection();
  restorePaintToolAfterCrop();
  resizeCanvases();
  render();
  setMessage(`切り取り: ${cropped.width}×${cropped.height}`);
  flushAutosave();
}

function cancelPendingAction() {
  if (state.pendingCrop || state.cropInteraction) {
    cancelPendingCrop();
    return;
  }
  cancelPendingSelectionEdit();
}

function confirmPendingAction() {
  if (state.pendingCrop) {
    confirmPendingCrop();
    return;
  }
  confirmPendingSelectionEdit();
}

function getWorkingSelection() {
  if (!state.selection) return null;
  if (state.pendingSelectionEdit?.cells) {
    return {
      cells: state.pendingSelectionEdit.cells,
      entries: state.pendingSelectionEdit.entries,
    };
  }
  return state.selection;
}

function bakePendingFromDisplayed() {
  if (!state.selection) {
    clearPendingSelectionEdit({ silent: true });
    return;
  }
  const cells = getDisplayedSelectionCells();
  if (!cells?.size) {
    clearPendingSelectionEdit({ silent: true });
    return;
  }
  if (selectionMapsEqual(cells, state.selection.cells)) {
    clearPendingSelectionEdit({ silent: true });
    return;
  }
  setPendingSelectionEdit({
    cells: new Map(cells),
    entries: entriesFromCells(cells),
  });
}

function cancelPendingSelectionEdit() {
  if (!state.pendingSelectionEdit) return;
  clearPendingSelectionEdit();
  renderGuide();
}

function confirmPendingSelectionEdit() {
  const pending = state.pendingSelectionEdit;
  if (!pending?.cells || !state.selection) return;
  state.pendingSelectionEdit = null;
  syncSelectionConfirmUi();
  pushUndo();
  const result = applySelectionContentReplace(
    state.grid,
    state.selection.cells,
    pending.cells,
    mapDims(),
    (x, y) => canPaint(x, y),
  );
  state.grid = result.grid;
  state.selection.cells = result.cells;
  state.selection.entries = entriesFromCells(result.cells);
  render();
  const parts = [`変形を確定: ${result.moved} マス`];
  if (result.gapFilled > 0) parts.push(`隙間 ${result.gapFilled} マスを周囲で補完`);
  if (result.sourceFilled > 0) parts.push(`元位置 ${result.sourceFilled} マスを周囲で補完`);
  if (result.stayed > 0) parts.push(`${result.stayed} マスは移動不可`);
  setMessage(parts.join("、"));
  flushAutosave();
}

function isCellSelected(x, y) {
  return Boolean(state.selection?.cells.has(`${x},${y}`));
}

function isDisplayedCellSelected(x, y) {
  const cells = getDisplayedSelectionCells();
  return Boolean(cells?.has(`${x},${y}`));
}

function isSelectionTransforming() {
  const type = state.selectInteraction?.type;
  return Boolean(
    state.pendingSelectionEdit ||
      type === "move" ||
      type === "rotate" ||
      type === "scale",
  );
}

function finalizeLasso(points) {
  const keys = cellsInsidePolygon(points, mapDims());
  if (!keys.length) {
    setMessage("選択範囲がありません");
    return;
  }
  const cells = buildSelectionCells(keys, state.grid);
  state.selection = {
    cells,
    entries: entriesFromCells(cells),
  };
  setMessage(`選択: ${keys.length} マス`);
}

function commitSelectionMove(dx, dy) {
  if (!state.selection || (dx === 0 && dy === 0)) return;

  pushUndo();
  const result = applySelectionMove(
    state.grid,
    state.selection.cells,
    dx,
    dy,
    mapDims(),
    (x, y) => canPaint(x, y),
  );
  state.grid = result.grid;
  state.selection.cells = result.cells;
  state.selection.entries = entriesFromCells(result.cells);
  render();
  const parts = [`移動: ${result.moved} マス`];
  if (result.sourceFilled > 0) parts.push(`元位置 ${result.sourceFilled} マスを周囲で補完`);
  if (result.stayed > 0) parts.push(`${result.stayed} マスは移動不可`);
  setMessage(parts.join("、"));
}

function getDisplayedSelectionCells() {
  if (!state.selection) return null;
  const working = getWorkingSelection();

  if (state.selectInteraction?.type === "rotate") {
    const { angle, center, baseEntries } = state.selectInteraction;
    if (angle !== 0 && center) {
      return cellsFromEntries(rotateEntries(baseEntries, center.cx, center.cy, angle));
    }
    return cellsFromEntries(baseEntries);
  }
  if (state.selectInteraction?.type === "scale") {
    const { scale, baseEntries } = state.selectInteraction;
    if (scale && (scale.scaleX !== 1 || scale.scaleY !== 1)) {
      return cellsFromEntries(
        scaleEntries(baseEntries, scale.anchorX, scale.anchorY, scale.scaleX, scale.scaleY),
      );
    }
    return cellsFromEntries(baseEntries);
  }
  if (state.selectInteraction?.type === "move") {
    const { offset, baseCells } = state.selectInteraction;
    if (!offset || (offset.dx === 0 && offset.dy === 0)) return baseCells;
    const display = new Map();
    for (const [key, code] of baseCells) {
      const [x, y] = key.split(",").map(Number);
      display.set(`${x + offset.dx},${y + offset.dy}`, code);
    }
    return display;
  }

  return working.cells;
}

function renderSelectionBox() {
  if (!state.selection || state.selectInteraction?.type === "lasso") return;
  const geometry = getSelectionBoxGeometry();
  if (!geometry) return;

  const step = state.zoom;
  guideCtx.save();
  guideCtx.strokeStyle = "rgba(100, 180, 255, 0.95)";
  guideCtx.fillStyle = "rgba(255, 255, 255, 0.95)";
  guideCtx.lineWidth = 1.5;
  guideCtx.beginPath();
  guideCtx.moveTo(geometry.corners[0].x * step, geometry.corners[0].y * step);
  for (const corner of geometry.corners.slice(1)) {
    guideCtx.lineTo(corner.x * step, corner.y * step);
  }
  guideCtx.closePath();
  guideCtx.stroke();

  const handleSize = Math.max(7, step * 0.4);
  const drawHandle = (handle) => {
    const hx = handle.x * step;
    const hy = handle.y * step;
    guideCtx.fillRect(hx - handleSize / 2, hy - handleSize / 2, handleSize, handleSize);
    guideCtx.strokeRect(hx - handleSize / 2 + 0.5, hy - handleSize / 2 + 0.5, handleSize - 1, handleSize - 1);
  };
  for (const corner of geometry.corners) drawHandle(corner);
  for (const edge of geometry.edges) drawHandle(edge);
  guideCtx.restore();
}

function renderSelection() {
  if (state.selectInteraction?.type === "lasso" && state.selectInteraction.points.length >= 2) {
    guideCtx.save();
    guideCtx.scale(state.zoom, state.zoom);
    guideCtx.strokeStyle = "rgba(100, 180, 255, 0.95)";
    guideCtx.lineWidth = Math.max(1, 2 / state.zoom);
    guideCtx.lineCap = "round";
    guideCtx.lineJoin = "round";
    guideCtx.setLineDash([4, 3]);
    guideCtx.beginPath();
    const first = state.selectInteraction.points[0];
    guideCtx.moveTo(first.x + 0.5, first.y + 0.5);
    for (const point of state.selectInteraction.points.slice(1)) {
      guideCtx.lineTo(point.x + 0.5, point.y + 0.5);
    }
    guideCtx.stroke();
    guideCtx.restore();
  }

  const cells = getDisplayedSelectionCells();
  if (!cells?.size) return;

  guideCtx.save();
  guideCtx.imageSmoothingEnabled = false;
  const step = state.zoom;
  const transforming = isSelectionTransforming();

  if (transforming && state.selection) {
    for (const key of state.selection.cells.keys()) {
      if (cells.has(key)) continue;
      const [x, y] = key.split(",").map(Number);
      if (x < 0 || y < 0 || x >= state.width || y >= state.height) continue;
      guideCtx.fillStyle = "rgba(18, 22, 30, 0.72)";
      guideCtx.fillRect(x * step, y * step, step, step);
    }
    for (const [key, code] of cells) {
      const [x, y] = key.split(",").map(Number);
      if (x < 0 || y < 0 || x >= state.width || y >= state.height) continue;
      const biome = biomeByCode.get(code) ?? biomeByCode.get("OCN");
      guideCtx.fillStyle = biome.color;
      guideCtx.fillRect(x * step, y * step, step, step);
    }
  }

  guideCtx.fillStyle = "rgba(100, 180, 255, 0.28)";
  guideCtx.strokeStyle = "rgba(100, 180, 255, 0.95)";
  guideCtx.lineWidth = 1;
  for (const key of cells.keys()) {
    const [x, y] = key.split(",").map(Number);
    if (x < 0 || y < 0 || x >= state.width || y >= state.height) continue;
    const px = x * step;
    const py = y * step;
    guideCtx.fillRect(px, py, step, step);
    if (step > 1) {
      guideCtx.strokeRect(px + 0.5, py + 0.5, step - 1, step - 1);
    }
  }
  guideCtx.restore();
  renderSelectionBox();
}

function snapshotOfLayer(layer) {
  if (layer === "zone") {
    ensureZoneGrid();
    return state.zoneGrid.map((row) => row.join("")).join("\n");
  }
  sanitizeStateGrid();
  return state.grid.map((row) => row.join("")).join("\n");
}

function restoreLayerSnapshot(layer, snapshot) {
  if (layer === "zone") {
    const rows = snapshot.split("\n");
    const grid = rows.map((row) => {
      const cells = [];
      for (let i = 0; i < row.length; i += 3) cells.push(row.slice(i, i + 3));
      return cells;
    });
    if (grid.length !== state.height || (grid[0]?.length ?? 0) !== state.width) return false;
    state.zoneGrid = grid;
    if (state.activeLayer !== "zone") setActiveLayer("zone");
    else render();
    return true;
  }
  return restoreSnapshot(snapshot);
}

function pushUndo() {
  state.undoStack.push({ layer: state.activeLayer, snapshot: snapshotOfLayer(state.activeLayer) });
  if (state.undoStack.length > 80) state.undoStack.shift();
  state.redoStack.length = 0;
}

function snapshotGrid() {
  sanitizeStateGrid();
  return state.grid.map((row) => row.join("")).join("\n");
}

function restoreSnapshot(snapshot) {
  const rows = snapshot.split("\n");
  let geometry = detectMapGeometry(rows);
  let normalizedRows = geometry ? normalizeRows(rows, { geometry }) : null;
  if (!normalizedRows) {
    const recovered = tryRecoverMixedRows(rows, {
      width: state.width,
      height: rows.length,
    });
    if (!recovered) return false;
    geometry = recovered.geometry;
    normalizedRows = recovered.rows;
  }
  state.width = geometry.width;
  state.height = geometry.height;
  state.grid = rowsToGrid(normalizedRows);
  sanitizeStateGrid();
  ensureZoneGrid();
  clearSelection();
  resizeCanvases();
  if (state.activeLayer !== "biome") setActiveLayer("biome");
  else render();
  return true;
}

function undo() {
  if (!state.undoStack.length) return;
  const previous = state.undoStack.pop();
  const current = { layer: previous.layer, snapshot: snapshotOfLayer(previous.layer) };
  if (!restoreLayerSnapshot(previous.layer, previous.snapshot)) {
    state.undoStack.push(previous);
    setMessage("Undo に失敗しました（スナップショットを復元できません）");
    return;
  }
  state.redoStack.push(current);
  flushAutosave();
}

function redo() {
  if (!state.redoStack.length) return;
  const next = state.redoStack.pop();
  const current = { layer: next.layer, snapshot: snapshotOfLayer(next.layer) };
  if (!restoreLayerSnapshot(next.layer, next.snapshot)) {
    state.redoStack.push(next);
    setMessage("Redo に失敗しました（スナップショットを復元できません）");
    return;
  }
  state.undoStack.push(current);
  flushAutosave();
}

function canPaint(x, y) {
  if (x < 0 || y < 0 || x >= state.width || y >= state.height) return false;
  if (isZoneLayer()) {
    if (isWaterCell(x, y)) return false; // 地理圏は水域(海)には塗れない
    // バイオーム限定塗り: フィルタ指定時は、その biome のセルにのみ塗れる
    if (state.zoneBiomeFilter && state.grid[y][x] !== state.zoneBiomeFilter) return false;
    return true;
  }
  return !state.mask.has(state.grid[y][x]);
}

function isOptionPickActive(event) {
  return Boolean(event?.altKey || state.optionKeyHeld);
}

function pickBiomeAt(x, y) {
  if (x < 0 || y < 0 || x >= state.width || y >= state.height) return;
  const code = activeGrid()[y][x];
  if (isZoneLayer() && !zoneByCode.has(code)) return; // 未塗り/海はスポイト不可
  setSelectedCode(code);
  syncPaletteState();
  render();
}

function syncCanvasCursor() {
  if (state.replacePreviewActive) {
    canvas.style.cursor = "";
    hideBrushCursor();
    return;
  }
  if (state.optionKeyHeld) {
    canvas.style.cursor = EYEDROPPER_CURSOR;
    hideBrushCursor();
    return;
  }
  const isPaint = state.tool === "paint";
  if (isPaint && state.brushSize > 1) {
    canvas.style.cursor = "none";
  } else if (state.tool === "select") {
    const interaction = state.selectInteraction?.type;
    if (interaction === "move" || interaction === "rotate" || interaction === "scale") {
      canvas.style.cursor = "grabbing";
    } else {
      const hit = hitSelectionHandle(state.lastCanvasPointFloat);
      if (hit?.type === "rotate") canvas.style.cursor = "grab";
      else if (hit?.type === "scale-corner") {
        canvas.style.cursor = hit.id === "tl" || hit.id === "br" ? "nwse-resize" : "nesw-resize";
      } else if (hit?.type === "scale-edge") {
        canvas.style.cursor = hit.id === "l" || hit.id === "r" ? "ew-resize" : "ns-resize";
      } else if (state.lastCanvasPoint && isDisplayedCellSelected(state.lastCanvasPoint.x, state.lastCanvasPoint.y)) {
        canvas.style.cursor = "grab";
      } else {
        canvas.style.cursor = "crosshair";
      }
    }
  } else if (state.tool === "crop") {
    canvas.style.cursor = "crosshair";
  } else {
    canvas.style.cursor = "";
  }
  if (state.lastCanvasPoint) updateBrushCursor(state.lastCanvasPoint);
  else hideBrushCursor();
}

function syncToolUi() {
  for (const input of els.toolField.querySelectorAll('input[name="tool"]')) {
    input.checked = input.value === state.tool;
  }
  syncCanvasCursor();
  renderGuide();
}

function syncBrushSizeUi() {
  for (const button of els.brushSizeField.querySelectorAll("[data-brush-size]")) {
    button.classList.toggle("active", Number(button.dataset.brushSize) === state.brushSize);
  }
  syncCanvasCursor();
  updateInfo();
  renderGuide();
}

function hideBrushCursor() {
  brushCursor.hidden = true;
}

function updateBrushCursor(point) {
  if (state.replacePreviewActive) {
    hideBrushCursor();
    return;
  }
  if (state.optionKeyHeld || state.tool !== "paint" || state.brushSize === 1) {
    hideBrushCursor();
    return;
  }

  const shape = getBrushShape(state.brushSize);
  if (state.brushSize === 4) {
    const origin = brushOrigin(point.x, point.y, shape);
    const left = CANVAS_INSET + origin.x * state.zoom;
    const top = CANVAS_INSET + origin.y * state.zoom;
    const size = shape.width * state.zoom;
    brushCursor.hidden = false;
    brushCursor.style.width = `${size}px`;
    brushCursor.style.height = `${size}px`;
    brushCursor.style.left = `${left}px`;
    brushCursor.style.top = `${top}px`;
    return;
  }

  hideBrushCursor();
  if (state.tool === "paint" && state.brushSize > 4) {
    renderGuide();
  }
}

function renderBrushCursor() {
  if (!state.lastCanvasPoint || state.replacePreviewActive || state.optionKeyHeld || state.tool !== "paint") {
    return;
  }
  if (state.brushSize <= 4) return;

  const cells = brushPaintCells(state.lastCanvasPoint.x, state.lastCanvasPoint.y, state.brushSize);
  if (!cells.length) return;

  guideCtx.save();
  guideCtx.imageSmoothingEnabled = false;
  const step = state.zoom;
  guideCtx.fillStyle = "rgba(255, 255, 255, 0.22)";
  guideCtx.strokeStyle = "rgba(255, 255, 255, 0.95)";
  guideCtx.lineWidth = 1;
  for (const { x, y } of cells) {
    const px = x * step;
    const py = y * step;
    guideCtx.fillRect(px, py, step, step);
    if (step > 1) {
      guideCtx.strokeRect(px + 0.5, py + 0.5, step - 1, step - 1);
    }
  }
  guideCtx.restore();
}

function paintCell(cx, cy, code = getSelectedCode()) {
  const grid = activeGrid();
  for (const { x, y } of brushPaintCells(cx, cy, state.brushSize)) {
    if (!canPaint(x, y)) continue;
    grid[y][x] = code;
    // レイヤー1で水域にしたセルはレイヤー2を未塗りに戻す(zone-layer-spec.md §5)
    if (!isZoneLayer() && isOceanDeepCode(code) && state.zoneGrid?.[y]) {
      state.zoneGrid[y][x] = ZONE_UNPAINTED;
    }
  }
  if (isZoneLayer()) invalidateCoverageIfShown();
}

// 編集で被覆結果が古くなったら破棄(赤オーバーレイを消し「再チェック」を促す)。安価にガード。
function invalidateCoverageIfShown() {
  if (!state.coverage.dead.length && !state.coverage.unpainted.length && !state.coverage.showDead) return;
  state.coverage.dead = [];
  state.coverage.unpainted = [];
  state.coverage.showDead = false;
  if (els.coverageShowToggle) els.coverageShowToggle.checked = false;
  if (els.coverageFixBtn) els.coverageFixBtn.disabled = true;
  if (els.coverageResult) els.coverageResult.innerHTML = '<div class="cov-sub">編集しました。再チェックしてください。</div>';
}

function linePaint(a, b, code = getSelectedCode()) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const steps = Math.max(Math.abs(dx), Math.abs(dy), 1);
  for (let i = 0; i <= steps; i++) {
    const x = Math.round(a.x + (dx * i) / steps);
    const y = Math.round(a.y + (dy * i) / steps);
    paintCell(x, y, code);
  }
}

function floodFill(x, y) {
  if (!canPaint(x, y)) return;
  const grid = activeGrid();
  const from = grid[y][x];
  const to = getSelectedCode();
  if (from === to) return;
  pushUndo();
  const queue = [{ x, y }];
  const seen = new Set();
  while (queue.length) {
    const point = queue.pop();
    const key = `${point.x},${point.y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (point.x < 0 || point.y < 0 || point.x >= state.width || point.y >= state.height) continue;
    if (grid[point.y][point.x] !== from || !canPaint(point.x, point.y)) continue;
    grid[point.y][point.x] = to;
    if (!isZoneLayer() && isOceanDeepCode(to) && state.zoneGrid?.[point.y]) {
      state.zoneGrid[point.y][point.x] = ZONE_UNPAINTED;
    }
    queue.push({ x: point.x + 1, y: point.y });
    queue.push({ x: point.x - 1, y: point.y });
    queue.push({ x: point.x, y: point.y + 1 });
    queue.push({ x: point.x, y: point.y - 1 });
  }
  if (isZoneLayer()) invalidateCoverageIfShown();
  render();
}

function canvasPoint(event) {
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor((event.clientX - rect.left) / state.zoom);
  const y = Math.floor((event.clientY - rect.top) / state.zoom);
  return { x, y };
}

function canvasPointFloat(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) / state.zoom,
    y: (event.clientY - rect.top) / state.zoom,
  };
}

function getSelectionTransform() {
  if (!state.selection) return { dx: 0, dy: 0, angle: 0, center: null, scale: null };
  if (state.selectInteraction?.type === "move") {
    return {
      dx: state.selectInteraction.offset.dx,
      dy: state.selectInteraction.offset.dy,
      angle: 0,
      center: null,
      scale: null,
    };
  }
  if (state.selectInteraction?.type === "rotate") {
    return {
      dx: 0,
      dy: 0,
      angle: state.selectInteraction.angle,
      center: state.selectInteraction.center,
      scale: null,
    };
  }
  if (state.selectInteraction?.type === "scale") {
    return {
      dx: 0,
      dy: 0,
      angle: 0,
      center: null,
      scale: state.selectInteraction.scale,
    };
  }
  return { dx: 0, dy: 0, angle: 0, center: null, scale: null };
}

function getSelectionBoxGeometry() {
  if (!state.selection) return null;
  const rotateOutset = Math.max(0.55, 10 / state.zoom);

  if (state.selectInteraction?.type === "scale") {
    const { baseBounds, baseEntries, scale } = state.selectInteraction;
    let bounds = baseBounds;
    if (scale && (scale.scaleX !== 1 || scale.scaleY !== 1)) {
      const preview = cellsFromEntries(
        scaleEntries(baseEntries, scale.anchorX, scale.anchorY, scale.scaleX, scale.scaleY),
      );
      bounds = selectionBounds(preview) || bounds;
    }
    if (!bounds) return null;
    return getSelectionBoxHandles(bounds, 0, rotateOutset);
  }

  if (state.selectInteraction?.type === "rotate") {
    const { baseEntries, center, angle } = state.selectInteraction;
    const bounds = selectionBounds(cellsFromEntries(baseEntries));
    if (!bounds || !center) return null;
    return getSelectionBoxHandles(
      { ...bounds, cx: center.cx, cy: center.cy },
      angle,
      rotateOutset,
    );
  }

  const cells = getDisplayedSelectionCells();
  const bounds = selectionBounds(cells);
  if (!bounds) return null;
  return getSelectionBoxHandles(bounds, 0, rotateOutset);
}

function hitSelectionHandle(pointF) {
  if (!pointF || !state.selection || state.selectInteraction?.type === "lasso") return null;
  const geometry = getSelectionBoxGeometry();
  if (!geometry) return null;

  const scaleRadius = Math.max(0.45, 7 / state.zoom);
  const rotateInner = Math.max(0.35, 5 / state.zoom);
  const rotateOuter = Math.max(0.7, 12 / state.zoom);

  const rotateId = hitRotateHandleOutside(
    pointF.x,
    pointF.y,
    geometry.corners,
    geometry.rotateHandles,
    rotateInner,
    rotateOuter,
  );
  if (rotateId) return { type: "rotate", id: rotateId };

  const cornerId = hitHandlePoint(pointF.x, pointF.y, geometry.corners, scaleRadius);
  if (cornerId) return { type: "scale-corner", id: cornerId };

  const edgeId = hitHandlePoint(pointF.x, pointF.y, geometry.edges, scaleRadius);
  if (edgeId) return { type: "scale-edge", id: edgeId };

  return null;
}

function commitSelectionRotate(angle, center) {
  if (!state.selection || angle === 0 || !center) return;

  pushUndo();
  const result = applySelectionRotate(
    state.grid,
    state.selection.cells,
    center.cx,
    center.cy,
    angle,
    mapDims(),
    (x, y) => canPaint(x, y),
  );
  state.grid = result.grid;
  state.selection.cells = result.cells;
  state.selection.entries = entriesFromCells(result.cells);
  render();
  const parts = [`回転: ${result.moved} マス`];
  if (result.gapFilled > 0) parts.push(`隙間 ${result.gapFilled} マスを周囲で補完`);
  if (result.sourceFilled > 0) parts.push(`元位置 ${result.sourceFilled} マスを周囲で補完`);
  if (result.stayed > 0) parts.push(`${result.stayed} マスは移動不可`);
  setMessage(parts.join("、"));
}

function commitSelectionScale(scale) {
  if (!state.selection || !scale) return;
  if (scale.scaleX === 1 && scale.scaleY === 1) return;

  pushUndo();
  const result = applySelectionScale(
    state.grid,
    state.selection.cells,
    scale.anchorX,
    scale.anchorY,
    scale.scaleX,
    scale.scaleY,
    mapDims(),
    (x, y) => canPaint(x, y),
  );
  state.grid = result.grid;
  state.selection.cells = result.cells;
  state.selection.entries = entriesFromCells(result.cells);
  render();
  const parts = [`変形: ${result.moved} マス`];
  if (result.gapFilled > 0) parts.push(`隙間 ${result.gapFilled} マスを周囲で補完`);
  if (result.sourceFilled > 0) parts.push(`元位置 ${result.sourceFilled} マスを周囲で補完`);
  if (result.stayed > 0) parts.push(`${result.stayed} マスは移動不可`);
  setMessage(parts.join("、"));
}

function parsePositiveInt(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= 1 ? n : null;
}

function syncAspectLockButton() {
  if (!els.aspectLockBtn) return;
  els.aspectLockBtn.setAttribute("aria-pressed", state.aspectRatioLocked ? "true" : "false");
  els.aspectLockBtn.title = state.aspectRatioLocked ? "縦横比固定中（クリックで解除）" : "縦横比を固定";
  els.aspectLockBtn.setAttribute(
    "aria-label",
    state.aspectRatioLocked ? "縦横比ロック解除" : "縦横比ロック",
  );
}

function captureAspectRatioFromInputs() {
  const width = parsePositiveInt(els.canvasWidthInput.value) ?? state.width;
  const height = parsePositiveInt(els.canvasHeightInput.value) ?? state.height;
  state.aspectRatio = width / height;
}

function setAspectRatioLocked(locked) {
  state.aspectRatioLocked = locked;
  if (locked) captureAspectRatioFromInputs();
  syncAspectLockButton();
}

function syncLinkedSizeInput(source) {
  if (!state.aspectRatioLocked || state.aspectRatio <= 0) return;
  if (source === "width") {
    const width = parsePositiveInt(els.canvasWidthInput.value);
    if (!width) return;
    els.canvasHeightInput.value = String(Math.max(1, Math.round(width / state.aspectRatio)));
  } else {
    const height = parsePositiveInt(els.canvasHeightInput.value);
    if (!height) return;
    els.canvasWidthInput.value = String(Math.max(1, Math.round(height * state.aspectRatio)));
  }
}

function getCanvasSizeMode() {
  const selected = document.querySelector('input[name="canvasSizeMode"]:checked');
  return selected?.value === "canvas" ? "canvas" : "stretch";
}

function applyCanvasSize(rawWidth, rawHeight) {
  const width = parsePositiveInt(rawWidth);
  const height = parsePositiveInt(rawHeight);
  if (!width || !height) {
    setMessage("横・縦はそれぞれ 1 以上の整数を指定してください");
    return;
  }
  if (width === state.width && height === state.height) {
    setMessage(`サイズはすでに ${width}×${height} です`);
    return;
  }
  const mode = getCanvasSizeMode();
  const modeLabel =
    mode === "canvas"
      ? "切り取り／海余白（縮小は中央切り取り、拡大は周囲に海）"
      : "伸縮（最近傍）";
  const ok = window.confirm(
    `マップサイズを ${state.width}×${state.height} → ${width}×${height} に変更します。\n方法: ${modeLabel}\nよろしいですか？`,
  );
  if (!ok) {
    setMessage("サイズ変更をキャンセルしました");
    updateInfo();
    return;
  }
  pushUndo();
  ensureZoneGrid(); // 変換前に zoneGrid を旧寸法へ揃える
  if (mode === "canvas") {
    state.grid = resizeGridCanvas(state.grid, width, height, "OCN");
    state.zoneGrid = resizeGridCanvas(state.zoneGrid, width, height, ZONE_UNPAINTED);
  } else {
    state.grid = resizeGrid(state.grid, width, height, "OCN");
    state.zoneGrid = resizeGrid(state.zoneGrid, width, height, ZONE_UNPAINTED); // レイヤー2も同じ伸縮
  }
  state.width = width;
  state.height = height;
  ensureZoneGrid(); // 念のため整合(通常は不変)
  if (state.aspectRatioLocked) state.aspectRatio = width / height;
  clearSelection();
  resizeCanvases();
  render();
  setMessage(
    mode === "canvas"
      ? `サイズを ${width}×${height} に変更しました（切り取り／海余白）`
      : `サイズを ${width}×${height} に変更しました（伸縮）`,
  );
}

function biomesGroupedByColorFamily() {
  const familyOrder = Object.keys(COLOR_FAMILIES);
  const grouped = new Map(familyOrder.map((key) => [key, []]));
  for (const biome of BIOMES) {
    if (!grouped.has(biome.colorFamily)) grouped.set(biome.colorFamily, []);
    grouped.get(biome.colorFamily).push(biome);
  }
  for (const biomes of grouped.values()) {
    biomes.sort((a, b) => a.elevation - b.elevation);
  }
  return familyOrder
    .filter((key) => grouped.get(key).length > 0)
    .map((key) => ({
      key,
      label: COLOR_FAMILIES[key].jp,
      biomes: grouped.get(key),
    }));
}

function createPaletteRow(biome) {
  const row = document.createElement("div");
  row.className = "palette-row";
  row.dataset.code = biome.code;
  row.innerHTML = `
    <input class="highlight-toggle" type="checkbox" title="ハイライト">
    <input class="mask-toggle" type="checkbox" title="マスク">
    <span class="swatch" style="background:${biome.color}"></span>
    <span class="biome-name">
      <strong>${biome.jp}</strong>
      <span class="biome-meta">${biome.code}</span>
    </span>
  `;
  row.addEventListener("click", (event) => {
    if (event.target.matches("input")) return;
    state.selectedCode = biome.code;
    syncPaletteState();
    render();
  });
  row.querySelector(".highlight-toggle").addEventListener("change", (event) => {
    if (event.target.checked) state.highlight.add(biome.code);
    else state.highlight.delete(biome.code);
    render();
  });
  row.querySelector(".mask-toggle").addEventListener("change", (event) => {
    if (event.target.checked) state.mask.add(biome.code);
    else state.mask.delete(biome.code);
    syncPaletteState();
    scheduleAutosave();
  });
  return row;
}

function createZoneRow(zone) {
  const row = document.createElement("div");
  row.className = "palette-row zone-row";
  row.dataset.code = zone.code;
  row.innerHTML = `
    <span class="swatch" style="background:${zone.color}"></span>
    <span class="biome-name">
      <strong>${zone.jp}</strong>
      <span class="biome-meta">${zone.code}</span>
    </span>
  `;
  row.addEventListener("click", () => {
    state.selectedZoneCode = zone.code;
    syncPaletteState();
    render();
  });
  return row;
}

function zonesGroupedByGroup() {
  const groups = [];
  const byLabel = new Map();
  for (const zone of ZONES) {
    if (!byLabel.has(zone.group)) {
      const entry = { label: zone.group, zones: [] };
      byLabel.set(zone.group, entry);
      groups.push(entry);
    }
    byLabel.get(zone.group).zones.push(zone);
  }
  return groups;
}

function buildPalette() {
  els.paletteList.innerHTML = "";
  if (isZoneLayer()) {
    for (const group of zonesGroupedByGroup()) {
      const section = document.createElement("section");
      section.className = "palette-family";
      const title = document.createElement("h3");
      title.className = "palette-family-title";
      title.textContent = group.label;
      section.appendChild(title);
      const rows = document.createElement("div");
      rows.className = "palette-family-rows";
      for (const zone of group.zones) rows.appendChild(createZoneRow(zone));
      section.appendChild(rows);
      els.paletteList.appendChild(section);
    }
  } else {
    for (const group of biomesGroupedByColorFamily()) {
      const section = document.createElement("section");
      section.className = "palette-family";
      const title = document.createElement("h3");
      title.className = "palette-family-title";
      title.textContent = group.label;
      section.appendChild(title);
      const rows = document.createElement("div");
      rows.className = "palette-family-rows";
      for (const biome of group.biomes) rows.appendChild(createPaletteRow(biome));
      section.appendChild(rows);
      els.paletteList.appendChild(section);
    }
  }
  syncPaletteState();
}

function syncPaletteState() {
  const selected = getSelectedCode();
  for (const row of els.paletteList.querySelectorAll(".palette-row")) {
    const code = row.dataset.code;
    row.classList.toggle("selected", code === selected);
    row.classList.toggle("masked", state.mask.has(code));
    const highlightToggle = row.querySelector(".highlight-toggle");
    const maskToggle = row.querySelector(".mask-toggle");
    if (highlightToggle) highlightToggle.checked = state.highlight.has(code);
    if (maskToggle) maskToggle.checked = state.mask.has(code);
  }
}

function updateLayerUi() {
  if (els.layerBiomeBtn) els.layerBiomeBtn.classList.toggle("active", state.activeLayer === "biome");
  if (els.layerZoneBtn) els.layerZoneBtn.classList.toggle("active", state.activeLayer === "zone");
  if (els.paletteHeading) els.paletteHeading.textContent = isZoneLayer() ? "地理圏(レイヤー2)" : "バイオーム";
  if (els.paletteHint) {
    els.paletteHint.textContent = isZoneLayer()
      ? "レイヤー1を淡色下敷きに、陸だけを30圏で塗る。海は自動割当。"
      : "チェックONでハイライト。マスクONの色は塗り替え不可。";
  }
  if (els.coveragePanel) els.coveragePanel.hidden = !isZoneLayer();
  if (els.zoneTransRow) els.zoneTransRow.hidden = !isZoneLayer();
  if (els.zoneFilterRow) els.zoneFilterRow.hidden = !isZoneLayer();
  if (!isZoneLayer() && state.coverage.showDead) {
    state.coverage.showDead = false;
    if (els.coverageShowToggle) els.coverageShowToggle.checked = false;
  }
}

function setActiveLayer(layer) {
  if (layer !== "biome" && layer !== "zone") return;
  state.activeLayer = layer;
  if (layer === "zone") {
    ensureZoneGrid();
    const zoneTools = new Set(["paint", "fill", "picker", "pan"]);
    if (!zoneTools.has(state.tool)) {
      state.tool = "paint";
      syncToolUi();
    }
  }
  updateLayerUi();
  buildPalette();
  render();
}

// レイヤー2「バイオーム限定塗り」のセレクタを構築(BIOMES から。色ファミリー順)。
function buildZoneBiomeFilter() {
  if (!els.zoneBiomeFilter) return;
  const opts = ['<option value="">制限なし(全バイオーム)</option>'];
  for (const group of biomesGroupedByColorFamily()) {
    opts.push(`<optgroup label="${group.label}">`);
    for (const b of group.biomes) {
      if (isOceanDeepBiome(b)) continue; // 海は塗れないので除外
      opts.push(`<option value="${b.code}">${b.jp}(${b.code})</option>`);
    }
    opts.push("</optgroup>");
  }
  els.zoneBiomeFilter.innerHTML = opts.join("");
  els.zoneBiomeFilter.value = state.zoneBiomeFilter || "";
}

// ---- 被覆チェック(zone_map の出現ゼロピクセル検査 & 近傍zone塗替) ----
function runCoverageCheck() {
  ensureZoneGrid();
  const r = findDead(state.grid, state.zoneGrid, state.width, state.height, HABITAT.roam, COV.alive);
  state.coverage.dead = r.dead;
  state.coverage.unpainted = r.unpainted;
  state.coverage.checked = r.checked;
  renderCoverageResult(r);
  render();
}

function renderCoverageResult(r) {
  const el = els.coverageResult;
  if (!el) return;
  const deadN = r.dead.length;
  const unpN = r.unpainted.length;
  const parts = [];
  if (unpN > 0) {
    parts.push(`<div class="cov-warn">◦ 未塗り ${unpN} px(地理圏を塗ってください。デッドとは別)</div>`);
  }
  if (deadN === 0) {
    parts.push(`<div class="cov-ok">✓ デッドなし${unpN ? "(塗り済みの陸は全て動物が出現)" : `(陸 ${r.checked} px すべてに動物が出現)`}</div>`);
  } else {
    const pairs = Object.entries(r.byPair).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const rows = pairs.map(([k, n]) => `<div class="cov-row"><span>${k}</span><span>${n}</span></div>`).join("");
    parts.push(
      `<div class="cov-bad">⚠ デッド ${deadN} px(塗り済みだが動物なし)</div>` +
      `<div class="cov-sub">出現しない (biome×zone):</div>${rows}` +
      (pairs.length < Object.keys(r.byPair).length ? `<div class="cov-sub">…他 ${Object.keys(r.byPair).length - pairs.length} 組</div>` : ""),
    );
  }
  el.innerHTML = parts.join("");
  if (els.coverageFixBtn) els.coverageFixBtn.disabled = deadN === 0;
}

function autoFixCoverage() {
  if (!state.coverage.dead.length) return;
  const { changes, unfixable } = repaintCoverage(
    state.grid, state.zoneGrid, state.width, state.height, state.coverage.dead, COV.zok,
  );
  if (changes.length) {
    pushUndo();
    for (const [x, y, nz] of changes) state.zoneGrid[y][x] = nz;
  }
  runCoverageCheck();
  const unfixN = Object.keys(unfixable).length;
  const msg = `${changes.length} px を近傍zoneへ塗替え`
    + (unfixN ? ` / 修正不能 ${unfixN} biome(生息域表の穴): ${Object.keys(unfixable).join(", ")}` : "");
  setMessage(msg);
}

function toggleDeadOverlay(on) {
  state.coverage.showDead = on;
  render();
}

// デッド=赤 / 未塗り=橙 を重ねる(guideキャンバス)。
function renderDeadOverlay() {
  if (!state.coverage.showDead || !isZoneLayer()) return;
  const cov = state.coverage;
  if (!cov.dead.length && !cov.unpainted.length) return;
  const step = state.zoom;
  guideCtx.save();
  guideCtx.fillStyle = "rgba(240, 160, 30, 0.55)"; // 未塗り=橙
  for (const [x, y] of cov.unpainted) guideCtx.fillRect(x * step, y * step, step, step);
  guideCtx.fillStyle = "rgba(230, 30, 40, 0.72)"; // デッド=赤
  for (const [x, y] of cov.dead) guideCtx.fillRect(x * step, y * step, step, step);
  guideCtx.restore();
}

function renderReplaceRules() {
  els.replaceRulesList.innerHTML = "";
  if (!state.replaceRules.length) {
    const empty = document.createElement("p");
    empty.className = "hint replace-rules-empty";
    empty.textContent = "ルールがありません。「ルール追加」で作成してください。";
    els.replaceRulesList.appendChild(empty);
    return;
  }

  state.replaceRules.forEach((rule, index) => {
    const card = document.createElement("div");
    card.className = "replace-rule";
    card.innerHTML = `
      <div class="replace-rule-head">
        <strong>ルール ${index + 1}</strong>
        <button class="replace-rule-remove" type="button" title="削除">×</button>
      </div>
      <div class="field">
        <label>条件</label>
        <select class="replace-mode">
          ${REPLACE_MODES.map(
            (item) => `<option value="${item.value}"${item.value === rule.mode ? " selected" : ""}>${item.label}</option>`,
          ).join("")}
        </select>
      </div>
      <div class="field replace-adjacent-field"${rule.mode === "always" ? " hidden" : ""}>
        <label>条件バイオーム（〇〇）</label>
        <select class="replace-adjacent">${replaceSelectorOptions(rule.adjacent)}</select>
      </div>
      <div class="field">
        <label>対象（◇◇）</label>
        <select class="replace-from">${replaceSelectorOptions(rule.from)}</select>
      </div>
      <div class="field">
        <label>置換先（△△）</label>
        <select class="replace-to">${replaceTargetOptions(rule.to)}</select>
      </div>
      <p class="hint replace-rule-summary"></p>
    `;

    const modeSelect = card.querySelector(".replace-mode");
    const adjacentField = card.querySelector(".replace-adjacent-field");
    const adjacentSelect = card.querySelector(".replace-adjacent");
    const fromSelect = card.querySelector(".replace-from");
    const toSelect = card.querySelector(".replace-to");
    const summary = card.querySelector(".replace-rule-summary");

    function syncRuleFromUi() {
      rule.mode = modeSelect.value;
      rule.adjacent = adjacentSelect.value;
      rule.from = fromSelect.value;
      rule.to = toSelect.value;
      adjacentField.hidden = rule.mode === "always";
      summary.textContent = describeReplaceRule(rule);
      scheduleAutosave();
      refreshReplacePreviewIfActive();
    }

    modeSelect.addEventListener("change", syncRuleFromUi);
    adjacentSelect.addEventListener("change", syncRuleFromUi);
    fromSelect.addEventListener("change", syncRuleFromUi);
    toSelect.addEventListener("change", syncRuleFromUi);
    card.querySelector(".replace-rule-remove").addEventListener("click", () => {
      state.replaceRules.splice(index, 1);
      renderReplaceRules();
      scheduleAutosave();
      refreshReplacePreviewIfActive();
    });

    adjacentField.hidden = rule.mode === "always";
    summary.textContent = describeReplaceRule(rule);
    els.replaceRulesList.appendChild(card);
  });
}

function describeReplaceRule(rule) {
  const fromLabel = labelForReplaceSelector(rule.from);
  const to = rule.to === ADJACENT_REPLACE_TARGET ? null : biomeByCode.get(rule.to);
  const toLabel = to ? to.jp : "面したバイオームのどれか";
  const adjacentLabel = labelForReplaceSelector(rule.adjacent);
  if (rule.mode === "always") {
    return `${fromLabel} を ${toLabel} に置換`;
  }
  if (rule.mode === "touching") {
    return `${adjacentLabel} に面した ${fromLabel} を ${toLabel} に置換`;
  }
  return `${adjacentLabel} に面していない ${fromLabel} を ${toLabel} に置換`;
}

function hasAdjacentBiome(x, y, code, grid) {
  return hasAdjacentBiomeAt(x, y, code, grid, mapDims());
}

function cellMatchesReplaceRule(x, y, rule, grid) {
  return cellMatchesReplaceRuleAt(x, y, rule, grid, mapDims(), getReplaceMatchContext());
}

function applyReplaceRules() {
  if (!state.replaceRules.length) {
    setMessage("置換ルールがありません");
    return;
  }

  pushUndo();
  let total = 0;
  for (const rule of state.replaceRules) {
    for (const { x, y } of getReplaceTargetsForRule(rule)) {
      if (!canPaint(x, y)) continue;
      const replacement = rule.to === ADJACENT_REPLACE_TARGET
        ? chooseAdjacentReplacement(x, y, state.grid, mapDims())
        : rule.to;
      if (!replacement) continue;
      state.grid[y][x] = replacement;
      total++;
    }
  }

  state.replacePreviewActive = false;
  render();
  setMessage(total > 0 ? `置換完了: ${total} マス` : "置換対象はありませんでした");
}

function fitToView() {
  const zoom = Math.max(1, Math.floor(Math.min(
    (wrap.clientWidth - 48) / state.width,
    (wrap.clientHeight - 48) / state.height,
  )));
  state.zoom = Math.min(32, zoom);
  els.zoomRange.value = String(state.zoom);
  resizeCanvases();
}

function isMapBlankOcean() {
  if (!state.grid.length) return true;
  for (const row of state.grid) {
    for (const code of row) {
      if (code !== "OCN") return false;
    }
  }
  return true;
}

function newMap(width, height = width) {
  const sameSize = state.width === width && state.height === height;
  if (!isMapBlankOcean() || !sameSize) {
    const ok = window.confirm(
      `現在のマップ（${state.width}×${state.height}）を破棄し、${width}×${height} の海のみのマップを作成します。\nよろしいですか？`,
    );
    if (!ok) {
      setMessage("新規キャンバス作成をキャンセルしました");
      return;
    }
  }
  pushUndo();
  state.width = width;
  state.height = height;
  state.grid = createGrid(width, height, "OCN");
  state.zoneGrid = [];
  ensureZoneGrid();
  state.guidePoints = [];
  clearSelection();
  fitToView();
  render();
  setMessage(`${width}×${height} の海マップを作成（ズーム ${state.zoom}x）`);
}

function clearCurrentMap() {
  const ok = window.confirm(
    `現在のマップ（${state.width}×${state.height}）をすべて海でクリアします。\nこの操作はアンドゥで戻せますが、よろしいですか？`,
  );
  if (!ok) return;
  pushUndo();
  state.grid = createGrid(state.width, state.height, "OCN");
  state.zoneGrid = [];
  ensureZoneGrid();
  state.guidePoints = [];
  clearSelection();
  render();
  setMessage(`${state.width}×${state.height} をクリアしました`);
}

function importJson(text, scaleMode = els.importScale.value) {
  const data = JSON.parse(text);
  const rows = data.rows;
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("rows がありません");
  let geometry = detectMapGeometry(rows);
  if (
    Number.isFinite(data.width) &&
    Number.isFinite(data.height) &&
    data.width > 0 &&
    data.height > 0 &&
    data.height === rows.length &&
    geometry &&
    rows.every((row) => typeof row === "string" && row.length === rows[0].length)
  ) {
    const cellWidth = rows[0].length / data.width;
    if (Number.isInteger(cellWidth) && (cellWidth === 1 || cellWidth === 3)) {
      geometry = { cellWidth, width: data.width, height: data.height };
    }
  }
  const importOptions = {
    legacyJungleIsle: isLegacyJungleIsleLegend(data.legend),
    legacyVolcanoIsle: isLegacyVolcanoIsleLegend(data.legend),
    geometry,
  };
  let normalizedRows = geometry ? normalizeRows(rows, importOptions) : null;
  let recoveredMixed = false;
  if (!normalizedRows) {
    const recovered = tryRecoverMixedRows(rows, data, importOptions);
    if (!recovered) {
      if (!geometry) {
        throw new Error("rows の寸法が不正です（各行の長さが揃った文字列配列が必要です）");
      }
      const { cellWidth } = geometry;
      const unknownCodes = new Set();
      for (const row of rows) {
        const rawCodes = cellWidth === 1 ? row.split("") : chunkString(row, 3);
        for (const code of rawCodes) {
          const normalizedCode = migrateLegacyCode(code, importOptions);
          if (!biomeByCode.has(normalizedCode)) unknownCodes.add(code);
        }
      }
      throw new Error(`未知のバイオームコード: ${[...unknownCodes].join(", ")}`);
    }
    geometry = recovered.geometry;
    normalizedRows = recovered.rows;
    recoveredMixed = true;
  }
  const { width: sourceWidth, height: sourceHeight } = geometry;
  const { grid, width, height } = applyImportScale(rowsToGrid(normalizedRows), scaleMode);
  pushUndo();
  state.width = width;
  state.height = height;
  state.grid = grid;
  sanitizeStateGrid();
  ensureZoneGrid();
  state.guidePoints = [];
  clearSelection();
  resizeCanvases();
  render();
  const scaleLabel = scaleMode === "2" ? "・2倍拡大" : scaleMode === "half" ? "・半分" : "";
  const recoverLabel = recoveredMixed ? "・旧コード混在を修復" : "";
  setMessage(`JSON読込: ${sourceWidth}×${sourceHeight} → ${width}×${height}${scaleLabel}${recoverLabel}`);
}

function importImage(file, scaleMode = els.importScale.value) {
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.onload = () => {
    try {
      const sourceWidth = image.width;
      const sourceHeight = image.height;
      if (sourceWidth < 1 || sourceHeight < 1) {
        throw new Error("画像サイズが不正です");
      }
      if (scaleMode === "half" && (sourceWidth % 2 !== 0 || sourceHeight % 2 !== 0)) {
        throw new Error("半分に縮小するには幅・高さが偶数である必要があります");
      }

      const off = document.createElement("canvas");
      off.width = sourceWidth;
      off.height = sourceHeight;
      const offCtx = off.getContext("2d");
      offCtx.imageSmoothingEnabled = false;
      offCtx.drawImage(image, 0, 0, sourceWidth, sourceHeight);
      const data = offCtx.getImageData(0, 0, sourceWidth, sourceHeight).data;
      const source = createGrid(sourceWidth, sourceHeight);
      for (let y = 0; y < sourceHeight; y++) {
        for (let x = 0; x < sourceWidth; x++) {
          const offset = (y * sourceWidth + x) * 4;
          const biome = nearestBiome(data[offset], data[offset + 1], data[offset + 2]);
          source[y][x] = biome.code;
        }
      }
      const { grid, width, height } = applyImportScale(source, scaleMode);
      pushUndo();
      state.width = width;
      state.height = height;
      state.grid = grid;
      state.guidePoints = [];
      clearSelection();
      resizeCanvases();
      render();
      const scaleLabel = scaleMode === "2" ? "・2倍拡大" : scaleMode === "half" ? "・半分" : "";
      setMessage(`画像読込: ${sourceWidth}×${sourceHeight} → ${width}×${height}${scaleLabel}`);
    } catch (error) {
      setMessage(error.message || "画像読込に失敗しました");
    } finally {
      URL.revokeObjectURL(url);
    }
  };
  image.src = url;
}

function exportPng() {
  const out = document.createElement("canvas");
  out.width = state.width;
  out.height = state.height;
  const outCtx = out.getContext("2d");
  const image = outCtx.createImageData(state.width, state.height);
  for (let y = 0; y < state.height; y++) {
    for (let x = 0; x < state.width; x++) {
      const rgb = hexToRgb(biomeByCode.get(state.grid[y][x]).color);
      const offset = (y * state.width + x) * 4;
      image.data[offset] = rgb.r;
      image.data[offset + 1] = rgb.g;
      image.data[offset + 2] = rgb.b;
      image.data[offset + 3] = 255;
    }
  }
  outCtx.putImageData(image, 0, 0);
  downloadUrl(out.toDataURL("image/png"), `biome_map_${state.width}x${state.height}.png`);
}

function exportJson() {
  sanitizeStateGrid();
  const legend = {};
  for (const biome of BIOMES) {
    legend[biome.code] = {
      name: biome.name,
      jp: biome.jp,
      color: biome.color,
      category: biome.category,
      elevation: biome.elevation,
      temp: biome.temp,
      humidity: biome.humidity,
      relief: biome.relief,
    };
  }
  const data = {
    width: state.width,
    height: state.height,
    ...(state.width === state.height ? { size: state.width } : {}),
    seed: null,
    scheme: "map-maker-v2",
    layer: "public",
    source: "Blockland Map Maker",
    px_means: "1px = 1 region",
    region_blocks: 64,
    world_width_blocks: state.width * 64,
    world_height_blocks: state.height * 64,
    world_blocks: state.width === state.height ? state.width * 64 : undefined,
    legend,
    rows: state.grid.map((row) => row.join("")),
    structures: [],
  };
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: "application/json" });
  downloadUrl(URL.createObjectURL(blob), `biome_map_${state.width}x${state.height}.json`, true);
}

// 塗り済み陸を種に、水域/未塗りへ最近傍の地理圏をBFS(FIFO・種は行優先)で割り当てる決定論的処理。
function fillZoneSeaByBfs() {
  const w = state.width;
  const h = state.height;
  const out = state.zoneGrid.map((row) => row.slice());
  const queue = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (zoneByCode.has(out[y][x])) queue.push({ x, y });
    }
  }
  const seeds = queue.length;
  let head = 0;
  while (head < queue.length) {
    const { x, y } = queue[head++];
    const code = out[y][x];
    const nbrs = [{ x: x + 1, y }, { x: x - 1, y }, { x, y: y + 1 }, { x, y: y - 1 }];
    for (const n of nbrs) {
      if (n.x < 0 || n.y < 0 || n.x >= w || n.y >= h) continue;
      if (!zoneByCode.has(out[n.y][n.x])) {
        out[n.y][n.x] = code;
        queue.push(n);
      }
    }
  }
  return { grid: out, seeds };
}

function exportZoneJson() {
  ensureZoneGrid();
  const w = state.width;
  const h = state.height;
  let unpainted = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (isOceanDeepBiome(biomeByCode.get(state.grid[y][x]))) continue; // 海は塗らなくてよい
      if (!zoneByCode.has(state.zoneGrid[y][x])) unpainted++;
    }
  }
  if (unpainted > 0) {
    setMessage(`地理圏の未塗り陸セルが ${unpainted} 個あります。全陸を塗ってから出力してください。`);
    return;
  }
  const { grid: filled, seeds } = fillZoneSeaByBfs();
  if (seeds === 0) {
    setMessage("地理圏が1つも塗られていません。");
    return;
  }
  const legend = {};
  for (const zone of ZONES) {
    legend[zone.code] = { jp: zone.jp, color: zone.color };
  }
  const data = {
    width: w,
    height: h,
    ...(w === h ? { size: w } : {}),
    seed: null,
    scheme: "zone-map-v1",
    layer: "zone",
    source: "Blockland Map Maker",
    px_means: "1px = 1 region",
    region_blocks: 64,
    note: "海セルは最寄り陸圏をBFSで自動割当済み(zone-layer-spec.md §4)",
    legend,
    rows: filled.map((row) => row.join("")),
  };
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: "application/json" });
  downloadUrl(URL.createObjectURL(blob), `zone_map_${w}x${h}.json`, true);
  setMessage("zone_map.json を出力しました。");
}

function importZoneJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    setMessage("地理圏JSONの解析に失敗しました。");
    return;
  }
  const rows = data.rows;
  if (!Array.isArray(rows) || rows.length !== state.height || (rows[0]?.length ?? 0) !== state.width * 3) {
    setMessage("地理圏JSONの寸法が現在のマップと一致しません。先にバイオームマップを合わせてください。");
    return;
  }
  ensureZoneGrid();
  for (let y = 0; y < state.height; y++) {
    const row = rows[y];
    for (let x = 0; x < state.width; x++) {
      if (isOceanDeepBiome(biomeByCode.get(state.grid[y][x]))) {
        state.zoneGrid[y][x] = ZONE_UNPAINTED; // 海は未塗り扱い(出力時にBFSで再割当)
        continue;
      }
      const code = row.slice(x * 3, x * 3 + 3);
      state.zoneGrid[y][x] = zoneByCode.has(code) ? code : ZONE_UNPAINTED;
    }
  }
  setActiveLayer("zone");
  setMessage("地理圏レイヤーを読み込みました。");
}

// ---- .blmap パス記憶（File System Access API + IndexedDB）----
const BLMAP_IDB_NAME = "blockland-map-maker-files";
const BLMAP_IDB_STORE = "handles";
const BLMAP_HANDLE_KEY = "blmap";
const BLMAP_NAME_KEY = "blockland-map-maker-blmap-name";
const BLMAP_PICKER_TYPES = [
  {
    description: "Blockland map set",
    accept: { "application/json": [".blmap", ".json"] },
  },
];

let blmapFileHandle = null;

function supportsBlmapFilePicker() {
  return typeof window.showOpenFilePicker === "function"
    && typeof window.showSaveFilePicker === "function";
}

function defaultBlmapFilename() {
  return `map_${state.width}x${state.height}.blmap`;
}

function openBlmapIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(BLMAP_IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(BLMAP_IDB_STORE)) {
        db.createObjectStore(BLMAP_IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGetHandle(key) {
  const db = await openBlmapIdb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(BLMAP_IDB_STORE, "readonly");
      const req = tx.objectStore(BLMAP_IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

async function idbSetHandle(key, value) {
  const db = await openBlmapIdb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(BLMAP_IDB_STORE, "readwrite");
      tx.objectStore(BLMAP_IDB_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function idbDeleteHandle(key) {
  const db = await openBlmapIdb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(BLMAP_IDB_STORE, "readwrite");
      tx.objectStore(BLMAP_IDB_STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function ensureFileHandlePermission(handle, mode = "readwrite") {
  if (!handle?.queryPermission || !handle?.requestPermission) return false;
  const opts = { mode };
  if ((await handle.queryPermission(opts)) === "granted") return true;
  if ((await handle.requestPermission(opts)) === "granted") return true;
  return false;
}

function syncBlmapPathUi() {
  const name = blmapFileHandle?.name
    || localStorage.getItem(BLMAP_NAME_KEY)
    || null;
  if (els.blmapPathInfo) {
    els.blmapPathInfo.textContent = name || "未設定";
  }
  if (els.exportMapSetBtn) {
    els.exportMapSetBtn.textContent = blmapFileHandle ? "上書き保存" : ".blmap で保存";
  }
}

async function rememberBlmapHandle(handle) {
  blmapFileHandle = handle || null;
  if (handle) {
    localStorage.setItem(BLMAP_NAME_KEY, handle.name || defaultBlmapFilename());
    try {
      await idbSetHandle(BLMAP_HANDLE_KEY, handle);
    } catch (error) {
      console.warn("blmap handle persist failed", error);
    }
  } else {
    localStorage.removeItem(BLMAP_NAME_KEY);
    try {
      await idbDeleteHandle(BLMAP_HANDLE_KEY);
    } catch (error) {
      console.warn("blmap handle clear failed", error);
    }
  }
  syncBlmapPathUi();
}

async function restoreBlmapHandle() {
  if (!supportsBlmapFilePicker()) {
    syncBlmapPathUi();
    return;
  }
  try {
    const handle = await idbGetHandle(BLMAP_HANDLE_KEY);
    if (handle) {
      blmapFileHandle = handle;
      if (handle.name) localStorage.setItem(BLMAP_NAME_KEY, handle.name);
    }
  } catch (error) {
    console.warn("blmap handle restore failed", error);
  }
  syncBlmapPathUi();
}

function buildMapSetPayload() {
  sanitizeStateGrid();
  ensureZoneGrid();
  return {
    format: "blockland-map-set",
    version: 1,
    width: state.width,
    height: state.height,
    ...(state.width === state.height ? { size: state.width } : {}),
    biome: { scheme: "geo-v1", rows: state.grid.map((row) => row.join("")) },
    zone: { scheme: "zone-map-v1", rows: state.zoneGrid.map((row) => row.join("")) },
  };
}

async function writeBlmapHandle(handle, payload) {
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify(payload));
  await writable.close();
}

async function saveMapSetToHandle(handle, { asNew = false } = {}) {
  const payload = buildMapSetPayload();
  await writeBlmapHandle(handle, payload);
  await rememberBlmapHandle(handle);
  setMessage(
    asNew
      ? `プロジェクトを保存しました（${handle.name}）`
      : `上書き保存しました（${handle.name}）`,
  );
}

// レイヤー1+2 を .blmap に保存。記憶済みハンドルがあれば上書き。
async function exportMapSet() {
  const payload = buildMapSetPayload();
  try {
    if (blmapFileHandle && supportsBlmapFilePicker()) {
      if (await ensureFileHandlePermission(blmapFileHandle, "readwrite")) {
        await saveMapSetToHandle(blmapFileHandle);
        return;
      }
      // 権限失効時はハンドルを捨てて別名保存へ
      await rememberBlmapHandle(null);
    }
    if (supportsBlmapFilePicker()) {
      const handle = await window.showSaveFilePicker({
        suggestedName: localStorage.getItem(BLMAP_NAME_KEY) || defaultBlmapFilename(),
        types: BLMAP_PICKER_TYPES,
      });
      await saveMapSetToHandle(handle, { asNew: true });
      return;
    }
  } catch (error) {
    if (error?.name === "AbortError") {
      setMessage("保存をキャンセルしました");
      return;
    }
    console.warn("blmap save failed, falling back to download", error);
  }
  const name = localStorage.getItem(BLMAP_NAME_KEY) || defaultBlmapFilename();
  const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
  downloadUrl(URL.createObjectURL(blob), name, true);
  localStorage.setItem(BLMAP_NAME_KEY, name);
  syncBlmapPathUi();
  setMessage(`プロジェクトをダウンロードしました（${name}）。対応ブラウザでは上書き保存が使えます。`);
}

// 常に新しい保存先を選ぶ
async function exportMapSetAs() {
  const payload = buildMapSetPayload();
  try {
    if (supportsBlmapFilePicker()) {
      const handle = await window.showSaveFilePicker({
        suggestedName: blmapFileHandle?.name || localStorage.getItem(BLMAP_NAME_KEY) || defaultBlmapFilename(),
        types: BLMAP_PICKER_TYPES,
      });
      await saveMapSetToHandle(handle, { asNew: true });
      return;
    }
  } catch (error) {
    if (error?.name === "AbortError") {
      setMessage("保存をキャンセルしました");
      return;
    }
    console.warn("blmap save-as failed, falling back to download", error);
  }
  const name = defaultBlmapFilename();
  const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
  downloadUrl(URL.createObjectURL(blob), name, true);
  localStorage.setItem(BLMAP_NAME_KEY, name);
  syncBlmapPathUi();
  setMessage(`プロジェクトをダウンロードしました（${name}）`);
}

// .blmap を読み込み、レイヤー1・2を同時に復元。成功時 true。
function importMapSet(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    setMessage(".blmap の解析に失敗しました。");
    return false;
  }
  const brows = data.biome?.rows;
  const zrows = data.zone?.rows;
  if (!Array.isArray(brows) || brows.length === 0) {
    setMessage(".blmap にバイオームデータがありません。");
    return false;
  }
  const geometry = detectMapGeometry(brows);
  const normalized = geometry ? normalizeRows(brows, { geometry }) : null;
  if (!geometry || !normalized) {
    setMessage(".blmap のバイオーム形式を認識できません。");
    return false;
  }
  pushUndo();
  state.width = geometry.width;
  state.height = geometry.height;
  state.grid = rowsToGrid(normalized);
  sanitizeStateGrid();
  // zone をレイヤー2へ(寸法一致・3文字。不一致セルは未塗り)
  state.zoneGrid = [];
  ensureZoneGrid();
  if (Array.isArray(zrows)) {
    for (let y = 0; y < state.height; y++) {
      const row = zrows[y];
      if (typeof row !== "string") continue;
      for (let x = 0; x < state.width; x++) {
        const code = row.slice(x * 3, x * 3 + 3);
        if (zoneByCode.has(code)) state.zoneGrid[y][x] = code;
      }
    }
  }
  clearSelection();
  invalidateCoverageIfShown();
  resizeCanvases();
  render();
  setMessage(`プロジェクトを読み込みました(${state.width}×${state.height})。`);
  return true;
}

async function importMapSetFromHandle(handle) {
  if (!(await ensureFileHandlePermission(handle, "read"))) {
    setMessage("ファイルへのアクセスが許可されませんでした");
    return;
  }
  const file = await handle.getFile();
  const ok = importMapSet(await file.text());
  if (ok) await rememberBlmapHandle(handle);
}

async function openMapSet() {
  try {
    if (supportsBlmapFilePicker()) {
      const [handle] = await window.showOpenFilePicker({
        multiple: false,
        types: BLMAP_PICKER_TYPES,
      });
      await importMapSetFromHandle(handle);
      return;
    }
  } catch (error) {
    if (error?.name === "AbortError") {
      setMessage("読込をキャンセルしました");
      return;
    }
    console.warn("blmap open picker failed, falling back to input", error);
  }
  els.importMapSetInput?.click();
}

function downloadUrl(url, filename, revoke = false) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (revoke) URL.revokeObjectURL(url);
}

function applyNoise() {
  if (!state.guidePoints.length) {
    setMessage("ノイズガイドがありません");
    return;
  }
  pushUndo();
  const radius = Number(els.noiseRadius.value);
  const density = Number(els.noiseDensity.value) / 100;
  const jitter = Number(els.noiseJitter.value);
  const code = state.selectedCode;
  for (const point of state.guidePoints) {
    const repeats = Math.max(1, Math.round(radius * density * 2));
    for (let i = 0; i < repeats; i++) {
      const angle = Math.random() * Math.PI * 2;
      const distance = Math.random() * radius;
      const jx = Math.round((Math.random() - 0.5) * jitter);
      const jy = Math.round((Math.random() - 0.5) * jitter);
      const cx = Math.round(point.x + Math.cos(angle) * distance + jx);
      const cy = Math.round(point.y + Math.sin(angle) * distance + jy);
      const oldBrush = state.brushSize;
      state.brushSize = Math.max(1, Math.round(Math.random() * radius));
      paintCell(cx, cy, code);
      state.brushSize = oldBrush;
    }
  }
  render();
  setMessage(`ノイズ適用: ${biomeByCode.get(code).jp}`);
}

function bindEvents() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((item) => item.classList.remove("active"));
      document.querySelectorAll(".panel").forEach((item) => item.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById(`${tab.dataset.tab}Tab`).classList.add("active");
    });
  });

  document.querySelectorAll("[data-new-width]").forEach((button) => {
    button.addEventListener("click", () => {
      newMap(Number(button.dataset.newWidth), Number(button.dataset.newHeight));
    });
  });
  document.getElementById("importInput").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      if (file.name.toLowerCase().endsWith(".json") || file.type.includes("json")) {
        importJson(await file.text());
      } else {
        importImage(file);
      }
    } catch (error) {
      setMessage(error.message || "読込に失敗しました");
    }
    event.target.value = "";
  });
  document.getElementById("exportPngBtn").addEventListener("click", exportPng);
  document.getElementById("exportJsonBtn").addEventListener("click", exportJson);
  if (els.layerBiomeBtn) els.layerBiomeBtn.addEventListener("click", () => setActiveLayer("biome"));
  if (els.layerZoneBtn) els.layerZoneBtn.addEventListener("click", () => setActiveLayer("zone"));
  if (els.zoneTransToggle) els.zoneTransToggle.addEventListener("change", (e) => { state.zoneTransparent = e.target.checked; render(); });
  if (els.zoneBiomeFilter) els.zoneBiomeFilter.addEventListener("change", (e) => { state.zoneBiomeFilter = e.target.value; });
  if (els.exportZoneJsonBtn) els.exportZoneJsonBtn.addEventListener("click", exportZoneJson);
  if (els.coverageCheckBtn) els.coverageCheckBtn.addEventListener("click", runCoverageCheck);
  if (els.coverageFixBtn) els.coverageFixBtn.addEventListener("click", autoFixCoverage);
  if (els.coverageShowToggle) els.coverageShowToggle.addEventListener("change", (e) => toggleDeadOverlay(e.target.checked));
  if (els.importZoneInput) {
    els.importZoneInput.addEventListener("change", async (event) => {
      const file = event.target.files[0];
      if (!file) return;
      try {
        importZoneJson(await file.text());
      } catch (error) {
        setMessage(error.message || "地理圏JSONの読込に失敗しました");
      }
      event.target.value = "";
    });
  }
  if (els.exportMapSetBtn) {
    els.exportMapSetBtn.addEventListener("click", () => {
      exportMapSet().catch((error) => setMessage(error.message || ".blmap の保存に失敗しました"));
    });
  }
  if (els.exportMapSetAsBtn) {
    els.exportMapSetAsBtn.addEventListener("click", () => {
      exportMapSetAs().catch((error) => setMessage(error.message || ".blmap の保存に失敗しました"));
    });
  }
  if (els.importMapSetBtn) {
    els.importMapSetBtn.addEventListener("click", () => {
      openMapSet().catch((error) => setMessage(error.message || ".blmap の読込に失敗しました"));
    });
  }
  if (els.importMapSetInput) {
    els.importMapSetInput.addEventListener("change", async (event) => {
      const file = event.target.files[0];
      if (!file) return;
      try {
        const ok = importMapSet(await file.text());
        if (ok) {
          // input 経由では上書きハンドルは取れないが、ファイル名は覚えておく
          localStorage.setItem(BLMAP_NAME_KEY, file.name || defaultBlmapFilename());
          syncBlmapPathUi();
        }
      } catch (error) {
        setMessage(error.message || ".blmap の読込に失敗しました");
      }
      event.target.value = "";
    });
  }
  document.getElementById("clearMapBtn").addEventListener("click", clearCurrentMap);
  document.getElementById("applyCanvasSizeBtn").addEventListener("click", () => {
    applyCanvasSize(els.canvasWidthInput.value, els.canvasHeightInput.value);
  });
  const applySizeOnEnter = (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      applyCanvasSize(els.canvasWidthInput.value, els.canvasHeightInput.value);
    }
  };
  els.canvasWidthInput.addEventListener("keydown", applySizeOnEnter);
  els.canvasHeightInput.addEventListener("keydown", applySizeOnEnter);
  els.canvasWidthInput.addEventListener("input", () => syncLinkedSizeInput("width"));
  els.canvasHeightInput.addEventListener("input", () => syncLinkedSizeInput("height"));
  els.aspectLockBtn.addEventListener("click", () => {
    setAspectRatioLocked(!state.aspectRatioLocked);
    setMessage(state.aspectRatioLocked ? "縦横比を固定しました" : "縦横比ロックを解除しました");
  });
  syncAspectLockButton();
  document.getElementById("undoBtn").addEventListener("click", undo);
  document.getElementById("redoBtn").addEventListener("click", redo);
  els.selectionConfirmBtn?.addEventListener("click", () => confirmPendingAction());
  els.selectionCancelBtn?.addEventListener("click", () => cancelPendingAction());

  document.addEventListener("keydown", (event) => {
    if (event.key === "Alt") {
      state.optionKeyHeld = true;
      syncCanvasCursor();
    }
    if (event.key === "Escape") {
      if (state.pendingCrop || state.cropInteraction) {
        cancelPendingCrop();
        return;
      }
      if (state.pendingSelectionEdit) {
        cancelPendingSelectionEdit();
        return;
      }
      if (state.selection || state.selectInteraction) {
        clearSelection();
        renderGuide();
        setMessage("選択を解除しました");
      }
      return;
    }
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
    const target = event.target;
    if (
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLElement && target.isContentEditable) ||
      (target instanceof HTMLInputElement && !["range", "file", "button", "checkbox", "radio"].includes(target.type))
    ) {
      return;
    }
    const key = event.key.toLowerCase();
    if (key === "z" && event.shiftKey) {
      event.preventDefault();
      redo();
    } else if (key === "z") {
      event.preventDefault();
      undo();
    }
  });
  document.addEventListener("keyup", (event) => {
    if (event.key === "Alt") {
      state.optionKeyHeld = false;
      syncCanvasCursor();
    }
  });
  window.addEventListener("blur", () => {
    state.optionKeyHeld = false;
    syncCanvasCursor();
  });
  document.getElementById("fitBtn").addEventListener("click", () => {
    fitToView();
    render();
  });
  document.getElementById("clearHighlightBtn").addEventListener("click", () => {
    state.highlight.clear();
    syncPaletteState();
    render();
  });
  document.getElementById("clearMaskBtn").addEventListener("click", () => {
    state.mask.clear();
    syncPaletteState();
    scheduleAutosave();
  });
  document.getElementById("maskAllBtn").addEventListener("click", () => {
    for (const biome of BIOMES) state.mask.add(biome.code);
    syncPaletteState();
    scheduleAutosave();
  });
  document.getElementById("applyNoiseBtn").addEventListener("click", applyNoise);
  document.getElementById("clearGuideBtn").addEventListener("click", () => {
    state.guidePoints = [];
    renderGuide();
    scheduleAutosave();
  });
  document.getElementById("addReplaceRuleBtn").addEventListener("click", () => {
    state.replaceRules.push(createReplaceRule());
    renderReplaceRules();
    scheduleAutosave();
    refreshReplacePreviewIfActive();
  });
  document.getElementById("previewReplaceRulesBtn").addEventListener("click", previewReplaceRules);
  document.getElementById("clearReplacePreviewBtn").addEventListener("click", clearReplacePreview);
  document.getElementById("runReplaceRulesBtn").addEventListener("click", applyReplaceRules);

  els.toolField.addEventListener("change", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.name !== "tool") return;
    state.tool = input.value;
    syncToolUi();
    scheduleAutosave();
  });
  els.brushSizeField.querySelectorAll("[data-brush-size]").forEach((button) => {
    button.addEventListener("click", () => {
      state.brushSize = Number(button.dataset.brushSize);
      syncBrushSizeUi();
      scheduleAutosave();
    });
  });
  els.zoomRange.addEventListener("input", () => {
    const wrapRect = wrap.getBoundingClientRect();
    applyZoom(Number(els.zoomRange.value), wrapRect.left + wrap.clientWidth / 2, wrapRect.top + wrap.clientHeight / 2);
    render();
  });
  els.showGridToggle.addEventListener("change", () => {
    state.showGrid = els.showGridToggle.checked;
    renderGuide();
    scheduleAutosave();
  });
  [els.noiseRadius, els.noiseDensity, els.noiseJitter].forEach((input) => {
    input.addEventListener("input", () => {
      updateInfo();
      scheduleAutosave();
    });
  });

  window.addEventListener("beforeunload", flushAutosave);

  bindPinchZoom();

  canvas.addEventListener("pointerdown", (event) => {
    if (state.isPinching || pinchZoomActivePointers.size > 1) return;
    const point = canvasPoint(event);
    if (isOptionPickActive(event)) {
      pickBiomeAt(point.x, point.y);
      return;
    }
    state.isDrawing = true;
    state.lastCell = point;
    canvas.setPointerCapture(event.pointerId);
    if (state.tool === "pan") {
      state.panStart = { x: event.clientX, y: event.clientY };
      state.wrapScrollStart = { x: wrap.scrollLeft, y: wrap.scrollTop };
      return;
    }
    if (state.tool === "picker") {
      pickBiomeAt(point.x, point.y);
      return;
    }
    if (state.tool === "fill") {
      floodFill(point.x, point.y);
      return;
    }
    if (state.tool === "guide") {
      state.guidePoints.push(point);
      renderGuide();
      return;
    }
    if (state.tool === "crop") {
      if (state.pendingSelectionEdit) {
        setMessage("先に○または×で変形を確定/キャンセルしてください");
        state.isDrawing = false;
        return;
      }
      const clamped = {
        x: Math.max(0, Math.min(state.width - 1, point.x)),
        y: Math.max(0, Math.min(state.height - 1, point.y)),
      };
      state.pendingCrop = null;
      syncSelectionConfirmUi();
      state.cropInteraction = { start: clamped, current: { ...clamped } };
      renderGuide();
      return;
    }
    if (state.tool === "select") {
      if (state.pendingCrop) {
        setMessage("先に○または×で切り取りを確定/キャンセルしてください");
        state.isDrawing = false;
        return;
      }
      const pointF = canvasPointFloat(event);
      const handle = hitSelectionHandle(pointF);
      const working = getWorkingSelection();
      if (state.selection && handle?.type === "rotate") {
        const bounds = selectionBounds(working.cells);
        state.selectInteraction = {
          type: "rotate",
          handle: handle.id,
          baseEntries: working.entries.map((entry) => ({ ...entry })),
          center: { cx: bounds.cx, cy: bounds.cy },
          startAngle: Math.atan2(pointF.y - bounds.cy, pointF.x - bounds.cx),
          angle: 0,
        };
        renderGuide();
        return;
      }
      if (state.selection && (handle?.type === "scale-corner" || handle?.type === "scale-edge")) {
        const bounds = selectionBounds(working.cells);
        state.selectInteraction = {
          type: "scale",
          mode: handle.type,
          handle: handle.id,
          baseEntries: working.entries.map((entry) => ({ ...entry })),
          baseBounds: bounds,
          scale: { anchorX: bounds.cx, anchorY: bounds.cy, scaleX: 1, scaleY: 1 },
        };
        renderGuide();
        return;
      }
      if (state.selection && isDisplayedCellSelected(point.x, point.y)) {
        state.selectInteraction = {
          type: "move",
          grab: point,
          offset: { dx: 0, dy: 0 },
          baseCells: new Map(working.cells),
          baseEntries: working.entries.map((entry) => ({ ...entry })),
        };
      } else {
        if (state.pendingSelectionEdit) {
          setMessage("先に○または×で変形を確定/キャンセルしてください");
          state.isDrawing = false;
          return;
        }
        clearSelection();
        state.selectInteraction = { type: "lasso", points: [point] };
      }
      renderGuide();
      return;
    }
    pushUndo();
    paintCell(point.x, point.y);
    render();
  });

  canvas.addEventListener("pointermove", (event) => {
    const point = canvasPoint(event);
    state.lastCanvasPoint = point;
    state.lastCanvasPointFloat = canvasPointFloat(event);
    els.cursorInfo.textContent = `x:${point.x} y:${point.y}`;
    syncCanvasCursor();
    if (state.isPinching) return;
    if (!state.isDrawing || isOptionPickActive(event)) return;
    if (state.tool === "pan") {
      wrap.scrollLeft = state.wrapScrollStart.x - (event.clientX - state.panStart.x);
      wrap.scrollTop = state.wrapScrollStart.y - (event.clientY - state.panStart.y);
      return;
    }
    if (state.tool === "guide") {
      state.guidePoints.push(point);
      renderGuide();
      return;
    }
    if (state.tool === "crop" && state.cropInteraction) {
      state.cropInteraction.current = {
        x: Math.max(0, Math.min(state.width - 1, point.x)),
        y: Math.max(0, Math.min(state.height - 1, point.y)),
      };
      renderGuide();
      return;
    }
    if (state.tool === "select" && state.selectInteraction?.type === "lasso") {
      const last = state.selectInteraction.points.at(-1);
      if (!last || last.x !== point.x || last.y !== point.y) {
        state.selectInteraction.points.push(point);
      }
      renderGuide();
      return;
    }
    if (state.tool === "select" && state.selectInteraction?.type === "move") {
      state.selectInteraction.offset = {
        dx: point.x - state.selectInteraction.grab.x,
        dy: point.y - state.selectInteraction.grab.y,
      };
      renderGuide();
      return;
    }
    if (state.tool === "select" && state.selectInteraction?.type === "rotate") {
      const { center, startAngle } = state.selectInteraction;
      const pointF = state.lastCanvasPointFloat;
      const currentAngle = Math.atan2(pointF.y - center.cy, pointF.x - center.cx);
      state.selectInteraction.angle = currentAngle - startAngle;
      renderGuide();
      return;
    }
    if (state.tool === "select" && state.selectInteraction?.type === "scale") {
      const { mode, handle, baseBounds } = state.selectInteraction;
      const pointF = state.lastCanvasPointFloat;
      state.selectInteraction.scale =
        mode === "scale-corner"
          ? computeScaleFromCorner(baseBounds, handle, pointF)
          : computeScaleFromEdge(baseBounds, handle, pointF);
      renderGuide();
      return;
    }
    if (state.tool !== "paint") return;
    linePaint(state.lastCell, point);
    state.lastCell = point;
    render();
  });

  canvas.addEventListener("pointerup", () => {
    if (state.cropInteraction) {
      const rect = normalizeCropRect(state.cropInteraction.start, state.cropInteraction.current);
      state.cropInteraction = null;
      state.isDrawing = false;
      state.lastCell = null;
      if (rect.width < 1 || rect.height < 1) {
        clearPendingCrop({ silent: true });
        renderGuide();
        return;
      }
      setPendingCrop(rect);
      renderGuide();
      return;
    }
    if (state.selectInteraction?.type === "lasso") {
      finalizeLasso(state.selectInteraction.points);
      state.selectInteraction = null;
      state.isDrawing = false;
      state.lastCell = null;
      renderGuide();
      return;
    }
    if (state.selectInteraction?.type === "move") {
      bakePendingFromDisplayed();
      state.selectInteraction = null;
      state.isDrawing = false;
      state.lastCell = null;
      renderGuide();
      return;
    }
    if (state.selectInteraction?.type === "rotate") {
      bakePendingFromDisplayed();
      state.selectInteraction = null;
      state.isDrawing = false;
      state.lastCell = null;
      renderGuide();
      return;
    }
    if (state.selectInteraction?.type === "scale") {
      bakePendingFromDisplayed();
      state.selectInteraction = null;
      state.isDrawing = false;
      state.lastCell = null;
      renderGuide();
      return;
    }
    const wasDrawing = state.isDrawing;
    state.isDrawing = false;
    state.lastCell = null;
    if (wasDrawing) flushAutosave();
  });
  canvas.addEventListener("pointerenter", () => {
    if (state.optionKeyHeld) syncCanvasCursor();
  });
  canvas.addEventListener("pointerleave", () => {
    const wasDrawing = state.isDrawing;
    state.isDrawing = false;
    state.lastCell = null;
    state.lastCanvasPoint = null;
    state.lastCanvasPointFloat = null;
    hideBrushCursor();
    if (wasDrawing) flushAutosave();
  });
}

function init() {
  buildPalette();
  bindEvents();
  const restored = loadAutosave();
  if (!restored) {
    state.grid = createGrid(state.width, state.height, "OCN");
  }
  ensureZoneGrid();
  updateLayerUi();
  buildPalette();
  buildZoneBiomeFilter();
  renderReplaceRules();
  syncPaletteState();
  syncToolUi();
  syncBrushSizeUi();
  resizeCanvases();
  render();
  restoreBlmapHandle().catch((error) => console.warn("blmap path restore failed", error));
  setMessage(restored ? "前回の作業を復元しました" : "準備完了");
  if (new URLSearchParams(location.search).has("test")) {
    window.__mapMakerTest = {
      ready: true,
      getCell: (x, y) => state.grid[y]?.[x] ?? null,
      getZoneCell: (x, y) => state.zoneGrid[y]?.[x] ?? null,
      getLayer: () => state.activeLayer,
      setGrids: (brows, zrows) => {
        state.height = brows.length;
        state.width = brows[0].length / 3;
        state.grid = brows.map((r) => { const c = []; for (let i = 0; i < r.length; i += 3) c.push(r.slice(i, i + 3)); return c; });
        state.zoneGrid = zrows.map((r) => { const c = []; for (let i = 0; i < r.length; i += 3) c.push(r.slice(i, i + 3)); return c; });
        setActiveLayer("zone");
        resizeCanvases();
        render();
      },
      covResultText: () => els.coverageResult?.textContent ?? "",
      covDeadCount: () => state.coverage.dead.length,
      getCursor: () => (state.lastCanvasPoint ? { ...state.lastCanvasPoint } : null),
      getTool: () => state.tool,
      getBrushSize: () => state.brushSize,
      getZoom: () => state.zoom,
    };
  }
}

init();
