# 検索付きAI商品情報生成（Google Search Grounding / 2段階パイプライン / gemini-3.8-flash 必須化）実装メモ

作成日: 2026-10-09 (JST)  
ステータス: 完了（PR #5 にて main マージ済み、本番 Web App v83 配信・実機検証済み）  
対象コンポーネント: GAS バックエンド（`llm_product_draft.js`, `tests.js`, `AI_BATCH_API_CONTRACT.md`）  
非対象（非変更）: Readdy フロントエンド、中継サーバー（`gas-ai-batch-relay`）、Square 連携コア（`コード.js`）、複数商品画像取込（`import_attempts` / v82）

---

## 1. 背景と課題

### 1.1 従来の1回方式（gemini-3.5-flash-lite）における課題
- **視覚的特徴の誤読とハルシネーション**:
  - 実例: `TMP-000100`（黒い外箱に大きな赤い「BIKE」ロゴ）において、モデルが「BIKE」を「NIKE」と誤認し、「Nike Air Flight 89」等の全く異なるスニーカーを検索・提案する事象が発生。
- **検索未実行時のフォールバック不全（サイレントサクセス）**:
  - Web検索ツールを指定しても、モデルが検索を実行せずに内部知識のみで生成を終えた場合、HTTP 200が返却されるため「生成成功」として扱われていた。
  - その結果、検索根拠のない不正確な商品名が本票へ自動反映されるリスクが存在した。
- **API仕様の競合（REST tools と responseSchema）**:
  - Gemini REST API において、`tools: [{ google_search: {} }]`（Web検索ツール）と `generationConfig.responseSchema`（JSONスキーマ指定）を同時に送信すると、仕様の非互換性により HTTP 400 等のエラーが発生する制約があった。

---

## 2. 設計方針とアーキテクチャ

### 2.1 2段階パイプライン（Two-Stage Pipeline）の標準化
検索ツールとJSONスキーマの競合を回避し、画像からの客観的特徴抽出とWeb検索を確実に行うため、生成処理を2段階に分離した。

```
[商品画像 (Base64) + カテゴリ + ブランド]
                  │
                  ▼
┌────────────────────────────────────────────────────────┐
│ Stage A: 特徴観察＆自律Web検索 (gemini-3.8-flash)       │
│  - 画像から文字・マーク・外観特徴を自律抽出            │
│  - 本票の商品名・SKUはプロンプトに含めない (ヒント排除)│
│  - tools: [{ google_search: {} }] でGoogle検索実行      │
│  - 検索クエリ・参照元URLの存在を検証                   │
└────────────────────────────────────────────────────────┘
                  │
                  │ (検索クエリ・参照元あり確認)
                  ▼
┌────────────────────────────────────────────────────────┐
│ Stage B: 構造化JSONスキーマ整形 (gemini-3.8-flash)     │
│  - Stage A の生成文・検索根拠を入力                    │
│  - responseMimeType: "application/json"                │
│  - responseSchema に準拠した確定JSON生成               │
│  - ツール指定なし (APIスキーマ競合を完全回避)          │
└────────────────────────────────────────────────────────┘
                  │
                  ▼
[商品ドラフト候補 (candidate) 出力]
```

#### Stage A: 特徴観察＆自律Web検索
- **入力情報**: 商品画像（Drive画像Base64）＋カテゴリ（`category`）＋ブランド（`brand`）のみ。
- **プロンプト純化（ヒント完全排除）**:
  - 本票の既存商品名、既存SKU、事前ヒント（「BIKE」等の推測語）は一切入力に混ぜない完全自律特定設計。
- **観察順序の構造化プロンプト**:
  1. **Step 1**: 画像から直接視認できる文字・ロゴ・マーキングの正確な書き起こし。
  2. **Step 2**: 外観・形状・カラー・素材の客観的記述。
  3. **Step 3**: 観察特徴に基づく Google Web 検索照合。
  4. **Step 4**: 検索結果に基づく推奨商品名・モデル公式呼称の特定。
  5. **Step 5**: 現物画像内の品番ラベル有無の確認。
- **ツール指定**: REST API 仕様準拠（`tools: [{ google_search: {} }]`）。
- **完了判定（Fail-Closed）**:
  - `groundingMetadata.webSearchQueries`（1件以上）および `groundingChunks`（参照元1件以上）の返却を必須化。
  - 検索未実行時は即座に中断し、Stage B へ進まない。

#### Stage B: 構造化JSONスキーマ整形
- **役割**: Stage A のテキスト出力および検索グラウンディング結果を受け取り、商品ドラフト用の JSON スキーマへ構造化整形。
- **出力形式**:
  - `responseMimeType: "application/json"`
  - `responseSchema`（`product_name`, `suggested_price`, `description`, `bullet_points`, `attributes` 等）。
- **ツール指定**: 検索ツールは指定せずスキーマ整形に専念し、REST API の仕様衝突を根本から解消。

---

## 3. 安全設計・フェイルクローズ・データ整合性

### 3.1 検索必須化と自動反映遮断
- 検索有効設定時、Stage A で検索クエリが0件、または参照元が0件の場合、Stage B の呼び出しを行わず即座に `SEARCH_GROUNDING_NOT_EXECUTED` エラーとして処理を中断。
- 未検索候補や検索失敗データを `product_ai_drafts` の確定候補として本票へ自動反映させない（`pending_review` または `failed` 扱いとし、未確認データでの確定・公開を防ぐ）。

### 3.2 SKU保護原則（品番ラベル目視基準）
- 検索によって得られた型番・品番（例: `M2002RDN` 等）は、商品名や説明文への反映は許可するが、確定SKUフィールド（`candidate.sku`）への自動代入は厳格に遮断し空文字 `""` に保護。
- **理由**: スニーカーの品番はカラー・製造年・仕様ごとに細分化されており、画像現物の品番タグ（シュータン裏や外箱ラベル）から直接目視確認された確証がない限り、モデル出力SKUを確定台帳に登録すると、Square/在庫の致命的な不整合（別商品の販売・二重引き当て）を引き起こすため。

### 3.3 PO承認仕様の遵守
- スニーカーサイズ空欄、AI価格nullの安全許容（スタッフ手動入力値を保護し、自動反映で上書きしない）。
- スタッフ入力済みの項目（価格・サイズ等）を優先保持。

---

## 4. モデル選定・料金体系・パフォーマンス特性

### 4.1 モデル選定
- **採用モデル**: `gemini-3.8-flash`
- **選定根拠**:
  - 高い画像観察能力（TMP-000100 の「BIKE」ロゴの正確な視認）。
  - Thinking プロセス（思考トークン）と検索グラウンディングの親和性。
  - 商品特定精度の顕著な向上。

### 4.2 料金体系（Gemini 3系 仕様準拠）
Gemini 3系における正しい課金体系を `AI_BATCH_API_CONTRACT.md` に明記。
- **入力トークン (`promptTokenCount`)**: \$0.75 / 100万トークン
- **出力トークン**: \$3.75 / 100万トークン
  - **重要**: `candidatesTokenCount`（返却テキスト）だけでなく、`thoughtsTokenCount`（思考プロセス）も出力トークン単価で課金対象となる。
- **Google Search Grounding**: 月間 5,000 クエリまで無料、超過分 \$0.014 / 検索クエリ。
- **計算式**:
  $$\text{Cost\_USD} = \frac{\text{promptTokenCount} \times 0.75}{10^6} + \frac{(\text{candidatesTokenCount} + \text{thoughtsTokenCount}) \times 3.75}{10^6} + \max(0, \text{Monthly\_Queries} - 5000) \times 0.014$$

### 4.3 パフォーマンス・時間特性
- 特殊なスニーカー（TMP-000102 等）では思考トークン消費（Thinking）が増加し、Stage A だけで約114秒を要するケースを確認。
- バッチキュー処理（1分間隔トリガー、5分リース期間）においてタイムアウトを起こさない設計を維持。

---

## 5. 環境設定・Script Properties と自己修復

### 5.1 Script Properties 実効値
2026-10-09 20:38 JST に本番環境の実効値を設定・確認完了。
- `AI_DRAFT_MODEL`: `gemini-3.8-flash`
- `AI_DRAFT_ENABLE_SEARCH_GROUNDING`: `true`
- `AI_DRAFT_SEARCH_GROUNDING_MODE`: `two_stage`

### 5.2 自己修復（Self-Healing）機構
- プロパティ未設定または古いモデル名（`gemini-3.5-flash-lite` 等）が残存していても、コード側の判定（`alignAiDraftModel_` / `alignAndVerifyScriptPropertiesForSearchGrounding`）により自動的に安全な推奨値へ補正・フォールバック。
- 設定整合用エントリポイント: `alignAndVerifyScriptPropertiesForSearchGrounding()`（GASエディタから引数なしで実行可能）。

### 5.3 実行環境の分離と参照関係
- 時間駆動トリガー（バッチワーカー）は常にプロジェクトの **HEAD** を実行。
- 本番 Web App は固定バージョン（`v83`）を実行。両者とも実行時に動的に Script Properties を参照するため、プロパティ変更が即時有効となる。

---

## 6. 実機検証結果の要約

### 6.1 TMP-000100 (BIKE vs NIKE 診断)
- モデル: `gemini-3.8-flash`
- 結果: Stage A 生成文にて「BIKE」が出現し、検索クエリおよび参照元経由で Bike Air（Nigel Sylvester コラボ）を正確に特定。1回方式の誤読問題を解消。

### 6.2 TMP-000109 (Readdy 実機バッチ連携)
- バッチID: `BAT_20261009_204657_hvgsf`
- 商品ID: `TMP-000109`
- 実行ログ: `model='gemini-3.8-flash'`, `mode='two_stage'`, `search_executed=true`, `queries=3`, `sources=6`
- 提案名: 「ジョウンド × ニューバランス 2002R レザー ゴアテックス "ブラック/ストーム"」が生成され、スタッフ提示の実商品と主要モデル情報が完全一致。
- 完了ステータス照合: 管理者認証が必要なAPIからの `TMP-000109` の最終 `status='completed'` については、認証キー照合を行っていないため推測せず「未確認」として記録。

---

## 7. 品質管理・運用上のルール

1. **グラウンディング達成 ≠ 商品一致保証**:
   - Web検索が実行され参照元が取得できたことは、AIが実在する商品情報に基づいて提案を生成した根拠であるが、画像との完全一致や真贋を保証するものではない。
2. **スタッフによる目視確認の必須性**:
   - 提案名、カラーウェイ、価格、サイズ、状態等の最終確認責任はスタッフにあり、AI候補は下書き・提案として運用する。
3. **Fail-Closed の徹底**:
   - 不明・判断不能・検索不成立時は処理を中断し、未確認データでの確定・公開を行わない。

---

## 8. テスト検証範囲

- `node test_harness_standalone.js`: **211/211 PASS**（GAS 内スイート 20/20 を含む）
- `node test_multi_product_import_standalone.js`: **18/18 PASS**
- `node docs/diagnostics/test_diagnose_tmp100_mock.js`: **19/19 PASS**
- 合計: **248/248 PASS**（回帰なし）

---

## 9. 関連ドキュメント・リンク

- [`AI_BATCH_API_CONTRACT.md`](file:///c:/Users/aij/Documents/ais-ec-gas/AI_BATCH_API_CONTRACT.md): AIバッチ生成API契約および料金計算式
- [`docs/handoff.md`](file:///c:/Users/aij/Documents/ais-ec-gas/docs/handoff.md): プロジェクト引き継ぎ書（最新構成・残件・eBay連携計画）
- [`docs/worklogs/2026-10-09.md`](file:///c:/Users/aij/Documents/ais-ec-gas/docs/worklogs/2026-10-09.md): 実機検証・診断ログ・作業日報
- [Pull Request #5](https://github.com/Fuga420/ais-ec-gas/pull/5): `feat(llm): mandatory search grounding with gemini-3.8-flash and two-stage pipeline`
