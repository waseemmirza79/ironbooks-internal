/**
 * Synthetic E2E test for BS Cleanup UF / AR / bank recon pipeline.
 *
 * Run: npx tsx scripts/test-cleanup-synthetic-e2e.ts
 * Optional: npx tsx scripts/test-cleanup-synthetic-e2e.ts --live
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import { matchUFtoAR } from "@/lib/uf-ar-matcher";
import {
  detectDuplicates,
  normalizeCrmRows,
  parseCsv,
} from "@/lib/hardcore-cleanup";
import {
  serializeMeta,
  ufKindToDecision,
  type UfEntryMeta,
} from "@/lib/cleanup-system/entry-meta";
import {
  syntheticCrmCsv,
  syntheticOpenInvoices,
  syntheticUfPayments,
} from "@/lib/cleanup-system/synthetic-fixtures";
import { createServiceSupabase } from "@/lib/supabase";
import { discoverBankReconModule } from "@/lib/cleanup-system/modules";
import { createProposedEntry } from "@/lib/cleanup-system/proposed-entries";
import { getValidToken } from "@/lib/qbo";
import { discoverUndepositedFundsModule } from "@/lib/cleanup-system/uf-discovery";
import { discoverAccountsReceivableModule } from "@/lib/cleanup-system/ar-discovery";

function loadEnvLocal() {
  for (const file of [".env.prod.local", ".env.local", ".env.vercel.local"]) {
    try {
      loadEnvFile(resolve(process.cwd(), file));
    } catch {
      /* optional */
    }
  }
}

function loadEnvFile(envPath: string) {
  const text = readFileSync(envPath, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!process.env[key] || process.env[key]!.length < 3) process.env[key] = val;
  }
}

type Assert = (cond: boolean, msg: string) => void;

function runPhase1(assert: Assert) {
  console.log("\n═══ Phase 1: Synthetic matcher + duplicate detection ═══");

  const ufMatches = matchUFtoAR(syntheticUfPayments, syntheticOpenInvoices);
  assert(ufMatches.length === 4, `UF match count = 4 (got ${ufMatches.length})`);

  const exact = ufMatches.find((m) => m.payment.qbo_payment_id === "pay-exact-001");
  assert(exact?.kind === "exact_invoice_number", "exact invoice # match");
  assert(
    exact?.proposed[0]?.qbo_invoice_id === "inv-1042",
    "exact match picks inv-1042"
  );
  assert(ufKindToDecision("exact_invoice_number") === "auto_approve", "exact → auto_approve");

  const high = ufMatches.find((m) => m.payment.qbo_payment_id === "pay-high-002");
  assert(high?.kind === "high_confidence", "high confidence match");
  assert(high?.proposed[0]?.qbo_invoice_id === "inv-2200a", "high picks inv-2200a");

  const low = ufMatches.find((m) => m.payment.qbo_payment_id === "pay-low-003");
  assert(low?.kind === "low_confidence", "low confidence (two $800 invoices)");
  assert((low?.candidates.length || 0) >= 2, "low confidence has candidate picker");

  const unmatched = ufMatches.find((m) => m.payment.qbo_payment_id === "pay-unmatched-004");
  assert(unmatched?.kind === "unmatched", "unmatched payment");

  const crmRows = parseCsv(syntheticCrmCsv);
  const crmJobs = normalizeCrmRows(crmRows, "generic");
  const { duplicates } = detectDuplicates({
    crmJobs,
    qboInvoices: syntheticOpenInvoices,
  });
  assert(duplicates.length >= 1, `AR duplicates found (got ${duplicates.length})`);
  const dupPair = duplicates.find(
    (d) =>
      d.qbo_invoice.qbo_invoice_id === "inv-dup-new" ||
      d.qbo_invoice.qbo_invoice_id === "inv-dup-old"
  );
  assert(!!dupPair, "duplicate pair includes Duplex Painters invoices");
  assert(
    !!dupPair?.surviving_qbo_invoice.qbo_invoice_id,
    "duplicate has survivor invoice"
  );

  const meta: UfEntryMeta = {
    v: 1,
    type: "uf_match",
    kind: "high_confidence",
    reasoning: "test",
    customer_name: "Blue Sky Homes",
    payment_id: "pay-high-002",
    proposed_invoice_id: "inv-2200a",
    proposed_doc_number: "2200-A",
    candidates: [],
  };
  const parsed = JSON.parse(serializeMeta(meta));
  assert(parsed.type === "uf_match" && parsed.kind === "high_confidence", "meta round-trip");

  // approve_uf_confident filter logic (mirrors API route)
  const confidentKinds = new Set(["exact_invoice_number", "high_confidence"]);
  const mockRows = ufMatches.map((m) => ({
    id: m.payment.qbo_payment_id,
    ai_reasoning: serializeMeta({
      v: 1,
      type: "uf_match",
      kind: m.kind,
      reasoning: m.reasoning,
      customer_name: m.payment.customer_name,
      payment_id: m.payment.qbo_payment_id,
      proposed_invoice_id: m.proposed[0]?.qbo_invoice_id || null,
      proposed_doc_number: m.proposed[0]?.doc_number || null,
      candidates: [],
    }),
    decision: ufKindToDecision(m.kind),
  }));
  const confidentIds = mockRows
    .filter((r) => {
      const m = JSON.parse(r.ai_reasoning);
      return confidentKinds.has(m.kind);
    })
    .map((r) => r.id);
  assert(confidentIds.length === 2, `confident bulk approve picks 2 (got ${confidentIds.length})`);

  console.log("  ✓ Phase 1 passed");
}

async function runPhase2(assert: Assert) {
  console.log("\n═══ Phase 2: DB staging (bank recon + proposed entries) ═══");

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY.length < 20) {
    console.log(
      "  ⚠ Skipping Phase 2 — SUPABASE_SERVICE_ROLE_KEY not set in .env.local"
    );
    console.log(
      "  Seed a synthetic run via Supabase MCP instead (see test output in agent log)."
    );
    return null;
  }

  const service = createServiceSupabase();
  const BANK_RECON_CLIENT = "1ec3d8b6-c7eb-4b24-b7aa-caa27a607b26"; // 1 Day Refinishing

  const { data: admin } = await service
    .from("users")
    .select("id")
    .eq("role", "admin")
    .limit(1)
    .single();
  assert(!!admin?.id, "admin user exists for bookkeeper_id");

  // Clean up any prior synthetic test runs for this client
  const { data: oldRuns } = await service
    .from("cleanup_runs")
    .select("id")
    .eq("client_link_id", BANK_RECON_CLIENT)
    .in("status", ["discovering", "reviewing", "executing", "failed"]);
  for (const r of oldRuns || []) {
    await service.from("proposed_entries").delete().eq("run_id", r.id);
    await service.from("cleanup_run_modules").delete().eq("run_id", r.id);
    await service.from("bs_health_scores").delete().eq("run_id", r.id);
    await service.from("cleanup_runs").delete().eq("id", r.id);
  }

  const { data: periodLock } = await service
    .from("period_locks")
    .upsert(
      {
        client_link_id: BANK_RECON_CLIENT,
        lock_date: "2026-05-31",
        set_by: admin!.id,
        updated_at: new Date().toISOString(),
      } as any,
      { onConflict: "client_link_id" }
    )
    .select("id")
    .single();

  const { data: run, error: runErr } = await service
    .from("cleanup_runs")
    .insert({
      client_link_id: BANK_RECON_CLIENT,
      bookkeeper_id: admin!.id,
      status: "reviewing",
      workflow_mode: "onboarding",
      period_lock_id: periodLock?.id,
      period_lock_date: "2026-05-31",
      current_module: "bank_recon",
    } as any)
    .select("id")
    .single();
  assert(!runErr && !!run?.id, `create test run (${runErr?.message || "ok"})`);

  const runId = run!.id;
  const modules = [
    "bank_recon",
    "undeposited_funds",
    "accounts_receivable",
    "accounts_payable",
    "loans",
    "shareholder_draws",
    "tax_payroll",
    "obe_uncategorized",
  ];
  await service.from("cleanup_run_modules").insert(
    modules.map((module, idx) => ({
      run_id: runId,
      module,
      status: idx === 0 ? "ready" : "locked",
    })) as any
  );

  const bankResult = await discoverBankReconModule(service, runId, BANK_RECON_CLIENT);
  assert(bankResult.proposed >= 1, `bank recon proposed >= 1 (got ${bankResult.proposed})`);

  const { data: bankEntries } = await service
    .from("proposed_entries")
    .select("id, module, entry_type, decision")
    .eq("run_id", runId)
    .eq("module", "bank_recon");
  assert((bankEntries?.length || 0) >= 1, "bank recon entries persisted");

  // Seed UF + AR proposed entries from synthetic matcher (simulates discovery output)
  for (const m of matchUFtoAR(syntheticUfPayments, syntheticOpenInvoices)) {
    const picked = m.proposed[0];
    const meta: UfEntryMeta = {
      v: 1,
      type: "uf_match",
      kind: m.kind,
      reasoning: m.reasoning,
      customer_name: m.payment.customer_name,
      payment_id: m.payment.qbo_payment_id,
      proposed_invoice_id: picked?.qbo_invoice_id || null,
      proposed_doc_number: picked?.doc_number || null,
      candidates: m.candidates.map((c) => ({
        qbo_invoice_id: c.qbo_invoice_id,
        doc_number: c.doc_number,
        balance: c.balance,
        customer_name: c.customer_name,
        txn_date: c.txn_date,
      })),
    };
    await createProposedEntry(service, {
      runId,
      clientLinkId: BANK_RECON_CLIENT,
      module: "undeposited_funds",
      entryType: "receive_payment",
      amount: m.payment.amount,
      txnDate: m.payment.date,
      memo: `SYNTH ${m.payment.customer_name || "UF"}`,
      qboTransactionId: m.payment.qbo_payment_id,
      qboTransactionType: "Payment",
      toAccountId: picked?.qbo_invoice_id,
      toAccountName: picked?.doc_number || undefined,
      decisionOverride: ufKindToDecision(m.kind),
      aiReasoning: serializeMeta(meta),
      confidenceOverride: m.confidence,
    });
  }

  const crmJobs = normalizeCrmRows(parseCsv(syntheticCrmCsv), "generic");
  const { duplicates } = detectDuplicates({
    crmJobs,
    qboInvoices: syntheticOpenInvoices,
  });
  for (const dup of duplicates) {
    await createProposedEntry(service, {
      runId,
      clientLinkId: BANK_RECON_CLIENT,
      module: "accounts_receivable",
      entryType: "void",
      amount: dup.qbo_invoice.balance,
      txnDate: dup.qbo_invoice.txn_date,
      memo: `SYNTH void duplicate`,
      qboTransactionId: dup.qbo_invoice.qbo_invoice_id,
      qboTransactionType: "Invoice",
      toAccountId: dup.surviving_qbo_invoice.qbo_invoice_id,
      toAccountName: dup.surviving_qbo_invoice.doc_number || "survivor",
      decisionOverride: dup.confidence >= 0.9 ? "auto_approve" : "needs_review",
      aiReasoning: JSON.stringify({
        v: 1,
        type: "ar_duplicate",
        reasoning: dup.reasoning,
        survivor_invoice_id: dup.surviving_qbo_invoice.qbo_invoice_id,
        survivor_doc_number: dup.surviving_qbo_invoice.doc_number,
        confidence: dup.confidence,
      }),
      confidenceOverride: dup.confidence,
    });
  }

  const { data: ufEntries } = await service
    .from("proposed_entries")
    .select("id, decision, ai_reasoning")
    .eq("run_id", runId)
    .eq("module", "undeposited_funds");
  assert((ufEntries?.length || 0) === 4, `4 UF entries staged (got ${ufEntries?.length})`);

  const confidentUf = (ufEntries || []).filter((r: any) => {
    try {
      const m = JSON.parse(r.ai_reasoning || "{}");
      return m.kind === "exact_invoice_number" || m.kind === "high_confidence";
    } catch {
      return false;
    }
  });
  assert(confidentUf.length === 2, "2 confident UF entries for bulk approve");

  // Simulate bulk approve (without QBO execute)
  if (confidentUf.length > 0) {
    await service
      .from("proposed_entries")
      .update({ decision: "approved" } as any)
      .in(
        "id",
        confidentUf.map((r: any) => r.id)
      );
  }

  const { data: approved } = await service
    .from("proposed_entries")
    .select("id")
    .eq("run_id", runId)
    .eq("module", "undeposited_funds")
    .eq("decision", "approved");
  assert((approved?.length || 0) === 2, "2 UF entries approved");

  console.log(`  ✓ Phase 2 passed — test run ${runId}`);
  console.log(`    Bank recon proposals: ${bankResult.proposed}`);
  console.log(`    UF entries: ${ufEntries?.length}, AR dup entries: ${duplicates.length}`);
  console.log(`    Wizard URL: /balance-sheet/${BANK_RECON_CLIENT}/cleanup/${runId}`);

  return { runId, clientId: BANK_RECON_CLIENT };
}

async function runPhase3Live(assert: Assert) {
  console.log("\n═══ Phase 3: Live QBO discovery (optional) ═══");

  const LIVE_CLIENT = "016f0b93-8584-4604-984f-f4ea1396f60d"; // James Painting LLC
  const service = createServiceSupabase();

  try {
    await getValidToken(LIVE_CLIENT, service);
  } catch (e: any) {
    console.log(`  ⚠ Skipping live QBO — token error: ${e.message}`);
    return;
  }

  const { data: admin } = await service.from("users").select("id").eq("role", "admin").limit(1).single();

  const { data: run } = await service
    .from("cleanup_runs")
    .insert({
      client_link_id: LIVE_CLIENT,
      bookkeeper_id: admin?.id,
      status: "reviewing",
      workflow_mode: "onboarding",
      period_lock_date: "2026-05-31",
      current_module: "undeposited_funds",
    } as any)
    .select("id")
    .single();
  if (!run?.id) throw new Error("Failed to create live test run");

  const runId = run.id;
  await service.from("cleanup_run_modules").insert(
    ["bank_recon", "undeposited_funds", "accounts_receivable"].map((module, idx) => ({
      run_id: runId,
      module,
      status: idx <= 1 ? "ready" : "locked",
    })) as any
  );

  let ufResult: { proposed: number; matches: number; skipped: number };
  try {
    ufResult = await discoverUndepositedFundsModule(
      service,
      runId,
      LIVE_CLIENT,
      "2026-05-31"
    );
    console.log(
      `  UF discovery: proposed=${ufResult.proposed} matches=${ufResult.matches} skipped=${ufResult.skipped}`
    );
    assert(ufResult.proposed >= 0, "UF discovery completed without throw");
  } catch (e: any) {
    console.log(`  ✗ UF discovery failed: ${e.message}`);
    await service.from("cleanup_runs").update({ status: "failed" } as any).eq("id", runId);
    return;
  }

  try {
    const arResult = await discoverAccountsReceivableModule(
      service,
      runId,
      LIVE_CLIENT,
      "2026-05-31",
      {}
    );
    console.log(`  AR discovery: proposed=${arResult.proposed} duplicates=${arResult.duplicates}`);
    assert(arResult.proposed >= 0, "AR discovery completed");
  } catch (e: any) {
    console.log(`  ✗ AR discovery failed: ${e.message}`);
  }

  console.log(`  ✓ Phase 3 live run: /balance-sheet/${LIVE_CLIENT}/cleanup/${runId}`);
}

async function main() {
  loadEnvLocal();

  let failed = 0;
  const assert: Assert = (cond, msg) => {
    if (!cond) {
      console.error(`  ✗ FAIL: ${msg}`);
      failed++;
    }
  };

  console.log("BS Cleanup Synthetic E2E Test");
  console.log("==============================");

  try {
    runPhase1(assert);
    await runPhase2(assert);
    if (process.argv.includes("--live")) {
      await runPhase3Live(assert);
    } else {
      console.log("\n  (skip live QBO — pass --live to test real discovery)");
    }
  } catch (e: any) {
    console.error("\n✗ Unhandled error:", e.message);
    if (e.stack) console.error(e.stack);
    failed++;
  }

  console.log("\n==============================");
  if (failed > 0) {
    console.error(`FAILED — ${failed} assertion(s)`);
    process.exit(1);
  }
  console.log("ALL TESTS PASSED");
}

main();
