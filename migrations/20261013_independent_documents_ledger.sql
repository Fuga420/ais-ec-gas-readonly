-- ==============================================================================
-- AIS-EC: 請求書・領収書の独立取込と受付番号照合・商品別損益 (工程1 マイグレーション 改訂版)
-- Migration: 20261013_independent_documents_ledger.sql
-- Description:
--   商品未登録でも書類原本を先行取込・保持できる独立書類台帳 (documents)、
--   元ページ・行・受付番号・取引区分・キャンセル行を保持する明細行台帳 (document_lines)、
--   および商品IDと明細行を安全に紐付ける照合台帳 (document_product_links) を新設する。
--
-- 改訂設計原則 (レビュー指摘反映):
--   1. 厳格なアクセス制御 (RLS & View):
--      ブラウザ (anon, authenticated) からの直接アクセスを全拒否。
--      ビューにも security_invoker = true を設定し、RLS迂回を完全に遮断。
--      DBアクセスは許可されたサーバー中継 (service_role) のみに限定。
--   2. 符号と集計の厳格化:
--      監査差額 (discrepancy_amount) は、原本の請求総額とキャンセル・返金行を含めた全明細純額を
--      突き合わせて計算 (キャンセル行を一律除外しない)。
--      商品原価集約 (v_product_cost_breakdown) では、販売精算 (sale_settlement) を原価に加算せず
--      売上精算として完全分離。共通経費の自動按分は実装せず手動明細として管理。
--   3. 履歴保全と削除抑止 (RESTRICT & 訂正追跡):
--      ON DELETE CASCADE を全廃し ON DELETE RESTRICT を適用 (親レコードの安易な物理削除を禁止)。
--      論理削除 (is_deleted) および訂正元参照 (correction_of_line_id) による監査トレイルを装備。
--   4. 金額未確認 (NULL) と 0円の厳格な区別:
--      原本先行保管のため total_amount / item_amount / fee_amount は NULL 許容とし、
--      未入力 (NULL) と 0円 (0.00) を明確に区別。
--   5. 受付番号の非一意性:
--      仕入先ごとに採番規則が異なり、他社との重複や再出品重複があり得るため単体UNIQUEにはしない。
-- ==============================================================================

-- 1. 書類台帳 (documents)
--    原本ファイル単位の台帳。商品登録前でも取込・保持可能。
CREATE TABLE IF NOT EXISTS documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- 書類ヘッダー情報
    document_number VARCHAR(100),                          -- 計算書番号 / 請求書番号 / 領収書番号
    invoice_registration_number VARCHAR(50),               -- 適格請求書発行事業者登録番号 (例: 'T2180001141237', 'T1010401168038')
    document_type VARCHAR(50) NOT NULL,                    -- 'invoice' (請求書), 'receipt' (領収書), 'statement' (計算書), 'delivery_note' (納品書), 'other'
    supplier_name VARCHAR(255) NOT NULL,                   -- 仕入先/取引先名 (例: 'オークネット', 'コメ兵', 'ネットジャパン', 'メルカリ', 'ヤフオク', 'PSA')
    supplier_code VARCHAR(100),                            -- 会員番号 / 仕入先コード (例: 'K026021', '2764', '10773')
    issue_date DATE,                                       -- 発行日 / 計上日
    due_date DATE,                                         -- 支払期日 (請求書の場合)
    currency VARCHAR(10) NOT NULL DEFAULT 'JPY',           -- 通貨
    
    -- 原本金額サマリー (NULL許容: NULL = 金額未確認・未入力, 0.00 = 0円)
    total_amount NUMERIC(12, 2),                           -- 原本記載の請求金額合計 / 支払合計 (税込)
    tax_amount NUMERIC(12, 2),                             -- 原本記載の消費税合計
    
    -- Google Drive 保管連携
    drive_file_id VARCHAR(255) NOT NULL,                   -- Google Drive ファイルID
    drive_folder_id VARCHAR(255),                          -- 保存先DriveフォルダID (仕入先/年月別等)
    drive_file_url TEXT,                                   -- 閲覧URL
    file_name VARCHAR(255) NOT NULL,                       -- アップロード時の元ファイル名
    mime_type VARCHAR(100) NOT NULL,                       -- 'application/pdf', 'image/jpeg', 'image/png' 等
    file_size BIGINT NOT NULL,                             -- ファイルサイズ (バイト)
    file_fingerprint VARCHAR(64) NOT NULL,                 -- SHA-256ハッシュ (ファイル重複検知・誤認防止)
    
    -- 再送・冪等性・処理状態管理
    idempotency_key VARCHAR(255) NOT NULL,                 -- クライアント指定の再送防止キー (UUID等)
    status VARCHAR(50) NOT NULL DEFAULT 'pending',         -- 'pending' (取込直後), 'pending_amount' (金額未入力), 'lines_registered' (明細登録済), 'partially_matched' (一部照合), 'fully_matched' (全行照合完了), 'flagged' (差額・抽出注意あり), 'archived' (アーカイブ)
    extracted_line_count INTEGER NOT NULL DEFAULT 0,       -- 抽出/登録された明細行数
    extracted_total_amount NUMERIC(12, 2),                 -- 抽出明細の総額合計 (純額税込)
    discrepancy_amount NUMERIC(12, 2),                     -- 原本合計 vs 抽出純額の差額 (原本合計 - 抽出合計)
    
    -- 備考・監査・論理削除 (物理削除禁止)
    notes TEXT,                                            -- 社内備考
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE,             -- 論理削除フラグ
    deleted_at TIMESTAMPTZ,                                -- 削除日時
    deleted_by VARCHAR(100),                               -- 削除実行者
    deletion_reason TEXT,                                  -- 削除理由
    created_by VARCHAR(100) NOT NULL DEFAULT 'system',     -- 登録者 (システムまたはスタッフ識別子)
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- 制約: 再送キーは一意、同一バイナリハッシュの多重登録を抑止
    CONSTRAINT uq_documents_idempotency UNIQUE (idempotency_key),
    CONSTRAINT uq_documents_fingerprint UNIQUE (file_fingerprint)
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_documents_supplier_date ON documents (supplier_name, issue_date);
CREATE INDEX IF NOT EXISTS idx_documents_document_number ON documents (document_number);
CREATE INDEX IF NOT EXISTS idx_documents_status ON documents (status);
CREATE INDEX IF NOT EXISTS idx_documents_drive_file_id ON documents (drive_file_id);
CREATE INDEX IF NOT EXISTS idx_documents_is_deleted ON documents (is_deleted);


-- 2. 書類明細行台帳 (document_lines)
--    書類内の明細行単位の台帳。元ページ・行、受付番号、金額内訳、キャンセル行を完全保持。
--    ON DELETE RESTRICT により、紐づく明細がある書類の物理削除を防止。
CREATE TABLE IF NOT EXISTS document_lines (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
    
    -- 原本位置情報
    page_number INTEGER NOT NULL DEFAULT 1,                -- 原本PDFのページ番号 (1-indexed)
    line_number INTEGER NOT NULL,                          -- ページ内または書類内の明細行番号 (NO)
    
    -- 照合キー (受付番号・ロット番号・枝番・セリ順)
    -- 注意: 受付番号は仕入先ごとに採番規則が異なり、他社との重複や再出品重複があり得るため単体UNIQUEにはしない
    reception_number_raw VARCHAR(100),                     -- 受付番号 原文 (例: '808-22821', '251-2', '469-9', '468-9')
    reception_number_normalized VARCHAR(100),              -- 受付番号 正規化値 (半角英数・前後空白除去・大文字・ハイフン統一)
    lot_number VARCHAR(50),                                -- ロットNo / 箱番号 (例: '251', '468', '469')
    branch_number VARCHAR(50),                             -- 枝番 (例: '2', '9', '6')
    auction_bid_number VARCHAR(100),                       -- セリ順 / オークション番号 (例: '80228')
    
    -- 原本品名・属性
    item_name_raw TEXT NOT NULL,                           -- 原本の品名・表記 (例: 'ティンバーランドコラボ 靴', 'ルース ダイヤモンド')
    brand_name_raw VARCHAR(255),                           -- 原本のブランド名 (例: 'LOUIS VUITTON', 'CHROME HEARTS', 'NIKE')
    category_hint VARCHAR(100),                            -- 原本・ERP上のカテゴリ分類 (例: 'スニーカー/靴', '宝石/貴金属', 'ポケカ', 'アパレル')
    item_rank_raw VARCHAR(50),                             -- 原本の状態ランク (例: 'Used', 'A', 'B')
    accessory_raw TEXT,                                    -- 原本の付属品表記 (例: '箱', '箱・紐', 'CGLソ', '有り')
    
    -- 取引区分 (符号・集計の根拠)
    -- 'purchase' (仕入/落札・プラス), 'commission' (落札手数料・プラス), 'participation_fee' (参加費/事務諸費用・プラス), 
    -- 'shipping' (配送料・プラス), 'other_expense' (写真代/その他経費・プラス), 'unsold_fee' (流札手数料・プラス), 
    -- 'cancel' (キャンセル行・請求除外時は0/相殺), 'refund' (返金/値引・マイナス), 'sale_settlement' (販売精算/売上代金・請求上マイナス相殺), 'other'
    transaction_type VARCHAR(50) NOT NULL DEFAULT 'purchase',
    
    -- 金額内訳 (NULL許容: NULL = 未入力, 0.00 = 0円)
    item_amount NUMERIC(12, 2),                            -- 商品代 (税抜本体代)
    tax_amount NUMERIC(12, 2),                             -- 商品代消費税
    item_amount_tax_included NUMERIC(12, 2) GENERATED ALWAYS AS (
        CASE WHEN item_amount IS NULL THEN NULL ELSE item_amount + COALESCE(tax_amount, 0) END
    ) STORED,                                              -- 商品代税込
    
    fee_rate NUMERIC(5, 2),                                -- 落札手数料率 (例: 5.00, 10.00, 15.00 %)
    fee_amount NUMERIC(12, 2),                             -- 取引手数料 (税抜)
    fee_tax_amount NUMERIC(12, 2),                         -- 手数料消費税
    fee_amount_tax_included NUMERIC(12, 2) GENERATED ALWAYS AS (
        CASE WHEN fee_amount IS NULL THEN NULL ELSE fee_amount + COALESCE(fee_tax_amount, 0) END
    ) STORED,                                              -- 手数料税込
    
    other_expense_amount NUMERIC(12, 2),                   -- その他経費 (税抜: 配送費・写真代・流札等)
    other_expense_tax_amount NUMERIC(12, 2),               -- その他経費消費税
    other_expense_tax_included NUMERIC(12, 2) GENERATED ALWAYS AS (
        CASE WHEN other_expense_amount IS NULL THEN NULL ELSE other_expense_amount + COALESCE(other_expense_tax_amount, 0) END
    ) STORED,                                              -- その他経費税込
    
    total_line_amount NUMERIC(12, 2),                      -- 当該行の請求/支払純額税込 (符号付き)
    
    -- キャンセル・除外管理 (削除せず行・履歴を完全保持)
    is_canceled BOOLEAN NOT NULL DEFAULT FALSE,            -- キャンセル行フラグ
    cancel_reason TEXT,                                    -- キャンセル理由・流札・落札辞退等の事由
    
    -- 照合状態
    -- 'unlinked' (未照合), 'candidate' (候補あり), 'confirmed' (照合確定), 'conflict' (複数候補競合), 'ignored' (照合不要)
    match_status VARCHAR(50) NOT NULL DEFAULT 'unlinked',
    
    -- 訂正履歴追跡・論理削除
    is_active BOOLEAN NOT NULL DEFAULT TRUE,               -- 最新有効行フラグ (訂正時は旧行をfalse化)
    correction_of_line_id UUID REFERENCES document_lines(id) ON DELETE RESTRICT, -- 訂正元行のID
    correction_reason TEXT,                                -- 訂正理由
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE,             -- 論理削除フラグ
    deleted_at TIMESTAMPTZ,                                -- 削除日時
    deleted_by VARCHAR(100),                               -- 削除実行者
    
    -- 備考・監査
    notes TEXT,                                            -- 原本備考または運用メモ
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- 制約: 同一書類・同ページ・同明細行の重複登録を防止
    CONSTRAINT uq_document_lines_doc_page_line UNIQUE (document_id, page_number, line_number)
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_document_lines_reception_norm ON document_lines (reception_number_normalized);
CREATE INDEX IF NOT EXISTS idx_document_lines_doc_id ON document_lines (document_id);
CREATE INDEX IF NOT EXISTS idx_document_lines_match_status ON document_lines (match_status);
CREATE INDEX IF NOT EXISTS idx_document_lines_trans_type ON document_lines (transaction_type);
CREATE INDEX IF NOT EXISTS idx_document_lines_is_active ON document_lines (is_active);


-- 3. 書類明細-商品照合台帳 (document_product_links)
--    明細行と商品マスタ (product_id) の紐付け。
--    ON DELETE RESTRICT により、確定リンクが存在する明細行の物理削除を防止。
CREATE TABLE IF NOT EXISTS document_product_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_line_id UUID NOT NULL REFERENCES document_lines(id) ON DELETE RESTRICT,
    product_id VARCHAR(100) NOT NULL,                      -- GAS/Sheets商品マスターの product_id (例: 'TMP-0001', 'PROD-0001')
    
    -- 紐付け種別
    -- 'primary_cost' (主仕入原価), 'commission' (落札手数料), 'shipping_cost' (配送料), 
    -- 'other_expense' (その他経費), 'refund' (仕入値引/返金・原価減算), 'sale_settlement' (販売精算/売上代金・原価非加算)
    link_type VARCHAR(50) NOT NULL DEFAULT 'primary_cost',
    
    -- 割当金額 (符号付き)
    allocated_amount NUMERIC(12, 2) NOT NULL,
    allocation_method VARCHAR(50) NOT NULL DEFAULT 'direct', -- 'direct' (単品全額), 'manual_split' (手動按分) ※自動按分は実装しない
    
    -- 照合方式と確信度
    -- 'manual' (MVP手動紐付け), 'reception_number_exact' (将来の自動照合), 'lot_branch_match' (将来のロット枝番照合)
    match_method VARCHAR(50) NOT NULL DEFAULT 'manual',
    confidence_score NUMERIC(3, 2) NOT NULL DEFAULT 1.00,  -- 0.00 〜 1.00
    
    -- 照合ライフサイクル
    -- 'candidate' (自動照合候補), 'confirmed' (スタッフ確定済), 'rejected' (スタッフ却下), 'unlinked' (手動解除)
    status VARCHAR(50) NOT NULL DEFAULT 'confirmed',
    
    -- 確定監査情報 (スタッフによる承認ログ)
    confirmed_by VARCHAR(100),                             -- 確定スタッフ識別子
    confirmed_at TIMESTAMPTZ,                              -- 確定日時
    notes TEXT,                                            -- 紐付け理由・按分根拠
    
    -- 論理削除 (リンク解除時も履歴を残す)
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
    deleted_at TIMESTAMPTZ,
    deleted_by VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- 制約: 同一明細行・同一商品・同一紐付け種別の二重登録を抑止
    CONSTRAINT uq_doc_product_links UNIQUE (document_line_id, product_id, link_type)
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_doc_product_links_product_id ON document_product_links (product_id);
CREATE INDEX IF NOT EXISTS idx_doc_product_links_line_id ON document_product_links (document_line_id);
CREATE INDEX IF NOT EXISTS idx_doc_product_links_status ON document_product_links (status);


-- 4. 監査・サマリー用ビュー (Views)
-- 4-1. 書類監査サマリービュー: 原本公称総額 vs 抽出明細総額の差額監視
--      security_invoker = true により、ビュー経由のRLS迂回を完全に遮断。
--      キャンセル行・返金行を含めた全明細純額を合計して原本総額と突き合わせる。
CREATE OR REPLACE VIEW v_document_audit_summary
WITH (security_invoker = true) AS
SELECT
    d.id AS document_id,
    d.document_number,
    d.supplier_name,
    d.issue_date,
    d.status AS document_status,
    d.total_amount AS declared_total_amount,
    COALESCE(SUM(l.total_line_amount) FILTER (WHERE NOT l.is_deleted AND l.is_active), 0) AS extracted_total_amount,
    COUNT(l.id) FILTER (WHERE NOT l.is_deleted AND l.is_active) AS active_lines_count,
    COUNT(l.id) FILTER (WHERE l.is_canceled AND NOT l.is_deleted AND l.is_active) AS canceled_lines_count,
    COUNT(l.id) FILTER (WHERE l.match_status = 'confirmed' AND NOT l.is_deleted AND l.is_active) AS confirmed_lines_count,
    COUNT(l.id) FILTER (WHERE l.match_status = 'unlinked' AND NOT l.is_canceled AND NOT l.is_deleted AND l.is_active) AS unlinked_lines_count,
    -- 差額計算: declared_total_amount が NULL の場合は NULL (未確定)
    CASE
        WHEN d.total_amount IS NULL THEN NULL
        ELSE d.total_amount - COALESCE(SUM(l.total_line_amount) FILTER (WHERE NOT l.is_deleted AND l.is_active), 0)
    END AS discrepancy_amount,
    -- 各種内訳集計 (監査用)
    COALESCE(SUM(l.total_line_amount) FILTER (WHERE l.transaction_type = 'purchase' AND NOT l.is_deleted AND l.is_active), 0) AS purchase_total,
    COALESCE(SUM(l.total_line_amount) FILTER (WHERE l.transaction_type IN ('commission', 'fee_only') AND NOT l.is_deleted AND l.is_active), 0) AS commission_total,
    COALESCE(SUM(l.total_line_amount) FILTER (WHERE l.transaction_type = 'participation_fee' AND NOT l.is_deleted AND l.is_active), 0) AS participation_fee_total,
    COALESCE(SUM(l.total_line_amount) FILTER (WHERE l.transaction_type IN ('refund', 'discount') AND NOT l.is_deleted AND l.is_active), 0) AS refund_total,
    COALESCE(SUM(l.total_line_amount) FILTER (WHERE l.transaction_type = 'sale_settlement' AND NOT l.is_deleted AND l.is_active), 0) AS sale_settlement_total
FROM documents d
LEFT JOIN document_lines l ON d.id = l.document_id
WHERE NOT d.is_deleted
GROUP BY d.id, d.document_number, d.supplier_name, d.issue_date, d.status, d.total_amount;


-- 4-2. 商品別原価集約ビュー: 商品IDに確定紐付けされた仕入原価の積上げサマリー
--      security_invoker = true により、ビュー経由のRLS迂回を完全に遮断。
--      販売精算 (sale_settlement) は原価に絶対に足さず、売上精算 (total_sale_proceeds) として完全分離。
CREATE OR REPLACE VIEW v_product_cost_breakdown
WITH (security_invoker = true) AS
SELECT
    lks.product_id,
    COUNT(DISTINCT l.document_id) AS document_count,
    COUNT(lks.id) AS matched_lines_count,
    -- 仕入本体原価 (+)
    COALESCE(SUM(lks.allocated_amount) FILTER (WHERE lks.link_type = 'primary_cost'), 0) AS total_primary_cost,
    -- 手数料・鑑定料 (+)
    COALESCE(SUM(lks.allocated_amount) FILTER (WHERE lks.link_type IN ('additional_fee', 'commission')), 0) AS total_commission_fee,
    -- 配送料 (+)
    COALESCE(SUM(lks.allocated_amount) FILTER (WHERE lks.link_type = 'shipping_cost'), 0) AS total_shipping_cost,
    -- その他経費 (+)
    COALESCE(SUM(lks.allocated_amount) FILTER (WHERE lks.link_type = 'other_expense'), 0) AS total_other_expense,
    -- 仕入返金・値引 (-)
    COALESCE(SUM(lks.allocated_amount) FILTER (WHERE lks.link_type = 'refund'), 0) AS total_purchase_refund,
    -- 合計仕入原価: (本体 + 手数料 + 配送料 + その他経費) - 返金 ※販売精算は除外
    (
        COALESCE(SUM(lks.allocated_amount) FILTER (WHERE lks.link_type = 'primary_cost'), 0)
      + COALESCE(SUM(lks.allocated_amount) FILTER (WHERE lks.link_type IN ('additional_fee', 'commission')), 0)
      + COALESCE(SUM(lks.allocated_amount) FILTER (WHERE lks.link_type = 'shipping_cost'), 0)
      + COALESCE(SUM(lks.allocated_amount) FILTER (WHERE lks.link_type = 'other_expense'), 0)
      - ABS(COALESCE(SUM(lks.allocated_amount) FILTER (WHERE lks.link_type = 'refund'), 0))
    ) AS total_allocated_cost,
    -- 販売精算額 (売上は原価とは分離して参考表示)
    COALESCE(SUM(lks.allocated_amount) FILTER (WHERE lks.link_type = 'sale_settlement'), 0) AS total_sale_proceeds,
    MAX(lks.confirmed_at) AS last_confirmed_at
FROM document_product_links lks
JOIN document_lines l ON lks.document_line_id = l.id
WHERE lks.status = 'confirmed' AND NOT lks.is_deleted AND NOT l.is_deleted AND l.is_active
GROUP BY lks.product_id;


-- 5. 厳格なアクセス制御 (RLS & Table Grants)
-- 5-1. 全テーブル・ビューから一般・匿名権限を剥奪
REVOKE ALL ON documents, document_lines, document_product_links FROM PUBLIC, anon, authenticated;
REVOKE ALL ON v_document_audit_summary, v_product_cost_breakdown FROM PUBLIC, anon, authenticated;

-- 5-2. サービスロール (Edge Functions 経由) のみに権限付与
GRANT ALL ON documents, document_lines, document_product_links TO service_role;
GRANT SELECT ON v_document_audit_summary, v_product_cost_breakdown TO service_role;

-- 5-3. Row Level Security (RLS) 有効化
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_product_links ENABLE ROW LEVEL SECURITY;

-- 5-4. サービスロール用ポリシー (service_role のみ全操作許可、anon/authenticated はポリシーなし=全拒否)
DROP POLICY IF EXISTS "service_role_all_documents" ON documents;
CREATE POLICY "service_role_all_documents"
    ON documents FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_all_document_lines" ON document_lines;
CREATE POLICY "service_role_all_document_lines"
    ON document_lines FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_all_document_product_links" ON document_product_links;
CREATE POLICY "service_role_all_document_product_links"
    ON document_product_links FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
