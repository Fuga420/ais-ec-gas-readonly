// test_documents_relay_integration.mjs
// 独立書類台帳 (Independent Document Ledger) Edge Function <-> PostgreSQL 結合テスト
// WASM PostgreSQL (pglite) を用いて本番マイグレーションDDLを適用し、
// documents-relay の正確な登録ペイロードでDB操作とDrive重複防止を一気通貫で検証する。
//
// ※ 注意: 本テストは Edge Function ロジックの結合再現テストであり、
//    実機 Supabase 上での Edge Function デプロイ実行そのものではありません。

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// pglite をロード (環境依存のない相対・フォールバック解決)
let PGlite;
try {
  const pgliteModule = await import('file:///C:/Users/aij/.gemini/antigravity/brain/22523736-35b0-403f-a4a1-958e65f240f6/scratch/node_modules/@electric-sql/pglite/dist/index.js');
  PGlite = pgliteModule.PGlite;
} catch (e) {
  const fallback = await import('@electric-sql/pglite');
  PGlite = fallback.PGlite;
}

console.log("==================================================");
console.log("=== documents-relay <-> PostgreSQL 結合テスト ===");
console.log("==================================================\n");

const db = new PGlite();

// Supabase標準ロールの初期化
await db.exec(`
  DO $$
  BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
      CREATE ROLE anon NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
      CREATE ROLE authenticated NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
      CREATE ROLE service_role NOLOGIN;
    END IF;
  END
  $$;
`);

// 1. マイグレーションDDLの実行
const migrationSql = fs.readFileSync('./migrations/20261013_independent_documents_ledger.sql', 'utf8');
await db.exec(migrationSql);
console.log("✓ マイグレーションDDL適用完了 (documents, document_lines, document_product_links, 2 views, RLS)");

// documents-relay は service_role でクエリを実行
await db.exec("SET ROLE service_role;");

// モックDriveストレージ
const mockDriveStorage = {
  files: new Map(), // file_id -> fileObj
  hashIndex: new Map(), // hash -> file_id
  createCount: 0,
};

function sha256Hex(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

// GASのupload_independent_documentモック
function mockGasUpload({ idempotency_key, document_type, file_name, mime_type, base64 }) {
  const hash = sha256Hex(base64);
  if (mockDriveStorage.hashIndex.has(hash)) {
    const existingId = mockDriveStorage.hashIndex.get(hash);
    const existing = mockDriveStorage.files.get(existingId);
    return {
      success: true,
      is_reused: true,
      file_id: existing.file_id,
      file_name: existing.file_name,
      mime_type: existing.mime_type,
      file_size: existing.file_size,
      file_fingerprint: hash,
      drive_file_url: existing.drive_file_url,
      view_url: existing.drive_file_url,
      folder_id: "mock_indep_folder_001"
    };
  }

  const fileId = "drive_file_" + Math.random().toString(36).substring(2, 9);
  const fileUrl = `https://drive.google.com/file/d/${fileId}/view`;
  const fileObj = {
    file_id: fileId,
    file_name: file_name,
    mime_type: mime_type,
    file_size: Buffer.from(base64, 'base64').length,
    drive_file_url: fileUrl,
  };
  mockDriveStorage.files.set(fileId, fileObj);
  mockDriveStorage.hashIndex.set(hash, fileId);
  mockDriveStorage.createCount++;

  return {
    success: true,
    is_reused: false,
    file_id: fileId,
    file_name: file_name,
    mime_type: mime_type,
    file_size: fileObj.file_size,
    file_fingerprint: hash,
    drive_file_url: fileUrl,
    view_url: fileUrl,
    folder_id: "mock_indep_folder_001"
  };
}

// documents-relay のコアロジックを忠実に再現
async function relayImportDocument(body) {
  const { idempotency_key, supplier_name, file_name, mime_type, base64, total_amount, notes } = body;
  if (!idempotency_key) throw new Error("IDEMPOTENCY_KEY_REQUIRED");
  if (!supplier_name) throw new Error("SUPPLIER_NAME_REQUIRED");
  if (!file_name) throw new Error("FILE_NAME_REQUIRED");
  if (!base64) throw new Error("BASE64_REQUIRED");

  // 1-1. idempotency_key チェック (GAS呼出し前にDB照合)
  const resKey = await db.query(
    "SELECT * FROM documents WHERE idempotency_key = $1 AND NOT is_deleted",
    [idempotency_key]
  );
  if (resKey.rows.length > 0) {
    const existing = resKey.rows[0];
    const auditRes = await db.query("SELECT * FROM v_document_audit_summary WHERE document_id = $1", [existing.id]);
    return {
      status: 200,
      body: {
        success: true,
        is_reused: true,
        document: existing,
        audit: auditRes.rows[0] || null
      }
    };
  }

  // 1-2. file_fingerprint チェック (Drive保存前に先行照合)
  const preHash = sha256Hex(base64);
  const resHash = await db.query(
    "SELECT * FROM documents WHERE file_fingerprint = $1 AND NOT is_deleted",
    [preHash]
  );
  if (resHash.rows.length > 0) {
    return {
      status: 409,
      body: {
        success: false,
        error_code: "DUPLICATE_FILE_FINGERPRINT",
        message: "同一内容のファイルが既に登録されています。",
        existing_document_id: resHash.rows[0].id
      }
    };
  }

  // 1-3. GASへ保存
  const gasRes = mockGasUpload({
    idempotency_key,
    document_type: body.document_type || "invoice",
    file_name,
    mime_type,
    base64
  });

  const parsedTotal = total_amount !== undefined && total_amount !== null && total_amount !== "" ? Number(total_amount) : null;
  const initialStatus = parsedTotal === null ? "pending_amount" : "pending";

  // 1-4. documents へ登録 (SQL実列名)
  const insertRes = await db.query(`
    INSERT INTO documents (
      idempotency_key, document_number, invoice_registration_number, document_type,
      supplier_name, supplier_code, issue_date, currency, total_amount, tax_amount,
      file_name, mime_type, file_size, file_fingerprint, drive_file_id, drive_folder_id,
      drive_file_url, notes, status, created_by
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20
    ) RETURNING *
  `, [
    idempotency_key,
    body.document_number || null,
    body.invoice_registration_number || null,
    body.document_type || "invoice",
    supplier_name,
    body.supplier_code || null,
    body.issue_date || null,
    body.currency || "JPY",
    parsedTotal,
    body.tax_amount !== undefined && body.tax_amount !== null && body.tax_amount !== "" ? Number(body.tax_amount) : null,
    gasRes.file_name,
    gasRes.mime_type,
    gasRes.file_size,
    gasRes.file_fingerprint,
    gasRes.file_id,
    gasRes.folder_id,
    gasRes.drive_file_url,
    notes || null,
    initialStatus,
    body.confirmed_by || "system"
  ]);

  const newDoc = insertRes.rows[0];
  const auditRes = await db.query("SELECT * FROM v_document_audit_summary WHERE document_id = $1", [newDoc.id]);

  return {
    status: 201,
    body: {
      success: true,
      is_reused: Boolean(gasRes.is_reused),
      document: newDoc,
      audit: auditRes.rows[0] || null
    }
  };
}

async function relaySaveDocumentLines(body) {
  const { document_id, lines } = body;
  for (const item of lines) {
    const receptionRaw = item.reception_number_raw || null;
    const receptionNorm = item.reception_number_normalized || (receptionRaw ? receptionRaw.toUpperCase().replace(/\s+/g, '') : null);
    const pageNumber = item.page_number || 1;
    const lineNumber = item.line_number;

    const totalLineAmount =
      item.total_line_amount !== undefined && item.total_line_amount !== null && item.total_line_amount !== ""
        ? Number(item.total_line_amount)
        : null;

    if (item.id) {
      await db.query(`
        UPDATE document_lines SET
          page_number = $1, line_number = $2, reception_number_raw = $3, reception_number_normalized = $4,
          transaction_type = $5, item_name_raw = $6, item_amount = $7, tax_amount = $8,
          fee_amount = $9, fee_tax_amount = $10, other_expense_amount = $11, total_line_amount = $12,
          is_canceled = $13, cancel_reason = $14, notes = $15, updated_at = NOW()
        WHERE id = $16 AND document_id = $17
      `, [
        pageNumber, lineNumber, receptionRaw, receptionNorm,
        item.transaction_type || "purchase", item.item_name_raw,
        item.item_amount !== undefined && item.item_amount !== null && item.item_amount !== "" ? Number(item.item_amount) : null,
        item.tax_amount !== undefined && item.tax_amount !== null && item.tax_amount !== "" ? Number(item.tax_amount) : null,
        item.fee_amount !== undefined && item.fee_amount !== null && item.fee_amount !== "" ? Number(item.fee_amount) : null,
        item.fee_tax_amount !== undefined && item.fee_tax_amount !== null && item.fee_tax_amount !== "" ? Number(item.fee_tax_amount) : null,
        item.other_expense_amount !== undefined && item.other_expense_amount !== null && item.other_expense_amount !== "" ? Number(item.other_expense_amount) : null,
        totalLineAmount,
        Boolean(item.is_canceled), item.cancel_reason || null, item.notes || null,
        item.id, document_id
      ]);
    } else {
      // 同一 (document_id, page_number, line_number) の既存行（論理削除含む）を確認して再利用
      const existCheck = await db.query(
        "SELECT id, is_deleted FROM document_lines WHERE document_id = $1 AND page_number = $2 AND line_number = $3",
        [document_id, pageNumber, lineNumber]
      );

      if (existCheck.rows.length > 0) {
        const existingId = existCheck.rows[0].id;
        await db.query(`
          UPDATE document_lines SET
            reception_number_raw = $1, reception_number_normalized = $2, lot_number = $3, branch_number = $4,
            transaction_type = $5, item_name_raw = $6, item_amount = $7, tax_amount = $8, fee_amount = $9,
            fee_tax_amount = $10, other_expense_amount = $11, total_line_amount = $12, is_canceled = $13,
            cancel_reason = $14, match_status = 'unlinked', is_active = true, is_deleted = false,
            deleted_at = NULL, deleted_by = NULL, notes = $15, updated_at = NOW()
          WHERE id = $16
        `, [
          receptionRaw, receptionNorm, item.lot_number || null, item.branch_number || null,
          item.transaction_type || "purchase", item.item_name_raw,
          item.item_amount !== undefined && item.item_amount !== null && item.item_amount !== "" ? Number(item.item_amount) : null,
          item.tax_amount !== undefined && item.tax_amount !== null && item.tax_amount !== "" ? Number(item.tax_amount) : null,
          item.fee_amount !== undefined && item.fee_amount !== null && item.fee_amount !== "" ? Number(item.fee_amount) : null,
          item.fee_tax_amount !== undefined && item.fee_tax_amount !== null && item.fee_tax_amount !== "" ? Number(item.fee_tax_amount) : null,
          item.other_expense_amount !== undefined && item.other_expense_amount !== null && item.other_expense_amount !== "" ? Number(item.other_expense_amount) : null,
          totalLineAmount,
          Boolean(item.is_canceled), item.cancel_reason || null, item.notes || null,
          existingId
        ]);
      } else {
        await db.query(`
          INSERT INTO document_lines (
            document_id, page_number, line_number, reception_number_raw, reception_number_normalized,
            lot_number, branch_number, transaction_type, item_name_raw, item_amount, tax_amount,
            fee_amount, fee_tax_amount, other_expense_amount, total_line_amount, is_canceled, cancel_reason,
            match_status, is_active, notes
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, 'unlinked', true, $18
          )
        `, [
          document_id, pageNumber, lineNumber, receptionRaw, receptionNorm,
          item.lot_number || null, item.branch_number || null, item.transaction_type || "purchase",
          item.item_name_raw,
          item.item_amount !== undefined && item.item_amount !== null && item.item_amount !== "" ? Number(item.item_amount) : null,
          item.tax_amount !== undefined && item.tax_amount !== null && item.tax_amount !== "" ? Number(item.tax_amount) : null,
          item.fee_amount !== undefined && item.fee_amount !== null && item.fee_amount !== "" ? Number(item.fee_amount) : null,
          item.fee_tax_amount !== undefined && item.fee_tax_amount !== null && item.fee_tax_amount !== "" ? Number(item.fee_tax_amount) : null,
          item.other_expense_amount !== undefined && item.other_expense_amount !== null && item.other_expense_amount !== "" ? Number(item.other_expense_amount) : null,
          totalLineAmount,
          Boolean(item.is_canceled), item.cancel_reason || null,
          item.notes || null
        ]);
      }
    }
  }

  // ステータス更新
  const auditRes = await db.query("SELECT * FROM v_document_audit_summary WHERE document_id = $1", [document_id]);
  const audit = auditRes.rows[0];
  let newStatus = "lines_registered";
  if (audit) {
    const unlinkedCount = Number(audit.unlinked_lines_count) || 0;
    const confirmedCount = Number(audit.confirmed_lines_count) || 0;
    const hasDiscrepancy = audit.discrepancy_amount !== null && Number(audit.discrepancy_amount) !== 0;
    if (unlinkedCount === 0 && confirmedCount > 0 && !hasDiscrepancy) {
      newStatus = "fully_matched";
    } else if (confirmedCount > 0) {
      newStatus = "partially_matched";
    } else if (hasDiscrepancy) {
      newStatus = "flagged";
    }
    await db.query(`
      UPDATE documents SET status = $1, extracted_line_count = $2, extracted_total_amount = $3, discrepancy_amount = $4, updated_at = NOW()
      WHERE id = $5
    `, [newStatus, audit.active_lines_count, audit.extracted_total_amount, audit.discrepancy_amount, document_id]);
  }

  return { success: true, document_id, audit };
}

async function relayDeleteDocumentLine(body) {
  const { document_line_id, deleted_by } = body;
  const lineRes = await db.query("SELECT * FROM document_lines WHERE id = $1 AND NOT is_deleted", [document_line_id]);
  if (lineRes.rows.length === 0) throw new Error("LINE_NOT_FOUND");
  const line = lineRes.rows[0];

  await db.query("UPDATE document_product_links SET is_deleted = true, deleted_at = NOW(), deleted_by = $1, status = 'unlinked' WHERE document_line_id = $2", [deleted_by || null, document_line_id]);
  await db.query("UPDATE document_lines SET is_deleted = true, is_active = false, deleted_at = NOW(), deleted_by = $1 WHERE id = $2", [deleted_by || null, document_line_id]);

  await relaySaveDocumentLines({ document_id: line.document_id, lines: [] });
  return { success: true, deleted_line_id: document_line_id };
}

async function relayLinkProductManual(body) {
  const { document_line_id, product_id, link_type, allocated_amount, confirmed_by, notes } = body;
  const lineRes = await db.query("SELECT * FROM document_lines WHERE id = $1 AND NOT is_deleted", [document_line_id]);
  if (lineRes.rows.length === 0) throw new Error("LINE_NOT_FOUND");
  const line = lineRes.rows[0];

  const lkType = link_type || "primary_cost";

  // 割当金額の決定ロジック
  // 1. allocated_amount がリクエストで明示されている場合はその値を使用する (0も有効)
  // 2. allocated_amount が未入力の場合は明細の total_line_amount を使用する
  // 3. 両方とも未入力またはNULLの場合は HTTP 400 ALLOCATED_AMOUNT_REQUIRED
  // 4. 有限な数値でない場合は HTTP 400 INVALID_ALLOCATED_AMOUNT
  let rawAllocated;
  if (allocated_amount !== undefined && allocated_amount !== null && allocated_amount !== "") {
    rawAllocated = allocated_amount;
  } else if (line.total_line_amount !== null && line.total_line_amount !== undefined && line.total_line_amount !== "") {
    rawAllocated = line.total_line_amount;
  } else {
    return {
      status: 400,
      success: false,
      error_code: "ALLOCATED_AMOUNT_REQUIRED",
      error: "明細の合計金額が未設定のため、割当金額 (allocated_amount) の指定が必要です。"
    };
  }

  const amount = Number(rawAllocated);
  if (!Number.isFinite(amount)) {
    return {
      status: 400,
      success: false,
      error_code: "INVALID_ALLOCATED_AMOUNT",
      error: "割当金額 (allocated_amount) は有効な数値である必要があります。"
    };
  }

  // 同一 (document_line_id, product_id, link_type) の既存リンクを確認 (論理削除済みなら再利用・復元)
  const existLink = await db.query(
    "SELECT * FROM document_product_links WHERE document_line_id = $1 AND product_id = $2 AND link_type = $3",
    [document_line_id, product_id, lkType]
  );

  let returnedLink;
  if (existLink.rows.length > 0) {
    const updated = await db.query(`
      UPDATE document_product_links SET
        allocated_amount = $1, allocation_method = 'direct', match_method = 'manual', confidence_score = 1.00,
        status = 'confirmed', confirmed_by = $2, confirmed_at = NOW(), notes = $3,
        is_deleted = false, deleted_at = NULL, deleted_by = NULL, updated_at = NOW()
      WHERE id = $4
      RETURNING *
    `, [amount, confirmed_by || null, notes || null, existLink.rows[0].id]);
    returnedLink = updated.rows[0];
  } else {
    const inserted = await db.query(`
      INSERT INTO document_product_links (
        document_line_id, product_id, link_type, allocated_amount, allocation_method, match_method,
        confidence_score, status, confirmed_by, confirmed_at, notes
      ) VALUES (
        $1, $2, $3, $4, 'direct', 'manual', 1.00, 'confirmed', $5, NOW(), $6
      ) RETURNING *
    `, [document_line_id, product_id, lkType, amount, confirmed_by || null, notes || null]);
    returnedLink = inserted.rows[0];
  }

  // 行のマッチ状態を 'confirmed' へ
  await db.query("UPDATE document_lines SET match_status = 'confirmed', updated_at = NOW() WHERE id = $1", [document_line_id]);

  // 書類ステータス再計算
  await relaySaveDocumentLines({ document_id: line.document_id, lines: [] });

  const auditRes = await db.query("SELECT * FROM v_document_audit_summary WHERE document_id = $1", [line.document_id]);
  const costRes = await db.query("SELECT * FROM v_product_cost_breakdown WHERE product_id = $1", [product_id]);

  return {
    status: 200,
    success: true,
    link: returnedLink,
    audit: auditRes.rows[0],
    product_cost: costRes.rows[0] || null
  };
}

async function relayGetDocument(document_id) {
  const docRes = await db.query("SELECT * FROM documents WHERE id = $1 AND NOT is_deleted", [document_id]);
  if (docRes.rows.length === 0) throw new Error("DOCUMENT_NOT_FOUND");
  const auditRes = await db.query("SELECT * FROM v_document_audit_summary WHERE document_id = $1", [document_id]);
  const linesRes = await db.query("SELECT * FROM document_lines WHERE document_id = $1 AND NOT is_deleted ORDER BY line_number ASC", [document_id]);
  return {
    success: true,
    document: docRes.rows[0],
    audit: auditRes.rows[0] || null,
    lines: linesRes.rows
  };
}

async function relayUnlinkProductManual(body) {
  const { link_id, deleted_by } = body;
  const lkRes = await db.query("SELECT * FROM document_product_links WHERE id = $1 AND NOT is_deleted", [link_id]);
  if (lkRes.rows.length === 0) throw new Error("LINK_NOT_FOUND");
  const link = lkRes.rows[0];

  await db.query("UPDATE document_product_links SET is_deleted = true, deleted_at = NOW(), deleted_by = $1, status = 'unlinked' WHERE id = $2", [deleted_by || null, link_id]);

  // 行の残りリンク確認
  const remaining = await db.query(
    "SELECT * FROM document_product_links WHERE document_line_id = $1 AND NOT is_deleted AND status = 'confirmed'",
    [link.document_line_id]
  );
  if (remaining.rows.length === 0) {
    await db.query("UPDATE document_lines SET match_status = 'unlinked', updated_at = NOW() WHERE id = $1", [link.document_line_id]);
  }

  const lineRes = await db.query("SELECT document_id FROM document_lines WHERE id = $1", [link.document_line_id]);
  if (lineRes.rows.length > 0) {
    await relaySaveDocumentLines({ document_id: lineRes.rows[0].document_id, lines: [] });
  }

  const costRes = await db.query("SELECT * FROM v_product_cost_breakdown WHERE product_id = $1", [link.product_id]);
  return {
    success: true,
    unlinked_id: link_id,
    product_cost: costRes.rows[0] || null
  };
}

// ----------------------------------------------------
// テストシナリオの実行
// ----------------------------------------------------
let passed = 0;
let failed = 0;
function assert(name, condition, extra = "") {
  if (condition) {
    console.log(`✓ ${name}`);
    passed++;
  } else {
    console.error(`✗ ${name}: ${extra}`);
    failed++;
  }
}

// 1. import_document で documents 登録成功
const samplePdfB64 = Buffer.from("SAMPLE_PDF_PAYLOAD_E2E_001").toString('base64');
const import1 = await relayImportDocument({
  idempotency_key: "idem-e2e-001",
  supplier_name: "コメ兵",
  supplier_code: "2764",
  document_type: "statement",
  document_number: "20250507_KOMEHYO",
  issue_date: "2025-05-07",
  total_amount: 520850.00,
  tax_amount: 47350.00,
  file_name: "20251216_計算書_K026021.pdf",
  mime_type: "application/pdf",
  base64: samplePdfB64,
  notes: "5月アパレル落札分"
});

assert(
  "1. import_document で documents 登録成功 (SQL列名完全準拠・Drive URL保存)",
  import1.status === 201 &&
  import1.body.success === true &&
  import1.body.document.supplier_name === "コメ兵" &&
  import1.body.document.notes === "5月アパレル落札分" &&
  Number(import1.body.document.total_amount) === 520850.00 &&
  Boolean(import1.body.document.drive_file_url) &&
  import1.body.document.status === "pending" &&
  mockDriveStorage.createCount === 1,
  JSON.stringify(import1.body)
);

const createdDocId = import1.body.document.id;

// 2. 同一キー再送で Drive・DB とも増えない
const import2 = await relayImportDocument({
  idempotency_key: "idem-e2e-001",
  supplier_name: "コメ兵",
  file_name: "20251216_計算書_K026021.pdf",
  mime_type: "application/pdf",
  base64: samplePdfB64,
});

const countRes2 = await db.query("SELECT COUNT(*) FROM documents WHERE NOT is_deleted");
assert(
  "2. 同一キー再送で Drive・DB とも増えない (is_reused: true, Drive作成回数維持)",
  import2.status === 200 &&
  import2.body.success === true &&
  import2.body.is_reused === true &&
  import2.body.document.id === createdDocId &&
  mockDriveStorage.createCount === 1 &&
  Number(countRes2.rows[0].count) === 1,
  `status: ${import2.status}, driveCreates: ${mockDriveStorage.createCount}, dbRows: ${countRes2.rows[0].count}`
);

// 3. 同一ファイル別キーで Drive・DB とも増えない
const import3 = await relayImportDocument({
  idempotency_key: "idem-e2e-002", // 別キー
  supplier_name: "コメ兵",
  file_name: "dup_komehyo.pdf",
  mime_type: "application/pdf",
  base64: samplePdfB64, // 同一バイナリ (同一指紋)
});

const countRes3 = await db.query("SELECT COUNT(*) FROM documents WHERE NOT is_deleted");
assert(
  "3. 同一ファイル別キーで Drive・DB とも増えない (409 DUPLICATE_FILE_FINGERPRINT, Drive作成遮断)",
  import3.status === 409 &&
  import3.body.error_code === "DUPLICATE_FILE_FINGERPRINT" &&
  mockDriveStorage.createCount === 1 &&
  Number(countRes3.rows[0].count) === 1,
  `status: ${import3.status}, code: ${import3.body.error_code}, driveCreates: ${mockDriveStorage.createCount}`
);

// 4. save_document_lines で明細登録成功
const saveLinesRes = await relaySaveDocumentLines({
  document_id: createdDocId,
  lines: [
    {
      page_number: 1,
      line_number: 1,
      reception_number_raw: "K026021",
      reception_number_normalized: "K026021",
      item_name_raw: "CHANEL マトラッセ チェーンショルダー",
      transaction_type: "purchase",
      item_amount: 450000.00,
      tax_amount: 45000.00,
      fee_amount: 22500.00,
      fee_tax_amount: 2250.00,
      total_line_amount: 519750.00,
      is_canceled: false,
      notes: "美品・箱あり"
    },
    {
      page_number: 1,
      line_number: 2,
      item_name_raw: "事務諸費用",
      transaction_type: "participation_fee",
      item_amount: 1000.00,
      tax_amount: 100.00,
      total_line_amount: 1100.00,
      is_canceled: false,
      notes: "参加費"
    }
  ]
});

const linesInDb = await db.query("SELECT * FROM document_lines WHERE document_id = $1 ORDER BY line_number ASC", [createdDocId]);
const line1 = linesInDb.rows[0];
const line2 = linesInDb.rows[1];

assert(
  "4. save_document_lines で明細登録成功 (SQL列名準拠・生成列計算・match_status: unlinked)",
  linesInDb.rows.length === 2 &&
  line1.item_name_raw === "CHANEL マトラッセ チェーンショルダー" &&
  line1.transaction_type === "purchase" &&
  line1.match_status === "unlinked" &&
  Number(line1.item_amount_tax_included) === 495000.00 &&
  Number(line1.fee_amount_tax_included) === 24750.00 &&
  Number(line1.total_line_amount) === 519750.00 &&
  Number(line2.total_line_amount) === 1100.00,
  JSON.stringify(linesInDb.rows)
);

// 5. link_product_manual 後に原価が 0 円ではなく集計される
const linkRes1 = await relayLinkProductManual({
  document_line_id: line1.id,
  product_id: "TMP-000117",
  link_type: "primary_cost",
  allocated_amount: 450000.00,
  confirmed_by: "staff_suzuki",
  notes: "商品現物と落札明細照合完了"
});

const linkRes2 = await relayLinkProductManual({
  document_line_id: line1.id,
  product_id: "TMP-000117",
  link_type: "commission",
  allocated_amount: 24750.00,
  confirmed_by: "staff_suzuki",
  notes: "落札手数料割当"
});

const costRes = await db.query("SELECT * FROM v_product_cost_breakdown WHERE product_id = $1", ["TMP-000117"]);
const costRow = costRes.rows[0];

assert(
  "5. link_product_manual 後に原価が 0 円ではなく集計される (total_allocated_cost > 0)",
  costRes.rows.length === 1 &&
  Number(costRow.total_primary_cost) === 450000.00 &&
  Number(costRow.total_commission_fee) === 24750.00 &&
  Number(costRow.total_allocated_cost) === 474750.00 &&
  Number(costRow.total_sale_proceeds) === 0.00,
  JSON.stringify(costRow)
);

// 6. get_document の差額・照合件数が正しい
const getDoc = await relayGetDocument(createdDocId);
const audit = getDoc.audit;

// 原本総額: 520,850円, 明細総額: 519,750 + 1,100 = 520,850円 -> 差額 0.00円
assert(
  "6. get_document の差額・照合件数が正しい (discrepancy_amount: 0.00, confirmed: 1, unlinked: 1)",
  Number(audit.declared_total_amount) === 520850.00 &&
  Number(audit.extracted_total_amount) === 520850.00 &&
  Number(audit.discrepancy_amount) === 0.00 &&
  Number(audit.confirmed_lines_count) === 1 &&
  Number(audit.unlinked_lines_count) === 1 &&
  getDoc.document.status === "partially_matched",
  JSON.stringify(audit)
);

// 7. unlink 後に原価と照合状態が戻る
await relayUnlinkProductManual({ link_id: linkRes1.link.id, deleted_by: "staff_suzuki" });
await relayUnlinkProductManual({ link_id: linkRes2.link.id, deleted_by: "staff_suzuki" });

const costAfterUnlink = await db.query("SELECT * FROM v_product_cost_breakdown WHERE product_id = $1", ["TMP-000117"]);
const line1AfterUnlink = await db.query("SELECT match_status FROM document_lines WHERE id = $1", [line1.id]);
const auditAfterUnlink = await db.query("SELECT * FROM v_document_audit_summary WHERE document_id = $1", [createdDocId]);

assert(
  "7. unlink 後に原価と照合状態が戻る (原価集計行なし, match_status: unlinked, confirmed_lines: 0)",
  costAfterUnlink.rows.length === 0 &&
  line1AfterUnlink.rows[0].match_status === "unlinked" &&
  Number(auditAfterUnlink.rows[0].confirmed_lines_count) === 0 &&
  Number(auditAfterUnlink.rows[0].unlinked_lines_count) === 2,
  `costRows: ${costAfterUnlink.rows.length}, line1Status: ${line1AfterUnlink.rows[0].match_status}`
);

// 8. unlink 後に同じ商品・同じ link_type へ再紐付けでき、原価が再集計される (再利用・復元)
const relinkRes = await relayLinkProductManual({
  document_line_id: line1.id,
  product_id: "TMP-000117",
  link_type: "primary_cost",
  allocated_amount: 450000.00,
  confirmed_by: "staff_suzuki",
  notes: "手動再紐付け"
});

const costAfterRelink = await db.query("SELECT * FROM v_product_cost_breakdown WHERE product_id = $1", ["TMP-000117"]);
assert(
  "8. unlink 後に同じ商品・同じ link_type へ再紐付けでき、原価が再集計される (UNIQUE制約衝突回避・再利用)",
  relinkRes.success === true &&
  relinkRes.link.is_deleted === false &&
  relinkRes.link.status === "confirmed" &&
  costAfterRelink.rows.length === 1 &&
  Number(costAfterRelink.rows[0].total_primary_cost) === 450000.00 &&
  Number(costAfterRelink.rows[0].total_allocated_cost) === 450000.00,
  JSON.stringify(costAfterRelink.rows)
);

// 9. 論理削除した明細と同じ page_number・line_number で再登録できる (行番号再利用)
await relayDeleteDocumentLine({ document_line_id: line2.id, deleted_by: "staff_suzuki" });
const line2AfterDelete = await db.query("SELECT is_deleted, is_active FROM document_lines WHERE id = $1", [line2.id]);
assert(
  "9-1. 明細行の論理削除成功 (is_deleted: true, is_active: false)",
  line2AfterDelete.rows[0].is_deleted === true && line2AfterDelete.rows[0].is_active === false,
  JSON.stringify(line2AfterDelete.rows[0])
);

// 同じ page_number: 1, line_number: 2 で再登録
const reRegisterLineRes = await relaySaveDocumentLines({
  document_id: createdDocId,
  lines: [
    {
      page_number: 1,
      line_number: 2,
      item_name_raw: "再登録 事務諸費用",
      transaction_type: "participation_fee",
      item_amount: 1500.00,
      tax_amount: 150.00,
      total_line_amount: 1650.00,
      is_canceled: false,
      notes: "参加費修正再登録"
    }
  ]
});

const line2AfterReRegister = await db.query("SELECT * FROM document_lines WHERE document_id = $1 AND page_number = 1 AND line_number = 2", [createdDocId]);
assert(
  "9-2. 論理削除した明細と同じ page_number・line_number で再登録できる (UNIQUE制約衝突回避・再活性化)",
  line2AfterReRegister.rows.length === 1 &&
  line2AfterReRegister.rows[0].is_deleted === false &&
  line2AfterReRegister.rows[0].is_active === true &&
  line2AfterReRegister.rows[0].item_name_raw === "再登録 事務諸費用" &&
  Number(line2AfterReRegister.rows[0].total_line_amount) === 1650.00,
  JSON.stringify(line2AfterReRegister.rows[0])
);

// 10. 金額未入力 (NULL) と 0円 (0.00) の区別
const nullZeroLineRes = await relaySaveDocumentLines({
  document_id: createdDocId,
  lines: [
    {
      page_number: 1,
      line_number: 3,
      item_name_raw: "未確定明細",
      transaction_type: "purchase",
      total_line_amount: null // 未入力
    },
    {
      page_number: 1,
      line_number: 4,
      item_name_raw: "無償サービス品",
      transaction_type: "other",
      total_line_amount: 0.00 // 0円
    }
  ]
});

const line3InDb = await db.query("SELECT total_line_amount FROM document_lines WHERE document_id = $1 AND line_number = 3", [createdDocId]);
const line4InDb = await db.query("SELECT total_line_amount FROM document_lines WHERE document_id = $1 AND line_number = 4", [createdDocId]);

assert(
  "10. 金額未入力 (NULL) と 0円 (0.00) の厳格な区別 (NULL保持 vs 0.00保持)",
  line3InDb.rows[0].total_line_amount === null &&
  line4InDb.rows[0].total_line_amount !== null &&
  Number(line4InDb.rows[0].total_line_amount) === 0.00,
  `line3: ${line3InDb.rows[0].total_line_amount}, line4: ${line4InDb.rows[0].total_line_amount}`
);

// 11. total_line_amount = NULL の明細に対する割当金額 (allocated_amount) のバリデーション
const line3Record = (await db.query("SELECT * FROM document_lines WHERE document_id = $1 AND line_number = 3", [createdDocId])).rows[0];

// 11-1. total_line_amount = NULL の明細に対して allocated_amount を省略すると、ALLOCATED_AMOUNT_REQUIRED となりリンクが作成されない
const omitAllocatedRes = await relayLinkProductManual({
  document_line_id: line3Record.id,
  product_id: "TMP-000117",
  link_type: "primary_cost",
  confirmed_by: "staff_suzuki"
});

const linksForLine3Omit = await db.query("SELECT * FROM document_product_links WHERE document_line_id = $1", [line3Record.id]);

assert(
  "11-1. total_line_amount = NULL の明細に対して allocated_amount を省略すると ALLOCATED_AMOUNT_REQUIRED となりリンクが作成されない",
  omitAllocatedRes.success === false &&
  omitAllocatedRes.status === 400 &&
  omitAllocatedRes.error_code === "ALLOCATED_AMOUNT_REQUIRED" &&
  linksForLine3Omit.rows.length === 0,
  JSON.stringify({ omitAllocatedRes, linkCount: linksForLine3Omit.rows.length })
);

// 11-2. 同じ明細に allocated_amount: 0 を明示すると、0円のリンクとして正常に登録できる
const zeroAllocatedRes = await relayLinkProductManual({
  document_line_id: line3Record.id,
  product_id: "TMP-000117",
  link_type: "primary_cost",
  allocated_amount: 0,
  confirmed_by: "staff_suzuki",
  notes: "0円手動割当"
});

const linksForLine3Zero = await db.query("SELECT * FROM document_product_links WHERE document_line_id = $1 AND NOT is_deleted", [line3Record.id]);

assert(
  "11-2. 同じ明細に allocated_amount: 0 を明示すると、0円のリンクとして正常に登録できる",
  zeroAllocatedRes.success === true &&
  zeroAllocatedRes.status === 200 &&
  Number(zeroAllocatedRes.link.allocated_amount) === 0.00 &&
  linksForLine3Zero.rows.length === 1 &&
  Number(linksForLine3Zero.rows[0].allocated_amount) === 0.00,
  JSON.stringify(linksForLine3Zero.rows[0])
);

console.log("\n==================================================");
console.log(`=== 結合テスト完了: ${passed}/${passed + failed} 通過 (失敗: ${failed}) ===`);
console.log("==================================================");

if (failed > 0) {
  process.exit(1);
}
