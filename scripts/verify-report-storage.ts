// Verify the client-generated report storage flow (save → list → parse →
// download) exactly as the generate route + portal page do it. Cleans up
// after itself. Run after any change to the report-save path scheme.
import { readFileSync } from "fs";
const env = readFileSync(".env.local", "utf8");
for (const line of env.split("\n")) {
  const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { createClient } from "@supabase/supabase-js";

const BUCKET = "client-uploads";
const svc: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "✓" : "✗ FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

(async () => {
  const { data: client } = await svc
    .from("client_links")
    .select("id, client_name")
    .eq("is_active", true)
    .limit(1)
    .single();
  console.log(`Test client: ${client.client_name} (${client.id})\n`);

  const ts = Date.now();
  const path = `${client.id}/reports/${ts}-Cleanup-Report-2026-05-01-to-2026-05-31.pdf`;
  const fakePdf = Buffer.from("%PDF-1.4 verify-report-storage test");

  try {
    // Save (as the generate route does)
    const { error: upErr } = await svc.storage
      .from(BUCKET)
      .upload(path, fakePdf, { contentType: "application/pdf" });
    check("upload PDF to reports folder", !upErr, upErr?.message);

    // List (as the portal page does)
    const { data: files, error: listErr } = await svc.storage
      .from(BUCKET)
      .list(`${client.id}/reports`, {
        limit: 100,
        sortBy: { column: "created_at", order: "desc" },
      });
    check("list reports folder", !listErr && Array.isArray(files), listErr?.message);
    const ours = (files || []).find((f: any) => f.name === `${ts}-Cleanup-Report-2026-05-01-to-2026-05-31.pdf`);
    check("uploaded report appears in list", !!ours);

    // Filename parsing (as the portal page does)
    const m = ours?.name.match(/Cleanup-Report-(\d{4}-\d{2}-\d{2})-to-(\d{4}-\d{2}-\d{2})/);
    check("period parses from filename", m?.[1] === "2026-05-01" && m?.[2] === "2026-05-31");

    // Signed download (as /api/client-files/download does)
    const { data: signed, error: signErr } = await svc.storage
      .from(BUCKET)
      .createSignedUrl(path, 60, { download: "Cleanup-Report-2026-05-01-to-2026-05-31.pdf" });
    check("signed download URL", !!signed?.signedUrl && !signErr, signErr?.message);
    if (signed) {
      const got = await fetch(signed.signedUrl);
      const body = Buffer.from(await got.arrayBuffer());
      check("downloaded content matches", got.ok && body.equals(fakePdf));
    }
  } finally {
    await svc.storage.from(BUCKET).remove([path]);
    const { data: after } = await svc.storage.from(BUCKET).list(`${client.id}/reports`);
    const leftover = (after || []).some((f: any) => f.name.startsWith(String(ts)));
    check("cleanup: test file removed", !leftover);
  }

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
