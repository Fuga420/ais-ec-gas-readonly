import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mapGasProductToSupabaseBundle } from "../src/productMapper.mjs";
import { createProductsApiHandler } from "../src/server.mjs";
import { executeSingleProductAiDraft } from "../src/aiDraftService.mjs";

const TINY_JPEG_BYTES = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
  "base64"
);

function createAiMockSupabase(initialProducts = []) {
  const state = {
    products: new Map(),
    product_images: [],
    product_translations: [],
    pokemon_cards: [],
    product_documents: [],
    product_ai_drafts: [],
    ai_draft_execution_locks: new Map(),
  };

  for (const b of initialProducts) {
    state.products.set(b.productRow.product_id, { ...b.productRow });
    state.product_images.push(...(b.imageRows || []));
    if (b.translationRow) state.product_translations.push(b.translationRow);
    if (b.pokemonCardRow) state.pokemon_cards.push(b.pokemonCardRow);
  }

  return {
    state,
    async rpc(fnName, args = {}) {
      if (fnName === "acquire_ai_draft_execution_lock") {
        const pid = args.p_product_id;
        assert.equal(typeof pid, "string");
        assert.equal(typeof args.p_ttl_seconds, "number");
        const ttlMs = Math.max(10, Number(args.p_ttl_seconds || 180)) * 1000;
        const existing = state.ai_draft_execution_locks.get(pid);
        if (existing && existing.expiresAtMs > Date.now()) {
          return {
            data: {
              acquired: false,
              execution_id: "",
              existing_execution_id: existing.executionId,
            },
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
        const ok = Boolean(
          existing &&
            existing.executionId === args.p_execution_id &&
            existing.expiresAtMs > Date.now()
        );
        return { data: ok, error: null };
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
        assert.equal(typeof args.p_draft_id, "string");
        assert.ok(Array.isArray(args.p_source_image_ids));
        assert.ok(Array.isArray(args.p_search_queries));
        assert.ok(
          args.p_confirmed_at === null || typeof args.p_confirmed_at === "string"
        );
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
        const nextVer =
          Math.max(maxVer, Number(args.p_min_draft_version || 0)) + 1;
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
            args.p_candidate_price !== null &&
            args.p_candidate_price !== undefined
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
          data: {
            draft_id: newRow.draft_id,
            product_id: pid,
            draft_version: nextVer,
          },
          error: null,
        };
      }
      return { data: null, error: null };
    },
    from(table) {
      let filters = [];
      let orders = [];
      let limitCount = null;
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
            product_images: state.product_images.filter(
              (i) => i.product_id === r.product_id
            ),
            product_translations: state.product_translations.filter(
              (t) => t.product_id === r.product_id
            ),
            pokemon_cards: state.pokemon_cards.filter(
              (p) => p.product_id === r.product_id
            ),
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
        if (limitCount !== null) rows = rows.slice(0, limitCount);
        return { data: rows, error: null };
      };

      const builder = {
        select(cols = "") {
          if (String(cols).includes("product_images(")) includeRelations = true;
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
        order(col, opts = {}) {
          orders.push({ col, ascending: opts.ascending !== false });
          return builder;
        },
        limit(n) {
          limitCount = n;
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
                (t) => t.product_id === it.product_id && (t.locale || "en") === (it.locale || "en")
              );
              if (idx >= 0) state.product_translations[idx] = { ...state.product_translations[idx], ...it };
              else state.product_translations.push(it);
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
                (d) => d.product_id === it.product_id && d.draft_version === it.draft_version
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

test("Phase 2 Unit 4: Single-product AI image selection, grounded draft generation (+cost floor), lookup, confirmation, and reusable auto_apply", async () => {
  const initialBundle = mapGasProductToSupabaseBundle({
    summary: { product_id: "TMP-000701", publish_status: "draft", record_status: "active" },
    detail: {
      product_id: "TMP-000701",
      category: "",
      brand: "",
      product_name: "",
      condition: "",
      planned_sale_price: 0,
      publish_status: "draft",
      inventory_status: "in_stock",
      record_status: "active",
      drive_folder_url: "https://drive.google.com/drive/folders/FOLDER_701",
      main_image_url: "https://drive.google.com/file/d/FILE_701_1/view",
      images: [
        { file_id: "FILE_701_1", name: "01_main.jpg", mime_type: "image/jpeg", view_url: "https://drive.google.com/file/d/FILE_701_1/view" },
        { file_id: "FILE_701_2", name: "02_label.jpg", mime_type: "image/jpeg", view_url: "https://drive.google.com/file/d/FILE_701_2/view" },
        { file_id: "FILE_701_DELETED", name: "03_deleted.jpg", mime_type: "image/jpeg", view_url: "https://drive.google.com/file/d/FILE_701_DELETED/view" },
      ],
    },
    rowSeq: 1,
  });

  const mockSupabase = createAiMockSupabase([initialBundle]);
  const gasCalls = [];

  const mockFetch = async (url, init = {}) => {
    const urlStr = String(url);
    if (urlStr.includes("/auth/v1/settings")) {
      return new Response(JSON.stringify({ external: {} }), { status: 200 });
    }
    if (urlStr.includes("/functions/v1/documents-relay")) {
      return new Response(
        JSON.stringify({
          success: true,
          product_id: "TMP-000701",
          cost_breakdown: { total_allocated_cost: 20000, matched_lines_count: 1 },
          links: [
            {
              link_type: "primary_cost",
              allocated_amount: 20000,
              line: {
                item_amount: 18000,
                tax_amount: 1800,
                fee_amount: 200,
                fee_tax_amount: 0,
                total_line_amount: 20000,
              },
            },
          ],
        }),
        { status: 200 }
      );
    }
    if (urlStr.startsWith("https://drive.google.com/uc?export=download")) {
      if (urlStr.includes("FILE_701_DELETED")) {
        return new Response("Not Found", { status: 404 });
      }
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
                  parts: [{ text: JSON.stringify({ category: "sneaker", confidence: "high", rationale: "Nike box" }) }],
                },
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (hasSearchTool) {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                finishReason: "STOP",
                groundingMetadata: {
                  webSearchQueries: ["DZ5485-612 Nike Air Jordan 1 Lost and Found"],
                  groundingChunks: [
                    { web: { uri: "https://snkrdunk.com/products/DZ5485-612", title: "Nike AJ1 Chicago" } },
                  ],
                },
                content: {
                  parts: [
                    {
                      text: [
                        "### 1. DIRECT PHYSICAL OBSERVATIONS",
                        "- BOX_LABEL_SKU: DZ5485-612",
                        "- INNER_TAG_SIZE: 27.5cm",
                        "### 2. EXTERNAL SEARCH CORROBORATIONS",
                        "- CORROBORATED_MODEL: Nike Air Jordan 1 High OG Lost & Found / Chicago",
                        "- STYLE_CODE: DZ5485-612",
                        "### 3. PRICING TRANSACTIONS",
                        "- Sold: 22,000円 (2026-10, https://snkrdunk.com/products/DZ5485-612)",
                        "### 4. UNCONFIRMED ATTRIBUTES",
                        "- None",
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
      // Stage B structured JSON
      return new Response(
        JSON.stringify({
          candidates: [
            {
              finishReason: "STOP",
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      title_ja: "ナイキ エアジョーダン1 ハイ OG ロスト & ファウンド/シカゴ (DZ5485-612)",
                      title_en: "Nike Air Jordan 1 High OG Lost & Found / Chicago (DZ5485-612)",
                      description_ja: "ナイキ エアジョーダン1 ハイ OG シカゴです。",
                      description_en: "Nike Air Jordan 1 High OG Lost & Found Chicago.",
                      hashtags_ja: "#NIKE #AirJordan1",
                      condition: "目立った傷や汚れなし",
                      category: "sneaker",
                      brand: "JORDAN",
                      sku: "DZ5485-612",
                      size: "27.5cm",
                      price: 22000,
                      price_basis: "recent_sold_provisional",
                      price_note: "成約参考 22,000円",
                      price_evidence: [
                        {
                          source_url: "https://snkrdunk.com/products/DZ5485-612",
                          price_type: "sold",
                          amount: 22000,
                          currency: "JPY",
                          transaction_date: "2026-10",
                          item_match_condition: "exact_match",
                          verification_status: "format_valid",
                        },
                      ],
                      needs_review: [],
                      identity_status: "confident",
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
      const body = init.body ? JSON.parse(init.body) : { method: "GET", url: urlStr };
      gasCalls.push(body);
      if (body.action === "get_ai_product_drafts_for_sync") {
        return new Response(JSON.stringify({ success: true, items: [] }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          success: true,
          confirmed_fingerprint: "GAS_FP_701_CONFIRMED",
        }),
        { status: 200 }
      );
    }
    throw new Error(`Unexpected fetch URL: ${urlStr}`);
  };

  const handler = createProductsApiHandler({
    getSupabase: () => mockSupabase,
    fetchImpl: mockFetch,
    gasWebAppUrl: "https://gas.example/exec",
    internalSecret: "test-internal-secret",
    readdyBackendUrl: "https://readdy.example",
    geminiApiKey: "test-gemini-key",
  });

  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const authHeaders = {
    "Content-Type": "application/json",
    apikey: "readdy-anon-key",
    Authorization: "Bearer readdy-staff-jwt",
  };

  try {
    // 1. Deleted image selection must fail closed with SELECTED_IMAGE_DELETED
    const delSelRes = await fetch(`${baseUrl}/products/TMP-000701/ai-selected-images`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ selected_image_ids: ["FILE_701_1", "FILE_701_DELETED"] }),
    });
    const delSelJson = await delSelRes.json();
    assert.equal(delSelJson.success, false);
    assert.equal(delSelJson.error_code, "SELECTED_IMAGE_DELETED");

    // 2. Valid 2-image selection saves to Supabase & mirrors to GAS
    const selRes = await fetch(`${baseUrl}/products/TMP-000701/ai-selected-images`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ selected_image_ids: ["FILE_701_1", "FILE_701_2"] }),
    });
    const selJson = await selRes.json();
    assert.equal(selJson.success, true);
    assert.deepEqual(selJson.selected_image_ids, ["FILE_701_1", "FILE_701_2"]);
    assert.deepEqual(
      mockSupabase.state.products.get("TMP-000701").selected_image_ids,
      ["FILE_701_1", "FILE_701_2"]
    );

    // 3. Generate AI draft: uses saved 2 images + applies 30% minimum gross margin floor (20,000 / (1 - 0.30) = 28,571.43 -> 28,600 > market 22,000)
    const genRes = await fetch(`${baseUrl}/products/TMP-000701/ai-draft/generate`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({}),
    });
    const genJson = await genRes.json();
    assert.equal(genJson.success, true);
    assert.equal(genJson.review_status, "pending_review");
    assert.equal(genJson.draft_version, 1);
    assert.equal(genJson.candidate.sku, "DZ5485-612");
    assert.equal(genJson.candidate.price, 28600);
    assert.equal(genJson.candidate.price_basis, "gross_margin_floor");
    assert.equal(mockSupabase.state.products.get("TMP-000701").ai_draft_flag, "ai_managed");

    // 4. Lookup AI draft (`GET /products/:id/ai-draft`) returns nested candidate.price = 28600
    const getRes = await fetch(`${baseUrl}/products/TMP-000701/ai-draft`, {
      method: "GET",
      headers: authHeaders,
    });
    const getJson = await getRes.json();
    assert.equal(getJson.success, true);
    assert.equal(getJson.latest_ai_draft.draft_id, genJson.draft_id);
    assert.equal(getJson.latest_ai_draft.candidate.price, 28600);

    // 5. Confirm AI draft (`POST /products/:id/ai-draft/confirm`)
    const confirmPayload = {
      draft_id: genJson.draft_id,
      draft_version: genJson.draft_version,
      confirmation_attempt_id: "att-701-1",
      confirmed_data: {
        product_name: genJson.candidate.title_ja,
        planned_sale_price: 28600,
        condition: genJson.candidate.condition,
        category: "sneaker",
        brand: "JORDAN",
        description: genJson.candidate.description_ja,
        hashtags_ja: "#NIKE #AirJordan1",
        sneaker_sku: "DZ5485-612",
        sneaker_size: "27.5cm",
        translated_title: genJson.candidate.title_en,
        translated_description: genJson.candidate.description_en,
      },
    };
    const confRes = await fetch(`${baseUrl}/products/TMP-000701/ai-draft/confirm`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify(confirmPayload),
    });
    const confJson = await confRes.json();
    assert.equal(confJson.success, true);
    assert.equal(confJson.review_status, "confirmed");
    assert.equal(confJson.confirmed_fingerprint, "GAS_FP_701_CONFIRMED");

    const updatedProd = mockSupabase.state.products.get("TMP-000701");
    assert.equal(updatedProd.category, "sneaker");
    assert.equal(updatedProd.planned_sale_price, 28600);
    assert.equal(updatedProd.sneaker_size, "27.5cm");
    assert.match(updatedProd.description, /#NIKE #AirJordan1/);

    // 6. Idempotent replay with same confirmation_attempt_id returns is_idempotent_replay: true
    const replayRes = await fetch(`${baseUrl}/products/TMP-000701/ai-draft/confirm`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify(confirmPayload),
    });
    const replayJson = await replayRes.json();
    assert.equal(replayJson.success, true);
    assert.equal(replayJson.is_idempotent_replay, true);

    // 7. Re-confirmation with updated sneaker_size ("28.0cm") and new attempt_id updates same product, while category change is blocked
    const catChangeRes = await fetch(`${baseUrl}/products/TMP-000701/ai-draft/confirm`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        ...confirmPayload,
        confirmation_attempt_id: "att-701-cat-change",
        confirmed_data: { ...confirmPayload.confirmed_data, category: "apparel" },
      }),
    });
    const catChangeJson = await catChangeRes.json();
    assert.equal(catChangeJson.success, false);
    assert.equal(catChangeJson.error_code, "CATEGORY_CANNOT_BE_CHANGED");

    const reconfRes = await fetch(`${baseUrl}/products/TMP-000701/ai-draft/confirm`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        ...confirmPayload,
        confirmation_attempt_id: "att-701-2",
        confirmed_data: { ...confirmPayload.confirmed_data, sneaker_size: "28.0cm" },
      }),
    });
    const reconfJson = await reconfRes.json();
    assert.equal(reconfJson.success, true);
    assert.equal(mockSupabase.state.products.get("TMP-000701").sneaker_size, "28.0cm");

    // 8. Re-generate without force_regenerate must reject CONFIRMED_DRAFT_EXISTS
    const regenBlockedRes = await fetch(`${baseUrl}/products/TMP-000701/ai-draft/generate`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({}),
    });
    const regenBlockedJson = await regenBlockedRes.json();
    assert.equal(regenBlockedJson.success, false);
    assert.equal(regenBlockedJson.error_code, "CONFIRMED_DRAFT_EXISTS");

    // 9. Reusable core `executeSingleProductAiDraft` with `auto_apply: true` (batch/nightly worker mode)
    //    protects staff-entered planned_sale_price (26000) & sneaker_size ("28.0cm")!
    mockSupabase.state.products.set("TMP-000701", {
      ...mockSupabase.state.products.get("TMP-000701"),
      planned_sale_price: 29800,
    });
    const batchCoreRes = await executeSingleProductAiDraft({
      supabase: mockSupabase,
      fetchImpl: mockFetch,
      gasWebAppUrl: "https://gas.example/exec",
      geminiApiKey: "test-gemini-key",
      internalSecret: "test-internal-secret",
      productId: "TMP-000701",
      options: {
        force_regenerate: true,
        auto_apply: true,
        selected_image_ids: ["FILE_701_1", "FILE_701_2"],
        confirmed_by: "ai_batch_worker",
      },
    });
    assert.equal(batchCoreRes.success, true);
    assert.equal(batchCoreRes.auto_applied, true);
    assert.equal(batchCoreRes.review_status, "confirmed");
    assert.equal(batchCoreRes.draft_version, 2);
    assert.equal(mockSupabase.state.products.get("TMP-000701").planned_sale_price, 29800);
    assert.equal(mockSupabase.state.products.get("TMP-000701").sneaker_size, "28.0cm");

    // 10. `mapGasProductToSupabaseBundle` omits `ai_draft_flag` when GAS `doGet` leaves it undefined
    const mappedWithoutFlag = mapGasProductToSupabaseBundle({
      summary: { product_id: "TMP-000701" },
      detail: { product_id: "TMP-000701", product_name: "Test" },
    });
    assert.equal(
      Object.prototype.hasOwnProperty.call(mappedWithoutFlag.productRow, "ai_draft_flag"),
      false
    );
  } finally {
    await new Promise((r) => server.close(r));
  }
});
