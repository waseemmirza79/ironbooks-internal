# Balance Sheet Cleanup System

Guided BS cleanup engine integrated into Ironbooks SNAP.

## Apply migration

Run [`scripts/migration_53_cleanup_system.sql`](../scripts/migration_53_cleanup_system.sql) against your Supabase project before using the wizard.

## Bookkeeper flow

1. Kanban **BS Cleanup** column → `/balance-sheet/[client_id]/cleanup`
2. Set period lock date → Health Score dashboard
3. Upload CSVs (optional) → run modules in order
4. Review proposed entries → attest → execute
5. QA gate → deliver → portal publish

## API routes

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/cleanup/start` | POST/GET | Start run / check active |
| `/api/cleanup/monthly` | POST | Monthly close mode |
| `/api/cleanup/[runId]/status` | GET | Poll run state |
| `/api/cleanup/[runId]/import` | POST | CSV import |
| `/api/cleanup/[runId]/modules/[module]/discover` | POST | Module discovery |
| `/api/cleanup/[runId]/modules/[module]/execute` | POST | Execute approved |
| `/api/cleanup/[runId]/proposed` | GET/PATCH | Review queue |
| `/api/cleanup/[runId]/proposed/[id]` | PATCH | Single decision |
| `/api/cleanup/[runId]/qa` | GET/POST | QA gate |
| `/api/cleanup/[runId]/cpa-flags` | GET/PATCH | CPA sign-off |
| `/api/cleanup/[runId]/deliver` | POST | Publish report |

## Hard rules

- Human approval + attestation before every QBO write
- Never edit closed periods (clearing entries only)
- CPA flags block until lead/admin sign-off
- Idempotency keys on all writes
- AI advisory only — amounts computed in code

See [`00-codebase-map.md`](./00-codebase-map.md) for full integration details.

## Ongoing operations (after cleanup)

1. **Daily recon** — auto-categorize every day; exceptions → Today. See **[`08-daily-recon-at-scale.md`](./08-daily-recon-at-scale.md)**.
2. **Month-end delivery** — start of each month, notify clients statements are ready. See **[`09-month-end-delivery.md`](./09-month-end-delivery.md)** (portal + email + AI summary, bulk send to hundreds).
