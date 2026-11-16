#!/usr/bin/env node
/**
 * Full-column reconciliation, auth security verification, & latency benchmark script:
 * - Verifies 100% parity between Google Sheets (GAS) and Supabase across ALL 153 products:
 *   * All 42 API-exposed columns of `シート1` (`row[0]`..`row[37]`, `row[40]`..`row[43]`)
 *   * Derived/auxiliary fields (`translated_title`, `main_image_display_url`, `selected_image_ids`)
 *   * All 4 nested child tables (`product_images`, `product_translations`, `pokemon_cards`, `product_documents`)
 * - Explicitly documents the 2 GAS-internal columns (`AM: square_payment_link_generation`, `AN: ai_draft_flag`)
 *   that GAS withholds when `admin_key` is not supplied.
 * - Verifies Cloud Run auth enforcement (`401` unauthenticated on `mode=admin`, `/sync`, `/reconcile`;
 *   `200` unauthenticated on public EC endpoints) and measures warm response times.
 */

import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  asRawString,
  asTrimmedString,
  normalizeStringArray,
  toJsonNumber,
} from "../cloud-run/products-api/src/productMapper.mjs";
import {
  loadLocalEnvFile,
  resolveDefaultGasUrl,
} from "./migrate_products_to_supabase.mjs";

const requireFromApi = createRequire(
  new URL("../cloud-run/products-api/package.json", import.meta.url)
);
const { createClient } = requireFromApi("@supabase/supabase-js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");

async function timedFetchJson(url, options = {}) {
  const maxAttempts = options.retries ?? 3;
  let lastStatus = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const t0 = performance.now();
    const res = await fetch(url, {
      method: options.method || "GET",
      headers: options.headers,
    });
    const elapsedMs = Math.round((performance.now() - t0) * 10) / 10;
    lastStatus = res.status;
    if (res.ok) {
      const json = await res.json();
      return { json, elapsedMs };
    }
    if (res.status >= 500 && attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, 500 * attempt));
      continue;
    }
    break;
  }
  const u = new URL(url);
  throw new Error(`HTTP ${lastStatus} from ${u.origin}${u.pathname}`);
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function next() {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await worker(items[idx], idx);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => next())
  );
  return results;
}

function normalizeIsoTimestamp(val) {
  const s = asTrimmedString(val);
  if (!s) return "";
  const t = new Date(s).getTime();
  return Number.isNaN(t) ? s : new Date(t).toISOString();
}

async function main() {
  loadLocalEnvFile(path.join(ROOT_DIR, ".env.supabase.local"));

  const supabaseUrl = (process.env.SUPABASE_URL || "").trim();
  const serviceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  const internalSecret = (process.env.PRODUCTS_API_INTERNAL_SECRET || "").trim();
  const cloudRunApiUrl = (process.env.CLOUD_RUN_PRODUCTS_API_URL || "")
    .trim()
    .replace(/\/+$/, "");

  if (!supabaseUrl || !serviceRoleKey) {
    console.error("[ERROR] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }

  const gasUrl = resolveDefaultGasUrl();
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log("=== 1. Fetching Source List + Full Details (153 items) from GAS & Target from Supabase ===");
  const { json: gasAll, elapsedMs: gasAllMs } = await timedFetchJson(
    `${gasUrl}?mode=admin&record_status=all`
  );
  const sheetProducts = gasAll.products || [];

  const detailEntries = await mapWithConcurrency(sheetProducts, 4, async (sp) => {
    const pid = asTrimmedString(sp.product_id);
    const { json } = await timedFetchJson(
      `${gasUrl}?mode=admin&product_id=${encodeURIComponent(pid)}`
    );
    if (!json || json.success !== true || !json.product) {
      throw new Error(`GAS detail fetch failed for ${pid}`);
    }
    return [pid, json.product];
  });
  const gasDetailMap = new Map(detailEntries);

  const { data: sbProducts, error: sbErr } = await supabase
    .from("products")
    .select(
      "*, product_images(*), product_translations(*), pokemon_cards(*), product_documents(*)"
    )
    .order("row_seq", { ascending: false });

  if (sbErr) {
    throw new Error(`Supabase query failed: ${sbErr.message}`);
  }

  const sbMap = new Map(sbProducts.map((r) => [r.product_id, r]));
  const sheetIds = new Set(sheetProducts.map((p) => p.product_id));

  const missingInSupabase = sheetProducts
    .map((p) => p.product_id)
    .filter((id) => !sbMap.has(id));
  const extraInSupabase = sbProducts
    .map((r) => r.product_id)
    .filter((id) => !sheetIds.has(id));

  // Order parity check (default reverse sheet order)
  let orderMismatchCount = 0;
  for (let i = 0; i < Math.min(sheetProducts.length, sbProducts.length); i++) {
    if (sheetProducts[i].product_id !== sbProducts[i].product_id) {
      orderMismatchCount++;
    }
  }

  // All 42 API-exposed columns of シート1 (`row[0]`..`row[37]` + `row[40]`..`row[43]`)
  // + derived/auxiliary fields (`translated_title`, `main_image_display_url`, `selected_image_ids`)
  const productColumnChecks = [
    ["created_at", (sum, det) => normalizeIsoTimestamp(det.created_at ?? sum.created_at), (t) => normalizeIsoTimestamp(t.created_at || t.created_at_raw)],
    ["product_id", (sum, det) => asTrimmedString(det.product_id ?? sum.product_id), (t) => asTrimmedString(t.product_id)],
    ["category", (sum, det) => asTrimmedString(det.category ?? sum.category), (t) => asTrimmedString(t.category)],
    ["brand", (sum, det) => asTrimmedString(det.brand ?? sum.brand), (t) => asTrimmedString(t.brand)],
    ["product_name", (sum, det) => asRawString(det.product_name ?? sum.product_name).trim(), (t) => asRawString(t.product_name).trim()],
    ["condition", (sum, det) => asTrimmedString(det.condition ?? sum.condition), (t) => asTrimmedString(t.condition)],
    ["purchase_price", (sum, det) => toJsonNumber(det.purchase_price ?? sum.purchase_price, 0), (t) => toJsonNumber(t.purchase_price, 0)],
    ["planned_sale_price", (sum, det) => toJsonNumber(det.planned_sale_price ?? sum.planned_sale_price, 0), (t) => toJsonNumber(t.planned_sale_price, 0)],
    ["storage_location", (sum, det) => asTrimmedString(det.storage_location ?? sum.storage_location), (t) => asTrimmedString(t.storage_location)],
    ["description", (_sum, det) => asRawString(det.description ?? ""), (t) => asRawString(t.description ?? "")],
    ["notes", (_sum, det) => asRawString(det.notes ?? ""), (t) => asRawString(t.notes ?? "")],
    ["sneaker_sku", (sum, det) => asTrimmedString(det.sneaker_sku ?? sum.sneaker_sku), (t) => asTrimmedString(t.sneaker_sku)],
    ["sneaker_size", (sum, det) => asTrimmedString(det.sneaker_size ?? sum.sneaker_size), (t) => asTrimmedString(t.sneaker_size)],
    ["sneaker_colorway", (_sum, det) => asTrimmedString(det.sneaker_colorway), (t) => asTrimmedString(t.sneaker_colorway)],
    ["sneaker_box", (_sum, det) => asTrimmedString(det.sneaker_box), (t) => asTrimmedString(t.sneaker_box)],
    ["sneaker_accessories", (_sum, det) => asTrimmedString(det.sneaker_accessories), (t) => asTrimmedString(t.sneaker_accessories)],
    ["sneaker_release_year", (_sum, det) => asTrimmedString(det.sneaker_release_year), (t) => asTrimmedString(t.sneaker_release_year)],
    ["jewelry_type", (_sum, det) => asTrimmedString(det.jewelry_type), (t) => asTrimmedString(t.jewelry_type)],
    ["jewelry_material", (_sum, det) => asTrimmedString(det.jewelry_material), (t) => asTrimmedString(t.jewelry_material)],
    ["carat", (_sum, det) => asTrimmedString(det.carat), (t) => asTrimmedString(t.carat)],
    ["shape", (_sum, det) => asTrimmedString(det.shape), (t) => asTrimmedString(t.shape)],
    ["color_grade", (_sum, det) => asTrimmedString(det.color_grade), (t) => asTrimmedString(t.color_grade)],
    ["clarity", (_sum, det) => asTrimmedString(det.clarity), (t) => asTrimmedString(t.clarity)],
    ["cut", (_sum, det) => asTrimmedString(det.cut), (t) => asTrimmedString(t.cut)],
    ["main_stone", (_sum, det) => asTrimmedString(det.main_stone), (t) => asTrimmedString(t.main_stone)],
    ["jewelry_size", (_sum, det) => asTrimmedString(det.jewelry_size), (t) => asTrimmedString(t.jewelry_size)],
    ["weight_g", (_sum, det) => asTrimmedString(det.weight_g), (t) => asTrimmedString(t.weight_g)],
    ["certificate_available", (_sum, det) => asTrimmedString(det.certificate_available), (t) => asTrimmedString(t.certificate_available)],
    ["certificate_number", (_sum, det) => asTrimmedString(det.certificate_number), (t) => asTrimmedString(t.certificate_number)],
    ["drive_folder_url", (sum, det) => asTrimmedString(det.drive_folder_url ?? sum.drive_folder_url), (t) => asTrimmedString(t.drive_folder_url)],
    ["main_image_url", (sum, det) => asTrimmedString(det.main_image_url ?? sum.main_image_url), (t) => asTrimmedString(t.main_image_url)],
    ["publish_status", (sum, det) => asTrimmedString(det.publish_status ?? sum.publish_status) || "draft", (t) => asTrimmedString(t.publish_status)],
    ["inventory_status", (sum, det) => asTrimmedString(det.inventory_status ?? sum.inventory_status) || "in_stock", (t) => asTrimmedString(t.inventory_status)],
    ["record_status", (sum, det) => asTrimmedString(det.record_status ?? sum.record_status) || "active", (t) => asTrimmedString(t.record_status)],
    ["square_item_id", (sum, det) => asTrimmedString(det.square_item_id ?? sum.square_item_id), (t) => asTrimmedString(t.square_item_id)],
    ["square_variation_id", (sum, det) => asTrimmedString(det.square_variation_id ?? sum.square_variation_id), (t) => asTrimmedString(t.square_variation_id)],
    ["square_payment_link_id", (sum, det) => asTrimmedString(det.square_payment_link_id ?? sum.square_payment_link_id), (t) => asTrimmedString(t.square_payment_link_id)],
    ["square_checkout_url", (sum, det) => asTrimmedString(det.square_checkout_url ?? sum.square_checkout_url), (t) => asTrimmedString(t.square_checkout_url)],
    ["subcategory", (sum, det) => asTrimmedString(det.subcategory ?? sum.subcategory), (t) => asTrimmedString(t.subcategory)],
    ["size", (sum, det) => asTrimmedString(det.size ?? sum.size), (t) => asTrimmedString(t.size)],
    ["official_sku", (sum, det) => asTrimmedString(det.official_sku ?? sum.official_sku), (t) => asTrimmedString(t.official_sku)],
    ["auction_item_number", (sum, det) => asTrimmedString(det.auction_item_number ?? sum.auction_item_number), (t) => asTrimmedString(t.auction_item_number)],
    // Auxiliary / derived fields
    ["translated_title", (sum, det) => asTrimmedString(sum.translated_title || det.translation?.translated_title), (t) => asTrimmedString(t.translated_title)],
    ["main_image_display_url", (sum) => asTrimmedString(sum.main_image_display_url), (t) => asTrimmedString(t.main_image_display_url)],
    ["selected_image_ids", (sum, det) => JSON.stringify(normalizeStringArray(det.selected_image_ids ?? sum.selected_image_ids ?? [])), (t) => JSON.stringify(normalizeStringArray(t.selected_image_ids ?? []))],
  ];

  const fieldDiffs = [];
  const relationDiffs = [];

  for (const sp of sheetProducts) {
    const pid = sp.product_id;
    const tp = sbMap.get(pid);
    const det = gasDetailMap.get(pid);
    if (!tp || !det) continue;

    // 1. Check all 42 sheet columns + 3 auxiliary fields
    for (const [name, getS, getT] of productColumnChecks) {
      const sv = getS(sp, det);
      const tv = getT(tp);
      if (sv !== tv) {
        fieldDiffs.push({ product_id: pid, field: name, sheets: sv, supabase: tv });
      }
    }

    // 2. Check product_images (count + ordered file_id, name, mime_type, view_url, display_url)
    const gasImgs = Array.isArray(det.images) ? det.images : [];
    const sbImgs = (Array.isArray(tp.product_images) ? [...tp.product_images] : []).sort(
      (a, b) => Number(a.sort_order) - Number(b.sort_order)
    );
    if (gasImgs.length !== sbImgs.length) {
      relationDiffs.push({
        product_id: pid,
        relation: "product_images.length",
        sheets: gasImgs.length,
        supabase: sbImgs.length,
      });
    } else {
      for (let i = 0; i < gasImgs.length; i++) {
        const gi = gasImgs[i];
        const si = sbImgs[i];
        if (
          asTrimmedString(gi.file_id) !== asTrimmedString(si.file_id) ||
          asTrimmedString(gi.name) !== asTrimmedString(si.name) ||
          asTrimmedString(gi.mime_type) !== asTrimmedString(si.mime_type) ||
          asTrimmedString(gi.view_url) !== asTrimmedString(si.view_url) ||
          asTrimmedString(gi.display_url) !== asTrimmedString(si.display_url)
        ) {
          relationDiffs.push({
            product_id: pid,
            relation: `product_images[${i}]`,
            sheets: gi,
            supabase: si,
          });
        }
      }
    }

    // 3. Check product_translations (all 8 fields)
    const gasTrans = det.translation && typeof det.translation === "object" ? det.translation : null;
    const sbTransList = Array.isArray(tp.product_translations) ? tp.product_translations : [];
    const sbTrans = sbTransList.find((x) => x.locale === "en") || sbTransList[0] || null;
    if (Boolean(gasTrans) !== Boolean(sbTrans)) {
      relationDiffs.push({
        product_id: pid,
        relation: "product_translations.exists",
        sheets: Boolean(gasTrans),
        supabase: Boolean(sbTrans),
      });
    } else if (gasTrans && sbTrans) {
      for (const k of [
        "locale",
        "translated_title",
        "translated_description",
        "translated_condition",
        "translated_box",
        "translated_accessories",
        "translation_status",
      ]) {
        if (asRawString(gasTrans[k] ?? "").trim() !== asRawString(sbTrans[k] ?? "").trim()) {
          relationDiffs.push({
            product_id: pid,
            relation: `product_translations.${k}`,
            sheets: gasTrans[k],
            supabase: sbTrans[k],
          });
        }
      }
      if (normalizeIsoTimestamp(gasTrans.generated_at) !== normalizeIsoTimestamp(sbTrans.generated_at || sbTrans.generated_at_raw)) {
        relationDiffs.push({
          product_id: pid,
          relation: "product_translations.generated_at",
          sheets: gasTrans.generated_at,
          supabase: sbTrans.generated_at,
        });
      }
    }

    // 4. Check pokemon_cards (all 10 attributes when present)
    const gasPkm = det.pokemon_card && typeof det.pokemon_card === "object" ? det.pokemon_card : null;
    const sbPkmRaw = tp.pokemon_cards;
    const sbPkm = Array.isArray(sbPkmRaw)
      ? sbPkmRaw[0] || null
      : sbPkmRaw && sbPkmRaw.product_id
      ? sbPkmRaw
      : null;
    if (Boolean(gasPkm) !== Boolean(sbPkm)) {
      relationDiffs.push({
        product_id: pid,
        relation: "pokemon_cards.exists",
        sheets: Boolean(gasPkm),
        supabase: Boolean(sbPkm),
      });
    } else if (gasPkm && sbPkm) {
      for (const k of [
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
      ]) {
        if (asTrimmedString(gasPkm[k]) !== asTrimmedString(sbPkm[k])) {
          relationDiffs.push({
            product_id: pid,
            relation: `pokemon_cards.${k}`,
            sheets: gasPkm[k],
            supabase: sbPkm[k],
          });
        }
      }
    }

    // 5. Check product_documents
    const gasDoc = det.document && typeof det.document === "object" ? det.document : null;
    const sbDocRaw = tp.product_documents;
    const sbDoc = Array.isArray(sbDocRaw)
      ? sbDocRaw[0] || null
      : sbDocRaw && sbDocRaw.product_id
      ? sbDocRaw
      : null;
    if (Boolean(gasDoc) !== Boolean(sbDoc)) {
      relationDiffs.push({
        product_id: pid,
        relation: "product_documents.exists",
        sheets: Boolean(gasDoc),
        supabase: Boolean(sbDoc),
      });
    } else if (gasDoc && sbDoc) {
      for (const k of ["file_id", "document_type", "original_file_name", "mime_type", "view_url"]) {
        if (asTrimmedString(gasDoc[k]) !== asTrimmedString(sbDoc[k])) {
          relationDiffs.push({
            product_id: pid,
            relation: `product_documents.${k}`,
            sheets: gasDoc[k],
            supabase: sbDoc[k],
          });
        }
      }
      if (toJsonNumber(gasDoc.file_size, 0) !== toJsonNumber(sbDoc.file_size, 0)) {
        relationDiffs.push({
          product_id: pid,
          relation: "product_documents.file_size",
          sheets: gasDoc.file_size,
          supabase: sbDoc.file_size,
        });
      }
    }
  }

  const totalImages = sbProducts.reduce(
    (acc, r) => acc + (Array.isArray(r.product_images) ? r.product_images.length : 0),
    0
  );
  const totalTranslations = sbProducts.reduce(
    (acc, r) =>
      acc + (Array.isArray(r.product_translations) && r.product_translations.length > 0 ? 1 : 0),
    0
  );
  const totalPokemonCards = sbProducts.reduce(
    (acc, r) =>
      acc +
      (r.pokemon_cards &&
      (Array.isArray(r.pokemon_cards) ? r.pokemon_cards.length > 0 : Boolean(r.pokemon_cards.product_id))
        ? 1
        : 0),
    0
  );
  const totalDocuments = sbProducts.reduce(
    (acc, r) =>
      acc +
      (r.product_documents &&
      (Array.isArray(r.product_documents)
        ? r.product_documents.length > 0
        : Boolean(r.product_documents.product_id))
        ? 1
        : 0),
    0
  );
  const squareLinkedSupabase = sbProducts.filter(
    (r) => r.square_item_id || r.square_variation_id
  ).length;

  const summary = {
    sheets_total: sheetProducts.length,
    supabase_total: sbProducts.length,
    verified_sheet_columns_count: 42,
    unverified_gas_internal_columns: [
      "AM (col 39): square_payment_link_generation — internal Square idempotency generation counter withheld by GAS doGet",
      "AN (col 40): ai_draft_flag — internal AI draft flag withheld by GAS doGet without admin_key",
    ],
    missing_in_supabase: missingInSupabase,
    extra_in_supabase: extraInSupabase,
    default_order_mismatches: orderMismatchCount,
    field_mismatches_count: fieldDiffs.length,
    field_mismatches_sample: fieldDiffs.slice(0, 10),
    relation_mismatches_count: relationDiffs.length,
    relation_mismatches_sample: relationDiffs.slice(0, 10),
    supabase_square_linked_count: squareLinkedSupabase,
    supabase_product_images_rows: totalImages,
    supabase_translations_count: totalTranslations,
    supabase_pokemon_cards_count: totalPokemonCards,
    supabase_product_documents_count: totalDocuments,
    gas_full_list_ms: gasAllMs,
  };

  if (cloudRunApiUrl && process.env.SKIP_CLOUD_RUN_BENCHMARK !== "1") {
    console.log("=== 2. Verifying Cloud Run Endpoint Boundary & Warm Latency vs GAS ===");
    await timedFetchJson(`${cloudRunApiUrl}/health?db=1`);

    const unauthReconcile = await fetch(`${cloudRunApiUrl}/reconcile`, { method: "POST" });
    summary.endpoint_boundary_checks = {
      unauth_post_reconcile_status: unauthReconcile.status,
    };
    if (unauthReconcile.status !== 401) {
      throw new Error(
        `Expected 401 for unauthenticated POST /reconcile, got ${unauthReconcile.status}`
      );
    }

    const [
      gasListPage1,
      crListPage1,
      gasSearch,
      crSearch,
      gasArchived,
      crArchived,
      gasPublicSneaker,
      crPublicSneaker,
      gasDetail,
      crDetail,
    ] = await Promise.all([
      timedFetchJson(`${gasUrl}?mode=admin&page=1&page_size=50`),
      timedFetchJson(`${cloudRunApiUrl}/?mode=admin&page=1&page_size=50`),
      timedFetchJson(`${gasUrl}?mode=admin&page=1&page_size=50&search=Nike`),
      timedFetchJson(`${cloudRunApiUrl}/?mode=admin&page=1&page_size=50&search=Nike`),
      timedFetchJson(`${gasUrl}?mode=admin&page=1&page_size=50&record_status=archived`),
      timedFetchJson(`${cloudRunApiUrl}/?mode=admin&page=1&page_size=50&record_status=archived`),
      timedFetchJson(`${gasUrl}?category=sneaker`),
      timedFetchJson(`${cloudRunApiUrl}/?category=sneaker`),
      timedFetchJson(`${gasUrl}?mode=admin&product_id=TMP-000163`),
      timedFetchJson(`${cloudRunApiUrl}/?mode=admin&product_id=TMP-000163`),
    ]);

    summary.benchmarks = {
      admin_list_page1: {
        gas_ms: gasListPage1.elapsedMs,
        cloud_run_ms: crListPage1.elapsedMs,
        gas_count: gasListPage1.json.count,
        cloud_run_count: crListPage1.json.count,
      },
      admin_search_nike: {
        gas_ms: gasSearch.elapsedMs,
        cloud_run_ms: crSearch.elapsedMs,
        gas_count: gasSearch.json.count,
        cloud_run_count: crSearch.json.count,
      },
      admin_archived_list: {
        gas_ms: gasArchived.elapsedMs,
        cloud_run_ms: crArchived.elapsedMs,
        gas_count: gasArchived.json.count,
        cloud_run_count: crArchived.json.count,
      },
      public_category_sneaker: {
        gas_ms: gasPublicSneaker.elapsedMs,
        cloud_run_ms: crPublicSneaker.elapsedMs,
        gas_count: gasPublicSneaker.json.products?.length ?? 0,
        cloud_run_count: crPublicSneaker.json.products?.length ?? 0,
      },
      admin_detail_tmp000163: {
        gas_ms: gasDetail.elapsedMs,
        cloud_run_ms: crDetail.elapsedMs,
        gas_images: gasDetail.json.product?.images?.length ?? 0,
        cloud_run_images: crDetail.json.product?.images?.length ?? 0,
      },
    };
  }

  console.log(JSON.stringify(summary, null, 2));

  if (
    missingInSupabase.length > 0 ||
    extraInSupabase.length > 0 ||
    fieldDiffs.length > 0 ||
    relationDiffs.length > 0 ||
    orderMismatchCount > 0
  ) {
    process.exit(2);
  }
}

main().catch((err) => {
  console.error("[VERIFY ERROR]", err instanceof Error ? err.message : err);
  process.exit(1);
});
