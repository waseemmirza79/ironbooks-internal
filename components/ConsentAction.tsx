"use client";

import { useState } from "react";

/** Public unsubscribe/resubscribe confirm widget (no login). */
export function ConsentAction({ token, action }: { token: string; action: "unsubscribe" | "resubscribe" }) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const isUnsub = action === "unsubscribe";

  async function go() {
    setState("busy");
    try {
      const res = await fetch("/api/email-consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, action }),
      });
      setState(res.ok ? "done" : "error");
    } catch {
      setState("error");
    }
  }

  if (state === "done") {
    return (
      <p style={{ color: "#1F5D58", fontWeight: 600 }}>
        {isUnsub
          ? "You've been unsubscribed from Ironbooks updates. You'll still receive essential account notices."
          : "You're resubscribed — welcome back. You'll start receiving our updates again."}
      </p>
    );
  }
  if (state === "error") {
    return <p style={{ color: "#b91c1c" }}>Something went wrong — this link may be invalid or expired. Email admin@ironbooks.com and we'll sort it.</p>;
  }
  return (
    <button
      onClick={go}
      disabled={state === "busy"}
      style={{ background: "#2D7A75", color: "#fff", border: 0, borderRadius: 12, padding: "12px 28px", fontSize: 16, fontWeight: 700, cursor: "pointer", opacity: state === "busy" ? 0.6 : 1 }}
    >
      {state === "busy" ? "Working…" : isUnsub ? "Confirm unsubscribe" : "Yes, resubscribe me"}
    </button>
  );
}
