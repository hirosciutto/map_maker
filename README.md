# Blockland Map Maker

Blockland の `biome_map` を手作業で編集するための静的Webツールです。

## 起動

```bash
cd /Users/nakashima/works/map_maker
python3 -m http.server 5173
```

ブラウザで `http://localhost:5173/` を開きます。

## できること

- 複数マップを上部タブで同時に開いて編集（新規作成・画像/JSON・`.blmap` 読み込みは新規タブ）
- レイヤー、Undo/Redo、ズーム、グリッド、ファイル/ツール設定、`.blmap` 保存先をタブごとに保持
- パレットの選択・ハイライト/マスクと描画ツール・ブラシサイズは全タブで共有
- `256×256` / `384×256` / `512×512` / `768×512` の新規マップ作成
- PNG/JPEG/WebP画像の読み込み
  - 読み込んだ各ピクセルは、必ず許可済みバイオーム色の最近傍へ量子化されます
- `biome_map.json` の読み込み（ファイル選択）
- 許可済みバイオーム色だけでのペイント
- パレット左チェックによるバイオームハイライト
- パレット中央チェックによるバイオームマスク
  - 例: `海` をマスクすると、海セルを塗り替えずに陸だけ編集できます
- ノイズガイド
  - `ノイズガイド` ツールで海岸線などをなぞる
  - `ノイズ実行` で、選択中バイオームをガイド周辺へ不規則に描き込み
  - マスクしたバイオームは侵食されません
- PNG / JSON 出力
- バイオーム置換
  - 置換先に `面したバイオーム` を選ぶと、対象マスの上下左右にある「対象マス自身とは異なるバイオーム」からランダムで1つを選んで置換します
  - このモードでは、上下左右に別バイオームが存在しないマスは置換対象になりません

## バイオーム制約

./docs/geo-reproduction-design.md を参照してください。

## 標高ティア

各バイオームは実在地域の代表標高（m）を `elevation` として持ちます。出典: [blockland/docs/design.md](../blockland/docs/design.md) §5.A.0。

| ティア | 代表m | 用途 |
|---|---:|---|
| T−2 | −8000 | 海溝 |
| T−1 | −4000 | 深海 |
| T0 | −100 | 大陸棚・浅海 |
| T1 | 0 | 海岸 |
| T2 | 100 | 低地平野 |
| T3 | 500 | 丘陵・台地 |
| T4 | 1200 | 高地・低高原 |
| T5 | 2200 | 山地 |
| T6 | 3500 | 高々度高原・氷冠 |
| T7 | 4800 | 高山・超高高原 |
| T8 | 6500 | 超高山 |
| T9 | 8500 | 極高山 |

## 標高マッピング（elevToY）

実標高（m）をブロック Y へ写す区分線形マッピングです。海面 Y = 62。

| 実標高帯 | 縮尺 | Y範囲 |
|---|---|---|
| −8000 〜 −400 m（深海・海溝） | 段階圧縮 ≈271 m/ブロック | Y14 〜 42 |
| −400 〜 2000 m（海面下盆地〜低地〜山地） | 1ブロック = 20 m | Y42 〜 162 |
| 2000 〜 5000 m（高山帯） | 1ブロック = 40 m | Y162 〜 237 |
| 5000 〜 8500 m（最高峰帯） | 1ブロック ≈ 58.3 m | Y237 〜 297 |

## 確定バイオーム一覧（62種・標高昇順）

出典: [blockland/docs/design.md](../blockland/docs/design.md) §5.A.0。`ISL` 南国の島は v2.10 で廃止。

| elevation | code | 旧 | jp / name | category | temp | humidity | relief | color |
|---:|:---:|:---:|---|---|---|---|---|:---:|
| -8000 | `TRN` | — | 海溝 / ocean_trench | coastal | cold | wet | rugged | `#102437` |
| -4000 | `DPO` | — | 深海 / deep_ocean | coastal | cold | wet | rolling | `#1e4267` |
| -200 | `DEP` | — | 海面下盆地 / depression | arid | hot | dry | flat | `#be9c37` |
| -100 | `SHF` | — | 浅海・大陸棚 / shelf_sea | coastal | temperate | wet | flat | `#2c6196` |
| 0 | `OCN` | `O` | 海 / ocean | coastal | temperate | wet | flat | `#3270ae` |
| 0 | `MNG` | — | マングローブ / mangrove | coastal | hot | wet | flat | `#356e65` |
| 5 | `BCH` | `B` | 浜 / beach | coastal | temperate | wet | flat | `#ffe1b2` |
| 50 | `TWN` | `T` | セントラルシティ / town | hub | temperate | mid | flat | `#808080` |
| 50 | `WET` | `W` | 湿地 / wetland | wetland | temperate | wet | flat | `#38756b` |
| 100 | `PLN` | `P` | 平原 / plains | grassland | temperate | mid | flat | `#527e25` |
| 100 | `JGL` | `J` | 平地ジャングル / lowland_jungle | jungle | hot | wet | flat | `#15653d` |
| 100 | `PLR` | — | 極地砂漠 / polar_desert | frozen | cold | dry | flat | `#91c5ca` |
| 150 | `MDW` | `Y` | 花畑メドウ / meadow | grassland | temperate | mid | flat | `#73b234` |
| 200 | `FOR` | `R` | 森林 / forest | forest | temperate | mid | rolling | `#2b5922` |
| 200 | `DSR` | `D` | 砂漠 / desert | arid | hot | dry | rolling | `#cdae51` |
| 250 | `SAV` | `V` | サバンナ / savanna | grassland | hot | dry | flat | `#b8df90` |
| 300 | `SNW` | `S` | 雪原 / snowfield | frozen | cold | mid | flat | `#94c7cc` |
| 300 | `SHR` | — | 地中海性低木 / shrubland | grassland | temperate | dry | rolling | `#6c6a37` |
| 300 | `DRF` | — | 熱帯季節林 / dry_forest | jungle | hot | mid | rolling | `#197647` |
| 400 | `TND` | `U` | ツンドラ / tundra | frozen | cold | dry | flat | `#98c9cd` |
| 400 | `STP` | — | 温帯ステップ / steppe | grassland | temperate | dry | flat | `#76743d` |
| 400 | `THN` | — | 半乾燥低木 / thorn_scrub | arid | hot | dry | flat | `#d0b35d` |
| 500 | `WDH` | `F` | 山林 / wooded_hills | forest | temperate | mid | rugged | `#428934` |
| 500 | `ICE` | — | 氷床 / ice_sheet | frozen | cold | wet | flat | `#9bcbcf` |
| 600 | `TGA` | `C` | タイガ / taiga | forest | cold | mid | rolling | `#295b46` |
| 800 | `PLT` | `A` | 高原 / plateau | grassland | temperate | mid | rolling | `#97954e` |
| 800 | `DRU` | — | 丘陵季節林 / monsoon_upland | jungle | hot | mid | rolling | `#23a463` |
| 900 | `CTG` | `H` | 寒冷タイガ / cold_taiga | forest | cold | mid | rolling | `#3e896a` |
| 900 | `MJG` | `G` | 山地ジャングル / montane_jungle | jungle | hot | wet | rugged | `#25ad69` |
| 1000 | `MSA` | `E` | メサ / mesa | mountain | hot | dry | rugged | `#9b4427` |
| 1000 | `DPL` | `Q` | 乾燥高原 / dry_plateau | arid | temperate | dry | rolling | `#dec98c` |
| 1000 | `CDS` | — | 寒冷砂漠 / cold_desert | arid | cold | dry | rolling | `#7e6144` |
| 1000 | `SVH` | — | 高地サバンナ / highland_savanna | grassland | hot | dry | rolling | `#a8a657` |
| 1100 | `MFR` | — | 山地林 / montane_forest | forest | temperate | mid | rugged | `#88cd7a` |
| 1200 | `RPL` | `L` | 岩石高原 / rocky_plateau | mountain | temperate | dry | rolling | `#b44f2d` |
| 1200 | `MOR` | `2` | 高層湿原 / high_moor | wetland | cold | wet | flat | `#9fd1c8` |
| 1200 | `IFD` | — | 氷原 / icefield | frozen | cold | wet | rolling | `#acd4d7` |
| 1300 | `HST` | — | 高原ステップ / highland_steppe | grassland | cold | dry | rolling | `#b4b26e` |
| 1400 | `RFM` | — | 中山ジャングル / montane_rainforest | jungle | hot | wet | rugged | `#31d382` |
| 1500 | `SUB` | `1` | 亜高山林 / subalpine_forest | forest | cold | mid | rugged | `#87c9ae` |
| 1500 | `HDS` | `Z` | 高地砂漠 / highland_desert | arid | temperate | dry | rolling | `#e8dab0` |
| 1800 | `VOL` | `K` | 火山 / volcano | mountain | hot | dry | peak | `#d88164` |
| 1900 | `SST` | — | 亜高山ステップ / subalpine_steppe | grassland | cold | dry | rolling | `#cecda1` |
| 2000 | `MTN` | `M` | 山岳 / mountain | mountain | cold | mid | rugged | `#2b2e31` |
| 2000 | `GLC` | `I` | 氷河・山岳 / glacier | frozen | cold | wet | rugged | `#a6b9c9` |
| 2000 | `CLF` | — | 雲霧林 / cloud_forest | jungle | hot | wet | rugged | `#68dfa3` |
| 2200 | `CDM` | — | 山地寒冷砂漠 / montane_cold_desert | arid | cold | dry | rolling | `#b18f6d` |
| 2500 | `ALG` | `3` | 高山草原 / alpine_grassland | alpine | cold | mid | rolling | `#5c663d` |
| 2800 | `ARK` | — | 高山岩稜 / alpine_rock | mountain | cold | mid | rugged | `#43474c` |
| 3000 | `ALT` | `4` | 高山ツンドラ / alpine_tundra | alpine | cold | dry | rolling | `#7e8c54` |
| 3200 | `CDH` | — | 高地寒冷砂漠 / high_cold_desert | arid | cold | dry | flat | `#cdb7a2` |
| 3500 | `SNM` | `X` | 雪の山岳 / snowy_mtn | alpine | cold | mid | peak | `#c4c7ca` |
| 3500 | `IDM` | — | 氷冠高原 / ice_dome | frozen | cold | wet | flat | `#e3f1f2` |
| 3600 | `SLT` | — | 塩原 / salt_flat | arid | cold | dry | flat | `#cdb8a2` |
| 3600 | `HRK` | — | 高峰岩壁 / high_rock | mountain | cold | dry | rugged | `#5b6167` |
| 3800 | `AFF` | — | 高山荒原 / alpine_fell | alpine | cold | dry | rolling | `#acb889` |
| 4200 | `CHL` | — | 寒冷高原 / cold_highland | alpine | cold | dry | flat | `#c1c9a6` |
| 4500 | `HGL` | — | 高地氷河 / high_glacier | frozen | cold | wet | rugged | `#ccd7e0` |
| 4800 | `HMT` | — | 高山 / high_mountain | alpine | cold | mid | rugged | `#d1d4d6` |
| 5500 | `PSN` | — | 万年雪冠 / permanent_snow | alpine | cold | wet | peak | `#d6d9db` |
| 6800 | `XPK` | — | 超高山峰 / extreme_peak | alpine | cold | dry | peak | `#e4e6e7` |
| 8500 | `HIM` | — | 極高山・ヒマラヤ / himalaya | alpine | cold | dry | peak | `#f4f5f5` |

旧1文字コードは「旧」列に従って3文字コードへ変換します。旧 `R=火山島` と解釈できる古い JSON は `VOL` へ移行します（v1.88 以降の `R` は `FOR` 森林）。

## biome_map.json の読み込み

`ファイル > 画像/JSONを読み込み` から `biome_map.json` を選択してください。
