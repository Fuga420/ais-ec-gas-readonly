# AI一括出品ドラフト生成 (Batch Draft) API契約仕様書

本ドキュメントは、ReaddyフロントエンドとGASバックエンド間の「一括AI出品ドラフト生成」に関する連携仕様を定義したものです。

---

## 1. 接続アーキテクチャ & 概要

### 1.1 概要
- クライアント（Readdy）が最大20件の商品IDを一括で受付リクエストします。
- GASバックエンドは即座に `batch_id` を発行し、HTTPレスポンスを返します（非同期受付）。
- ブラウザを閉じても、GASの時間主導型バックグラウンドワーカーが順次生成を継続します。
- 生成結果は既存の `product_ai_drafts` シートに保存されます。
  - v77以降（本番v79）のバッチワーカーは自動反映（`auto_apply`）を行い、本票・英文翻訳・ポケカ属性へ反映したうえで `review_status: "confirmed"`（`confirmed_by: "ai_batch_worker"`）として確定し、反映完了判定（`verifyProductDraftReflectionCompleted_`）を通過した場合のみ `completed` にします。
  - スタッフ入力済みの価格・サイズは上書きしません。スタッフ編集が検知された場合は反映せず `SOURCE_MODIFIED_DURING_GENERATION` で失敗します。
  - 公開・Square登録は行いません。公開時は従来どおり公開ゲート（`assertProductPublishable_`）で確定指紋・スニーカーサイズ等を検証します。
- クライアントは `batch_id` を用いて進捗・結果をポーリング取得します。
- 一部商品が失敗した場合は、成功分を再生成することなく失敗分のみを再試行できます。

### 1.2 共通認証パラメータ
既存のAIドラフトAPIと同様、管理者認証（`verifyAdminAccess_`）を適用します。
- **POST Body**:
  - `"mode": "admin"` （必須）
  - `"admin_key": "<ADMIN_API_KEY>"` （`token` または `key` でも可）
- **GET クエリ**:
  - `?mode=admin&admin_key=<ADMIN_API_KEY>`

---

## 2. API エンドポイント詳細

### 2.1 一括生成受付 (`create_ai_product_draft_batch`)
最大20件の商品IDを受け付け、バッチジョブを作成して `batch_id` を即時返却します。

- **Method**: `POST`
- **Path**: `/exec`
- **Request Body**:
  ```json
  {
    "action": "create_ai_product_draft_batch",
    "mode": "admin",
    "admin_key": "<ADMIN_API_KEY>",
    "request_id": "REQ_BATCH_20261005_001",
    "product_ids": [
      "TMP-000088",
      "TMP-000090",
      "TMP-000091"
    ],
    "force_regenerate": false
  }
  ```
  - `request_id`: 必須（クライアントが生成するUUIDやユニーク文字列。冪等性キー）。
  - `product_ids`: 必須（配列。最大20件。重複IDはサーバー側で自動排除）。
  - `force_regenerate`: 任意（boolean、デフォルト `false`。既に確定済みドラフトが存在する場合に再生成を許可するか）。`false` で確定済みドラフトがある商品は `CONFIRMED_DRAFT_EXISTS` で失敗します。
  - `min_cost_markup_rate`（別名 `min_markup_rate`）: 任意（number、デフォルト `0.30`＝**概算原価への最低30％上乗せ（×1.30）**。`30` のようなパーセント表記も `0.30` に自動正規化。**※既存の粗利率 `min_gross_margin_rate`（分母＝販売価格）とは意味が異なるため、別項目として扱います**）。
    - 下限価格計算式：`原価上乗せ下限価格 = ceilPriceByPolicy_(概算原価 × (1 + min_cost_markup_rate))`（既定：`ceilPriceByPolicy_(概算原価 × 1.30)`。10,000円以上は100円単位、1,000〜9,999円は50円単位、1,000円未満は10円単位で切り上げ）。
    - 不正値（`<= 0` または `> 5.0` / `> 500%`）は `INVALID_MIN_COST_MARKUP_RATE` で受付時に拒否します。
  - `product_costs`（別名 `product_costs_by_product`、または `items[].product_cost`）: 任意（商品IDをキーとする原価情報マップ。`gas-ai-batch-relay` 経由時は未指定商品について Readdy 内蔵DB `document_product_links` の `status = 'confirmed'` 明細を自動補完）。
    - 各商品の値には以下のいずれかをそのまま渡せます：
      1. `documents-relay`（`action: "get_product_cost"`）のレスポンス `{ cost_breakdown, links: [{ status: "confirmed", allocated_amount, line: { item_amount, fee_amount, tax_amount, fee_tax_amount, total_line_amount } }] }`
      2. `ProductCostSection.tsx`（`computeProductCostSummary`）の算出オブジェクト `{ confirmedTaxIncludedCost, referenceAllocatedTotal, allTaxConfirmed }`（またはスネークケース `{ confirmed_tax_included_cost, reference_allocated_total, all_tax_confirmed }`）
    - **価格決定ルール（概算原価への最低30％上乗せ）**:
      - 照合済み（`status = 'confirmed'` リンクあり）: `max(相場提案価格, 原価上乗せ下限価格)` を採用（相場提案が下限 `ceil(概算原価 × 1.30)` 以上なら相場価格を採用、相場提案が下限未満なら下限価格を採用・`price_basis: "cost_markup_floor"`）。
      - 未照合（確定リンク0件）: 従来どおり相場提案価格を採用し、`price_note` に「仕入原価が未確定（未照合）のためWeb相場に基づく概算価格提案です。最終判断はスタッフが行います。」を明記。
      - 税額未確定（`total_line_amount === null` 等）: 税抜または参考配賦額（`referenceAllocatedTotal`）から `× 1.30` 切り上げ下限を試算し、`price_note` に「参考配賦原価（税額未確定のため概算）への最低30%上乗せ（×1.30）…最終判断はスタッフが行います。」を明記。
  - `model_name`: 任意（モデル指定。省略時はシステムデフォルトの `gemini-3.8-flash`、2段階Web検索グラウンディング必須）。英数字で始まり英数字・`.`・`_`・`-` のみ、64文字以内。
  - `selected_image_ids_by_product`: 任意（オブジェクト `{ "TMP-000088": ["driveFileId1", "driveFileId4", "driveFileId5"] }` または `items: [{ "product_id": "TMP-000088", "selected_image_ids": [...] }]`）。
    - **省略時（推奨・既存リクエスト互換）**: 各商品について事前に保存された `selected_image_ids`（`product_ai_image_selections` シート）を自動的に引き継ぎ、`ai_batch_items.selected_image_ids` に固定保存してワーカーへ渡します。
    - **未選択商品のフォールバック**: 選択が保存されていない商品（または空配列 `[]`）は、従来どおりファイル名昇順の先頭最大3枚を使用します。
  - **対象カテゴリ（登録済みカテゴリ最優先）**:
    - 商品シート `C` 列（`category`）に登録されている全6カテゴリ（`sneaker`, `pokemon_card`, `apparel`, `fashion_goods`, `jewelry`, `other`）に対応し、登録済みカテゴリを最優先します。
    - 本票への自動反映先：`sneaker` は `L` 列（12列目 `sneaker_sku`）・`M` 列（13列目 `sneaker_size`）、`apparel` / `fashion_goods` は `AP` 列（42列目 `size`）・`AQ` 列（43列目 `official_sku`）に反映し、スニーカー列を汚染しません（`AO` 列 41列目 `subcategory` およびスタッフ入力済み値は上書きしません）。
  - `force_regenerate` / `model_name` / `min_cost_markup_rate` / `product_costs_json` は `ai_batch_jobs` シートの同名列（既存12列の後ろに追加）へ保存され、ワーカーが各商品の生成時に使用します。列が無い既存シートは初回アクセス時に末尾へ列を追加し、旧ジョブは既定値（`false` / 空=デフォルトモデル `gemini-3.8-flash` / `0.30` / `{}`）で処理します。
  - モデル指定時はフォールバックモデルへ自動切替しません（既存の単品生成と同じ挙動）。

- **Success Response (HTTP 200)**:
  ```json
  {
    "success": true,
    "batch_id": "BAT_20261005_123456_abc",
    "request_id": "REQ_BATCH_20261005_001",
    "status": "queued",
    "total_count": 3,
    "is_reused": false,
    "created_at": "2026-10-05T10:00:00.000Z"
  }
  ```
  ※ 同一の `request_id` で再送された場合、新規バッチは作成せず既存のバッチ情報を返します（`is_reused: true`）。

- **主なエラー**:
  - `REQUEST_ID_REQUIRED`: `request_id` が未指定または空文字。
  - `EMPTY_PRODUCT_IDS`: `product_ids` が空配列。
  - `MAX_BATCH_SIZE_EXCEEDED`: `product_ids` の件数が20件を超過。
  - `IMAGE_COUNT_EXCEEDED`: 商品ごとの選択画像IDが3枚を超過。
  - `DUPLICATE_SELECTED_IMAGE_ID`: 同一商品の `selected_image_ids` に重複IDが含まれる。
  - `INVALID_IMAGE_SELECTION`: 指定された画像IDが対象商品のDriveフォルダに存在しない。
  - `SELECTED_IMAGE_DELETED`: 選択された画像が削除（ゴミ箱移動等）されている（別の画像へ黙って差し替えずエラー返却）。
  - `UNAUTHORIZED_ADMIN_ACCESS`: 管理者キー不一致または未指定。

---

### 2.1b 商品ごとのAI解析用画像選択の保存・取得（販売用メイン画像・画像順は変更しない）

商品画像編集後または商品詳細画面で、スタッフがAI解析に使いたい画像（最大3枚、例：先頭外観＋4枚目の箱ラベル＋5枚目のサイズタグ等）のDrive `file_id` を商品ごとに保存・取得できます。販売用のメイン画像（`AE` 列）や画像の並び順（`01_main_...`, `02_...`）は一切変更しません。

1. **単独保存 (`save_product_ai_selected_images`)**:
   - **Method**: `POST`（既存の `update_product` / `update_product_images` と同じ GAS Web App URL へ直接送信可）
   - **Request Body**:
     ```json
     {
       "action": "save_product_ai_selected_images",
       "product_id": "TMP-000088",
       "selected_image_ids": ["driveFileId_01", "driveFileId_04_box", "driveFileId_05_tag"]
     }
     ```
     ※ 選択解除（デフォルトの先頭3枚に戻す）場合は `"selected_image_ids": []` を送信します。
   - **Success Response**:
     ```json
     {
       "success": true,
       "version": "product-ai-selected-images-v1",
       "product_id": "TMP-000088",
       "selected_image_ids": ["driveFileId_01", "driveFileId_04_box", "driveFileId_05_tag"],
       "ai_selected_image_ids": ["driveFileId_01", "driveFileId_04_box", "driveFileId_05_tag"],
       "updated_at": "2026-10-26T06:00:00.000Z"
     }
     ```
2. **画像編集・商品更新と同時の保存 (`update_product_images` / `update_product`)**:
   - `update_product_images` または `update_product` のリクエストボディに任意項目 `"selected_image_ids": ["..."]` を含めることでも保存できます（`update_product_images` では新規追加画像の `client_id` を指定した場合も、アップロード後の実Drive `file_id` に自動変換して保存します）。
3. **選択状態の確認・取得**:
   - 商品詳細取得 `GET ?mode=admin&product_id=TMP-000088` の `product.selected_image_ids`（および `product.ai_selected_image_ids`）に配列で返ります（未選択時は `[]`）。
   - 管理画面一覧取得 `GET ?mode=admin` の各商品オブジェクトの `selected_image_ids` にも返ります。
   - 単独取得 `GET ?mode=admin&action=get_product_ai_selected_images&product_id=TMP-000088`（または `POST { "action": "get_product_ai_selected_images", "product_id": "TMP-000088" }`）でも取得可能です。

---

### 2.2 バッチ進捗・結果取得 (`get_ai_product_draft_batch`)
`batch_id` を指定して、バッチ全体の進捗と商品別の生成状態を取得します。

- **Method**: `GET` (または `POST`)
- **Path**: `/exec?mode=admin&admin_key=<ADMIN_API_KEY>&action=get_ai_product_draft_batch&batch_id=BAT_20261005_123456_abc`
- **POST時の Body**:
  ```json
  {
    "action": "get_ai_product_draft_batch",
    "mode": "admin",
    "admin_key": "<ADMIN_API_KEY>",
    "batch_id": "BAT_20261005_123456_abc"
  }
  ```

- **Success Response (HTTP 200)**:
  ```json
  {
    "success": true,
    "batch_id": "BAT_20261005_123456_abc",
    "request_id": "REQ_BATCH_20261005_001",
    "status": "processing",
    "total_count": 3,
    "completed_count": 1,
    "failed_count": 0,
    "processing_count": 1,
    "created_at": "2026-10-05T10:00:00.000Z",
    "updated_at": "2026-10-05T10:01:30.000Z",
    "completed_at": null,
    "items": [
      {
        "product_id": "TMP-000088",
        "status": "completed",
        "draft_id": "DRFT_TMP-000088_1728122490000",
        "draft_version": 1,
        "model_name": "gemini-3.5-flash-lite",
        "error_code": null,
        "error_message": null,
        "retry_count": 0
      },
      {
        "product_id": "TMP-000090",
        "status": "processing",
        "draft_id": null,
        "draft_version": null,
        "model_name": null,
        "error_code": null,
        "error_message": null,
        "retry_count": 0
      },
      {
        "product_id": "TMP-000091",
        "status": "pending",
        "draft_id": null,
        "draft_version": null,
        "model_name": null,
        "error_code": null,
        "error_message": null,
        "retry_count": 0
      }
    ]
  }
  ```

- **主なエラー**:
  - `BATCH_ID_REQUIRED`: `batch_id` が未指定。
  - `BATCH_NOT_FOUND`: 指定された `batch_id` が存在しない。

---

### 2.3 失敗商品のみ再試行 (`retry_ai_product_draft_batch`)
バッチ内で `failed` になった商品のみを `pending` に戻し、再処理を受け付けます。成功（`completed`）済み商品は再実行されません。

- **Method**: `POST`
- **Path**: `/exec`
- **Request Body**:
  ```json
  {
    "action": "retry_ai_product_draft_batch",
    "mode": "admin",
    "admin_key": "<ADMIN_API_KEY>",
    "batch_id": "BAT_20261005_123456_abc",
    "request_id": "REQ_RETRY_20261005_001"
  }
  ```
  - `batch_id`: 必須（再試行対象のバッチID）。
  - `request_id`: 必須（再試行リクエストの冪等性キー。未指定は `REQUEST_ID_REQUIRED`）。

- **Success Response (HTTP 200)**:
  ```json
  {
    "success": true,
    "batch_id": "BAT_20261005_123456_abc",
    "request_id": "REQ_RETRY_20261005_001",
    "status": "queued",
    "total_count": 3,
    "retried_count": 1,
    "completed_count": 2,
    "failed_count": 0,
    "is_reused": false,
    "updated_at": "2026-10-05T10:05:00.000Z"
  }
  ```
  - 失敗商品は `pending` に戻り、`error_code` / `error_message` / `retry_count` / `next_retry_at` / ワーカー情報をクリアします。
    - **通常失敗時**: `draft_id` / `draft_version` / `model_name`（候補との対応付け）は保持し、次回ワーカー実行時の中断回収で既存候補を照合・回収します（不要な再生成は行いません）。
    - **検索未実行失敗時（例外条件）**: `error_code` が `SEARCH_GROUNDING_NOT_EXECUTED` のアイテムに限り、過去の未検索候補の回収を避け、新しい検索付き推論（Gemini API呼出し）を走らせるため、`draft_id` / `draft_version` / `model_name` を空文字にクリアして `pending` に戻します（`product_ai_drafts` シートの過去候補は削除せず履歴として保持されます）。
  - **冪等性**: 処理済みの `request_id` と応答は `ai_batch_jobs.retry_requests` 列（JSON、1バッチあたり直近50件）に記録されます。同一 `request_id` の再送（遅延再送を含む）は再試行を重複登録せず、初回応答に `is_reused: true` を付けて返します。新しい再試行には新しい `request_id` を使ってください。

- **失敗商品が0件の場合 (HTTP 200)**:
  ```json
  {
    "success": false,
    "error_code": "NO_FAILED_ITEMS",
    "message": "No failed items to retry in batch: BAT_20261005_123456_abc",
    "batch_id": "BAT_20261005_123456_abc",
    "request_id": "REQ_RETRY_20261005_002",
    "status": "completed",
    "retried_count": 0,
    "is_reused": false
  }
  ```
  バッチステータスは変更しません（実際の応答には `total_count` / `completed_count` / `failed_count` / `updated_at` も含みます）。この応答も `request_id` ごとに記録され、再送時は同一内容（`is_reused: true`）を返します。

- **主なエラー**:
  - `BATCH_ID_REQUIRED`: `batch_id` が未指定。
  - `REQUEST_ID_REQUIRED`: `request_id` が未指定または空文字。
  - `BATCH_NOT_FOUND`: 指定された `batch_id` が存在しない。
  - `NO_FAILED_ITEMS`: 失敗した商品がなく、再試行不要（`success: false`）。

---

## 3. 状態値とライフサイクル

### 3.1 バッチ全体ステータス (`batch.status`)
| ステータス | 説明 |
| :--- | :--- |
| `queued` | ジョブ登録完了、ワーカーによる処理開始待ち |
| `processing` | ワーカーが処理を実行中（一部完了または処理中商品あり） |
| `completed` | バッチ内の全商品が正常に生成完了 (`completed_count === total_count`) |
| `partially_failed` | 全商品の処理が終了したが、一部が失敗した状態 |
| `failed` | 全商品が失敗した状態 |

### 3.2 商品別ステータス (`item.status`)
| ステータス | 説明 |
| :--- | :--- |
| `pending` | ワーカーによる生成実行待ち（一時エラー後は `next_retry_at` 到達まで待機） |
| `processing` | 現在ワーカーが画像取得・LLM呼び出し・保存中 |
| `completed` | 生成・自動反映・確定が完了し、反映完了判定を通過（`draft_id` はこのアイテムで生成・予約した候補） |
| `failed` | リトライ上限超過または恒久的エラーにより失敗 |

### 3.3 検索グラウンディング関連エラーコードと再試行動作対比表

| 発生事由 | `error_code` | アイテム `status` | 親バッチ `status` | 下書き・本票反映 (Fail-Closed) | ワーカー内自動再試行 | Readdy明示再試行 (`retry_ai_product_draft_batch`) 挙動 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Stage A 検索クエリ0件**<br>(Web検索未実行) | `SEARCH_GROUNDING_NOT_EXECUTED` | `failed` | `partially_failed` または `failed` | **下書き未保存**<br>本票変更なし<br>(中断回収時も pending_review 維持) | なし<br>(恒久エラーとして即時失敗) | **再試行可能**<br>`draft_id`, `draft_version`, `model_name` をクリアし `pending` へ戻す。ワーカーが新規推論を実行 |
| **Stage A 参照元0件**<br>(クエリあり・参照元0件) | `SEARCH_GROUNDING_NO_SOURCES` | `failed` | `partially_failed` または `failed` | **下書き未保存**<br>本票変更なし | なし<br>(即時失敗) | **再試行可能**<br>`draft_id`, `draft_version`, `model_name` をクリアし `pending` へ戻す。ワーカーが新規推論を実行 |
| **Gemini API 429**<br>(レート制限・クォータ枯渇) | `LLM_HTTP_ERROR_429` | 再試行中: `pending`<br>上限超過: `failed` | 処理中: `processing`<br>全完了時: `partially_failed`/`failed` | **下書き未保存**<br>本票変更なし | **あり** (最大3回)<br>バックオフ待機 (60s, 120s, 180s)。サーキットブレーカー作動でループ中断待避 | **再試行可能**<br>上限超過後にスタッフが明示再試行可能。リセット後ワーカーが再実行 |
| **Stage A MAX_TOKENS**<br>(思考/出力トークン打ち切り) | `STAGE_A_MAX_TOKENS` | `failed` | `partially_failed` または `failed` | **下書き未保存**<br>本票変更なし | なし<br>(即時失敗) | **再試行可能**<br>`draft_id`, `draft_version`, `model_name` をクリアし `pending` へ戻す。ワーカーが新規推論を実行 |

---

## 4. ワーカー実行仕様

1. **時間主導型トリガー**:
   - システム全体で共有のトリガー `processAiBatchQueue`（1分間隔）を1つのみ設置。
   - 既存トリガーの存在確認を行い、多重作成を防止。
2. **実行リソース制約**:
   - 1回のトリガー実行あたり最大3件、最長約4分（240秒）を目安とする。
   - 次のLLM呼び出し（所要約30〜45秒）を開始する時間的余裕がない場合、残件は次回トリガーへ引き継ぐ。
3. **排他制御 (ScriptLock)**:
   - キューからのアイテム取得時および完了保存時の数ミリ秒〜数秒間のみ `ScriptLock` を使用。
   - Google Driveからの画像バイナリ取得およびGemini API通信中には **ScriptLockを保持しない**。
4. **リースと実行ID保護（保存直前の所有権確認）**:
   - アイテム取得時に `worker_execution_id` と `lease_expires_at`（5分後）を記録。
   - 実行が異常中断（GASタイムアウト等）した場合でも、リース期限切れのアイテムは後続ワーカーが安全に回収・再実行。
   - 候補保存・本票/英文/ポケカ反映の直前に、短い ScriptLock 内で「アイテムが `processing`・自分の `worker_execution_id`・リース有効」と「商品のAI生成実行ロックが自分のもの」を確認します。満たさない場合は `BATCH_ITEM_OWNERSHIP_LOST` 等で書込みを行いません。
   - 所有権確認を通過した時点でアイテムの `draft_id` / `draft_version` / `model_name` を予約記録してから候補を保存します。
   - 古いワーカーは、新しいワーカーの結果・状態（`status` / `worker_execution_id` / `draft_id` / `error_code` 等）を変更しません。
5. **保存済み候補の自動回収（アイテム対応候補のみ）**:
   - 回収対象は、アイテムに予約記録された `draft_id` と一致する最新候補のみです。「最新ドラフトが存在する」だけで過去の候補（単品生成分や別バッチ分）を流用しません。
   - 予約 `draft_id` が最新候補と一致: 確定済みなら反映完了判定、未確定なら所有権・最新性・他生成中を確認したうえで反映・確定し、完了判定を通過すれば `completed`。
   - **未検索候補の回収例外**: 予約 `draft_id` と一致する候補であっても、検索グラウンディング有効かつ実検索未実行（`search_executed: false`）の場合、自動反映や confirmed 化は一切行いません。不要な再生成（無駄なGemini呼出し）を避けてドラフトを `pending_review` のまま安全に保持し、バッチアイテムは `SEARCH_GROUNDING_NOT_EXECUTED` で `failed` として回収を完了します。
   - 予約 `draft_id` の候補が既により新しい候補に置き換わっている: `AI_DRAFT_SUPERSEDED` で失敗（古い候補で上書きしない）。
   - 予約のみで候補が未保存: 再生成します。
6. **一時エラーのリトライ制御（構造化エラーコードで判定）**:
   - 再試行対象は `LLM_HTTP_ERROR_429` / `500` / `502` / `503` / `504` と `LLM_COMMUNICATION_FAILED`（通信例外）のみ。メッセージ文字列では判定しません（`error_message` は安全な固定文言）。
   - 最大3回まで再試行（初回を含め最大4回実行）。待機は `60秒 × 再試行回数`。上限到達後は `failed`、`next_retry_at` は空にします。
   - ワーカー内で長時間スリープせず、`next_retry_at` に次回試行時刻を設定してトリガーを終了。次回ワーカーが期限到達後に処理。
   - `LLM_HTTP_ERROR_400` / `403`、`STRUCTURED_PARSE_FAILED`、`GENERATION_ALREADY_IN_PROGRESS` 等は再試行せず `failed`（失敗分のみ再試行APIで再投入可能）。
7. **独立障害耐性**:
   - 1件の商品が画像欠損やエラーで失敗しても、同一バッチ内の残りの商品の処理は停止せず継続。

---

## 5. Readdy・中継（gas-ai-batch-relay）・GAS 接続構成

本バッチ処理では、ブラウザ側に GAS URL や `ADMIN_API_KEY` を露出させないため、専用中継サービス `gas-ai-batch-relay` を経由して接続します。

### 5.1 役割分担
```text
Readdy (フロントエンド)
  │
  │  POST / GET (Bearer JWT / CORS 制御)
  │  ※ mode や admin_key の送信は不要
  ▼
gas-ai-batch-relay (中継サーバー)
  │
  ├─ CORS オリジン照合 (`ALLOWED_ORIGINS`)
  ├─ JWT 署名・期限検証 (`JWT_SECRET`, HS256)
  ├─ 対象3アクションの選別とクライアント入力バリデーション
  ├─ サーバー側環境変数より mode: "admin", admin_key: GAS_ADMIN_SECRET を付与
  ▼
Google Apps Script (GAS Web App)
  URL: /exec
```

### 5.2 Readdy 実装時の留意点
1. **認証情報の秘匿**:
   - Readdy は `mode` や `admin_key` をリクエストに含める必要はありません（リレー側で安全に注入されます）。
   - クライアント側から送信された場合でも、中継サーバー側で上書き破棄されます。
2. **受付前 request_id の永続化**:
   - `create_ai_product_draft_batch` 呼出し前にクライアント側で `request_id` をローカルDB/Storageへ保存し、通信切断時や再送時に同一 `request_id` を送信することで安全に冪等性を担保します。
3. **ポーリング間隔**:
   - `get_ai_product_draft_batch` のポーリング間隔は 3秒〜5秒 を推奨します。ワーカーは1分間隔のトリガーまたは手動起動で順次処理を進めます。

---

## 6. Gemini 3.8 Flash 料金体系および処理時間仕様

### 6.1 公式料金体系 (2026年最新基準)
- **標準モデル**: `gemini-3.8-flash`
- **入力トークン費用**: **$0.75 / 1,000,000 トークン** (プロンプト <= 128k)
- **出力トークン費用**: **$3.75 / 1,000,000 トークン** (thinking 思考トークンおよび生成テキストを含む)
- **Google Search Grounding (Web検索) 費用**:
  - **月間 5,000クエリまで無料** (Free tier)
  - 5,000クエリ超過後: **$14.00 / 1,000 検索クエリ** ($0.014 / 検索)
  *(※旧バージョンの $0.075 / $0.30 や $35 / 1,000クエリは適用されません)*

### 6.2 費用算出式
実測トークン数に基づき、以下の式で費用を算出します（※Gemini API レスポンスにおいて `candidatesTokenCount` と `thoughtsTokenCount` が個別に返却される場合に対応し、課金対象となる総出力トークン数として思考トークンを明示的に加算合算します）：

```text
Prompt_Tokens = Stage_A_promptTokenCount + Stage_B_promptTokenCount
Response_Tokens = Stage_A_candidatesTokenCount + Stage_B_candidatesTokenCount
Thinking_Tokens = (Stage_A_thoughtsTokenCount || 0) + (Stage_B_thoughtsTokenCount || 0)
Total_Output_Tokens = Response_Tokens + Thinking_Tokens
Search_Queries = Stage_A_webSearchQueries.length

Cost_USD = (Prompt_Tokens * 0.75 / 1,000,000)
         + (Total_Output_Tokens * 3.75 / 1,000,000)
         + (max(0, Monthly_Search_Queries - 5,000) * 0.014)

Cost_JPY = Cost_USD * USD_JPY_EXCHANGE_RATE
```

### 6.3 実機検証で確認すべき `usageMetadata` 項目
1商品あたりの正確な費用算出のため、GASログまたはレスポンスの以下の項目を確認・記録します：
- `usageMetadata.promptTokenCount`: 入力トークン数（画像Base64 + プロンプトテキスト）
- `usageMetadata.candidatesTokenCount`: 生成回答トークン数
- `usageMetadata.thoughtsTokenCount`: 思考（Thinking）トークン数（出力課金 $3.75/1M トークンの対象）
- `groundingMetadata.webSearchQueries`: 実行されたWeb検索クエリ数（検索課金対象）

### 6.4 処理時間見積もり (長時間処理の考慮)
- **1商品あたりの所要時間**:
  - 標準的なスニーカー（外観特徴が明確）: **約25秒〜45秒**
  - 複雑な商品（TMP-000102等の多面思考・深掘り検索）: **約60秒〜最長約120秒 (約2分)**
- **20商品バッチの所要時間**:
  - GASワーカーは1分間隔トリガー (`processAiBatchQueue`) で稼働し、安全マージン（240秒）内で1回の起動あたり2〜3件ずつ安全に処理を進めます。
  - バッチ全体（20件）の完了所要時間: **約8分〜最長15分程度**


