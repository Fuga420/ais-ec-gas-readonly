import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mapGasProductToSupabaseBundle } from "../src/productMapper.mjs";
import { createProductsApiHandler } from "../src/server.mjs";

const TINY_JPEG_B64 =
  "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";

function createWriteMockSupabase(initialBundles = [], startSeq = 163) {
  let idSeq = startSeq;
  let syncRunSeq = 1;
  const state = {
    products: new Map(),
    product_images: [],
    product_translations: [],
    pokemon_cards: [],
    product_documents: [],
    product_write_idempotency: [],
    product_import_attempts: [],
    product_sync_runs: [],
    rpcCalls: [],
    productMutations: 0,
    translationMutations: 0,
    failNextProductsUpsertError: null,
    failIdempotencyUpdates: false,
  };

  for (const b of initialBundles) {
    state.products.set(b.productRow.product_id, {
      is_test: false,
      ...b.productRow,
      search_text: [
        b.productRow.product_name,
        b.productRow.translated_title,
        b.productRow.product_id,
        b.productRow.brand,
        b.productRow.auction_item_number,
      ]
        .join(" ")
        .toLowerCase(),
    });
    state.product_images.push(...b.imageRows);
    if (b.translationRow) state.product_translations.push(b.translationRow);
    if (b.pokemonCardRow) state.pokemon_cards.push(b.pokemonCardRow);
    if (b.documentRow) state.product_documents.push(b.documentRow);
  }

  return {
    state,
    auth: {
      async getUser() {
        return { data: { user: null }, error: { message: "No user" } };
      },
    },
    async rpc(fnName, args = {}) {
      state.rpcCalls.push({ fnName, args });
      if (fnName === "allocate_next_product_id") {
        const floor = Number(args.min_floor) || 0;
        let maxExisting = 0;
        for (const pid of state.products.keys()) {
          const m = String(pid).match(/^TMP-(\d+)$/);
          if (m) maxExisting = Math.max(maxExisting, Number(m[1]));
        }
        for (const idem of state.product_write_idempotency) {
          const m = String(idem.product_id || "").match(/^TMP-(\d+)$/);
          if (m) maxExisting = Math.max(maxExisting, Number(m[1]));
        }
        for (const imp of state.product_import_attempts) {
          const m = String(imp.product_id || "").match(/^TMP-(\d+)$/);
          if (m) maxExisting = Math.max(maxExisting, Number(m[1]));
        }
        idSeq = Math.max(idSeq, maxExisting, floor) + 1;
        return {
          data: `TMP-${String(idSeq).padStart(6, "0")}`,
          error: null,
        };
      }
      if (fnName === "replace_product_images_atomic") {
        const pid = String(args.p_product_id || "").trim();
        const existingProd = state.products.get(pid);
        if (!existingProd) {
          return {
            data: null,
            error: { message: `Product not found: ${pid}` },
          };
        }
        const nowIso = new Date().toISOString();
        const nextRow = {
          ...existingProd,
          main_image_url: String(args.p_main_image_url || ""),
          main_image_display_url: String(args.p_main_image_display_url || ""),
          ...(args.p_update_selected_ids
            ? { selected_image_ids: [...(args.p_selected_image_ids || [])] }
            : {}),
          write_source: "supabase",
          supabase_written_at: nowIso,
          sheets_mirror_pending: false,
          synced_from_sheets_at: nowIso,
        };
        state.products.set(pid, nextRow);
        state.productMutations++;

        state.product_images = state.product_images.filter(
          (img) => img.product_id !== pid
        );
        const imgs = Array.isArray(args.p_images) ? args.p_images : [];
        imgs.forEach((img, idx) => {
          state.product_images.push({
            product_id: pid,
            sort_order:
              typeof img.sort_order === "number" ? img.sort_order : idx,
            file_id: String(img.file_id || ""),
            name: String(img.name || ""),
            mime_type: String(img.mime_type || "image/jpeg"),
            view_url: String(img.view_url || ""),
            display_url: String(img.display_url || ""),
          });
        });
        return { data: null, error: null };
      }
      if (fnName === "allocate_next_product_row_seq") {
        let maxRowSeq = 0;
        for (const r of state.products.values()) {
          maxRowSeq = Math.max(maxRowSeq, Number(r.row_seq) || 0);
        }
        return { data: maxRowSeq + 1, error: null };
      }
      return { data: null, error: null };
    },
    from(table) {
      let filters = [];
      let orders = [];
      let rangeBounds = null;
      let limitCount = null;
      let wantCount = false;
      let headOnly = false;
      let includeRelations = false;
      let pendingInsertRows = null;

      const executeSelect = () => {
        if (pendingInsertRows) {
          return {
            data: pendingInsertRows,
            count: pendingInsertRows.length,
            status: 201,
            error: null,
          };
        }
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
            product_documents: state.product_documents.filter(
              (d) => d.product_id === r.product_id
            ),
          }));
        }

        if (orders.length > 0) {
          rows.sort((a, b) => {
            for (const { col, ascending, nullsFirst } of orders) {
              const va = a[col];
              const vb = b[col];
              if (va === vb) continue;
              if (va === null || va === undefined) return nullsFirst ? -1 : 1;
              if (vb === null || vb === undefined) return nullsFirst ? 1 : -1;
              const cmp = va < vb ? -1 : 1;
              return ascending ? cmp : -cmp;
            }
            return 0;
          });
        }

        const total = rows.length;
        if (rangeBounds) {
          const [start, end] = rangeBounds;
          rows = rows.slice(start, end + 1);
        } else if (limitCount !== null) {
          rows = rows.slice(0, limitCount);
        }

        return {
          data: headOnly ? null : rows,
          count: wantCount ? total : null,
          status: 200,
          error: null,
        };
      };

      const builder = {
        select(cols, opts = {}) {
          wantCount = opts.count === "exact";
          headOnly = Boolean(opts.head);
          if (String(cols).includes("product_images(")) {
            includeRelations = true;
          }
          return builder;
        },
        eq(col, val) {
          filters.push((r) => r[col] === val);
          return builder;
        },
        in(col, vals) {
          const set = new Set(vals);
          filters.push((r) => set.has(r[col]));
          return builder;
        },
        ilike(col, pattern) {
          const inner = pattern
            .replace(/^%|%$/g, "")
            .replace(/\\([%_\\])/g, "$1");
          const needle = inner.toLowerCase();
          filters.push((r) =>
            String(r[col] || "").toLowerCase().includes(needle)
          );
          return builder;
        },
        order(col, opts = {}) {
          orders.push({
            col,
            ascending: opts.ascending !== false,
            nullsFirst: Boolean(opts.nullsFirst),
          });
          return builder;
        },
        limit(n) {
          limitCount = n;
          return builder;
        },
        range(start, end) {
          rangeBounds = [start, end];
          return Promise.resolve(executeSelect());
        },
        maybeSingle() {
          const res = executeSelect();
          return Promise.resolve({
            data: res.data && res.data.length > 0 ? res.data[0] : null,
            error: res.error,
          });
        },
        then(resolve, reject) {
          return Promise.resolve(executeSelect()).then(resolve, reject);
        },
        insert(payload) {
          const items = Array.isArray(payload) ? payload : [payload];
          if (table === "product_write_idempotency") {
            for (const it of items) {
              const dup = state.product_write_idempotency.find(
                (x) => x.request_id === it.request_id
              );
              if (dup) {
                pendingInsertRows = null;
                return {
                  then(resolve, reject) {
                    return Promise.resolve({
                      data: null,
                      error: { code: "23505", message: "duplicate key value" },
                    }).then(resolve, reject);
                  },
                };
              }
            }
          }
          if (table === "product_import_attempts") {
            for (const it of items) {
              const dup = state.product_import_attempts.find(
                (x) => x.attempt_id === it.attempt_id
              );
              if (dup) {
                pendingInsertRows = null;
                return {
                  then(resolve, reject) {
                    return Promise.resolve({
                      data: null,
                      error: { code: "23505", message: "duplicate key value" },
                    }).then(resolve, reject);
                  },
                };
              }
            }
          }
          const inserted = items.map((it) => {
            if (table === "product_sync_runs") {
              const row = { id: syncRunSeq++, ...it };
              state.product_sync_runs.push(row);
              return row;
            }
            state[table].push(it);
            return it;
          });
          pendingInsertRows = inserted;
          return builder;
        },
        update(patch) {
          const updateFilters = [];
          const updateBuilder = {
            eq(col, val) {
              updateFilters.push((r) => r[col] === val);
              return updateBuilder;
            },
            then(resolve, reject) {
              if (
                table === "product_write_idempotency" &&
                state.failIdempotencyUpdates
              ) {
                return Promise.resolve({
                  error: { message: "Simulated idempotency update outage" },
                }).then(resolve, reject);
              }
              if (table === "products") {
                state.productMutations++;
                for (const [k, row] of state.products.entries()) {
                  if (updateFilters.every((fn) => fn(row))) {
                    const nextRow = { ...row, ...patch };
                    nextRow.search_text = [
                      nextRow.product_name,
                      nextRow.translated_title,
                      nextRow.product_id,
                      nextRow.brand,
                      nextRow.auction_item_number,
                    ]
                      .join(" ")
                      .toLowerCase();
                    state.products.set(k, nextRow);
                  }
                }
              } else {
                state[table] = (state[table] || []).map((row) =>
                  updateFilters.every((fn) => fn(row))
                    ? { ...row, ...patch }
                    : row
                );
              }
              return Promise.resolve({ error: null }).then(resolve, reject);
            },
          };
          return updateBuilder;
        },
        upsert(payload) {
          const items = Array.isArray(payload) ? payload : [payload];
          if (table === "products") {
            if (state.failNextProductsUpsertError) {
              const errMsg = state.failNextProductsUpsertError;
              state.failNextProductsUpsertError = null;
              return Promise.resolve({ error: { message: errMsg } });
            }
            state.productMutations++;
            for (const it of items) {
              const prev = state.products.get(it.product_id);
              const nextRow = {
                is_test: false,
                ...prev,
                ...it,
                row_seq:
                  it.row_seq ?? prev?.row_seq ?? state.products.size + 1,
              };
              nextRow.search_text = [
                nextRow.product_name,
                nextRow.translated_title,
                nextRow.product_id,
                nextRow.brand,
                nextRow.auction_item_number,
              ]
                .join(" ")
                .toLowerCase();
              state.products.set(it.product_id, nextRow);
            }
          } else if (table === "product_images") {
            for (const it of items) {
              const idx = state.product_images.findIndex(
                (x) =>
                  x.product_id === it.product_id && x.file_id === it.file_id
              );
              if (idx >= 0) state.product_images[idx] = it;
              else state.product_images.push(it);
            }
          } else if (table === "product_translations") {
            state.translationMutations++;
            for (const it of items) {
              const idx = state.product_translations.findIndex(
                (x) =>
                  x.product_id === it.product_id && x.locale === it.locale
              );
              if (idx >= 0) state.product_translations[idx] = it;
              else state.product_translations.push(it);
            }
          } else if (table === "pokemon_cards") {
            for (const it of items) {
              const idx = state.pokemon_cards.findIndex(
                (x) => x.product_id === it.product_id
              );
              if (idx >= 0) state.pokemon_cards[idx] = it;
              else state.pokemon_cards.push(it);
            }
          } else if (table === "product_write_idempotency") {
            for (const it of items) {
              const idx = state.product_write_idempotency.findIndex(
                (x) => x.request_id === it.request_id
              );
              if (idx >= 0) state.product_write_idempotency[idx] = it;
              else state.product_write_idempotency.push(it);
            }
          } else if (table === "product_import_attempts") {
            for (const it of items) {
              const idx = state.product_import_attempts.findIndex(
                (x) => x.attempt_id === it.attempt_id
              );
              if (idx >= 0) state.product_import_attempts[idx] = it;
              else state.product_import_attempts.push(it);
            }
          }
          return Promise.resolve({ error: null });
        },
        delete() {
          const delFilters = [];
          const delBuilder = {
            eq(col, val) {
              delFilters.push((r) => r[col] === val);
              return delBuilder;
            },
            in(col, vals) {
              const set = new Set(vals);
              delFilters.push((r) => set.has(r[col]));
              return delBuilder;
            },
            then(resolve, reject) {
              if (table === "products") {
                for (const [k, row] of state.products.entries()) {
                  if (delFilters.every((fn) => fn(row))) {
                    state.products.delete(k);
                  }
                }
              } else {
                state[table] = (state[table] || []).filter(
                  (r) => !delFilters.every((fn) => fn(r))
                );
              }
              return Promise.resolve({ error: null }).then(resolve, reject);
            },
          };
          return delBuilder;
        },
      };

      return builder;
    },
  };
}

test("Phase 2 Unit 1: POST /products creates non-Square draft in Supabase, handles Sheets ID collision & client_request_id idempotency", async () => {
  const mockSupabase = createWriteMockSupabase([], 163);
  const gasCalls = [];
  let simulateCollisionOn164 = true;

  const mockFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    gasCalls.push(body);
    if (body.action === "mirror_created_draft_product") {
      if (simulateCollisionOn164 && body.reserved_product_id === "TMP-000164") {
        simulateCollisionOn164 = false;
        return new Response(
          JSON.stringify({
            success: false,
            error_code: "PRODUCT_ID_ALREADY_IN_SHEETS",
            max_sheet_sequence: 170,
          }),
          { status: 200 }
        );
      }
      const pid = body.reserved_product_id;
      return new Response(
        JSON.stringify({
          success: true,
          product_id: pid,
          created_at: "2026-11-02T06:30:00.000Z",
          drive_folder_id: `FOLDER_${pid}`,
          drive_folder_url: `https://drive.google.com/drive/folders/FOLDER_${pid}`,
          main_image_url: `https://drive.google.com/file/d/FILE_1_${pid}/view`,
          images: [
            {
              file_id: `FILE_1_${pid}`,
              name: "01_main_dunk.jpg",
              mime_type: "image/jpeg",
              view_url: `https://drive.google.com/file/d/FILE_1_${pid}/view`,
              display_url: `https://drive.google.com/thumbnail?id=FILE_1_${pid}&sz=w1600`,
            },
            {
              file_id: `FILE_2_${pid}`,
              name: "02_side.jpg",
              mime_type: "image/jpeg",
              view_url: `https://drive.google.com/file/d/FILE_2_${pid}/view`,
              display_url: `https://drive.google.com/thumbnail?id=FILE_2_${pid}&sz=w1600`,
            },
          ],
        }),
        { status: 200 }
      );
    }
    if (body.action === "save_product_ai_selected_images") {
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    throw new Error(`Unexpected GAS call: ${body.action}`);
  };

  const server = http.createServer(
    createProductsApiHandler({
      getSupabase: () => mockSupabase,
      fetchImpl: mockFetch,
      gasWebAppUrl: "https://gas.example.com/exec",
      internalSecret: "test-write-secret",
    })
  );
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const writeHeaders = {
    "Content-Type": "application/json",
    "X-Internal-Sync-Token": "test-write-secret",
  };

  try {
    // 1. Rejects published creation on draft endpoint
    const pubReject = await fetch(`${base}/products`, {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify({
        publish_status: "published",
        category: "sneaker",
        images: [{ file_name: "a.jpg", base64: TINY_JPEG_B64 }],
      }),
    });
    assert.equal(pubReject.status, 400);
    const pubRejectJson = await pubReject.json();
    assert.equal(pubRejectJson.error_code, "DRAFT_ONLY_ENDPOINT");

    // 2. Rejects invalid pokemon_card before allocating ID or calling GAS
    const pkmReject = await fetch(`${base}/products`, {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify({
        category: "pokemon_card",
        images: [{ file_name: "a.jpg", base64: TINY_JPEG_B64 }],
        pokemon_card: {
          card_name: "Pikachu",
          language: "JA",
          grading_status: "graded",
          grader: "", // missing grader!
        },
      }),
    });
    assert.equal(pkmReject.status, 400);
    assert.equal(gasCalls.length, 0);

    // 3. Valid draft creation recovers from TMP-000164 collision -> allocates TMP-000171
    const createPayload = {
      client_request_id: "req-draft-001",
      category: "sneaker",
      brand: "Nike",
      product_name: "Nike Dunk Low Retro White/Black",
      condition: "目立った傷や汚れなし",
      purchase_price: 9000,
      planned_sale_price: 18500,
      storage_location: "B-12",
      sneaker_sku: "DD1391-100",
      sneaker_size: "27.5cm",
      auction_item_number: "00842-01",
      selected_image_indexes: [0, 1],
      images: [
        { file_name: "main.jpg", mime_type: "image/jpeg", base64: TINY_JPEG_B64 },
        { file_name: "side.jpg", mime_type: "image/jpeg", base64: TINY_JPEG_B64 },
      ],
    };

    const createRes = await fetch(`${base}/products`, {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify(createPayload),
    });
    assert.equal(createRes.status, 200);
    const createJson = await createRes.json();
    assert.equal(createJson.success, true);
    assert.equal(createJson.write_master, "supabase");
    assert.equal(createJson.product_id, "TMP-000171");
    assert.equal(createJson.auction_item_number, "00842-01");
    assert.deepEqual(createJson.selected_image_ids, [
      "FILE_1_TMP-000171",
      "FILE_2_TMP-000171",
    ]);

    const savedRow = mockSupabase.state.products.get("TMP-000171");
    assert.equal(savedRow.write_source, "supabase");
    assert.equal(savedRow.sheets_mirror_pending, false);
    assert.equal(savedRow.auction_item_number, "00842-01");
    assert.equal(savedRow.publish_status, "draft");

    // 4. Idempotent retry with same client_request_id returns cached result without calling GAS again
    const gasCountBeforeRetry = gasCalls.length;
    const retryRes = await fetch(`${base}/products`, {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify(createPayload),
    });
    assert.equal(retryRes.status, 200);
    const retryJson = await retryRes.json();
    assert.equal(retryJson.product_id, "TMP-000171");
    assert.equal(retryJson.is_reused, true);
    assert.equal(gasCalls.length, gasCountBeforeRetry);

    // 5. Different payload with same client_request_id -> 409 IDEMPOTENCY_PAYLOAD_MISMATCH
    const mismatchRes = await fetch(`${base}/products`, {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify({ ...createPayload, planned_sale_price: 99999 }),
    });
    assert.equal(mismatchRes.status, 409);
  } finally {
    server.close();
  }
});

test("Phase 2 Unit 1: POST /products/:id/update enforces atomic pre-validation, category guards, and protects pending Sheets mirrors during reconcile", async () => {
  const initialBundles = [
    mapGasProductToSupabaseBundle({
      rowSeq: 1,
      summary: {
        product_id: "TMP-000201",
        category: "apparel",
        brand: "Supreme",
        product_name: "Supreme Box Logo Hoodie",
        translated_title: "Original En Title",
        planned_sale_price: 45000,
        auction_item_number: "00555-09",
        publish_status: "draft",
        inventory_status: "in_stock",
        record_status: "active",
      },
      detail: {
        product_id: "TMP-000201",
        category: "apparel",
        brand: "Supreme",
        product_name: "Supreme Box Logo Hoodie",
        purchase_price: 25000,
        planned_sale_price: 45000,
        subcategory: "Hoodie",
        size: "L",
        auction_item_number: "00555-09",
        publish_status: "draft",
        inventory_status: "in_stock",
        record_status: "active",
        images: [
          { file_id: "APP_IMG_1", name: "01_main.jpg" },
          { file_id: "APP_IMG_2", name: "02_back.jpg" },
        ],
        translation: {
          locale: "en",
          translated_title: "Original En Title",
          translated_description: "Keep This Description Intact",
          translation_status: "approved",
        },
      },
    }),
    mapGasProductToSupabaseBundle({
      rowSeq: 2,
      summary: {
        product_id: "TMP-000202",
        category: "sneaker",
        brand: "Jordan",
        product_name: "Air Jordan 1 High",
        planned_sale_price: 30000,
        publish_status: "published",
        inventory_status: "in_stock",
        record_status: "active",
        square_item_id: "SQ_202",
        square_variation_id: "SQ_VAR_202",
      },
      detail: {
        product_id: "TMP-000202",
        category: "sneaker",
        brand: "Jordan",
        product_name: "Air Jordan 1 High",
        planned_sale_price: 30000,
        publish_status: "published",
        inventory_status: "in_stock",
        record_status: "active",
        square_item_id: "SQ_202",
        square_variation_id: "SQ_VAR_202",
        images: [],
      },
    }),
  ];

  const mockSupabase = createWriteMockSupabase(initialBundles, 202);
  let gasMirrorAvailable = false; // Start with GAS down to test pending-mirror protection!
  const gasSheetsMirrorState = {
    "TMP-000201": {
      product_id: "TMP-000201",
      category: "apparel",
      brand: "Supreme",
      product_name: "Supreme Box Logo Hoodie",
      translated_title: "Original En Title",
      purchase_price: 25000,
      planned_sale_price: 45000,
      subcategory: "Hoodie",
      size: "L",
      auction_item_number: "00555-09",
      publish_status: "draft",
      inventory_status: "in_stock",
      record_status: "active",
    },
    "TMP-000202": {
      product_id: "TMP-000202",
      category: "sneaker",
      brand: "Jordan",
      product_name: "Air Jordan 1 High",
      planned_sale_price: 30000,
      publish_status: "published",
      inventory_status: "in_stock",
      record_status: "active",
      square_item_id: "SQ_202",
      square_variation_id: "SQ_VAR_202",
    },
  };

  const mockFetch = async (url, init = {}) => {
    if (init.method === "POST") {
      if (!gasMirrorAvailable) {
        return new Response("GAS transiently unavailable", { status: 503 });
      }
      const body = JSON.parse(init.body);
      if (body.action === "update_product") {
        const cur = gasSheetsMirrorState[body.product_id];
        Object.assign(cur, {
          brand: body.brand ?? cur.brand,
          product_name: body.product_name ?? cur.product_name,
          translated_title: body.translated_title ?? cur.translated_title,
          planned_sale_price:
            body.planned_sale_price === ""
              ? 0
              : Number(body.planned_sale_price ?? cur.planned_sale_price),
          size: body.size ?? cur.size,
          auction_item_number:
            body.auction_item_number ?? cur.auction_item_number,
        });
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
    }
    const u = new URL(url);
    if (u.searchParams.get("record_status") === "all") {
      return new Response(
        JSON.stringify({
          success: true,
          products: [
            gasSheetsMirrorState["TMP-000202"],
            gasSheetsMirrorState["TMP-000201"],
          ],
        }),
        { status: 200 }
      );
    }
    const pid = u.searchParams.get("product_id");
    return new Response(
      JSON.stringify({
        success: true,
        product: { ...gasSheetsMirrorState[pid], images: [] },
      }),
      { status: 200 }
    );
  };

  const server = http.createServer(
    createProductsApiHandler({
      getSupabase: () => mockSupabase,
      fetchImpl: mockFetch,
      gasWebAppUrl: "https://gas.example.com/exec",
      internalSecret: "sync-secret",
    })
  );
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const writeHeaders = {
    "Content-Type": "application/json",
    "X-Internal-Sync-Token": "sync-secret",
  };

  try {
    // 1. Atomic pre-validation: valid translated_title + invalid negative planned_sale_price -> 0 DB mutations!
    const mutBefore = mockSupabase.state.productMutations;
    const transMutBefore = mockSupabase.state.translationMutations;

    const badPriceRes = await fetch(`${base}/products/TMP-000201/update`, {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify({
        translated_title: "Should Not Be Saved",
        planned_sale_price: -500,
      }),
    });
    assert.equal(badPriceRes.status, 400);
    const badPriceJson = await badPriceRes.json();
    assert.equal(badPriceJson.error_code, "INVALID_PLANNED_SALE_PRICE");
    assert.equal(mockSupabase.state.productMutations, mutBefore);
    assert.equal(mockSupabase.state.translationMutations, transMutBefore);
    assert.equal(
      mockSupabase.state.products.get("TMP-000201").translated_title,
      "Original En Title"
    );

    // 2. Category immutability -> 400 CATEGORY_IMMUTABLE
    const catChangeRes = await fetch(`${base}/products/TMP-000201/update`, {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify({ category: "sneaker" }),
    });
    assert.equal(catChangeRes.status, 400);
    assert.equal((await catChangeRes.json()).error_code, "CATEGORY_IMMUTABLE");

    // 3. Published / Square-linked item -> 409 blocked
    const pubUpdateRes = await fetch(`${base}/products/TMP-000202/update`, {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify({ planned_sale_price: 32000 }),
    });
    assert.equal(pubUpdateRes.status, 409);

    // 4. Valid draft update while GAS mirror is down:
    //    - Saves immediately to Supabase (`sheets_mirror_pending: true`)
    //    - Preserves omitted `auction_item_number` ("00555-09")
    //    - Preserves `translated_description` in `product_translations`
    //    - Ignores `sneaker_size` on `apparel` product
    const okUpdateRes = await fetch(`${base}/products/TMP-000201/update`, {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify({
        product_name: "Supreme Box Logo Hoodie Updated",
        translated_title: "Updated Supreme Box Logo Hoodie XL",
        planned_sale_price: 49800,
        size: "XL",
        sneaker_size: "29cm", // should be ignored for apparel!
        selected_image_ids: ["APP_IMG_2"],
      }),
    });
    assert.equal(okUpdateRes.status, 200);
    const okUpdateJson = await okUpdateRes.json();
    assert.equal(okUpdateJson.write_master, "supabase");
    assert.equal(okUpdateJson.sheets_mirrored, false);

    const rowAfterUpdate = mockSupabase.state.products.get("TMP-000201");
    assert.equal(rowAfterUpdate.product_name, "Supreme Box Logo Hoodie Updated");
    assert.equal(rowAfterUpdate.planned_sale_price, 49800);
    assert.equal(rowAfterUpdate.size, "XL");
    assert.equal(rowAfterUpdate.sneaker_size, ""); // ignored!
    assert.equal(rowAfterUpdate.auction_item_number, "00555-09"); // preserved!
    assert.equal(rowAfterUpdate.sheets_mirror_pending, true);
    assert.equal(
      mockSupabase.state.product_translations[0].translated_description,
      "Keep This Description Intact"
    );

    // 5. While GAS mirror is still down, scheduled /reconcile MUST NOT overwrite TMP-000201 with stale Sheets!
    const recWhileGasDown = await fetch(`${base}/reconcile?rolling=0`, {
      method: "POST",
      headers: { "X-Internal-Sync-Token": "sync-secret" },
    });
    assert.equal(recWhileGasDown.status, 200);
    const recDownJson = await recWhileGasDown.json();
    assert.equal(recDownJson.protected_pending_count, 1);
    assert.equal(
      mockSupabase.state.products.get("TMP-000201").planned_sale_price,
      49800
    );

    // 6. Once GAS mirror recovers, /reconcile flushes Supabase -> Sheets FIRST, clearing pending flag with 0 clobber!
    gasMirrorAvailable = true;
    const recAfterRecover = await fetch(`${base}/reconcile?rolling=0`, {
      method: "POST",
      headers: { "X-Internal-Sync-Token": "sync-secret" },
    });
    assert.equal(recAfterRecover.status, 200);
    const recRecoverJson = await recAfterRecover.json();
    assert.equal(recRecoverJson.flushed_pending_count, 1);
    assert.equal(
      gasSheetsMirrorState["TMP-000201"].planned_sale_price,
      49800
    );
    assert.equal(
      mockSupabase.state.products.get("TMP-000201").sheets_mirror_pending,
      false
    );
  } finally {
    server.close();
  }
});

test("Review Fix 1: POST /products recovers the exact same TMP-XXXXXX without duplicate Drive/Sheets/DB creation when Supabase save fails after GAS mirror", async () => {
  const mockSupabase = createWriteMockSupabase([], 164);
  const gasCreatedSheetsRows = new Map(); // pid -> { requestId, createdCount }
  let mirrorCalls = 0;

  const mockFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.action === "mirror_created_draft_product") {
      mirrorCalls++;
      const pid = body.reserved_product_id;
      const reqId = body.request_id;
      const existing = gasCreatedSheetsRows.get(pid);
      if (existing) {
        if (existing.requestId === reqId) {
          return new Response(
            JSON.stringify({
              success: true,
              is_reused: true,
              product_id: pid,
              created_at: "2026-11-02T07:10:00.000Z",
              drive_folder_url: `https://drive.google.com/drive/folders/FOLDER_${pid}`,
              main_image_url: `https://drive.google.com/file/d/FILE_1_${pid}/view`,
              images: [
                {
                  file_id: `FILE_1_${pid}`,
                  name: "01_main.jpg",
                  mime_type: "image/jpeg",
                  view_url: `https://drive.google.com/file/d/FILE_1_${pid}/view`,
                  display_url: `https://drive.google.com/thumbnail?id=FILE_1_${pid}&sz=w1600`,
                },
              ],
            }),
            { status: 200 }
          );
        }
        return new Response(
          JSON.stringify({
            success: false,
            error_code: "PRODUCT_ID_ALREADY_IN_SHEETS",
            max_sheet_sequence: 165,
          }),
          { status: 200 }
        );
      }
      gasCreatedSheetsRows.set(pid, { requestId: reqId, createdCount: 1 });
      return new Response(
        JSON.stringify({
          success: true,
          product_id: pid,
          created_at: "2026-11-02T07:10:00.000Z",
          drive_folder_url: `https://drive.google.com/drive/folders/FOLDER_${pid}`,
          main_image_url: `https://drive.google.com/file/d/FILE_1_${pid}/view`,
          images: [
            {
              file_id: `FILE_1_${pid}`,
              name: "01_main.jpg",
              mime_type: "image/jpeg",
              view_url: `https://drive.google.com/file/d/FILE_1_${pid}/view`,
              display_url: `https://drive.google.com/thumbnail?id=FILE_1_${pid}&sz=w1600`,
            },
          ],
        }),
        { status: 200 }
      );
    }
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  };

  const server = http.createServer(
    createProductsApiHandler({
      getSupabase: () => mockSupabase,
      fetchImpl: mockFetch,
      gasWebAppUrl: "https://gas.example.com/exec",
      internalSecret: "test-write-secret",
    })
  );
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const writeHeaders = {
    "Content-Type": "application/json",
    "X-Internal-Sync-Token": "test-write-secret",
  };

  try {
    // Scenario A: GAS mirror succeeds -> mirror_completed saved -> Supabase products.upsert fails (500)
    const payloadA = {
      client_request_id: "req-partial-fail-a",
      category: "sneaker",
      brand: "New Balance",
      product_name: "New Balance 990v6 Gray",
      planned_sale_price: 29800,
      images: [{ file_name: "nb.jpg", mime_type: "image/jpeg", base64: TINY_JPEG_B64 }],
    };

    mockSupabase.state.failNextProductsUpsertError =
      "Simulated Supabase DB connection drop during products upsert";

    const firstAttemptA = await fetch(`${base}/products`, {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify(payloadA),
    });
    assert.equal(firstAttemptA.status, 500);
    assert.equal(gasCreatedSheetsRows.size, 1);
    assert.equal(gasCreatedSheetsRows.has("TMP-000165"), true);
    assert.equal(mockSupabase.state.products.size, 0); // Not yet in Supabase products!
    assert.equal(mirrorCalls, 1);

    // Retry with same client_request_id -> recovers TMP-000165 WITHOUT calling GAS again or creating TMP-000166!
    const retryAttemptA = await fetch(`${base}/products`, {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify(payloadA),
    });
    assert.equal(retryAttemptA.status, 200);
    const retryJsonA = await retryAttemptA.json();
    assert.equal(retryJsonA.success, true);
    assert.equal(retryJsonA.product_id, "TMP-000165");
    assert.equal(retryJsonA.is_reused, true);
    assert.equal(retryJsonA.recovered, true);
    assert.equal(mirrorCalls, 1); // GAS was NOT called a second time because mirror_completed cached mirror_json!
    assert.equal(gasCreatedSheetsRows.size, 1);
    assert.equal(mockSupabase.state.products.size, 1);
    assert.equal(
      mockSupabase.state.products.get("TMP-000165").product_name,
      "New Balance 990v6 Gray"
    );

    // Scenario B: Total Supabase write outage immediately after GAS mirror succeeded
    // (BOTH `mirror_completed` checkpoint update AND `products.upsert` fail!)
    const payloadB = {
      client_request_id: "req-partial-fail-b",
      category: "apparel",
      brand: "Stussy",
      product_name: "Stussy 8 Ball Tee",
      planned_sale_price: 12000,
      images: [{ file_name: "stussy.jpg", mime_type: "image/jpeg", base64: TINY_JPEG_B64 }],
    };

    mockSupabase.state.failIdempotencyUpdates = true;
    mockSupabase.state.failNextProductsUpsertError =
      "Simulated total Supabase outage right after GAS mirror";

    const firstAttemptB = await fetch(`${base}/products`, {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify(payloadB),
    });
    assert.equal(firstAttemptB.status, 500);
    assert.equal(gasCreatedSheetsRows.size, 2);
    assert.equal(gasCreatedSheetsRows.has("TMP-000166"), true);
    assert.equal(mockSupabase.state.products.has("TMP-000166"), false);

    // Supabase recovers; client retries same client_request_id:
    // Reuses reserved `in_progress` TMP-000166 -> hits GAS `request_id` idempotency -> saves TMP-000166 in Supabase!
    mockSupabase.state.failIdempotencyUpdates = false;
    const retryAttemptB = await fetch(`${base}/products`, {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify(payloadB),
    });
    assert.equal(retryAttemptB.status, 200);
    const retryJsonB = await retryAttemptB.json();
    assert.equal(retryJsonB.success, true);
    assert.equal(retryJsonB.product_id, "TMP-000166");
    assert.equal(retryJsonB.is_reused, true);
    assert.equal(retryJsonB.recovered, true);
    assert.equal(gasCreatedSheetsRows.size, 2); // Still 2! No TMP-000167 created!
    assert.equal(mockSupabase.state.products.size, 2);
    assert.equal(
      mockSupabase.state.products.get("TMP-000166").product_name,
      "Stussy 8 Ball Tee"
    );
  } finally {
    server.close();
  }
});

test("Review Fix 2: Write endpoints reject URL-only / unauthorized third-party requests while allowing verified Readdy Backend credentials", async () => {
  const initialBundle = mapGasProductToSupabaseBundle({
    rowSeq: 1,
    summary: {
      product_id: "TMP-000301",
      category: "sneaker",
      brand: "Adidas",
      product_name: "Adidas Samba OG",
      planned_sale_price: 15400,
      publish_status: "draft",
      inventory_status: "in_stock",
      record_status: "active",
    },
    detail: {
      product_id: "TMP-000301",
      category: "sneaker",
      brand: "Adidas",
      product_name: "Adidas Samba OG",
      planned_sale_price: 15400,
      publish_status: "draft",
      inventory_status: "in_stock",
      record_status: "active",
      images: [],
    },
  });

  const mockSupabase = createWriteMockSupabase([initialBundle], 301);
  let readdyAuthVerifyCalls = 0;
  let gasCalls = 0;

  const mockFetch = async (url, init = {}) => {
    if (String(url).startsWith("https://readdy-backend.example.com/auth/v1/settings")) {
      readdyAuthVerifyCalls++;
      const auth = init.headers?.Authorization || init.headers?.authorization || "";
      if (auth === "Bearer sb_publishable_valid_readdy_client_key") {
        return new Response(
          JSON.stringify({ external: { anonymous_users: false } }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ message: "Invalid API key" }), {
        status: 401,
      });
    }
    gasCalls++;
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  };

  const server = http.createServer(
    createProductsApiHandler({
      getSupabase: () => mockSupabase,
      fetchImpl: mockFetch,
      gasWebAppUrl: "https://gas.example.com/exec",
      internalSecret: "server-internal-secret",
      readdyBackendUrl: "https://readdy-backend.example.com",
      allowedOrigins: ["https://bis-ec.readdy.ai"],
    })
  );
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    // 1. Third party knowing ONLY the Cloud Run URL (no credentials) -> 401 on all write routes
    const unauthCreate = await fetch(`${base}/products`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        category: "sneaker",
        images: [{ file_name: "a.jpg", base64: TINY_JPEG_B64 }],
      }),
    });
    assert.equal(unauthCreate.status, 401);

    const unauthUpdate = await fetch(`${base}/products/TMP-000301/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planned_sale_price: 100 }),
    });
    assert.equal(unauthUpdate.status, 401);

    const unauthPatch = await fetch(`${base}/products/TMP-000301`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planned_sale_price: 100 }),
    });
    assert.equal(unauthPatch.status, 401);

    const unauthRootPost = await fetch(`${base}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "update_product",
        product_id: "TMP-000301",
        planned_sale_price: 100,
      }),
    });
    assert.equal(unauthRootPost.status, 401);

    // 2. Invalid token -> 401
    const fakeTokenRes = await fetch(`${base}/products/TMP-000301/update`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer forged-random-token",
      },
      body: JSON.stringify({ planned_sale_price: 100 }),
    });
    assert.equal(fakeTokenRes.status, 401);

    // 3. Disallowed browser Origin -> 403 even before token verification
    const evilOriginRes = await fetch(`${base}/products/TMP-000301/update`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://evil.example.org",
        Authorization: "Bearer sb_publishable_valid_readdy_client_key",
      },
      body: JSON.stringify({ planned_sale_price: 100 }),
    });
    assert.equal(evilOriginRes.status, 403);

    // Confirm 0 mutations and 0 GAS calls occurred from all unauthorized attempts
    assert.equal(
      mockSupabase.state.products.get("TMP-000301").planned_sale_price,
      15400
    );
    assert.equal(gasCalls, 0);

    // 4. Authorized frontend write with Readdy Backend credential -> 200 OK & caches verification
    const verifyCallsBeforeValid = readdyAuthVerifyCalls;
    const validUpdate1 = await fetch(`${base}/products/TMP-000301/update`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://bis-ec.readdy.ai",
        apikey: "sb_publishable_valid_readdy_client_key",
        Authorization: "Bearer sb_publishable_valid_readdy_client_key",
      },
      body: JSON.stringify({ planned_sale_price: 16800 }),
    });
    assert.equal(validUpdate1.status, 200);
    assert.equal(readdyAuthVerifyCalls, verifyCallsBeforeValid + 1);
    assert.equal(
      mockSupabase.state.products.get("TMP-000301").planned_sale_price,
      16800
    );

    const validUpdate2 = await fetch(`${base}/products/TMP-000301/update`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://bis-ec.readdy.ai",
        apikey: "sb_publishable_valid_readdy_client_key",
        Authorization: "Bearer sb_publishable_valid_readdy_client_key",
      },
      body: JSON.stringify({ planned_sale_price: 17200 }),
    });
    assert.equal(validUpdate2.status, 200);
    assert.equal(readdyAuthVerifyCalls, verifyCallsBeforeValid + 1); // Served from in-memory cache (0 extra roundtrips!)
    assert.equal(
      mockSupabase.state.products.get("TMP-000301").planned_sale_price,
      17200
    );

    // 5. Read endpoints continue working without friction
    const adminRead = await fetch(`${base}/?mode=admin&product_id=TMP-000301`);
    assert.equal(adminRead.status, 200);
  } finally {
    server.close();
  }
});

test("Phase 2 Unit 2: POST /products/import enforces import_attempt_id idempotency, fingerprint mismatch rejection, and mid-flight failure recovery", async () => {
  const mockSupabase = createWriteMockSupabase([], 164);
  const gasCalls = [];
  let simulateCollisionOn165 = true;

  const TINY_PNG_B64 =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

  const mockFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    gasCalls.push(body);
    if (body.action === "import_product_by_images") {
      if (simulateCollisionOn165 && body.reserved_product_id === "TMP-000165") {
        simulateCollisionOn165 = false;
        return new Response(
          JSON.stringify({
            success: false,
            error_code: "PRODUCT_ID_ALREADY_IN_SHEETS",
            max_sheet_sequence: 165,
            message: "reserved_product_id already exists in Google Sheets",
            import_attempt_id: body.import_attempt_id,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      const pid = body.reserved_product_id;
      const imagesMeta = (body.images || []).map((img, i) => {
        const fid = `DRV_IMP_${pid}_${i + 1}`;
        const name =
          i === 0
            ? `01_main_${img.file_name}`
            : `${String(i + 1).padStart(2, "0")}_${img.file_name}`;
        return {
          file_id: fid,
          name,
          mime_type: img.mime_type,
          view_url: `https://drive.google.com/file/d/${fid}/view`,
          display_url: `https://drive.google.com/thumbnail?id=${fid}&sz=w1600`,
        };
      });

      return new Response(
        JSON.stringify({
          success: true,
          version: "product-import-v1",
          import_attempt_id: body.import_attempt_id,
          product_id: pid,
          is_reused: false,
          status: "completed",
          publish_status: "draft",
          inventory_status: "in_stock",
          record_status: "active",
          drive_folder_id: `FLD_${pid}`,
          drive_folder_url: `https://drive.google.com/drive/folders/FLD_${pid}`,
          main_image_url: imagesMeta[0]?.view_url || "",
          image_count: imagesMeta.length,
          images: imagesMeta,
          auction_item_number: body.auction_item_number || "",
          created_at: "2026-11-02T08:00:00.000Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    throw new Error(`Unexpected GAS call: ${url}`);
  };

  const handler = createProductsApiHandler({
    getSupabase: () => mockSupabase,
    fetchImpl: mockFetch,
    gasWebAppUrl: "https://script.google.com/macros/s/MOCK/exec",
    internalSecret: "test-import-secret",
  });

  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const writeHeaders = {
    "Content-Type": "application/json",
    "X-Internal-Sync-Token": "test-import-secret",
  };

  try {
    // 1. Unauthorized import rejected with 401
    const unauthRes = await fetch(`${base}/products/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        import_attempt_id: "IMP_UNAUTH",
        images: [{ file_name: "a.jpg", mime_type: "image/jpeg", base64: TINY_JPEG_B64 }],
      }),
    });
    assert.equal(unauthRes.status, 401);
    assert.equal(gasCalls.length, 0);

    // 2. Normal multi-image import (with Sheets TMP-000165 collision -> reallocates TMP-000166, forces draft)
    const impPayload1 = {
      import_attempt_id: "IMP_20261102_001",
      publish_status: "published", // Must be ignored and forced to draft
      auction_item_number: "00842-01",
      images: [
        { file_name: "front.jpg", mime_type: "image/jpeg", base64: TINY_JPEG_B64 },
        { file_name: "back.png", mime_type: "image/png", base64: TINY_PNG_B64 },
      ],
    };

    const res1 = await fetch(`${base}/products/import`, {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify(impPayload1),
    });
    assert.equal(res1.status, 200);
    const json1 = await res1.json();
    assert.equal(json1.success, true);
    assert.equal(json1.version, "product-import-v1");
    assert.equal(json1.product_id, "TMP-000166");
    assert.equal(json1.is_reused, false);
    assert.equal(json1.publish_status, "draft");
    assert.equal(json1.image_count, 2);
    assert.equal(json1.auction_item_number, "00842-01");
    assert.equal(gasCalls.length, 2); // 165 collision + 166 success

    // Verify detail read returns exact 2 images in sort_order
    const det1 = await (
      await fetch(`${base}/?mode=admin&product_id=TMP-000166`)
    ).json();
    assert.equal(det1.success, true);
    assert.equal(det1.product.images.length, 2);
    assert.equal(det1.product.images[0].name, "01_main_front.jpg");
    assert.equal(det1.product.images[1].name, "02_back.png");

    // 3. Same import_attempt_id + same payload -> is_reused: true, 0 extra GAS calls, 0 duplicate rows
    const res1Replay = await fetch(`${base}/products/import`, {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify(impPayload1),
    });
    const json1Replay = await res1Replay.json();
    assert.equal(json1Replay.success, true);
    assert.equal(json1Replay.product_id, "TMP-000166");
    assert.equal(json1Replay.is_reused, true);
    assert.equal(gasCalls.length, 2);
    assert.equal(mockSupabase.state.products.size, 1);

    // 4. Same import_attempt_id + swapped image order -> IMPORT_IDEMPOTENCY_PAYLOAD_MISMATCH
    const resMismatch = await fetch(`${base}/products/import`, {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify({
        ...impPayload1,
        images: [impPayload1.images[1], impPayload1.images[0]],
      }),
    });
    const jsonMismatch = await resMismatch.json();
    assert.equal(jsonMismatch.success, false);
    assert.equal(
      jsonMismatch.error_code,
      "IMPORT_IDEMPOTENCY_PAYLOAD_MISMATCH"
    );
    assert.equal(gasCalls.length, 2);

    // 5. Mid-flight failure: Drive/Sheets succeeds (TMP-000167), Supabase products.upsert fails (500),
    //    then retry with same import_attempt_id recovers TMP-000167 with 0 duplicate Drive uploads!
    mockSupabase.state.failNextProductsUpsertError =
      "Simulated Supabase DB outage after Drive upload";

    const midFlightPayload = {
      import_attempt_id: "IMP_20261102_MIDFLIGHT",
      auction_item_number: "09-777",
      images: [
        { file_name: "one.jpg", mime_type: "image/jpeg", base64: TINY_JPEG_B64 },
        { file_name: "two.png", mime_type: "image/png", base64: TINY_PNG_B64 },
      ],
    };

    const failRes = await fetch(`${base}/products/import`, {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify(midFlightPayload),
    });
    assert.equal(failRes.status, 500);
    assert.equal(gasCalls.length, 3); // 1 Drive upload happened for TMP-000167
    assert.equal(mockSupabase.state.products.has("TMP-000167"), false);

    // Retry with same import_attempt_id -> recovers TMP-000167 without calling GAS again!
    const recoverRes = await fetch(`${base}/products/import`, {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify(midFlightPayload),
    });
    assert.equal(recoverRes.status, 200);
    const recoverJson = await recoverRes.json();
    assert.equal(recoverJson.success, true);
    assert.equal(recoverJson.product_id, "TMP-000167");
    assert.equal(recoverJson.is_reused, true);
    assert.equal(gasCalls.length, 3); // ZERO second Drive upload!
    assert.equal(mockSupabase.state.products.size, 2);
  } finally {
    server.close();
  }
});

test("Phase 2 Unit 2: POST /products/:productId/images handles reorder, add, delete, 0-image clear, and selected_image_ids rules", async () => {
  const initialBundle = mapGasProductToSupabaseBundle({
    summary: {
      product_id: "TMP-000401",
      row_seq: 10,
      created_at: "2026-11-02T08:00:00.000Z",
      category: "sneaker",
      brand: "Nike",
      product_name: "Image Edit Target",
      planned_sale_price: 20000,
      publish_status: "draft",
      inventory_status: "in_stock",
      record_status: "active",
      drive_folder_url: "https://drive.google.com/drive/folders/FLD_401",
      main_image_url: "https://drive.google.com/file/d/FILE_A/view",
      selected_image_ids: ["FILE_A"],
    },
    detail: {
      product_id: "TMP-000401",
      images: [
        {
          file_id: "FILE_A",
          name: "01_main_a.jpg",
          mime_type: "image/jpeg",
          view_url: "https://drive.google.com/file/d/FILE_A/view",
          display_url: "https://drive.google.com/thumbnail?id=FILE_A&sz=w1600",
        },
        {
          file_id: "FILE_B",
          name: "02_b.jpg",
          mime_type: "image/jpeg",
          view_url: "https://drive.google.com/file/d/FILE_B/view",
          display_url: "https://drive.google.com/thumbnail?id=FILE_B&sz=w1600",
        },
      ],
    },
  });

  const mockSupabase = createWriteMockSupabase([initialBundle], 401);
  const driveFiles = new Map([
    [
      "FILE_A",
      { file_id: "FILE_A", baseName: "a.jpg", mime_type: "image/jpeg" },
    ],
    [
      "FILE_B",
      { file_id: "FILE_B", baseName: "b.jpg", mime_type: "image/jpeg" },
    ],
  ]);
  let uploadedCounter = 0;
  let gasImageCalls = 0;

  const mockFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.action === "update_product_images") {
      gasImageCalls++;
      const uploadedByClientId = new Map();
      for (const n of body.new_images || []) {
        uploadedCounter++;
        const fid = `FILE_NEW_${uploadedCounter}`;
        const entry = {
          file_id: fid,
          baseName: n.file_name,
          mime_type: n.mime_type,
        };
        driveFiles.set(fid, entry);
        uploadedByClientId.set(n.client_id, entry);
      }

      const ordered = body.image_order.map((item, idx) => {
        const meta =
          item.source === "existing"
            ? driveFiles.get(item.id)
            : uploadedByClientId.get(item.id);
        const name =
          idx === 0
            ? `01_main_${meta.baseName}`
            : `${String(idx + 1).padStart(2, "0")}_${meta.baseName}`;
        return {
          file_id: meta.file_id,
          name,
          mime_type: meta.mime_type,
          view_url: `https://drive.google.com/file/d/${meta.file_id}/view`,
          display_url: `https://drive.google.com/thumbnail?id=${meta.file_id}&sz=w1600`,
        };
      });

      const keptIds = new Set(ordered.map((o) => o.file_id));
      for (const k of Array.from(driveFiles.keys())) {
        if (!keptIds.has(k)) driveFiles.delete(k);
      }

      return new Response(
        JSON.stringify({
          success: true,
          version: "product-images-update-v2",
          product_id: body.product_id,
          image_count: ordered.length,
          main_image_url: ordered[0]?.view_url || "",
          images: ordered,
          selected_image_ids: body.selected_image_ids || ["FILE_A"],
          ai_selected_image_ids: body.selected_image_ids || ["FILE_A"],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    throw new Error(`Unexpected GAS call: ${url}`);
  };

  const handler = createProductsApiHandler({
    getSupabase: () => mockSupabase,
    fetchImpl: mockFetch,
    gasWebAppUrl: "https://script.google.com/macros/s/MOCK/exec",
    internalSecret: "test-img-secret",
  });

  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const writeHeaders = {
    "Content-Type": "application/json",
    "X-Internal-Sync-Token": "test-img-secret",
  };

  try {
    // 1. Reorder: move FILE_B to main (index 0), FILE_A to index 1; omit selected_image_ids -> preserved
    const reorderRes = await fetch(`${base}/products/TMP-000401/images`, {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify({
        image_order: [
          { source: "existing", id: "FILE_B" },
          { source: "existing", id: "FILE_A" },
        ],
        new_images: [],
      }),
    });
    assert.equal(reorderRes.status, 200);
    const reorderJson = await reorderRes.json();
    assert.equal(reorderJson.success, true);
    assert.equal(reorderJson.version, "product-images-update-v2");
    assert.equal(
      reorderJson.main_image_url,
      "https://drive.google.com/file/d/FILE_B/view"
    );
    assert.deepEqual(reorderJson.selected_image_ids, ["FILE_A"]);

    const detailAfterReorder = await (
      await fetch(`${base}/?mode=admin&product_id=TMP-000401`)
    ).json();
    assert.deepEqual(
      detailAfterReorder.product.images.map((i) => i.file_id),
      ["FILE_B", "FILE_A"]
    );
    assert.equal(detailAfterReorder.product.images[0].name, "01_main_b.jpg");
    assert.equal(detailAfterReorder.product.images[1].name, "02_a.jpg");

    // 2. Add 1 new image + Delete FILE_A in single operation
    const addDelRes = await fetch(`${base}/products/TMP-000401/images`, {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify({
        image_order: [
          { source: "existing", id: "FILE_B" },
          { source: "new", id: "client-new-1" },
        ],
        new_images: [
          {
            client_id: "client-new-1",
            file_name: "added.jpg",
            mime_type: "image/jpeg",
            base64: TINY_JPEG_B64,
          },
        ],
      }),
    });
    assert.equal(addDelRes.status, 200);
    const addDelJson = await addDelRes.json();
    assert.equal(addDelJson.image_count, 2);
    assert.deepEqual(
      addDelJson.images.map((i) => i.file_id),
      ["FILE_B", "FILE_NEW_1"]
    );
    assert.equal(driveFiles.has("FILE_A"), false); // Trashed in Drive

    // 3. Reject >20 images BEFORE touching GAS
    const callsBeforeReject = gasImageCalls;
    const tooManyRes = await fetch(`${base}/products/TMP-000401/images`, {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify({
        image_order: Array.from({ length: 21 }, (_, idx) => ({
          source: "existing",
          id: `FAKE_${idx}`,
        })),
        new_images: [],
      }),
    });
    assert.equal(tooManyRes.status, 400);
    const tooManyJson = await tooManyRes.json();
    assert.equal(tooManyJson.error_code, "MAX_IMAGE_COUNT_EXCEEDED");
    assert.equal(gasImageCalls, callsBeforeReject);

    // 4. Reject SELECTED_IMAGE_DELETED BEFORE touching GAS
    const delSelRes = await fetch(`${base}/products/TMP-000401/images`, {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify({
        image_order: [{ source: "existing", id: "FILE_B" }],
        new_images: [],
        selected_image_ids: ["FILE_NEW_1"],
      }),
    });
    assert.equal(delSelRes.status, 400);
    const delSelJson = await delSelRes.json();
    assert.equal(delSelJson.error_code, "SELECTED_IMAGE_DELETED");
    assert.equal(gasImageCalls, callsBeforeReject);

    // 5. Clear all images (0 images) -> main_image_url = ""
    const clearRes = await fetch(`${base}/products/TMP-000401/images`, {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify({
        image_order: [],
        new_images: [],
      }),
    });
    assert.equal(clearRes.status, 200);
    const clearJson = await clearRes.json();
    assert.equal(clearJson.image_count, 0);
    assert.equal(clearJson.main_image_url, "");

    const detailAfterClear = await (
      await fetch(`${base}/?mode=admin&product_id=TMP-000401`)
    ).json();
    assert.equal(detailAfterClear.product.images.length, 0);
    assert.equal(detailAfterClear.product.main_image_url, "");
  } finally {
    server.close();
  }
});

test("Phase 2 Unit 3: Draft inventory_status & record_status endpoints enforce non-Square draft eligibility, preserve inventory_status on restore, and replay deferred status mirrors during reconcile", async () => {
  const mockSupabase = createWriteMockSupabase([
    {
      productRow: {
        product_id: "TMP-000501",
        row_seq: 1,
        category: "sneaker",
        brand: "Nike",
        product_name: "Draft Dunk Low",
        condition: "A",
        purchase_price: 12000,
        planned_sale_price: 22000,
        publish_status: "draft",
        inventory_status: "in_stock",
        record_status: "active",
        square_item_id: "",
        square_variation_id: "",
        square_payment_link_id: "",
        square_checkout_url: "",
        sheets_mirror_pending: false,
      },
      imageRows: [],
    },
    {
      productRow: {
        product_id: "TMP-000502",
        row_seq: 2,
        category: "sneaker",
        brand: "Nike",
        product_name: "Published Dunk Low",
        condition: "A",
        purchase_price: 12000,
        planned_sale_price: 22000,
        publish_status: "published",
        inventory_status: "in_stock",
        record_status: "active",
        square_item_id: "SQ_ITEM_502",
        square_variation_id: "SQ_VAR_502",
        square_payment_link_id: "SQ_LINK_502",
        square_checkout_url: "https://square.link/u/502",
        sheets_mirror_pending: false,
      },
      imageRows: [],
    },
    {
      productRow: {
        product_id: "TMP-000503",
        row_seq: 3,
        category: "jewelry",
        brand: "Cartier",
        product_name: "Restored Draft With Residual Square Link",
        condition: "AB",
        purchase_price: 80000,
        planned_sale_price: 140000,
        publish_status: "draft",
        inventory_status: "sold",
        record_status: "archived",
        square_item_id: "",
        square_variation_id: "",
        square_payment_link_id: "SQ_RESIDUAL_LINK_503",
        square_checkout_url: "",
        sheets_mirror_pending: false,
      },
      imageRows: [],
    },
  ]);

  let gasMirrorAvailable = true;
  let gasPostCalls = 0;
  const gasSheetsState = {
    "TMP-000501": {
      product_id: "TMP-000501",
      category: "sneaker",
      brand: "Nike",
      product_name: "Draft Dunk Low",
      condition: "A",
      purchase_price: 12000,
      planned_sale_price: 22000,
      publish_status: "draft",
      inventory_status: "in_stock",
      record_status: "active",
      square_item_id: "",
      square_variation_id: "",
      square_payment_link_id: "",
      square_checkout_url: "",
    },
    "TMP-000502": {
      product_id: "TMP-000502",
      category: "sneaker",
      brand: "Nike",
      product_name: "Published Dunk Low",
      condition: "A",
      purchase_price: 12000,
      planned_sale_price: 22000,
      publish_status: "published",
      inventory_status: "in_stock",
      record_status: "active",
      square_item_id: "SQ_ITEM_502",
      square_variation_id: "SQ_VAR_502",
      square_payment_link_id: "SQ_LINK_502",
      square_checkout_url: "https://square.link/u/502",
    },
    "TMP-000503": {
      product_id: "TMP-000503",
      category: "jewelry",
      brand: "Cartier",
      product_name: "Restored Draft With Residual Square Link",
      condition: "AB",
      purchase_price: 80000,
      planned_sale_price: 140000,
      publish_status: "draft",
      inventory_status: "sold",
      record_status: "archived",
      square_item_id: "",
      square_variation_id: "",
      square_payment_link_id: "SQ_RESIDUAL_LINK_503",
      square_checkout_url: "",
    },
  };

  const mockFetch = async (url, init = {}) => {
    if (init.method === "POST") {
      gasPostCalls++;
      if (!gasMirrorAvailable) {
        return new Response("GAS Mirror Unavailable", { status: 503 });
      }
      const body = JSON.parse(init.body);
      const cur = gasSheetsState[body.product_id];
      if (body.action === "update_inventory_status") {
        cur.inventory_status = body.inventory_status;
        return new Response(
          JSON.stringify({
            success: true,
            version: "inventory-status-update-v1",
            product_id: body.product_id,
            inventory_status: body.inventory_status,
          }),
          { status: 200 }
        );
      }
      if (body.action === "update_record_status") {
        if (cur.record_status === "archived" && body.record_status === "active") {
          cur.publish_status = "draft";
        }
        cur.record_status = body.record_status;
        return new Response(
          JSON.stringify({
            success: true,
            version: "record-status-update-v1",
            product_id: body.product_id,
            record_status: body.record_status,
            publish_status: cur.publish_status,
          }),
          { status: 200 }
        );
      }
      if (body.action === "update_product") {
        Object.assign(cur, {
          brand: body.brand ?? cur.brand,
          product_name: body.product_name ?? cur.product_name,
        });
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
    }
    const u = new URL(url);
    if (u.searchParams.get("record_status") === "all") {
      return new Response(
        JSON.stringify({
          success: true,
          products: [
            gasSheetsState["TMP-000503"],
            gasSheetsState["TMP-000502"],
            gasSheetsState["TMP-000501"],
          ],
        }),
        { status: 200 }
      );
    }
    const pid = u.searchParams.get("product_id");
    if (!gasMirrorAvailable && pid === "TMP-000501_OFFLINE") {
      return new Response("Offline", { status: 503 });
    }
    return new Response(
      JSON.stringify({
        success: true,
        product: { ...gasSheetsState[pid], images: [] },
      }),
      { status: 200 }
    );
  };

  const server = http.createServer(
    createProductsApiHandler({
      getSupabase: () => mockSupabase,
      fetchImpl: mockFetch,
      gasWebAppUrl: "https://gas.example.com/exec",
      internalSecret: "sync-secret",
    })
  );
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const writeHeaders = {
    "Content-Type": "application/json",
    "X-Internal-Sync-Token": "sync-secret",
  };

  try {
    // 1. Unauthenticated status write rejected (401)
    const unauthRes = await fetch(
      `${base}/products/TMP-000501/inventory-status`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inventory_status: "reserved" }),
      }
    );
    assert.equal(unauthRes.status, 401);

    // 2. Invalid status values rejected (400) & missing product rejected (404)
    const badInvRes = await fetch(
      `${base}/products/TMP-000501/inventory-status`,
      {
        method: "POST",
        headers: writeHeaders,
        body: JSON.stringify({ inventory_status: "out_of_stock" }),
      }
    );
    assert.equal(badInvRes.status, 400);
    assert.equal((await badInvRes.json()).error_code, "INVALID_INVENTORY_STATUS");

    const badRecRes = await fetch(
      `${base}/products/TMP-000501/record-status`,
      {
        method: "POST",
        headers: writeHeaders,
        body: JSON.stringify({ record_status: "deleted" }),
      }
    );
    assert.equal(badRecRes.status, 400);
    assert.equal((await badRecRes.json()).error_code, "INVALID_RECORD_STATUS");

    const notFoundRes = await fetch(
      `${base}/products/TMP-999999/record-status`,
      {
        method: "POST",
        headers: writeHeaders,
        body: JSON.stringify({ record_status: "archived" }),
      }
    );
    assert.equal(notFoundRes.status, 404);
    assert.equal((await notFoundRes.json()).error_code, "PRODUCT_NOT_FOUND");

    // 3. Published or Square-linked (including residual payment_link_id) rejected Fail-Closed (409) with 0 GAS calls
    const callsBeforeBlock = gasPostCalls;
    const pubInvRes = await fetch(
      `${base}/products/TMP-000502/inventory-status`,
      {
        method: "POST",
        headers: writeHeaders,
        body: JSON.stringify({ inventory_status: "sold" }),
      }
    );
    assert.equal(pubInvRes.status, 409);
    assert.equal((await pubInvRes.json()).error_code, "NON_DRAFT_PRODUCT");

    const sqRecRes = await fetch(
      `${base}/products/TMP-000503/record-status`,
      {
        method: "POST",
        headers: writeHeaders,
        body: JSON.stringify({ record_status: "active" }),
      }
    );
    assert.equal(sqRecRes.status, 409);
    assert.equal((await sqRecRes.json()).error_code, "SQUARE_LINKED_PRODUCT");
    assert.equal(gasPostCalls, callsBeforeBlock);

    // 4. Non-Square draft inventory_status -> reserved -> sold, then archive -> restore preserves sold + draft
    const resInv1 = await fetch(
      `${base}/products/TMP-000501/inventory-status`,
      {
        method: "POST",
        headers: writeHeaders,
        body: JSON.stringify({ inventory_status: "reserved" }),
      }
    );
    assert.equal(resInv1.status, 200);
    const jsonInv1 = await resInv1.json();
    assert.equal(jsonInv1.inventory_status, "reserved");
    assert.equal(jsonInv1.write_master, "supabase");
    assert.equal(jsonInv1.sheets_mirrored, true);
    assert.equal(gasSheetsState["TMP-000501"].inventory_status, "reserved");

    // Action dispatch parity via POST /
    const resInv2 = await fetch(`${base}/`, {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify({
        action: "update_inventory_status",
        product_id: "TMP-000501",
        inventory_status: "sold",
      }),
    });
    assert.equal(resInv2.status, 200);
    assert.equal(
      mockSupabase.state.products.get("TMP-000501").inventory_status,
      "sold"
    );
    assert.equal(gasSheetsState["TMP-000501"].inventory_status, "sold");

    // Archive while sold
    const resArch = await fetch(`${base}/products/TMP-000501/record-status`, {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify({ record_status: "archived" }),
    });
    assert.equal(resArch.status, 200);
    const jsonArch = await resArch.json();
    assert.equal(jsonArch.record_status, "archived");
    assert.equal(jsonArch.publish_status, "draft");
    assert.equal(jsonArch.inventory_status, "sold");
    assert.equal(gasSheetsState["TMP-000501"].record_status, "archived");

    // Restore from archive -> publish_status fixed to "draft", inventory_status MUST stay "sold"
    const resRestore = await fetch(
      `${base}/products/TMP-000501/record-status`,
      {
        method: "POST",
        headers: writeHeaders,
        body: JSON.stringify({ record_status: "active" }),
      }
    );
    assert.equal(resRestore.status, 200);
    const jsonRestore = await resRestore.json();
    assert.equal(jsonRestore.record_status, "active");
    assert.equal(jsonRestore.publish_status, "draft");
    assert.equal(jsonRestore.inventory_status, "sold");
    assert.equal(
      mockSupabase.state.products.get("TMP-000501").inventory_status,
      "sold"
    );
    assert.equal(gasSheetsState["TMP-000501"].record_status, "active");
    assert.equal(gasSheetsState["TMP-000501"].inventory_status, "sold");

    // 5. Deferred Sheets mirror protection when GAS is temporarily unavailable
    gasMirrorAvailable = false;
    const invWhileDown = await fetch(
      `${base}/products/TMP-000501/inventory-status`,
      {
        method: "POST",
        headers: writeHeaders,
        body: JSON.stringify({ inventory_status: "in_stock" }),
      }
    );
    assert.equal(invWhileDown.status, 200);
    assert.equal((await invWhileDown.json()).sheets_mirrored, false);

    const archWhileDown = await fetch(
      `${base}/products/TMP-000501/record-status`,
      {
        method: "POST",
        headers: writeHeaders,
        body: JSON.stringify({ record_status: "archived" }),
      }
    );
    assert.equal(archWhileDown.status, 200);
    assert.equal((await archWhileDown.json()).sheets_mirrored, false);
    assert.equal(
      mockSupabase.state.products.get("TMP-000501").sheets_mirror_pending,
      true
    );
    // GAS still has stale sold + active
    assert.equal(gasSheetsState["TMP-000501"].inventory_status, "sold");
    assert.equal(gasSheetsState["TMP-000501"].record_status, "active");

    // On-demand /sync/:id while pending & GAS down refuses stale overwrite (409)
    const syncWhileDown = await fetch(`${base}/sync/TMP-000501`, {
      method: "POST",
    });
    assert.equal(syncWhileDown.status, 409);

    // Scheduled /reconcile while GAS down protects TMP-000501 from clobber
    const recDown = await fetch(`${base}/reconcile?rolling=0`, {
      method: "POST",
      headers: { "X-Internal-Sync-Token": "sync-secret" },
    });
    assert.equal(recDown.status, 200);
    const recDownJson = await recDown.json();
    assert.equal(recDownJson.protected_pending_count, 1);
    assert.equal(
      mockSupabase.state.products.get("TMP-000501").inventory_status,
      "in_stock"
    );
    assert.equal(
      mockSupabase.state.products.get("TMP-000501").record_status,
      "archived"
    );

    // Once GAS recovers, /reconcile replays BOTH inventory_status and record_status to Sheets
    gasMirrorAvailable = true;
    const recUp = await fetch(`${base}/reconcile?rolling=0`, {
      method: "POST",
      headers: { "X-Internal-Sync-Token": "sync-secret" },
    });
    assert.equal(recUp.status, 200);
    const recUpJson = await recUp.json();
    assert.equal(recUpJson.flushed_pending_count, 1);
    assert.equal(gasSheetsState["TMP-000501"].inventory_status, "in_stock");
    assert.equal(gasSheetsState["TMP-000501"].record_status, "archived");
    assert.equal(
      mockSupabase.state.products.get("TMP-000501").sheets_mirror_pending,
      false
    );
  } finally {
    server.close();
  }
});

test("Test Product Isolation: POST /products and POST /products/import save is_test while keeping TMP-XXXXXX numbering unchanged", async () => {
  const mockSupabase = createWriteMockSupabase([], 600);
  const mockFetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const pid = body.reserved_product_id;
    return new Response(
      JSON.stringify({
        success: true,
        product_id: pid,
        created_at: "2026-11-09T01:00:00.000Z",
        drive_folder_id: `FOLDER_${pid}`,
        drive_folder_url: `https://drive.google.com/drive/folders/FOLDER_${pid}`,
        main_image_url: `https://drive.google.com/file/d/FILE_1_${pid}/view`,
        image_count: 1,
        images: [
          {
            file_id: `FILE_1_${pid}`,
            name: "01_main.jpg",
            mime_type: "image/jpeg",
            view_url: `https://drive.google.com/file/d/FILE_1_${pid}/view`,
            display_url: `https://drive.google.com/thumbnail?id=FILE_1_${pid}&sz=w1600`,
          },
        ],
      }),
      { status: 200 }
    );
  };

  const server = http.createServer(
    createProductsApiHandler({
      getSupabase: () => mockSupabase,
      fetchImpl: mockFetch,
      gasWebAppUrl: "https://script.google.com/macros/s/MOCK/exec",
      internalSecret: "sync-secret",
    })
  );
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const writeHeaders = {
    "Content-Type": "application/json",
    "X-Internal-Sync-Token": "sync-secret",
  };

  try {
    // 1. Default POST /products -> is_test: false, TMP-000601
    const resDefault = await (
      await fetch(`${base}/products`, {
        method: "POST",
        headers: writeHeaders,
        body: JSON.stringify({
          client_request_id: "req-normal-601",
          product_name: "Normal Draft",
          images: [{ file_name: "a.jpg", mime_type: "image/jpeg", base64: TINY_JPEG_B64 }],
        }),
      })
    ).json();
    assert.equal(resDefault.success, true);
    assert.equal(resDefault.product_id, "TMP-000601");
    assert.equal(resDefault.is_test, false);
    assert.equal(mockSupabase.state.products.get("TMP-000601").is_test, false);

    // 2. Explicit is_test: true on POST /products -> TMP-000602 (same numbering sequence)
    const resTestCreate = await (
      await fetch(`${base}/products`, {
        method: "POST",
        headers: writeHeaders,
        body: JSON.stringify({
          client_request_id: "req-test-602",
          product_name: "Test Draft 1",
          is_test: true,
          images: [{ file_name: "b.jpg", mime_type: "image/jpeg", base64: TINY_JPEG_B64 }],
        }),
      })
    ).json();
    assert.equal(resTestCreate.success, true);
    assert.equal(resTestCreate.product_id, "TMP-000602");
    assert.equal(resTestCreate.is_test, true);
    assert.equal(resTestCreate.product.is_test, true);
    assert.equal(mockSupabase.state.products.get("TMP-000602").is_test, true);

    // Reusing client_request_id with flipped is_test is rejected as 409 IDEMPOTENCY_PAYLOAD_MISMATCH
    const mismatchCreate = await fetch(`${base}/products`, {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify({
        client_request_id: "req-test-602",
        product_name: "Test Draft 1",
        is_test: false,
        images: [{ file_name: "b.jpg", mime_type: "image/jpeg", base64: TINY_JPEG_B64 }],
      }),
    });
    assert.equal(mismatchCreate.status, 409);

    // Invalid non-boolean is_test rejected
    const invalidBool = await fetch(`${base}/products`, {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify({
        product_name: "Bad Flag",
        is_test: "yes",
        images: [{ file_name: "b.jpg", mime_type: "image/jpeg", base64: TINY_JPEG_B64 }],
      }),
    });
    assert.equal(invalidBool.status, 400);

    // 3. Explicit is_test: true on POST /products/import -> TMP-000603
    const resTestImport = await (
      await fetch(`${base}/products/import`, {
        method: "POST",
        headers: writeHeaders,
        body: JSON.stringify({
          import_attempt_id: "imp-test-603",
          is_test: true,
          images: [{ file_name: "c.jpg", mime_type: "image/jpeg", base64: TINY_JPEG_B64 }],
        }),
      })
    ).json();
    assert.equal(resTestImport.success, true);
    assert.equal(resTestImport.product_id, "TMP-000603");
    assert.equal(resTestImport.is_test, true);
    assert.equal(mockSupabase.state.products.get("TMP-000603").is_test, true);

    // Reusing import_attempt_id with different is_test returns IMPORT_IDEMPOTENCY_PAYLOAD_MISMATCH
    const mismatchImport = await (
      await fetch(`${base}/products/import`, {
        method: "POST",
        headers: writeHeaders,
        body: JSON.stringify({
          import_attempt_id: "imp-test-603",
          is_test: false,
          images: [{ file_name: "c.jpg", mime_type: "image/jpeg", base64: TINY_JPEG_B64 }],
        }),
      })
    ).json();
    assert.equal(mismatchImport.success, false);
    assert.equal(mismatchImport.error_code, "IMPORT_IDEMPOTENCY_PAYLOAD_MISMATCH");
  } finally {
    server.close();
  }
});




