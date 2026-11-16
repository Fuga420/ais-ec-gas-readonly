/**
 * Mapping & formatting layer between Google Sheets (GAS responses),
 * Supabase tables, and B.I.S EC frontend/public API contracts.
 */

export function asTrimmedString(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

export function asRawString(value) {
  if (value === null || value === undefined) return "";
  return String(value);
}

export function toNullableNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  const cleaned = String(value).replace(/,/g, "").trim();
  if (!cleaned) return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

export function toJsonNumber(value, fallback = 0) {
  const num = toNullableNumber(value);
  return num === null ? fallback : num;
}

export function convertDriveFileUrlToDisplayUrl(url, size = "w800") {
  if (!url) return "";
  const match = String(url).match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (!match) return "";
  return `https://drive.google.com/thumbnail?id=${match[1]}&sz=${size}`;
}

export function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const item of value) {
    const s = asTrimmedString(item);
    if (s && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

/**
 * Maps a GAS product summary + detail payload into normalized Supabase table rows.
 */
export function mapGasProductToSupabaseBundle({ summary = {}, detail = {}, rowSeq }) {
  const productId = asTrimmedString(detail.product_id || summary.product_id);
  if (!productId) {
    throw new Error("product_id is required to map product bundle");
  }

  const rawCreatedAt = asTrimmedString(detail.created_at ?? summary.created_at);
  let parsedCreatedAt = null;
  if (rawCreatedAt) {
    const t = new Date(rawCreatedAt).getTime();
    if (!Number.isNaN(t)) {
      parsedCreatedAt = new Date(t).toISOString();
    }
  }

  const mainImageUrl = asTrimmedString(detail.main_image_url ?? summary.main_image_url);
  const mainImageDisplayUrl =
    asTrimmedString(summary.main_image_display_url) ||
    convertDriveFileUrlToDisplayUrl(mainImageUrl, "w800");

  const translation = detail.translation && typeof detail.translation === "object"
    ? detail.translation
    : null;

  const translatedTitle = asTrimmedString(
    summary.translated_title || (translation && translation.translated_title) || ""
  );

  const selectedImageIds = normalizeStringArray(
    detail.selected_image_ids ??
      detail.ai_selected_image_ids ??
      summary.selected_image_ids ??
      summary.ai_selected_image_ids ??
      []
  );

  const subcategory = asTrimmedString(
    detail.subcategory ?? detail.sub_category ?? summary.subcategory ?? summary.sub_category
  );
  const size = asTrimmedString(detail.size ?? summary.size);
  const officialSku = asTrimmedString(
    detail.official_sku ?? detail.sku ?? summary.official_sku ?? summary.sku
  );
  const auctionItemNumber = asTrimmedString(
    detail.auction_item_number ?? summary.auction_item_number
  );

  const productRow = {
    product_id: productId,
    ...(Number.isInteger(rowSeq) && rowSeq > 0 ? { row_seq: rowSeq } : {}),
    created_at: parsedCreatedAt,
    created_at_raw: parsedCreatedAt || rawCreatedAt,
    category: asTrimmedString(detail.category ?? summary.category),
    brand: asTrimmedString(detail.brand ?? summary.brand),
    product_name: asRawString(detail.product_name ?? summary.product_name).trim(),
    translated_title: translatedTitle,
    condition: asTrimmedString(detail.condition ?? summary.condition),
    purchase_price: toNullableNumber(detail.purchase_price ?? summary.purchase_price) ?? 0,
    planned_sale_price: toNullableNumber(detail.planned_sale_price ?? summary.planned_sale_price) ?? 0,
    storage_location: asTrimmedString(detail.storage_location ?? summary.storage_location),
    description: asRawString(detail.description ?? ""),
    notes: asRawString(detail.notes ?? ""),

    sneaker_sku: asTrimmedString(detail.sneaker_sku ?? summary.sneaker_sku),
    sneaker_size: asTrimmedString(detail.sneaker_size ?? summary.sneaker_size),
    sneaker_colorway: asTrimmedString(detail.sneaker_colorway),
    sneaker_box: asTrimmedString(detail.sneaker_box),
    sneaker_accessories: asTrimmedString(detail.sneaker_accessories),
    sneaker_release_year: asTrimmedString(detail.sneaker_release_year),

    jewelry_type: asTrimmedString(detail.jewelry_type),
    jewelry_material: asTrimmedString(detail.jewelry_material),
    carat: asTrimmedString(detail.carat),
    shape: asTrimmedString(detail.shape),
    color_grade: asTrimmedString(detail.color_grade),
    clarity: asTrimmedString(detail.clarity),
    cut: asTrimmedString(detail.cut),
    main_stone: asTrimmedString(detail.main_stone),
    jewelry_size: asTrimmedString(detail.jewelry_size),
    weight_g: asTrimmedString(detail.weight_g),
    certificate_available: asTrimmedString(detail.certificate_available),
    certificate_number: asTrimmedString(detail.certificate_number),

    subcategory,
    size,
    official_sku: officialSku,
    auction_item_number: auctionItemNumber,

    drive_folder_url: asTrimmedString(detail.drive_folder_url ?? summary.drive_folder_url),
    main_image_url: mainImageUrl,
    main_image_display_url: mainImageDisplayUrl,
    selected_image_ids: selectedImageIds,

    publish_status: asTrimmedString(detail.publish_status ?? summary.publish_status) || "draft",
    inventory_status: asTrimmedString(detail.inventory_status ?? summary.inventory_status) || "in_stock",
    record_status: asTrimmedString(detail.record_status ?? summary.record_status) || "active",

    square_item_id: asTrimmedString(detail.square_item_id ?? summary.square_item_id),
    square_variation_id: asTrimmedString(detail.square_variation_id ?? summary.square_variation_id),
    square_payment_link_id: asTrimmedString(
      detail.square_payment_link_id ?? summary.square_payment_link_id
    ),
    square_checkout_url: asTrimmedString(detail.square_checkout_url ?? summary.square_checkout_url),
    square_payment_link_generation:
      detail.square_payment_link_generation != null && detail.square_payment_link_generation !== ""
        ? Number(detail.square_payment_link_generation)
        : null,
    ...(detail.ai_draft_flag !== undefined || summary.ai_draft_flag !== undefined
      ? {
          ai_draft_flag: asTrimmedString(
            detail.ai_draft_flag ?? summary.ai_draft_flag
          ),
        }
      : {}),
    ...(typeof (detail.is_test ?? summary.is_test) === "boolean"
      ? {
          is_test: Boolean(detail.is_test ?? summary.is_test),
        }
      : {}),
    write_source: "sheets",
    sheets_mirror_pending: false,
    synced_from_sheets_at: new Date().toISOString(),
  };

  const rawImages = Array.isArray(detail.images) ? detail.images : [];
  const imageRows = [];
  const seenFileIds = new Set();
  rawImages.forEach((img, index) => {
    if (!img || typeof img !== "object") return;
    const fileId = asTrimmedString(img.file_id);
    if (!fileId || seenFileIds.has(fileId)) return;
    seenFileIds.add(fileId);
    imageRows.push({
      product_id: productId,
      sort_order: index,
      file_id: fileId,
      name: asTrimmedString(img.name),
      mime_type: asTrimmedString(img.mime_type) || "image/jpeg",
      view_url: asTrimmedString(img.view_url),
      display_url:
        asTrimmedString(img.display_url) ||
        `https://drive.google.com/thumbnail?id=${fileId}&sz=w1600`,
    });
  });

  let translationRow = null;
  if (translation && (translation.translated_title || translation.translated_description)) {
    translationRow = {
      product_id: productId,
      locale: asTrimmedString(translation.locale) || "en",
      translated_title: asTrimmedString(translation.translated_title),
      translated_description: asRawString(translation.translated_description ?? ""),
      translated_condition: asTrimmedString(translation.translated_condition),
      translated_box: asTrimmedString(translation.translated_box),
      translated_accessories: asTrimmedString(translation.translated_accessories),
      translation_status: asTrimmedString(translation.translation_status),
      generated_at: asTrimmedString(translation.generated_at),
    };
  } else if (translatedTitle) {
    translationRow = {
      product_id: productId,
      locale: "en",
      translated_title: translatedTitle,
      translated_description: "",
      translated_condition: "",
      translated_box: "",
      translated_accessories: "",
      translation_status: "draft",
      generated_at: "",
    };
  }

  let pokemonCardRow = null;
  if (detail.pokemon_card && typeof detail.pokemon_card === "object") {
    const p = detail.pokemon_card;
    pokemonCardRow = {
      product_id: productId,
      card_name: asTrimmedString(p.card_name),
      set_name: asTrimmedString(p.set_name),
      card_number: asTrimmedString(p.card_number),
      rarity: asTrimmedString(p.rarity),
      language: asTrimmedString(p.language),
      grading_status: asTrimmedString(p.grading_status) || "ungraded",
      grader: asTrimmedString(p.grader),
      grade: asTrimmedString(p.grade),
      certification_number: asTrimmedString(p.certification_number),
      card_condition: asTrimmedString(p.card_condition || detail.card_condition),
      source_created_at: asTrimmedString(p.created_at),
      source_updated_at: asTrimmedString(p.updated_at),
    };
  }

  let documentRow = null;
  if (detail.document && typeof detail.document === "object") {
    const d = detail.document;
    const origName = asTrimmedString(d.original_file_name || d.file_name);
    const viewUrl = asTrimmedString(d.view_url || d.open_url || d.display_url);
    if (d.file_id || origName || viewUrl) {
      documentRow = {
        product_id: productId,
        file_id: asTrimmedString(d.file_id),
        document_type: asTrimmedString(d.document_type),
        original_file_name: origName,
        mime_type: asTrimmedString(d.mime_type),
        file_size: toNullableNumber(d.file_size ?? d.size),
        source_created_at: asTrimmedString(d.created_at || d.attached_at),
        view_url: viewUrl,
        open_url: asTrimmedString(d.open_url || viewUrl),
      };
    }
  }

  return {
    productRow,
    imageRows,
    translationRow,
    pokemonCardRow,
    documentRow,
  };
}

/**
 * Formats a Supabase `products` row into `AdminProduct` summary (admin-product-list-v2 / v3).
 */
export function buildAdminProductSummaryFromRow(row) {
  const mainImageUrl = row.main_image_url || "";
  const mainImageDisplayUrl =
    row.main_image_display_url || convertDriveFileUrlToDisplayUrl(mainImageUrl, "w800");
  const selectedIds = Array.isArray(row.selected_image_ids) ? row.selected_image_ids : [];
  const subcat = asTrimmedString(row.subcategory);
  const officialSku = asTrimmedString(row.official_sku);

  return {
    created_at: row.created_at || row.created_at_raw || "",
    product_id: row.product_id || "",
    category: row.category || "",
    brand: row.brand || "",
    product_name: row.product_name || "",
    translated_title: row.translated_title || "",
    condition: row.condition || "",
    purchase_price: toJsonNumber(row.purchase_price, 0),
    planned_sale_price: toJsonNumber(row.planned_sale_price, 0),
    storage_location: row.storage_location || "",
    subcategory: subcat,
    sub_category: subcat,
    size: asTrimmedString(row.size),
    official_sku: officialSku,
    sku: officialSku,
    auction_item_number: row.auction_item_number || "",
    sneaker_sku: row.sneaker_sku || "",
    sneaker_size: row.sneaker_size || "",
    drive_folder_url: row.drive_folder_url || "",
    inventory_status: asTrimmedString(row.inventory_status) || "in_stock",
    main_image_url: mainImageUrl,
    main_image_display_url: mainImageDisplayUrl,
    publish_status: asTrimmedString(row.publish_status) || "draft",
    record_status: asTrimmedString(row.record_status) || "active",
    square_item_id: row.square_item_id || "",
    square_variation_id: row.square_variation_id || "",
    square_payment_link_id: row.square_payment_link_id || "",
    square_checkout_url: row.square_checkout_url || "",
    selected_image_ids: selectedIds,
    ai_selected_image_ids: selectedIds,
    is_test: Boolean(row.is_test),
  };
}

/**
 * Formats a Supabase `products` row into public category summary (product-list-v4).
 * Never exposes purchase_price, storage_location, notes, auction_item_number, or Square IDs.
 */
export function buildPublicProductSummaryFromRow(row) {
  const mainImageUrl = row.main_image_url || "";
  const subcat = asTrimmedString(row.subcategory);
  const officialSku = asTrimmedString(row.official_sku);

  return {
    product_id: row.product_id || "",
    category: row.category || "",
    brand: row.brand || "",
    product_name: row.product_name || "",
    condition: row.condition || "",
    planned_sale_price: toJsonNumber(row.planned_sale_price, 0),
    description: row.description || "",
    sneaker_sku: row.sneaker_sku || "",
    sneaker_size: row.sneaker_size || "",
    sneaker_colorway: row.sneaker_colorway || "",
    subcategory: subcat,
    sub_category: subcat,
    size: asTrimmedString(row.size),
    official_sku: officialSku,
    sku: officialSku,
    main_image_url: mainImageUrl,
    main_image_display_url:
      row.main_image_display_url || convertDriveFileUrlToDisplayUrl(mainImageUrl, "w800"),
  };
}

/**
 * Formats a Supabase `products` row + nested relations into Admin/Public Product Detail.
 */
export function buildProductDetailFromRows(row, isAdmin) {
  const rawImages = Array.isArray(row.product_images) ? row.product_images.slice() : [];
  rawImages.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));

  const images = rawImages.map((img) => ({
    file_id: img.file_id || "",
    name: img.name || "",
    mime_type: img.mime_type || "image/jpeg",
    view_url: img.view_url || "",
    display_url:
      img.display_url ||
      (img.file_id ? `https://drive.google.com/thumbnail?id=${img.file_id}&sz=w1600` : ""),
  }));

  const subcat = asTrimmedString(row.subcategory);
  const officialSku = asTrimmedString(row.official_sku);

  const product = {
    created_at: row.created_at || row.created_at_raw || "",
    product_id: row.product_id || "",
    category: row.category || "",
    brand: row.brand || "",
    product_name: row.product_name || "",
    condition: row.condition || "",
    ...(isAdmin
      ? {
          purchase_price: toJsonNumber(row.purchase_price, 0),
          storage_location: row.storage_location || "",
          notes: row.notes || "",
          drive_folder_url: row.drive_folder_url || "",
        }
      : {}),
    planned_sale_price: toJsonNumber(row.planned_sale_price, 0),
    description: row.description || "",

    sneaker_sku: row.sneaker_sku || "",
    sneaker_size: row.sneaker_size || "",
    sneaker_colorway: row.sneaker_colorway || "",
    sneaker_box: row.sneaker_box || "",
    sneaker_accessories: row.sneaker_accessories || "",
    sneaker_release_year: row.sneaker_release_year || "",

    jewelry_type: row.jewelry_type || "",
    jewelry_material: row.jewelry_material || "",
    carat: row.carat || "",
    shape: row.shape || "",
    color_grade: row.color_grade || "",
    clarity: row.clarity || "",
    cut: row.cut || "",
    main_stone: row.main_stone || "",
    jewelry_size: row.jewelry_size || "",
    weight_g: row.weight_g || "",
    certificate_available: row.certificate_available || "",
    certificate_number: row.certificate_number || "",

    subcategory: subcat,
    sub_category: subcat,
    size: asTrimmedString(row.size),
    official_sku: officialSku,
    sku: officialSku,

    main_image_url: row.main_image_url || "",
    publish_status: asTrimmedString(row.publish_status) || "draft",
    inventory_status: asTrimmedString(row.inventory_status) || "in_stock",
    record_status: asTrimmedString(row.record_status) || "active",
    images,
  };

  if (isAdmin) {
    product.square_item_id = row.square_item_id || "";
    product.square_variation_id = row.square_variation_id || "";
    product.square_payment_link_id = row.square_payment_link_id || "";
    product.square_checkout_url = row.square_checkout_url || "";
  } else {
    // Public checkout needs square_checkout_url if present on published item
    product.square_checkout_url = row.square_checkout_url || "";
  }

  // Pokemon card relation
  const pkmRaw = Array.isArray(row.pokemon_cards)
    ? row.pokemon_cards[0]
    : row.pokemon_cards || null;
  if (asTrimmedString(row.category) === "pokemon_card") {
    if (pkmRaw && pkmRaw.product_id) {
      product.pokemon_card = {
        product_id: pkmRaw.product_id,
        card_name: pkmRaw.card_name || "",
        set_name: pkmRaw.set_name || "",
        card_number: pkmRaw.card_number || "",
        rarity: pkmRaw.rarity || "",
        language: pkmRaw.language || "",
        grading_status: pkmRaw.grading_status || "ungraded",
        grader: pkmRaw.grader || "",
        grade: pkmRaw.grade || "",
        certification_number: pkmRaw.certification_number || "",
        card_condition: pkmRaw.card_condition || "",
        created_at: pkmRaw.source_created_at || "",
        updated_at: pkmRaw.source_updated_at || "",
      };
      product.card_condition = pkmRaw.card_condition || "";
    } else {
      product.pokemon_card = null;
      product.card_condition = "";
    }
  }

  // Translation relation (prefer 'en' or first available)
  const transList = Array.isArray(row.product_translations)
    ? row.product_translations
    : row.product_translations
      ? [row.product_translations]
      : [];
  const transRow =
    transList.find((t) => t && t.locale === "en") || transList[0] || null;
  if (transRow && (transRow.translated_title || transRow.translated_description)) {
    product.translation = {
      product_id: row.product_id,
      locale: transRow.locale || "en",
      translated_title: transRow.translated_title || "",
      translated_description: transRow.translated_description || "",
      translated_condition: transRow.translated_condition || "",
      translated_box: transRow.translated_box || "",
      translated_accessories: transRow.translated_accessories || "",
      translation_status: transRow.translation_status || "",
      generated_at: transRow.generated_at || "",
    };
  } else {
    product.translation = null;
  }

  if (isAdmin) {
    const selectedIds = Array.isArray(row.selected_image_ids) ? row.selected_image_ids : [];
    product.selected_image_ids = selectedIds;
    product.ai_selected_image_ids = selectedIds;
    product.auction_item_number = row.auction_item_number || "";
    product.is_test = Boolean(row.is_test);

    const docRaw = Array.isArray(row.product_documents)
      ? row.product_documents[0]
      : row.product_documents || null;
    if (docRaw && (docRaw.file_id || docRaw.original_file_name || docRaw.view_url)) {
      product.document = {
        product_id: row.product_id,
        file_id: docRaw.file_id || "",
        document_type: docRaw.document_type || "",
        original_file_name: docRaw.original_file_name || "",
        file_name: docRaw.original_file_name || "",
        mime_type: docRaw.mime_type || "",
        file_size: docRaw.file_size ?? null,
        size: docRaw.file_size ?? null,
        created_at: docRaw.source_created_at || "",
        attached_at: docRaw.source_created_at || "",
        view_url: docRaw.view_url || "",
        open_url: docRaw.open_url || docRaw.view_url || "",
      };
    } else {
      product.document = null;
    }
  }

  return product;
}

