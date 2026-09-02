// ---------------------------------------------------------------------------
// HTTP endpoint for the Inbox Tester's buttons: verify (SMTP/IMAP login check),
// test-now (queue a placement test and send it), and blast (queue + kick a
// custom external send). An ordinary function — NO `config.schedule` export, or
// Netlify would stop serving it over HTTP — sharing one implementation with the
// scheduled worker via _mailWorker.ts. Gated by APP_FUNCTION_TOKEN.
// ---------------------------------------------------------------------------
import { handleAction } from "./_mailWorker.js";

export default async (req: Request) => {
  try {
    return await handleAction(req);
  } catch (e) {
    return new Response(
      JSON.stringify({ ok: false, error: e instanceof Error ? e.message : "request failed" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};
