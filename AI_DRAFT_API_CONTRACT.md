# AI出品ドラフト機能 バックエンドAPI契約仕様書

本ドキュメントは、ReaddyフロントエンドとGASバックエンド間の連携仕様を実コードに準拠して定義したものです。

---

## 1. 接続アーキテクチャ & 認証契約

### 1.1 接続構成
```
[Readdy ブラウザ]
       │ (スタッフ認証セッション)
       ▼
[Readdy サーバー / API Route]
       │ (サーバー間通信: ADMIN_API_KEY 付与)
       ▼
[GAS Web App /exec]
```
- **セキュリティ原則**:
  - GASの管理者認証秘密鍵（`ADMIN_API_KEY`）は**ブラウザJSへ直接埋め込まないでください**。
  - 必ずReaddy側のスタッフ認証付きサーバー（Next.js API Route / BFF等）を経由してGASへリクエストを中継してください。

### 1.2 共通認証パラメータ
GASバックエンドはリクエスト内の `mode` と管理者キーを検証します。
AIドラフト関連API（生成・確定・詳細取得）を呼び出す際は、必ず以下を含めてください：
- **JSON Body**:
  - `"mode": "admin"` （必須）
  - `"admin_key": "<ADMIN_API_KEY>"` （`token` または `key` でも可）
- **GET クエリ**:
  - `?mode=admin&admin_key=<ADMIN_API_KEY>`

---

## 2. API エンドポイント詳細

### 2.1 画像のみ登録（仮ドラフト商品作成）
通常の商品登録画面を残しつつ、画像先行で `product_id` 付きの仮 draft を作成します。
架空の商品名やブランド・状態は挿入せず、空白のまま保存されます。

- **Method**: `POST`
- **Path**: `/exec`
- **Request Body**:
  ```json
  {
    "images": [
      {
        "file_name": "photo_01.jpg",
        "mime_type": "image/jpeg",
        "base64": "<BASE64_STRING>"
      },
      {
        "file_name": "photo_02.jpg",
        "mime_type": "image/jpeg",
        "base64": "<BASE64_STRING>"
      }
    ],
    "publish_status": "draft"
  }
  ```
  ※ `action` キーは**含めない**（または未定義）。
  ※ 商品画像は最大20枚まで保持可能（AI解析には後続APIで最大3枚を使用）。
  ※ `planned_sale_price` 未入力時はGASシート上で `0` として初期化されます。フロントエンド側では「価格未設定」として扱ってください。

- **Success Response (HTTP 200)**:
  ```json
  {
    "success": true,
    "version": "product-create-v2",
    "product_id": "TMP-000035",
    "publish_status": "draft",
    "inventory_status": "in_stock",
    "drive_folder_url": "https://drive.google.com/drive/folders/...",
    "main_image_url": "https://drive.google.com/uc?id=...",
    "image_count": 2
  }
  ```
  ※ 作成後は取得した `product_id` をキーとして後続の生成・更新処理を行ってください（重複登録禁止）。

- **主なエラー**:
  - `maximum image count is 20`: 画像が21枚以上送信された場合。

---

### 2.2 AI商品情報候補生成 (`generate_ai_product_draft`)
対象商品のDrive画像を `gemini-3.8-flash` で解析し、日英のタイトル・説明文・状態・カテゴリ等の候補を生成して `product_ai_drafts` シートに `pending_review` で保存します。

- **Method**: `POST`
- **Path**: `/exec`
- **Request Body**:
  ```json
  {
    "action": "generate_ai_product_draft",
    "mode": "admin",
    "admin_key": "<ADMIN_API_KEY>",
    "product_id": "TMP-000035",
    "force_regenerate": true,
    "selected_image_ids": ["<fileId_1>", "<fileId_2>"]
  }
  ```
  ※ `selected_image_ids`: 解析に使用する画像ID配列（最大3枚。省略時はフォルダ内先頭最大3枚を自動使用）。
  ※ `force_regenerate`: 既存ドラフトがあっても新規バージョンで再生成する場合は `true`。

- **Success Response (HTTP 200)**:
  ```json
  {
    "success": true,
    "draft_id": "DRAFT_TMP-000035_1_1728100000000_a1b2c3",
    "product_id": "TMP-000035",
    "draft_version": 1,
    "review_status": "pending_review",
    "model_name": "gemini-3.5-flash-lite",
    "candidate": {
      "title_ja": "NIKE AIR JORDAN 1 HIGH OG CHICAGO",
      "hashtags_ja": "#NIKE #AIRJORDAN1 #CHICAGO #スニーカー",
      "description_ja": "ナイキ エアジョーダン1 レトロ ハイ OG シカゴです。状態は良好で...",
      "title_en": "Nike Air Jordan 1 High OG Chicago",
      "description_en": "Nike Air Jordan 1 High OG Chicago in excellent condition...",
      "condition": "目立った傷や汚れなし",
      "price": 42000,
      "price_note": "AIによる概算価格です",
      "category": "sneaker",
      "brand": "Nike",
      "sku": "DZ5485-612",
      "size": "27.5cm"
    },
    "source_fingerprint": "c3ab89..."
  }
  ```
  ※ **価格サジェスト仕様 (`candidate.price` / `candidate.price_note`)**:
  - `candidate.price`: 写真・識別できたモデル・状態に基づく「**正の安全な整数（円単位、例: 42000）**」または「**null（判断不能時）**」。負数・小数・0・文字列等の不正値はバックエンド側で自動的に null へサニタイズされます。
  - `candidate.price_note`: LLMによる理由生成は行わず、常に固定文言 `「AIによる概算価格です」` を返却します（UI表示および後方互換用）。
  - **シート保存**: `product_ai_drafts` シートでは既存の `candidate_price` 列のみを使用し、**理由用の新規列は追加しません**。旧データの空欄セルは API 取得時に `price: null` として安全に扱われます。
  - **スタッフ確認必須**: `candidate.price` は下書き用の概算参考値であり、確定API（`confirm_ai_product_draft`）を呼ぶまで本票の販売価格（H列 / `planned_sale_price`）および Square 価格には一切反映されません。スタッフが画面上で確認・修正した値を確定要求に含めてください。
  ※ **一括生成の実装方針**: バックエンドに長時間のバルクAPIは新設しません。フロントエンド側で複数選択された商品について、本APIを**1件ずつ順次（Sequential）実行**し、商品ごとの進捗表示・再試行を制御してください。

- **主なエラー**:
  - `UNAUTHORIZED_ADMIN_ACCESS`: `mode: "admin"` または管理者キーの不一致。
  - `PRODUCT_NOT_FOUND`: 商品が存在しない。
  - `INVALID_PRODUCT_STATE`: 商品が `draft` かつ `active` でない。
  - `ALREADY_PUBLISHED_PRODUCT`: すでに `published` の商品。
  - `AI_DRAFT_IN_PROGRESS`: 当該商品に対して別の生成処理が実行中（二重実行防止）。
  - `LLM_GENERATION_FAILED`: Gemini API 通信エラー（再試行推奨）。

---

### 2.3 AI候補のスタッフ確認・確定保存 (`confirm_ai_product_draft`)
スタッフが画面上で候補を確認・修正し、確定内容を商品マスター本票および英文翻訳・ポケカシートへ一括反映します。

- **Method**: `POST`
- **Path**: `/exec`
- **Request Body (完全例)**:
  ```json
  {
    "action": "confirm_ai_product_draft",
    "mode": "admin",
    "admin_key": "<ADMIN_API_KEY>",
    "product_id": "TMP-000035",
    "draft_id": "DRAFT_TMP-000035_1_1728100000000_a1b2c3",
    "draft_version": 1,
    "confirmation_attempt_id": "CONFIRM_REQ_20261005_110000_STAFF1",
    "staff_id": "staff@example.com",
    "confirmed_data": {
      "product_name": "NIKE AIR JORDAN 1 HIGH OG CHICAGO",
      "planned_sale_price": 45000,
      "condition": "目立った傷や汚れなし",
      "category": "sneaker",
      "brand": "Nike",
      "description": "ナイキ エアジョーダン1 レトロ ハイ OG シカゴです...",
      "hashtags_ja": "#NIKE #AIRJORDAN1 #CHICAGO",
      "sneaker_sku": "DZ5485-612",
      "sneaker_size": "27.5cm",
      "sneaker_box": "あり",
      "sneaker_accessories": "替え紐、黒タグ",
      "translated_title": "Nike Air Jordan 1 High OG Chicago",
      "translated_description": "Authentic Nike Air Jordan 1 High OG Chicago in excellent condition...",
      "pokemon_card": null
    }
  }
  ```
  ※ **必須項目**:
  - `product_id`: 対象商品ID
  - `draft_id`: 確定対象のドラフトID
  - `draft_version`: **必須（数値）**。候補生成時に返却された `draft_version` を指定。
  - `confirmation_attempt_id`: クライアント生成の一意なID。通信瞬断・タイムアウト後の安全な再試行・冪等性復旧に必須。
  - `staff_id`: 確定操作を行ったスタッフ識別子（メールアドレス等）。
  - `confirmed_data`: 確定する属性オブジェクト。
    - `product_name`: 必須文字列
    - `planned_sale_price`: **数値必須（null / 0不可）**
    - `condition`: 必須（状態の選択肢値）
    - `description`: 日本語説明文（文字列）
    - `hashtags_ja`: ハッシュタグ文字列（例: `"#NIKE #AJ1"`）
    - `category`: `"sneaker"`, `"pokemon_card"`, `"apparel"` のいずれか
    - `translated_title`: 確定英題文字列
    - `translated_description`: 確定英文説明文字列
    - `sneaker_size`: **下書き確定時は未入力（`""` または `null`）を許可**。実物確認後にサイズを追加する場合は、後述の「サイズ追加入力・再確定」手順を実行します。

- **初回確定の正常レスポンス (HTTP 200)**:
  ```json
  {
    "success": true,
    "product_id": "TMP-000035",
    "draft_id": "DRAFT_TMP-000035_1_1728100000000_a1b2c3",
    "draft_version": 1,
    "review_status": "confirmed",
    "publish_status": "draft",
    "message": "AI draft confirmed and saved successfully. Product is ready for publication."
  }
  ```
  ※ **確定後のステータス**: `review_status: "confirmed"` となります（サイズ未入力の場合も下書き保存済みとして `confirmed` となりますが、公開可否は公開ゲートで判定されます）。
  ※ **指紋（confirmed_fingerprint）について**:
    確定指紋（`confirmed_fingerprint`）はGAS内部で改ざん検知および公開ゲート用に計算され、**履歴シート（`product_ai_drafts`）のセルに安全に保存されます**。APIレスポンスJSONには含まれません。
  ※ **同一attempt_id再送時のレスポンス（冪等復旧）**:
    既に確定済みの同一 `confirmation_attempt_id`・同一内容で再送された場合は、上記レスポンスに `"is_idempotent_replay": true` が付与されて成功（HTTP 200）します。

- **サイズ未入力での確定例 (Request)**:
  ```json
  {
    "action": "confirm_ai_product_draft",
    "mode": "admin",
    "admin_key": "<ADMIN_API_KEY>",
    "product_id": "TMP-000035",
    "draft_id": "DRAFT_TMP-000035_1_1728100000000_a1b2c3",
    "draft_version": 1,
    "confirmation_attempt_id": "CONFIRM_REQ_20261005_110000_STAFF1",
    "staff_id": "staff@example.com",
    "confirmed_data": {
      "product_name": "NIKE AIR JORDAN 1 HIGH OG CHICAGO",
      "planned_sale_price": 45000,
      "condition": "目立った傷や汚れなし",
      "category": "sneaker",
      "brand": "Nike",
      "description": "ナイキ エアジョーダン1 レトロ ハイ OG シカゴです...",
      "hashtags_ja": "#NIKE #AIRJORDAN1 #CHICAGO",
      "sneaker_sku": "DZ5485-612",
      "sneaker_size": "",
      "sneaker_box": "あり",
      "sneaker_accessories": "替え紐",
      "translated_title": "Nike Air Jordan 1 High OG Chicago",
      "translated_description": "Authentic Nike Air Jordan 1 High OG Chicago in excellent condition...",
      "pokemon_card": null
    }
  }
  ```
  ※ レスポンスは通常確定と同様に `success: true`, `review_status: "confirmed"` が返却されます。

- **サイズ空欄確定後のサイズ追加入力・再確定フロー**:
  サイズ空欄で確定保存した後、実物確認等でサイズが判明した場合は、**新しい `confirmation_attempt_id`（例: `CONFIRM_${productId}_${Date.now()}`）を指定して `confirm_ai_product_draft` を再度呼び出してください**。
  - **重要（新しい attempt ID 必須）**: 初回確定時と同じ `confirmation_attempt_id` を再利用すると、改ざん・競合防止判定（`DRAFT_ALREADY_CONFIRMED_WITH_DIFFERENT_DATA`）により拒絶されます。再確定時は必ずクライアント側で新しい一意な attempt ID を生成してください。
  - フロントエンドで先に `update_product` を呼び出して本票サイズを保存した場合でも、公開ゲート（確定指紋照合）を通過するには本再確定 API の呼出しが必要です。
  - `confirmed_data` には通常プロパティ名（`sneaker_size`, `sneaker_sku`, `product_name`, `planned_sale_price`, `translated_title`, `translated_description`）に加えて、candidate のプロパティ名（`size`, `sku`, `title_ja`, `price`, `title_en`, `description_en`）も自動互換マッピングされます。
  - AI画像からの再生成は不要です。
  - 同じ `product_id` に対して本票のサイズが更新され、公開ゲート用の確定指紋（`confirmed_fingerprint`）が新しいサイズを含めた値へと自動更新されます。
  - 確定指紋チェック自体は無効化されず、公開前の属性改ざん検知は安全に維持されます。

- **主なエラー**:
  - `INVALID_CONFIRMATION_PAYLOAD`: `product_id`, `draft_id`, `draft_version`, `confirmed_data` のいずれかが不足。
  - `CONFIRMATION_ATTEMPT_ID_REQUIRED`: `confirmation_attempt_id` が未指定。
  - `DRAFT_VERSION_MISMATCH`: 最新のドラフトID・バージョンと一致しない。
  - `SOURCE_ATTRIBUTE_MODIFIED_BY_OTHER`: 候補生成後に他スタッフが本票属性を変更したため競合遮断。
  - `PRODUCT_NAME_REQUIRED`: 商品名が空文字。
  - `VALID_SALE_PRICE_REQUIRED`: 価格が未入力または0以下の数値。
  - `CONDITION_REQUIRED`: 状態が未入力。
  - `INVALID_CONDITION_VALUE`: 状態値が規定外。
  - `INVALID_IDEMPOTENT_REPLAY_ATTEMPT`: 既に確定済みのデータと完全に同一の内容を、新しい attempt ID で送信した場合。

---

### 2.4 AIドラフト候補・履歴取得 (`get_ai_product_draft`)
確認モーダル表示や再確認のために、最新のAIドラフト情報を取得します。

- **Method**: `GET`
- **Path**: `/exec?action=get_ai_product_draft&mode=admin&admin_key=<ADMIN_API_KEY>&product_id=TMP-000035`
- **Success Response (HTTP 200)**:
  ```json
  {
    "success": true,
    "product_id": "TMP-000035",
    "latest_ai_draft": {
      "draft_id": "DRAFT_TMP-000035_1_1728100000000_a1b2c3",
      "product_id": "TMP-000035",
      "draft_version": 1,
      "review_status": "confirmed",
      "candidate_title_ja": "NIKE AIR JORDAN 1 HIGH OG CHICAGO",
      "candidate_hashtags_ja": "#NIKE #AIRJORDAN1 #CHICAGO",
      "candidate_description_ja": "...",
      "candidate_title_en": "...",
      "candidate_description_en": "...",
      "candidate_condition": "目立った傷や汚れなし",
      "candidate_price": 42000,
      "candidate_category": "sneaker",
      "candidate_brand": "Nike",
      "candidate_sku": "DZ5485-612",
      "candidate_size": "27.5cm",
      "source_fingerprint": "...",
      "source_image_fingerprint": "...",
      "confirmed_fingerprint": "8f3b...",
      "source_image_ids": "fileId1,fileId2",
      "model_name": "gemini-3.5-flash-lite",
      "generated_at": "2026-10-05T02:00:00.000Z",
      "confirmed_at": "2026-10-05T02:05:00.000Z",
      "confirmed_by": "staff@example.com",
      "candidate": {
        "title_ja": "NIKE AIR JORDAN 1 HIGH OG CHICAGO",
        "hashtags_ja": "#NIKE #AIRJORDAN1 #CHICAGO",
        "description_ja": "...",
        "title_en": "...",
        "description_en": "...",
        "condition": "目立った傷や汚れなし",
        "price": 42000,
        "price_note": "AIによる概算価格です",
        "category": "sneaker",
        "brand": "Nike",
        "sku": "DZ5485-612",
        "size": "27.5cm"
      }
    }
  }
  ```
  ※ 通常の商品詳細取得 `GET /exec?mode=admin&product_id=TMP-000035&admin_key=<KEY>` でも、管理者認証が成功していればレスポンス内に `latest_ai_draft` が付与されます。
  ※ AI画像解析でサイズが明確に読み取れない場合、`candidate.size` は推測やダミー値を用いず空文字 `""` となります。

---

## 3. 公開・Square販売連携とサイズ必須検証

### 3.1 公開ゲート（Fail-Closed 検証）
スタッフ確定（`review_status: "confirmed"`）した商品は、公開（`publish_status: "published"`）や Square 連携を行う直前に共通の公開検証（`assertProductPublishable_`）が実行されます。

1. **AIドラフト状態検証**:
   - `pending_review` または履歴なしの場合: `AI_DRAFT_NOT_CONFIRMED`
   - 確定後にシートを直接改ざんされた場合: `AI_DRAFT_MODIFIED_AFTER_CONFIRMATION`
2. **スニーカーサイズ必須検証**:
   - カテゴリが `sneaker` かつ `sneaker_size` が未入力（空文字）の場合: **`SNEAKER_SIZE_REQUIRED`** で拒否。
   - ※ 販売停止（`publish_status: "draft"` または `"hidden"`）や在庫0への変更はサイズ空欄でも妨げられません。

### 3.2 サイズ未入力時のエラーレスポンス例（公開時）
```json
{
  "success": false,
  "error_code": "SNEAKER_SIZE_REQUIRED",
  "message": "Publish validation failed for TMP-000035: Sneaker size is required before publishing or selling on Square."
}
```
フロントエンドではこのエラーを受け取った場合、スタッフにサイズ入力を促し、サイズ入力後に `confirm_ai_product_draft` で再確定してから公開ボタンを押すよう案内してください。
