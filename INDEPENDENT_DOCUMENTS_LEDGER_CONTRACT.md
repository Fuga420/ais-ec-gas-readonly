# INDEPENDENT_DOCUMENTS_LEDGER_CONTRACT.md
# 請求書・領収書の独立取込と受付番号照合・商品別損益 API仕様書 & データモデル (改訂版)

> **対象仕様**: Notion「2026-10-13｜請求書・領収書の独立取込と受付番号照合・商品別損益」工程0 & 工程1  
> **ブランチ**: `feat/independent-document-ledger-schema`  
> **ステータス**: レビュー反映・改訂完了 / 隔離PostgreSQL検証PASS (本番未適用)

---

## 1. 背景と改訂設計方針

### 1-1. レビュー反映による重要改善
1. **厳格なアクセス制御 (RLS & View)**:
   - 「ブラウザから直接アクセスを全拒否」という原則に基づき、テーブルおよびビューから `PUBLIC`, `anon`, `authenticated` の権限を剥奪。
   - 2つのビュー（`v_document_audit_summary`, `v_product_cost_breakdown`）に `WITH (security_invoker = true)` を付与し、ビュー経由でのRLS迂回を完全に遮断。
   - DB操作権限は、許可されたサーバー中継（Supabase Edge Functions の `service_role`）のみに限定。
2. **符号と集計の厳格化 (手元原本例に完全適合)**:
   - 監査差額（`discrepancy_amount`）は、原本公称合計と「キャンセル行・返金行を含めた全明細純額」を突き合わせて算出（キャンセル行を一律除外しないことで原本との差額を正確に判定）。
   - 商品原価集約（`v_product_cost_breakdown`）において、販売精算（`sale_settlement`）を商品原価に絶対に足さず、売上精算として完全分離。
   - 共通経費（参加費・事務諸費用）の自動按分は実装せず、手動での明細管理にとどめる。
3. **履歴保全と削除抑止 (ON DELETE RESTRICT & 訂正追跡)**:
   - `ON DELETE CASCADE` を全廃し、`ON DELETE RESTRICT` を採用（紐づく明細や照合リンクが存在する親レコードの安易な物理削除を禁止）。
   - 論理削除（`is_deleted`）および訂正元参照（`correction_of_line_id`）により、誤入力訂正時にも元の記録を完全追跡可能化。
4. **金額未確認 (NULL) と 0円の厳格な区別**:
   - 原本の先行保管を可能にするため、`total_amount`、`item_amount`、`fee_amount` は NULL 許容とし、「金額未入力・未確認（NULL）」と「無償・手数料0円（0.00）」を明確に区別。
5. **照合APIの段階分離 (手動照合 vs 自動照合)**:
   - 現状の商品マスタに受付番号列が存在しないため、MVPでは「スタッフによる手動紐付けAPI」を提供。
   - 保存先（SheetsまたはDB）の正式決定後に有効化される「自動候補取得API」と明確に契約を分離。

---

## 2. セキュリティ・認証およびアクセス制御仕様

### 2-1. アクセス権限マトリクス
| アクセス主体 | 接続経路 | documents / lines / links 表 | 監査・原価 ビュー | 備考 |
| :--- | :--- | :--- | :--- | :--- |
| **匿名ユーザー (anon)** | ブラウザ直接 | **全アクセス拒否 (Deny)** | **全アクセス拒否 (Deny)** | 403 Forbidden / 空配列 |
| **一般認証ユーザー (authenticated)** | ブラウザ直接 | **全アクセス拒否 (Deny)** | **全アクセス拒否 (Deny)** | RLS & View invoker で遮断 |
| **書類中継 Edge Function (service_role)** | サーバー間通信 | **全操作許可 (Full)** | **SELECT 許可** | 管理スタッフ確認後のみ実行 |

### 2-2. 既存管理画面の実装に基づくスタッフ確認仕様（新規ログイン新設なし）
既存コード（[`bis-ec-frontend`](file:///C:/Users/aij/Documents/bis-ec-frontend) および [`コード.js`](file:///C:/Users/aij/Documents/ais-ec-gas-search-grounding/%E3%82%B3%E3%83%BC%E3%83%89.js)）の認証設計に基づき、Edge Functionが `service_role` を行使する前に以下の多層防御でリクエスト元を検証します：

```text
Readdy 管理画面 (ブラウザ)
  │
  ├─ 1. CORS Origin ヘッダー (管理画面ドメイン)
  ├─ 2. スタッフ識別子 (confirmed_by / staff_name)
  ├─ 3. セッション検証トークン (X-BIS-Staff-Token)
  ▼
Supabase Edge Function (documents-relay)
  │
  ├─ Step 1: CORS オリジン照合 (`ALLOWED_ORIGINS` 以外は 403 拒否)
  ├─ Step 2: Gateway JWT 検証 (`verify_jwt = true`)
  ├─ Step 3: スタッフ識別情報および社内管理トークンの検証 (Fail-Closed)
  │          ※ 原本Drive保存時は GAS Web App (ADMIN_API_KEY) とサーバー間連携
  ▼
PostgreSQL (service_role でクエリ実行)
```

1. **CORS オリジン制限 (`ALLOWED_ORIGINS`)**:
   ブラウザの `Origin` ヘッダーを検証し、社内管理画面ドメイン以外からの呼出しを即座に 403 遮断。
2. **ゲートウェイ署名検証 (`verify_jwt = true`)**:
   Supabase API Gateway を経由した正規のリクエストであることを検証。
3. **スタッフ識別子の必須化と監査ログ**:
   すべての更新・確定操作において、スタッフ識別子（`confirmed_by`）を必須とし、空文字の場合は `STAFF_IDENTIFIER_REQUIRED` で拒否。
4. **GAS管理者セッション連携（Drive原本操作時）**:
   原本PDFをGoogle Driveへ格納する処理は、Edge FunctionからGAS Web Appへ管理者シークレット（`GAS_ADMIN_SECRET`）を伴って実行されるため、GAS側の管理者検証（`verifyAdminAccess_`）を通過しない限り原本登録が成立しない構造を維持。

---

## 3. 取引区分・符号および集計ルール（原本実例対比）

### 3-1. 取引区分 (`transaction_type`) と符号
| 区分 (`transaction_type`) | 内容 | 明細金額の符号 | 書類監査への影響 | 商品原価への影響 |
| :--- | :--- | :--- | :--- | :--- |
| `purchase` | 落札金額・仕入商品代 | **プラス (+)** | 請求額に加算 | 主仕入原価 (`primary_cost`) |
| `commission` / `fee_only` | 取引手数料・落札手数料 | **プラス (+)** | 請求額に加算 | 手数料原価 (`commission`) |
| `participation_fee` | 大会参加費・事務諸費用 | **プラス (+)** | 請求額に加算 | **自動按分なし**（共通経費） |
| `shipping` | 配送料 | **プラス (+)** | 請求額に加算 | 配送原価 (`shipping_cost`) |
| `other_expense` | 写真代・鑑定料等 | **プラス (+)** | 請求額に加算 | その他経費原価 (`other_expense`) |
| `unsold_fee` | 流札手数料・出品手数料 | **プラス (+)** | 請求額に加算 | **商品原価非加算**（共通経費） |
| `cancel` | 落札取消（手数料のみ等） | **プラス / 0** | 請求額に算入 | **商品原価非加算** |
| `refund` / `discount` | 返品返金・不良値引 | **マイナス (-)** | 請求額を減算 | 仕入原価から減算 (`-refund`) |
| `sale_settlement` | 出品販売精算（売上代金） | **マイナス (-)** | 請求額相殺 | **原価には絶対に足さない**（売上精算） |

### 3-2. 原本監査差額の計算式
```text
discrepancy_amount = declared_total_amount - SUM(total_line_amount)
```
- 原本記載の総請求額（`total_amount`）と、キャンセル行・返金行・相殺行を含めた**全有効明細の純額合計**を比較します。
- これにより、コメ兵の精算書（1,263,295円）や、オークネットの相殺精算（買上490,600円 - 雑費4,000円など）において、キャンセルや値引を理由とした誤検知差額（False Discrepancy）が発生しません。
- `total_amount` が未入力（`NULL`）の場合は、差額も `NULL`（金額未確定）として扱います。

### 3-3. 商品別原価積上げの計算式
```text
total_allocated_cost = primary_cost + commission + shipping_cost + other_expense - ABS(refund)
```
- **販売精算（`sale_settlement`）は原価計算から完全に除外**し、参考情報 `total_sale_proceeds` として別列で表示します。
- **共通経費（参加費等）の自動按分は行いません**。

---

## 4. データベーステーブル定義 (PostgreSQL)

マイグレーションファイル: [`migrations/20261013_independent_documents_ledger.sql`](file:///C:/Users/aij/Documents/ais-ec-gas-search-grounding/migrations/20261013_independent_documents_ledger.sql)

### 4-1. `documents` (書類原本台帳)
- `id`: UUID PRIMARY KEY DEFAULT gen_random_uuid()
- `document_number`: VARCHAR(100)
- `invoice_registration_number`: VARCHAR(50) (適格請求書登録番号)
- `document_type`: VARCHAR(50) NOT NULL (`invoice`, `receipt`, `statement`, `delivery_note`, `other`)
- `supplier_name`: VARCHAR(255) NOT NULL
- `supplier_code`: VARCHAR(100)
- `issue_date`: DATE
- `due_date`: DATE
- `currency`: VARCHAR(10) NOT NULL DEFAULT 'JPY'
- `total_amount`: NUMERIC(12, 2) (NULL許容: NULL = 未確認, 0.00 = 0円)
- `tax_amount`: NUMERIC(12, 2) (NULL許容)
- `drive_file_id`: VARCHAR(255) NOT NULL
- `drive_folder_id`: VARCHAR(255)
- `drive_file_url`: TEXT
- `file_name`: VARCHAR(255) NOT NULL
- `mime_type`: VARCHAR(100) NOT NULL
- `file_size`: BIGINT NOT NULL
- `file_fingerprint`: VARCHAR(64) NOT NULL (SHA-256)
- `idempotency_key`: VARCHAR(255) NOT NULL
- `status`: VARCHAR(50) NOT NULL DEFAULT 'pending' (`pending`, `pending_amount`, `lines_registered`, `partially_matched`, `fully_matched`, `flagged`, `archived`)
- `extracted_line_count`: INTEGER NOT NULL DEFAULT 0
- `extracted_total_amount`: NUMERIC(12, 2)
- `discrepancy_amount`: NUMERIC(12, 2)
- `notes`: TEXT
- `is_deleted`: BOOLEAN NOT NULL DEFAULT FALSE (論理削除)
- `deleted_at`: TIMESTAMPTZ
- `deleted_by`: VARCHAR(100)
- `created_by`: VARCHAR(100) NOT NULL DEFAULT 'system'
- `created_at`: TIMESTAMPTZ NOT NULL DEFAULT NOW()
- `updated_at`: TIMESTAMPTZ NOT NULL DEFAULT NOW()
- **制約**: `UNIQUE (idempotency_key)`, `UNIQUE (file_fingerprint)`

### 4-2. `document_lines` (明細行台帳)
- `id`: UUID PRIMARY KEY DEFAULT gen_random_uuid()
- `document_id`: UUID NOT NULL REFERENCES documents(id) **ON DELETE RESTRICT** (原本物理削除抑止)
- `page_number`: INTEGER NOT NULL DEFAULT 1
- `line_number`: INTEGER NOT NULL
- `reception_number_raw`: VARCHAR(100)
- `reception_number_normalized`: VARCHAR(100) (※非一意)
- `lot_number`: VARCHAR(50)
- `branch_number`: VARCHAR(50)
- `auction_bid_number`: VARCHAR(100)
- `item_name_raw`: TEXT NOT NULL
- `brand_name_raw`: VARCHAR(255)
- `category_hint`: VARCHAR(100)
- `item_rank_raw`: VARCHAR(50)
- `accessory_raw`: TEXT
- `transaction_type`: VARCHAR(50) NOT NULL DEFAULT 'purchase'
- `item_amount`: NUMERIC(12, 2) (NULL許容)
- `tax_amount`: NUMERIC(12, 2) (NULL許容)
- `item_amount_tax_included`: NUMERIC(12, 2) GENERATED STORED (NULL時NULL)
- `fee_rate`: NUMERIC(5, 2)
- `fee_amount`: NUMERIC(12, 2) (NULL許容)
- `fee_tax_amount`: NUMERIC(12, 2) (NULL許容)
- `fee_amount_tax_included`: NUMERIC(12, 2) GENERATED STORED (NULL時NULL)
- `other_expense_amount`: NUMERIC(12, 2) (NULL許容)
- `other_expense_tax_amount`: NUMERIC(12, 2) (NULL許容)
- `other_expense_tax_included`: NUMERIC(12, 2) GENERATED STORED (NULL時NULL)
- `total_line_amount`: NUMERIC(12, 2) (符号付き純額税込, NULL許容)
- `is_canceled`: BOOLEAN NOT NULL DEFAULT FALSE
- `cancel_reason`: TEXT
- `match_status`: VARCHAR(50) NOT NULL DEFAULT 'unlinked'
- `is_active`: BOOLEAN NOT NULL DEFAULT TRUE (最新有効フラグ)
- `correction_of_line_id`: UUID REFERENCES document_lines(id) **ON DELETE RESTRICT** (訂正履歴追跡)
- `correction_reason`: TEXT
- `is_deleted`: BOOLEAN NOT NULL DEFAULT FALSE
- `deleted_at`: TIMESTAMPTZ
- `deleted_by`: VARCHAR(100)
- `created_at`: TIMESTAMPTZ NOT NULL DEFAULT NOW()
- `updated_at`: TIMESTAMPTZ NOT NULL DEFAULT NOW()
- **制約**: `UNIQUE (document_id, page_number, line_number)`

### 4-3. `document_product_links` (照合台帳)
- `id`: UUID PRIMARY KEY DEFAULT gen_random_uuid()
- `document_line_id`: UUID NOT NULL REFERENCES document_lines(id) **ON DELETE RESTRICT** (明細物理削除抑止)
- `product_id`: VARCHAR(100) NOT NULL
- `link_type`: VARCHAR(50) NOT NULL DEFAULT 'primary_cost' (`primary_cost`, `commission`, `shipping_cost`, `other_expense`, `refund`, `sale_settlement`)
- `allocated_amount`: NUMERIC(12, 2) NOT NULL
- `allocation_method`: VARCHAR(50) NOT NULL DEFAULT 'direct' (`direct`, `manual_split` ※自動按分は実装しない)
- `match_method`: VARCHAR(50) NOT NULL DEFAULT 'manual' (`manual`, `reception_number_exact`)
- `confidence_score`: NUMERIC(3, 2) NOT NULL DEFAULT 1.00
- `status`: VARCHAR(50) NOT NULL DEFAULT 'confirmed'
- `confirmed_by`: VARCHAR(100)
- `confirmed_at`: TIMESTAMPTZ
- `is_deleted`: BOOLEAN NOT NULL DEFAULT FALSE
- `deleted_at`: TIMESTAMPTZ
- `deleted_by`: VARCHAR(100)
- `created_at`: TIMESTAMPTZ NOT NULL DEFAULT NOW()
- `updated_at`: TIMESTAMPTZ NOT NULL DEFAULT NOW()
- **制約**: `UNIQUE (document_line_id, product_id, link_type)`

---

## 5. API契約仕様 (Readdy Edge Function: documents-relay)

ブラウザ（Readdyフロントエンド）は Supabase SDK の `functions.invoke` を使用して本中継を呼び出します：
```ts
const { data, error } = await supabase.functions.invoke("documents-relay", {
  body: { action: "<ACTION_NAME>", ...params }
});
```

> **MVP運用方針（更新・削除）**:
> - MVPでは明細行の直接更新（上書き更新）をサポートします。新旧行を別レコードとして完全保持する履歴管理は将来拡張とし、行の取消・削除は論理削除（`is_deleted: true`）および `is_canceled: true` で安全に保全します。
> - 書類の受付番号は明細行（`document_lines.reception_number_raw` / `reception_number_normalized`）で一元管理し、原本台帳（`documents`）には重複保持しません。

### 5-1. 書類独立取込 (`action: "import_document"`)
商品が未登録でもPDF/JPG/PNG書類をDriveへ保存し、`documents` 台帳へ登録します。DB先行照合により同一再送（`idempotency_key`）および同一内容（`file_fingerprint`）のDrive二重作成を完全抑止します。

**Request Body**:
```json
{
  "action": "import_document",
  "idempotency_key": "c1f7b0a1-4321-4d1a-9f5b-123456789abc",
  "supplier_name": "コメ兵",
  "supplier_code": "2764",
  "document_type": "statement",
  "document_number": "20250507_KOMEHYO",
  "invoice_registration_number": "T2180001141237",
  "issue_date": "2025-05-07",
  "total_amount": 1263295,
  "tax_amount": 114845,
  "currency": "JPY",
  "file_name": "20251216_計算書_K026021.pdf",
  "mime_type": "application/pdf",
  "base64": "JVBERi0xLjQK...",
  "notes": "アパレル落札計算書"
}
```
*※ `supplier_name` は必須入力。`total_amount` は省略または `null` 可能（原本先行保管）。*

**Response (201 Created / 200 Reused)**:
```json
{
  "success": true,
  "is_reused": false,
  "document": {
    "id": "a0000000-0000-0000-0000-000000000001",
    "idempotency_key": "c1f7b0a1-4321-4d1a-9f5b-123456789abc",
    "document_type": "statement",
    "document_number": "20250507_KOMEHYO",
    "supplier_name": "コメ兵",
    "supplier_code": "2764",
    "issue_date": "2025-05-07",
    "total_amount": 1263295.00,
    "tax_amount": 114845.00,
    "currency": "JPY",
    "file_name": "20251216_計算書_K026021.pdf",
    "mime_type": "application/pdf",
    "file_size": 245100,
    "file_fingerprint": "a3f89e2...",
    "drive_file_id": "1HoDrdlNN...",
    "drive_folder_id": "mock_indep_folder_001",
    "drive_file_url": "https://drive.google.com/file/d/1HoDrdlNN.../view",
    "notes": "アパレル落札計算書",
    "status": "pending",
    "created_at": "2026-10-13T16:00:00Z"
  },
  "audit": {
    "document_id": "a0000000-0000-0000-0000-000000000001",
    "declared_total_amount": 1263295.00,
    "extracted_total_amount": 0.00,
    "active_lines_count": 0,
    "confirmed_lines_count": 0,
    "unlinked_lines_count": 0,
    "discrepancy_amount": 1263295.00,
    "is_balanced": false
  }
}
```

### 5-2. 書類一覧取得 (`action: "list_documents"`)
登録済み書類の一覧をページネーション・検索・監査差額サマリー付きで取得します。

**Request Body (または GET クエリパラメータ)**:
```json
{
  "action": "list_documents",
  "status": "all",
  "supplier_name": "コメ兵",
  "page": 1,
  "page_size": 20
}
```

**Response (200 OK)**:
```json
{
  "success": true,
  "count": 1,
  "page": 1,
  "page_size": 20,
  "total_pages": 1,
  "documents": [
    {
      "id": "a0000000-0000-0000-0000-000000000001",
      "file_name": "20251216_計算書_K026021.pdf",
      "supplier_name": "コメ兵",
      "issue_date": "2025-05-07",
      "total_amount": 1263295.00,
      "status": "pending",
      "drive_file_url": "https://drive.google.com/file/d/...",
      "audit": {
        "declared_total_amount": 1263295.00,
        "extracted_total_amount": 0.00,
        "discrepancy_amount": 1263295.00,
        "confirmed_lines_count": 0,
        "unlinked_lines_count": 0,
        "is_balanced": false
      }
    }
  ]
}
```

### 5-3. 書類詳細取得 (`action: "get_document"`)
書類の原本メタデータ、監査差額、明細行一覧、各行に紐づく商品リンクを一括取得します。

**Request Body (または GET クエリパラメータ)**:
```json
{
  "action": "get_document",
  "document_id": "a0000000-0000-0000-0000-000000000001"
}
```

**Response (200 OK)**:
```json
{
  "success": true,
  "document": {
    "id": "a0000000-0000-0000-0000-000000000001",
    "file_name": "20251216_計算書_K026021.pdf",
    "supplier_name": "コメ兵",
    "total_amount": 1263295.00,
    "status": "partially_matched"
  },
  "audit": {
    "declared_total_amount": 1263295.00,
    "extracted_total_amount": 1263295.00,
    "discrepancy_amount": 0.00,
    "confirmed_lines_count": 1,
    "unlinked_lines_count": 6,
    "is_balanced": true
  },
  "lines": [
    {
      "id": "b0000000-0000-0000-0000-000000000001",
      "line_number": 1,
      "page_number": 1,
      "reception_number_raw": "K026021",
      "reception_number_normalized": "K026021",
      "item_name_raw": "CHANEL マトラッセ チェーンショルダー",
      "transaction_type": "purchase",
      "item_amount": 450000.00,
      "tax_amount": 45000.00,
      "fee_amount": 22500.00,
      "fee_tax_amount": 2250.00,
      "total_line_amount": 519750.00,
      "match_status": "confirmed",
      "links": [
        {
          "id": "c0000000-0000-0000-0000-000000000001",
          "product_id": "TMP-000117",
          "link_type": "primary_cost",
          "allocated_amount": 519750.00,
          "match_method": "manual",
          "status": "confirmed",
          "confirmed_by": "staff_suzuki"
        }
      ]
    }
  ]
}
```

### 5-4. 明細行の手動登録・更新 (`action: "save_document_lines"`)
手動またはCSVインポート由来の明細行を登録・修正します。既存行は `id` 指定で直接更新、未指定は新規追加されます。登録後、書類ステータスが自動再評価されます。

**Request Body**:
```json
{
  "action": "save_document_lines",
  "document_id": "a0000000-0000-0000-0000-000000000001",
  "confirmed_by": "staff_suzuki",
  "lines": [
    {
      "page_number": 1,
      "line_number": 1,
      "reception_number_raw": "K026021",
      "reception_number_normalized": "K026021",
      "item_name_raw": "CHANEL マトラッセ チェーンショルダー",
      "transaction_type": "purchase",
      "item_amount": 450000,
      "tax_amount": 45000,
      "fee_amount": 22500,
      "fee_tax_amount": 2250,
      "total_line_amount": 519750,
      "is_canceled": false,
      "notes": "美品・箱あり"
    },
    {
      "page_number": 1,
      "line_number": 2,
      "item_name_raw": "事務諸費用",
      "transaction_type": "participation_fee",
      "item_amount": 1000,
      "tax_amount": 100,
      "total_line_amount": 1100,
      "is_canceled": false,
      "notes": "参加費"
    }
  ]
}
```

### 5-5. 明細行の論理削除 (`action: "delete_document_line"`)
**Request Body**:
```json
{
  "action": "delete_document_line",
  "document_line_id": "b0000000-0000-0000-0000-000000000002",
  "deleted_by": "staff_suzuki"
}
```

### 5-6. 商品ID手動紐付け (`action: "link_product_manual"`)
明細行に対し、管理スタッフが商品IDおよび原価種別（`link_type`）を指定して手動紐付けを確定します。

**Request Body**:
```json
{
  "action": "link_product_manual",
  "document_line_id": "b0000000-0000-0000-0000-000000000001",
  "product_id": "TMP-000117",
  "link_type": "primary_cost",
  "allocated_amount": 519750,
  "confirmed_by": "staff_suzuki",
  "notes": "落札明細と商品現物を照合完了"
}
```
*※ `link_type` 未指定時は `primary_cost`。指定可能値: `primary_cost`, `commission`, `shipping_cost`, `other_expense`, `refund`, `sale_settlement`。*  
*※ `allocated_amount` 未指定時は明細の `total_line_amount` を使用。明細の `total_line_amount` も未設定（NULL）でリクエストの `allocated_amount` も未指定の場合は 400 `ALLOCATED_AMOUNT_REQUIRED` を返却。明示的な `0` は有効な0円として受け付ける。数値が無効または有限数でない場合は 400 `INVALID_ALLOCATED_AMOUNT` を返却。*

**Response (201 Created)**:
```json
{
  "success": true,
  "link": {
    "id": "c0000000-0000-0000-0000-000000000001",
    "document_line_id": "b0000000-0000-0000-0000-000000000001",
    "product_id": "TMP-000117",
    "link_type": "primary_cost",
    "allocated_amount": 519750.00,
    "allocation_method": "direct",
    "match_method": "manual",
    "status": "confirmed",
    "confirmed_by": "staff_suzuki",
    "confirmed_at": "2026-10-13T16:00:00Z",
    "notes": "落札明細と商品現物を照合完了"
  },
  "audit": {
    "declared_total_amount": 1263295.00,
    "extracted_total_amount": 519750.00,
    "discrepancy_amount": 743545.00,
    "confirmed_lines_count": 1,
    "unlinked_lines_count": 1,
    "is_balanced": false
  },
  "product_cost": {
    "product_id": "TMP-000117",
    "total_primary_cost": 519750.00,
    "total_commission_fee": 0.00,
    "total_allocated_cost": 519750.00,
    "total_sale_proceeds": 0.00
  }
}
```

### 5-7. 手動紐付け解除 (`action: "unlink_product_manual"`)
**Request Body**:
```json
{
  "action": "unlink_product_manual",
  "link_id": "c0000000-0000-0000-0000-000000000001",
  "deleted_by": "staff_suzuki"
}
```

### 5-8. 商品別原価・書類照合状況取得 (`action: "get_product_cost"`)
指定した商品IDに紐付いている書類明細および集計原価を取得します。

**Request Body (または GET クエリパラメータ)**:
```json
{
  "action": "get_product_cost",
  "product_id": "TMP-000117"
}
```

**Response (200 OK)**:
```json
{
  "success": true,
  "product_id": "TMP-000117",
  "cost_breakdown": {
    "product_id": "TMP-000117",
    "total_primary_cost": 450000.00,
    "total_commission_fee": 24750.00,
    "total_shipping_cost": 0.00,
    "total_other_expense": 0.00,
    "total_purchase_refund": 0.00,
    "total_allocated_cost": 474750.00,
    "total_sale_proceeds": 0.00
  },
  "links": [
    {
      "id": "c0000000-0000-0000-0000-000000000001",
      "allocated_amount": 450000.00,
      "link_type": "primary_cost",
      "match_method": "manual",
      "status": "confirmed",
      "confirmed_by": "staff_suzuki",
      "line": {
        "item_name_raw": "CHANEL マトラッセ チェーンショルダー",
        "total_line_amount": 519750.00,
        "transaction_type": "purchase",
        "document": {
          "file_name": "20251216_計算書_K026021.pdf",
          "supplier_name": "コメ兵",
          "drive_file_url": "https://drive.google.com/file/d/..."
        }
      }
    }
  ]
}
```

---

## 6. Supabase接続設定（工程2向け・秘密値マスク）

| 設定項目 | 現在の設定状況 / 接続先 | 役割 |
| :--- | :--- | :--- |
| `SUPABASE_URL` | `https://yg9qauzldubdo1ca5z0z.helloreaddy.com/` | 既存Readdy管理のSaaS Supabaseプロキシ |
| `SUPABASE_ANON_KEY` | `sb_publishable_***` | フロントエンド公開用クライアントキー |
| `SUPABASE_SERVICE_ROLE_KEY` | *(プロジェクトSecretsに設定)* | Edge Function内部専用・DB全権限キー |
| `GAS_WEBHOOK_URL` | `https://script.google.com/macros/s/***` | GAS本番エンドポイント |
| `GAS_ADMIN_SECRET` | *(プロジェクトSecretsに設定)* | GAS管理者認証キー |
| `ALLOWED_ORIGINS` | `http://localhost:5173,https://*.helloreaddy.com` | CORS許可オリジン |

---

## 7. 会長・運用担当の未確定判断事項（実装前整理）

1. **商品側「受付番号」の正式保存先**:
   - 案A: Google Sheets（商品マスター）の末尾（AP列 / 42列目）に「受付番号」を新設する（Sheets上で目視可能、GASコードへの列定義確認が必要）。
   - 案B: Google Sheetsは変更せず、Supabase側に `product_identifiers` テーブルを新設して管理する（Sheets非侵襲、複数仕入先の識別子を管理可能）。
   - 案C: `document_product_links` を正本とし、手動紐付けの確定記録そのものを対応表とする（新規スキーマ不要）。
2. **原本PDFのGoogle Drive保管フォルダ構成**:
   - 商品未登録の書類を保管するため、独立した書類ルートフォルダ（例: `BIS_Documents/YYYY/MM/仕入先名/`）を新設するか。
3. **共通経費（大会参加費・事務諸費用）の負担ルール**:
   - ネットジャパンの参加費4,000円やコメ兵の事務諸費用1,100円など、回全体にかかる費用を「社内共通販管費」とするか、商品に手動按分するか。
4. **キャンセル・流札手数料の経費仕訳**:
   - 落札辞退や流札となった商品の手数料（例: 5,000円）を、商品原価ではなく営業外費用/販管費として集計するルール。
