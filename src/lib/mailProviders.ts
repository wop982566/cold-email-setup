// ---------------------------------------------------------------------------
// Provider presets for the Inbox Tester.
//
// Adding a seed inbox (or a manual sending inbox) means typing IMAP/SMTP host,
// port and — the part people get stuck on — an *app password*, which every
// provider hides in a different place behind two-factor auth. So each provider
// carries its own host/port defaults plus the exact click-path to the app
// password. Pure data + helpers: the form reads these, nothing here does I/O.
// ---------------------------------------------------------------------------
import type { MailProvider } from "./types";

export interface ProviderPreset {
  code: MailProvider;
  label: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean; // true = implicit TLS (465); false = STARTTLS (587)
  /** Where to generate an app password. Empty for "other". */
  appPasswordUrl: string;
  /** Step-by-step, in the order the user performs them. */
  steps: string[];
  /** Set when the provider is deprecating basic auth / app passwords. */
  caveat?: string;
}

export const PROVIDER_PRESETS: Record<MailProvider, ProviderPreset> = {
  gmail: {
    code: "gmail",
    label: "Gmail (personal)",
    imapHost: "imap.gmail.com",
    imapPort: 993,
    imapSecure: true,
    smtpHost: "smtp.gmail.com",
    smtpPort: 465,
    smtpSecure: true,
    appPasswordUrl: "https://myaccount.google.com/apppasswords",
    steps: [
      "Turn on 2-Step Verification: myaccount.google.com → Security → 2-Step Verification.",
      "Create an App Password at myaccount.google.com/apppasswords (pick 'Mail'). Copy the 16-character code.",
      "Enable IMAP: Gmail → Settings (gear) → See all settings → Forwarding and POP/IMAP → Enable IMAP → Save.",
      "Use your full address as the username and the App Password (not your normal password).",
    ],
    caveat: "App Passwords need 2-Step Verification on; a plain account password will be rejected.",
  },
  gworkspace: {
    code: "gworkspace",
    label: "Google Workspace",
    imapHost: "imap.gmail.com",
    imapPort: 993,
    imapSecure: true,
    smtpHost: "smtp.gmail.com",
    smtpPort: 465,
    smtpSecure: true,
    appPasswordUrl: "https://myaccount.google.com/apppasswords",
    steps: [
      "Your Workspace admin must allow IMAP and App Passwords (Admin console → Apps → Google Workspace → Gmail → End User Access).",
      "On the account: turn on 2-Step Verification, then create an App Password at myaccount.google.com/apppasswords.",
      "Enable IMAP in Gmail → Settings → Forwarding and POP/IMAP.",
      "Username = full address, password = the App Password.",
    ],
    caveat: "If the admin enforces OAuth-only, App Passwords won't appear — IMAP basic auth may be blocked.",
  },
  outlook: {
    code: "outlook",
    label: "Outlook.com / Hotmail",
    imapHost: "outlook.office365.com",
    imapPort: 993,
    imapSecure: true,
    smtpHost: "smtp-mail.outlook.com",
    smtpPort: 587,
    smtpSecure: false,
    appPasswordUrl: "https://account.microsoft.com/security",
    steps: [
      "Turn on Two-step verification: account.microsoft.com → Security → Advanced security options.",
      "Under 'App passwords', create a new app password and copy it.",
      "Username = full address, password = the app password.",
    ],
    caveat: "Some consumer tenants have disabled basic-auth IMAP; if login fails you'll need OAuth.",
  },
  o365: {
    code: "o365",
    label: "Office 365 / business",
    imapHost: "outlook.office365.com",
    imapPort: 993,
    imapSecure: true,
    smtpHost: "smtp.office365.com",
    smtpPort: 587,
    smtpSecure: false,
    appPasswordUrl: "https://account.activedirectory.windowsazure.com/",
    steps: [
      "Your admin must enable IMAP and SMTP AUTH for the mailbox (Exchange admin → recipients → mailbox → email apps).",
      "Turn on MFA for the account, then create an app password (Microsoft 365 → My Account → Security info).",
      "Username = full address, password = the app password.",
    ],
    caveat: "Microsoft is retiring basic auth for many tenants; OAuth may be required.",
  },
  yahoo: {
    code: "yahoo",
    label: "Yahoo Mail",
    imapHost: "imap.mail.yahoo.com",
    imapPort: 993,
    imapSecure: true,
    smtpHost: "smtp.mail.yahoo.com",
    smtpPort: 465,
    smtpSecure: true,
    appPasswordUrl: "https://login.yahoo.com/account/security",
    steps: [
      "Go to login.yahoo.com/account/security → turn on Two-step verification.",
      "Click 'Generate app password' (or 'Manage app passwords'), name it, and copy the code.",
      "Username = full address, password = the app password.",
    ],
  },
  icloud: {
    code: "icloud",
    label: "iCloud Mail",
    imapHost: "imap.mail.me.com",
    imapPort: 993,
    imapSecure: true,
    smtpHost: "smtp.mail.me.com",
    smtpPort: 587,
    smtpSecure: false,
    appPasswordUrl: "https://appleid.apple.com/account/manage",
    steps: [
      "Turn on two-factor authentication for your Apple ID.",
      "At appleid.apple.com → Sign-In and Security → App-Specific Passwords → generate one and copy it.",
      "Username = your iCloud address, password = the app-specific password.",
    ],
  },
  other: {
    code: "other",
    label: "Other (enter manually)",
    imapHost: "",
    imapPort: 993,
    imapSecure: true,
    smtpHost: "",
    smtpPort: 587,
    smtpSecure: false,
    appPasswordUrl: "",
    steps: [
      "Enter your provider's IMAP host/port and SMTP host/port.",
      "Most providers require an app-specific password rather than your login password.",
    ],
  },
};

export const PROVIDER_ORDER: MailProvider[] = [
  "gmail",
  "gworkspace",
  "outlook",
  "o365",
  "yahoo",
  "icloud",
  "other",
];

export function presetFor(provider: MailProvider): ProviderPreset {
  return PROVIDER_PRESETS[provider] ?? PROVIDER_PRESETS.other;
}

/**
 * Best-effort guess of the provider from an email's domain / MX-style host,
 * so the Add-seed form can pre-select a sensible default. Never authoritative
 * (custom domains hide behind Google/Microsoft) — the user can override.
 */
export function guessProvider(email: string): MailProvider {
  const at = email.lastIndexOf("@");
  const domain = (at >= 0 ? email.slice(at + 1) : email).trim().toLowerCase();
  if (!domain) return "other";
  if (domain === "gmail.com" || domain === "googlemail.com") return "gmail";
  if (domain === "yahoo.com" || domain.startsWith("yahoo.")) return "yahoo";
  if (domain === "icloud.com" || domain === "me.com" || domain === "mac.com") return "icloud";
  if (
    domain === "outlook.com" ||
    domain === "hotmail.com" ||
    domain === "live.com" ||
    domain === "msn.com"
  ) {
    return "outlook";
  }
  return "other";
}
