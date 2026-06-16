// Backfill M/E April 2026 close + promote to production. Per client:
// cleanup_range_end bumped UP to 2026-04-30 (never regressed — a client
// already reconciled through a later month keeps it), cleanup_completed_at
// set if null, daily_recon_enabled=true + daily_recon_paused=false.
// DRY by default; --apply writes.
import { readFileSync } from "fs";
const env = readFileSync(".env.local", "utf8");
for (const line of env.split("\n")) { const m = line.match(/^([A-Z_]+)="?(.*?)"?$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; }
import { createClient } from "@supabase/supabase-js";
const svc: any = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const APPLY = process.argv.includes("--apply");
const CLOSE_END = "2026-04-30";
const NAMES = [
"1 Day Refinishing Edmonton LTD","Amundson Custom Painting LLC","Array of Colour Incorporated",
"Baldwin & Co. Painting and Finishing","Baldwin & Co. Painting and Finishing Inc.","Blessent Building LLC",
"BMD Painting Ltd","BRIGHTVIEW PAINTING COMPANY","Brittney Tough","Camellia Painting Pros",
"Charles and Crew Painting","Clean Cut Painters LLC","Cliff Kranenburg Painting Inc.",
"Coastline Architectural Painting LLC","Colour Your Life Paint & Design","Despres Painting LLC",
"Exivisual DecoPainting Corp.","Final Coat Painting Inc","Hub City Hues","Imago Painting And Designs LTD",
"Interial Painting LLC","James Painting LLC","Lionetti Painting","LT Woodworks","Make It Happen Painting",
"Neighborhood Painting, Inc.","On A Roll","Oriah Contracting Incorporated","Painter1 of Greater North Austin",
"Power Painting Plus Corp","Premier Pro Painters Home Improvement LLC","Renaissance Solutions",
"Rock Bound Painting Ltd.","Supreme Decorating and Painting","Taro Renovation Services LLC",
"The Goodbrush Painting Co","Top Notch Painters LLC","Top Pick Painters Inc","True Blue Painting",
"Under the Sun Fl, LLC","White Oak Painting","Zuno Painting LLC",
];
const norm = (s:string)=>(s||"").toLowerCase().replace(/&/g," and ").replace(/[.,]/g," ")
  .replace(/\b(llc|inc|incorporated|ltd|corp|corporation|co|company)\b/g," ").replace(/[^a-z0-9]+/g," ").trim();
const HOLD = new Set(["1 Day Refinishing Edmonton LTD","Taro Renovation Services LLC"]);
(async () => {
  const { data: clients } = await svc.from("client_links")
    .select("id, client_name, cleanup_range_end, cleanup_completed_at, daily_recon_enabled, is_active").eq("is_active", true);
  const exact = new Map<string,any>(); for (const c of clients||[]) exact.set(c.client_name, c);
  const byNorm = new Map<string,any[]>(); for (const c of clients||[]){const k=norm(c.client_name); if(!byNorm.has(k))byNorm.set(k,[]); byNorm.get(k)!.push(c);}
  const targets:any[]=[]; const skipped:string[]=[];
  for (const name of NAMES) {
    if (HOLD.has(name)) { skipped.push(`${name} (HELD)`); continue; }
    if (exact.has(name)) { targets.push(exact.get(name)); continue; }
    const hits = byNorm.get(norm(name))||[];
    if (hits.length===1) targets.push(hits[0]); else skipped.push(`${name} (${hits.length} matches)`);
  }
  console.log(`${APPLY?"APPLY":"DRY RUN"} — ${targets.length} clients, ${skipped.length} held\n`);
  const now = new Date().toISOString(); let done=0, kept=0;
  for (const c of targets) {
    const cur = c.cleanup_range_end as string|null;
    const newEnd = (cur && cur >= CLOSE_END) ? cur : CLOSE_END;
    const upd:any = { daily_recon_enabled:true, daily_recon_paused:false };
    if (newEnd !== cur) upd.cleanup_range_end = newEnd;
    if (!c.cleanup_completed_at) upd.cleanup_completed_at = now;
    if (newEnd === cur) kept++;
    console.log(`${APPLY?"✓":"•"} ${c.client_name.padEnd(42)} end:${newEnd===cur?`KEPT ${cur}`:`${cur||"-"}→${newEnd}`}  done:${c.cleanup_completed_at?"kept":"set"}  prod:${c.daily_recon_enabled?"already":"→ON"}`);
    if (APPLY) {
      const { error } = await svc.from("client_links").update(upd).eq("id", c.id);
      if (error) { console.log(`    ERROR: ${error.message}`); continue; }
      await svc.from("audit_log").insert({ event_type:"backfill_april_close", request_payload:{ client_link_id:c.id, client_name:c.client_name, close_end:newEnd, promoted_to_production:true } });
      done++;
    }
  }
  console.log(`\n${targets.length} targets (${kept} kept a later close date). Held: ${skipped.join(", ")}`);
  if (APPLY) console.log(`Applied to ${done}.`);
})();
