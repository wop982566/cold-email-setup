// ---------------------------------------------------------------------------
// Operator email, via Resend.
//
// Used by the scheduled swapper to tell you what it did while you weren't
// looking. Deliberately best-effort: a notification that fails must never lose
// the record of a swap that succeeded, so every path here returns a result
// rather than throwing.
//
// The API key lives only in the RESEND_API_KEY environment variable — never in
// the repository.
// ---------------------------------------------------------------------------

const RESEND_URL = "https://api.resend.com/emails";

export interface NotifyResult {
  sent: boolean;
  /** Why not, in words that go straight into the run log. */
  detail: string;
}

export interface NotifyInput {
  subject: string;
  /** Plain text; converted to minimal HTML so it's readable in any client. */
  body: string;
  to: string;
  from: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export async function notify(input: NotifyInput): Promise<NotifyResult> {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    return { sent: false, detail: "RESEND_API_KEY is not set — no email sent" };
  }
  if (!input.to || !input.from) {
    return { sent: false, detail: "sender or recipient missing — no email sent" };
  }

  try {
    const res = await fetch(RESEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: input.from,
        to: [input.to],
        subject: input.subject,
        text: input.body,
        html: `<pre style="font:14px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap">${escapeHtml(
          input.body,
        )}</pre>`,
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      // 403 here is nearly always an unverified sending domain, which is worth
      // saying outright rather than leaving as a bare status code.
      const hint =
        res.status === 403
          ? ` — check that ${input.from.split("@")[1] ?? "the sender domain"} is verified in Resend`
          : "";
      return { sent: false, detail: `Resend ${res.status}${hint}: ${detail.slice(0, 300)}` };
    }
    return { sent: true, detail: `emailed ${input.to}` };
  } catch (err) {
    return {
      sent: false,
      detail: `Resend request failed: ${err instanceof Error ? err.message : "unknown error"}`,
    };
  }
}
