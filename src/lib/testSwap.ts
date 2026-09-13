// ---------------------------------------------------------------------------
// The test-swap harness's decision logic.
//
// It answers, for one campaign: which mailbox is actually failing, and which
// spare would replace it under the SAME eligibility rules the real swapper uses
// (mailboxHealth.ts's `available` predicate + the niche gate) — optionally with
// specific gates relaxed for a one-off test (e.g. you have amateur spares but
// still want to prove the automation swaps).
//
// It reuses the REAL per-mailbox health already computed (`MailboxHealth` from
// computeMaintenance carries the real score/maturity/verdict), so the test
// reflects the true automation, not a parallel guess. With NO relaxations the
// eligible pool is exactly the real available set (∩ this campaign's needs).
//
// Pure module — the caller applies/reverts the actual write.
// ---------------------------------------------------------------------------
import { eligibleFor, tagsFor, type TagMap } from "./tags";
import type { MailboxHealth } from "./mailboxHealth";

export interface TestGates {
  ignoreNiche: boolean;
  ignoreWarmupScore: boolean;
  allowImmature: boolean;
  includeRecovering: boolean;
}

export interface SpareEval {
  email: string;
  score: number | null;
  mature: boolean;
  /** shares a niche tag with the campaign. */
  passesNiche: boolean;
  passesWarmup: boolean;
  passesMature: boolean;
  recovering: boolean;
  /** Passes given the chosen gates. */
  eligible: boolean;
  /** Gates it only passed because they were relaxed — the "why it qualified". */
  relaxationsUsed: string[];
}

export interface TestSwapPlan {
  bad: { email: string; score: number | null; reason: string } | null;
  spare: SpareEval | null;
  alternatives: SpareEval[];
}

export interface TestSwapInput {
  /** The real per-mailbox health (computeMaintenance result's `mailboxes`). */
  mailboxes: readonly MailboxHealth[];
  /** The campaign's current email_list (any case). */
  campaignEmails: readonly string[];
  /** The campaign's resolved niche tags. */
  campaignTags: readonly string[];
  gates: TestGates;
  tagMap: TagMap;
  recovering: ReadonlySet<string>;
  /** maintenance_min_warmup_score. */
  minScore: number;
}

const lc = (s: string) => (s ?? "").trim().toLowerCase();

export function buildTestSwap(input: TestSwapInput): TestSwapPlan {
  const inCampaign = new Set(input.campaignEmails.map(lc));

  // The failing mailbox: real verdict "replace" AND currently in this campaign.
  const bads = input.mailboxes
    .filter((m) => m.verdict === "replace" && inCampaign.has(lc(m.box.email)))
    .sort((a, b) => (a.score ?? 0) - (b.score ?? 0)); // worst first
  const badM = bads[0] ?? null;
  const bad = badM
    ? {
        email: badM.box.email,
        score: badM.score,
        reason:
          badM.issues.find((i) => i.triggersReplacement)?.label ??
          "flagged for replacement",
      }
    : null;

  const badEmail = badM ? lc(badM.box.email) : null;

  const evals: SpareEval[] = input.mailboxes
    // Structural: a spare must be a free, sound mailbox not already in play.
    .filter(
      (m) =>
        m.box.active &&
        !m.box.setupPending &&
        !m.box.excluded &&
        m.box.shareCount === 0 &&
        m.verdict !== "replace" &&
        !inCampaign.has(lc(m.box.email)) &&
        lc(m.box.email) !== badEmail,
    )
    .map((m) => {
      const email = m.box.email;
      const passesWarmup = m.score !== null && m.score >= input.minScore;
      const passesMature = m.mature;
      const notRecovering = !input.recovering.has(lc(email));
      const passesNiche =
        input.campaignTags.length > 0 && eligibleFor(tagsFor(input.tagMap, email), input.campaignTags);

      const relaxationsUsed: string[] = [];
      if (input.gates.ignoreWarmupScore && !passesWarmup) relaxationsUsed.push("warmup score");
      if (input.gates.allowImmature && !passesMature) relaxationsUsed.push("maturity");
      if (input.gates.includeRecovering && !notRecovering) relaxationsUsed.push("recovering");
      if (input.gates.ignoreNiche && !passesNiche) relaxationsUsed.push("niche match");

      const eligible =
        (input.gates.ignoreWarmupScore || passesWarmup) &&
        (input.gates.allowImmature || passesMature) &&
        (input.gates.includeRecovering || notRecovering) &&
        (input.gates.ignoreNiche || passesNiche);

      return {
        email,
        score: m.score,
        mature: m.mature,
        passesNiche,
        passesWarmup,
        passesMature,
        recovering: !notRecovering,
        eligible,
        relaxationsUsed,
      };
    });

  const eligible = evals
    .filter((e) => e.eligible)
    .sort(
      (a, b) =>
        (b.score ?? -1) - (a.score ?? -1) || // best warmup first
        Number(b.passesMature) - Number(a.passesMature) ||
        Number(b.passesNiche) - Number(a.passesNiche) ||
        a.email.localeCompare(b.email),
    );

  return { bad, spare: eligible[0] ?? null, alternatives: eligible.slice(1) };
}
