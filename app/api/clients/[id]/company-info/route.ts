import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { fetchCompanyInfo, getValidToken, fiscalStartMonthToNumber, getReclassDateRangePresets, qboErrorResponse } from "@/lib/qbo";
import { NextResponse } from "next/server";

/**
 * GET /api/clients/[id]/company-info
 *
 * Returns the client's QBO CompanyInfo with derived fiscal year details.
 * Used by the reclass form to compute date range presets that respect each
 * client's actual fiscal year (pulled from QBO, not assumed).
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const supabase = await createServerSupabase();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();

  const { data: clientLink } = await service
    .from("client_links")
    .select("id, qbo_realm_id, is_active, client_name, jurisdiction, state_province")
    .eq("id", id)
    .single();

  if (!clientLink) return NextResponse.json({ error: "Client not found" }, { status: 404 });
  if (!clientLink.is_active) {
    return NextResponse.json({ error: "Client is inactive" }, { status: 400 });
  }

  try {
    const accessToken = await getValidToken(clientLink.id, service as any);
    const info = await fetchCompanyInfo(clientLink.qbo_realm_id, accessToken);
    const fiscalStartMonth = fiscalStartMonthToNumber(info.FiscalYearStartMonth);
    const presets = getReclassDateRangePresets(fiscalStartMonth);

    return NextResponse.json({
      client: {
        id: clientLink.id,
        name: clientLink.client_name,
        jurisdiction: clientLink.jurisdiction,
        state_province: clientLink.state_province,
      },
      company: {
        name: info.CompanyName,
        country: info.Country || info.CompanyAddr?.Country || null,
        fiscal_year_start_month_name: info.FiscalYearStartMonth || "January",
        fiscal_year_start_month_number: fiscalStartMonth,
      },
      date_range_presets: presets,
    });
  } catch (err: any) {
    return qboErrorResponse(err);
  }
}
