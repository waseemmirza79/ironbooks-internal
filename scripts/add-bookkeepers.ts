// One-off: pre-provision three bookkeepers with their correct display
// names (auto-provision-on-signin would otherwise derive "Rheamae" /
// "Gazzlemae" from the email local-part).
//
// Mirrors app/api/admin/users/invite/route.ts but uses createUser (silent,
// email_confirm:true — no invite email) since @ironbooks.com team members
// sign in self-serve via the normal magic-link login. The users-row id
// MUST match the auth user id, so we create the auth user first.
//
// Idempotent: skips anyone who already has a users row; reuses an existing
// auth user if one's already there for that email.
import { readFileSync } from "fs";
const env = readFileSync(".env.local", "utf8");
for (const line of env.split("\n")) {
  const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { createClient } from "@supabase/supabase-js";

const svc: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

const BOOKKEEPERS = [
  { email: "rheamae@ironbooks.com", full_name: "Rhea" },
  { email: "melvira@ironbooks.com", full_name: "Melvira" },
  { email: "gazzlemae@ironbooks.com", full_name: "Gazzle" },
];

async function findAuthUserByEmail(email: string): Promise<string | null> {
  // Admin API has no get-by-email; page through listUsers (small directory).
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await svc.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    const hit = (data?.users || []).find(
      (u: any) => (u.email || "").toLowerCase() === email.toLowerCase()
    );
    if (hit) return hit.id;
    if (!data?.users || data.users.length < 200) break;
  }
  return null;
}

(async () => {
  for (const bk of BOOKKEEPERS) {
    const email = bk.email.toLowerCase();
    try {
      // 1. Already in users table? Skip.
      const { data: existingRow } = await svc
        .from("users")
        .select("id, email, full_name, role")
        .eq("email", email)
        .maybeSingle();
      if (existingRow) {
        console.log(`SKIP  ${email} — users row exists (${existingRow.full_name}, ${existingRow.role})`);
        continue;
      }

      // 2. Get-or-create the auth user (silent; confirmed so they can sign in).
      let authId = await findAuthUserByEmail(email);
      if (authId) {
        console.log(`      ${email} — reusing existing auth user ${authId.slice(0, 8)}`);
      } else {
        const { data: created, error: createErr } = await svc.auth.admin.createUser({
          email,
          email_confirm: true,
          user_metadata: { full_name: bk.full_name, role: "bookkeeper" },
        });
        if (createErr || !created?.user) {
          throw new Error(`createUser failed: ${createErr?.message || "no user returned"}`);
        }
        authId = created.user.id;
        console.log(`      ${email} — created auth user ${authId.slice(0, 8)}`);
      }

      // 3. Insert the profile row keyed to the auth id.
      const { error: insertErr } = await svc.from("users").insert({
        id: authId,
        email,
        full_name: bk.full_name,
        role: "bookkeeper",
        is_active: true,
      });
      if (insertErr) throw new Error(`users insert failed: ${insertErr.message}`);

      await svc.from("audit_log").insert({
        event_type: "bookkeeper_provisioned",
        user_id: authId,
        request_payload: { email, full_name: bk.full_name, method: "add-bookkeepers script" },
      });

      console.log(`ADDED ${email} → ${bk.full_name} (bookkeeper)`);
    } catch (err: any) {
      console.error(`FAIL  ${email}: ${err?.message}`);
    }
  }

  // Verify final state
  console.log("\n=== Final state ===");
  const { data: rows } = await svc
    .from("users")
    .select("email, full_name, role, is_active")
    .in("email", BOOKKEEPERS.map((b) => b.email));
  for (const r of rows || []) {
    console.log(`  ${r.email}  ${r.full_name}  ${r.role}  active=${r.is_active}`);
  }
})();
