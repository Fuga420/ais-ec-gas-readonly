# AIドラフト推論パイプライン・検証設計・想定経路 ダイアグラム集

AI出品ドラフト生成（PR #12）における推論制御パイプライン全体像、および実画像テスト（TMP-000113、TMP-000114）の検証設計・想定通過経路を可視化した図面集です（※実測ログ取得待ち）。

---

## 📁 収録ファイル一覧

| ファイル名 | 種別 | 説明・用途 |
| :--- | :--- | :--- |
| **[`ai_draft_inference_flow.html`](./ai_draft_inference_flow.html)** | 🌐 **HTML（推奨）** | **ブラウザでダブルクリックして開くと、各図をワンクリックで SVG / PNG 画像としてPCにダウンロードできます。** |
| **[`ai_draft_inference_flow.md`](./ai_draft_inference_flow.md)** | 📝 **Markdown** | GitHub Web上やMarkdownプレビューアーでダイアグラムをそのまま閲覧できます。 |
| **[`01_overall_inference_pipeline.mmd`](./01_overall_inference_pipeline.mmd)** | 📊 **Mermaid Raw** | 図1（推論パイプライン全体フロー）のMermaidソースコード |
| **[`02_tmp_000113_pokemon_card_flow.mmd`](./02_tmp_000113_pokemon_card_flow.mmd)** | 📊 **Mermaid Raw** | 図2（TMP-000113 ポケカ想定通過経路）のMermaidソースコード |
| **[`03_tmp_000114_sneaker_flow.mmd`](./03_tmp_000114_sneaker_flow.mmd)** | 📊 **Mermaid Raw** | 図3（TMP-000114 スニーカー想定通過経路）のMermaidソースコード |

---

## 📥 画像（SVG / PNG）としての保存方法

1. Finder またはファイラーで本フォルダ（`docs/diagrams/`）を開きます。
2. **`ai_draft_inference_flow.html`** をダブルクリックしてブラウザ（Chrome, Safari等）で開きます。
3. 各図の右上に表示される **「📥 SVG保存」** または **「📥 PNG保存」** ボタンをクリックすると、高解像度の画像ファイルがダウンロードフォルダに保存されます。

---

## 📊 図の概要

### 1. 推論パイプライン全体フロー (`01_overall_inference_pipeline.mmd`)
- 先行カテゴリー判定（`classifyCategoryPriorFromImages_`）
- カテゴリ別 Stage A（ポケカ専用／スニーカー専用／汎用客観検査）
- 柔軟抽出パーサー（`parseStageASections_`）によるマークダウン・自然文の安全パース
- Stage B による構造化ドラフト生成
- カテゴリ救済ロジック（先行分類未確定時の後段特定救済）
- スニーカー型番候補判定（箱ラベル未撮影時のモデル整合性検証＋検索型番候補提示＋出典注記＋`needs_review: sku`）
- 価格根拠検査（成約取引一致／同一モデル比較可能参考価格案）
- ポケカ裏面未撮影サニタイズ（状態の空欄化）

### 2. TMP-000113 検証設計・想定通過経路 (`02_tmp_000113_pokemon_card_flow.mmd`)
- 表面写真1枚からの判定
- 先行分類: `pokemon_card` (high)
- 視認・抽出: ミュウex / M6a / 129/103 / SAR
- Stage B 生成: ミュウex [M6a 129/103] 30th CELEBRATION
- サニタイズ: `condition: ""`（要確認フラグ付与）
- 価格案: 直近取引参照案（`recent_transaction_reference`）

### 3. TMP-000114 検証設計・想定通過経路 (`03_tmp_000114_sneaker_flow.mmd`)
- シューズ外観写真1枚（箱ラベル未撮影）からの判定
- 先行分類: 一時パースエラー（未確定）
- 汎用客観検査 Stage A: Nike Kobe 外観特定、検索で型番 `IB4481-500` 確認（Kobe V Protro “Year of the Mamba” Eggplant）
- 後段カテゴリ救済: `sneaker` 確定
- 型番候補設定: `sku: "IB4481-500"`, `sku_source: "search_corroborated"`, 出典注記付与
- 価格案: サイズ未確認・同一モデル成約（`comparable_model`）参考価格案算出（自動確定遮断）
