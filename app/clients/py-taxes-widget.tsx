"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Calendar, Check, Loader2, AlertTriangle, X, RotateCcw } from "lucide-react";

interface Props {
  clientLinkId: string;
  pyTaxesFiled: boolean;
  pyTaxesFiledThroughYear: number | null;
  /** When true, render in compact (single-line) mode for inline use. */
  compact?: boolean;
}

/**
 * Prior-year taxes indicator — one-time client setting.
 *
 * Two stable states + an inline edit mode:
 *   Filed (green)   — taxes filed through year Y; reclass Y+1 and later only
 *   Not filed (amber) — taxes NOT filed; reclass any year
 *
 * The "not filed" state covers both "haven't asked the client yet" and
 * "client confirmed they haven't filed". We collapse them because they
 * behave identically downstream (reclass-any-year). When the bookkeeper
 * confirms taxes have been filed, they click Edit and enter the year —
 * widget jumps to green and shows the reclass guidance.
 */
export function PyTaxesWidget({
  clientLinkId,
  pyTaxesFiled,
  pyTaxesFiledThroughYear,
  compact = false,
}: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [year, setYear] = useState<string>(
    pyTaxesFiledThroughYear ? String(pyTaxesFiledThroughYear) : ""
  );
  const [error, setError] = useState<string>("");

  const thisYear = new Date().getFullYear();
  const isFiled = pyTaxesFiled && pyTaxesFiledThroughYear !== null;

  async function save(filed: boolean, throughYear: number | null) {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/clients/${clientLinkId}/py-taxes`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          py_taxes_filed: filed,
          py_taxes_filed_through_year: throughYear,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setEditing(false);
      router.refresh();
    } catch (e: any) {
      setError(e.message || "Failed to save");
    } finally {
      setBusy(false);
    }
  }

  function submitYear() {
    const yr = parseInt(year, 10);
    if (!Number.isFinite(yr) || yr < 2000 || yr > thisYear + 1) {
      setError(`Enter a year between 2000 and ${thisYear + 1}`);
      return;
    }
    save(true, yr);
  }

  // ── Editing mode
  if (editing) {
    return (
      <div
        className={`flex items-center gap-1.5 rounded-md border px-2 py-1.5 bg-white border-teal/30 flex-wrap ${
          compact ? "text-[11px]" : "text-xs"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <Calendar size={13} className="text-teal flex-shrink-0" />
        <span className="text-navy font-semibold flex-shrink-0">Filed through:</span>
        <input
          type="number"
          value={year}
          onChange={(e) => setYear(e.target.value)}
          placeholder={String(thisYear - 1)}
          min={2000}
          max={thisYear + 1}
          autoFocus
          className="w-20 px-1.5 py-0.5 rounded border border-gray-200 text-xs"
          onKeyDown={(e) => {
            if (e.key === "Enter") submitYear();
            if (e.key === "Escape") {
              setEditing(false);
              setError("");
            }
          }}
        />
        <button
          onClick={submitYear}
          disabled={busy}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-teal text-white text-[10px] font-bold disabled:opacity-50"
        >
          {busy ? <Loader2 size={10} className="animate-spin" /> : <Check size={10} />}
          Save
        </button>
        {isFiled && (
          // Only show "Clear" when currently filed — lets the bookkeeper
          // un-mark a client whose year was set in error.
          <button
            onClick={() => save(false, null)}
            disabled={busy}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-gray-100 text-gray-700 text-[10px] font-semibold disabled:opacity-50"
            title="Mark as not filed (clears the year)"
          >
            <RotateCcw size={9} />
            Clear
          </button>
        )}
        <button
          onClick={() => {
            setEditing(false);
            setError("");
            setYear(pyTaxesFiledThroughYear ? String(pyTaxesFiledThroughYear) : "");
          }}
          className="text-ink-light hover:text-ink-slate"
          title="Cancel"
        >
          <X size={12} />
        </button>
        {error && (
          <span className="text-[10px] text-red-600 font-semibold ml-1">{error}</span>
        )}
      </div>
    );
  }

  // ── Filed + year known
  if (isFiled) {
    const reclassYear = pyTaxesFiledThroughYear! + 1;
    return (
      <div
        className={`flex items-center gap-2 rounded-md border px-2 py-1.5 bg-emerald-50 border-emerald-200 ${
          compact ? "text-[11px]" : "text-xs"
        }`}
      >
        <Check size={13} className="text-emerald-600 flex-shrink-0" />
        <span className="text-emerald-900 flex-1 min-w-0">
          <strong>Taxes filed through {pyTaxesFiledThroughYear}</strong>
          <span className="text-emerald-700">
            {" "}· reclass {reclassYear}+ only
          </span>
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            setEditing(true);
          }}
          className="text-[10px] font-bold uppercase tracking-wider text-emerald-700 hover:text-emerald-900 px-1"
        >
          Edit
        </button>
      </div>
    );
  }

  // ── Not filed (default for new clients + explicit "haven't filed" state)
  return (
    <div
      className={`flex items-center gap-2 rounded-md border px-2 py-1.5 bg-amber-50 border-amber-200 ${
        compact ? "text-[11px]" : "text-xs"
      }`}
    >
      <AlertTriangle size={13} className="text-amber-600 flex-shrink-0" />
      <span className="text-amber-900 flex-1 truncate">
        <strong>PY taxes not yet filed</strong>
        <span className="text-amber-700"> · reclass any year</span>
      </span>
      <button
        onClick={(e) => {
          e.stopPropagation();
          setEditing(true);
        }}
        className="text-[10px] font-bold uppercase tracking-wider text-amber-700 hover:text-amber-900 px-1.5"
      >
        Set year
      </button>
    </div>
  );
}
