import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { createTask } from "@/lib/double";

/**
 * POST /api/double/client-question
 *
 * Sends a question to the client via Double HQ as a non-closing task. Used
 * by the reclass review "Draft Email to Client" modal — the bookkeeper edits
 * the body, then we post it to Double so the client sees it in their portal.
 *
 * Body:
 *  {
 *    reclass_job_id: string,
 *    subject: string,
 *    body: string,
 *    due_date?: string  // YYYY-MM-DD, defaults to 48 hours from now
 *  }
 */
export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { reclass_job_id, subject, body: emailBody, due_date } = body;

  if (!reclass_job_id || !subject || !emailBody) {
    return NextResponse.json(
      { error: "reclass_job_id, subject, and body are all required" },
      { status: 400 }
    );
  }

  const service = createServiceSupabase();

  // Look up the reclass job + client link so we can find the Double client ID
  const { data: job } = await service
    .from("reclass_jobs")
    .select("id, client_link_id, client_links(double_client_id, client_name)")
    .eq("id", reclass_job_id)
    .single();

  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const clientLink = (job as any).client_links;
  if (!clientLink?.double_client_id || String(clientLink.double_client_id).startsWith("pending_")) {
    return NextResponse.json(
      { error: "Client is not linked to Double HQ. Connect the client first." },
      { status: 400 }
    );
  }

  const doubleClientId = parseInt(String(clientLink.double_client_id), 10);
  if (isNaN(doubleClientId)) {
    return NextResponse.json({ error: "Invalid Double client ID" }, { status: 400 });
  }

  // Default due date = 48 hours from now (as the email template promises)
  const dueDateStr =
    due_date ||
    new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString().slice(0, 10);

  try {
    const task = await createTask({
      clientId: doubleClientId,
      taskName: subject.slice(0, 200), // Double has length limits
      dueDate: dueDateStr,
      priority: false,
      type: "nonClosing",
      status: "notStarted",
      subText: emailBody,
    });

    // Audit log entry — we want a trail of every client question sent
    await service.from("audit_log").insert({
      job_id: reclass_job_id,
      user_id: user.id,
      event_type: "client_question_sent",
      request_payload: {
        message: `Sent ${subject.length > 60 ? subject.slice(0, 57) + "..." : subject} to ${clientLink.client_name} via Double`,
        subject,
        body_length: emailBody.length,
        double_client_id: doubleClientId,
      } as any,
      response_payload: {
        double_task_id: task?.id || null,
      } as any,
    });

    return NextResponse.json({
      sent: true,
      double_task_id: task?.id || null,
      due_date: dueDateStr,
    });
  } catch (err: any) {
    console.error("[double/client-question] Send failed:", err);
    return NextResponse.json(
      { error: `Double HQ rejected the task: ${err.message}` },
      { status: 500 }
    );
  }
}
