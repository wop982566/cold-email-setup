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
| **Campaign Planner** | Per-campaign-group demand vs mailbox supply from live Instantly data (contention-aware), lead runway, idle mailboxes, mailbox exclusions, and a goal planner: \"to send N emails/day you need X inboxes across Y domains\". |
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
| `INSTANTLY_WRITE_ENABLED` | functions | **Required for any write.** Set to `true` to let the planner create mailboxes and swap them on campaigns. Unset, every write returns 403 and the Maintenance tab shows a banner saying so. Reads are unaffected. |
| `AUTO_SWAP_ENABLED` | functions | Kill switch for the daily automatic swapper (`netlify/functions/auto-swap.mts`, logic in `_autoSwapRun.ts`). Unset or not `true`, the scheduled run exits immediately having changed nothing. Also requires `INSTANTLY_WRITE_ENABLED`. |
| `RESEND_API_KEY` | functions | Resend key for run-summary emails. Without it the swapper still runs and still logs — it just can't email you. The sending domain must be verified in Resend or sends fail with 403. |
| `OPENAI_API_KEY` | functions | Enables AI lead enrichment (server-side only) |
| `OPENAI_MODEL` | functions | Optional, defaults to `gpt-4o-mini` |
| `APP_FUNCTION_TOKEN` + `VITE_APP_TOKEN` | both | Shared secret so only your app can call the functions. Also **required** to read or write saved mailbox credentials (Settings → Mailbox credentials) — without it that table is refused outright, since it holds SMTP/IMAP passwords. Set `VITE_APP_TOKEN` to the same value, and do **not** mark it Secret in Netlify or the build can't read it. |
| `VITE_APP_USERNAME` + `VITE_APP_PASSWORD` | build | Optional login gate. Set the password to require sign-in. |

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
  `analytics-campaigns`, `analytics-daily`, `campaign-detail`, `leads`, `warmup`
  (accounts/campaigns/leads are paginated server-side). Powers the Instantly insights page (campaign
  analytics, mailbox/warmup health, sending volume vs plan) with the key kept
  server-side.
- **`/.netlify/functions/auto-swap`** — **scheduled daily** (`@daily`, UTC).
  Replaces failing mailboxes in live campaigns without you having to watch for
  them. It imports `computePlan`/`computeMaintenance` directly and calls the
  `instantly` handler in-process, so it decides exactly what the Maintenance tab
  would have shown you — there is no second implementation to drift.

  **Guardrails.** Exits immediately unless `AUTO_SWAP_ENABLED=true`, and every
  write still passes the `INSTANTLY_WRITE_ENABLED` gate. Per run it will swap at
  most `auto_swap_max_per_run` mailboxes (default 2), worst-scoring first, so a
  bad metrics day can't empty your campaigns. It never swaps in a mailbox that
  is excluded, convalescing, immature or below your score floor — if no healthy
  spare exists it leaves the bad one in place rather than swapping in something
  worse. Each write is confirmed by reading the campaign back; an unconfirmed
  write records nothing. Set `auto_swap_min_bad_days` above 1 to require that
  many consecutive bad daily readings before it acts.

  Every run is recorded — including quiet runs and crashes — and shown under
  **Automatic swaps** on the Maintenance tab, so silence there always means
  "nothing to report" rather than "the cron died". Swaps it makes are ordinary
  archive entries, so you can undo any of them by hand.

  **Testing it without waiting a day.** The buttons call
  `/.netlify/functions/auto-swap-test`, a separate ordinary HTTP function —
  **not** `auto-swap` itself. Netlify does not serve scheduled functions over
  HTTP, so anything with a `schedule` export answers an empty 404; both share
  one implementation in `_autoSwapRun.ts`. Do not add a `schedule` export to
  `auto-swap-test.mts` or the buttons break again.

  The same panel has two buttons.
  *Test now (dry run)* runs the entire pipeline — settings, Instantly fetch,
  health, the swap decision — and writes **nothing**, then shows exactly what it
  would have swapped and what it skipped. *Send test email* pushes one message
  through Resend and reports what the API actually said, so a missing key or an
  unverified sending domain is named rather than swallowed. Both are gated on
  `APP_FUNCTION_TOKEN` when it is set.

  **Note on scheduling:** Netlify runs scheduled functions only on *production*
  deploys. If the branch carrying this code is a branch deploy rather than the
  production branch, the cron never fires however the env vars are set.

---

## 🏷️ Niche tags

A mailbox warmed on CBD outreach has a reputation built against that audience.
Dropping it into a kratom campaign because it was the healthiest spare wastes the
warmup and pollutes both niches, so **a mailbox is only ever swapped into a
campaign of its own niche.**

A campaign's niche is a **tag you set in Instantly** — never its name. Tagging
two unrelated campaigns `AEO` makes one AEO mailbox eligible for both, including
campaigns you create later; deriving a niche from the name would tie a mailbox
to one campaign and lock it out of its own siblings.

Resolution order, used by the UI and the cron alike: tags from Instantly, else
an explicit per-campaign entry in `campaign_group_overrides` (comma-separated
for two niches), else untagged — and an untagged campaign takes no swaps. Tags
are read from Instantly's custom-tags endpoint, probed across several paths
because the API has moved it between revisions; the response names the path that
answered, so the Maintenance tab can tell you if none of them exist.

A mailbox's niche is explicit, stored in `mailbox_tags`, because a swap
candidate is by definition attached to no active campaign and so has no history
to infer one from. Set it in bulk setup (a chip row per domain, applied to both
its mailboxes) or later in the Planner's mailbox table, **Niche** column.

**Untagged means never eligible.** "We don't know" has to mean "don't touch it",
or the whole rule is decorative. The practical consequence is that a brand-new
spare cannot be swapped anywhere until you tag it — so untagged spares are
reported as their own outcome in the Maintenance tab, the dry run and the daily
email, rather than looking like a quiet day. If gating is ever off (no tag map
supplied), the tab says so in red.

---

## 💾 Bulk setup batches

The Bulk Setup page saves as you work. A batch is a stored record — domains,
per-domain DKIM tokens, prefixes, tracking config and the chosen credential
profile — kept in the `setup_batches` table, named, and listed at the top of the
page so a run you started last week is still there.

Saving is **server-side only**, on a ~700ms debounce, and also flushes when a
field loses focus and again on `pagehide` using `fetch(keepalive: true)` so a
refresh mid-edit still commits. The header shows *Saved / Saving / Unsaved*, and
the browser warns before you leave with genuinely unsaved changes.

It stores `profile_id` only — SMTP and IMAP credentials stay in `mail_profiles`,
which is gated behind `APP_FUNCTION_TOKEN`.

`created_emails` records the mailboxes Instantly **confirmed**, so an
interrupted run resumes instead of re-attempting every address: creating again
skips what exists and tells you how many it skipped. Dry runs and failed creates
are never recorded — either would make the next run skip a mailbox that doesn't
exist.

**Updating inboxes that already exist.** *Live inboxes* on the bulk-setup page
reads the current Instantly settings for the batch's domains (name, daily limit,
warmup, tracking domain, tags, warmup filter tag) — each row expands to raw JSON.
Below it, a bulk updater pushes only the fields you tick — tracking domain
(`inst.<each inbox's own domain>`), name, daily limit, warmup, tags, warmup
filter tag — to the selected inboxes. **Preview** dry-runs the exact diff; **Apply**
PATCHes each and surfaces the per-inbox result. It never creates an account, and
the server whitelists the patch so no credential field can be sent. Tags and the
warmup filter tag are written back under the exact key the live account exposes
them under (visible in the raw JSON); if an inbox doesn't expose that key, the
field is skipped with a reason rather than sent as a guess.

**Manual import — the API-free path.** *Instantly CSV* on the create panel
downloads a ready-to-upload account file in Instantly's exact 15-column format
(`Email, First/Last Name, IMAP/SMTP …, Warmup …`), filled from the batch and the
selected credential profile, generated entirely in your browser. Tweak anything
(the SMTP port especially — port 25 is throttled by AWS; 587 is safer) and
import it into Instantly directly, skipping the API. The file holds plaintext
SMTP/IMAP passwords, so delete it after importing.

**Usernames are the login, not the mailbox address.** The SMTP/IMAP username on
a credential profile is sent as-is — a blank one is no longer silently replaced
with the mailbox email, which is what produced *"IMAP connection failed"* on a
shared-account setup (one Gmail IMAP + an SES access key). Set it explicitly: the
SES access key for SMTP, your shared address for IMAP, or `{prefix}@{domain}` for
per-mailbox Google. A blank username is reported, not guessed.

**Creating mailboxes — the tracking-domain default.** Instantly rejects an
account whose `tracking_domain_name` it can't verify, and a brand-new domain's
`inst.` CNAME isn't verified yet — so the batch **omits the tracking domain by
default** and creates against Instantly's shared one. Tick *"Send a custom
tracking domain"* in the create panel once your CNAME is green. When a create
does fail, the log now shows Instantly's own message and the exact (credential-
scrubbed) payload sent, so a 400 names its own cause instead of reading only
"Instantly 400". Provider code lives on the credential profile — custom SMTP
(SES) uses a different code from Google/Microsoft, and the surfaced error names
the one Instantly expects.

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
