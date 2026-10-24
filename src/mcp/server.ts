import { existsSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { cliCommand } from "../hints";
import type { AppConfig } from "../config";
import type { Db } from "../db/client";
import type { Project } from "../db/schema";
import type { Engine } from "../engine/engine";
import { isLegacy, moduleLibrary, type LoadedModule } from "../modules/registry";
import type { Pack } from "../personas/pack";
import { previewTarget, type ProjectInput, type TargetPreview } from "../population/preview";
import { suggestionDocument, suggestTarget, writeSuggestion } from "../population/suggest";
import { compareSummaries } from "../studies/compare";
import { PROTOCOL_VERSION } from "../studies/protocols/concept-price";
import { toneWarning } from "../studies/pitch-tone";
import { formatProjectPrice } from "../studies/price-model";
import { createProject, getProject, listProjects, projectFileSchema, slugify, type ProjectExtra } from "../studies/project";
import { recommendationPath, recommendStudy } from "../studies/recommend";
import { findStudy, listStudies } from "../studies/store";
import { createStudy, rolePopulations, type CreateStudyInput, type PopulationInput } from "../studies/study";
import type { StudySummary } from "../studies/summary";
import { lastResponseAt, responseCount, studySummary } from "../web/adapters";
import { AlreadyRunningError, type Launcher } from "../web/launcher";
import { dryRun, estimateCost, estimateExistingStudy, missingNarratives, type CostEstimate } from "./estimate";
import { assistantCallsCost, costNoteOf, socleOfPack } from "../studies/cost";
import { chooseProfile, engineInfoOf, guardedEngine, profileForStudy, studyEngineInfo } from "../engine/select";
import type { EngineProfile } from "../engine/profiles";

/**
 * Serveur MCP local (plateforme.md § 8.4) : expose les fonctions du domaine aux agents (Claude Code,
 * Claude Desktop…). Lecture libre ; les opérations à coût (ou qui écrivent) exigent `confirm: true` et
 * renvoient sinon un aperçu avec l'estimation des appels LLM. Les décisions réservées à l'utilisateur
 * (accepter un module, appliquer une neutralisation de pitch, supprimer) ne sont pas exposées.
 */

export interface McpContext {
  db: Db;
  pack: Pack;
  config: AppConfig;
  launcher: Launcher;
  /** Dossier des données (celui de la base) : suggestions, recommandations. */
  dataDir: string;
  /** Moteur de l'assistant de cible et des recommandations (défaut : profil actif ; tests : moteur simulé). */
  engine?: () => Engine;
  /** Profil de moteur imposé (sinon `PERSONAS_PROFILE`, le profil actif, puis claude-cli). */
  profile?: string;
  /** Bibliothèque de modules (défaut : modules/ du dépôt). */
  library?: () => Map<string, LoadedModule>;
}

export const SERVER_NAME = "personas";
export const SERVER_VERSION = "1.0.0";

/** Positionnement rappelé dans les descriptions : ce que l'outil mesure de façon fiable, et ce qui reste indicatif. */
export const POSITIONING =
  "Personas simulates synthetic personas: it is a bad-idea filter and an objection generator, not an oracle. " +
  "Reliable: objections, segments, and differences between variants tested on the same sample. " +
  "Indicative only: absolute levels (trial, payment rates); always read them with the confidence index.";

const CONFIRM_NOTE =
  "Costly or writing operation: without `confirm: true` it only returns a preview (planned LLM calls). " +
  "Show the preview to the user and call again with `confirm: true` only after the user agrees.";

export const INSTRUCTIONS = [
  POSITIONING,
  CONFIRM_NOTE,
  "Not exposed on purpose (decisions reserved to the user, in the dashboard or the CLI): accepting a module draft, applying a pitch neutralisation, deleting anything.",
  "Protocols v3 and v4 refuse a pitch whose commercial-tone score exceeds the threshold (25); there is no override through MCP.",
  "Typical flow: list_projects → get_project → preview_target → create_study (preview, then confirm) → run_study (confirm) → study_status (poll) → study_summary → compare_studies / recommend.",
].join("\n\n");

const BACKENDS = ["claude-cli", "ollama"] as const;

/** Appels prévus et coût réel estimé (docs/plateforme.md § 7.3). */
function plannedOf(e: CostEstimate) {
  return {
    responses: e.calls.responses,
    repairs: e.calls.repairs,
    narratives: e.calls.narratives,
    ...(e.calls.triage && { triage: e.calls.triage }),
    total: e.calls.total,
    estimatedCost: e.cost.usd,
    costRange: e.cost.low !== null && e.cost.high !== null ? [e.cost.low, e.cost.high] : null,
    costKind: e.cost.kind,
    costNote: costNoteOf(e.cost.kind, e.cost.low, e.cost.high),
    currency: "USD",
    durationMinutes: e.durationMinutes,
    engine: { profile: e.profile, provider: e.provider, model: e.model },
    ...(e.limits.perStudyUsd !== undefined && { capPerStudyUsd: e.limits.perStudyUsd, exceedsStudyCap: e.exceedsStudyCap }),
    ...(e.requiresConfirmation && { requiresConfirmation: true }),
  };
}

/** Appels d'un assistant (ordre de grandeur du coût sur le profil). */
function assistantPlanned(profile: EngineProfile, expected: number, max: number) {
  const c = assistantCallsCost(profile, expected);
  return { expected, max, engine: `${profile.name} (${profile.provider} / ${profile.model})`, estimatedCost: c.usd, costKind: c.kind, costNote: costNoteOf(c.kind, c.usd === null ? null : c.usd * 0.7, c.usd === null ? null : c.usd * 1.3 * (max / Math.max(1, expected))), currency: "USD" };
}

// ─── Résultats ────────────────────────────────────────────────────────────────

function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string, extra: Record<string, unknown> = {}): CallToolResult {
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: message, ...extra }, null, 2) }] };
}

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Refus du garde-fou de ton (createStudy, protocoles v3 et v4) : message explicite, sans `--force` possible ici. */
function isToneRefusal(message: string): boolean {
  return /^Pitch (au ton commercial|with a commercial tone)/.test(message);
}

/**
 * Le message de createStudy est pensé pour la CLI (français, `--force`, `npm run`) : le MCP renvoie le sien, en
 * anglais, sans contournement et avec la commande du mode courant (`personas …` hors du dépôt).
 */
function toneRefusal(_message: string, project: Project | undefined): CallToolResult {
  const tone = project ? toneWarning(project.pitch) : null;
  const id = project?.id ?? "<id>";
  return fail(
    `Pitch with a commercial tone${tone ? ` (score ${tone.score}/100, threshold ${tone.threshold})` : ""}: protocol v4 (like v3) requires a neutral pitch. Study not created.`,
    {
      reason: "pitch_tone",
      ...(tone && { tone: { score: tone.score, threshold: tone.threshold, markers: tone.markers } }),
      howToFix:
        "There is no override through MCP. Ask the user to neutralise the pitch from the dashboard (project page) or the CLI " +
        `(\`${cliCommand("project:neutralize-pitch", `--project ${id}`)}\`) and validate it; this decision is theirs.`,
    },
  );
}

async function guarded(fn: () => CallToolResult | Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    return fail(errMsg(err));
  }
}

// ─── Vues ─────────────────────────────────────────────────────────────────────

function studyState(ctx: McpContext, studyId: string) {
  const s = findStudy(ctx.db, studyId);
  const done = responseCount(ctx.db, s.id);
  const run = ctx.launcher.info(s.id);
  const interrupted = s.status === "running" && run !== null && !run.alive && done < s.personaIds.length;
  const groups: Record<string, number> = {};
  for (const id of s.personaIds) {
    const g = s.personaGroups?.[id] ?? "target";
    groups[g] = (groups[g] ?? 0) + 1;
  }
  const missing = missingNarratives(ctx.db, s.personaIds);
  return {
    id: s.id,
    projectId: s.projectId,
    name: s.name,
    status: interrupted ? "interrupted" : s.status,
    protocolVersion: s.protocolVersion,
    backend: s.backend,
    model: s.model,
    ...(studyEngineInfo(s) && { engine: studyEngineInfo(s) }),
    seed: s.seed,
    responses: done,
    total: s.personaIds.length,
    complete: done >= s.personaIds.length,
    groupSizes: groups,
    narratives: { written: s.personaIds.length - missing, missing },
    lastResponseAt: lastResponseAt(ctx.db, s.id),
    run: run && { pid: run.pid, alive: run.alive, startedAt: run.startedAt, logPath: run.logPath },
    error: s.error,
    createdAt: s.createdAt,
    startedAt: s.startedAt,
    completedAt: s.completedAt,
  };
}

function projectView(ctx: McpContext, p: Project) {
  const extra = p.extra as ProjectExtra;
  const tone = toneWarning(p.pitch);
  const studies = listStudies(ctx.db).filter((s) => s.projectId === p.id);
  return {
    id: p.id,
    name: p.name,
    pitch: p.pitch,
    targetAudience: p.targetAudience,
    businessModel: p.businessModel,
    price: formatProjectPrice(p),
    freeOffer: p.freeOffer,
    competitors: p.competitors,
    alternatives: p.alternatives,
    ...(extra.priceTiers && { priceTiers: extra.priceTiers }),
    ...(extra.pricing && { pricing: extra.pricing }),
    ...(extra.target && { target: extra.target }),
    ...(extra.control && { control: extra.control }),
    ...(extra.roles && { roles: extra.roles }),
    ...(extra.protocol && { protocol: extra.protocol }),
    pitchTone: { score: tone.score, threshold: tone.threshold, warn: tone.warn, markers: tone.markers, neutralized: extra.pitchNeutralized === true },
    studies: studies.map((s) => ({
      id: s.id,
      name: s.name,
      status: s.status,
      protocolVersion: s.protocolVersion,
      backend: s.backend,
      model: s.model,
      sampleSize: s.sampleSize,
      responses: responseCount(ctx.db, s.id),
      createdAt: s.createdAt,
    })),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

/** Résumé structuré et compact (sans segments ni verbatims complets) ; `full` renvoie le résumé brut. */
function compactSummary(s: StudySummary, verbatims: number) {
  const analysisView = (a: StudySummary["overall"]) => ({
    n: a.n,
    behaviors: a.behaviors.overall.shares,
    freeSignupOrMore: a.behaviors.freeSignupOrMore,
    payers: a.behaviors.payers,
    ...(a.behaviors.levels && { levels: a.behaviors.levels.shares }),
    notConcernedShare: a.relevance.notConcernedShare,
    objections: {
      shares: a.objections.overall.shares,
      ...(a.objections.canonical && { canonical: a.objections.canonical.shares }),
      perRespondent: a.objections.perRespondent,
      examples: Object.fromEntries(Object.entries(a.objections.examples).map(([k, v]) => [k, v.slice(0, 2).map((e) => e.detail)])),
    },
    forwardShare: a.forward.share,
    vanWestendorp: { n: a.vanWestendorp.n, pmc: a.vanWestendorp.pmc, opp: a.vanWestendorp.opp, ipp: a.vanWestendorp.ipp, pme: a.vanWestendorp.pme, neverPayShare: a.vanWestendorp.neverPayShare },
    gaborGranger: a.gaborGranger,
    ...(a.payment && { payment: a.payment }),
    ...(a.needFrequency && { needFrequency: a.needFrequency }),
    anomalies: { rate: a.anomalies.rate, repairedRate: a.anomalies.repairedRate },
    verbatims: a.verbatims.slice(0, verbatims).map((v) => ({ who: v.who, behavior: v.behavior, text: v.text })),
  });
  return {
    positioning: POSITIONING,
    study: s.study,
    model: { backend: s.study.backend, model: s.study.model, ...(s.study.engine && { engine: s.study.engine }), protocolVersion: s.protocolVersion ?? null },
    project: { id: s.project.id, name: s.project.name, price: s.project.price, ...(s.project.referencePrice && { referencePrice: s.project.referencePrice }) },
    confidence: s.confidence ?? null,
    methodNote: s.methodNote,
    ...(s.eligibility && { eligibility: s.eligibility }),
    ...(s.payment && { payment: s.payment }),
    ...(s.needFrequency && { needFrequency: s.needFrequency }),
    ...(s.drivers && {
      drivers: s.drivers.outcomes.map((o) => ({ level: o.level, label: o.label, rate: o.rate, factors: o.factors.slice(0, 3).map((f) => f.sentence), ...(o.note && { note: o.note }) })),
    }),
    overall: analysisView(s.overall),
    groups: s.groups.map((g) => ({ group: g.group, label: g.label, analysis: analysisView(g.analysis) })),
    ...(s.crossRoles && { crossRoles: s.crossRoles }),
  };
}

function trimPreview(p: TargetPreview) {
  const { triage, ...rest } = p;
  return {
    ...rest,
    ...(triage && {
      triage: {
        model: triage.model,
        n: triage.n,
        share: triage.share,
        ci: triage.ci,
        alert: triage.alert,
        message: triage.message,
        profiles: triage.profiles.slice(0, 5),
        calls: triage.calls,
        cachedCalls: triage.cachedCalls,
      },
    }),
  };
}

function summaryOf(ctx: McpContext, studyId: string): StudySummary {
  const study = findStudy(ctx.db, studyId);
  const project = getProject(ctx.db, study.projectId);
  if (!project) throw new Error(`Projet introuvable : ${study.projectId}`);
  const s = studySummary(ctx.db, ctx.pack, study, project);
  if (!s) throw new Error(`Aucune réponse pour l'étude ${study.id}.`);
  return s;
}

// ─── Études : populations comme la CLI (study:create) ─────────────────────────

interface StudyArgs {
  projectId: string;
  n?: number | undefined;
  controlN?: number | undefined;
  roleN?: Record<string, number> | undefined;
  seed?: number | undefined;
  backend?: (typeof BACKENDS)[number] | undefined;
  profile?: string | undefined;
  model?: string | undefined;
  sameSampleAs?: string | undefined;
  sameSampleGroup?: string | undefined;
  name?: string | undefined;
}

function studyInput(ctx: McpContext, project: Project, a: StudyArgs): CreateStudyInput {
  const targeting = project.extra as ProjectExtra;
  // Moteur : backend historique (claude-cli, ollama) ou profil (option, PERSONAS_PROFILE, profil actif, puis claude-cli)
  const profile = chooseProfile(ctx.config, { backend: a.backend, profile: a.profile ?? ctx.profile, model: a.model });
  const backend = profile.provider;
  const model = profile.model;
  const useRoles = !!targeting.roles?.length && !a.sameSampleAs;
  const useTargeting = !useRoles && !!targeting.target && !a.sameSampleAs;
  if (!useRoles && !useTargeting && !a.n && !a.sameSampleAs) throw new Error("Taille d'échantillon requise (n) : le projet ne déclare ni cible ni rôles.");
  let populations: PopulationInput[] | undefined;
  if (useRoles) populations = rolePopulations(project, a.n ? Object.fromEntries(targeting.roles!.map((r) => [r.id, a.n!])) : (a.roleN ?? {}));
  else if (useTargeting) {
    populations = [
      { group: "target", n: a.n ?? targeting.target!.n ?? NaN, target: targeting.target! },
      ...(targeting.control ? [{ group: "control", n: a.controlN ?? targeting.control.n ?? NaN, target: targeting.control }] : []),
    ];
  }
  if (populations?.some((p) => !Number.isInteger(p.n) || p.n < 1)) throw new Error("Effectif requis pour chaque population (n, controlN ou roleN, sinon `n` du bloc du projet).");
  return {
    projectId: project.id,
    ...(populations && { populations }),
    ...(a.n && !useTargeting && !useRoles && { n: a.n }),
    seed: a.seed ?? 7,
    backend,
    model,
    engine: engineInfoOf(profile),
    ...(a.sameSampleAs && { sameSampleAs: a.sameSampleAs }),
    ...(a.sameSampleGroup && { sameSampleGroup: a.sameSampleGroup }),
    ...(a.name && { name: a.name }),
    // Protocole par défaut (v4) seulement, et jamais de `force` : le garde-fou de ton s'applique sans contournement.
    protocolVersion: PROTOCOL_VERSION,
    force: false,
  };
}

// ─── Modules ──────────────────────────────────────────────────────────────────

const fold = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

function moduleView(m: LoadedModule) {
  const d = m.def;
  return {
    id: d.id,
    version: d.version,
    label: d.label,
    ...(d.description && { description: d.description }),
    status: d.status,
    appliesTo: d.applies_to,
    requires: d.requires,
    attributes: d.attributes.map((a) => ({ key: a.key, label: a.label, type: (a as { type?: string }).type ?? null })),
  };
}

/** Recherche texte simple : chaque mot de la requête trouvé compte (id et libellé pèsent plus). */
export function searchModules(lib: Map<string, LoadedModule>, query: string, includeLegacy = false) {
  const words = fold(query).split(/[^a-z0-9]+/).filter((w) => w.length >= 2);
  if (!words.length) return [];
  const out: Array<{ score: number; module: ReturnType<typeof moduleView> }> = [];
  for (const m of lib.values()) {
    if (!includeLegacy && isLegacy(m)) continue;
    const d = m.def;
    const strong = fold(`${d.id} ${d.label} ${d.short_label ?? ""}`);
    const weak = fold(`${d.description ?? ""} ${d.attributes.map((a) => `${a.key} ${a.label} ${(a as { description?: string }).description ?? ""}`).join(" ")}`);
    let score = 0;
    for (const w of words) score += (strong.includes(w) ? 3 : 0) + (weak.includes(w) ? 1 : 0);
    if (score > 0) out.push({ score, module: moduleView(m) });
  }
  return out.sort((a, b) => b.score - a.score || a.module.id.localeCompare(b.module.id));
}

// ─── Serveur ──────────────────────────────────────────────────────────────────

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const COSTLY = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

const confirmArg = z.boolean().optional().describe("Must be true to actually perform the operation. Omit it first to get a preview with the planned LLM calls.");

export const TOOL_NAMES = [
  "list_projects",
  "get_project",
  "preview_target",
  "study_status",
  "study_summary",
  "compare_studies",
  "list_modules",
  "search_modules",
  "create_project",
  "suggest_target",
  "create_study",
  "run_study",
  "recommend",
] as const;

export function createMcpServer(ctx: McpContext): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  // Chargé à la demande : la lecture ne dépend pas du moteur.
  const activeProfile = () => chooseProfile(ctx.config, { profile: ctx.profile });
  const engine = async (): Promise<Engine> => (ctx.engine ? ctx.engine() : guardedEngine(ctx.db, activeProfile(), ctx.config));
  const library = () => (ctx.library ? ctx.library() : moduleLibrary());

  // ─── Lecture ────────────────────────────────────────────────────────────────

  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description: "List the Personas projects (offers to test) with their price and number of studies. Read-only, no LLM call.",
      inputSchema: {},
      annotations: READ,
    },
    () =>
      guarded(() => {
        const studies = listStudies(ctx.db);
        return ok(
          listProjects(ctx.db).map((p) => ({
            id: p.id,
            name: p.name,
            price: formatProjectPrice(p),
            hasTarget: Boolean((p.extra as ProjectExtra).target),
            hasRoles: Boolean((p.extra as ProjectExtra).roles?.length),
            studyCount: studies.filter((s) => s.projectId === p.id).length,
            createdAt: p.createdAt,
          })),
        );
      }),
  );

  server.registerTool(
    "get_project",
    {
      title: "Get a project",
      description:
        "Full description of a project: pitch, price, competitors and alternatives, target/control or roles, project protocol, " +
        "commercial-tone score of the pitch (protocol v4 refuses a score above the threshold), and its studies with progress. Read-only, no LLM call.",
      inputSchema: { projectId: z.string().describe("Project id (see list_projects).") },
      annotations: READ,
    },
    ({ projectId }) =>
      guarded(() => {
        const p = getProject(ctx.db, projectId);
        if (!p) return fail(`Projet introuvable : ${projectId}`);
        return ok(projectView(ctx, p));
      }),
  );

  server.registerTool(
    "preview_target",
    {
      title: "Preview a target population",
      description:
        "Preview a project's target (or control) population before a study: eligibility rate with its 95% CI, distributions of key attributes, " +
        "and sample persona cards as the protocol will see them. Local statistical draw, no LLM call and nothing written. " +
        "Optional `triage: true` adds a relevance pre-sort by the local Ollama model (2 calls per persona, cached): it then requires `confirm: true`.",
      inputSchema: {
        projectId: z.string().optional().describe("Saved project id. Give either projectId or project."),
        project: z.record(z.string(), z.unknown()).optional().describe("Unsaved project object (same schema as create_project) to preview before creating it."),
        group: z.string().optional().describe("Population block of the project: 'target' (default) or 'control'."),
        n: z.number().int().min(1).max(5000).optional().describe("Number of personas drawn (default: the block's n, else 200)."),
        seed: z.number().int().optional().describe("Draw seed (default 42; use the study's seed to see its personas)."),
        sample: z.number().int().min(0).max(20).optional().describe("Number of sample persona cards (default 5)."),
        triage: z.boolean().optional().describe("Add the local Ollama relevance pre-sort (LLM calls on the local model). Default false."),
        confirm: confirmArg,
      },
      annotations: READ,
    },
    (a) =>
      guarded(async () => {
        let input: ProjectInput;
        if (a.projectId) {
          const p = getProject(ctx.db, a.projectId);
          if (!p) return fail(`Projet introuvable : ${a.projectId}`);
          input = p;
        } else if (a.project) {
          const parsed = projectFileSchema.safeParse(a.project);
          if (!parsed.success) return fail("Projet invalide.", { issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
          input = a.project as ProjectInput;
        } else return fail("projectId ou project requis.");
        const opts = { ...(a.group && { group: a.group }), ...(a.n && { n: a.n }), ...(a.seed !== undefined && { seed: a.seed }), sample: a.sample ?? 5, library: library() };
        if (a.triage && !a.confirm) {
          const base = await previewTarget(input, opts);
          return ok({
            preview: true,
            message: "Triage not run: it calls the local Ollama model (2 calls per persona, cached). Call again with confirm: true to run it.",
            plannedLlmCalls: { triage: base.n * 2, engine: "ollama (local)", estimatedCost: 0, costKind: "local", costNote: costNoteOf("local", 0, 0) },
            result: trimPreview(base),
          });
        }
        return ok(trimPreview(await previewTarget(input, { ...opts, triage: Boolean(a.triage) })));
      }),
  );

  server.registerTool(
    "study_status",
    {
      title: "Study status",
      description:
        "Progress of a study: status (draft, running, completed, interrupted…), responses written over the sample size, narratives still missing, " +
        "and the background run process if one was launched. Poll it after run_study. Read-only, no LLM call.",
      inputSchema: { studyId: z.string().describe("Study id (or unique prefix).") },
      annotations: READ,
    },
    ({ studyId }) => guarded(() => ok(studyState(ctx, studyId))),
  );

  server.registerTool(
    "study_summary",
    {
      title: "Study summary",
      description:
        "Structured summary of a study: behaviours, relevance, objections with examples, Van Westendorp and Gabor-Granger, payment measures (M1 observed, M2 estimated), " +
        "need frequency, engagement drivers, per group (target / control / roles), plus the confidence index and the model used. " +
        POSITIONING +
        " Read-only, no LLM call (works on a partial study too).",
      inputSchema: {
        studyId: z.string().describe("Study id (or unique prefix)."),
        verbatims: z.number().int().min(0).max(30).optional().describe("Verbatims per analysis (default 5)."),
        full: z.boolean().optional().describe("Return the raw, complete summary (large: segments, all verbatims). Default false."),
      },
      annotations: READ,
    },
    ({ studyId, verbatims, full }) =>
      guarded(() => {
        const s = summaryOf(ctx, studyId);
        return ok(full ? { positioning: POSITIONING, ...s } : compactSummary(s, verbatims ?? 5));
      }),
  );

  server.registerTool(
    "compare_studies",
    {
      title: "Compare studies",
      description:
        "Compare several studies (variants of an offer: price, pitch, target); the first one is the reference and deltas are in points. " +
        "Differences between variants tested on the same sample are the most reliable signal; absolute levels stay indicative. Read-only, no LLM call.",
      inputSchema: {
        studyIds: z.array(z.string()).min(2).max(10).describe("Study ids; the first is the reference."),
        group: z.string().optional().describe("Group to compare (default: target, or the whole study)."),
        normalize: z.enum(["monthly-eur"]).optional().describe("Normalise prices to a monthly EUR equivalent across different price units."),
      },
      annotations: READ,
    },
    ({ studyIds, group, normalize }) =>
      guarded(() => {
        const summaries = studyIds.map((id) => summaryOf(ctx, id));
        return ok({ positioning: POSITIONING, ...compareSummaries(summaries, group, normalize ? { normalize } : {}) });
      }),
  );

  server.registerTool(
    "list_modules",
    {
      title: "List population modules",
      description:
        "List the thematic population modules of the local library (attributes drawn statistically on top of a country base: digital work, meetings, children…). " +
        "Use their ids in a project's target block. Read-only.",
      inputSchema: { includeLegacy: z.boolean().optional().describe("Include archived (legacy) modules. Default false.") },
      annotations: READ,
    },
    ({ includeLegacy }) => guarded(() => ok([...library().values()].filter((m) => includeLegacy || !isLegacy(m)).map(moduleView))),
  );

  server.registerTool(
    "search_modules",
    {
      title: "Search population modules",
      description: "Simple text search over the local module library (id, label, description, attributes), best matches first. Read-only.",
      inputSchema: {
        query: z.string().min(2).describe("Words to look for, e.g. 'freelance', 'réunions', 'enfants'."),
        includeLegacy: z.boolean().optional(),
        limit: z.number().int().min(1).max(50).optional().describe("Maximum results (default 10)."),
      },
      annotations: READ,
    },
    ({ query, includeLegacy, limit }) => guarded(() => ok(searchModules(library(), query, includeLegacy).slice(0, limit ?? 10))),
  );

  // ─── Écriture à coût (confirmation) ─────────────────────────────────────────

  server.registerTool(
    "create_project",
    {
      title: "Create a project",
      description:
        "Create a project from a project object validated by the Personas project schema (name, pitch as a real user would see it, price, competitors, " +
        "alternatives, optional target/control or roles, protocol). Keep the real constraints: the pitch should be factual (protocol v4 refuses a commercial tone above 25), " +
        "alternatives often free, no flattering wording. Pitch neutralisation fields are not accepted here (user decision). No LLM call. " +
        CONFIRM_NOTE,
      inputSchema: {
        project: z.record(z.string(), z.unknown()).describe("Project object (same format as the JSON/YAML project files in examples/)."),
        update: z.boolean().optional().describe("Replace an existing project with the same id. Default false."),
        confirm: confirmArg,
      },
      annotations: COSTLY,
    },
    ({ project, update, confirm }) =>
      guarded(() => {
        const parsed = projectFileSchema.safeParse(project);
        if (!parsed.success) return fail("Projet invalide.", { issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
        const file = parsed.data;
        if (file.pitchOriginal !== undefined || file.pitchNeutralized !== undefined) {
          return fail("pitchOriginal et pitchNeutralized ne sont pas acceptés via MCP : la neutralisation du pitch est validée par l'utilisateur (tableau de bord ou project:neutralize-pitch).");
        }
        const id = file.id ?? slugify(file.name);
        const existing = getProject(ctx.db, id);
        if (existing && !update) return fail(`Le projet « ${id} » existe déjà (update: true pour le remplacer).`);
        if (existing && (existing.extra as ProjectExtra).pitchNeutralized) {
          return fail(`Le projet « ${id} » porte une neutralisation de pitch validée par l'utilisateur : le remplacer via MCP la perdrait. Modifier le projet depuis le tableau de bord ou la CLI.`);
        }
        const tone = toneWarning(file.pitch);
        const toneView = { score: tone.score, threshold: tone.threshold, warn: tone.warn, markers: tone.markers };
        if (!confirm) {
          return ok({
            preview: true,
            id,
            action: existing ? "update" : "create",
            name: file.name,
            pitchTone: toneView,
            ...(tone.warn && { warning: "Commercial tone above the threshold: create_study (protocol v4) will refuse this pitch until it is neutralised by the user." }),
            plannedLlmCalls: { total: 0, estimatedCost: 0, costNote: "no LLM call" },
            next: "Call again with confirm: true to save the project.",
          });
        }
        const p = createProject(ctx.db, file, { update: Boolean(update) });
        return ok({ created: !existing, updated: Boolean(existing), project: projectView(ctx, p) });
      }),
  );

  server.registerTool(
    "suggest_target",
    {
      title: "Suggest a target population",
      description:
        "Target assistant: Claude (claude-cli, no tools) proposes the attributes that condition usage, eligibility-filter variants, quotas and missing modules; " +
        "each valid variant is previewed locally. Nothing is applied to the project: the proposal is written to data/suggestions/ for the user to review. " +
        "About 1 LLM call (up to 4 with repairs). " +
        CONFIRM_NOTE,
      inputSchema: {
        projectId: z.string().optional().describe("Saved project id. Give either projectId or project."),
        project: z.record(z.string(), z.unknown()).optional().describe("Unsaved project object."),
        n: z.number().int().min(10).max(2000).optional().describe("Size of each variant preview (default 200)."),
        seed: z.number().int().optional(),
        confirm: confirmArg,
      },
      annotations: COSTLY,
    },
    (a) =>
      guarded(async () => {
        let input: ProjectInput;
        let id: string;
        if (a.projectId) {
          const p = getProject(ctx.db, a.projectId);
          if (!p) return fail(`Projet introuvable : ${a.projectId}`);
          input = p;
          id = p.id;
        } else if (a.project) {
          const parsed = projectFileSchema.safeParse(a.project);
          if (!parsed.success) return fail("Projet invalide.", { issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
          input = a.project as ProjectInput;
          id = parsed.data.id ?? slugify(parsed.data.name);
        } else return fail("projectId ou project requis.");
        const path = join(ctx.dataDir, "suggestions", `${id}.target-suggestion.yaml`);
        if (!a.confirm) {
          return ok({
            preview: true,
            project: id,
            plannedLlmCalls: assistantPlanned(activeProfile(), 1, 4),
            writes: path,
            next: "Call again with confirm: true to run the target assistant.",
          });
        }
        const s = await suggestTarget(input, { engine: await engine(), n: a.n ?? 200, seed: a.seed ?? 42, library: library() });
        writeSuggestion(s, path);
        return ok({ written: path, suggestion: suggestionDocument(s) });
      }),
  );

  const studyArgs = {
    projectId: z.string().describe("Project id."),
    n: z.number().int().min(1).max(5000).optional().describe("Target sample size (overrides the project's target.n; for a multi-role project, the size of every role)."),
    controlN: z.number().int().min(1).max(5000).optional().describe("Control group size (overrides the project's control.n)."),
    roleN: z.record(z.string(), z.number().int().min(1)).optional().describe("Multi-role project: size per role id."),
    seed: z.number().int().optional().describe("Sample seed (default 7)."),
    backend: z.enum(BACKENDS).optional().describe("Built-in engine answering the study: 'claude-cli' or 'ollama' (local). Default: the active engine profile (claude-cli without configuration). The paid Anthropic API is never used without a user-configured profile."),
    profile: z.string().optional().describe("Engine profile (engine:profile) answering the study, e.g. a user's OpenAI or Anthropic key profile. Its spending cap applies (default $5 per study for paid providers)."),
    model: z.string().optional().describe("Model of the backend (default from the configuration)."),
    sameSampleAs: z.string().optional().describe("Reuse the exact sample of another study (A/B variants on the same personas: the most reliable comparison)."),
    sameSampleGroup: z.string().optional().describe("With sameSampleAs: only reuse this group (e.g. 'target')."),
    name: z.string().optional(),
  };

  server.registerTool(
    "create_study",
    {
      title: "Create a study",
      description:
        "Create a concept + price study (protocol v4) for a project and freeze its sample (statistical draw; attributes are never written by an LLM). " +
        "The study is not run: use run_study. Missing narratives are written by run_study before the responses. " +
        "The pitch-tone guard applies: a commercial pitch (score above 25) is refused, with no override through MCP. " +
        "The preview simulates the creation without writing and gives the planned LLM calls of the run (n responses + ~10% repairs + ceil(missing narratives / 10)). " +
        CONFIRM_NOTE,
      inputSchema: { ...studyArgs, confirm: confirmArg },
      annotations: COSTLY,
    },
    ({ confirm, ...a }) =>
      guarded(() => {
        const project = getProject(ctx.db, a.projectId);
        if (!project) return fail(`Projet introuvable : ${a.projectId}`);
        let input: CreateStudyInput;
        try {
          input = studyInput(ctx, project, a);
        } catch (err) {
          return fail(errMsg(err));
        }
        const describe = (r: ReturnType<typeof createStudy>, missing: number) => ({
          name: r.study.name,
          protocolVersion: r.study.protocolVersion,
          backend: r.study.backend,
          model: r.study.model,
          seed: r.study.seed,
          sampleSize: r.study.sampleSize,
          populations: r.study.populations.map((p) => ({ group: p.group, n: p.n, packVersion: p.packVersion })),
          sampleFromStudyId: r.study.sampleFromStudyId,
          shortfalls: r.shortfalls,
          notes: r.notes,
          engine: studyEngineInfo(r.study),
          plannedLlmCalls: plannedOf(
            estimateCost({
              profile: chooseProfile(ctx.config, { backend: a.backend, profile: a.profile ?? ctx.profile, model: a.model }),
              protocolVersion: String(r.study.protocolVersion),
              socle: socleOfPack(r.study.populations[0]?.packVersion),
              responses: r.study.sampleSize,
              missingNarratives: missing,
              db: ctx.db,
            }),
          ),
        });
        try {
          if (!confirm) {
            const view = dryRun(ctx.db, () => {
              const r = createStudy(ctx.db, ctx.pack, input);
              return describe(r, missingNarratives(ctx.db, r.study.personaIds));
            });
            return ok({ preview: true, ...view, next: "Call again with confirm: true to create the study (it will not run until run_study)." });
          }
          const r = createStudy(ctx.db, ctx.pack, input);
          return ok({ created: true, studyId: r.study.id, ...describe(r, missingNarratives(ctx.db, r.study.personaIds)), next: `run_study { studyId: "${r.study.id}" }` });
        } catch (err) {
          const m = errMsg(err);
          return isToneRefusal(m) ? toneRefusal(m, project) : fail(m);
        }
      }),
  );

  server.registerTool(
    "run_study",
    {
      title: "Run a study",
      description:
        "Launch (or resume) a study in a detached background process (`study:run`); returns immediately. Only missing responses are processed, " +
        "missing narratives first. Poll study_status for progress, then read study_summary. " +
        CONFIRM_NOTE,
      inputSchema: { studyId: z.string().describe("Study id (or unique prefix)."), confirm: confirmArg },
      annotations: COSTLY,
    },
    ({ studyId, confirm }) =>
      guarded(() => {
        const s = findStudy(ctx.db, studyId);
        let profile: EngineProfile;
        try {
          profile = profileForStudy(s, ctx.config);
        } catch (err) {
          return fail(`Backend refusé : ${s.backend} (${errMsg(err)})`);
        }
        const done = responseCount(ctx.db, s.id);
        if (done >= s.personaIds.length) return fail("Étude déjà complète.", { studyId: s.id, responses: done });
        const current = ctx.launcher.info(s.id);
        if (current?.alive) return fail(`L'étude ${s.id} tourne déjà (processus ${current.pid}).`, { run: current });
        const plan = { studyId: s.id, backend: s.backend, model: s.model, engine: studyEngineInfo(s), responsesDone: done, total: s.personaIds.length, plannedLlmCalls: plannedOf(estimateExistingStudy(ctx.db, s, profile)) };
        if (!confirm) return ok({ preview: true, ...plan, next: "Call again with confirm: true to launch the run in the background." });
        try {
          const info = ctx.launcher.start(s.id);
          return ok({ launched: true, ...plan, run: { pid: info.pid, startedAt: info.startedAt, logPath: info.logPath }, next: `study_status { studyId: "${s.id}" }` });
        } catch (err) {
          if (err instanceof AlreadyRunningError) return fail(err.message, { run: err.info });
          throw err;
        }
      }),
  );

  server.registerTool(
    "recommend",
    {
      title: "Recommend next steps",
      description:
        "Recommendations after a study (claude-cli): findings and recommendations whose evidence is checked against the summary (invalid evidence is repaired or dropped), " +
        "with proposed next studies. Cached in data/recommendations/ (no call if the inputs did not change). Nothing is created: the user decides. " +
        "About 1 LLM call (2 with a repair). " +
        POSITIONING +
        " " +
        CONFIRM_NOTE,
      inputSchema: {
        studyId: z.string().describe("Study id (or unique prefix)."),
        refresh: z.boolean().optional().describe("Ignore the cache and ask again. Default false."),
        confirm: confirmArg,
      },
      annotations: COSTLY,
    },
    ({ studyId, refresh, confirm }) =>
      guarded(async () => {
        const s = findStudy(ctx.db, studyId);
        const outDir = join(ctx.dataDir, "recommendations");
        const cached = existsSync(recommendationPath(s.id, outDir));
        if (!confirm) {
          return ok({
            preview: true,
            studyId: s.id,
            cached: cached && !refresh,
            plannedLlmCalls: { ...assistantPlanned(activeProfile(), cached && !refresh ? 0 : 1, 2), note: cached && !refresh ? "a cached result exists; it is reused if the inputs are unchanged" : undefined },
            next: "Call again with confirm: true to get the recommendations.",
          });
        }
        const r = await recommendStudy(s.id, { db: ctx.db, pack: ctx.pack, engine: await engine(), force: Boolean(refresh), outDir });
        return ok({ positioning: POSITIONING, ...r });
      }),
  );

  return server;
}
