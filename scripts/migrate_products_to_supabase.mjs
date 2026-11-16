#!/usr/bin/env node
/**
 * Idempotent migration script: Copies ALL products (including dummy & archived rows)
 * from Google Sheets (via current GAS Web App) into the dedicated Supabase Product Master DB.
 *
 * Usage:
 *   node scripts/migrate_products_to_supabase.mjs
 *
 * Reads configuration from environment variables or `.env.supabase.local` (never committed to Git).
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mapGasProductToSupabaseBundle } from "../cloud-run/products-api/src/productMapper.mjs";
import { upsertProductBundle } from "../cloud-run/products-api/src/productsRepository.mjs";

const requireFromApi = createRequire(
  new URL("../cloud-run/products-api/package.json", import.meta.url)
);
const { createClient } = requireFromApi("@supabase/supabase-js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");

export function loadLocalEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    const val = line
      .slice(eqIdx + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "");
    if (key && !process.env[key]) {
      process.env[key] = val;
    }
  }
}

export function resolveDefaultGasUrl() {
  if (process.env.GAS_WEB_APP_URL) return process.env.GAS_WEB_APP_URL.trim();
  const feConfigPath = path.resolve(
    ROOT_DIR,
    "..",
    "bis-ec-frontend-drive-import",
    "src",
    "config",
    "googleSheets.ts"
  );
  if (fs.existsSync(feConfigPath)) {
    const src = fs.readFileSync(feConfigPath, "utf8");
    const m = src.match(/https:\/\/script\.google\.com\/macros\/s\/[^"'\s]+\/exec/);
    if (m) return m[0];
  }
  throw new Error("GAS_WEB_APP_URL is required");
}

async function fetchJsonWithRetry(url, retries = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { method: "GET" });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 800 * attempt));
      }
    }
  }
  throw lastErr;
}

async function mapPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= items.length) break;
        results[idx] = await worker(items[idx], idx);
      }
    }
  );
  await Promise.all(runners);
  return results;
}

async function main() {
  loadLocalEnvFile(path.join(ROOT_DIR, ".env.supabase.local"));

  const supabaseUrl = (process.env.SUPABASE_URL || "").trim();
  const serviceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!supabaseUrl || !serviceRoleKey) {
    console.error(
      "[ERROR] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.supabase.local or environment."
    );
    process.exit(1);
  }

  const gasUrl = resolveDefaultGasUrl();
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const startedAt = Date.now();
  console.log("[1/4] Fetching full product master list (record_status=all) from GAS...");
  const listJson = await fetchJsonWithRetry(`${gasUrl}?mode=admin&record_status=all`);
  if (!listJson || listJson.success !== true || !Array.isArray(listJson.products)) {
    throw new Error("Invalid list response from GAS");
  }

  // GAS unpaginated default returns sheet rows in reverse order (newest first).
  // Reverse back to ascending sheet row order so row_seq 1 = oldest sheet row, N = newest sheet row.
  const orderedSummaries = listJson.products.slice().reverse();
  const totalCount = orderedSummaries.length;
  console.log(`[1/4] Retrieved ${totalCount} products from Google Sheets.`);

  console.log("[2/4] Fetching per-product detail (images, translation, pokemon_card, document)...");
  let fetchedCount = 0;
  const bundles = await mapPool(orderedSummaries, 6, async (summary, index) => {
    const rowSeq = index + 1;
    const pid = String(summary.product_id || "").trim();
    const detailJson = await fetchJsonWithRetry(
      `${gasUrl}?mode=admin&product_id=${encodeURIComponent(pid)}`
    );
    if (!detailJson || detailJson.success !== true || !detailJson.product) {
      throw new Error(
        `Failed to fetch detail for ${pid}: ${detailJson?.error || "empty product"}`
      );
    }
    fetchedCount++;
    if (fetchedCount % 25 === 0 || fetchedCount === totalCount) {
      console.log(`  ...fetched detail ${fetchedCount}/${totalCount}`);
    }
    return mapGasProductToSupabaseBundle({
      summary,
      detail: detailJson.product,
      rowSeq,
    });
  });

  console.log("[3/4] Upserting all product bundles idempotently into Supabase...");
  let upsertedCount = 0;
  await mapPool(bundles, 8, async (bundle) => {
    await upsertProductBundle(supabase, bundle);
    upsertedCount++;
    if (upsertedCount % 25 === 0 || upsertedCount === totalCount) {
      console.log(`  ...upserted ${upsertedCount}/${totalCount}`);
    }
  });

  console.log("[4/4] Synchronizing products.row_seq identity sequence...");
  const { data: maxSeq, error: seqErr } = await supabase.rpc("sync_products_row_seq");
  if (seqErr) {
    console.warn(`[WARN] sync_products_row_seq warning: ${seqErr.message}`);
  } else {
    console.log(`  row_seq sequence synchronized to ${maxSeq}`);
  }

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `[DONE] Successfully migrated/synced ${totalCount} products to Supabase in ${elapsedSec}s.`
  );
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((err) => {
    console.error("[FATAL]", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

