import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { getValidToken, fetchAllAccounts } from "@/lib/qbo";
import { fetchProfitAndLoss, extractGstHstAccounts } from "@/lib/qbo-reports";
import { getProvinceTax } from "@/lib/canadian-tax";

function fmt(n: number) {
  return n.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ client_id: string }> }
) {
  const { client_id } = await context.params;

  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const startDate = url.searchParams.get("start_date");
  const endDate = url.searchParams.get("end_date");
  if (!startDate || !endDate) {
    return NextResponse.json({ error: "start_date and end_date are required" }, { status: 400 });
  }

  const service = createServiceSupabase();
  const { data: client } = await service
    .from("client_links")
    .select("*")
    .eq("id", client_id)
    .single();

  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });
  if (client.jurisdiction !== "CA") {
    return NextResponse.json({ error: "Tax audit is only available for Canadian clients" }, { status: 400 });
  }

  const province = getProvinceTax((client as any).state_province);
  if (!province) {
    return NextResponse.json({ error: "Client province is not set" }, { status: 400 });
  }

  const accessToken = await getValidToken(client_id, service as any);

  // Fetch P&L and COA in parallel
  const [pnl, allAccounts] = await Promise.all([
    fetchProfitAndLoss((client as any).qbo_realm_id, accessToken, startDate, endDate),
    fetchAllAccounts((client as any).qbo_realm_id, accessToken),
  ]);

  const gstAccounts = extractGstHstAccounts(allAccounts);

  // ─── Service tax rate for this province ─────────────────────────────────
  // Use the federal GST/HST component — the rate charged to customers
  // on painting services (PST/RST is typically exempt for service labor).
  const taxRate = province.serviceTax.rate;
  const taxRateDisplay = province.display;
  const gstHstRate = province.rates.hst ?? province.rates.gst ?? 0.05;

  // ─── TEST 1: GST/HST Account Inventory ──────────────────────────────────
  const netPayable = gstAccounts
    .filter((a) => a.type === "payable")
    .reduce((s, a) => s + a.balance, 0);
  const netReceivable = gstAccounts
    .filter((a) => a.type === "receivable")
    .reduce((s, a) => s + a.balance, 0);

  const accountInventory = {
    accounts: gstAccounts,
    netPayable,
    netReceivable,
    pass: gstAccounts.length > 0,
    message:
      gstAccounts.length === 0
        ? "No GST/HST accounts found. Check that QBO is set up for Canadian tax."
        : `Found ${gstAccounts.length} GST/HST account${gstAccounts.length > 1 ? "s" : ""}. Net payable to CRA: $${fmt(netPayable)}.`,
  };

  // ─── TEST 2: Sales Tax Reasonableness ────────────────────────────────────
  // Expected GST/HST collected = total revenue × applicable rate.
  // Compare against the net payable balance. Tolerance ±15% to account for
  // zero-rated items, timing differences, and partial-period remittances.
  // NOTE: account balance reflects current date, not period-end — flagged in UI.
  const expectedCollected = pnl.totalIncome * taxRate;
  const variance =
    expectedCollected > 0
      ? Math.abs(netPayable - expectedCollected) / expectedCollected
      : 0;
  const TOLERANCE = 0.15;
  const salesTestPass = variance <= TOLERANCE || expectedCollected === 0;

  const salesTaxTest = {
    totalRevenue: pnl.totalIncome,
    taxRate,
    taxRateDisplay,
    expectedCollected,
    netPayableBalance: netPayable,
    variancePct: variance * 100,
    pass: salesTestPass,
    message: salesTestPass
      ? `GST/HST payable ($${fmt(netPayable)}) is within ±15% of expected $${fmt(expectedCollected)} (${(taxRate * 100).toFixed(0)}% × revenue).`
      : `GST/HST payable ($${fmt(netPayable)}) differs from expected $${fmt(expectedCollected)} by ${(variance * 100).toFixed(1)}%. Investigate uncollected tax or unremitted balance.`,
  };

  // ─── TEST 3: Meals 50% ITC ───────────────────────────────────────────────
  // Under s.67.1 ITA and the Excise Tax Act, the ITC on meals & entertainment
  // is limited to 50% of the GST/HST paid. In QBO CA, meals are typically
  // booked net of tax (the ITC split is handled via tax codes). We estimate:
  //   Max allowable meals ITC = meals_expense × gst_rate × 50%
  //
  // This is a BENCHMARK — the bookkeeper should verify the ITC claim against
  // the actual transactions. A larger-than-expected ITC suggests the full
  // amount was claimed rather than the 50% limit.
  const estimatedGSTOnMeals = pnl.mealsExpense * gstHstRate;
  const maxAllowableMealsITC = estimatedGSTOnMeals * 0.5;
  const mealsHasExpense = pnl.mealsExpense > 0;

  const meals50Test = {
    mealsExpense: pnl.mealsExpense,
    mealsAccounts: pnl.mealsAccounts,
    gstHstRate,
    estimatedGSTOnMeals,
    maxAllowableMealsITC,
    hasExpense: mealsHasExpense,
    pass: true, // This is always a benchmark/advisory, not a hard pass/fail
    message: mealsHasExpense
      ? `Meals & entertainment: $${fmt(pnl.mealsExpense)}. Estimated GST/HST on meals: $${fmt(estimatedGSTOnMeals)}. Maximum allowable ITC (50%): $${fmt(maxAllowableMealsITC)}. Verify that the ITC claimed for meals does not exceed this amount.`
      : "No meals & entertainment expense found in this period.",
  };

  return NextResponse.json({
    client: {
      id: client_id,
      name: (client as any).client_name,
      province: province.name,
      provinceCode: (client as any).state_province,
      taxRate,
      taxRateDisplay,
    },
    period: { startDate, endDate },
    pnl: {
      totalIncome: pnl.totalIncome,
      totalExpenses: pnl.totalExpenses,
      netIncome: pnl.netIncome,
      mealsExpense: pnl.mealsExpense,
    },
    tests: {
      accountInventory,
      salesTaxTest,
      meals50Test,
    },
  });
}
