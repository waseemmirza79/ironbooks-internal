/**
 * Claude AI — Repair Plan Generator
 * ----------------------------------
 * Called at the END of a COA cleanup execution, after all the auto-steps
 * have run. Takes the list of failures (errors that came back from QBO during
 * the job) and asks Claude to produce a Manual Cleanup Report: one or more
 * line items per failure, each with plain-English reason + step-by-step
 * instructions for what the bookkeeper should do in QBO to handle it.
 *
 * Design notes:
 *   - SINGLE Claude call for ALL failures in the job (not per-failure).
 *     Cheaper, faster, and Claude is smart enough to group similar failures
 *     into a single repair item with shared instructions when appropriate.
 *   - Returns a flat list of ManualCleanupItem. May return MORE items than
 *     failures (e.g., one failure may yield two related action items).
 *   - On Claude failure (rate limit, network, etc), falls back to a basic
 *     pass-through report so the job still completes cleanly with the raw
 *     QBO errors visible. Never throws — repair plan generation is best-effort.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { ManualCleanupItem } from './executor';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-opus-4-7';

/**
 * One row representing a failed action we want Claude to explain.
 * Built by the executor from the catch blocks. Includes everything Claude
 * needs to write a sensible repair plan — request, response, account state.
 */
export interface FailureContext {
  intended_action: 'rename' | 'inactivate' | 'create' | 'merge' | 'reparent';
  account_id: string | null;
  account_name: string;
  /** The body we sent to QBO, exactly as it went out. */
  request_body: Record<string, unknown>;
  /** Raw QBO error response string. */
  qbo_error: string;
  /**
   * Optional snapshot of the account in QBO before we tried to modify it.
   * Useful when Claude needs to know subtype, parent, balance, etc.
   */
  account_snapshot?: Record<string, unknown> | null;
}

interface ClaudeRepairItem {
  account_name: string;
  intended_action: 'rename' | 'inactivate' | 'create' | 'merge' | 'reparent';
  account_id: string | null;
  /** One-sentence plain-English explanation, no API jargon. */
  reason: string;
  /** Numbered steps the bookkeeper should perform in the QBO web UI. */
  steps: string[];
  /** Optional alternative path if applicable. */
  alternative?: string;
}

interface ClaudeRepairResponse {
  items: ClaudeRepairItem[];
}

const SYSTEM_PROMPT = `You are a senior QuickBooks Online bookkeeper helping a junior bookkeeper finish a Chart of Accounts cleanup job.

The Ironbooks system tried to apply some changes to QBO automatically. A few hit QBO platform limits that the API can't override (system-protected accounts, parent/subtype rules, accounts with historical transactions, name collisions, etc).

You will be given the failures. Your job is to produce a Manual Cleanup Report — a structured list of action items the junior bookkeeper should perform in the QBO web UI to complete the cleanup.

Rules:
1. Output VALID JSON only. No prose before or after. No markdown fences.
2. One "items" array. Each item is one action the bookkeeper does in QBO.
3. You MAY produce MORE items than the number of failures if a single failure naturally splits into multiple steps for the user. You MAY produce FEWER items if multiple failures collapse into one repair action.
4. Each item has: account_name, intended_action, account_id (if known, else null), reason, steps, optional alternative.
5. "reason" is one sentence, plain English, no error codes, no API jargon. Explain to a bookkeeper, not a developer.
6. "steps" is an ordered list of concrete clicks in QBO's web UI. Each step short and imperative. Don't say "open QBO" repeatedly — once per item is enough.
7. "alternative" only if there's a clearly better/simpler path the bookkeeper could choose instead.
8. Never invent QBO features that don't exist. If you're not sure what the user should do, say "review this account with your senior and decide on the appropriate action."
9. If a failure is clearly because the account has transactions, the right step is usually to either (a) reclassify those transactions to a different account first, then inactivate, or (b) leave the account active. Recommend whichever fits the data better.
10. If a failure is a "parent not found" cascade because the parent failed first, do NOT create a separate item for the child — fold it into the parent's steps ("after creating the parent, Ironbooks will create [child] automatically on the next run").

Output schema (strict):
{
  "items": [
    {
      "account_name": "string",
      "intended_action": "rename" | "inactivate" | "create" | "merge" | "reparent",
      "account_id": "string or null",
      "reason": "one sentence, plain English",
      "steps": ["Step 1", "Step 2", "..."],
      "alternative": "optional string"
    }
  ]
}`;

/**
 * Generate Manual Cleanup Report items for a batch of execution failures.
 * Returns at least one item per failure. Falls back to a basic pass-through
 * on Claude failure so the job still completes.
 */
export async function generateManualRepairPlan(
  failures: FailureContext[]
): Promise<ManualCleanupItem[]> {
  if (failures.length === 0) return [];

  // Compose a tight user message with each failure clearly delineated
  const userMessage = JSON.stringify({
    failures: failures.map((f, idx) => ({
      index: idx + 1,
      intended_action: f.intended_action,
      account_id: f.account_id,
      account_name: f.account_name,
      request_body_sent: f.request_body,
      qbo_error: f.qbo_error.slice(0, 2000), // cap noise
      account_snapshot: f.account_snapshot ?? null,
    })),
  });

  try {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    });

    const text = resp.content
      .filter((b) => b.type === 'text')
      .map((b: any) => b.text)
      .join('\n')
      .trim();

    // Strip any accidental markdown fencing Claude added despite instructions
    const cleanText = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const parsed = JSON.parse(cleanText) as ClaudeRepairResponse;

    if (!parsed.items || !Array.isArray(parsed.items)) {
      throw new Error('Claude response missing items array');
    }

    return parsed.items.map((item) => ({
      account_id: item.account_id ?? null,
      account_name: item.account_name,
      intended_action: item.intended_action,
      reason: item.reason,
      // Pack steps into the existing `suggestion` field as a numbered list.
      // (Storage shape stays backward-compatible with what's already in DB.)
      suggestion: item.steps.map((s, i) => `${i + 1}. ${s}`).join('\n') +
        (item.alternative ? `\n\nAlternative: ${item.alternative}` : ''),
    }));
  } catch (e: any) {
    console.error('[claude-repair] Failed to generate repair plan, falling back:', e?.message);
    // Fallback: produce a basic item per failure with the raw error
    return failures.map((f) => ({
      account_id: f.account_id,
      account_name: f.account_name,
      intended_action: f.intended_action,
      reason: 'QBO rejected this change via API. The exact reason was not auto-explained.',
      suggestion: `Open QBO → Chart of Accounts → find "${f.account_name}" and handle the intended ${f.intended_action} manually. (AI repair-plan generation was unavailable for this item.)`,
      qbo_response: f.qbo_error,
    }));
  }
}
