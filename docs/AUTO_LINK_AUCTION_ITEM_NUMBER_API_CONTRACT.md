# `auction_item_number` 自動検索・自動紐付け バックエンド API 契約書

最終更新: 2026-11-02 (JST)

## 1. 配信ベース・配信状態と上書き防止の重要注意（Readdy Backend 反映済み）

- **対象ファイル**: `supabase/functions/documents-relay/index.ts`
- **現在の配信ステータス**: **本番配信済み・Readdy `Code` タブ同期済み・フロント実機確認完了（2026-11-02）**
  - 完成版ファイル仕様: **3,024 行 / `107,292` bytes（UTF-8 / LF） / SHA-256 `ead8da5a8441db3f4e0ad8f10ed17f0343346a418e63f947681bdb727129f710`**（`Fuga420/bis-ec-frontend` `main` コミット `20b1635` にて Readdy 側へ Pull 同期済み）。
  - 実URL検証（`node docs/diagnostics/verify_live_auto_link_url.mjs`）にて、`TMP-000161` × `"842-33225"` で HTTP `200` / `status: "conflict_existing_link"` が返り、`TMP-000134` の確定リンク（`018883e7-1664-4dee-bd41-9cacc092ffe2`）が維持されることを確認済み。
- **現在稼働中の本番ベースコード確認結果（`c61f9f4` との差分検証済み）**:
  - `origin/main` の最新 Readdy エクスポートコミット **`eb74432`**（`From Readdy: 商品登録共通画面 – v177`、blob **`c0062a0`**、1,745行）と、未マージブランチ `feat/cloud-run-batch-relay-api` の **`c61f9f4`**（blob `74623d6`、1,779行）を本番実挙動と突き合わせた結果、**現在稼働中の `documents-relay` は `c61f9f4` ではなく `eb74432`（blob `c0062a0`）と一致**していることを確認済み。
    - 実証根拠: 2026-10-29 16:37 JST に `TMP-000134` が手動紐付け（`link_product_manual`）された際、親書類 `bf7272b8-f0b0-4651-b6dd-f469f631ee0d` の `status` が `"processed"` から **`"partially_matched"`** に更新されている（`eb74432` / `c0062a0` の `refreshDocumentStatus` 挙動であり、Readdy `v177` の `src/pages/documents/types.ts` `mapMatchStatus` の `"一部照合"` / `"照合済み"` バッジ判定もこれに依存。`c61f9f4` で上書きすると `"processed"` のまま固定され画面バッジが未照合に戻る）。
- **バックエンド担当者（Readdy Backend）へ渡す差分**:
  - 現行配信版 **`eb74432`（blob `c0062a0`）の既存1,745行を1行も変更・削除せず（`-0` 行）**、新アクション `auto_link_product_by_item_number` のみを純粋追加（`+1,279` 行）した `supabase/functions/documents-relay/index.ts`（または対 `eb74432` 純粋追加パッチ `readdy-patches/14_documents-relay_auto_link_item_number.patch`）を反映してください。
  - **追加環境変数は不要**: 既存の `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GAS_WEBHOOK_URL`, `GAS_ADMIN_SECRET`, `DOCUMENTS_WORKER_SECRET` のみで動作します。
- **配信直後の実URL確認手順（リンク非変更の読み取り競合確認）**:
  1. `POST ${VITE_PUBLIC_SUPABASE_URL}/functions/v1/documents-relay` に対し、`{ "action": "auto_link_product_by_item_number", "product_id": "TMP-000161", "auction_item_number": "842-33225" }` を送信する。
  2. HTTP `200` で `linked: false`, `status: "conflict_existing_link"`, `reason_code: "LINE_ALREADY_LINKED_TO_OTHER_PRODUCT"`, `conflicting_links[0].product_id: "TMP-000134"`（`link_id: "018883e7-1664-4dee-bd41-9cacc092ffe2"`）が返ることを確認する。
  3. 続けて `{ "action": "get_product_cost", "product_id": "TMP-000134" }` および `{ "action": "get_product_cost", "product_id": "TMP-000161" }` を呼び、`TMP-000134` の確定リンク（`links.length === 1`, `links[0].id === "018883e7-1664-4dee-bd41-9cacc092ffe2"`）が維持され、`TMP-000161` が `links.length === 0` のままであることを確認する（`node docs/diagnostics/verify_live_auto_link_url.mjs` で一括検証可能）。
- **ワーカー専用認証境界の維持**:
  - `WORKER_ONLY_ACTIONS` は従来どおり `register_drive_document`・`update_document_folder` の2件のみ維持。`auto_link_product_by_item_number` は `link_product_manual` / `get_product_cost` と同じくフロントエンドから `supabase.functions.invoke("documents-relay", { body })` で呼び出し可能です。

---

## 2. 台帳の番号列と番号種別の非混同ルール

| 仕入台帳（Excel「仕入明細」）の列 | `document_lines` のカラム | 値の特徴・実例 |
| :--- | :--- | :--- |
| F列「落札・受付番号」（受付番号） | `reception_number_raw` | `842-33225`, `855-19157`, `78-3`, `469-9`（回次/箱番号-枝番） |
| G列「商品番号」 | `auction_bid_number` | `80328`, `64014`, `40276`, `1`, `2`（出品番号・行番号。KOMEHYOは `null`） |

- `number_type` による検索対象の制御（既定 `"auto"`）:
  - `"reception_number"`: `reception_number_raw` のみを文字単位の完全一致で検索（先頭ゼロ・ハイフン保持）。
  - `"auction_bid_number"`: `auction_bid_number` のみを文字単位の完全一致で検索（先頭ゼロ・ハイフン保持）。
  - `"auto"`（省略時）: `reception_number_raw` と `auction_bid_number` を **別々の名前空間として個別検索** する。両方の列で異なる明細行に一致した場合は勝手に片方を優先せず `status: "multiple_candidates"`, `reason_code: "AMBIGUOUS_NUMBER_TYPE"` として保留し、各候補に `matched_field` を明示して返却する。
- 確定紐付け時の `document_product_links.match_method`:
  - 受付番号一致: `"reception_number_exact"`
  - 商品番号一致: `"auction_bid_number_exact"`

---

## 3. フロントエンドからの呼び出しタイミングと非破壊原則

### 呼び出し順序
1. **新規商品登録時（画像からの商品登録 / 手動登録）**
   - Step 1: GAS Web App へ `import_product_by_images`（または `create_product`）を送信し、`product_id` の発行と商品保存を完了させる。
   - Step 2: `auction_item_number.trim() !== ""` の場合のみ、続けて `documents-relay` の `action: "auto_link_product_by_item_number"` を呼ぶ。
   - **重要**: Step 2 が `linked: false`（`0件` / `複数件` / `既存リンク競合` / `金額不整合`）または通信エラーになっても、**Step 1 の商品登録成功は絶対に取り消さない（ロールバック・削除しない）**。結果に応じた確認メッセージ・候補情報のみ画面に表示する。

2. **既存商品の `auction_item_number` 編集時**
   - Step 1: GAS Web App へ `action: "update_product"` を送信し、`auction_item_number` の更新を完了させる。
   - Step 2:
     - 空文字 `""` にクリアした場合: 自動紐付けAPIは呼ばない（既存の確定リンクを黙って解除もしない）。
     - 非空の番号を保存した場合: `documents-relay` の `action: "auto_link_product_by_item_number"` を呼ぶ。既にこの商品が別明細へ確定紐付け済みの場合は `PRODUCT_ALREADY_LINKED_TO_OTHER_LINE` が返り、既存リンクは維持される。

### リクエスト形式
- エンドポイント: `POST ${VITE_PUBLIC_SUPABASE_URL}/functions/v1/documents-relay`（`supabase.functions.invoke("documents-relay", { body })`）

```json
{
  "action": "auto_link_product_by_item_number",
  "product_id": "TMP-000161",
  "auction_item_number": "842-33225",
  "number_type": "auto",
  "supplier_name": "オークネット",
  "issue_date": "2025-11-18",
  "document_number": "443654",
  "document_id": "bf7272b8-f0b0-4651-b6dd-f469f631ee0d",
  "confirmed_by": "staff"
}
```

| フィールド | 必須 | 型 | 説明 |
| :--- | :---: | :--- | :--- |
| `action` | 必須 | `"auto_link_product_by_item_number"` | 固定アクション名 |
| `product_id` | 必須 | `string` | 保存済みの商品ID（例: `"TMP-000161"`） |
| `auction_item_number` | 任意 | `string` | 保存した商品番号（前後空白のみトリム、先頭ゼロ・ハイフン保持。空欄時は `skipped_empty_item_number` で正常終了） |
| `number_type` | 任意 | `"auto" \| "reception_number" \| "auction_bid_number"` | 省略時は `"auto"` |
| `supplier_name` | 任意 | `string` | 複数候補時の絞り込み条件（仕入先名の完全一致） |
| `issue_date` | 任意 | `string` | 複数候補時の絞り込み条件（発行日 `YYYY-MM-DD` 完全一致） |
| `document_number` | 任意 | `string` | 複数候補時の絞り込み条件（計算書・請求書番号の完全一致） |
| `document_id` | 任意 | `string` | 複数候補時の絞り込み条件（書類UUIDの完全一致） |
| `confirmed_by` | 任意 | `string` | 監査記録用識別子（省略時 `"auto_item_number"`） |
| `dry_run` | 任意 | `boolean` | `true` の場合はDB書込を行わず判定結果のみ返却 |

---

## 4. ステータス一覧と応答例

すべての業務判定結果（紐付け成功・再送・0件・複数候補・既存リンク競合・金額不整合・空欄）は **HTTP `200`** で返却されるため、`supabase.functions.invoke` の `data` から直接 `linked` / `status` / `reason_code` を参照できます。

| `status` | `linked` | `is_reused` | `reason_code` | 意味・画面での扱い |
| :--- | :---: | :---: | :--- | :--- |
| `"linked"` | `true` | `false` | `"AUTO_LINKED_EXACT_UNIQUE"` | 一意の未紐付け明細へ確定紐付け完了 |
| `"already_linked_same_product"` | `true` | `true` | `"ALREADY_LINKED_IDEMPOTENT"` | 同一商品・同一明細へ既に同額で紐付け済み（再送成功・二重作成なし） |
| `"skipped_empty_item_number"` | `false` | `false` | `"EMPTY_ITEM_NUMBER"` | 商品番号が空欄のためスキップ |
| `"no_match"` | `false` | `false` | `"NO_MATCHING_LINE"` / `"MATCHED_NON_PURCHASE_OR_CANCELED_LINE"` | 該当する仕入明細なし（未取込または番号確認を案内） |
| `"multiple_candidates"` | `false` | `false` | `"MULTIPLE_MATCHING_LINES"` / `"AMBIGUOUS_NUMBER_TYPE"` / `"HAS_RELATED_CANCEL_OR_REFUND_LINE"` | 複数候補あり（自動紐付け保留・`candidates` と `suggested_narrowing_fields` を表示） |
| `"conflict_existing_link"` | `false` | `false` | `"LINE_ALREADY_LINKED_TO_OTHER_PRODUCT"` / `"PRODUCT_ALREADY_LINKED_TO_OTHER_LINE"` / `"EXISTING_LINK_AMOUNT_DISCREPANCY"` | 既存リンクと競合（既存リンクは解除・変更せず維持、`conflicting_links` を表示） |
| `"amount_error"` | `false` | `false` | `"LINE_AMOUNT_UNSET"` / `"LINE_TOTAL_DISCREPANCY"` | 明細金額未入力または内訳と税込合計の不整合により保留 |

### 応答例①: 一意候補・確定紐付け成功（`status: "linked"`）
```json
{
  "success": true,
  "linked": true,
  "is_reused": false,
  "status": "linked",
  "reason_code": "AUTO_LINKED_EXACT_UNIQUE",
  "message": "一意の仕入明細を確認し、商品へ自動紐付けしました。",
  "product_id": "TMP-000162",
  "auction_item_number": "855-19157",
  "searched_number_type": "auto",
  "matched_number_type": "reception_number",
  "match_method": "reception_number_exact",
  "product_registration_preserved": true,
  "tax_confirmed": true,
  "allocated_amount": 23452,
  "candidate_count": 1,
  "candidate": {
    "document_line_id": "ddfb5fa8-68a5-4826-a6a1-35e49789740a",
    "document_id": "bf7272b8-f0b0-4651-b6dd-f469f631ee0d",
    "document_number": "443654",
    "supplier_name": "オークネット",
    "issue_date": "2025-11-18",
    "matched_field": "reception_number_raw",
    "matched_number_label": "落札・受付番号",
    "reception_number_raw": "855-19157",
    "auction_bid_number": "80328",
    "item_name_raw": "スカルプリント 長袖Ｔシャツ その他",
    "item_amount": 20500,
    "fee_amount": 820,
    "tax_amount": 2050,
    "fee_tax_amount": 82,
    "total_line_amount": 23452,
    "expected_allocated_amount": 23452,
    "tax_confirmed": true,
    "match_status": "confirmed"
  },
  "link": {
    "id": "...",
    "document_line_id": "ddfb5fa8-68a5-4826-a6a1-35e49789740a",
    "product_id": "TMP-000162",
    "link_type": "primary_cost",
    "allocated_amount": 23452,
    "allocation_method": "direct",
    "match_method": "reception_number_exact",
    "status": "confirmed"
  },
  "product_cost": {
    "product_id": "TMP-000162",
    "document_count": 1,
    "matched_lines_count": 1,
    "total_primary_cost": 23452,
    "total_allocated_cost": 23452
  }
}
```

### 応答例②: 既存リンク競合（実データ `TMP-000161` × `"842-33225"` の実測応答）
```json
{
  "success": true,
  "linked": false,
  "is_reused": false,
  "status": "conflict_existing_link",
  "reason_code": "LINE_ALREADY_LINKED_TO_OTHER_PRODUCT",
  "message": "該当する仕入明細は既に別商品（TMP-000134）に確定紐付けされているため、自動紐付けを行いませんでした。既存リンクは維持されています。",
  "product_id": "TMP-000161",
  "auction_item_number": "842-33225",
  "searched_number_type": "auto",
  "matched_number_type": "reception_number",
  "product_registration_preserved": true,
  "candidate_count": 1,
  "candidate": {
    "document_line_id": "ddfb5fa8-68a5-4826-a6a1-35e49789740a",
    "document_id": "bf7272b8-f0b0-4651-b6dd-f469f631ee0d",
    "document_number": "443654",
    "supplier_name": "オークネット",
    "issue_date": "2025-11-18",
    "matched_field": "reception_number_raw",
    "reception_number_raw": "842-33225",
    "auction_bid_number": "80328",
    "item_name_raw": "スカルプリント 長袖Ｔシャツ その他",
    "item_amount": 20500,
    "fee_amount": 820,
    "tax_amount": 2050,
    "fee_tax_amount": 82,
    "total_line_amount": 23452,
    "expected_allocated_amount": 23452,
    "tax_confirmed": true
  },
  "conflicting_links": [
    {
      "link_id": "018883e7-1664-4dee-bd41-9cacc092ffe2",
      "document_line_id": "ddfb5fa8-68a5-4826-a6a1-35e49789740a",
      "product_id": "TMP-000134",
      "link_type": "primary_cost",
      "allocated_amount": 21320,
      "allocation_method": "direct",
      "match_method": "manual",
      "confirmed_at": "2026-10-29T07:37:29.149+00:00",
      "product_summary": {
        "product_id": "TMP-000134",
        "record_status": "active",
        "publish_status": "draft",
        "product_name": "CHROME HEARTS × Joe Foti Wing Skull L/S T-Shirt Black クロムハーツ 長袖Tシャツ",
        "category": "apparel",
        "auction_item_number": ""
      }
    }
  ],
  "unlinked_history": [
    {
      "link_id": "eff35083-f244-47bf-bf70-f07e8dab2663",
      "product_id": "TMP-000159",
      "link_type": "primary_cost",
      "allocated_amount": 21320,
      "status": "unlinked",
      "deleted_at": "2026-10-29T06:58:41.877+00:00"
    }
  ]
}
```

### 応答例③: 複数候補あり（`status: "multiple_candidates"`）
```json
{
  "success": true,
  "linked": false,
  "is_reused": false,
  "status": "multiple_candidates",
  "reason_code": "MULTIPLE_MATCHING_LINES",
  "message": "番号「64014」に一致する仕入明細が 2 件あるため、自動紐付けを保留しました。仕入先・仕入日・書類番号等で確認してください。",
  "product_id": "TMP-000163",
  "auction_item_number": "64014",
  "searched_number_type": "auto",
  "matched_number_type": "auction_bid_number",
  "product_registration_preserved": true,
  "candidate_count": 2,
  "suggested_narrowing_fields": [
    "issue_date",
    "document_number",
    "reception_number_raw",
    "document_id"
  ],
  "candidates": [
    {
      "document_line_id": "3285622e-dd5e-4f6b-9ea6-c1f1c2bf9659",
      "document_id": "553146fa-1f82-47aa-a91a-5e18cd81021c",
      "document_number": "453560",
      "supplier_name": "オークネット",
      "issue_date": "2025-12-23",
      "matched_field": "auction_bid_number",
      "reception_number_raw": "849-20866",
      "auction_bid_number": "64014",
      "item_name_raw": "モノグラム ジャケット",
      "total_line_amount": 65208,
      "expected_allocated_amount": 65208
    },
    {
      "document_line_id": "6518a628-989f-4781-b947-ae5c287b3c65",
      "document_id": "a14144dd-e8ff-40bb-9073-bfe362d90f2c",
      "document_number": "388577",
      "supplier_name": "オークネット",
      "issue_date": "2025-04-22",
      "matched_field": "auction_bid_number",
      "reception_number_raw": "815-47526",
      "auction_bid_number": "64014",
      "item_name_raw": "アレッサンドロ スカーズ カリグラ",
      "total_line_amount": 67496,
      "expected_allocated_amount": 67496
    }
  ]
}
```

### 応答例④: 候補なし（`status: "no_match"`）
```json
{
  "success": true,
  "linked": false,
  "is_reused": false,
  "status": "no_match",
  "reason_code": "NO_MATCHING_LINE",
  "message": "番号「999-99999」に完全一致する仕入明細は見つかりませんでした。",
  "product_id": "TMP-000164",
  "auction_item_number": "999-99999",
  "searched_number_type": "auto",
  "matched_number_type": null,
  "product_registration_preserved": true,
  "candidate_count": 0,
  "candidates": []
}
```

### 応答例⑤: 同一要求の再送（`status: "already_linked_same_product"`, `is_reused: true`）
```json
{
  "success": true,
  "linked": true,
  "is_reused": true,
  "status": "already_linked_same_product",
  "reason_code": "ALREADY_LINKED_IDEMPOTENT",
  "message": "既に同じ仕入明細へ確定紐付け済みです（二重作成なし）。",
  "product_id": "TMP-000162",
  "auction_item_number": "855-19157",
  "searched_number_type": "auto",
  "matched_number_type": "reception_number",
  "product_registration_preserved": true,
  "tax_confirmed": true,
  "allocated_amount": 23452,
  "candidate_count": 1,
  "link": { "id": "...", "allocated_amount": 23452, "status": "confirmed" },
  "product_cost": { "total_allocated_cost": 23452 }
}
```

