"use client";

import { useEffect } from "react";
import { X as XIcon, ExternalLink, Download } from "lucide-react";

/**
 * In-app preview for a file in the private client-uploads bucket (statements,
 * etc.). Renders the file inline in an <iframe> served through
 * /api/client-files/download?inline=1 — the browser's PDF viewer, without
 * leaving the app ("preview in the same window"). Backdrop / X / Escape close.
 *
 * Both fallbacks are always present in the header: "Open in new tab" and
 * "Download" — so if a browser can't inline-render a given file, the user is
 * never stuck.
 */
export function FilePreviewModal({
  path,
  name,
  onClose,
}: {
  path: string;
  name: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    // Lock background scroll while the preview is open.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  const base = `/api/client-files/download?path=${encodeURIComponent(path)}`;
  const inlineUrl = `${base}&inline=1`;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Preview of ${name}`}
    >
      <div
        className="flex h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-gray-200 px-4 py-3">
          <div className="min-w-0 text-sm font-bold text-navy truncate" title={name}>
            {name}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <a
              href={inlineUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-ink-slate hover:bg-gray-100"
              title="Open in a new tab"
            >
              <ExternalLink size={13} /> New tab
            </a>
            <a
              href={base}
              className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-ink-slate hover:bg-gray-100"
              title="Download original"
            >
              <Download size={13} /> Download
            </a>
            <button
              onClick={onClose}
              className="rounded-lg p-1.5 text-ink-slate hover:bg-gray-100 hover:text-navy"
              aria-label="Close preview"
            >
              <XIcon size={18} />
            </button>
          </div>
        </div>
        <iframe
          src={inlineUrl}
          title={`Preview of ${name}`}
          className="flex-1 w-full bg-gray-50"
        />
      </div>
    </div>
  );
}
