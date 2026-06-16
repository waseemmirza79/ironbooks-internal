/**
 * Backfill client_links contact fields from the Double contacts export
 * (transcribed below). This is the AUTHORITATIVE source — it matches each
 * Double contact to a SNAP client by business name and fills the contact
 * name / email / phone (blanks only by default).
 *
 * Why a static table instead of the Double API: the Double API key isn't
 * available in this environment, and this export is the exact, reviewed data.
 *
 * For businesses with multiple contacts, the primary is chosen by:
 *   - exclude obvious bookkeeper rows (label contains "bookkeeper")
 *   - prefer a contact whose email domain echoes the business name
 *   - else the first listed
 *
 * Country is derived from the jurisdiction enum (not stored here).
 *
 * Run:
 *   npx tsx scripts/backfill-from-double-export.ts            # dry run
 *   npx tsx scripts/backfill-from-double-export.ts --apply    # write
 */

import { readFileSync } from "fs";

const env = readFileSync(".env.local", "utf8");
for (const raw of env.split("\n")) {
  const line = raw.replace(/\r$/, "").trim();
  if (!line || line.startsWith("#")) continue;
  const eq = line.indexOf("=");
  if (eq === -1) continue;
  const key = line.slice(0, eq).trim();
  let val = line.slice(eq + 1).trim();
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1);
  }
  if (key && !process.env[key]) process.env[key] = val;
}

import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const OVERWRITE = process.argv.includes("--overwrite");

const supa = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

interface Contact {
  first: string;
  last: string;
  email: string;
  phone: string | null;
  business: string; // exactly as it appears in Double's "Client(s)" column
  bookkeeper?: boolean;
}

// ── Double export (transcribed from the two screenshots) ──
const CONTACTS: Contact[] = [
  { first: "Adam", last: "Flagg", email: "aflagg@macatawapainting.com", phone: "+1 (269) 251-7218", business: "Macatawa Painting LLC" },
  { first: "Austin", last: "Lipp", email: "alipp75@gmail.com", phone: null, business: "Under the Sun Fl, LLC" },
  { first: "Austin", last: "York", email: "austinyork@paintersnear-me.com", phone: "+1 (613) 818-9737", business: "Painters Near Me" },
  { first: "Avie", last: "Aguirre", email: "avieaguirre0@gmail.com", phone: "+1 (256) 668-9409", business: "Camellia Painting Pros" },
  { first: "Ben", last: "Dorozio", email: "bmdorozio@gmail.com", phone: null, business: "BMD Painting Ltd" },
  { first: "Branson", last: "Despres", email: "branson@desprespainting.com", phone: "+1 (803) 206-0419", business: "Despres Painting LLC" },
  { first: "Brittney", last: "Tough", email: "brittneytough@gmail.com", phone: "+1 (403) 988-2261", business: "Brittney Tough" },
  { first: "Calum", last: "Bechervaise", email: "calum@toppickpainters.com", phone: "+1 (613) 243-8555", business: "Top Pick Painters Inc" },
  { first: "Calvin", last: "Larcher", email: "maplecitypainters@gmail.com", phone: "+1 (613) 890-3000", business: "Maple City Painters & Renovations Inc." },
  { first: "Casey", last: "Cole", email: "casey@colouryourlife.ca", phone: null, business: "Colour Your Life Paint & Design" },
  { first: "Charlie", last: "Schenck", email: "charles@charlesandcrewpainting.com", phone: null, business: "Charles and Crew Painting" },
  { first: "Cliff", last: "Kranenburg", email: "cliff@kranenburgpainting.com", phone: "+1 (941) 524-2937", business: "Cliff Kranenburg Painting Inc." },
  { first: "Cloud", last: "Minkler", email: "cminkler@minklerpainting.com", phone: null, business: "Minkler Painting LLC" },
  { first: "Damon", last: "Lee", email: "damon@onarollmn.com", phone: "+1 (612) 226-4442", business: "On A Roll" },
  { first: "Daniel", last: "Blessent", email: "dan@blessentbuilding.com", phone: "+1 (619) 787-6050", business: "Blessent Building LLC" },
  { first: "Daniel", last: "Garner", email: "dan@paintersnear-me.com", phone: "+1 (613) 818-9737", business: "Painters Near Me" },
  { first: "Daniel", last: "McCarthy", email: "danmccarth1@gmail.com", phone: "+1 (709) 743-2235", business: "Rock Bound Painting Ltd." },
  { first: "Dominic", last: "Escalante", email: "sdcp.bids@gmail.com", phone: "+1 (619) 261-0646", business: "San Diego Custom Painting" },
  { first: "Edgar", last: "Morales", email: "financialsuccess373@gmail.com", phone: "+1 (626) 502-4798", business: "BRIGHTVIEW PAINTING COMPANY" },
  { first: "Emily", last: "Escalante", email: "sdcp.emily@gmail.com", phone: "+1 (619) 261-0646", business: "San Diego Custom Painting" },
  { first: "Enrique (Alex)", last: "Jovel", email: "oriahcontracting@gmail.com", phone: "+1 (604) 612-3682", business: "Oriah Contracting Incorporated" },
  { first: "Eric", last: "Goodwill", email: "eric@renaissancepainting.ca", phone: "+1 (604) 358-4918", business: "Renaissance Solutions" },
  { first: "Erika", last: "Venegas", email: "erika@exivisual.com", phone: "+1 (630) 544-0616", business: "Exivisual DecoPainting Corp." },
  { first: "Gerard", last: "Lamothe Jr", email: "office@superiorpainting.net", phone: null, business: "Superior Painting of Tallahassee" },
  { first: "Isaac", last: "Mumma", email: "info@whiteoakpainting.com", phone: null, business: "White Oak Painting" },
  { first: "Jacob", last: "Campbell", email: "jacobcampbell96.jc@gmail.com", phone: null, business: "1 Day Refinishing Edmonton LTD" },
  { first: "Jacob", last: "Cohen", email: "jacob@neighborpaint.com", phone: null, business: "Neighborhood Painting, Inc." },
  { first: "James", last: "Mitchell", email: "jamesmpaintingllc@gmail.com", phone: "+1 (208) 640-7213", business: "James Painting LLC" },
  { first: "Jason", last: "Bozzo", email: "jason@supreme-decorating.com", phone: "+1 (905) 541-7536", business: "Supreme Decorating and Painting" },
  { first: "Jody", last: "Duxbury", email: "jodyimago@gmail.com", phone: "+1 (780) 898-6385", business: "Imago Painting And Designs LTD" },
  { first: "Joe", last: "Lionetti", email: "joelionetti@gmail.com", phone: null, business: "Lionetti Painting" },
  { first: "John", last: "Barry", email: "john@thegoodbrush.ca", phone: null, business: "The Goodbrush Painting Co" },
  { first: "John", last: "Demers", email: "finalcoatpainting403@gmail.com", phone: "+1 (403) 996-1150", business: "Final Coat Painting Inc" },
  { first: "John", last: "Power", email: "john@powerpaintingplus.com", phone: null, business: "Power Painting Plus Corp" },
  { first: "Johnny", last: "Blackstock", email: "johnny@coastcountryconstruction.com", phone: "+1 (949) 761-0451", business: "Coast and Country Construction" },
  { first: "Jordan", last: "Dorning", email: "jdorning@tarorenovationservices.com", phone: "+1 (509) 530-1391", business: "Taro Renovation Services LLC" },
  { first: "Jorden", last: "Myers", email: "jorden.myers@hubcityhues.com", phone: null, business: "Hub City Hues" },
  { first: "Josh", last: "Smith", email: "joshuasmith0912@gmail.com", phone: "+1 (941) 807-7501", business: "Coastline Architectural Painting LLC" },
  { first: "Joy", last: "Ogden", email: "joypogden@gmail.com", phone: null, business: "Premier Pro Painters Home Improvement LLC" },
  { first: "Krys", last: "Kudakiewicz", email: "info@splashofcolour.ca", phone: "+1 (613) 314-2761", business: "Splash of Colour Painting & Design" },
  { first: "Kyle", last: "Amsberry", email: "kyle@ktppaintingco.com", phone: "+1 (480) 707-3875", business: "KTP Painting Co LLC" },
  { first: "Leonard", last: "Vazquez", email: "leonard@painter1.com", phone: "+1 (512) 736-3957", business: "Painter1 of Greater North Austin" },
  { first: "Lisa", last: "Escalante", email: "sdcp.lisa@gmail.com", phone: "+1 (619) 261-0646", business: "San Diego Custom Painting" },
  { first: "Logan", last: "Platt", email: "cleancutpainters406@gmail.com", phone: "+1 (303) 746-4439", business: "Clean Cut Painters LLC" },
  { first: "Madelaine", last: "Quirk", email: "madelinebquirk@gmail.com", phone: null, business: "PictureThis!Painting" },
  { first: "Marissa", last: "Young", email: "aoc.pro.paint@gmail.com", phone: "+1 (613) 929-9781", business: "Array of Colour Incorporated" },
  { first: "Matty", last: "Wilson", email: "grandtraversepaintingco@gmail.com", phone: "+1 (231) 409-9191", business: "Grand Traverse Painting Company LLC" },
  { first: "Max", last: "Parker", email: "business@topnotchpainters.com", phone: "+1 (763) 478-7219", business: "Top Notch Painters LLC" },
  { first: "Megan", last: "Interial", email: "interialkendall@gmail.com", phone: "+1 (217) 855-7587", business: "Interial Painting LLC" },
  { first: "Michael", last: "Vesey", email: "mike.vesey@vzpaintingllc.com", phone: "+1 (717) 468-5087", business: "VZ Painting LLC" },
  { first: "Mitch", last: "Robinson", email: "mitchr@burliprepandpainting.com", phone: "+1 (905) 978-3468", business: "BURLI PREP & PAINTING" },
  { first: "Moleen", last: "Tope and Akin Bookkeeper", email: "mmukanhairi@balncd.ca", phone: null, business: "Brilliant Enterprises Inc.", bookkeeper: true },
  { first: "Nate", last: "Brown", email: "nate@truebluepainting.com", phone: null, business: "True Blue Painting" },
  { first: "Nathan", last: "Switzer", email: "nswitzer@macatawapainting.com", phone: "+1 (906) 440-2100", business: "Macatawa Painting LLC" },
  { first: "Nick", last: "Weissman", email: "nick@makeithappenpainting.com", phone: null, business: "Make It Happen Painting" },
  { first: "Oliver", last: "Amundson", email: "oliver@amundsoncustompainting.com", phone: null, business: "Amundson Custom Painting LLC" },
  { first: "Patrick", last: "Connell", email: "patrick@rocketpainter.ca", phone: "+1 (647) 401-6143", business: "RocketPainter Kingston" },
  { first: "Phillip", last: "Ogden", email: "philipallenogden@gmail.com", phone: null, business: "Premier Pro Painters Home Improvement LLC" },
  { first: "Rachel", last: "Smith", email: "rrsmithpainting@gmail.com", phone: null, business: "XPaint LLC" },
  { first: "Rich", last: "Baldwin", email: "info@baldwinpnf.com", phone: "+1 (403) 869-3341", business: "Baldwin & Co. Painting and Finishing" },
  { first: "Rich", last: "Baldwin", email: "info@baldwinpnf.com", phone: "+1 (403) 869-3341", business: "Baldwin & Co. Painting and Finishing Inc." },
  { first: "Rick", last: "Power", email: "rick@powerpaintingplus.com", phone: null, business: "Power Painting Plus Corp" },
  { first: "Rick", last: "Ridenour", email: "rick@sunsethearth.com", phone: "+1 (541) 815-4286", business: "SUNSET HEARTH AND HOME LLC" },
  { first: "Robert", last: "Gelinskey", email: "r.gelinskey@splashpaintingwi.com", phone: "+1 (262) 339-8464", business: "Splash Painting LLC" },
  { first: "Sani", last: "Bozunovich", email: "sonny@zunopainting.com", phone: null, business: "Zuno Painting LLC" },
  { first: "Temitope", last: "Olufe", email: "brilliantcolourspro@gmail.com", phone: "+1 (204) 292-9048", business: "Brilliant Enterprises Inc." },
  { first: "Travis", last: "Martin", email: "ltwoodworks94@gmail.com", phone: "+1 (519) 292-9998", business: "LT Woodworks" },
  { first: "Trevor", last: "Gerardine", email: "gerardinepaint@gmail.com", phone: "+1 (865) 203-0891", business: "Gerardine Painting" },
];

function normBiz(s: string): string {
  return String(s || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(llc|inc|incorporated|ltd|limited|corp|corporation|company|co|the)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function domainCore(email: string): string {
  const d = (email.split("@")[1] || "").toLowerCase();
  return d.replace(/\.(com|ca|net|org|co|io|biz)$/g, "").replace(/[^a-z0-9]/g, "");
}

/** Choose the primary contact for a business from its candidate rows. */
function pickPrimary(rows: Contact[], normalizedBiz: string): Contact {
  const bizTokens = normalizedBiz.replace(/\s+/g, "");
  const scored = rows.map((c) => {
    let score = 0;
    if (c.bookkeeper || /bookkeeper/i.test(c.last)) score -= 100;
    const core = domainCore(c.email);
    if (core && bizTokens && (core.includes(bizTokens) || bizTokens.includes(core))) score += 3;
    if (c.phone) score += 1; // a contact with a phone is slightly preferred
    return { c, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].c;
}

(async () => {
  console.log(`\n${APPLY ? "APPLY" : "DRY RUN"} — backfill from Double export${OVERWRITE ? " (OVERWRITE mode)" : " (fill blanks only)"}\n`);

  const { data, error } = await supa
    .from("client_links")
    .select("id, client_name, contact_first_name, contact_last_name, client_email, client_phone")
    .eq("is_active", true);
  if (error) { console.error("✗", error.message); process.exit(1); }
  const clients = (data as any[]) || [];

  // Index Double contacts by normalized business name → primary contact.
  const byBiz = new Map<string, Contact[]>();
  for (const c of CONTACTS) {
    const key = normBiz(c.business);
    if (!byBiz.has(key)) byBiz.set(key, []);
    byBiz.get(key)!.push(c);
  }
  const primaryByBiz = new Map<string, Contact>();
  for (const [key, rows] of byBiz) primaryByBiz.set(key, pickPrimary(rows, key));

  // Known name variants: SNAP client_name differs from the Double business
  // label, so register the Double contact under the SNAP name too.
  //   [Double business label, SNAP client_name]
  const ALIASES: [string, string][] = [
    ["Taro Renovation Services LLC", "Taro Painting Services"],
  ];
  for (const [doubleBiz, snapName] of ALIASES) {
    const c = primaryByBiz.get(normBiz(doubleBiz));
    if (c) primaryByBiz.set(normBiz(snapName), c);
  }

  let touched = 0, fieldsFilled = 0;
  const matchedBiz = new Set<string>();
  const noDouble: string[] = [];

  for (const cl of clients) {
    const key = normBiz(cl.client_name);
    const c = primaryByBiz.get(key);
    if (!c) { noDouble.push(cl.client_name); continue; }
    matchedBiz.add(key);

    const proposed: Record<string, string> = {};
    const want = (field: string, current: any, val: string | null) => {
      if (!val) return;
      const blank = current == null || String(current).trim() === "";
      if (OVERWRITE || blank) proposed[field] = val;
    };
    want("contact_first_name", cl.contact_first_name, c.first);
    want("contact_last_name", cl.contact_last_name, c.last);
    want("client_email", cl.client_email, c.email);
    want("client_phone", cl.client_phone, c.phone);

    const keys = Object.keys(proposed);
    if (!keys.length) continue;
    touched++;
    fieldsFilled += keys.length;
    console.log(`${cl.client_name}  ←  ${c.first} ${c.last}`);
    for (const k of keys) console.log(`    ${k}: ${proposed[k]}`);

    if (APPLY) {
      const { error: upErr } = await supa
        .from("client_links")
        .update({ ...proposed, profile_updated_at: new Date().toISOString() } as any)
        .eq("id", cl.id);
      if (upErr) console.error(`    ✗ ${upErr.message}`);
    }
  }

  // Double businesses we never matched to a SNAP client.
  const unmatchedDouble = [...byBiz.keys()]
    .filter((k) => !matchedBiz.has(k))
    .map((k) => byBiz.get(k)![0].business);

  console.log(`\n${"=".repeat(60)}`);
  console.log(`RESULTS  (${clients.length} active clients, ${CONTACTS.length} Double contacts)`);
  console.log("=".repeat(60));
  console.log(`  ${APPLY ? "Updated" : "Would update"}: ${touched} clients, ${fieldsFilled} fields`);
  if (noDouble.length) {
    console.log(`\n  SNAP clients with NO Double contact (${noDouble.length}):`);
    for (const n of noDouble.sort()) console.log(`      ${n}`);
  }
  if (unmatchedDouble.length) {
    console.log(`\n  Double businesses not matched to a SNAP client (${unmatchedDouble.length}):`);
    for (const n of unmatchedDouble.sort()) console.log(`      ${n}`);
  }
  if (!APPLY && touched) console.log(`\n→ Re-run with --apply to write.\n`);
  else console.log("");
})();
