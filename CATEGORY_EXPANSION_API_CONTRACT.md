# B.I.S EC 商品カテゴリ拡張 API契約仕様書 (自己完結版 v1.2)

**対象リポジトリ**: `ais-ec-gas` (GAS Web App)  
**対象読者**: Readdy (フロントエンド / UI開発担当)  
**ステータス**: **【未デプロイ / 開発中仕様】** (ブランチ `feat/category-expansion-apparel-fashion-goods` 上で実装・テスト完了。GAS本番環境へは未デプロイ)  
**更新日**: 2026-10-22  

---

> [!IMPORTANT]
> **【重要】本実装は未デプロイ（本番未反映）です**  
> 本仕様書に記載されているカテゴリ拡張（`apparel`, `fashion_goods`）、新列（41〜43列）、および関連するバリデーション・保存処理の実装は、現在ブランチ `feat/category-expansion-apparel-fashion-goods` 上で検証中の**未デプロイ（本番未配信）**状態です。  
> GAS本番環境への配信および商品スプレッドシートへの列追加（41〜43列の手動追加）が完了するまで、本番Web Appでは動作しません。受入テストは本番デプロイ完了後に実施してください。

---

## 1. 概要・通信経路アーキテクチャ

Curry Kicks の既存 Square サイトに掲載されている取扱商品の種類を B.I.S で一元管理できるようにするため、商品主カテゴリに **`apparel`（アパレル）** および **`fashion_goods`（ファッション小物）** を新設します。

### 1.1 現行フロントエンドとの通信経路

現行の B.I.S EC システムでは、アクションの性質に応じて以下の 2 系統の通信経路を使用しています。契約書記載のリクエストは必ずこの経路に従ってください。

```text
【経路 A: 通常商品登録・更新・取得 (create_product, update_product, doGet)】
Readdy (ブラウザ)
  │
  │  POST / GET (Content-Type: text/plain;charset=utf-8)
  │  ※ ブラウザ CORS プリフライト (OPTIONS) を回避するため text/plain で送信
  ▼
Google Apps Script (GAS Web App: /exec)


【経路 B: AI商品ドラフト確定・バッチ操作 (confirm_ai_product_draft 等)】
Readdy (ブラウザ)
  │
  │  POST /confirm_ai_product_draft
  │  Headers: Authorization: Bearer <JWT>
  │  ※ ブラウザ側に ADMIN_API_KEY を露出させないため直接 GAS へは送信しない
  ▼
gas-ai-relay / gas-ai-batch-relay (専用中継サーバー)
  │
  ├─ CORS オリジン照合 (`ALLOWED_ORIGINS`)
  ├─ JWT 署名・期限検証 (`JWT_SECRET`, HS256)
  ├─ サーバー側環境変数より admin_key (ADMIN_API_KEY) を注入
  ▼
Google Apps Script (GAS Web App: /exec)
```

- **送信形式 (POST)**:
  - 経路 A（GAS直接）: **`Content-Type: text/plain;charset=utf-8`**（ボディに `JSON.stringify(payload)` を文字列として設定）。`application/json` は使用しません。
  - 経路 B（中継サーバー経由）: `gas-ai-relay` の仕様に従い `application/json` かつ Bearer JWT ヘッダーを付与。中継サーバーが GAS へ安全に中継します。
- **100%後方互換**: 既存の 4 カテゴリ（`sneaker`, `jewelry`, `pokemon_card`, `other`）および既存商品のスプレッドシート列構造（1〜40列）は一切変更・汚染しません。新属性は 41〜43列（AO〜AQ列）へ独立して保存されます。
- **自己完結型ドキュメント**: 本ファイル単体でカテゴリ値、送受信キー、画面側の必要項目、JSON例、制約事項、受入確認手順のすべてを網羅しています。

---

## 2. 主カテゴリ一覧 (`category`)

商品登録・更新・確定・一覧取得で使用可能な `category` コード値は以下の 6 種類です。

| カテゴリ値 (`category`) | 日本語表示名 | 説明 | 備考 |
| :--- | :--- | :--- | :--- |
| `sneaker` | スニーカー | スニーカー現品 | 既存 (12〜17列使用) |
| `jewelry` | ジュエリー | 高級ジュエリー、シルバーアクセサリー | 既存 (18〜29列使用) |
| `pokemon_card` | ポケモンカード | ポケカシングルカード・PSA鑑定品 | 既存 (別シート管理) |
| `apparel` | アパレル | Tシャツ、パーカー、アウター、パンツ等 | **【新設・未デプロイ】** (41〜43列使用) |
| `fashion_goods` | ファッション小物 | アイウェア、帽子、手袋、財布、キーケース、ベルト、バッグ等 | **【新設・未デプロイ】** (41〜43列使用) |
| `other` | その他 | 上記 5 カテゴリに該当しない商品 | 既存 (共通列のみ使用) |

---

## 3. Chrome Hearts と各カテゴリの紐付けについて

> [!IMPORTANT]
> **「Chrome Hearts」はブランド名（`brand`）であり、カテゴリではありません。**
> 
> Chrome Hearts（クロムハーツ）の商品は種類に応じて適切な主カテゴリ（`category`）に分類して登録します。単一の「クロムハーツ」カテゴリは存在しません。
> 
> - **リング、ネックレス、ブレスレット、ペンダント、チャーム等**  
>   → 主カテゴリ: `category: "jewelry"`、ブランド: `brand: "Chrome Hearts"`
> - **Tシャツ、ロンT、パーカー、スウェット、ジャケット等**  
>   → 主カテゴリ: `category: "apparel"`、ブランド: `brand: "Chrome Hearts"`
> - **サングラス、メガネ、キャップ、財布、キーチェーン、ベルト等**  
>   → 主カテゴリ: `category: "fashion_goods"`、ブランド: `brand: "Chrome Hearts"`

---

## 4. サブカテゴリ一覧 (`subcategory` / `sub_category`)

サブカテゴリは、Curry Kicks 既存サイトの分類に対応した小分類です。

### 4.1. `category: "apparel"` (アパレル) のサブカテゴリ

| サブカテゴリ値 (`subcategory`) | 日本語表示名 | 該当商品例 |
| :--- | :--- | :--- |
| `t_shirt` | Tシャツ | 半袖Tシャツ、長袖Tシャツ、ロンT |
| `shirt` | シャツ | ネルシャツ、ワークシャツ、ドレスシャツ |
| `hoodie_sweatshirt` | パーカー・スウェット | フーディー、ジップパーカー、トレーナー |
| `jacket_outer` | ジャケット・アウター | レザージャケット、トラックジャケット、ダウン、ブルゾン |
| `pants` | パンツ | デニム、ワークパンツ、スウェットパンツ |
| `shorts` | ショーツ | ハーフパンツ、ショートパンツ |
| `other_apparel` | その他アパレル | その他の衣料品 |

### 4.2. `category: "fashion_goods"` (ファッション小物) のサブカテゴリ

| サブカテゴリ値 (`subcategory`) | 日本語表示名 | 該当商品例 |
| :--- | :--- | :--- |
| `eyewear` | アイウェア | サングラス、メガネ |
| `cap_hat` | 帽子 | キャップ、ハット、ビーニー、ニット帽 |
| `gloves` | 手袋 | レザーグローブ、ニットグローブ |
| `wallet` | 財布 | 長財布、二つ折り財布、コインケース、カードケース |
| `key_case` | キーケース・キーホルダー | キーケース、キーリング、キーチェーン |
| `belt` | ベルト | レザーベルト、バックル |
| `bag` | バッグ | ショルダーバッグ、トートバッグ、バックパック、ウエストポーチ |
| `other_goods` | その他小物 | その他の服飾雑貨・小物 |

---

## 5. ジュエリー種類 (`jewelry_type`) の追加候補

既存の `jewelry` カテゴリに対し、以下の 3 種類が正式に拡張されています。

| 種類値 (`jewelry_type`) | 日本語表示名 | GASバックエンド実装状況 | Readdy UI側対応 |
| :--- | :--- | :--- | :--- |
| `ring` | リング (指輪) | 対応済み | 実装済み |
| `necklace` | ネックレス | 対応済み | 実装済み |
| `bracelet` | ブレスレット | 対応済み | 実装済み |
| `pendant` | ペンダント | **対応済み (未デプロイ)** | **UIセレクトへの追加が必要** |
| `charm` | チャーム | **対応済み (未デプロイ)** | **UIセレクトへの追加が必要** |
| `chain` | チェーン | **対応済み (未デプロイ)** | **UIセレクトへの追加が必要** |
| `earring` / `pierce` | ピアス・イヤリング | 対応済み | 実装済み |
| `other_jewelry` | その他ジュエリー | 対応済み | 実装済み |

---

## 6. 商品状態 (`condition`) の仕様（共通6段階）

> [!WARNING]
> **状態値は「A」「S」等の記号ではありません。**
> 
> B.I.S EC では全カテゴリ共通で以下の日本語 6 段階文字列がそのままスプレッドシート本票に保存され、Square 連携や詳細取得でもそのまま返却されます。API 送信時は必ず以下の正確な日本語文字列を使用してください。

| 状態値 (`condition`) | 説明 |
| :--- | :--- |
| `新品・未使用` | 未使用の完全な新品状態 |
| `未使用に近い` | 数回使用程度、極めて美品 |
| `目立った傷や汚れなし` | 通常使用による軽微な使用感のみ |
| `やや傷や汚れあり` | 目視で確認できる傷・汚れがある |
| `傷や汚れあり` | 全体的に使用感や明確なダメージがある |
| `全体的に状態が悪い` | 目立つ損傷・劣化・訳あり品 |

---

## 7. 新カテゴリの属性キーと送受信契約

`apparel` および `fashion_goods` に必要な最小属性は以下の 3 項目です。
ブランド、状態、商品名、販売価格、仕入価格、保管場所、説明文、画像等は既存の共通キーを使用します。

| 属性名 | 送信キー (POST) | 受信キー (GET) | 型 | 必須/任意 | 説明・値の例 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **サブカテゴリ** | `subcategory`<br>*(互換: `sub_category`)* | `subcategory`<br>`sub_category` | string | 任意 (推奨) | セクション4に定義されたコード値（例: `"t_shirt"`, `"eyewear"`, `"wallet"`） |
| **サイズ** | `size` | `size` | string | 任意 | S/M/Lや「36」「Free」「53□18-145」等の文字列 |
| **公式品番** | `official_sku`<br>*(互換: `sku`)* | `official_sku`<br>`sku` | string | 任意 | ブランド公式の型番・品番（例: `"2212-304-4000"`, `"CH-TS-001"`） |

### 列分離と互換性ルール
1. **既存列の完全分離**:
   - `sneaker_size`, `sneaker_sku` (12〜13列) やジュエリー属性 (18〜29列) には一切書き込まれません。
   - スプレッドシート 41列目 (AO: subcategory)、42列目 (AP: size)、43列目 (AQ: official_sku) に保存されます。
   - 既存 4 カテゴリ（`sneaker`, `jewelry`, `pokemon_card`, `other`）の商品に対して誤って `size` や `official_sku` を送信しても、バックエンドで書き込みが遮断され、41〜43列が汚染されることはありません。
2. **キー互換エイリアス**:
   - 送信時: `subcategory` または `sub_category`、`official_sku` または `sku` のどちらでも受け付けます。
   - 受信時: レスポンス（一覧・詳細）には両方のキーが含まれるため、フロントエンドの実装差を吸収します。

---

## 8. API 利用例

### 8.1. 商品新規登録 (`create_product`)

**送信経路**: 経路 A（Readdy → GAS Web App 直接）  
**エンドポイント**: `POST {GAS_WEB_APP_URL}/exec`  
**Content-Type**: `text/plain;charset=utf-8`  
**送信ボディ**: 下記 JSON を `JSON.stringify(payload)` して文字列として送信

#### ペイロード例 1: アパレル (Chrome Hearts Tシャツ)
```json
{
  "action": "create_product",
  "category": "apparel",
  "subcategory": "t_shirt",
  "size": "L",
  "official_sku": "CH-TS-2026-BLK",
  "brand": "Chrome Hearts",
  "product_name": "CH Horseshoe Floral Cross Tee Black",
  "condition": "未使用に近い",
  "planned_sale_price": 58000,
  "purchase_price": 35000,
  "storage_location": "倉庫A-3",
  "description": "クロムハーツ定番のホースシュー・フローラルクロスTシャツです。",
  "publish_status": "draft",
  "images": [
    {
      "file_name": "ch_tee_front.jpg",
      "mime_type": "image/jpeg",
      "base64": "..."
    }
  ]
}
```

#### ペイロード例 2: ファッション小物 (Chrome Hearts サングラス)
```json
{
  "action": "create_product",
  "category": "fashion_goods",
  "subcategory": "eyewear",
  "size": "53□18-145",
  "official_sku": "CH-SUN-001",
  "brand": "Chrome Hearts",
  "product_name": "CH Gittin Any? Sunglasses Black",
  "condition": "新品・未使用",
  "planned_sale_price": 128000,
  "purchase_price": 80000,
  "storage_location": "ショーケース1",
  "description": "クロムハーツのアイウェア。シルバー装飾が特徴的です。",
  "publish_status": "draft",
  "images": []
}
```

**成功レスポンス**:
```json
{
  "success": true,
  "version": "product-create-v2",
  "product_id": "TMP-000150",
  "publish_status": "draft",
  "inventory_status": "in_stock",
  "drive_folder_url": "https://drive.google.com/drive/folders/...",
  "main_image_url": "https://drive.google.com/file/d/.../view",
  "image_count": 1
}
```

---

### 8.2. 商品詳細取得 (`get_product_detail` / `doGet`)

**送信経路**: 経路 A（Readdy → GAS Web App 直接）  
**エンドポイント**: `GET {GAS_WEB_APP_URL}/exec?mode=admin&product_id=TMP-000150&admin_key={ADMIN_API_KEY}`

**成功レスポンス**:
```json
{
  "success": true,
  "version": "admin-product-detail-v1",
  "product": {
    "product_id": "TMP-000150",
    "category": "apparel",
    "subcategory": "t_shirt",
    "sub_category": "t_shirt",
    "size": "L",
    "official_sku": "CH-TS-2026-BLK",
    "sku": "CH-TS-2026-BLK",
    "brand": "Chrome Hearts",
    "product_name": "CH Horseshoe Floral Cross Tee Black",
    "condition": "未使用に近い",
    "planned_sale_price": 58000,
    "purchase_price": 35000,
    "storage_location": "倉庫A-3",
    "description": "クロムハーツ定番のホースシュー・フローラルクロスTシャツです。",
    "notes": "",
    "publish_status": "draft",
    "inventory_status": "in_stock",
    "record_status": "active",
    "sneaker_sku": "",
    "sneaker_size": "",
    "jewelry_type": "",
    "drive_folder_url": "https://drive.google.com/drive/folders/...",
    "main_image_url": "https://drive.google.com/file/d/.../view",
    "images": [
      {
        "file_id": "1abc...",
        "name": "01_main_ch_tee_front.jpg",
        "mime_type": "image/jpeg",
        "view_url": "https://drive.google.com/file/d/.../view",
        "display_url": "https://drive.google.com/thumbnail?id=1abc...&sz=w1600"
      }
    ]
  }
}
```

---

### 8.3. 商品情報更新 (`update_product`)

**送信経路**: 経路 A（Readdy → GAS Web App 直接）  
**エンドポイント**: `POST {GAS_WEB_APP_URL}/exec`  
**Content-Type**: `text/plain;charset=utf-8`

**ペイロード例 (サイズと販売価格の更新)**:
```json
{
  "action": "update_product",
  "product_id": "TMP-000150",
  "size": "XL",
  "planned_sale_price": 62000,
  "subcategory": "hoodie_sweatshirt"
}
```

**成功レスポンス**:
```json
{
  "success": true,
  "product_id": "TMP-000150"
}
```

---

### 8.4. AI商品ドラフト確定 (`confirm_ai_product_draft`)

AIが生成した出品ドラフト候補をスタッフが確認・編集して確定し、本票へ正式登録するエンドポイントです。

> [!NOTE]
> **確定時のカテゴリ指定ルール**:
> - **新規商品の通常登録**: 新規商品は登録時に画面上で明示的に `apparel` または `fashion_goods` を選択して作成します。
> - **本票カテゴリが空欄（未設定）の商品**: 画像取込等で本票の `category` が未設定のまま作成された商品は、初回確定時にスタッフが `apparel` または `fashion_goods` を選択して初回設定できます。
> - **既存の `other` 商品**: 本票の `category` がすでに `"other"` の商品は、`ai_managed` フラグや未確定ドラフトがあっても確定時にカテゴリを変更することはできません（`CATEGORY_CANNOT_BE_CHANGED` で拒絶されます）。

**送信経路**: **経路 B（Readdy → `gas-ai-relay` 経由）**  
**エンドポイント**: `POST {GAS_AI_RELAY_URL}/confirm_ai_product_draft`  
**Headers**:
- `Authorization: Bearer <JWT>`
- `Content-Type: application/json`

> ※Readdy は `gas-ai-relay` へ送信し、中継サーバー側で `ADMIN_API_KEY` が付与されて GAS Web App へ転送されます。ブラウザから直接 GAS `/exec` へ確定リクエストを送ることはできません（管理者認証エラーとなります）。

**ペイロード例 (アパレル商品のドラフト確定)**:
```json
{
  "action": "confirm_ai_product_draft",
  "product_id": "TMP-000150",
  "draft_id": "DRFT_TMP-000150_20261022",
  "draft_version": 1,
  "staff_id": "staff_01",
  "confirmation_attempt_id": "ATTEMPT_20261022_001",
  "confirmed_data": {
    "category": "apparel",
    "subcategory": "t_shirt",
    "size": "XL",
    "official_sku": "CH-TS-CONF",
    "brand": "Chrome Hearts",
    "product_name": "CH Floral Cross Tee Black XL",
    "condition": "未使用に近い",
    "planned_sale_price": 55000,
    "description": "クロムハーツ定番のフローラルクロスTシャツです。",
    "translated_title": "Chrome Hearts Floral Cross Tee Black XL",
    "translated_description": "Authentic Chrome Hearts Floral Cross Tee in size XL."
  }
}
```
*(※ `TMP-000150` は商品登録時に `category: "apparel"` として登録された商品、または本票カテゴリが未設定（空欄）の下書き商品です)*

**成功レスポンス**:
```json
{
  "success": true,
  "product_id": "TMP-000150",
  "draft_id": "DRFT_TMP-000150_20261022",
  "draft_version": 1,
  "review_status": "confirmed",
  "publish_status": "draft"
}
```

---

## 9. カテゴリ変更に関する制約とAIドラフト確定仕様

### 9.1. 登録後のカテゴリ不変原則（カテゴリ変更の厳格禁止）
一度作成された既存商品の `category` を変更することはできません。
商品更新（`update_product`）およびAIドラフト確定（`confirm_ai_product_draft`）のいずれの経路であっても、登録後のカテゴリ変更要求は以下のエラーで厳格に拒絶されます。
```json
{
  "success": false,
  "error_code": "CATEGORY_CANNOT_BE_CHANGED",
  "message": "product category cannot be changed after creation (current: 'other', requested: 'apparel')"
}
```

### 9.2. 既存の `other` 商品およびカテゴリ未設定商品の扱い
- **既存の `other` 商品はカテゴリ変更不可**:
  - 本票の `category` がすでに `"other"` として登録されている商品は、40列目（AN列）に `ai_managed` フラグが付与されていたり、未確定のAIドラフト（`pending_review`）が存在していても、確定時に `apparel` や `fashion_goods` へカテゴリを変更することはできません（`CATEGORY_CANNOT_BE_CHANGED` で拒絶されます）。
  - 登録後カテゴリ不変原則を堅持（Fail-Closed）し、既存商品の意図しないカテゴリ書き換わりを完全に防止します。
- **新規商品の登録運用**:
  - アパレルおよびファッション小物の新規商品は、通常の商品登録時（`create_product`）にスタッフが画面上で明示的に `category: "apparel"` または `"fashion_goods"` を選択して登録してください。
- **本票カテゴリが空欄（未設定）の商品の初回確定**:
  - 画像一括取込（`import_product_by_images`）などで本票の `category` が空欄（未設定）のまま作成された商品に限り、AIドラフト初回確定時（`confirm_ai_product_draft`）にスタッフが選択した `apparel` または `fashion_goods` を正式カテゴリとして設定できます。

### 9.3. スタッフ入力済みサイズ・公式品番の保護
AIドラフト確定時、既存商品にスタッフが入力したサイズ（AP列）や公式品番（AQ列）がすでに存在する場合、**AI候補の値で上書きせず既存値を保護**します。
確定データ（AI候補）による属性保存は、**本票の対象列が空欄の場合にのみ補完**されます。

### 9.4. 列数不足時のフェイルセーフ早期停止
アパレル／ファッション小物のAIドラフト確定時、本票シートの最大列数が 43 列未満の場合は、**商品名・価格・カテゴリ等を含む一切の書き込みを行う前に即座にエラー（`INSUFFICIENT_SHEET_COLUMNS`）で停止**します。「共通項目だけが更新されて新項目が保存されない」中途半端な部分更新は発生しません。また、43列未満のシートに対して新列（41〜43列）の読取も行われません。

---

## 10. Square 連携仕様

1. **Variation 名の表示**:
   - `sneaker`: `27.5cm / 中古-良い` 等
   - `jewelry`: `15号` 等（サイズ指定時）
   - **`apparel` / `fashion_goods`**: 商品に `size`（例: `"L"`, `"36"`, `"Free"`）が登録されている場合、Square Catalog の Variation 名をその `size` に設定します。未設定時は従来通り `"Regular"` となります。
2. **商品説明文 (HTML)**:
   - Square の商品詳細情報に `【状態】`, `【サイズ】`, `【品番】`, `【商品番号】` が自動で掲載されます。
3. **Square カテゴリ割り当て**:
   - Square 実機の小分類カテゴリ ID は後日マッピング予定のため、現時点では Square 側でカテゴリ未指定の通常アイテムとして作成されます。

---

## 11. 受入確認手順（Readdy担当者向け）

> [!CAUTION]
> **最重要注意事項: 初期テスト時のチェックボックス設定**
> 
> B.I.S の商品登録画面は、既定で**「公開（publish_status: published）」**および**「Square連携」**がオンになっています。
> **最初の受入確認（下書き1件テスト）では、必ず画面上の「公開」および「Square連携」のチェックを両方オフにして下書き登録（`publish_status: "draft"`）として実行してください。**
> 本番公開中サイトやSquare本番環境への予期せぬ出品事故を防ぐため、受入手順を厳守してください。

### 受入テストの実施順序

```text
[GASバックエンド本番デプロイ完了 & 商品シート41〜43列追加完了]
          ↓
[Readdy UI画面対応]
  ・カテゴリ選択肢に「アパレル」「ファッション小物」追加
  ・サブカテゴリ選択肢 (t_shirt, eyewear 等) の動的表示
  ・サイズ、公式品番入力欄の設置
  ・ジュエリー種類に「ペンダント」「チャーム」「チェーン」追加
  ・送信時の Content-Type: text/plain;charset=utf-8 設定確認
  ・AI確定リクエストの gas-ai-relay 経由送信設定確認
          ↓
[下書き 1 件での受入確認]
  ① 新規登録画面を開く
     (※既存の other 商品のカテゴリ変更は禁止されています。必ず新規登録画面からカテゴリ「アパレル」を選択してください)
  ② ★「公開」および「Square連携」のチェックを両方オフにする★
  ③ カテゴリ: アパレル、サブカテゴリ: Tシャツ、サイズ: XL、公式品番: CH-TS-TEST、ブランド: Chrome Hearts を入力
  ④ 状態: 「未使用に近い」 を選択
  ⑤ 登録を実行 → 成功レスポンス (TMP-xxxx) を確認
  ⑥ 商品詳細画面を開き、サブカテゴリ・サイズ・公式品番が正しく表示されることを確認
  ⑦ 商品更新画面でサイズを「XXL」に変更し保存 → 詳細画面で反映を確認
          ↓
[受入完了報告]
```
