import {
  asTrimmedString,
  buildAdminProductSummaryFromRow,
  buildProductDetailFromRows,
  buildPublicProductSummaryFromRow,
} from "./productMapper.mjs";

const ADMIN_SUMMARY_COLUMNS = [
  "row_seq",
  "created_at",
  "created_at_raw",
  "product_id",
  "category",
  "brand",
  "product_name",
  "translated_title",
  "condition",
  "purchase_price",
  "planned_sale_price",
  "storage_location",
  "subcategory",
  "size",
  "official_sku",
  "auction_item_number",
  "sneaker_sku",
  "sneaker_size",
  "drive_folder_url",
  "inventory_status",
  "main_image_url",
  "main_image_display_url",
  "publish_status",
  "record_status",
  "square_item_id",
  "square_variation_id",
  "square_payment_link_id",
  "square_checkout_url",
  "selected_image_ids",
  "is_test",
].join(",");

const PUBLIC_SUMMARY_COLUMNS = [
  "row_seq",
  "product_id",
  "category",
  "brand",
  "product_name",
  "condition",
  "planned_sale_price",
  "description",
  "sneaker_sku",
  "sneaker_size",
  "sneaker_colorway",
  "subcategory",
  "size",
  "official_sku",
  "main_image_url",
  "main_image_display_url",
].join(",");

const DETAIL_SELECT_QUERY = [
  "*",
  "product_images(sort_order,file_id,name,mime_type,view_url,display_url)",
  "product_translations(locale,translated_title,translated_description,translated_condition,translated_box,translated_accessories,translation_status,generated_at)",
  "pokemon_cards(product_id,card_name,set_name,card_number,rarity,language,grading_status,grader,grade,certification_number,card_condition,source_created_at,source_updated_at)",
  "product_documents(product_id,file_id,document_type,original_file_name,mime_type,file_size,source_created_at,view_url,open_url)",
].join(",");

export function escapeIlikePattern(term) {
  return String(term).replace(/([\\%_])/g, "\\$1");
}

function applyAdminSort(query, sortKey) {
  switch (sortKey) {
    case "created_desc":
      return query
        .order("created_at", { ascending: false, nullsFirst: false })
        .order("product_id", { ascending: true });
    case "created_asc":
      return query
        .order("created_at", { ascending: true, nullsFirst: true })
        .order("product_id", { ascending: true });
    case "price_desc":
      return query
        .order("planned_sale_price", { ascending: false, nullsFirst: false })
        .order("product_id", { ascending: true });
    case "price_asc":
      return query
        .order("planned_sale_price", { ascending: true, nullsFirst: true })
        .order("product_id", { ascending: true });
    case "name_asc":
      return query
        .order("product_name", { ascending: true })
        .order("product_id", { ascending: true });
    case "name_desc":
      return query
        .order("product_name", { ascending: false })
        .order("product_id", { ascending: true });
    case "default":
    default:
      return query
        .order("row_seq", { ascending: false })
        .order("product_id", { ascending: true });
  }
}

/**
 * Fetches a single product detail by product_id in 1 Supabase round-trip.
 */
export async function queryProductDetail(supabase, { productId, isAdmin }) {
  const normalizedId = asTrimmedString(productId);
  if (!normalizedId) {
    return {
      status: 200,
      body: {
        success: false,
        error: "product_id is required",
      },
    };
  }

  const { data: row, error } = await supabase
    .from("products")
    .select(DETAIL_SELECT_QUERY)
    .eq("product_id", normalizedId)
    .maybeSingle();

  if (error) {
    throw new Error(`Supabase detail query failed: ${error.message}`);
  }

  if (!row) {
    return {
      status: 200,
      body: {
        success: false,
        error: "product not found",
        product_id: normalizedId,
      },
    };
  }

  const publishStatus = asTrimmedString(row.publish_status);
  const inventoryStatus = asTrimmedString(row.inventory_status || "in_stock");
  const recordStatus = asTrimmedString(row.record_status || "active");

  if (
    !isAdmin &&
    (row.is_test === true ||
      publishStatus !== "published" ||
      inventoryStatus !== "in_stock" ||
      recordStatus !== "active")
  ) {
    return {
      status: 200,
      body: {
        success: false,
        error: "product not found",
        product_id: normalizedId,
      },
    };
  }

  const product = buildProductDetailFromRows(row, isAdmin);
  return {
    status: 200,
    body: {
      success: true,
      version: isAdmin ? "admin-product-detail-v1" : "product-read-v4",
      product,
    },
  };
}

/**
 * Queries Admin Product List with SQL-level filter, search, sort, and pagination.
 * Supports both `admin-product-list-v3` (paginated) and legacy `admin-product-list-v2`.
 */
export async function queryAdminProductList(supabase, rawParams = {}) {
  const category = asTrimmedString(rawParams.category);
  const recordStatus = asTrimmedString(
    rawParams.record_status ?? rawParams.recordStatus
  );
  const publishStatus = asTrimmedString(
    rawParams.publish_status ?? rawParams.publishStatus
  );
  const inventoryStatus = asTrimmedString(
    rawParams.inventory_status ?? rawParams.inventoryStatus
  );
  const searchQuery = asTrimmedString(rawParams.search ?? rawParams.q);
  const sortKey =
    asTrimmedString(rawParams.sort ?? rawParams.sort_by ?? rawParams.sortBy) ||
    "default";
  const rawIsTest = asTrimmedString(
    rawParams.is_test ?? rawParams.isTest
  ).toLowerCase();
  const isTestFilter =
    rawIsTest === "true" || rawIsTest === "1"
      ? true
      : rawIsTest === "all"
        ? "all"
        : false;

  const rawPage = rawParams.page;
  const rawPageSize =
    rawParams.page_size !== undefined ? rawParams.page_size : rawParams.pageSize;

  const isPaginated =
    rawPage !== undefined ||
    rawPageSize !== undefined ||
    searchQuery !== "" ||
    publishStatus !== "" ||
    inventoryStatus !== "" ||
    rawIsTest !== "" ||
    (sortKey !== "" && sortKey !== "default");

  const requestedRecordStatus = recordStatus || "active";

  let query = supabase
    .from("products")
    .select(ADMIN_SUMMARY_COLUMNS, { count: "exact" });

  if (isTestFilter !== "all") {
    query = query.eq("is_test", isTestFilter);
  }
  if (requestedRecordStatus !== "all") {
    query = query.eq("record_status", requestedRecordStatus);
  }
  if (category && category !== "all") {
    query = query.eq("category", category);
  }
  if (publishStatus && publishStatus !== "all") {
    query = query.eq("publish_status", publishStatus);
  }
  if (inventoryStatus && inventoryStatus !== "all") {
    query = query.eq("inventory_status", inventoryStatus);
  }
  if (searchQuery) {
    const terms = searchQuery.toLowerCase().split(/\s+/).filter(Boolean);
    for (const term of terms) {
      query = query.ilike("search_text", `%${escapeIlikePattern(term)}%`);
    }
  }

  query = applyAdminSort(query, sortKey);

  if (!isPaginated) {
    const { data, error } = await query;
    if (error) {
      throw new Error(`Supabase legacy admin list query failed: ${error.message}`);
    }
    const products = (data || []).map(buildAdminProductSummaryFromRow);
    return {
      status: 200,
      body: {
        success: true,
        version: "admin-product-list-v2",
        category: category || "all",
        record_status: requestedRecordStatus,
        count: products.length,
        products,
      },
    };
  }

  let page = parseInt(String(rawPage ?? "1"), 10);
  if (Number.isNaN(page) || page < 1) page = 1;

  let pageSize = parseInt(String(rawPageSize ?? "50"), 10);
  if (Number.isNaN(pageSize) || pageSize < 1) {
    pageSize = 50;
  } else if (pageSize > 100) {
    pageSize = 100;
  }

  const startIndex = (page - 1) * pageSize;
  const endIndex = startIndex + pageSize - 1;

  // Note: If startIndex exceeds total count, PostgREST may return 416 Range Not Satisfiable.
  // First handle normal range, and gracefully treat range-out-of-bounds as empty page!
  const { data, count, error, status: pgStatus } = await query.range(
    startIndex,
    endIndex
  );

  if (error) {
    if (pgStatus === 416 || String(error.code || "") === "PGRST103") {
      // Out-of-range page requested (e.g. page=999): count total matched with head query
      let countQuery = supabase
        .from("products")
        .select("product_id", { count: "exact", head: true });
      if (isTestFilter !== "all") {
        countQuery = countQuery.eq("is_test", isTestFilter);
      }
      if (requestedRecordStatus !== "all") {
        countQuery = countQuery.eq("record_status", requestedRecordStatus);
      }
      if (category && category !== "all") {
        countQuery = countQuery.eq("category", category);
      }
      if (publishStatus && publishStatus !== "all") {
        countQuery = countQuery.eq("publish_status", publishStatus);
      }
      if (inventoryStatus && inventoryStatus !== "all") {
        countQuery = countQuery.eq("inventory_status", inventoryStatus);
      }
      if (searchQuery) {
        const terms = searchQuery.toLowerCase().split(/\s+/).filter(Boolean);
        for (const term of terms) {
          countQuery = countQuery.ilike(
            "search_text",
            `%${escapeIlikePattern(term)}%`
          );
        }
      }
      const { count: fallbackCount, error: countErr } = await countQuery;
      if (countErr) {
        throw new Error(`Supabase count query failed: ${countErr.message}`);
      }
      const totalMatched = fallbackCount ?? 0;
      const totalPages = totalMatched === 0 ? 0 : Math.ceil(totalMatched / pageSize);
      return {
        status: 200,
        body: {
          success: true,
          version: "admin-product-list-v3",
          category: category || "all",
          record_status: requestedRecordStatus,
          publish_status: publishStatus || "all",
          inventory_status: inventoryStatus || "all",
          is_test: isTestFilter,
          search: searchQuery,
          sort: sortKey,
          count: totalMatched,
          page,
          page_size: pageSize,
          total_pages: totalPages,
          products: [],
        },
      };
    }
    throw new Error(`Supabase admin list query failed: ${error.message}`);
  }

  const totalMatched = typeof count === "number" ? count : (data || []).length;
  const totalPages = totalMatched === 0 ? 0 : Math.ceil(totalMatched / pageSize);
  const products =
    totalMatched > 0 && page <= totalPages
      ? (data || []).map(buildAdminProductSummaryFromRow)
      : [];

  return {
    status: 200,
    body: {
      success: true,
      version: "admin-product-list-v3",
      category: category || "all",
      record_status: requestedRecordStatus,
      publish_status: publishStatus || "all",
      inventory_status: inventoryStatus || "all",
      is_test: isTestFilter,
      search: searchQuery,
      sort: sortKey,
      count: totalMatched,
      page,
      page_size: pageSize,
      total_pages: totalPages,
      products,
    },
  };
}

/**
 * Queries Public EC Category List (published + in_stock + active only).
 */
export async function queryPublicCategoryList(supabase, category) {
  const normalizedCategory = asTrimmedString(category);
  const { data, error } = await supabase
    .from("products")
    .select(PUBLIC_SUMMARY_COLUMNS)
    .eq("category", normalizedCategory)
    .eq("is_test", false)
    .eq("publish_status", "published")
    .eq("inventory_status", "in_stock")
    .eq("record_status", "active")
    .order("row_seq", { ascending: true })
    .order("product_id", { ascending: true });

  if (error) {
    throw new Error(`Supabase public list query failed: ${error.message}`);
  }

  const products = (data || []).map(buildPublicProductSummaryFromRow);
  return {
    status: 200,
    body: {
      success: true,
      version: "product-list-v4",
      category: normalizedCategory,
      products,
    },
  };
}

/**
 * Idempotently upserts one mapped product bundle into Supabase.
 * Safe to re-run repeatedly without creating duplicate rows.
 */
export async function upsertProductBundle(supabase, bundle) {
  const { productRow, imageRows, translationRow, pokemonCardRow, documentRow } =
    bundle;
  const productId = productRow.product_id;

  const { error: prodErr } = await supabase
    .from("products")
    .upsert(productRow, { onConflict: "product_id" });
  if (prodErr) {
    throw new Error(`Failed upserting product ${productId}: ${prodErr.message}`);
  }

  // Replace/sync product_images idempotently
  if (imageRows.length === 0) {
    const { error: delAllImgErr } = await supabase
      .from("product_images")
      .delete()
      .eq("product_id", productId);
    if (delAllImgErr) {
      throw new Error(
        `Failed clearing images for ${productId}: ${delAllImgErr.message}`
      );
    }
  } else {
    const { data: existingImgs, error: listImgErr } = await supabase
      .from("product_images")
      .select("file_id")
      .eq("product_id", productId);
    if (listImgErr) {
      throw new Error(
        `Failed reading existing images for ${productId}: ${listImgErr.message}`
      );
    }
    const keepIds = new Set(imageRows.map((r) => r.file_id));
    const staleIds = (existingImgs || [])
      .map((r) => r.file_id)
      .filter((fid) => fid && !keepIds.has(fid));
    if (staleIds.length > 0) {
      const { error: delStaleErr } = await supabase
        .from("product_images")
        .delete()
        .eq("product_id", productId)
        .in("file_id", staleIds);
      if (delStaleErr) {
        throw new Error(
          `Failed deleting stale images for ${productId}: ${delStaleErr.message}`
        );
      }
    }

    const { error: imgUpsertErr } = await supabase
      .from("product_images")
      .upsert(imageRows, { onConflict: "product_id,file_id" });
    if (imgUpsertErr) {
      throw new Error(
        `Failed upserting images for ${productId}: ${imgUpsertErr.message}`
      );
    }
  }

  if (translationRow) {
    const { error: transErr } = await supabase
      .from("product_translations")
      .upsert(translationRow, { onConflict: "product_id,locale" });
    if (transErr) {
      throw new Error(
        `Failed upserting translation for ${productId}: ${transErr.message}`
      );
    }
  } else {
    await supabase.from("product_translations").delete().eq("product_id", productId);
  }

  if (pokemonCardRow) {
    const { error: pkmErr } = await supabase
      .from("pokemon_cards")
      .upsert(pokemonCardRow, { onConflict: "product_id" });
    if (pkmErr) {
      throw new Error(
        `Failed upserting pokemon_card for ${productId}: ${pkmErr.message}`
      );
    }
  } else {
    await supabase.from("pokemon_cards").delete().eq("product_id", productId);
  }

  if (documentRow) {
    const { error: docErr } = await supabase
      .from("product_documents")
      .upsert(documentRow, { onConflict: "product_id" });
    if (docErr) {
      throw new Error(
        `Failed upserting product_document for ${productId}: ${docErr.message}`
      );
    }
  } else {
    await supabase.from("product_documents").delete().eq("product_id", productId);
  }
}

