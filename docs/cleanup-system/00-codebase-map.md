# Ironbooks SNAP — BS Cleanup System Codebase Map

> Phase 0 discovery document. Confirms integration points for the balance-sheet cleanup engine.

## Stack

| Layer | Technology | Path |
|-------|------------|------|
| Framework | Next.js 15 App Router, React 19 | `app/` |
| Backend | Next.js API routes (~134 handlers) | `app/api/` |
| Database | Supabase Postgres | `scripts/migration_*.sql` |
| Auth | Supabase Auth + `@supabase/ssr` | `lib/supabase.ts`, `middleware.ts` |
| QBO | OAuth 2.0 + REST API | `lib/qbo.ts`, `lib/qbo-reclass.ts` |
| AI | Anthropic Claude (advisory only) | `lib/claude*.ts` |
| Deploy | Vercel (cron, maxDuration 800s) | `vercel.json` |

## Bookkeeper onboarding pipeline

```
COA (/jobs/new) → Reclass full_categorization → Stripe Recon (optional)
  → Bank Rules (/reclass/[id]/bank-rules) → BS Cleanup (kanban bs_cleanup)
  → Senior Review → complete-cleanup + PDF
```

Kanban stage derivation: `app/api/kanban/onboarding/route.ts`
- `bs_cleanup`: any completed reclass, no active reclass job

## Existing modules to reuse

| Module | Key files | Role in BS cleanup |
|--------|-----------|-------------------|
| Reclass engine | `lib/qbo-reclass.ts` | Line reclass, closed-period guards |
| Reclass review UX | `app/reclass/[id]/review/review-client.tsx` | Pattern for proposed_entries review |
| Bank rules | `bank_rules`, `lib/daily-recon.ts` | Ongoing automation post-cleanup |
| Bank recon | `bank_recon_jobs`, `landing-client.tsx` | Module 1: bank/CC recon |
| UF → AR | `uf_ar_jobs`, `uf_ar_matches` | Module 2: undeposited funds |
| Hardcore cleanup | `lib/hardcore-cleanup.ts` | Module 3: AR duplicates |
| Stripe recon | `lib/qbo-stripe-recon.ts` | Tier 4 batch/payout matching (read-only input) |
| BS accounts | `lib/qbo-balance-sheet.ts` | Account listing, UF/AR fetch |
| JE posting | `app/api/balance-sheet/post-je/route.ts` | Clearing entries |
| Audit | `audit_log` via `lib/executor.ts` | All mutations logged |
| Completion | `app/api/clients/[id]/complete-cleanup/route.ts` | Final marker + PDF range |

## New tables (migration_53)

| Table | Purpose |
|-------|---------|
| `period_locks` | Per-client lock date (QBO + Double) |
| `qbo_snapshots` | Immutable trial balance + BS at run start |
| `cleanup_runs` | Orchestrator (one active per client) |
| `cleanup_run_modules` | Per-module status within a run |
| `bs_health_scores` | Score + per-account grades + task list |
| `imported_records` | Canonical CSV rows |
| `recon_matches` | Matching engine output |
| `proposed_entries` | Staging for approval (like reclassifications) |
| `cpa_flags` | Hard blocks with sign-off |
| `cleanup_reports` | Deliverable snapshot for portal |
| `source_adapter_configs` | Declarative CSV column maps |

FK extensions: `bank_recon_jobs.cleanup_run_id`, `uf_ar_jobs.cleanup_run_id`, `hardcore_cleanup_runs.cleanup_run_id`

## New code locations

```
lib/cleanup-system/
  types.ts              — shared types + module order
  snapshot.ts           — QBO trial balance pull
  health-score.ts       — diagnose + grade accounts
  csv-adapters.ts       — Stripe/Jobber/DripJobs/bank CSV
  orchestrator.ts       — run lifecycle + module gating
  matching-engine.ts    — tiers 1–5 unified matching
  proposed-entries.ts   — staging helpers
  execute-proposed.ts   — approved post path + idempotency
  qa-gate.ts            — automated clean-check
  cpa-flags.ts          — CPA sign-off workflow
  qbo-queue.ts          — per-realm rate limiting wrapper
  auth.ts               — staff ownership checks

app/api/cleanup/
  start/route.ts        — POST create run + snapshot
  [runId]/status/route.ts
  [runId]/diagnose/route.ts
  [runId]/import/route.ts
  [runId]/modules/[module]/discover/route.ts
  [runId]/modules/[module]/execute/route.ts
  [runId]/proposed/route.ts
  [runId]/proposed/[id]/route.ts
  [runId]/qa/route.ts
  [runId]/deliver/route.ts
  [runId]/cpa-flags/route.ts

app/balance-sheet/[client_id]/cleanup/
  page.tsx              — redirect to active run or start
  [runId]/page.tsx      — wizard shell
  [runId]/cleanup-wizard-client.tsx
```

## Hard rules (enforced in code)

1. Never auto-post to QBO — human approve + attest required
2. Never edit closed period — skip or clearing entry in earliest open period
3. CPA-flagged items blocked until lead/admin sign-off
4. AI advisory only — never sets amounts
5. Idempotency keys on every QBO write
6. Bank is source of truth; processor CSVs enrich only

## Auth & tenancy

- Tenant boundary: `client_links` (one QBO realm per client)
- Staff: `assigned_bookkeeper_id` + role (`admin`, `lead`, `bookkeeper`, `viewer`)
- Portal: `client_users` → read-only on `cleanup_reports`, `bs_health_scores` summary
- RLS: `user_can_see_client()` on all new tables (migration_53)

## Job execution pattern

Matches existing reclass pattern:
1. POST creates job row with `status=discovering`
2. `after()` runs background discovery (chunked via `discovery_cursor`)
3. Frontend polls `/api/cleanup/[runId]/status`
4. Execute requires `attested=true`

## Integration with kanban

`app/kanban/client-card.tsx` `bs_cleanup` stage:
- Primary CTA → `/balance-sheet/[client_id]/cleanup` (wizard entry)
- Shows Health Score badge when active run exists

## Scalability notes (1000 clients + 1000 portal users)

- Chunked discovery with resume cursor
- One active `cleanup_runs` per client (concurrency guard)
- `qbo-queue.ts` token-bucket per realm
- Portal reads `cleanup_reports` snapshot, not live QBO
- Cron: bounded concurrency (5 clients parallel) in `app/api/cron/daily-recon/route.ts`
