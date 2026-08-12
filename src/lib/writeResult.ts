// ---------------------------------------------------------------------------
// Classifying what actually happened to a write.
//
// This exists because the first version got it wrong in the most damaging way
// available: the server returns `applied: null` when the confirming read
// fails, and the client tested `applied !== false`, so an unconfirmed write was
// reported to the operator as done. The app said a mailbox had been swapped
// back; Instantly disagreed.
//
// Three outcomes, never two. "We could not confirm" is its own answer and must
// never be rounded up to success.
//
// Pure module — callers do the fetching, this decides what to believe.
// ---------------------------------------------------------------------------
import type { WriteResult } from "./instantly";

export type WriteOutcome = "applied" | "unconfirmed" | "failed";

export interface WriteVerdict {
  outcome: WriteOutcome;
  /** One line fit for a toast or a row. */
  message: string;
  /** True only when Instantly confirmed the change on a fresh read. */
  confirmed: boolean;
}

export function classifyWrite(res: WriteResult, label: string): WriteVerdict {
  if (!res.ok) {
    return {
      outcome: "failed",
      confirmed: false,
      message: `${label}: ${res.error ?? "request failed"}`,
    };
  }
  if (res.applied === true) {
    return { outcome: "applied", confirmed: true, message: `${label}: confirmed` };
  }
  if (res.applied === false) {
    return {
      outcome: "failed",
      confirmed: false,
      message: `${label}: Instantly accepted the request but the mailbox list did not change`,
    };
  }
  // applied == null — the write may or may not have landed.
  return {
    outcome: "unconfirmed",
    confirmed: false,
    message: `${label}: sent, but couldn't read the campaign back to confirm${
      res.verifyStatus ? ` (verify read returned ${res.verifyStatus})` : ""
    } — check Instantly directly`,
  };
}

/**
 * Everything the server tried, as copyable text. The whole point is that a
 * failed write leaves a durable record instead of a toast that disappears
 * before it can be read.
 */
export function formatAttempts(res: WriteResult, label: string): string {
  const lines = [`— ${label} —`];
  if (res.writesDisabled) {
    lines.push("BLOCKED: writes are disabled (INSTANTLY_WRITE_ENABLED is not set to true)");
  }
  if (res.before) lines.push(`before: ${res.before.join(", ") || "(empty)"}`);
  if (res.after) lines.push(`intended: ${res.after.join(", ") || "(empty)"}`);
  for (const a of res.attempts ?? []) {
    lines.push(
      `${a.method} ${a.path} -> HTTP ${a.status}${
        a.body ? ` ${JSON.stringify(a.body).slice(0, 400)}` : ""
      }`,
    );
  }
  if (res.verified) lines.push(`after (read back): ${res.verified.join(", ") || "(empty)"}`);
  if (res.applied === null) lines.push("could not confirm: the read-back failed");
  if (res.error) lines.push(`error: ${res.error}`);
  if ((res.attempts ?? []).length === 0 && !res.error && !res.writesDisabled) {
    lines.push("no HTTP attempt was recorded");
  }
  return lines.join("\n");
}

/** Roll several per-campaign verdicts into one sentence. */
export function summariseWrites(verdicts: WriteVerdict[]): {
  message: string;
  tone: "success" | "error" | "info";
} {
  const applied = verdicts.filter((v) => v.outcome === "applied").length;
  const unconfirmed = verdicts.filter((v) => v.outcome === "unconfirmed").length;
  const failed = verdicts.filter((v) => v.outcome === "failed");

  if (applied === verdicts.length && applied > 0) {
    return { message: `Confirmed on ${applied} campaign${applied === 1 ? "" : "s"}`, tone: "success" };
  }
  if (failed.length === verdicts.length) {
    return { message: failed[0]?.message ?? "Nothing was applied", tone: "error" };
  }
  const parts = [
    applied ? `${applied} confirmed` : "",
    unconfirmed ? `${unconfirmed} unconfirmed` : "",
    failed.length ? `${failed.length} failed` : "",
  ].filter(Boolean);
  return {
    // Anything short of fully confirmed is not a success message.
    message: `${parts.join(", ")} — see the details panel`,
    tone: unconfirmed > 0 || failed.length > 0 ? "error" : "info",
  };
}
