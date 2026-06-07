import { readFileSync } from "fs";
const env = readFileSync(".env.local", "utf8");
for (const line of env.split("\n")) {
  const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

import { createClient } from "@supabase/supabase-js";
const supa = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

(async () => {
  const { data: admin } = await supa
    .from("users").select("id, email, role")
    .eq("role", "admin").limit(1).single();
  if (!admin) { console.error("no admin"); process.exit(1); }

  const { data, error } = await supa.auth.admin.generateLink({
    type: "magiclink",
    email: admin.email,
    options: { redirectTo: "http://localhost:3003/auth/callback" },
  });
  if (error) { console.error("err:", error.message); process.exit(1); }

  // Token_hash is what verifyOtp consumes client-side
  console.log("EMAIL:", admin.email);
  console.log("USER_ID:", admin.id);
  console.log("TOKEN_HASH:", data.properties?.hashed_token);
  console.log("ACTION_LINK:", data.properties?.action_link);
})();
