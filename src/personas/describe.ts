import type { Persona } from "../db/schema";
import type { FrPack, Pack, PcsCode, Sex } from "./pack";
import { formatSgPersona, sgDescribeForPrompt } from "./countries/sg/describe";
import type { PersonaExtra } from "./sampler";
import { socleVars } from "../modules/apply";
import { cardLines } from "../modules/engine";
import { resolveModules, type ResolvedModules } from "../modules/registry";

/** Libellés français des codes stockés en base. */

export const HOUSEHOLD_LABELS: Record<string, string> = {
  alone: "vit seul·e",
  couple_no_child: "en couple, sans enfant au foyer",
  couple_with_children: "en couple, avec enfant(s) au foyer",
  single_parent: "parent isolé, avec enfant(s) au foyer",
  with_parents: "vit chez ses parents",
  other: "vit avec d'autres personnes (colocation, hébergé·e)",
};

export const TENURE_LABELS: Record<string, string> = {
  owner: "propriétaire (sans crédit en cours)",
  owner_mortgage: "propriétaire, rembourse un crédit immobilier",
  renter_private: "locataire dans le parc privé",
  renter_social: "locataire d'un logement social (HLM)",
  free: "logé·e gratuitement",
};

export const ROGERS_LABELS: Record<string, string> = {
  innovator: "innovateur (essaie tout ce qui sort)",
  early_adopter: "adopteur précoce (adopte tôt ce qui lui est utile)",
  early_majority: "majorité précoce (adopte une fois que c'est éprouvé)",
  late_majority: "majorité tardive (adopte par nécessité, sur le tard)",
  laggard: "retardataire (évite le numérique quand il le peut)",
};

export const SOCIAL_LABELS: Record<string, string> = {
  none: "n'utilise pas les réseaux sociaux",
  occasional: "réseaux sociaux de temps en temps",
  daily: "réseaux sociaux tous les jours",
  heavy: "réseaux sociaux plusieurs heures par jour",
};

export const STATUS_LABELS: Record<string, string> = {
  employed: "en emploi",
  unemployed: "au chômage",
  student: "étudiant·e",
  retired: "retraité·e",
  inactive: "inactif·ve",
};

const genderize = (s: string, sex: string) =>
  s.replace(/(\p{L}+)·(e|ve)\b/gu, (_, w: string, suf: string) =>
    sex === "F" ? (suf === "ve" ? w.replace(/f$/, "") + "ve" : w + "e") : w,
  );

const eur = (n: number) => `${Math.round(n).toLocaleString("fr-FR")} €`;

const level = (x: number) => (x < 0.25 ? "faible" : x < 0.45 ? "plutôt faible" : x < 0.6 ? "moyen" : x < 0.8 ? "élevé" : "très élevé");

export function extraOf(p: Persona): Partial<PersonaExtra> {
  return p.extra as Partial<PersonaExtra>;
}

function householdLine(pack: FrPack, p: Persona): string {
  const x = extraOf(p);
  const parts = [genderize(HOUSEHOLD_LABELS[p.householdType] ?? p.householdType, p.sex)];
  if (x.partner) {
    const pl = x.partner.sex === "F" ? "conjointe" : "conjoint";
    const st = x.partner.status === "employed" && x.partner.pcs
      ? pack.pcs.data.labels[x.partner.pcs as PcsCode][x.partner.sex as Sex].toLowerCase()
      : genderize(STATUS_LABELS[x.partner.status] ?? x.partner.status, x.partner.sex);
    parts.push(`${pl} de ${x.partner.age} ans, ${st}`);
  }
  if (x.childrenAges?.length) {
    parts.push(`${x.childrenAges.length} enfant${x.childrenAges.length > 1 ? "s" : ""} (${x.childrenAges.map((a) => (a === 0 ? "moins d'1 an" : `${a} ans`)).join(", ")})`);
  }
  if (x.parents?.length) parts.push(x.parents.length === 2 ? "avec ses deux parents" : "avec un parent");
  return parts.join(" ; ");
}

function placeLine(pack: FrPack, p: Persona): string {
  const x = extraOf(p);
  const size = pack.townSize.data.labels[p.townSize as keyof typeof pack.townSize.data.labels] ?? p.townSize;
  return `${pack.regionName(p.region)}, ${size.toLowerCase()}${x.cityHint ? ` (agglomération : ${x.cityHint})` : ""}`;
}

function subscriptionsLine(p: Persona): string {
  if (!p.subscriptions.length) return "aucun";
  return p.subscriptions
    .map((s) => `${s.name} ${s.monthlyEur.toLocaleString("fr-FR")} €${s.household ? " (pour le foyer)" : ""}`)
    .join(", ");
}

const TONE_LABELS: Record<string, string> = {};

export function toneLabel(pack: Pack, id: string | undefined): string {
  if (!id) return "neutre";
  if (!Object.keys(TONE_LABELS).length) for (const t of pack.psychographics.data.tones) TONE_LABELS[t.id] = t.label;
  return TONE_LABELS[id] ?? id;
}

/**
 * La méfiance n'est évoquée que si elle est marquée (≥ 0,6, cf. HIGH_SKEPTICISM dans narrate.ts) :
 * l'afficher pour tout le monde poussait le modèle à parler de publicité dans la moitié des récits.
 */
function skepticismHint(skepticism: number): string {
  if (skepticism >= 0.6) return ` ; méfiance marquée envers les nouveautés, la publicité et le démarchage (${level(skepticism)})`;
  if (skepticism < 0.3) return " ; plutôt confiant, ouvert à ce qui est nouveau";
  return "";
}

/** Lignes de fiche des modules activés (vide pour la base générale). */
export function moduleLines(pack: Pack, p: Persona, only?: string[]): string[] {
  return cardLines(personaModules(pack, p), extraOf(p).modules, p.sex, socleVars(pack, p))
    .filter((x) => !only || only.includes(x.module.def.id))
    .map((x) => x.line);
}

const resolvedCache = new Map<string, ResolvedModules>();
/**
 * Modules d'une persona : ceux du pack (v1), sinon ceux qui lui ont été appliqués (v2, ciblage :
 * clés de `extra.modules`), résolus dans l'ordre de tirage.
 */
export function personaModules(pack: Pack, p: Persona): ResolvedModules {
  if (pack.modules.ordered.length) return pack.modules;
  const ids = Object.keys(extraOf(p).modules ?? {});
  if (!ids.length) return pack.modules;
  const key = `${pack.socle}:${ids.join(",")}`;
  let r = resolvedCache.get(key);
  if (!r) resolvedCache.set(key, (r = resolveModules(ids, pack.socle)));
  return r;
}

/** Fiche compacte envoyée au LLM pour écrire le récit. */
/**
 * `modules: false` : fiche du socle seul (récits génériques des personas v2 : le récit parle de la vie,
 * les attributs de module s'ajoutent en lignes de fiche au moment de l'étude).
 * `modules: [ids]` : seulement les lignes de ces modules (ceux de la cible d'une étude ; une persona du
 * cache peut porter des modules appliqués par une autre étude).
 */
export function describeForPrompt(pack: Pack, p: Persona, opts: { modules?: boolean | string[] } = {}): string {
  if (pack.kind === "sg") return sgDescribeForPrompt(pack, p, opts);
  const x = extraOf(p);
  const lines = [
    `Prénom : ${p.firstName ?? "(au choix, cohérent avec l'âge)"} ; ${p.sex === "F" ? "femme" : "homme"} ; ${p.age} ans`,
    `Lieu de vie : ${placeLine(pack, p)}`,
    `Situation : ${p.occupation}`,
    ...(opts.modules === false ? [] : moduleLines(pack, p, Array.isArray(opts.modules) ? opts.modules : undefined)),
    `Foyer : ${householdLine(pack, p)} ; ${TENURE_LABELS[x.tenure ?? ""] ?? "logement inconnu"}`,
    `Revenu personnel : ${eur(p.monthlyIncomeEur)} net/mois ; revenu du foyer après impôt et aides : ${eur(p.householdIncomeEur ?? 0)}/mois`,
    `Reste-à-vivre personnel après dépenses contraintes, courantes et abonnements : ${eur(p.monthlyDiscretionaryBudgetEur)}/mois` +
      (x.monthlyShortfallEur ? ` (fins de mois dans le rouge, il manque environ ${eur(x.monthlyShortfallEur)})` : ""),
    `Équipement : ${p.equipment.join(", ")} ; ${SOCIAL_LABELS[p.socialMediaUsage] ?? p.socialMediaUsage}`,
    `Abonnements en cours : ${subscriptionsLine(p)}`,
    `Rapport au numérique : ${ROGERS_LABELS[p.techAdoption] ?? p.techAdoption}`,
    `Sensibilité au prix : ${level(p.priceSensitivity)}` + skepticismHint(p.skepticism),
    `Tonalité du récit : ${toneLabel(pack, x.narrativeTone)}`,
  ];
  return lines.join("\n");
}

/** Affichage lisible en français (commande personas:show). */
export function formatPersona(pack: Pack, p: Persona): string {
  if (pack.kind === "sg") return formatSgPersona(pack, p);
  const x = extraOf(p);
  const head = `${p.firstName ?? "?"}, ${p.age} ans — ${p.occupation}`;
  const lines = [
    `${head}\n${"─".repeat(Math.min(80, head.length))}`,
    `id             ${p.id}  (pack ${p.packVersion}, graine ${p.seed})`,
    `Lieu           ${placeLine(pack, p)}`,
    ...cardLines(personaModules(pack, p), extraOf(p).modules, p.sex, socleVars(pack, p)).map((x) => `${(x.module.def.short_label ?? x.module.def.label).slice(0, 14).padEnd(14)} ${x.line}`),
    `Foyer          ${householdLine(pack, p)} (${p.householdSize ?? "?"} pers., ${x.consumptionUnits ?? "?"} UC)`,
    `Logement       ${TENURE_LABELS[x.tenure ?? ""] ?? "?"}, coût ${eur(x.housingCostEur ?? 0)}/mois` +
      (x.housingAidEur ? ` (aide au logement ${eur(x.housingAidEur)})` : ""),
    `Revenus        personnel ${eur(p.monthlyIncomeEur)} ; foyer ${eur(p.householdIncomeEur ?? 0)} après impôt (${eur(x.incomeTaxEur ?? 0)}) et prestations (${eur(x.benefitsEur ?? 0)})`,
    `Niveau de vie  ${eur(x.livingStandardEur ?? 0)}/mois par UC`,
    `Dépenses       pré-engagées ${eur(x.preCommittedEur ?? 0)} ; courantes ${eur(x.currentExpensesEur ?? 0)} ; abonnements hors télécoms ${eur(x.subscriptionsEur ?? 0)}`,
    `Reste-à-vivre  ${eur(p.monthlyDiscretionaryBudgetEur)}/mois` + (x.monthlyShortfallEur ? ` (déficit ${eur(x.monthlyShortfallEur)})` : ""),
    `Équipement     ${p.equipment.join(", ")}`,
    `Abonnements    ${subscriptionsLine(p)}`,
    `Numérique      ${ROGERS_LABELS[p.techAdoption] ?? p.techAdoption} ; ${SOCIAL_LABELS[p.socialMediaUsage] ?? p.socialMediaUsage}`,
    `Psychologie    sensibilité au prix ${p.priceSensitivity.toFixed(2)} (${level(p.priceSensitivity)}), scepticisme ${p.skepticism.toFixed(2)} (${level(p.skepticism)})`,
    "",
    p.narrative ? wrap(p.narrative, 90) : "(pas encore de récit : npm run personas:narrate)",
  ];
  if (p.narrative) lines.push(`\n  — récit : ${p.narrativeBackend}/${p.narrativeModel}, tonalité ${toneLabel(pack, x.narrativeTone)}`);
  return lines.join("\n");
}

function wrap(text: string, width: number): string {
  const out: string[] = [];
  let line = "";
  for (const w of text.split(/\s+/)) {
    if ((line + " " + w).trim().length > width) {
      out.push(line);
      line = w;
    } else line = (line + " " + w).trim();
  }
  if (line) out.push(line);
  return out.map((l) => "  " + l).join("\n");
}
