import type { Persona } from "../db/schema";
import { ROGERS_LABELS } from "../personas/describe";
import { asFr, type FrPack, type Pack } from "../personas/pack";
import { sgSegmentLabel } from "../personas/countries/sg/describe";
import { usSegmentLabel } from "../personas/countries/us/describe";
import { valueLabel } from "../modules/engine";
import { librarySegments, moduleLibrary } from "../modules/registry";

/**
 * Segments d'analyse et de quotas. Chaque dimension associe à une persona un code
 * stable (utilisé dans les quotas) et un libellé lisible (utilisé dans les sorties).
 */

/** Dimensions du socle (toutes les populations). */
export const SOCLE_DIMENSIONS = [
  "ageBand",
  "sex",
  "pcs",
  "livingStandard",
  "techAdoption",
  "townSize",
  "activityStatus",
  "region",
] as const;

/**
 * Dimensions déclarées par les modules (`segments` des fichiers modules/<id>/module.yaml) :
 * lues dans `extra.modules.<module>.<attribut>`, libellées par le module.
 */
export const MODULE_SEGMENTS = librarySegments();

/** Dimensions des modules, dans l'ordre de la bibliothèque ; affichées seulement si renseignées. */
export const EXTRA_DIMENSIONS: SegmentDimension[] = MODULE_SEGMENTS.map((s) => s.id);

export const SEGMENT_DIMENSIONS: readonly string[] = [...SOCLE_DIMENSIONS, ...EXTRA_DIMENSIONS];
export type SegmentDimension = string;

/** Dimensions affichées par défaut dans les agrégations. */
export const SUMMARY_DIMENSIONS: SegmentDimension[] = ["ageBand", "pcs", "livingStandard", "techAdoption", "townSize"];

const moduleSegment = (dim: string) => MODULE_SEGMENTS.find((s) => s.id === dim);

/** Code d'un attribut de module (« ? » si absent). */
export function extraValue(extra: unknown, dim: string): string {
  const seg = moduleSegment(dim);
  if (!seg) return "?";
  const v = (extra as { modules?: Record<string, Record<string, unknown>> } | null)?.modules?.[seg.module]?.[seg.attribute];
  return typeof v === "string" && v.trim() ? v.trim() : "?";
}

/** Libellé d'une valeur d'attribut de module, accordé au sexe de la persona d'exemple. */
export function extraLabel(dim: string, code: string, sex: string): string | undefined {
  const seg = moduleSegment(dim);
  const m = seg && moduleLibrary().get(seg.module);
  return m ? valueLabel(m, seg.attribute, code, sex) : undefined;
}

export const DIMENSION_LABELS: Record<SegmentDimension, string> = {
  ageBand: "Tranche d'âge",
  sex: "Sexe",
  pcs: "PCS",
  livingStandard: "Niveau de vie (quintile)",
  techAdoption: "Profil d'adoption",
  townSize: "Taille d'agglomération",
  activityStatus: "Situation d'activité",
  region: "Région",
  ...Object.fromEntries(MODULE_SEGMENTS.map((s) => [s.id, s.label])),
};

/** Libellés anglais des dimensions du socle (études en anglais) ; ceux des modules restent ceux du module. */
export const DIMENSION_LABELS_EN: Record<SegmentDimension, string> = {
  ageBand: "Age band",
  sex: "Sex",
  pcs: "Occupation group",
  livingStandard: "Living standard (quintile)",
  techAdoption: "Adoption profile",
  townSize: "Planning area",
  activityStatus: "Activity status",
  region: "Region",
  needFrequency: "Need frequency",
};

/** Dimensions des modules utilisées par défaut dans les comparaisons de variantes (rang `compare`). */
export const COMPARE_DIMENSIONS: SegmentDimension[] = MODULE_SEGMENTS.filter((s) => s.compare !== undefined)
  .sort((a, b) => a.compare! - b.compare!)
  .map((s) => s.id);

export const AGE_BANDS = [
  { code: "18-29", from: 18, to: 29 },
  { code: "30-44", from: 30, to: 44 },
  { code: "45-59", from: 45, to: 59 },
  { code: "60-79", from: 60, to: 200 },
] as const;

const PCS_SHORT: Record<string, string> = {
  "1": "Agriculteurs",
  "2": "Artisans, commerçants, chefs d'entreprise",
  "3": "Cadres",
  "4": "Professions intermédiaires",
  "5": "Employés",
  "6": "Ouvriers",
  none: "Jamais en emploi",
};

const ACTIVITY_LABELS: Record<string, string> = {
  employed: "En emploi",
  unemployed: "Chômage",
  student: "Études",
  retired: "Retraite",
  inactive: "Autres inactifs",
};

/** Quintiles de niveau de vie, à partir des déciles annuels du pack (D2, D4, D6, D8). */
export function livingStandardQuintile(pack: Pack, monthlyLivingStandardEur: number): string {
  const d = pack.livingStandard.data.deciles;
  const annual = monthlyLivingStandardEur * 12;
  const cuts = [d[1]!, d[3]!, d[5]!, d[7]!];
  const q = cuts.findIndex((c) => annual < c);
  return `Q${q === -1 ? 5 : q + 1}`;
}

function livingStandardLabel(pack: Pack, code: string): string {
  const d = pack.livingStandard.data.deciles;
  const m = (x: number) => `${Math.round(x / 12).toLocaleString("fr-FR")} €`;
  switch (code) {
    case "Q1":
      return `Q1 (< ${m(d[1]!)}/mois/UC)`;
    case "Q2":
      return `Q2 (${m(d[1]!)}–${m(d[3]!)})`;
    case "Q3":
      return `Q3 (${m(d[3]!)}–${m(d[5]!)})`;
    case "Q4":
      return `Q4 (${m(d[5]!)}–${m(d[7]!)})`;
    default:
      return `Q5 (≥ ${m(d[7]!)})`;
  }
}

export function segmentOf(pack: Pack, p: Persona, dim: SegmentDimension): string {
  switch (dim) {
    case "ageBand":
      return AGE_BANDS.find((b) => p.age >= b.from && p.age <= b.to)?.code ?? "?";
    case "sex":
      return p.sex;
    case "pcs":
      return p.pcs ?? "none";
    case "livingStandard": {
      const ls = (p.extra as { livingStandardEur?: number }).livingStandardEur;
      return ls === undefined ? "?" : livingStandardQuintile(pack, ls);
    }
    case "techAdoption":
      return p.techAdoption;
    case "townSize":
      return p.townSize;
    case "activityStatus":
      return p.activityStatus ?? "?";
    case "region":
      return p.region;
    default:
      return extraValue(p.extra, dim);
  }
}

export function segmentLabel(pack: Pack, dim: SegmentDimension, code: string, example?: Persona): string {
  if (pack.kind === "sg" && !EXTRA_DIMENSIONS.includes(dim)) return sgSegmentLabel(pack, dim, code);
  if (pack.kind === "us" && !EXTRA_DIMENSIONS.includes(dim)) return usSegmentLabel(pack, dim, code);
  if (EXTRA_DIMENSIONS.includes(dim) && example && code !== "?") {
    const l = extraLabel(dim, code, example.sex);
    if (l) return l;
  }
  switch (dim) {
    case "ageBand":
      return code === "60-79" ? "60 ans et plus" : `${code} ans`;
    case "sex":
      return code === "F" ? "Femmes" : "Hommes";
    case "pcs":
      return PCS_SHORT[code] ?? code;
    case "livingStandard":
      return livingStandardLabel(pack, code);
    case "techAdoption":
      return (ROGERS_LABELS[code] ?? code).replace(/ \(.*\)$/, "");
    case "townSize":
      return asFr(pack).townSize.data.labels[code as keyof FrPack["townSize"]["data"]["labels"]] ?? code;
    case "activityStatus":
      return ACTIVITY_LABELS[code] ?? code;
    case "region":
      return pack.regionName(code);
    default:
      return code === "?" ? "Non renseigné" : code.replace(/_/g, " ");
  }
}

/** Ordre d'affichage stable des codes d'une dimension. */
export function segmentOrder(dim: SegmentDimension, codes: string[]): string[] {
  const order: Partial<Record<SegmentDimension, string[]>> = {
    ageBand: AGE_BANDS.map((b) => b.code),
    pcs: ["1", "2", "3", "4", "5", "6", "none"],
    livingStandard: ["Q1", "Q2", "Q3", "Q4", "Q5"],
    techAdoption: ["innovator", "early_adopter", "early_majority", "late_majority", "laggard"],
    townSize: ["rural", "uu_lt20k", "uu_20k_100k", "uu_100k_200k", "uu_200k_2m", "uu_paris"],
  };
  const ref = order[dim];
  return [...codes].sort((a, b) => {
    if (!ref) return a.localeCompare(b);
    const ia = ref.indexOf(a);
    const ib = ref.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
}
