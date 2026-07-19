import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getValidToken, fetchAllAccounts, QBOReauthRequiredError } from "@/lib/qbo";
import { computeRetypePlans, type RetypeMasterRow } from "@/lib/coa-retype";
import { retypeAccountViaRebuild, setAccountParent, ensureAccountExists } from "@/lib/coa-reclass-je";
import { applyMasterCoaToClient, type MasterCoaRow } from "@/lib/apply-master-coa";
import { computeCoaDrift, type DriftMasterRow } from "@/lib/coa-drift";
import { normalizeAccountName } from "@/lib/account-name";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/admin/coa-audit/fix — apply the DETERMINISTIC, SAFE half of COA
 * standardization for ONE client, from the audit view, after the admin has
 * reviewed the specific changes (Mike, 2026-07-16: fix the COAs one by one,
 * verifying the changes and the re-write):
 *   - retype: change AccountType/SubType so an account sits in the right
 *     statement section (fixes the "expenses below net profit" case). Does
 *     NOT move transactions.
 *   - create: create a missing REQUIRED master account (additive).
 *
 * Deliberately NOT here: merges / renames / deletes of the non-master
 * sprawl — those move transactions + inactivate accounts and stay in the
 * reviewed per-client COA cleanup with its date-scope + guards.
 *
 * Server revalidates: it recomputes the plans from live QBO + master and
 * only touches accounts/names the client selected that are STILL valid
 * candidates — the request is never trusted blindly.
 *
 * Body: { client_link_id, retype_account_ids?: string[], create_account_names?: string[] }
 */
export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if ((actor as any)?.role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const clientLinkId = String(body.client_link_id || "");
  const retypeIds: string[] = Array.isArray(body.retype_account_ids) ? body.retype_account_ids.map(String) : [];
  const createNames: string[] = Array.isArray(body.create_account_names) ? body.create_account_names.map(String) : [];
  const reparentIds: string[] = Array.isArray(body.reparent_account_ids) ? body.reparent_account_ids.map(String) : [];
  if (!clientLinkId) return NextResponse.json({ error: "client_link_id required" }, { status: 400 });
  if (retypeIds.length === 0 && createNames.length === 0 && reparentIds.length === 0) {
    return NextResponse.json({ error: "Nothing selected to fix" }, { status: 400 });
  }

  const { data: clientLink } = await service
    .from("client_links")
    .select("id, client_name, qbo_realm_id, jurisdiction, industry, is_active")
    .eq("id", clientLinkId)
    .single();
  if (!clientLink?.qbo_realm_id || !clientLink.is_active) {
    return NextResponse.json({ error: "Client not found / inactive / not QBO-connected" }, { status: 404 });
  }

  const industryRaw = ((clientLink as any).industry as string) || "painters";
  const jurisdiction = clientLink.jurisdiction || "US";
  let { data: masterRows } = await service
    .from("master_coa")
    .select("account_name, qbo_account_type, qbo_account_subtype, parent_account_name, is_parent, is_required")
    .eq("industry", industryRaw)
    .eq("jurisdiction", jurisdiction);
  if ((!masterRows || masterRows.length === 0) && industryRaw !== "painters") {
    ({ data: masterRows } = await service
      .from("master_coa")
      .select("account_name, qbo_account_type, qbo_account_subtype, parent_account_name, is_parent, is_required")
      .eq("industry", "painters")
      .eq("jurisdiction", jurisdiction));
  }
  if (!masterRows || masterRows.length === 0) {
    return NextResponse.json({ error: `No master COA for ${jurisdiction}/${industryRaw}` }, { status: 400 });
  }

  const summary = {
    retyped: [] as string[],
    created: [] as string[],
    renested: [] as string[],
    failed: [] as { account: string; message: string }[],
  };
  const retypeDebug: Array<{ account: string; newType: string; createdType: string | null; moved: number | null; inactivated: boolean | null }> = [];

  try {
    const accessToken = await getValidToken(clientLink.id, service as any, "ironbooks/api/admin/coa-audit/fix");

    // Reclass window: current calendar YTD, including closed months (Mike's call).
    const now = new Date();
    const ytdStart = `${now.getFullYear()}-01-01`;
    const ytdEnd = now.toISOString().slice(0, 10);

    // ── Retypes — QBO can't change a used account's type, so rebuild: rename the
    //    wrong-typed account aside, create a correctly-typed twin with the real
    //    name, and drain the old one into it (per-month JEs + Item re-point +
    //    sub-account detach), then retire the old one. Revalidated vs live QBO. ──
    if (retypeIds.length > 0) {
      const accounts = await fetchAllAccounts(clientLink.qbo_realm_id, accessToken);
      const byId = new Map(accounts.map((a) => [a.Id, a]));
      const validPlans = computeRetypePlans({
        masterRows: masterRows as RetypeMasterRow[],
        clientAccounts: accounts.filter((a) => a.Active !== false),
      }).filter((p) => retypeIds.includes(p.qbo_account_id));

      for (const plan of validPlans) {
        const current: any = byId.get(plan.qbo_account_id);
        if (!current) {
          summary.failed.push({ account: plan.current_name, message: "account no longer exists" });
          continue;
        }
        try {
          const r = await retypeAccountViaRebuild({
            realmId: clientLink.qbo_realm_id,
            accessToken,
            account: current,
            newType: plan.new_type,
            newSubType: plan.new_subtype,
            startDate: ytdStart,
            endDate: ytdEnd,
            allAccounts: accounts,
          });
          retypeDebug.push({
            account: plan.current_name, newType: plan.new_type, createdType: r.createdType,
            moved: r.drain?.moved ?? null, inactivated: r.drain?.inactivated ?? null,
          });
          if (r.failures.length === 0) {
            summary.retyped.push(`${plan.current_name} → ${plan.new_type}`);
          } else {
            summary.failed.push({ account: plan.current_name, message: r.failures.join("; ") });
          }
        } catch (e: any) {
          summary.failed.push({ account: plan.current_name, message: e.message });
        }
      }
    }

    // ── Re-nest: master-matched accounts sitting under a legacy parent
    //    ("General business expenses:Software Subscriptions" — Camellia)
    //    move under their master heading, creating the heading if the client
    //    doesn't have it yet; master-top-level accounts detach to top level.
    //    Revalidated against live drift — selections that no longer apply
    //    are skipped, not trusted. ──
    if (reparentIds.length > 0) {
      const accounts = await fetchAllAccounts(clientLink.qbo_realm_id, accessToken);
      const drift = computeCoaDrift(accounts as any, masterRows as DriftMasterRow[]);
      const byId = new Map(accounts.map((a) => [a.Id, a]));
      const masterByNorm = new Map(
        (masterRows as any[]).map((m) => [normalizeAccountName(m.account_name), m])
      );
      const live = [...accounts]; // grows as we create headings
      for (const wp of drift.wrongParent.filter((w) => reparentIds.includes(w.id))) {
        const acct: any = byId.get(wp.id);
        if (!acct) {
          summary.failed.push({ account: wp.name, message: "account no longer exists" });
          continue;
        }
        try {
          if (!wp.masterParent) {
            await setAccountParent({ realmId: clientLink.qbo_realm_id, accessToken, account: acct, parentId: null });
            summary.renested.push(`${wp.name} → top level`);
            continue;
          }
          const parentRow: any = masterByNorm.get(normalizeAccountName(wp.masterParent));
          const parent = await ensureAccountExists({
            realmId: clientLink.qbo_realm_id,
            accessToken,
            name: wp.masterParent,
            accountType: parentRow?.qbo_account_type || acct.AccountType,
            accountSubType: parentRow?.qbo_account_subtype || acct.AccountSubType,
            allAccounts: live,
          });
          if (!live.some((a) => a.Id === parent.Id)) live.push(parent);
          if ((parent.AccountType || "") !== (acct.AccountType || "")) {
            summary.failed.push({
              account: wp.name,
              message: `can't nest under "${parent.Name}" — types differ (${acct.AccountType} vs ${parent.AccountType}); retype first`,
            });
            continue;
          }
          await setAccountParent({ realmId: clientLink.qbo_realm_id, accessToken, account: acct, parentId: parent.Id });
          summary.renested.push(`${wp.name} → ${parent.Name}`);
        } catch (e: any) {
          summary.failed.push({ account: wp.name, message: String(e?.message || e).slice(0, 250) });
        }
      }
    }

    // ── Create missing required (additive; reuses the existing primitive,
    //    scoped to the selected names, which it re-verifies as missing) ──
    if (createNames.length > 0) {
      const applyResult = await applyMasterCoaToClient({
        clientLinkId: clientLink.id,
        clientName: clientLink.client_name,
        realmId: clientLink.qbo_realm_id,
        accessToken,
        masterRows: masterRows as MasterCoaRow[],
        dryRun: false,
        onlyLeafNames: createNames,
      });
      summary.created = applyResult.created;
      for (const e of applyResult.errors) summary.failed.push(e);
    }

    // Fresh drift so the UI updates the conformance score in place.
    const accountsAfter = await fetchAllAccounts(clientLink.qbo_realm_id, accessToken);
    const drift = computeCoaDrift(accountsAfter as any, masterRows as DriftMasterRow[]);

    await service.from("audit_log").insert({
      event_type: "coa_audit_fix",
      user_id: user.id,
      request_payload: {
        client_link_id: clientLink.id,
        client_name: clientLink.client_name,
        retyped: summary.retyped,
        created: summary.created,
        renested: summary.renested,
        failed: summary.failed,
        conformance_after: drift.conformancePct,
      } as any,
    } as any);

    return NextResponse.json({ ...summary, retypeDebug, drift });
  } catch (err: any) {
    if (err instanceof QBOReauthRequiredError) {
      return NextResponse.json({ error: "QBO reconnect required", reauth: true }, { status: 200 });
    }
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
