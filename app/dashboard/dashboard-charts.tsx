"use client";

import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";

export interface WeeklyPoint {
  week: string;
  jobs: number;
  avgMinutes: number | null;
}

export interface BookkeeperPoint {
  name: string;
  cleanups: number;
  avgMinutes: number | null;
}

const TEAL = "#2D7A75";
const BLUE = "#0891B2";
const GRID = "#F1F5F9";
const TICK = "#94A3B8";

const tooltipStyle = {
  fontSize: 12,
  borderRadius: 8,
  border: "1px solid #E2E8F0",
  boxShadow: "0 4px 12px rgba(0,0,0,0.06)",
};

const axisProps = {
  axisLine: false as const,
  tickLine: false as const,
  tick: { fontSize: 11, fill: TICK },
};

function EmptyChart({ message }: { message: string }) {
  return (
    <div className="flex items-center justify-center h-[180px] text-sm text-ink-slate italic">
      {message}
    </div>
  );
}

export function DashboardCharts({
  weeklyData,
  bookkeepersData,
}: {
  weeklyData: WeeklyPoint[];
  bookkeepersData: BookkeeperPoint[];
}) {
  const hasWeeklyJobs = weeklyData.some((w) => w.jobs > 0);
  const hasMinutes = weeklyData.some((w) => w.avgMinutes !== null);
  const hasBookkeeperData = bookkeepersData.length > 0;

  return (
    <div className="space-y-4">
      {/* Row 1 — volume + minutes trend */}
      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-xl bg-white border border-gray-200 p-5">
          <div className="mb-4">
            <h3 className="text-sm font-bold text-navy">Cleanups Per Week</h3>
            <p className="text-xs text-ink-slate mt-0.5">Completed jobs over the last 8 weeks</p>
          </div>
          {!hasWeeklyJobs ? (
            <EmptyChart message="No completed jobs yet" />
          ) : (
            <ResponsiveContainer width="100%" height={180}>
              <AreaChart data={weeklyData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="jobsGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={TEAL} stopOpacity={0.15} />
                    <stop offset="95%" stopColor={TEAL} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
                <XAxis dataKey="week" {...axisProps} />
                <YAxis {...axisProps} width={24} allowDecimals={false} />
                <Tooltip contentStyle={tooltipStyle} />
                <Area
                  type="monotone"
                  dataKey="jobs"
                  stroke={TEAL}
                  strokeWidth={2}
                  fill="url(#jobsGrad)"
                  dot={false}
                  name="Cleanups"
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="rounded-xl bg-white border border-gray-200 p-5">
          <div className="mb-4">
            <h3 className="text-sm font-bold text-navy">Avg Minutes Per Cleanup</h3>
            <p className="text-xs text-ink-slate mt-0.5">
              Total time in account — job start to execution complete
            </p>
          </div>
          {!hasMinutes ? (
            <EmptyChart message="Not enough data yet" />
          ) : (
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={weeklyData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
                <XAxis dataKey="week" {...axisProps} />
                <YAxis {...axisProps} width={36} unit="m" />
                <Tooltip
                  contentStyle={tooltipStyle}
                  formatter={(v: any) => [`${v}m`, "Avg time"]}
                />
                <Line
                  type="monotone"
                  dataKey="avgMinutes"
                  stroke={BLUE}
                  strokeWidth={2}
                  dot={{ r: 3, fill: BLUE, strokeWidth: 0 }}
                  activeDot={{ r: 5 }}
                  name="Avg minutes"
                  connectNulls
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Row 2 — per bookkeeper */}
      <div className="rounded-xl bg-white border border-gray-200 p-5">
        <div className="mb-4">
          <h3 className="text-sm font-bold text-navy">Team Performance — This Month</h3>
          <p className="text-xs text-ink-slate mt-0.5">
            Cleanups completed and avg minutes per bookkeeper
          </p>
        </div>
        {!hasBookkeeperData ? (
          <EmptyChart message="No completed jobs this month" />
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <BarChart
              data={bookkeepersData}
              margin={{ top: 4, right: 16, bottom: 0, left: 0 }}
              barCategoryGap="35%"
              barGap={4}
            >
              <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
              <XAxis dataKey="name" {...axisProps} tick={{ fontSize: 12, fill: "#0F1F2E" }} />
              <YAxis
                yAxisId="left"
                {...axisProps}
                width={24}
                allowDecimals={false}
              />
              <YAxis
                yAxisId="right"
                orientation="right"
                {...axisProps}
                width={40}
                unit="m"
              />
              <Tooltip
                contentStyle={tooltipStyle}
                formatter={(value: any, name: string) =>
                  name === "Avg minutes" ? [`${value}m`, name] : [value, name]
                }
              />
              <Legend
                wrapperStyle={{ fontSize: 12, paddingTop: 12 }}
                iconType="circle"
                iconSize={8}
              />
              <Bar
                yAxisId="left"
                dataKey="cleanups"
                fill={TEAL}
                radius={[4, 4, 0, 0]}
                name="Cleanups"
                maxBarSize={48}
              />
              <Bar
                yAxisId="right"
                dataKey="avgMinutes"
                fill={BLUE}
                radius={[4, 4, 0, 0]}
                name="Avg minutes"
                maxBarSize={48}
              />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
