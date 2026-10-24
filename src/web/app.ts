import { DRIVER_OUTCOMES, DRIVER_OUTCOMES_EN } from "../studies/drivers";
import { Hono } from "hono";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { runMode, type AppConfig, type RunMode } from "../config";
import { HOSTED_FEATURES, LOCAL_FEATURES, type Feature } from "./features";
import type { Db } from "../db/client";
import { and, count, inArray, isNotNull, max } from "drizzle-orm";
import { personas, type Project, type Study } from "../db/schema";
import { getPersona } from "../personas/store";
import type { Pack } from "../personas/pack";
import { compareSummaries } from "../studies/compare";
import { FX_TABLE, hasGenericPricing, pricingOf, referenceOffer, type Pricing } from "../studies/price-model";
import type { StudySummary } from "../studies/summary";
import { priceIn, pricingIn, tierIn, unitLabelIn, unitWordIn } from "./i18n-price";
import { createProject, getProject, listProjects, PERIOD_LABELS, projectFileSchema } from "../studies/project";
import { hasV3Measures, PROTOCOL_VERSION, PROTOCOL_VERSIONS } from "../studies/protocols/concept-price";
import { toneWarning } from "../studies/pitch-tone";
import {
  BEHAVIOR_LABELS,
  BEHAVIORS,
  CHECK_LABELS,
  OBJECTION_CATEGORIES,
  OBJECTION_LABELS,
  RELEVANCE,
  RELEVANCE_LABELS,
} from "../studies/protocols/concept-price";
import { DIMENSION_LABELS, MODULE_SEGMENTS, SEGMENT_DIMENSIONS } from "../studies/segments";
import { findStudy, listStudies } from "../studies/store";
import { createStudy, type CreateStudyInput, type PopulationInput } from "../studies/study";
import { GROUP_LABELS, METHOD_NOTE, scaleView, SMALL_SEGMENT } from "../studies/summary";
import { LEVEL_LABELS } from "../studies/protocols/protocol";
import {
  lastResponseAt,
  listPersonas,
  packList,
  personaCard,
  priceUnit,
  projectDetail,
  projectListItem,
  responseCount,
  responseDetail,
  responseRows,
  studyListItem,
  studySummary,
} from "./adapters";
import { AlreadyRunningError, ScriptMissingError, type Launcher } from "./launcher";
import { projectTargeting, registerModuleRoutes, socleList } from "./module-routes";
import { registerHubRoutes, type HubRouteDeps } from "./hub-routes";
import type { AssistantLoader } from "./modules";
import { registerP1Routes } from "./p1-routes";
import { registerPitchRoutes } from "./pitch-routes";
import { plainCriteria, projectOverview } from "./overview";
import { errorBodyIn, L, langOf, overlay, projectLocale, type Lang } from "./i18n";
import {
  BACKEND_LABELS,
  BEHAVIOR_LABELS_EN,
  CHECK_LABELS_EN,
  CONFIDENCE_LEVEL_LABELS_EN,
  DIMENSION_LABELS_EN,
  ENCOUNTER_LABELS_EN,
  ENCOUNTER_LABELS_FR,
  GROUP_LABELS_EN,
  LEVEL_LABELS_EN,
  METHOD_NOTE_EN,
  OBJECTION_LABELS_EN,
  PERIOD_LABELS_EN,
  PRICE_UNITS,
  RELEVANCE_LABELS_EN,
  behaviorLabelsForEn,
} from "./i18n-labels";
import { registerRecommendRoutes, type RecommendLoader } from "./recommend-routes";
import { moduleLibrary } from "../modules/registry";
import { resolveSoclePack } from "../population/target";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { registerSetupRoutes, type SetupDeps } from "./setup-routes";
import { chooseProfile, engineInfoOf, profileBudget, profileForStudy, studyEngineInfo } from "../engine/select";
import { activeProfileName, isBuiltinProfile, listProfiles, loadEngineConfig, type EngineProfile } from "../engine/profiles";
import { pricingFor } from "../engine/pricing";
import { estimateExistingStudy, estimateNewStudy } from "../studies/cost";

export interface AppContext {
  db: Db;
  pack: Pack;
  config: AppConfig;
  launcher: Launcher;
  /** Assistant de modules (import dynamique par défaut ; injecté dans les tests). */
  assistant?: AssistantLoader;
  /** Dossier des modules (défaut : modules/ du dépôt). */
  modulesDir?: string;
  /** Racine du dépôt (fichiers projet) et dossier des données (aperçus, propositions, sauvegardes). */
  root?: string;
  dataDir?: string;
  /** Recommandations (import dynamique de src/studies/recommend.ts ; injecté dans les tests). */
  recommend?: RecommendLoader;
  /** Jeton de session de l'API locale de configuration (tiré au démarrage du serveur ; défaut : tiré ici). */
  sessionToken?: string;
  /** Dépendances de l'écran de premier lancement (trousseau, fichier des profils… ; injectées dans les tests). */
  setup?: SetupDeps;
  /** Client et cache du Hub (page Modules ; injectés dans les tests). */
  hub?: HubRouteDeps;
  /** Mode d'exécution exposé par /meta (défaut : `runMode()`). `hosted` : service hébergé (src/hosted/). */
  mode?: RunMode;
  /** Fonctions disponibles exposées par /meta (défaut : selon le mode). */
  features?: readonly Feature[];
}

const BACKENDS = ["claude-cli", "ollama"] as const;

const quotas = z.record(z.string(), z.record(z.string(), z.number().nonnegative())).optional();
/**
 * Population d'une étude créée à la main : un pack déjà tiré en base (`packVersion`), ou un socle
 * (`socle`, ex. fr → packs/socles.json) tiré à la demande et mis en cache, comme la cible d'un projet.
 */
const population = z
  .object({ packVersion: z.string().min(1).optional(), socle: z.string().min(1).optional(), n: z.number().int().positive(), quotas })
  .refine((p) => p.packVersion || p.socle, { message: "pack ou socle requis", path: ["packVersion"] });

/** Libellés des champs du formulaire « Nouvelle étude », pour des erreurs de validation lisibles. */
const STUDY_FIELD_LABELS: Record<string, string> = {
  projectId: "Projet",
  name: "Nom de l'étude",
  seed: "Graine",
  profile: "Profil de moteur",
  model: "Modèle",
  n: "Effectif",
  controlN: "Effectif du témoin",
  "target.packVersion": "Population cible",
  "target.socle": "Population cible",
  "target.n": "Effectif de la cible",
  "target.quotas": "Quotas de la cible",
  "control.packVersion": "Population témoin",
  "control.socle": "Population témoin",
  "control.n": "Effectif du témoin",
  "control.quotas": "Quotas du témoin",
  protocolVersion: "Version du protocole",
};

/**
 * Erreurs de validation du corps d'une étude, en phrases (jamais le message brut de Zod) ; le français
 * est traduit en sortie par errorBodyIn (src/web/i18n.ts).
 */
export function studyValidationMessage(issues: ReadonlyArray<{ path: PropertyKey[]; code: string; message: string }>): string {
  const lines = issues.map((i) => {
    const path = i.path.map(String).join(".");
    if (!path) return i.message;
    const label = STUDY_FIELD_LABELS[path] ?? `Champ « ${path} »`;
    if (/(^|\.)(packVersion|socle)$/.test(path)) return `${label} : choisir un pack ou un socle.`;
    if (/(^|\.)(n|controlN|seed)$/.test(path)) return `${label} : nombre entier positif attendu.`;
    if (i.code === "invalid_type") return `${label} : valeur manquante ou invalide.`;
    return `${label} : valeur invalide.`;
  });
  return [...new Set(lines)].join(" ");
}

export const createStudySchema = z
  .object({
    projectId: z.string().min(1),
    name: z.string().trim().min(1).optional(),
    seed: z.number().int().default(7),
    /** Moteur intégré historique (claude-cli, ollama) ; sinon `profile`, sinon le profil actif. */
    backend: z.enum(BACKENDS).optional(),
    /** Profil de moteur (docs/plateforme.md § 7.1) ; prioritaire sur `backend`. */
    profile: z.string().trim().min(1).optional(),
    model: z.string().trim().min(1).optional(),
    /** Modèle sans prix connu : confirmation explicite du coût inconnu. */
    acceptUnknownCost: z.boolean().optional(),
    target: population.optional(),
    control: population.optional(),
    sameSampleAs: z.string().min(1).optional(),
    sameSampleGroup: z.string().min(1).optional(),
    n: z.number().int().positive().optional(),
    /** Utiliser la cible (et le témoin) déclarés dans le projet : socle, modules, filtre d'éligibilité. */
    useProjectTarget: z.boolean().optional(),
    controlN: z.number().int().positive().optional(),
    withControl: z.boolean().optional(),
    /** Version du protocole concept-price : v4 par défaut (v3 et bloc délimité des attributs de module). */
    protocolVersion: z.enum(PROTOCOL_VERSIONS).optional(),
    /** v3 et v4 : passer outre le refus d'un pitch au ton commercial (l'indice de confiance le signale). */
    force: z.boolean().optional(),
  })
  .refine((v) => v.sameSampleAs || v.target || v.useProjectTarget, { message: "Population cible requise (ou « même échantillon que », ou la cible du projet)." });

function httpError(err: unknown): { message: string; status: 400 | 404 | 409 } {
  const message = err instanceof Error ? err.message : String(err);
  if (/introuvable|not found/i.test(message)) return { message, status: 404 };
  if (/existe déjà|tourne déjà|already exists|already running/i.test(message)) return { message, status: 409 };
  return { message, status: 400 };
}

type Scale = ReturnType<typeof scaleView>;

/**
 * Échelle d'affichage dans la langue demandée. Protocole historique : libellés traduits par code
 * (comportements selon l'unité de l'offre de référence). Protocole propre au projet : ses libellés (données).
 */
function scaleIn(lang: Lang, scale: Scale, custom: boolean, p: Project): Scale {
  if (lang !== "en" || custom) return scale;
  const generic = hasGenericPricing(p) ? pricingOf(p) : null;
  const ref = generic ? referenceOffer(generic).unit : null;
  const behaviors = ref && !["month", "year"].includes(ref) ? behaviorLabelsForEn(ref) : BEHAVIOR_LABELS_EN;
  return {
    behaviors: scale.behaviors.map((b) => ({ ...b, label: behaviors[b.code] ?? b.label })),
    objections: scale.objections.map((o) => ({ ...o, label: OBJECTION_LABELS_EN[o.code] ?? o.label })),
    relevance: scale.relevance.map((r) => ({ ...r, label: RELEVANCE_LABELS_EN[r.code] ?? r.label })),
  };
}

/**
 * Résumé (calculé par src/studies/summary.ts, en français) : seuls les libellés à code connu sont traduits
 * (groupes cible/témoin, niveau de confiance, prix). Les textes calculés (alertes, segments, rôles) restent en français.
 */
function summaryIn(lang: Lang, s: StudySummary, p: Project): StudySummary {
  if (lang !== "en") return s;
  const pricing = s.project.pricing as Pricing | undefined;
  const ref = pricing ? referenceOffer(pricing) : null;
  const project: StudySummary["project"] = {
    ...s.project,
    price: pricing ? pricingIn(lang, pricing) : p.priceEur ? priceIn(lang, p.priceEur, p.pricePeriod) : s.project.price,
    ...(s.project.priceUnit !== undefined && { priceUnit: pricing && ref ? unitLabelIn(lang, ref) : unitWordIn(lang, s.project.priceUnit) }),
    ...(pricing && ref && s.project.referencePrice !== undefined && { referencePrice: tierIn(lang, pricing, ref.amount) }),
    ...(s.project.behaviorLabels && ref && { behaviorLabels: behaviorLabelsForEn(ref.unit) as StudySummary["project"]["behaviorLabels"] }),
  };
  return {
    ...s,
    project,
    methodNote: s.methodNote === METHOD_NOTE ? METHOD_NOTE_EN : s.methodNote,
    groups: s.groups.map((g) => ({ ...g, label: g.label === GROUP_LABELS[g.group] ? GROUP_LABELS_EN[g.group] ?? g.label : g.label })),
    ...(s.confidence && { confidence: { ...s.confidence, label: CONFIDENCE_LEVEL_LABELS_EN[s.confidence.level] ?? s.confidence.label } }),
    // Issues des facteurs : libellé par niveau (les phrases et les segments restent en français)
    ...(s.drivers && {
      drivers: {
        ...s.drivers,
        outcomes: s.drivers.outcomes.map((o) => {
          const fr = DRIVER_OUTCOMES.find((d) => d.level === o.level);
          const en = DRIVER_OUTCOMES_EN.find((d) => d.level === o.level);
          return fr && en && o.label === fr.label ? { ...o, label: en.label } : o;
        }),
      },
    }),
  };
}

export function createApp(ctx: AppContext) {
  const { db, pack, config, launcher } = ctx;
  const mode: RunMode = ctx.mode ?? runMode();
  const hosted = mode === "hosted";
  const features = ctx.features ?? (hosted ? HOSTED_FEATURES : LOCAL_FEATURES);
  const api = new Hono();

  api.onError((err, c) => {
    if (err instanceof ScriptMissingError) return c.json({ error: err.message, unavailable: true }, 503);
    const { message, status } = httpError(err);
    return c.json({ error: message }, status);
  });

  // Erreurs en anglais avec `?lang=en` : le statut est déjà fixé (sur le message français), seul le texte change
  api.use(async (c, next) => {
    await next();
    const lang = langOf(c);
    if (lang !== "en" || c.res.status < 400 || !c.res.headers.get("content-type")?.includes("application/json")) return;
    const body = (await c.res.clone().json().catch(() => null)) as unknown;
    if (!body) return;
    const headers = new Headers(c.res.headers);
    headers.delete("content-length");
    c.res = new Response(JSON.stringify(errorBodyIn(lang, body)), { status: c.res.status, headers });
  });

  const loadStudy = (id: string): Study => findStudy(db, id);

  // ── Méta : libellés et constantes partagés avec l'interface ──
  api.get("/meta", (c) => {
    const lang = langOf(c);
    const behaviorLabels = overlay(lang, BEHAVIOR_LABELS, BEHAVIOR_LABELS_EN);
    const objectionLabels = overlay(lang, OBJECTION_LABELS, OBJECTION_LABELS_EN);
    const relevanceLabels = overlay(lang, RELEVANCE_LABELS, RELEVANCE_LABELS_EN);
    const dimensionLabels = overlay(lang, DIMENSION_LABELS, DIMENSION_LABELS_EN);
    const periodLabels = overlay(lang, PERIOD_LABELS, PERIOD_LABELS_EN);
    return c.json({
      mode,
      features,
      behaviors: BEHAVIORS.map((id) => ({ id, label: behaviorLabels[id] })),
      objections: OBJECTION_CATEGORIES.map((id) => ({ id, label: objectionLabels[id] })),
      relevance: RELEVANCE.map((id) => ({ id, label: relevanceLabels[id] })),
      // Dimensions du socle, puis celles des modules (module source et rang de comparaison)
      dimensions: SEGMENT_DIMENSIONS.map((id) => {
        const m = MODULE_SEGMENTS.find((s) => s.id === id);
        return { id, label: dimensionLabels[id] ?? id, ...(m && { module: m.module, ...(m.compare !== undefined && { compare: m.compare }) }) };
      }),
      checks: overlay(lang, CHECK_LABELS, CHECK_LABELS_EN),
      groups: overlay(lang, GROUP_LABELS, GROUP_LABELS_EN),
      encounters: overlay(lang, ENCOUNTER_LABELS_FR, ENCOUNTER_LABELS_EN),
      // Périodes historiques (`price.period`) ; le modèle générique a ses propres unités et devises
      periods: Object.entries(periodLabels)
        .filter(([id]) => id !== "one_time")
        .map(([id, label]) => ({ id, label })),
      priceUnits: PRICE_UNITS.map((u) => ({ id: u.id, label: L(lang, u.fr, u.en) })),
      currencies: ["EUR", "USD", "SGD", "GBP", "CHF"].map((id) => ({ id, ...(FX_TABLE[id] && { fx: FX_TABLE[id] }) })),
      // Service hébergé : aucun moteur local (claude-cli, Ollama) ; seulement le profil de la clé de l'utilisateur
      backends: hosted
        ? []
        : [
            { id: "claude-cli", label: L(lang, BACKEND_LABELS["claude-cli"]!.fr, BACKEND_LABELS["claude-cli"]!.en), defaultModel: config.CLAUDE_CLI_MODEL },
            { id: "ollama", label: L(lang, BACKEND_LABELS.ollama!.fr, BACKEND_LABELS.ollama!.en), defaultModel: config.OLLAMA_MODEL },
          ],
      profiles: profileList(),
      methodNote: L(lang, METHOD_NOTE, METHOD_NOTE_EN),
      socles: socleList(),
      smallSegment: SMALL_SEGMENT,
      packs: packList(db),
    });
  });

  // ── Projets ──
  api.get("/projects", (c) => c.json(listProjects(db).map((p) => projectListItem(db, p, langOf(c)))));

  api.post("/projects", async (c) => {
    const body = (await c.req.json()) as { project?: unknown; update?: boolean } & Record<string, unknown>;
    const raw = body.project ?? body;
    const parsed = projectFileSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "Projet invalide.", issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, 400);
    }
    const p = createProject(db, parsed.data, { update: body.update === true });
    return c.json(projectDetail(p, langOf(c)), 201);
  });

  /** Import d'un fichier projet (JSON ou YAML), même validation que `project:create`. */
  api.post("/projects/import", async (c) => {
    const { content, filename, update } = (await c.req.json()) as { content?: string; filename?: string; update?: boolean };
    if (!content?.trim()) return c.json({ error: "Fichier vide." }, 400);
    let raw: unknown;
    try {
      raw = /\.ya?ml$/i.test(filename ?? "") ? parseYaml(content) : JSON.parse(content);
    } catch (err) {
      return c.json({ error: `Fichier illisible : ${(err as Error).message}` }, 400);
    }
    const parsed = projectFileSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "Projet invalide.", issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, 400);
    }
    // Service hébergé : le nom du fichier envoyé n'est jamais retenu comme fichier source (rien n'est lu ni écrit sur disque)
    const p = createProject(db, parsed.data, { update: update === true, ...(filename && !hosted && { sourceFile: filename }) });
    return c.json(projectDetail(p, langOf(c)), 201);
  });

  api.get("/projects/:id", async (c) => {
    const p = getProject(db, c.req.param("id"));
    if (!p) return c.json({ error: `Projet introuvable : ${c.req.param("id")}` }, 404);
    const lang = langOf(c);
    const studies = listStudies(db).filter((s) => s.projectId === p.id).map((s) => studyListItem(db, s));
    return c.json({ project: projectDetail(p, lang), studies, targeting: await projectTargeting(db, ctx, p.id, lang) });
  });

  // ── Études ──
  api.get("/studies", (c) => {
    const project = c.req.query("project");
    return c.json(listStudies(db).filter((s) => !project || s.projectId === project).map((s) => studyListItem(db, s)));
  });

  /**
   * Entrée de `createStudy` depuis le corps du formulaire (cible du projet, packs, même échantillon) et profil
   * de moteur retenu ; une erreur renvoie la réponse HTTP à donner.
   */
  type BodyInput = { input: CreateStudyInput; profile: EngineProfile } | { error: Record<string, unknown>; status: 400 | 409 | 422 };
  /** Population saisie à la main : pack en base, ou socle tiré à la demande (sans module ni filtre). */
  function manualPopulation(group: string, p: z.infer<typeof population>): PopulationInput {
    const q = p.quotas && { quotas: p.quotas };
    if (p.packVersion) return { group, packVersion: p.packVersion, n: p.n, ...q };
    return { group, n: p.n, target: { socle: p.socle!, modules: [] }, ...q };
  }

  async function studyInputFromBody(raw: unknown): Promise<BodyInput> {
    const parsed = createStudySchema.safeParse(raw);
    if (!parsed.success) {
      return { error: { error: studyValidationMessage(parsed.error.issues), code: "invalid_study" }, status: 400 };
    }
    const v = parsed.data;
    let profile: EngineProfile;
    try {
      // Sans profil configuré : claude-cli (ou le backend choisi), exactement comme avant
      profile = chooseProfile(config, { profile: v.profile, backend: v.profile ? undefined : v.backend, model: v.model });
    } catch (err) {
      return { error: { error: (err as Error).message }, status: 400 };
    }
    const model = profile.model;
    const backend = profile.provider;
    // Coût inconnu accepté dans l'interface : enregistré dans l'étude, sinon le garde-fou de budget la met en pause au premier appel
    const engine = engineInfoOf(profile, v.acceptUnknownCost === true ? { acceptUnknownCost: true } : {});
    const version = v.protocolVersion ?? PROTOCOL_VERSION;
    const opts = { protocolVersion: version, ...(v.force && { force: true }) };
    // v3 et v4 : un pitch au ton commercial est refusé sans « forcer » (même règle que createStudy, réponse structurée)
    const proj = getProject(db, v.projectId);
    if (proj && hasV3Measures(version) && !v.force) {
      const tone = toneWarning(proj.pitch);
      if (tone.warn)
        return {
          error: {
            error: `Pitch au ton commercial (score ${tone.score}/100, seuil ${tone.threshold}) : le protocole v${version} exige un pitch neutre.`,
            code: "pitch_tone",
            pitchTone: { score: tone.score, threshold: tone.threshold, markers: tone.markers },
          },
          status: 422,
        };
    }
    if (v.useProjectTarget && !v.sameSampleAs) {
      const t = await projectTargeting(db, ctx, v.projectId);
      if (!t.target) return { error: { error: "Ce projet ne déclare pas de cible (bloc `target`)." }, status: 400 };
      if (t.blocking.length) return { error: { error: `Module(s) à valider avant de lancer une étude : ${t.blocking.map((m) => m.id).join(", ")}.` }, status: 409 };
      const n = v.n ?? t.target.n;
      const controlN = v.controlN ?? t.control?.n;
      if (!n) return { error: { error: "Effectif de la cible requis (n)." }, status: 400 };
      const withControl = v.withControl !== false && t.control;
      if (withControl && !controlN) return { error: { error: "Effectif du témoin requis." }, status: 400 };
      return {
        profile,
        input: {
          projectId: v.projectId,
          populations: [
            { group: "target", n, target: t.target },
            ...(withControl ? [{ group: "control", n: controlN!, target: t.control! }] : []),
          ],
          seed: v.seed,
          backend,
          model,
          engine,
          ...(v.name && { name: v.name }),
          ...opts,
        },
      };
    }
    const input: CreateStudyInput = v.sameSampleAs
      ? {
          projectId: v.projectId,
          sameSampleAs: v.sameSampleAs,
          ...(v.sameSampleGroup && { sameSampleGroup: v.sameSampleGroup }),
          ...(v.n && { n: v.n }),
          seed: v.seed,
          backend,
          model,
          engine,
          ...(v.name && { name: v.name }),
          ...opts,
        }
      : {
          projectId: v.projectId,
          populations: [
            manualPopulation("target", v.target!),
            ...(v.control ? [manualPopulation("control", v.control)] : []),
          ],
          seed: v.seed,
          backend,
          model,
          engine,
          ...(v.name && { name: v.name }),
          ...opts,
        };
    return { input, profile };
  }

  /** Profils de moteur pour le formulaire (jamais de clé) : fournisseur, modèle, tarification, plafond. */
  function profileList() {
    let file;
    try {
      file = loadEngineConfig();
    } catch {
      file = undefined;
    }
    let active = "claude-cli";
    try {
      active = activeProfileName(file ? { file } : {});
    } catch {
      // fichier illisible : profil par défaut
    }
    return listProfiles(config, file ?? { version: 1, profiles: [] }).filter((p) => !hosted || !isBuiltinProfile(p.name)).map((p) => {
      const b = profileBudget(p);
      return {
        name: p.name,
        provider: p.provider,
        model: p.model,
        builtin: isBuiltinProfile(p.name),
        active: p.name === active,
        paid: b.paid,
        pricing: b.pricing.kind,
        ...(b.limits.perStudyUsd !== undefined && { perStudyUsd: b.limits.perStudyUsd }),
        ...(b.limits.perDayUsd !== undefined && { perDayUsd: b.limits.perDayUsd }),
        ...(b.limits.perMonthUsd !== undefined && { perMonthUsd: b.limits.perMonthUsd }),
      };
    });
  }

  api.post("/studies", async (c) => {
    const body = (await c.req.json()) as { acceptUnknownCost?: boolean };
    const r = await studyInputFromBody(body);
    if ("error" in r) return c.json(r.error, r.status);
    // Modèle sans prix connu : confirmation explicite du coût inconnu (docs/plateforme.md § 7.3)
    if (pricingFor(r.profile.provider, r.profile.model, { baseUrl: r.profile.baseUrl }).kind === "unknown" && body.acceptUnknownCost !== true) {
      return c.json({ error: `Coût inconnu pour le modèle ${r.profile.model} (absent de pricing/models.json) : confirmer le lancement malgré le coût inconnu.`, code: "unknown_cost", model: r.profile.model }, 422);
    }
    const { study, shortfalls, notes } = createStudy(db, pack, r.input);
    return c.json({ study: studyListItem(db, study), shortfalls, notes }, 201);
  });

  /** Estimation avant lancement (même corps que la création ; création simulée, sans écriture ni appel). */
  api.post("/studies/estimate", async (c) => {
    const r = await studyInputFromBody(await c.req.json());
    if ("error" in r) return c.json(r.error, r.status);
    return c.json({ estimate: estimateNewStudy(db, pack, r.input, r.profile) });
  });

  /** Estimation d'une étude sur la cible du projet (ou le pack par défaut) : `?n=&controlN=&profile=&seed=&protocol=`. */
  api.get("/projects/:id/estimate", async (c) => {
    const p = getProject(db, c.req.param("id"));
    if (!p) return c.json({ error: `Projet introuvable : ${c.req.param("id")}` }, 404);
    const q = (k: string) => c.req.query(k);
    const n = q("n") ? Number(q("n")) : undefined;
    const hasTarget = Boolean((p.extra as { target?: unknown }).target);
    const body = {
      projectId: p.id,
      seed: q("seed") ? Number(q("seed")) : 7,
      ...(q("profile") && { profile: q("profile") }),
      ...(q("backend") && { backend: q("backend") }),
      ...(q("model") && { model: q("model") }),
      ...(q("protocol") && { protocolVersion: q("protocol") }),
      ...(q("force") === "true" && { force: true }),
      ...(hasTarget
        ? { useProjectTarget: true, ...(n && { n }), ...(q("controlN") && { controlN: Number(q("controlN")) }), ...(q("withControl") === "false" && { withControl: false }) }
        : { target: { packVersion: q("pack") ?? pack.manifest.version, n: n ?? 200 } }),
    };
    const r = await studyInputFromBody(body);
    if ("error" in r) return c.json(r.error, r.status);
    return c.json({ estimate: estimateNewStudy(db, pack, r.input, r.profile) });
  });

  /** Reste à faire d'une étude existante (réponses et récits manquants) au profil qui l'exécutera. */
  api.get("/studies/:id/estimate", (c) => {
    const s = loadStudy(c.req.param("id"));
    const profile = profileForStudy(s, config);
    return c.json({ estimate: estimateExistingStudy(db, s, profile) });
  });

  api.get("/studies/:id", (c) => {
    const lang = langOf(c);
    const s = loadStudy(c.req.param("id"));
    const p = getProject(db, s.projectId);
    // Qui a été interrogé, en langage clair (critères de sélection traduits, caractéristiques ajoutées)
    const populationsPlain = (s.populations ?? []).map((pop) => {
      const el = (pop as { eligibility?: { socle?: string; modules?: string[]; expression?: string | null } }).eligibility;
      let regionName: ((c: string) => string) | undefined;
      let socleLabel: string | null = null;
      try {
        const sp = resolveSoclePack(el?.socle?.replace(/-\d.*$/, "") || "fr");
        regionName = (code: string) => sp.regionName(code);
        socleLabel = (sp.manifest as { population?: string }).population ?? null;
      } catch {
        regionName = undefined;
      }
      const plain = plainCriteria(el?.expression ?? null, regionName, lang);
      const modules = (el?.modules ?? []).map((m) => {
        const id = m.split("@")[0]!;
        try {
          return { id, label: moduleLibrary().get(id)?.def.label ?? id };
        } catch {
          return { id, label: id };
        }
      });
      return { group: pop.group, n: pop.n, packVersion: pop.packVersion, socleLabel, criteria: plain.criteria, rawCriteria: plain.raw, modules };
    });
    return c.json({ study: studyState(s), project: p ? projectDetail(p, lang) : null, populationsPlain });
  });

  /** Suivi léger pour le polling pendant une exécution. */
  api.get("/studies/:id/progress", (c) => c.json(studyState(loadStudy(c.req.param("id")))));

  api.post("/studies/:id/run", (c) => {
    const s = loadStudy(c.req.param("id"));
    try {
      profileForStudy(s, config);
    } catch (err) {
      return c.json({ error: `Backend refusé : ${s.backend} (${(err as Error).message})` }, 400);
    }
    if (responseCount(db, s.id) >= s.personaIds.length) return c.json({ error: "Étude déjà complète." }, 409);
    try {
      const info = launcher.start(s.id);
      return c.json({ run: info, state: studyState(s) }, 202);
    } catch (err) {
      if (err instanceof AlreadyRunningError) return c.json({ error: err.message, run: err.info }, 409);
      throw err;
    }
  });

  api.get("/studies/:id/log", (c) => c.json(launcher.tail(loadStudy(c.req.param("id")).id)));

  api.get("/studies/:id/summary", (c) => {
    const s = loadStudy(c.req.param("id"));
    const p = getProject(db, s.projectId);
    if (!p) return c.json({ error: `Projet introuvable : ${s.projectId}` }, 404);
    const summary = studySummary(db, pack, s, p);
    if (!summary) return c.json({ error: "Aucune réponse pour cette étude." }, 404);
    // Échelle d'affichage : protocole propre à l'étude (figé dans les réponses), sinon historique
    const lang = langOf(c);
    const scale = scaleIn(lang, scaleView(summary.protocol ?? undefined, summary.project.behaviorLabels as Record<string, string> | undefined), Boolean(summary.protocol), p);
    const levels = summary.protocol
      ? Object.fromEntries(summary.protocol.behaviors.map((b) => [b.code, b.level]))
      : null;
    const shown = summaryIn(lang, summary, p);
    const unit = shown.project.priceUnit ?? priceUnit(p as typeof p & Record<string, unknown>, lang);
    return c.json({ ...shown, unit, scale, behaviorLevels: levels, levelLabels: overlay(lang, LEVEL_LABELS, LEVEL_LABELS_EN), locale: projectLocale(p) });
  });

  api.get("/studies/:id/responses", (c) => c.json(responseRows(db, pack, loadStudy(c.req.param("id")), langOf(c))));

  api.get("/studies/:id/responses/:personaId", (c) => {
    const s = loadStudy(c.req.param("id"));
    const lang = langOf(c);
    const d = responseDetail(db, pack, s, c.req.param("personaId"), lang);
    if (!d) return c.json({ error: "Réponse introuvable." }, 404);
    const p = getProject(db, s.projectId);
    return c.json({ ...d, study: { id: s.id, name: s.name, backend: s.backend, model: s.model }, project: p ? projectDetail(p, lang) : null });
  });

  // ── Comparaison ──
  api.get("/compare", (c) => {
    const ids = (c.req.query("ids") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    if (ids.length < 2) return c.json({ error: "Choisir au moins deux études." }, 400);
    const group = c.req.query("group") || undefined;
    const summaries = ids.map((id) => {
      const s = loadStudy(id);
      const p = getProject(db, s.projectId);
      const sum = p && studySummary(db, pack, s, p);
      if (!sum) throw new Error(`Aucune réponse pour l'étude ${s.id}.`);
      return sum;
    });
    const normalize = c.req.query("normalize") === "monthly-eur" ? ({ normalize: "monthly-eur" } as const) : {};
    return c.json(compareSummaries(summaries, group, normalize));
  });

  // ── Personas ──
  api.get("/personas", (c) => {
    const q = c.req.query();
    const num = (x?: string) => (x !== undefined && x !== "" && Number.isFinite(Number(x)) ? Number(x) : undefined);
    const segments = Object.fromEntries(
      Object.entries(q)
        .filter(([k, v]) => k.startsWith("seg.") && v)
        .map(([k, v]) => [k.slice(4), v]),
    );
    const ageMin = num(q.ageMin);
    const ageMax = num(q.ageMax);
    const page = num(q.page);
    const pageSize = num(q.pageSize);
    return c.json(
      listPersonas(db, pack, {
        ...(q.pack && { pack: q.pack }),
        ...(ageMin !== undefined && { ageMin }),
        ...(ageMax !== undefined && { ageMax }),
        ...(q.q && { q: q.q }),
        ...((q.narrative === "with" || q.narrative === "without") && { narrative: q.narrative }),
        ...(Object.keys(segments).length && { segments }),
        ...(page !== undefined && { page }),
        ...(pageSize !== undefined && { pageSize }),
      }, langOf(c)),
    );
  });

  api.get("/personas/:id", (c) => {
    const p = getPersona(db, c.req.param("id"));
    if (!p) return c.json({ error: `Persona introuvable : ${c.req.param("id")}` }, 404);
    return c.json(personaCard(pack, p, langOf(c)));
  });

  /**
   * Avancement des récits de l'échantillon (comptage en base) : `study:run` les écrit avant les réponses,
   * y compris lancé depuis le terminal. `lastAt` : date du dernier récit enregistré.
   */
  function narrativeProgress(ids: string[]) {
    let doneN = 0;
    let lastAt: string | null = null;
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const [row] = db.select({ n: count(), last: max(personas.narrativeAt) }).from(personas).where(and(inArray(personas.id, chunk), isNotNull(personas.narrative))).all();
      doneN += row?.n ?? 0;
      if (row?.last && (!lastAt || row.last > lastAt)) lastAt = row.last;
    }
    return { done: doneN, total: ids.length, lastAt };
  }

  function studyState(s: Study) {
    const done = responseCount(db, s.id);
    const run = launcher.info(s.id);
    // « running » en base mais processus lancé d'ici et mort : exécution interrompue
    const interrupted = s.status === "running" && run !== null && !run.alive && done < s.personaIds.length;
    const { personaIds, personaGroups, ...rest } = s;
    const groups: Record<string, number> = {};
    for (const id of personaIds) {
      const g = personaGroups?.[id] ?? "target";
      groups[g] = (groups[g] ?? 0) + 1;
    }
    return {
      ...rest,
      responses: done,
      total: personaIds.length,
      narratives: narrativeProgress(personaIds),
      groupSizes: groups,
      lastResponseAt: lastResponseAt(db, s.id),
      run: run && { pid: run.pid, alive: run.alive, startedAt: run.startedAt, logPath: run.logPath, ...(run.queued !== undefined && { queued: run.queued, position: run.position ?? null }) },
      displayStatus: interrupted ? "interrupted" : s.status,
      engine: studyEngineInfo(s),
    };
  }

  registerModuleRoutes(api, ctx);
  registerHubRoutes(api, ctx.hub);
  const root = ctx.root ?? resolve(import.meta.dirname, "../..");
  const dataDir = ctx.dataDir ?? dirname(resolve(root, config.DATABASE_PATH));
  registerP1Routes(api, { ...ctx, root, dataDir });
  registerPitchRoutes(api, { ...ctx, root, dataDir });
  /** Vue d'ensemble d'un projet (cartes de la page Projet). */
  registerRecommendRoutes(api, { ...ctx, dataDir });
  // Écran de premier lancement (trousseau, profils locaux) : jamais en mode hébergé (remplacé par /api/me/engine)
  if (!hosted) registerSetupRoutes(api, { ...ctx, dataDir, sessionToken: ctx.sessionToken ?? randomBytes(32).toString("base64url") });
  api.get("/projects/:id/overview", async (c) => c.json(await projectOverview(db, pack, dataDir, c.req.param("id"), langOf(c))));

  const app = new Hono();
  app.route("/api", api);
  return app;
}
