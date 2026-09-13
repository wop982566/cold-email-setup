// ---------------------------------------------------------------------------
// Real sends per mailbox — when Instantly reports them.
//
// The whole point of this module is the thing it refuses to do. Campaign sends
// and each campaign's mailbox list are both known, so it is trivial to divide
// one by the other and print a per-inbox number. That number would be wrong:
// Instantly does not spread a campaign evenly across its mailboxes, and a
// figure that looks measured but is inferred is worse than no figure at all.
//
// So either the API gives us per-account counts and we show them, or we say it
// doesn't and fall back to signals that are genuinely per-inbox (last used,
// warmup score, inbox placement).
//
// Pure module — the page fetches, this parses.
// ---------------------------------------------------------------------------
import { pick } from "./apiShape";

export interface InboxSends {
  email: string;
  sentLast30: number;
  sentPerDay: number;
  /** Real bounces in the window, when the payload reports them; 0 when it doesn't. */
  bounced: number;
  /** bounced / sent as a percentage, or null when there is nothing to divide. */
  bounceRate: number | null;
}

export type InboxSendsResult =
  | { supported: true; byEmail: Map<string, InboxSends>; source: string }
  | { supported: false; reason: string };

const F = {
  sent: ["sent", "emails_sent_count", "sent_count", "emails_sent", "total_sent", "sent_total"],
  bounced: ["bounced", "bounced_count", "bounce_count", "total_bounced", "bounces"],
};

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function emailOf(o: Obj): string {
  for (const k of ["email", "account", "address", "account_email", "from_email"]) {
    const v = o[k];
    if (typeof v === "string" && v.includes("@")) return v.trim().toLowerCase();
  }
  return "";
}

const UNSUPPORTED =
  "Instantly's API doesn't report per-mailbox send counts for this workspace, so there's nothing real to show here. The per-campaign figures above are measured; a per-inbox split would only be a guess.";

/**
 * Parse whatever the account-analytics probe returned.
 *
 * `windowDays` and `sendingDaysPerWeek` convert a 30-day total into the
 * per-sending-day rate the rest of the planner compares against.
 */
export function parseInboxSends(
  payload: unknown,
  opts: { supported?: boolean; windowDays?: number; sendingDaysPerWeek?: number; source?: string } = {},
): InboxSendsResult {
  if (opts.supported === false) return { supported: false, reason: UNSUPPORTED };

  const rows: unknown[] = Array.isArray(payload)
    ? payload
    : isObj(payload) && Array.isArray(payload.items)
      ? (payload.items as unknown[])
      : [];

  const windowDays = Math.max(1, opts.windowDays ?? 30);
  const factor = Math.min(7, Math.max(1, opts.sendingDaysPerWeek ?? 5)) / 7;

  // A bounce field that is genuinely absent must not read as 0 bounces — 0 and
  // "not reported" are different facts, and only the former earns a clean rate.
  const bounceReported = new Set<string>();

  const byEmail = new Map<string, InboxSends>();
  for (const row of rows) {
    if (!isObj(row)) continue;
    const email = emailOf(row);
    if (!email) continue;
    const sent = pick(row, F.sent, 0);
    const bounced = pick(row, F.bounced, -1);
    if (bounced >= 0) bounceReported.add(email);
    const prev = byEmail.get(email);
    const total = (prev?.sentLast30 ?? 0) + sent;
    const totalBounced = (prev?.bounced ?? 0) + Math.max(0, bounced);
    byEmail.set(email, {
      email,
      sentLast30: total,
      sentPerDay: factor > 0 ? total / windowDays / factor : 0,
      bounced: totalBounced,
      // Filled after the loop, once the per-email totals are final.
      bounceRate: null,
    });
  }

  // Resolve bounce rate now that sums are complete: a real percentage only when
  // this mailbox reported bounces AND actually sent something.
  for (const [email, r] of byEmail) {
    r.bounceRate =
      bounceReported.has(email) && r.sentLast30 > 0
        ? (r.bounced / r.sentLast30) * 100
        : null;
  }

  // Rows that carry no send figures at all are the same as no rows: the shape
  // was recognised but the numbers we need aren't in it.
  const anySends = [...byEmail.values()].some((r) => r.sentLast30 > 0);
  if (byEmail.size === 0 || !anySends) return { supported: false, reason: UNSUPPORTED };

  return { supported: true, byEmail, source: opts.source ?? "accounts analytics" };
}
