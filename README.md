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

### The Accounts tab

The Campaign Planner's **Accounts** tab is where you tag inboxes and confirm
what a tag buys them. It lists **every** connected inbox — tagged and untagged
in one table, untagged surfaced first because those are the ones that can't be
swapped. Each row shows its current niche (or an `untagged` flag), a picker to
attach or change one, and — after you press **Verify** — the exact campaigns
that inbox is eligible to be swapped into.

The picker's options are **fetched live from Instantly**: every tag seen on your
campaigns and accounts, plus any niche your campaigns already use, plus anything
already assigned in the app. Saving writes the tag to `mailbox_tags` — the same
table the swapper reads — so a tag set here takes effect immediately, and
changing a tag clears its stale verification so you re-verify against the new
niche.

**Verify uses the swapper's own rule**, not a second opinion. Eligibility is
computed with the same `campaignTagsOf` resolution and `eligibleFor`
intersection the Maintenance tab and the daily cron use
(`src/lib/accountsTag.ts` is built on those primitives), so a campaign appears
as eligible here **if and only if** a swap would actually be allowed into it. An
untagged account verifies to nothing, and a tagged account that matches no
campaign's tag says so rather than showing an empty column ambiguously. **Verify
all** runs the check across every inbox at once. The stat cards summarise
coverage: total inboxes, how many are tagged (swap-eligible), how many are not,
and how many campaigns carry a tag.

**Matching is an exact tag comparison, so "no campaign matches" has three
distinct causes** — and the tab now names which one you hit: the account has no
tag; the account's tag doesn't equal any campaign's tag (e.g. you typed
`FOR AEO CAMPAIGN` but the campaign's tag is `AEO`); or **no campaign has a tag
at all** (the usual case when Instantly's custom-tags endpoint returns nothing),
in which case tagging the inbox can never help until the campaigns get tags. A
collapsible **Campaign tags** reference lists every campaign and its current
tag(s), so a mismatch is always visible.

**Match… — the manual binding.** When you can't rely on Instantly's tags, the
**Match…** button on any account opens a picker of every campaign (each showing
its current tag) plus a niche field. Confirming gives the account and the
campaigns you tick a **shared niche tag**: it writes the niche to the account's
`mailbox_tags` row and to each chosen campaign's `campaign_group_overrides`
entry. Because the swapper resolves a campaign's niche as *Instantly tag →
`campaign_group_overrides` → untagged* and gates on `eligibleFor`, the account
is immediately swap-eligible for those campaigns **and every sibling sharing the
niche** — in both the Maintenance tab and the daily cron, with no change to the
swap-decision code. One caveat, surfaced in the UI: a campaign already tagged in
Instantly keeps that tag (Instantly wins over the override), so Match leaves it
untouched and tells you to retag it in Instantly instead.

**IMAP/SMTP per account.** Each row shows, under the address, the IMAP login it
uses (SMTP in the tooltip), tagged **live** when Instantly reports it or
**setup log** when the value is reconstructed from the credential profile that
created the mailbox — the app knows which `mail_profiles` profile made each
address (via the batch's `created_emails`) and expands its `{prefix}/{domain}`
username template with the mailbox's own local-part and domain. Live wins per
field; the log only fills gaps, because an IMAP you changed in Instantly is the
truth and the creation-time log may be stale. Passwords are never read from
either source. A per-row **raw** expander shows the account's raw JSON so any
IMAP key the mapper doesn't yet recognise is discoverable, and **Load IMAP
details** backfills from `account-detail` on demand. The `mail_profiles` source
needs `APP_FUNCTION_TOKEN` (the table is gated); without it, only the live value
shows. The Plan tab's **Accounts by IMAP** card renders the same grouping as a
clean table.

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

**See which IMAP/SMTP each account uses.** The Campaign Planner shows an **IMAP**
column per inbox and an **Accounts by IMAP** card that lists every inbox grouped
under the login it shares — read live from Instantly (the account's own value,
not a saved profile that may be stale). Passwords are never shown: they're
write-only in Instantly and the account-detail read scrubs them. If the accounts
list doesn't carry IMAP fields, **Load IMAP details** fills them on demand from
`account-detail`.

**Lead progress mirrors Instantly, and never overshoots.** The planner's
per-campaign progress reads Instantly's own per-status counts —
`completed / total` is the headline percent (matching Instantly's "Progress"),
and **not-yet-contacted** is the real "leads left" that drives the finish-ETA.
It no longer derives "remaining" as `total − contacted_count`: that counter is
cumulative and can exceed the current list, which used to clamp remaining to 0
and wrongly declare a 14%-done list "complete". A list only reads as finished
when Instantly's own not-yet-contacted is a real zero. `src/lib/leadStatus.ts`
reconciles these counts defensively and **never reports a number larger than the
list total**; when Instantly returns only the cumulative counter it says
"per-status counts unavailable" rather than inventing a completion. **Load exact
lead counts** aggregates the per-lead list to reproduce Instantly's Completed /
contacted / not-yet-contacted figures exactly, overriding the analytics row.

Two related display fixes: the group **"spare"** badge now shows the real
supply−demand surplus (it was pinned to 0), the capacity footer's
`inboxes × per-day` arithmetic reconciles (the shared-mailbox share is shown
separately rather than as a result that didn't add up), the campaign **health**
line labels its three separate figures (overall score · weakest inbox · worst
placement) so they don't read as one broken equation, and **sending** is shown
against the campaign's own Instantly daily limit rather than a derived
fair-share number.

**The Domains tab mirrors Instantly live.** On load it reads the connected
accounts and reconciles them against the stored table: a domain Instantly has
that the table doesn't is **added automatically** (pre-filled with its mailbox
addresses and `connected = Yes`, registrar/expiry/DNS left blank for you), and
existing rows have their Instantly-owned fields — connection, warmup, and any
blank mailbox slot — refreshed to the live value. It's additive and idempotent:
it only ever fills blanks and updates status that actually changed, never
overwrites your registrar/expiry/DNS/cost/notes, and never deletes — so a
transient empty read can't wipe anything. Because the new rows are persisted,
**Capacity and the Dashboard count them too**. Newly created inboxes from bulk
setup are pushed into the Domains tab the moment they're created.

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
