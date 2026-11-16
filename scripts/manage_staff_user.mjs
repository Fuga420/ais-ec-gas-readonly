#!/usr/bin/env node
/**
 * Manage authorized B.I.S staff accounts in the dedicated Supabase project.
 *
 * Usage:
 *   node scripts/manage_staff_user.mjs list
 *   node scripts/manage_staff_user.mjs add <email> <password>
 *   node scripts/manage_staff_user.mjs revoke <email>
 *
 * Never logs passwords or secret keys.
 */

import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { loadLocalEnvFile } from "./migrate_products_to_supabase.mjs";

const requireFromApi = createRequire(
  new URL("../cloud-run/products-api/package.json", import.meta.url)
);
const { createClient } = requireFromApi("@supabase/supabase-js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");

async function main() {
  loadLocalEnvFile(path.join(ROOT_DIR, ".env.supabase.local"));
  const supabaseUrl = (process.env.SUPABASE_URL || "").trim();
  const serviceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!supabaseUrl || !serviceRoleKey) {
    console.error("[ERROR] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const [cmd, rawEmail, rawPassword] = process.argv.slice(2);
  const email = (rawEmail || "").trim().toLowerCase();

  if (cmd === "list") {
    const { data, error } = await supabase
      .from("staff_users")
      .select("email,is_active,created_at")
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    console.log(JSON.stringify(data || [], null, 2));
    return;
  }

  if (cmd === "add") {
    if (!email || !rawPassword || rawPassword.length < 8) {
      console.error("Usage: node scripts/manage_staff_user.mjs add <email> <password(>=8chars)>");
      process.exit(1);
    }

    const { data: listData, error: listErr } = await supabase.auth.admin.listUsers();
    if (listErr) throw new Error(listErr.message);
    const existingUser = (listData?.users || []).find(
      (u) => (u.email || "").toLowerCase() === email
    );

    if (existingUser) {
      const { error: updErr } = await supabase.auth.admin.updateUserById(
        existingUser.id,
        {
          password: rawPassword,
          email_confirm: true,
          app_metadata: { ...(existingUser.app_metadata || {}), role: "staff" },
        }
      );
      if (updErr) throw new Error(updErr.message);
    } else {
      const { error: createErr } = await supabase.auth.admin.createUser({
        email,
        password: rawPassword,
        email_confirm: true,
        app_metadata: { role: "staff" },
      });
      if (createErr) throw new Error(createErr.message);
    }

    const { error: staffErr } = await supabase.from("staff_users").upsert(
      { email, is_active: true },
      { onConflict: "email" }
    );
    if (staffErr) throw new Error(staffErr.message);

    console.log(`[OK] Authorized staff account configured: ${email}`);
    return;
  }

  if (cmd === "revoke") {
    if (!email) {
      console.error("Usage: node scripts/manage_staff_user.mjs revoke <email>");
      process.exit(1);
    }
    const { data: listData } = await supabase.auth.admin.listUsers();
    const existingUser = (listData?.users || []).find(
      (u) => (u.email || "").toLowerCase() === email
    );
    if (existingUser) {
      const nextMeta = { ...(existingUser.app_metadata || {}) };
      delete nextMeta.role;
      delete nextMeta.staff;
      await supabase.auth.admin.updateUserById(existingUser.id, {
        app_metadata: nextMeta,
      });
    }
    const { error } = await supabase
      .from("staff_users")
      .update({ is_active: false })
      .eq("email", email);
    if (error) throw new Error(error.message);
    console.log(`[OK] Revoked staff access for: ${email}`);
    return;
  }

  if (cmd === "delete") {
    if (!email) {
      console.error("Usage: node scripts/manage_staff_user.mjs delete <email>");
      process.exit(1);
    }
    const { data: listData } = await supabase.auth.admin.listUsers();
    const existingUser = (listData?.users || []).find(
      (u) => (u.email || "").toLowerCase() === email
    );
    if (existingUser) {
      const { error: delAuthErr } = await supabase.auth.admin.deleteUser(
        existingUser.id
      );
      if (delAuthErr) throw new Error(delAuthErr.message);
    }
    const { error: delStaffErr } = await supabase
      .from("staff_users")
      .delete()
      .eq("email", email);
    if (delStaffErr) throw new Error(delStaffErr.message);
    console.log(`[OK] Deleted staff account: ${email}`);
    return;
  }

  console.error("Commands: list | add <email> <password> | revoke <email> | delete <email>");
  process.exit(1);
}

main().catch((err) => {
  console.error("[ERROR]", err instanceof Error ? err.message : err);
  process.exit(1);
});
