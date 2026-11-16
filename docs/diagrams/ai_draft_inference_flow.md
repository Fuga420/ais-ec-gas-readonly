# AIドラフト推論パイプライン・検証設計・想定経路図

本ドキュメントは、AI出品ドラフト生成における推論制御パイプラインの全体像、および実画像テスト（TMP-000113、TMP-000114）における検証設計・想定経路を可視化したものです（※修正後コードの実機実測ログ取得待ち）。

GitHub Web画面やMermaid対応ビューアーで自動的にダイアグラムとして表示されます。
また、ローカルで開いてSVG/PNG画像として保存したい場合は、同フォルダの [ai_draft_inference_flow.html](./ai_draft_inference_flow.html) をブラウザで開いてください。

---

## 1. 推論パイプライン全体フロー

画像とメタデータの入力から、先行分類、Stage A、柔軟抽出、Stage B、カテゴリ救済、型番候補提示、成約価格算出、裏面未撮影サニタイズを経てドラフト保存に至る完全制御フローです。

```mermaid
flowchart TD
    Start["画像・商品メタデータ入力"] --> PriorClass["先行カテゴリー判定 (classifyCategoryPriorFromImages_)"]
    
    PriorClass --> CheckPrior{"カテゴリー判定結果"}
    CheckPrior -->|"不一致検知 (category_mismatch)"| StageAGeneric["汎用客観検査 Stage A (推測遮断)"]
    CheckPrior -->|"ポケカ確定"| StageAPoke["ポケカ専用 Stage A (直接視認 + 検索)"]
    CheckPrior -->|"スニーカー確定"| StageASneaker["スニーカー専用 Stage A (箱ラベル/タグ確認 + 検索)"]
    CheckPrior -->|"形式エラー / 未確定"| StageAGeneric
    
    StageAPoke --> ParseA["柔軟抽出パーサー (parseStageASections_)"]
    StageASneaker --> ParseA
    StageAGeneric --> ParseA
    
    ParseA --> StageB["Stage B: 構造化ドラフト生成 (直接視認値バインド)"]
    StageB --> CategoryRescue{"先行分類未確定かつ<br/>後段で特定成功?"}
    CategoryRescue -->|"はい"| RescueCat["カテゴリ確定 (needs_reviewからcategory除外)"]
    CategoryRescue -->|"いいえ"| KeepCat["既存カテゴリ状態維持"]
    
    RescueCat --> SkuRescue{"スニーカー箱ラベル未撮影かつ<br/>検索で型番確認?"}
    KeepCat --> SkuRescue
    
    SkuRescue -->|"はい"| SetSkuCand["型番候補提示 (sku_source: search_corroborated)<br/>出典注記追記 + needs_review: sku"]
    SkuRescue -->|"いいえ / 箱ラベル直読"| SetDirectSku["直読SKU採用 (sku_source: box_label)"]
    
    SetSkuCand --> PriceCheck{"価格根拠検査 (calculateServerGroundedPrice_)"}
    SetDirectSku --> PriceCheck
    
    PriceCheck -->|"同一モデル比較可能 (comparable_model)"| CompPrice["参考価格案算出 (price_basis: comparable_model_reference)<br/>needs_review_price: true (自動確定遮断)"]
    PriceCheck -->|"厳格成約一致 (exact_match)"| ExactPrice["成約中央値/平均値算出"]
    PriceCheck -->|"根拠なし"| NoPrice["価格 null (空欄)"]
    
    CompPrice --> SanitizeCond{"ポケカかつ裏面画像未撮影?"}
    ExactPrice --> SanitizeCond
    NoPrice --> SanitizeCond
    
    SanitizeCond -->|"はい"| BlankCond["状態欄 condition: '' (空欄化)<br/>needs_review: condition, card_condition"]
    SanitizeCond -->|"いいえ"| NormalCond["状態保持"]
    
    BlankCond --> FinalDraft["AIドラフト生成完了 (product_ai_drafts 保存)"]
    NormalCond --> FinalDraft
```

---

## 2. TMP-000113 検証設計・想定通過経路（ポケモンカード表面1枚）

カード表面写真1枚のみの入力に対し、先行分類が高信頼度でポケカを特定、Stage Aでミュウexの各識別子を正確に読み取り、Stage Bでタイトルを構築。裏面未撮影であるため状態の断定を回避（空欄化）し、直近成約取引を参照した価格案を算出する想定設計です。

```mermaid
flowchart LR
    A["TMP-000113 (表面1枚)"] --> B["先行分類: pokemon_card (high)"]
    B --> C["ポケカ専用 Stage A: ミュウex / M6a / 129/103 / SAR 視認"]
    C --> D["柔軟パーサー: card_name='ミュウex', card_number='129/103', set_code='M6a', rarity='SAR' 抽出"]
    D --> E["Stage B: ミュウex [M6a 129/103] 30th CELEBRATION 生成"]
    E --> F["裏面未撮影サニタイズ: condition='', needs_review=['condition', 'card_condition']"]
    F --> G["成約取引検索: 直近取引参照案 (price: 算出値, price_basis: recent_transaction_reference)"]
```

---

## 3. TMP-000114 検証設計・想定通過経路（スニーカー外観1枚）

シューズ外観1枚（箱ラベル未撮影）の入力に対し、先行分類の一時的パースエラーを後段の汎用客観検査・Stage Bで自動救済して `sneaker` を確定。Google Search で確認した型番 `IB4481-500` をモデル整合性検証（Kobe V Protro）を経て出典注記付きの候補として提示し、サイズ未確認を踏まえた同一モデル成約参考価格案を提示する想定設計です。

```mermaid
flowchart LR
    A["TMP-000114 (シューズ外観1枚)"] --> B["先行分類: 形式エラーで未確定 (category='')"]
    B --> C["汎用客観検査 Stage A: Nike Kobe 外観特定、検索で型番 IB4481-500 確認"]
    C --> D["柔軟パーサー: box_label_sku=NONE, style_code='IB4481-500' 抽出"]
    D --> E["Stage B: NIKE Kobe V Protro “Year of the Mamba” Eggplant 特定、後段カテゴリ救済 (category='sneaker')"]
    E --> F["型番候補設定: sku='IB4481-500', sku_source='search_corroborated', 出典注記付与, needs_review=['sku']"]
    F --> G["価格計算: サイズ未確認・同一モデル成約 (comparable_model) 参考価格案算出, needs_review_price=true"]
```
