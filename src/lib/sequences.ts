// ---------------------------------------------------------------------------
// Cold-email sequence helpers: platform variable/spintax reference, an offline
// template generator (used when the AI key isn't set), performance math, and
// the subject/body/CTA diagnosis from the cold-email playbook.
// ---------------------------------------------------------------------------
import {
  SequenceBrief,
  SequenceEmail,
  SequencePerformance,
  SequencePlatform,
} from "./types";
import { uuid } from "./utils";

export const DEFAULT_BRIEF: SequenceBrief = {
  audience: "",
  sender_name: "",
  sender_role: "",
  offer: "",
  proof: "",
  signal: "",
  industry: "",
  angle: "save time",
  personalization: "segment",
  tone: "peer / conversational",
  sequence_type: "classic7",
  email_count: 7,
  length_pref: "short",
  cta_style: "interest",
  use_spintax: true,
  notes: "",
};

export const DEFAULT_PERFORMANCE: SequencePerformance = {
  sent: 0,
  opens: 0,
  replies: 0,
  positive_replies: 0,
  meetings: 0,
  rating: 0,
  is_winner: false,
  notes: "",
};

// Per-platform merge-tag + spintax reference. Default is Instantly.
export const PLATFORM_INFO: Record<
  SequencePlatform,
  { label: string; variables: string[]; fallback: string; spintax: string; note: string }
> = {
  instantly: {
    label: "Instantly.ai",
    variables: [
      "{{firstName}}",
      "{{lastName}}",
      "{{companyName}}",
      "{{email}}",
      "{{title}}",
      "{{website}}",
      "{{phone}}",
      "{{location}}",
      "{{industry}}",
      "{{sendingAccountFirstName}}",
      "{{customVariable}}",
    ],
    fallback: "{{firstName|there}}",
    spintax: "{Hi|Hey|Hello}",
    note: "Instantly supports {{variables}} (with per-variable fallback values) and {spintax|spin|syntax} for randomized variations that boost deliverability.",
  },
  smartlead: {
    label: "Smartlead",
    variables: ["{{first_name}}", "{{last_name}}", "{{company_name}}", "{{title}}", "{{website}}"],
    fallback: "{{first_name|there}}",
    spintax: "{Hi|Hey}",
    note: "Smartlead uses {{snake_case}} variables and spintax for variation.",
  },
  apollo: {
    label: "Apollo",
    variables: ["{{first_name}}", "{{last_name}}", "{{company}}", "{{title}}"],
    fallback: "{{first_name}}",
    spintax: "—",
    note: "Apollo uses {{first_name}} style variables; spintax is limited.",
  },
  lemlist: {
    label: "lemlist",
    variables: ["{{firstName}}", "{{companyName}}", "{{signature}}", "{{customVar}}"],
    fallback: '{{firstName|"there"}}',
    spintax: "{{spin:Hi|Hey}}",
    note: "lemlist uses {{firstName}} variables with fallback and {{spin:...}} syntax.",
  },
  gmail: {
    label: "Gmail (manual)",
    variables: ["{FirstName}", "{Company}"],
    fallback: "{FirstName}",
    spintax: "—",
    note: "Plain merge fields for manual / mail-merge sends.",
  },
  manual: {
    label: "Manual / other",
    variables: ["{{firstName}}", "{{companyName}}"],
    fallback: "{{firstName|there}}",
    spintax: "{Hi|Hey}",
    note: "Generic variables — adapt to your tool.",
  },
};

export const SEQUENCE_TYPES = [
  { value: "classic7", label: "Classic (7 emails, ~2 weeks)", count: 7 },
  { value: "fast5", label: "Fast-track (5 emails, ~1 week)", count: 5 },
  { value: "nurture", label: "Long nurture (10 emails, ~5 weeks)", count: 10 },
  { value: "custom", label: "Custom length", count: 5 },
];

// Send-day cadence for a given number of steps (increasing gaps).
export function cadenceFor(count: number): number[] {
  const presets: Record<number, number[]> = {
    3: [0, 3, 7],
    4: [0, 3, 7, 12],
    5: [0, 2, 5, 9, 14],
    6: [0, 2, 5, 9, 14, 21],
    7: [0, 2, 4, 7, 10, 14, 21],
    10: [0, 2, 4, 7, 10, 14, 18, 24, 30, 38],
  };
  if (presets[count]) return presets[count];
  const days: number[] = [];
  let d = 0;
  let gap = 2;
  for (let i = 0; i < count; i++) {
    days.push(d);
    d += gap;
    gap += 1;
  }
  return days;
}

const SEND_TIMES = ["10:00", "11:00", "14:00", "10:30", "15:00", "09:00", "16:00"];

// Offline fallback generator — scaffolds a sequence with the cold-email
// structure and platform variables, so the tool is useful even without AI.
export function buildTemplateSequence(brief: SequenceBrief): Omit<SequenceEmail, "id" | "sequence_id">[] {
  const v = PLATFORM_INFO.instantly; // template uses Instantly-style tags
  const fn = "{{firstName}}";
  const co = "{{companyName}}";
  const spin = (opts: string) => (brief.use_spintax ? `{${opts}}` : opts.split("|")[0]);
  const offer = brief.offer || "help teams like yours with this";
  const proof = brief.proof || "we recently helped a similar company get a clear result";
  const angle = brief.angle || "the usual challenge here";
  const signal = brief.signal ? `${brief.signal} — ` : "";

  const blocks: { subject: string; subjects: string[]; body: string; angle: string; goal: string }[] = [
    {
      subject: "quick question",
      subjects: ["quick question", `${brief.industry || "your team"}`, "your setup"],
      body: `${spin("Hi|Hey")} ${fn},\n\n${signal}noticed ${co} is likely dealing with ${angle}. Most ${brief.audience || "teams like yours"} we talk to hit that wall as they scale.\n\nWe ${offer}. ${proof}.\n\nWorth a quick look?\n\n${brief.sender_name || "—"}`,
      angle: "Intro / relevance",
      goal: "Get recognized as relevant + a reply",
    },
    {
      subject: "how this worked",
      subjects: ["how this worked", "a quick example"],
      body: `${fn}, following up with a concrete example.\n\n${proof} — without the usual heavy lift.\n\nHappy to walk through how this could map to ${co}. Open to it?`,
      angle: "Value proof",
      goal: "Establish credibility",
    },
    {
      subject: "different angle",
      subjects: ["different angle", "another thought"],
      body: `${fn}, the first email was about ${angle}.\n\nBut a lot of ${brief.audience || "teams"} care more about ${spin("speed|cost|risk")}. If that's closer to home, we help there too.\n\nIf neither's relevant, just say so and I'll stop.`,
      angle: "Alternate pain point",
      goal: "Re-hook with a new angle",
    },
    {
      subject: "what others are doing",
      subjects: ["what others are doing", "peers in your space"],
      body: `${fn}, sharing what's working for similar ${brief.industry || "companies"}: ${proof}.\n\nNot sure if you're taking the same approach at ${co} — worth comparing notes?`,
      angle: "Social proof",
      goal: "Peer validation",
    },
    {
      subject: "thought this might help",
      subjects: ["thought this might help", "useful either way"],
      body: `${fn}, no ask here — just something useful: a short breakdown of how ${brief.audience || "teams"} tackle ${angle}.\n\nHappy to send it over. Want it?`,
      angle: "Give value",
      goal: "Provide value, lower friction",
    },
    {
      subject: "worth 15 minutes?",
      subjects: ["worth 15 minutes?", "quick chat"],
      body: `${fn}, I'll be direct: I think we can help ${co} with ${angle}.\n\n${offer}. Worth 15 minutes to see if it maps?`,
      angle: "Direct ask",
      goal: "Clear ask for a call",
    },
    {
      subject: "should I close this out?",
      subjects: ["should I close this out?", "last note"],
      body: `${fn}, I'll stop cluttering your inbox after this.\n\nIf ${angle} ever becomes a priority, just reply here and I'll pick it up. If someone else at ${co} is better to talk to, a name would go a long way.\n\nEither way — all the best.`,
      angle: "Breakup",
      goal: "Close the loop (often best reply rate)",
    },
  ];

  const count = Math.max(2, Math.min(brief.email_count || 7, blocks.length));
  // Always keep the breakup as the final email.
  const chosen = count >= blocks.length ? blocks : [...blocks.slice(0, count - 1), blocks[blocks.length - 1]];
  const days = cadenceFor(chosen.length);

  return chosen.map((b, i) => ({
    position: i + 1,
    day: days[i] ?? i * 3,
    send_time: SEND_TIMES[i % SEND_TIMES.length],
    subject: b.subject,
    subject_variants: b.subjects,
    body: b.body,
    angle: b.angle,
    goal: b.goal,
    word_count: b.body.split(/\s+/).filter(Boolean).length,
    notes: "",
  }));
}

// Funnel rates from raw counts.
export function sequenceRates(p: SequencePerformance) {
  const pct = (n: number, d: number) => (d > 0 ? (n / d) * 100 : 0);
  return {
    openRate: pct(p.opens, p.sent),
    replyRate: pct(p.replies, p.sent),
    positiveRate: pct(p.positive_replies, p.replies),
    meetingRate: pct(p.meetings, p.sent),
  };
}

// Diagnose where a live sequence is breaking, per the cold-email playbook.
export function diagnose(p: SequencePerformance): { level: "ok" | "subject" | "body" | "cta" | "nodata"; text: string } {
  if (p.sent < 20) return { level: "nodata", text: "Not enough sends yet — let it run to ~50–100 before judging." };
  const r = sequenceRates(p);
  if (r.openRate < 35)
    return { level: "subject", text: `Open rate ${Math.round(r.openRate)}% is low. The problem is the subject line or deliverability — test shorter, more internal-looking subjects and check warmup/SPF/DKIM.` };
  if (r.replyRate < 4)
    return { level: "body", text: `Opens are healthy but reply rate is ${r.replyRate.toFixed(1)}%. The body or offer isn't landing — tighten the opener, tie personalization to the problem, and sharpen the value prop.` };
  if (r.meetingRate < 1 && p.replies > 0)
    return { level: "cta", text: `You're getting replies but few meetings. The CTA or qualification is off — make the ask lower-friction and more specific.` };
  return { level: "ok", text: `Solid: ${Math.round(r.openRate)}% open, ${r.replyRate.toFixed(1)}% reply. Consider marking this a winner and reusing the angle.` };
}

export function newEmailRow(sequenceId: string, position: number): SequenceEmail {
  return {
    id: uuid(),
    sequence_id: sequenceId,
    position,
    day: position === 1 ? 0 : (position - 1) * 3,
    send_time: "10:00",
    subject: "",
    subject_variants: [],
    body: "",
    angle: "",
    goal: "",
    word_count: 0,
    notes: "",
  };
}
