# 引き継ぎ (handoff)

最終更新: 2026-11-12 (JST)
セッション開始時は本ファイルと最新の日報 (`docs/worklogs/`) を確認し、作業終了時に両方を更新すること。
Secrets（APIキー、管理キー、JWT秘密鍵、Webhook URL、Web App の完全なURL等）は記載しない。

## 1. 構成

| 要素 | 内容 |
| :--- | :--- |
| GAS プロジェクト | clasp 管理（`.clasp.json`）。アップロード対象は `.claspignore` で GAS 実行コードと `appsscript.json` に限定 |
| `コード.js` | Web App 入口（`doGet` / `doPost`）、商品管理、複数商品・画像インポート（`import_attempts` 冪等性管理・v82本番稼働中）、公開処理、Square 連携（世代別冪等キー、作成後の再取得照合、ロールバック、状態照合・検出・安全回収 `reconcileSquareProductionProductStatus`） |
| `llm_product_draft.js` | AI商品ドラフト（単品生成・確定・公開ゲート・指紋）、AIバッチ生成（受付・取得・再試行・ワーカー `processAiBatchQueue`）、Google Search Grounding 検索付きドラフト生成（本番v92配信済み、2段階方式を標準化、未確認時自動反映緩和、SKU誤読値排除） |
| `llm_translation.js` | 英文翻訳（`product_translations` シート） |
| `pokemon_cards.js` | ポケカ固有属性 |
| `tests.js` | GAS 内テスト `testAiProductDraftSuite_`（20項目）、`testBulkProductArchiveSafetySuite_`（12項目・Live環境Script Properties完全隔離・不変性検証）、`testAiProductDraftIdentityAndPricingSuite_`（24項目・ポケカ/スニーカー同定・PSA鑑定品・価格根拠・表記揺れ・SKU誤読値排除・先行分類経路選択）、各種診断関数 |
| `test_harness_standalone.js` | Node ローカルハーネス（252件PASS、GAS へはアップロードしない） |
| `test_multi_product_import_standalone.js` | 複数商品・画像インポートのローカルハーネス（26件PASS、GAS へはアップロードしない） |
| `docs/diagnostics/diagnose_tmp100_standalone.js` | 検索グラウンディング診断スクリプト（GAS配信対象外） |
| `docs/diagnostics/test_diagnose_tmp100_mock.js` | 診断モックテスト（19シナリオPASS） |
| `docs/MULTI_PRODUCT_IMPORT_API_CONTRACT.md` | 複数商品・画像インポート API 契約書 |
| `docs/SQUARE_SYNC_RECONCILIATION_CONTRACT.md` | Square同期中断・不整合の照合・通知・回収 API契約書 |
| `AI_DRAFT_API_CONTRACT.md` / `AI_BATCH_API_CONTRACT.md` | AIドラフト・バッチ API 契約 |
| `docs/AI_SEARCH_GROUNDING_IMPLEMENTATION_MEMO.md` | 検索付きAI商品情報生成（2段階方式・gemini-3.8-flash 必須化）実装メモ |
| `docs/diagrams/` | 推論パイプライン全体フロー・実測経路ダイアグラム集（HTML/Markdown/MMD、SVG/PNGダウンロード対応） |
| 中継 `gas-ai-batch-relay` | Readdy → 中継 → GAS。中継が管理キーを注入。本番Web App（`AKfycbyxee-…` v92）へ転送 |
| Readdy（フロントエンド） | ブラウザ側で管理（本リポジトリでの git 操作不要） |

主なシート: 本票（先頭シート、44列。AN列 `ai_draft_flag`、AO列 `apparel_fashion_subcategory`、AP列 `apparel_fashion_size`、AQ列 `apparel_fashion_sku`、AR列 `auction_item_number`）、`import_attempts`、`product_ai_drafts`、`product_translations`、`ai_batch_jobs`、`ai_batch_items`。

## 2. 承認済み仕様

### A. 複数商品・画像インポート (v82 本番配信済み・main マージ済み)
- **エンドポイント**: `action: "import_product_by_images"` または `action` 省略＋`import_attempt_id` 付与。
- **下書き固定**: リクエスト内の `publish_status` 指定に関わらず、本ルートで登録された商品は常に `draft` に固定。公開ゲートを迂回しての公開やSquare同期は不可。
- **三重管理・冪等性**: `import_attempts` シート、本票、Driveフォルダ（`ROOT_FOLDER_ID` 内の商品個別フォルダ）の三重照合。
- **指紋照合**: 同一 `import_attempt_id` の再送時は、画像内容SHA-256、順序、商品属性の指紋を照合。一致すれば `is_reused: true` で既存 `product_id` を返却（商品行や画像は重複追加しない）。不一致は `IMPORT_IDEMPOTENCY_PAYLOAD_MISMATCH` で即時拒絶。
- **Fail-Closed 画像検証**: 再送時・回収時に本票行とDrive実在画像ファイルの存在・内容一致を確認。欠損時はエラー（`IMPORT_DRIVE_FOLDER_NOT_FOUND` / `IMPORT_DRIVE_IMAGES_NOT_FOUND`）。同名内容違いは `IMPORT_DRIVE_IMAGE_CONTENT_MISMATCH` で拒絶。
- **画像フォーマット**: Data URI 形式 (`data:image/jpeg;base64,...`) と接頭辞なし Raw Base64 形式の両方に対応。空・不正なBase64は台帳作成前に即時拒絶。
- **後方互換性**: 従来の `action` なし・`import_attempt_id` なしの登録経路（`version: product-create-v2`）の挙動を100%維持。

### B. AIドラフト & バッチ生成 (v92 本番配信済み)
- **自動反映条件の緩和**: `identity_status === "confident"` を本票ドラフト自動反映の必須条件から除外。箱ラベル・サイズ未確認（`candidate` / `ambiguous`）であっても、生成された商品名、説明、カテゴリ、ブランド、正の整数価格案（未入力時）を本票へ安全に自動反映する。
- **要確認項目の保持**: 不明なサイズは空欄のまま保持し、要確認項目（`needs_review`）はドラフトレコード側に保持する。
- **SKU誤読値排除**: `FACING-THE`、`LABEL-SIDE`、`BENEATH-THE` などのプロンプト指示語・構図語句由来の誤読値は、スタイルコードの数字必須検証およびブラックリストにより完全排除（空欄維持）。
- **実行ロックTTL**: 2段階検索グラウンディング通信時間をカバーするため `EXECUTION_TTL_MS` を 240秒（4分）に設定。
- **完全性検証**: バッチワーカーは反映直後の本票を再読取して検証（`verifyProductDraftReflectionCompleted_`）。サイズ未確認をエラーとせず、商品名・価格案が反映された商品を正常に `completed` 判定。
- **公開ゲート保護**: 公開ゲート `assertProductPublishable_` はスニーカーサイズ必須（`SNEAKER_SIZE_REQUIRED`）を堅持。下書き反映のみを許可し、未確認商品の誤公開やSquare登録は物理的に遮断。
- **価格サジェスト**: `candidate.price` は正の整数または null。スタッフ入力済みの価格・サイズは自動反映で上書きしない。
- **バッチ**: 最大20件、`request_id` 冪等、1分トリガー1本、ScriptLock は短時間のみ、リース5分。

### C. 検索グラウンディング改善（PR #5でmain統合・本番Web App v83配信済み）
- **実効設定**: 2026-10-09 20:38 JST に Script Properties を `AI_DRAFT_MODEL=gemini-3.8-flash`、`AI_DRAFT_ENABLE_SEARCH_GROUNDING=true`、`AI_DRAFT_SEARCH_GROUNDING_MODE=two_stage` に設定・確認。HEADの自己修復コードはv83には含まれないが、設定値はv83から動的に参照される。
- **標準経路**: Stage A で画像・ブランド・カテゴリからWeb検索、Stage B で構造化候補。検索クエリ0件、参照元0件、Stage A打切り等では失敗とし、未検索候補を自動反映しない。保存済み候補の中断回収には別途ガードあり。詳細は `AI_BATCH_API_CONTRACT.md`。
- **SKU保護**: 検索で見つかった型番を、現物ラベルで直接確認せずに確定SKUへ代入しない。
- **品質の限界**: グラウンディング達成は画像の商品一致・真正性の保証ではない。スタッフが提案名・価格・サイズ等を確認する。AI精度改善はeBay開発と別課題。

### D. Square 連携
- 世代別 Idempotency Key、作成後の再取得照合、読み取り例外はフェイルクローズ。

### E. 一括アーカイブ・復帰・再連携安全仕様 (`feat/bulk-product-archive` - 配信前保留中)
- **アーカイブ動作**:
  - 順序: (1) Square在庫0化 -> (2) 決済リンク削除 -> (3) Square Catalogアイテムアーカイブ (`is_archived: true`) -> (4) すべて成功後のみ BIS 本票 `record_status`（AH列・34列目）を `"archived"` へ更新。
  - 保持: 本票の `publish_status`（AF列・32列目）および `inventory_status` はアーカイブ前の値を保持。
- **active 復帰時の安全固定**:
  - Square商品は自動でアーカイブ解除しない（アーカイブ状態維持）。
  - Square在庫は自動で1へ戻さない（0のまま維持）。
  - 決済リンクは自動再生成しない（無効のまま維持）。
  - BIS本票の `publish_status`（AF列・32列目）は自動再開せず `"draft"` に安全固定（販売・公開の誤再開を防止）。
  - `inventory_status` は勝手に `"in_stock"` に変更せず、`"sold"` や `"reserved"` 等の既存値を保持。
  - 既に `active` + `published` で販売再開済みの商品へ `active` を再送した場合は、下書き化せず `published` を維持。
- **明示的な再連携フロー (スタッフの明示的操作必須)**:
  - Step 1: `unarchive_square_production_product` (管理者認証必須)
  - Step 2: `syncSquareProductionProductDetails` (商品名・説明・SKU等同期)
  - Step 3: `update_publish_status` (`"published"`, Square在庫1化先行・失敗時draft維持)
  - Step 4: `create_square_payment_link` (オンライン決済URL生成)
- **中断状態の検出と回収 (`reconcileSquareProductionProductStatus`)**:
  - 詳細は [`docs/SQUARE_SYNC_RECONCILIATION_CONTRACT.md`](docs/SQUARE_SYNC_RECONCILIATION_CONTRACT.md) に規定。
  - Square 在庫1かつ BIS 本票が `draft` の中断状態（GAS停止・ネットワーク切断等）を `MISMATCH_SQUARE_IN_STOCK_BIS_DRAFT` として検出。
  - **状態不明時の回収禁止（フェイルクローズ）**: Square Catalog または 在庫の取得に失敗した場合は `UNKNOWN_EXTERNAL_ERROR` とし、外部状態確定前の自動回収（`auto_reconcile`）を例外で厳格禁止。
  - **`complete_publish` 実行の厳格な事前条件**:
    1. `record_status === "active"` (非アクティブ商品の公開禁止)
    2. `inventory_status === "in_stock"` (売却済 sold 等の商品の公開禁止)
    3. `square_variation_id` が存在すること
    4. Square Catalog Item がアーカイブ解除済み (`is_archived === false`) であること
    5. 公開ゲート検証（スニーカーサイズ検証等）を通過すること
    6. 外部通信エラー（`catalog_fetch_error`, `inventory_fetch_error`）が一切ないこと
  - **`stop_sales` 実行の更新順と非公開安全性設計**:
    1. **Step 1 (先行非公開化)**: BIS本票（32列目）の `publish_status` を先行して `"draft"` に更新（EC公開を即時停止）。
    2. **Step 2**: Square 在庫を 0 に同期（店頭POS販売停止）。
    3. **Step 3**: オンライン決済リンクを無効化（AK/AL消去）。
    4. **Step 4**: BISがアーカイブ済みの場合は Square Catalog アイテムをアーカイブ化。
    5. **Step 5**: キャッシュ破棄・更新結果返却。
    - **非公開保証**: 先行して BIS を draft 化するため、後続の Square API が失敗した場合でも公開ページに販売可能商品として残存することを確実に防止。また途中で例外が発生した場合は fail-closed となり、公開ページに販売可能商品として残る状態のまま「回収成功」を返さない。
    - 3ケース網羅検証: (a) 元からdraftの商品、(b) publishedの商品、(c) archivedだがSquare側が稼働している商品のすべてで安全停止を検証。
- **決済リンク失敗セマンティクスの厳格分離と不確定性への対応**:
  - (1) **事前検証エラー (`error_phase: "precondition"`)**: draft商品・sold商品・スニーカーサイズ未設定等の不備時は、Square APIを呼び出さず即座に `status: "payment_link_precondition_failed"`, `square_payment_link_created: false`, `square_inventory: "unknown"`, `pos_sales_enabled: "unknown"` を返却。
  - (2) **Square API 未確定エラー (タイムアウト/5xx等、rollbackなし)**: Square側でリンクや注文が作成された可能性があるため、安易に「リンク未作成（false）」と断定せず `square_payment_link_created: "unknown"`, `status: "payment_link_create_failed_unconfirmed"` を返却。外部の在庫・カタログ状態は未確認のため `pos_sales_enabled: "unknown"` 等を返却。
  - (3) **Square API 明確拒絶エラー (HTTP 4xx等、rollbackなし)**: Square側でリクエストが明確に拒絶された場合に限り `square_payment_link_created: false`, `status: "payment_link_create_failed_rejected"` と断定。
  - (4) **Square API 成功後の本票保存失敗 (`error_phase: "sheet_save"`)**: Square API が成功して決済リンクID・URLを返した後、BIS本票への `setValues` が失敗した場合、`square_payment_link_created: true`, `status: "payment_link_sheet_save_failed"` を返却（リンクID・URLを保持）。事前検証エラーと混同せず「Square側作成済み・未紐付け状態」を正確に報告。
  - (5) **同一世代の冪等性キーによる再試行修復**: 本票 generation カウンタと連動した同一キー（`ais-sq-prod-plink-<productId>-g<generation>`）により再試行されるため、Square側でリンクが二重作成されず既存リンクを安全に取得して本票への紐付け・整合復旧が完了する。
  - (6) **決済リンク失敗 + 在庫巻き戻し成功 (`rollback_on_failure: true`)**: 在庫を安全に0へ巻き戻し `status: "pending_retry_inventory_reverted_to_zero"`, `rollback_status: "success"`, `square_inventory: 0`, `pos_sales_enabled: false` を返却。
  - (7) **決済リンク失敗 + 在庫巻き戻し失敗 (多重障害)**: 確定値を返さず `status: "rollback_failed_square_inventory_unknown"`, `rollback_status: "failed"`, `pos_sales_enabled: "unknown"`, `square_inventory: "unknown"`, `square_catalog_unarchived: "unknown"` とし、「店頭POSで販売可能な可能性があるため要確認です」警告を表示。
- **管理者認証境界の厳格化 (GET / POST 完全一致)**:
  - `GET ?action=reconcile_square_product_status` は `mode=admin` のみでは拒絶され、POST と同様に `verifyAdminAccess_` による `admin_key` 照合が必須（認証なし・`mode=admin` のみ・正しいキーの3ケースを単体テストで網羅検証）。
- **Readdy 管理者認証中継 (Relay) の契約分離と契約書表記の是正**:
  - GAS 新 API（`unarchive_square_production_product`, `reconcile_square_product_status`）のステータスを **「専用ブランチに実装済み・GAS未配信」** に統一。
  - Readdy フロントエンド (SPA) 境界: ブラウザに `ADMIN_API_KEY` を配置することは厳禁。
  - Readdy 側 Relay 契約: Readdy 側でスタッフセッションを検証した上で `ADMIN_API_KEY` を付与して GAS Web App を中継呼出するサーバーサイドエンドポイントの実装が必須（未実装）。
  - 自動監視 runner の不在: 現在のシステムには自動巡回・自動通知 runner は存在せず、障害発生時は管理者が手動で照合APIを実行するか、将来配備される Readdy 中継・UI からトリガーされる（未実装）。

#### F. AIドラフト同定精度・価格根拠・表記揺れ正規化 (`feat/ai-draft-identity-pricing` - PR作成準備中)
- **カテゴリ & ブランドの完全正規化**:
  - `normalizeCategoryValue_`: `sneaker`（kicks, shoes, スニーカー等）、`pokemon_card`（明示的ポケカ表現、および文脈証拠のある汎用TCG表現）、`apparel`（clothing, 服, Tシャツ等）を網羅的に正規化。TCG/card等の単なるカード表現は文脈証拠がない場合は未確定（空文字）としてスタッフ確認を促す。
  - `normalizeBrandValue_`: ポケモンカードカテゴリおよびポケモン関連ブランドを正規値 `"ポケモン"` へ完全統一。主要スニーカーブランド（`NIKE`, `JORDAN`, `adidas`, `New Balance`, `ASICS`, `PUMA`, `CONVERSE`, `VANS`, `SALOMON`, `Reebok`, `YEEZY`）の表記揺れを吸収。
- **ポケカ同定・命名・PSA分離**:
  - 商品名正規テンプレート: `{card_name} {rarity} {card_number} {set_name}`（先頭の冗長な「ポケモンカードゲーム 」等を自動除去）。同定が曖昧（ambiguous）な場合はテンプレート整形を行わず元のタイトルを維持。
  - 鑑定品（PSA/BGS等）: `[PSA10]` 等のグレード表記をタイトル先頭に保持し、通常未鑑定品と明確に区別。`pokemon_cards` シート属性に `grading_status: "graded"`, `grader: "PSA"`, `grade: "10"` を保存。
- **安全ガードと自動反映抑止**:
  - 表面1枚のみ（裏面欠落）での白欠け断定を禁止（サニタイズ・注記付与・`needs_review: ["card_condition"]`）。
  - サーバー側商品同定検査（`verifyProductIdentityOnServer_`）: 型番不鮮明・不一致、レアリティ不一致、PSA品と通常品の混同、別言語版（日本語 vs 英語）の混同、スニーカー推測SKUを客観検知し `identity_status: "ambiguous"` へ降格。
  - 自動反映抑止: `identity_status !== "confident"` または `!price_evidence_verified` の場合は `auto_apply` をスキップし `pending_review` のまま保護（`candidate` も自動反映の対象外）。
  - スタッフ入力済みのブランド、価格、SKU、サイズ、ポケカ属性は自動反映で一切上書きせず保護マージ。
- **サーバー側での成約根拠価格算出 (`calculateServerGroundedPrice_`)**:
  - 個別根拠のURL、取引日（YYYY-MM形式）、通貨（JPY）、商品一致条件（exact_match）をサーバー側で厳格検証（`verifyPriceEvidenceItem_`）。
  - 検証済み成約事例（sold）3件以上で中央値、1〜2件で平均値を採用しポリシー丸め（1万円以上100円、1千円以上50円、1千円未満10円）。
  - 出品中のみは参考価格（`needs_review: ["price"]`）。根拠なし・未検証成約は `price: null`（`price_evidence_verified: false`）。
  - 旧形式推測価格は候補表示用として残すが `needs_review_price: true`, `price_evidence_verified: false` とし本票価格への自動反映を完全遮断。
- **状態・外部連携の次期設計（今回PRからは除外）**:
  - ポケカ状態（新品/A/B/C）と現行BIS（6段階）、Square、eBayのマッピング案を策定。UI変更・DB列追加は次期タスクとして分離。

#### G. 下書き商品の英語タイトル編集および同時送信時の検証順序安全化 (`update_product` translated_title & planned_sale_price対応・本番Web App v95配信済み)
- **エンドポイント**: `doPost` (`action: "update_product"`, `product_id: "...", translated_title: "...", planned_sale_price: ...`)
- **書き込み前の厳格な事前検証 (Pre-Validation)**:
  - いかなるシート書き込み（`product_translations`、本票）やSquare同期処理を行う前に、全入力項目（`translated_title`、`planned_sale_price`、`category`、`pokemon_card` 等）の妥当性を先行検証。
  - 価格が不正（負数、非数値、小数等）な場合は `Error("planned_sale_price must be a positive integer")` で即座に例外停止し、`translated_title` も一切保存されない。
- **下書き限定ガード**: 対象商品の `publish_status === "draft"` の場合のみ英語タイトル編集可能。`published` 等の下書き以外の商品は `TRANSLATED_TITLE_DRAFT_ONLY`（または `PUBLISHED_AI_PRODUCT_EDIT_BLOCKED`）で拒絶。
- **空欄禁止・トリム保存**: 空文字または空白のみは `TRANSLATED_TITLE_REQUIRED` で拒絶。前後の空白は安全に除去（トリム）して保存。
- **既存翻訳データの完全維持**: `product_translations` シートの対象商品を末尾逆順走査で特定し、`translated_title` 列（および `generated_at` 列）のみ上書き。説明文・状態・箱・付属品・承認ステータス（`approved`等）は完全に維持。既存翻訳がない場合は新規レコードを追加。
- **本票・Square同期の非破壊性**: 既存の Square 価格処理（パターンB: 旧Link無効化 -> Square価格更新 -> BIS価格更新 -> 新Link生成）は完全維持。タイトルだけを送った場合に価格や日本語商品名は変わらない。
- **キャッシュ即時クリア**: 詳細API（`GET ?mode=admin&product_id=...`）用のスクリプトキャッシュ `prod_trans_<productId>` を即時破棄し、保存直後の詳細取得や一覧取得（`GET ?mode=admin`）で新タイトルが即座に返る。

## 3. ブランチ・SHA・コードの所在

| 所在 | ブランチ / 版 | 最新SHA / 状態 | 備考 |
| :--- | :--- | :--- | :--- |
| GitHub `origin/main` | `main` | 最新マージ反映 | PR #18〜#22 に加え、Phase 2 Unit 3〜5（在庫/アーカイブ移行・単品AI下書き移行・手動AI一括生成キュー移行）および `feat/test-product-isolation`（テスト商品分離・本番稼働 `00014-v8p`・既存198件の本番23件/テスト175件分類整理）を PR #23 でマージ |
| ローカル (`ais-ec-gas-drive-import`) | `feat/ai-batch-category-cost-expansion` | `main` マージ完了 | 商品別解析用画像指定（`selected_image_ids` 最大3枚）+ 登録全6カテゴリ優先 + 原価最低30%上乗せ（`×1.30`）+ 価格根拠判定厳格化 + アパレルタイトル/説明文フォーマット統一（249/249 PASS） |
| GitHub `origin/fix/update-product-validation-order` | `fix/update-product-validation-order` | 作業ブランチ | 同時送信時の事前検証順序安全化（価格エラー時タイトル不変） |
| ローカル worktree 1 (`/Users/terashimafuga/ais-ec-gas`) | `feat/ai-batch-generation` | (未コミット変更あり) | メイン作業ツリー。未コミット差分あり。触れず保持 |
| ローカル worktree 2 (`/Users/terashimafuga/ais-ec-gas-bulk-archive`) | `feat/bulk-product-archive` | `8cbdc92` (clean) | アーカイブ作業用worktree |
| ローカル worktree 3 (`/Users/terashimafuga/ais-ec-gas-ai-draft`) | `feat/ai-draft-identity-pricing` | `c224242` | PR #10 (レビュー用オープン中) |
| ローカル worktree 4 (`/Users/terashimafuga/ais-ec-gas-ai-fixed-format`) | `feat/ai-draft-fixed-format` | `6c1ae7e` (clean) | PR #11 (手動登録見本形式固定化・Readdy画面出力契約・価格null下書き反映運用) |
| ローカル worktree 5 (`/Users/terashimafuga/ais-ec-gas-ai-real-eval`) | `feat/ai-draft-real-eval` | `754d60f` (clean) | PR #12 (Stage A識別子柔軟抽出・先行分類救済・スニーカー型番候補・参考価格案・状態断定排除) |
| GitHub `origin/feat/product-auction-item-number` (`ais-ec-gas`) | `feat/product-auction-item-number` | `main` マージ完了 | `auction_item_number`（AR列・44列目）対応・本番 Web App **v108** 配信済み、自動照合契約書・検証スクリプト一式（250/250 PASS、25/25 PASS、10/10 PASS） |
| GitHub `origin/feat/supabase-products-master-phase1` (`ais-ec-gas`) | `feat/supabase-products-master-phase1` | `main` マージ完了（コード `7949897`） | 独立 Supabase マイグレーション `000001`〜`000007`、Phase 2 Unit 1〜5 ベースブランチ |
| GitHub `origin/feat/test-product-isolation` (`ais-ec-gas`) | `feat/test-product-isolation` | `main` マージ完了（PR #23） | テスト商品最小分離：マイグレーション `20261109000008_test_product_isolation.sql` 適用済み、Cloud Run `bis-ec-products-api`（`is_test` カラム・一覧SQL除外・`test_only` 一括生成受付前拒否・GAS同期/`reconcile` 保持）、252/252 PASS & 15/15 PASS |
| ローカル / GitHub `feat/nightly-ai-batch` (`ais-ec-gas` & `bis-ec-frontend`) | `feat/nightly-ai-batch` | 本番 Cloud Run **`00017-t95`** 配信・複数デバイス＆重複ガード実機E2E検証完了 | スタッフ手動選択・日時指定予約方式＋全デバイス共通統合一覧＋稼働中商品重複受付ガード（マイグレーション `000009`・`000010` 適用済み、`GET /ai-batch-runs` で即時・予約の両方を一覧取得＆別デバイスでも進捗・商品名・結果表示、予約中・処理待ち・処理中の商品重複を `409 PRODUCT_ALREADY_IN_ACTIVE_AI_BATCH` で受付停止、完了後の意図的再生成 `force_regenerate` 対応）。Cloud Scheduler **`bis-ec-ai-batch-schedule-dispatch`**（`* * * * *` 毎分）稼働中。旧午前2時自動選定経路は `410` 無効化・`bis-ec-ai-batch-nightly` は `PAUSED` 維持 |
| GitHub `origin/main` / `origin/feat/test-product-isolation` (`bis-ec-frontend`) | `main` / `feat/test-product-isolation` | **`e91a4c5`** (`main` 反映・Readdy 実機確認完了) | Readdy `v249`（`d6debc6`）の UI/UX 変更を完全保持した上で、画面共通の「通常モード／テストモード」単一切替（`OperatingModeProvider` + `AdminOperatingModeBar`）、モード別の商品一覧取得・選択クリア、`/import`・`/register` の `is_test` 自動送信（個別チェックボックス撤去）、テスト専用AI一括生成（`test_only: true`）、`/products/:id` 詳細画面でのテスト商品公開・本番Square操作無効化を反映し実機確認完了 |
| 本番 Web App (固定デプロイID) | **v111 (`@111`)** | 本番稼働中・後方互換維持 | `v110` 機能一式に加え、Phase 2 Unit 4 用の内部同期ブリッジ `mirror_ai_product_draft_state`・`get_ai_product_drafts_for_sync` に対応 |
| GAS HEAD | `main` (8ファイル) | push反映済み | v111 反映済み |

## 4. 現在地と検証状況 (2026-10-18)

0. **下書き商品の英語タイトル編集および同時送信時の検証順序安全化 (本番Web App v95配信済み・フロント実機確認完了)**:
   - **目的**: Readdy 管理画面の下書き商品一覧プレビュー画面から「英語タイトル（`translated_title`）」と「販売予定価格（`planned_sale_price`）」を同時または単独でインライン編集・保存する際、価格が不正であればタイトルも変更されないよう事前検証順序を徹底。
   - **バックエンド実装**:
     - フェーズ1（事前検証）: `translated_title`、`planned_sale_price`、`category`、`pokemon_card` の形式・妥当性を先行検証。価格不正時は即座に例外スロー。
     - フェーズ2（書き込み）: 全検証通過後にのみ `updateProductTranslatedTitle_`、Square同期処理、本票セル更新を実行。
     - キャッシュ即時破棄: `CacheService.getScriptCache().remove("prod_trans_" + normId)` で詳細取得キャッシュをクリア。
   - **実機検証（v95 API実測）**:
     - 価格エラー時の同時送信（`TMP-000121`）: `translated_title: "SHOULD_NOT_BE_SAVED"`, `planned_sale_price: -999` 送信時、`planned_sale_price must be a positive integer` で即時停止し、英語タイトルも価格も変更されず元の値を保持（PASS）。
     - 正常な同時更新（`TMP-000121`）: タイトルと価格を同時送信時、一覧API（`GET ?mode=admin`）および詳細API（`GET ?mode=admin&product_id=...`）で両方が即時正しく更新されることを確認（PASS）。
     - 復元検証: 元のタイトル・価格への復元完了（PASS）。
   - **テスト結果**: `node test_harness_standalone.js` で **219/219 PASS (0 failed)**。スイート25 `testUpdateProductTranslatedTitleSuite_` 全7項目PASS。
   - **Readdy側対応・実機確認**: 本番固定Web App（v95）にて、Readdy 管理画面のプレビュー画面から下書き商品の「英語タイトル」および「販売予定価格」のインライン編集・保存・再読み込みが正常に動作することを確認完了。

1. **管理画面商品一覧の英語タイトル優先表示 (本番Web App v93配信済み)**:
   - **目的**: Readdy 管理画面の商品一覧カードの先頭タイトルを「英語優先」に統一。
   - **表示ルール**: 英語タイトル（`translated_title`）があれば先頭表示。未作成・空欄の場合は現在の `product_name` を表示（空欄にはしない）。商品詳細・編集では日本語の商品名を引き続き確認・保持。
   - **バックエンド（GAS）**: 一覧API（`GET ?mode=admin`）において、`product_translations` シートから `product_id -> translated_title` のMapを1回のシート走査で一括構築（N+1問題を完全回避）。従来互換モード（`admin-product-list-v2`）およびページネーションモード（`admin-product-list-v3`）の双方で各商品サマリーオブジェクトに `translated_title` を追加。最新行優先。
   - **フロントエンド（bis-ec-frontend）**: ブランチ `feat/admin-product-list-english-title`（コミット `5fc80f7`）作成・push済み。`AdminProduct` 型に `translated_title?: string;` を追加し、`ProductRow.tsx` で `(product.translated_title && product.translated_title.trim()) || product.product_name || "（商品名なし）"` のフォールバック表示を実装。`sort.ts` に表示名優先ソートヘルパー `getProductDisplayName` を追加。
   - **実機検証（v93 API実測）**:
     - `TMP-000121`: `product_name: "NIKE AIR JORDAN 5 RETRO \"WINGS\" MULTI-COLOR (AV2405-900)"`, `translated_title: "Nike Air Jordan 5 Retro \"Wings\" Multi-Color (AV2405-900)"`
     - `TMP-000122`: `product_name: "トロフィールーム × ナイキ エアジョーダン5 レトロ SP \"アイスブルー\" (CI1899-400)"`, `translated_title: "Trophy Room × Nike Air Jordan 5 Retro SP \"Ice Blue\" (CI1899-400)"`
     - 未翻訳商品（`TMP-000037` 等）: `translated_title: ""`（空文字維持、`product_name` がフォールバック表示）
   - **テスト結果**: `node test_harness_standalone.js` で **218/218 PASS**。`testAdminProductListPaginationSuite_` はテスト8（英語タイトル一括マッピング）を含む全8項目中 **8 PASS**。

2. **AIドラフト自動反映条件の緩和・SKU誤読値排除 (本番Web App v92配信済み)**:
   - 依存関係: PR #10 (`c224242`) → PR #11 (`6c1ae7e`) → 本ブランチ (`feat/ai-draft-real-eval`)。
   - **Stage A 抽出識別子の空欄解消**: `gemini-3.8-flash` が太字マークダウン（`**CARD_NAME**:` 等）で出力していたキーを `extractFlex` で柔軟に吸収し、フォールバックパターンマッチを追加。Stage B プロンプトの直接視認値セクションへ確実に引き渡し。
   - **先行分類一時パースエラー救済**: コードフェンス除去＋正規表現フォールバックを追加。先行分類が一時的な形式エラーで未確定（`category = ""`）でも、後段（Stage A/B）でスニーカーやポケカと特定された場合は `effectiveCategory` として確定し、不要な `needs_review: ["category"]` を除外。
   - **スニーカー型番候補提示 & 出典注記**: 箱ラベル未撮影時でも、検索で特定された Nike 公式型番（`IB4481-500`）をドラフト候補として提示し、`sku_source: "search_corroborated"` を設定。説明文に推定候補である旨の出典注記を付記し、`needs_review: ["sku"]` を付与して写真直接読取と検索確認を区別。検索由来SKUの強制消去ガードを廃止し、スタッフ手入力保護と候補提示を両立。
   - **サイズ未確認時の同一モデル成約参考価格案**: `item_match_condition: "comparable_model"` を許容し、同一モデル成約事例から参考価格案を算出。`priceBasis = "comparable_model_reference"`、`needsReviewPrice = true`、`priceEvidenceVerified = false` として自動確定反映を防ぎつつスタッフへ注記を提示。
   - **ポケカ裏面未撮影時の状態断定排除**: 裏面未撮影時は、LLMが出力した `condition`（「目立った傷や汚れなし」「美品」等）を断定とみなして空欄 `""` にサニタイズし、`card_condition` も空欄化して `needs_review` に `["condition", "card_condition"]` を付与。本票（F列）への誤った断定保存を物理遮断。
   - **報告表現の訂正と未確認事項の撤回**: PR #11 の「実画像で比較」「スタッフ修正80/83%削減」「手動登録画面に完全準拠」「検証済み成約価格」はモック検証（机上想定値）であり、実Gemini生成・実画面でのスタッフ実測ではないことを明記・訂正。TMP-000111/112 の具体名（特にAJ4等の根拠のない推測）や削減率は撤回し「未確認」と訂正。手動登録見本画面（ルギア）はUI項目契約の参考見本であることを明記。
   - **テスト結果**: `node test_harness_standalone.js` で全213項目中 **213 PASS**。GAS内 `testAiProductDraftIdentityAndPricingSuite_` は全20項目中 **20 PASS**。
   - **推論パイプライン・実測経路ダイアグラム集配備 (`docs/diagrams/`)**: 全体フロー、TMP-000113、TMP-000114の実行経路を可視化した HTML（SVG/PNG保存機能付き）・Markdown・MMDファイルを `docs/diagrams/` に配置。

2. **手動登録見本形式・出力契約の固定化 (PR #11 `feat/ai-draft-fixed-format`)**:
   - Readdy手動登録見本画像との1対1対応契約を策定。
   - ポケカブランドを Readdy ドロップダウン選択肢 **`Pokemon Card Game`** に統一。
   - ポケカ商品名フォーマットを **`{card_name} [{set_code} {card_number}] {set_name}`**（鑑定品は `[PSA10]` プレフィックス）に完全固定（レアリティは詳細欄に分離）。
   - `detectCategoryFromCandidateContext_` 新設: カテゴリ未入力時も画像・型番・SKU・サイズから `pokemon_card` / `sneaker` を自律判定。
   - 価格未検証（`price: null`）時でも、`identity_status === "confident"` であれば商品名・ブランド・属性を本票へドラフト反映する運用を確立（本票のH列価格は空欄維持、スタッフが価格だけ手入力して公開できる運用）。
   - 二重状態欄（本票 `condition` vs `pokemon_cards.card_condition`）の整理と A/B/C/D 移行計画を策定。

3. **AI一括生成の精度改善（PR #10 `feat/ai-draft-identity-pricing`）**:
   - サーバー側成約検証、推測価格の自動反映遮断、商品同定客観照合を実装済み。

4. **一括アーカイブ安全化・復帰ガード・照合回収API (PR #8) の本番配信完了 (v84)**:
   - PR #8 は `main` へマージ完了。Web App v84 デプロイ済み。実機検証完了。

5. **検索付きAI一括生成フェーズ**:
   - PR #5 にて main 統合済み。本番稼働中。実機バッチ検証完了。

6. **複数商品・画像取込機能**:
   - PR #4 にて main へマージ済み。v82〜v84 本番で安定稼働中。

## 5. 元の feat/ai-batch-generation 作業ツリーに残る未コミット差分の比較根拠

メイン作業ツリー (`ais-ec-gas`) に未コミット差分があります。不要と判断して破棄する前に、包含関係を個別確認し、触れず保持してください。AIドラフト改善作業・eBay作業・アーカイブ作業は独立したworktreeで進めています。

## 6. 確認済みテスト範囲

- `node test_harness_standalone.js`: **252/252 PASS (0 failed)**
- `node test_multi_product_import_standalone.js`: **26/26 シナリオ PASS**
- `npm --prefix cloud-run/products-api test`: **17/17 スイート PASS**
- `node docs/diagnostics/test_diagnose_tmp100_mock.js`: **19/19 シナリオ PASS**
- `node docs/diagnostics/test_auto_link_item_number.mjs`: **10/10 PASS**

## 7. 既知の問題・課題事項

- **ポケカ状態4段階（新品/A/B/C）UIおよびPSA等級用DB列追加（次期課題）**:
  - 今回のPRでは既存スキーマ・UIを維持し、プロンプト・Schema・正規化・バリデーションに限定。
  - 次期タスクとして、Readdy UIへのポケカ状態4段階セレクタ追加、本票へのPSA等級列追加（または `pokemon_cards` シートとのUIバインド）、Square/eBay連携マッピングの実装が必要。
- **インポート商品完全削除後の同一 `import_attempt_id` 再送問題**:
  - 本票削除と連動した `import_attempts` 台帳ステータス更新、または墓標管理の導入が必要（次期削除機能で対応）。
- **Readdy からの Square アーカイブ解除・状態照合中継の未実装**:
  - Readdy 側に `unarchive_square_production_product` / `reconcile_square_product_status` を安全に呼ぶサーバー側リレー（BFF / Edge Function）が存在しないため、Readdy チームによる実装が必要。

## 8. 次の作業（eBay連携）

**目標**: BISの商品画面で「eBayに出品」を選んだ商品をeBayに出品し、eBayで売れたらBISを完売・Square側を販売不可にする。BIS/Squareで売れたらeBay側の販売も止める。二重販売防止が終了要件。

**手順**
1. `git fetch origin` で最新 `main` を確認し、本ファイル・`docs/worklogs/2026-10-10.md`・既存Squareの同期処理・AI/API契約を読む。新しい `feat/ebay-integration` を `origin/main` から独立したworktreeに作る。旧 `feat/ai-batch-generation` の未コミット差分は保持する。
2. 対象eBayマーケットプレイス、販売アカウントとPayoneer審査の現在状況、出品形態、ポリシーを確認。
3. eBay公式API資料（OAuth、Inventory API、Account API、Fulfillment API等）を調査。
4. 初期実装は読み取り・Sandboxから開始。
5. 本番販売を伴う操作は確認後に進行。APIキーやOAuthトークンはGit・日報・Readdyブラウザへ置かない。


## 10. 商品カテゴリ拡張 (apparel, fashion_goods, jewelry追加候補) (2026-10-22 本番配信完了)

- **ブランチ**: `feat/category-expansion-apparel-fashion-goods` (PR #18・#19 にて `main` へマージ完了: マージコミット `53c1f05` / `7811408`)
- **本番配信状態**: **本番配信完了（v99 デプロイ済み、書類操作2経路復旧、本番商品シート43列用意完了、デプロイID・URL維持、疎通確認完了）**
- **本番 Web App**: 固定デプロイID（Secrets保護のため非記載） @ **99**（現在は `@110` 稼働中）
- **本番商品シート**: `商品マスタ_MVP`（43列、AO〜AQ列追加済み、ヘッダー設定完了）
- **API契約仕様書**: [`CATEGORY_EXPANSION_API_CONTRACT.md`](../CATEGORY_EXPANSION_API_CONTRACT.md) (自己完結版 v1.2)
- **主要仕様・実装内容**:
  - 主カテゴリに `apparel` (アパレル) および `fashion_goods` (ファッション小物) を新設。
  - 既存カテゴリ (`sneaker`, `jewelry`, `pokemon_card`, `other`) を 100% 後方互換で維持。
  - **Chrome Hearts（クロムハーツ）の扱い**: ブランド名 (`brand`) として管理。リング/ネックレス等は `jewelry`、Tシャツ等は `apparel`、アイウェア等は `fashion_goods` に分類。
  - **Google Sheets 本票 (Sheets[0]) の列配置**:
    - 既存 1〜40列 (スニーカー専用 12〜17列、ジュエリー専用 18〜29列、状態・Square・AIフラグ 32〜40列) は一切ずらさず完全維持。
    - 41列目 (AO): `apparel_fashion_subcategory` (サブカテゴリ)
    - 42列目 (AP): `apparel_fashion_size` (サイズ: 文字列)
    - 43列目 (AQ): `apparel_fashion_sku` (公式品番)
  - **列数不足の早期停止ガード (`assertProductSheetColumnCount_`)**:
    - 本票が 43 列未満の場合、画像保存や行作成、セル更新の前に `INSUFFICIENT_SHEET_COLUMNS` 例外で早期停止。動的拡張による中途半端な失敗を物理遮断。
  - **新列書き込み遮断ガード**:
    - 新規登録（`executeProductCreationCore_`）および更新（`handleUpdateProduct`）において、41〜43列への書き込みを `apparel` / `fashion_goods` に厳格限定。スニーカー等の他カテゴリからの書き込みを完全遮断。
  - **AIドラフト反映・確定制御 (`llm_product_draft.js`)**:
    - **[レビュー対応1] 43列未満シートの先行読取防止・部分更新防止**: 確定処理冒頭の読取で既存40列（1〜40列）のみを安全に先行読取。アパレル/小物の場合、書き込み前に物理列数を検査し43列未満なら直ちに `INSUFFICIENT_SHEET_COLUMNS` で停止（43列目までの読取・書込を物理遮断）。43列以上ある場合のみ41〜43列を安全に読取。
    - **[レビュー対応2] 通常既存 other 商品の昇格除外 (Fail-Closed)**: 現行データには手動登録商品とAI先行仮商品を確実に判別する作成元情報が存在しないため、推測による特例昇格は作らず、既存 `other` 商品に対するカテゴリ変更要求は例外なく `CATEGORY_CANNOT_BE_CHANGED` で厳格拒絶（登録後カテゴリ不変原則の堅持）。カテゴリ未設定（空欄）の新規下書き商品のみ初回カテゴリ決定を許可。
    - **スタッフ入力値保護 & 空欄補完**: 確定時およびAI反映時、本票の 42列目（AP: size）および 43列目（AQ: official_sku）に既存値がある場合はAI候補で上書きせず保護。空欄の場合のみ補完。サブカテゴリ（41列）はスタッフ明示指定値のみ保存。
    - 競合検知（`SOURCE_ATTRIBUTE_MODIFIED_BY_OTHER`）との順序調整: 他スタッフによる属性変更（`source_fingerprint` 不一致）を優先検知して Fail-Closed 遮断。
    - 指紋ハッシュ整合: `computeConfirmedProductFingerprint_` および公開ゲート `assertProductPublishable_` の比較対象に 41〜43列を含めて一貫性を担保。
  - **Square連携**:
    - 新カテゴリで `size` が指定されている場合は Square Catalog の Variation 名にサイズを反映、未指定時は `Regular`。
    - 商品説明HTMLに【サイズ】【品番】【ブランド】を自動掲載。Square 実カテゴリ ID は未設定のため推測 ID を入れずカテゴリ未指定を維持。
- **Readdy 向け通信経路整合 (v1.2 仕様書)**:
  - 通常登録・更新・一覧・詳細: ブラウザから直接 GAS Web App へ POST / GET（CORS OPTIONS 回避のため `text/plain;charset=utf-8`、JSON文字列ペイロード）。
  - AIドラフト確定: `ADMIN_API_KEY` を要するため、ブラウザ直接ではなく認証付き中継サーバー `gas-ai-relay`（Bearer JWT 認証）経由で実行。
- **検証状態**:
  - `test_harness_standalone.js`: **全 246/246 PASS (0 failed)** (Section 32: 24 アサーションを含む、範囲外アクセス例外スローシートでの読取順序検証済み)。
  - `tests.js`: GAS内テストスイート `testCategoryExpansionSuite_` (GAS 実環境にて **全17/17項目 PASS**)。
  - `test_multi_product_import_standalone.js`: **全 24/24 シナリオ PASS**。
  - 本番 Web App (v98) 読み取り疎通確認完了（公開一覧47件、管理一覧83件・新属性キー空文字返却、新カテゴリ絞り込み count:0、公開詳細、管理詳細・既存SKU正常保持・新属性キー返却）。
- **Readdy への引き渡し手順**:
  - `CATEGORY_EXPANSION_API_CONTRACT.md`（自己完結版 v1.2）を Readdy 担当者へ共有。
  - フロントエンドはまだ未Publish。
  - 受入確認時は、登録画面の「公開」および「Square連携」チェックを必ず両方オフにして下書き登録（1件）で検証する。

## 11. AI一括生成の商品別解析用画像指定 (`selected_image_ids` 最大3枚) (2026-10-26 本番v100配信・実機検証完了)

- **ブランチ**: `feat/ai-batch-selected-images` (`origin/main` = `86eeac8` / 本番 v99 ベース)
- **変更ファイル**: `コード.js`, `llm_product_draft.js`, `tests.js`, `test_harness_standalone.js`, `AI_BATCH_API_CONTRACT.md`
- **主要仕様・実装内容**:
  - **商品ごとの解析用画像選択の保存・取得（販売用メイン画像・並び順は不変）**:
    - シート `product_ai_image_selections`（`product_id`, `selected_image_ids`, `updated_at`）に商品別の選択 Drive ファイル ID 配列（最大3件）を保存。本票 `AE` 列や Drive 上の `01_main_...` 等の並び順・メイン画像は一切変更しない。
    - 保存経路: `POST action: "save_product_ai_selected_images"`（単独保存）、`POST action: "update_product_images"`（画像編集と同時保存、新規 `client_id` も自動解決）、`POST action: "update_product"`（商品更新と同時保存、Phase 1 事前検証対応）。
    - 取得経路: `GET ?mode=admin&product_id=...`、`GET ?mode=admin`、`GET/POST action: "get_product_ai_selected_images"` で `selected_image_ids`（および `ai_selected_image_ids`）を返却。
  - **AI一括生成での引き継ぎ・ワーカー受け渡し・再試行維持**:
    - `create_ai_product_draft_batch` 受付時に、リクエスト明示指定（`selected_image_ids_by_product` / `items[].selected_image_ids`）または `product_ai_image_selections` の保存済み選択を引き継ぎ、`ai_batch_items` の16列目（P列 `selected_image_ids`）へ保存。
    - ワーカー `processAiBatchQueue` が `selected_image_ids` を `executeSingleAiProductDraftCore_` → `getValidatedProductDriveImages_` へ渡して推論実行。未選択（`[]`）の商品は従来どおり先頭最大3枚を使用。
    - `retry_ai_product_draft_batch` 再試行時もそのバッチで指定された `selected_image_ids` を保持して再実行。
  - **厳格検証と削除済み画像の明示エラー返却**:
    - 3枚超は `IMAGE_COUNT_EXCEEDED`、重複IDは `DUPLICATE_SELECTED_IMAGE_ID`、対象商品のDriveフォルダ外IDや非配列は `INVALID_IMAGE_SELECTION` で拒絶。
    - 選択後に画像がゴミ箱移動またはフォルダから削除された場合は `SELECTED_IMAGE_DELETED` と理由メッセージを返し、別画像へ黙って差し替えない。
- **検証状態**:
  - `node test_harness_standalone.js`: **全 248/248 PASS (0 failed)**（Suite 28 `testAiBatchSelectedImagesSuite_` 全10/10項目 PASS）。
  - `node test_multi_product_import_standalone.js`: **全 24/24 PASS (0 failed)**。

## 12. AI一括生成の拡張（登録済み全カテゴリ優先対応・概算原価への最低30％上乗せ価格提案・価格根拠判定厳格化・アパレル書式統一）(2026-10-29 本番v106配信完了)

- **ブランチ**: `feat/ai-batch-category-cost-expansion`（本番 `v100` ベース）
- **変更ファイル**: `llm_product_draft.js`, `コード.js`, `tests.js`, `test_harness_standalone.js`, `AI_BATCH_API_CONTRACT.md`（およびフロントエンド側リポジトリ `supabase/functions/gas-ai-batch-relay/index.ts`）
- **本番 Web App**: 固定デプロイ ID @ **106**
- **主要仕様・実装内容**:
  - **登録済みカテゴリ最優先での全6カテゴリ対応 (`sneaker`, `pokemon_card`, `apparel`, `fashion_goods`, `jewelry`, `other`)**:
    - 商品シート `C` 列に登録済みカテゴリがある場合は先行分類・Stage A・Stage B・サニタイズで登録済みカテゴリを最優先し、非スニーカー商品にスニーカー系ブランドが登録されていても誤ってカテゴリ矛盾にしない。
    - 本票自動反映・スタッフ編集検知・反映完了判定を43列対応に統一し、`apparel` / `fashion_goods` のサイズ・品番を `AP` 列（42列目 `size`）・`AQ` 列（43列目 `official_sku`）へ反映（`L`・`M` 列は `sneaker` 専用を維持）。
  - **照合済み商品の概算原価への最低30％上乗せ（`min_cost_markup_rate = 0.30`, `×1.30`）による価格提案反映**:
    - `documents-relay`（`get_product_cost`）の `links[].line`（`item_amount`, `fee_amount`, `tax_amount`, `fee_tax_amount`, `total_line_amount`）と同一基準で概算原価を集計（`total_line_amount` に手数料・税額が含まれるため二重加算しない）。
    - **v104 修正**: 明細の税額が確認済み（`isPurchaseLineTaxComplete_ === true`）であるにもかかわらず `document_product_links.allocated_amount` に税抜合計（`item_amount + fee_amount`）等が保存されている場合、確認済み税額を除外せず税込総額（`total_line_amount = 商品代金 + 落札手数料 + 確認済み税額`）を有効原価（`effective_cost_amount`）に採用。複数商品への部分割当は `allocated_amount` を維持し、税額未確認の明細に対して GAS 側で税額を推測補完することは行わない。
    - 原価上乗せ下限価格 `P_floor = ceilPriceByPolicy_(概算原価 × (1 + min_cost_markup_rate))`（既定 `min_cost_markup_rate = 0.30`、すなわち `概算原価 × 1.30` を価格単位で切り上げ）とWeb相場価格 `P_market` を比較し、`max(P_market, P_floor)` を提案価格に採用。
    - 既存の `min_gross_margin_rate`（粗利率）と混同しないよう、API項目名（`min_cost_markup_rate` / `cost_markup_multiplier` / `pricing_rule: "cost_markup_floor"`）、`price_basis: "cost_markup_floor"`、`price_note`（「最低30%上乗せ（×1.30）」「原価比+○○%」）に統一。
    - 原価未照合時および税額未確定時（`all_tax_confirmed === false`）は `price_note` に概算である旨と「最終判断はスタッフが行います」を明記。
  - **v105 修正（価格根拠判定の厳格化・未特定アパレル無根拠相場抑止・価格メモ表現是正）**:
    - サイト内検索結果一覧URL（`/search?keyword=...`, `/s?query=...`, `/sch/...` 等）を `isSearchResultListingUrl_` で検出し、`verifyPriceEvidenceItem_`・`calculateServerGroundedPrice_`・Stage A 価格復元のすべてで確認済み根拠として採用しない（`/item/...`, `/products/...`, `/jp/auction/...`, `/itm/...` 等の個別商品ページは保護）。
    - ブランド・型番を特定できず有効な個別価格根拠も残らないアパレル相当商品（`isUnidentifiedApparelEquivalent_`、`category: "other"` の衣類を含む）では、`comparable_model`・未検証URL平均・根拠のないAI概算（`unverified_estimate`）を「Web相場」として採用せず、原価照合済みなら30％上乗せ下限を「相場未確認の価格案」として提示し、原価未照合なら `price: null`（価格未設定）でスタッフ判断に委ねる。
    - `price_note` で「検索で取得した」「個別取引および成約内容を確認済み（`is_content_verified: true` のみ）」「成約価格である／成約価格とは確定していない」を厳密に区別し、URL形式通過のみの根拠を `"形式確認済"` と表現しない。
  - **v106 修正（アパレル向け商品タイトル・商品説明フォーマット生成指示の最小限統一）**:
    - 価格計算・価格根拠判定・画像選択・カテゴリ分類・出力スキーマには触れず、`buildAiDraftSystemInstruction_`・`callGeminiSingleRequestSearchGrounding_`・`callGeminiTwoStageSearchGrounding_`（Stage A / Stage B）のアパレル生成指示のみを統一（`category: "other"` や未確定時の衣類にも適用）。
    - **タイトル**: 原則英語で確認済みの「ブランド・コラボ名・モデルまたは品目・色・サイズ」を簡潔に記載（未確認ブランド・モデルの推測補完禁止、英語のみで分かりにくい場合のみ `title_ja` に日本語併記、`Chrome Hearts` の自動決めつけ・紙製クリーニングタグ誤認を明示禁止）。
    - **商品説明順序**: (1) ブランド・モデルと概要 → (2) 写真で確認できるデザイン特徴 → (3) 実物の状態・使用感（未撮影箇所の断定禁止） → (4) 確認できた項目のみの `【サイズ】`/`【素材】`/`【原産国】`/`【付属品】`（未確認見出しは省略、実寸は実測値がある場合のみ） → (5) 必要な注意事項＋`hashtags_ja` への関連ハッシュタグ少数出力（情報不足でも生成失敗にしない）。
  - **画像3枚選択（`v100` 既存実装）の維持**:
    - `v100` の `save_product_ai_selected_images`・`product_ai_image_selections`・`ai_batch_items` 16列目（`selected_image_ids`）をそのまま再利用。
- **検証状態**:
  - `node test_harness_standalone.js`: **全 249/249 PASS (0 failed)**（Suite 28 `testAiBatchSelectedImagesSuite_` 10/10 PASS、Suite 29 `testAiBatchCategoryAndCostExpansionSuite_` **9/9 PASS**、アパレル生成指示検証＋情報十分な例／前面1枚・タグ未確認の例の2例書式検証を含む）。
  - `node test_multi_product_import_standalone.js`: **全 24/24 PASS (0 failed)**。
  - 本番 Web App (**v106**) デプロイ・実URL単体テスト（`run_ai_batch_category_cost_tests` **9/9 PASS**）確認完了。実商品での強制再生成・販売予定価格変更は既存データ保護のため **未実施**。
- **残るアパレルAI生成精度の次期改善課題（今回スコープ外）**:
  1. カテゴリ未設定商品の先行分類（`classifyCategoryPriorFromImages_`）が `"pokemon_card" | "sneaker" | "other"` の3択のみで衣類を `"other"` に分類するため、未設定インポート時に `apparel` 経路・`AP`/`AQ` 列に乗らない。
  2. `parseStageASections_` が `observedFields.inner_tag_size` / `box_label_sku` をスニーカー専用の `normalizeSneakerSize_` / `normalizeSneakerSku_` で上書きするため、Stage B プロンプトへアパレルサイズ（`S/M/L/XL` 等）が `(none/unconfirmed)` として渡る。
  3. アパレル同定には首元ブランドタグ・内側品質表示タグ（会社名・品番・素材・サイズ）の画像入力と、クリーニング紙タグ等の除外指示が必要。

## 13. 仕入台帳のオークション等の商品番号 (`auction_item_number`) の任意保存対応 (2026-10-29 本番v108配信完了)

- **ブランチ**: `feat/product-auction-item-number`（`origin/main` = `cf51c31` / PR #21 マージ後ベース）
- **変更ファイル**: `コード.js`, `tests.js`, `test_harness_standalone.js`, `test_multi_product_import_standalone.js`
- **本番 Web App**: 固定デプロイ ID @ **108**
- **主要仕様・実装内容**:
  - **専用列 `AR` 列（44列目、ヘッダー `auction_item_number`）の追加**:
    - 既存1〜43列（`official_sku` `AQ` 列、商品ID `B` 列、備考 `K` 列等）へは流用せず、44列目（`AR` 列）を新設しプレーンテキスト書式 `"@"` を適用（先頭ゼロ `"00123"`・ハイフン `"00842-33225"` / `"-01-12"`・空欄 `""` を文字列のまま保持）。
  - **単一API項目名 `auction_item_number` に統一**:
    - 作成API（`import_product_by_images` / `create_product`）: 省略時は `""` で保存。
    - 更新API（`update_product`）: キー省略または `undefined` 時は既存値を維持し、明示的な `""`（または `null`）送信時のみクリア。
    - 管理向け詳細・一覧取得API（`GET ?mode=admin&product_id=...` / `GET ?mode=admin`）で `auction_item_number` を文字列として返却（公開ストアフロント向け詳細には非露出）。
    - 重複による登録・更新拒否なし、仕入明細との自動照合なし、既存商品・既存カテゴリの値は不変。
- **検証状態**:
  - `node test_harness_standalone.js`: **250/250 PASS (0 failed)**（Suite 30 `testAuctionItemNumberContractSuite_` **8/8 PASS**）。
  - `node test_multi_product_import_standalone.js`: **25/25 PASS (0 failed)**（Test 25 追加）。
  - 本番 Web App (**v108**) デプロイ、`setup_product_sheet_columns` 実行（`43 -> 44` 列）、GAS実環境 `run_auction_item_number_tests` **8/8 PASS**、既存商品読取り不変確認完了。
- **完了状態（2026-11-02）**:
  - GAS `v108` 配信、`documents-relay`（`auto_link_product_by_item_number`）本番配信・実URL競合保護確認（`verify_live_auto_link_url.mjs` PASS）、Readdy `Code` タブ同期（`bis-ec-frontend` `main` `20b1635` Pull）、フロント実機確認、`ais-ec-gas` `main` マージまで完了。

## 14. `auction_item_number` 自動検索・自動紐付けバックエンド (`documents-relay` `auto_link_product_by_item_number`) (2026-11-02 本番配信・Codeタブ同期・フロント実機確認完了)

- **対象ファイル（フロントエンドリポジトリ側 Edge Function）**: `supabase/functions/documents-relay/index.ts`（3,024行 / `107,292` bytes / SHA-256 `ead8da5a8441db3f4e0ad8f10ed17f0343346a418e63f947681bdb727129f710`）
- **リモート反映**: `Fuga420/bis-ec-frontend` `main`（コミット `20b1635`、およびブランチ `feat/documents-relay-auto-link-item-number` `e8da290`）
- **配信ステータス**: **本番配信済み・Readdy `Code` タブ同期済み・フロント実機確認完了**（実URLにて `TMP-000161` × `"842-33225"` で HTTP `200` `conflict_existing_link` 返却および `TMP-000134` 確定リンク不変を確認済み）。
- **稼働中コード比較と純粋追加ベース**:
  - 稼働中の `documents-relay` を確認した結果、未マージブランチの `c61f9f4`（blob `74623d6`）ではなく、`origin/main` の最新 Readdy エクスポート **`eb74432`（v177、blob `c0062a0`、1,745行）** と一致していたことを確認（`TMP-000134` 手動紐付け時に書類 `bf7272b8-...` の `status` が `"partially_matched"` に更新された実データ挙動および Readdy v177 `mapMatchStatus` との整合で確認）。
  - そのため、`eb74432`（`c0062a0`）の既存1,745行を1行も変更・削除せず（`-0` 行）、`auto_link_product_by_item_number` のみを純粋追加（`+1,279` 行）した `documents-relay/index.ts` と `readdy-patches/14_documents-relay_auto_link_item_number.patch` に差し替え済み。
- **API契約書**: [`docs/AUTO_LINK_AUCTION_ITEM_NUMBER_API_CONTRACT.md`](AUTO_LINK_AUCTION_ITEM_NUMBER_API_CONTRACT.md)
- **主要仕様**:
  - 台帳の受付番号（`reception_number_raw`）と商品番号（`auction_bid_number`）を混同せず完全一致検索（先頭ゼロ・ハイフン保持、両列別行ヒット時は `AMBIGUOUS_NUMBER_TYPE` で保留）。
  - 一意候補かつ既存確定リンク競合なしの場合のみ `primary_cost` 確定リンクを作成。同一要求の再送は `is_reused: true`（`already_linked_same_product`）で二重作成しない。
  - 割当額 `allocated_amount` は `商品代金 + 落札手数料 + 確認済み税額`（`total_line_amount` 設定行では税込行合計）を採用し、税抜額のみによる税込総額との不一致を防止。
  - 0件・複数件・既存リンク競合（例: `842-33225` は `TMP-000159` 解除済み・`TMP-000134` 有効確定リンク中のため `TMP-000161` は `LINE_ALREADY_LINKED_TO_OTHER_PRODUCT` 競合）・エラー時は書込を行わず理由と確認情報を返却し、商品登録・更新の成功は取り消さない。
- **検証状態**:
  - `node docs/diagnostics/test_auto_link_item_number.mjs`: **10/10 PASS**（モック8件＋実データ読取専用検証2件、実DB書込ゼロ、`TMP-000134` リンク不変確認済み）。


## 15. 商品マスターDBの独立Supabase移行・Cloud Run 商品読取API実装（Phase 1 + レビュー修正反映）(2026-11-02 本番稼働・実画面確認完了)

- **管理リポジトリ（Supabase GitHub連携指定先）**: `Fuga420/ais-ec-gas`（リポジトリ直下に `supabase/` があるため、Supabase GitHub連携の **Working directory は `.`** を指定する。`cloud-run/products-api/` に Cloud Run API、`scripts/` に冪等コピー・照合・スタッフ管理スクリプトを配置。`.claspignore` により GAS へのアップロード対象は既存の 8 ファイルのみに厳格制限）
- **移行先 Supabase プロジェクト**: `wzhgewtkosgxwomlkvmg`（東京リージョン `ap-northeast-1` / PostgreSQL 17）。仕入書類DBは当面 Readdy 内蔵DBに残し、商品マスターおよび管理画面スタッフ認証を独立プロジェクトで管理。
- **Cloud Run サービス**: `bis-ec-products-api`（リビジョン `00005-wpv`、GCP `bis-square-integration-507508` / `asia-northeast1` 東京リージョン、Node.js 22、秘密鍵は GCP Secret Manager `SUPABASE_SERVICE_ROLE_KEY`・`PRODUCTS_API_INTERNAL_SECRET` から注入）
- **公開範囲・現行GASとの比較（個別ログインなし・ブラウザ秘密鍵埋め込みなし）**:
  - 複数スタッフの同時作業および Muse AI のブラウザ操作をログイン画面で止めない方針により、フロントエンドの `StaffAuthGate` / Supabase Auth ログインは除外済み。
  - **`GET ?mode=admin`（一覧・詳細）**: 現行 GAS Web App（`doGet ?mode=admin`）と同く認証なしで取得可能（仕入価格 `purchase_price`・下書き商品・Square ID・`auction_item_number` 等を含む管理用レスポンスを返す点も現行GASと同一。AI内部フラグ `ai_draft_flag` や `latest_ai_draft` は非公開）。
  - **`POST /sync/:productId`**: ブラウザから書込直後に認証なしで呼び出し可能。ただしリクエストボディから任意の値を書き込むことは一切できず、必ずサーバー側で正本（GAS / Google Sheets）を再読取して Supabase に反映する（`?allow_delete=1` も GAS 側で `"product not found"` が確認された場合のみ削除する）ため、外部から正本にないデータの改ざんや生存中商品の削除は不可。
  - **`POST /reconcile`**: Cloud Scheduler 専用のサーバー間トークン（`X-Internal-Sync-Token` = Secret Manager `PRODUCTS_API_INTERNAL_SECRET`）が必須であり、外部からは実行不可（`401`）。
  - **公開EC向け `GET /?category=...`・`GET /?product_id=...`（`mode=admin` なし）**: 認証不要で `published + in_stock + active` のみ返却（仕入価格や管理項目は非公開）。
- **テーブル構成**:
  - `public.products`（現行 Google Sheets 44列 + 行順保持 `row_seq` + `main_image_display_url` + `translated_title` + `selected_image_ids` + `pg_trgm` GIN インデックス付き生成列 `search_text`）
  - `public.product_images`（Drive 画像メタデータ・表示順保持。画像実体は Google Drive に維持）
  - `public.product_translations`、`public.pokemon_cards`、`public.product_documents`
  - `public.product_sync_runs`（Cloud Scheduler 5分周期の差分同期実行履歴）
  - `public.staff_users`（**現在未使用**：マイグレーション履歴の整合性維持のため空テーブル・RLS有効のまま残置。`scripts/manage_staff_user.mjs` も現在未使用）
- **全件コピー・全項目照合結果**:
  - ダミー・アーカイブ済みを含む現行 **全153件**（`active: 114` / `archived: 39`、`published: 68` / `draft: 85`、Square連携済 `68` 件、画像 `715` 行、翻訳 `50` 件、ポケカ属性 `6` 件、添付書類 `1` 件）を冪等コピー。
  - `node scripts/verify_products_migration.mjs` により、`シート1` 全44列のうち GAS `doGet` が返却する **全42列**＋補助3項目（計6,885セル）および子テーブル全4種（画像715行・翻訳50件・ポケカ6件・書類1件）の全フィールドで **不一致 `0` 件**・並び順不一致 `0` 件を確認。
  - **未検証範囲（GAS内部専用2列）**: `AM`列（39列目 `square_payment_link_generation`）および `AN`列（40列目 `ai_draft_flag`）は `admin_key` なし `doGet` で非公開のため照合対象外（現在も Google Sheets / GAS 側が書込・決済・AI処理の正本として直接参照）。
- **現在の切替範囲・正本維持と同期補完**:
  - **Cloud Run + Supabase へ切替済み（読取系 GET）**: 商品一覧（通常・アーカイブ・公開カテゴリ）・キーワード検索・絞り込み・並び替え・商品詳細・仕入書類画面の商品ID検索（GAS の約 2.6〜4.5秒から **約 104〜158 ms** へ高速化）。
  - **Google Sheets / GAS に保持中（書込系 POST・定期処理の正本）**: 商品新規登録・画像一括取込・商品編集・画像Drive保存/並び替え・公開/在庫/アーカイブ/完全削除・Square連携・Square決済後の `sold` 反映・AI単品/一括ドラフト生成・英語翻訳生成/承認。
  - **二重の同期保証**:
    1. フロントエンド書込直後の `syncProductToReadDb()` が HTTP ステータスおよび応答 JSON（`success: true, synced: true`）を検証し、万一失敗した場合は警告表示＋未同期マークにより次回読取を正本（GAS）へ自動切替して古い表示を防止。
    2. GCP Cloud Scheduler `bis-ec-products-reconcile`（`*/5 * * * *`、5分周期）が `POST /reconcile?rolling=10` を実行し、画面を閉じている間の GAS 定期処理による変更（`sold` 反映・AI一括生成・削除・詳細変更）も自動で差分照合・再同期（GAS異常時は Fail-Closed）。


## 16. Phase 2（第1単位）：Square連携を伴わない「下書き商品の新規登録・編集」の Cloud Run + Supabase 書込移行 (2026-11-02 本番稼働・実データ検証完了)

- **マイグレーション**:
  - `supabase/migrations/20261102000003_phase2_draft_write_support.sql`（独立Supabase `wzhgewtkosgxwomlkvmg` 適用済み）: `public.products` に `write_source`（`'sheets' | 'supabase'`）、`supabase_written_at`、`sheets_mirror_pending` を追加。原子的商品ID採番 RPC `public.allocate_next_product_id(min_floor)`、`public.allocate_next_product_row_seq()`、リクエスト冪等管理テーブル `public.product_write_idempotency`（RLS有効）を追加。
  - `supabase/migrations/20261102000004_idempotency_recovery_state.sql`（適用済み）: `product_write_idempotency` に進行状態（`status`: `'in_progress' | 'mirror_completed' | 'completed'`、`mirror_json`、`updated_at`）を追加し、GAS保存成功後のSupabase書込失敗時に同一 `client_request_id` 再送で同じ `TMP-XXXXXX` を二重作成なく回復・返却。
- **Cloud Run / GAS バージョン・書込制御**:
  - Cloud Run `bis-ec-products-api`: リビジョン **`00007-h7g`**（メモリ `512Mi`、タイムアウト `300s`、`POST /products`・`POST /products/:productId/update`・`PATCH /products/:productId`・`POST /`）。
  - **書込APIの最小限アクセス制御**: 書込ルートは URL 単体や無資格リクエストを `401` で即時拒否。個別スタッフアカウントやブラウザへの固定秘密鍵埋め込みは行わず、既存の Readdy Backend 接続資格情報（`src/lib/supabaseClient.ts`、サーバー側で `READDY_BACKEND_URL/auth/v1/settings` へ照合・短時間キャッシュ）またはサーバー間 `X-Internal-Sync-Token` のみを許可。
  - GAS 本番固定 Web App: **`@109`（v109）**（個人マイドライブ `ROOT_FOLDER_ID` 配下への画像配置＋下流互換行追記 `mirror_created_draft_product` 追加。`node test_harness_standalone.js` **251/251 PASS**）。
- **書込正本と二重正本回避の境界**:
  - **Cloud Run + Supabase へ移行済みの書込操作（Supabase が書込正本）**:
    1. 商品登録画面（`/register`）での **非公開（下書き・Square連携OFF）の新規登録**（`POST /products`）および仮下書き更新（`POST /products/:id/update`）。
    2. 商品詳細画面（`/products/:id`）での **Square未連携・下書き商品の「商品情報を編集」保存**（`POST /products/:id/update`）。
    3. 商品一覧画面（`/products`）での **Square未連携・下書き商品のインライン編集保存**（`POST /products/:id/update`）。
  - **引き続き GAS に残る書込操作**:
    - 公開状態での新規登録・Square本番連携（Item/画像/在庫/決済リンク生成）、公開済み商品またはSquare連携履歴あり商品の編集（パターンB価格同期）、公開/在庫/アーカイブ状態変更・商品削除、`/import` 複数画像一括取込、画像単体の追加/並替/削除、書類添付、AI単品/一括ドラフト生成・確定、英語翻訳生成/承認。
  - **整合維持設計**: Cloud Run での下書き書込は Supabase を先行確定した上で GAS/Sheets へ同期ミラーし（AI確定済み商品の `confirmed_fingerprint` も維持）、一時障害時は `sheets_mirror_pending = true` により `reconciler.mjs` が古い Sheets で上書きせず Supabase → Sheets へ自動再送する。
- **実データE2E検証**: ダミー商品 **`TMP-000164`** にて `/register` 下書き登録 → `/products` 一覧先頭表示 → `/products/TMP-000164` 詳細確認・詳細編集（`00999-02` 等） → `/products` インライン編集 → `POST /reconcile` 差異 `0` 件（全154件一致）まで確認完了。
- **次の切替手順（Phase 2 次単位以降）**:
  1. 非Squareの状態変更（アーカイブ・在庫変更・完全削除）の Cloud Run + Supabase 化
  2. Square 連携（Catalog / Inventory / Payment Link / 決済後 `sold` ポーリングまたは Webhook）の Cloud Run 移行
  3. AI 単品・一括ドラフト生成ワーカーおよび英語翻訳の Cloud Run + Supabase 化 → 完了後に Google Sheets 下流互換ミラーと `POST /reconcile` を廃止し Supabase 単独運用へ完了


## 17. Phase 2（第2単位）：商品画像の取込・追加・並べ替え・削除の Cloud Run + Supabase 移行 (2026-11-02 本番稼働・実画面確認完了)

- **マイグレーション**:
  - `supabase/migrations/20261102000005_phase2_image_import_and_edit.sql`（独立Supabase `wzhgewtkosgxwomlkvmg` 適用済み）:
    - 複数画像取込の冪等台帳 `public.product_import_attempts`（RLS有効、`attempt_id`、SHA-256 `payload_fingerprint`、`status`: `'initiated' | 'drive_saved' | 'completed' | 'failed'`、予約 `product_id`、回復用 `mirror_json` / `response_json`）を追加。
    - `public.allocate_next_product_id(min_floor)` を更新し、`product_import_attempts` の予約済み連番も上限考慮。
    - 画像一覧・メイン画像・選択画像IDを1トランザクションで原子的に置換する `public.replace_product_images_atomic(...)` RPC を追加。
- **Cloud Run / GAS バージョン**:
  - Cloud Run `bis-ec-products-api`: リビジョン **`00008-bwh`**（`POST /products/import` および `POST|PUT|PATCH /products/:productId/images` を追加、既存の Readdy Backend 資格情報検証 `verifyWriteAccess` で保護）。
  - GAS 本番固定 Web App: **`@110`（v110）**（`import_product_by_images` での `reserved_product_id` 受付・`images[]` メタデータ返却、`update_product_images` の data URI 対応。`node test_multi_product_import_standalone.js` **26/26 PASS**、`node test_harness_standalone.js` **251/251 PASS**）。
- **変更したフロントエンド接続先（`Fuga420/bis-ec-frontend` `main` コミット `fafa3e5`：Readdy `v217` `482bb94` の上に競合ゼロで統合済み）**:
  - `/import` 複数画像取込（`src/pages/import/lib/multiImport.ts`）: GAS 直結 → Cloud Run `POST /products/import`
  - `/products/:id` 詳細画面「画像を編集」（並替・メイン変更・追加・削除、`src/pages/products/detail/page.tsx`）: GAS 直結 → Cloud Run `POST /products/:productId/images`
  - `/register` 単品AI生成用の仮下書き作成・画像差替（`src/pages/register/lib/aiProduct.ts`）: GAS 直結 → Cloud Run `POST /products`・`POST /products/:productId/images`
- **残る GAS / Google Sheets 依存（明示）**:
  1. **Google Drive 実ファイル操作ブリッジ**: 画像ファイルの保存先は従来どおり個人マイドライブ `ROOT_FOLDER_ID/<product_id>/`（`01_main_...`, `02_...`）を維持しているため、Cloud Run サーバー内部から GAS（`@110`）を呼び出して Drive フォルダ/ファイル作成・リネーム・削除画像のゴミ箱移動を実行。
  2. **未移行機能向けの下流シート互換同期**: 未移行の AI 単品/一括生成（`generate_ai_product_draft` / `processAiBatchQueue`）および Square 公開・画像同期（`create_square_production_product` / `sync_square_production_image`）が参照する `シート1`（`AD` `drive_folder_url`、`AE` `main_image_url`、`AR` `auction_item_number`）および `product_ai_drafts` の `confirmed_fingerprint` 無効化を引き続き GAS 側で同期維持。
  3. **ブラウザから引き続き GAS / 既存 Edge Function を呼ぶ未移行操作**: 公開状態での登録・Square公開/価格/画像/在庫/決済リンク連携、公開済み・Square連携済み商品の属性編集、公開/在庫/アーカイブ状態変更・完全削除、AI単品/一括生成・確定、`save_product_ai_selected_images` 単体保存、英語翻訳生成/承認。
- **実画面E2E検証**: ダミー商品 **`TMP-000166`** にて `/import` 3枚取込（同一 `import_attempt_id` 再送 `is_reused: true`・順序改変 `IMPORT_IDEMPOTENCY_PAYLOAD_MISMATCH` 確認）→ `/products` 一覧・`/products/TMP-000166` 詳細表示 → 並べ替え（2枚目→メイン変更）→ 追加（+1枚）・削除（-1枚）→ `POST /reconcile` 差異 `0` 件（全156件完全一致）を確認完了。
- **仕入台帳の商品番号（`auction_item_number`）自動仕入照合フラグ有効化・実画面通信確認（`Fuga420/bis-ec-frontend` `main` コミット `6f058dc`：Readdy `v219` `564e07c` の上に統合・公開反映済み）**:
  - `src/pages/documents/lib/productAutoLink.ts` の `AUTO_LINK_BY_ITEM_NUMBER_ENABLED` を `true` に有効化（Readdy `v219` `564e07c` までのUI変更・Phase 2第2単位を完全保持）。
  - 既存 `TMP-000168`（`459-1`）での単発自動照合、新規ダミー取込 `TMP-000169`（`808-22822` → `¥198,000`、確認後 `archived` 化）での保存・自動照合・一覧「照合済み」・詳細原価反映を確認。
  - さらに公開実画面（`/import`）からの Headless Chrome 実通信確認を実施し、CORS Preflight（`200`）・`POST .../functions/v1/documents-relay`（`200`）・完了カードへの結果メッセージ描画まで一気通貫で稼働していることを確認済み（`TMP-000170` の `459-1` は既存リンク競合保護 `conflict_existing_link`、`TMP-000171` の `200-5` は複数候補保留 `multiple_candidates`、`TMP-000172` の `845-34227` は該当計算書未取込による一致0件 `no_match` とすべて仕様どおり動作）。


## 18. Phase 2（第3単位）：Square未連携の下書き商品の在庫状態変更・アーカイブ・復元・一括アーカイブの Cloud Run + Supabase 移行 (2026-11-03 本番稼働・E2E検証完了)

- **Cloud Run バージョン**: `bis-ec-products-api` リビジョン **`00009-8hs`**（GAS は既存の固定デプロイ `@110` のまま変更・再デプロイなし、新規 SQL マイグレーション不要）。
- **対象商品の厳格判定（フロントエンド & Cloud Run 双方で強制）**:
  - `publish_status === "draft"` かつ `square_item_id`, `square_variation_id`, `square_payment_link_id`, `square_checkout_url` の4項目すべてが空文字の商品のみ Cloud Run + Supabase 正本で処理。
  - 公開中商品や Square 連携済み商品は Cloud Run 側でも `409`（`NON_DRAFT_PRODUCT` / `SQUARE_LINKED_PRODUCT`）で Fail-Closed 拒否し、従来どおり GAS 経路を維持。
- **移行した操作と仕様維持**:
  1. 商品詳細画面での **在庫状態変更**（`POST /products/:productId/inventory-status`: `in_stock` / `reserved` / `sold`）
  2. 商品詳細画面での **単品アーカイブ・復元**（`POST /products/:productId/record-status`: `active` ↔ `archived`。復元時は `publish_status` を `"draft"` に固定し、既存の `inventory_status`（`sold` / `reserved` 等）は変更せず保持）
  3. 商品一覧画面での **一括アーカイブ**（`useBulkArchive.ts`: Square未連携の下書き商品は Cloud Run、公開中・Square連携済み商品は GAS へ振り分け。通信断時の `要確認分を再確認` は書込正本側を直接確認し、`失敗のみ再試行` は成功分を再送せず失敗分のみ同一経路で再試行）
  - **Sheets 互換ミラーと巻き戻り防止**: Supabase 先行確定後に GAS（`update_inventory_status` / `update_record_status`）へ同期ミラーし、GAS 一時障害時は `sheets_mirror_pending = true` により 5分周期 `reconciler.mjs`（`flushPendingSupabaseDraftToSheets`）が古い Sheets 値で上書きせず差分を再送。
- **フロントエンド反映**: `Fuga420/bis-ec-frontend` `main` コミット **`572245c`**（Readdy `v225` `90fb24e` を保持統合）。
- **完全削除（`delete_product`）を次単位以降へ移行するための前提条件（今回未移行）**:
  1. Drive 画像フォルダ（`AD`列）のゴミ箱移動および失敗時ロールバックを担うブリッジ権限設計。
  2. Readdy 内蔵 Supabase `document_product_links` の有効リンク残存時の扱い（削除ブロックか、`documents-relay` 連動での論理削除＋`document_lines.match_status`/書類ステータス再計算か）の仕様確定。
  3. `product_import_attempts` 等の冪等履歴と、`reconciler.mjs` が互換ミラー期間中に Sheets 残存行から削除済み商品を復活させない削除同期の担保（Square連携済みアーカイブ商品の削除は Square リソース削除を伴うため GAS 維持）。

## 19. Phase 2（第4単位・完了）：単品AI下書き生成・保存・確定・解析画像選択の Cloud Run + 独立Supabase 移行 (2026-11-05 本番配信・初期同期・フロント切替・実画面E2E検証完了)

- **完了済み項目**:
  1. **独立Supabaseマイグレーション適用済み**: `supabase/migrations/20261103000006_phase2_ai_product_drafts.sql`（`public.product_ai_drafts`、`public.ai_draft_execution_locks`、ロック制御 RPC 3種、原子的ドラフト保存 RPC `save_generated_ai_draft_atomic` を `wzhgewtkosgxwomlkvmg` 本番へ反映済み）。
  2. **GAS 下流互換ミラー・同期ブリッジ本番配信済み (`@111`)**: `mirror_ai_product_draft_state` および `get_ai_product_drafts_for_sync` を固定 Web App **`@111`** へデプロイ済み（`252/252 PASS`）。
  3. **Cloud Run 本番配信完了 (`bis-ec-products-api-00011-j59` / コード `c353013`)**:
     - GCP Secret Manager の `GEMINI_API_KEY` を参照追加し、既存の全環境変数・シークレット（`SUPABASE_URL`, `GAS_WEB_APP_URL`, `READDY_BACKEND_URL`, `SUPABASE_SERVICE_ROLE_KEY:latest`, `PRODUCTS_API_INTERNAL_SECRET:latest`）を維持したまま配信。
     - `aiDraftService.mjs` の PostgreSQL RPC フラット引数（31引数）・`search_queries TEXT[]`・GAS `@111` トップレベル `translation` / `pokemon_card` ミラー整合を修正・検証済み（`11/11 PASS`）。
  4. **既存 AI ドラフト・`ai_draft_flag` 初期同期・照合完了**:
     - 生存商品 163件中 `ai_draft_flag = 'ai_managed'` **47件**・最新 AI ドラフト **45件**（削除済み旧商品 `TMP-000119` 履歴1件を除く全件）を独立 Supabase へ同期し、`flagMismatchCount: 0`・`draftMismatchCount: 0` を確認済み。
  5. **フロントエンド 4 関数接続切替・Readdy `v233` 統合・実画面通し E2E 検証完了 (`bis-ec-frontend` `main`: `efe3d3e`)**:
     - `src/config/productsApi.ts`・`src/pages/register/lib/aiProduct.ts`（`generateAiProductDraft`, `confirmAiProductDraft`, `getAiProductDraft`）・`src/pages/products/lib/aiBatch.ts`（`saveProductAiSelectedImages`）のみを切替し、直後に反映された Readdy `v233`（`425a0f9`、全10ファイル UI/UX 調整）の上に統合済み（公開処理・Square連携・一括AI生成 `gas-ai-batch-relay` は不変）。
     - ダミー商品 `TMP-000179` にて「解析画像選択 → AI生成（未公開・`pending_review` 維持確認）→ 内容確認・編集 → 確定保存 → 詳細画面再読込・詳細画面からの画像選択保存 → Supabase / Sheets / GAS 指紋整合 → `POST /reconcile` 後の巻き戻りゼロ → ダミー商品アーカイブ整理」を通し確認済み。

## 20. Phase 2（第5単位・完了）：手動AI一括生成の Cloud Run + 独立Supabase キュー移行 (2026-11-05 本番配信・フロント切替・実画面E2E検証完了)

- **完了済み項目**:
  1. **独立Supabaseキュー基盤適用済み**: `supabase/migrations/20261105000007_phase2_ai_batch_queue.sql`（`public.ai_batch_jobs`、`public.ai_batch_items`、RLS `service_role` 限定、原子的キュー制御 RPC 6種を `wzhgewtkosgxwomlkvmg` 本番へ反映済み）。
  2. **20件上限撤廃・同時実行数制御・夜間実行共用可能キュー (`bis-ec-products-api-00013-dwf` / コード `7f7eb9e`)**:
     - 手動一括受付の上限を旧20件から最大 **500件**（`POST /ai-batches`）へ拡張し、商品ごとの処理を永続キューへ登録。
     - 環境変数 `AI_BATCH_CONCURRENCY=2` によるクラスター横断の同時実行数制御、HTTP `429` サーキットブレーカー＋バックオフ自動再試行、`SELF_API_URL` アクティブ HTTP 自己チェイン（`cpuIdle: true` 対応）、`request_id` 冪等重複防止、失敗商品のみの再実行（`POST /ai-batches/:batchId/retry`、成功済み商品は再生成しない）、確定仕入原価解決の Fail-Closed 保護（`PRODUCT_COST_FETCH_FAILED`）を実装。
     - 成功商品は `auto_apply: true`（`confirmed_by: "ai_batch_worker"`）として下書き商品（`products`・`product_translations`・`pokemon_cards`・`product_ai_drafts`）および Google Sheets / GAS（`@111` `mirror_ai_product_draft_state`）へ自動確定反映し、公開（`publish_status: "draft"` 維持）・Square連携は一切行わない。
     - 夜間定期実行はまだ実装せず、後から同じ `ai_batch_jobs`（`job_source = 'scheduled_nightly'`）および `POST /ai-batches/worker/run` をそのまま利用できる構成に統一。
  3. **フロントエンド切替・Readdy `v243` 統合・実画面通しE2E検証完了 (`bis-ec-frontend` `main`: `794f676`)**:
     - 既存の `AiBatchConfirmModal`・`AiBatchResultModal`・`useAiBatchGeneration`・`ImportBatchSection` を活かし、`gas-ai-batch-relay` から Cloud Run `/ai-batches*` へ切替（`/products` のページ跨ぎ選択保持および `/import` の20件分割解消・上乗せ率指定連携を含む）した上で、直後の Readdy `v243`（`be7a22a`、全29ファイル UI/UX 調整）へ競合ゼロで再統合済み。
     - 実機・実画面にて 22件（20件超）受付＆`request_id` 重複防止、50件選択確認、ダミー商品 `TMP-000181`・`TMP-000182` での一部失敗→画像追加→「失敗のみ再実行」（`TMP-000181` 再生成なし・`TMP-000182` のみ完了・完了後 `NO_FAILED_ITEMS`）、Supabase / Sheets / GAS 3者指紋整合、`POST /reconcile?rolling=5`（`upserted_count: 0`）後の巻き戻りゼロ、ダミー商品アーカイブ整理まで確認済み。

## 21. テスト商品の最小分離（夜間AI一括生成の前段保護・2026-11-09 本番稼働・実画面E2E検証完了）

- **目的**: 開発テストで実商品を誤って一括生成の対象にしないため、夜間AI一括生成へ進む前にテスト商品を最小構成で分離。
- **実装・配信済み項目**:
  1. **独立Supabase (`20261109000008_test_product_isolation.sql` 適用済み)**:
     - `public.products` に `is_test BOOLEAN NOT NULL DEFAULT false` を追加（既存全実商品は `false`、商品ID採番は従来の `TMP-XXXXXX` のまま不変）。
     - `public.ai_batch_jobs` に `test_only BOOLEAN NOT NULL DEFAULT false` を追加し、`enqueue_ai_batch_job_atomic`（10引数版）で DB トランザクション内でも `NON_TEST_PRODUCT_INCLUDED` を検証。
  2. **Cloud Run (`bis-ec-products-api-00014-v8p` 本番稼働中)**:
     - `GET /?mode=admin` は既定で SQL クエリ取得段階から `is_test = false` のみを取得（`count`・`total_pages`・全選択対象が一致）。`is_test=true` 指定時のみテスト商品一覧を返し、公開EC向けエンドポイントからは `is_test = true` を完全除外。
     - `POST /products`・`POST /products/import` で任意の `is_test: boolean` を保存。
     - `POST /ai-batches` で `test_only: true` 指定時は、キュー登録・仕入原価照合・LLM呼出の **前** に対象ID全件が `is_test = true` か確認し、実商品IDや未登録IDが1件でも混じれば HTTP `400` / `NON_TEST_PRODUCT_INCLUDED`（`non_test_product_ids` 付き）で即時拒否。通常のスタッフ向け一括生成は従来どおり利用可能。
     - `POST /sync/:id` および 5分周期 `POST /reconcile` で `existing.is_test` を保持し、GAS シートに `is_test` 列が無くても消えないよう保護。
  3. **フロントエンド (`Fuga420/bis-ec-frontend`: `e91a4c5`、`feat/test-product-isolation` & `main`、Readdy `v249` `d6debc6` 完全保持)**:
     - 画面共通の単一「通常モード／テストモード」切替（`OperatingModeProvider` + `AdminOperatingModeBar`、初期値 `normal`、`sessionStorage` で画面移動・タブ内再読込も維持）を実装し、各画面の個別チェックボックス（「テスト商品を表示」「テスト商品として取り込む」「テスト商品として登録」）は撤去。
     - `/products` は通常モードで実商品のみ（`is_test=false`）、テストモードでテスト商品のみ（`is_test=true`）を取得・表示し、件数・ページ分割・一括選択を一致させ、モード切替時に選択状態をクリア。テストモードの一括AI生成は `test_only: true` を送信し、一括公開ボタンを非表示化。
     - `/import`・`/register` は現在モードに応じて `is_test: true / false` を自動送信（テストモード時の `/register` は公開・Square連携チェックを強制OFF＆無効化）。
     - `/products/:id` 商品詳細では `product.is_test === true` の商品に対し、公開状態変更（`SalesManagementPanel`）および本番Square反映・決済リンク生成（`SquareIntegrationSection`）を画面・ハンドラ双方で無効化。
  4. **残る制約（仕様上の境界）**:
     - Google Sheets（`シート1`）自体には `is_test` 列を持たず独立 Supabase `public.products.is_test` を正本としているため、画面を介さず GAS 側の従来公開・Square Webhook API を直接呼び出した場合は GAS 単体では `is_test` を判定しない（画面上は `/register`・`/products` 一括公開・`/products/:id` 公開状態および Square 本番反映ボタンのすべてで無効化済み）。
     - モード状態はタブ単位（`sessionStorage`）で保持し、新しいタブ／新しいブラウザセッションを開いた際は安全側（初期値「通常モード」）で開始する。また、モード切替中に実行済みのAI一括生成ジョブがバックグラウンド継続している場合は、そのジョブ起動時点の `test_only` 条件が Cloud Run 側で維持される。
     - 夜間定期AI一括生成ジョブ（`job_source = 'scheduled_nightly'`）を次単位で実装する際は、本番対象抽出クエリに必ず `WHERE is_test = false`（テスト実行時は `is_test = true` かつ `test_only = true`）を含めること。
  5. **実機E2E検証（新規テスト商品 `TMP-000207`, `TMP-000208`, `TMP-000209` のみ使用・実商品不使用）**:
     - 通常モード初期表示（実商品のみ `105件`）・選択クリア、モード維持での画面移動（`/products` → `/register` → `/import`）、テストモードでの画像取込 `TMP-000209`（`is_test: true` 自動送信）、テストモード一覧表示（`3件`）、`[TMP-000207, TMP-000176]` 混入時の受付前拒否（`400 NON_TEST_PRODUCT_INCLUDED`・実商品不変）、テスト専用一括生成（`BATCH_1794187913242_951348`・`BATCH_1794194159521_fb664f`）の完了、`/products/TMP-000209` 詳細画面での公開・Square本番反映ボタン無効化、`POST /sync/:id`・`POST /reconcile?rolling=5` 後の `is_test: true` 保持を確認済み。

## 22. 次回セッションの開始確認と次の作業候補

1. **フロントエンド・バックエンド同期状況**:
   - `Fuga420/ais-ec-gas` および `Fuga420/bis-ec-frontend` の **`feat/nightly-ai-batch`** ブランチに「スタッフ手動選択・日時指定予約方式」＋「即時・予約の全デバイス共通一覧・進捗・結果表示」＋「予約中・処理待ち・処理中の重複商品受付ブロック（失敗再実行時のDB原子的排他制御を含む、完了後の再生成は許容）」＋「200件予約起動時のウォームアップ・一時エラー再試行・90秒時間予算制御」を実装し、両リポジトリとも `origin/feat/nightly-ai-batch` へ Push 済み（`bis-ec-frontend` は Readdy 最新 `v263` `d674010` の上に統合した `a40da66`、Cloud Run は `bis-ec-products-api-00018-rvv` 本番稼働中、Supabase は `20261109000009`・`20261109000010`・`20261109000011`・`20261109000012` 適用済み）。マージ承認後に `main` マージ・Readdy Pull を行う（次回フロント作業時は先に `git fetch origin` で Readdy 側の新規コミット有無を確認すること）。
2. **今後の移行・検討候補（未着手・スコープ分離済み）**:
   - **完全削除（`delete_product`）の移行**: セクション18 / 2026-11-03 日報で整理した Google Drive ゴミ箱移動ブリッジ・仕入書類リンク（`document_product_links`）整合・Square未連携境界を満たした上での移行。
   - **公開処理・Square連携の移行（後続フェーズ）**: 現在は従来どおり GAS（`@111`）を正本として稼働中。
3. **既知の運用メモ**:
   - `/import` 完了カードに表示された自動照合結果（一致0件・複数候補・競合等の警告）は、`/products/:id` 詳細画面へ遷移した後の初期表示には引き継がれない（「仕入・書類」0件のみ表示される）ため、必要に応じて詳細画面側でも未紐付け理由の案内を出すかは今後のUI検討事項。
   - `TMP-000172`（`auction_item_number: "845-34227"`）は該当するオークネット計算書PDFが `/documents` に取り込まれた後に手動または再照合で紐付け可能。

## 23. 既存商品198件の本番／テスト識別整理（2026-11-09）

- 利用者指定の本番商品は `TMP-` 6桁ゼロ埋めで末尾 `174, 171, 161, 157, 154, 153, 151, 150, 149, 148, 147, 146, 145, 144, 143, 142, 141, 140, 139, 138, 137, 136, 135` の23件。その他の現存175件をテスト商品とする。
- 独立Supabase `public.products.is_test` のみ更新。既にテストだった3件を除く172件を `true` に変更した。更新後は本番23件／テスト175件で、Cloud Run管理用一覧の件数も一致。公開状態、アーカイブ状態、Square連携項目は変更なし。
- 分類変更前から、テストと指定された商品に公開状態69件、保存済みSquare購入URL41件が存在。BISの公開APIではテスト商品を除外するが、既存のSquareリンクは停止していない。必要なSquare側の整理は別途検討する。

## 24. AI一括生成の日時指定予約方式・全デバイス共通進捗/結果表示・稼働中商品重複ブロック（2026-11-09）

- **ブランチ**: `ais-ec-gas-drive-import` および `bis-ec-frontend` の **`feat/nightly-ai-batch`**（Readdy `v263` `d674010` のUI変更を100%保持した `a40da66`）。
- **旧「午前2時自動選定」経路の廃止**:
  - 前回の `POST /ai-batches/nightly/run` は HTTP `410 AUTO_NIGHTLY_SELECTION_DISABLED` で無効化し、自動候補選定コードを削除。Cloud Scheduler `bis-ec-ai-batch-nightly` は `PAUSED` のまま有効化しない。
- **デプロイ先**:
  - 独立 Supabase（`wzhgewtkosgxwomlkvmg`）: マイグレーション `supabase/migrations/20261109000009_ai_batch_schedules.sql`、`20261109000010_ai_batch_unified_runs_and_overlap_guard.sql`、`20261109000011_ai_batch_retry_atomic_overlap_guard.sql`、および `20261109000012_fix_retry_conflict_check_jsonb.sql` 適用済み（`public.ai_batch_schedules` `force_regenerate` 対応、統合検索インデックス、原子的排他ロック付き重複検査関数 `find_active_ai_batch_product_conflicts`＋新規受付/予約/失敗再実行 RPC 群）。
  - Cloud Run `bis-ec-products-api`（`asia-northeast1`）: リビジョン **`bis-ec-products-api-00018-rvv`**（100% トラフィック、Secret Manager `READDY_BACKEND_ANON_KEY` マウント済み）。
  - Cloud Scheduler **`bis-ec-ai-batch-schedule-dispatch`**（`asia-northeast1`、スケジュール `* * * * *` / `Asia/Tokyo` 毎分、`POST /ai-batch-schedules/dispatch`、ボディ `{"max_schedules":5}`、ヘッダー `X-Internal-Sync-Token`、`attemptDeadline: 180s`、状態 `ENABLED`。明示予約された `scheduled_at <= now()` の行のみを起動し、未予約時は何も処理しない）。
- **主な仕様・安全境界**:
  1. **手動選択IDの固定予約と200〜500件対応**:
     - 商品一覧（`/products`）の「一括AI生成」確認ダイアログ（`AiBatchConfirmModal.tsx`）に「**今すぐ実行**／**日時を指定して予約**」を追加。日本時間（JST）で開始日時と選択済み `product_id` 一覧を確認して予約（最大500件、予約受付時は外部 `documents-relay` 通信待ちを行わず高速保存）。開始時刻に商品の自動検索・追加・差替は一切行わない。
  2. **通常／テストモードの混入防止と実行前状態変化の除外記録**:
     - 予約時・実行時の両方で `is_test` 一致を検証（`NON_TEST_PRODUCT_INCLUDED` / `TEST_PRODUCT_INCLUDED`）。
     - 実行開始前に公開済み・アーカイブ済み・Square連携済み・画像0枚・選択画像削除・未存在になった商品は理由とともに `excluded_items_json` へ記録して除外し、代替商品は自動選定しない。
  3. **二重起動防止・開始前取消・ワーカー継続**:
     - `request_id` 一意制約と `claim_due_ai_batch_schedules` のリース制御により二重起動・重複キュー作成を防止。開始前（`scheduled` / `dispatch_retry`）は `POST /ai-batch-schedules/:id/cancel` で取消可能（開始後は `409 SCHEDULE_ALREADY_STARTED`）。未完了アイテム残存時は毎分のディスパッチが既存ワーカー（`POST /ai-batches/worker/run`）も継続起動する。
  4. **実行時の確定仕入原価取得（Fail-Closed）・200件予約の180秒期限内起動対策・下書き保存**:
     - 実行開始時にサーバー間で `${READDY_BACKEND_URL}/functions/v1/documents-relay`（`action: "get_product_cost"`）から確定原価を取得。取得失敗時は「原価なし」に置き換えず `dispatch_retry` で再試行待ちとし、生成を進めない。
     - 200件予約の起動時間実測はコールドスタート時 **`55.68秒`**・ウォーム時 **`16.19秒`**（Cloud Scheduler 期限 `180秒` 以内）。さらに ①単発タイムアウト `15秒`＋一時エラー最大3回リトライ、②20件以上での先行1件ウォームアップ＋並列度12取得、③1ループ1予約ずつの claim と `90秒` 時間予算（複数200件予約が同時刻に重なっても次分へ安全に分割）を実装済み。
     - 生成結果は従来どおり下書き保存（`publish_status = 'draft'`）までとし、自動公開・Square連携は行わない。
  5. **全デバイス共通の即時実行・予約一覧取得と進捗／結果表示（`GET /ai-batch-runs`）**:
     - 単独即時実行（`ai_batch_jobs`）と日時予約（`ai_batch_schedules`、予約由来 `batch_id` の重複除外済み）をサーバー側で統合取得し、`GET /ai-batches/:id`・`GET /ai-batch-schedules/:id` でもサーバー側で商品名を補完して返却。`localStorage` が空の別デバイス・スマートフォンでも稼働中進捗・完了結果・統合履歴（`[即時]` / `[予約]`）を確認・切替・予約取消できる。
  6. **予約中・処理待ち・処理中の商品重複ブロック（新規受付・予約・失敗再実行すべてでDB原子的排他）と完了後の再生成許容**:
     - 予約中（`scheduled` / `starting` / `dispatch_retry`）・処理待ち（`pending`）・処理中（`processing`）の商品を別ジョブ（`POST /ai-batches` / `POST /ai-batch-schedules` / `POST /ai-batches/:batchId/retry`）に入れようとした場合、アプリケーション層および DB トランザクション助言ロック（`pg_advisory_xact_lock(hashtext('ai_batch_active_products_guard'))` + `find_active_ai_batch_product_conflicts`）の双方で HTTP `409 PRODUCT_ALREADY_IN_ACTIVE_AI_BATCH`（`conflicting_product_ids` 付き）を返し受付前に停止する。
     - 同一 `request_id` の再送（`is_reused: true`）、失敗商品のみの再実行（成功分は対象外）、完了・失敗・取消後の意図的な再生成（`force_regenerate: true`）を維持。
- **実機・自動テスト確認結果（テスト商品のみ使用・実商品23件不変）**:
  - 自動テスト: Cloud Run `18/18 PASS`（失敗再実行と新規即時/予約の同時競合テスト、200件予約のウォームアップ・一時503再試行・時間予算分割テストを含む）、GAS `252/252 PASS`、フロントエンド本番ビルド成功。
  - 実機検証: 日時指定予約の自律起動・除外記録（`SCHED_1794201329288_650fb9` → `BATCH_1794201426283_b7af7f`）および複数ブラウザプロファイル（`Device A` / `Device B` / 新規 `Device C`）での重複 `409` 拒否・別デバイス予約取消・完了商品の意図的再生成・ライブ進捗追従・商品名補完付き結果表示を確認済み。実商品23件は前後とも完全不変。

## 25. AI一括生成の要件改訂対応（原価取得非ブロッキング化・売価未設定時の下書き保存・真贋文言自動除去・アパレル/靴の状態基準見直し・最低粗利率30%下限）（2026-11-12）

- **ブランチ & デプロイ状況**:
  - バックエンド (`ais-ec-gas-drive-import`): **`main`** マージ済み（旧作業ブランチ: `feat/ai-batch-resilient-cost-and-draft`）
  - フロントエンド (`bis-ec-frontend`): **`main`** マージ済み（旧作業ブランチ: `feat/ai-batch-resilient-cost-and-draft`、Readdy 最新 `v273` `9231c34` のUI変更を100%保持統合）
  - Cloud Run `bis-ec-products-api`（`asia-northeast1`）: リビジョン **`bis-ec-products-api-00019-7wb`**（100% トラフィック配信・実機確認済み）
- **主な改訂内容（As-Is → To-Be）**:
  1. **原価取得の非ブロッキング化（日時予約・今すぐ実行・失敗分再実行・単品生成共通）**:
     - 原価取得（`documents-relay` `get_product_cost`）を生成の補助情報として扱い、1件のタイムアウトや取得先全体の一時障害があっても予約・即時実行・再実行全体を止めず、取得できなかった商品自身も除外・代替せず生成対象に含める。
     - 内部的に `confirmed`（確定原価 > 0）、`no_cost`（照合成功・原価なし、直引きポケカ等）、`lookup_failed`（通信エラー・タイムアウト）を区別し、未取得や原価なしを架空の `0` 円原価や推測値で補わない。
     - 単発タイムアウト `8秒`（一時エラー最大2回試行）・バッチ時間予算 `25秒`・連続12件失敗サーキットブレーカーにより応答待ちで予約を長時間停滞させず、未取得の事実と対象 `product_id` 一覧を `product_costs_json`・`cost_fetch_failed_product_ids` / `cost_fetch_failed_count` に記録。
  2. **売価案と下書き保存・スタッフ入力保護（販売価格に対する最低粗利率30%下限）**:
     - 確定原価（`> 0`）がある場合のみ価格下限（`ceilPriceByPolicy_(cost / (1 - minGrossMarginRate))`、既定30%＝`原価 ÷ (1 − 0.30)` を価格単位で切り上げ。例：原価11,500円なら下限16,500円）を適用し、`no_cost` / `lookup_failed` 時は下限を計算せず市場情報から売価案を作成する。画面表示・価格根拠（`price_note`）・保存データ（`pricing_rule: "gross_margin_floor"`）を「最低粗利率30%」に統一。
     - 売価案を作れない場合（`candidate.price === null`）でも `MISSING_PROPOSED_PRICE` で失敗にせず、生成できた商品名・説明文・翻訳・属性を下書きに保存し、売価は未設定のままスタッフ確認待ちとする（スタッフが価格を入力するまで公開ゲート `SALE_PRICE_REQUIRED_FOR_PUBLISH` で公開不可）。スタッフ入力済みの売価・属性は上書きしない。
  3. **真贋に関する文章と禁止ワードの自動除去（正式商品名の保持）**:
     - 「本物保証」「真贋鑑定済み」「確実正規品」「100% authentic」「guaranteed authentic」「100% original」等の保証・鑑定主張のみを自動除去し、単独の `Authentic` 等を含む正式な商品名・型名・ブランド名（`Vans Authentic 44 DX` 等）・カード収録弾・PSAグレード（`[PSA10]` 等）はAI生成時・スタッフ下書き確定時の双方でそのまま保持する。
  4. **アパレル・靴の状態（`condition`）基準**:
     - クリーニング後の見た目を前提とし、明らかな傷・目立つ汚れ・破損がない限り軽微な使用感で減点せず標準候補を **`目立った傷や汚れなし`** とする（明確な根拠なく `新品・未使用` にはしない）。明らかな破損・目立つ汚れは状態に反映する。
     - 「クリーニング済み」等の定型文は自動記載せず、出力された場合も自動除去する。スタッフ入力済みの `condition` は上書きしない。ポケモンカードの収録弾・グレード・カード状態ルールは維持。
- **テスト結果**:
  - Cloud Run 自動テスト (`npm --prefix cloud-run/products-api test`): **19/19 PASS**（受入条件 1〜7 + `Vans Authentic 44 DX` 回帰 + 原価11,500円→下限16,500円検証を含む）
  - GAS ローカル単体テスト (`node test_harness_standalone.js`): **258/258 PASS**
  - フロントエンド本番ビルド (`npm --prefix c:\Users\aij\Documents\bis-ec-frontend run build`): **成功**

