import {
  asTrimmedString,
  convertDriveFileUrlToDisplayUrl,
  mapGasProductToSupabaseBundle,
  normalizeStringArray,
  toJsonNumber,
} from "./productMapper.mjs";
import { upsertProductBundle } from "./productsRepository.mjs";
import {
  flushPendingSupabaseDraftToSheets,
  hasAnySquareLink,
} from "./productWriter.mjs";
import { syncAiProductDraftsFromGas } from "./aiDraftService.mjs";

const RECONCILE_SELECT_COLUMNS = [
  "product_id",
  "row_seq",
  "category",
  "brand",
  "product_name",
  "translated_title",
  "condition",
  "purchase_price",
  "planned_sale_price",
  "storage_location",
  "publish_status",
  "inventory_status",
  "record_status",
  "sneaker_sku",
  "sneaker_size",
  "subcategory",
  "size",
  "official_sku",
  "auction_item_number",
  "square_item_id",
  "square_variation_id",
  "square_payment_link_id",
  "square_checkout_url",
  "drive_folder_url",
  "main_image_url",
  "main_image_display_url",
  "selected_image_ids",
  "write_source",
  "supabase_written_at",
  "sheets_mirror_pending",
  "synced_from_sheets_at",
  "is_test",
].join(",");

function sameStringArray(a, b) {
  const arrA = normalizeStringArray(a);
  const arrB = normalizeStringArray(b);
  if (arrA.length !== arrB.length) return false;
  for (let i = 0; i < arrA.length; i++) {
    if (arrA[i] !== arrB[i]) return false;
  }
  return true;
}

/**
 * Compares all summary-level columns between a GAS list row and a Supabase `products` row.
 * Returns true if ANY field or row_seq differs.
 */
export function hasSummaryDifference(sheetProduct, sbRow, expectedRowSeq) {
  if (!sbRow) return true;
  if (Number(sbRow.row_seq) !== expectedRowSeq) return true;

  const mainUrl = asTrimmedString(sheetProduct.main_image_url);
  const expectedDisplayUrl =
    asTrimmedString(sheetProduct.main_image_display_url) ||
    convertDriveFileUrlToDisplayUrl(mainUrl, "w800");

  const sheetSubcat = asTrimmedString(
    sheetProduct.subcategory ?? sheetProduct.sub_category
  );
  const sheetOfficialSku = asTrimmedString(
    sheetProduct.official_sku ?? sheetProduct.sku
  );
  const sheetSelectedIds =
    sheetProduct.selected_image_ids ?? sheetProduct.ai_selected_image_ids ?? [];

  if (asTrimmedString(sheetProduct.category) !== asTrimmedString(sbRow.category)) return true;
  if (asTrimmedString(sheetProduct.brand) !== asTrimmedString(sbRow.brand)) return true;
  if (asTrimmedString(sheetProduct.product_name) !== asTrimmedString(sbRow.product_name)) return true;
  if (asTrimmedString(sheetProduct.translated_title) !== asTrimmedString(sbRow.translated_title)) return true;
  if (asTrimmedString(sheetProduct.condition) !== asTrimmedString(sbRow.condition)) return true;
  if (toJsonNumber(sheetProduct.purchase_price, 0) !== toJsonNumber(sbRow.purchase_price, 0)) return true;
  if (toJsonNumber(sheetProduct.planned_sale_price, 0) !== toJsonNumber(sbRow.planned_sale_price, 0)) return true;
  if (asTrimmedString(sheetProduct.storage_location) !== asTrimmedString(sbRow.storage_location)) return true;
  if ((asTrimmedString(sheetProduct.publish_status) || "draft") !== asTrimmedString(sbRow.publish_status)) return true;
  if ((asTrimmedString(sheetProduct.inventory_status) || "in_stock") !== asTrimmedString(sbRow.inventory_status)) return true;
  if ((asTrimmedString(sheetProduct.record_status) || "active") !== asTrimmedString(sbRow.record_status)) return true;
  if (asTrimmedString(sheetProduct.sneaker_sku) !== asTrimmedString(sbRow.sneaker_sku)) return true;
  if (asTrimmedString(sheetProduct.sneaker_size) !== asTrimmedString(sbRow.sneaker_size)) return true;
  if (sheetSubcat !== asTrimmedString(sbRow.subcategory)) return true;
  if (asTrimmedString(sheetProduct.size) !== asTrimmedString(sbRow.size)) return true;
  if (sheetOfficialSku !== asTrimmedString(sbRow.official_sku)) return true;
  if (asTrimmedString(sheetProduct.auction_item_number) !== asTrimmedString(sbRow.auction_item_number)) return true;
  if (asTrimmedString(sheetProduct.square_item_id) !== asTrimmedString(sbRow.square_item_id)) return true;
  if (asTrimmedString(sheetProduct.square_variation_id) !== asTrimmedString(sbRow.square_variation_id)) return true;
  if (asTrimmedString(sheetProduct.square_payment_link_id) !== asTrimmedString(sbRow.square_payment_link_id)) return true;
  if (asTrimmedString(sheetProduct.square_checkout_url) !== asTrimmedString(sbRow.square_checkout_url)) return true;
  if (asTrimmedString(sheetProduct.drive_folder_url) !== asTrimmedString(sbRow.drive_folder_url)) return true;
  if (mainUrl !== asTrimmedString(sbRow.main_image_url)) return true;
  if (expectedDisplayUrl !== asTrimmedString(sbRow.main_image_display_url)) return true;
  if (!sameStringArray(sheetSelectedIds, sbRow.selected_image_ids)) return true;

  return false;
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
  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => next()
  );
  await Promise.all(runners);
  return results;
}

async function recordSyncRunStart(supabase, triggerSource) {
  try {
    const { data } = await supabase
      .from("product_sync_runs")
      .insert({ trigger_source: triggerSource, status: "running" })
      .select("id")
      .maybeSingle();
    return data?.id ?? null;
  } catch {
    return null;
  }
}

async function recordSyncRunFinish(supabase, runId, patch) {
  if (!runId) return;
  try {
    await supabase
      .from("product_sync_runs")
      .update({ ...patch, finished_at: new Date().toISOString() })
      .eq("id", runId);
  } catch {
    // Non-fatal audit logging failure
  }
}

/**
 * Reconciles Google Sheets (write master via GAS) -> Supabase (read master).
 * - Catches any changes made by GAS periodic triggers while browsers are closed
 *   (e.g. Square `sold` polling, AI batch worker updates, image/status changes, deletions).
 * - Fail-closed: never modifies or deletes Supabase rows if GAS returns an invalid/failed snapshot.
 */
export async function reconcileProductsFromGas({
  supabase,
  fetchImpl = globalThis.fetch,
  gasWebAppUrl,
  triggerSource = "scheduled",
  rollingLimit = 10,
  forceFull = false,
  allowBulkDelete = false,
  concurrency = 3,
}) {
  if (!gasWebAppUrl) {
    throw new Error("GAS_WEB_APP_URL is not configured");
  }

  const runId = await recordSyncRunStart(supabase, triggerSource);

  try {
    // 0. Flush any Supabase-authored draft edits whose synchronous Sheets mirror was deferred
    const protectedPendingIds = new Set();
    let flushedPendingCount = 0;
    const { data: pendingRows, error: pendingErr } = await supabase
      .from("products")
      .select("product_id")
      .eq("sheets_mirror_pending", true);
    if (!pendingErr && Array.isArray(pendingRows) && pendingRows.length > 0) {
      for (const pRow of pendingRows) {
        const pid = asTrimmedString(pRow.product_id);
        if (!pid) continue;
        try {
          const ok = await flushPendingSupabaseDraftToSheets({
            supabase,
            fetchImpl,
            gasWebAppUrl,
            productId: pid,
          });
          if (ok) {
            flushedPendingCount++;
          } else {
            protectedPendingIds.add(pid);
          }
        } catch {
          protectedPendingIds.add(pid);
        }
      }
    }

    // 1. Fetch full summary list from GAS (record_status=all)
    const listUrl = `${gasWebAppUrl}?mode=admin&record_status=all`;
    const listRes = await fetchImpl(listUrl, { method: "GET" });
    if (!listRes.ok) {
      throw new Error(`GAS full list failed with HTTP ${listRes.status}`);
    }
    const listJson = await listRes.json();
    if (!listJson || listJson.success !== true || !Array.isArray(listJson.products)) {
      throw new Error("GAS full list returned invalid payload (fail-closed)");
    }

    const sheetProducts = listJson.products;

    // 2. Fetch current Supabase summary state
    const { data: sbRows, error: sbErr } = await supabase
      .from("products")
      .select(RECONCILE_SELECT_COLUMNS);
    if (sbErr) {
      throw new Error(`Supabase products select failed: ${sbErr.message}`);
    }

    const sbProducts = sbRows || [];
    const sbMap = new Map(sbProducts.map((r) => [r.product_id, r]));
    const sheetIds = new Set();

    const totalSheets = sheetProducts.length;
    const dirtyTargets = [];
    const unchangedCandidates = [];

    sheetProducts.forEach((sp, idx) => {
      const pid = asTrimmedString(sp.product_id);
      if (!pid) return;
      sheetIds.add(pid);
      const expectedRowSeq = totalSheets - idx;
      const existing = sbMap.get(pid);

      // Protect Supabase-authored draft edits whose Sheets mirror is still pending
      if (
        (protectedPendingIds.has(pid) || existing?.sheets_mirror_pending === true) &&
        (asTrimmedString(sp.publish_status) || "draft") === "draft" &&
        !hasAnySquareLink(sp)
      ) {
        return;
      }

      if (forceFull || hasSummaryDifference(sp, existing, expectedRowSeq)) {
        dirtyTargets.push({ summary: sp, productId: pid, rowSeq: expectedRowSeq, reason: "diff" });
      } else if (rollingLimit > 0) {
        unchangedCandidates.push({
          summary: sp,
          productId: pid,
          rowSeq: expectedRowSeq,
          syncedAtMs: existing?.synced_from_sheets_at
            ? new Date(existing.synced_from_sheets_at).getTime() || 0
            : 0,
        });
      }
    });

    // Rolling refresh of oldest-synced rows catches detail-only edits (description, notes, images[], translations)
    let rollingTargets = [];
    if (!forceFull && rollingLimit > 0 && dirtyTargets.length < rollingLimit) {
      unchangedCandidates.sort((a, b) => a.syncedAtMs - b.syncedAtMs);
      const slots = rollingLimit - dirtyTargets.length;
      rollingTargets = unchangedCandidates.slice(0, slots).map((c) => ({
        summary: c.summary,
        productId: c.productId,
        rowSeq: c.rowSeq,
        reason: "rolling",
      }));
    }

    const targetsToSync = [...dirtyTargets, ...rollingTargets];

    // 3. Fetch full detail from GAS & upsert into Supabase for targets
    await mapWithConcurrency(targetsToSync, concurrency, async (target) => {
      const detailUrl = `${gasWebAppUrl}?mode=admin&product_id=${encodeURIComponent(
        target.productId
      )}`;
      const detRes = await fetchImpl(detailUrl, { method: "GET" });
      if (!detRes.ok) {
        throw new Error(
          `GAS detail fetch failed for ${target.productId} (HTTP ${detRes.status})`
        );
      }
      const detJson = await detRes.json();
      if (!detJson || detJson.success !== true || !detJson.product) {
        throw new Error(
          `GAS detail invalid for ${target.productId}: ${detJson?.error || "missing product"}`
        );
      }
      const bundle = mapGasProductToSupabaseBundle({
        summary: target.summary,
        detail: detJson.product,
        rowSeq: target.rowSeq,
      });
      const existing = sbMap.get(target.productId);
      if (existing && typeof existing.is_test === "boolean") {
        bundle.productRow.is_test = existing.is_test;
      }
      await upsertProductBundle(supabase, bundle);
    });

    // 4. Delete rows removed from Sheets (with fail-closed bulk wipe guard & pending-mirror protection)
    const missingFromSheets = sbProducts
      .filter(
        (r) =>
          r.product_id &&
          !sheetIds.has(r.product_id) &&
          !protectedPendingIds.has(r.product_id) &&
          r.sheets_mirror_pending !== true
      )
      .map((r) => r.product_id);

    let deletedIds = [];
    if (missingFromSheets.length > 0 && totalSheets > 0) {
      const maxSafeDeletes = Math.max(5, Math.floor(sbProducts.length * 0.2));
      if (missingFromSheets.length <= maxSafeDeletes || allowBulkDelete) {
        const { error: delErr } = await supabase
          .from("products")
          .delete()
          .in("product_id", missingFromSheets);
        if (delErr) {
          throw new Error(`Failed deleting removed products: ${delErr.message}`);
        }
        deletedIds = missingFromSheets;
      } else {
        throw new Error(
          `Refusing automatic bulk delete of ${missingFromSheets.length} products (exceeds safety threshold ${maxSafeDeletes})`
        );
      }
    }

    // 5. Keep row_seq identity sequence synchronized
    if (dirtyTargets.length > 0 || deletedIds.length > 0) {
      if (typeof supabase.rpc === "function") {
        await supabase.rpc("sync_products_row_seq");
      }
    }

    const changedProductIds = dirtyTargets.map((t) => t.productId);
    if (
      changedProductIds.length > 0 &&
      asTrimmedString(process.env.PRODUCTS_API_INTERNAL_SECRET)
    ) {
      await syncAiProductDraftsFromGas({
        supabase,
        fetchImpl,
        gasWebAppUrl,
        internalSecret: process.env.PRODUCTS_API_INTERNAL_SECRET,
        productIds: changedProductIds,
      }).catch((err) => {
        console.warn(
          JSON.stringify({
            severity: "WARNING",
            message: `AI draft sync warning during reconcile: ${
              err instanceof Error ? err.message : String(err)
            }`,
          })
        );
      });
    }
    await recordSyncRunFinish(supabase, runId, {
      status: "completed",
      sheets_count: totalSheets,
      supabase_before_count: sbProducts.length,
      upserted_count: dirtyTargets.length,
      rolling_checked_count: rollingTargets.length,
      deleted_count: deletedIds.length,
      changed_product_ids: changedProductIds,
      deleted_product_ids: deletedIds,
    });

    return {
      sheets_count: totalSheets,
      supabase_before_count: sbProducts.length,
      upserted_count: dirtyTargets.length,
      rolling_checked_count: rollingTargets.length,
      flushed_pending_count: flushedPendingCount,
      protected_pending_count: protectedPendingIds.size,
      deleted_count: deletedIds.length,
      changed_product_ids: changedProductIds,
      deleted_product_ids: deletedIds,
    };
  } catch (err) {
    await recordSyncRunFinish(supabase, runId, {
      status: "failed",
      error_message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
