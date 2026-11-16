import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mapGasProductToSupabaseBundle } from "../src/productMapper.mjs";
import { createProductsApiHandler } from "../src/server.mjs";
import {
  dispatchDueAiBatchSchedules,
  formatJstDateTimeDisplay,
  resolveConfirmedProductCostsForBatch,
} from "../src/aiBatchService.mjs";

const TINY_JPEG_BYTES = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
  "base64"
);

function createBatchMockSupabase(initialProducts = []) {
  let nextItemId = 1;
  const state = {
    products: new Map(),
    product_images: [],
    product_translations: [],
    pokemon_cards: [],
    product_documents: [],
    product_ai_drafts: [],
    ai_draft_execution_locks: new Map(),
    ai_batch_jobs: [],
    ai_batch_items: [],
    ai_batch_schedules: [],
  };

  for (const b of initialProducts) {
    state.products.set(b.productRow.product_id, { is_test: false, ...b.productRow });
    state.product_images.push(...(b.imageRows || []));
    if (b.translationRow) state.product_translations.push(b.translationRow);
    if (b.pokemonCardRow) state.pokemon_cards.push(b.pokemonCardRow);
  }

  function recomputeJobSummary(batchId) {
    const jobIdx = state.ai_batch_jobs.findIndex((j) => j.batch_id === batchId);
    if (jobIdx < 0) return null;
    const job = state.ai_batch_jobs[jobIdx];
    const items = state.ai_batch_items.filter((i) => i.batch_id === batchId);
    const total = items.length || job.total_count;
    const completed = items.filter((i) => i.status === "completed").length;
    const failed = items.filter((i) => i.status === "failed").length;
    const processing = items.filter((i) => i.status === "processing").length;

    let nextStatus = "queued";
    let isTerminal = false;
    if (completed === total && total > 0) {
      nextStatus = "completed";
      isTerminal = true;
    } else if (failed === total && total > 0) {
      nextStatus = "failed";
      isTerminal = true;
    } else if (completed + failed === total && total > 0) {
      nextStatus = "partially_failed";
      isTerminal = true;
    } else if (processing > 0 || completed > 0 || failed > 0) {
      nextStatus = "processing";
    }

    const nowIso = new Date().toISOString();
    const updated = {
      ...job,
      status: nextStatus,
      total_count: total,
      completed_count: completed,
      failed_count: failed,
      processing_count: processing,
      updated_at: nowIso,
      completed_at: isTerminal ? job.completed_at || nowIso : null,
    };
    state.ai_batch_jobs[jobIdx] = updated;
    return updated;
  }

  return {
    state,
    addProductBundle(b) {
      state.products.set(b.productRow.product_id, { is_test: false, ...b.productRow });
      state.product_images.push(...(b.imageRows || []));
      if (b.translationRow) state.product_translations.push(b.translationRow);
      if (b.pokemonCardRow) state.pokemon_cards.push(b.pokemonCardRow);
    },
    async rpc(fnName, args = {}) {
      const findActiveConflicts = (
        productIds = [],
        ignoreScheduleId = null,
        ignoreBatchId = null
      ) => {
        const targetList = Array.isArray(productIds) ? productIds : [];
        const conflicts = [];
        for (const pid of targetList) {
          let activeSched = null;
          for (const s of state.ai_batch_schedules) {
            if (ignoreScheduleId && s.schedule_id === ignoreScheduleId) continue;
            if (s.batch_id) continue;
            if (
              (s.status === "scheduled" ||
                s.status === "starting" ||
                s.status === "dispatch_retry") &&
              Array.isArray(s.product_ids) &&
              s.product_ids.includes(pid)
            ) {
              activeSched = s;
              break;
            }
          }
          let activeItem = null;
          for (const it of state.ai_batch_items) {
            if (ignoreBatchId && it.batch_id === ignoreBatchId) continue;
            if (
              (it.status === "pending" || it.status === "processing") &&
              it.product_id === pid
            ) {
              activeItem = it;
              break;
            }
          }
          if (activeSched || activeItem) {
            conflicts.push({
              product_id: pid,
              conflict_state: activeItem ? activeItem.status : activeSched.status,
              schedule_id: activeSched ? activeSched.schedule_id : null,
              batch_id: activeItem ? activeItem.batch_id : null,
            });
          }
        }
        return {
          has_conflict: conflicts.length > 0,
          conflicting_product_ids: conflicts.map((c) => c.product_id),
          conflicts,
        };
      };

      if (fnName === "find_active_ai_batch_product_conflicts") {
        return {
          data: findActiveConflicts(
            args.p_product_ids,
            args.p_ignore_schedule_id,
            args.p_ignore_batch_id
          ),
          error: null,
        };
      }
      if (fnName === "acquire_ai_draft_execution_lock") {
        const pid = args.p_product_id;
        const ttlMs = Math.max(10, Number(args.p_ttl_seconds || 180)) * 1000;
        const existing = state.ai_draft_execution_locks.get(pid);
        if (existing && existing.expiresAtMs > Date.now()) {
          return {
            data: { acquired: false, execution_id: "", existing_execution_id: existing.executionId },
            error: null,
          };
        }
        const execId = `EXEC_${pid}_${Math.random().toString(16).slice(2, 10)}`;
        state.ai_draft_execution_locks.set(pid, {
          executionId: execId,
          expiresAtMs: Date.now() + ttlMs,
        });
        return { data: { acquired: true, execution_id: execId }, error: null };
      }
      if (fnName === "verify_ai_draft_execution_lock") {
        const existing = state.ai_draft_execution_locks.get(args.p_product_id);
        return {
          data: Boolean(
            existing &&
              existing.executionId === args.p_execution_id &&
              existing.expiresAtMs > Date.now()
          ),
          error: null,
        };
      }
      if (fnName === "release_ai_draft_execution_lock") {
        const existing = state.ai_draft_execution_locks.get(args.p_product_id);
        if (existing && existing.executionId === args.p_execution_id) {
          state.ai_draft_execution_locks.delete(args.p_product_id);
          return { data: true, error: null };
        }
        return { data: false, error: null };
      }
      if (fnName === "save_generated_ai_draft_atomic") {
        const pid = args.p_product_id;
        let maxVer = 0;
        state.product_ai_drafts = state.product_ai_drafts.map((row) => {
          if (row.product_id === pid) {
            maxVer = Math.max(maxVer, Number(row.draft_version || 0));
            if (row.review_status === "pending_review") {
              return { ...row, review_status: "stale" };
            }
          }
          return row;
        });
        const nextVer = Math.max(maxVer, Number(args.p_min_draft_version || 0)) + 1;
        const newRow = {
          draft_id: args.p_draft_id,
          product_id: pid,
          draft_version: nextVer,
          review_status: args.p_review_status || "pending_review",
          candidate_title_ja: args.p_candidate_title_ja || "",
          candidate_hashtags_ja: args.p_candidate_hashtags_ja || "",
          candidate_description_ja: args.p_candidate_description_ja || "",
          candidate_title_en: args.p_candidate_title_en || "",
          candidate_description_en: args.p_candidate_description_en || "",
          candidate_condition: args.p_candidate_condition || "",
          candidate_price:
            args.p_candidate_price !== null && args.p_candidate_price !== undefined
              ? Number(args.p_candidate_price)
              : null,
          candidate_price_basis: args.p_candidate_price_basis || "",
          candidate_price_note: args.p_candidate_price_note || "",
          candidate_category: args.p_candidate_category || "",
          candidate_brand: args.p_candidate_brand || "",
          candidate_sku: args.p_candidate_sku || "",
          candidate_sku_source: args.p_candidate_sku_source || "",
          candidate_size: args.p_candidate_size || "",
          candidate_json: args.p_candidate_json || {},
          source_fingerprint: args.p_source_fingerprint || "",
          source_image_fingerprint: args.p_source_image_fingerprint || "",
          confirmed_fingerprint: args.p_confirmed_fingerprint || "",
          source_image_ids: args.p_source_image_ids || [],
          model_name: args.p_model_name || "",
          generated_at: args.p_generated_at || new Date().toISOString(),
          confirmed_at: args.p_confirmed_at || null,
          confirmed_by: args.p_confirmed_by || "",
          last_confirmation_attempt_id: "",
          last_confirmation_payload_hash: "",
          search_grounding_enabled: Boolean(args.p_search_grounding_enabled),
          search_grounding_mode: args.p_search_grounding_mode || "",
          search_executed: Boolean(args.p_search_executed),
          search_queries: args.p_search_queries || [],
          write_source: "supabase",
        };
        state.product_ai_drafts.push(newRow);
        return {
          data: { draft_id: newRow.draft_id, product_id: pid, draft_version: nextVer },
          error: null,
        };
      }
      if (fnName === "enqueue_ai_batch_job_atomic") {
        const existing = state.ai_batch_jobs.find((j) => j.request_id === args.p_request_id);
        if (existing) {
          return { data: { is_reused: true, job: existing }, error: null };
        }
        const conflictRes = findActiveConflicts(
          args.p_product_ids,
          args.p_ignore_schedule_id || null,
          null
        );
        if (conflictRes.has_conflict) {
          return {
            data: null,
            error: {
              message: `PRODUCT_ALREADY_IN_ACTIVE_AI_BATCH:${conflictRes.conflicting_product_ids.join(",")}`,
            },
          };
        }
        const nowIso = new Date().toISOString();
        const job = {
          batch_id: args.p_batch_id,
          request_id: args.p_request_id,
          job_source: args.p_job_source || "manual",
          status: "queued",
          total_count: args.p_product_ids.length,
          completed_count: 0,
          failed_count: 0,
          processing_count: 0,
          force_regenerate: Boolean(args.p_force_regenerate),
          test_only: Boolean(args.p_test_only),
          model_name: args.p_model_name || "",
          min_cost_markup_rate: Number(args.p_min_cost_markup_rate ?? 0.3),
          product_costs_json: args.p_product_costs_json || {},
          retry_requests: {},
          created_at: nowIso,
          updated_at: nowIso,
          completed_at: null,
        };
        state.ai_batch_jobs.push(job);
        const selMap = args.p_selected_image_ids_by_product || {};
        args.p_product_ids.forEach((pid, idx) => {
          state.ai_batch_items.push({
            id: nextItemId++,
            batch_id: job.batch_id,
            product_id: pid,
            item_index: idx,
            status: "pending",
            selected_image_ids: Array.isArray(selMap[pid]) ? [...selMap[pid]] : [],
            source_image_ids: [],
            draft_id: null,
            draft_version: null,
            model_name: null,
            proposed_price: null,
            price_basis: null,
            price_note: null,
            error_code: null,
            error_message: null,
            retry_count: 0,
            next_retry_at: null,
            worker_execution_id: null,
            lease_expires_at: null,
            created_at: nowIso,
            updated_at: nowIso,
          });
        });
        return { data: { is_reused: false, job }, error: null };
      }
      if (fnName === "claim_ai_batch_queue_items") {
        const nowMs = Date.now();
        const activeCount = state.ai_batch_items.filter(
          (i) =>
            i.status === "processing" &&
            i.lease_expires_at &&
            new Date(i.lease_expires_at).getTime() > nowMs
        ).length;
        const maxGlobal = Number(args.p_max_global_concurrency || 2);
        const limit = Number(args.p_limit || 1);
        const slots = Math.min(limit, Math.max(0, maxGlobal - activeCount));
        if (slots <= 0) return { data: [], error: null };

        const activeProductIds = new Set(
          state.ai_batch_items
            .filter(
              (i) =>
                i.status === "processing" &&
                i.lease_expires_at &&
                new Date(i.lease_expires_at).getTime() > nowMs
            )
            .map((i) => i.product_id)
        );
        const claimed = [];
        const affectedBatches = new Set();
        const sorted = [...state.ai_batch_items].sort(
          (a, b) => a.created_at.localeCompare(b.created_at) || a.item_index - b.item_index || a.id - b.id
        );
        for (const item of sorted) {
          if (claimed.length >= slots) break;
          if (activeProductIds.has(item.product_id)) continue;
          const isReadyPending =
            item.status === "pending" &&
            (!item.next_retry_at || new Date(item.next_retry_at).getTime() <= nowMs);
          const isExpiredProcessing =
            item.status === "processing" &&
            (!item.lease_expires_at || new Date(item.lease_expires_at).getTime() <= nowMs);
          if (!isReadyPending && !isExpiredProcessing) continue;

          const execId = `WRK_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
          const leaseExp = new Date(
            nowMs + Number(args.p_lease_seconds || 300) * 1000
          ).toISOString();
          item.status = "processing";
          item.worker_execution_id = execId;
          item.lease_expires_at = leaseExp;
          item.updated_at = new Date(nowMs).toISOString();
          activeProductIds.add(item.product_id);
          affectedBatches.add(item.batch_id);

          const job = state.ai_batch_jobs.find((j) => j.batch_id === item.batch_id) || {};
          claimed.push({
            id: item.id,
            batch_id: item.batch_id,
            product_id: item.product_id,
            item_index: item.item_index,
            selected_image_ids: item.selected_image_ids,
            linked_draft_id: item.draft_id || "",
            retry_count: item.retry_count,
            worker_execution_id: execId,
            lease_expires_at: leaseExp,
            job_source: job.job_source || "manual",
            force_regenerate: Boolean(job.force_regenerate),
            job_test_only: Boolean(job.test_only),
            job_model_name: job.model_name || "",
            min_cost_markup_rate: job.min_cost_markup_rate ?? 0.3,
            product_cost: job.product_costs_json?.[item.product_id] ?? null,
          });
        }
        for (const bid of affectedBatches) recomputeJobSummary(bid);
        return { data: claimed, error: null };
      }
      if (fnName === "verify_or_reserve_ai_batch_item_ownership") {
        const item = state.ai_batch_items.find((i) => i.id === args.p_item_id);
        if (
          !item ||
          item.status !== "processing" ||
          item.worker_execution_id !== args.p_worker_execution_id ||
          new Date(item.lease_expires_at).getTime() <= Date.now()
        ) {
          return { data: false, error: null };
        }
        if (args.p_draft_id) {
          item.draft_id = args.p_draft_id;
          if (args.p_model_name) item.model_name = args.p_model_name;
        }
        return { data: true, error: null };
      }
      if (fnName === "complete_ai_batch_queue_item") {
        const item = state.ai_batch_items.find((i) => i.id === args.p_item_id);
        if (
          !item ||
          item.status !== "processing" ||
          item.worker_execution_id !== args.p_worker_execution_id
        ) {
          return { data: { committed: false, fenced: true }, error: null };
        }
        if (args.p_outcome === "completed") {
          item.status = "completed";
          item.draft_id = args.p_draft_id || item.draft_id;
          item.draft_version = args.p_draft_version ?? item.draft_version;
          item.model_name = args.p_model_name || item.model_name;
          item.proposed_price = args.p_proposed_price ?? null;
          item.price_basis = args.p_price_basis || "";
          item.price_note = args.p_price_note || "";
          item.source_image_ids = args.p_source_image_ids || [];
          item.error_code = null;
          item.error_message = null;
          item.next_retry_at = null;
          item.lease_expires_at = null;
        } else if (args.p_outcome === "retry_pending") {
          item.status = "pending";
          item.error_code = args.p_error_code || null;
          item.error_message = args.p_error_message || null;
          item.retry_count = args.p_retry_count ?? item.retry_count + 1;
          item.next_retry_at = args.p_next_retry_at;
          item.worker_execution_id = null;
          item.lease_expires_at = null;
        } else {
          item.status = "failed";
          if (args.p_draft_id) item.draft_id = args.p_draft_id;
          if (args.p_draft_version !== null && args.p_draft_version !== undefined) {
            item.draft_version = args.p_draft_version;
          }
          if (args.p_model_name) item.model_name = args.p_model_name;
          item.error_code = args.p_error_code || "GENERATION_FAILED";
          item.error_message = args.p_error_message || "Failed";
          item.next_retry_at = null;
          item.lease_expires_at = null;
        }
        const job = recomputeJobSummary(item.batch_id);
        return { data: { committed: true, fenced: false, job }, error: null };
      }
      if (fnName === "retry_ai_batch_failed_items_atomic") {
        const jobIdx = state.ai_batch_jobs.findIndex((j) => j.batch_id === args.p_batch_id);
        if (jobIdx < 0) return { data: { found: false }, error: null };
        const job = state.ai_batch_jobs[jobIdx];
        if (job.retry_requests?.[args.p_request_id]) {
          return {
            data: {
              found: true,
              is_reused: true,
              response: {
                ...job.retry_requests[args.p_request_id].response,
                batch_id: args.p_batch_id,
                request_id: args.p_request_id,
                is_reused: true,
              },
            },
            error: null,
          };
        }
        const failedIdsForRetry = [
          ...new Set(
            state.ai_batch_items
              .filter((it) => it.batch_id === args.p_batch_id && it.status === "failed")
              .map((it) => String(it.product_id || "").trim())
              .filter(Boolean)
          ),
        ];
        if (failedIdsForRetry.length > 0) {
          const conflictRes = findActiveConflicts(
            failedIdsForRetry,
            null,
            args.p_batch_id
          );
          if (conflictRes.has_conflict) {
            return {
              data: null,
              error: {
                message: `PRODUCT_ALREADY_IN_ACTIVE_AI_BATCH:${conflictRes.conflicting_product_ids.join(",")}`,
              },
            };
          }
        }
        if (args.p_updated_product_costs) {
          job.product_costs_json = {
            ...(job.product_costs_json || {}),
            ...args.p_updated_product_costs,
          };
        }
        let retriedCount = 0;
        for (const it of state.ai_batch_items) {
          if (it.batch_id === args.p_batch_id && it.status === "failed") {
            const ec = String(it.error_code || "");
            if (
              ec === "SEARCH_GROUNDING_NOT_EXECUTED" ||
              ec.startsWith("SEARCH_") ||
              ec.startsWith("STAGE_A_") ||
              ec === "SELECTED_IMAGE_DELETED" ||
              ec === "INVALID_IMAGE_SELECTION"
            ) {
              it.draft_id = null;
              it.draft_version = null;
              it.model_name = null;
            }
            it.status = "pending";
            it.error_code = null;
            it.error_message = null;
            it.retry_count = 0;
            it.next_retry_at = null;
            it.worker_execution_id = null;
            it.lease_expires_at = null;
            retriedCount += 1;
          }
        }
        const batchItems = state.ai_batch_items.filter((i) => i.batch_id === args.p_batch_id);
        const completedCount = batchItems.filter((i) => i.status === "completed").length;
        const failedCount = batchItems.filter((i) => i.status === "failed").length;
        const processingCount = batchItems.filter((i) => i.status === "processing").length;
        const nowIso = new Date().toISOString();

        let response;
        if (retriedCount > 0) {
          job.status = processingCount > 0 ? "processing" : "queued";
          job.completed_count = completedCount;
          job.failed_count = failedCount;
          job.processing_count = processingCount;
          job.updated_at = nowIso;
          job.completed_at = null;
          response = {
            success: true,
            batch_id: args.p_batch_id,
            request_id: args.p_request_id,
            status: job.status,
            total_count: job.total_count,
            retried_count: retriedCount,
            completed_count: completedCount,
            failed_count: failedCount,
            is_reused: false,
            updated_at: nowIso,
          };
        } else {
          response = {
            success: false,
            error_code: "NO_FAILED_ITEMS",
            message: `No failed items to retry in batch: ${args.p_batch_id}`,
            batch_id: args.p_batch_id,
            request_id: args.p_request_id,
            status: job.status,
            total_count: job.total_count,
            retried_count: 0,
            completed_count: completedCount,
            failed_count: failedCount,
            is_reused: false,
            updated_at: nowIso,
          };
        }
        job.retry_requests = {
          ...(job.retry_requests || {}),
          [args.p_request_id]: { processed_at: nowIso, response },
        };
        return {
          data: { found: true, is_reused: false, retried_count: retriedCount, response },
          error: null,
        };
      }
      if (fnName === "create_ai_batch_schedule_atomic") {
        const existing = state.ai_batch_schedules.find(
          (s) => s.request_id === args.p_request_id
        );
        if (existing) {
          if (args.p_test_only && !existing.test_only) {
            return { data: null, error: { message: "NON_TEST_PRODUCT_INCLUDED" } };
          }
          if (!args.p_test_only && existing.test_only) {
            return { data: null, error: { message: "TEST_PRODUCT_INCLUDED" } };
          }
          return { data: { is_reused: true, schedule: existing }, error: null };
        }
        const conflictRes = findActiveConflicts(args.p_product_ids, null, null);
        if (conflictRes.has_conflict) {
          return {
            data: null,
            error: {
              message: `PRODUCT_ALREADY_IN_ACTIVE_AI_BATCH:${conflictRes.conflicting_product_ids.join(",")}`,
            },
          };
        }
        const nowIso = new Date().toISOString();
        const schedule = {
          schedule_id: args.p_schedule_id,
          request_id: args.p_request_id,
          status: "scheduled",
          scheduled_at: args.p_scheduled_at,
          test_only: Boolean(args.p_test_only),
          force_regenerate: Boolean(args.p_force_regenerate),
          min_cost_markup_rate: Number(args.p_min_cost_markup_rate ?? 0.3),
          product_ids: [...args.p_product_ids],
          product_names_json: { ...(args.p_product_names_json || {}) },
          selected_image_ids_by_product: {
            ...(args.p_selected_image_ids_by_product || {}),
          },
          excluded_items_json: [],
          batch_id: null,
          dispatch_token: null,
          dispatch_lease_expires_at: null,
          dispatch_retry_count: 0,
          next_dispatch_retry_at: null,
          dispatch_error_code: null,
          dispatch_error_message: null,
          started_at: null,
          cancelled_at: null,
          completed_at: null,
          created_at: nowIso,
          updated_at: nowIso,
        };
        state.ai_batch_schedules.push(schedule);
        return { data: { is_reused: false, schedule }, error: null };
      }
      if (fnName === "cancel_ai_batch_schedule_atomic") {
        const idx = state.ai_batch_schedules.findIndex(
          (s) => s.schedule_id === args.p_schedule_id
        );
        if (idx < 0) {
          return {
            data: { found: false, cancelled: false, reason: "NOT_FOUND" },
            error: null,
          };
        }
        const cur = state.ai_batch_schedules[idx];
        if (cur.status === "cancelled") {
          return {
            data: { found: true, cancelled: true, is_reused: true, schedule: cur },
            error: null,
          };
        }
        if (
          (cur.status === "scheduled" || cur.status === "dispatch_retry") &&
          !cur.batch_id
        ) {
          const nowIso = new Date().toISOString();
          const updated = {
            ...cur,
            status: "cancelled",
            cancelled_at: nowIso,
            dispatch_token: null,
            dispatch_lease_expires_at: null,
            next_dispatch_retry_at: null,
            updated_at: nowIso,
          };
          state.ai_batch_schedules[idx] = updated;
          return {
            data: { found: true, cancelled: true, is_reused: false, schedule: updated },
            error: null,
          };
        }
        return {
          data: {
            found: true,
            cancelled: false,
            reason: "ALREADY_STARTED",
            schedule: cur,
          },
          error: null,
        };
      }
      if (fnName === "claim_due_ai_batch_schedules") {
        const nowMs = args.p_now ? new Date(args.p_now).getTime() : Date.now();
        const nowIso = new Date(nowMs).toISOString();
        const limit = Math.max(1, Number(args.p_limit || 1));
        const leaseSecs = Math.max(30, Number(args.p_lease_seconds || 180));
        const sorted = [...state.ai_batch_schedules].sort(
          (a, b) =>
            String(a.scheduled_at).localeCompare(String(b.scheduled_at)) ||
            String(a.created_at).localeCompare(String(b.created_at))
        );
        const claimed = [];
        for (const s of sorted) {
          if (claimed.length >= limit) break;
          if (s.batch_id) continue;
          const schedMs = new Date(s.scheduled_at).getTime();
          const isDueScheduled = s.status === "scheduled" && schedMs <= nowMs;
          const isDueRetry =
            s.status === "dispatch_retry" &&
            schedMs <= nowMs &&
            (!s.next_dispatch_retry_at ||
              new Date(s.next_dispatch_retry_at).getTime() <= nowMs);
          const isExpiredStarting =
            s.status === "starting" &&
            (!s.dispatch_lease_expires_at ||
              new Date(s.dispatch_lease_expires_at).getTime() <= nowMs);
          if (!isDueScheduled && !isDueRetry && !isExpiredStarting) continue;

          const idx = state.ai_batch_schedules.findIndex(
            (x) => x.schedule_id === s.schedule_id
          );
          const token = `DSP_${nowMs}_${Math.random().toString(16).slice(2, 8)}`;
          const leaseExp = new Date(nowMs + leaseSecs * 1000).toISOString();
          const updated = {
            ...state.ai_batch_schedules[idx],
            status: "starting",
            dispatch_token: token,
            dispatch_lease_expires_at: leaseExp,
            updated_at: nowIso,
          };
          state.ai_batch_schedules[idx] = updated;
          claimed.push(updated);
        }
        return { data: claimed, error: null };
      }
      if (fnName === "complete_ai_batch_schedule_dispatch") {
        const idx = state.ai_batch_schedules.findIndex(
          (s) => s.schedule_id === args.p_schedule_id
        );
        if (idx < 0) return { data: { applied: false, reason: "NOT_FOUND" }, error: null };
        const cur = state.ai_batch_schedules[idx];
        if (
          cur.status === "started" ||
          cur.status === "completed_all_excluded" ||
          cur.status === "cancelled"
        ) {
          return {
            data: { applied: false, reason: "ALREADY_FINALIZED", schedule: cur },
            error: null,
          };
        }
        if (cur.dispatch_token !== args.p_dispatch_token) {
          return {
            data: { applied: false, reason: "TOKEN_MISMATCH", schedule: cur },
            error: null,
          };
        }
        const nowIso = new Date().toISOString();
        let updated = { ...cur, updated_at: nowIso };
        if (args.p_outcome === "started") {
          updated = {
            ...updated,
            status: "started",
            batch_id: args.p_batch_id,
            excluded_items_json: args.p_excluded_items_json || [],
            dispatch_token: null,
            dispatch_lease_expires_at: null,
            next_dispatch_retry_at: null,
            dispatch_error_code: null,
            dispatch_error_message: null,
            started_at: updated.started_at || nowIso,
          };
        } else if (args.p_outcome === "completed_all_excluded") {
          updated = {
            ...updated,
            status: "completed_all_excluded",
            excluded_items_json: args.p_excluded_items_json || [],
            dispatch_token: null,
            dispatch_lease_expires_at: null,
            next_dispatch_retry_at: null,
            dispatch_error_code: null,
            dispatch_error_message: null,
            started_at: updated.started_at || nowIso,
            completed_at: updated.completed_at || nowIso,
          };
        } else if (args.p_outcome === "dispatch_retry") {
          updated = {
            ...updated,
            status: "dispatch_retry",
            dispatch_token: null,
            dispatch_lease_expires_at: null,
            dispatch_retry_count: Number(args.p_retry_count || cur.dispatch_retry_count + 1),
            next_dispatch_retry_at: args.p_next_dispatch_retry_at || null,
            dispatch_error_code: args.p_error_code || null,
            dispatch_error_message: args.p_error_message || null,
          };
        } else if (args.p_outcome === "failed") {
          updated = {
            ...updated,
            status: "failed",
            excluded_items_json: args.p_excluded_items_json || [],
            dispatch_token: null,
            dispatch_lease_expires_at: null,
            next_dispatch_retry_at: null,
            dispatch_retry_count: Number(args.p_retry_count || cur.dispatch_retry_count),
            dispatch_error_code: args.p_error_code || null,
            dispatch_error_message: args.p_error_message || null,
            completed_at: updated.completed_at || nowIso,
          };
        }
        state.ai_batch_schedules[idx] = updated;
        return { data: { applied: true, schedule: updated }, error: null };
      }
      return { data: null, error: null };
    },
    from(table) {
      let filters = [];
      let orders = [];
      let limitCount = null;
      let rangeWindow = null;
      let includeRelations = false;

      const executeSelect = () => {
        let rows =
          table === "products"
            ? Array.from(state.products.values())
            : [...(state[table] || [])];
        for (const fn of filters) rows = rows.filter(fn);
        if (includeRelations && table === "products") {
          rows = rows.map((r) => ({
            ...r,
            product_images: state.product_images.filter((i) => i.product_id === r.product_id),
            product_translations: state.product_translations.filter(
              (t) => t.product_id === r.product_id
            ),
            pokemon_cards: state.pokemon_cards.filter((p) => p.product_id === r.product_id),
            product_documents: [],
          }));
        }
        if (orders.length > 0) {
          rows.sort((a, b) => {
            for (const { col, ascending } of orders) {
              if (a[col] === b[col]) continue;
              return ascending ? (a[col] < b[col] ? -1 : 1) : a[col] > b[col] ? -1 : 1;
            }
            return 0;
          });
        }
        if (rangeWindow !== null) {
          rows = rows.slice(rangeWindow.from, rangeWindow.to + 1);
        } else if (limitCount !== null) {
          rows = rows.slice(0, limitCount);
        }
        return { data: rows, error: null };
      };

      const builder = {
        select(cols = "") {
          if (
            String(cols).includes("product_images(") ||
            String(cols).includes("product_translations(")
          ) {
            includeRelations = true;
          }
          return builder;
        },
        eq(col, val) {
          filters.push((r) => r[col] === val);
          return builder;
        },
        in(col, vals) {
          const s = new Set(vals);
          filters.push((r) => s.has(r[col]));
          return builder;
        },
        lte(col, val) {
          filters.push((r) => Boolean(r[col]) && String(r[col]) <= String(val));
          return builder;
        },
        order(col, opts = {}) {
          orders.push({ col, ascending: opts.ascending !== false });
          return builder;
        },
        limit(n) {
          limitCount = n;
          return builder;
        },
        range(from, to) {
          rangeWindow = { from: Number(from), to: Number(to) };
          return builder;
        },
        maybeSingle() {
          const res = executeSelect();
          return Promise.resolve({
            data: res.data.length > 0 ? res.data[0] : null,
            error: null,
          });
        },
        then(resolve, reject) {
          return Promise.resolve(executeSelect()).then(resolve, reject);
        },
        update(patch) {
          const updFilters = [];
          const updBuilder = {
            eq(col, val) {
              updFilters.push((r) => r[col] === val);
              return updBuilder;
            },
            then(resolve, reject) {
              if (table === "products") {
                for (const [k, row] of state.products.entries()) {
                  if (updFilters.every((fn) => fn(row))) {
                    state.products.set(k, { ...row, ...patch });
                  }
                }
              } else {
                state[table] = (state[table] || []).map((row) =>
                  updFilters.every((fn) => fn(row)) ? { ...row, ...patch } : row
                );
              }
              return Promise.resolve({ error: null }).then(resolve, reject);
            },
          };
          return updBuilder;
        },
        upsert(payload) {
          const items = Array.isArray(payload) ? payload : [payload];
          if (table === "products") {
            for (const it of items) {
              const prev = state.products.get(it.product_id) || {};
              state.products.set(it.product_id, { ...prev, ...it });
            }
          } else if (table === "product_translations") {
            for (const it of items) {
              const idx = state.product_translations.findIndex(
                (t) =>
                  t.product_id === it.product_id && (t.locale || "en") === (it.locale || "en")
              );
              if (idx >= 0) {
                state.product_translations[idx] = { ...state.product_translations[idx], ...it };
              } else {
                state.product_translations.push(it);
              }
            }
          } else if (table === "pokemon_cards") {
            for (const it of items) {
              const idx = state.pokemon_cards.findIndex((p) => p.product_id === it.product_id);
              if (idx >= 0) state.pokemon_cards[idx] = { ...state.pokemon_cards[idx], ...it };
              else state.pokemon_cards.push(it);
            }
          } else if (table === "product_ai_drafts") {
            for (const it of items) {
              const idx = state.product_ai_drafts.findIndex(
                (d) =>
                  d.product_id === it.product_id && d.draft_version === it.draft_version
              );
              if (idx >= 0) state.product_ai_drafts[idx] = { ...state.product_ai_drafts[idx], ...it };
              else state.product_ai_drafts.push(it);
            }
          }
          return Promise.resolve({ error: null });
        },
      };
      return builder;
    },
  };
}

function makeDraftBundle(productId, rowSeq = 1, extraDetail = {}) {
  return mapGasProductToSupabaseBundle({
    summary: { product_id: productId, publish_status: "draft", record_status: "active" },
    detail: {
      product_id: productId,
      category: "",
      brand: "",
      product_name: "",
      condition: "",
      planned_sale_price: 0,
      publish_status: "draft",
      inventory_status: "in_stock",
      record_status: "active",
      drive_folder_url: `https://drive.google.com/drive/folders/FOLDER_${productId}`,
      main_image_url: `https://drive.google.com/file/d/FILE_${productId}_1/view`,
      images: [
        {
          file_id: `FILE_${productId}_1`,
          name: "01_main.jpg",
          mime_type: "image/jpeg",
          view_url: `https://drive.google.com/file/d/FILE_${productId}_1/view`,
        },
      ],
      ...extraDetail,
    },
    rowSeq,
  });
}

test("Phase 2 Unit 5: Accepts >20 products in 1 manual batch, enforces concurrency cap, applies cost_markup_floor, and keeps products draft & unlinked", async () => {
  const productIds = Array.from(
    { length: 25 },
    (_, i) => `TMP-${String(801 + i).padStart(6, "0")}`
  );
  const bundles = productIds.map((pid, idx) => makeDraftBundle(pid, idx + 1));
  const mockSupabase = createBatchMockSupabase(bundles);

  let activeSearchCalls = 0;
  let peakSearchConcurrency = 0;
  const gasMirrorCalls = [];

  const mockFetch = async (url, init = {}) => {
    const urlStr = String(url);
    if (urlStr.includes("/auth/v1/settings") || urlStr.includes("/auth/v1/user")) {
      return new Response(
        JSON.stringify({ id: "staff-1", email: "staff@example.com", external: {} }),
        { status: 200 }
      );
    }
    if (urlStr.includes("/functions/v1/documents-relay")) {
      const body = JSON.parse(init.body || "{}");
      if (body.product_id === "TMP-000801") {
        return new Response(
          JSON.stringify({
            success: true,
            product_id: body.product_id,
            cost_breakdown: { total_allocated_cost: 20000, matched_lines_count: 1 },
            links: [{ link_type: "primary_cost", allocated_amount: 20000 }],
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          success: true,
          product_id: body.product_id,
          cost_breakdown: null,
          links: [],
        }),
        { status: 200 }
      );
    }
    if (urlStr.startsWith("https://drive.google.com/uc?export=download")) {
      return new Response(TINY_JPEG_BYTES, {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }
    if (urlStr.includes("generativelanguage.googleapis.com")) {
      const reqJson = JSON.parse(init.body || "{}");
      const hasSearchTool = Array.isArray(reqJson.tools) && reqJson.tools.length > 0;
      const isPrior = reqJson.generationConfig?.maxOutputTokens === 100;
      if (isPrior) {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: JSON.stringify({ category: "sneaker", confidence: "high" }) }],
                },
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (hasSearchTool) {
        activeSearchCalls += 1;
        peakSearchConcurrency = Math.max(peakSearchConcurrency, activeSearchCalls);
        await new Promise((r) => setTimeout(r, 15));
        activeSearchCalls -= 1;
        return new Response(
          JSON.stringify({
            candidates: [
              {
                finishReason: "STOP",
                groundingMetadata: {
                  webSearchQueries: ["DZ5485-612 Nike AJ1"],
                  groundingChunks: [{ web: { uri: "https://snkrdunk.com/DZ5485-612", title: "AJ1" } }],
                },
                content: {
                  parts: [
                    {
                      text: [
                        "### 1. DIRECT PHYSICAL OBSERVATIONS",
                        "- BOX_LABEL_SKU: DZ5485-612",
                        "- INNER_TAG_SIZE: 27.0cm",
                        "### 2. EXTERNAL SEARCH CORROBORATIONS",
                        "- CORROBORATED_MODEL: Nike Air Jordan 1 High OG",
                        "### 3. PRICING TRANSACTIONS",
                        "- Sold: 22,000円",
                      ].join("\n"),
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          candidates: [
            {
              finishReason: "STOP",
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      title_ja: "ナイキ エアジョーダン1 ハイ OG (DZ5485-612)",
                      title_en: "Nike Air Jordan 1 High OG (DZ5485-612)",
                      description_ja: "ナイキ エアジョーダン1です。",
                      description_en: "Nike Air Jordan 1 High OG.",
                      hashtags_ja: "#NIKE",
                      condition: "目立った傷や汚れなし",
                      category: "sneaker",
                      brand: "JORDAN",
                      sku: "DZ5485-612",
                      size: "27.0cm",
                      price: 22000,
                      price_basis: "recent_sold_provisional",
                      price_note: "成約参考 22,000円",
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 }
      );
    }
    if (urlStr.startsWith("https://gas.example/exec")) {
      const body = JSON.parse(init.body || "{}");
      gasMirrorCalls.push(body);
      return new Response(
        JSON.stringify({
          success: true,
          confirmed_fingerprint: `GAS_FP_${body.product_id}`,
        }),
        { status: 200 }
      );
    }
    throw new Error(`Unexpected URL in test: ${urlStr}`);
  };

  mockSupabase.state.staff_users = [
    { email: "staff@example.com", is_active: true, role: "admin" },
  ];

  const handler = createProductsApiHandler({
    getSupabase: () => mockSupabase,
    fetchImpl: mockFetch,
    gasWebAppUrl: "https://gas.example/exec",
    internalSecret: "test-internal-secret",
    readdyBackendUrl: "https://readdy.example",
    geminiApiKey: "test-gemini-key",
    aiBatchConcurrency: 2,
    enableAutoBatchWorker: false,
  });

  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const staffHeaders = {
    "Content-Type": "application/json",
    Authorization: "Bearer valid-staff-jwt",
    apikey: "readdy-anon-key",
  };

  try {
    // 1. Submit 25 items (>20 legacy limit!)
    const createRes = await fetch(`${baseUrl}/ai-batches`, {
      method: "POST",
      headers: staffHeaders,
      body: JSON.stringify({
        request_id: "REQ_25_ITEMS_001",
        product_ids: [...productIds, "TMP-000801"], // duplicate deduplicated to 25
        min_cost_markup_rate: 0.35,
      }),
    });
    const createJson = await createRes.json();
    assert.equal(createRes.status, 200);
    assert.equal(createJson.success, true);
    assert.equal(createJson.total_count, 25);
    assert.equal(createJson.is_reused, false);
    assert.equal(createJson.status, "queued");
    assert.equal(createJson.min_cost_markup_rate, 0.35);

    // 2. Duplicate request_id returns is_reused: true with zero duplicate batches
    const dupRes = await fetch(`${baseUrl}/ai-batches`, {
      method: "POST",
      headers: staffHeaders,
      body: JSON.stringify({
        request_id: "REQ_25_ITEMS_001",
        product_ids: productIds,
        min_cost_markup_rate: 0.35,
      }),
    });
    const dupJson = await dupRes.json();
    assert.equal(dupJson.success, true);
    assert.equal(dupJson.is_reused, true);
    assert.equal(dupJson.batch_id, createJson.batch_id);
    assert.equal(mockSupabase.state.ai_batch_jobs.length, 1);
    assert.equal(mockSupabase.state.ai_batch_items.length, 25);

    // 3. Run controlled-concurrency worker (concurrency = 2)
    const workerRes = await fetch(`${baseUrl}/ai-batches/worker/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Sync-Token": "test-internal-secret",
      },
      body: JSON.stringify({}),
    });
    const workerJson = await workerRes.json();
    assert.equal(workerJson.success, true);
    assert.equal(workerJson.processed_count, 25);
    assert.equal(workerJson.completed_count, 25);
    assert.equal(workerJson.concurrency, 2);
    assert.ok(
      peakSearchConcurrency <= 2,
      `Expected peak concurrency <= 2, got ${peakSearchConcurrency}`
    );
    assert.equal(peakSearchConcurrency, 2);

    // 4. Verify progress endpoint & gross_margin_floor on TMP-000801 (20000 / (1 - 0.35) = 30769.23 -> 30800 > 22000)
    const progRes = await fetch(
      `${baseUrl}/ai-batches/${encodeURIComponent(createJson.batch_id)}`,
      { method: "GET", headers: staffHeaders }
    );
    const progJson = await progRes.json();
    assert.equal(progJson.success, true);
    assert.equal(progJson.status, "completed");
    assert.equal(progJson.completed_count, 25);
    assert.equal(progJson.failed_count, 0);
    assert.ok(progJson.completed_at);
    assert.equal(progJson.items.length, 25);

    const firstItem = progJson.items[0];
    assert.equal(firstItem.product_id, "TMP-000801");
    assert.equal(firstItem.status, "completed");
    assert.equal(firstItem.proposed_price, 30800);
    assert.equal(firstItem.price_basis, "gross_margin_floor");
    assert.ok(String(firstItem.price_note).includes("30800") || String(firstItem.price_note).length > 0);

    const secondItem = progJson.items[1];
    assert.equal(secondItem.product_id, "TMP-000802");
    assert.equal(secondItem.proposed_price, 22000);

    // 5. Verify all 25 products remain draft, Square-unlinked, ai_managed, and mirrored to GAS
    assert.equal(
      gasMirrorCalls.filter((c) => c.action === "mirror_ai_product_draft_state").length,
      25
    );
    for (const pid of productIds) {
      const pRow = mockSupabase.state.products.get(pid);
      assert.equal(pRow.publish_status, "draft");
      assert.equal(pRow.square_item_id, "");
      assert.equal(pRow.square_payment_link_id, "");
      assert.equal(pRow.ai_draft_flag, "ai_managed");
      assert.equal(pRow.sheets_mirror_pending, false);
    }
    assert.equal(mockSupabase.state.products.get("TMP-000801").planned_sale_price, 30800);
    assert.equal(mockSupabase.state.products.get("TMP-000802").planned_sale_price, 22000);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Phase 2 Unit 5: Fail-closed unsearched draft, 429 circuit breaker + backoff, failed-only retry idempotency, NO_FAILED_ITEMS, cost fail-closed, and nightly job_source reuse", async () => {
  const mockSupabase = createBatchMockSupabase([
    makeDraftBundle("TMP-000901", 1, { sneaker_sku: "MARKER-901" }),
    makeDraftBundle("TMP-000902", 2, { sneaker_sku: "MARKER-902" }),
    makeDraftBundle("TMP-000903", 3, { sneaker_sku: "MARKER-903" }),
  ]);
  mockSupabase.state.staff_users = [
    { email: "staff@example.com", is_active: true, role: "admin" },
  ];

  let failCostRelay = false;
  let unsearchedFor902 = true;
  let rateLimit903Active = true;
  const generatedCountByProduct = new Map();

  const mockFetch = async (url, init = {}) => {
    const urlStr = String(url);
    if (urlStr.includes("/auth/v1/settings") || urlStr.includes("/auth/v1/user")) {
      return new Response(
        JSON.stringify({ id: "staff-1", email: "staff@example.com", external: {} }),
        { status: 200 }
      );
    }
    if (urlStr.includes("/functions/v1/documents-relay")) {
      if (failCostRelay) {
        return new Response("Internal Error", { status: 500 });
      }
      const body = JSON.parse(init.body || "{}");
      return new Response(
        JSON.stringify({
          success: true,
          product_id: body.product_id,
          cost_breakdown: null,
          links: [],
        }),
        { status: 200 }
      );
    }
    if (urlStr.startsWith("https://drive.google.com/uc?export=download")) {
      const fid = new URL(urlStr).searchParams.get("id") || "";
      // Encode fileId marker into trailing JPEG comment bytes so Gemini payload carries product identity
      const customBytes = Buffer.concat([TINY_JPEG_BYTES, Buffer.from(fid, "utf8")]);
      return new Response(customBytes, {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }
    if (urlStr.includes("generativelanguage.googleapis.com")) {
      const bodyStr = String(init.body || "");
      const reqJson = JSON.parse(bodyStr || "{}");
      const hasSearchTool = Array.isArray(reqJson.tools) && reqJson.tools.length > 0;
      const isPrior = reqJson.generationConfig?.maxOutputTokens === 100;
      if (isPrior) {
        return new Response(
          JSON.stringify({
            candidates: [
              { content: { parts: [{ text: JSON.stringify({ category: "sneaker", confidence: "high" }) }] } },
            ],
          }),
          { status: 200 }
        );
      }

      const inlineB64 =
        reqJson.contents?.[0]?.parts?.find((p) => p.inlineData?.data)?.inlineData?.data || "";
      const decodedBytes = inlineB64 ? Buffer.from(inlineB64, "base64").toString("utf8") : "";
      const matchedPid = ["TMP-000901", "TMP-000902", "TMP-000903", "TMP-000904", "TMP-000999"].find(
        (p) => decodedBytes.includes(p) || bodyStr.includes(p.slice(-3))
      );

      if (hasSearchTool) {
        if (matchedPid === "TMP-000903" && rateLimit903Active) {
          return new Response(JSON.stringify({ error: { message: "Quota exceeded" } }), {
            status: 429,
          });
        }
        if (matchedPid) {
          generatedCountByProduct.set(
            matchedPid,
            (generatedCountByProduct.get(matchedPid) || 0) + 1
          );
        }
        if (matchedPid === "TMP-000902" && unsearchedFor902) {
          // Simulate Gemini returning text WITHOUT executing Google Search (empty groundingMetadata)
          return new Response(
            JSON.stringify({
              candidates: [
                {
                  finishReason: "STOP",
                  groundingMetadata: {},
                  content: { parts: [{ text: "### 1. DIRECT PHYSICAL OBSERVATIONS\n- Sneaker" }] },
                },
              ],
            }),
            { status: 200 }
          );
        }
        return new Response(
          JSON.stringify({
            candidates: [
              {
                finishReason: "STOP",
                groundingMetadata: {
                  webSearchQueries: [`${matchedPid || "sneaker"} Nike`],
                  groundingChunks: [{ web: { uri: "https://snkrdunk.com/item", title: "Item" } }],
                },
                content: {
                  parts: [
                    {
                      text: "### 1. DIRECT PHYSICAL OBSERVATIONS\n- SKU: DD1391-100\n### 2. EXTERNAL SEARCH CORROBORATIONS\n- Nike Dunk Low\n### 3. PRICING TRANSACTIONS\n- Sold: 15,000円",
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 }
        );
      }

      return new Response(
        JSON.stringify({
          candidates: [
            {
              finishReason: "STOP",
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      title_ja: "ナイキ ダンク ロー パンダ (DD1391-100)",
                      title_en: "Nike Dunk Low Retro White Black (DD1391-100)",
                      description_ja: "ナイキ ダンク ローです。",
                      description_en: "Nike Dunk Low Retro.",
                      hashtags_ja: "#NIKE",
                      condition: "目立った傷や汚れなし",
                      category: "sneaker",
                      brand: "NIKE",
                      sku: "DD1391-100",
                      size: "27.0cm",
                      price: 15000,
                      price_basis: "recent_sold_provisional",
                      price_note: "成約参考 15,000円",
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 }
      );
    }
    if (urlStr.startsWith("https://gas.example/exec")) {
      return new Response(JSON.stringify({ success: true, confirmed_fingerprint: "FP_OK" }), {
        status: 200,
      });
    }
    throw new Error(`Unexpected URL: ${urlStr}`);
  };

  const handler = createProductsApiHandler({
    getSupabase: () => mockSupabase,
    fetchImpl: mockFetch,
    gasWebAppUrl: "https://gas.example/exec",
    internalSecret: "test-internal-secret",
    readdyBackendUrl: "https://readdy.example",
    geminiApiKey: "test-gemini-key",
    aiBatchConcurrency: 1,
    enableAutoBatchWorker: false,
  });

  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const staffHeaders = {
    "Content-Type": "application/json",
    Authorization: "Bearer valid-staff-jwt",
    apikey: "readdy-anon-key",
  };
  const internalHeaders = {
    "Content-Type": "application/json",
    "X-Internal-Sync-Token": "test-internal-secret",
  };

  try {
    // 1. Resilient when documents-relay fails: starts batch with cost_status="lookup_failed" & records failed IDs
    failCostRelay = true;
    const resilientRes = await fetch(`${baseUrl}/ai-batches`, {
      method: "POST",
      headers: staffHeaders,
      body: JSON.stringify({
        request_id: "REQ_COST_FAIL",
        product_ids: ["TMP-000901"],
      }),
    });
    const resilientJson = await resilientRes.json();
    assert.equal(resilientRes.status, 200);
    assert.equal(resilientJson.success, true);
    assert.equal(resilientJson.cost_fetch_failed_count, 1);
    assert.deepEqual(resilientJson.cost_fetch_failed_product_ids, ["TMP-000901"]);
    assert.equal(
      mockSupabase.state.ai_batch_jobs[0].product_costs_json["TMP-000901"].cost_status,
      "lookup_failed"
    );
    assert.equal(
      mockSupabase.state.ai_batch_jobs[0].product_costs_json["TMP-000901"].cost_breakdown,
      null
    );
    // Reset job state before step 2 so TMP-000901 can be queued in REQ_MIXED_001
    mockSupabase.state.ai_batch_jobs.length = 0;
    mockSupabase.state.ai_batch_items.length = 0;

    // 2. Create 4-item batch (TMP-000904 does not exist yet)
    failCostRelay = false;
    const createRes = await fetch(`${baseUrl}/ai-batches`, {
      method: "POST",
      headers: staffHeaders,
      body: JSON.stringify({
        request_id: "REQ_MIXED_001",
        product_ids: ["TMP-000901", "TMP-000902", "TMP-000903", "TMP-000904"],
      }),
    });
    const { batch_id: batchId } = await createRes.json();

    // Pass 1: 901 completes, 902 fails (unsearched), 903 hits 429 -> schedules retry & trips circuit breaker BEFORE 904!
    const pass1 = await (
      await fetch(`${baseUrl}/ai-batches/worker/run`, {
        method: "POST",
        headers: internalHeaders,
        body: "{}",
      })
    ).json();
    assert.equal(pass1.circuit_breaker_tripped, true);
    assert.equal(pass1.processed_count, 3);
    assert.equal(pass1.retry_scheduled_count, 1);

    // Verify 902 was NOT auto-applied to products (remains blank product_name)
    assert.equal(mockSupabase.state.products.get("TMP-000902").product_name, "");

    // Fast-forward 903's next_retry_at and run Pass 2 -> 903 completes, 904 fails PRODUCT_NOT_FOUND
    rateLimit903Active = false;
    for (const it of mockSupabase.state.ai_batch_items) {
      if (it.product_id === "TMP-000903") {
        it.next_retry_at = new Date(Date.now() - 1000).toISOString();
      }
    }
    await fetch(`${baseUrl}/ai-batches/worker/run`, {
      method: "POST",
      headers: internalHeaders,
      body: "{}",
    });

    const midProg = await (
      await fetch(`${baseUrl}/ai-batches/${batchId}`, { headers: staffHeaders })
    ).json();
    assert.equal(midProg.status, "partially_failed");
    assert.equal(midProg.completed_count, 2);
    assert.equal(midProg.failed_count, 2);
    const item902 = midProg.items.find((i) => i.product_id === "TMP-000902");
    assert.equal(item902.status, "failed");
    assert.ok(
      item902.error_code === "SEARCH_GROUNDING_NOT_EXECUTED" ||
        String(item902.error_code).startsWith("SEARCH_")
    );
    const item904 = midProg.items.find((i) => i.product_id === "TMP-000904");
    assert.equal(item904.status, "failed");
    assert.equal(item904.error_code, "PRODUCT_NOT_FOUND");

    // 3. Fix 902 search + add TMP-000904, then retry failed items ONLY
    unsearchedFor902 = false;
    mockSupabase.addProductBundle(makeDraftBundle("TMP-000904", 4));
    const gen901BeforeRetry = generatedCountByProduct.get("TMP-000901");
    const gen903BeforeRetry = generatedCountByProduct.get("TMP-000903");

    const retryRes = await fetch(`${baseUrl}/ai-batches/${batchId}/retry`, {
      method: "POST",
      headers: staffHeaders,
      body: JSON.stringify({ request_id: "RETRY_001" }),
    });
    const retryJson = await retryRes.json();
    assert.equal(retryJson.success, true);
    assert.equal(retryJson.retried_count, 2);
    assert.equal(retryJson.completed_count, 2);
    assert.equal(retryJson.failed_count, 0);
    assert.equal(retryJson.is_reused, false);

    // Duplicate retry request_id returns is_reused: true
    const retryDup = await (
      await fetch(`${baseUrl}/ai-batches/${batchId}/retry`, {
        method: "POST",
        headers: staffHeaders,
        body: JSON.stringify({ request_id: "RETRY_001" }),
      })
    ).json();
    assert.equal(retryDup.is_reused, true);
    assert.equal(retryDup.retried_count, 2);

    // Run worker pass 3 -> only 902 & 904 run; 901 & 903 are untouched!
    const pass3 = await (
      await fetch(`${baseUrl}/ai-batches/worker/run`, {
        method: "POST",
        headers: internalHeaders,
        body: "{}",
      })
    ).json();
    assert.equal(pass3.processed_count, 2);
    assert.equal(pass3.completed_count, 2);
    assert.equal(generatedCountByProduct.get("TMP-000901"), gen901BeforeRetry);
    assert.equal(generatedCountByProduct.get("TMP-000903"), gen903BeforeRetry);

    const finalProg = await (
      await fetch(`${baseUrl}/ai-batches/${batchId}`, { headers: staffHeaders })
    ).json();
    assert.equal(finalProg.status, "completed");
    assert.equal(finalProg.completed_count, 4);
    assert.equal(finalProg.failed_count, 0);

    // Retry when 0 failed items returns NO_FAILED_ITEMS
    const noFailRetry = await (
      await fetch(`${baseUrl}/ai-batches/${batchId}/retry`, {
        method: "POST",
        headers: staffHeaders,
        body: JSON.stringify({ request_id: "RETRY_NONE" }),
      })
    ).json();
    assert.equal(noFailRetry.success, false);
    assert.equal(noFailRetry.error_code, "NO_FAILED_ITEMS");

    // 4. Verify future nightly scheduled job can enqueue with job_source='scheduled_nightly' into the exact same queue
    mockSupabase.addProductBundle(makeDraftBundle("TMP-000999", 99));
    const nightlyRes = await (
      await fetch(`${baseUrl}/ai-batches`, {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({
          request_id: "NIGHTLY_2026_11_05",
          job_source: "scheduled_nightly",
          product_ids: ["TMP-000999"],
          product_costs: { "TMP-000999": null },
        }),
      })
    ).json();
    assert.equal(nightlyRes.success, true);
    assert.equal(nightlyRes.job_source, "scheduled_nightly");

    const nightlyPass = await (
      await fetch(`${baseUrl}/ai-batches/worker/run`, {
        method: "POST",
        headers: internalHeaders,
        body: "{}",
      })
    ).json();
    assert.equal(nightlyPass.completed_count, 1);

    // 5. Test Product Isolation: test_only=true succeeds ONLY when all IDs have is_test=true,
    //    and rejects BEFORE acceptance (0 jobs, 0 cost lookups) if any real/unknown product is mixed in.
    mockSupabase.addProductBundle(makeDraftBundle("TMP-000991", 101, { is_test: true }));
    mockSupabase.addProductBundle(makeDraftBundle("TMP-000992", 102, { is_test: true }));
    mockSupabase.addProductBundle(makeDraftBundle("TMP-000993", 103, { is_test: false }));

    const jobsCountBeforeReject = mockSupabase.state.ai_batch_jobs.length;
    const mixRejectResp = await fetch(`${baseUrl}/ai-batches`, {
      method: "POST",
      headers: staffHeaders,
      body: JSON.stringify({
        request_id: "TEST_BATCH_MIX_REJECT",
        test_only: true,
        product_ids: ["TMP-000991", "TMP-000993"],
      }),
    });
    assert.equal(mixRejectResp.status, 400);
    const mixRejectJson = await mixRejectResp.json();
    assert.equal(mixRejectJson.success, false);
    assert.equal(mixRejectJson.error_code, "NON_TEST_PRODUCT_INCLUDED");
    assert.deepEqual(mixRejectJson.non_test_product_ids, ["TMP-000993"]);
    assert.equal(mockSupabase.state.ai_batch_jobs.length, jobsCountBeforeReject);

    // Missing/unknown ID in test_only=true is also rejected before acceptance
    const missingRejectResp = await fetch(`${baseUrl}/ai-batches`, {
      method: "POST",
      headers: staffHeaders,
      body: JSON.stringify({
        request_id: "TEST_BATCH_MISSING_REJECT",
        test_only: true,
        product_ids: ["TMP-000991", "TMP-999999"],
      }),
    });
    assert.equal(missingRejectResp.status, 400);
    const missingRejectJson = await missingRejectResp.json();
    assert.equal(missingRejectJson.error_code, "NON_TEST_PRODUCT_INCLUDED");
    assert.deepEqual(missingRejectJson.non_test_product_ids, ["TMP-999999"]);
    assert.equal(mockSupabase.state.ai_batch_jobs.length, jobsCountBeforeReject);

    // Test-only batch with 2 pure test products succeeds end-to-end
    const testBatchCreateResp = await fetch(`${baseUrl}/ai-batches`, {
      method: "POST",
      headers: staffHeaders,
      body: JSON.stringify({
        request_id: "TEST_BATCH_PURE_OK",
        test_only: true,
        product_ids: ["TMP-000991", "TMP-000992"],
      }),
    });
    assert.equal(testBatchCreateResp.status, 200);
    const testBatchCreateJson = await testBatchCreateResp.json();
    assert.equal(testBatchCreateJson.success, true);
    assert.equal(testBatchCreateJson.test_only, true);
    assert.equal(testBatchCreateJson.total_count, 2);

    const testWorkerPass = await (
      await fetch(`${baseUrl}/ai-batches/worker/run`, {
        method: "POST",
        headers: internalHeaders,
        body: "{}",
      })
    ).json();
    assert.equal(testWorkerPass.completed_count, 2);
    assert.equal(mockSupabase.state.products.get("TMP-000991").is_test, true);
    assert.equal(mockSupabase.state.products.get("TMP-000992").is_test, true);
    assert.equal(mockSupabase.state.products.get("TMP-000991").publish_status, "draft");
    assert.equal(mockSupabase.state.products.get("TMP-000993").product_name, "");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});


test("Staff-Scheduled AI Batch Reservations: 200-item intake, pre-time non-execution, due start, double-start guard, cancel, state-change exclusions, cost fail-closed, and test/prod isolation", async () => {
  const initialBundles = [];

  // 200 real products (TMP-010001 .. TMP-010200) for 200-item reservation intake & cap verification
  const real200Ids = [];
  for (let i = 1; i <= 200; i += 1) {
    const pid = `TMP-${String(10000 + i).padStart(6, "0")}`;
    real200Ids.push(pid);
    initialBundles.push(makeDraftBundle(pid, i, { is_test: false }));
  }

  // Extra unreserved real & test products to prove NO automatic selection/substitution ever occurs
  initialBundles.push(makeDraftBundle("TMP-019999", 9999, { is_test: false }));
  initialBundles.push(makeDraftBundle("TMP-029999", 29999, { is_test: true }));

  // 6 test products (TMP-020001 .. TMP-020006) for execution, exclusion, and cancellation tests
  const testIds = [
    "TMP-020001",
    "TMP-020002",
    "TMP-020003",
    "TMP-020004",
    "TMP-020005",
    "TMP-020006",
  ];
  testIds.forEach((pid, idx) => {
    initialBundles.push(
      makeDraftBundle(pid, 2000 + idx, {
        is_test: true,
        product_name: `テスト下書き_${pid}`,
      })
    );
  });

  const mockSupabase = createBatchMockSupabase(initialBundles);
  mockSupabase.state.staff_users = [
    { email: "staff@example.com", is_active: true, role: "admin" },
  ];

  let costRelayShouldFail = false;
  let costRelayCallCount = 0;
  const costRelayAuthHeadersSeen = [];
  const confirmedCostsByProduct = {
    "TMP-020001": 20000, // floor = 20000 * 1.3 = 26000 (AI proposes 18000 -> raised to 26000)
    "TMP-020005": null, // no cost -> keeps AI proposed 18000
  };

  const mockFetch = async (url, init = {}) => {
    const urlStr = String(url);
    if (urlStr.includes("/auth/v1/settings") || urlStr.includes("/auth/v1/user")) {
      return new Response(
        JSON.stringify({ id: "staff-1", email: "staff@example.com", external: {} }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (urlStr.includes("/functions/v1/documents-relay")) {
      costRelayCallCount += 1;
      const hdrs = init.headers || {};
      costRelayAuthHeadersSeen.push({
        authorization: hdrs.Authorization || hdrs.authorization || "",
        apikey: hdrs.apikey || "",
      });
      if (costRelayShouldFail) {
        return new Response(JSON.stringify({ success: false, error: "Relay DB unavailable" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      }
      const reqBody = JSON.parse(String(init.body || "{}"));
      assert.equal(reqBody.action, "get_product_cost");
      const costVal =
        reqBody.product_id in confirmedCostsByProduct
          ? confirmedCostsByProduct[reqBody.product_id]
          : null;
      return new Response(
        JSON.stringify({
          success: true,
          product_id: reqBody.product_id,
          cost_breakdown:
            costVal !== null
              ? { total_allocated_cost: costVal, matched_lines_count: 1 }
              : null,
          links:
            costVal !== null
              ? [{ link_type: "primary_cost", allocated_amount: costVal }]
              : [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (urlStr.includes("https://drive.google.com/uc?export=download")) {
      return new Response(TINY_JPEG_BYTES, {
        status: 200,
        headers: { "Content-Type": "image/jpeg" },
      });
    }
    if (urlStr.includes(":generateContent")) {
      const bodyObj = JSON.parse(String(init.body || "{}"));
      const isPrior = bodyObj.generationConfig?.maxOutputTokens === 100;
      if (isPrior) {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: JSON.stringify({ category: "sneaker", confidence: "high" }) }],
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      const isSearchStage = Array.isArray(bodyObj.tools) && bodyObj.tools.length > 0;
      if (isSearchStage) {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                finishReason: "STOP",
                content: {
                  parts: [
                    {
                      text: [
                        "### 1. DIRECT PHYSICAL OBSERVATIONS",
                        "- BOX_LABEL_SKU: CW2288-111",
                        "- INNER_TAG_SIZE: 27.0cm",
                        "### 2. EXTERNAL SEARCH CORROBORATIONS",
                        "- CORROBORATED_MODEL: Nike Air Force 1 Low White",
                        "### 3. PRICING TRANSACTIONS",
                        "- Sold: 18,000円",
                      ].join("\n"),
                    },
                  ],
                },
                groundingMetadata: {
                  webSearchQueries: ["CW2288-111 Air Force 1"],
                  groundingChunks: [
                    { web: { uri: "https://example.com/af1", title: "AF1 Market" } },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          candidates: [
            {
              finishReason: "STOP",
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      title_ja: "ナイキ エアフォース1 ロー ホワイト (CW2288-111)",
                      hashtags_ja: "#ナイキ #エアフォース1",
                      description_ja: "定番ホワイトレザースニーカーです。",
                      title_en: "Nike Air Force 1 Low White (CW2288-111)",
                      description_en: "Classic white leather sneakers.",
                      category: "sneaker",
                      brand: "NIKE",
                      condition: "目立った傷や汚れなし",
                      size: "27.0cm",
                      sku: "CW2288-111",
                      price: 18000,
                      price_basis: "recent_sold_provisional",
                      price_note: "中古成約相場 18,000円",
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (urlStr.startsWith("https://script.google.com/macros/s/test/exec")) {
      const gasBody = JSON.parse(String(init.body || "{}"));
      return new Response(
        JSON.stringify({
          success: true,
          confirmed_fingerprint: `GAS_FP_${gasBody.product_id || "TEST"}`,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    throw new Error(`Unexpected fetch URL in schedule test: ${urlStr}`);
  };

  const handler = createProductsApiHandler({
    getSupabase: () => mockSupabase,
    fetchImpl: mockFetch,
    gasWebAppUrl: "https://script.google.com/macros/s/test/exec",
    readdyBackendUrl: "https://readdy.example.supabase.co",
    readdyBackendAnonKey: "readdy-server-anon-jwt-test",
    internalSecret: "schedule-internal-secret",
    geminiApiKey: "test-gemini-key",
    enableAutoBatchWorker: false,
  });

  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const internalHeaders = {
    "Content-Type": "application/json",
    "X-Internal-Sync-Token": "schedule-internal-secret",
  };
  const staffHeaders = {
    "Content-Type": "application/json",
    Authorization: "Bearer staff-jwt",
    apikey: "readdy-anon-key",
  };

  try {
    // 1. Old 2:00 AM auto-candidate-selection endpoint is strictly disabled (410 Gone)
    const oldNightlyUnauth = await fetch(`${baseUrl}/ai-batches/nightly/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(oldNightlyUnauth.status, 401);

    const oldNightlyDisabled = await fetch(`${baseUrl}/ai-batches/nightly/run`, {
      method: "POST",
      headers: internalHeaders,
      body: "{}",
    });
    assert.equal(oldNightlyDisabled.status, 410);
    assert.equal(
      (await oldNightlyDisabled.json()).error_code,
      "AUTO_NIGHTLY_SELECTION_DISABLED"
    );

    // Dispatcher endpoint auth boundary: unauth -> 401, browser token -> 403
    const dispUnauth = await fetch(`${baseUrl}/ai-batch-schedules/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(dispUnauth.status, 401);

    const dispForbidden = await fetch(`${baseUrl}/ai-batch-schedules/dispatch`, {
      method: "POST",
      headers: staffHeaders,
      body: "{}",
    });
    assert.equal(dispForbidden.status, 403);

    // 2. Reservation-time Test / Normal Mode Mix-in Rejection (Bidirectional)
    const mixTestInProdRes = await fetch(`${baseUrl}/ai-batch-schedules`, {
      method: "POST",
      headers: staffHeaders,
      body: JSON.stringify({
        request_id: "REQ_SCHED_MIX_PROD",
        scheduled_at: new Date(Date.now() + 3600_000).toISOString(),
        test_only: false,
        product_ids: ["TMP-010001", "TMP-020001"],
      }),
    });
    assert.equal(mixTestInProdRes.status, 400);
    assert.equal((await mixTestInProdRes.json()).error_code, "TEST_PRODUCT_INCLUDED");

    const mixRealInTestRes = await fetch(`${baseUrl}/ai-batch-schedules`, {
      method: "POST",
      headers: staffHeaders,
      body: JSON.stringify({
        request_id: "REQ_SCHED_MIX_TEST",
        scheduled_at: new Date(Date.now() + 3600_000).toISOString(),
        test_only: true,
        product_ids: ["TMP-020001", "TMP-010001"],
      }),
    });
    assert.equal(mixRealInTestRes.status, 400);
    assert.equal(
      (await mixRealInTestRes.json()).error_code,
      "NON_TEST_PRODUCT_INCLUDED"
    );

    // Reject >500 items
    const over500Ids = Array.from({ length: 501 }, (_, idx) => `TMP-X${idx}`);
    const over500Res = await fetch(`${baseUrl}/ai-batch-schedules`, {
      method: "POST",
      headers: staffHeaders,
      body: JSON.stringify({
        request_id: "REQ_SCHED_OVER_500",
        scheduled_at: new Date(Date.now() + 3600_000).toISOString(),
        test_only: false,
        product_ids: over500Ids,
      }),
    });
    assert.equal(over500Res.status, 400);
    assert.equal((await over500Res.json()).error_code, "BATCH_SIZE_EXCEEDED");

    // 3. 200-item Reservation Intake + Pre-Start Cancellation
    //    Verify 0 documents-relay cost calls occur at reservation time (no browser timeout risk!)
    costRelayCallCount = 0;
    const future2hIso = new Date(Date.now() + 2 * 3600_000).toISOString();
    const sched200Res = await fetch(`${baseUrl}/ai-batch-schedules`, {
      method: "POST",
      headers: staffHeaders,
      body: JSON.stringify({
        request_id: "REQ_SCHED_200_ITEMS",
        scheduled_at: future2hIso,
        test_only: false,
        min_cost_markup_rate: 0.35,
        product_ids: real200Ids,
      }),
    });
    assert.equal(sched200Res.status, 200);
    const sched200 = await sched200Res.json();
    assert.equal(sched200.success, true);
    assert.equal(sched200.is_reused, false);
    assert.equal(sched200.overall_status, "scheduled");
    assert.equal(sched200.can_cancel, true);
    assert.equal(sched200.total_reserved_count, 200);
    assert.deepEqual(sched200.product_ids, real200Ids);
    assert.equal(
      sched200.scheduled_at_jst,
      formatJstDateTimeDisplay(future2hIso)
    );
    assert.equal(costRelayCallCount, 0); // Cost lookup deferred to execution time!

    // Duplicate request_id returns is_reused: true without creating a second schedule
    const sched200Dup = await (
      await fetch(`${baseUrl}/ai-batch-schedules`, {
        method: "POST",
        headers: staffHeaders,
        body: JSON.stringify({
          request_id: "REQ_SCHED_200_ITEMS",
          scheduled_at: future2hIso,
          test_only: false,
          min_cost_markup_rate: 0.35,
          product_ids: real200Ids,
        }),
      })
    ).json();
    assert.equal(sched200Dup.is_reused, true);
    assert.equal(sched200Dup.schedule_id, sched200.schedule_id);
    assert.equal(mockSupabase.state.ai_batch_schedules.length, 1);

    // Pre-start cancellation succeeds (200) and prevents future execution
    const cancel200Res = await fetch(
      `${baseUrl}/ai-batch-schedules/${sched200.schedule_id}/cancel`,
      {
        method: "POST",
        headers: staffHeaders,
        body: JSON.stringify({ test_only: false }),
      }
    );
    assert.equal(cancel200Res.status, 200);
    const cancel200 = await cancel200Res.json();
    assert.equal(cancel200.overall_status, "cancelled");
    assert.equal(cancel200.can_cancel, false);

    // Dispatch even AFTER future2hIso must NOT run a cancelled schedule
    const dispAfterCancel = await dispatchDueAiBatchSchedules({
      supabase: mockSupabase,
      fetchImpl: mockFetch,
      gasWebAppUrl: "https://script.google.com/macros/s/test/exec",
      readdyBackendUrl: "https://readdy.example.supabase.co",
      readdyBackendAnonKey: "readdy-server-anon-jwt-test",
      now: new Date(Date.now() + 3 * 3600_000),
      triggerWorker: async () => ({ triggered: false }),
    });
    assert.equal(dispAfterCancel.body.claimed_count, 0);
    assert.equal(mockSupabase.state.ai_batch_jobs.length, 0);

    // 4. Execution Flow: Non-execution before scheduled_at -> State Changes & Exclusions -> Cost Fail-Closed -> Due Execution -> Double-Start Guard -> Browser Reopen Persistence
    const schedTargetMs = Date.now() + 30 * 60_000;
    const schedTargetIso = new Date(schedTargetMs).toISOString();
    const reserveTestRes = await fetch(`${baseUrl}/ai-batch-schedules`, {
      method: "POST",
      headers: staffHeaders,
      body: JSON.stringify({
        request_id: "REQ_SCHED_TEST_EXEC_001",
        scheduled_at: schedTargetIso,
        test_only: true,
        min_cost_markup_rate: 0.3,
        product_ids: testIds, // TMP-020001 .. TMP-020006
        product_names: {
          "TMP-020001": "テストスニーカー1",
          "TMP-020002": "公開済みに変わる商品",
          "TMP-020003": "アーカイブに変わる商品",
          "TMP-020004": "画像0枚に変わる商品",
          "TMP-020005": "テストスニーカー5",
          "TMP-020006": "通常商品へ変わった不整合商品",
        },
      }),
    });
    assert.equal(reserveTestRes.status, 200);
    const reserveTest = await reserveTestRes.json();
    const testScheduleId = reserveTest.schedule_id;

    // 4a. Before scheduled_at (1 minute early): dispatcher does NOT start it
    const earlyDispatch = await dispatchDueAiBatchSchedules({
      supabase: mockSupabase,
      fetchImpl: mockFetch,
      gasWebAppUrl: "https://script.google.com/macros/s/test/exec",
      readdyBackendUrl: "https://readdy.example.supabase.co",
      readdyBackendAnonKey: "readdy-server-anon-jwt-test",
      now: new Date(schedTargetMs - 60_000),
      triggerWorker: async () => ({ triggered: false }),
    });
    assert.equal(earlyDispatch.body.claimed_count, 0);
    assert.equal(mockSupabase.state.ai_batch_jobs.length, 0);

    // 4b. Mutate 4 of the 6 reserved products BEFORE scheduled_at arrives:
    //     - TMP-020002 -> published
    //     - TMP-020003 -> archived
    //     - TMP-020004 -> 0 images
    //     - TMP-020006 -> flipped is_test=false (mode mismatch at execution time!)
    //     Meanwhile TMP-029999 (unreserved eligible test product) sits in DB and MUST NOT be substituted!
    mockSupabase.state.products.get("TMP-020002").publish_status = "published";
    mockSupabase.state.products.get("TMP-020003").record_status = "archived";
    mockSupabase.state.product_images = mockSupabase.state.product_images.filter(
      (im) => im.product_id !== "TMP-020004"
    );
    mockSupabase.state.products.get("TMP-020006").is_test = false;

    // 4c. Cost Fetch Resilience at scheduled_at:
    //     Simulate documents-relay 503 outage -> resolveConfirmedProductCostsForBatch does NOT fail-close;
    //     it records lookup_failed with NO dummy/0 cost so the schedule can still start!
    costRelayShouldFail = true;
    const outageCostRes = await resolveConfirmedProductCostsForBatch({
      productIds: ["TMP-020001", "TMP-020005"],
      readdyBackendUrl: "https://readdy.example.supabase.co",
      readdyBackendAnonKey: "readdy-server-anon-jwt-test",
      fetchImpl: mockFetch,
    });
    assert.equal(outageCostRes["TMP-020001"].cost_status, "lookup_failed");
    assert.equal(outageCostRes["TMP-020005"].cost_status, "lookup_failed");
    assert.equal(outageCostRes["TMP-020001"].cost_breakdown, null);

    // 4d. Dispatcher starts ONLY ["TMP-020001", "TMP-020005"]!
    costRelayShouldFail = false;
    costRelayAuthHeadersSeen.length = 0;
    let workerWakeCount = 0;
    const dueDispatch = await dispatchDueAiBatchSchedules({
      supabase: mockSupabase,
      fetchImpl: mockFetch,
      gasWebAppUrl: "https://script.google.com/macros/s/test/exec",
      readdyBackendUrl: "https://readdy.example.supabase.co",
      readdyBackendAnonKey: "readdy-server-anon-jwt-test",
      now: new Date(schedTargetMs + 65_000),
      triggerWorker: async () => {
        workerWakeCount += 1;
        return { triggered: true };
      },
    });
    assert.equal(dueDispatch.body.claimed_count, 1);
    assert.equal(dueDispatch.body.results[0].outcome, "started");
    assert.equal(dueDispatch.body.results[0].eligible_count, 2);
    assert.equal(dueDispatch.body.results[0].excluded_count, 4);
    assert.equal(workerWakeCount, 1);
    assert.equal(mockSupabase.state.ai_batch_jobs.length, 1);

    // Verify server-to-server cost lookup ONLY queried the 2 eligible items with READDY_BACKEND_ANON_KEY
    assert.equal(costRelayAuthHeadersSeen.length, 2);
    assert.equal(
      costRelayAuthHeadersSeen[0].authorization,
      "Bearer readdy-server-anon-jwt-test"
    );

    // Verify exact queued items (NO TMP-029999 substitution!)
    const createdBatchId = dueDispatch.body.results[0].batch_id;
    const queuedPids = mockSupabase.state.ai_batch_items
      .filter((i) => i.batch_id === createdBatchId)
      .sort((a, b) => a.item_index - b.item_index)
      .map((i) => i.product_id);
    assert.deepEqual(queuedPids, ["TMP-020001", "TMP-020005"]);

    // 4e. Double-start prevention: repeated dispatch call does NOT create a duplicate job
    const dupDispatch = await dispatchDueAiBatchSchedules({
      supabase: mockSupabase,
      fetchImpl: mockFetch,
      gasWebAppUrl: "https://script.google.com/macros/s/test/exec",
      readdyBackendUrl: "https://readdy.example.supabase.co",
      readdyBackendAnonKey: "readdy-server-anon-jwt-test",
      now: new Date(schedTargetMs + 70_000),
      triggerWorker: async () => ({ triggered: true }),
    });
    assert.equal(dupDispatch.body.claimed_count, 0);
    assert.equal(mockSupabase.state.ai_batch_jobs.length, 1);

    // 4f. Post-start cancellation is rejected with 409 SCHEDULE_ALREADY_STARTED
    const cancelAfterStartRes = await fetch(
      `${baseUrl}/ai-batch-schedules/${testScheduleId}/cancel`,
      {
        method: "POST",
        headers: staffHeaders,
        body: JSON.stringify({ test_only: true }),
      }
    );
    assert.equal(cancelAfterStartRes.status, 409);
    assert.equal(
      (await cancelAfterStartRes.json()).error_code,
      "SCHEDULE_ALREADY_STARTED"
    );

    // 4g. Run worker pass to complete AI draft generation while browser is closed
    const workerReport = await (
      await fetch(`${baseUrl}/ai-batches/worker/run`, {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({ max_items: 10 }),
      })
    ).json();
    assert.equal(workerReport.completed_count, 2);

    // Verify cost floor on TMP-020001 (20000 / (1 - 0.30) = 28571.43 -> 28600) & market price on TMP-020005 (18000), both remaining draft
    assert.equal(mockSupabase.state.products.get("TMP-020001").planned_sale_price, 28600);
    assert.equal(mockSupabase.state.products.get("TMP-020001").publish_status, "draft");
    assert.equal(mockSupabase.state.products.get("TMP-020005").planned_sale_price, 18000);
    assert.equal(mockSupabase.state.products.get("TMP-020005").publish_status, "draft");
    // Unreserved TMP-029999 & TMP-019999 untouched
    assert.equal(mockSupabase.state.products.get("TMP-029999").product_name, "");
    assert.equal(mockSupabase.state.products.get("TMP-019999").product_name, "");

    // 4h. Reopen Browser (no localStorage!): GET /ai-batch-schedules & GET /ai-batch-schedules/:id
    //     Verify mode separation: Normal mode list shows ONLY the normal schedule; Test mode list shows ONLY the test schedule!
    const listProd = await (
      await fetch(`${baseUrl}/ai-batch-schedules?test_only=false`, {
        headers: staffHeaders,
      })
    ).json();
    assert.equal(listProd.count, 1);
    assert.equal(listProd.schedules[0].schedule_id, sched200.schedule_id);
    assert.equal(listProd.schedules[0].overall_status, "cancelled");

    const listTest = await (
      await fetch(`${baseUrl}/ai-batch-schedules?test_only=true`, {
        headers: staffHeaders,
      })
    ).json();
    assert.equal(listTest.count, 1);
    assert.equal(listTest.schedules[0].schedule_id, testScheduleId);
    assert.equal(listTest.schedules[0].overall_status, "completed");
    assert.equal(listTest.schedules[0].total_reserved_count, 6);
    assert.equal(listTest.schedules[0].eligible_count, 2);
    assert.equal(listTest.schedules[0].completed_count, 2);
    assert.equal(listTest.schedules[0].failed_count, 0);
    assert.equal(listTest.schedules[0].excluded_count, 4);

    const detailTest = await (
      await fetch(
        `${baseUrl}/ai-batch-schedules/${testScheduleId}?test_only=true`,
        { headers: staffHeaders }
      )
    ).json();
    assert.equal(detailTest.overall_status, "completed");
    assert.equal(detailTest.items.length, 6);
    assert.deepEqual(
      detailTest.items.map((it) => [it.product_id, it.status, it.error_code]),
      [
        ["TMP-020001", "completed", null],
        ["TMP-020002", "excluded", "PUBLISHED_PRODUCT_NOT_ALLOWED"],
        ["TMP-020003", "excluded", "INACTIVE_PRODUCT_NOT_ALLOWED"],
        ["TMP-020004", "excluded", "NO_IMAGES_FOUND"],
        ["TMP-020005", "completed", null],
        ["TMP-020006", "excluded", "NON_TEST_PRODUCT_INCLUDED"],
      ]
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Unified Cross-Device Runs & Active Product Overlap Guard: lists immediate + scheduled runs without duplicates, blocks overlapping scheduled/pending/processing IDs with 409, and allows intentional regeneration after cancel or completion", async () => {
  const initialBundles = [
    ["TMP-030001", 3001, "テスト商品A", true],
    ["TMP-030002", 3002, "テスト商品B", true],
    ["TMP-030003", 3003, "テスト商品C", true],
    ["TMP-030004", 3004, "実商品D", false],
  ].map(([pid, idx, name, isTest]) =>
    makeDraftBundle(pid, idx, { is_test: isTest, product_name: name })
  );

  const mockSupabase = createBatchMockSupabase(initialBundles);
  mockSupabase.state.staff_users = [
    { email: "staff@bis.example.com", is_active: true, role: "admin" },
  ];

  const mockFetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes("/auth/v1/settings") || u.includes("/auth/v1/user")) {
      return new Response(
        JSON.stringify({ id: "staff-user-2", email: "staff@bis.example.com", external: {} }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (u.includes("/functions/v1/documents-relay")) {
      const body = init.body ? JSON.parse(init.body) : {};
      return new Response(
        JSON.stringify({
          success: true,
          product_id: body.product_id,
          links: [{ link_type: "primary_cost", allocated_amount: 10000 }],
          cost_breakdown: {
            product_id: body.product_id,
            total_allocated_cost: 10000,
            matched_lines_count: 1,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (
      u.includes("https://drive.google.com/uc?export=download") ||
      u.includes("lh3.googleusercontent.com")
    ) {
      return new Response(TINY_JPEG_BYTES, {
        status: 200,
        headers: { "Content-Type": "image/jpeg" },
      });
    }
    if (u.includes(":generateContent")) {
      const bodyObj = JSON.parse(String(init.body || "{}"));
      const isPrior = bodyObj.generationConfig?.maxOutputTokens === 100;
      if (isPrior) {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: JSON.stringify({ category: "sneaker", confidence: "high" }) }],
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      const isSearchStage = Array.isArray(bodyObj.tools) && bodyObj.tools.length > 0;
      if (isSearchStage) {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                finishReason: "STOP",
                content: {
                  parts: [
                    {
                      text: [
                        "### 1. DIRECT PHYSICAL OBSERVATIONS",
                        "- BOX_LABEL_SKU: CW2288-111",
                        "- INNER_TAG_SIZE: 27.0cm",
                        "### 2. EXTERNAL SEARCH CORROBORATIONS",
                        "- CORROBORATED_MODEL: Nike Air Force 1 Low White",
                        "### 3. PRICING TRANSACTIONS",
                        "- Sold: 15,000円",
                      ].join("\n"),
                    },
                  ],
                },
                groundingMetadata: {
                  webSearchQueries: ["CW2288-111 Air Force 1"],
                  groundingChunks: [
                    { web: { uri: "https://example.com/af1", title: "AF1 Market" } },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          candidates: [
            {
              finishReason: "STOP",
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      title_ja: "AI再生成タイトル",
                      hashtags_ja: "#テスト",
                      description_ja: "テスト説明文です。",
                      title_en: "AI Regenerated Title",
                      description_en: "Test description.",
                      category: "sneaker",
                      brand: "NIKE",
                      condition: "目立った傷や汚れなし",
                      size: "27.0cm",
                      sku: "CW2288-111",
                      price: 15000,
                      price_basis: "recent_sold_provisional",
                      price_note: "相場 15,000円",
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (u.startsWith("https://script.google.com/macros/s/test/exec")) {
      const gasBody = JSON.parse(String(init.body || "{}"));
      return new Response(
        JSON.stringify({
          success: true,
          confirmed_fingerprint: `GAS_FP_${gasBody.product_id || "TEST"}`,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  };

  const handler = createProductsApiHandler({
    getSupabase: () => mockSupabase,
    fetchImpl: mockFetch,
    gasWebAppUrl: "https://script.google.com/macros/s/test/exec",
    internalSecret: "sched-overlap-secret-test",
    readdyBackendUrl: "https://readdy.example.supabase.co",
    readdyBackendAnonKey: "readdy-server-anon-jwt-test",
    geminiApiKey: "gemini-test-key",
    enableAutoBatchWorker: false,
  });

  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const staffHeaders = {
    "Content-Type": "application/json",
    Authorization: "Bearer staff-jwt-token",
    apikey: "readdy-anon-key",
  };
  const internalHeaders = {
    "Content-Type": "application/json",
    "X-Internal-Sync-Token": "sched-overlap-secret-test",
  };

  try {
    const baseNowMs = Date.now();
    const futureIso = new Date(baseNowMs + 2 * 3600_000).toISOString();

    // 1. Device A creates a scheduled reservation on TMP-030001
    const schedARes = await fetch(`${baseUrl}/ai-batch-schedules`, {
      method: "POST",
      headers: staffHeaders,
      body: JSON.stringify({
        request_id: "REQ_OVERLAP_SCHED_A",
        scheduled_at: futureIso,
        product_ids: ["TMP-030001"],
        test_only: true,
      }),
    });
    assert.equal(schedARes.status, 200);
    const schedA = await schedARes.json();
    assert.equal(schedA.overall_status, "scheduled");

    // 1b. Idempotent replay with same request_id succeeds (200, is_reused: true) without self-conflicting
    const schedAReplayRes = await fetch(`${baseUrl}/ai-batch-schedules`, {
      method: "POST",
      headers: staffHeaders,
      body: JSON.stringify({
        request_id: "REQ_OVERLAP_SCHED_A",
        scheduled_at: futureIso,
        product_ids: ["TMP-030001"],
        test_only: true,
      }),
    });
    assert.equal(schedAReplayRes.status, 200);
    assert.equal((await schedAReplayRes.json()).is_reused, true);

    // 2. Submitting TMP-030001 + TMP-030002 to an IMMEDIATE batch is rejected with 409 showing ONLY TMP-030001
    const immConflictRes = await fetch(`${baseUrl}/ai-batches`, {
      method: "POST",
      headers: staffHeaders,
      body: JSON.stringify({
        request_id: "REQ_IMM_CONFLICT_1",
        product_ids: ["TMP-030001", "TMP-030002"],
        test_only: true,
      }),
    });
    assert.equal(immConflictRes.status, 409);
    const immConflictBody = await immConflictRes.json();
    assert.equal(immConflictBody.error_code, "PRODUCT_ALREADY_IN_ACTIVE_AI_BATCH");
    assert.deepEqual(immConflictBody.conflicting_product_ids, ["TMP-030001"]);
    assert.match(immConflictBody.message, /TMP-030001/);
    assert.doesNotMatch(immConflictBody.message, /TMP-030002/);
    assert.equal(mockSupabase.state.ai_batch_jobs.length, 0);

    // 3. Submitting TMP-030001 + TMP-030002 to ANOTHER reservation is also rejected with 409 showing TMP-030001
    const schedConflictRes = await fetch(`${baseUrl}/ai-batch-schedules`, {
      method: "POST",
      headers: staffHeaders,
      body: JSON.stringify({
        request_id: "REQ_SCHED_CONFLICT_1",
        scheduled_at: futureIso,
        product_ids: ["TMP-030001", "TMP-030002"],
        test_only: true,
      }),
    });
    assert.equal(schedConflictRes.status, 409);
    const schedConflictBody = await schedConflictRes.json();
    assert.equal(schedConflictBody.error_code, "PRODUCT_ALREADY_IN_ACTIVE_AI_BATCH");
    assert.deepEqual(schedConflictBody.conflicting_product_ids, ["TMP-030001"]);

    // 4. Non-overlapping TMP-030002 CAN start an immediate batch right away
    const immOkRes = await fetch(`${baseUrl}/ai-batches`, {
      method: "POST",
      headers: staffHeaders,
      body: JSON.stringify({
        request_id: "REQ_IMM_OK_B",
        product_ids: ["TMP-030002"],
        test_only: true,
      }),
    });
    assert.equal(immOkRes.status, 200);
    const immOk = await immOkRes.json();
    assert.equal(immOk.status, "queued");

    // 4b. Idempotent replay of immediate batch request_id succeeds (200, is_reused: true)
    const immReplayRes = await fetch(`${baseUrl}/ai-batches`, {
      method: "POST",
      headers: staffHeaders,
      body: JSON.stringify({
        request_id: "REQ_IMM_OK_B",
        product_ids: ["TMP-030002"],
        test_only: true,
      }),
    });
    assert.equal(immReplayRes.status, 200);
    assert.equal((await immReplayRes.json()).is_reused, true);

    // 5. While TMP-030002 is `pending` in immediate batch, both another immediate batch and a reservation reject TMP-030002
    const pendingImmDup = await fetch(`${baseUrl}/ai-batches`, {
      method: "POST",
      headers: staffHeaders,
      body: JSON.stringify({
        request_id: "REQ_IMM_CONFLICT_2",
        product_ids: ["TMP-030002", "TMP-030003"],
        test_only: true,
      }),
    });
    assert.equal(pendingImmDup.status, 409);
    assert.deepEqual((await pendingImmDup.json()).conflicting_product_ids, ["TMP-030002"]);

    const pendingSchedDup = await fetch(`${baseUrl}/ai-batch-schedules`, {
      method: "POST",
      headers: staffHeaders,
      body: JSON.stringify({
        request_id: "REQ_SCHED_CONFLICT_2",
        scheduled_at: futureIso,
        product_ids: ["TMP-030002"],
        test_only: true,
      }),
    });
    assert.equal(pendingSchedDup.status, 409);
    assert.deepEqual((await pendingSchedDup.json()).conflicting_product_ids, ["TMP-030002"]);

    // 5b. Simulate TMP-030002 actively `processing` -> still rejected with 409!
    mockSupabase.state.ai_batch_items.find(
      (i) => i.batch_id === immOk.batch_id
    ).status = "processing";
    const processingDup = await fetch(`${baseUrl}/ai-batches`, {
      method: "POST",
      headers: staffHeaders,
      body: JSON.stringify({
        request_id: "REQ_IMM_CONFLICT_PROCESSING",
        product_ids: ["TMP-030002"],
        test_only: true,
      }),
    });
    assert.equal(processingDup.status, 409);
    assert.deepEqual((await processingDup.json()).conflicting_product_ids, ["TMP-030002"]);
    // Restore to pending so worker runs it cleanly
    mockSupabase.state.ai_batch_items.find(
      (i) => i.batch_id === immOk.batch_id
    ).status = "pending";

    // 5c. Retrying an older failed batch whose failed item (TMP-030002) is currently active in immOk is ALSO blocked with 409!
    mockSupabase.state.ai_batch_jobs.push({
      batch_id: "BATCH_OLD_FAILED_1",
      request_id: "REQ_OLD_FAILED_1",
      job_source: "manual",
      status: "failed",
      total_count: 1,
      completed_count: 0,
      failed_count: 1,
      processing_count: 0,
      force_regenerate: false,
      test_only: true,
      model_name: "",
      min_cost_markup_rate: 0.3,
      product_costs_json: {},
      retry_requests: {},
      created_at: new Date(baseNowMs - 600_000).toISOString(),
      updated_at: new Date(baseNowMs - 590_000).toISOString(),
      completed_at: new Date(baseNowMs - 590_000).toISOString(),
    });
    mockSupabase.state.ai_batch_items.push({
      id: 99991,
      batch_id: "BATCH_OLD_FAILED_1",
      product_id: "TMP-030002",
      item_index: 0,
      status: "failed",
      selected_image_ids: [],
      source_image_ids: [],
      draft_id: null,
      draft_version: null,
      model_name: null,
      proposed_price: null,
      price_basis: null,
      price_note: null,
      error_code: "LLM_COMMUNICATION_FAILED",
      error_message: "temporary error",
      retry_count: 3,
      next_retry_at: null,
      worker_execution_id: null,
      lease_expires_at: null,
      created_at: new Date(baseNowMs - 600_000).toISOString(),
      updated_at: new Date(baseNowMs - 590_000).toISOString(),
    });
    const retryConflictRes = await fetch(
      `${baseUrl}/ai-batches/BATCH_OLD_FAILED_1/retry`,
      {
        method: "POST",
        headers: staffHeaders,
        body: JSON.stringify({ request_id: "REQ_RETRY_CONFLICT_1" }),
      }
    );
    assert.equal(retryConflictRes.status, 409);
    assert.deepEqual(
      (await retryConflictRes.json()).conflicting_product_ids,
      ["TMP-030002"]
    );
    // Remove synthetic failed batch before unified run count assertions below
    mockSupabase.state.ai_batch_jobs = mockSupabase.state.ai_batch_jobs.filter(
      (j) => j.batch_id !== "BATCH_OLD_FAILED_1"
    );
    mockSupabase.state.ai_batch_items = mockSupabase.state.ai_batch_items.filter(
      (i) => i.batch_id !== "BATCH_OLD_FAILED_1"
    );

    // 6. Device B (fresh browser, NO localStorage): GET /ai-batch-runs?test_only=true lists BOTH immediate & scheduled!
    const runsTestRes = await fetch(`${baseUrl}/ai-batch-runs?test_only=true`, {
      headers: staffHeaders,
    });
    assert.equal(runsTestRes.status, 200);
    const runsTest = await runsTestRes.json();
    assert.equal(runsTest.count, 2);
    assert.deepEqual(
      new Set(runsTest.runs.map((r) => `${r.run_type}:${r.schedule_id || r.batch_id}`)),
      new Set([
        `scheduled:${schedA.schedule_id}`,
        `immediate:${immOk.batch_id}`,
      ])
    );

    // Normal mode (`test_only=false`) sees 0 runs (strict mode isolation)
    const runsNormal = await (
      await fetch(`${baseUrl}/ai-batch-runs?test_only=false`, {
        headers: staffHeaders,
      })
    ).json();
    assert.equal(runsNormal.count, 0);

    // Device B fetches immediate batch detail and receives server-hydrated product_name ("テスト商品B")
    const immDetailOnDeviceB = await (
      await fetch(`${baseUrl}/ai-batches/${immOk.batch_id}?test_only=true`, {
        headers: staffHeaders,
      })
    ).json();
    assert.equal(immDetailOnDeviceB.items.length, 1);
    assert.equal(immDetailOnDeviceB.items[0].product_id, "TMP-030002");
    assert.equal(immDetailOnDeviceB.items[0].product_name, "テスト商品B");

    // Wrong mode filter on GET /ai-batches/:batchId returns BATCH_NOT_FOUND
    const immWrongModeBody = await (
      await fetch(`${baseUrl}/ai-batches/${immOk.batch_id}?test_only=false`, {
        headers: staffHeaders,
      })
    ).json();
    assert.equal(immWrongModeBody.success, false);
    assert.equal(immWrongModeBody.error_code, "BATCH_NOT_FOUND");

    // 7. Complete immediate batch on TMP-030002 -> draft_version 1 created
    await fetch(`${baseUrl}/ai-batches/worker/run`, {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify({ max_items: 5 }),
    });
    const completedImm = await (
      await fetch(`${baseUrl}/ai-batches/${immOk.batch_id}?test_only=true`, {
        headers: staffHeaders,
      })
    ).json();
    assert.equal(completedImm.status, "completed");
    assert.equal(completedImm.items[0].draft_version, 1);

    // 8. Intentional regeneration AFTER completion is NOT blocked!
    //    8a. Immediate regeneration on TMP-030002 with force_regenerate: true -> succeeds & creates draft_version 2
    const regenImmRes = await fetch(`${baseUrl}/ai-batches`, {
      method: "POST",
      headers: staffHeaders,
      body: JSON.stringify({
        request_id: "REQ_IMM_REGEN_B",
        product_ids: ["TMP-030002"],
        test_only: true,
        force_regenerate: true,
      }),
    });
    assert.equal(regenImmRes.status, 200);
    const regenImm = await regenImmRes.json();
    assert.equal(regenImm.force_regenerate, true);
    await fetch(`${baseUrl}/ai-batches/worker/run`, {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify({ max_items: 5 }),
    });
    const completedRegenImm = await (
      await fetch(`${baseUrl}/ai-batches/${regenImm.batch_id}?test_only=true`, {
        headers: staffHeaders,
      })
    ).json();
    assert.equal(completedRegenImm.status, "completed");
    assert.equal(completedRegenImm.items[0].draft_version, 2);

    //    8b. Cancel schedA on TMP-030001 -> cancelled reservation does NOT block new jobs!
    const cancelARes = await fetch(
      `${baseUrl}/ai-batch-schedules/${schedA.schedule_id}/cancel`,
      {
        method: "POST",
        headers: staffHeaders,
        body: JSON.stringify({ test_only: true }),
      }
    );
    assert.equal(cancelARes.status, 200);

    //    8c. Create a scheduled regeneration for BOTH TMP-030001 (was cancelled) & TMP-030002 (completed v2) with force_regenerate: true
    const nearIso = new Date(baseNowMs + 60_000).toISOString();
    const regenSchedRes = await fetch(`${baseUrl}/ai-batch-schedules`, {
      method: "POST",
      headers: staffHeaders,
      body: JSON.stringify({
        request_id: "REQ_SCHED_REGEN_AB",
        scheduled_at: nearIso,
        product_ids: ["TMP-030001", "TMP-030002"],
        test_only: true,
        force_regenerate: true,
      }),
    });
    assert.equal(regenSchedRes.status, 200);
    const regenSched = await regenSchedRes.json();
    assert.equal(regenSched.force_regenerate, true);

    // Dispatch at due time (must NOT conflict with itself via p_ignore_schedule_id!) and run worker
    const dispRes = await dispatchDueAiBatchSchedules({
      supabase: mockSupabase,
      fetchImpl: mockFetch,
      gasWebAppUrl: "https://script.google.com/macros/s/test/exec",
      readdyBackendUrl: "https://readdy.example.supabase.co",
      readdyBackendAnonKey: "readdy-server-anon-jwt-test",
      now: new Date(baseNowMs + 65_000),
      triggerWorker: async () => ({ triggered: true }),
    });
    assert.equal(dispRes.body.results[0].outcome, "started");
    await fetch(`${baseUrl}/ai-batches/worker/run`, {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify({ max_items: 5 }),
    });

    const regenSchedDone = await (
      await fetch(
        `${baseUrl}/ai-batch-schedules/${regenSched.schedule_id}?test_only=true`,
        { headers: staffHeaders }
      )
    ).json();
    assert.equal(regenSchedDone.overall_status, "completed");
    assert.deepEqual(
      regenSchedDone.items.map((i) => [i.product_id, i.status, i.draft_version]),
      [
        ["TMP-030001", "completed", 1],
        ["TMP-030002", "completed", 3],
      ]
    );

    // 9. Verify unified GET /ai-batch-runs does NOT duplicate started schedule's underlying batch_id!
    //    Expected runs: 2 immediate (`immOk`, `regenImm`) + 2 scheduled (`schedA`, `regenSched`) = 4 runs total
    const finalRuns = await (
      await fetch(`${baseUrl}/ai-batch-runs?test_only=true`, {
        headers: staffHeaders,
      })
    ).json();
    assert.equal(finalRuns.count, 4);
    assert.equal(
      finalRuns.runs.filter((r) => r.run_type === "immediate").length,
      2
    );
    assert.equal(
      finalRuns.runs.filter((r) => r.run_type === "scheduled").length,
      2
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Pre-merge #1 & #2: Atomic DB mutex prevents concurrent retry + new batch/schedule double-activation, and 200-item scheduled dispatch warms up, retries transient 503s, and respects timeBudgetMs", async () => {
  const raceBundles = [
    makeDraftBundle("TMP-040001", 1, { is_test: true, product_name: "競合検証テスト商品1" }),
    makeDraftBundle("TMP-040002", 2, { is_test: true, product_name: "競合検証テスト商品2" }),
  ];
  const scaleIds1 = Array.from(
    { length: 200 },
    (_, i) => `TMP-${String(50001 + i).padStart(6, "0")}`
  );
  const scaleIds2 = Array.from(
    { length: 200 },
    (_, i) => `TMP-${String(50201 + i).padStart(6, "0")}`
  );
  const scaleBundles = [...scaleIds1, ...scaleIds2].map((pid, idx) =>
    makeDraftBundle(pid, idx + 10, { is_test: true, product_name: `予約負荷商品_${pid}` })
  );

  const mockSupabase = createBatchMockSupabase([...raceBundles, ...scaleBundles]);
  mockSupabase.state.staff_users = [
    { email: "staff@example.com", is_active: true, role: "admin" },
  ];

  // Barrier control to force true concurrency right after pre-RPC app checks pass
  let costBarrierMode = "off";
  let costBarrierArrived = 0;
  let releaseCostBarrier = null;
  let costBarrierPromise = null;

  let activeRelayCalls = 0;
  let maxRelayDuringWarmup = 0;
  let maxRelayOverall = 0;
  let warmupCompleted = false;
  const transient503Attempted = new Set();

  const mockFetch = async (url, init = {}) => {
    const urlStr = String(url);
    if (urlStr.includes("/auth/v1/settings") || urlStr.includes("/auth/v1/user")) {
      return new Response(
        JSON.stringify({ id: "staff-1", email: "staff@example.com", external: {} }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (urlStr.includes("/functions/v1/documents-relay")) {
      const body = JSON.parse(init.body || "{}");
      const pid = String(body.product_id || "");

      if (costBarrierMode === "pair" && pid === "TMP-040001") {
        costBarrierArrived += 1;
        if (costBarrierArrived >= 2 && releaseCostBarrier) {
          releaseCostBarrier();
        }
        await costBarrierPromise;
      }

      if (pid.startsWith("TMP-050")) {
        activeRelayCalls += 1;
        if (!warmupCompleted && pid === "TMP-050001") {
          maxRelayDuringWarmup = Math.max(maxRelayDuringWarmup, activeRelayCalls);
        }
        maxRelayOverall = Math.max(maxRelayOverall, activeRelayCalls);
        await new Promise((r) => setTimeout(r, 2));
        activeRelayCalls -= 1;
        if (pid === "TMP-050001") {
          warmupCompleted = true;
        }
        // Simulate 3 transient cold-start 503 responses (matching live measurement 197/200 first-try)
        if (
          (pid === "TMP-050001" || pid === "TMP-050055" || pid === "TMP-050199") &&
          !transient503Attempted.has(pid)
        ) {
          transient503Attempted.add(pid);
          return new Response("Edge Function cold start 503", { status: 503 });
        }
      }

      return new Response(
        JSON.stringify({
          success: true,
          product_id: pid,
          cost_breakdown: { total_allocated_cost: 10000, matched_lines_count: 1 },
          links: [{ link_type: "primary_cost", allocated_amount: 10000 }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (urlStr.includes("drive.google.com/uc")) {
      return new Response(TINY_JPEG_BYTES, {
        status: 200,
        headers: { "Content-Type": "image/jpeg" },
      });
    }
    if (urlStr.includes("generativelanguage.googleapis.com")) {
      const bodyObj = JSON.parse(init.body || "{}");
      const hasSearch = Array.isArray(bodyObj.tools) && bodyObj.tools.length > 0;
      const isPrior = bodyObj.generationConfig?.maxOutputTokens === 100;
      if (isPrior) {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: JSON.stringify({ category: "apparel", confidence: "high" }) }],
                },
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (hasSearch) {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                finishReason: "STOP",
                groundingMetadata: {
                  webSearchQueries: ["競合検証テスト"],
                  groundingChunks: [{ web: { uri: "https://example.com/item", title: "Ref" } }],
                },
                content: {
                  parts: [
                    {
                      text: "### 1. DIRECT PHYSICAL OBSERVATIONS\n- TAG: TEST\n### 2. EXTERNAL SEARCH CORROBORATIONS\n- MODEL: Test Jacket\n### 3. PRICING TRANSACTIONS\n- Sold: 16000 JPY",
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          candidates: [
            {
              finishReason: "STOP",
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      category: "apparel",
                      brand: "TestBrand",
                      title_ja: "競合検証ジャケット",
                      title_en: "Race Verification Jacket",
                      description_ja: "説明文",
                      description_en: "Description.",
                      condition: "目立った傷や汚れなし",
                      price: 16000,
                      price_basis: "market_comps",
                      price_note: "相場参考",
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 }
      );
    }
    if (urlStr.includes("script.google.com")) {
      return new Response(
        JSON.stringify({ success: true, confirmed_fingerprint: "FP_RACE" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    throw new Error(`Unexpected fetch URL: ${urlStr}`);
  };

  const handler = createProductsApiHandler({
    getSupabase: () => mockSupabase,
    fetchImpl: mockFetch,
    gasWebAppUrl: "https://script.google.com/macros/s/test/exec",
    internalSecret: "test-internal-secret",
    readdyBackendUrl: "https://readdy.example.supabase.co",
    readdyBackendAnonKey: "readdy-server-anon-jwt-test",
    geminiApiKey: "test-gemini-key",
    enableAutoBatchWorker: false,
  });

  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const staffHeaders = {
    Authorization: "Bearer valid-staff-jwt",
    apikey: "readdy-anon-key",
    "Content-Type": "application/json",
  };
  const internalHeaders = {
    "X-Internal-Sync-Token": "test-internal-secret",
    "Content-Type": "application/json",
  };

  try {
    // --- PART 1A: Concurrent Retry vs New Immediate Batch on same failed product ---
    // Seed BATCH_RACE_1 with TMP-040001 = failed, TMP-040002 = completed
    const nowIso = new Date().toISOString();
    mockSupabase.state.ai_batch_jobs.push({
      batch_id: "BATCH_RACE_1",
      request_id: "REQ_RACE_SEED_1",
      job_source: "manual",
      status: "partially_failed",
      total_count: 2,
      completed_count: 1,
      failed_count: 1,
      processing_count: 0,
      force_regenerate: false,
      test_only: true,
      model_name: "gemini-3-flash-preview",
      min_cost_markup_rate: 0.3,
      product_costs_json: {},
      selected_image_ids_by_product: {},
      retry_requests: {},
      created_at: nowIso,
      updated_at: nowIso,
      completed_at: nowIso,
    });
    mockSupabase.state.ai_batch_items.push(
      {
        id: 801,
        batch_id: "BATCH_RACE_1",
        item_index: 0,
        product_id: "TMP-040001",
        status: "failed",
        selected_image_ids: [],
        source_image_ids: [],
        draft_id: null,
        draft_version: null,
        model_name: null,
        proposed_price: null,
        price_basis: null,
        price_note: null,
        error_code: "LLM_COMMUNICATION_FAILED",
        error_message: "temporary failure",
        retry_count: 3,
        next_retry_at: null,
        worker_execution_id: null,
        lease_expires_at: null,
        created_at: nowIso,
        updated_at: nowIso,
      },
      {
        id: 802,
        batch_id: "BATCH_RACE_1",
        item_index: 1,
        product_id: "TMP-040002",
        status: "completed",
        selected_image_ids: [],
        source_image_ids: ["FILE_TMP-040002_1"],
        draft_id: "DRAFT_DONE_802",
        draft_version: 1,
        model_name: "gemini-3-flash-preview",
        proposed_price: 16000,
        price_basis: "market_comps",
        price_note: "相場参考",
        error_code: null,
        error_message: null,
        retry_count: 0,
        next_retry_at: null,
        worker_execution_id: null,
        lease_expires_at: null,
        created_at: nowIso,
        updated_at: nowIso,
      }
    );

    // Enable barrier so BOTH retry and createBatch pass pre-RPC findActiveAiBatchProductConflicts
    // simultaneously before either RPC executes!
    costBarrierMode = "pair";
    costBarrierArrived = 0;
    costBarrierPromise = new Promise((resolve) => {
      releaseCostBarrier = resolve;
    });

    const [retryRaceRes, newImmRaceRes] = await Promise.all([
      fetch(`${baseUrl}/ai-batches/BATCH_RACE_1/retry`, {
        method: "POST",
        headers: staffHeaders,
        body: JSON.stringify({ request_id: "REQ_RETRY_RACE_1" }),
      }),
      fetch(`${baseUrl}/ai-batches`, {
        method: "POST",
        headers: staffHeaders,
        body: JSON.stringify({
          request_id: "REQ_NEW_IMM_RACE_1",
          product_ids: ["TMP-040001"],
          test_only: true,
        }),
      }),
    ]);
    costBarrierMode = "off";

    const retryRaceBody = await retryRaceRes.json();
    const newImmRaceBody = await newImmRaceRes.json();
    const statuses1 = [retryRaceRes.status, newImmRaceRes.status].sort((a, b) => a - b);
    assert.deepEqual(
      statuses1,
      [200, 409],
      `Expected exactly one 200 and one 409, got retry=${retryRaceRes.status} (${JSON.stringify(retryRaceBody)}) vs new=${newImmRaceRes.status} (${JSON.stringify(newImmRaceBody)})`
    );

    const loserBody1 = retryRaceRes.status === 409 ? retryRaceBody : newImmRaceBody;
    assert.equal(loserBody1.error_code, "PRODUCT_ALREADY_IN_ACTIVE_AI_BATCH");
    assert.deepEqual(loserBody1.conflicting_product_ids, ["TMP-040001"]);

    // Verify TMP-040001 is active (`pending` or `processing`) in AT MOST 1 batch!
    const activeItemsAfterRace1 = mockSupabase.state.ai_batch_items.filter(
      (i) =>
        i.product_id === "TMP-040001" &&
        (i.status === "pending" || i.status === "processing")
    );
    assert.equal(activeItemsAfterRace1.length, 1);
    // Completed sibling TMP-040002 remains untouched
    const completedSibling = mockSupabase.state.ai_batch_items.find(
      (i) => i.id === 802
    );
    assert.equal(completedSibling.status, "completed");

    // If retry won, verify idempotent replay of same request_id returns 200 is_reused: true even while pending!
    if (retryRaceRes.status === 200) {
      const replayRetryRes = await fetch(`${baseUrl}/ai-batches/BATCH_RACE_1/retry`, {
        method: "POST",
        headers: staffHeaders,
        body: JSON.stringify({ request_id: "REQ_RETRY_RACE_1" }),
      });
      assert.equal(replayRetryRes.status, 200);
      const replayRetryBody = await replayRetryRes.json();
      assert.equal(replayRetryBody.is_reused, true);
      assert.equal(replayRetryBody.retried_count, 1);
    }

    // Complete the winning active job via worker
    await fetch(`${baseUrl}/ai-batches/worker/run`, {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify({ max_items: 5 }),
    });

    // --- PART 1B: Retry rejected by DB RPC when concurrent Schedule becomes active during retry's cost lookup ---
    // Seed BATCH_RACE_2 where TMP-040001 failed, and while retry is fetching cost, create a schedule for TMP-040001!
    mockSupabase.state.ai_batch_jobs.push({
      batch_id: "BATCH_RACE_2",
      request_id: "REQ_RACE_SEED_2",
      job_source: "manual",
      status: "failed",
      total_count: 1,
      completed_count: 0,
      failed_count: 1,
      processing_count: 0,
      force_regenerate: true,
      test_only: true,
      model_name: "gemini-3-flash-preview",
      min_cost_markup_rate: 0.3,
      product_costs_json: {},
      selected_image_ids_by_product: {},
      retry_requests: {},
      created_at: nowIso,
      updated_at: nowIso,
      completed_at: nowIso,
    });
    mockSupabase.state.ai_batch_items.push({
      id: 803,
      batch_id: "BATCH_RACE_2",
      item_index: 0,
      product_id: "TMP-040001",
      status: "failed",
      selected_image_ids: [],
      source_image_ids: [],
      draft_id: null,
      draft_version: null,
      model_name: null,
      proposed_price: null,
      price_basis: null,
      price_note: null,
      error_code: "LLM_COMMUNICATION_FAILED",
      error_message: "temporary failure",
      retry_count: 3,
      next_retry_at: null,
      worker_execution_id: null,
      lease_expires_at: null,
      created_at: nowIso,
      updated_at: nowIso,
    });

    costBarrierMode = "pair";
    costBarrierArrived = 0;
    let enteredRetryCost = null;
    const retryEnteredPromise = new Promise((r) => {
      enteredRetryCost = r;
    });
    // Pause retry inside documents-relay, create schedule so schedule commits FIRST, then release retry so retry hits DB RPC guard!
    costBarrierPromise = new Promise((resolve) => {
      releaseCostBarrier = resolve;
    });
    const origCheck = costBarrierMode;
    assert.equal(origCheck, "pair");

    const retryWhileSchedPromise = (async () => {
      // Trigger retry; when mockFetch sees TMP-040001, costBarrierArrived becomes 1
      return fetch(`${baseUrl}/ai-batches/BATCH_RACE_2/retry`, {
        method: "POST",
        headers: staffHeaders,
        body: JSON.stringify({ request_id: "REQ_RETRY_VS_SCHED_2" }),
      });
    })();

    // Wait until retry has passed pre-RPC findActiveAiBatchProductConflicts and is inside documents-relay
    while (costBarrierArrived < 1) {
      await new Promise((r) => setTimeout(r, 2));
    }
    enteredRetryCost();
    await retryEnteredPromise;

    const schedDuringRetryRes = await fetch(`${baseUrl}/ai-batch-schedules`, {
      method: "POST",
      headers: staffHeaders,
      body: JSON.stringify({
        request_id: "REQ_SCHED_DURING_RETRY_2",
        scheduled_at: new Date(Date.now() + 3600_000).toISOString(),
        product_ids: ["TMP-040001"],
        test_only: true,
        force_regenerate: true,
      }),
    });
    assert.equal(schedDuringRetryRes.status, 200);
    const schedDuringRetry = await schedDuringRetryRes.json();

    // Now release retry so it calls `retry_ai_batch_failed_items_atomic` -> MUST fail with 409!
    costBarrierMode = "off";
    releaseCostBarrier();

    const retryLostRes = await retryWhileSchedPromise;
    assert.equal(retryLostRes.status, 409);
    const retryLostBody = await retryLostRes.json();
    assert.equal(retryLostBody.error_code, "PRODUCT_ALREADY_IN_ACTIVE_AI_BATCH");
    assert.deepEqual(retryLostBody.conflicting_product_ids, ["TMP-040001"]);
    // Verify item 803 remained `failed` (did NOT become `pending`)!
    assert.equal(
      mockSupabase.state.ai_batch_items.find((i) => i.id === 803).status,
      "failed"
    );

    // Cancel that schedule -> now retry succeeds AND intentional regeneration after completion remains intact!
    await fetch(`${baseUrl}/ai-batch-schedules/${schedDuringRetry.schedule_id}/cancel`, {
      method: "POST",
      headers: staffHeaders,
      body: JSON.stringify({ test_only: true }),
    });
    const retryAfterCancelRes = await fetch(`${baseUrl}/ai-batches/BATCH_RACE_2/retry`, {
      method: "POST",
      headers: staffHeaders,
      body: JSON.stringify({ request_id: "REQ_RETRY_AFTER_CANCEL_2" }),
    });
    assert.equal(retryAfterCancelRes.status, 200);
    const retryAfterCancelBody = await retryAfterCancelRes.json();
    assert.equal(retryAfterCancelBody.success, true);
    assert.equal(retryAfterCancelBody.retried_count, 1);

    // Replay same request_id while pending -> 200 is_reused: true
    const retryReplay2Res = await fetch(`${baseUrl}/ai-batches/BATCH_RACE_2/retry`, {
      method: "POST",
      headers: staffHeaders,
      body: JSON.stringify({ request_id: "REQ_RETRY_AFTER_CANCEL_2" }),
    });
    assert.equal(retryReplay2Res.status, 200);
    assert.equal((await retryReplay2Res.json()).is_reused, true);

    await fetch(`${baseUrl}/ai-batches/worker/run`, {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify({ max_items: 5 }),
    });

    // --- PART 2: 200-Item Scheduled Dispatch Startup Time, Warmup, Transient 503 Retry & Time Budget ---
    const dueBaseMs = Date.now() + 120_000;
    const dueIso = new Date(dueBaseMs).toISOString();

    const s200Res1 = await fetch(`${baseUrl}/ai-batch-schedules`, {
      method: "POST",
      headers: staffHeaders,
      body: JSON.stringify({
        request_id: "REQ_SCHED_200_A",
        scheduled_at: dueIso,
        product_ids: scaleIds1,
        test_only: true,
      }),
    });
    assert.equal(s200Res1.status, 200);
    const sched200A = await s200Res1.json();
    assert.equal(sched200A.total_reserved_count, 200);

    const s200Res2 = await fetch(`${baseUrl}/ai-batch-schedules`, {
      method: "POST",
      headers: staffHeaders,
      body: JSON.stringify({
        request_id: "REQ_SCHED_200_B",
        scheduled_at: dueIso,
        product_ids: scaleIds2,
        test_only: true,
      }),
    });
    assert.equal(s200Res2.status, 200);
    const sched200B = await s200Res2.json();
    assert.equal(sched200B.total_reserved_count, 200);

    // Dispatch with timeBudgetMs = 1ms so after claiming & starting schedule #1 (200 items),
    // schedule #2 is deferred to the next minute tick instead of stacking beyond Cloud Scheduler's 180s deadline!
    const dispatchStartMs = Date.now();
    const disp200Tick1 = await dispatchDueAiBatchSchedules({
      supabase: mockSupabase,
      fetchImpl: mockFetch,
      gasWebAppUrl: "https://script.google.com/macros/s/test/exec",
      readdyBackendUrl: "https://readdy.example.supabase.co",
      readdyBackendAnonKey: "readdy-server-anon-jwt-test",
      now: new Date(dueBaseMs + 5_000),
      maxSchedules: 5,
      timeBudgetMs: 1,
      triggerWorker: async () => ({ triggered: true }),
    });
    const dispatchElapsedMs = Date.now() - dispatchStartMs;

    assert.equal(disp200Tick1.status, 200);
    assert.equal(disp200Tick1.body.claimed_count, 1);
    assert.equal(disp200Tick1.body.results.length, 1);
    assert.equal(disp200Tick1.body.results[0].schedule_id, sched200A.schedule_id);
    assert.equal(disp200Tick1.body.results[0].outcome, "started");
    assert.equal(disp200Tick1.body.results[0].eligible_count, 200);
    // Warmup ran single-flight (`maxRelayDuringWarmup === 1`) before fanning out up to concurrency 12
    assert.equal(maxRelayDuringWarmup, 1);
    assert.ok(maxRelayOverall <= 12, `Expected max concurrency <= 12, got ${maxRelayOverall}`);
    // All 3 simulated transient 503 items recovered via retry!
    assert.equal(transient503Attempted.size, 3);
    assert.ok(dispatchElapsedMs < 15_000, `Expected fast 200-item dispatch, got ${dispatchElapsedMs}ms`);

    // Schedule #2 remained `scheduled` (not claimed or timed out) and starts cleanly on next tick!
    const sched2RowAfterTick1 = mockSupabase.state.ai_batch_schedules.find(
      (s) => s.schedule_id === sched200B.schedule_id
    );
    assert.equal(sched2RowAfterTick1.status, "scheduled");

    const disp200Tick2 = await dispatchDueAiBatchSchedules({
      supabase: mockSupabase,
      fetchImpl: mockFetch,
      gasWebAppUrl: "https://script.google.com/macros/s/test/exec",
      readdyBackendUrl: "https://readdy.example.supabase.co",
      readdyBackendAnonKey: "readdy-server-anon-jwt-test",
      now: new Date(dueBaseMs + 65_000),
      maxSchedules: 5,
      triggerWorker: async () => ({ triggered: true }),
    });
    assert.equal(disp200Tick2.body.claimed_count, 1);
    assert.equal(disp200Tick2.body.results[0].schedule_id, sched200B.schedule_id);
    assert.equal(disp200Tick2.body.results[0].outcome, "started");
    assert.equal(disp200Tick2.body.results[0].eligible_count, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("AI Batch Revised Requirements (Acceptance Criteria 1-7): 88-item 1-timeout resilience, total cost outage, no-cost Pokemon card, price-null draft save, authenticity stripping, apparel/shoe condition & staff preservation", async () => {
  const initialBundles = [];
  const ids88 = [];

  // Create 88 reserved test products:
  // - TMP-088001: sneaker with confirmed cost (10,000 JPY), LLM outputs authenticity guarantee + "クリーニング済み" + "やや傷や汚れあり" with minor wear only
  // - TMP-088002: sneaker where cost lookup times out (1 item timeout out of 88!)
  // - TMP-088003: Pokemon card [PSA10] with NO purchase cost (pack-pulled: total_allocated_cost = 0, links = [])
  // - TMP-088004: unidentified apparel where no price proposal can be formed (price: null)
  // - TMP-088005: apparel with obvious stain/damage -> should reflect "やや傷や汚れあり"
  // - TMP-088006: apparel where staff already entered condition = "やや傷や汚れあり" -> AI must NOT overwrite staff condition!
  // - TMP-088007..TMP-088088: 82 additional test products
  for (let i = 1; i <= 88; i++) {
    const pid = `TMP-088${String(i).padStart(3, "0")}`;
    ids88.push(pid);
    const isPoke = i === 3;
    const isApparel = i === 4 || i === 5 || i === 6;
    const bundle = makeDraftBundle(pid, 88000 + i, {
      category: isPoke ? "pokemon_card" : isApparel ? "apparel" : "sneaker",
      condition: i === 6 ? "やや傷や汚れあり" : "",
      planned_sale_price: null,
      ai_draft_flag: "",
    });
    bundle.productRow.is_test = true;
    initialBundles.push(bundle);
  }

  // Additional test products for total cost outage across immediate & retry
  for (const [idx, extraPid] of ["TMP-089001", "TMP-089002"].entries()) {
    const b = makeDraftBundle(extraPid, 89001 + idx, {
      category: "sneaker",
      condition: "",
      planned_sale_price: null,
    });
    b.productRow.is_test = true;
    initialBundles.push(b);
  }

  const mockSupabase = createBatchMockSupabase(initialBundles);
  let totalCostOutage = false;
  let costCallCountDuringOutage = 0;
  let failLlmFor089002 = true;

  const mockFetch = async (url, init = {}) => {
    const urlStr = String(url);
    if (
      urlStr.includes("/auth/v1/settings") ||
      urlStr.includes("/auth/v1/user")
    ) {
      return new Response(
        JSON.stringify({ id: "staff-uid-88", email: "staff88@example.com", external: {} }),
        { status: 200 }
      );
    }
    if (urlStr.endsWith("/functions/v1/documents-relay")) {
      const body = JSON.parse(String(init.body || "{}"));
      const pid = body.product_id;
      if (totalCostOutage) {
        costCallCountDuringOutage += 1;
        return new Response("Service Unavailable", { status: 503 });
      }
      // Criterion 1: 1 item (TMP-088002) times out / aborts during cost lookup!
      if (pid === "TMP-088002") {
        const timeoutErr = new Error("The operation was aborted");
        timeoutErr.name = "AbortError";
        throw timeoutErr;
      }
      // Criterion 3: Pokemon card (TMP-088003) has no purchase cost (pack-pulled)
      if (pid === "TMP-088003" || pid === "TMP-088004") {
        return new Response(
          JSON.stringify({
            success: true,
            product_id: pid,
            cost_breakdown: { total_allocated_cost: 0, matched_lines_count: 0 },
            links: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (pid === "TMP-088001") {
        // Confirmed cost: item 10,000 + buyer fee 1,500 = 11,500 JPY (tax included) -> floor 11,500 / (1 - 0.30) = 16,500 JPY
        return new Response(
          JSON.stringify({
            success: true,
            product_id: pid,
            cost_breakdown: { total_allocated_cost: 11500, matched_lines_count: 1 },
            links: [
              {
                allocated_amount: 11500,
                status: "confirmed",
                line: {
                  item_amount: 10000,
                  fee_amount: 1500,
                  tax_included_flag: true,
                  total_line_amount: 11500,
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          success: true,
          product_id: pid,
          cost_breakdown: { total_allocated_cost: 10000, matched_lines_count: 1 },
          links: [
            {
              allocated_amount: 10000,
              status: "confirmed",
              line: {
                item_amount: 9000,
                fee_amount: 0,
                tax_amount: 1000,
                fee_tax_amount: 0,
                total_line_amount: 10000,
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (
      urlStr.startsWith("https://img.example/") ||
      urlStr.startsWith("https://drive.google.com/uc?export=download")
    ) {
      return new Response(
        Buffer.concat([TINY_JPEG_BYTES, Buffer.from(urlStr, "utf8")]),
        {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        }
      );
    }
    if (urlStr.includes("generativelanguage.googleapis.com")) {
      const bodyStr = String(init.body || "{}");
      const bodyObj = JSON.parse(bodyStr);
      const isStageA = Boolean(bodyObj.tools);
      const inlineB64 =
        bodyObj.contents?.[0]?.parts?.find((p) => p.inlineData?.data)?.inlineData
          ?.data || "";
      const decodedBytes = inlineB64
        ? Buffer.from(inlineB64, "base64").toString("utf8")
        : "";
      const pidMatch =
        decodedBytes.match(/TMP-08[89]\d{3}/) ||
        bodyStr.match(/TMP-08[89]\d{3}/);
      const pid = pidMatch ? pidMatch[0] : "TMP-088001";

      if (pid === "TMP-089002" && failLlmFor089002 && !isStageA) {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                finishReason: "STOP",
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        title_ja: "",
                        description_ja: "エラー",
                      }),
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 }
        );
      }

      if (isStageA) {
        if (pid === "TMP-088004") {
          return new Response(
            JSON.stringify({
              candidates: [
                {
                  finishReason: "STOP",
                  groundingMetadata: {
                    webSearchQueries: ["vintage hoodie"],
                    groundingChunks: [
                      {
                        web: {
                          uri: "https://jp.mercari.com/search?keyword=hoodie",
                          title: "Search",
                        },
                      },
                    ],
                  },
                  content: {
                    parts: [
                      {
                        text: `### 1. DIRECT PHYSICAL OBSERVATIONS\n- Item: ${pid}\n- Unbranded Hoodie\n### 2. EXTERNAL SEARCH CORROBORATIONS\n- Unknown\n### 3. PRICING TRANSACTIONS\n- None`,
                      },
                    ],
                  },
                },
              ],
            }),
            { status: 200 }
          );
        }
        return new Response(
          JSON.stringify({
            candidates: [
              {
                finishReason: "STOP",
                groundingMetadata: {
                  webSearchQueries: [`${pid} market`],
                  groundingChunks: [
                    { web: { uri: "https://snkrdunk.com/items/123", title: "Item" } },
                  ],
                },
                content: {
                  parts: [
                    {
                      text: `### 1. DIRECT PHYSICAL OBSERVATIONS\n- Item: ${pid}\n- SKU: DD1391-100\n### 2. EXTERNAL SEARCH CORROBORATIONS\n- Corroborated\n### 3. PRICING TRANSACTIONS\n- Sold: 18,000円`,
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 }
        );
      }

      // Stage B structured output per product scenario
      if (pid === "TMP-088001") {
        // Official product name "Vans Authentic 44 DX" + authenticity guarantee claims + "クリーニング済み" + market price 14,000 below floor 16,500
        return new Response(
          JSON.stringify({
            candidates: [
              {
                finishReason: "STOP",
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        title_ja: "Vans Authentic 44 DX アナハイムファクトリー 確実正規品",
                        title_en: "100% Authentic Vans Authentic 44 DX Anaheim Factory",
                        description_ja:
                          "Vans Authentic 44 DX です。当店ではプロの鑑定士による真贋鑑定済みの本物保証いたします。出品前にクリーニング済みです。着用に伴う若干の使用感はありますが、目立つ傷や汚れはなく全体的に状態良好です。",
                        description_en:
                          "Vans Authentic 44 DX in classic canvas. Guaranteed 100% authentic and genuine pair. Professionally cleaned before listing. Pre-owned in good condition with minor wear.",
                        hashtags_ja: "#Vans #VansAuthentic #正規品 #本物保証 #クリーニング済み",
                        condition: "やや傷や汚れあり",
                        category: "sneaker",
                        brand: "VANS",
                        sku: "VN0A38ENMR2",
                        size: "27.0cm",
                        price: 14000,
                        price_basis: "recent_sold_provisional",
                        price_note: "成約参考 14,000円",
                      }),
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 }
        );
      }

      if (pid === "TMP-088003") {
        // Pokemon card [PSA10] with no purchase cost + authenticity phrase
        return new Response(
          JSON.stringify({
            candidates: [
              {
                finishReason: "STOP",
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        title_ja: "[PSA10] ナンジャモ SAR [SV2D 096/071] クレイバースト 本物保証",
                        title_en: "[PSA10] Genuine Pokemon Card Iono SAR SV2D 096/071",
                        description_ja:
                          "PSA10鑑定品です。確実正規品・本物保証いたします。ケースも良好な状態です。",
                        description_en:
                          "Graded PSA10. 100% original guaranteed authentic card.",
                        hashtags_ja: "#ポケカ #PSA10 #本物保証",
                        condition: "目立った傷や汚れなし",
                        category: "pokemon_card",
                        brand: "Pokemon Card Game",
                        price: 45000,
                        price_basis: "recent_sold_provisional",
                        price_note: "成約参考 45,000円",
                        pokemon_card: {
                          card_name: "ナンジャモ",
                          set_code: "SV2D",
                          set_name: "クレイバースト",
                          card_number: "096/071",
                          rarity: "SAR",
                          language: "Japanese",
                          grading_status: "graded",
                          grader: "PSA",
                          grade: "10",
                          certification_number: "87654321",
                          card_condition: "",
                        },
                      }),
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 }
        );
      }

      if (pid === "TMP-088004") {
        // Unidentified apparel where no price proposal can be formed (price: null), LLM outputs "新品・未使用" without basis
        return new Response(
          JSON.stringify({
            candidates: [
              {
                finishReason: "STOP",
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        title_ja: "スウェット パーカー グレー フーディー",
                        title_en: "Gray Sweatshirt Hoodie",
                        description_ja: "シンプルなグレーのパーカーです。目立つ傷や汚れはありません。",
                        description_en: "Simple gray hoodie in good pre-owned condition.",
                        hashtags_ja: "#パーカー #古着",
                        condition: "新品・未使用",
                        category: "apparel",
                        brand: "不明",
                        sku: "",
                        size: "L",
                        price: null,
                        price_basis: "no_evidence",
                        price_note: "相場不明",
                      }),
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 }
        );
      }

      if (pid === "TMP-088005") {
        // Apparel with obvious stain/damage -> must reflect "やや傷や汚れあり" even if LLM said "目立った傷や汚れなし"
        return new Response(
          JSON.stringify({
            candidates: [
              {
                finishReason: "STOP",
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        title_ja: "ステューシー ロゴ Tシャツ ホワイト",
                        title_en: "Stussy Logo T-Shirt White",
                        description_ja: "フロントに目立つシミと小さな破れがあります。",
                        description_en: "Has a prominent stain on the front.",
                        hashtags_ja: "#STUSSY",
                        condition: "目立った傷や汚れなし",
                        category: "apparel",
                        brand: "STUSSY",
                        sku: "",
                        size: "M",
                        price: 15000,
                        price_basis: "recent_sold_provisional",
                        price_note: "参考 15,000円",
                      }),
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 }
        );
      }

      return new Response(
        JSON.stringify({
          candidates: [
            {
              finishReason: "STOP",
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      title_ja: `ナイキ ダンク ロー (${pid})`,
                      title_en: `Nike Dunk Low (${pid})`,
                      description_ja: "状態良好なスニーカーです。",
                      description_en: "Good condition sneaker.",
                      hashtags_ja: "#NIKE",
                      condition: "目立った傷や汚れなし",
                      category: "sneaker",
                      brand: "NIKE",
                      sku: "DD1391-100",
                      size: "27.0cm",
                      price: 18000,
                      price_basis: "recent_sold_provisional",
                      price_note: "成約参考 18,000円",
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 }
      );
    }
    if (urlStr.startsWith("https://gas.example/exec")) {
      return new Response(
        JSON.stringify({ success: true, confirmed_fingerprint: "FP_OK" }),
        { status: 200 }
      );
    }
    throw new Error(`Unexpected URL: ${urlStr}`);
  };

  const handler = createProductsApiHandler({
    getSupabase: () => mockSupabase,
    fetchImpl: mockFetch,
    gasWebAppUrl: "https://gas.example/exec",
    internalSecret: "test-internal-secret",
    readdyBackendUrl: "https://readdy.example.supabase.co",
    readdyBackendAnonKey: "readdy-server-anon-jwt-test",
    geminiApiKey: "test-gemini-key",
    aiBatchConcurrency: 4,
    enableAutoBatchWorker: false,
  });

  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const staffHeaders = {
    "Content-Type": "application/json",
    Authorization: "Bearer valid-staff-jwt",
    apikey: "readdy-anon-key",
  };
  const internalHeaders = {
    "Content-Type": "application/json",
    "X-Internal-Sync-Token": "test-internal-secret",
  };

  try {
    // --- Acceptance Criterion 1: 88-item scheduled reservation where 1 item (TMP-088002) times out during cost lookup ---
    const schedAtMs = Date.now() + 60_000;
    const create88Res = await fetch(`${baseUrl}/ai-batch-schedules`, {
      method: "POST",
      headers: staffHeaders,
      body: JSON.stringify({
        request_id: "REQ_SCHED_88_1TIMEOUT",
        scheduled_at: new Date(schedAtMs).toISOString(),
        product_ids: ids88,
        test_only: true,
      }),
    });
    assert.equal(create88Res.status, 200);
    const sched88 = await create88Res.json();
    assert.equal(sched88.total_reserved_count, 88);

    const disp88 = await dispatchDueAiBatchSchedules({
      supabase: mockSupabase,
      fetchImpl: mockFetch,
      gasWebAppUrl: "https://gas.example/exec",
      readdyBackendUrl: "https://readdy.example.supabase.co",
      readdyBackendAnonKey: "readdy-server-anon-jwt-test",
      now: new Date(schedAtMs + 1000),
      triggerWorker: async () => ({ triggered: true }),
    });
    assert.equal(disp88.status, 200);
    assert.equal(disp88.body.claimed_count, 1);
    const disp88Res = disp88.body.results[0];
    // All 88 items MUST start (including the timed-out TMP-088002)!
    assert.equal(disp88Res.outcome, "started");
    assert.equal(disp88Res.eligible_count, 88);
    assert.equal(disp88Res.excluded_count, 0);
    assert.equal(disp88Res.cost_fetch_failed_count, 1);
    assert.deepEqual(disp88Res.cost_fetch_failed_product_ids, ["TMP-088002"]);

    // Verify schedule detail & batch progress expose cost_fetch_failed_product_ids for later inspection
    const sched88Detail = await (
      await fetch(`${baseUrl}/ai-batch-schedules/${sched88.schedule_id}`, {
        headers: staffHeaders,
      })
    ).json();
    assert.equal(sched88Detail.cost_fetch_failed_count, 1);
    assert.deepEqual(sched88Detail.cost_fetch_failed_product_ids, ["TMP-088002"]);

    // Run worker for the first 6 items (TMP-088001 .. TMP-088006)
    const workerPass = await (
      await fetch(`${baseUrl}/ai-batches/worker/run`, {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({ max_items: 6 }),
      })
    ).json();
    assert.equal(workerPass.processed_count, 6);
    assert.equal(workerPass.completed_count, 6);
    assert.equal(workerPass.failed_count, 0);

    // Criterion 1 & 2 verification on TMP-088002 (timed-out cost lookup item):
    // Generated with market price 18,000, NO fictitious 0-yen cost, cost_status = "lookup_failed"
    const p88002 = mockSupabase.state.products.get("TMP-088002");
    assert.equal(p88002.product_name, "ナイキ ダンク ロー (TMP-088002)");
    assert.equal(p88002.planned_sale_price, 18000);
    assert.equal(p88002.publish_status, "draft");
    const item88002 = mockSupabase.state.ai_batch_items.find(
      (i) => i.batch_id === disp88Res.batch_id && i.product_id === "TMP-088002"
    );
    assert.equal(item88002.status, "completed");
    assert.match(item88002.price_note, /原価未取得/);

    // Criterion 5 & 6 + Gross Margin Floor (11,500 / (1 - 0.30) -> 16,500) verification on TMP-088001:
    // - Official product name "Vans Authentic 44 DX" is preserved (never turned into "Vans 44 DX")
    // - Guarantee claims ("確実正規品", "100% Authentic", "本物保証", "真贋鑑定済み") and "クリーニング済み" are stripped
    // - Condition normalized from "やや傷や汚れあり" (minor wear) -> "目立った傷や汚れなし"
    // - Confirmed cost 11,500 JPY (item 10,000 + fee 1,500) yields floor 16,500 JPY (> market 14,000 JPY)
    const p88001 = mockSupabase.state.products.get("TMP-088001");
    assert.equal(p88001.product_name, "Vans Authentic 44 DX アナハイムファクトリー");
    assert.equal(p88001.translated_title, "Vans Authentic 44 DX Anaheim Factory");
    assert.doesNotMatch(p88001.product_name, /確実正規品/);
    assert.doesNotMatch(p88001.translated_title, /100%\s*Authentic/i);
    assert.doesNotMatch(p88001.description, /本物保証|真贋|クリーニング済み|#正規品|#本物保証/);
    assert.match(p88001.description, /Vans Authentic 44 DX/);
    assert.match(p88001.description, /状態良好/);
    assert.equal(p88001.condition, "目立った傷や汚れなし");
    assert.equal(p88001.planned_sale_price, 16500);
    const draft88001 = mockSupabase.state.product_ai_drafts.find(
      (d) => d.product_id === "TMP-088001"
    );
    assert.equal(draft88001.candidate_price, 16500);
    assert.equal(draft88001.candidate_price_basis, "gross_margin_floor");
    assert.match(draft88001.candidate_price_note, /最低粗利率30%/);
    assert.doesNotMatch(draft88001.candidate_price_note, /上乗せ|×1\.3/);

    // Also verify staff confirmation (`POST /products/TMP-088001/ai-draft/confirm`) preserves "Vans Authentic 44 DX" while stripping any guarantee claims
    const staffConfirmRes = await fetch(
      `${baseUrl}/products/TMP-088001/ai-draft/confirm`,
      {
        method: "POST",
        headers: staffHeaders,
        body: JSON.stringify({
          draft_id: draft88001.draft_id,
          draft_version: draft88001.draft_version,
          confirmation_attempt_id: "att-vans-authentic-44-dx",
          confirmed_data: {
            product_name: "Vans Authentic 44 DX アナハイム 本物保証",
            translated_title: "Vans Authentic 44 DX Anaheim Guaranteed Authentic",
            description: "Vans Authentic 44 DX の定番モデルです。真贋鑑定済みの本物保証いたします。",
            translated_description: "Classic Vans Authentic 44 DX model. Authenticity guaranteed.",
            hashtags_ja: "#Vans #VansAuthentic #本物保証",
            planned_sale_price: 16500,
            condition: "目立った傷や汚れなし",
            category: "sneaker",
            brand: "VANS",
            sneaker_sku: "VN0A38ENMR2",
            sneaker_size: "27.0cm",
          },
        }),
      }
    );
    const staffConfirmJson = await staffConfirmRes.json();
    assert.equal(staffConfirmJson.success, true);
    const p88001AfterStaffConfirm = mockSupabase.state.products.get("TMP-088001");
    assert.equal(p88001AfterStaffConfirm.product_name, "Vans Authentic 44 DX アナハイム");
    assert.equal(p88001AfterStaffConfirm.translated_title, "Vans Authentic 44 DX Anaheim");
    assert.match(p88001AfterStaffConfirm.description, /Vans Authentic 44 DX/);
    assert.doesNotMatch(p88001AfterStaffConfirm.description, /本物保証|真贋鑑定/);

    // Criterion 3 & 5 verification on TMP-088003 (Pokemon card [PSA10] with no purchase cost):
    // Generated with market price 45,000, [PSA10] preserved, "本物保証"/"確実正規品" stripped, cost_status = "no_cost", reference_allocated_total = null (NOT 0!)
    const p88003 = mockSupabase.state.products.get("TMP-088003");
    assert.match(p88003.product_name, /^\[PSA10\] ナンジャモ/);
    assert.doesNotMatch(p88003.product_name, /本物保証/);
    assert.doesNotMatch(p88003.description, /本物保証|確実正規品/);
    assert.match(p88003.description, /PSA10鑑定品/);
    assert.equal(p88003.planned_sale_price, 45000);
    const job88 = mockSupabase.state.ai_batch_jobs.find(
      (j) => j.batch_id === disp88Res.batch_id
    );
    assert.equal(job88.product_costs_json["TMP-088003"], null);
    const draft88003 = mockSupabase.state.product_ai_drafts.find(
      (d) => d.product_id === "TMP-088003"
    );
    assert.equal(draft88003.candidate_json.cost_calculation.cost_status, "no_cost");
    assert.equal(
      draft88003.candidate_json.cost_calculation.reference_allocated_total,
      null
    );
    assert.equal(
      draft88003.candidate_json.cost_calculation.effective_cost_amount,
      null
    );

    // Criterion 4 & 6 verification on TMP-088004 (unidentified apparel with price: null):
    // Draft title, description, translations, and normalized condition ("目立った傷や汚れなし", not "新品・未使用") are saved even though planned_sale_price is null!
    const p88004 = mockSupabase.state.products.get("TMP-088004");
    assert.equal(p88004.product_name, "スウェット パーカー グレー フーディー");
    assert.ok(
      p88004.planned_sale_price === null || p88004.planned_sale_price === 0,
      `Expected unset planned_sale_price (null or 0), got ${p88004.planned_sale_price}`
    );
    assert.equal(p88004.condition, "目立った傷や汚れなし");
    assert.equal(p88004.publish_status, "draft");
    const item88004 = mockSupabase.state.ai_batch_items.find(
      (i) => i.batch_id === disp88Res.batch_id && i.product_id === "TMP-088004"
    );
    assert.equal(item88004.status, "completed");
    assert.equal(item88004.proposed_price, null);

    // Criterion 6 verification on TMP-088005 (obvious stain/damage reflected) & TMP-088006 (staff-entered condition preserved):
    const p88005 = mockSupabase.state.products.get("TMP-088005");
    assert.equal(p88005.condition, "やや傷や汚れあり");
    const p88006 = mockSupabase.state.products.get("TMP-088006");
    assert.equal(p88006.condition, "やや傷や汚れあり");

    // Criterion 7 verification: no auto-publish or Square linking
    for (let i = 1; i <= 6; i++) {
      const pid = `TMP-088${String(i).padStart(3, "0")}`;
      const p = mockSupabase.state.products.get(pid);
      assert.equal(p.publish_status, "draft");
      assert.equal(p.square_item_id || "", "");
    }

    // --- Acceptance Criterion 2: Complete cost endpoint outage across Immediate Batch & Failed-Item Retry ---
    totalCostOutage = true;
    costCallCountDuringOutage = 0;

    const immOutageRes = await fetch(`${baseUrl}/ai-batches`, {
      method: "POST",
      headers: staffHeaders,
      body: JSON.stringify({
        request_id: "REQ_IMM_OUTAGE_1",
        product_ids: ["TMP-089001", "TMP-089002"],
        test_only: true,
      }),
    });
    assert.equal(immOutageRes.status, 200);
    const immOutageBody = await immOutageRes.json();
    assert.equal(immOutageBody.cost_fetch_failed_count, 2);
    assert.deepEqual(immOutageBody.cost_fetch_failed_product_ids, [
      "TMP-089001",
      "TMP-089002",
    ]);

    // Mark remaining items of disp88Res.batch_id as completed so worker focuses on immOutageBody
    for (const it of mockSupabase.state.ai_batch_items) {
      if (it.batch_id === disp88Res.batch_id && it.status === "pending") {
        it.status = "completed";
      }
    }

    // Run worker (TMP-089001 succeeds, TMP-089002 fails LLM 3 times -> status: failed)
    for (let pass = 0; pass < 3; pass++) {
      for (const it of mockSupabase.state.ai_batch_items) {
        if (it.batch_id === immOutageBody.batch_id && it.next_retry_at) {
          it.next_retry_at = new Date(Date.now() - 1000).toISOString();
        }
      }
      await fetch(`${baseUrl}/ai-batches/worker/run`, {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({ max_items: 5 }),
      });
    }

    // Retry failed item TMP-089002 while cost endpoint is STILL in total outage -> retry succeeds and generates!
    failLlmFor089002 = false;
    const retryOutageRes = await fetch(
      `${baseUrl}/ai-batches/${immOutageBody.batch_id}/retry`,
      {
        method: "POST",
        headers: staffHeaders,
        body: JSON.stringify({ request_id: "REQ_RETRY_OUTAGE_1" }),
      }
    );
    assert.equal(retryOutageRes.status, 200);
    const retryOutageBody = await retryOutageRes.json();
    assert.equal(retryOutageBody.success, true);
    assert.equal(retryOutageBody.retried_count, 1);

    await fetch(`${baseUrl}/ai-batches/worker/run`, {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify({ max_items: 5 }),
    });
    const item089002 = mockSupabase.state.ai_batch_items.find(
      (i) => i.batch_id === immOutageBody.batch_id && i.product_id === "TMP-089002"
    );
    assert.equal(item089002.status, "completed");
    assert.equal(mockSupabase.state.products.get("TMP-089002").planned_sale_price, 18000);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
