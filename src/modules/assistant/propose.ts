import type { Engine } from "../../engine/engine";
import type { CompleteResult } from "../../engine/types";
import { isUsageLimitError } from "../../personas/narrate";
import { lineDiff } from "./diff";
import {
  createDraft,
  draftExists,
  readDraftFile,
  readDraftYaml,
  readMeta,
  validateModuleYaml,
  writeDraftFile,
  writeDraftYaml,
  writeMeta,
  type DraftMeta,
} from "./drafts";
import { previewModule } from "./preview";
import {
  generationPrompt,
  generationSystem,
  proposalSchema,
  repairPrompt,
  researchPrompt,
  researchSchema,
  RESEARCH_SYSTEM,
  recalibrationPrompt,
  revisionPrompt,
  revisionSchema,
  targetedResearchPrompt,
  type Research,
} from "./prompts";

/**
 * Proposition et révision de modules par l'assistant (Claude via l'abonnement, `claude-cli`).
 * Étapes reprenables, chacune enregistrée dans le brouillon : recherche de sources (mode recherche :
 * WebSearch et WebFetch seulement), rédaction du YAML, réparations (2 à 3 tours) contre la validation
 * et les alertes bloquantes de l'aperçu. Sur une limite d'usage, le brouillon passe en `error` et une
 * relance avec `--draft` reprend à l'étape interrompue.
 */

export const MAX_REPAIRS = 3;
/** Tours de recalage des distributions sur les parts sourcées, après une révision. */
export const MAX_RECALIBRATIONS = 2;
/** Délai d'une requête de recherche web (plusieurs recherches et pages lues). */
export const RESEARCH_TIMEOUT_MS = 20 * 60_000;

export interface ProposeInput {
  draftId?: string;
  description: string;
  moduleId?: string;
  socle?: string;
  projectId?: string;
  projectContext?: string;
  /** Sans recherche web (tests, ou hors ligne) : tout ce qui n'est pas sourcé devient hypothèse. */
  research?: boolean;
  maxRepairs?: number;
  log?: (m: string) => void;
}

function addUsage(meta: DraftMeta, r: CompleteResult<unknown>): void {
  const u = (meta.usage ??= { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 });
  u.calls += r.attempts;
  u.inputTokens += r.usage.inputTokens;
  u.outputTokens += r.usage.outputTokens;
  u.costUsd += r.usage.costUsd ?? 0;
  u.durationMs += r.durationMs;
}

function progress(meta: DraftMeta, text: string, log?: (m: string) => void): DraftMeta {
  log?.(text);
  return writeMeta({ ...meta, status: "proposing", progress: text });
}

const issuesOf = (yaml: string, socle: string) => {
  const v = validateModuleYaml(yaml, { socle });
  if (!v.ok) return v.errors.map((e) => `${e.path ? `${e.path} : ` : ""}${e.message}`);
  // Alertes bloquantes de l'aperçu (incohérence avec le socle…) : à réparer aussi
  const p = previewModule({ yaml }, { n: 4000, sample: 0, socle });
  return p.alerts.filter((a) => a.level === "error").map((a) => a.message);
};

/** Boucle de réparation : renvoie au modèle les erreurs de validation, jusqu'à `max` tours. */
async function repairLoop(engine: Engine, meta: DraftMeta, yaml: string, notes: string[], max: number, log?: (m: string) => void) {
  let current = yaml;
  let errors = issuesOf(current, meta.socle);
  let round = meta.steps?.repairRounds ?? 0;
  while (errors.length && round < max) {
    round++;
    meta = progress(meta, `Réparation ${round}/${max} : ${errors.length} erreur(s)`, log);
    const r = await engine.complete({
      system: generationSystem(),
      messages: [{ role: "user", content: repairPrompt(current, errors) }],
      schema: proposalSchema,
      maxTokens: 16_000,
    });
    addUsage(meta, r);
    const before = current;
    current = r.data.yaml;
    notes = [...new Set([...notes, ...r.data.notes])];
    writeDraftYaml(meta.id, current);
    meta.history.push({ at: new Date().toISOString(), kind: "repair", summary: `Réparation ${round} (${errors.length} erreur(s))`, diff: lineDiff(before, current) });
    meta = writeMeta({ ...meta, notes, steps: { ...meta.steps, repairRounds: round } });
    errors = issuesOf(current, meta.socle);
  }
  return { meta, yaml: current, errors, notes };
}

async function guarded<T>(meta: DraftMeta, run: () => Promise<T>, log?: (m: string) => void): Promise<T | null> {
  try {
    return await run();
  } catch (err) {
    const msg = (err as Error).message;
    const quota = isUsageLimitError(msg);
    const latest = readMeta(meta.id);
    writeMeta({
      ...latest,
      status: "error",
      error: quota ? `Limite d'usage atteinte : relancer plus tard avec --draft ${meta.id} (reprise à l'étape « ${latest.progress} »). ${msg}` : msg,
    });
    log?.(`Échec : ${msg}`);
    return null;
  }
}

/** Propose un module : recherche, rédaction, réparations. Reprenable par `draftId`. */
export async function proposeModule(engine: Engine, input: ProposeInput): Promise<DraftMeta> {
  const log = input.log;
  const socle = input.socle ?? "fr";
  let meta =
    input.draftId && draftExists(input.draftId)
      ? readMeta(input.draftId)
      : createDraft({
          ...(input.draftId && { id: input.draftId }),
          description: input.description,
          socle,
          ...(input.projectId && { projectId: input.projectId }),
          ...(input.moduleId && { moduleId: input.moduleId }),
        });
  if (meta.status === "accepted") throw new Error(`Le brouillon ${meta.id} est déjà validé.`);
  const { error: _previous, ...clean } = meta;
  meta = writeMeta({ ...clean, status: "proposing" });

  // 1. Recherche de sources (mode recherche)
  let research: Research | null = null;
  const saved = readDraftFile(meta.id, "research.json");
  if (saved) research = JSON.parse(saved) as Research;
  else if (input.research !== false) {
    meta = progress(meta, "Recherche de sources (WebSearch, WebFetch)…", log);
    const r = await guarded(
      meta,
      () =>
        engine.complete({
          system: RESEARCH_SYSTEM,
          messages: [{ role: "user", content: researchPrompt({ description: meta.description, ...(meta.moduleId && { moduleId: meta.moduleId }), ...(input.projectContext && { projectContext: input.projectContext }), socle }) }],
          schema: researchSchema,
          webTools: ["WebSearch", "WebFetch"],
          timeoutMs: RESEARCH_TIMEOUT_MS,
          maxTokens: 16_000,
        }),
      log,
    );
    if (!r) return readMeta(meta.id);
    addUsage(meta, r);
    research = r.data;
    writeDraftFile(meta.id, "research.json", `${JSON.stringify(research, null, 2)}\n`);
    meta = writeMeta({ ...meta, notes: [...meta.notes, ...research.notes.map((n) => `Recherche : ${n}`)], steps: { ...meta.steps, research: true } });
    log?.(`${research.sources.length} source(s), dont ${research.sources.filter((s) => s.verified).length} vérifiée(s).`);
  }

  // 2. Rédaction du YAML
  let yaml = readDraftYaml(meta.id);
  if (!yaml || !meta.steps?.generated) {
    meta = progress(meta, "Rédaction du YAML…", log);
    const r = await guarded(
      meta,
      () =>
        engine.complete({
          system: generationSystem(),
          messages: [{ role: "user", content: generationPrompt({ description: meta.description, ...(meta.moduleId && { moduleId: meta.moduleId }), socle, research, ...(input.projectContext && { projectContext: input.projectContext }) }) }],
          schema: proposalSchema,
          maxTokens: 16_000,
        }),
      log,
    );
    if (!r) return readMeta(meta.id);
    addUsage(meta, r);
    yaml = r.data.yaml;
    writeDraftYaml(meta.id, yaml);
    meta.history.push({ at: new Date().toISOString(), kind: "propose", summary: "Proposition initiale" });
    meta = writeMeta({ ...meta, notes: [...meta.notes, ...r.data.notes], steps: { ...meta.steps, generated: true } });
  }

  // 3. Réparations
  const fixed = await guarded(meta, () => repairLoop(engine, meta, yaml!, meta.notes, input.maxRepairs ?? MAX_REPAIRS, log), log);
  if (!fixed) return readMeta(meta.id);
  meta = fixed.meta;
  if (fixed.errors.length) {
    return writeMeta({ ...meta, status: "error", progress: "Validation en échec après réparations", error: fixed.errors.join("\n") });
  }
  const preview = previewModule({ yaml: fixed.yaml }, { n: 10_000, sample: 0, socle: meta.socle });
  const warn = preview.alerts.filter((a) => a.level === "warn").map((a) => `Aperçu : ${a.message}`);
  return writeMeta({ ...meta, status: "ready", progress: "Prêt à relire", notes: [...new Set([...meta.notes, ...warn])] });
}

/** Fusionne une recherche ciblée dans research.json (sources dédoublonnées par URL, clés uniques). */
export function mergeResearch(old: Research | null, add: Research): Research {
  if (!old) return add;
  const byUrl = new Map(old.sources.map((s) => [s.url, s]));
  const keys = new Set(old.sources.map((s) => s.key));
  const sources = [...old.sources];
  for (const s of add.sources) {
    const prev = byUrl.get(s.url);
    if (prev) {
      // Même page : on garde la vérification la plus forte et on cumule les chiffres
      prev.verified ||= s.verified;
      prev.findings = [...new Set([...prev.findings, ...s.findings])];
      continue;
    }
    let key = s.key;
    for (let k = 2; keys.has(key); k++) key = `${s.key}_${k}`;
    keys.add(key);
    sources.push({ ...s, key });
  }
  return {
    summary: `${old.summary}\n\n${add.summary}`,
    sources,
    attributes: [...old.attributes, ...add.attributes],
    notes: [...new Set([...old.notes, ...add.notes])],
  };
}

/** Parts sourcées non atteintes à l'aperçu (validation.shares), en texte pour le recalage. */
function unmetShares(yaml: string, socle: string): string[] {
  const p = previewModule({ yaml }, { n: 10_000, sample: 0, socle });
  return p.alerts.filter((a) => a.message.startsWith("Cible déclarée non atteinte")).map((a) => a.message.replace("Cible déclarée non atteinte : ", ""));
}

/**
 * Révision ciblée par instruction ; historique avec diff. `research` : recherche web ciblée sur
 * l'instruction (mode recherche), fusionnée dans research.json, avant la révision. Après validation,
 * les distributions sont recalées sur les parts sourcées (`validation.shares`), vérifiées par l'aperçu
 * (2 tours au plus).
 */
export async function reviseModule(
  engine: Engine,
  draftId: string,
  instruction: string,
  opts: { maxRepairs?: number; research?: boolean; maxRecalibrations?: number; log?: (m: string) => void } = {},
): Promise<DraftMeta> {
  let meta = readMeta(draftId);
  if (meta.status === "accepted") throw new Error(`Le brouillon ${draftId} est déjà validé.`);
  if (meta.status === "proposing") throw new Error(`Le brouillon ${draftId} est en cours de proposition.`);
  const before = readDraftYaml(draftId);
  if (!before) throw new Error(`Le brouillon ${draftId} n'a pas encore de YAML.`);

  // 1. Recherche ciblée (facultative)
  let added: Research | null = null;
  if (opts.research) {
    meta = progress(meta, `Recherche ciblée (WebSearch, WebFetch) : ${instruction}`, opts.log);
    const rr = await guarded(
      meta,
      () =>
        engine.complete({
          system: RESEARCH_SYSTEM,
          messages: [{ role: "user", content: targetedResearchPrompt(before, instruction) }],
          schema: researchSchema,
          webTools: ["WebSearch", "WebFetch"],
          timeoutMs: RESEARCH_TIMEOUT_MS,
          maxTokens: 16_000,
        }),
      opts.log,
    );
    if (!rr) return readMeta(draftId);
    addUsage(meta, rr);
    added = rr.data;
    if (!added.sources.length) {
      // Recherche vide (le modèle a parfois répondu sans chercher) : une relance, plus insistante
      opts.log?.("Recherche ciblée vide : relance.");
      const again = await guarded(
        meta,
        () =>
          engine.complete({
            system: RESEARCH_SYSTEM,
            messages: [
              { role: "user", content: targetedResearchPrompt(before, instruction) },
              { role: "assistant", content: JSON.stringify(rr.data) },
              { role: "user", content: "Tu n'as renvoyé aucune source. Lance maintenant les recherches WebSearch demandées (au moins 3), ouvre les pages utiles avec WebFetch, puis renvoie le JSON avec toutes les sources consultées, même celles qui ne donnent pas le chiffre." },
            ],
            schema: researchSchema,
            webTools: ["WebSearch", "WebFetch"],
            timeoutMs: RESEARCH_TIMEOUT_MS,
            maxTokens: 16_000,
          }),
        opts.log,
      );
      if (!again) return readMeta(draftId);
      addUsage(meta, again);
      added = again.data;
    }
    const old = readDraftFile(draftId, "research.json");
    const merged = mergeResearch(old ? (JSON.parse(old) as Research) : null, added);
    writeDraftFile(draftId, "research.json", `${JSON.stringify(merged, null, 2)}\n`);
    meta = writeMeta({ ...meta, notes: [...new Set([...meta.notes, ...added.notes.map((n) => `Recherche : ${n}`)])] });
    opts.log?.(`${added.sources.length} source(s) trouvée(s), dont ${added.sources.filter((x) => x.verified).length} vérifiée(s).`);
  }

  // 2. Révision
  meta = progress(meta, `Révision : ${instruction}`, opts.log);
  const r = await guarded(
    meta,
    () =>
      engine.complete({
        system: generationSystem(),
        messages: [{ role: "user", content: revisionPrompt(before, instruction, added) }],
        schema: revisionSchema,
        maxTokens: 16_000,
      }),
    opts.log,
  );
  if (!r) return readMeta(draftId);
  addUsage(meta, r);
  writeDraftYaml(draftId, r.data.yaml);
  meta.history.push({ at: new Date().toISOString(), kind: "revise", summary: `${instruction} — ${r.data.summary}`, diff: lineDiff(before, r.data.yaml) });
  meta = writeMeta({ ...meta, notes: [...new Set([...meta.notes, ...r.data.notes])], steps: { ...meta.steps, repairRounds: 0 } });
  let fixed = await guarded(meta, () => repairLoop(engine, meta, r.data.yaml, meta.notes, opts.maxRepairs ?? MAX_REPAIRS, opts.log), opts.log);
  if (!fixed) return readMeta(draftId);
  if (fixed.errors.length) {
    return writeMeta({ ...fixed.meta, status: "error", progress: "Révision invalide après réparations", error: fixed.errors.join("\n") });
  }

  // 3. Recalage sur les parts sourcées, vérifié par l'aperçu
  let yaml = fixed.yaml;
  meta = fixed.meta;
  let unmet = unmetShares(yaml, meta.socle);
  const maxRecal = opts.maxRecalibrations ?? MAX_RECALIBRATIONS;
  for (let round = 1; unmet.length && round <= maxRecal; round++) {
    meta = progress(meta, `Recalage ${round}/${maxRecal} sur les parts sourcées : ${unmet.length} écart(s)`, opts.log);
    const current = yaml;
    const rc = await guarded(
      meta,
      () =>
        engine.complete({
          system: generationSystem(),
          messages: [{ role: "user", content: recalibrationPrompt(current, unmet) }],
          schema: revisionSchema,
          maxTokens: 16_000,
        }),
      opts.log,
    );
    if (!rc) return readMeta(draftId);
    addUsage(meta, rc);
    const v = validateModuleYaml(rc.data.yaml, { socle: meta.socle });
    if (!v.ok) {
      opts.log?.(`Recalage ${round} invalide (${v.errors.length} erreur(s)) : version précédente gardée.`);
      continue;
    }
    const after = unmetShares(rc.data.yaml, meta.socle);
    if (after.length > unmet.length) {
      opts.log?.(`Recalage ${round} moins bon (${after.length} écart(s)) : version précédente gardée.`);
      continue;
    }
    writeDraftYaml(draftId, rc.data.yaml);
    meta.history.push({ at: new Date().toISOString(), kind: "repair", summary: `Recalage ${round} : ${rc.data.summary}`, diff: lineDiff(current, rc.data.yaml) });
    meta = writeMeta({ ...meta, notes: [...new Set([...meta.notes, ...rc.data.notes])] });
    yaml = rc.data.yaml;
    unmet = after;
  }
  const remaining = unmet.map((u) => `Recalage : part sourcée encore hors fourchette : ${u}`);
  return writeMeta({ ...meta, status: "ready", progress: "Révision prête à relire", notes: [...new Set([...meta.notes, ...remaining])] });
}
