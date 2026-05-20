import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

/**
 * GET /api/kanban/mom
 *
 * Returns clients grouped by month-over-month stage for the current calendar
 * month. Only clients with cleanup_completed_at set appear here.
 *
 * Query params:
 *   bookkeeper_id  — filter by assigned bookkeeper (optional)
 *   year           — override year (default: current)
 *   month          — override month 1-12 (default: current)
 *   page           — 0-indexed page (default 0)
 *   limit          — cards per column (default 20, max 50)
 *
 * Stages:
 *   month_open      no reclass job for this month
 *   in_progress     active reclass job (pending / executing / in_review / failed)
 *   review_send     reclass complete, month not closed
 *   month_closed    month_closed_at set on most recent reclass job
 */
export async function GET(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const bookkeeperFilter = searchParams.get("bookkeeper_id") || null;
  const page = Math.max(0, parseInt(searchParams.get("page") || "0", 10));
  const limit = Math.min(50, Math.max(1, parseInt(searchParams.get("limit") || "20", 10)));
  const offset = page * limit;

  const now = new Date();
  const year = parseInt(searchParams.get("year") || String(now.getFullYear()), 10);
  const month = parseInt(searchParams.get("month") || String(now.getMonth() + 1), 10);

  // First and last day of the target month (UTC)
  const monthStart = new Date(Date.UTC(year, month - 1, 1)).toISOString();
  const monthEnd = new Date(Date.UTC(year, month, 1)).toISOString();

  const service = createServiceSupabase();

  let query = service
    .from("client_links")
    .select("*")
    .eq("is_active", true)
    .not("cleanup_completed_at", "is", null);

  if (bookkeeperFilter) {
    query = query.eq("assigned_bookkeeper_id", bookkeeperFilter);
  }

  const { data: clients, error } = await query.order("client_name");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const activeClients = (clients || []).filter((c: any) => !c.kanban_on_hold);
  if (!activeClients.length) return NextResponse.json({ columns: emptyColumns(), month: { year, month } });

  const clientIds = activeClients.map((c) => c.id);

  // Reclass jobs for the target month
  const { data: reclassJobs } = await service
    .from("reclass_jobs")
    .select("id, client_link_id, status, created_at, updated_at, bookkeeper_id, month_closed_at, month_closed_by")
    .in("client_link_id", clientIds)
    .gte("created_at", monthStart)
    .lt("created_at", monthEnd)
    .order("created_at", { ascending: false });

  // Note counts
  const { data: noteCounts } = await service
    .from("client_notes")
    .select("client_link_id")
    .in("client_link_id", clientIds);

  // Bookkeepers
  const { data: bookkeepers } = await service
    .from("users")
    .select("id, full_name, avatar_url")
    .eq("is_active", true);

  const bkById = new Map((bookkeepers || []).map((b) => [b.id, b]));

  // Most recent reclass job this month per client
  const latestReclass = new Map<string, any>();
  for (const j of reclassJobs || []) {
    if (!latestReclass.has(j.client_link_id)) latestReclass.set(j.client_link_id, j);
  }

  const noteCountMap = new Map<string, number>();
  for (const n of noteCounts || []) {
    noteCountMap.set(n.client_link_id, (noteCountMap.get(n.client_link_id) || 0) + 1);
  }

  const ACTIVE_STATUSES = new Set(["pending", "executing", "in_review", "failed"]);

  const columns: Record<string, any[]> = {
    month_open: [],
    in_progress: [],
    review_send: [],
    month_closed: [],
  };

  for (const client of activeClients) {
    const reclass = latestReclass.get(client.id);
    const bk = client.assigned_bookkeeper_id ? bkById.get(client.assigned_bookkeeper_id) : null;

    const card = {
      id: client.id,
      client_name: client.client_name,
      jurisdiction: client.jurisdiction,
      state_province: client.state_province,
      stripe_detected: client.stripe_detected,
      stripe_connected: client.stripe_connection_status === "connected",
      due_date: client.due_date,
      note_count: noteCountMap.get(client.id) || 0,
      bookkeeper: bk ? { id: bk.id, full_name: bk.full_name, avatar_url: bk.avatar_url } : null,
      latest_reclass_job: reclass
        ? { id: reclass.id, status: reclass.status, month_closed_at: reclass.month_closed_at }
        : null,
    };

    if (!reclass) {
      columns.month_open.push(card);
    } else if (reclass.month_closed_at) {
      columns.month_closed.push(card);
    } else if (reclass.status === "complete") {
      columns.review_send.push(card);
    } else if (ACTIVE_STATUSES.has(reclass.status)) {
      columns.in_progress.push(card);
    } else {
      columns.month_open.push(card);
    }
  }

  // Paginate
  const paginated: Record<string, { cards: any[]; total: number }> = {};
  for (const [key, cards] of Object.entries(columns)) {
    paginated[key] = {
      cards: cards.slice(offset, offset + limit),
      total: cards.length,
    };
  }

  return NextResponse.json({ columns: paginated, month: { year, month } });
}

function emptyColumns() {
  const keys = ["month_open", "in_progress", "review_send", "month_closed"];
  return Object.fromEntries(keys.map((k) => [k, { cards: [], total: 0 }]));
}
