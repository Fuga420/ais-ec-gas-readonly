import crypto from "node:crypto";
import { asRawString, asTrimmedString, normalizeStringArray, toNullableNumber } from "./productMapper.mjs";
import { hasAnySquareLink } from "./productWriter.mjs";
import {
  AI_DRAFT_CONFIG,
  ceilPriceByPolicy_,
  resolveAiDraftModelName,
  validateLegacyGrossMarginRateIfPresent_,
  validateMinCostMarkupRateInput_,
  validateSelectedImageIdsSyntax_,
} from "./aiDraftEngine.mjs";
import {
  AiDraftError,
  executeSingleProductAiDraft,
  fetchLatestSupabaseAiDraft,
  fetchProductBundleOrBackfill,
  fetchProductCostFromDocumentsRelay,
  mirrorAiProductDraftStateToSheets,
} from "./aiDraftService.mjs";

export const AI_BATCH_QUEUE_CONFIG = Object.freeze({
  MAX_MANUAL_BATCH_SIZE: 500,
  DEFAULT_CONCURRENCY: 2,
  MAX_ALLOWED_CONCURRENCY: 8,
  LEASE_SECONDS: 300,
  MAX_RETRIES: 3,
  RETRY_BACKOFF_MS: 60 * 1000,
  WORKER_TIME_BUDGET_MS: 180 * 1000,
  COST_LOOKUP_CONCURRENCY: 12,
  COST_LOOKUP_BATCH_TIME_BUDGET_MS: 45 * 1000,
  COST_LOOKUP_CIRCUIT_BREAKER_THRESHOLD: 8,
  DISPATCH_HEADSTART_MS: 250,
});

export const AI_BATCH_SCHEDULE_CONFIG = Object.freeze({
  MAX_SCHEDULE_SIZE: 500,
  DISPATCH_LEASE_SECONDS: 180,
  DISPATCH_TIME_BUDGET_MS: 90 * 1000,
  MAX_DISPATCH_RETRIES: 5,
  DISPATCH_RETRY_BACKOFF_MS: 60 * 1000,
  DEFAULT_LIST_LIMIT: 10,
  MAX_LIST_LIMIT: 30,
  PAST_TOLERANCE_MS: 5 * 60 * 1000,
});

const ALLOWED_JOB_SOURCES = new Set(["manual", "scheduled_nightly", "api"]);

export function formatJstDateKey(nowInput = new Date()) {
  const dateObj = nowInput instanceof Date ? nowInput : new Date(nowInput);
  const ms = dateObj.getTime();
  if (!Number.isFinite(ms)) {
    throw new AiDraftError(
      "INVALID_TIMESTAMP",
      "Invalid timestamp for JST date calculation",
      { status: 400 }
    );
  }
  // Asia/Tokyo is fixed UTC+09:00 (no DST)
  return new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

export function formatJstDateTimeDisplay(dateInput) {
  const str = asTrimmedString(dateInput);
  if (!str && !(dateInput instanceof Date)) return null;
  const dateObj = dateInput instanceof Date ? dateInput : new Date(str);
  const ms = dateObj.getTime();
  if (!Number.isFinite(ms)) return null;
  const jstIso = new Date(ms + 9 * 3600 * 1000).toISOString();
  // YYYY-MM-DDTHH:mm:ss.sssZ -> YYYY/MM/DD HH:mm（日本時間）
  const datePart = jstIso.slice(0, 10).replace(/-/g, "/");
  const timePart = jstIso.slice(11, 16);
  return `${datePart} ${timePart}（日本時間）`;
}

export function resolveAiBatchConcurrency(explicitConcurrency) {
  const raw =
    explicitConcurrency !== undefined && explicitConcurrency !== null
      ? Number(explicitConcurrency)
      : Number(process.env.AI_BATCH_CONCURRENCY || AI_BATCH_QUEUE_CONFIG.DEFAULT_CONCURRENCY);
  if (!Number.isFinite(raw) || raw < 1) {
    return AI_BATCH_QUEUE_CONFIG.DEFAULT_CONCURRENCY;
  }
  return Math.min(
    AI_BATCH_QUEUE_CONFIG.MAX_ALLOWED_CONCURRENCY,
    Math.max(1, Math.trunc(raw))
  );
}

export function resolveMaxManualBatchSize(explicitMax) {
  const raw =
    explicitMax !== undefined && explicitMax !== null
      ? Number(explicitMax)
      : Number(
          process.env.AI_BATCH_MAX_MANUAL_ITEMS ||
            AI_BATCH_QUEUE_CONFIG.MAX_MANUAL_BATCH_SIZE
        );
  if (!Number.isFinite(raw) || raw < 1) {
    return AI_BATCH_QUEUE_CONFIG.MAX_MANUAL_BATCH_SIZE;
  }
  return Math.max(1, Math.trunc(raw));
}

export function isTransientAiBatchError(err) {
  if (!err) return false;
  const code = asTrimmedString(err.error_code || err.errorCode);
  if (code === "LLM_COMMUNICATION_FAILED") return true;
  if (code.startsWith("LLM_HTTP_ERROR_")) {
    const status = Number(code.replace("LLM_HTTP_ERROR_", ""));
    if (status === 429 || (status >= 500 && status <= 599)) {
      return true;
    }
  }
  const statusCode = Number(err.status_code || err.statusCode || 0);
  if (statusCode === 429 || (statusCode >= 500 && statusCode <= 599)) {
    return true;
  }
  return false;
}

export function isRateLimitedAiBatchError(err) {
  if (!err) return false;
  const code = asTrimmedString(err.error_code || err.errorCode);
  const statusCode = Number(err.status_code || err.statusCode || 0);
  return code === "LLM_HTTP_ERROR_429" || statusCode === 429;
}

async function mapWithConcurrency(items, concurrency, worker) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const results = new Array(items.length);
  let cursor = 0;
  const limit = Math.max(1, Math.min(concurrency, items.length));
  async function runner() {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await worker(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: limit }, () => runner()));
  return results;
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function generateBatchId() {
  return `BATCH_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
}

function normalizeCostEntry(entry, productId) {
  if (entry === null || entry === undefined) return null;
  if (typeof entry !== "object" || Array.isArray(entry)) {
    throw new AiDraftError(
      "INVALID_PRODUCT_COSTS",
      `product_costs['${productId}'] must be an object or null`
    );
  }
  const explicitStatus = asTrimmedString(entry.cost_status || entry.costStatus).toLowerCase();
  if (explicitStatus === "lookup_failed" || entry.cost_lookup_failed === true) {
    return {
      cost_status: "lookup_failed",
      cost_breakdown: null,
      links: [],
      cost_lookup_error:
        asTrimmedString(entry.cost_lookup_error || entry.costLookupError) ||
        "documents-relay lookup failed",
      cost_fetch_failed_at:
        asTrimmedString(entry.cost_fetch_failed_at) || new Date().toISOString(),
    };
  }
  const breakdown =
    entry.cost_breakdown !== undefined ? entry.cost_breakdown : entry;
  if (breakdown === null || breakdown === undefined) {
    return null;
  }
  if (typeof breakdown !== "object" || Array.isArray(breakdown)) {
    throw new AiDraftError(
      "INVALID_PRODUCT_COSTS",
      `product_costs['${productId}'].cost_breakdown must be an object or null`
    );
  }
  const rawTotal = breakdown.total_allocated_cost;
  if (rawTotal === null || rawTotal === undefined || rawTotal === "") {
    return null;
  }
  const numTotal = Number(rawTotal);
  if (typeof rawTotal === "boolean" || !Number.isFinite(numTotal) || numTotal < 0) {
    throw new AiDraftError(
      "INVALID_PRODUCT_COSTS",
      `product_costs['${productId}'].total_allocated_cost must be a non-negative finite number`
    );
  }
  if (numTotal === 0) {
    return null;
  }
  return {
    cost_status: "confirmed",
    cost_breakdown: breakdown,
    ...(Array.isArray(entry.links) ? { links: entry.links } : {}),
  };
}

function validateInternalProductCostsMap(rawMap, allowedProductIds) {
  if (rawMap === undefined || rawMap === null) return {};
  if (typeof rawMap !== "object" || Array.isArray(rawMap)) {
    throw new AiDraftError(
      "INVALID_PRODUCT_COSTS",
      "product_costs must be an object keyed by product_id"
    );
  }
  const allowedSet = new Set(allowedProductIds);
  const normalized = {};
  for (const [k, val] of Object.entries(rawMap)) {
    const pid = asTrimmedString(k);
    if (!pid || !allowedSet.has(pid)) continue;
    normalized[pid] = normalizeCostEntry(val, pid);
  }
  return normalized;
}

function buildLookupFailedCostEntry(errorReason) {
  return {
    cost_status: "lookup_failed",
    cost_breakdown: null,
    links: [],
    cost_lookup_error:
      asTrimmedString(errorReason) || "documents-relay lookup failed",
    cost_fetch_failed_at: new Date().toISOString(),
  };
}

export async function resolveConfirmedProductCostsForBatch({
  fetchImpl = globalThis.fetch,
  readdyBackendUrl = process.env.READDY_BACKEND_URL,
  readdyBackendAnonKey = process.env.READDY_BACKEND_ANON_KEY,
  callerAuthHeaders = {},
  actorType = "staff",
  rawInternalProductCosts,
  requireServerCostLookup = false,
  productIds,
  batchTimeBudgetMs = AI_BATCH_QUEUE_CONFIG.COST_LOOKUP_BATCH_TIME_BUDGET_MS,
}) {
  if (
    !requireServerCostLookup &&
    actorType === "internal" &&
    rawInternalProductCosts !== undefined
  ) {
    return validateInternalProductCostsMap(rawInternalProductCosts, productIds);
  }

  const baseUrl = asTrimmedString(readdyBackendUrl).replace(/\/+$/, "");
  if (!baseUrl) {
    if (requireServerCostLookup) {
      const missingUrlMap = {};
      for (const pid of productIds) {
        missingUrlMap[pid] = buildLookupFailedCostEntry(
          "READDY_BACKEND_URL is not configured"
        );
      }
      return missingUrlMap;
    }
    // Local / isolated test environment without Readdy Backend configured
    return {};
  }

  const cleanServerAnonKey = asTrimmedString(readdyBackendAnonKey);
  const authorizationHeader =
    asTrimmedString(callerAuthHeaders?.authorization) ||
    (cleanServerAnonKey ? `Bearer ${cleanServerAnonKey}` : "");
  const apikeyHeader =
    asTrimmedString(callerAuthHeaders?.apikey) || cleanServerAnonKey;

  if (!authorizationHeader) {
    const missingAuthMap = {};
    for (const pid of productIds) {
      missingAuthMap[pid] = buildLookupFailedCostEntry(
        "Missing authorization for documents-relay cost lookup"
      );
    }
    return missingAuthMap;
  }

  const resolvedMap = {};
  const startWallMs = Date.now();
  const effectiveBudgetMs =
    Number.isFinite(Number(batchTimeBudgetMs)) && Number(batchTimeBudgetMs) > 0
      ? Number(batchTimeBudgetMs)
      : AI_BATCH_QUEUE_CONFIG.COST_LOOKUP_BATCH_TIME_BUDGET_MS;
  let consecutiveFailures = 0;
  let anySuccess = false;
  let circuitOpen = false;

  const lookupOne = async (pid) => {
    if (circuitOpen) {
      resolvedMap[pid] = buildLookupFailedCostEntry(
        "Skipped cost lookup because documents-relay endpoint is temporarily unavailable"
      );
      return;
    }
    if (Date.now() - startWallMs >= effectiveBudgetMs) {
      resolvedMap[pid] = buildLookupFailedCostEntry(
        `Cost lookup batch time budget (${effectiveBudgetMs}ms) reached`
      );
      return;
    }
    try {
      const lookup = await fetchProductCostFromDocumentsRelay({
        fetchImpl,
        readdyBackendUrl: baseUrl,
        authorizationHeader,
        apikeyHeader,
        productId: pid,
      });
      if (!lookup.resolved) {
        consecutiveFailures += 1;
        if (
          !anySuccess &&
          consecutiveFailures >=
            AI_BATCH_QUEUE_CONFIG.COST_LOOKUP_CIRCUIT_BREAKER_THRESHOLD
        ) {
          circuitOpen = true;
        }
        resolvedMap[pid] = buildLookupFailedCostEntry(
          lookup.error || "documents-relay lookup failed"
        );
        return;
      }
      anySuccess = true;
      consecutiveFailures = 0;
      resolvedMap[pid] = lookup.productCost
        ? normalizeCostEntry(lookup.productCost, pid)
        : null;
    } catch (err) {
      consecutiveFailures += 1;
      if (
        !anySuccess &&
        consecutiveFailures >=
          AI_BATCH_QUEUE_CONFIG.COST_LOOKUP_CIRCUIT_BREAKER_THRESHOLD
      ) {
        circuitOpen = true;
      }
      resolvedMap[pid] = buildLookupFailedCostEntry(
        err?.message || "documents-relay lookup threw an error"
      );
    }
  };

  // Warm up `documents-relay` Edge Function isolate with 1 item first on large batches (>=20 items)
  // before fanning out concurrently, preventing simultaneous cold-start bursts.
  const remainingIds =
    productIds.length >= 20 ? productIds.slice(1) : productIds;
  if (productIds.length >= 20) {
    await lookupOne(productIds[0]);
  }
  await mapWithConcurrency(
    remainingIds,
    AI_BATCH_QUEUE_CONFIG.COST_LOOKUP_CONCURRENCY,
    lookupOne
  );
  return resolvedMap;
}

function buildPricingSummary(minCostMarkupRate, productIds, productCostsJson) {
  const rate =
    Number.isFinite(Number(minCostMarkupRate)) &&
    Number(minCostMarkupRate) > 0 &&
    Number(minCostMarkupRate) < 1
      ? Number(minCostMarkupRate)
      : AI_DRAFT_CONFIG.DEFAULT_MIN_COST_MARKUP_RATE;
  const divisor = Math.round((1 - rate) * 1000000) / 1000000;
  const costsObj =
    productCostsJson && typeof productCostsJson === "object" && !Array.isArray(productCostsJson)
      ? productCostsJson
      : {};
  const byProduct = {};
  const costFetchFailedProductIds = [];
  for (const pid of productIds) {
    const entry = costsObj[pid];
    const explicitStatus = asTrimmedString(
      entry?.cost_status || entry?.costStatus
    ).toLowerCase();
    if (explicitStatus === "lookup_failed" || entry?.cost_lookup_failed === true) {
      costFetchFailedProductIds.push(pid);
      byProduct[pid] = {
        cost_source: "lookup_failed",
        cost_status: "lookup_failed",
        total_allocated_cost: null,
        cost_floor_price: null,
        cost_lookup_error:
          asTrimmedString(entry?.cost_lookup_error || entry?.costLookupError) ||
          null,
      };
      continue;
    }
    const bd = entry?.cost_breakdown ?? entry;
    const total = toNullableNumber(bd?.total_allocated_cost);
    if (total !== null && total > 0) {
      const rawFloor = divisor > 0 ? Math.round((total / divisor) * 1e6) / 1e6 : total;
      byProduct[pid] = {
        cost_source: "confirmed_AllocatedCost",
        cost_status: "confirmed",
        total_allocated_cost: total,
        cost_floor_price: ceilPriceByPolicy_(rawFloor),
      };
    } else {
      byProduct[pid] = {
        cost_source: "none",
        cost_status: "no_cost",
        total_allocated_cost: null,
        cost_floor_price: null,
      };
    }
  }
  return {
    pricing_rule: "gross_margin_floor",
    min_gross_margin_rate: rate,
    min_cost_markup_rate: rate,
    gross_margin_divisor: Math.round((1 - rate) * 10000) / 10000,
    product_costs_by_product: byProduct,
    cost_fetch_failed_product_ids: costFetchFailedProductIds,
    cost_fetch_failed_count: costFetchFailedProductIds.length,
  };
}

function formatIsoOrNull(val) {
  const str = asTrimmedString(val);
  return str || null;
}

function formatBatchCreateResponse(jobRow, isReused) {
  const rate = Number(
    jobRow.min_cost_markup_rate ?? AI_DRAFT_CONFIG.DEFAULT_MIN_COST_MARKUP_RATE
  );
  const costsObj =
    jobRow.product_costs_json &&
    typeof jobRow.product_costs_json === "object" &&
    !Array.isArray(jobRow.product_costs_json)
      ? jobRow.product_costs_json
      : {};
  const costFetchFailedProductIds = Object.keys(costsObj).filter((pid) => {
    const entry = costsObj[pid];
    const st = asTrimmedString(entry?.cost_status || entry?.costStatus).toLowerCase();
    return st === "lookup_failed" || entry?.cost_lookup_failed === true;
  });
  return {
    success: true,
    write_master: "supabase",
    batch_id: asTrimmedString(jobRow.batch_id),
    request_id: asTrimmedString(jobRow.request_id),
    job_source: asTrimmedString(jobRow.job_source) || "manual",
    status: asTrimmedString(jobRow.status) || "queued",
    total_count: Number(jobRow.total_count || 0),
    is_reused: Boolean(isReused),
    force_regenerate: Boolean(jobRow.force_regenerate),
    test_only: Boolean(jobRow.test_only),
    created_at: asTrimmedString(jobRow.created_at),
    pricing_rule: "gross_margin_floor",
    min_gross_margin_rate: rate,
    min_cost_markup_rate: rate,
    gross_margin_divisor: Math.round((1 - rate) * 10000) / 10000,
    cost_fetch_failed_product_ids: costFetchFailedProductIds,
    cost_fetch_failed_count: costFetchFailedProductIds.length,
  };
}

function formatBatchProgressResponse(jobRow, itemRows, productNamesMap = {}) {
  const orderedItems = [...(itemRows || [])].sort(
    (a, b) => Number(a.item_index || 0) - Number(b.item_index || 0)
  );
  const productIds = orderedItems.map((it) => asTrimmedString(it.product_id));
  const pricing = buildPricingSummary(
    jobRow.min_cost_markup_rate,
    productIds,
    jobRow.product_costs_json
  );

  const items = orderedItems.map((row) => {
    const pid = asTrimmedString(row.product_id);
    const draftVer = toNullableNumber(row.draft_version);
    const propPrice = toNullableNumber(row.proposed_price);
    const selectedIds = normalizeStringArray(row.selected_image_ids);
    const sourceIds = normalizeStringArray(row.source_image_ids);
    const resolvedName = asTrimmedString(productNamesMap?.[pid]);
    return {
      product_id: pid,
      product_name: resolvedName || "（商品名なし）",
      status: asTrimmedString(row.status) || "pending",
      draft_id: asTrimmedString(row.draft_id) || null,
      draft_version: draftVer !== null ? Math.trunc(draftVer) : null,
      model_name: asTrimmedString(row.model_name) || null,
      proposed_price: propPrice !== null && propPrice > 0 ? Math.trunc(propPrice) : null,
      price_basis: asTrimmedString(row.price_basis) || null,
      price_note: asRawString(row.price_note ?? "").trim() || null,
      error_code: asTrimmedString(row.error_code) || null,
      error_message: asTrimmedString(row.error_message) || null,
      retry_count: Number(row.retry_count || 0),
      selected_image_ids: selectedIds,
      source_image_ids: sourceIds,
    };
  });

  const totalCount = Number(jobRow.total_count || 0);
  const completedCount = Number(jobRow.completed_count || 0);
  const failedCount = Number(jobRow.failed_count || 0);
  const processingCount = Number(jobRow.processing_count || 0);
  const pendingCount = Math.max(
    0,
    totalCount - completedCount - failedCount - processingCount
  );

  return {
    success: true,
    write_master: "supabase",
    batch_id: asTrimmedString(jobRow.batch_id),
    request_id: asTrimmedString(jobRow.request_id),
    job_source: asTrimmedString(jobRow.job_source) || "manual",
    status: asTrimmedString(jobRow.status) || "queued",
    total_count: totalCount,
    completed_count: completedCount,
    failed_count: failedCount,
    processing_count: processingCount,
    pending_count: pendingCount,
    force_regenerate: Boolean(jobRow.force_regenerate),
    test_only: Boolean(jobRow.test_only),
    created_at: asTrimmedString(jobRow.created_at),
    created_at_jst: formatJstDateTimeDisplay(jobRow.created_at),
    updated_at: asTrimmedString(jobRow.updated_at),
    completed_at: formatIsoOrNull(jobRow.completed_at),
    pricing_rule: pricing.pricing_rule,
    min_cost_markup_rate: pricing.min_cost_markup_rate,
    min_gross_margin_rate: pricing.min_gross_margin_rate,
    gross_margin_divisor: pricing.gross_margin_divisor,
    product_costs_by_product: pricing.product_costs_by_product,
    cost_fetch_failed_product_ids: pricing.cost_fetch_failed_product_ids,
    cost_fetch_failed_count: pricing.cost_fetch_failed_count,
    items,
  };
}

/**
 * Hydrates display titles per `product_id` from `public.products` + `product_translations`
 * so any device (without originating browser `localStorage`) sees accurate product names.
 */
async function resolveProductDisplayTitlesMap(
  supabase,
  productIds,
  fallbackNamesMap = {}
) {
  const uniqueIds = [
    ...new Set((productIds || []).map((id) => asTrimmedString(id)).filter(Boolean)),
  ];
  const result = {};
  if (uniqueIds.length === 0) return result;

  const rowById = new Map();
  const chunkSize = 200;
  for (let i = 0; i < uniqueIds.length; i += chunkSize) {
    const chunk = uniqueIds.slice(i, i + chunkSize);
    const { data, error } = await supabase
      .from("products")
      .select(
        "product_id, category, product_name, product_translations(locale, translated_title)"
      )
      .in("product_id", chunk);
    if (error) {
      throw new Error(
        `Failed reading product display titles: ${error.message}`
      );
    }
    for (const r of data || []) {
      rowById.set(asTrimmedString(r.product_id), r);
    }
  }

  for (const pid of uniqueIds) {
    const row = rowById.get(pid);
    let translatedTitle = "";
    if (row?.product_translations) {
      const transList = Array.isArray(row.product_translations)
        ? row.product_translations
        : [row.product_translations];
      const enRow =
        transList.find((t) => asTrimmedString(t?.locale || "en") === "en") ||
        transList[0];
      translatedTitle = asTrimmedString(enRow?.translated_title);
    }
    const cat = asTrimmedString(row?.category);
    const prodName = asTrimmedString(row?.product_name);
    const fb = asTrimmedString(fallbackNamesMap?.[pid]);
    const nonIdFallback = fb && fb !== pid ? fb : "";

    if (cat === "sneaker" && translatedTitle) {
      result[pid] = translatedTitle;
    } else if (prodName) {
      result[pid] = prodName;
    } else if (translatedTitle) {
      result[pid] = translatedTitle;
    } else if (nonIdFallback) {
      result[pid] = nonIdFallback;
    } else {
      result[pid] = "（商品名なし）";
    }
  }

  return result;
}

/**
 * Checks whether any of `productIds` are currently active in another AI batch job or reservation:
 * - Scheduled reservation waiting/starting (`ai_batch_schedules.status IN ('scheduled', 'starting', 'dispatch_retry')` and `batch_id IS NULL`)
 * - Batch queue item waiting/running (`ai_batch_items.status IN ('pending', 'processing')`)
 *
 * Completed, partially_failed, failed, cancelled, and completed_all_excluded jobs NEVER block
 * intentional regeneration after completion.
 */
export async function findActiveAiBatchProductConflicts(
  supabase,
  productIds,
  { ignoreScheduleId = null, ignoreBatchId = null } = {}
) {
  const orderedIds = [];
  const seen = new Set();
  for (const rawId of productIds || []) {
    const pid = asTrimmedString(rawId);
    if (pid && !seen.has(pid)) {
      seen.add(pid);
      orderedIds.push(pid);
    }
  }
  if (orderedIds.length === 0) {
    return {
      has_conflict: false,
      conflicting_product_ids: [],
      conflicts: [],
    };
  }

  const normIgnoreSched = asTrimmedString(ignoreScheduleId);
  const normIgnoreBatch = asTrimmedString(ignoreBatchId);

  const itemConflictByPid = new Map();
  const chunkSize = 200;
  for (let i = 0; i < orderedIds.length; i += chunkSize) {
    const chunk = orderedIds.slice(i, i + chunkSize);
    const { data: activeItems, error: itemErr } = await supabase
      .from("ai_batch_items")
      .select("product_id, batch_id, status")
      .in("product_id", chunk)
      .in("status", ["pending", "processing"]);
    if (itemErr) {
      throw new Error(
        `Failed checking active ai_batch_items conflicts: ${itemErr.message}`
      );
    }
    for (const row of activeItems || []) {
      const bId = asTrimmedString(row.batch_id);
      if (normIgnoreBatch && bId === normIgnoreBatch) continue;
      const pid = asTrimmedString(row.product_id);
      const st = asTrimmedString(row.status) || "pending";
      const prev = itemConflictByPid.get(pid);
      if (!prev || (prev.active_state !== "processing" && st === "processing")) {
        itemConflictByPid.set(pid, {
          active_state: st,
          batch_id: bId || null,
          schedule_id: null,
        });
      }
    }
  }

  const { data: activeSchedules, error: schedErr } = await supabase
    .from("ai_batch_schedules")
    .select("schedule_id, status, batch_id, scheduled_at, product_ids")
    .in("status", ["scheduled", "starting", "dispatch_retry"]);
  if (schedErr) {
    throw new Error(
      `Failed checking active ai_batch_schedules conflicts: ${schedErr.message}`
    );
  }

  const schedConflictByPid = new Map();
  for (const sRow of activeSchedules || []) {
    const sId = asTrimmedString(sRow.schedule_id);
    if (normIgnoreSched && sId === normIgnoreSched) continue;
    if (asTrimmedString(sRow.batch_id)) continue;
    const pList = normalizeStringArray(sRow.product_ids);
    for (const pid of pList) {
      if (seen.has(pid) && !schedConflictByPid.has(pid)) {
        schedConflictByPid.set(pid, {
          active_state: "scheduled",
          schedule_id: sId || null,
          batch_id: null,
        });
      }
    }
  }

  const conflictingProductIds = [];
  const conflicts = [];
  for (const pid of orderedIds) {
    const hit = itemConflictByPid.get(pid) || schedConflictByPid.get(pid);
    if (hit) {
      conflictingProductIds.push(pid);
      conflicts.push({
        product_id: pid,
        active_state: hit.active_state,
        schedule_id: hit.schedule_id,
        batch_id: hit.batch_id,
      });
    }
  }

  return {
    has_conflict: conflictingProductIds.length > 0,
    conflicting_product_ids: conflictingProductIds,
    conflicts,
  };
}

function buildActiveProductConflictResponse(conflictData) {
  const ids = Array.isArray(conflictData?.conflicting_product_ids)
    ? conflictData.conflicting_product_ids
    : [];
  const conflicts = Array.isArray(conflictData?.conflicts)
    ? conflictData.conflicts
    : ids.map((pid) => ({
        product_id: pid,
        active_state: "active",
        schedule_id: null,
        batch_id: null,
      }));
  const displayIds =
    ids.length <= 20
      ? ids.join(", ")
      : `${ids.slice(0, 20).join(", ")} ほか${ids.length - 20}件`;
  return {
    status: 409,
    body: {
      success: false,
      error_code: "PRODUCT_ALREADY_IN_ACTIVE_AI_BATCH",
      conflicting_product_ids: ids,
      conflicts,
      error: `Products already in active AI batch or schedule: ${ids.join(", ")}`,
      message: `予約中・処理待ち・処理中の商品が含まれているため受付できません（重複商品ID: ${displayIds}）。完了または予約取消の後に実行してください。`,
    },
  };
}

function extractDbActiveConflictIds(errOrMessage) {
  const msg =
    typeof errOrMessage === "string"
      ? errOrMessage
      : errOrMessage?.message ?? "";
  const raw = asTrimmedString(msg);
  const marker = "PRODUCT_ALREADY_IN_ACTIVE_AI_BATCH";
  const idx = raw.indexOf(marker);
  if (idx < 0) return null;
  const after = raw.slice(idx + marker.length).replace(/^:\s*/, "");
  const firstLine = after.split(/\r?\n/)[0].trim();
  return firstLine
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseDbActiveConflictError(errOrMessage) {
  const ids = extractDbActiveConflictIds(errOrMessage);
  if (!ids) return null;
  return buildActiveProductConflictResponse({
    conflicting_product_ids: ids,
    conflicts: ids.map((pid) => ({
      product_id: pid,
      active_state: "active",
      schedule_id: null,
      batch_id: null,
    })),
  });
}

/**
 * Checks whether any queue items are immediately runnable (`pending` with due `next_retry_at`
 * or `processing` with expired `lease_expires_at`).
 */
export async function hasRunnableAiBatchQueueItems(supabase) {
  const nowIso = new Date().toISOString();
  const { data: pendingRows, error: pErr } = await supabase
    .from("ai_batch_items")
    .select("id, next_retry_at")
    .eq("status", "pending")
    .limit(20);
  if (!pErr && Array.isArray(pendingRows)) {
    const nowMs = Date.now();
    for (const r of pendingRows) {
      const nextStr = asTrimmedString(r.next_retry_at);
      if (!nextStr || new Date(nextStr).getTime() <= nowMs) {
        return true;
      }
    }
  }

  const { data: expiredRows, error: eErr } = await supabase
    .from("ai_batch_items")
    .select("id")
    .eq("status", "processing")
    .lte("lease_expires_at", nowIso)
    .limit(1);
  if (!eErr && Array.isArray(expiredRows) && expiredRows.length > 0) {
    return true;
  }

  return false;
}

/**
 * Resolves per-product `selected_image_ids` snapshot at batch creation time:
 * - If caller explicitly passed `selected_image_ids_by_product[pid]`, validates syntax + folder membership strictly.
 * - Otherwise snapshots saved `products.selected_image_ids` from Supabase (if non-empty).
 */
async function resolveBatchSelectedImageSnapshot({
  supabase,
  fetchImpl,
  gasWebAppUrl,
  productIds,
  explicitByProduct,
}) {
  let explicitMap = null;
  if (explicitByProduct !== undefined && explicitByProduct !== null) {
    if (typeof explicitByProduct !== "object" || Array.isArray(explicitByProduct)) {
      throw new AiDraftError(
        "INVALID_IMAGE_SELECTION",
        "selected_image_ids_by_product must be an object mapping product_id to string[]"
      );
    }
    explicitMap = explicitByProduct;
  }

  const existingBundleById = new Map();
  const chunkSize = 200;
  for (let i = 0; i < productIds.length; i += chunkSize) {
    const chunk = productIds.slice(i, i + chunkSize);
    const { data, error } = await supabase
      .from("products")
      .select("product_id, selected_image_ids, product_images(file_id)")
      .in("product_id", chunk);
    if (error) {
      throw new Error(`Failed reading products for batch image snapshot: ${error.message}`);
    }
    for (const row of data || []) {
      existingBundleById.set(asTrimmedString(row.product_id), row);
    }
  }

  const snapshot = {};
  for (const pid of productIds) {
    const hasExplicit =
      explicitMap !== null &&
      Object.prototype.hasOwnProperty.call(explicitMap, pid);
    if (hasExplicit) {
      let normalizedIds;
      try {
        normalizedIds = validateSelectedImageIdsSyntax_(explicitMap[pid], pid);
      } catch (synErr) {
        throw new AiDraftError(
          synErr.error_code || "INVALID_IMAGE_SELECTION",
          synErr.message
        );
      }
      if (normalizedIds.length > 0) {
        let prodRow = existingBundleById.get(pid);
        if (!prodRow) {
          prodRow = await fetchProductBundleOrBackfill({
            supabase,
            fetchImpl,
            gasWebAppUrl,
            productId: pid,
          });
        }
        if (!prodRow) {
          throw new AiDraftError(
            "PRODUCT_NOT_FOUND",
            `Product not found: ${pid}`
          );
        }
        const ownedSet = new Set(
          (Array.isArray(prodRow.product_images) ? prodRow.product_images : []).map((im) =>
            asTrimmedString(im.file_id)
          )
        );
        for (const sId of normalizedIds) {
          if (!ownedSet.has(sId)) {
            throw new AiDraftError(
              "INVALID_IMAGE_SELECTION",
              `Selected image ID '${sId}' does not belong to product ${pid} drive folder.`
            );
          }
        }
        snapshot[pid] = normalizedIds;
      }
      continue;
    }

    const existingRow = existingBundleById.get(pid);
    if (existingRow) {
      const savedIds = normalizeStringArray(existingRow.selected_image_ids);
      if (savedIds.length > 0) {
        snapshot[pid] = savedIds;
      }
    }
  }

  return snapshot;
}

/**
 * Enqueues a manual (or future `scheduled_nightly`) AI draft generation batch into Supabase.
 * - No 20-item ceiling (accepts >20 items in a single batch).
 * - Idempotent on `request_id` (`is_reused: true` on duplicate submission).
 * - Resolves confirmed purchase costs server-side via `documents-relay` (fail-closed on lookup failure).
 */
export async function createAiProductDraftBatch({
  supabase,
  fetchImpl = globalThis.fetch,
  gasWebAppUrl,
  readdyBackendUrl = process.env.READDY_BACKEND_URL,
  readdyBackendAnonKey = process.env.READDY_BACKEND_ANON_KEY,
  callerAuthHeaders = {},
  actorType = "staff",
  payload = {},
  maxBatchSize,
  requireServerCostLookup = false,
  ignoreScheduleId = null,
  triggerWorker,
}) {
  try {
    const requestId = asTrimmedString(payload?.request_id);
    if (!requestId) {
      return {
        status: 200,
        body: {
          success: false,
          error_code: "REQUEST_ID_REQUIRED",
          message: "request_id is required for idempotent batch creation",
        },
      };
    }

    const rawProductIds = payload?.product_ids;
    if (!Array.isArray(rawProductIds) || rawProductIds.length === 0) {
      return {
        status: 200,
        body: {
          success: false,
          error_code: "INVALID_PRODUCT_IDS",
          message: "product_ids must be a non-empty array",
        },
      };
    }

    const uniqueProductIds = [];
    const seen = new Set();
    for (const rawId of rawProductIds) {
      const pid = asTrimmedString(rawId);
      if (pid && !seen.has(pid)) {
        seen.add(pid);
        uniqueProductIds.push(pid);
      }
    }

    if (uniqueProductIds.length === 0) {
      return {
        status: 200,
        body: {
          success: false,
          error_code: "INVALID_PRODUCT_IDS",
          message: "No valid product_ids provided",
        },
      };
    }

    const effectiveMaxSize = resolveMaxManualBatchSize(maxBatchSize);
    if (uniqueProductIds.length > effectiveMaxSize) {
      return {
        status: 200,
        body: {
          success: false,
          error_code: "BATCH_SIZE_EXCEEDED",
          message: `Maximum batch size is ${effectiveMaxSize} (received ${uniqueProductIds.length})`,
        },
      };
    }

    validateLegacyGrossMarginRateIfPresent_(payload?.min_gross_margin_rate);
    const rawMarkupRate =
      payload?.min_cost_markup_rate !== undefined
        ? payload.min_cost_markup_rate
        : payload?.min_markup_rate;
    const minCostMarkupRate = validateMinCostMarkupRateInput_(rawMarkupRate, false);

    const rawSource = asTrimmedString(payload?.job_source) || "manual";
    const jobSource = ALLOWED_JOB_SOURCES.has(rawSource) ? rawSource : "manual";

    if (
      payload?.test_only !== undefined &&
      payload?.test_only !== null &&
      typeof payload.test_only !== "boolean"
    ) {
      return {
        status: 400,
        body: {
          success: false,
          error_code: "INVALID_TEST_ONLY_FLAG",
          error: "test_only must be a boolean",
          message: "test_only には真偽値（true / false）を指定してください。",
        },
      };
    }
    const testOnly = payload?.test_only === true;

    if (
      payload?.force_regenerate !== undefined &&
      payload?.force_regenerate !== null &&
      typeof payload.force_regenerate !== "boolean"
    ) {
      return {
        status: 400,
        body: {
          success: false,
          error_code: "INVALID_FORCE_REGENERATE_FLAG",
          error: "force_regenerate must be a boolean",
          message: "force_regenerate には真偽値（true / false）を指定してください。",
        },
      };
    }
    const forceRegenerate = payload?.force_regenerate === true;

    {
      const { data: testCheckRows, error: testCheckErr } = await supabase
        .from("products")
        .select("product_id, is_test")
        .in("product_id", uniqueProductIds);
      if (testCheckErr) {
        throw new Error(
          `Supabase test product verification failed: ${testCheckErr.message}`
        );
      }
      const isTestByProductId = new Map(
        (testCheckRows || []).map((r) => [
          asTrimmedString(r.product_id),
          r.is_test === true,
        ])
      );

      if (testOnly) {
        const nonTestProductIds = uniqueProductIds.filter(
          (pid) => isTestByProductId.get(pid) !== true
        );
        if (nonTestProductIds.length > 0) {
          return {
            status: 400,
            body: {
              success: false,
              error_code: "NON_TEST_PRODUCT_INCLUDED",
              error: `Test batch rejected because non-test or unknown product IDs were included: ${nonTestProductIds.join(", ")}`,
              message: `テスト実行ではテスト商品（is_test=true）のみ対象にできます。実商品または未登録の商品IDが含まれているため受付前に拒否しました: ${nonTestProductIds.join(", ")}`,
              non_test_product_ids: nonTestProductIds,
            },
          };
        }
      } else {
        const testOrUnknownIds = uniqueProductIds.filter((pid) => {
          if (!isTestByProductId.has(pid)) {
            return jobSource === "scheduled_nightly";
          }
          return isTestByProductId.get(pid) === true;
        });
        if (testOrUnknownIds.length > 0) {
          return {
            status: 400,
            body: {
              success: false,
              error_code: "TEST_PRODUCT_INCLUDED",
              error: `Normal batch rejected because test or unknown product IDs were included: ${testOrUnknownIds.join(", ")}`,
              message: `通常実行では実商品（is_test=false）のみ対象にできます。テスト商品が含まれているため受付前に拒否しました: ${testOrUnknownIds.join(", ")}`,
              test_product_ids: testOrUnknownIds,
            },
          };
        }
      }
    }

    // Fast-path idempotency check BEFORE overlap check & external cost lookup
    const { data: existingJob, error: existErr } = await supabase
      .from("ai_batch_jobs")
      .select("*")
      .eq("request_id", requestId)
      .maybeSingle();
    if (existErr) {
      throw new Error(`Supabase ai_batch_jobs lookup failed: ${existErr.message}`);
    }
    if (existingJob) {
      if (testOnly && existingJob.test_only !== true) {
        return {
          status: 400,
          body: {
            success: false,
            error_code: "NON_TEST_PRODUCT_INCLUDED",
            error: `request_id ${requestId} is already bound to a non-test batch`,
            message:
              "指定された request_id は通常の一括生成ジョブで使用済みのため、テスト実行では再利用できません。",
          },
        };
      }
      if (!testOnly && existingJob.test_only === true) {
        return {
          status: 400,
          body: {
            success: false,
            error_code: "TEST_PRODUCT_INCLUDED",
            error: `request_id ${requestId} is already bound to a test batch`,
            message:
              "指定された request_id はテスト専用一括生成ジョブで使用済みのため、通常実行では再利用できません。",
          },
        };
      }
      return {
        status: 200,
        body: formatBatchCreateResponse(existingJob, true),
      };
    }

    // Reject overlapping active products (scheduled / pending / processing) BEFORE external cost lookup
    const conflictCheck = await findActiveAiBatchProductConflicts(
      supabase,
      uniqueProductIds,
      { ignoreScheduleId }
    );
    if (conflictCheck.has_conflict) {
      return buildActiveProductConflictResponse(conflictCheck);
    }

    const selectedSnapshot = await resolveBatchSelectedImageSnapshot({
      supabase,
      fetchImpl,
      gasWebAppUrl,
      productIds: uniqueProductIds,
      explicitByProduct: payload?.selected_image_ids_by_product,
    });

    const productCostsJson = await resolveConfirmedProductCostsForBatch({
      fetchImpl,
      readdyBackendUrl,
      readdyBackendAnonKey,
      callerAuthHeaders,
      actorType,
      rawInternalProductCosts: payload?.product_costs,
      requireServerCostLookup,
      productIds: uniqueProductIds,
    });

    const batchId = generateBatchId();
    // Keep server-default search-grounded model unless internal caller overrides
    const modelName =
      actorType === "internal" && asTrimmedString(payload?.model_name)
        ? asTrimmedString(payload.model_name)
        : resolveAiDraftModelName();

    const { data: enqueueData, error: enqueueErr } = await supabase.rpc(
      "enqueue_ai_batch_job_atomic",
      {
        p_batch_id: batchId,
        p_request_id: requestId,
        p_product_ids: uniqueProductIds,
        p_job_source: jobSource,
        p_force_regenerate: forceRegenerate,
        p_model_name: modelName,
        p_min_cost_markup_rate: minCostMarkupRate,
        p_product_costs_json: productCostsJson,
        p_selected_image_ids_by_product: selectedSnapshot,
        p_test_only: testOnly,
        p_ignore_schedule_id: asTrimmedString(ignoreScheduleId) || null,
      }
    );
    if (enqueueErr || !enqueueData?.job) {
      const dbConflict = parseDbActiveConflictError(enqueueErr?.message);
      if (dbConflict) return dbConflict;
      throw new Error(
        `Failed enqueueing AI batch job: ${enqueueErr?.message || "empty RPC result"}`
      );
    }

    const isReused = Boolean(enqueueData.is_reused);
    if (!isReused && typeof triggerWorker === "function") {
      await triggerWorker({ reason: "batch_created", batchId: enqueueData.job.batch_id });
    }

    return {
      status: 200,
      body: formatBatchCreateResponse(enqueueData.job, isReused),
    };
  } catch (err) {
    if (err instanceof AiDraftError || err?.error_code) {
      const code = err.errorCode || err.error_code || "BATCH_CREATION_FAILED";
      const status = err.status && err.status >= 400 ? err.status : 200;
      return {
        status,
        body: {
          success: false,
          error_code: code,
          error: err.message,
          message: err.message,
        },
      };
    }
    throw err;
  }
}

/**
 * Returns batch progress & per-product queue state (`get_ai_product_draft_batch`).
 * Supports `batch_id`, `"latest"`, and `"by_product:<productId>"`.
 * Hydrates `product_name` from Supabase so any device sees real product titles.
 */
export async function getAiProductDraftBatch({
  supabase,
  batchId,
  testOnly,
  triggerWorker,
}) {
  const requestedId = asTrimmedString(batchId);
  if (!requestedId) {
    return {
      status: 200,
      body: {
        success: false,
        error_code: "BATCH_ID_REQUIRED",
        message: "batch_id is required",
      },
    };
  }

  let resolvedBatchId = requestedId;
  let jobRow = null;

  if (requestedId === "latest") {
    let query = supabase
      .from("ai_batch_jobs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(1);
    if (typeof testOnly === "boolean") {
      query = query.eq("test_only", testOnly);
    }
    const { data, error } = await query.maybeSingle();
    if (error) {
      throw new Error(`Failed reading latest ai_batch_jobs: ${error.message}`);
    }
    jobRow = data || null;
    resolvedBatchId = asTrimmedString(jobRow?.batch_id);
  } else if (requestedId.startsWith("by_product:")) {
    const targetProductId = asTrimmedString(requestedId.slice("by_product:".length));
    if (targetProductId) {
      const { data: latestItem, error: itemLookupErr } = await supabase
        .from("ai_batch_items")
        .select("batch_id")
        .eq("product_id", targetProductId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (itemLookupErr) {
        throw new Error(
          `Failed looking up batch by product (${targetProductId}): ${itemLookupErr.message}`
        );
      }
      resolvedBatchId = asTrimmedString(latestItem?.batch_id);
    } else {
      resolvedBatchId = "";
    }
  }

  if (resolvedBatchId && !jobRow) {
    const { data, error } = await supabase
      .from("ai_batch_jobs")
      .select("*")
      .eq("batch_id", resolvedBatchId)
      .maybeSingle();
    if (error) {
      throw new Error(`Failed reading ai_batch_jobs (${resolvedBatchId}): ${error.message}`);
    }
    jobRow = data || null;
  }

  if (
    !jobRow ||
    (typeof testOnly === "boolean" && Boolean(jobRow.test_only) !== testOnly)
  ) {
    return {
      status: 200,
      body: {
        success: false,
        error_code: "BATCH_NOT_FOUND",
        message: `Batch not found: ${requestedId}`,
      },
    };
  }

  const { data: itemRows, error: itemsErr } = await supabase
    .from("ai_batch_items")
    .select("*")
    .eq("batch_id", jobRow.batch_id)
    .order("item_index", { ascending: true });
  if (itemsErr) {
    throw new Error(
      `Failed reading ai_batch_items (${jobRow.batch_id}): ${itemsErr.message}`
    );
  }

  const itemProductIds = (itemRows || [])
    .map((r) => asTrimmedString(r.product_id))
    .filter(Boolean);
  const productNamesMap = await resolveProductDisplayTitlesMap(
    supabase,
    itemProductIds
  );

  // Self-healing wakeup: if this batch still has runnable items (`pending` due now or expired `processing`)
  // and no worker slot has claimed them, nudge the worker asynchronously.
  if (typeof triggerWorker === "function") {
    const nowMs = Date.now();
    const hasReadyInBatch = (itemRows || []).some((r) => {
      const st = asTrimmedString(r.status);
      if (st === "pending") {
        const nextStr = asTrimmedString(r.next_retry_at);
        return !nextStr || new Date(nextStr).getTime() <= nowMs;
      }
      if (st === "processing") {
        const leaseStr = asTrimmedString(r.lease_expires_at);
        return Boolean(leaseStr) && new Date(leaseStr).getTime() <= nowMs;
      }
      return false;
    });
    if (hasReadyInBatch) {
      void Promise.resolve(
        triggerWorker({ reason: "poll_wakeup", batchId: jobRow.batch_id })
      ).catch(() => {});
    }
  }

  return {
    status: 200,
    body: formatBatchProgressResponse(jobRow, itemRows || [], productNamesMap),
  };
}

/**
 * Retries ONLY `failed` items in an existing batch (`retry_ai_product_draft_batch`).
 * - Idempotent on `request_id`.
 * - Rejects with 409 if any failed item is currently active in another batch or reservation.
 * - Never touches `completed` or active `processing` items.
 * - Returns `NO_FAILED_ITEMS` when there are 0 failed items.
 */
export async function retryAiProductDraftBatch({
  supabase,
  fetchImpl = globalThis.fetch,
  readdyBackendUrl = process.env.READDY_BACKEND_URL,
  readdyBackendAnonKey = process.env.READDY_BACKEND_ANON_KEY,
  callerAuthHeaders = {},
  actorType = "staff",
  batchId,
  payload = {},
  triggerWorker,
}) {
  try {
    const normBatchId = asTrimmedString(batchId || payload?.batch_id);
    if (!normBatchId) {
      return {
        status: 200,
        body: {
          success: false,
          error_code: "BATCH_ID_REQUIRED",
          message: "batch_id is required",
        },
      };
    }

    const retryRequestId = asTrimmedString(payload?.request_id);
    if (!retryRequestId) {
      return {
        status: 200,
        body: {
          success: false,
          error_code: "REQUEST_ID_REQUIRED",
          message: "request_id is required for batch retry",
        },
      };
    }

    const { data: existingJob, error: jobErr } = await supabase
      .from("ai_batch_jobs")
      .select("*")
      .eq("batch_id", normBatchId)
      .maybeSingle();
    if (jobErr) {
      throw new Error(`Failed reading ai_batch_jobs (${normBatchId}): ${jobErr.message}`);
    }
    if (!existingJob) {
      return {
        status: 200,
        body: {
          success: false,
          error_code: "BATCH_NOT_FOUND",
          message: `Batch not found: ${normBatchId}`,
        },
      };
    }

    // Fast-path idempotent replay check before overlap check & refreshing costs
    const retryMap =
      existingJob.retry_requests &&
      typeof existingJob.retry_requests === "object" &&
      !Array.isArray(existingJob.retry_requests)
        ? existingJob.retry_requests
        : {};
    if (Object.prototype.hasOwnProperty.call(retryMap, retryRequestId)) {
      const prev = retryMap[retryRequestId]?.response || {};
      return {
        status: 200,
        body: {
          ...prev,
          batch_id: normBatchId,
          request_id: retryRequestId,
          is_reused: true,
        },
      };
    }

    const { data: failedRows, error: failedLookupErr } = await supabase
      .from("ai_batch_items")
      .select("product_id")
      .eq("batch_id", normBatchId)
      .eq("status", "failed");
    if (failedLookupErr) {
      throw new Error(
        `Failed reading failed ai_batch_items (${normBatchId}): ${failedLookupErr.message}`
      );
    }
    const failedProductIds = [
      ...new Set(
        (failedRows || []).map((r) => asTrimmedString(r.product_id)).filter(Boolean)
      ),
    ];

    if (failedProductIds.length > 0) {
      const conflictCheck = await findActiveAiBatchProductConflicts(
        supabase,
        failedProductIds,
        { ignoreBatchId: normBatchId }
      );
      if (conflictCheck.has_conflict) {
        return buildActiveProductConflictResponse(conflictCheck);
      }
    }

    // Refresh confirmed costs for failed items when Readdy Backend is configured
    let updatedCosts = null;
    if (failedProductIds.length > 0 && asTrimmedString(readdyBackendUrl)) {
      const fetchedCosts = await resolveConfirmedProductCostsForBatch({
        fetchImpl,
        readdyBackendUrl,
        readdyBackendAnonKey,
        callerAuthHeaders,
        actorType,
        productIds: failedProductIds,
      });
      const existingCostsObj =
        existingJob.product_costs_json &&
        typeof existingJob.product_costs_json === "object" &&
        !Array.isArray(existingJob.product_costs_json)
          ? existingJob.product_costs_json
          : {};
      updatedCosts = {};
      for (const pid of failedProductIds) {
        const nextEntry = fetchedCosts[pid];
        const prevEntry = existingCostsObj[pid];
        const prevBd = prevEntry?.cost_breakdown ?? prevEntry;
        const prevTotal = toNullableNumber(prevBd?.total_allocated_cost);
        const nextStatus = asTrimmedString(
          nextEntry?.cost_status || nextEntry?.costStatus
        ).toLowerCase();
        // If retry cost refresh failed due to a transient outage, preserve a previously confirmed cost
        if (nextStatus === "lookup_failed" && prevTotal !== null && prevTotal > 0) {
          updatedCosts[pid] = prevEntry;
        } else {
          updatedCosts[pid] = nextEntry !== undefined ? nextEntry : null;
        }
      }
    }

    const { data: rpcRes, error: rpcErr } = await supabase.rpc(
      "retry_ai_batch_failed_items_atomic",
      {
        p_batch_id: normBatchId,
        p_request_id: retryRequestId,
        p_updated_product_costs: updatedCosts,
      }
    );
    if (rpcErr || !rpcRes) {
      const dbConflict = parseDbActiveConflictError(rpcErr);
      if (dbConflict) {
        return dbConflict;
      }
      throw new Error(
        `Failed retrying batch (${normBatchId}): ${rpcErr?.message || "empty RPC result"}`
      );
    }
    if (rpcRes.found === false) {
      return {
        status: 200,
        body: {
          success: false,
          error_code: "BATCH_NOT_FOUND",
          message: `Batch not found: ${normBatchId}`,
        },
      };
    }

    const retriedCount = Number(rpcRes.retried_count || 0);
    if (!rpcRes.is_reused && retriedCount > 0 && typeof triggerWorker === "function") {
      await triggerWorker({ reason: "batch_retried", batchId: normBatchId });
    }

    const mergedCostsForSummary = {
      ...(existingJob.product_costs_json &&
      typeof existingJob.product_costs_json === "object" &&
      !Array.isArray(existingJob.product_costs_json)
        ? existingJob.product_costs_json
        : {}),
      ...(updatedCosts || {}),
    };
    const costFetchFailedProductIds = Object.keys(mergedCostsForSummary).filter((pid) => {
      const entry = mergedCostsForSummary[pid];
      const st = asTrimmedString(entry?.cost_status || entry?.costStatus).toLowerCase();
      return st === "lookup_failed" || entry?.cost_lookup_failed === true;
    });

    return {
      status: 200,
      body: {
        ...rpcRes.response,
        cost_fetch_failed_product_ids: costFetchFailedProductIds,
        cost_fetch_failed_count: costFetchFailedProductIds.length,
      },
    };
  } catch (err) {
    const dbConflict = parseDbActiveConflictError(err);
    if (dbConflict) {
      return dbConflict;
    }
    if (err instanceof AiDraftError || err?.error_code) {
      const code = err.errorCode || err.error_code || "BATCH_RETRY_FAILED";
      const status = err.status && err.status >= 400 ? err.status : 200;
      return {
        status,
        body: {
          success: false,
          error_code: code,
          error: err.message,
          message: err.message,
        },
      };
    }
    throw err;
  }
}

/**
 * Fail-closed verification that an auto-applied AI draft is completely reflected in Supabase
 * while remaining strictly `publish_status = 'draft'` and unlinked from Square.
 */
async function verifySupabaseBatchItemReflection(supabase, productId, expectedDraftId) {
  const [{ data: productRow, error: prodErr }, { data: transRow, error: transErr }, latestDraft] =
    await Promise.all([
      supabase
        .from("products")
        .select(
          "product_id, category, product_name, condition, planned_sale_price, description, ai_draft_flag, publish_status, record_status, square_item_id, square_variation_id, square_payment_link_id, square_checkout_url, sheets_mirror_pending"
        )
        .eq("product_id", productId)
        .maybeSingle(),
      supabase
        .from("product_translations")
        .select("product_id, locale, translated_title, translated_description, translation_status")
        .eq("product_id", productId)
        .eq("locale", "en")
        .maybeSingle(),
      fetchLatestSupabaseAiDraft(supabase, productId),
    ]);

  if (prodErr || !productRow) {
    throw new AiDraftError(
      "AI_DRAFT_REFLECTION_INCOMPLETE",
      `Product missing during reflection verification: ${productId}`
    );
  }
  if (transErr) {
    throw new AiDraftError(
      "AI_DRAFT_REFLECTION_INCOMPLETE",
      `Translation lookup failed during reflection verification (${productId}): ${transErr.message}`
    );
  }
  if (!latestDraft || asTrimmedString(latestDraft.draft_id) !== expectedDraftId) {
    throw new AiDraftError(
      latestDraft ? "AI_DRAFT_SUPERSEDED" : "AI_DRAFT_NOT_FOUND",
      `Expected latest AI draft '${expectedDraftId}' for ${productId}, found '${
        latestDraft?.draft_id || "none"
      }'`
    );
  }

  if ((asTrimmedString(productRow.publish_status) || "draft") !== "draft") {
    throw new AiDraftError(
      "UNEXPECTED_PUBLISH_STATE",
      `Batch auto-apply must remain draft for ${productId}`
    );
  }
  if (hasAnySquareLink(productRow)) {
    throw new AiDraftError(
      "SQUARE_LINKED_PRODUCT_NOT_ALLOWED",
      `Batch auto-apply must never link Square for ${productId}`
    );
  }
  if (asTrimmedString(latestDraft.review_status) !== "confirmed") {
    throw new AiDraftError(
      "AI_DRAFT_REFLECTION_INCOMPLETE",
      `Draft ${expectedDraftId} is not in confirmed state (${latestDraft.review_status})`
    );
  }
  if (!asTrimmedString(latestDraft.confirmed_fingerprint)) {
    throw new AiDraftError(
      "AI_DRAFT_REFLECTION_INCOMPLETE",
      `Draft ${expectedDraftId} is missing confirmed_fingerprint`
    );
  }
  if (asTrimmedString(productRow.ai_draft_flag) !== AI_DRAFT_CONFIG.FLAG_VALUE) {
    throw new AiDraftError(
      "AI_DRAFT_REFLECTION_INCOMPLETE",
      `Product ${productId} is missing ai_draft_flag='${AI_DRAFT_CONFIG.FLAG_VALUE}'`
    );
  }
  if (!asTrimmedString(productRow.product_name)) {
    throw new AiDraftError(
      "AI_DRAFT_REFLECTION_INCOMPLETE",
      `Product ${productId} is missing product_name after auto-apply`
    );
  }
  const expectedPrice = toNullableNumber(latestDraft.candidate_price);
  const salePrice = toNullableNumber(productRow.planned_sale_price);
  if (expectedPrice !== null && expectedPrice > 0 && (salePrice === null || salePrice <= 0)) {
    throw new AiDraftError(
      "AI_DRAFT_REFLECTION_INCOMPLETE",
      `Product ${productId} is missing positive planned_sale_price after auto-apply`
    );
  }
  if (
    !transRow ||
    !asTrimmedString(transRow.translated_title) ||
    !asTrimmedString(transRow.translated_description)
  ) {
    throw new AiDraftError(
      "AI_DRAFT_REFLECTION_INCOMPLETE",
      `Product ${productId} is missing approved English translation after auto-apply`
    );
  }

  return { productRow, transRow, latestDraft };
}

/**
 * Processes a single claimed `ai_batch_items` row with full fencing, interruption recovery,
 * fail-closed verification, and transient retry handling.
 */
async function processSingleClaimedBatchItem({
  supabase,
  fetchImpl = globalThis.fetch,
  gasWebAppUrl,
  geminiApiKey = process.env.GEMINI_API_KEY,
  internalSecret = process.env.PRODUCTS_API_INTERNAL_SECRET,
  claimedItem,
}) {
  const itemId = Number(claimedItem.id);
  const productId = asTrimmedString(claimedItem.product_id);
  const workerExecutionId = asTrimmedString(claimedItem.worker_execution_id);
  const linkedDraftId = asTrimmedString(claimedItem.linked_draft_id);
  const currentRetryCount = Number(claimedItem.retry_count || 0);
  const selectedIds = normalizeStringArray(claimedItem.selected_image_ids);

  const ownershipCheck = async (info = {}) => {
    const reserveDraftId =
      info && info.phase === "commit" && info.draft_id
        ? asTrimmedString(info.draft_id)
        : null;
    const reserveModelName =
      info && info.phase === "commit" && info.model_name
        ? asTrimmedString(info.model_name)
        : null;

    const { data: ok, error } = await supabase.rpc(
      "verify_or_reserve_ai_batch_item_ownership",
      {
        p_item_id: itemId,
        p_worker_execution_id: workerExecutionId,
        p_draft_id: reserveDraftId,
        p_model_name: reserveModelName,
      }
    );
    if (error) {
      throw new Error(`Batch item ownership RPC failed: ${error.message}`);
    }
    if (ok !== true) {
      throw new AiDraftError(
        "BATCH_ITEM_OWNERSHIP_LOST",
        `Worker ${workerExecutionId} lost lease ownership of batch item ${itemId} (${productId})`
      );
    }
  };

  try {
    // 1. Interruption recovery if a previous worker pass already reserved `linked_draft_id`
    if (linkedDraftId) {
      const latestDraft = await fetchLatestSupabaseAiDraft(supabase, productId);
      if (latestDraft && asTrimmedString(latestDraft.draft_id) === linkedDraftId) {
        if (latestDraft.search_grounding_enabled && !latestDraft.search_executed) {
          const unsearchedErr = new AiDraftError(
            "SEARCH_GROUNDING_NOT_EXECUTED",
            `Search grounding was enabled but search was not executed for ${productId}.`
          );
          unsearchedErr.draft_id = linkedDraftId;
          unsearchedErr.draft_version = Number(latestDraft.draft_version || 1);
          unsearchedErr.model_name = asTrimmedString(latestDraft.model_name);
          throw unsearchedErr;
        }

        if (asTrimmedString(latestDraft.review_status) === "confirmed") {
          await ownershipCheck({ phase: "prepare" });
          const verified = await verifySupabaseBatchItemReflection(
            supabase,
            productId,
            linkedDraftId
          );

          // If GAS mirror was still pending when previous worker crashed, flush mirror now
          if (gasWebAppUrl && verified.productRow.sheets_mirror_pending === true) {
            await mirrorAiProductDraftStateToSheets({
              fetchImpl,
              gasWebAppUrl,
              internalSecret,
              payload: {
                product_id: productId,
                ai_draft_flag: AI_DRAFT_CONFIG.FLAG_VALUE,
                mark_previous_pending_stale: true,
                apply_confirmed_product: false,
                draft_record: {
                  draft_id: linkedDraftId,
                  product_id: productId,
                  draft_version: Number(latestDraft.draft_version || 1),
                  review_status: "confirmed",
                  confirmed_fingerprint: asTrimmedString(latestDraft.confirmed_fingerprint),
                },
              },
            }).catch(() => {});
          }

          const propPrice = toNullableNumber(latestDraft.candidate_price);
          await supabase.rpc("complete_ai_batch_queue_item", {
            p_item_id: itemId,
            p_worker_execution_id: workerExecutionId,
            p_outcome: "completed",
            p_draft_id: linkedDraftId,
            p_draft_version: Number(latestDraft.draft_version || 1),
            p_model_name: asTrimmedString(latestDraft.model_name),
            p_proposed_price: propPrice !== null && propPrice > 0 ? Math.trunc(propPrice) : null,
            p_price_basis: asTrimmedString(latestDraft.candidate_price_basis),
            p_price_note: asRawString(latestDraft.candidate_price_note ?? ""),
            p_source_image_ids: normalizeStringArray(latestDraft.source_image_ids),
          });
          return { status: "completed", rateLimited: false, productId };
        }
      } else if (latestDraft) {
        const { data: oldDraftRow } = await supabase
          .from("product_ai_drafts")
          .select("draft_id")
          .eq("product_id", productId)
          .eq("draft_id", linkedDraftId)
          .maybeSingle();
        if (oldDraftRow) {
          throw new AiDraftError(
            "AI_DRAFT_SUPERSEDED",
            `AI draft ${linkedDraftId} for ${productId} was superseded by newer draft ${latestDraft.draft_id}.`
          );
        }
      }
    }

    {
      const { data: prodTestRow, error: prodTestErr } = await supabase
        .from("products")
        .select("product_id, is_test")
        .eq("product_id", productId)
        .maybeSingle();
      if (prodTestErr) {
        throw new Error(
          `Worker test product check failed for ${productId}: ${prodTestErr.message}`
        );
      }
      if (claimedItem.job_test_only === true) {
        if (!prodTestRow || prodTestRow.is_test !== true) {
          throw new AiDraftError(
            "NON_TEST_PRODUCT_INCLUDED",
            `Refusing AI generation in test_only batch because ${productId} is not marked is_test=true`
          );
        }
      } else if (prodTestRow && prodTestRow.is_test === true) {
        throw new AiDraftError(
          "TEST_PRODUCT_INCLUDED",
          `Refusing AI generation in normal batch because ${productId} is marked is_test=true`
        );
      }
    }

    // 2. Execute single-product AI draft with auto_apply: true
    const draftRes = await executeSingleProductAiDraft({
      supabase,
      fetchImpl,
      gasWebAppUrl,
      geminiApiKey,
      internalSecret,
      productId,
      options: {
        force_regenerate: Boolean(claimedItem.force_regenerate),
        model_name: asTrimmedString(claimedItem.job_model_name),
        selected_image_ids: selectedIds.length > 0 ? selectedIds : undefined,
        selection_was_prevalidated: selectedIds.length > 0,
        product_cost:
          claimedItem.product_cost !== undefined ? claimedItem.product_cost : null,
        min_cost_markup_rate: Number(
          claimedItem.min_cost_markup_rate ?? AI_DRAFT_CONFIG.DEFAULT_MIN_COST_MARKUP_RATE
        ),
        apply_cost_floor: true,
        auto_apply: true,
        confirmed_by: "ai_batch_worker",
        ownership_check: ownershipCheck,
      },
    });

    const latestAfter = await fetchLatestSupabaseAiDraft(supabase, productId);
    if (!latestAfter || asTrimmedString(latestAfter.draft_id) !== draftRes.draft_id) {
      throw new AiDraftError(
        latestAfter ? "AI_DRAFT_SUPERSEDED" : "AI_DRAFT_NOT_FOUND",
        `Generated AI draft ${draftRes.draft_id} for ${productId} is not the latest draft.`
      );
    }

    // Fail-closed: if search grounding was enabled but search did not execute, keep draft in `pending_review`
    // and mark batch item `failed` (`SEARCH_GROUNDING_NOT_EXECUTED`) so unsearched content is never auto-applied!
    if (
      (latestAfter.search_grounding_enabled && !latestAfter.search_executed) ||
      draftRes.auto_applied !== true
    ) {
      const unsearchedErr = new AiDraftError(
        "SEARCH_GROUNDING_NOT_EXECUTED",
        `Search grounding was enabled but search was not executed for ${productId}.`
      );
      unsearchedErr.draft_id = draftRes.draft_id;
      unsearchedErr.draft_version = Number(draftRes.draft_version || 1);
      unsearchedErr.model_name = asTrimmedString(draftRes.model_name);
      throw unsearchedErr;
    }

    await verifySupabaseBatchItemReflection(supabase, productId, draftRes.draft_id);

    const cand = draftRes.candidate || {};
    const propPrice = toNullableNumber(cand.price ?? latestAfter.candidate_price);
    await supabase.rpc("complete_ai_batch_queue_item", {
      p_item_id: itemId,
      p_worker_execution_id: workerExecutionId,
      p_outcome: "completed",
      p_draft_id: draftRes.draft_id,
      p_draft_version: Number(draftRes.draft_version || 1),
      p_model_name: asTrimmedString(draftRes.model_name),
      p_proposed_price: propPrice !== null && propPrice > 0 ? Math.trunc(propPrice) : null,
      p_price_basis: asTrimmedString(cand.price_basis ?? latestAfter.candidate_price_basis),
      p_price_note: asRawString(cand.price_note ?? latestAfter.candidate_price_note ?? ""),
      p_source_image_ids: normalizeStringArray(latestAfter.source_image_ids),
    });

    return { status: "completed", rateLimited: false, productId };
  } catch (procErr) {
    const errCode = asTrimmedString(
      procErr?.errorCode || procErr?.error_code || "GENERATION_FAILED"
    );
    if (errCode === "BATCH_ITEM_OWNERSHIP_LOST") {
      return { status: "fenced", rateLimited: false, productId };
    }

    const rateLimited = isRateLimitedAiBatchError(procErr);
    const transient = isTransientAiBatchError(procErr);
    const safeMsg =
      asTrimmedString(procErr?.message) || AI_DRAFT_CONFIG.SAFE_LLM_ERROR_MESSAGE;

    if (transient && currentRetryCount < AI_BATCH_QUEUE_CONFIG.MAX_RETRIES) {
      const nextRetryCount = currentRetryCount + 1;
      const nextRetryIso = new Date(
        Date.now() + AI_BATCH_QUEUE_CONFIG.RETRY_BACKOFF_MS * nextRetryCount
      ).toISOString();
      await supabase.rpc("complete_ai_batch_queue_item", {
        p_item_id: itemId,
        p_worker_execution_id: workerExecutionId,
        p_outcome: "retry_pending",
        p_error_code: errCode,
        p_error_message: safeMsg,
        p_retry_count: nextRetryCount,
        p_next_retry_at: nextRetryIso,
      });
      return { status: "retry_pending", rateLimited, productId };
    }

    await supabase.rpc("complete_ai_batch_queue_item", {
      p_item_id: itemId,
      p_worker_execution_id: workerExecutionId,
      p_outcome: "failed",
      p_draft_id: asTrimmedString(procErr?.draft_id) || null,
      p_draft_version:
        procErr?.draft_version !== undefined && procErr?.draft_version !== null
          ? Number(procErr.draft_version)
          : null,
      p_model_name: asTrimmedString(procErr?.model_name) || null,
      p_error_code: errCode,
      p_error_message: safeMsg,
    });
    return { status: "failed", rateLimited, productId };
  }
}

/**
 * Runs a controlled-concurrency pass over the persistent `ai_batch_items` queue.
 * Reusable by manual batches AND future scheduled nightly jobs (`job_source = 'scheduled_nightly'`).
 */
export async function processAiBatchQueuePass({
  supabase,
  fetchImpl = globalThis.fetch,
  gasWebAppUrl,
  geminiApiKey = process.env.GEMINI_API_KEY,
  internalSecret = process.env.PRODUCTS_API_INTERNAL_SECRET,
  concurrency,
  maxItems,
  timeBudgetMs = AI_BATCH_QUEUE_CONFIG.WORKER_TIME_BUDGET_MS,
  leaseSeconds = AI_BATCH_QUEUE_CONFIG.LEASE_SECONDS,
}) {
  const effectiveConcurrency = resolveAiBatchConcurrency(concurrency);
  const maxItemsCap =
    maxItems !== undefined && maxItems !== null && Number.isFinite(Number(maxItems))
      ? Math.max(1, Math.trunc(Number(maxItems)))
      : Infinity;

  const startMs = Date.now();
  let processedCount = 0;
  let completedCount = 0;
  let failedCount = 0;
  let retryScheduledCount = 0;
  let circuitBreakerTripped = false;
  let timeBudgetReached = false;

  const inFlight = new Set();

  while (processedCount + inFlight.size < maxItemsCap) {
    if (circuitBreakerTripped) break;
    if (Date.now() - startMs >= timeBudgetMs) {
      timeBudgetReached = true;
      break;
    }

    const freeLocalSlots = Math.min(
      effectiveConcurrency - inFlight.size,
      maxItemsCap - (processedCount + inFlight.size)
    );
    if (freeLocalSlots <= 0) {
      await Promise.race(inFlight);
      continue;
    }

    const { data: claimedRows, error: claimErr } = await supabase.rpc(
      "claim_ai_batch_queue_items",
      {
        p_limit: freeLocalSlots,
        p_max_global_concurrency: effectiveConcurrency,
        p_lease_seconds: leaseSeconds,
      }
    );
    if (claimErr) {
      throw new Error(`Failed claiming AI batch queue items: ${claimErr.message}`);
    }

    const claimedList = Array.isArray(claimedRows) ? claimedRows : [];
    if (claimedList.length === 0) {
      if (inFlight.size === 0) {
        break;
      }
      await Promise.race(inFlight);
      continue;
    }

    for (const item of claimedList) {
      let taskPromise;
      taskPromise = processSingleClaimedBatchItem({
        supabase,
        fetchImpl,
        gasWebAppUrl,
        geminiApiKey,
        internalSecret,
        claimedItem: item,
      })
        .then((outcome) => {
          processedCount += 1;
          if (outcome.status === "completed") completedCount += 1;
          else if (outcome.status === "failed") failedCount += 1;
          else if (outcome.status === "retry_pending") retryScheduledCount += 1;
          if (outcome.rateLimited) {
            circuitBreakerTripped = true;
          }
        })
        .finally(() => {
          inFlight.delete(taskPromise);
        });
      inFlight.add(taskPromise);
    }

    if (inFlight.size >= effectiveConcurrency) {
      await Promise.race(inFlight);
    }
  }

  if (inFlight.size > 0) {
    await Promise.allSettled([...inFlight]);
  }

  const remainingRunnable =
    !circuitBreakerTripped && (await hasRunnableAiBatchQueueItems(supabase));

  return {
    processed_count: processedCount,
    completed_count: completedCount,
    failed_count: failedCount,
    retry_scheduled_count: retryScheduledCount,
    concurrency: effectiveConcurrency,
    circuit_breaker_tripped: circuitBreakerTripped,
    time_budget_reached: timeBudgetReached,
    remaining_runnable: remainingRunnable,
    elapsed_ms: Date.now() - startMs,
  };
}

/**
 * Creates a Cloud Run–safe worker coordinator for `server.mjs`:
 * - Single-flight per container instance (`activeRunPromise`) so overlapping wakeups share one loop.
 * - When `selfApiUrl` + `internalSecret` are configured (Cloud Run production), dispatches an active
 *   HTTP `POST ${selfApiUrl}/ai-batches/worker/run` so Cloud Run keeps 100% request CPU allocated
 *   even with `cpuIdle: true`, and automatically self-chains if >3 min of queue items remain!
 * - When `selfApiUrl` is empty (local dev / unit tests), executes `runLocalPass` asynchronously in-process.
 */
function generateScheduleId() {
  return `SCHED_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
}

function buildScheduleBatchRequestId(scheduleId) {
  return `SCHED_BATCH_${asTrimmedString(scheduleId)}`;
}

function normalizeProductNamesMap(rawNames, allowedProductIds) {
  const allowed = new Set(allowedProductIds);
  const out = {};
  if (rawNames && typeof rawNames === "object" && !Array.isArray(rawNames)) {
    for (const [k, v] of Object.entries(rawNames)) {
      const pid = asTrimmedString(k);
      if (!pid || !allowed.has(pid)) continue;
      const name = asTrimmedString(v);
      if (name) out[pid] = name;
    }
  }
  return out;
}

function normalizeExcludedItemsList(rawExcluded) {
  if (!Array.isArray(rawExcluded)) return [];
  const out = [];
  for (const item of rawExcluded) {
    if (!item || typeof item !== "object") continue;
    const pid = asTrimmedString(item.product_id);
    if (!pid) continue;
    out.push({
      product_id: pid,
      product_name: asTrimmedString(item.product_name) || pid,
      error_code: asTrimmedString(item.error_code) || "EXCLUDED_BEFORE_START",
      error_message:
        asTrimmedString(item.error_message) ||
        "実行前の商品状態変更により対象外になりました。",
    });
  }
  return out;
}

function deriveScheduleOverallStatus(scheduleRow, jobRow) {
  const schedStatus = asTrimmedString(scheduleRow?.status) || "scheduled";
  if (schedStatus === "scheduled") return "scheduled";
  if (schedStatus === "starting") return "starting";
  if (schedStatus === "dispatch_retry") return "dispatch_retry";
  if (schedStatus === "cancelled") return "cancelled";
  if (schedStatus === "completed_all_excluded") return "completed";
  if (schedStatus === "failed") return "failed";

  // schedStatus === "started"
  const jobStatus = asTrimmedString(jobRow?.status) || "queued";
  if (jobStatus === "completed") return "completed";
  if (jobStatus === "partially_failed") return "partially_failed";
  if (jobStatus === "failed") return "failed";
  return "processing";
}

function formatScheduleSummary(scheduleRow, jobRow) {
  const schedStatus = asTrimmedString(scheduleRow.status) || "scheduled";
  const productIds = normalizeStringArray(scheduleRow.product_ids);
  const excludedItems = normalizeExcludedItemsList(scheduleRow.excluded_items_json);
  const excludedCount = excludedItems.length;
  const totalReservedCount = productIds.length;
  const overallStatus = deriveScheduleOverallStatus(scheduleRow, jobRow);

  const completedCount = jobRow ? Number(jobRow.completed_count || 0) : 0;
  const failedCount = jobRow
    ? Number(jobRow.failed_count || 0)
    : schedStatus === "failed"
      ? Math.max(0, totalReservedCount - excludedCount)
      : 0;
  const processingCount = jobRow ? Number(jobRow.processing_count || 0) : 0;
  const eligibleCount = jobRow
    ? Number(jobRow.total_count || 0)
    : schedStatus === "completed_all_excluded"
      ? 0
      : Math.max(0, totalReservedCount - excludedCount);
  const pendingCount = jobRow
    ? Math.max(0, eligibleCount - completedCount - failedCount - processingCount)
    : overallStatus === "scheduled" ||
        overallStatus === "starting" ||
        overallStatus === "dispatch_retry"
      ? totalReservedCount
      : 0;

  const rate = Number(
    scheduleRow.min_cost_markup_rate ?? AI_DRAFT_CONFIG.DEFAULT_MIN_COST_MARKUP_RATE
  );
  const canCancel =
    (schedStatus === "scheduled" || schedStatus === "dispatch_retry") &&
    !asTrimmedString(scheduleRow.batch_id);

  const completedAt =
    formatIsoOrNull(jobRow?.completed_at) ||
    formatIsoOrNull(scheduleRow.completed_at) ||
    formatIsoOrNull(scheduleRow.cancelled_at);

  const pricing = jobRow
    ? buildPricingSummary(
        jobRow.min_cost_markup_rate,
        productIds,
        jobRow.product_costs_json
      )
    : null;

  return {
    schedule_id: asTrimmedString(scheduleRow.schedule_id),
    request_id: asTrimmedString(scheduleRow.request_id),
    schedule_status: schedStatus,
    overall_status: overallStatus,
    can_cancel: canCancel,
    all_excluded: schedStatus === "completed_all_excluded",
    test_only: Boolean(scheduleRow.test_only),
    force_regenerate: Boolean(scheduleRow.force_regenerate),
    scheduled_at: asTrimmedString(scheduleRow.scheduled_at),
    scheduled_at_jst: formatJstDateTimeDisplay(scheduleRow.scheduled_at),
    started_at: formatIsoOrNull(scheduleRow.started_at),
    cancelled_at: formatIsoOrNull(scheduleRow.cancelled_at),
    completed_at: completedAt,
    created_at: asTrimmedString(scheduleRow.created_at),
    created_at_jst: formatJstDateTimeDisplay(scheduleRow.created_at),
    updated_at: asTrimmedString(scheduleRow.updated_at),
    batch_id: asTrimmedString(scheduleRow.batch_id) || null,
    min_cost_markup_rate: rate,
    min_gross_margin_rate: rate,
    gross_margin_divisor: Math.round((1 - rate) * 10000) / 10000,
    total_reserved_count: totalReservedCount,
    eligible_count: eligibleCount,
    completed_count: completedCount,
    failed_count: failedCount,
    processing_count: processingCount,
    pending_count: pendingCount,
    excluded_count: excludedCount,
    cost_fetch_failed_product_ids: pricing ? pricing.cost_fetch_failed_product_ids : [],
    cost_fetch_failed_count: pricing ? pricing.cost_fetch_failed_count : 0,
    dispatch_retry_count: Number(scheduleRow.dispatch_retry_count || 0),
    next_dispatch_retry_at: formatIsoOrNull(scheduleRow.next_dispatch_retry_at),
    dispatch_error_code: asTrimmedString(scheduleRow.dispatch_error_code) || null,
    dispatch_error_message:
      asTrimmedString(scheduleRow.dispatch_error_message) || null,
    product_ids: productIds,
    excluded_items: excludedItems,
  };
}

function formatScheduleDetail(scheduleRow, jobRow, itemRows, liveNamesMap = {}) {
  const summary = formatScheduleSummary(scheduleRow, jobRow);
  const namesMap =
    scheduleRow.product_names_json &&
    typeof scheduleRow.product_names_json === "object" &&
    !Array.isArray(scheduleRow.product_names_json)
      ? scheduleRow.product_names_json
      : {};
  const excludedByPid = new Map(
    summary.excluded_items.map((ex) => [ex.product_id, ex])
  );
  const batchItemByPid = new Map();
  for (const row of itemRows || []) {
    batchItemByPid.set(asTrimmedString(row.product_id), row);
  }

  const pricing = jobRow
    ? buildPricingSummary(
        jobRow.min_cost_markup_rate,
        summary.product_ids,
        jobRow.product_costs_json
      )
    : {
        pricing_rule: "gross_margin_floor",
        min_cost_markup_rate: summary.min_cost_markup_rate,
        min_gross_margin_rate: summary.min_gross_margin_rate,
        gross_margin_divisor: summary.gross_margin_divisor,
        product_costs_by_product: {},
        cost_fetch_failed_product_ids: [],
        cost_fetch_failed_count: 0,
      };

  const items = summary.product_ids.map((pid) => {
    const liveName = asTrimmedString(liveNamesMap?.[pid]);
    const fallbackName =
      (liveName && liveName !== "（商品名なし）" ? liveName : "") ||
      asTrimmedString(namesMap[pid]) ||
      liveName ||
      pid;
    const ex = excludedByPid.get(pid);
    if (ex) {
      return {
        product_id: pid,
        product_name:
          (liveName && liveName !== "（商品名なし）" ? liveName : "") ||
          ex.product_name ||
          fallbackName,
        status: "excluded",
        draft_id: null,
        draft_version: null,
        model_name: null,
        proposed_price: null,
        price_basis: null,
        price_note: null,
        error_code: ex.error_code,
        error_message: ex.error_message,
        retry_count: 0,
        selected_image_ids: [],
        source_image_ids: [],
      };
    }

    const bRow = batchItemByPid.get(pid);
    if (bRow) {
      const draftVer = toNullableNumber(bRow.draft_version);
      const propPrice = toNullableNumber(bRow.proposed_price);
      return {
        product_id: pid,
        product_name: fallbackName,
        status: asTrimmedString(bRow.status) || "pending",
        draft_id: asTrimmedString(bRow.draft_id) || null,
        draft_version: draftVer !== null ? Math.trunc(draftVer) : null,
        model_name: asTrimmedString(bRow.model_name) || null,
        proposed_price:
          propPrice !== null && propPrice > 0 ? Math.trunc(propPrice) : null,
        price_basis: asTrimmedString(bRow.price_basis) || null,
        price_note: asRawString(bRow.price_note ?? "").trim() || null,
        error_code: asTrimmedString(bRow.error_code) || null,
        error_message: asTrimmedString(bRow.error_message) || null,
        retry_count: Number(bRow.retry_count || 0),
        selected_image_ids: normalizeStringArray(bRow.selected_image_ids),
        source_image_ids: normalizeStringArray(bRow.source_image_ids),
      };
    }

    if (summary.schedule_status === "cancelled") {
      return {
        product_id: pid,
        product_name: fallbackName,
        status: "cancelled",
        draft_id: null,
        draft_version: null,
        model_name: null,
        proposed_price: null,
        price_basis: null,
        price_note: null,
        error_code: null,
        error_message: null,
        retry_count: 0,
        selected_image_ids: [],
        source_image_ids: [],
      };
    }

    if (summary.schedule_status === "failed") {
      return {
        product_id: pid,
        product_name: fallbackName,
        status: "failed",
        draft_id: null,
        draft_version: null,
        model_name: null,
        proposed_price: null,
        price_basis: null,
        price_note: null,
        error_code: summary.dispatch_error_code || "SCHEDULE_DISPATCH_FAILED",
        error_message:
          summary.dispatch_error_message ||
          "予約時刻の開始処理に失敗しました。",
        retry_count: summary.dispatch_retry_count,
        selected_image_ids: [],
        source_image_ids: [],
      };
    }

    return {
      product_id: pid,
      product_name: fallbackName,
      status: "pending",
      draft_id: null,
      draft_version: null,
      model_name: null,
      proposed_price: null,
      price_basis: null,
      price_note: null,
      error_code: null,
      error_message: null,
      retry_count: 0,
      selected_image_ids: [],
      source_image_ids: [],
    };
  });

  return {
    success: true,
    write_master: "supabase",
    ...summary,
    pricing_rule: pricing.pricing_rule,
    product_costs_by_product: pricing.product_costs_by_product,
    cost_fetch_failed_product_ids: pricing.cost_fetch_failed_product_ids,
    cost_fetch_failed_count: pricing.cost_fetch_failed_count,
    items,
  };
}

function evaluateScheduledProductEligibility({
  productId,
  productRow,
  testOnly,
  reservedSelectedIds,
  fallbackName,
}) {
  const displayName =
    asTrimmedString(productRow?.product_name) ||
    asTrimmedString(fallbackName) ||
    productId;

  if (!productRow) {
    return {
      eligible: false,
      excludedItem: {
        product_id: productId,
        product_name: displayName,
        error_code: "PRODUCT_NOT_FOUND",
        error_message: "商品が見つからないため対象外になりました。",
      },
    };
  }

  const isTest = productRow.is_test === true;
  if (testOnly && !isTest) {
    return {
      eligible: false,
      excludedItem: {
        product_id: productId,
        product_name: displayName,
        error_code: "NON_TEST_PRODUCT_INCLUDED",
        error_message: "テスト商品（is_test=true）ではないため対象外になりました。",
      },
    };
  }
  if (!testOnly && isTest) {
    return {
      eligible: false,
      excludedItem: {
        product_id: productId,
        product_name: displayName,
        error_code: "TEST_PRODUCT_INCLUDED",
        error_message: "テスト商品（is_test=true）のため通常モードの予約から除外しました。",
      },
    };
  }

  const recordStatus = asTrimmedString(productRow.record_status) || "active";
  if (recordStatus !== "active") {
    return {
      eligible: false,
      excludedItem: {
        product_id: productId,
        product_name: displayName,
        error_code: "INACTIVE_PRODUCT_NOT_ALLOWED",
        error_message: "予約後にアーカイブ済みとなったため対象外になりました。",
      },
    };
  }

  const publishStatus = asTrimmedString(productRow.publish_status) || "draft";
  if (publishStatus !== "draft") {
    return {
      eligible: false,
      excludedItem: {
        product_id: productId,
        product_name: displayName,
        error_code: "PUBLISHED_PRODUCT_NOT_ALLOWED",
        error_message:
          publishStatus === "published"
            ? "予約後に公開済みとなったため対象外になりました。"
            : "下書き以外の公開状態（非公開）のため対象外になりました。",
      },
    };
  }

  if (hasAnySquareLink(productRow)) {
    return {
      eligible: false,
      excludedItem: {
        product_id: productId,
        product_name: displayName,
        error_code: "SQUARE_LINKED_PRODUCT_NOT_ALLOWED",
        error_message: "Square連携済み商品のため対象外になりました。",
      },
    };
  }

  const validImages = (
    Array.isArray(productRow.product_images) ? productRow.product_images : []
  ).filter((im) => im && Boolean(asTrimmedString(im.file_id)));
  if (validImages.length === 0) {
    return {
      eligible: false,
      excludedItem: {
        product_id: productId,
        product_name: displayName,
        error_code: "NO_IMAGES_FOUND",
        error_message: "商品画像が0枚のため対象外になりました。",
      },
    };
  }

  const currentSavedSelected = normalizeStringArray(productRow.selected_image_ids);
  const snapshotSelected = normalizeStringArray(reservedSelectedIds);
  const effectiveSelected =
    currentSavedSelected.length > 0 ? currentSavedSelected : snapshotSelected;

  if (effectiveSelected.length > 0) {
    if (effectiveSelected.length > AI_DRAFT_CONFIG.MAX_IMAGES) {
      return {
        eligible: false,
        excludedItem: {
          product_id: productId,
          product_name: displayName,
          error_code: "IMAGE_COUNT_EXCEEDED",
          error_message: `AI解析用の選択画像数が上限（${AI_DRAFT_CONFIG.MAX_IMAGES}枚）を超えているため対象外になりました。`,
        },
      };
    }
    const ownedFileIds = new Set(
      validImages.map((im) => asTrimmedString(im.file_id))
    );
    if (effectiveSelected.some((fid) => !ownedFileIds.has(fid))) {
      return {
        eligible: false,
        excludedItem: {
          product_id: productId,
          product_name: displayName,
          error_code: "SELECTED_IMAGE_DELETED",
          error_message:
            "選択されていたAI解析用画像が削除・変更されたため対象外になりました。",
        },
      };
    }
  }

  return {
    eligible: true,
    selectedImageIds: effectiveSelected,
  };
}

/**
 * Creates a staff-scheduled AI batch reservation (`POST /ai-batch-schedules`).
 * - Fixes exact staff-selected `product_ids` (1..500) at reservation time; never adds/substitutes IDs.
 * - Enforces bidirectional `is_test` isolation at reservation time.
 * - Does NOT call external `documents-relay` at reservation time (costs are fetched at execution time),
 *   so 200-500 item reservations complete immediately without browser timeout risk.
 */
export async function createAiBatchSchedule({
  supabase,
  payload = {},
  now = new Date(),
  maxScheduleSize,
}) {
  try {
    const requestId = asTrimmedString(payload?.request_id);
    if (!requestId) {
      return {
        status: 400,
        body: {
          success: false,
          error_code: "REQUEST_ID_REQUIRED",
          error: "request_id is required",
          message: "予約の重複防止キー（request_id）が必要です。",
        },
      };
    }

    const rawScheduledAt = asTrimmedString(payload?.scheduled_at);
    if (!rawScheduledAt) {
      return {
        status: 400,
        body: {
          success: false,
          error_code: "INVALID_SCHEDULED_AT",
          error: "scheduled_at is required",
          message: "開始日時（scheduled_at）を指定してください。",
        },
      };
    }
    const scheduledMs = Date.parse(rawScheduledAt);
    if (!Number.isFinite(scheduledMs)) {
      return {
        status: 400,
        body: {
          success: false,
          error_code: "INVALID_SCHEDULED_AT",
          error: `Invalid scheduled_at: ${rawScheduledAt}`,
          message: "開始日時の形式が正しくありません。",
        },
      };
    }
    const scheduledIso = new Date(scheduledMs).toISOString();

    if (
      payload?.test_only !== undefined &&
      payload?.test_only !== null &&
      typeof payload.test_only !== "boolean"
    ) {
      return {
        status: 400,
        body: {
          success: false,
          error_code: "INVALID_TEST_ONLY_FLAG",
          error: "test_only must be a boolean",
          message: "test_only には真偽値（true / false）を指定してください。",
        },
      };
    }
    const testOnly = payload?.test_only === true;

    if (
      payload?.force_regenerate !== undefined &&
      payload?.force_regenerate !== null &&
      typeof payload.force_regenerate !== "boolean"
    ) {
      return {
        status: 400,
        body: {
          success: false,
          error_code: "INVALID_FORCE_REGENERATE_FLAG",
          error: "force_regenerate must be a boolean",
          message: "force_regenerate には真偽値（true / false）を指定してください。",
        },
      };
    }
    const forceRegenerate = payload?.force_regenerate === true;

    const rawProductIds = payload?.product_ids;
    if (!Array.isArray(rawProductIds) || rawProductIds.length === 0) {
      return {
        status: 400,
        body: {
          success: false,
          error_code: "INVALID_PRODUCT_IDS",
          error: "product_ids must be a non-empty array",
          message: "予約対象の商品IDを1件以上選択してください。",
        },
      };
    }

    const uniqueProductIds = [];
    const seen = new Set();
    for (const rawId of rawProductIds) {
      const pid = asTrimmedString(rawId);
      if (pid && !seen.has(pid)) {
        seen.add(pid);
        uniqueProductIds.push(pid);
      }
    }
    if (uniqueProductIds.length === 0) {
      return {
        status: 400,
        body: {
          success: false,
          error_code: "INVALID_PRODUCT_IDS",
          error: "No valid product_ids provided",
          message: "有効な商品IDが含まれていません。",
        },
      };
    }

    const effectiveMaxSize =
      maxScheduleSize !== undefined && maxScheduleSize !== null
        ? resolveMaxManualBatchSize(maxScheduleSize)
        : resolveMaxManualBatchSize(AI_BATCH_SCHEDULE_CONFIG.MAX_SCHEDULE_SIZE);
    if (uniqueProductIds.length > effectiveMaxSize) {
      return {
        status: 400,
        body: {
          success: false,
          error_code: "BATCH_SIZE_EXCEEDED",
          error: `Maximum schedule size is ${effectiveMaxSize} (received ${uniqueProductIds.length})`,
          message: `一度に予約できる商品は最大${effectiveMaxSize}件までです（選択: ${uniqueProductIds.length}件）。`,
        },
      };
    }

    validateLegacyGrossMarginRateIfPresent_(payload?.min_gross_margin_rate);
    const rawMarkupRate =
      payload?.min_cost_markup_rate !== undefined
        ? payload.min_cost_markup_rate
        : payload?.min_markup_rate;
    const minCostMarkupRate = validateMinCostMarkupRateInput_(rawMarkupRate, false);

    // 1. Fast-path idempotency check BEFORE checking past timestamp (so retries after clock drift still succeed)
    const { data: existingRow, error: existErr } = await supabase
      .from("ai_batch_schedules")
      .select("*")
      .eq("request_id", requestId)
      .maybeSingle();
    if (existErr) {
      throw new Error(
        `Supabase ai_batch_schedules lookup failed: ${existErr.message}`
      );
    }
    if (existingRow) {
      if (testOnly && existingRow.test_only !== true) {
        return {
          status: 400,
          body: {
            success: false,
            error_code: "NON_TEST_PRODUCT_INCLUDED",
            error: `request_id ${requestId} is already bound to a non-test schedule`,
            message:
              "指定された request_id は通常モードの予約で使用済みのため、テストモードでは再利用できません。",
          },
        };
      }
      if (!testOnly && existingRow.test_only === true) {
        return {
          status: 400,
          body: {
            success: false,
            error_code: "TEST_PRODUCT_INCLUDED",
            error: `request_id ${requestId} is already bound to a test schedule`,
            message:
              "指定された request_id はテストモードの予約で使用済みのため、通常モードでは再利用できません。",
          },
        };
      }
      const detail = await getAiBatchSchedule({
        supabase,
        scheduleId: existingRow.schedule_id,
      });
      return {
        status: 200,
        body: {
          ...detail.body,
          is_reused: true,
        },
      };
    }

    const nowObj = now instanceof Date ? now : new Date(now);
    const nowMs = nowObj.getTime();
    if (scheduledMs < nowMs - AI_BATCH_SCHEDULE_CONFIG.PAST_TOLERANCE_MS) {
      return {
        status: 400,
        body: {
          success: false,
          error_code: "SCHEDULED_AT_IN_PAST",
          error: "scheduled_at cannot be in the past",
          message: "開始日時は現在以降の日時（日本時間）を指定してください。",
        },
      };
    }

    // 2. Verify product existence + bidirectional mode isolation + snapshot names & selected_image_ids
    const productRowById = new Map();
    const chunkSize = 200;
    for (let i = 0; i < uniqueProductIds.length; i += chunkSize) {
      const chunk = uniqueProductIds.slice(i, i + chunkSize);
      const { data: rows, error: prodErr } = await supabase
        .from("products")
        .select("product_id, is_test, product_name, selected_image_ids")
        .in("product_id", chunk);
      if (prodErr) {
        throw new Error(
          `Supabase schedule product verification failed: ${prodErr.message}`
        );
      }
      for (const r of rows || []) {
        productRowById.set(asTrimmedString(r.product_id), r);
      }
    }

    if (testOnly) {
      const nonTestProductIds = uniqueProductIds.filter((pid) => {
        const r = productRowById.get(pid);
        return !r || r.is_test !== true;
      });
      if (nonTestProductIds.length > 0) {
        return {
          status: 400,
          body: {
            success: false,
            error_code: "NON_TEST_PRODUCT_INCLUDED",
            error: `Test schedule rejected because non-test or unknown product IDs were included: ${nonTestProductIds.join(", ")}`,
            message: `テストモードの予約ではテスト商品（is_test=true）のみ対象にできます。実商品または未登録の商品IDが含まれているため受付前に拒否しました: ${nonTestProductIds.join(", ")}`,
            non_test_product_ids: nonTestProductIds,
          },
        };
      }
    } else {
      const testProductIds = uniqueProductIds.filter(
        (pid) => productRowById.get(pid)?.is_test === true
      );
      if (testProductIds.length > 0) {
        return {
          status: 400,
          body: {
            success: false,
            error_code: "TEST_PRODUCT_INCLUDED",
            error: `Normal schedule rejected because test product IDs were included: ${testProductIds.join(", ")}`,
            message: `通常モードの予約では実商品（is_test=false）のみ対象にできます。テスト商品が含まれているため受付前に拒否しました: ${testProductIds.join(", ")}`,
            test_product_ids: testProductIds,
          },
        };
      }
      const missingProductIds = uniqueProductIds.filter(
        (pid) => !productRowById.has(pid)
      );
      if (missingProductIds.length > 0) {
        return {
          status: 400,
          body: {
            success: false,
            error_code: "PRODUCT_NOT_FOUND",
            error: `Unknown product IDs included in schedule: ${missingProductIds.join(", ")}`,
            message: `未登録の商品IDが含まれているため予約できません: ${missingProductIds.join(", ")}`,
            missing_product_ids: missingProductIds,
          },
        };
      }
    }

    // 3. Reject overlapping active products (scheduled / pending / processing) BEFORE inserting reservation
    const conflictCheck = await findActiveAiBatchProductConflicts(
      supabase,
      uniqueProductIds
    );
    if (conflictCheck.has_conflict) {
      return buildActiveProductConflictResponse(conflictCheck);
    }

    const callerNames = normalizeProductNamesMap(
      payload?.product_names,
      uniqueProductIds
    );
    const liveTitlesMap = await resolveProductDisplayTitlesMap(
      supabase,
      uniqueProductIds,
      callerNames
    );
    const productNamesJson = {};
    const selectedSnapshot = {};
    for (const pid of uniqueProductIds) {
      const r = productRowById.get(pid);
      productNamesJson[pid] =
        callerNames[pid] ||
        asTrimmedString(liveTitlesMap[pid]) ||
        asTrimmedString(r?.product_name) ||
        pid;
      const savedSelected = normalizeStringArray(r?.selected_image_ids);
      if (savedSelected.length > 0) {
        selectedSnapshot[pid] = savedSelected;
      }
    }

    const scheduleId = generateScheduleId();
    const { data: rpcRes, error: rpcErr } = await supabase.rpc(
      "create_ai_batch_schedule_atomic",
      {
        p_schedule_id: scheduleId,
        p_request_id: requestId,
        p_scheduled_at: scheduledIso,
        p_product_ids: uniqueProductIds,
        p_product_names_json: productNamesJson,
        p_selected_image_ids_by_product: selectedSnapshot,
        p_min_cost_markup_rate: minCostMarkupRate,
        p_test_only: testOnly,
        p_force_regenerate: forceRegenerate,
      }
    );
    if (rpcErr || !rpcRes?.schedule) {
      const parsedRaceConflict = parseDbActiveConflictError(rpcErr);
      if (parsedRaceConflict) {
        return parsedRaceConflict;
      }
      throw new Error(
        `Failed creating AI batch schedule: ${rpcErr?.message || "empty RPC result"}`
      );
    }

    return {
      status: 200,
      body: {
        ...formatScheduleDetail(rpcRes.schedule, null, [], liveTitlesMap),
        is_reused: Boolean(rpcRes.is_reused),
      },
    };
  } catch (err) {
    if (err instanceof AiDraftError || err?.error_code) {
      const code = err.errorCode || err.error_code || "SCHEDULE_CREATION_FAILED";
      const status = err.status && err.status >= 400 ? err.status : 400;
      return {
        status,
        body: {
          success: false,
          error_code: code,
          error: err.message,
          message: err.message,
        },
      };
    }
    throw err;
  }
}

/**
 * Fetches a single AI batch reservation with full item/exclusion/batch progress from Supabase
 * (`GET /ai-batch-schedules/:scheduleId`). Works after closing and reopening the browser.
 */
export async function getAiBatchSchedule({
  supabase,
  scheduleId,
  testOnly,
  triggerWorker,
}) {
  const requestedId = asTrimmedString(scheduleId);
  if (!requestedId) {
    return {
      status: 400,
      body: {
        success: false,
        error_code: "SCHEDULE_ID_REQUIRED",
        error: "schedule_id is required",
        message: "予約ID（schedule_id）が必要です。",
      },
    };
  }

  let scheduleRow = null;
  if (requestedId === "latest") {
    let query = supabase
      .from("ai_batch_schedules")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(1);
    if (typeof testOnly === "boolean") {
      query = query.eq("test_only", testOnly);
    }
    const { data, error } = await query.maybeSingle();
    if (error) {
      throw new Error(`Failed reading latest ai_batch_schedules: ${error.message}`);
    }
    scheduleRow = data || null;
  } else {
    const { data, error } = await supabase
      .from("ai_batch_schedules")
      .select("*")
      .eq("schedule_id", requestedId)
      .maybeSingle();
    if (error) {
      throw new Error(
        `Failed reading ai_batch_schedules (${requestedId}): ${error.message}`
      );
    }
    scheduleRow = data || null;
  }

  if (
    !scheduleRow ||
    (typeof testOnly === "boolean" && Boolean(scheduleRow.test_only) !== testOnly)
  ) {
    return {
      status: 404,
      body: {
        success: false,
        error_code: "SCHEDULE_NOT_FOUND",
        error: `Schedule not found: ${requestedId}`,
        message: `指定された予約が見つかりません: ${requestedId}`,
      },
    };
  }

  let jobRow = null;
  let itemRows = [];
  const linkedBatchId = asTrimmedString(scheduleRow.batch_id);
  if (linkedBatchId) {
    const [{ data: jData, error: jErr }, { data: iData, error: iErr }] =
      await Promise.all([
        supabase
          .from("ai_batch_jobs")
          .select("*")
          .eq("batch_id", linkedBatchId)
          .maybeSingle(),
        supabase
          .from("ai_batch_items")
          .select("*")
          .eq("batch_id", linkedBatchId)
          .order("item_index", { ascending: true }),
      ]);
    if (jErr) {
      throw new Error(
        `Failed reading linked ai_batch_jobs (${linkedBatchId}): ${jErr.message}`
      );
    }
    if (iErr) {
      throw new Error(
        `Failed reading linked ai_batch_items (${linkedBatchId}): ${iErr.message}`
      );
    }
    jobRow = jData || null;
    itemRows = iData || [];

    if (typeof triggerWorker === "function" && itemRows.length > 0) {
      const nowMs = Date.now();
      const hasReadyInBatch = itemRows.some((r) => {
        const st = asTrimmedString(r.status);
        if (st === "pending") {
          const nextStr = asTrimmedString(r.next_retry_at);
          return !nextStr || new Date(nextStr).getTime() <= nowMs;
        }
        if (st === "processing") {
          const leaseStr = asTrimmedString(r.lease_expires_at);
          return Boolean(leaseStr) && new Date(leaseStr).getTime() <= nowMs;
        }
        return false;
      });
      if (hasReadyInBatch) {
        void Promise.resolve(
          triggerWorker({ reason: "schedule_poll_wakeup", batchId: linkedBatchId })
        ).catch(() => {});
      }
    }
  }

  const liveNamesMap = await resolveProductDisplayTitlesMap(
    supabase,
    normalizeStringArray(scheduleRow.product_ids),
    scheduleRow.product_names_json &&
      typeof scheduleRow.product_names_json === "object" &&
      !Array.isArray(scheduleRow.product_names_json)
      ? scheduleRow.product_names_json
      : {}
  );

  return {
    status: 200,
    body: formatScheduleDetail(scheduleRow, jobRow, itemRows, liveNamesMap),
  };
}

/**
 * Lists unified AI batch runs — BOTH standalone immediate executions (`ai_batch_jobs`)
 * AND staff-scheduled reservations (`ai_batch_schedules`) — for the current mode (`GET /ai-batch-runs`).
 * Enables any device / fresh browser without localStorage to view active progress, history, and results.
 */
export async function listAiBatchRuns({
  supabase,
  testOnly = false,
  limit = 20,
}) {
  const expectedIsTest = Boolean(testOnly);
  const rawLimit = Number(limit);
  const effectiveLimit = Number.isFinite(rawLimit)
    ? Math.min(50, Math.max(1, Math.trunc(rawLimit)))
    : 20;

  const [
    { data: recentScheduleRows, error: recentSchedErr },
    { data: activeScheduleRows, error: activeSchedErr },
    { data: recentJobRows, error: recentJobErr },
    { data: activeJobRows, error: activeJobErr },
  ] = await Promise.all([
    supabase
      .from("ai_batch_schedules")
      .select("*")
      .eq("test_only", expectedIsTest)
      .order("created_at", { ascending: false })
      .limit(effectiveLimit),
    supabase
      .from("ai_batch_schedules")
      .select("*")
      .eq("test_only", expectedIsTest)
      .in("status", ["scheduled", "starting", "dispatch_retry", "started"])
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("ai_batch_jobs")
      .select("*")
      .eq("test_only", expectedIsTest)
      .order("created_at", { ascending: false })
      .limit(effectiveLimit),
    supabase
      .from("ai_batch_jobs")
      .select("*")
      .eq("test_only", expectedIsTest)
      .in("status", ["queued", "processing"])
      .order("created_at", { ascending: false })
      .limit(50),
  ]);

  if (recentSchedErr || activeSchedErr) {
    throw new Error(
      `Failed listing ai_batch_schedules for unified runs: ${
        (recentSchedErr || activeSchedErr)?.message
      }`
    );
  }
  if (recentJobErr || activeJobErr) {
    throw new Error(
      `Failed listing ai_batch_jobs for unified runs: ${
        (recentJobErr || activeJobErr)?.message
      }`
    );
  }

  const scheduleById = new Map();
  for (const r of [
    ...(Array.isArray(activeScheduleRows) ? activeScheduleRows : []),
    ...(Array.isArray(recentScheduleRows) ? recentScheduleRows : []),
  ]) {
    const sid = asTrimmedString(r?.schedule_id);
    if (sid && !scheduleById.has(sid)) {
      scheduleById.set(sid, r);
    }
  }

  const jobById = new Map();
  for (const j of [
    ...(Array.isArray(activeJobRows) ? activeJobRows : []),
    ...(Array.isArray(recentJobRows) ? recentJobRows : []),
  ]) {
    const bid = asTrimmedString(j?.batch_id);
    if (bid && !jobById.has(bid)) {
      jobById.set(bid, j);
    }
  }

  // Ensure any batch_id linked from schedule rows is loaded into jobById
  const missingLinkedBatchIds = [
    ...new Set(
      [...scheduleById.values()]
        .map((r) => asTrimmedString(r.batch_id))
        .filter((bid) => bid && !jobById.has(bid))
    ),
  ];
  if (missingLinkedBatchIds.length > 0) {
    const { data: extraJobs, error: extraJobErr } = await supabase
      .from("ai_batch_jobs")
      .select("*")
      .in("batch_id", missingLinkedBatchIds);
    if (extraJobErr) {
      throw new Error(
        `Failed reading linked ai_batch_jobs for unified runs: ${extraJobErr.message}`
      );
    }
    for (const j of extraJobs || []) {
      const bid = asTrimmedString(j?.batch_id);
      if (bid) jobById.set(bid, j);
    }
  }

  // Deduplicate: any batch_id owned by an ai_batch_schedules row is surfaced as `run_type: "scheduled"`
  const scheduleOwnedBatchIds = new Set(
    [...scheduleById.values()]
      .map((r) => asTrimmedString(r.batch_id))
      .filter(Boolean)
  );
  const candidateJobIds = [...jobById.keys()].filter(
    (bid) => !scheduleOwnedBatchIds.has(bid)
  );
  if (candidateJobIds.length > 0) {
    const { data: linkedSchedRefs, error: linkedRefErr } = await supabase
      .from("ai_batch_schedules")
      .select("schedule_id, batch_id")
      .in("batch_id", candidateJobIds);
    if (linkedRefErr) {
      throw new Error(
        `Failed checking schedule ownership for ai_batch_jobs: ${linkedRefErr.message}`
      );
    }
    for (const ref of linkedSchedRefs || []) {
      const bid = asTrimmedString(ref?.batch_id);
      if (bid) scheduleOwnedBatchIds.add(bid);
    }
  }

  const unifiedRuns = [];

  for (const schedRow of scheduleById.values()) {
    const linkedJob =
      jobById.get(asTrimmedString(schedRow.batch_id)) || null;
    const summary = formatScheduleSummary(schedRow, linkedJob);
    const isActive =
      summary.overall_status === "scheduled" ||
      summary.overall_status === "starting" ||
      summary.overall_status === "dispatch_retry" ||
      summary.overall_status === "queued" ||
      summary.overall_status === "processing";
    unifiedRuns.push({
      run_key: `schedule:${summary.schedule_id}`,
      run_type: "scheduled",
      schedule_id: summary.schedule_id,
      batch_id: summary.batch_id,
      job_source: linkedJob
        ? asTrimmedString(linkedJob.job_source) || "scheduled_nightly"
        : "scheduled_nightly",
      overall_status: summary.overall_status,
      is_active: isActive,
      can_cancel: summary.can_cancel,
      all_excluded: summary.all_excluded,
      test_only: summary.test_only,
      force_regenerate: summary.force_regenerate,
      scheduled_at: summary.scheduled_at,
      scheduled_at_jst: summary.scheduled_at_jst,
      started_at: summary.started_at,
      completed_at: summary.completed_at,
      created_at: summary.created_at,
      created_at_jst: summary.created_at_jst,
      updated_at: summary.updated_at,
      total_count: summary.total_reserved_count,
      eligible_count: summary.eligible_count,
      completed_count: summary.completed_count,
      failed_count: summary.failed_count,
      processing_count: summary.processing_count,
      pending_count: summary.pending_count,
      excluded_count: summary.excluded_count,
      min_cost_markup_rate: summary.min_cost_markup_rate,
      dispatch_error_message: summary.dispatch_error_message,
    });
  }

  for (const [bid, jobRow] of jobById.entries()) {
    if (scheduleOwnedBatchIds.has(bid)) continue;
    const jobStatus = asTrimmedString(jobRow.status) || "queued";
    const totalCount = Number(jobRow.total_count || 0);
    const completedCount = Number(jobRow.completed_count || 0);
    const failedCount = Number(jobRow.failed_count || 0);
    const processingCount = Number(jobRow.processing_count || 0);
    const pendingCount = Math.max(
      0,
      totalCount - completedCount - failedCount - processingCount
    );
    const rate = Number(
      jobRow.min_cost_markup_rate ?? AI_DRAFT_CONFIG.DEFAULT_MIN_COST_MARKUP_RATE
    );
    const isActive = jobStatus === "queued" || jobStatus === "processing";
    unifiedRuns.push({
      run_key: `batch:${bid}`,
      run_type: "immediate",
      schedule_id: null,
      batch_id: bid,
      job_source: asTrimmedString(jobRow.job_source) || "manual",
      overall_status: jobStatus,
      is_active: isActive,
      can_cancel: false,
      all_excluded: false,
      test_only: Boolean(jobRow.test_only),
      force_regenerate: Boolean(jobRow.force_regenerate),
      scheduled_at: null,
      scheduled_at_jst: null,
      started_at: asTrimmedString(jobRow.created_at) || null,
      completed_at: formatIsoOrNull(jobRow.completed_at),
      created_at: asTrimmedString(jobRow.created_at),
      created_at_jst: formatJstDateTimeDisplay(jobRow.created_at),
      updated_at: asTrimmedString(jobRow.updated_at),
      total_count: totalCount,
      eligible_count: totalCount,
      completed_count: completedCount,
      failed_count: failedCount,
      processing_count: processingCount,
      pending_count: pendingCount,
      excluded_count: 0,
      min_cost_markup_rate: rate,
      dispatch_error_message: null,
    });
  }

  // Keep ALL active runs plus the most recent inactive runs up to effectiveLimit, ordered newest-first
  unifiedRuns.sort((a, b) =>
    String(b.created_at || "").localeCompare(String(a.created_at || ""))
  );
  const activeList = unifiedRuns.filter((r) => r.is_active);
  const inactiveList = unifiedRuns.filter((r) => !r.is_active);
  const remainingSlots = Math.max(0, effectiveLimit - activeList.length);
  const finalRuns = [...activeList, ...inactiveList.slice(0, remainingSlots)].sort(
    (a, b) => String(b.created_at || "").localeCompare(String(a.created_at || ""))
  );

  return {
    status: 200,
    body: {
      success: true,
      write_master: "supabase",
      test_only: expectedIsTest,
      count: finalRuns.length,
      runs: finalRuns,
    },
  };
}

/**
 * Lists active & recent AI batch reservations for the current mode (`GET /ai-batch-schedules`).
 * Enables restoring scheduled / running / completed / failed / excluded state after reopening browser.
 */
export async function listAiBatchSchedules({
  supabase,
  testOnly = false,
  limit = AI_BATCH_SCHEDULE_CONFIG.DEFAULT_LIST_LIMIT,
}) {
  const expectedIsTest = Boolean(testOnly);
  const rawLimit = Number(limit);
  const effectiveLimit = Number.isFinite(rawLimit)
    ? Math.min(
        AI_BATCH_SCHEDULE_CONFIG.MAX_LIST_LIMIT,
        Math.max(1, Math.trunc(rawLimit))
      )
    : AI_BATCH_SCHEDULE_CONFIG.DEFAULT_LIST_LIMIT;

  const { data: scheduleRows, error: schedErr } = await supabase
    .from("ai_batch_schedules")
    .select("*")
    .eq("test_only", expectedIsTest)
    .order("created_at", { ascending: false })
    .limit(effectiveLimit);
  if (schedErr) {
    throw new Error(
      `Failed listing ai_batch_schedules: ${schedErr.message}`
    );
  }

  const rows = Array.isArray(scheduleRows) ? scheduleRows : [];
  const batchIds = [
    ...new Set(rows.map((r) => asTrimmedString(r.batch_id)).filter(Boolean)),
  ];

  const jobById = new Map();
  if (batchIds.length > 0) {
    const { data: jobRows, error: jobErr } = await supabase
      .from("ai_batch_jobs")
      .select("*")
      .in("batch_id", batchIds);
    if (jobErr) {
      throw new Error(
        `Failed reading ai_batch_jobs for schedules: ${jobErr.message}`
      );
    }
    for (const j of jobRows || []) {
      jobById.set(asTrimmedString(j.batch_id), j);
    }
  }

  const schedules = rows.map((r) =>
    formatScheduleSummary(r, jobById.get(asTrimmedString(r.batch_id)) || null)
  );

  return {
    status: 200,
    body: {
      success: true,
      write_master: "supabase",
      test_only: expectedIsTest,
      count: schedules.length,
      schedules,
    },
  };
}

/**
 * Cancels an AI batch reservation before execution starts (`POST /ai-batch-schedules/:scheduleId/cancel`).
 * Rejects with 409 if the reservation has already started.
 */
export async function cancelAiBatchSchedule({
  supabase,
  scheduleId,
  testOnly,
}) {
  const targetId = asTrimmedString(scheduleId);
  if (!targetId) {
    return {
      status: 400,
      body: {
        success: false,
        error_code: "SCHEDULE_ID_REQUIRED",
        error: "schedule_id is required",
        message: "予約ID（schedule_id）が必要です。",
      },
    };
  }

  if (typeof testOnly === "boolean") {
    const { data: existing, error: lookupErr } = await supabase
      .from("ai_batch_schedules")
      .select("schedule_id, test_only")
      .eq("schedule_id", targetId)
      .maybeSingle();
    if (lookupErr) {
      throw new Error(
        `Failed reading schedule before cancel (${targetId}): ${lookupErr.message}`
      );
    }
    if (!existing || Boolean(existing.test_only) !== testOnly) {
      return {
        status: 404,
        body: {
          success: false,
          error_code: "SCHEDULE_NOT_FOUND",
          error: `Schedule not found: ${targetId}`,
          message: `指定された予約が見つかりません: ${targetId}`,
        },
      };
    }
  }

  const { data: rpcRes, error: rpcErr } = await supabase.rpc(
    "cancel_ai_batch_schedule_atomic",
    { p_schedule_id: targetId }
  );
  if (rpcErr || !rpcRes) {
    throw new Error(
      `Failed cancelling schedule (${targetId}): ${rpcErr?.message || "empty RPC result"}`
    );
  }

  if (rpcRes.found === false) {
    return {
      status: 404,
      body: {
        success: false,
        error_code: "SCHEDULE_NOT_FOUND",
        error: `Schedule not found: ${targetId}`,
        message: `指定された予約が見つかりません: ${targetId}`,
      },
    };
  }

  if (rpcRes.cancelled !== true) {
    const detail = await getAiBatchSchedule({ supabase, scheduleId: targetId });
    return {
      status: 409,
      body: {
        success: false,
        error_code: "SCHEDULE_ALREADY_STARTED",
        error: "Cannot cancel a schedule that has already started",
        message: "すでに実行が開始されているため、予約を取り消せません。",
        schedule: detail.body,
      },
    };
  }

  return {
    status: 200,
    body: {
      ...formatScheduleDetail(rpcRes.schedule, null, []),
      is_reused: Boolean(rpcRes.is_reused),
    },
  };
}

/**
 * Lightweight periodic dispatcher (`POST /ai-batch-schedules/dispatch`) invoked by Cloud Scheduler.
 * - Claims ONLY due reservations (`scheduled_at <= now`) with atomic DB leases (never runs future schedules,
 *   never auto-searches or substitutes products).
 * - Evaluates fixed `product_ids` at execution time: records exclusion reasons for items that became
 *   published, archived, Square-linked, 0-image, mode-mismatched, or missing.
 * - Fetches confirmed purchase costs server-to-server via `documents-relay` (strict fail-closed).
 * - Enqueues eligible items into `ai_batch_jobs` / `ai_batch_items` with deterministic
 *   `SCHED_BATCH_<schedule_id>` so duplicate deliveries never create duplicate jobs.
 * - Also nudges the worker if any active batch has runnable items (ensuring 200-item multi-pass batches
 *   drain to 100% completion even with zero browsers open).
 */
export async function dispatchDueAiBatchSchedules({
  supabase,
  fetchImpl = globalThis.fetch,
  gasWebAppUrl,
  readdyBackendUrl = process.env.READDY_BACKEND_URL,
  readdyBackendAnonKey = process.env.READDY_BACKEND_ANON_KEY,
  now = new Date(),
  maxSchedules = 5,
  timeBudgetMs = AI_BATCH_SCHEDULE_CONFIG.DISPATCH_TIME_BUDGET_MS,
  triggerWorker,
}) {
  const nowObj = now instanceof Date ? now : new Date(now);
  const nowMs = nowObj.getTime();
  if (!Number.isFinite(nowMs)) {
    throw new AiDraftError(
      "INVALID_TIMESTAMP",
      "Invalid timestamp passed to dispatchDueAiBatchSchedules",
      { status: 400 }
    );
  }
  const nowIso = new Date(nowMs).toISOString();
  const limit = Math.max(1, Math.min(20, Math.trunc(Number(maxSchedules) || 5)));
  const dispatchWallStartMs = Date.now();
  const effectiveTimeBudgetMs = Number.isFinite(Number(timeBudgetMs))
    ? Math.max(0, Number(timeBudgetMs))
    : AI_BATCH_SCHEDULE_CONFIG.DISPATCH_TIME_BUDGET_MS;

  const results = [];
  let claimedCount = 0;
  let shouldWakeWorker = false;

  // Claim 1 due schedule at a time while within DISPATCH_TIME_BUDGET_MS (90s)
  // so multiple 200-item schedules never stack up past Cloud Scheduler's 180s attemptDeadline.
  for (let slot = 0; slot < limit; slot++) {
    if (slot > 0 && Date.now() - dispatchWallStartMs >= effectiveTimeBudgetMs) {
      break;
    }
    const { data: claimedRows, error: claimErr } = await supabase.rpc(
      "claim_due_ai_batch_schedules",
      {
        p_limit: 1,
        p_lease_seconds: AI_BATCH_SCHEDULE_CONFIG.DISPATCH_LEASE_SECONDS,
        p_now: nowIso,
      }
    );
    if (claimErr) {
      throw new Error(
        `Failed claiming due AI batch schedules: ${claimErr.message}`
      );
    }
    const claimedBatch = Array.isArray(claimedRows) ? claimedRows : [];
    if (claimedBatch.length === 0) {
      break;
    }
    claimedCount += claimedBatch.length;
    const schedRow = claimedBatch[0];
    const scheduleId = asTrimmedString(schedRow.schedule_id);
    const dispatchToken = asTrimmedString(schedRow.dispatch_token);
    const testOnly = Boolean(schedRow.test_only);
    const fixedProductIds = normalizeStringArray(schedRow.product_ids);
    const namesMap =
      schedRow.product_names_json &&
      typeof schedRow.product_names_json === "object" &&
      !Array.isArray(schedRow.product_names_json)
        ? schedRow.product_names_json
        : {};
    const savedSelectedByPid =
      schedRow.selected_image_ids_by_product &&
      typeof schedRow.selected_image_ids_by_product === "object" &&
      !Array.isArray(schedRow.selected_image_ids_by_product)
        ? schedRow.selected_image_ids_by_product
        : {};
    const batchRequestId = buildScheduleBatchRequestId(scheduleId);

    // 1. Crash-recovery idempotency check: if deterministic batch already exists, link without re-creating
    const { data: existingJob, error: existJobErr } = await supabase
      .from("ai_batch_jobs")
      .select("*")
      .eq("request_id", batchRequestId)
      .maybeSingle();
    if (existJobErr) {
      throw new Error(
        `Failed checking existing batch for schedule (${scheduleId}): ${existJobErr.message}`
      );
    }
    if (existingJob) {
      const { data: existingItems } = await supabase
        .from("ai_batch_items")
        .select("product_id")
        .eq("batch_id", existingJob.batch_id);
      const includedSet = new Set(
        (existingItems || []).map((r) => asTrimmedString(r.product_id))
      );
      const recoveredExcluded = normalizeExcludedItemsList(
        schedRow.excluded_items_json
      );
      const excludedToSave =
        recoveredExcluded.length > 0
          ? recoveredExcluded
          : fixedProductIds
              .filter((pid) => !includedSet.has(pid))
              .map((pid) => ({
                product_id: pid,
                product_name: asTrimmedString(namesMap[pid]) || pid,
                error_code: "EXCLUDED_BEFORE_START",
                error_message: "実行前の商品状態確認により対象外になりました。",
              }));

      await supabase.rpc("complete_ai_batch_schedule_dispatch", {
        p_schedule_id: scheduleId,
        p_dispatch_token: dispatchToken,
        p_outcome: "started",
        p_batch_id: existingJob.batch_id,
        p_excluded_items_json: excludedToSave,
      });
      shouldWakeWorker = true;
      results.push({
        schedule_id: scheduleId,
        outcome: "started_recovered",
        batch_id: existingJob.batch_id,
        eligible_count: includedSet.size,
        excluded_count: excludedToSave.length,
      });
      continue;
    }

    // 2. Load current product states ONLY for the fixed `fixedProductIds` (never search other products!)
    const productRowById = new Map();
    const chunkSize = 200;
    for (let i = 0; i < fixedProductIds.length; i += chunkSize) {
      const chunk = fixedProductIds.slice(i, i + chunkSize);
      const { data: pRows, error: pErr } = await supabase
        .from("products")
        .select(
          "product_id, is_test, record_status, publish_status, product_name, selected_image_ids, square_item_id, square_variation_id, square_payment_link_id, square_checkout_url, product_images(file_id)"
        )
        .in("product_id", chunk);
      if (pErr) {
        throw new Error(
          `Failed loading products for scheduled dispatch (${scheduleId}): ${pErr.message}`
        );
      }
      for (const r of pRows || []) {
        productRowById.set(asTrimmedString(r.product_id), r);
      }
    }

    const eligibleIds = [];
    const eligibleSelectedSnapshot = {};
    const excludedItems = [];

    for (const pid of fixedProductIds) {
      const evalRes = evaluateScheduledProductEligibility({
        productId: pid,
        productRow: productRowById.get(pid) || null,
        testOnly,
        reservedSelectedIds: savedSelectedByPid[pid],
        fallbackName: namesMap[pid],
      });
      if (!evalRes.eligible) {
        excludedItems.push(evalRes.excludedItem);
      } else {
        eligibleIds.push(pid);
        if (evalRes.selectedImageIds && evalRes.selectedImageIds.length > 0) {
          eligibleSelectedSnapshot[pid] = evalRes.selectedImageIds;
        }
      }
    }

    // 2.5. Exclude any product currently active in ANOTHER job/schedule (defensive guard against race)
    if (eligibleIds.length > 0) {
      const dispatchConflictCheck = await findActiveAiBatchProductConflicts(
        supabase,
        eligibleIds,
        { ignoreScheduleId: scheduleId }
      );
      if (dispatchConflictCheck.has_conflict) {
        const conflictSet = new Set(dispatchConflictCheck.conflicting_product_ids);
        const remainingEligible = [];
        for (const pid of eligibleIds) {
          if (conflictSet.has(pid)) {
            delete eligibleSelectedSnapshot[pid];
            excludedItems.push({
              product_id: pid,
              product_name:
                asTrimmedString(productRowById.get(pid)?.product_name) ||
                asTrimmedString(namesMap[pid]) ||
                pid,
              error_code: "PRODUCT_ALREADY_IN_ACTIVE_AI_BATCH",
              error_message:
                "別のAI一括生成ジョブで予約中または処理中のため対象外になりました。",
            });
          } else {
            remainingEligible.push(pid);
          }
        }
        eligibleIds.length = 0;
        eligibleIds.push(...remainingEligible);
      }
    }

    // 3. If all reserved items became ineligible before start time, mark schedule completed_all_excluded
    if (eligibleIds.length === 0) {
      await supabase.rpc("complete_ai_batch_schedule_dispatch", {
        p_schedule_id: scheduleId,
        p_dispatch_token: dispatchToken,
        p_outcome: "completed_all_excluded",
        p_excluded_items_json: excludedItems,
      });
      results.push({
        schedule_id: scheduleId,
        outcome: "completed_all_excluded",
        batch_id: null,
        eligible_count: 0,
        excluded_count: excludedItems.length,
      });
      continue;
    }

    // 4. Resolve purchase costs server-to-server as auxiliary information at execution time.
    // Even if 1 item or all items fail/time out during cost lookup, start the batch for all eligibleIds
    // and record which product_ids had cost lookup failures in `product_costs_json`.
    const productCostsJson = await resolveConfirmedProductCostsForBatch({
      fetchImpl,
      readdyBackendUrl,
      readdyBackendAnonKey,
      actorType: "internal",
      requireServerCostLookup: true,
      productIds: eligibleIds,
    });
    const costFetchFailedProductIds = eligibleIds.filter((pid) => {
      const entry = productCostsJson?.[pid];
      const st = asTrimmedString(entry?.cost_status || entry?.costStatus).toLowerCase();
      return st === "lookup_failed" || entry?.cost_lookup_failed === true;
    });

    // 5. Enqueue into existing `ai_batch_jobs` / `ai_batch_items` atomically
    const newBatchId = generateBatchId();
    const minCostMarkupRate = Number(
      schedRow.min_cost_markup_rate ?? AI_DRAFT_CONFIG.DEFAULT_MIN_COST_MARKUP_RATE
    );
    const { data: enqueueData, error: enqueueErr } = await supabase.rpc(
      "enqueue_ai_batch_job_atomic",
      {
        p_batch_id: newBatchId,
        p_request_id: batchRequestId,
        p_product_ids: eligibleIds,
        p_job_source: "scheduled_nightly",
        p_force_regenerate: Boolean(schedRow.force_regenerate),
        p_model_name: resolveAiDraftModelName(),
        p_min_cost_markup_rate: minCostMarkupRate,
        p_product_costs_json: productCostsJson,
        p_selected_image_ids_by_product: eligibleSelectedSnapshot,
        p_test_only: testOnly,
        p_ignore_schedule_id: scheduleId,
      }
    );
    if (enqueueErr || !enqueueData?.job) {
      throw new Error(
        `Failed enqueueing scheduled AI batch (${scheduleId}): ${
          enqueueErr?.message || "empty RPC result"
        }`
      );
    }

    const finalBatchId = asTrimmedString(enqueueData.job.batch_id);
    await supabase.rpc("complete_ai_batch_schedule_dispatch", {
      p_schedule_id: scheduleId,
      p_dispatch_token: dispatchToken,
      p_outcome: "started",
      p_batch_id: finalBatchId,
      p_excluded_items_json: excludedItems,
    });

    shouldWakeWorker = true;
    results.push({
      schedule_id: scheduleId,
      outcome: "started",
      batch_id: finalBatchId,
      eligible_count: eligibleIds.length,
      excluded_count: excludedItems.length,
      cost_fetch_failed_count: costFetchFailedProductIds.length,
      cost_fetch_failed_product_ids: costFetchFailedProductIds,
    });
  }

  // Also check if any running batch still has runnable items (e.g. 200-item multi-pass batch)
  const workerHasRunnable =
    shouldWakeWorker || (await hasRunnableAiBatchQueueItems(supabase));
  let workerWakeup = null;
  if (workerHasRunnable && typeof triggerWorker === "function") {
    workerWakeup = await triggerWorker({ reason: "schedule_dispatch_tick" });
  }

  return {
    status: 200,
    body: {
      success: true,
      write_master: "supabase",
      checked_at: nowIso,
      claimed_count: claimedCount,
      results,
      worker_woken: Boolean(workerHasRunnable && triggerWorker),
      worker_wakeup: workerWakeup,
    },
  };
}

export function createAiBatchWorkerCoordinator({
  getSupabase,
  fetchImpl = globalThis.fetch,
  getGasWebAppUrl,
  getGeminiApiKey,
  getInternalSecret,
  getSelfApiUrl,
  concurrency,
  timeBudgetMs,
}) {
  let activeRunPromise = null;

  async function runLocalPass(overrideOptions = {}) {
    if (activeRunPromise) {
      return activeRunPromise;
    }
    const supabase = getSupabase();
    activeRunPromise = (async () => {
      try {
        const result = await processAiBatchQueuePass({
          supabase,
          fetchImpl,
          gasWebAppUrl: getGasWebAppUrl(),
          geminiApiKey: getGeminiApiKey(),
          internalSecret: getInternalSecret(),
          concurrency: overrideOptions.concurrency ?? concurrency,
          maxItems: overrideOptions.maxItems,
          timeBudgetMs: overrideOptions.timeBudgetMs ?? timeBudgetMs,
        });

        // Self-chain next HTTP invocation if queue still has runnable items after time budget
        if (result.remaining_runnable) {
          await dispatchWakeup({ reason: "self_chain_remaining", forceHttp: true });
        }
        return result;
      } finally {
        activeRunPromise = null;
      }
    })();
    return activeRunPromise;
  }

  async function dispatchWakeup({ reason = "wakeup", forceHttp = false } = {}) {
    if (!forceHttp && activeRunPromise) {
      return { dispatched: false, already_running_locally: true };
    }

    const selfUrl = asTrimmedString(getSelfApiUrl?.() || "").replace(/\/+$/, "");
    const secret = asTrimmedString(getInternalSecret?.() || "");

    if (selfUrl && secret) {
      const reqPromise = fetchImpl(`${selfUrl}/ai-batches/worker/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "X-Internal-Sync-Token": secret,
        },
        body: JSON.stringify({ trigger_reason: reason }),
      })
        .then((r) => r.text())
        .catch((err) => {
          console.warn(
            JSON.stringify({
              severity: "WARNING",
              message: `AI batch self-worker HTTP wakeup warning (${reason}): ${
                err instanceof Error ? err.message : String(err)
              }`,
            })
          );
        });

      await Promise.race([
        reqPromise,
        sleepMs(AI_BATCH_QUEUE_CONFIG.DISPATCH_HEADSTART_MS),
      ]);
      return { dispatched: true, mode: "http_self_invoke" };
    }

    // Fallback when running locally / in unit tests without `SELF_API_URL`
    void runLocalPass().catch((err) => {
      console.error(
        JSON.stringify({
          severity: "ERROR",
          message: `AI batch local worker error (${reason}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        })
      );
    });
    return { dispatched: true, mode: "in_process" };
  }

  return {
    runLocalPass,
    dispatchWakeup,
    isRunningLocally: () => Boolean(activeRunPromise),
  };
}
