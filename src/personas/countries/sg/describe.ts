import type { Persona } from "../../../db/schema";
import { cardLines } from "../../../modules/engine";
import { resolveModules, type ResolvedModules } from "../../../modules/registry";
import { sgSocleVars } from "./vars";
import { formatMoneyEn } from "../../../studies/price-model-en";
import type { SgPack } from "./pack";

/**
 * Fiche d'une persona du socle Singapour, en anglais (langue du socle) : celle que lisent le récit et
 * les études. Mêmes rubriques que la fiche française, plus le statut de résidence, l'ethnie, la religion,
 * la langue et le logement, qui conditionnent le budget et les usages à Singapour.
 */

const money = (n: number) => `S$${Math.round(n).toLocaleString("en-SG")}`;
const level = (x: number) => (x < 0.25 ? "low" : x < 0.45 ? "rather low" : x < 0.6 ? "medium" : x < 0.8 ? "high" : "very high");


/** « 1 person, 1 adult-equivalent » / « 3 people, 2.1 adult-equivalents » (fiche lisible SG et US). */
export function householdCountsEn(size: number | null | undefined, units: number | null | undefined): string {
  const people = size == null ? "? people" : `${size} ${size === 1 ? "person" : "people"}`;
  const eq = units == null ? "? adult-equivalents" : `${units} ${units === 1 ? "adult-equivalent" : "adult-equivalents"}`;
  return `${people}, ${eq}`;
}

export const ROGERS_LABELS_EN: Record<string, string> = {
  innovator: "innovator (tries everything new)",
  early_adopter: "early adopter (adopts early what is useful to them)",
  early_majority: "early majority (adopts once it is proven)",
  late_majority: "late majority (adopts out of necessity, late)",
  laggard: "laggard (avoids digital tools when possible)",
};

export const SOCIAL_LABELS_EN: Record<string, string> = {
  none: "does not use social media",
  occasional: "social media now and then",
  daily: "social media every day",
  heavy: "social media several hours a day",
};

export const STATUS_LABELS_EN: Record<string, string> = {
  employed: "employed",
  unemployed: "unemployed",
  student: "student",
  retired: "retired",
  inactive: "not working",
};

export const HOUSEHOLD_LABELS_EN: Record<string, string> = {
  alone: "lives alone",
  couple_no_child: "lives with a partner, no child at home",
  couple_with_children: "lives with a partner and child(ren)",
  single_parent: "single parent, with child(ren) at home",
  with_parents: "lives with their parents",
  other: "lives with unrelated people",
};

export const TENURE_LABELS_EN: Record<string, string> = {
  owner: "owner, no housing loan",
  owner_mortgage: "owner, repaying a housing loan",
  renter_private: "renting",
  renter_social: "renting from HDB (public rental)",
  free: "does not pay rent",
};

const RESIDENCY_LINE: Record<string, string> = {
  citizen: "Singapore citizen",
  pr: "Singapore permanent resident",
  ep: "Employment Pass holder",
  spass: "S Pass holder",
  wp: "Work Permit holder",
  mdw: "migrant domestic worker (Work Permit)",
  dependant: "Dependant's Pass holder (spouse of a work pass holder)",
  student: "Student's Pass holder",
};

interface X {
  residency?: string;
  pass?: string;
  nationality?: string | null;
  ethnicity?: string;
  religion?: string;
  homeLanguage?: string;
  education?: string;
  dwelling?: string;
  tenure?: string;
  partner?: { age: number; sex: string; status: string; pcs: string | null; incomeEur: number } | null;
  parents?: Array<{ age: number; status: string }>;
  childrenAges?: number[];
  consumptionUnits?: number;
  housingCostEur?: number;
  housingTotalEur?: number;
  incomeTaxEur?: number;
  benefitsEur?: number;
  preCommittedEur?: number;
  currentExpensesEur?: number;
  subscriptionsEur?: number;
  livingStandardEur?: number;
  monthlyShortfallEur?: number;
  grossIncomeEur?: number;
  cpfEmployeeEur?: number;
  remittanceEur?: number;
  narrativeTone?: string;
  nationalService?: boolean;
  liveIn?: boolean;
  modules?: Record<string, Record<string, unknown>>;
}
const xOf = (p: Persona) => (p.extra ?? {}) as X;

function nationalityLabel(pack: SgPack, code: string | null | undefined, ethnicity?: string): string | null {
  if (!code) return null;
  const n = pack.ethnicity.data.nationalities.find((x) => x.code === code);
  return (ethnicity && n?.labelByEthnicity?.[ethnicity]) ?? n?.label ?? code;
}

function residencyLine(pack: SgPack, p: Persona): string {
  const x = xOf(p);
  const base = RESIDENCY_LINE[x.residency ?? ""] ?? x.residency ?? "?";
  const sector = x.pass === "wp_cmp" ? ", construction, marine or process sector" : x.pass === "wp_other" ? ", manufacturing or services" : "";
  const nat = nationalityLabel(pack, x.nationality, x.ethnicity);
  return `${base}${sector}${nat ? ` (nationality: ${nat})` : ""}`;
}

function backgroundLine(pack: SgPack, p: Persona): string {
  const x = xOf(p);
  const e = pack.ethnicity.data.labels[(x.ethnicity ?? "others") as keyof typeof pack.ethnicity.data.labels] ?? x.ethnicity;
  const r = pack.religion.data.labels[(x.religion ?? "none") as keyof typeof pack.religion.data.labels] ?? x.religion;
  const l = pack.language.data.labels[(x.homeLanguage ?? "english") as keyof typeof pack.language.data.labels] ?? x.homeLanguage;
  const ed = pack.education.data.labels[(x.education ?? "secondary") as keyof typeof pack.education.data.labels] ?? x.education;
  // Étrangers : l'ethnie est celle de la classification de Singapour (ex. un Bangladais est classé « Indian »)
  const eth = x.nationality ? `ethnic group in Singapore's classification: ${e}` : e;
  return `${eth}; religion: ${r}; language most spoken at home: ${l}; highest qualification: ${ed.toLowerCase()}`;
}

function placeLine(pack: SgPack, p: Persona): string {
  return `${pack.areaName(p.townSize)} (${pack.regionName(p.region)})`;
}

function housingLine(pack: SgPack, p: Persona): string {
  const x = xOf(p);
  const d = pack.geography.data.dwellingLabels[(x.dwelling ?? "other") as keyof typeof pack.geography.data.dwellingLabels] ?? x.dwelling;
  if (x.dwelling === "dormitory") return `${d}, provided by the employer`;
  if (x.liveIn) return `lives in the employer's home (${d}), with board and lodging provided`;
  if (p.householdType === "with_parents") return `${d}, the parents' home`;
  const t = TENURE_LABELS_EN[x.tenure ?? ""] ?? x.tenure ?? "?";
  const cpf = x.tenure === "owner_mortgage" && x.housingTotalEur ? ` (mostly paid from CPF savings; cash part about ${money(x.housingCostEur ?? 0)}/month)` : "";
  return `${d}, ${t}${cpf}`;
}

function householdLine(pack: SgPack, p: Persona): string {
  const x = xOf(p);
  const parts = [HOUSEHOLD_LABELS_EN[p.householdType] ?? p.householdType];
  if (x.liveIn) parts[0] = "lives in the employer's household";
  if (x.dwelling === "dormitory") parts[0] = "lives in a workers' dormitory";
  if (x.partner) {
    const who = x.partner.sex === "F" ? "wife or female partner" : "husband or male partner";
    const st = x.partner.status === "employed" && x.partner.pcs ? (pack.occupation.data.labels[x.partner.pcs as keyof typeof pack.occupation.data.labels] ?? "employed").toLowerCase() : STATUS_LABELS_EN[x.partner.status] ?? x.partner.status;
    parts.push(`${who}, ${x.partner.age}, ${st}`);
  }
  if (x.childrenAges?.length) {
    const n = x.childrenAges.length;
    parts.push(`${n} child${n > 1 ? "ren" : ""} (${x.childrenAges.map((a) => (a === 0 ? "under 1" : `${a}`)).join(", ")})`);
  }
  if (x.parents?.length) parts.push(x.parents.length === 2 ? "with both parents" : "with one parent");
  return parts.join("; ");
}

function subscriptionsLine(p: Persona): string {
  if (!p.subscriptions.length) return "none";
  return p.subscriptions.map((s) => `${s.name} ${formatMoneyEn(s.monthlyEur, "SGD")}${s.household ? " (for the household)" : ""}`).join(", ");
}

function skepticismHint(skepticism: number): string {
  if (skepticism >= 0.6) return `; marked distrust of novelties, advertising and sales calls (${level(skepticism)})`;
  if (skepticism < 0.3) return "; rather trusting, open to new things";
  return "";
}

export function sgToneLabel(pack: SgPack, id: string | undefined): string {
  if (!id) return "neutral";
  return pack.psychographics.data.tones.find((t) => t.id === id)?.label ?? id;
}

const resolvedCache = new Map<string, ResolvedModules>();
function personaModules(pack: SgPack, p: Persona): ResolvedModules {
  if (pack.modules.ordered.length) return pack.modules;
  const ids = Object.keys(xOf(p).modules ?? {});
  if (!ids.length) return pack.modules;
  const key = `${pack.socle}:${ids.join(",")}`;
  let r = resolvedCache.get(key);
  if (!r) resolvedCache.set(key, (r = resolveModules(ids, pack.socle)));
  return r;
}

export function sgModuleLines(pack: SgPack, p: Persona, only?: string[]): string[] {
  return cardLines(personaModules(pack, p), xOf(p).modules as never, p.sex, sgSocleVars(pack, p))
    .filter((x) => !only || only.includes(x.module.def.id))
    .map((x) => x.line);
}

function incomeLine(p: Persona): string {
  const x = xOf(p);
  const gross = x.grossIncomeEur ?? p.monthlyIncomeEur;
  const cpf = x.cpfEmployeeEur ?? 0;
  const personal =
    p.monthlyIncomeEur <= 0
      ? "no personal income"
      : `${money(p.monthlyIncomeEur)} net/month${cpf ? ` after CPF contribution (gross ${money(gross)})` : ""}`;
  const remit = x.remittanceEur ? `; sends about ${money(x.remittanceEur)}/month to family back home` : "";
  return `Personal income: ${personal}${remit}; household income after tax and government transfers: ${money(p.householdIncomeEur ?? 0)}/month`;
}

const wrap = (lines: string[], f?: (lines: string[]) => string[]) => (f ? f(lines) : lines);

/** Fiche compacte envoyée au LLM (récit, étude) ; `modules` et `wrapModules` comme pour la fiche française. */
export function sgDescribeForPrompt(pack: SgPack, p: Persona, opts: { modules?: boolean | string[]; wrapModules?: (lines: string[]) => string[] } = {}): string {
  const x = xOf(p);
  const lines = [
    `Name: ${p.firstName ?? "(your choice, consistent with age and background)"}; ${p.sex === "F" ? "woman" : "man"}; ${p.age} years old`,
    `Residency: ${residencyLine(pack, p)}`,
    `Background: ${backgroundLine(pack, p)}`,
    `Lives in: ${placeLine(pack, p)}`,
    `Situation: ${p.occupation}`,
    ...(opts.modules === false ? [] : wrap(sgModuleLines(pack, p, Array.isArray(opts.modules) ? opts.modules : undefined), opts.wrapModules)),
    `Household: ${householdLine(pack, p)}; housing: ${housingLine(pack, p)}`,
    incomeLine(p),
    `Discretionary budget after committed and day-to-day expenses and subscriptions: ${money(p.monthlyDiscretionaryBudgetEur)}/month` +
      (x.monthlyShortfallEur ? ` (in the red at the end of the month, about ${money(x.monthlyShortfallEur)} short)` : ""),
    `Equipment: ${p.equipment.join(", ")}; ${SOCIAL_LABELS_EN[p.socialMediaUsage] ?? p.socialMediaUsage}`,
    `Current subscriptions: ${subscriptionsLine(p)}`,
    `Relationship with technology: ${ROGERS_LABELS_EN[p.techAdoption] ?? p.techAdoption}`,
    `Price sensitivity: ${level(p.priceSensitivity)}` + skepticismHint(p.skepticism),
    `Narrative tone: ${sgToneLabel(pack, x.narrativeTone)}`,
  ];
  return lines.join("\n");
}

/** Affichage lisible (personas:show). */
export function formatSgPersona(pack: SgPack, p: Persona): string {
  const x = xOf(p);
  const head = `${p.firstName ?? "?"}, ${p.age} — ${p.occupation}`;
  const lines = [
    `${head}\n${"─".repeat(Math.min(80, head.length))}`,
    `id             ${p.id}  (pack ${p.packVersion}, seed ${p.seed})`,
    `Residency      ${residencyLine(pack, p)}`,
    `Background     ${backgroundLine(pack, p)}`,
    `Lives in       ${placeLine(pack, p)}`,
    ...sgModuleLines(pack, p).map((l) => `Module         ${l}`),
    `Household      ${householdLine(pack, p)} (${householdCountsEn(p.householdSize, x.consumptionUnits)})`,
    `Housing        ${housingLine(pack, p)}`,
    `Income         ${incomeLine(p).replace(/^Personal income: /, "")}`,
    `Tax/transfers  income tax ${money(x.incomeTaxEur ?? 0)}/month; transfers ${money(x.benefitsEur ?? 0)}/month`,
    `Living std     ${money(x.livingStandardEur ?? 0)}/month per adult-equivalent`,
    `Expenses       committed ${money(x.preCommittedEur ?? 0)}; day-to-day ${money(x.currentExpensesEur ?? 0)}; subscriptions (excl. telecom) ${money(x.subscriptionsEur ?? 0)}`,
    `Budget         ${money(p.monthlyDiscretionaryBudgetEur)}/month` + (x.monthlyShortfallEur ? ` (shortfall ${money(x.monthlyShortfallEur)})` : ""),
    `Equipment      ${p.equipment.join(", ")}`,
    `Subscriptions  ${subscriptionsLine(p)}`,
    `Technology     ${ROGERS_LABELS_EN[p.techAdoption] ?? p.techAdoption}; ${SOCIAL_LABELS_EN[p.socialMediaUsage] ?? p.socialMediaUsage}`,
    `Psychology     price sensitivity ${p.priceSensitivity.toFixed(2)} (${level(p.priceSensitivity)}), skepticism ${p.skepticism.toFixed(2)} (${level(p.skepticism)})`,
    "",
    p.narrative ? p.narrative : "(no narrative yet: npm run personas:narrate)",
  ];
  if (p.narrative) lines.push(`\n  — narrative: ${p.narrativeBackend}/${p.narrativeModel}, tone ${sgToneLabel(pack, x.narrativeTone)}`);
  return lines.join("\n");
}

const AGE_LABELS: Record<string, string> = { "18-29": "18-29", "30-44": "30-44", "45-59": "45-59", "60-79": "60 and over" };
const ACTIVITY_LABELS_EN: Record<string, string> = { employed: "Employed", unemployed: "Unemployed", student: "Studying", retired: "Retired", inactive: "Other inactive (incl. NSF)" };

/** Libellé d'un segment du socle, en anglais. */
export function sgSegmentLabel(pack: SgPack, dim: string, code: string): string {
  switch (dim) {
    case "ageBand":
      return AGE_LABELS[code] ?? code;
    case "sex":
      return code === "F" ? "Women" : "Men";
    case "pcs":
      return code === "none" ? "Never employed / no occupation" : (pack.occupation.data.labels[code as keyof typeof pack.occupation.data.labels] ?? code);
    case "livingStandard": {
      const d = pack.livingStandard.data.deciles;
      const m = (v: number) => money(v / 12);
      return code === "Q1" ? `Q1 (< ${m(d[1]!)}/month/AE)` : code === "Q2" ? `Q2 (${m(d[1]!)}–${m(d[3]!)})` : code === "Q3" ? `Q3 (${m(d[3]!)}–${m(d[5]!)})` : code === "Q4" ? `Q4 (${m(d[5]!)}–${m(d[7]!)})` : `Q5 (≥ ${m(d[7]!)})`;
    }
    case "techAdoption":
      return (ROGERS_LABELS_EN[code] ?? code).replace(/ \(.*\)$/, "");
    case "townSize":
      return pack.areaName(code);
    case "activityStatus":
      return ACTIVITY_LABELS_EN[code] ?? code;
    case "region":
      return pack.regionName(code);
    default:
      return code === "?" ? "Not given" : code.replace(/_/g, " ");
  }
}
