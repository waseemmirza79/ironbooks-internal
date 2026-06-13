/**
 * BS Cleanup statement analysis — read uploaded bank / credit-card / loan
 * statement PDFs with Claude, extract the ending balance per account,
 * match each to a live QBO balance-sheet account, and turn the QBO-vs-
 * statement gap into a bank_recon_jobs row. The existing bank_recon
 * module then converts those gaps into proposed reconciling entries the
 * bookkeeper reviews + approves — so an upload directly becomes a
 * recommendation.
 *
 * Claude reads PDFs natively via document content blocks; no server-side
 * PDF text extraction needed.
 */

import { fetchAllAccounts, type QBOAccount } from "@/lib/qbo";

const MODEL = "claude-opus-4-7";

/**
 * Call the Anthropic Messages API directly. The installed SDK (0.30.1)
 * predates PDF document blocks, but PDF support is GA on the API itself —
 * so this one call hits the REST endpoint with raw content blocks rather
 * than risk a repo-wide SDK bump.
 */
async function callClaudePdf(content: any[]): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      messages: [{ role: "user", content }],
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Anthropic ${res.status}: ${detail.slice(0, 300)}`);
  }
  const data = await res.json();
  return (data.content || [])
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("");
}

export interface UploadedStatement {
  /** Original filename — shown back to the bookkeeper for traceability. */
  filename: string;
  /** base64-encoded PDF bytes (no data: prefix). */
  base64: string;
}

export interface ExtractedStatement {
  filename: string;
  institution: string | null;
  account_label: string | null;
  last4: string | null;
  statement_end_date: string | null; // YYYY-MM-DD
  ending_balance: number | null;
  account_kind: "bank" | "credit_card" | "loan" | "unknown";
  /** Claude's match to a QBO account id (or null if it couldn't decide). */
  matched_qbo_account_id: string | null;
  match_confidence: "high" | "medium" | "low" | "none";
  notes: string | null;
}

export interface StatementReconResult {
  filename: string;
  matched_account_name: string | null;
  qbo_account_id: string | null;
  qbo_balance: number | null;
  statement_balance: number | null;
  gap: number | null;
  statement_end_date: string | null;
  confidence: ExtractedStatement["match_confidence"];
  status: "reconciled" | "gap_found" | "unmatched" | "no_balance";
  note: string | null;
}

/** Candidate accounts the matcher chooses from — bank, CC, and loan-like
 *  liability accounts, with their live QBO balance + last4. */
function reconCandidates(accounts: QBOAccount[]) {
  return accounts
    .filter((a) => a.Active !== false)
    .filter((a) => {
      const t = (a.AccountType || "").toLowerCase();
      const st = (a.AccountSubType || "").toLowerCase();
      return (
        t === "bank" ||
        t === "credit card" ||
        st.includes("loan") ||
        st.includes("notes payable") ||
        t === "long term liabilities"
      );
    })
    .map((a) => ({
      id: a.Id,
      name: a.FullyQualifiedName || a.Name,
      type: a.AccountType,
      subtype: a.AccountSubType,
      balance: a.CurrentBalance,
    }));
}

const EXTRACTION_SCHEMA = `Return ONLY valid JSON, no prose, shaped exactly:
{
  "statements": [
    {
      "index": <number, matches the order the PDFs were given, 0-based>,
      "institution": <string|null>,
      "account_label": <string|null, e.g. "Business Checking ...1234">,
      "last4": <string|null, last 4 digits of the account number>,
      "statement_end_date": <"YYYY-MM-DD"|null, the statement's closing/ending date>,
      "ending_balance": <number|null, the ENDING balance as a signed number;
                         for a credit card or loan a balance OWED is NEGATIVE
                         to match how QBO carries those accounts>,
      "account_kind": <"bank"|"credit_card"|"loan"|"unknown">,
      "matched_qbo_account_id": <string|null, the id from the candidate list
                                 that best matches this statement, by last4
                                 first, then name/institution, then type+amount>,
      "match_confidence": <"high"|"medium"|"low"|"none">,
      "notes": <string|null, one short line if anything is ambiguous>
    }
  ]
}`;

/**
 * Send all PDFs to Claude in one request with the candidate account list,
 * get back the extracted + matched statements.
 */
export async function extractStatements(
  statements: UploadedStatement[],
  candidates: ReturnType<typeof reconCandidates>
): Promise<ExtractedStatement[]> {
  if (statements.length === 0) return [];

  const candidateList = candidates
    .map(
      (c) =>
        `  - id=${c.id} | "${c.name}" | type=${c.type}/${c.subtype} | QBO balance=${c.balance}`
    )
    .join("\n");

  const docs = statements.map((s, i) => ({
    type: "document",
    source: { type: "base64", media_type: "application/pdf", data: s.base64 },
    title: `Statement ${i}: ${s.filename}`,
  }));

  const prompt = `You are a bookkeeper's assistant reconciling a client's QuickBooks balance sheet against their actual account statements.

You have been given ${statements.length} statement PDF(s), indexed 0..${statements.length - 1} in the order attached.

Candidate QuickBooks accounts to match each statement to:
${candidateList || "(none provided)"}

For EACH statement, extract the ending balance and match it to the single best candidate account. Sign convention: bank balances positive; credit-card and loan balances OWED are negative (QBO carries liabilities that way). If you cannot confidently match a statement to a candidate, set matched_qbo_account_id to null and match_confidence to "none".

${EXTRACTION_SCHEMA}`;

  const text = await callClaudePdf([...docs, { type: "text", text: prompt }]);
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Statement analysis returned no parseable result");
  const parsed = JSON.parse(jsonMatch[0]);
  const rows: any[] = Array.isArray(parsed.statements) ? parsed.statements : [];

  return statements.map((s, i) => {
    const r = rows.find((x) => x.index === i) || rows[i] || {};
    return {
      filename: s.filename,
      institution: r.institution ?? null,
      account_label: r.account_label ?? null,
      last4: r.last4 ? String(r.last4).slice(-4) : null,
      statement_end_date: r.statement_end_date ?? null,
      ending_balance: typeof r.ending_balance === "number" ? r.ending_balance : null,
      account_kind: ["bank", "credit_card", "loan"].includes(r.account_kind) ? r.account_kind : "unknown",
      matched_qbo_account_id: r.matched_qbo_account_id ? String(r.matched_qbo_account_id) : null,
      match_confidence: ["high", "medium", "low", "none"].includes(r.match_confidence) ? r.match_confidence : "none",
      notes: r.notes ?? null,
    };
  });
}

/**
 * Full pipeline: fetch QBO accounts, extract statements, upsert a
 * bank_recon_jobs row per matched statement with the QBO-vs-statement gap.
 * Returns a per-file result for display. Does NOT itself create proposed
 * entries — the caller re-runs the bank_recon module so the gaps flow
 * through the existing review path.
 */
export async function analyzeAndReconcile(
  service: any,
  params: {
    runId: string;
    clientLinkId: string;
    qboRealmId: string;
    accessToken: string;
    bookkeeperId: string;
    statements: UploadedStatement[];
  }
): Promise<{ results: StatementReconResult[]; reconRowsWritten: number }> {
  const accounts = await fetchAllAccounts(params.qboRealmId, params.accessToken);
  const candidates = reconCandidates(accounts);
  const byId = new Map(candidates.map((c) => [c.id, c]));

  const extracted = await extractStatements(params.statements, candidates);

  const results: StatementReconResult[] = [];
  let reconRowsWritten = 0;

  for (const ex of extracted) {
    const acct = ex.matched_qbo_account_id ? byId.get(ex.matched_qbo_account_id) : null;

    if (!acct) {
      results.push({
        filename: ex.filename,
        matched_account_name: ex.account_label,
        qbo_account_id: null,
        qbo_balance: null,
        statement_balance: ex.ending_balance,
        gap: null,
        statement_end_date: ex.statement_end_date,
        confidence: ex.match_confidence,
        status: "unmatched",
        note: ex.notes || "Couldn't match to a QuickBooks account — pick it manually.",
      });
      continue;
    }
    if (ex.ending_balance === null) {
      results.push({
        filename: ex.filename,
        matched_account_name: acct.name,
        qbo_account_id: acct.id,
        qbo_balance: acct.balance,
        statement_balance: null,
        gap: null,
        statement_end_date: ex.statement_end_date,
        confidence: ex.match_confidence,
        status: "no_balance",
        note: ex.notes || "Couldn't read an ending balance from this statement.",
      });
      continue;
    }

    const gap = Number((acct.balance - ex.ending_balance).toFixed(2));
    const reconciled = Math.abs(gap) < 0.01;

    // Upsert the per-account recon row this run's bank_recon module reads.
    const last4 = ex.last4 || null;
    const { data: existing } = await service
      .from("bank_recon_jobs")
      .select("id")
      .eq("client_link_id", params.clientLinkId)
      .eq("qbo_account_id", acct.id)
      .or(`cleanup_run_id.eq.${params.runId},cleanup_run_id.is.null`)
      .maybeSingle();

    const row = {
      client_link_id: params.clientLinkId,
      cleanup_run_id: params.runId,
      bookkeeper_id: params.bookkeeperId,
      qbo_account_id: acct.id,
      qbo_account_name: acct.name,
      qbo_account_type: acct.type,
      qbo_account_last4: last4,
      statement_ending_balance: ex.ending_balance,
      statement_as_of_date: ex.statement_end_date,
      qbo_balance_at_date: acct.balance,
      gap_amount: gap,
      status: reconciled ? "reconciled" : "gap",
      notes: `From upload "${ex.filename}"${ex.notes ? ` — ${ex.notes}` : ""}`,
    };

    if (existing) {
      await service.from("bank_recon_jobs").update(row as any).eq("id", (existing as any).id);
    } else {
      await service.from("bank_recon_jobs").insert(row as any);
    }
    reconRowsWritten++;

    results.push({
      filename: ex.filename,
      matched_account_name: acct.name,
      qbo_account_id: acct.id,
      qbo_balance: acct.balance,
      statement_balance: ex.ending_balance,
      gap,
      statement_end_date: ex.statement_end_date,
      confidence: ex.match_confidence,
      status: reconciled ? "reconciled" : "gap_found",
      note: ex.notes,
    });
  }

  return { results, reconRowsWritten };
}
