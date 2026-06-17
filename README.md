# Cold Email Command Center

A bird's-eye dashboard for running a cold-email operation: domains & mailboxes,
**sending-capacity planning**, **lead management with sub-lists + enrichment**,
**cost tracking**, **domain-expiry reminders**, and **setup playbooks** that
remember exactly how you built everything last time. Gumroad-inspired UI.

Built with **React + Vite + TypeScript + Tailwind**, a **Supabase** backend
(optional — falls back to local browser storage), and two **Netlify Functions**
for domain-expiry lookups and AI enrichment.

---

## ✨ What's inside

| Page | What it does |
|------|--------------|
| **Dashboard** | KPIs, sending-capacity utilisation, domains-by-campaign, expiry alerts, setup readiness. |
| **Domains** | Every field from your sheet (emails, expiry, registrar, DNS, forwarding, hosting account, Gravatar, Gmail send-as, Instantly, warmup). Search/filter, CSV import/export, **auto-fetch expiry** (RDAP/WHOIS) with manual fallback, per-domain mailbox limits, custom fields. |
| **Sending Capacity** | The real ceiling = **min(mailbox capacity, SES cap, Instantly cap)**. Per-mailbox daily limits (global + per-domain overrides), bottleneck breakdown, "how many domains to max out SES", leads/month throughput. Fully editable provider limits. |
| **Leads** | Master list + nested **sub-lists**, advanced filters (status, industry, score, hide-already-used), **dedupe**, bulk move/tag/status, **make sub-list from selection**, CSV import (auto-dedupes on email), **AI enrichment (ChatGPT)** + **manual enrichment**. |
| **Costs** | Track domains, SES, Instantly, hosting, AI, etc. Monthly/annual totals, cost-per-domain, cost-per-1k-emails, spend-by-category, upcoming renewals. |
| **Setup Playbooks** | Named, dated, step-by-step record of how a setup was built — registrar → DNS → SES → forwarding → sites → Gmail send-as → Instantly → warmup, with platforms, accounts and links. Seeded with your current 2026 setup. |
| **Insights** | Domain-health score, lead funnel, leads-per-campaign, expiry-by-month, capacity utilisation, and an **Opportunities** list that nudges you to use your full capacity. |
| **Settings** | Workspace config, currency, reminder window, campaigns, **custom fields**, AI toggle, Supabase connection guide, JSON export, reset. |

Everything is customisable — provider limits, costs, campaigns and custom
fields are all editable in the UI.

---

## 🚀 Run it locally

```bash
npm install
npm run dev      # http://localhost:5173
```

With no environment variables, the app runs in **Local mode**: all data lives in
your browser (`localStorage`), pre-seeded with your 20 domains, capacity limits,
costs and the 2026 setup playbook. Great for trying it out immediately.

```bash
npm run build    # type-check + production build into dist/
npm run preview  # preview the production build
```

---

## 🗄️ Connect Supabase (recommended)

So data is permanent and synced across devices.

1. Create a new project at [supabase.com](https://supabase.com).
2. Open **SQL Editor** and run, in order:
   - `supabase/migrations/0001_init.sql` (tables, triggers, RLS policies)
   - `supabase/migrations/0002_seed.sql` (campaigns, your 20 domains, etc.)
3. Get your keys from **Project Settings → API**:
   - **Project URL** → `VITE_SUPABASE_URL`
   - **anon public** key → `VITE_SUPABASE_ANON_KEY`
4. Set them as environment variables (local `.env`, or Netlify env vars) and
   rebuild/redeploy. The header badge flips from **Local mode** to **Supabase**.

> **Note on access:** you chose an **open (no-login)** app, so the RLS policies
> allow anyone with the anon key full read/write. Keep the URL private, or add
> Supabase Auth later and tighten the `anon_all` policies in `0001_init.sql`.

### What to send me to wire it up

If you'd like me to configure it for you, paste:

- `VITE_SUPABASE_URL` (Project URL)
- `VITE_SUPABASE_ANON_KEY` (anon public key)
- *(optional)* the **service-role** key or DB connection string if you want me
  to run the migrations for you instead of pasting the SQL yourself.

---

## ☁️ Deploy to Netlify

The repo is Netlify-ready (`netlify.toml`):

- Build command: `npm run build`, publish dir: `dist`, functions dir: `netlify/functions`.
- SPA redirect is configured so deep links work.

Set these env vars in **Netlify → Site settings → Environment variables**:

| Variable | Where | Purpose |
|----------|-------|---------|
| `VITE_SUPABASE_URL` | build | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | build | Supabase anon key |
| `ANTHROPIC_API_KEY` | functions | Claude AI cold-email sequence generation |
| `ANTHROPIC_MODEL` | functions | Optional, defaults to `claude-opus-4-8` (cheaper: `claude-sonnet-4-6`, `claude-haiku-4-5`) |
| `INSTANTLY_API_KEY` | functions | Instantly v2 key (read scopes) — live insights page |
| `OPENAI_API_KEY` | functions | Enables AI lead enrichment (server-side only) |
| `OPENAI_MODEL` | functions | Optional, defaults to `gpt-4o-mini` |
| `APP_FUNCTION_TOKEN` + `VITE_APP_TOKEN` | both | Optional shared secret so only your app can call the functions |

---

## 🔌 Serverless functions

- **`/.netlify/functions/domain-expiry?domain=example.com`** — looks up the
  registry expiry date via **RDAP** (with an `rdap.org` fallback), returning
  `{ ok, expiry, registrar }`. If a TLD has no RDAP data, the UI lets you enter
  the date manually. Powers the "Auto-fetch expiry" buttons and the
  **expiry reminders** (domains expiring within your reminder window).
- **`/.netlify/functions/enrich`** — optional **OpenAI** enrichment. Send leads +
  instructions; it returns inferred `industry`, a 0-100 fit `score`, and a
  one-line `summary`. AI is intentionally optional — the Leads page has powerful
  manual filters + bulk-fill so you can enrich entirely on your own.
- **`/.netlify/functions/generate-sequence`** — **Claude** cold-email sequence
  generator. Takes the builder's brief, returns a structured multi-email
  sequence using the target platform's merge variables + spintax (Instantly by
  default). Defaults to `claude-opus-4-8`.
- **`/.netlify/functions/instantly`** — read-only proxy for the **Instantly v2
  API**. Whitelisted resources: `accounts`, `campaigns`, `analytics-overview`,
  `analytics-campaigns`, `warmup`. Powers the Instantly insights page (campaign
  analytics, mailbox/warmup health, sending volume vs plan) with the key kept
  server-side.

---

## 🧱 Tech & structure

```
src/
  lib/        types, seed data, db adapter (Supabase|local), capacity & cost math, hooks
  components/ ui primitives (Gumroad style), layout, badges, modals, toasts
  pages/      Dashboard, Domains, Capacity, Leads, Costs, Setups, Insights, Settings
netlify/functions/  domain-expiry.mts, enrich.mts
supabase/migrations/ 0001_init.sql, 0002_seed.sql
```

The data layer (`src/lib/db.ts`) exposes one async API with two backends, so the
UI never cares whether it's talking to Supabase or localStorage.
