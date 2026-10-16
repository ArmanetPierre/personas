import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { eq } from "drizzle-orm";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { Db } from "../db/client";
import { responses, type ResponseRow, type Study } from "../db/schema";
import type { Engine, Usage } from "../engine";
import { isUsageLimitError, type ConceptPricePayload } from "./run";
import { QUESTION_KEY } from "./protocols/concept-price";
import { CANONICAL_OBJECTIONS, objectionDefSchema, type ObjectionDef } from "./protocols/protocol";
import { studyResponses } from "./store";

/**
 * Recatégorisation a posteriori (lot P1) : les objections d'une étude sont reclassées dans une
 * nouvelle taxonomie par lots, via le moteur (claude-cli), et rangées dans `payload.recoded[clé]`,
 * à côté de l'original, qui n'est jamais modifié. Reprenable : seules les réponses sans recodage
 * pour cette clé sont traitées.
 */

export interface Taxonomy {
  key: string;
  objections: ObjectionDef[];
}

/** Lit une taxonomie : proposition (`{ protocol: { objections } }`), bloc `protocol`, `{ objections }` ou tableau. */
export function readTaxonomy(path: string, key?: string): Taxonomy {
  const text = readFileSync(path, "utf8");
  const raw = (/\.ya?ml$/i.test(path) ? parseYaml(text) : JSON.parse(text)) as unknown;
  const r = raw as { protocol?: { objections?: unknown }; objections?: unknown };
  const list = Array.isArray(raw) ? raw : r.protocol?.objections ?? r.objections;
  const parsed = z.array(objectionDefSchema).min(2).safeParse(list);
  if (!parsed.success) throw new Error(`Taxonomie invalide (${path}) : ${parsed.error.issues.map((i) => `${i.path.join(".")} : ${i.message}`).join(" ; ")}`);
  return { key: key ?? basename(path, extname(path)).replace(/-protocol$/, ""), objections: parsed.data };
}

export interface RecodeItem {
  id: string;
  category: string;
  detail: string;
}

export function buildRecodePrompt(t: Taxonomy): string {
  return `Tu reclasses des objections exprimées par des personas lors d'une étude de marché dans une nouvelle taxonomie. Pour chaque objection, choisis la catégorie dont la description correspond le mieux à son détail. L'ancienne catégorie n'est qu'une indication : elle était souvent trop large. Garde « autre » pour ce qui ne rentre vraiment nulle part.

Catégories :
${t.objections.map((o) => `- "${o.code}" : ${o.label} — ${o.description}`).join("\n")}

Réponds avec l'objet JSON seul : { "items": [ { "id": "...", "code": "..." } ] }, un élément par objection, avec le même id.`;
}

export interface RecodeResult {
  responses: number;
  objections: number;
  calls: number;
  usage: Usage;
  stoppedForUsageLimit: string | null;
  failed: number;
}

export async function recodeStudy(
  db: Db,
  engine: Engine,
  study: Study,
  taxonomy: Taxonomy,
  opts: { batchSize?: number; log?: (m: string) => void } = {},
): Promise<RecodeResult> {
  const log = opts.log ?? (() => {});
  const batchSize = opts.batchSize ?? 40;
  const codes = taxonomy.objections.map((o) => o.code) as [string, ...string[]];
  const schema = z.object({ items: z.array(z.object({ id: z.string(), code: z.enum(codes) })) });
  const rows = studyResponses(db, study.id, QUESTION_KEY).filter((r) => !(r.payload as ConceptPricePayload).recoded?.[taxonomy.key]);
  const items: Array<RecodeItem & { row: ResponseRow; index: number }> = rows
    .flatMap((row) => ((row.payload as ConceptPricePayload).answer.objections ?? []).map((o, index) => ({ category: o.category, detail: o.detail, row, index })))
    .map((x, k) => ({ ...x, id: `o${k + 1}` }));
  const result: RecodeResult = { responses: rows.length, objections: items.length, calls: 0, usage: { inputTokens: 0, outputTokens: 0 }, stoppedForUsageLimit: null, failed: 0 };
  const system = buildRecodePrompt(taxonomy);
  const assigned = new Map<string, string>();
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    try {
      const res = await engine.complete({
        system,
        messages: [{ role: "user", content: JSON.stringify(batch.map(({ id, category, detail }) => ({ id, ancienne_categorie: category, detail }))) }],
        schema,
        maxTokens: 4_000,
      });
      result.calls++;
      result.usage.inputTokens += res.usage.inputTokens;
      result.usage.outputTokens += res.usage.outputTokens;
      for (const it of res.data.items) assigned.set(it.id, it.code);
      log(`[${Math.min(i + batchSize, items.length)}/${items.length}] objections reclassées`);
    } catch (err) {
      if (isUsageLimitError(err)) {
        result.stoppedForUsageLimit = (err as Error).message;
        break;
      }
      result.failed += batch.length;
      log(`[échec] lot ${i / batchSize + 1} : ${(err as Error).message.slice(0, 200)}`);
    }
  }
  // Écriture : seulement les réponses dont toutes les objections ont reçu un code
  const now = new Date().toISOString();
  for (const row of rows) {
    const mine = items.filter((x) => x.row.id === row.id).sort((a, b) => a.index - b.index);
    const out = mine.map((x) => assigned.get(x.id));
    if (out.some((c) => c === undefined)) continue;
    const payload = row.payload as ConceptPricePayload;
    const next = { ...payload, recoded: { ...(payload.recoded ?? {}), [taxonomy.key]: { codes: out as string[], at: now, model: engine.backend.model } } };
    db.update(responses).set({ payload: next }).where(eq(responses.id, row.id)).run();
  }
  return result;
}

export interface RecodedDistribution {
  key: string;
  n: number;
  /** Part des répondants qui citent chaque catégorie de la nouvelle taxonomie. */
  shares: Record<string, number>;
  counts: Record<string, number>;
  /** Répartition des anciennes catégories dans les nouvelles (nombre d'objections). */
  crosstab: Record<string, Record<string, number>>;
  /** Parts par catégorie canonique, pour comparer à l'ancienne répartition. */
  canonical: Record<string, number>;
  /** Exemples par nouvelle catégorie. */
  examples: Record<string, string[]>;
}

export function recodedDistribution(rows: ResponseRow[], t: Taxonomy): RecodedDistribution | null {
  const done = rows.filter((r) => (r.payload as ConceptPricePayload).recoded?.[t.key]);
  if (!done.length) return null;
  const counts = Object.fromEntries(t.objections.map((o) => [o.code, 0])) as Record<string, number>;
  const canon = Object.fromEntries(CANONICAL_OBJECTIONS.map((c) => [c, 0])) as Record<string, number>;
  const crosstab: Record<string, Record<string, number>> = {};
  const examples: Record<string, string[]> = {};
  const canonOf = new Map(t.objections.map((o) => [o.code, o.canonical]));
  for (const r of done) {
    const p = r.payload as ConceptPricePayload;
    const codes = p.recoded![t.key]!.codes;
    for (const c of new Set(codes)) counts[c] = (counts[c] ?? 0) + 1;
    for (const c of new Set(codes.map((x) => canonOf.get(x) ?? "other"))) canon[c] = (canon[c] ?? 0) + 1;
    codes.forEach((c, i) => {
      const old = p.answer.objections[i]?.category ?? "?";
      (crosstab[old] ??= {})[c] = (crosstab[old]![c] ?? 0) + 1;
      const ex = (examples[c] ??= []);
      if (ex.length < 3) ex.push(p.answer.objections[i]?.detail ?? "");
    });
  }
  const n = done.length;
  const share = (x: Record<string, number>) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, Math.round((v / n) * 1000) / 1000]));
  return { key: t.key, n, shares: share(counts), counts, crosstab, canonical: share(canon), examples };
}
