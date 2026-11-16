import http from "node:http";
import { createClient } from "@supabase/supabase-js";
import { createAuthVerifier, createWriteAccessVerifier } from "./auth.mjs";
import {
  asTrimmedString,
  mapGasProductToSupabaseBundle,
} from "./productMapper.mjs";
import {
  queryAdminProductList,
  queryProductDetail,
  queryPublicCategoryList,
  upsertProductBundle,
} from "./productsRepository.mjs";
import {
  createDraftProduct,
  flushPendingSupabaseDraftToSheets,
  importProductByImages,
  ProductWriteError,
  updateDraftInventoryStatus,
  updateDraftProduct,
  updateDraftRecordStatus,
  updateProductImages,
} from "./productWriter.mjs";
import { reconcileProductsFromGas } from "./reconciler.mjs";
import {
  confirmProductAiDraft,
  generateProductAiDraft,
  getProductAiDraft,
  saveProductAiSelectedImages,
  syncAiProductDraftsFromGas,
} from "./aiDraftService.mjs";
import {
  cancelAiBatchSchedule,
  createAiBatchSchedule,
  createAiBatchWorkerCoordinator,
  createAiProductDraftBatch,
  dispatchDueAiBatchSchedules,
  getAiBatchSchedule,
  getAiProductDraftBatch,
  hasRunnableAiBatchQueueItems,
  listAiBatchRuns,
  listAiBatchSchedules,
  retryAiProductDraftBatch,
} from "./aiBatchService.mjs";

const MAX_WRITE_BODY_BYTES = 35 * 1024 * 1024; // 35MB for up to 20 base64 images

function getAllowedOrigins() {
  const raw = process.env.ALLOWED_ORIGINS || "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildCorsHeaders(req) {
  const allowed = getAllowedOrigins();
  const origin = req.headers.origin || "";
  let allowOrigin = "*";
  if (allowed.length > 0) {
    allowOrigin = origin && allowed.includes(origin) ? origin : allowed[0];
  } else if (origin) {
    allowOrigin = origin;
  }

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, apikey, x-client-info, X-Requested-With, X-Internal-Sync-Token",
    Vary: "Origin",
  };
}

function readJsonBody(req, maxBytes = MAX_WRITE_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let aborted = false;

    req.on("data", (chunk) => {
      if (aborted) return;
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        aborted = true;
        reject(
          new ProductWriteError(
            413,
            "PAYLOAD_TOO_LARGE",
            `Request payload exceeds maximum size of ${maxBytes} bytes`
          )
        );
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (aborted) return;
      const rawText = Buffer.concat(chunks).toString("utf8").trim();
      if (!rawText) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(rawText));
      } catch {
        reject(
          new ProductWriteError(400, "INVALID_JSON", "Invalid JSON request body")
        );
      }
    });

    req.on("error", (err) => {
      if (!aborted) reject(err);
    });
  });
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

export function createSupabaseAdminClient() {
  const supabaseUrl = asTrimmedString(process.env.SUPABASE_URL);
  const serviceRoleKey = asTrimmedString(process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables"
    );
  }
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

/**
 * Creates the HTTP request handler (injectable `getSupabase`, `fetchImpl`, `internalSecret` for unit testing).
 */
export function createProductsApiHandler({
  getSupabase,
  fetchImpl = globalThis.fetch,
  gasWebAppUrl = process.env.GAS_WEB_APP_URL || "",
  internalSecret,
  readdyBackendUrl,
  readdyBackendAnonKey,
  geminiApiKey,
  selfApiUrl,
  aiBatchConcurrency,
  enableAutoBatchWorker = true,
  allowedOrigins,
} = {}) {
  let cachedSupabase = null;
  const resolveSupabase = () => {
    if (getSupabase) return getSupabase();
    if (!cachedSupabase) {
      cachedSupabase = createSupabaseAdminClient();
    }
    return cachedSupabase;
  };

  const resolveInternalSecret = () =>
    internalSecret !== undefined
      ? asTrimmedString(internalSecret)
      : asTrimmedString(process.env.PRODUCTS_API_INTERNAL_SECRET);

  const resolveGeminiApiKey = () =>
    geminiApiKey !== undefined ? geminiApiKey : process.env.GEMINI_API_KEY;

  const resolveReaddyBackendUrl = () =>
    readdyBackendUrl !== undefined
      ? asTrimmedString(readdyBackendUrl)
      : asTrimmedString(process.env.READDY_BACKEND_URL);

  const resolveReaddyBackendAnonKey = () =>
    readdyBackendAnonKey !== undefined
      ? asTrimmedString(readdyBackendAnonKey)
      : asTrimmedString(process.env.READDY_BACKEND_ANON_KEY);

  const resolveSelfApiUrl = () =>
    selfApiUrl !== undefined
      ? asTrimmedString(selfApiUrl)
      : asTrimmedString(
          process.env.SELF_API_URL || process.env.CLOUD_RUN_PRODUCTS_API_URL || ""
        );

  const verifyAuth = createAuthVerifier({
    getInternalSecret: resolveInternalSecret,
  });

  const verifyWriteAccess = createWriteAccessVerifier({
    getInternalSecret: resolveInternalSecret,
    getReaddyBackendUrl: resolveReaddyBackendUrl,
    getAllowedOrigins: () =>
      Array.isArray(allowedOrigins) ? allowedOrigins : getAllowedOrigins(),
    fetchImpl,
  });

  const batchWorkerCoordinator = createAiBatchWorkerCoordinator({
    getSupabase: resolveSupabase,
    fetchImpl,
    getGasWebAppUrl: () => gasWebAppUrl,
    getGeminiApiKey: resolveGeminiApiKey,
    getInternalSecret: resolveInternalSecret,
    getSelfApiUrl: resolveSelfApiUrl,
    concurrency: aiBatchConcurrency,
  });
  const activeWorkerTrigger = enableAutoBatchWorker
    ? batchWorkerCoordinator.dispatchWakeup
    : undefined;

  return async function handleRequest(req, res) {
    const startMs = performance.now();
    const cors = buildCorsHeaders(req);

    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }

    const urlObj = new URL(req.url || "/", "http://localhost");
    const pathname = urlObj.pathname.replace(/\/+$/, "") || "/";
    const params = Object.fromEntries(urlObj.searchParams.entries());

    try {
      // 1. Health check (/health for Cloud Run GFE compatibility; /healthz for local/internal)
      if ((pathname === "/health" || pathname === "/healthz") && req.method === "GET") {
        let dbStatus = "skipped";
        if (params.db === "1") {
          const supabase = resolveSupabase();
          const { error } = await supabase
            .from("products")
            .select("product_id", { head: true })
            .limit(1);
          if (error) throw new Error(`DB health check failed: ${error.message}`);
          dbStatus = "ok";
        }
        const elapsedMs = Math.round((performance.now() - startMs) * 100) / 100;
        return sendJson(
          res,
          200,
          {
            success: true,
            service: "bis-ec-products-api",
            db: dbStatus,
            elapsed_ms: elapsedMs,
          },
          { ...cors, "X-Response-Time-Ms": String(elapsedMs) }
        );
      }

      // 2. Periodic/manual diff reconciliation from Google Sheets -> Supabase (Cloud Scheduler / server-only token)
      if (pathname === "/reconcile" && req.method === "POST") {
        const supabase = resolveSupabase();
        const authResult = await verifyAuth(req, supabase);
        if (!authResult.ok) {
          return sendJson(
            res,
            authResult.status,
            {
              success: false,
              error_code: authResult.errorCode,
              error: authResult.error,
            },
            cors
          );
        }

        const rawRolling = parseInt(String(params.rolling ?? "10"), 10);
        const rollingLimit = Number.isNaN(rawRolling)
          ? 10
          : Math.min(50, Math.max(0, rawRolling));
        const forceFull = params.force_full === "1";

        const report = await reconcileProductsFromGas({
          supabase,
          fetchImpl,
          gasWebAppUrl,
          triggerSource:
            authResult.actorType === "internal" ? "scheduled" : `manual:${authResult.email}`,
          rollingLimit,
          forceFull,
        });

        let aiBatchWakeupDispatched = false;
        if (enableAutoBatchWorker) {
          const hasRunnable = await hasRunnableAiBatchQueueItems(supabase).catch(
            () => false
          );
          if (hasRunnable) {
            await batchWorkerCoordinator.dispatchWakeup({
              reason: "reconcile_wakeup",
            });
            aiBatchWakeupDispatched = true;
          }
        }

        const elapsedMs = Math.round((performance.now() - startMs) * 100) / 100;
        return sendJson(
          res,
          200,
          {
            success: true,
            reconciled: true,
            ...report,
            ai_batch_wakeup_dispatched: aiBatchWakeupDispatched,
            elapsed_ms: elapsedMs,
          },
          { ...cors, "X-Response-Time-Ms": String(elapsedMs) }
        );
      }

      // 3. Single-product on-demand sync from GAS after frontend write
      //    Reads authoritative state from Google Sheets (GAS) only; accepts no arbitrary payload from caller.
      const syncMatch = pathname.match(/^\/sync\/([^/]+)$/);
      if (syncMatch && req.method === "POST") {
        const supabase = resolveSupabase();
        const targetProductId = decodeURIComponent(syncMatch[1]).trim();
        if (!targetProductId) {
          return sendJson(
            res,
            400,
            { success: false, error: "product_id is required" },
            cors
          );
        }
        if (!gasWebAppUrl) {
          return sendJson(
            res,
            501,
            { success: false, error: "GAS_WEB_APP_URL is not configured" },
            cors
          );
        }

        const { data: existingSyncRow } = await supabase
          .from("products")
          .select("product_id, sheets_mirror_pending, is_test")
          .eq("product_id", targetProductId)
          .maybeSingle();

        if (existingSyncRow?.sheets_mirror_pending === true) {
          const flushed = await flushPendingSupabaseDraftToSheets({
            supabase,
            fetchImpl,
            gasWebAppUrl,
            productId: targetProductId,
          });
          if (!flushed) {
            return sendJson(
              res,
              409,
              {
                success: false,
                error_code: "PENDING_SHEETS_MIRROR",
                error:
                  "Product has a pending Supabase draft edit awaiting Sheets mirror; refusing stale overwrite",
                product_id: targetProductId,
              },
              cors
            );
          }
        }

        const detailUrl = `${gasWebAppUrl}?mode=admin&product_id=${encodeURIComponent(
          targetProductId
        )}`;
        const gasRes = await fetchImpl(detailUrl, { method: "GET" });
        if (!gasRes.ok) {
          throw new Error(`GAS detail fetch failed with HTTP ${gasRes.status}`);
        }
        const gasJson = await gasRes.json();
        if (!gasJson || gasJson.success !== true || !gasJson.product) {
          const isNotFound =
            gasJson &&
            gasJson.success === false &&
            String(gasJson.error || "").toLowerCase().includes("not found");
          if (params.allow_delete === "1" && isNotFound) {
            const { error: delErr } = await supabase
              .from("products")
              .delete()
              .eq("product_id", targetProductId);
            if (delErr) {
              throw new Error(`Failed deleting ${targetProductId}: ${delErr.message}`);
            }
            const elapsedMs = Math.round((performance.now() - startMs) * 100) / 100;
            return sendJson(
              res,
              200,
              {
                success: true,
                synced: true,
                deleted: true,
                product_id: targetProductId,
                elapsed_ms: elapsedMs,
              },
              { ...cors, "X-Response-Time-Ms": String(elapsedMs) }
            );
          }
          return sendJson(
            res,
            404,
            {
              success: false,
              error: gasJson?.error || "product not found in GAS",
              product_id: targetProductId,
            },
            cors
          );
        }

        const bundle = mapGasProductToSupabaseBundle({
          summary: gasJson.product,
          detail: gasJson.product,
        });
        if (existingSyncRow && typeof existingSyncRow.is_test === "boolean") {
          bundle.productRow.is_test = existingSyncRow.is_test;
        }
        await upsertProductBundle(supabase, bundle);
        if (resolveInternalSecret()) {
          await syncAiProductDraftsFromGas({
            supabase,
            fetchImpl,
            gasWebAppUrl,
            internalSecret: resolveInternalSecret(),
            productIds: [targetProductId],
          }).catch(() => {});
        }
        const elapsedMs = Math.round((performance.now() - startMs) * 100) / 100;
        return sendJson(
          res,
          200,
          {
            success: true,
            synced: true,
            product_id: targetProductId,
            elapsed_ms: elapsedMs,
          },
          { ...cors, "X-Response-Time-Ms": String(elapsedMs) }
        );
      }

      // 4. Phase 2 Unit 1, Unit 2 & Unit 3: Product Write, Image & Draft Status Endpoints (Cloud Run + Supabase authoritative)
      //    - POST /products                                      -> createDraftProduct
      //    - POST /products/import                               -> importProductByImages
      //    - POST|PUT|PATCH /products/:productId/images          -> updateProductImages
      //    - POST|PATCH /products/:productId/inventory-status    -> updateDraftInventoryStatus
      //    - POST|PATCH /products/:productId/record-status       -> updateDraftRecordStatus
      //    - POST /products/:productId/update                    -> updateDraftProduct
      //    - PATCH /products/:productId                          -> updateDraftProduct
      //    - POST / (action=create_draft_product|update_product|import_product_by_images|update_product_images|update_inventory_status|update_record_status)
      const imagesPathMatch = pathname.match(/^\/products\/([^/]+)\/images$/);
      const aiSelectedImagesPathMatch = pathname.match(
        /^\/products\/([^/]+)\/ai-selected-images$/
      );
      const aiDraftGeneratePathMatch = pathname.match(
        /^\/products\/([^/]+)\/ai-draft\/generate$/
      );
      const aiDraftConfirmPathMatch = pathname.match(
        /^\/products\/([^/]+)\/ai-draft\/confirm$/
      );
      const aiDraftGetPathMatch = pathname.match(
        /^\/products\/([^/]+)\/ai-draft$/
      );
      const aiBatchGetPathMatch = pathname.match(/^\/ai-batches\/([^/]+)$/);
      const aiBatchRetryPathMatch = pathname.match(
        /^\/ai-batches\/([^/]+)\/retry$/
      );
      const aiBatchScheduleGetPathMatch =
        pathname !== "/ai-batch-schedules/dispatch"
          ? pathname.match(/^\/ai-batch-schedules\/([^/]+)$/)
          : null;
      const aiBatchScheduleCancelPathMatch = pathname.match(
        /^\/ai-batch-schedules\/([^/]+)\/cancel$/
      );
      const inventoryStatusPathMatch = pathname.match(
        /^\/products\/([^/]+)\/inventory-status$/
      );
      const recordStatusPathMatch = pathname.match(
        /^\/products\/([^/]+)\/record-status$/
      );
      const updatePathMatch = pathname.match(/^\/products\/([^/]+)\/update$/);
      const patchPathMatch =
        req.method === "PATCH" ? pathname.match(/^\/products\/([^/]+)$/) : null;

      // 旧「午前2時自動候補選定」経路は要件外のため無効化（410 Gone）
      if (pathname === "/ai-batches/nightly/run" && req.method === "POST") {
        const supabase = resolveSupabase();
        const authResult = await verifyWriteAccess(req, supabase);
        if (!authResult.ok) {
          return sendJson(
            res,
            authResult.status,
            {
              success: false,
              error_code: authResult.errorCode,
              error: authResult.error,
              message: authResult.error,
            },
            cors
          );
        }
        if (authResult.actorType !== "internal") {
          return sendJson(
            res,
            403,
            {
              success: false,
              error_code: "FORBIDDEN_INTERNAL_ONLY",
              error: "Scheduled nightly AI batch requires server-to-server internal token",
              message: "夜間AI一括生成の起動にはサーバー間認証トークンが必要です。",
            },
            cors
          );
        }
        return sendJson(
          res,
          410,
          {
            success: false,
            error_code: "AUTO_NIGHTLY_SELECTION_DISABLED",
            error: "Automatic nightly candidate selection is disabled; use /ai-batch-schedules instead",
            message:
              "自動候補選定による夜間実行は無効化されています。商品一覧で対象商品と開始日時を指定して予約してください。",
          },
          cors
        );
      }

      if (pathname === "/ai-batch-schedules/dispatch" && req.method === "POST") {
        const supabase = resolveSupabase();
        const authResult = await verifyWriteAccess(req, supabase);
        if (!authResult.ok) {
          return sendJson(
            res,
            authResult.status,
            {
              success: false,
              error_code: authResult.errorCode,
              error: authResult.error,
              message: authResult.error,
            },
            cors
          );
        }
        if (authResult.actorType !== "internal") {
          return sendJson(
            res,
            403,
            {
              success: false,
              error_code: "FORBIDDEN_INTERNAL_ONLY",
              error: "Schedule dispatcher requires server-to-server internal token",
              message: "予約起動ディスパッチャーの実行にはサーバー間認証トークンが必要です。",
            },
            cors
          );
        }
        const body = await readJsonBody(req);
        const result = await dispatchDueAiBatchSchedules({
          supabase,
          fetchImpl,
          gasWebAppUrl,
          readdyBackendUrl: resolveReaddyBackendUrl(),
          readdyBackendAnonKey: resolveReaddyBackendAnonKey(),
          maxSchedules: body?.max_schedules,
          triggerWorker: activeWorkerTrigger,
        });
        const elapsedMs = Math.round((performance.now() - startMs) * 100) / 100;
        return sendJson(
          res,
          result.status,
          {
            ...result.body,
            elapsed_ms: elapsedMs,
          },
          { ...cors, "X-Response-Time-Ms": String(elapsedMs) }
        );
      }

      if (pathname === "/ai-batch-schedules" && req.method === "POST") {
        const supabase = resolveSupabase();
        const writeAuth = await verifyWriteAccess(req, supabase);
        if (!writeAuth.ok) {
          return sendJson(
            res,
            writeAuth.status,
            {
              success: false,
              error_code: writeAuth.errorCode,
              error: writeAuth.error,
              message: writeAuth.error,
            },
            cors
          );
        }
        const body = await readJsonBody(req);
        const result = await createAiBatchSchedule({
          supabase,
          payload: body,
        });
        const elapsedMs = Math.round((performance.now() - startMs) * 100) / 100;
        return sendJson(res, result.status, result.body, {
          ...cors,
          "X-Response-Time-Ms": String(elapsedMs),
        });
      }

      if (pathname === "/ai-batch-runs" && req.method === "GET") {
        const supabase = resolveSupabase();
        const writeAuth = await verifyWriteAccess(req, supabase);
        if (!writeAuth.ok) {
          return sendJson(
            res,
            writeAuth.status,
            {
              success: false,
              error_code: writeAuth.errorCode,
              error: writeAuth.error,
              message: writeAuth.error,
            },
            cors
          );
        }
        const rawTestOnly = asTrimmedString(params.test_only).toLowerCase();
        const testOnly = rawTestOnly === "1" || rawTestOnly === "true";
        const result = await listAiBatchRuns({
          supabase,
          testOnly,
          limit: params.limit !== undefined ? Number(params.limit) : undefined,
        });
        const elapsedMs = Math.round((performance.now() - startMs) * 100) / 100;
        return sendJson(res, result.status, result.body, {
          ...cors,
          "X-Response-Time-Ms": String(elapsedMs),
        });
      }

      if (pathname === "/ai-batch-schedules" && req.method === "GET") {
        const supabase = resolveSupabase();
        const writeAuth = await verifyWriteAccess(req, supabase);
        if (!writeAuth.ok) {
          return sendJson(
            res,
            writeAuth.status,
            {
              success: false,
              error_code: writeAuth.errorCode,
              error: writeAuth.error,
              message: writeAuth.error,
            },
            cors
          );
        }
        const rawTestOnly = asTrimmedString(params.test_only).toLowerCase();
        const testOnly = rawTestOnly === "1" || rawTestOnly === "true";
        const result = await listAiBatchSchedules({
          supabase,
          testOnly,
          limit: params.limit !== undefined ? Number(params.limit) : undefined,
        });
        const elapsedMs = Math.round((performance.now() - startMs) * 100) / 100;
        return sendJson(res, result.status, result.body, {
          ...cors,
          "X-Response-Time-Ms": String(elapsedMs),
        });
      }

      if (aiBatchScheduleGetPathMatch && req.method === "GET") {
        const supabase = resolveSupabase();
        const writeAuth = await verifyWriteAccess(req, supabase);
        if (!writeAuth.ok) {
          return sendJson(
            res,
            writeAuth.status,
            {
              success: false,
              error_code: writeAuth.errorCode,
              error: writeAuth.error,
              message: writeAuth.error,
            },
            cors
          );
        }
        const targetScheduleId = decodeURIComponent(
          aiBatchScheduleGetPathMatch[1]
        ).trim();
        let testOnlyFilter;
        if (params.test_only !== undefined) {
          const rawTestOnly = asTrimmedString(params.test_only).toLowerCase();
          testOnlyFilter = rawTestOnly === "1" || rawTestOnly === "true";
        }
        const result = await getAiBatchSchedule({
          supabase,
          scheduleId: targetScheduleId,
          testOnly: testOnlyFilter,
          triggerWorker: activeWorkerTrigger,
        });
        const elapsedMs = Math.round((performance.now() - startMs) * 100) / 100;
        return sendJson(res, result.status, result.body, {
          ...cors,
          "X-Response-Time-Ms": String(elapsedMs),
        });
      }

      if (aiBatchScheduleCancelPathMatch && req.method === "POST") {
        const supabase = resolveSupabase();
        const writeAuth = await verifyWriteAccess(req, supabase);
        if (!writeAuth.ok) {
          return sendJson(
            res,
            writeAuth.status,
            {
              success: false,
              error_code: writeAuth.errorCode,
              error: writeAuth.error,
              message: writeAuth.error,
            },
            cors
          );
        }
        const targetScheduleId = decodeURIComponent(
          aiBatchScheduleCancelPathMatch[1]
        ).trim();
        const body = await readJsonBody(req);
        let testOnlyFilter;
        if (typeof body?.test_only === "boolean") {
          testOnlyFilter = body.test_only;
        } else if (params.test_only !== undefined) {
          const rawTestOnly = asTrimmedString(params.test_only).toLowerCase();
          testOnlyFilter = rawTestOnly === "1" || rawTestOnly === "true";
        }
        const result = await cancelAiBatchSchedule({
          supabase,
          scheduleId: targetScheduleId,
          testOnly: testOnlyFilter,
        });
        const elapsedMs = Math.round((performance.now() - startMs) * 100) / 100;
        return sendJson(res, result.status, result.body, {
          ...cors,
          "X-Response-Time-Ms": String(elapsedMs),
        });
      }

      if (pathname === "/ai-batches/worker/run" && req.method === "POST") {
        const supabase = resolveSupabase();
        const authResult = await verifyAuth(req, supabase);
        if (!authResult.ok) {
          return sendJson(
            res,
            authResult.status,
            {
              success: false,
              error_code: authResult.errorCode,
              error: authResult.error,
              message: authResult.error,
            },
            cors
          );
        }
        const body = await readJsonBody(req);
        const workerReport = await batchWorkerCoordinator.runLocalPass({
          concurrency: body?.concurrency,
          maxItems: body?.max_items,
        });
        const elapsedMs = Math.round((performance.now() - startMs) * 100) / 100;
        return sendJson(
          res,
          200,
          {
            success: true,
            ...workerReport,
            elapsed_ms: elapsedMs,
          },
          { ...cors, "X-Response-Time-Ms": String(elapsedMs) }
        );
      }

      if (pathname === "/ai-batches" && req.method === "POST") {
        const supabase = resolveSupabase();
        const writeAuth = await verifyWriteAccess(req, supabase);
        if (!writeAuth.ok) {
          return sendJson(
            res,
            writeAuth.status,
            {
              success: false,
              error_code: writeAuth.errorCode,
              error: writeAuth.error,
              message: writeAuth.error,
            },
            cors
          );
        }
        const body = await readJsonBody(req);
        const result = await createAiProductDraftBatch({
          supabase,
          fetchImpl,
          gasWebAppUrl,
          readdyBackendUrl: resolveReaddyBackendUrl(),
          readdyBackendAnonKey: resolveReaddyBackendAnonKey(),
          callerAuthHeaders: {
            authorization: req.headers.authorization || "",
            apikey: req.headers.apikey || "",
          },
          actorType: writeAuth.actorType || "staff",
          payload: body,
          triggerWorker: activeWorkerTrigger,
        });
        const elapsedMs = Math.round((performance.now() - startMs) * 100) / 100;
        return sendJson(res, result.status, result.body, {
          ...cors,
          "X-Response-Time-Ms": String(elapsedMs),
        });
      }

      if (aiBatchGetPathMatch && req.method === "GET") {
        const supabase = resolveSupabase();
        const writeAuth = await verifyWriteAccess(req, supabase);
        if (!writeAuth.ok) {
          return sendJson(
            res,
            writeAuth.status,
            {
              success: false,
              error_code: writeAuth.errorCode,
              error: writeAuth.error,
              message: writeAuth.error,
            },
            cors
          );
        }
        const targetBatchId = decodeURIComponent(aiBatchGetPathMatch[1]).trim();
        let testOnlyFilter;
        if (params.test_only !== undefined) {
          const rawTestOnly = asTrimmedString(params.test_only).toLowerCase();
          testOnlyFilter = rawTestOnly === "1" || rawTestOnly === "true";
        }
        const result = await getAiProductDraftBatch({
          supabase,
          batchId: targetBatchId,
          testOnly: testOnlyFilter,
          triggerWorker: activeWorkerTrigger,
        });
        const elapsedMs = Math.round((performance.now() - startMs) * 100) / 100;
        return sendJson(res, result.status, result.body, {
          ...cors,
          "X-Response-Time-Ms": String(elapsedMs),
        });
      }

      if (aiBatchRetryPathMatch && req.method === "POST") {
        const supabase = resolveSupabase();
        const writeAuth = await verifyWriteAccess(req, supabase);
        if (!writeAuth.ok) {
          return sendJson(
            res,
            writeAuth.status,
            {
              success: false,
              error_code: writeAuth.errorCode,
              error: writeAuth.error,
              message: writeAuth.error,
            },
            cors
          );
        }
        const targetBatchId = decodeURIComponent(
          aiBatchRetryPathMatch[1]
        ).trim();
        const body = await readJsonBody(req);
        const result = await retryAiProductDraftBatch({
          supabase,
          fetchImpl,
          readdyBackendUrl: resolveReaddyBackendUrl(),
          readdyBackendAnonKey: resolveReaddyBackendAnonKey(),
          callerAuthHeaders: {
            authorization: req.headers.authorization || "",
            apikey: req.headers.apikey || "",
          },
          actorType: writeAuth.actorType || "staff",
          batchId: targetBatchId,
          payload: body,
          triggerWorker: activeWorkerTrigger,
        });
        const elapsedMs = Math.round((performance.now() - startMs) * 100) / 100;
        return sendJson(res, result.status, result.body, {
          ...cors,
          "X-Response-Time-Ms": String(elapsedMs),
        });
      }

      if (aiDraftGetPathMatch && req.method === "GET") {
        const supabase = resolveSupabase();
        const writeAuth = await verifyWriteAccess(req, supabase);
        if (!writeAuth.ok) {
          return sendJson(
            res,
            writeAuth.status,
            {
              success: false,
              error_code: writeAuth.errorCode,
              error: writeAuth.error,
              message: writeAuth.error,
            },
            cors
          );
        }
        const targetProductId = decodeURIComponent(
          aiDraftGetPathMatch[1]
        ).trim();
        const result = await getProductAiDraft({
          supabase,
          fetchImpl,
          gasWebAppUrl,
          internalSecret: resolveInternalSecret(),
          productId: targetProductId,
        });
        const elapsedMs = Math.round((performance.now() - startMs) * 100) / 100;
        return sendJson(res, result.status, result.body, {
          ...cors,
          "X-Response-Time-Ms": String(elapsedMs),
        });
      }

      if (
        aiSelectedImagesPathMatch &&
        (req.method === "POST" || req.method === "PUT" || req.method === "PATCH")
      ) {
        const supabase = resolveSupabase();
        const writeAuth = await verifyWriteAccess(req, supabase);
        if (!writeAuth.ok) {
          return sendJson(
            res,
            writeAuth.status,
            {
              success: false,
              error_code: writeAuth.errorCode,
              error: writeAuth.error,
              message: writeAuth.error,
            },
            cors
          );
        }
        const targetProductId = decodeURIComponent(
          aiSelectedImagesPathMatch[1]
        ).trim();
        const body = await readJsonBody(req);
        const result = await saveProductAiSelectedImages({
          supabase,
          fetchImpl,
          gasWebAppUrl,
          productId: targetProductId,
          payload: body,
        });
        const elapsedMs = Math.round((performance.now() - startMs) * 100) / 100;
        return sendJson(res, result.status, result.body, {
          ...cors,
          "X-Response-Time-Ms": String(elapsedMs),
        });
      }

      if (aiDraftGeneratePathMatch && req.method === "POST") {
        const supabase = resolveSupabase();
        const writeAuth = await verifyWriteAccess(req, supabase);
        if (!writeAuth.ok) {
          return sendJson(
            res,
            writeAuth.status,
            {
              success: false,
              error_code: writeAuth.errorCode,
              error: writeAuth.error,
              message: writeAuth.error,
            },
            cors
          );
        }
        const targetProductId = decodeURIComponent(
          aiDraftGeneratePathMatch[1]
        ).trim();
        const body = await readJsonBody(req);
        const result = await generateProductAiDraft({
          supabase,
          fetchImpl,
          gasWebAppUrl,
          geminiApiKey:
            geminiApiKey !== undefined
              ? geminiApiKey
              : process.env.GEMINI_API_KEY,
          internalSecret: resolveInternalSecret(),
          readdyBackendUrl:
            readdyBackendUrl !== undefined
              ? asTrimmedString(readdyBackendUrl)
              : asTrimmedString(process.env.READDY_BACKEND_URL),
          callerAuthHeaders: {
            authorization: req.headers.authorization || "",
            apikey: req.headers.apikey || "",
          },
          productId: targetProductId,
          payload: body,
        });
        const elapsedMs = Math.round((performance.now() - startMs) * 100) / 100;
        return sendJson(res, result.status, result.body, {
          ...cors,
          "X-Response-Time-Ms": String(elapsedMs),
        });
      }

      if (aiDraftConfirmPathMatch && req.method === "POST") {
        const supabase = resolveSupabase();
        const writeAuth = await verifyWriteAccess(req, supabase);
        if (!writeAuth.ok) {
          return sendJson(
            res,
            writeAuth.status,
            {
              success: false,
              error_code: writeAuth.errorCode,
              error: writeAuth.error,
              message: writeAuth.error,
            },
            cors
          );
        }
        const targetProductId = decodeURIComponent(
          aiDraftConfirmPathMatch[1]
        ).trim();
        const body = await readJsonBody(req);
        const result = await confirmProductAiDraft({
          supabase,
          fetchImpl,
          gasWebAppUrl,
          internalSecret: resolveInternalSecret(),
          productId: targetProductId,
          payload: body,
        });
        const elapsedMs = Math.round((performance.now() - startMs) * 100) / 100;
        return sendJson(res, result.status, result.body, {
          ...cors,
          "X-Response-Time-Ms": String(elapsedMs),
        });
      }

      if (pathname === "/products/import" && req.method === "POST") {
        const supabase = resolveSupabase();
        const writeAuth = await verifyWriteAccess(req, supabase);
        if (!writeAuth.ok) {
          return sendJson(
            res,
            writeAuth.status,
            {
              success: false,
              error_code: writeAuth.errorCode,
              error: writeAuth.error,
              message: writeAuth.error,
            },
            cors
          );
        }
        const body = await readJsonBody(req);
        const result = await importProductByImages({
          supabase,
          fetchImpl,
          gasWebAppUrl,
          payload: body,
        });
        const elapsedMs = Math.round((performance.now() - startMs) * 100) / 100;
        return sendJson(res, result.status, result.body, {
          ...cors,
          "X-Response-Time-Ms": String(elapsedMs),
        });
      }

      if (
        imagesPathMatch &&
        (req.method === "POST" || req.method === "PUT" || req.method === "PATCH")
      ) {
        const supabase = resolveSupabase();
        const writeAuth = await verifyWriteAccess(req, supabase);
        if (!writeAuth.ok) {
          return sendJson(
            res,
            writeAuth.status,
            {
              success: false,
              error_code: writeAuth.errorCode,
              error: writeAuth.error,
              message: writeAuth.error,
            },
            cors
          );
        }
        const targetProductId = decodeURIComponent(imagesPathMatch[1]).trim();
        const body = await readJsonBody(req);
        const result = await updateProductImages({
          supabase,
          fetchImpl,
          gasWebAppUrl,
          productId: targetProductId,
          payload: body,
        });
        const elapsedMs = Math.round((performance.now() - startMs) * 100) / 100;
        return sendJson(res, result.status, result.body, {
          ...cors,
          "X-Response-Time-Ms": String(elapsedMs),
        });
      }

      if (pathname === "/products" && req.method === "POST") {
        const supabase = resolveSupabase();
        const writeAuth = await verifyWriteAccess(req, supabase);
        if (!writeAuth.ok) {
          return sendJson(
            res,
            writeAuth.status,
            {
              success: false,
              error_code: writeAuth.errorCode,
              error: writeAuth.error,
              message: writeAuth.error,
            },
            cors
          );
        }
        const body = await readJsonBody(req);
        const result = await createDraftProduct({
          supabase,
          fetchImpl,
          gasWebAppUrl,
          payload: body,
        });
        const elapsedMs = Math.round((performance.now() - startMs) * 100) / 100;
        return sendJson(res, result.status, result.body, {
          ...cors,
          "X-Response-Time-Ms": String(elapsedMs),
        });
      }

      if (
        inventoryStatusPathMatch &&
        (req.method === "POST" || req.method === "PATCH")
      ) {
        const supabase = resolveSupabase();
        const writeAuth = await verifyWriteAccess(req, supabase);
        if (!writeAuth.ok) {
          return sendJson(
            res,
            writeAuth.status,
            {
              success: false,
              error_code: writeAuth.errorCode,
              error: writeAuth.error,
              message: writeAuth.error,
            },
            cors
          );
        }
        const targetProductId = decodeURIComponent(
          inventoryStatusPathMatch[1]
        ).trim();
        const body = await readJsonBody(req);
        const result = await updateDraftInventoryStatus({
          supabase,
          fetchImpl,
          gasWebAppUrl,
          productId: targetProductId,
          payload: body,
        });
        const elapsedMs = Math.round((performance.now() - startMs) * 100) / 100;
        return sendJson(res, result.status, result.body, {
          ...cors,
          "X-Response-Time-Ms": String(elapsedMs),
        });
      }

      if (
        recordStatusPathMatch &&
        (req.method === "POST" || req.method === "PATCH")
      ) {
        const supabase = resolveSupabase();
        const writeAuth = await verifyWriteAccess(req, supabase);
        if (!writeAuth.ok) {
          return sendJson(
            res,
            writeAuth.status,
            {
              success: false,
              error_code: writeAuth.errorCode,
              error: writeAuth.error,
              message: writeAuth.error,
            },
            cors
          );
        }
        const targetProductId = decodeURIComponent(
          recordStatusPathMatch[1]
        ).trim();
        const body = await readJsonBody(req);
        const result = await updateDraftRecordStatus({
          supabase,
          fetchImpl,
          gasWebAppUrl,
          productId: targetProductId,
          payload: body,
        });
        const elapsedMs = Math.round((performance.now() - startMs) * 100) / 100;
        return sendJson(res, result.status, result.body, {
          ...cors,
          "X-Response-Time-Ms": String(elapsedMs),
        });
      }

      if ((updatePathMatch && req.method === "POST") || patchPathMatch) {
        const supabase = resolveSupabase();
        const writeAuth = await verifyWriteAccess(req, supabase);
        if (!writeAuth.ok) {
          return sendJson(
            res,
            writeAuth.status,
            {
              success: false,
              error_code: writeAuth.errorCode,
              error: writeAuth.error,
              message: writeAuth.error,
            },
            cors
          );
        }
        const rawTargetId = (updatePathMatch || patchPathMatch)[1];
        const targetProductId = decodeURIComponent(rawTargetId).trim();
        const body = await readJsonBody(req);
        const result = await updateDraftProduct({
          supabase,
          fetchImpl,
          gasWebAppUrl,
          productId: targetProductId,
          payload: body,
        });
        const elapsedMs = Math.round((performance.now() - startMs) * 100) / 100;
        return sendJson(res, result.status, result.body, {
          ...cors,
          "X-Response-Time-Ms": String(elapsedMs),
        });
      }

      if (pathname === "/" && req.method === "POST") {
        const supabase = resolveSupabase();
        const writeAuth = await verifyWriteAccess(req, supabase);
        if (!writeAuth.ok) {
          return sendJson(
            res,
            writeAuth.status,
            {
              success: false,
              error_code: writeAuth.errorCode,
              error: writeAuth.error,
              message: writeAuth.error,
            },
            cors
          );
        }
        const body = await readJsonBody(req);
        const action = asTrimmedString(body?.action);
        if (
          action === "import_product_by_images" ||
          (!action && asTrimmedString(body?.import_attempt_id))
        ) {
          const result = await importProductByImages({
            supabase,
            fetchImpl,
            gasWebAppUrl,
            payload: body,
          });
          const elapsedMs = Math.round((performance.now() - startMs) * 100) / 100;
          return sendJson(res, result.status, result.body, {
            ...cors,
            "X-Response-Time-Ms": String(elapsedMs),
          });
        }
        if (action === "update_product_images") {
          const result = await updateProductImages({
            supabase,
            fetchImpl,
            gasWebAppUrl,
            productId: asTrimmedString(body?.product_id),
            payload: body,
          });
          const elapsedMs = Math.round((performance.now() - startMs) * 100) / 100;
          return sendJson(res, result.status, result.body, {
            ...cors,
            "X-Response-Time-Ms": String(elapsedMs),
          });
        }
        if (action === "create_draft_product") {
          const result = await createDraftProduct({
            supabase,
            fetchImpl,
            gasWebAppUrl,
            payload: body,
          });
          const elapsedMs = Math.round((performance.now() - startMs) * 100) / 100;
          return sendJson(res, result.status, result.body, {
            ...cors,
            "X-Response-Time-Ms": String(elapsedMs),
          });
        }
        if (action === "update_product") {
          const result = await updateDraftProduct({
            supabase,
            fetchImpl,
            gasWebAppUrl,
            productId: asTrimmedString(body?.product_id),
            payload: body,
          });
          const elapsedMs = Math.round((performance.now() - startMs) * 100) / 100;
          return sendJson(res, result.status, result.body, {
            ...cors,
            "X-Response-Time-Ms": String(elapsedMs),
          });
        }
        if (action === "update_inventory_status") {
          const result = await updateDraftInventoryStatus({
            supabase,
            fetchImpl,
            gasWebAppUrl,
            productId: asTrimmedString(body?.product_id),
            payload: body,
          });
          const elapsedMs = Math.round((performance.now() - startMs) * 100) / 100;
          return sendJson(res, result.status, result.body, {
            ...cors,
            "X-Response-Time-Ms": String(elapsedMs),
          });
        }
        if (action === "update_record_status") {
          const result = await updateDraftRecordStatus({
            supabase,
            fetchImpl,
            gasWebAppUrl,
            productId: asTrimmedString(body?.product_id),
            payload: body,
          });
          const elapsedMs = Math.round((performance.now() - startMs) * 100) / 100;
          return sendJson(res, result.status, result.body, {
            ...cors,
            "X-Response-Time-Ms": String(elapsedMs),
          });
        }
        if (action === "save_product_ai_selected_images") {
          const result = await saveProductAiSelectedImages({
            supabase,
            fetchImpl,
            gasWebAppUrl,
            productId: asTrimmedString(body?.product_id),
            payload: body,
          });
          const elapsedMs = Math.round((performance.now() - startMs) * 100) / 100;
          return sendJson(res, result.status, result.body, {
            ...cors,
            "X-Response-Time-Ms": String(elapsedMs),
          });
        }
        if (action === "generate_ai_product_draft") {
          const result = await generateProductAiDraft({
            supabase,
            fetchImpl,
            gasWebAppUrl,
            geminiApiKey:
              geminiApiKey !== undefined
                ? geminiApiKey
                : process.env.GEMINI_API_KEY,
            internalSecret: resolveInternalSecret(),
            readdyBackendUrl:
              readdyBackendUrl !== undefined
                ? asTrimmedString(readdyBackendUrl)
                : asTrimmedString(process.env.READDY_BACKEND_URL),
            callerAuthHeaders: {
              authorization: req.headers.authorization || "",
              apikey: req.headers.apikey || "",
            },
            productId: asTrimmedString(body?.product_id),
            payload: body,
          });
          const elapsedMs = Math.round((performance.now() - startMs) * 100) / 100;
          return sendJson(res, result.status, result.body, {
            ...cors,
            "X-Response-Time-Ms": String(elapsedMs),
          });
        }
        if (action === "confirm_ai_product_draft") {
          const result = await confirmProductAiDraft({
            supabase,
            fetchImpl,
            gasWebAppUrl,
            internalSecret: resolveInternalSecret(),
            productId: asTrimmedString(body?.product_id),
            payload: body,
          });
          const elapsedMs = Math.round((performance.now() - startMs) * 100) / 100;
          return sendJson(res, result.status, result.body, {
            ...cors,
            "X-Response-Time-Ms": String(elapsedMs),
          });
        }
        if (action === "get_ai_product_draft") {
          const result = await getProductAiDraft({
            supabase,
            fetchImpl,
            gasWebAppUrl,
            internalSecret: resolveInternalSecret(),
            productId: asTrimmedString(body?.product_id),
          });
          const elapsedMs = Math.round((performance.now() - startMs) * 100) / 100;
          return sendJson(res, result.status, result.body, {
            ...cors,
            "X-Response-Time-Ms": String(elapsedMs),
          });
        }
        if (action === "create_ai_product_draft_batch") {
          const result = await createAiProductDraftBatch({
            supabase,
            fetchImpl,
            gasWebAppUrl,
            readdyBackendUrl: resolveReaddyBackendUrl(),
            callerAuthHeaders: {
              authorization: req.headers.authorization || "",
              apikey: req.headers.apikey || "",
            },
            actorType: writeAuth.actorType || "staff",
            payload: body,
            triggerWorker: activeWorkerTrigger,
          });
          const elapsedMs = Math.round((performance.now() - startMs) * 100) / 100;
          return sendJson(res, result.status, result.body, {
            ...cors,
            "X-Response-Time-Ms": String(elapsedMs),
          });
        }
        if (action === "get_ai_product_draft_batch") {
          const result = await getAiProductDraftBatch({
            supabase,
            batchId: asTrimmedString(body?.batch_id),
            testOnly:
              typeof body?.test_only === "boolean" ? body.test_only : undefined,
            triggerWorker: activeWorkerTrigger,
          });
          const elapsedMs = Math.round((performance.now() - startMs) * 100) / 100;
          return sendJson(res, result.status, result.body, {
            ...cors,
            "X-Response-Time-Ms": String(elapsedMs),
          });
        }
        if (action === "list_ai_batch_runs") {
          const result = await listAiBatchRuns({
            supabase,
            testOnly: body?.test_only === true,
            limit: body?.limit !== undefined ? Number(body.limit) : undefined,
          });
          const elapsedMs = Math.round((performance.now() - startMs) * 100) / 100;
          return sendJson(res, result.status, result.body, {
            ...cors,
            "X-Response-Time-Ms": String(elapsedMs),
          });
        }
        if (action === "retry_ai_product_draft_batch") {
          const result = await retryAiProductDraftBatch({
            supabase,
            fetchImpl,
            readdyBackendUrl: resolveReaddyBackendUrl(),
            callerAuthHeaders: {
              authorization: req.headers.authorization || "",
              apikey: req.headers.apikey || "",
            },
            actorType: writeAuth.actorType || "staff",
            batchId: asTrimmedString(body?.batch_id),
            payload: body,
            triggerWorker: activeWorkerTrigger,
          });
          const elapsedMs = Math.round((performance.now() - startMs) * 100) / 100;
          return sendJson(res, result.status, result.body, {
            ...cors,
            "X-Response-Time-Ms": String(elapsedMs),
          });
        }
        return sendJson(
          res,
          400,
          {
            success: false,
            error_code: "UNSUPPORTED_WRITE_ACTION",
            error: `Unsupported write action on Cloud Run API: ${action || "(empty)"}`,
          },
          cors
        );
      }

      // 5. Product Read Endpoints (GET / , GET /products , GET /products/:productId)
      if (req.method !== "GET") {
        return sendJson(
          res,
          405,
          { success: false, error: "Method Not Allowed" },
          cors
        );
      }

      const pathDetailMatch = pathname.match(/^\/products\/([^/]+)$/);
      if (pathname !== "/" && pathname !== "/products" && !pathDetailMatch) {
        return sendJson(
          res,
          404,
          { success: false, error: "Not Found" },
          cors
        );
      }

      const rawMode = asTrimmedString(params.mode).toLowerCase();
      if (rawMode !== "" && rawMode !== "public" && rawMode !== "admin") {
        return sendJson(
          res,
          400,
          {
            success: false,
            error_code: "INVALID_MODE",
            error: "Invalid mode parameter",
          },
          cors
        );
      }

      const isAdmin = rawMode === "admin";
      const supabase = resolveSupabase();

      const productId = pathDetailMatch
        ? decodeURIComponent(pathDetailMatch[1]).trim()
        : asTrimmedString(params.product_id);
      const category = asTrimmedString(params.category);

      let result;
      if (productId) {
        result = await queryProductDetail(supabase, { productId, isAdmin });
      } else if (isAdmin) {
        result = await queryAdminProductList(supabase, params);
      } else if (category) {
        result = await queryPublicCategoryList(supabase, category);
      } else {
        result = {
          status: 200,
          body: {
            success: false,
            error: "product_id, category, or mode=admin is required",
          },
        };
      }

      const elapsedMs = Math.round((performance.now() - startMs) * 100) / 100;
      return sendJson(res, result.status, result.body, {
        ...cors,
        "X-Response-Time-Ms": String(elapsedMs),
      });
    } catch (err) {
      const elapsedMs = Math.round((performance.now() - startMs) * 100) / 100;
      if (err instanceof ProductWriteError) {
        return sendJson(
          res,
          err.status || 400,
          {
            success: false,
            error_code: err.errorCode,
            error: err.message,
            message: err.message,
          },
          { ...cors, "X-Response-Time-Ms": String(elapsedMs) }
        );
      }
      console.error(
        JSON.stringify({
          severity: "ERROR",
          path: pathname,
          method: req.method,
          elapsed_ms: elapsedMs,
          message: err instanceof Error ? err.message : String(err),
        })
      );
      return sendJson(
        res,
        500,
        {
          success: false,
          error: "Internal Server Error",
        },
        { ...cors, "X-Response-Time-Ms": String(elapsedMs) }
      );
    }
  };
}

// Start HTTP server when executed directly
const isMain =
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());

if (isMain) {
  const port = parseInt(process.env.PORT || "8080", 10);
  const server = http.createServer(createProductsApiHandler());
  server.listen(port, () => {
    console.log(
      JSON.stringify({
        severity: "INFO",
        message: `bis-ec-products-api listening on port ${port}`,
      })
    );
  });
}
