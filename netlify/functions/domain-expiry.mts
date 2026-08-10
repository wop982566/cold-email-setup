// Domain expiry lookup via RDAP (the modern, HTTPS/JSON replacement for WHOIS).
// Uses the IANA bootstrap registry to find the right RDAP server per TLD.
// Falls back gracefully so the UI can prompt for manual entry.

let bootstrapCache: { services: [string[], string[]][] } | null = null;
let bootstrapFetchedAt = 0;

async function getBootstrap(): Promise<{ services: [string[], string[]][] } | null> {
  const ONE_DAY = 24 * 60 * 60 * 1000;
  if (bootstrapCache && Date.now() - bootstrapFetchedAt < ONE_DAY) return bootstrapCache;
  try {
    const res = await fetch("https://data.iana.org/rdap/dns.json");
    if (!res.ok) return bootstrapCache;
    bootstrapCache = (await res.json()) as { services: [string[], string[]][] };
    bootstrapFetchedAt = Date.now();
    return bootstrapCache;
  } catch {
    return bootstrapCache;
  }
}

function rdapServerFor(tld: string, bootstrap: { services: [string[], string[]][] } | null): string | null {
  if (!bootstrap) return null;
  for (const [tlds, servers] of bootstrap.services) {
    if (tlds.includes(tld) && servers.length > 0) {
      return servers[0].replace(/\/$/, "");
    }
  }
  return null;
}

function tokenOk(req: Request): boolean {
  const required = process.env.APP_FUNCTION_TOKEN;
  if (!required) return true;
  return req.headers.get("x-app-token") === required;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export default async (req: Request): Promise<Response> => {
  if (!tokenOk(req)) return json({ ok: false, error: "Unauthorized" }, 401);

  const url = new URL(req.url);
  const domain = (url.searchParams.get("domain") || "").trim().toLowerCase();
  if (!domain || !domain.includes(".")) {
    return json({ ok: false, domain, expiry: null, error: "Invalid domain" }, 400);
  }

  const tld = domain.split(".").pop() as string;
  const bootstrap = await getBootstrap();
  const server = rdapServerFor(tld, bootstrap);

  // Try the per-TLD server, then the rdap.org aggregator as a fallback.
  const candidates = [
    server ? `${server}/domain/${domain}` : null,
    `https://rdap.org/domain/${domain}`,
  ].filter(Boolean) as string[];

  for (const endpoint of candidates) {
    try {
      const res = await fetch(endpoint, { headers: { Accept: "application/rdap+json" } });
      if (!res.ok) continue;
      const data = (await res.json()) as {
        events?: { eventAction: string; eventDate: string }[];
        entities?: { roles?: string[]; vcardArray?: unknown }[];
      };
      const expEvent = data.events?.find(
        (e) => e.eventAction === "expiration" || e.eventAction === "registration expiration",
      );
      if (!expEvent?.eventDate) continue;

      const expiry = expEvent.eventDate.slice(0, 10); // ISO date
      let registrar: string | null = null;
      const reg = data.entities?.find((e) => e.roles?.includes("registrar"));
      if (reg && Array.isArray(reg.vcardArray)) {
        const vcard = reg.vcardArray[1] as unknown[];
        if (Array.isArray(vcard)) {
          const fn = vcard.find((entry) => Array.isArray(entry) && entry[0] === "fn") as
            | unknown[]
            | undefined;
          if (fn && typeof fn[3] === "string") registrar = fn[3];
        }
      }

      return json({ ok: true, domain, expiry, registrar, source: "rdap" });
    } catch {
      // try next candidate
    }
  }

  return json({
    ok: false,
    domain,
    expiry: null,
    error: "RDAP lookup failed for this TLD — enter the expiry date manually.",
  });
};
