function clearPokemonCardCache_(productId) {
  const normalizedId = String(productId || "").trim();
  if (!normalizedId) return;
  try {
    CacheService.getScriptCache().remove("prod_poke_" + normalizedId);
  } catch (err) {
    console.warn("clearPokemonCardCache_ error:", err);
  }
}

/**
 * pokemon_cards シートのヘッダー（1行目）が期待スキーマ13列と完全一致するか検証
 * 列数違い（不足または余分な列）、値違い、順序違いがある場合はErrorをスロー
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 */
function validatePokemonCardsSheetSchema_(sheet) {
  const lastColumn = sheet.getLastColumn();

  // 既存ヘッダーの取得（1行目）
  const headerValues = sheet
    .getRange(1, 1, 1, lastColumn)
    .getValues()[0]
    .map(val => String(val || "").trim());

  // ヘッダー列数の一致検証（不足または余分な列がある場合は不一致として拒否）
  if (headerValues.length !== POKEMON_CARDS_HEADERS.length) {
    throw new Error(
      "Pokemon Cards sheet header does not match expected schema: " +
      "expected " + POKEMON_CARDS_HEADERS.length + " columns (" + POKEMON_CARDS_HEADERS.join(", ") + "), " +
      "but found " + headerValues.length + " columns (" + headerValues.join(", ") + ")"
    );
  }

  // 各ヘッダーの順序・値の完全一致検証
  for (let i = 0; i < POKEMON_CARDS_HEADERS.length; i++) {
    if (headerValues[i] !== POKEMON_CARDS_HEADERS[i]) {
      throw new Error(
        "Pokemon Cards sheet header does not match expected schema at column " + (i + 1) + ": " +
        "expected '" + POKEMON_CARDS_HEADERS[i] + "', but found '" + headerValues[i] + "'"
      );
    }
  }
}

/**
 * pokemon_cards のセル値を文字列へ正規化
 * null / undefined のみ空文字とし、0などの偽値も安全に文字列化
 * @param {*} value
 * @return {string}
 */
function normalizePokemonCardStringValue_(value) {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value).trim();
}

/**
 * pokemon_cards の日付セル値をISO文字列または空文字へ正規化
 * @param {*} value
 * @return {string}
 */
function normalizePokemonCardDateValue_(value) {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value || "").trim();
}

/**
 * pokemon_cards シートを手動で初期化する内部関数
 *
 * 既存データを破壊しない安全設計：
 * - シートが存在しない場合：新規作成しヘッダー13列を設定
 * - 空シートが存在する場合：ヘッダー13列を設定
 * - シートとヘッダーが正常に存在する場合：変更せず成功返却
 * - ヘッダーが期待スキーマと不一致（列数違い・順序違い・余分な列等）の場合：上書きせず例外停止
 *
 * @return {Object} 処理結果サマリー
 */
function initializePokemonCardsSheet() {
  const sheetName = POKEMON_CARDS_SHEET_NAME;
  const expectedHeaders = POKEMON_CARDS_HEADERS;

  const lock = LockService.getScriptLock();

  try {
    lock.waitLock(10000);

    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = spreadsheet.getSheetByName(sheetName);

    // Case 1: シートが存在しない場合は新規作成
    if (!sheet) {
      sheet = spreadsheet.insertSheet(sheetName);
      sheet.getRange(1, 1, 1, expectedHeaders.length).setValues([expectedHeaders]);

      console.log("Pokemon Cards sheet initialized: " + sheetName);

      return {
        success: true,
        status: "created",
        sheet_name: sheetName,
        column_count: expectedHeaders.length
      };
    }

    const lastRow = sheet.getLastRow();
    const lastColumn = sheet.getLastColumn();

    // 空シートが存在する場合（行または列が0）
    if (lastRow === 0 || lastColumn === 0) {
      sheet.getRange(1, 1, 1, expectedHeaders.length).setValues([expectedHeaders]);

      console.log("Pokemon Cards sheet initialized: " + sheetName);

      return {
        success: true,
        status: "initialized_existing_empty_sheet",
        sheet_name: sheetName,
        column_count: expectedHeaders.length
      };
    }

    // 既存ヘッダーのスキーマ検証（不一致・余分な列がある場合は例外スロー）
    validatePokemonCardsSheetSchema_(sheet);

    // Case 2: スキーマが完全一致している場合
    console.log("Pokemon Cards sheet already initialized");

    return {
      success: true,
      status: "already_initialized",
      sheet_name: sheetName,
      column_count: expectedHeaders.length
    };

  } finally {
    try {
      lock.releaseLock();
    } catch (_) {
      // noop
    }
  }
}

/**
 * pokemon_cards シート内から product_id に一致する行情報を検索する内部helper
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet 対象シート
 * @param {string} productId 正規化済み product_id
 * @return {{ rowIndex: number, values: Array }|null} 該当行の行番号(1-based)とセル値配列。存在しない場合は null、重複は例外
 */
function findPokemonCardRowByProductId_(sheet, productId) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return null;
  }

  const rows = sheet
    .getRange(2, 1, lastRow - 1, POKEMON_CARDS_HEADERS.length)
    .getValues();

  let matched = null;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowProductId = normalizePokemonCardStringValue_(row[0]);

    if (rowProductId === productId) {
      if (matched !== null) {
        throw new Error(
          "duplicate pokemon card record for product_id: " + productId
        );
      }

      matched = {
        rowIndex: i + 2,
        values: row
      };
    }
  }

  return matched;
}

/**
 * pokemon_cards シートから product_id をキーにカード情報を取得するREAD専用内部関数
 *
 * - product_id が空の場合は例外
 * - pokemon_cards シートが存在しない場合は例外（自動作成しない）
 * - シートのヘッダーが期待スキーマと不一致の場合は例外
 * - データ行がない、または該当 product_id が存在しない場合は null
 * - 重複する product_id が存在する場合は例外
 * - 該当1件のデータを固定キーのオブジェクトで返却
 *
 * @param {string} productId 対象商品ID (例: "TMP-000123")
 * @return {Object|null} ポケモンカード情報オブジェクト、または存在しない場合 null
 */
function getPokemonCardByProductId(productId) {
  const tPokeStart = Date.now();
  const normalizedProductId = String(productId || "").trim();

  if (!normalizedProductId) {
    throw new Error("product_id is required");
  }

  try {
    const cachedStr = CacheService.getScriptCache().get("prod_poke_" + normalizedProductId);
    if (cachedStr) {
      if (cachedStr === "__null__") {
        console.log("[PERF] getPokemonCardByProductId cache HIT (null): " + (Date.now() - tPokeStart) + "ms (product_id=" + normalizedProductId + ")");
        return null;
      }
      const parsed = JSON.parse(cachedStr);
      console.log("[PERF] getPokemonCardByProductId cache HIT: " + (Date.now() - tPokeStart) + "ms (product_id=" + normalizedProductId + ")");
      return parsed;
    }
  } catch (cErr) {
    console.warn("pokemon card cache read error:", cErr);
  }

  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = spreadsheet.getSheetByName(POKEMON_CARDS_SHEET_NAME);

  if (!sheet) {
    throw new Error("pokemon_cards sheet is not initialized");
  }

  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();

  // 空シート（ヘッダーなし）の場合は未初期化エラー
  if (lastRow === 0 || lastColumn === 0) {
    throw new Error("pokemon_cards sheet is not initialized");
  }

  // スキーマ検証（ヘッダー13列の完全一致・余分な列の検知）
  validatePokemonCardsSheetSchema_(sheet);

  const matched = findPokemonCardRowByProductId_(sheet, normalizedProductId);
  if (!matched) {
    try {
      CacheService.getScriptCache().put("prod_poke_" + normalizedProductId, "__null__", PRODUCT_CACHE_EXPIRATION_SEC);
    } catch (_) {}
    console.log("[PERF] getPokemonCardByProductId (not found): " + (Date.now() - tPokeStart) + "ms (product_id=" + normalizedProductId + ")");
    return null;
  }

  const row = matched.values;

  const result = {
    product_id: normalizedProductId,
    card_name: normalizePokemonCardStringValue_(row[1]),
    set_name: normalizePokemonCardStringValue_(row[2]),
    card_number: normalizePokemonCardStringValue_(row[3]),
    rarity: normalizePokemonCardStringValue_(row[4]),
    language: normalizePokemonCardStringValue_(row[5]),
    grading_status: normalizePokemonCardStringValue_(row[6]),
    grader: normalizePokemonCardStringValue_(row[7]),
    grade: normalizePokemonCardStringValue_(row[8]),
    certification_number: normalizePokemonCardStringValue_(row[9]),
    card_condition: normalizePokemonCardStringValue_(row[10]),
    created_at: normalizePokemonCardDateValue_(row[11]),
    updated_at: normalizePokemonCardDateValue_(row[12])
  };

  try {
    CacheService.getScriptCache().put("prod_poke_" + normalizedProductId, JSON.stringify(result), PRODUCT_CACHE_EXPIRATION_SEC);
  } catch (cPutErr) {
    console.warn("pokemon card cache put error:", cPutErr);
  }

  console.log("[PERF] getPokemonCardByProductId: " + (Date.now() - tPokeStart) + "ms (product_id=" + normalizedProductId + ")");
  return result;
}

/**
 * pokemon_cards シートへ product_id をキーとしてカード情報を新規作成・更新するWRITE専用内部関数 (UPSERT)
 *
 * - product_id が空の場合は例外
 * - cardData がオブジェクトでない場合は例外
 * - cardData.product_id が指定されていて引数と不一致の場合は例外
 * - pokemon_cards シートが存在しない・未初期化の場合は例外（自動作成しない）
 * - シートのヘッダーが期待スキーマと不一致の場合は例外
 * - 重複する product_id が存在する場合は例外
 * - 既存レコードがある場合は指定されたキーのみ上書き (partial update)
 * - 業務必須項目 (card_name, language, grading_status) のバリデーション
 * - grading_status ("graded" / "ungraded") に応じた整合性チェックと不要項目の自動クリア
 * - A〜K列の書式を Plain Text ("@") に設定して先頭ゼロ保護
 * - A〜M列を一括 setValues で書き込み
 * - ScriptLock は上位レイヤーの管轄のため内部では取得しない
 *
 * @param {string} productId 対象商品ID (例: "TMP-000123")
 * @param {Object} cardData カード情報
 * @return {{ success: boolean, status: "created"|"updated", product_id: string }}
 */
function savePokemonCardByProductId(productId, cardData) {
  const normalizedProductId = String(productId || "").trim();

  if (!normalizedProductId) {
    throw new Error("product_id is required");
  }

  if (!cardData || typeof cardData !== "object" || Array.isArray(cardData)) {
    throw new Error("pokemon card data is required");
  }

  if (Object.prototype.hasOwnProperty.call(cardData, "product_id")) {
    const cardDataProductId = normalizePokemonCardStringValue_(cardData.product_id);
    if (cardDataProductId !== normalizedProductId) {
      throw new Error("product_id mismatch");
    }
  }

  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = spreadsheet.getSheetByName(POKEMON_CARDS_SHEET_NAME);

  if (!sheet) {
    throw new Error("pokemon_cards sheet is not initialized");
  }

  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();

  // 空シート（ヘッダーなし）の場合は未初期化エラー
  if (lastRow === 0 || lastColumn === 0) {
    throw new Error("pokemon_cards sheet is not initialized");
  }

  // スキーマ検証（ヘッダー13列の完全一致・余分な列の検知）
  validatePokemonCardsSheetSchema_(sheet);

  const matched = findPokemonCardRowByProductId_(sheet, normalizedProductId);
  const isNew = matched === null;
  const existingValues = isNew ? null : matched.values;

  const currentData = {
    card_name: isNew ? "" : normalizePokemonCardStringValue_(existingValues[1]),
    set_name: isNew ? "" : normalizePokemonCardStringValue_(existingValues[2]),
    card_number: isNew ? "" : normalizePokemonCardStringValue_(existingValues[3]),
    rarity: isNew ? "" : normalizePokemonCardStringValue_(existingValues[4]),
    language: isNew ? "" : normalizePokemonCardStringValue_(existingValues[5]),
    grading_status: isNew ? "" : normalizePokemonCardStringValue_(existingValues[6]),
    grader: isNew ? "" : normalizePokemonCardStringValue_(existingValues[7]),
    grade: isNew ? "" : normalizePokemonCardStringValue_(existingValues[8]),
    certification_number: isNew ? "" : normalizePokemonCardStringValue_(existingValues[9]),
    card_condition: isNew ? "" : normalizePokemonCardStringValue_(existingValues[10])
  };

  const businessFields = [
    "card_name",
    "set_name",
    "card_number",
    "rarity",
    "language",
    "grading_status",
    "grader",
    "grade",
    "certification_number",
    "card_condition"
  ];

  const merged = Object.assign({}, currentData);

  for (let i = 0; i < businessFields.length; i++) {
    const field = businessFields[i];
    if (Object.prototype.hasOwnProperty.call(cardData, field)) {
      merged[field] = normalizePokemonCardStringValue_(cardData[field]);
    }
  }

  // 共通必須項目
  if (!merged.card_name) {
    throw new Error("card_name is required");
  }

  if (!merged.language) {
    throw new Error("language is required");
  }

  if (merged.grading_status !== "graded" && merged.grading_status !== "ungraded") {
    throw new Error("grading_status must be graded or ungraded");
  }

  // grading_status に応じた検証と正規化
  if (merged.grading_status === "graded") {
    if (!merged.grader) {
      throw new Error("grader is required for graded card");
    }
    if (!merged.grade) {
      throw new Error("grade is required for graded card");
    }
    // graded の場合は card_condition を必ず空文字へ正規化
    merged.card_condition = "";
  } else {
    // ungraded の場合
    // 要件: ポケカ状態は原則A/B/C（ドラフト初期値A、明らかな傷・白欠け時はBまたはC）
    // 互換性のため空欄ドラフトも許容
    // ungraded の場合は grader, grade, certification_number を必ず空文字へ正規化
    merged.grader = "";
    merged.grade = "";
    merged.certification_number = "";
    if (merged.card_condition) {
      const upperCond = merged.card_condition.toUpperCase();
      if (["A", "B", "C"].includes(upperCond)) {
        merged.card_condition = upperCond;
      }
    }
  }

  const now = new Date();
  const createdAtValue = isNew ? now : existingValues[11];
  const updatedAtValue = now;

  const rowValues = [
    normalizedProductId,
    merged.card_name,
    merged.set_name,
    merged.card_number,
    merged.rarity,
    merged.language,
    merged.grading_status,
    merged.grader,
    merged.grade,
    merged.certification_number,
    merged.card_condition,
    createdAtValue,
    updatedAtValue
  ];

  const targetRow = isNew ? sheet.getLastRow() + 1 : matched.rowIndex;

  // A〜K列 (1〜11列) を Plain Text ("@") に設定（先頭ゼロ保護）
  sheet.getRange(targetRow, 1, 1, 11).setNumberFormat("@");

  // A〜M列 (1〜13列) を一括書き込み（L, M は日付形式を維持）
  sheet.getRange(targetRow, 1, 1, rowValues.length).setValues([rowValues]);

  clearPokemonCardCache_(normalizedProductId);

  return {
    success: true,
    status: isNew ? "created" : "updated",
    product_id: normalizedProductId
  };
}

/**
 * pokemon_cards シートから指定 product_id のレコードを安全に削除する内部rollback helper
 *
 * 1. productId normalize
 * 2. 空なら Error ("product_id is required")
 * 3. pokemon_cards Sheet存在確認（未初期化なら例外）
 * 4. schema validation
 * 5. findPokemonCardRowByProductId_ を使用して検索
 * 6. 存在しない場合: { success: true, status: "not_found", product_id: normalizedProductId }
 * 7. 1件存在する場合: sheet.deleteRow(matched.rowIndex) を実行し { success: true, status: "deleted", product_id: normalizedProductId }
 * 8. 重複の場合: findPokemonCardRowByProductId_ の例外をそのまま伝播
 *
 * @param {string} productId 対象商品ID (例: "TMP-000123")
 * @return {{ success: boolean, status: "deleted"|"not_found", product_id: string }}
 */
function deletePokemonCardByProductId_(productId) {
  const normalizedProductId = String(productId || "").trim();

  if (!normalizedProductId) {
    throw new Error("product_id is required");
  }

  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = spreadsheet.getSheetByName(POKEMON_CARDS_SHEET_NAME);

  if (!sheet) {
    throw new Error("pokemon_cards sheet is not initialized");
  }

  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();

  // 空シート（ヘッダーなし）の場合は未初期化エラー
  if (lastRow === 0 || lastColumn === 0) {
    throw new Error("pokemon_cards sheet is not initialized");
  }

  // スキーマ検証（ヘッダー13列の完全一致・余分な列の検知）
  validatePokemonCardsSheetSchema_(sheet);

  const matched = findPokemonCardRowByProductId_(sheet, normalizedProductId);

  if (!matched) {
    return {
      success: true,
      status: "not_found",
      product_id: normalizedProductId
    };
  }

  sheet.deleteRow(matched.rowIndex);

  clearPokemonCardCache_(normalizedProductId);

  return {
    success: true,
    status: "deleted",
    product_id: normalizedProductId
  };
}
