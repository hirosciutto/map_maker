# Blockland Map Maker

Blockland の `biome_map` を手作業で編集するための静的Webツールです。

## 起動

```bash
cd /Users/nakashima/works
python3 -m http.server 5173
```

ブラウザで `http://localhost:5173/map_maker/` を開きます。

## できること

- `256×256` / `512×512` の新規マップ作成
- PNG/JPEG/WebP画像の読み込み
  - 読み込んだ各ピクセルは、必ず許可済みバイオーム色の最近傍へ量子化されます
- `biome_map.json` の読み込み
- 許可済みバイオーム色だけでのペイント
- パレット左チェックによるバイオームハイライト
- パレット中央チェックによるバイオームマスク
  - 例: `海` をマスクすると、海セルを塗り替えずに陸だけ編集できます
- ノイズガイド
  - `ノイズガイド` ツールで海岸線などをなぞる
  - `ノイズ実行` で、選択中バイオームをガイド周辺へ不規則に描き込み
  - マスクしたバイオームは侵食されません
- PNG / JSON 出力

## バイオーム制約

パレットは `blockland/tools/generate_macro_map.py` の `LEGEND` と同じ色・コードを固定で持っています。`A 高原` / `Q 乾燥高原` も使用できます。
ツール内部のグリッドはバイオームコードで保持され、任意色は保存できません。

## 現在の `biome_map` を読み込む

`ファイル > 現在の biome_map を読み込み` を押してください。
上記のように `/Users/nakashima/works` をHTTP配信している場合、`../blockland/map/biome_map.json` を自動取得できます。
別の起動方法で失敗する場合は、手動で以下を選択してください。

```text
/Users/nakashima/works/blockland/map/biome_map.json
```
