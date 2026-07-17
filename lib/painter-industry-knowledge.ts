/**
 * Painter-industry knowledge brief — baked into the Portal Ask AI's
 * system prompt so responses feel painter-fluent without retrieving
 * from a live coaching corpus.
 *
 * This is the INITIAL hand-written version. Replace with the
 * data-derived version by running:
 *
 *   npx tsx scripts/distill-painter-knowledge.ts
 *
 * which distills the 413 PainterGrowth call_insights rows into an
 * updated brief and overwrites this file. Diff and review before
 * shipping — anything that goes here is visible to every portal client.
 *
 * Style guidelines for this content:
 *   - Atomic facts, not coaching anecdotes
 *   - Number ranges, not specific clients or transcripts
 *   - Vocabulary painters use (e.g. "EDDM", "spec drawings", "punch list")
 *   - No specific people, companies, or revenue figures
 */

export const PAINTER_INDUSTRY_KNOWLEDGE = `═══ PAINTER INDUSTRY KNOWLEDGE (curated baseline — used to make the assistant fluent in the painting trade) ═══

— FINANCIAL TARGETS (residential repaint / light commercial) —
- Direct labor (variable, on the job):  30–40% of revenue
- Materials (paint, supplies):           10–20% of revenue
- Gross profit:                          ~50% (top operators: 55–60%)
- Overhead / operating expenses:             30–40% of revenue
- Net profit:                            10–20% (10% acceptable, 15%+ healthy, 20%+ excellent)
- A 25–30% gross margin is BELOW target for a painter, not "healthy."

— SALES / PIPELINE BENCHMARKS —
- Estimate-to-job close rate:            30–50% for residential repaints
- Estimate-to-job close rate:            10–25% for commercial
- Average job size varies by market — pull from the data, don't guess regional numbers
- Most painters issue 4–8 estimates per closed job in cold-call mode; 2–3 with warm referrals
- "Spec drawing" or "site walk" before quoting boosts close rate but adds 30–60 min per estimate

— OPERATING REALITIES —
- Revenue is project-based, not recurring. Lumpy months are normal.
- Seasonality: May–Sep is peak in cold-climate regions; winter is slow. Sun Belt is flatter year-round.
- Cash flow gap: deposits at job start (typically 30–50%), balance at completion. Large jobs strain cash if not staged.
- Crews vs. subs: many painters mix W2 painters with 1099 subs. Sub-heavy shops have lower payroll on books but typically lower gross margin too (subs charge more than direct labor cost).
- Estimating accuracy is the single biggest lever for margin. Most painters who run thin margins under-bid labor hours.

— COMMON COST CATEGORIES (and what painters confuse) —
- "Postage" often hides EDDM marketing spend (Every Door Direct Mail at USPS) — should be Marketing.
- "Office supplies" often hides job-site supplies — should be Job Materials.
- "Vehicle expense" often mixes personal use of an LLC vehicle — IRS issue.
- "Subcontractors" should hold 1099 labor; W2 wages belong in Payroll/Wages.
- "Owner draws" are NOT an expense — they hit Equity. Common mistake on owner-operator P&Ls.

— LANGUAGE PAINTERS USE —
- "EDDM" = Every Door Direct Mail (a USPS bulk-mail product painters use for local leads)
- "Spec drawing" = scope document used during estimating
- "Cut-in" = brushing edges before rolling
- "Punch list" = remaining touch-ups at end of job
- "Change order" = scope additions after the original quote is signed
- "Lead paint" / "RRP" = EPA Lead Renovation, Repair, and Painting certification (required for pre-1978 homes)
- "Hold-back" or "retainer" = portion of final payment held until punch list complete

— SCALING PATTERNS —
- Sub-$500K solo painters typically run lean overhead but cap revenue at owner's billable hours.
- $500K–$1M is the "first crew" stage — first hire (usually a lead painter), first office work outsourced.
- $1M–$2M needs a second crew + dedicated estimator. Margin usually dips here before recovering.
- $2M+ requires real production management, job-costing discipline, and usually a sales role separate from the owner.
- Most painters who plateau do so at $750K–$1.2M, often because the owner is still doing all estimating + most production management.

— FREQUENT PAIN POINTS PAINTERS ASK ABOUT —
- "Can I afford to hire?" → Frame against the 30–40% labor target and pipeline depth
- "Why am I not making money?" → Almost always either (a) under-bid labor, (b) overhead crept above 35%, or (c) sub-mix is wrong
- "Should I buy a vehicle?" → Cash flow + Section 179 question; redirect tax piece to CPA
- "How do I close more jobs?" → Lift close rate first (qualifying questions, in-person walks), not lead volume
- "Bookkeeping is messy" → Usually job costing isn't set up; expense categories don't match how the owner thinks about jobs

═══ END PAINTER INDUSTRY KNOWLEDGE ═══`;
