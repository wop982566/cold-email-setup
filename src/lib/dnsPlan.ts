// ---------------------------------------------------------------------------
// DNS records for a new cold-email domain, in the exact shape of the zones
// already running.
//
// Derived by diffing two live exports (aeoagency.cloud and aeoagency.online).
// Everything identical across both is generated verbatim; only two things
// genuinely vary per domain and both must be supplied:
//
//   • the three SES DKIM tokens (SES mints them per domain — unguessable)
//   • the www target (a different Netlify site each time)
//
// SOA and NS are deliberately absent: Cloudflare owns those and rejects them
// on import.
//
// Pure module — the page renders, this computes.
// ---------------------------------------------------------------------------

export type RecordType = "CNAME" | "MX" | "TXT";

export interface DnsRecord {
  /** Fully qualified, without the trailing dot. */
  name: string;
  type: RecordType;
  value: string;
  priority?: number;
  ttl: number;
  proxied: boolean;
  /** Why this record exists — shown in the UI, and as a zone comment. */
  note: string;
  /** True when Cloudflare Email Routing creates this record itself. */
  fromEmailRouting: boolean;
}

export interface DomainSpec {
  domain: string;
  /** Mailbox prefixes for this domain, e.g. ["tanuj", "tanuj.s"]. */
  prefixes: string[];
  /** The three tokens SES shows after you add the domain identity. */
  dkimTokens: string[];
  /** Netlify site for the www CNAME. Blank omits the record entirely. */
  netlifySite: string;
}

export interface BatchConfig {
  /** Where Cloudflare Email Routing forwards to. */
  forwardTo: string;
  /** DMARC rua/ruf address. */
  dmarcReportTo: string;
  dmarcPolicy: "none" | "quarantine" | "reject";
  /** Tracking subdomain, e.g. "inst" -> inst.example.com. */
  trackingPrefix: string;
  trackingTarget: string;
  apexTarget: string;
  /** Authorise SES in SPF. The live domains don't; new ones should. */
  includeSes: boolean;
  ttl: number;
  mxPriorities: [number, number, number];
  /**
   * Leave out the records Cloudflare Email Routing writes for itself (MX and
   * its shared DKIM key). Enabling Email Routing before importing is the
   * documented order, so by default they're included to match the existing
   * exports byte for byte — flip this if the import complains about them.
   */
  omitEmailRoutingRecords: boolean;
  /**
   * Send `tracking_domain_name` when creating the Instantly mailbox.
   *
   * Off by default: a freshly-created domain's `inst.` CNAME isn't verified in
   * Instantly yet, and Instantly rejects an account whose tracking domain it
   * can't resolve — a 400 at create time. With this off, the mailbox is created
   * against Instantly's shared tracking domain (which always works) and you
   * point it at your own later, once the CNAME is green.
   */
  sendTrackingDomain: boolean;
}

const MX_HOSTS = ["route1.mx.cloudflare.net", "route2.mx.cloudflare.net", "route3.mx.cloudflare.net"];

/**
 * Cloudflare Email Routing's DKIM key. Byte-identical on both live domains —
 * it's Cloudflare's shared signing key, not something minted per domain — so
 * it's a constant here rather than an input. Split across two quoted strings
 * exactly as BIND requires for values over 255 characters.
 */
const CF_DKIM_PARTS = [
  "v=DKIM1; h=sha256; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAiweykoi+o48IOGuP7GR3X0MOExCUDY/BCRHoWBnh3rChl7WhdyCxW3jgq1daEjPPqoi7sJvdg5hEQVsgVRQP4DcnQDVjGMbASQtrY4WmB1VebF+RPJB2ECPsEDTpeiI5ZyUAwJaVX7r6bznU67g7LvFq35yIo4sdlmtZGV+i0H4cpYH9+3JJ78k",
  "m4KXwaf9xUJCWF6nxeD+qG6Fyruw1Qlbds2r85U9dkNDVAS3gioCvELryh1TxKGiVTkg4wqHTyHfWsp7KD3WQHYJn0RyfJJu6YEmL77zonn7p2SRMvTMP3ZEXibnC9gz3nnhR6wcYL8Q7zXypKTMD58bTixDSJwIDAQAB",
];

export const DKIM_TOKEN_COUNT = 3;
/** SES DKIM tokens are 32 lowercase base32 characters. */
const TOKEN_RE = /[a-z0-9]{32}/gi;

export function defaultBatchConfig(): BatchConfig {
  return {
    forwardTo: "",
    dmarcReportTo: "",
    dmarcPolicy: "none",
    trackingPrefix: "inst",
    trackingTarget: "prox.itrackly.com",
    apexTarget: "apex-loadbalancer.netlify.com",
    includeSes: true,
    ttl: 1,
    mxPriorities: [10, 20, 30],
    omitEmailRoutingRecords: false,
    sendTrackingDomain: false,
  };
}

/** Strip protocol, path, www., trailing dot and case from a pasted domain. */
export function normaliseDomain(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[/?#].*$/, "")
    .replace(/\.$/, "")
    .trim();
}

/** One domain per line, or comma/space separated. Deduped, order preserved. */
export function parseDomains(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of text.split(/[\s,;]+/)) {
    const d = normaliseDomain(part);
    // Must look like a hostname with a TLD.
    if (!d || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) continue;
    if (seen.has(d)) continue;
    seen.add(d);
    out.push(d);
  }
  return out;
}

/**
 * Pull SES DKIM tokens out of whatever you pasted — the three CNAME rows
 * copied from the console, full BIND lines, or bare tokens in any order.
 *
 * Tokens anchored to `._domainkey` or `.dkim.amazonses.com` are preferred; a
 * bare-token paste falls back to any 32-character run. Nothing is invented:
 * fewer than three in means fewer than three out, and the caller reports it.
 */
export function parseDkimTokens(text: string): string[] {
  const anchored = new Set<string>();
  for (const line of text.split(/[\s,]+/)) {
    const m = line.match(/([a-z0-9]{32})(?=\._domainkey|\.dkim\.amazonses\.com)/i);
    if (m) anchored.add(m[1].toLowerCase());
  }
  if (anchored.size > 0) return [...anchored].slice(0, DKIM_TOKEN_COUNT);

  const bare = new Set<string>();
  for (const m of text.matchAll(TOKEN_RE)) bare.add(m[0].toLowerCase());
  return [...bare].slice(0, DKIM_TOKEN_COUNT);
}

/** The www target, accepting "name", "name.netlify.app" or a full URL. */
function netlifyTarget(site: string): string {
  const s = site.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");
  if (!s) return "";
  return s.includes(".") ? s : `${s}.netlify.app`;
}

export function spfValue(config: BatchConfig): string {
  const includes = [config.includeSes ? "include:amazonses.com" : "", "include:_spf.mx.cloudflare.net"]
    .filter(Boolean)
    .join(" ");
  return `v=spf1 ${includes} ~all`;
}

export function dmarcValue(config: BatchConfig): string {
  const to = config.dmarcReportTo.trim();
  const reports = to ? `rua=mailto:${to};ruf=mailto:${to};` : "";
  return `v=DMARC1;p=${config.dmarcPolicy};${reports}`;
}

export function mailboxesFor(spec: DomainSpec): string[] {
  return spec.prefixes
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean)
    .map((p) => `${p}@${spec.domain}`);
}

export function trackingDomainFor(spec: DomainSpec, config: BatchConfig): string {
  const p = config.trackingPrefix.trim();
  return p ? `${p}.${spec.domain}` : spec.domain;
}

/**
 * Every record for one domain, sorted the way Cloudflare's own export sorts
 * them (by type, then name) so a generated zone can be diffed against a live
 * one line by line.
 */
export function recordsFor(spec: DomainSpec, config: BatchConfig): DnsRecord[] {
  const d = spec.domain;
  const ttl = config.ttl;
  const out: DnsRecord[] = [];

  const cname = (name: string, value: string, note: string, fromEmailRouting = false) =>
    out.push({ name, type: "CNAME", value, ttl, proxied: false, note, fromEmailRouting });

  cname(d, config.apexTarget, "Apex points at Netlify so the domain serves a real site");

  const www = netlifyTarget(spec.netlifySite);
  if (www) cname(`www.${d}`, www, "www serves this domain's Netlify site");

  const tracking = config.trackingPrefix.trim();
  if (tracking) {
    cname(
      `${tracking}.${d}`,
      config.trackingTarget,
      "Custom tracking domain — link clicks resolve here instead of Instantly's shared host",
    );
  }

  for (const token of spec.dkimTokens) {
    cname(
      `${token}._domainkey.${d}`,
      `${token}.dkim.amazonses.com`,
      "SES DKIM — signs outgoing mail, and the only thing carrying DMARC today",
    );
  }

  if (!config.omitEmailRoutingRecords) {
    MX_HOSTS.forEach((host, i) =>
      out.push({
        name: d,
        type: "MX",
        value: host,
        priority: config.mxPriorities[i] ?? (i + 1) * 10,
        ttl,
        proxied: false,
        note: "Cloudflare Email Routing receives replies here",
        fromEmailRouting: true,
      }),
    );
  }

  out.push({
    name: d,
    type: "TXT",
    value: spfValue(config),
    ttl,
    proxied: false,
    note: config.includeSes
      ? "SPF authorising SES to send and Cloudflare to receive"
      : "SPF — Cloudflare receiving only. SES sends unauthorised, so SPF fails alignment on every send.",
    fromEmailRouting: false,
  });

  if (!config.omitEmailRoutingRecords) {
    out.push({
      name: `cf2024-1._domainkey.${d}`,
      type: "TXT",
      value: CF_DKIM_PARTS.join(""),
      ttl,
      proxied: false,
      note: "Cloudflare Email Routing's shared DKIM key — identical on every domain",
      fromEmailRouting: true,
    });
  }

  out.push({
    name: `_dmarc.${d}`,
    type: "TXT",
    value: dmarcValue(config),
    ttl,
    proxied: false,
    note: `DMARC, policy ${config.dmarcPolicy}`,
    fromEmailRouting: false,
  });

  const typeOrder: Record<RecordType, number> = { CNAME: 0, MX: 1, TXT: 2 };
  return out.sort(
    (a, b) => typeOrder[a.type] - typeOrder[b.type] || a.name.localeCompare(b.name) || (a.priority ?? 0) - (b.priority ?? 0),
  );
}

/** BIND value formatting — TXT is quoted, and long TXT is split like Cloudflare's export. */
function zoneValue(r: DnsRecord): string {
  if (r.type === "TXT") {
    if (r.value === CF_DKIM_PARTS.join("")) {
      return CF_DKIM_PARTS.map((p) => `"${p}"`).join(" ");
    }
    return `"${r.value}"`;
  }
  const target = `${r.value}.`;
  return r.type === "MX" ? `${r.priority} ${target}` : target;
}

/**
 * A BIND zone file in the same layout Cloudflare exports, ready for its bulk
 * import. Deliberately omits SOA and NS — Cloudflare manages both and rejects
 * them on import.
 */
export function zoneFileFor(spec: DomainSpec, config: BatchConfig, now = new Date()): string {
  const records = recordsFor(spec, config);
  const lines: string[] = [
    ";;",
    `;; Domain:     ${spec.domain}.`,
    `;; Generated:  ${now.toISOString().slice(0, 19).replace("T", " ")}`,
    ";;",
    ";; Import into Cloudflare via DNS > Records > Import and Export.",
    ";; SOA and NS are omitted on purpose — Cloudflare manages those.",
    ";;",
  ];

  const section = (title: string, type: RecordType) => {
    const rows = records.filter((r) => r.type === type);
    if (rows.length === 0) return;
    lines.push("", `;; ${title}`);
    for (const r of rows) {
      const suffix = r.type === "CNAME" ? " ; cf_tags=cf-proxied:false" : "";
      lines.push(`${r.name}.\t${r.ttl}\tIN\t${r.type}\t${zoneValue(r)}${suffix}`);
    }
  };

  section("CNAME Records", "CNAME");
  section("MX Records", "MX");
  section("TXT Records", "TXT");

  return lines.join("\n") + "\n";
}

/** All zones in one file, so a batch is a single download. */
export function zoneBundle(specs: DomainSpec[], config: BatchConfig, now = new Date()): string {
  return specs.map((s) => zoneFileFor(s, config, now)).join("\n\n");
}

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** Cloudflare-style CSV, as a secondary import format. */
export function csvFor(specs: DomainSpec[], config: BatchConfig): string {
  const rows = [["domain", "type", "name", "content", "ttl", "priority", "proxied"]];
  for (const spec of specs) {
    for (const r of recordsFor(spec, config)) {
      rows.push([
        spec.domain,
        r.type,
        r.name,
        r.value,
        String(r.ttl),
        r.priority === undefined ? "" : String(r.priority),
        "false",
      ]);
    }
  }
  return rows.map((r) => r.map(csvCell).join(",")).join("\n");
}

export interface SpecStatus {
  domain: string;
  dkimCount: number;
  dkimComplete: boolean;
  hasWww: boolean;
  mailboxes: string[];
  problems: string[];
}

export function statusFor(spec: DomainSpec, config: BatchConfig): SpecStatus {
  const problems: string[] = [];
  if (spec.dkimTokens.length === 0) {
    problems.push("No DKIM tokens — mail will not be signed, and DMARC will fail");
  } else if (spec.dkimTokens.length < DKIM_TOKEN_COUNT) {
    problems.push(`Only ${spec.dkimTokens.length} of ${DKIM_TOKEN_COUNT} DKIM tokens`);
  }
  if (mailboxesFor(spec).length === 0) problems.push("No mailbox prefixes set");
  if (!spec.netlifySite.trim()) problems.push("No Netlify site — the www record is omitted");
  if (!config.forwardTo.trim()) problems.push("No forwarding address — replies have nowhere to go");
  if (!config.dmarcReportTo.trim()) problems.push("No DMARC reporting address");

  return {
    domain: spec.domain,
    dkimCount: spec.dkimTokens.length,
    dkimComplete: spec.dkimTokens.length === DKIM_TOKEN_COUNT,
    hasWww: Boolean(spec.netlifySite.trim()),
    mailboxes: mailboxesFor(spec),
    problems,
  };
}

/** The manual steps, in the order that avoids the Email Routing / MX clash. */
export function checklistFor(specs: DomainSpec[], config: BatchConfig): string[] {
  const n = specs.length;
  const mailboxes = specs.reduce((sum, s) => sum + mailboxesFor(s).length, 0);
  return [
    `Register or transfer ${n} domain${n === 1 ? "" : "s"} and point the nameservers at Cloudflare.`,
    "In Cloudflare, enable Email Routing FIRST — it writes its own MX records, and doing it after the import is what creates duplicates.",
    `Add each forwarding address and verify ${config.forwardTo || "your destination inbox"}.`,
    "In Amazon SES, add each domain as an identity with Easy DKIM, then paste the three CNAME tokens it shows into this page.",
    "Download the zone file per domain and import it in Cloudflare (DNS > Records > Import and Export).",
    "Wait for SES to report the DKIM status as Verified — usually minutes, occasionally hours.",
    `Create the ${mailboxes} mailbox${mailboxes === 1 ? "" : "es"} in Instantly using a saved credential profile.`,
    "Start warmup and leave it alone for at least two weeks before attaching anything to a live campaign.",
  ];
}
