import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const frontendDir = path.resolve(
  import.meta.dirname,
  "../../../bis-ec-frontend-drive-import"
);

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

const supabaseUrl = process.env.VITE_PUBLIC_SUPABASE_URL || "";
const anonKey = process.env.VITE_PUBLIC_SUPABASE_ANON_KEY || "";

if (!supabaseUrl || !anonKey) {
  console.error("Missing VITE_PUBLIC_SUPABASE_URL or VITE_PUBLIC_SUPABASE_ANON_KEY");
  process.exit(1);
}

const endpoint = `${supabaseUrl.replace(/\/$/, "")}/functions/v1/documents-relay`;

async function callRelay(body) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${anonKey}`,
      apikey: anonKey,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const beforeCost134 = await callRelay({
  action: "get_product_cost",
  product_id: "TMP-000134",
});
assert.equal(beforeCost134.status, 200);
assert.equal(beforeCost134.data.links.length, 1);
assert.equal(
  beforeCost134.data.links[0].id,
  "018883e7-1664-4dee-bd41-9cacc092ffe2"
);

const autoLinkRes = await callRelay({
  action: "auto_link_product_by_item_number",
  product_id: "TMP-000161",
  auction_item_number: "842-33225",
});

if (
  autoLinkRes.status === 400 &&
  (autoLinkRes.data?.error_code === "UNSUPPORTED_ACTION" ||
    autoLinkRes.data?.error === "UNSUPPORTED_ACTION")
) {
  console.error(
    "[NOT DEPLOYED YET] Live documents-relay returned 400 UNSUPPORTED_ACTION for auto_link_product_by_item_number."
  );
  process.exit(2);
}

assert.equal(autoLinkRes.status, 200);
assert.equal(autoLinkRes.data.success, true);
assert.equal(autoLinkRes.data.linked, false);
assert.equal(autoLinkRes.data.status, "conflict_existing_link");
assert.equal(
  autoLinkRes.data.reason_code,
  "LINE_ALREADY_LINKED_TO_OTHER_PRODUCT"
);
assert.equal(autoLinkRes.data.conflicting_links[0].product_id, "TMP-000134");
assert.equal(
  autoLinkRes.data.conflicting_links[0].link_id,
  "018883e7-1664-4dee-bd41-9cacc092ffe2"
);

const afterCost134 = await callRelay({
  action: "get_product_cost",
  product_id: "TMP-000134",
});
const afterCost161 = await callRelay({
  action: "get_product_cost",
  product_id: "TMP-000161",
});

assert.equal(afterCost134.status, 200);
assert.equal(afterCost134.data.links.length, 1);
assert.equal(
  afterCost134.data.links[0].id,
  "018883e7-1664-4dee-bd41-9cacc092ffe2"
);
assert.equal(afterCost161.status, 200);
assert.equal(afterCost161.data.links.length, 0);

console.log(
  "LIVE URL VERIFICATION PASSED: conflict_existing_link returned and TMP-000134 link preserved."
);
console.log(JSON.stringify(autoLinkRes.data, null, 2));
