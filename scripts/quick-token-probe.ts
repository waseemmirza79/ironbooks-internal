import { readFileSync } from "fs";
const env = readFileSync(".env.local", "utf8");
for (const line of env.split("\n")) {
  const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { createClient } from "@supabase/supabase-js";
const supa = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
import { getValidToken } from "@/lib/qbo";

(async () => {
  const { data: clients } = await supa
    .from("client_links")
    .select("id, client_name, qbo_realm_id, qbo_token_expires_at")
    .not("qbo_refresh_token", "is", null)
    .order("qbo_token_expires_at", { ascending: false })
    .limit(50);

  let healthy = 0, dead = 0;
  const healthyClients: any[] = [];
  for (const c of clients || []) {
    try {
      await getValidToken((c as any).id, supa as any);
      healthy++;
      healthyClients.push({ id: (c as any).id, name: (c as any).client_name });
    } catch (e: any) {
      dead++;
    }
  }
  console.log(`Probed ${clients?.length || 0} clients (most-recently-refreshed first)`);
  console.log(`HEALTHY: ${healthy}, DEAD: ${dead}`);
  if (healthyClients.length > 0) {
    console.log("\nHealthy clients (good for live testing):");
    for (const c of healthyClients.slice(0, 10)) console.log(`  ${c.name} -- ${c.id}`);
  }
})();
