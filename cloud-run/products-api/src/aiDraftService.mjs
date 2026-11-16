import crypto from "node:crypto";
import {
  asRawString,
  asTrimmedString,
  mapGasProductToSupabaseBundle,
  normalizeStringArray,
  toNullableNumber,
} from "./productMapper.mjs";
import { upsertProductBundle } from "./productsRepository.mjs";
import { hasAnySquareLink } from "./productWriter.mjs";
import {
  AI_DRAFT_CONFIG,
  applyCostFloorToCandidate_,
  callGeminiMultimodalAiDraftWithSearch_,
  callGeminiMultimodalAiDraft_,
  computeConfirmationPayloadHash_,
  detectProhibitedWords_,
  normalizeBrandValue_,
  normalizeCategoryValue_,
  parseStoredSelectedImageIds_,
  resolveAiDraftModelName,
  resolveSearchGroundingEnabled,
  sha256Hex,
  stripAuthenticityGuaranteeText_,
  stripCleaningBoilerplateText_,
  translateFixedAttributes,
  validateLegacyGrossMarginRateIfPresent_,
  validateMinCostMarkupRateInput_,
  validateSelectedImageIdsSyntax_,
} from "./aiDraftEngine.mjs";

const ALLOWED_POKEMON_GRADING_STATUSES = new Set(["graded", "ungraded"]);
const ALLOWED_POKEMON_CARD_CONDITIONS = new Set(["A", "B", "C", ""]);

export class AiDraftError extends Error {
  constructor(errorCode, message, options = {}) {
    super(message);
    this.name = "AiDraftError";
    this.errorCode = errorCode;
    this.error_code = errorCode;
    this.status = options.status || 200;
    this.preserveMessage = options.preserveMessage !== false;
    this.preserve_message = this.preserveMessage;
  }
}

const PRODUCT_BUNDLE_SELECT = [
  "*",
  "product_images(sort_order,file_id,name,mime_type,view_url,display_url)",
  "product_translations(locale,translated_title,translated_description,translated_condition,translated_box,translated_accessories,translation_status,generated_at)",
  "pokemon_cards(product_id,card_name,set_name,card_number,rarity,language,grading_status,grader,grade,certification_number,card_condition,source_created_at,source_updated_at)",
].join(",");

function pickEnglishTranslation(bundleRow) {
  const list = Array.isArray(bundleRow?.product_translations)
    ? bundleRow.product_translations
    : bundleRow?.product_translations
      ? [bundleRow.product_translations]
      : [];
  return (
    list.find((t) => asTrimmedString(t?.locale || "en") === "en") ||
    list[0] ||
    null
  );
}

function pickPokemonCard(bundleRow) {
  if (!bundleRow?.pokemon_cards) return null;
  return Array.isArray(bundleRow.pokemon_cards)
    ? bundleRow.pokemon_cards[0] || null
    : bundleRow.pokemon_cards;
}

function getSortedProductImages(bundleRow) {
  const imgs = Array.isArray(bundleRow?.product_images)
    ? [...bundleRow.product_images]
    : [];
  return imgs
    .filter((img) => img && asTrimmedString(img.file_id))
    .sort((a, b) => {
      const sa = Number(a.sort_order ?? 0);
      const sb = Number(b.sort_order ?? 0);
      if (sa !== sb) return sa - sb;
      return asTrimmedString(a.name).localeCompare(
        asTrimmedString(b.name),
        "ja",
        { numeric: true }
      );
    });
}

export function computeSupabaseImageFingerprint(productImages) {
  const sorted = [...(productImages || [])]
    .filter((img) => img && asTrimmedString(img.file_id))
    .sort((a, b) =>
      asTrimmedString(a.name).localeCompare(asTrimmedString(b.name), "ja", {
        numeric: true,
      })
    );
  const sig = sorted
    .map(
      (img) =>
        `${asTrimmedString(img.file_id)}:${asTrimmedString(
          img.name
        )}:${asTrimmedString(img.mime_type)}`
    )
    .join("|");
  return sha256Hex(sig);
}

function serializePokemonCardForFingerprint(poke) {
  if (!poke) return "";
  return [
    asTrimmedString(poke.card_name),
    asTrimmedString(poke.set_name),
    asTrimmedString(poke.card_number),
    asTrimmedString(poke.rarity),
    asTrimmedString(poke.language),
    asTrimmedString(poke.grading_status),
    asTrimmedString(poke.grader),
    asTrimmedString(poke.grade),
    asTrimmedString(poke.certification_number),
    asTrimmedString(poke.card_condition),
  ].join("|");
}

export function computeSupabaseSourceFingerprint(
  productRow,
  pokemonRow,
  productImages
) {
  const imgFp = computeSupabaseImageFingerprint(productImages);
  const attrs = [
    asTrimmedString(productRow.category),
    asTrimmedString(productRow.brand),
    asTrimmedString(productRow.product_name),
    asTrimmedString(productRow.condition),
    toNullableNumber(productRow.planned_sale_price) &&
    Number(productRow.planned_sale_price) > 0
      ? String(Number(productRow.planned_sale_price))
      : "",
    asTrimmedString(productRow.description),
    asTrimmedString(productRow.sneaker_sku),
    asTrimmedString(productRow.sneaker_size),
    asTrimmedString(productRow.sneaker_colorway),
    asTrimmedString(productRow.sneaker_box),
    asTrimmedString(productRow.sneaker_accessories),
    asTrimmedString(productRow.sneaker_release_year),
    asTrimmedString(productRow.jewelry_type),
    asTrimmedString(productRow.jewelry_material),
    productRow.carat != null ? String(productRow.carat).trim() : "",
    asTrimmedString(productRow.shape),
    asTrimmedString(productRow.color_grade),
    asTrimmedString(productRow.clarity),
    asTrimmedString(productRow.cut),
    asTrimmedString(productRow.main_stone),
    asTrimmedString(productRow.jewelry_size),
    productRow.weight_g != null ? String(productRow.weight_g).trim() : "",
    productRow.certificate_available == null
      ? ""
      : String(productRow.certificate_available),
    asTrimmedString(productRow.certificate_number),
    asTrimmedString(productRow.drive_folder_url),
    asTrimmedString(productRow.main_image_url),
    asTrimmedString(productRow.publish_status) || "draft",
    asTrimmedString(productRow.inventory_status) || "in_stock",
    asTrimmedString(productRow.record_status) || "active",
    asTrimmedString(productRow.subcategory),
    asTrimmedString(productRow.size),
    asTrimmedString(productRow.official_sku),
    serializePokemonCardForFingerprint(pokemonRow),
  ].join("::");
  return sha256Hex(`${imgFp}::${attrs}`);
}

export function computeSupabaseConfirmedFingerprint(
  productRow,
  pokemonRow,
  translationRow,
  productImages
) {
  const imgFp = computeSupabaseImageFingerprint(productImages);
  const transSig = translationRow
    ? [
        asTrimmedString(translationRow.translated_title),
        asTrimmedString(translationRow.translated_description),
        asTrimmedString(translationRow.translation_status),
      ].join("|")
    : "";
  const attrs = [
    asTrimmedString(productRow.category),
    asTrimmedString(productRow.brand),
    asTrimmedString(productRow.product_name),
    asTrimmedString(productRow.condition),
    toNullableNumber(productRow.planned_sale_price) &&
    Number(productRow.planned_sale_price) > 0
      ? String(Number(productRow.planned_sale_price))
      : "",
    asTrimmedString(productRow.description),
    asTrimmedString(productRow.sneaker_sku),
    asTrimmedString(productRow.sneaker_size),
    asTrimmedString(productRow.main_image_url),
    asTrimmedString(productRow.subcategory),
    asTrimmedString(productRow.size),
    asTrimmedString(productRow.official_sku),
    serializePokemonCardForFingerprint(pokemonRow),
  ].join("::");
  return sha256Hex(`${imgFp}::${attrs}::${transSig}`);
}

export function formatDraftRowForApiResponse(row) {
  if (!row) return null;
  const candidateJson =
    row.candidate_json && typeof row.candidate_json === "object"
      ? row.candidate_json
      : {};
  const numericPrice =
    row.candidate_price !== null &&
    row.candidate_price !== undefined &&
    row.candidate_price !== "" &&
    Number.isFinite(Number(row.candidate_price))
      ? Number(row.candidate_price)
      : null;

  const candidate = {
    title_ja: asRawString(
      row.candidate_title_ja ?? candidateJson.title_ja ?? ""
    ),
    hashtags_ja: asRawString(
      row.candidate_hashtags_ja ?? candidateJson.hashtags_ja ?? ""
    ),
    description_ja: asRawString(
      row.candidate_description_ja ?? candidateJson.description_ja ?? ""
    ),
    title_en: asRawString(
      row.candidate_title_en ?? candidateJson.title_en ?? ""
    ),
    description_en: asRawString(
      row.candidate_description_en ?? candidateJson.description_en ?? ""
    ),
    condition: asTrimmedString(
      row.candidate_condition ?? candidateJson.condition ?? ""
    ),
    price: numericPrice,
    price_evidence_verified: Boolean(candidateJson.price_evidence_verified),
    price_basis: asTrimmedString(
      row.candidate_price_basis ?? candidateJson.price_basis ?? ""
    ),
    price_note: asRawString(
      row.candidate_price_note ?? candidateJson.price_note ?? ""
    ),
    price_evidence: Array.isArray(candidateJson.price_evidence)
      ? candidateJson.price_evidence
      : [],
    category: asTrimmedString(
      row.candidate_category ?? candidateJson.category ?? ""
    ),
    brand: asTrimmedString(row.candidate_brand ?? candidateJson.brand ?? ""),
    sku: asTrimmedString(row.candidate_sku ?? candidateJson.sku ?? ""),
    sku_source: asTrimmedString(
      row.candidate_sku_source ?? candidateJson.sku_source ?? ""
    ),
    inferred_sku_from_search: asTrimmedString(
      candidateJson.inferred_sku_from_search ?? ""
    ),
    size: asTrimmedString(row.candidate_size ?? candidateJson.size ?? ""),
    needs_review: Array.isArray(candidateJson.needs_review)
      ? candidateJson.needs_review
      : [],
    identity_status: asTrimmedString(candidateJson.identity_status ?? ""),
    pokemon_card:
      candidateJson.pokemon_card &&
      typeof candidateJson.pokemon_card === "object"
        ? candidateJson.pokemon_card
        : null,
    cost_calculation:
      candidateJson.cost_calculation &&
      typeof candidateJson.cost_calculation === "object"
        ? candidateJson.cost_calculation
        : null,
  };

  return {
    draft_id: asTrimmedString(row.draft_id),
    product_id: asTrimmedString(row.product_id),
    draft_version: Number(row.draft_version || 1),
    review_status: asTrimmedString(row.review_status) || "pending_review",
    candidate,
    candidate_title_ja: candidate.title_ja,
    candidate_hashtags_ja: candidate.hashtags_ja,
    candidate_description_ja: candidate.description_ja,
    candidate_title_en: candidate.title_en,
    candidate_description_en: candidate.description_en,
    candidate_condition: candidate.condition,
    candidate_price: numericPrice,
    candidate_category: candidate.category,
    candidate_brand: candidate.brand,
    candidate_sku: candidate.sku,
    candidate_size: candidate.size,
    candidate_price_basis: candidate.price_basis,
    candidate_price_note: candidate.price_note,
    candidate_sku_source: candidate.sku_source,
    source_fingerprint: asTrimmedString(row.source_fingerprint),
    source_image_fingerprint: asTrimmedString(row.source_image_fingerprint),
    confirmed_fingerprint: asTrimmedString(row.confirmed_fingerprint),
    source_image_ids: Array.isArray(row.source_image_ids)
      ? row.source_image_ids.filter(Boolean)
      : parseStoredSelectedImageIds_(row.source_image_ids),
    model_name: asTrimmedString(row.model_name),
    generated_at: row.generated_at ? String(row.generated_at) : "",
    confirmed_at: row.confirmed_at ? String(row.confirmed_at) : "",
    confirmed_by: asTrimmedString(row.confirmed_by),
    last_confirmation_attempt_id: asTrimmedString(
      row.last_confirmation_attempt_id
    ),
    last_confirmation_payload_hash: asTrimmedString(
      row.last_confirmation_payload_hash
    ),
    search_grounding_enabled: Boolean(row.search_grounding_enabled),
    search_grounding_mode: asTrimmedString(row.search_grounding_mode),
    search_executed: Boolean(row.search_executed),
    search_queries: Array.isArray(row.search_queries)
      ? row.search_queries.map((q) => asTrimmedString(q)).filter(Boolean).join(", ")
      : asRawString(row.search_queries ?? ""),
    search_sources_count: Number(
      row.search_sources_count ??
        candidateJson.search_grounding?.sources_count ??
        (Array.isArray(candidateJson.search_grounding?.sources)
          ? candidateJson.search_grounding.sources.length
          : 0)
    ),
    search_queries_count: Number(
      row.search_queries_count ??
        candidateJson.search_grounding?.queries_count ??
        (Array.isArray(row.search_queries) ? row.search_queries.length : 0)
    ),
    stage_a_elapsed_ms: Number(
      row.stage_a_elapsed_ms ??
        candidateJson.search_grounding?.stage_a_elapsed_ms ??
        0
    ),
    stage_b_elapsed_ms: Number(
      row.stage_b_elapsed_ms ??
        candidateJson.search_grounding?.stage_b_elapsed_ms ??
        0
    ),
    search_total_elapsed_ms: Number(
      row.search_total_elapsed_ms ??
        candidateJson.search_grounding?.search_total_elapsed_ms ??
        0
    ),
    search_finish_reason: asTrimmedString(
      row.search_finish_reason ??
        candidateJson.search_grounding?.search_finish_reason ??
        ""
    ),
    search_tokens_json: asRawString(
      row.search_tokens_json ??
        candidateJson.search_grounding?.search_tokens_json ??
        ""
    ),
  };
}

export async function mirrorAiProductDraftStateToSheets({
  fetchImpl = globalThis.fetch,
  gasWebAppUrl,
  internalSecret = process.env.PRODUCTS_API_INTERNAL_SECRET,
  payload,
}) {
  if (!gasWebAppUrl) return { ok: false, skipped: true };
  if (!asTrimmedString(internalSecret)) {
    return {
      ok: false,
      error: "PRODUCTS_API_INTERNAL_SECRET is not configured for GAS mirror",
    };
  }
  const res = await fetchImpl(gasWebAppUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      ...payload,
      action: "mirror_ai_product_draft_state",
      internal_sync_source: "bis-ec-products-api",
      internal_sync_token: asTrimmedString(internalSecret),
    }),
  });
  if (!res.ok) {
    return { ok: false, error: `GAS AI draft mirror HTTP ${res.status}` };
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    return { ok: false, error: "Invalid JSON from GAS AI draft mirror" };
  }
  if (!json || json.success !== true) {
    return {
      ok: false,
      error:
        json?.message ||
        json?.error ||
        "GAS AI draft mirror returned success=false",
      errorCode: json?.error_code,
    };
  }
  return {
    ok: true,
    confirmedFingerprint: asTrimmedString(json.confirmed_fingerprint),
  };
}

function mapGasDraftRecordToSupabaseRow(gasDraft, writeSource = "sheets") {
  if (!gasDraft || typeof gasDraft !== "object") return null;
  const draftId = asTrimmedString(gasDraft.draft_id);
  const productId = asTrimmedString(gasDraft.product_id);
  if (!draftId || !productId) return null;

  const cand =
    gasDraft.candidate && typeof gasDraft.candidate === "object"
      ? gasDraft.candidate
      : {};
  const rawPrice =
    cand.price !== undefined ? cand.price : gasDraft.candidate_price;
  const parsedPrice =
    rawPrice !== null &&
    rawPrice !== undefined &&
    String(rawPrice).trim() !== "" &&
    Number.isFinite(Number(rawPrice))
      ? Math.trunc(Number(rawPrice))
      : null;

  const rawImgIds = gasDraft.source_image_ids;
  const sourceImageIds = Array.isArray(rawImgIds)
    ? rawImgIds.map((v) => asTrimmedString(v)).filter(Boolean)
    : parseStoredSelectedImageIds_(rawImgIds);

  const generatedAt = asTrimmedString(gasDraft.generated_at);
  const confirmedAt = asTrimmedString(gasDraft.confirmed_at);

  return {
    draft_id: draftId,
    product_id: productId,
    draft_version: Math.max(1, Number(gasDraft.draft_version || 1)),
    review_status: asTrimmedString(gasDraft.review_status) || "pending_review",
    candidate_title_ja: asRawString(
      cand.title_ja ?? gasDraft.candidate_title_ja ?? ""
    ),
    candidate_hashtags_ja: asRawString(
      cand.hashtags_ja ?? gasDraft.candidate_hashtags_ja ?? ""
    ),
    candidate_description_ja: asRawString(
      cand.description_ja ?? gasDraft.candidate_description_ja ?? ""
    ),
    candidate_title_en: asRawString(
      cand.title_en ?? gasDraft.candidate_title_en ?? ""
    ),
    candidate_description_en: asRawString(
      cand.description_en ?? gasDraft.candidate_description_en ?? ""
    ),
    candidate_condition: asTrimmedString(
      cand.condition ?? gasDraft.candidate_condition ?? ""
    ),
    candidate_price: parsedPrice,
    candidate_category: asTrimmedString(
      cand.category ?? gasDraft.candidate_category ?? ""
    ),
    candidate_brand: asTrimmedString(
      cand.brand ?? gasDraft.candidate_brand ?? ""
    ),
    candidate_sku: asTrimmedString(cand.sku ?? gasDraft.candidate_sku ?? ""),
    candidate_size: asTrimmedString(cand.size ?? gasDraft.candidate_size ?? ""),
    candidate_price_basis: asTrimmedString(
      cand.price_basis ?? gasDraft.candidate_price_basis ?? ""
    ),
    candidate_price_note: asRawString(
      cand.price_note ?? gasDraft.candidate_price_note ?? ""
    ),
    candidate_sku_source: asTrimmedString(
      cand.sku_source ?? gasDraft.candidate_sku_source ?? ""
    ),
    candidate_json: cand,
    source_fingerprint: asTrimmedString(gasDraft.source_fingerprint),
    source_image_fingerprint: asTrimmedString(
      gasDraft.source_image_fingerprint
    ),
    confirmed_fingerprint: asTrimmedString(gasDraft.confirmed_fingerprint),
    source_image_ids: sourceImageIds,
    model_name: asTrimmedString(gasDraft.model_name),
    generated_at:
      generatedAt && !Number.isNaN(Date.parse(generatedAt))
        ? new Date(generatedAt).toISOString()
        : new Date().toISOString(),
    confirmed_at:
      confirmedAt && !Number.isNaN(Date.parse(confirmedAt))
        ? new Date(confirmedAt).toISOString()
        : null,
    confirmed_by: asTrimmedString(gasDraft.confirmed_by),
    last_confirmation_attempt_id: asTrimmedString(
      gasDraft.last_confirmation_attempt_id
    ),
    last_confirmation_payload_hash: asTrimmedString(
      gasDraft.last_confirmation_payload_hash
    ),
    search_grounding_enabled:
      gasDraft.search_grounding_enabled === true ||
      String(gasDraft.search_grounding_enabled).toLowerCase() === "true",
    search_grounding_mode: asTrimmedString(gasDraft.search_grounding_mode),
    search_executed:
      gasDraft.search_executed === true ||
      String(gasDraft.search_executed).toLowerCase() === "true",
    search_queries: Array.isArray(gasDraft.search_queries)
      ? gasDraft.search_queries.map((q) => asTrimmedString(q)).filter(Boolean)
      : asRawString(gasDraft.search_queries ?? "")
          .split(",")
          .map((q) => q.trim())
          .filter(Boolean),
    write_source: writeSource,
    updated_at: new Date().toISOString(),
  };
}

/**
 * Syncs `ai_draft_flag` + latest `product_ai_drafts` from GAS (`get_ai_product_drafts_for_sync`)
 * into Supabase without overwriting products that currently have `sheets_mirror_pending = true`
 * or newer Supabase-authored drafts (`draft_version` higher than GAS).
 */
export async function syncAiProductDraftsFromGas({
  supabase,
  fetchImpl = globalThis.fetch,
  gasWebAppUrl,
  internalSecret = process.env.PRODUCTS_API_INTERNAL_SECRET,
  productIds = [],
  allLatest = false,
}) {
  if (!gasWebAppUrl || !asTrimmedString(internalSecret)) {
    return { syncedDraftCount: 0, updatedFlagCount: 0, skipped: true };
  }
  const normalizedIds = [
    ...new Set((productIds || []).map((id) => asTrimmedString(id)).filter(Boolean)),
  ];
  if (!allLatest && normalizedIds.length === 0) {
    return { syncedDraftCount: 0, updatedFlagCount: 0 };
  }

  const reqPayload = {
    action: "get_ai_product_drafts_for_sync",
    internal_sync_source: "bis-ec-products-api",
    internal_sync_token: asTrimmedString(internalSecret),
    ...(allLatest
      ? { all_latest: true }
      : normalizedIds.length === 1
        ? { product_id: normalizedIds[0] }
        : { product_ids: normalizedIds }),
  };

  const res = await fetchImpl(gasWebAppUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(reqPayload),
  });
  if (!res.ok) {
    return {
      syncedDraftCount: 0,
      updatedFlagCount: 0,
      error: `HTTP ${res.status}`,
    };
  }
  const json = await res.json();
  if (!json || json.success !== true || !Array.isArray(json.items)) {
    return {
      syncedDraftCount: 0,
      updatedFlagCount: 0,
      error: json?.message || "Invalid sync payload",
    };
  }

  const itemProductIds = [
    ...new Set(
      json.items.map((it) => asTrimmedString(it?.product_id)).filter(Boolean)
    ),
  ];
  if (itemProductIds.length === 0) {
    return { syncedDraftCount: 0, updatedFlagCount: 0 };
  }

  // Read existing Supabase product state + latest draft versions in chunks
  const existingProdMap = new Map();
  const existingDraftMap = new Map();
  const chunkSize = 200;
  for (let i = 0; i < itemProductIds.length; i += chunkSize) {
    const chunk = itemProductIds.slice(i, i + chunkSize);
    const [{ data: prodRows }, { data: draftRows }] = await Promise.all([
      supabase
        .from("products")
        .select("product_id, ai_draft_flag, sheets_mirror_pending")
        .in("product_id", chunk),
      supabase
        .from("product_ai_drafts")
        .select("draft_id, product_id, draft_version, review_status, write_source")
        .in("product_id", chunk)
        .order("draft_version", { ascending: false }),
    ]);
    for (const r of prodRows || []) {
      existingProdMap.set(asTrimmedString(r.product_id), r);
    }
    for (const d of draftRows || []) {
      const pid = asTrimmedString(d.product_id);
      if (!existingDraftMap.has(pid)) {
        existingDraftMap.set(pid, d);
      }
    }
  }

  let updatedFlagCount = 0;
  let syncedDraftCount = 0;

  for (const item of json.items) {
    const pid = asTrimmedString(item?.product_id);
    if (!pid) continue;
    const prodState = existingProdMap.get(pid);
    if (!prodState) continue; // Only attach to products existing in Supabase
    if (prodState.sheets_mirror_pending === true) continue;

    const gasFlag = asTrimmedString(item.ai_draft_flag);
    if (gasFlag && asTrimmedString(prodState.ai_draft_flag) !== gasFlag) {
      const { error: flagErr } = await supabase
        .from("products")
        .update({ ai_draft_flag: gasFlag })
        .eq("product_id", pid);
      if (!flagErr) updatedFlagCount += 1;
    }

    if (item.latest_ai_draft) {
      const mapped = mapGasDraftRecordToSupabaseRow(
        item.latest_ai_draft,
        "sheets"
      );
      if (!mapped) continue;

      const currentLatest = existingDraftMap.get(pid);
      if (currentLatest) {
        const curVer = Number(currentLatest.draft_version || 0);
        if (curVer > mapped.draft_version) {
          // Newer version already in Supabase — never downgrade
          continue;
        }
        if (
          curVer === mapped.draft_version &&
          asTrimmedString(currentLatest.write_source) === "supabase" &&
          asTrimmedString(currentLatest.review_status) === "confirmed" &&
          mapped.review_status !== "confirmed"
        ) {
          continue;
        }
      }

      const { error: upErr } = await supabase
        .from("product_ai_drafts")
        .upsert(mapped, { onConflict: "product_id,draft_version" });
      if (!upErr) {
        syncedDraftCount += 1;
      } else {
        console.warn(
          JSON.stringify({
            severity: "WARNING",
            message: `Failed upserting synced AI draft for ${pid}: ${upErr.message}`,
          })
        );
      }
    }
  }

  return { syncedDraftCount, updatedFlagCount };
}

export async function fetchProductBundleOrBackfill({
  supabase,
  fetchImpl,
  gasWebAppUrl,
  productId,
}) {
  const { data: existing, error } = await supabase
    .from("products")
    .select(PRODUCT_BUNDLE_SELECT)
    .eq("product_id", productId)
    .maybeSingle();
  if (error) {
    throw new Error(`Supabase product lookup failed: ${error.message}`);
  }
  if (existing) return existing;

  if (!gasWebAppUrl) return null;

  // Lazy-backfill from GAS if product was created on legacy GAS path before reconcile ran
  try {
    const detRes = await fetchImpl(
      `${gasWebAppUrl}?mode=admin&product_id=${encodeURIComponent(productId)}`,
      { method: "GET" }
    );
    if (!detRes.ok) return null;
    const detJson = await detRes.json();
    if (!detJson || detJson.success !== true || !detJson.product) return null;
    const bundle = mapGasProductToSupabaseBundle(detJson.product, null);
    await upsertProductBundle(supabase, bundle);
    const { data: reloaded } = await supabase
      .from("products")
      .select(PRODUCT_BUNDLE_SELECT)
      .eq("product_id", productId)
      .maybeSingle();
    return reloaded || null;
  } catch {
    return null;
  }
}

export async function fetchLatestSupabaseAiDraft(supabase, productId) {
  const { data, error } = await supabase
    .from("product_ai_drafts")
    .select("*")
    .eq("product_id", productId)
    .order("draft_version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`Supabase product_ai_drafts lookup failed: ${error.message}`);
  }
  return data || null;
}

async function downloadDriveImageBytes({
  fetchImpl,
  fileId,
  declaredMimeType,
  fileName,
  productId,
  isExplicitSelection,
}) {
  const url = `https://drive.google.com/uc?export=download&id=${encodeURIComponent(
    fileId
  )}`;
  let res;
  try {
    res = await fetchImpl(url, { method: "GET", redirect: "follow" });
  } catch (netErr) {
    throw new AiDraftError(
      "DRIVE_IMAGE_DOWNLOAD_FAILED",
      `Failed downloading product image '${fileId}' from Google Drive.`,
      { preserveMessage: true }
    );
  }

  if (res.status === 404 || res.status === 410) {
    if (isExplicitSelection) {
      throw new AiDraftError(
        "SELECTED_IMAGE_DELETED",
        `Selected image ID '${fileId}' for product ${productId} has been deleted or removed from Drive folder. Automatic substitution with another image is not allowed.`,
        { preserveMessage: true }
      );
    }
    throw new AiDraftError(
      "DRIVE_IMAGE_NOT_FOUND",
      `Product image '${fileId}' was not found in Google Drive for product ${productId}.`,
      { preserveMessage: true }
    );
  }
  if (!res.ok) {
    throw new AiDraftError(
      "DRIVE_IMAGE_DOWNLOAD_FAILED",
      `Google Drive returned HTTP ${res.status} for image '${fileId}' of product ${productId}.`,
      { preserveMessage: true }
    );
  }

  const contentType = asTrimmedString(
    res.headers?.get?.("content-type") || ""
  )
    .split(";")[0]
    .trim()
    .toLowerCase();

  // If Google Drive returns an HTML login / error page instead of image bytes, treat as inaccessible/deleted
  if (contentType === "text/html") {
    if (isExplicitSelection) {
      throw new AiDraftError(
        "SELECTED_IMAGE_DELETED",
        `Selected image ID '${fileId}' for product ${productId} is inaccessible or deleted in Google Drive.`,
        { preserveMessage: true }
      );
    }
    throw new AiDraftError(
      "DRIVE_IMAGE_INACCESSIBLE",
      `Product image '${fileId}' is not publicly readable by link in Google Drive.`,
      { preserveMessage: true }
    );
  }

  let mimeType =
    contentType && contentType.startsWith("image/")
      ? contentType
      : asTrimmedString(declaredMimeType).toLowerCase();
  if (mimeType === "image/jpg") mimeType = "image/jpeg";

  if (!AI_DRAFT_CONFIG.ALLOWED_MIME_TYPES.includes(mimeType)) {
    throw new AiDraftError(
      "UNSUPPORTED_MIME_TYPE",
      `Unsupported image MIME type '${mimeType}' in file: ${fileName || fileId}`,
      { preserveMessage: true }
    );
  }

  const ab = await res.arrayBuffer();
  const buf = Buffer.from(ab);
  if (buf.length === 0) {
    throw new AiDraftError(
      "DRIVE_IMAGE_DOWNLOAD_FAILED",
      `Downloaded empty image bytes for file: ${fileName || fileId}`,
      { preserveMessage: true }
    );
  }

  return {
    fileId,
    fileName: fileName || fileId,
    mimeType,
    byteLength: buf.length,
    base64: buf.toString("base64"),
  };
}

/**
 * Resolves and downloads 1..3 Drive images for a product from `product_images` + Drive.
 */
export async function resolveAndDownloadProductImagesForAi({
  fetchImpl = globalThis.fetch,
  productId,
  productImages,
  selectedImageIds,
  selectionWasPrevalidated = false,
}) {
  const allImages = getSortedProductImages({ product_images: productImages });
  const imageById = new Map(
    allImages.map((img) => [asTrimmedString(img.file_id), img])
  );

  let targetMetaList = [];
  let isExplicitSelection = false;

  if (selectedImageIds !== undefined && selectedImageIds !== null) {
    let normalizedIds;
    try {
      normalizedIds = validateSelectedImageIdsSyntax_(
        selectedImageIds,
        productId
      );
    } catch (synErr) {
      throw new AiDraftError(
        synErr.error_code || "INVALID_IMAGE_SELECTION",
        synErr.message,
        { preserveMessage: true }
      );
    }
    if (normalizedIds.length > 0) {
      isExplicitSelection = true;
      for (const sId of normalizedIds) {
        const matched = imageById.get(sId);
        if (!matched) {
          if (selectionWasPrevalidated) {
            throw new AiDraftError(
              "SELECTED_IMAGE_DELETED",
              `Selected image ID '${sId}' for product ${productId} has been deleted or removed from Drive folder. Automatic substitution with another image is not allowed.`,
              { preserveMessage: true }
            );
          }
          throw new AiDraftError(
            "INVALID_IMAGE_SELECTION",
            `Selected image ID '${sId}' does not belong to product ${productId} drive folder.`,
            { preserveMessage: true }
          );
        }
        targetMetaList.push(matched);
      }
    } else {
      targetMetaList = allImages.slice(0, AI_DRAFT_CONFIG.MAX_IMAGES);
    }
  } else {
    targetMetaList = allImages.slice(0, AI_DRAFT_CONFIG.MAX_IMAGES);
  }

  if (targetMetaList.length === 0) {
    throw new AiDraftError(
      "NO_IMAGES_FOUND",
      `No images found for product: ${productId}`,
      { preserveMessage: true }
    );
  }
  if (targetMetaList.length > AI_DRAFT_CONFIG.MAX_IMAGES) {
    throw new AiDraftError(
      "IMAGE_COUNT_EXCEEDED",
      `Image count (${targetMetaList.length}) exceeds maximum limit (${AI_DRAFT_CONFIG.MAX_IMAGES}) for product: ${productId}`,
      { preserveMessage: true }
    );
  }

  let totalBytes = 0;
  const images = [];
  const imageIds = [];
  for (const meta of targetMetaList) {
    const fid = asTrimmedString(meta.file_id);
    const dl = await downloadDriveImageBytes({
      fetchImpl,
      fileId: fid,
      declaredMimeType: meta.mime_type,
      fileName: meta.name,
      productId,
      isExplicitSelection: isExplicitSelection || selectionWasPrevalidated,
    });
    totalBytes += dl.byteLength;
    if (totalBytes > AI_DRAFT_CONFIG.MAX_TOTAL_IMAGE_BYTES) {
      throw new AiDraftError(
        "IMAGE_SIZE_EXCEEDED",
        `Total image size exceeds limit (${AI_DRAFT_CONFIG.MAX_TOTAL_IMAGE_BYTES} bytes) for product: ${productId}`,
        { preserveMessage: true }
      );
    }
    images.push({
      mimeType: dl.mimeType,
      base64: dl.base64,
      fileId: dl.fileId,
      fileName: dl.fileName,
    });
    imageIds.push(dl.fileId);
  }

  const hasBackImage =
    images.length >= 2 ||
    images.some((im) => /back|rear|裏|背面/i.test(String(im.fileName || "")));

  return { images, imageIds, hasBackImage };
}

const DOCUMENTS_RELAY_COST_TIMEOUT_MS = 5 * 1000;
const DOCUMENTS_RELAY_COST_MAX_ATTEMPTS = 2;
const DOCUMENTS_RELAY_COST_RETRY_BASE_MS = 200;

function isTransientDocumentsRelayStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function sleepRelayRetryMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasPositiveConfirmedCostFromRelay(costBreakdown, links) {
  const totalAllocated = Number(costBreakdown?.total_allocated_cost ?? 0);
  if (Number.isFinite(totalAllocated) && totalAllocated > 0) {
    return true;
  }
  const totalPrimary = Number(costBreakdown?.total_primary_cost ?? 0);
  if (Number.isFinite(totalPrimary) && totalPrimary > 0) {
    return true;
  }
  if (Array.isArray(links) && links.length > 0) {
    return links.some((lnk) => {
      if (!lnk || typeof lnk !== "object" || lnk.is_deleted === true) return false;
      const st = String(lnk.status || "confirmed").trim().toLowerCase();
      if (st !== "confirmed") return false;
      const alloc = Number(lnk.allocated_amount ?? lnk.allocatedAmount ?? 0);
      if (Number.isFinite(alloc) && alloc > 0) return true;
      const line = lnk.line || lnk.document_lines || lnk;
      const lineTotal = Number(
        line?.total_line_amount ?? line?.totalLineAmount ?? line?.item_amount ?? line?.itemAmount ?? 0
      );
      return Number.isFinite(lineTotal) && lineTotal > 0;
    });
  }
  return false;
}

/**
 * Resolves purchase cost from Readdy `documents-relay` (`get_product_cost`)
 * as auxiliary information for AI generation.
 * Distinguishes:
 * - `costStatus: "confirmed"` when purchase lines with positive cost exist,
 * - `costStatus: "no_cost"` when lookup succeeded and no purchase cost exists,
 * - `costStatus: "lookup_failed"` when communication/timeout/auth failed (never fabricates 0 yen or aborts generation).
 */
export async function fetchProductCostFromDocumentsRelay({
  fetchImpl = globalThis.fetch,
  readdyBackendUrl = process.env.READDY_BACKEND_URL,
  authorizationHeader = "",
  apikeyHeader = "",
  productId,
  timeoutMs = DOCUMENTS_RELAY_COST_TIMEOUT_MS,
  maxAttempts = DOCUMENTS_RELAY_COST_MAX_ATTEMPTS,
  retryBaseMs = DOCUMENTS_RELAY_COST_RETRY_BASE_MS,
}) {
  const baseUrl = asTrimmedString(readdyBackendUrl).replace(/\/+$/, "");
  const auth = asTrimmedString(authorizationHeader);
  if (!baseUrl || !auth || !productId) {
    const errMsg = !baseUrl
      ? "READDY_BACKEND_URL is not configured"
      : !auth
        ? "Authorization header is missing"
        : "product_id is empty";
    return {
      resolved: false,
      costStatus: "lookup_failed",
      productCost: {
        cost_status: "lookup_failed",
        cost_breakdown: null,
        links: [],
        cost_lookup_error: errMsg,
        cost_fetch_failed_at: new Date().toISOString(),
      },
      error: errMsg,
    };
  }

  const headers = {
    "Content-Type": "application/json",
    Authorization: auth,
  };
  if (asTrimmedString(apikeyHeader)) {
    headers.apikey = asTrimmedString(apikeyHeader);
  }
  const requestBody = JSON.stringify({
    action: "get_product_cost",
    product_id: productId,
  });
  const attempts = Math.max(1, Math.min(5, Math.trunc(Number(maxAttempts) || 1)));
  let lastError = "documents-relay lookup failed";

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const fetchOptions = {
        method: "POST",
        headers,
        body: requestBody,
      };
      if (
        fetchImpl === globalThis.fetch &&
        typeof AbortSignal !== "undefined" &&
        typeof AbortSignal.timeout === "function" &&
        Number.isFinite(Number(timeoutMs)) &&
        Number(timeoutMs) > 0
      ) {
        fetchOptions.signal = AbortSignal.timeout(Number(timeoutMs));
      }

      const res = await fetchImpl(
        `${baseUrl}/functions/v1/documents-relay`,
        fetchOptions
      );
      if (!res.ok) {
        lastError = `documents-relay HTTP ${res.status}`;
        if (attempt < attempts && isTransientDocumentsRelayStatus(res.status)) {
          await sleepRelayRetryMs(retryBaseMs * attempt);
          continue;
        }
        return {
          resolved: false,
          costStatus: "lookup_failed",
          productCost: {
            cost_status: "lookup_failed",
            cost_breakdown: null,
            links: [],
            cost_lookup_error: lastError,
            cost_fetch_failed_at: new Date().toISOString(),
          },
          error: lastError,
        };
      }

      const json = await res.json();
      if (!json || json.success !== true) {
        lastError =
          asTrimmedString(json?.message || json?.error) ||
          "documents-relay returned success=false";
        return {
          resolved: false,
          costStatus: "lookup_failed",
          productCost: {
            cost_status: "lookup_failed",
            cost_breakdown: null,
            links: [],
            cost_lookup_error: lastError,
            cost_fetch_failed_at: new Date().toISOString(),
          },
          error: lastError,
        };
      }
      const links = Array.isArray(json.links) ? json.links : [];
      if (
        !json.cost_breakdown ||
        !hasPositiveConfirmedCostFromRelay(json.cost_breakdown, links)
      ) {
        return {
          resolved: true,
          costStatus: "no_cost",
          productCost: null,
        };
      }
      return {
        resolved: true,
        costStatus: "confirmed",
        productCost: {
          cost_status: "confirmed",
          cost_breakdown: json.cost_breakdown,
          links,
        },
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt < attempts) {
        await sleepRelayRetryMs(retryBaseMs * attempt);
        continue;
      }
    }
  }

  return {
    resolved: false,
    costStatus: "lookup_failed",
    productCost: {
      cost_status: "lookup_failed",
      cost_breakdown: null,
      links: [],
      cost_lookup_error: lastError,
      cost_fetch_failed_at: new Date().toISOString(),
    },
    error: lastError,
  };
}

/**
 * Applies an AI candidate directly to a draft product in Supabase (`auto_apply: true`),
 * protecting existing staff-entered attributes per `applyCandidateToProduct_` rules.
 */
async function applyCandidateToSupabaseDraftProduct({
  supabase,
  bundleRow,
  productId,
  candidate,
  nowIso,
}) {
  const existingCat = normalizeCategoryValue_(bundleRow.category);
  const normCat = normalizeCategoryValue_(candidate.category);
  const effectiveCat = existingCat || normCat;

  const updateFields = {
    ai_draft_flag: AI_DRAFT_CONFIG.FLAG_VALUE,
    write_source: "supabase",
    supabase_written_at: nowIso,
  };

  if (asTrimmedString(candidate.title_ja)) {
    updateFields.product_name = asTrimmedString(candidate.title_ja);
  }
  if (asTrimmedString(candidate.title_en)) {
    updateFields.translated_title = asTrimmedString(candidate.title_en);
  }
  const existingCond = asTrimmedString(bundleRow.condition);
  const hasValidExistingCond =
    Boolean(existingCond) &&
    AI_DRAFT_CONFIG.ALLOWED_CONDITIONS.includes(existingCond);
  if (
    effectiveCat !== "pokemon_card" &&
    !hasValidExistingCond &&
    candidate.condition &&
    AI_DRAFT_CONFIG.ALLOWED_CONDITIONS.includes(candidate.condition)
  ) {
    updateFields.condition = candidate.condition;
  }

  const existingPrice = toNullableNumber(bundleRow.planned_sale_price);
  const isPriceSet =
    existingPrice !== null &&
    Number.isSafeInteger(existingPrice) &&
    existingPrice > 0;
  if (!isPriceSet && candidate.price !== null && candidate.price !== undefined) {
    const numPrice = Number(candidate.price);
    if (Number.isSafeInteger(numPrice) && numPrice > 0) {
      updateFields.planned_sale_price = numPrice;
    }
  }

  let fullDesc = asTrimmedString(candidate.description_ja);
  const hashtags = asTrimmedString(candidate.hashtags_ja);
  if (hashtags && !fullDesc.includes(hashtags)) {
    fullDesc = fullDesc ? `${fullDesc}\n\n${hashtags}` : hashtags;
  }
  if (fullDesc) {
    updateFields.description = fullDesc;
  }

  if (!existingCat && normCat) {
    updateFields.category = normCat;
  }

  const existingBrand = asTrimmedString(bundleRow.brand);
  const safeExistingBrand =
    /^(?:test|dummy|sample|n\/?a|unknown|none|null|undefined|-)$/i.test(
      existingBrand
    )
      ? ""
      : existingBrand;
  if (!safeExistingBrand) {
    const normBrand = normalizeBrandValue_(candidate.brand, effectiveCat);
    if (normBrand) {
      updateFields.brand = normBrand;
    }
  } else if (
    effectiveCat === "pokemon_card" &&
    ["Pokémon", "Pokemon", "ポケモン"].includes(safeExistingBrand)
  ) {
    updateFields.brand = "Pokemon Card Game";
  }

  const isNonSneakerCategory = [
    "pokemon_card",
    "jewelry",
    "apparel",
    "fashion_goods",
    "other",
  ].includes(effectiveCat);
  if (!isNonSneakerCategory) {
    if (!asTrimmedString(bundleRow.sneaker_sku) && asTrimmedString(candidate.sku)) {
      updateFields.sneaker_sku = asTrimmedString(candidate.sku);
    }
    if (
      !asTrimmedString(bundleRow.sneaker_size) &&
      asTrimmedString(candidate.size)
    ) {
      updateFields.sneaker_size = asTrimmedString(candidate.size);
    }
  }

  if (effectiveCat === "apparel" || effectiveCat === "fashion_goods") {
    if (!asTrimmedString(bundleRow.size) && asTrimmedString(candidate.size)) {
      updateFields.size = asTrimmedString(candidate.size);
    }
    if (
      !asTrimmedString(bundleRow.official_sku) &&
      asTrimmedString(candidate.sku)
    ) {
      updateFields.official_sku = asTrimmedString(candidate.sku);
    }
  }

  const { error: prodErr } = await supabase
    .from("products")
    .update(updateFields)
    .eq("product_id", productId);
  if (prodErr) {
    throw new Error(
      `Failed applying AI candidate to Supabase products (${productId}): ${prodErr.message}`
    );
  }

  let savedTranslation = pickEnglishTranslation(bundleRow);
  const transTitle = asTrimmedString(candidate.title_en);
  const transDesc = asTrimmedString(candidate.description_en);
  if (transTitle || transDesc) {
    const fixedTrans = translateFixedAttributes({
      condition:
        updateFields.condition ?? asTrimmedString(bundleRow.condition),
      sneaker_box: asTrimmedString(bundleRow.sneaker_box),
      sneaker_accessories: asTrimmedString(bundleRow.sneaker_accessories),
    });
    const transRow = {
      product_id: productId,
      locale: "en",
      translated_title: transTitle,
      translated_description: transDesc,
      translated_condition: fixedTrans.translated_condition,
      translated_box: fixedTrans.translated_box,
      translated_accessories: fixedTrans.translated_accessories,
      translation_status: "approved",
      generated_at: nowIso,
    };
    const { error: transErr } = await supabase
      .from("product_translations")
      .upsert(transRow, { onConflict: "product_id,locale" });
    if (transErr) {
      throw new Error(
        `Failed upserting product_translations for ${productId}: ${transErr.message}`
      );
    }
    savedTranslation = transRow;
  }

  let savedPokemon = pickPokemonCard(bundleRow);
  if (effectiveCat === "pokemon_card") {
    const candPoke =
      candidate.pokemon_card && typeof candidate.pokemon_card === "object"
        ? candidate.pokemon_card
        : null;
    if (!savedPokemon) {
      const gradingStatus =
        asTrimmedString(candPoke?.grading_status) === "graded"
          ? "graded"
          : "ungraded";
      const rawCond = asTrimmedString(candPoke?.card_condition).toUpperCase();
      const cardCondition =
        gradingStatus === "graded"
          ? ""
          : ["A", "B", "C"].includes(rawCond)
            ? rawCond
            : "A";
      const pRow = {
        product_id: productId,
        card_name:
          asTrimmedString(candPoke?.card_name) ||
          asTrimmedString(candidate.title_ja) ||
          asTrimmedString(bundleRow.product_name),
        set_name: asTrimmedString(candPoke?.set_name),
        card_number: asTrimmedString(candPoke?.card_number),
        rarity: asTrimmedString(candPoke?.rarity),
        language: asTrimmedString(candPoke?.language) || "Japanese",
        grading_status: gradingStatus,
        grader: gradingStatus === "graded" ? asTrimmedString(candPoke?.grader) : "",
        grade: gradingStatus === "graded" ? asTrimmedString(candPoke?.grade) : "",
        certification_number:
          gradingStatus === "graded"
            ? asTrimmedString(candPoke?.certification_number)
            : "",
        card_condition: cardCondition,
        source_created_at: nowIso,
        source_updated_at: nowIso,
      };
      const { error: pkErr } = await supabase
        .from("pokemon_cards")
        .upsert(pRow, { onConflict: "product_id" });
      if (pkErr) {
        throw new Error(
          `Failed upserting pokemon_cards for ${productId}: ${pkErr.message}`
        );
      }
      savedPokemon = pRow;
    } else if (candPoke) {
      const merged = { ...savedPokemon, product_id: productId, source_updated_at: nowIso };
      const fields = [
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
      for (const k of fields) {
        const existingVal = asTrimmedString(savedPokemon[k]);
        const isPlaceholder =
          /^(?:test|dummy|sample|n\/?a|unknown|none|null|undefined|-)$/i.test(
            existingVal
          );
        if ((!existingVal || isPlaceholder) && candPoke[k] !== undefined) {
          merged[k] = asTrimmedString(candPoke[k]);
        }
      }
      if (merged.grading_status !== "graded") {
        merged.grading_status = "ungraded";
        const up = asTrimmedString(merged.card_condition).toUpperCase();
        merged.card_condition = ["A", "B", "C"].includes(up) ? up : "A";
      } else {
        merged.card_condition = "";
      }
      const { error: pkErr } = await supabase
        .from("pokemon_cards")
        .upsert(merged, { onConflict: "product_id" });
      if (pkErr) {
        throw new Error(
          `Failed updating pokemon_cards for ${productId}: ${pkErr.message}`
        );
      }
      savedPokemon = merged;
    }
  }

  const mergedProductRow = { ...bundleRow, ...updateFields };
  const productImages = getSortedProductImages(bundleRow);
  const confirmedFingerprint = computeSupabaseConfirmedFingerprint(
    mergedProductRow,
    savedPokemon,
    savedTranslation,
    productImages
  );

  return {
    mergedProductRow,
    savedTranslation,
    savedPokemon,
    confirmedFingerprint,
  };
}

function buildConfirmedMirrorProductPayload(
  productRow,
  translationRow,
  pokemonRow
) {
  const payload = {
    category: asTrimmedString(productRow.category),
    brand: asTrimmedString(productRow.brand),
    product_name: asTrimmedString(productRow.product_name),
    condition: asTrimmedString(productRow.condition),
    planned_sale_price:
      toNullableNumber(productRow.planned_sale_price) &&
      Number(productRow.planned_sale_price) > 0
        ? Number(productRow.planned_sale_price)
        : null,
    description: asRawString(productRow.description ?? ""),
    sneaker_sku: asTrimmedString(productRow.sneaker_sku),
    sneaker_size: asTrimmedString(productRow.sneaker_size),
    subcategory: asTrimmedString(productRow.subcategory),
    size: asTrimmedString(productRow.size),
    official_sku: asTrimmedString(productRow.official_sku),
    translated_title: translationRow
      ? asTrimmedString(translationRow.translated_title)
      : "",
    translated_description: translationRow
      ? asRawString(translationRow.translated_description ?? "")
      : "",
  };
  if (pokemonRow && asTrimmedString(productRow.category) === "pokemon_card") {
    payload.pokemon_card = {
      card_name: asTrimmedString(pokemonRow.card_name),
      set_name: asTrimmedString(pokemonRow.set_name),
      card_number: asTrimmedString(pokemonRow.card_number),
      rarity: asTrimmedString(pokemonRow.rarity),
      language: asTrimmedString(pokemonRow.language),
      grading_status: asTrimmedString(pokemonRow.grading_status) || "ungraded",
      grader: asTrimmedString(pokemonRow.grader),
      grade: asTrimmedString(pokemonRow.grade),
      certification_number: asTrimmedString(pokemonRow.certification_number),
      card_condition: asTrimmedString(pokemonRow.card_condition),
    };
  }
  return payload;
}

function buildConfirmedMirrorTopLevelFields(
  productRow,
  translationRow,
  pokemonRow
) {
  const confirmedProduct = buildConfirmedMirrorProductPayload(
    productRow,
    translationRow,
    pokemonRow
  );
  const fields = {
    confirmed_product: confirmedProduct,
  };
  if (
    translationRow &&
    (asTrimmedString(translationRow.translated_title) ||
      asTrimmedString(translationRow.translated_description))
  ) {
    fields.translation = {
      translated_title: asTrimmedString(translationRow.translated_title),
      translated_description: asRawString(
        translationRow.translated_description ?? ""
      ),
      condition: asTrimmedString(
        translationRow.translated_condition ?? productRow.condition ?? ""
      ),
      box: asTrimmedString(
        translationRow.translated_box ?? productRow.sneaker_box ?? ""
      ),
      accessories: asTrimmedString(
        translationRow.translated_accessories ??
          productRow.sneaker_accessories ??
          ""
      ),
    };
  }
  if (confirmedProduct.pokemon_card) {
    fields.pokemon_card = confirmedProduct.pokemon_card;
  }
  return fields;
}

/**
 * Reusable Core AI Draft Execution Service (`executeSingleProductAiDraft`).
 * Designed to be directly invoked by:
 *   1) Single-product interactive endpoint (`auto_apply: false` -> `pending_review`)
 *   2) Future AI Batch Generation & Nightly Scheduled Worker (`auto_apply: true` -> `confirmed`)
 */
export async function executeSingleProductAiDraft({
  supabase,
  fetchImpl = globalThis.fetch,
  gasWebAppUrl,
  geminiApiKey = process.env.GEMINI_API_KEY,
  internalSecret = process.env.PRODUCTS_API_INTERNAL_SECRET,
  productId,
  options = {},
}) {
  const normId = asTrimmedString(productId);
  if (!normId) {
    throw new AiDraftError("PRODUCT_ID_REQUIRED", "product_id is required");
  }

  const forceRegenerate = Boolean(options.force_regenerate);
  const autoApply = Boolean(options.auto_apply);
  const confirmedBy = asTrimmedString(options.confirmed_by) || "ai_batch_worker";
  const ownershipCheck =
    typeof options.ownership_check === "function"
      ? options.ownership_check
      : null;

  const bundle = await fetchProductBundleOrBackfill({
    supabase,
    fetchImpl,
    gasWebAppUrl,
    productId: normId,
  });
  if (!bundle) {
    throw new AiDraftError(
      "PRODUCT_NOT_FOUND",
      `Product not found: ${normId}`,
      { status: 404 }
    );
  }

  const publishStatus = asTrimmedString(bundle.publish_status) || "draft";
  const recordStatus = asTrimmedString(bundle.record_status) || "active";

  if (publishStatus !== "draft") {
    throw new AiDraftError(
      "PUBLISHED_PRODUCT_NOT_ALLOWED",
      `Cannot generate AI draft for already published product: ${normId}`
    );
  }
  if (recordStatus !== "active") {
    throw new AiDraftError(
      "INACTIVE_PRODUCT_NOT_ALLOWED",
      `Cannot generate AI draft for inactive/archived product: ${normId}`
    );
  }
  if (hasAnySquareLink(bundle)) {
    throw new AiDraftError(
      "SQUARE_LINKED_PRODUCT_NOT_ALLOWED",
      `Cannot generate AI draft for Square-linked product: ${normId}`
    );
  }

  // Ensure any pre-existing GAS AI draft history is visible before checking `CONFIRMED_DRAFT_EXISTS`
  let latestDraft = await fetchLatestSupabaseAiDraft(supabase, normId);
  if (!latestDraft && bundle.sheets_mirror_pending !== true) {
    await syncAiProductDraftsFromGas({
      supabase,
      fetchImpl,
      gasWebAppUrl,
      internalSecret,
      productIds: [normId],
    });
    latestDraft = await fetchLatestSupabaseAiDraft(supabase, normId);
  }

  if (
    latestDraft &&
    asTrimmedString(latestDraft.review_status) === "confirmed" &&
    !forceRegenerate
  ) {
    throw new AiDraftError(
      "CONFIRMED_DRAFT_EXISTS",
      "A confirmed AI draft already exists. Use force_regenerate: true to overwrite."
    );
  }

  if (ownershipCheck) {
    await ownershipCheck({ phase: "prepare" });
  }

  const ttlSeconds = Math.max(
    10,
    Math.ceil(Number(AI_DRAFT_CONFIG.EXECUTION_TTL_MS || 240000) / 1000)
  );

  const { data: lockData, error: lockErr } = await supabase.rpc(
    "acquire_ai_draft_execution_lock",
    {
      p_product_id: normId,
      p_ttl_seconds: ttlSeconds,
    }
  );
  if (lockErr) {
    throw new Error(`Failed acquiring AI draft execution lock: ${lockErr.message}`);
  }
  if (!lockData || lockData.acquired !== true) {
    throw new AiDraftError(
      "GENERATION_ALREADY_IN_PROGRESS",
      `AI draft generation already in progress for product ${normId}`
    );
  }
  const executionId = asTrimmedString(lockData.execution_id);

  try {
    const productImages = getSortedProductImages(bundle);
    const pokemonRow = pickPokemonCard(bundle);
    const sourceImageFingerprint = computeSupabaseImageFingerprint(productImages);
    const sourceFingerprint = computeSupabaseSourceFingerprint(
      bundle,
      pokemonRow,
      productImages
    );

    const productMeta = {
      productId: normId,
      category: asTrimmedString(bundle.category),
      brand: asTrimmedString(bundle.brand),
      productName: asTrimmedString(bundle.product_name),
      sneakerSku: asTrimmedString(bundle.sneaker_sku),
    };

    // Resolve image selection: explicit options.selected_image_ids > saved products.selected_image_ids > first 3
    let effectiveSelected = options.selected_image_ids;
    let selectionWasPrevalidated = Boolean(options.selection_was_prevalidated);
    if (effectiveSelected === undefined) {
      const savedSelected = normalizeStringArray(bundle.selected_image_ids);
      if (savedSelected.length > 0) {
        effectiveSelected = savedSelected;
        selectionWasPrevalidated = true;
      }
    }

    let validatedImages;
    let candidate;
    const requestedModel = asTrimmedString(options.model_name);

    try {
      validatedImages = await resolveAndDownloadProductImagesForAi({
        fetchImpl,
        productId: normId,
        productImages,
        selectedImageIds: effectiveSelected,
        selectionWasPrevalidated,
      });

      const useSearchGrounding = resolveSearchGroundingEnabled(
        options.enable_search_grounding
      );
      const llmOptions = {
        ...options,
        apiKey: geminiApiKey,
        fetchImpl,
        has_back_image: validatedImages.hasBackImage,
      };
      if (useSearchGrounding) {
        if (llmOptions.ignore_existing_identity === undefined && forceRegenerate) {
          llmOptions.ignore_existing_identity = true;
        }
        candidate = await callGeminiMultimodalAiDraftWithSearch_(
          validatedImages.images,
          productMeta,
          requestedModel,
          llmOptions
        );
      } else {
        candidate = await callGeminiMultimodalAiDraft_(
          validatedImages.images,
          productMeta,
          requestedModel,
          llmOptions
        );
      }

      if (
        candidate &&
        (options.product_cost !== undefined ||
          options.min_cost_markup_rate !== undefined ||
          options.apply_cost_floor === true)
      ) {
        applyCostFloorToCandidate_(
          candidate,
          options.product_cost,
          options.min_cost_markup_rate
        );
      }
    } catch (extErr) {
      if (extErr instanceof AiDraftError) {
        throw extErr;
      }
      const preserveMsg = Boolean(extErr?.preserve_message);
      const safeMsg =
        preserveMsg && extErr?.message
          ? extErr.message
          : AI_DRAFT_CONFIG.SAFE_LLM_ERROR_MESSAGE;
      throw new AiDraftError(
        extErr?.error_code || "LLM_GENERATION_FAILED",
        safeMsg,
        { preserveMessage: true }
      );
    }

    // Re-verify execution lock + fresh product state + source fingerprint before committing
    const { data: lockValid, error: verifyErr } = await supabase.rpc(
      "verify_ai_draft_execution_lock",
      {
        p_product_id: normId,
        p_execution_id: executionId,
      }
    );
    if (verifyErr) {
      throw new Error(
        `Failed verifying AI draft execution lock: ${verifyErr.message}`
      );
    }
    if (lockValid !== true) {
      throw new AiDraftError(
        "STALE_EXECUTION_DISCARDED",
        "Execution lock expired or was superseded by another process."
      );
    }

    const { data: freshBundle, error: freshErr } = await supabase
      .from("products")
      .select(PRODUCT_BUNDLE_SELECT)
      .eq("product_id", normId)
      .maybeSingle();
    if (freshErr || !freshBundle) {
      throw new AiDraftError(
        "PRODUCT_NOT_FOUND",
        `Product disappeared during generation: ${normId}`
      );
    }

    const freshPublish = asTrimmedString(freshBundle.publish_status) || "draft";
    const freshRecord = asTrimmedString(freshBundle.record_status) || "active";
    if (
      freshPublish !== "draft" ||
      freshRecord !== "active" ||
      hasAnySquareLink(freshBundle)
    ) {
      throw new AiDraftError(
        "PRODUCT_STATE_CHANGED_DURING_GENERATION",
        "Product state changed (must remain active non-Square draft) while generating draft."
      );
    }

    const freshImages = getSortedProductImages(freshBundle);
    const freshPokemon = pickPokemonCard(freshBundle);
    const freshSourceFp = computeSupabaseSourceFingerprint(
      freshBundle,
      freshPokemon,
      freshImages
    );
    if (freshSourceFp !== sourceFingerprint) {
      throw new AiDraftError(
        "SOURCE_MODIFIED_DURING_GENERATION",
        "Product images or attributes were modified while generating draft."
      );
    }

    const draftId = `DRFT_${normId}_${Date.now()}`;
    const generatedAtIso = new Date().toISOString();
    const actuallyUsedModel = asTrimmedString(
      candidate?.actual_model_name ||
        requestedModel ||
        resolveAiDraftModelName()
    );

    if (ownershipCheck) {
      await ownershipCheck({
        phase: "commit",
        draft_id: draftId,
        model_name: actuallyUsedModel,
      });
    }

    let shouldAutoApply = autoApply;
    if (
      shouldAutoApply &&
      candidate?.search_grounding?.enabled &&
      !candidate?.search_grounding?.search_executed
    ) {
      shouldAutoApply = false;
    }

    let finalReviewStatus = "pending_review";
    let confirmedFingerprint = "";
    let confirmedAtIso = null;
    let finalConfirmedBy = "";
    let autoAppliedResult = null;

    if (shouldAutoApply) {
      autoAppliedResult = await applyCandidateToSupabaseDraftProduct({
        supabase,
        bundleRow: freshBundle,
        productId: normId,
        candidate,
        nowIso: generatedAtIso,
      });
      finalReviewStatus = "confirmed";
      confirmedFingerprint = autoAppliedResult.confirmedFingerprint;
      confirmedAtIso = generatedAtIso;
      finalConfirmedBy = confirmedBy;
    }

    const searchGroundingInfo = candidate.search_grounding || {};
    const searchEnabled = Boolean(searchGroundingInfo.enabled);
    const searchModeUsed = asTrimmedString(searchGroundingInfo.mode_used);
    const searchExecuted = Boolean(searchGroundingInfo.search_executed);
    const searchQueriesArr = Array.isArray(searchGroundingInfo.queries)
      ? searchGroundingInfo.queries.map((q) => asTrimmedString(q)).filter(Boolean)
      : [];
    const searchQueriesStr = searchQueriesArr.join(", ");

    const candidateSnapshot = {
      title_ja: candidate.title_ja,
      hashtags_ja: candidate.hashtags_ja,
      description_ja: candidate.description_ja,
      title_en: candidate.title_en,
      description_en: candidate.description_en,
      condition: candidate.condition,
      price: candidate.price,
      price_evidence_verified: Boolean(candidate.price_evidence_verified),
      price_note: candidate.price_note,
      price_basis: candidate.price_basis || "",
      price_evidence: candidate.price_evidence || [],
      category: candidate.category,
      brand: candidate.brand,
      sku: candidate.sku,
      sku_source: candidate.sku_source || "",
      inferred_sku_from_search: candidate.inferred_sku_from_search || "",
      size: candidate.size,
      needs_review: candidate.needs_review || [],
      identity_status: candidate.identity_status || "",
      pokemon_card: candidate.pokemon_card || null,
      search_grounding: candidate.search_grounding || null,
      cost_calculation: candidate.cost_calculation || null,
    };

    const telemetryMeta = {
      search_sources_count:
        searchGroundingInfo.sources_count ??
        (Array.isArray(searchGroundingInfo.sources)
          ? searchGroundingInfo.sources.length
          : 0),
      search_queries_count:
        searchGroundingInfo.queries_count ?? searchQueriesArr.length,
      stage_a_elapsed_ms: searchGroundingInfo.stage_a_elapsed_ms || 0,
      stage_b_elapsed_ms: searchGroundingInfo.stage_b_elapsed_ms || 0,
      search_total_elapsed_ms:
        searchGroundingInfo.search_total_elapsed_ms || 0,
      search_finish_reason: searchGroundingInfo.search_finish_reason || "",
      search_tokens_json: searchGroundingInfo.search_tokens_json || "",
    };

    const parsedCandidatePrice =
      candidate.price !== null &&
      candidate.price !== undefined &&
      Number.isFinite(Number(candidate.price))
        ? Math.trunc(Number(candidate.price))
        : null;

    const minDraftVersionFloor = latestDraft
      ? Number(latestDraft.draft_version || 0)
      : 0;

    const { data: savedRow, error: saveErr } = await supabase.rpc(
      "save_generated_ai_draft_atomic",
      {
        p_product_id: normId,
        p_draft_id: draftId,
        p_review_status: finalReviewStatus,
        p_candidate_title_ja: candidate.title_ja || "",
        p_candidate_hashtags_ja: candidate.hashtags_ja || "",
        p_candidate_description_ja: candidate.description_ja || "",
        p_candidate_title_en: candidate.title_en || "",
        p_candidate_description_en: candidate.description_en || "",
        p_candidate_condition: candidate.condition || "",
        p_candidate_price: parsedCandidatePrice,
        p_candidate_price_basis: candidate.price_basis || "",
        p_candidate_price_note: candidate.price_note || "",
        p_candidate_category: candidate.category || "",
        p_candidate_brand: candidate.brand || "",
        p_candidate_sku: candidate.sku || "",
        p_candidate_sku_source: candidate.sku_source || "",
        p_candidate_size: candidate.size || "",
        p_candidate_json: candidateSnapshot,
        p_source_fingerprint: sourceFingerprint,
        p_source_image_fingerprint: sourceImageFingerprint,
        p_confirmed_fingerprint: confirmedFingerprint,
        p_source_image_ids: validatedImages.imageIds,
        p_model_name: actuallyUsedModel,
        p_generated_at: generatedAtIso,
        p_confirmed_at: confirmedAtIso || null,
        p_confirmed_by: finalConfirmedBy,
        p_search_grounding_enabled: searchEnabled,
        p_search_grounding_mode: searchModeUsed,
        p_search_executed: searchExecuted,
        p_search_queries: searchQueriesArr,
        p_min_draft_version: minDraftVersionFloor,
      }
    );
    if (saveErr || !savedRow) {
      throw new Error(
        `Failed saving generated AI draft in Supabase: ${
          saveErr?.message || "empty RPC result"
        }`
      );
    }

    const nextVersion = Number(savedRow.draft_version || 1);

    // Stamp `ai_draft_flag = 'ai_managed'` + `sheets_mirror_pending = Boolean(gasWebAppUrl)` on `products`
    const { error: stampErr } = await supabase
      .from("products")
      .update({
        ai_draft_flag: AI_DRAFT_CONFIG.FLAG_VALUE,
        write_source: "supabase",
        supabase_written_at: generatedAtIso,
        sheets_mirror_pending: Boolean(gasWebAppUrl),
      })
      .eq("product_id", normId);
    if (stampErr) {
      throw new Error(
        `Failed stamping ai_draft_flag on products (${normId}): ${stampErr.message}`
      );
    }

    // Mirror downstream compatibility state to Google Sheets (`mirror_ai_product_draft_state`)
    let sheetsMirrored = false;
    if (gasWebAppUrl) {
      try {
        const mirrorPayload = {
          product_id: normId,
          ai_draft_flag: AI_DRAFT_CONFIG.FLAG_VALUE,
          mark_previous_pending_stale: true,
          apply_confirmed_product: shouldAutoApply,
          ...(shouldAutoApply && autoAppliedResult
            ? buildConfirmedMirrorTopLevelFields(
                autoAppliedResult.mergedProductRow,
                autoAppliedResult.savedTranslation,
                autoAppliedResult.savedPokemon
              )
            : {}),
          draft_record: {
            draft_id: draftId,
            product_id: normId,
            draft_version: nextVersion,
            review_status: finalReviewStatus,
            candidate_title_ja: candidate.title_ja || "",
            candidate_hashtags_ja: candidate.hashtags_ja || "",
            candidate_description_ja: candidate.description_ja || "",
            candidate_title_en: candidate.title_en || "",
            candidate_description_en: candidate.description_en || "",
            candidate_condition: candidate.condition || "",
            candidate_price:
              candidate.price !== null && candidate.price !== undefined
                ? candidate.price
                : "",
            candidate_category: candidate.category || "",
            candidate_brand: candidate.brand || "",
            candidate_sku: candidate.sku || "",
            candidate_size: candidate.size || "",
            candidate_price_basis: candidate.price_basis || "",
            candidate_price_note: candidate.price_note || "",
            candidate_sku_source: candidate.sku_source || "",
            source_fingerprint: sourceFingerprint,
            source_image_fingerprint: sourceImageFingerprint,
            confirmed_fingerprint: confirmedFingerprint,
            source_image_ids: validatedImages.imageIds.join(","),
            model_name: actuallyUsedModel,
            generated_at: generatedAtIso,
            confirmed_at: confirmedAtIso || "",
            confirmed_by: finalConfirmedBy,
            search_grounding_enabled: searchEnabled ? "true" : "false",
            search_grounding_mode: searchModeUsed,
            search_executed: searchExecuted ? "true" : "false",
            search_queries: searchQueriesStr,
            ...telemetryMeta,
          },
        };

        const mirrorRes = await mirrorAiProductDraftStateToSheets({
          fetchImpl,
          gasWebAppUrl,
          internalSecret,
          payload: mirrorPayload,
        });
        if (mirrorRes.ok) {
          sheetsMirrored = true;
          if (shouldAutoApply && mirrorRes.confirmedFingerprint) {
            confirmedFingerprint = mirrorRes.confirmedFingerprint;
            await supabase
              .from("product_ai_drafts")
              .update({
                confirmed_fingerprint: confirmedFingerprint,
                updated_at: new Date().toISOString(),
              })
              .eq("draft_id", draftId);
          }
          if (freshBundle.sheets_mirror_pending !== true) {
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
              message: `Sheets AI draft mirror deferred for ${normId}: ${mirrorRes.error}`,
            })
          );
        }
      } catch (mirrorErr) {
        console.warn(
          JSON.stringify({
            severity: "WARNING",
            message: `Sheets AI draft mirror network error for ${normId}: ${
              mirrorErr instanceof Error ? mirrorErr.message : String(mirrorErr)
            }`,
          })
        );
      }
    }

    return {
      success: true,
      write_master: "supabase",
      draft_id: draftId,
      product_id: normId,
      draft_version: nextVersion,
      review_status: finalReviewStatus,
      model_name: actuallyUsedModel,
      candidate: candidateSnapshot,
      source_fingerprint: sourceFingerprint,
      confirmed_fingerprint: confirmedFingerprint,
      auto_applied: shouldAutoApply,
      sheets_mirrored: sheetsMirrored,
    };
  } finally {
    try {
      await supabase.rpc("release_ai_draft_execution_lock", {
        p_product_id: normId,
        p_execution_id: executionId,
      });
    } catch {
      // Non-fatal; TTL auto-expires stale locks
    }
  }
}

/**
 * Single-product interactive AI draft generation HTTP handler (`generate_ai_product_draft`).
 */
export async function generateProductAiDraft({
  supabase,
  fetchImpl = globalThis.fetch,
  gasWebAppUrl,
  geminiApiKey = process.env.GEMINI_API_KEY,
  internalSecret = process.env.PRODUCTS_API_INTERNAL_SECRET,
  readdyBackendUrl = process.env.READDY_BACKEND_URL,
  callerAuthHeaders = {},
  productId,
  payload = {},
}) {
  try {
    const normId = asTrimmedString(productId || payload?.product_id);
    validateLegacyGrossMarginRateIfPresent_(payload?.min_gross_margin_rate);
    const rawMarkupRate =
      payload?.min_cost_markup_rate !== undefined
        ? payload.min_cost_markup_rate
        : payload?.min_markup_rate;
    const minCostMarkupRate = validateMinCostMarkupRateInput_(
      rawMarkupRate,
      true
    );

    const explicitSelected =
      payload?.selected_image_ids !== undefined
        ? payload.selected_image_ids
        : payload?.ai_selected_image_ids;

    let explicitCost =
      payload?.product_cost !== undefined
        ? payload.product_cost
        : payload?.product_costs &&
            typeof payload.product_costs === "object" &&
            normId
          ? payload.product_costs[normId]
          : undefined;

    if (explicitCost === undefined && normId) {
      const costLookup = await fetchProductCostFromDocumentsRelay({
        fetchImpl,
        readdyBackendUrl,
        authorizationHeader: callerAuthHeaders?.authorization || "",
        apikeyHeader: callerAuthHeaders?.apikey || "",
        productId: normId,
      });
      explicitCost = costLookup.productCost;
    }

    const result = await executeSingleProductAiDraft({
      supabase,
      fetchImpl,
      gasWebAppUrl,
      geminiApiKey,
      internalSecret,
      productId: normId,
      options: {
        force_regenerate: Boolean(payload?.force_regenerate),
        model_name: payload?.model_name,
        selected_image_ids: explicitSelected,
        product_cost: explicitCost,
        min_cost_markup_rate: minCostMarkupRate,
        apply_cost_floor: true,
        auto_apply: false,
      },
    });
    return { status: 200, body: result };
  } catch (err) {
    if (err instanceof AiDraftError) {
      return {
        status: 200,
        body: {
          success: false,
          error_code: err.errorCode,
          message: err.message || AI_DRAFT_CONFIG.SAFE_LLM_ERROR_MESSAGE,
        },
      };
    }
    if (err && err.error_code) {
      return {
        status: 200,
        body: {
          success: false,
          error_code: err.error_code,
          message:
            err.preserve_message && err.message
              ? err.message
              : AI_DRAFT_CONFIG.SAFE_LLM_ERROR_MESSAGE,
        },
      };
    }
    throw err;
  }
}

/**
 * Staff review confirmation handler (`confirm_ai_product_draft`).
 * Commits confirmed draft + product attributes + approved English translation + pokemon_cards
 * to Supabase (`write_source = 'supabase'`), then mirrors to Google Sheets (`mirror_ai_product_draft_state`)
 * so Square publish (`assertProductPublishable_`) passes seamlessly.
 */
export async function confirmProductAiDraft({
  supabase,
  fetchImpl = globalThis.fetch,
  gasWebAppUrl,
  internalSecret = process.env.PRODUCTS_API_INTERNAL_SECRET,
  productId,
  payload = {},
}) {
  const normId = asTrimmedString(productId || payload?.product_id);
  const draftId = asTrimmedString(payload?.draft_id);
  const draftVersion = Number(payload?.draft_version || 0);
  const staffId = asTrimmedString(payload?.staff_id) || "unauthenticated_staff";
  const confirmedData = payload?.confirmed_data;
  const confirmationAttemptId = asTrimmedString(
    payload?.confirmation_attempt_id ||
      (confirmedData && confirmedData.confirmation_attempt_id)
  );

  if (
    !normId ||
    !draftId ||
    !draftVersion ||
    !confirmedData ||
    typeof confirmedData !== "object" ||
    Array.isArray(confirmedData)
  ) {
    return {
      status: 200,
      body: {
        success: false,
        error_code: "INVALID_CONFIRMATION_PAYLOAD",
        message:
          "product_id, draft_id, draft_version, and confirmed_data are required",
      },
    };
  }

  const rawProductName = asTrimmedString(
    confirmedData.product_name || confirmedData.title_ja
  );
  const productName =
    stripCleaningBoilerplateText_(
      stripAuthenticityGuaranteeText_(rawProductName, { mode: "title" }),
      { mode: "title" }
    ) || rawProductName;
  const rawPrice =
    confirmedData.planned_sale_price !== undefined
      ? confirmedData.planned_sale_price
      : confirmedData.price;
  const plannedSalePrice = Number(rawPrice);

  let condition = asTrimmedString(confirmedData.condition);
  let normalizedPokeInput =
    confirmedData.pokemon_card &&
    typeof confirmedData.pokemon_card === "object" &&
    !Array.isArray(confirmedData.pokemon_card)
      ? { ...confirmedData.pokemon_card }
      : null;

  const upperConfirmCond = condition.toUpperCase();
  if (["A", "B", "C"].includes(upperConfirmCond)) {
    condition =
      upperConfirmCond === "A"
        ? "目立った傷や汚れなし"
        : upperConfirmCond === "B"
          ? "やや傷や汚れあり"
          : "傷や汚れあり";
    if (!normalizedPokeInput) normalizedPokeInput = {};
    if (!normalizedPokeInput.card_condition) {
      normalizedPokeInput.card_condition = upperConfirmCond;
    }
  }

  const rawTransTitle = asTrimmedString(
    confirmedData.translated_title || confirmedData.title_en
  );
  const transTitle =
    stripCleaningBoilerplateText_(
      stripAuthenticityGuaranteeText_(rawTransTitle, { mode: "title" }),
      { mode: "title" }
    ) || rawTransTitle;
  const rawTransDesc = asTrimmedString(
    confirmedData.translated_description || confirmedData.description_en
  );
  const transDesc =
    stripCleaningBoilerplateText_(
      stripAuthenticityGuaranteeText_(rawTransDesc, { mode: "description" }),
      { mode: "description" }
    ) || rawTransDesc;
  const rawSize =
    confirmedData.sneaker_size !== undefined
      ? confirmedData.sneaker_size
      : confirmedData.size;
  const rawSku =
    confirmedData.sneaker_sku !== undefined
      ? confirmedData.sneaker_sku
      : confirmedData.sku;

  if (!productName) {
    return {
      status: 200,
      body: {
        success: false,
        error_code: "PRODUCT_NAME_REQUIRED",
        message: "product_name is required for confirmation",
      },
    };
  }

  if (
    rawPrice === null ||
    rawPrice === undefined ||
    String(rawPrice).trim() === "" ||
    typeof rawPrice === "boolean" ||
    !Number.isSafeInteger(plannedSalePrice) ||
    plannedSalePrice <= 0
  ) {
    return {
      status: 200,
      body: {
        success: false,
        error_code: "VALID_SALE_PRICE_REQUIRED",
        message:
          "planned_sale_price must be a positive safe integer (Staff manual check required)",
      },
    };
  }

  if (!condition) {
    return {
      status: 200,
      body: {
        success: false,
        error_code: "CONDITION_REQUIRED",
        message: "condition is required for confirmation",
      },
    };
  }
  if (!AI_DRAFT_CONFIG.ALLOWED_CONDITIONS.includes(condition)) {
    return {
      status: 200,
      body: {
        success: false,
        error_code: "INVALID_CONDITION_VALUE",
        message: `condition must be one of ALLOWED_CONDITIONS: ${condition}`,
      },
    };
  }

  const rawCategoryStr = asTrimmedString(confirmedData.category);
  const normalizedCat = normalizeCategoryValue_(rawCategoryStr);
  if (rawCategoryStr && !normalizedCat) {
    return {
      status: 200,
      body: {
        success: false,
        error_code: "INVALID_CATEGORY_VALUE",
        message: `Invalid category value '${rawCategoryStr}'. Must be one of: ${AI_DRAFT_CONFIG.ALLOWED_CATEGORIES.join(
          ", "
        )}`,
      },
    };
  }

  if (normalizedPokeInput) {
    const gradingStatus = asTrimmedString(normalizedPokeInput.grading_status);
    if (
      gradingStatus &&
      !ALLOWED_POKEMON_GRADING_STATUSES.has(gradingStatus)
    ) {
      return {
        status: 200,
        body: {
          success: false,
          error_code: "INVALID_POKEMON_CARD_PAYLOAD",
          message: "pokemon_card.grading_status must be 'graded' or 'ungraded'",
        },
      };
    }
    const cardCondition = asTrimmedString(
      normalizedPokeInput.card_condition
    ).toUpperCase();
    if (!ALLOWED_POKEMON_CARD_CONDITIONS.has(cardCondition)) {
      return {
        status: 200,
        body: {
          success: false,
          error_code: "INVALID_POKEMON_CARD_PAYLOAD",
          message: "pokemon_card.card_condition must be 'A', 'B', 'C', or empty",
        },
      };
    }
  }

  if (!transTitle || !transDesc) {
    return {
      status: 200,
      body: {
        success: false,
        error_code: "TRANSLATED_CONTENT_REQUIRED",
        message: "translated_title and translated_description are required",
      },
    };
  }

  const bundle = await fetchProductBundleOrBackfill({
    supabase,
    fetchImpl,
    gasWebAppUrl,
    productId: normId,
  });
  if (!bundle) {
    return {
      status: 200,
      body: {
        success: false,
        error_code: "PRODUCT_NOT_FOUND",
        message: `Product not found: ${normId}`,
      },
    };
  }

  const publishStatus = asTrimmedString(bundle.publish_status) || "draft";
  const recordStatus = asTrimmedString(bundle.record_status) || "active";
  if (publishStatus !== "draft" || recordStatus !== "active") {
    return {
      status: 200,
      body: {
        success: false,
        error_code: "INVALID_PRODUCT_STATE_FOR_CONFIRMATION",
        message:
          "Only active draft products can be confirmed via AI draft workflow.",
      },
    };
  }
  if (hasAnySquareLink(bundle)) {
    return {
      status: 200,
      body: {
        success: false,
        error_code: "SQUARE_LINKED_PRODUCT_NOT_ALLOWED",
        message:
          "Square-linked products cannot be confirmed via AI draft workflow.",
      },
    };
  }

  let latestDraft = await fetchLatestSupabaseAiDraft(supabase, normId);
  if (!latestDraft && bundle.sheets_mirror_pending !== true) {
    await syncAiProductDraftsFromGas({
      supabase,
      fetchImpl,
      gasWebAppUrl,
      internalSecret,
      productIds: [normId],
    });
    latestDraft = await fetchLatestSupabaseAiDraft(supabase, normId);
  }

  if (!latestDraft) {
    return {
      status: 200,
      body: {
        success: false,
        error_code: "NO_DRAFT_RECORD_FOUND",
        message: `No AI draft record found for product: ${normId}`,
      },
    };
  }

  if (
    asTrimmedString(latestDraft.draft_id) !== draftId ||
    Number(latestDraft.draft_version) !== draftVersion
  ) {
    return {
      status: 200,
      body: {
        success: false,
        error_code: "DRAFT_VERSION_MISMATCH",
        message: `Target draft (${draftId} v${draftVersion}) is outdated. Latest is ${latestDraft.draft_id} v${latestDraft.draft_version}.`,
      },
    };
  }

  const normalizedConfirmedDataForHash = {
    ...confirmedData,
    condition,
    ...(normalizedPokeInput ? { pokemon_card: normalizedPokeInput } : {}),
  };
  const currentPayloadHash = computeConfirmationPayloadHash_(
    normalizedConfirmedDataForHash
  );
  const latestReviewStatus = asTrimmedString(latestDraft.review_status);
  const isReconfirming = latestReviewStatus === "confirmed";

  if (isReconfirming) {
    const prevAttemptId = asTrimmedString(
      latestDraft.last_confirmation_attempt_id
    );
    const prevPayloadHash = asTrimmedString(
      latestDraft.last_confirmation_payload_hash
    );

    if (confirmationAttemptId && prevAttemptId === confirmationAttemptId) {
      if (prevPayloadHash && prevPayloadHash !== currentPayloadHash) {
        return {
          status: 200,
          body: {
            success: false,
            error_code: "DRAFT_ALREADY_CONFIRMED_WITH_DIFFERENT_DATA",
            message:
              "Idempotent replay rejected: confirmation_attempt_id matches, but confirmed_data differs from the saved confirmation.",
          },
        };
      }
      return {
        status: 200,
        body: {
          success: true,
          write_master: "supabase",
          product_id: normId,
          draft_id: draftId,
          draft_version: draftVersion,
          review_status: "confirmed",
          confirmed_fingerprint: asTrimmedString(
            latestDraft.confirmed_fingerprint
          ),
          is_idempotent_replay: true,
        },
      };
    }

    if (!confirmationAttemptId) {
      return {
        status: 200,
        body: {
          success: false,
          error_code: "INVALID_IDEMPOTENT_REPLAY_ATTEMPT",
          message:
            "Draft is already confirmed. A valid confirmation_attempt_id is required for idempotent retry or re-confirmation.",
        },
      };
    }

    if (prevPayloadHash && prevPayloadHash === currentPayloadHash) {
      return {
        status: 200,
        body: {
          success: false,
          error_code: "INVALID_IDEMPOTENT_REPLAY_ATTEMPT",
          message:
            "Draft is already confirmed with identical data under a different confirmation_attempt_id. Retry with the original confirmation_attempt_id.",
        },
      };
    }
  } else if (latestReviewStatus !== "pending_review") {
    return {
      status: 200,
      body: {
        success: false,
        error_code: "DRAFT_NOT_IN_PENDING_STATUS",
        message: `Draft status must be pending_review or confirmed (current: ${latestReviewStatus})`,
      },
    };
  }

  // Verify images & source fingerprint have not been externally altered
  const productImages = getSortedProductImages(bundle);
  const pokemonRow = pickPokemonCard(bundle);
  const translationRow = pickEnglishTranslation(bundle);
  const currentImgFp = computeSupabaseImageFingerprint(productImages);

  if (asTrimmedString(latestDraft.write_source) === "supabase") {
    if (
      asTrimmedString(latestDraft.source_image_fingerprint) &&
      currentImgFp !== asTrimmedString(latestDraft.source_image_fingerprint)
    ) {
      return {
        status: 200,
        body: {
          success: false,
          error_code: "IMAGE_FINGERPRINT_MISMATCH",
          message:
            "Product images were changed after AI draft generation. Please regenerate AI draft.",
        },
      };
    }
    if (!isReconfirming) {
      const currentSourceFp = computeSupabaseSourceFingerprint(
        bundle,
        pokemonRow,
        productImages
      );
      if (
        asTrimmedString(latestDraft.source_fingerprint) &&
        currentSourceFp !== asTrimmedString(latestDraft.source_fingerprint)
      ) {
        const isResumingSameAttempt =
          Boolean(confirmationAttemptId) &&
          confirmationAttemptId ===
            asTrimmedString(latestDraft.last_confirmation_attempt_id) &&
          currentPayloadHash ===
            asTrimmedString(latestDraft.last_confirmation_payload_hash);
        if (!isResumingSameAttempt) {
          return {
            status: 200,
            body: {
              success: false,
              error_code: "SOURCE_ATTRIBUTE_MODIFIED_BY_OTHER",
              message:
                "Product attributes were modified by another user or process since draft generation. Please regenerate.",
            },
          };
        }
      }
    }
  } else {
    // Legacy `write_source === 'sheets'` draft: verify all `source_image_ids` still belong to `product_images`
    const currentFileIdSet = new Set(
      productImages.map((img) => asTrimmedString(img.file_id))
    );
    const draftImgIds = Array.isArray(latestDraft.source_image_ids)
      ? latestDraft.source_image_ids
      : parseStoredSelectedImageIds_(latestDraft.source_image_ids);
    for (const fid of draftImgIds) {
      if (fid && !currentFileIdSet.has(fid)) {
        return {
          status: 200,
          body: {
            success: false,
            error_code: "IMAGE_FINGERPRINT_MISMATCH",
            message:
              "Product images were changed after AI draft generation. Please regenerate AI draft.",
          },
        };
      }
    }
  }

  // Category immutability rule (`llm_product_draft.js` L6901-6915):
  // Initial category can be set ONLY when existing category is empty (""); otherwise category cannot change.
  const existingCategory = asTrimmedString(bundle.category);
  if (existingCategory && normalizedCat && normalizedCat !== existingCategory) {
    return {
      status: 200,
      body: {
        success: false,
        error_code: "CATEGORY_CANNOT_BE_CHANGED",
        message: `Existing category '${existingCategory}' cannot be changed to '${normalizedCat}'.`,
      },
    };
  }
  const effectiveCategory = existingCategory || normalizedCat;

  let fullDescription = stripCleaningBoilerplateText_(
    stripAuthenticityGuaranteeText_(asTrimmedString(confirmedData.description), {
      mode: "description",
    }),
    { mode: "description" }
  );
  const hashtags = stripCleaningBoilerplateText_(
    stripAuthenticityGuaranteeText_(asTrimmedString(confirmedData.hashtags_ja), {
      mode: "hashtags",
    }),
    { mode: "hashtags" }
  );
  if (hashtags && !fullDescription.includes(hashtags)) {
    fullDescription = fullDescription
      ? `${fullDescription}\n\n${hashtags}`
      : hashtags;
  }

  const nowIso = new Date().toISOString();
  const hadPriorPendingMirror = bundle.sheets_mirror_pending === true;

  const productUpdate = {
    product_name: productName,
    ...(transTitle ? { translated_title: transTitle } : {}),
    condition,
    planned_sale_price: plannedSalePrice,
    description: fullDescription,
    ai_draft_flag: AI_DRAFT_CONFIG.FLAG_VALUE,
    write_source: "supabase",
    supabase_written_at: nowIso,
    sheets_mirror_pending: Boolean(gasWebAppUrl),
  };

  if (!existingCategory && normalizedCat) {
    productUpdate.category = normalizedCat;
  }

  if (confirmedData.brand !== undefined) {
    const normConfirmedBrand = normalizeBrandValue_(
      confirmedData.brand,
      effectiveCategory
    );
    productUpdate.brand =
      normConfirmedBrand || asTrimmedString(confirmedData.brand);
  }

  const isNonSneakerConfirmedCat = [
    "pokemon_card",
    "jewelry",
    "apparel",
    "fashion_goods",
    "other",
  ].includes(effectiveCategory);
  if (!isNonSneakerConfirmedCat) {
    if (rawSize !== undefined) {
      productUpdate.sneaker_size = asTrimmedString(rawSize);
    }
    if (rawSku !== undefined) {
      productUpdate.sneaker_sku = asTrimmedString(rawSku);
    }
  }

  if (
    effectiveCategory === "apparel" ||
    effectiveCategory === "fashion_goods"
  ) {
    if (
      confirmedData.subcategory !== undefined &&
      confirmedData.subcategory !== null
    ) {
      productUpdate.subcategory = asTrimmedString(confirmedData.subcategory);
    }
    if (!asTrimmedString(bundle.size) && asTrimmedString(rawSize)) {
      productUpdate.size = asTrimmedString(rawSize);
    }
    const rawFashionSku =
      confirmedData.official_sku !== undefined
        ? confirmedData.official_sku
        : rawSku;
    if (
      !asTrimmedString(bundle.official_sku) &&
      asTrimmedString(rawFashionSku)
    ) {
      productUpdate.official_sku = asTrimmedString(rawFashionSku);
    }
  }

  if (confirmationAttemptId && !isReconfirming) {
    const { error: preStampErr } = await supabase
      .from("product_ai_drafts")
      .update({
        last_confirmation_attempt_id: confirmationAttemptId,
        last_confirmation_payload_hash: currentPayloadHash,
        updated_at: nowIso,
      })
      .eq("draft_id", draftId);
    if (preStampErr) {
      throw new Error(
        `Failed pre-stamping confirmation_attempt_id (${draftId}): ${preStampErr.message}`
      );
    }
  }

  const { error: prodUpdErr } = await supabase
    .from("products")
    .update(productUpdate)
    .eq("product_id", normId);
  if (prodUpdErr) {
    throw new Error(
      `Failed updating confirmed product in Supabase (${normId}): ${prodUpdErr.message}`
    );
  }

  let savedPokemon = pokemonRow;
  if (effectiveCategory === "pokemon_card") {
    const pokeSource = normalizedPokeInput || pokemonRow || {};
    const gradingStatus =
      asTrimmedString(pokeSource.grading_status) === "graded"
        ? "graded"
        : "ungraded";
    const rawCardCond = asTrimmedString(
      pokeSource.card_condition
    ).toUpperCase();
    const cardCondition =
      gradingStatus === "graded"
        ? ""
        : ["A", "B", "C"].includes(rawCardCond)
          ? rawCardCond
          : "A";
    const pkmRow = {
      product_id: normId,
      card_name: asTrimmedString(pokeSource.card_name) || productName,
      set_name: asTrimmedString(pokeSource.set_name),
      card_number: asTrimmedString(pokeSource.card_number),
      rarity: asTrimmedString(pokeSource.rarity),
      language: asTrimmedString(pokeSource.language) || "Japanese",
      grading_status: gradingStatus,
      grader: gradingStatus === "graded" ? asTrimmedString(pokeSource.grader) : "",
      grade: gradingStatus === "graded" ? asTrimmedString(pokeSource.grade) : "",
      certification_number:
        gradingStatus === "graded"
          ? asTrimmedString(pokeSource.certification_number)
          : "",
      card_condition: cardCondition,
      source_created_at: pokemonRow?.source_created_at || nowIso,
      source_updated_at: nowIso,
    };
    const { error: pkErr } = await supabase
      .from("pokemon_cards")
      .upsert(pkmRow, { onConflict: "product_id" });
    if (pkErr) {
      throw new Error(
        `Failed upserting confirmed pokemon_cards (${normId}): ${pkErr.message}`
      );
    }
    savedPokemon = pkmRow;
  }

  const fixedTrans = translateFixedAttributes({
    condition,
    sneaker_box: asTrimmedString(bundle.sneaker_box),
    sneaker_accessories: asTrimmedString(bundle.sneaker_accessories),
  });
  const savedTranslation = {
    product_id: normId,
    locale: "en",
    translated_title: transTitle,
    translated_description: transDesc,
    translated_condition: fixedTrans.translated_condition,
    translated_box: fixedTrans.translated_box,
    translated_accessories: fixedTrans.translated_accessories,
    translation_status: "approved",
    generated_at: nowIso,
  };
  const { error: transErr } = await supabase
    .from("product_translations")
    .upsert(savedTranslation, { onConflict: "product_id,locale" });
  if (transErr) {
    throw new Error(
      `Failed upserting confirmed product_translations (${normId}): ${transErr.message}`
    );
  }

  const mergedProductRow = { ...bundle, ...productUpdate };
  let confirmedFingerprint = computeSupabaseConfirmedFingerprint(
    mergedProductRow,
    savedPokemon,
    savedTranslation,
    productImages
  );

  const { error: draftUpdErr } = await supabase
    .from("product_ai_drafts")
    .update({
      review_status: "confirmed",
      confirmed_fingerprint: confirmedFingerprint,
      confirmed_at: nowIso,
      confirmed_by: staffId,
      last_confirmation_attempt_id: confirmationAttemptId,
      last_confirmation_payload_hash: currentPayloadHash,
      write_source: "supabase",
      updated_at: nowIso,
    })
    .eq("draft_id", draftId);
  if (draftUpdErr) {
    throw new Error(
      `Failed updating product_ai_drafts confirmation (${draftId}): ${draftUpdErr.message}`
    );
  }

  let sheetsMirrored = false;
  if (gasWebAppUrl) {
    try {
      const formattedLatest = formatDraftRowForApiResponse(latestDraft);
      const mirrorPayload = {
        product_id: normId,
        ai_draft_flag: AI_DRAFT_CONFIG.FLAG_VALUE,
        apply_confirmed_product: true,
        ...buildConfirmedMirrorTopLevelFields(
          mergedProductRow,
          savedTranslation,
          savedPokemon
        ),
        draft_record: {
          draft_id: draftId,
          product_id: normId,
          draft_version: draftVersion,
          review_status: "confirmed",
          candidate_title_ja: asRawString(latestDraft.candidate_title_ja ?? ""),
          candidate_hashtags_ja: asRawString(
            latestDraft.candidate_hashtags_ja ?? ""
          ),
          candidate_description_ja: asRawString(
            latestDraft.candidate_description_ja ?? ""
          ),
          candidate_title_en: asRawString(latestDraft.candidate_title_en ?? ""),
          candidate_description_en: asRawString(
            latestDraft.candidate_description_en ?? ""
          ),
          candidate_condition: asTrimmedString(latestDraft.candidate_condition),
          candidate_price:
            latestDraft.candidate_price !== null &&
            latestDraft.candidate_price !== undefined
              ? latestDraft.candidate_price
              : "",
          candidate_category: asTrimmedString(latestDraft.candidate_category),
          candidate_brand: asTrimmedString(latestDraft.candidate_brand),
          candidate_sku: asTrimmedString(latestDraft.candidate_sku),
          candidate_size: asTrimmedString(latestDraft.candidate_size),
          candidate_price_basis: asTrimmedString(
            latestDraft.candidate_price_basis
          ),
          candidate_price_note: asRawString(
            latestDraft.candidate_price_note ?? ""
          ),
          candidate_sku_source: asTrimmedString(
            latestDraft.candidate_sku_source
          ),
          source_fingerprint: asTrimmedString(latestDraft.source_fingerprint),
          source_image_fingerprint: asTrimmedString(
            latestDraft.source_image_fingerprint
          ),
          confirmed_fingerprint: confirmedFingerprint,
          source_image_ids: Array.isArray(latestDraft.source_image_ids)
            ? latestDraft.source_image_ids.join(",")
            : asTrimmedString(latestDraft.source_image_ids),
          model_name: asTrimmedString(latestDraft.model_name),
          generated_at: latestDraft.generated_at
            ? String(latestDraft.generated_at)
            : nowIso,
          confirmed_at: nowIso,
          confirmed_by: staffId,
          last_confirmation_attempt_id: confirmationAttemptId,
          last_confirmation_payload_hash: currentPayloadHash,
          search_grounding_enabled: latestDraft.search_grounding_enabled
            ? "true"
            : "false",
          search_grounding_mode: asTrimmedString(
            latestDraft.search_grounding_mode
          ),
          search_executed: latestDraft.search_executed ? "true" : "false",
          search_queries: formattedLatest?.search_queries ?? "",
          search_sources_count: formattedLatest?.search_sources_count ?? 0,
          search_queries_count: formattedLatest?.search_queries_count ?? 0,
          stage_a_elapsed_ms: formattedLatest?.stage_a_elapsed_ms ?? 0,
          stage_b_elapsed_ms: formattedLatest?.stage_b_elapsed_ms ?? 0,
          search_total_elapsed_ms:
            formattedLatest?.search_total_elapsed_ms ?? 0,
          search_finish_reason: formattedLatest?.search_finish_reason ?? "",
          search_tokens_json: formattedLatest?.search_tokens_json ?? "",
        },
      };

      const mirrorRes = await mirrorAiProductDraftStateToSheets({
        fetchImpl,
        gasWebAppUrl,
        internalSecret,
        payload: mirrorPayload,
      });
      if (mirrorRes.ok) {
        sheetsMirrored = true;
        if (mirrorRes.confirmedFingerprint) {
          confirmedFingerprint = mirrorRes.confirmedFingerprint;
          await supabase
            .from("product_ai_drafts")
            .update({
              confirmed_fingerprint: confirmedFingerprint,
              updated_at: new Date().toISOString(),
            })
            .eq("draft_id", draftId);
        }
        if (!hadPriorPendingMirror) {
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
            message: `Sheets confirm_ai_product_draft mirror deferred for ${normId}: ${mirrorRes.error}`,
          })
        );
      }
    } catch (mirrorErr) {
      console.warn(
        JSON.stringify({
          severity: "WARNING",
          message: `Sheets confirm_ai_product_draft mirror network error for ${normId}: ${
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
      write_master: "supabase",
      product_id: normId,
      draft_id: draftId,
      draft_version: draftVersion,
      review_status: "confirmed",
      confirmed_fingerprint: confirmedFingerprint,
      sheets_mirrored: sheetsMirrored,
    },
  };
}

/**
 * Latest AI draft lookup handler (`get_ai_product_draft`).
 */
export async function getProductAiDraft({
  supabase,
  fetchImpl = globalThis.fetch,
  gasWebAppUrl,
  internalSecret = process.env.PRODUCTS_API_INTERNAL_SECRET,
  productId,
}) {
  const normId = asTrimmedString(productId);
  if (!normId) {
    return {
      status: 200,
      body: {
        success: false,
        error_code: "PRODUCT_ID_REQUIRED",
        message: "product_id is required",
      },
    };
  }

  let latestDraft = await fetchLatestSupabaseAiDraft(supabase, normId);
  if (!latestDraft && gasWebAppUrl && asTrimmedString(internalSecret)) {
    const { data: prod } = await supabase
      .from("products")
      .select("product_id, sheets_mirror_pending")
      .eq("product_id", normId)
      .maybeSingle();
    if (!prod) {
      await fetchProductBundleOrBackfill({
        supabase,
        fetchImpl,
        gasWebAppUrl,
        productId: normId,
      });
    }
    if (!prod || prod.sheets_mirror_pending !== true) {
      await syncAiProductDraftsFromGas({
        supabase,
        fetchImpl,
        gasWebAppUrl,
        internalSecret,
        productIds: [normId],
      });
      latestDraft = await fetchLatestSupabaseAiDraft(supabase, normId);
    }
  }

  return {
    status: 200,
    body: {
      success: true,
      product_id: normId,
      latest_ai_draft: latestDraft
        ? formatDraftRowForApiResponse(latestDraft)
        : null,
    },
  };
}

/**
 * Saves AI analysis selected images (`save_product_ai_selected_images`) to Supabase `public.products`
 * as primary store (`write_source = 'supabase'`), with Drive ownership + existence verification
 * and synchronous compatibility mirror to GAS (`product_ai_image_selections`) so GAS AI batch
 * continues to read the exact same selection.
 */
export async function saveProductAiSelectedImages({
  supabase,
  fetchImpl = globalThis.fetch,
  gasWebAppUrl,
  productId,
  payload = {},
}) {
  const normId = asTrimmedString(productId || payload?.product_id);
  if (!normId) {
    return {
      status: 200,
      body: {
        success: false,
        error_code: "PRODUCT_ID_REQUIRED",
        message: "product_id is required",
      },
    };
  }

  const rawSelected =
    payload?.selected_image_ids !== undefined
      ? payload.selected_image_ids
      : payload?.ai_selected_image_ids;
  if (rawSelected === undefined) {
    return {
      status: 200,
      body: {
        success: false,
        error_code: "INVALID_IMAGE_SELECTION",
        message:
          "selected_image_ids (array of Drive file IDs, or [] to clear) is required",
      },
    };
  }

  let normalizedIds;
  try {
    normalizedIds = validateSelectedImageIdsSyntax_(
      rawSelected === null ? [] : rawSelected,
      normId
    );
  } catch (synErr) {
    return {
      status: 200,
      body: {
        success: false,
        error_code: synErr.error_code || "INVALID_IMAGE_SELECTION",
        message: synErr.message || "Invalid selected_image_ids",
      },
    };
  }

  const bundle = await fetchProductBundleOrBackfill({
    supabase,
    fetchImpl,
    gasWebAppUrl,
    productId: normId,
  });
  if (!bundle) {
    return {
      status: 200,
      body: {
        success: false,
        error_code: "PRODUCT_NOT_FOUND",
        message: `Product not found: ${normId}`,
      },
    };
  }

  const productImages = getSortedProductImages(bundle);
  const imageById = new Map(
    productImages.map((img) => [asTrimmedString(img.file_id), img])
  );

  for (const sId of normalizedIds) {
    const meta = imageById.get(sId);
    if (!meta) {
      return {
        status: 200,
        body: {
          success: false,
          error_code: "INVALID_IMAGE_SELECTION",
          message: `Selected image ID '${sId}' does not belong to product ${normId} drive folder.`,
        },
      };
    }
    const mime = asTrimmedString(meta.mime_type).toLowerCase();
    const normMime = mime === "image/jpg" ? "image/jpeg" : mime;
    if (normMime && !AI_DRAFT_CONFIG.ALLOWED_MIME_TYPES.includes(normMime)) {
      return {
        status: 200,
        body: {
          success: false,
          error_code: "UNSUPPORTED_MIME_TYPE",
          message: `Unsupported image MIME type '${normMime}' in file: ${
            meta.name || sId
          }`,
        },
      };
    }
    // Verify the selected Drive file is still live (not deleted/trashed)
    try {
      await downloadDriveImageBytes({
        fetchImpl,
        fileId: sId,
        declaredMimeType: normMime || "image/jpeg",
        fileName: meta.name,
        productId: normId,
        isExplicitSelection: true,
      });
    } catch (dlErr) {
      if (dlErr instanceof AiDraftError) {
        return {
          status: 200,
          body: {
            success: false,
            error_code: dlErr.errorCode,
            message: dlErr.message,
          },
        };
      }
      throw dlErr;
    }
  }

  const nowIso = new Date().toISOString();
  const isDraftUnlinked =
    (asTrimmedString(bundle.publish_status) || "draft") === "draft" &&
    !hasAnySquareLink(bundle);
  const hadPriorPendingMirror = bundle.sheets_mirror_pending === true;

  const { error: updErr } = await supabase
    .from("products")
    .update({
      selected_image_ids: normalizedIds,
      ...(isDraftUnlinked
        ? {
            write_source: "supabase",
            supabase_written_at: nowIso,
            sheets_mirror_pending: Boolean(gasWebAppUrl),
          }
        : {}),
    })
    .eq("product_id", normId);
  if (updErr) {
    throw new Error(
      `Failed saving selected_image_ids in Supabase (${normId}): ${updErr.message}`
    );
  }

  let sheetsMirrored = false;
  if (gasWebAppUrl) {
    try {
      const gasRes = await fetchImpl(gasWebAppUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          action: "save_product_ai_selected_images",
          product_id: normId,
          selected_image_ids: normalizedIds,
        }),
      });
      if (gasRes.ok) {
        const gasJson = await gasRes.json().catch(() => null);
        if (gasJson && gasJson.success === true) {
          sheetsMirrored = true;
          if (isDraftUnlinked && !hadPriorPendingMirror) {
            await supabase
              .from("products")
              .update({
                sheets_mirror_pending: false,
                synced_from_sheets_at: new Date().toISOString(),
              })
              .eq("product_id", normId);
          }
        }
      }
    } catch (mirrorErr) {
      console.warn(
        JSON.stringify({
          severity: "WARNING",
          message: `Sheets save_product_ai_selected_images mirror deferred for ${normId}: ${
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
      write_master: "supabase",
      product_id: normId,
      selected_image_ids: normalizedIds,
      ai_selected_image_ids: normalizedIds,
      updated_at: nowIso,
      sheets_mirrored: sheetsMirrored,
    },
  };
}

/**
 * Replays any pending AI draft state (`ai_draft_flag = 'ai_managed'` + latest `product_ai_drafts`)
 * from Supabase -> Google Sheets during `flushPendingSupabaseDraftToSheets` (`reconciler` / `sync`).
 */
export async function flushPendingAiDraftStateToSheets({
  supabase,
  fetchImpl = globalThis.fetch,
  gasWebAppUrl,
  internalSecret = process.env.PRODUCTS_API_INTERNAL_SECRET,
  productRow,
}) {
  if (!gasWebAppUrl || !productRow) return true;
  const productId = asTrimmedString(productRow.product_id);
  if (asTrimmedString(productRow.ai_draft_flag) !== AI_DRAFT_CONFIG.FLAG_VALUE) {
    return true;
  }

  const latestDraft = await fetchLatestSupabaseAiDraft(supabase, productId);
  if (!latestDraft) {
    // Still ensure AN = "ai_managed" + selected_image_ids are mirrored
    const flagOnlyRes = await mirrorAiProductDraftStateToSheets({
      fetchImpl,
      gasWebAppUrl,
      internalSecret,
      payload: {
        product_id: productId,
        ai_draft_flag: AI_DRAFT_CONFIG.FLAG_VALUE,
        selected_image_ids: normalizeStringArray(productRow.selected_image_ids),
      },
    });
    return Boolean(flagOnlyRes.ok);
  }

  const isConfirmed =
    asTrimmedString(latestDraft.review_status) === "confirmed";
  const translationRow = pickEnglishTranslation(productRow);
  const pokemonRow = pickPokemonCard(productRow);

  const formattedLatest = formatDraftRowForApiResponse(latestDraft);
  const mirrorPayload = {
    product_id: productId,
    ai_draft_flag: AI_DRAFT_CONFIG.FLAG_VALUE,
    selected_image_ids: normalizeStringArray(productRow.selected_image_ids),
    apply_confirmed_product: isConfirmed,
    ...(isConfirmed
      ? buildConfirmedMirrorTopLevelFields(
          productRow,
          translationRow,
          pokemonRow
        )
      : {}),
    draft_record: {
      draft_id: asTrimmedString(latestDraft.draft_id),
      product_id: productId,
      draft_version: Number(latestDraft.draft_version || 1),
      review_status:
        asTrimmedString(latestDraft.review_status) || "pending_review",
      candidate_title_ja: asRawString(latestDraft.candidate_title_ja ?? ""),
      candidate_hashtags_ja: asRawString(
        latestDraft.candidate_hashtags_ja ?? ""
      ),
      candidate_description_ja: asRawString(
        latestDraft.candidate_description_ja ?? ""
      ),
      candidate_title_en: asRawString(latestDraft.candidate_title_en ?? ""),
      candidate_description_en: asRawString(
        latestDraft.candidate_description_en ?? ""
      ),
      candidate_condition: asTrimmedString(latestDraft.candidate_condition),
      candidate_price:
        latestDraft.candidate_price !== null &&
        latestDraft.candidate_price !== undefined
          ? latestDraft.candidate_price
          : "",
      candidate_category: asTrimmedString(latestDraft.candidate_category),
      candidate_brand: asTrimmedString(latestDraft.candidate_brand),
      candidate_sku: asTrimmedString(latestDraft.candidate_sku),
      candidate_size: asTrimmedString(latestDraft.candidate_size),
      candidate_price_basis: asTrimmedString(latestDraft.candidate_price_basis),
      candidate_price_note: asRawString(latestDraft.candidate_price_note ?? ""),
      candidate_sku_source: asTrimmedString(latestDraft.candidate_sku_source),
      source_fingerprint: asTrimmedString(latestDraft.source_fingerprint),
      source_image_fingerprint: asTrimmedString(
        latestDraft.source_image_fingerprint
      ),
      confirmed_fingerprint: asTrimmedString(latestDraft.confirmed_fingerprint),
      source_image_ids: Array.isArray(latestDraft.source_image_ids)
        ? latestDraft.source_image_ids.join(",")
        : asTrimmedString(latestDraft.source_image_ids),
      model_name: asTrimmedString(latestDraft.model_name),
      generated_at: latestDraft.generated_at
        ? String(latestDraft.generated_at)
        : new Date().toISOString(),
      confirmed_at: latestDraft.confirmed_at
        ? String(latestDraft.confirmed_at)
        : "",
      confirmed_by: asTrimmedString(latestDraft.confirmed_by),
      last_confirmation_attempt_id: asTrimmedString(
        latestDraft.last_confirmation_attempt_id
      ),
      last_confirmation_payload_hash: asTrimmedString(
        latestDraft.last_confirmation_payload_hash
      ),
      search_grounding_enabled: latestDraft.search_grounding_enabled
        ? "true"
        : "false",
      search_grounding_mode: asTrimmedString(latestDraft.search_grounding_mode),
      search_executed: latestDraft.search_executed ? "true" : "false",
      search_queries: formattedLatest?.search_queries ?? "",
      search_sources_count: formattedLatest?.search_sources_count ?? 0,
      search_queries_count: formattedLatest?.search_queries_count ?? 0,
      stage_a_elapsed_ms: formattedLatest?.stage_a_elapsed_ms ?? 0,
      stage_b_elapsed_ms: formattedLatest?.stage_b_elapsed_ms ?? 0,
      search_total_elapsed_ms: formattedLatest?.search_total_elapsed_ms ?? 0,
      search_finish_reason: formattedLatest?.search_finish_reason ?? "",
      search_tokens_json: formattedLatest?.search_tokens_json ?? "",
    },
  };

  const res = await mirrorAiProductDraftStateToSheets({
    fetchImpl,
    gasWebAppUrl,
    internalSecret,
    payload: mirrorPayload,
  });
  if (!res.ok) return false;
  if (isConfirmed && res.confirmedFingerprint) {
    await supabase
      .from("product_ai_drafts")
      .update({
        confirmed_fingerprint: res.confirmedFingerprint,
        updated_at: new Date().toISOString(),
      })
      .eq("draft_id", asTrimmedString(latestDraft.draft_id));
  }
  return true;
}
