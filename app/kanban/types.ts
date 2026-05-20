export interface KanbanBookkeeper {
  id: string;
  full_name: string;
  avatar_url: string | null;
}

export interface KanbanCard {
  id: string;
  client_name: string;
  jurisdiction: string;
  state_province: string | null;
  stripe_detected: boolean;
  stripe_connected: boolean;
  stripe_pending: boolean;
  stripe_request_sent_at: string | null;
  stripe_link_sent_by: string | null;
  stripe_link_sent_at: string | null;
  stripe_not_required?: boolean;
  /** True if any bank_recon_jobs row exists for this client. */
  bs_recon_started?: boolean;
  /** True if a bank_recon_jobs row exists with non-complete status. */
  bs_recon_in_progress?: boolean;
  /** Bookkeeper checked "Sent client request to identify transactions". */
  ask_client_email_sent_at?: string | null;
  /** Bookkeeper checked "Sent client stripe request". */
  stripe_request_sent_confirmed_at?: string | null;
  /**
   * Pre-built /api/reports/cleanup link for one-click download. Null until
   * we have a date range to feed the report (either cleanup_range_* from
   * complete-cleanup, or the latest completed COA job as fallback).
   */
  cleanup_pdf_href?: string | null;
  due_date: string | null;
  note_count: number;
  bookkeeper: KanbanBookkeeper | null;
  latest_coa_job: { id: string; status: string } | null;
  latest_reclass_job: { id: string; status: string; month_closed_at?: string | null } | null;
}

export interface KanbanColumn {
  cards: KanbanCard[];
  total: number;
}

export type OnboardingStage =
  | "needs_cleanup"
  | "coa_in_progress"
  | "reclass_in_progress"
  | "awaiting_stripe"
  | "bs_cleanup"
  | "review";

export type MomStage = "month_open" | "in_progress" | "review_send" | "month_closed";
