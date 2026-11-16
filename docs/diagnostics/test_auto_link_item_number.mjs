import assert from "node:assert/strict";
import fs from "node:fs";
import module from "node:module";
import path from "node:path";
import vm from "node:vm";

const frontendDir = "c:/Users/aij/Documents/bis-ec-frontend-drive-import";
const relayPath = path.join(
  frontendDir,
  "supabase/functions/documents-relay/index.ts"
);

// Load .env / .env.local (never print secret values)
for (const envName of [".env", ".env.local"]) {
  const p = path.join(frontendDir, envName);
  if (fs.existsSync(p)) {
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const idx = t.indexOf("=");
      if (idx > 0) {
        const k = t.slice(0, idx).trim();
        let v = t.slice(idx + 1).trim();
        if (
          (v.startsWith('"') && v.endsWith('"')) ||
          (v.startsWith("'") && v.endsWith("'"))
        ) {
          v = v.slice(1, -1);
        }
        if (!process.env[k]) process.env[k] = v;
      }
    }
  }
}

const gasCfg = fs.readFileSync(
  path.join(frontendDir, "src/config/googleSheets.ts"),
  "utf8"
);
const liveGasUrl = (gasCfg.match(
  /https:\/\/script\.google\.com\/macros\/s\/[^"'\s]+/
) || [""])[0];
const liveSupabaseUrl = process.env.VITE_PUBLIC_SUPABASE_URL || "";
const liveSupabaseKey = process.env.VITE_PUBLIC_SUPABASE_ANON_KEY || "";

/**
 * Compile and load `supabase/functions/documents-relay/index.ts` in an isolated VM
 * with a custom `createClient` implementation and `Deno.env` map.
 */
function createRelayHarness({ createClientImpl, envMap, fetchImpl }) {
  const tsSource = fs.readFileSync(relayPath, "utf8");
  // Replace Deno URL imports with global hooks injected into the VM context
  const patchedTs = tsSource
    .replace(
      /import\s*\{\s*serve\s*\}\s*from\s*["'][^"']+["'];?/,
      "const serve = globalThis.__mockServe;"
    )
    .replace(
      /import\s*\{\s*createClient\s*\}\s*from\s*["'][^"']+["'];?/,
      "const createClient = globalThis.__mockCreateClient;"
    );

  const jsCode = module.stripTypeScriptTypes(patchedTs, { mode: "transform" });

  let capturedHandler = null;
  const sandbox = {
    console,
    URL,
    URLSearchParams,
    Headers,
    Request,
    Response,
    AbortController,
    TextEncoder,
    crypto: globalThis.crypto,
    setTimeout,
    clearTimeout,
    fetch: fetchImpl || globalThis.fetch,
    Deno: {
      env: {
        get(key) {
          return envMap[key];
        },
      },
    },
    __mockServe(fn) {
      capturedHandler = fn;
    },
    __mockCreateClient(...args) {
      return createClientImpl(...args);
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(jsCode, sandbox, { filename: "documents-relay/index.ts" });
  assert.equal(typeof capturedHandler, "function", "serve() handler captured");

  return async function invoke(body) {
    const req = new Request("https://mock.local/functions/v1/documents-relay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const res = await capturedHandler(req);
    const json = await res.json();
    return { status: res.status, data: json };
  };
}

/**
 * Full in-memory Supabase query builder mock supporting documents, document_lines, document_product_links.
 */
function createInMemorySupabase(initialState, options = {}) {
  const db = {
    documents: structuredClone(initialState.documents || []),
    document_lines: structuredClone(initialState.document_lines || []),
    document_product_links: structuredClone(
      initialState.document_product_links || []
    ),
  };
  let idSeq = 1;

  function makeBuilder(table) {
    const state = {
      op: "select",
      selectSpec: "*",
      filters: [],
      payload: null,
      singleMode: null, // "single" | "maybeSingle"
    };

    const builder = {
      select(spec = "*") {
        if (state.op === "select") state.op = "select";
        state.selectSpec = spec;
        return builder;
      },
      insert(payload) {
        state.op = "insert";
        state.payload = payload;
        return builder;
      },
      update(payload) {
        state.op = "update";
        state.payload = payload;
        return builder;
      },
      eq(col, val) {
        state.filters.push((row) => row[col] === val);
        return builder;
      },
      in(col, vals) {
        const set = new Set(vals);
        state.filters.push((row) => set.has(row[col]));
        return builder;
      },
      order() {
        return builder;
      },
      limit() {
        return builder;
      },
      single() {
        state.singleMode = "single";
        return execute();
      },
      maybeSingle() {
        state.singleMode = "maybeSingle";
        return execute();
      },
      then(resolve, reject) {
        return execute().then(resolve, reject);
      },
    };

    async function execute() {
      if (options.failTable === table) {
        return {
          data: null,
          error: { message: `Simulated DB failure on ${table}` },
        };
      }

      const rows = db[table];
      if (!rows) throw new Error(`Unknown table: ${table}`);

      const enrichRow = (row) => {
        const clone = structuredClone(row);
        if (
          table === "document_lines" &&
          String(state.selectSpec).includes("document:documents")
        ) {
          clone.document =
            structuredClone(
              db.documents.find((d) => d.id === clone.document_id)
            ) || null;
        }
        if (
          table === "document_product_links" &&
          String(state.selectSpec).includes("line:document_lines")
        ) {
          const ln = db.document_lines.find(
            (l) => l.id === clone.document_line_id
          );
          if (ln) {
            const lnClone = structuredClone(ln);
            lnClone.document =
              structuredClone(
                db.documents.find((d) => d.id === lnClone.document_id)
              ) || null;
            clone.line = lnClone;
          } else {
            clone.line = null;
          }
        }
        return clone;
      };

      if (state.op === "select") {
        const matched = rows
          .filter((r) => state.filters.every((fn) => fn(r)))
          .map(enrichRow);
        if (state.singleMode === "maybeSingle") {
          return { data: matched[0] ?? null, error: null };
        }
        if (state.singleMode === "single") {
          if (matched.length !== 1) {
            return { data: null, error: { message: "Row not found" } };
          }
          return { data: matched[0], error: null };
        }
        return { data: matched, error: null };
      }

      if (state.op === "insert") {
        const items = Array.isArray(state.payload)
          ? state.payload
          : [state.payload];
        const inserted = [];
        for (const item of items) {
          if (table === "document_product_links") {
            // Enforce UNIQUE (document_line_id, product_id, link_type) across all rows (including soft-deleted!)
            const dup = rows.find(
              (r) =>
                r.document_line_id === item.document_line_id &&
                r.product_id === item.product_id &&
                r.link_type === (item.link_type || "primary_cost")
            );
            if (dup) {
              return {
                data: null,
                error: {
                  code: "23505",
                  message:
                    'duplicate key value violates unique constraint "uq_doc_product_links"',
                },
              };
            }
          }
          const now = new Date().toISOString();
          const newRow = {
            id: item.id || `mock-link-${idSeq++}`,
            is_deleted: false,
            created_at: now,
            updated_at: now,
            ...structuredClone(item),
          };
          rows.push(newRow);
          inserted.push(enrichRow(newRow));
        }
        if (state.singleMode === "single") {
          return { data: inserted[0], error: null };
        }
        return { data: inserted, error: null };
      }

      if (state.op === "update") {
        const matched = rows.filter((r) => state.filters.every((fn) => fn(r)));
        for (const r of matched) {
          Object.assign(r, structuredClone(state.payload));
        }
        const out = matched.map(enrichRow);
        if (state.singleMode === "single") {
          if (out.length !== 1) {
            return { data: null, error: { message: "Update target not found" } };
          }
          return { data: out[0], error: null };
        }
        return { data: out, error: null };
      }

      throw new Error(`Unsupported op: ${state.op}`);
    }

    return builder;
  }

  return {
    db,
    client: {
      from(table) {
        return makeBuilder(table);
      },
    },
  };
}

/**
 * Strictly READ-ONLY PostgREST client wrapper for safe verification against live production DB.
 * Any non-SELECT operation throws immediately before making any network call!
 */
function createReadOnlyLiveSupabaseClient(supabaseUrl, anonKey) {
  let writeAttempted = false;
  function makeBuilder(table) {
    const state = {
      selectSpec: "*",
      params: [],
      singleMode: null,
    };
    const builder = {
      select(spec = "*") {
        state.selectSpec = spec.replace(/\s+/g, "");
        return builder;
      },
      insert() {
        writeAttempted = true;
        throw new Error(`FORBIDDEN_LIVE_WRITE: insert on ${table}`);
      },
      update() {
        writeAttempted = true;
        throw new Error(`FORBIDDEN_LIVE_WRITE: update on ${table}`);
      },
      delete() {
        writeAttempted = true;
        throw new Error(`FORBIDDEN_LIVE_WRITE: delete on ${table}`);
      },
      eq(col, val) {
        state.params.push([col, `eq.${val}`]);
        return builder;
      },
      in(col, vals) {
        const encoded = vals.map((v) => `"${String(v).replace(/"/g, '\\"')}"`).join(",");
        state.params.push([col, `in.(${encoded})`]);
        return builder;
      },
      maybeSingle() {
        state.singleMode = "maybeSingle";
        return execute();
      },
      single() {
        state.singleMode = "single";
        return execute();
      },
      then(resolve, reject) {
        return execute().then(resolve, reject);
      },
    };

    async function execute() {
      const qs = new URLSearchParams([
        ["select", state.selectSpec],
        ...state.params,
      ]).toString();
      const res = await fetch(`${supabaseUrl}/rest/v1/${table}?${qs}`, {
        method: "GET",
        headers: {
          apikey: anonKey,
          Authorization: `Bearer ${anonKey}`,
        },
      });
      const text = await res.text();
      if (!res.ok) {
        return { data: null, error: { message: `REST ${res.status}: ${text}` } };
      }
      const rows = JSON.parse(text);
      if (state.singleMode === "maybeSingle") {
        return { data: rows[0] ?? null, error: null };
      }
      if (state.singleMode === "single") {
        return rows.length === 1
          ? { data: rows[0], error: null }
          : { data: null, error: { message: "Not single" } };
      }
      return { data: rows, error: null };
    }

    return builder;
  }

  return {
    wasWriteAttempted: () => writeAttempted,
    client: {
      from(table) {
        return makeBuilder(table);
      },
    },
  };
}

let passed = 0;
async function runTest(name, fn) {
  await fn();
  passed++;
  console.log(`  PASS [${passed}] ${name}`);
}

(async () => {
  console.log("=== Part 1: Unit / Contract Verification (Isolated In-Memory Mock) ===");

  const baseDocs = [
    {
      id: "doc-auc-1",
      document_number: "443654",
      supplier_name: "オークネット",
      issue_date: "2025-11-18",
      file_name: "20251118_計算書_443654.pdf",
      drive_file_url: "https://drive.example/doc-auc-1",
      status: "processed",
      total_amount: 23452,
      is_deleted: false,
    },
    {
      id: "doc-auc-2",
      document_number: "388577",
      supplier_name: "オークネット",
      issue_date: "2025-04-22",
      file_name: "20250422_計算書_388577.pdf",
      drive_file_url: "https://drive.example/doc-auc-2",
      status: "lines_registered",
      total_amount: 132704,
      is_deleted: false,
    },
    {
      id: "doc-kome-1",
      document_number: null,
      supplier_name: "KOMEHYO",
      issue_date: "2026-03-18",
      file_name: "komehyo_20260318.pdf",
      drive_file_url: null,
      status: "lines_registered",
      total_amount: null,
      is_deleted: false,
    },
  ];

  const baseLines = [
    // 1. Unique unlinked line with confirmed tax (item 20500 + fee 820 + tax 2050 + fee_tax 82 = 23452)
    {
      id: "line-unique-rec",
      document_id: "doc-auc-1",
      page_number: 1,
      line_number: 1,
      reception_number_raw: "842-33225",
      reception_number_normalized: "842-33225",
      lot_number: "842",
      branch_number: "33225",
      auction_bid_number: "0080328",
      item_name_raw: "スカルプリント 長袖Ｔシャツ その他",
      brand_name_raw: "CHROME HEARTS",
      category_hint: "アパレル",
      transaction_type: "purchase",
      item_amount: 20500,
      fee_amount: 820,
      tax_amount: 2050,
      fee_tax_amount: 82,
      other_expense_amount: null,
      other_expense_tax_amount: null,
      total_line_amount: 23452,
      match_status: "unlinked",
      is_canceled: false,
      is_active: true,
      is_deleted: false,
    },
    // 2. Line without leading zero ("80328") to prove exact string match (no leading-zero stripping!)
    {
      id: "line-no-zero-bid",
      document_id: "doc-auc-2",
      page_number: 1,
      line_number: 1,
      reception_number_raw: "815-10001",
      auction_bid_number: "80328",
      item_name_raw: "テストスニーカー",
      transaction_type: "purchase",
      item_amount: 30000,
      fee_amount: 1000,
      tax_amount: 3000,
      fee_tax_amount: 100,
      other_expense_amount: null,
      other_expense_tax_amount: null,
      total_line_amount: 34100,
      match_status: "unlinked",
      is_canceled: false,
      is_active: true,
      is_deleted: false,
    },
    // 3 & 4. Duplicate auction_bid_number = "64014" across two documents/dates
    {
      id: "line-dup-1",
      document_id: "doc-auc-1",
      page_number: 1,
      line_number: 2,
      reception_number_raw: "849-20866",
      auction_bid_number: "64014",
      item_name_raw: "モノグラム ジャケット",
      transaction_type: "purchase",
      item_amount: 57000,
      fee_amount: 2280,
      tax_amount: 5700,
      fee_tax_amount: 228,
      other_expense_amount: null,
      other_expense_tax_amount: null,
      total_line_amount: 65208,
      match_status: "unlinked",
      is_canceled: false,
      is_active: true,
      is_deleted: false,
    },
    {
      id: "line-dup-2",
      document_id: "doc-auc-2",
      page_number: 1,
      line_number: 2,
      reception_number_raw: "815-47526",
      auction_bid_number: "64014",
      item_name_raw: "カリグラフィ ジャケット",
      transaction_type: "purchase",
      item_amount: 59000,
      fee_amount: 2360,
      tax_amount: 5900,
      fee_tax_amount: 236,
      other_expense_amount: null,
      other_expense_tax_amount: null,
      total_line_amount: 67496,
      match_status: "unlinked",
      is_canceled: false,
      is_active: true,
      is_deleted: false,
    },
    // 5 & 6. Cross-column collision ("50001" is reception_number_raw on one line and auction_bid_number on another)
    {
      id: "line-cross-rec",
      document_id: "doc-auc-1",
      page_number: 1,
      line_number: 3,
      reception_number_raw: "50001",
      auction_bid_number: "99001",
      item_name_raw: "受付番号50001の商品",
      transaction_type: "purchase",
      item_amount: 10000,
      fee_amount: 500,
      tax_amount: 1000,
      fee_tax_amount: 50,
      total_line_amount: 11550,
      match_status: "unlinked",
      is_canceled: false,
      is_active: true,
      is_deleted: false,
    },
    {
      id: "line-cross-bid",
      document_id: "doc-auc-2",
      page_number: 1,
      line_number: 3,
      reception_number_raw: "815-99999",
      auction_bid_number: "50001",
      item_name_raw: "商品番号50001の商品",
      transaction_type: "purchase",
      item_amount: 20000,
      fee_amount: 1000,
      tax_amount: 2000,
      fee_tax_amount: 100,
      total_line_amount: 23100,
      match_status: "unlinked",
      is_canceled: false,
      is_active: true,
      is_deleted: false,
    },
    // 7. Line already linked to another product (TMP-000134) + soft-deleted link on TMP-000159
    {
      id: "line-conflict-other",
      document_id: "doc-auc-1",
      page_number: 1,
      line_number: 4,
      reception_number_raw: "777-11111",
      auction_bid_number: "71111",
      item_name_raw: "既リンク競合テスト品",
      transaction_type: "purchase",
      item_amount: 20500,
      fee_amount: 820,
      tax_amount: 2050,
      fee_tax_amount: 82,
      total_line_amount: 23452,
      match_status: "confirmed",
      is_canceled: false,
      is_active: true,
      is_deleted: false,
    },
    // 8. Tax-unconfirmed line (KOMEHYO style: total_line_amount === null, tax === null)
    {
      id: "line-komehyo-notax",
      document_id: "doc-kome-1",
      page_number: 1,
      line_number: 1,
      reception_number_raw: "78-3",
      auction_bid_number: null,
      item_name_raw: "KOMEHYO アパレル品",
      transaction_type: "purchase",
      item_amount: 55000,
      fee_amount: 2750,
      tax_amount: null,
      fee_tax_amount: null,
      total_line_amount: null,
      match_status: "unlinked",
      is_canceled: false,
      is_active: true,
      is_deleted: false,
    },
    // 9. Discrepant line (component gross = 23452, but total_line_amount = 21320)
    {
      id: "line-discrepant",
      document_id: "doc-auc-2",
      page_number: 1,
      line_number: 5,
      reception_number_raw: "666-99999",
      auction_bid_number: null,
      item_name_raw: "内訳不整合テスト品",
      transaction_type: "purchase",
      item_amount: 20500,
      fee_amount: 820,
      tax_amount: 2050,
      fee_tax_amount: 82,
      total_line_amount: 21320,
      match_status: "unlinked",
      is_canceled: false,
      is_active: true,
      is_deleted: false,
    },
    // 10. Line with prior soft-deleted link for TMP-REACTIVATE
    {
      id: "line-soft-deleted",
      document_id: "doc-auc-2",
      page_number: 1,
      line_number: 6,
      reception_number_raw: "555-12345",
      auction_bid_number: "51234",
      item_name_raw: "再有効化テスト品",
      transaction_type: "purchase",
      item_amount: 15000,
      fee_amount: 600,
      tax_amount: 1500,
      fee_tax_amount: 60,
      total_line_amount: 17160,
      match_status: "unlinked",
      is_canceled: false,
      is_active: true,
      is_deleted: false,
    },
  ];

  const baseLinks = [
    {
      id: "lk-hist-159",
      document_line_id: "line-conflict-other",
      product_id: "TMP-000159",
      link_type: "primary_cost",
      allocated_amount: 21320,
      allocation_method: "direct",
      match_method: "manual",
      status: "unlinked",
      is_deleted: true,
      deleted_at: "2026-10-29T05:00:00Z",
    },
    {
      id: "lk-active-134",
      document_line_id: "line-conflict-other",
      product_id: "TMP-000134",
      link_type: "primary_cost",
      allocated_amount: 21320,
      allocation_method: "direct",
      match_method: "manual",
      status: "confirmed",
      is_deleted: false,
      confirmed_at: "2026-10-29T07:37:29Z",
    },
    {
      id: "lk-soft-reactivate",
      document_line_id: "line-soft-deleted",
      product_id: "TMP-REACTIVATE",
      link_type: "primary_cost",
      allocated_amount: 15600,
      allocation_method: "direct",
      match_method: "manual",
      status: "unlinked",
      is_deleted: true,
      deleted_at: "2026-10-29T06:00:00Z",
    },
  ];

  const mem = createInMemorySupabase({
    documents: baseDocs,
    document_lines: baseLines,
    document_product_links: baseLinks,
  });

  const invoke = createRelayHarness({
    createClientImpl: () => mem.client,
    envMap: {
      SUPABASE_URL: "https://mock.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "mock-service-role",
      GAS_WEBHOOK_URL: "",
      GAS_ADMIN_SECRET: "",
    },
  });

  await runTest(
    "1. 一意候補（受付番号完全一致）: 商品代金+落札手数料+確認済み税額の税込総額(23,452円)で確定紐付けし、processed書類ステータスを維持する",
    async () => {
      const res = await invoke({
        action: "auto_link_product_by_item_number",
        product_id: "TMP-TEST-001",
        auction_item_number: "842-33225",
      });
      assert.equal(res.status, 200);
      assert.equal(res.data.success, true);
      assert.equal(res.data.linked, true);
      assert.equal(res.data.is_reused, false);
      assert.equal(res.data.status, "linked");
      assert.equal(res.data.matched_number_type, "reception_number");
      assert.equal(res.data.match_method, "reception_number_exact");
      assert.equal(res.data.tax_confirmed, true);
      assert.equal(res.data.allocated_amount, 23452);
      assert.equal(res.data.link.allocated_amount, 23452);
      assert.equal(res.data.product_cost.total_allocated_cost, 23452);
      // Verify live refreshDocumentStatus behavior (eb74432 / c0062a0: 1 of 4 lines confirmed -> partially_matched)
      const doc1 = mem.db.documents.find((d) => d.id === "doc-auc-1");
      assert.equal(doc1.status, "partially_matched");
    }
  );

  await runTest(
    "2. 同じ要求の再送（冪等性）: リンクを二重作成せず is_reused: true で既存リンクと原価(23,452円)を返す",
    async () => {
      const linksBefore = mem.db.document_product_links.length;
      const res = await invoke({
        action: "auto_link_product_by_item_number",
        product_id: "TMP-TEST-001",
        auction_item_number: "842-33225",
      });
      assert.equal(res.status, 200);
      assert.equal(res.data.linked, true);
      assert.equal(res.data.is_reused, true);
      assert.equal(res.data.status, "already_linked_same_product");
      assert.equal(res.data.allocated_amount, 23452);
      assert.equal(res.data.product_cost.total_allocated_cost, 23452);
      assert.equal(mem.db.document_product_links.length, linksBefore);
    }
  );

  await runTest(
    "3. 番号種別の非混同 & 先頭ゼロ保持: '0080328' と '80328' を区別し、number_type='reception_number' 指定時は商品番号列にマッチさせない",
    async () => {
      // Searching '80328' with number_type='reception_number' must NOT match auction_bid_number='80328'
      const wrongType = await invoke({
        action: "auto_link_product_by_item_number",
        product_id: "TMP-TEST-002",
        auction_item_number: "80328",
        number_type: "reception_number",
      });
      assert.equal(wrongType.status, 200);
      assert.equal(wrongType.data.linked, false);
      assert.equal(wrongType.data.status, "no_match");

      // Searching '80328' (auto) matches ONLY line-no-zero-bid (NOT '0080328'!)
      const exactNoZero = await invoke({
        action: "auto_link_product_by_item_number",
        product_id: "TMP-TEST-002",
        auction_item_number: "80328",
      });
      assert.equal(exactNoZero.status, 200);
      assert.equal(exactNoZero.data.linked, true);
      assert.equal(exactNoZero.data.matched_number_type, "auction_bid_number");
      assert.equal(exactNoZero.data.match_method, "auction_bid_number_exact");
      assert.equal(exactNoZero.data.candidate.document_line_id, "line-no-zero-bid");
      assert.equal(exactNoZero.data.allocated_amount, 34100);
    }
  );

  await runTest(
    "4. 候補なし（0件）および空欄番号: リンクを書かず理由を返し、商品登録成功を取り消さない",
    async () => {
      const linksBefore = mem.db.document_product_links.length;
      const noMatch = await invoke({
        action: "auto_link_product_by_item_number",
        product_id: "TMP-TEST-NOMATCH",
        auction_item_number: "999-99999",
      });
      assert.equal(noMatch.status, 200);
      assert.equal(noMatch.data.success, true);
      assert.equal(noMatch.data.linked, false);
      assert.equal(noMatch.data.status, "no_match");
      assert.equal(noMatch.data.reason_code, "NO_MATCHING_LINE");
      assert.equal(noMatch.data.product_registration_preserved, true);

      const emptyRes = await invoke({
        action: "auto_link_product_by_item_number",
        product_id: "TMP-TEST-EMPTY",
        auction_item_number: "   ",
      });
      assert.equal(emptyRes.status, 200);
      assert.equal(emptyRes.data.linked, false);
      assert.equal(emptyRes.data.status, "skipped_empty_item_number");
      assert.equal(mem.db.document_product_links.length, linksBefore);
    }
  );

  await runTest(
    "5. 複数候補（同一商品番号 '64014' が複数書類に存在）: 単体ではリンクを書かず候補一覧を返し、supplier_name + issue_date 指定時は1件に絞って紐付けできる",
    async () => {
      const linksBefore = mem.db.document_product_links.length;
      const multi = await invoke({
        action: "auto_link_product_by_item_number",
        product_id: "TMP-TEST-MULTI",
        auction_item_number: "64014",
      });
      assert.equal(multi.status, 200);
      assert.equal(multi.data.linked, false);
      assert.equal(multi.data.status, "multiple_candidates");
      assert.equal(multi.data.reason_code, "MULTIPLE_MATCHING_LINES");
      assert.equal(multi.data.candidate_count, 2);
      assert.ok(multi.data.suggested_narrowing_fields.includes("issue_date"));
      assert.equal(mem.db.document_product_links.length, linksBefore);

      // Narrow with supplier_name + issue_date -> unique 1 candidate -> links!
      const narrowed = await invoke({
        action: "auto_link_product_by_item_number",
        product_id: "TMP-TEST-MULTI",
        auction_item_number: "64014",
        supplier_name: "オークネット",
        issue_date: "2025-11-18",
      });
      assert.equal(narrowed.status, 200);
      assert.equal(narrowed.data.linked, true);
      assert.equal(narrowed.data.candidate.document_line_id, "line-dup-1");
      assert.equal(narrowed.data.allocated_amount, 65208);
    }
  );

  await runTest(
    "6. 受付番号と商品番号の両列に別行がヒットした場合: 混同せず AMBIGUOUS_NUMBER_TYPE で保留し、number_type 明示で解消できる",
    async () => {
      const linksBefore = mem.db.document_product_links.length;
      const ambig = await invoke({
        action: "auto_link_product_by_item_number",
        product_id: "TMP-TEST-AMBIG",
        auction_item_number: "50001",
      });
      assert.equal(ambig.status, 200);
      assert.equal(ambig.data.linked, false);
      assert.equal(ambig.data.status, "multiple_candidates");
      assert.equal(ambig.data.reason_code, "AMBIGUOUS_NUMBER_TYPE");
      assert.equal(ambig.data.candidate_count, 2);
      assert.ok(ambig.data.suggested_narrowing_fields.includes("number_type"));
      assert.equal(mem.db.document_product_links.length, linksBefore);

      const resolved = await invoke({
        action: "auto_link_product_by_item_number",
        product_id: "TMP-TEST-AMBIG",
        auction_item_number: "50001",
        number_type: "auction_bid_number",
      });
      assert.equal(resolved.status, 200);
      assert.equal(resolved.data.linked, true);
      assert.equal(resolved.data.candidate.document_line_id, "line-cross-bid");
      assert.equal(resolved.data.allocated_amount, 23100);
    }
  );

  await runTest(
    "7. 既存リンク競合保護: 他商品(TMP-000134)の確定リンクも自商品の他明細リンクも黙って解除・移動せず conflict_existing_link を返す",
    async () => {
      const linksBefore = structuredClone(mem.db.document_product_links);

      // 7a. Target line already linked to TMP-000134
      const conflictOther = await invoke({
        action: "auto_link_product_by_item_number",
        product_id: "TMP-000161",
        auction_item_number: "777-11111",
      });
      assert.equal(conflictOther.status, 200);
      assert.equal(conflictOther.data.linked, false);
      assert.equal(conflictOther.data.status, "conflict_existing_link");
      assert.equal(
        conflictOther.data.reason_code,
        "LINE_ALREADY_LINKED_TO_OTHER_PRODUCT"
      );
      assert.equal(conflictOther.data.conflicting_links[0].product_id, "TMP-000134");
      assert.equal(conflictOther.data.unlinked_history[0].product_id, "TMP-000159");

      // 7b. Target product (TMP-TEST-001) already linked to line-unique-rec; trying to link to unlinked line-dup-2 ("815-47526")
      const conflictSelf = await invoke({
        action: "auto_link_product_by_item_number",
        product_id: "TMP-TEST-001",
        auction_item_number: "815-47526",
      });
      assert.equal(conflictSelf.status, 200);
      assert.equal(conflictSelf.data.linked, false);
      assert.equal(conflictSelf.data.status, "conflict_existing_link");
      assert.equal(
        conflictSelf.data.reason_code,
        "PRODUCT_ALREADY_LINKED_TO_OTHER_LINE"
      );

      assert.deepEqual(mem.db.document_product_links, linksBefore);
    }
  );

  await runTest(
    "8. 論理削除済み過去リンクの安全な再有効化、税額未確認行(KOMEHYO)の割当、内訳不整合行の保留、DBエラー時の非破壊応答",
    async () => {
      // 8a. Soft-deleted link on TMP-REACTIVATE is restored with updated tax-included amount (17,160) without 23505 error
      const reactivated = await invoke({
        action: "auto_link_product_by_item_number",
        product_id: "TMP-REACTIVATE",
        auction_item_number: "555-12345",
      });
      assert.equal(reactivated.status, 200);
      assert.equal(reactivated.data.linked, true);
      assert.equal(reactivated.data.allocated_amount, 17160);
      assert.equal(reactivated.data.link.id, "lk-soft-reactivate");

      // 8b. Tax-unconfirmed line (total_line_amount = null): uses item_amount + fee_amount (57,750) with tax_confirmed = false
      const komeRes = await invoke({
        action: "auto_link_product_by_item_number",
        product_id: "TMP-TEST-KOME",
        auction_item_number: "78-3",
      });
      assert.equal(komeRes.status, 200);
      assert.equal(komeRes.data.linked, true);
      assert.equal(komeRes.data.tax_confirmed, false);
      assert.equal(komeRes.data.allocated_amount, 57750);

      // 8c. Discrepant line (20500+820+2050+82=23452 != total_line_amount 21320): refuses to write!
      const discRes = await invoke({
        action: "auto_link_product_by_item_number",
        product_id: "TMP-TEST-DISC",
        auction_item_number: "666-99999",
      });
      assert.equal(discRes.status, 200);
      assert.equal(discRes.data.linked, false);
      assert.equal(discRes.data.status, "amount_error");
      assert.equal(discRes.data.reason_code, "LINE_TOTAL_DISCREPANCY");

      // 8d. Simulated DB error -> linked: false, product_registration_preserved: true
      const errMem = createInMemorySupabase(
        { documents: baseDocs, document_lines: baseLines, document_product_links: baseLinks },
        { failTable: "document_lines" }
      );
      const errInvoke = createRelayHarness({
        createClientImpl: () => errMem.client,
        envMap: {
          SUPABASE_URL: "https://mock.supabase.co",
          SUPABASE_SERVICE_ROLE_KEY: "mock-service-role",
        },
      });
      const dbErrRes = await errInvoke({
        action: "auto_link_product_by_item_number",
        product_id: "TMP-TEST-ERR",
        auction_item_number: "842-33225",
      });
      assert.equal(dbErrRes.status, 500);
      assert.equal(dbErrRes.data.linked, false);
      assert.equal(dbErrRes.data.product_registration_preserved, true);
    }
  );

  console.log("\n=== Part 2: Read-Only Live Production Snapshot Verification (ZERO DB Writes!) ===");
  const roLive = createReadOnlyLiveSupabaseClient(liveSupabaseUrl, liveSupabaseKey);
  const invokeLiveReadOnly = createRelayHarness({
    createClientImpl: () => roLive.client,
    envMap: {
      SUPABASE_URL: liveSupabaseUrl,
      SUPABASE_SERVICE_ROLE_KEY: liveSupabaseKey,
      GAS_WEBHOOK_URL: liveGasUrl,
      GAS_ADMIN_SECRET: "",
    },
  });

  await runTest(
    "9. [実データ読取のみ] TMP-000161 × '842-33225': 受付番号1件一致を検出し、TMP-000134 との確定リンク競合 & TMP-000159 解除履歴を返却（DB書込ゼロ）",
    async () => {
      const res = await invokeLiveReadOnly({
        action: "auto_link_product_by_item_number",
        product_id: "TMP-000161",
        auction_item_number: "842-33225",
      });
      assert.equal(res.status, 200);
      assert.equal(res.data.linked, false);
      assert.equal(res.data.status, "conflict_existing_link");
      assert.equal(res.data.reason_code, "LINE_ALREADY_LINKED_TO_OTHER_PRODUCT");
      assert.equal(res.data.matched_number_type, "reception_number");
      assert.equal(
        res.data.candidate.document_line_id,
        "ddfb5fa8-68a5-4826-a6a1-35e49789740a"
      );
      assert.equal(res.data.candidate.auction_bid_number, "80328");
      assert.equal(res.data.candidate.expected_allocated_amount, 23452);
      assert.equal(res.data.conflicting_links.length, 1);
      assert.equal(res.data.conflicting_links[0].product_id, "TMP-000134");
      assert.equal(
        res.data.conflicting_links[0].product_summary?.record_status,
        "active"
      );
      assert.ok(
        res.data.unlinked_history.some((h) => h.product_id === "TMP-000159")
      );
      assert.equal(roLive.wasWriteAttempted(), false);
      console.log(
        "     Live conflict response summary:",
        JSON.stringify({
          status: res.data.status,
          reason_code: res.data.reason_code,
          matched_number_type: res.data.matched_number_type,
          expected_allocated_amount: res.data.candidate.expected_allocated_amount,
          conflicting_links: res.data.conflicting_links,
          unlinked_history: res.data.unlinked_history,
        })
      );
    }
  );

  await runTest(
    "10. [実データ読取のみ / dry_run] 実台帳での一意未紐付け(855-19157)・複数候補(64014)と仕入日絞り込み・候補なし検証（DB書込ゼロ）",
    async () => {
      // Unique unlinked line on live DB with dry_run: true
      const dryUnique = await invokeLiveReadOnly({
        action: "auto_link_product_by_item_number",
        product_id: "TMP-DRYRUN-CHECK",
        auction_item_number: "855-19157",
        dry_run: true,
      });
      assert.equal(dryUnique.status, 200);
      assert.equal(dryUnique.data.linked, false);
      assert.equal(dryUnique.data.would_link, true);
      assert.equal(dryUnique.data.status, "dry_run_ready_to_link");
      assert.equal(dryUnique.data.matched_number_type, "reception_number");
      assert.equal(
        dryUnique.data.expected_allocated_amount,
        dryUnique.data.candidate.total_line_amount
      );

      // Multiple candidates on live DB ('64014')
      const liveMulti = await invokeLiveReadOnly({
        action: "auto_link_product_by_item_number",
        product_id: "TMP-DRYRUN-CHECK",
        auction_item_number: "64014",
        dry_run: true,
      });
      assert.equal(liveMulti.status, 200);
      assert.equal(liveMulti.data.linked, false);
      assert.equal(liveMulti.data.status, "multiple_candidates");
      assert.equal(liveMulti.data.candidate_count, 2);

      // Narrow '64014' by supplier_name + issue_date ('2025-12-23') with dry_run: true
      const liveNarrowed = await invokeLiveReadOnly({
        action: "auto_link_product_by_item_number",
        product_id: "TMP-DRYRUN-CHECK",
        auction_item_number: "64014",
        supplier_name: "オークネット",
        issue_date: "2025-12-23",
        dry_run: true,
      });
      assert.equal(liveNarrowed.status, 200);
      assert.equal(liveNarrowed.data.would_link, true);
      assert.equal(liveNarrowed.data.expected_allocated_amount, 65208);

      // No match on live DB
      const liveNoMatch = await invokeLiveReadOnly({
        action: "auto_link_product_by_item_number",
        product_id: "TMP-DRYRUN-CHECK",
        auction_item_number: "NO-SUCH-ITEM-999999",
        dry_run: true,
      });
      assert.equal(liveNoMatch.status, 200);
      assert.equal(liveNoMatch.data.status, "no_match");

      assert.equal(roLive.wasWriteAttempted(), false);
    }
  );

  console.log(`\nALL ${passed}/${passed} TESTS PASSED SUCCESSFULLY (ZERO LIVE WRITES)!`);
})();
