# Square同期中断・不整合の照合・通知・回収 API契約書

最終更新: 2026-10-11 (JST)
対象機能: `feat/bulk-product-archive`（一括アーカイブ・復帰・再連携安全化）

---

## 1. 概要と背景

BIS ECバックエンドにおける商品公開処理（`update_publish_status("published")`）は、フェイルクローズ（Fail-Closed）原則に基づき、**「Square在庫を先行して1にする → 成功後にBIS本票（32列目）を `published` に書き換える」** という順序で実行されます。

この設計により「BISが公開中なのにSquare在庫が0」というEC側の二重受注リスクは防止されますが、**Square在庫を1にした直後、本票書き込み前にGASがタイムアウト（6分実行上限）や強制停止した場合、およびネットワーク切断が発生した場合**に、以下の「公開中断不整合」が残留します。

| 項目 | 状態 | 影響 |
| :--- | :--- | :--- |
| **BIS 本票** | `publish_status: "draft"` | BISサイト・EC上は非公開（下書き） |
| **Square Production** | カタログ有効、在庫 `1` (`IN_STOCK`) | **店頭POSレジで販売可能**（購入される可能性あり） |
| **オンライン決済リンク** | 未生成 / 無効 | オンライン決済は不可 |

本契約書は、この強制終了後の中断不整合について、**現在動作するGASバックエンドAPIの仕様**と、**今後Readdy側で実装すべき中継・UI・監視要件**を明確に区別し、不整合発生時の安全回収手順を定義するものです。

---

## 2. 実装ステータスの明確な区分（現状と今後の開発対象）

本システムにおける照合・回収機能は、バックエンド（GAS）とフロントエンド・中継（Readdy）で以下の通り実装段階が分かれています。**存在しない監視 runner による「自動検知」を前提とした運用設計を行ってはなりません。**

| コンポーネント | 実装ステータス | 現在の稼働状況・提供範囲 |
| :--- | :--- | :--- |
| **GAS 状態照合・検出 API** (`reconcile_square_product_status`) | **【専用ブランチに実装済み・GAS未配信】** | ブランチ `feat/bulk-product-archive` 内に実装完了（GAS本番デプロイは保留中）。管理者認証必須（POST/GET共に `admin_key` 照合必須）。外部状態（Square Catalog/在庫）を精査し、不整合ステータスを返却する。 |
| **GAS 安全回収 API** (`auto_reconcile: "complete_publish" / "stop_sales"`) | **【専用ブランチに実装済み・GAS未配信】** | ブランチ `feat/bulk-product-archive` 内に実装完了（GAS本番デプロイは保留中）。先行非公開化・事前条件厳格化・Fail-Closed を担保した安全回収を実行する。 |
| **GAS 決済リンク生成・ロールバック API** (`create_square_payment_link`) | **【専用ブランチに実装済み・GAS未配信】** | ブランチ `feat/bulk-product-archive` 内に実装完了（GAS本番デプロイは保留中）。事前検証エラーとSquare APIエラーの厳格分離、リンク失敗時の在庫0巻き戻し、および未確定・巻き戻し失敗時の状態不明（`unknown`）通知・要確認警告を返却する。 |
| **Readdy サーバー中継 (Relay / Edge Function)** | **【未実装・今後の開発対象】** | ブラウザに秘密鍵を置かずにスタッフセッションを認証して GAS へプロキシするサーバー層。現在未配備。 |
| **Readdy 画面 警告アラートバナー・回収ボタン UI** | **【未実装・今後の開発対象】** | 商品詳細画面で不整合を検知してスタッフに回収操作を促す UI。現在未配備。 |
| **定期巡回バッチ / 健全性監視 runner** | **【未実装・今後の開発対象】** | 全商品の不整合をバックグラウンドで自動巡回・検知・通知する runner。**現在は存在しない**。 |

> [!IMPORTANT]
> **自動検知 runner の不在に関する注意**:
> 現在のシステムには自動巡回・自動通知 runner は配備されていません。公開処理の中断やネットワーク切断が発生した場合、Readdy 側の実装が完了するまでは、**管理者が認証情報を用いて手動で照合APIを実行するか、GASコンソール/管理スクリプトから検証する必要があります。**

---

## 3. 責任境界と将来の運用トリガー

### 誰が (Who)
1. **店舗・EC運営スタッフ (一次対応者)**: Readdy 管理画面で対象商品を操作・確認するスタッフ（Readdy UI配備後）。
2. **Readdy サーバー中継 (Relay)**: スタッフのセッションを検証し、サーバー環境変数の `ADMIN_API_KEY` を付与して GAS API を安全に中継（Readdy 側未実装）。
3. **システム管理者 (現行の直接対応者)**: Readdy 側未配備の現段階において、障害発生時に認証鍵を用いて照合・回収 API を直接呼出。

### いつ (When)
- **トリガー A（即時・切断検知時 / 将来 Readdy 実装対象）**:
  Readdy クライアントが `update_publish_status("published")` を呼び出し、HTTP 504 やネットワークエラーを受け取った直後に中継経由で照合。
- **トリガー B（商品閲覧・操作時 / 将来 Readdy 実装対象）**:
  スタッフが下書き（`draft`）状態の商品の詳細画面を開いた際、または公開操作を再実行しようとした際。
- **トリガー C（障害復旧・手動照合時 / 現行運用可能）**:
  GAS 実行中断や Square 障害復旧後に、対象商品に対して管理者が照合 API を実行。

---

## 4. 照合API仕様 (How to Inspect)

### エンドポイント
- **URL**: GAS Web App URL
- **Method**: `POST`（推奨）または `GET`
- **認証**: **管理者認証必須** (`mode: "admin"`, `admin_key: "<ADMIN_API_KEY>"` または `token: "<ADMIN_API_KEY>"`)
  - ※`GET` の場合も `mode=admin` のみでは拒絶され、`admin_key` の検証が必須（Fail-Closed）。認証なし・キー不一致時は `UNAUTHORIZED_ADMIN_ACCESS` を返却。

### リクエスト (照合のみ・読み取り専用)
```json
{
  "action": "reconcile_square_product_status",
  "mode": "admin",
  "admin_key": "<ADMIN_API_KEY>",
  "product_id": "TMP-000001"
}
```

### 判定ステータス (`reconciliation_status`)
| ステータス | 判定条件 | 状態の説明 | 推奨アクション |
| :--- | :--- | :--- | :--- |
| `MISMATCH_SQUARE_IN_STOCK_BIS_DRAFT` | BIS=draft かつ Square在庫>0 | **【公開中断検知】** 店頭POS販売中だがBIS下書き | `complete_publish_or_stop_sales` |
| `UNKNOWN_EXTERNAL_ERROR` | Square Catalog/在庫取得失敗 | **【状態不明】** 外部APIエラーのため回収禁止 | `manual_inspection_required` |
| `POS_SALES_ENABLED_CHECKOUT_LINK_MISSING` | BIS=published, 在庫=1, カタログ有効, リンクなし | 店頭POS有効、オンライン決済リンクのみ未生成 | `create_square_payment_link` |
| `CONSISTENT_PUBLISHED` | BIS=published, 在庫=1, リンクあり | 正常公開中 | `none` |
| `CONSISTENT_DRAFT` | BIS=draft, 在庫=0 | 正常下書き（停止中） | `none` |
| `CONSISTENT_ARCHIVED` | BIS=archived, 在庫=0, カタログアーカイブ | 正常アーカイブ | `none` |
| `MISMATCH_ARCHIVED_WITH_LIVE_SQUARE` | BIS=archived だが Square在庫>0 または カタログ有効 | アーカイブ漏れ異常 | `stop_sales` |
| `MISMATCH_BIS_PUBLISHED_SQUARE_OUT_OF_STOCK` | BIS=published だが Square在庫0 | 公開中なのに在庫切れ/停止中 | `complete_publish` |

### レスポンス例（公開中断検知時）
```json
{
  "success": true,
  "product_id": "TMP-000001",
  "reconciliation_status": "MISMATCH_SQUARE_IN_STOCK_BIS_DRAFT",
  "anomaly_detected": true,
  "recommended_action": "complete_publish_or_stop_sales",
  "description": "【公開中断検知】Square在庫が1（店頭POS販売可能）ですが、BIS本票は未公開(draft)です。公開処理中のGAS停止やネットワーク中断の可能性があります。販売を完了する場合は published を再送し、販売を停止する場合は在庫を0に戻してください。",
  "bis_state": {
    "record_status": "active",
    "publish_status": "draft",
    "inventory_status": "in_stock",
    "has_payment_link": false
  },
  "square_state": {
    "square_item_id": "SQ_ITEM_01",
    "square_variation_id": "SQ_VAR_01",
    "is_archived": false,
    "inventory_quantity": 1,
    "pos_sales_enabled": true,
    "catalog_fetch_error": null,
    "inventory_fetch_error": null
  }
}
```

### レスポンス例（外部エラー時・フェイルクローズ）
```json
{
  "success": true,
  "product_id": "TMP-000001",
  "reconciliation_status": "UNKNOWN_EXTERNAL_ERROR",
  "anomaly_detected": true,
  "recommended_action": "manual_inspection_required",
  "description": "Square Catalog または 在庫の取得に失敗したため、外部状態が不明です（カタログエラー: Square catalog API HTTP 500, 在庫エラー: none）。フェイルクローズ原則に基づき、状態確定前の自動回収は禁止されます。",
  "square_state": {
    "pos_sales_enabled": "unknown",
    "catalog_fetch_error": "Square catalog API HTTP 500",
    "inventory_fetch_error": null
  }
}
```

---

## 5. 安全回収API仕様 (How to Recover)

### リクエスト
```json
{
  "action": "reconcile_square_product_status",
  "mode": "admin",
  "admin_key": "<ADMIN_API_KEY>",
  "product_id": "TMP-000001",
  "auto_reconcile": "complete_publish"
}
```

### 回収モードと厳格な事前条件

#### A. `complete_publish`（販売再開を安全に完了）
- **動作**: Square 在庫を1に補完/維持した上で、BIS本票（32列目）を `published` に更新して販売を正式に再開する。
- **事前条件（Fail-Closed 原則・違反時は即座に例外拒絶）**:
  1. **外部状態エラーなし**: `catalog_fetch_error` および `inventory_fetch_error` がないこと（状態不明時は回収禁止）。
  2. **アクティブ商品であること**: `record_status === "active"`（アーカイブ商品・削除商品は不可）。
  3. **在庫ステータスが in_stock であること**: `inventory_status === "in_stock"`（売却済 `sold`、予約中 `reserved` の商品は不可）。
  4. **Square バリエーションIDが存在すること**: `square_variation_id` が未登録の商品は不可。
  5. **Square カタログがアーカイブ解除済みであること**: `is_archived === false` であること（アーカイブ中の商品は先に `unarchive_square_production_product` を行う必要がある）。
  6. **公開ゲート通過**: `assertProductPublishable_` により、スニーカーサイズ必須等の商品バリデーションを通過すること。
- **成功レスポンス**:
  `reconciliation_applied: "complete_publish"`、`bis_state.publish_status: "published"`、`square_state.pos_sales_enabled: true`。

#### B. `stop_sales`（販売停止と安全回収）
- **更新順の安全性設計**:
  1. **Step 1: BIS 本票の非公開化**: `publishStatus !== "draft"` の場合、先に BIS 本票（32列目）を `"draft"` に更新する。
     - **効果**: EC公開サイト上から即座に商品を非公開化する。万が一後続の Square API が失敗しても、公開ページに販売可能商品として残存することを防ぐ。
  2. **Step 2: Square 在庫 0 化**: `squareVariationId` に対し在庫 0 を同期する（店頭POS販売停止）。
  3. **Step 3: オンライン決済リンク無効化**: 既存決済リンクを Square API で無効化し、シート列 AK/AL を消去。
  4. **Step 4: Square Catalog アーカイブ（archived商品のみ）**: `record_status === "archived"` かつカタログ未アーカイブの場合、Square Catalog アイテムをアーカイブ化する。
  5. **Step 5: キャッシュ消去・整合結果返却**: キャッシュを破棄し、更新結果を返却。
- **事前条件**:
  1. **外部状態エラーなし**: `catalog_fetch_error` および `inventory_fetch_error` がないこと。
- **成功レスポンス**:
  `reconciliation_applied: "stop_sales"`、`bis_state.publish_status: "draft"`、`square_state.inventory_quantity: 0`、`square_state.pos_sales_enabled: false`。
  （`record_status === "archived"` の場合は `square_state.is_archived: true`）

---

## 6. 失敗時・途中中断時の状態遷移マトリクス表

### 6-1. `stop_sales` 実行時のステップ別失敗状態マトリクス

| 中断・失敗地点 | BIS状態 (record / publish / inv) | Square 在庫 | Square カタログ | 決済リンク | API返却値 | 公開ページ販売 | 店舗POS販売 | 安全評価と対処 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **0. 実行前 (Published中断)** | active / published / in_stock | 1 | unarchived (有効) | 有効 | - | 販売中 | 販売中 | 不整合または回収実行前 |
| **失敗1: BIS下書き化失敗 (Step 1)** | active / published / in_stock (不変) | 1 (不変) | unarchived (不変) | 有効 (不変) | 例外エラー (`success: false`) | 販売中のまま | 販売中のまま | フェイルクローズ。回収不成立。シート権限やロックを確認し再試行 |
| **失敗2: Square在庫0化失敗 (Step 2)** | active / **draft** / in_stock | 1 (巻き戻し未達) | unarchived (有効) | 有効 | 例外エラー (`success: false`) | **非公開 (安全)** | 販売可能 (要確認) | **EC公開は停止**。店頭POSは販売可能リスクが残るため管理画面で確認・再試行 |
| **失敗3: 決済リンク無効化失敗 (Step 3)** | active / **draft** / in_stock | **0 (停止済)** | unarchived (有効) | 有効 (残存) | 例外エラー (`success: false`) | **非公開 (安全)** | **販売停止 (安全)** | 在庫0のため決済リンクから購入されてもSquareが在庫切れ拒絶。安全。再試行要 |
| **失敗4: カタログアーカイブ失敗 (Step 4, archived商品のみ)** | archived / **draft** / in_stock | **0 (停止済)** | unarchived (残存) | **無効化済** | 例外エラー (`success: false`) | **非公開 (安全)** | **販売停止 (安全)** | 在庫0かつEC非公開のため実売不可。カタログ表示のみ残存。再試行要 |
| **全ステップ成功** | active (またはarchived) / **draft** / 保持 | **0 (停止済)** | 有効 (archived時はarchived) | **無効化済** | **`success: true, reconciliation_applied: "stop_sales"`** | **非公開 (完全停止)** | **販売停止 (完全停止)** | **回収完了・完全整合状態** |

> [!NOTE]
> 公開ページに販売可能商品として残存する状態のまま `reconciliation_applied: "stop_sales"`（回収成功）が返却されることはありません。必ず Step 1 で BIS が draft 化され、全ステップが完遂した時のみ成功が返却されます。

---

### 6-2. `create_square_payment_link` 失敗時のレスポンスと状態マトリクス

`create_square_payment_link` が失敗した場合、事前検証／Square API呼出中／Square API成功後の本票保存失敗を明確に区別し、外部状態の確認確証レベルに応じて確定値または `"unknown"` が返却されます。Square API呼出の失敗（タイムアウトや5xx等）では、Square側でリンクが作成済みの可能性を考慮し、安易に「リンク未生成（false）」と断定せず `"unknown"` として返却します（明確なHTTP 4xx拒絶のみ `false` と断定）。また、Square側で生成成功した後にBIS本票への保存（`setValues`）が失敗した場合は、`square_payment_link_created: true` と共にリンクID・URLを返し、同一世代の冪等性キーによる安全な再試行を案内します。

| 失敗ケース | Square Catalog | Square 在庫 | pos_sales_enabled | square_inventory | square_catalog_unarchived | square_payment_link_created | rollback_status | 返却 status / メッセージ | 安全評価と対処 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Case 0: 事前検証失敗 (`error_phase: "precondition"`)**<br>(例: draft商品・sold商品・スニーカーサイズ未設定) | 不明 (未確認) | 不明 (未確認) | `"unknown"` | `"unknown"` | `"unknown"` | `false` (API未呼出のため未作成確定) | なし | `payment_link_precondition_failed`<br>「事前検証に失敗したため決済リンク生成を中止しました（Square APIは未実行）」 | Square APIは未実行のためSquare側の状態は変更されない。本票の公開ステータスや必須項目を確認 |
| **Case 1: 通常リンク生成失敗 (Square API タイムアウト/5xx・未確定エラー、rollbackなし)** | 不明 (未確認) | 不明 (未確認) | `"unknown"` | `"unknown"` | `"unknown"` | `"unknown"` (作成済みの可能性あり) | なし | `payment_link_create_failed_unconfirmed`<br>「Square決済リンク生成に失敗しました（Square側でリンクが作成済みの可能性がありますが未紐付けです）。外部の在庫・カタログ状態が未確定のため、reconcile_square_product_status で状態を確認してください。」 | 外部状態不明。Square側でリンクが生成された可能性があるため、照合APIまたはSquare管理画面で確認要 |
| **Case 2: リンク生成拒絶 (Square API HTTP 4xx拒絶、rollbackなし)** | 不明 (未確認) | 不明 (未確認) | `"unknown"` | `"unknown"` | `"unknown"` | `false` (Square側で拒絶・未生成確定) | なし | `payment_link_create_failed_rejected`<br>「Square決済リンク生成に失敗しました（Square側でリンクは拒絶・未生成です）。外部の在庫・カタログ状態が未確定のため、reconcile_square_product_status で状態を確認してください。」 | リンクは未作成確定だが在庫・カタログ状態は未確認。照合APIで確認要 |
| **Case 3: Square API成功後の本票保存失敗 (`error_phase: "sheet_save"`)** | 不明 (未確認) | 不明 (未確認) | `"unknown"` | `"unknown"` | `"unknown"` | **`true` (Square側作成済み確定)** | なし | `payment_link_sheet_save_failed`<br>「Square側で決済リンクは正常に生成されましたが、BIS本票への保存に失敗しました（Square側作成済み・未紐付け状態）。同一世代の冪等性キーで再試行することで安全に本票へ紐付けられます。」 | Square側にリンクが存在するがBIS本票未保存。同一世代キーにより再送することで二重作成なく安全に紐付け修復可能 |
| **Case 4: リンク失敗 + 在庫0巻き戻し成功 (`rollback_on_failure: true`)** | 不明 (未確認) | **0 (安全化)** | `false` | `0` | `"unknown"` | `false` (4xx時) / `"unknown"` (未確定時) | `"success"` | `pending_retry_inventory_reverted_to_zero`<br>「Square決済リンク生成に失敗したため、安全確保のためSquare在庫を0にロールバックしました（再試行待ち）。」 | 店舗POSもECも販売停止。二重販売リスクなし。再試行待ち |
| **Case 5: リンク失敗 + 在庫0巻き戻し失敗 (多重障害)** | 不明 (未確認) | 不明 (未確認) | `"unknown"` | `"unknown"` | `"unknown"` | `false` (4xx時) / `"unknown"` (未確定時) | `"failed"` | `rollback_failed_square_inventory_unknown`<br>「Square決済リンク生成に失敗し、さらにSquare在庫の0ロールバックにも失敗しました。**店頭POSで販売可能な可能性があるため要確認です。**」 | **外部状態不明**。確定値を返さず警告。Square管理画面または照合APIで確認要 |

> [!TIP]
> **同一世代の冪等性キーによる再試行修復**:
> Square決済リンク生成時の冪等性キーは `ais-sq-prod-plink-<productId>-g<generation>` で構成されており、本票の generation カウンタ（AM列）と連動しています。本票への保存が失敗した場合でも generation 番号はインクリメントされないため、同一商品に対して再度 `create_square_payment_link` を実行すると同一の冪等性キーが Square API へ送られます。Square 側の冪等性保証により、Square 側は新規リンクを二重作成せず前回生成済みの同一決済リンク（ID・URL）を返却するため、再試行によって安全に本票への紐付け・整合復旧が完了します。

---

## 7. Readdy 側開発要件（将来のサーバー中継・UI）

### 7-1. Readdy サーバー中継 (Relay / BFF)
- **秘密鍵の保護原則**: Readdy フロントエンド（ブラウザSPA）には `ADMIN_API_KEY` を**絶対に配置してはならない**。
- **サーバープロキシ実装**: Readdy チームは、スタッフのログインセッション / JWT を検証した上で、サーバー環境変数から `ADMIN_API_KEY` を付与して本 GAS API へプロキシするサーバーサイドエンドポイント（例: `POST /api/products/:id/reconcile-square`）を実装すること。
- **中継未配備時の運用**: 当該中継が Readdy 側に配備されるまでは、ブラウザからの照合・回収呼出は行わず、緊急時は認証鍵を持つ管理ツールまたは GAS コンソールから実行すること。

### 7-2. Readdy 画面 警告アラート UI 仕様（中継配備後の設計）
中継経由で `anomaly_detected === true` を受け取った場合、Readdy 画面上に以下を表示する：

1. **公開中断検知 (`MISMATCH_SQUARE_IN_STOCK_BIS_DRAFT`) の場合**:
   - アラートバナー:
     > ⚠️ **【公開中断検知】店頭POSで販売可能な状態です**
     > Squareの在庫が1になっていますが、BIS本票は未公開（draft）です。公開処理の途中で通信が中断した可能性があります。
   - ボタンA: **「公開を完了する」** (`auto_reconcile: "complete_publish"`)
   - ボタンB: **「販売を停止する」** (`auto_reconcile: "stop_sales"`)
2. **外部エラー (`UNKNOWN_EXTERNAL_ERROR`) の場合**:
   - 警告バナー（回収ボタンは非活性化）:
     > ⚠️ **【Square通信エラー】Squareの外部状態を確認できません**
     > Square APIとの通信に失敗したため、店頭販売中かどうかが不明です。安全のため自動回収は禁止されています。Square管理画面またはネットワーク状況をご確認ください。
