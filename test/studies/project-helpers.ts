import type { Project } from "../../src/db/schema";
import { priceColumns, readProjectFile } from "../../src/studies/project";

/** Projet en mémoire depuis un fichier JSON ou YAML, comme `project:create` l'enregistrerait. */
export function projectFrom(path: string): Project {
  const f = readProjectFile(path);
  const cols = priceColumns(f);
  return {
    id: f.id ?? "x", name: f.name, pitch: f.pitch, targetAudience: null, businessModel: null, priceEur: cols.priceEur,
    pricePeriod: cols.pricePeriod, freeOffer: cols.freeOffer, competitors: f.competitors, alternatives: f.alternatives,
    extra: { ...cols.extra }, createdAt: "", updatedAt: "",
  } as Project;
}

export const PRICE_EXAMPLES = ["fresh-catch-per-kg", "photo-editor-one-time", "team-schedule-usd", "kids-reading-freemium"] as const;
