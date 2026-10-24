import type { Persona } from "../../../db/schema";
import { cardLines } from "../../../modules/engine";
import { resolveModules, type ResolvedModules } from "../../../modules/registry";
import { usSocleVars } from "./vars";
import { HOUSEHOLD_LABELS_EN, householdCountsEn, ROGERS_LABELS_EN, SOCIAL_LABELS_EN, STATUS_LABELS_EN } from "../sg/describe";
import type { UsPack } from "./pack";

/**
 * Fiche d'une persona du socle États-Unis, en anglais (langue du socle) : celle que lisent le récit et les
 * études. Mêmes rubriques que les fiches France et Singapour, plus l'État, l'origine, la nativité, la langue,
 * le diplôme, l'assurance santé et les dépenses contraintes propres aux États-Unis (prêt étudiant, voiture).
 */

const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const moneyCents = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: Math.round(n * 100) % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
const level = (x: number) => (x < 0.25 ? "low" : x < 0.45 ? "rather low" : x < 0.6 ? "medium" : x < 0.8 ? "high" : "very high");

export const US_TENURE_LABELS_EN: Record<string, string> = {
  owner: "owns the home outright",
  owner_mortgage: "owns the home, paying off a mortgage",
  renter_private: "renting",
  renter_social: "renting with public housing assistance (public housing or a voucher)",
  free: "does not pay rent",
};

const DWELLING_EN: Record<string, string> = {
  single_family: "single-family house",
  townhouse: "townhouse",
  small_multifamily: "small multi-unit building (2-4 homes)",
  apartment: "apartment building",
  mobile_home: "mobile home",
};

interface X {
  state?: string;
  urbanicity?: string;
  race?: string;
  asianOrigin?: string;
  nativity?: string;
  homeLanguage?: string;
  education?: string;
  dwelling?: string;
  tenure?: string;
  married?: boolean;
  classOfWorker?: string;
  healthInsurance?: string;
  healthCostEur?: number;
  partner?: { age: number; sex: string; status: string; pcs: string | null; incomeEur: number } | null;
  parents?: Array<{ age: number; status: string }>;
  adultChildren?: Array<{ age: number; sex: string; status: string }>;
  childrenAges?: number[];
  consumptionUnits?: number;
  housingCostEur?: number;
  incomeTaxEur?: number;
  benefitsEur?: number;
  snapEur?: number;
  preCommittedEur?: number;
  currentExpensesEur?: number;
  subscriptionsEur?: number;
  livingStandardEur?: number;
  monthlyShortfallEur?: number;
  grossIncomeEur?: number;
  payrollTaxEur?: number;
  studentLoan?: boolean;
  studentLoanEur?: number;
  vehicles?: number;
  carEur?: number;
  carLoan?: boolean;
  childcareEur?: number;
  narrativeTone?: string;
  modules?: Record<string, Record<string, unknown>>;
}
const xOf = (p: Persona) => (p.extra ?? {}) as X;

function backgroundLine(pack: UsPack, p: Persona): string {
  const x = xOf(p);
  const ORIGIN: Record<string, string> = { south_asian: "South Asian", chinese: "Chinese", filipino: "Filipino", vietnamese: "Vietnamese", korean: "Korean", japanese: "Japanese" };
  const r0 = pack.race.data.labels[(x.race ?? "white") as keyof typeof pack.race.data.labels] ?? x.race;
  const race = x.asianOrigin && ORIGIN[x.asianOrigin] ? `${r0}, of ${ORIGIN[x.asianOrigin]} origin` : r0;
  const nat = pack.nativity.data.labels[(x.nativity ?? "us_born") as keyof typeof pack.nativity.data.labels] ?? x.nativity;
  const lang = x.homeLanguage === "english" ? "speaks only English at home" : `speaks ${pack.language.data.labels[(x.homeLanguage ?? "other") as keyof typeof pack.language.data.labels] ?? x.homeLanguage} at home`;
  const ed = pack.education.data.labels[(x.education ?? "high_school") as keyof typeof pack.education.data.labels] ?? x.education;
  return `${race}; ${nat}; ${lang}; highest education: ${ed.charAt(0).toLowerCase()}${ed.slice(1)}`;
}

function placeLine(pack: UsPack, p: Persona): string {
  const x = xOf(p);
  return `${pack.stateName(p.townSize)} (${pack.regionName(p.region)}), ${x.urbanicity === "rural" ? "rural area" : "urban or suburban area"}`;
}

function housingLine(p: Persona): string {
  const x = xOf(p);
  const d = DWELLING_EN[x.dwelling ?? ""] ?? x.dwelling ?? "home";
  if (p.householdType === "with_parents") return `${d}, the parents' home`;
  const t = US_TENURE_LABELS_EN[x.tenure ?? ""] ?? x.tenure ?? "?";
  const cost = x.housingCostEur ? ` (housing costs about ${money(x.housingCostEur)}/month, utilities included)` : "";
  return `${d}, ${t}${cost}`;
}

function householdLine(pack: UsPack, p: Persona): string {
  const x = xOf(p);
  const parts = [HOUSEHOLD_LABELS_EN[p.householdType] ?? p.householdType];
  if (p.householdType === "other") parts[0] = "lives with roommates or other relatives";
  if (x.partner) {
    const who = x.married ? (x.partner.sex === "F" ? "wife" : "husband") : x.partner.sex === "F" ? "female partner" : "male partner";
    const st = x.partner.status === "employed" && x.partner.pcs ? (pack.occupation.data.labels[x.partner.pcs as keyof typeof pack.occupation.data.labels] ?? "employed").replace(/ \(.*\)$/, "").toLowerCase() : STATUS_LABELS_EN[x.partner.status] ?? x.partner.status;
    parts.push(`${who}, ${x.partner.age}, ${st}`);
  }
  if (x.childrenAges?.length) {
    const n = x.childrenAges.length;
    parts.push(`${n} child${n > 1 ? "ren" : ""} (${x.childrenAges.map((a) => (a === 0 ? "under 1" : `${a}`)).join(", ")})`);
  }
  if (x.adultChildren?.length) parts.push(`an adult ${x.adultChildren[0]!.sex === "F" ? "daughter" : "son"}, ${x.adultChildren[0]!.age}, still living at home`);
  if (x.parents?.length) parts.push(x.parents.length === 2 ? "with both parents" : "with one parent");
  return parts.join("; ");
}

function subscriptionsLine(p: Persona): string {
  if (!p.subscriptions.length) return "none";
  return p.subscriptions.map((s) => `${s.name} ${moneyCents(s.monthlyEur)}${s.household ? " (for the household)" : ""}`).join(", ");
}

function skepticismHint(skepticism: number): string {
  if (skepticism >= 0.6) return `; marked distrust of novelties, advertising and sales calls (${level(skepticism)})`;
  if (skepticism < 0.3) return "; rather trusting, open to new things";
  return "";
}

export function usToneLabel(pack: UsPack, id: string | undefined): string {
  if (!id) return "neutral";
  return pack.psychographics.data.tones.find((t) => t.id === id)?.label ?? id;
}

const resolvedCache = new Map<string, ResolvedModules>();
function personaModules(pack: UsPack, p: Persona): ResolvedModules {
  if (pack.modules.ordered.length) return pack.modules;
  const ids = Object.keys(xOf(p).modules ?? {});
  if (!ids.length) return pack.modules;
  const key = `${pack.socle}:${ids.join(",")}`;
  let r = resolvedCache.get(key);
  if (!r) resolvedCache.set(key, (r = resolveModules(ids, pack.socle)));
  return r;
}

export function usModuleLines(pack: UsPack, p: Persona, only?: string[]): string[] {
  return cardLines(personaModules(pack, p), xOf(p).modules as never, p.sex, usSocleVars(pack, p))
    .filter((x) => !only || only.includes(x.module.def.id))
    .map((x) => x.line);
}

function incomeLine(p: Persona): string {
  const x = xOf(p);
  const gross = x.grossIncomeEur ?? p.monthlyIncomeEur;
  const personal = p.monthlyIncomeEur <= 0 ? "no personal income" : `${money(gross)} gross/month${x.payrollTaxEur ? ` (${money(p.monthlyIncomeEur)} after Social Security and Medicare payroll taxes)` : ""}`;
  const aid = x.snapEur ? `; the household receives SNAP food assistance (about ${money(x.snapEur)}/month)` : "";
  return `Personal income: ${personal}; household income after taxes and tax credits: ${money(p.householdIncomeEur ?? 0)}/month${aid}`;
}

function healthLine(pack: UsPack, p: Persona): string {
  const x = xOf(p);
  const h = pack.health.data.labels[(x.healthInsurance ?? "uninsured") as keyof typeof pack.health.data.labels] ?? x.healthInsurance;
  return `${h}${x.healthCostEur ? ` (premiums and out-of-pocket costs about ${money(x.healthCostEur)}/month for the household)` : ""}`;
}

function obligationsLine(p: Persona): string | null {
  const x = xOf(p);
  const parts: string[] = [];
  if (x.vehicles === 0) parts.push("no car");
  else if (x.vehicles) parts.push(`${x.vehicles} car${x.vehicles > 1 ? "s" : ""}${x.carEur ? ` (about ${money(x.carEur)}/month with insurance, gas${x.carLoan ? " and a car loan" : ""})` : ""}`);
  if (x.studentLoan) parts.push(x.studentLoanEur ? `student loan payments of about ${money(x.studentLoanEur)}/month` : "student loan debt, payments currently paused or deferred");
  if (x.childcareEur) parts.push(`childcare about ${money(x.childcareEur)}/month`);
  return parts.length ? `Other fixed costs: ${parts.join("; ")}` : null;
}

const wrap = (lines: string[], f?: (lines: string[]) => string[]) => (f ? f(lines) : lines);

/** Fiche compacte envoyée au LLM (récit, étude) ; `modules` et `wrapModules` comme pour la fiche française. */
export function usDescribeForPrompt(pack: UsPack, p: Persona, opts: { modules?: boolean | string[]; wrapModules?: (lines: string[]) => string[] } = {}): string {
  const x = xOf(p);
  const obligations = obligationsLine(p);
  const lines = [
    `Name: ${p.firstName ?? "(your choice, consistent with age and background)"}; ${p.sex === "F" ? "woman" : "man"}; ${p.age} years old`,
    `Background: ${backgroundLine(pack, p)}`,
    `Lives in: ${placeLine(pack, p)}`,
    `Situation: ${p.occupation}`,
    ...(opts.modules === false ? [] : wrap(usModuleLines(pack, p, Array.isArray(opts.modules) ? opts.modules : undefined), opts.wrapModules)),
    `Household: ${householdLine(pack, p)}; housing: ${housingLine(p)}`,
    incomeLine(p),
    `Health coverage: ${healthLine(pack, p)}`,
    ...(obligations ? [obligations] : []),
    `Discretionary budget after fixed and day-to-day expenses and subscriptions: ${money(p.monthlyDiscretionaryBudgetEur)}/month` +
      (x.monthlyShortfallEur ? ` (short at the end of the month, about ${money(x.monthlyShortfallEur)} in the red)` : ""),
    `Equipment: ${p.equipment.join(", ")}; ${SOCIAL_LABELS_EN[p.socialMediaUsage] ?? p.socialMediaUsage}`,
    `Current subscriptions: ${subscriptionsLine(p)}`,
    `Relationship with technology: ${ROGERS_LABELS_EN[p.techAdoption] ?? p.techAdoption}`,
    `Price sensitivity: ${level(p.priceSensitivity)}` + skepticismHint(p.skepticism),
    `Narrative tone: ${usToneLabel(pack, x.narrativeTone)}`,
  ];
  return lines.join("\n");
}

/** Affichage lisible (personas:show). */
export function formatUsPersona(pack: UsPack, p: Persona): string {
  const x = xOf(p);
  const head = `${p.firstName ?? "?"}, ${p.age} — ${p.occupation}`;
  const obligations = obligationsLine(p);
  const lines = [
    `${head}\n${"─".repeat(Math.min(80, head.length))}`,
    `id             ${p.id}  (pack ${p.packVersion}, seed ${p.seed})`,
    `Background     ${backgroundLine(pack, p)}`,
    `Lives in       ${placeLine(pack, p)}`,
    ...usModuleLines(pack, p).map((l) => `Module         ${l}`),
    `Household      ${householdLine(pack, p)} (${householdCountsEn(p.householdSize, x.consumptionUnits)})`,
    `Housing        ${housingLine(p)}`,
    `Income         ${incomeLine(p).replace(/^Personal income: /, "")}`,
    `Tax/credits    income taxes ${money(x.incomeTaxEur ?? 0)}/month; tax credits and SNAP ${money(x.benefitsEur ?? 0)}/month`,
    `Health         ${healthLine(pack, p)}`,
    ...(obligations ? [`Fixed costs    ${obligations.replace(/^Other fixed costs: /, "")}`] : []),
    `Living std     ${money(x.livingStandardEur ?? 0)}/month per adult-equivalent`,
    `Expenses       fixed ${money(x.preCommittedEur ?? 0)}; day-to-day ${money(x.currentExpensesEur ?? 0)}; subscriptions (excl. phone and internet) ${money(x.subscriptionsEur ?? 0)}`,
    `Budget         ${money(p.monthlyDiscretionaryBudgetEur)}/month` + (x.monthlyShortfallEur ? ` (shortfall ${money(x.monthlyShortfallEur)})` : ""),
    `Equipment      ${p.equipment.join(", ")}`,
    `Subscriptions  ${subscriptionsLine(p)}`,
    `Technology     ${ROGERS_LABELS_EN[p.techAdoption] ?? p.techAdoption}; ${SOCIAL_LABELS_EN[p.socialMediaUsage] ?? p.socialMediaUsage}`,
    `Psychology     price sensitivity ${p.priceSensitivity.toFixed(2)} (${level(p.priceSensitivity)}), skepticism ${p.skepticism.toFixed(2)} (${level(p.skepticism)})`,
    "",
    p.narrative ? p.narrative : "(no narrative yet: npm run personas:narrate)",
  ];
  if (p.narrative) lines.push(`\n  — narrative: ${p.narrativeBackend}/${p.narrativeModel}, tone ${usToneLabel(pack, x.narrativeTone)}`);
  return lines.join("\n");
}

const AGE_LABELS: Record<string, string> = { "18-29": "18-29", "30-44": "30-44", "45-59": "45-59", "60-79": "60 and over" };
const ACTIVITY_LABELS_EN: Record<string, string> = { employed: "Employed", unemployed: "Unemployed", student: "Studying", retired: "Retired", inactive: "Other not in labor force" };

/** Libellé d'un segment du socle, en anglais. */
export function usSegmentLabel(pack: UsPack, dim: string, code: string): string {
  switch (dim) {
    case "ageBand":
      return AGE_LABELS[code] ?? code;
    case "sex":
      return code === "F" ? "Women" : "Men";
    case "pcs":
      return code === "none" ? "Not currently employed" : (pack.occupation.data.labels[code as keyof typeof pack.occupation.data.labels] ?? code);
    case "livingStandard": {
      const d = pack.livingStandard.data.deciles;
      const m = (v: number) => money(v / 12);
      return code === "Q1" ? `Q1 (< ${m(d[1]!)}/month/AE)` : code === "Q2" ? `Q2 (${m(d[1]!)}–${m(d[3]!)})` : code === "Q3" ? `Q3 (${m(d[3]!)}–${m(d[5]!)})` : code === "Q4" ? `Q4 (${m(d[5]!)}–${m(d[7]!)})` : `Q5 (≥ ${m(d[7]!)})`;
    }
    case "techAdoption":
      return (ROGERS_LABELS_EN[code] ?? code).replace(/ \(.*\)$/, "");
    case "townSize":
      return pack.stateName(code);
    case "activityStatus":
      return ACTIVITY_LABELS_EN[code] ?? code;
    case "region":
      return pack.regionName(code);
    default:
      return code === "?" ? "Not given" : code.replace(/_/g, " ");
  }
}
