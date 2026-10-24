import { z } from "zod";
import type { Persona } from "../db/schema";
import type { Pack } from "../personas/pack";
import { Rng } from "../personas/rng";
import { SEGMENT_DIMENSIONS, segmentOf, type SegmentDimension } from "./segments";

/**
 * Échantillonnage d'une étude.
 * Sans quotas : tirage aléatoire simple à graine (la base est déjà représentative).
 * Avec quotas : on parcourt la même permutation aléatoire et on ne garde une persona
 * que si toutes ses cellules de quota ont encore de la place.
 */

/** `{ "ageBand": { "18-29": 0.25, ... }, "pcs": { "3": 0.2, ... } }` : parts par code de segment. */
export const quotasSchema = z.partialRecord(
  z.enum(SEGMENT_DIMENSIONS),
  z.record(z.string(), z.number().nonnegative()),
);
export type Quotas = z.infer<typeof quotasSchema>;

/** Effectifs cibles par cellule (méthode du plus fort reste, total = n). */
export function quotaTargets(shares: Record<string, number>, n: number): Record<string, number> {
  const total = Object.values(shares).reduce((a, b) => a + b, 0);
  if (total <= 0) throw new Error("Quotas vides : la somme des parts doit être positive.");
  const raw = Object.entries(shares).map(([k, s]) => ({ k, exact: (s / total) * n }));
  const out: Record<string, number> = {};
  let assigned = 0;
  for (const r of raw) {
    out[r.k] = Math.floor(r.exact);
    assigned += out[r.k]!;
  }
  raw
    .sort((a, b) => b.exact - Math.floor(b.exact) - (a.exact - Math.floor(a.exact)) || a.k.localeCompare(b.k))
    .slice(0, n - assigned)
    .forEach((r) => (out[r.k] = out[r.k]! + 1));
  return out;
}

export function shuffleIds<T extends { id: string }>(rows: T[], seed: number): T[] {
  const out = [...rows].sort((a, b) => a.id.localeCompare(b.id));
  const rng = new Rng(`study-sample:${seed}`);
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export interface SampleResult {
  ids: string[];
  /** Cellules de quota non remplies (code → manque). */
  shortfalls: string[];
}

export function drawSample(
  pack: Pack,
  pool: Persona[],
  n: number,
  seed: number,
  quotas: Quotas = {},
): SampleResult {
  if (!Number.isInteger(n) || n < 1) throw new Error(`Taille d'échantillon invalide : ${n}`);
  if (pool.length < n) throw new Error(`Base trop petite : ${pool.length} personas pour un échantillon de ${n}.`);
  const shuffled = shuffleIds(pool, seed);
  const dims = Object.keys(quotas) as SegmentDimension[];
  if (!dims.length) return { ids: shuffled.slice(0, n).map((p) => p.id), shortfalls: [] };

  const remaining = new Map<SegmentDimension, Record<string, number>>();
  for (const d of dims) remaining.set(d, quotaTargets(quotas[d]!, n));

  const ids: string[] = [];
  for (const p of shuffled) {
    if (ids.length >= n) break;
    const cells = dims.map((d) => [d, segmentOf(pack, p, d)] as const);
    if (cells.every(([d, c]) => (remaining.get(d)![c] ?? 0) > 0)) {
      ids.push(p.id);
      for (const [d, c] of cells) remaining.get(d)![c]!--;
    }
  }
  const shortfalls: string[] = [];
  for (const [d, cells] of remaining) {
    for (const [c, left] of Object.entries(cells)) if (left > 0) shortfalls.push(`${d}=${c} : manque ${left}`);
  }
  return { ids, shortfalls };
}
