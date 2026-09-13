-- ===========================================================================
-- Seed data — mirrors src/lib/seed.ts. Safe to run once on a fresh project.
-- Re-running is a no-op thanks to ON CONFLICT DO NOTHING.
-- ===========================================================================

-- Campaigns ------------------------------------------------------------------
insert into campaigns (id, name, type, description, color, status) values
  ('11111111-1111-4111-8111-111111111111', 'AEO Campaign', 'AEO', 'Answer Engine Optimization outreach.', '#FF90E8', 'active'),
  ('22222222-2222-4222-8222-222222222222', 'CBD Campaign', 'CBD', 'CBD niche outreach.', '#23A094', 'active'),
  ('33333333-3333-4333-8333-333333333333', 'Backlink Campaign', 'Backlink', 'Backlink / link-building outreach.', '#90A8ED', 'active')
on conflict (id) do nothing;

-- Domains --------------------------------------------------------------------
insert into domains (
  id, position, domain_name, email_1, email_2, expiry_date, expiry_source,
  domain_provider, mailing_server, mailing_status, dns_provider, dns_status,
  email_forward, hosting_provider, hosting_account, website_note,
  emails_forwarded_to, campaign_id, campaign_label, gravatar,
  gmail_send_configured, connected_to_instantly, warmup_started, renewal_cost
) values
  ('dom-1','1','aeoagency.cloud','tanuj@aeoagency.cloud','tanuj.s@aeoagency.cloud','2027-02-13','manual','IONOS','Amazon SES','Yes','Cloudflare','Yes','Cloudflare','Netlify','git login - tanuj9825','Netlify account git login - tanuj9825','webofpicasso2@gmail.com','11111111-1111-4111-8111-111111111111','AEO Campaign','','Yes','Yes','Yes',12),
  ('dom-2','2','aeoagency.info','tanuj@aeoagency.info','tanuj.s@aeoagency.info','2027-02-13','manual','IONOS','Amazon SES','Yes','Cloudflare','Yes','Cloudflare','Netlify','git login - tanuj9825','Netlify account git login - tanuj9825','webofpicasso2@gmail.com','11111111-1111-4111-8111-111111111111','AEO Campaign','','Yes','Yes','Yes',12),
  ('dom-3','3','aeoagency.online','tanuj@aeoagency.online','tanuj.s@aeoagency.online','2027-02-14','manual','IONOS','Amazon SES','Yes','Cloudflare','Yes','Cloudflare','Netlify','git login - tanuj9825','Netlify account git login - tanuj9825','webofpicasso2@gmail.com','11111111-1111-4111-8111-111111111111','AEO Campaign','','Yes','Yes','Yes',12),
  ('dom-4','4','aeoagency.website','tanuj@aeoagency.website','tanuj.s@aeoagency.website','2027-02-14','manual','IONOS','Amazon SES','Yes','Cloudflare','Yes','Cloudflare','Netlify','git login - tanuj9825','Netlify account git login - tanuj9825','webofpicasso2@gmail.com','11111111-1111-4111-8111-111111111111','AEO Campaign','','Yes','Yes','Yes',12),
  ('dom-5','5','theaeoagency.info','tanuj@theaeoagency.info','tanuj.s@theaeoagency.info','2027-02-13','manual','IONOS','Amazon SES','Yes','Cloudflare','Yes','Cloudflare','Netlify','git login - tanuj9825','Netlify account git login - tanuj9825','webofpicasso2@gmail.com','11111111-1111-4111-8111-111111111111','AEO Campaign','','Yes','Yes','Yes',12),
  ('dom-6','6','theaeoagency.online','tanuj@theaeoagency.online','tanuj.s@theaeoagency.online','2027-02-14','manual','IONOS','Amazon SES','Yes','Cloudflare','Yes','Cloudflare','Netlify','git login - tanuj9825','Netlify account git login - tanuj9825','webofpicasso2@gmail.com','11111111-1111-4111-8111-111111111111','AEO Campaign','','Yes','Yes','Yes',12),
  ('dom-7','7','buildwithwop.info','tanuj@buildwithwop.info','tanuj.s@buildwithwop.info','2027-06-09','manual','IONOS','Amazon SES','Yes','Cloudflare','Yes','Cloudflare','Netlify','git login - tanuj9825','Netlify account git login - tanuj9825','webofpicasso2@gmail.com','11111111-1111-4111-8111-111111111111','AEO Campaign','','Yes','Yes','Yes',12),
  ('dom-8','8','rankwithwop.info','tanuj@rankwithwop.info','tanuj.s@rankwithwop.info','2027-06-09','manual','IONOS','Amazon SES','Yes','Cloudflare','Yes','Cloudflare','Netlify','git login - tanuj9825','Netlify account git login - tanuj9825','webofpicasso2@gmail.com','11111111-1111-4111-8111-111111111111','AEO Campaign','','Yes','Yes','Yes',12),
  ('dom-9','9','rankwithwop.online','tanuj@rankwithwop.online','tanuj.s@rankwithwop.online','2027-06-09','manual','IONOS','Amazon SES','Yes','Cloudflare','Yes','Cloudflare','Netlify','git login - tanuj9825','Netlify account git login - tanuj9825','webofpicasso2@gmail.com','11111111-1111-4111-8111-111111111111','AEO Campaign','','Yes','Partially','Yes',12),
  ('dom-10','10','risewithwop.info','tanuj@risewithwop.info','tanuj.s@risewithwop.info','2027-06-09','manual','IONOS','Amazon SES','Yes','Cloudflare','Yes','Cloudflare','Netlify','git login - tanuj9825','Netlify account git login - tanuj9825','webofpicasso2@gmail.com','22222222-2222-4222-8222-222222222222','CBD Campaign','','Yes','Yes','Yes',12),
  ('dom-11','11','scalewithwop.info','tanuj@scalewithwop.info','tanuj.s@scalewithwop.info','2027-06-09','manual','IONOS','Amazon SES','Yes','Cloudflare','Yes','Cloudflare','Netlify','git login - tanuj9825','Netlify account git login - tanuj9825','webofpicasso2@gmail.com','22222222-2222-4222-8222-222222222222','CBD Campaign','','Yes','Yes','Yes',12),
  ('dom-12','12','webofpicassoagency.info','tanuj@webofpicassoagency.info','tanuj.s@webofpicassoagency.info','2027-06-09','manual','IONOS','Amazon SES','Yes','Cloudflare','Yes','Cloudflare','Netlify','git login - tanuj9825','Netlify account git login - tanuj9825','webofpicasso2@gmail.com','22222222-2222-4222-8222-222222222222','CBD Campaign','','Yes','Yes','Yes',12),
  ('dom-13','13','webofpicassoagency.online','tanuj@webofpicassoagency.online','tanuj.s@webofpicassoagency.online','2027-06-09','manual','IONOS','Amazon SES','Yes','Cloudflare','Yes','Cloudflare','Netlify','git login - tanuj9825','Netlify account git login - tanuj9825','webofpicasso2@gmail.com','22222222-2222-4222-8222-222222222222','CBD Campaign','','Yes','Yes','Yes',12),
  ('dom-14','14','webofpicassodigital.info','tanuj@webofpicassodigital.info','tanuj.s@webofpicassodigital.info','2027-06-09','manual','IONOS','Amazon SES','Yes','Cloudflare','Yes','Cloudflare','Netlify','git login - tanuj9825','Netlify account git login - tanuj9825','webofpicasso2@gmail.com','22222222-2222-4222-8222-222222222222','CBD Campaign','','Yes','Yes','Yes',12),
  ('dom-15','15','webofpicassodigital.online','tanuj@webofpicassodigital.online','tanuj.s@webofpicassodigital.online','2027-06-09','manual','IONOS','Amazon SES','Yes','Cloudflare','Yes','Cloudflare','Netlify','git login - tanuj9825','Netlify account git login - tanuj9825','webofpicasso2@gmail.com','22222222-2222-4222-8222-222222222222','CBD Campaign','','Yes','Yes','Yes',12),
  ('dom-16','16','webofpicassoseo.info','tanuj@webofpicassoseo.info','tanuj.s@webofpicassoseo.info','2027-06-09','manual','IONOS','Amazon SES','Yes','Cloudflare','Yes','Cloudflare','Netlify','git login - tanuj9825','Netlify account git login - tanuj9825','webofpicasso2@gmail.com','22222222-2222-4222-8222-222222222222','CBD Campaign','','Yes','Yes','Yes',12),
  ('dom-17','17','winwithwop.info','tanuj@winwithwop.info','tanuj.s@winwithwop.info','2027-06-09','manual','IONOS','Amazon SES','Yes','Cloudflare','Yes','Cloudflare','Netlify','git login - tanuj9825','Netlify account git login - tanuj9825','rishi@webofpicasso.com','33333333-3333-4333-8333-333333333333','Backlink Campaign','','NA','Yes','Yes',12),
  ('dom-18','18','wopagency.info','tanuj@wopagency.info','tanuj.s@wopagency.info','2027-06-09','manual','IONOS','Amazon SES','Yes','Cloudflare','Yes','Cloudflare','Netlify','git login - tanuj9825','Netlify account git login - tanuj9825','rishi@webofpicasso.com','33333333-3333-4333-8333-333333333333','Backlink Campaign','','NA','Yes','Yes',12),
  ('dom-19','19','wopmarketing.info','tanuj@wopmarketing.info','tanuj.s@wopmarketing.info','2027-06-09','manual','IONOS','Amazon SES','Yes','Cloudflare','Yes','Cloudflare','Netlify','git login - tanuj9825','Netlify account git login - tanuj9825','rishi@webofpicasso.com','33333333-3333-4333-8333-333333333333','Backlink Campaign','','NA','Yes','Yes',12),
  ('dom-20','20','wopseo.info','tanuj@wopseo.info','tanuj.s@wopseo.info','2027-06-09','manual','IONOS','Amazon SES','Yes','Cloudflare','Yes','Cloudflare','Netlify','git login - tanuj9825','Netlify account git login - tanuj9825','rishi@webofpicasso.com','33333333-3333-4333-8333-333333333333','Backlink Campaign','','NA','Yes','Yes',12)
on conflict (id) do nothing;

-- Capacity sources -----------------------------------------------------------
insert into capacity_sources (id, name, kind, limit_amount, limit_period, used_amount, color, notes, enabled, sort) values
  ('cap-ses','Amazon SES','sending',50000,'day',0,'#FF9900','Production access. 50,000 emails / 24h.',true,1),
  ('cap-instantly','Instantly (Hyper Growth)','sending',125000,'month',0,'#3F6BFF','Hyper Growth plan, $97/mo. Renews Jul 8, 2026.',true,2),
  ('cap-instantly-contacts','Instantly Contacts','contacts',25000,'month',948,'#B23386','Total uploaded contacts cap on Hyper Growth.',true,3)
on conflict (id) do nothing;

-- Cost items -----------------------------------------------------------------
insert into cost_items (id, name, category, provider, amount, currency, billing_cycle, quantity, renews_on, notes, active) values
  ('cost-domains','Domains (IONOS) × 20','Domains','IONOS',12,'USD','annual',20,'2027-06-09','Per-domain annual renewal (avg). Adjust per TLD.',true),
  ('cost-instantly','Instantly — Hyper Growth','Tools','Instantly',97,'USD','monthly',1,'2026-07-08','25,000 contacts / 125,000 emails per month.',true),
  ('cost-ses','Amazon SES sending','Sending','Amazon SES',0.1,'USD','per-1000-emails',1,null,'$0.10 per 1,000 emails sent.',true),
  ('cost-netlify','Netlify (site hosting)','Hosting','Netlify',0,'USD','monthly',1,null,'Free tier for campaign sites (account: tanuj9825).',true),
  ('cost-cloudflare','Cloudflare (DNS + Email Routing)','Email Infrastructure','Cloudflare',0,'USD','monthly',1,null,'Free DNS + email forwarding.',true),
  ('cost-openai','OpenAI (lead enrichment)','AI','OpenAI',0,'USD','monthly',1,null,'Usage-based. Set an estimated monthly spend.',true)
on conflict (id) do nothing;

-- Lead lists -----------------------------------------------------------------
insert into lead_lists (id, name, parent_id, description, color, source) values
  ('list-master','Master — Scraped Leads',null,'All raw scraped leads land here before filtering.','#FF90E8','Apollo / scrape'),
  ('list-aeo','AEO — Qualified','list-master','Sub-list filtered for the AEO campaign.','#23A094','Filtered from master')
on conflict (id) do nothing;

-- Sample leads ---------------------------------------------------------------
insert into leads (id, list_id, email, first_name, last_name, company, title, website, location, industry, employees, status, score, tags, enrichment) values
  ('lead-1','list-master','jane@acmeco.com','Jane','Doe','Acme Co','Head of Marketing','acmeco.com','Austin, TX','SaaS','51-200','new',72,'["inbound-fit"]'::jsonb,'{}'::jsonb),
  ('lead-2','list-master','mark@brightlabs.io','Mark','Lee','Bright Labs','Founder','brightlabs.io','Remote','Agency','1-10','used',65,'["agency"]'::jsonb,'{"summary":"Boutique SEO agency, good ICP match."}'::jsonb)
on conflict (id) do nothing;
update leads set used_in_campaign_id = '11111111-1111-4111-8111-111111111111', used_at = now()
  where id = 'lead-2' and used_in_campaign_id is null;

-- Setup playbook -------------------------------------------------------------
insert into setups (id, name, date, summary, status) values
  ('setup-2026','Current Cold Email Setup — 2026','2026-02-10',
   '20 domains on IONOS, DNS + email forwarding on Cloudflare, Amazon SES as the mailing server, campaign sites on Netlify (account tanuj9825), Gmail send-as for replies, mailboxes connected to Instantly (Hyper Growth) with warmup enabled.',
   'active')
on conflict (id) do nothing;

insert into setup_steps (id, setup_id, position, title, category, platform, account_used, details, links, done) values
  ('step-1','setup-2026',1,'Bought the domains','Domains','IONOS','IONOS account','Registered 20 domains across .info / .online / .cloud / .website TLDs.','[{"label":"IONOS dashboard","url":"https://www.ionos.com/"}]'::jsonb,true),
  ('step-2','setup-2026',2,'Pointed DNS to Cloudflare','DNS','Cloudflare','Cloudflare account','Added each domain to Cloudflare and switched IONOS nameservers. Manage MX/SPF/DKIM/DMARC here.','[{"label":"Cloudflare","url":"https://dash.cloudflare.com/"}]'::jsonb,true),
  ('step-3','setup-2026',3,'Set up Amazon SES (mailing server)','Email Server','Amazon SES','AWS account','Verified domains in SES, published DKIM/SPF/DMARC, requested production access. 50,000 emails / 24h.','[{"label":"SES console","url":"https://console.aws.amazon.com/ses/"}]'::jsonb,true),
  ('step-4','setup-2026',4,'Set up email forwarding','Forwarding','Cloudflare Email Routing','Cloudflare account','AEO + CBD domains forward to webofpicasso2@gmail.com; Backlink domains to rishi@webofpicasso.com.','[{"label":"Email Routing","url":"https://dash.cloudflare.com/"}]'::jsonb,true),
  ('step-5','setup-2026',5,'Built the campaign sites','Sites','Netlify','Netlify (git login: tanuj9825)','Each domain has a simple site on Netlify so it resolves to a real website (helps deliverability).','[{"label":"Netlify","url":"https://app.netlify.com/"}]'::jsonb,true),
  ('step-6','setup-2026',6,'Configured Gmail Send As','Gmail','Gmail','webofpicasso2@gmail.com','Added each mailbox as a Send-mail-as identity using SES SMTP credentials so replies happen in Gmail.','[{"label":"Gmail settings","url":"https://mail.google.com/mail/u/0/#settings/accounts"}]'::jsonb,true),
  ('step-7','setup-2026',7,'Connected mailboxes to Instantly','Sending Tool','Instantly','Instantly (Hyper Growth)','Connected all sending mailboxes via SMTP/IMAP. Plan caps: 25,000 contacts / 125,000 emails per month.','[{"label":"Instantly","url":"https://app.instantly.ai/"}]'::jsonb,true),
  ('step-8','setup-2026',8,'Started warmup','Warmup','Instantly','Instantly (Hyper Growth)','Enabled warmup on every mailbox before scaling. Ramp gradually to the per-inbox target.','[{"label":"Warmup","url":"https://app.instantly.ai/"}]'::jsonb,true)
on conflict (id) do nothing;

-- App settings ---------------------------------------------------------------
insert into app_settings (id, value) values
  ('app', '{"org_name":"Web of Picasso","currency":"USD","reminder_window_days":30,"per_mailbox_daily_limit":30,"emails_per_domain":2,"sending_days_per_week":5,"warmup_ramp_per_day":5,"warmup_target":40,"default_sends_per_lead":3,"ai_enabled":true,"accent":"#FF90E8"}'::jsonb)
on conflict (id) do nothing;
