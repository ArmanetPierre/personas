import { studyAudience } from "./locale";
import type { Db } from "../db/client";
import { responses, type Persona, type Study } from "../db/schema";
import type { Engine, Usage } from "../engine";
import { isBudgetExceeded } from "../engine/budget";
import type { StudyExtra } from "../db/schema";
import type { Pack } from "../personas/pack";
import { getProject } from "./project";
import {
  answerSchemaFor,
  buildRepairPrompt,
  buildSystemPrompt,
  buildUserPrompt,
  checkCoherence,
  coherenceContext,
  priceIssueDetails,
  pickEncounter,
  protocolVersionOf,
  hasV3Measures,
  usesAttributeBlock,
  buildRoleSystemPrompt,
  roleAnswerSchema,
  type CoherenceContext,
  QUESTION_KEY,
  studyTiers,
  type ConceptPriceAnswer,
} from "./protocols/concept-price";
import { checkFacts } from "./protocols/facts";
import { toneWarning } from "./pitch-tone";
import type { ModuleValues } from "../modules/engine";
import type { Project } from "../db/schema";
import { resolveSoclePack } from "../population/target";
import { roleProject, rolePrompt } from "./role-view";
import { childBlock, freezeRole, pickChild, prepareChild, projectRoles, type FrozenRole, type PreparedChild } from "./roles";
import { protocolOfPayload, resolveProtocol, type ResolvedProtocol } from "./protocols/protocol";
import { packResolver } from "./packs";
import { personasByIds, studyResponses, updateStudy } from "./store";
import { reportStudyCompleted } from "../hub/telemetry";

/** Charge utile enregistrée pour chaque réponse du protocole concept + prix. */
export interface ConceptPricePayload extends Record<string, unknown> {
  answer: ConceptPriceAnswer;
  encounter: string;
  tiers: number[];
  priceShown: number;
  /** Incohérences détectées avant réparation. */
  initialAnomalies: string[];
  /** Protocole propre au projet, figé dans la réponse (absent : protocole historique). */
  protocol?: ResolvedProtocol;
  /** Recatégorisations a posteriori des objections (`study:recode`), par taxonomie ; l'original n'est pas modifié. */
  recoded?: Record<string, { codes: string[]; at: string; model: string }>;
  /** Groupe de la persona dans l'étude (cible, témoin). */
  group?: string;
  /** Réponse d'origine, si la réparation l'a remplacée. */
  originalAnswer?: ConceptPriceAnswer;
  /** Version du protocole, figée dans la réponse (v3 et v4 seulement ; absente : v2). */
  protocolVersion?: "3" | "4";
  /** Ton du pitch montré (score lexical, v3 et v4 seulement), pour l'indice de confiance. */
  pitchTone?: { score: number; threshold: number; neutralized: boolean };
  /** Multi-rôles (phase 7) : rôle de la persona, figé ; absent pour un projet sans rôles. */
  role?: FrozenRole;
  /** Rôle `payer_for_child` : enfant pour qui la persona a répondu. */
  child?: { index: number; age: number; sex: "M" | "F"; modules: ModuleValues; lines: string[]; outsideFilter?: true };
}

interface RoleSetup {
  frozen: FrozenRole;
  view: Project;
  tiers: number[];
  system: string;
  schema: ReturnType<typeof roleAnswerSchema>;
  ctx: CoherenceContext;
  pitchTone: { score: number; threshold: number; neutralized: boolean } | null;
  child: PreparedChild | null;
}

/** Message d'erreur d'un quota atteint (abonnement Max, ou HTTP 429). */
const USAGE_LIMIT_RE =
  /usage limit|limit reached|hit your (usage )?limit|rate[ _-]?limit|out of (extra )?usage|quota|resets? (at |à )?\d|\b429\b/i;

export function isUsageLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return USAGE_LIMIT_RE.test(msg);
}

export interface RunOptions {
  log?: (message: string) => void;
  /** Par défaut : la concurrence du backend. */
  concurrency?: number;
  /** Arrêt de l'étude après N échecs consécutifs (tunnel coupé, CLI déconnectée…). */
  maxConsecutiveFailures?: number;
  temperature?: number;
  maxTokens?: number;
}

export interface RunResult {
  total: number;
  alreadyDone: number;
  written: number;
  failed: Array<{ personaId: string; error: string }>;
  stoppedForUsageLimit: string | null;
  /** Plafond de dépense atteint (BudgetGuard) : l'étude est en pause, reprise après relèvement du plafond. */
  stoppedForBudget: string | null;
  aborted: string | null;
  usage: Usage;
  durationMs: number;
}

/**
 * Modules de la population d'une persona dans l'étude (`populations[].eligibility.modules`, sans version).
 * `undefined` pour une étude sans population ciblée (v1) : la fiche reste inchangée.
 * Liste vide (témoin sans module) : la fiche n'affiche aucune ligne de module.
 */
export function studyModulesFor(study: Pick<Study, "populations" | "personaGroups">, personaId: string): string[] | undefined {
  const group = study.personaGroups[personaId] ?? "target";
  const pop = study.populations.find((x) => x.group === group) as { eligibility?: { modules?: string[] } } | undefined;
  const mods = pop?.eligibility?.modules;
  return mods ? mods.map((m) => m.split("@")[0]!) : undefined;
}

export async function runStudy(db: Db, engine: Engine, pack: Pack, study: Study, opts: RunOptions = {}): Promise<RunResult> {
  const log = opts.log ?? (() => {});
  const project = getProject(db, study.projectId);
  if (!project) throw new Error(`Projet introuvable : ${study.projectId}`);
  if (study.backend !== engine.backend.name) {
    throw new Error(`L'étude a été créée pour ${study.backend}, pas pour ${engine.backend.name}.`);
  }

  const existing = studyResponses(db, study.id, QUESTION_KEY);
  const done = new Set(existing.map((r) => r.personaId));
  // Protocole du projet (lot P1) : il doit être celui des réponses déjà obtenues
  const proto = resolveProtocol(project);
  const previous = existing.length ? protocolOfPayload(existing[0]!.payload as { protocol?: ResolvedProtocol }) : null;
  if (previous && previous.signature !== proto.signature && done.size < study.personaIds.length) {
    throw new Error(
      `Le protocole du projet a changé depuis le début de l'étude ${study.id} (échelle ou taxonomie) : reprendre mélangerait deux protocoles. Créer une nouvelle étude.`,
    );
  }
  // Personas relues au lancement : un récit écrit depuis la création de l'étude est utilisé.
  const todo = personasByIds(db, study.personaIds.filter((id) => !done.has(id)));
  const result: RunResult = {
    total: study.personaIds.length,
    alreadyDone: done.size,
    written: 0,
    failed: [],
    stoppedForUsageLimit: null,
    stoppedForBudget: null,
    aborted: null,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
    durationMs: 0,
  };
  const started = performance.now();
  updateStudy(db, study.id, {
    status: "running",
    error: null,
    progressTotal: study.personaIds.length,
    progressDone: done.size,
    ...(study.startedAt ? {} : { startedAt: new Date().toISOString() }),
  });
  if (!todo.length) {
    updateStudy(db, study.id, { status: "completed", completedAt: study.completedAt ?? new Date().toISOString() });
    return result;
  }

  const packOf = packResolver(pack);
  // Version enregistrée dans l'étude : une étude v2 (ou v1) garde le prompt, le schéma et les contrôles v2.
  const version = protocolVersionOf(study.protocolVersion);
  const baseTiers = studyTiers(project, version);
  const tiers = baseTiers;
  // Public de l'étude (langue, pays, devise des personas) : celui du socle ; France = prompts historiques.
  const audience = studyAudience(study);
  const baseSystem = buildSystemPrompt(project, tiers, version, audience);
  const baseSchema = answerSchemaFor(tiers, proto, version);
  const baseCtx = { ...coherenceContext(project, tiers, audience), ...(proto.custom && { protocol: proto }), ...(hasV3Measures(version) && { version }) };
  const tone = hasV3Measures(version) ? toneWarning(project.pitch, undefined, audience.locale) : null;
  const pitchTone = tone && { score: tone.score, threshold: tone.threshold, neutralized: (project.extra as { pitchNeutralized?: boolean }).pitchNeutralized === true };

  // Multi-rôles (phase 7) : prompt, schéma, paliers et contrôles propres au rôle du groupe de la persona.
  // Un projet sans rôles garde exactement le prompt, le schéma et les contrôles ci-dessus.
  const roles = projectRoles(project);
  const setups = new Map<string, RoleSetup>();
  const setupFor = (group: string | undefined): RoleSetup | null => {
    const role = group ? roles.find((r) => r.id === group) : undefined;
    if (!role) return null;
    let st = setups.get(role.id);
    if (!st) {
      const view = roleProject(project, role);
      const rp = rolePrompt(role, roles);
      const rTiers = studyTiers(view, version);
      const rTone = hasV3Measures(version) ? toneWarning(view.pitch, undefined, audience.locale) : null;
      st = {
        frozen: freezeRole(role),
        view,
        tiers: rp.pricing ? rTiers : [],
        system: buildRoleSystemPrompt(view, rTiers, version, rp, audience),
        schema: roleAnswerSchema(rTiers, proto, version, rp),
        ctx: { ...coherenceContext(view, rTiers, audience), ...(proto.custom && { protocol: proto }), ...(hasV3Measures(version) && { version }), ...(!rp.pricing && { noPricing: true }) },
        pitchTone: rTone && { score: rTone.score, threshold: rTone.threshold, neutralized: (project.extra as { pitchNeutralized?: boolean }).pitchNeutralized === true },
        child: role.child ? prepareChild(role.child, resolveSoclePack(role.target.socle ?? "fr").socle) : null,
      };
      setups.set(role.id, st);
    }
    return st;
  };
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? engine.backend.concurrency, engine.backend.concurrency));
  const maxFails = opts.maxConsecutiveFailures ?? 5;
  let consecutiveFails = 0;
  let stop = false;
  let progress = done.size;
  const queue = [...todo];
  let engineExtra = study.extra as StudyExtra | undefined;
  let reportedSaved = false;

  const callOpts = {
    ...(opts.temperature !== undefined && { temperature: opts.temperature }),
    maxTokens: opts.maxTokens ?? 2_000,
  };

  const handle = async (p: Persona) => {
    const t0 = performance.now();
    const encounter = pickEncounter(p, study.seed);
    const modules = studyModulesFor(study, p.id);
    const setup = setupFor(study.personaGroups[p.id]);
    // payer_for_child : enfant du foyer tiré pour l'étude ; hors filtre enfant si le récit a changé son sexe (signalé)
    const child = setup?.child ? (pickChild(p, setup.child, study.seed) ?? pickChild(p, { ...setup.child, filter: null }, study.seed)) : null;
    if (setup?.child && !child) throw new Error(`Persona ${p.id} : aucun enfant dans la tranche d'âge du rôle ${setup.frozen.id}.`);
    const childInFilter = child && setup?.child ? pickChild(p, setup.child, study.seed) !== null : true;
    // v4 : lignes de module (persona et enfant) dans le bloc délimité ; v2 et v3 : prompt historique, inchangé
    const block = usesAttributeBlock(version) ? { attributeBlock: audience.locale } : {};
    const user = buildUserPrompt(packOf(p), p, setup?.view ?? project, encounter, {
      ...(modules && { modules }),
      ...(child && { child: childBlock(child, block) }),
      ...(usesAttributeBlock(version) && { version }),
    });
    const system = setup?.system ?? baseSystem;
    // Rôle sans prix : réponse sans vanWestendorp, gaborGranger ni budgetFit (le résumé et les contrôles le savent)
    const schema = (setup?.schema ?? baseSchema) as typeof baseSchema;
    const ctx = setup?.ctx ?? baseCtx;
    const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
    const first = await engine.complete({ system, messages: [{ role: "user", content: user }], schema, ...callOpts });
    addUsage(usage, first.usage);
    let attempts = first.attempts;
    let answer = first.data;
    let text = first.text;
    let model = first.model;
    const pctx = { ...ctx, budgetEur: p.monthlyDiscretionaryBudgetEur };
    const check = (a: ConceptPriceAnswer) => {
      const facts = checkFacts(a, p, audience.locale);
      const coherence = checkCoherence(a, pctx);
      return {
        codes: [...coherence, ...new Set(facts.map((f) => f.code))],
        details: [...priceIssueDetails(coherence, pctx, audience), ...facts.map((f) => f.detail)],
      };
    };
    const first0 = check(answer);
    const initial = first0.codes;
    let issues = initial;
    let original: ConceptPriceAnswer | undefined;
    let budgetHit: unknown = null;
    if (initial.length) {
      try {
        const second = await engine.complete({
          system,
          messages: [
            { role: "user", content: user },
            { role: "assistant", content: JSON.stringify(answer) },
            { role: "user", content: buildRepairPrompt(initial, first0.details, audience) },
          ],
          schema,
          ...callOpts,
        });
        addUsage(usage, second.usage);
        attempts += second.attempts;
        const after = check(second.data).codes;
        if (after.length <= initial.length) {
          original = answer;
          answer = second.data;
          text = second.text;
          model = second.model;
          issues = after;
        }
      } catch (err) {
        if (isUsageLimitError(err)) throw err;
        // Plafond atteint pendant la réparation : on garde la première réponse (déjà payée), puis on s'arrête
        if (isBudgetExceeded(err)) budgetHit = err;
        // Réparation impossible : on garde la première réponse, anomalies marquées.
      }
    }
    const payload: ConceptPricePayload = {
      answer,
      encounter: encounter.id,
      tiers: setup?.tiers ?? baseTiers,
      priceShown: ctx.projectPrice,
      initialAnomalies: initial,
      ...(proto.custom && { protocol: proto }),
      ...(study.personaGroups[p.id] && { group: study.personaGroups[p.id] }),
      ...(original && { originalAnswer: original }),
      ...(hasV3Measures(version) && { protocolVersion: version, ...((setup ? setup.pitchTone : pitchTone) && { pitchTone: (setup ? setup.pitchTone : pitchTone)! }) }),
      ...(setup && { role: setup.frozen }),
      ...(child && { child: { index: child.index, age: child.age, sex: child.sex, modules: child.modules, lines: child.lines, ...(!childInFilter && { outsideFilter: true as const }) } }),
    };
    const durationMs = Math.round(performance.now() - t0);
    db.insert(responses)
      .values({
        studyId: study.id,
        personaId: p.id,
        questionKey: QUESTION_KEY,
        payload,
        rawText: text,
        backend: engine.backend.name,
        model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens ?? 0,
        costUsd: usage.costUsd ?? null,
        durationMs,
        attempts,
        narrativeUsed: Boolean(p.narrative?.trim()),
        repaired: initial.length > 0,
        anomalies: issues,
      })
      .onConflictDoNothing()
      .run();
    // Modèle exact rapporté par l'API, figé dans l'étude à la première réponse (études avec moteur enregistré)
    if (!reportedSaved && engineExtra?.engine && !engineExtra.engine.reportedModel && model) {
      reportedSaved = true;
      engineExtra = { ...engineExtra, engine: { ...engineExtra.engine, reportedModel: model } };
      updateStudy(db, study.id, { extra: engineExtra });
    }
    addUsage(result.usage, usage);
    result.written++;
    progress++;
    updateStudy(db, study.id, { progressDone: progress });
    log(
      `[${progress}/${result.total}] ${p.firstName ?? "?"}, ${p.age} ans (${p.id}) → ${answer.behavior}` +
        `${issues.length ? ` ⚠ ${issues.join(",")}` : initial.length ? " (réparée)" : ""}` +
        ` — ${(durationMs / 1000).toFixed(1)} s, ${usage.inputTokens}/${usage.outputTokens} tokens`,
    );
    if (budgetHit) throw budgetHit;
  };

  const worker = async () => {
    while (!stop) {
      const p = queue.shift();
      if (!p) return;
      try {
        await handle(p);
        consecutiveFails = 0;
      } catch (err) {
        const msg = (err as Error).message;
        if (isBudgetExceeded(err)) {
          stop = true;
          result.stoppedForBudget = msg;
          return;
        }
        if (isUsageLimitError(err)) {
          stop = true;
          result.stoppedForUsageLimit = msg;
          return;
        }
        result.failed.push({ personaId: p.id, error: msg });
        log(`[échec] ${p.id} : ${msg.slice(0, 300)}`);
        if (++consecutiveFails >= maxFails) {
          stop = true;
          result.aborted = `${consecutiveFails} échecs consécutifs, dernier : ${msg.slice(0, 300)}`;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));

  result.durationMs = Math.round(performance.now() - started);
  const remaining = result.total - progress;
  if (remaining === 0) {
    const completedAt = new Date().toISOString();
    updateStudy(db, study.id, { status: "completed", completedAt, error: null });
    // Télémétrie opt-in (désactivée par défaut) : agrégats seulement, jamais de texte du projet (src/hub/telemetry.ts)
    await reportStudyCompleted({ ...study, completedAt });
  } else if (result.stoppedForBudget) {
    updateStudy(db, study.id, { status: "paused", error: result.stoppedForBudget.slice(0, 500) });
  } else if (result.stoppedForUsageLimit) {
    updateStudy(db, study.id, { status: "paused", error: `Quota atteint : ${result.stoppedForUsageLimit.slice(0, 500)}` });
  } else if (result.aborted) {
    updateStudy(db, study.id, { status: "failed", error: result.aborted });
  } else {
    updateStudy(db, study.id, { status: "paused", error: `${remaining} réponse(s) manquante(s) après échec : relancer study:run.` });
  }
  return result;
}

function addUsage(total: Usage, add: Usage): void {
  total.inputTokens += add.inputTokens;
  total.outputTokens += add.outputTokens;
  total.cacheReadTokens = (total.cacheReadTokens ?? 0) + (add.cacheReadTokens ?? 0);
  if (add.costUsd !== undefined) total.costUsd = (total.costUsd ?? 0) + add.costUsd;
}

