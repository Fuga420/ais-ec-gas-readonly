function guardSandboxActionDisabled_(actionName) {
  throw new Error(
    "Square Sandbox action '" +
    actionName +
    "' is disabled in production MVP to protect production catalog IDs."
  );
}

function handleCreateSquareProduct(sheet, data) {
  guardSandboxActionDisabled_("create_square_product");

  const productId =
    String(data.product_id || "").trim();

  if (!productId) {
    throw new Error("product_id is required");
  }

  const result =
    createSquareProduct(productId);

  return jsonResponse({
    success: true,
    version: "square-product-create-v1",
    product_id: result.product_id,
    square_item_id: result.square_item_id,
    square_variation_id:
      result.square_variation_id,
    sku: result.sku,
    product_name: result.product_name,
    price_amount: result.price_amount,
    currency: result.currency
  });
}

function handleUpdateSquareProduct(sheet, data) {
  guardSandboxActionDisabled_("update_square_product");

  const productId =
    String(data.product_id || "").trim();

  if (!productId) {
    throw new Error("product_id is required");
  }

  const result =
    updateSquareProduct(productId);

  return jsonResponse({
    success: true,
    version: "square-product-update-v1",
    product_id: result.product_id,
    square_item_id: result.square_item_id,
    square_variation_id:
      result.square_variation_id,
    product_name: result.product_name,
    variation_name: result.variation_name,
    sku: result.sku,
    price_amount: result.price_amount,
    currency: result.currency
  });
}

function handleSyncSquareProductImage(sheet, data) {
  guardSandboxActionDisabled_("sync_square_product_image");

  const productId =
    String(data.product_id || "").trim();

  if (!productId) {
    throw new Error("product_id is required");
  }

  const result =
    syncSquareProductMainImage(productId);

  return jsonResponse({
    success: true,
    version: "square-product-image-sync-v1",
    product_id: result.product_id,
    square_item_id: result.square_item_id,
    square_image_id: result.square_image_id,
    square_image_url: result.square_image_url,
    drive_file_id: result.drive_file_id,
    drive_file_name: result.drive_file_name,
    mime_type: result.mime_type,
    is_primary: result.is_primary
  });
}

function handleSyncSquareProductInventory(sheet, data) {
  guardSandboxActionDisabled_("sync_square_product_inventory");

  const productId =
    String(data.product_id || "").trim();

  if (!productId) {
    throw new Error("product_id is required");
  }

  const result =
    syncSquareProductInventory(productId);

  return jsonResponse({
    success: true,
    version: "square-product-inventory-sync-v1",
    product_id: result.product_id,
    inventory_status: result.inventory_status,
    record_status: result.record_status,
    target_quantity: result.target_quantity,
    previous_square_quantity:
      result.previous_square_quantity,
    square_quantity: result.square_quantity,
    square_item_id: result.square_item_id,
    square_variation_id:
      result.square_variation_id,
    location_id: result.location_id
  });
}

function getSquareConfig() {
  const scriptProperties =
    PropertiesService
      .getScriptProperties();

  const environment = String(
    scriptProperties.getProperty(
      "SQUARE_ENV"
    ) || ""
  ).trim().toLowerCase();

  const accessToken = String(
    scriptProperties.getProperty(
      "SQUARE_ACCESS_TOKEN"
    ) || ""
  ).trim();

  const locationId = String(
    scriptProperties.getProperty(
      "SQUARE_LOCATION_ID"
    ) || ""
  ).trim();

  const apiVersion = String(
    scriptProperties.getProperty(
      "SQUARE_API_VERSION"
    ) || ""
  ).trim();

  const missingProperties = [];

  if (!environment) {
    missingProperties.push("SQUARE_ENV");
  }

  if (!accessToken) {
    missingProperties.push(
      "SQUARE_ACCESS_TOKEN"
    );
  }

  if (!locationId) {
    missingProperties.push(
      "SQUARE_LOCATION_ID"
    );
  }

  if (!apiVersion) {
    missingProperties.push(
      "SQUARE_API_VERSION"
    );
  }

  if (missingProperties.length > 0) {
    throw new Error(
      "missing required Square Script Properties: " +
      missingProperties.join(", ")
    );
  }

  let baseUrl = "";

  if (environment === "sandbox") {
    baseUrl =
      "https://connect.squareupsandbox.com";
  } else if (environment === "production") {
    baseUrl =
      "https://connect.squareup.com";
  } else {
    throw new Error(
      "invalid SQUARE_ENV: " + environment
    );
  }

  return {
    environment: environment,
    accessToken: accessToken,
    locationId: locationId,
    apiVersion: apiVersion,
    baseUrl: baseUrl
  };
}

function squareRequest(path, options) {
  const config = getSquareConfig();
  const requestOptions = options || {};

  const normalizedPath =
    String(path || "").startsWith("/")
      ? String(path)
      : "/" + String(path || "");

  const fetchOptions = {
    method: String(
      requestOptions.method || "get"
    ).toLowerCase(),

    headers: {
      Authorization:
        "Bearer " + config.accessToken,
      "Square-Version": config.apiVersion,
      "Content-Type": "application/json"
    },

    muteHttpExceptions: true
  };

  if (
    Object.prototype.hasOwnProperty.call(
      requestOptions,
      "payload"
    )
  ) {
    fetchOptions.payload =
      typeof requestOptions.payload === "string"
        ? requestOptions.payload
        : JSON.stringify(
            requestOptions.payload
          );
  }

  const response = UrlFetchApp.fetch(
    config.baseUrl + normalizedPath,
    fetchOptions
  );

  const httpStatus =
    response.getResponseCode();

  const responseBody =
    response.getContentText();

  if (
    httpStatus < 200 ||
    httpStatus >= 300
  ) {
    const safeResponseBody =
      responseBody
        .split(config.accessToken)
        .join("[REDACTED]");

    throw new Error(
      "Square API request failed with HTTP " +
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

function createSquareProduct(productId) {
  const normalizedProductId =
    String(productId || "").trim();

  if (!normalizedProductId) {
    throw new Error("product_id is required");
  }

  const squareConfig =
    getSquareConfig();

  if (squareConfig.environment !== "sandbox") {
    throw new Error(
      "Square product creation is limited to sandbox"
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

  ensureSquareIdColumns(sheet);

  const row =
    sheet
      .getRange(
        targetRow,
        1,
        1,
        36
      )
      .getValues()[0];

  const productName =
    String(row[4] || "").trim();

  const sneakerSize =
    String(row[12] || "").trim();

  const priceAmount =
    Number(row[7]);

  const existingSquareItemId =
    String(row[34] || "").trim();

  const existingSquareVariationId =
    String(row[35] || "").trim();

  if (existingSquareItemId) {
    throw new Error(
      "product is already linked to Square"
    );
  }

  if (existingSquareVariationId) {
    throw new Error(
      "product has an existing Square variation link"
    );
  }

  if (!productName) {
    throw new Error(
      "product_name is required for Square"
    );
  }

  if (
    !Number.isSafeInteger(priceAmount) ||
    priceAmount <= 0
  ) {
    throw new Error(
      "planned_sale_price must be a positive integer"
    );
  }

  const temporaryItemId =
    "#ais-item-" + normalizedProductId;

  const temporaryVariationId =
    "#ais-variation-" +
    normalizedProductId;

  const idempotencyKey =
    "ais-square-create-" +
    normalizedProductId;

  const payload = {
    idempotency_key: idempotencyKey,

    object: {
      type: "ITEM",
      id: temporaryItemId,

      item_data: {
        name: productName,

        variations: [
          {
            type: "ITEM_VARIATION",
            id: temporaryVariationId,

            item_variation_data: {
              item_id: temporaryItemId,
              name: sneakerSize,
              sku: normalizedProductId,
              pricing_type:
                "FIXED_PRICING",

              price_money: {
                amount: priceAmount,
                currency: "JPY"
              },

              track_inventory: true
            }
          }
        ]
      }
    }
  };

  const response = squareRequest(
    "/v2/catalog/object",
    {
      method: "post",
      payload: payload
    }
  );

  let createResponse;

  try {
    createResponse = JSON.parse(
      response.body || "{}"
    );
  } catch (_) {
    throw new Error(
      "Square Catalog API returned invalid JSON"
    );
  }

  const idMappings =
    Array.isArray(createResponse.id_mappings)
      ? createResponse.id_mappings
      : [];

  const itemIdMapping =
    idMappings.find(mapping =>
      mapping.client_object_id ===
      temporaryItemId
    );

  const variationIdMapping =
    idMappings.find(mapping =>
      mapping.client_object_id ===
      temporaryVariationId
    );

  let squareItemId = String(
    itemIdMapping &&
    itemIdMapping.object_id || ""
  ).trim();

  let squareVariationId = String(
    variationIdMapping &&
    variationIdMapping.object_id || ""
  ).trim();

  const catalogObject =
    createResponse.catalog_object || {};

  if (!squareItemId) {
    squareItemId = String(
      catalogObject.id || ""
    ).trim();
  }

  if (!squareVariationId) {
    const createdVariations =
      catalogObject.item_data &&
      Array.isArray(
        catalogObject.item_data.variations
      )
        ? catalogObject.item_data.variations
        : [];

    const createdVariation =
      createdVariations.find(variation =>
        String(
          variation.item_variation_data &&
          variation.item_variation_data.sku ||
          ""
        ).trim() === normalizedProductId
      ) || createdVariations[0];

    squareVariationId = String(
      createdVariation &&
      createdVariation.id || ""
    ).trim();
  }

  if (
    !squareItemId ||
    squareItemId.startsWith("#")
  ) {
    throw new Error(
      "Square Item ID was not returned"
    );
  }

  if (
    !squareVariationId ||
    squareVariationId.startsWith("#")
  ) {
    throw new Error(
      "Square Variation ID was not returned"
    );
  }

  sheet
    .getRange(
      targetRow,
      35,
      1,
      2
    )
    .setValues([[
      squareItemId,
      squareVariationId
    ]]);

  return {
    success: true,
    product_id: normalizedProductId,
    square_item_id: squareItemId,
    square_variation_id:
      squareVariationId,
    sku: normalizedProductId,
    product_name: productName,
    price_amount: priceAmount,
    currency: "JPY"
  };
}

function getSquareCatalogItem(squareItemId) {
  const normalizedSquareItemId =
    String(squareItemId || "").trim();

  if (!normalizedSquareItemId) {
    throw new Error(
      "square_item_id is required"
    );
  }

  const response = squareRequest(
    "/v2/catalog/object/" +
    encodeURIComponent(
      normalizedSquareItemId
    ),
    {
      method: "get"
    }
  );

  let retrieveResponse;

  try {
    retrieveResponse = JSON.parse(
      response.body || "{}"
    );
  } catch (_) {
    throw new Error(
      "Square Catalog API returned invalid JSON"
    );
  }

  const catalogObject =
    retrieveResponse.object;

  if (
    !catalogObject ||
    catalogObject.type !== "ITEM" ||
    String(catalogObject.id || "") !==
      normalizedSquareItemId ||
    catalogObject.is_deleted === true
  ) {
    throw new Error(
      "linked Square Item was not found"
    );
  }

  if (
    !Number.isSafeInteger(
      catalogObject.version
    )
  ) {
    throw new Error(
      "Square Item version was not returned"
    );
  }

  return catalogObject;
}

function findSquareItemVariation(
  catalogItem,
  squareVariationId
) {
  const variations =
    catalogItem.item_data &&
    Array.isArray(
      catalogItem.item_data.variations
    )
      ? catalogItem.item_data.variations
      : [];

  return variations.find(variation =>
    variation &&
    variation.type === "ITEM_VARIATION" &&
    String(variation.id || "").trim() ===
      squareVariationId
  ) || null;
}

function buildSquareCatalogObjectForUpdate(
  catalogObject
) {
  if (
    !catalogObject ||
    !catalogObject.type ||
    !catalogObject.id ||
    !Number.isSafeInteger(
      catalogObject.version
    )
  ) {
    throw new Error(
      "invalid Square CatalogObject for update"
    );
  }

  const updateObject = JSON.parse(
    JSON.stringify(catalogObject)
  );

  // CatalogObjectのレスポンス専用フィールド
  delete updateObject.updated_at;
  delete updateObject.created_at;
  delete updateObject.is_deleted;
  delete updateObject.catalog_v1_ids;

  if (updateObject.item_data) {
    // CatalogItemのレスポンス専用フィールド
    delete updateObject
      .item_data
      .description_plaintext;

    delete updateObject
      .item_data
      .channels;

    if (
      Array.isArray(
        updateObject.item_data.variations
      )
    ) {
      updateObject.item_data.variations =
        updateObject
          .item_data
          .variations
          .map(variation =>
            buildSquareCatalogObjectForUpdate(
              variation
            )
          );
    }
  }

  if (updateObject.item_variation_data) {
    // CatalogItemVariationの読み取り専用フィールド
    delete updateObject
      .item_variation_data
      .ordinal;
  }

  return updateObject;
}

function updateSquareProduct(productId) {
  const normalizedProductId =
    String(productId || "").trim();

  if (!normalizedProductId) {
    throw new Error("product_id is required");
  }

  const squareConfig =
    getSquareConfig();

  if (squareConfig.environment !== "sandbox") {
    throw new Error(
      "Square product update is limited to sandbox"
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

  const productName =
    String(row[4] || "").trim();

  const sneakerSize =
    String(row[12] || "").trim();

  const priceAmount =
    Number(row[7]);

  const squareItemId =
    String(row[34] || "").trim();

  const squareVariationId =
    String(row[35] || "").trim();

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

  if (!productName) {
    throw new Error(
      "product_name is required for Square"
    );
  }

  if (!sneakerSize) {
    throw new Error(
      "sneaker_size is required for Square"
    );
  }

  if (
    !Number.isSafeInteger(priceAmount) ||
    priceAmount <= 0
  ) {
    throw new Error(
      "planned_sale_price must be a positive integer"
    );
  }

  // ------------------------------------------
  // 1. 現在のItem / Variationを確認
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
  // 2. Itemを現在値ベースで更新
  // ------------------------------------------

  const itemUpdateObject =
    buildSquareCatalogObjectForUpdate(
      currentItem
    );

  itemUpdateObject.item_data.name =
    productName;

  squareRequest(
    "/v2/catalog/object",
    {
      method: "post",
      payload: {
        idempotency_key:
          "ais-square-item-update-" +
          Utilities.getUuid(),
        object: itemUpdateObject
      }
    }
  );

  // ------------------------------------------
  // 3. Item更新後の最新状態を再取得
  // ------------------------------------------

  const refreshedItem =
    getSquareCatalogItem(squareItemId);

  const refreshedVariation =
    findSquareItemVariation(
      refreshedItem,
      squareVariationId
    );

  if (!refreshedVariation) {
    throw new Error(
      "linked Square Variation was not found after Item update"
    );
  }

  if (
    !refreshedVariation.item_variation_data ||
    String(
      refreshedVariation
        .item_variation_data
        .item_id || ""
    ).trim() !== squareItemId
  ) {
    throw new Error(
      "Square Variation does not belong to linked Item"
    );
  }

  // ------------------------------------------
  // 4. Variationを最新値ベースで更新
  // ------------------------------------------

  const variationUpdateObject =
    buildSquareCatalogObjectForUpdate(
      refreshedVariation
    );

  const variationData =
    variationUpdateObject
      .item_variation_data;

  variationData.item_id = squareItemId;
  variationData.name = sneakerSize;
  variationData.sku = normalizedProductId;
  variationData.pricing_type =
    "FIXED_PRICING";
  variationData.price_money = {
    amount: priceAmount,
    currency: "JPY"
  };

  squareRequest(
    "/v2/catalog/object",
    {
      method: "post",
      payload: {
        idempotency_key:
          "ais-square-variation-update-" +
          Utilities.getUuid(),
        object: variationUpdateObject
      }
    }
  );

  // ------------------------------------------
  // 5. 更新後のSquare実値を取得
  // ------------------------------------------

  const updatedItem =
    getSquareCatalogItem(squareItemId);

  const updatedVariation =
    findSquareItemVariation(
      updatedItem,
      squareVariationId
    );

  if (
    !updatedVariation ||
    !updatedVariation.item_variation_data
  ) {
    throw new Error(
      "updated Square Variation was not returned"
    );
  }

  const updatedItemData =
    updatedItem.item_data || {};

  const updatedVariationData =
    updatedVariation.item_variation_data;

  const updatedPriceMoney =
    updatedVariationData.price_money || {};

  return {
    success: true,
    product_id: normalizedProductId,
    square_item_id: squareItemId,
    square_variation_id:
      squareVariationId,
    product_name:
      updatedItemData.name || "",
    variation_name:
      updatedVariationData.name || "",
    sku:
      updatedVariationData.sku || "",
    price_amount:
      Object.prototype.hasOwnProperty.call(
        updatedPriceMoney,
        "amount"
      )
        ? updatedPriceMoney.amount
        : null,
    currency:
      updatedPriceMoney.currency || ""
  };
}

function squareUploadImageRequest(path, requestData, imageBlob) {
  const config = getSquareConfig();

  const normalizedPath =
    String(path || "").startsWith("/")
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
      Authorization:
        "Bearer " + config.accessToken,
      "Square-Version": config.apiVersion,
      Accept: "application/json"
    },
    payload: payload,
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch(
    config.baseUrl + normalizedPath,
    fetchOptions
  );

  const httpStatus =
    response.getResponseCode();

  const responseBody =
    response.getContentText();

  if (
    httpStatus < 200 ||
    httpStatus >= 300
  ) {
    const safeResponseBody =
      responseBody
        .split(config.accessToken)
        .join("[REDACTED]");

    throw new Error(
      "Square API image upload failed with HTTP " +
      httpStatus +
      ": " +
      safeResponseBody
    );
  }

  let parsedResponse;

  try {
    parsedResponse = JSON.parse(
      responseBody || "{}"
    );
  } catch (_) {
    throw new Error(
      "Square image upload returned invalid JSON"
    );
  }

  return {
    httpStatus: httpStatus,
    body: responseBody,
    data: parsedResponse
  };
}

function syncSquareProductMainImage(productId) {
  const normalizedProductId =
    String(productId || "").trim();

  if (!normalizedProductId) {
    throw new Error("product_id is required");
  }

  const squareConfig =
    getSquareConfig();

  if (squareConfig.environment !== "sandbox") {
    throw new Error(
      "Square image sync is limited to sandbox"
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

  const productName =
    String(row[4] || "").trim();

  const folderUrl =
    String(row[29] || "").trim();

  const squareItemId =
    String(row[34] || "").trim();

  const squareVariationId =
    String(row[35] || "").trim();

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
  // Drive商品フォルダ取得と安全確認
  // ------------------------------------------

  if (!folderUrl) {
    throw new Error(
      "product Drive folder URL is missing"
    );
  }

  const folderId =
    extractDriveFolderId(folderUrl);

  if (!folderId) {
    throw new Error(
      "invalid product Drive folder URL"
    );
  }

  const productFolder =
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

  if (productFolder.getName() !== normalizedProductId) {
    throw new Error(
      "product Drive folder does not match product_id"
    );
  }

  // ------------------------------------------
  // メイン画像（01_main_）の取得
  // ------------------------------------------

  const files =
    productFolder.getFiles();

  const mainImageFiles = [];

  while (files.hasNext()) {
    const file = files.next();

    if (
      file.getName().startsWith("01_main_")
    ) {
      mainImageFiles.push(file);
    }
  }

  if (mainImageFiles.length === 0) {
    throw new Error(
      "main image not found"
    );
  }

  if (mainImageFiles.length > 1) {
    throw new Error(
      "multiple main images found"
    );
  }

  const mainImageFile =
    mainImageFiles[0];

  const mimeType =
    String(
      mainImageFile.getMimeType() || ""
    ).trim().toLowerCase();

  // WebPは明示的に拒否
  if (mimeType === "image/webp") {
    throw new Error(
      "Square image sync does not support WebP"
    );
  }

  // JPEG / PNG のみ許可
  const allowedMimes = [
    "image/jpeg",
    "image/png"
  ];

  if (!allowedMimes.includes(mimeType)) {
    throw new Error(
      "unsupported Square image mime type: " +
      mimeType
    );
  }

  // ファイルサイズ検証（15MB以下）
  const fileSize =
    mainImageFile.getSize();

  const maxSizeBytes =
    15 * 1024 * 1024;

  if (fileSize > maxSizeBytes) {
    throw new Error(
      "image file size exceeds 15MB limit: " +
      fileSize +
      " bytes"
    );
  }

  // ------------------------------------------
  // Square側の二重画像登録防止
  // ------------------------------------------

  const currentItem =
    getSquareCatalogItem(squareItemId);

  const currentItemData =
    currentItem.item_data || {};

  const existingImageIds =
    Array.isArray(currentItemData.image_ids)
      ? currentItemData.image_ids
      : [];

  if (existingImageIds.length > 0) {
    throw new Error(
      "product already has a Square image"
    );
  }

  // ------------------------------------------
  // Square CreateCatalogImage 実行
  // ------------------------------------------

  const driveFileId =
    mainImageFile.getId();

  const driveFileName =
    mainImageFile.getName();

  const idempotencyKey =
    "ais-square-image-" +
    normalizedProductId +
    "-" +
    driveFileId;

  const temporaryImageId =
    "#ais-image-" +
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

  const uploadResponse =
    squareUploadImageRequest(
      "/v2/catalog/images",
      requestData,
      mainImageFile.getBlob()
    );

  const responseData =
    uploadResponse.data || {};

  const imageObject =
    responseData.image;

  if (
    !imageObject ||
    typeof imageObject !== "object"
  ) {
    throw new Error(
      "Square Image object was not returned"
    );
  }

  if (imageObject.type !== "IMAGE") {
    throw new Error(
      "invalid Square Image object type: " +
      String(imageObject.type || "")
    );
  }

  const squareImageId =
    String(imageObject.id || "").trim();

  if (
    !squareImageId ||
    squareImageId.startsWith("#")
  ) {
    throw new Error(
      "Square Image ID was not returned"
    );
  }

  const imageData =
    imageObject.image_data || {};

  const squareImageUrl =
    String(imageData.url || "").trim();

  if (!squareImageUrl) {
    throw new Error(
      "Square Image URL was not returned"
    );
  }

  return {
    success: true,
    product_id: normalizedProductId,
    square_item_id: squareItemId,
    square_image_id: squareImageId,
    square_image_url: squareImageUrl,
    drive_file_id: driveFileId,
    drive_file_name: driveFileName,
    mime_type: mimeType,
    is_primary: true
  };
}
