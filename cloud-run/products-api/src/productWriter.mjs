import crypto from "node:crypto";
import {
  asRawString,
  asTrimmedString,
  convertDriveFileUrlToDisplayUrl,
  mapGasProductToSupabaseBundle,
  normalizeStringArray,
  toNullableNumber,
} from "./productMapper.mjs";
import {
  queryProductDetail,
  upsertProductBundle,
} from "./productsRepository.mjs";
import {
  computeSupabaseConfirmedFingerprint,
  flushPendingAiDraftStateToSheets,
  syncAiProductDraftsFromGas,
} from "./aiDraftService.mjs";

const ALLOWED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const MAX_IMAGES_PER_PRODUCT = 20;
const MAX_SINGLE_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB (matches frontend MAX_IMAGE_SIZE)
const MAX_SELECTED_AI_IMAGES = 3;

const SNEAKER_KEYS = [
  "sneaker_sku",
  "sneaker_size",
  "sneaker_colorway",
  "sneaker_box",
  "sneaker_accessories",
  "sneaker_release_year",
];

const JEWELRY_KEYS = [
  "jewelry_type",
  "jewelry_material",
  "carat",
  "shape",
  "color_grade",
  "clarity",
  "cut",
  "main_stone",
  "jewelry_size",
  "weight_g",
  "certificate_available",
  "certificate_number",
];

const APPAREL_FASHION_CANONICAL_KEYS = ["subcategory", "size", "official_sku"];

const POKEMON_BUSINESS_FIELDS = [
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
];

export class ProductWriteError extends Error {
  constructor(status, errorCode, message) {
    super(message);
    this.name = "ProductWriteError";
    this.status = status;
    this.errorCode = errorCode;
  }
}

const ALLOWED_INVENTORY_STATUSES = new Set(["in_stock", "reserved", "sold"]);
const ALLOWED_RECORD_STATUSES = new Set(["active", "archived"]);

/**
 * Returns true if ANY Square linkage identifier/URL is present on the product row.
 * Square-linked products MUST remain on the GAS Square-synchronized write path.
 */
export function hasAnySquareLink(row) {
  if (!row || typeof row !== "object") return false;
  return (
    asTrimmedString(row.square_item_id) !== "" ||
    asTrimmedString(row.square_variation_id) !== "" ||
    asTrimmedString(row.square_payment_link_id) !== "" ||
    asTrimmedString(row.square_checkout_url) !== ""
  );
}

export function normalizeAuctionItemNumberInput(rawVal) {
  if (rawVal === undefined || rawVal === null) {
    return "";
  }
  if (typeof rawVal === "object" || typeof rawVal === "boolean") {
    throw new ProductWriteError(
      400,
      "INVALID_AUCTION_ITEM_NUMBER",
      "auction_item_number must be a string"
    );
  }
  return String(rawVal).trim();
}

function extractRawBase64AndMime(rawBase64, declaredMime) {
  const s = String(rawBase64 || "").trim();
  if (!s) {
    throw new ProductWriteError(
      400,
      "INVALID_IMAGE_BASE64",
      "Image base64 content cannot be empty"
    );
  }
  let mime = asTrimmedString(declaredMime).toLowerCase();
  let b64 = s;
  const dataUriMatch = s.match(/^data:([^;]+);base64,([\s\S]+)$/i);
  if (dataUriMatch) {
    if (!mime) mime = dataUriMatch[1].trim().toLowerCase();
    b64 = dataUriMatch[2].trim();
  }
  if (mime === "image/jpg") mime = "image/jpeg";
  if (!mime) mime = "image/jpeg";

  if (!ALLOWED_IMAGE_MIME_TYPES.has(mime)) {
    throw new ProductWriteError(
      400,
      "UNSUPPORTED_IMAGE_TYPE",
      `Unsupported image mime_type: ${mime}`
    );
  }

  const normalizedB64 = b64.replace(/\s+/g, "");
  if (!normalizedB64 || !/^[A-Za-z0-9+/=]+$/.test(normalizedB64)) {
    throw new ProductWriteError(
      400,
      "INVALID_IMAGE_BASE64",
      "Invalid base64 encoding in image payload"
    );
  }

  const bytes = Buffer.from(normalizedB64, "base64");
  if (bytes.length === 0) {
    throw new ProductWriteError(
      400,
      "INVALID_IMAGE_BASE64",
      "Decoded image is empty"
    );
  }
  if (bytes.length > MAX_SINGLE_IMAGE_BYTES) {
    throw new ProductWriteError(
      400,
      "IMAGE_TOO_LARGE",
      "Each image must be 5MB or smaller"
    );
  }

  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  return {
    base64: normalizedB64,
    mime_type: mime,
    byteLength: bytes.length,
    sha256,
  };
}

export function validateAndMergePokemonCard(
  productId,
  cardInput,
  existingRow = null
) {
  if (!cardInput || typeof cardInput !== "object" || Array.isArray(cardInput)) {
    throw new ProductWriteError(
      400,
      "INVALID_POKEMON_CARD_DATA",
      "invalid pokemon_card data"
    );
  }

  if (Object.prototype.hasOwnProperty.call(cardInput, "product_id")) {
    const inputPid = asTrimmedString(cardInput.product_id);
    if (inputPid && productId && inputPid !== productId) {
      throw new ProductWriteError(
        400,
        "POKEMON_CARD_PRODUCT_ID_MISMATCH",
        "product_id mismatch"
      );
    }
  }

  const merged = {
    card_name: existingRow ? asTrimmedString(existingRow.card_name) : "",
    set_name: existingRow ? asTrimmedString(existingRow.set_name) : "",
    card_number: existingRow ? asTrimmedString(existingRow.card_number) : "",
    rarity: existingRow ? asTrimmedString(existingRow.rarity) : "",
    language: existingRow ? asTrimmedString(existingRow.language) : "",
    grading_status: existingRow
      ? asTrimmedString(existingRow.grading_status)
      : "",
    grader: existingRow ? asTrimmedString(existingRow.grader) : "",
    grade: existingRow ? asTrimmedString(existingRow.grade) : "",
    certification_number: existingRow
      ? asTrimmedString(existingRow.certification_number)
      : "",
    card_condition: existingRow
      ? asTrimmedString(existingRow.card_condition)
      : "",
  };

  for (const field of POKEMON_BUSINESS_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(cardInput, field)) {
      const v = cardInput[field];
      merged[field] = v === null || v === undefined ? "" : String(v).trim();
    }
  }

  if (!merged.card_name) {
    throw new ProductWriteError(
      400,
      "POKEMON_CARD_NAME_REQUIRED",
      "card_name is required"
    );
  }
  if (!merged.language) {
    throw new ProductWriteError(
      400,
      "POKEMON_CARD_LANGUAGE_REQUIRED",
      "language is required"
    );
  }
  if (
    merged.grading_status !== "graded" &&
    merged.grading_status !== "ungraded"
  ) {
    throw new ProductWriteError(
      400,
      "POKEMON_CARD_INVALID_GRADING_STATUS",
      "grading_status must be graded or ungraded"
    );
  }

  if (merged.grading_status === "graded") {
    if (!merged.grader) {
      throw new ProductWriteError(
        400,
        "POKEMON_CARD_GRADER_REQUIRED",
        "grader is required for graded card"
      );
    }
    if (!merged.grade) {
      throw new ProductWriteError(
        400,
        "POKEMON_CARD_GRADE_REQUIRED",
        "grade is required for graded card"
      );
    }
    merged.card_condition = "";
  } else {
    merged.grader = "";
    merged.grade = "";
    merged.certification_number = "";
    if (merged.card_condition) {
      const upper = merged.card_condition.toUpperCase();
      if (["A", "B", "C"].includes(upper)) {
        merged.card_condition = upper;
      }
    }
  }

  const nowIso = new Date().toISOString();
  return {
    product_id: productId,
    ...merged,
    source_created_at:
      existingRow && asTrimmedString(existingRow.source_created_at)
        ? asTrimmedString(existingRow.source_created_at)
        : nowIso,
    source_updated_at: nowIso,
  };
}

export function validateSelectedImageIds(rawSel, validFileIdsSet, productId) {
  const effective = rawSel === null ? [] : rawSel;
  if (!Array.isArray(effective)) {
    throw new ProductWriteError(
      400,
      "INVALID_SELECTED_IMAGE_IDS",
      "selected_image_ids must be an array"
    );
  }
  if (effective.length > MAX_SELECTED_AI_IMAGES) {
    throw new ProductWriteError(
      400,
      "IMAGE_COUNT_EXCEEDED",
      `Selected images count (${effective.length}) exceeds maximum limit (${MAX_SELECTED_AI_IMAGES}) for product: ${productId}`
    );
  }

  const out = [];
  const seen = new Set();
  for (const rawId of effective) {
    if (typeof rawId !== "string" && typeof rawId !== "number") {
      throw new ProductWriteError(
        400,
        "INVALID_SELECTED_IMAGE_IDS",
        "Each selected image ID must be a string"
      );
    }
    const fid = String(rawId).trim();
    if (!fid) {
      throw new ProductWriteError(
        400,
        "INVALID_SELECTED_IMAGE_IDS",
        "Selected image ID cannot be empty"
      );
    }
    if (seen.has(fid)) {
      throw new ProductWriteError(
        400,
        "DUPLICATE_SELECTED_IMAGE_ID",
        `Duplicate image ID '${fid}' in selected_image_ids for product: ${productId}`
      );
    }
    if (validFileIdsSet && !validFileIdsSet.has(fid)) {
      throw new ProductWriteError(
        400,
        "INVALID_IMAGE_SELECTION",
        `Selected image ID '${fid}' does not belong to product ${productId} drive folder.`
      );
    }
    seen.add(fid);
    out.push(fid);
  }
  return out;
}

function validatePriceForCreate(rawVal, fieldName, allowZeroWhenSet = false) {
  if (rawVal === undefined || rawVal === null || String(rawVal).trim() === "") {
    return 0;
  }
  const num = Number(String(rawVal).replace(/,/g, "").trim());
  const valid = allowZeroWhenSet
    ? Number.isSafeInteger(num) && num >= 0
    : Number.isSafeInteger(num) && num > 0;
  if (!valid) {
    throw new ProductWriteError(
      400,
      `INVALID_${fieldName.toUpperCase()}`,
      `${fieldName} must be a ${allowZeroWhenSet ? "non-negative" : "positive"} integer`
    );
  }
  return num;
}

/**
 * Phase 2 Unit 1: Create a new non-Square draft product via Cloud Run + Supabase.
 * - Pre-validates all fields & images in Cloud Run before any external side effect.
 * - Atomically allocates `TMP-XXXXXX` in Supabase PostgreSQL (`allocate_next_product_id`).
 * - Uploads images to Google Drive (`ROOT_FOLDER_ID/<product_id>/`) and writes downstream
 *   compatibility row to Google Sheets so AI batch & Square publish remain 100% compatible.
 * - Saves authoritative product bundle directly to Supabase (`write_source = 'supabase'`).
 */
export async function createDraftProduct({
  supabase,
  fetchImpl = globalThis.fetch,
  gasWebAppUrl,
  payload = {},
}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ProductWriteError(
      400,
      "INVALID_PAYLOAD",
      "JSON object body is required"
    );
  }

  // 1. Draft-only guard (no Square sync, no immediate publish)
  const requestedPublish = asTrimmedString(payload.publish_status);
  if (requestedPublish && requestedPublish !== "draft") {
    throw new ProductWriteError(
      400,
      "DRAFT_ONLY_ENDPOINT",
      "Only draft product creation without Square sync is supported on this endpoint"
    );
  }

  // 2. Validate images (1..20)
  if (!Array.isArray(payload.images) || payload.images.length === 0) {
    throw new ProductWriteError(
      400,
      "IMAGES_REQUIRED",
      "At least 1 product image is required"
    );
  }
  if (payload.images.length > MAX_IMAGES_PER_PRODUCT) {
    throw new ProductWriteError(
      400,
      "MAX_IMAGE_COUNT_EXCEEDED",
      "maximum image count is 20"
    );
  }

  const normalizedImages = payload.images.map((img, idx) => {
    if (!img || typeof img !== "object") {
      throw new ProductWriteError(
        400,
        "INVALID_IMAGE_ITEM",
        `Invalid image item at index ${idx}`
      );
    }
    const parsed = extractRawBase64AndMime(img.base64, img.mime_type);
    const fileName =
      asTrimmedString(img.file_name || img.name) || `image_${idx + 1}.jpg`;
    return {
      file_name: fileName,
      mime_type: parsed.mime_type,
      base64: parsed.base64,
      sha256: parsed.sha256,
    };
  });

  // 3. Validate auction_item_number, prices, category, pokemon_card, translated_title
  const validatedAuctionItemNumber = Object.prototype.hasOwnProperty.call(
    payload,
    "auction_item_number"
  )
    ? normalizeAuctionItemNumberInput(payload.auction_item_number)
    : "";

  const purchasePrice = validatePriceForCreate(
    payload.purchase_price,
    "purchase_price",
    true
  );
  const plannedSalePrice = validatePriceForCreate(
    payload.planned_sale_price,
    "planned_sale_price",
    false
  );

  const category = asTrimmedString(payload.category);
  const isPokemonCard = category === "pokemon_card";
  const isSneaker = category === "sneaker";
  const isJewelry = category === "jewelry";
  const isApparelOrFashion =
    category === "apparel" || category === "fashion_goods";

  // Pre-validate pokemon_card before allocating ID or touching Drive
  if (isPokemonCard) {
    validateAndMergePokemonCard("", payload.pokemon_card, null);
  }

  let validatedTranslatedTitle = "";
  if (
    Object.prototype.hasOwnProperty.call(payload, "translated_title") &&
    payload.translated_title !== undefined &&
    payload.translated_title !== null
  ) {
    validatedTranslatedTitle = asTrimmedString(payload.translated_title);
    if (!validatedTranslatedTitle) {
      throw new ProductWriteError(
        400,
        "TRANSLATED_TITLE_REQUIRED",
        "translated_title cannot be empty"
      );
    }
  }

  // Optional selected_image_indexes (0-based indexes into payload.images, max 3)
  let selectedImageIndexes = [];
  if (
    Object.prototype.hasOwnProperty.call(payload, "selected_image_indexes") &&
    payload.selected_image_indexes !== undefined &&
    payload.selected_image_indexes !== null
  ) {
    if (!Array.isArray(payload.selected_image_indexes)) {
      throw new ProductWriteError(
        400,
        "INVALID_SELECTED_IMAGE_INDEXES",
        "selected_image_indexes must be an array"
      );
    }
    if (payload.selected_image_indexes.length > MAX_SELECTED_AI_IMAGES) {
      throw new ProductWriteError(
        400,
        "IMAGE_COUNT_EXCEEDED",
        "selected_image_indexes cannot exceed 3"
      );
    }
    const seenIdx = new Set();
    for (const rawIdx of payload.selected_image_indexes) {
      const idx = Number(rawIdx);
      if (
        !Number.isInteger(idx) ||
        idx < 0 ||
        idx >= normalizedImages.length ||
        seenIdx.has(idx)
      ) {
        throw new ProductWriteError(
          400,
          "INVALID_SELECTED_IMAGE_INDEXES",
          "Invalid or duplicate index in selected_image_indexes"
        );
      }
      seenIdx.add(idx);
      selectedImageIndexes.push(idx);
    }
  }

  let condition = asTrimmedString(payload.condition);
  if (
    isPokemonCard &&
    ["A", "B", "C"].includes(condition.toUpperCase())
  ) {
    condition = "";
  }

  let isTest = false;
  if (
    Object.prototype.hasOwnProperty.call(payload, "is_test") &&
    payload.is_test !== undefined &&
    payload.is_test !== null &&
    payload.is_test !== ""
  ) {
    if (typeof payload.is_test !== "boolean") {
      throw new ProductWriteError(
        400,
        "INVALID_IS_TEST",
        "is_test must be a boolean"
      );
    }
    isTest = payload.is_test;
  }

  const normalizedFields = {
    category,
    brand: asTrimmedString(payload.brand),
    product_name: asRawString(payload.product_name ?? "").trim(),
    translated_title: validatedTranslatedTitle,
    condition,
    purchase_price: purchasePrice,
    planned_sale_price: plannedSalePrice,
    storage_location: asTrimmedString(payload.storage_location),
    description: asRawString(payload.description ?? ""),
    notes: asRawString(payload.notes ?? ""),

    sneaker_sku: isSneaker ? asTrimmedString(payload.sneaker_sku) : "",
    sneaker_size: isSneaker ? asTrimmedString(payload.sneaker_size) : "",
    sneaker_colorway: isSneaker ? asTrimmedString(payload.sneaker_colorway) : "",
    sneaker_box: isSneaker ? asTrimmedString(payload.sneaker_box) : "",
    sneaker_accessories: isSneaker
      ? asTrimmedString(payload.sneaker_accessories)
      : "",
    sneaker_release_year: isSneaker
      ? asTrimmedString(payload.sneaker_release_year)
      : "",

    jewelry_type: isJewelry ? asTrimmedString(payload.jewelry_type) : "",
    jewelry_material: isJewelry ? asTrimmedString(payload.jewelry_material) : "",
    carat: isJewelry ? asTrimmedString(payload.carat) : "",
    shape: isJewelry ? asTrimmedString(payload.shape) : "",
    color_grade: isJewelry ? asTrimmedString(payload.color_grade) : "",
    clarity: isJewelry ? asTrimmedString(payload.clarity) : "",
    cut: isJewelry ? asTrimmedString(payload.cut) : "",
    main_stone: isJewelry ? asTrimmedString(payload.main_stone) : "",
    jewelry_size: isJewelry ? asTrimmedString(payload.jewelry_size) : "",
    weight_g: isJewelry ? asTrimmedString(payload.weight_g) : "",
    certificate_available: isJewelry
      ? asTrimmedString(payload.certificate_available)
      : "",
    certificate_number: isJewelry
      ? asTrimmedString(payload.certificate_number)
      : "",

    subcategory: isApparelOrFashion
      ? asTrimmedString(payload.subcategory ?? payload.sub_category)
      : "",
    size: isApparelOrFashion ? asTrimmedString(payload.size) : "",
    official_sku: isApparelOrFashion
      ? asTrimmedString(payload.official_sku ?? payload.sku)
      : "",
    auction_item_number: validatedAuctionItemNumber,
  };

  // 4. Optional client_request_id idempotency check in Supabase
  const clientRequestId = asTrimmedString(
    payload.client_request_id ?? payload.request_id
  );
  const payloadHash = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        fields: normalizedFields,
        ...(isTest ? { is_test: true } : {}),
        pokemon_card: isPokemonCard ? payload.pokemon_card : null,
        selectedImageIndexes,
        images: normalizedImages.map((i) => ({
          file_name: i.file_name,
          mime_type: i.mime_type,
          sha256: i.sha256,
        })),
      })
    )
    .digest("hex");

  let existingIdem = null;
  let isRecovery = false;

  if (clientRequestId) {
    const { data: foundIdem, error: idemErr } = await supabase
      .from("product_write_idempotency")
      .select(
        "request_id, payload_hash, product_id, status, mirror_json, response_json"
      )
      .eq("request_id", clientRequestId)
      .maybeSingle();
    if (idemErr) {
      throw new Error(`Idempotency lookup failed: ${idemErr.message}`);
    }
    if (foundIdem) {
      if (foundIdem.payload_hash !== payloadHash) {
        throw new ProductWriteError(
          409,
          "IDEMPOTENCY_PAYLOAD_MISMATCH",
          "Different payload was submitted with the same client_request_id"
        );
      }
      const idemStatus = asTrimmedString(foundIdem.status) || "completed";
      const completedPid = asTrimmedString(
        foundIdem.response_json?.product_id || foundIdem.product_id
      );
      if (
        idemStatus === "completed" &&
        completedPid &&
        foundIdem.response_json &&
        Object.keys(foundIdem.response_json).length > 0
      ) {
        const { data: existingProd, error: prodCheckErr } = await supabase
          .from("products")
          .select("product_id")
          .eq("product_id", completedPid)
          .maybeSingle();
        if (prodCheckErr) {
          throw new Error(
            `Idempotency product verification failed: ${prodCheckErr.message}`
          );
        }
        if (existingProd) {
          return {
            status: 200,
            body: {
              ...foundIdem.response_json,
              is_reused: true,
            },
          };
        }
      }
      existingIdem = foundIdem;
      isRecovery = true;
    }
  }

  if (!gasWebAppUrl) {
    throw new ProductWriteError(
      501,
      "DRIVE_STORAGE_BRIDGE_NOT_CONFIGURED",
      "GAS_WEB_APP_URL is required for Google Drive image upload"
    );
  }

  // 5. Allocate atomic TMP-XXXXXX in Supabase PostgreSQL (or reuse reserved ID on retry after mid-flight failure)
  const allocateId = async (minFloor = 0) => {
    const { data: nextId, error: idErr } = await supabase.rpc(
      "allocate_next_product_id",
      { min_floor: minFloor }
    );
    if (idErr || !nextId) {
      throw new Error(
        `Failed allocating product_id in Supabase: ${idErr?.message || "empty result"}`
      );
    }
    return asTrimmedString(nextId);
  };

  let productId = asTrimmedString(existingIdem?.product_id);
  if (!productId) {
    productId = await allocateId(0);
    if (clientRequestId) {
      const { error: reserveErr } = await supabase
        .from("product_write_idempotency")
        .insert({
          request_id: clientRequestId,
          payload_hash: payloadHash,
          product_id: productId,
          status: "in_progress",
          mirror_json: null,
          response_json: {},
          updated_at: new Date().toISOString(),
        });
      if (reserveErr) {
        if (String(reserveErr.code || "") === "23505") {
          const { data: racedIdem, error: raceReadErr } = await supabase
            .from("product_write_idempotency")
            .select(
              "request_id, payload_hash, product_id, status, mirror_json, response_json"
            )
            .eq("request_id", clientRequestId)
            .maybeSingle();
          if (raceReadErr || !racedIdem) {
            throw new Error(
              `Concurrent idempotency lookup failed: ${
                raceReadErr?.message || reserveErr.message
              }`
            );
          }
          if (racedIdem.payload_hash !== payloadHash) {
            throw new ProductWriteError(
              409,
              "IDEMPOTENCY_PAYLOAD_MISMATCH",
              "Different payload was submitted with the same client_request_id"
            );
          }
          if (
            asTrimmedString(racedIdem.status) === "completed" &&
            racedIdem.response_json?.product_id
          ) {
            return {
              status: 200,
              body: {
                ...racedIdem.response_json,
                is_reused: true,
              },
            };
          }
          existingIdem = racedIdem;
          isRecovery = true;
          productId = asTrimmedString(racedIdem.product_id) || productId;
        } else {
          throw new Error(
            `Failed recording idempotency reservation: ${reserveErr.message}`
          );
        }
      }
    }
  }

  const internalReqId = clientRequestId || crypto.randomUUID();

  const callDriveAndSheetsMirror = async (reservedId) => {
    const mirrorBody = {
      action: "mirror_created_draft_product",
      reserved_product_id: reservedId,
      request_id: internalReqId,
      ...normalizedFields,
      publish_status: "draft",
      ...(isPokemonCard ? { pokemon_card: payload.pokemon_card } : {}),
      images: normalizedImages.map((img) => ({
        file_name: img.file_name,
        mime_type: img.mime_type,
        base64: img.base64,
      })),
    };
    const res = await fetchImpl(gasWebAppUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(mirrorBody),
    });
    if (!res.ok) {
      throw new Error(`Google Drive / Sheets mirror returned HTTP ${res.status}`);
    }
    return res.json();
  };

  let mirrorJson = null;
  if (
    existingIdem &&
    asTrimmedString(existingIdem.status) === "mirror_completed" &&
    existingIdem.mirror_json &&
    existingIdem.mirror_json.success === true
  ) {
    mirrorJson = existingIdem.mirror_json;
  } else {
    mirrorJson = await callDriveAndSheetsMirror(productId);
    if (
      mirrorJson &&
      mirrorJson.success === false &&
      mirrorJson.error_code === "PRODUCT_ID_ALREADY_IN_SHEETS"
    ) {
      const floor = Number(mirrorJson.max_sheet_sequence) || 0;
      const reallocatedId = await allocateId(floor);
      if (clientRequestId) {
        const { error: updateIdErr } = await supabase
          .from("product_write_idempotency")
          .update({
            product_id: reallocatedId,
            updated_at: new Date().toISOString(),
          })
          .eq("request_id", clientRequestId);
        if (updateIdErr) {
          throw new Error(
            `Failed updating reserved product_id in idempotency state: ${updateIdErr.message}`
          );
        }
      }
      productId = reallocatedId;
      mirrorJson = await callDriveAndSheetsMirror(productId);
    }

    if (!mirrorJson || mirrorJson.success !== true) {
      throw new Error(
        `Drive / Sheets mirror failed: ${
          mirrorJson?.message || mirrorJson?.error || "unknown error"
        }`
      );
    }

    if (clientRequestId) {
      try {
        await supabase
          .from("product_write_idempotency")
          .update({
            product_id: productId,
            status: "mirror_completed",
            mirror_json: mirrorJson,
            updated_at: new Date().toISOString(),
          })
          .eq("request_id", clientRequestId);
      } catch {
        // Best-effort checkpoint; even if Supabase is transiently unreachable right now,
        // `in_progress` + `product_id` + GAS `MIRROR_CREATE_REQ_<productId>` still recovers `productId`.
      }
    }
  }

  // 6. Allocate row_seq in Supabase (reuse existing row_seq if recovering a partially saved row)
  const { data: existingProductRow, error: existingProdRowErr } = await supabase
    .from("products")
    .select("product_id, row_seq")
    .eq("product_id", productId)
    .maybeSingle();
  if (existingProdRowErr) {
    throw new Error(
      `Failed checking existing product row before save: ${existingProdRowErr.message}`
    );
  }

  let allocatedRowSeq = Number(existingProductRow?.row_seq) || 0;
  if (!(Number.isInteger(allocatedRowSeq) && allocatedRowSeq > 0)) {
    const { data: nextRowSeq, error: rowSeqErr } = await supabase.rpc(
      "allocate_next_product_row_seq"
    );
    if (rowSeqErr) {
      throw new Error(`Failed allocating row_seq: ${rowSeqErr.message}`);
    }
    allocatedRowSeq = Number(nextRowSeq) || 0;
  }

  const nowIso = new Date().toISOString();
  const createdAtIso = asTrimmedString(mirrorJson.created_at) || nowIso;
  const driveFolderUrl = asTrimmedString(mirrorJson.drive_folder_url);
  const mainImageUrl = asTrimmedString(mirrorJson.main_image_url);
  const mainImageDisplayUrl = convertDriveFileUrlToDisplayUrl(
    mainImageUrl,
    "w800"
  );

  const rawDriveImages = Array.isArray(mirrorJson.images)
    ? mirrorJson.images
    : [];
  const imageRows = rawDriveImages
    .filter((img) => img && asTrimmedString(img.file_id))
    .map((img, index) => {
      const fid = asTrimmedString(img.file_id);
      return {
        product_id: productId,
        sort_order: index,
        file_id: fid,
        name: asTrimmedString(img.name),
        mime_type: asTrimmedString(img.mime_type) || "image/jpeg",
        view_url: asTrimmedString(img.view_url),
        display_url:
          asTrimmedString(img.display_url) ||
          `https://drive.google.com/thumbnail?id=${fid}&sz=w1600`,
      };
    });

  const selectedImageIds = selectedImageIndexes
    .map((idx) => imageRows[idx]?.file_id || "")
    .filter(Boolean);

  if (selectedImageIds.length > 0 && gasWebAppUrl) {
    try {
      await fetchImpl(gasWebAppUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          action: "save_product_ai_selected_images",
          product_id: productId,
          selected_image_ids: selectedImageIds,
        }),
      });
    } catch {
      // Non-fatal; Supabase holds authoritative selected_image_ids
    }
  }

  const pokemonCardRow = isPokemonCard
    ? validateAndMergePokemonCard(productId, payload.pokemon_card, null)
    : null;

  const translationRow = validatedTranslatedTitle
    ? {
        product_id: productId,
        locale: "en",
        translated_title: validatedTranslatedTitle,
        translated_description: "",
        translated_condition: "",
        translated_box: "",
        translated_accessories: "",
        translation_status: "approved",
        generated_at: nowIso,
      }
    : null;

  const productRow = {
    product_id: productId,
    ...(Number.isInteger(Number(allocatedRowSeq)) && Number(allocatedRowSeq) > 0
      ? { row_seq: Number(allocatedRowSeq) }
      : {}),
    created_at: createdAtIso,
    created_at_raw: createdAtIso,
    ...normalizedFields,
    drive_folder_url: driveFolderUrl,
    main_image_url: mainImageUrl,
    main_image_display_url: mainImageDisplayUrl,
    selected_image_ids: selectedImageIds,
    publish_status: "draft",
    inventory_status: "in_stock",
    record_status: "active",
    is_test: isTest,
    square_item_id: "",
    square_variation_id: "",
    square_payment_link_id: "",
    square_checkout_url: "",
    square_payment_link_generation: null,
    ai_draft_flag: "",
    write_source: "supabase",
    supabase_written_at: nowIso,
    sheets_mirror_pending: false,
    synced_from_sheets_at: nowIso,
  };

  await upsertProductBundle(supabase, {
    productRow,
    imageRows,
    translationRow,
    pokemonCardRow,
    documentRow: null,
  });

  const detailResult = await queryProductDetail(supabase, {
    productId,
    isAdmin: true,
  });

  const responsePayload = {
    success: true,
    version: "product-create-v2",
    write_master: "supabase",
    product_id: productId,
    publish_status: "draft",
    inventory_status: "in_stock",
    record_status: "active",
    is_test: isTest,
    drive_folder_url: driveFolderUrl,
    main_image_url: mainImageUrl,
    main_image_display_url: mainImageDisplayUrl,
    image_count: imageRows.length,
    auction_item_number: validatedAuctionItemNumber,
    ...(selectedImageIds.length > 0
      ? {
          selected_image_ids: selectedImageIds,
          ai_selected_image_ids: selectedImageIds,
        }
      : {}),
    ...(detailResult?.body?.product ? { product: detailResult.body.product } : {}),
  };

  if (clientRequestId) {
    try {
      await supabase.from("product_write_idempotency").upsert(
        {
          request_id: clientRequestId,
          payload_hash: payloadHash,
          product_id: productId,
          status: "completed",
          mirror_json: mirrorJson,
          response_json: responsePayload,
          updated_at: nowIso,
        },
        { onConflict: "request_id" }
      );
    } catch {
      // Non-fatal; if retried, `mirror_completed` + existing `products` row still returns `productId` idempotently.
    }
  }

  return {
    status: 200,
    body: isRecovery
      ? {
          ...responsePayload,
          is_reused: true,
          recovered: true,
        }
      : responsePayload,
  };
}

/**
 * Mirrors a committed non-Square draft product state from Supabase -> Google Sheets (`update_product`).
 * Used both synchronously during `updateDraftProduct` and asynchronously by `reconciler.mjs`
 * if a transient GAS error left `sheets_mirror_pending = true`.
 */
export async function mirrorDraftUpdateToSheets({
  fetchImpl = globalThis.fetch,
  gasWebAppUrl,
  productId,
  mirrorPayload,
}) {
  if (!gasWebAppUrl) return { ok: false, skipped: true };
  const res = await fetchImpl(gasWebAppUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      ...mirrorPayload,
      action: "update_product",
      product_id: productId,
    }),
  });
  if (!res.ok) {
    return { ok: false, error: `GAS mirror HTTP ${res.status}` };
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    return { ok: false, error: "Invalid JSON from GAS mirror" };
  }
  if (!json || json.success !== true) {
    return {
      ok: false,
      error: json?.message || json?.error || "GAS mirror returned success=false",
      errorCode: json?.error_code,
    };
  }
  return { ok: true };
}

/**
 * Mirrors a committed non-Square draft `inventory_status` from Supabase -> Google Sheets
 * (`update_inventory_status`).
 */
export async function mirrorInventoryStatusToSheets({
  fetchImpl = globalThis.fetch,
  gasWebAppUrl,
  productId,
  inventoryStatus,
}) {
  if (!gasWebAppUrl) return { ok: false, skipped: true };
  const res = await fetchImpl(gasWebAppUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      action: "update_inventory_status",
      product_id: productId,
      inventory_status: inventoryStatus,
    }),
  });
  if (!res.ok) {
    return { ok: false, error: `GAS inventory_status mirror HTTP ${res.status}` };
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    return { ok: false, error: "Invalid JSON from GAS inventory_status mirror" };
  }
  if (!json || json.success !== true) {
    return {
      ok: false,
      error:
        json?.message ||
        json?.error ||
        "GAS inventory_status mirror returned success=false",
      errorCode: json?.error_code,
    };
  }
  return { ok: true };
}

/**
 * Mirrors a committed non-Square draft `record_status` (`active` / `archived`) from Supabase
 * -> Google Sheets (`update_record_status`).
 */
export async function mirrorRecordStatusToSheets({
  fetchImpl = globalThis.fetch,
  gasWebAppUrl,
  productId,
  recordStatus,
}) {
  if (!gasWebAppUrl) return { ok: false, skipped: true };
  const res = await fetchImpl(gasWebAppUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      action: "update_record_status",
      product_id: productId,
      record_status: recordStatus,
    }),
  });
  if (!res.ok) {
    return { ok: false, error: `GAS record_status mirror HTTP ${res.status}` };
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    return { ok: false, error: "Invalid JSON from GAS record_status mirror" };
  }
  if (!json || json.success !== true) {
    return {
      ok: false,
      error:
        json?.message ||
        json?.error ||
        "GAS record_status mirror returned success=false",
      errorCode: json?.error_code,
    };
  }
  return { ok: true };
}

const EXISTING_DETAIL_FOR_UPDATE_SELECT = [
  "*",
  "product_images(sort_order,file_id,name,mime_type,view_url,display_url)",
  "product_translations(locale,translated_title,translated_description,translated_condition,translated_box,translated_accessories,translation_status,generated_at)",
  "pokemon_cards(product_id,card_name,set_name,card_number,rarity,language,grading_status,grader,grade,certification_number,card_condition,source_created_at,source_updated_at)",
].join(",");

/**
 * Phase 2 Unit 1: Update an existing non-Square draft product via Cloud Run + Supabase.
 * - Enforces 100% of GAS Phase 1 pre-validation rules BEFORE writing any table
 *   (so e.g. invalid `planned_sale_price` never partially saves `translated_title`).
 * - Blocks published products (`PUBLISHED_AI_PRODUCT_EDIT_BLOCKED` / `NON_DRAFT_PRODUCT`)
 *   and Square-linked products (`SQUARE_LINKED_PRODUCT`).
 * - Commits directly to Supabase (`write_source = 'supabase'`) FIRST, then mirrors to
 *   Google Sheets so AI batch, `confirmed_fingerprint`, and future Square publish stay in sync.
 */
export async function updateDraftProduct({
  supabase,
  fetchImpl = globalThis.fetch,
  gasWebAppUrl,
  productId,
  payload = {},
}) {
  const normId = asTrimmedString(productId || payload?.product_id);
  if (!normId) {
    throw new ProductWriteError(
      400,
      "PRODUCT_ID_REQUIRED",
      "product_id is required"
    );
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ProductWriteError(
      400,
      "INVALID_PAYLOAD",
      "JSON object body is required"
    );
  }

  const { data: current, error: fetchErr } = await supabase
    .from("products")
    .select(EXISTING_DETAIL_FOR_UPDATE_SELECT)
    .eq("product_id", normId)
    .maybeSingle();

  if (fetchErr) {
    throw new Error(`Supabase product lookup failed: ${fetchErr.message}`);
  }
  if (!current) {
    throw new ProductWriteError(
      404,
      "PRODUCT_NOT_FOUND",
      `Product not found: ${normId}`
    );
  }

  const currentPublishStatus =
    asTrimmedString(current.publish_status) || "draft";
  const currentAiDraftFlag = asTrimmedString(current.ai_draft_flag);
  const currentCategory = asTrimmedString(current.category);
  const isSquareLinked = hasAnySquareLink(current);
  const hadPriorPendingMirror = current.sheets_mirror_pending === true;

  // =========================================================================
  // Phase 1: Atomic Pre-Validation (zero mutations if ANY check fails)
  // =========================================================================
  if (
    currentAiDraftFlag === "ai_managed" &&
    currentPublishStatus === "published"
  ) {
    throw new ProductWriteError(
      409,
      "PUBLISHED_AI_PRODUCT_EDIT_BLOCKED",
      `[AI Draft] Editing AI managed product while published is not allowed: ${normId}`
    );
  }

  if (currentPublishStatus !== "draft") {
    if (
      Object.prototype.hasOwnProperty.call(payload, "translated_title") &&
      payload.translated_title !== undefined
    ) {
      throw new ProductWriteError(
        400,
        "TRANSLATED_TITLE_DRAFT_ONLY",
        "translated_title can only be updated for draft products"
      );
    }
    throw new ProductWriteError(
      409,
      "NON_DRAFT_PRODUCT",
      "Only draft products without Square linkage can be updated on this endpoint"
    );
  }

  if (isSquareLinked) {
    throw new ProductWriteError(
      409,
      "SQUARE_LINKED_PRODUCT",
      "Square-linked products must use the Square-synchronized update path"
    );
  }

  // 1-1. translated_title validation
  let shouldUpdateTranslatedTitle = false;
  let validatedTranslatedTitle = "";
  if (
    Object.prototype.hasOwnProperty.call(payload, "translated_title") &&
    payload.translated_title !== undefined
  ) {
    validatedTranslatedTitle = asTrimmedString(payload.translated_title);
    if (!validatedTranslatedTitle) {
      throw new ProductWriteError(
        400,
        "TRANSLATED_TITLE_REQUIRED",
        "translated_title cannot be empty"
      );
    }
    shouldUpdateTranslatedTitle = true;
  }

  // 1-2. Category immutability check (exact parity with コード.js L1425-1438)
  if (
    Object.prototype.hasOwnProperty.call(payload, "category") &&
    payload.category !== undefined &&
    payload.category !== null
  ) {
    const incomingCategory = asTrimmedString(payload.category);
    if (incomingCategory !== currentCategory) {
      throw new ProductWriteError(
        400,
        "CATEGORY_IMMUTABLE",
        "product category cannot be changed after creation"
      );
    }
  }

  // 1-3. planned_sale_price validation (must be positive safe integer if non-empty; null/"" clears to 0)
  let shouldUpdatePlannedPrice = false;
  let nextPlannedPrice = toNullableNumber(current.planned_sale_price) ?? 0;
  if (
    Object.prototype.hasOwnProperty.call(payload, "planned_sale_price") &&
    payload.planned_sale_price !== undefined
  ) {
    if (
      payload.planned_sale_price === null ||
      String(payload.planned_sale_price).trim() === ""
    ) {
      nextPlannedPrice = 0;
      shouldUpdatePlannedPrice = true;
    } else {
      const parsedPrice = Number(payload.planned_sale_price);
      if (!Number.isSafeInteger(parsedPrice) || parsedPrice <= 0) {
        throw new ProductWriteError(
          400,
          "INVALID_PLANNED_SALE_PRICE",
          "planned_sale_price must be a positive integer"
        );
      }
      nextPlannedPrice = parsedPrice;
      shouldUpdatePlannedPrice = true;
    }
  }

  let shouldUpdatePurchasePrice = false;
  let nextPurchasePrice = toNullableNumber(current.purchase_price) ?? 0;
  if (
    Object.prototype.hasOwnProperty.call(payload, "purchase_price") &&
    payload.purchase_price !== undefined
  ) {
    if (
      payload.purchase_price === null ||
      String(payload.purchase_price).trim() === ""
    ) {
      nextPurchasePrice = 0;
      shouldUpdatePurchasePrice = true;
    } else {
      const parsedPurchase = Number(
        String(payload.purchase_price).replace(/,/g, "").trim()
      );
      if (!Number.isFinite(parsedPurchase) || parsedPurchase < 0) {
        throw new ProductWriteError(
          400,
          "INVALID_PURCHASE_PRICE",
          "purchase_price must be a non-negative number"
        );
      }
      nextPurchasePrice = parsedPurchase;
      shouldUpdatePurchasePrice = true;
    }
  }

  // 1-4. Pokemon Card validation & top-level card_condition compatibility
  const existingPokemonRow = Array.isArray(current.pokemon_cards)
    ? current.pokemon_cards[0] || null
    : current.pokemon_cards || null;

  const hasPokemonPayload =
    Object.prototype.hasOwnProperty.call(payload, "pokemon_card") &&
    payload.pokemon_card !== undefined;

  let rawPokemonUpdate = null;
  if (hasPokemonPayload) {
    if (
      !payload.pokemon_card ||
      typeof payload.pokemon_card !== "object" ||
      Array.isArray(payload.pokemon_card)
    ) {
      throw new ProductWriteError(
        400,
        "INVALID_POKEMON_CARD_DATA",
        "invalid pokemon_card data"
      );
    }
    rawPokemonUpdate = { ...payload.pokemon_card };
  }

  if (currentCategory === "pokemon_card") {
    let topCardCond = "";
    if (
      Object.prototype.hasOwnProperty.call(payload, "card_condition") &&
      payload.card_condition !== undefined &&
      payload.card_condition !== null
    ) {
      topCardCond = asTrimmedString(payload.card_condition);
    } else if (
      Object.prototype.hasOwnProperty.call(payload, "condition") &&
      payload.condition !== undefined &&
      payload.condition !== null
    ) {
      const condUpper = asTrimmedString(payload.condition).toUpperCase();
      if (["A", "B", "C"].includes(condUpper)) {
        topCardCond = condUpper;
      }
    }
    if (topCardCond) {
      if (!rawPokemonUpdate) rawPokemonUpdate = {};
      if (!rawPokemonUpdate.card_condition) {
        rawPokemonUpdate.card_condition = topCardCond;
      }
    }
  }

  let validatedPokemonRow = null;
  if (currentCategory === "pokemon_card" && rawPokemonUpdate !== null) {
    validatedPokemonRow = validateAndMergePokemonCard(
      normId,
      rawPokemonUpdate,
      existingPokemonRow
    );
  }

  // 1-5. selected_image_ids / ai_selected_image_ids validation
  let shouldUpdateSelectedImages = false;
  let validatedSelectedIds = [];
  const hasSelectedIds =
    (Object.prototype.hasOwnProperty.call(payload, "selected_image_ids") &&
      payload.selected_image_ids !== undefined) ||
    (Object.prototype.hasOwnProperty.call(payload, "ai_selected_image_ids") &&
      payload.ai_selected_image_ids !== undefined);
  if (hasSelectedIds) {
    const rawSel =
      payload.selected_image_ids !== undefined
        ? payload.selected_image_ids
        : payload.ai_selected_image_ids;
    const validFileIds = new Set(
      (Array.isArray(current.product_images) ? current.product_images : [])
        .map((img) => asTrimmedString(img.file_id))
        .filter(Boolean)
    );
    validatedSelectedIds = validateSelectedImageIds(
      rawSel,
      validFileIds,
      normId
    );
    shouldUpdateSelectedImages = true;
  }

  // 1-6. auction_item_number validation (omit/undefined preserves existing; ""/null clears)
  let shouldUpdateAuctionItemNumber = false;
  let validatedAuctionItemNumber = asTrimmedString(current.auction_item_number);
  if (
    Object.prototype.hasOwnProperty.call(payload, "auction_item_number") &&
    payload.auction_item_number !== undefined
  ) {
    validatedAuctionItemNumber = normalizeAuctionItemNumberInput(
      payload.auction_item_number
    );
    shouldUpdateAuctionItemNumber = true;
  }

  // =========================================================================
  // Phase 2: Build Authoritative Patch & Persist to Supabase FIRST
  // =========================================================================
  const nowIso = new Date().toISOString();
  const productPatch = {
    write_source: "supabase",
    supabase_written_at: nowIso,
    sheets_mirror_pending: Boolean(gasWebAppUrl),
  };
  const mirrorPayload = {};

  if (Object.prototype.hasOwnProperty.call(payload, "brand") && payload.brand !== undefined) {
    productPatch.brand = asTrimmedString(payload.brand);
    mirrorPayload.brand = productPatch.brand;
  }
  if (
    Object.prototype.hasOwnProperty.call(payload, "product_name") &&
    payload.product_name !== undefined
  ) {
    productPatch.product_name = asRawString(payload.product_name ?? "").trim();
    mirrorPayload.product_name = productPatch.product_name;
  }
  if (
    Object.prototype.hasOwnProperty.call(payload, "condition") &&
    payload.condition !== undefined
  ) {
    const incomingCond = asTrimmedString(payload.condition);
    const skipPokemonAbc =
      currentCategory === "pokemon_card" &&
      ["A", "B", "C"].includes(incomingCond.toUpperCase());
    if (!skipPokemonAbc) {
      productPatch.condition = incomingCond;
      mirrorPayload.condition = incomingCond;
    }
  }
  if (shouldUpdatePurchasePrice) {
    productPatch.purchase_price = nextPurchasePrice;
    mirrorPayload.purchase_price = nextPurchasePrice > 0 ? nextPurchasePrice : "";
  }
  if (shouldUpdatePlannedPrice) {
    productPatch.planned_sale_price = nextPlannedPrice;
    mirrorPayload.planned_sale_price = nextPlannedPrice > 0 ? nextPlannedPrice : "";
  }
  if (
    Object.prototype.hasOwnProperty.call(payload, "storage_location") &&
    payload.storage_location !== undefined
  ) {
    productPatch.storage_location = asTrimmedString(payload.storage_location);
    mirrorPayload.storage_location = productPatch.storage_location;
  }
  if (
    Object.prototype.hasOwnProperty.call(payload, "description") &&
    payload.description !== undefined
  ) {
    productPatch.description = asRawString(payload.description ?? "");
    mirrorPayload.description = productPatch.description;
  }
  if (
    Object.prototype.hasOwnProperty.call(payload, "notes") &&
    payload.notes !== undefined
  ) {
    productPatch.notes = asRawString(payload.notes ?? "");
    mirrorPayload.notes = productPatch.notes;
  }

  // Category-scoped column guards (exact parity with コード.js L1737-1755)
  if (currentCategory === "sneaker") {
    for (const k of SNEAKER_KEYS) {
      if (Object.prototype.hasOwnProperty.call(payload, k) && payload[k] !== undefined) {
        productPatch[k] = asTrimmedString(payload[k]);
        mirrorPayload[k] = productPatch[k];
      }
    }
  }
  if (currentCategory === "jewelry") {
    for (const k of JEWELRY_KEYS) {
      if (Object.prototype.hasOwnProperty.call(payload, k) && payload[k] !== undefined) {
        productPatch[k] = asTrimmedString(payload[k]);
        mirrorPayload[k] = productPatch[k];
      }
    }
  }
  if (currentCategory === "apparel" || currentCategory === "fashion_goods") {
    if (
      (Object.prototype.hasOwnProperty.call(payload, "subcategory") &&
        payload.subcategory !== undefined) ||
      (Object.prototype.hasOwnProperty.call(payload, "sub_category") &&
        payload.sub_category !== undefined)
    ) {
      const subVal = asTrimmedString(
        payload.subcategory !== undefined
          ? payload.subcategory
          : payload.sub_category
      );
      productPatch.subcategory = subVal;
      mirrorPayload.subcategory = subVal;
    }
    if (
      Object.prototype.hasOwnProperty.call(payload, "size") &&
      payload.size !== undefined
    ) {
      productPatch.size = asTrimmedString(payload.size);
      mirrorPayload.size = productPatch.size;
    }
    if (
      (Object.prototype.hasOwnProperty.call(payload, "official_sku") &&
        payload.official_sku !== undefined) ||
      (Object.prototype.hasOwnProperty.call(payload, "sku") &&
        payload.sku !== undefined)
    ) {
      const skuVal = asTrimmedString(
        payload.official_sku !== undefined ? payload.official_sku : payload.sku
      );
      productPatch.official_sku = skuVal;
      mirrorPayload.official_sku = skuVal;
    }
  }

  if (shouldUpdateTranslatedTitle) {
    productPatch.translated_title = validatedTranslatedTitle;
    mirrorPayload.translated_title = validatedTranslatedTitle;
  }
  if (shouldUpdateSelectedImages) {
    productPatch.selected_image_ids = validatedSelectedIds;
    mirrorPayload.selected_image_ids = validatedSelectedIds;
  }
  if (shouldUpdateAuctionItemNumber) {
    productPatch.auction_item_number = validatedAuctionItemNumber;
    mirrorPayload.auction_item_number = validatedAuctionItemNumber;
  }

  const { error: prodUpdateErr } = await supabase
    .from("products")
    .update(productPatch)
    .eq("product_id", normId);
  if (prodUpdateErr) {
    throw new Error(
      `Supabase products update failed for ${normId}: ${prodUpdateErr.message}`
    );
  }

  // Update product_translations while preserving existing description / status
  if (shouldUpdateTranslatedTitle) {
    const transList = Array.isArray(current.product_translations)
      ? current.product_translations
      : current.product_translations
        ? [current.product_translations]
        : [];
    const existingEn =
      transList.find((t) => asTrimmedString(t.locale || "en") === "en") ||
      transList[0] ||
      null;

    const transRow = {
      product_id: normId,
      locale: "en",
      translated_title: validatedTranslatedTitle,
      translated_description: existingEn
        ? asRawString(existingEn.translated_description ?? "")
        : "",
      translated_condition: existingEn
        ? asTrimmedString(existingEn.translated_condition)
        : "",
      translated_box: existingEn
        ? asTrimmedString(existingEn.translated_box)
        : "",
      translated_accessories: existingEn
        ? asTrimmedString(existingEn.translated_accessories)
        : "",
      translation_status: existingEn
        ? asTrimmedString(existingEn.translation_status) || "approved"
        : "approved",
      generated_at: nowIso,
    };

    const { error: transErr } = await supabase
      .from("product_translations")
      .upsert(transRow, { onConflict: "product_id,locale" });
    if (transErr) {
      throw new Error(
        `Supabase product_translations upsert failed for ${normId}: ${transErr.message}`
      );
    }
  }

  // Update pokemon_cards if applicable
  if (validatedPokemonRow) {
    const { error: pkmErr } = await supabase
      .from("pokemon_cards")
      .upsert(validatedPokemonRow, { onConflict: "product_id" });
    if (pkmErr) {
      throw new Error(
        `Supabase pokemon_cards upsert failed for ${normId}: ${pkmErr.message}`
      );
    }
    mirrorPayload.pokemon_card = {
      card_name: validatedPokemonRow.card_name,
      set_name: validatedPokemonRow.set_name,
      card_number: validatedPokemonRow.card_number,
      rarity: validatedPokemonRow.rarity,
      language: validatedPokemonRow.language,
      grading_status: validatedPokemonRow.grading_status,
      grader: validatedPokemonRow.grader,
      grade: validatedPokemonRow.grade,
      certification_number: validatedPokemonRow.certification_number,
      card_condition: validatedPokemonRow.card_condition,
    };
  }

  // Keep Supabase `product_ai_drafts.confirmed_fingerprint` aligned when staff manually edits an AI-managed draft
  if (currentAiDraftFlag === "ai_managed") {
    try {
      const { data: latestAiDraft } = await supabase
        .from("product_ai_drafts")
        .select("draft_id, review_status")
        .eq("product_id", normId)
        .order("draft_version", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (
        latestAiDraft &&
        asTrimmedString(latestAiDraft.review_status) === "confirmed"
      ) {
        const transList = Array.isArray(current.product_translations)
          ? current.product_translations
          : current.product_translations
            ? [current.product_translations]
            : [];
        const baseTrans =
          transList.find((t) => asTrimmedString(t.locale || "en") === "en") ||
          transList[0] ||
          null;
        const nextTrans = shouldUpdateTranslatedTitle
          ? {
              ...(baseTrans || {}),
              translated_title: validatedTranslatedTitle,
              translation_status: baseTrans
                ? asTrimmedString(baseTrans.translation_status) || "approved"
                : "approved",
            }
          : baseTrans;
        const nextPkm =
          validatedPokemonRow ||
          (Array.isArray(current.pokemon_cards)
            ? current.pokemon_cards[0]
            : current.pokemon_cards) ||
          null;
        const nextFp = computeSupabaseConfirmedFingerprint(
          { ...current, ...updateRow },
          nextPkm,
          nextTrans,
          Array.isArray(current.product_images) ? current.product_images : []
        );
        await supabase
          .from("product_ai_drafts")
          .update({
            confirmed_fingerprint: nextFp,
            updated_at: nowIso,
          })
          .eq("draft_id", asTrimmedString(latestAiDraft.draft_id));
      }
    } catch {
      // Non-fatal if `product_ai_drafts` mock is absent in legacy unit tests
    }
  }

  // =========================================================================
  // Phase 3: Synchronous Downstream Compatibility Mirror to Google Sheets
  //          (keeps Sheets, GAS Cache, and AI `confirmed_fingerprint` aligned)
  // =========================================================================
  let sheetsMirrored = false;
  if (gasWebAppUrl) {
    try {
      const mirrorRes = await mirrorDraftUpdateToSheets({
        fetchImpl,
        gasWebAppUrl,
        productId: normId,
        mirrorPayload,
      });
      if (mirrorRes.ok) {
        if (hadPriorPendingMirror) {
          sheetsMirrored = await flushPendingSupabaseDraftToSheets({
            supabase,
            fetchImpl,
            gasWebAppUrl,
            productId: normId,
          });
        } else {
          sheetsMirrored = true;
          await supabase
            .from("products")
            .update({
              sheets_mirror_pending: false,
              synced_from_sheets_at: new Date().toISOString(),
            })
            .eq("product_id", normId);
        }
        if (currentAiDraftFlag === "ai_managed") {
          await syncAiProductDraftsFromGas({
            supabase,
            fetchImpl,
            gasWebAppUrl,
            productIds: [normId],
          }).catch(() => {});
        }
      } else {
        console.warn(
          JSON.stringify({
            severity: "WARNING",
            message: `Sheets compatibility mirror deferred for ${normId}: ${mirrorRes.error}`,
          })
        );
      }
    } catch (mirrorErr) {
      console.warn(
        JSON.stringify({
          severity: "WARNING",
          message: `Sheets compatibility mirror network error for ${normId}: ${
            mirrorErr instanceof Error ? mirrorErr.message : String(mirrorErr)
          }`,
        })
      );
    }
  }

  const responsePayload = {
    success: true,
    version: "product-update-v1",
    write_master: "supabase",
    product_id: normId,
    sheets_mirrored: sheetsMirrored,
    ...(shouldUpdateSelectedImages
      ? {
          selected_image_ids: validatedSelectedIds,
          ai_selected_image_ids: validatedSelectedIds,
        }
      : {}),
    ...(shouldUpdateAuctionItemNumber
      ? {
          auction_item_number: validatedAuctionItemNumber,
        }
      : {}),
  };

  return {
    status: 200,
    body: responsePayload,
  };
}

/**
 * Phase 2 Unit 3: Update `inventory_status` (`in_stock` / `reserved` / `sold`) for a
 * non-Square draft product via Cloud Run + Supabase (`write_source = 'supabase'`).
 * - Rejects published (`409 NON_DRAFT_PRODUCT`) and Square-linked (`409 SQUARE_LINKED_PRODUCT`)
 *   products Fail-Closed so Square inventory / Payment Link operations remain on GAS.
 * - Saves to Supabase FIRST (`sheets_mirror_pending = true`), then mirrors to Google Sheets
 *   (`update_inventory_status`) with deferred replay via `reconciler.mjs` if GAS is unavailable.
 */
export async function updateDraftInventoryStatus({
  supabase,
  fetchImpl = globalThis.fetch,
  gasWebAppUrl,
  productId,
  payload = {},
}) {
  const normId = asTrimmedString(productId || payload?.product_id);
  if (!normId) {
    throw new ProductWriteError(
      400,
      "PRODUCT_ID_REQUIRED",
      "product_id is required"
    );
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ProductWriteError(
      400,
      "INVALID_PAYLOAD",
      "JSON object body is required"
    );
  }

  const targetInventoryStatus = asTrimmedString(payload.inventory_status);
  if (!ALLOWED_INVENTORY_STATUSES.has(targetInventoryStatus)) {
    throw new ProductWriteError(
      400,
      "INVALID_INVENTORY_STATUS",
      "invalid inventory_status"
    );
  }

  const { data: current, error: fetchErr } = await supabase
    .from("products")
    .select(
      "product_id, publish_status, inventory_status, record_status, square_item_id, square_variation_id, square_payment_link_id, square_checkout_url, sheets_mirror_pending"
    )
    .eq("product_id", normId)
    .maybeSingle();

  if (fetchErr) {
    throw new Error(`Supabase product lookup failed: ${fetchErr.message}`);
  }
  if (!current) {
    throw new ProductWriteError(
      404,
      "PRODUCT_NOT_FOUND",
      `Product not found: ${normId}`
    );
  }

  const currentPublishStatus =
    asTrimmedString(current.publish_status) || "draft";
  if (currentPublishStatus !== "draft") {
    throw new ProductWriteError(
      409,
      "NON_DRAFT_PRODUCT",
      "Only draft products without Square linkage can update inventory_status on this endpoint"
    );
  }
  if (hasAnySquareLink(current)) {
    throw new ProductWriteError(
      409,
      "SQUARE_LINKED_PRODUCT",
      "Square-linked products must use the Square-synchronized inventory_status path"
    );
  }

  const hadPriorPendingMirror = current.sheets_mirror_pending === true;
  const nowIso = new Date().toISOString();

  const { error: updErr } = await supabase
    .from("products")
    .update({
      inventory_status: targetInventoryStatus,
      write_source: "supabase",
      supabase_written_at: nowIso,
      sheets_mirror_pending: Boolean(gasWebAppUrl),
    })
    .eq("product_id", normId);

  if (updErr) {
    throw new Error(
      `Failed updating inventory_status in Supabase: ${updErr.message}`
    );
  }

  let sheetsMirrored = false;
  if (gasWebAppUrl) {
    try {
      const mirrorRes = await mirrorInventoryStatusToSheets({
        fetchImpl,
        gasWebAppUrl,
        productId: normId,
        inventoryStatus: targetInventoryStatus,
      });
      if (mirrorRes.ok) {
        if (hadPriorPendingMirror) {
          sheetsMirrored = await flushPendingSupabaseDraftToSheets({
            supabase,
            fetchImpl,
            gasWebAppUrl,
            productId: normId,
          });
        } else {
          sheetsMirrored = true;
          await supabase
            .from("products")
            .update({
              sheets_mirror_pending: false,
              synced_from_sheets_at: new Date().toISOString(),
            })
            .eq("product_id", normId);
        }
      } else {
        console.warn(
          JSON.stringify({
            severity: "WARNING",
            message: `Sheets inventory_status mirror deferred for ${normId}: ${mirrorRes.error}`,
          })
        );
      }
    } catch (mirrorErr) {
      console.warn(
        JSON.stringify({
          severity: "WARNING",
          message: `Sheets inventory_status mirror network error for ${normId}: ${
            mirrorErr instanceof Error ? mirrorErr.message : String(mirrorErr)
          }`,
        })
      );
    }
  }

  return {
    status: 200,
    body: {
      success: true,
      version: "inventory-status-update-v1",
      write_master: "supabase",
      product_id: normId,
      inventory_status: targetInventoryStatus,
      sheets_mirrored: sheetsMirrored,
    },
  };
}

/**
 * Phase 2 Unit 3: Update `record_status` (`active` / `archived`) for a non-Square draft
 * product via Cloud Run + Supabase (`write_source = 'supabase'`).
 * - Rejects published (`409 NON_DRAFT_PRODUCT`) and Square-linked (`409 SQUARE_LINKED_PRODUCT`)
 *   products Fail-Closed so Square archive / payment-link flows remain on GAS.
 * - Preserves exact GAS restore semantics (`コード.js` `handleUpdateRecordStatus`):
 *   - Restoring `archived` -> `active` fixes `publish_status = 'draft'` and preserves existing
 *     `inventory_status` (`sold` / `reserved` / `in_stock`) unchanged.
 * - Saves to Supabase FIRST (`sheets_mirror_pending = true`), then mirrors to Google Sheets
 *   (`update_record_status`) with deferred replay via `reconciler.mjs` if GAS is unavailable.
 */
export async function updateDraftRecordStatus({
  supabase,
  fetchImpl = globalThis.fetch,
  gasWebAppUrl,
  productId,
  payload = {},
}) {
  const normId = asTrimmedString(productId || payload?.product_id);
  if (!normId) {
    throw new ProductWriteError(
      400,
      "PRODUCT_ID_REQUIRED",
      "product_id is required"
    );
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ProductWriteError(
      400,
      "INVALID_PAYLOAD",
      "JSON object body is required"
    );
  }

  const targetRecordStatus = asTrimmedString(payload.record_status);
  if (!ALLOWED_RECORD_STATUSES.has(targetRecordStatus)) {
    throw new ProductWriteError(
      400,
      "INVALID_RECORD_STATUS",
      "invalid record_status"
    );
  }

  const { data: current, error: fetchErr } = await supabase
    .from("products")
    .select(
      "product_id, publish_status, inventory_status, record_status, square_item_id, square_variation_id, square_payment_link_id, square_checkout_url, sheets_mirror_pending"
    )
    .eq("product_id", normId)
    .maybeSingle();

  if (fetchErr) {
    throw new Error(`Supabase product lookup failed: ${fetchErr.message}`);
  }
  if (!current) {
    throw new ProductWriteError(
      404,
      "PRODUCT_NOT_FOUND",
      `Product not found: ${normId}`
    );
  }

  const currentPublishStatus =
    asTrimmedString(current.publish_status) || "draft";
  if (currentPublishStatus !== "draft") {
    throw new ProductWriteError(
      409,
      "NON_DRAFT_PRODUCT",
      "Only draft products without Square linkage can update record_status on this endpoint"
    );
  }
  if (hasAnySquareLink(current)) {
    throw new ProductWriteError(
      409,
      "SQUARE_LINKED_PRODUCT",
      "Square-linked products must use the Square-synchronized record_status path"
    );
  }

  const currentInventoryStatus =
    asTrimmedString(current.inventory_status) || "in_stock";
  const finalPublishStatus = "draft";
  const hadPriorPendingMirror = current.sheets_mirror_pending === true;
  const nowIso = new Date().toISOString();

  const { error: updErr } = await supabase
    .from("products")
    .update({
      record_status: targetRecordStatus,
      publish_status: finalPublishStatus,
      write_source: "supabase",
      supabase_written_at: nowIso,
      sheets_mirror_pending: Boolean(gasWebAppUrl),
    })
    .eq("product_id", normId);

  if (updErr) {
    throw new Error(
      `Failed updating record_status in Supabase: ${updErr.message}`
    );
  }

  let sheetsMirrored = false;
  if (gasWebAppUrl) {
    try {
      const mirrorRes = await mirrorRecordStatusToSheets({
        fetchImpl,
        gasWebAppUrl,
        productId: normId,
        recordStatus: targetRecordStatus,
      });
      if (mirrorRes.ok) {
        if (hadPriorPendingMirror) {
          sheetsMirrored = await flushPendingSupabaseDraftToSheets({
            supabase,
            fetchImpl,
            gasWebAppUrl,
            productId: normId,
          });
        } else {
          sheetsMirrored = true;
          await supabase
            .from("products")
            .update({
              sheets_mirror_pending: false,
              synced_from_sheets_at: new Date().toISOString(),
            })
            .eq("product_id", normId);
        }
      } else {
        console.warn(
          JSON.stringify({
            severity: "WARNING",
            message: `Sheets record_status mirror deferred for ${normId}: ${mirrorRes.error}`,
          })
        );
      }
    } catch (mirrorErr) {
      console.warn(
        JSON.stringify({
          severity: "WARNING",
          message: `Sheets record_status mirror network error for ${normId}: ${
            mirrorErr instanceof Error ? mirrorErr.message : String(mirrorErr)
          }`,
        })
      );
    }
  }

  return {
    status: 200,
    body: {
      success: true,
      version: "record-status-update-v1",
      write_master: "supabase",
      product_id: normId,
      record_status: targetRecordStatus,
      publish_status: finalPublishStatus,
      inventory_status: currentInventoryStatus,
      sheets_mirrored: sheetsMirrored,
    },
  };
}

function sameNormalizedStringList(a, b) {
  const arrA = normalizeStringArray(a);
  const arrB = normalizeStringArray(b);
  if (arrA.length !== arrB.length) return false;
  for (let i = 0; i < arrA.length; i++) {
    if (arrA[i] !== arrB[i]) return false;
  }
  return true;
}

function hasDraftAttributeDifference(gasDetail, sbRow) {
  if (!gasDetail || !sbRow) return true;
  if (asTrimmedString(gasDetail.brand) !== asTrimmedString(sbRow.brand)) return true;
  if (
    asRawString(gasDetail.product_name ?? "").trim() !==
    asRawString(sbRow.product_name ?? "").trim()
  ) {
    return true;
  }
  if (
    asTrimmedString(gasDetail.translated_title) !==
    asTrimmedString(sbRow.translated_title)
  ) {
    return true;
  }
  if (asTrimmedString(gasDetail.condition) !== asTrimmedString(sbRow.condition)) {
    return true;
  }
  const gasPurchase = Number(toNullableNumber(gasDetail.purchase_price) ?? 0) || 0;
  const sbPurchase = Number(toNullableNumber(sbRow.purchase_price) ?? 0) || 0;
  if (gasPurchase !== sbPurchase) return true;

  const gasPlanned =
    Number(toNullableNumber(gasDetail.planned_sale_price) ?? 0) || 0;
  const sbPlanned = Number(toNullableNumber(sbRow.planned_sale_price) ?? 0) || 0;
  if (gasPlanned !== sbPlanned) return true;

  if (
    asTrimmedString(gasDetail.storage_location) !==
    asTrimmedString(sbRow.storage_location)
  ) {
    return true;
  }
  if (
    asRawString(gasDetail.description ?? "") !==
    asRawString(sbRow.description ?? "")
  ) {
    return true;
  }
  if (asRawString(gasDetail.notes ?? "") !== asRawString(sbRow.notes ?? "")) {
    return true;
  }
  if (
    asTrimmedString(gasDetail.auction_item_number) !==
    asTrimmedString(sbRow.auction_item_number)
  ) {
    return true;
  }
  const gasSelected =
    gasDetail.selected_image_ids ?? gasDetail.ai_selected_image_ids ?? [];
  if (!sameNormalizedStringList(gasSelected, sbRow.selected_image_ids)) {
    return true;
  }

  const cat = asTrimmedString(sbRow.category);
  if (cat === "sneaker") {
    for (const k of SNEAKER_KEYS) {
      if (asTrimmedString(gasDetail[k]) !== asTrimmedString(sbRow[k])) {
        return true;
      }
    }
  }
  if (cat === "jewelry") {
    for (const k of JEWELRY_KEYS) {
      if (asTrimmedString(gasDetail[k]) !== asTrimmedString(sbRow[k])) {
        return true;
      }
    }
  }
  if (cat === "apparel" || cat === "fashion_goods") {
    const gasSub = asTrimmedString(
      gasDetail.subcategory ?? gasDetail.sub_category
    );
    if (gasSub !== asTrimmedString(sbRow.subcategory)) return true;
    if (asTrimmedString(gasDetail.size) !== asTrimmedString(sbRow.size)) {
      return true;
    }
    const gasSku = asTrimmedString(gasDetail.official_sku ?? gasDetail.sku);
    if (gasSku !== asTrimmedString(sbRow.official_sku)) return true;
  }
  if (cat === "pokemon_card") {
    const sbPkm = Array.isArray(sbRow.pokemon_cards)
      ? sbRow.pokemon_cards[0]
      : sbRow.pokemon_cards;
    const gasPkm = gasDetail.pokemon_card || null;
    if (sbPkm && asTrimmedString(sbPkm.card_name) && asTrimmedString(sbPkm.language)) {
      if (!gasPkm) return true;
      for (const k of POKEMON_BUSINESS_FIELDS) {
        if (asTrimmedString(gasPkm[k]) !== asTrimmedString(sbPkm[k])) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Replays all pending fields/statuses of a Supabase draft row (with `sheets_mirror_pending = true`)
 * to Google Sheets so `reconciler.mjs` never clobbers a Supabase-committed draft edit or status
 * transition (`inventory_status` / `record_status`) with stale Sheets data.
 */
export async function flushPendingSupabaseDraftToSheets({
  supabase,
  fetchImpl = globalThis.fetch,
  gasWebAppUrl,
  productId,
}) {
  if (!gasWebAppUrl) return false;
  const { data: row, error } = await supabase
    .from("products")
    .select(EXISTING_DETAIL_FOR_UPDATE_SELECT)
    .eq("product_id", productId)
    .maybeSingle();
  if (error || !row) return false;

  if (
    (asTrimmedString(row.publish_status) || "draft") !== "draft" ||
    hasAnySquareLink(row)
  ) {
    return false;
  }

  // Inspect current GAS product state so we only invoke the exact GAS mirror action(s) that differ
  // (attributes via `update_product`, `inventory_status`, and/or `record_status`), and never replay
  // draft writes if GAS already linked/published the item.
  let gasDetail = null;
  try {
    const detRes = await fetchImpl(
      `${gasWebAppUrl}?mode=admin&product_id=${encodeURIComponent(productId)}`,
      { method: "GET" }
    );
    if (!detRes.ok) return false;
    const detJson = await detRes.json();
    if (!detJson || detJson.success !== true || !detJson.product) {
      return false;
    }
    gasDetail = detJson.product;
  } catch {
    return false;
  }

  if (
    (asTrimmedString(gasDetail.publish_status) || "draft") !== "draft" ||
    hasAnySquareLink(gasDetail)
  ) {
    return false;
  }

  const targetRec = asTrimmedString(row.record_status) || "active";
  const gasRec = asTrimmedString(gasDetail.record_status) || "active";
  const needRecMirror = gasRec !== targetRec;

  // If restoring `archived` -> `active`, flip `record_status` in Sheets first so AI draft mirror (which requires `active`) succeeds
  let recMirroredEarly = false;
  if (needRecMirror && targetRec === "active") {
    const recRes = await mirrorRecordStatusToSheets({
      fetchImpl,
      gasWebAppUrl,
      productId,
      recordStatus: targetRec,
    });
    if (!recRes.ok) return false;
    recMirroredEarly = true;
  }

  // If `ai_draft_flag === 'ai_managed'`, replay AI draft state (`AN` flag, initial `C` category when empty, translations, `product_ai_drafts`) first
  if (
    asTrimmedString(row.ai_draft_flag) === "ai_managed" &&
    asTrimmedString(process.env.PRODUCTS_API_INTERNAL_SECRET)
  ) {
    const aiFlushed = await flushPendingAiDraftStateToSheets({
      supabase,
      fetchImpl,
      gasWebAppUrl,
      internalSecret: process.env.PRODUCTS_API_INTERNAL_SECRET,
      productRow: row,
    });
    if (!aiFlushed) return false;
  }

  const needAttrMirror = hasDraftAttributeDifference(gasDetail, row);
  const targetInv = asTrimmedString(row.inventory_status) || "in_stock";
  const gasInv = asTrimmedString(gasDetail.inventory_status) || "in_stock";
  const needInvMirror = gasInv !== targetInv;

  if (needAttrMirror) {
    const cat = asTrimmedString(row.category);
    const mirrorPayload = {
      brand: asTrimmedString(row.brand),
      product_name: asRawString(row.product_name ?? "").trim(),
      condition: asTrimmedString(row.condition),
      purchase_price:
        toNullableNumber(row.purchase_price) && Number(row.purchase_price) > 0
          ? Number(row.purchase_price)
          : "",
      planned_sale_price:
        toNullableNumber(row.planned_sale_price) &&
        Number(row.planned_sale_price) > 0
          ? Number(row.planned_sale_price)
          : "",
      storage_location: asTrimmedString(row.storage_location),
      description: asRawString(row.description ?? ""),
      notes: asRawString(row.notes ?? ""),
      auction_item_number: asTrimmedString(row.auction_item_number),
      selected_image_ids: normalizeStringArray(row.selected_image_ids),
    };

    const tTitle = asTrimmedString(row.translated_title);
    if (tTitle) {
      mirrorPayload.translated_title = tTitle;
    }
    if (cat === "sneaker") {
      for (const k of SNEAKER_KEYS) mirrorPayload[k] = asTrimmedString(row[k]);
    }
    if (cat === "jewelry") {
      for (const k of JEWELRY_KEYS) mirrorPayload[k] = asTrimmedString(row[k]);
    }
    if (cat === "apparel" || cat === "fashion_goods") {
      for (const k of APPAREL_FASHION_CANONICAL_KEYS) {
        mirrorPayload[k] = asTrimmedString(row[k]);
      }
    }
    if (cat === "pokemon_card") {
      const pkm = Array.isArray(row.pokemon_cards)
        ? row.pokemon_cards[0]
        : row.pokemon_cards;
      if (
        pkm &&
        asTrimmedString(pkm.card_name) &&
        asTrimmedString(pkm.language)
      ) {
        mirrorPayload.pokemon_card = {
          card_name: asTrimmedString(pkm.card_name),
          set_name: asTrimmedString(pkm.set_name),
          card_number: asTrimmedString(pkm.card_number),
          rarity: asTrimmedString(pkm.rarity),
          language: asTrimmedString(pkm.language),
          grading_status: asTrimmedString(pkm.grading_status) || "ungraded",
          grader: asTrimmedString(pkm.grader),
          grade: asTrimmedString(pkm.grade),
          certification_number: asTrimmedString(pkm.certification_number),
          card_condition: asTrimmedString(pkm.card_condition),
        };
      }
    }

    const attrRes = await mirrorDraftUpdateToSheets({
      fetchImpl,
      gasWebAppUrl,
      productId,
      mirrorPayload,
    });
    if (!attrRes.ok) return false;
  }

  if (needInvMirror) {
    const invRes = await mirrorInventoryStatusToSheets({
      fetchImpl,
      gasWebAppUrl,
      productId,
      inventoryStatus: targetInv,
    });
    if (!invRes.ok) return false;
  }

  if (needRecMirror && !recMirroredEarly) {
    const recRes = await mirrorRecordStatusToSheets({
      fetchImpl,
      gasWebAppUrl,
      productId,
      recordStatus: targetRec,
    });
    if (!recRes.ok) return false;
  }

  await supabase
    .from("products")
    .update({
      sheets_mirror_pending: false,
      synced_from_sheets_at: new Date().toISOString(),
    })
    .eq("product_id", productId);
  return true;
}

/**
 * Computes deterministic SHA-256 fingerprint for multi-image import (`import_product_by_images`).
 * Detects any change in image count, image order, file_name, mime_type, image bytes,
 * auction_item_number, or optional product attributes. `publish_status` is fixed to `"draft"`.
 */
export function computeImportPayloadFingerprint(
  normalizedImages,
  normalizedFields,
  pokemonCardInput = null,
  isTest = false
) {
  const canonical = {
    images: normalizedImages.map((img, idx) => ({
      idx,
      name: img.file_name,
      mime: img.mime_type,
      sha256: img.sha256,
    })),
    publish_status: "draft",
    fields: normalizedFields,
    ...(isTest ? { is_test: true } : {}),
    pokemon_card: pokemonCardInput || null,
  };
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical), "utf8")
    .digest("hex");
}

function importContractRejected(errorCode, message, attemptId = "") {
  return {
    status: 200,
    body: {
      success: false,
      error_code: errorCode,
      message,
      ...(attemptId ? { import_attempt_id: attemptId } : {}),
    },
  };
}

/**
 * Phase 2 Unit 2: Multi-image product import via Cloud Run + Supabase (`POST /products/import`).
 * - Preserves 100% of `import_product_by_images` response & idempotency contract:
 *   - Requires `import_attempt_id` (`IMPORT_ATTEMPT_ID_REQUIRED`) and 1..20 valid images.
 *   - Enforces SHA-256 `payload_fingerprint` (`IMPORT_IDEMPOTENCY_PAYLOAD_MISMATCH`).
 *   - Recovers mid-flight failures (after Drive upload / Sheets append / before Supabase commit)
 *     on retry with the same `import_attempt_id`, returning `is_reused: true` with 0 duplicates.
 *   - Forces `publish_status = "draft"`.
 *   - Uses GAS strictly as physical Google Drive storage (`ROOT_FOLDER_ID/<product_id>/01_main_...`)
 *     + downstream `シート1` compatibility row for AI batch & Square publish.
 */
export async function importProductByImages({
  supabase,
  fetchImpl = globalThis.fetch,
  gasWebAppUrl,
  payload = {},
}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return importContractRejected(
      "INVALID_PAYLOAD",
      "JSON object body is required"
    );
  }

  const attemptId = asTrimmedString(payload.import_attempt_id);
  if (!attemptId) {
    return importContractRejected(
      "IMPORT_ATTEMPT_ID_REQUIRED",
      "import_attempt_id is required"
    );
  }

  if (!Array.isArray(payload.images) || payload.images.length === 0) {
    return importContractRejected(
      "EMPTY_IMAGES",
      "images array is required and must not be empty",
      attemptId
    );
  }

  if (payload.images.length > MAX_IMAGES_PER_PRODUCT) {
    return importContractRejected(
      "MAX_IMAGE_COUNT_EXCEEDED",
      "maximum image count is 20",
      attemptId
    );
  }

  const normalizedImages = [];
  for (let i = 0; i < payload.images.length; i++) {
    const img = payload.images[i];
    if (!img || typeof img !== "object" || Array.isArray(img)) {
      return importContractRejected(
        "INVALID_IMAGE_PAYLOAD",
        `image at index ${i} must be an object`,
        attemptId
      );
    }
    const rawStr = String(img.base64 ?? "").trim();
    if (!rawStr) {
      return importContractRejected(
        "EMPTY_IMAGE_BASE64",
        `image at index ${i} has empty base64 data`,
        attemptId
      );
    }
    const strippedCheck = rawStr.replace(/^data:[^;]+;base64,/i, "").trim();
    if (!strippedCheck) {
      return importContractRejected(
        "EMPTY_IMAGE_BASE64",
        `image at index ${i} has empty base64 data`,
        attemptId
      );
    }

    let parsed;
    try {
      parsed = extractRawBase64AndMime(img.base64, img.mime_type);
    } catch (imgErr) {
      if (imgErr instanceof ProductWriteError) {
        return importContractRejected(
          imgErr.errorCode || "INVALID_IMAGE_BASE64",
          `image at index ${i}: ${imgErr.message}`,
          attemptId
        );
      }
      throw imgErr;
    }

    const fileName = asTrimmedString(img.file_name || img.name) || "image.jpg";
    normalizedImages.push({
      file_name: fileName,
      mime_type: parsed.mime_type,
      base64: parsed.base64,
      sha256: parsed.sha256,
    });
  }

  let validatedAuctionItemNumber = "";
  if (Object.prototype.hasOwnProperty.call(payload, "auction_item_number")) {
    try {
      validatedAuctionItemNumber = normalizeAuctionItemNumberInput(
        payload.auction_item_number
      );
    } catch (aucErr) {
      if (aucErr instanceof ProductWriteError) {
        return importContractRejected(
          aucErr.errorCode || "INVALID_AUCTION_ITEM_NUMBER",
          aucErr.message,
          attemptId
        );
      }
      throw aucErr;
    }
  }

  const category = asTrimmedString(payload.category);
  const isPokemonCard = category === "pokemon_card";
  const isSneaker = category === "sneaker";
  const isJewelry = category === "jewelry";
  const isApparelOrFashion =
    category === "apparel" || category === "fashion_goods";

  if (isPokemonCard) {
    try {
      validateAndMergePokemonCard("", payload.pokemon_card, null);
    } catch (pkmErr) {
      if (pkmErr instanceof ProductWriteError) {
        return importContractRejected(
          pkmErr.errorCode || "INVALID_POKEMON_CARD_DATA",
          pkmErr.message,
          attemptId
        );
      }
      throw pkmErr;
    }
  }

  const purchasePrice =
    payload.purchase_price === undefined ||
    payload.purchase_price === null ||
    String(payload.purchase_price).trim() === ""
      ? 0
      : Number(String(payload.purchase_price).replace(/,/g, "").trim()) || 0;
  const plannedSalePrice =
    payload.planned_sale_price === undefined ||
    payload.planned_sale_price === null ||
    String(payload.planned_sale_price).trim() === ""
      ? 0
      : Number(String(payload.planned_sale_price).replace(/,/g, "").trim()) || 0;

  let condition = asTrimmedString(payload.condition);
  if (isPokemonCard && ["A", "B", "C"].includes(condition.toUpperCase())) {
    condition = "";
  }

  let isTest = false;
  if (
    Object.prototype.hasOwnProperty.call(payload, "is_test") &&
    payload.is_test !== undefined &&
    payload.is_test !== null &&
    payload.is_test !== ""
  ) {
    if (typeof payload.is_test !== "boolean") {
      return importContractRejected(
        "INVALID_IS_TEST",
        "is_test must be a boolean",
        attemptId
      );
    }
    isTest = payload.is_test;
  }

  const normalizedFields = {
    category,
    brand: asTrimmedString(payload.brand),
    product_name: asRawString(payload.product_name ?? "").trim(),
    condition,
    purchase_price: purchasePrice,
    planned_sale_price: plannedSalePrice,
    storage_location: asTrimmedString(payload.storage_location),
    description: asRawString(payload.description ?? ""),
    notes: asRawString(payload.notes ?? ""),

    sneaker_sku: isSneaker ? asTrimmedString(payload.sneaker_sku) : "",
    sneaker_size: isSneaker ? asTrimmedString(payload.sneaker_size) : "",
    sneaker_colorway: isSneaker ? asTrimmedString(payload.sneaker_colorway) : "",
    sneaker_box: isSneaker ? asTrimmedString(payload.sneaker_box) : "",
    sneaker_accessories: isSneaker
      ? asTrimmedString(payload.sneaker_accessories)
      : "",
    sneaker_release_year: isSneaker
      ? asTrimmedString(payload.sneaker_release_year)
      : "",

    jewelry_type: isJewelry ? asTrimmedString(payload.jewelry_type) : "",
    jewelry_material: isJewelry ? asTrimmedString(payload.jewelry_material) : "",
    carat: isJewelry ? asTrimmedString(payload.carat) : "",
    shape: isJewelry ? asTrimmedString(payload.shape) : "",
    color_grade: isJewelry ? asTrimmedString(payload.color_grade) : "",
    clarity: isJewelry ? asTrimmedString(payload.clarity) : "",
    cut: isJewelry ? asTrimmedString(payload.cut) : "",
    main_stone: isJewelry ? asTrimmedString(payload.main_stone) : "",
    jewelry_size: isJewelry ? asTrimmedString(payload.jewelry_size) : "",
    weight_g: isJewelry ? asTrimmedString(payload.weight_g) : "",
    certificate_available: isJewelry
      ? asTrimmedString(payload.certificate_available)
      : "",
    certificate_number: isJewelry
      ? asTrimmedString(payload.certificate_number)
      : "",

    subcategory: isApparelOrFashion
      ? asTrimmedString(payload.subcategory ?? payload.sub_category)
      : "",
    size: isApparelOrFashion ? asTrimmedString(payload.size) : "",
    official_sku: isApparelOrFashion
      ? asTrimmedString(payload.official_sku ?? payload.sku)
      : "",
    auction_item_number: validatedAuctionItemNumber,
  };

  const payloadFingerprint = computeImportPayloadFingerprint(
    normalizedImages,
    normalizedFields,
    isPokemonCard ? payload.pokemon_card : null,
    isTest
  );

  // Check authoritative idempotency ledger in Supabase (`product_import_attempts`)
  const { data: foundAttempt, error: attemptLookupErr } = await supabase
    .from("product_import_attempts")
    .select(
      "attempt_id, status, payload_fingerprint, product_id, drive_folder_id, drive_folder_url, main_image_url, image_count, mirror_json, response_json"
    )
    .eq("attempt_id", attemptId)
    .maybeSingle();

  if (attemptLookupErr) {
    throw new Error(
      `Import attempt lookup failed: ${attemptLookupErr.message}`
    );
  }

  let existingAttempt = null;
  let isReused = false;

  if (foundAttempt) {
    if (foundAttempt.payload_fingerprint !== payloadFingerprint) {
      return importContractRejected(
        "IMPORT_IDEMPOTENCY_PAYLOAD_MISMATCH",
        "同一の import_attempt_id に対して異なる画像データまたは商品属性が送信されました。新規商品には新しい import_attempt_id を発行してください。",
        attemptId
      );
    }

    const attemptStatus = asTrimmedString(foundAttempt.status);
    const savedPid = asTrimmedString(
      foundAttempt.response_json?.product_id || foundAttempt.product_id
    );
    if (
      attemptStatus === "completed" &&
      savedPid &&
      foundAttempt.response_json &&
      Object.keys(foundAttempt.response_json).length > 0
    ) {
      const { data: prodCheck, error: prodCheckErr } = await supabase
        .from("products")
        .select("product_id")
        .eq("product_id", savedPid)
        .maybeSingle();
      if (prodCheckErr) {
        throw new Error(
          `Import idempotency product check failed: ${prodCheckErr.message}`
        );
      }
      if (prodCheck) {
        return {
          status: 200,
          body: {
            ...foundAttempt.response_json,
            is_reused: true,
          },
        };
      }
    }

    existingAttempt = foundAttempt;
    isReused = true;
  }

  if (!gasWebAppUrl) {
    throw new ProductWriteError(
      501,
      "DRIVE_STORAGE_BRIDGE_NOT_CONFIGURED",
      "GAS_WEB_APP_URL is required for Google Drive image upload"
    );
  }

  const allocateId = async (minFloor = 0) => {
    const { data: nextId, error: idErr } = await supabase.rpc(
      "allocate_next_product_id",
      { min_floor: minFloor }
    );
    if (idErr || !nextId) {
      throw new Error(
        `Failed allocating product_id in Supabase: ${
          idErr?.message || "empty result"
        }`
      );
    }
    return asTrimmedString(nextId);
  };

  let productId = asTrimmedString(existingAttempt?.product_id);
  if (!productId) {
    productId = await allocateId(0);
    if (existingAttempt) {
      const { error: updIdErr } = await supabase
        .from("product_import_attempts")
        .update({
          product_id: productId,
          updated_at: new Date().toISOString(),
        })
        .eq("attempt_id", attemptId);
      if (updIdErr) {
        throw new Error(
          `Failed saving reserved product_id on import attempt: ${updIdErr.message}`
        );
      }
    } else {
      const { error: insErr } = await supabase
        .from("product_import_attempts")
        .insert({
          attempt_id: attemptId,
          status: "initiated",
          payload_fingerprint: payloadFingerprint,
          product_id: productId,
          mirror_json: null,
          response_json: {},
        });
      if (insErr) {
        if (String(insErr.code || "") === "23505") {
          const { data: raced, error: raceErr } = await supabase
            .from("product_import_attempts")
            .select(
              "attempt_id, status, payload_fingerprint, product_id, drive_folder_id, drive_folder_url, main_image_url, image_count, mirror_json, response_json"
            )
            .eq("attempt_id", attemptId)
            .maybeSingle();
          if (raceErr || !raced) {
            throw new Error(
              `Concurrent import attempt lookup failed: ${
                raceErr?.message || insErr.message
              }`
            );
          }
          if (raced.payload_fingerprint !== payloadFingerprint) {
            return importContractRejected(
              "IMPORT_IDEMPOTENCY_PAYLOAD_MISMATCH",
              "同一の import_attempt_id に対して異なる画像データまたは商品属性が送信されました。新規商品には新しい import_attempt_id を発行してください。",
              attemptId
            );
          }
          if (
            asTrimmedString(raced.status) === "completed" &&
            raced.response_json?.product_id
          ) {
            return {
              status: 200,
              body: {
                ...raced.response_json,
                is_reused: true,
              },
            };
          }
          existingAttempt = raced;
          isReused = true;
          productId = asTrimmedString(raced.product_id) || productId;
        } else {
          throw new Error(
            `Failed recording import attempt reservation: ${insErr.message}`
          );
        }
      }
    }
  }

  const callGasImportBridge = async (reservedId) => {
    const bridgeBody = {
      action: "import_product_by_images",
      import_attempt_id: attemptId,
      reserved_product_id: reservedId,
      ...normalizedFields,
      publish_status: "draft",
      ...(isPokemonCard ? { pokemon_card: payload.pokemon_card } : {}),
      images: normalizedImages.map((img) => ({
        file_name: img.file_name,
        mime_type: img.mime_type,
        base64: img.base64,
      })),
    };
    const res = await fetchImpl(gasWebAppUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(bridgeBody),
    });
    if (!res.ok) {
      throw new Error(
        `Google Drive / Sheets import bridge returned HTTP ${res.status}`
      );
    }
    return res.json();
  };

  let mirrorJson = null;
  if (
    existingAttempt &&
    asTrimmedString(existingAttempt.status) === "drive_saved" &&
    existingAttempt.mirror_json &&
    existingAttempt.mirror_json.success === true
  ) {
    mirrorJson = existingAttempt.mirror_json;
  } else {
    mirrorJson = await callGasImportBridge(productId);
    if (
      mirrorJson &&
      mirrorJson.success === false &&
      mirrorJson.error_code === "PRODUCT_ID_ALREADY_IN_SHEETS"
    ) {
      const floor = Number(mirrorJson.max_sheet_sequence) || 0;
      const reallocatedId = await allocateId(floor);
      const { error: updReallocErr } = await supabase
        .from("product_import_attempts")
        .update({
          product_id: reallocatedId,
          updated_at: new Date().toISOString(),
        })
        .eq("attempt_id", attemptId);
      if (updReallocErr) {
        throw new Error(
          `Failed updating reallocated product_id on import attempt: ${updReallocErr.message}`
        );
      }
      productId = reallocatedId;
      mirrorJson = await callGasImportBridge(productId);
    }

    if (mirrorJson && mirrorJson.success === false) {
      try {
        await supabase
          .from("product_import_attempts")
          .update({
            status: "failed",
            error_message:
              asTrimmedString(mirrorJson.message || mirrorJson.error) ||
              "GAS import bridge returned success=false",
            updated_at: new Date().toISOString(),
          })
          .eq("attempt_id", attemptId);
      } catch {
        // Non-fatal
      }
      return {
        status: 200,
        body: {
          ...mirrorJson,
          import_attempt_id: attemptId,
        },
      };
    }

    if (!mirrorJson || mirrorJson.success !== true) {
      throw new Error("Invalid response from Google Drive / Sheets import bridge");
    }

    productId = asTrimmedString(mirrorJson.product_id) || productId;

    try {
      await supabase
        .from("product_import_attempts")
        .update({
          product_id: productId,
          status: "drive_saved",
          drive_folder_id: asTrimmedString(mirrorJson.drive_folder_id),
          drive_folder_url: asTrimmedString(mirrorJson.drive_folder_url),
          main_image_url: asTrimmedString(mirrorJson.main_image_url),
          image_count: Number(mirrorJson.image_count) || normalizedImages.length,
          mirror_json: mirrorJson,
          error_message: "",
          updated_at: new Date().toISOString(),
        })
        .eq("attempt_id", attemptId);
    } catch {
      // Best-effort checkpoint; GAS `import_attempts` + `product_import_attempts.product_id` still recover cleanly.
    }
  }

  productId = asTrimmedString(mirrorJson.product_id) || productId;

  // Allocate or reuse `row_seq`
  const { data: existingProductRow, error: existingProdRowErr } = await supabase
    .from("products")
    .select("product_id, row_seq")
    .eq("product_id", productId)
    .maybeSingle();
  if (existingProdRowErr) {
    throw new Error(
      `Failed checking existing product row before import save: ${existingProdRowErr.message}`
    );
  }

  let allocatedRowSeq = Number(existingProductRow?.row_seq) || 0;
  if (!(Number.isInteger(allocatedRowSeq) && allocatedRowSeq > 0)) {
    const { data: nextRowSeq, error: rowSeqErr } = await supabase.rpc(
      "allocate_next_product_row_seq"
    );
    if (rowSeqErr) {
      throw new Error(`Failed allocating row_seq: ${rowSeqErr.message}`);
    }
    allocatedRowSeq = Number(nextRowSeq) || 0;
  }

  const nowIso = new Date().toISOString();
  const createdAtIso = asTrimmedString(mirrorJson.created_at) || nowIso;
  const driveFolderUrl = asTrimmedString(mirrorJson.drive_folder_url);
  let rawDriveImages = Array.isArray(mirrorJson.images) ? mirrorJson.images : [];

  // Fallback if an older GAS deployment omitted `images[]` on `product-import-v1`
  if (rawDriveImages.length === 0 && gasWebAppUrl) {
    try {
      const detailRes = await fetchImpl(
        `${gasWebAppUrl}?mode=admin&product_id=${encodeURIComponent(productId)}`,
        { method: "GET" }
      );
      if (detailRes.ok) {
        const detailJson = await detailRes.json();
        if (Array.isArray(detailJson?.product?.images)) {
          rawDriveImages = detailJson.product.images;
        }
      }
    } catch {
      // Best-effort fallback
    }
  }

  const imageRows = rawDriveImages
    .filter((img) => img && asTrimmedString(img.file_id))
    .map((img, index) => {
      const fid = asTrimmedString(img.file_id);
      return {
        product_id: productId,
        sort_order: index,
        file_id: fid,
        name: asTrimmedString(img.name),
        mime_type: asTrimmedString(img.mime_type) || "image/jpeg",
        view_url: asTrimmedString(img.view_url),
        display_url:
          asTrimmedString(img.display_url) ||
          `https://drive.google.com/thumbnail?id=${fid}&sz=w1600`,
      };
    });

  const mainImageUrl =
    asTrimmedString(mirrorJson.main_image_url) ||
    (imageRows.length > 0 ? imageRows[0].view_url : "");
  const mainImageDisplayUrl = convertDriveFileUrlToDisplayUrl(
    mainImageUrl,
    "w800"
  );

  const pokemonCardRow = isPokemonCard
    ? validateAndMergePokemonCard(productId, payload.pokemon_card, null)
    : null;

  const productRow = {
    product_id: productId,
    ...(Number.isInteger(Number(allocatedRowSeq)) && Number(allocatedRowSeq) > 0
      ? { row_seq: Number(allocatedRowSeq) }
      : {}),
    created_at: createdAtIso,
    created_at_raw: createdAtIso,
    ...normalizedFields,
    drive_folder_url: driveFolderUrl,
    main_image_url: mainImageUrl,
    main_image_display_url: mainImageDisplayUrl,
    selected_image_ids: [],
    publish_status: "draft",
    inventory_status: "in_stock",
    record_status: "active",
    is_test: isTest,
    square_item_id: "",
    square_variation_id: "",
    square_payment_link_id: "",
    square_checkout_url: "",
    square_payment_link_generation: null,
    ai_draft_flag: "",
    write_source: "supabase",
    supabase_written_at: nowIso,
    sheets_mirror_pending: false,
    synced_from_sheets_at: nowIso,
  };

  await upsertProductBundle(supabase, {
    productRow,
    imageRows,
    translationRow: null,
    pokemonCardRow,
    documentRow: null,
  });

  const finalImageCount =
    imageRows.length > 0
      ? imageRows.length
      : Number(mirrorJson.image_count) || normalizedImages.length;

  const baseResponse = {
    success: true,
    version: "product-import-v1",
    write_master: "supabase",
    import_attempt_id: attemptId,
    product_id: productId,
    is_reused: false,
    status: "completed",
    publish_status: "draft",
    inventory_status: "in_stock",
    record_status: "active",
    is_test: isTest,
    drive_folder_url: driveFolderUrl,
    main_image_url: mainImageUrl,
    main_image_display_url: mainImageDisplayUrl,
    image_count: finalImageCount,
    images: imageRows.map(
      ({ file_id, name, mime_type, view_url, display_url }) => ({
        file_id,
        name,
        mime_type,
        view_url,
        display_url,
      })
    ),
    auction_item_number: validatedAuctionItemNumber,
    created_at: createdAtIso,
  };

  try {
    await supabase.from("product_import_attempts").upsert(
      {
        attempt_id: attemptId,
        status: "completed",
        payload_fingerprint: payloadFingerprint,
        product_id: productId,
        drive_folder_id: asTrimmedString(mirrorJson.drive_folder_id),
        drive_folder_url: driveFolderUrl,
        main_image_url: mainImageUrl,
        image_count: finalImageCount,
        mirror_json: mirrorJson,
        response_json: baseResponse,
        error_message: "",
        updated_at: nowIso,
      },
      { onConflict: "attempt_id" }
    );
  } catch {
    // Non-fatal; `drive_saved` + existing `products` row still guarantees idempotent reuse.
  }

  return {
    status: 200,
    body: {
      ...baseResponse,
      is_reused: Boolean(isReused || mirrorJson.is_reused === true),
    },
  };
}

/**
 * Phase 2 Unit 2: Product Image Add / Reorder / Delete via Cloud Run + Supabase
 * (`POST /products/:productId/images`).
 * - Pre-validates `image_order` / `keep_image_ids` (0..20 images), `new_images` base64 & mime,
 *   and optional `selected_image_ids` (`v100` contract: preserved untouched when omitted).
 * - Uses GAS (`update_product_images`) strictly for Google Drive file operations
 *   (`ROOT_FOLDER_ID/<product_id>/`, `01_main_...` / `02_...` renaming, trashing removed files)
 *   + downstream `シート1` `AE` (`main_image_url`) & AI `confirmed_fingerprint` invalidation.
 * - Atomically updates `public.products` + `public.product_images` (`sort_order = 0..N-1`)
 *   via `public.replace_product_images_atomic`.
 */
export async function updateProductImages({
  supabase,
  fetchImpl = globalThis.fetch,
  gasWebAppUrl,
  productId,
  payload = {},
}) {
  const normId = asTrimmedString(productId || payload?.product_id);
  if (!normId) {
    throw new ProductWriteError(
      400,
      "PRODUCT_ID_REQUIRED",
      "product_id is required"
    );
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ProductWriteError(
      400,
      "INVALID_PAYLOAD",
      "JSON object body is required"
    );
  }

  let { data: current, error: fetchErr } = await supabase
    .from("products")
    .select(EXISTING_DETAIL_FOR_UPDATE_SELECT)
    .eq("product_id", normId)
    .maybeSingle();

  if (fetchErr) {
    throw new Error(`Supabase product lookup failed: ${fetchErr.message}`);
  }

  // Lazy backfill if a legacy Sheets product hasn't been synced yet
  if (!current && gasWebAppUrl) {
    const detailUrl = `${gasWebAppUrl}?mode=admin&product_id=${encodeURIComponent(
      normId
    )}`;
    const gasDetailRes = await fetchImpl(detailUrl, { method: "GET" });
    if (gasDetailRes.ok) {
      const gasDetailJson = await gasDetailRes.json();
      if (gasDetailJson?.success === true && gasDetailJson.product) {
        const bundle = mapGasProductToSupabaseBundle({
          summary: gasDetailJson.product,
          detail: gasDetailJson.product,
        });
        await upsertProductBundle(supabase, bundle);
        const reloaded = await supabase
          .from("products")
          .select(EXISTING_DETAIL_FOR_UPDATE_SELECT)
          .eq("product_id", normId)
          .maybeSingle();
        current = reloaded.data || null;
      }
    }
  }

  if (!current) {
    throw new ProductWriteError(
      404,
      "PRODUCT_NOT_FOUND",
      `Product not found: ${normId}`
    );
  }

  if (current.sheets_mirror_pending === true && gasWebAppUrl) {
    await flushPendingSupabaseDraftToSheets({
      supabase,
      fetchImpl,
      gasWebAppUrl,
      productId: normId,
    });
  }

  // 1. Pre-validate `new_images` and `image_order` / `keep_image_ids`
  const rawNewImages = Array.isArray(payload.new_images)
    ? payload.new_images
    : [];
  const rawNewImageMap = new Map();
  const normalizedNewImagesList = rawNewImages.map((img, index) => {
    if (!img || typeof img !== "object" || Array.isArray(img)) {
      throw new ProductWriteError(
        400,
        "INVALID_NEW_IMAGE",
        `new_images[${index}] must be an object`
      );
    }
    const clientId =
      asTrimmedString(img.client_id) || `legacy-new-${index}`;
    const entry = {
      ...img,
      client_id: clientId,
    };
    rawNewImageMap.set(clientId, entry);
    return entry;
  });

  let imageOrder = [];
  if (Array.isArray(payload.image_order)) {
    imageOrder = payload.image_order.map((item) => ({
      source: asTrimmedString(item?.source),
      id: asTrimmedString(item?.id),
    }));
  } else {
    const keepImageIds = Array.isArray(payload.keep_image_ids)
      ? payload.keep_image_ids.map((id) => asTrimmedString(id)).filter(Boolean)
      : [];
    imageOrder = [
      ...keepImageIds.map((fid) => ({ source: "existing", id: fid })),
      ...normalizedNewImagesList.map((img) => ({
        source: "new",
        id: img.client_id,
      })),
    ];
  }

  if (imageOrder.length > MAX_IMAGES_PER_PRODUCT) {
    throw new ProductWriteError(
      400,
      "MAX_IMAGE_COUNT_EXCEEDED",
      "maximum image count is 20"
    );
  }

  const existingDbFileIds = new Set(
    (Array.isArray(current.product_images) ? current.product_images : [])
      .map((img) => asTrimmedString(img.file_id))
      .filter(Boolean)
  );

  const seenOrderKeys = new Set();
  const validatedNewImagesForBridge = [];
  const validatedNewIdsSet = new Set();

  for (const item of imageOrder) {
    if (item.source !== "existing" && item.source !== "new") {
      throw new ProductWriteError(
        400,
        "INVALID_IMAGE_SOURCE",
        "invalid image source"
      );
    }
    if (!item.id) {
      throw new ProductWriteError(
        400,
        "INVALID_IMAGE_ORDER_ID",
        "image_order item id is required"
      );
    }
    const orderKey = `${item.source}:${item.id}`;
    if (seenOrderKeys.has(orderKey)) {
      throw new ProductWriteError(
        400,
        "DUPLICATE_IMAGE_ORDER",
        "duplicate image in image_order"
      );
    }
    seenOrderKeys.add(orderKey);

    if (item.source === "new") {
      const rawNew = rawNewImageMap.get(item.id);
      if (!rawNew) {
        throw new ProductWriteError(
          400,
          "NEW_IMAGE_NOT_FOUND",
          `new image not found: ${item.id}`
        );
      }
      if (!validatedNewIdsSet.has(item.id)) {
        const parsed = extractRawBase64AndMime(rawNew.base64, rawNew.mime_type);
        validatedNewImagesForBridge.push({
          client_id: item.id,
          file_name:
            asTrimmedString(rawNew.file_name || rawNew.name) || "image.jpg",
          mime_type: parsed.mime_type,
          base64: parsed.base64,
        });
        validatedNewIdsSet.add(item.id);
      }
    }
  }

  // Pre-validate optional `selected_image_ids` / `ai_selected_image_ids` (`v100` contract)
  const hasSelectedImageIdsPayload =
    (Object.prototype.hasOwnProperty.call(payload, "selected_image_ids") &&
      payload.selected_image_ids !== undefined) ||
    (Object.prototype.hasOwnProperty.call(payload, "ai_selected_image_ids") &&
      payload.ai_selected_image_ids !== undefined);

  let preValidatedSelectedIds = [];
  if (hasSelectedImageIdsPayload) {
    const rawSel =
      payload.selected_image_ids !== undefined
        ? payload.selected_image_ids
        : payload.ai_selected_image_ids;
    const syntaxChecked = validateSelectedImageIds(rawSel, null, normId);
    const activeOrderIds = new Set(imageOrder.map((it) => it.id));
    for (const sId of syntaxChecked) {
      if (!activeOrderIds.has(sId)) {
        if (existingDbFileIds.has(sId)) {
          throw new ProductWriteError(
            400,
            "SELECTED_IMAGE_DELETED",
            `Selected image ID '${sId}' for product ${normId} was deleted in this image update and cannot be selected.`
          );
        }
        throw new ProductWriteError(
          400,
          "INVALID_IMAGE_SELECTION",
          `Selected image ID '${sId}' does not belong to product ${normId} drive folder.`
        );
      }
    }
    preValidatedSelectedIds = syntaxChecked;
  }

  if (!gasWebAppUrl) {
    throw new ProductWriteError(
      501,
      "DRIVE_STORAGE_BRIDGE_NOT_CONFIGURED",
      "GAS_WEB_APP_URL is required for Google Drive image update"
    );
  }

  // 2. Execute physical Google Drive operations + downstream Sheets AE / AI confirmation update via GAS bridge
  const gasBridgeBody = {
    action: "update_product_images",
    product_id: normId,
    image_order: imageOrder,
    new_images: validatedNewImagesForBridge,
    ...(hasSelectedImageIdsPayload
      ? { selected_image_ids: preValidatedSelectedIds }
      : {}),
  };

  const gasRes = await fetchImpl(gasWebAppUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(gasBridgeBody),
  });
  if (!gasRes.ok) {
    throw new Error(
      `Google Drive image bridge returned HTTP ${gasRes.status}`
    );
  }
  const gasJson = await gasRes.json();
  if (!gasJson || gasJson.success !== true) {
    const errMsg =
      asTrimmedString(gasJson?.message || gasJson?.error) ||
      "Failed updating product images in Google Drive";
    const errCode = asTrimmedString(gasJson?.error_code);
    if (
      errCode ||
      errMsg.includes("existing image not found") ||
      errMsg.includes("new image not found") ||
      errMsg.includes("maximum image count") ||
      errMsg.includes("invalid image source") ||
      errMsg.includes("duplicate image")
    ) {
      throw new ProductWriteError(
        400,
        errCode || "IMAGE_UPDATE_REJECTED",
        errMsg
      );
    }
    throw new Error(`Google Drive image update failed: ${errMsg}`);
  }

  // 3. Atomically update `products` + `product_images` in Supabase
  const rawGasImages = Array.isArray(gasJson.images) ? gasJson.images : [];
  const orderedImages = rawGasImages
    .filter((img) => img && asTrimmedString(img.file_id))
    .map((img, index) => {
      const fid = asTrimmedString(img.file_id);
      return {
        sort_order: index,
        file_id: fid,
        name: asTrimmedString(img.name),
        mime_type: asTrimmedString(img.mime_type) || "image/jpeg",
        view_url: asTrimmedString(img.view_url),
        display_url:
          asTrimmedString(img.display_url) ||
          `https://drive.google.com/thumbnail?id=${fid}&sz=w1600`,
      };
    });

  const mainImageUrl =
    orderedImages.length > 0
      ? orderedImages[0].view_url
      : asTrimmedString(gasJson.main_image_url);
  const mainImageDisplayUrl = convertDriveFileUrlToDisplayUrl(
    mainImageUrl,
    "w800"
  );

  const existingSelectedIds = normalizeStringArray(current.selected_image_ids);
  const resolvedSelectedIds = hasSelectedImageIdsPayload
    ? normalizeStringArray(
        gasJson.selected_image_ids ??
          gasJson.ai_selected_image_ids ??
          preValidatedSelectedIds
      )
    : existingSelectedIds;

  const { error: rpcErr } = await supabase.rpc(
    "replace_product_images_atomic",
    {
      p_product_id: normId,
      p_main_image_url: mainImageUrl,
      p_main_image_display_url: mainImageDisplayUrl,
      p_images: orderedImages,
      p_update_selected_ids: hasSelectedImageIdsPayload,
      p_selected_image_ids: resolvedSelectedIds,
    }
  );
  if (rpcErr) {
    throw new Error(
      `Supabase replace_product_images_atomic failed for ${normId}: ${rpcErr.message}`
    );
  }

  // Match GAS `handleUpdateProductImages` behavior: invalidate any `confirmed` AI draft to `stale` when images change
  try {
    await supabase
      .from("product_ai_drafts")
      .update({
        review_status: "stale",
        updated_at: new Date().toISOString(),
      })
      .eq("product_id", normId)
      .eq("review_status", "confirmed");
  } catch {
    // Non-fatal if `product_ai_drafts` mock is absent in legacy unit tests
  }

  const responseImages = orderedImages.map(
    ({ file_id, name, mime_type, view_url, display_url }) => ({
      file_id,
      name,
      mime_type,
      view_url,
      display_url,
    })
  );

  return {
    status: 200,
    body: {
      success: true,
      version: "product-images-update-v2",
      write_master: "supabase",
      product_id: normId,
      image_count: responseImages.length,
      main_image_url: mainImageUrl,
      main_image_display_url: mainImageDisplayUrl,
      images: responseImages,
      selected_image_ids: resolvedSelectedIds,
      ai_selected_image_ids: resolvedSelectedIds,
    },
  };
}

