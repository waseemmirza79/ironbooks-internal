import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/clients/[id]/uncat-income/[scanId]/email-draft
 *
 * Generates a client-confirmation email asking the business owner who
 * paid each unidentified deposit. Branded HTML + plain-text.
 *
 * Body: { filter?: "ask_client" | "all_unresolved" }
 * Defaults to "all_unresolved".
 */

const BRAND = {
  teal: "#2D7A75",
  tealLight: "#E8F2F0",
  tealDark: "#1F5D58",
  tealLighter: "#F4F9F8",
  navy: "#0F1F2E",
  slate: "#475569",
  lightSlate: "#94A3B8",
  border: "#CBD5E1",
  white: "#FFFFFF",
  amber: "#D97706",
  amberLight: "#FEF3C7",
};

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; scanId: string }> }
) {
  const { id: clientLinkId, scanId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: client } = await service
    .from("client_links")
    .select("id, client_name")
    .eq("id", clientLinkId)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  const { data: scan } = await service
    .from("uncat_income_scans" as any)
    .select("id, client_link_id")
    .eq("id", scanId)
    .eq("client_link_id", clientLinkId)
    .single();
  if (!scan) return NextResponse.json({ error: "Scan not found" }, { status: 404 });

  const body = (await request.json().catch(() => ({}))) as { filter?: string };
  const filter = body.filter || "all_unresolved";

  let q = service
    .from("uncat_income_items" as any)
    .select("*")
    .eq("scan_id", scanId);

  if (filter === "ask_client") {
    q = q.eq("resolution", "ask_client");
  } else {
    // "all_unresolved" used to include EVERY non-executed row — that pulled
    // in items already resolved as apply_to_invoice / write_off / etc, so the
    // email asked clients about deposits the bookkeeper had already handled.
    // Restrict to genuinely-needs-input statuses: pending (nothing picked yet)
    // and ask_client (explicitly queued).
    q = q.in("resolution", ["pending", "ask_client"]);
  }

  const { data: itemsRaw } = await q
    .order("txn_date", { ascending: true });
  const items = ((itemsRaw as any[]) || []) as Array<{
    txn_date: string;
    amount: number;
    description: string;
    private_note: string;
    bank_account_name: string | null;
    customer_name: string | null;
  }>;

  if (items.length === 0) {
    return NextResponse.json(
      {
        error:
          filter === "ask_client"
            ? "No items marked 'Ask Client' yet — mark some deposits Ask Client first."
            : "Nothing to ask the client about — every deposit is already resolved or executed.",
      },
      { status: 400 }
    );
  }

  const clientName = (client as any).client_name as string;
  const firstName = clientName.split(/[ ,]/)[0] || "there";
  const totalAmount = items.reduce((s, i) => s + Number(i.amount || 0), 0);

  const subject = `Quick question on ${items.length} deposit${items.length === 1 ? "" : "s"} — ${clientName}`;
  const emailText = buildPlain({ firstName, clientName, items, totalAmount });
  const emailHtml = buildHtml({ firstName, clientName, items, totalAmount });

  return NextResponse.json({
    ok: true,
    subject,
    email_text: emailText,
    email_html: emailHtml,
    deposit_count: items.length,
    total_amount: totalAmount,
  });
}

function fmtMoney(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface BuildOpts {
  firstName: string;
  clientName: string;
  items: Array<{
    txn_date: string;
    amount: number;
    description: string;
    private_note: string;
    bank_account_name: string | null;
    customer_name: string | null;
  }>;
  totalAmount: number;
}

function buildPlain(opts: BuildOpts): string {
  const lines: string[] = [];
  lines.push(`Hi ${opts.firstName},`);
  lines.push("");
  lines.push(
    `We're cleaning up the books for ${opts.clientName} and found ${opts.items.length} deposit${opts.items.length === 1 ? "" : "s"} (totaling ${fmtMoney(opts.totalAmount)}) sitting in "Uncategorized Income" because we couldn't tell who paid them. Can you reply with the customer name + invoice number for each?`
  );
  lines.push("");
  lines.push(`If you genuinely can't tell, mark it OTHER — pick one:`);
  lines.push(`  A) Customer payment (give us name + invoice if you know it)`);
  lines.push(`  B) Prepayment / retainer with no invoice yet (we'll move to Customer Deposits)`);
  lines.push(`  C) Not a real sale — refund / duplicate / transfer`);
  lines.push(`  D) Not sure — let's hop on a call`);
  lines.push("");
  lines.push(`────────────────────────────────────────`);
  lines.push("");

  opts.items.slice(0, 60).forEach((it, idx) => {
    const desc = it.description || it.private_note || "(no description)";
    const bank = it.bank_account_name ? ` · ${it.bank_account_name}` : "";
    lines.push(`${idx + 1}. ${it.txn_date}  —  ${fmtMoney(it.amount)}${bank}`);
    lines.push(`     Description: ${desc.slice(0, 100)}${desc.length > 100 ? "…" : ""}`);
    lines.push(`     Your answer (customer + invoice, or A/B/C/D): _______`);
    lines.push("");
  });

  if (opts.items.length > 60) {
    lines.push(
      `(${opts.items.length - 60} more deposits not listed here — we'll cover them in a follow-up.)`
    );
    lines.push("");
  }

  lines.push(`Thanks for the help — this gets us close to a clean balance sheet.`);
  lines.push("");
  lines.push(`— Ironbooks`);

  return lines.join("\n");
}

function buildHtml(opts: BuildOpts): string {
  const rows = opts.items
    .slice(0, 60)
    .map((it, idx) => {
      const rowBg = idx % 2 === 0 ? BRAND.white : BRAND.tealLighter;
      const desc = it.description || it.private_note || "(no description)";
      const bank = it.bank_account_name ? ` · ${escapeHtml(it.bank_account_name)}` : "";
      return `
        <div style="margin-bottom:14px;background:${rowBg};border:1px solid ${BRAND.border};border-radius:8px;overflow:hidden;">
          <div style="background:${BRAND.teal};color:${BRAND.white};padding:8px 12px;display:flex;justify-content:space-between;font-family:'Figtree','Helvetica Neue',sans-serif;">
            <div style="font-weight:700;font-size:13px;">${idx + 1}. ${escapeHtml(it.txn_date)}${bank}</div>
            <div style="font-weight:700;font-size:13px;">${escapeHtml(fmtMoney(it.amount))}</div>
          </div>
          <div style="padding:8px 12px;font-family:'Figtree','Helvetica Neue',sans-serif;font-size:12px;color:${BRAND.slate};">
            <div style="font-style:italic;margin-bottom:6px;">${escapeHtml(desc.slice(0, 140))}${desc.length > 140 ? "…" : ""}</div>
            <div style="color:${BRAND.navy};"><strong>Your answer:</strong> _______________________</div>
          </div>
        </div>`;
    })
    .join("");

  const overflow =
    opts.items.length > 60
      ? `<div style="padding:8px 12px;color:${BRAND.lightSlate};font-size:11px;font-style:italic;">(${opts.items.length - 60} more deposits not listed here — we'll follow up.)</div>`
      : "";

  return `<!doctype html>
<html><body style="margin:0;padding:0;background:${BRAND.tealLight};font-family:'Figtree','Helvetica Neue',sans-serif;color:${BRAND.navy};">
  <div style="max-width:640px;margin:24px auto;background:${BRAND.white};border:1px solid ${BRAND.border};border-radius:12px;overflow:hidden;">
    <div style="background:${BRAND.navy};color:${BRAND.white};padding:16px 20px;font-size:14px;font-weight:600;letter-spacing:0.02em;">
      Ironbooks · ${escapeHtml(opts.clientName)} · Deposit Identification
    </div>
    <div style="padding:20px;font-size:14px;line-height:1.55;color:${BRAND.navy};">
      <p style="margin:0 0 12px;">Hi ${escapeHtml(opts.firstName)},</p>
      <p style="margin:0 0 12px;">We're cleaning up the books for <strong>${escapeHtml(opts.clientName)}</strong> and found <strong>${opts.items.length} deposit${opts.items.length === 1 ? "" : "s"}</strong> (totaling <strong>${escapeHtml(fmtMoney(opts.totalAmount))}</strong>) sitting in "Uncategorized Income" because we couldn't tell who paid them.</p>
      <p style="margin:0 0 12px;">Can you reply with the <strong>customer name + invoice number</strong> for each one? If you genuinely can't tell, mark it as one of these:</p>
      <div style="background:${BRAND.amberLight};border:1px solid ${BRAND.amber};border-radius:8px;padding:10px 14px;margin:0 0 16px;font-size:13px;color:${BRAND.navy};">
        <div><strong>A)</strong> Customer payment (give us name + invoice if you know it)</div>
        <div><strong>B)</strong> Prepayment / retainer with no invoice yet — we'll move to Customer Deposits</div>
        <div><strong>C)</strong> Not a real sale — refund / duplicate / transfer</div>
        <div><strong>D)</strong> Not sure — let's hop on a call</div>
      </div>
      ${rows}
      ${overflow}
      <p style="margin:16px 0 0;">Thanks for the help — this gets us close to a clean balance sheet.</p>
      <p style="margin:8px 0 0;color:${BRAND.slate};">— Ironbooks</p>
    </div>
  </div>
</body></html>`;
}
