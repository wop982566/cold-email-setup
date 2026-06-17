// ---------------------------------------------------------------------------
// CSV → Lead mapping. Handles Apollo / ZenProspect / Instantly-style headers,
// builds a location from city/state/country, and preserves EVERY other column
// in `custom` so nothing is lost on import.
// ---------------------------------------------------------------------------
import { Lead } from "./types";

export function normHeader(h: string): string {
  return h.trim().toLowerCase().replace(/^"|"$/g, "").replace(/\s+/g, " ");
}

// Known header (normalised) -> standard Lead field.
const STANDARD: Record<string, keyof Lead> = {
  email: "email",
  "email address": "email",
  "work email": "email",
  "first name": "first_name",
  firstname: "first_name",
  "last name": "last_name",
  lastname: "last_name",
  "company name": "company",
  company: "company",
  organization: "company",
  "organization name": "company",
  account: "company",
  "company website": "website",
  website: "website",
  "company domain": "website",
  domain: "website",
  url: "website",
  linkedin: "linkedin",
  "linkedin url": "linkedin",
  "person linkedin": "linkedin",
  "linkedin profile": "linkedin",
  title: "title",
  "job title": "title",
  position: "title",
  industry: "industry",
  "employees count": "employees",
  employees: "employees",
  "employee count": "employees",
  "# employees": "employees",
  "num employees": "employees",
  "mobile number": "phone",
  phone: "phone",
  "phone number": "phone",
  mobile: "phone",
  "work phone": "phone",
};

// Headers we fold into a single "location" string when there's no explicit one.
const CITY = ["city"];
const STATE = ["state", "region"];
const COUNTRY = ["country"];

function emptyLead(listId: string | null): Omit<Lead, "id"> {
  return {
    list_id: listId,
    email: "",
    first_name: "",
    last_name: "",
    company: "",
    title: "",
    website: "",
    linkedin: "",
    phone: "",
    location: "",
    industry: "",
    employees: "",
    status: "new",
    used_in_campaign_id: null,
    used_at: null,
    enriched: false,
    category: "",
    relevance: "",
    discarded: false,
    discarded_at: null,
    score: 50,
    tags: [],
    enrichment: {},
    custom: {},
  };
}

export interface MappingReport {
  total: number;
  mappedFields: string[];
  extraColumns: string[];
  hasEmailColumn: boolean;
}

export function analyzeHeaders(headers: string[]): MappingReport {
  const mapped = new Set<string>();
  const extra: string[] = [];
  let cityish = false;
  for (const h of headers) {
    const n = normHeader(h);
    if (STANDARD[n]) mapped.add(STANDARD[n] as string);
    else if (CITY.includes(n) || STATE.includes(n) || COUNTRY.includes(n)) cityish = true;
    else if (n === "location") mapped.add("location");
    else extra.push(h);
  }
  if (cityish) mapped.add("location");
  return {
    total: headers.length,
    mappedFields: Array.from(mapped),
    extraColumns: extra,
    hasEmailColumn: mapped.has("email"),
  };
}

// Build a full Lead (minus id) from one CSV row, preserving all extra columns.
export function buildLeadFromRow(row: Record<string, string>, listId: string | null): Omit<Lead, "id"> {
  const lead = emptyLead(listId);
  let city = "";
  let state = "";
  let country = "";
  let fullName = "";

  for (const rawKey of Object.keys(row)) {
    const n = normHeader(rawKey);
    const value = (row[rawKey] ?? "").trim();
    if (value === "") continue;

    const field = STANDARD[n];
    if (field) {
      const k = field as string;
      const obj = lead as Record<string, unknown>;
      // Don't overwrite an already-set standard field with a weaker source.
      if (!obj[k]) obj[k] = value;
      continue;
    }
    if (n === "location") {
      lead.location = value;
      continue;
    }
    if (CITY.includes(n)) city = value;
    else if (STATE.includes(n)) state = value;
    else if (COUNTRY.includes(n)) country = value;
    if (n === "full name" || n === "fullname") fullName = value;

    // Preserve everything (including city/state/country) under the original header.
    lead.custom[rawKey] = value;
  }

  if (!lead.location) {
    lead.location = [city, state, country].filter(Boolean).join(", ");
  }
  // Fill names from "Full Name" if first/last missing.
  if (!lead.first_name && fullName) {
    const parts = fullName.split(/\s+/);
    lead.first_name = parts[0] ?? "";
    if (!lead.last_name && parts.length > 1) lead.last_name = parts.slice(1).join(" ");
  }
  return lead;
}

// ---- Export (Instantly-ready) --------------------------------------------
const EXPORT_CUSTOM = [
  "Headline",
  "Seniority",
  "Department",
  "City",
  "State",
  "Country",
  "Company Short Description",
  "Keywords",
];

export function leadToExportRow(lead: Lead): Record<string, string> {
  const base: Record<string, string> = {
    first_name: lead.first_name,
    last_name: lead.last_name,
    email: lead.email,
    company: lead.company,
    title: lead.title,
    website: lead.website,
    linkedin: lead.linkedin,
    phone: lead.phone,
    industry: lead.industry,
    location: lead.location,
    employees: lead.employees,
    category: lead.category,
    score: String(lead.score),
    tags: lead.tags.join("|"),
  };
  for (const key of EXPORT_CUSTOM) {
    const v = lead.custom?.[key];
    if (v != null && String(v).trim() !== "") base[key.toLowerCase().replace(/\s+/g, "_")] = String(v);
  }
  return base;
}
