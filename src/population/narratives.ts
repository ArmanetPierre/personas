import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { personas, type Persona } from "../db/schema";
import type { Engine } from "../engine/engine";
import type { Usage } from "../engine/types";
import { SOCLE_FIELDS } from "../modules/migrate";
import { narratePersonas } from "../personas/narrate";
import type { Pack } from "../personas/pack";
import { saveNarrative } from "../personas/store";

/**
 * Récits à la demande : seules les personas d'un échantillon qui n'ont pas de récit en reçoivent un.
 * Reprenable (on ne traite que les récits manquants) et économe :
 * 1. réemploi : une persona v2 dont le « jumeau » du même socle (même graine, même rang, mêmes
 *    attributs, autre version de pack, ex. fr-2026.1) a déjà un récit le reprend, sans appel ;
 * 2. sinon, récit écrit par le moteur (claude-cli par défaut), avec les contrôles anti-clichés.
 * Les récits restent génériques : la fiche envoyée au LLM ne contient pas les lignes de module.
 */

export interface EnsureNarrativesResult {
  requested: number;
  alreadyDone: number;
  reused: number;
  written: number;
  missing: string[];
  calls: number;
  usage: Usage;
  durationMs: number;
  aborted: string | null;
}

const socleKey = (p: Persona) => {
  const x = { ...(p.extra as Record<string, unknown>) };
  delete x.modules;
  delete x.moduleVersions;
  return JSON.stringify([SOCLE_FIELDS.map((f) => p[f]), x]);
};

export async function ensureNarratives(
  db: Db,
  ids: string[],
  opts: {
    packOf: (p: Persona) => Pack;
    engine?: Engine;
    limit?: number;
    batchSize?: number;
    log?: (m: string) => void;
  },
): Promise<EnsureNarrativesResult> {
  const log = opts.log ?? (() => {});
  const res: EnsureNarrativesResult = {
    requested: ids.length,
    alreadyDone: 0,
    reused: 0,
    written: 0,
    missing: [],
    calls: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    durationMs: 0,
    aborted: null,
  };
  const rows = ids.length ? db.select().from(personas).where(inArray(personas.id, ids)).all() : [];
  const order = new Map(ids.map((id, i) => [id, i]));
  let todo = rows.filter((p) => !p.narrative).sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  res.alreadyDone = rows.length - todo.length;

  // 1. Réemploi des récits des jumeaux (même socle, même graine, même rang)
  const left: Persona[] = [];
  for (const p of todo) {
    if (p.seed === null || p.drawIndex === null) {
      left.push(p);
      continue;
    }
    const twins = db
      .select()
      .from(personas)
      .where(and(eq(personas.seed, p.seed), eq(personas.drawIndex, p.drawIndex), isNotNull(personas.narrative)))
      .all()
      .filter((t) => t.id !== p.id && socleKey(t) === socleKey(p));
    const twin = twins[0];
    if (twin) {
      db.update(personas)
        .set({ narrative: twin.narrative, narrativeBackend: twin.narrativeBackend, narrativeModel: twin.narrativeModel, narrativeAt: twin.narrativeAt })
        .where(eq(personas.id, p.id))
        .run();
      res.reused++;
    } else left.push(p);
  }
  if (res.reused) log(`${res.reused} récit(s) repris de personas jumelles (même socle, même graine, même rang).`);
  todo = opts.limit !== undefined ? left.slice(0, opts.limit) : left;
  if (!todo.length) return res;
  if (!opts.engine) {
    res.missing = todo.map((p) => p.id);
    return res;
  }

  // 2. Écriture, par pack (la fiche dépend du pack)
  const byPack = new Map<Pack, Persona[]>();
  for (const p of todo) {
    const pk = opts.packOf(p);
    byPack.set(pk, [...(byPack.get(pk) ?? []), p]);
  }
  const started = performance.now();
  for (const [pk, group] of byPack) {
    log(`${group.length} récit(s) à écrire (${pk.manifest.version}).`);
    const r = await narratePersonas(opts.engine, pk, group, {
      ...(opts.batchSize && { batchSize: opts.batchSize }),
      save: (id, narrative, meta) => saveNarrative(db, id, narrative, meta),
      log,
    });
    res.written += r.written;
    res.calls += r.batches;
    for (const k of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd"] as const) {
      const v = r.usage[k];
      if (v !== undefined) res.usage[k] = (res.usage[k] ?? 0) + v;
    }
    res.missing.push(...r.stillMissing.keys());
    if (r.aborted) {
      res.aborted = r.aborted;
      break;
    }
  }
  res.durationMs = Math.round(performance.now() - started);
  return res;
}
