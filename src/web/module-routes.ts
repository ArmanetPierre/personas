import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import type { Db } from "../db/client";
import { modulesRoot } from "../modules/registry";
import { PACKS_DIR } from "../personas/pack";
import type { TargetSpec } from "../population/target";
import { getProject, slugify, type ProjectExtra } from "../studies/project";
import type { AppContext } from "./app";
import {
  defaultAssistantLoader,
  draftsDir,
  fallbackApi,
  readDraftMeta,
  SAFE_ID,
  viewOf,
  type AssistantApi,
  type AssistantLoader,
  type ModuleSummary,
  type ValidationIssue,
} from "./modules";
import { DEFAULT_LANG, L, langOf, messageIn, type Lang } from "./i18n";
import { draftMetaIn, previewIn } from "./i18n-modules";

/**
 * Routes de l'assistant de modules (phase 5) : bibliothèque, détail, revue d'un brouillon,
 * proposition, révision et acceptation lancées en processus détaché (`module:*`), suivi par `meta.json`.
 */

/** Socles déclarés dans packs/socles.json (fr → fr-2026.2). */
export function socleList(): Array<{ id: string; pack: string }> {
  try {
    const map = JSON.parse(readFileSync(join(PACKS_DIR, "socles.json"), "utf8")) as Record<string, string>;
    return Object.entries(map)
      .filter(([k]) => !k.startsWith("_"))
      .map(([id, pack]) => ({ id, pack }));
  } catch {
    return [{ id: "fr", pack: "fr" }];
  }
}

const loaders = new WeakMap<AppContext, AssistantLoader>();
function loaderOf(ctx: AppContext): AssistantLoader {
  if (ctx.assistant) return ctx.assistant;
  let l = loaders.get(ctx);
  if (!l) loaders.set(ctx, (l = defaultAssistantLoader()));
  return l;
}

/** L'assistant s'il est là, sinon le repli en lecture (sans aperçu). */
async function apiOf(ctx: AppContext): Promise<{ api: Omit<AssistantApi, "previewModule"> & Partial<Pick<AssistantApi, "previewModule">>; available: boolean; reason?: string }> {
  const { api, reason } = await loaderOf(ctx)();
  if (api) return { api, available: true };
  return { api: fallbackApi(ctx.modulesDir ?? modulesRoot()), available: false, ...(reason && { reason }) };
}

const issueText = (e: ValidationIssue | string) => (typeof e === "string" ? e : `${e.path ? `${e.path} : ` : ""}${e.message}`);

export interface ProjectTargeting {
  target: TargetSpec | null;
  control: TargetSpec | null;
  modules: Array<{ id: string; label: string; status: string; draftId?: string; usedBy: string[] }>;
  /** Modules non validés (brouillon ou introuvable) : une étude ne peut pas être lancée. */
  blocking: Array<{ id: string; status: string; draftId?: string }>;
}

/** Cible du projet et état de ses modules (validés, en brouillon, introuvables). */
export async function projectTargeting(_db: Db, ctx: AppContext, projectId: string, lang: Lang = DEFAULT_LANG): Promise<ProjectTargeting> {
  const p = getProject(ctx.db, projectId);
  const extra = (p?.extra ?? {}) as ProjectExtra;
  const target = extra.target ?? null;
  const control = extra.control ?? null;
  const used = new Map<string, string[]>();
  for (const [g, spec] of [[L(lang, "cible", "target"), target], [L(lang, "témoin", "control"), control]] as const) for (const m of spec?.modules ?? []) used.set(m, [...(used.get(m) ?? []), g]);
  if (!used.size) return { target, control, modules: [], blocking: [] };
  const { api } = await apiOf(ctx);
  const lib = await api.listModules();
  const byId = new Map<string, ModuleSummary>();
  for (const m of lib) {
    const prev = byId.get(m.id);
    if (!prev || m.status === "validated") byId.set(m.id, m);
  }
  // Dépendances (`requires`) des modules validés : elles doivent l'être aussi
  const queue = [...used.keys()];
  while (queue.length) {
    const id = queue.shift()!;
    for (const r of byId.get(id)?.requires ?? []) {
      if (!used.has(r)) {
        used.set(r, [L(lang, `requis par ${id}`, `required by ${id}`)]);
        queue.push(r);
      }
    }
  }
  const modules = [...used.entries()].map(([id, usedBy]) => {
    const m = byId.get(id);
    return { id, label: m?.version ? m.label : id, status: m?.status ?? "missing", ...(m?.draftId && { draftId: m.draftId }), usedBy };
  });
  return { target, control, modules, blocking: modules.filter((m) => m.status !== "validated").map((m) => ({ id: m.id, status: m.status, ...(m.draftId && { draftId: m.draftId }) })) };
}

/** Brouillon créé par une proposition dont le CLI aurait choisi un autre identifiant que le nôtre. */
function findDraftFromJob(modulesDir: string, description: string, since: string): string | null {
  const dd = draftsDir(modulesDir);
  if (!existsSync(dd)) return null;
  const hits = readdirSync(dd)
    .map((d) => readDraftMeta(modulesDir, d))
    .filter((m): m is NonNullable<typeof m> => !!m && m.description === description && (m.createdAt ?? "") >= since.slice(0, 16));
  return hits.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))[0]?.id ?? null;
}

export function registerModuleRoutes(api: Hono, ctx: AppContext): void {
  const modulesDir = () => ctx.modulesDir ?? modulesRoot();
  const jobKey = (draftId: string) => `module-${draftId}`;
  const jobOf = (draftId: string) => {
    const info = ctx.launcher.info(jobKey(draftId));
    return info && { pid: info.pid, alive: info.alive, startedAt: info.startedAt, logPath: info.logPath, command: info.command };
  };
  const checkId = (id: string) => {
    if (!SAFE_ID.test(id) || id === "_drafts") throw new Error(`Identifiant invalide : ${id}`);
    return id;
  };

  api.get("/modules", async (c) => {
    const { api: a, available, reason } = await apiOf(ctx);
    const modules = await a.listModules();
    return c.json({ assistant: { available, ...(reason && { reason: messageIn(langOf(c), reason) }) }, modules });
  });

  api.post("/modules/validate", async (c) => {
    const { yaml } = (await c.req.json()) as { yaml?: string };
    const { api: a } = await apiOf(ctx);
    const { ok, errors } = await a.validateModuleYaml(yaml ?? "");
    return c.json({ ok, errors });
  });

  api.post("/modules/propose", async (c) => {
    const body = (await c.req.json()) as { description?: string; projectId?: string; socle?: string };
    const description = body.description?.trim() ?? "";
    if (description.length < 10) return c.json({ error: "Décrire le domaine en une phrase au moins (10 caractères)." }, 400);
    if (body.projectId && !getProject(ctx.db, body.projectId)) return c.json({ error: `Projet introuvable : ${body.projectId}` }, 404);
    const socle = body.socle?.trim() || "fr";
    if (!socleList().some((s) => s.id === socle)) return c.json({ error: `Socle inconnu : ${socle}` }, 400);
    const draftId = `${slugify(description).split("-").slice(0, 4).join("-") || "module"}-${randomBytes(2).toString("hex")}`;
    const args = ["--description", description, "--socle", socle, "--draft", draftId, ...(body.projectId ? ["--project", body.projectId] : [])];
    const job = ctx.launcher.startScript(jobKey(draftId), "module:propose", args);
    return c.json({ draftId, job: { pid: job.pid, startedAt: job.startedAt, logPath: job.logPath } }, 202);
  });

  api.get("/modules/drafts/:id/status", (c) => {
    const id = checkId(c.req.param("id"));
    let meta = readDraftMeta(modulesDir(), id);
    const job = jobOf(id);
    let redirect: string | null = null;
    if (!meta && job) {
      // Le CLI a pu nommer le brouillon lui-même : on le retrouve par sa description et sa date
      const desc = job.command[job.command.indexOf("--description") + 1];
      redirect = desc ? findDraftFromJob(modulesDir(), desc, job.startedAt) : null;
      if (redirect) meta = readDraftMeta(modulesDir(), redirect);
    }
    const log = job ? ctx.launcher.tail(jobKey(id), 6000) : { logPath: null, text: "" };
    // Processus mort sans brouillon prêt : la proposition a échoué
    const stalled = job && !job.alive && (!meta || meta.status === "proposing");
    return c.json({ draftId: redirect ?? id, meta: draftMetaIn(langOf(c), meta), job, log: log.text, stalled: Boolean(stalled) });
  });

  api.post("/modules/drafts/:id/revise", async (c) => {
    const id = checkId(c.req.param("id"));
    const { instruction, research } = (await c.req.json()) as { instruction?: string; research?: boolean };
    if (!instruction?.trim() || instruction.trim().length < 5) return c.json({ error: "Préciser la révision demandée." }, 400);
    if (!readDraftMeta(modulesDir(), id)) return c.json({ error: `Brouillon introuvable : ${id}` }, 404);
    const job = ctx.launcher.startScript(jobKey(id), "module:revise", ["--draft", id, "--instruction", instruction.trim(), ...(research ? ["--research"] : [])]);
    return c.json({ draftId: id, job: { pid: job.pid, startedAt: job.startedAt, logPath: job.logPath } }, 202);
  });

  api.put("/modules/drafts/:id/yaml", async (c) => {
    const id = checkId(c.req.param("id"));
    const { yaml } = (await c.req.json()) as { yaml?: string };
    if (!yaml?.trim()) return c.json({ error: "YAML vide." }, 400);
    const meta = readDraftMeta(modulesDir(), id);
    if (!meta) return c.json({ error: `Brouillon introuvable : ${id}` }, 404);
    if (meta.status === "accepted") return c.json({ error: "Ce brouillon a déjà été validé." }, 409);
    if (jobOf(id)?.alive) return c.json({ error: "L'assistant travaille sur ce brouillon : attendre la fin avant de l'éditer." }, 409);
    const { api: a } = await apiOf(ctx);
    const v = await a.validateModuleYaml(yaml);
    if (!v.ok) return c.json({ error: "YAML invalide : non enregistré.", errors: v.errors }, 400);
    await a.saveDraftYaml(id, yaml);
    return c.json({ ok: true });
  });

  api.post("/modules/drafts/:id/accept", async (c) => {
    const id = checkId(c.req.param("id"));
    const body = (await c.req.json().catch(() => ({}))) as { replace?: boolean };
    const meta = readDraftMeta(modulesDir(), id);
    if (!meta) return c.json({ error: `Brouillon introuvable : ${id}` }, 404);
    if (meta.status === "accepted") return c.json({ error: "Ce brouillon a déjà été validé." }, 409);
    if (meta.status !== "ready") return c.json({ error: `Brouillon pas prêt (statut ${meta.status}).` }, 409);
    if (jobOf(id)?.alive) return c.json({ error: "L'assistant travaille encore sur ce brouillon." }, 409);
    const { api: a, available } = await apiOf(ctx);
    const mod = await a.getModule(id);
    const errors = mod.validationErrors.map(issueText);
    if (available && a.previewModule) {
      const preview = await a.previewModule({ draftId: id }, { n: 2000, sample: 0 });
      errors.push(...preview.alerts.filter((x) => x.level === "error").map((x) => `aperçu : ${x.message}`));
    }
    if (errors.length) return c.json({ error: "Validation refusée : il reste des erreurs.", errors }, 409);
    const job = ctx.launcher.startScript(jobKey(id), "module:accept", ["--draft", id, ...(body.replace === true ? ["--replace"] : [])]);
    return c.json({ draftId: id, job: { pid: job.pid, startedAt: job.startedAt, logPath: job.logPath } }, 202);
  });

  api.get("/modules/:id/preview", async (c) => {
    const id = checkId(c.req.param("id"));
    const { api: a, available, reason } = await apiOf(ctx);
    if (!available || !a.previewModule) return c.json({ error: reason ?? "Aperçu indisponible.", unavailable: true }, 503);
    const n = Math.min(Math.max(Number(c.req.query("n") ?? 2000) || 2000, 100), 20000);
    const sample = Math.min(Math.max(Number(c.req.query("sample") ?? 5) || 5, 0), 10);
    const isDraft = !!readDraftMeta(modulesDir(), id) && !existsSync(join(modulesDir(), id, "module.yaml"));
    return c.json(previewIn(langOf(c), await a.previewModule(isDraft ? { draftId: id } : { moduleId: id }, { n, sample })));
  });

  api.get("/modules/:id", async (c) => {
    const lang = langOf(c);
    const id = checkId(c.req.param("id"));
    const { api: a, available, reason } = await apiOf(ctx);
    const mod = await a.getModule(id);
    const draftId = mod.meta?.id ?? (mod.status.startsWith("draft") ? id : undefined);
    return c.json({
      assistant: { available, ...(reason && { reason: messageIn(lang, reason) }) },
      module: { ...mod, parsed: undefined, ...(mod.meta && { meta: draftMetaIn(lang, mod.meta) }), validationErrors: mod.validationErrors.map((e) => (typeof e === "string" ? messageIn(lang, e) : { ...e, message: messageIn(lang, e.message) })) },
      view: mod.yaml ? viewOf(mod.parsed, mod.yaml, lang) : null,
      draftId: draftId ?? null,
      job: draftId ? jobOf(draftId) : null,
    });
  });
}
