import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  mapGasProductToSupabaseBundle,
} from "../src/productMapper.mjs";
import { createProductsApiHandler } from "../src/server.mjs";

// In-memory mock of Supabase PostgREST + Auth client for contract verification
function createMockSupabase(initialProducts = [], options = {}) {
  let syncRunSeq = 1;
  const state = {
    products: new Map(),
    product_images: [],
    product_translations: [],
    pokemon_cards: [],
    product_documents: [],
    staff_users: options.staffUsers || [
      { email: "staff@bis-ec.example.com", is_active: true },
    ],
    product_sync_runs: [],
    rpcCalls: [],
  };

  const usersByToken = new Map(
    Object.entries(
      options.tokens || {
        "valid-staff-jwt": {
          id: "user-staff-1",
          email: "staff@bis-ec.example.com",
          app_metadata: {},
        },
        "valid-meta-staff-jwt": {
          id: "user-staff-2",
          email: "meta-staff@bis-ec.example.com",
          app_metadata: { role: "staff" },
        },
        "valid-outsider-jwt": {
          id: "user-outsider-1",
          email: "outsider@example.com",
          app_metadata: {},
        },
      }
    )
  );

  for (const b of initialProducts) {
    state.products.set(b.productRow.product_id, {
      is_test: false,
      ...b.productRow,
      search_text: [
        b.productRow.product_name,
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
      async getUser(token) {
        const user = usersByToken.get(token);
        if (!user) {
          return { data: { user: null }, error: { message: "Invalid JWT" } };
        }
        return { data: { user }, error: null };
      },
    },
    async rpc(fnName, args) {
      state.rpcCalls.push({ fnName, args });
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

        for (const fn of filters) {
          rows = rows.filter(fn);
        }

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
          if (start >= total && total > 0) {
            return {
              data: null,
              count: null,
              status: 416,
              error: { code: "PGRST103", message: "Requested range not satisfiable" },
            };
          }
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
          const inner = pattern.replace(/^%|%$/g, "").replace(/\\([%_\\])/g, "$1");
          const needle = inner.toLowerCase();
          filters.push((r) => String(r[col] || "").toLowerCase().includes(needle));
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
              if (table === "products") {
                for (const [k, row] of state.products.entries()) {
                  if (updateFilters.every((fn) => fn(row))) {
                    state.products.set(k, { ...row, ...patch });
                  }
                }
              } else {
                state[table] = (state[table] || []).map((row) =>
                  updateFilters.every((fn) => fn(row)) ? { ...row, ...patch } : row
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
            for (const it of items) {
              const prev = state.products.get(it.product_id);
              const nextRow = {
                is_test: false,
                ...prev,
                ...it,
                row_seq: it.row_seq ?? prev?.row_seq ?? state.products.size + 1,
              };
              nextRow.search_text = [
                nextRow.product_name,
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
                (x) => x.product_id === it.product_id && x.file_id === it.file_id
              );
              if (idx >= 0) state.product_images[idx] = it;
              else state.product_images.push(it);
            }
          } else if (table === "product_translations") {
            for (const it of items) {
              const idx = state.product_translations.findIndex(
                (x) => x.product_id === it.product_id && x.locale === it.locale
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
          } else if (table === "product_documents") {
            for (const it of items) {
              const idx = state.product_documents.findIndex(
                (x) => x.product_id === it.product_id
              );
              if (idx >= 0) state.product_documents[idx] = it;
              else state.product_documents.push(it);
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
                    state.product_images = state.product_images.filter(
                      (x) => x.product_id !== k
                    );
                    state.product_translations = state.product_translations.filter(
                      (x) => x.product_id !== k
                    );
                    state.pokemon_cards = state.pokemon_cards.filter(
                      (x) => x.product_id !== k
                    );
                    state.product_documents = state.product_documents.filter(
                      (x) => x.product_id !== k
                    );
                  }
                }
              } else {
                state[table] = state[table].filter(
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

const sampleBundles = [
  mapGasProductToSupabaseBundle({
    rowSeq: 1,
    summary: {
      product_id: "TMP-000001",
      created_at: "2026-08-24T06:08:19.000Z",
      category: "",
      brand: "Dummy",
      product_name: "ダミーテスト商品",
      planned_sale_price: 5000,
      publish_status: "draft",
      inventory_status: "in_stock",
      record_status: "archived",
    },
    detail: {
      product_id: "TMP-000001",
      created_at: "2026-08-24T06:08:19.000Z",
      category: "",
      brand: "Dummy",
      product_name: "ダミーテスト商品",
      purchase_price: 1000,
      planned_sale_price: 5000,
      publish_status: "draft",
      inventory_status: "in_stock",
      record_status: "archived",
      auction_item_number: "00123",
      images: [],
    },
  }),
  mapGasProductToSupabaseBundle({
    rowSeq: 2,
    summary: {
      product_id: "TMP-000128",
      created_at: "2026-10-10T10:00:00.000Z",
      category: "pokemon_card",
      brand: "Pokemon",
      product_name: "ピカチュウ AR",
      translated_title: "Pikachu AR",
      planned_sale_price: 12000,
      publish_status: "published",
      inventory_status: "in_stock",
      record_status: "active",
      square_item_id: "SQ_ITEM_128",
      square_variation_id: "SQ_VAR_128",
      square_payment_link_id: "SQ_LINK_128",
      square_checkout_url: "https://square.link/u/128",
    },
    detail: {
      product_id: "TMP-000128",
      created_at: "2026-10-10T10:00:00.000Z",
      category: "pokemon_card",
      brand: "Pokemon",
      product_name: "ピカチュウ AR",
      purchase_price: 6000,
      planned_sale_price: 12000,
      publish_status: "published",
      inventory_status: "in_stock",
      record_status: "active",
      square_item_id: "SQ_ITEM_128",
      square_variation_id: "SQ_VAR_128",
      square_payment_link_id: "SQ_LINK_128",
      square_checkout_url: "https://square.link/u/128",
      main_image_url: "https://drive.google.com/file/d/FILE_PKM_1/view",
      images: [
        {
          file_id: "FILE_PKM_1",
          name: "01_main_pikachu.jpg",
          mime_type: "image/jpeg",
          view_url: "https://drive.google.com/file/d/FILE_PKM_1/view",
          display_url: "https://drive.google.com/thumbnail?id=FILE_PKM_1&sz=w1600",
        },
      ],
      pokemon_card: {
        card_name: "ピカチュウ",
        set_name: "VSTARユニバース",
        card_number: "205/172",
        rarity: "AR",
        language: "JA",
        grading_status: "graded",
        grader: "PSA",
        grade: "10",
        certification_number: "99999999",
        card_condition: "A",
      },
      translation: {
        locale: "en",
        translated_title: "Pikachu AR",
        translated_description: "PSA 10 Gem Mint",
        translation_status: "approved",
        generated_at: "2026-10-10T11:00:00.000Z",
      },
    },
  }),
  mapGasProductToSupabaseBundle({
    rowSeq: 3,
    summary: {
      product_id: "TMP-000163",
      created_at: "2026-11-02T01:48:35.000Z",
      category: "sneaker",
      brand: "NIKE",
      product_name: 'CLOT × Nike Cortez SP "CLOTEZ" Black/White 28.0cm',
      translated_title: 'CLOT × Nike Cortez SP "CLOTEZ" US 10',
      planned_sale_price: 15000,
      sneaker_sku: "DZ3239-002",
      sneaker_size: "28cm",
      auction_item_number: "455-3",
      publish_status: "draft",
      inventory_status: "in_stock",
      record_status: "active",
    },
    detail: {
      product_id: "TMP-000163",
      created_at: "2026-11-02T01:48:35.000Z",
      category: "sneaker",
      brand: "NIKE",
      product_name: 'CLOT × Nike Cortez SP "CLOTEZ" Black/White 28.0cm',
      purchase_price: 8500,
      planned_sale_price: 15000,
      storage_location: "A-03",
      sneaker_sku: "DZ3239-002",
      sneaker_size: "28cm",
      auction_item_number: "455-3",
      publish_status: "draft",
      inventory_status: "in_stock",
      record_status: "active",
      selected_image_ids: ["IMG_1", "IMG_2"],
      main_image_url: "https://drive.google.com/file/d/IMG_1/view",
      images: [
        { file_id: "IMG_1", name: "01_main.jpg" },
        { file_id: "IMG_2", name: "02_side.jpg" },
      ],
    },
  }),
];

test("Endpoint access boundary: admin & sync work without login (GAS-compatible), /reconcile requires internal token, public EC filters drafts", async () => {
  const mockSupabase = createMockSupabase(sampleBundles);
  const server = http.createServer(
    createProductsApiHandler({
      getSupabase: () => mockSupabase,
      internalSecret: "test-internal-sync-secret-999",
    })
  );
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    // 1. /reconcile remains protected by server-only X-Internal-Sync-Token (401 without token)
    const unauthReconcile = await fetch(`${base}/reconcile`, { method: "POST" });
    assert.equal(unauthReconcile.status, 401);

    // 2. Admin list & detail work without login (matching current GAS doGet ?mode=admin)
    const adminListRes = await fetch(`${base}/?mode=admin&page=1&page_size=50`);
    assert.equal(adminListRes.status, 200);
    const adminListJson = await adminListRes.json();
    assert.equal(adminListJson.success, true);
    assert.equal(adminListJson.count, 2);

    const adminDetRes = await fetch(`${base}/?mode=admin&product_id=TMP-000128`);
    assert.equal(adminDetRes.status, 200);

    // 3. Unknown mode value -> 400
    const badModeRes = await fetch(`${base}/?mode=superuser&category=pokemon_card`);
    assert.equal(badModeRes.status, 400);

    // 4. Public EC endpoints return ONLY published + in_stock + active items and hide purchase_price
    const pubCatRes = await fetch(`${base}/?category=pokemon_card`);
    assert.equal(pubCatRes.status, 200);
    const pubCatJson = await pubCatRes.json();
    assert.equal(pubCatJson.version, "product-list-v4");
    assert.equal(pubCatJson.products.length, 1);
    assert.equal(pubCatJson.products[0].product_id, "TMP-000128");
    assert.equal("purchase_price" in pubCatJson.products[0], false);

    const pubDetRes = await fetch(`${base}/?product_id=TMP-000128`);
    assert.equal(pubDetRes.status, 200);
    const pubDetJson = await pubDetRes.json();
    assert.equal(pubDetJson.success, true);
    assert.equal(pubDetJson.product.product_id, "TMP-000128");
    assert.equal("purchase_price" in pubDetJson.product, false);

    const pubDraftRes = await fetch(`${base}/?product_id=TMP-000163`);
    const pubDraftJson = await pubDraftRes.json();
    assert.equal(pubDraftJson.success, false);
    assert.equal(pubDraftJson.error, "product not found");

    // 5. Health endpoint does not leak row counts
    const healthRes = await fetch(`${base}/health?db=1`);
    assert.equal(healthRes.status, 200);
    const healthJson = await healthRes.json();
    assert.equal(healthJson.db, "ok");
    assert.equal("total_products" in healthJson, false);
  } finally {
    server.close();
  }
});

test("Admin paginated list v3, multi-term search, archived tab, and detail (unauthenticated GAS-compatible)", async () => {
  const mockSupabase = createMockSupabase(sampleBundles);
  const server = http.createServer(
    createProductsApiHandler({ getSupabase: () => mockSupabase })
  );
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const authHeaders = {};

  try {
    // 1. Default active paginated list (row_seq DESC -> TMP-000163 first, TMP-000128 second)
    const listRes = await fetch(`${base}/?mode=admin&page=1&page_size=50`, {
      headers: authHeaders,
    });
    assert.equal(listRes.status, 200);
    assert.ok(listRes.headers.get("x-response-time-ms"));
    const listJson = await listRes.json();
    assert.equal(listJson.version, "admin-product-list-v3");
    assert.equal(listJson.count, 2);
    assert.equal(listJson.total_pages, 1);
    assert.equal(listJson.products[0].product_id, "TMP-000163");
    assert.equal(listJson.products[0].sneaker_size, "28cm");
    assert.equal(listJson.products[0].auction_item_number, "455-3");
    assert.equal(listJson.products[1].product_id, "TMP-000128");
    assert.equal(listJson.products[1].square_variation_id, "SQ_VAR_128");

    // 2. Multi-term AND search (brand + auction_item_number)
    const searchRes = await fetch(
      `${base}/?mode=admin&page=1&page_size=50&search=${encodeURIComponent("nike 455-3")}`,
      { headers: authHeaders }
    );
    const searchJson = await searchRes.json();
    assert.equal(searchJson.count, 1);
    assert.equal(searchJson.products[0].product_id, "TMP-000163");

    // 3. Archived tab preserves leading zeros in auction_item_number ("00123") and empty category ("")
    const archRes = await fetch(
      `${base}/?mode=admin&page=1&page_size=50&record_status=archived`,
      { headers: authHeaders }
    );
    const archJson = await archRes.json();
    assert.equal(archJson.count, 1);
    assert.equal(archJson.products[0].product_id, "TMP-000001");
    assert.equal(archJson.products[0].auction_item_number, "00123");
    assert.equal(archJson.products[0].category, "");

    // 4. Out-of-range page=99 returns empty array with accurate count & total_pages
    const oorRes = await fetch(`${base}/?mode=admin&page=99&page_size=50`, {
      headers: authHeaders,
    });
    const oorJson = await oorRes.json();
    assert.equal(oorJson.success, true);
    assert.equal(oorJson.count, 2);
    assert.equal(oorJson.total_pages, 1);
    assert.deepEqual(oorJson.products, []);

    // 5. Admin detail returns full relations (images, pokemon_card, translation, Square IDs, purchase_price)
    const admDetRes = await fetch(`${base}/?mode=admin&product_id=TMP-000128`, {
      headers: authHeaders,
    });
    const admDetJson = await admDetRes.json();
    assert.equal(admDetJson.version, "admin-product-detail-v1");
    assert.equal(admDetJson.product.purchase_price, 6000);
    assert.equal(admDetJson.product.pokemon_card.grade, "10");
    assert.equal(admDetJson.product.translation.translated_title, "Pikachu AR");
    assert.equal(admDetJson.product.images.length, 1);
    assert.equal(admDetJson.product.square_payment_link_id, "SQ_LINK_128");
  } finally {
    server.close();
  }
});

test("Single-product sync & periodic diff reconciler catch off-screen GAS changes and fail closed", async () => {
  const mockSupabase = createMockSupabase(sampleBundles);

  // Simulated GAS state where:
  // - TMP-000128 was marked `sold` by GAS background Square polling while browser was closed
  // - TMP-000164 was newly added
  // - TMP-000001 was deleted from Sheets
  let gasHealthy = true;
  const gasSnapshotList = [
    {
      product_id: "TMP-000164",
      created_at: "2026-11-02T05:00:00.000Z",
      category: "jewelry",
      brand: "Cartier",
      product_name: "Cartier Love Ring #52",
      purchase_price: 110000,
      planned_sale_price: 180000,
      publish_status: "published",
      inventory_status: "in_stock",
      record_status: "active",
      auction_item_number: "900-1",
    },
    {
      product_id: "TMP-000163",
      created_at: "2026-11-02T01:48:35.000Z",
      category: "sneaker",
      brand: "NIKE",
      product_name: 'CLOT × Nike Cortez SP "CLOTEZ" Black/White 28.0cm',
      translated_title: 'CLOT × Nike Cortez SP "CLOTEZ" US 10',
      planned_sale_price: 15000,
      sneaker_sku: "DZ3239-002",
      sneaker_size: "28cm",
      auction_item_number: "455-3",
      purchase_price: 8500,
      storage_location: "A-03",
      publish_status: "draft",
      inventory_status: "in_stock",
      record_status: "active",
      selected_image_ids: ["IMG_1", "IMG_2"],
      main_image_url: "https://drive.google.com/file/d/IMG_1/view",
    },
    {
      product_id: "TMP-000128",
      created_at: "2026-10-10T10:00:00.000Z",
      category: "pokemon_card",
      brand: "Pokemon",
      product_name: "ピカチュウ AR",
      translated_title: "Pikachu AR",
      purchase_price: 6000,
      planned_sale_price: 12000,
      publish_status: "published",
      inventory_status: "sold", // <-- changed by GAS trigger!
      record_status: "active",
      square_item_id: "SQ_ITEM_128",
      square_variation_id: "SQ_VAR_128",
      square_payment_link_id: "SQ_LINK_128",
      square_checkout_url: "https://square.link/u/128",
      main_image_url: "https://drive.google.com/file/d/FILE_PKM_1/view",
    },
  ];

  const gasDetails = {
    "TMP-000164": {
      ...gasSnapshotList[0],
      purchase_price: 110000,
      jewelry_material: "K18YG",
      images: [],
    },
    "TMP-000163": {
      ...gasSnapshotList[1],
      purchase_price: 8500,
      storage_location: "A-03",
      images: [
        { file_id: "IMG_1", name: "01_main.jpg" },
        { file_id: "IMG_2", name: "02_side.jpg" },
      ],
    },
    "TMP-000128": {
      ...gasSnapshotList[2],
      purchase_price: 6000,
      images: [
        {
          file_id: "FILE_PKM_1",
          name: "01_main_pikachu.jpg",
          mime_type: "image/jpeg",
          view_url: "https://drive.google.com/file/d/FILE_PKM_1/view",
        },
      ],
    },
  };

  const mockFetch = async (url) => {
    if (!gasHealthy) {
      return new Response("GAS Down", { status: 502 });
    }
    const u = new URL(url);
    if (u.searchParams.get("record_status") === "all") {
      return new Response(
        JSON.stringify({ success: true, products: gasSnapshotList }),
        { status: 200 }
      );
    }
    const pid = u.searchParams.get("product_id");
    if (pid && gasDetails[pid]) {
      return new Response(
        JSON.stringify({ success: true, product: gasDetails[pid] }),
        { status: 200 }
      );
    }
    return new Response(
      JSON.stringify({ success: false, error: "product not found" }),
      { status: 200 }
    );
  };

  const server = http.createServer(
    createProductsApiHandler({
      getSupabase: () => mockSupabase,
      fetchImpl: mockFetch,
      gasWebAppUrl: "https://gas.example.com/exec",
      internalSecret: "sched-secret-123",
    })
  );
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    // 1. Fail-closed check when GAS returns HTTP 502: Supabase rows remain untouched
    gasHealthy = false;
    const failRes = await fetch(`${base}/reconcile?rolling=0`, {
      method: "POST",
      headers: { "X-Internal-Sync-Token": "sched-secret-123" },
    });
    assert.equal(failRes.status, 500);
    assert.equal(mockSupabase.state.products.get("TMP-000128").inventory_status, "in_stock");
    assert.equal(mockSupabase.state.products.has("TMP-000001"), true);
    assert.equal(mockSupabase.state.product_sync_runs.at(-1).status, "failed");

    // 2. Healthy scheduled reconcile: updates TMP-000128 -> sold, inserts TMP-000164, deletes TMP-000001
    gasHealthy = true;
    const recRes = await fetch(`${base}/reconcile?rolling=1`, {
      method: "POST",
      headers: { "X-Internal-Sync-Token": "sched-secret-123" },
    });
    assert.equal(recRes.status, 200);
    const recJson = await recRes.json();
    assert.equal(recJson.success, true);
    assert.equal(recJson.reconciled, true);
    assert.equal(recJson.sheets_count, 3);
    assert.equal(recJson.upserted_count, 3); // TMP-000164 (new) + TMP-000163 (row_seq shift) + TMP-000128 (sold + row_seq)
    assert.equal(recJson.deleted_count, 1); // TMP-000001
    assert.equal(mockSupabase.state.products.get("TMP-000128").inventory_status, "sold");
    assert.equal(mockSupabase.state.products.get("TMP-000164").jewelry_material, "K18YG");
    assert.equal(mockSupabase.state.products.has("TMP-000001"), false);
    assert.equal(mockSupabase.state.product_sync_runs.at(-1).status, "completed");

    // 2b. Second reconcile with zero changes: upserted_count = 0, rolling_checked_count = 1
    const recRes2 = await fetch(`${base}/reconcile?rolling=1`, {
      method: "POST",
      headers: { "X-Internal-Sync-Token": "sched-secret-123" },
    });
    assert.equal(recRes2.status, 200);
    const recJson2 = await recRes2.json();
    assert.equal(recJson2.upserted_count, 0);
    assert.equal(recJson2.deleted_count, 0);
    assert.equal(recJson2.rolling_checked_count, 1);

    // Public EC category list now automatically hides sold TMP-000128!
    const pubCatAfterSold = await fetch(`${base}/?category=pokemon_card`);
    const pubCatJson = await pubCatAfterSold.json();
    assert.equal(pubCatJson.products.length, 0);

    // 3. Single-product POST /sync/:id without auth header
    gasDetails["TMP-000163"].planned_sale_price = 16800;
    const syncRes = await fetch(`${base}/sync/TMP-000163`, {
      method: "POST",
    });
    assert.equal(syncRes.status, 200);
    const syncJson = await syncRes.json();
    assert.equal(syncJson.success, true);
    assert.equal(syncJson.synced, true);
    assert.equal(mockSupabase.state.products.get("TMP-000163").planned_sale_price, 16800);
  } finally {
    server.close();
  }
});

test("Test Product Isolation: query-stage exclusion, is_test=true toggle, public hiding, and GAS sync/reconcile preservation", async () => {
  const real1 = mapGasProductToSupabaseBundle({
    summary: {
      product_id: "TMP-000101",
      category: "sneaker",
      brand: "NIKE",
      product_name: "Real Sneaker 1",
      planned_sale_price: 20000,
      publish_status: "published",
      inventory_status: "in_stock",
      record_status: "active",
    },
    detail: {
      product_id: "TMP-000101",
      category: "sneaker",
      brand: "NIKE",
      product_name: "Real Sneaker 1",
      planned_sale_price: 20000,
      publish_status: "published",
      inventory_status: "in_stock",
      record_status: "active",
    },
    rowSeq: 1,
  });
  const real2 = mapGasProductToSupabaseBundle({
    summary: {
      product_id: "TMP-000102",
      category: "sneaker",
      brand: "ADIDAS",
      product_name: "Real Sneaker 2",
      planned_sale_price: 15000,
      publish_status: "draft",
      inventory_status: "in_stock",
      record_status: "active",
    },
    detail: {
      product_id: "TMP-000102",
      category: "sneaker",
      brand: "ADIDAS",
      product_name: "Real Sneaker 2",
      planned_sale_price: 15000,
      publish_status: "draft",
      inventory_status: "in_stock",
      record_status: "active",
    },
    rowSeq: 2,
  });
  const testProd = mapGasProductToSupabaseBundle({
    summary: {
      product_id: "TMP-000103",
      category: "sneaker",
      brand: "NIKE",
      product_name: "Test Sneaker Isolated",
      planned_sale_price: 19800,
      publish_status: "published",
      inventory_status: "in_stock",
      record_status: "active",
      is_test: true,
    },
    detail: {
      product_id: "TMP-000103",
      category: "sneaker",
      brand: "NIKE",
      product_name: "Test Sneaker Isolated",
      planned_sale_price: 19800,
      publish_status: "published",
      inventory_status: "in_stock",
      record_status: "active",
      is_test: true,
    },
    rowSeq: 3,
  });

  const mockSupabase = createMockSupabase([real1, real2, testProd]);

  // GAS returns NO is_test field at all (simulating Google Sheets 44-column schema)
  const gasItems = {
    "TMP-000101": {
      product_id: "TMP-000101",
      category: "sneaker",
      brand: "NIKE",
      product_name: "Real Sneaker 1",
      planned_sale_price: 20000,
      publish_status: "published",
      inventory_status: "in_stock",
      record_status: "active",
    },
    "TMP-000102": {
      product_id: "TMP-000102",
      category: "sneaker",
      brand: "ADIDAS",
      product_name: "Real Sneaker 2",
      planned_sale_price: 15000,
      publish_status: "draft",
      inventory_status: "in_stock",
      record_status: "active",
    },
    "TMP-000103": {
      product_id: "TMP-000103",
      category: "sneaker",
      brand: "NIKE",
      product_name: "Test Sneaker Isolated Updated In Sheets",
      planned_sale_price: 22000,
      publish_status: "draft",
      inventory_status: "in_stock",
      record_status: "active",
    },
  };

  const mockFetch = async (urlStr) => {
    const u = new URL(urlStr);
    const pid = u.searchParams.get("product_id");
    if (pid) {
      return new Response(JSON.stringify({ success: true, product: gasItems[pid] }), {
        status: 200,
      });
    }
    return new Response(
      JSON.stringify({
        success: true,
        products: [gasItems["TMP-000103"], gasItems["TMP-000102"], gasItems["TMP-000101"]],
      }),
      { status: 200 }
    );
  };

  const server = http.createServer(
    createProductsApiHandler({
      getSupabase: () => mockSupabase,
      fetchImpl: mockFetch,
      gasWebAppUrl: "https://script.google.com/macros/s/MOCK/exec",
      internalSecret: "sched-secret-123",
    })
  );
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    // 1. Default admin paginated list excludes TMP-000103 at SQL query stage (count = 2, total_pages = 2 for page_size=1)
    const normalPage1 = await (
      await fetch(`${base}/?mode=admin&page=1&page_size=1`)
    ).json();
    assert.equal(normalPage1.success, true);
    assert.equal(normalPage1.count, 2);
    assert.equal(normalPage1.total_pages, 2);
    assert.equal(normalPage1.is_test, false);
    assert.equal(normalPage1.products.length, 1);
    assert.equal(normalPage1.products[0].product_id, "TMP-000102");
    assert.equal(normalPage1.products[0].is_test, false);

    // Out-of-range page fallback countQuery also excludes test products (count = 2)
    const normalOutOfRange = await (
      await fetch(`${base}/?mode=admin&page=99&page_size=1`)
    ).json();
    assert.equal(normalOutOfRange.count, 2);
    assert.equal(normalOutOfRange.products.length, 0);

    // 2. Toggle ON (`is_test=true`) returns ONLY TMP-000103 (count = 1, total_pages = 1)
    const testList = await (
      await fetch(`${base}/?mode=admin&page=1&page_size=50&is_test=true`)
    ).json();
    assert.equal(testList.success, true);
    assert.equal(testList.count, 1);
    assert.equal(testList.total_pages, 1);
    assert.equal(testList.is_test, true);
    assert.equal(testList.products[0].product_id, "TMP-000103");
    assert.equal(testList.products[0].is_test, true);

    // 3. Public category list & public detail NEVER expose TMP-000103 even when publish_status='published'
    const pubCat = await (await fetch(`${base}/?category=sneaker`)).json();
    assert.equal(pubCat.products.length, 1);
    assert.equal(pubCat.products[0].product_id, "TMP-000101");

    const pubDetTest = await (await fetch(`${base}/?product_id=TMP-000103`)).json();
    assert.equal(pubDetTest.success, false);
    assert.equal(pubDetTest.error, "product not found");

    // Admin detail includes is_test: true
    const admDetTest = await (
      await fetch(`${base}/?mode=admin&product_id=TMP-000103`)
    ).json();
    assert.equal(admDetTest.success, true);
    assert.equal(admDetTest.product.is_test, true);

    // 4. POST /sync/TMP-000103 and POST /reconcile preserve is_test=true when GAS has no is_test field
    const syncRes = await (
      await fetch(`${base}/sync/TMP-000103`, { method: "POST" })
    ).json();
    assert.equal(syncRes.success, true);
    assert.equal(mockSupabase.state.products.get("TMP-000103").is_test, true);
    assert.equal(mockSupabase.state.products.get("TMP-000103").planned_sale_price, 22000);

    gasItems["TMP-000103"].planned_sale_price = 23500;
    const recRes = await (
      await fetch(`${base}/reconcile?rolling=3`, {
        method: "POST",
        headers: { "X-Internal-Sync-Token": "sched-secret-123" },
      })
    ).json();
    assert.equal(recRes.success, true);
    assert.equal(mockSupabase.state.products.get("TMP-000103").is_test, true);
    assert.equal(mockSupabase.state.products.get("TMP-000103").planned_sale_price, 23500);
    assert.equal(mockSupabase.state.products.get("TMP-000101").is_test, false);
  } finally {
    server.close();
  }
});
