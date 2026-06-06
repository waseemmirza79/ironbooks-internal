export type MonthEndPackageStatus =
  | "draft"
  | "summary_pending"
  | "ready_to_send"
  | "sending"
  | "sent"
  | "failed";

export interface PeriodRef {
  periodYear: number;
  periodMonth: number;
}

export interface PeriodBounds extends PeriodRef {
  periodStart: string;
  periodEnd: string;
  label: string;
}

export type ReadinessBlockReason =
  | "reclass_incomplete"
  | "today_pending"
  | "daily_recon_paused"
  | "summary_not_reviewed"
  | "package_not_built"
  | "already_sent"
  | "qbo_token_missing"
  | "no_reclass_job";

export interface ClientReadiness {
  clientLinkId: string;
  clientName: string;
  /** Passes operational gates — can build package / generate summary */
  operationallyReady: boolean;
  /** Ready for bulk send (reviewed summary + ready_to_send) */
  deliverable: boolean;
  blockReasons: ReadinessBlockReason[];
  blockLabels: string[];
  reclassJobId: string | null;
  todayPendingCount: number;
  packageId: string | null;
  packageStatus: MonthEndPackageStatus | null;
  aiSummaryReviewed: boolean;
}

export interface FleetReadinessSummary {
  period: PeriodBounds;
  ready: ClientReadiness[];
  blocked: ClientReadiness[];
  sent: ClientReadiness[];
  failed: ClientReadiness[];
  counts: {
    ready: number;
    blocked: number;
    sent: number;
    failed: number;
    draft: number;
    summaryPending: number;
  };
}

export interface PlSnapshot {
  totalIncome: number;
  totalExpenses: number;
  netIncome: number;
  comparisonIncome: number;
  comparisonExpenses: number;
  comparisonNetIncome: number;
  topIncomeLines: { label: string; amount: number }[];
  topExpenseLines: { label: string; amount: number }[];
}

export interface BsSnapshot {
  asOfDate: string;
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  cashOnHand: number;
  topAssets: { name: string; balance: number }[];
  topLiabilities: { name: string; balance: number }[];
}

export interface ArApSnapshot {
  openARTotal: number;
  openARCount: number;
  overdueARTotal: number;
  overdueARCount: number;
  openAPTotal: number;
  openAPCount: number;
}

export interface DailyReconStats {
  autoCategorized: number;
  exceptionsCleared: number;
  pendingNow: number;
}
