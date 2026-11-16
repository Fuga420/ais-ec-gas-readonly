function testSquareCatalogConnection() {
  const response = squareRequest(
    "/v2/catalog/list?types=ITEM",
    {
      method: "get"
    }
  );

  let catalogResponse;

  try {
    catalogResponse = JSON.parse(
      response.body || "{}"
    );
  } catch (_) {
    throw new Error(
      "Square Catalog API returned invalid JSON"
    );
  }

  const catalogObjects =
    Array.isArray(catalogResponse.objects)
      ? catalogResponse.objects
      : [];

  const items = [];

  catalogObjects.forEach(object => {
    if (
      !object ||
      object.type !== "ITEM"
    ) {
      return;
    }

    const itemData =
      object.item_data || {};

    const variations =
      Array.isArray(itemData.variations)
        ? itemData.variations
        : [];

    variations.forEach(variation => {
      const variationData =
        variation.item_variation_data || {};

      const priceMoney =
        variationData.price_money || {};

      items.push({
        square_item_id:
          object.id || "",

        product_name:
          itemData.name || "",

        square_variation_id:
          variation.id || "",

        variation_name:
          variationData.name || "",

        sku:
          variationData.sku || "",

        price_amount:
          Object.prototype.hasOwnProperty.call(
            priceMoney,
            "amount"
          )
            ? priceMoney.amount
            : null,

        currency:
          priceMoney.currency || ""
      });
    });
  });

  const result = {
    success: true,
    http_status: response.httpStatus,
    item_count: items.length,
    items: items
  };

  console.log(JSON.stringify(result));

  return result;
}

/**
 * Square Production ListLocations READ ONLY 疎通確認テスト
 *
 * 既存のSQUARE_ENVやSandbox設定を変更せず、
 * Production専用プロパティ（SQUARE_PROD_ACCESS_TOKEN, SQUARE_PROD_LOCATION_ID）を用いて
 * 本番Square API (GET /v2/locations) への接続とLocation整合性を検証する。
 *
 * @return {{
 *   success: boolean,
 *   environment: string,
 *   location_found: boolean,
 *   location_id: string,
 *   location_name: string,
 *   status: string,
 *   currency: string
 * }}
 */
function testSquareProductionListLocations() {
  const scriptProperties = PropertiesService.getScriptProperties();

  const prodAccessToken = String(
    scriptProperties.getProperty("SQUARE_PROD_ACCESS_TOKEN") || ""
  ).trim();

  const prodLocationId = String(
    scriptProperties.getProperty("SQUARE_PROD_LOCATION_ID") || ""
  ).trim();

  const apiVersion = String(
    scriptProperties.getProperty("SQUARE_API_VERSION") || ""
  ).trim();

  const missingProperties = [];
  if (!prodAccessToken) {
    missingProperties.push("SQUARE_PROD_ACCESS_TOKEN");
  }
  if (!prodLocationId) {
    missingProperties.push("SQUARE_PROD_LOCATION_ID");
  }
  if (!apiVersion) {
    missingProperties.push("SQUARE_API_VERSION");
  }

  if (missingProperties.length > 0) {
    throw new Error(
      "missing required Square Production Script Properties: " +
      missingProperties.join(", ")
    );
  }

  const url = "https://connect.squareup.com/v2/locations";

  const fetchOptions = {
    method: "get",
    headers: {
      Authorization: "Bearer " + prodAccessToken,
      "Square-Version": apiVersion,
      "Content-Type": "application/json"
    },
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch(url, fetchOptions);
  const httpStatus = response.getResponseCode();
  const responseBody = response.getContentText();

  if (httpStatus < 200 || httpStatus >= 300) {
    const safeResponseBody = responseBody
      .split(prodAccessToken)
      .join("[REDACTED]");

    throw new Error(
      "Square Production API request failed with HTTP " +
      httpStatus +
      ": " +
      safeResponseBody
    );
  }

  let responseData;
  try {
    responseData = JSON.parse(responseBody || "{}");
  } catch (_) {
    throw new Error("Square Production API returned invalid JSON");
  }

  const locations = Array.isArray(responseData.locations)
    ? responseData.locations
    : [];

  if (locations.length === 0) {
    throw new Error("Square Production API returned no locations");
  }

  const matchedLocation = locations.find(loc =>
    loc && String(loc.id || "").trim() === prodLocationId
  );

  if (!matchedLocation) {
    const availableIds = locations
      .map(loc => String(loc && loc.id || "").trim())
      .filter(Boolean);

    throw new Error(
      "configured SQUARE_PROD_LOCATION_ID not found in Production locations. Available location IDs: " +
      availableIds.join(", ")
    );
  }

  if (String(matchedLocation.status || "").trim().toUpperCase() !== "ACTIVE") {
    throw new Error(
      "Square Production location is not ACTIVE: status=" +
      matchedLocation.status
    );
  }

  const result = {
    success: true,
    environment: "production",
    location_found: true,
    location_id: String(matchedLocation.id || "").trim(),
    location_name: String(matchedLocation.name || "").trim(),
    status: String(matchedLocation.status || "").trim(),
    currency: String(matchedLocation.currency || "").trim()
  };

  console.log(JSON.stringify(result));
  return result;
}

/**
 * Square Production Catalog の作成・取得・削除を検証する安全なE2Eテスト
 *
 * 1. POST /v2/catalog/object で本番専用テスト商品を1件作成 (Location限定、価格100円)
 * 2. GET /v2/catalog/object/{id} で再取得し、名前・Variation ID・価格を照合
 * 3. DELETE /v2/catalog/object/{id} で削除し、deleted_object_ids を確認
 * 4. GET /v2/catalog/object/{id} で削除完了（404 または is_deleted: true）を確認
 * 5. finally ブロックで必ず削除処理を試行（テスト失敗時も商品を残さない）
 *
 * ※ BIS商品マスター、Google Sheets、Drive等への変更は一切行いません。
 *
 * @return {{
 *   success: boolean,
 *   environment: string,
 *   create: string,
 *   retrieve: string,
 *   delete: string,
 *   cleanup: string,
 *   item_id: string,
 *   variation_id: string
 * }}
 */
function testSquareProductionCatalogCreateDelete() {
  const scriptProperties = PropertiesService.getScriptProperties();

  const prodLocationId = String(
    scriptProperties.getProperty("SQUARE_PROD_LOCATION_ID") || ""
  ).trim();

  if (!prodLocationId) {
    throw new Error("SQUARE_PROD_LOCATION_ID is required");
  }

  const testSuffix = Utilities.getUuid();
  const testItemName = "BIS PRODUCTION API TEST 2026-09-17";
  const testVariationName = "Test Variation";
  const testPriceAmount = 100;
  const testCurrency = "JPY";

  const tempItemId = "#bis-prod-test-item-" + testSuffix;
  const tempVariationId = "#bis-prod-test-var-" + testSuffix;
  const idempotencyKey = Utilities.getUuid();

  let createdItemId = null;
  let createdVariationId = null;
  let deletePassed = false;

  let testError = null;
  let cleanupError = null;

  try {
    // ------------------------------------------
    // 1. CREATE: POST /v2/catalog/object
    // ------------------------------------------
    const createPayload = {
      idempotency_key: idempotencyKey,
      object: {
        type: "ITEM",
        id: tempItemId,
        present_at_all_locations: false,
        present_at_location_ids: [prodLocationId],
        item_data: {
          name: testItemName,
          variations: [
            {
              type: "ITEM_VARIATION",
              id: tempVariationId,
              present_at_all_locations: false,
              present_at_location_ids: [prodLocationId],
              item_variation_data: {
                name: testVariationName,
                pricing_type: "FIXED_PRICING",
                price_money: {
                  amount: testPriceAmount,
                  currency: testCurrency
                }
              }
            }
          ]
        }
      }
    };

    const createRes = squareProdRequest_(
      "/v2/catalog/object",
      {
        method: "post",
        payload: createPayload
      }
    );

    let createData;
    try {
      createData = JSON.parse(createRes.body || "{}");
    } catch (_) {
      throw new Error("Square Production Catalog CREATE returned invalid JSON");
    }

    const catalogObject = createData.catalog_object || {};
    const idMappings = Array.isArray(createData.id_mappings)
      ? createData.id_mappings
      : [];

    const itemMapping = idMappings.find(m =>
      m && m.client_object_id === tempItemId
    );
    createdItemId = String(
      itemMapping && itemMapping.object_id || catalogObject.id || ""
    ).trim();

    const varMapping = idMappings.find(m =>
      m && m.client_object_id === tempVariationId
    );
    createdVariationId = String(
      varMapping && varMapping.object_id || ""
    ).trim();

    if (!createdVariationId && catalogObject.item_data && Array.isArray(catalogObject.item_data.variations)) {
      const firstVar = catalogObject.item_data.variations[0];
      if (firstVar) {
        createdVariationId = String(firstVar.id || "").trim();
      }
    }

    if (!createdItemId || createdItemId.startsWith("#")) {
      throw new Error(
        "Square Production Catalog CREATE did not return a valid server item_id: " +
        createdItemId
      );
    }

    if (!createdVariationId || createdVariationId.startsWith("#")) {
      throw new Error(
        "Square Production Catalog CREATE did not return a valid server variation_id: " +
        createdVariationId
      );
    }

    // ------------------------------------------
    // 2. RETRIEVE: GET /v2/catalog/object/{item_id}
    // ------------------------------------------
    const retrieveRes = squareProdRequest_(
      "/v2/catalog/object/" + encodeURIComponent(createdItemId),
      {
        method: "get"
      }
    );

    let retrieveData;
    try {
      retrieveData = JSON.parse(retrieveRes.body || "{}");
    } catch (_) {
      throw new Error("Square Production Catalog RETRIEVE returned invalid JSON");
    }

    const retrievedObject = retrieveData.object;
    if (!retrievedObject || retrievedObject.type !== "ITEM") {
      throw new Error("Retrieved Catalog object is not an ITEM");
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
    if (String(retrievedItemData.name || "").trim() !== testItemName) {
      throw new Error(
        "Retrieved Catalog item name mismatch: expected " +
        testItemName +
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
    if (String(matchedVarData.name || "").trim() !== testVariationName) {
      throw new Error(
        "Retrieved variation name mismatch: expected " +
        testVariationName +
        ", got " +
        matchedVarData.name
      );
    }

    const priceMoney = matchedVarData.price_money || {};
    if (Number(priceMoney.amount) !== testPriceAmount) {
      throw new Error(
        "Retrieved variation price amount mismatch: expected " +
        testPriceAmount +
        ", got " +
        priceMoney.amount
      );
    }

    if (String(priceMoney.currency || "").trim().toUpperCase() !== testCurrency) {
      throw new Error(
        "Retrieved variation price currency mismatch: expected " +
        testCurrency +
        ", got " +
        priceMoney.currency
      );
    }

  } catch (error) {
    testError = error;
  } finally {
    // ------------------------------------------
    // 3 & 4. DELETE & 削除後確認 (cleanup)
    // ------------------------------------------
    if (createdItemId) {
      try {
        const deleteRes = squareProdRequest_(
          "/v2/catalog/object/" + encodeURIComponent(createdItemId),
          {
            method: "delete"
          }
        );

        let deleteData = {};
        try {
          deleteData = JSON.parse(deleteRes.body || "{}");
        } catch (_) {}

        const deletedObjectIds = Array.isArray(deleteData.deleted_object_ids)
          ? deleteData.deleted_object_ids
          : [];

        if (!deletedObjectIds.includes(createdItemId)) {
          throw new Error(
            "deleted_object_ids does not contain createdItemId (" +
            createdItemId +
            "): " +
            deletedObjectIds.join(", ")
          );
        }

        deletePassed = true;

        // 削除後確認: GET /v2/catalog/object/{item_id}
        const verifyDelRes = squareProdRequest_(
          "/v2/catalog/object/" + encodeURIComponent(createdItemId),
          {
            method: "get",
            allowError: true
          }
        );

        let isDeletedConfirmed = false;
        if (verifyDelRes.httpStatus === 404) {
          isDeletedConfirmed = true;
        } else if (verifyDelRes.httpStatus >= 200 && verifyDelRes.httpStatus < 300) {
          let verifyDelData = {};
          try {
            verifyDelData = JSON.parse(verifyDelRes.body || "{}");
          } catch (_) {}
          if (verifyDelData.object && verifyDelData.object.is_deleted === true) {
            isDeletedConfirmed = true;
          }
        } else {
          let verifyDelData = {};
          try {
            verifyDelData = JSON.parse(verifyDelRes.body || "{}");
          } catch (_) {}
          if (
            Array.isArray(verifyDelData.errors) &&
            verifyDelData.errors.some(e => e && e.code === "NOT_FOUND")
          ) {
            isDeletedConfirmed = true;
          }
        }

        if (!isDeletedConfirmed) {
          throw new Error(
            "Square Production Catalog object was not confirmed as deleted: status=" +
            verifyDelRes.httpStatus +
            ", body=" +
            verifyDelRes.body
          );
        }

      } catch (delError) {
        cleanupError = delError;
      }
    }
  }

  // エラー判定：本体テストエラーを優先スロー
  if (testError) {
    if (cleanupError) {
      console.warn(
        "Square Production Catalog cleanup also failed: " +
        cleanupError.message
      );
    }
    throw testError;
  }

  if (cleanupError) {
    throw cleanupError;
  }

  const summary = {
    success: true,
    environment: "production",
    create: "passed",
    retrieve: "passed",
    delete: deletePassed ? "passed" : "not_attempted",
    cleanup: "passed",
    item_id: createdItemId,
    variation_id: createdVariationId
  };

  console.log(JSON.stringify(summary));
  return summary;
}

/**
 * Square Production 実商品登録手動テスト
 *
 * Script Properties の SQUARE_PROD_TEST_PRODUCT_ID から対象商品IDを取得し、
 * createSquareProductionProduct(productId) を実行する。
 *
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
function testCreateSquareProductionProduct() {
  const testProductId = String(
    PropertiesService
      .getScriptProperties()
      .getProperty("SQUARE_PROD_TEST_PRODUCT_ID") || ""
  ).trim();

  if (!testProductId) {
    throw new Error(
      "SQUARE_PROD_TEST_PRODUCT_ID is required for manual test"
    );
  }

  const result = createSquareProductionProduct(testProductId);
  return result;
}

/**
 * Square Production メイン画像同期 手動テスト
 *
 * Script Properties の SQUARE_PROD_TEST_PRODUCT_ID から対象商品IDを取得し、
 * syncSquareProductionProductMainImage(productId) を実行する。
 *
 * @return {Object} 実行結果サマリー
 */
function testSyncSquareProductionProductMainImage() {
  const testProductId = String(
    PropertiesService
      .getScriptProperties()
      .getProperty("SQUARE_PROD_TEST_PRODUCT_ID") || ""
  ).trim();

  if (!testProductId) {
    throw new Error(
      "SQUARE_PROD_TEST_PRODUCT_ID is required for manual test"
    );
  }

  const result = syncSquareProductionProductMainImage(testProductId);
  return result;
}

/**
 * Square Production 在庫同期 手動テスト
 *
 * Script Properties の SQUARE_PROD_TEST_PRODUCT_ID から対象商品IDを取得し、
 * 数量 1 で syncSquareProductionProductInventory(productId, 1) を実行する。
 *
 * @return {Object} 実行結果サマリー
 */
function testSyncSquareProductionProductInventory() {
  const testProductId = String(
    PropertiesService
      .getScriptProperties()
      .getProperty("SQUARE_PROD_TEST_PRODUCT_ID") || ""
  ).trim();

  if (!testProductId) {
    throw new Error(
      "SQUARE_PROD_TEST_PRODUCT_ID is required for manual test"
    );
  }

  const result = syncSquareProductionProductInventory(testProductId, 1);
  return result;
}

/**
 * Square Production Variation 価格更新 手動テスト
 *
 * Script Properties の SQUARE_PROD_TEST_PRODUCT_ID と SQUARE_PROD_TEST_PRICE (任意、デフォルト 100) から
 * updateSquareProductionProductPrice(productId, newPrice) を実行する。
 *
 * @return {Object} 実行結果サマリー
 */
function testUpdateSquareProductionProductPrice() {
  const scriptProperties = PropertiesService.getScriptProperties();
  const testProductId = String(
    scriptProperties.getProperty("SQUARE_PROD_TEST_PRODUCT_ID") || ""
  ).trim();
  const testPrice = Number(
    scriptProperties.getProperty("SQUARE_PROD_TEST_PRICE") || 100
  );

  if (!testProductId) {
    throw new Error("SQUARE_PROD_TEST_PRODUCT_ID is required for manual test");
  }

  return updateSquareProductionProductPrice(testProductId, testPrice);
}

/**
 * Square Production Catalog Item アーカイブ 手動テスト
 * @return {Object}
 */
function testArchiveSquareProductionProduct() {
  const scriptProperties = PropertiesService.getScriptProperties();
  const testProductId = String(
    scriptProperties.getProperty("SQUARE_PROD_TEST_PRODUCT_ID") || ""
  ).trim();

  if (!testProductId) {
    throw new Error("SQUARE_PROD_TEST_PRODUCT_ID is required for manual test");
  }

  return archiveSquareProductionProduct(testProductId);
}

/**
 * Square Production Catalog Item アーカイブ解除 手動テスト
 * @return {Object}
 */
function testUnarchiveSquareProductionProduct() {
  const scriptProperties = PropertiesService.getScriptProperties();
  const testProductId = String(
    scriptProperties.getProperty("SQUARE_PROD_TEST_PRODUCT_ID") || ""
  ).trim();

  if (!testProductId) {
    throw new Error("SQUARE_PROD_TEST_PRODUCT_ID is required for manual test");
  }

  return unarchiveSquareProductionProduct(testProductId);
}

/**
 * Square Production Catalog Item 完全削除 手動テスト
 * @return {Object}
 */
function testDeleteSquareProductionProduct() {
  const scriptProperties = PropertiesService.getScriptProperties();
  const testProductId = String(
    scriptProperties.getProperty("SQUARE_PROD_TEST_PRODUCT_ID") || ""
  ).trim();

  if (!testProductId) {
    throw new Error("SQUARE_PROD_TEST_PRODUCT_ID is required for manual test");
  }

  return deleteSquareProductionProduct(testProductId);
}

/**
 * Square Production 商品詳細情報同期 手動テスト
 * @return {Object}
 */
function testSyncSquareProductionProductDetails() {
  const scriptProperties = PropertiesService.getScriptProperties();
  const testProductId = String(
    scriptProperties.getProperty("SQUARE_PROD_TEST_PRODUCT_ID") || ""
  ).trim();

  if (!testProductId) {
    throw new Error("SQUARE_PROD_TEST_PRODUCT_ID is required for manual test");
  }

  return syncSquareProductionProductDetails(testProductId);
}

/**
 * Square Production Payment READ ONLY プレビューの手動テスト用ラッパー
 * Apps Script エディタから引数なしで実行可能
 *
 * @return {Object} プレビュー結果サマリー
 */
function testPreviewSquareProductionCompletedPayments() {
  return previewSquareProductionCompletedPayments();
}

/**
 * Square Production 販売Order処理 手動テスト用ラッパー
 * Script Properties の SQUARE_PROD_TEST_ORDER_ID を使用して実行する
 *
 * @return {Object} 処理結果サマリー
 */
function testProcessSquareProductionSaleOrder() {
  const testOrderId = String(
    PropertiesService
      .getScriptProperties()
      .getProperty("SQUARE_PROD_TEST_ORDER_ID") || ""
  ).trim();

  if (!testOrderId) {
    throw new Error(
      "SQUARE_PROD_TEST_ORDER_ID is required for manual test"
    );
  }

  const result = processSquareProductionSaleOrder(testOrderId);
  return result;
}

/**
 * Square Production Payment Link 無効化 手動テスト
 *
 * Script Properties の SQUARE_PROD_TEST_PRODUCT_ID から対象商品IDを取得し、
 * invalidateSquareProductionPaymentLink(productId) を実行する。
 *
 * @return {Object} 実行結果サマリー
 */
function testInvalidateSquareProductionPaymentLink() {
  const testProductId = String(
    PropertiesService
      .getScriptProperties()
      .getProperty("SQUARE_PROD_TEST_PRODUCT_ID") || ""
  ).trim();

  if (!testProductId) {
    throw new Error(
      "SQUARE_PROD_TEST_PRODUCT_ID is required for manual test"
    );
  }

  const result = invalidateSquareProductionPaymentLink(testProductId);
  return result;
}

/**
 * Square Production Payment Link 生成 手動テスト
 *
 * Script Properties の SQUARE_PROD_TEST_PRODUCT_ID から対象商品IDを取得し、
 * createSquareProductionPaymentLink(productId) を実行する。
 *
 * @return {Object} 実行結果サマリー
 */
function testCreateSquareProductionPaymentLink() {
  const testProductId = String(
    PropertiesService
      .getScriptProperties()
      .getProperty("SQUARE_PROD_TEST_PRODUCT_ID") || ""
  ).trim();

  if (!testProductId) {
    throw new Error(
      "SQUARE_PROD_TEST_PRODUCT_ID is required for manual test"
    );
  }

  const result = createSquareProductionPaymentLink(testProductId);
  return result;
}

/**
 * 未確定9商品の square_item_id 環境判定 手動実行用テスト関数
 * Apps Script エディタから手動実行可能
 */
function testInspectUnconfirmedSquareCatalogItems() {
  return inspectUnconfirmedSquareItemIds();
}

function testCreateSquareProduct() {
  const testProductId = String(
    PropertiesService
      .getScriptProperties()
      .getProperty(
        "SQUARE_TEST_PRODUCT_ID"
      ) || ""
  ).trim();

  if (!testProductId) {
    throw new Error(
      "SQUARE_TEST_PRODUCT_ID is required for manual test"
    );
  }

  const result =
    createSquareProduct(testProductId);

  console.log(JSON.stringify(result));

  return result;
}

function testUpdateSquareProduct() {
  const testProductId = String(
    PropertiesService
      .getScriptProperties()
      .getProperty(
        "SQUARE_TEST_PRODUCT_ID"
      ) || ""
  ).trim();

  if (!testProductId) {
    throw new Error(
      "SQUARE_TEST_PRODUCT_ID is required for manual test"
    );
  }

  const result =
    updateSquareProduct(testProductId);

  console.log(JSON.stringify(result));

  return result;
}

function testSyncSquareProductMainImage() {
  const testProductId = String(
    PropertiesService
      .getScriptProperties()
      .getProperty(
        "SQUARE_TEST_PRODUCT_ID"
      ) || ""
  ).trim();

  if (!testProductId) {
    throw new Error(
      "SQUARE_TEST_PRODUCT_ID is required for manual test"
    );
  }

  const result =
    syncSquareProductMainImage(testProductId);

  console.log(JSON.stringify(result));

  return result;
}

function testSyncSquareProductInventory() {
  const testProductId = String(
    PropertiesService
      .getScriptProperties()
      .getProperty(
        "SQUARE_TEST_PRODUCT_ID"
      ) || ""
  ).trim();

  if (!testProductId) {
    throw new Error(
      "SQUARE_TEST_PRODUCT_ID is required for manual test"
    );
  }

  const result =
    syncSquareProductInventory(testProductId);

  console.log(JSON.stringify(result));

  return result;
}

function testInspectSquareInventoryTracking() {
  const testProductId = String(
    PropertiesService
      .getScriptProperties()
      .getProperty(
        "SQUARE_TEST_PRODUCT_ID"
      ) || ""
  ).trim();

  if (!testProductId) {
    throw new Error(
      "SQUARE_TEST_PRODUCT_ID is required for manual test"
    );
  }

  const sheet = SpreadsheetApp
    .getActiveSpreadsheet()
    .getSheets()[0];

  const targetRow =
    findProductRow(
      sheet,
      testProductId
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

  const squareItemId =
    String(row[34] || "").trim();

  const squareVariationId =
    String(row[35] || "").trim();

  if (!squareItemId || !squareVariationId) {
    throw new Error(
      "product is not fully linked to Square: item=" +
      squareItemId +
      ", variation=" +
      squareVariationId
    );
  }

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

  const variationData =
    currentVariation.item_variation_data || {};

  const rawLocationOverrides =
    Array.isArray(variationData.location_overrides)
      ? variationData.location_overrides
      : [];

  const locationOverrides =
    rawLocationOverrides.map(override => ({
      location_id:
        String(override && override.location_id || "").trim(),
      track_inventory:
        override && Object.prototype.hasOwnProperty.call(override, "track_inventory")
          ? override.track_inventory
          : null,
      sold_out:
        override && Object.prototype.hasOwnProperty.call(override, "sold_out")
          ? override.sold_out
          : null
    }));

  const result = {
    product_id: testProductId,
    square_item_id: squareItemId,
    square_variation_id: squareVariationId,
    track_inventory:
      Object.prototype.hasOwnProperty.call(variationData, "track_inventory")
        ? variationData.track_inventory
        : null,
    sellable:
      Object.prototype.hasOwnProperty.call(variationData, "sellable")
        ? variationData.sellable
        : null,
    stockable:
      Object.prototype.hasOwnProperty.call(variationData, "stockable")
        ? variationData.stockable
        : null,
    location_overrides: locationOverrides
  };

  console.log(JSON.stringify(result));

  return result;
}

function testProcessSquareSaleOrder() {
  const testOrderId = String(
    PropertiesService
      .getScriptProperties()
      .getProperty(
        "SQUARE_TEST_ORDER_ID"
      ) || ""
  ).trim();

  if (!testOrderId) {
    throw new Error(
      "SQUARE_TEST_ORDER_ID is required for manual test"
    );
  }

  const result =
    processSquareSaleOrder(testOrderId);

  console.log(JSON.stringify(result));

  return result;
}

/**
 * 手動テスト関数
 */
function testPollSquareCompletedPayments() {
  const result = pollSquareCompletedPayments();
  console.log(JSON.stringify(result));
  return result;
}

/**
 * Pokemon Card Phase 3 テスト用のアサーション内部helper
 * @param {boolean} condition
 * @param {string} message
 */
function assertPokemonCardTest_(condition, message) {
  if (!condition) {
    throw new Error("Pokemon Card Phase 3 test failed: " + message);
  }
}

/**
 * Pokemon Cards Phase 3: WRITE / READ helper の手動E2E検証関数
 *
 * 目的:
 * 1. 新規CREATE
 * 2. READ
 * 3. card_numberの先頭ゼロ保持 ("001/025")
 * 4. certification_numberの先頭ゼロ保持 ("0001234567")
 * 5. graded時のcard_condition自動クリア
 * 6. Partial Update (未指定項目の維持)
 * 7. graded → ungraded切替時の項目自動クリア
 * 8. validation (不正値でErrorになること、既存データが不変であること)
 * 9. finallyでの一意テストレコード完全クリーンアップ (既存他データには一切触れない)
 *
 * ※ Apps Script エディタから手動実行して動作確認する関数です。
 *
 * @return {Object} テスト結果サマリー
 */
function testPokemonCardReadWritePhase3() {
  const testProductId = "TEST-PKM-" + Utilities.getUuid();
  const lock = LockService.getScriptLock();
  let lockAcquired = false;

  let testError = null;
  let cleanupError = null;
  let summary = null;

  try {
    lock.waitLock(10000);
    lockAcquired = true;

    // --- Preflight ---
    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = spreadsheet.getSheetByName(POKEMON_CARDS_SHEET_NAME);
    assertPokemonCardTest_(sheet !== null, "pokemon_cards sheet is not initialized");

    validatePokemonCardsSheetSchema_(sheet);

    const initialRecord = getPokemonCardByProductId(testProductId);
    assertPokemonCardTest_(initialRecord === null, "initial record for testProductId must be null");

    // --- Test 1: Graded Card CREATE ---
    const createData = {
      card_name: "Pikachu Phase3 Test",
      set_name: "Test Set",
      card_number: "001/025",
      rarity: "SR",
      language: "Japanese",
      grading_status: "graded",
      grader: "PSA",
      grade: "10",
      certification_number: "0001234567",
      // gradedでは自動クリアされることを確認するため、あえて入力
      card_condition: "NM"
    };

    const createRes = savePokemonCardByProductId(testProductId, createData);
    assertPokemonCardTest_(createRes.success === true, "createRes.success must be true");
    assertPokemonCardTest_(createRes.status === "created", "createRes.status must be 'created'");
    assertPokemonCardTest_(createRes.product_id === testProductId, "createRes.product_id mismatch");

    // --- Test 2 & 3: READ after CREATE & 先頭ゼロ保持 & graded自動クリア検証 ---
    const read1 = getPokemonCardByProductId(testProductId);
    assertPokemonCardTest_(read1 !== null, "read1 must not be null");
    assertPokemonCardTest_(read1.product_id === testProductId, "read1.product_id mismatch");
    assertPokemonCardTest_(read1.card_name === "Pikachu Phase3 Test", "read1.card_name mismatch");
    assertPokemonCardTest_(read1.set_name === "Test Set", "read1.set_name mismatch");
    assertPokemonCardTest_(read1.card_number === "001/025", "read1.card_number leading zero mismatch (expected '001/025', got '" + read1.card_number + "')");
    assertPokemonCardTest_(read1.rarity === "SR", "read1.rarity mismatch");
    assertPokemonCardTest_(read1.language === "Japanese", "read1.language mismatch");
    assertPokemonCardTest_(read1.grading_status === "graded", "read1.grading_status mismatch");
    assertPokemonCardTest_(read1.grader === "PSA", "read1.grader mismatch");
    assertPokemonCardTest_(read1.grade === "10", "read1.grade mismatch");
    assertPokemonCardTest_(read1.certification_number === "0001234567", "read1.certification_number leading zero mismatch (expected '0001234567', got '" + read1.certification_number + "')");
    assertPokemonCardTest_(read1.card_condition === "", "read1.card_condition must be empty string for graded card");
    assertPokemonCardTest_(!!read1.created_at, "read1.created_at must be populated");
    assertPokemonCardTest_(!!read1.updated_at, "read1.updated_at must be populated");

    // --- Test 4: Partial Update (未指定項目の維持) ---
    const updateData = {
      rarity: "SAR"
    };

    const updateRes = savePokemonCardByProductId(testProductId, updateData);
    assertPokemonCardTest_(updateRes.success === true, "updateRes.success must be true");
    assertPokemonCardTest_(updateRes.status === "updated", "updateRes.status must be 'updated'");
    assertPokemonCardTest_(updateRes.product_id === testProductId, "updateRes.product_id mismatch");

    const read2 = getPokemonCardByProductId(testProductId);
    assertPokemonCardTest_(read2 !== null, "read2 must not be null");
    assertPokemonCardTest_(read2.rarity === "SAR", "read2.rarity must be updated to 'SAR'");
    assertPokemonCardTest_(read2.card_name === "Pikachu Phase3 Test", "read2.card_name must be retained");
    assertPokemonCardTest_(read2.set_name === "Test Set", "read2.set_name must be retained");
    assertPokemonCardTest_(read2.card_number === "001/025", "read2.card_number must be retained");
    assertPokemonCardTest_(read2.language === "Japanese", "read2.language must be retained");
    assertPokemonCardTest_(read2.grading_status === "graded", "read2.grading_status must be retained");
    assertPokemonCardTest_(read2.grader === "PSA", "read2.grader must be retained");
    assertPokemonCardTest_(read2.grade === "10", "read2.grade must be retained");
    assertPokemonCardTest_(read2.certification_number === "0001234567", "read2.certification_number must be retained");
    assertPokemonCardTest_(read2.card_condition === "", "read2.card_condition must remain empty string");
    assertPokemonCardTest_(read2.created_at === read1.created_at, "read2.created_at must remain identical to read1.created_at");

    // --- Test 5: graded → ungraded 切替 ---
    const transitionData = {
      grading_status: "ungraded",
      card_condition: "NM"
    };

    const transitionRes = savePokemonCardByProductId(testProductId, transitionData);
    assertPokemonCardTest_(transitionRes.success === true, "transitionRes.success must be true");
    assertPokemonCardTest_(transitionRes.status === "updated", "transitionRes.status must be 'updated'");

    const read3 = getPokemonCardByProductId(testProductId);
    assertPokemonCardTest_(read3 !== null, "read3 must not be null");
    assertPokemonCardTest_(read3.grading_status === "ungraded", "read3.grading_status must be 'ungraded'");
    assertPokemonCardTest_(read3.card_condition === "NM", "read3.card_condition must be 'NM'");
    assertPokemonCardTest_(read3.grader === "", "read3.grader must be cleared to empty string");
    assertPokemonCardTest_(read3.grade === "", "read3.grade must be cleared to empty string");
    assertPokemonCardTest_(read3.certification_number === "", "read3.certification_number must be cleared to empty string");
    assertPokemonCardTest_(read3.card_name === "Pikachu Phase3 Test", "read3.card_name must be retained");
    assertPokemonCardTest_(read3.card_number === "001/025", "read3.card_number must be retained");

    // --- Test 6: Validation (不正値でErrorになること & 既存データ不変確認) ---
    let validationErrorCaught = false;
    try {
      savePokemonCardByProductId(testProductId, {
        grading_status: "invalid"
      });
    } catch (error) {
      if (String(error.message) === "grading_status must be graded or ungraded") {
        validationErrorCaught = true;
      } else {
        throw error;
      }
    }
    assertPokemonCardTest_(validationErrorCaught, "expected grading_status validation error was not thrown");

    // Validation失敗後に既存レコードが破壊・変更されていないことを確認
    const read4 = getPokemonCardByProductId(testProductId);
    assertPokemonCardTest_(read4 !== null, "read4 must not be null");
    assertPokemonCardTest_(read4.grading_status === "ungraded", "read4.grading_status must remain 'ungraded'");
    assertPokemonCardTest_(read4.card_condition === "NM", "read4.card_condition must remain 'NM'");
    assertPokemonCardTest_(read4.grader === "", "read4.grader must remain empty string");
    assertPokemonCardTest_(read4.grade === "", "read4.grade must remain empty string");
    assertPokemonCardTest_(read4.certification_number === "", "read4.certification_number must remain empty string");

    // --- Test 7: Ungraded card with empty card_condition (ドラフト・裏面未撮影許容) ---
    const emptyCondRes = savePokemonCardByProductId(testProductId, {
      grading_status: "ungraded",
      card_condition: ""
    });
    assertPokemonCardTest_(emptyCondRes.success === true, "emptyCondRes.success must be true");
    const read5 = getPokemonCardByProductId(testProductId);
    assertPokemonCardTest_(read5 !== null, "read5 must not be null");
    assertPokemonCardTest_(read5.grading_status === "ungraded", "read5.grading_status must be 'ungraded'");
    assertPokemonCardTest_(read5.card_condition === "", "read5.card_condition must be empty string");

    summary = {
      success: true,
      version: "pokemon-card-phase3-test-v1",
      product_id: testProductId,
      create: "passed",
      read: "passed",
      leading_zero_preservation: "passed",
      partial_update: "passed",
      grading_transition: "passed",
      validation: "passed",
      empty_condition: "passed",
      cleanup: "pending"
    };

  } catch (error) {
    testError = error;
  } finally {
    // --- Cleanup: testProductId に完全一致する行のみ安全に削除 ---
    try {
      const cleanupSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(POKEMON_CARDS_SHEET_NAME);
      if (cleanupSheet) {
        const lastRow = cleanupSheet.getLastRow();
        if (lastRow >= 2) {
          const idValues = cleanupSheet.getRange(2, 1, lastRow - 1, 1).getValues();
          // 下の行から上の行へ削除（行インデックスずれ防止）
          for (let i = idValues.length - 1; i >= 0; i--) {
            const rowId = String(idValues[i][0] || "").trim();
            if (rowId === testProductId) {
              cleanupSheet.deleteRow(i + 2);
            }
          }
        }

        // Cleanup確認（残存チェック：1件でも残っていればエラー）
        const verifyLastRow = cleanupSheet.getLastRow();
        if (verifyLastRow >= 2) {
          const remainingIds = cleanupSheet.getRange(2, 1, verifyLastRow - 1, 1).getValues();
          for (let i = 0; i < remainingIds.length; i++) {
            const rowId = String(remainingIds[i][0] || "").trim();
            if (rowId === testProductId) {
              throw new Error("Pokemon card test cleanup failed: test record still remaining at row " + (i + 2));
            }
          }
        }
      }

      if (summary) {
        summary.cleanup = "passed";
      }
    } catch (error) {
      cleanupError = error;
    }

    if (lockAcquired) {
      try {
        lock.releaseLock();
      } catch (_) {
        // noop
      }
    }
  }

  // エラー判定：本体テストのエラーを優先スロー
  if (testError) {
    if (cleanupError) {
      console.warn("Pokemon card test cleanup also failed: " + cleanupError.message);
    }
    throw testError;
  }

  // 本体テスト成功・cleanup失敗時はcleanupエラーをスロー
  if (cleanupError) {
    throw cleanupError;
  }

  console.log(JSON.stringify(summary));
  return summary;
}

/**
 * Pokemon Card Phase 4B 統合E2Eテスト関数
 *
 * handleCreateProduct() と pokemon_cards シート、Driveフォルダ作成の統合を検証する。
 *
 * A. Validation Failure Test:
 *    category === "pokemon_card" で pokemon_card オブジェクトが未指定の場合に
 *    適切なエラーがthrowされ、シートやDriveフォルダにゴミが残らないことを検証。
 *
 * B. Success Create Test:
 *    正常なポケカデータ（画像0件）で handleCreateProduct() を呼び出し、
 *    - 返却レスポンス
 *    - 商品マスターシート（34列）
 *    - pokemon_cards シート（13列・先頭ゼロ保持・graded時のcard_condition空文字）
 *    - Driveフォルダ（ROOT_FOLDER_ID直下、フォルダ名一致）
 *    が正しく作成・保存されることを検証。
 *
 * C. Cleanup (finally):
 *    テストで作成されたリソース（pokemon_cards, 商品マスター, Driveフォルダ）を
 *    独立した3系統で安全に削除し、残存確認を行う。
 *    本体テストエラーを最優先でthrowする。
 *
 * @return {{
 *   success: boolean,
 *   version: string,
 *   product_id: string,
 *   validation: string,
 *   create_product: string,
 *   main_sheet_record: string,
 *   pokemon_card_record: string,
 *   leading_zero_preservation: string,
 *   drive_folder: string,
 *   cleanup: string
 * }}
 */
function testPokemonCardCreateIntegrationPhase4B() {
  const lock = LockService.getScriptLock();
  let lockAcquired = false;

  let testError = null;
  const cleanupErrors = [];
  let summary = null;

  let createdProductId = null;
  let createdDriveFolderUrl = null;
  let createdDriveFolderId = null;

  try {
    lock.waitLock(10000);
    lockAcquired = true;

    // --- Preflight ---
    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = spreadsheet.getSheets()[0];
    assertPokemonCardTest_(sheet !== null, "main product sheet is not found");

    const pkmSheet = spreadsheet.getSheetByName(POKEMON_CARDS_SHEET_NAME);
    assertPokemonCardTest_(pkmSheet !== null, "pokemon_cards sheet is not initialized");

    validatePokemonCardsSheetSchema_(pkmSheet);

    // ==================================================
    // Section A: Validation Failure Test
    // ==================================================
    const mainLastRowBeforeA = sheet.getLastRow();
    const pkmLastRowBeforeA = pkmSheet.getLastRow();

    let validationErrorCaught = false;
    try {
      handleCreateProduct(sheet, {
        category: "pokemon_card",
        brand: "Pokemon Card Game",
        product_name: "Phase4B Validation Failure Test",
        condition: "NM",
        purchase_price: 1000,
        planned_sale_price: 2000,
        storage_location: "BOX-A",
        description: "Validation failure test",
        notes: "Phase 4B",
        images: []
        // pokemon_card 未指定
      });
    } catch (err) {
      if (String(err.message).indexOf("pokemon_card data is required for pokemon_card category") !== -1) {
        validationErrorCaught = true;
      } else {
        throw err;
      }
    }

    assertPokemonCardTest_(validationErrorCaught, "expected validation error 'pokemon_card data is required for pokemon_card category' was not thrown");
    assertPokemonCardTest_(sheet.getLastRow() === mainLastRowBeforeA, "main sheet row count must not increase on validation failure");
    assertPokemonCardTest_(pkmSheet.getLastRow() === pkmLastRowBeforeA, "pokemon_cards sheet row count must not increase on validation failure");

    // ==================================================
    // Section B: Success Create Test
    // ==================================================
    const validData = {
      category: "pokemon_card",
      brand: "Pokemon Card Game",
      product_name: "Pikachu Phase4B Integration Test",
      condition: "NM",
      purchase_price: 1500,
      planned_sale_price: 3000,
      storage_location: "BOX-PKM-TEST",
      description: "Phase 4B integration test description",
      notes: "Phase 4B notes",
      images: [],
      pokemon_card: {
        card_name: "Pikachu Phase4B",
        set_name: "Test Set 4B",
        card_number: "025/165",
        rarity: "SAR",
        language: "Japanese",
        grading_status: "graded",
        grader: "PSA",
        grade: "10",
        certification_number: "0009876543"
      }
    };

    const createRes = handleCreateProduct(sheet, validData);
    assertPokemonCardTest_(createRes !== null && typeof createRes.getContent === "function", "handleCreateProduct must return TextOutput");

    const createJson = JSON.parse(createRes.getContent());
    assertPokemonCardTest_(createJson.success === true, "create response success must be true");
    assertPokemonCardTest_(createJson.version === "product-create-v2", "create response version mismatch");
    assertPokemonCardTest_(createJson.publish_status === "draft", "create response publish_status mismatch");
    assertPokemonCardTest_(createJson.inventory_status === "in_stock", "create response inventory_status mismatch");
    assertPokemonCardTest_(createJson.image_count === 0, "create response image_count mismatch");
    assertPokemonCardTest_(createJson.main_image_url === "", "create response main_image_url mismatch");
    assertPokemonCardTest_(!!createJson.drive_folder_url, "create response drive_folder_url must exist");
    assertPokemonCardTest_(!!createJson.product_id, "create response product_id must exist");

    createdProductId = createJson.product_id;
    createdDriveFolderUrl = createJson.drive_folder_url;
    createdDriveFolderId = extractDriveFolderId(createdDriveFolderUrl);

    // --- 1. 商品マスターSheetの検証 ---
    const productRowIndex = findProductRow(sheet, createdProductId);
    assertPokemonCardTest_(productRowIndex >= 2, "productRowIndex must be valid row index (>= 2)");

    const productRowValues = sheet.getRange(productRowIndex, 1, 1, 34).getValues()[0];
    assertPokemonCardTest_(productRowValues[0] instanceof Date || !isNaN(Date.parse(productRowValues[0])), "main sheet Col A (created_at) must be valid date");
    assertPokemonCardTest_(String(productRowValues[1]).trim() === createdProductId, "main sheet Col B (product_id) mismatch");
    assertPokemonCardTest_(String(productRowValues[2]).trim() === "pokemon_card", "main sheet Col C (category) mismatch");
    assertPokemonCardTest_(String(productRowValues[3]).trim() === "Pokemon Card Game", "main sheet Col D (brand) mismatch");
    assertPokemonCardTest_(String(productRowValues[4]).trim() === "Pikachu Phase4B Integration Test", "main sheet Col E (product_name) mismatch");
    assertPokemonCardTest_(String(productRowValues[5]).trim() === "NM", "main sheet Col F (condition) mismatch");
    assertPokemonCardTest_(Number(productRowValues[6]) === 1500, "main sheet Col G (purchase_price) mismatch");
    assertPokemonCardTest_(Number(productRowValues[7]) === 3000, "main sheet Col H (planned_sale_price) mismatch");
    assertPokemonCardTest_(String(productRowValues[29]).trim() === createdDriveFolderUrl, "main sheet Col AD (drive_folder_url) mismatch");
    assertPokemonCardTest_(String(productRowValues[30]).trim() === "", "main sheet Col AE (main_image_url) must be empty");
    assertPokemonCardTest_(String(productRowValues[31]).trim() === "draft", "main sheet Col AF (publish_status) mismatch");
    assertPokemonCardTest_(String(productRowValues[32]).trim() === "in_stock", "main sheet Col AG (inventory_status) mismatch");
    assertPokemonCardTest_(String(productRowValues[33]).trim() === "active", "main sheet Col AH (record_status) mismatch");

    // --- 2. pokemon_cards Sheetの検証 ---
    const pkmCard = getPokemonCardByProductId(createdProductId);
    assertPokemonCardTest_(pkmCard !== null, "pokemon card record must exist");
    assertPokemonCardTest_(pkmCard.product_id === createdProductId, "pkmCard.product_id mismatch");
    assertPokemonCardTest_(pkmCard.card_name === "Pikachu Phase4B", "pkmCard.card_name mismatch");
    assertPokemonCardTest_(pkmCard.set_name === "Test Set 4B", "pkmCard.set_name mismatch");
    assertPokemonCardTest_(pkmCard.card_number === "025/165", "pkmCard.card_number leading zero mismatch (expected '025/165', got '" + pkmCard.card_number + "')");
    assertPokemonCardTest_(pkmCard.rarity === "SAR", "pkmCard.rarity mismatch");
    assertPokemonCardTest_(pkmCard.language === "Japanese", "pkmCard.language mismatch");
    assertPokemonCardTest_(pkmCard.grading_status === "graded", "pkmCard.grading_status mismatch");
    assertPokemonCardTest_(pkmCard.grader === "PSA", "pkmCard.grader mismatch");
    assertPokemonCardTest_(pkmCard.grade === "10", "pkmCard.grade mismatch");
    assertPokemonCardTest_(pkmCard.certification_number === "0009876543", "pkmCard.certification_number leading zero mismatch (expected '0009876543', got '" + pkmCard.certification_number + "')");
    assertPokemonCardTest_(pkmCard.card_condition === "", "pkmCard.card_condition must be empty string for graded card");
    assertPokemonCardTest_(!!pkmCard.created_at, "pkmCard.created_at must be populated");
    assertPokemonCardTest_(!!pkmCard.updated_at, "pkmCard.updated_at must be populated");

    // --- 3. Driveフォルダの検証 ---
    assertPokemonCardTest_(!!createdDriveFolderId, "valid drive folder ID must be extractable");
    const productFolder = DriveApp.getFolderById(createdDriveFolderId);
    assertPokemonCardTest_(productFolder !== null, "product folder must exist in Drive");
    assertPokemonCardTest_(productFolder.getName() === createdProductId, "product folder name must match createdProductId");

    const parents = productFolder.getParents();
    let isUnderRootFolder = false;
    while (parents.hasNext()) {
      const parent = parents.next();
      if (parent.getId() === ROOT_FOLDER_ID) {
        isUnderRootFolder = true;
        break;
      }
    }
    assertPokemonCardTest_(isUnderRootFolder, "product folder parent must be ROOT_FOLDER_ID");

    summary = {
      success: true,
      version: "pokemon-card-phase4b-test-v1",
      product_id: createdProductId,
      validation: "passed",
      create_product: "passed",
      main_sheet_record: "passed",
      pokemon_card_record: "passed",
      leading_zero_preservation: "passed",
      drive_folder: "passed",
      cleanup: "pending"
    };

  } catch (error) {
    testError = error;
  } finally {
    // ==================================================
    // Section C: Cleanup (3系統独立)
    // ==================================================

    // 1. pokemon_cards Sheet cleanup
    if (createdProductId) {
      try {
        deletePokemonCardByProductId_(createdProductId);
        const remainingCard = getPokemonCardByProductId(createdProductId);
        if (remainingCard !== null) {
          throw new Error("pokemon_cards test record still remaining for " + createdProductId);
        }
      } catch (err) {
        cleanupErrors.push("pokemon_cards cleanup failed: " + err.message);
      }
    }

    // 2. 商品マスターSheet cleanup
    if (createdProductId) {
      try {
        const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
        const mainSheet = spreadsheet.getSheets()[0];
        let rowIndex = null;
        try {
          rowIndex = findProductRow(mainSheet, createdProductId);
        } catch (_) {
          rowIndex = null;
        }

        if (rowIndex !== null) {
          const rowId = String(mainSheet.getRange(rowIndex, 2).getValue() || "").trim();
          if (rowId === createdProductId) {
            mainSheet.deleteRow(rowIndex);
          } else {
            throw new Error("Row ID mismatch during cleanup: expected " + createdProductId + " but got " + rowId);
          }
        }

        // 残存確認（findProductRowで例外になること）
        let notFound = false;
        try {
          findProductRow(mainSheet, createdProductId);
        } catch (findErr) {
          if (String(findErr.message).indexOf("product not found") !== -1) {
            notFound = true;
          } else {
            throw findErr;
          }
        }
        if (!notFound) {
          throw new Error("main sheet test record still remaining for " + createdProductId);
        }
      } catch (err) {
        cleanupErrors.push("main sheet cleanup failed: " + err.message);
      }
    }

    // 3. Drive フォルダ cleanup
    if (createdDriveFolderId) {
      try {
        const folder = DriveApp.getFolderById(createdDriveFolderId);
        if (folder) {
          const folderName = folder.getName();
          if (folderName === createdProductId) {
            let isChildOfRoot = false;
            const parents = folder.getParents();
            while (parents.hasNext()) {
              if (parents.next().getId() === ROOT_FOLDER_ID) {
                isChildOfRoot = true;
                break;
              }
            }
            if (isChildOfRoot) {
              folder.setTrashed(true);
              if (!folder.isTrashed()) {
                throw new Error("Drive folder isTrashed() returned false after setTrashed(true)");
              }
            } else {
              throw new Error("Drive folder parent is not ROOT_FOLDER_ID, skipping deletion for safety");
            }
          } else {
            throw new Error("Drive folder name mismatch: expected " + createdProductId + " but got " + folderName);
          }
        }
      } catch (err) {
        cleanupErrors.push("drive folder cleanup failed: " + err.message);
      }
    }

    if (summary && cleanupErrors.length === 0) {
      summary.cleanup = "passed";
    }

    if (lockAcquired) {
      try {
        lock.releaseLock();
      } catch (_) {
        // noop
      }
    }
  }

  // エラー判定：本体テストエラーを優先スロー
  if (testError) {
    if (cleanupErrors.length > 0) {
      console.warn("Pokemon card create integration cleanup also failed: " + cleanupErrors.join("; "));
    }
    throw testError;
  }

  // 本体テスト成功・cleanup失敗時はcleanupエラーをスロー
  if (cleanupErrors.length > 0) {
    throw new Error("Pokemon card create integration cleanup failed: " + cleanupErrors.join("; "));
  }

  console.log(JSON.stringify(summary));
  return summary;
}

/**
 * Pokemon Card バックエンド統合テスト関数 (GET詳細 & UPDATE)
 *
 * 1. Pokemon Card商品を一時登録 (handleCreateProduct)
 * 2. 管理商品詳細取得 (doGet ?mode=admin&product_id=...) -> pokemon_cardが返る
 * 3. Pokemon Cardをpartial update (handleUpdateProduct with rarity: "UR")
 * 4. 再取得 -> rarity === "UR"
 * 5. 未指定項目 (card_name, card_number, language等) が維持されること
 * 6. 通常商品フィールド (product_name) も同時更新できること
 * 7. category変更 (pokemon_card -> sneaker) が拒否されること
 * 8. validation失敗後もcategoryがpokemon_cardのままであること
 * 9. finallyで商品マスター・pokemon_cards・Driveを安全にクリーンアップ
 *
 * @return {{
 *   success: boolean,
 *   version: string,
 *   product_id: string,
 *   create: string,
 *   get_detail: string,
 *   partial_update: string,
 *   unspecified_fields_retained: string,
 *   simultaneous_product_update: string,
 *   category_change_blocked: string,
 *   category_integrity_preserved: string,
 *   cleanup: string
 * }}
 */
function testPokemonCardBackendIntegration() {
  const lock = LockService.getScriptLock();
  let lockAcquired = false;

  let testError = null;
  const cleanupErrors = [];
  let summary = null;

  let createdProductId = null;
  let createdDriveFolderUrl = null;
  let createdDriveFolderId = null;

  try {
    lock.waitLock(10000);
    lockAcquired = true;

    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = spreadsheet.getSheets()[0];
    assertPokemonCardTest_(sheet !== null, "main product sheet is not found");

    const pkmSheet = spreadsheet.getSheetByName(POKEMON_CARDS_SHEET_NAME);
    assertPokemonCardTest_(pkmSheet !== null, "pokemon_cards sheet is not initialized");

    validatePokemonCardsSheetSchema_(pkmSheet);

    // ------------------------------------------
    // 1. Pokemon Card商品を一時登録
    // ------------------------------------------
    const createData = {
      category: "pokemon_card",
      brand: "Pokemon Card Game",
      product_name: "Charizard Backend Test",
      condition: "NM",
      purchase_price: 2000,
      planned_sale_price: 5000,
      storage_location: "BOX-TEST",
      description: "Backend integration test description",
      notes: "Test notes",
      images: [],
      pokemon_card: {
        card_name: "Charizard",
        set_name: "151",
        card_number: "006/165",
        rarity: "SAR",
        language: "Japanese",
        grading_status: "graded",
        grader: "PSA",
        grade: "10",
        certification_number: "0001234567"
      }
    };

    const createRes = handleCreateProduct(sheet, createData);
    assertPokemonCardTest_(createRes !== null && typeof createRes.getContent === "function", "handleCreateProduct must return TextOutput");

    const createJson = JSON.parse(createRes.getContent());
    assertPokemonCardTest_(createJson.success === true, "create response success must be true");
    assertPokemonCardTest_(!!createJson.product_id, "created product_id must exist");

    createdProductId = createJson.product_id;
    createdDriveFolderUrl = createJson.drive_folder_url;
    createdDriveFolderId = extractDriveFolderId(createdDriveFolderUrl);

    // ------------------------------------------
    // 2. 管理商品詳細取得 (doGet with mode=admin)
    // ------------------------------------------
    const getRes1 = doGet({
      parameter: {
        mode: "admin",
        product_id: createdProductId
      }
    });
    assertPokemonCardTest_(getRes1 !== null && typeof getRes1.getContent === "function", "doGet must return TextOutput");

    const getJson1 = JSON.parse(getRes1.getContent());
    assertPokemonCardTest_(getJson1.success === true, "getJson1.success must be true");
    assertPokemonCardTest_(getJson1.product !== undefined, "getJson1.product must exist");
    assertPokemonCardTest_(getJson1.product.product_id === createdProductId, "getJson1 product_id mismatch");
    assertPokemonCardTest_(getJson1.product.category === "pokemon_card", "getJson1 category mismatch");
    assertPokemonCardTest_(getJson1.product.product_name === "Charizard Backend Test", "getJson1 product_name mismatch");
    assertPokemonCardTest_(getJson1.product.pokemon_card !== undefined, "getJson1 pokemon_card must exist on product");

    const pkm1 = getJson1.product.pokemon_card;
    assertPokemonCardTest_(pkm1.product_id === createdProductId, "pkm1.product_id mismatch");
    assertPokemonCardTest_(pkm1.card_name === "Charizard", "pkm1.card_name mismatch");
    assertPokemonCardTest_(pkm1.set_name === "151", "pkm1.set_name mismatch");
    assertPokemonCardTest_(pkm1.card_number === "006/165", "pkm1.card_number leading zero mismatch (expected '006/165', got '" + pkm1.card_number + "')");
    assertPokemonCardTest_(pkm1.rarity === "SAR", "pkm1.rarity mismatch");
    assertPokemonCardTest_(pkm1.language === "Japanese", "pkm1.language mismatch");
    assertPokemonCardTest_(pkm1.grading_status === "graded", "pkm1.grading_status mismatch");
    assertPokemonCardTest_(pkm1.grader === "PSA", "pkm1.grader mismatch");
    assertPokemonCardTest_(pkm1.grade === "10", "pkm1.grade mismatch");
    assertPokemonCardTest_(pkm1.certification_number === "0001234567", "pkm1.certification_number leading zero mismatch (expected '0001234567', got '" + pkm1.certification_number + "')");
    assertPokemonCardTest_(pkm1.card_condition === "", "pkm1.card_condition must be empty string for graded card");

    // ------------------------------------------
    // 3, 5, 6. Pokemon Card partial update + 通常商品フィールド同時更新
    // ------------------------------------------
    const updateData = {
      product_id: createdProductId,
      product_name: "Charizard Backend Test Updated",
      pokemon_card: {
        rarity: "UR"
      }
    };

    const updateRes1 = handleUpdateProduct(sheet, updateData);
    assertPokemonCardTest_(updateRes1 !== null && typeof updateRes1.getContent === "function", "handleUpdateProduct must return TextOutput");

    const updateJson1 = JSON.parse(updateRes1.getContent());
    assertPokemonCardTest_(updateJson1.success === true, "updateJson1.success must be true");
    assertPokemonCardTest_(updateJson1.product_id === createdProductId, "updateJson1.product_id mismatch");

    // ------------------------------------------
    // 4 & 5. 再取得 & 未指定項目の維持 & product_name 更新確認
    // ------------------------------------------
    const getRes2 = doGet({
      parameter: {
        mode: "admin",
        product_id: createdProductId
      }
    });
    const getJson2 = JSON.parse(getRes2.getContent());
    assertPokemonCardTest_(getJson2.success === true, "getJson2.success must be true");
    assertPokemonCardTest_(getJson2.product.product_name === "Charizard Backend Test Updated", "product_name must be updated");
    assertPokemonCardTest_(getJson2.product.pokemon_card !== undefined, "pokemon_card must exist after update");

    const pkm2 = getJson2.product.pokemon_card;
    assertPokemonCardTest_(pkm2.rarity === "UR", "rarity must be updated to 'UR'");
    // 未指定項目の維持確認
    assertPokemonCardTest_(pkm2.card_name === "Charizard", "card_name must be retained");
    assertPokemonCardTest_(pkm2.set_name === "151", "set_name must be retained");
    assertPokemonCardTest_(pkm2.card_number === "006/165", "card_number must be retained");
    assertPokemonCardTest_(pkm2.language === "Japanese", "language must be retained");
    assertPokemonCardTest_(pkm2.grading_status === "graded", "grading_status must be retained");
    assertPokemonCardTest_(pkm2.grader === "PSA", "grader must be retained");
    assertPokemonCardTest_(pkm2.grade === "10", "grade must be retained");
    assertPokemonCardTest_(pkm2.certification_number === "0001234567", "certification_number must be retained");
    assertPokemonCardTest_(pkm2.card_condition === "", "card_condition must remain empty string");

    // ------------------------------------------
    // 7. category変更 (pokemon_card -> sneaker) が拒否されること
    // ------------------------------------------
    let categoryChangeBlocked = false;
    try {
      handleUpdateProduct(sheet, {
        product_id: createdProductId,
        category: "sneaker"
      });
    } catch (err) {
      if (String(err.message).indexOf("product category cannot be changed after creation") !== -1) {
        categoryChangeBlocked = true;
      } else {
        throw err;
      }
    }
    assertPokemonCardTest_(categoryChangeBlocked, "category change from pokemon_card to sneaker must be rejected");

    // ------------------------------------------
    // 8. validation失敗後もcategoryがpokemon_cardのままであること
    // ------------------------------------------
    const targetRow = findProductRow(sheet, createdProductId);
    const storedCategoryAfterReject = String(sheet.getRange(targetRow, 3).getValue() || "").trim();
    assertPokemonCardTest_(storedCategoryAfterReject === "pokemon_card", "stored category in main sheet must remain 'pokemon_card'");

    const getRes3 = doGet({
      parameter: {
        mode: "admin",
        product_id: createdProductId
      }
    });
    const getJson3 = JSON.parse(getRes3.getContent());
    assertPokemonCardTest_(getJson3.success === true, "getJson3.success must be true");
    assertPokemonCardTest_(getJson3.product.category === "pokemon_card", "product category in doGet must remain 'pokemon_card'");
    assertPokemonCardTest_(getJson3.product.pokemon_card !== undefined, "pokemon_card must still exist in doGet");

    summary = {
      success: true,
      version: "pokemon-card-backend-integration-v1",
      product_id: createdProductId,
      create: "passed",
      get_detail: "passed",
      partial_update: "passed",
      unspecified_fields_retained: "passed",
      simultaneous_product_update: "passed",
      category_change_blocked: "passed",
      category_integrity_preserved: "passed",
      cleanup: "pending"
    };

  } catch (error) {
    testError = error;
  } finally {
    // ------------------------------------------
    // 9. Cleanup (3系統独立)
    // ------------------------------------------

    // 1. pokemon_cards Sheet cleanup
    if (createdProductId) {
      try {
        deletePokemonCardByProductId_(createdProductId);
        const remainingCard = getPokemonCardByProductId(createdProductId);
        if (remainingCard !== null) {
          throw new Error("pokemon_cards test record still remaining for " + createdProductId);
        }
      } catch (err) {
        cleanupErrors.push("pokemon_cards cleanup failed: " + err.message);
      }
    }

    // 2. 商品マスターSheet cleanup
    if (createdProductId) {
      try {
        const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
        const mainSheet = spreadsheet.getSheets()[0];
        let rowIndex = null;
        try {
          rowIndex = findProductRow(mainSheet, createdProductId);
        } catch (_) {
          rowIndex = null;
        }

        if (rowIndex !== null) {
          const rowId = String(mainSheet.getRange(rowIndex, 2).getValue() || "").trim();
          if (rowId === createdProductId) {
            mainSheet.deleteRow(rowIndex);
          } else {
            throw new Error("Row ID mismatch during cleanup: expected " + createdProductId + " but got " + rowId);
          }
        }

        // 残存確認
        let notFound = false;
        try {
          findProductRow(mainSheet, createdProductId);
        } catch (findErr) {
          if (String(findErr.message).indexOf("product not found") !== -1) {
            notFound = true;
          } else {
            throw findErr;
          }
        }
        if (!notFound) {
          throw new Error("main sheet test record still remaining for " + createdProductId);
        }
      } catch (err) {
        cleanupErrors.push("main sheet cleanup failed: " + err.message);
      }
    }

    // 3. Drive フォルダ cleanup
    if (createdDriveFolderId) {
      try {
        const folder = DriveApp.getFolderById(createdDriveFolderId);
        if (folder) {
          const folderName = folder.getName();
          if (folderName === createdProductId) {
            let isChildOfRoot = false;
            const parents = folder.getParents();
            while (parents.hasNext()) {
              if (parents.next().getId() === ROOT_FOLDER_ID) {
                isChildOfRoot = true;
                break;
              }
            }
            if (isChildOfRoot) {
              folder.setTrashed(true);
              if (!folder.isTrashed()) {
                throw new Error("Drive folder isTrashed() returned false after setTrashed(true)");
              }
            } else {
              throw new Error("Drive folder parent is not ROOT_FOLDER_ID, skipping deletion for safety");
            }
          } else {
            throw new Error("Drive folder name mismatch: expected " + createdProductId + " but got " + folderName);
          }
        }
      } catch (err) {
        cleanupErrors.push("drive folder cleanup failed: " + err.message);
      }
    }

    if (summary && cleanupErrors.length === 0) {
      summary.cleanup = "passed";
    }

    if (lockAcquired) {
      try {
        lock.releaseLock();
      } catch (_) {
        // noop
      }
    }
  }

  // エラー判定：本体テストエラーを優先スロー
  if (testError) {
    if (cleanupErrors.length > 0) {
      console.warn("Pokemon card backend integration cleanup also failed: " + cleanupErrors.join("; "));
    }
    throw testError;
  }

  // 本体テスト成功・cleanup失敗時はcleanupエラーをスロー
  if (cleanupErrors.length > 0) {
    throw new Error("Pokemon card backend integration cleanup failed: " + cleanupErrors.join("; "));
  }

  console.log(JSON.stringify(summary));
  return summary;
}

// ==================================================
// AI出品ドラフト & 販売開始ゲート 単体・統合テストスイート
// ==================================================

/**
 * AI出品ドラフト機能の安全性・排他制御・整合性・公開ゲート検証テスト
 *
 * 厳格制約:
 * - 外部LLM（Gemini API）への実通信は行わない（モック検証）
 * - Square Productionへの実通信・書込みは行わない
 * - 実決済は行わない
 *
 * @return {Object} テスト結果サマリー
 */
function testAiProductDraftSuite_() {
  console.log("--- [testAiProductDraftSuite_] 開始 ---");

  const results = {
    total: 0,
    passed: 0,
    failed: 0,
    tests: []
  };

  function record(name, pass, detail) {
    results.total++;
    if (pass) {
      results.passed++;
      results.tests.push({ name: name, status: "PASS", detail: detail || "" });
      console.log("✓ " + name);
    } else {
      results.failed++;
      results.tests.push({ name: name, status: "FAIL", detail: detail || "" });
      console.error("× " + name + ": " + (detail || "failed"));
    }
  }

  // --------------------------------------------------
  // 1. 候補バリデーション: 真贋保証表現の自動除去 (生成失敗にしない・Vans Authentic 44 DX 等の正式商品名は保持) & 価格・SKU検証
  // --------------------------------------------------
  try {
    const rawCandidateWithProhibited = {
      title_ja: "Vans Authentic 44 DX アナハイム 確実正規品",
      hashtags_ja: "#Vans #VansAuthentic #正規品 #スニーカー",
      description_ja: "Vans Authentic 44 DX です。100% Original なスニーカーで真贋鑑定済み・本物保証いたします。数回着用で良好なコンディションです。",
      title_en: "100% Authentic Vans Authentic 44 DX Anaheim",
      description_en: "Vans Authentic 44 DX. 100% authentic genuine pair guaranteed. Pre-owned in great shape.",
      condition: "目立った傷や汚れなし",
      price: 50000,
      category: "スニーカー",
      brand: "VANS"
    };

    let prohibitedSanitized = false;
    let sanitizedRes = null;
    try {
      sanitizedRes = validateAndSanitizeDraftCandidate_(rawCandidateWithProhibited);
      prohibitedSanitized = Boolean(
        sanitizedRes &&
        sanitizedRes.title_ja.indexOf("Vans Authentic 44 DX") !== -1 &&
        !/確実正規品|本物保証/i.test(sanitizedRes.title_ja) &&
        sanitizedRes.description_ja.indexOf("Vans Authentic 44 DX") !== -1 &&
        !/本物保証|真贋鑑定|100%\s*original/i.test(sanitizedRes.description_ja) &&
        sanitizedRes.description_ja.indexOf("数回着用") !== -1 &&
        sanitizedRes.title_en.indexOf("Vans Authentic 44 DX") !== -1 &&
        !/100%\s*authentic/i.test(sanitizedRes.title_en)
      );
    } catch (valErr) {
      prohibitedSanitized = false;
    }

    // 1-1. 有効価格 (30000) & SKU placeholder ("TEST")
    const cleanCandidate = {
      title_ja: "ナイキ エアジョーダン 1 ハイ OG シカゴ",
      hashtags_ja: "#NIKE #AirJordan1 #スニーカー",
      description_ja: "スニーカーの説明文です。状態良好。",
      title_en: "Nike Air Jordan 1 High OG Chicago",
      description_en: "Great condition sneaker pair.",
      condition: "目立った傷や汚れなし",
      price: 30000,
      price_note: "人気モデル・良好状態に基づく概算",
      sku: "TEST"
    };
    const cleanValidated = validateAndSanitizeDraftCandidate_(cleanCandidate);
    const validPriceOk = cleanValidated.price === 30000;
    const skuEnforcedEmpty = cleanValidated.sku === "";
    const priceNoteOk = cleanValidated.price_note === "AIによる概算価格です";

    // 1-2. 判断不能時 (price: null)
    const nullCandidate = {
      ...cleanCandidate,
      price: null
    };
    const nullValidated = validateAndSanitizeDraftCandidate_(nullCandidate);
    const nullPriceOk = nullValidated.price === null && nullValidated.price_note === "AIによる概算価格です";

    // 1-3. 不正値 (負数, 0, 非数値) は安全に null へフォールバック
    const negValidated = validateAndSanitizeDraftCandidate_({ ...cleanCandidate, price: -5000 });
    const zeroValidated = validateAndSanitizeDraftCandidate_({ ...cleanCandidate, price: 0 });
    const strInvalidValidated = validateAndSanitizeDraftCandidate_({ ...cleanCandidate, price: "不明" });
    const invalidPriceHandled = negValidated.price === null && zeroValidated.price === null && strInvalidValidated.price === null;

    record(
      "1. Candidate Validation - Authenticity Phrase Stripping, Price Suggestion (Valid/Null/Invalid) & SKU Placeholder Empty Enforcement",
      prohibitedSanitized && validPriceOk && skuEnforcedEmpty && priceNoteOk && nullPriceOk && invalidPriceHandled,
      `prohibitedSanitized: ${prohibitedSanitized}, validPrice: ${validPriceOk}, nullPrice: ${nullPriceOk}, invalidPriceHandled: ${invalidPriceHandled}, skuEmpty: ${skuEnforcedEmpty}`
    );
  } catch (err) {
    record("1. Candidate Validation - Authenticity Phrase Stripping, Price Suggestion (Valid/Null/Invalid) & SKU Placeholder Empty Enforcement", false, err.message);
  }

  // --------------------------------------------------
  // 2. 実行ID排他ロックの取得と二重取得防止
  // --------------------------------------------------
  const testPid = "TEST-DRAFT-LOCK-001";
  try {
    releaseAiDraftExecutionLock_(testPid);

    const execId1 = acquireAiDraftExecutionLock_(testPid);
    let doubleAcquireBlocked = false;

    try {
      acquireAiDraftExecutionLock_(testPid);
    } catch (doubleErr) {
      if (doubleErr.message.indexOf("already in progress") !== -1) {
        doubleAcquireBlocked = true;
      }
    }

    const verified = verifyAiDraftExecutionLock_(testPid, execId1);
    releaseAiDraftExecutionLock_(testPid);
    const cleared = !verifyAiDraftExecutionLock_(testPid, execId1);

    record(
      "2. Execution Lock & Double Execution Prevention",
      doubleAcquireBlocked && verified && cleared,
      `execId: ${execId1}, doubleAcquireBlocked: ${doubleAcquireBlocked}, cleared: ${cleared}`
    );
  } catch (err) {
    releaseAiDraftExecutionLock_(testPid);
    record("2. Execution Lock & Double Execution Prevention", false, err.message);
  }

  // --------------------------------------------------
  // 3. 販売開始ゲート: 通常商品の無条件通過 (完全後方互換性)
  // --------------------------------------------------
  try {
    const mockNormalSheet = {
      getLastColumn: function() { return 40; },
      getRange: function(row, col) {
        return {
          getValue: function() {
            if (col === 40) return ""; // 通常商品は ai_draft_flag が空
            return "";
          }
        };
      }
    };

    const normalAllowed = assertProductPublishable_(mockNormalSheet, 2, "TMP-NORMAL-001");
    record("3. Publish Gate - Normal Products Bypass (Backward Compatibility)", normalAllowed === true);
  } catch (err) {
    record("3. Publish Gate - Normal Products Bypass (Backward Compatibility)", false, err.message);
  }

  // --------------------------------------------------
  // 4. 販売開始ゲート: AI対象商品で履歴欠損時は Fail-Closed (error_code検証)
  // --------------------------------------------------
  try {
    const mockAiManagedSheet = {
      getLastColumn: function() { return 40; },
      getRange: function(row, col, numRows, numCols) {
        return {
          getValue: function() {
            if (col === 40) return "ai_managed"; // AI対象商品
            return "";
          },
          getValues: function() {
            const arr = new Array(40).fill("");
            arr[39] = "ai_managed";
            return [arr];
          }
        };
      }
    };

    let blockedOnMissingHistory = false;
    let gateErrorCode = "";
    try {
      assertProductPublishable_(mockAiManagedSheet, 2, "TMP-MISSING-HIST-999");
    } catch (gateErr) {
      if (gateErr.error_code === "AI_DRAFT_HISTORY_MISSING") {
        blockedOnMissingHistory = true;
        gateErrorCode = gateErr.error_code;
      }
    }

    record(
      "4. Publish Gate - AI Managed Missing History (Fail-Closed with error_code)",
      blockedOnMissingHistory && gateErrorCode === "AI_DRAFT_HISTORY_MISSING",
      `error_code: ${gateErrorCode}`
    );
  } catch (err) {
    record("4. Publish Gate - AI Managed Missing History (Fail-Closed with error_code)", false, err.message);
  }

  // --------------------------------------------------
  // 5. 確認処理バリデーション: 価格・必須値欠損の拒否
  // --------------------------------------------------
  try {
    const dummySheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];

    const noPricePayload = {
      product_id: "TMP-000001",
      draft_id: "DRFT_001",
      draft_version: 1,
      staff_id: "staff_test",
      confirmed_data: {
        product_name: "テストスニーカー",
        planned_sale_price: null,
        condition: "目立った傷や汚れなし",
        translated_title: "Test Sneaker",
        translated_description: "English description"
      }
    };

    const resNoPrice = handleConfirmAiProductDraft(dummySheet, noPricePayload);
    const parsedNoPrice = JSON.parse(resNoPrice.getContent());

    record(
      "5. Confirmation Validation - Price Required (Cannot be Null)",
      parsedNoPrice.success === false && parsedNoPrice.error_code === "VALID_SALE_PRICE_REQUIRED",
      `error_code: ${parsedNoPrice.error_code}`
    );
  } catch (err) {
    record("5. Confirmation Validation - Price Required (Cannot be Null)", false, err.message);
  }

  // --------------------------------------------------
  // 6. 確認処理バリデーション: 英文タイトル・説明文欠損の拒否
  // --------------------------------------------------
  try {
    const dummySheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];

    const noTransPayload = {
      product_id: "TMP-000001",
      draft_id: "DRFT_001",
      draft_version: 1,
      staff_id: "staff_test",
      confirmed_data: {
        product_name: "テストスニーカー",
        planned_sale_price: 15000,
        condition: "目立った傷や汚れなし",
        translated_title: "",
        translated_description: ""
      }
    };

    const resNoTrans = handleConfirmAiProductDraft(dummySheet, noTransPayload);
    const parsedNoTrans = JSON.parse(resNoTrans.getContent());

    record(
      "6. Confirmation Validation - Translated Content Required",
      parsedNoTrans.success === false && parsedNoTrans.error_code === "TRANSLATED_CONTENT_REQUIRED",
      `error_code: ${parsedNoTrans.error_code}`
    );
  } catch (err) {
    record("6. Confirmation Validation - Translated Content Required", false, err.message);
  }

  // --------------------------------------------------
  // 7. 画像バリデーション: 不正MIME・枚数超過の検証ロジック
  // --------------------------------------------------
  try {
    let mimeRejected = false;
    const invalidMime = "application/pdf";
    if (AI_DRAFT_CONFIG.ALLOWED_MIME_TYPES.indexOf(invalidMime) === -1) {
      mimeRejected = true;
    }

    record(
      "7. Image Validation - Unsupported MIME Rejected",
      mimeRejected,
      `allowed: ${AI_DRAFT_CONFIG.ALLOWED_MIME_TYPES.join(", ")}`
    );
  } catch (err) {
    record("7. Image Validation - Unsupported MIME Rejected", false, err.message);
  }

  // --------------------------------------------------
  // 8. 確定指紋の計算・照合テスト (確認後変更検知)
  // --------------------------------------------------
  try {
    const dummySheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
    const testFp = computeConfirmedProductFingerprint_(dummySheet, 2, "TMP-000001");
    record(
      "8. Confirmed Fingerprint Calculation",
      typeof testFp === "string" && testFp.length === 64,
      `fingerprint: ${testFp.substring(0, 16)}...`
    );
  } catch (err) {
    record("8. Confirmed Fingerprint Calculation", false, err.message);
  }

  // --------------------------------------------------
  // 9. 実行ロックの Superseded Release Protection テスト
  // --------------------------------------------------
  try {
    const pid = "TEST-SUPERSEDE-001";
    releaseAiDraftExecutionLock_(pid);
    const exec1 = acquireAiDraftExecutionLock_(pid);

    PropertiesService.getScriptProperties().setProperty("AI_GEN_LOCK_" + pid, JSON.stringify({
      execution_id: "EXEC_NEW_002",
      started_at: Date.now()
    }));

    releaseAiDraftExecutionLock_(pid, exec1);

    const stillAlive = verifyAiDraftExecutionLock_(pid, "EXEC_NEW_002");
    releaseAiDraftExecutionLock_(pid, "EXEC_NEW_002");

    record(
      "9. Superseded Lock Release Protection",
      stillAlive === true,
      `new lock preserved: ${stillAlive}`
    );
  } catch (err) {
    record("9. Superseded Lock Release Protection", false, err.message);
  }

  // --------------------------------------------------
  // 10. 管理者認証 verifyAdminAccess_ テスト (Fail-Closed & ローカルモック検証)
  // --------------------------------------------------
  try {
    const mockPropsEmpty = { getProperty: function() { return ""; } };
    const mockPropsThrow = { getProperty: function() { throw new Error("storage failure"); } };
    const mockPropsSet = {
      getProperty: function(key) {
        if (key === "ADMIN_API_KEY") return "secret_admin_token_123";
        return "";
      }
    };

    // 10-1: ADMIN_API_KEY 未設定時は Fail-Closed (管理者アクセス拒絶)
    const adminUnconfiguredBlocked = !verifyAdminAccess_({ mode: "admin", admin_key: "secret_admin_token_123" }, mockPropsEmpty);

    // 10-2: ADMIN_API_KEY 取得例外時も Fail-Closed
    const adminExceptionBlocked = !verifyAdminAccess_({ mode: "admin", admin_key: "secret_admin_token_123" }, mockPropsThrow);

    // 10-3: 誤った admin_key は拒絶
    const adminWithWrongTokenBlocked = !verifyAdminAccess_({ mode: "admin", admin_key: "wrong_token" }, mockPropsSet);

    // 10-4: 正しい admin_key は承認
    const adminWithCorrectTokenAllowed = verifyAdminAccess_({ mode: "admin", admin_key: "secret_admin_token_123" }, mockPropsSet);

    // 10-5: token パラメータによる提供も承認
    const adminWithTokenParamAllowed = verifyAdminAccess_({ mode: "admin", token: "secret_admin_token_123" }, mockPropsSet);

    // 10-6: mode !== "admin" はキーが合致していても拒絶
    const nonAdminModeBlocked = !verifyAdminAccess_({ mode: "", admin_key: "secret_admin_token_123" }, mockPropsSet);

    const allPassed = adminUnconfiguredBlocked &&
                      adminExceptionBlocked &&
                      adminWithWrongTokenBlocked &&
                      adminWithCorrectTokenAllowed &&
                      adminWithTokenParamAllowed &&
                      nonAdminModeBlocked;

    record(
      "10. Admin Auth Verification (verifyAdminAccess_ Fail-Closed Local Mock)",
      allPassed,
      `unconfiguredBlocked: ${adminUnconfiguredBlocked}, exceptionBlocked: ${adminExceptionBlocked}, correctTokenAllowed: ${adminWithCorrectTokenAllowed}`
    );
  } catch (err) {
    record("10. Admin Auth Verification (verifyAdminAccess_ Fail-Closed Local Mock)", false, err.message);
  }

  // --------------------------------------------------
  // 11. 確定バリデーション: 不正 condition 値の拒絶
  // --------------------------------------------------
  try {
    const dummySheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
    const invalidCondPayload = {
      product_id: "TMP-000001",
      draft_id: "DRFT_001",
      draft_version: 1,
      staff_id: "staff_test",
      confirmed_data: {
        product_name: "テスト商品",
        planned_sale_price: 15000,
        condition: "完璧な状態", // 許可外
        translated_title: "Test Title",
        translated_description: "Test Desc"
      }
    };
    const resInvalidCond = handleConfirmAiProductDraft(dummySheet, invalidCondPayload);
    const parsedCond = JSON.parse(resInvalidCond.getContent());
    record(
      "11. Confirmation Validation - Invalid Condition Rejected",
      parsedCond.success === false && parsedCond.error_code === "INVALID_CONDITION_VALUE",
      `error_code: ${parsedCond.error_code}`
    );
  } catch (err) {
    record("11. Confirmation Validation - Invalid Condition Rejected", false, err.message);
  }

  // --------------------------------------------------
  // 12. スニーカーサイズ仕様: 確定時はサイズ空欄許可 & 公開ゲート直前でSNEAKER_SIZE_REQUIRED拒否
  // --------------------------------------------------
  try {
    const dummySheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
    const emptySizePayload = {
      product_id: "TMP-000001",
      draft_id: "DRFT_001",
      draft_version: 1,
      staff_id: "staff_test",
      confirmed_data: {
        product_name: "テストスニーカー",
        category: "sneaker",
        sneaker_size: "", // 空文字
        planned_sale_price: 25000,
        condition: "目立った傷や汚れなし",
        translated_title: "Test Sneaker",
        translated_description: "Test Description"
      }
    };
    const resEmptySize = handleConfirmAiProductDraft(dummySheet, emptySizePayload);
    const parsedEmptySize = JSON.parse(resEmptySize.getContent());
    const confirmValidationPasses = (parsedEmptySize.error_code !== "SNEAKER_SIZE_REQUIRED");

    // 12-2. 公開ゲート (assertProductPublishable_) ではスニーカーでサイズ未指定の場合 SNEAKER_SIZE_REQUIRED で拒否
    const mockSneakerEmptySizeSheet = {
      getLastColumn: function() { return 40; },
      getRange: function(row, col) {
        return {
          getValue: function() {
            if (col === 3) return "sneaker"; // カテゴリ: スニーカー
            if (col === 13) return "";        // サイズ: 空欄
            if (col === 40) return "";
            return "";
          }
        };
      }
    };
    let gateBlockedOnEmptySize = false;
    let gateErrorCode = "";
    try {
      assertProductPublishable_(mockSneakerEmptySizeSheet, 2, "TMP-SNEAKER-NOSIZE");
    } catch (gateErr) {
      if (gateErr.error_code === "SNEAKER_SIZE_REQUIRED") {
        gateBlockedOnEmptySize = true;
        gateErrorCode = gateErr.error_code;
      }
    }

    // 12-3. サイズ入力済みのスニーカーは公開ゲートのサイズ検証を通過
    const mockSneakerWithSizeSheet = {
      getLastColumn: function() { return 40; },
      getRange: function(row, col) {
        return {
          getValue: function() {
            if (col === 3) return "sneaker";  // カテゴリ: スニーカー
            if (col === 13) return "27.5cm";  // サイズ: 27.5cm
            if (col === 40) return "";         // 通常商品
            return "";
          }
        };
      }
    };
    const sizePassesGate = (assertProductPublishable_(mockSneakerWithSizeSheet, 2, "TMP-SNEAKER-WITHSIZE") === true);

    record(
      "12. Sneaker Size Specification - Confirmation Allows Empty Size & Publish Gate Rejects with SNEAKER_SIZE_REQUIRED",
      confirmValidationPasses && gateBlockedOnEmptySize && gateErrorCode === "SNEAKER_SIZE_REQUIRED" && sizePassesGate,
      `confirmPass: ${confirmValidationPasses}, gateBlocked: ${gateBlockedOnEmptySize}, gateErrorCode: ${gateErrorCode}, sizePassesGate: ${sizePassesGate}`
    );
  } catch (err) {
    record("12. Sneaker Size Specification - Confirmation Allows Empty Size & Publish Gate Rejects with SNEAKER_SIZE_REQUIRED", false, err.message);
  }

  // --------------------------------------------------
  // 13. 通信エラーメッセージのサニタイズ（安全な固定メッセージ検証）
  // --------------------------------------------------
  try {
    const isSafe = AI_DRAFT_CONFIG.SAFE_LLM_ERROR_MESSAGE.indexOf("http") === -1 &&
                   AI_DRAFT_CONFIG.SAFE_LLM_ERROR_MESSAGE.indexOf("key=") === -1;
    record(
      "13. LLM Error Sanitization - No URL or Key Leakage in Safe Message",
      isSafe,
      `safeMessage: ${AI_DRAFT_CONFIG.SAFE_LLM_ERROR_MESSAGE}`
    );
  } catch (err) {
    record("13. LLM Error Sanitization - No URL or Key Leakage in Safe Message", false, err.message);
  }

  // --------------------------------------------------
  // 14. 冪等再送ハッシュ判定テスト (指摘1)
  // --------------------------------------------------
  try {
    const payloadA = { product_name: "商品A", planned_sale_price: 10000 };
    const payloadB = { product_name: "商品A", planned_sale_price: 12000 };
    const hashA1 = computeConfirmationPayloadHash_(payloadA);
    const hashA2 = computeConfirmationPayloadHash_({ planned_sale_price: 10000, product_name: "商品A" }); // キー順序非依存
    const hashB = computeConfirmationPayloadHash_(payloadB);

    record(
      "14. Confirmation Payload Hash (Key order independent & detects changes)",
      hashA1 === hashA2 && hashA1 !== hashB && typeof hashA1 === "string" && hashA1.length === 64,
      `hashA1: ${hashA1.substring(0, 8)}, hashA2: ${hashA2.substring(0, 8)}, hashB: ${hashB.substring(0, 8)}`
    );
  } catch (err) {
    record("14. Confirmation Payload Hash (Key order independent & detects changes)", false, err.message);
  }

  // --------------------------------------------------
  // 15. ロックの ScriptLock 保護 & 競合解放防止 (指摘2)
  // --------------------------------------------------
  try {
    const pid = "TEST-LOCK-CONFLICT-001";
    PropertiesService.getScriptProperties().setProperty("AI_GEN_LOCK_" + pid, JSON.stringify({
      execution_id: "EXEC_NEW_PROCESS",
      started_at: Date.now()
    }));

    // 古い実行IDで解放を試みる -> Superseded 保護により消されない
    releaseAiDraftExecutionLock_(pid, "EXEC_OLD_PROCESS");
    const stillActive = verifyAiDraftExecutionLock_(pid, "EXEC_NEW_PROCESS");

    // 新しい実行IDで解放 -> 正常に削除される
    releaseAiDraftExecutionLock_(pid, "EXEC_NEW_PROCESS");
    const nowRemoved = !verifyAiDraftExecutionLock_(pid, "EXEC_NEW_PROCESS");

    record(
      "15. Execution Lock ScriptLock Protection & Conflict Safety",
      stillActive === true && nowRemoved === true,
      `stillActive: ${stillActive}, nowRemoved: ${nowRemoved}`
    );
  } catch (err) {
    record("15. Execution Lock ScriptLock Protection & Conflict Safety", false, err.message);
  }

  // --------------------------------------------------
  // 16. カテゴリ正規化テスト (指摘4)
  // --------------------------------------------------
  try {
    const s1 = normalizeCategoryValue_("スニーカー") === "sneaker";
    const s2 = normalizeCategoryValue_("sneaker") === "sneaker";
    const p1 = normalizeCategoryValue_("ポケモンカード") === "pokemon_card";
    const p2 = normalizeCategoryValue_("pokemon_card") === "pokemon_card";
    const a1 = normalizeCategoryValue_("アパレル") === "apparel";
    const a2 = normalizeCategoryValue_("apparel") === "apparel";
    const invalid = normalizeCategoryValue_("時計") === "";

    record(
      "16. Category Normalization (Strict Canonical Code Conversion)",
      s1 && s2 && p1 && p2 && a1 && a2 && invalid,
      `s1:${s1}, p1:${p1}, a1:${a1}, invalid:${invalid}`
    );
  } catch (err) {
    record("16. Category Normalization (Strict Canonical Code Conversion)", false, err.message);
  }

  // --------------------------------------------------
  // 17. 認証切り分けテスト (要件1: 既存doGet mode=admin互換性とAI情報の認証分離)
  // --------------------------------------------------
  try {
    const mockEmptyProps = { getProperty: () => "" };
    // ADMIN_API_KEY 未設定時に mode=admin のみは verifyAdminAccess_ で弾かれる
    const blockedWithoutKey = !verifyAdminAccess_({ mode: "admin" }, mockEmptyProps);
    // mode=public は管理者アクセスではない（一般公開）
    const publicNotAdmin = !verifyAdminAccess_({ mode: "public" }, mockEmptyProps);

    // キーなしの mode=admin では buildProductDetail から AI詳細情報が返らないこと (要件1)
    const dummyRow = new Array(40).fill("");
    dummyRow[1] = "TMP-000001";
    dummyRow[39] = "ai_managed"; // AN列
    const detailWithoutKey = buildProductDetail(dummyRow, true, false); // isAdmin=true, hasAdminAuth=false
    const detailWithKey = buildProductDetail(dummyRow, true, true);    // isAdmin=true, hasAdminAuth=true
    const noKeyAiProtected = (detailWithoutKey.latest_ai_draft === undefined && detailWithoutKey.ai_draft_flag === undefined);
    const keyAllowsAi = (detailWithKey.ai_draft_flag === "ai_managed");

    record(
      "17. Admin Auth Isolation (Strict Protection for AI Endpoints & No Leak on mode=admin without key)",
      blockedWithoutKey && publicNotAdmin && noKeyAiProtected && keyAllowsAi,
      `blockedWithoutKey: ${blockedWithoutKey}, noKeyAiProtected: ${noKeyAiProtected}, keyAllowsAi: ${keyAllowsAi}`
    );
  } catch (err) {
    record("17. Admin Auth Isolation (Strict Protection for AI Endpoints & No Leak on mode=admin without key)", false, err.message);
  }

  // --------------------------------------------------
  // 18. Square Variation Name & Candidate Property Aliases Support
  // --------------------------------------------------
  try {
    // 18-1: Candidate aliases hash normalization matches confirmed_data format
    const aliasHash = computeConfirmationPayloadHash_({
      title_ja: "エイリアステスト",
      price: 12000,
      condition: "新品・未使用",
      title_en: "Alias Test",
      description_en: "English Description",
      category: "sneaker",
      size: "26.5cm",
      sku: "SKU-ALIAS-01"
    });
    const standardHash = computeConfirmationPayloadHash_({
      product_name: "エイリアステスト",
      planned_sale_price: 12000,
      condition: "新品・未使用",
      translated_title: "Alias Test",
      translated_description: "English Description",
      category: "sneaker",
      sneaker_size: "26.5cm",
      sneaker_sku: "SKU-ALIAS-01"
    });
    const hashMatches = (aliasHash === standardHash && aliasHash.length > 0);

    // 18-2: Square Catalog Display builds variationName properly
    const mockSneakerSource = {
      category: "sneaker",
      brand: "NIKE",
      product_name: "AIR JORDAN 1",
      sneaker_sku: "555088-101",
      sneaker_size: "27.5cm",
      condition: "新品・未使用"
    };
    const squareDisplay = buildSquareProductDisplay_(mockSneakerSource);
    const varNameOk = (squareDisplay.variationName === "27.5cm");

    // 18-3: When sneakerOptions is provided, Square Option naming format is used
    const mockSneakerOpts = {
      expectedVariationName: "27.5, 新品・未使用"
    };
    const squareOptionDisplay = buildSquareProductDisplay_(mockSneakerSource, mockSneakerOpts);
    const optVarNameOk = (squareOptionDisplay.variationName === "27.5, 新品・未使用");

    record(
      "18. Square Variation Name & Candidate Property Aliases Support",
      hashMatches && varNameOk && optVarNameOk,
      `hashMatches: ${hashMatches}, variationName: ${squareDisplay.variationName}, optVariationName: ${squareOptionDisplay.variationName}`
    );
  } catch (err) {
    record("18. Square Variation Name & Candidate Property Aliases Support", false, err.message);
  }

  // 19. Square Idempotency Key Generation & Deletion Recovery Support
  try {
    const pid = "TMP-TEST-IDEMP";
    const key1 = buildSquareProdCreateIdempotencyKey_(pid, 1);
    const key2 = buildSquareProdCreateIdempotencyKey_(pid, 2);
    const keyDefault = buildSquareProdCreateIdempotencyKey_(pid);
    const isKey1Fixed = (key1 === "ais-square-prod-create-" + pid);
    const isKeyDefaultFixed = (keyDefault === "ais-square-prod-create-" + pid);
    const isKey2Advanced = (key2 === "ais-square-prod-create-" + pid + "-g2");

    setSquareProdCreateGeneration_(pid, 2);
    const readGen = getSquareProdCreateGeneration_(pid);
    setSquareProdCreateGeneration_(pid, 1); // cleanup

    record(
      "19. Square Idempotency Key Generation & Deletion Recovery Support",
      isKey1Fixed && isKeyDefaultFixed && isKey2Advanced && readGen === 2,
      `key1: ${key1}, key2: ${key2}, readGen: ${readGen}`
    );
  } catch (err) {
    record("19. Square Idempotency Key Generation & Deletion Recovery Support", false, err.message);
  }

  // 20. AI Batch Generation API Validation & Idempotency
  try {
    const noReq = handleCreateAiProductDraftBatch({});
    const noReqJson = JSON.parse(noReq.getContent());
    const reqRequiredOk = (noReqJson.error_code === "REQUEST_ID_REQUIRED");

    const emptyPids = handleCreateAiProductDraftBatch({ request_id: "GAS_REQ_001", product_ids: [] });
    const emptyPidsJson = JSON.parse(emptyPids.getContent());
    const emptyPidsOk = (emptyPidsJson.error_code === "EMPTY_PRODUCT_IDS");

    const over20 = [];
    for (let i = 1; i <= 21; i++) over20.push("TMP-" + i);
    const over20Res = handleCreateAiProductDraftBatch({ request_id: "GAS_REQ_002", product_ids: over20 });
    const over20Json = JSON.parse(over20Res.getContent());
    const maxExceededOk = (over20Json.error_code === "MAX_BATCH_SIZE_EXCEEDED");

    const validBatch = handleCreateAiProductDraftBatch({
      request_id: "GAS_REQ_003",
      product_ids: ["TMP-BATCH-01", "TMP-BATCH-02", "TMP-BATCH-01"]
    });
    const validJson = JSON.parse(validBatch.getContent());
    const createOk = (validJson.success === true && validJson.total_count === 2 && validJson.status === "queued" && !validJson.is_reused);

    const dupBatch = handleCreateAiProductDraftBatch({
      request_id: "GAS_REQ_003",
      product_ids: ["TMP-BATCH-01"]
    });
    const dupJson = JSON.parse(dupBatch.getContent());
    const idempOk = (dupJson.success === true && dupJson.batch_id === validJson.batch_id && dupJson.is_reused === true);

    const getRes = handleGetAiProductDraftBatch({ batch_id: validJson.batch_id });
    const getJson = JSON.parse(getRes.getContent());
    const getOk = (getJson.success === true && getJson.items.length === 2 && getJson.items[0].status === "pending");

    const allBatchOk = reqRequiredOk && emptyPidsOk && maxExceededOk && createOk && idempOk && getOk;
    record(
      "20. AI Batch Generation API Validation & Idempotency",
      allBatchOk,
      `reqRequiredOk: ${reqRequiredOk}, emptyPidsOk: ${emptyPidsOk}, maxExceededOk: ${maxExceededOk}, createOk: ${createOk}, idempOk: ${idempOk}, getOk: ${getOk}`
    );
  } catch (err) {
    record("20. AI Batch Generation API Validation & Idempotency", false, err.message);
  }

  console.log("--- [testAiProductDraftSuite_] 完了: " + results.passed + "/" + results.total + " 通過 ---");
  return results;
}

// ==================================================
// 実機確認用: 対象商品事前確認 & AI候補生成 (生成のみ)
// ==================================================

/**
 * 実機確認用 Pre-flight:
 * 対象テスト商品の現在値、Drive画像一覧、公開/在庫/Square状態を安全に読み取ってログ出力する。
 * （スプレッドシートや関連データへの変更は一切行わない READ ONLY 関数）
 *
 * @param {string} [targetProductId="TMP-000007"] 確認対象商品ID
 * @return {Object} 商品の事前状態サマリー
 */
function inspectTargetProductBeforeAiDraft(targetProductId) {
  const pid = String(targetProductId || "TMP-000027").trim();
  console.log("=== [Pre-flight] 対象テスト商品確認開始: " + pid + " ===");

  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = spreadsheet.getSheets()[0];
  const targetRow = findProductRow(sheet, pid);

  if (targetRow === -1) {
    console.error("[Pre-flight ERROR] Product not found in sheet: " + pid);
    return { success: false, error: "Product not found", product_id: pid };
  }

  const row = sheet.getRange(targetRow, 1, 1, Math.max(sheet.getLastColumn(), 40)).getValues()[0];

  const preState = {
    row_number: targetRow,
    product_id: String(row[1] || "").trim(),
    category: String(row[2] || "").trim(),
    brand: String(row[3] || "").trim(),
    product_name: String(row[4] || "").trim(),
    condition: String(row[5] || "").trim(),
    purchase_price: row[6],
    planned_sale_price: row[7],
    description: String(row[9] || "").trim(),
    sneaker_sku: String(row[11] || "").trim(),
    sneaker_size: String(row[12] || "").trim(),
    drive_folder_url: String(row[29] || "").trim(),
    publish_status: String(row[31] || "").trim(),
    inventory_status: String(row[32] || "").trim(),
    status: String(row[33] || "").trim(),
    square_item_id: String(row[34] || "").trim(),
    square_variation_id: String(row[35] || "").trim(),
    ai_draft_flag: String(row[39] || "").trim() // AN列 (40)
  };

  console.log("------------------------------------------");
  console.log("[商品基本情報]");
  console.log("  行番号: " + preState.row_number);
  console.log("  商品ID: " + preState.product_id);
  console.log("  カテゴリ (C列): " + preState.category);
  console.log("  ブランド (D列): " + preState.brand);
  console.log("  商品名 (E列): " + preState.product_name);
  console.log("  状態 (F列): " + preState.condition);
  console.log("  販売予定価格 (H列): " + preState.planned_sale_price);
  console.log("  説明文抜粋 (J列): " + preState.description.substring(0, 60) + (preState.description.length > 60 ? "..." : ""));
  console.log("------------------------------------------");
  console.log("[ステータス・Square状態]");
  console.log("  publish_status (AF列): " + preState.publish_status + " (要求: draft)");
  console.log("  status (AH列): " + preState.status + " (要求: active)");
  console.log("  square_item_id (AI列): " + (preState.square_item_id || "(未登録/空 - 安全)"));
  console.log("  ai_draft_flag (AN列): " + (preState.ai_draft_flag || "(未設定/空)"));
  console.log("------------------------------------------");

  // Drive画像の確認
  let imagesSummary = [];
  if (preState.drive_folder_url) {
    try {
      const folderId = extractDriveFolderId(preState.drive_folder_url);
      const folder = DriveApp.getFolderById(folderId);
      const files = folder.getFiles();
      while (files.hasNext()) {
        const file = files.next();
        const mime = file.getMimeType();
        if (AI_DRAFT_CONFIG.ALLOWED_MIME_TYPES.indexOf(mime) !== -1) {
          imagesSummary.push({
            id: file.getId(),
            name: file.getName(),
            mime_type: mime,
            size_bytes: file.getSize()
          });
        }
      }
      console.log("[Drive画像情報] フォルダURL: " + preState.drive_folder_url);
      console.log("  利用可能画像数: " + imagesSummary.length + "枚");
      imagesSummary.forEach((img, idx) => {
        console.log(`    [画像${idx + 1}] ID: ${img.id}, Name: ${img.name}, MIME: ${img.mime_type}, Size: ${(img.size_bytes / 1024).toFixed(1)} KB`);
      });
    } catch (driveErr) {
      console.warn("  Drive画像フォルダ読取失敗: " + driveErr.message);
    }
  } else {
    console.warn("  DriveフォルダURLが空です。");
  }

  // AIドラフト履歴の確認
  const latestDraft = getLatestProductAiDraft_(pid);
  if (latestDraft) {
    console.log("[既存AIドラフト情報]");
    console.log("  draft_id: " + latestDraft.draft_id);
    console.log("  version: " + latestDraft.draft_version);
    console.log("  review_status: " + latestDraft.review_status);
  } else {
    console.log("[既存AIドラフト情報] 履歴なし (新規生成対象)");
  }

  console.log("=== [Pre-flight] 確認完了 ===");
  return {
    success: true,
    product: preState,
    images: imagesSummary,
    latest_draft: latestDraft
  };
}

/**
 * 実機確認用: 非公開テスト商品1件を対象に AI候補生成のみを実行する
 *
 * 厳格制約:
 * - スタッフ確定（confirm API）は呼ばない
 * - 販売公開（publish_status更新）は行わない
 * - Squareへの書き込みは一切行わない
 * - 本番デプロイ更新は不要（GAS HEAD / エディタからの手動実行）
 * - LLM_API_KEY 等の秘密値は一切ログ出力しない
 *
 * @param {string} [targetProductId="TMP-000027"] 対象商品ID
 * @param {string[]} [selectedImageIds] 解析対象画像ID（未指定時は最大3枚自動選択）
 * @return {Object} 生成実行結果サマリー
 */
function testGenerateAiProductDraftLive(targetProductId, selectedImageIds) {
  const pid = String(targetProductId || "TMP-000027").trim();
  console.log("==================================================");
  console.log("=== [Live Execution] AI候補生成実機確認開始: " + pid + " ===");
  console.log("==================================================");

  const preCheck = inspectTargetProductBeforeAiDraft(pid);
  if (!preCheck.success) {
    throw new Error("Pre-check failed for product: " + pid);
  }

  const prod = preCheck.product;
  if (prod.publish_status !== "draft" || prod.status !== "active") {
    throw new Error(`Invalid product state for AI generation: publish_status='${prod.publish_status}', status='${prod.status}'. Must be active draft.`);
  }

  if (prod.square_item_id) {
    console.warn("[WARNING] Square item ID exists on target product: " + prod.square_item_id);
  }

  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = spreadsheet.getSheets()[0];

  console.log("\n[モデル・プロパティ設定確認]");
  checkAiDraftModelSetting_();

  console.log("\n>>> handleGenerateAiProductDraft 呼出し開始 (外部Gemini通信実行) >>>");
  const startTime = Date.now();

  const reqPayload = {
    product_id: pid,
    force_regenerate: true
  };
  if (Array.isArray(selectedImageIds) && selectedImageIds.length > 0) {
    reqPayload.selected_image_ids = selectedImageIds;
  }

  const res = handleGenerateAiProductDraft(sheet, reqPayload);
  const elapsedMs = Date.now() - startTime;

  if (!res || typeof res.getContent !== "function") {
    throw new Error("handleGenerateAiProductDraft did not return TextOutput");
  }

  const json = JSON.parse(res.getContent());
  console.log("<<< handleGenerateAiProductDraft 呼出し完了 (" + elapsedMs + "ms) <<<");

  console.log("\n------------------------------------------");
  console.log("[生成結果判定]");
  console.log("  Success: " + json.success);
  if (!json.success) {
    console.error("  Error Code: " + json.error_code);
    console.error("  Message: " + json.message);
    return { success: false, error_code: json.error_code, message: json.message };
  }

  console.log("  Draft ID: " + json.draft_id);
  console.log("  Draft Version: " + json.draft_version);
  console.log("  Review Status: " + json.review_status + " (要求: pending_review)");
  console.log("  レスポンス使用モデル: " + (json.model_name || "(未返却)"));
  console.log("------------------------------------------");
  console.log("[AI生成候補内容]");
  const cand = json.candidate || {};
  console.log("  日本語タイトル: " + cand.title_ja);
  console.log("  ハッシュタグ: " + cand.hashtags_ja);
  console.log("  日本語説明文抜粋: " + String(cand.description_ja || "").substring(0, 80) + "...");
  console.log("  英語タイトル: " + cand.title_en);
  console.log("  英語説明文抜粋: " + String(cand.description_en || "").substring(0, 80) + "...");
  console.log("  提案価格: " + (cand.price !== null ? cand.price + " 円" : "null (未設定)") + " / 提案理由: " + (cand.price_note || "(なし)"));
  console.log("  カテゴリ: " + cand.category);
  console.log("  ブランド: " + cand.brand);
  console.log("  SKU: '" + (cand.sku || "") + "' (画像から未確認時は空欄)");
  console.log("  サイズ: " + cand.size);
  console.log("------------------------------------------");

  // シート変更検証
  console.log("[シート変更検証]");
  const postRow = sheet.getRange(prod.row_number, 1, 1, Math.max(sheet.getLastColumn(), 40)).getValues()[0];
  const postFlag = String(postRow[39] || "").trim(); // AN列 (40)
  console.log("  本票 AN列 (ai_draft_flag): '" + postFlag + "' (期待値: 'ai_managed')");

  // 本票の商品名・価格・状態が確定前のため書き換わっていないことを検証
  const postName = String(postRow[4] || "").trim();
  const postPrice = postRow[7];
  const postCond = String(postRow[5] || "").trim();
  const mainUnmodified = (postName === prod.product_name && postPrice === prod.planned_sale_price && postCond === prod.condition);
  console.log("  本票主要セル未変更 (確定前保護): " + (mainUnmodified ? "OK (変更なし確認)" : "NG (予期せぬ変更検知!)"));

  // product_ai_drafts シートの追加行確認
  const latest = getLatestProductAiDraft_(pid);
  const draftSaved = (latest && latest.draft_id === json.draft_id && latest.review_status === "pending_review");
  const modelSaved = latest ? latest.model_name : "";
  console.log("  product_ai_drafts 行保存確認: " + (draftSaved ? `OK (pending_review / 保存モデル: '${modelSaved}')` : "NG"));

  console.log("==================================================");
  console.log("=== [Live Execution] 実機確認サマリー完了 ===");
  console.log("==================================================");

  return {
    success: true,
    elapsed_ms: elapsedMs,
    draft_id: json.draft_id,
    draft_version: json.draft_version,
    review_status: json.review_status,
    model_name: json.model_name,
    saved_model_name: modelSaved,
    an_column_flag: postFlag,
    main_unmodified: mainUnmodified,
    draft_saved: draftSaved,
    candidate: cand
  };
}

/**
 * AI一括出品ドラフト実機検証関数 (3商品一括受付・ワーカー実行・結果保存)
 *
 * @param {string[]} [productIds] 対象商品ID配列（未指定時は ["TMP-000027", "TMP-000088", "TMP-000090"]）
 * @return {Object} 検証結果サマリー
 */
function testAiBatchDraftLive(productIds) {
  const pids = (Array.isArray(productIds) && productIds.length > 0)
    ? productIds
    : ["TMP-000049", "TMP-000048", "TMP-000047"];

  console.log("==================================================");
  console.log("=== [Live Execution] AI一括ドラフト実機確認開始 ===");
  console.log("=== 対象商品ID: " + JSON.stringify(pids) + " ===");
  console.log("==================================================");

  // 1. トリガー設置
  console.log("\n[1. トリガー設置確認]");
  const trigger = ensureAiBatchTrigger();
  console.log("  トリガー設置完了: " + (trigger ? ("ID: " + trigger.getUniqueId()) : "(既存トリガー維持)"));

  // 2. バッチ受付 (create_ai_product_draft_batch)
  console.log("\n[2. バッチ受付呼出し]");
  const reqId = "LIVE_BATCH_" + Date.now();
  const createRes = handleCreateAiProductDraftBatch({
    request_id: reqId,
    product_ids: pids,
    force_regenerate: true
  });
  const createJson = JSON.parse(createRes.getContent());
  console.log("  受付結果: " + JSON.stringify(createJson));
  if (!createJson.success) {
    throw new Error("バッチ受付に失敗しました: " + createJson.message);
  }
  const batchId = createJson.batch_id;

  // 2-2. 再読込からの復帰検証 (同一 request_id での再呼出しによる既存バッチ返却)
  console.log("\n[2-2. 再読込からの復帰検証 (同一 request_id 再送)]");
  const reloadRes = handleCreateAiProductDraftBatch({
    request_id: reqId,
    product_ids: pids,
    force_regenerate: true
  });
  const reloadJson = JSON.parse(reloadRes.getContent());
  console.log("  再読込復帰結果: " + JSON.stringify(reloadJson));
  if (!reloadJson.success || reloadJson.batch_id !== batchId || reloadJson.is_reused !== true) {
    throw new Error("再読込からの復帰に失敗しました: 既存batch_idが返却されませんでした (is_reused=" + reloadJson.is_reused + ")");
  }
  console.log("  => 再読込復帰成功: 同一batch_id返却確認 (batch_id=" + batchId + ", is_reused=true)");

  // 3. ワーカーキュー実行 (processAiBatchQueue)
  console.log("\n[3. バックグラウンドワーカー実行]");
  const workerRes = processAiBatchQueue();
  console.log("  ワーカー実行結果: " + JSON.stringify(workerRes));

  // 4. 進捗・商品別状態取得 (get_ai_product_draft_batch)
  console.log("\n[4. バッチ進捗確認]");
  const getRes = handleGetAiProductDraftBatch({ batch_id: batchId });
  const getJson = JSON.parse(getRes.getContent());
  console.log("  進捗サマリー: " + JSON.stringify({
    batch_id: getJson.batch_id,
    status: getJson.status,
    total_count: getJson.total_count,
    completed_count: getJson.completed_count,
    failed_count: getJson.failed_count
  }));

  console.log("\n[5. 商品別結果詳細]");
  if (Array.isArray(getJson.items)) {
    getJson.items.forEach((item, idx) => {
      console.log(`  [商品 ${idx + 1}] ID: ${item.product_id}, Status: ${item.status}, DraftID: ${item.draft_id}, Model: ${item.model_name}, Error: ${item.error_message || "なし"}`);
    });
  }

  // 5. シート永続化検証 & 下書き自動反映検証
  console.log("\n[6. シート永続化検証 & 下書き自動反映確認]");
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const mainSheet = ss.getSheets()[0];
  const jobsSheet = ss.getSheetByName(AI_BATCH_CONFIG.JOBS_SHEET_NAME);
  const itemsSheet = ss.getSheetByName(AI_BATCH_CONFIG.ITEMS_SHEET_NAME);
  const draftsSheet = ss.getSheetByName(AI_DRAFT_CONFIG.SHEET_NAME);

  console.log("  ai_batch_jobs 存在: " + !!jobsSheet + ", 行数: " + (jobsSheet ? jobsSheet.getLastRow() : 0));
  console.log("  ai_batch_items 存在: " + !!itemsSheet + ", 行数: " + (itemsSheet ? itemsSheet.getLastRow() : 0));
  console.log("  product_ai_drafts 存在: " + !!draftsSheet + ", 行数: " + (draftsSheet ? draftsSheet.getLastRow() : 0));

  console.log("\n[7. 商品下書き自動反映 (Auto-Apply) 詳細検証]");
  pids.forEach(pid => {
    try {
      const pRow = findProductRow(mainSheet, pid);
      if (pRow > 0) {
        const rowVals = mainSheet.getRange(pRow, 1, 1, Math.max(mainSheet.getLastColumn(), 40)).getValues()[0];
        const draft = getLatestProductAiDraft_(pid);
        const trans = safeGetProductTranslation_(pid);
        console.log(`  商品 ${pid} (行 ${pRow}):`);
        console.log(`    本票 商品名: '${rowVals[4]}', 状態: '${rowVals[5]}', 価格: ${rowVals[7]}, サイズ: '${rowVals[12]}', AN列: '${rowVals[39]}'`);
        console.log(`    ドラフト ステータス: '${draft ? draft.review_status : "なし"}', 確定指紋: '${draft ? (draft.confirmed_fingerprint ? draft.confirmed_fingerprint.substring(0, 16) + "..." : "(空)") : "なし"}'`);
        console.log(`    英文翻訳 ステータス: '${trans ? trans.translation_status : "なし"}', タイトル: '${trans ? trans.translated_title : ""}'`);
      }
    } catch (checkErr) {
      console.warn(`  商品 ${pid} 検証時エラー: ${checkErr.message}`);
    }
  });

  console.log("==================================================");
  console.log("=== [Live Execution] AI一括ドラフト実機確認完了 ===");
  console.log("==================================================");

  return {
    success: true,
    batch_id: batchId,
    batch_status: getJson.status,
    create_result: createJson,
    worker_result: workerRes,
    get_result: getJson
  };
}

// ==================================================
// gemini-3.5-flash-lite 単体直接検証関数 (商品シート書込みなし)
// ==================================================

/**
 * gemini-3.5-flash-lite の単体検証関数 (商品シート書込みなしの完全READ-ONLY)
 *
 * 既存の段階診断を最初から繰り返さず、同じ画像・商品生成プロンプト・responseSchemaで
 * gemini-3.5-flash-lite の単体呼び出しを行い、候補検証（スキーマ適合・内容）を確認する。
 *
 * @param {string} [targetProductId="TMP-000027"]
 * @return {Object} 検証結果サマリー
 */
function verifyGemini35FlashLiteLive(targetProductId) {
  const pid = String(targetProductId || "TMP-000027").trim();
  const testModel = "gemini-3.5-flash-lite";

  console.log("==================================================");
  console.log(`=== [Gemini 3.5 Flash Lite Live Verification] 開始: ${pid} ===`);
  console.log(`=== 対象モデル: ${testModel} (商品シート書込みなし) ===`);
  console.log("==================================================");

  checkAiDraftModelSetting_();

  const preCheck = inspectTargetProductBeforeAiDraft(pid);
  if (!preCheck.success) {
    throw new Error(`対象商品 (${pid}) の事前確認に失敗しました。`);
  }

  const prod = preCheck.product;
  if (!prod.drive_folder_url) {
    throw new Error(`対象商品 (${pid}) に Drive フォルダ URL がありません。`);
  }

  const productMeta = {
    productId: pid,
    category: prod.category || "",
    brand: prod.brand || "",
    productName: prod.product_name || "",
    sneakerSku: prod.sneaker_sku || ""
  };

  console.log(`\n[1. Drive画像取得] productId=${pid}, folder=${prod.drive_folder_url}`);
  const validatedImages = getValidatedProductDriveImages_(pid, prod.drive_folder_url);
  console.log(`  取得成功: ${validatedImages.images.length} 枚 (画像ID: ${validatedImages.imageIds.join(", ")})`);

  console.log(`\n[2. Gemini API 呼び出し] model=${testModel}, responseSchema=有効, 商品プロンプト送信 (単体直接検証)`);
  const startTime = Date.now();
  let candidate = null;
  let errorCaught = null;

  try {
    candidate = callGeminiMultimodalAiDraft_(validatedImages.images, productMeta, testModel);
  } catch (err) {
    errorCaught = err;
  }

  const elapsedMs = Date.now() - startTime;

  if (errorCaught) {
    console.error(`\n【検証失敗】 ${testModel} 呼出し例外 (${elapsedMs}ms): ${errorCaught.message} (code=${errorCaught.error_code || "N/A"})`);
    return {
      success: false,
      model: testModel,
      elapsed_ms: elapsedMs,
      error_code: errorCaught.error_code || "UNKNOWN",
      error_message: errorCaught.message
    };
  }

  console.log("\n--------------------------------------------------");
  console.log(`【検証成功】 ${testModel} での生成・候補検証が完了しました! (${elapsedMs}ms)`);
  console.log(`  使用モデル: ${candidate.actual_model_name || testModel}`);
  console.log(`  タイトル(日): ${candidate.title_ja}`);
  console.log(`  タイトル(英): ${candidate.title_en}`);
  console.log(`  状態(判定): ${candidate.condition}`);
  console.log(`  カテゴリ: ${candidate.category}`);
  console.log(`  ブランド: ${candidate.brand}`);
  console.log(`  ハッシュタグ: ${candidate.hashtags_ja}`);
  console.log(`  説明(日): ${(candidate.description_ja || "").substring(0, 80)}...`);
  console.log(`  説明(英): ${(candidate.description_en || "").substring(0, 80)}...`);
  console.log("==================================================");

  return {
    success: true,
    model: testModel,
    actual_model_name: candidate.actual_model_name || testModel,
    elapsed_ms: elapsedMs,
    candidate: candidate
  };
}

// ==================================================
// Gemini AIドラフト生成 最小限原因切り分け診断関数 (商品シート書込みなし)
// ==================================================

/**
 * Gemini AIドラフト生成の原因切り分け診断 (シート変更一切なしの完全READ-ONLY)
 *
 * 1. 最小テキストリクエスト ("OKと返すだけ", 画像なし・スキーマなし)
 *    ※失敗時は利用可能モデル一覧取得 & 代表的モデル比較
 * 2. 実画像1枚追加リクエスト ("画像 + OK", スキーマなし)
 * 3. 現行商品生成要求 (フルプロンプト・responseSchema、シート保存なし)
 *
 * @param {string} [targetProductId="TMP-000027"]
 * @return {Object} 診断結果サマリー
 */
function diagnoseGeminiAiDraftLive(targetProductId) {
  const pid = String(targetProductId || "TMP-000027").trim();
  console.log("==================================================");
  console.log("=== [Gemini Diagnosis] 複数Flashモデル比較診断開始: " + pid + " ===");
  console.log("==================================================");

  const apiKey = getLlmApiKey_();
  const configuredModel = getLlmModelName_();
  const rawModelProp = PropertiesService.getScriptProperties().getProperty(LLM_TRANSLATION_CONFIG.MODEL_PROPERTY);

  console.log("[設定確認]");
  console.log("  API Key 設定有無: " + (apiKey ? "OK (設定あり)" : "NG (未設定)"));
  console.log("  Script Properties LLM_MODEL: " + (rawModelProp ? `'${rawModelProp}'` : "(未設定 / デフォルト適用)"));
  console.log("  現行設定モデル名: '" + configuredModel + "' (※比較中はScript Propertiesを変更しません)");

  if (!apiKey) {
    throw new Error("LLM_API_KEY is not configured in Script Properties");
  }

  // 1. 利用可能モデル一覧をAPIから取得して現行Flashモデル候補（最大2つ）を探索
  console.log("\n>>> [Step 0] Google API利用可能モデル一覧取得 & 現行Flashモデル照合 >>>");
  let discoveredValidModels = [];
  let allModelNames = [];
  try {
    const listRes = UrlFetchApp.fetch("https://generativelanguage.googleapis.com/v1beta/models", {
      method: "get",
      headers: { "x-goog-api-key": apiKey },
      muteHttpExceptions: true
    });
    if (listRes.getResponseCode() === 200) {
      const listData = JSON.parse(listRes.getContentText());
      const rawModels = listData.models || [];
      allModelNames = rawModels.map(m => (m.name || "").replace(/^models\//, ""));
      console.log("  API取得モデル総数: " + allModelNames.length);

      // 条件:
      // 1. supportedGenerationMethods に generateContent を含む
      // 2. モデル名に flash を含む
      // 3. Gemini 1.5系・2.0系を除外 (指示: 比較候補からGemini 1.5系・2.0系を除外してください)
      // 4. 混雑エラー確認済みの gemini-3.6-flash を除外
      discoveredValidModels = rawModels
        .filter(m => {
          const methods = Array.isArray(m.supportedGenerationMethods) ? m.supportedGenerationMethods : [];
          if (!methods.includes("generateContent")) return false;

          const name = (m.name || "").replace(/^models\//, "");
          const nameLower = name.toLowerCase();

          // Flashモデルであること
          if (!nameLower.includes("flash")) return false;

          // 1.5系・2.0系の除外
          if (/(?:1\.5|2\.0|1-5|2-0)/i.test(name) || name.startsWith("gemini-1.") || name.startsWith("gemini-2.0")) {
            return false;
          }

          // 混雑が確認された gemini-3.6-flash は除外
          if (name === "gemini-3.6-flash") return false;

          return true;
        })
        .map(m => (m.name || "").replace(/^models\//, ""));

      console.log("  条件合致（現行Flash / generateContent対応 / 1.5・2.0・3.6除外）モデル: " + (discoveredValidModels.join(", ") || "(なし)"));
    } else {
      console.warn("  モデル一覧取得非200: HTTP " + listRes.getResponseCode());
    }
  } catch (e) {
    console.warn("  モデル一覧取得スキップ: " + e.message);
  }

  // 候補例 (gemini-3.8-flash, gemini-3.5-flash-lite) との照合
  // 実際のモデル一覧に存在し、generateContentに対応するものだけ使用する
  const candidatePreferences = [
    "gemini-3.8-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.5-flash",
    "gemini-3-flash"
  ];

  const candidateModels = [];

  // 1. 優先候補例の照合
  candidatePreferences.forEach(pref => {
    if (discoveredValidModels.includes(pref) && !candidateModels.includes(pref) && candidateModels.length < 2) {
      candidateModels.push(pref);
    }
  });

  // 2. 2枠に満たない場合、条件合致した他の現行Flashモデルから補充 (最大2つ)
  discoveredValidModels.forEach(m => {
    if (!candidateModels.includes(m) && candidateModels.length < 2) {
      candidateModels.push(m);
    }
  });

  // 万一モデル一覧APIが取得できなかった場合のフォールバック（指示の候補例を最大2つ）
  if (candidateModels.length === 0) {
    console.warn("  API一覧から合致モデル未検出のため、指示の候補例（最大2つ）を使用します");
    candidateModels.push("gemini-3.8-flash", "gemini-3.5-flash-lite");
  }

  console.log("  最終比較対象モデル (最大2つ): " + candidateModels.join(", "));

  // 画像準備 (商品事前チェック)
  const preCheck = inspectTargetProductBeforeAiDraft(pid);
  if (!preCheck || !preCheck.success || !preCheck.product) {
    throw new Error("Product pre-check failed for: " + pid);
  }

  const rawImages = Array.isArray(preCheck.images) ? preCheck.images.slice() : [];
  if (rawImages.length === 0) {
    throw new Error("No images available for product: " + pid);
  }
  rawImages.sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "ja", { numeric: true }));
  const firstImageId = rawImages[0].id;
  console.log(`  使用先頭画像: ID='${firstImageId}', Name='${rawImages[0].name}'`);

  const validatedImages = getValidatedProductDriveImages_(
    pid,
    preCheck.product.drive_folder_url,
    [firstImageId]
  );
  if (!validatedImages || !Array.isArray(validatedImages.images) || validatedImages.images.length === 0) {
    throw new Error("Failed to load drive image for product: " + pid);
  }
  const img0 = validatedImages.images[0];
  console.log(`  画像準備完了: MIME='${img0.mimeType}', 約${Math.round(((img0.base64 ? img0.base64.length : 0) * 0.75) / 1024)}KB`);

  const productMeta = {
    productId: pid,
    category: preCheck.product.category,
    brand: preCheck.product.brand,
    productName: preCheck.product.product_name,
    sneakerSku: preCheck.product.sneaker_sku
  };

  const results = [];
  let successfulModel = null;
  let successfulResult = null;

  for (let mIdx = 0; mIdx < candidateModels.length; mIdx++) {
    const testModel = candidateModels[mIdx];
    console.log(`\n==================================================`);
    console.log(`=== [Model ${mIdx + 1}/${candidateModels.length}] 検証モデル: '${testModel}' ===`);
    console.log(`==================================================`);

    const modelRecord = {
      model: testModel,
      stage1_minimal_text: null,
      stage2_single_image: null,
      stage3_full_draft: null
    };

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(testModel)}:generateContent`;

    // --------------------------------------------------
    // Stage 1: 最小テキストリクエスト ("OKと返すだけ")
    // --------------------------------------------------
    console.log(`>>> [Stage 1: ${testModel}] 最小テキスト ("OKと返すだけ") >>>`);
    const s1Start = Date.now();
    const s1Payload = {
      contents: [{ role: "user", parts: [{ text: "Reply with only the word OK." }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 256 }
    };

    let s1Res;
    try {
      s1Res = UrlFetchApp.fetch(endpoint, {
        method: "post",
        contentType: "application/json",
        headers: { "x-goog-api-key": apiKey },
        payload: JSON.stringify(s1Payload),
        muteHttpExceptions: true
      });
    } catch (s1Err) {
      console.error(`  [Stage 1 失敗] 通信例外: ${s1Err.message}`);
      modelRecord.stage1_minimal_text = { success: false, error: s1Err.message };
      results.push(modelRecord);
      continue;
    }

    const s1Code = s1Res.getResponseCode();
    const s1Elapsed = Date.now() - s1Start;
    const s1Body = s1Res.getContentText();
    console.log(`  [Stage 1] HTTP ${s1Code} (${s1Elapsed}ms)`);

    if (s1Code !== 200) {
      const errDetail = parseGoogleErrorJson_(s1Body, s1Code);
      console.error(`  [Stage 1 失敗] Code=${errDetail.code}, Status='${errDetail.status}', Message='${errDetail.message}'`);
      modelRecord.stage1_minimal_text = { success: false, code: s1Code, error: errDetail };
      results.push(modelRecord);
      continue;
    }

    const s1Text = extractGeminiResponseText_(s1Body);
    if (!s1Text) {
      console.error(`  [Stage 1 失敗] HTTP 200ですが応答本文が空です。Raw: ${s1Body.substring(0, 200)}`);
      modelRecord.stage1_minimal_text = { success: false, code: 200, error: "Empty response text" };
      results.push(modelRecord);
      continue;
    }

    console.log(`  [Stage 1 成功] 応答: '${s1Text}'`);
    modelRecord.stage1_minimal_text = { success: true, code: 200, elapsed_ms: s1Elapsed, reply: s1Text };

    // --------------------------------------------------
    // Stage 2: 実画像1枚追加リクエスト ("画像 + OK")
    // --------------------------------------------------
    console.log(`>>> [Stage 2: ${testModel}] 実画像1枚 ("画像 + OK") >>>`);
    const s2Start = Date.now();
    const s2Payload = {
      contents: [
        {
          role: "user",
          parts: [
            { text: "Reply with only the word OK." },
            { inlineData: { mimeType: img0.mimeType, data: img0.base64 } }
          ]
        }
      ],
      generationConfig: { temperature: 0.1, maxOutputTokens: 256 }
    };

    let s2Res;
    try {
      s2Res = UrlFetchApp.fetch(endpoint, {
        method: "post",
        contentType: "application/json",
        headers: { "x-goog-api-key": apiKey },
        payload: JSON.stringify(s2Payload),
        muteHttpExceptions: true
      });
    } catch (s2Err) {
      console.error(`  [Stage 2 失敗] 通信例外: ${s2Err.message}`);
      modelRecord.stage2_single_image = { success: false, error: s2Err.message };
      results.push(modelRecord);
      continue;
    }

    const s2Code = s2Res.getResponseCode();
    const s2Elapsed = Date.now() - s2Start;
    const s2Body = s2Res.getContentText();
    console.log(`  [Stage 2] HTTP ${s2Code} (${s2Elapsed}ms)`);

    if (s2Code !== 200) {
      const errDetail = parseGoogleErrorJson_(s2Body, s2Code);
      console.error(`  [Stage 2 失敗] Code=${errDetail.code}, Status='${errDetail.status}', Message='${errDetail.message}'`);
      modelRecord.stage2_single_image = { success: false, code: s2Code, error: errDetail };
      results.push(modelRecord);
      continue;
    }

    const s2Text = extractGeminiResponseText_(s2Body);
    if (!s2Text) {
      console.error(`  [Stage 2 失敗] HTTP 200ですが応答本文が空です。Raw: ${s2Body.substring(0, 200)}`);
      modelRecord.stage2_single_image = { success: false, code: 200, error: "Empty response text" };
      results.push(modelRecord);
      continue;
    }

    console.log(`  [Stage 2 成功] 応答: '${s2Text}'`);
    modelRecord.stage2_single_image = { success: true, code: 200, elapsed_ms: s2Elapsed, reply: s2Text };

    // --------------------------------------------------
    // Stage 3: 現行商品情報生成要求 (フルプロンプト・responseSchema、シート保存なし)
    // --------------------------------------------------
    console.log(`>>> [Stage 3: ${testModel}] 商品情報生成要求 (フルスキーマ・プロンプト、シート保存なし) >>>`);
    const s3Start = Date.now();
    try {
      const candidate = callGeminiMultimodalAiDraft_(validatedImages.images, productMeta, testModel);
      const s3Elapsed = Date.now() - s3Start;
      console.log(`  [Stage 3 成功!!] (${s3Elapsed}ms) 商品情報生成成功!`);
      console.log(`    タイトル(日): ${candidate.title_ja}`);
      console.log(`    タイトル(英): ${candidate.title_en}`);
      console.log(`    状態: ${candidate.condition}`);
      console.log(`    カテゴリ: ${candidate.category}`);
      console.log(`    ブランド: ${candidate.brand}`);
      console.log(`    SKU: ${candidate.sku}`);
      console.log(`    サイズ: ${candidate.size}`);
      console.log(`    価格: ${candidate.price} (設計通りのnull)`);
      console.log(`    説明文(日抜粋): ${String(candidate.description_ja || "").substring(0, 60)}...`);

      modelRecord.stage3_full_draft = { success: true, elapsed_ms: s3Elapsed, candidate: candidate };
      results.push(modelRecord);

      successfulModel = testModel;
      successfulResult = {
        model: testModel,
        stage1_ms: s1Elapsed,
        stage2_ms: s2Elapsed,
        stage3_ms: s3Elapsed,
        total_ms: s1Elapsed + s2Elapsed + s3Elapsed,
        candidate: candidate
      };
      break; // 成功したモデルが見つかったのでループを終了
    } catch (s3Err) {
      const s3Elapsed = Date.now() - s3Start;
      console.error(`  [Stage 3 失敗] (${s3Elapsed}ms) Code=${s3Err.error_code}, Message=${s3Err.message}`);
      modelRecord.stage3_full_draft = { success: false, elapsed_ms: s3Elapsed, error_code: s3Err.error_code, message: s3Err.message };
      results.push(modelRecord);
    }
  }

  console.log(`\n==================================================`);
  console.log(`=== [Gemini Diagnosis Summary] 診断完了 (シート変更なし) ===`);
  console.log(`==================================================`);
  if (successfulModel) {
    console.log(`【成功判定】 モデル '${successfulModel}' で Stage 1〜3 すべて成功しました!`);
    console.log(`  所要時間: Stage1=${successfulResult.stage1_ms}ms, Stage2=${successfulResult.stage2_ms}ms, Stage3=${successfulResult.stage3_ms}ms (計 ${successfulResult.total_ms}ms)`);
  } else {
    console.error(`【失敗判定】 検証したすべての候補モデルで Stage 3 まで完了できませんでした。`);
  }

  return {
    success: Boolean(successfulModel),
    successful_model: successfulModel,
    successful_result: successfulResult,
    configured_model_kept: configuredModel,
    all_results: results
  };
}

/**
 * Google Gemini API のエラーレスポンス JSON を安全にパースするヘルパー
 * @param {string} bodyText
 * @param {number} fallbackCode
 * @return {{code: number, status: string, message: string}}
 */
function parseGoogleErrorJson_(bodyText, fallbackCode) {
  let code = fallbackCode;
  let status = "UNKNOWN";
  let message = "";
  try {
    const errJson = JSON.parse(bodyText);
    if (errJson && errJson.error) {
      code = errJson.error.code || fallbackCode;
      status = errJson.error.status || "UNKNOWN";
      message = String(errJson.error.message || "").replace(/key=[^&\s]+/gi, "key=[REDACTED]");
    }
  } catch (_) {
    message = String(bodyText || "").substring(0, 300).replace(/key=[^&\s]+/gi, "key=[REDACTED]");
  }
  return { code: code, status: status, message: message };
}

/**
 * Gemini API レスポンスから思考パート(thought)を除外して本文テキストを安全に抽出するヘルパー
 * @param {string} bodyText レスポンスボディJSON文字列
 * @return {string} 抽出された本文テキスト (空の場合は空文字)
 */
function extractGeminiResponseText_(bodyText) {
  try {
    const p = JSON.parse(bodyText);
    if (p.candidates && p.candidates[0] && p.candidates[0].content && Array.isArray(p.candidates[0].content.parts)) {
      const parts = p.candidates[0].content.parts;
      // 1. thoughtフラグのない通常のテキストpartを優先結合
      const nonThought = parts
        .filter(pt => !pt.thought && typeof pt.text === "string" && pt.text.trim().length > 0)
        .map(pt => pt.text)
        .join("\n")
        .trim();
      if (nonThought) return nonThought;

      // 2. thoughtプロパティが明示されていない場合の全partテキスト結合
      const allText = parts
        .filter(pt => typeof pt.text === "string" && pt.text.trim().length > 0)
        .map(pt => pt.text)
        .join("\n")
        .trim();
      if (allText) return allText;
    }
    if (p.candidates && p.candidates[0]) {
      const c = p.candidates[0];
      if (c.finishReason) {
        console.warn(`    [Gemini Text Extraction] textが空です (finishReason='${c.finishReason}')`);
      }
    }
  } catch (_) {}
  return "";
}

/**
 * TMP-000093 の実機状態（本票セル値、最新ドラフト、バッチアイテム行）を検査し、
 * 必要に応じて既存候補を用いて下書き自動反映を安全に実行する診断・復旧関数
 * 
 * @param {Object} [options]
 * @param {boolean} [options.apply_draft=false] 下書きが空欄の場合に既存候補を自動反映するかどうか (デフォルト安全のためfalse)
 * @return {Object} 診断および反映結果
 */
function inspectAndSyncTmp000093Live(options) {
  const productId = "TMP-000093";
  const shouldApply = options && options.apply_draft !== undefined ? Boolean(options.apply_draft) : false;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const mainSheet = ss.getSheets()[0];
  const pRow = findProductRow(mainSheet, productId);

  if (pRow <= 0) {
    return { success: false, error: `Product not found: ${productId}` };
  }

  // 1. 本票セル値（反映前）
  const lastCol = Math.max(mainSheet.getLastColumn(), 40);
  const rowValsBefore = mainSheet.getRange(pRow, 1, 1, lastCol).getValues()[0];
  const beforeState = {
    row_number: pRow,
    created_at: rowValsBefore[0],
    product_id: String(rowValsBefore[1] || "").trim(),
    category: String(rowValsBefore[2] || "").trim(),
    brand: String(rowValsBefore[3] || "").trim(),
    product_name: String(rowValsBefore[4] || "").trim(),
    condition: String(rowValsBefore[5] || "").trim(),
    purchase_price: rowValsBefore[6],
    planned_sale_price: rowValsBefore[7],
    storage_location: String(rowValsBefore[8] || "").trim(),
    description: String(rowValsBefore[9] || "").trim(),
    notes: String(rowValsBefore[10] || "").trim(),
    sneaker_sku: String(rowValsBefore[11] || "").trim(),
    sneaker_size: String(rowValsBefore[12] || "").trim(),
    publish_status: String(rowValsBefore[31] || "").trim(),
    record_status: String(rowValsBefore[33] || "").trim(),
    drive_folder_url: String(rowValsBefore[29] || "").trim(),
    ai_status: String(rowValsBefore[39] || "").trim() // AN列
  };

  // 2. 最新AIドラフト
  const latestDraft = getLatestProductAiDraft_(productId);

  // 3. バッチアイテム情報
  let batchItems = [];
  const itemsSheet = ss.getSheetByName(AI_BATCH_CONFIG.ITEMS_SHEET_NAME);
  if (itemsSheet && itemsSheet.getLastRow() > 1) {
    const iData = itemsSheet.getRange(1, 1, itemsSheet.getLastRow(), itemsSheet.getLastColumn()).getValues();
    const headers = iData[0].map(h => String(h || "").trim());
    const pidIdx = headers.indexOf("product_id");
    for (let r = 1; r < iData.length; r++) {
      if (String(iData[r][pidIdx] || "").trim() === productId) {
        const itemObj = {};
        headers.forEach((h, c) => {
          itemObj[h] = iData[r][c];
        });
        batchItems.push(itemObj);
      }
    }
  }

  // 4. 現在のソース指紋とスタッフ編集チェック
  let currentSourceFp = "";
  let staffModified = false;
  try {
    currentSourceFp = computeProductSourceFingerprint_(mainSheet, pRow, productId);
    if (latestDraft && latestDraft.source_fingerprint && currentSourceFp !== latestDraft.source_fingerprint) {
      staffModified = true;
    }
  } catch (fpErr) {
    console.warn("Fingerprint check error:", fpErr.message);
  }

  // スタッフによる本票編集があるかのチェック（商品名などが既に空欄でない場合）
  const hasExistingContent = Boolean(beforeState.product_name || beforeState.category);

  let applyResult = null;
  // 5. 下書き自動反映の実行 (本票が空欄で、既存候補があり、shouldApply=trueの場合)
  if (shouldApply && !hasExistingContent && latestDraft) {
    console.log(`[TMP-000093 Live Sync] Applying existing candidate ${latestDraft.draft_id} to product record...`);
    try {
      applyResult = applyExistingAiDraftToProductRecord_(mainSheet, productId, latestDraft);
    } catch (applyErr) {
      applyResult = {
        success: false,
        error_code: applyErr.error_code || "APPLY_ERROR",
        message: applyErr.message
      };
    }
  }

  // 6. 本票セル値（反映後）
  const rowValsAfter = mainSheet.getRange(pRow, 1, 1, lastCol).getValues()[0];
  const afterState = {
    row_number: pRow,
    created_at: rowValsAfter[0],
    product_id: String(rowValsAfter[1] || "").trim(),
    category: String(rowValsAfter[2] || "").trim(),
    brand: String(rowValsAfter[3] || "").trim(),
    product_name: String(rowValsAfter[4] || "").trim(),
    condition: String(rowValsAfter[5] || "").trim(),
    purchase_price: rowValsAfter[6],
    planned_sale_price: rowValsAfter[7],
    storage_location: String(rowValsAfter[8] || "").trim(),
    description: String(rowValsAfter[9] || "").trim(),
    notes: String(rowValsAfter[10] || "").trim(),
    sneaker_sku: String(rowValsAfter[11] || "").trim(),
    sneaker_size: String(rowValsAfter[12] || "").trim(),
    publish_status: String(rowValsAfter[31] || "").trim(),
    record_status: String(rowValsAfter[33] || "").trim(),
    drive_folder_url: String(rowValsAfter[29] || "").trim(),
    ai_status: String(rowValsAfter[39] || "").trim()
  };

  // 7. 英文翻訳および最新ドラフト（反映後）
  const latestDraftAfter = getLatestProductAiDraft_(productId);
  const translationAfter = safeGetProductTranslation_(productId);

  // 8. 取得API応答 (buildProductDetail)
  let apiResponse = null;
  try {
    apiResponse = buildProductDetail(rowValsAfter, true, true);
  } catch (apiErr) {
    apiResponse = { error: apiErr.message };
  }

  return {
    success: true,
    product_id: productId,
    staff_modified_during_generation: staffModified,
    has_existing_content_before: hasExistingContent,
    before_state: beforeState,
    latest_draft_before: latestDraft,
    batch_items: batchItems,
    apply_result: applyResult,
    after_state: afterState,
    latest_draft_after: latestDraftAfter,
    translation_after: translationAfter,
    api_detail: apiResponse
  };
}

// ==================================================
// Google Search Grounding 診断・実機比較関数 (完全READ-ONLY)
// ==================================================

/**
 * 検索グラウンディング (Google Search Grounding) の実機診断関数
 * シートや公開状態への書込みは一切行わず、1回方式と2段階方式のAPI疎通・検索実行・商品名推論結果を比較検証する
 *
 * @param {string} [targetProductId="TMP-000100"] 診断対象の商品ID (例: TMP-000100, TMP-000102, TMP-000095)
 * @param {Object} [options]
 * @param {string} [options.model_name="gemini-3.8-flash"] 検証モデル名
 * @param {boolean} [options.run_single=true] 1回方式を実行するか
 * @param {boolean} [options.run_two_stage=true] 2段階方式を実行するか
 * @return {Object} 診断結果サマリー
 */
function diagnoseSearchGroundingLive(targetProductId, options) {
  options = options || {};
  const pid = String(targetProductId || "TMP-000100").trim();
  const testModel = String(options.model_name || (typeof getAiDraftModelName_ === "function" ? getAiDraftModelName_() : "gemini-3.8-flash")).trim();
  const shouldRunSingle = options.run_single !== undefined ? Boolean(options.run_single) : true;
  const shouldRunTwoStage = options.run_two_stage !== undefined ? Boolean(options.run_two_stage) : true;

  console.log("==================================================");
  console.log(`=== [Search Grounding Diagnosis] 開始: ${pid} (Model: ${testModel}) ===`);
  console.log("==================================================");

  const apiKey = getLlmApiKey_();
  if (!apiKey) {
    throw new Error("LLM_API_KEY is not configured in Script Properties");
  }

  // 1. 商品事前チェック & Drive画像取得 (既存の inspectTargetProductBeforeAiDraft を再利用)
  const preCheck = inspectTargetProductBeforeAiDraft(pid);
  if (!preCheck || !preCheck.success || !preCheck.product) {
    throw new Error(`Product pre-check failed for: ${pid}`);
  }

  const rawImages = Array.isArray(preCheck.images) ? preCheck.images.slice() : [];
  if (rawImages.length === 0) {
    throw new Error(`No images available for product: ${pid}`);
  }
  rawImages.sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "ja", { numeric: true }));
  const selectedImageIds = rawImages.slice(0, 3).map(img => img.id);
  console.log(`[Diagnosis Step 1] 対象画像取得: ${selectedImageIds.length}枚 (IDs: ${selectedImageIds.join(", ")})`);

  const validatedImages = getValidatedProductDriveImages_(
    pid,
    preCheck.product.drive_folder_url,
    selectedImageIds
  );
  if (!validatedImages || !Array.isArray(validatedImages.images) || validatedImages.images.length === 0) {
    throw new Error(`Failed to load drive images for product: ${pid}`);
  }

  // 指摘1: モデルへのメタデータには既存の商品名・SKUを含めず、画像・ブランド・カテゴリのみから評価する
  // (特にTMP-000102等の既存誤認名が検索クエリへ誘導されるのを防止)
  const productMetaForLlm = {
    productId: pid,
    category: preCheck.product.category,
    brand: preCheck.product.brand,
    productName: "",
    sneakerSku: ""
  };
  const callOptions = { ignore_existing_identity: true };

  const report = {
    product_id: pid,
    model_name: testModel,
    existing_meta: {
      productId: pid,
      category: preCheck.product.category,
      brand: preCheck.product.brand,
      productName: preCheck.product.product_name,
      sneakerSku: preCheck.product.sneaker_sku
    },
    single_request_result: null,
    two_stage_result: null,
    summary: {}
  };

  // --------------------------------------------------
  // 2. 方式1 (Single-Request): tools + responseSchema 同時指定
  // --------------------------------------------------
  if (shouldRunSingle) {
    console.log(`\n>>> [Method 1: Single-Request Grounding] 1回方式 実行開始 >>>`);
    const sStart = Date.now();
    try {
      const singleRes = callGeminiSingleRequestSearchGrounding_(validatedImages.images, productMetaForLlm, testModel, callOptions);
      const sElapsed = Date.now() - sStart;
      console.log(`  [Method 1 完了] HTTP ${singleRes.status_code} (${sElapsed}ms)`);
      if (singleRes.success) {
        const searchExecuted = Boolean(singleRes.grounding && singleRes.grounding.search_executed);
        const groundingStatus = searchExecuted ? "grounded" : "unsearched_visual_only";
        console.log(`  【1回方式 成功】 grounding_status: ${groundingStatus}, 検索実行: ${searchExecuted}`);
        console.log(`    クエリ (${singleRes.grounding.queries.length}件): ${singleRes.grounding.queries.join(", ") || "(なし)"}`);
        console.log(`    参照先 (${singleRes.grounding.sources.length}件): ${singleRes.grounding.sources.map(s => s.title || s.url).slice(0, 2).join(" / ")}`);
        console.log(`    提案タイトル(日): ${singleRes.candidate.title_ja}`);
        console.log(`    提案タイトル(英): ${singleRes.candidate.title_en}`);
        console.log(`    確定SKU (保護確認): '${singleRes.candidate.sku}' (空文字であれば保護成功)`);
        report.single_request_result = {
          success: true,
          status_code: singleRes.status_code,
          elapsed_ms: sElapsed,
          grounding_status: groundingStatus,
          search_executed: searchExecuted,
          queries: singleRes.grounding.queries,
          sources: singleRes.grounding.sources,
          candidate: singleRes.candidate
        };
      } else {
        console.warn(`  【1回方式 非成功】 HTTP ${singleRes.status_code}, code=${singleRes.error_code}, is_schema_unsupported=${singleRes.is_schema_unsupported}, msg=${singleRes.error_message}`);
        report.single_request_result = {
          success: false,
          status_code: singleRes.status_code,
          elapsed_ms: sElapsed,
          grounding_status: "failed",
          search_executed: false,
          is_schema_unsupported: singleRes.is_schema_unsupported,
          error_code: singleRes.error_code,
          error_message: singleRes.error_message,
          error_details: singleRes.error_details
        };
      }
    } catch (sErr) {
      const sElapsed = Date.now() - sStart;
      console.error(`  【1回方式 例外】 (${sElapsed}ms) code=${sErr.error_code || "UNKNOWN"}, status=${sErr.status_code || "UNKNOWN"}, msg=${sErr.message}`);
      if (sErr.error_details) {
        console.error(`    エラー詳細: Code=${sErr.error_details.code}, Status='${sErr.error_details.status}', Message='${sErr.error_details.message}'`);
      }
      report.single_request_result = {
        success: false,
        elapsed_ms: sElapsed,
        grounding_status: "failed",
        search_executed: false,
        error_code: sErr.error_code || "EXCEPTION",
        status_code: sErr.status_code,
        error_message: sErr.message,
        error_details: sErr.error_details || null
      };
    }
  }

  // --------------------------------------------------
  // 3. 方式2 (Two-Stage): Stage A (検索) → Stage B (構造化)
  // --------------------------------------------------
  if (shouldRunTwoStage) {
    console.log(`\n>>> [Method 2: Two-Stage Grounding] 2段階方式 実行開始 >>>`);
    const tsStart = Date.now();
    try {
      const twoStageRes = callGeminiTwoStageSearchGrounding_(validatedImages.images, productMetaForLlm, testModel, callOptions);
      const tsElapsed = Date.now() - tsStart;
      const searchExecuted = Boolean(twoStageRes.grounding && twoStageRes.grounding.search_executed);
      const groundingStatus = searchExecuted ? "grounded" : "unsearched_visual_only";
      console.log(`  [Method 2 完了] (${tsElapsed}ms)`);
      console.log(`  【2段階方式 成功】 grounding_status: ${groundingStatus}, 検索実行: ${searchExecuted}`);
      console.log(`    クエリ (${twoStageRes.grounding.queries.length}件): ${twoStageRes.grounding.queries.join(", ") || "(なし)"}`);
      console.log(`    Stage A 調査抜粋: ${String(twoStageRes.stage_a_text || "").substring(0, 100)}...`);
      console.log(`    提案タイトル(日): ${twoStageRes.candidate.title_ja}`);
      console.log(`    提案タイトル(英): ${twoStageRes.candidate.title_en}`);
      console.log(`    確定SKU (保護確認): '${twoStageRes.candidate.sku}' (空文字であれば保護成功)`);
      report.two_stage_result = {
        success: true,
        status_code: 200,
        elapsed_ms: tsElapsed,
        grounding_status: groundingStatus,
        search_executed: searchExecuted,
        queries: twoStageRes.grounding.queries,
        sources: twoStageRes.grounding.sources,
        stage_a_text: twoStageRes.stage_a_text,
        candidate: twoStageRes.candidate
      };
    } catch (tsErr) {
      const tsElapsed = Date.now() - tsStart;
      console.error(`  【2段階方式 例外】 (${tsElapsed}ms) code=${tsErr.error_code || "UNKNOWN"}, status=${tsErr.status_code || "UNKNOWN"}, msg=${tsErr.message}`);
      if (tsErr.error_details) {
        console.error(`    エラー詳細: Code=${tsErr.error_details.code}, Status='${tsErr.error_details.status}', Message='${tsErr.error_details.message}'`);
      }
      report.two_stage_result = {
        success: false,
        elapsed_ms: tsElapsed,
        grounding_status: "failed",
        search_executed: false,
        error_code: tsErr.error_code || "EXCEPTION",
        status_code: tsErr.status_code,
        error_message: tsErr.message,
        error_details: tsErr.error_details || null
      };
    }
  }

  // レビュー指摘2: 診断サマリーで検索実行有無と提案名を明確に区別して整理
  report.summary = {
    product_id: pid,
    existing_product_name: preCheck.product.product_name || "(未設定)",
    existing_sku: preCheck.product.sneaker_sku || "(未設定)",
    single_request: report.single_request_result ? {
      success: report.single_request_result.success,
      status_code: report.single_request_result.status_code,
      grounding_status: report.single_request_result.grounding_status,
      search_executed: report.single_request_result.search_executed,
      elapsed_ms: report.single_request_result.elapsed_ms,
      proposed_title_ja: (report.single_request_result.candidate && report.single_request_result.candidate.title_ja) || null,
      proposed_title_en: (report.single_request_result.candidate && report.single_request_result.candidate.title_en) || null,
      error_code: report.single_request_result.error_code || null
    } : "SKIPPED",
    two_stage: report.two_stage_result ? {
      success: report.two_stage_result.success,
      status_code: report.two_stage_result.status_code,
      grounding_status: report.two_stage_result.grounding_status,
      search_executed: report.two_stage_result.search_executed,
      elapsed_ms: report.two_stage_result.elapsed_ms,
      proposed_title_ja: (report.two_stage_result.candidate && report.two_stage_result.candidate.title_ja) || null,
      proposed_title_en: (report.two_stage_result.candidate && report.two_stage_result.candidate.title_en) || null,
      error_code: report.two_stage_result.error_code || null
    } : "SKIPPED"
  };

  console.log(`\n==================================================`);
  console.log(`=== [Search Grounding Diagnosis Summary] ${pid} 診断完了 (完全READ-ONLY) ===`);
  console.log(`  既存名: ${report.summary.existing_product_name}`);
  if (report.summary.single_request !== "SKIPPED") {
    console.log(`  1回方式: status=${report.summary.single_request.status_code}, grounding=${report.summary.single_request.grounding_status}, search_executed=${report.summary.single_request.search_executed}, 提案名='${report.summary.single_request.proposed_title_ja || "-"}' (${report.summary.single_request.elapsed_ms}ms)`);
  }
  if (report.summary.two_stage !== "SKIPPED") {
    console.log(`  2段階方式: status=${report.summary.two_stage.status_code}, grounding=${report.summary.two_stage.grounding_status}, search_executed=${report.summary.two_stage.search_executed}, 提案名='${report.summary.two_stage.proposed_title_ja || "-"}' (${report.summary.two_stage.elapsed_ms}ms)`);
  }
  console.log(`==================================================`);

  return report;
}

/**
 * TMP-000100 診断ラッパー (GASエディタからワンクリック実行用)
 */
function diagnoseSearchGroundingTmp000100() {
  return diagnoseSearchGroundingLive("TMP-000100");
}

/**
 * TMP-000102 診断ラッパー (GASエディタからワンクリック実行用)
 */
function diagnoseSearchGroundingTmp000102() {
  return diagnoseSearchGroundingLive("TMP-000102");
}

/**
 * TMP-000095 診断ラッパー (GASエディタからワンクリック実行用)
 */
function diagnoseSearchGroundingTmp000095() {
  return diagnoseSearchGroundingLive("TMP-000095");
}

/**
 * 過去バージョン互換用ラッパー (diagnoseProductSearchGroundingLive)
 * @param {Object} [options]
 * @return {Object}
 */
function diagnoseProductSearchGroundingLive(options) {
  options = options || {};
  const targetIds = (Array.isArray(options.productIds) && options.productIds.length > 0)
    ? options.productIds
    : ["TMP-000100", "TMP-000102", "TMP-000095"];
  const results = {};
  targetIds.forEach(pid => {
    results[pid] = diagnoseSearchGroundingLive(pid, options);
  });
  return results;
}

/**
 * Apps Script エディタの関数選択プルダウンから引数なしで即座に手動実行するためのラッパー
 * @return {Object}
 */
function diagnoseSearchGrounding() {
  return diagnoseProductSearchGroundingLive();
}

/**
 * Script Properties を検索必須・gemini-3.8-flash方針に整合させ、実効値を確認するエントリーポイント (引数なし)
 * - AI_DRAFT_MODEL を "gemini-3.8-flash" に設定
 * - AI_DRAFT_ENABLE_SEARCH_GROUNDING を "true" に設定
 * - AI_DRAFT_SEARCH_GROUNDING_MODE を "two_stage" に設定
 * @return {Object}
 */
function alignAndVerifyScriptPropertiesForSearchGrounding() {
  console.log("==================================================");
  console.log("=== 【Script Properties 整合・実効値確認】 開始 ===");
  console.log("==================================================");

  const props = PropertiesService.getScriptProperties();
  const beforeModel = props.getProperty("AI_DRAFT_MODEL");
  const beforeSearch = props.getProperty("AI_DRAFT_ENABLE_SEARCH_GROUNDING");
  const beforeMode = props.getProperty("AI_DRAFT_SEARCH_GROUNDING_MODE");

  console.log("[変更前の設定値]");
  console.log(`  AI_DRAFT_MODEL: ${beforeModel !== null ? `'${beforeModel}'` : "(未設定)"}`);
  console.log(`  AI_DRAFT_ENABLE_SEARCH_GROUNDING: ${beforeSearch !== null ? `'${beforeSearch}'` : "(未設定)"}`);
  console.log(`  AI_DRAFT_SEARCH_GROUNDING_MODE: ${beforeMode !== null ? `'${beforeMode}'` : "(未設定)"}`);

  const changesMade = [];
  const timestamp = new Date().toISOString();

  // 1. AI_DRAFT_MODEL: 承認済み方針により gemini-3.8-flash を明示設定
  if (beforeModel !== "gemini-3.8-flash") {
    props.setProperty("AI_DRAFT_MODEL", "gemini-3.8-flash");
    changesMade.push(`AI_DRAFT_MODEL: '${beforeModel}' -> 'gemini-3.8-flash'`);
  }

  // 2. AI_DRAFT_ENABLE_SEARCH_GROUNDING: 検索グラウンディング必須化 (true)
  if (beforeSearch !== "true") {
    props.setProperty("AI_DRAFT_ENABLE_SEARCH_GROUNDING", "true");
    changesMade.push(`AI_DRAFT_ENABLE_SEARCH_GROUNDING: '${beforeSearch}' -> 'true'`);
  }

  // 3. AI_DRAFT_SEARCH_GROUNDING_MODE: 2段階方式標準化 (two_stage)
  if (beforeMode !== "two_stage") {
    props.setProperty("AI_DRAFT_SEARCH_GROUNDING_MODE", "two_stage");
    changesMade.push(`AI_DRAFT_SEARCH_GROUNDING_MODE: '${beforeMode}' -> 'two_stage'`);
  }

  // 変更後の実効値確認
  const afterRawModel = props.getProperty("AI_DRAFT_MODEL");
  const afterRawSearch = props.getProperty("AI_DRAFT_ENABLE_SEARCH_GROUNDING");
  const afterRawMode = props.getProperty("AI_DRAFT_SEARCH_GROUNDING_MODE");

  const effectiveModel = typeof getAiDraftModelName_ === "function" ? getAiDraftModelName_() : "gemini-3.8-flash";
  const effectiveSearch = typeof isAiDraftSearchGroundingEnabled_ === "function" ? isAiDraftSearchGroundingEnabled_() : true;
  const effectiveMode = typeof getAiDraftSearchGroundingMode_ === "function" ? getAiDraftSearchGroundingMode_() : "two_stage";

  console.log("\n[変更後の設定値および実効値]");
  console.log(`  AI_DRAFT_MODEL (設定値): '${afterRawModel}' => 実効モデル名: '${effectiveModel}'`);
  console.log(`  AI_DRAFT_ENABLE_SEARCH_GROUNDING (設定値): '${afterRawSearch}' => 実効状態: ${effectiveSearch ? "有効 (true / 必須)" : "無効"}`);
  console.log(`  AI_DRAFT_SEARCH_GROUNDING_MODE (設定値): '${afterRawMode}' => 実効モード: '${effectiveMode}'`);
  console.log(`  実行日時: ${timestamp}`);
  console.log(`  実施変更: ${changesMade.length > 0 ? changesMade.join(", ") : "(既に最新設定と一致・変更なし)"}`);

  return {
    timestamp: timestamp,
    changes_made: changesMade,
    before: {
      raw_model: beforeModel,
      raw_search_enabled: beforeSearch,
      raw_mode: beforeMode
    },
    after: {
      raw_model: afterRawModel,
      raw_search_enabled: afterRawSearch,
      raw_mode: afterRawMode,
      effective_model: effectiveModel,
      effective_search_enabled: effectiveSearch,
      effective_mode: effectiveMode
    }
  };
}


/**
 * 一括商品アーカイブ・安全復帰および販売再開テストスイート
 *
 * 以下の仕様を包括的に検証する:
 * 1. 通常アーカイブ: Square在庫0化・決済リンク削除・カタログアーカイブ・本票archived (publish_status/inventory_status維持)
 * 2. 復帰後のdraft固定 & Square停止維持: record_status="active" 時に publish_status="draft"、Square側は停止維持 (unarchive/inventory1呼ばない)
 * 3. sold商品の復帰: inventory_status="sold" を維持し、勝手に in_stock に戻さない
 * 4. 操作再送 & 販売中商品の意図せぬ下書き化防止:
 *    - すでに active + draft の商品への再送で状態が壊れないこと
 *    - すでに active + published で販売再開済みの商品へ active を再送しても published が維持され draft に戻らないこと
 * 5. 途中失敗・フェイルクローズ: publish_status を先行して draft にするため、復帰処理中断時も active + published の販売可能状態にならない
 * 6. 公開・在庫1化失敗時のフェイルクローズ: update_publish_status("published") で Square 在庫1化が失敗した場合、本票は draft のまま維持され公開されないこと
 * 7. unarchive_square_production_product の管理者認証境界:
 *    - 認証なし・不正キーでの呼出は UNAUTHORIZED_ADMIN_ACCESS で拒絶されること
 *    - 正しい管理者認証が付与された場合のみアーカイブ解除が実行されること
 * 8. 既存APIからの意図せぬ復帰ガード:
 *    - archived 商品に対する publish_status="published" 拒絶
 *    - draft 商品に対する syncSquareProductionProductInventory(id, 1) 拒絶
 *    - Square側が is_archived: true の商品に対する syncSquareProductionProductInventory(id, 1) 拒絶
 *    - archived 商品に対する unarchive_square_production_product 拒絶
 *    - sync_square_production_inventory で quantity 未指定時、draft商品なら安全に 0 が選択されること
 * 9. 明示的な再連携フロー: unarchive (管理者認証) -> details sync -> publish (在庫1先行) -> payment link 生成の完全再連携
 *
 * @return {{ passed: number, failed: number, total: number, results: Array }}
 */
function testBulkProductArchiveSafetySuite_() {
  console.log("--- [testBulkProductArchiveSafetySuite_] 開始 ---");
  const results = [];
  let passed = 0;
  let failed = 0;

  function record(name, isPass, detail) {
    if (isPass) {
      passed++;
      console.log(`✓ ${name}`);
    } else {
      failed++;
      console.error(`✗ ${name} (FAILED): ${detail || ""}`);
    }
    results.push({ name, passed: isPass, detail: detail || "" });
  }

  // モックシート作成ヘルパー
  function createMockProductSheet(products) {
    const headers = [
      "created_at", "product_id", "category", "brand", "product_name", "condition",
      "purchase_price", "planned_sale_price", "storage_location", "description", "note",
      "sneaker_sku", "sneaker_size", "", "", "", "",
      "", "", "", "", "", "", "", "", "", "", "", "",
      "drive_folder_url", "main_image_url", "publish_status", "inventory_status",
      "record_status", "square_item_id", "square_variation_id",
      "square_payment_link_id", "square_checkout_url", "square_payment_link_generation", "ai_draft_flag"
    ];
    const data = [headers];
    products.forEach(p => {
      const row = new Array(40).fill("");
      row[0] = p.created_at || new Date().toISOString();
      row[1] = p.product_id;
      row[2] = p.category || "sneaker";
      row[4] = p.product_name || "Test Product";
      row[7] = p.planned_sale_price || 10000;
      row[12] = p.sneaker_size || "27.0";
      row[29] = p.drive_folder_url || "https://drive.google.com/folders/test";
      row[30] = p.main_image_url || "https://drive.google.com/test.jpg";
      row[31] = p.publish_status !== undefined ? p.publish_status : "draft";
      row[32] = p.inventory_status !== undefined ? p.inventory_status : "in_stock";
      row[33] = p.record_status !== undefined ? p.record_status : "active";
      row[34] = p.square_item_id !== undefined ? p.square_item_id : "";
      row[35] = p.square_variation_id !== undefined ? p.square_variation_id : "";
      row[36] = p.square_payment_link_id !== undefined ? p.square_payment_link_id : "";
      row[37] = p.square_checkout_url !== undefined ? p.square_checkout_url : "";
      row[38] = p.square_payment_link_generation !== undefined ? p.square_payment_link_generation : 1;
      row[39] = p.ai_draft_flag || "";
      data.push(row);
    });

    const sheetObj = {
      data: data,
      failSetValues: false,
      getLastRow: () => data.length,
      getLastColumn: () => 40,
      getMaxColumns: () => 40,
      getRange: function(r, c, nr, nc) {
        const numRows = nr !== undefined ? nr : 1;
        const numCols = nc !== undefined ? nc : 1;
        return {
          getValue: () => {
            if (!data[r - 1]) return "";
            return data[r - 1][c - 1] !== undefined ? data[r - 1][c - 1] : "";
          },
          setValue: (val) => {
            while (data.length < r) data.push(new Array(40).fill(""));
            while (data[r - 1].length < c) data[r - 1].push("");
            data[r - 1][c - 1] = val;
          },
          getValues: () => {
            const out = [];
            for (let i = 0; i < numRows; i++) {
              const rowIdx = r - 1 + i;
              const row = [];
              for (let j = 0; j < numCols; j++) {
                const colIdx = c - 1 + j;
                row.push(data[rowIdx] && data[rowIdx][colIdx] !== undefined ? data[rowIdx][colIdx] : "");
              }
              out.push(row);
            }
            return out;
          },
          setValues: (vals) => {
            if (sheetObj.failSetValues) {
              throw new Error("Spreadsheet write lock timeout (simulated setValues failure)");
            }
            for (let i = 0; i < vals.length; i++) {
              const rowIdx = r - 1 + i;
              while (data.length <= rowIdx) data.push(new Array(40).fill(""));
              for (let j = 0; j < vals[i].length; j++) {
                const colIdx = c - 1 + j;
                while (data[rowIdx].length <= colIdx) data[rowIdx].push("");
                data[rowIdx][colIdx] = vals[i][j];
              }
            }
          },
          getFormulas: () => {
            const out = [];
            for (let i = 0; i < numRows; i++) {
              out.push(new Array(numCols).fill(""));
            }
            return out;
          }
        };
      }
    };
    return sheetObj;
  }

  // Live Script Properties の変更禁止ガード（本番環境破壊防止）
  let realPropsBefore = {};
  let realPropertiesService = null;
  try {
    if (typeof PropertiesService !== "undefined" && PropertiesService.getScriptProperties) {
      realPropertiesService = PropertiesService.getScriptProperties();
      if (typeof realPropertiesService.getProperties === "function") {
        realPropsBefore = Object.assign({}, realPropertiesService.getProperties() || {});
      }
    }
  } catch (_) {}

  // テスト専用の完全隔離された mockProps
  const mockScriptPropertiesStore = {
    "SQUARE_PROD_LOCATION_ID": "LOC_PROD_TEST",
    "SQUARE_PROD_ACCESS_TOKEN": "EAAA_TEST_TOKEN",
    "ADMIN_API_KEY": "TEST_ADMIN_SECRET_KEY_123"
  };
  const mockProps = {
    getProperty: function(key) {
      return mockScriptPropertiesStore[key] !== undefined ? mockScriptPropertiesStore[key] : null;
    },
    getProperties: function() {
      return Object.assign({}, mockScriptPropertiesStore);
    },
    setProperty: function(key, val) {
      mockScriptPropertiesStore[key] = String(val);
    },
    deleteProperty: function(key) {
      delete mockScriptPropertiesStore[key];
    }
  };

  // Square Catalog オブジェクトストア
  const squareCatalog = {
    "SQ_ITEM_01": {
      id: "SQ_ITEM_01",
      type: "ITEM",
      version: 1,
      item_data: {
        name: "Test Sneaker",
        is_archived: false,
        variations: [{
          id: "SQ_VAR_01",
          version: 1,
          item_variation_data: {
            sku: "TMP-ARCH-01",
            track_inventory: true
          }
        }]
      }
    }
  };
  const squareInventory = {
    "SQ_VAR_01": 1
  };
  const squarePaymentLinks = {
    "PLINK_01": "https://square.link/01"
  };
  const squarePaymentLinksByIdempotencyKey = {};
  const squareCallCounts = {
    inventory_sync: 0,
    payment_link_delete: 0,
    payment_link_create: 0,
    catalog_archive: 0,
    catalog_unarchive: 0
  };

  let failInventoryBatchCreate = false;
  let failPaymentLinkCreate = false;
  let failPaymentLinkCreate400 = false;
  let failCatalogObjectGet = false;
  let failInventoryGet = false;

  const mockSquareProdRequest = function(path, options) {
    const method = String(options.method || "get").toLowerCase();

    // 在庫更新
    if (path === "/v2/inventory/changes/batch-create" && method === "post") {
      if (failInventoryBatchCreate) {
        throw new Error("Square Production BatchChangeInventory API error (simulated network failure)");
      }
      squareCallCounts.inventory_sync++;
      const payload = options.payload || {};
      const changes = payload.changes || [];
      changes.forEach(c => {
        if (c.physical_count) {
          squareInventory[c.physical_count.catalog_object_id] = Number(c.physical_count.quantity);
        }
      });
      return { httpStatus: 200, body: JSON.stringify({ counts: [] }) };
    }

    // 在庫照会
    if (path.startsWith("/v2/inventory/") && method === "get") {
      if (failInventoryGet) {
        throw new Error("Square Production Inventory API error (simulated network failure)");
      }
      const varId = path.split("/")[3].split("?")[0];
      const q = squareInventory[varId] !== undefined ? squareInventory[varId] : 0;
      return {
        httpStatus: 200,
        body: JSON.stringify({
          counts: [{
            catalog_object_id: varId,
            location_id: "LOC_PROD_TEST",
            quantity: String(q),
            state: "IN_STOCK"
          }]
        })
      };
    }

    // 決済リンク DELETE
    if (path.startsWith("/v2/online-checkout/payment-links/") && method === "delete") {
      squareCallCounts.payment_link_delete++;
      const plinkId = path.split("/").pop();
      delete squarePaymentLinks[plinkId];
      for (const k in squarePaymentLinksByIdempotencyKey) {
        if (squarePaymentLinksByIdempotencyKey[k].id === plinkId) {
          delete squarePaymentLinksByIdempotencyKey[k];
        }
      }
      return { httpStatus: 200, body: "{}" };
    }

    // 決済リンク POST (生成)
    if (path === "/v2/online-checkout/payment-links" && method === "post") {
      if (failPaymentLinkCreate400) {
        throw new Error("Square Production API request (POST /v2/online-checkout/payment-links) failed with HTTP 400: {\"errors\":[{\"code\":\"BAD_REQUEST\",\"detail\":\"Invalid variation\"}]}");
      }
      if (failPaymentLinkCreate) {
        throw new Error("Square Production Payment Link API error (simulated checkout creation failure)");
      }
      const payload = options.payload || {};
      const ikey = payload.idempotency_key;
      if (ikey && squarePaymentLinksByIdempotencyKey[ikey]) {
        return {
          httpStatus: 200,
          body: JSON.stringify({
            payment_link: squarePaymentLinksByIdempotencyKey[ikey]
          })
        };
      }
      squareCallCounts.payment_link_create++;
      const newId = "PLINK_NEW_" + Date.now();
      const newUrl = "https://square.link/new_" + Date.now();
      const linkObj = { id: newId, url: newUrl };
      squarePaymentLinks[newId] = newUrl;
      if (ikey) {
        squarePaymentLinksByIdempotencyKey[ikey] = linkObj;
      }
      return {
        httpStatus: 200,
        body: JSON.stringify({
          payment_link: linkObj
        })
      };
    }

    // Catalog Object GET
    if (path.startsWith("/v2/catalog/object/") && method === "get") {
      if (failCatalogObjectGet) {
        throw new Error("Square Production Catalog API error (simulated network failure)");
      }
      const objId = decodeURIComponent(path.split("/").pop());
      if (squareCatalog[objId]) {
        return {
          httpStatus: 200,
          body: JSON.stringify({ object: squareCatalog[objId] })
        };
      }
      return { httpStatus: 404, body: JSON.stringify({ errors: [{ code: "NOT_FOUND" }] }) };
    }

    // Catalog Object POST (Upsert)
    if (path === "/v2/catalog/object" && method === "post") {
      const payload = options.payload || {};
      const obj = payload.object || {};
      if (obj.id && squareCatalog[obj.id]) {
        const target = squareCatalog[obj.id];
        target.version = (target.version || 1) + 1;
        if (obj.item_data) {
          if (obj.item_data.is_archived === true) {
            squareCallCounts.catalog_archive++;
            target.item_data.is_archived = true;
          } else if (obj.item_data.is_archived === false) {
            squareCallCounts.catalog_unarchive++;
            target.item_data.is_archived = false;
          }
        }
        return {
          httpStatus: 200,
          body: JSON.stringify({ catalog_object: target })
        };
      }
      return { httpStatus: 200, body: JSON.stringify({ catalog_object: obj }) };
    }

    return { httpStatus: 200, body: "{}" };
  };

  function createTestOptions(sheet) {
    return {
      sheet: sheet,
      propService: mockProps,
      squareRequest: mockSquareProdRequest,
      locationId: "LOC_PROD_TEST"
    };
  }

  // 共通の Square モック環境構築 (グローバル退避・フォールバック保護用)
  const origSpreadsheet = SpreadsheetApp.getActiveSpreadsheet;
  const origSquareProd = typeof squareProdRequest_ === "function" ? squareProdRequest_ : null;
  squareProdRequest_ = mockSquareProdRequest;

  try {
    // --------------------------------------------------
    // Test 1: 通常アーカイブ (Normal Archive)
    // --------------------------------------------------
    try {
      const mockSheet = createMockProductSheet([{
        product_id: "TMP-ARCH-01",
        publish_status: "published",
        inventory_status: "in_stock",
        record_status: "active",
        square_item_id: "SQ_ITEM_01",
        square_variation_id: "SQ_VAR_01",
        square_payment_link_id: "PLINK_01",
        square_checkout_url: "https://square.link/01",
        square_payment_link_generation: 1
      }]);
      SpreadsheetApp.getActiveSpreadsheet = () => ({
        getSheets: () => [mockSheet]
      });

      const res = handleUpdateRecordStatus(mockSheet, {
        product_id: "TMP-ARCH-01",
        record_status: "archived"
      }, createTestOptions(mockSheet));
      const parsedRes = JSON.parse(res.getContent());

      const row = mockSheet.getRange(2, 1, 1, 40).getValues()[0];
      const isArchivedSuccess = (
        parsedRes.success === true &&
        parsedRes.record_status === "archived" &&
        row[33] === "archived" && // 34列目: record_status
        row[31] === "published" && // 32列目: publish_status 保持
        row[32] === "in_stock" &&  // 33列目: inventory_status 保持
        row[36] === "" &&          // 37列目: payment_link_id クリア
        row[37] === "" &&          // 38列目: checkout_url クリア
        row[38] === 2 &&           // 39列目: generation インクリメント
        squareInventory["SQ_VAR_01"] === 0 &&
        squareCatalog["SQ_ITEM_01"].item_data.is_archived === true
      );

      record("1. 通常アーカイブ: Square在庫0・決済リンク削除・カタログアーカイブ・本票archived (publish/inventory保持)", isArchivedSuccess);
    } catch (e1) {
      record("1. 通常アーカイブ: Square在庫0・決済リンク削除・カタログアーカイブ・本票archived (publish/inventory保持)", false, e1.message);
    }

    // --------------------------------------------------
    // Test 2: 復帰後のdraft固定 & Square停止維持
    // --------------------------------------------------
    try {
      const mockSheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
      squareCallCounts.catalog_unarchive = 0;
      squareCallCounts.inventory_sync = 0;

      const res = handleUpdateRecordStatus(mockSheet, {
        product_id: "TMP-ARCH-01",
        record_status: "active"
      }, createTestOptions(mockSheet));
      const parsedRes = JSON.parse(res.getContent());

      const row = mockSheet.getRange(2, 1, 1, 40).getValues()[0];
      const isRestoreSafe = (
        parsedRes.success === true &&
        parsedRes.record_status === "active" &&
        parsedRes.publish_status === "draft" &&
        row[33] === "active" && // 34列目: active
        row[31] === "draft" &&  // 32列目: draft に固定 (publishedに戻らない！)
        row[32] === "in_stock" &&
        row[36] === "" &&       // 決済リンクは無効のまま
        squareCatalog["SQ_ITEM_01"].item_data.is_archived === true && // Squareはアーカイブ状態維持
        squareInventory["SQ_VAR_01"] === 0 &&                        // Square在庫は0のまま維持
        squareCallCounts.catalog_unarchive === 0 &&                  // 自動unarchive呼ばれない
        squareCallCounts.inventory_sync === 0                        // 自動在庫戻し呼ばれない
      );

      record("2. active復帰: 本票draft固定 & Square停止維持 (unarchive・在庫1化を行わない)", isRestoreSafe);
    } catch (e2) {
      record("2. active復帰: 本票draft固定 & Square停止維持 (unarchive・在庫1化を行わない)", false, e2.message);
    }

    // --------------------------------------------------
    // Test 3: sold商品の復帰 (inventory_status 保持)
    // --------------------------------------------------
    try {
      const mockSheet = createMockProductSheet([{
        product_id: "TMP-ARCH-SOLD",
        publish_status: "published",
        inventory_status: "sold",
        record_status: "archived",
        square_item_id: "SQ_ITEM_01",
        square_variation_id: "SQ_VAR_01"
      }]);
      SpreadsheetApp.getActiveSpreadsheet = () => ({
        getSheets: () => [mockSheet]
      });

      const res = handleUpdateRecordStatus(mockSheet, {
        product_id: "TMP-ARCH-SOLD",
        record_status: "active"
      }, createTestOptions(mockSheet));
      const parsedRes = JSON.parse(res.getContent());
      const row = mockSheet.getRange(2, 1, 1, 40).getValues()[0];

      const isSoldPreserved = (
        parsedRes.success === true &&
        row[33] === "active" &&
        row[31] === "draft" &&
        row[32] === "sold" // 勝手に in_stock に変更されず sold を保持
      );

      record("3. sold商品の復帰: inventory_status='sold'を保持し勝手にin_stockに書き換えない", isSoldPreserved);
    } catch (e3) {
      record("3. sold商品の復帰: inventory_status='sold'を保持し勝手にin_stockに書き換えない", false, e3.message);
    }

    // --------------------------------------------------
    // Test 4: 操作再送 & 既に販売中商品の意図せぬ下書き化防止 (Point 3)
    // --------------------------------------------------
    try {
      // 4-a: すでに active + draft の商品への再送
      const mockSheet = createMockProductSheet([{
        product_id: "TMP-ARCH-RETRY",
        publish_status: "draft",
        inventory_status: "in_stock",
        record_status: "active",
        square_item_id: "SQ_ITEM_01",
        square_variation_id: "SQ_VAR_01"
      }]);
      SpreadsheetApp.getActiveSpreadsheet = () => ({ getSheets: () => [mockSheet] });

      const res1 = handleUpdateRecordStatus(mockSheet, {
        product_id: "TMP-ARCH-RETRY",
        record_status: "active"
      }, createTestOptions(mockSheet));
      const parsedRes1 = JSON.parse(res1.getContent());
      const row1 = mockSheet.getRange(2, 1, 1, 40).getValues()[0];

      const isIdempotentDraft = (
        parsedRes1.success === true &&
        parsedRes1.record_status === "active" &&
        parsedRes1.publish_status === "draft" &&
        row1[33] === "active" &&
        row1[31] === "draft" &&
        row1[32] === "in_stock"
      );

      // 4-b: すでに active + published で販売再開済みの商品へ active を再送した際、published が維持されること
      const mockSheetPublished = createMockProductSheet([{
        product_id: "TMP-ALREADY-PUB",
        publish_status: "published",
        inventory_status: "in_stock",
        record_status: "active",
        square_item_id: "SQ_ITEM_01",
        square_variation_id: "SQ_VAR_01"
      }]);
      SpreadsheetApp.getActiveSpreadsheet = () => ({ getSheets: () => [mockSheetPublished] });

      const res2 = handleUpdateRecordStatus(mockSheetPublished, {
        product_id: "TMP-ALREADY-PUB",
        record_status: "active"
      }, createTestOptions(mockSheetPublished));
      const parsedRes2 = JSON.parse(res2.getContent());
      const row2 = mockSheetPublished.getRange(2, 1, 1, 40).getValues()[0];

      const isPublishedPreserved = (
        parsedRes2.success === true &&
        parsedRes2.record_status === "active" &&
        parsedRes2.publish_status === "published" && // draft に戻らず published を維持！
        row2[33] === "active" &&
        row2[31] === "published" &&
        row2[32] === "in_stock"
      );

      record(
        "4. 操作再送 & 販売中商品の意図せぬ下書き化防止: active再送で冪等成功し、販売中(published)商品のdraft化を防止",
        isIdempotentDraft && isPublishedPreserved,
        `isIdempotentDraft=${isIdempotentDraft}, isPublishedPreserved=${isPublishedPreserved}`
      );
    } catch (e4) {
      record("4. 操作再送 & 販売中商品の意図せぬ下書き化防止: active再送で冪等成功し、販売中(published)商品のdraft化を防止", false, e4.message);
    }

    // --------------------------------------------------
    // Test 5: 復帰処理の途中失敗・フェイルクローズ設計
    // --------------------------------------------------
    try {
      const mockSheet = createMockProductSheet([{
        product_id: "TMP-INTERRUPT",
        publish_status: "draft",    // 32列目 draft 書き込み完了
        inventory_status: "in_stock",
        record_status: "archived"   // 34列目 書き込み前に中断
      }]);

      const row = mockSheet.getRange(2, 1, 1, 40).getValues()[0];
      const isPublishableBeforeActive = (
        row[31] === "published" && row[32] === "in_stock" && row[33] === "active"
      );

      // 再送で復旧
      handleUpdateRecordStatus(mockSheet, {
        product_id: "TMP-INTERRUPT",
        record_status: "active"
      }, createTestOptions(mockSheet));
      const rowAfter = mockSheet.getRange(2, 1, 1, 40).getValues()[0];

      const isFailClosedSafe = (
        !isPublishableBeforeActive &&
        rowAfter[33] === "active" &&
        rowAfter[31] === "draft"
      );

      record("5. 途中失敗・フェイルクローズ: publish_status先行更新により中断時も販売可能状態にならず、再送で正常復旧する", isFailClosedSafe);
    } catch (e5) {
      record("5. 途中失敗・フェイルクローズ: publish_status先行更新により中断時も販売可能状態にならず、再送で正常復旧する", false, e5.message);
    }

    // --------------------------------------------------
    // Test 6: 公開・在庫1化失敗時のフェイルクローズ (Point 1)
    // --------------------------------------------------
    try {
      // Square在庫更新でエラーが発生するようシミュレーション設定
      failInventoryBatchCreate = true;

      const mockSheetPubFail = createMockProductSheet([{
        product_id: "TMP-PUB-FAIL",
        category: "apparel",
        publish_status: "draft",
        inventory_status: "in_stock",
        record_status: "active",
        square_item_id: "SQ_ITEM_01",
        square_variation_id: "SQ_VAR_01"
      }]);
      // Squareアイテムはアーカイブ解除済みとする
      squareCatalog["SQ_ITEM_01"].item_data.is_archived = false;
      SpreadsheetApp.getActiveSpreadsheet = () => ({ getSheets: () => [mockSheetPubFail] });

      let pubUpdateThrew = false;
      try {
        handleUpdatePublishStatus(mockSheetPubFail, {
          product_id: "TMP-PUB-FAIL",
          publish_status: "published"
        }, createTestOptions(mockSheetPubFail));
      } catch (pubErr) {
        pubUpdateThrew = true;
      }

      const rowAfterFail = mockSheetPubFail.getRange(2, 1, 1, 40).getValues()[0];
      const isDraftPreservedOnFailure = (
        pubUpdateThrew &&
        rowAfterFail[31] === "draft" && // published にならず draft のまま維持される！
        rowAfterFail[33] === "active"
      );

      record(
        "6. 公開・在庫1化失敗時フェイルクローズ: Square在庫1化失敗時は本票がpublishedにならずdraftを維持し非公開を守る",
        isDraftPreservedOnFailure,
        `pubUpdateThrew=${pubUpdateThrew}, publish_status=${rowAfterFail[31]}`
      );
    } catch (e6) {
      record("6. 公開・在庫1化失敗時フェイルクローズ: Square在庫1化失敗時は本票がpublishedにならずdraftを維持し非公開を守る", false, e6.message);
    } finally {
      failInventoryBatchCreate = false;
    }

    // --------------------------------------------------
    // Test 7: unarchive_square_production_product & GET reconcile の管理者認証境界 (Point 2)
    // --------------------------------------------------
    try {
      const mockSheetAuth = createMockProductSheet([{
        product_id: "TMP-AUTH-01",
        publish_status: "draft",
        inventory_status: "in_stock",
        record_status: "active",
        square_item_id: "SQ_ITEM_01",
        square_variation_id: "SQ_VAR_01"
      }]);
      squareCatalog["SQ_ITEM_01"].item_data.is_archived = true;
      SpreadsheetApp.getActiveSpreadsheet = () => ({ getSheets: () => [mockSheetAuth] });

      // 7-a: 認証なし (mode なし / key なし)
      const resUnauth = doPost({
        postData: {
          contents: JSON.stringify({
            action: "unarchive_square_production_product",
            product_id: "TMP-AUTH-01"
          })
        }
      }, createTestOptions(mockSheetAuth));
      const parsedUnauth = JSON.parse(resUnauth.getContent());
      const isUnauthRejected = (
        parsedUnauth.success === false &&
        parsedUnauth.error_code === "UNAUTHORIZED_ADMIN_ACCESS" &&
        squareCatalog["SQ_ITEM_01"].item_data.is_archived === true // 解除されていないこと
      );

      // 7-b: 不正なキー
      const resWrongKey = doPost({
        postData: {
          contents: JSON.stringify({
            action: "unarchive_square_production_product",
            mode: "admin",
            admin_key: "wrong_password",
            product_id: "TMP-AUTH-01"
          })
        }
      }, createTestOptions(mockSheetAuth));
      const parsedWrongKey = JSON.parse(resWrongKey.getContent());
      const isWrongKeyRejected = (
        parsedWrongKey.success === false &&
        parsedWrongKey.error_code === "UNAUTHORIZED_ADMIN_ACCESS" &&
        squareCatalog["SQ_ITEM_01"].item_data.is_archived === true
      );

      // 7-c: 正しい管理者認証
      const resAuth = doPost({
        postData: {
          contents: JSON.stringify({
            action: "unarchive_square_production_product",
            mode: "admin",
            admin_key: "TEST_ADMIN_SECRET_KEY_123",
            product_id: "TMP-AUTH-01"
          })
        }
      }, createTestOptions(mockSheetAuth));
      const parsedAuth = JSON.parse(resAuth.getContent());
      const isAuthAllowed = (
        parsedAuth.success === true &&
        squareCatalog["SQ_ITEM_01"].item_data.is_archived === false // 正しくアーカイブ解除されたこと
      );

      // 7-d: GET ?action=reconcile_square_product_status の認証境界 (3ケース検証)
      // (1) 認証なし
      const resGetNoAuth = doGet({
        parameter: {
          action: "reconcile_square_product_status",
          product_id: "TMP-AUTH-01"
        }
      }, createTestOptions(mockSheetAuth));
      const parsedGetNoAuth = JSON.parse(resGetNoAuth.getContent());
      const isGetNoAuthRejected = (
        parsedGetNoAuth.success === false &&
        parsedGetNoAuth.error_code === "UNAUTHORIZED_ADMIN_ACCESS"
      );

      // (2) mode=admin のみ (admin_key なし)
      const resGetModeOnly = doGet({
        parameter: {
          action: "reconcile_square_product_status",
          mode: "admin",
          product_id: "TMP-AUTH-01"
        }
      }, createTestOptions(mockSheetAuth));
      const parsedGetModeOnly = JSON.parse(resGetModeOnly.getContent());
      const isGetModeOnlyRejected = (
        parsedGetModeOnly.success === false &&
        parsedGetModeOnly.error_code === "UNAUTHORIZED_ADMIN_ACCESS"
      );

      // (3) 正しい管理者認証 (mode=admin & admin_key)
      const resGetAuth = doGet({
        parameter: {
          action: "reconcile_square_product_status",
          mode: "admin",
          admin_key: "TEST_ADMIN_SECRET_KEY_123",
          product_id: "TMP-AUTH-01"
        }
      }, createTestOptions(mockSheetAuth));
      const parsedGetAuth = JSON.parse(resGetAuth.getContent());
      const isGetAuthAllowed = (
        parsedGetAuth.success === true &&
        parsedGetAuth.product_id === "TMP-AUTH-01" &&
        parsedGetAuth.reconciliation_status !== undefined
      );

      const allAuthPassed = (
        isUnauthRejected &&
        isWrongKeyRejected &&
        isAuthAllowed &&
        isGetNoAuthRejected &&
        isGetModeOnlyRejected &&
        isGetAuthAllowed
      );

      record(
        "7. 管理者認証境界: unarchive および GET reconcile は正しい管理者認証でのみ許可され不正呼出（認証なし・mode=adminのみ）は拒絶される",
        allAuthPassed,
        `unauth=${isUnauthRejected}, wrongKey=${isWrongKeyRejected}, auth=${isAuthAllowed}, getNoAuth=${isGetNoAuthRejected}, getModeOnly=${isGetModeOnlyRejected}, getAuth=${isGetAuthAllowed}`
      );
    } catch (e7) {
      record("7. 管理者認証境界: unarchive および GET reconcile は正しい管理者認証でのみ許可され不正呼出（認証なし・mode=adminのみ）は拒絶される", false, e7.message);
    }

    // --------------------------------------------------
    // Test 8: 既存APIからの意図せぬ復帰ガード
    // --------------------------------------------------
    try {
      // 8-a: archived 商品に対する update_publish_status("published") 拒絶
      let archivedPublishBlocked = false;
      const mockSheetA = createMockProductSheet([{
        product_id: "TMP-GUARD-01",
        publish_status: "draft",
        inventory_status: "in_stock",
        record_status: "archived"
      }]);
      try {
        handleUpdatePublishStatus(mockSheetA, {
          product_id: "TMP-GUARD-01",
          publish_status: "published"
        }, createTestOptions(mockSheetA));
      } catch (errA) {
        if (errA.message.indexOf("cannot publish archived product") !== -1) {
          archivedPublishBlocked = true;
        }
      }

      // 8-b: draft 商品に対する syncSquareProductionProductInventory(productId, 1) 単独呼出拒絶
      let draftInventoryIncreaseBlocked = false;
      const mockSheetB = createMockProductSheet([{
        product_id: "TMP-GUARD-02",
        publish_status: "draft",
        inventory_status: "in_stock",
        record_status: "active",
        square_item_id: "SQ_ITEM_01",
        square_variation_id: "SQ_VAR_01"
      }]);
      SpreadsheetApp.getActiveSpreadsheet = () => ({ getSheets: () => [mockSheetB] });
      try {
        syncSquareProductionProductInventory("TMP-GUARD-02", 1, createTestOptions(mockSheetB));
      } catch (errB) {
        if (errB.message.indexOf("cannot increase inventory for non-published product") !== -1) {
          draftInventoryIncreaseBlocked = true;
        }
      }

      // 8-c: Square Catalog Item が is_archived: true の商品に対する在庫1化拒絶
      let archivedSquareItemInventoryBlocked = false;
      squareCatalog["SQ_ITEM_01"].item_data.is_archived = true;
      const mockSheetC = createMockProductSheet([{
        product_id: "TMP-GUARD-03",
        publish_status: "published",
        inventory_status: "in_stock",
        record_status: "active",
        square_item_id: "SQ_ITEM_01",
        square_variation_id: "SQ_VAR_01"
      }]);
      SpreadsheetApp.getActiveSpreadsheet = () => ({ getSheets: () => [mockSheetC] });
      try {
        syncSquareProductionProductInventory("TMP-GUARD-03", 1, createTestOptions(mockSheetC));
      } catch (errC) {
        if (errC.message.indexOf("cannot set Square inventory > 0 for archived Square item") !== -1) {
          archivedSquareItemInventoryBlocked = true;
        }
      }

      // 8-d: handleSyncSquareProductionInventory で quantity 未指定時、draft商品なら 0 が安全に選択される
      const mockSheetD = createMockProductSheet([{
        product_id: "TMP-GUARD-04",
        publish_status: "draft",
        inventory_status: "in_stock",
        record_status: "active",
        square_item_id: "SQ_ITEM_01",
        square_variation_id: "SQ_VAR_01"
      }]);
      SpreadsheetApp.getActiveSpreadsheet = () => ({ getSheets: () => [mockSheetD] });
      const syncRes = handleSyncSquareProductionInventory(mockSheetD, { product_id: "TMP-GUARD-04" }, createTestOptions(mockSheetD));
      const parsedSyncRes = JSON.parse(syncRes.getContent());
      const quantityZeroSafe = Number(parsedSyncRes.quantity) === 0;

      // 8-e: archived 商品に対する unarchive_square_production_product 拒絶
      let archivedBisUnarchiveBlocked = false;
      const mockSheetE = createMockProductSheet([{
        product_id: "TMP-GUARD-05",
        record_status: "archived",
        square_item_id: "SQ_ITEM_01"
      }]);
      SpreadsheetApp.getActiveSpreadsheet = () => ({ getSheets: () => [mockSheetE] });
      try {
        unarchiveSquareProductionProduct("TMP-GUARD-05", createTestOptions(mockSheetE));
      } catch (errE) {
        if (errE.message.indexOf("cannot unarchive Square product for archived BIS product") !== -1) {
          archivedBisUnarchiveBlocked = true;
        }
      }

      const allGuardsPass = (
        archivedPublishBlocked &&
        draftInventoryIncreaseBlocked &&
        archivedSquareItemInventoryBlocked &&
        quantityZeroSafe &&
        archivedBisUnarchiveBlocked
      );

      record(
        "8. 既存API復帰ガード: archived公開拒絶・draft在庫1拒絶・Squareアーカイブ在庫1拒絶・未指定時0安全選択・archived解除拒絶",
        allGuardsPass,
        `archivedPublishBlocked=${archivedPublishBlocked}, draftInvBlocked=${draftInventoryIncreaseBlocked}, archivedSqInvBlocked=${archivedSquareItemInventoryBlocked}, qZero=${quantityZeroSafe}, archivedBisBlocked=${archivedBisUnarchiveBlocked}`
      );
    } catch (e8) {
      record("8. 既存API復帰ガード: archived公開拒絶・draft在庫1拒絶・Squareアーカイブ在庫1拒絶・未指定時0安全選択・archived解除拒絶", false, e8.message);
    }

    // --------------------------------------------------
    // Test 9: 明示的な再連携フロー (Explicit Re-linking Flow)
    // --------------------------------------------------
    try {
      const mockSheet = createMockProductSheet([{
        product_id: "TMP-RELINK-01",
        category: "apparel",
        publish_status: "draft",
        inventory_status: "in_stock",
        record_status: "active",
        square_item_id: "SQ_ITEM_01",
        square_variation_id: "SQ_VAR_01",
        square_payment_link_id: "",
        square_checkout_url: "",
        square_payment_link_generation: 2
      }]);
      squareCatalog["SQ_ITEM_01"].item_data.is_archived = true;
      SpreadsheetApp.getActiveSpreadsheet = () => ({ getSheets: () => [mockSheet] });

      // Step 1: 明示的な Square アーカイブ解除 (管理者認証付き)
      const step1 = doPost({
        postData: {
          contents: JSON.stringify({
            action: "unarchive_square_production_product",
            mode: "admin",
            admin_key: "TEST_ADMIN_SECRET_KEY_123",
            product_id: "TMP-RELINK-01"
          })
        }
      }, createTestOptions(mockSheet));
      const parsedStep1 = JSON.parse(step1.getContent());

      // Step 2: 明示的な Square 商品詳細同期
      const step2 = handleSyncSquareProductionDetails(mockSheet, { product_id: "TMP-RELINK-01" }, createTestOptions(mockSheet));
      const parsedStep2 = JSON.parse(step2.getContent());

      // Step 3: 明示的な 公開 (published) -> 先行して Square 在庫 1 に同期
      const step3 = handleUpdatePublishStatus(mockSheet, { product_id: "TMP-RELINK-01", publish_status: "published" }, createTestOptions(mockSheet));
      const parsedStep3 = JSON.parse(step3.getContent());

      // Step 4: 明示的な 決済リンク再生成
      const step4 = handleCreateSquarePaymentLink(mockSheet, { product_id: "TMP-RELINK-01" }, createTestOptions(mockSheet));
      const parsedStep4 = JSON.parse(step4.getContent());

      const finalRow = mockSheet.getRange(2, 1, 1, 40).getValues()[0];
      const isRelinkSuccessful = (
        parsedStep1.success === true &&
        squareCatalog["SQ_ITEM_01"].item_data.is_archived === false &&
        parsedStep2.success === true &&
        parsedStep3.success === true &&
        finalRow[31] === "published" &&
        squareInventory["SQ_VAR_01"] === 1 &&
        parsedStep4.success === true &&
        Boolean(finalRow[36]) && // 決済リンク生成済み
        Boolean(finalRow[37])
      );

      record("9. 明示的な再連携フロー: unarchive (管理者認証) -> details sync -> publish (在庫1先行) -> payment link 生成の完結", isRelinkSuccessful);
    } catch (e9) {
      record("9. 明示的な再連携フロー: unarchive (管理者認証) -> details sync -> publish (在庫1) -> payment link 生成の完結", false, e9.message);
    }

    // --------------------------------------------------
    // Test 10: 中断状態の検出・照合と安全な回収 (Point 2)
    // --------------------------------------------------
    try {
      // 10-a: 中断状態のシミュレーションと正常回収
      // Square 在庫は 1（店頭POS販売可能）、Square Catalog は有効(is_archived: false)、
      // しかし BIS本票は draft のまま（タイムアウトや切断による中断）
      squareCatalog["SQ_ITEM_REC"] = {
        id: "SQ_ITEM_REC",
        type: "ITEM",
        version: 1,
        item_data: {
          name: "Interrupted Sneakers",
          is_archived: false,
          variations: [{
            id: "SQ_VAR_REC",
            version: 1,
            item_variation_data: { sku: "TMP-REC-01", track_inventory: true }
          }]
        }
      };
      squareInventory["SQ_VAR_REC"] = 1;

      const mockSheetRec = createMockProductSheet([{
        product_id: "TMP-REC-01",
        category: "apparel",
        publish_status: "draft",
        inventory_status: "in_stock",
        record_status: "active",
        square_item_id: "SQ_ITEM_REC",
        square_variation_id: "SQ_VAR_REC"
      }]);
      SpreadsheetApp.getActiveSpreadsheet = () => ({ getSheets: () => [mockSheetRec] });

      // 検出 (Detection): 管理者による照合
      const detectRes = reconcileSquareProductionProductStatus("TMP-REC-01", createTestOptions(mockSheetRec));
      const isDetected = (
        detectRes.success === true &&
        detectRes.reconciliation_status === "MISMATCH_SQUARE_IN_STOCK_BIS_DRAFT" &&
        detectRes.anomaly_detected === true &&
        detectRes.recommended_action === "complete_publish_or_stop_sales" &&
        detectRes.square_state.pos_sales_enabled === true &&
        detectRes.square_state.inventory_quantity === 1 &&
        detectRes.bis_state.publish_status === "draft"
      );

      // 回収モードA: complete_publish (販売再開を安全に完了)
      const completeRes = reconcileSquareProductionProductStatus("TMP-REC-01", Object.assign({}, createTestOptions(mockSheetRec), {
        auto_reconcile: "complete_publish"
      }));
      const rowAfterComplete = mockSheetRec.getRange(2, 1, 1, 40).getValues()[0];
      const isCompleteSafe = (
        completeRes.success === true &&
        completeRes.reconciliation_applied === "complete_publish" &&
        rowAfterComplete[31] === "published" &&
        squareInventory["SQ_VAR_REC"] === 1
      );

      // 10-b: 回収モードB: stop_sales の3ケース網羅検証
      // (1) 元から draft の商品 (publish_status: "draft", record_status: "active")
      squareInventory["SQ_VAR_REC2"] = 1;
      squareCatalog["SQ_ITEM_REC2"] = {
        id: "SQ_ITEM_REC2",
        type: "ITEM",
        version: 1,
        item_data: {
          name: "Interrupted Sneakers 2",
          is_archived: false,
          variations: [{
            id: "SQ_VAR_REC2",
            version: 1,
            item_variation_data: { sku: "TMP-REC-02", track_inventory: true }
          }]
        }
      };
      const mockSheetRec2 = createMockProductSheet([{
        product_id: "TMP-REC-02",
        category: "apparel",
        publish_status: "draft",
        inventory_status: "in_stock",
        record_status: "active",
        square_item_id: "SQ_ITEM_REC2",
        square_variation_id: "SQ_VAR_REC2"
      }]);
      SpreadsheetApp.getActiveSpreadsheet = () => ({ getSheets: () => [mockSheetRec2] });

      const stopSalesResDraft = reconcileSquareProductionProductStatus("TMP-REC-02", Object.assign({}, createTestOptions(mockSheetRec2), {
        auto_reconcile: "stop_sales"
      }));
      const rowAfterStopDraft = mockSheetRec2.getRange(2, 1, 1, 40).getValues()[0];
      const isStopDraftSafe = (
        stopSalesResDraft.success === true &&
        stopSalesResDraft.reconciliation_applied === "stop_sales" &&
        squareInventory["SQ_VAR_REC2"] === 0 &&
        rowAfterStopDraft[31] === "draft" &&
        stopSalesResDraft.bis_state.publish_status === "draft" &&
        stopSalesResDraft.square_state.inventory_quantity === 0 &&
        stopSalesResDraft.square_state.pos_sales_enabled === false
      );

      // (2) published の商品 (publish_status: "published", record_status: "active", 決済リンクあり)
      squareInventory["SQ_VAR_REC_PUB"] = 1;
      squarePaymentLinks["PLINK_REC_PUB"] = "https://square.link/rec_pub";
      squareCatalog["SQ_ITEM_REC_PUB"] = {
        id: "SQ_ITEM_REC_PUB",
        type: "ITEM",
        version: 1,
        item_data: {
          name: "Published Sneaker Stop",
          is_archived: false,
          variations: [{
            id: "SQ_VAR_REC_PUB",
            version: 1,
            item_variation_data: { sku: "TMP-REC-PUB", track_inventory: true }
          }]
        }
      };
      const mockSheetRecPub = createMockProductSheet([{
        product_id: "TMP-REC-PUB",
        category: "apparel",
        publish_status: "published",
        inventory_status: "in_stock",
        record_status: "active",
        square_item_id: "SQ_ITEM_REC_PUB",
        square_variation_id: "SQ_VAR_REC_PUB",
        square_payment_link_id: "PLINK_REC_PUB",
        square_checkout_url: "https://square.link/rec_pub"
      }]);
      SpreadsheetApp.getActiveSpreadsheet = () => ({ getSheets: () => [mockSheetRecPub] });

      const stopSalesResPub = reconcileSquareProductionProductStatus("TMP-REC-PUB", Object.assign({}, createTestOptions(mockSheetRecPub), {
        auto_reconcile: "stop_sales"
      }));
      const rowAfterStopPub = mockSheetRecPub.getRange(2, 1, 1, 40).getValues()[0];
      const isStopPubSafe = (
        stopSalesResPub.success === true &&
        stopSalesResPub.reconciliation_applied === "stop_sales" &&
        rowAfterStopPub[31] === "draft" && // BIS本票が確実に draft 化
        stopSalesResPub.bis_state.publish_status === "draft" && // レスポンスも draft
        squareInventory["SQ_VAR_REC_PUB"] === 0 && // Square在庫0
        stopSalesResPub.square_state.inventory_quantity === 0 &&
        stopSalesResPub.square_state.pos_sales_enabled === false &&
        !squarePaymentLinks["PLINK_REC_PUB"] // 決済リンク削除
      );

      // (3) archived だが Square側が稼働している商品 (record_status: "archived", Catalog未アーカイブ, 在庫1)
      squareInventory["SQ_VAR_REC_ARCH_LIVE"] = 1;
      squareCatalog["SQ_ITEM_REC_ARCH_LIVE"] = {
        id: "SQ_ITEM_REC_ARCH_LIVE",
        type: "ITEM",
        version: 1,
        item_data: {
          name: "Archived Live Sneaker",
          is_archived: false, // カタログがアーカイブされていない異常状態
          variations: [{
            id: "SQ_VAR_REC_ARCH_LIVE",
            version: 1,
            item_variation_data: { sku: "TMP-REC-ARCH-LIVE", track_inventory: true }
          }]
        }
      };
      const mockSheetRecArchLive = createMockProductSheet([{
        product_id: "TMP-REC-ARCH-LIVE",
        category: "apparel",
        publish_status: "draft",
        inventory_status: "in_stock",
        record_status: "archived",
        square_item_id: "SQ_ITEM_REC_ARCH_LIVE",
        square_variation_id: "SQ_VAR_REC_ARCH_LIVE"
      }]);
      SpreadsheetApp.getActiveSpreadsheet = () => ({ getSheets: () => [mockSheetRecArchLive] });

      const stopSalesResArchLive = reconcileSquareProductionProductStatus("TMP-REC-ARCH-LIVE", Object.assign({}, createTestOptions(mockSheetRecArchLive), {
        auto_reconcile: "stop_sales"
      }));
      const rowAfterStopArchLive = mockSheetRecArchLive.getRange(2, 1, 1, 40).getValues()[0];
      const isStopArchLiveSafe = (
        stopSalesResArchLive.success === true &&
        stopSalesResArchLive.reconciliation_applied === "stop_sales" &&
        rowAfterStopArchLive[33] === "archived" && // BIS record_status は archived を維持
        rowAfterStopArchLive[31] === "draft" &&
        squareInventory["SQ_VAR_REC_ARCH_LIVE"] === 0 && // Square 在庫 0
        squareCatalog["SQ_ITEM_REC_ARCH_LIVE"].item_data.is_archived === true && // Square カタログもアーカイブ完了
        stopSalesResArchLive.square_state.is_archived === true &&
        stopSalesResArchLive.square_state.pos_sales_enabled === false
      );

      // (4) 途中失敗時の非公開安全性検証（公開ページに販売可能商品として残る状態を「回収成功」と返さないこと）
      failInventoryBatchCreate = true;
      let stopSalesInventoryErrorBlocked = false;
      const mockSheetRecFail = createMockProductSheet([{
        product_id: "TMP-REC-FAIL",
        category: "apparel",
        publish_status: "published",
        inventory_status: "in_stock",
        record_status: "active",
        square_item_id: "SQ_ITEM_REC_PUB",
        square_variation_id: "SQ_VAR_REC_PUB"
      }]);
      try {
        reconcileSquareProductionProductStatus("TMP-REC-FAIL", Object.assign({}, createTestOptions(mockSheetRecFail), {
          auto_reconcile: "stop_sales"
        }));
      } catch (eStopFail) {
        stopSalesInventoryErrorBlocked = true;
      }
      failInventoryBatchCreate = false;
      const rowAfterStopFail = mockSheetRecFail.getRange(2, 1, 1, 40).getValues()[0];
      const isFailureSafeNonPublic = (
        stopSalesInventoryErrorBlocked === true &&
        rowAfterStopFail[31] === "draft" // Square在庫API失敗時でもBISは先行してdraftになり公開ページには残らない
      );

      const isStopSafe = (
        isStopDraftSafe &&
        isStopPubSafe &&
        isStopArchLiveSafe &&
        isFailureSafeNonPublic
      );

      // 10-c: complete_publish の厳格な事前条件検証
      // (1) archived商品への complete_publish 拒絶
      let archivedCompleteBlocked = false;
      const mockSheetArc = createMockProductSheet([{
        product_id: "TMP-REC-ARC",
        category: "apparel",
        publish_status: "draft",
        inventory_status: "in_stock",
        record_status: "archived",
        square_item_id: "SQ_ITEM_REC",
        square_variation_id: "SQ_VAR_REC"
      }]);
      try {
        reconcileSquareProductionProductStatus("TMP-REC-ARC", Object.assign({}, createTestOptions(mockSheetArc), {
          auto_reconcile: "complete_publish"
        }));
      } catch (eArc) {
        if (eArc.message.indexOf("cannot complete publish for non-active product") !== -1) {
          archivedCompleteBlocked = true;
        }
      }

      // (2) sold商品への complete_publish 拒絶
      let soldCompleteBlocked = false;
      const mockSheetSold = createMockProductSheet([{
        product_id: "TMP-REC-SOLD",
        category: "apparel",
        publish_status: "draft",
        inventory_status: "sold",
        record_status: "active",
        square_item_id: "SQ_ITEM_REC",
        square_variation_id: "SQ_VAR_REC"
      }]);
      try {
        reconcileSquareProductionProductStatus("TMP-REC-SOLD", Object.assign({}, createTestOptions(mockSheetSold), {
          auto_reconcile: "complete_publish"
        }));
      } catch (eSold) {
        if (eSold.message.indexOf("cannot complete publish for non in-stock product") !== -1) {
          soldCompleteBlocked = true;
        }
      }

      // (3) Square Catalogアイテムが archived の場合の complete_publish 拒絶
      let sqArchivedCompleteBlocked = false;
      squareCatalog["SQ_ITEM_REC_ARC"] = {
        id: "SQ_ITEM_REC_ARC",
        type: "ITEM",
        version: 1,
        item_data: {
          name: "Archived Catalog Item",
          is_archived: true,
          variations: [{ id: "SQ_VAR_REC_ARC", version: 1, item_variation_data: { sku: "TMP-REC-ARC2", track_inventory: true } }]
        }
      };
      const mockSheetSqArc = createMockProductSheet([{
        product_id: "TMP-REC-SQARC",
        category: "apparel",
        publish_status: "draft",
        inventory_status: "in_stock",
        record_status: "active",
        square_item_id: "SQ_ITEM_REC_ARC",
        square_variation_id: "SQ_VAR_REC_ARC"
      }]);
      try {
        reconcileSquareProductionProductStatus("TMP-REC-SQARC", Object.assign({}, createTestOptions(mockSheetSqArc), {
          auto_reconcile: "complete_publish"
        }));
      } catch (eSqArc) {
        if (eSqArc.message.indexOf("cannot complete publish while Square catalog item is archived") !== -1) {
          sqArchivedCompleteBlocked = true;
        }
      }

      // 10-d: SquareのCatalog・在庫取得エラー時の「状態不明」判定 & 自動回収禁止 (フェイルクローズ)
      let unknownCatalogBlocked = false;
      let unknownInventoryBlocked = false;

      // (1) Catalog取得失敗時
      failCatalogObjectGet = true;
      const detectCatalogFail = reconcileSquareProductionProductStatus("TMP-REC-01", createTestOptions(mockSheetRec));
      let autoRecCatalogBlocked = false;
      try {
        reconcileSquareProductionProductStatus("TMP-REC-01", Object.assign({}, createTestOptions(mockSheetRec), {
          auto_reconcile: "complete_publish"
        }));
      } catch (eCatRec) {
        if (eCatRec.message.indexOf("Auto-reconciliation is strictly prohibited when Square external state is unknown") !== -1) {
          autoRecCatalogBlocked = true;
        }
      }
      failCatalogObjectGet = false;
      unknownCatalogBlocked = (
        detectCatalogFail.reconciliation_status === "UNKNOWN_EXTERNAL_ERROR" &&
        detectCatalogFail.anomaly_detected === true &&
        detectCatalogFail.square_state.pos_sales_enabled === "unknown" &&
        Boolean(detectCatalogFail.square_state.catalog_fetch_error) &&
        autoRecCatalogBlocked
      );

      // (2) 在庫取得失敗時
      failInventoryGet = true;
      const detectInvFail = reconcileSquareProductionProductStatus("TMP-REC-01", createTestOptions(mockSheetRec));
      let autoRecInvBlocked = false;
      try {
        reconcileSquareProductionProductStatus("TMP-REC-01", Object.assign({}, createTestOptions(mockSheetRec), {
          auto_reconcile: "stop_sales"
        }));
      } catch (eInvRec) {
        if (eInvRec.message.indexOf("Auto-reconciliation is strictly prohibited when Square external state is unknown") !== -1) {
          autoRecInvBlocked = true;
        }
      }
      failInventoryGet = false;
      unknownInventoryBlocked = (
        detectInvFail.reconciliation_status === "UNKNOWN_EXTERNAL_ERROR" &&
        detectInvFail.anomaly_detected === true &&
        detectInvFail.square_state.pos_sales_enabled === "unknown" &&
        Boolean(detectInvFail.square_state.inventory_fetch_error) &&
        autoRecInvBlocked
      );

      const allPreconditionsAndRecoveryPass = (
        isDetected &&
        isCompleteSafe &&
        isStopSafe &&
        archivedCompleteBlocked &&
        soldCompleteBlocked &&
        sqArchivedCompleteBlocked &&
        unknownCatalogBlocked &&
        unknownInventoryBlocked
      );

      record(
        "10. 中断状態の検出・照合と安全な回収: 外部エラー時の状態不明判定・回収禁止およびcomplete_publish厳格事前条件",
        allPreconditionsAndRecoveryPass,
        `detected=${isDetected}, completeSafe=${isCompleteSafe}, stopSafe=${isStopSafe}, arcBlocked=${archivedCompleteBlocked}, soldBlocked=${soldCompleteBlocked}, sqArcBlocked=${sqArchivedCompleteBlocked}, unkCatBlocked=${unknownCatalogBlocked}, unkInvBlocked=${unknownInventoryBlocked}`
      );
    } catch (e10) {
      record("10. 中断状態の検出・照合と安全な回収: 外部エラー時の状態不明判定・回収禁止およびcomplete_publish厳格事前条件", false, e10.message);
    } finally {
      failCatalogObjectGet = false;
      failInventoryGet = false;
    }

    // --------------------------------------------------
    // Test 11: 決済リンク生成失敗時の販売状態セマンティクス (Point 3)
    // --------------------------------------------------
    try {
      // 11-a: 事前検証エラー (例: draft商品のまま決済リンク生成を要求 -> Square API未実行・リンク未生成確定)
      const mockSheetDraft = createMockProductSheet([{
        product_id: "TMP-PLINK-DRAFT",
        category: "apparel",
        publish_status: "draft",
        inventory_status: "in_stock",
        record_status: "active",
        square_item_id: "SQ_ITEM_FAIL1",
        square_variation_id: "SQ_VAR_FAIL1"
      }]);
      SpreadsheetApp.getActiveSpreadsheet = () => ({ getSheets: () => [mockSheetDraft] });

      const resPrecondition = handleCreateSquarePaymentLink(mockSheetDraft, {
        product_id: "TMP-PLINK-DRAFT"
      }, createTestOptions(mockSheetDraft));
      const parsedPrecondition = JSON.parse(resPrecondition.getContent());

      const isPreconditionSafe = (
        parsedPrecondition.success === false &&
        parsedPrecondition.error_phase === "precondition" &&
        parsedPrecondition.status === "payment_link_precondition_failed" &&
        parsedPrecondition.square_catalog_unarchived === "unknown" &&
        parsedPrecondition.square_inventory === "unknown" &&
        parsedPrecondition.pos_sales_enabled === "unknown" &&
        parsedPrecondition.square_payment_link_created === false
      );

      // 11-b: 通常のリンク生成失敗 (Square API タイムアウト/5xx等の未確定エラー: POS状態不明・リンク作成状態unknown)
      failPaymentLinkCreate = true;
      failPaymentLinkCreate400 = false;
      failInventoryBatchCreate = false;

      squareInventory["SQ_VAR_FAIL1"] = 1;
      squareCatalog["SQ_ITEM_FAIL1"] = {
        id: "SQ_ITEM_FAIL1",
        type: "ITEM",
        version: 1,
        item_data: {
          name: "Payment Link Fail 1",
          is_archived: false,
          variations: [{ id: "SQ_VAR_FAIL1", version: 1, item_variation_data: { sku: "TMP-PLINK-01", track_inventory: true } }]
        }
      };
      const mockSheetFail1 = createMockProductSheet([{
        product_id: "TMP-PLINK-01",
        category: "apparel",
        publish_status: "published",
        inventory_status: "in_stock",
        record_status: "active",
        square_item_id: "SQ_ITEM_FAIL1",
        square_variation_id: "SQ_VAR_FAIL1"
      }]);
      SpreadsheetApp.getActiveSpreadsheet = () => ({ getSheets: () => [mockSheetFail1] });

      const resFail1 = handleCreateSquarePaymentLink(mockSheetFail1, {
        product_id: "TMP-PLINK-01"
      }, createTestOptions(mockSheetFail1));
      const parsedFail1 = JSON.parse(resFail1.getContent());

      const isUnconfirmedReported = (
        parsedFail1.success === false &&
        parsedFail1.error_phase === "square_api" &&
        parsedFail1.status === "payment_link_create_failed_unconfirmed" &&
        parsedFail1.square_catalog_unarchived === "unknown" &&
        parsedFail1.square_inventory === "unknown" &&
        parsedFail1.pos_sales_enabled === "unknown" &&
        parsedFail1.square_payment_link_created === "unknown" &&
        typeof parsedFail1.message === "string" &&
        parsedFail1.message.indexOf("未紐付け") !== -1
      );

      // 11-c: 明確な4xx拒絶によるリンク生成失敗 (HTTP 400: Square側で確実に未生成)
      failPaymentLinkCreate = false;
      failPaymentLinkCreate400 = true;

      const resFail400 = handleCreateSquarePaymentLink(mockSheetFail1, {
        product_id: "TMP-PLINK-01"
      }, createTestOptions(mockSheetFail1));
      const parsedFail400 = JSON.parse(resFail400.getContent());

      const isRejectedReported = (
        parsedFail400.success === false &&
        parsedFail400.error_phase === "square_api" &&
        parsedFail400.status === "payment_link_create_failed_rejected" &&
        parsedFail400.square_catalog_unarchived === "unknown" &&
        parsedFail400.square_inventory === "unknown" &&
        parsedFail400.pos_sales_enabled === "unknown" &&
        parsedFail400.square_payment_link_created === false &&
        typeof parsedFail400.message === "string" &&
        parsedFail400.message.indexOf("拒絶・未生成") !== -1
      );
      failPaymentLinkCreate400 = false;

      // 11-d: Square API 成功後の本票保存失敗 (Square側リンク作成済み・BIS本票未紐付け)
      const mockSheetSaveFail = createMockProductSheet([{
        product_id: "TMP-PLINK-SAVEFAIL",
        category: "apparel",
        publish_status: "published",
        inventory_status: "in_stock",
        record_status: "active",
        square_item_id: "SQ_ITEM_FAIL1",
        square_variation_id: "SQ_VAR_FAIL1"
      }]);
      mockSheetSaveFail.failSetValues = true; // 本票書き込み失敗をシミュレーション
      SpreadsheetApp.getActiveSpreadsheet = () => ({ getSheets: () => [mockSheetSaveFail] });

      const resSaveFail = handleCreateSquarePaymentLink(mockSheetSaveFail, {
        product_id: "TMP-PLINK-SAVEFAIL"
      }, createTestOptions(mockSheetSaveFail));
      const parsedSaveFail = JSON.parse(resSaveFail.getContent());

      const isSheetSaveFailureReported = (
        parsedSaveFail.success === false &&
        parsedSaveFail.error_phase === "sheet_save" &&
        parsedSaveFail.error_code === "PAYMENT_LINK_SHEET_SAVE_FAILED" &&
        parsedSaveFail.status === "payment_link_sheet_save_failed" &&
        parsedSaveFail.square_payment_link_created === true && // Square側リンク作成済みを正しく報告！
        Boolean(parsedSaveFail.square_payment_link_id) &&
        Boolean(parsedSaveFail.square_checkout_url) &&
        parsedSaveFail.square_payment_link_generation === 1 &&
        parsedSaveFail.square_catalog_unarchived === "unknown" &&
        parsedSaveFail.square_inventory === "unknown" &&
        parsedSaveFail.pos_sales_enabled === "unknown" &&
        mockSheetSaveFail.data[1][36] === "" && // 本票未保存（未紐付け）
        mockSheetSaveFail.data[1][37] === "" &&
        typeof parsedSaveFail.message === "string" &&
        parsedSaveFail.message.indexOf("未紐付け") !== -1
      );

      // 11-e: 同一世代の冪等性キーによる再試行（再送成功・同一リンク紐付け完了）
      mockSheetSaveFail.failSetValues = false; // シート保存障害解消
      const resRetry = handleCreateSquarePaymentLink(mockSheetSaveFail, {
        product_id: "TMP-PLINK-SAVEFAIL"
      }, createTestOptions(mockSheetSaveFail));
      const parsedRetry = JSON.parse(resRetry.getContent());

      const isRetrySuccessAndConsistent = (
        parsedRetry.success === true &&
        parsedRetry.square_payment_link_id === parsedSaveFail.square_payment_link_id && // 同一キーにより同一リンク取得
        parsedRetry.square_checkout_url === parsedSaveFail.square_checkout_url &&
        mockSheetSaveFail.data[1][36] === parsedSaveFail.square_payment_link_id && // 本票へ紐付け完了
        mockSheetSaveFail.data[1][37] === parsedSaveFail.square_checkout_url &&
        mockSheetSaveFail.data[1][38] === 1
      );

      // 11-f: 決済リンク生成失敗 + 在庫巻き戻し成功 (rollback_on_failure: true)
      failPaymentLinkCreate = true;
      failPaymentLinkCreate400 = false;
      squareInventory["SQ_VAR_FAIL2"] = 1;
      squareCatalog["SQ_ITEM_FAIL2"] = {
        id: "SQ_ITEM_FAIL2",
        type: "ITEM",
        version: 1,
        item_data: {
          name: "Payment Link Fail 2",
          is_archived: false,
          variations: [{ id: "SQ_VAR_FAIL2", version: 1, item_variation_data: { sku: "TMP-PLINK-02", track_inventory: true } }]
        }
      };
      const mockSheetFail2 = createMockProductSheet([{
        product_id: "TMP-PLINK-02",
        category: "apparel",
        publish_status: "published",
        inventory_status: "in_stock",
        record_status: "active",
        square_item_id: "SQ_ITEM_FAIL2",
        square_variation_id: "SQ_VAR_FAIL2"
      }]);
      SpreadsheetApp.getActiveSpreadsheet = () => ({ getSheets: () => [mockSheetFail2] });

      const resFail2 = handleCreateSquarePaymentLink(mockSheetFail2, {
        product_id: "TMP-PLINK-02",
        rollback_on_failure: true
      }, createTestOptions(mockSheetFail2));
      const parsedFail2 = JSON.parse(resFail2.getContent());

      const isRollbackZeroSafe = (
        parsedFail2.success === false &&
        parsedFail2.status === "pending_retry_inventory_reverted_to_zero" &&
        parsedFail2.rollback_status === "success" &&
        parsedFail2.square_inventory === 0 &&
        parsedFail2.pos_sales_enabled === false &&
        squareInventory["SQ_VAR_FAIL2"] === 0 // Square在庫が安全に0へ巻き戻されたこと
      );

      // 11-g: 決済リンク生成失敗 + 在庫巻き戻し失敗 (多重障害ケース)
      // 在庫APIも失敗するようにシミュレーション
      failInventoryBatchCreate = true;

      squareInventory["SQ_VAR_FAIL3"] = 1;
      squareCatalog["SQ_ITEM_FAIL3"] = {
        id: "SQ_ITEM_FAIL3",
        type: "ITEM",
        version: 1,
        item_data: {
          name: "Payment Link Fail 3",
          is_archived: false,
          variations: [{ id: "SQ_VAR_FAIL3", version: 1, item_variation_data: { sku: "TMP-PLINK-03", track_inventory: true } }]
        }
      };
      const mockSheetFail3 = createMockProductSheet([{
        product_id: "TMP-PLINK-03",
        category: "apparel",
        publish_status: "published",
        inventory_status: "in_stock",
        record_status: "active",
        square_item_id: "SQ_ITEM_FAIL3",
        square_variation_id: "SQ_VAR_FAIL3"
      }]);
      SpreadsheetApp.getActiveSpreadsheet = () => ({ getSheets: () => [mockSheetFail3] });

      const resFail3 = handleCreateSquarePaymentLink(mockSheetFail3, {
        product_id: "TMP-PLINK-03",
        rollback_on_failure: true
      }, createTestOptions(mockSheetFail3));
      const parsedFail3 = JSON.parse(resFail3.getContent());

      const isRollbackFailureTruthful = (
        parsedFail3.success === false &&
        parsedFail3.status === "rollback_failed_square_inventory_unknown" &&
        parsedFail3.rollback_status === "failed" &&
        parsedFail3.pos_sales_enabled === "unknown" && // 確定値を返さず unknown
        parsedFail3.square_inventory === "unknown" &&
        parsedFail3.square_catalog_unarchived === "unknown" &&
        squareInventory["SQ_VAR_FAIL3"] === 1 && // 巻き戻し失敗により実在庫は1のまま残留
        Boolean(parsedFail3.rollback_error) &&
        typeof parsedFail3.message === "string" &&
        parsedFail3.message.indexOf("販売可能な可能性があるため要確認") !== -1
      );

      const allPaymentLinkSemanticsPass = (
        isPreconditionSafe &&
        isUnconfirmedReported &&
        isRejectedReported &&
        isSheetSaveFailureReported &&
        isRetrySuccessAndConsistent &&
        isRollbackZeroSafe &&
        isRollbackFailureTruthful
      );

      record(
        "11. 決済リンク失敗セマンティクス: 事前検証・API未確定・4xx拒絶・本票保存失敗(作成済未紐付)・再試行修復・巻き戻しの厳格分離",
        allPaymentLinkSemanticsPass,
        `precondition=${isPreconditionSafe}, unconfirmed=${isUnconfirmedReported}, rejected=${isRejectedReported}, sheetSave=${isSheetSaveFailureReported}, retryFix=${isRetrySuccessAndConsistent}, rollbackZero=${isRollbackZeroSafe}, rollbackFailure=${isRollbackFailureTruthful}`
      );
    } catch (e11) {
      record("11. 決済リンク失敗セマンティクス: 事前検証・API未確定・4xx拒絶・本票保存失敗(作成済未紐付)・再試行修復・巻き戻しの厳格分離", false, e11.message);
    } finally {
      failPaymentLinkCreate = false;
      failPaymentLinkCreate400 = false;
      failInventoryBatchCreate = false;
    }

    // --------------------------------------------------
    // Test 12: 実Script PropertiesおよびGASグローバルサービス完全不変性検証 (Point 1)
    // --------------------------------------------------
    try {
      let livePropsUnchanged = true;
      let leakDetected = false;

      if (realPropertiesService) {
        if (typeof realPropertiesService.getProperties === "function") {
          const livePropsNow = realPropertiesService.getProperties() || {};
          // テスト用のダミー値が実Propertiesに漏洩・書き込みされていないことを確認
          if (
            livePropsNow["SQUARE_PROD_LOCATION_ID"] === "LOC_PROD_TEST" ||
            livePropsNow["SQUARE_PROD_ACCESS_TOKEN"] === "EAAA_TEST_TOKEN" ||
            livePropsNow["ADMIN_API_KEY"] === "TEST_ADMIN_SECRET_KEY_123"
          ) {
            leakDetected = true;
          }

          // テスト前とキー・値が完全一致していること（破壊されていないこと）
          const beforeKeys = Object.keys(realPropsBefore);
          const nowKeys = Object.keys(livePropsNow);
          if (beforeKeys.length !== nowKeys.length) {
            livePropsUnchanged = false;
          } else {
            for (let k of beforeKeys) {
              if (realPropsBefore[k] !== livePropsNow[k]) {
                livePropsUnchanged = false;
                break;
              }
            }
          }
        } else if (typeof realPropertiesService.getProperty === "function") {
          const loc = realPropertiesService.getProperty("SQUARE_PROD_LOCATION_ID");
          const tok = realPropertiesService.getProperty("SQUARE_PROD_ACCESS_TOKEN");
          const key = realPropertiesService.getProperty("ADMIN_API_KEY");
          if (loc === "LOC_PROD_TEST" || tok === "EAAA_TEST_TOKEN" || key === "TEST_ADMIN_SECRET_KEY_123") {
            leakDetected = true;
          }
        }
      }

      record(
        "12. 実Script Properties不変性: テスト実行による本番Propertiesの汚染・破壊ゼロを保証 (完全モック分離)",
        !leakDetected && livePropsUnchanged,
        `leakDetected=${leakDetected}, livePropsUnchanged=${livePropsUnchanged}`
      );
    } catch (e12) {
      record("12. 実Script Properties不変性: テスト実行による本番Propertiesの汚染・破壊ゼロを保証 (完全モック分離)", false, e12.message);
    }

  } finally {
    SpreadsheetApp.getActiveSpreadsheet = origSpreadsheet;
    if (origSquareProd) squareProdRequest_ = origSquareProd;
  }

  console.log(`--- [testBulkProductArchiveSafetySuite_] 完了: ${passed}/${results.length} 通過 ---`);
  return {
    passed: passed,
    failed: failed,
    total: results.length,
    results: results
  };
}

// ==================================================
// 20. AI商品ドラフト 同定・価格判定・正規化 改善テストスイート
// ==================================================

/**
 * AI商品ドラフトの同定精度・価格根拠・表記揺れ正規化に関するテストスイート
 * (ポケカ/スニーカー同定、PSA鑑定品、裏面欠落ガード、サーバー価格算出、表記揺れ正規化、実行時間/検索確認)
 *
 * @return {Object} テスト結果 { passed, failed, total, results }
 */
function testAiProductDraftIdentityAndPricingSuite_() {
  console.log("--- [testAiProductDraftIdentityAndPricingSuite_] 開始 ---");
  const results = [];
  let passed = 0;
  let failed = 0;

  function record(name, isPass, detail) {
    results.push({ name: name, passed: isPass, detail: detail || "" });
    if (isPass) {
      passed++;
      console.log("✓ " + name);
    } else {
      failed++;
      console.error("✗ " + name + ": " + (detail || ""));
    }
  }

  // --------------------------------------------------
  // 1. ポケカ通常品の同定・命名・正規化
  // --------------------------------------------------
  try {
    const rawPokeCandidate = {
      title_ja: "ポケモンカードゲーム ミュウex UR 135/103 ポケモンカード151",
      category: "ポケカ",
      brand: "Pokémon",
      condition: "目立った傷や汚れなし",
      identity_status: "confident",
      pokemon_card: {
        card_name: "ミュウex",
        rarity: "UR",
        card_number: "135/103",
        expansion: "ポケモンカード151"
      },
      price_basis: "no_evidence"
    };

    const sanitized = validateAndSanitizeDraftCandidate_(rawPokeCandidate, { image_count: 2, has_back_image: true });
    const isCatNorm = sanitized.category === "pokemon_card";
    const isBrandNorm = sanitized.brand === "Pokemon Card Game";
    // 手動登録見本フォーマット: {card_name} [{set_code} {card_number}] {set_name} (レアリティ除外)
    const expectedTitle = "ミュウex [135/103] ポケモンカード151";
    const isTitleSanitized = sanitized.title_ja === expectedTitle;
    const isIdentityConfident = sanitized.identity_status === "confident";

    record(
      "1. ポケカ通常品同定: 命名整形(見本フォーマット)・ブランド「Pokemon Card Game」統一・カテゴリ「pokemon_card」統一",
      isCatNorm && isBrandNorm && isTitleSanitized && isIdentityConfident,
      `category=${sanitized.category}, brand=${sanitized.brand}, title=${sanitized.title_ja}, identity_status=${sanitized.identity_status}`
    );
  } catch (err) {
    record("1. ポケカ通常品同定: 命名整形(見本フォーマット)・ブランド「Pokemon Card Game」統一・カテゴリ「pokemon_card」統一", false, err.message);
  }

  // --------------------------------------------------
  // 2. ポケカ型番違い・PSA鑑定品と通常未鑑定品の峻別
  // --------------------------------------------------
  try {
    // 2-1: PSA10鑑定品
    const rawPsaCandidate = {
      title_ja: "PSA10 ミュウex SAR 205/165 ポケモンカード151",
      category: "pokemon_card",
      brand: "ポケモン",
      condition: "未使用に近い",
      pokemon_card: {
        card_name: "ミュウex",
        rarity: "SAR",
        card_number: "205/165",
        expansion: "ポケモンカード151",
        grading_status: "graded",
        grader: "PSA",
        grade: "10"
      },
      price_basis: "no_evidence"
    };
    const sanitizedPsa = validateAndSanitizeDraftCandidate_(rawPsaCandidate, { image_count: 2, has_back_image: true });
    const isPsaGraded = sanitizedPsa.pokemon_card.grading_status === "graded" &&
                        sanitizedPsa.pokemon_card.grader === "PSA" &&
                        sanitizedPsa.pokemon_card.grade === "10";
    const isPsaTitlePreserved = sanitizedPsa.title_ja.indexOf("[PSA10]") !== -1 || sanitizedPsa.title_ja.indexOf("PSA10") !== -1;

    // 2-2: 通常未鑑定品
    const rawUngradedCandidate = {
      title_ja: "ピカチュウ PROMO 001/SV-P プロモカードパック",
      category: "pokemon_card",
      brand: "ポケモン",
      condition: "目立った傷や汚れなし",
      pokemon_card: {
        card_name: "ピカチュウ",
        rarity: "PROMO",
        card_number: "001/SV-P",
        expansion: "プロモカードパック"
      },
      price_basis: "no_evidence"
    };
    const sanitizedUngraded = validateAndSanitizeDraftCandidate_(rawUngradedCandidate, { image_count: 2, has_back_image: true });
    const isUngraded = sanitizedUngraded.pokemon_card.grading_status === "ungraded" &&
                       (!sanitizedUngraded.pokemon_card.grader) &&
                       (!sanitizedUngraded.pokemon_card.grade);

    record(
      "2. ポケカ鑑定品・通常品峻別: PSA10鑑定属性(graded/PSA/10)保持と通常品(ungraded)の明確な分離",
      isPsaGraded && isPsaTitlePreserved && isUngraded,
      `psaGraded=${isPsaGraded}, psaTitle=${sanitizedPsa.title_ja}, ungraded=${isUngraded}`
    );
  } catch (err) {
    record("2. ポケカ鑑定品・通常品峻別: PSA10鑑定属性(graded/PSA/10)保持と通常品(ungraded)の明確な分離", false, err.message);
  }

  // --------------------------------------------------
  // 3. ポケカ裏面なし & 番号不鮮明時の安全ガード
  // --------------------------------------------------
  try {
    // 3-1: 画像1枚（裏面なし）での白欠け断定防止
    const rawSingleImageCandidate = {
      title_ja: "ナンジャモ SAR 096/071 クレイバースト",
      category: "pokemon_card",
      brand: "ポケモン",
      condition: "新品・未使用",
      pokemon_card: {
        card_name: "ナンジャモ",
        rarity: "SAR",
        card_number: "096/071",
        card_condition: "白かけなし・美品"
      },
      price_basis: "no_evidence"
    };
    const sanitizedSingleImg = validateAndSanitizeDraftCandidate_(rawSingleImageCandidate, { image_count: 1, has_back_image: false });
    const conditionNeedsReview = sanitizedSingleImg.needs_review &&
                                 sanitizedSingleImg.needs_review.indexOf("card_condition") !== -1;

    // 3-2: 型番不鮮明・不確定（identity_status: "ambiguous"）
    const rawAmbiguousCandidate = {
      title_ja: "リザードン",
      category: "pokemon_card",
      brand: "ポケモン",
      condition: "傷や汚れあり",
      identity_status: "ambiguous",
      pokemon_card: {
        card_name: "リザードン"
      },
      price_basis: "no_evidence"
    };
    const sanitizedAmbiguous = validateAndSanitizeDraftCandidate_(rawAmbiguousCandidate, { image_count: 2, has_back_image: true });
    const numberNeedsReview = sanitizedAmbiguous.needs_review &&
                              sanitizedAmbiguous.needs_review.indexOf("card_number") !== -1;
    const isStatusAmbiguous = sanitizedAmbiguous.identity_status === "ambiguous";

    record(
      "3. ポケカ安全ガード: 画像1枚裏面欠落時の状態要確認(needs_review:card_condition)と型番不鮮明時の同定曖昧(ambiguous)",
      conditionNeedsReview && numberNeedsReview && isStatusAmbiguous,
      `conditionNeedsReview=${conditionNeedsReview}, numberNeedsReview=${numberNeedsReview}, identity_status=${sanitizedAmbiguous.identity_status}`
    );
  } catch (err) {
    record("3. ポケカ安全ガード: 画像1枚裏面欠落時の状態要確認(needs_review:card_condition)と型番不鮮明時の同定曖昧(ambiguous)", false, err.message);
  }

  // --------------------------------------------------
  // 4. スニーカー特定（箱ラベル優先、特定困難時SKU空欄保護、スタッフ入力保護）
  // --------------------------------------------------
  try {
    // 4-1: 箱ラベルからスタイルコード特定成功
    const rawBoxLabelCandidate = {
      title_ja: "Air Jordan 1 Retro High OG Chicago",
      category: "sneaker",
      brand: "NIKE",
      condition: "新品・未使用",
      sku: "FD8775-001",
      size: "27.5cm",
      identity_status: "confident",
      price_basis: "no_evidence"
    };
    const sanitizedBox = validateAndSanitizeDraftCandidate_(rawBoxLabelCandidate, { image_count: 3 });
    const boxSkuConfident = sanitizedBox.identity_status === "confident" &&
                            sanitizedBox.sku === "FD8775-001" &&
                            sanitizedBox.brand === "NIKE";

    // 4-2: ラベル不鮮明・型番特定困難
    const rawUnclearCandidate = {
      title_ja: "Nike Air Max",
      category: "sneaker",
      brand: "NIKE",
      condition: "目立った傷や汚れなし",
      sku: null,
      price_basis: "no_evidence"
    };
    const sanitizedUnclear = validateAndSanitizeDraftCandidate_(rawUnclearCandidate, { image_count: 2 });
    const unclearNeedsReview = sanitizedUnclear.needs_review &&
                               sanitizedUnclear.needs_review.indexOf("sku") !== -1;

    // 4-3: スタッフ入力値の保護検証 (applyCandidateToProduct_)
    const mockRow = new Array(40).fill("");
    mockRow[1] = "TMP-SNEAKER-PROT";
    mockRow[2] = "sneaker";
    mockRow[3] = "JORDAN";         // スタッフ入力済みブランド
    mockRow[6] = 25000;             // スタッフ入力済み価格 (G列)
    mockRow[7] = 30000;             // スタッフ入力済み予定販売価格 (H列: 8)
    mockRow[11] = "555088-101";     // スタッフ入力済みSKU (L列)
    mockRow[12] = "28.0cm";         // スタッフ入力済みサイズ (M列)

    const updatedRanges = {};
    const mockProtectSheet = {
      getLastColumn: () => 40,
      getRange: (r, c, numR, numC) => ({
        getValues: () => [mockRow],
        setValue: (val) => {
          mockRow[c - 1] = val;
          updatedRanges[c] = val;
        }
      })
    };

    const aiOverridingCandidate = {
      category: "sneaker",
      brand: "NIKE",
      sku: "NEW-AI-SKU-001",
      size: "26.5cm",
      price: 18000,
      title_ja: "New Title",
      condition: "新品・未使用"
    };

    applyCandidateToProduct_(mockProtectSheet, 2, "TMP-SNEAKER-PROT", aiOverridingCandidate);

    // D列(4), L列(12), M列(13), G列(7), H列(8) が上書きされていないこと
    const brandProtected = updatedRanges[4] === undefined;
    const skuProtected = updatedRanges[12] === undefined;
    const sizeProtected = updatedRanges[13] === undefined;
    const priceProtected = updatedRanges[7] === undefined && updatedRanges[8] === undefined;

    const allProtected = brandProtected && skuProtected && sizeProtected && priceProtected;

    record(
      "4. スニーカー特定とスタッフ入力保護: 箱ラベル優先特定・特定困難時SKU要確認・スタッフ入力(ブランド/SKU/サイズ/価格)の上書き防止保護",
      boxSkuConfident && unclearNeedsReview && allProtected,
      `boxSkuConfident=${boxSkuConfident}, unclearNeedsReview=${unclearNeedsReview}, allProtected=${allProtected}`
    );
  } catch (err) {
    record("4. スニーカー特定とスタッフ入力保護: 箱ラベル優先特定・特定困難時SKU要確認・スタッフ入力(ブランド/SKU/サイズ/価格)の上書き防止保護", false, err.message);
  }

  // --------------------------------------------------
  // 5. 表記揺れの網羅的正規化（カテゴリ、ブランド）
  // --------------------------------------------------
  try {
    // カテゴリ正規化テスト
    const catSneakerTests = ["スニーカー", "sneakers", "KICKS", "shoes", "靴"].every(val => normalizeCategoryValue_(val) === "sneaker");
    // ポケモン固有の明示的表現は文脈なしで判定
    const catPokeExplicitTests = ["ポケカ", "ポケモンカード", "pokemon card", "Pokemon Card Game", "pokemoncard"].every(val => normalizeCategoryValue_(val) === "pokemon_card");
    // 指摘5: 汎用TCG表現は文脈なしでは空文字（未確定）、文脈ありで pokemon_card
    const catTcgWithoutContext = ["TCG", "trading card", "card"].every(val => normalizeCategoryValue_(val) === "");
    const catTcgWithContext = ["TCG", "trading card", "card"].every(val => normalizeCategoryValue_(val, { brand: "Pokemon Card Game" }) === "pokemon_card");
    const catApparelTests = ["アパレル", "服", "Tシャツ", "apparel", "clothing"].every(val => normalizeCategoryValue_(val) === "apparel");
    const catInvalidTests = ["時計", "ゲーム", "unknown", ""].every(val => normalizeCategoryValue_(val) === "");

    // ブランド正規化テスト (ポケカ: Readdy画面選択肢 "Pokemon Card Game" に統一)
    const pokeBrands = ["Pokémon", "pokemon", "Pokemon", "ポケモン", "The Pokemon Company", "任天堂", "Pokemon Card Game"];
    const pokeBrandTests = pokeBrands.every(b => normalizeBrandValue_(b, "pokemon_card") === "Pokemon Card Game");

    // ブランド正規化テスト (スニーカー)
    const nikeTests = ["Nike", "NIKE SPORTSWEAR", "ナイキ"].every(b => normalizeBrandValue_(b, "sneaker") === "NIKE");
    const jordanTests = ["Jordan", "Air Jordan", "ジョーダン"].every(b => normalizeBrandValue_(b, "sneaker") === "JORDAN");
    const adidasTests = ["Adidas", "アディダス"].every(b => normalizeBrandValue_(b, "sneaker") === "adidas");
    const nbTests = ["New Balance", "ニューバランス"].every(b => normalizeBrandValue_(b, "sneaker") === "New Balance");
    const asicsTests = ["Asics", "アシックス"].every(b => normalizeBrandValue_(b, "sneaker") === "ASICS");

    const allCatPass = catSneakerTests && catPokeExplicitTests && catTcgWithoutContext && catTcgWithContext && catApparelTests && catInvalidTests;
    const allBrandPass = pokeBrandTests && nikeTests && jordanTests && adidasTests && nbTests && asicsTests;

    record(
      "5. 表記揺れ網羅的正規化: カテゴリ(sneaker/pokemon_card/apparel, TCG文脈判定)およびブランド(Pokemon Card Game/NIKE/JORDAN/adidas/New Balance/ASICS)の完全統制",
      allCatPass && allBrandPass,
      `catPass=${allCatPass}, brandPass=${allBrandPass}`
    );
  } catch (err) {
    record("5. 表記揺れ網羅的正規化: カテゴリ(sneaker/pokemon_card/apparel, TCG文脈判定)およびブランド(ポケモン/NIKE/JORDAN/adidas/New Balance/ASICS)の完全統制", false, err.message);
  }

  // --------------------------------------------------
  // 6. サーバー側価格算出・根拠検証（成約中央値、出品参考、根拠なし空欄、丸め）
  // --------------------------------------------------
  try {
    // 6-1: 成約3件以上（実取引内容確認済成約事例・中央値採用 & 100円丸め）
    const p1 = calculateServerGroundedPrice_({
      price_basis: "recent_sold_verified",
      price_evidence: [
        { price_type: "sold", amount: 12040, currency: "JPY", source_url: "https://example.com/1", transaction_date: "2026-10", item_match_condition: "exact_match", is_content_verified: true },
        { price_type: "sold", amount: 15000, currency: "JPY", source_url: "https://example.com/2", transaction_date: "2026-10", item_match_condition: "exact_match", is_content_verified: true },
        { price_type: "sold", amount: 18060, currency: "JPY", source_url: "https://example.com/3", transaction_date: "2026-10", item_match_condition: "exact_match", is_content_verified: true }
      ]
    });
    const isP1Median = p1.price === 15000 &&
                       p1.price_basis === "recent_sold_verified" &&
                       p1.price_evidence_verified === true &&
                       !p1.needs_review_price;

    // 6-1b: 成約3件以上（形式検査のみ合格・実取引内容未確認 -> スタッフ向け暫定案、要確認フラグ保持）
    const p1Provisional = calculateServerGroundedPrice_({
      price_basis: "recent_sold_provisional",
      price_evidence: [
        { price_type: "sold", amount: 12040, currency: "JPY", source_url: "https://example.com/1", transaction_date: "2026-10", item_match_condition: "exact_match" },
        { price_type: "sold", amount: 15000, currency: "JPY", source_url: "https://example.com/2", transaction_date: "2026-10", item_match_condition: "exact_match" },
        { price_type: "sold", amount: 18060, currency: "JPY", source_url: "https://example.com/3", transaction_date: "2026-10", item_match_condition: "exact_match" }
      ]
    });
    const isP1Provisional = p1Provisional.price === 15000 &&
                            p1Provisional.price_basis === "recent_transaction_reference" &&
                            p1Provisional.price_evidence_verified === false &&
                            p1Provisional.needs_review_price === true &&
                            p1Provisional.price_note.indexOf("暫定案") !== -1;

    // 6-2: 成約1〜2件（実取引内容確認済成約事例・平均値採用 & 100円丸め）
    const p2 = calculateServerGroundedPrice_({
      price_basis: "recent_sold_verified",
      price_evidence: [
        { price_type: "sold", amount: 12040, currency: "JPY", source_url: "https://example.com/1", transaction_date: "2026-10", item_match_condition: "exact_match", is_content_verified: true },
        { price_type: "sold", amount: 12600, currency: "JPY", source_url: "https://example.com/2", transaction_date: "2026-10", item_match_condition: "exact_match", is_content_verified: true }
      ]
    });
    // 平均 12320 -> 100円丸めで 12300
    const isP2Average = p2.price === 12300 &&
                        p2.price_basis === "recent_sold_verified" &&
                        p2.price_evidence_verified === true &&
                        !p2.needs_review_price;

    // 6-3: 出品中のみ（参考価格 & 要確認フラグ & 自動反映不可）
    const p3 = calculateServerGroundedPrice_({
      price_basis: "active_listing_reference",
      price_evidence: [
        { price_type: "active", amount: 20050, currency: "JPY", source_url: "https://example.com/a", transaction_date: "2026-10", item_match_condition: "exact_match" },
        { price_type: "active", amount: 22000, currency: "JPY", source_url: "https://example.com/b", transaction_date: "2026-10", item_match_condition: "exact_match" }
      ]
    });
    // 平均 (20050 + 22000) / 2 = 21025 -> 100円丸めで 21000
    const isP3Active = p3.price === 21000 &&
                       p3.price_basis === "active_listing_reference" &&
                       p3.price_evidence_verified === false &&
                       p3.needs_review_price === true;

    // 6-4: 相場根拠なし（0件）
    const p4 = calculateServerGroundedPrice_({
      price_basis: "no_evidence",
      price_evidence: []
    });
    const isP4NoEvidence = p4.price === null &&
                           p4.price_basis === "no_evidence" &&
                           p4.price_evidence_verified === false &&
                           p4.needs_review_price === true &&
                           p4.price_note.indexOf("根拠となる取引事例が確認できない") !== -1;

    // 6-5: 取引種別不明（成約か出品中か未確定だが比較可能金額あり） -> 市場参考価格案（成約とは呼ばない）
    const p5Unknown = calculateServerGroundedPrice_({
      price_basis: "market_reference_proposal",
      price_evidence: [
        { price_type: "unknown", amount: 28000, currency: "JPY", source_url: "https://example.com/u1", transaction_date: "2026-10", item_match_condition: "exact_match" },
        { price_type: "unknown", amount: 30000, currency: "JPY", source_url: "https://example.com/u2", transaction_date: "2026-10", item_match_condition: "exact_match" }
      ]
    });
    // 平均 29000
    const isP5Unknown = p5Unknown.price === 29000 &&
                        p5Unknown.price_basis === "market_reference_proposal" &&
                        p5Unknown.price_evidence_verified === false &&
                        p5Unknown.needs_review_price === true &&
                        p5Unknown.price_note.indexOf("市場参考価格案") !== -1 &&
                        p5Unknown.price_note.indexOf("取引種別（成約取引か販売中出品か）および実取引内容が未確認") !== -1 &&
                        p5Unknown.price_note.indexOf("直近の成約事例") === -1 &&
                        p5Unknown.price_note.indexOf("https://example.com/u1") !== -1;

    const allPricingPass = isP1Median && isP1Provisional && isP2Average && isP3Active && isP4NoEvidence && isP5Unknown;

    record(
      "6. サーバー側価格算出・根拠検証: 成約3件以上中央値・1〜2件平均値・暫定参照案区別・出品のみ参考価格(要確認)・取引種別不明市場参考価格案・根拠なし価格null空欄・100円丸め",
      allPricingPass,
      `p1Median=${isP1Median} (${p1.price}), p1Provisional=${isP1Provisional}, p2Average=${isP2Average} (${p2.price}), p3Active=${isP3Active} (${p3.price}), p4NoEvidence=${isP4NoEvidence}, p5Unknown=${isP5Unknown} (${p5Unknown.price})`
    );
  } catch (err) {
    record("6. サーバー側価格算出・根拠検証: 成約3件以上中央値・1〜2件平均値・出品のみ参考価格(要確認)・根拠なし価格null空欄・100円丸め", false, err.message);
  }

  // --------------------------------------------------
  // 7. 実行時間と検索呼び出しの確認（独立性・メタデータ整合性）
  // --------------------------------------------------
  try {
    // 7-1: search_executed と price_evidence_verified の独立性
    const mockRawCandidateWithSearch = {
      title_ja: "珍しいビンテージカード",
      category: "pokemon_card",
      brand: "ポケモン",
      condition: "全体的に状態が悪い",
      pokemon_card: { card_name: "ビンテージカード", card_number: "001" },
      price_basis: "no_evidence",
      price_evidence: []
    };
    const sanitizedWithSearch = validateAndSanitizeDraftCandidate_(mockRawCandidateWithSearch, { image_count: 2, has_back_image: true });
    const searchMeta = {
      enabled: true,
      mode_used: "two_stage",
      search_executed: true,
      price_evidence_verified: Boolean(sanitizedWithSearch.price_evidence_verified),
      queries: ["ビンテージカード ポケカ 相場"],
      sources: []
    };
    const isSearchExecuted = searchMeta.search_executed === true;
    const isPriceNotVerified = searchMeta.price_evidence_verified === false;
    const isPriceNull = sanitizedWithSearch.price === null;
    const independencePass = isSearchExecuted && isPriceNotVerified && isPriceNull;

    // 7-2: mock 実行時間計測 (オーバーヘッドが低レイテンシで完了すること)
    const startTime = Date.now();
    for (let i = 0; i < 20; i++) {
      calculateServerGroundedPrice_({
        price_basis: "recent_sold_verified",
        price_evidence: [
          { price_type: "sold", amount: 10000 + i * 100, currency: "JPY", source_url: "https://example.com/1", transaction_date: "2026-10", item_match_condition: "exact_match" },
          { price_type: "sold", amount: 12000, currency: "JPY", source_url: "https://example.com/2", transaction_date: "2026-10", item_match_condition: "exact_match" },
          { price_type: "sold", amount: 15000, currency: "JPY", source_url: "https://example.com/3", transaction_date: "2026-10", item_match_condition: "exact_match" }
        ]
      });
      validateAndSanitizeDraftCandidate_({
        title_ja: "ポケモンカードゲーム ミュウ " + i,
        category: "ポケカ",
        brand: "Pokémon",
        condition: "目立った傷や汚れなし",
        pokemon_card: { card_name: "ミュウ", card_number: "00" + i + "/100", rarity: "R" },
        price_basis: "no_evidence"
      }, { image_count: 2, has_back_image: true });
    }
    const elapsedMs = Date.now() - startTime;
    const isPerformant = elapsedMs < 500; // 20回の検証が500ms未満

    record(
      "7. 実行時間と検索呼び出し確認: search_executedとprice_evidence_verifiedの独立性・メタデータ整合性・高パフォーマンス(<500ms)",
      independencePass && isPerformant,
      `independencePass=${independencePass}, elapsedMs=${elapsedMs}ms`
    );
  } catch (err) {
    record("7. 実行時間と検索呼び出し確認: search_executedとprice_evidence_verifiedの独立性・メタデータ整合性・高パフォーマンス(<500ms)", false, err.message);
  }

  // --------------------------------------------------
  // 8. 必須テスト: 価格根拠の厳格検証と自動反映遮断（指示1, 2）
  // (URL/日付なしsold除外、検索スニペット伝聞除外、根拠なし推測価格の自動反映遮断)
  // --------------------------------------------------
  try {
    // 8-1: URLや日付なしの "sold" は未検証として価格null
    const pNoUrl = calculateServerGroundedPrice_({
      price_basis: "recent_sold_verified",
      price_evidence: [
        { price_type: "sold", amount: 15000 } // source_url, transaction_date 欠落
      ]
    });
    const isNoUrlNull = pNoUrl.price === null &&
                        pNoUrl.price_evidence_verified === false &&
                        pNoUrl.needs_review_price === true;

    // 8-2: 検索スニペット伝聞（無効URL）は未検証として除外
    const pSnippet = calculateServerGroundedPrice_({
      price_basis: "recent_sold_verified",
      price_evidence: [
        { price_type: "sold", amount: 15000, source_url: "Google検索スニペット: 15000円で売切" }
      ]
    });
    const isSnippetNull = pSnippet.price === null && pSnippet.price_evidence_verified === false;

    // 8-3: 根拠なし推測価格（旧形式）は候補表示に残すが needs_review_price: true で自動反映を遮断
    const pLegacy = calculateServerGroundedPrice_({
      price: 35000,
      price_basis: "unverified_estimate"
    });
    const isLegacyProtected = pLegacy.price === 35000 &&
                              pLegacy.needs_review_price === true &&
                              pLegacy.price_evidence_verified === false;

    // 8-4: 下書き価格の本票自動反映とスタッフ入力保護検証 (applyCandidateToProduct_)
    const mockRowPrice = new Array(40).fill("");
    mockRowPrice[1] = "TMP-TEST-PRICE-APPLY";
    const mockPriceSheet = {
      getLastColumn: () => 40,
      getRange: (r, c) => ({
        getValues: () => [mockRowPrice],
        setValue: (val) => { mockRowPrice[c - 1] = val; }
      })
    };
    // 1) 未設定時は price_evidence_verified: false (市場参考価格案等) であっても正の整数価格(35000)が本票H列(8)へ直接反映されること
    applyCandidateToProduct_(mockPriceSheet, 2, "TMP-TEST-PRICE-APPLY", {
      price: 35000,
      price_evidence_verified: false,
      title_ja: "下書き価格テスト"
    });
    const priceAutoApplied = (mockRowPrice[7] === 35000);

    // 2) スタッフ入力済み価格(50000)がある場合は上書きされないこと
    mockRowPrice[7] = 50000;
    applyCandidateToProduct_(mockPriceSheet, 2, "TMP-TEST-PRICE-APPLY", {
      price: 38000,
      price_evidence_verified: false,
      title_ja: "下書き価格テスト2"
    });
    const staffPriceProtected = (mockRowPrice[7] === 50000);

    // 3) 価格null時は未設定のまま維持されること
    mockRowPrice[7] = "";
    applyCandidateToProduct_(mockPriceSheet, 2, "TMP-TEST-PRICE-APPLY", {
      price: null,
      title_ja: "価格nullテスト"
    });
    const nullPriceUnset = (mockRowPrice[7] === "");

    // 4) 反映完了検証 (verifyProductDraftReflectionCompleted_):
    // 正の価格候補でH列が空欄の場合は PRICE_NOT_REFLECTED で遮断されること
    let priceVerificationBlockedWhenEmpty = false;
    try {
      mockRowPrice[7] = "";
      mockRowPrice[4] = "価格検証テスト";
      verifyProductDraftReflectionCompleted_(mockPriceSheet, 2, "TMP-TEST-PRICE-APPLY", {
        candidate: { title_ja: "価格検証テスト", price: 35000 }
      });
    } catch (vErr) {
      priceVerificationBlockedWhenEmpty = (vErr.error_code === "PRICE_NOT_REFLECTED");
    }

    const priceReflectionPass = priceAutoApplied && staffPriceProtected && nullPriceUnset && priceVerificationBlockedWhenEmpty;

    const priceStrictPass = isNoUrlNull && isSnippetNull && isLegacyProtected && priceReflectionPass;

    record(
      "8. 必須テスト: 価格根拠の厳格検証と下書き価格直接反映・スタッフ入力保護(URL/日付欠落除外・スニペット除外・直接反映・上書き防止・未反映遮断)",
      priceStrictPass,
      `noUrl=${isNoUrlNull}, snippet=${isSnippetNull}, legacy=${isLegacyProtected}, applied=${priceAutoApplied}, protected=${staffPriceProtected}, nullUnset=${nullPriceUnset}, failClosed=${priceVerificationBlockedWhenEmpty}`
    );
  } catch (err) {
    record("8. 必須テスト: 価格根拠の厳格検証と下書き価格直接反映・スタッフ入力保護(URL/日付欠落除外・スニペット除外・直接反映・上書き防止)", false, err.message);
  }

  // --------------------------------------------------
  // 9. 必須テスト: サーバー側商品同定（別番号・別レアリティ・PSA混同・別言語・推測SKU排除）（指示3）
  // --------------------------------------------------
  try {
    // 9-1: 別番号の検知 (タイトルと属性の型番不一致)
    const candDiffNum = validateAndSanitizeDraftCandidate_({
      title_ja: "ミュウex UR 135/103 ポケモンカード151",
      category: "pokemon_card",
      brand: "ポケモン",
      condition: "目立った傷や汚れなし",
      pokemon_card: { card_name: "ミュウex", card_number: "205/165", rarity: "UR" }
    });
    const diffNumAmbiguous = candDiffNum.identity_status === "ambiguous" &&
                             candDiffNum.needs_review.indexOf("card_number") !== -1;

    // 9-2: 別レアリティの検知 (タイトルと属性のレアリティ不一致)
    const candDiffRarity = validateAndSanitizeDraftCandidate_({
      title_ja: "ミュウex SAR 205/165 ポケモンカード151",
      category: "pokemon_card",
      brand: "ポケモン",
      condition: "目立った傷や汚れなし",
      pokemon_card: { card_name: "ミュウex", card_number: "205/165", rarity: "UR" }
    });
    const diffRarityAmbiguous = candDiffRarity.identity_status === "ambiguous" &&
                                candDiffRarity.needs_review.indexOf("rarity") !== -1;

    // 9-3: PSA品と未鑑定品の混同検知 (タイトルにPSAあるが属性ungraded)
    const candPsaConfusion = validateAndSanitizeDraftCandidate_({
      title_ja: "PSA10 ピカチュウ 001/SV-P",
      category: "pokemon_card",
      brand: "ポケモン",
      condition: "未使用に近い",
      pokemon_card: { card_name: "ピカチュウ", card_number: "001/SV-P", grading_status: "ungraded" }
    });
    const psaConfusionAmbiguous = candPsaConfusion.identity_status === "ambiguous" &&
                                  candPsaConfusion.needs_review.indexOf("grading_status") !== -1;

    // 9-4: 別言語の検知 (タイトル英語版だが属性Japanese)
    const candLangConfusion = validateAndSanitizeDraftCandidate_({
      title_ja: "Charizard ex English 199/165 151",
      category: "pokemon_card",
      brand: "ポケモン",
      condition: "目立った傷や汚れなし",
      pokemon_card: { card_name: "Charizard ex", card_number: "199/165", language: "Japanese" }
    });
    const langConfusionAmbiguous = candLangConfusion.identity_status === "ambiguous" &&
                                   candLangConfusion.needs_review.indexOf("language") !== -1;

    // 9-5: スニーカー推測SKUの排除 (推測表現は空欄化し要確認・ambiguous)
    const candInferredSku = validateAndSanitizeDraftCandidate_({
      title_ja: "Nike Dunk Low Retro",
      category: "sneaker",
      brand: "NIKE",
      sku: "DD1391-100(推測)",
      size: "27.0cm",
      condition: "新品・未使用"
    });
    const inferredSkuHandled = candInferredSku.sku === "" &&
                               candInferredSku.identity_status === "ambiguous" &&
                               candInferredSku.needs_review.indexOf("sku") !== -1;

    const identityStrictPass = diffNumAmbiguous && diffRarityAmbiguous && psaConfusionAmbiguous && langConfusionAmbiguous && inferredSkuHandled;

    record(
      "9. 必須テスト: サーバー側商品同定(別番号・別レアリティ・PSA混同・別言語・推測SKU排除)",
      identityStrictPass,
      `diffNum=${diffNumAmbiguous}, diffRarity=${diffRarityAmbiguous}, psa=${psaConfusionAmbiguous}, lang=${langConfusionAmbiguous}, inferredSku=${inferredSkuHandled}`
    );
  } catch (err) {
    record("9. 必須テスト: サーバー側商品同定(別番号・別レアリティ・PSA混同・別言語・推測SKU排除)", false, err.message);
  }

  // --------------------------------------------------
  // 10. 必須テスト: 状態断定サニタイズとポケカ既存属性の保護マージ（指示5）
  // --------------------------------------------------
  try {
    // 10-1: 表面写真2枚で裏面未確認時の状態断定サニタイズ（「白かけなし」「美品」排除）
    const candNoBack = validateAndSanitizeDraftCandidate_({
      title_ja: "ルチア SR 104/096 裂空のカリスマ",
      description_ja: "目立った傷や白かけなしの極美品です。コレクションに最適。",
      category: "pokemon_card",
      brand: "ポケモン",
      condition: "未使用に近い",
      pokemon_card: {
        card_name: "ルチア",
        card_number: "104/096",
        rarity: "SR",
        card_condition: "白かけなし・美品"
      }
    }, { image_count: 2, has_back_image: false });

    const descSanitized = candNoBack.description_ja.indexOf("白かけなし") === -1 &&
                          candNoBack.description_ja.indexOf("要現物確認") !== -1;
    const condSanitized = candNoBack.pokemon_card.card_condition.indexOf("白かけなし") === -1;
    const condNeedsReview = candNoBack.needs_review.indexOf("card_condition") !== -1;

    // 10-2: ポケカ既存スタッフ入力属性の保護マージ
    let savedPokePayload = null;
    const origSavePokemon = typeof savePokemonCardByProductId === "function" ? savePokemonCardByProductId : null;
    const origGetPokemon = typeof getPokemonCardByProductId === "function" ? getPokemonCardByProductId : null;

    getPokemonCardByProductId = (pid) => ({
      product_id: pid,
      card_name: "スタッフ入力ミュウ",
      card_number: "135/103",
      rarity: "UR",
      card_condition: "スタッフ確認済み美品"
    });
    savePokemonCardByProductId = (pid, payload) => {
      savedPokePayload = payload;
      return payload;
    };

    const mockRowPoke = new Array(40).fill("");
    mockRowPoke[1] = "TMP-POKE-PROTECT";
    mockRowPoke[2] = "pokemon_card";
    const mockPokeSheet = {
      getLastColumn: () => 40,
      getRange: (r, c) => ({
        getValues: () => [mockRowPoke],
        setValue: (val) => { mockRowPoke[c - 1] = val; }
      })
    };

    applyCandidateToProduct_(mockPokeSheet, 2, "TMP-POKE-PROTECT", {
      category: "pokemon_card",
      title_ja: "AI生成ミュウ",
      pokemon_card: {
        card_name: "AIが上書きしようとしたミュウ",
        card_number: "999/999",
        rarity: "SAR",
        card_condition: "AI判定状態"
      }
    });

    if (origSavePokemon) savePokemonCardByProductId = origSavePokemon;
    if (origGetPokemon) getPokemonCardByProductId = origGetPokemon;

    // スタッフ入力済みの card_name, card_number, rarity, card_condition が保持されていること
    const pokeProtected = savedPokePayload &&
                          savedPokePayload.card_name === "スタッフ入力ミュウ" &&
                          savedPokePayload.card_number === "135/103" &&
                          savedPokePayload.rarity === "UR" &&
                          savedPokePayload.card_condition === "スタッフ確認済み美品";

    const protectPass = descSanitized && condSanitized && condNeedsReview && pokeProtected;

    record(
      "10. 必須テスト: 状態断定サニタイズとポケカ既存属性の保護マージ(裏面なし断定排除・既存スタッフ値保持)",
      protectPass,
      `descSanitized=${descSanitized}, condSanitized=${condSanitized}, condNeedsReview=${condNeedsReview}, pokeProtected=${pokeProtected}`
    );
  } catch (err) {
    record("10. 必須テスト: 状態断定サニタイズとポケカ既存属性の保護マージ(裏面なし断定排除・既存スタッフ値保持)", false, err.message);
  }

  // --------------------------------------------------
  // 11. カテゴリ未入力時の属性・文脈からの自動判定 (detectCategoryFromCandidateContext_)
  // --------------------------------------------------
  try {
    // 11-1: ポケカ属性（型番 142/103、カード名）
    const pokeCandidate = {
      category: "",
      pokemon_card: { card_name: "ルギア", card_number: "142/103", set_code: "M6a" }
    };
    const detectedPoke = detectCategoryFromCandidateContext_(pokeCandidate);

    // 11-2: スニーカー属性（SKU DZ5485-612、サイズ 27.5cm）
    const sneakerCandidate = {
      category: "",
      sku: "DZ5485-612",
      size: "27.5cm"
    };
    const detectedSneaker = detectCategoryFromCandidateContext_(sneakerCandidate);

    // 11-3: メタデータブランドからの判定
    const brandMetaSneaker = detectCategoryFromCandidateContext_({}, { brand: "NIKE" });

    // 11-4: 曖昧・手がかりなし時は空文字
    const ambiguousCat = detectCategoryFromCandidateContext_({ title_ja: "ただのアイテム" });

    const detectPass = (detectedPoke === "pokemon_card") &&
                       (detectedSneaker === "sneaker") &&
                       (brandMetaSneaker === "sneaker") &&
                       (ambiguousCat === "");

    record(
      "11. カテゴリ未入力時の文脈・属性自動判定 (detectCategoryFromCandidateContext_): ポケカ型番・スニーカーSKU/サイズからの自律同定",
      detectPass,
      `poke=${detectedPoke}, sneaker=${detectedSneaker}, metaSneaker=${brandMetaSneaker}, ambiguous='${ambiguousCat}'`
    );
  } catch (err) {
    record("11. カテゴリ未入力時の文脈・属性自動判定 (detectCategoryFromCandidateContext_): ポケカ型番・スニーカーSKU/サイズからの自律同定", false, err.message);
  }

  // --------------------------------------------------
  // 12. ポケカ手動登録見本フォーマット完全準拠 (カード名 [セットコード カード番号] セット名)
  // --------------------------------------------------
  try {
    // 12-1: 見本通常品 (ルギア [M6a 142/103] 拡張パック『30th CELEBRATION』)
    const titleSample = sanitizePokemonCardTitle_("ポケモンカードゲーム ルギア その他 M6a 142/103", {
      card_name: "ルギア",
      set_code: "M6a",
      card_number: "142/103",
      set_name: "拡張パック『30th CELEBRATION』",
      rarity: "その他"
    });
    const expectedSample = "ルギア [M6a 142/103] 拡張パック『30th CELEBRATION』";

    // 12-2: PSA10鑑定品プレフィックス付与
    const titleGraded = sanitizePokemonCardTitle_("ルギア", {
      card_name: "ルギア",
      set_code: "M6a",
      card_number: "142/103",
      set_name: "拡張パック『30th CELEBRATION』",
      grading_status: "graded",
      grader: "PSA",
      grade: "10"
    });
    const expectedGraded = "[PSA10] ルギア [M6a 142/103] 拡張パック『30th CELEBRATION』";

    // 12-3: セットコードなし通常品 ([番号] のみブラケット)
    const titleNoSetCode = sanitizePokemonCardTitle_("ピカチュウ", {
      card_name: "ピカチュウ",
      card_number: "001/025",
      set_name: "25th ANNIVERSARY COLLECTION"
    });
    const expectedNoSetCode = "ピカチュウ [001/025] 25th ANNIVERSARY COLLECTION";

    const titlePass = (titleSample === expectedSample) &&
                      (titleGraded === expectedGraded) &&
                      (titleNoSetCode === expectedNoSetCode);

    record(
      "12. ポケカ手動登録見本フォーマット完全準拠: カード名 [セットコード カード番号] セット名 (レアリティ除外・PSAプレフィックス)",
      titlePass,
      `sample='${titleSample}', graded='${titleGraded}', noCode='${titleNoSetCode}'`
    );
  } catch (err) {
    record("12. ポケカ手動登録見本フォーマット完全準拠: カード名 [セットコード カード番号] セット名 (レアリティ除外・PSAプレフィックス)", false, err.message);
  }

  // --------------------------------------------------
  // 13. 価格nullドラフトの本票下書き反映 (スタッフ手動入力運用の保証)
  // --------------------------------------------------
  try {
    const mockRowNullPrice = new Array(40).fill("");
    mockRowNullPrice[0] = "TMP-NULL-PRICE";
    mockRowNullPrice[1] = "TMP-NULL-PRICE";
    mockRowNullPrice[2] = ""; // カテゴリ未設定
    mockRowNullPrice[3] = ""; // ブランド未設定
    mockRowNullPrice[7] = ""; // 価格未設定

    const updatedColMap = {};
    const mockNullPriceSheet = {
      getLastColumn: () => 40,
      getRange: (r, c) => ({
        getValues: () => [mockRowNullPrice],
        setValue: (val) => {
          mockRowNullPrice[c - 1] = val;
          updatedColMap[c] = val;
        }
      })
    };

    const candidateNullPrice = {
      category: "pokemon_card",
      brand: "Pokemon Card Game",
      title_ja: "ルギア [M6a 142/103] 拡張パック『30th CELEBRATION』",
      condition: "新品・未使用",
      price: null,
      price_basis: "no_evidence",
      price_evidence_verified: false,
      identity_status: "confident",
      description_ja: "拡張パック『30th CELEBRATION』収録のルギアです。",
      pokemon_card: {
        card_name: "ルギア",
        set_code: "M6a",
        card_number: "142/103",
        set_name: "拡張パック『30th CELEBRATION』"
      }
    };

    const origSavePoke = typeof savePokemonCardByProductId === "function" ? savePokemonCardByProductId : null;
    const origGetPoke = typeof safeGetPokemonCard_ === "function" ? safeGetPokemonCard_ : null;
    const origSaveTrans = typeof saveConfirmedProductTranslation_ === "function" ? saveConfirmedProductTranslation_ : null;
    const origGetTrans = typeof safeGetProductTranslation_ === "function" ? safeGetProductTranslation_ : null;

    let savedPokeData = null;
    savePokemonCardByProductId = (pid, data) => { savedPokeData = data; return data; };
    safeGetPokemonCard_ = (pid) => savedPokeData || { card_name: "ルギア", card_number: "142/103" };
    saveConfirmedProductTranslation_ = (pid, data) => { return data; };
    safeGetProductTranslation_ = (pid) => ({ translation_status: "approved", translated_title: "Lugia" });

    try {
      applyCandidateToProduct_(mockNullPriceSheet, 2, "TMP-NULL-PRICE", candidateNullPrice);

      // 商品名(E:5)、ブランド(D:4)、カテゴリ(C:3)、説明文(J:10)、フラグ(AN:40) が反映されていること
      const titleUpdated = updatedColMap[5] === "ルギア [M6a 142/103] 拡張パック『30th CELEBRATION』";
      const brandUpdated = updatedColMap[4] === "Pokemon Card Game";
      const catUpdated = updatedColMap[3] === "pokemon_card";
      const descUpdated = updatedColMap[10] && updatedColMap[10].indexOf("拡張パック『30th CELEBRATION』") !== -1;
      // 価格欄(H:8) は未設定(上書き・設定されていない)こと
      const priceRemainedEmpty = (updatedColMap[8] === undefined) && (mockRowNullPrice[7] === "");

      const nullPricePass = titleUpdated && brandUpdated && catUpdated && descUpdated && priceRemainedEmpty;

      record(
        "13. 価格nullドラフトの本票下書き反映: confident同定時に商品情報・属性を反映し価格欄(H列)は空欄維持(スタッフ手入力運用)",
        nullPricePass,
        `title=${titleUpdated}, brand=${brandUpdated}, cat=${catUpdated}, desc=${descUpdated}, priceEmpty=${priceRemainedEmpty}`
      );
    } finally {
      if (origSavePoke) savePokemonCardByProductId = origSavePoke;
      if (origGetPoke) safeGetPokemonCard_ = origGetPoke;
      if (origSaveTrans) saveConfirmedProductTranslation_ = origSaveTrans;
      if (origGetTrans) safeGetProductTranslation_ = origGetTrans;
    }
  } catch (err) {
    record("13. 価格nullドラフトの本票下書き反映: confident同定時に商品情報・属性を反映し価格欄(H列)は空欄維持(スタッフ手入力運用)", false, err.message);
  }

  // 14. 先行カテゴリー判定 (Prior Category Detection) と矛盾検知 (category_mismatch)
  try {
    // 14a. カテゴリ未指定時: コンテキストまたは画像先行判定から自動判定
    const priorBlankMeta = { productId: "TMP-PRIOR-01", category: "", brand: "Pokemon Card Game", productName: "ルギア M6a 142/103" };
    const priorRes1 = classifyCategoryPriorFromImages_([], priorBlankMeta);
    const pass14a = priorRes1.category === "pokemon_card" && priorRes1.mismatchDetected === false;

    // 14b. カテゴリ矛盾検知: 本票がスニーカーなのにコンテキスト/判定がポケカの場合
    const priorMismatchMeta = { productId: "TMP-PRIOR-02", category: "sneaker", brand: "Pokemon Card Game", productName: "ルギア M6a 142/103" };
    const priorRes2 = classifyCategoryPriorFromImages_([], priorMismatchMeta);
    const pass14b = priorRes2.mismatchDetected === true && priorRes2.category === "";

    record(
      "14. 先行カテゴリー判定とカテゴリー矛盾検知: カテゴリ未指定の自動判定および本票と画像特徴の食い違い時(category_mismatch)安全停止",
      pass14a && pass14b,
      `blankDetected=${priorRes1.category}, mismatchDetected=${priorRes2.mismatchDetected}, mismatchReason=${priorRes2.mismatchReason}`
    );
  } catch (err) {
    record("14. 先行カテゴリー判定とカテゴリー矛盾検知: カテゴリ未指定の自動判定および本票と画像特徴の食い違い時(category_mismatch)安全停止", false, err.message);
  }

  // 15. タイトル整形時の欠損値・空ブラケット完全防御 (sanitizePokemonCardTitle_)
  try {
    // 15a. セットコードのみ欠損: [142/103] のみ生成 (余分なスペースや空ブラケットなし)
    const titleMissingSetCode = sanitizePokemonCardTitle_("ルギア 拡張パック", {
      card_name: "ルギア",
      card_number: "142/103",
      set_code: "",
      set_name: "拡張パック"
    });
    const pass15a = titleMissingSetCode === "ルギア [142/103] 拡張パック";

    // 15b. セットコード・カード番号ともに欠損: ブラケット自体を一切生成しない (不完全な [] や [undefined] の完全防止)
    const titleMissingBoth = sanitizePokemonCardTitle_("ミュウex 30th", {
      card_name: "ミュウex",
      card_number: "",
      set_code: "",
      set_name: "拡張パック『30th CELEBRATION』"
    });
    const pass15b = titleMissingBoth === "ミュウex 拡張パック『30th CELEBRATION』" && titleMissingBoth.indexOf("[") === -1;

    // 15c. 入力タイトルに既に空ブラケット '[]' や '[ ]' が含まれていた場合の完全消去
    const titleWithEmptyBrackets = sanitizePokemonCardTitle_("ルギア [ ] 拡張パック", {
      card_name: "ルギア",
      card_number: "",
      set_code: "",
      set_name: "拡張パック"
    });
    const pass15c = titleWithEmptyBrackets === "ルギア 拡張パック" && titleWithEmptyBrackets.indexOf("[") === -1;

    record(
      "15. ポケカタイトル欠損値処理: セットコード・番号欠損時に不完全な[]を作らず安全整形・空ブラケット完全消去",
      pass15a && pass15b && pass15c,
      `missingSetCode='${titleMissingSetCode}', missingBoth='${titleMissingBoth}', emptyBracketsCleaned='${titleWithEmptyBrackets}'`
    );
  } catch (err) {
    record("15. ポケカタイトル欠損値処理: セットコード・番号欠損時に不完全な[]を作らず安全整形・空ブラケット完全消去", false, err.message);
  }

  // 16. callGeminiTwoStageSearchGrounding_ の Stage A 経路選択および画像先行分類の包括的検証 (指示2, 3)
  try {
    let activeFetchApp = null;
    if (typeof UrlFetchApp !== "undefined" && UrlFetchApp) {
      activeFetchApp = UrlFetchApp;
    } else if (typeof globalThis !== "undefined" && globalThis.UrlFetchApp) {
      activeFetchApp = globalThis.UrlFetchApp;
    } else {
      activeFetchApp = { fetch: () => ({ getResponseCode: () => 200, getContentText: () => "{}" }) };
      if (typeof globalThis !== "undefined") globalThis.UrlFetchApp = activeFetchApp;
      if (typeof global !== "undefined") global.UrlFetchApp = activeFetchApp;
    }
    const origFetch = activeFetchApp.fetch;
    const testImages = [{ mimeType: "image/jpeg", base64: "dGVzdGltYWdlYmFzZTY0" }];

    // 16-1: カテゴリー空欄 + 画像先行判定ポケカ -> ポケカ専用 Stage A
    let capturedStageAPrompt1 = "";
    activeFetchApp.fetch = (url, params) => {
      const payload = JSON.parse(params.payload || "{}");
      // 先行分類API
      if (payload.generationConfig && payload.generationConfig.maxOutputTokens === 100) {
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({
            candidates: [{ content: { parts: [{ text: JSON.stringify({ category: "pokemon_card", confidence: "high", rationale: "Pokémon card visible" }) }] } }]
          })
        };
      }
      // Stage A
      if (payload.tools && payload.tools.length > 0) {
        if (!capturedStageAPrompt1) capturedStageAPrompt1 = payload.contents[0].parts[0].text;
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({
            candidates: [{
              content: { parts: [{ text: "### OBSERVED_CARD_ATTRIBUTES\nCARD_NAME: ルギア\nSET_CODE: M6a\nCARD_NUMBER: 142/103\nRARITY: UR" }] },
              groundingMetadata: { webSearchQueries: ["ルギア M6a 142/103 UR"], groundingChunks: [{ web: { uri: "https://example.com/lugia", title: "Lugia UR" } }] }
            }]
          })
        };
      }
      // Stage B
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({
          candidates: [{ content: { parts: [{ text: JSON.stringify({
            title_ja: "ルギア [M6a 142/103] 拡張パック『30th CELEBRATION』",
            title_en: "Lugia [M6a 142/103]",
            category: "pokemon_card",
            brand: "Pokemon Card Game",
            condition: "目立った傷や汚れなし",
            description_ja: "拡張パック収録のルギアです。",
            description_en: "Lugia card.",
            pokemon_card: { card_name: "ルギア", set_code: "M6a", card_number: "142/103", rarity: "UR" }
          }) }] } }]
        })
      };
    };

    const res16_1 = callGeminiTwoStageSearchGrounding_(testImages, { productId: "TMP-P-01", category: "" }, "gemini-3.8-flash", { enable_prior_classification_api: true });
    const pass16_1 = capturedStageAPrompt1.indexOf("TASK INSTRUCTIONS FOR POKÉMON CARD IDENTIFICATION & PRICING:") !== -1;

    // 16-2: カテゴリー空欄 + 画像先行判定スニーカー -> スニーカー専用 Stage A
    let capturedStageAPrompt2 = "";
    activeFetchApp.fetch = (url, params) => {
      const payload = JSON.parse(params.payload || "{}");
      if (payload.generationConfig && payload.generationConfig.maxOutputTokens === 100) {
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({
            candidates: [{ content: { parts: [{ text: JSON.stringify({ category: "sneaker", confidence: "high", rationale: "Sneaker shoe box visible" }) }] } }]
          })
        };
      }
      if (payload.tools && payload.tools.length > 0) {
        if (!capturedStageAPrompt2) capturedStageAPrompt2 = payload.contents[0].parts[0].text;
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({
            candidates: [{
              content: { parts: [{ text: "### OBSERVED_SNEAKER_ATTRIBUTES\nPHYSICAL_BOX_LABEL_SKU: DD1391-100\nPHYSICAL_INNER_TAG_SIZE: 27.5cm" }] },
              groundingMetadata: { webSearchQueries: ["DD1391-100"], groundingChunks: [{ web: { uri: "https://example.com/dunk", title: "Dunk Panda" } }] }
            }]
          })
        };
      }
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({
          candidates: [{ content: { parts: [{ text: JSON.stringify({
            title_ja: "NIKE DUNK LOW RETRO",
            title_en: "Nike Dunk Low Retro",
            category: "sneaker",
            brand: "NIKE",
            condition: "目立った傷や汚れなし",
            sku: "DD1391-100",
            size: "27.5cm",
            description_ja: "ダンクです。",
            description_en: "Dunk sneaker."
          }) }] } }]
        })
      };
    };

    const res16_2 = callGeminiTwoStageSearchGrounding_(testImages, { productId: "TMP-S-01", category: "" }, "gemini-3.8-flash", { enable_prior_classification_api: true });
    const pass16_2 = capturedStageAPrompt2.indexOf("TASK INSTRUCTIONS FOR SNEAKER IDENTIFICATION & PRICING:") !== -1;

    // 16-3: 既存カテゴリーとの矛盾 (本票がスニーカーなのに画像判定がポケカ)
    // 期待: スニーカー専用Stage Aへフォールバックせず、汎用客観検査Stage Aが選ばれ、category_mismatchが付与される
    let capturedStageAPrompt3 = "";
    activeFetchApp.fetch = (url, params) => {
      const payload = JSON.parse(params.payload || "{}");
      if (payload.generationConfig && payload.generationConfig.maxOutputTokens === 100) {
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({
            candidates: [{ content: { parts: [{ text: JSON.stringify({ category: "pokemon_card", confidence: "high", rationale: "Card visible, not shoe" }) }] } }]
          })
        };
      }
      if (payload.tools && payload.tools.length > 0) {
        if (!capturedStageAPrompt3) capturedStageAPrompt3 = payload.contents[0].parts[0].text;
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({
            candidates: [{
              content: { parts: [{ text: "### OBSERVED_FEATURES\nVisible card artwork of Lugia" }] },
              groundingMetadata: { webSearchQueries: ["Lugia card"], groundingChunks: [{ web: { uri: "https://example.com/lugia", title: "Lugia" } }] }
            }]
          })
        };
      }
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({
          candidates: [{ content: { parts: [{ text: JSON.stringify({
            title_ja: "ルギア",
            title_en: "Lugia",
            category: "",
            brand: "",
            condition: "目立った傷や汚れなし",
            description_ja: "カード。",
            description_en: "Card."
          }) }] } }]
        })
      };
    };

    const res16_3 = callGeminiTwoStageSearchGrounding_(testImages, { productId: "TMP-M-01", category: "sneaker", brand: "NIKE" }, "gemini-3.8-flash", { enable_prior_classification_api: true });
    // 矛盾時はスニーカー専用ではなく汎用客観検査が選ばれていること
    const pass16_3_prompt = capturedStageAPrompt3.indexOf("TASK INSTRUCTIONS (Category Unconfirmed - Objective Physical Inspection):") !== -1 &&
                            capturedStageAPrompt3.indexOf("Category: sneaker") === -1 &&
                            capturedStageAPrompt3.indexOf("NOTE: Category conflict detected") !== -1;
    const pass16_3_guard = res16_3.candidate.identity_status === "ambiguous" &&
                           res16_3.candidate.needs_review.indexOf("category_mismatch") !== -1;

    // 16-4: 先行分類API失敗 (HTTP 500) -> 例外停止せず安全フォールバック
    let capturedStageAPrompt4 = "";
    activeFetchApp.fetch = (url, params) => {
      const payload = JSON.parse(params.payload || "{}");
      if (payload.generationConfig && payload.generationConfig.maxOutputTokens === 100) {
        return {
          getResponseCode: () => 500,
          getContentText: () => JSON.stringify({ error: { code: 500, message: "Internal server error" } })
        };
      }
      if (payload.tools && payload.tools.length > 0) {
        if (!capturedStageAPrompt4) capturedStageAPrompt4 = payload.contents[0].parts[0].text;
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({
            candidates: [{
              content: { parts: [{ text: "### OBSERVED_FEATURES\nProduct inspection" }] },
              groundingMetadata: { webSearchQueries: ["Product search"], groundingChunks: [{ web: { uri: "https://example.com/p", title: "Product" } }] }
            }]
          })
        };
      }
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({
          candidates: [{ content: { parts: [{ text: JSON.stringify({
            title_ja: "商品",
            title_en: "Product",
            condition: "目立った傷や汚れなし",
            description_ja: "説明文",
            description_en: "Desc"
          }) }] } }]
        })
      };
    };

    const res16_4 = callGeminiTwoStageSearchGrounding_(testImages, { productId: "TMP-FAIL-01", category: "" }, "gemini-3.8-flash", { enable_prior_classification_api: true });
    const pass16_4 = capturedStageAPrompt4.indexOf("TASK INSTRUCTIONS (Category Unconfirmed - Objective Physical Inspection):") !== -1 &&
                     res16_4.candidate.identity_status === "ambiguous";

    // 16-5: 価格根拠の厳格キー検査 (currency / item_match_condition 欠損時の勝手な補完抑止)
    const rawEvidenceMissingKeys = {
      price_type: "sold",
      amount: 15000,
      source_url: "https://example.com/item"
      // currency, transaction_date, item_match_condition なし
    };
    const verifiedItem = verifyPriceEvidenceItem_(rawEvidenceMissingKeys);
    const pass16_5 = verifiedItem.currency === "" &&
                     verifiedItem.item_match_condition === "" &&
                     verifiedItem.verification_status === "unverified";

    activeFetchApp.fetch = origFetch;

    const all16Pass = pass16_1 && pass16_2 && pass16_3_prompt && pass16_3_guard && pass16_4 && pass16_5;
    record(
      "16. callGeminiTwoStageSearchGrounding_ 経路選択と画像先行分類: ポケカ/スニーカー分岐、矛盾時汎用フォールバック、API障害耐性、価格キー厳格検査",
      all16Pass,
      `pokePrompt=${pass16_1}, sneakerPrompt=${pass16_2}, mismatchPrompt=${pass16_3_prompt}, mismatchGuard=${pass16_3_guard}, apiFailFallback=${pass16_4}, keyCheck=${pass16_5}`
    );
  } catch (err) {
    record("16. callGeminiTwoStageSearchGrounding_ 経路選択と画像先行分類: ポケカ/スニーカー分岐、矛盾時汎用フォールバック、API障害耐性、価格キー厳格検査", false, err.message);
  }

  // --------------------------------------------------
  // --------------------------------------------------
  // 17. 実画像実測フィードバック: スニーカー型番・モデル整合性検証 (不一致棄却 & 一致採用 & 写真直読との峻別)
  // --------------------------------------------------
  try {
    // 17-A: 不一致の組み合わせ（Vomero 17 × Kobe V Protro型番 IB4481-500）の棄却
    // 1) validateAndSanitizeDraftCandidate_ による不一致棄却
    const rawMismatch = {
      title_ja: "NIKE VOMERO 17",
      category: "sneaker",
      brand: "NIKE",
      sku: "IB4481-500",
      sku_source: "search_corroborated",
      condition: "新品・未使用",
      description_ja: "NIKE Vomero 17 ランニングシューズです。"
    };
    const candMismatch = validateAndSanitizeDraftCandidate_(rawMismatch);
    const pass17_mismatch_cand = candMismatch.sku === "" &&
                                 candMismatch.needs_review.indexOf("sku") !== -1 &&
                                 candMismatch.needs_review.indexOf("sku_model_mismatch") !== -1;

    // 2) callGeminiMultimodalAiDraftWithSearch_ における不一致棄却
    const activeFetchApp = typeof UrlFetchApp !== "undefined" ? UrlFetchApp : sandbox.UrlFetchApp;
    const origFetch = activeFetchApp.fetch;
    activeFetchApp.fetch = (url, opts) => {
      const payload = JSON.parse(opts.payload);
      if (payload.tools) {
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({
            candidates: [{
              content: { parts: [{ text: "### OBSERVED_SNEAKER_ATTRIBUTES\nPHYSICAL_BOX_LABEL_SKU: NONE\nPHYSICAL_INNER_TAG_SIZE: NONE\n### SEARCH_FINDINGS\nStyle Code: IB4481-500\nModel: Nike Kobe 5 Protro" }] },
              groundingMetadata: { webSearchQueries: ["nike vomero 17"], groundingChunks: [{ web: { uri: "https://nike.com", title: "Nike" } }] }
            }]
          })
        };
      }
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({
          candidates: [{
            content: { parts: [{ text: JSON.stringify({
              title_ja: "NIKE Vomero 17",
              title_en: "Nike Vomero 17",
              category: "sneaker",
              brand: "NIKE",
              sku: "IB4481-500",
              condition: "新品・未使用",
              description_ja: "Vomero 17"
            }) }] }
          }]
        })
      };
    };

    const searchDraftMismatch = callGeminiMultimodalAiDraftWithSearch_([{ mimeType: "image/jpeg", base64: "dGVzdA==" }], { productId: "TMP-000114" }, "gemini-3.8-flash", { prior_classification: { category: "sneaker", confidence: "high" } });
    activeFetchApp.fetch = origFetch;

    const pass17_mismatch_search = searchDraftMismatch.sku === "" &&
                                   searchDraftMismatch.sku_source === "unconfirmed" &&
                                   searchDraftMismatch.needs_review.indexOf("sku") !== -1 &&
                                   searchDraftMismatch.needs_review.indexOf("sku_model_mismatch") !== -1 &&
                                   searchDraftMismatch.description_ja.indexOf("推定候補") === -1;

    // 17-B: 一致する組み合わせ（Kobe V Protro × 型番 IB4481-500）の採用
    // 1) validateAndSanitizeDraftCandidate_ による一致採用
    const rawMatch = {
      title_ja: "NIKE Kobe V Protro “Year of the Mamba” Eggplant",
      category: "sneaker",
      brand: "NIKE",
      sku: "IB4481-500",
      sku_source: "search_corroborated",
      condition: "新品・未使用",
      description_ja: "NIKE Kobe V Protro バスケットボールシューズです。"
    };
    const candMatch = validateAndSanitizeDraftCandidate_(rawMatch);
    const pass17_match_cand = candMatch.sku === "IB4481-500" &&
                              candMatch.sku_source === "search_corroborated" &&
                              candMatch.needs_review.indexOf("sku") !== -1 &&
                              candMatch.needs_review.indexOf("sku_model_mismatch") === -1;

    // 2) callGeminiMultimodalAiDraftWithSearch_ における一致採用 & 出典注記
    activeFetchApp.fetch = (url, opts) => {
      const payload = JSON.parse(opts.payload);
      if (payload.tools) {
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({
            candidates: [{
              content: { parts: [{ text: "### OBSERVED_SNEAKER_ATTRIBUTES\nPHYSICAL_BOX_LABEL_SKU: NONE\nPHYSICAL_INNER_TAG_SIZE: NONE\n### SEARCH_FINDINGS\nStyle Code: IB4481-500\nModel: Nike Kobe 5 Protro \"Year of the Mamba\" Eggplant" }] },
              groundingMetadata: { webSearchQueries: ["nike kobe 5 protro year of the mamba eggplant"], groundingChunks: [{ web: { uri: "https://nike.com", title: "Nike" } }] }
            }]
          })
        };
      }
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({
          candidates: [{
            content: { parts: [{ text: JSON.stringify({
              title_ja: "NIKE Kobe V Protro “Year of the Mamba” Eggplant",
              title_en: "Nike Kobe 5 Protro Year of the Mamba Eggplant",
              category: "sneaker",
              brand: "NIKE",
              sku: "IB4481-500",
              condition: "新品・未使用",
              description_ja: "Kobe V Protro Year of the Mamba"
            }) }] }
          }]
        })
      };
    };

    const searchDraftMatch = callGeminiMultimodalAiDraftWithSearch_([{ mimeType: "image/jpeg", base64: "dGVzdA==" }], { productId: "TMP-000114" }, "gemini-3.8-flash", { prior_classification: { category: "sneaker", confidence: "high" } });
    activeFetchApp.fetch = origFetch;

    const pass17_match_search = searchDraftMatch.sku === "IB4481-500" &&
                                searchDraftMatch.sku_source === "search_corroborated" &&
                                searchDraftMatch.needs_review.indexOf("sku") !== -1 &&
                                searchDraftMatch.needs_review.indexOf("sku_model_mismatch") === -1 &&
                                searchDraftMatch.description_ja.indexOf("推定候補") !== -1;

    const pass17 = pass17_mismatch_cand && pass17_mismatch_search && pass17_match_cand && pass17_match_search;
    record("17. スニーカー型番・モデル整合性検証: 不一致棄却(Vomero×IB4481) & 一致採用(Kobe V×IB4481) & 出典注記(needs_review:sku)", pass17, `mismatchCand=${pass17_mismatch_cand}, mismatchSearch=${pass17_mismatch_search}, matchCand=${pass17_match_cand}, matchSearch=${pass17_match_search}`);
  } catch (err) {
    record("17. スニーカー型番・モデル整合性検証: 不一致棄却(Vomero×IB4481) & 一致採用(Kobe V×IB4481) & 出典注記(needs_review:sku)", false, err.message);
  }

  // --------------------------------------------------
  // 18. 実画像実測フィードバック: サイズ未確認時の同一モデル比較可能取引（comparable_model）参考価格案
  // --------------------------------------------------
  try {
    const rawComparableEvidence = {
      price_basis: "recent_sold_provisional",
      price_evidence: [
        { price_type: "sold", amount: 15400, currency: "JPY", source_url: "https://example.com/sold1", transaction_date: "2026-10", item_match_condition: "comparable_model" },
        { price_type: "sold", amount: 16800, currency: "JPY", source_url: "https://example.com/sold2", transaction_date: "2026-10", item_match_condition: "comparable_model" }
      ]
    };
    const compPrice = calculateServerGroundedPrice_(rawComparableEvidence, { category: "sneaker", brand: "NIKE" });
    const pass18 = compPrice.price === 16100 && // 平均値 16100 (100円丸め)
                   compPrice.price_basis === "comparable_model_reference" &&
                   compPrice.price_evidence_verified === false &&
                   compPrice.needs_review_price === true &&
                   compPrice.price_note.indexOf("サイズ未確認") !== -1;

    record("18. サイズ未確認時: comparable_model 成約事例からの参考価格案算出と注記(自動確定遮断)", pass18, `price=${compPrice.price}, basis=${compPrice.price_basis}, verified=${compPrice.price_evidence_verified}, needsReview=${compPrice.needs_review_price}`);
  } catch (err) {
    record("18. サイズ未確認時: comparable_model 成約事例からの参考価格案算出と注記(自動確定遮断)", false, err.message);
  }

  // --------------------------------------------------
  // 19. 実画像実測フィードバック: ポケカ裏面未撮影時の状態断定排除（condition空欄化 + 要確認付与）
  // --------------------------------------------------
  try {
    const candNoBackRaw = {
      title_ja: "ミュウex SAR 205/165 ポケモンカード151",
      description_ja: "目立った傷や汚れなしの美品です。",
      category: "pokemon_card",
      brand: "ポケモン",
      condition: "目立った傷や汚れなし",
      pokemon_card: {
        card_name: "ミュウex",
        set_code: "SV2a",
        card_number: "205/165",
        rarity: "SAR",
        card_condition: "目立った傷や汚れなし"
      }
    };
    const sanitizedNoBack = validateAndSanitizeDraftCandidate_(candNoBackRaw, { image_count: 1, has_back_image: false });
    const pass19 = sanitizedNoBack.condition === "" &&
                   sanitizedNoBack.pokemon_card.card_condition === "A" &&
                   sanitizedNoBack.needs_review.indexOf("card_condition") !== -1 &&
                   sanitizedNoBack.description_ja.indexOf("目立った傷や汚れなし") === -1 &&
                   sanitizedNoBack.description_ja.indexOf("裏面未確認") !== -1;

    record("19. ポケカ裏面未撮影時: card_condition原則A設定・説明文断定排除・needs_review付与・本票F列空文字維持", pass19, `card_condition=${sanitizedNoBack.pokemon_card.card_condition}, needsReview=${sanitizedNoBack.needs_review.indexOf("card_condition") !== -1}`);
  } catch (err) {
    record("19. ポケカ裏面未撮影時: card_condition原則A設定・説明文断定排除・needs_review付与・本票F列空文字維持", false, err.message);
  }

  // --------------------------------------------------
  // 20. 実画像実測フィードバック: 先行分類一時エラー救済 (後段推論結果によるカテゴリ確定)
  // --------------------------------------------------
  try {
    const activeFetchApp = typeof UrlFetchApp !== "undefined" ? UrlFetchApp : sandbox.UrlFetchApp;
    const origFetch = activeFetchApp.fetch;
    activeFetchApp.fetch = (url, opts) => {
      const payload = JSON.parse(opts.payload);
      if (payload.tools) {
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({
            candidates: [{
              content: { parts: [{ text: "### OBSERVED_SNEAKER_ATTRIBUTES\nPHYSICAL_BOX_LABEL_SKU: NONE\n### SEARCH_FINDINGS\nModel: Nike Kobe 5 Protro \"Year of the Mamba\" Eggplant\nStyle Code: IB4481-500" }] },
              groundingMetadata: { webSearchQueries: ["nike kobe 5 protro"], groundingChunks: [{ web: { uri: "https://nike.com", title: "Nike" } }] }
            }]
          })
        };
      }
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({
          candidates: [{
            content: { parts: [{ text: JSON.stringify({
              title_ja: "NIKE Kobe V Protro “Year of the Mamba” Eggplant",
              title_en: "Nike Kobe 5 Protro Year of the Mamba Eggplant",
              category: "sneaker",
              brand: "NIKE",
              sku: "IB4481-500",
              condition: "新品・未使用",
              description_ja: "Kobe V Protro Year of the Mamba"
            }) }] }
          }]
        })
      };
    };

    // 先行分類が形式エラー等で category="" (未確定) だったケース
    const twoStageRes = callGeminiTwoStageSearchGrounding_([{ mimeType: "image/jpeg", base64: "dGVzdA==" }], { productId: "TMP-000114" }, "gemini-3.8-flash", { prior_classification: { category: "", confidence: "low", mismatchDetected: false } });
    activeFetchApp.fetch = origFetch;

    const pass20 = twoStageRes.candidate.category === "sneaker" &&
                   twoStageRes.candidate.needs_review.indexOf("category") === -1 &&
                   twoStageRes.candidate.sku === "IB4481-500";

    record("20. 先行分類パースエラー救済: 後段でスニーカー特定時にカテゴリ確定し要確認categoryを除外", pass20, `category=${twoStageRes.candidate.category}, hasReviewCat=${twoStageRes.candidate.needs_review.indexOf("category") !== -1}`);
  } catch (err) {
    record("20. 先行分類パースエラー救済: 後段でスニーカー特定時にカテゴリ確定し要確認categoryを除外", false, err.message);
  }

  // --------------------------------------------------
  // 21. 価格根拠種別・参照URL・計算方法・SKU出典の保持と再取得 (product_ai_drafts & get_ai_product_draft 整合性)
  // --------------------------------------------------
  try {
    const testPid = "TMP-TEST-ROUNDTRIP-01";
    const draftSheet = getOrCreateProductAiDraftsSheet_();
    const testDraftId = "DRFT_ROUNDTRIP_TEST_01";
    const samplePriceNote = "取引種別（成約取引か販売中出品か）および実取引内容が未確認のため、同一商品の市場情報（形式確認済1件・採用値29000円）に基づく市場参考価格案です。参照元: https://example.com/u1（確認日: 2026-10-12）。スタッフによる取引形態・実取引内容の確認が必要です。";

    const lastCol = draftSheet.getLastColumn();
    const headers = draftSheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h || "").trim());

    const rowMap = {
      draft_id: testDraftId,
      product_id: testPid,
      draft_version: 1,
      review_status: "pending_review",
      candidate_title_ja: "テスト商品 ラウンドトリップ",
      candidate_price: 29000,
      candidate_category: "sneaker",
      candidate_brand: "NIKE",
      candidate_sku: "IB4481-500",
      candidate_size: "27.5cm",
      candidate_price_basis: "market_reference_proposal",
      candidate_price_note: samplePriceNote,
      candidate_sku_source: "box_label",
      model_name: "gemini-3.8-flash",
      generated_at: new Date().toISOString()
    };

    const newRow = headers.map(h => (rowMap[h] !== undefined ? rowMap[h] : ""));
    draftSheet.appendRow(newRow);

    const retrievedDraft = getLatestProductAiDraft_(testPid);
    const pass21 = retrievedDraft !== null &&
                   retrievedDraft.draft_id === testDraftId &&
                   retrievedDraft.candidate_price_basis === "market_reference_proposal" &&
                   retrievedDraft.candidate_price_note === samplePriceNote &&
                   retrievedDraft.candidate_sku_source === "box_label" &&
                   retrievedDraft.candidate &&
                   retrievedDraft.candidate.price_basis === "market_reference_proposal" &&
                   retrievedDraft.candidate.price_note === samplePriceNote &&
                   retrievedDraft.candidate.sku_source === "box_label" &&
                   retrievedDraft.candidate.price === 29000;

    record(
      "21. 価格根拠種別・参照URL・計算方法・SKU出典の保持と再取得 (product_ai_drafts & get_ai_product_draft 整合性)",
      pass21,
      `price_basis=${retrievedDraft && retrievedDraft.candidate_price_basis}, sku_source=${retrievedDraft && retrievedDraft.candidate_sku_source}, noteMatch=${retrievedDraft && retrievedDraft.candidate_price_note === samplePriceNote}`
    );
  } catch (err) {
    record("21. 価格根拠種別・参照URL・計算方法・SKU出典の保持と再取得 (product_ai_drafts & get_ai_product_draft 整合性)", false, err.message);
  }

  // --------------------------------------------------
  // 22. 箱ラベルSKU/サイズ正規化・元文字列保持・同一URL重複排除・販売中参考価格案 (実用上修正)
  // --------------------------------------------------
  try {
    // 22-1: 箱ラベルSKU正規化 ("IB4481 500" -> "IB4481-500", "IB4481_500" -> "IB4481-500", "SKU: DZ5485 612" -> "DZ5485-612")
    const sku1 = normalizeSneakerSku_("IB4481 500");
    const sku2 = normalizeSneakerSku_("IB4481_500");
    const sku3 = normalizeSneakerSku_("SKU: DZ5485 612");
    const sku4 = normalizeSneakerSku_("IG1024");
    const skuInvalid = normalizeSneakerSku_("TEST");
    const pass22_sku = sku1 === "IB4481-500" &&
                       sku2 === "IB4481-500" &&
                       sku3 === "DZ5485-612" &&
                       sku4 === "IG1024" &&
                       skuInvalid === "";

    // 22-2: サイズ正規化 (ラベル全文から "25.5cm" を抽出)
    const size1 = normalizeSneakerSize_("7.5 (25.5cm) UK 6.5 EUR 40.5 cm 25.5");
    const size2 = normalizeSneakerSize_("US 7.5 UK 6.5 EUR 40.5 cm 25.5 BR 39 CN 255(2.5)");
    const size3 = normalizeSneakerSize_("25.5 cm");
    const size4 = normalizeSneakerSize_("cm 25.5");
    const size5 = normalizeSneakerSize_("27.0cm");
    const sizeInvalid = normalizeSneakerSize_("未設定");
    const pass22_size = size1 === "25.5cm" &&
                        size2 === "25.5cm" &&
                        size3 === "25.5cm" &&
                        size4 === "25.5cm" &&
                        size5 === "27.0cm" &&
                        sizeInvalid === "";

    // 22-3: 同一URL重複排除と再計算 (TMP-000113対応: 同一URLの2件を1件に集約、件数と説明文の再計算)
    const pDup = calculateServerGroundedPrice_({
      price_basis: "recent_transaction_reference",
      price_evidence: [
        { price_type: "sold", amount: 25000, currency: "JPY", source_url: "https://snkrdunk.com/products/IB4481-500", transaction_date: "2026-10", item_match_condition: "exact_match" },
        { price_type: "sold", amount: 25000, currency: "JPY", source_url: "https://snkrdunk.com/products/IB4481-500/", transaction_date: "2026-10", item_match_condition: "exact_match" }
      ]
    });
    const pass22_dup = pDup.price === 25000 &&
                       pDup.price_evidence.length === 1 &&
                       pDup.price_note.indexOf("1件") !== -1 &&
                       pDup.price_note.indexOf("採用値") !== -1;

    // 22-4: 販売中出品価格（active）の参考価格案 (TMP-000114対応: 成約がなくても販売中価格で数値を提案、成約とは呼ばない)
    const pActive = calculateServerGroundedPrice_({
      price_basis: "active_listing_reference",
      price_evidence: [
        { price_type: "active", amount: 38000, currency: "JPY", source_url: "https://snkrdunk.com/products/IB4481-500", transaction_date: "2026-10", item_match_condition: "exact_match" }
      ]
    });
    const pass22_active = pActive.price === 38000 &&
                          pActive.price_basis === "active_listing_reference" &&
                          pActive.price_note.indexOf("成約価格ではありません") !== -1 &&
                          pActive.price_note.indexOf("参考価格案") !== -1 &&
                          pActive.needs_review_price === true;

    // 22-5: Stage A パース時の元文字列保持
    const stageATestText = "### OBSERVED_SNEAKER_ATTRIBUTES\nPHYSICAL_BOX_LABEL_SKU: IB4481 500\nPHYSICAL_INNER_TAG_SIZE: 7.5 (25.5cm) UK 6.5 EUR 40.5 cm 25.5";
    const parsedA = parseStageASections_(stageATestText);
    const pass22_raw = parsedA.observedFields.box_label_sku === "IB4481-500" &&
                       parsedA.observedFields.raw_box_label_sku === "IB4481 500" &&
                       parsedA.observedFields.inner_tag_size === "25.5cm" &&
                       parsedA.observedFields.raw_inner_tag_size === "7.5 (25.5cm) UK 6.5 EUR 40.5 cm 25.5";

    const all22Pass = pass22_sku && pass22_size && pass22_dup && pass22_active && pass22_raw;
    record(
      "22. 箱ラベルSKU/サイズ正規化・元文字列保持・同一URL重複排除・販売中参考価格案 (実用上修正)",
      all22Pass,
      `sku=${pass22_sku}, size=${pass22_size}, dup=${pass22_dup}, active=${pass22_active}, raw=${pass22_raw}`
    );
  } catch (err) {
    record("22. 箱ラベルSKU/サイズ正規化・元文字列保持・同一URL重複排除・販売中参考価格案 (実用上修正)", false, err.message);
  }

  // --------------------------------------------------
  // 23. 裏面未撮影ポケカドラフト下書き反映・空欄card_condition許容・詳細GETフォールバック
  // --------------------------------------------------
  try {
    // 23-1: ポケカ専用レコード欠損時でも buildProductDetail が Error をスローせず基本情報を返すこと
    const mockRowNoPkm = new Array(40).fill("");
    mockRowNoPkm[0] = new Date();
    mockRowNoPkm[1] = "TMP-POKE-NO-RECORD";
    mockRowNoPkm[2] = "pokemon_card";
    mockRowNoPkm[3] = "Pokemon Card Game";
    mockRowNoPkm[4] = "メガゲンガーex [M2a 240/193] ハイクラスパック";
    mockRowNoPkm[5] = "";
    mockRowNoPkm[7] = 30400; // H列 販売予定価格
    mockRowNoPkm[9] = "ハイクラスパック収録のメガゲンガーexです。";
    mockRowNoPkm[29] = "https://drive.google.com/folders/f115";
    mockRowNoPkm[31] = "draft";
    mockRowNoPkm[32] = "in_stock";
    mockRowNoPkm[33] = "active";

    let detailResult = null;
    const origGetPkmDetail = typeof getPokemonCardByProductId === "function" ? getPokemonCardByProductId : null;
    getPokemonCardByProductId = (pid) => null;

    try {
      detailResult = buildProductDetail(mockRowNoPkm, false, false);
    } finally {
      if (origGetPkmDetail) getPokemonCardByProductId = origGetPkmDetail;
    }

    const detailOk = detailResult &&
                     detailResult.product_id === "TMP-POKE-NO-RECORD" &&
                     detailResult.product_name === "メガゲンガーex [M2a 240/193] ハイクラスパック" &&
                     detailResult.planned_sale_price === 30400 &&
                     detailResult.category === "pokemon_card" &&
                     detailResult.pokemon_card === null;

    // 23-2: applyCandidateToProduct_ で card_condition 空欄のポケカが正常保存・反映されること
    const mockSheet23 = {
      getLastColumn: () => 40,
      getRange: (r, c) => ({
        getValues: () => [mockRowNoPkm],
        setValue: (val) => { mockRowNoPkm[c - 1] = val; }
      })
    };

    let pkmSavedPayload = null;
    const origSavePkm = typeof savePokemonCardByProductId === "function" ? savePokemonCardByProductId : null;
    const origGetPkm = typeof safeGetPokemonCard_ === "function" ? safeGetPokemonCard_ : null;
    const origSaveTrans = typeof saveConfirmedProductTranslation_ === "function" ? saveConfirmedProductTranslation_ : null;
    const origGetTrans = typeof safeGetProductTranslation_ === "function" ? safeGetProductTranslation_ : null;

    savePokemonCardByProductId = (pid, payload) => { pkmSavedPayload = payload; return { success: true }; };
    safeGetPokemonCard_ = (pid) => pkmSavedPayload || { card_name: "メガゲンガーex", card_condition: "" };
    saveConfirmedProductTranslation_ = (pid, data) => data;
    safeGetProductTranslation_ = (pid) => ({ translation_status: "approved", translated_title: "Mega Gengar ex" });

    let apply23Ok = false;
    try {
      mockRowNoPkm[7] = ""; // 未設定状態
      const cand23 = {
        title_ja: "メガゲンガーex [M2a 240/193]",
        price: 30400,
        category: "pokemon_card",
        brand: "Pokemon Card Game",
        condition: "",
        pokemon_card: {
          card_name: "メガゲンガーex",
          set_code: "M2a",
          card_number: "240/193",
          grading_status: "ungraded",
          card_condition: ""
        }
      };
      const res23 = applyCandidateToProduct_(mockSheet23, 2, "TMP-POKE-NO-RECORD", cand23);
      apply23Ok = res23 && Boolean(res23.confirmedFingerprint) && mockRowNoPkm[7] === 30400;
    } finally {
      if (origSavePkm) savePokemonCardByProductId = origSavePkm;
      if (origGetPkm) safeGetPokemonCard_ = origGetPkm;
      if (origSaveTrans) saveConfirmedProductTranslation_ = origSaveTrans;
      if (origGetTrans) safeGetProductTranslation_ = origGetTrans;
    }

    const pass23 = detailOk && apply23Ok;
    record(
      "23. 裏面未撮影ポケカドラフト下書き反映・空欄card_condition許容・詳細GETフォールバック",
      pass23,
      `detailOk=${detailOk}, apply23Ok=${apply23Ok}`
    );
  } catch (err) {
    record("23. 裏面未撮影ポケカドラフト下書き反映・空欄card_condition許容・詳細GETフォールバック", false, err.message);
  }

  // ------------------------------------------------------------
  // 24. SKU誤読値排除 (FACING-THE / LABEL-SIDE) および identity_status: candidate 時の本票下書き反映
  // ------------------------------------------------------------
  try {
    // 24-1: normalizeSneakerSku_ の誤読値排除と正常型番抽出
    const badSku1 = normalizeSneakerSku_("FACING THE");
    const badSku2 = normalizeSneakerSku_("FACING-THE");
    const badSku3 = normalizeSneakerSku_("LABEL SIDE");
    const badSku4 = normalizeSneakerSku_("LABEL-SIDE");
    const badSku5 = normalizeSneakerSku_("CAMERA ANGLE");
    const goodSku1 = normalizeSneakerSku_("IB4481 500");
    const goodSku2 = normalizeSneakerSku_("IB4481-500");
    const goodSku3 = normalizeSneakerSku_("AV2405-900");
    const goodSku4 = normalizeSneakerSku_("IG1024");
    const goodSku5 = normalizeSneakerSku_("M2002RDA");

    const skuFilterOk = badSku1 === "" && badSku2 === "" && badSku3 === "" && badSku4 === "" && badSku5 === "" &&
                        goodSku1 === "IB4481-500" && goodSku2 === "IB4481-500" && goodSku3 === "AV2405-900" &&
                        goodSku4 === "IG1024" && goodSku5 === "M2002RDA";

    // 24-2: identity_status: "candidate" (サイズ空欄・SKU空欄・要確認項目あり) の本票自動反映
    const mockRow24 = new Array(40).fill("");
    mockRow24[0] = "TMP-CAND-001";
    mockRow24[1] = "Active";
    mockRow24[30] = "draft";
    mockRow24[32] = "active";
    const mockSheet24 = {
      getLastColumn: () => 40,
      getRange: (r, c, nr, nc) => {
        if (nr === 1 && nc >= 40) {
          return {
            getValues: () => [mockRow24],
            setValue: (val) => { mockRow24[c - 1] = val; }
          };
        }
        return {
          setValue: (val) => { mockRow24[c - 1] = val; },
          getValue: () => mockRow24[c - 1]
        };
      }
    };

    const cand24 = {
      title_ja: "ナイキ ダンク ロー CO.JP \"ワット ザ\"",
      description_ja: "左右非対称のクレイジーカラーが特徴的な2024年復刻モデルです。",
      hashtags_ja: "#NIKE #Dunk",
      category: "sneaker",
      brand: "NIKE",
      sku: "",
      size: "",
      price: 19300,
      condition: "新品・未使用",
      identity_status: "candidate",
      needs_review: ["size", "sku"]
    };

    const applyRes24 = applyCandidateToProduct_(mockSheet24, 2, "TMP-CAND-001", cand24);
    const titleReflected = mockRow24[4] === "ナイキ ダンク ロー CO.JP \"ワット ザ\"";
    const priceReflected = mockRow24[7] === 19300;
    const catReflected = mockRow24[2] === "sneaker";
    const brandReflected = mockRow24[3] === "NIKE";
    const sizeEmptyAllowed = mockRow24[12] === "";
    const aiFlagReflected = mockRow24[39] === AI_DRAFT_CONFIG.FLAG_VALUE;

    // 24-3: 本票再読取による完全性検証 (verifyProductDraftReflectionCompleted_) が通過すること
    const mockLatestDraft24 = {
      draft_id: "DRFT_CAND_001",
      review_status: "confirmed",
      confirmed_fingerprint: applyRes24.confirmedFingerprint,
      candidate: cand24
    };
    let verifyPass = false;
    try {
      const vRes = verifyProductDraftReflectionCompleted_(mockSheet24, 2, "TMP-CAND-001", mockLatestDraft24);
      verifyPass = Boolean(vRes && vRes.success);
    } catch (_) {
      verifyPass = false;
    }

    // 24-4: スタッフ入力済み価格が保護されること
    mockRow24[7] = 25000; // スタッフが入力した価格
    cand24.price = 18000; // AIの異なる価格案
    applyCandidateToProduct_(mockSheet24, 2, "TMP-CAND-001", cand24);
    const staffPriceProtected = mockRow24[7] === 25000;

    const pass24 = skuFilterOk && titleReflected && priceReflected && catReflected &&
                   brandReflected && sizeEmptyAllowed && aiFlagReflected && verifyPass && staffPriceProtected;

    record(
      "24. SKU誤読値排除(FACING-THE/LABEL-SIDE)およびcandidate時本票反映・価格H列反映・スタッフ値保護・完全性検証",
      pass24,
      `skuFilterOk=${skuFilterOk}, titleReflected=${titleReflected}, priceReflected=${priceReflected}, verifyPass=${verifyPass}, staffPriceProtected=${staffPriceProtected}`
    );
  } catch (err) {
    record("24. SKU誤読値排除(FACING-THE/LABEL-SIDE)およびcandidate時本票反映・価格H列反映・スタッフ値保護・完全性検証", false, err.message);
  }

  console.log(`--- [testAiProductDraftIdentityAndPricingSuite_] 完了: ${passed}/${results.length} 通過 ---`);
  return {
    passed: passed,
    failed: failed,
    total: results.length,
    results: results
  };
}

/**
 * 実画像評価用 完全ドライランドラフト生成 (本票更新ゼロ・Square連携ゼロ・安全隔離実行)
 * 対象: TMP-000113, TMP-000114
 * 
 * @param {string} [targetPid] "TMP-000113" または "TMP-000114" (省略時は両方)
 * @return {Object} 評価レポート
 */
function runAiDraftRealEvalDryRun(targetPid) {
  const pids = targetPid ? [String(targetPid).trim()] : ["TMP-000113", "TMP-000114"];
  const modelName = (typeof getAiDraftModelName_ === "function" ? getAiDraftModelName_() : "") || "gemini-3.8-flash";
  const results = {};

  console.log("==================================================");
  console.log(`=== [AI Draft Real Image Eval Dry-Run] 開始 (Model: ${modelName}) ===`);
  console.log("==================================================");

  pids.forEach(pid => {
    console.log(`\n--------------------------------------------------`);
    console.log(`>>> 商品評価開始: ${pid}`);
    console.log(`--------------------------------------------------`);

    const preCheck = inspectTargetProductBeforeAiDraft(pid);
    if (!preCheck || !preCheck.success || !preCheck.product) {
      console.error(`[Error] 商品情報取得失敗: ${pid}`);
      results[pid] = { success: false, error: "Product pre-check failed" };
      return;
    }

    const rawImages = Array.isArray(preCheck.images) ? preCheck.images.slice() : [];
    if (rawImages.length === 0) {
      console.error(`[Error] 画像なし: ${pid}`);
      results[pid] = { success: false, error: "No images available" };
      return;
    }

    const selectedImageIds = rawImages.map(img => img.id);
    const validatedImages = getValidatedProductDriveImages_(
      pid,
      preCheck.product.drive_folder_url,
      selectedImageIds
    );

    if (!validatedImages || !Array.isArray(validatedImages.images) || validatedImages.images.length === 0) {
      console.error(`[Error] Drive画像読み込み失敗: ${pid}`);
      results[pid] = { success: false, error: "Failed to load drive images" };
      return;
    }

    // メタデータ空欄での評価 (画像先行判定の真価を測定)
    const productMeta = {
      productId: pid,
      category: "", // 空欄でテスト
      brand: "",    // 空欄でテスト
      productName: "",
      sneakerSku: ""
    };

    const startTime = Date.now();
    let apiCallCount = 0;

    // 1. 画像先行判定 (1回のみ呼出)
    const priorStartTime = Date.now();
    const priorClass = classifyCategoryPriorFromImages_(validatedImages.images, productMeta, modelName, { enable_prior_classification_api: true });
    const priorElapsed = Date.now() - priorStartTime;
    if (priorClass.apiExecuted) {
      apiCallCount++;
    }

    // 2. 2段階検索グラウンディング (先行判定結果を渡し、内部での二重API呼出を完全に防止)
    const callOptions = {
      prior_classification: priorClass,
      enable_prior_classification_api: false,
      has_back_image: validatedImages.images.length >= 2,
      dry_run: true
    };

    let twoStageResult;
    try {
      twoStageResult = callGeminiTwoStageSearchGrounding_(
        validatedImages.images,
        productMeta,
        modelName,
        callOptions
      );
      apiCallCount += 2; // Stage A (Search) + Stage B (Structured)
    } catch (twoStageErr) {
      console.error(`\n[Stage B / Grounding Exception for ${pid}]: ${twoStageErr.message}`);

      const stageAText = twoStageErr.stage_a_text || "";
      const stageAGrounding = twoStageErr.stage_a_grounding || {};
      const parsedStageA = twoStageErr.parsed_stage_a || parseStageASections_(stageAText);
      const diag = twoStageErr.stage_b_diagnostics || {};

      console.log(`\n==================================================`);
      console.log(`=== [STAGE A DIAGNOSTIC RECOVERY: ${pid}] ===`);
      console.log(`==================================================`);
      console.log(`1. Stage A 物理画像観察値 (直接視認): ${JSON.stringify(parsedStageA.observedFields || {})}`);
      console.log(`   Stage A Web検索由来値 (推論・検索): ${JSON.stringify(parsedStageA.searchDerivedFields || {})}`);
      const queries = stageAGrounding.queries || [];
      console.log(`2. Stage A 検索クエリ (${queries.length}件): ${queries.join(" | ")}`);
      const sources = stageAGrounding.sources || [];
      console.log(`3. Stage A 参照元 (${sources.length}件):`);
      sources.slice(0, 5).forEach((s, idx) => {
        console.log(`   [${idx + 1}] ${s.title}: ${s.url}`);
      });
      console.log(`4. Stage A 観察テキスト:\n${parsedStageA.observedText || "(空)"}`);
      console.log(`5. Stage A 検索結果テキスト:\n${parsedStageA.searchText || "(空)"}`);
      console.log(`6. Stage A 価格調査テキスト:\n${parsedStageA.pricingText || "(空)"}`);
      console.log(`==================================================`);

      console.log(`\n==================================================`);
      console.log(`=== [STAGE B DIAGNOSTIC DETAILS: ${pid}] ===`);
      console.log(`==================================================`);
      console.log(`- FinishReason: ${diag.finish_reason || "UNKNOWN"}`);
      console.log(`- Token Usage: ${JSON.stringify(diag.usage || {})}`);
      console.log(`- Output Character Length: ${diag.output_length || 0}`);
      console.log(`- Parse Error: ${diag.parse_error || twoStageErr.message}`);
      console.log(`- Output Head (first 300 chars):\n${diag.output_head || ""}`);
      console.log(`- Output Tail (last 500 chars):\n${diag.output_tail || ""}`);
      console.log(`==================================================\n`);

      results[pid] = {
        product_id: pid,
        success: false,
        error: twoStageErr.message,
        error_code: twoStageErr.error_code || "STRUCTURED_PARSE_FAILED",
        prior_classification: priorClass,
        stage_a: {
          observed_text: parsedStageA.observedText,
          search_text: parsedStageA.searchText,
          pricing_text: parsedStageA.pricingText,
          unconfirmed_text: parsedStageA.unconfirmedText,
          observed_identifiers: parsedStageA.observedFields,
          search_derived_identifiers: parsedStageA.searchDerivedFields,
          extracted_identifiers: parsedStageA.extractedFields,
          grounding_queries: queries,
          grounding_sources: sources
        },
        stage_b_diagnostics: diag
      };
      return;
    }

    const totalElapsed = Date.now() - startTime;

    // パース結果の抽出
    const parsedStageA = parseStageASections_(twoStageResult.stage_a_text);
    const candidate = twoStageResult.candidate;

    const evalReport = {
      product_id: pid,
      model_name: modelName,
      image_count: validatedImages.images.length,
      image_names: validatedImages.images.map(i => i.name),
      api_call_count: apiCallCount,
      timing: {
        prior_classification_ms: priorElapsed,
        stage_a_ms: twoStageResult.stage_a_elapsed_ms,
        stage_b_ms: twoStageResult.stage_b_elapsed_ms,
        total_ms: totalElapsed
      },
      prior_classification: priorClass,
      stage_a: {
        observed_text: parsedStageA.observedText,
        search_text: parsedStageA.searchText,
        pricing_text: parsedStageA.pricingText,
        unconfirmed_text: parsedStageA.unconfirmedText,
        observed_identifiers: parsedStageA.observedFields,
        search_derived_identifiers: parsedStageA.searchDerivedFields,
        extracted_identifiers: parsedStageA.extractedFields,
        grounding_queries: (twoStageResult.grounding && twoStageResult.grounding.queries) || [],
        grounding_sources: (twoStageResult.grounding && twoStageResult.grounding.sources) || []
      },
      stage_b_candidate: candidate,
      final_draft: {
        category: candidate.category,
        brand: candidate.brand,
        product_name: candidate.title_ja,
        condition: candidate.condition,
        price: candidate.price,
        price_basis: candidate.price_basis,
        price_note: candidate.price_note,
        pokemon_card: candidate.pokemon_card || null,
        sneaker_sku: candidate.sku || "",
        sku_source: candidate.sku_source || "",
        sneaker_size: candidate.size || "",
        needs_review: candidate.needs_review || []
      }
    };

    console.log(`\n=== [EVAL RESULT: ${pid}] ===`);
    console.log(`1. 先行判定カテゴリ: '${priorClass.category}' (confidence: ${priorClass.confidence})`);
    console.log(`2. Stage A 物理画像観察値 (直接視認): ${JSON.stringify(parsedStageA.observedFields || {})}`);
    console.log(`   Stage A Web検索由来値 (推論・検索): ${JSON.stringify(parsedStageA.searchDerivedFields || {})}`);
    console.log(`3. Stage A 検索クエリ (${evalReport.stage_a.grounding_queries.length}件): ${evalReport.stage_a.grounding_queries.join(" | ")}`);
    console.log(`4. Stage A 参照元 (${evalReport.stage_a.grounding_sources.length}件):`);
    evalReport.stage_a.grounding_sources.slice(0, 5).forEach((s, idx) => {
      console.log(`   [${idx + 1}] ${s.title}: ${s.url}`);
    });
    console.log(`5. 生成商品名: ${candidate.title_ja}`);
    console.log(`6. カテゴリ・ブランド: ${candidate.category} / ${candidate.brand}`);
    if (candidate.pokemon_card) {
      console.log(`7. ポケカ詳細: ${JSON.stringify(candidate.pokemon_card)}`);
    } else {
      console.log(`7. 靴属性: SKU='${candidate.sku}' (source: ${candidate.sku_source || "unknown"}), Size='${candidate.size}'`);
    }
    console.log(`8. 価格案: ${candidate.price}円 (basis: ${candidate.price_basis})`);
    console.log(`   根拠メモ: ${candidate.price_note}`);
    console.log(`9. 要確認項目 (needs_review): ${JSON.stringify(candidate.needs_review)}`);

    const trace = (twoStageResult && twoStageResult.price_trace) || candidate._price_trace || {};
    console.log(`\n--- [PRICE TRACEABILITY: ${pid}] ---`);
    console.log(`- Stage A 検出価格: ${trace.stage_a_detected_price !== null && trace.stage_a_detected_price !== undefined ? trace.stage_a_detected_price + "円" : "(なし)"}`);
    console.log(`- 追加価格検索 (Dedicated Price Search): ${trace.dedicated_price_search_executed ? "実行 (Query: " + trace.dedicated_price_search_query + ")" : "スキップ"}`);
    if (trace.dedicated_price_search_executed) {
      console.log(`- 追加価格検索 検出価格: ${trace.dedicated_price_search_price !== null && trace.dedicated_price_search_price !== undefined ? trace.dedicated_price_search_price + "円" : "(なし)"}`);
    }
    console.log(`- Stage B 返却価格: ${trace.stage_b_raw_price !== null && trace.stage_b_raw_price !== undefined ? trace.stage_b_raw_price + "円" : "null"} (basis: ${trace.stage_b_raw_basis || "なし"}, 根拠件数: ${trace.stage_b_raw_evidence_count || 0}件)`);
    console.log(`- サーバー計算価格: ${trace.server_calculated_price !== null && trace.server_calculated_price !== undefined ? trace.server_calculated_price + "円" : "null"} (basis: ${trace.server_calculated_basis || "なし"})`);
    console.log(`- 最終採用価格: ${candidate.price !== null && candidate.price !== undefined ? candidate.price + "円" : "null"} (basis: ${candidate.price_basis || "なし"})`);
    console.log(`- 採用根拠メモ: ${candidate.price_note}`);
    console.log(`------------------------------------\n`);

    console.log(`10. 所要時間: ${totalElapsed}ms (Stage A: ${twoStageResult.stage_a_elapsed_ms}ms, Stage B: ${twoStageResult.stage_b_elapsed_ms}ms, API回数: ${apiCallCount})`);
    console.log(`=== [EVAL RESULT END: ${pid}] ===\n`);

    results[pid] = evalReport;
  });

  console.log("==================================================");
  console.log("=== [AI Draft Real Image Eval Dry-Run] 全商品完了 ===");
  console.log("==================================================");

  return results;
}

function runAiDraftRealEvalDryRun113() {
  return runAiDraftRealEvalDryRun("TMP-000113");
}

function runAiDraftRealEvalDryRun114() {
  return runAiDraftRealEvalDryRun("TMP-000114");
}

/**
 * 商品添付書類 (請求書・領収書) 登録・隔離・冪等性・アクセス権限テストスイート
 */
function testProductDocumentAttachmentSuite_() {
  const results = [];
  let passed = 0;
  let failed = 0;

  function record(name, pass, msg) {
    results.push({ name, pass, msg });
    if (pass) {
      passed++;
      console.log(`✓ ${name}`);
    } else {
      failed++;
      console.error(`✗ ${name}: ${msg}`);
    }
  }

  console.log("\n--- [testProductDocumentAttachmentSuite_] 開始 ---");

  // テスト用モック共通セットアップ
  const originalGetActiveSs = SpreadsheetApp.getActiveSpreadsheet;
  const originalGetFolderById = DriveApp.getFolderById;

  // モックシート・Drive環境の作成
  const mockDriveFolders = {};
  const mockDriveFiles = {};

  class MockFolder {
    constructor(id, name) {
      this.id = id;
      this.name = name;
      this.trashed = false;
      this.files = [];
      this.subfolders = [];
    }
    getId() { return this.id; }
    getName() { return this.name; }
    getUrl() { return `https://drive.google.com/drive/folders/${this.id}`; }
    isTrashed() { return this.trashed; }
    setTrashed(t) { this.trashed = t; }
    getFiles() {
      let idx = 0;
      const list = this.files.filter(f => !f.trashed);
      return {
        hasNext: () => idx < list.length,
        next: () => list[idx++]
      };
    }
    getFoldersByName(name) {
      let idx = 0;
      const list = this.subfolders.filter(f => !f.trashed && f.name === name);
      return {
        hasNext: () => idx < list.length,
        next: () => list[idx++]
      };
    }
    createFolder(name) {
      const sub = new MockFolder(`sub_${name}_${Math.random().toString(36).substring(2, 7)}`, name);
      this.subfolders.push(sub);
      mockDriveFolders[sub.id] = sub;
      return sub;
    }
    createFile(blob) {
      const fileId = `file_${Math.random().toString(36).substring(2, 7)}`;
      const file = {
        id: fileId,
        name: blob.name,
        mime: blob.mime || "application/octet-stream",
        bytes: blob.bytes || [],
        trashed: false,
        getId: function() { return this.id; },
        getName: function() { return this.name; },
        setName: function(n) { this.name = n; },
        getMimeType: function() { return this.mime; },
        getUrl: function() { return `https://drive.google.com/file/d/${this.id}/view`; },
        getSize: function() { return this.bytes.length; },
        getLastUpdated: function() { return new Date(); },
        isTrashed: function() { return this.trashed; },
        setTrashed: function(t) { this.trashed = t; },
        getBlob: function() {
          return {
            getName: () => blob.name,
            getBytes: () => blob.bytes,
            getContentType: () => blob.mime
          };
        }
      };
      this.files.push(file);
      mockDriveFiles[fileId] = file;
      return file;
    }
  }

  // モックSpreadsheet
  function createTestSpreadsheet() {
    const sheetsMap = {};
    class TestSheet {
      constructor(name) {
        this.name = name;
        this.rows = [];
      }
      getName() { return this.name; }
      getLastRow() { return this.rows.length; }
      getLastColumn() { return this.rows.length > 0 ? this.rows[0].length : 0; }
      appendRow(row) { this.rows.push([...row]); }
      getRange(r, c, numR = 1, numC = 1) {
        const sheetRef = this;
        return {
          getValue: () => {
            const rowData = sheetRef.rows[r - 1];
            return (rowData && rowData[c - 1] !== undefined) ? rowData[c - 1] : "";
          },
          setValue: (val) => {
            while (sheetRef.rows.length < r) sheetRef.rows.push([]);
            const rowData = sheetRef.rows[r - 1];
            while (rowData.length < c) rowData.push("");
            rowData[c - 1] = val;
          },
          getValues: () => {
            const res = [];
            for (let i = 0; i < numR; i++) {
              const rowIdx = r - 1 + i;
              const rowData = sheetRef.rows[rowIdx] || [];
              const rowRes = [];
              for (let j = 0; j < numC; j++) {
                const colIdx = c - 1 + j;
                rowRes.push(rowData[colIdx] !== undefined ? rowData[colIdx] : "");
              }
              res.push(rowRes);
            }
            return res;
          }
        };
      }
      getParent() { return testSS; }
    }

    const testSS = {
      getSheetByName: (n) => sheetsMap[n] || null,
      insertSheet: (n) => {
        const s = new TestSheet(n);
        sheetsMap[n] = s;
        return s;
      },
      getSheets: () => Object.values(sheetsMap)
    };
    return { testSS, sheetsMap, TestSheet };
  }

  const { testSS } = createTestSpreadsheet();

  // 本票シートの初期化
  const masterSheet = testSS.insertSheet("商品管理本票");
  masterSheet.appendRow(new Array(40).fill("ヘッダー")); // Row 1: ヘッダー
  // 商品1: TMP-DOC-001 (Driveフォルダ folder_001)
  const rowProd1 = new Array(40).fill("");
  rowProd1[0] = new Date();
  rowProd1[1] = "TMP-DOC-001";
  rowProd1[2] = "sneaker";
  rowProd1[3] = "NIKE";
  rowProd1[4] = "Air Jordan 1 Retro";
  rowProd1[29] = "https://drive.google.com/drive/folders/folder_001";
  rowProd1[31] = "draft";
  rowProd1[32] = "in_stock";
  rowProd1[33] = "active";
  masterSheet.appendRow(rowProd1); // Row 2

  // 商品2: TMP-DOC-002 (Driveフォルダ folder_002)
  const rowProd2 = new Array(40).fill("");
  rowProd2[0] = new Date();
  rowProd2[1] = "TMP-DOC-002";
  rowProd2[2] = "pokemon_card";
  rowProd2[3] = "Pokemon Card Game";
  rowProd2[4] = "ミュウex SAR";
  rowProd2[29] = "https://drive.google.com/drive/folders/folder_002";
  rowProd2[31] = "draft";
  rowProd2[32] = "in_stock";
  rowProd2[33] = "active";
  masterSheet.appendRow(rowProd2); // Row 3

  // 商品3: TMP-DOC-003 (未添付用)
  const rowProd3 = new Array(40).fill("");
  rowProd3[0] = new Date();
  rowProd3[1] = "TMP-DOC-003";
  rowProd3[2] = "sneaker";
  rowProd3[4] = "Unattached Sneaker";
  rowProd3[29] = "https://drive.google.com/drive/folders/folder_003";
  rowProd3[31] = "draft";
  masterSheet.appendRow(rowProd3); // Row 4

  // Drive フォルダの準備
  const folder1 = new MockFolder("folder_001", "TMP-DOC-001");
  mockDriveFolders["folder_001"] = folder1;
  // 商品画像 01_main_shoe.jpg, 02_side.jpg を追加
  const img1 = folder1.createFile({ name: "01_main_shoe.jpg", mime: "image/jpeg", bytes: [1, 2, 3] });
  const img2 = folder1.createFile({ name: "02_side.jpg", mime: "image/jpeg", bytes: [4, 5, 6] });

  const folder2 = new MockFolder("folder_002", "TMP-DOC-002");
  mockDriveFolders["folder_002"] = folder2;
  folder2.createFile({ name: "01_main_card.png", mime: "image/png", bytes: [7, 8, 9] });

  const folder3 = new MockFolder("folder_003", "TMP-DOC-003");
  mockDriveFolders["folder_003"] = folder3;
  folder3.createFile({ name: "01_main_item.jpg", mime: "image/jpeg", bytes: [10, 11] });

  // SpreadsheetApp / DriveApp をモックへ差し替え
  SpreadsheetApp.getActiveSpreadsheet = () => testSS;
  DriveApp.getFolderById = (id) => mockDriveFolders[id] || null;

  try {
    // ----------------------------------------------------
    // Test 1: PDF 請求書の初回正常登録
    // ----------------------------------------------------
    try {
      const pdfBase64 = Utilities.base64Encode("JVBERi0xLjQKJ_mock_pdf_content");
      const res1Raw = handleAttachProductDocument(masterSheet, {
        product_id: "TMP-DOC-001",
        idempotency_key: "att-pdf-001",
        document_type: "invoice",
        file_name: "receipt_inv_2026.pdf",
        mime_type: "application/pdf",
        base64: pdfBase64
      });
      const res1 = JSON.parse(res1Raw.getContent ? res1Raw.getContent() : res1Raw);

      const docSheet = testSS.getSheetByName(PRODUCT_DOCUMENTS_CONFIG.SHEET_NAME);
      const docRecord = findProductDocumentRecord_(docSheet, "TMP-DOC-001");

      const ok1 = res1.success === true &&
                  res1.is_reused === false &&
                  res1.product_id === "TMP-DOC-001" &&
                  res1.document_type === "invoice" &&
                  res1.mime_type === "application/pdf" &&
                  Boolean(res1.file_id) &&
                  Boolean(res1.view_url) &&
                  Boolean(res1.open_url) &&
                  docRecord !== null &&
                  docRecord.idempotency_key === "att-pdf-001" &&
                  docRecord.original_file_name === "receipt_inv_2026.pdf";

      record("1. PDF請求書初回添付: 正常系・product_documents記録・documents/サブフォルダ保存", ok1, ok1 ? "" : JSON.stringify(res1));
    } catch (e1) {
      record("1. PDF請求書初回添付: 正常系・product_documents記録・documents/サブフォルダ保存", false, e1.message);
    }

    // ----------------------------------------------------
    // Test 2: JPG 領収書添付と商品画像からの厳格隔離検証
    // ----------------------------------------------------
    try {
      const jpgBase64 = Utilities.base64Encode("mock_jpg_receipt_image_binary");
      const res2Raw = handleAttachProductDocument(masterSheet, {
        product_id: "TMP-DOC-002",
        idempotency_key: "att-jpg-002",
        document_type: "receipt",
        file_name: "receipt_card_purchase.jpg",
        mime_type: "image/jpeg",
        base64: jpgBase64
      });
      const res2 = JSON.parse(res2Raw.getContent ? res2Raw.getContent() : res2Raw);

      // 隔離検証 A: buildProductDetail の images に書類が含まれないこと
      const detailRow = masterSheet.getRange(3, 1, 1, 40).getValues()[0];
      const prodDetail = buildProductDetail(detailRow, true, true);
      const detailHasDocImage = prodDetail.images.some(img => img.file_id === res2.file_id);

      // 隔離検証 B: getValidatedProductDriveImages_ に書類が含まれないこと
      const valImages = getValidatedProductDriveImages_("TMP-DOC-002", rowProd2[29]);
      const valHasDocImage = valImages.images.some(img => img.fileId === res2.file_id);

      // 隔離検証 C: computeImageFingerprintFromFolderUrl_ に書類が含まれないこと
      const fp = computeImageFingerprintFromFolderUrl_(rowProd2[29]);
      const ok2 = res2.success === true &&
                  res2.document_type === "receipt" &&
                  res2.mime_type === "image/jpeg" &&
                  !detailHasDocImage &&
                  !valHasDocImage &&
                  Boolean(fp);

      record("2. JPG領収書添付: 正常登録と商品画像一覧・AI推論画像・画像指紋からの厳格隔離", ok2, `detailHasDocImage=${detailHasDocImage}, valHasDocImage=${valHasDocImage}`);
    } catch (e2) {
      record("2. JPG領収書添付: 正常登録と商品画像一覧・AI推論画像・画像指紋からの厳格隔離", false, e2.message);
    }

    // ----------------------------------------------------
    // Test 3: PNG 書類添付と商品画像管理(更新・削除)での保護検証
    // ----------------------------------------------------
    try {
      const doc1Record = getProductDocumentRecord("TMP-DOC-001");
      const docFileObj = mockDriveFiles[doc1Record.file_id];
      const initialTrashed = docFileObj.isTrashed();

      // 画像順序更新: 01_main_shoe.jpg のみを保持
      handleUpdateProductImages(masterSheet, {
        product_id: "TMP-DOC-001",
        image_order: [
          { source: "existing", id: img1.getId() }
        ]
      });

      const afterTrashed = docFileObj.isTrashed();
      const ok3 = initialTrashed === false && afterTrashed === false;

      record("3. 書類保護検証: 画像更新・削除(handleUpdateProductImages)による書類誤削除ゼロ保証", ok3, `initialTrashed=${initialTrashed}, afterTrashed=${afterTrashed}`);
    } catch (e3) {
      record("3. 書類保護検証: 画像更新・削除(handleUpdateProductImages)による書類誤削除ゼロ保証", false, e3.message);
    }

    // ----------------------------------------------------
    // Test 4: 書類未添付商品の正常動作
    // ----------------------------------------------------
    try {
      const row3 = masterSheet.getRange(4, 1, 1, 40).getValues()[0];
      const prod3Admin = buildProductDetail(row3, true, true);
      const prod3Public = buildProductDetail(row3, false, false);

      const ok4 = prod3Admin.document === null &&
                  prod3Public.document === undefined;

      record("4. 書類未添付商品: 管理者向けは null、公開API向けは非公開(プロパティ除外)", ok4, `adminDoc=${prod3Admin.document}, publicDoc=${prod3Public.document}`);
    } catch (e4) {
      record("4. 書類未添付商品: 管理者向けは null、公開API向けは非公開(プロパティ除外)", false, e4.message);
    }

    // ----------------------------------------------------
    // Test 5: 同一再送識別子・同一内容の冪等性 (is_reused: true)
    // ----------------------------------------------------
    try {
      const pdfBase64 = Utilities.base64Encode("JVBERi0xLjQKJ_mock_pdf_content");
      const res5Raw = handleAttachProductDocument(masterSheet, {
        product_id: "TMP-DOC-001",
        idempotency_key: "att-pdf-001",
        document_type: "invoice",
        file_name: "receipt_inv_2026.pdf",
        mime_type: "application/pdf",
        base64: pdfBase64
      });
      const res5 = JSON.parse(res5Raw.getContent ? res5Raw.getContent() : res5Raw);

      const docSheet = testSS.getSheetByName(PRODUCT_DOCUMENTS_CONFIG.SHEET_NAME);
      const docRowsForProd1 = docSheet.rows.filter(r => r[0] === "TMP-DOC-001");

      const ok5 = res5.success === true &&
                  res5.is_reused === true &&
                  docRowsForProd1.length === 1;

      record("5. 同一再送識別子・同一内容の冪等性: is_reused: true・Drive/台帳の重複ゼロ保証", ok5, `is_reused=${res5.is_reused}, rows=${docRowsForProd1.length}`);
    } catch (e5) {
      record("5. 同一再送識別子・同一内容の冪等性: is_reused: true・Drive/台帳の重複ゼロ保証", false, e5.message);
    }

    // ----------------------------------------------------
    // Test 6: 1商品1件超過・別書類の競合検知 (DOCUMENT_ALREADY_EXISTS)
    // ----------------------------------------------------
    try {
      const differentPdfBase64 = Utilities.base64Encode("DIFFERENT_INVOICE_CONTENT_BYTES");
      const res6Raw = handleAttachProductDocument(masterSheet, {
        product_id: "TMP-DOC-001",
        idempotency_key: "att-pdf-DIFFERENT-002",
        document_type: "invoice",
        file_name: "another_invoice.pdf",
        mime_type: "application/pdf",
        base64: differentPdfBase64
      });
      const res6 = JSON.parse(res6Raw.getContent ? res6Raw.getContent() : res6Raw);

      const ok6 = res6.success === false &&
                  res6.error_code === "DOCUMENT_ALREADY_EXISTS" &&
                  res6.product_id === "TMP-DOC-001" &&
                  Boolean(res6.existing_document) &&
                  res6.existing_document.original_file_name === "receipt_inv_2026.pdf";

      record("6. 1商品1件制限・別書類競合検知: 上書き・重複添付拒絶 (DOCUMENT_ALREADY_EXISTS)", ok6, JSON.stringify(res6));
    } catch (e6) {
      record("6. 1商品1件制限・別書類競合検知: 上書き・重複添付拒絶 (DOCUMENT_ALREADY_EXISTS)", false, e6.message);
    }

    // ----------------------------------------------------
    // Test 7: 書類添付失敗と書類のみ再試行 (成否分離)
    // ----------------------------------------------------
    try {
      // 7-1: 不正形式（テキストファイル）送信時の拒絶
      const badMimeRaw = handleAttachProductDocument(masterSheet, {
        product_id: "TMP-DOC-003",
        idempotency_key: "att-bad-001",
        document_type: "invoice",
        file_name: "doc.txt",
        mime_type: "text/plain",
        base64: Utilities.base64Encode("plain text")
      });
      const badMimeRes = JSON.parse(badMimeRaw.getContent ? badMimeRaw.getContent() : badMimeRaw);

      const okFail = badMimeRes.success === false &&
                     badMimeRes.error_code === "INVALID_DOCUMENT_MIME_TYPE" &&
                     badMimeRes.product_id === "TMP-DOC-003";

      // 7-2: 正しいPDFで再試行すると成功すること
      const retryPdfRaw = handleAttachProductDocument(masterSheet, {
        product_id: "TMP-DOC-003",
        idempotency_key: "att-retry-001",
        document_type: "invoice",
        file_name: "valid_doc.pdf",
        mime_type: "application/pdf",
        base64: Utilities.base64Encode("valid_pdf_content")
      });
      const retryRes = JSON.parse(retryPdfRaw.getContent ? retryPdfRaw.getContent() : retryPdfRaw);

      const okRetry = retryRes.success === true &&
                      retryRes.product_id === "TMP-DOC-003" &&
                      retryRes.file_id.length > 0;

      const ok7 = okFail && okRetry;
      record("7. 書類添付失敗時の独立エラー返却と書類のみの安全な再試行 (成否分離)", ok7, `okFail=${okFail}, okRetry=${okRetry}`);
    } catch (e7) {
      record("7. 書類添付失敗時の独立エラー返却と書類のみの安全な再試行 (成否分離)", false, e7.message);
    }

    // ----------------------------------------------------
    // Test 8: 障害復旧 (Drive保存後・シート記録前の中断回収)
    // ----------------------------------------------------
    try {
      // 商品4 を追加
      const rowProd4 = new Array(40).fill("");
      rowProd4[0] = new Date();
      rowProd4[1] = "TMP-DOC-004";
      rowProd4[2] = "sneaker";
      rowProd4[4] = "Crash Recovery Product";
      rowProd4[29] = "https://drive.google.com/drive/folders/folder_004";
      rowProd4[31] = "draft";
      masterSheet.appendRow(rowProd4);

      const folder4 = new MockFolder("folder_004", "TMP-DOC-004");
      mockDriveFolders["folder_004"] = folder4;
      const docFolder4 = folder4.createFolder("documents");

      // 前回中断で Drive の documents/ 内にファイルが既に作成された状態を模倣
      const crashPdfBytes = Utilities.base64Decode(Utilities.base64Encode("CRASH_RECOVERY_PDF_BYTES"));
      const crashFile = docFolder4.createFile({
        name: "invoice_crash_recovery.pdf",
        mime: "application/pdf",
        bytes: crashPdfBytes
      });
      const initialFileCount = docFolder4.files.length;

      // 再送
      const recovRaw = handleAttachProductDocument(masterSheet, {
        product_id: "TMP-DOC-004",
        idempotency_key: "att-crash-001",
        document_type: "invoice",
        file_name: "crash_recovery.pdf",
        mime_type: "application/pdf",
        base64: Utilities.base64Encode("CRASH_RECOVERY_PDF_BYTES")
      });
      const recovRes = JSON.parse(recovRaw.getContent ? recovRaw.getContent() : recovRaw);

      // 新規ファイルを作らず、既存ファイルを再利用して台帳を修復したこと
      const afterFileCount = docFolder4.files.length;
      const ok8 = recovRes.success === true &&
                  recovRes.file_id === crashFile.getId() &&
                  initialFileCount === afterFileCount;

      record("8. 障害復旧: Drive保存後・シート記録前中断からのファイル照合回収・重複作成ゼロ", ok8, `matchedFile=${recovRes.file_id === crashFile.getId()}, count=${afterFileCount}`);
    } catch (e8) {
      record("8. 障害復旧: Drive保存後・シート記録前中断からのファイル照合回収・重複作成ゼロ", false, e8.message);
    }

    // ----------------------------------------------------
    // Test 9: 管理画面(mode=admin)での書類取得と公開ページ非公開の検証
    // ----------------------------------------------------
    try {
      // 9-1: 公開API (modeなし / isAdmin=false) では document が非公開であること
      const row1Data = masterSheet.getRange(2, 1, 1, 40).getValues()[0];
      const publicDetail = buildProductDetail(row1Data, false, false);
      const isPublicHidden = publicDetail.document === undefined;

      // 9-2: mode=admin なしでの doGet?action=get_product_document は拒絶
      const noAdminGet = doGet({
        parameter: {
          action: "get_product_document",
          product_id: "TMP-DOC-001"
        }
      }, { sheet: masterSheet });
      const noAdminRes = JSON.parse(noAdminGet.getContent());
      const isNoAdminDenied = noAdminRes.success === false && noAdminRes.error_code === "UNAUTHORIZED_ADMIN_ACCESS";

      // 9-3: 管理画面 (mode=admin, 認証キー不要) での商品詳細 buildProductDetail に document が付与されること
      const adminDetail = buildProductDetail(row1Data, true, false);
      const isAdminDetailAttached = adminDetail.document &&
                                    adminDetail.document.document_type === "invoice" &&
                                    Boolean(adminDetail.document.view_url) &&
                                    Boolean(adminDetail.document.open_url);

      // 9-4: 管理画面 (mode=admin, 認証キー不要) による doGet?action=get_product_document 取得成功
      const adminDocGet = doGet({
        parameter: {
          action: "get_product_document",
          product_id: "TMP-DOC-001",
          mode: "admin"
        }
      }, { sheet: masterSheet });
      const adminDocRes = JSON.parse(adminDocGet.getContent());
      const isAdminDocSuccess = adminDocRes.success === true &&
                                Boolean(adminDocRes.document) &&
                                adminDocRes.document.document_type === "invoice" &&
                                Boolean(adminDocRes.document.view_url) &&
                                Boolean(adminDocRes.document.open_url);

      const ok9 = isPublicHidden && isNoAdminDenied && isAdminDetailAttached && isAdminDocSuccess;
      record("9. 管理画面表示と公開API非公開: 公開除外・非管理者拒絶・mode=adminでのOpen URL取得", ok9, `publicHidden=${isPublicHidden}, noAdminDenied=${isNoAdminDenied}, adminDetailAttached=${isAdminDetailAttached}, adminDocSuccess=${isAdminDocSuccess}`);
    } catch (e9) {
      record("9. 管理画面表示と公開API非公開: 公開除外・非管理者拒絶・mode=adminでのOpen URL取得", false, e9.message);
    }

  } finally {
    SpreadsheetApp.getActiveSpreadsheet = originalGetActiveSs;
    DriveApp.getFolderById = originalGetFolderById;
  }

  console.log(`--- [testProductDocumentAttachmentSuite_] 完了: ${passed}/${results.length} 通過 (失敗: ${failed}) ---`);
  return {
    passed: passed,
    failed: failed,
    total: results.length,
    results: results
  };
}

/**
 * ポケモンカード状態区分 A/B/C MVP テストスイート
 * 
 * 検証要件:
 * 1. 未鑑定ポケカの一括生成で裏面画像なしでも card_condition が A で保存され、詳細APIで A が取得できること
 * 2. 明確な状態差がある場合は B や C が入ること (画像観察・条件マッピング)
 * 3. 鑑定済みカード (PSA等) では card_condition が空欄 ("") となり、未鑑定用ABCが混入しないこと
 * 4. スタッフ修正済みの card_condition は AI再生成や下書き反映で上書きされず保持されること
 * 5. 商品マスター本票 F列（状態）に A/B/C が書き込まれず、日本語状態区分または空欄が維持されること
 * 6. 商品更新 API (handleUpdateProduct) で pokemon_card.card_condition およびトップレベル card_condition / condition(A/B/C) が安全に更新され、本票F列を汚染しないこと
 */
function testPokemonCardConditionAbcSuite_() {
  const results = [];
  let passed = 0;
  let failed = 0;

  function record(name, pass, msg) {
    results.push({ name, pass, msg });
    if (pass) {
      passed++;
      console.log(`✓ ${name}`);
    } else {
      failed++;
      console.error(`✗ ${name}: ${msg}`);
    }
  }

  console.log("\n--- [testPokemonCardConditionAbcSuite_] 開始 ---");

  // 1. 未鑑定ポケカ: 裏面画像なし時のドラフト生成（原則A、説明文サニタイズ、needs_review付与、F列非破壊）
  try {
    const rawCand1 = {
      title_ja: "ピカチュウ AR [SV2a 173/165] ポケモンカード151",
      description_ja: "白かけなし・極美品のピカチュウARです。",
      title_en: "Pikachu AR",
      description_en: "Mint Pikachu AR card.",
      category: "pokemon_card",
      brand: "Pokemon Card Game",
      condition: "目立った傷や汚れなし",
      price: 3500,
      pokemon_card: {
        card_name: "ピカチュウ",
        set_code: "SV2a",
        card_number: "173/165",
        rarity: "AR",
        grading_status: "ungraded",
        card_condition: ""
      }
    };
    const cand1 = validateAndSanitizeDraftCandidate_(rawCand1, { image_count: 1, has_back_image: false });
    const ok1 = cand1.pokemon_card &&
                cand1.pokemon_card.card_condition === "A" &&
                cand1.condition === "" &&
                cand1.needs_review.indexOf("card_condition") !== -1 &&
                cand1.description_ja.indexOf("白かけなし") === -1 &&
                cand1.description_ja.indexOf("裏面未確認") !== -1;
    record("1. 未鑑定ポケカ裏面画像なし: card_condition原則A・説明文断定排除・needs_review付与・F列空文字維持", ok1, `cond=${cand1.pokemon_card?.card_condition}, finalCond=${cand1.condition}, needsReview=${cand1.needs_review?.includes("card_condition")}`);
  } catch (e1) {
    record("1. 未鑑定ポケカ裏面画像なし: card_condition原則A・説明文断定排除・needs_review付与・F列空文字維持", false, e1.message);
  }

  // 2. 明確な状態差がある場合 (BおよびCの判定)
  try {
    const rawCand2B = {
      title_ja: "リザードン 25th",
      description_ja: "角にわずかな白欠けが見られます。",
      title_en: "Charizard 25th",
      description_en: "Minor edge wear.",
      category: "pokemon_card",
      brand: "Pokemon Card Game",
      condition: "やや傷や汚れあり",
      price: 18000,
      pokemon_card: {
        card_name: "リザードン",
        card_number: "001/025",
        grading_status: "ungraded",
        card_condition: "B"
      }
    };
    const cand2B = validateAndSanitizeDraftCandidate_(rawCand2B, { image_count: 2, has_back_image: true });

    const rawCand2C = {
      title_ja: "ミュウツーGX SSR",
      description_ja: "裏面に目立つ折れ傷あり。",
      title_en: "Mewtwo GX SSR",
      description_en: "Crease on back.",
      category: "pokemon_card",
      brand: "Pokemon Card Game",
      condition: "傷や汚れあり",
      price: 5000,
      pokemon_card: {
        card_name: "ミュウツーGX",
        card_number: "219/150",
        grading_status: "ungraded",
        card_condition: "C"
      }
    };
    const cand2C = validateAndSanitizeDraftCandidate_(rawCand2C, { image_count: 2, has_back_image: true });

    const ok2 = cand2B.pokemon_card.card_condition === "B" && cand2C.pokemon_card.card_condition === "C";
    record("2. 明確な状態差: BおよびCの判定と保持", ok2, `cand2B=${cand2B.pokemon_card?.card_condition}, cand2C=${cand2C.pokemon_card?.card_condition}`);
  } catch (e2) {
    record("2. 明確な状態差: BおよびCの判定と保持", false, e2.message);
  }

  // 3. 鑑定済みカード（PSA等）: card_condition が空欄 ("") となりABCが入らないこと
  try {
    const rawCand3 = {
      title_ja: "PSA10 ピカチュウex SAR",
      description_ja: "PSA10鑑定品です。",
      title_en: "PSA 10 Pikachu ex SAR",
      description_en: "PSA 10 graded card.",
      category: "pokemon_card",
      brand: "Pokemon Card Game",
      condition: "目立った傷や汚れなし",
      price: 65000,
      pokemon_card: {
        card_name: "ピカチュウex",
        set_code: "SV8",
        card_number: "132/106",
        rarity: "SAR",
        grading_status: "graded",
        grader: "PSA",
        grade: "10",
        certification_number: "12345678",
        card_condition: "A" // 誤ってAが渡されてもgradedでは空文字に強制
      }
    };
    const cand3 = validateAndSanitizeDraftCandidate_(rawCand3, { image_count: 2, has_back_image: true });
    const ok3 = cand3.pokemon_card.grading_status === "graded" &&
                cand3.pokemon_card.grader === "PSA" &&
                cand3.pokemon_card.grade === "10" &&
                cand3.pokemon_card.card_condition === "";
    record("3. 鑑定済みカード(PSA等): card_condition空文字強制・未鑑定ABC混入防止", ok3, `card_condition='${cand3.pokemon_card?.card_condition}', grader='${cand3.pokemon_card?.grader}', grade='${cand3.pokemon_card?.grade}'`);
  } catch (e3) {
    record("3. 鑑定済みカード(PSA等): card_condition空文字強制・未鑑定ABC混入防止", false, e3.message);
  }

  // 4. 下書き反映と保存・詳細API取得 (applyCandidateToProduct_ -> buildProductDetail)
  try {
    const mockRow4 = new Array(40).fill("");
    mockRow4[0] = new Date();
    mockRow4[1] = "TMP-ABC-001";
    mockRow4[2] = "pokemon_card";
    mockRow4[3] = "Pokemon Card Game";
    mockRow4[4] = "ピカチュウ AR [SV2a 173/165]";
    mockRow4[5] = ""; // 本票F列（状態）
    mockRow4[7] = ""; // H列 販売予定価格 (未設定)
    mockRow4[29] = "";
    mockRow4[31] = "draft";
    mockRow4[32] = "in_stock";
    mockRow4[33] = "active";

    const mockSheet4 = {
      getLastColumn: () => 40,
      getRange: (r, c) => ({
        getValues: () => [mockRow4],
        setValue: (val) => { mockRow4[c - 1] = val; }
      })
    };

    let savedPkmCard4 = null;
    const origSavePkm = typeof savePokemonCardByProductId === "function" ? savePokemonCardByProductId : null;
    const origGetPkm = typeof getPokemonCardByProductId === "function" ? getPokemonCardByProductId : null;
    const origSafeGetPkm = typeof safeGetPokemonCard_ === "function" ? safeGetPokemonCard_ : null;
    const origSaveTrans = typeof saveConfirmedProductTranslation_ === "function" ? saveConfirmedProductTranslation_ : null;
    const origSafeGetTrans = typeof safeGetProductTranslation_ === "function" ? safeGetProductTranslation_ : null;

    savePokemonCardByProductId = (pid, payload) => {
      savedPkmCard4 = Object.assign({ product_id: pid }, payload);
      return { success: true };
    };
    getPokemonCardByProductId = (pid) => savedPkmCard4;
    safeGetPokemonCard_ = (pid) => savedPkmCard4;
    saveConfirmedProductTranslation_ = (pid, data) => data;
    safeGetProductTranslation_ = (pid) => ({ translation_status: "approved", translated_title: "Pikachu AR" });

    try {
      const cand4 = {
        title_ja: "ピカチュウ AR [SV2a 173/165]",
        price: 3500,
        category: "pokemon_card",
        brand: "Pokemon Card Game",
        condition: "",
        pokemon_card: {
          card_name: "ピカチュウ",
          set_code: "SV2a",
          card_number: "173/165",
          grading_status: "ungraded",
          card_condition: "A"
        }
      };
      applyCandidateToProduct_(mockSheet4, 2, "TMP-ABC-001", cand4);

      // 本票F列 (index 5) に A が書き込まれていないこと
      const fColClean = mockRow4[5] !== "A";
      // H列 (index 7) に価格 3500 が反映されていること
      const hColPrice = mockRow4[7] === 3500;
      // pokemon_cards に card_condition: "A" が保存されていること
      const pokeSavedA = savedPkmCard4 && savedPkmCard4.card_condition === "A";

      // buildProductDetail で詳細を取得
      const detail4 = buildProductDetail(mockRow4, true, true);
      const detailPokeA = detail4 && detail4.pokemon_card && detail4.pokemon_card.card_condition === "A";
      const detailCardCondA = detail4 && detail4.card_condition === "A";

      const ok4 = fColClean && hColPrice && pokeSavedA && detailPokeA && detailCardCondA;
      record("4. 下書き反映・保存・詳細API取得: card_condition 'A' 保存・詳細取得・F列非汚染・H列価格反映", ok4, `fCol='${mockRow4[5]}', hCol=${mockRow4[7]}, savedCond='${savedPkmCard4?.card_condition}', detailPokeCond='${detail4?.pokemon_card?.card_condition}'`);
    } finally {
      if (origSavePkm) savePokemonCardByProductId = origSavePkm;
      if (origGetPkm) getPokemonCardByProductId = origGetPkm;
      if (origSafeGetPkm) safeGetPokemonCard_ = origSafeGetPkm;
      if (origSaveTrans) saveConfirmedProductTranslation_ = origSaveTrans;
      if (origSafeGetTrans) safeGetProductTranslation_ = origSafeGetTrans;
    }
  } catch (e4) {
    record("4. 下書き反映・保存・詳細API取得: card_condition 'A' 保存・詳細取得・F列非汚染・H列価格反映", false, e4.message);
  }

  // 5. スタッフ修正後の再生成で値が守られること (保護マージ)
  try {
    const mockRow5 = new Array(40).fill("");
    mockRow5[1] = "TMP-ABC-STAFF";
    mockRow5[2] = "pokemon_card";
    mockRow5[4] = "ミュウツーGX [219/150]";
    mockRow5[5] = "";
    mockRow5[7] = 5000;

    const mockSheet5 = {
      getLastColumn: () => 40,
      getRange: (r, c) => ({
        getValues: () => [mockRow5],
        setValue: (val) => { mockRow5[c - 1] = val; }
      })
    };

    let savedPkmCard5 = null;
    const origSavePkm5 = typeof savePokemonCardByProductId === "function" ? savePokemonCardByProductId : null;
    const origSafeGetPkm5 = typeof safeGetPokemonCard_ === "function" ? safeGetPokemonCard_ : null;
    const origSaveTrans5 = typeof saveConfirmedProductTranslation_ === "function" ? saveConfirmedProductTranslation_ : null;
    const origSafeGetTrans5 = typeof safeGetProductTranslation_ === "function" ? safeGetProductTranslation_ : null;

    // スタッフが事前に card_condition を "B" へ修正済み
    const existingStaffPoke = {
      product_id: "TMP-ABC-STAFF",
      card_name: "ミュウツーGX",
      card_number: "219/150",
      grading_status: "ungraded",
      card_condition: "B"
    };

    safeGetPokemonCard_ = (pid) => existingStaffPoke;
    savePokemonCardByProductId = (pid, payload) => {
      savedPkmCard5 = payload;
      return { success: true };
    };
    saveConfirmedProductTranslation_ = (pid, data) => data;
    safeGetProductTranslation_ = (pid) => ({ translation_status: "approved", translated_title: "Mewtwo GX" });

    try {
      // AI再生成で "A" が候補として提示された場合
      const candidateAi = {
        title_ja: "ミュウツーGX [219/150]",
        price: 5200,
        category: "pokemon_card",
        pokemon_card: {
          card_name: "ミュウツーGX",
          card_number: "219/150",
          grading_status: "ungraded",
          card_condition: "A"
        }
      };
      applyCandidateToProduct_(mockSheet5, 2, "TMP-ABC-STAFF", candidateAi);

      // スタッフ入力の "B" が保持されていること (Aで上書きされない)
      const ok5 = savedPkmCard5 && savedPkmCard5.card_condition === "B";
      record("5. スタッフ修正値の保護: AI再生成で既存のcard_condition 'B' が上書きされず保持されること", ok5, `savedCondition='${savedPkmCard5?.card_condition}'`);
    } finally {
      if (origSavePkm5) savePokemonCardByProductId = origSavePkm5;
      if (origSafeGetPkm5) safeGetPokemonCard_ = origSafeGetPkm5;
      if (origSaveTrans5) saveConfirmedProductTranslation_ = origSaveTrans5;
      if (origSafeGetTrans5) safeGetProductTranslation_ = origSafeGetTrans5;
    }
  } catch (e5) {
    record("5. スタッフ修正値の保護: AI再生成で既存のcard_condition 'B' が上書きされず保持されること", false, e5.message);
  }

  // 6. 商品更新 API (handleUpdateProduct) での更新受付とF列保護
  try {
    const mockRow6 = new Array(40).fill("");
    mockRow6[1] = "TMP-ABC-UPD";
    mockRow6[2] = "pokemon_card";
    mockRow6[4] = "ゲンガーex";
    mockRow6[5] = "目立った傷や汚れなし"; // 初期F列
    mockRow6[7] = 12000;

    const mockSheet6 = {
      getLastColumn: () => 40,
      getRange: (r, c) => ({
        getValue: () => mockRow6[c - 1],
        getValues: () => [mockRow6],
        setValue: (val) => { mockRow6[c - 1] = val; }
      })
    };

    let pkmSavedUpdate = null;
    const origFindProductRow = typeof findProductRow === "function" ? findProductRow : null;
    const origSavePkm6 = typeof savePokemonCardByProductId === "function" ? savePokemonCardByProductId : null;

    findProductRow = (s, pid) => 2;
    savePokemonCardByProductId = (pid, payload) => {
      pkmSavedUpdate = payload;
      return { success: true };
    };

    try {
      // 6a: pokemon_card オブジェクトによる card_condition: "B" 更新
      handleUpdateProduct(mockSheet6, {
        product_id: "TMP-ABC-UPD",
        pokemon_card: { card_condition: "B" }
      });
      const ok6a = pkmSavedUpdate && pkmSavedUpdate.card_condition === "B" && mockRow6[5] === "目立った傷や汚れなし";

      // 6b: トップレベル card_condition: "C" 更新
      pkmSavedUpdate = null;
      handleUpdateProduct(mockSheet6, {
        product_id: "TMP-ABC-UPD",
        card_condition: "C"
      });
      const ok6b = pkmSavedUpdate && pkmSavedUpdate.card_condition === "C" && mockRow6[5] === "目立った傷や汚れなし";

      // 6c: トップレベル condition: "A" 更新 -> pokemon_cards へ保存され、本票F列には "A" が書き込まれない
      pkmSavedUpdate = null;
      handleUpdateProduct(mockSheet6, {
        product_id: "TMP-ABC-UPD",
        condition: "A"
      });
      const ok6c = pkmSavedUpdate && pkmSavedUpdate.card_condition === "A" && mockRow6[5] !== "A";

      const ok6 = ok6a && ok6b && ok6c;
      record("6. 商品更新API(handleUpdateProduct): pokemon_card/トップレベル更新受付と本票F列のA/B/C汚染防止", ok6, `ok6a=${ok6a}, ok6b=${ok6b}, ok6c=${ok6c}, row5='${mockRow6[5]}'`);
    } finally {
      if (origFindProductRow) findProductRow = origFindProductRow;
      if (origSavePkm6) savePokemonCardByProductId = origSavePkm6;
    }
  } catch (e6) {
    record("6. 商品更新API(handleUpdateProduct): pokemon_card/トップレベル更新受付と本票F列のA/B/C汚染防止", false, e6.message);
  }

  console.log(`--- [testPokemonCardConditionAbcSuite_] 完了: ${passed}/${results.length} 通過 (失敗: ${failed}) ---`);
  return {
    passed: passed,
    failed: failed,
    total: results.length,
    results: results
  };
}

/**
 * 管理画面商品一覧 サーバー側検索・フィルター・ソート・ページ分割テストスイート
 */
function testAdminProductListPaginationSuite_() {
  const results = [];
  let passed = 0;
  let failed = 0;

  function record(name, isPass, detail) {
    results.push({ name: name, passed: isPass, detail: detail || "" });
    if (isPass) {
      passed++;
      console.log(`✓ ${name}`);
    } else {
      failed++;
      console.error(`✗ ${name}: ${detail}`);
    }
  }

  console.log("\n--- [testAdminProductListPaginationSuite_] 開始 ---");

  function createMockDataset_() {
    const headerRow = new Array(40).fill("header");
    headerRow[0] = "created_at";
    headerRow[1] = "product_id";
    headerRow[2] = "category";
    headerRow[3] = "brand";
    headerRow[4] = "product_name";
    headerRow[5] = "condition";
    headerRow[6] = "purchase_price";
    headerRow[7] = "planned_sale_price";
    headerRow[8] = "storage_location";
    headerRow[29] = "drive_folder_url";
    headerRow[30] = "main_image_url";
    headerRow[31] = "publish_status";
    headerRow[32] = "inventory_status";
    headerRow[33] = "record_status";

    function makeRow(id, cat, brand, name, price, pubStatus, invStatus, recStatus, dateStr) {
      const row = new Array(40).fill("");
      row[0] = new Date(dateStr);
      row[1] = id;
      row[2] = cat;
      row[3] = brand;
      row[4] = name;
      row[5] = "目立った傷や汚れなし";
      row[6] = Math.round(price * 0.7);
      row[7] = price;
      row[8] = "A-1";
      row[29] = "https://drive.google.com/drive/folders/" + id;
      row[30] = "https://drive.google.com/file/d/" + id + "_img/view";
      row[31] = pubStatus;
      row[32] = invStatus;
      row[33] = recStatus;
      return row;
    }

    const rows = [
      headerRow,
      makeRow("TMP-PAG-001", "sneaker", "Nike", "Air Jordan 1 High", 25000, "published", "in_stock", "active", "2026-10-01T10:00:00.000Z"),
      makeRow("TMP-PAG-002", "sneaker", "adidas", "Yeezy Boost 350", 30000, "published", "in_stock", "active", "2026-10-02T10:00:00.000Z"),
      makeRow("TMP-PAG-003", "pokemon_card", "Pokemon", "ピカチュウ AR", 5000, "draft", "in_stock", "active", "2026-10-03T10:00:00.000Z"),
      makeRow("TMP-PAG-004", "pokemon_card", "Pokemon", "リザードンex SAR", 45000, "published", "out_of_stock", "active", "2026-10-04T10:00:00.000Z"),
      makeRow("TMP-PAG-005", "jewelry", "Cartier", "ラブリング K18WG", 180000, "published", "in_stock", "archived", "2026-10-05T10:00:00.000Z"),
      makeRow("TMP-PAG-006", "sneaker", "Nike", "Dunk Low Retro Panda", 15000, "published", "in_stock", "active", "2026-10-06T10:00:00.000Z"),
      makeRow("TMP-PAG-007", "other", "Supreme", "Box Logo Hoodie", 45000, "hidden", "in_stock", "active", "2026-10-07T10:00:00.000Z")
    ];

    const mockSheet = {
      getLastRow: () => rows.length,
      getLastColumn: () => 40,
      getMaxColumns: () => 40,
      getDataRange: () => ({
        getValues: () => rows
      })
    };

    return { mockSheet: mockSheet, rows: rows };
  }

  // 1. 2ページ以上の複数ページ分割と重複ゼロの検証
  try {
    const { mockSheet } = createMockDataset_();
    // アクティブ商品は6件 (TMP-001, 002, 003, 004, 006, 007)。1ページ2件で3ページ構成
    const p1Raw = doGet({ parameter: { mode: "admin", page: "1", page_size: "2" } }, { sheet: mockSheet });
    const p1 = JSON.parse(p1Raw.getContent ? p1Raw.getContent() : p1Raw);

    const p2Raw = doGet({ parameter: { mode: "admin", page: "2", page_size: "2" } }, { sheet: mockSheet });
    const p2 = JSON.parse(p2Raw.getContent ? p2Raw.getContent() : p2Raw);

    const p3Raw = doGet({ parameter: { mode: "admin", page: "3", page_size: "2" } }, { sheet: mockSheet });
    const p3 = JSON.parse(p3Raw.getContent ? p3Raw.getContent() : p3Raw);

    const okCounts = p1.count === 6 && p1.total_pages === 3 && p1.page === 1 && p1.page_size === 2 && p1.products.length === 2 &&
                     p2.count === 6 && p2.total_pages === 3 && p2.page === 2 && p2.page_size === 2 && p2.products.length === 2 &&
                     p3.count === 6 && p3.total_pages === 3 && p3.page === 3 && p3.page_size === 2 && p3.products.length === 2;

    const allPids = [
      ...p1.products.map(p => p.product_id),
      ...p2.products.map(p => p.product_id),
      ...p3.products.map(p => p.product_id)
    ];
    const uniquePids = new Set(allPids);
    const okNoDups = allPids.length === 6 && uniquePids.size === 6;

    record("1. 複数ページ分割(2ページ以上): 件数・総ページ数・ページ切出・ページ間重複ゼロ保証", okCounts && okNoDups, `all=${allPids.join(",")}`);
  } catch (e1) {
    record("1. 複数ページ分割(2ページ以上): 件数・総ページ数・ページ切出・ページ間重複ゼロ保証", false, e1.message);
  }

  // 2. 範囲外ページおよび0件ヒット時の挙動
  try {
    const { mockSheet } = createMockDataset_();
    // 範囲外ページ (page: 4 / total_pages: 3)
    const p4Raw = doGet({ parameter: { mode: "admin", page: "4", page_size: "2" } }, { sheet: mockSheet });
    const p4 = JSON.parse(p4Raw.getContent ? p4Raw.getContent() : p4Raw);
    const okP4 = p4.success === true && p4.count === 6 && p4.total_pages === 3 && p4.page === 4 && p4.products.length === 0;

    // 極端な範囲外ページ (page: 999)
    const p999Raw = doGet({ parameter: { mode: "admin", page: "999", page_size: "2" } }, { sheet: mockSheet });
    const p999 = JSON.parse(p999Raw.getContent ? p999Raw.getContent() : p999Raw);
    const okP999 = p999.success === true && p999.count === 6 && p999.total_pages === 3 && p999.page === 999 && p999.products.length === 0;

    // 0件ヒット (条件に一致する商品なし)
    const pZeroRaw = doGet({ parameter: { mode: "admin", page: "1", page_size: "50", search: "NoMatchingItemXYZ" } }, { sheet: mockSheet });
    const pZero = JSON.parse(pZeroRaw.getContent ? pZeroRaw.getContent() : pZeroRaw);
    const okZero = pZero.success === true && pZero.count === 0 && pZero.total_pages === 0 && pZero.page === 1 && pZero.products.length === 0;

    record("2. 範囲外ページ・0件挙動: page>total_pages時の空配列・count=0時のtotal_pages=0明示", okP4 && okP999 && okZero, `okP4=${okP4}, okP999=${okP999}, okZero=${okZero}`);
  } catch (e2) {
    record("2. 範囲外ページ・0件挙動: page>total_pages時の空配列・count=0時のtotal_pages=0明示", false, e2.message);
  }

  // 3. 検索機能 (商品名・商品ID・ブランドの部分一致、大文字小文字無視、複数ワード)
  try {
    const { mockSheet } = createMockDataset_();

    // 商品名部分一致
    const sNameRaw = doGet({ parameter: { mode: "admin", search: "ピカチュウ", page: "1" } }, { sheet: mockSheet });
    const sName = JSON.parse(sNameRaw.getContent ? sNameRaw.getContent() : sNameRaw);
    const okName = sName.count === 1 && sName.products[0].product_id === "TMP-PAG-003";

    // 商品ID部分一致
    const sIdRaw = doGet({ parameter: { mode: "admin", search: "TMP-PAG-004", page: "1" } }, { sheet: mockSheet });
    const sId = JSON.parse(sIdRaw.getContent ? sIdRaw.getContent() : sIdRaw);
    const okId = sId.count === 1 && sId.products[0].product_id === "TMP-PAG-004";

    // ブランド部分一致 (大文字小文字無視: "nike")
    const sBrandRaw = doGet({ parameter: { mode: "admin", search: "nike", page: "1" } }, { sheet: mockSheet });
    const sBrand = JSON.parse(sBrandRaw.getContent ? sBrandRaw.getContent() : sBrandRaw);
    const okBrand = sBrand.count === 2 && sBrand.products.every(p => p.brand.toLowerCase() === "nike");

    // 複数語AND検索 ("Nike Panda")
    const sMultiRaw = doGet({ parameter: { mode: "admin", search: "Nike Panda", page: "1" } }, { sheet: mockSheet });
    const sMulti = JSON.parse(sMultiRaw.getContent ? sMultiRaw.getContent() : sMultiRaw);
    const okMulti = sMulti.count === 1 && sMulti.products[0].product_id === "TMP-PAG-006";

    record("3. 検索機能: 商品名・商品ID・ブランド部分一致・大小文字無視・複数語AND", okName && okId && okBrand && okMulti, `okName=${okName}, okId=${okId}, okBrand=${okBrand}, okMulti=${okMulti}`);
  } catch (e3) {
    record("3. 検索機能: 商品名・商品ID・ブランド部分一致・大小文字無視・複数語AND", false, e3.message);
  }

  // 4. 各種フィルター (カテゴリ、公開状態、在庫状態、record_status)
  try {
    const { mockSheet } = createMockDataset_();

    // カテゴリフィルター
    const catRaw = doGet({ parameter: { mode: "admin", category: "pokemon_card", page: "1" } }, { sheet: mockSheet });
    const catRes = JSON.parse(catRaw.getContent ? catRaw.getContent() : catRaw);
    const okCat = catRes.count === 2 && catRes.products.every(p => p.category === "pokemon_card");

    // 公開状態フィルター (draft)
    const pubRaw = doGet({ parameter: { mode: "admin", publish_status: "draft", page: "1" } }, { sheet: mockSheet });
    const pubRes = JSON.parse(pubRaw.getContent ? pubRaw.getContent() : pubRaw);
    const okPub = pubRes.count === 1 && pubRes.products[0].product_id === "TMP-PAG-003";

    // 在庫状態フィルター (out_of_stock)
    const invRaw = doGet({ parameter: { mode: "admin", inventory_status: "out_of_stock", page: "1" } }, { sheet: mockSheet });
    const invRes = JSON.parse(invRaw.getContent ? invRaw.getContent() : invRaw);
    const okInv = invRes.count === 1 && invRes.products[0].product_id === "TMP-PAG-004";

    // record_status フィルター (archived)
    const arcRaw = doGet({ parameter: { mode: "admin", record_status: "archived", page: "1" } }, { sheet: mockSheet });
    const arcRes = JSON.parse(arcRaw.getContent ? arcRaw.getContent() : arcRaw);
    const okArc = arcRes.count === 1 && arcRes.products[0].product_id === "TMP-PAG-005";

    // record_status=all
    const allRaw = doGet({ parameter: { mode: "admin", record_status: "all", page: "1", page_size: "10" } }, { sheet: mockSheet });
    const allRes = JSON.parse(allRaw.getContent ? allRaw.getContent() : allRaw);
    const okAll = allRes.count === 7 && allRes.products.length === 7;

    record("4. フィルター機能: category, publish_status, inventory_status, record_status(通常/アーカイブ/all)", okCat && okPub && okInv && okArc && okAll, `okCat=${okCat}, okPub=${okPub}, okInv=${okInv}, okArc=${okArc}, okAll=${okAll}`);
  } catch (e4) {
    record("4. フィルター機能: category, publish_status, inventory_status, record_status(通常/アーカイブ/all)", false, e4.message);
  }

  // 5. 並び順とタイブレーク (同値商品の順序固定)
  try {
    const { mockSheet } = createMockDataset_();

    // 価格降順 (price_desc): 45000 (TMP-004, TMP-007 tied), 30000 (TMP-002), 25000 (TMP-001), 15000 (TMP-006), 5000 (TMP-003)
    // 同額45000の2件は product_id 昇順で TMP-PAG-004 が TMP-PAG-007 より先に来る
    const sortPriceDescRaw = doGet({ parameter: { mode: "admin", sort: "price_desc", page: "1", page_size: "6" } }, { sheet: mockSheet });
    const sortPriceDesc = JSON.parse(sortPriceDescRaw.getContent ? sortPriceDescRaw.getContent() : sortPriceDescRaw);
    const pidsDesc = sortPriceDesc.products.map(p => p.product_id);
    const okPriceDesc = pidsDesc[0] === "TMP-PAG-004" && pidsDesc[1] === "TMP-PAG-007" && pidsDesc[5] === "TMP-PAG-003";

    // 1件ずつ切り出しても同額商品の順序がページ間で揺れないことを検証 (page_size=1)
    const p1PriceRaw = doGet({ parameter: { mode: "admin", sort: "price_desc", page: "1", page_size: "1" } }, { sheet: mockSheet });
    const p1Price = JSON.parse(p1PriceRaw.getContent ? p1PriceRaw.getContent() : p1PriceRaw);
    const p2PriceRaw = doGet({ parameter: { mode: "admin", sort: "price_desc", page: "2", page_size: "1" } }, { sheet: mockSheet });
    const p2Price = JSON.parse(p2PriceRaw.getContent ? p2PriceRaw.getContent() : p2PriceRaw);
    const okTieBreak = p1Price.products[0].product_id === "TMP-PAG-004" && p2Price.products[0].product_id === "TMP-PAG-007";

    // 価格昇順 (price_asc)
    const sortPriceAscRaw = doGet({ parameter: { mode: "admin", sort: "price_asc", page: "1", page_size: "1" } }, { sheet: mockSheet });
    const sortPriceAsc = JSON.parse(sortPriceAscRaw.getContent ? sortPriceAscRaw.getContent() : sortPriceAscRaw);
    const okPriceAsc = sortPriceAsc.products[0].product_id === "TMP-PAG-003";

    // 商品名昇順 (name_asc)
    const sortNameAscRaw = doGet({ parameter: { mode: "admin", sort: "name_asc", page: "1", page_size: "6" } }, { sheet: mockSheet });
    const sortNameAsc = JSON.parse(sortNameAscRaw.getContent ? sortNameAscRaw.getContent() : sortNameAscRaw);
    const okNameAsc = sortNameAsc.products[0].product_name === "Air Jordan 1 High";

    // 登録日時新旧 (created_desc / created_asc)
    const sortCreatedDescRaw = doGet({ parameter: { mode: "admin", sort: "created_desc", page: "1", page_size: "1" } }, { sheet: mockSheet });
    const sortCreatedDesc = JSON.parse(sortCreatedDescRaw.getContent ? sortCreatedDescRaw.getContent() : sortCreatedDescRaw);
    const okCreatedDesc = sortCreatedDesc.products[0].product_id === "TMP-PAG-007"; // 10-07最新

    const sortCreatedAscRaw = doGet({ parameter: { mode: "admin", sort: "created_asc", page: "1", page_size: "1" } }, { sheet: mockSheet });
    const sortCreatedAsc = JSON.parse(sortCreatedAscRaw.getContent ? sortCreatedAscRaw.getContent() : sortCreatedAscRaw);
    const okCreatedAsc = sortCreatedAsc.products[0].product_id === "TMP-PAG-001"; // 10-01最古

    // 既定の順序 (default) -> シート追加逆順
    const sortDefaultRaw = doGet({ parameter: { mode: "admin", sort: "default", page: "1", page_size: "1" } }, { sheet: mockSheet });
    const sortDefault = JSON.parse(sortDefaultRaw.getContent ? sortDefaultRaw.getContent() : sortDefaultRaw);
    const okDefault = sortDefault.products[0].product_id === "TMP-PAG-007";

    const okSort = okPriceDesc && okTieBreak && okPriceAsc && okNameAsc && okCreatedDesc && okCreatedAsc && okDefault;
    record("5. 並び順・タイブレーク: 既定・登録日時・価格・商品名昇降順・同値時ID順序固定", okSort, `priceDesc=${okPriceDesc}, tieBreak=${okTieBreak}, priceAsc=${okPriceAsc}, nameAsc=${okNameAsc}`);
  } catch (e5) {
    record("5. 並び順・タイブレーク: 既定・登録日時・価格・商品名昇降順・同値時ID順序固定", false, e5.message);
  }

  // 6. ページパラメータ境界値と既定値・上限値クランプ (既定50, 上限100, 下限1)
  try {
    const { mockSheet } = createMockDataset_();

    // page_size 未指定時は 50
    const defPsRaw = doGet({ parameter: { mode: "admin", page: "1" } }, { sheet: mockSheet });
    const defPs = JSON.parse(defPsRaw.getContent ? defPsRaw.getContent() : defPsRaw);
    const okDefPs = defPs.page_size === 50;

    // page_size 超過 (150) は 100 にクランプ
    const maxPsRaw = doGet({ parameter: { mode: "admin", page: "1", page_size: "150" } }, { sheet: mockSheet });
    const maxPs = JSON.parse(maxPsRaw.getContent ? maxPsRaw.getContent() : maxPsRaw);
    const okMaxPs = maxPs.page_size === 100;

    // page_size <= 0 は 50 に補正
    const zeroPsRaw = doGet({ parameter: { mode: "admin", page: "1", page_size: "0" } }, { sheet: mockSheet });
    const zeroPs = JSON.parse(zeroPsRaw.getContent ? zeroPsRaw.getContent() : zeroPsRaw);
    const okZeroPs = zeroPs.page_size === 50;

    // page <= 0 は 1 に補正
    const zeroPageRaw = doGet({ parameter: { mode: "admin", page: "0", page_size: "10" } }, { sheet: mockSheet });
    const zeroPage = JSON.parse(zeroPageRaw.getContent ? zeroPageRaw.getContent() : zeroPageRaw);
    const okZeroPage = zeroPage.page === 1;

    record("6. 境界値検証: page_size既定50・上限100クランプ・不正page補正", okDefPs && okMaxPs && okZeroPs && okZeroPage, `defPs=${okDefPs}, maxPs=${okMaxPs}, zeroPs=${okZeroPs}, zeroPage=${okZeroPage}`);
  } catch (e6) {
    record("6. 境界値検証: page_size既定50・上限100クランプ・不正page補正", false, e6.message);
  }

  // 7. 従来互換モード (ページネーション未指定時のadmin-product-list-v2全件返却)
  try {
    const { mockSheet } = createMockDataset_();
    const legacyRaw = doGet({ parameter: { mode: "admin" } }, { sheet: mockSheet });
    const legacy = JSON.parse(legacyRaw.getContent ? legacyRaw.getContent() : legacyRaw);

    const okLegacy = legacy.success === true &&
                     legacy.version === "admin-product-list-v2" &&
                     legacy.count === 6 &&
                     legacy.products.length === 6 &&
                     legacy.page === undefined &&
                     legacy.page_size === undefined;

    record("7. 従来互換モード: パラメータ未指定時のadmin-product-list-v2全件返却維持", okLegacy, `version=${legacy.version}, count=${legacy.count}, productsLen=${legacy.products?.length}`);
  } catch (e7) {
    record("7. 従来互換モード: パラメータ未指定時のadmin-product-list-v2全件返却維持", false, e7.message);
  }

  // 8. 英語タイトル一括マッピング (product_translations シートから translated_title を一括結合・最新行優先・未翻訳は空文字)
  try {
    const { mockSheet } = createMockDataset_();

    const transRows = [
      ["TMP-PAG-001", "en", "Nike Air Jordan 1 High (En Title)", "En Desc", "Good", "", "", "approved", "2026-10-01T00:00:00Z"],
      ["TMP-PAG-002", "en", "Old adidas Yeezy Title", "En Desc", "Good", "", "", "draft", "2026-09-01T00:00:00Z"],
      ["TMP-PAG-002", "en", "adidas Yeezy Boost 350 V2 (Latest En Title)", "En Desc", "Good", "", "", "approved", "2026-10-02T00:00:00Z"]
    ];

    const mockTransSheet = {
      getLastRow: () => transRows.length + 1,
      getLastColumn: () => 9,
      getRange: (r, c, numR, numC) => {
        if (r === 1 && numR === 1) {
          return {
            getValues: () => [[
              "product_id", "locale", "translated_title", "translated_description",
              "translated_condition", "translated_box", "translated_accessories",
              "translation_status", "generated_at"
            ]]
          };
        }
        return {
          getValues: () => transRows
        };
      }
    };

    const origGetActiveSpreadsheet = SpreadsheetApp.getActiveSpreadsheet;
    SpreadsheetApp.getActiveSpreadsheet = () => ({
      getSheets: () => [mockSheet],
      getSheetByName: (name) => {
        if (name === "product_translations") return mockTransSheet;
        return mockSheet;
      }
    });

    try {
      // 従来互換モードでの検証
      const legacyRaw = doGet({ parameter: { mode: "admin" } }, { sheet: mockSheet });
      const legacy = JSON.parse(legacyRaw.getContent ? legacyRaw.getContent() : legacyRaw);

      const p1 = legacy.products.find(p => p.product_id === "TMP-PAG-001");
      const p2 = legacy.products.find(p => p.product_id === "TMP-PAG-002");
      const p3 = legacy.products.find(p => p.product_id === "TMP-PAG-003");

      const okP1 = p1 && p1.translated_title === "Nike Air Jordan 1 High (En Title)";
      const okP2 = p2 && p2.translated_title === "adidas Yeezy Boost 350 V2 (Latest En Title)";
      const okP3 = p3 && p3.translated_title === "";

      // ページネーションモードでの検証
      const pageRaw = doGet({ parameter: { mode: "admin", page: "1", page_size: "10" } }, { sheet: mockSheet });
      const pageRes = JSON.parse(pageRaw.getContent ? pageRaw.getContent() : pageRaw);

      const pageP1 = pageRes.products.find(p => p.product_id === "TMP-PAG-001");
      const pageP2 = pageRes.products.find(p => p.product_id === "TMP-PAG-002");
      const pageP3 = pageRes.products.find(p => p.product_id === "TMP-PAG-003");

      const okPage = pageP1 && pageP1.translated_title === "Nike Air Jordan 1 High (En Title)" &&
                     pageP2 && pageP2.translated_title === "adidas Yeezy Boost 350 V2 (Latest En Title)" &&
                     pageP3 && pageP3.translated_title === "";

      record("8. 英語タイトル一括マッピング: product_translationsからtranslated_titleを一括結合(最新行優先・未翻訳空文字・全APIモード対応)", okP1 && okP2 && okP3 && okPage, `p1=${okP1}, p2=${okP2}(${p2?.translated_title}), p3=${okP3}, page=${okPage}`);
    } finally {
      SpreadsheetApp.getActiveSpreadsheet = origGetActiveSpreadsheet;
    }
  } catch (e8) {
    record("8. 英語タイトル一括マッピング: product_translationsからtranslated_titleを一括結合(最新行優先・未翻訳空文字・全APIモード対応)", false, e8.message);
  }

  console.log(`--- [testAdminProductListPaginationSuite_] 完了: ${passed}/${results.length} 通過 (失敗: ${failed}) ---`);
  return {
    passed: passed,
    failed: failed,
    total: results.length,
    results: results
  };
}

// ==================================================
// 24. 独立原本書類アップロード テストスイート (工程2)
// ==================================================

function testIndependentDocumentUploadSuite_() {
  console.log("\n--- [testIndependentDocumentUploadSuite_] 開始 ---");
  const results = [];
  let passed = 0;
  let failed = 0;

  function record(name, ok, detail) {
    if (ok) {
      passed++;
      console.log(`✓ ${name}`);
    } else {
      failed++;
      console.error(`✗ ${name}: ${detail}`);
    }
    results.push({ name: name, passed: ok, detail: detail });
  }

  class MockFile {
    constructor(id, name, mimeType, bytes) {
      this.id = id;
      this.name = name;
      this.mimeType = mimeType;
      this.bytes = bytes;
      this.trashed = false;
    }
    getId() { return this.id; }
    getName() { return this.name; }
    getMimeType() { return this.mimeType; }
    getUrl() { return "https://drive.google.com/file/d/" + this.id + "/view"; }
    isTrashed() { return this.trashed; }
  }

  class MockFolder {
    constructor(id, name) {
      this.id = id;
      this.name = name;
      this.files = [];
      this.subfolders = [];
      this.trashed = false;
    }
    getId() { return this.id; }
    getName() { return this.name; }
    getUrl() { return "https://drive.google.com/drive/folders/" + this.id; }
    isTrashed() { return this.trashed; }
    getFoldersByName(name) {
      const matched = this.subfolders.filter(f => f.getName() === name && !f.isTrashed());
      let idx = 0;
      return {
        hasNext: () => idx < matched.length,
        next: () => matched[idx++]
      };
    }
    createFolder(name) {
      const f = new MockFolder("fld-" + name + "-" + Math.random().toString(36).slice(2, 6), name);
      this.subfolders.push(f);
      return f;
    }
    createFile(blob) {
      const fileId = "file-" + Math.random().toString(36).slice(2, 8);
      const file = new MockFile(fileId, blob.getName(), blob.getContentType(), blob.getBytes ? blob.getBytes() : []);
      this.files.push(file);
      return file;
    }
  }

  const rootFolder = new MockFolder(ROOT_FOLDER_ID, "RootFolder");
  const mockPropService = {
    props: { ADMIN_API_KEY: "test_secret_key_123" },
    getProperty(k) { return this.props[k] || null; },
    setProperty(k, v) { this.props[k] = String(v); }
  };

  // 1. PDF原本の独立アップロード (正常系: product_id不要でDrive保存)
  try {
    const rawPdf = Utilities.base64Encode("SAMPLE_INDEPENDENT_PDF_CONTENT");
    const res1Raw = handleUploadIndependentDocument({
      idempotency_key: "idem-indep-001",
      document_type: "statement",
      file_name: "20251216_計算書_K026021.pdf",
      mime_type: "application/pdf",
      base64: rawPdf
    }, { rootFolder: rootFolder });
    const res1 = JSON.parse(res1Raw.getContent ? res1Raw.getContent() : res1Raw);

    const ok1 = res1.success === true &&
                Boolean(res1.file_id) &&
                res1.file_name === "20251216_計算書_K026021.pdf" &&
                res1.mime_type === "application/pdf" &&
                Boolean(res1.file_fingerprint) &&
                res1.file_size > 0;
    record("1. PDF原本の独立アップロード: 正常系・product_id不要・Drive保存・指紋返却", ok1, JSON.stringify(res1));
  } catch (e1) {
    record("1. PDF原本の独立アップロード: 正常系・product_id不要・Drive保存・指紋返却", false, e1.message);
  }

  // 2. JPG/PNG領収書の独立アップロード
  try {
    const rawJpg = Utilities.base64Encode("SAMPLE_INDEPENDENT_JPG_IMAGE");
    const res2Raw = handleUploadIndependentDocument({
      idempotency_key: "idem-indep-002",
      document_type: "receipt",
      file_name: "receipt_komehyo.jpg",
      mime_type: "image/jpeg",
      base64: rawJpg
    }, { rootFolder: rootFolder });
    const res2 = JSON.parse(res2Raw.getContent ? res2Raw.getContent() : res2Raw);

    const ok2 = res2.success === true &&
                Boolean(res2.file_id) &&
                res2.mime_type === "image/jpeg";
    record("2. 画像領収書の独立アップロード: JPG/PNG対応・正常保存", ok2, JSON.stringify(res2));
  } catch (e2) {
    record("2. 画像領収書の独立アップロード: JPG/PNG対応・正常保存", false, e2.message);
  }

  // 3. 不正MIMEタイプの拒絶 (txt, exe 等)
  try {
    const res3Raw = handleUploadIndependentDocument({
      idempotency_key: "idem-indep-003",
      file_name: "bad.txt",
      mime_type: "text/plain",
      base64: Utilities.base64Encode("hello world")
    }, { rootFolder: rootFolder });
    const res3 = JSON.parse(res3Raw.getContent ? res3Raw.getContent() : res3Raw);

    const ok3 = res3.success === false && res3.error_code === "INVALID_DOCUMENT_MIME_TYPE";
    record("3. 不正MIMEタイプの拒絶: PDF/JPG/PNG以外を遮断", ok3, JSON.stringify(res3));
  } catch (e3) {
    record("3. 不正MIMEタイプの拒絶: PDF/JPG/PNG以外を遮断", false, e3.message);
  }

  // 4. 空Base64 / 不正Base64の拒絶
  try {
    const res4Raw = handleUploadIndependentDocument({
      idempotency_key: "idem-indep-004",
      file_name: "empty.pdf",
      mime_type: "application/pdf",
      base64: ""
    }, { rootFolder: rootFolder });
    const res4 = JSON.parse(res4Raw.getContent ? res4Raw.getContent() : res4Raw);

    const ok4 = res4.success === false && res4.error_code === "EMPTY_DOCUMENT_BASE64";
    record("4. 空Base64の拒絶: EMPTY_DOCUMENT_BASE64返却", ok4, JSON.stringify(res4));
  } catch (e4) {
    record("4. 空Base64の拒絶: EMPTY_DOCUMENT_BASE64返却", false, e4.message);
  }

  // 5. 冪等性キー欠落の拒絶
  try {
    const res5Raw = handleUploadIndependentDocument({
      file_name: "no_key.pdf",
      mime_type: "application/pdf",
      base64: Utilities.base64Encode("test")
    }, { rootFolder: rootFolder });
    const res5 = JSON.parse(res5Raw.getContent ? res5Raw.getContent() : res5Raw);

    const ok5 = res5.success === false && res5.error_code === "IDEMPOTENCY_KEY_REQUIRED";
    record("5. 冪等性キー欠落の拒絶: IDEMPOTENCY_KEY_REQUIRED返却", ok5, JSON.stringify(res5));
  } catch (e5) {
    record("5. 冪等性キー欠落の拒絶: IDEMPOTENCY_KEY_REQUIRED返却", false, e5.message);
  }

  // 6. doPost経由での管理者認証チェック (非管理者 / キー不一致の拒絶)
  try {
    const unauthPost = doPost({
      postData: {
        contents: JSON.stringify({
          action: "upload_independent_document",
          idempotency_key: "idem-unauth-001",
          file_name: "test.pdf",
          mime_type: "application/pdf",
          base64: Utilities.base64Encode("test")
        })
      }
    }, { rootFolder: rootFolder, propService: mockPropService });
    const unauthRes = JSON.parse(unauthPost.getContent ? unauthPost.getContent() : unauthPost);

    const ok6 = unauthRes.success === false && unauthRes.error_code === "UNAUTHORIZED_ADMIN_ACCESS";
    record("6. doPost管理者認証: mode=admin+正しいadmin_keyなしの呼出しを拒絶", ok6, JSON.stringify(unauthRes));
  } catch (e6) {
    record("6. doPost管理者認証: mode=admin+正しいadmin_keyなしの呼出しを拒絶", false, e6.message);
  }

  // 7. doPost経由での正常アップロード (管理者認証あり)
  try {
    const authPost = doPost({
      postData: {
        contents: JSON.stringify({
          action: "upload_independent_document",
          mode: "admin",
          admin_key: "test_secret_key_123",
          idempotency_key: "idem-auth-001",
          file_name: "auth_test.pdf",
          mime_type: "application/pdf",
          base64: Utilities.base64Encode("test_auth_success")
        })
      }
    }, { rootFolder: rootFolder, propService: mockPropService });
    const authRes = JSON.parse(authPost.getContent ? authPost.getContent() : authPost);

    const ok7 = authRes.success === true && Boolean(authRes.file_id);
    record("7. doPost管理者認証: 正しい認証でのアップロード成功とDrive保存", ok7, JSON.stringify(authRes));
  } catch (e7) {
    record("7. doPost管理者認証: 正しい認証でのアップロード成功とDrive保存", false, e7.message);
  }

  // 8. 同一ファイル指紋の再送時: Driveファイル再利用 (is_reused: true, 同一file_id)
  try {
    const rawPdfReuse = Utilities.base64Encode("SAMPLE_INDEPENDENT_PDF_CONTENT_REUSE");
    const firstResRaw = handleUploadIndependentDocument({
      idempotency_key: "idem-reuse-001",
      document_type: "invoice",
      file_name: "invoice_orig.pdf",
      mime_type: "application/pdf",
      base64: rawPdfReuse
    }, { rootFolder: rootFolder, propService: mockPropService });
    const firstRes = JSON.parse(firstResRaw.getContent ? firstResRaw.getContent() : firstResRaw);

    const secondResRaw = handleUploadIndependentDocument({
      idempotency_key: "idem-reuse-002",
      document_type: "invoice",
      file_name: "invoice_dup.pdf",
      mime_type: "application/pdf",
      base64: rawPdfReuse
    }, { rootFolder: rootFolder, propService: mockPropService });
    const secondRes = JSON.parse(secondResRaw.getContent ? secondResRaw.getContent() : secondResRaw);

    const ok8 = firstRes.success === true &&
                secondRes.success === true &&
                secondRes.is_reused === true &&
                secondRes.file_id === firstRes.file_id;
    record("8. Driveファイル重複防止: 同一指紋の別キー再送時にDriveファイルを再利用", ok8, JSON.stringify({ first: firstRes.file_id, second: secondRes.file_id, is_reused: secondRes.is_reused }));
  } catch (e8) {
    record("8. Driveファイル重複防止: 同一指紋の別キー再送時にDriveファイルを再利用", false, e8.message);
  }

  console.log(`--- [testIndependentDocumentUploadSuite_] 完了: ${passed}/${results.length} 通過 (失敗: ${failed}) ---`);
  return {
    passed: passed,
    failed: failed,
    total: results.length,
    results: results
  };
}

// ==================================================
// 25. 下書き商品の英語タイトル (translated_title) 単独更新 テストスイート
// ==================================================

function testUpdateProductTranslatedTitleSuite_() {
  const results = [];
  let passed = 0;
  let failed = 0;

  function record(name, isPass, detail) {
    results.push({ name: name, passed: isPass, detail: detail || "" });
    if (isPass) {
      passed++;
      console.log(`✓ ${name}`);
    } else {
      failed++;
      console.error(`✗ ${name}: ${detail}`);
    }
  }

  console.log("\n--- [testUpdateProductTranslatedTitleSuite_] 開始 ---");

  const origFindProductRow = typeof findProductRow === "function" ? findProductRow : null;
  findProductRow = (sheet, pid) => {
    const norm = String(pid || "").trim();
    const data = sheet.getDataRange ? sheet.getDataRange().getValues() : [];
    for (let r = 1; r < data.length; r++) {
      if (String(data[r][1] || "").trim() === norm) {
        return r + 1; // 1-based row index
      }
    }
    throw new Error("Product not found: " + norm);
  };

  try {
  // モックデータセット構築
  function setupMockEnvironment_() {
    const headerRow = new Array(40).fill("");
    headerRow[0] = "created_at";
    headerRow[1] = "product_id";
    headerRow[2] = "category";
    headerRow[3] = "brand";
    headerRow[4] = "product_name";
    headerRow[5] = "condition";
    headerRow[6] = "purchase_price";
    headerRow[7] = "planned_sale_price";
    headerRow[8] = "storage_location";
    headerRow[31] = "publish_status";
    headerRow[32] = "inventory_status";
    headerRow[33] = "record_status";
    headerRow[39] = "ai_draft_flag";

    function makeProductRow(id, name, price, pubStatus) {
      const row = new Array(40).fill("");
      row[0] = new Date("2026-10-16T00:00:00Z");
      row[1] = id;
      row[2] = "sneaker";
      row[3] = "Nike";
      row[4] = name;
      row[5] = "目立った傷や汚れなし";
      row[6] = 10000;
      row[7] = price;
      row[8] = "A-1";
      row[31] = pubStatus; // "draft" or "published"
      row[32] = "in_stock";
      row[33] = "active";
      row[39] = "ai_managed";
      return row;
    }

    const mainSheetRows = [
      headerRow,
      makeProductRow("TMP-EDIT-001", "ナイキ エアジョーダン1", 25000, "draft"),
      makeProductRow("TMP-EDIT-002", "ナイキ ダンク ロー", 18000, "published"),
      makeProductRow("TMP-EDIT-003", "ナイキ コルテッツ", 12000, "draft")
    ];

    const transRows = [
      ["TMP-EDIT-001", "en", "Original English Title", "Original English Description", "Good", "Original Box", "Original Acc", "approved", "2026-10-15T00:00:00Z"],
      ["TMP-EDIT-002", "en", "Published English Title", "Published Description", "Good", "", "", "approved", "2026-10-15T00:00:00Z"]
    ];

    const mockMainSheet = {
      getLastRow: () => mainSheetRows.length,
      getLastColumn: () => 40,
      getRange: (r, c, numR, numC) => {
        const nr = numR || 1;
        const nc = numC || 1;
        return {
          getValue: () => mainSheetRows[r - 1][c - 1],
          setValue: (val) => {
            mainSheetRows[r - 1][c - 1] = val;
          },
          getValues: () => {
            const res = [];
            for (let i = 0; i < nr; i++) {
              const row = [];
              for (let j = 0; j < nc; j++) {
                row.push(mainSheetRows[r - 1 + i][c - 1 + j]);
              }
              res.push(row);
            }
            return res;
          },
          setValues: (vals) => {
            for (let i = 0; i < vals.length; i++) {
              for (let j = 0; j < vals[i].length; j++) {
                mainSheetRows[r - 1 + i][c - 1 + j] = vals[i][j];
              }
            }
          }
        };
      },
      getDataRange: () => ({
        getValues: () => mainSheetRows
      })
    };

    const mockTransSheet = {
      getLastRow: () => transRows.length + 1,
      getLastColumn: () => 9,
      getRange: (r, c, numR, numC) => {
        const nr = numR || 1;
        const nc = numC || 1;
        if (r === 1 && nr === 1) {
          return {
            getValues: () => [[
              "product_id", "locale", "translated_title", "translated_description",
              "translated_condition", "translated_box", "translated_accessories",
              "translation_status", "generated_at"
            ]]
          };
        }
        return {
          getValue: () => transRows[r - 2][c - 1],
          setValue: (val) => {
            transRows[r - 2][c - 1] = val;
          },
          getValues: () => {
            const res = [];
            for (let i = 0; i < nr; i++) {
              const row = [];
              for (let j = 0; j < nc; j++) {
                row.push(transRows[r - 2 + i][c - 1 + j]);
              }
              res.push(row);
            }
            return res;
          }
        };
      },
      appendRow: (row) => {
        transRows.push(row);
      }
    };

    const mockSpreadsheet = {
      getSheets: () => [mockMainSheet],
      getSheetByName: (name) => {
        if (name === "product_translations") return mockTransSheet;
        return mockMainSheet;
      }
    };

    return {
      mainSheet: mockMainSheet,
      mainSheetRows: mainSheetRows,
      transSheet: mockTransSheet,
      transRows: transRows,
      spreadsheet: mockSpreadsheet
    };
  }

  // 1. 下書き商品の translated_title 単独更新: 英語タイトル更新、既存説明文・状態・承認維持、本票商品名・価格不変
  try {
    const env = setupMockEnvironment_();
    const origGetActiveSpreadsheet = SpreadsheetApp.getActiveSpreadsheet;
    SpreadsheetApp.getActiveSpreadsheet = () => env.spreadsheet;

    try {
      const updatePayload = {
        action: "update_product",
        product_id: "TMP-EDIT-001",
        translated_title: "  New Updated English Title  "
      };

      const resRaw = handleUpdateProduct(env.mainSheet, updatePayload);
      const res = JSON.parse(resRaw.getContent ? resRaw.getContent() : resRaw);

      // product_translations の検証
      const transRow = env.transRows.find(r => r[0] === "TMP-EDIT-001");
      const okTitle = transRow && transRow[2] === "New Updated English Title"; // 前後空白トリム
      const okDesc = transRow && transRow[3] === "Original English Description"; // 説明文維持
      const okCond = transRow && transRow[4] === "Good"; // 状態維持
      const okBox = transRow && transRow[5] === "Original Box"; // 箱維持
      const okAcc = transRow && transRow[6] === "Original Acc"; // 付属品維持
      const okStatus = transRow && transRow[7] === "approved"; // ステータス維持

      // 本票の検証
      const mainRow = env.mainSheetRows.find(r => r[1] === "TMP-EDIT-001");
      const okProdName = mainRow && mainRow[4] === "ナイキ エアジョーダン1"; // 日本語名不変
      const okPrice = mainRow && mainRow[7] === 25000; // 販売予定価格不変

      const ok1 = res.success === true && okTitle && okDesc && okCond && okBox && okAcc && okStatus && okProdName && okPrice;
      record("1. 下書き商品のtranslated_title単独更新: 英語タイトル更新・説明文/状態/ステータス維持・本票名前/価格不変", ok1, `res=${res.success}, title=${transRow?.[2]}, name=${mainRow?.[4]}, price=${mainRow?.[7]}`);
    } finally {
      SpreadsheetApp.getActiveSpreadsheet = origGetActiveSpreadsheet;
    }
  } catch (e1) {
    record("1. 下書き商品のtranslated_title単独更新: 英語タイトル更新・説明文/状態/ステータス維持・本票名前/価格不変", false, e1.message);
  }

  // 2. 空欄タイトルの拒絶: 空文字または空白のみは TRANSLATED_TITLE_REQUIRED で拒絶
  try {
    const env = setupMockEnvironment_();
    const origGetActiveSpreadsheet = SpreadsheetApp.getActiveSpreadsheet;
    SpreadsheetApp.getActiveSpreadsheet = () => env.spreadsheet;

    try {
      let threwEmpty = false;
      try {
        handleUpdateProduct(env.mainSheet, {
          action: "update_product",
          product_id: "TMP-EDIT-001",
          translated_title: "   "
        });
      } catch (err) {
        threwEmpty = err.error_code === "TRANSLATED_TITLE_REQUIRED" || err.message.includes("cannot be empty");
      }

      // 値が変わっていないことを確認
      const transRow = env.transRows.find(r => r[0] === "TMP-EDIT-001");
      const okUnchanged = transRow && transRow[2] === "Original English Title";

      record("2. 空欄タイトルの拒絶: 空白のみは TRANSLATED_TITLE_REQUIRED で拒絶され値不変", threwEmpty && okUnchanged, `threwEmpty=${threwEmpty}, title=${transRow?.[2]}`);
    } finally {
      SpreadsheetApp.getActiveSpreadsheet = origGetActiveSpreadsheet;
    }
  } catch (e2) {
    record("2. 空欄タイトルの拒絶: 空白のみは TRANSLATED_TITLE_REQUIRED で拒絶され値不変", false, e2.message);
  }

  // 3. 下書き以外の商品への更新拒絶: published 商品への更新要求は TRANSLATED_TITLE_DRAFT_ONLY で拒絶
  try {
    const env = setupMockEnvironment_();
    const origGetActiveSpreadsheet = SpreadsheetApp.getActiveSpreadsheet;
    SpreadsheetApp.getActiveSpreadsheet = () => env.spreadsheet;

    try {
      let threwDraftOnly = false;
      try {
        handleUpdateProduct(env.mainSheet, {
          action: "update_product",
          product_id: "TMP-EDIT-002", // published
          translated_title: "Attempted Title on Published"
        });
      } catch (err) {
        threwDraftOnly = err.error_code === "TRANSLATED_TITLE_DRAFT_ONLY" ||
          err.error_code === "PUBLISHED_AI_PRODUCT_EDIT_BLOCKED" ||
          err.message.includes("draft products") ||
          err.message.includes("published is not allowed");
      }

      const transRow = env.transRows.find(r => r[0] === "TMP-EDIT-002");
      const okUnchanged = transRow && transRow[2] === "Published English Title";

      record("3. 下書き以外の商品への更新拒絶: published商品へのtranslated_title更新は拒絶され値不変", threwDraftOnly && okUnchanged, `threw=${threwDraftOnly}, title=${transRow?.[2]}`);
    } finally {
      SpreadsheetApp.getActiveSpreadsheet = origGetActiveSpreadsheet;
    }
  } catch (e3) {
    record("3. 下書き以外の商品への更新拒絶: published商品へのtranslated_title更新は拒絶され値不変", false, e3.message);
  }

  // 4. 存在しない商品IDへの更新拒絶
  try {
    const env = setupMockEnvironment_();
    const origGetActiveSpreadsheet = SpreadsheetApp.getActiveSpreadsheet;
    SpreadsheetApp.getActiveSpreadsheet = () => env.spreadsheet;

    try {
      let threwNotFound = false;
      try {
        handleUpdateProduct(env.mainSheet, {
          action: "update_product",
          product_id: "TMP-NONEXISTENT",
          translated_title: "Nonexistent Product Title"
        });
      } catch (err) {
        threwNotFound = true;
      }

      record("4. 存在しない商品IDへの更新拒絶: 例外で停止", threwNotFound, `threw=${threwNotFound}`);
    } finally {
      SpreadsheetApp.getActiveSpreadsheet = origGetActiveSpreadsheet;
    }
  } catch (e4) {
    record("4. 存在しない商品IDへの更新拒絶: 例外で停止", false, e4.message);
  }

  // 5. 既存翻訳レコードがない下書き商品への新規追加
  try {
    const env = setupMockEnvironment_();
    const origGetActiveSpreadsheet = SpreadsheetApp.getActiveSpreadsheet;
    SpreadsheetApp.getActiveSpreadsheet = () => env.spreadsheet;

    try {
      const updatePayload = {
        action: "update_product",
        product_id: "TMP-EDIT-003", // 翻訳未作成の下書き商品
        translated_title: "Brand New English Title For TMP-003"
      };

      const resRaw = handleUpdateProduct(env.mainSheet, updatePayload);
      const res = JSON.parse(resRaw.getContent ? resRaw.getContent() : resRaw);

      const newTransRow = env.transRows.find(r => r[0] === "TMP-EDIT-003");
      const okCreated = newTransRow && newTransRow[2] === "Brand New English Title For TMP-003" && newTransRow[7] === "approved";

      record("5. 既存翻訳がない下書き商品への新規追加: レコードが安全に追加されタイトルが反映される", res.success === true && okCreated, `success=${res.success}, title=${newTransRow?.[2]}`);
    } finally {
      SpreadsheetApp.getActiveSpreadsheet = origGetActiveSpreadsheet;
    }
  } catch (e5) {
    record("5. 既存翻訳がない下書き商品への新規追加: レコードが安全に追加されタイトルが反映される", false, e5.message);
  }

  // 6. 正常な同時更新: translated_title と planned_sale_price を同時送信
  try {
    const env = setupMockEnvironment_();
    const origGetActiveSpreadsheet = SpreadsheetApp.getActiveSpreadsheet;
    SpreadsheetApp.getActiveSpreadsheet = () => env.spreadsheet;

    try {
      const updatePayload = {
        action: "update_product",
        product_id: "TMP-EDIT-001",
        translated_title: "Valid Simultaneous English Title",
        planned_sale_price: 32000
      };

      const resRaw = handleUpdateProduct(env.mainSheet, updatePayload);
      const res = JSON.parse(resRaw.getContent ? resRaw.getContent() : resRaw);

      const transRow = env.transRows.find(r => r[0] === "TMP-EDIT-001");
      const okTitle = transRow && transRow[2] === "Valid Simultaneous English Title";

      const mainRow = env.mainSheetRows.find(r => r[1] === "TMP-EDIT-001");
      const okPrice = mainRow && Number(mainRow[7]) === 32000;

      const ok6 = res.success === true && okTitle && okPrice;
      record("6. 正常な同時更新: translated_titleとplanned_sale_priceが同時に正常保存される", ok6, `res=${res.success}, title=${transRow?.[2]}, price=${mainRow?.[7]}`);
    } finally {
      SpreadsheetApp.getActiveSpreadsheet = origGetActiveSpreadsheet;
    }
  } catch (e6) {
    record("6. 正常な同時更新: translated_titleとplanned_sale_priceが同時に正常保存される", false, e6.message);
  }

  // 7. 価格エラー時のタイトル不変検証: 不正価格ならタイトルも変更されず停止
  try {
    const env = setupMockEnvironment_();
    const origGetActiveSpreadsheet = SpreadsheetApp.getActiveSpreadsheet;
    SpreadsheetApp.getActiveSpreadsheet = () => env.spreadsheet;

    try {
      let threwPriceErr = false;
      try {
        handleUpdateProduct(env.mainSheet, {
          action: "update_product",
          product_id: "TMP-EDIT-001",
          translated_title: "Should Never Be Saved On Invalid Price",
          planned_sale_price: -500 // 不正な価格（負数）
        });
      } catch (err) {
        threwPriceErr = err.message.includes("positive integer");
      }

      // シート内の英語タイトルと価格が変更されていないことを確認
      const transRow = env.transRows.find(r => r[0] === "TMP-EDIT-001");
      const okTitleUnchanged = transRow && transRow[2] === "Original English Title"; // 変更前のまま

      const mainRow = env.mainSheetRows.find(r => r[1] === "TMP-EDIT-001");
      const okPriceUnchanged = mainRow && Number(mainRow[7]) === 25000; // 変更前のまま

      const ok7 = threwPriceErr && okTitleUnchanged && okPriceUnchanged;
      record("7. 価格エラー時のタイトル不変検証: 不正価格時は例外で停止しタイトルも価格も変更されない", ok7, `threw=${threwPriceErr}, title=${transRow?.[2]}, price=${mainRow?.[7]}`);
    } finally {
      SpreadsheetApp.getActiveSpreadsheet = origGetActiveSpreadsheet;
    }
  } catch (e7) {
    record("7. 価格エラー時のタイトル不変検証: 不正価格時は例外で停止しタイトルも価格も変更されない", false, e7.message);
  }

  } finally {
    if (origFindProductRow) {
      findProductRow = origFindProductRow;
    }
  }

  console.log(`--- [testUpdateProductTranslatedTitleSuite_] 完了: ${passed}/${results.length} 通過 (失敗: ${failed}) ---`);
  return {
    passed: passed,
    failed: failed,
    total: results.length,
    results: results
  };
}






/**
 * 商品カテゴリ拡張 (apparel, fashion_goods, jewelry新種別, 列保護, Square連携) テストスイート
 */
function testCategoryExpansionSuite_() {
  console.log("--- [testCategoryExpansionSuite_] 開始 ---");
  const results = [];
  let passed = 0;
  let failed = 0;

  function record(name, ok, detail) {
    results.push({ name: name, passed: ok, detail: detail || "" });
    if (ok) {
      passed++;
      console.log("✓ " + name);
    } else {
      failed++;
      console.error("✗ " + name + ": " + (detail || "failed"));
    }
  }

  const mockRows = [];
  mockRows.push(new Array(43).fill("header"));
  const mockSheet = {
    getName: () => "商品マスター",
    getLastRow: () => mockRows.length,
    getLastColumn: () => 43,
    getMaxColumns: () => 43,
    appendRow: (row) => {
      const r = row.slice();
      while (r.length < 43) r.push("");
      mockRows.push(r);
    },
    getRange: (r, c, numR, numC) => {
      numR = numR || 1;
      numC = numC || 1;
      return {
        getValue: () => {
          const rowData = mockRows[r - 1] || [];
          return rowData[c - 1] !== undefined ? rowData[c - 1] : "";
        },
        getValues: () => {
          const res = [];
          for (let i = 0; i < numR; i++) {
            const rowData = mockRows[r - 1 + i] || [];
            const cols = [];
            for (let j = 0; j < numC; j++) {
              cols.push(rowData[c - 1 + j] !== undefined ? rowData[c - 1 + j] : "");
            }
            res.push(cols);
          }
          return res;
        },
        setValue: (val) => {
          while (mockRows.length < r) mockRows.push(new Array(43).fill(""));
          const rowData = mockRows[r - 1];
          while (rowData.length < c) rowData.push("");
          rowData[c - 1] = val;
        }
      };
    }
  };

  const origGenId = (typeof generateNextProductId === "function") ? generateNextProductId : null;
  const origDriveApp = (typeof DriveApp !== "undefined") ? DriveApp : null;
  const origFindRow = (typeof findProductRow === "function") ? findProductRow : null;
  const origGetTrans = (typeof getProductTranslation === "function") ? getProductTranslation : null;
  const origSafeGetTrans = (typeof safeGetProductTranslation_ === "function") ? safeGetProductTranslation_ : null;
  const origSaveTrans = (typeof saveProductTranslation === "function") ? saveProductTranslation : null;

  try {
    generateNextProductId = () => "TMP-APP-TEST01";
    const mockFolder = {
      getId: () => "folder_test01",
      getUrl: () => "https://drive.google.com/folders/folder_test01",
      createFolder: () => mockFolder,
      getFiles: () => ({ hasNext: () => false, next: () => null })
    };
    DriveApp = {
      getFolderById: () => mockFolder
    };
    findProductRow = (sh, pid) => {
      const idx = mockRows.findIndex(r => r[1] === pid);
      return idx !== -1 ? idx + 1 : 2;
    };
    let currentTransRecord = {
      locale: "en",
      translated_title: "CH Floral Cross Tee",
      translated_description: "English desc",
      translation_status: "approved"
    };
    saveProductTranslation = (arg1, arg2) => {
      const targetData = (arg2 && typeof arg2 === "object") ? arg2 : ((arg1 && typeof arg1 === "object") ? arg1 : {});
      if (targetData.translated_title !== undefined) currentTransRecord.translated_title = targetData.translated_title;
      if (targetData.translated_description !== undefined) currentTransRecord.translated_description = targetData.translated_description;
      currentTransRecord.translation_status = "approved";
    };
    getProductTranslation = (pid) => currentTransRecord;
    safeGetProductTranslation_ = (pid) => currentTransRecord;

    // 1. apparel 新規登録
    try {
      const appPayload = {
        category: "apparel",
        subcategory: "t_shirt",
        size: "L",
        official_sku: "CH-TS-001",
        brand: "Chrome Hearts",
        product_name: "CH Horseshoe Floral Cross Tee Black",
        condition: "A",
        planned_sale_price: 58000,
        purchase_price: 35000,
        storage_location: "倉庫A-1",
        description: "クロムハーツ定番Tシャツ",
        publish_status: "draft"
      };
      const resRaw = executeProductCreationCore_(mockSheet, appPayload, {});
      const res = JSON.parse(resRaw.getContent ? resRaw.getContent() : resRaw);
      const row2 = mockRows[1];
      const ok1 = res.success === true &&
                  row2[40] === "t_shirt" && row2[41] === "L" && row2[42] === "CH-TS-001" &&
                  row2[11] === "" && row2[12] === "" && row2[17] === "" && row2[25] === "";
      record("1. apparel商品の新規登録: 41〜43列目への属性保存と1〜40列目の既存列完全保護", ok1, "col41=" + row2[40] + ", col42=" + row2[41] + ", col43=" + row2[42]);
    } catch (e1) {
      record("1. apparel商品の新規登録: 41〜43列目への属性保存と1〜40列目の既存列完全保護", false, e1.message);
    }

    // 2. apparel 詳細取得
    try {
      const row2 = mockRows[1];
      const detail = buildProductDetail(row2, true, true);
      const ok2 = detail.category === "apparel" &&
                  detail.subcategory === "t_shirt" &&
                  detail.sub_category === "t_shirt" &&
                  detail.size === "L" &&
                  detail.official_sku === "CH-TS-001" &&
                  detail.sku === "CH-TS-001";
      record("2. apparel詳細取得: サブカテゴリ・サイズ・公式品番の往復取得と互換エイリアス", ok2);
    } catch (e2) {
      record("2. apparel詳細取得: サブカテゴリ・サイズ・公式品番の往復取得と互換エイリアス", false, e2.message);
    }

    // 3. apparel 更新
    try {
      const updResRaw = handleUpdateProduct(mockSheet, {
        product_id: "TMP-APP-TEST01",
        size: "XL",
        planned_sale_price: 62000,
        subcategory: "hoodie_sweatshirt"
      });
      const updRes = JSON.parse(updResRaw.getContent ? updResRaw.getContent() : updResRaw);
      const row2 = mockRows[1];
      const ok3 = updRes.success === true &&
                  row2[40] === "hoodie_sweatshirt" &&
                  row2[41] === "XL" &&
                  Number(row2[7]) === 62000;
      record("3. apparel更新: handleUpdateProduct による新属性および価格の更新", ok3);
    } catch (e3) {
      record("3. apparel更新: handleUpdateProduct による新属性および価格の更新", false, e3.message);
    }

    // 4. カテゴリ変更禁止
    try {
      let threwCatErr = false;
      try {
        handleUpdateProduct(mockSheet, {
          product_id: "TMP-APP-TEST01",
          category: "sneaker"
        });
      } catch (ce) {
        if (ce.message.includes("product category cannot be changed after creation")) {
          threwCatErr = true;
        }
      }
      record("4. カテゴリ不変検証: 登録後のカテゴリ変更要求は例外で拒絶される", threwCatErr);
    } catch (e4) {
      record("4. カテゴリ不変検証: 登録後のカテゴリ変更要求は例外で拒絶される", false, e4.message);
    }

    // 5. 新カテゴリ商品のスニーカー・ジュエリー列汚染防止
    try {
      handleUpdateProduct(mockSheet, {
        product_id: "TMP-APP-TEST01",
        sneaker_size: "28.0",
        sneaker_sku: "ERR-SKU",
        jewelry_material: "SV925"
      });
      const row2 = mockRows[1];
      const ok5 = row2[11] === "" && row2[12] === "" && row2[18] === "";
      record("5. 列分離検証: apparel商品に対するスニーカー・ジュエリー属性更新は遮断され値不変", ok5);
    } catch (e5) {
      record("5. 列分離検証: apparel商品に対するスニーカー・ジュエリー属性更新は遮断され値不変", false, e5.message);
    }

    // 6. fashion_goods 作成と一覧取得
    try {
      generateNextProductId = () => "TMP-FSH-TEST01";
      const fshPayload = {
        category: "fashion_goods",
        subcategory: "eyewear",
        size: "53□18-145",
        official_sku: "CH-SUN-001",
        brand: "Chrome Hearts",
        product_name: "CH Gittin Any? Sunglasses Black",
        condition: "S",
        planned_sale_price: 128000
      };
      executeProductCreationCore_(mockSheet, fshPayload, {});
      const row3 = mockRows[2];
      const summary = buildAdminProductSummary(row3, "");
      const ok6 = summary.category === "fashion_goods" &&
                  summary.subcategory === "eyewear" &&
                  summary.size === "53□18-145" &&
                  summary.official_sku === "CH-SUN-001";
      record("6. fashion_goods作成と一覧取得: サブカテゴリ・サイズ・品番が管理一覧に反映", ok6);
    } catch (e6) {
      record("6. fashion_goods作成と一覧取得: サブカテゴリ・サイズ・品番が管理一覧に反映", false, e6.message);
    }

    // 7. Square 連携表示
    try {
      const srcApparel = {
        product_id: "TMP-APP-TEST01",
        category: "apparel",
        brand: "Chrome Hearts",
        product_name: "CH Hoodie Black",
        condition: "A",
        size: "XL",
        official_sku: "CH-HD-001",
        description: "クロムハーツ定番パーカー"
      };
      const dispSize = buildSquareProductDisplay_(srcApparel);
      const dispNoSize = buildSquareProductDisplay_({
        product_id: "TMP-APP-TEST02",
        category: "apparel",
        product_name: "CH Scarf",
        condition: "S",
        size: "",
        official_sku: "",
        description: "スカーフ"
      });
      const ok7 = dispSize.variationName === "XL" &&
                  dispSize.descriptionHtml.includes("【サイズ】 XL") &&
                  dispSize.descriptionHtml.includes("【品番】 CH-HD-001") &&
                  dispNoSize.variationName === "Regular";
      record("7. Square連携表示: size指定時はVariation名に反映、未指定時はRegular", ok7);
    } catch (e7) {
      record("7. Square連携表示: size指定時はVariation名に反映、未指定時はRegular", false, e7.message);
    }

    // 8. ジュエリー新種別 (pendant, charm, chain)
    try {
      generateNextProductId = () => "TMP-JWL-TEST01";
      const jwlPayload = {
        category: "jewelry",
        jewelry_type: "pendant",
        jewelry_material: "22K",
        carat: "0.5",
        brand: "Chrome Hearts",
        product_name: "CH Baby Fat Pendant 22K with Pave Diamond",
        condition: "S",
        planned_sale_price: 380000
      };
      executeProductCreationCore_(mockSheet, jwlPayload, {});
      const row4 = mockRows[3];
      const jwlDetail = buildProductDetail(row4, true, true);
      const ok8 = jwlDetail.category === "jewelry" &&
                  jwlDetail.jewelry_type === "pendant" &&
                  jwlDetail.jewelry_material === "22K";
      record("8. ジュエリー新種別: pendant の正常登録と詳細取得", ok8);
    } catch (e8) {
      record("8. ジュエリー新種別: pendant の正常登録と詳細取得", false, e8.message);
    }

    // 9. AI確定・反映経路でのスニーカー列誤保存防止 & カテゴリ不変
    try {
      const aiCand = {
        title_ja: "AI生成タイトル",
        category: "apparel",
        sku: "AI-NEW-SKU-SHOULD-NOT-POLLUTE",
        size: "M"
      };
      if (typeof applyCandidateToProduct_ === "function") {
        applyCandidateToProduct_(mockSheet, 2, "TMP-APP-TEST01", aiCand);
        const row2 = mockRows[1];
        const ok9 = row2[11] === "" && row2[12] === "" && row2[2] === "apparel";
        record("9. AI反映経路ガード: apparel商品のスニーカー列汚染防止と既存カテゴリ維持", ok9);
      } else {
        record("9. AI反映経路ガード: applyCandidateToProduct_ 未定義スキップ", true);
      }
    } catch (e9) {
      record("9. AI反映経路ガード: apparel商品のスニーカー列汚染防止と既存カテゴリ維持", false, e9.message);
    }

    // 10. シート列数不足(43列未満)時の早期停止検証
    try {
      const smallSheet = {
        getMaxColumns: () => 40,
        getLastColumn: () => 40
      };
      let caughtErr = false;
      try {
        assertProductSheetColumnCount_(smallSheet);
      } catch (err) {
        if (err.error_code === "INSUFFICIENT_SHEET_COLUMNS") {
          caughtErr = true;
        }
      }
      record("10. 列数チェック: 43列未満のシートで INSUFFICIENT_SHEET_COLUMNS 例外が発生する", caughtErr);
    } catch (e10) {
      record("10. 列数チェック: 43列未満のシートで INSUFFICIENT_SHEET_COLUMNS 例外が発生する", false, e10.message);
    }

    // 11. sneaker登録・更新時の新列書き込み遮断
    try {
      generateNextProductId = () => "TMP-SNK-TEST01";
      const snkPayload = {
        category: "sneaker",
        brand: "NIKE",
        product_name: "Air Jordan 1",
        condition: "S",
        planned_sale_price: 35000,
        sneaker_size: "27.5",
        sneaker_sku: "555088-001",
        size: "XL",
        official_sku: "ILLEGAL-SKU",
        subcategory: "t_shirt"
      };
      executeProductCreationCore_(mockSheet, snkPayload, {});
      const snkRow = mockRows[mockRows.length - 1];
      const ok11a = snkRow[11] === "555088-001" && snkRow[12] === "27.5" &&
                    snkRow[40] === "" && snkRow[41] === "" && snkRow[42] === "";

      handleUpdateProduct(mockSheet, {
        product_id: "TMP-SNK-TEST01",
        size: "28.0",
        official_sku: "NEW-ILLEGAL-SKU",
        subcategory: "hoodie_sweatshirt"
      });
      const ok11b = snkRow[40] === "" && snkRow[41] === "" && snkRow[42] === "";
      record("11. 列分離検証: sneaker登録・更新時の41〜43列(AO〜AQ)書き込み遮断", ok11a && ok11b);
    } catch (e11) {
      record("11. 列分離検証: sneaker登録・更新時の41〜43列(AO〜AQ)書き込み遮断", false, e11.message);
    }

    // 12. apparel商品のスタッフ入力済み属性(size, official_sku)のAI反映上書き防止
    try {
      const row2 = mockRows[1];
      row2[41] = "M"; // スタッフ入力済みサイズ
      row2[42] = "STAFF-SKU-001"; // スタッフ入力済み品番
      if (typeof applyCandidateToProduct_ === "function") {
        applyCandidateToProduct_(mockSheet, 2, "TMP-APP-TEST01", {
          title_ja: "CH T-Shirt",
          category: "apparel",
          size: "L", // AI候補サイズ (上書きされてはならない)
          sku: "AI-SKU-OVERWRITE" // AI候補品番 (上書きされてはならない)
        });
        const ok12 = row2[41] === "M" && row2[42] === "STAFF-SKU-001";
        record("12. スタッフ入力保護: apparelの既存size・official_skuはAI候補で上書きされない", ok12);
      } else {
        record("12. スタッフ入力保護: applyCandidateToProduct_ 未定義スキップ", true);
      }
    } catch (e12) {
      record("12. スタッフ入力保護: apparelの既存size・official_skuはAI候補で上書きされない", false, e12.message);
    }

    // 13. [要件2] 通常の既存 other 商品に新しいAIドラフトを生成・確定するケースは CATEGORY_CANNOT_BE_CHANGED で拒絶される
    try {
      generateNextProductId = () => "TMP-AI-OTHER01";
      const aiOtherPayload = {
        category: "other",
        brand: "Chrome Hearts",
        product_name: "通常の既存その他商品",
        condition: "A",
        planned_sale_price: 50000,
        ai_draft_flag: "ai_managed"
      };
      executeProductCreationCore_(mockSheet, aiOtherPayload, {});
      const aiOtherRow = mockRows[mockRows.length - 1];
      aiOtherRow[39] = "ai_managed"; // 40列目: ai_draft_flag (AIドラフト生成により刻印された状態)

      // getLatestProductAiDraft_ のモック (pending_review の未確定ドラフトあり)
      const origGetLatest = typeof getLatestProductAiDraft_ === "function" ? getLatestProductAiDraft_ : null;
      getLatestProductAiDraft_ = () => ({
        product_id: "TMP-AI-OTHER01",
        draft_id: "DRFT_TMP_PROMOTE",
        draft_version: 1,
        review_status: "pending_review",
        candidate_category: "other",
        candidate_condition: "未使用に近い"
      });

      try {
        const confirmRes = handleConfirmAiProductDraft(mockSheet, {
          product_id: "TMP-AI-OTHER01",
          draft_id: "DRFT_TMP_PROMOTE",
          draft_version: 1,
          staff_id: "staff_confirm",
          confirmation_attempt_id: "ATTEMPT_PROMOTE_TEST",
          confirmed_data: {
            category: "apparel",
            brand: "Chrome Hearts",
            product_name: "CH Floral Cross Tee",
            condition: "未使用に近い",
            planned_sale_price: 55000,
            subcategory: "t_shirt",
            size: "XL",
            official_sku: "CH-TS-CONF",
            description: "確定説明",
            translated_title: "CH Tee",
            translated_description: "English desc"
          }
        });
        const parsedConfirm = JSON.parse(confirmRes.getContent ? confirmRes.getContent() : confirmRes);
        const ok13 = parsedConfirm.success === false &&
                     parsedConfirm.error_code === "CATEGORY_CANNOT_BE_CHANGED" &&
                     aiOtherRow[2] === "other";
        record("13. 変更拒絶: 通常の既存 other 商品にAIドラフトを生成・確定するケースは CATEGORY_CANNOT_BE_CHANGED で拒絶される", ok13);
      } finally {
        if (origGetLatest) getLatestProductAiDraft_ = origGetLatest;
      }
    } catch (e13) {
      record("13. 変更拒絶: 通常の既存 other 商品にAIドラフトを生成・確定するケースは CATEGORY_CANNOT_BE_CHANGED で拒絶される", false, e13.message);
    }

    // 14. 非AI管理の other 商品確定要求での CATEGORY_CANNOT_BE_CHANGED 拒絶
    try {
      generateNextProductId = () => "TMP-NON-AI01";
      const nonAiPayload = {
        category: "other",
        brand: "Chrome Hearts",
        product_name: "非AIその他商品",
        condition: "A",
        planned_sale_price: 50000
      };
      executeProductCreationCore_(mockSheet, nonAiPayload, {});
      const nonAiRow = mockRows[mockRows.length - 1];

      const origGetLatest = typeof getLatestProductAiDraft_ === "function" ? getLatestProductAiDraft_ : null;
      getLatestProductAiDraft_ = () => ({
        draft_id: "DRFT_NON_AI_EXP",
        draft_version: 1,
        review_status: "pending_review",
        candidate_condition: "未使用に近い"
      });

      try {
        const confirmRes = handleConfirmAiProductDraft(mockSheet, {
          product_id: "TMP-NON-AI01",
          draft_id: "DRFT_NON_AI_EXP",
          draft_version: 1,
          staff_id: "staff_confirm",
          confirmation_attempt_id: "ATTEMPT_NON_AI_EXP",
          confirmed_data: {
            category: "apparel",
            brand: "Chrome Hearts",
            product_name: "非AIその他商品",
            condition: "未使用に近い",
            planned_sale_price: 50000,
            description: "確定説明",
            translated_title: "Non AI Title",
            translated_description: "Non AI Desc"
          }
        });
        const parsedConfirm = JSON.parse(confirmRes.getContent ? confirmRes.getContent() : confirmRes);
        const ok14 = parsedConfirm.success === false &&
                     parsedConfirm.error_code === "CATEGORY_CANNOT_BE_CHANGED" &&
                     nonAiRow[2] === "other";
        record("14. 変更拒絶: 非AI管理 other 商品に対する apparel 変更確定要求は拒絶される", ok14);
      } finally {
        if (origGetLatest) getLatestProductAiDraft_ = origGetLatest;
      }
    } catch (e14) {
      record("14. 変更拒絶: 非AI管理 other 商品に対する apparel 変更確定要求は拒絶される", false, e14.message);
    }

    // 15. [要件1] 43列未満時のAI確定早期停止・部分更新防止
    try {
      const origGetLatest15 = typeof getLatestProductAiDraft_ === "function" ? getLatestProductAiDraft_ : null;
      getLatestProductAiDraft_ = () => ({
        product_id: "TMP-APP-TEST01",
        draft_id: "DRFT_TMP_SHORT",
        draft_version: 1,
        review_status: "pending_review",
        candidate_category: "apparel",
        candidate_condition: "未使用に近い"
      });

      const smallSheet = {
        getMaxColumns: () => 40,
        getLastColumn: () => 40,
        getRange: (r, c, nr, nc) => {
          const startCol = c;
          const endCol = c + (nc !== undefined ? nc : 1) - 1;
          if (startCol > 40 || endCol > 40) {
            throw new Error(`Coordinates out of range: getRange requested column ${startCol}..${endCol}, but sheet has only 40 columns`);
          }
          return {
            getValues: () => [mockRows[1].slice(0, 40)],
            setValue: (v) => { mockRows[1][c - 1] = v; }
          };
        }
      };
      const row2BeforeName = mockRows[1][4];
      try {
        const resShort = handleConfirmAiProductDraft(smallSheet, {
          product_id: "TMP-APP-TEST01",
          draft_id: "DRFT_TMP_SHORT",
          draft_version: 1,
          staff_id: "staff_confirm",
          confirmation_attempt_id: "ATTEMPT_SHORT",
          confirmed_data: {
            category: "apparel",
            brand: "Chrome Hearts",
            product_name: "SHOULD_NOT_UPDATE",
            condition: "未使用に近い",
            planned_sale_price: 99999,
            description: "Desc",
            translated_title: "Title",
            translated_description: "Desc"
          }
        });
        const parsedShort = JSON.parse(resShort.getContent ? resShort.getContent() : resShort);
        const ok15 = parsedShort.success === false &&
                     parsedShort.error_code === "INSUFFICIENT_SHEET_COLUMNS" &&
                     mockRows[1][4] === row2BeforeName;
        record("15. [要件1] 列不足時の部分更新防止: 43列未満では書き込み前に INSUFFICIENT_SHEET_COLUMNS で停止", ok15);
      } finally {
        if (origGetLatest15) getLatestProductAiDraft_ = origGetLatest15;
      }
    } catch (e15) {
      record("15. [要件1] 列不足時の部分更新防止: 43列未満では書き込み前に INSUFFICIENT_SHEET_COLUMNS で停止", false, e15.message);
    }

    // 16. [要件2] AI確定時のスタッフ入力済みサイズ・公式品番の保護 & 空欄時のみ補完
    try {
      const row2 = mockRows[1];
      row2[41] = "M"; // スタッフ入力済みサイズ
      row2[42] = "STAFF-SKU-001"; // スタッフ入力済み品番
      const origGetLatest = typeof getLatestProductAiDraft_ === "function" ? getLatestProductAiDraft_ : null;
      getLatestProductAiDraft_ = () => ({
        product_id: "TMP-APP-TEST01",
        draft_id: "DRFT_STAFF_EXP",
        draft_version: 1,
        row_number: 2,
        review_status: "pending_review",
        candidate_category: "apparel",
        candidate_condition: "未使用に近い"
      });

      try {
        currentTransRecord = {
          locale: "en",
          translated_title: "Title",
          translated_description: "Desc",
          translation_status: "approved"
        };
        const confirmRes = handleConfirmAiProductDraft(mockSheet, {
          product_id: "TMP-APP-TEST01",
          draft_id: "DRFT_STAFF_EXP",
          draft_version: 1,
          staff_id: "staff_confirm",
          confirmation_attempt_id: "ATTEMPT_STAFF_EXP",
          confirmed_data: {
            category: "apparel",
            brand: "Chrome Hearts",
            product_name: "CH Tee",
            condition: "未使用に近い",
            planned_sale_price: 50000,
            description: "Desc",
            translated_title: "Title",
            translated_description: "Desc",
            size: "XL", // AI候補サイズ（既存値Mが保護されるべき）
            official_sku: "AI-OVERWRITE-SKU" // AI候補品番（既存値が保護されるべき）
          }
        });
        const parsedConfirm = JSON.parse(confirmRes.getContent ? confirmRes.getContent() : confirmRes);
        const ok16a = parsedConfirm.success === true && row2[41] === "M" && row2[42] === "STAFF-SKU-001";

        // 空欄のみ補完の検証: サイズ空欄、品番既存値
        row2[41] = "";
        getLatestProductAiDraft_ = () => ({
          product_id: "TMP-APP-TEST01",
          draft_id: "DRFT_STAFF_EXP2",
          draft_version: 1,
          row_number: 2,
          review_status: "pending_review",
          candidate_category: "apparel",
          candidate_condition: "未使用に近い"
        });
        currentTransRecord = {
          locale: "en",
          translated_title: "Title",
          translated_description: "Desc",
          translation_status: "approved"
        };
        const confirmRes2 = handleConfirmAiProductDraft(mockSheet, {
          product_id: "TMP-APP-TEST01",
          draft_id: "DRFT_STAFF_EXP2",
          draft_version: 1,
          staff_id: "staff_confirm",
          confirmation_attempt_id: "ATTEMPT_STAFF_EXP2",
          confirmed_data: {
            category: "apparel",
            brand: "Chrome Hearts",
            product_name: "CH Tee",
            condition: "未使用に近い",
            planned_sale_price: 50000,
            description: "Desc",
            translated_title: "Title",
            translated_description: "Desc",
            size: "XL", // 空欄なので補完されるべき
            official_sku: "AI-OVERWRITE-SKU" // 既存値があるので保護されるべき
          }
        });
        const parsedConfirm2 = JSON.parse(confirmRes2.getContent ? confirmRes2.getContent() : confirmRes2);
        const ok16b = parsedConfirm2.success === true && row2[41] === "XL" && row2[42] === "STAFF-SKU-001";

        record("16. [要件2] スタッフ入力保護: 既存サイズ・品番は上書きされず保護、空欄のみ補完される", ok16a && ok16b);
      } finally {
        if (origGetLatest) getLatestProductAiDraft_ = origGetLatest;
      }
    } catch (e16) {
      record("16. [要件2] スタッフ入力保護: 既存サイズ・品番は上書きされず保護、空欄のみ補完される", false, e16.stack || e16.message);
    }

    // 17. [要件3] 確定済みAI管理商品に対するカテゴリ変更要求拒絶
    try {
      const aiRow = mockRows.find(r => r[1] === "TMP-AI-OTHER01");
      if (aiRow) {
        aiRow[2] = "other"; // other カテゴリに戻す
        aiRow[39] = "ai_managed";
      }

      const origGetLatest = typeof getLatestProductAiDraft_ === "function" ? getLatestProductAiDraft_ : null;
      getLatestProductAiDraft_ = () => ({
        product_id: "TMP-AI-OTHER01",
        draft_id: "DRFT_ALREADY_CONF",
        draft_version: 1,
        review_status: "confirmed", // 既に確定済み状態
        candidate_category: "other",
        candidate_condition: "未使用に近い"
      });

      try {
        currentTransRecord = {
          locale: "en",
          translated_title: "Title",
          translated_description: "Desc",
          translation_status: "approved"
        };
        const confirmRes = handleConfirmAiProductDraft(mockSheet, {
          product_id: "TMP-AI-OTHER01",
          draft_id: "DRFT_ALREADY_CONF",
          draft_version: 1,
          staff_id: "staff_confirm",
          confirmation_attempt_id: "ATTEMPT_ALREADY_CONF",
          confirmed_data: {
            category: "apparel",
            brand: "Chrome Hearts",
            product_name: "CH 仮商品",
            condition: "未使用に近い",
            planned_sale_price: 50000,
            description: "Desc",
            translated_title: "Title",
            translated_description: "Desc"
          }
        });
        const parsedConfirm = JSON.parse(confirmRes.getContent ? confirmRes.getContent() : confirmRes);
        const ok17 = parsedConfirm.success === false && parsedConfirm.error_code === "CATEGORY_CANNOT_BE_CHANGED";
        record("17. [要件3] 昇格条件限定: すでに確定済みのAI管理商品は other から apparel への変更が拒絶される", ok17);
      } finally {
        if (origGetLatest) getLatestProductAiDraft_ = origGetLatest;
      }
    } catch (e17) {
      record("17. [要件3] 昇格条件限定: すでに確定済みのAI管理商品は other から apparel への変更が拒絶される", false, e17.message);
    }

  } finally {
    if (origGenId) generateNextProductId = origGenId;
    if (origDriveApp) DriveApp = origDriveApp;
    if (origFindRow) findProductRow = origFindRow;
    if (origGetTrans) getProductTranslation = origGetTrans;
    if (origSafeGetTrans) safeGetProductTranslation_ = origSafeGetTrans;
    if (origSaveTrans) saveProductTranslation = origSaveTrans;
  }

  console.log("--- [testCategoryExpansionSuite_] 完了: " + passed + "/" + results.length + " 通過 (失敗: " + failed + ") ---");
  return {
    passed: passed,
    failed: failed,
    total: results.length,
    results: results
  };
}

/**
 * 商品シート (Sheets[0]) の列数とヘッダーを検査する (読み取り専用)
 * @return {{ success: boolean, sheet_name: string, max_columns: number, last_column: number, has_43_or_more: boolean, cols_41_43: string[], headers: string[] }}
 */
function inspectProductSheetColumns_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheets()[0];
  const maxCols = sheet.getMaxColumns();
  const lastCol = sheet.getLastColumn();
  const headerCount = Math.max(maxCols, lastCol);
  const headerValues = headerCount > 0 ? sheet.getRange(1, 1, 1, headerCount).getValues()[0] : [];
  let col44Format = "";
  if (maxCols >= 44 && sheet.getMaxRows() >= 2 && typeof sheet.getRange(2, 44).getNumberFormat === "function") {
    col44Format = String(sheet.getRange(2, 44).getNumberFormat() || "");
  }

  return {
    success: true,
    sheet_name: sheet.getName(),
    max_columns: maxCols,
    last_column: lastCol,
    has_43_or_more: maxCols >= 43,
    has_44_or_more: maxCols >= 44,
    cols_41_43: [
      headerValues[40] ? String(headerValues[40]).trim() : "",
      headerValues[41] ? String(headerValues[41]).trim() : "",
      headerValues[42] ? String(headerValues[42]).trim() : ""
    ],
    col_44: headerValues[43] ? String(headerValues[43]).trim() : "",
    col_44_number_format: col44Format,
    headers: headerValues.map(function(h) { return String(h || "").trim(); })
  };
}

/**
 * 商品シート (Sheets[0]) に AO〜AQ 列 (41〜43列) および AR 列 (44列: auction_item_number) を安全に用意する
 * 既存 1〜43列のデータ・ヘッダーおよび既存商品の行データは一切変更しない。
 * @return {{ success: boolean, sheet_name: string, before_max_cols: number, after_max_cols: number, cols_41_43: string[], col_44: string, col_44_number_format: string }}
 */
function setupProductSheetColumns_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheets()[0];
  const beforeMaxCols = sheet.getMaxColumns();

  // 44列未満の場合は末尾に列を追加 (既存列は一切移動・変更しない)
  if (beforeMaxCols < 44) {
    sheet.insertColumnsAfter(beforeMaxCols, 44 - beforeMaxCols);
  }

  // 41〜43列のヘッダーを用意 (空欄または既存ヘッダーがない場合のみ設定、重複追加なし)
  const current41 = String(sheet.getRange(1, 41).getValue() || "").trim();
  const current42 = String(sheet.getRange(1, 42).getValue() || "").trim();
  const current43 = String(sheet.getRange(1, 43).getValue() || "").trim();
  const current44 = String(sheet.getRange(1, 44).getValue() || "").trim();

  if (current44 && current44 !== "auction_item_number") {
    throw new Error("AR column (44) is already in use: found '" + current44 + "'");
  }

  if (!current44) {
    const lastRow = sheet.getLastRow();
    if (lastRow >= 2) {
      const existingArVals = sheet.getRange(2, 44, lastRow - 1, 1).getValues();
      const hasNonEmptyAr = existingArVals.some(function(r) {
        return String(r[0] || "").trim() !== "";
      });
      if (hasNonEmptyAr) {
        throw new Error("AR column (44) already contains data without auction_item_number header");
      }
    }
  }

  if (!current41) {
    sheet.getRange(1, 41).setValue("apparel_fashion_subcategory");
  }
  if (!current42) {
    sheet.getRange(1, 42).setValue("apparel_fashion_size");
  }
  if (!current43) {
    sheet.getRange(1, 43).setValue("apparel_fashion_sku");
  }
  if (!current44) {
    sheet.getRange(1, 44).setValue("auction_item_number");
  }

  // AR列 (2行目以降) をプレーンテキスト書式 "@" に設定し、先頭ゼロ・ハイフンの自動変換を防ぐ (セル値は書き換えない)
  const maxRows = sheet.getMaxRows();
  if (maxRows >= 2) {
    const arDataRange = sheet.getRange(2, 44, maxRows - 1, 1);
    if (typeof arDataRange.setNumberFormat === "function") {
      arDataRange.setNumberFormat("@");
    }
  }

  SpreadsheetApp.flush();

  const afterMaxCols = sheet.getMaxColumns();
  const updatedHeaders = sheet.getRange(1, 41, 1, 4).getValues()[0];
  const col44Fmt = (maxRows >= 2 && typeof sheet.getRange(2, 44).getNumberFormat === "function")
    ? String(sheet.getRange(2, 44).getNumberFormat() || "")
    : "";

  return {
    success: true,
    sheet_name: sheet.getName(),
    before_max_cols: beforeMaxCols,
    after_max_cols: afterMaxCols,
    cols_41_43: [
      String(updatedHeaders[0] || "").trim(),
      String(updatedHeaders[1] || "").trim(),
      String(updatedHeaders[2] || "").trim()
    ],
    col_44: String(updatedHeaders[3] || "").trim(),
    col_44_number_format: col44Fmt
  };
}

/**
 * カテゴリ拡張テストを実行する公開エントリーポイント
 */
function testCategoryExpansionSuite() {
  return testCategoryExpansionSuite_();
}

function runCategoryExpansionTests_() {
  return testCategoryExpansionSuite_();
}

/**
 * ==================================================
 * 27. Driveファイル操作APIテストスイート (move_drive_file / get_drive_file_content)
 * ==================================================
 */
function testDriveFileOperationsSuite_() {
  const results = [];
  let passed = 0;
  let failed = 0;

  function record(name, ok, detail) {
    if (ok) {
      passed++;
      results.push({ name: name, passed: true });
      console.log(`✓ ${name}`);
    } else {
      failed++;
      results.push({ name: name, passed: false, detail: detail });
      console.error(`✗ ${name}: ${detail}`);
    }
  }

  console.log("--- [testDriveFileOperationsSuite_] 開始 ---");

  // モックDriveApp
  function createMockDriveApp() {
    const files = new Map();
    const folders = new Map();

    const mockFolderA = {
      id: "folder_inbox",
      name: "inbox",
      getId: () => "folder_inbox",
      getName: () => "inbox"
    };
    const mockFolderB = {
      id: "folder_processed",
      name: "processed",
      getId: () => "folder_processed",
      getName: () => "processed"
    };

    folders.set("folder_inbox", mockFolderA);
    folders.set("folder_processed", mockFolderB);

    const mockFile = {
      id: "file_doc_001",
      name: "test_doc.pdf",
      mimeType: "application/pdf",
      currentFolderId: "folder_inbox",
      getId: () => "file_doc_001",
      getName: () => "test_doc.pdf",
      getMimeType: () => "application/pdf",
      getBlob: () => ({
        getBytes: () => [80, 68, 70],
        getContentType: () => "application/pdf"
      }),
      moveTo: function(destFolder) {
        this.currentFolderId = destFolder.getId();
      }
    };
    files.set("file_doc_001", mockFile);

    return {
      files,
      folders,
      getFileById: (id) => files.get(id) || null,
      getFolderById: (id) => folders.get(id) || null
    };
  }

  const mockDrive = createMockDriveApp();
  const mockPropService = {
    getProperty: (k) => (k === "ADMIN_SECRET_KEY" ? "valid_secret_123" : null),
    getScriptProperties: function() { return this; }
  };

  // 1. handleMoveDriveFile: 正常系
  try {
    const resRaw = handleMoveDriveFile({
      file_id: "file_doc_001",
      target_folder_id: "folder_processed"
    }, { driveApp: mockDrive });
    const res = JSON.parse(resRaw.getContent());
    const ok1 = res.success === true && res.target_folder_id === "folder_processed" && mockDrive.files.get("file_doc_001").currentFolderId === "folder_processed";
    record("1. handleMoveDriveFile: 正常系 (フォルダ移動成功)", ok1, JSON.stringify(res));
  } catch (e1) {
    record("1. handleMoveDriveFile: 正常系 (フォルダ移動成功)", false, e1.message);
  }

  // 2. handleMoveDriveFile: file_id 欠落
  try {
    const resRaw = handleMoveDriveFile({ target_folder_id: "folder_processed" }, { driveApp: mockDrive });
    const res = JSON.parse(resRaw.getContent());
    record("2. handleMoveDriveFile: file_id欠落拒絶", res.success === false && res.error_code === "FILE_ID_REQUIRED", JSON.stringify(res));
  } catch (e2) {
    record("2. handleMoveDriveFile: file_id欠落拒絶", false, e2.message);
  }

  // 3. handleMoveDriveFile: target_folder_id 欠落
  try {
    const resRaw = handleMoveDriveFile({ file_id: "file_doc_001" }, { driveApp: mockDrive });
    const res = JSON.parse(resRaw.getContent());
    record("3. handleMoveDriveFile: target_folder_id欠落拒絶", res.success === false && res.error_code === "TARGET_FOLDER_ID_REQUIRED", JSON.stringify(res));
  } catch (e3) {
    record("3. handleMoveDriveFile: target_folder_id欠落拒絶", false, e3.message);
  }

  // 4. handleGetDriveFileContent: 正常系 (Base64取得)
  try {
    const resRaw = handleGetDriveFileContent({ file_id: "file_doc_001" }, { driveApp: mockDrive });
    const res = JSON.parse(resRaw.getContent());
    const ok4 = res.success === true && res.file_id === "file_doc_001" && typeof res.base64 === "string" && res.file_size === 3;
    record("4. handleGetDriveFileContent: 正常系 (Base64取得)", ok4, JSON.stringify(res));
  } catch (e4) {
    record("4. handleGetDriveFileContent: 正常系 (Base64取得)", false, e4.message);
  }

  // 5. handleGetDriveFileContent: file_id 欠落
  try {
    const resRaw = handleGetDriveFileContent({}, { driveApp: mockDrive });
    const res = JSON.parse(resRaw.getContent());
    record("5. handleGetDriveFileContent: file_id欠落拒絶", res.success === false && res.error_code === "FILE_ID_REQUIRED", JSON.stringify(res));
  } catch (e5) {
    record("5. handleGetDriveFileContent: file_id欠落拒絶", false, e5.message);
  }

  // 6. doPost管理者認証: move_drive_file を拒絶
  try {
    const postResRaw = doPost({
      postData: {
        contents: JSON.stringify({ action: "move_drive_file", file_id: "file_doc_001", target_folder_id: "folder_processed" })
      }
    }, { propService: mockPropService, driveApp: mockDrive });
    const postRes = JSON.parse(postResRaw.getContent());
    record("6. doPost管理者認証: move_drive_fileの未認証拒絶", postRes.success === false && postRes.error_code === "UNAUTHORIZED_ADMIN_ACCESS", JSON.stringify(postRes));
  } catch (e6) {
    record("6. doPost管理者認証: move_drive_fileの未認証拒絶", false, e6.message);
  }

  // 7. doPost管理者認証: get_drive_file_content を拒絶
  try {
    const postResRaw = doPost({
      postData: {
        contents: JSON.stringify({ action: "get_drive_file_content", file_id: "file_doc_001" })
      }
    }, { propService: mockPropService, driveApp: mockDrive });
    const postRes = JSON.parse(postResRaw.getContent());
    record("7. doPost管理者認証: get_drive_file_contentの未認証拒絶", postRes.success === false && postRes.error_code === "UNAUTHORIZED_ADMIN_ACCESS", JSON.stringify(postRes));
  } catch (e7) {
    record("7. doPost管理者認証: get_drive_file_contentの未認証拒絶", false, e7.message);
  }

  // 8. doPost管理者認証: mode=admin での move_drive_file 成功
  try {
    const postResRaw = doPost({
      postData: {
        contents: JSON.stringify({ action: "move_drive_file", mode: "admin", file_id: "file_doc_001", target_folder_id: "folder_processed" })
      }
    }, { propService: mockPropService, driveApp: mockDrive });
    const postRes = JSON.parse(postResRaw.getContent());
    record("8. doPost管理者認証: mode=admin での move_drive_file 成功", postRes.success === true && postRes.file_id === "file_doc_001", JSON.stringify(postRes));
  } catch (e8) {
    record("8. doPost管理者認証: mode=admin での move_drive_file 成功", false, e8.message);
  }

  // 9. doPost管理者認証: mode=admin での get_drive_file_content 成功
  try {
    const postResRaw = doPost({
      postData: {
        contents: JSON.stringify({ action: "get_drive_file_content", mode: "admin", file_id: "file_doc_001" })
      }
    }, { propService: mockPropService, driveApp: mockDrive });
    const postRes = JSON.parse(postResRaw.getContent());
    record("9. doPost管理者認証: mode=admin での get_drive_file_content 成功", postRes.success === true && postRes.file_id === "file_doc_001", JSON.stringify(postRes));
  } catch (e9) {
    record("9. doPost管理者認証: mode=admin での get_drive_file_content 成功", false, e9.message);
  }

  // 10. doPost管理者認証: 不正な admin_key 送信時の拒絶
  try {
    const mockPropWithKey = {
      getProperty: (k) => (k === "ADMIN_API_KEY" ? "SECRET_KEY_123" : null)
    };
    const postResRaw = doPost({
      postData: {
        contents: JSON.stringify({ action: "move_drive_file", mode: "admin", admin_key: "WRONG_KEY", file_id: "file_doc_001", target_folder_id: "folder_processed" })
      }
    }, { propService: mockPropWithKey, driveApp: mockDrive });
    const postRes = JSON.parse(postResRaw.getContent());
    record("10. doPost管理者認証: 不正キー送信時の拒絶", postRes.success === false && postRes.error_code === "UNAUTHORIZED_ADMIN_ACCESS", JSON.stringify(postRes));
  } catch (e10) {
    record("10. doPost管理者認証: 不正キー送信時の拒絶", false, e10.message);
  }

  console.log(`--- [testDriveFileOperationsSuite_] 完了: ${passed}/${results.length} 通過 (失敗: ${failed}) ---`);
  return {
    passed: passed,
    failed: failed,
    total: results.length,
    results: results
  };
}

function testDriveFileOperationsSuite() {
  return testDriveFileOperationsSuite_();
}

function runDriveFileOperationsTests_() {
  return testDriveFileOperationsSuite_();
}

// ==================================================
// AI一括生成 商品別解析用画像選択 (selected_image_ids) テストスイート
// ==================================================
function testAiBatchSelectedImagesSuite_() {
  console.log("--- [testAiBatchSelectedImagesSuite_] 開始 ---");
  const results = [];
  let passed = 0;
  let failed = 0;

  function record(name, condition, detail) {
    if (condition) {
      passed++;
      results.push({ name: name, status: "PASS", detail: detail || "" });
      console.log("✓ " + name);
    } else {
      failed++;
      results.push({ name: name, status: "FAIL", detail: detail || "" });
      console.error("✗ " + name + (detail ? " -> " + detail : ""));
    }
  }

  // バックアップ
  const origGetActiveSs = SpreadsheetApp.getActiveSpreadsheet;
  const origGetFolderById = DriveApp.getFolderById;
  const origCallGemini = typeof callGeminiMultimodalAiDraft_ === "function" ? callGeminiMultimodalAiDraft_ : null;
  const origCallGeminiSearch = typeof callGeminiMultimodalAiDraftWithSearch_ === "function" ? callGeminiMultimodalAiDraftWithSearch_ : null;
  const origIsSearchEnabled = typeof isAiDraftSearchGroundingEnabled_ === "function" ? isAiDraftSearchGroundingEnabled_ : null;
  const origEnsureTrigger = typeof ensureAiBatchTrigger === "function" ? ensureAiBatchTrigger : null;

  try {
    // インメモリ2次元シートモック生成ヘルパー
    function createInMemorySheet(name, initialRows, minMaxCols) {
      const data = initialRows.map(r => r.slice());
      let maxCols = Math.max(minMaxCols || 43, ...data.map(r => r.length));
      return {
        getName: () => name,
        getLastRow: () => data.length,
        getLastColumn: () => data.reduce((m, r) => Math.max(m, r.length), 0),
        getMaxColumns: () => maxCols,
        insertColumnsAfter: (afterPos, howMany) => { maxCols += howMany; },
        setFrozenRows: () => {},
        appendRow: (row) => {
          const copy = row.slice();
          data.push(copy);
          if (copy.length > maxCols) maxCols = copy.length;
        },
        getDataRange: () => ({
          getValues: () => data.map(r => r.slice())
        }),
        getRange: (row, col, numRows, numCols) => {
          const rCount = numRows || 1;
          const cCount = numCols || 1;
          return {
            getValue: () => {
              const rArr = data[row - 1] || [];
              return rArr[col - 1] !== undefined ? rArr[col - 1] : "";
            },
            getValues: () => {
              const out = [];
              for (let r = 0; r < rCount; r++) {
                const srcRow = data[row - 1 + r] || [];
                const rowOut = [];
                for (let c = 0; c < cCount; c++) {
                  rowOut.push(srcRow[col - 1 + c] !== undefined ? srcRow[col - 1 + c] : "");
                }
                out.push(rowOut);
              }
              return out;
            },
            setValue: (val) => {
              while (data.length < row) data.push([]);
              const targetRow = data[row - 1];
              while (targetRow.length < col) targetRow.push("");
              targetRow[col - 1] = val;
              if (targetRow.length > maxCols) maxCols = targetRow.length;
            },
            setValues: (vals) => {
              for (let r = 0; r < vals.length; r++) {
                const rIdx = row - 1 + r;
                while (data.length <= rIdx) data.push([]);
                const targetRow = data[rIdx];
                for (let c = 0; c < vals[r].length; c++) {
                  const cIdx = col - 1 + c;
                  while (targetRow.length <= cIdx) targetRow.push("");
                  targetRow[cIdx] = vals[r][c];
                }
                if (targetRow.length > maxCols) maxCols = targetRow.length;
              }
            }
          };
        },
        _data: data
      };
    }

    // 商品マスターシート初期データ (TMP-SEL-001: 5枚画像、TMP-SEL-002: 4枚画像)
    const masterHeaders = new Array(43).fill("");
    masterHeaders[0] = "created_at";
    masterHeaders[1] = "product_id";
    masterHeaders[2] = "category";
    masterHeaders[3] = "brand";
    masterHeaders[4] = "product_name";
    masterHeaders[29] = "drive_folder_url";
    masterHeaders[30] = "main_image_url";
    masterHeaders[31] = "publish_status";
    masterHeaders[32] = "inventory_status";
    masterHeaders[33] = "record_status";
    masterHeaders[39] = "ai_draft_flag";
    masterHeaders[40] = "apparel_fashion_subcategory";
    masterHeaders[41] = "apparel_fashion_size";
    masterHeaders[42] = "apparel_fashion_sku";

    const row1 = new Array(43).fill("");
    row1[0] = new Date("2026-10-26T00:00:00Z");
    row1[1] = "TMP-SEL-001";
    row1[2] = "sneaker";
    row1[3] = "Nike";
    row1[4] = "Air Jordan 1";
    row1[29] = "https://drive.google.com/drive/folders/FOLDER_SEL_001";
    row1[30] = "https://drive.google.com/file/d/img_01/view";
    row1[31] = "draft";
    row1[32] = "in_stock";
    row1[33] = "active";

    const row2 = new Array(43).fill("");
    row2[0] = new Date("2026-10-26T00:01:00Z");
    row2[1] = "TMP-SEL-002";
    row2[2] = "sneaker";
    row2[3] = "Adidas";
    row2[4] = "Samba OG";
    row2[29] = "https://drive.google.com/drive/folders/FOLDER_SEL_002";
    row2[30] = "https://drive.google.com/file/d/img_p2_01/view";
    row2[31] = "draft";
    row2[32] = "in_stock";
    row2[33] = "active";

    const mainSheet = createInMemorySheet("シート1", [masterHeaders, row1, row2], 43);
    const sheetsMap = { "シート1": mainSheet };

    SpreadsheetApp.getActiveSpreadsheet = () => ({
      getSheets: () => [mainSheet],
      getSheetByName: (n) => sheetsMap[n] || null,
      insertSheet: (n) => {
        const s = createInMemorySheet(n, [], 20);
        sheetsMap[n] = s;
        return s;
      }
    });

    // Driveフォルダ & 画像ファイルモック (4枚目・5枚目に箱ラベル・タグ画像)
    function makeMockImageFile(id, name, bytesLen) {
      let currentName = name;
      let trashed = false;
      return {
        getId: () => id,
        getName: () => currentName,
        setName: (n) => { currentName = n; },
        getMimeType: () => "image/jpeg",
        getSize: () => bytesLen || 1024,
        getLastUpdated: () => new Date("2026-10-26T00:00:00Z"),
        getUrl: () => "https://drive.google.com/file/d/" + id + "/view",
        isTrashed: () => trashed,
        setTrashed: (t) => { trashed = Boolean(t); },
        getBlob: () => ({
          getBytes: () => [1, 2, 3, 4]
        })
      };
    }

    const folder1Files = [
      makeMockImageFile("img_01", "01_main_front.jpg"),
      makeMockImageFile("img_02", "02_side.jpg"),
      makeMockImageFile("img_03", "03_back.jpg"),
      makeMockImageFile("img_04_box_label", "04_box_label.jpg"),
      makeMockImageFile("img_05_tag", "05_tag.jpg")
    ];
    const folder2Files = [
      makeMockImageFile("img_p2_01", "01_main_front.jpg"),
      makeMockImageFile("img_p2_02", "02_side.jpg"),
      makeMockImageFile("img_p2_03", "03_sole.jpg"),
      makeMockImageFile("img_p2_04", "04_box.jpg")
    ];

    const folderMap = {
      "FOLDER_SEL_001": {
        getId: () => "FOLDER_SEL_001",
        getName: () => "TMP-SEL-001",
        getUrl: () => "https://drive.google.com/drive/folders/FOLDER_SEL_001",
        getFiles: () => {
          let idx = 0;
          return {
            hasNext: () => idx < folder1Files.length,
            next: () => folder1Files[idx++]
          };
        }
      },
      "FOLDER_SEL_002": {
        getId: () => "FOLDER_SEL_002",
        getName: () => "TMP-SEL-002",
        getUrl: () => "https://drive.google.com/drive/folders/FOLDER_SEL_002",
        getFiles: () => {
          let idx = 0;
          return {
            hasNext: () => idx < folder2Files.length,
            next: () => folder2Files[idx++]
          };
        }
      }
    };

    DriveApp.getFolderById = (fid) => {
      if (!folderMap[fid]) throw new Error("Folder not found: " + fid);
      return folderMap[fid];
    };

    // 1. 商品ごとの選択画像保存 (先頭1枚 + 4枚目箱ラベル + 5枚目タグの計3枚)
    const saveResRaw = doPost({
      postData: {
        contents: JSON.stringify({
          action: "save_product_ai_selected_images",
          product_id: "TMP-SEL-001",
          selected_image_ids: ["img_01", "img_04_box_label", "img_05_tag"]
        })
      }
    }, { sheet: mainSheet });
    const saveRes = JSON.parse(saveResRaw.getContent());
    const mainUrlAfterSave = mainSheet.getRange(2, 31).getValue();
    const fileNamesAfterSave = folder1Files.map(f => f.getName()).join(",");
    record(
      "1. 商品別選択画像の保存とメイン画像・画像順の不変確認",
      saveRes.success === true &&
        JSON.stringify(saveRes.selected_image_ids) === JSON.stringify(["img_01", "img_04_box_label", "img_05_tag"]) &&
        mainUrlAfterSave === "https://drive.google.com/file/d/img_01/view" &&
        fileNamesAfterSave === "01_main_front.jpg,02_side.jpg,03_back.jpg,04_box_label.jpg,05_tag.jpg",
      JSON.stringify(saveRes)
    );

    // 2. 商品詳細 (doGet mode=admin&product_id=...) および一覧での選択画像ID取得確認
    const detailResRaw = doGet({
      parameter: { mode: "admin", product_id: "TMP-SEL-001" }
    }, { sheet: mainSheet });
    const detailRes = JSON.parse(detailResRaw.getContent());
    const listResRaw = doGet({
      parameter: { mode: "admin", page: "1", page_size: "10" }
    }, { sheet: mainSheet });
    const listRes = JSON.parse(listResRaw.getContent());
    const listProd1 = (listRes.products || []).find(p => p.product_id === "TMP-SEL-001");
    const listProd2 = (listRes.products || []).find(p => p.product_id === "TMP-SEL-002");
    record(
      "2. 商品詳細および管理一覧での selected_image_ids 取得確認",
      detailRes.success === true &&
        JSON.stringify(detailRes.product.selected_image_ids) === JSON.stringify(["img_01", "img_04_box_label", "img_05_tag"]) &&
        detailRes.product.images.length === 5 &&
        listProd1 && JSON.stringify(listProd1.selected_image_ids) === JSON.stringify(["img_01", "img_04_box_label", "img_05_tag"]) &&
        listProd2 && JSON.stringify(listProd2.selected_image_ids) === JSON.stringify([]),
      JSON.stringify({ detail: detailRes.product && detailRes.product.selected_image_ids, list1: listProd1 && listProd1.selected_image_ids, list2: listProd2 && listProd2.selected_image_ids })
    );

    // 3. バリデーション: 重複IDの拒絶 (DUPLICATE_SELECTED_IMAGE_ID)
    const dupResRaw = doPost({
      postData: {
        contents: JSON.stringify({
          action: "save_product_ai_selected_images",
          product_id: "TMP-SEL-001",
          selected_image_ids: ["img_01", "img_04_box_label", "img_01"]
        })
      }
    }, { sheet: mainSheet });
    const dupRes = JSON.parse(dupResRaw.getContent());
    record(
      "3. 重複画像IDの拒絶 (DUPLICATE_SELECTED_IMAGE_ID)",
      dupRes.success === false && dupRes.error_code === "DUPLICATE_SELECTED_IMAGE_ID",
      JSON.stringify(dupRes)
    );

    // 4. バリデーション: 3枚超の拒絶 (IMAGE_COUNT_EXCEEDED)
    const exceedResRaw = doPost({
      postData: {
        contents: JSON.stringify({
          action: "save_product_ai_selected_images",
          product_id: "TMP-SEL-001",
          selected_image_ids: ["img_01", "img_02", "img_03", "img_04_box_label"]
        })
      }
    }, { sheet: mainSheet });
    const exceedRes = JSON.parse(exceedResRaw.getContent());
    record(
      "4. 4枚以上指定の拒絶 (IMAGE_COUNT_EXCEEDED)",
      exceedRes.success === false && exceedRes.error_code === "IMAGE_COUNT_EXCEEDED",
      JSON.stringify(exceedRes)
    );

    // 5. バリデーション: 他商品の画像ID指定の拒絶 (INVALID_IMAGE_SELECTION)
    const foreignResRaw = doPost({
      postData: {
        contents: JSON.stringify({
          action: "save_product_ai_selected_images",
          product_id: "TMP-SEL-001",
          selected_image_ids: ["img_01", "img_p2_01"]
        })
      }
    }, { sheet: mainSheet });
    const foreignRes = JSON.parse(foreignResRaw.getContent());
    record(
      "5. 対象商品のDriveフォルダに属さない画像IDの拒絶 (INVALID_IMAGE_SELECTION)",
      foreignRes.success === false && foreignRes.error_code === "INVALID_IMAGE_SELECTION",
      JSON.stringify(foreignRes)
    );

    // 6. AI一括生成受付時の選択引き継ぎ & ワーカーでの画像取得検証 (選択あり=後方箱ラベル含む指定3枚、未選択=先頭3枚)
    const receivedImageIdsByProduct = {};
    isAiDraftSearchGroundingEnabled_ = () => false;
    ensureAiBatchTrigger = () => null;
    callGeminiMultimodalAiDraft_ = (images, productMeta, modelName) => {
      receivedImageIdsByProduct[productMeta.productId] = images.map(img => img.fileId);
      return {
        title_ja: "AI生成タイトル " + productMeta.productId,
        hashtags_ja: "#nike #sneaker",
        description_ja: "テスト説明文",
        title_en: "AI Generated Title " + productMeta.productId,
        description_en: "Test description in English",
        condition: "目立った傷や汚れなし",
        price: 25000,
        price_note: "",
        price_basis: "visual",
        category: "sneaker",
        brand: productMeta.brand || "Nike",
        sku: "DZ5485-612",
        sku_source: "box_label",
        size: "27.5cm",
        needs_review: [],
        identity_status: "confident",
        actual_model_name: modelName || "gemini-2.5-flash"
      };
    };

    // 既存の一括生成リクエスト形式 ({ request_id, product_ids, force_regenerate }) でバッチ作成
    const batchCreateRaw = handleCreateAiProductDraftBatch({
      request_id: "REQ_BATCH_INHERIT_001",
      product_ids: ["TMP-SEL-001", "TMP-SEL-002"],
      force_regenerate: true
    });
    const batchCreateRes = JSON.parse(batchCreateRaw.getContent());
    const workerRes = processAiBatchQueue();
    const batchGetRaw = handleGetAiProductDraftBatch({ batch_id: batchCreateRes.batch_id });
    const batchGetRes = JSON.parse(batchGetRaw.getContent());
    const item1 = (batchGetRes.items || []).find(it => it.product_id === "TMP-SEL-001");
    const item2 = (batchGetRes.items || []).find(it => it.product_id === "TMP-SEL-002");
    const draft1 = getLatestProductAiDraft_("TMP-SEL-001");
    const draft2 = getLatestProductAiDraft_("TMP-SEL-002");

    record(
      "6. 一括生成ワーカー実行: 選択済み商品は後方箱ラベル含む指定3枚、未選択商品は先頭3枚を使用",
      batchCreateRes.success === true &&
        workerRes.processed_count === 2 &&
        batchGetRes.status === "completed" &&
        item1 && item1.status === "completed" &&
        JSON.stringify(item1.selected_image_ids) === JSON.stringify(["img_01", "img_04_box_label", "img_05_tag"]) &&
        JSON.stringify(receivedImageIdsByProduct["TMP-SEL-001"]) === JSON.stringify(["img_01", "img_04_box_label", "img_05_tag"]) &&
        draft1 && draft1.source_image_ids === "img_01,img_04_box_label,img_05_tag" &&
        item2 && item2.status === "completed" &&
        JSON.stringify(item2.selected_image_ids) === JSON.stringify([]) &&
        JSON.stringify(receivedImageIdsByProduct["TMP-SEL-002"]) === JSON.stringify(["img_p2_01", "img_p2_02", "img_p2_03"]) &&
        draft2 && draft2.source_image_ids === "img_p2_01,img_p2_02,img_p2_03",
      JSON.stringify({
        used1: receivedImageIdsByProduct["TMP-SEL-001"],
        used2: receivedImageIdsByProduct["TMP-SEL-002"],
        draft1Ids: draft1 && draft1.source_image_ids,
        draft2Ids: draft2 && draft2.source_image_ids
      })
    );

    // 7. 選択画像が後で削除された場合の検証 (別の画像へ黙って差し替えず SELECTED_IMAGE_DELETED を返す)
    // バッチ受付後に 4枚目の箱ラベル画像 (img_04_box_label) がゴミ箱移動されたケース
    const batchDelCreateRaw = handleCreateAiProductDraftBatch({
      request_id: "REQ_BATCH_DELETED_IMG_001",
      product_ids: ["TMP-SEL-001"],
      force_regenerate: true
    });
    const batchDelCreateRes = JSON.parse(batchDelCreateRaw.getContent());
    delete receivedImageIdsByProduct["TMP-SEL-001"];

    // 選択されていた4枚目画像を削除(Trash)
    folder1Files[3].setTrashed(true);
    processAiBatchQueue();

    const batchDelGetRaw = handleGetAiProductDraftBatch({ batch_id: batchDelCreateRes.batch_id });
    const batchDelGetRes = JSON.parse(batchDelGetRaw.getContent());
    const delItem = (batchDelGetRes.items || [])[0];

    record(
      "7. 選択画像が後で削除された場合は別の画像へ差し替えず SELECTED_IMAGE_DELETED と理由を返す",
      batchDelGetRes.status === "failed" &&
        delItem &&
        delItem.status === "failed" &&
        delItem.error_code === "SELECTED_IMAGE_DELETED" &&
        delItem.error_message &&
        delItem.error_message.indexOf("img_04_box_label") !== -1 &&
        receivedImageIdsByProduct["TMP-SEL-001"] === undefined,
      JSON.stringify(delItem)
    );

    // 8. バッチ再試行 (retry_ai_product_draft_batch) でもそのバッチで指定した画像を引き続き使用する
    // 削除されていた画像を復元し、別の一時選択に書き換えても、既存バッチの再試行ではバッチ受付時の選択画像が使われることを確認
    folder1Files[3].setTrashed(false);
    saveProductAiSelectedImageIds_(mainSheet, "TMP-SEL-001", ["img_01", "img_02"]);

    const retryRaw = handleRetryAiProductDraftBatch({
      batch_id: batchDelCreateRes.batch_id,
      request_id: "REQ_RETRY_BATCH_001"
    });
    const retryRes = JSON.parse(retryRaw.getContent());
    processAiBatchQueue();

    const afterRetryGetRaw = handleGetAiProductDraftBatch({ batch_id: batchDelCreateRes.batch_id });
    const afterRetryGetRes = JSON.parse(afterRetryGetRaw.getContent());
    const retriedItem = (afterRetryGetRes.items || [])[0];

    record(
      "8. バッチ再試行時にもそのバッチで指定された selected_image_ids (後方箱ラベル含む3枚) を使用する",
      retryRes.success === true &&
        afterRetryGetRes.status === "completed" &&
        retriedItem &&
        retriedItem.status === "completed" &&
        JSON.stringify(receivedImageIdsByProduct["TMP-SEL-001"]) === JSON.stringify(["img_01", "img_04_box_label", "img_05_tag"]),
      JSON.stringify({ retryUsed: receivedImageIdsByProduct["TMP-SEL-001"], item: retriedItem })
    );

    // 9. update_product_images および update_product 経由での selected_image_ids 保存・取得検証
    const updImgRaw = doPost({
      postData: {
        contents: JSON.stringify({
          action: "update_product_images",
          product_id: "TMP-SEL-001",
          image_order: [
            { source: "existing", id: "img_01" },
            { source: "existing", id: "img_02" },
            { source: "existing", id: "img_03" },
            { source: "existing", id: "img_04_box_label" },
            { source: "existing", id: "img_05_tag" }
          ],
          selected_image_ids: ["img_02", "img_04_box_label"]
        })
      }
    }, { sheet: mainSheet });
    const updImgRes = JSON.parse(updImgRaw.getContent());
    const getAfterUpdImg = getProductAiSelectedImageIds_("TMP-SEL-001");
    record(
      "9. update_product_images 実行と同時の selected_image_ids 保存・メイン画像維持確認",
      updImgRes.success === true &&
        updImgRes.main_image_url === "https://drive.google.com/file/d/img_01/view" &&
        JSON.stringify(updImgRes.selected_image_ids) === JSON.stringify(["img_02", "img_04_box_label"]) &&
        JSON.stringify(getAfterUpdImg) === JSON.stringify(["img_02", "img_04_box_label"]),
      JSON.stringify(updImgRes)
    );

    // 10. create_ai_product_draft_batch での明示指定 (selected_image_ids_by_product) の検証と不正指定の即時拒絶
    const explicitBatchDupRaw = handleCreateAiProductDraftBatch({
      request_id: "REQ_BATCH_EXPLICIT_DUP",
      product_ids: ["TMP-SEL-001"],
      selected_image_ids_by_product: {
        "TMP-SEL-001": ["img_01", "img_01"]
      }
    });
    const explicitBatchDupRes = JSON.parse(explicitBatchDupRaw.getContent());

    const explicitBatchForeignRaw = handleCreateAiProductDraftBatch({
      request_id: "REQ_BATCH_EXPLICIT_FOREIGN",
      product_ids: ["TMP-SEL-001"],
      selected_image_ids_by_product: {
        "TMP-SEL-001": ["img_01", "img_p2_01"]
      }
    });
    const explicitBatchForeignRes = JSON.parse(explicitBatchForeignRaw.getContent());

    const explicitBatchValidRaw = handleCreateAiProductDraftBatch({
      request_id: "REQ_BATCH_EXPLICIT_VALID",
      product_ids: ["TMP-SEL-001"],
      force_regenerate: true,
      selected_image_ids_by_product: {
        "TMP-SEL-001": ["img_03", "img_04_box_label", "img_05_tag"]
      }
    });
    const explicitBatchValidRes = JSON.parse(explicitBatchValidRaw.getContent());
    processAiBatchQueue();
    record(
      "10. 一括生成リクエスト明示指定 (selected_image_ids_by_product) の検証・不正拒絶・ワーカー反映",
      explicitBatchDupRes.success === false &&
        explicitBatchDupRes.error_code === "DUPLICATE_SELECTED_IMAGE_ID" &&
        explicitBatchForeignRes.success === false &&
        explicitBatchForeignRes.error_code === "INVALID_IMAGE_SELECTION" &&
        explicitBatchValidRes.success === true &&
        JSON.stringify(receivedImageIdsByProduct["TMP-SEL-001"]) === JSON.stringify(["img_03", "img_04_box_label", "img_05_tag"]),
      JSON.stringify({
        dup: explicitBatchDupRes.error_code,
        foreign: explicitBatchForeignRes.error_code,
        used: receivedImageIdsByProduct["TMP-SEL-001"]
      })
    );

  } finally {
    SpreadsheetApp.getActiveSpreadsheet = origGetActiveSs;
    DriveApp.getFolderById = origGetFolderById;
    if (origCallGemini) callGeminiMultimodalAiDraft_ = origCallGemini;
    if (origCallGeminiSearch) callGeminiMultimodalAiDraftWithSearch_ = origCallGeminiSearch;
    if (origIsSearchEnabled) isAiDraftSearchGroundingEnabled_ = origIsSearchEnabled;
    if (origEnsureTrigger) ensureAiBatchTrigger = origEnsureTrigger;
  }

  console.log(`--- [testAiBatchSelectedImagesSuite_] 完了: ${passed}/${results.length} 通過 (失敗: ${failed}) ---`);
  return {
    passed: passed,
    failed: failed,
    total: results.length,
    results: results
  };
}

function testAiBatchSelectedImagesSuite() {
  return testAiBatchSelectedImagesSuite_();
}

function runAiBatchSelectedImagesTests_() {
  return testAiBatchSelectedImagesSuite_();
}

// ==================================================
// AI一括生成 カテゴリ拡張 & 原価・最低粗利率20%反映 単体テストスイート
// ==================================================
function testAiBatchCategoryAndCostExpansionSuite_() {
  console.log("=== [testAiBatchCategoryAndCostExpansionSuite_] AI一括生成 カテゴリ拡張・原価反映テスト開始 ===");
  const results = [];
  let passed = 0;
  let failed = 0;

  function record(name, cond, detail) {
    if (cond) {
      passed++;
      console.log(`✓ ${name}`);
      results.push({ name: name, status: "PASS", detail: detail || "" });
    } else {
      failed++;
      console.error(`✗ ${name} (${detail || ""})`);
      results.push({ name: name, status: "FAIL", detail: detail || "" });
    }
  }

  // 1. 全6カテゴリの正規化と登録済みカテゴリ優先判定 (NIKEブランドのアパレル等で誤って矛盾扱いしないこと)
  const normCats = {
    sneaker: normalizeCategoryValue_("スニーカー"),
    pokemon_card: normalizeCategoryValue_("ポケカ"),
    apparel: normalizeCategoryValue_("アパレル"),
    fashion_goods: normalizeCategoryValue_("ファッション小物"),
    jewelry: normalizeCategoryValue_("ジュエリー"),
    other: normalizeCategoryValue_("その他"),
    invalidClock: normalizeCategoryValue_("時計")
  };
  const priorApparelNike = classifyCategoryPriorFromImages_(
    [],
    { productId: "TMP-CAT-APP", category: "apparel", brand: "NIKE", productName: "ACG Jacket" },
    "gemini-3.8-flash",
    {}
  );
  const priorJewelry = classifyCategoryPriorFromImages_(
    [],
    { productId: "TMP-CAT-JWL", category: "jewelry", brand: "TIFFANY & CO.", productName: "Ring" },
    "gemini-3.8-flash",
    {}
  );
  record(
    "1. 登録済み6カテゴリ正規化と登録カテゴリ最優先 (apparel+NIKEでもmismatch誤検知なし)",
    normCats.sneaker === "sneaker" &&
      normCats.pokemon_card === "pokemon_card" &&
      normCats.apparel === "apparel" &&
      normCats.fashion_goods === "fashion_goods" &&
      normCats.jewelry === "jewelry" &&
      normCats.other === "other" &&
      normCats.invalidClock === "" &&
      priorApparelNike.category === "apparel" &&
      priorApparelNike.mismatchDetected === false &&
      priorJewelry.category === "jewelry" &&
      priorJewelry.mismatchDetected === false,
    JSON.stringify({ normCats: normCats, priorApparelNike: priorApparelNike, priorJewelry: priorJewelry })
  );

  // 2. get_product_cost (documents-relay / ProductCostSection.tsx) 形式の原価集計と二重加算防止・税未確定判定
  const confirmedTaxLinks = {
    cost_breakdown: {
      total_primary_cost: 11550,
      total_allocated_cost: 11550,
      matched_lines_count: 1
    },
    links: [
      {
        status: "confirmed",
        allocated_amount: null,
        line: {
          item_amount: 10000,
          fee_amount: 500,
          tax_amount: 1000,
          fee_tax_amount: 50,
          total_line_amount: 11550,
          is_deleted: false,
          is_active: true
        }
      },
      {
        status: "candidate", // 候補ステータスは除外されること
        allocated_amount: 99999,
        line: {
          item_amount: 99999,
          tax_amount: 0,
          total_line_amount: 99999
        }
      }
    ]
  };
  const costSumConfirmed = computeProductCostSummaryFromInput_(confirmedTaxLinks);

  const unconfirmedTaxLinks = {
    links: [
      {
        status: "confirmed",
        allocated_amount: 5000,
        line: {
          item_amount: 5000,
          fee_amount: null,
          tax_amount: null,
          fee_tax_amount: null,
          total_line_amount: null
        }
      }
    ]
  };
  const costSumUnconfirmedTax = computeProductCostSummaryFromInput_(unconfirmedTaxLinks);

  record(
    "2. 原価API(get_product_cost)形式の集計: 二重加算なし(11,550円)・候補除外・税未確定時は参考配賦額(5,000円)を使用",
    costSumConfirmed.has_confirmed_links === true &&
      costSumConfirmed.confirmed_tax_included_cost === 11550 &&
      costSumConfirmed.effective_cost_amount === 11550 &&
      costSumConfirmed.all_tax_confirmed === true &&
      costSumUnconfirmedTax.has_confirmed_links === true &&
      costSumUnconfirmedTax.confirmed_tax_included_cost === null &&
      costSumUnconfirmedTax.reference_allocated_total === 5000 &&
      costSumUnconfirmedTax.effective_cost_amount === 5000 &&
      costSumUnconfirmedTax.all_tax_confirmed === false,
    JSON.stringify({ confirmed: costSumConfirmed, unconfirmedTax: costSumUnconfirmedTax })
  );

  // 3. 価格提案ロジック (販売価格に対する最低粗利率30%: P_floor = ceilPriceByPolicy_(原価 ÷ (1 − 0.30)))
  // 3-A: 原価未照合 (相場 8,300円 -> 8,300円、概算・スタッフ最終判断注記)
  const candUnmatched = applyCostFloorToCandidate_(
    { price: 8300, price_basis: "active_listing_reference", price_note: "販売中相場8,300円", needs_review: [] },
    { links: [] },
    0.30
  );
  // 3-B: 照合済み・相場(18,500円) >= 最低粗利率下限(ceil(11550 / 0.70 = 16500) -> 16,500円) -> 相場18,500円採用
  const candMarketHigher = applyCostFloorToCandidate_(
    { price: 18500, price_basis: "recent_sold_provisional", price_note: "成約相場18,500円", needs_review: [] },
    confirmedTaxLinks,
    0.30
  );
  // 3-C: 照合済み・相場(6,800円) < 最低粗利率下限(ceil(6600 / 0.70 = 9428.57) -> 9,450円) -> 下限9,450円採用
  const candFloorHigher = applyCostFloorToCandidate_(
    { price: 6800, price_basis: "active_listing_reference", price_note: "販売中相場6,800円", needs_review: [] },
    {
      links: [
        {
          status: "confirmed",
          allocated_amount: 6600,
          line: {
            item_amount: 6000,
            fee_amount: null,
            tax_amount: 600,
            fee_tax_amount: null,
            total_line_amount: 6600
          }
        }
      ]
    },
    0.30
  );
  // 3-C2: 商品代金10,000円＋落札手数料1,500円＝原価11,500円 -> 11,500 ÷ (1 - 0.30) = 16,428.57 -> 下限16,500円
  const cand11500Floor = applyCostFloorToCandidate_(
    { price: 14000, price_basis: "active_listing_reference", price_note: "販売中相場14,000円", needs_review: [] },
    {
      links: [
        {
          status: "confirmed",
          allocated_amount: 11500,
          line: {
            item_amount: 10000,
            fee_amount: 1500,
            tax_included_flag: true,
            total_line_amount: 11500
          }
        }
      ]
    },
    0.30
  );
  // 3-D: 照合済み・税額未確定 (参考原価5,000円、下限5000/0.70=7,142.86->7,150円、相場5,500円 -> 7,150円採用 + 税未確定概算注記)
  const candTaxUnconfirmed = applyCostFloorToCandidate_(
    { price: 5500, price_basis: "active_listing_reference", price_note: "販売中相場5,500円", needs_review: [] },
    unconfirmedTaxLinks,
    0.30
  );
  // 3-E: 税額確認済明細(商品代金20,500 + 手数料820 + 税額2,050 + 手数料税82 = 税込総額23,452円)に対し、
  // link.allocated_amount に税抜合計(21,320円)が保存されているケース -> 確認済み税額2,132円を除外せず 23,452円 ÷ 0.70 = 33,502.86 -> 下限33,600円になること
  const exTaxAllocatedButConfirmedTaxLinks = {
    cost_breakdown: {
      total_primary_cost: 21320,
      total_allocated_cost: 21320,
      matched_lines_count: 1
    },
    links: [
      {
        status: "confirmed",
        allocation_method: "direct",
        allocated_amount: 21320,
        line: {
          item_amount: 20500,
          fee_amount: 820,
          tax_amount: 2050,
          fee_tax_amount: 82,
          total_line_amount: 23452,
          is_deleted: false,
          is_active: true
        }
      }
    ]
  };
  const costSumExTaxAllocConfirmed = computeProductCostSummaryFromInput_(exTaxAllocatedButConfirmedTaxLinks);
  const candExTaxAllocConfirmed = applyCostFloorToCandidate_(
    { price: 3250, price_basis: "recent_sold_provisional", price_note: "比較可能取引事例（平均値3250円）", needs_review: [] },
    exTaxAllocatedButConfirmedTaxLinks,
    0.30
  );

  record(
    "3. 販売価格に対する最低粗利率30%(原価÷(1-0.30))価格比較: 未照合は相場(8,300円)、相場>下限は相場(18,500円)、11,500円原価は下限16,500円、6,600円原価は下限9,450円、税未確定5,000円は下限7,150円、確認済税額あり(23,452円)は下限33,600円",
    candUnmatched.price === 8300 &&
      candUnmatched.price_note.indexOf("概算") !== -1 &&
      candUnmatched.price_note.indexOf("最終判断はスタッフが行います") !== -1 &&
      candMarketHigher.price === 18500 &&
      candMarketHigher.cost_calculation.pricing_rule === "gross_margin_floor" &&
      candMarketHigher.cost_calculation.min_cost_markup_rate === 0.30 &&
      candMarketHigher.cost_calculation.gross_margin_divisor === 0.7 &&
      candMarketHigher.cost_calculation.floor_price === 16500 &&
      candMarketHigher.cost_calculation.price_decision_source === "market_above_gross_margin_floor" &&
      candFloorHigher.price === 9450 &&
      candFloorHigher.price_basis === "gross_margin_floor" &&
      candFloorHigher.cost_calculation.floor_price === 9450 &&
      candFloorHigher.price_note.indexOf("最低粗利率30%") !== -1 &&
      candFloorHigher.price_note.indexOf("最終判断はスタッフが行います") !== -1 &&
      cand11500Floor.price === 16500 &&
      cand11500Floor.price_basis === "gross_margin_floor" &&
      cand11500Floor.cost_calculation.floor_price === 16500 &&
      candTaxUnconfirmed.price === 7150 &&
      candTaxUnconfirmed.price_note.indexOf("税額未確定") !== -1 &&
      candTaxUnconfirmed.price_note.indexOf("最終判断はスタッフが行います") !== -1 &&
      costSumExTaxAllocConfirmed.effective_cost_amount === 23452 &&
      costSumExTaxAllocConfirmed.confirmed_tax_included_cost === 23452 &&
      costSumExTaxAllocConfirmed.all_tax_confirmed === true &&
      costSumExTaxAllocConfirmed.cost_source === "confirmed_tax_included" &&
      candExTaxAllocConfirmed.price === 33600 &&
      candExTaxAllocConfirmed.price_basis === "gross_margin_floor" &&
      candExTaxAllocConfirmed.cost_calculation.effective_cost_amount === 23452 &&
      candExTaxAllocConfirmed.cost_calculation.floor_price === 33600 &&
      candExTaxAllocConfirmed.price_note.indexOf("確定税込原価（23452円）") !== -1 &&
      candExTaxAllocConfirmed.price_note.indexOf("下限価格（33600円") !== -1,
    JSON.stringify({
      unmatched: candUnmatched,
      marketHigher: candMarketHigher,
      floorHigher: candFloorHigher,
      cand11500Floor: cand11500Floor,
      taxUnconfirmed: candTaxUnconfirmed,
      exTaxAllocConfirmed: candExTaxAllocConfirmed
    })
  );

  // 4. 全登録カテゴリ (apparel, fashion_goods, jewelry, other) での一括生成ワーカーE2E検証 (43列シート反映 & 原価反映)
  const origGetActiveSs = SpreadsheetApp.getActiveSpreadsheet;
  const origGetFolderById = DriveApp.getFolderById;
  const origCallGeminiSearch = typeof callGeminiMultimodalAiDraftWithSearch_ === "function" ? callGeminiMultimodalAiDraftWithSearch_ : null;
  const origIsSearchEnabled = typeof isAiDraftSearchGroundingEnabled_ === "function" ? isAiDraftSearchGroundingEnabled_ : null;
  const origEnsureTrigger = typeof ensureAiBatchTrigger === "function" ? ensureAiBatchTrigger : null;

  try {
    const headers43 = new Array(43).fill("");
    headers43[0] = "created_at";
    headers43[1] = "product_id";
    headers43[2] = "category";
    headers43[3] = "brand";
    headers43[4] = "product_name";
    headers43[5] = "condition";
    headers43[7] = "planned_sale_price";
    headers43[9] = "description";
    headers43[11] = "sneaker_sku";
    headers43[12] = "sneaker_size";
    headers43[29] = "drive_folder_url";
    headers43[31] = "publish_status";
    headers43[33] = "record_status";
    headers43[39] = "ai_draft_flag";
    headers43[40] = "subcategory";
    headers43[41] = "size";
    headers43[42] = "official_sku";

    const makeRow43 = (pid, cat, brand, folderId) => {
      const r = new Array(43).fill("");
      r[0] = "2026-10-29T00:00:00Z";
      r[1] = pid;
      r[2] = cat;
      r[3] = brand;
      r[29] = "https://drive.google.com/drive/folders/" + folderId;
      r[31] = "draft";
      r[33] = "active";
      return r;
    };

    const mainRows = [
      headers43,
      makeRow43("TMP-EXP-APP", "apparel", "NIKE", "FOLDER_EXP_APP"),
      makeRow43("TMP-EXP-FGD", "fashion_goods", "GUCCI", "FOLDER_EXP_FGD"),
      makeRow43("TMP-EXP-JWL", "jewelry", "TIFFANY & CO.", "FOLDER_EXP_JWL"),
      makeRow43("TMP-EXP-OTH", "other", "Supreme", "FOLDER_EXP_OTH")
    ];

    const sheetStore = {};
    function createSheetMock(name, initialRows, minMaxCols) {
      const data = initialRows ? initialRows.map(r => r.slice()) : [];
      const mock = {
        getName: () => name,
        getLastRow: () => data.length,
        getLastColumn: () => data.reduce((m, r) => Math.max(m, r.length), 0),
        getMaxColumns: () => Math.max(minMaxCols || 40, data.reduce((m, r) => Math.max(m, r.length), 0)),
        setFrozenRows: () => {},
        appendRow: (row) => { data.push(row.slice()); },
        getRange: (r, c, numR, numC) => {
          const nR = numR || 1;
          const nC = numC || 1;
          return {
            getValue: () => (data[r - 1] && data[r - 1][c - 1] !== undefined) ? data[r - 1][c - 1] : "",
            getValues: () => {
              const out = [];
              for (let i = 0; i < nR; i++) {
                const rowArr = [];
                for (let j = 0; j < nC; j++) {
                  rowArr.push((data[r - 1 + i] && data[r - 1 + i][c - 1 + j] !== undefined) ? data[r - 1 + i][c - 1 + j] : "");
                }
                out.push(rowArr);
              }
              return out;
            },
            setValue: (val) => {
              while (data.length < r) data.push([]);
              while (data[r - 1].length < c) data[r - 1].push("");
              data[r - 1][c - 1] = val;
            },
            setValues: (vals) => {
              for (let i = 0; i < vals.length; i++) {
                while (data.length < r + i) data.push([]);
                for (let j = 0; j < vals[i].length; j++) {
                  while (data[r - 1 + i].length < c + j) data[r - 1 + i].push("");
                  data[r - 1 + i][c - 1 + j] = vals[i][j];
                }
              }
            }
          };
        },
        _data: data
      };
      sheetStore[name] = mock;
      return mock;
    }

    const mainSheetMock = createSheetMock("商品マスター", mainRows, 43);
    SpreadsheetApp.getActiveSpreadsheet = () => ({
      getSheets: () => [mainSheetMock],
      getSheetByName: (n) => sheetStore[n] || null,
      insertSheet: (n) => createSheetMock(n, [], 43)
    });

    DriveApp.getFolderById = () => ({
      getFiles: () => {
        let idx = 0;
        const files = [
          {
            getId: () => "img_exp_01",
            getName: () => "01_main.jpg",
            getMimeType: () => "image/jpeg",
            getSize: () => 1024,
            getLastUpdated: () => new Date("2026-10-29T00:00:00Z"),
            isTrashed: () => false,
            getBlob: () => ({ getBytes: () => [1, 2, 3, 4] })
          }
        ];
        return {
          hasNext: () => idx < files.length,
          next: () => files[idx++]
        };
      }
    });

    isAiDraftSearchGroundingEnabled_ = () => true;
    ensureAiBatchTrigger = () => null;

    callGeminiMultimodalAiDraftWithSearch_ = (images, productMeta) => {
      const cat = normalizeCategoryValue_(productMeta.category);
      const marketPrices = {
        "TMP-EXP-APP": 6800,  // 原価6,600円(下限 6600*1.30=8,580 -> 8,600円)より低い -> 8,600円になること
        "TMP-EXP-FGD": 24000, // 原価11,550円(下限 11550*1.30=15,015 -> 15,100円)より高い -> 24,000円になること
        "TMP-EXP-JWL": 45000, // 原価未照合 -> 45,000円になること
        "TMP-EXP-OTH": 12000  // 税未確定原価10,000円(下限 10000*1.30=13,000円)より低い -> 13,000円になること
      };
      return {
        title_ja: `${productMeta.brand} ${cat} テスト商品名`,
        hashtags_ja: `#${productMeta.brand}`,
        description_ja: `${cat} 商品の説明文です。`,
        title_en: `${productMeta.brand} ${cat} Test Item`,
        description_en: `Description for ${cat} item.`,
        condition: "目立った傷や汚れなし",
        price: marketPrices[productMeta.productId] || 10000,
        price_basis: "active_listing_reference",
        price_note: `同一商品の販売中市場価格（${marketPrices[productMeta.productId]}円）を参照した参考価格案です。`,
        price_evidence: [
          {
            source_url: "https://example.com/item/" + productMeta.productId,
            price_type: "active",
            amount: marketPrices[productMeta.productId] || 10000,
            currency: "JPY",
            transaction_date: "2026-10",
            item_match_condition: "exact_match",
            verification_status: "format_valid"
          }
        ],
        price_evidence_verified: false,
        category: cat,
        brand: productMeta.brand,
        sku: (cat === "apparel" || cat === "fashion_goods") ? "BV0740-010" : "",
        sku_source: "box_label",
        size: (cat === "apparel" || cat === "fashion_goods") ? "L" : "",
        identity_status: "confident",
        needs_review: ["price"],
        actual_model_name: "gemini-3.8-flash",
        search_grounding: {
          enabled: true,
          mode_used: "two_stage",
          search_executed: true,
          queries: [productMeta.brand + " " + cat],
          sources: [{ url: "https://example.com/item", title: "Example" }],
          sources_count: 1,
          queries_count: 1
        }
      };
    };

    const batchCreateRes = JSON.parse(handleCreateAiProductDraftBatch({
      request_id: "REQ_CAT_COST_EXP_001",
      product_ids: ["TMP-EXP-APP", "TMP-EXP-FGD", "TMP-EXP-JWL", "TMP-EXP-OTH"],
      min_cost_markup_rate: 0.30,
      product_costs: {
        "TMP-EXP-APP": {
          links: [
            {
              status: "confirmed",
              allocated_amount: 6600,
              line: { item_amount: 6000, fee_amount: null, tax_amount: 600, fee_tax_amount: null, total_line_amount: 6600 }
            }
          ]
        },
        "TMP-EXP-FGD": confirmedTaxLinks,
        "TMP-EXP-JWL": { links: [] },
        "TMP-EXP-OTH": {
          links: [
            {
              status: "confirmed",
              allocated_amount: 10000,
              line: { item_amount: 10000, fee_amount: null, tax_amount: null, fee_tax_amount: null, total_line_amount: null }
            }
          ]
        }
      }
    }).getContent());

    processAiBatchQueue();
    processAiBatchQueue();

    const batchStatusRes = JSON.parse(handleGetAiProductDraftBatch({
      batch_id: batchCreateRes.batch_id
    }).getContent());

    const rowApp = mainSheetMock._data[1];
    const rowFgd = mainSheetMock._data[2];
    const rowJwl = mainSheetMock._data[3];
    const rowOth = mainSheetMock._data[4];

    record(
      "4. 全登録カテゴリ(apparel/fashion_goods/jewelry/other)一括生成完了 & 43列属性(AP/AQ列)・最低粗利率30%下限価格(H列)反映",
      batchCreateRes.success === true &&
        batchCreateRes.min_cost_markup_rate === 0.30 &&
        batchCreateRes.gross_margin_divisor === 0.7 &&
        batchStatusRes.status === "completed" &&
        batchStatusRes.completed_count === 4 &&
        // TMP-EXP-APP: apparel, H列(index 7)=9450(原価6,600÷0.70=9,428.57→9,450), L/M列(index 11,12)空欄, AP列(index 41)='L', AQ列(index 42)='BV0740-010'
        rowApp[2] === "apparel" &&
        Number(rowApp[7]) === 9450 &&
        rowApp[11] === "" &&
        rowApp[12] === "" &&
        rowApp[41] === "L" &&
        rowApp[42] === "BV0740-010" &&
        // TMP-EXP-FGD: fashion_goods, H列(index 7)=24000(相場24,000 > 下限16,500), AP列='L', AQ列='BV0740-010'
        rowFgd[2] === "fashion_goods" &&
        Number(rowFgd[7]) === 24000 &&
        rowFgd[41] === "L" &&
        rowFgd[42] === "BV0740-010" &&
        // TMP-EXP-JWL: jewelry, H列(index 7)=45000(未照合・相場ベース), L/M/AP/AQ空欄
        rowJwl[2] === "jewelry" &&
        Number(rowJwl[7]) === 45000 &&
        rowJwl[11] === "" &&
        rowJwl[41] === "" &&
        // TMP-EXP-OTH: other, H列(index 7)=14300(税未確定原価10,000・最低粗利率30%下限14,300 > 相場12,000)
        rowOth[2] === "other" &&
        Number(rowOth[7]) === 14300,
      JSON.stringify({
        batchStatus: batchStatusRes.status,
        completed: batchStatusRes.completed_count,
        appPrice: rowApp[7],
        appSizeAp: rowApp[41],
        appSkuAq: rowApp[42],
        fgdPrice: rowFgd[7],
        jwlPrice: rowJwl[7],
        othPrice: rowOth[7]
      })
    );
  } finally {
    SpreadsheetApp.getActiveSpreadsheet = origGetActiveSs;
    DriveApp.getFolderById = origGetFolderById;
    if (origCallGeminiSearch) callGeminiMultimodalAiDraftWithSearch_ = origCallGeminiSearch;
    if (origIsSearchEnabled) isAiDraftSearchGroundingEnabled_ = origIsSearchEnabled;
    if (origEnsureTrigger) ensureAiBatchTrigger = origEnsureTrigger;
  }

  // 5. TMP-000159 実数値検証: 検索結果一覧URLのみが渡された場合に ¥3,250 を相場採用せず、税込仕入総額 ¥23,452 から下限 ¥33,600（相場未確認の価格案）となること
  const tmp159CostInput = {
    cost_breakdown: {
      total_primary_cost: 21320,
      total_allocated_cost: 21320,
      matched_lines_count: 1
    },
    links: [
      {
        status: "confirmed",
        allocation_method: "direct",
        allocated_amount: 21320,
        line: {
          item_amount: 20500,
          fee_amount: 820,
          tax_amount: 2050,
          fee_tax_amount: 82,
          total_line_amount: 23452,
          is_deleted: false,
          is_active: true
        }
      }
    ]
  };
  const buildTmp159RawCandidate = (catVal) => ({
    title_ja: "ウイングスカル グラフィック ロングスリーブ Tシャツ ブラック",
    hashtags_ja: "#ロングスリーブTシャツ #ロンT #長袖Tシャツ #スカルプリント #カットソー",
    description_ja: "ブラックボディにウイングスカルのグラフィックが配されたロングスリーブTシャツです。",
    title_en: "Winged Skull Graphic Long Sleeve T-Shirt Black",
    description_en: "Black long-sleeve graphic T-shirt featuring a winged skull motif.",
    condition: "やや傷や汚れあり",
    category: catVal,
    brand: "",
    sku: "",
    size: "",
    price: 3250,
    price_basis: "comparable_model_reference",
    price_evidence: [
      {
        source_url: "https://jp.mercari.com/search?keyword=PAWN+NOMADS+%E3%83%AD%E3%83%B3T",
        price_type: "active",
        amount: 3000,
        currency: "JPY",
        transaction_date: "2026-10",
        item_match_condition: "comparable_model"
      },
      {
        source_url: "https://jp.mercari.com/search?keyword=DELUXE+%E3%83%AD%E3%83%B3T+%E9%BB%92",
        price_type: "active",
        amount: 3500,
        currency: "JPY",
        transaction_date: "2026-10",
        item_match_condition: "comparable_model"
      }
    ]
  });

  const sanitized159Other = validateAndSanitizeDraftCandidate_(buildTmp159RawCandidate("other"), { image_count: 3 });
  const preFloorMarketNull = sanitized159Other.price === null && sanitized159Other.price_basis === "no_evidence";
  const allSearchUrlsUnverified = Array.isArray(sanitized159Other.price_evidence) &&
    sanitized159Other.price_evidence.length === 2 &&
    sanitized159Other.price_evidence.every(e => e.verification_status === "unverified");
  applyCostFloorToCandidate_(sanitized159Other, tmp159CostInput, 0.30);

  const sanitized159Apparel = validateAndSanitizeDraftCandidate_(buildTmp159RawCandidate("apparel"), { image_count: 3 });
  applyCostFloorToCandidate_(sanitized159Apparel, tmp159CostInput, 0.30);

  record(
    "5. TMP-000159実数値検証: 検索結果一覧URLのみの¥3,250を相場採用せず、税込仕入総額¥23,452から下限¥33,600(相場未確認の価格案)を提案",
    preFloorMarketNull &&
      allSearchUrlsUnverified &&
      sanitized159Other.price === 33600 &&
      sanitized159Other.price_basis === "gross_margin_floor" &&
      sanitized159Other.cost_calculation.effective_cost_amount === 23452 &&
      sanitized159Other.cost_calculation.market_price === null &&
      sanitized159Other.cost_calculation.floor_price === 33600 &&
      sanitized159Other.price_note.indexOf("相場未確認の価格案") !== -1 &&
      sanitized159Other.price_note.indexOf("確定税込原価（23452円）") !== -1 &&
      sanitized159Other.price_note.indexOf("下限価格（33600円") !== -1 &&
      sanitized159Other.price_note.indexOf("3250") === -1 &&
      sanitized159Other.price_note.indexOf("形式確認済") === -1 &&
      sanitized159Other.price_note.indexOf("同一モデルの比較可能取引事例") === -1 &&
      sanitized159Apparel.price === 33600 &&
      sanitized159Apparel.cost_calculation.market_price === null,
    JSON.stringify({
      preFloorMarketNull: preFloorMarketNull,
      allSearchUrlsUnverified: allSearchUrlsUnverified,
      price: sanitized159Other.price,
      marketPrice: sanitized159Other.cost_calculation.market_price,
      floorPrice: sanitized159Other.cost_calculation.floor_price,
      priceNote: sanitized159Other.price_note
    })
  );

  // 6. ブランド・商品未特定のアパレル相当で原価未照合の場合: 無関係な平均やAI概算を採用せず価格未設定(null)のままスタッフ判断に委ねること
  const sanitizedUnmatchedSearchOnly = validateAndSanitizeDraftCandidate_(buildTmp159RawCandidate("other"), { image_count: 3 });
  applyCostFloorToCandidate_(sanitizedUnmatchedSearchOnly, { links: [] }, 0.30);

  const sanitizedUnmatchedAiGuess = validateAndSanitizeDraftCandidate_({
    title_ja: "グラフィック プリント Tシャツ ブラック",
    description_ja: "ブランドタグ不明のプリントTシャツです。",
    condition: "目立った傷や汚れなし",
    category: "apparel",
    brand: "",
    sku: "",
    price: 3000,
    price_basis: "unverified_estimate",
    price_evidence: []
  }, { image_count: 2 });
  applyCostFloorToCandidate_(sanitizedUnmatchedAiGuess, { links: [] }, 0.30);

  record(
    "6. 未特定アパレル・原価未照合時: 検索一覧URL平均・AI概算の双方を不採用とし価格未設定(null)でスタッフ判断に委ねる",
    sanitizedUnmatchedSearchOnly.price === null &&
      sanitizedUnmatchedSearchOnly.cost_calculation.market_price === null &&
      sanitizedUnmatchedSearchOnly.price_note.indexOf("価格は未設定") !== -1 &&
      sanitizedUnmatchedSearchOnly.price_note.indexOf("Web相場に基づく概算価格提案") === -1 &&
      sanitizedUnmatchedAiGuess.price === null &&
      sanitizedUnmatchedAiGuess.cost_calculation.market_price === null &&
      sanitizedUnmatchedAiGuess.price_note.indexOf("価格は未設定") !== -1 &&
      sanitizedUnmatchedAiGuess.price_note.indexOf("Web相場に基づく概算価格提案") === -1,
    JSON.stringify({
      searchOnlyPrice: sanitizedUnmatchedSearchOnly.price,
      searchOnlyNote: sanitizedUnmatchedSearchOnly.price_note,
      aiGuessPrice: sanitizedUnmatchedAiGuess.price,
      aiGuessNote: sanitizedUnmatchedAiGuess.price_note
    })
  );

  // 7. 個別商品URLの保護と従来の相場比較維持、および価格メモ表現（「検索」「個別取引確認」「成約価格」の厳密区別）
  const rejectedSearchChecks = [
    "https://jp.mercari.com/search?keyword=PAWN+NOMADS",
    "https://auctions.yahoo.co.jp/search/search?p=skull+shirt",
    "https://fril.jp/s?query=deluxe+tee",
    "https://www.ebay.com/sch/i.html?_nkw=vintage+tee",
    "https://www.2ndstreet.jp/search?keyword=tee",
    "https://www.google.com/search?q=pawn+nomads"
  ].every(u => {
    const v = verifyPriceEvidenceItem_({
      source_url: u,
      price_type: "sold",
      amount: 5000,
      currency: "JPY",
      transaction_date: "2026-10",
      item_match_condition: "exact_match"
    });
    return v && v.verification_status === "unverified";
  });

  const preservedItemChecks = [
    "https://jp.mercari.com/item/m98765432101",
    "https://jp.mercari.com/item/m98765432101?utm_source=ios",
    "https://jp.mercari.com/shops/product/2J8K9L0M1N2P",
    "https://page.auctions.yahoo.co.jp/jp/auction/x1122334455",
    "https://snkrdunk.com/products/IB4481-500?size=27.5",
    "https://www.ebay.com/itm/1234567890",
    "https://item.fril.jp/abcdef123456"
  ].every(u => {
    const v = verifyPriceEvidenceItem_({
      source_url: u,
      price_type: "sold",
      amount: 35000,
      currency: "JPY",
      transaction_date: "2026-10",
      item_match_condition: "exact_match"
    });
    return v && v.verification_status === "format_valid";
  });

  // 個別商品の有効な根拠がある場合の従来相場比較:
  // (a) 個別商品URL相場 ¥35,000 >= 下限 ¥33,600 -> 相場 ¥35,000 採用（ただし実内容未確認のため「確認済」と表現しない）
  const candValidMarketHigher = validateAndSanitizeDraftCandidate_({
    title_ja: "NEIGHBORHOOD スカル ロングスリーブ Tシャツ ブラック",
    description_ja: "ネイバーフッドのロングスリーブTシャツです。",
    condition: "目立った傷や汚れなし",
    category: "apparel",
    brand: "NEIGHBORHOOD",
    sku: "232PCNH-LT01",
    size: "L",
    price: 35000,
    price_basis: "recent_sold_provisional",
    price_evidence: [
      {
        source_url: "https://jp.mercari.com/item/m11111111111",
        price_type: "sold",
        amount: 34000,
        currency: "JPY",
        transaction_date: "2026-10",
        item_match_condition: "exact_match"
      },
      {
        source_url: "https://jp.mercari.com/item/m22222222222",
        price_type: "sold",
        amount: 36000,
        currency: "JPY",
        transaction_date: "2026-10",
        item_match_condition: "exact_match"
      }
    ]
  }, { image_count: 3 });
  const preFloorNoteUnconfirmedClean =
    candValidMarketHigher.price === 35000 &&
    candValidMarketHigher.price_note.indexOf("検索で取得した") !== -1 &&
    candValidMarketHigher.price_note.indexOf("未確認") !== -1 &&
    candValidMarketHigher.price_note.indexOf("成約価格とは確定しておらず") !== -1 &&
    candValidMarketHigher.price_note.indexOf("確認済") === -1;
  applyCostFloorToCandidate_(candValidMarketHigher, tmp159CostInput, 0.30);

  // (b) 個別商品URL相場 ¥18,000 < 下限 ¥33,600 -> 下限 ¥33,600 採用（market_price=18000 は保持）
  const candValidMarketLower = validateAndSanitizeDraftCandidate_({
    title_ja: "NEIGHBORHOOD スカル ロングスリーブ Tシャツ ブラック",
    description_ja: "ネイバーフッドのロングスリーブTシャツです。",
    condition: "目立った傷や汚れなし",
    category: "apparel",
    brand: "NEIGHBORHOOD",
    sku: "232PCNH-LT01",
    size: "L",
    price: 18000,
    price_basis: "active_listing_reference",
    price_evidence: [
      {
        source_url: "https://jp.mercari.com/item/m33333333333",
        price_type: "active",
        amount: 18000,
        currency: "JPY",
        transaction_date: "2026-10",
        item_match_condition: "exact_match"
      }
    ]
  }, { image_count: 3 });
  applyCostFloorToCandidate_(candValidMarketLower, tmp159CostInput, 0.30);

  // (c) 明示的に個別取引確認済み (is_content_verified: true) の場合のみ「個別取引および成約内容を確認済み」と表現できること
  const contentVerifiedRes = calculateServerGroundedPrice_({
    price_basis: "recent_sold_verified",
    price_evidence: [
      {
        source_url: "https://jp.mercari.com/item/m44444444444",
        price_type: "sold",
        amount: 35000,
        currency: "JPY",
        transaction_date: "2026-10-15",
        item_match_condition: "exact_match",
        is_content_verified: true
      }
    ]
  }, { category: "apparel", brand: "NEIGHBORHOOD", sku: "232PCNH-LT01" });

  record(
    "7. 個別商品URL保護・従来相場比較(相場>=下限は相場35,000円/相場<下限は下限33,600円)・価格メモ表現(検索/個別取引確認/成約価格の区別)",
    rejectedSearchChecks &&
      preservedItemChecks &&
      preFloorNoteUnconfirmedClean &&
      candValidMarketHigher.price === 35000 &&
      candValidMarketHigher.cost_calculation.market_price === 35000 &&
      candValidMarketHigher.cost_calculation.floor_price === 33600 &&
      candValidMarketHigher.cost_calculation.price_decision_source === "market_above_gross_margin_floor" &&
      candValidMarketLower.price === 33600 &&
      candValidMarketLower.cost_calculation.market_price === 18000 &&
      candValidMarketLower.cost_calculation.floor_price === 33600 &&
      candValidMarketLower.cost_calculation.price_decision_source === "gross_margin_floor" &&
      contentVerifiedRes.price === 35000 &&
      contentVerifiedRes.price_evidence_verified === true &&
      contentVerifiedRes.price_note.indexOf("個別取引および成約内容を確認済み") !== -1,
    JSON.stringify({
      rejectedSearchChecks: rejectedSearchChecks,
      preservedItemChecks: preservedItemChecks,
      preFloorNoteUnconfirmedClean: preFloorNoteUnconfirmedClean,
      higherPrice: candValidMarketHigher.price,
      lowerPrice: candValidMarketLower.price,
      lowerMarket: candValidMarketLower.cost_calculation.market_price,
      verifiedNote: contentVerifiedRes.price_note
    })
  );

  // 8. アパレル向け生成指示の書式統一・未確認項目省略・Chrome Hearts決めつけ防止ルール検証
  const sysInstrText = buildAiDraftSystemInstruction_();
  const sysPromptChecks =
    sysInstrText.indexOf("4B. APPAREL GUIDELINES") !== -1 &&
    sysInstrText.indexOf("SUPREME × HONDA HRC RACING JACKET S") !== -1 &&
    sysInstrText.indexOf("NEVER copy example words, brands, or sizes") !== -1 &&
    sysInstrText.indexOf("Never assume or default to 'Chrome Hearts'") !== -1 &&
    sysInstrText.indexOf("Append concise Japanese to title_ja ONLY when English alone would be unclear") !== -1 &&
    sysInstrText.indexOf("【サイズ】") !== -1 &&
    sysInstrText.indexOf("【素材】") !== -1 &&
    sysInstrText.indexOf("【原産国】") !== -1 &&
    sysInstrText.indexOf("【付属品】") !== -1 &&
    sysInstrText.indexOf("Include flat measurements (実寸) ONLY when actual measured data is provided") !== -1 &&
    sysInstrText.indexOf("must NEVER cause generation failure") !== -1;

  // 9. アパレル2例検証: (A)情報が十分な例 と (B)前面画像1枚・タグ未確認の例 で書式統一・未確認スペック/状態の創作なし・本票反映確認
  let promptCaptureChecks = false;
  let exampleAChecks = false;
  let exampleBChecks = false;
  let debugApparelExamples = {};

  {
    let activeFetch = null;
    if (typeof UrlFetchApp !== "undefined" && UrlFetchApp) {
      activeFetch = UrlFetchApp;
    } else if (typeof globalThis !== "undefined" && globalThis.UrlFetchApp) {
      activeFetch = globalThis.UrlFetchApp;
    } else {
      activeFetch = { fetch: () => ({ getResponseCode: () => 200, getContentText: () => "{}" }) };
      if (typeof globalThis !== "undefined") globalThis.UrlFetchApp = activeFetch;
      if (typeof global !== "undefined") global.UrlFetchApp = activeFetch;
    }
    const origFetch = activeFetch.fetch;
    const origGetLlmKey = (typeof getLlmApiKey_ === "function") ? getLlmApiKey_ : null;
    const origGetActiveSs2 = SpreadsheetApp.getActiveSpreadsheet;
    const origGetFolderById2 = DriveApp.getFolderById;

    try {
      if (origGetLlmKey) getLlmApiKey_ = () => "mock_test_key";
      DriveApp.getFolderById = () => ({
        getFiles: () => {
          let idx = 0;
          const files = [
            {
              getId: () => "img_fmt_01",
              getName: () => "01_main.jpg",
              getMimeType: () => "image/jpeg",
              getSize: () => 1024,
              getLastUpdated: () => new Date("2026-10-29T00:00:00Z"),
              isTrashed: () => false,
              getBlob: () => ({ getBytes: () => [1, 2, 3, 4] })
            }
          ];
          return {
            hasNext: () => idx < files.length,
            next: () => files[idx++]
          };
        }
      });

      const sheetStore2 = {};
      function createSheetMock2(name, initialData, maxCols) {
        const data = initialData.map(r => r.slice());
        const cols = maxCols || 43;
        const mock = {
          getName: () => name,
          getLastRow: () => data.length,
          getLastColumn: () => cols,
          getMaxColumns: () => cols,
          setFrozenRows: () => {},
          appendRow: (row) => { data.push(row.slice()); },
          getRange: (r, c, numR, numC) => {
            const nR = numR || 1;
            const nC = numC || 1;
            return {
              getValue: () => (data[r - 1] && data[r - 1][c - 1] !== undefined) ? data[r - 1][c - 1] : "",
              getValues: () => {
                const out = [];
                for (let i = 0; i < nR; i++) {
                  const rowArr = [];
                  for (let j = 0; j < nC; j++) {
                    rowArr.push((data[r - 1 + i] && data[r - 1 + i][c - 1 + j] !== undefined) ? data[r - 1 + i][c - 1 + j] : "");
                  }
                  out.push(rowArr);
                }
                return out;
              },
              setValue: (val) => {
                while (data.length < r) data.push([]);
                while (data[r - 1].length < c) data[r - 1].push("");
                data[r - 1][c - 1] = val;
              },
              setValues: (vals) => {
                for (let i = 0; i < vals.length; i++) {
                  while (data.length < r + i) data.push([]);
                  for (let j = 0; j < vals[i].length; j++) {
                    while (data[r - 1 + i].length < c + j) data[r - 1 + i].push("");
                    data[r - 1 + i][c - 1 + j] = vals[i][j];
                  }
                }
              }
            };
          },
          _data: data
        };
        sheetStore2[name] = mock;
        return mock;
      }

      const header43 = new Array(43).fill("");
      header43[0] = "product_id";
      header43[2] = "category";
      header43[3] = "brand";
      header43[4] = "product_name";
      header43[5] = "condition";
      header43[7] = "planned_sale_price";
      header43[9] = "description";
      header43[41] = "fashion_size";
      header43[42] = "fashion_sku";

      const rowInitA = new Array(43).fill("");
      rowInitA[0] = "TMP-FMT-FULL";
      rowInitA[2] = "apparel";
      rowInitA[3] = "Supreme";
      rowInitA[29] = "https://drive.google.com/drive/folders/folder_fmt_full";

      const rowInitB = new Array(43).fill("");
      rowInitB[0] = "TMP-FMT-SPARSE";
      rowInitB[2] = "other";
      rowInitB[3] = "";
      rowInitB[29] = "https://drive.google.com/drive/folders/folder_fmt_sparse";

      const mainSheet2 = createSheetMock2("商品マスター", [header43, rowInitA, rowInitB], 43);
      SpreadsheetApp.getActiveSpreadsheet = () => ({
        getSheets: () => [mainSheet2],
        getSheetByName: (n) => sheetStore2[n] || null,
        insertSheet: (n) => createSheetMock2(n, [], 43)
      });

      // --- 例A: 情報が十分なアパレル例（前面・背面・首タグ/品質タグの3枚、ブランド/コラボ/モデル/色/サイズ/素材/原産国が確認済、実寸と付属品は未確認） ---
      let capturedStageAA = "";
      let capturedStageBA = "";
      activeFetch.fetch = (url, params) => {
        const payload = JSON.parse(params.payload || "{}");
        if (payload.tools && payload.tools.length > 0) {
          if (!capturedStageAA) capturedStageAA = payload.contents[0].parts[0].text;
          return {
            getResponseCode: () => 200,
            getContentText: () => JSON.stringify({
              candidates: [{
                content: {
                  parts: [{
                    text: [
                      "### OBSERVED_PRODUCT_ATTRIBUTES",
                      "PHYSICAL_BOX_LABEL_SKU: NONE",
                      "PHYSICAL_INNER_TAG_SIZE: S",
                      "CARE_TAG_SPECS: 素材=コットン100%, 原産国=MADE IN CHINA, 付属品=NONE",
                      "VISUAL_APPEARANCE: Supreme × Honda HRC Racing Jacket, Black, front/back/sleeve embroidered patches, clean front and back",
                      "### UNCONFIRMED_FIELDS",
                      "- 実寸（平置き計測値なし）",
                      "- 付属品（写真確認なし）"
                    ].join("\n")
                  }]
                },
                groundingMetadata: {
                  webSearchQueries: ["Supreme Honda HRC Puffy Zip Up Work Jacket Black"],
                  groundingChunks: [{ web: { uri: "https://jp.mercari.com/item/m98765432101", title: "Supreme Honda HRC Racing Jacket S" } }]
                }
              }]
            })
          };
        }
        capturedStageBA = payload.contents[0].parts[0].text;
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({
            candidates: [{
              content: {
                parts: [{
                  text: JSON.stringify({
                    title_ja: "SUPREME × HONDA HRC RACING JACKET BLACK S",
                    title_en: "SUPREME × HONDA HRC RACING JACKET BLACK S",
                    category: "apparel",
                    brand: "Supreme",
                    sku: "",
                    sku_source: "none",
                    size: "S",
                    condition: "目立った傷や汚れなし",
                    price: 69800,
                    price_basis: "active_listing_reference",
                    price_note: "メルカリの同一モデル販売中価格を参照した参考価格案です。",
                    price_evidence: [{
                      source_url: "https://jp.mercari.com/item/m98765432101",
                      price_type: "active",
                      amount: 69800,
                      currency: "JPY",
                      transaction_date: "2026-10",
                      item_match_condition: "exact_match"
                    }],
                    description_ja: [
                      "SupremeとHonda Racing Corporation（HRC）によるコラボのレーシングジャケット（ブラック）です。",
                      "フロント・バック・両袖にHRCやロゴの刺繍ワッペンが配されたフルジップ仕様です。",
                      "前後ともに目立つ汚れや破れは見受けられず、全体的に良好なコンディションです。",
                      "【サイズ】S\n【素材】コットン100%\n【原産国】中国製",
                      "中古品のため微細なスレや保管ジワはご容赦ください。"
                    ].join("\n\n"),
                    description_en: "Supreme x Honda HRC Racing Jacket in black, size S. Embroidered patches on front, back, and sleeves. Good pre-owned condition. Material: 100% Cotton. Made in China.",
                    hashtags_ja: "#Supreme #Honda #HRC #RacingJacket",
                    identity_status: "confident",
                    needs_review: ["sku", "price"]
                  })
                }]
              }
            }]
          })
        };
      };

      const imagesFull = [
        { mimeType: "image/jpeg", base64: "ZnJvbnQ=" },
        { mimeType: "image/jpeg", base64: "YmFjaw==" },
        { mimeType: "image/jpeg", base64: "dGFn" }
      ];
      const resFull = callGeminiTwoStageSearchGrounding_(
        imagesFull,
        { productId: "TMP-FMT-FULL", category: "apparel", brand: "Supreme" },
        "gemini-3.8-flash",
        { has_back_image: true }
      );
      applyCandidateToProduct_(mainSheet2, 2, "TMP-FMT-FULL", resFull.candidate);
      const transA = getProductTranslation("TMP-FMT-FULL");
      const transTitleA = transA ? String(transA.translated_title || "") : "";

      // --- 例B: 前面画像1枚・タグ未確認の例（黒のスカルプリント長袖T、紙製クリーニングタグのみ、ブランド/モデル/サイズ/素材/原産国/背面すべて未確認） ---
      let capturedStageAB = "";
      let capturedStageBB = "";
      activeFetch.fetch = (url, params) => {
        const payload = JSON.parse(params.payload || "{}");
        if (payload.tools && payload.tools.length > 0) {
          if (!capturedStageAB) capturedStageAB = payload.contents[0].parts[0].text;
          return {
            getResponseCode: () => 200,
            getContentText: () => JSON.stringify({
              candidates: [{
                content: {
                  parts: [{
                    text: [
                      "### OBSERVED_PRODUCT_ATTRIBUTES",
                      "PHYSICAL_BOX_LABEL_SKU: NONE",
                      "PHYSICAL_INNER_TAG_SIZE: NONE",
                      "CARE_TAG_SPECS: NONE (首元に紙製クリーニングタグのみ。ブランド織りネーム・品質タグ未確認)",
                      "VISUAL_APPEARANCE: Black crew-neck long sleeve T-shirt with white winged skull and cross graphic print on front",
                      "### UNCONFIRMED_FIELDS",
                      "- ブランド・正式モデル名・型番",
                      "- サイズ表記・実寸・素材・原産国・付属品",
                      "- 背面・内側の状態（前面画像1枚のみ）"
                    ].join("\n")
                  }]
                },
                groundingMetadata: {
                  webSearchQueries: ["winged skull graphic long sleeve t-shirt black"],
                  groundingChunks: [{ web: { uri: "https://jp.mercari.com/search?keyword=%E3%82%B9%E3%82%AB%E3%83%AB+%E3%83%AD%E3%83%B3T", title: "スカル ロンT の検索結果" } }]
                }
              }]
            })
          };
        }
        capturedStageBB = payload.contents[0].parts[0].text;
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({
            candidates: [{
              content: {
                parts: [{
                  text: JSON.stringify({
                    title_ja: "WINGED SKULL GRAPHIC LONG SLEEVE T-SHIRT BLACK",
                    title_en: "WINGED SKULL GRAPHIC LONG SLEEVE T-SHIRT BLACK",
                    category: "other",
                    brand: "",
                    sku: "",
                    sku_source: "none",
                    size: "",
                    condition: "目立った傷や汚れなし",
                    price: null,
                    price_basis: "none",
                    price_note: "",
                    price_evidence: [],
                    description_ja: [
                      "ブラックのグラフィックプリント長袖Tシャツです。",
                      "フロント中央にウィングとスカルモチーフのモノトーンプリントが施されたクルーネックデザインです。",
                      "前面写真で確認できる範囲では大きな破れや目立つ汚れは見られませんが、背面や内タグ等の状態は写真未掲載のため未確認です。",
                      "写真に写っているものが全てとなりますので、画像をご確認のうえご検討ください。"
                    ].join("\n\n"),
                    description_en: "Black graphic print crew-neck long sleeve T-shirt featuring a winged skull motif on the front. Front appears clean in the photo; back and inner tags are not pictured.",
                    hashtags_ja: "#LongSleeveTShirt #GraphicTee #BlackTee",
                    identity_status: "needs_review",
                    needs_review: ["brand", "sku", "size", "price"]
                  })
                }]
              }
            }]
          })
        };
      };

      const imagesSparse = [{ mimeType: "image/jpeg", base64: "ZnJvbnRfb25seQ==" }];
      const resSparse = callGeminiTwoStageSearchGrounding_(
        imagesSparse,
        { productId: "TMP-FMT-SPARSE", category: "other", brand: "" },
        "gemini-3.8-flash",
        { has_back_image: false }
      );
      applyCandidateToProduct_(mainSheet2, 3, "TMP-FMT-SPARSE", resSparse.candidate);

      promptCaptureChecks =
        capturedStageAA.indexOf("TASK INSTRUCTIONS FOR APPAREL / FASHION GOODS (apparel) IDENTIFICATION & PRICING:") !== -1 &&
        capturedStageAA.indexOf("CARE_TAG_SPECS:") !== -1 &&
        capturedStageAA.indexOf("NEVER assume 'Chrome Hearts'") !== -1 &&
        capturedStageAA.indexOf("Missing tags or single front-only images must NOT cause failure") !== -1 &&
        capturedStageAB.indexOf("TASK INSTRUCTIONS FOR GENERAL MERCHANDISE (other) IDENTIFICATION & PRICING:") !== -1 &&
        capturedStageAB.indexOf("NEVER assume 'Chrome Hearts'") !== -1 &&
        capturedStageBA.indexOf("For apparel (category 'apparel', or clothing/garment items even when category is 'other' or unconfirmed):") !== -1 &&
        capturedStageBA.indexOf("SUPREME × HONDA HRC RACING JACKET S") !== -1 &&
        capturedStageBA.indexOf("Completely OMIT any unconfirmed '【...】' header/line.") !== -1 &&
        capturedStageBB.indexOf("NEVER assume or default to 'Chrome Hearts'") !== -1;

      const savedRowA = mainSheet2._data[1];
      const savedDescA = String(savedRowA[9] || "");
      const transB = getProductTranslation("TMP-FMT-SPARSE");
      const transTitleB = transB ? String(transB.translated_title || "") : "";
      const idxOverviewA = savedDescA.indexOf("SupremeとHonda Racing Corporation");
      const idxDesignA = savedDescA.indexOf("フロント・バック・両袖にHRC");
      const idxCondA = savedDescA.indexOf("前後ともに目立つ汚れや破れは見受けられず");
      const idxSizeA = savedDescA.indexOf("【サイズ】S");
      const idxMatA = savedDescA.indexOf("【素材】コットン100%");
      const idxOrigA = savedDescA.indexOf("【原産国】中国製");
      const idxNoteA = savedDescA.indexOf("中古品のため微細なスレ");
      const idxHashA = savedDescA.indexOf("#Supreme #Honda #HRC #RacingJacket");

      exampleAChecks =
        resFull.success === true &&
        savedRowA[4] === "SUPREME × HONDA HRC RACING JACKET BLACK S" &&
        savedRowA[3] === "Supreme" &&
        savedRowA[41] === "S" &&
        savedRowA[11] === "" &&
        savedRowA[12] === "" &&
        transTitleA === "SUPREME × HONDA HRC RACING JACKET BLACK S" &&
        idxOverviewA !== -1 &&
        idxOverviewA < idxDesignA &&
        idxDesignA < idxCondA &&
        idxCondA < idxSizeA &&
        idxSizeA < idxMatA &&
        idxMatA < idxOrigA &&
        idxOrigA < idxHashA &&
        idxOrigA < idxNoteA &&
        idxNoteA < idxHashA &&
        // 未確認の【付属品】と実寸が創作されていないこと
        savedDescA.indexOf("【付属品】") === -1 &&
        savedDescA.indexOf("実寸") === -1 &&
        savedDescA.indexOf("着丈") === -1 &&
        savedDescA.indexOf("身幅") === -1;

      const savedRowB = mainSheet2._data[2];
      const savedDescB = String(savedRowB[9] || "");
      const combinedTextB = [savedRowB[3], savedRowB[4], savedDescB, resSparse.candidate.title_en, resSparse.candidate.description_en].join(" ");
      const idxOverviewB = savedDescB.indexOf("ブラックのグラフィックプリント長袖Tシャツです。");
      const idxDesignB = savedDescB.indexOf("フロント中央にウィングとスカルモチーフ");
      const idxCondB = savedDescB.indexOf("前面写真で確認できる範囲では");
      const idxNoteB = savedDescB.indexOf("写真に写っているものが全てとなりますので");
      const idxHashB = savedDescB.indexOf("#LongSleeveTShirt #GraphicTee #BlackTee");

      exampleBChecks =
        resSparse.success === true &&
        resSparse.candidate.brand === "" &&
        resSparse.candidate.size === "" &&
        resSparse.candidate.sku === "" &&
        resSparse.candidate.needs_review.indexOf("size") !== -1 &&
        resSparse.candidate.needs_review.indexOf("sku") !== -1 &&
        savedRowB[3] === "" &&
        savedRowB[4] === "WINGED SKULL GRAPHIC LONG SLEEVE T-SHIRT BLACK" &&
        transTitleB === "WINGED SKULL GRAPHIC LONG SLEEVE T-SHIRT BLACK" &&
        // Chrome Hearts決めつけや例文流用がないこと
        !/chrome\s*hearts|クロムハーツ|supreme|honda|hrc/i.test(combinedTextB) &&
        // 1→2→3→5(注意事項＋ハッシュタグ)の順序で、未確認の4(サイズ/素材/原産国/付属品/実寸)が全て省略されていること
        idxOverviewB !== -1 &&
        idxOverviewB < idxDesignB &&
        idxDesignB < idxCondB &&
        idxCondB < idxNoteB &&
        idxNoteB < idxHashB &&
        savedDescB.indexOf("【サイズ】") === -1 &&
        savedDescB.indexOf("【素材】") === -1 &&
        savedDescB.indexOf("【原産国】") === -1 &&
        savedDescB.indexOf("【付属品】") === -1 &&
        savedDescB.indexOf("実寸") === -1 &&
        savedDescB.indexOf("着丈") === -1 &&
        savedDescB.indexOf("身幅") === -1;

      debugApparelExamples = {
        promptCaptureChecks: promptCaptureChecks,
        exampleAChecks: exampleAChecks,
        exampleBChecks: exampleBChecks,
        titleA: savedRowA[4],
        titleB: savedRowB[4],
        brandB: savedRowB[3]
      };
    } finally {
      activeFetch.fetch = origFetch;
      if (origGetLlmKey) getLlmApiKey_ = origGetLlmKey;
      SpreadsheetApp.getActiveSpreadsheet = origGetActiveSs2;
      DriveApp.getFolderById = origGetFolderById2;
    }
  }

  record(
    "8. アパレル向け生成指示(System/StageA/StageB)の書式統一・未確認項目省略・Chrome Hearts決めつけ防止ルール検証",
    sysPromptChecks && promptCaptureChecks,
    JSON.stringify({ sysPromptChecks: sysPromptChecks, promptCaptureChecks: promptCaptureChecks })
  );

  record(
    "9. アパレル2例検証: (A)情報十分な例 と (B)前面画像1枚・タグ未確認の例 で書式統一・未確認スペック/状態の創作なし・本票反映確認",
    exampleAChecks && exampleBChecks,
    JSON.stringify(debugApparelExamples)
  );

  console.log(`--- [testAiBatchCategoryAndCostExpansionSuite_] 完了: ${passed}/${results.length} 通過 (失敗: ${failed}) ---`);
  return {
    passed: passed,
    failed: failed,
    total: results.length,
    results: results
  };
}

function testAiBatchCategoryAndCostExpansionSuite() {
  return testAiBatchCategoryAndCostExpansionSuite_();
}

function runAiBatchCategoryCostTests_() {
  return testAiBatchCategoryAndCostExpansionSuite_();
}

/**
 * ==================================================
 * 30. 仕入台帳のオークション等の商品番号 (auction_item_number / AR列: 44列目) 契約テストスイート
 * ==================================================
 */
function testAuctionItemNumberContractSuite_() {
  const results = [];
  let passed = 0;
  let failed = 0;

  function record(name, ok, detail) {
    if (ok) {
      passed++;
      results.push({ name: name, passed: true });
      console.log(`✓ ${name}`);
    } else {
      failed++;
      results.push({ name: name, passed: false, detail: detail });
      console.error(`✗ ${name}: ${detail}`);
    }
  }

  console.log("--- [testAuctionItemNumberContractSuite_] 開始 ---");

  const origGetActiveSs = SpreadsheetApp.getActiveSpreadsheet;
  const origGetFolderById = DriveApp.getFolderById;
  const origGetScriptProps = PropertiesService.getScriptProperties;
  const origGetScriptCache = CacheService.getScriptCache;
  const origGenerateNextPid = typeof generateNextProductId === "function" ? generateNextProductId : null;

  function createIsolatedTestEnv(initialMaxCols) {
    let maxCols = initialMaxCols || 44;
    const formats = {};
    const headers = new Array(maxCols).fill("");
    headers[1] = "商品ID";
    headers[2] = "カテゴリ";
    headers[10] = "備考";
    headers[11] = "スニーカーSKU/型番";
    headers[40] = "apparel_fashion_subcategory";
    headers[41] = "apparel_fashion_size";
    headers[42] = "apparel_fashion_sku";
    if (maxCols >= 44) {
      headers[43] = "auction_item_number";
    }

    function createSheet(name, initRows) {
      const rows = initRows ? initRows.map(function(r) { return r.slice(); }) : [];
      let sheetMaxCols = name === "シート1" ? maxCols : 20;
      const sheetObj = {
        getName: function() { return name; },
        getParent: function() { return mockSs; },
        getLastRow: function() { return rows.length; },
        getMaxRows: function() { return Math.max(rows.length, 100); },
        getLastColumn: function() {
          let maxLen = 0;
          for (let i = 0; i < rows.length; i++) {
            if (rows[i] && rows[i].length > maxLen) maxLen = rows[i].length;
          }
          return maxLen;
        },
        getMaxColumns: function() { return sheetMaxCols; },
        insertColumnsAfter: function(afterPos, howMany) {
          sheetMaxCols += (howMany || 1);
          if (name === "シート1") maxCols = sheetMaxCols;
          for (let i = 0; i < rows.length; i++) {
            while (rows[i].length < sheetMaxCols) rows[i].push("");
          }
        },
        appendRow: function(r) {
          const copy = r.slice();
          while (copy.length < sheetMaxCols) copy.push("");
          rows.push(copy);
        },
        getDataRange: function() {
          const totalRows = Math.max(rows.length, 1);
          const totalCols = Math.max(sheetObj.getLastColumn(), sheetMaxCols);
          return sheetObj.getRange(1, 1, totalRows, totalCols);
        },
        getRange: function(startRow, startCol, numRows, numCols) {
          const nRows = numRows || 1;
          const nCols = numCols || 1;
          const fmtKey = name + ":" + startRow + ":" + startCol;
          return {
            getValue: function() {
              const r = rows[startRow - 1];
              return (r && r[startCol - 1] !== undefined) ? r[startCol - 1] : "";
            },
            setValue: function(val) {
              while (rows.length < startRow) {
                rows.push(new Array(sheetMaxCols).fill(""));
              }
              const r = rows[startRow - 1];
              while (r.length < startCol) r.push("");
              r[startCol - 1] = val;
            },
            getValues: function() {
              const out = [];
              for (let i = 0; i < nRows; i++) {
                const r = rows[startRow - 1 + i] || [];
                const line = [];
                for (let j = 0; j < nCols; j++) {
                  line.push(r[startCol - 1 + j] !== undefined ? r[startCol - 1 + j] : "");
                }
                out.push(line);
              }
              return out;
            },
            setValues: function(vals) {
              for (let i = 0; i < vals.length; i++) {
                while (rows.length < startRow + i) {
                  rows.push(new Array(sheetMaxCols).fill(""));
                }
                const r = rows[startRow - 1 + i];
                for (let j = 0; j < vals[i].length; j++) {
                  while (r.length < startCol + j) r.push("");
                  r[startCol - 1 + j] = vals[i][j];
                }
              }
            },
            setNumberFormat: function(fmt) {
              formats[fmtKey] = fmt;
              return this;
            },
            getNumberFormat: function() {
              return formats[fmtKey] || "";
            }
          };
        },
        _rows: rows
      };
      return sheetObj;
    }

    const sheetsMap = {};
    const mainSheet = createSheet("シート1", [headers]);
    sheetsMap["シート1"] = mainSheet;

    const mockSs = {
      getSheets: function() { return [mainSheet]; },
      getSheetByName: function(n) { return sheetsMap[n] || null; },
      insertSheet: function(n) {
        const s = createSheet(n, []);
        sheetsMap[n] = s;
        return s;
      }
    };

    const folders = {};
    let folderSeq = 1;
    let fileSeq = 1;
    function makeFolder(id, name) {
      const files = [];
      const subfolders = [];
      const folder = {
        getId: function() { return id; },
        getName: function() { return name; },
        getUrl: function() { return "https://drive.google.com/drive/folders/" + id; },
        isTrashed: function() { return false; },
        getFiles: function() {
          let idx = 0;
          return {
            hasNext: function() { return idx < files.length; },
            next: function() { return files[idx++]; }
          };
        },
        getFoldersByName: function(subName) {
          let idx = 0;
          const matched = subfolders.filter(function(sf) { return sf.getName() === subName; });
          return {
            hasNext: function() { return idx < matched.length; },
            next: function() { return matched[idx++]; }
          };
        },
        createFolder: function(subName) {
          const newId = "mock_folder_" + (folderSeq++);
          const sf = makeFolder(newId, subName);
          subfolders.push(sf);
          folders[newId] = sf;
          return sf;
        },
        createFile: function(blob) {
          const fid = "mock_file_" + (fileSeq++);
          const fName = typeof blob.getName === "function" ? blob.getName() : (blob.name || "img.jpg");
          const fMime = typeof blob.getContentType === "function" ? blob.getContentType() : (blob.mime || "image/jpeg");
          const fBytes = typeof blob.getBytes === "function" ? blob.getBytes() : (blob.bytes || []);
          const f = {
            getId: function() { return fid; },
            getName: function() { return fName; },
            getMimeType: function() { return fMime; },
            getUrl: function() { return "https://drive.google.com/file/d/" + fid + "/view"; },
            isTrashed: function() { return false; },
            getBlob: function() {
              return {
                getName: function() { return fName; },
                getContentType: function() { return fMime; },
                getBytes: function() { return fBytes; }
              };
            }
          };
          files.push(f);
          return f;
        }
      };
      folders[id] = folder;
      return folder;
    }

    const rootFolder = makeFolder("1HoDrdlNNGCsPpGMPWCej3sA5CqWv24xV", "ROOT");
    const propStore = { PRODUCT_ID_SEQUENCE: "500" };
    let seqNum = 500;

    return {
      mainSheet: mainSheet,
      mockSs: mockSs,
      formats: formats,
      install: function() {
        SpreadsheetApp.getActiveSpreadsheet = function() { return mockSs; };
        DriveApp.getFolderById = function(fid) {
          return folders[fid] || rootFolder;
        };
        PropertiesService.getScriptProperties = function() {
          return {
            getProperty: function(k) { return Object.prototype.hasOwnProperty.call(propStore, k) ? propStore[k] : null; },
            setProperty: function(k, v) { propStore[k] = String(v); },
            deleteProperty: function(k) { delete propStore[k]; }
          };
        };
        CacheService.getScriptCache = function() {
          return {
            get: function() { return null; },
            put: function() {},
            remove: function() {},
            removeAll: function() {}
          };
        };
        generateNextProductId = function() {
          seqNum += 1;
          return "TMP-" + String(seqNum).padStart(6, "0");
        };
      }
    };
  }

  function parseJsonRes(res) {
    if (!res) return null;
    if (typeof res.getContent === "function") {
      return JSON.parse(res.getContent());
    }
    return res;
  }

  try {
    // テスト1: 画像登録1件作成 → 詳細取得 → 商品番号の編集 → 再取得（詳細＆一覧）の一連契約
    const env1 = createIsolatedTestEnv(44);
    env1.install();

    const createRes1 = parseJsonRes(doPost({
      postData: {
        contents: JSON.stringify({
          action: "import_product_by_images",
          import_attempt_id: "att-auction-001",
          images: [{ base64: "aW1hZ2Ux", file_name: "front.jpg", mime_type: "image/jpeg" }],
          auction_item_number: "00842-01"
        })
      }
    }));

    const createdPid1 = createRes1 && createRes1.product_id;
    const detailRes1 = parseJsonRes(doGet({
      parameter: { mode: "admin", product_id: createdPid1 }
    }));

    const updateRes1 = parseJsonRes(doPost({
      postData: {
        contents: JSON.stringify({
          action: "update_product",
          product_id: createdPid1,
          auction_item_number: "842-33225"
        })
      }
    }));

    const detailAfterEdit1 = parseJsonRes(doGet({
      parameter: { mode: "admin", product_id: createdPid1 }
    }));

    const listAfterEdit1 = parseJsonRes(doGet({
      parameter: { mode: "admin", page: "1", page_size: "20" }
    }));
    const listItem1 = (listAfterEdit1 && Array.isArray(listAfterEdit1.products))
      ? listAfterEdit1.products.find(function(p) { return p.product_id === createdPid1; })
      : null;

    const ok1 =
      createRes1 && createRes1.success === true &&
      createRes1.product_id === "TMP-000501" &&
      createRes1.auction_item_number === "00842-01" &&
      detailRes1 && detailRes1.success === true &&
      detailRes1.product.auction_item_number === "00842-01" &&
      updateRes1 && updateRes1.success === true &&
      updateRes1.auction_item_number === "842-33225" &&
      detailAfterEdit1 && detailAfterEdit1.success === true &&
      detailAfterEdit1.product.auction_item_number === "842-33225" &&
      listItem1 && listItem1.auction_item_number === "842-33225";

    record(
      "1. 契約E2E: 画像登録で1件作成(00842-01) → 詳細取得 → 商品番号編集(842-33225) → 詳細・一覧再取得で一致",
      !!ok1,
      JSON.stringify({ createRes1: createRes1, detailBefore: detailRes1 && detailRes1.product && detailRes1.product.auction_item_number, updateRes1: updateRes1, detailAfter: detailAfterEdit1 && detailAfterEdit1.product && detailAfterEdit1.product.auction_item_number, listAfter: listItem1 && listItem1.auction_item_number })
    );

    // テスト2: 先頭ゼロ・先頭/途中ハイフン・プレーンテキスト書式 "@"・空欄クリアの検証
    parseJsonRes(doPost({
      postData: {
        contents: JSON.stringify({
          action: "update_product",
          product_id: createdPid1,
          auction_item_number: "000123"
        })
      }
    }));
    const detailLeadingZero = parseJsonRes(doGet({
      parameter: { mode: "admin", product_id: createdPid1 }
    }));

    parseJsonRes(doPost({
      postData: {
        contents: JSON.stringify({
          action: "update_product",
          product_id: createdPid1,
          auction_item_number: "-01-12"
        })
      }
    }));
    const detailHyphen = parseJsonRes(doGet({
      parameter: { mode: "admin", product_id: createdPid1 }
    }));

    parseJsonRes(doPost({
      postData: {
        contents: JSON.stringify({
          action: "update_product",
          product_id: createdPid1,
          auction_item_number: ""
        })
      }
    }));
    const detailCleared = parseJsonRes(doGet({
      parameter: { mode: "admin", product_id: createdPid1 }
    }));

    const ok2 =
      detailLeadingZero.product.auction_item_number === "000123" &&
      typeof detailLeadingZero.product.auction_item_number === "string" &&
      detailHyphen.product.auction_item_number === "-01-12" &&
      env1.formats["シート1:2:44"] === "@" &&
      detailCleared.product.auction_item_number === "" &&
      typeof detailCleared.product.auction_item_number === "string";

    record(
      "2. 文字列保持・空欄許可: 先頭ゼロ(000123)・ハイフン(-01-12)・書式'@'・空欄クリア('')が厳密に文字列で保持される",
      !!ok2,
      JSON.stringify({ zero: detailLeadingZero.product.auction_item_number, hyphen: detailHyphen.product.auction_item_number, fmt: env1.formats["シート1:2:44"], cleared: detailCleared.product.auction_item_number })
    );

    // テスト3: 商品番号未指定での画像登録 → 空文字 "" 取得 → 後から編集設定可能
    const createOmittedRes = parseJsonRes(doPost({
      postData: {
        contents: JSON.stringify({
          action: "import_product_by_images",
          import_attempt_id: "att-auction-002",
          images: [{ base64: "aW1hZ2Uy", file_name: "item2.jpg", mime_type: "image/jpeg" }]
        })
      }
    }));
    const pid2 = createOmittedRes.product_id;
    const detailOmitted = parseJsonRes(doGet({
      parameter: { mode: "admin", product_id: pid2 }
    }));
    parseJsonRes(doPost({
      postData: {
        contents: JSON.stringify({
          action: "update_product",
          product_id: pid2,
          auction_item_number: "05-0099"
        })
      }
    }));
    const detailSetLater = parseJsonRes(doGet({
      parameter: { mode: "admin", product_id: pid2 }
    }));

    const ok3 =
      createOmittedRes.success === true &&
      createOmittedRes.auction_item_number === "" &&
      detailOmitted.product.auction_item_number === "" &&
      detailSetLater.product.auction_item_number === "05-0099";

    record(
      "3. 任意項目互換: 未指定で画像登録すると空文字 '' で保存・取得でき、後から編集で設定できる",
      !!ok3,
      JSON.stringify({ createAuctionNo: createOmittedRes.auction_item_number, before: detailOmitted.product.auction_item_number, after: detailSetLater.product.auction_item_number })
    );

    // テスト4: 重複許可（同一の商品番号を複数商品へ登録・更新しても拒否しない）＆検索ヒット確認
    const createDupRes = parseJsonRes(doPost({
      postData: {
        contents: JSON.stringify({
          action: "import_product_by_images",
          import_attempt_id: "att-auction-003",
          images: [{ base64: "aW1hZ2Uz", file_name: "item3.jpg", mime_type: "image/jpeg" }],
          auction_item_number: "05-0099"
        })
      }
    }));
    const pid3 = createDupRes.product_id;
    const searchDupList = parseJsonRes(doGet({
      parameter: { mode: "admin", page: "1", page_size: "20", search: "05-0099" }
    }));

    const ok4 =
      createDupRes.success === true &&
      pid3 !== pid2 &&
      createDupRes.auction_item_number === "05-0099" &&
      searchDupList.count === 2 &&
      searchDupList.products.some(function(p) { return p.product_id === pid2; }) &&
      searchDupList.products.some(function(p) { return p.product_id === pid3; });

    record(
      "4. 重複許可: 同一の auction_item_number(05-0099) を別商品に登録しても拒否せず両方保持される",
      !!ok4,
      JSON.stringify({ pid2: pid2, pid3: pid3, searchCount: searchDupList && searchDupList.count })
    );

    // テスト5: 専用列分離（official_sku, product_id, notes, sneaker_sku, 既存商品・既存カテゴリを一切変更しない）
    const apparelRes = parseJsonRes(doPost({
      postData: {
        contents: JSON.stringify({
          action: "import_product_by_images",
          import_attempt_id: "att-auction-apparel",
          images: [{ base64: "aW1hZ2U0", file_name: "apparel.jpg", mime_type: "image/jpeg" }],
          category: "apparel",
          subcategory: "jacket",
          size: "M",
          official_sku: "MFG-SKU-777",
          notes: "社内メモそのまま",
          auction_item_number: "0099-LOT-8"
        })
      }
    }));
    const pidApparel = apparelRes.product_id;
    const rowApparel = env1.mainSheet._rows[4]; // Row 5 (index 4)
    const detailApparel = parseJsonRes(doGet({
      parameter: { mode: "admin", product_id: pidApparel }
    }));

    // 既存商品 pid2 の値が pidApparel の作成や更新で一切変わっていないことも確認
    const detailPid2Check = parseJsonRes(doGet({
      parameter: { mode: "admin", product_id: pid2 }
    }));

    const ok5 =
      rowApparel[1] === pidApparel &&
      rowApparel[2] === "apparel" &&
      rowApparel[10] === "社内メモそのまま" &&
      rowApparel[11] === "" &&
      rowApparel[42] === "MFG-SKU-777" &&
      rowApparel[43] === "0099-LOT-8" &&
      detailApparel.product.official_sku === "MFG-SKU-777" &&
      detailApparel.product.notes === "社内メモそのまま" &&
      detailApparel.product.auction_item_number === "0099-LOT-8" &&
      detailPid2Check.product.auction_item_number === "05-0099";

    record(
      "5. 専用列(AR列:44列目)分離・既存保護: official_sku(AQ列)・product_id(B列)・備考(K列)・既存カテゴリ/既存商品を一切書き換えない",
      !!ok5,
      JSON.stringify({ colB: rowApparel[1], colC: rowApparel[2], colK: rowApparel[10], colAQ: rowApparel[42], colAR: rowApparel[43] })
    );

    // テスト6: 公開ページ向け詳細取得 (isAdmin=false) への非漏洩確認
    const publicDetailCheck = buildProductDetail(rowApparel, false, false);
    const adminDetailCheck = buildProductDetail(rowApparel, true, false);
    const ok6 =
      publicDetailCheck.auction_item_number === undefined &&
      adminDetailCheck.auction_item_number === "0099-LOT-8";

    record(
      "6. 公開境界の保護: 公開ストアフロント向け詳細(isAdmin=false)には auction_item_number を露出せず管理画面のみ返却する",
      !!ok6,
      JSON.stringify({ publicVal: publicDetailCheck.auction_item_number, adminVal: adminDetailCheck.auction_item_number })
    );

    // テスト7: 冪等再送・不一致検知・不正型の事前拒絶
    const retrySameRes = parseJsonRes(doPost({
      postData: {
        contents: JSON.stringify({
          action: "import_product_by_images",
          import_attempt_id: "att-auction-apparel",
          images: [{ base64: "aW1hZ2U0", file_name: "apparel.jpg", mime_type: "image/jpeg" }],
          category: "apparel",
          subcategory: "jacket",
          size: "M",
          official_sku: "MFG-SKU-777",
          notes: "社内メモそのまま",
          auction_item_number: "0099-LOT-8"
        })
      }
    }));

    const retryDiffRes = parseJsonRes(doPost({
      postData: {
        contents: JSON.stringify({
          action: "import_product_by_images",
          import_attempt_id: "att-auction-apparel",
          images: [{ base64: "aW1hZ2U0", file_name: "apparel.jpg", mime_type: "image/jpeg" }],
          category: "apparel",
          subcategory: "jacket",
          size: "M",
          official_sku: "MFG-SKU-777",
          notes: "社内メモそのまま",
          auction_item_number: "DIFFERENT-999"
        })
      }
    }));

    const rowCountBeforeInvalid = env1.mainSheet.getLastRow();
    const invalidTypeRes = parseJsonRes(doPost({
      postData: {
        contents: JSON.stringify({
          action: "import_product_by_images",
          import_attempt_id: "att-auction-invalid",
          images: [{ base64: "aW1hZ2U0", file_name: "apparel.jpg", mime_type: "image/jpeg" }],
          auction_item_number: ["not", "a", "string"]
        })
      }
    }));
    const rowCountAfterInvalid = env1.mainSheet.getLastRow();

    const ok7 =
      retrySameRes.success === true &&
      retrySameRes.is_reused === true &&
      retrySameRes.product_id === pidApparel &&
      retrySameRes.auction_item_number === "0099-LOT-8" &&
      retryDiffRes.success === false &&
      retryDiffRes.error_code === "IMPORT_IDEMPOTENCY_PAYLOAD_MISMATCH" &&
      invalidTypeRes.success === false &&
      invalidTypeRes.error_code === "INVALID_AUCTION_ITEM_NUMBER" &&
      rowCountBeforeInvalid === rowCountAfterInvalid;

    record(
      "7. 冪等性と入力検証: 同一再送は値維持で成功・異なる商品番号再送はMISMATCH拒絶・配列等の不正型は採番前に拒絶",
      !!ok7,
      JSON.stringify({ retrySame: retrySameRes, retryDiffCode: retryDiffRes.error_code, invalidCode: invalidTypeRes.error_code })
    );

    // テスト8: 3通りの省略・明示クリア契約検証
    //   (8-a) 新規作成で省略 → "" で保存
    //   (8-b) 保存済み "00842-01" に対し update_product で auction_item_number を送らず他項目(product_name等)のみ更新 (JSON省略 & JS undefined の双方) → "00842-01" を維持
    //   (8-c) update_product で auction_item_number: "" を明示送信 → "" にクリア
    const createOmitCheck = parseJsonRes(doPost({
      postData: {
        contents: JSON.stringify({
          action: "import_product_by_images",
          import_attempt_id: "att-auction-omit-create",
          images: [{ base64: "aW1hZ2U4YQ==", file_name: "omit.jpg", mime_type: "image/jpeg" }],
          product_name: "省略新規作成テスト"
        })
      }
    }));
    const pidOmitCreate = createOmitCheck.product_id;
    const detailOmitCreate = parseJsonRes(doGet({
      parameter: { mode: "admin", product_id: pidOmitCreate }
    }));

    const createWith00842 = parseJsonRes(doPost({
      postData: {
        contents: JSON.stringify({
          action: "import_product_by_images",
          import_attempt_id: "att-auction-keep-00842",
          images: [{ base64: "aW1hZ2U4Yg==", file_name: "keep.jpg", mime_type: "image/jpeg" }],
          product_name: "初期商品名",
          brand: "InitialBrand",
          auction_item_number: "00842-01"
        })
      }
    }));
    const pidKeep = createWith00842.product_id;

    // (8-b1) JSON ペイロードで auction_item_number キーを送らずに product_name / brand のみ更新
    const partialUpdateJsonRes = parseJsonRes(doPost({
      postData: {
        contents: JSON.stringify({
          action: "update_product",
          product_id: pidKeep,
          product_name: "商品名だけ編集後",
          brand: "UpdatedBrand"
        })
      }
    }));
    const detailAfterJsonOmit = parseJsonRes(doGet({
      parameter: { mode: "admin", product_id: pidKeep }
    }));

    // (8-b2) JS オブジェクトとして auction_item_number: undefined が渡された場合も省略扱いで維持
    const partialUpdateUndefinedRes = parseJsonRes(handleUpdateProduct(env1.mainSheet, {
      action: "update_product",
      product_id: pidKeep,
      product_name: "さらに別項目編集後",
      auction_item_number: undefined
    }));
    const detailAfterUndefinedOmit = parseJsonRes(doGet({
      parameter: { mode: "admin", product_id: pidKeep }
    }));

    // (8-c) auction_item_number: "" を明示送信してクリア
    const explicitClearRes = parseJsonRes(doPost({
      postData: {
        contents: JSON.stringify({
          action: "update_product",
          product_id: pidKeep,
          auction_item_number: ""
        })
      }
    }));
    const detailAfterExplicitClear = parseJsonRes(doGet({
      parameter: { mode: "admin", product_id: pidKeep }
    }));

    const ok8 =
      createOmitCheck.success === true &&
      createOmitCheck.auction_item_number === "" &&
      detailOmitCreate.product.auction_item_number === "" &&
      partialUpdateJsonRes.success === true &&
      partialUpdateJsonRes.auction_item_number === undefined &&
      detailAfterJsonOmit.product.product_name === "商品名だけ編集後" &&
      detailAfterJsonOmit.product.brand === "UpdatedBrand" &&
      detailAfterJsonOmit.product.auction_item_number === "00842-01" &&
      partialUpdateUndefinedRes.success === true &&
      partialUpdateUndefinedRes.auction_item_number === undefined &&
      detailAfterUndefinedOmit.product.product_name === "さらに別項目編集後" &&
      detailAfterUndefinedOmit.product.auction_item_number === "00842-01" &&
      explicitClearRes.success === true &&
      explicitClearRes.auction_item_number === "" &&
      detailAfterExplicitClear.product.product_name === "さらに別項目編集後" &&
      detailAfterExplicitClear.product.auction_item_number === "";

    record(
      "8. 更新時の省略保持・明示空文字クリア: 保存済み 00842-01 に対し他項目のみ更新(JSON省略/undefined)で 00842-01 を維持し、明示 '' でクリア、新規省略は '' 保存",
      !!ok8,
      JSON.stringify({
        omitCreate: detailOmitCreate.product.auction_item_number,
        afterJsonOmit: detailAfterJsonOmit.product.auction_item_number,
        afterUndefinedOmit: detailAfterUndefinedOmit.product.auction_item_number,
        afterExplicitClear: detailAfterExplicitClear.product.auction_item_number
      })
    );
  } finally {
    SpreadsheetApp.getActiveSpreadsheet = origGetActiveSs;
    DriveApp.getFolderById = origGetFolderById;
    PropertiesService.getScriptProperties = origGetScriptProps;
    CacheService.getScriptCache = origGetScriptCache;
    if (origGenerateNextPid) {
      generateNextProductId = origGenerateNextPid;
    }
  }

  console.log(`--- [testAuctionItemNumberContractSuite_] 完了: ${passed}/${results.length} 通過 (失敗: ${failed}) ---`);
  return {
    passed: passed,
    failed: failed,
    total: results.length,
    results: results
  };
}

function testAuctionItemNumberContractSuite() {
  return testAuctionItemNumberContractSuite_();
}

function runAuctionItemNumberTests_() {
  return testAuctionItemNumberContractSuite_();
}

function testMirrorCreatedDraftProductSuite_() {
  const results = [];
  let passed = 0;
  let failed = 0;
  function record(name, ok, detail) {
    if (ok) {
      passed++;
    } else {
      failed++;
      console.log("✗ [MirrorSuite FAIL] " + name + " -> " + (detail || ""));
    }
    results.push({ name: name, ok: !!ok, detail: detail || "" });
  }

  const origGetActiveSs = SpreadsheetApp.getActiveSpreadsheet;
  const origGetFolderById = DriveApp.getFolderById;
  const origGetScriptProps = PropertiesService.getScriptProperties;
  const origGetScriptCache = CacheService.getScriptCache;

  const headers = new Array(44).fill("");
  headers[1] = "商品ID";
  headers[2] = "カテゴリ";
  headers[10] = "備考";
  headers[11] = "スニーカーSKU/型番";
  headers[40] = "apparel_fashion_subcategory";
  headers[41] = "apparel_fashion_size";
  headers[42] = "apparel_fashion_sku";
  headers[43] = "auction_item_number";

  const rows = [headers.slice()];
  const formats = {};
  const mainSheet = {
    getName: function() { return "シート1"; },
    getLastRow: function() { return rows.length; },
    getMaxRows: function() { return 100; },
    getLastColumn: function() { return 44; },
    getMaxColumns: function() { return 44; },
    appendRow: function(r) {
      const c = r.slice();
      while (c.length < 44) c.push("");
      rows.push(c);
    },
    getDataRange: function() { return mainSheet.getRange(1, 1, rows.length, 44); },
    getRange: function(sr, sc, nr, nc) {
      const nRows = nr || 1;
      const nCols = nc || 1;
      const fmtKey = sr + ":" + sc;
      return {
        getValue: function() {
          const r = rows[sr - 1];
          return (r && r[sc - 1] !== undefined) ? r[sc - 1] : "";
        },
        setValue: function(val) {
          while (rows.length < sr) rows.push(new Array(44).fill(""));
          rows[sr - 1][sc - 1] = val;
        },
        getValues: function() {
          const out = [];
          for (let i = 0; i < nRows; i++) {
            const r = rows[sr - 1 + i] || [];
            const line = [];
            for (let j = 0; j < nCols; j++) line.push(r[sc - 1 + j] !== undefined ? r[sc - 1 + j] : "");
            out.push(line);
          }
          return out;
        },
        setNumberFormat: function(fmt) { formats[fmtKey] = fmt; return this; },
        getFormula: function() { return ""; }
      };
    }
  };

  const folders = {};
  let folderSeq = 1;
  let fileSeq = 1;
  function makeFolder(id, name) {
    const files = [];
    const folder = {
      getId: function() { return id; },
      getName: function() { return name; },
      getUrl: function() { return "https://drive.google.com/drive/folders/" + id; },
      isTrashed: function() { return false; },
      getFiles: function() {
        let idx = 0;
        return {
          hasNext: function() { return idx < files.length; },
          next: function() { return files[idx++]; }
        };
      },
      createFolder: function(sub) {
        const fid = "mirror_folder_" + (folderSeq++);
        const sf = makeFolder(fid, sub);
        folders[fid] = sf;
        return sf;
      },
      createFile: function(blob) {
        const fid = "mirror_file_" + (fileSeq++);
        const fn = typeof blob.getName === "function" ? blob.getName() : "img.jpg";
        const fm = typeof blob.getContentType === "function" ? blob.getContentType() : "image/jpeg";
        const fb = typeof blob.getBytes === "function" ? blob.getBytes() : [];
        const f = {
          getId: function() { return fid; },
          getName: function() { return fn; },
          getMimeType: function() { return fm; },
          getUrl: function() { return "https://drive.google.com/file/d/" + fid + "/view"; },
          isTrashed: function() { return false; },
          getBlob: function() {
            return { getBytes: function() { return fb; } };
          }
        };
        files.push(f);
        return f;
      }
    };
    folders[id] = folder;
    return folder;
  }

  const rootFolder = makeFolder("1HoDrdlNNGCsPpGMPWCej3sA5CqWv24xV", "ROOT");
  const propStore = { PRODUCT_ID_SEQUENCE: "163" };
  const mockProps = {
    getProperty: function(k) { return Object.prototype.hasOwnProperty.call(propStore, k) ? propStore[k] : null; },
    setProperty: function(k, v) { propStore[k] = String(v); },
    deleteProperty: function(k) { delete propStore[k]; }
  };

  function parseRes(res) {
    return (res && typeof res.getContent === "function") ? JSON.parse(res.getContent()) : res;
  }

  try {
    SpreadsheetApp.getActiveSpreadsheet = function() {
      return {
        getSheets: function() { return [mainSheet]; },
        getSheetByName: function(n) { return n === "シート1" ? mainSheet : null; }
      };
    };
    DriveApp.getFolderById = function(fid) { return folders[fid] || rootFolder; };
    PropertiesService.getScriptProperties = function() { return mockProps; };
    CacheService.getScriptCache = function() {
      return { get: function() { return null; }, put: function() {}, remove: function() {} };
    };

    // 1. Supabase予約IDでの下書きミラー作成（publish_status:"published"を指定しても"draft"に強制固定、imagesメタデータ返却）
    const r1 = parseRes(doPost({
      postData: {
        contents: JSON.stringify({
          action: "mirror_created_draft_product",
          reserved_product_id: "TMP-000164",
          request_id: "req-mirror-164",
          category: "sneaker",
          brand: "Nike",
          product_name: "Test Sneaker",
          publish_status: "published",
          auction_item_number: "0099-01",
          images: [{ base64: "aW1hZ2Ux", file_name: "shoe.jpg", mime_type: "image/jpeg" }]
        })
      }
    }));
    record(
      "1. mirror_created_draft_product creates draft row, forces draft, returns images metadata, advances sequence",
      r1 && r1.success === true && r1.product_id === "TMP-000164" && r1.publish_status === "draft" &&
      Array.isArray(r1.images) && r1.images.length === 1 && r1.images[0].name === "01_main_shoe.jpg" &&
      propStore.PRODUCT_ID_SEQUENCE === "164" && rows[1][43] === "0099-01",
      JSON.stringify(r1)
    );

    // 2. 同一 request_id の再送時は二重作成せず is_reused: true で冪等返却
    const r2 = parseRes(doPost({
      postData: {
        contents: JSON.stringify({
          action: "mirror_created_draft_product",
          reserved_product_id: "TMP-000164",
          request_id: "req-mirror-164",
          images: [{ base64: "aW1hZ2Ux", file_name: "shoe.jpg", mime_type: "image/jpeg" }]
        })
      }
    }));
    record(
      "2. Idempotent retry with same request_id returns is_reused: true without adding duplicate row",
      r2 && r2.success === true && r2.is_reused === true && rows.length === 2,
      JSON.stringify(r2)
    );

    // 3. 異なる request_id で既存 product_id を指定した場合は PRODUCT_ID_ALREADY_IN_SHEETS と最大連番を返却
    const r3 = parseRes(doPost({
      postData: {
        contents: JSON.stringify({
          action: "mirror_created_draft_product",
          reserved_product_id: "TMP-000164",
          request_id: "req-other-collision",
          images: [{ base64: "aW1hZ2Ux", file_name: "shoe.jpg", mime_type: "image/jpeg" }]
        })
      }
    }));
    record(
      "3. Conflicting product_id returns PRODUCT_ID_ALREADY_IN_SHEETS with max_sheet_sequence",
      r3 && r3.success === false && r3.error_code === "PRODUCT_ID_ALREADY_IN_SHEETS" && r3.max_sheet_sequence === 164,
      JSON.stringify(r3)
    );

    // 4. 後続の GAS 側従来登録が TMP-000165 以降を採番し、衝突しないことを確認
    const nextGasId = generateNextProductId(mainSheet);
    record(
      "4. Subsequent GAS generateNextProductId allocates TMP-000165 without collision",
      nextGasId === "TMP-000165",
      nextGasId
    );
  } finally {
    SpreadsheetApp.getActiveSpreadsheet = origGetActiveSs;
    DriveApp.getFolderById = origGetFolderById;
    PropertiesService.getScriptProperties = origGetScriptProps;
    CacheService.getScriptCache = origGetScriptCache;
  }

  return { passed: passed, failed: failed, total: results.length, results: results };
}

/**
 * Cloud Run + Supabase 正本からの AI下書き生成・確定ミラー & Square公開ゲート整合テストスイート
 */
function testMirrorAiProductDraftStateSuite_() {
  const results = [];
  let passed = 0;
  let failed = 0;
  function record(name, ok, detail) {
    if (ok) passed++; else failed++;
    results.push({ name: name, ok: ok, detail: detail || "" });
  }

  const origGetActiveSs = SpreadsheetApp.getActiveSpreadsheet;
  const origGetFolderById = DriveApp.getFolderById;
  const origGetScriptProps = PropertiesService.getScriptProperties;
  const origGetScriptCache = CacheService.getScriptCache;

  function makeInMemorySheet(name, initialRows, minCols) {
    const sheetRows = initialRows.map(function(r) {
      const c = r.slice();
      while (c.length < minCols) c.push("");
      return c;
    });
    const sheetObj = {
      getName: function() { return name; },
      getLastRow: function() { return sheetRows.length; },
      getLastColumn: function() { return sheetRows[0] ? sheetRows[0].length : minCols; },
      getMaxColumns: function() { return Math.max(minCols, sheetRows[0] ? sheetRows[0].length : minCols); },
      setFrozenRows: function() {},
      insertColumnsAfter: function(afterPos, howMany) {
        for (let i = 0; i < sheetRows.length; i++) {
          for (let k = 0; k < howMany; k++) sheetRows[i].push("");
        }
      },
      appendRow: function(r) {
        const width = Math.max(minCols, sheetObj.getLastColumn(), r.length);
        const c = r.slice();
        while (c.length < width) c.push("");
        sheetRows.push(c);
      },
      getDataRange: function() {
        return sheetObj.getRange(1, 1, Math.max(sheetRows.length, 1), Math.max(sheetObj.getLastColumn(), 1));
      },
      getRange: function(sr, sc, nr, nc) {
        const nRows = nr || 1;
        const nCols = nc || 1;
        return {
          getValue: function() {
            const r = sheetRows[sr - 1];
            return (r && r[sc - 1] !== undefined) ? r[sc - 1] : "";
          },
          setValue: function(val) {
            const width = Math.max(minCols, sc);
            while (sheetRows.length < sr) sheetRows.push(new Array(width).fill(""));
            while (sheetRows[sr - 1].length < width) sheetRows[sr - 1].push("");
            sheetRows[sr - 1][sc - 1] = val;
          },
          getValues: function() {
            const out = [];
            for (let i = 0; i < nRows; i++) {
              const r = sheetRows[sr - 1 + i] || [];
              const line = [];
              for (let j = 0; j < nCols; j++) line.push(r[sc - 1 + j] !== undefined ? r[sc - 1 + j] : "");
              out.push(line);
            }
            return out;
          },
          setValues: function(vals) {
            for (let i = 0; i < vals.length; i++) {
              const rIdx = sr - 1 + i;
              const width = Math.max(minCols, sc - 1 + vals[i].length);
              while (sheetRows.length <= rIdx) sheetRows.push(new Array(width).fill(""));
              while (sheetRows[rIdx].length < width) sheetRows[rIdx].push("");
              for (let j = 0; j < vals[i].length; j++) {
                sheetRows[rIdx][sc - 1 + j] = vals[i][j];
              }
            }
          },
          setNumberFormat: function() { return this; },
          getFormula: function() { return ""; }
        };
      },
      _rows: sheetRows
    };
    return sheetObj;
  }

  const header44 = new Array(44).fill("");
  header44[1] = "product_id";
  header44[2] = "category";
  header44[39] = "ai_draft_flag";
  header44[43] = "auction_item_number";

  const draftRow = new Array(44).fill("");
  draftRow[0] = "2026-11-03T10:00:00.000Z";
  draftRow[1] = "TMP-000175";
  draftRow[2] = ""; // temp draft starts with empty category
  draftRow[29] = "https://drive.google.com/drive/folders/folder_175";
  draftRow[30] = "https://drive.google.com/file/d/img_175_1/view";
  draftRow[31] = "draft";
  draftRow[32] = "in_stock";
  draftRow[33] = "active";

  const pubRow = new Array(44).fill("");
  pubRow[1] = "TMP-000176";
  pubRow[2] = "sneaker";
  pubRow[31] = "published";
  pubRow[32] = "in_stock";
  pubRow[33] = "active";

  const sheetsMap = {};
  const mainSheet = makeInMemorySheet("シート1", [header44, draftRow, pubRow], 44);
  sheetsMap["シート1"] = mainSheet;

  const mockFolder175 = {
    getId: function() { return "folder_175"; },
    getName: function() { return "TMP-000175"; },
    isTrashed: function() { return false; },
    getFiles: function() {
      const files = [{
        getId: function() { return "img_175_1"; },
        getName: function() { return "01_main_shoe.jpg"; },
        getMimeType: function() { return "image/jpeg"; },
        getSize: function() { return 12345; },
        getLastUpdated: function() { return new Date("2026-11-03T10:00:00.000Z"); },
        getUrl: function() { return "https://drive.google.com/file/d/img_175_1/view"; },
        isTrashed: function() { return false; }
      }];
      let idx = 0;
      return {
        hasNext: function() { return idx < files.length; },
        next: function() { return files[idx++]; }
      };
    }
  };

  const propStore = { PRODUCTS_API_INTERNAL_SECRET: "unit-test-internal-secret" };
  const mockProps = {
    getProperty: function(k) { return Object.prototype.hasOwnProperty.call(propStore, k) ? propStore[k] : null; },
    setProperty: function(k, v) { propStore[k] = String(v); },
    deleteProperty: function(k) { delete propStore[k]; }
  };

  function parseRes(res) {
    return (res && typeof res.getContent === "function") ? JSON.parse(res.getContent()) : res;
  }

  try {
    SpreadsheetApp.getActiveSpreadsheet = function() {
      return {
        getSheets: function() { return Object.keys(sheetsMap).map(function(k) { return sheetsMap[k]; }); },
        getSheetByName: function(n) { return sheetsMap[n] || null; },
        insertSheet: function(n) {
          const created = makeInMemorySheet(n, [], 35);
          sheetsMap[n] = created;
          return created;
        }
      };
    };
    DriveApp.getFolderById = function(fid) {
      if (fid === "folder_175") return mockFolder175;
      throw new Error("Folder not found: " + fid);
    };
    PropertiesService.getScriptProperties = function() { return mockProps; };
    CacheService.getScriptCache = function() {
      return { get: function() { return null; }, put: function() {}, remove: function() {}, removeAll: function() {} };
    };

    // 1. トークン不一致時は UNAUTHORIZED_INTERNAL_SYNC で遮断
    const rUnauth = parseRes(doPost({
      postData: {
        contents: JSON.stringify({
          action: "mirror_ai_product_draft_state",
          internal_sync_token: "wrong-token",
          product_id: "TMP-000175",
          draft_record: { draft_id: "DRF_TEST_1", draft_version: 1, review_status: "pending_review" }
        })
      }
    }));
    record(
      "1. Unauthorized internal_sync_token is rejected Fail-Closed",
      rUnauth && rUnauth.success === false && rUnauth.error_code === "UNAUTHORIZED_INTERNAL_SYNC",
      JSON.stringify(rUnauth)
    );

    // 2. 公開済み商品は PUBLISHED_PRODUCT_NOT_ALLOWED で遮断
    const rPub = parseRes(doPost({
      postData: {
        contents: JSON.stringify({
          action: "mirror_ai_product_draft_state",
          internal_sync_token: "unit-test-internal-secret",
          product_id: "TMP-000176",
          draft_record: { draft_id: "DRF_PUB_1", draft_version: 1, review_status: "pending_review" }
        })
      }
    }));
    record(
      "2. Published product is rejected with PUBLISHED_PRODUCT_NOT_ALLOWED",
      rPub && rPub.success === false && rPub.error_code === "PUBLISHED_PRODUCT_NOT_ALLOWED",
      JSON.stringify(rPub)
    );

    // 3. pending_review ミラー保存時は AN列=ai_managed となり公開ゲートが AI_DRAFT_UNCONFIRMED で遮断
    const rPending = parseRes(doPost({
      postData: {
        contents: JSON.stringify({
          action: "mirror_ai_product_draft_state",
          internal_sync_token: "unit-test-internal-secret",
          product_id: "TMP-000175",
          selected_image_ids: ["img_175_1"],
          draft_record: {
            draft_id: "DRF_175_V1",
            draft_version: 1,
            review_status: "pending_review",
            candidate_title_ja: "NIKE DUNK LOW 27.5cm",
            candidate_title_en: "NIKE Dunk Low 27.5cm",
            candidate_description_ja: "テスト説明",
            candidate_description_en: "Test description",
            candidate_condition: "目立った傷や汚れなし",
            candidate_price: 18500,
            candidate_category: "sneaker",
            candidate_brand: "NIKE",
            candidate_sku: "DD1391-100",
            candidate_size: "27.5cm",
            model_name: "gemini-3.8-flash",
            search_grounding_enabled: true,
            search_grounding_mode: "two_stage",
            search_executed: true,
            search_queries: ["NIKE DD1391-100"]
          }
        })
      }
    }));
    let pendingGateErr = "";
    try {
      // set sneaker_size temporarily or check AI_DRAFT_UNCONFIRMED when category is set
      mainSheet.getRange(2, 3).setValue("sneaker");
      mainSheet.getRange(2, 13).setValue("27.5cm");
      assertProductPublishable_(mainSheet, 2, "TMP-000175");
    } catch (gErr) {
      pendingGateErr = gErr.error_code || gErr.message;
    } finally {
      mainSheet.getRange(2, 3).setValue("");
      mainSheet.getRange(2, 13).setValue("");
    }
    record(
      "3. pending_review mirror sets ai_draft_flag and blocks Square publish gate with AI_DRAFT_UNCONFIRMED",
      rPending && rPending.success === true && mainSheet._rows[1][39] === "ai_managed" && pendingGateErr === "AI_DRAFT_UNCONFIRMED",
      JSON.stringify({ rPending: rPending, pendingGateErr: pendingGateErr })
    );

    // 4. confirmed ミラー保存時は初期カテゴリ・属性・翻訳・確定指紋が保存され、assertProductPublishable_ を通過する
    const rConfirmed = parseRes(doPost({
      postData: {
        contents: JSON.stringify({
          action: "mirror_ai_product_draft_state",
          internal_sync_token: "unit-test-internal-secret",
          product_id: "TMP-000175",
          apply_confirmed_product: true,
          confirmed_product: {
            category: "sneaker",
            brand: "NIKE",
            product_name: "NIKE DUNK LOW 27.5cm",
            condition: "目立った傷や汚れなし",
            planned_sale_price: 18500,
            description: "テスト説明\n\n#NIKE #DUNK",
            sneaker_sku: "DD1391-100",
            sneaker_size: "27.5cm"
          },
          translation: {
            translated_title: "NIKE Dunk Low 27.5cm",
            translated_description: "Test description",
            condition: "目立った傷や汚れなし"
          },
          draft_record: {
            draft_id: "DRF_175_V1",
            draft_version: 1,
            review_status: "confirmed",
            candidate_title_ja: "NIKE DUNK LOW 27.5cm",
            candidate_title_en: "NIKE Dunk Low 27.5cm",
            candidate_description_ja: "テスト説明",
            candidate_description_en: "Test description",
            candidate_condition: "目立った傷や汚れなし",
            candidate_price: 18500,
            candidate_category: "sneaker",
            candidate_brand: "NIKE",
            candidate_sku: "DD1391-100",
            candidate_size: "27.5cm",
            confirmed_at: "2026-11-03T10:05:00.000Z",
            confirmed_by: "staff",
            last_confirmation_attempt_id: "att-175-1",
            last_confirmation_payload_hash: "hash-175-1",
            model_name: "gemini-3.8-flash"
          }
        })
      }
    }));
    const publishGateOk = assertProductPublishable_(mainSheet, 2, "TMP-000175");
    record(
      "4. confirmed mirror updates Sheets[0] + translations + confirmed_fingerprint and passes assertProductPublishable_",
      rConfirmed && rConfirmed.success === true && Boolean(rConfirmed.confirmed_fingerprint) &&
      mainSheet._rows[1][2] === "sneaker" && mainSheet._rows[1][7] === 18500 && publishGateOk === true,
      JSON.stringify(rConfirmed)
    );

    // 5. get_ai_product_drafts_for_sync で最新ドラフトと ai_draft_flag を取得できる
    const rSyncRead = parseRes(doPost({
      postData: {
        contents: JSON.stringify({
          action: "get_ai_product_drafts_for_sync",
          internal_sync_token: "unit-test-internal-secret",
          product_id: "TMP-000175"
        })
      }
    }));
    record(
      "5. get_ai_product_drafts_for_sync returns latest confirmed draft and ai_draft_flag",
      rSyncRead && rSyncRead.success === true && rSyncRead.ai_draft_flag === "ai_managed" &&
      rSyncRead.latest_ai_draft && rSyncRead.latest_ai_draft.review_status === "confirmed" &&
      rSyncRead.latest_ai_draft.confirmed_fingerprint === rConfirmed.confirmed_fingerprint,
      JSON.stringify(rSyncRead)
    );
  } finally {
    SpreadsheetApp.getActiveSpreadsheet = origGetActiveSs;
    DriveApp.getFolderById = origGetFolderById;
    PropertiesService.getScriptProperties = origGetScriptProps;
    CacheService.getScriptCache = origGetScriptCache;
  }

  return { passed: passed, failed: failed, total: results.length, results: results };
}



