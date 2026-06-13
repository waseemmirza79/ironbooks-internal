import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { requireStaff, requireOwnerOrSenior } from "@/lib/cleanup-system/auth";
import { getValidToken, QBOReauthRequiredError } from "@/lib/qbo";
import { analyzeAndReconcile, type UploadedStatement } from "@/lib/cleanup-system/statement-analysis";
import { discoverBankReconModule } from "@/lib/cleanup-system/modules";

export const dynamic = "force-dynamic";
export const maxDuration = 800;

/**
 * POST /api/cleanup/[runId]/analyze-statements
 *
 * Body: { statements: [{ filename, base64 }] }  (base64 = PDF bytes, no prefix)
 *
 * Reads each uploaded statement PDF with Claude, matches it to a live QBO
 * balance-sheet account, writes the QBO-vs-statement gap into a
 * bank_recon_jobs row, then re-runs the bank_recon module so the gaps
 * become proposed reconciling entries on the review screen. Returns a
 * per-file result the wizard renders for one-glance approval.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ runId: string }> }
) {
  const { runId } = await context.params;
  const supabase = await createServerSupabase();
  const auth = await requireStaff(supabase);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const statements: UploadedStatement[] = Array.isArray(body.statements) ? body.statements : [];
  if (statements.length === 0) {
    return NextResponse.json({ error: "No statements provided" }, { status: 400 });
  }
  if (statements.length > 20) {
    return NextResponse.json({ error: "Max 20 statements per upload" }, { status: 400 });
  }
  for (const s of statements) {
    if (!s.filename || !s.base64) {
      return NextResponse.json({ error: "Each statement needs filename + base64" }, { status: 400 });
    }
  }

  const service = createServiceSupabase();
  const { data: run } = await service
    .from("cleanup_runs")
    .select("client_link_id")
    .eq("id", runId)
    .single();
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });
  const clientLinkId = (run as any).client_link_id;

  const perm = await requireOwnerOrSenior(service, clientLinkId, auth.userId, auth.role);
  if (!perm.ok) return NextResponse.json({ error: perm.error }, { status: 403 });

  const { data: client } = await service
    .from("client_links")
    .select("qbo_realm_id, qbo_refresh_token")
    .eq("id", clientLinkId)
    .single();
  if (!client || !(client as any).qbo_realm_id || !(client as any).qbo_refresh_token) {
    return NextResponse.json(
      { error: "Client has no QuickBooks connection — connect QBO before analyzing statements." },
      { status: 422 }
    );
  }

  try {
    const accessToken = await getValidToken(clientLinkId, service as any);
    const { results, reconRowsWritten } = await analyzeAndReconcile(service, {
      runId,
      clientLinkId,
      qboRealmId: (client as any).qbo_realm_id,
      accessToken,
      bookkeeperId: auth.userId,
      statements,
    });

    // Re-run bank_recon discovery so the freshly-written gaps become
    // proposed reconciling entries on the review screen.
    if (reconRowsWritten > 0) {
      await discoverBankReconModule(service, runId, clientLinkId);
    }

    await service.from("audit_log").insert({
      event_type: "bs_cleanup_statements_analyzed",
      user_id: auth.userId,
      request_payload: {
        run_id: runId,
        client_link_id: clientLinkId,
        files: statements.map((s) => s.filename),
        matched: results.filter((r) => r.qbo_account_id).length,
        gaps_found: results.filter((r) => r.status === "gap_found").length,
      } as any,
    });

    return NextResponse.json({ ok: true, results, recon_rows_written: reconRowsWritten });
  } catch (err: any) {
    if (err instanceof QBOReauthRequiredError) {
      return NextResponse.json({ error: "QuickBooks needs reconnecting.", reconnect: true }, { status: 401 });
    }
    return NextResponse.json({ error: err.message || "Statement analysis failed" }, { status: 500 });
  }
}
