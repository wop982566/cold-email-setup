// ---------------------------------------------------------------------------
// Which swaps a scheduled run is allowed to perform, unattended.
//
// The maintenance panel proposes swaps for a human to approve. This decides
// which of those a machine may carry out at 3am with nobody watching, which is
// a strictly higher bar: a person can look at a proposal and say "not that
// one", and there is nobody here to do that.
//
// The rules, and why each exists:
//   • Cap per run. A metrics glitch that makes every mailbox look terrible must
//     not empty the campaigns. The cap bounds the blast radius of being wrong.
//   • Worst first. If the cap allows two swaps and five are proposed, the two
//     that get done should be the two doing the most damage.
//   • Sustained decline. One bad reading can be a bad day. `minBadDays` demands
//     the mailbox has looked bad on N consecutive observations before anyone
//     rips it out of a live campaign.
//   • A confirmed-good replacement or nothing. Swapping a bad mailbox for
//     another bad mailbox is worse than leaving it alone, because it also
//     resets the new one's reputation.
//
// Pure module — the scheduled function fetches, persists and writes; this only
// decides.
// ---------------------------------------------------------------------------
import type { MailboxHealth, SwapProposal } from "./mailboxHealth";

export interface AutoSwapPolicy {
  /** Hard ceiling on swaps performed in one run. */
  maxPerRun: number;
  /** Consecutive bad observations required before acting. 1 = act on today's. */
  minBadDays: number;
  /** A replacement must score at least this to be used. */
  minScore: number;
}

export const DEFAULT_POLICY: AutoSwapPolicy = {
  maxPerRun: 2,
  minBadDays: 1,
  minScore: 80,
};

export interface AutoSwapDecision {
  proposal: SwapProposal;
  from: string;
  to: string;
  campaignIds: string[];
  reason: string;
}

export interface AutoSwapSkip {
  email: string;
  /** Phrased for the run log and the email — a human reads these. */
  reason: string;
}

export interface AutoSwapPlan {
  act: AutoSwapDecision[];
  skip: AutoSwapSkip[];
  /** Proposals dropped purely because the cap was reached. */
  deferred: number;
}

/** Scores seen for a mailbox, oldest first. Today's reading is the last. */
export type ScoreHistory = Map<string, number[]>;

function badForLongEnough(
  email: string,
  history: ScoreHistory,
  policy: AutoSwapPolicy,
): { ok: boolean; seen: number } {
  if (policy.minBadDays <= 1) return { ok: true, seen: 1 };
  const scores = history.get(email.trim().toLowerCase()) ?? [];
  // Count back from the most recent while the reading is still bad.
  let streak = 0;
  for (let i = scores.length - 1; i >= 0; i--) {
    if (scores[i] < policy.minScore) streak++;
    else break;
  }
  return { ok: streak >= policy.minBadDays, seen: streak };
}

function usable(m: MailboxHealth, policy: AutoSwapPolicy): boolean {
  return (
    m.available &&
    m.mature &&
    m.score !== null &&
    m.score >= policy.minScore &&
    m.verdict !== "replace"
  );
}

/**
 * Decide what an unattended run should do.
 *
 * `proposals` come straight from `buildMaintenance`, so exclusions and
 * convalescing mailboxes have already been filtered out of the candidate pool
 * upstream — this re-checks the replacement anyway, because a rule that only
 * holds because something else enforced it is one refactor from not holding.
 */
export function planAutoSwaps(
  proposals: SwapProposal[],
  history: ScoreHistory,
  policy: AutoSwapPolicy = DEFAULT_POLICY,
): AutoSwapPlan {
  const act: AutoSwapDecision[] = [];
  const skip: AutoSwapSkip[] = [];
  let deferred = 0;

  // Worst first, so a tight cap is spent where it matters. Unknown scores sort
  // last: we don't rip out a mailbox we couldn't measure.
  const ordered = [...proposals].sort(
    (a, b) => (a.bad.score ?? Infinity) - (b.bad.score ?? Infinity),
  );

  for (const p of ordered) {
    const from = p.bad.box.email;

    if (p.bad.score === null) {
      skip.push({ email: from, reason: "no score for it — not touching what we can't measure" });
      continue;
    }
    if (p.campaigns.length === 0) {
      skip.push({ email: from, reason: "not in any campaign to swap out of" });
      continue;
    }

    const streak = badForLongEnough(from, history, policy);
    if (!streak.ok) {
      skip.push({
        email: from,
        reason: `bad for ${streak.seen} run${streak.seen === 1 ? "" : "s"}, needs ${policy.minBadDays} in a row`,
      });
      continue;
    }

    if (!usable(p.replacement, policy)) {
      skip.push({
        email: from,
        reason: `no replacement good enough (best was ${p.replacement.box.email} at ${
          p.replacement.score ?? "no score"
        }) — left in place rather than swapped for something worse`,
      });
      continue;
    }

    // Cap check last, so the log distinguishes "we ran out of budget" from
    // "this one wasn't eligible anyway".
    if (act.length >= policy.maxPerRun) {
      deferred++;
      continue;
    }

    act.push({
      proposal: p,
      from,
      to: p.replacement.box.email,
      campaignIds: p.campaigns.map((c) => c.id),
      reason: p.bad.issues
        .filter((i) => i.triggersReplacement)
        .map((i) => i.label)
        .join("; "),
    });
  }

  return { act, skip, deferred };
}

/** Merge today's readings into stored history, capped so it can't grow forever. */
export function recordScores(
  previous: ScoreHistory,
  today: { email: string; score: number | null }[],
  keep = 14,
): ScoreHistory {
  const next: ScoreHistory = new Map(previous);
  for (const { email, score } of today) {
    if (score === null) continue; // an unknown reading breaks no streak and starts none
    const key = email.trim().toLowerCase();
    next.set(key, [...(next.get(key) ?? []), score].slice(-keep));
  }
  return next;
}
