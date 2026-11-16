const ROOT_FOLDER_ID = "1HoDrdlNNGCsPpGMPWCej3sA5CqWv24xV";


// ==================================================
// POST 共通入口
// ==================================================

function doPost(e, testOptions) {
  if (
    e &&
    String(
      e.parameter &&
      e.parameter.route || ""
    ).trim() === "square-webhook"
  ) {
    return handleSquareWebhookRelay(e);
  }

  const lock = LockService.getScriptLock();
  let requestedAction = "";

  try {
    // 同時更新による競合を防止
    lock.waitLock(10000);

    const data = JSON.parse(e.postData.contents);
    requestedAction = String(data && data.action || "").trim();

    const opts = testOptions || {};
    const sheet = opts.sheet || SpreadsheetApp
      .getActiveSpreadsheet()
      .getSheets()[0];
    const propService = opts.propService;

    // ------------------------------------------
    // 1. 公開状態変更
    // ------------------------------------------

    if (data.action === "update_publish_status") {
      return handleUpdatePublishStatus(sheet, data, opts);
    }


    // ------------------------------------------
    // 2. 商品情報変更
    // ------------------------------------------

    if (data.action === "update_product") {
      return handleUpdateProduct(sheet, data);
    }


    // ------------------------------------------
    // 3. 商品画像変更 / AI解析用選択画像の保存・取得
    // ------------------------------------------

    if (data.action === "update_product_images") {
      return handleUpdateProductImages(sheet, data);
    }

    if (
      data.action === "save_product_ai_selected_images" ||
      data.action === "update_product_ai_selected_images" ||
      data.action === "save_ai_selected_images" ||
      data.action === "update_ai_selected_images"
    ) {
      return handleSaveProductAiSelectedImages(sheet, data);
    }

    if (data.action === "get_product_ai_selected_images") {
      return handleGetProductAiSelectedImages(sheet, data);
    }


    // ------------------------------------------
    // 4. 在庫状態変更
    // ------------------------------------------

    if (data.action === "update_inventory_status") {
      return handleUpdateInventoryStatus(sheet, data);
    }

    // レコード状態変更（追加）
    if (data.action === "update_record_status") {
      return handleUpdateRecordStatus(sheet, data, opts);
    }

    // 商品完全削除
    if (data.action === "delete_product") {
      return handleDeleteProduct(sheet, data);
    }

    // Square Sandbox商品作成
    if (data.action === "create_square_product") {
      return handleCreateSquareProduct(sheet, data);
    }

    // Square Sandbox商品更新
    if (data.action === "update_square_product") {
      return handleUpdateSquareProduct(sheet, data);
    }

    // Square Sandboxメイン画像同期
    if (data.action === "sync_square_product_image") {
      return handleSyncSquareProductImage(sheet, data);
    }

    // Square Sandbox在庫同期
    if (data.action === "sync_square_product_inventory") {
      return handleSyncSquareProductInventory(sheet, data);
    }

    // Square Production商品作成
    if (data.action === "create_square_production_product") {
      return handleCreateSquareProductionProduct(sheet, data);
    }

    // Square Productionメイン画像同期
    if (data.action === "sync_square_production_image") {
      return handleSyncSquareProductionImage(sheet, data);
    }

    // Square Production在庫同期
    if (data.action === "sync_square_production_inventory") {
      return handleSyncSquareProductionInventory(sheet, data, opts);
    }

    // Square Production商品詳細同期（商品名・説明文・サイズ/状態表示）
    if (data.action === "sync_square_production_details") {
      return handleSyncSquareProductionDetails(sheet, data, opts);
    }

    // Square Production 商品アーカイブ復帰 (明示的再連携用・管理者認証必須)
    if (data.action === "unarchive_square_production_product") {
      if (!verifyAdminAccess_(data, propService)) {
        return jsonResponse({
          success: false,
          error_code: "UNAUTHORIZED_ADMIN_ACCESS",
          message: "Admin authentication required to unarchive Square product"
        });
      }
      return handleUnarchiveSquareProductionProduct(sheet, data, opts);
    }

    // Square Production 状態照合・検出・安全回収 (管理者認証必須)
    if (data.action === "reconcile_square_product_status") {
      if (!verifyAdminAccess_(data, propService)) {
        return jsonResponse({
          success: false,
          error_code: "UNAUTHORIZED_ADMIN_ACCESS",
          message: "Admin authentication required to reconcile Square product status"
        });
      }
      const reconciliation = reconcileSquareProductionProductStatus(data.product_id, Object.assign({}, opts, {
        auto_reconcile: data.auto_reconcile
      }));
      return jsonResponse(reconciliation);
    }

    // Square Production Payment Link (決済URL) 生成
    if (data.action === "create_square_payment_link") {
      return handleCreateSquarePaymentLink(sheet, data, opts);
    }

    // LLM翻訳生成
    if (data.action === "generate_translation") {
      return handleGenerateTranslation(sheet, data);
    }

    // LLM翻訳ステータス承認
    if (data.action === "approve_translation") {
      return handleApproveTranslation(sheet, data);
    }

    // AI出品ドラフト生成 (管理者認証必須・通信分離・短時間排他ロック内部制御)
    if (data.action === "generate_ai_product_draft") {
      if (!verifyAdminAccess_(data)) {
        return jsonResponse({
          success: false,
          error_code: "UNAUTHORIZED_ADMIN_ACCESS",
          message: "Admin authentication required to generate AI draft"
        });
      }
      try {
        lock.releaseLock();
      } catch (_) {}
      return handleGenerateAiProductDraft(sheet, data);
    }

    // AI出品ドラフト スタッフ確認・確定 (管理者認証必須)
    if (data.action === "confirm_ai_product_draft") {
      if (!verifyAdminAccess_(data)) {
        return jsonResponse({
          success: false,
          error_code: "UNAUTHORIZED_ADMIN_ACCESS",
          message: "Admin authentication required to confirm AI draft"
        });
      }
      return handleConfirmAiProductDraft(sheet, data);
    }

    // AI一括出品ドラフト受付 (管理者認証必須)
    if (data.action === "create_ai_product_draft_batch") {
      if (!verifyAdminAccess_(data)) {
        return jsonResponse({
          success: false,
          error_code: "UNAUTHORIZED_ADMIN_ACCESS",
          message: "Admin authentication required"
        });
      }
      try {
        lock.releaseLock();
      } catch (_) {}
      return handleCreateAiProductDraftBatch(data);
    }

    // AI一括出品ドラフト進捗取得 (管理者認証必須)
    if (data.action === "get_ai_product_draft_batch") {
      if (!verifyAdminAccess_(data)) {
        return jsonResponse({
          success: false,
          error_code: "UNAUTHORIZED_ADMIN_ACCESS",
          message: "Admin authentication required"
        });
      }
      return handleGetAiProductDraftBatch(data);
    }

    // AI一括出品ドラフト再試行 (管理者認証必須)
    if (data.action === "retry_ai_product_draft_batch") {
      if (!verifyAdminAccess_(data)) {
        return jsonResponse({
          success: false,
          error_code: "UNAUTHORIZED_ADMIN_ACCESS",
          message: "Admin authentication required"
        });
      }
      try {
        lock.releaseLock();
      } catch (_) {}
      return handleRetryAiProductDraftBatch(data);
    }

    // AI一括出品ワーカー即時実行 / トリガー設置 (管理者認証必須)
    if (data.action === "run_ai_batch_worker") {
      if (!verifyAdminAccess_(data)) {
        return jsonResponse({
          success: false,
          error_code: "UNAUTHORIZED_ADMIN_ACCESS",
          message: "Admin authentication required"
        });
      }
      try {
        lock.releaseLock();
      } catch (_) {}
      ensureAiBatchTrigger();
      const res = processAiBatchQueue();
      return jsonResponse({ success: true, worker_result: res });
    }

    if (data.action === "setup_ai_batch_trigger") {
      if (!verifyAdminAccess_(data)) {
        return jsonResponse({
          success: false,
          error_code: "UNAUTHORIZED_ADMIN_ACCESS",
          message: "Admin authentication required"
        });
      }
      const trigger = ensureAiBatchTrigger();
      return jsonResponse({ success: true, trigger_id: trigger ? trigger.getUniqueId() : null });
    }

    // 複数商品・画像インポート (新ルート)
    if (data.action === "import_product_by_images") {
      return handleImportProductByImages(sheet, data);
    }

    // Cloud Run + Supabase 正本からの下書き商品新規登録ミラー & Drive画像保存
    if (data.action === "mirror_created_draft_product") {
      return handleMirrorCreatedDraftProduct_(sheet, data, opts);
    }

    // Cloud Run + Supabase 正本からの AI下書き生成・確定状態ミラー (下書き専用・Square公開ゲート互換)
    if (data.action === "mirror_ai_product_draft_state") {
      return handleMirrorAiProductDraftState_(sheet, data, opts);
    }

    // Cloud Run + Supabase への AI下書き履歴同期・バックフィル読取
    if (data.action === "get_ai_product_drafts_for_sync") {
      return handleGetAiProductDraftsForSync_(sheet, data, opts);
    }

    // 商品添付書類 (請求書・領収書) 登録・再送
    if (data.action === "attach_product_document") {
      return handleAttachProductDocument(sheet, data);
    }

    // 独立原本書類アップロード (商品未登録でもDriveへ保存・管理者必須)
    if (data.action === "upload_independent_document") {
      if (!verifyAdminAccess_(data, propService)) {
        return jsonResponse({
          success: false,
          error_code: "UNAUTHORIZED_ADMIN_ACCESS",
          message: "Admin authentication required to upload independent document"
        });
      }
      return handleUploadIndependentDocument(data, opts);
    }

    // Drive原本書類の移動 (管理者必須)
    if (data.action === "move_drive_file") {
      if (!verifyDocumentAdminAccess_(data, propService)) {
        return jsonResponse({
          success: false,
          error_code: "UNAUTHORIZED_ADMIN_ACCESS",
          message: "Admin authentication required to move drive file"
        });
      }
      return handleMoveDriveFile(data, opts);
    }

    // Drive原本書類の取得 (Base64取得・管理者必須)
    if (data.action === "get_drive_file_content") {
      if (!verifyDocumentAdminAccess_(data, propService)) {
        return jsonResponse({
          success: false,
          error_code: "UNAUTHORIZED_ADMIN_ACCESS",
          message: "Admin authentication required to get drive file content"
        });
      }
      return handleGetDriveFileContent(data, opts);
    }

    if (
      Object.prototype.hasOwnProperty.call(
        data,
        "action"
      )
    ) {
      throw new Error("invalid action");
    }

    // ------------------------------------------
    // 5. actionなし = 新規商品登録
    //    import_attempt_id があれば新インポートロジック、なければ従来ロジック
    // ------------------------------------------
    if (data && data.import_attempt_id) {
      return handleImportProductByImages(sheet, data);
    }

    return handleCreateProduct(sheet, data);


  } catch (error) {

    console.error("doPost error:", error);

    const errorMessage = error && error.message ? error.message : String(error);
    const safeErrorMessage = errorMessage
      .replace(/sq0atp-[A-Za-z0-9_-]+/g, "[REDACTED]")
      .replace(/Bearer\s+[A-Za-z0-9_-]+/g, "Bearer [REDACTED]");

    const errorResponse = {
      success: false,
      version: "product-api-v1",
      error: safeErrorMessage,
      message: safeErrorMessage
    };

    if (error && (error.error_code || error.errorCode)) {
      errorResponse.error_code = error.error_code || error.errorCode;
    }

    if (requestedAction) {
      errorResponse.action = requestedAction;
    }

    return jsonResponse(errorResponse);

  } finally {

    try {
      lock.releaseLock();
    } catch (_) {}
  }
}


// ==================================================
// 公開状態変更
// ==================================================

function handleUpdatePublishStatus(sheet, data, options) {
  const productId =
    String(data.product_id || "").trim();

  const publishStatus =
    String(data.publish_status || "").trim();

  const allowedStatuses = [
    "draft",
    "published",
    "hidden"
  ];

  if (!productId) {
    throw new Error("product_id is required");
  }

  if (!allowedStatuses.includes(publishStatus)) {
    throw new Error("invalid publish_status");
  }

  const opts = Object.assign({}, options, { sheet: sheet });

  const targetRow =
    findProductRow(sheet, productId);

  const row = sheet
    .getRange(targetRow, 1, 1, 38)
    .getValues()[0];

  const currentInventoryStatus = String(row[32] || "in_stock").trim();
  const currentRecordStatus = String(row[33] || "active").trim();
  const squareVariationId = String(row[35] || "").trim();
  const paymentLinkId = String(row[36] || "").trim();
  const checkoutUrl = String(row[37] || "").trim();

  if (publishStatus === "draft" || publishStatus === "hidden") {
    // 1. Square側を安全化（在庫0、Payment Link無効化）を先に行う
    if (squareVariationId) {
      syncSquareProductionProductInventory(productId, 0, opts);
    }
    if (paymentLinkId || checkoutUrl) {
      invalidateSquareProductionPaymentLink(productId, opts);
    }

    // 2. Square側が成功した後のみ BIS 状態を更新
    sheet
      .getRange(targetRow, 32)
      .setValue(publishStatus);
  } else {
    // publishStatus === "published" への復帰 (AIドラフト未確認・内容不一致時はFail-Closedで例外拒否)
    if (currentRecordStatus === "archived") {
      throw new Error("cannot publish archived product: " + productId);
    }

    assertProductPublishable_(sheet, targetRow, productId);

    // 1. Square連携がある場合、Square側の在庫1化を先行して完了させる (Fail-Closed)
    //    Square側が成功して初めてBIS本票を published に更新する
    if (
      currentRecordStatus === "active" &&
      currentInventoryStatus === "in_stock" &&
      squareVariationId
    ) {
      syncSquareProductionProductInventory(productId, 1, Object.assign({}, opts, { allowingPublish: true }));
    }

    // 2. Square側が成功した後のみ BIS 状態を published へ更新
    try {
      sheet
        .getRange(targetRow, 32)
        .setValue("published");
    } catch (sheetErr) {
      // 万一本票更新に失敗した場合は即座にSquare在庫を0へロールバック (Fail-Closed)
      if (squareVariationId) {
        try {
          syncSquareProductionProductInventory(productId, 0, opts);
        } catch (_) {}
      }
      throw sheetErr;
    }
  }

  clearProductCache_(productId);

  return jsonResponse({
    success: true,
    version: "publish-status-update-v1",
    product_id: productId,
    publish_status: publishStatus
  });
}


// ==================================================
// 在庫状態変更
// ==================================================

function updateProductInventoryStatusOnSheet(
  sheet,
  targetRow,
  inventoryStatus
) {
  const allowedStatuses = [
    "in_stock",
    "reserved",
    "sold"
  ];

  if (!allowedStatuses.includes(inventoryStatus)) {
    throw new Error("invalid inventory_status");
  }

  // AG列 = 33列目
  sheet
    .getRange(targetRow, 33)
    .setValue(inventoryStatus);
}

function handleUpdateInventoryStatus(sheet, data) {
  const productId =
    String(data.product_id || "").trim();

  const inventoryStatus =
    String(data.inventory_status || "").trim();

  const allowedStatuses = [
    "in_stock",
    "reserved",
    "sold"
  ];

  if (!productId) {
    throw new Error("product_id is required");
  }

  if (!allowedStatuses.includes(inventoryStatus)) {
    throw new Error("invalid inventory_status");
  }

  const targetRow =
    findProductRow(sheet, productId);

  const row = sheet
    .getRange(targetRow, 1, 1, 38)
    .getValues()[0];

  const currentPublishStatus = String(row[31] || "draft").trim();
  const currentRecordStatus = String(row[33] || "active").trim();
  const squareVariationId = String(row[35] || "").trim();
  const paymentLinkId = String(row[36] || "").trim();
  const checkoutUrl = String(row[37] || "").trim();

  if (inventoryStatus === "sold") {
    // 1. Square側を安全化（在庫0、Payment Link無効化）を先に行う
    if (squareVariationId) {
      syncSquareProductionProductInventory(productId, 0);
    }
    if (paymentLinkId || checkoutUrl) {
      invalidateSquareProductionPaymentLink(productId);
    }

    // 2. Square側が成功した後のみ BIS 状態を更新
    updateProductInventoryStatusOnSheet(
      sheet,
      targetRow,
      "sold"
    );
  } else if (inventoryStatus === "reserved") {
    // reserved は一時状態: 在庫0、Payment Linkは削除しない
    if (squareVariationId) {
      syncSquareProductionProductInventory(productId, 0);
    }

    // Square側が成功した後のみ BIS 状態を更新
    updateProductInventoryStatusOnSheet(
      sheet,
      targetRow,
      "reserved"
    );
  } else {
    // inventoryStatus === "in_stock" への復帰
    updateProductInventoryStatusOnSheet(
      sheet,
      targetRow,
      "in_stock"
    );

    // 販売可能3条件 (active + published + in_stock) が揃っていれば在庫を1へ戻す
    if (
      currentRecordStatus === "active" &&
      currentPublishStatus === "published" &&
      squareVariationId
    ) {
      assertProductPublishable_(sheet, targetRow, productId);
      syncSquareProductionProductInventory(productId, 1);
    }
  }

  clearProductCache_(productId);

  return jsonResponse({
    success: true,
    version: "inventory-status-update-v1",
    product_id: productId,
    inventory_status: inventoryStatus
  });
}

// ==================================================
// レコード状態変更
// active / archived
// ==================================================

function handleUpdateRecordStatus(sheet, data, options) {
  const productId =
    String(data.product_id || "").trim();

  const recordStatus =
    String(data.record_status || "").trim();

  const allowedStatuses = [
    "active",
    "archived"
  ];

  if (!productId) {
    throw new Error("product_id is required");
  }

  if (!allowedStatuses.includes(recordStatus)) {
    throw new Error("invalid record_status");
  }

  const opts = Object.assign({}, options, { sheet: sheet });

  const targetRow =
    findProductRow(sheet, productId);

  const row = sheet
    .getRange(targetRow, 1, 1, 39)
    .getValues()[0];

  const currentPublishStatus = String(row[31] || "draft").trim();
  const currentInventoryStatus = String(row[32] || "in_stock").trim();
  const currentRecordStatus = String(row[33] || "active").trim();
  const squareItemId = String(row[34] || "").trim();
  const squareVariationId = String(row[35] || "").trim();
  const paymentLinkId = String(row[36] || "").trim();
  const checkoutUrl = String(row[37] || "").trim();

  if (recordStatus === "archived") {
    // 多重防御でSquare側を安全化（すべて完了後にBISを更新）
    // 1. Square inventory = 0
    if (squareVariationId) {
      syncSquareProductionProductInventory(productId, 0, opts);
    }
    // 2. Payment Link DELETE
    if (paymentLinkId || checkoutUrl) {
      invalidateSquareProductionPaymentLink(productId, opts);
    }
    // 3. Square Catalog Item archive (item_data.is_archived = true)
    if (squareItemId) {
      archiveSquareProductionProduct(productId, opts);
    }

    // 4. すべて成功後のみ BIS record_status = archived
    sheet
      .getRange(targetRow, 34)
      .setValue("archived");
  } else {
    // recordStatus === "active" への復帰
    // 安全方針:
    // - Square商品は自動unarchiveしない (アーカイブ状態維持)
    // - Square在庫は自動で1へ戻さない (0のまま維持)
    // - Payment Linkは自動再生成しない (無効のまま維持)
    // - 公開状態は自動再開せず draft に固定 (販売・公開の誤再開を防止)
    // - inventory_status は勝手に in_stock に変更せず、sold/reserved等の既存値を保持
    //
    // 更新順序（フェイルクローズ設計）:
    // 万一書き込み途中で例外やネットワーク切断が発生しても
    // 「BISは active + published の販売可能状態なのに Square が停止中」という
    // 不整合が絶対に生じないよう、record_status (34列目) より先に
    // publish_status (32列目) を "draft" へ書き換える。
    // archived から active への復帰時のみ、公開状態を安全のため draft に固定する。
    // 既に active + published で販売再開済みの商品への再送・再実行時は、
    // 意図しない下書き化を防ぐため publish_status を変更しない。
    if (currentRecordStatus === "archived") {
      sheet
        .getRange(targetRow, 32)
        .setValue("draft");
    }

    // BIS record_status = active
    sheet
      .getRange(targetRow, 34)
      .setValue("active");
  }

  clearProductCache_(productId);

  const finalPublishStatus = currentRecordStatus === "archived"
    ? "draft"
    : currentPublishStatus;

  return jsonResponse({
    success: true,
    version: "record-status-update-v1",
    product_id: productId,
    record_status: recordStatus,
    publish_status: finalPublishStatus
  });
}


// ==================================================
// Square Sandbox アクション無効化ガード (本番MVP用)
// ==================================================



// ==================================================
// Square Sandbox商品作成API
// ==================================================



// ==================================================
// Square Sandbox商品更新API
// ==================================================



// ==================================================
// Square Sandboxメイン画像同期API
// ==================================================



// ==================================================
// Square Sandbox在庫同期API
// ==================================================



// ==================================================
// Square Production 商品作成API
// ==================================================

function handleCreateSquareProductionProduct(sheet, data) {
  const productId = String(data.product_id || "").trim();

  if (!productId) {
    throw new Error("product_id is required");
  }

  const result = createSquareProductionProduct(productId);

  return jsonResponse({
    success: true,
    action: "create_square_production_product",
    product_id: result.product_id,
    square_item_id: result.square_item_id,
    square_variation_id: result.square_variation_id,
    product_name: result.product_name,
    price_amount: result.price_amount,
    currency: result.currency
  });
}


// ==================================================
// Square Production メイン画像同期API
// ==================================================

function handleSyncSquareProductionImage(sheet, data) {
  const productId = String(data.product_id || "").trim();

  if (!productId) {
    throw new Error("product_id is required");
  }

  const result = syncSquareProductionProductMainImage(productId);

  return jsonResponse({
    success: true,
    action: "sync_square_production_image",
    product_id: result.product_id,
    square_item_id: result.square_item_id,
    image_id: result.image_id,
    image_url: result.image_url
  });
}


// ==================================================
// Square Production 在庫同期API
// ==================================================

function handleSyncSquareProductionInventory(sheet, data, options) {
  const productId = String(data.product_id || "").trim();

  if (!productId) {
    throw new Error("product_id is required");
  }

  let quantity;
  if (
    data.quantity !== undefined &&
    data.quantity !== null &&
    String(data.quantity).trim() !== ""
  ) {
    if (typeof data.quantity === "boolean") {
      throw new Error("quantity must be integer 0 or 1, got boolean: " + data.quantity);
    }
    const rawQuantity = Number(data.quantity);
    if (!Number.isInteger(rawQuantity) || (rawQuantity !== 0 && rawQuantity !== 1)) {
      throw new Error("quantity must be integer 0 or 1, got: " + data.quantity);
    }
    quantity = rawQuantity;
  } else {
    // フロントからの指定がない場合、商品マスターの在庫状態から安全に決定
    // 販売可能3条件 (active + published + in_stock) が揃っている場合のみ 1、それ以外 (record_status !== "active", draft, sold, reserved 等) は必ず 0
    const targetRow = findProductRow(sheet, productId);
    const row = sheet.getRange(targetRow, 1, 1, 34).getValues()[0];
    const publishStatus = String(row[31] || "draft").trim();
    const inventoryStatus = String(row[32] || "in_stock").trim();
    const recordStatus = String(row[33] || "active").trim();

    if (
      recordStatus === "active" &&
      publishStatus === "published" &&
      inventoryStatus === "in_stock"
    ) {
      quantity = 1;
    } else {
      quantity = 0;
    }
  }

  const opts = Object.assign({}, options, { sheet: sheet });
  const result = syncSquareProductionProductInventory(productId, quantity, opts);

  return jsonResponse({
    success: true,
    action: "sync_square_production_inventory",
    product_id: result.product_id,
    square_item_id: result.square_item_id,
    square_variation_id: result.square_variation_id,
    location_id: result.location_id,
    quantity: result.quantity
  });
}


// ==================================================
// Square Production 商品詳細同期API (商品名・説明文・サイズ/状態)
// ==================================================

function handleSyncSquareProductionDetails(sheet, data, options) {
  const productId = String(data.product_id || "").trim();

  if (!productId) {
    throw new Error("product_id is required");
  }

  const opts = Object.assign({}, options, { sheet: sheet });
  const result = syncSquareProductionProductDetails(productId, opts);

  return jsonResponse({
    success: true,
    version: "square-production-details-sync-v1",
    product_id: productId,
    square_item_id: result.square_item_id,
    square_variation_id: result.square_variation_id,
    item_name: result.item_name,
    variation_name: result.variation_name,
    version: result.version
  });
}


// ==================================================
// Square Production 商品アーカイブ復帰API (明示的再連携用)
// ==================================================

function handleUnarchiveSquareProductionProduct(sheet, data, options) {
  const productId = String(data.product_id || "").trim();

  if (!productId) {
    throw new Error("product_id is required");
  }

  const opts = Object.assign({}, options, { sheet: sheet });
  const result = unarchiveSquareProductionProduct(productId, opts);

  return jsonResponse({
    success: true,
    action: "unarchive_square_production_product",
    product_id: result.product_id,
    square_item_id: result.square_item_id,
    already_active: result.already_active || false,
    version: result.version
  });
}


// ==================================================
// Square Production Payment Link 生成API
// ==================================================

function handleCreateSquarePaymentLink(sheet, data, options) {
  const productId = String(data.product_id || "").trim();

  if (!productId) {
    return jsonResponse({
      success: false,
      action: "create_square_payment_link",
      error: "product_id is required",
      error_code: "PRODUCT_ID_REQUIRED",
      error_phase: "precondition",
      status: "payment_link_precondition_failed",
      pos_sales_enabled: "unknown",
      square_inventory: "unknown",
      square_catalog_unarchived: "unknown",
      square_payment_link_created: false,
      message: "事前検証に失敗しました: product_id is required"
    });
  }

  const opts = Object.assign({}, options, {
    sheet: sheet,
    rollbackOnFailure: Boolean(data.rollback_on_failure || (options && options.rollbackOnFailure))
  });

  try {
    const result = createSquareProductionPaymentLink(productId, opts);

    return jsonResponse({
      success: true,
      action: "create_square_payment_link",
      product_id: result.product_id,
      square_payment_link_id: result.square_payment_link_id,
      square_checkout_url: result.square_checkout_url,
      already_exists: result.already_exists || false
    });
  } catch (err) {
    const errorPhase = err.error_phase || "unknown";

    // 1. 事前検証エラーの場合 (Square API 未実行・外部状態は未確認)
    if (errorPhase === "precondition") {
      return jsonResponse({
        success: false,
        action: "create_square_payment_link",
        product_id: productId,
        error: err.message,
        error_code: err.error_code || "PRECONDITION_FAILED",
        error_phase: "precondition",
        status: "payment_link_precondition_failed",
        square_catalog_unarchived: "unknown",
        square_inventory: "unknown",
        pos_sales_enabled: "unknown",
        square_payment_link_created: false,
        retry_recommendation: "check_product_and_publish_status",
        message: "事前検証に失敗したため決済リンク生成を中止しました（Square APIは未実行）: " + err.message
      });
    }

    // 2. Square API 成功後の本票保存失敗 (Square側リンク作成済み・BIS本票未紐付け)
    if (errorPhase === "sheet_save") {
      return jsonResponse({
        success: false,
        action: "create_square_payment_link",
        product_id: productId,
        error: err.message,
        error_code: err.error_code || "PAYMENT_LINK_SHEET_SAVE_FAILED",
        error_phase: "sheet_save",
        status: "payment_link_sheet_save_failed",
        square_catalog_unarchived: "unknown",
        square_inventory: "unknown",
        pos_sales_enabled: "unknown",
        square_payment_link_created: true,
        square_payment_link_id: err.square_payment_link_id || null,
        square_checkout_url: err.square_checkout_url || null,
        square_payment_link_generation: err.square_payment_link_generation || null,
        retry_recommendation: "create_square_payment_link",
        message: "Square側で決済リンクは正常に生成されましたが（ID: " +
          (err.square_payment_link_id || "不明") +
          "）、BIS本票への保存に失敗しました（Square側作成済み・未紐付け状態）。同一世代の冪等性キーで再試行（create_square_payment_link）することで安全に本票へ紐付けられます。"
      });
    }

    // 3. Square API 呼出中・呼出後のエラー
    // リンクが確実に未生成と断定できるか？ (4xx拒絶のみ true、5xx/タイムアウト/パースエラー等は未確定)
    const linkDefinitiveNotCreated = (err.square_link_definitive_not_created === true);
    const linkCreatedState = linkDefinitiveNotCreated ? false : "unknown";

    if (opts.rollbackOnFailure) {
      let rollbackOk = false;
      let rollbackErr = null;
      try {
        syncSquareProductionProductInventory(productId, 0, opts);
        rollbackOk = true;
      } catch (rbErr) {
        rollbackErr = rbErr;
      }

      if (rollbackOk) {
        return jsonResponse({
          success: false,
          action: "create_square_payment_link",
          product_id: productId,
          error: err.message,
          error_phase: errorPhase,
          status: "pending_retry_inventory_reverted_to_zero",
          square_catalog_unarchived: "unknown",
          square_inventory: 0,
          pos_sales_enabled: false,
          square_payment_link_created: linkCreatedState,
          rollback_status: "success",
          retry_recommendation: "create_square_payment_link",
          message: "Square決済リンク生成に失敗したため、安全確保のためSquare在庫を0にロールバックしました（再試行待ち）。"
        });
      } else {
        return jsonResponse({
          success: false,
          action: "create_square_payment_link",
          product_id: productId,
          error: err.message,
          error_phase: errorPhase,
          rollback_error: rollbackErr ? rollbackErr.message : "unknown rollback failure",
          status: "rollback_failed_square_inventory_unknown",
          square_catalog_unarchived: "unknown",
          square_inventory: "unknown",
          pos_sales_enabled: "unknown",
          square_payment_link_created: linkCreatedState,
          rollback_status: "failed",
          retry_recommendation: "reconcile_square_product_status",
          message: "Square決済リンク生成に失敗し、さらにSquare在庫の0ロールバックにも失敗しました。店頭POSで販売可能な可能性があるため要確認です。reconcile_square_product_status または Square管理画面で在庫を確認してください。"
        });
      }
    }

    // 4. ロールバック指定なし（通常失敗）:
    // Square API エラー時、外部の在庫・Catalog状態は取得確認していないため unknown
    // リンク作成状態: 4xx拒絶なら false、タイムアウト/5xx等は作成済みの可能性を考慮し unknown
    const linkStatusDesc = linkDefinitiveNotCreated
      ? "（Square側でリンクは拒絶・未生成です）"
      : "（Square側でリンクが作成済みの可能性がありますが未紐付けです）";

    return jsonResponse({
      success: false,
      action: "create_square_payment_link",
      product_id: productId,
      error: err.message,
      error_phase: errorPhase,
      status: linkDefinitiveNotCreated
        ? "payment_link_create_failed_rejected"
        : "payment_link_create_failed_unconfirmed",
      square_catalog_unarchived: "unknown",
      square_inventory: "unknown",
      pos_sales_enabled: "unknown",
      square_payment_link_created: linkCreatedState,
      retry_recommendation: "reconcile_square_product_status",
      message: "Square決済リンク生成に失敗しました" + linkStatusDesc + "。外部の在庫・カタログ状態が未確定のため、reconcile_square_product_status で状態を確認してください。"
    });
  }
}


// ==================================================
// LLM翻訳生成API
// ==================================================

function handleGenerateTranslation(sheet, data) {
  const productId =
    String(data.product_id || "").trim();

  if (!productId) {
    throw new Error("product_id is required");
  }

  const targetRow =
    findProductRow(sheet, productId);

  const row =
    sheet
      .getRange(
        targetRow,
        1,
        1,
        sheet.getLastColumn()
      )
      .getValues()[0];

  const productData =
    buildProductDetail(row);

  const result =
    generateAndSaveProductTranslation(productData);

  return jsonResponse({
    success: true,
    version: "product-translation-generate-v1",
    product_id: productId,
    translation: result.translation,
    save_result: result.save_result
  });
}


// ==================================================
// LLM翻訳ステータス承認API
// ==================================================

function handleApproveTranslation(sheet, data) {
  const productId =
    String(data.product_id || "").trim();

  if (!productId) {
    throw new Error("product_id is required");
  }

  const result =
    approveProductTranslation(productId);

  return jsonResponse({
    success: true,
    version: "product-translation-approve-v1",
    product_id: productId,
    translation_status: result.translation_status,
    updated_row: result.updated_row
  });
}


// ==================================================
// 商品完全削除
// archived の商品のみ削除可能
// ==================================================

function handleDeleteProduct(sheet, data) {
  const productId =
    String(data.product_id || "").trim();

  if (!productId) {
    throw new Error("product_id is required");
  }

  const targetRow =
    findProductRow(sheet, productId);

  // AH列 = 34列目
  const recordStatus = String(
    sheet
      .getRange(targetRow, 34)
      .getValue() || ""
  ).trim();

  if (recordStatus !== "archived") {
    throw new Error(
      "product must be archived before deletion"
    );
  }

  // 1. Square Production 側の安全化とリソース完全削除 (Square連携済み商品の場合)
  // 行削除およびDrive移動より前に実行し、失敗時はBISを削除しない (Fail-closed)
  const row = sheet
    .getRange(targetRow, 1, 1, 39)
    .getValues()[0];

  const squareItemId = String(row[34] || "").trim();
  const squareVariationId = String(row[35] || "").trim();
  const paymentLinkId = String(row[36] || "").trim();
  const checkoutUrl = String(row[37] || "").trim();

  if (squareItemId) {
    // 1-1. Square inventory = 0 (失敗時は即停止)
    if (squareVariationId) {
      syncSquareProductionProductInventory(productId, 0);
    }

    // 1-2. Payment Link DELETE (失敗時は即停止)
    if (paymentLinkId || checkoutUrl) {
      invalidateSquareProductionPaymentLink(productId);
    }

    // 1-3. Square Catalog Item DELETE (カスケード削除、失敗時は即停止)
    // 監査性・追跡性を維持するため、BIS行削除前にSquare ID列はクリアしない
    deleteSquareProductionProduct(productId);
  }

  // 2. Drive フォルダのゴミ箱移動
  // AD列 = 30列目
  const folderUrl = String(
    sheet
      .getRange(targetRow, 30)
      .getValue() || ""
  ).trim();

  let productFolder = null;
  let folderMovedToTrash = false;

  if (folderUrl) {
    const folderId =
      extractDriveFolderId(folderUrl);

    if (!folderId) {
      throw new Error(
        "invalid product Drive folder URL"
      );
    }

    productFolder =
      DriveApp.getFolderById(folderId);

    const parents =
      productFolder.getParents();

    let isInRootFolder = false;

    while (parents.hasNext()) {
      if (
        parents.next().getId() ===
        ROOT_FOLDER_ID
      ) {
        isInRootFolder = true;
        break;
      }
    }

    if (!isInRootFolder) {
      throw new Error(
        "product Drive folder is outside root folder"
      );
    }

    if (productFolder.getName() !== productId) {
      throw new Error(
        "product Drive folder does not match product_id"
      );
    }

    if (!productFolder.isTrashed()) {
      productFolder.setTrashed(true);
      folderMovedToTrash = true;
    }
  }

  try {
    sheet.deleteRow(targetRow);
    clearProductCache_(productId);
  } catch (deleteError) {
    if (
      productFolder &&
      folderMovedToTrash
    ) {
      try {
        productFolder.setTrashed(false);
      } catch (restoreError) {
        console.error(
          "Drive folder restore error:",
          restoreError
        );

        throw new Error(
          "failed to delete product row and " +
          "restore Drive folder: " +
          String(deleteError) +
          "; restore error: " +
          String(restoreError)
        );
      }
    }

    throw deleteError;
  }

  return jsonResponse({
    success: true,
    version: "product-delete-v1",
    product_id: productId,
    deleted: true
  });
}


// ==================================================
// 商品情報変更
// ==================================================
// 下書き商品の英語タイトル (translated_title) を product_translations シートに保存
// 既存の説明文・状態・ステータスを維持した上でキャッシュをクリア
// ==================================================

function updateProductTranslatedTitle_(productId, newTitle) {
  const normId = String(productId || "").trim();
  const title = String(newTitle || "").trim();

  if (!normId) {
    throw new Error("product_id is required");
  }
  if (!title) {
    const err = new Error("translated_title cannot be empty");
    err.error_code = "TRANSLATED_TITLE_REQUIRED";
    throw err;
  }

  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) {
    throw new Error("Active spreadsheet not found");
  }

  let transSheet = spreadsheet.getSheetByName("product_translations");
  if (!transSheet) {
    if (typeof getOrCreateProductTranslationsSheet_ === "function") {
      transSheet = getOrCreateProductTranslationsSheet_();
    } else {
      throw new Error("product_translations sheet not found");
    }
  }

  const lastRow = transSheet.getLastRow();
  const lastCol = transSheet.getLastColumn();

  let targetRowIndex = -1;
  let titleColIdx = -1;
  let generatedAtColIdx = -1;

  if (lastRow >= 2 && lastCol >= 1) {
    const headers = transSheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h || "").trim());
    const pIdIdx = headers.indexOf("product_id");
    const localeIdx = headers.indexOf("locale");
    titleColIdx = headers.indexOf("translated_title");
    generatedAtColIdx = headers.indexOf("generated_at");

    if (pIdIdx !== -1) {
      const rows = transSheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
      for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i];
        if (
          String(row[pIdIdx] || "").trim() === normId &&
          (localeIdx === -1 || String(row[localeIdx] || "en").trim() === "en")
        ) {
          targetRowIndex = i + 2; // 1-based sheet row number
          break;
        }
      }
    }
  }

  if (targetRowIndex !== -1 && titleColIdx !== -1) {
    // 既存行が存在する場合: translated_title のみ上書き更新（説明文・状態・承認ステータス等は一切消さず維持）
    transSheet.getRange(targetRowIndex, titleColIdx + 1).setValue(title);
    if (generatedAtColIdx !== -1) {
      transSheet.getRange(targetRowIndex, generatedAtColIdx + 1).setValue(new Date().toISOString());
    }
    console.log(`[Product Update] Updated translated_title for ${normId} at row ${targetRowIndex}`);
  } else {
    // 既存レコードが存在しない場合: 新規レコードを作成
    const colCount = Math.max(lastCol, 9);
    let headers = [];
    if (colCount >= 1 && transSheet.getLastRow() >= 1) {
      headers = transSheet.getRange(1, 1, 1, colCount).getValues()[0].map(h => String(h || "").trim());
    }
    if (headers.length === 0 || headers.indexOf("product_id") === -1) {
      headers = ["product_id", "locale", "translated_title", "translated_description", "translated_condition", "translated_box", "translated_accessories", "translation_status", "generated_at"];
    }
    const newRow = headers.map(h => {
      if (h === "product_id") return normId;
      if (h === "locale") return "en";
      if (h === "translated_title") return title;
      if (h === "translation_status") return "approved";
      if (h === "generated_at") return new Date().toISOString();
      return "";
    });
    transSheet.appendRow(newRow);
    console.log(`[Product Update] Created new translated_title record for ${normId}`);
  }

  // 翻訳キャッシュを即時クリア (詳細APIがシートの最新値を読むようにする)
  try {
    CacheService.getScriptCache().remove("prod_trans_" + normId);
  } catch (cErr) {
    console.warn("Failed to clear translation cache:", cErr);
  }

  return { success: true, product_id: normId, translated_title: title };
}

function handleUpdateProduct(sheet, data) {
  const productId =
    String(data.product_id || "").trim();

  if (!productId) {
    throw new Error("product_id is required");
  }

  const targetRow =
    findProductRow(sheet, productId);

  // AI対象 published商品の確認対象項目編集を拒否
  const productRowValues = sheet.getRange(targetRow, 1, 1, Math.max(sheet.getLastColumn(), 40)).getValues()[0];
  const currentPublishStatus = String(productRowValues[31] || "draft").trim();
  const currentAiDraftFlag = String(productRowValues[39] || "").trim();

  if (currentAiDraftFlag === "ai_managed" && currentPublishStatus === "published") {
    const editErr = new Error(
      "[AI Draft] Editing AI managed product while published is not allowed: " + productId
    );
    editErr.error_code = "PUBLISHED_AI_PRODUCT_EDIT_BLOCKED";
    throw editErr;
  }

  const currentCategory =
    String(sheet.getRange(targetRow, 3).getValue() || "").trim();

  // シート列数事前チェック
  assertProductSheetColumnCount_(sheet);

  // ==========================================
  // 【フェーズ1: 入力値の事前検証 (Pre-Validation)】
  // シート書き込みや外部連携を行う前に全入力値を検証し、不正があれば即座に拒絶する。
  // ==========================================

  // 1-1. translated_title (英語タイトル) の事前検証
  let shouldUpdateTranslatedTitle = false;
  let validatedTranslatedTitle = "";
  if (
    Object.prototype.hasOwnProperty.call(data, "translated_title") &&
    data.translated_title !== undefined
  ) {
    if (currentPublishStatus !== "draft") {
      const draftErr = new Error("translated_title can only be updated for draft products");
      draftErr.error_code = "TRANSLATED_TITLE_DRAFT_ONLY";
      throw draftErr;
    }

    validatedTranslatedTitle = String(data.translated_title || "").trim();
    if (!validatedTranslatedTitle) {
      const emptyErr = new Error("translated_title cannot be empty");
      emptyErr.error_code = "TRANSLATED_TITLE_REQUIRED";
      throw emptyErr;
    }
    shouldUpdateTranslatedTitle = true;
  }

  // 1-2. Category変更禁止チェック (MVP)
  if (
    Object.prototype.hasOwnProperty.call(data, "category") &&
    data.category !== undefined &&
    data.category !== null
  ) {
    const incomingCategory =
      String(data.category || "").trim();

    if (incomingCategory !== currentCategory) {
      throw new Error(
        "product category cannot be changed after creation"
      );
    }
  }

  // 1-3. planned_sale_price の事前検証
  let shouldUpdatePrice = false;
  let validatedNewPrice = 0;
  if (
    Object.prototype.hasOwnProperty.call(data, "planned_sale_price") &&
    data.planned_sale_price !== undefined &&
    data.planned_sale_price !== null &&
    String(data.planned_sale_price).trim() !== ""
  ) {
    validatedNewPrice = Number(data.planned_sale_price);

    if (!Number.isSafeInteger(validatedNewPrice) || validatedNewPrice <= 0) {
      throw new Error("planned_sale_price must be a positive integer");
    }
    shouldUpdatePrice = true;
  }

  // 1-4. Pokemon Card 更新チェック
  const hasPokemonCardPayload =
    Object.prototype.hasOwnProperty.call(data, "pokemon_card") &&
    data.pokemon_card !== undefined;

  let pokemonCardUpdate = null;
  if (hasPokemonCardPayload) {
    if (
      !data.pokemon_card ||
      typeof data.pokemon_card !== "object" ||
      Array.isArray(data.pokemon_card)
    ) {
      throw new Error("invalid pokemon_card data");
    }
    pokemonCardUpdate = Object.assign({}, data.pokemon_card);
  }

  // トップレベルで card_condition が渡された場合、または condition に A/B/C が渡された場合の互換サポート
  if (currentCategory === "pokemon_card") {
    let topCardCondition = "";
    if (Object.prototype.hasOwnProperty.call(data, "card_condition") && data.card_condition !== undefined && data.card_condition !== null) {
      topCardCondition = String(data.card_condition).trim();
    } else if (Object.prototype.hasOwnProperty.call(data, "condition") && data.condition !== undefined && data.condition !== null) {
      const condVal = String(data.condition).trim().toUpperCase();
      if (["A", "B", "C"].includes(condVal)) {
        topCardCondition = condVal;
      }
    }

    if (topCardCondition) {
      if (!pokemonCardUpdate) {
        pokemonCardUpdate = {};
      }
      if (!pokemonCardUpdate.card_condition) {
        pokemonCardUpdate.card_condition = topCardCondition;
      }
    }
  }

  // 1-5. AI解析用選択画像ID (selected_image_ids / ai_selected_image_ids) の事前検証
  let shouldUpdateSelectedImageIds = false;
  let validatedSelectedImageIds = [];
  const hasSelectedIdsInUpdate =
    (Object.prototype.hasOwnProperty.call(data, "selected_image_ids") && data.selected_image_ids !== undefined) ||
    (Object.prototype.hasOwnProperty.call(data, "ai_selected_image_ids") && data.ai_selected_image_ids !== undefined);
  if (hasSelectedIdsInUpdate) {
    const rawSel = data.selected_image_ids !== undefined ? data.selected_image_ids : data.ai_selected_image_ids;
    const effectiveSel = rawSel === null ? [] : rawSel;
    validatedSelectedImageIds = validateSelectedImageIdsSyntax_(effectiveSel, productId);
    if (validatedSelectedImageIds.length > 0) {
      const driveFolderUrlForSel = String(productRowValues[29] || "").trim();
      getValidatedProductDriveImages_(productId, driveFolderUrlForSel, validatedSelectedImageIds, {
        metadata_only: true
      });
    }
    shouldUpdateSelectedImageIds = true;
  }

  // 1-6. 仕入台帳のオークション等の商品番号 (auction_item_number) の事前検証
  // 項目自体が未送信 (キー省略 または undefined) の場合は既存値を維持し、明示指定 ("" 含む) の場合のみ更新する
  let shouldUpdateAuctionItemNumber = false;
  let validatedAuctionItemNumber = "";
  if (
    Object.prototype.hasOwnProperty.call(data, "auction_item_number") &&
    data.auction_item_number !== undefined
  ) {
    validatedAuctionItemNumber = normalizeAuctionItemNumberInput_(data.auction_item_number);
    shouldUpdateAuctionItemNumber = true;
  }

  // ==========================================
  // 【フェーズ2: 書き込み・外部同期 (Execution / Write Phase)】
  // すべての検証を通過した後にのみ実行する。
  // ==========================================

  // 2-0. AI解析用選択画像ID (selected_image_ids) 保存 (メイン画像AE列や画像順は変更しない)
  if (shouldUpdateSelectedImageIds) {
    saveProductAiSelectedImageIds_(sheet, productId, validatedSelectedImageIds, {
      skipDriveValidation: true
    });
  }

  // 2-1. translated_title (英語タイトル) 保存
  if (shouldUpdateTranslatedTitle) {
    updateProductTranslatedTitle_(productId, validatedTranslatedTitle);
  }

  // 2-2. Pokemon Card 保存
  if (
    currentCategory === "pokemon_card" &&
    pokemonCardUpdate !== null
  ) {
    savePokemonCardByProductId(
      productId,
      pokemonCardUpdate
    );
  }

  let paymentLinkError = "";
  let paymentLinkCreated = false;

  // ------------------------------------------
  // 更新を許可する項目
  // 値 = Google Sheets上の列番号
  // ------------------------------------------

  const fieldMap = {
    category: 3,                 // C
    brand: 4,                    // D
    product_name: 5,             // E
    condition: 6,                // F
    purchase_price: 7,           // G
    planned_sale_price: 8,       // H
    storage_location: 9,         // I
    description: 10,             // J
    notes: 11,                   // K

    sneaker_sku: 12,             // L
    sneaker_size: 13,            // M
    sneaker_colorway: 14,        // N
    sneaker_box: 15,             // O
    sneaker_accessories: 16,     // P
    sneaker_release_year: 17,    // Q

    jewelry_type: 18,            // R
    jewelry_material: 19,        // S
    carat: 20,                   // T
    shape: 21,                   // U
    color_grade: 22,             // V
    clarity: 23,                 // W
    cut: 24,                     // X
    main_stone: 25,              // Y
    jewelry_size: 26,            // Z
    weight_g: 27,                // AA
    certificate_available: 28,  // AB
    certificate_number: 29,     // AC

    // 新カテゴリ属性 (41〜43列: 既存列1〜40は不変)
    subcategory: 41,             // AO
    sub_category: 41,            // AO (互換エイリアス)
    size: 42,                    // AP
    official_sku: 43,            // AQ
    sku: 43                      // AQ (互換エイリアス)
  };

  const numericFields = [
    "purchase_price",
    "planned_sale_price",
    "sneaker_size",
    "sneaker_release_year",
    "carat",
    "weight_g"
  ];

  // ------------------------------------------
  // 2-3. 価格変更時の Square Production 完全同期 (パターンB: 旧Link無効化 -> Square価格更新 -> BIS価格更新 -> 新Link生成)
  // ------------------------------------------
  if (shouldUpdatePrice) {
    const currentPrice = Number(sheet.getRange(targetRow, 8).getValue() || 0);
    const newPrice = validatedNewPrice;

    if (newPrice !== currentPrice) {
      // 対象行の Square 連携状態および販売可能状態を確認 (32〜38列)
      const statusRow = sheet
        .getRange(targetRow, 1, 1, 38)
        .getValues()[0];

      const currentPublishStatus = String(statusRow[31] || "draft").trim();
      const currentInventoryStatus = String(statusRow[32] || "in_stock").trim();
      const currentRecordStatus = String(statusRow[33] || "active").trim();
      const squareVariationId = String(statusRow[35] || "").trim();
      const existingPaymentLinkId = String(statusRow[36] || "").trim();
      const existingCheckoutUrl = String(statusRow[37] || "").trim();

      // Square 連携済み商品の場合のみ完全同期パイプラインを実行
      // Square 未連携商品（square_variation_id なし）は後続のBIS更新のみ実行
      if (squareVariationId) {
        console.log(
          "Price change detected for Square-linked product " +
          productId +
          " (" +
          currentPrice +
          " -> " +
          newPrice +
          "). Starting Square Production price sync pipeline (Pattern B)."
        );

        // 1. 旧 Payment Link 無効化 (先に行い誤価格販売の窓を遮断)
        // 失敗時は例外で停止し、Square価格もBIS価格も変更されない (Fail-closed)
        if (existingPaymentLinkId || existingCheckoutUrl) {
          invalidateSquareProductionPaymentLink(productId);
        }

        // 2. Square Catalog Variation 価格更新 (決定論的 idempotency key)
        // 失敗時は例外で停止し、BIS価格は変更されない
        updateSquareProductionProductPrice(productId, newPrice);

        // 3. BIS planned_sale_price 更新 (ここでBIS価格を先行保存して確定)
        sheet.getRange(targetRow, 8).setValue(newPrice);
        console.log(
          "BIS planned_sale_price updated to " +
          newPrice +
          " for product " +
          productId
        );

        // 4. 販売可能条件 (active + published + in_stock) の判定と新 Payment Link 再生成
        const isSellable =
          currentRecordStatus === "active" &&
          currentPublishStatus === "published" &&
          currentInventoryStatus === "in_stock";

        if (isSellable) {
          try {
            createSquareProductionPaymentLink(productId);
            paymentLinkCreated = true;
            console.log(
              "New payment link successfully created for product " +
              productId +
              " with new price " +
              newPrice
            );
          } catch (linkRegenErr) {
            paymentLinkError = true;
            console.error(
              "[ERROR] Square price and BIS price updated to " +
              newPrice +
              ", but payment link generation failed for product " +
              productId +
              ". Retaining product in recovery-waiting state (no payment link). Error: " +
              (linkRegenErr && linkRegenErr.message ? linkRegenErr.message : String(linkRegenErr)),
              linkRegenErr
            );
            // 新Link生成に失敗しても、BIS価格=新価格、Square価格=新価格、Payment Link=なし
            // を正常な「復旧待ち状態」として維持し、価格更新自体を旧価格へロールバックしない
          }
        } else {
          console.log(
            "Product " +
            productId +
            " is not in sellable state (publish: " +
            currentPublishStatus +
            ", inventory: " +
            currentInventoryStatus +
            ", record: " +
            currentRecordStatus +
            "). Skipped payment link regeneration after price update."
          );
        }
      }
    }
  }

  Object.keys(fieldMap).forEach(key => {

    // POSTされた項目だけ更新
    if (
      !Object.prototype.hasOwnProperty.call(
        data,
        key
      )
    ) {
      return;
    }

    let value = data[key];


    // null / undefined は空欄として保存
    if (
      value === null ||
      value === undefined
    ) {
      value = "";
    }

    if (key === "category" && currentCategory === "pokemon_card") {
      value = "pokemon_card";
    }

    // スニーカーカテゴリ以外の場合、スニーカー固有列への誤書き込みを遮断
    if (key.startsWith("sneaker_") && currentCategory !== "sneaker") {
      return;
    }

    // ジュエリーカテゴリ以外の場合、ジュエリー固有列への誤書き込みを遮断
    if (
      (key.startsWith("jewelry_") || ["carat", "shape", "color_grade", "clarity", "cut", "main_stone", "weight_g", "certificate_available", "certificate_number"].includes(key)) &&
      currentCategory !== "jewelry"
    ) {
      return;
    }

    // アパレル・ファッション小物カテゴリ以外の場合、41〜43列への誤書き込みを遮断
    // 既存4カテゴリ (sneaker, pokemon_card, jewelry, other) への新列書き込みを厳格に防止
    const apparelFashionKeys = ["subcategory", "sub_category", "size", "official_sku", "sku"];
    if (apparelFashionKeys.includes(key) && currentCategory !== "apparel" && currentCategory !== "fashion_goods") {
      return;
    }

    // ポケカの場合、本票F列（状態）にA/B/Cを書き込まない（F列は従来商品の日本語状態区分用）
    if (key === "condition" && currentCategory === "pokemon_card") {
      const condStr = String(value || "").trim().toUpperCase();
      if (["A", "B", "C"].includes(condStr)) {
        return;
      }
    }


    // 数値項目
    if (
      numericFields.includes(key) &&
      value !== ""
    ) {
      const numericValue = Number(value);

      if (!Number.isNaN(numericValue)) {
        value = numericValue;
      }
    }


    sheet
      .getRange(
        targetRow,
        fieldMap[key]
      )
      .setValue(value);
  });

  // 仕入台帳のオークション等の商品番号 (AR列: 44列目) 保存 (全カテゴリ対象・文字列保持・空欄許可)
  if (shouldUpdateAuctionItemNumber) {
    writeAuctionItemNumberCell_(sheet, targetRow, validatedAuctionItemNumber);
  }


  console.log(
    "Product updated:",
    productId
  );

  clearProductCache_(productId);

  // AI管理商品の指紋整合性同期:
  // 自動反映後または確定後の下書きについて、スタッフによる通常編集内容に合わせて
  // confirmed_fingerprint を安全に更新し、公開ゲートでの不要な手動再確定ブロックを防ぐ
  try {
    const flagCol = (typeof AI_DRAFT_CONFIG !== "undefined" && AI_DRAFT_CONFIG.AI_DRAFT_FLAG_COLUMN) ? AI_DRAFT_CONFIG.AI_DRAFT_FLAG_COLUMN : 40;
    if (sheet.getLastColumn() >= flagCol) {
      const aiFlag = String(sheet.getRange(targetRow, flagCol).getValue() || "").trim();
      if (aiFlag === "ai_managed" && typeof getLatestProductAiDraft_ === "function") {
        const latestDraft = getLatestProductAiDraft_(productId);
        if (latestDraft && latestDraft.review_status === "confirmed") {
          const newFp = computeConfirmedProductFingerprint_(sheet, targetRow, productId);
          if (newFp && newFp !== latestDraft.confirmed_fingerprint) {
            const draftSheet = getOrCreateProductAiDraftsSheet_();
            const draftHeaders = draftSheet.getRange(1, 1, 1, draftSheet.getLastColumn()).getValues()[0].map(h => String(h || "").trim());
            const fpIdx = draftHeaders.indexOf("confirmed_fingerprint");
            if (fpIdx !== -1) {
              draftSheet.getRange(latestDraft.row_number, fpIdx + 1).setValue(newFp);
              console.log(`[AI Draft] Synchronized confirmed_fingerprint for ${productId} after product update.`);
            }
          }
        }
      }
    }
  } catch (syncErr) {
    console.warn(`[AI Draft] Failed to sync confirmed_fingerprint after product update for ${productId}:`, syncErr.message);
  }

  const responsePayload = {
    success: true,
    version: "product-update-v1",
    product_id: productId
  };

  if (shouldUpdateSelectedImageIds) {
    responsePayload.selected_image_ids = validatedSelectedImageIds;
    responsePayload.ai_selected_image_ids = validatedSelectedImageIds;
  }

  if (shouldUpdateAuctionItemNumber) {
    responsePayload.auction_item_number = validatedAuctionItemNumber;
  }

  if (paymentLinkError) {
    responsePayload.payment_link_status = "failed";
    responsePayload.warning =
      "価格は更新されましたが、決済リンクの再生成に失敗しました。商品詳細画面の「決済リンクを生成」から再実行してください。";
    responsePayload.message = responsePayload.warning;
  } else if (paymentLinkCreated) {
    responsePayload.payment_link_status = "created";
  }

  return jsonResponse(responsePayload);
}


// ==================================================
// 商品画像変更 v2
//
// ・追加
// ・削除
// ・並び替え
// ・メイン画像変更
//
// image_order[0] がメイン画像
// ==================================================

function handleUpdateProductImages(sheet, data) {
  const productId =
    String(data.product_id || "").trim();

  if (!productId) {
    throw new Error("product_id is required");
  }


  const targetRow =
    findProductRow(sheet, productId);


  // ------------------------------------------
  // AD列から商品Driveフォルダ取得
  // ------------------------------------------

  const folderUrl = String(
    sheet
      .getRange(targetRow, 30)
      .getValue() || ""
  );


  const folderId =
    extractDriveFolderId(folderUrl);


  if (!folderId) {
    throw new Error(
      "product Drive folder not found"
    );
  }


  const productFolder =
    DriveApp.getFolderById(folderId);


  // ==================================================
  // 新規画像
  // ==================================================

  const rawNewImages =
    Array.isArray(data.new_images)
      ? data.new_images
      : [];


  const newImages =
    rawNewImages.map(
      (image, index) => ({
        ...image,

        client_id: String(
          image.client_id ||
          `legacy-new-${index}`
        )
      })
    );


  const newImageMap = {};

  newImages.forEach(image => {
    newImageMap[image.client_id] =
      image;
  });


  // ==================================================
  // 現在のDrive画像
  // ==================================================

  const existingFiles = [];
  const existingFileMap = {};
  const docFileIds = getProductDocumentFileIds_(productId);

  const iterator =
    productFolder.getFiles();


  while (iterator.hasNext()) {
    const file = iterator.next();
    if (docFileIds.has(file.getId())) continue;
    if (typeof file.isTrashed === "function" && file.isTrashed()) continue;

    if (
      file
        .getMimeType()
        .startsWith("image/")
    ) {
      existingFiles.push(file);

      existingFileMap[
        file.getId()
      ] = file;
    }
  }


  // ==================================================
  // 保存後の画像順
  // ==================================================

  let imageOrder = [];


  if (Array.isArray(data.image_order)) {

    imageOrder =
      data.image_order.map(item => ({
        source:
          String(item.source || ""),

        id:
          String(item.id || "")
      }));

  } else {

    // ------------------------------------------
    // v1フロントとの後方互換
    // ------------------------------------------

    const keepImageIds =
      Array.isArray(data.keep_image_ids)
        ? data.keep_image_ids.map(String)
        : [];


    imageOrder = [
      ...keepImageIds.map(
        fileId => ({
          source: "existing",
          id: fileId
        })
      ),

      ...newImages.map(
        image => ({
          source: "new",
          id: image.client_id
        })
      )
    ];
  }


  // ==================================================
  // 画像枚数チェック
  // ==================================================

  if (imageOrder.length > 20) {
    throw new Error(
      "maximum image count is 20"
    );
  }


  // ==================================================
  // image_order バリデーション
  // ==================================================

  const seenKeys = new Set();


  imageOrder.forEach(item => {

    if (
      item.source !== "existing" &&
      item.source !== "new"
    ) {
      throw new Error(
        "invalid image source"
      );
    }


    const key =
      `${item.source}:${item.id}`;


    if (seenKeys.has(key)) {
      throw new Error(
        "duplicate image in image_order"
      );
    }


    seenKeys.add(key);


    if (
      item.source === "existing" &&
      !existingFileMap[item.id]
    ) {
      throw new Error(
        "existing image not found: " +
        item.id
      );
    }


    if (
      item.source === "new" &&
      !newImageMap[item.id]
    ) {
      throw new Error(
        "new image not found: " +
        item.id
      );
    }
  });

  // ==================================================
  // AI解析用選択画像ID (selected_image_ids) の事前検証 (指定時のみ)
  // ==================================================
  const hasSelectedImageIdsPayload =
    (Object.prototype.hasOwnProperty.call(data, "selected_image_ids") && data.selected_image_ids !== undefined) ||
    (Object.prototype.hasOwnProperty.call(data, "ai_selected_image_ids") && data.ai_selected_image_ids !== undefined);
  let preValidatedSelectedIds = [];
  if (hasSelectedImageIdsPayload) {
    const rawSel = data.selected_image_ids !== undefined ? data.selected_image_ids : data.ai_selected_image_ids;
    const effectiveSel = rawSel === null ? [] : rawSel;
    preValidatedSelectedIds = validateSelectedImageIdsSyntax_(effectiveSel, productId);
    const activeOrderIds = new Set(imageOrder.map(it => it.id));
    for (let i = 0; i < preValidatedSelectedIds.length; i++) {
      const sId = preValidatedSelectedIds[i];
      if (!activeOrderIds.has(sId)) {
        if (existingFileMap[sId]) {
          const delErr = new Error(
            `Selected image ID '${sId}' for product ${productId} was deleted in this image update and cannot be selected.`
          );
          delErr.error_code = "SELECTED_IMAGE_DELETED";
          delErr.preserve_message = true;
          throw delErr;
        }
        const selErr = new Error(
          `Selected image ID '${sId}' does not belong to product ${productId} drive folder.`
        );
        selErr.error_code = "INVALID_IMAGE_SELECTION";
        selErr.preserve_message = true;
        throw selErr;
      }
    }
  }


  // ==================================================
  // 新規画像を先にアップロード
  // ==================================================

  const uploadedFileMap = {};
  const uploadedFiles = [];


  try {

    const referencedNewIds =
      imageOrder
        .filter(
          item =>
            item.source === "new"
        )
        .map(
          item => item.id
        );


    referencedNewIds.forEach(
      clientId => {

        const image =
          newImageMap[clientId];


        if (
          !image ||
          !image.base64
        ) {
          throw new Error(
            "invalid new image"
          );
        }


        const rawB64 =
          extractRawBase64_(
            image.base64
          );

        const bytes =
          Utilities.base64Decode(
            rawB64
          );


        const mimeType =
          image.mime_type ||
          "image/jpeg";


        const originalName =
          image.file_name ||
          "image.jpg";


        const blob =
          Utilities.newBlob(
            bytes,
            mimeType,
            originalName
          );


        const file =
          productFolder.createFile(
            blob
          );


        uploadedFiles.push(file);


        uploadedFileMap[
          clientId
        ] = file;
      }
    );

  } catch (uploadError) {

    // 今回追加した画像だけ削除
    uploadedFiles.forEach(file => {
      try {
        file.setTrashed(true);
      } catch (_) {}
    });

    throw uploadError;
  }


  // ==================================================
  // image_order順にFile[]を作る
  // ==================================================

  const orderedFiles =
    imageOrder.map(item => {

      if (item.source === "existing") {
        return existingFileMap[
          item.id
        ];
      }

      return uploadedFileMap[
        item.id
      ];
    });


  // ==================================================
  // ファイル名を再整理
  //
  // 01_main
  // 02
  // 03 ...
  // ==================================================

  orderedFiles.forEach(
    (file, index) => {

      const baseName =
        removeImagePrefix(
          file.getName()
        );


      const newName =
        index === 0

          ? `01_main_${baseName}`

          : `${String(
              index + 1
            ).padStart(
              2,
              "0"
            )}_${baseName}`;


      file.setName(newName);
    }
  );


  // ==================================================
  // 不要な既存画像を削除
  // ==================================================

  const keptExistingIds =
    new Set(
      imageOrder

        .filter(
          item =>
            item.source ===
            "existing"
        )

        .map(
          item => item.id
        )
    );


  existingFiles.forEach(file => {

    if (
      !keptExistingIds.has(
        file.getId()
      )
    ) {
      file.setTrashed(true);
    }
  });


  // ==================================================
  // AE列 = メイン画像URL更新
  // ==================================================

  const mainImageUrl =
    orderedFiles.length > 0

      ? orderedFiles[0].getUrl()

      : "";


  sheet
    .getRange(
      targetRow,
      31
    )
    .setValue(
      mainImageUrl
    );


  // ==================================================
  // 最新画像一覧をレスポンス用に作成
  // ==================================================

  const images =
    orderedFiles.map(file => ({

      file_id:
        file.getId(),

      name:
        file.getName(),

      mime_type:
        file.getMimeType(),

      view_url:
        file.getUrl(),

      display_url:
        "https://drive.google.com/thumbnail?id=" +
        file.getId() +
        "&sz=w1600"

    }));


  console.log(
    "Images updated:",
    productId,
    images.length
  );

  // AI解析用選択画像IDの保存 (リクエストで指定されている場合、新規画像のclient_idを実Drive IDへ解決して保存)
  let currentSelectedImageIds = [];
  if (hasSelectedImageIdsPayload) {
    const resolvedSelectedIds = preValidatedSelectedIds.map(sId => {
      if (uploadedFileMap[sId] && typeof uploadedFileMap[sId].getId === "function") {
        return uploadedFileMap[sId].getId();
      }
      return sId;
    });
    saveProductAiSelectedImageIds_(sheet, productId, resolvedSelectedIds, {
      skipDriveValidation: true
    });
    currentSelectedImageIds = resolvedSelectedIds;
  } else if (typeof getProductAiSelectedImageIds_ === "function") {
    currentSelectedImageIds = getProductAiSelectedImageIds_(productId);
  }

  clearProductImageCache_(productId);

  // 画像変更に伴い、既存のAIドラフト確認状態を解除 (stale化し再公開をブロック)
  invalidateAiDraftConfirmationIfExists_(sheet, productId, "Product images updated");

  return jsonResponse({

    success: true,

    version:
      "product-images-update-v2",

    product_id:
      productId,

    image_count:
      images.length,

    main_image_url:
      mainImageUrl,

    images:
      images,

    selected_image_ids:
      currentSelectedImageIds,

    ai_selected_image_ids:
      currentSelectedImageIds
  });
}

// ==================================================
// 商品別 AI解析用選択画像 (selected_image_ids) の単独保存・取得
// 販売用のメイン画像 (AE列) や Drive画像順は一切変更しない
// ==================================================

function handleSaveProductAiSelectedImages(sheet, data) {
  const productId = String(data.product_id || "").trim();
  if (!productId) {
    const err = new Error("product_id is required");
    err.error_code = "PRODUCT_ID_REQUIRED";
    throw err;
  }

  const rawSelected = data.selected_image_ids !== undefined
    ? data.selected_image_ids
    : data.ai_selected_image_ids;

  if (rawSelected === undefined) {
    const err = new Error("selected_image_ids is required");
    err.error_code = "INVALID_IMAGE_SELECTION";
    throw err;
  }

  const saved = saveProductAiSelectedImageIds_(sheet, productId, rawSelected);

  return jsonResponse({
    success: true,
    version: "product-ai-selected-images-v1",
    product_id: saved.product_id,
    selected_image_ids: saved.selected_image_ids,
    ai_selected_image_ids: saved.selected_image_ids,
    updated_at: saved.updated_at
  });
}

function handleGetProductAiSelectedImages(sheet, data) {
  const productId = String(data.product_id || "").trim();
  if (!productId) {
    const err = new Error("product_id is required");
    err.error_code = "PRODUCT_ID_REQUIRED";
    throw err;
  }

  findProductRow(sheet, productId);
  const selectedIds = typeof getProductAiSelectedImageIds_ === "function"
    ? getProductAiSelectedImageIds_(productId)
    : [];

  return jsonResponse({
    success: true,
    version: "product-ai-selected-images-v1",
    product_id: productId,
    selected_image_ids: selectedIds,
    ai_selected_image_ids: selectedIds
  });
}


// ==================================================
// 複数商品・画像インポート (import_attempts) 管理設定
// ==================================================

const IMPORT_ATTEMPTS_CONFIG = {
  SHEET_NAME: "import_attempts",
  HEADERS: [
    "attempt_id",          // 1 (A)
    "status",              // 2 (B): initiated, drive_saved, sheet_appended, completed, failed
    "payload_fingerprint", // 3 (C): SHA-256
    "product_id",          // 4 (D): TMP-XXXXXX
    "drive_folder_id",     // 5 (E)
    "drive_folder_url",    // 6 (F)
    "main_image_url",      // 7 (G)
    "image_count",         // 8 (H)
    "error_message",       // 9 (I)
    "created_at",          // 10 (J)
    "updated_at"           // 11 (K)
  ]
};

function getOrCreateImportAttemptsSheet_(spreadsheet) {
  let sheet = spreadsheet.getSheetByName(IMPORT_ATTEMPTS_CONFIG.SHEET_NAME);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(IMPORT_ATTEMPTS_CONFIG.SHEET_NAME);
    sheet.appendRow(IMPORT_ATTEMPTS_CONFIG.HEADERS);
  }
  return sheet;
}

function findImportAttemptRecord_(sheet, attemptId) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  const data = sheet.getRange(2, 1, lastRow - 1, 11).getValues();
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    if (String(row[0] || "").trim() === attemptId) {
      return {
        rowIndex: i + 2,
        attempt_id: String(row[0] || "").trim(),
        status: String(row[1] || "").trim(),
        payload_fingerprint: String(row[2] || "").trim(),
        product_id: String(row[3] || "").trim(),
        drive_folder_id: String(row[4] || "").trim(),
        drive_folder_url: String(row[5] || "").trim(),
        main_image_url: String(row[6] || "").trim(),
        image_count: Number(row[7] || 0),
        error_message: String(row[8] || "").trim(),
        created_at: row[9],
        updated_at: row[10]
      };
    }
  }
  return null;
}

function saveNewImportAttemptRecord_(sheet, record) {
  const now = new Date().toISOString();
  const row = [
    record.attempt_id,
    record.status || "initiated",
    record.payload_fingerprint || "",
    record.product_id || "",
    record.drive_folder_id || "",
    record.drive_folder_url || "",
    record.main_image_url || "",
    record.image_count || 0,
    record.error_message || "",
    record.created_at || now,
    record.updated_at || now
  ];
  sheet.appendRow(row);
  return sheet.getLastRow();
}

function updateImportAttemptRecord_(sheet, rowIndex, updates) {
  if (updates.status !== undefined) {
    sheet.getRange(rowIndex, 2).setValue(updates.status);
  }
  if (updates.payload_fingerprint !== undefined) {
    sheet.getRange(rowIndex, 3).setValue(updates.payload_fingerprint);
  }
  if (updates.product_id !== undefined) {
    sheet.getRange(rowIndex, 4).setValue(updates.product_id);
  }
  if (updates.drive_folder_id !== undefined) {
    sheet.getRange(rowIndex, 5).setValue(updates.drive_folder_id);
  }
  if (updates.drive_folder_url !== undefined) {
    sheet.getRange(rowIndex, 6).setValue(updates.drive_folder_url);
  }
  if (updates.main_image_url !== undefined) {
    sheet.getRange(rowIndex, 7).setValue(updates.main_image_url);
  }
  if (updates.image_count !== undefined) {
    sheet.getRange(rowIndex, 8).setValue(updates.image_count);
  }
  if (updates.error_message !== undefined) {
    sheet.getRange(rowIndex, 9).setValue(updates.error_message);
  }
  sheet.getRange(rowIndex, 11).setValue(new Date().toISOString());
}

// ==================================================
// 商品添付書類 (product_documents) 管理設定・ヘルパー
// ==================================================

const PRODUCT_DOCUMENTS_CONFIG = {
  SHEET_NAME: "product_documents",
  HEADERS: [
    "product_id",         // 1 (A): TMP-XXXXXX
    "file_id",            // 2 (B): Drive File ID
    "document_type",      // 3 (C): invoice / receipt
    "original_file_name", // 4 (D): 元ファイル名
    "mime_type",          // 5 (E): application/pdf, image/jpeg, image/png
    "file_size",          // 6 (F): バイト数
    "created_at",         // 7 (G): ISOタイムスタンプ
    "idempotency_key",    // 8 (H): 再送・冪等性キー
    "payload_hash",       // 9 (I): 書類バイナリSHA-256
    "drive_file_url"      // 10 (J): DriveファイルURL
  ],
  ALLOWED_MIME_TYPES: [
    "application/pdf",
    "image/jpeg",
    "image/png"
  ],
  MAX_FILE_SIZE_BYTES: 15 * 1024 * 1024, // 15MB
  SUBFOLDER_NAME: "documents"
};

function getOrCreateProductDocumentsSheet_(spreadsheet) {
  let sheet = spreadsheet.getSheetByName(PRODUCT_DOCUMENTS_CONFIG.SHEET_NAME);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(PRODUCT_DOCUMENTS_CONFIG.SHEET_NAME);
    sheet.appendRow(PRODUCT_DOCUMENTS_CONFIG.HEADERS);
  }
  return sheet;
}

function findProductDocumentRecord_(documentsSheet, productId) {
  if (!documentsSheet) return null;
  const lastRow = documentsSheet.getLastRow();
  if (lastRow < 2) return null;
  const numCols = PRODUCT_DOCUMENTS_CONFIG.HEADERS.length;
  const data = documentsSheet.getRange(2, 1, lastRow - 1, numCols).getValues();
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    if (String(row[0] || "").trim() === productId) {
      return {
        rowIndex: i + 2,
        product_id: String(row[0] || "").trim(),
        file_id: String(row[1] || "").trim(),
        document_type: String(row[2] || "").trim(),
        original_file_name: String(row[3] || "").trim(),
        mime_type: String(row[4] || "").trim(),
        file_size: Number(row[5] || 0),
        created_at: String(row[6] || "").trim(),
        idempotency_key: String(row[7] || "").trim(),
        payload_hash: String(row[8] || "").trim(),
        drive_file_url: String(row[9] || "").trim(),
        view_url: String(row[9] || "").trim(),
        open_url: String(row[9] || "").trim()
      };
    }
  }
  return null;
}

function getProductDocumentRecord(productId) {
  if (!productId) return null;
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    if (!ss || typeof ss.getSheetByName !== "function") return null;
    const sheet = ss.getSheetByName(PRODUCT_DOCUMENTS_CONFIG.SHEET_NAME);
    if (!sheet) return null;
    return findProductDocumentRecord_(sheet, productId);
  } catch (_) {
    return null;
  }
}

function getProductDocumentFileIds_(productId) {
  const set = new Set();
  if (!productId) return set;
  try {
    const doc = getProductDocumentRecord(productId);
    if (doc && doc.file_id) {
      set.add(doc.file_id);
    }
  } catch (_) {}
  return set;
}

function getOrCreateProductDocumentsFolder_(productFolder) {
  if (!productFolder) return null;
  if (typeof productFolder.getFoldersByName === "function") {
    try {
      const it = productFolder.getFoldersByName(PRODUCT_DOCUMENTS_CONFIG.SUBFOLDER_NAME);
      while (it && typeof it.hasNext === "function" && it.hasNext()) {
        const f = it.next();
        if (f && typeof f.isTrashed === "function" && f.isTrashed()) continue;
        return f;
      }
    } catch (_) {}
  }
  if (typeof productFolder.createFolder === "function") {
    return productFolder.createFolder(PRODUCT_DOCUMENTS_CONFIG.SUBFOLDER_NAME);
  }
  return null;
}

function handleAttachProductDocument(sheet, data, testOptions) {
  testOptions = testOptions || {};
  const productId = String(data && (data.product_id || data.productId) || "").trim();
  if (!productId) {
    return jsonResponse({
      success: false,
      error_code: "PRODUCT_ID_REQUIRED",
      message: "product_id is required"
    });
  }

  const rowIndex = findProductRowSafe_(sheet, productId);
  if (rowIndex === null) {
    return jsonResponse({
      success: false,
      error_code: "PRODUCT_NOT_FOUND",
      message: "指定された product_id の商品が見つかりません: " + productId,
      product_id: productId
    });
  }

  const idempotencyKey = String(data && (data.idempotency_key || data.idempotencyKey || data.document_attempt_id) || "").trim();
  if (!idempotencyKey) {
    return jsonResponse({
      success: false,
      error_code: "DOCUMENT_IDEMPOTENCY_KEY_REQUIRED",
      message: "idempotency_key (or document_attempt_id) is required",
      product_id: productId
    });
  }

  const rawDocType = String(data && (data.document_type || data.documentType) || "").trim().toLowerCase();
  const documentType = (rawDocType === "receipt") ? "receipt" : "invoice";

  const originalFileName = String(data && (data.file_name || data.fileName || data.original_file_name || data.filename) || "").trim() || (documentType + ".pdf");

  const rawB64 = extractRawBase64_(data && (data.base64 || data.base64_data || data.base64Data || data.data));
  if (!rawB64) {
    return jsonResponse({
      success: false,
      error_code: "EMPTY_DOCUMENT_BASE64",
      message: "書類の base64 データが空です",
      product_id: productId
    });
  }

  let rawMime = String(data && (data.mime_type || data.mimeType || data.mime) || "").trim().toLowerCase();
  if (rawMime === "image/jpg" || rawMime === "image/pjpeg") rawMime = "image/jpeg";
  if (rawMime === "application/x-pdf") rawMime = "application/pdf";
  if (!rawMime || rawMime === "application/octet-stream") {
    if (originalFileName.toLowerCase().endsWith(".pdf")) rawMime = "application/pdf";
    else if (originalFileName.toLowerCase().endsWith(".png")) rawMime = "image/png";
    else if (originalFileName.toLowerCase().endsWith(".jpg") || originalFileName.toLowerCase().endsWith(".jpeg")) rawMime = "image/jpeg";
    else if (rawB64.startsWith("JVBERi")) rawMime = "application/pdf";
    else if (rawB64.startsWith("iVBORw0KGgo")) rawMime = "image/png";
    else if (rawB64.startsWith("/9j/")) rawMime = "image/jpeg";
  }

  if (!PRODUCT_DOCUMENTS_CONFIG.ALLOWED_MIME_TYPES.includes(rawMime)) {
    return jsonResponse({
      success: false,
      error_code: "INVALID_DOCUMENT_MIME_TYPE",
      message: "許可されていない書類形式です。PDF, JPG, PNG のみを添付できます (指定形式: " + rawMime + ")",
      product_id: productId
    });
  }

  let bytes;
  try {
    bytes = Utilities.base64Decode(rawB64);
    if (!bytes || bytes.length === 0) {
      throw new Error("decoded byte length is 0");
    }
  } catch (bErr) {
    return jsonResponse({
      success: false,
      error_code: "INVALID_DOCUMENT_BASE64",
      message: "書類の base64 データが不正です: " + bErr.message,
      product_id: productId
    });
  }

  // 書類容量（ファイルサイズ上限）検査
  if (bytes.length > PRODUCT_DOCUMENTS_CONFIG.MAX_FILE_SIZE_BYTES) {
    return jsonResponse({
      success: false,
      error_code: "DOCUMENT_SIZE_EXCEEDED",
      message: "書類サイズが上限（15MB）を超えています: " + (Math.round(bytes.length / 1024 / 1024 * 10) / 10) + "MB",
      product_id: productId
    });
  }

  // SHA-256 ハッシュ計算
  const payloadHash = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    rawB64,
    Utilities.Charset.UTF_8
  ).map(function(b) { return (b < 0 ? b + 256 : b).toString(16).padStart(2, "0"); }).join("");

  const spreadsheet = typeof sheet.getParent === "function" ? sheet.getParent() : SpreadsheetApp.getActiveSpreadsheet();
  const documentsSheet = getOrCreateProductDocumentsSheet_(spreadsheet);

  // 既存書類レコードの確認
  const existingRecord = findProductDocumentRecord_(documentsSheet, productId);
  if (existingRecord) {
    const isSameKey = existingRecord.idempotency_key === idempotencyKey;
    const isSameContent = existingRecord.payload_hash === payloadHash;

    if (isSameKey && isSameContent) {
      // 冪等性: 同一キーかつ同一内容の再送
      const reusedDoc = {
        product_id: productId,
        file_id: existingRecord.file_id,
        document_type: existingRecord.document_type,
        original_file_name: existingRecord.original_file_name,
        mime_type: existingRecord.mime_type,
        file_size: existingRecord.file_size,
        created_at: existingRecord.created_at,
        drive_file_url: existingRecord.drive_file_url,
        view_url: existingRecord.drive_file_url,
        open_url: existingRecord.drive_file_url
      };
      return jsonResponse({
        success: true,
        is_reused: true,
        status: "completed",
        document: reusedDoc,
        product_id: productId,
        file_id: existingRecord.file_id,
        document_type: existingRecord.document_type,
        original_file_name: existingRecord.original_file_name,
        mime_type: existingRecord.mime_type,
        file_size: existingRecord.file_size,
        created_at: existingRecord.created_at,
        view_url: existingRecord.drive_file_url,
        open_url: existingRecord.drive_file_url
      });
    }

    // 異なるキーまたは異なる内容での重複添付は明確に競合エラー (1商品につき1件制限)
    return jsonResponse({
      success: false,
      error_code: "DOCUMENT_ALREADY_EXISTS",
      message: "既にこの商品には書類が登録されています。1商品につき1件のみ登録可能です。上書き・重複追加は行われません。",
      product_id: productId,
      existing_document: {
        file_id: existingRecord.file_id,
        document_type: existingRecord.document_type,
        original_file_name: existingRecord.original_file_name,
        mime_type: existingRecord.mime_type,
        created_at: existingRecord.created_at
      }
    });
  }

  // 商品フォルダの取得
  const folderUrl = String(sheet.getRange(rowIndex, 30).getValue() || "").trim(); // AD列 (30)
  const folderId = extractDriveFolderId(folderUrl);
  const productFolder = folderId ? findDriveFolderSafe_(folderId) : null;

  if (!productFolder) {
    return jsonResponse({
      success: false,
      error_code: "PRODUCT_DRIVE_FOLDER_NOT_FOUND",
      message: "商品登録は成功していますが、Driveフォルダが見つからないため書類添付に失敗しました。書類のみ再試行してください。",
      product_id: productId
    });
  }

  try {
    // 書類専用サブフォルダ documents/ の取得または作成
    const docFolder = getOrCreateProductDocumentsFolder_(productFolder);
    if (!docFolder) {
      throw new Error("Failed to get or create documents subfolder");
    }

    // 障害復旧: シート書込み前に中断された既存ファイルが documents/ 内に同内容で存在するか照合
    let targetFile = null;
    if (typeof docFolder.getFiles === "function") {
      try {
        const existingFiles = docFolder.getFiles();
        while (existingFiles && typeof existingFiles.hasNext === "function" && existingFiles.hasNext()) {
          const f = existingFiles.next();
          if (f && typeof f.isTrashed === "function" && f.isTrashed()) continue;
          if (isDriveFileContentEqual_(f, rawB64)) {
            targetFile = f;
            break;
          }
        }
      } catch (_) {}
    }

    if (!targetFile) {
      const sanitizedName = originalFileName.replace(/[^a-zA-Z0-9._-]/g, "_");
      const storageFileName = documentType + "_" + sanitizedName;
      const blob = Utilities.newBlob(bytes, rawMime, storageFileName);
      targetFile = docFolder.createFile(blob);
    }

    const nowIso = new Date().toISOString();
    const driveFileUrl = typeof targetFile.getUrl === "function" ? targetFile.getUrl() : ("https://drive.google.com/file/d/" + targetFile.getId() + "/view");

    // product_documents シートへ追記
    documentsSheet.appendRow([
      productId,
      targetFile.getId(),
      documentType,
      originalFileName,
      rawMime,
      bytes.length,
      nowIso,
      idempotencyKey,
      payloadHash,
      driveFileUrl
    ]);

    const attachedDoc = {
      product_id: productId,
      file_id: targetFile.getId(),
      document_type: documentType,
      original_file_name: originalFileName,
      mime_type: rawMime,
      file_size: bytes.length,
      created_at: nowIso,
      drive_file_url: driveFileUrl,
      view_url: driveFileUrl,
      open_url: driveFileUrl
    };

    return jsonResponse({
      success: true,
      is_reused: false,
      status: "completed",
      document: attachedDoc,
      product_id: productId,
      file_id: targetFile.getId(),
      document_type: documentType,
      original_file_name: originalFileName,
      mime_type: rawMime,
      file_size: bytes.length,
      created_at: nowIso,
      view_url: driveFileUrl,
      open_url: driveFileUrl
    });

  } catch (err) {
    console.error("[Product Document] Failed to attach document for product " + productId + ":", err);
    return jsonResponse({
      success: false,
      error_code: "DOCUMENT_ATTACH_FAILED",
      product_id: productId,
      message: "商品登録は成功していますが、書類の添付に失敗しました。書類のみ再試行してください。",
      error: err && err.message ? err.message : String(err)
    });
  }
}

// ==================================================
// 独立書類 (未登録商品でも原本保管) 設定とハンドラー
// ==================================================

const INDEPENDENT_DOCUMENTS_CONFIG = {
  FOLDER_NAME: "AIS_INDEPENDENT_DOCUMENTS",
  MAX_FILE_SIZE_BYTES: 15 * 1024 * 1024, // 15MB
  ALLOWED_MIME_TYPES: [
    "application/pdf",
    "image/jpeg",
    "image/png"
  ]
};

function getOrCreateIndependentDocumentsFolder_(rootFolderId, testOptions) {
  testOptions = testOptions || {};
  let rootFolder = null;
  if (testOptions.rootFolder) {
    rootFolder = testOptions.rootFolder;
  } else {
    try {
      rootFolder = DriveApp.getFolderById(rootFolderId || ROOT_FOLDER_ID);
    } catch (_) {}
  }
  if (!rootFolder) return null;

  let docFolder = null;
  if (typeof rootFolder.getFoldersByName === "function") {
    try {
      const it = rootFolder.getFoldersByName(INDEPENDENT_DOCUMENTS_CONFIG.FOLDER_NAME);
      while (it && typeof it.hasNext === "function" && it.hasNext()) {
        const f = it.next();
        if (f && typeof f.isTrashed === "function" && f.isTrashed()) continue;
        docFolder = f;
        break;
      }
    } catch (_) {}
  }
  if (!docFolder && typeof rootFolder.createFolder === "function") {
    docFolder = rootFolder.createFolder(INDEPENDENT_DOCUMENTS_CONFIG.FOLDER_NAME);
  }
  return docFolder;
}

function handleUploadIndependentDocument(data, testOptions) {
  testOptions = testOptions || {};
  const idempotencyKey = String(data && (data.idempotency_key || data.idempotencyKey || data.request_id) || "").trim();
  if (!idempotencyKey) {
    return jsonResponse({
      success: false,
      error_code: "IDEMPOTENCY_KEY_REQUIRED",
      message: "idempotency_key (or request_id) is required"
    });
  }

  const rawDocType = String(data && (data.document_type || data.documentType) || "").trim().toLowerCase();
  const documentType = (rawDocType === "receipt") ? "receipt" : (rawDocType === "statement" ? "statement" : "invoice");
  const originalFileName = String(data && (data.file_name || data.fileName || data.original_file_name || data.filename) || "").trim() || (documentType + ".pdf");

  const rawB64 = extractRawBase64_(data && (data.base64 || data.base64_data || data.base64Data || data.data));
  if (!rawB64) {
    return jsonResponse({
      success: false,
      error_code: "EMPTY_DOCUMENT_BASE64",
      message: "書類の base64 データが空です"
    });
  }

  let rawMime = String(data && (data.mime_type || data.mimeType || data.mime) || "").trim().toLowerCase();
  if (rawMime === "image/jpg" || rawMime === "image/pjpeg") rawMime = "image/jpeg";
  if (rawMime === "application/x-pdf") rawMime = "application/pdf";
  if (!rawMime || rawMime === "application/octet-stream") {
    if (originalFileName.toLowerCase().endsWith(".pdf")) rawMime = "application/pdf";
    else if (originalFileName.toLowerCase().endsWith(".png")) rawMime = "image/png";
    else if (originalFileName.toLowerCase().endsWith(".jpg") || originalFileName.toLowerCase().endsWith(".jpeg")) rawMime = "image/jpeg";
    else if (rawB64.startsWith("JVBERi")) rawMime = "application/pdf";
    else if (rawB64.startsWith("iVBORw0KGgo")) rawMime = "image/png";
    else if (rawB64.startsWith("/9j/")) rawMime = "image/jpeg";
  }

  if (!INDEPENDENT_DOCUMENTS_CONFIG.ALLOWED_MIME_TYPES.includes(rawMime)) {
    return jsonResponse({
      success: false,
      error_code: "INVALID_DOCUMENT_MIME_TYPE",
      message: "許可されていない書類形式です。PDF, JPG, PNG のみを保存できます (指定形式: " + rawMime + ")"
    });
  }

  let bytes;
  try {
    bytes = Utilities.base64Decode(rawB64);
    if (!bytes || bytes.length === 0) {
      throw new Error("decoded byte length is 0");
    }
  } catch (bErr) {
    return jsonResponse({
      success: false,
      error_code: "INVALID_DOCUMENT_BASE64",
      message: "書類の base64 データが不正です: " + bErr.message
    });
  }

  if (bytes.length > INDEPENDENT_DOCUMENTS_CONFIG.MAX_FILE_SIZE_BYTES) {
    return jsonResponse({
      success: false,
      error_code: "DOCUMENT_SIZE_EXCEEDED",
      message: "書類の容量が上限（15MB）を超過しています: " + Math.round(bytes.length / 1024 / 1024) + "MB"
    });
  }

  const payloadHash = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    rawB64,
    Utilities.Charset.UTF_8
  ).map(function(b) { return (b < 0 ? b + 256 : b).toString(16).padStart(2, "0"); }).join("");

  const docFolder = getOrCreateIndependentDocumentsFolder_(ROOT_FOLDER_ID, testOptions);
  if (!docFolder) {
    return jsonResponse({
      success: false,
      error_code: "INDEPENDENT_DOCUMENTS_FOLDER_NOT_FOUND",
      message: "Driveの独立書類保管フォルダが見つからないため保存に失敗しました。"
    });
  }

  // 同一内容ファイル（同一指紋）のDrive重複作成防止・再利用
  const scriptProps = (testOptions && testOptions.propService) || PropertiesService.getScriptProperties();
  const cacheKey = "indep_doc_" + payloadHash;
  if (scriptProps) {
    try {
      const cachedMetaRaw = scriptProps.getProperty(cacheKey);
      if (cachedMetaRaw) {
        const cached = JSON.parse(cachedMetaRaw);
        if (cached && cached.file_id) {
          return jsonResponse({
            success: true,
            is_reused: true,
            file_id: cached.file_id,
            file_name: cached.file_name || originalFileName,
            mime_type: rawMime,
            file_size: bytes.length,
            file_fingerprint: payloadHash,
            drive_file_url: cached.drive_file_url,
            view_url: cached.drive_file_url,
            folder_id: docFolder.getId()
          });
        }
      }
    } catch (_) {}
  }

  try {
    const blob = Utilities.newBlob(bytes, rawMime, originalFileName);
    const targetFile = docFolder.createFile(blob);
    const driveFileUrl = typeof targetFile.getUrl === "function" ? targetFile.getUrl() : ("https://drive.google.com/file/d/" + targetFile.getId() + "/view");

    if (scriptProps) {
      try {
        scriptProps.setProperty(cacheKey, JSON.stringify({
          file_id: targetFile.getId(),
          file_name: targetFile.getName(),
          drive_file_url: driveFileUrl
        }));
      } catch (_) {}
    }

    return jsonResponse({
      success: true,
      file_id: targetFile.getId(),
      file_name: targetFile.getName(),
      mime_type: rawMime,
      file_size: bytes.length,
      file_fingerprint: payloadHash,
      drive_file_url: driveFileUrl,
      view_url: driveFileUrl,
      folder_id: docFolder.getId()
    });
  } catch (err) {
    console.error("[Independent Document] Failed to save file to Drive:", err);
    return jsonResponse({
      success: false,
      error_code: "DRIVE_SAVE_FAILED",
      message: "Driveへのファイル保存に失敗しました: " + (err && err.message ? err.message : String(err))
    });
  }
}

/**
 * Drive原本書類を別のフォルダへ移動する。
 *
 * @param {Object} data { file_id, target_folder_id }
 * @param {Object} testOptions テスト用モックオブジェクト
 * @return {GoogleAppsScript.Content.TextOutput} JSONレスポンス
 */
function handleMoveDriveFile(data, testOptions) {
  testOptions = testOptions || {};
  const fileId = String(data && (data.file_id || data.fileId) || "").trim();
  if (!fileId) {
    return jsonResponse({
      success: false,
      error_code: "FILE_ID_REQUIRED",
      message: "file_id is required"
    });
  }
  const targetFolderId = String(data && (data.target_folder_id || data.targetFolderId || data.folder_id) || "").trim();
  if (!targetFolderId) {
    return jsonResponse({
      success: false,
      error_code: "TARGET_FOLDER_ID_REQUIRED",
      message: "target_folder_id is required"
    });
  }

  let driveApp = testOptions.driveApp || DriveApp;
  try {
    const file = driveApp.getFileById(fileId);
    const targetFolder = driveApp.getFolderById(targetFolderId);
    if (!file) throw new Error("File not found: " + fileId);
    if (!targetFolder) throw new Error("Target folder not found: " + targetFolderId);

    if (typeof file.moveTo === "function") {
      file.moveTo(targetFolder);
    } else {
      // 古いAPIフォールバック
      if (typeof targetFolder.addFile === "function") {
        targetFolder.addFile(file);
      }
      if (typeof file.getParents === "function") {
        const parents = file.getParents();
        while (parents && typeof parents.hasNext === "function" && parents.hasNext()) {
          const p = parents.next();
          if (p.getId() !== targetFolderId && typeof p.removeFile === "function") {
            p.removeFile(file);
          }
        }
      }
    }

    return jsonResponse({
      success: true,
      file_id: fileId,
      target_folder_id: targetFolderId,
      file_name: typeof file.getName === "function" ? file.getName() : ""
    });
  } catch (err) {
    console.error("[Move Drive File] Error:", err);
    return jsonResponse({
      success: false,
      error_code: "DRIVE_MOVE_FAILED",
      message: "Driveファイルの移動に失敗しました: " + (err && err.message ? err.message : String(err))
    });
  }
}

/**
 * Drive原本書類の内容（Base64）を取得する。
 *
 * @param {Object} data { file_id }
 * @param {Object} testOptions テスト用モックオブジェクト
 * @return {GoogleAppsScript.Content.TextOutput} JSONレスポンス
 */
function handleGetDriveFileContent(data, testOptions) {
  testOptions = testOptions || {};
  const fileId = String(data && (data.file_id || data.fileId) || "").trim();
  if (!fileId) {
    return jsonResponse({
      success: false,
      error_code: "FILE_ID_REQUIRED",
      message: "file_id is required"
    });
  }

  let driveApp = testOptions.driveApp || DriveApp;
  try {
    const file = driveApp.getFileById(fileId);
    if (!file) throw new Error("File not found: " + fileId);
    const blob = file.getBlob();
    const bytes = blob.getBytes();
    const base64 = Utilities.base64Encode(bytes);
    return jsonResponse({
      success: true,
      file_id: fileId,
      file_name: typeof file.getName === "function" ? file.getName() : "",
      mime_type: blob.getContentType() || (typeof file.getMimeType === "function" ? file.getMimeType() : "application/pdf"),
      file_size: bytes.length,
      base64: base64
    });
  } catch (err) {
    console.error("[Get Drive File Content] Error:", err);
    return jsonResponse({
      success: false,
      error_code: "DRIVE_FILE_READ_FAILED",
      message: "Driveファイルの読み取りに失敗しました: " + (err && err.message ? err.message : String(err))
    });
  }
}

/**
 * Data URI スキーム (data:[mime];base64,...) が含まれる場合は Base64 本体のみを抽出し、
 * 従来の接頭辞なし Base64 文字列はそのままトリムして返す。
 *
 * @param {string} str Base64 文字列または Data URI 文字列
 * @return {string} Base64 本体文字列
 */
function extractRawBase64_(str) {
  const s = String(str || "").trim();
  const commaIdx = s.indexOf(",");
  if (commaIdx !== -1) {
    return s.substring(commaIdx + 1).trim();
  }
  return s;
}

/**
 * 画像の内容・順序および登録に影響する属性を含めた SHA-256 指紋を計算
 */
function computeImportPayloadFingerprint_(data, isImport) {
  isImport = isImport !== false; // 新インポートは常に draft 固定
  const images = Array.isArray(data && data.images) ? data.images : [];
  const normalizedImages = images.map(function(img, idx) {
    if (!img) return { idx: idx, empty: true };
    const rawB64 = extractRawBase64_(img.base64);
    let b64Hash = "";
    if (rawB64.length > 0) {
      const digest = Utilities.computeDigest(
        Utilities.DigestAlgorithm.SHA_256,
        rawB64,
        Utilities.Charset.UTF_8
      );
      b64Hash = digest.map(function(b) {
        return ('0' + ((b & 0xFF).toString(16))).slice(-2);
      }).join('');
    }
    return {
      idx: idx,
      name: String(img.file_name || "image.jpg").trim(),
      mime: String(img.mime_type || "image/jpeg").trim(),
      b64_hash: b64Hash
    };
  });

  const normalizedAttrs = {
    category: String(data.category || "").trim(),
    brand: String(data.brand || "").trim(),
    product_name: String(data.product_name || "").trim(),
    condition: String(data.condition || "").trim(),
    purchase_price: Number(data.purchase_price || 0),
    planned_sale_price: Number(data.planned_sale_price || 0),
    storage_location: String(data.storage_location || "").trim(),
    description: String(data.description || "").trim(),
    notes: String(data.notes || "").trim(),
    sneaker_sku: String(data.sneaker_sku || "").trim(),
    sneaker_size: String(data.sneaker_size || "").trim(),
    sneaker_colorway: String(data.sneaker_colorway || "").trim(),
    sneaker_box: String(data.sneaker_box || "").trim(),
    sneaker_accessories: String(data.sneaker_accessories || "").trim(),
    sneaker_release_year: String(data.sneaker_release_year || "").trim(),
    jewelry_type: String(data.jewelry_type || "").trim(),
    jewelry_material: String(data.jewelry_material || "").trim(),
    carat: String(data.carat || "").trim(),
    shape: String(data.shape || "").trim(),
    color_grade: String(data.color_grade || "").trim(),
    clarity: String(data.clarity || "").trim(),
    cut: String(data.cut || "").trim(),
    main_stone: String(data.main_stone || "").trim(),
    jewelry_size: String(data.jewelry_size || "").trim(),
    weight_g: String(data.weight_g || "").trim(),
    certificate_available: String(data.certificate_available || "").trim(),
    certificate_number: String(data.certificate_number || "").trim(),
    subcategory: String(data.subcategory !== undefined ? data.subcategory : (data.sub_category || "")).trim(),
    size: String(data.size || "").trim(),
    official_sku: String(data.official_sku !== undefined ? data.official_sku : (data.sku || "")).trim(),
    pokemon_card: data.pokemon_card ? JSON.stringify(data.pokemon_card) : "",
    // 新インポートでは入力値に関わらず常に draft 固定
    publish_status: isImport ? "draft" : (String(data.publish_status || "").trim() === "published" ? "published" : "draft")
  };

  // auction_item_number は指定時のみ指紋に含め、未指定・空欄の既存リクエストと完全互換を維持する
  const normalizedAuctionItemNo = normalizeAuctionItemNumberInput_(data.auction_item_number);
  if (normalizedAuctionItemNo !== "") {
    normalizedAttrs.auction_item_number = normalizedAuctionItemNo;
  }

  const payloadString = JSON.stringify({
    images: normalizedImages,
    attrs: normalizedAttrs
  });

  const fullDigest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    payloadString,
    Utilities.Charset.UTF_8
  );
  return fullDigest.map(function(b) {
    return ('0' + ((b & 0xFF).toString(16))).slice(-2);
  }).join('');
}

function findProductRowSafe_(sheet, productId) {
  if (!productId) return null;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  const productIds = sheet.getRange(2, 2, lastRow - 1, 1).getValues();
  for (let i = 0; i < productIds.length; i++) {
    if (String(productIds[i][0] || "").trim() === productId) {
      return i + 2;
    }
  }
  return null;
}

function findDriveFolderSafe_(folderId) {
  if (!folderId) return null;
  try {
    const folder = DriveApp.getFolderById(folderId);
    if (folder) {
      if (typeof folder.isTrashed === "function" && folder.isTrashed()) {
        return null;
      }
      return folder;
    }
    return null;
  } catch (_) {
    return null;
  }
}

/**
 * Drive ファイルの内容と Base64 文字列の内容が一致するか検証
 *
 * @param {GoogleAppsScript.Drive.File} file Drive ファイル
 * @param {string} targetBase64 比較対象の Base64 文字列
 * @return {boolean} 一致していれば true
 */
function isDriveFileContentEqual_(file, targetBase64) {
  if (!file) return false;
  if (typeof file.isTrashed === "function" && file.isTrashed()) return false;
  try {
    let fileBytes = null;
    if (typeof file.getBlob === "function") {
      const blob = file.getBlob();
      if (blob && typeof blob.getBytes === "function") {
        fileBytes = blob.getBytes();
      } else if (blob && blob.bytes) {
        fileBytes = blob.bytes;
      }
    } else if (file.bytes) {
      fileBytes = file.bytes;
    }

    if (!fileBytes) return false;

    const cleanB64 = extractRawBase64_(targetBase64);
    if (!cleanB64) return false;

    const targetBytes = Utilities.base64Decode(cleanB64);
    if (!targetBytes) return false;

    if (fileBytes.length !== targetBytes.length) {
      return false;
    }

    const fileB64 = Utilities.base64Encode(fileBytes);
    const targetCanonicalB64 = Utilities.base64Encode(targetBytes);

    return fileB64 === targetCanonicalB64;
  } catch (e) {
    return false;
  }
}

// ==================================================
// 商品シート列数検証 (43列以上必須)
// ==================================================

/**
 * 商品シート (Sheets[0]) の最大列数が 43 列以上あることを検証する
 * 43列未満の場合は、画像保存や行作成、セル更新の前に明確なエラーで停止する
 *
 * @param {Sheet} sheet 商品シート
 */
function assertProductSheetColumnCount_(sheet) {
  if (!sheet || typeof sheet.getMaxColumns !== "function") return;
  const maxCols = sheet.getMaxColumns();
  if (maxCols < 43) {
    const err = new Error(
      `Product sheet column count insufficient (found: ${maxCols}, required: 43). ` +
      `Please ensure columns AO (41: apparel_fashion_subcategory), AP (42: apparel_fashion_size), AQ (43: apparel_fashion_sku) exist in the sheet before proceeding.`
    );
    err.error_code = "INSUFFICIENT_SHEET_COLUMNS";
    throw err;
  }
}

// ==================================================
// 仕入台帳のオークション等の商品番号 (AR列: 44列目) ヘルパー
// ==================================================

const AUCTION_ITEM_NUMBER_COLUMN = 44;

/**
 * 入力された auction_item_number を文字列へ正規化する。
 * - undefined / null は空文字 "" とする
 * - 先頭ゼロ ("00123") やハイフン ("842-33225", "-005") を保持する
 * - 配列・オブジェクト・真偽値は型不正として拒否する
 *
 * @param {*} rawVal
 * @return {string}
 */
function normalizeAuctionItemNumberInput_(rawVal) {
  if (rawVal === undefined || rawVal === null) {
    return "";
  }
  if (typeof rawVal === "object" || typeof rawVal === "boolean") {
    const err = new Error("auction_item_number must be a string");
    err.error_code = "INVALID_AUCTION_ITEM_NUMBER";
    throw err;
  }
  return String(rawVal).trim();
}

/**
 * シートセルから読み取った auction_item_number を常に文字列として整形する。
 *
 * @param {*} cellVal
 * @return {string}
 */
function formatAuctionItemNumber_(cellVal) {
  if (cellVal === undefined || cellVal === null || cellVal === "") {
    return "";
  }
  return String(cellVal).trim();
}

/**
 * 商品シートの AR列 (44列目: auction_item_number) に文字列として安全に書き込む。
 * 先頭ゼロやハイフンが数値・日付・数式へ自動変換されないようプレーンテキスト書式 "@" を適用する。
 *
 * @param {Sheet} sheet
 * @param {number} rowNumber
 * @param {string} normalizedVal
 */
function writeAuctionItemNumberCell_(sheet, rowNumber, normalizedVal) {
  if (
    sheet &&
    typeof sheet.getMaxColumns === "function" &&
    typeof sheet.insertColumnsAfter === "function"
  ) {
    const maxCols = sheet.getMaxColumns();
    if (maxCols < AUCTION_ITEM_NUMBER_COLUMN) {
      sheet.insertColumnsAfter(maxCols, AUCTION_ITEM_NUMBER_COLUMN - maxCols);
      const headerCell = sheet.getRange(1, AUCTION_ITEM_NUMBER_COLUMN);
      const currentHeader = String(headerCell.getValue() || "").trim();
      if (!currentHeader) {
        headerCell.setValue("auction_item_number");
      }
    }
  }
  const cell = sheet.getRange(rowNumber, AUCTION_ITEM_NUMBER_COLUMN);
  if (cell && typeof cell.setNumberFormat === "function") {
    cell.setNumberFormat("@");
  }
  cell.setValue(normalizedVal);
  if (
    normalizedVal !== "" &&
    cell &&
    typeof cell.getFormula === "function" &&
    cell.getFormula() !== ""
  ) {
    cell.setValue("'" + normalizedVal);
  }
}

// ==================================================
// 商品登録共通コア処理
// ==================================================

function executeProductCreationCore_(sheet, data, options) {
  options = options || {};
  const isImport = !!options.isImport;
  const attemptId = options.importAttemptId || "";
  const attemptsSheet = options.attemptsSheet || null;
  const attemptRowIndex = options.attemptRowIndex || null;

  // セキュリティ対策: 外部POSTの data._testInterruptStage は完全に無視し、テスト内部呼び出しの options.interruptStage のみ許可
  const interruptStage = String(options.interruptStage || "");

  // ------------------------------------------
  // シート列数事前チェック (画像保存や商品行作成の前に検証)
  // ------------------------------------------
  assertProductSheetColumnCount_(sheet);

  // ------------------------------------------
  // auction_item_number 事前検証 (採番前に検証)
  // ------------------------------------------
  const validatedAuctionItemNumber = Object.prototype.hasOwnProperty.call(data, "auction_item_number")
    ? normalizeAuctionItemNumberInput_(data.auction_item_number)
    : "";

  // ------------------------------------------
  // 画像枚数事前チェック
  // ------------------------------------------
  if (
    Array.isArray(data.images) &&
    data.images.length > 20
  ) {
    if (isImport) {
      return jsonResponse({
        success: false,
        error_code: "MAX_IMAGE_COUNT_EXCEEDED",
        message: "maximum image count is 20"
      });
    }
    throw new Error(
      "maximum image count is 20"
    );
  }

  // ------------------------------------------
  // 商品ID発行・予約
  // ------------------------------------------
  const productId =
    options.existingProductId || generateNextProductId(sheet);

  if (isImport && attemptsSheet && attemptRowIndex) {
    updateImportAttemptRecord_(attemptsSheet, attemptRowIndex, {
      product_id: productId
    });
  }

  // ------------------------------------------
  // Pokemon Card 判定 & 保存
  // ------------------------------------------
  const normalizedCategory =
    String(data.category || "").trim();

  const isPokemonCard =
    normalizedCategory === "pokemon_card";

  let pokemonCardRecordCreated = false;

  try {
    if (isPokemonCard) {
      if (
        !data.pokemon_card ||
        typeof data.pokemon_card !== "object" ||
        Array.isArray(data.pokemon_card)
      ) {
        throw new Error(
          "pokemon_card data is required for pokemon_card category"
        );
      }

      const existingPokemonCard =
        getPokemonCardByProductId(productId);

      // 通常登録、または新規採番された productId の場合は既存レコードがあればエラー (元の挙動を完全復元)
      if (!options.existingProductId && existingPokemonCard !== null) {
        throw new Error(
          "pokemon card record already exists for new product_id: " + productId
        );
      }

      if (existingPokemonCard === null) {
        const pokemonSaveResult =
          savePokemonCardByProductId(
            productId,
            data.pokemon_card
          );

        pokemonCardRecordCreated = true;

        if (
          !pokemonSaveResult ||
          pokemonSaveResult.status !== "created"
        ) {
          throw new Error(
            "failed to create pokemon card record for product_id: " + productId
          );
        }
      }
    }

    // ------------------------------------------
    // Drive商品フォルダ作成 / 既存取得
    // ------------------------------------------
    const rootFolder =
      DriveApp.getFolderById(
        ROOT_FOLDER_ID
      );

    let productFolder = null;
    if (options.existingFolderId) {
      productFolder = findDriveFolderSafe_(options.existingFolderId);
    }

    if (!productFolder) {
      productFolder =
        rootFolder.createFolder(
          productId
        );

      if (isImport && attemptsSheet && attemptRowIndex) {
        updateImportAttemptRecord_(attemptsSheet, attemptRowIndex, {
          drive_folder_id: productFolder.getId(),
          drive_folder_url: productFolder.getUrl()
        });
      }
    }

    // 既存フォルダ内の既存ファイルをファイル名でインデックス化 (同名ファイルの自動ゴミ箱移動は行わない)
    const existingFilesByName = {};
    if (productFolder && typeof productFolder.getFiles === "function") {
      try {
        const files = productFolder.getFiles();
        while (files && typeof files.hasNext === "function" && files.hasNext()) {
          const f = files.next();
          if (f && typeof f.isTrashed === "function" && f.isTrashed()) continue;
          if (f && typeof f.getName === "function") {
            const fname = f.getName();
            if (!existingFilesByName[fname]) {
              existingFilesByName[fname] = f;
            }
          }
        }
      } catch (_) {}
    }

    const imageUrls = [];
    const createdImagesMeta = [];

    // ------------------------------------------
    // 商品画像保存
    // ------------------------------------------
    if (Array.isArray(data.images)) {
      for (let index = 0; index < data.images.length; index++) {
        const image = data.images[index];
        if (
          !image ||
          !image.base64
        ) {
          continue;
        }

        const originalName =
          image.file_name ||
          "image.jpg";

        const fileName =
          index === 0
            ? `01_main_${originalName}`
            : `${String(
                index + 1
              ).padStart(
                2,
                "0"
              )}_${originalName}`;

        // 既存フォルダ内に既に同名ファイルが存在する場合
        if (existingFilesByName[fileName]) {
          const existingFile = existingFilesByName[fileName];
          // ファイル名だけでなく内容が一致するか検証 (同名で内容が異なる画像の誤流用を防止)
          if (isDriveFileContentEqual_(existingFile, image.base64)) {
            const existingUrl = existingFile.getUrl();
            const existingFileId = typeof existingFile.getId === "function" ? existingFile.getId() : "";
            const existingMime = typeof existingFile.getMimeType === "function"
              ? existingFile.getMimeType()
              : (image.mime_type || "image/jpeg");
            imageUrls.push(existingUrl);
            createdImagesMeta.push({
              file_id: existingFileId,
              name: fileName,
              mime_type: existingMime || "image/jpeg",
              view_url: existingUrl,
              display_url: existingFileId
                ? ("https://drive.google.com/thumbnail?id=" + existingFileId + "&sz=w1600")
                : ""
            });
            continue;
          } else {
            const mismatchError = new Error(
              "Drive folder contains conflicting file with same name but different content: " + fileName
            );
            mismatchError.error_code = "IMPORT_DRIVE_IMAGE_CONTENT_MISMATCH";
            throw mismatchError;
          }
        }

        // テスト用中断シミュレーション: 画像保存途中
        if (interruptStage === "during_image_save" && index === 1) {
          throw new Error("Simulated failure during image save");
        }

        const rawB64 = extractRawBase64_(image.base64);
        const bytes =
          Utilities.base64Decode(
            rawB64
          );

        let mimeType = image.mime_type || "";
        if (!mimeType) {
          const s = String(image.base64 || "").trim();
          const match = s.match(/^data:([^;]+);base64,/i);
          if (match) {
            mimeType = match[1];
          }
        }
        if (!mimeType) {
          mimeType = "image/jpeg";
        }

        const blob =
          Utilities.newBlob(
            bytes,
            mimeType,
            fileName
          );

        const file =
          productFolder.createFile(
            blob
          );

        const createdUrl = file.getUrl();
        const createdFileId = typeof file.getId === "function" ? file.getId() : "";
        imageUrls.push(
          createdUrl
        );
        createdImagesMeta.push({
          file_id: createdFileId,
          name: fileName,
          mime_type: mimeType,
          view_url: createdUrl,
          display_url: createdFileId
            ? ("https://drive.google.com/thumbnail?id=" + createdFileId + "&sz=w1600")
            : ""
        });
        existingFilesByName[fileName] = file;
      }
    }

    const folderUrl =
      productFolder.getUrl();

    const mainImageUrl =
      imageUrls.length > 0
        ? imageUrls[0]
        : "";

    if (isImport && attemptsSheet && attemptRowIndex) {
      updateImportAttemptRecord_(attemptsSheet, attemptRowIndex, {
        status: "drive_saved",
        drive_folder_id: productFolder.getId(),
        drive_folder_url: folderUrl,
        main_image_url: mainImageUrl,
        image_count: imageUrls.length
      });
    }

    // ------------------------------------------
    // Sheetsへ保存 (本票)
    // ------------------------------------------
    let targetRow = options.existingRowIndex || null;
    const createdAtDate = new Date();

    if (!targetRow) {
      const rowData = [
        // A 登録日時
        createdAtDate,

        // B 商品ID
        productId,

        // C〜K 共通
        isPokemonCard
          ? "pokemon_card"
          : (data.category || ""),
        data.brand || "",
        data.product_name || "",
        data.condition || "",

        Number(
          data.purchase_price || 0
        ),

        Number(
          data.planned_sale_price || 0
        ),

        data.storage_location || "",
        data.description || "",
        data.notes || "",

        // L〜Q スニーカー
        data.sneaker_sku || "",
        data.sneaker_size || "",
        data.sneaker_colorway || "",
        data.sneaker_box || "",
        data.sneaker_accessories || "",
        data.sneaker_release_year || "",

        // R〜AC ジュエリー
        data.jewelry_type || "",
        data.jewelry_material || "",
        data.carat || "",
        data.shape || "",
        data.color_grade || "",
        data.clarity || "",
        data.cut || "",
        data.main_stone || "",
        data.jewelry_size || "",
        data.weight_g || "",
        data.certificate_available || "",
        data.certificate_number || "",

        // AD
        folderUrl,

        // AE
        mainImageUrl
      ];

      sheet.appendRow(rowData);
      targetRow = sheet.getLastRow();

      if (isImport && attemptsSheet && attemptRowIndex) {
        updateImportAttemptRecord_(attemptsSheet, attemptRowIndex, {
          status: "sheet_appended"
        });
      }

      // テスト用中断シミュレーション: 行追加後（状態列書き込み前）
      if (interruptStage === "after_sheet_append") {
        throw new Error("Simulated failure after sheet append");
      }
    }

    // ------------------------------------------
    // AF = 公開状態, AG = 在庫状態, AH = レコード状態
    // 新インポート時は入力値に関わらず常に draft 固定
    // ------------------------------------------
    const publishStatus = isImport
      ? "draft"
      : (String(data.publish_status || "").trim() === "published" ? "published" : "draft");

    sheet
      .getRange(
        targetRow,
        32
      )
      .setValue(
        publishStatus
      );

    // テスト用中断シミュレーション: 状態列書き込み途中
    if (interruptStage === "during_status_write") {
      throw new Error("Simulated failure during status write");
    }

    sheet
      .getRange(
        targetRow,
        33
      )
      .setValue(
        "in_stock"
      );

    sheet
      .getRange(
        targetRow,
        34
      )
      .setValue(
        "active"
      );

    // 新カテゴリ属性の保存 (41: subcategory, 42: size, 43: official_sku)
    // 既存4カテゴリ (sneaker, pokemon_card, jewelry, other) への新列書き込みを厳格に防止
    const isApparelOrFashionCat = (normalizedCategory === "apparel" || normalizedCategory === "fashion_goods");
    if (isApparelOrFashionCat) {
      const subcategoryVal = String(data.subcategory !== undefined ? data.subcategory : (data.sub_category !== undefined ? data.sub_category : "")).trim();
      const sizeVal = String(data.size || "").trim();
      const officialSkuVal = String(data.official_sku !== undefined ? data.official_sku : (data.sku !== undefined ? data.sku : "")).trim();

      if (subcategoryVal) {
        sheet.getRange(targetRow, 41).setValue(subcategoryVal);
      }
      if (sizeVal) {
        sheet.getRange(targetRow, 42).setValue(sizeVal);
      }
      if (officialSkuVal) {
        sheet.getRange(targetRow, 43).setValue(officialSkuVal);
      }
    }

    // 仕入台帳のオークション等の商品番号の保存 (AR列: 44列目 / 全カテゴリ対象・任意)
    if (validatedAuctionItemNumber !== "") {
      writeAuctionItemNumberCell_(sheet, targetRow, validatedAuctionItemNumber);
    }

    if (options.includeImagesMeta) {
      const mirrorTitle = String(data.translated_title || "").trim();
      if (mirrorTitle) {
        updateProductTranslatedTitle_(productId, mirrorTitle);
      }
      if (Array.isArray(data.selected_image_ids) && data.selected_image_ids.length > 0 && typeof saveProductAiSelectedImageIds_ === "function") {
        saveProductAiSelectedImageIds_(sheet, productId, data.selected_image_ids, {
          skipDriveValidation: true
        });
      }
    }

    console.log(
      "Product registered:",
      productId
    );

    if (isImport && attemptsSheet && attemptRowIndex) {
      updateImportAttemptRecord_(attemptsSheet, attemptRowIndex, {
        status: "completed"
      });
    }

    // テスト用中断シミュレーション: 応答喪失（完了後に通信切断）
    if (interruptStage === "after_response_lost") {
      throw new Error("Simulated network drop after completion (response lost)");
    }

    // ------------------------------------------
    // レスポンス返却
    // ------------------------------------------
    if (options.includeImagesMeta) {
      return jsonResponse({
        success: true,
        version: "mirror-draft-create-v1",
        product_id: productId,
        created_at: createdAtDate.toISOString(),
        publish_status: "draft",
        inventory_status: "in_stock",
        record_status: "active",
        drive_folder_id: typeof productFolder.getId === "function" ? productFolder.getId() : "",
        drive_folder_url: folderUrl,
        main_image_url: mainImageUrl,
        image_count: imageUrls.length,
        images: createdImagesMeta,
        auction_item_number: validatedAuctionItemNumber
      });
    }

    if (isImport) {
      return jsonResponse({
        success: true,
        version: "product-import-v1",
        import_attempt_id: attemptId,
        product_id: productId,
        is_reused: !!options.isReused,
        status: "completed",
        publish_status: publishStatus,
        inventory_status: "in_stock",
        record_status: "active",
        drive_folder_id: typeof productFolder.getId === "function" ? productFolder.getId() : "",
        drive_folder_url: folderUrl,
        main_image_url: mainImageUrl,
        image_count: imageUrls.length,
        images: createdImagesMeta,
        auction_item_number: validatedAuctionItemNumber,
        created_at: createdAtDate.toISOString()
      });
    }

    // 従来のレスポンス (100% 後方互換性)
    return jsonResponse({
      success: true,
      version:
        "product-create-v2",
      product_id:
        productId,
      publish_status:
        publishStatus,
      inventory_status:
        "in_stock",
      drive_folder_url:
        folderUrl,
      main_image_url:
        mainImageUrl,
      image_count:
        imageUrls.length,
      auction_item_number:
        validatedAuctionItemNumber
    });

  } catch (originalError) {
    if (isImport && attemptsSheet && attemptRowIndex) {
      try {
        updateImportAttemptRecord_(attemptsSheet, attemptRowIndex, {
          status: "failed",
          error_message: originalError && originalError.message ? originalError.message : String(originalError)
        });
      } catch (_) {}
    }

    if (pokemonCardRecordCreated) {
      try {
        deletePokemonCardByProductId_(productId);
      } catch (rollbackError) {
        console.error(
          "Pokemon Card rollback failed for " +
          productId +
          ": " +
          rollbackError.message
        );
      }
    }

    throw originalError;
  }
}

// ==================================================
// 従来の新規商品登録 (後方互換入口)
// ==================================================

function handleCreateProduct(sheet, data) {
  return executeProductCreationCore_(sheet, data, { isImport: false });
}

// ==================================================
// Cloud Run + Supabase 正本からの下書き商品登録ミラー & Drive画像保存
// - 商品ID (TMP-XXXXXX) は Supabase 側で原子的に採番された reserved_product_id を受け取る
// - 常に publish_status = "draft" に固定（公開や Square 同期は一切行わない）
// - PRODUCT_ID_SEQUENCE を同期前進させ、GAS側の未移行登録とのID衝突を物理遮断する
// - 同一 request_id の再送時は冪等に既存 Drive 画像・本票情報を返却する
// ==================================================
function handleMirrorCreatedDraftProduct_(sheet, data, opts) {
  opts = opts || {};
  const reservedProductId = String(data && data.reserved_product_id || "").trim();
  const idMatch = reservedProductId.match(/^TMP-(\d{6,})$/);
  if (!idMatch) {
    return jsonResponse({
      success: false,
      error_code: "INVALID_RESERVED_PRODUCT_ID",
      message: "reserved_product_id must match TMP-XXXXXX"
    });
  }

  const reservedSequence = Number(idMatch[1]);
  if (!Number.isSafeInteger(reservedSequence) || reservedSequence < 1) {
    return jsonResponse({
      success: false,
      error_code: "INVALID_RESERVED_PRODUCT_ID",
      message: "reserved_product_id numeric sequence is invalid"
    });
  }

  const requestId = String(data && data.request_id || "").trim();
  const props = opts.propService || PropertiesService.getScriptProperties();
  const sequenceKey = "PRODUCT_ID_SEQUENCE";
  const storedRaw = String(props.getProperty(sequenceKey) || "").trim();
  const parsedStored = Number(storedRaw);
  const storedSequence = (/^\d+$/.test(storedRaw) && Number.isSafeInteger(parsedStored)) ? parsedStored : 0;

  let maxSheetSequence = 0;
  let existingRowIndex = -1;
  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    const idVals = sheet.getRange(2, 2, lastRow - 1, 1).getValues();
    for (let i = 0; i < idVals.length; i++) {
      const pid = String(idVals[i][0] || "").trim();
      if (pid === reservedProductId) {
        existingRowIndex = i + 2;
      }
      const m = pid.match(/^TMP-(\d+)$/);
      if (m) {
        const seq = Number(m[1]);
        if (Number.isSafeInteger(seq) && seq > maxSheetSequence) {
          maxSheetSequence = seq;
        }
      }
    }
  }

  const currentMaxSeq = Math.max(storedSequence, maxSheetSequence);

  // 既存行が既にある場合: 同一 request_id の再送なら冪等返却、別登録との競合なら再採番要求を返却
  if (existingRowIndex !== -1) {
    const reqPropKey = "MIRROR_CREATE_REQ_" + reservedProductId;
    const savedReqId = String(props.getProperty(reqPropKey) || "").trim();
    if (requestId && savedReqId === requestId) {
      const existingRow = sheet.getRange(existingRowIndex, 1, 1, 44).getValues()[0];
      const existingCreatedAt = existingRow[0] instanceof Date
        ? existingRow[0].toISOString()
        : String(existingRow[0] || new Date().toISOString());
      const existingFolderUrl = String(existingRow[29] || "").trim();
      const existingMainUrl = String(existingRow[30] || "").trim();
      const existingAuctionNum = formatAuctionItemNumber_(existingRow[43]);
      let existingImages = [];
      try {
        const builtDetail = buildProductDetail(existingRow, true, false);
        existingImages = (builtDetail && Array.isArray(builtDetail.images)) ? builtDetail.images : [];
      } catch (_) {
        existingImages = [];
      }
      return jsonResponse({
        success: true,
        version: "mirror-draft-create-v1",
        is_reused: true,
        product_id: reservedProductId,
        created_at: existingCreatedAt,
        publish_status: String(existingRow[31] || "draft").trim() || "draft",
        inventory_status: String(existingRow[32] || "in_stock").trim() || "in_stock",
        record_status: String(existingRow[33] || "active").trim() || "active",
        drive_folder_url: existingFolderUrl,
        main_image_url: existingMainUrl,
        image_count: existingImages.length,
        images: existingImages,
        auction_item_number: existingAuctionNum
      });
    }

    return jsonResponse({
      success: false,
      error_code: "PRODUCT_ID_ALREADY_IN_SHEETS",
      max_sheet_sequence: currentMaxSeq,
      message: "reserved_product_id already exists in Google Sheets"
    });
  }

  // 異常な大幅ジャンプによる採番シーケンス汚染を防止 (現在最大値 + 50 以内のみ許容)
  if (reservedSequence > currentMaxSeq + 50) {
    return jsonResponse({
      success: false,
      error_code: "RESERVED_PRODUCT_ID_OUT_OF_RANGE",
      max_sheet_sequence: currentMaxSeq,
      message: "reserved_product_id exceeds allowed monotonic window"
    });
  }

  // 先行して GAS 側の連番上限も予約値以上に更新し、同時実行の後続 GAS 登録との衝突を防ぐ
  const nextStoredSeq = Math.max(currentMaxSeq, reservedSequence);
  props.setProperty(sequenceKey, String(nextStoredSeq));

  const draftPayload = Object.assign({}, data, {
    publish_status: "draft"
  });

  const resp = executeProductCreationCore_(sheet, draftPayload, {
    isImport: false,
    existingProductId: reservedProductId,
    includeImagesMeta: true
  });

  if (requestId) {
    try {
      props.setProperty("MIRROR_CREATE_REQ_" + reservedProductId, requestId);
    } catch (_) {}
  }

  return resp;
}

// ==================================================
// 複数商品・画像インポート (新ルート入口)
//
// [認証境界の保護]
// - 現行の新規商品登録 (handleCreateProduct) と同等の公開境界を維持 (Readdy ブラウザ直接通信)。
// - 本ルートで取込まれる商品は、リクエスト内の指定値に関わらず常に publish_status="draft" に固定。
// - 公開ゲート (assertProductPublishable_) や Square Production 同期などの
//   管理者保護境界 (verifyAdminAccess_) をバイパスすることは一切できないため、
//   既存のセキュリティ境界を弱めることはない。
// ==================================================

function handleImportProductByImages(sheet, data, testOptions) {
  testOptions = testOptions || {};
  const attemptId = String(data && data.import_attempt_id || "").trim();
  if (!attemptId) {
    return jsonResponse({
      success: false,
      error_code: "IMPORT_ATTEMPT_ID_REQUIRED",
      message: "import_attempt_id is required"
    });
  }

  if (!Array.isArray(data.images) || data.images.length === 0) {
    return jsonResponse({
      success: false,
      error_code: "EMPTY_IMAGES",
      message: "images array is required and must not be empty"
    });
  }

  if (data.images.length > 20) {
    return jsonResponse({
      success: false,
      error_code: "MAX_IMAGE_COUNT_EXCEEDED",
      message: "maximum image count is 20"
    });
  }

  // 全画像の有効な base64 を台帳作成・採番前に検証 (空・不正な base64 を即時拒絶)
  for (let i = 0; i < data.images.length; i++) {
    const img = data.images[i];
    if (!img || typeof img !== "object") {
      return jsonResponse({
        success: false,
        error_code: "INVALID_IMAGE_PAYLOAD",
        message: "image at index " + i + " must be an object",
        import_attempt_id: attemptId
      });
    }
    const rawB64 = extractRawBase64_(img.base64);
    if (!rawB64) {
      return jsonResponse({
        success: false,
        error_code: "EMPTY_IMAGE_BASE64",
        message: "image at index " + i + " has empty base64 data",
        import_attempt_id: attemptId
      });
    }
    try {
      const decoded = Utilities.base64Decode(rawB64);
      if (!decoded || decoded.length === 0) {
        throw new Error("decoded byte length is 0");
      }
    } catch (e) {
      return jsonResponse({
        success: false,
        error_code: "INVALID_IMAGE_BASE64",
        message: "image at index " + i + " contains invalid base64 data: " + e.message,
        import_attempt_id: attemptId
      });
    }
  }

  let validatedImportAuctionItemNumber = "";
  if (data && Object.prototype.hasOwnProperty.call(data, "auction_item_number")) {
    try {
      validatedImportAuctionItemNumber = normalizeAuctionItemNumberInput_(data.auction_item_number);
    } catch (valErr) {
      return jsonResponse({
        success: false,
        error_code: valErr.error_code || "INVALID_AUCTION_ITEM_NUMBER",
        message: valErr.message,
        import_attempt_id: attemptId
      });
    }
  }

  // オプション: Cloud Run + Supabase 側で事前予約された商品ID (TMP-XXXXXX)
  const reservedProductId = String(data && data.reserved_product_id || "").trim();
  let reservedSequence = 0;
  if (reservedProductId) {
    const idMatch = reservedProductId.match(/^TMP-(\d{6,})$/);
    reservedSequence = idMatch ? Number(idMatch[1]) : 0;
    if (!idMatch || !Number.isSafeInteger(reservedSequence) || reservedSequence < 1) {
      return jsonResponse({
        success: false,
        error_code: "INVALID_RESERVED_PRODUCT_ID",
        message: "reserved_product_id must match TMP-XXXXXX",
        import_attempt_id: attemptId
      });
    }
  }

  // 新インポートの指紋計算: publish_status は常に draft 固定で算出
  const currentFingerprint = computeImportPayloadFingerprint_(data, true);
  const spreadsheet = typeof sheet.getParent === "function" ? sheet.getParent() : SpreadsheetApp.getActiveSpreadsheet();
  const attemptsSheet = getOrCreateImportAttemptsSheet_(spreadsheet);

  const existingRecord = findImportAttemptRecord_(attemptsSheet, attemptId);

  // 1. 同一 attempt_id の既存試行がある場合
  if (existingRecord) {
    // 指紋照合 (画像・順序・登録属性の不一致は即拒絶)
    if (existingRecord.payload_fingerprint !== currentFingerprint) {
      return jsonResponse({
        success: false,
        error_code: "IMPORT_IDEMPOTENCY_PAYLOAD_MISMATCH",
        message: "同一の import_attempt_id に対して異なる画像データまたは商品属性が送信されました。新規商品には新しい import_attempt_id を発行してください。",
        import_attempt_id: attemptId
      });
    }

    // 台帳 + 本票行 + Driveフォルダの照合
    const productId = existingRecord.product_id || reservedProductId;
    const existingRowIndex = productId ? findProductRowSafe_(sheet, productId) : null;
    const existingFolder = existingRecord.drive_folder_id ? findDriveFolderSafe_(existingRecord.drive_folder_id) : null;

    // 【重要】本票行が存在するのに Drive フォルダが欠損している場合は成功を返さずエラー (Fail-Closed)
    if (existingRowIndex !== null && existingFolder === null) {
      return jsonResponse({
        success: false,
        error_code: "IMPORT_DRIVE_FOLDER_NOT_FOUND",
        message: "登録対象のDriveフォルダが見つかりません。データ不整合のため処理を中断しました。",
        import_attempt_id: attemptId,
        product_id: productId
      });
    }

    // フォルダ内の非ゴミ箱ファイルを名前マップで収集 (自動ゴミ箱移動は行わない)
    const existingFilesByName = {};
    if (existingFolder && typeof existingFolder.getFiles === "function") {
      try {
        const files = existingFolder.getFiles();
        while (files && typeof files.hasNext === "function" && files.hasNext()) {
          const f = files.next();
          if (f && typeof f.isTrashed === "function" && f.isTrashed()) continue;
          if (f && typeof f.getName === "function") {
            const fname = f.getName();
            if (!existingFilesByName[fname]) {
              existingFilesByName[fname] = f;
            }
          }
        }
      } catch (_) {}
    }

    // 本票行が存在する場合 (完了済み再送、または行追加後・状態列前での回収): 全画像の完全実在・内容一致を必須とする
    if (existingRowIndex !== null) {
      const recoveredImagesMeta = [];
      for (let i = 0; i < data.images.length; i++) {
        const img = data.images[i];
        const originalName = img.file_name || "image.jpg";
        const expectedFileName = i === 0 ? "01_main_" + originalName : String(i + 1).padStart(2, "0") + "_" + originalName;
        const file = existingFilesByName[expectedFileName];

        if (!file) {
          return jsonResponse({
            success: false,
            error_code: "IMPORT_DRIVE_IMAGES_NOT_FOUND",
            message: "登録対象画像 (" + expectedFileName + ") がDriveフォルダ内に見つかりません。データ不整合のため処理を中断しました。",
            import_attempt_id: attemptId,
            product_id: productId
          });
        }

        if (!isDriveFileContentEqual_(file, img.base64)) {
          return jsonResponse({
            success: false,
            error_code: "IMPORT_DRIVE_IMAGE_CONTENT_MISMATCH",
            message: "Driveフォルダ内の画像 (" + expectedFileName + ") の内容が一致しません。データ不整合のため処理を中断しました。",
            import_attempt_id: attemptId,
            product_id: productId
          });
        }

        const fId = typeof file.getId === "function" ? file.getId() : "";
        const fMime = typeof file.getMimeType === "function"
          ? file.getMimeType()
          : (img.mime_type || "image/jpeg");
        const fUrl = typeof file.getUrl === "function" ? file.getUrl() : "";
        recoveredImagesMeta.push({
          file_id: fId,
          name: expectedFileName,
          mime_type: fMime || "image/jpeg",
          view_url: fUrl,
          display_url: fId ? ("https://drive.google.com/thumbnail?id=" + fId + "&sz=w1600") : ""
        });
      }

      // 地点4 (応答喪失) & 完了済み: 既に本票行・Driveフォルダ・台帳・全画像が揃っている場合
      if (existingRecord.status === "completed") {
        const pubVal = String(sheet.getRange(existingRowIndex, 32).getValue() || "draft");
        const invVal = String(sheet.getRange(existingRowIndex, 33).getValue() || "in_stock");
        const recVal = String(sheet.getRange(existingRowIndex, 34).getValue() || "active");
        const storedAuctionItemNo =
          (typeof sheet.getMaxColumns !== "function" || sheet.getMaxColumns() >= AUCTION_ITEM_NUMBER_COLUMN)
            ? formatAuctionItemNumber_(sheet.getRange(existingRowIndex, AUCTION_ITEM_NUMBER_COLUMN).getValue())
            : validatedImportAuctionItemNumber;

        return jsonResponse({
          success: true,
          version: "product-import-v1",
          import_attempt_id: attemptId,
          product_id: productId,
          is_reused: true,
          status: "completed",
          publish_status: pubVal,
          inventory_status: invVal,
          record_status: recVal,
          drive_folder_id: existingRecord.drive_folder_id || "",
          drive_folder_url: existingRecord.drive_folder_url,
          main_image_url: existingRecord.main_image_url,
          image_count: existingRecord.image_count,
          images: recoveredImagesMeta,
          auction_item_number: storedAuctionItemNo,
          created_at: String(existingRecord.created_at || "")
        });
      }

      // 地点2 (行追加後) または 地点3 (状態列書込み途中): 本票行と全画像が実在する場合
      // 本票行は既にあるので、appendRow は絶対に呼ばない！
      const pubRange = sheet.getRange(existingRowIndex, 32);
      const invRange = sheet.getRange(existingRowIndex, 33);
      const recRange = sheet.getRange(existingRowIndex, 34);

      // 新インポート時は常に draft 固定
      const targetPub = "draft";
      if (!pubRange.getValue()) pubRange.setValue(targetPub);
      if (!invRange.getValue()) invRange.setValue("in_stock");
      if (!recRange.getValue()) recRange.setValue("active");
      if (validatedImportAuctionItemNumber !== "") {
        writeAuctionItemNumberCell_(sheet, existingRowIndex, validatedImportAuctionItemNumber);
      }

      updateImportAttemptRecord_(attemptsSheet, existingRecord.rowIndex, {
        status: "completed"
      });

      return jsonResponse({
        success: true,
        version: "product-import-v1",
        import_attempt_id: attemptId,
        product_id: productId,
        is_reused: true,
        status: "completed",
        publish_status: pubRange.getValue() || targetPub,
        inventory_status: invRange.getValue() || "in_stock",
        record_status: recRange.getValue() || "active",
        drive_folder_id: existingRecord.drive_folder_id || "",
        drive_folder_url: existingRecord.drive_folder_url,
        main_image_url: existingRecord.main_image_url,
        image_count: existingRecord.image_count,
        images: recoveredImagesMeta,
        auction_item_number: validatedImportAuctionItemNumber,
        created_at: String(existingRecord.created_at || "")
      });
    }

    // 本票行が存在しない場合 (地点1: 画像保存途中での失敗後の再送 / 部分アップロードからの復旧):
    // 既存フォルダ内に同名で内容が異なる画像があれば安全のためエラー中断 (自動上書き・ゴミ箱移動を防止)
    if (existingRowIndex === null && existingFolder !== null) {
      for (let i = 0; i < data.images.length; i++) {
        const img = data.images[i];
        const originalName = img.file_name || "image.jpg";
        const expectedFileName = i === 0 ? "01_main_" + originalName : String(i + 1).padStart(2, "0") + "_" + originalName;
        const file = existingFilesByName[expectedFileName];
        if (file && !isDriveFileContentEqual_(file, img.base64)) {
          return jsonResponse({
            success: false,
            error_code: "IMPORT_DRIVE_IMAGE_CONTENT_MISMATCH",
            message: "既存Driveフォルダ内に同名で内容の異なる画像 (" + expectedFileName + ") が存在します。安全のため処理を中断しました。",
            import_attempt_id: attemptId,
            product_id: productId
          });
        }
      }
    }

    // 地点1 (画像保存途中): 本票行は未作成
    // 既存の productId を再利用し、Driveから再実行
    return executeProductCreationCore_(sheet, data, {
      isImport: true,
      importAttemptId: attemptId,
      attemptsSheet: attemptsSheet,
      attemptRowIndex: existingRecord.rowIndex,
      existingProductId: productId, // 予約済みIDを維持
      existingFolderId: existingRecord.drive_folder_id,
      fingerprint: currentFingerprint,
      interruptStage: testOptions.interruptStage || ""
    });
  }

  // 2. 新規の import_attempt_id の場合
  // Cloud Run 予約ID指定時は、台帳記録・Driveフォルダ作成より前にシート既存重複と単調増加幅を検証
  if (reservedProductId) {
    const props = testOptions.propService || PropertiesService.getScriptProperties();
    const sequenceKey = "PRODUCT_ID_SEQUENCE";
    const storedRaw = String(props.getProperty(sequenceKey) || "").trim();
    const parsedStored = Number(storedRaw);
    const storedSequence = (/^\d+$/.test(storedRaw) && Number.isSafeInteger(parsedStored)) ? parsedStored : 0;

    let maxSheetSequence = 0;
    let existingSheetRow = -1;
    const lastRow = sheet.getLastRow();
    if (lastRow >= 2) {
      const idVals = sheet.getRange(2, 2, lastRow - 1, 1).getValues();
      for (let i = 0; i < idVals.length; i++) {
        const pid = String(idVals[i][0] || "").trim();
        if (pid === reservedProductId) {
          existingSheetRow = i + 2;
        }
        const m = pid.match(/^TMP-(\d+)$/);
        if (m) {
          const seq = Number(m[1]);
          if (Number.isSafeInteger(seq) && seq > maxSheetSequence) {
            maxSheetSequence = seq;
          }
        }
      }
    }

    const currentMaxSeq = Math.max(storedSequence, maxSheetSequence);
    if (existingSheetRow !== -1) {
      return jsonResponse({
        success: false,
        error_code: "PRODUCT_ID_ALREADY_IN_SHEETS",
        max_sheet_sequence: currentMaxSeq,
        message: "reserved_product_id already exists in Google Sheets",
        import_attempt_id: attemptId
      });
    }
    if (reservedSequence > currentMaxSeq + 50) {
      return jsonResponse({
        success: false,
        error_code: "RESERVED_PRODUCT_ID_OUT_OF_RANGE",
        max_sheet_sequence: currentMaxSeq,
        message: "reserved_product_id exceeds allowed monotonic window",
        import_attempt_id: attemptId
      });
    }
    props.setProperty(sequenceKey, String(Math.max(currentMaxSeq, reservedSequence)));
  }

  const newRowIndex = saveNewImportAttemptRecord_(attemptsSheet, {
    attempt_id: attemptId,
    status: "initiated",
    payload_fingerprint: currentFingerprint,
    product_id: reservedProductId || ""
  });

  return executeProductCreationCore_(sheet, data, {
    isImport: true,
    importAttemptId: attemptId,
    attemptsSheet: attemptsSheet,
    attemptRowIndex: newRowIndex,
    existingProductId: reservedProductId || "",
    fingerprint: currentFingerprint,
    interruptStage: testOptions.interruptStage || ""
  });
}


// ==================================================
// 次の商品IDを発行
// ==================================================

function generateNextProductId(sheet) {
  const sequenceKey =
    "PRODUCT_ID_SEQUENCE";

  const scriptProperties =
    PropertiesService
      .getScriptProperties();

  const storedValue = String(
    scriptProperties.getProperty(
      sequenceKey
    ) || ""
  ).trim();

  const parsedStoredSequence =
    Number(storedValue);

  const storedSequence =
    /^\d+$/.test(storedValue) &&
    Number.isSafeInteger(
      parsedStoredSequence
    )
      ? parsedStoredSequence
      : 0;

  let maxSheetSequence = 0;

  const lastRow =
    sheet.getLastRow();

  if (lastRow >= 2) {
    const productIds =
      sheet
        .getRange(
          2,
          2,
          lastRow - 1,
          1
        )
        .getValues();

    productIds.forEach(row => {
      const match = String(
        row[0] || ""
      ).trim().match(
        /^TMP-(\d+)$/
      );

      if (!match) {
        return;
      }

      const sequence =
        Number(match[1]);

      if (
        Number.isSafeInteger(sequence) &&
        sequence > maxSheetSequence
      ) {
        maxSheetSequence = sequence;
      }
    });
  }

  const nextSequence =
    Math.max(
      storedSequence,
      maxSheetSequence
    ) + 1;

  scriptProperties.setProperty(
    sequenceKey,
    String(nextSequence)
  );

  return (
    "TMP-" +
    String(nextSequence).padStart(
      6,
      "0"
    )
  );
}


// ==================================================
// 商品IDからSheet行を検索
// ==================================================

function findProductRow(
  sheet,
  productId
) {

  const lastRow =
    sheet.getLastRow();


  if (lastRow < 2) {
    throw new Error(
      "product not found"
    );
  }


  // B列
  const productIds =
    sheet
      .getRange(
        2,
        2,
        lastRow - 1,
        1
      )
      .getValues();


  const index =
    productIds.findIndex(
      row =>
        String(
          row[0]
        ).trim() ===
        productId
    );


  if (index === -1) {
    throw new Error(
      "product not found"
    );
  }


  // Sheet実行番号
  return index + 2;
}


// ==================================================
// 画像名から既存の番号prefixを除去
// ==================================================

function removeImagePrefix(name) {

  return String(name)

    .replace(
      /^\d{2}_main_/,
      ""
    )

    .replace(
      /^\d{2}_/,
      ""
    );
}
/**
 * 書類操作用の管理者アクセス検証
 * ADMIN_API_KEY が未設定の環境、またはキー未送信時でも mode=admin が指定されていれば管理画面・中継からの操作を許可する。
 * （設定がある場合に誤ったキーが送信された場合は遮断する）
 * @param {Object} params リクエストパラメータ
 * @param {Object} [propService] テスト用プロパティサービスモック
 * @return {boolean}
 */
function verifyDocumentAdminAccess_(params, propService) {
  const mode = String(params && params.mode || "").trim();
  if (mode !== "admin") {
    return false;
  }

  try {
    const props = propService || PropertiesService.getScriptProperties();
    const expectedKey = String(
      props.getProperty("ADMIN_API_KEY") || ""
    ).trim();

    if (expectedKey) {
      const providedKey = String(
        (params && (params.admin_key || params.token || params.key)) || ""
      ).trim();
      if (providedKey && providedKey !== expectedKey) {
        return false;
      }
    }
    return true;
  } catch (err) {
    return true;
  }
}

/**
 * 管理者アクセスの検証 (Fail-Closed)
 * mode=admin に加え、ADMIN_API_KEY が Script Properties に定義されていることを必須とし、
 * 提供されたキー（admin_key, token 等）を照合して認証する。
 * ADMIN_API_KEY が未設定の場合、または取得例外が発生した場合は Fail-Closed (false) で拒否する。
 * @param {Object} params リクエストパラメータ
 * @param {Object} [propService] テスト用プロパティサービスモック（省略時は PropertiesService.getScriptProperties()）
 * @return {boolean}
 */
function verifyAdminAccess_(params, propService) {
  const mode = String(params && params.mode || "").trim();
  if (mode !== "admin") {
    return false;
  }

  try {
    const props = propService || PropertiesService.getScriptProperties();
    const expectedKey = String(
      props.getProperty("ADMIN_API_KEY") || ""
    ).trim();

    if (!expectedKey) {
      console.warn("[Auth] ADMIN_API_KEY is not configured in Script Properties. Denying admin access (Fail-Closed).");
      return false;
    }

    const providedKey = String(
      (params && (params.admin_key || params.token || params.key)) || ""
    ).trim();

    return providedKey.length > 0 && providedKey === expectedKey;
  } catch (err) {
    console.error("[Auth] Exception during admin verification (Fail-Closed):", err);
    return false;
  }
}

function doGet(e, testOptions) {
  const perfStart = Date.now();
  try {
    const params = (e && e.parameter) || {};
    const productId =
      String(params.product_id || "").trim();

    const category =
      String(params.category || "").trim();

    const mode =
      String(params.mode || "").trim();

    // ★追加 (record_status, publish_status, inventory_status, search, sort, pagination)
    const recordStatus =
      String(params.record_status || params.recordStatus || "").trim();

    const publishStatus =
      String(params.publish_status || params.publishStatus || "").trim();

    const inventoryStatus =
      String(params.inventory_status || params.inventoryStatus || "").trim();

    const searchQuery =
      String(params.search || params.q || "").trim();

    const sortKey =
      String(params.sort || params.sort_by || params.sortBy || "default").trim();

    const rawPage = params.page;
    const rawPageSize = params.page_size !== undefined ? params.page_size : params.pageSize;
    const isPaginated =
      rawPage !== undefined ||
      rawPageSize !== undefined ||
      searchQuery !== "" ||
      publishStatus !== "" ||
      inventoryStatus !== "" ||
      (sortKey !== "" && sortKey !== "default");

    // 既存管理画面 (Readdy) の後方互換性を100%維持するため、既存doGetのisAdminはmode === "admin"を維持
    const isAdmin = mode === "admin";
    // AIドラフト詳細情報へのアクセス権限（キー検証成功時のみ許可）
    const hasAdminAuth = verifyAdminAccess_(params, testOptions && testOptions.propService);

    const sheet = (testOptions && testOptions.sheet) || SpreadsheetApp
      .getActiveSpreadsheet()
      .getSheets()[0];

    // ==================================================
    // 0-00. 商品添付書類取得 (管理画面専用・公開API非公開)
    // ==================================================
    if (params.action === "get_product_document") {
      if (!isAdmin) {
        return jsonResponse({
          success: false,
          error_code: "UNAUTHORIZED_ADMIN_ACCESS",
          message: "Admin mode required to access product document"
        });
      }
      if (!productId) {
        return jsonResponse({
          success: false,
          error_code: "PRODUCT_ID_REQUIRED",
          message: "product_id is required"
        });
      }
      const doc = getProductDocumentRecord(productId);
      return jsonResponse({
        success: true,
        product_id: productId,
        document: doc ? {
          product_id: doc.product_id,
          file_id: doc.file_id,
          document_type: doc.document_type,
          original_file_name: doc.original_file_name,
          mime_type: doc.mime_type,
          file_size: doc.file_size,
          created_at: doc.created_at,
          view_url: doc.view_url,
          open_url: doc.view_url
        } : null
      });
    }

    // ==================================================
    // 0-0. AI一括ドラフト進捗取得 (管理者認証必須)
    // ==================================================
    if (params.action === "get_ai_product_draft_batch") {
      if (!verifyAdminAccess_(params, testOptions && testOptions.propService)) {
        return jsonResponse({
          success: false,
          error_code: "UNAUTHORIZED_ADMIN_ACCESS",
          message: "Admin authentication required to access AI batch details"
        });
      }
      return handleGetAiProductDraftBatch(params);
    }

    // ==================================================
    // 0-0b. 商品別 AI解析用選択画像ID取得 (管理画面専用)
    // ==================================================
    if (params.action === "get_product_ai_selected_images") {
      if (!isAdmin) {
        return jsonResponse({
          success: false,
          error_code: "UNAUTHORIZED_ADMIN_ACCESS",
          message: "Admin mode required to access selected AI images"
        });
      }
      if (!productId) {
        return jsonResponse({
          success: false,
          error_code: "PRODUCT_ID_REQUIRED",
          message: "product_id is required"
        });
      }
      const selectedIds = typeof getProductAiSelectedImageIds_ === "function"
        ? getProductAiSelectedImageIds_(productId)
        : [];
      return jsonResponse({
        success: true,
        product_id: productId,
        selected_image_ids: selectedIds,
        ai_selected_image_ids: selectedIds
      });
    }

    // ==================================================
    // 0. AIドラフト詳細取得 (AI機能専用: 管理者認証必須・公開API非公開)
    // ==================================================
    if (params.action === "get_ai_product_draft") {
      if (!verifyAdminAccess_(params, testOptions && testOptions.propService)) {
        return jsonResponse({
          success: false,
          error_code: "UNAUTHORIZED_ADMIN_ACCESS",
          message: "Admin authentication required to access AI draft details"
        });
      }
      if (!productId) {
        return jsonResponse({
          success: false,
          error_code: "PRODUCT_ID_REQUIRED",
          message: "product_id is required"
        });
      }
      const draft = getLatestProductAiDraft_(productId);
      return jsonResponse({
        success: true,
        product_id: productId,
        latest_ai_draft: draft
      });
    }

    // ==================================================
    // 0-1. Square Catalog SKU状態確認 (管理者専用・安全なREAD ONLY検査)
    // ==================================================
    if (params.action === "inspect_square_sku" && isAdmin) {
      const sku = String(params.sku || productId || "").trim();
      if (!sku) {
        return jsonResponse({
          success: false,
          error: "sku or product_id is required"
        });
      }
      const inspection = inspectSquareProductionProductBySku_(sku);
      return jsonResponse(inspection);
    }

    // ==================================================
    // 0-2. Square Production 状態照合・検出 (管理者認証必須・安全なREAD ONLY検査)
    // ==================================================
    if (params.action === "reconcile_square_product_status") {
      if (!verifyAdminAccess_(params, testOptions && testOptions.propService)) {
        return jsonResponse({
          success: false,
          error_code: "UNAUTHORIZED_ADMIN_ACCESS",
          message: "Admin authentication required to reconcile Square product status"
        });
      }
      const targetPid = String(params.product_id || productId || "").trim();
      if (!targetPid) {
        return jsonResponse({
          success: false,
          error: "product_id is required"
        });
      }
      const reconciliation = reconcileSquareProductionProductStatus(
        targetPid,
        Object.assign({}, testOptions, { sheet: sheet })
      );
      return jsonResponse(reconciliation);
    }

    // ==================================================
    // 0-3. 商品シート列数・ヘッダー確認 (管理者専用)
    // ==================================================
    if (params.action === "inspect_product_sheet_columns" && isAdmin) {
      if (typeof inspectProductSheetColumns_ === "function") {
        return jsonResponse(inspectProductSheetColumns_());
      }
      return jsonResponse({ success: false, error: "inspectProductSheetColumns_ not available" });
    }

    // ==================================================
    // 0-4. 商品シート列数・ヘッダー設定 (管理者専用)
    // ==================================================
    if (params.action === "setup_product_sheet_columns" && isAdmin) {
      if (typeof setupProductSheetColumns_ === "function") {
        return jsonResponse(setupProductSheetColumns_());
      }
      return jsonResponse({ success: false, error: "setupProductSheetColumns_ not available" });
    }

    // ==================================================
    // 0-5. カテゴリ拡張テスト実行 (管理者専用)
    // ==================================================
    if (params.action === "run_category_expansion_tests" && isAdmin) {
      if (typeof runCategoryExpansionTests_ === "function") {
        return jsonResponse(runCategoryExpansionTests_());
      }
      return jsonResponse({ success: false, error: "runCategoryExpansionTests_ not available" });
    }

    // ==================================================
    // 0-6. Driveファイル操作テスト実行 (管理者専用)
    // ==================================================
    if (params.action === "run_drive_file_operations_tests" && isAdmin) {
      if (typeof runDriveFileOperationsTests_ === "function") {
        return jsonResponse(runDriveFileOperationsTests_());
      }
      return jsonResponse({ success: false, error: "runDriveFileOperationsTests_ not available" });
    }

    // ==================================================
    // 0-7. オークション等の商品番号契約テスト実行 (管理者専用)
    // ==================================================
    if (params.action === "run_auction_item_number_tests" && isAdmin) {
      if (typeof runAuctionItemNumberTests_ === "function") {
        return jsonResponse(runAuctionItemNumberTests_());
      }
      return jsonResponse({ success: false, error: "runAuctionItemNumberTests_ not available" });
    }

    // ==================================================
    // 0-7. AI一括生成 選択画像テスト実行 (管理者専用)
    // ==================================================
    if (params.action === "run_ai_batch_selected_images_tests" && isAdmin) {
      if (typeof runAiBatchSelectedImagesTests_ === "function") {
        return jsonResponse(runAiBatchSelectedImagesTests_());
      }
      return jsonResponse({ success: false, error: "runAiBatchSelectedImagesTests_ not available" });
    }

    // ==================================================
    // 0-8. AI一括生成 カテゴリ拡張・原価反映テスト実行 (管理者専用)
    // ==================================================
    if (params.action === "run_ai_batch_category_cost_tests" && isAdmin) {
      if (typeof runAiBatchCategoryCostTests_ === "function") {
        return jsonResponse(runAiBatchCategoryCostTests_());
      }
      return jsonResponse({ success: false, error: "runAiBatchCategoryCostTests_ not available" });
    }



    // ==================================================
    // 1. 商品詳細取得
    // ==================================================
    //
    // 公開サイト:
    // ?product_id=TMP-000006
    //
    // 管理画面:
    // ?mode=admin&product_id=TMP-000006
    //
    // ==================================================

    if (productId) {
      const tSheetStart = Date.now();
      const lastRow = sheet.getLastRow();

      if (lastRow < 2) {
        console.log("[PERF] doGet total: " + (Date.now() - perfStart) + "ms (mode=" + mode + ", product_id=" + productId + ", not_found)");
        return jsonResponse({
          success: false,
          error: "product not found",
          product_id: productId
        });
      }

      // B列 (列2) のみを取得して対象行を高速検索
      const idValues = sheet.getRange(2, 2, lastRow - 1, 1).getValues();
      let targetRowIndex = -1;
      for (let i = 0; i < idValues.length; i++) {
        if (String(idValues[i][0] || "").trim() === productId) {
          targetRowIndex = i + 2; // 1-based sheet row number
          break;
        }
      }

      if (targetRowIndex === -1) {
        console.log("[PERF] sheet read (id scan): " + (Date.now() - tSheetStart) + "ms (not found)");
        console.log("[PERF] doGet total: " + (Date.now() - perfStart) + "ms (mode=" + mode + ", product_id=" + productId + ", not_found)");
        return jsonResponse({
          success: false,
          error: "product not found",
          product_id: productId
        });
      }

      // 対象1行のみ取得
      const maxSheetCols = typeof sheet.getMaxColumns === "function"
        ? sheet.getMaxColumns()
        : Math.max(sheet.getLastColumn(), AUCTION_ITEM_NUMBER_COLUMN);
      const fetchColCount = Math.min(Math.max(sheet.getLastColumn(), AUCTION_ITEM_NUMBER_COLUMN), maxSheetCols);
      const row = sheet.getRange(targetRowIndex, 1, 1, fetchColCount).getValues()[0];
      console.log("[PERF] sheet read (single row): " + (Date.now() - tSheetStart) + "ms (row=" + targetRowIndex + ", product_id=" + productId + ")");

      const publishStatus =
        String(row[31] || "").trim();

      const inventoryStatus =
        String(row[32] || "in_stock").trim();

      // ★追加
      const productRecordStatus =
        String(row[33] || "active").trim();

      // 公開サイトから取得する場合は、
      // published + in_stock + active の商品のみ許可
      if (
        !isAdmin &&
        (
          publishStatus !== "published" ||
          inventoryStatus !== "in_stock" ||
          productRecordStatus !== "active"
        )
      ) {
        console.log("[PERF] doGet total: " + (Date.now() - perfStart) + "ms (mode=" + mode + ", product_id=" + productId + ", forbidden_public)");
        return jsonResponse({
          success: false,
          error: "product not found",
          product_id: productId
        });
      }

      const product =
        buildProductDetail(row, isAdmin, hasAdminAuth);

      if (isAdmin) {
        product.square_item_id =
          String(row[34] || "").trim();

        product.square_variation_id =
          String(row[35] || "").trim();

        product.square_payment_link_id =
          String(row[36] || "").trim();

        product.square_checkout_url =
          String(row[37] || "").trim();
      }

      product.translation =
        getProductTranslation(productId);

      console.log("[PERF] doGet total: " + (Date.now() - perfStart) + "ms (mode=" + mode + ", product_id=" + productId + ")");
      return jsonResponse({
        success: true,
        version: isAdmin
          ? "admin-product-detail-v1"
          : "product-read-v4",
        product: product
      });
    }

    // ==================================================
    // 2. 一覧取得 (商品マスター全件読み込み)
    // ==================================================

    const tSheetAllStart = Date.now();
    const values =
      sheet.getDataRange().getValues();

    const rows = values.slice(1);
    console.log("[PERF] sheet read (all rows): " + (Date.now() - tSheetAllStart) + "ms (count=" + rows.length + ")");

    // ==================================================
    // 2. 管理画面用の商品一覧
    // ==================================================
    //
    // ?mode=admin
    //
    // または
    //
    // ?mode=admin&category=sneaker
    //
    // ==================================================

    if (isAdmin) {
      let adminRows = rows;

      // 1. record_status (既定: active)
      const requestedRecordStatus = recordStatus || "active";
      if (requestedRecordStatus !== "all") {
        adminRows = adminRows.filter(
          r => String(r[33] || "active").trim() === requestedRecordStatus
        );
      }

      // 2. category (カテゴリ絞り込み: sneaker, jewelry, pokemon_card, other 等)
      if (category && category !== "all") {
        adminRows = adminRows.filter(
          r => String(r[2] || "").trim() === category
        );
      }

      // 3. publish_status (公開状態: draft, published, hidden 等)
      if (publishStatus && publishStatus !== "all") {
        adminRows = adminRows.filter(
          r => String(r[31] || "draft").trim() === publishStatus
        );
      }

      // 4. inventory_status (在庫状態: in_stock, out_of_stock 等)
      if (inventoryStatus && inventoryStatus !== "all") {
        adminRows = adminRows.filter(
          r => String(r[32] || "in_stock").trim() === inventoryStatus
        );
      }

      // 5. search (商品名・商品ID・ブランド・オークション等の商品番号の部分一致、大文字小文字無視、空白区切りAND検索)
      if (searchQuery) {
        const terms = searchQuery.toLowerCase().split(/\s+/).filter(Boolean);
        adminRows = adminRows.filter(r => {
          const haystack = (
            String(r[4] || "") +
            " " +
            String(r[1] || "") +
            " " +
            String(r[3] || "") +
            " " +
            formatAuctionItemNumber_(r[43])
          ).toLowerCase();
          return terms.every(term => haystack.indexOf(term) !== -1);
        });
      }

      // 6. 並び替え (既定の順序、登録日時の新旧、予定販売価格の高低、商品名の昇降)
      if (sortKey === "default" || !sortKey) {
        // 既定の順序: シート追加の新しい順（従来の reverse と同一）
        adminRows = adminRows.slice().reverse();
      } else {
        adminRows = adminRows.slice().sort((a, b) => compareAdminProductRows_(a, b, sortKey));
      }

      const totalMatched = adminRows.length;

      // 7. 従来互換モード (ページネーション・新検索パラメータが一切指定されていない場合)
      if (!isPaginated) {
        const transMap = getProductTranslationsMap_();
        const selectedImagesMap = typeof getProductAiSelectedImagesMap_ === "function" ? getProductAiSelectedImagesMap_() : {};
        const products = adminRows.map(row => buildAdminProductSummary(row, transMap, selectedImagesMap));
        console.log(
          "[PERF] doGet total: " +
            (Date.now() - perfStart) +
            "ms (mode=admin, legacy unpaginated, count=" +
            products.length +
            ")"
        );
        return jsonResponse({
          success: true,
          version: "admin-product-list-v2",
          category: category || "all",
          record_status: requestedRecordStatus,
          count: products.length,
          products: products
        });
      }

      // 8. ページ切り出し (新契約: 既定50件、上限100件、同値商品は商品ID等で順序固定)
      let page = parseInt(rawPage, 10);
      if (isNaN(page) || page < 1) page = 1;

      let pageSize = parseInt(rawPageSize, 10);
      if (isNaN(pageSize) || pageSize < 1) {
        pageSize = 50; // MVP 既定値
      } else if (pageSize > 100) {
        pageSize = 100; // MVP 上限値
      }

      const totalPages = totalMatched === 0 ? 0 : Math.ceil(totalMatched / pageSize);

      let pageRows = [];
      if (totalMatched > 0 && page <= totalPages) {
        const startIndex = (page - 1) * pageSize;
        const endIndex = Math.min(startIndex + pageSize, totalMatched);
        pageRows = adminRows.slice(startIndex, endIndex);
      }

      // ページ内の商品のみ詳細/サマリーを組み立て (ページ外商品は組み立てない)
      const transMap = getProductTranslationsMap_();
      const selectedImagesMap = typeof getProductAiSelectedImagesMap_ === "function" ? getProductAiSelectedImagesMap_() : {};
      const products = pageRows.map(row => buildAdminProductSummary(row, transMap, selectedImagesMap));

      console.log(
        "[PERF] doGet total: " +
          (Date.now() - perfStart) +
          "ms (mode=admin, paginated, page=" +
          page +
          "/" +
          totalPages +
          ", count=" +
          totalMatched +
          ", returned=" +
          products.length +
          ")"
      );
      return jsonResponse({
        success: true,
        version: "admin-product-list-v3",
        category: category || "all",
        record_status: requestedRecordStatus,
        publish_status: publishStatus || "all",
        inventory_status: inventoryStatus || "all",
        search: searchQuery,
        sort: sortKey,
        count: totalMatched,
        page: page,
        page_size: pageSize,
        total_pages: totalPages,
        products: products
      });
    }

    // ==================================================
    // 3. 公開サイト用カテゴリ一覧
    // ==================================================
    //
    // ?category=sneaker
    //
    // publishedだけ返す
    //
    // ==================================================

    if (category) {
      const products =
        rows
          .filter(
            r =>
              // カテゴリ
              String(r[2]).trim() === category &&

              // AF = 公開中
              String(r[31]).trim() === "published" &&

              // AG = 在庫あり
              String(r[32] || "in_stock").trim() === "in_stock" &&

              // AH = アクティブ
              String(r[33] || "active").trim() === "active"
          )
          .map(row =>
            buildProductSummary(row)
          );

      console.log("[PERF] doGet total: " + (Date.now() - perfStart) + "ms (category=" + category + ", count=" + products.length + ")");
      return jsonResponse({
        success: true,
        version: "product-list-v4",
        category: category,
        count: products.length,
        products: products
      });
    }

    // ==================================================
    // 4. パラメータ不足
    // ==================================================

    console.log("[PERF] doGet total: " + (Date.now() - perfStart) + "ms (missing params)");
    return jsonResponse({
      success: false,
      error:
        "product_id, category, or mode=admin is required"
    });

  } catch (error) {
    console.error("[PERF] doGet error: " + (Date.now() - perfStart) + "ms", error);
    return jsonResponse({
      success: false,
      error: String(error)
    });
  }
}


function buildProductSummary(row) {
  return {
    product_id: row[1],
    category: row[2],
    brand: row[3],
    product_name: row[4],
    condition: row[5],

    planned_sale_price: row[7],

    description: row[9],

    sneaker_sku: row[11],
    sneaker_size: row[12],
    sneaker_colorway: row[13],

    subcategory: String(row[40] || "").trim(),
    sub_category: String(row[40] || "").trim(),
    size: String(row[41] || "").trim(),
    official_sku: String(row[42] || "").trim(),
    sku: String(row[42] || "").trim(),

    // Drive閲覧URL
    main_image_url: row[30] || "",

    // 商品一覧で <img src=""> に使うURL
    main_image_display_url:
      convertDriveFileUrlToDisplayUrl(row[30] || "")
  };
}

/**
 * product_translations シートから product_id -> translated_title のマッピングを一括取得する。
 * N+1問題を回避し、1回のシート走査で最新の英文タイトルを取得する。
 * @return {!Object<string, string>} product_id をキー、translated_title を値とするオブジェクト
 */
function getProductTranslationsMap_() {
  const tStart = Date.now();
  const map = {};
  try {
    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    if (!spreadsheet) return map;

    const translationSheet = spreadsheet.getSheetByName("product_translations");
    if (!translationSheet) {
      console.log("[PERF] getProductTranslationsMap_ (sheet not found): " + (Date.now() - tStart) + "ms");
      return map;
    }

    const lastRow = translationSheet.getLastRow();
    const lastColumn = translationSheet.getLastColumn();
    if (lastRow < 2 || lastColumn < 1) {
      console.log("[PERF] getProductTranslationsMap_ (empty sheet): " + (Date.now() - tStart) + "ms");
      return map;
    }

    const headers = translationSheet
      .getRange(1, 1, 1, lastColumn)
      .getValues()[0]
      .map(h => String(h || "").trim());

    const productIdIdx = headers.indexOf("product_id");
    const titleIdx = headers.indexOf("translated_title");

    if (productIdIdx === -1 || titleIdx === -1) {
      return map;
    }

    const rows = translationSheet
      .getRange(2, 1, lastRow - 1, lastColumn)
      .getValues();

    // 順序走査: シート末尾に向かって走査し、最新レコードで上書き
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const pId = String(row[productIdIdx] || "").trim();
      const title = String(row[titleIdx] || "").trim();
      if (pId && title) {
        map[pId] = title;
      }
    }
    console.log("[PERF] getProductTranslationsMap_: " + (Date.now() - tStart) + "ms (count=" + Object.keys(map).length + ")");
  } catch (err) {
    console.warn("getProductTranslationsMap_ error:", err);
  }
  return map;
}

function buildAdminProductSummary(row, translationMapOrTitle, selectedImagesMap) {
  const mainImageUrl =
    row[30] || "";

  const productId =
    String(row[1] || "").trim();

  let translatedTitle = "";
  if (typeof translationMapOrTitle === "string") {
    translatedTitle = translationMapOrTitle;
  } else if (translationMapOrTitle && typeof translationMapOrTitle === "object") {
    translatedTitle = String(translationMapOrTitle[productId] || "").trim();
  }

  let selectedImageIds = [];
  if (selectedImagesMap && typeof selectedImagesMap === "object" && Array.isArray(selectedImagesMap[productId])) {
    selectedImageIds = selectedImagesMap[productId];
  } else if (!selectedImagesMap && typeof getProductAiSelectedImageIds_ === "function" && productId) {
    selectedImageIds = getProductAiSelectedImageIds_(productId);
  }

  return {
    created_at:
      row[0] instanceof Date
        ? row[0].toISOString()
        : row[0],

    product_id:
      productId,

    category:
      row[2] || "",

    brand:
      row[3] || "",

    product_name:
      row[4] || "",

    translated_title:
      translatedTitle,

    condition:
      row[5] || "",

    purchase_price:
      row[6] || 0,

    planned_sale_price:
      row[7] || 0,

    storage_location:
      row[8] || "",

    subcategory:
      String(row[40] || "").trim(),
    sub_category:
      String(row[40] || "").trim(),
    size:
      String(row[41] || "").trim(),
    official_sku:
      String(row[42] || "").trim(),
    sku:
      String(row[42] || "").trim(),

    auction_item_number:
      formatAuctionItemNumber_(row[43]),

    sneaker_sku:
      row[11] || "",

    sneaker_size:
      row[12] || "",

    drive_folder_url:
      row[29] || "",

    inventory_status:
    String(row[32] || "in_stock").trim(),

    main_image_url:
      mainImageUrl,

    main_image_display_url:
      convertDriveFileUrlToDisplayUrl(
        mainImageUrl
      ),

    // AF列
    publish_status:
      String(row[31] || "draft").trim(),
    record_status:
      String(row[33] || "active").trim(),

    square_item_id:
      String(row[34] || "").trim(),
    square_variation_id:
      String(row[35] || "").trim(),
    square_payment_link_id:
      String(row[36] || "").trim(),
    square_checkout_url:
      String(row[37] || "").trim(),

    selected_image_ids:
      selectedImageIds,
    ai_selected_image_ids:
      selectedImageIds
  };
}

function parseRowTimeToEpoch_(val) {
  if (!val) return -Infinity;
  if (val instanceof Date) {
    const t = val.getTime();
    return isNaN(t) ? -Infinity : t;
  }
  const t = new Date(val).getTime();
  return isNaN(t) ? -Infinity : t;
}

function parseRowPriceToNumber_(val) {
  if (val === null || val === undefined || val === "") return -Infinity;
  if (typeof val === "number") return isFinite(val) ? val : -Infinity;
  const cleaned = String(val).replace(/,/g, "").trim();
  const num = Number(cleaned);
  return (!isNaN(num) && isFinite(num)) ? num : -Infinity;
}

function compareStringsDeterministic_(a, b) {
  const strA = String(a || "").trim();
  const strB = String(b || "").trim();
  try {
    return strA.localeCompare(strB, "ja", { numeric: true, sensitivity: "base" });
  } catch (e) {
    return strA < strB ? -1 : (strA > strB ? 1 : 0);
  }
}

function compareAdminProductRows_(a, b, sortKey) {
  const idA = String(a[1] || "").trim();
  const idB = String(b[1] || "").trim();
  const idCmp = compareStringsDeterministic_(idA, idB);

  switch (sortKey) {
    case "created_desc": {
      const tA = parseRowTimeToEpoch_(a[0]);
      const tB = parseRowTimeToEpoch_(b[0]);
      if (tB !== tA) return tB - tA;
      return idCmp;
    }
    case "created_asc": {
      const tA = parseRowTimeToEpoch_(a[0]);
      const tB = parseRowTimeToEpoch_(b[0]);
      if (tA !== tB) return tA - tB;
      return idCmp;
    }
    case "price_desc": {
      const pA = parseRowPriceToNumber_(a[7]);
      const pB = parseRowPriceToNumber_(b[7]);
      if (pB !== pA) return pB - pA;
      return idCmp;
    }
    case "price_asc": {
      const pA = parseRowPriceToNumber_(a[7]);
      const pB = parseRowPriceToNumber_(b[7]);
      if (pA !== pB) return pA - pB;
      return idCmp;
    }
    case "name_asc": {
      const nameA = String(a[4] || "").trim();
      const nameB = String(b[4] || "").trim();
      const nameCmp = compareStringsDeterministic_(nameA, nameB);
      if (nameCmp !== 0) return nameCmp;
      return idCmp;
    }
    case "name_desc": {
      const nameA = String(a[4] || "").trim();
      const nameB = String(b[4] || "").trim();
      const nameCmp = compareStringsDeterministic_(nameB, nameA);
      if (nameCmp !== 0) return nameCmp;
      return idCmp;
    }
    case "default":
    default:
      return idCmp;
  }
}


const PRODUCT_CACHE_EXPIRATION_SEC = 600; // 10分 (600秒)

function clearProductCache_(productId) {
  const normalizedId = String(productId || "").trim();
  if (!normalizedId) return;

  try {
    const cache = CacheService.getScriptCache();
    cache.removeAll([
      "prod_images_" + normalizedId,
      "prod_trans_" + normalizedId,
      "prod_poke_" + normalizedId
    ]);
  } catch (err) {
    console.warn("clearProductCache_ error:", err);
  }
}

function clearProductImageCache_(productId) {
  const normalizedId = String(productId || "").trim();
  if (!normalizedId) return;
  try {
    CacheService.getScriptCache().remove("prod_images_" + normalizedId);
  } catch (err) {
    console.warn("clearProductImageCache_ error:", err);
  }
}

function clearProductTranslationCache_(productId) {
  const normalizedId = String(productId || "").trim();
  if (!normalizedId) return;
  try {
    CacheService.getScriptCache().remove("prod_trans_" + normalizedId);
  } catch (err) {
    console.warn("clearProductTranslationCache_ error:", err);
  }
}


function buildProductDetail(row, isAdmin, hasAdminAuth) {
  const tBuildStart = Date.now();
  const productId = String(row[1] || "").trim();
  const driveFolderUrl = row[29] || "";
  const storedMainImageUrl = row[30] || "";

  let images = [];

  if (driveFolderUrl) {
    const tDriveStart = Date.now();
    const imageCacheKey = "prod_images_" + productId;
    let cachedImages = null;

    if (productId) {
      try {
        const cachedStr = CacheService.getScriptCache().get(imageCacheKey);
        if (cachedStr) {
          cachedImages = JSON.parse(cachedStr);
        }
      } catch (cErr) {
        console.warn("image cache read error:", cErr);
      }
    }

    if (cachedImages && Array.isArray(cachedImages)) {
      images = cachedImages;
      console.log("[PERF] drive images cache HIT: " + (Date.now() - tDriveStart) + "ms (product_id=" + productId + ", count=" + images.length + ")");
    } else {
      let scanSucceeded = false;
      try {
        const folderId = extractDriveFolderId(driveFolderUrl);

        if (folderId) {
          const folder = DriveApp.getFolderById(folderId);
          const files = folder.getFiles();
          const docFileIds = getProductDocumentFileIds_(productId);

          while (files.hasNext()) {
            const file = files.next();
            if (docFileIds.has(file.getId())) continue;
            if (typeof file.isTrashed === "function" && file.isTrashed()) continue;
            const mimeType = file.getMimeType();

            if (mimeType.startsWith("image/")) {
              images.push({
                file_id: file.getId(),
                name: file.getName(),
                mime_type: mimeType,
                view_url: file.getUrl(),
                display_url:
                  "https://drive.google.com/thumbnail?id=" +
                  file.getId() +
                  "&sz=w1600"
              });
            }
          }

          images.sort((a, b) =>
            a.name.localeCompare(b.name, "ja", {
              numeric: true,
              sensitivity: "base"
            })
          );

          scanSucceeded = true;
        }
      } catch (driveError) {
        console.log("Drive image read error:", driveError);
      }

      if (productId && scanSucceeded) {
        try {
          CacheService.getScriptCache().put(imageCacheKey, JSON.stringify(images), PRODUCT_CACHE_EXPIRATION_SEC);
        } catch (cPutErr) {
          console.warn("image cache put error:", cPutErr);
        }
      }
      console.log("[PERF] drive images scan: " + (Date.now() - tDriveStart) + "ms (product_id=" + productId + ", count=" + images.length + ", cached=" + scanSucceeded + ")");
    }
  }

  const product = {
    created_at:
      row[0] instanceof Date
        ? row[0].toISOString()
        : row[0],

    product_id: row[1],
    category: row[2],
    brand: row[3],
    product_name: row[4],
    condition: row[5],

    purchase_price: row[6],
    planned_sale_price: row[7],
    storage_location: row[8],

    description: row[9],
    notes: row[10],

    sneaker_sku: row[11],
    sneaker_size: row[12],
    sneaker_colorway: row[13],
    sneaker_box: row[14],
    sneaker_accessories: row[15],
    sneaker_release_year: row[16],

    jewelry_type: row[17],
    jewelry_material: row[18],
    carat: row[19],
    shape: row[20],
    color_grade: row[21],
    clarity: row[22],
    cut: row[23],
    main_stone: row[24],
    jewelry_size: row[25],
    weight_g: row[26],
    certificate_available: row[27],
    certificate_number: row[28],

    subcategory: String(row[40] || "").trim(),
    sub_category: String(row[40] || "").trim(),
    size: String(row[41] || "").trim(),
    official_sku: String(row[42] || "").trim(),
    sku: String(row[42] || "").trim(),

    drive_folder_url: driveFolderUrl,
    main_image_url: storedMainImageUrl,

    publish_status:
      String(row[31] || "draft").trim(),
    
    inventory_status:
    String(row[32] || "in_stock").trim(),

    record_status:
    String(row[33] || "active").trim(),

    square_item_id:
      String(row[34] || "").trim(),
    square_variation_id:
      String(row[35] || "").trim(),
    square_payment_link_id:
      String(row[36] || "").trim(),
    square_checkout_url:
      String(row[37] || "").trim(),

    images: images
  };

  const normalizedCategory =
    String(row[2] || "").trim();

  if (normalizedCategory === "pokemon_card") {
    let pokemonCard = null;
    try {
      pokemonCard = getPokemonCardByProductId(row[1]);
    } catch (pkmErr) {
      console.warn(
        "[Product Detail] Could not load pokemon_card record for " +
        row[1] + ": " + pkmErr.message
      );
    }
    // 要件: ポケカ専用レコードがなくても基本情報を返す
    product.pokemon_card = pokemonCard || null;
    product.card_condition = pokemonCard ? (pokemonCard.card_condition || "") : "";
  }

  // 管理画面 (mode=admin) の場合、スタッフが選択したAI解析用画像ID一覧および仕入台帳の商品番号を返す
  if (isAdmin) {
    const selectedImageIds = typeof getProductAiSelectedImageIds_ === "function"
      ? getProductAiSelectedImageIds_(productId)
      : [];
    product.selected_image_ids = selectedImageIds;
    product.ai_selected_image_ids = selectedImageIds;
    product.auction_item_number = formatAuctionItemNumber_(row[43]);
  }

  // AIドラフトステータス属性の付与
  // 指示: キーなしのmode=adminで商品を取得できても、latest_ai_draft・AI候補・確認者情報は返さない
  // 正しい管理者キー認証 (hasAdminAuth) が検証された場合のみAI情報を付与
  if (hasAdminAuth) {
    const aiDraftFlag = String(row[39] || "").trim(); // AN列 (40)
    product.ai_draft_flag = aiDraftFlag;

    if (aiDraftFlag === "ai_managed") {
      try {
        const latestDraft = getLatestProductAiDraft_(productId);
        if (latestDraft) {
          product.ai_review_status = latestDraft.review_status;
          product.latest_ai_draft = latestDraft;
        } else {
          product.ai_review_status = "missing_history";
        }
      } catch (_) {
        product.ai_review_status = "error";
      }
    } else {
      product.ai_review_status = "not_ai_managed";
    }
  }

  // 商品添付書類 (管理画面 mode=admin 時に付与・商品公開ページには非表示)
  if (isAdmin) {
    let docRecord = null;
    try {
      docRecord = getProductDocumentRecord(productId);
    } catch (docErr) {
      console.warn("[Product Detail] Could not load document for " + productId + ":", docErr);
    }
    if (docRecord) {
      product.document = {
        product_id: docRecord.product_id,
        file_id: docRecord.file_id,
        document_type: docRecord.document_type,
        original_file_name: docRecord.original_file_name,
        mime_type: docRecord.mime_type,
        file_size: docRecord.file_size,
        created_at: docRecord.created_at,
        view_url: docRecord.view_url,
        open_url: docRecord.view_url
      };
    } else {
      product.document = null;
    }
  }

  console.log("[PERF] buildProductDetail: " + (Date.now() - tBuildStart) + "ms (product_id=" + productId + ")");
  return product;
}


function convertDriveFileUrlToDisplayUrl(url) {
  if (!url) return "";

  const match = String(url).match(
    /\/file\/d\/([a-zA-Z0-9_-]+)/
  );

  if (!match) return "";

  return (
    "https://drive.google.com/thumbnail?id=" +
    match[1] +
    "&sz=w800"
  );
}


function extractDriveFolderId(url) {
  if (!url) return "";

  const match = String(url).match(
    /\/folders\/([a-zA-Z0-9_-]+)/
  );

  return match ? match[1] : "";
}


// ==================================================
// 商品の最新翻訳データを取得
// product_translations シートから該当 product_id の最新レコードを検索
// 存在しない場合は null を返却
// ==================================================

function getProductTranslation(productId) {
  const tTransStart = Date.now();
  const normalizedProductId =
    String(productId || "").trim();

  if (!normalizedProductId) {
    return null;
  }

  try {
    const cachedStr = CacheService.getScriptCache().get("prod_trans_" + normalizedProductId);
    if (cachedStr) {
      if (cachedStr === "__null__") {
        console.log("[PERF] getProductTranslation cache HIT (null): " + (Date.now() - tTransStart) + "ms (product_id=" + normalizedProductId + ")");
        return null;
      }
      const parsed = JSON.parse(cachedStr);
      console.log("[PERF] getProductTranslation cache HIT: " + (Date.now() - tTransStart) + "ms (product_id=" + normalizedProductId + ")");
      return parsed;
    }
  } catch (cErr) {
    console.warn("translation cache read error:", cErr);
  }

  const spreadsheet =
    SpreadsheetApp.getActiveSpreadsheet();

  const translationSheet =
    spreadsheet.getSheetByName("product_translations");

  if (!translationSheet) {
    console.log("[PERF] getProductTranslation (sheet not found): " + (Date.now() - tTransStart) + "ms");
    return null;
  }

  const lastRow = translationSheet.getLastRow();
  const lastColumn = translationSheet.getLastColumn();

  if (lastRow < 2 || lastColumn < 1) {
    try {
      CacheService.getScriptCache().put("prod_trans_" + normalizedProductId, "__null__", PRODUCT_CACHE_EXPIRATION_SEC);
    } catch (_) {}
    console.log("[PERF] getProductTranslation (empty sheet): " + (Date.now() - tTransStart) + "ms");
    return null;
  }

  const headers = translationSheet
    .getRange(1, 1, 1, lastColumn)
    .getValues()[0]
    .map(h => String(h || "").trim());

  const productIdIdx = headers.indexOf("product_id");
  const localeIdx = headers.indexOf("locale");
  const titleIdx = headers.indexOf("translated_title");
  const descIdx = headers.indexOf("translated_description");
  const conditionIdx = headers.indexOf("translated_condition");
  const boxIdx = headers.indexOf("translated_box");
  const accessoriesIdx = headers.indexOf("translated_accessories");
  const statusIdx = headers.indexOf("translation_status");
  const generatedAtIdx = headers.indexOf("generated_at");

  if (productIdIdx === -1) {
    return null;
  }

  // 末尾行から逆順に走査して最新レコードを検索
  const rows = translationSheet
    .getRange(2, 1, lastRow - 1, lastColumn)
    .getValues();

  let translation = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    const rowProductId = String(row[productIdIdx] || "").trim();

    if (rowProductId === normalizedProductId) {
      const generatedAtVal = generatedAtIdx !== -1 ? row[generatedAtIdx] : "";
      const generatedAt = generatedAtVal instanceof Date
        ? generatedAtVal.toISOString()
        : String(generatedAtVal || "").trim();

      translation = {
        product_id: rowProductId,
        locale: localeIdx !== -1 ? String(row[localeIdx] || "en").trim() : "en",
        translated_title: titleIdx !== -1 ? String(row[titleIdx] || "").trim() : "",
        translated_description: descIdx !== -1 ? String(row[descIdx] || "").trim() : "",
        translated_condition: conditionIdx !== -1 ? String(row[conditionIdx] || "").trim() : "",
        translated_box: boxIdx !== -1 ? String(row[boxIdx] || "").trim() : "",
        translated_accessories: accessoriesIdx !== -1 ? String(row[accessoriesIdx] || "").trim() : "",
        translation_status: statusIdx !== -1 ? String(row[statusIdx] || "draft").trim() : "draft",
        generated_at: generatedAt
      };
      break;
    }
  }

  try {
    if (translation) {
      CacheService.getScriptCache().put("prod_trans_" + normalizedProductId, JSON.stringify(translation), PRODUCT_CACHE_EXPIRATION_SEC);
    } else {
      CacheService.getScriptCache().put("prod_trans_" + normalizedProductId, "__null__", PRODUCT_CACHE_EXPIRATION_SEC);
    }
  } catch (cPutErr) {
    console.warn("translation cache put error:", cPutErr);
  }

  console.log("[PERF] getProductTranslation: " + (Date.now() - tTransStart) + "ms (product_id=" + normalizedProductId + ", found=" + (translation !== null) + ")");
  return translation;
}


// ==================================================
// 商品の最新翻訳ステータスを "approved" に更新
// product_translations シートから該当 product_id の最新レコードを検索し、
// translation_status 列を上書き更新
// ==================================================

function approveProductTranslation(productId) {
  const normalizedProductId =
    String(productId || "").trim();

  if (!normalizedProductId) {
    throw new Error("product_id is required");
  }

  const spreadsheet =
    SpreadsheetApp.getActiveSpreadsheet();

  const translationSheet =
    spreadsheet.getSheetByName("product_translations");

  if (!translationSheet) {
    throw new Error("product_translations sheet not found");
  }

  const lastRow = translationSheet.getLastRow();
  const lastColumn = translationSheet.getLastColumn();

  if (lastRow < 2 || lastColumn < 1) {
    throw new Error("no translation records found");
  }

  const headers = translationSheet
    .getRange(1, 1, 1, lastColumn)
    .getValues()[0]
    .map(h => String(h || "").trim());

  const productIdIdx = headers.indexOf("product_id");
  const statusIdx = headers.indexOf("translation_status");

  if (productIdIdx === -1) {
    throw new Error("product_id column not found in product_translations");
  }

  if (statusIdx === -1) {
    throw new Error("translation_status column not found in product_translations");
  }

  // 末尾行から逆順に走査して最新レコードを検索
  const rows = translationSheet
    .getRange(2, 1, lastRow - 1, lastColumn)
    .getValues();

  let targetRowIndex = -1;

  for (let i = rows.length - 1; i >= 0; i--) {
    const rowProductId = String(rows[i][productIdIdx] || "").trim();

    if (rowProductId === normalizedProductId) {
      targetRowIndex = i + 2; // シート上の行番号 (1-based, 2行目スタート)
      break;
    }
  }

  if (targetRowIndex === -1) {
    throw new Error(`translation not found for product_id: ${normalizedProductId}`);
  }

  // translation_status 列（1-based なので statusIdx + 1）を "approved" に上書き更新
  translationSheet
    .getRange(targetRowIndex, statusIdx + 1)
    .setValue("approved");

  clearProductTranslationCache_(normalizedProductId);

  return {
    success: true,
    product_id: normalizedProductId,
    translation_status: "approved",
    updated_row: targetRowIndex
  };
}


function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}


// ==================================================
// Square API 設定
// ==================================================



// ==================================================
// Square API 共通HTTPリクエスト
// ==================================================



// ==================================================
// Square Sandbox Catalog READ ONLY 接続テスト
// Apps Scriptエディタから手動実行
// ==================================================



// ==================================================
// Square Production ListLocations READ ONLY 接続テスト
// Apps Scriptエディタから手動実行
// ==================================================



// ==================================================
// Square Production 共通HTTPリクエスト（テスト専用内部helper）
// ==================================================

/**
 * Square Production API への直接リクエスト用内部helper
 *
 * 既存のSQUARE_ENVやSandbox設定と完全に分離し、
 * SQUARE_PROD_ACCESS_TOKEN を使用して https://connect.squareup.com へ通信する。
 *
 * @param {string} path APIパス (例: "/v2/catalog/object")
 * @param {Object} [options] リクエスト設定
 * @param {string} [options.method] HTTPメソッド ("get", "post", "delete" 等)
 * @param {Object|string} [options.payload] 送信データ
 * @param {boolean} [options.allowError] trueの場合、2xx以外でも例外をスローせずレスポンスを返却
 * @return {{ httpStatus: number, body: string }}
 */
function squareProdRequest_(path, options) {
  const scriptProperties = PropertiesService.getScriptProperties();

  const prodAccessToken = String(
    scriptProperties.getProperty("SQUARE_PROD_ACCESS_TOKEN") || ""
  ).trim();

  const apiVersion = String(
    scriptProperties.getProperty("SQUARE_API_VERSION") || ""
  ).trim();

  if (!prodAccessToken) {
    throw new Error("SQUARE_PROD_ACCESS_TOKEN is required");
  }
  if (!apiVersion) {
    throw new Error("SQUARE_API_VERSION is required");
  }

  const normalizedPath = String(path || "").startsWith("/")
    ? String(path)
    : "/" + String(path || "");

  const requestOptions = options || {};
  const fetchOptions = {
    method: String(requestOptions.method || "get").toLowerCase(),
    headers: {
      Authorization: "Bearer " + prodAccessToken,
      "Square-Version": apiVersion,
      "Content-Type": "application/json"
    },
    muteHttpExceptions: true
  };

  if (Object.prototype.hasOwnProperty.call(requestOptions, "payload")) {
    fetchOptions.payload =
      typeof requestOptions.payload === "string"
        ? requestOptions.payload
        : JSON.stringify(requestOptions.payload);
  }

  const response = UrlFetchApp.fetch(
    "https://connect.squareup.com" + normalizedPath,
    fetchOptions
  );

  const httpStatus = response.getResponseCode();
  const responseBody = response.getContentText();

  if (
    !requestOptions.allowError &&
    (httpStatus < 200 || httpStatus >= 300)
  ) {
    const safeResponseBody = responseBody
      .split(prodAccessToken)
      .join("[REDACTED]");

    throw new Error(
      "Square Production API request (" +
      fetchOptions.method.toUpperCase() +
      " " +
      normalizedPath +
      ") failed with HTTP " +
      httpStatus +
      ": " +
      safeResponseBody
    );
  }

  return {
    httpStatus: httpStatus,
    body: responseBody
  };
}


// ==================================================
// Square Production Catalog CREATE / RETRIEVE / DELETE E2E手動テスト
// Apps Scriptエディタから手動実行
// ==================================================



// ==================================================
// Square Production Catalog Item / Variation 表示構築ヘルパー
// ==================================================

/**
 * Square description_html 用 HTML 特殊文字エスケープ
 *
 * @param {*} str 対象文字列
 * @return {string} エスケープ済み文字列
 */
function escapeSquareHtml_(str) {
  if (str === null || str === undefined) {
    return "";
  }
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Square description_html 生成ヘルパー
 *
 * スペック/状態ブロックとBIS商品説明本文ブロックを安全なHTML（<p>, <br>）で構成する。
 * description_plaintext はSquare側で自動同期生成されるため書き込まない。
 *
 * @param {Array<string>} infoLines スペック・状態行配列
 * @param {string} rawDescription BIS商品説明本文
 * @return {string} 生成された description_html 文字列
 */
function buildSquareDescriptionHtml_(infoLines, rawDescription) {
  const blocks = [];

  const validInfoLines = (infoLines || [])
    .filter(line => line !== null && line !== undefined && String(line).trim() !== "")
    .map(line => escapeSquareHtml_(line));

  if (validInfoLines.length > 0) {
    blocks.push("<p>" + validInfoLines.join("<br>") + "</p>");
  }

  const trimmedDesc = String(rawDescription || "").trim();
  if (trimmedDesc) {
    const escapedDesc = escapeSquareHtml_(trimmedDesc).replace(/\r?\n/g, "<br>");
    blocks.push("<p>" + escapedDesc + "</p>");
  }

  return blocks.join("\n");
}

/**
 * スニーカー用 Square 表示情報構築
 *
 * @param {Object} product BIS元データ
 * @return {{ itemName: string, variationName: string, descriptionHtml: string }}
 */
function buildSquareSneakerDisplay_(product, sneakerOptions) {
  const rawSize = String(product.sneaker_size || "").trim();
  let displaySize = "";
  if (rawSize) {
    displaySize = rawSize.toLowerCase().endsWith("cm") ? rawSize : (rawSize + " cm");
  }

  // Item Options が存在する場合は、Squareの自動命名規則（オプション値のカンマ区切り）に合わせる
  let variationName = "";
  if (sneakerOptions && sneakerOptions.expectedVariationName) {
    variationName = sneakerOptions.expectedVariationName;
  } else {
    variationName = displaySize || "Regular";
  }

  const itemName = String(product.product_name || "").trim() || String(product.product_id || "").trim();

  const infoLines = [];
  if (displaySize) {
    infoLines.push("【サイズ】 " + displaySize);
  }
  if (product.condition && String(product.condition).trim()) {
    infoLines.push("【状態】 " + String(product.condition).trim());
  }
  infoLines.push("【商品番号】 " + String(product.product_id || "").trim());

  const descriptionHtml = buildSquareDescriptionHtml_(infoLines, product.description);

  return {
    itemName: itemName,
    variationName: variationName,
    descriptionHtml: descriptionHtml
  };
}

/**
 * ポケモンカード用 Square 表示情報構築
 *
 * 実在する pokemon_cards シート定義（card_name, set_name, card_number, rarity, language,
 * grading_status, grader, grade, certification_number, card_condition）のみを使用。
 *
 * @param {Object} product BIS元データ (pokemon_card オブジェクト含む)
 * @return {{ itemName: string, variationName: string, descriptionHtml: string }}
 */
function buildSquarePokemonCardDisplay_(product) {
  const pkm = product.pokemon_card || null;
  const itemName = String(product.product_name || "").trim() || String(product.product_id || "").trim();

  let variationName = "Regular";
  const infoLines = [];

  if (pkm) {
    const isGraded = pkm.grading_status === "graded";

    // 1. 状態
    if (isGraded) {
      const graderGrade = [pkm.grader, pkm.grade].filter(Boolean).join(" ").trim();
      const statusText = graderGrade ? ("鑑定済 (" + graderGrade + ")") : "鑑定済";
      infoLines.push("【状態】 " + statusText);
      variationName = graderGrade || "Graded";
    } else {
      const cond = pkm.card_condition || product.condition || "";
      const statusText = cond ? ("未鑑定 (" + cond + ")") : "未鑑定";
      infoLines.push("【状態】 " + statusText);
      variationName = cond || "Regular";
    }

    // 2. 商品番号
    infoLines.push("【商品番号】 " + String(product.product_id || "").trim());

    // 3. カード固有の購入判断情報 (実在フィールドのみ)
    if (isGraded) {
      const graderGrade = [pkm.grader, pkm.grade].filter(Boolean).join(" ").trim();
      if (graderGrade) {
        infoLines.push("【鑑定】 " + graderGrade);
      }
      if (pkm.certification_number) {
        infoLines.push("【証明番号】 " + pkm.certification_number);
      }
    }
    if (pkm.card_name) {
      infoLines.push("【カード名】 " + pkm.card_name);
    }
    if (pkm.set_name) {
      infoLines.push("【収録セット】 " + pkm.set_name);
    }
    if (pkm.card_number) {
      infoLines.push("【カード番号】 " + pkm.card_number);
    }
    if (pkm.rarity) {
      infoLines.push("【レアリティ】 " + pkm.rarity);
    }
    if (pkm.language) {
      infoLines.push("【言語】 " + pkm.language);
    }

  } else {
    // pokemon_cards シート未登録時のフォールバック
    if (product.condition && String(product.condition).trim()) {
      infoLines.push("【状態】 " + String(product.condition).trim());
      variationName = String(product.condition).trim();
    }
    infoLines.push("【商品番号】 " + String(product.product_id || "").trim());
  }

  const descriptionHtml = buildSquareDescriptionHtml_(infoLines, product.description);

  return {
    itemName: itemName,
    variationName: variationName,
    descriptionHtml: descriptionHtml
  };
}

/**
 * デフォルト（その他カテゴリ）用 Square 表示情報構築
 *
 * @param {Object} product BIS元データ
 * @return {{ itemName: string, variationName: string, descriptionHtml: string }}
 */
function buildSquareDefaultDisplay_(product) {
  const itemName = String(product.product_name || "").trim() || String(product.product_id || "").trim();
  let variationName = "Regular";

  if (product.jewelry_size && String(product.jewelry_size).trim()) {
    const rawJSize = String(product.jewelry_size).trim();
    variationName = rawJSize.endsWith("号") ? rawJSize : (rawJSize + "号");
  }

  const infoLines = [];
  if (product.condition && String(product.condition).trim()) {
    infoLines.push("【状態】 " + String(product.condition).trim());
  }
  infoLines.push("【商品番号】 " + String(product.product_id || "").trim());

  const descriptionHtml = buildSquareDescriptionHtml_(infoLines, product.description);

  return {
    itemName: itemName,
    variationName: variationName,
    descriptionHtml: descriptionHtml
  };
}

/**
 * Square 商品表示情報ディスパッチャー
 *
 * @param {Object} product BIS元データ
 * @return {{ itemName: string, variationName: string, descriptionHtml: string }}
 */
/**
 * アパレル・ファッション小物用 Square 表示情報構築
 *
 * @param {Object} product BIS元データ
 * @return {{ itemName: string, variationName: string, descriptionHtml: string }}
 */
function buildSquareApparelFashionDisplay_(product) {
  const itemName = String(product.product_name || "").trim() || String(product.product_id || "").trim();
  let variationName = "Regular";

  // サイズが指定されている場合は Variation 名にサイズを反映、未指定時は "Regular"
  if (product.size && String(product.size).trim()) {
    variationName = String(product.size).trim();
  }

  const infoLines = [];
  if (product.brand && String(product.brand).trim()) {
    infoLines.push("【ブランド】 " + String(product.brand).trim());
  }
  if (product.condition && String(product.condition).trim()) {
    infoLines.push("【状態】 " + String(product.condition).trim());
  }
  if (product.size && String(product.size).trim()) {
    infoLines.push("【サイズ】 " + String(product.size).trim());
  }
  if (product.official_sku && String(product.official_sku).trim()) {
    infoLines.push("【品番】 " + String(product.official_sku).trim());
  }
  infoLines.push("【商品番号】 " + String(product.product_id || "").trim());

  const descriptionHtml = buildSquareDescriptionHtml_(infoLines, product.description);

  return {
    itemName: itemName,
    variationName: variationName,
    descriptionHtml: descriptionHtml
  };
}

function buildSquareProductDisplay_(product, sneakerOptions) {
  if (!product) {
    throw new Error("product object is required for buildSquareProductDisplay_");
  }

  const category = String(product.category || "").trim().toLowerCase();

  if (category === "sneaker") {
    return buildSquareSneakerDisplay_(product, sneakerOptions);
  } else if (category === "pokemon_card") {
    return buildSquarePokemonCardDisplay_(product);
  } else if (category === "apparel" || category === "fashion_goods") {
    return buildSquareApparelFashionDisplay_(product);
  } else {
    return buildSquareDefaultDisplay_(product);
  }
}

/**
 * Square連携用のBIS商品元データを取得・正規化する内部helper
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet メインシート
 * @param {string} productId 正規化済みBIS商品ID
 * @return {Object} BIS元データオブジェクト
 */
function getSquareProductSourceData_(sheet, productId) {
  const normalizedProductId = String(productId || "").trim();
  if (!normalizedProductId) {
    throw new Error("product_id is required");
  }

  const targetRow = findProductRow(sheet, normalizedProductId);
  const maxCols = Math.min(Math.max(sheet.getLastColumn(), 43), sheet.getMaxColumns());
  const row = sheet.getRange(targetRow, 1, 1, maxCols).getValues()[0];

  const category = String(row[2] || "").trim();
  let pokemonCard = null;

  if (category === "pokemon_card") {
    try {
      pokemonCard = getPokemonCardByProductId(normalizedProductId);
    } catch (pkmErr) {
      console.warn(
        "Could not load pokemon_card record for " + normalizedProductId + ":",
        pkmErr
      );
    }
  }

  return {
    targetRow: targetRow,
    product_id: normalizedProductId,
    category: category,
    brand: String(row[3] || "").trim(),
    product_name: String(row[4] || "").trim(),
    condition: String(row[5] || "").trim(),
    planned_sale_price: Number(row[7] || 0),
    description: String(row[9] || "").trim(),
    sneaker_size: String(row[12] || "").trim(),
    jewelry_size: String(row[25] || "").trim(),
    subcategory: String(row[40] || "").trim(),
    size: String(row[41] || "").trim(),
    official_sku: String(row[42] || "").trim(),
    square_item_id: String(row[34] || "").trim(),
    square_variation_id: String(row[35] || "").trim(),
    square_payment_link_id: String(row[36] || "").trim(),
    square_checkout_url: String(row[37] || "").trim(),
    pokemon_card: pokemonCard
  };
}


// ==================================================
// Square Production Item Options (サイズ / 状態) 連携
// ==================================================

/**
 * スニーカーサイズ表記を Square Item Option Value 用に正規化
 * 例: "29" -> "29.0", "28.5" -> "28.5", "28.0" -> "28.0"
 *
 * @param {string|number} rawSize 元のサイズ値
 * @return {string} 正規化されたサイズ文字列 (例: "29.0")
 */
function formatSquareSneakerSizeOptionValue_(rawSize) {
  const s = String(rawSize || "").trim().replace(/\s*cm$/i, "");
  const num = Number(s);
  if (!isNaN(num) && num > 0) {
    return num.toFixed(1);
  }
  return s;
}

/**
 * Square Catalog から ITEM_OPTION を name / display_name で検索して解決する。
 * ScriptProperties をキャッシュとして活用する。
 *
 * @param {string} optionName 検索するオプション名 (例: "サイズ", "状態")
 * @return {Object} Square CatalogItemOption オブジェクト (type: "ITEM_OPTION")
 */
function resolveSquareItemOption_(optionName) {
  const normalizedName = String(optionName || "").trim();
  if (!normalizedName) {
    throw new Error("optionName is required");
  }

  const scriptProperties = PropertiesService.getScriptProperties();
  const cacheKey = "SQUARE_CACHE_OPTION_ID_" + (
    normalizedName === "サイズ" ? "SIZE" :
    normalizedName === "状態" ? "CONDITION" :
    encodeURIComponent(normalizedName)
  );

  const cachedId = String(scriptProperties.getProperty(cacheKey) || "").trim();

  // 1. キャッシュIDが存在する場合、GET で実在と名前の一致を確認
  if (cachedId) {
    try {
      const getRes = squareProdRequest_(
        "/v2/catalog/object/" + encodeURIComponent(cachedId),
        { method: "get", allowError: true }
      );
      if (getRes.httpStatus === 200) {
        const body = JSON.parse(getRes.body || "{}");
        const obj = body.object;
        if (
          obj &&
          obj.type === "ITEM_OPTION" &&
          obj.item_option_data &&
          (String(obj.item_option_data.name || "").trim() === normalizedName ||
           String(obj.item_option_data.display_name || "").trim() === normalizedName)
        ) {
          return obj;
        }
      }
    } catch (e) {
      console.warn("Cached option verification failed for " + normalizedName + ": " + e.message);
    }
    // キャッシュ無効化
    try {
      scriptProperties.deleteProperty(cacheKey);
    } catch (_) {}
  }

  // 2. Square Catalog から ITEM_OPTION を一覧取得して検索 (GET /v2/catalog/list?types=ITEM_OPTION)
  const listRes = squareProdRequest_(
    "/v2/catalog/list?types=ITEM_OPTION",
    { method: "get" }
  );

  let listData;
  try {
    listData = JSON.parse(listRes.body || "{}");
  } catch (_) {
    throw new Error("Square Catalog list ITEM_OPTION returned invalid JSON");
  }

  const objects = Array.isArray(listData.objects) ? listData.objects : [];
  const found = objects.find(obj => {
    if (!obj || obj.type !== "ITEM_OPTION" || !obj.item_option_data) {
      return false;
    }
    const name = String(obj.item_option_data.name || "").trim();
    const displayName = String(obj.item_option_data.display_name || "").trim();
    return name === normalizedName || displayName === normalizedName;
  });

  if (found) {
    try {
      scriptProperties.setProperty(cacheKey, found.id);
    } catch (err) {
      console.warn("Failed to cache option ID for " + normalizedName + ": " + err.message);
    }
    return found;
  }

  // 3. 存在しない場合は新規作成 (POST /v2/catalog/object)
  const tempOptionId = "#ais-opt-" + Utilities.getUuid();
  const createPayload = {
    idempotency_key: "ais-sq-opt-create-" + encodeURIComponent(normalizedName) + "-" + Utilities.getUuid(),
    object: {
      type: "ITEM_OPTION",
      id: tempOptionId,
      item_option_data: {
        name: normalizedName,
        display_name: normalizedName
      }
    }
  };

  const createRes = squareProdRequest_("/v2/catalog/object", {
    method: "post",
    payload: createPayload
  });

  let createData;
  try {
    createData = JSON.parse(createRes.body || "{}");
  } catch (_) {
    throw new Error("Square Catalog create ITEM_OPTION returned invalid JSON");
  }

  const createdObj = createData.catalog_object;
  if (!createdObj || createdObj.type !== "ITEM_OPTION" || !createdObj.id) {
    throw new Error("Failed to create ITEM_OPTION in Square for: " + normalizedName);
  }

  try {
    scriptProperties.setProperty(cacheKey, createdObj.id);
  } catch (err) {
    console.warn("Failed to cache newly created option ID: " + err.message);
  }

  return createdObj;
}

/**
 * 既存の ITEM_OPTION に新しい値 (ITEM_OPTION_VAL) を安全に追加する。
 * Square の Upsert は full-replacement semantics であるため、
 * 既存の values を完全保持した上で新 value を追加し、完全オブジェクトで Upsert する。
 *
 * @param {Object} optionObject Square ITEM_OPTION カタログオブジェクト
 * @param {string} valueName 追加する値の名前 (例: "29.0", "新品・未使用")
 * @return {{
 *   optionId: string,
 *   valueId: string,
 *   isNew: boolean
 * }}
 */
function addSquareItemOptionValueSafely_(optionObject, valueName) {
  const normalizedValue = String(valueName || "").trim();
  if (!normalizedValue) {
    throw new Error("valueName is required for addSquareItemOptionValueSafely_");
  }
  if (!optionObject || optionObject.type !== "ITEM_OPTION" || !optionObject.id) {
    throw new Error("Invalid optionObject provided to addSquareItemOptionValueSafely_");
  }

  // 最新の ITEM_OPTION を GET して既存 values と version を確実に取得
  const getRes = squareProdRequest_(
    "/v2/catalog/object/" + encodeURIComponent(optionObject.id),
    { method: "get" }
  );

  let getData;
  try {
    getData = JSON.parse(getRes.body || "{}");
  } catch (_) {
    throw new Error("Failed to GET latest ITEM_OPTION: " + optionObject.id);
  }

  const latestOption = getData.object;
  if (!latestOption || latestOption.type !== "ITEM_OPTION") {
    throw new Error("Retrieved object is not an ITEM_OPTION: " + optionObject.id);
  }

  const itemOptionData = latestOption.item_option_data || {};
  const existingValues = Array.isArray(itemOptionData.values)
    ? itemOptionData.values
    : [];

  // 念のため再チェック：既に値が存在するか
  const alreadyExists = existingValues.find(v =>
    v &&
    v.item_option_value_data &&
    String(v.item_option_value_data.name || "").trim() === normalizedValue
  );

  if (alreadyExists && alreadyExists.id) {
    return {
      optionId: latestOption.id,
      valueId: alreadyExists.id,
      isNew: false
    };
  }

  // 完全オブジェクト Upsert のためのクローン & サニタイズ
  const cloned = JSON.parse(JSON.stringify(latestOption));

  // Option 直下の read-only 項目を除去
  delete cloned.updated_at;
  delete cloned.created_at;
  delete cloned.is_deleted;
  delete cloned.catalog_v1_ids;

  cloned.item_option_data = cloned.item_option_data || {};
  cloned.item_option_data.values = cloned.item_option_data.values || [];

  // 既存 values の read-only 項目を除去（既存valuesの完全保持）
  cloned.item_option_data.values.forEach(function(v) {
    if (v) {
      delete v.updated_at;
      delete v.created_at;
      delete v.is_deleted;
      delete v.catalog_v1_ids;
    }
  });

  // 新 value オブジェクトの作成
  const tempValId = "#ais-val-" + Utilities.getUuid();
  const nextOrdinal = cloned.item_option_data.values.length;

  cloned.item_option_data.values.push({
    type: "ITEM_OPTION_VAL",
    id: tempValId,
    item_option_value_data: {
      item_option_id: cloned.id,
      name: normalizedValue,
      ordinal: nextOrdinal
    }
  });

  const idempotencyKey =
    "ais-sq-optval-add-" +
    cloned.id +
    "-" +
    encodeURIComponent(normalizedValue) +
    "-v" +
    (cloned.version || Date.now());

  const updateRes = squareProdRequest_("/v2/catalog/object", {
    method: "post",
    payload: {
      idempotency_key: idempotencyKey,
      object: cloned
    }
  });

  let updateData;
  try {
    updateData = JSON.parse(updateRes.body || "{}");
  } catch (_) {
    throw new Error("Square Catalog add ITEM_OPTION_VAL returned invalid JSON");
  }

  const updatedOption = updateData.catalog_object || {};
  const idMappings = Array.isArray(updateData.id_mappings)
    ? updateData.id_mappings
    : [];

  let resolvedValId = "";
  const valMapping = idMappings.find(m => m && m.client_object_id === tempValId);
  if (valMapping && valMapping.object_id) {
    resolvedValId = valMapping.object_id;
  }

  if (!resolvedValId && updatedOption.item_option_data && Array.isArray(updatedOption.item_option_data.values)) {
    const matchedVal = updatedOption.item_option_data.values.find(v =>
      v &&
      v.item_option_value_data &&
      String(v.item_option_value_data.name || "").trim() === normalizedValue
    );
    if (matchedVal && matchedVal.id) {
      resolvedValId = matchedVal.id;
    }
  }

  if (!resolvedValId || resolvedValId.startsWith("#")) {
    throw new Error(
      "Failed to obtain resolved server value ID for: " + normalizedValue +
      " in option: " + cloned.id
    );
  }

  console.log(
    "Successfully added Square Item Option Value [" + normalizedValue +
    "] with ID [" + resolvedValId + "] to Option [" + cloned.id + "]"
  );

  return {
    optionId: cloned.id,
    valueId: resolvedValId,
    isNew: true
  };
}

/**
 * オプション名 (例: "サイズ", "状態") と値名 (例: "29.0", "新品・未使用") を解決する。
 * 既存の ITEM_OPTION に値が存在すればその ID を返し、
 * 存在しない場合は addSquareItemOptionValueSafely_ で既存値を完全保持した上で追加する。
 *
 * @param {string} optionName オプション名
 * @param {string} valueName 値名
 * @return {{
 *   optionId: string,
 *   valueId: string,
 *   isNew: boolean
 * }}
 */
function resolveSquareItemOptionValue_(optionName, valueName) {
  const normalizedValue = String(valueName || "").trim();
  if (!normalizedValue) {
    throw new Error("valueName is required for resolveSquareItemOptionValue_");
  }

  const optionObject = resolveSquareItemOption_(optionName);
  const values = (optionObject.item_option_data && Array.isArray(optionObject.item_option_data.values))
    ? optionObject.item_option_data.values
    : [];

  const matched = values.find(v =>
    v &&
    v.item_option_value_data &&
    String(v.item_option_value_data.name || "").trim() === normalizedValue
  );

  if (matched && matched.id) {
    return {
      optionId: optionObject.id,
      valueId: matched.id,
      isNew: false
    };
  }

  // 存在しない場合は安全に追加
  return addSquareItemOptionValueSafely_(optionObject, normalizedValue);
}

/**
 * スニーカー用の Item Option / Item Option Values 構造を構築
 *
 * @param {Object} source BIS元データ (sneaker_size, condition, category)
 * @return {{
 *   itemOptions: Array<{ item_option_id: string }>,
 *   itemOptionValues: Array<{ item_option_id: string, item_option_value_id: string }>
 * }|null}
 */
function buildSquareSneakerItemOptions_(source) {
  if (!source || source.category !== "sneaker") {
    return null;
  }

  const sizeValName = formatSquareSneakerSizeOptionValue_(source.sneaker_size);
  const condValName = String(source.condition || "").trim();

  const itemOptions = [];
  const itemOptionValues = [];
  const optionNames = [];

  if (sizeValName) {
    const sizeOpt = resolveSquareItemOptionValue_("サイズ", sizeValName);
    if (sizeOpt && sizeOpt.optionId && sizeOpt.valueId) {
      itemOptions.push({ item_option_id: sizeOpt.optionId });
      itemOptionValues.push({
        item_option_id: sizeOpt.optionId,
        item_option_value_id: sizeOpt.valueId
      });
      optionNames.push(sizeValName);
    }
  }

  if (condValName) {
    const condOpt = resolveSquareItemOptionValue_("状態", condValName);
    if (condOpt && condOpt.optionId && condOpt.valueId) {
      itemOptions.push({ item_option_id: condOpt.optionId });
      itemOptionValues.push({
        item_option_id: condOpt.optionId,
        item_option_value_id: condOpt.valueId
      });
      optionNames.push(condValName);
    }
  }

  if (itemOptions.length === 0) {
    return null;
  }

  return {
    itemOptions: itemOptions,
    itemOptionValues: itemOptionValues,
    expectedVariationName: optionNames.join(", ")
  };
}


// ==================================================
// Square Production 実商品登録（1件）
// ==================================================

/**
 * BIS商品マスターの対象商品（1件）をSquare Productionへ新規登録する
 *
 * 既存のSandbox用 createSquareProduct は一切変更せず、Production専用処理として独立。
 * squareProdRequest_() を使用し、Production Location IDに限定して登録する。
 *
 * 登録フロー:
 * 1. 商品マスターから対象商品行を取得し、既存 square_item_id / square_variation_id が空であることを厳格検証
 * 2. POST /v2/catalog/object で ITEM + VARIATION を作成 (planned_sale_price, JPY, Location限定)
 * 3. GET /v2/catalog/object/{item_id} で RETRIEVE 検証 (name, price, variation, currency)
 * 4. 検証成功時のみ、商品マスターの AI列 (square_item_id) / AJ列 (square_variation_id) へ保存
 *
 * Rollback方針:
 * - AI/AJ保存前のエラー: Square側に作成済みのItemがあればDELETEによるrollbackを試行
 * - AI/AJ保存後のエラー: 自動rollbackは行わず、明示的エラーとログを出力
 *
 * @param {string} productId 商品ID (例: "TMP-000010")
 * @return {{
 *   success: boolean,
 *   environment: string,
 *   product_id: string,
 *   square_item_id: string,
 *   square_variation_id: string,
 *   catalog_create: string,
 *   catalog_retrieve: string,
 *   sheet_update: string,
 *   product_name: string,
 *   price_amount: number,
 *   currency: string
 * }}
 */

/**
 * Square Production 商品作成の世代番号 (generation) を取得
 * 削除済み商品の結果キャッシュと通信未確認の再送を厳格に分離するために使用
 * @param {string} productId
 * @return {number}
 */
function getSquareProdCreateGeneration_(productId) {
  try {
    const props = PropertiesService.getScriptProperties();
    const val = props.getProperty("SQUARE_PROD_CREATE_GEN_" + productId);
    const num = parseInt(val, 10);
    return Number.isSafeInteger(num) && num >= 1 ? num : 1;
  } catch (_) {
    return 1;
  }
}

/**
 * Square Production 商品作成の世代番号 (generation) を記録
 * @param {string} productId
 * @param {number} gen
 */
function setSquareProdCreateGeneration_(productId, gen) {
  try {
    const props = PropertiesService.getScriptProperties();
    props.setProperty("SQUARE_PROD_CREATE_GEN_" + productId, String(gen));
  } catch (e) {
    console.warn("Failed to set square prod create gen for " + productId + ": " + e.message);
  }
}

/**
 * Square Production 商品作成のIdempotency Keyを生成
 * 通信エラー時の安全な再送（同一キー）と、削除確認後の安全な再作成（新世代キー）を両立する
 * @param {string} productId
 * @param {number} gen
 * @return {string}
 */
function buildSquareProdCreateIdempotencyKey_(productId, gen) {
  const g = Number(gen) || 1;
  if (g <= 1) {
    return "ais-square-prod-create-" + productId;
  }
  return "ais-square-prod-create-" + productId + "-g" + g;
}

/**
 * Square Production Catalogから指定SKUの商品状態（稼働中／削除済み）を安全にREAD ONLY検索・確認
 * @param {string} sku
 * @return {Object}
 */
function inspectSquareProductionProductBySku_(sku) {
  const normalizedSku = String(sku || "").trim();
  if (!normalizedSku) {
    return { success: false, error: "sku is required" };
  }

  try {
    let searchRes = squareProdRequest_(
      "/v2/catalog/search",
      {
        method: "post",
        payload: {
          query: {
            exact_query: {
              attribute_name: "sku",
              attribute_value: normalizedSku
            }
          },
          include_deleted_objects: true,
          include_related_objects: true
        },
        allowError: true
      }
    );

    let searchData = {};
    try {
      searchData = JSON.parse(searchRes.body || "{}");
    } catch (_) {}

    let objects = Array.isArray(searchData.objects) ? searchData.objects : [];
    let relatedObjects = Array.isArray(searchData.related_objects) ? searchData.related_objects : [];

    // exact_queryで0件の場合、text_queryでも確認
    if (objects.length === 0) {
      const textRes = squareProdRequest_(
        "/v2/catalog/search",
        {
          method: "post",
          payload: {
            query: {
              text_query: {
                keywords: [ normalizedSku ]
              }
            },
            include_deleted_objects: true,
            include_related_objects: true
          },
          allowError: true
        }
      );
      try {
        const textData = JSON.parse(textRes.body || "{}");
        if (Array.isArray(textData.objects) && textData.objects.length > 0) {
          objects = textData.objects;
          relatedObjects = Array.isArray(textData.related_objects) ? textData.related_objects : [];
          searchRes = textRes;
        }
      } catch (_) {}
    }

    const seenIds = new Set();
    const allObjects = [];
    objects.concat(relatedObjects).forEach(o => {
      if (o && o.id && !seenIds.has(o.id)) {
        seenIds.add(o.id);
        allObjects.push(o);
      }
    });

    const activeObjects = allObjects.filter(o => o && !o.is_deleted);
    const deletedObjects = allObjects.filter(o => o && o.is_deleted);

    const currentGen = getSquareProdCreateGeneration_(normalizedSku);
    const currentKey = buildSquareProdCreateIdempotencyKey_(normalizedSku, currentGen);

    return {
      success: true,
      sku: normalizedSku,
      http_status: searchRes.httpStatus,
      total_found: allObjects.length,
      active_count: activeObjects.length,
      deleted_count: deletedObjects.length,
      active_objects: activeObjects.map(o => ({
        id: o.id,
        type: o.type,
        version: o.version,
        is_deleted: !!o.is_deleted,
        name: (o.item_data && o.item_data.name) || (o.item_variation_data && o.item_variation_data.name) || "",
        sku: (o.item_variation_data && o.item_variation_data.sku) || ""
      })),
      deleted_objects: deletedObjects.map(o => ({
        id: o.id,
        type: o.type,
        version: o.version,
        is_deleted: !!o.is_deleted,
        updated_at: o.updated_at || "",
        name: (o.item_data && o.item_data.name) || (o.item_variation_data && o.item_variation_data.name) || "",
        sku: (o.item_variation_data && o.item_variation_data.sku) || ""
      })),
      current_generation: currentGen,
      current_idempotency_key: currentKey
    };
  } catch (err) {
    return {
      success: false,
      sku: normalizedSku,
      error: err.message
    };
  }
}

function createSquareProductionProduct(productId) {
  const normalizedProductId = String(productId || "").trim();

  if (!normalizedProductId) {
    throw new Error("product_id is required");
  }

  const scriptProperties = PropertiesService.getScriptProperties();

  const prodLocationId = String(
    scriptProperties.getProperty("SQUARE_PROD_LOCATION_ID") || ""
  ).trim();

  if (!prodLocationId) {
    throw new Error("SQUARE_PROD_LOCATION_ID is required for Square Production");
  }

  const sheet = SpreadsheetApp
    .getActiveSpreadsheet()
    .getSheets()[0];

  ensureSquareIdColumns(sheet);

  const source = getSquareProductSourceData_(sheet, normalizedProductId);
  const targetRow = source.targetRow;

  // AIドラフト未確認・内容不一致時はSquare商品作成を拒否 (Fail-Closed)
  assertProductPublishable_(sheet, targetRow, normalizedProductId);

  const productName = source.product_name;
  const priceAmount = source.planned_sale_price;

  const existingSquareItemId = source.square_item_id;
  const existingSquareVariationId = source.square_variation_id;

  // 既存IDの厳格チェック
  if (existingSquareItemId || existingSquareVariationId) {
    throw new Error(
      "square production registration requires empty square IDs"
    );
  }

  if (!productName) {
    throw new Error("product_name is required for Square");
  }

  if (!Number.isSafeInteger(priceAmount) || priceAmount <= 0) {
    throw new Error("planned_sale_price must be a positive integer");
  }

  // スニーカーの場合のみ Item Options (サイズ / 状態) を解決して設定
  const sneakerOptions = buildSquareSneakerItemOptions_(source);

  // 作成リクエストと照合の期待値は同じ命名処理から生成
  const display = buildSquareProductDisplay_(source, sneakerOptions);

  const temporaryItemId = "#ais-prod-item-" + normalizedProductId;
  const temporaryVariationId = "#ais-prod-var-" + normalizedProductId;

  let currentGen = getSquareProdCreateGeneration_(normalizedProductId);
  let idempotencyKey = buildSquareProdCreateIdempotencyKey_(normalizedProductId, currentGen);

  const variationData = {
    item_id: temporaryItemId,
    name: display.variationName,
    sku: normalizedProductId,
    pricing_type: "FIXED_PRICING",
    price_money: {
      amount: priceAmount,
      currency: "JPY"
    },
    track_inventory: true
  };

  if (sneakerOptions && sneakerOptions.itemOptionValues) {
    variationData.item_option_values = sneakerOptions.itemOptionValues;
  }

  const itemData = {
    name: display.itemName,
    description_html: display.descriptionHtml,
    variations: [
      {
        type: "ITEM_VARIATION",
        id: temporaryVariationId,
        present_at_all_locations: false,
        present_at_location_ids: [prodLocationId],
        item_variation_data: variationData
      }
    ]
  };

  if (sneakerOptions && sneakerOptions.itemOptions) {
    itemData.item_options = sneakerOptions.itemOptions;
  }

  let createdItemId = "";
  let createdVariationId = "";
  let isSavedToSheet = false;

  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      idempotencyKey = buildSquareProdCreateIdempotencyKey_(normalizedProductId, currentGen);

      const payload = {
        idempotency_key: idempotencyKey,
        object: {
          type: "ITEM",
          id: temporaryItemId,
          present_at_all_locations: false,
          present_at_location_ids: [prodLocationId],
          item_data: itemData
        }
      };

      // ------------------------------------------
      // 1. CREATE: POST /v2/catalog/object
      // ------------------------------------------
      const createRes = squareProdRequest_(
        "/v2/catalog/object",
        {
          method: "post",
          payload: payload,
          allowError: true
        }
      );

      let createData;
      try {
        createData = JSON.parse(createRes.body || "{}");
      } catch (_) {
        throw new Error("Square Production Catalog CREATE returned invalid JSON");
      }

      // Square APIエラー時のハンドリング
      if (createRes.httpStatus < 200 || createRes.httpStatus >= 300) {
        const errors = Array.isArray(createData.errors) ? createData.errors : [];
        const isDeletedError = errors.some(e =>
          e && (e.code === "NOT_FOUND" || String(e.detail || "").toLowerCase().includes("deleted"))
        );
        // 以前の削除済み商品に起因するキー不整合かつ初回試行の場合、世代を進めて安全に再作成
        if (isDeletedError && attempt === 0) {
          console.warn(
            "[Square Prod] Idempotency key " +
            idempotencyKey +
            " hit deleted object in Square. Advancing generation to recreate."
          );
          currentGen++;
          setSquareProdCreateGeneration_(normalizedProductId, currentGen);
          continue;
        }
        throw new Error(
          "Square Production Catalog CREATE failed with HTTP " +
          createRes.httpStatus +
          ": " +
          createRes.body
        );
      }

      const catalogObject = createData.catalog_object || {};

      // 固定キーのキャッシュ返却等で削除済み商品が返された場合、受け入れず再作成へ移行
      if (catalogObject.is_deleted === true) {
        if (attempt === 0) {
          console.warn(
            "[Square Prod] Idempotency key " +
            idempotencyKey +
            " returned deleted catalog_object. Advancing generation to recreate."
          );
          currentGen++;
          setSquareProdCreateGeneration_(normalizedProductId, currentGen);
          continue;
        }
        throw new Error(
          "Square Production Catalog object returned with is_deleted=true: " + catalogObject.id
        );
      }

      const idMappings = Array.isArray(createData.id_mappings)
        ? createData.id_mappings
        : [];

      const itemMapping = idMappings.find(m =>
        m && m.client_object_id === temporaryItemId
      );
      createdItemId = String(
        itemMapping && itemMapping.object_id || catalogObject.id || ""
      ).trim();

      const varMapping = idMappings.find(m =>
        m && m.client_object_id === temporaryVariationId
      );
      createdVariationId = String(
        varMapping && varMapping.object_id || ""
      ).trim();

      if (!createdVariationId && catalogObject.item_data && Array.isArray(catalogObject.item_data.variations)) {
        const matchedVar = catalogObject.item_data.variations.find(v =>
          String(v && v.item_variation_data && v.item_variation_data.sku || "").trim() === normalizedProductId
        ) || catalogObject.item_data.variations[0];

        if (matchedVar) {
          createdVariationId = String(matchedVar.id || "").trim();
        }
      }

      if (!createdItemId || createdItemId.startsWith("#")) {
        throw new Error(
          "Square Production Catalog CREATE did not return a valid server item_id: " + createdItemId
        );
      }

      if (!createdVariationId || createdVariationId.startsWith("#")) {
        throw new Error(
          "Square Production Catalog CREATE did not return a valid server variation_id: " + createdVariationId
        );
      }

      // ------------------------------------------
      // 2. RETRIEVE確認: GET /v2/catalog/object/{item_id}
      // ------------------------------------------
      const retrieveRes = squareProdRequest_(
        "/v2/catalog/object/" + encodeURIComponent(createdItemId),
        {
          method: "get",
          allowError: true
        }
      );

      let retrieveData = {};
      try {
        retrieveData = JSON.parse(retrieveRes.body || "{}");
      } catch (_) {}

      const isNotFound = (retrieveRes.httpStatus === 404) ||
        (Array.isArray(retrieveData.errors) && retrieveData.errors.some(e => e && e.code === "NOT_FOUND"));
      const isDeletedObj = (retrieveData.object && retrieveData.object.is_deleted === true);

      // RETRIEVEで削除済みまたは404が返された場合（固定キーで以前削除されたIDを再取得してしまった場合）
      if ((isNotFound || isDeletedObj) && attempt === 0) {
        console.warn(
          "[Square Prod] Retrieved object " +
          createdItemId +
          " is deleted/not-found in Square. Advancing generation to recreate."
        );
        currentGen++;
        setSquareProdCreateGeneration_(normalizedProductId, currentGen);
        createdItemId = "";
        createdVariationId = "";
        continue;
      }

      if (retrieveRes.httpStatus < 200 || retrieveRes.httpStatus >= 300) {
        throw new Error(
          "Square Production Catalog RETRIEVE failed with HTTP " +
          retrieveRes.httpStatus +
          ": " +
          retrieveRes.body
        );
      }

      const retrievedObject = retrieveData.object;
      if (!retrievedObject || retrievedObject.type !== "ITEM") {
        throw new Error("Retrieved Catalog object is not an ITEM");
      }

      if (retrievedObject.is_deleted === true) {
        throw new Error("Retrieved Catalog object is marked as deleted: " + createdItemId);
      }

      if (String(retrievedObject.id || "").trim() !== createdItemId) {
        throw new Error(
          "Retrieved Catalog object ID mismatch: expected " +
          createdItemId +
          ", got " +
          retrievedObject.id
        );
      }

      const retrievedItemData = retrievedObject.item_data || {};
      if (String(retrievedItemData.name || "").trim() !== productName) {
        throw new Error(
          "Retrieved Catalog item name mismatch: expected " +
          productName +
          ", got " +
          retrievedItemData.name
        );
      }

      const retrievedVariations = Array.isArray(retrievedItemData.variations)
        ? retrievedItemData.variations
        : [];

      const matchedVariation = retrievedVariations.find(v =>
        v && String(v.id || "").trim() === createdVariationId
      );

      if (!matchedVariation) {
        throw new Error(
          "Retrieved Catalog variations did not contain created variation_id: " +
          createdVariationId
        );
      }

      const matchedVarData = matchedVariation.item_variation_data || {};
      const actualVarName = String(matchedVarData.name || "").trim();
      const expectedVarName = String(display.variationName || "").trim();
      const namesMatch = (actualVarName === expectedVarName) ||
        (actualVarName.replace(/,\s*/g, ", ") === expectedVarName.replace(/,\s*/g, ", "));

      if (!namesMatch) {
        throw new Error(
          "Retrieved variation name mismatch: expected " +
          display.variationName +
          ", got " +
          matchedVarData.name
        );
      }

      const priceMoney = matchedVarData.price_money || {};
      if (Number(priceMoney.amount) !== priceAmount) {
        throw new Error(
          "Retrieved variation price amount mismatch: expected " +
          priceAmount +
          ", got " +
          priceMoney.amount
        );
      }

      if (String(priceMoney.currency || "").trim().toUpperCase() !== "JPY") {
        throw new Error(
          "Retrieved variation price currency mismatch: expected JPY, got " +
          priceMoney.currency
        );
      }

      // すべての検証に通過したため正常終了
      break;
    }

    // ------------------------------------------
    // 3. 商品マスターへ保存 (AI: 35, AJ: 36)
    // ------------------------------------------
    sheet
      .getRange(targetRow, 35, 1, 2)
      .setValues([[
        createdItemId,
        createdVariationId
      ]]);

    isSavedToSheet = true;

  } catch (error) {
    // AI/AJ保存前にエラーが発生し、Square側に商品が作成済みの場合はrollback（削除）試行
    if (createdItemId && !isSavedToSheet) {
      try {
        const delRes = squareProdRequest_(
          "/v2/catalog/object/" + encodeURIComponent(createdItemId),
          {
            method: "delete",
            allowError: true
          }
        );
        if (delRes.httpStatus >= 200 && delRes.httpStatus < 300) {
          console.warn(
            "Rolled back Square Production Catalog Item: " + createdItemId
          );
          // 削除が実際に成功したため、次回の再作成時に削除済みキャッシュを踏まないよう世代を進める
          setSquareProdCreateGeneration_(normalizedProductId, currentGen + 1);
        } else {
          console.warn(
            "Rollback DELETE failed for Square Production Catalog Item " +
            createdItemId +
            ": HTTP " +
            delRes.httpStatus
          );
        }
      } catch (cleanupErr) {
        console.warn(
          "Failed to rollback Square Production Catalog Item " +
          createdItemId +
          ": " +
          cleanupErr.message
        );
      }
    } else if (isSavedToSheet) {
      console.error(
        "Error occurred AFTER saving to sheet for product " +
        normalizedProductId +
        ". Production Item ID: " +
        createdItemId +
        ", Variation ID: " +
        createdVariationId +
        ". Error: " +
        error.message
      );
    }
    throw error;
  }

  const summary = {
    success: true,
    environment: "production",
    product_id: normalizedProductId,
    square_item_id: createdItemId,
    square_variation_id: createdVariationId,
    catalog_create: "passed",
    catalog_retrieve: "passed",
    sheet_update: "passed",
    product_name: display.itemName,
    variation_name: display.variationName,
    price_amount: priceAmount,
    currency: "JPY"
  };

  console.log(JSON.stringify(summary));
  return summary;
}


// ==================================================
// Square Production 実商品登録 手動テスト
// SQUARE_PROD_TEST_PRODUCT_ID を事前設定して実行
// ==================================================



// ==================================================
// Square Production 画像アップロード専用HTTPリクエスト
// multipart/form-data: request (JSON) + file (Blob)
// ==================================================

/**
 * Square Production API 画像アップロード専用内部helper
 *
 * SQUARE_PROD_ACCESS_TOKEN を使用し、multipart/form-data で
 * https://connect.squareup.com へ画像を送信する。
 *
 * @param {string} path APIパス (例: "/v2/catalog/images")
 * @param {Object} requestData 送信JSONメタデータ
 * @param {GoogleAppsScript.Base.Blob} imageBlob アップロード画像Blob
 * @return {{ httpStatus: number, body: string, data: Object }}
 */
function squareProdUploadImageRequest_(path, requestData, imageBlob) {
  const scriptProperties = PropertiesService.getScriptProperties();

  const prodAccessToken = String(
    scriptProperties.getProperty("SQUARE_PROD_ACCESS_TOKEN") || ""
  ).trim();

  const apiVersion = String(
    scriptProperties.getProperty("SQUARE_API_VERSION") || ""
  ).trim();

  if (!prodAccessToken) {
    throw new Error("SQUARE_PROD_ACCESS_TOKEN is required");
  }
  if (!apiVersion) {
    throw new Error("SQUARE_API_VERSION is required");
  }

  const normalizedPath = String(path || "").startsWith("/")
    ? String(path)
    : "/" + String(path || "");

  const requestJsonBlob = Utilities.newBlob(
    JSON.stringify(requestData),
    "application/json"
  );

  const payload = {
    request: requestJsonBlob,
    file: imageBlob
  };

  const fetchOptions = {
    method: "post",
    headers: {
      Authorization: "Bearer " + prodAccessToken,
      "Square-Version": apiVersion,
      Accept: "application/json"
    },
    payload: payload,
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch(
    "https://connect.squareup.com" + normalizedPath,
    fetchOptions
  );

  const httpStatus = response.getResponseCode();
  const responseBody = response.getContentText();

  if (httpStatus < 200 || httpStatus >= 300) {
    const safeResponseBody = responseBody
      .split(prodAccessToken)
      .join("[REDACTED]");

    throw new Error(
      "Square Production image upload failed with HTTP " +
      httpStatus +
      ": " +
      safeResponseBody
    );
  }

  let parsedResponse;
  try {
    parsedResponse = JSON.parse(responseBody || "{}");
  } catch (_) {
    throw new Error("Square Production image upload returned invalid JSON");
  }

  return {
    httpStatus: httpStatus,
    body: responseBody,
    data: parsedResponse
  };
}


// ==================================================
// Square Production メイン画像同期（1件）
// ==================================================

/**
 * BIS商品のメイン画像（1枚）をSquare ProductionのCatalog Itemへ同期する
 *
 * 既存のSandbox用 syncSquareProductMainImage は一切変更せず、Production専用として独立。
 * SQUARE_PROD_ACCESS_TOKEN を使用し、既存のItem本体・Variationは変更せず、
 * Google Sheetsの更新も行わない。
 *
 * 同期フロー:
 * 1. 事前validation (product_id, square_item_id, square_variation_id, main_image_url)
 * 2. GET /v2/catalog/object/{square_item_id} でItemの存在および既存画像を事前確認
 *    - 既に画像が存在する場合は重複登録を防ぐため skip
 * 3. Drive商品フォルダから 01_main_* 画像Blobを安全に取得（形式・サイズ検証）
 * 4. POST /v2/catalog/images (multipart/form-data) でItemへ画像をアップロード・attach
 * 5. GET /v2/catalog/object/{square_item_id} で image_ids の紐付け確認
 * 6. GET /v2/catalog/object/{image_id} で IMAGE オブジェクトの確認
 *
 * Cleanup方針:
 * - 画像作成成功後、Item紐付け検証で失敗した場合は作成された CatalogImage のみ DELETE cleanup を試行
 * - Production Item本体・Variationは絶対に削除しない
 *
 * @param {string} productId 商品ID (例: "TMP-000027")
 * @return {{
 *   success: boolean,
 *   environment: string,
 *   product_id: string,
 *   square_item_id: string,
 *   image_upload?: string,
 *   image_attach?: string,
 *   image_id?: string,
 *   image_url?: string,
 *   status?: string,
 *   message?: string
 * }}
 */
function syncSquareProductionProductMainImage(productId) {
  const normalizedProductId = String(productId || "").trim();

  if (!normalizedProductId) {
    throw new Error("product_id is required");
  }

  const sheet = SpreadsheetApp
    .getActiveSpreadsheet()
    .getSheets()[0];

  const targetRow = findProductRow(sheet, normalizedProductId);

  const row = sheet
    .getRange(targetRow, 1, 1, 36)
    .getValues()[0];

  const productName = String(row[4] || "").trim();
  const folderUrl = String(row[29] || "").trim();
  const mainImageUrl = String(row[30] || "").trim();
  const squareItemId = String(row[34] || "").trim();
  const squareVariationId = String(row[35] || "").trim();

  // ------------------------------------------
  // 事前validation
  // ------------------------------------------
  if (!squareItemId) {
    throw new Error("square production item is not registered");
  }

  if (!squareVariationId) {
    throw new Error("Square Variation link is missing");
  }

  if (!mainImageUrl) {
    throw new Error("main image is required for Square Production image sync");
  }

  // ------------------------------------------
  // 1. Production Item存在確認 & 重複画像チェック
  // ------------------------------------------
  const itemRes = squareProdRequest_(
    "/v2/catalog/object/" + encodeURIComponent(squareItemId),
    {
      method: "get"
    }
  );

  let itemData;
  try {
    itemData = JSON.parse(itemRes.body || "{}");
  } catch (_) {
    throw new Error("Square Production Item RETRIEVE returned invalid JSON");
  }

  const currentItem = itemData.object;
  if (!currentItem || currentItem.type !== "ITEM") {
    throw new Error("Square Production object is not an ITEM: " + squareItemId);
  }

  if (String(currentItem.id || "").trim() !== squareItemId) {
    throw new Error(
      "Square Production Item ID mismatch: expected " +
      squareItemId +
      ", got " +
      currentItem.id
    );
  }

  const currentItemData = currentItem.item_data || {};
  const existingImageIds = Array.isArray(currentItemData.image_ids)
    ? currentItemData.image_ids
    : [];

  if (existingImageIds.length > 0) {
    const alreadySummary = {
      success: true,
      status: "already_has_image",
      environment: "production",
      product_id: normalizedProductId,
      square_item_id: squareItemId,
      existing_image_ids: existingImageIds,
      message: "Square Production Item already has image(s), skipping upload"
    };
    console.log(JSON.stringify(alreadySummary));
    return alreadySummary;
  }

  // ------------------------------------------
  // 2. Drive商品フォルダ取得とメイン画像安全取得
  // ------------------------------------------
  if (!folderUrl) {
    throw new Error("product Drive folder URL is missing");
  }

  const folderId = extractDriveFolderId(folderUrl);
  if (!folderId) {
    throw new Error("invalid product Drive folder URL");
  }

  const productFolder = DriveApp.getFolderById(folderId);
  const parents = productFolder.getParents();
  let isInRootFolder = false;

  while (parents.hasNext()) {
    if (parents.next().getId() === ROOT_FOLDER_ID) {
      isInRootFolder = true;
      break;
    }
  }

  if (!isInRootFolder) {
    throw new Error("product Drive folder is outside root folder");
  }

  if (productFolder.getName() !== normalizedProductId) {
    throw new Error("product Drive folder does not match product_id");
  }

  const files = productFolder.getFiles();
  const mainImageFiles = [];

  while (files.hasNext()) {
    const file = files.next();
    if (file.getName().startsWith("01_main_")) {
      mainImageFiles.push(file);
    }
  }

  if (mainImageFiles.length === 0) {
    throw new Error("main image not found");
  }

  if (mainImageFiles.length > 1) {
    throw new Error("multiple main images found");
  }

  const mainImageFile = mainImageFiles[0];

  const mimeType = String(
    mainImageFile.getMimeType() || ""
  ).trim().toLowerCase();

  if (mimeType === "image/webp") {
    throw new Error("Square image sync does not support WebP");
  }

  const allowedMimes = ["image/jpeg", "image/png"];
  if (!allowedMimes.includes(mimeType)) {
    throw new Error("unsupported Square image mime type: " + mimeType);
  }

  const fileSize = mainImageFile.getSize();
  const maxSizeBytes = 15 * 1024 * 1024;
  if (fileSize > maxSizeBytes) {
    throw new Error(
      "image file size exceeds 15MB limit: " + fileSize + " bytes"
    );
  }

  // ------------------------------------------
  // 3. Square CreateCatalogImage 実行
  // ------------------------------------------
  const driveFileId = mainImageFile.getId();
  const driveFileName = mainImageFile.getName();

  const idempotencyKey =
    "ais-square-prod-image-" +
    normalizedProductId;

  const temporaryImageId =
    "#ais-prod-image-" +
    normalizedProductId;

  const imageDisplayName =
    productName || driveFileName;

  const requestData = {
    idempotency_key: idempotencyKey,
    object_id: squareItemId,
    is_primary: true,
    image: {
      type: "IMAGE",
      id: temporaryImageId,
      image_data: {
        name: imageDisplayName,
        caption: imageDisplayName
      }
    }
  };

  let createdImageId = "";
  let squareImageUrl = "";
  let isAttachVerified = false;

  try {
    const uploadResponse = squareProdUploadImageRequest_(
      "/v2/catalog/images",
      requestData,
      mainImageFile.getBlob()
    );

    const uploadData = uploadResponse.data || {};
    const imageObject = uploadData.image;

    if (!imageObject || typeof imageObject !== "object") {
      throw new Error("Square Production Image object was not returned");
    }

    if (imageObject.type !== "IMAGE") {
      throw new Error(
        "invalid Square Production Image object type: " +
        String(imageObject.type || "")
      );
    }

    createdImageId = String(imageObject.id || "").trim();

    if (!createdImageId || createdImageId.startsWith("#")) {
      throw new Error(
        "Square Production Image ID was not returned: " + createdImageId
      );
    }

    const imageData = imageObject.image_data || {};
    squareImageUrl = String(imageData.url || "").trim();

    // ------------------------------------------
    // 4. 成功確認: Item再取得 & attach確認
    // ------------------------------------------
    const verifyItemRes = squareProdRequest_(
      "/v2/catalog/object/" + encodeURIComponent(squareItemId),
      {
        method: "get"
      }
    );

    let verifyItemData;
    try {
      verifyItemData = JSON.parse(verifyItemRes.body || "{}");
    } catch (_) {
      throw new Error("Square Production Item re-fetch returned invalid JSON");
    }

    const verifiedItem = verifyItemData.object || {};
    const verifiedItemData = verifiedItem.item_data || {};
    const attachedImageIds = Array.isArray(verifiedItemData.image_ids)
      ? verifiedItemData.image_ids
      : [];

    if (!attachedImageIds.includes(createdImageId)) {
      throw new Error(
        "Created Image ID (" +
        createdImageId +
        ") is not attached to Square Production Item (" +
        squareItemId +
        ")"
      );
    }

    // ------------------------------------------
    // 5. 成功確認: Imageオブジェクト取得確認
    // ------------------------------------------
    const verifyImgRes = squareProdRequest_(
      "/v2/catalog/object/" + encodeURIComponent(createdImageId),
      {
        method: "get"
      }
    );

    let verifyImgData;
    try {
      verifyImgData = JSON.parse(verifyImgRes.body || "{}");
    } catch (_) {
      throw new Error("Square Production Image re-fetch returned invalid JSON");
    }

    const verifiedImg = verifyImgData.object || {};
    if (verifiedImg.type !== "IMAGE" || String(verifiedImg.id || "").trim() !== createdImageId) {
      throw new Error(
        "Verified object is not the created IMAGE: expected " +
        createdImageId +
        ", got " +
        verifiedImg.id
      );
    }

    isAttachVerified = true;

  } catch (error) {
    if (createdImageId && !isAttachVerified) {
      try {
        squareProdRequest_(
          "/v2/catalog/object/" + encodeURIComponent(createdImageId),
          {
            method: "delete"
          }
        );
        console.warn(
          "Cleaned up orphaned Square Production Catalog Image: " +
          createdImageId
        );
      } catch (cleanupErr) {
        console.warn(
          "Failed to cleanup Square Production Catalog Image " +
          createdImageId +
          ": " +
          cleanupErr.message
        );
      }
    }
    throw error;
  }

  const summary = {
    success: true,
    environment: "production",
    product_id: normalizedProductId,
    square_item_id: squareItemId,
    image_upload: "passed",
    image_attach: "passed",
    image_id: createdImageId,
    image_url: squareImageUrl
  };

  console.log(JSON.stringify(summary));
  return summary;
}


// ==================================================
// Square Production メイン画像同期 手動テスト
// SQUARE_PROD_TEST_PRODUCT_ID を使用
// ==================================================



// ==================================================
// Square Production 在庫取得（内部helper）
// GET /v2/inventory/{variation_id}?location_ids={prodLocationId}
// ==================================================

/**
 * Square Production 特定Variation / Location の在庫を取得する内部helper
 *
 * @param {string} squareVariationId Variation ID
 * @param {string} prodLocationId Location ID
 * @return {{
 *   square_variation_id: string,
 *   location_id: string,
 *   quantity: string,
 *   calculated_at: string
 * }}
 */
function getSquareProductionProductInventory_(squareVariationId, prodLocationId, options) {
  const normalizedSquareVariationId = String(squareVariationId || "").trim();
  const normalizedLocationId = String(prodLocationId || "").trim();

  if (!normalizedSquareVariationId) {
    throw new Error("square_variation_id is required");
  }
  if (!normalizedLocationId) {
    throw new Error("location_id is required");
  }

  const squareRequester = (options && options.squareRequest) || squareProdRequest_;

  const response = squareRequester(
    "/v2/inventory/" +
    encodeURIComponent(normalizedSquareVariationId) +
    "?location_ids=" +
    encodeURIComponent(normalizedLocationId),
    {
      method: "get"
    }
  );

  let inventoryResponse;
  try {
    inventoryResponse = JSON.parse(response.body || "{}");
  } catch (_) {
    throw new Error("Square Production Inventory API returned invalid JSON");
  }

  const counts = Array.isArray(inventoryResponse.counts)
    ? inventoryResponse.counts
    : [];

  const matchedCount = counts.find(count =>
    count &&
    String(count.catalog_object_id || "").trim() === normalizedSquareVariationId &&
    String(count.location_id || "").trim() === normalizedLocationId &&
    String(count.state || "").trim() === "IN_STOCK"
  );

  return {
    square_variation_id: normalizedSquareVariationId,
    location_id: normalizedLocationId,
    quantity:
      matchedCount &&
      Object.prototype.hasOwnProperty.call(matchedCount, "quantity") &&
      matchedCount.quantity !== null &&
      matchedCount.quantity !== undefined
        ? String(matchedCount.quantity)
        : "0",
    calculated_at:
      matchedCount && matchedCount.calculated_at
        ? String(matchedCount.calculated_at)
        : ""
  };
}


// ==================================================
// Square Production 在庫同期（1件）
// ==================================================

/**
 * BIS商品の在庫数量をSquare ProductionのInventoryへ同期する
 *
 * 既存のSandbox用 syncSquareProductInventory は一切変更せず、Production専用として独立。
 * SQUARE_PROD_ACCESS_TOKEN / SQUARE_PROD_LOCATION_ID を使用し、
 * PHYSICAL_COUNT を送信して在庫数量を設定・検証する。
 *
 * 同期フロー:
 * 1. 事前validation (product_id, square_item_id, square_variation_id, quantity)
 * 2. GET /v2/catalog/object/{square_item_id} でItemおよびVariationの存在を確認
 *    - 必要に応じて track_inventory を有効化
 * 3. POST /v2/inventory/changes/batch-create で PHYSICAL_COUNT (state: IN_STOCK) を送信
 * 4. GET /v2/inventory/{square_variation_id} で在庫数量および location_id, catalog_object_id を再取得して検証
 *
 * 注意:
 * - Google Sheets (商品マスター) の更新は行わない
 * - 在庫同期失敗時に Catalog Item, Variation, 画像は絶対に削除しない
 *
 * @param {string} productId 商品ID (例: "TMP-000027")
 * @param {number|string} [quantity=1] 設定在庫数量（0以上の整数）
 * @param {Object} [options] オプション / モック
 * @return {{
 *   success: boolean,
 *   environment: string,
 *   product_id: string,
 *   square_item_id: string,
 *   square_variation_id: string,
 *   location_id: string,
 *   inventory_update: string,
 *   inventory_verify: string,
 *   quantity: string
 * }}
 */
function syncSquareProductionProductInventory(productId, quantity, options) {
  const normalizedProductId = String(productId || "").trim();

  if (!normalizedProductId) {
    throw new Error("product_id is required");
  }

  const targetQuantityInt = quantity !== undefined && quantity !== null
    ? Number(quantity)
    : 1;

  if (!Number.isInteger(targetQuantityInt) || targetQuantityInt < 0) {
    throw new Error("quantity must be an integer greater than or equal to 0");
  }

  const targetQuantity = String(targetQuantityInt);

  const sheet = (options && options.sheet) || SpreadsheetApp
    .getActiveSpreadsheet()
    .getSheets()[0];

  const squareRequester = (options && options.squareRequest) || squareProdRequest_;

  let prodLocationId = (options && options.locationId) || (options && options.propService && options.propService.getProperty("SQUARE_PROD_LOCATION_ID"));
  if (!prodLocationId) {
    try {
      prodLocationId = getSquareProdLocationId_(options && options.propService);
    } catch (_) {
      prodLocationId = "";
    }
  }

  if (!prodLocationId) {
    throw new Error("SQUARE_PROD_LOCATION_ID is required for Square Production");
  }

  const targetRow = findProductRow(sheet, normalizedProductId);

  // 在庫を1以上にして販売可能化する場合のみ、AIドラフト公開ゲートを厳格適用 (quantity===0の販売停止・sold処理は安全化のため常に許可)
  if (targetQuantityInt > 0) {
    assertProductPublishable_(sheet, targetRow, normalizedProductId);
  }

  const row = sheet
    .getRange(targetRow, 1, 1, 36)
    .getValues()[0];

  const publishStatus = String(row[31] || "draft").trim();
  const inventoryStatus = String(row[32] || "in_stock").trim();
  const recordStatus = String(row[33] || "active").trim();
  const squareItemId = String(row[34] || "").trim();
  const squareVariationId = String(row[35] || "").trim();

  // 在庫を1以上にして販売可能化する場合のみ、商品ステータスを厳格検証
  if (targetQuantityInt > 0) {
    if (recordStatus !== "active") {
      throw new Error(
        "cannot increase inventory for inactive product: " +
        normalizedProductId + " (record_status: " + recordStatus + ")"
      );
    }
    const isAllowingPublish = Boolean(options && options.allowingPublish);
    if (publishStatus !== "published" && !isAllowingPublish) {
      throw new Error(
        "cannot increase inventory for non-published product: " +
        normalizedProductId + " (publish_status: " + publishStatus + ")"
      );
    }
  }

  // ------------------------------------------
  // 事前validation
  // ------------------------------------------
  if (!squareItemId) {
    throw new Error("square production item is not registered");
  }

  if (!squareVariationId) {
    throw new Error("square production variation is not registered");
  }

  // ------------------------------------------
  // 1. Square Production Item / Variation 取得確認
  // ------------------------------------------
  const itemRes = squareRequester(
    "/v2/catalog/object/" + encodeURIComponent(squareItemId),
    {
      method: "get"
    }
  );

  let itemData;
  try {
    itemData = JSON.parse(itemRes.body || "{}");
  } catch (_) {
    throw new Error("Square Production Item RETRIEVE returned invalid JSON");
  }

  const currentItem = itemData.object;
  if (!currentItem || currentItem.type !== "ITEM") {
    throw new Error("Square Production object is not an ITEM: " + squareItemId);
  }

  if (targetQuantityInt > 0) {
    const isArchived = Boolean(
      currentItem.item_data &&
      currentItem.item_data.is_archived === true
    );
    if (isArchived) {
      throw new Error(
        "cannot set Square inventory > 0 for archived Square item: " +
        squareItemId + " (product_id: " + normalizedProductId + "). Please unarchive Square product first."
      );
    }
  }

  const variations = currentItem.item_data && Array.isArray(currentItem.item_data.variations)
    ? currentItem.item_data.variations
    : [];

  const currentVariation = variations.find(v =>
    v && String(v.id || "").trim() === squareVariationId
  );

  if (!currentVariation) {
    throw new Error(
      "linked Square Variation (" +
      squareVariationId +
      ") was not found in Square Production Item (" +
      squareItemId +
      ")"
    );
  }

  // ------------------------------------------
  // 2. track_inventory の確認と完全オブジェクト更新による有効化
  // ------------------------------------------
  const variationData = currentVariation.item_variation_data || {};
  let effectiveTrackInventory = null;

  if (Array.isArray(variationData.location_overrides)) {
    const locationOverride = variationData.location_overrides.find(override =>
      override && String(override.location_id || "").trim() === prodLocationId
    );
    if (locationOverride && typeof locationOverride.track_inventory === "boolean") {
      effectiveTrackInventory = locationOverride.track_inventory;
    }
  }

  if (effectiveTrackInventory === null) {
    if (typeof variationData.track_inventory === "boolean") {
      effectiveTrackInventory = variationData.track_inventory;
    } else {
      effectiveTrackInventory = false;
    }
  }

  if (effectiveTrackInventory !== true) {
    // Square UpsertCatalogObjectはfull replacement semanticsのため、
    // 既存Variationオブジェクトをdeep copyして全属性を保持し、
    // read-only fields（created_at, updated_at, is_deleted等）のみを除外した上で
    // track_inventory = true に更新する
    const clonedVariation = JSON.parse(JSON.stringify(currentVariation));

    // read-only fields の除外
    delete clonedVariation.created_at;
    delete clonedVariation.updated_at;
    delete clonedVariation.is_deleted;

    const clonedVariationData = clonedVariation.item_variation_data || {};
    clonedVariationData.track_inventory = true;

    // location_overrides が存在する場合は該当 location の track_inventory も true に設定
    if (Array.isArray(clonedVariationData.location_overrides)) {
      clonedVariationData.location_overrides = clonedVariationData.location_overrides.map(override => {
        if (override && String(override.location_id || "").trim() === prodLocationId) {
          return Object.assign({}, override, { track_inventory: true });
        }
        return override;
      });
    }

    clonedVariation.item_variation_data = clonedVariationData;

    const enableTrackPayload = {
      idempotency_key: "ais-square-prod-track-" + squareVariationId + "-" + currentVariation.version,
      object: clonedVariation
    };

    const updateVarRes = squareRequester("/v2/catalog/object", {
      method: "post",
      payload: enableTrackPayload
    });

    let updateVarData;
    try {
      updateVarData = JSON.parse(updateVarRes.body || "{}");
    } catch (_) {
      throw new Error("Square Production Variation update returned invalid JSON");
    }

    const updatedObject = updateVarData.catalog_object || {};
    const updatedVarData = updatedObject.item_variation_data || {};
    if (updatedVarData.track_inventory !== true) {
      throw new Error(
        "Failed to enable track_inventory on Square Production Variation: " +
        squareVariationId
      );
    }
  }

  // ------------------------------------------
  // 3. PHYSICAL_COUNT WRITE 実行
  // ------------------------------------------
  const idempotencyKey =
    "ais-square-prod-inv-" +
    Utilities.getUuid();

  const payload = {
    idempotency_key: idempotencyKey,
    changes: [
      {
        type: "PHYSICAL_COUNT",
        physical_count: {
          reference_id: normalizedProductId,
          catalog_object_id: squareVariationId,
          location_id: prodLocationId,
          state: "IN_STOCK",
          quantity: targetQuantity,
          occurred_at: new Date().toISOString()
        }
      }
    ]
  };

  const writeResponse = squareRequester(
    "/v2/inventory/changes/batch-create",
    {
      method: "post",
      payload: payload
    }
  );

  let batchResponse;
  try {
    batchResponse = JSON.parse(writeResponse.body || "{}");
  } catch (_) {
    throw new Error("Square Production BatchChangeInventory returned invalid JSON");
  }

  if (Array.isArray(batchResponse.errors) && batchResponse.errors.length > 0) {
    const errorMessages = batchResponse.errors
      .map(err => String(err.detail || err.code || ""))
      .filter(Boolean)
      .join("; ");
    throw new Error(
      "Square Production BatchChangeInventory failed: " + (errorMessages || "unknown error")
    );
  }

  // ------------------------------------------
  // 4. Square Production 在庫再READ & 一致確認
  // ------------------------------------------
  const verifiedInventory = getSquareProductionProductInventory_(
    squareVariationId,
    prodLocationId,
    options
  );

  if (String(verifiedInventory.square_variation_id || "").trim() !== squareVariationId) {
    throw new Error(
      "Verified inventory catalog_object_id mismatch: expected " +
      squareVariationId +
      ", got " +
      verifiedInventory.square_variation_id
    );
  }

  if (String(verifiedInventory.location_id || "").trim() !== prodLocationId) {
    throw new Error(
      "Verified inventory location_id mismatch: expected " +
      prodLocationId +
      ", got " +
      verifiedInventory.location_id
    );
  }

  const verifiedQuantityNum = Number(verifiedInventory.quantity);
  const targetQuantityNum = Number(targetQuantity);

  if (
    Number.isNaN(verifiedQuantityNum) ||
    Number.isNaN(targetQuantityNum) ||
    verifiedQuantityNum !== targetQuantityNum
  ) {
    throw new Error(
      "synced Square Production inventory quantity does not match target: expected " +
      targetQuantity +
      ", got " +
      verifiedInventory.quantity
    );
  }

  const summary = {
    success: true,
    environment: "production",
    product_id: normalizedProductId,
    square_item_id: squareItemId,
    square_variation_id: squareVariationId,
    location_id: prodLocationId,
    inventory_update: "passed",
    inventory_verify: "passed",
    quantity: verifiedInventory.quantity
  };

  console.log(JSON.stringify(summary));
  return summary;
}


// ==================================================
// Square Production 在庫同期 手動テスト
// SQUARE_PROD_TEST_PRODUCT_ID を使用
// ==================================================



// ==================================================
// Square Production Catalog Variation 価格更新 (planned_sale_price のみ)
// ==================================================

/**
 * Square Production Catalog Variation 価格更新 (planned_sale_price のみ)
 *
 * 指定されたBIS商品の square_item_id / square_variation_id を用いて、
 * Square Production Catalog から対象 Item / Variation の最新 version を取得し、
 * Variation の price_money (planned_sale_price) のみを更新して UpsertCatalogObject を実行する。
 *
 * 安全仕様:
 * 1. BIS商品ID、価格 (正の整数)、Square ID (AI列: 35, AJ列: 36) を厳密バリデーション
 * 2. GET /v2/catalog/object/{square_item_id} で最新の Item / Variation および version を取得
 * 3. 取得した Variation からレスポンス専用・読み取り専用フィールドを除外
 * 4. price_money (JPY, newPrice) のみを更新 (location_overrides 内の price_money もあれば更新)
 * 5. POST /v2/catalog/object で UpsertCatalogObject を実行
 * 6. レスポンスの Variation price_money.amount が更新後価格と一致することを検証
 *
 * @param {string} productId BIS商品ID
 * @param {number|string} newPrice 新しい販売価格 (planned_sale_price)
 * @return {{
 *   success: boolean,
 *   environment: string,
 *   product_id: string,
 *   square_item_id: string,
 *   square_variation_id: string,
 *   old_price: number,
 *   new_price: number,
 *   version: number
 * }}
 */
function updateSquareProductionProductPrice(productId, newPrice) {
  const normalizedProductId = String(productId || "").trim();

  if (!normalizedProductId) {
    throw new Error("product_id is required");
  }

  const priceAmount = Number(newPrice);
  if (!Number.isSafeInteger(priceAmount) || priceAmount <= 0) {
    throw new Error(
      "planned_sale_price must be a positive integer: " + newPrice
    );
  }

  const sheet = SpreadsheetApp
    .getActiveSpreadsheet()
    .getSheets()[0];

  const targetRow = findProductRow(sheet, normalizedProductId);
  ensureSquareIdColumns(sheet);

  const row = sheet
    .getRange(targetRow, 1, 1, 36)
    .getValues()[0];

  const squareItemId = String(row[34] || "").trim();
  const squareVariationId = String(row[35] || "").trim();

  if (!squareItemId || !squareVariationId) {
    throw new Error(
      "Square Production link is missing for product: " +
      normalizedProductId +
      " (square_item_id: " + squareItemId +
      ", square_variation_id: " + squareVariationId + ")"
    );
  }

  // ------------------------------------------
  // 1. 最新の Square Production Item / Variation 取得 (GET)
  // ------------------------------------------
  const itemRes = squareProdRequest_(
    "/v2/catalog/object/" + encodeURIComponent(squareItemId),
    {
      method: "get"
    }
  );

  let itemData;
  try {
    itemData = JSON.parse(itemRes.body || "{}");
  } catch (_) {
    throw new Error(
      "Square Production Item RETRIEVE returned invalid JSON for product: " +
      normalizedProductId
    );
  }

  const currentItem = itemData.object;
  if (!currentItem || currentItem.type !== "ITEM") {
    throw new Error(
      "Square Production object is not an ITEM: " + squareItemId
    );
  }

  const variations =
    currentItem.item_data && Array.isArray(currentItem.item_data.variations)
      ? currentItem.item_data.variations
      : [];

  const currentVariation = variations.find(v =>
    v && String(v.id || "").trim() === squareVariationId
  );

  if (!currentVariation) {
    throw new Error(
      "linked Square Variation (" +
      squareVariationId +
      ") was not found in Square Production Item (" +
      squareItemId +
      ")"
    );
  }

  if (
    !Number.isSafeInteger(currentVariation.version) ||
    currentVariation.version < 0
  ) {
    throw new Error(
      "Square Production Variation version is invalid: " +
      currentVariation.version
    );
  }

  const oldPriceAmount =
    currentVariation.item_variation_data &&
    currentVariation.item_variation_data.price_money &&
    currentVariation.item_variation_data.price_money.amount;

  // 再試行安全性 (retry-safety):
  // 既に要求された新価格と一致している場合、二重Upsertを行わず成功として即時return
  if (oldPriceAmount === priceAmount) {
    const summary = {
      success: true,
      already_updated: true,
      environment: "production",
      product_id: normalizedProductId,
      square_item_id: squareItemId,
      square_variation_id: squareVariationId,
      old_price: oldPriceAmount,
      new_price: priceAmount,
      version: currentVariation.version
    };

    console.log(
      "Square Production Variation price is already up-to-date (" +
      priceAmount + " JPY): " + JSON.stringify(summary)
    );

    return summary;
  }

  // ------------------------------------------
  // 2. Variation オブジェクトのディープコピーと価格更新
  // Square UpsertCatalogObject の full replacement に従い、
  // 読み取り専用フィールドを除外し価格のみ変更
  // ------------------------------------------
  const clonedVariation = JSON.parse(JSON.stringify(currentVariation));

  // レスポンス専用 / 読み取り専用フィールドの除外
  delete clonedVariation.updated_at;
  delete clonedVariation.created_at;
  delete clonedVariation.is_deleted;
  delete clonedVariation.catalog_v1_ids;

  const clonedVariationData = clonedVariation.item_variation_data || {};
  delete clonedVariationData.ordinal;

  clonedVariationData.pricing_type = "FIXED_PRICING";
  clonedVariationData.price_money = {
    amount: priceAmount,
    currency: "JPY"
  };

  // location_overrides が存在し、価格が設定されている場合は併せて同期
  if (Array.isArray(clonedVariationData.location_overrides)) {
    clonedVariationData.location_overrides = clonedVariationData.location_overrides.map(override => {
      if (override && override.price_money) {
        return Object.assign({}, override, {
          price_money: {
            amount: priceAmount,
            currency: "JPY"
          }
        });
      }
      return override;
    });
  }

  clonedVariation.item_variation_data = clonedVariationData;

  // ------------------------------------------
  // 3. UpsertCatalogObject 実行 (POST /v2/catalog/object)
  // 決定論的 idempotency key (retry-safe)
  // 同一価格更新試行では同一keyとなり、バージョン更新や新価格では別keyとなる
  // ------------------------------------------
  const updatePayload = {
    idempotency_key:
      "ais-sq-prod-price-" +
      normalizedProductId +
      "-" +
      squareVariationId +
      "-v" +
      currentVariation.version +
      "-p" +
      priceAmount,
    object: clonedVariation
  };

  const updateRes = squareProdRequest_("/v2/catalog/object", {
    method: "post",
    payload: updatePayload
  });

  let updateData;
  try {
    updateData = JSON.parse(updateRes.body || "{}");
  } catch (_) {
    throw new Error(
      "Square Production Catalog price update returned invalid JSON for product: " +
      normalizedProductId
    );
  }

  const updatedObject = updateData.catalog_object || {};
  const updatedVarData = updatedObject.item_variation_data || {};
  const updatedAmount =
    updatedVarData.price_money && updatedVarData.price_money.amount;

  if (updatedAmount !== priceAmount) {
    throw new Error(
      "Failed to verify updated price on Square Production Variation (" +
      squareVariationId + "): expected " + priceAmount + ", got " + updatedAmount
    );
  }

  const summary = {
    success: true,
    environment: "production",
    product_id: normalizedProductId,
    square_item_id: squareItemId,
    square_variation_id: squareVariationId,
    old_price: oldPriceAmount,
    new_price: priceAmount,
    version: updatedObject.version
  };

  console.log(
    "Square Production Variation price successfully updated: " +
    JSON.stringify(summary)
  );

  return summary;
}




// ==================================================
// Square Production Catalog Item アーカイブ / アーカイブ解除 / 完全削除
// ==================================================

/**
 * Catalog Item オブジェクトを UpsertCatalogObject 用にサニタイズ（完全オブジェクト維持）
 *
 * Square Catalog API の UpsertCatalogObject は完全置換（full replacement）であるため、
 * variations 含む既存の writable な属性をすべて維持しつつ、
 * APIで拒否される read-only / response-only フィールドのみを除外する。
 *
 * 除外対象 (response-only / read-only):
 * - Item 直下: updated_at, created_at, is_deleted, catalog_v1_ids
 * - item_data 直下: ecom_uri, ecom_image_uris, sort_name, channels
 * - variation 直下: updated_at, created_at, is_deleted, catalog_v1_ids
 * - item_variation_data 直下: ordinal, sold_out, sold_out_valid_until, channels
 * - location_overrides 直下: sold_out, sold_out_valid_until, channels
 *
 * @param {Object} item Square Catalog Item オブジェクト
 * @return {Object} サニタイズされた完全 Catalog Item オブジェクト
 */
function sanitizeCatalogItemForUpsert_(item) {
  const cloned = JSON.parse(JSON.stringify(item));

  // 1. Item 直下の response-only / read-only 項目
  delete cloned.updated_at;
  delete cloned.created_at;
  delete cloned.is_deleted;
  delete cloned.catalog_v1_ids;

  if (cloned.item_data) {
    // 2. item_data 直下の response-only / read-only 項目
    // ※ sort_name は書き込み可能属性のため保持する（full-replacement semantics保護）
    delete cloned.item_data.ecom_uri;
    delete cloned.item_data.ecom_image_uris;
    delete cloned.item_data.description_plaintext;
    delete cloned.item_data.channels;

    // 3. variations 直下および item_variation_data 直下の response-only / read-only 項目
    if (Array.isArray(cloned.item_data.variations)) {
      cloned.item_data.variations.forEach(function(v) {
        if (v) {
          delete v.updated_at;
          delete v.created_at;
          delete v.is_deleted;
          delete v.catalog_v1_ids;

          if (v.item_variation_data) {
            delete v.item_variation_data.ordinal;
            delete v.item_variation_data.sold_out;
            delete v.item_variation_data.sold_out_valid_until;
            delete v.item_variation_data.channels;

            if (Array.isArray(v.item_variation_data.location_overrides)) {
              v.item_variation_data.location_overrides.forEach(function(loc) {
                if (loc) {
                  delete loc.sold_out;
                  delete loc.sold_out_valid_until;
                  delete loc.channels;
                }
              });
            }
          }
        }
      });
    }
  }

  return cloned;
}


/**
 * Square Production Catalog Item アーカイブ
 *
 * 指定されたBIS商品の square_item_id (AI列: 35) を使用し、
 * Square Catalog API (GET /v2/catalog/object/{id} -> item_data.is_archived = true -> POST /v2/catalog/object)
 * で Item をアーカイブする。
 *
 * 安全仕様:
 * 1. square_item_id が存在しない場合は例外をスロー
 * 2. GET で最新の Item オブジェクトを取得
 * 3. 既に is_archived === true の場合は Upsert をスキップして即時正常 return (冪等性・retry-safety)
 * 4. 完全オブジェクト Upsert: Variations を含む全既存属性を保持し、read-only 項目のみ除去
 * 5. 決定論的 idempotency key を使用
 *
 * @param {string} productId BIS商品ID
 * @return {{
 *   success: boolean,
 *   already_archived: boolean,
 *   environment: string,
 *   product_id: string,
 *   square_item_id: string,
 *   version: number
 * }}
 */
function archiveSquareProductionProduct(productId, options) {
  const normalizedProductId = String(productId || "").trim();

  if (!normalizedProductId) {
    throw new Error("product_id is required");
  }

  const sheet = (options && options.sheet) || SpreadsheetApp
    .getActiveSpreadsheet()
    .getSheets()[0];

  const squareRequester = (options && options.squareRequest) || squareProdRequest_;

  const targetRow = findProductRow(sheet, normalizedProductId);
  ensureSquareIdColumns(sheet);

  const row = sheet
    .getRange(targetRow, 1, 1, 36)
    .getValues()[0];

  const squareItemId = String(row[34] || "").trim();

  if (!squareItemId) {
    throw new Error(
      "Square Production link is missing for product: " +
      normalizedProductId +
      " (square_item_id: " + squareItemId + ")"
    );
  }

  // 1. 最新の Square Production Item 取得 (GET)
  const itemRes = squareRequester(
    "/v2/catalog/object/" + encodeURIComponent(squareItemId),
    {
      method: "get"
    }
  );

  let itemData;
  try {
    itemData = JSON.parse(itemRes.body || "{}");
  } catch (_) {
    throw new Error(
      "Square Production Item RETRIEVE returned invalid JSON for product: " +
      normalizedProductId
    );
  }

  const currentItem = itemData.object;
  if (!currentItem || currentItem.type !== "ITEM") {
    throw new Error(
      "Square Production object is not an ITEM: " + squareItemId
    );
  }

  if (
    !Number.isSafeInteger(currentItem.version) ||
    currentItem.version < 0
  ) {
    throw new Error(
      "Square Production Item version is invalid: " +
      currentItem.version
    );
  }

  const isAlreadyArchived = Boolean(
    currentItem.item_data &&
    currentItem.item_data.is_archived === true
  );

  // 再試行安全性 (retry-safety): 既にアーカイブ済みの場合は Upsert せず即時 return
  if (isAlreadyArchived) {
    const summary = {
      success: true,
      already_archived: true,
      environment: "production",
      product_id: normalizedProductId,
      square_item_id: squareItemId,
      version: currentItem.version
    };

    console.log(
      "Square Production Item is already archived for product " +
      normalizedProductId + ": " + JSON.stringify(summary)
    );

    return summary;
  }

  // 2. 完全オブジェクトのクローンと is_archived = true 設定
  // read-only / response-only フィールドのみ除去し、variations 含む全既存属性を保持
  const clonedItem = sanitizeCatalogItemForUpsert_(currentItem);
  clonedItem.item_data = clonedItem.item_data || {};
  clonedItem.item_data.is_archived = true;

  // 3. UpsertCatalogObject 実行 (POST /v2/catalog/object)
  // 決定論的 idempotency key (retry-safe)
  const idempotencyKey =
    "ais-sq-prod-archive-" +
    normalizedProductId +
    "-" +
    squareItemId +
    "-v" +
    currentItem.version;

  const updateRes = squareRequester("/v2/catalog/object", {
    method: "post",
    payload: {
      idempotency_key: idempotencyKey,
      object: clonedItem
    }
  });

  let updateData;
  try {
    updateData = JSON.parse(updateRes.body || "{}");
  } catch (_) {
    throw new Error(
      "Square Production Catalog archive returned invalid JSON for product: " +
      normalizedProductId
    );
  }

  const updatedObject = updateData.catalog_object;
  const newVersion = updatedObject && updatedObject.version !== undefined
    ? updatedObject.version
    : currentItem.version;

  const summary = {
    success: true,
    already_archived: false,
    environment: "production",
    product_id: normalizedProductId,
    square_item_id: squareItemId,
    version: newVersion
  };

  console.log(
    "Square Production Item successfully archived for product " +
    normalizedProductId + ": " + JSON.stringify(summary)
  );

  return summary;
}


/**
 * Square Production Catalog Item アーカイブ解除 (unarchive)
 *
 * 指定されたBIS商品の square_item_id (AI列: 35) を使用し、
 * Square Catalog API (GET /v2/catalog/object/{id} -> item_data.is_archived = false -> POST /v2/catalog/object)
 * で Item をアーカイブ解除する。
 *
 * 安全仕様:
 * 1. square_item_id が存在しない場合は例外をスロー
 * 2. GET で最新の Item オブジェクトを取得
 * 3. 既に is_archived !== true の場合は Upsert をスキップして即時正常 return (冪等性・retry-safety)
 * 4. 完全オブジェクト Upsert: Variations を含む全既存属性を保持し、read-only 項目のみ除去
 * 5. 決定論的 idempotency key を使用
 *
 * @param {string} productId BIS商品ID
 * @param {Object} [options] オプション / モック
 * @return {{
 *   success: boolean,
 *   already_active: boolean,
 *   environment: string,
 *   product_id: string,
 *   square_item_id: string,
 *   version: number
 * }}
 */
function unarchiveSquareProductionProduct(productId, options) {
  const normalizedProductId = String(productId || "").trim();

  if (!normalizedProductId) {
    throw new Error("product_id is required");
  }

  const sheet = (options && options.sheet) || SpreadsheetApp
    .getActiveSpreadsheet()
    .getSheets()[0];

  const squareRequester = (options && options.squareRequest) || squareProdRequest_;

  const targetRow = findProductRow(sheet, normalizedProductId);
  ensureSquareIdColumns(sheet);

  const row = sheet
    .getRange(targetRow, 1, 1, 36)
    .getValues()[0];

  const currentRecordStatus = String(row[33] || "active").trim();
  if (currentRecordStatus === "archived") {
    throw new Error(
      "cannot unarchive Square product for archived BIS product: " +
      normalizedProductId + ". Restore BIS product to active first."
    );
  }

  const squareItemId = String(row[34] || "").trim();

  if (!squareItemId) {
    throw new Error(
      "Square Production link is missing for product: " +
      normalizedProductId +
      " (square_item_id: " + squareItemId + ")"
    );
  }

  // 1. 最新の Square Production Item 取得 (GET)
  const itemRes = squareRequester(
    "/v2/catalog/object/" + encodeURIComponent(squareItemId),
    {
      method: "get"
    }
  );

  let itemData;
  try {
    itemData = JSON.parse(itemRes.body || "{}");
  } catch (_) {
    throw new Error(
      "Square Production Item RETRIEVE returned invalid JSON for product: " +
      normalizedProductId
    );
  }

  const currentItem = itemData.object;
  if (!currentItem || currentItem.type !== "ITEM") {
    throw new Error(
      "Square Production object is not an ITEM: " + squareItemId
    );
  }

  if (
    !Number.isSafeInteger(currentItem.version) ||
    currentItem.version < 0
  ) {
    throw new Error(
      "Square Production Item version is invalid: " +
      currentItem.version
    );
  }

  const isCurrentlyArchived = Boolean(
    currentItem.item_data &&
    currentItem.item_data.is_archived === true
  );

  // 再試行安全性 (retry-safety): 既にアクティブ (非アーカイブ) の場合は Upsert せず即時 return
  if (!isCurrentlyArchived) {
    const summary = {
      success: true,
      already_active: true,
      environment: "production",
      product_id: normalizedProductId,
      square_item_id: squareItemId,
      version: currentItem.version
    };

    console.log(
      "Square Production Item is already active (not archived) for product " +
      normalizedProductId + ": " + JSON.stringify(summary)
    );

    return summary;
  }

  // 2. 完全オブジェクトのクローンと is_archived = false 設定
  // read-only / response-only フィールドのみ除去し、variations 含む全既存属性を保持
  const clonedItem = sanitizeCatalogItemForUpsert_(currentItem);
  clonedItem.item_data = clonedItem.item_data || {};
  clonedItem.item_data.is_archived = false;

  // 3. UpsertCatalogObject 実行 (POST /v2/catalog/object)
  // 決定論的 idempotency key (retry-safe)
  const idempotencyKey =
    "ais-sq-prod-unarchive-" +
    normalizedProductId +
    "-" +
    squareItemId +
    "-v" +
    currentItem.version;

  const updateRes = squareRequester("/v2/catalog/object", {
    method: "post",
    payload: {
      idempotency_key: idempotencyKey,
      object: clonedItem
    }
  });

  let updateData;
  try {
    updateData = JSON.parse(updateRes.body || "{}");
  } catch (_) {
    throw new Error(
      "Square Production Catalog unarchive returned invalid JSON for product: " +
      normalizedProductId
    );
  }

  const updatedObject = updateData.catalog_object;
  const newVersion = updatedObject && updatedObject.version !== undefined
    ? updatedObject.version
    : currentItem.version;

  const summary = {
    success: true,
    already_active: false,
    environment: "production",
    product_id: normalizedProductId,
    square_item_id: squareItemId,
    version: newVersion
  };

  console.log(
    "Square Production Item successfully unarchived for product " +
    normalizedProductId + ": " + JSON.stringify(summary)
  );

  return summary;
}


/**
 * Square Production Catalog Item 完全削除 (hard delete)
 *
 * 指定されたBIS商品の square_item_id (AI列: 35) を使用し、
 * Square Catalog API (DELETE /v2/catalog/object/{id}) で Item を削除する。
 * Square 側のカスケード削除により、紐づく Variation も自動削除される。
 *
 * 安全仕様:
 * 1. square_item_id が存在しない場合は deleted: false で正常 return
 * 2. DELETE 実行で HTTP 200 または HTTP 404 (既に削除済み) の場合を成功とみなす
 * 3. HTTP 4xx/5xx (404以外) は例外をスロー
 * 4. ※注意: 監査性・追跡性を維持するため、本関数内でシートの Square ID 列はクリアしない
 *
 * @param {string} productId BIS商品ID
 * @return {{
 *   success: boolean,
 *   environment: string,
 *   product_id: string,
 *   square_item_id: string,
 *   deleted: boolean,
 *   already_missing: boolean,
 *   http_status: number,
 *   message: string
 * }}
 */
function deleteSquareProductionProduct(productId) {
  const normalizedProductId = String(productId || "").trim();

  if (!normalizedProductId) {
    throw new Error("product_id is required");
  }

  const sheet = SpreadsheetApp
    .getActiveSpreadsheet()
    .getSheets()[0];

  const targetRow = findProductRow(sheet, normalizedProductId);
  ensureSquareIdColumns(sheet);

  const row = sheet
    .getRange(targetRow, 1, 1, 36)
    .getValues()[0];

  const squareItemId = String(row[34] || "").trim();

  if (!squareItemId) {
    return {
      success: true,
      environment: "production",
      product_id: normalizedProductId,
      square_item_id: "",
      deleted: false,
      already_missing: false,
      http_status: 200,
      message: "No square_item_id found to delete"
    };
  }

  // DELETE /v2/catalog/object/{id}
  const delRes = squareProdRequest_(
    "/v2/catalog/object/" + encodeURIComponent(squareItemId),
    {
      method: "delete",
      allowError: true
    }
  );

  const isAlreadyMissing = delRes.httpStatus === 404;

  if (delRes.httpStatus >= 400 && !isAlreadyMissing) {
    throw new Error(
      "Failed to delete Square Production Catalog Item (" +
      squareItemId + "): HTTP " + delRes.httpStatus + ": " + delRes.body
    );
  }

  const summary = {
    success: true,
    environment: "production",
    product_id: normalizedProductId,
    square_item_id: squareItemId,
    deleted: true,
    already_missing: isAlreadyMissing,
    http_status: delRes.httpStatus,
    message: isAlreadyMissing
      ? "Square Production Catalog Item was already missing on Square (HTTP 404)"
      : "Square Production Catalog Item successfully deleted from Square"
  };

  if (isAlreadyMissing) {
    console.warn(
      "Square Production Catalog Item was already missing on Square (HTTP 404) for product " +
      normalizedProductId + " (item_id: " + squareItemId + ")"
    );
  } else {
    console.log(
      "Square Production Catalog Item successfully deleted for product " +
      normalizedProductId + " (item_id: " + squareItemId + ")"
    );
  }

  return summary;
}








// ==================================================
// Square Production 商品詳細情報同期 (Item.name / description_html / Variation.name)
// ==================================================

/**
 * Square Production 商品詳細情報同期
 *
 * BISの商品情報（商品名、サイズ、状態、商品説明など）に基づき、
 * 既存の Square Production Catalog Item の name / description_html および
 * 対象 Variation の name を同期更新する。
 *
 * 既存の price_money, SKU, track_inventory, location設定, 画像(image_ids),
 * 在庫数量, Payment Link, アーカイブ状態などは一切破壊せず維持する。
 *
 * @param {string} productId BIS商品ID
 * @return {Object} 処理結果サマリー
 */
function syncSquareProductionProductDetails(productId, options) {
  const normalizedProductId = String(productId || "").trim();

  if (!normalizedProductId) {
    throw new Error("product_id is required");
  }

  let prodLocationId = (options && options.locationId) || (options && options.propService && options.propService.getProperty("SQUARE_PROD_LOCATION_ID"));
  if (!prodLocationId) {
    try {
      prodLocationId = getSquareProdLocationId_(options && options.propService);
    } catch (_) {
      prodLocationId = "";
    }
  }

  if (!prodLocationId) {
    throw new Error("SQUARE_PROD_LOCATION_ID is required for Square Production");
  }

  const sheet = (options && options.sheet) || SpreadsheetApp
    .getActiveSpreadsheet()
    .getSheets()[0];

  const squareRequester = (options && options.squareRequest) || squareProdRequest_;

  ensureSquareIdColumns(sheet);

  const source = getSquareProductSourceData_(sheet, normalizedProductId);
  const targetRow = source.targetRow;

  // 公開・Square販売反映の共通検証（スニーカーのサイズ必須 & AI確定検証）
  assertProductPublishable_(sheet, targetRow, normalizedProductId);

  const squareItemId = source.square_item_id;
  const squareVariationId = source.square_variation_id;

  if (!squareItemId) {
    throw new Error(
      "Square Production link is missing for product: " +
      normalizedProductId +
      " (square_item_id is empty)"
    );
  }

  // 1. 最新の Square Production Item 取得 (GET /v2/catalog/object/{id})
  const itemRes = squareRequester(
    "/v2/catalog/object/" + encodeURIComponent(squareItemId),
    {
      method: "get"
    }
  );

  let itemData;
  try {
    itemData = JSON.parse(itemRes.body || "{}");
  } catch (_) {
    throw new Error(
      "Square Production Item RETRIEVE returned invalid JSON for product: " +
      normalizedProductId
    );
  }

  const currentItem = itemData.object;
  if (!currentItem || currentItem.type !== "ITEM") {
    throw new Error(
      "Square Production object is not an ITEM: " + squareItemId
    );
  }

  if (
    !Number.isSafeInteger(currentItem.version) ||
    currentItem.version < 0
  ) {
    throw new Error(
      "Square Production Item version is invalid: " +
      currentItem.version
    );
  }

  // 2. スニーカーの場合のみ Item Options (サイズ / 状態) を解決して設定
  const sneakerOptions = buildSquareSneakerItemOptions_(source);

  // 表示用データの構築（作成リクエストと照合の期待値は同じ命名処理から生成）
  const display = buildSquareProductDisplay_(source, sneakerOptions);

  // 3. 完全オブジェクトのクローンとサニタイズ（全既存属性を保護）
  const clonedItem = sanitizeCatalogItemForUpsert_(currentItem);
  clonedItem.item_data = clonedItem.item_data || {};

  // 4. 更新対象フィールドのみ上書き
  clonedItem.item_data.name = display.itemName;
  clonedItem.item_data.description_html = display.descriptionHtml;

  if (sneakerOptions && sneakerOptions.itemOptions) {
    clonedItem.item_data.item_options = sneakerOptions.itemOptions;
  }

  // 対象Variationの name および item_option_values を更新 (既存の price_money, SKU, track_inventory 等は保持)
  if (Array.isArray(clonedItem.item_data.variations)) {
    const targetVar = clonedItem.item_data.variations.find(v =>
      String(v && v.id || "").trim() === squareVariationId ||
      String(v && v.item_variation_data && v.item_variation_data.sku || "").trim() === normalizedProductId
    ) || clonedItem.item_data.variations[0];

    if (targetVar && targetVar.item_variation_data) {
      targetVar.item_variation_data.name = display.variationName;
      if (sneakerOptions && sneakerOptions.itemOptionValues) {
        targetVar.item_variation_data.item_option_values = sneakerOptions.itemOptionValues;
      }
    }
  }

  // 5. UpsertCatalogObject 実行 (POST /v2/catalog/object)
  // 決定論的 idempotency key (retry-safe)
  const idempotencyKey =
    "ais-sq-prod-details-" +
    normalizedProductId +
    "-" +
    squareItemId +
    "-v" +
    currentItem.version;

  const updateRes = squareRequester("/v2/catalog/object", {
    method: "post",
    payload: {
      idempotency_key: idempotencyKey,
      object: clonedItem
    }
  });

  let updateData;
  try {
    updateData = JSON.parse(updateRes.body || "{}");
  } catch (_) {
    throw new Error(
      "Square Production Catalog details update returned invalid JSON for product: " +
      normalizedProductId
    );
  }

  const updatedObject = updateData.catalog_object || {};

  const summary = {
    success: true,
    environment: "production",
    product_id: normalizedProductId,
    square_item_id: squareItemId,
    square_variation_id: squareVariationId,
    item_name: display.itemName,
    variation_name: display.variationName,
    description_html: display.descriptionHtml,
    version: updatedObject.version
  };

  console.log(
    "Square Production product details successfully synchronized for " +
    normalizedProductId + ": " + JSON.stringify(summary)
  );

  return summary;
}



// ==================================================
// Square Production Payments API List Payments 取得（内部helper）
// ==================================================

/**
 * Square Production Payments API List Payments 取得 helper
 *
 * @param {string} prodLocationId Location ID
 * @param {string} beginTimeIso 開始日時 (ISO 8601)
 * @param {string} endTimeIso 終了日時 (ISO 8601)
 * @param {string} [cursor] ページネーションカーソル
 * @return {Object} Payments API レスポンスオブジェクト
 */
function listSquareProductionPaymentsForPolling_(
  prodLocationId,
  beginTimeIso,
  endTimeIso,
  cursor
) {
  let query =
    "?location_id=" +
    encodeURIComponent(prodLocationId) +
    "&updated_at_begin_time=" +
    encodeURIComponent(beginTimeIso) +
    "&updated_at_end_time=" +
    encodeURIComponent(endTimeIso) +
    "&sort_field=UPDATED_AT" +
    "&sort_order=ASC" +
    "&limit=100";

  if (cursor) {
    query += "&cursor=" + encodeURIComponent(cursor);
  }

  const response = squareProdRequest_(
    "/v2/payments" + query,
    {
      method: "get"
    }
  );

  let responseData;
  try {
    responseData = JSON.parse(response.body || "{}");
  } catch (_) {
    throw new Error(
      "Square Production Payments API returned invalid JSON"
    );
  }

  return responseData;
}


// ==================================================
// Square Production Payment ポーリング初期化
// ==================================================

/**
 * Square Production Payment ポーリング用高水位（last success）の初期化
 * 現在時刻を SQUARE_PROD_PAYMENT_POLL_LAST_SUCCESS_AT に保存
 *
 * 注意:
 * - Square API は呼ばない
 * - Google Sheets / BIS 商品マスターは変更しない
 * - trigger は作成しない
 *
 * @return {{
 *   success: boolean,
 *   environment: string,
 *   initialized_at: string
 * }}
 */
function initializeSquareProductionPaymentPolling() {
  const now = new Date();
  const isoNow = now.toISOString();

  PropertiesService
    .getScriptProperties()
    .setProperty(
      "SQUARE_PROD_PAYMENT_POLL_LAST_SUCCESS_AT",
      isoNow
    );

  console.log("Square Production payment polling initialized at: " + isoNow);

  return {
    success: true,
    environment: "production",
    initialized_at: isoNow
  };
}


// ==================================================
// BIS商品マスター square_variation_id マップ構築（一括取得・N+1防止・重複ガード）
// ==================================================

/**
 * BIS商品マスターから square_variation_id (AJ列) -> 商品情報の Map を1回で一括構築
 * Spreadsheet への N+1 アクセスを完全に防止し、Variation ID の重複を厳格にガードする
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet 商品マスターシート
 * @return {Object.<string, {product_id: string, product_name: string, inventory_status: string, row_index: number}>}
 */
function buildSquareVariationProductMap_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return {};
  }

  // 1行目はヘッダー、2行目から lastRow まで一括取得（1〜36列/AJ列まで）
  const allRows = sheet
    .getRange(2, 1, lastRow - 1, 36)
    .getValues();

  const map = {};
  for (let i = 0; i < allRows.length; i++) {
    const row = allRows[i];
    const variationId = String(row[35] || "").trim(); // AJ列 (0-indexed 35)
    if (variationId) {
      if (Object.prototype.hasOwnProperty.call(map, variationId)) {
        throw new Error(
          "duplicate square_variation_id in product master: " + variationId
        );
      }
      map[variationId] = {
        product_id: String(row[1] || "").trim(),        // B列 (0-indexed 1)
        product_name: String(row[4] || "").trim(),      // E列 (0-indexed 4)
        inventory_status: String(row[32] || "").trim(),  // AG列 (0-indexed 32)
        record_status: String(row[33] || "").trim(),     // AH列 (0-indexed 33)
        row_index: i + 2
      };
    }
  }

  return map;
}


// ==================================================
// Square Production Payment READ ONLY プレビュー
// ==================================================

/**
 * Square Production 完了済み Payment の READ ONLY プレビュー取得
 *
 * SQUARE_PROD_PAYMENT_POLL_LAST_SUCCESS_AT から2分オーバーラップで検索開始時刻を作成し、
 * preview開始時点の固定時刻までを検索窓として完了済みPaymentを取得する。
 * 各PaymentのOrderおよびLine Itemsに含まれるVariation IDをBIS商品マスター（AJ列）と照合する。
 *
 * 厳格制約:
 * - BIS商品マスターの状態（inventory_status等）は一切変更しない（READ ONLY）
 * - Google Sheets への setValue / setValues は呼び出さない
 * - Drive / BIS 画像は変更しない
 * - SQUARE_PROD_PAYMENT_POLL_LAST_SUCCESS_AT は更新しない（固定anchor、cursor_updated: false）
 * - 自動トリガー（ScriptApp.newTrigger）は作成しない
 * - Access Token はログに出力しない
 *
 * @return {{
 *   success: boolean,
 *   environment: string,
 *   last_success_at: string,
 *   search_begin_at: string,
 *   search_end_at: string,
 *   cursor_updated: boolean,
 *   completed_payment_count: number,
 *   payments: Array<Object>
 * }}
 */
function previewSquareProductionCompletedPayments() {
  const scriptProperties = PropertiesService.getScriptProperties();

  const prodLocationId = String(
    scriptProperties.getProperty("SQUARE_PROD_LOCATION_ID") || ""
  ).trim();

  if (!prodLocationId) {
    throw new Error("SQUARE_PROD_LOCATION_ID is required for Square Production");
  }

  // 1. preview 基準時刻を固定（全 pagination で updated_at_end_time を統一）
  const pollStartedAt = new Date();
  const pollStartedAtIso = pollStartedAt.toISOString();

  // 2. last success 時刻の取得（未初期化チェック）
  //    preview ではこの時刻を更新せず、固定 anchor として参照のみ行う
  const lastSuccessAt = String(
    scriptProperties.getProperty("SQUARE_PROD_PAYMENT_POLL_LAST_SUCCESS_AT") || ""
  ).trim();

  if (!lastSuccessAt) {
    throw new Error(
      "Square Production payment polling is not initialized. Please run initializeSquareProductionPaymentPolling() first."
    );
  }

  const lastSuccessTime = new Date(lastSuccessAt).getTime();
  if (isNaN(lastSuccessTime)) {
    throw new Error(
      "Invalid SQUARE_PROD_PAYMENT_POLL_LAST_SUCCESS_AT: " + lastSuccessAt
    );
  }

  // 3. 検索開始時刻（2分オーバーラップ: 120,000ms）
  const overlapMs = typeof SQUARE_PAYMENT_POLL_OVERLAP_MS === "number"
    ? SQUARE_PAYMENT_POLL_OVERLAP_MS
    : 120000;
  const searchBeginTime = new Date(lastSuccessTime - overlapMs);
  const searchBeginAtIso = searchBeginTime.toISOString();

  // 4. Payments API Pagination 取得
  let cursor = "";
  let pageCount = 0;
  const allPayments = [];

  do {
    pageCount++;
    if (pageCount > 20) {
      throw new Error(
        "Square Production payment polling exceeded page limit"
      );
    }

    const pageData = listSquareProductionPaymentsForPolling_(
      prodLocationId,
      searchBeginAtIso,
      pollStartedAtIso,
      cursor
    );

    const payments = Array.isArray(pageData.payments)
      ? pageData.payments
      : [];

    for (let p = 0; p < payments.length; p++) {
      allPayments.push(payments[p]);
    }

    cursor = String(pageData.cursor || "").trim();
  } while (cursor);

  // 5. Payment 抽出・フィルタリング (status === "COMPLETED" && location_id 一致)
  const completedPayments = [];

  for (let i = 0; i < allPayments.length; i++) {
    const payment = allPayments[i];

    if (
      payment.location_id &&
      String(payment.location_id).trim() !== prodLocationId
    ) {
      continue;
    }

    const status = String(payment.status || "").trim();
    if (status !== "COMPLETED") {
      continue;
    }

    completedPayments.push(payment);
  }

  // 6. BIS商品マスターの square_variation_id Map を一括構築（N+1防止 & 重複ガード）
  const sheet = SpreadsheetApp
    .getActiveSpreadsheet()
    .getSheets()[0];

  const variationProductMap = buildSquareVariationProductMap_(sheet);

  // 7. 各 Payment の Order を取得し、Line Items と BIS AJ列を照合
  const previewPayments = [];

  for (let j = 0; j < completedPayments.length; j++) {
    const payment = completedPayments[j];
    const paymentId = String(payment.id || "").trim();
    const orderId = String(payment.order_id || "").trim();
    const amountMoney = payment.amount_money || {};
    const amount = Object.prototype.hasOwnProperty.call(amountMoney, "amount")
      ? amountMoney.amount
      : null;
    const currency = String(amountMoney.currency || "JPY").trim();
    const sourceType = String(payment.source_type || "").trim();
    const createdAt = String(payment.created_at || "").trim();
    const updatedAt = String(payment.updated_at || "").trim();

    // order_id が存在しない場合
    if (!orderId) {
      previewPayments.push({
        payment_id: paymentId,
        order_id: "",
        status: "COMPLETED",
        amount: amount,
        currency: currency,
        created_at: createdAt,
        updated_at: updatedAt,
        source_type: sourceType,
        match_status: "no_order_id",
        line_items: []
      });
      continue;
    }

    // Order 取得
    let order = null;
    let orderFetchError = null;

    try {
      const orderRes = squareProdRequest_(
        "/v2/orders/" + encodeURIComponent(orderId),
        {
          method: "get"
        }
      );

      let orderData;
      try {
        orderData = JSON.parse(orderRes.body || "{}");
      } catch (_) {
        orderData = {};
      }

      order = orderData.order || null;
    } catch (orderErr) {
      orderFetchError = orderErr.message || String(orderErr);
    }

    // Order 取得失敗時のハンドリング（全体を落とさずエラー情報を残す）
    if (orderFetchError || !order) {
      previewPayments.push({
        payment_id: paymentId,
        order_id: orderId,
        status: "COMPLETED",
        amount: amount,
        currency: currency,
        created_at: createdAt,
        updated_at: updatedAt,
        source_type: sourceType,
        match_status: "order_fetch_failed",
        error: orderFetchError || "Square Order was not returned",
        line_items: []
      });
      continue;
    }

    // Line Items の照合
    const orderLineItems = Array.isArray(order.line_items)
      ? order.line_items
      : [];

    const lineItemsPreview = [];

    for (let k = 0; k < orderLineItems.length; k++) {
      const item = orderLineItems[k];
      const catalogObjectId = String(item && item.catalog_object_id || "").trim();
      const quantity = String(item && item.quantity || "1").trim();
      const itemName = String(item && item.name || "").trim();

      let matchedProductId = null;
      let matchedProductName = null;
      let matchStatus = "not_found";

      if (!catalogObjectId) {
        matchStatus = "no_catalog_object";
      } else if (Object.prototype.hasOwnProperty.call(variationProductMap, catalogObjectId)) {
        const matched = variationProductMap[catalogObjectId];
        matchedProductId = matched.product_id;
        matchedProductName = matched.product_name;
        matchStatus = "matched";
      } else {
        matchStatus = "not_found";
      }

      lineItemsPreview.push({
        catalog_object_id: catalogObjectId,
        quantity: quantity,
        name: itemName,
        matched_product_id: matchedProductId,
        matched_product_name: matchedProductName,
        match_status: matchStatus
      });
    }

    previewPayments.push({
      payment_id: paymentId,
      order_id: orderId,
      status: "COMPLETED",
      amount: amount,
      currency: currency,
      created_at: createdAt,
      updated_at: updatedAt,
      source_type: sourceType,
      line_items: lineItemsPreview
    });
  }

  const summary = {
    success: true,
    environment: "production",
    last_success_at: lastSuccessAt,
    search_begin_at: searchBeginAtIso,
    search_end_at: pollStartedAtIso,
    cursor_updated: false,
    completed_payment_count: completedPayments.length,
    payments: previewPayments
  };

  console.log(JSON.stringify(summary));
  return summary;
}


// ==================================================
// Square Production Payment READ ONLY プレビュー 手動テスト用
// ==================================================



// ==================================================
// Square Production 販売Order処理（BIS販売反映）
// ==================================================

/**
 * Square Production の完了した Order に含まれる BIS 商品の在庫状態を sold に更新する
 *
 * 処理フロー:
 * 1. orderId の必須検証
 * 2. GET /v2/orders/{orderId} を squareProdRequest_ で取得
 * 3. order.location_id が SQUARE_PROD_LOCATION_ID と一致することを確認
 * 4. 商品マスターを buildSquareVariationProductMap_() で一括走査（N+1防止 & 重複ガード）
 * 5. 全 line_items を事前検証し、実行計画（executionPlans）を構築
 *    - BIS管理外（AJ列未登録）: status = "unmanaged"（スキップ、全体エラーにしない）
 *    - 数量が "1" 以外: status = "unsupported_quantity"（BIS更新せずスキップ）
 *    - 既に sold: status = "already_sold"（二重更新防止、正常扱い）
 *    - in_stock / reserved: status = "sold"
 * 6. Phase 2: status === "sold" の BIS 行のみ updateProductInventoryStatusOnSheet() で "sold" に更新
 *
 * 安全条件:
 * - square_item_id, square_variation_id, record_status は変更しない
 * - Square Catalog, Square Inventory, Drive は変更しない
 *
 * @param {string} orderId Square Order ID
 * @param {Object} [options] 呼び出し元からの追加オプション
 * @param {Object} [options.payment] Poller等で事前検証済みのCOMPLETED Paymentオブジェクト
 * @return {{
 *   success: boolean,
 *   environment: string,
 *   order_id: string,
 *   order_state: string,
 *   line_item_count: number,
 *   sold_product_count: number,
 *   already_sold_count: number,
 *   unmanaged_count: number,
 *   unsupported_quantity_count: number,
 *   results: Array<{
 *     catalog_object_id: string,
 *     product_id: string|null,
 *     status: string
 *   }>
 * }}
 */
function processSquareProductionSaleOrder(orderId, options) {
  const normalizedOrderId = String(orderId || "").trim();

  if (!normalizedOrderId) {
    throw new Error("order_id is required");
  }

  const scriptProperties = PropertiesService.getScriptProperties();

  const prodLocationId = String(
    scriptProperties.getProperty("SQUARE_PROD_LOCATION_ID") || ""
  ).trim();

  if (!prodLocationId) {
    throw new Error("SQUARE_PROD_LOCATION_ID is required for Square Production");
  }

  // 1. Order 取得
  const orderRes = squareProdRequest_(
    "/v2/orders/" + encodeURIComponent(normalizedOrderId),
    {
      method: "get"
    }
  );

  let orderData;
  try {
    orderData = JSON.parse(orderRes.body || "{}");
  } catch (_) {
    throw new Error("Square Production Orders API returned invalid JSON");
  }

  const order = orderData.order;
  if (!order) {
    throw new Error("Square Production Order was not returned");
  }

  const orderLocationId = String(order.location_id || "").trim();
  if (!orderLocationId) {
    throw new Error("Square Production Order location_id was not returned");
  }

  if (orderLocationId !== prodLocationId) {
    throw new Error("Square Production Order location does not match configured location");
  }

  const orderState = String(order.state || "").trim();

  if (orderState === "COMPLETED") {
    // 既存の即時完了注文（POS等）: そのまま許可
  } else if (orderState === "OPEN") {
    // 条件1: SHIPMENT fulfillment の存在確認
    const fulfillments = Array.isArray(order.fulfillments)
      ? order.fulfillments
      : [];
    const hasShipmentFulfillment = fulfillments.some(f =>
      f && String(f.type || "").trim() === "SHIPMENT"
    );

    if (!hasShipmentFulfillment) {
      throw new Error(
        "Square Production Order is OPEN but does not have SHIPMENT fulfillment: " +
        normalizedOrderId
      );
    }

    // 条件2〜4: Payment が COMPLETED かつ 対象Location かつ 対象Order であることの検証
    let verifiedPayment = null;
    const callerPayment = options && options.payment;

    if (callerPayment) {
      // Poller経由: すでに検証済みの Payment 情報を options 経由で受け取る
      const payStatus = String(callerPayment.status || "").trim();
      const payLocationId = String(callerPayment.location_id || "").trim();
      const payOrderId = String(callerPayment.order_id || "").trim();

      if (
        payStatus === "COMPLETED" &&
        payLocationId === prodLocationId &&
        payOrderId === normalizedOrderId
      ) {
        verifiedPayment = callerPayment;
      }
    } else {
      // 手動実行・単体呼び出し時: order.tenders[].payment_id から Payment を取得して再検証
      const tenders = Array.isArray(order.tenders) ? order.tenders : [];
      const paymentId = tenders
        .map(t => t && String(t.payment_id || "").trim())
        .find(Boolean);

      if (paymentId) {
        const payRes = squareProdRequest_(
          "/v2/payments/" + encodeURIComponent(paymentId),
          {
            method: "get"
          }
        );

        let payData;
        try {
          payData = JSON.parse(payRes.body || "{}");
        } catch (_) {
          payData = {};
        }

        const payment = payData.payment || {};
        const payStatus = String(payment.status || "").trim();
        const payLocationId = String(payment.location_id || "").trim();
        const payOrderId = String(payment.order_id || "").trim();

        if (
          payStatus === "COMPLETED" &&
          payLocationId === prodLocationId &&
          payOrderId === normalizedOrderId
        ) {
          verifiedPayment = payment;
        }
      }
    }

    if (!verifiedPayment) {
      throw new Error(
        "Square Production Order is OPEN but completed payment was not verified: " +
        normalizedOrderId
      );
    }
  } else {
    // CANCELED, DRAFT などは従来通り拒否
    throw new Error(
      "Square Production Order is not completed or valid open shipment: " +
      normalizedOrderId +
      " (state: " + orderState + ")"
    );
  }

  const lineItems = Array.isArray(order.line_items)
    ? order.line_items
    : [];

  const sheet = SpreadsheetApp
    .getActiveSpreadsheet()
    .getSheets()[0];

  // 2. 商品マスターの square_variation_id Map を一括構築（N+1防止 & 重複ガード）
  const variationProductMap = buildSquareVariationProductMap_(sheet);

  // ------------------------------------------
  // Phase 1: 全 line_items の事前検証・計画構築
  // ------------------------------------------
  const executionPlans = [];
  const seenVariationIdsInOrder = new Set();

  for (let i = 0; i < lineItems.length; i++) {
    const lineItem = lineItems[i];
    const catalogObjectId = String(lineItem && lineItem.catalog_object_id || "").trim();
    const quantity = String(lineItem && lineItem.quantity || "").trim();

    // Catalog 未紐づけ（カスタム金額など）
    if (!catalogObjectId) {
      executionPlans.push({
        status: "unmanaged",
        catalog_object_id: "",
        quantity: quantity,
        product_id: null,
        target_row: -1
      });
      continue;
    }

    // BIS 管理外の Square 商品
    if (!Object.prototype.hasOwnProperty.call(variationProductMap, catalogObjectId)) {
      executionPlans.push({
        status: "unmanaged",
        catalog_object_id: catalogObjectId,
        quantity: quantity,
        product_id: null,
        target_row: -1
      });
      continue;
    }

    const matched = variationProductMap[catalogObjectId];
    const productId = matched.product_id;
    const targetRow = matched.row_index;
    const inventoryStatus = matched.inventory_status;
    const recordStatus = matched.record_status;

    // 同一 BIS 商品の重複 line item チェック
    if (seenVariationIdsInOrder.has(catalogObjectId)) {
      executionPlans.push({
        status: "duplicate_line_item",
        catalog_object_id: catalogObjectId,
        quantity: quantity,
        product_id: productId,
        target_row: targetRow
      });
      continue;
    }
    seenVariationIdsInOrder.add(catalogObjectId);

    // quantity 検証（BIS 商品は 1 点物モデルのため quantity === "1" を通常ケースとする）
    if (quantity !== "1") {
      executionPlans.push({
        status: "unsupported_quantity",
        catalog_object_id: catalogObjectId,
        quantity: quantity,
        product_id: productId,
        target_row: targetRow
      });
      continue;
    }

    // record_status 検証
    if (recordStatus === "archived") {
      throw new Error(
        "archived BIS product was sold in Square Production: " +
        productId +
        " (variation: " +
        catalogObjectId +
        ")"
      );
    }

    // inventory_status 判定（二重処理防止）
    if (inventoryStatus === "sold") {
      executionPlans.push({
        status: "already_sold",
        catalog_object_id: catalogObjectId,
        quantity: quantity,
        product_id: productId,
        target_row: targetRow
      });
    } else if (
      inventoryStatus === "in_stock" ||
      inventoryStatus === "reserved"
    ) {
      executionPlans.push({
        status: "sold",
        catalog_object_id: catalogObjectId,
        quantity: quantity,
        product_id: productId,
        target_row: targetRow
      });
    } else {
      throw new Error(
        "invalid inventory_status for BIS product: " +
        inventoryStatus +
        " (" +
        productId +
        ")"
      );
    }
  }

  // ------------------------------------------
  // Phase 2: 対象 BIS 行の sold 更新
  // ------------------------------------------
  let soldProductCount = 0;
  let alreadySoldCount = 0;
  let unmanagedCount = 0;
  let unsupportedQuantityCount = 0;

  const processedRows = new Set();

  for (let j = 0; j < executionPlans.length; j++) {
    const plan = executionPlans[j];

    if (plan.status === "sold") {
      if (!processedRows.has(plan.target_row)) {
        updateProductInventoryStatusOnSheet(
          sheet,
          plan.target_row,
          "sold"
        );
        processedRows.add(plan.target_row);

        // Best effort で Payment Link を無効化
        // Poller は成功カーソルを進めるため、Link無効化の失敗で例外送出しない
        try {
          invalidateSquareProductionPaymentLink(plan.product_id);
        } catch (linkErr) {
          console.warn(
            "[WARN] Best-effort Payment Link invalidation failed for sold product " +
            plan.product_id +
            ":",
            linkErr
          );
        }
      }
      soldProductCount++;
    } else if (plan.status === "already_sold") {
      alreadySoldCount++;
    } else if (plan.status === "unmanaged") {
      unmanagedCount++;
    } else if (plan.status === "unsupported_quantity") {
      unsupportedQuantityCount++;
    }
  }

  const summary = {
    success: true,
    environment: "production",
    order_id: normalizedOrderId,
    order_state: String(order.state || ""),
    line_item_count: lineItems.length,
    sold_product_count: soldProductCount,
    already_sold_count: alreadySoldCount,
    unmanaged_count: unmanagedCount,
    unsupported_quantity_count: unsupportedQuantityCount,
    results: executionPlans.map(plan => ({
      catalog_object_id: plan.catalog_object_id,
      product_id: plan.product_id,
      status: plan.status
    }))
  };

  console.log(JSON.stringify(summary));
  return summary;
}


// ==================================================
// Square Production 販売Order処理 手動テスト
// SQUARE_PROD_TEST_ORDER_ID を使用
// ==================================================



// ==================================================
// Square Production Payment ポーリング本体
// ==================================================

/**
 * Square Production の完了済み Payment を定期取得し BIS 在庫を更新する
 *
 * 処理フロー:
 * 1. ScriptLock 取得（同時二重実行を防止）
 * 2. poll 開始基準時刻（pollStartedAtIso）を固定
 * 3. SQUARE_PROD_PAYMENT_POLL_LAST_SUCCESS_AT を取得（未初期化チェック）
 * 4. 2分オーバーラップで検索開始時刻（searchBeginAtIso）を生成
 * 5. Payments API をページネーション走査して COMPLETED かつ location 一致の決済を抽出
 * 6. order_id を重複排除（order_id なしは no_order_id_count としてスキップ）
 * 7. 各 Order に対して processSquareProductionSaleOrder(orderId) を try-catch で安全に実行
 *    - already_sold / unmanaged / sold: 正常処理
 *    - unsupported_quantity / duplicate_line_item / 例外エラー: 異常系として集計し、cursor更新を阻止
 * 8. 全 Order 処理が完全に正常終了した場合のみ SQUARE_PROD_PAYMENT_POLL_LAST_SUCCESS_AT を pollStartedAtIso に更新
 * 9. lock 解放
 *
 * @return {{
 *   success: boolean,
 *   environment: string,
 *   search_begin_at: string,
 *   search_end_at: string,
 *   previous_last_success_at: string,
 *   new_last_success_at: string,
 *   payment_count: number,
 *   completed_payment_count: number,
 *   skipped_non_completed_count: number,
 *   skipped_wrong_location_count: number,
 *   no_order_id_count: number,
 *   unique_order_count: number,
 *   sold_product_count: number,
 *   already_sold_count: number,
 *   unmanaged_count: number,
 *   failed_order_count: number,
 *   cursor_updated: boolean,
 *   cursor_updated_to: string,
 *   orders: Array<Object>
 * }}
 */
function pollSquareProductionCompletedPayments() {
  const scriptProperties = PropertiesService.getScriptProperties();

  const prodLocationId = String(
    scriptProperties.getProperty("SQUARE_PROD_LOCATION_ID") || ""
  ).trim();

  if (!prodLocationId) {
    throw new Error("SQUARE_PROD_LOCATION_ID is required for Square Production");
  }

  const lock = LockService.getScriptLock();

  try {
    // 同時実行による重複処理や high-water mark の後退を防止
    lock.waitLock(10000);

    // 1. poll 基準時刻を固定
    const pollStartedAt = new Date();
    const pollStartedAtIso = pollStartedAt.toISOString();

    // 2. last success 時刻の取得と未初期化チェック
    const lastSuccessAt = String(
      scriptProperties.getProperty("SQUARE_PROD_PAYMENT_POLL_LAST_SUCCESS_AT") || ""
    ).trim();

    if (!lastSuccessAt) {
      throw new Error(
        "Square Production payment polling is not initialized. Please run initializeSquareProductionPaymentPolling() first."
      );
    }

    const lastSuccessTime = new Date(lastSuccessAt).getTime();
    if (isNaN(lastSuccessTime)) {
      throw new Error(
        "Invalid SQUARE_PROD_PAYMENT_POLL_LAST_SUCCESS_AT: " + lastSuccessAt
      );
    }

    // 3. 検索開始時刻（2分オーバーラップ: 120,000ms）
    const overlapMs = typeof SQUARE_PAYMENT_POLL_OVERLAP_MS === "number"
      ? SQUARE_PAYMENT_POLL_OVERLAP_MS
      : 120000;
    const searchBeginTime = new Date(lastSuccessTime - overlapMs);
    const searchBeginAtIso = searchBeginTime.toISOString();

    // 4. Payments API Pagination 取得
    const maxPages = typeof MAX_PAYMENT_POLL_PAGES === "number"
      ? MAX_PAYMENT_POLL_PAGES
      : 20;

    let cursor = "";
    let pageCount = 0;
    const allPayments = [];

    do {
      pageCount++;
      if (pageCount > maxPages) {
        throw new Error(
          "Square Production payment polling exceeded page limit"
        );
      }

      const pageData = listSquareProductionPaymentsForPolling_(
        prodLocationId,
        searchBeginAtIso,
        pollStartedAtIso,
        cursor
      );

      const payments = Array.isArray(pageData.payments)
        ? pageData.payments
        : [];

      for (let p = 0; p < payments.length; p++) {
        allPayments.push(payments[p]);
      }

      cursor = String(pageData.cursor || "").trim();
    } while (cursor);

    // 5. Payment 抽出・フィルタリング (status === "COMPLETED" && location_id 一致) & order_id 重複排除
    let completedPaymentCount = 0;
    let skippedNonCompletedCount = 0;
    let skippedNoOrderCount = 0;
    let skippedWrongLocationCount = 0;

    const targetOrderIds = [];
    const seenOrderIdsInThisPoll = new Set();
    const paymentsByOrderId = new Map();

    for (let i = 0; i < allPayments.length; i++) {
      const payment = allPayments[i];

      if (
        payment.location_id &&
        String(payment.location_id).trim() !== prodLocationId
      ) {
        skippedWrongLocationCount++;
        continue;
      }

      const status = String(payment.status || "").trim();
      if (status !== "COMPLETED") {
        skippedNonCompletedCount++;
        continue;
      }

      completedPaymentCount++;

      const orderId = String(payment.order_id || "").trim();
      if (!orderId) {
        skippedNoOrderCount++;
        continue;
      }

      if (!seenOrderIdsInThisPoll.has(orderId)) {
        seenOrderIdsInThisPoll.add(orderId);
        targetOrderIds.push(orderId);
        paymentsByOrderId.set(orderId, payment);
      }
    }

    // 6. 各 Order に対する processSquareProductionSaleOrder 呼び出し
    let totalSoldProductCount = 0;
    let totalAlreadySoldCount = 0;
    let totalUnmanagedCount = 0;
    let failedOrderCount = 0;
    let unprocessableOrderCount = 0;
    const orderResults = [];

    for (let j = 0; j < targetOrderIds.length; j++) {
      const orderId = targetOrderIds[j];

      try {
        const paymentInfo = paymentsByOrderId.get(orderId);
        const saleResult = processSquareProductionSaleOrder(orderId, {
          payment: paymentInfo || null
        });

        // 自動処理不能な結果（unsupported_quantity / duplicate_line_item）の検査
        const lineResults = Array.isArray(saleResult.results) ? saleResult.results : [];
        let hasUnprocessableLine = false;

        for (let k = 0; k < lineResults.length; k++) {
          const lineRes = lineResults[k];
          if (
            lineRes.status === "unsupported_quantity" ||
            lineRes.status === "duplicate_line_item"
          ) {
            hasUnprocessableLine = true;
            break;
          }
        }

        if (hasUnprocessableLine) {
          unprocessableOrderCount++;
          orderResults.push({
            order_id: orderId,
            status: "unprocessable",
            sold_product_count: saleResult.sold_product_count || 0,
            already_sold_count: saleResult.already_sold_count || 0,
            unmanaged_count: saleResult.unmanaged_count || 0,
            results: lineResults
          });
        } else {
          totalSoldProductCount += (saleResult.sold_product_count || 0);
          totalAlreadySoldCount += (saleResult.already_sold_count || 0);
          totalUnmanagedCount += (saleResult.unmanaged_count || 0);

          orderResults.push({
            order_id: orderId,
            status: "processed",
            sold_product_count: saleResult.sold_product_count || 0,
            already_sold_count: saleResult.already_sold_count || 0,
            unmanaged_count: saleResult.unmanaged_count || 0,
            results: lineResults
          });
        }
      } catch (orderErr) {
        failedOrderCount++;
        orderResults.push({
          order_id: orderId,
          status: "failed",
          error: orderErr.message || String(orderErr)
        });
      }
    }

    // 7. エラーまたは処理不能 Order が存在する場合は cursor を更新せず例外をスロー
    if (failedOrderCount > 0 || unprocessableOrderCount > 0) {
      console.error(
        "Square Production payment polling had errors. failed: " +
        failedOrderCount + ", unprocessable: " + unprocessableOrderCount +
        ". Results: " + JSON.stringify(orderResults)
      );

      throw new Error(
        "Square Production payment polling failed (" +
        failedOrderCount + " orders failed, " +
        unprocessableOrderCount + " unprocessable). Cursor was NOT updated."
      );
    }

    // 8. 全 Order 処理が完全に正常終了した場合のみ cursor (last success) を更新
    PropertiesService
      .getScriptProperties()
      .setProperty(
        "SQUARE_PROD_PAYMENT_POLL_LAST_SUCCESS_AT",
        pollStartedAtIso
      );

    const summary = {
      success: true,
      environment: "production",
      search_begin_at: searchBeginAtIso,
      search_end_at: pollStartedAtIso,
      previous_last_success_at: lastSuccessAt,
      new_last_success_at: pollStartedAtIso,
      payment_count: allPayments.length,
      completed_payment_count: completedPaymentCount,
      skipped_non_completed_count: skippedNonCompletedCount,
      skipped_wrong_location_count: skippedWrongLocationCount,
      no_order_id_count: skippedNoOrderCount,
      unique_order_count: targetOrderIds.length,
      sold_product_count: totalSoldProductCount,
      already_sold_count: totalAlreadySoldCount,
      unmanaged_count: totalUnmanagedCount,
      failed_order_count: 0,
      cursor_updated: true,
      cursor_updated_to: pollStartedAtIso,
      orders: orderResults
    };

    console.log(JSON.stringify(summary));
    return summary;
  } finally {
    lock.releaseLock();
  }
}


// ==================================================
// Square連携ID保存列を確認
// AI = square_item_id
// AJ = square_variation_id
// ==================================================

function ensureSquareIdColumns(sheet) {
  const squareItemIdColumn = 35;
  const squareVariationIdColumn = 36;

  const requiredLastColumn =
    squareVariationIdColumn;

  const maxColumns =
    sheet.getMaxColumns();

  if (maxColumns < requiredLastColumn) {
    sheet.insertColumnsAfter(
      maxColumns,
      requiredLastColumn - maxColumns
    );
  }

  const lastRow =
    Math.max(sheet.getLastRow(), 1);

  const squareColumnsRange =
    sheet.getRange(
      1,
      squareItemIdColumn,
      lastRow,
      2
    );

  const values =
    squareColumnsRange.getValues();

  const formulas =
    squareColumnsRange.getFormulas();

  const expectedHeaders = [
    "square_item_id",
    "square_variation_id"
  ];

  expectedHeaders.forEach(
    (expectedHeader, index) => {
      const header = String(
        values[0][index] || ""
      ).trim();

      if (
        header &&
        header !== expectedHeader
      ) {
        throw new Error(
          (index === 0 ? "AI" : "AJ") +
          " column is already in use"
        );
      }

      if (!header) {
        const hasExistingData =
          values
            .slice(1)
            .some(row =>
              String(
                row[index] || ""
              ).trim() !== ""
            ) ||
          formulas
            .slice(1)
            .some(row =>
              String(
                row[index] || ""
              ).trim() !== ""
            );

        if (hasExistingData) {
          throw new Error(
            (index === 0 ? "AI" : "AJ") +
            " column is already in use"
          );
        }
      }
    }
  );

  const currentHeaders =
    values[0].map(value =>
      String(value || "").trim()
    );

  if (
    currentHeaders[0] !== expectedHeaders[0] ||
    currentHeaders[1] !== expectedHeaders[1]
  ) {
    sheet
      .getRange(
        1,
        squareItemIdColumn,
        1,
        2
      )
      .setValues([
        expectedHeaders
      ]);
  }
}


// ==================================================
// Square Payment Link保存列を確認・確保
// AK (37列目) = square_payment_link_id
// AL (38列目) = square_checkout_url
// ==================================================

/**
 * Square Payment Link 保存列を確認・確保
 * AK (37列目) = square_payment_link_id
 * AL (38列目) = square_checkout_url
 * AM (39列目) = square_payment_link_generation
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet 商品マスターシート
 */
function ensureSquarePaymentLinkColumns_(sheet) {
  const squarePaymentLinkIdColumn = 37;
  const squareCheckoutUrlColumn = 38;
  const squarePaymentLinkGenColumn = 39;

  const requiredLastColumn = squarePaymentLinkGenColumn;

  const maxColumns = sheet.getMaxColumns();

  if (maxColumns < requiredLastColumn) {
    sheet.insertColumnsAfter(
      maxColumns,
      requiredLastColumn - maxColumns
    );
  }

  const lastRow = Math.max(sheet.getLastRow(), 1);

  const paymentLinkColumnsRange = sheet.getRange(
    1,
    squarePaymentLinkIdColumn,
    lastRow,
    3
  );

  const values = paymentLinkColumnsRange.getValues();
  const formulas = paymentLinkColumnsRange.getFormulas();

  const expectedHeaders = [
    "square_payment_link_id",
    "square_checkout_url",
    "square_payment_link_generation"
  ];

  expectedHeaders.forEach((expectedHeader, index) => {
    const colName = index === 0 ? "AK" : index === 1 ? "AL" : "AM";
    const header = String(values[0][index] || "").trim();

    if (header && header !== expectedHeader) {
      throw new Error(
        colName +
        " column is already in use: expected '" +
        expectedHeader +
        "', found '" +
        header +
        "'"
      );
    }

    if (!header) {
      const hasExistingData =
        values.slice(1).some(row => String(row[index] || "").trim() !== "") ||
        formulas.slice(1).some(row => String(row[index] || "").trim() !== "");

      if (hasExistingData) {
        throw new Error(
          colName + " column is already in use"
        );
      }
    }
  });

  const currentHeaders = values[0].map(value => String(value || "").trim());

  if (
    currentHeaders[0] !== expectedHeaders[0] ||
    currentHeaders[1] !== expectedHeaders[1] ||
    currentHeaders[2] !== expectedHeaders[2]
  ) {
    sheet
      .getRange(1, squarePaymentLinkIdColumn, 1, 3)
      .setValues([expectedHeaders]);
  }
}


// ==================================================
// Square Production Location ID 取得 helper
// ==================================================

/**
 * Square Production Location ID を取得
 * @return {string}
 */
function getSquareProdLocationId_(propService) {
  const props = propService || PropertiesService.getScriptProperties();
  const prodLocationId = String(
    props.getProperty("SQUARE_PROD_LOCATION_ID") || ""
  ).trim();

  if (!prodLocationId) {
    throw new Error(
      "SQUARE_PROD_LOCATION_ID is required for Square Production"
    );
  }

  return prodLocationId;
}


// ==================================================
// Square Production Payment Link (Checkout URL) 生成
// ==================================================

/**
 * Square Production Payment Link (Checkout URL) 生成
 *
 * 指定されたBIS商品の square_variation_id を使用して、
 * Square Checkout API (POST /v2/online-checkout/payment-links) で決済リンクを生成する。
 *
 * 安全仕様:
 * 1. square_variation_id が存在しない場合は処理を中断
 * 2. inventory_status === "sold" (および非 in_stock) の商品はリンク生成を禁止
 * 3. publish_status !== "published" (非公開) の商品はリンク生成を禁止
 * 4. record_status !== "active" (無効/アーカイブ) の商品はリンク生成を禁止
 * 5. 既に square_checkout_url が存在する場合は Square API を再度呼ばず既存URLを返却 (冪等性)
 * 6. Order には catalog_object_id = square_variation_id, quantity = "1" を指定
 * 7. checkout_options.ask_for_shipping_address = true を指定
 * 8. 生成失敗時に既存 Catalog Item / Variation / 在庫は一切変更・削除しない
 * 9. 成功時のみ square_payment_link_id (AK列: 37), square_checkout_url (AL列: 38) へ保存
 *
 * @param {string} productId BIS商品ID (例: "TMP-000028")
 * @return {{
 *   success: boolean,
 *   already_exists: boolean,
 *   environment: string,
 *   product_id: string,
 *   square_item_id: string,
 *   square_variation_id: string,
 *   square_payment_link_id: string,
 *   square_checkout_url: string,
 *   ask_for_shipping_address: boolean
 * }}
 */
function createSquareProductionPaymentLink(productId, options) {
  const normalizedProductId = String(productId || "").trim();

  function preconditionErr_(msg, code) {
    const err = new Error(msg);
    err.error_phase = "precondition";
    err.error_code = code || "PRECONDITION_FAILED";
    return err;
  }

  if (!normalizedProductId) {
    throw preconditionErr_("product_id is required", "PRODUCT_ID_REQUIRED");
  }

  let prodLocationId = (options && options.locationId) || (options && options.propService && options.propService.getProperty("SQUARE_PROD_LOCATION_ID"));
  if (!prodLocationId) {
    try {
      prodLocationId = getSquareProdLocationId_(options && options.propService);
    } catch (_) {
      prodLocationId = "";
    }
  }

  if (!prodLocationId) {
    throw preconditionErr_("SQUARE_PROD_LOCATION_ID is required for Square Production", "LOCATION_ID_REQUIRED");
  }

  const sheet = (options && options.sheet) || SpreadsheetApp
    .getActiveSpreadsheet()
    .getSheets()[0];

  const squareRequester = (options && options.squareRequest) || squareProdRequest_;

  const targetRow = findProductRow(sheet, normalizedProductId);

  // 1. カラムの確認・確保 (AI/AJ, AK/AL/AM)
  ensureSquareIdColumns(sheet);
  ensureSquarePaymentLinkColumns_(sheet);

  // 2. 対象行のデータを取得 (1〜39列)
  const row = sheet
    .getRange(targetRow, 1, 1, 39)
    .getValues()[0];

  // AIドラフト未確認・内容不一致時は決済リンク生成を拒否 (Fail-Closed)
  try {
    assertProductPublishable_(sheet, targetRow, normalizedProductId);
  } catch (gateErr) {
    gateErr.error_phase = "precondition";
    throw gateErr;
  }

  const publishStatus = String(row[31] || "draft").trim();
  const inventoryStatus = String(row[32] || "in_stock").trim();
  const recordStatus = String(row[33] || "active").trim();
  const squareItemId = String(row[34] || "").trim();
  const squareVariationId = String(row[35] || "").trim();
  const existingPaymentLinkId = String(row[36] || "").trim();
  const existingCheckoutUrl = String(row[37] || "").trim();
  const currentGen = Number(row[38] || 0) || 1;

  // ------------------------------------------
  // 事前バリデーション
  // ------------------------------------------

  // (1) square_variation_id の存在確認
  if (!squareVariationId) {
    throw preconditionErr_(
      "Square Variation ID (square_variation_id) is not registered for product: " +
      normalizedProductId,
      "SQUARE_VARIATION_ID_REQUIRED"
    );
  }

  // (2) 在庫ステータス確認 (soldは生成禁止)
  if (inventoryStatus === "sold") {
    throw preconditionErr_(
      "cannot create payment link for sold product: " + normalizedProductId,
      "PRODUCT_ALREADY_SOLD"
    );
  }
  if (inventoryStatus !== "in_stock") {
    throw preconditionErr_(
      "cannot create payment link for non-in_stock product: " +
      normalizedProductId +
      " (inventory_status: " + inventoryStatus + ")",
      "PRODUCT_NOT_IN_STOCK"
    );
  }

  // (3) 有効・公開ステータス確認 (非公開・無効商品は生成禁止)
  if (recordStatus !== "active") {
    throw preconditionErr_(
      "cannot create payment link for inactive product: " +
      normalizedProductId +
      " (record_status: " + recordStatus + ")"
    );
  }
  if (publishStatus !== "published") {
    throw preconditionErr_(
      "cannot create payment link for unpublished product: " +
      normalizedProductId +
      " (publish_status: " + publishStatus + ")"
    );
  }

  // (4) 既存Checkout URLの確認 (存在する場合はAPIを呼ばず既存URLを返却)
  if (existingCheckoutUrl) {
    console.log(
      "Square Production Payment Link already exists for product: " +
      normalizedProductId +
      " (url: " + existingCheckoutUrl + ", id: " + existingPaymentLinkId + ", gen: " + currentGen + ")"
    );
    return {
      success: true,
      already_exists: true,
      environment: "production",
      product_id: normalizedProductId,
      square_item_id: squareItemId,
      square_variation_id: squareVariationId,
      square_payment_link_id: existingPaymentLinkId,
      square_checkout_url: existingCheckoutUrl,
      square_payment_link_generation: currentGen,
      ask_for_shipping_address: true
    };
  }

  // ------------------------------------------
  // Square Checkout API リクエストペイロード構築
  // generation counter 連動型 idempotency key
  // 同一世代のリトライでは同一keyとなり、Link無効化後の次世代では別keyとなる
  // ------------------------------------------
  const idempotencyKey =
    "ais-sq-prod-plink-" +
    normalizedProductId +
    "-g" +
    currentGen;

  const payload = {
    idempotency_key: idempotencyKey,
    order: {
      location_id: prodLocationId,
      line_items: [
        {
          catalog_object_id: squareVariationId,
          quantity: "1"
        }
      ]
    },
    checkout_options: {
      ask_for_shipping_address: true
    }
  };

  // ------------------------------------------
  // API実行: POST /v2/online-checkout/payment-links
  // ------------------------------------------
  let response;
  try {
    response = squareRequester(
      "/v2/online-checkout/payment-links",
      {
        method: "post",
        payload: payload
      }
    );
  } catch (apiErr) {
    apiErr.error_phase = "square_api";
    const statusMatch = String(apiErr.message || "").match(/HTTP\s+(\d{3})/i);
    const httpStatus = statusMatch ? parseInt(statusMatch[1], 10) : null;
    if (httpStatus && httpStatus >= 400 && httpStatus < 500) {
      // 4xx: Square側でリクエストが明確に拒絶されたため、リンクは確実に未生成
      apiErr.square_link_definitive_not_created = true;
      apiErr.http_status = httpStatus;
    } else {
      // 5xx / ネットワークタイムアウト等: Square側で作成された可能性があるが未確認
      apiErr.square_link_definitive_not_created = false;
      apiErr.http_status = httpStatus;
    }
    throw apiErr;
  }

  let responseData;
  try {
    responseData = JSON.parse(response.body || "{}");
  } catch (_) {
    const parseErr = new Error(
      "Square Production Payment Link API returned invalid JSON for product: " +
      normalizedProductId
    );
    parseErr.error_phase = "square_api";
    parseErr.square_link_definitive_not_created = false;
    throw parseErr;
  }

  const paymentLink = responseData.payment_link || {};
  const paymentLinkId = String(paymentLink.id || "").trim();
  const checkoutUrl = String(paymentLink.url || "").trim();

  if (!paymentLinkId || !checkoutUrl) {
    const dataErr = new Error(
      "Square Production Payment Link response missing id or url for product: " +
      normalizedProductId
    );
    dataErr.error_phase = "square_api";
    dataErr.square_link_definitive_not_created = false;
    throw dataErr;
  }

  // ------------------------------------------
  // 成功時のみシートへ保存 (AK: 37, AL: 38, AM: 39)
  // ------------------------------------------
  try {
    sheet
      .getRange(targetRow, 37, 1, 3)
      .setValues([[
        paymentLinkId,
        checkoutUrl,
        currentGen
      ]]);
  } catch (sheetErr) {
    const saveErr = new Error(
      "Square payment link created successfully on Square (" + paymentLinkId +
      "), but failed to save to BIS sheet: " + sheetErr.message
    );
    saveErr.error_phase = "sheet_save";
    saveErr.error_code = "PAYMENT_LINK_SHEET_SAVE_FAILED";
    saveErr.square_payment_link_id = paymentLinkId;
    saveErr.square_checkout_url = checkoutUrl;
    saveErr.square_payment_link_generation = currentGen;
    saveErr.square_link_definitive_created = true;
    saveErr.cause = sheetErr;
    throw saveErr;
  }

  const summary = {
    success: true,
    already_exists: false,
    environment: "production",
    product_id: normalizedProductId,
    square_item_id: squareItemId,
    square_variation_id: squareVariationId,
    square_payment_link_id: paymentLinkId,
    square_checkout_url: checkoutUrl,
    square_payment_link_generation: currentGen,
    ask_for_shipping_address: true
  };

  console.log(JSON.stringify(summary));
  return summary;
}


// ==================================================
// Square Production Payment Link 情報取得 (READ ONLY)
// ==================================================

/**
 * Square Production Payment Link 情報取得 (READ ONLY)
 *
 * @param {string} productId BIS商品ID
 * @return {{
 *   success: boolean,
 *   product_id: string,
 *   square_item_id: string,
 *   square_variation_id: string,
 *   square_payment_link_id: string,
 *   square_checkout_url: string,
 *   publish_status: string,
 *   inventory_status: string,
 *   record_status: string
 * }}
 */
function getSquareProductionPaymentLink(productId) {
  const normalizedProductId = String(productId || "").trim();

  if (!normalizedProductId) {
    throw new Error("product_id is required");
  }

  const sheet = SpreadsheetApp
    .getActiveSpreadsheet()
    .getSheets()[0];

  const targetRow = findProductRow(sheet, normalizedProductId);
  ensureSquarePaymentLinkColumns_(sheet);

  const row = sheet
    .getRange(targetRow, 1, 1, 39)
    .getValues()[0];

  return {
    success: true,
    product_id: normalizedProductId,
    square_item_id: String(row[34] || "").trim(),
    square_variation_id: String(row[35] || "").trim(),
    square_payment_link_id: String(row[36] || "").trim(),
    square_checkout_url: String(row[37] || "").trim(),
    publish_status: String(row[31] || "draft").trim(),
    inventory_status: String(row[32] || "in_stock").trim(),
    record_status: String(row[33] || "active").trim()
  };
}


// ==================================================
// Square Production Payment Link 無効化 (DELETE & シートクリア)
// ==================================================

/**
 * Square Production Payment Link 無効化
 *
 * 指定されたBIS商品の square_payment_link_id (AK列: 37) が存在する場合、
 * Square Checkout API (DELETE /v2/online-checkout/payment-links/{id}) でリンクを無効化し、
 * 成功時のみ商品マスターの square_payment_link_id (AK列) および square_checkout_url (AL列) をクリアし、
 * 次世代 generation counter (AM列: 39) をインクリメントする。
 *
 * 安全仕様:
 * 1. square_payment_link_id が存在する場合のみ DELETE API を実行
 * 2. DELETE 成功 (200 または 404) 後のみ AK列・AL列をクリアし、AM列 generation を +1
 * 3. 既存の Catalog Item / Variation / 在庫は一切変更・削除しない
 *
 * @param {string} productId BIS商品ID
 * @param {Object} [options] オプション / モック
 * @return {{
 *   success: boolean,
 *   environment: string,
 *   product_id: string,
 *   invalidated: boolean,
 *   square_payment_link_id: string,
 *   square_payment_link_generation: number,
 *   message: string
 * }}
 */
function invalidateSquareProductionPaymentLink(productId, options) {
  const normalizedProductId = String(productId || "").trim();

  if (!normalizedProductId) {
    throw new Error("product_id is required");
  }

  const sheet = (options && options.sheet) || SpreadsheetApp
    .getActiveSpreadsheet()
    .getSheets()[0];

  const squareRequester = (options && options.squareRequest) || squareProdRequest_;

  const targetRow = findProductRow(sheet, normalizedProductId);
  ensureSquarePaymentLinkColumns_(sheet);

  const row = sheet
    .getRange(targetRow, 1, 1, 39)
    .getValues()[0];

  const paymentLinkId = String(row[36] || "").trim();
  const checkoutUrl = String(row[37] || "").trim();
  const currentGen = Number(row[38] || 0) || 1;

  // (1) IDなし / URLなし → invalidated: false で正常return
  if (!paymentLinkId && !checkoutUrl) {
    return {
      success: true,
      environment: "production",
      product_id: normalizedProductId,
      invalidated: false,
      already_missing: false,
      square_payment_link_id: "",
      square_checkout_url: "",
      square_payment_link_generation: currentGen,
      message: "No square_payment_link_id or square_checkout_url found to invalidate"
    };
  }

  // (2) IDなし / URLあり → データ不整合として例外をスロー（AK/ALは変更しない）
  if (!paymentLinkId && checkoutUrl) {
    throw new Error(
      "Data inconsistency for product " +
      normalizedProductId +
      ": square_checkout_url exists (" +
      checkoutUrl +
      ") but square_payment_link_id is empty. Link may remain active on Square; manual inspection required."
    );
  }

  // (3) IDあり → Square DELETE 実行
  const delRes = squareRequester(
    "/v2/online-checkout/payment-links/" + encodeURIComponent(paymentLinkId),
    {
      method: "delete",
      allowError: true
    }
  );

  const isAlreadyMissing = delRes.httpStatus === 404;

  if (delRes.httpStatus !== 200 && !isAlreadyMissing) {
    throw new Error(
      "Failed to delete Square Production Payment Link (" +
      paymentLinkId + "): HTTP " + delRes.httpStatus + ": " + delRes.body
    );
  }

  // 成功後のみ AK列 (37), AL列 (38) をクリアし、AM列 (39: generation) を次世代へインクリメント
  const nextGen = currentGen + 1;
  sheet
    .getRange(targetRow, 37, 1, 3)
    .setValues([["", "", nextGen]]);

  const summary = {
    success: true,
    environment: "production",
    product_id: normalizedProductId,
    invalidated: true,
    already_missing: isAlreadyMissing,
    http_status: delRes.httpStatus,
    square_payment_link_id: paymentLinkId,
    square_payment_link_generation: nextGen,
    message: isAlreadyMissing
      ? "Square Production Payment Link was already missing on Square (HTTP 404); cleared from sheet"
      : "Square Production Payment Link successfully invalidated and cleared from sheet"
  };

  if (isAlreadyMissing) {
    console.warn(
      "Square Production Payment Link was already missing on Square (HTTP 404) for product " +
      normalizedProductId +
      " (link_id: " + paymentLinkId + "). Sheet columns AK/AL cleared."
    );
  } else {
    console.log(
      "Square Production Payment Link successfully deleted (HTTP 200) for product " +
      normalizedProductId +
      " (link_id: " + paymentLinkId + "). Sheet columns AK/AL cleared."
    );
  }

  return summary;
}


// ==================================================
// Square Production 在庫・公開状態照合・検出・安全回収
// ==================================================

/**
 * Square Production 商品と BIS 本票の整合性照合・状態検出・安全回収
 *
 * 【背景・目的】
 * 公開処理中（Square在庫1化後、BIS本票published書き込み前）の中断や、
 * 決済リンク生成失敗、予期せぬ実行停止等の状態不整合を安全に検出し、
 * 照合結果と安全な回収（販売完了 or 販売停止）手順を提示・実行する。
 *
 * 照合内容:
 * 1. BIS本票の record_status, publish_status, inventory_status, square_variation_id, square_item_id
 * 2. Square実API: GET /v2/inventory/{variation_id} (実在庫数)
 * 3. Square実API: GET /v2/catalog/object/{item_id} (is_archived状態)
 *
 * 検出状態 (reconciliation_status):
 * - "CONSISTENT_PUBLISHED": BIS published + Square 在庫1 + is_archived: false (正常公開中)
 * - "CONSISTENT_DRAFT": BIS draft + Square 在庫0 (正常下書き・販売停止)
 * - "CONSISTENT_ARCHIVED": BIS archived + Square 在庫0 + is_archived: true (正常アーカイブ)
 * - "MISMATCH_SQUARE_IN_STOCK_BIS_DRAFT": Square在庫1だがBISはdraft (公開中断の検知)
 * - "MISMATCH_ARCHIVED_WITH_LIVE_SQUARE": BISアーカイブ済みだがSquare在庫>0またはカタログ有効
 * - "MISMATCH_BIS_PUBLISHED_SQUARE_OUT_OF_STOCK": BIS publishedだがSquare在庫0
 * - "POS_SALES_ENABLED_CHECKOUT_LINK_MISSING": Square在庫1・Catalog有効だが決済リンク未生成
 *
 * 回収モード (auto_reconcile):
 * - "complete_publish": BIS本票を published に更新して販売再開を安全に完了
 * - "stop_sales": Square在庫を 0 にロールバックして販売を安全に停止
 *
 * @param {string} productId BIS商品ID
 * @param {Object} [options] オプション / モック
 * @return {Object} 照合結果・回収サマリー
 */
function reconcileSquareProductionProductStatus(productId, options) {
  const normalizedProductId = String(productId || "").trim();
  if (!normalizedProductId) {
    throw new Error("product_id is required");
  }

  const sheet = (options && options.sheet) || SpreadsheetApp
    .getActiveSpreadsheet()
    .getSheets()[0];
  const squareRequester = (options && options.squareRequest) || squareProdRequest_;
  const targetRow = findProductRow(sheet, normalizedProductId);
  ensureSquareIdColumns(sheet);
  ensureSquarePaymentLinkColumns_(sheet);

  const row = sheet.getRange(targetRow, 1, 1, 39).getValues()[0];
  const publishStatus = String(row[31] || "draft").trim();
  const inventoryStatus = String(row[32] || "in_stock").trim();
  const recordStatus = String(row[33] || "active").trim();
  const squareItemId = String(row[34] || "").trim();
  const squareVariationId = String(row[35] || "").trim();
  const paymentLinkId = String(row[36] || "").trim();
  const checkoutUrl = String(row[37] || "").trim();

  let prodLocationId = (options && options.locationId) || (options && options.propService && options.propService.getProperty("SQUARE_PROD_LOCATION_ID"));
  if (!prodLocationId) {
    try {
      prodLocationId = getSquareProdLocationId_(options && options.propService);
    } catch (_) {
      prodLocationId = "";
    }
  }

  // Square Catalog Object RETRIEVE
  let squareItemArchived = null;
  let squareItemExists = false;
  let catalogFetchError = null;
  if (squareItemId) {
    try {
      const itemRes = squareRequester(
        "/v2/catalog/object/" + encodeURIComponent(squareItemId),
        { method: "get", allowError: true }
      );
      if (itemRes && itemRes.httpStatus === 200) {
        const itemBody = JSON.parse(itemRes.body || "{}");
        if (itemBody.object && itemBody.object.item_data) {
          squareItemExists = true;
          squareItemArchived = Boolean(itemBody.object.item_data.is_archived);
        } else {
          catalogFetchError = "Square catalog object payload missing item_data";
        }
      } else if (itemRes && itemRes.httpStatus === 404) {
        squareItemExists = false;
        squareItemArchived = null;
      } else {
        catalogFetchError = "Square catalog API HTTP " + (itemRes ? itemRes.httpStatus : "unknown");
      }
    } catch (catErr) {
      catalogFetchError = catErr.message || "Square catalog fetch exception";
    }
  }

  // Square Inventory RETRIEVE
  let squareInventoryQuantity = null;
  let inventoryFetchError = null;
  if (squareVariationId && prodLocationId) {
    try {
      const inv = getSquareProductionProductInventory_(squareVariationId, prodLocationId, options);
      if (inv && inv.quantity !== undefined && inv.quantity !== null) {
        squareInventoryQuantity = Number(inv.quantity);
      } else {
        inventoryFetchError = "Square inventory response missing quantity";
      }
    } catch (invErr) {
      inventoryFetchError = invErr.message || "Square inventory fetch exception";
    }
  } else if (!squareVariationId) {
    squareInventoryQuantity = 0;
  } else {
    inventoryFetchError = "Missing prodLocationId for inventory fetch";
  }

  let reconciliationStatus = "UNKNOWN";
  let anomalyDetected = false;
  let recommendedAction = "none";
  let description = "";

  if (catalogFetchError || inventoryFetchError) {
    reconciliationStatus = "UNKNOWN_EXTERNAL_ERROR";
    anomalyDetected = true;
    recommendedAction = "manual_inspection_required";
    description = "Square Catalog または 在庫の取得に失敗したため、外部状態が不明です（カタログエラー: " +
      (catalogFetchError || "none") + ", 在庫エラー: " + (inventoryFetchError || "none") +
      "）。フェイルクローズ原則に基づき、状態確定前の自動回収は禁止されます。";
  } else if (recordStatus === "archived") {
    if (squareInventoryQuantity === 0 && (squareItemArchived === true || !squareItemId)) {
      reconciliationStatus = "CONSISTENT_ARCHIVED";
      description = "BISアーカイブ済み、Square在庫0、Square Catalogアーカイブ済み（完全整合）";
    } else {
      reconciliationStatus = "MISMATCH_ARCHIVED_WITH_LIVE_SQUARE";
      anomalyDetected = true;
      recommendedAction = "stop_sales";
      description = "BISはアーカイブ済みですが、Square側に在庫または有効カタログが残存しています。";
    }
  } else if (publishStatus === "published") {
    if (squareInventoryQuantity > 0 && squareItemArchived === false) {
      if (!paymentLinkId || !checkoutUrl) {
        reconciliationStatus = "POS_SALES_ENABLED_CHECKOUT_LINK_MISSING";
        description = "Square Catalog解除済み・在庫1（店舗POS販売可能）。オンライン決済リンクのみ未生成です（販売停止中ではありません）。";
        recommendedAction = "create_square_payment_link";
      } else {
        reconciliationStatus = "CONSISTENT_PUBLISHED";
        description = "BIS公開中、Square在庫1、決済リンク生成済み（完全整合）";
      }
    } else {
      reconciliationStatus = "MISMATCH_BIS_PUBLISHED_SQUARE_OUT_OF_STOCK";
      anomalyDetected = true;
      recommendedAction = "complete_publish";
      description = "BISは公開中(published)ですが、Square在庫が0またはカタログ停止中です。";
    }
  } else {
    // publishStatus === "draft" または "hidden"
    if (squareInventoryQuantity > 0) {
      // ★ 最重要中断ケース: Square在庫1だがBISは下書き
      reconciliationStatus = "MISMATCH_SQUARE_IN_STOCK_BIS_DRAFT";
      anomalyDetected = true;
      recommendedAction = "complete_publish_or_stop_sales";
      description = "【公開中断検知】Square在庫が1（店頭POS販売可能）ですが、BIS本票は未公開(draft)です。公開処理中のGAS停止やネットワーク中断の可能性があります。販売を完了する場合は published を再送し、販売を停止する場合は在庫を0に戻してください。";
    } else {
      reconciliationStatus = "CONSISTENT_DRAFT";
      description = "BIS下書き、Square在庫0（正常停止状態）";
    }
  }

  const posSalesEnabled = (catalogFetchError || inventoryFetchError)
    ? "unknown"
    : Boolean(squareInventoryQuantity !== null && squareInventoryQuantity > 0 && squareItemArchived === false);

  const result = {
    success: true,
    product_id: normalizedProductId,
    reconciliation_status: reconciliationStatus,
    anomaly_detected: anomalyDetected,
    recommended_action: recommendedAction,
    description: description,
    bis_state: {
      record_status: recordStatus,
      publish_status: publishStatus,
      inventory_status: inventoryStatus,
      has_payment_link: Boolean(paymentLinkId && checkoutUrl)
    },
    square_state: {
      square_item_id: squareItemId,
      square_variation_id: squareVariationId,
      is_archived: squareItemArchived,
      inventory_quantity: squareInventoryQuantity,
      pos_sales_enabled: posSalesEnabled,
      catalog_fetch_error: catalogFetchError,
      inventory_fetch_error: inventoryFetchError
    }
  };

  // auto_reconcile の実行 (安全な回収)
  const autoReconcile = String((options && options.auto_reconcile) || "").trim();
  if (autoReconcile) {
    // 外部状態取得エラーがある場合は、フェイルクローズ原則により回収を禁止
    if (catalogFetchError || inventoryFetchError) {
      const recErr = new Error(
        "Auto-reconciliation is strictly prohibited when Square external state is unknown (catalog_error: " +
        (catalogFetchError || "none") + ", inventory_error: " + (inventoryFetchError || "none") + ")"
      );
      recErr.error_code = "RECONCILIATION_PROHIBITED_UNKNOWN_EXTERNAL_STATE";
      throw recErr;
    }

    if (autoReconcile === "complete_publish") {
      // 事前条件の厳格な検証 (Fail-Closed)
      if (recordStatus !== "active") {
        const actErr = new Error("cannot complete publish for non-active product (record_status: " + recordStatus + ")");
        actErr.error_code = "COMPLETE_PUBLISH_PRECONDITION_FAILED";
        throw actErr;
      }
      if (inventoryStatus !== "in_stock") {
        const invErr = new Error("cannot complete publish for non in-stock product (inventory_status: " + inventoryStatus + ")");
        invErr.error_code = "COMPLETE_PUBLISH_PRECONDITION_FAILED";
        throw invErr;
      }
      if (!squareVariationId) {
        const varErr = new Error("cannot complete publish without square_variation_id");
        varErr.error_code = "COMPLETE_PUBLISH_PRECONDITION_FAILED";
        throw varErr;
      }
      if (squareItemId && squareItemArchived === true) {
        const arcErr = new Error("cannot complete publish while Square catalog item is archived. Please unarchive Square product first.");
        arcErr.error_code = "COMPLETE_PUBLISH_PRECONDITION_FAILED";
        throw arcErr;
      }
      if (squareItemId && !squareItemExists) {
        const nfeErr = new Error("cannot complete publish: Square catalog item not found on Square");
        nfeErr.error_code = "COMPLETE_PUBLISH_PRECONDITION_FAILED";
        throw nfeErr;
      }

      // 公開ゲート（スニーカーサイズ検証等）
      assertProductPublishable_(sheet, targetRow, normalizedProductId);

      // Square 在庫 1 化（在庫が1未満の場合に同期）
      if (squareInventoryQuantity < 1) {
        syncSquareProductionProductInventory(normalizedProductId, 1, Object.assign({}, options, { allowingPublish: true }));
      }

      sheet.getRange(targetRow, 32).setValue("published");
      clearProductCache_(normalizedProductId);
      result.reconciliation_applied = "complete_publish";
      result.bis_state.publish_status = "published";
      result.square_state.inventory_quantity = 1;
      result.square_state.pos_sales_enabled = true;
    } else if (autoReconcile === "stop_sales") {
      // 1. EC公開の停止 (BIS本票の publish_status を draft へ変更)
      //    更新順の安全性設計:
      //    BISを先行して非公開(draft)化することで、以降のSquare側APIの成否にかかわらず、
      //    公開ページに販売可能商品として残存する状態を確実に防ぐ（フェイルクローズ原則）。
      if (publishStatus !== "draft") {
        sheet.getRange(targetRow, 32).setValue("draft");
      }

      // 2. Square 在庫 0 化 (店舗POS販売停止)
      if (squareVariationId) {
        syncSquareProductionProductInventory(normalizedProductId, 0, options);
      }

      // 3. オンライン決済リンクの無効化
      if (paymentLinkId || checkoutUrl) {
        invalidateSquareProductionPaymentLink(normalizedProductId, options);
      }

      // 4. BISがアーカイブ済みの場合は、Square Catalog も確実にアーカイブ
      if (recordStatus === "archived" && squareItemId && squareItemArchived === false) {
        archiveSquareProductionProduct(normalizedProductId, options);
      }

      // 5. キャッシュクリアと結果更新
      clearProductCache_(normalizedProductId);
      result.reconciliation_applied = "stop_sales";
      result.bis_state.publish_status = "draft";
      if (paymentLinkId || checkoutUrl) {
        result.bis_state.has_payment_link = false;
      }
      result.square_state.inventory_quantity = 0;
      result.square_state.pos_sales_enabled = false;
      if (recordStatus === "archived") {
        result.square_state.is_archived = true;
      }
    } else {
      const unsuppErr = new Error("unsupported auto_reconcile mode: " + autoReconcile);
      unsuppErr.error_code = "INVALID_AUTO_RECONCILE_MODE";
      throw unsuppErr;
    }
  }

  return result;
}


// ==================================================
// Square Production Payment Link 無効化 手動テスト
// ==================================================



// ==================================================
// Square Production Payment Link 生成 手動テスト
// ==================================================



// ==================================================
// Square Catalog Item ID 環境判定 (READ ONLY)
// ==================================================

/**
 * AI/AJに値がある未確定商品の square_item_id を
 * Production API と Sandbox API の両方で READ ONLY 照合し、環境を判定する。
 *
 * 判定基準:
 * - Production 200 -> Production ID
 * - Production 404 + Sandbox 200 -> Sandbox ID
 * - 両方404 -> 不整合/削除済み
 *
 * @param {string[]} [productIds] 対象商品ID配列（未指定時は未確定9商品）
 * @return {Array<Object>} 判定結果一覧
 */
function inspectUnconfirmedSquareItemIds(productIds) {
  const targetIds = Array.isArray(productIds) && productIds.length > 0
    ? productIds
    : [
        "TMP-000027",
        "TMP-000020",
        "TMP-000019",
        "TMP-000014",
        "TMP-000013",
        "TMP-000012",
        "TMP-000011",
        "TMP-000008",
        "TMP-000007"
      ];

  const sheet = SpreadsheetApp
    .getActiveSpreadsheet()
    .getSheets()[0];

  const squareConfig = getSquareConfig();
  const scriptProperties = PropertiesService.getScriptProperties();
  const prodAccessToken = String(
    scriptProperties.getProperty("SQUARE_PROD_ACCESS_TOKEN") || ""
  ).trim();
  const apiVersion = String(
    scriptProperties.getProperty("SQUARE_API_VERSION") || ""
  ).trim();

  const results = [];

  for (let i = 0; i < targetIds.length; i++) {
    const pid = String(targetIds[i] || "").trim();
    let targetRow;
    try {
      targetRow = findProductRow(sheet, pid);
    } catch (e) {
      results.push({
        product_id: pid,
        square_item_id: "",
        square_variation_id: "",
        production_status: null,
        sandbox_status: null,
        verdict: "商品が見つかりません"
      });
      continue;
    }

    const row = sheet.getRange(targetRow, 1, 1, 38).getValues()[0];
    const squareItemId = String(row[34] || "").trim();
    const squareVariationId = String(row[35] || "").trim();

    if (!squareItemId) {
      results.push({
        product_id: pid,
        square_item_id: "",
        square_variation_id: squareVariationId,
        production_status: null,
        sandbox_status: null,
        verdict: "ID未設定 (空)"
      });
      continue;
    }

    // 1. Production API READ ONLY (GET /v2/catalog/object/{id})
    let prodStatus = 0;
    try {
      const prodRes = squareProdRequest_(
        "/v2/catalog/object/" + encodeURIComponent(squareItemId),
        { method: "get", allowError: true }
      );
      prodStatus = prodRes.httpStatus;
    } catch (prodErr) {
      console.warn("Production check error for " + pid + ":", prodErr);
      prodStatus = -1;
    }

    // 2. Sandbox API READ ONLY (GET /v2/catalog/object/{id})
    let sandboxStatus = 0;
    try {
      const sbFetchRes = UrlFetchApp.fetch(
        "https://connect.squareupsandbox.com/v2/catalog/object/" + encodeURIComponent(squareItemId),
        {
          method: "get",
          headers: {
            Authorization: "Bearer " + squareConfig.accessToken,
            "Square-Version": apiVersion || squareConfig.apiVersion,
            "Content-Type": "application/json"
          },
          muteHttpExceptions: true
        }
      );
      sandboxStatus = sbFetchRes.getResponseCode();
    } catch (sbErr) {
      console.warn("Sandbox check error for " + pid + ":", sbErr);
      sandboxStatus = -1;
    }

    // 3. 判定ロジック
    let verdict = "";
    if (prodStatus === 200) {
      verdict = "Production ID";
    } else if (prodStatus === 404 && sandboxStatus === 200) {
      verdict = "Sandbox ID";
    } else if (prodStatus === 404 && sandboxStatus === 404) {
      verdict = "不整合/削除済み";
    } else {
      verdict = "要確認 (Prod: " + prodStatus + ", Sandbox: " + sandboxStatus + ")";
    }

    const itemResult = {
      product_id: pid,
      square_item_id: squareItemId,
      square_variation_id: squareVariationId,
      production_status: prodStatus,
      sandbox_status: sandboxStatus,
      verdict: verdict
    };

    results.push(itemResult);
  }

  console.log("=== inspectUnconfirmedSquareItemIds 判定結果 ===");
  console.log(JSON.stringify(results, null, 2));

  return results;
}



// ==================================================
// 過去の Square Sandbox ID クリア (AI列・AJ列)
// ==================================================

/**
 * Sandbox IDが確定した8商品のAI列 (square_item_id) / AJ列 (square_variation_id) を安全にクリアする。
 *
 * 安全保護仕様:
 * 1. 対象は確定した8商品のみ (TMP-000020, TMP-000019, TMP-000014, TMP-000013, TMP-000012, TMP-000011, TMP-000008, TMP-000007)
 * 2. TMP-000027 および TMP-000028 (Production ID) は絶対に変更禁止 (ガードチェック)
 * 3. 変更対象は AI列 (35列目) および AJ列 (36列目) の2列のみ。AK列 (37), AL列 (38) 等の他列は一切変更しない。
 * 4. 実行前に全対象商品の現在の値をログ出力
 * 5. クリア後に全商品を再読み込みし、8件のクリア、TMP-000027/28の未変更、AK/ALの未変更を検証
 *
 * @return {Object} クリア結果サマリー
 */
function cleanupSquareSandboxIdsFromSheet() {
  const targetProductIds = [
    "TMP-000020",
    "TMP-000019",
    "TMP-000014",
    "TMP-000013",
    "TMP-000012",
    "TMP-000011",
    "TMP-000008",
    "TMP-000007"
  ];

  const protectedProductIds = [
    "TMP-000027",
    "TMP-000028"
  ];

  const sheet = SpreadsheetApp
    .getActiveSpreadsheet()
    .getSheets()[0];

  console.log("=== 1. 処理前ステータス確認 (Pre-check) ===");

  // 1. 保護対象商品の事前状態を記録
  const protectedPreState = {};
  for (let i = 0; i < protectedProductIds.length; i++) {
    const pid = protectedProductIds[i];
    const rowIdx = findProductRow(sheet, pid);
    const row = sheet.getRange(rowIdx, 1, 1, 38).getValues()[0];
    protectedPreState[pid] = {
      product_id: pid,
      row_index: rowIdx,
      square_item_id: String(row[34] || "").trim(),
      square_variation_id: String(row[35] || "").trim(),
      square_payment_link_id: String(row[36] || "").trim(),
      square_checkout_url: String(row[37] || "").trim()
    };
    console.log("[PROTECTED PRE-CHECK] " + pid + ": item_id=" + protectedPreState[pid].square_item_id + ", var_id=" + protectedPreState[pid].square_variation_id + ", link_id=" + protectedPreState[pid].square_payment_link_id + ", checkout_url=" + protectedPreState[pid].square_checkout_url);
  }

  // 2. クリア対象8商品の事前状態を記録 & ログ出力
  const targetsPreState = [];
  for (let i = 0; i < targetProductIds.length; i++) {
    const pid = targetProductIds[i];
    if (protectedProductIds.indexOf(pid) !== -1) {
      throw new Error("FATAL: Protected product ID included in targets: " + pid);
    }
    const rowIdx = findProductRow(sheet, pid);
    const row = sheet.getRange(rowIdx, 1, 1, 38).getValues()[0];
    const preInfo = {
      product_id: pid,
      row_index: rowIdx,
      square_item_id: String(row[34] || "").trim(),
      square_variation_id: String(row[35] || "").trim(),
      square_payment_link_id: String(row[36] || "").trim(),
      square_checkout_url: String(row[37] || "").trim()
    };
    targetsPreState.push(preInfo);
    console.log("[TARGET PRE-CHECK] " + pid + " (row " + rowIdx + "): item_id=" + preInfo.square_item_id + ", var_id=" + preInfo.square_variation_id);
  }

  console.log("=== 2. AI列(35)・AJ列(36) クリア実行 ===");

  // 3. 対象8件のAI列(35)・AJ列(36)のみクリア
  for (let i = 0; i < targetsPreState.length; i++) {
    const target = targetsPreState[i];
    // 35列目から2列分 (AI: 35, AJ: 36) のみを空文字で上書き
    sheet.getRange(target.row_index, 35, 1, 2).setValues([["", ""]]);
    console.log("[CLEARED] " + target.product_id + " (row " + target.row_index + ") columns AI/AJ cleared.");
  }

  // スプレッドシートの変更をフラッシュ
  SpreadsheetApp.flush();

  console.log("=== 3. 処理後ステータス検証 (Post-check) ===");

  let errors = [];

  // 4. クリア対象8件の再読み込み検証
  const clearedResults = [];
  for (let i = 0; i < targetsPreState.length; i++) {
    const target = targetsPreState[i];
    const postRow = sheet.getRange(target.row_index, 1, 1, 38).getValues()[0];
    const postItemId = String(postRow[34] || "").trim();
    const postVarId = String(postRow[35] || "").trim();
    const postPaymentLinkId = String(postRow[36] || "").trim();
    const postCheckoutUrl = String(postRow[37] || "").trim();

    const isCleared = (postItemId === "" && postVarId === "");
    const akAlUnchanged = (postPaymentLinkId === target.square_payment_link_id && postCheckoutUrl === target.square_checkout_url);

    if (!isCleared) {
      errors.push("Product " + target.product_id + " AI/AJ was not cleared! item_id=" + postItemId + ", var_id=" + postVarId);
    }
    if (!akAlUnchanged) {
      errors.push("Product " + target.product_id + " AK/AL was unexpectedly modified!");
    }

    clearedResults.push({
      product_id: target.product_id,
      cleared: isCleared,
      square_item_id: postItemId,
      square_variation_id: postVarId,
      ak_al_unchanged: akAlUnchanged
    });
  }

  // 5. 保護対象2件 (TMP-000027, TMP-000028) の再読み込み検証
  const protectedResults = [];
  for (let i = 0; i < protectedProductIds.length; i++) {
    const pid = protectedProductIds[i];
    const pre = protectedPreState[pid];
    const postRow = sheet.getRange(pre.row_index, 1, 1, 38).getValues()[0];
    const postItemId = String(postRow[34] || "").trim();
    const postVarId = String(postRow[35] || "").trim();
    const postPaymentLinkId = String(postRow[36] || "").trim();
    const postCheckoutUrl = String(postRow[37] || "").trim();

    const aiAjUnchanged = (postItemId === pre.square_item_id && postVarId === pre.square_variation_id);
    const akAlUnchanged = (postPaymentLinkId === pre.square_payment_link_id && postCheckoutUrl === pre.square_checkout_url);

    if (!aiAjUnchanged) {
      errors.push("CRITICAL: Protected product " + pid + " AI/AJ was modified! expected=" + pre.square_item_id + "/" + pre.square_variation_id + ", got=" + postItemId + "/" + postVarId);
    }
    if (!akAlUnchanged) {
      errors.push("CRITICAL: Protected product " + pid + " AK/AL was modified!");
    }

    protectedResults.push({
      product_id: pid,
      ai_aj_unchanged: aiAjUnchanged,
      ak_al_unchanged: akAlUnchanged,
      square_item_id: postItemId,
      square_variation_id: postVarId,
      square_payment_link_id: postPaymentLinkId,
      square_checkout_url: postCheckoutUrl
    });
  }

  const summary = {
    success: errors.length === 0,
    cleared_count: clearedResults.filter(r => r.cleared).length,
    total_targets: targetProductIds.length,
    cleared_results: clearedResults,
    protected_results: protectedResults,
    errors: errors
  };

  console.log("=== 4. 最終実行サマリー ===");
  console.log(JSON.stringify(summary, null, 2));

  return summary;
}


// ==================================================
// AIS商品をSquare Sandboxへ新規登録
// ==================================================



// ==================================================
// Square Sandbox CREATE 手動テスト
// SQUARE_TEST_PRODUCT_ID を事前設定して実行
// ==================================================



// ==================================================
// Square Catalog Item取得
// ==================================================



// ==================================================
// Square Item内のVariation取得
// ==================================================



// ==================================================
// 取得したCatalogObjectをUpsert用に整形
// ==================================================



// ==================================================
// AIS商品情報でSquare Sandbox商品を更新
// ==================================================



// ==================================================
// Square Sandbox UPDATE 手動テスト
// SQUARE_TEST_PRODUCT_ID を使用
// ==================================================



// ==================================================
// Square API 画像アップロード専用HTTPリクエスト
// multipart/form-data: request (JSON) + file (Blob)
// ==================================================



// ==================================================
// AISのメイン画像1枚をSquare Sandboxの商品へ同期
// ==================================================



// ==================================================
// Square Sandbox メイン画像同期 手動テスト
// SQUARE_TEST_PRODUCT_ID を使用
// ==================================================



// ==================================================
// Square Inventory READ helper
// GET /v2/inventory/{squareVariationId}?location_ids={SQUARE_LOCATION_ID}
// ==================================================

function getSquareProductInventory(squareVariationId) {
  const normalizedSquareVariationId =
    String(squareVariationId || "").trim();

  if (!normalizedSquareVariationId) {
    throw new Error("square_variation_id is required");
  }

  const squareConfig = getSquareConfig();

  const response = squareRequest(
    "/v2/inventory/" +
    encodeURIComponent(normalizedSquareVariationId) +
    "?location_ids=" +
    encodeURIComponent(squareConfig.locationId),
    {
      method: "get"
    }
  );

  let inventoryResponse;

  try {
    inventoryResponse = JSON.parse(
      response.body || "{}"
    );
  } catch (_) {
    throw new Error(
      "Square Inventory API returned invalid JSON"
    );
  }

  const counts =
    Array.isArray(inventoryResponse.counts)
      ? inventoryResponse.counts
      : [];

  const matchedCount = counts.find(count =>
    count &&
    String(count.catalog_object_id || "").trim() ===
      normalizedSquareVariationId &&
    String(count.location_id || "").trim() ===
      squareConfig.locationId &&
    String(count.state || "").trim() ===
      "IN_STOCK"
  );

  return {
    square_variation_id: normalizedSquareVariationId,
    location_id: squareConfig.locationId,
    quantity:
      matchedCount &&
      Object.prototype.hasOwnProperty.call(matchedCount, "quantity") &&
      matchedCount.quantity !== null &&
      matchedCount.quantity !== undefined
        ? String(matchedCount.quantity)
        : "0",
    calculated_at:
      matchedCount && matchedCount.calculated_at
        ? String(matchedCount.calculated_at)
        : ""
  };
}


// ==================================================
// AISの商品在庫状態をSquare Sandbox Inventoryへ同期
// ==================================================

function syncSquareProductInventory(productId) {
  const normalizedProductId =
    String(productId || "").trim();

  if (!normalizedProductId) {
    throw new Error("product_id is required");
  }

  const squareConfig =
    getSquareConfig();

  if (squareConfig.environment !== "sandbox") {
    throw new Error(
      "Square inventory sync is limited to sandbox"
    );
  }

  const sheet = SpreadsheetApp
    .getActiveSpreadsheet()
    .getSheets()[0];

  const targetRow =
    findProductRow(
      sheet,
      normalizedProductId
    );

  const row =
    sheet
      .getRange(
        targetRow,
        1,
        1,
        36
      )
      .getValues()[0];

  const inventoryStatus =
    String(row[32] || "").trim();

  const recordStatus =
    String(row[33] || "").trim();

  const squareItemId =
    String(row[34] || "").trim();

  const squareVariationId =
    String(row[35] || "").trim();

  // ------------------------------------------
  // 1. Squareリンク整合性確認
  // ------------------------------------------

  if (
    !squareItemId &&
    !squareVariationId
  ) {
    throw new Error(
      "product is not linked to Square"
    );
  }

  if (!squareItemId) {
    throw new Error(
      "Square Item link is missing"
    );
  }

  if (!squareVariationId) {
    throw new Error(
      "Square Variation link is missing"
    );
  }

  // ------------------------------------------
  // 2. 在庫数量ルール判定
  // ------------------------------------------

  let targetQuantity = null;

  if (recordStatus === "archived") {
    targetQuantity = "0";
  } else if (recordStatus === "active") {
    if (inventoryStatus === "in_stock") {
      targetQuantity = "1";
    } else if (
      inventoryStatus === "reserved" ||
      inventoryStatus === "sold"
    ) {
      targetQuantity = "0";
    } else {
      throw new Error(
        "invalid inventory_status for active product: " +
        inventoryStatus
      );
    }
  } else {
    throw new Error(
      "invalid record_status: " +
      recordStatus
    );
  }

  // ------------------------------------------
  // 3. Square Item / Variation 取得と属格確認
  // ------------------------------------------

  const currentItem =
    getSquareCatalogItem(squareItemId);

  const currentVariation =
    findSquareItemVariation(
      currentItem,
      squareVariationId
    );

  if (!currentVariation) {
    throw new Error(
      "linked Square Variation was not found in Square Item"
    );
  }

  if (
    !currentVariation.item_variation_data ||
    String(
      currentVariation
        .item_variation_data
        .item_id || ""
    ).trim() !== squareItemId
  ) {
    throw new Error(
      "Square Variation does not belong to linked Item"
    );
  }

  // ------------------------------------------
  // 4. effectiveTrackInventory 判定
  // ------------------------------------------

  const variationData =
    currentVariation.item_variation_data || {};

  let effectiveTrackInventory = null;

  if (Array.isArray(variationData.location_overrides)) {
    const locationOverride =
      variationData.location_overrides.find(override =>
        override &&
        String(override.location_id || "").trim() ===
          squareConfig.locationId
      );

    if (
      locationOverride &&
      typeof locationOverride.track_inventory === "boolean"
    ) {
      effectiveTrackInventory =
        locationOverride.track_inventory;
    }
  }

  if (effectiveTrackInventory === null) {
    if (typeof variationData.track_inventory === "boolean") {
      effectiveTrackInventory =
        variationData.track_inventory;
    } else {
      effectiveTrackInventory = false;
    }
  }

  if (effectiveTrackInventory !== true) {
    throw new Error(
      "Square inventory tracking is disabled for this variation"
    );
  }

  // ------------------------------------------
  // 5. 現在Square在庫READ (WRITE前)
  // ------------------------------------------

  const previousInventory =
    getSquareProductInventory(squareVariationId);

  // ------------------------------------------
  // 6. PHYSICAL_COUNT WRITE 実行
  // ------------------------------------------

  const idempotencyKey =
    "ais-square-inv-" +
    Utilities.getUuid();

  const payload = {
    idempotency_key: idempotencyKey,
    changes: [
      {
        type: "PHYSICAL_COUNT",
        physical_count: {
          reference_id: normalizedProductId,
          catalog_object_id: squareVariationId,
          location_id: squareConfig.locationId,
          state: "IN_STOCK",
          quantity: targetQuantity,
          occurred_at: new Date().toISOString()
        }
      }
    ]
  };

  const writeResponse = squareRequest(
    "/v2/inventory/changes/batch-create",
    {
      method: "post",
      payload: payload
    }
  );

  let batchResponse;

  try {
    batchResponse = JSON.parse(
      writeResponse.body || "{}"
    );
  } catch (_) {
    throw new Error(
      "Square BatchChangeInventory returned invalid JSON"
    );
  }

  if (
    Array.isArray(batchResponse.errors) &&
    batchResponse.errors.length > 0
  ) {
    const errorMessages =
      batchResponse.errors
        .map(err =>
          String(err.detail || err.code || "")
        )
        .filter(Boolean)
        .join("; ");

    throw new Error(
      "Square BatchChangeInventory failed: " +
      (errorMessages || "unknown error")
    );
  }

  // ------------------------------------------
  // 7. Square在庫再READと一致確認 (WRITE後)
  // ------------------------------------------

  const verifiedInventory =
    getSquareProductInventory(squareVariationId);

  const verifiedQuantityNum =
    Number(verifiedInventory.quantity);

  const targetQuantityNum =
    Number(targetQuantity);

  if (
    Number.isNaN(verifiedQuantityNum) ||
    Number.isNaN(targetQuantityNum) ||
    verifiedQuantityNum !== targetQuantityNum
  ) {
    throw new Error(
      "synced Square inventory quantity does not match target: expected " +
      targetQuantity +
      ", got " +
      verifiedInventory.quantity
    );
  }

  // ------------------------------------------
  // 8. 成功レスポンス
  // ------------------------------------------

  return {
    success: true,
    product_id: normalizedProductId,
    inventory_status: inventoryStatus,
    record_status: recordStatus,
    target_quantity: targetQuantity,
    previous_square_quantity:
      previousInventory.quantity,
    square_quantity:
      verifiedInventory.quantity,
    square_item_id: squareItemId,
    square_variation_id: squareVariationId,
    location_id: squareConfig.locationId
  };
}


// ==================================================
// Square Sandbox 在庫同期 手動テスト
// SQUARE_TEST_PRODUCT_ID を使用
// ==================================================



// ==================================================
// Square Sandbox 在庫追跡設定 調査用手動テスト (READ ONLY)
// SQUARE_TEST_PRODUCT_ID を使用
// ==================================================



// ==================================================
// Square Order READ helper
// GET /v2/orders/{order_id}
// ==================================================

function getSquareOrder(orderId) {
  const normalizedOrderId =
    String(orderId || "").trim();

  if (!normalizedOrderId) {
    throw new Error("order_id is required");
  }

  const response = squareRequest(
    "/v2/orders/" +
    encodeURIComponent(normalizedOrderId),
    {
      method: "get"
    }
  );

  let orderResponse;

  try {
    orderResponse = JSON.parse(
      response.body || "{}"
    );
  } catch (_) {
    throw new Error(
      "Square Orders API returned invalid JSON"
    );
  }

  if (!orderResponse || !orderResponse.order) {
    throw new Error(
      "Square Order was not returned"
    );
  }

  return orderResponse.order;
}


// ==================================================
// Square Variation ID から BIS商品行を逆引き
// AJ列 (36列目)
// ==================================================

function findProductRowBySquareVariationId(
  sheet,
  squareVariationId
) {
  const normalizedVariationId =
    String(squareVariationId || "").trim();

  if (!normalizedVariationId) {
    return -1;
  }

  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    return -1;
  }

  // AJ列 = 36列目をヘッダー除外で一括取得
  const variationValues = sheet
    .getRange(2, 36, lastRow - 1, 1)
    .getValues();

  let matchedRow = -1;

  for (let i = 0; i < variationValues.length; i++) {
    const cellValue =
      String(variationValues[i][0] || "").trim();

    if (cellValue === normalizedVariationId) {
      if (matchedRow !== -1) {
        throw new Error(
          "duplicate Square Variation link in BIS: " +
          normalizedVariationId
        );
      }
      matchedRow = i + 2;
    }
  }

  return matchedRow;
}


// ==================================================
// Square Sandbox 販売Orderを処理しBIS在庫をsoldへ更新
// ==================================================

function processSquareSaleOrder(orderId) {
  const normalizedOrderId =
    String(orderId || "").trim();

  if (!normalizedOrderId) {
    throw new Error("order_id is required");
  }

  const squareConfig = getSquareConfig();

  if (squareConfig.environment !== "sandbox") {
    throw new Error(
      "Square sale order processing is limited to sandbox"
    );
  }

  const order =
    getSquareOrder(normalizedOrderId);

  const orderLocationId =
    String(order.location_id || "").trim();

  if (!orderLocationId) {
    throw new Error(
      "Square Order location_id was not returned"
    );
  }

  if (orderLocationId !== squareConfig.locationId) {
    throw new Error(
      "Square Order location does not match configured location"
    );
  }

  const lineItems =
    Array.isArray(order.line_items)
      ? order.line_items
      : [];

  const sheet = SpreadsheetApp
    .getActiveSpreadsheet()
    .getSheets()[0];

  // ------------------------------------------
  // Phase 1: 全line_itemsの事前検証・計画構築
  // ------------------------------------------

  const executionPlans = [];
  const plannedBisVariationIds = new Set();

  for (let i = 0; i < lineItems.length; i++) {
    const lineItem = lineItems[i];
    const catalogObjectId =
      String(lineItem && lineItem.catalog_object_id || "").trim();
    const quantity =
      String(lineItem && lineItem.quantity || "").trim();

    // 1. Catalog未紐づけ（ad hoc / カスタム金額など）
    if (!catalogObjectId) {
      executionPlans.push({
        status: "skipped_no_catalog_object",
        catalog_object_id: "",
        quantity: quantity,
        product_id: "",
        target_row: -1
      });
      continue;
    }

    // 2. BIS AJ列で逆引き
    const targetRow =
      findProductRowBySquareVariationId(
        sheet,
        catalogObjectId
      );

    // 3. BIS未管理Square商品
    if (targetRow === -1) {
      executionPlans.push({
        status: "skipped_unmanaged_variation",
        catalog_object_id: catalogObjectId,
        quantity: quantity,
        product_id: "",
        target_row: -1
      });
      continue;
    }

    // 4. 同一BIS商品の重複line itemチェック（一点物モデルのため複数回出現はエラー停止）
    if (plannedBisVariationIds.has(catalogObjectId)) {
      throw new Error(
        "duplicate BIS product line item in Square Order: " +
        catalogObjectId
      );
    }
    plannedBisVariationIds.add(catalogObjectId);

    // 5. quantity検証（BIS商品は1点物モデルのため quantity === "1" 必須）
    if (quantity !== "1") {
      throw new Error(
        "unexpected Square line item quantity for BIS product: " +
        quantity +
        " (variation: " +
        catalogObjectId +
        ")"
      );
    }

    // 6. BIS商品データ取得
    const row = sheet
      .getRange(targetRow, 1, 1, 36)
      .getValues()[0];

    const productId =
      String(row[1] || "").trim();

    const inventoryStatus =
      String(row[32] || "").trim();

    const recordStatus =
      String(row[33] || "").trim();

    // 7. record_status検証
    if (recordStatus === "archived") {
      throw new Error(
        "archived BIS product was sold in Square: " +
        productId +
        " (variation: " +
        catalogObjectId +
        ")"
      );
    }

    if (recordStatus !== "active") {
      throw new Error(
        "invalid record_status for sold BIS product: " +
        recordStatus +
        " (" +
        productId +
        ")"
      );
    }

    // 7. inventory_status判定
    if (inventoryStatus === "sold") {
      executionPlans.push({
        status: "already_sold",
        catalog_object_id: catalogObjectId,
        quantity: quantity,
        product_id: productId,
        target_row: targetRow
      });
    } else if (
      inventoryStatus === "in_stock" ||
      inventoryStatus === "reserved"
    ) {
      executionPlans.push({
        status: "sold",
        catalog_object_id: catalogObjectId,
        quantity: quantity,
        product_id: productId,
        target_row: targetRow
      });
    } else {
      throw new Error(
        "invalid inventory_status for BIS product: " +
        inventoryStatus +
        " (" +
        productId +
        ")"
      );
    }
  }

  // ------------------------------------------
  // Phase 2: 対象BIS行のsold更新
  // Phase 1で全件検証が通った場合のみ実行
  // ------------------------------------------

  let soldProductCount = 0;
  let alreadySoldCount = 0;
  let skippedCount = 0;

  const processedRows = new Set();

  for (let i = 0; i < executionPlans.length; i++) {
    const plan = executionPlans[i];

    if (plan.status === "sold") {
      if (!processedRows.has(plan.target_row)) {
        updateProductInventoryStatusOnSheet(
          sheet,
          plan.target_row,
          "sold"
        );
        processedRows.add(plan.target_row);
      }
      soldProductCount++;
    } else if (plan.status === "already_sold") {
      alreadySoldCount++;
    } else {
      skippedCount++;
    }
  }

  return {
    success: true,
    order_id: normalizedOrderId,
    order_state: String(order.state || ""),
    line_item_count: lineItems.length,
    sold_product_count: soldProductCount,
    already_sold_count: alreadySoldCount,
    skipped_count: skippedCount,
    results: executionPlans.map(plan => ({
      catalog_object_id: plan.catalog_object_id,
      quantity: plan.quantity,
      status: plan.status,
      product_id: plan.product_id
    }))
  };
}


// ==================================================
// Square Sandbox 販売Order処理 手動テスト
// SQUARE_TEST_ORDER_ID を使用
// ==================================================



// ==================================================
// square_webhook_events 専用Sheet取得・作成 helper
// ==================================================

function getOrCreateSquareWebhookEventsSheet() {
  const spreadsheet =
    SpreadsheetApp.getActiveSpreadsheet();

  const sheetName = "square_webhook_events";

  const expectedHeaders = [
    "processed_at",
    "event_id",
    "event_type",
    "payment_id",
    "order_id",
    "status",
    "detail"
  ];

  let sheet =
    spreadsheet.getSheetByName(sheetName);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(sheetName);

    sheet.getRange(1, 1, 1, expectedHeaders.length).setValues([expectedHeaders]);
    return sheet;
  }

  // 既に存在する場合、ヘッダーを厳密完全一致検証
  const lastColumn = sheet.getLastColumn();

  if (lastColumn !== expectedHeaders.length) {
    throw new Error(
      "square_webhook_events sheet has unexpected headers"
    );
  }

  const actualHeaders = sheet
    .getRange(1, 1, 1, expectedHeaders.length)
    .getValues()[0];

  for (let i = 0; i < expectedHeaders.length; i++) {
    if (String(actualHeaders[i] || "").trim() !== expectedHeaders[i]) {
      throw new Error(
        "square_webhook_events sheet has unexpected headers"
      );
    }
  }

  return sheet;
}


// ==================================================
// square_webhook_events で event_id が既に processed か確認
// status === "processed" のみ重複と判定（failedは再試行可能）
// ==================================================

function isSquareWebhookEventProcessed(eventsSheet, eventId) {
  const normalizedEventId = String(eventId || "").trim();

  if (!normalizedEventId) {
    return false;
  }

  const lastRow = eventsSheet.getLastRow();

  if (lastRow < 2) {
    return false;
  }

  // B列(2列目: event_id) と F列(6列目: status) を確認
  // ヘッダー除外で一括取得
  const rows = eventsSheet
    .getRange(2, 1, lastRow - 1, 6)
    .getValues();

  for (let i = 0; i < rows.length; i++) {
    const rowEventId = String(rows[i][1] || "").trim();
    const rowStatus = String(rows[i][5] || "").trim();

    if (rowEventId === normalizedEventId && rowStatus === "processed") {
      return true;
    }
  }

  return false;
}


// ==================================================
// Square Webhook Relay 受信ハンドラー
// POST /exec/square-webhook
// ==================================================

function handleSquareWebhookRelay(e) {
  let lock = null;

  try {
    let data;

    try {
      data = JSON.parse(
        e && e.postData && e.postData.contents || "{}"
      );
    } catch (_) {
      return jsonResponse({
        success: false,
        version: "square-webhook-relay-v1",
        error: "invalid JSON body"
      });
    }

    // 1. Script Propertyから共有シークレットを取得
    const expectedSecret = String(
      PropertiesService
        .getScriptProperties()
        .getProperty("SQUARE_WEBHOOK_RELAY_SECRET") || ""
    ).trim();

    if (!expectedSecret) {
      throw new Error("SQUARE_WEBHOOK_RELAY_SECRET is required");
    }

    // 2. shared secret 検証
    const receivedSecret = String(data.relay_secret || "").trim();

    if (!receivedSecret || receivedSecret !== expectedSecret) {
      return jsonResponse({
        success: false,
        version: "square-webhook-relay-v1",
        error: "unauthorized relay"
      });
    }

    // 3. version 検証
    const version = String(data.version || "").trim();

    if (version !== "square-webhook-relay-v1") {
      return jsonResponse({
        success: false,
        version: "square-webhook-relay-v1",
        error: "unsupported square webhook relay version: " + version
      });
    }

    // 4. 必須項目検証
    const eventId = String(data.event_id || "").trim();
    const paymentId = String(data.payment_id || "").trim();
    const orderId = String(data.order_id || "").trim();

    if (!eventId) {
      return jsonResponse({
        success: false,
        version: "square-webhook-relay-v1",
        error: "event_id is required"
      });
    }

    if (!paymentId) {
      return jsonResponse({
        success: false,
        version: "square-webhook-relay-v1",
        error: "payment_id is required"
      });
    }

    if (!orderId) {
      return jsonResponse({
        success: false,
        version: "square-webhook-relay-v1",
        error: "order_id is required"
      });
    }

    // 5. Sandbox限定ガード
    const squareConfig = getSquareConfig();

    if (squareConfig.environment !== "sandbox") {
      return jsonResponse({
        success: false,
        version: "square-webhook-relay-v1",
        error: "Square webhook relay processing is limited to sandbox"
      });
    }

    // ------------------------------------------
    // 認証・事前検証が全て成功した後にLockを取得
    // ------------------------------------------
    lock = LockService.getScriptLock();
    lock.waitLock(10000);

    // 6. square_webhook_events シート取得・作成（ヘッダー厳密完全一致検証含む）
    const eventsSheet = getOrCreateSquareWebhookEventsSheet();

    // 7. event_id 重複防止確認 (status === "processed" のチェック)
    if (isSquareWebhookEventProcessed(eventsSheet, eventId)) {
      return jsonResponse({
        success: true,
        version: "square-webhook-relay-v1",
        status: "already_processed",
        event_id: eventId,
        payment_id: paymentId,
        order_id: orderId
      });
    }

    // 8. processSquareSaleOrder(orderId) の実行
    let saleResult;

    try {
      saleResult = processSquareSaleOrder(orderId);
    } catch (processError) {
      // 失敗時のイベントログ記録
      eventsSheet.appendRow([
        new Date().toISOString(),
        eventId,
        "payment.updated",
        paymentId,
        orderId,
        "failed",
        JSON.stringify({
          error: processError.message || String(processError)
        })
      ]);

      return jsonResponse({
        success: false,
        version: "square-webhook-relay-v1",
        error: processError.message || String(processError)
      });
    }

    // 9. 成功時のイベントログ記録
    const safeDetail = JSON.stringify({
      sold_product_count: saleResult.sold_product_count,
      already_sold_count: saleResult.already_sold_count,
      skipped_count: saleResult.skipped_count
    });

    eventsSheet.appendRow([
      new Date().toISOString(),
      eventId,
      "payment.updated",
      paymentId,
      orderId,
      "processed",
      safeDetail
    ]);

    // 10. 成功レスポンス返却
    return jsonResponse({
      success: true,
      version: "square-webhook-relay-v1",
      status: "processed",
      event_id: eventId,
      payment_id: paymentId,
      order_id: orderId,
      sale_result: {
        sold_product_count: saleResult.sold_product_count,
        already_sold_count: saleResult.already_sold_count,
        skipped_count: saleResult.skipped_count
      }
    });

  } catch (err) {
    console.error("handleSquareWebhookRelay error:", err);

    return jsonResponse({
      success: false,
      version: "square-webhook-relay-v1",
      error: err.message || String(err)
    });
  } finally {
    if (lock) {
      try {
        lock.releaseLock();
      } catch (_) {
        // noop
      }
    }
  }
}


// ==================================================
// Square Sandbox Payment ポーリング機能
// ==================================================

const SQUARE_PAYMENT_POLL_OVERLAP_MS = 120000; // 2分
const MAX_PAYMENT_POLL_PAGES = 20;

/**
 * ポーリング用高水位（last success）の初期化
 * 現在時刻を SQUARE_PAYMENT_POLL_LAST_SUCCESS_AT に保存
 */
function initializeSquarePaymentPolling() {
  const squareConfig = getSquareConfig();

  if (squareConfig.environment !== "sandbox") {
    throw new Error(
      "Square payment polling is limited to sandbox"
    );
  }

  const now = new Date();
  const isoNow = now.toISOString();

  PropertiesService
    .getScriptProperties()
    .setProperty(
      "SQUARE_PAYMENT_POLL_LAST_SUCCESS_AT",
      isoNow
    );

  console.log("Square payment polling initialized at: " + isoNow);

  return {
    success: true,
    initialized_at: isoNow
  };
}

/**
 * Square Payments API List Payments 取得 helper
 */
function listSquarePaymentsForPolling(
  squareConfig,
  beginTimeIso,
  endTimeIso,
  cursor
) {
  let query =
    "?location_id=" +
    encodeURIComponent(squareConfig.locationId) +
    "&updated_at_begin_time=" +
    encodeURIComponent(beginTimeIso) +
    "&updated_at_end_time=" +
    encodeURIComponent(endTimeIso) +
    "&sort_field=UPDATED_AT" +
    "&sort_order=ASC" +
    "&limit=100";

  if (cursor) {
    query += "&cursor=" + encodeURIComponent(cursor);
  }

  const response = squareRequest(
    "/v2/payments" + query,
    {
      method: "get"
    }
  );

  let responseData;
  try {
    responseData = JSON.parse(response.body || "{}");
  } catch (_) {
    throw new Error(
      "Square Payments API returned invalid JSON"
    );
  }

  return responseData;
}

/**
 * Square Sandbox の完了済みPaymentを定期取得しBIS在庫を更新
 */
function pollSquareCompletedPayments() {
  const squareConfig = getSquareConfig();

  if (squareConfig.environment !== "sandbox") {
    throw new Error(
      "Square payment polling is limited to sandbox"
    );
  }

  const lock = LockService.getScriptLock();

  try {
    // 同時実行による重複処理やhigh-water markの後退を防止
    lock.waitLock(10000);

    // 1. poll基準時刻を固定
    const pollStartedAt = new Date();
    const pollStartedAtIso = pollStartedAt.toISOString();

    // 2. last success 時刻の取得と未初期化チェック
    const lastSuccessAt = String(
      PropertiesService
        .getScriptProperties()
        .getProperty("SQUARE_PAYMENT_POLL_LAST_SUCCESS_AT") || ""
    ).trim();

    if (!lastSuccessAt) {
      throw new Error(
        "Square payment polling is not initialized. Please run initializeSquarePaymentPolling() first."
      );
    }

    const lastSuccessTime = new Date(lastSuccessAt).getTime();
    if (isNaN(lastSuccessTime)) {
      throw new Error(
        "Invalid SQUARE_PAYMENT_POLL_LAST_SUCCESS_AT: " + lastSuccessAt
      );
    }

    // 3. 検索開始時刻（2分オーバーラップ）
    const searchBeginTime = new Date(
      lastSuccessTime - SQUARE_PAYMENT_POLL_OVERLAP_MS
    );
    const searchBeginAtIso = searchBeginTime.toISOString();

    // 4. Payments API Pagination 取得
    let cursor = "";
    let pageCount = 0;
    const allPayments = [];

    do {
      pageCount++;
      if (pageCount > MAX_PAYMENT_POLL_PAGES) {
        throw new Error(
          "Square payment polling exceeded page limit"
        );
      }

      const pageData = listSquarePaymentsForPolling(
        squareConfig,
        searchBeginAtIso,
        pollStartedAtIso,
        cursor
      );

      const payments = Array.isArray(pageData.payments)
        ? pageData.payments
        : [];

      for (let p = 0; p < payments.length; p++) {
        allPayments.push(payments[p]);
      }

      cursor = String(pageData.cursor || "").trim();
    } while (cursor);

    // 5. Payment 抽出・フィルタリング
    let completedPaymentCount = 0;
    let skippedNonCompletedCount = 0;
    let skippedNoOrderCount = 0;
    let skippedWrongLocationCount = 0;

    const targetOrderIds = [];
    const seenOrderIdsInThisPoll = new Set();

    for (let i = 0; i < allPayments.length; i++) {
      const payment = allPayments[i];

      // location_id 二重確認
      if (
        payment.location_id &&
        String(payment.location_id).trim() !== squareConfig.locationId
      ) {
        skippedWrongLocationCount++;
        continue;
      }

      // status COMPLETED 確認
      const status = String(payment.status || "").trim();
      if (status !== "COMPLETED") {
        skippedNonCompletedCount++;
        continue;
      }

      // COMPLETED Payment全件をカウント
      completedPaymentCount++;

      // order_id 確認
      const orderId = String(payment.order_id || "").trim();
      if (!orderId) {
        skippedNoOrderCount++;
        continue;
      }

      // 同一 poll 内の order_id 重複除外
      if (!seenOrderIdsInThisPoll.has(orderId)) {
        seenOrderIdsInThisPoll.add(orderId);
        targetOrderIds.push(orderId);
      }
    }

    // 6. 各 Order に対する processSquareSaleOrder 呼び出し
    let processedOrderCount = 0;
    let alreadySoldOrderCount = 0;
    let failedOrderCount = 0;
    const orderResults = [];

    for (let j = 0; j < targetOrderIds.length; j++) {
      const orderId = targetOrderIds[j];

      try {
        const saleResult = processSquareSaleOrder(orderId);

        let orderStatus = "processed";
        if (
          saleResult.sold_product_count === 0 &&
          saleResult.already_sold_count > 0
        ) {
          orderStatus = "already_sold";
          alreadySoldOrderCount++;
        } else {
          processedOrderCount++;
        }

        orderResults.push({
          order_id: orderId,
          status: orderStatus,
          sold_product_count: saleResult.sold_product_count,
          already_sold_count: saleResult.already_sold_count,
          skipped_count: saleResult.skipped_count
        });
      } catch (orderError) {
        failedOrderCount++;
        orderResults.push({
          order_id: orderId,
          status: "failed",
          error: orderError.message || String(orderError)
        });
      }
    }

    const resultSummary = {
      success: failedOrderCount === 0,
      poll_started_at: pollStartedAtIso,
      search_begin_at: searchBeginAtIso,
      previous_last_success_at: lastSuccessAt,
      new_last_success_at:
        failedOrderCount === 0 ? pollStartedAtIso : lastSuccessAt,

      payment_count: allPayments.length,
      completed_payment_count: completedPaymentCount,
      skipped_non_completed_count: skippedNonCompletedCount,
      skipped_no_order_count: skippedNoOrderCount,
      skipped_wrong_location_count: skippedWrongLocationCount,

      unique_order_count: targetOrderIds.length,
      processed_order_count: processedOrderCount,
      already_sold_order_count: alreadySoldOrderCount,
      failed_order_count: failedOrderCount,

      results: orderResults
    };

    // 7. high-water mark 更新
    if (failedOrderCount === 0) {
      PropertiesService
        .getScriptProperties()
        .setProperty(
          "SQUARE_PAYMENT_POLL_LAST_SUCCESS_AT",
          pollStartedAtIso
        );
    } else {
      console.error(
        "Square payment polling had failed orders. Results: " +
        JSON.stringify(resultSummary)
      );
      throw new Error(
        "Square payment polling encountered " +
        failedOrderCount +
        " failed order(s). High-water mark was not updated."
      );
    }

    return resultSummary;
  } finally {
    try {
      lock.releaseLock();
    } catch (_) {
      // noop
    }
  }
}



// ==================================================
// Pokemon Cards Sheet Helpers
// ==================================================

const POKEMON_CARDS_SHEET_NAME = "pokemon_cards";

const POKEMON_CARDS_HEADERS = [
  "product_id",
  "card_name",
  "set_name",
  "card_number",
  "rarity",
  "language",
  "grading_status",
  "grader",
  "grade",
  "certification_number",
  "card_condition",
  "created_at",
  "updated_at"
];
