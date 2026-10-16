import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import type { Db } from "../db/client";
import type { Pack } from "../personas/pack";
import { getProject, type ProjectExtra } from "../studies/project";
import { plainCriteria } from "./overview";
import { findStudy } from "../studies/store";
import type { AppContext } from "./app";
import { ScriptMissingError } from "./launcher";
import { langOf, messageIn } from "./i18n";

/**
 * Recommandations d'une étude (backend de l'agent des études : `src/studies/recommend.ts`, CLI `study:recommend`).
 * Lecture : le cache `data/recommendations/<étude>.json`. Génération : la CLI en tâche détachée.
 * Création de l'étude suivante : `createNextStudy`, importée dynamiquement (« indisponible » tant qu'elle manque).
 */

export type Strength = "faible" | "moyenne" | "forte";
export interface Evidence {
  metric: string;
  value: unknown;
  source: string;
}
export interface Recommendations {
  studyId: string;
  generatedAt: string;
  model?: string;
  inputsHash?: string;
  headline: string;
  findings: Array<{ title: string; detail: string; evidence: Evidence[]; strength: Strength }>;
  recommendations: Array<{
    id: string;
    kind: "prix" | "cible" | "offre" | "message" | "questionnaire" | "autre" | string;
    title: string;
    rationale: string;
    evidence: Evidence[];
    confidence: Strength;
    nextStudy?: {
      hypothesis: string;
      successCriterion: string;
      projectPatch: Record<string, unknown>;
      sample: "same_sample" | "new_target" | string;
      n: number;
      control?: unknown;
      estimatedCalls?: number;
      estimatedMinutes?: number;
    };
  }>;
  caveats: string[];
}

export interface RecommendApi {
  /** Signature réelle (src/studies/recommend.ts) : la base, le pack et le dossier du cache sont passés par l'appelant. */
  createNextStudy(studyId: string, recId: string, opts: { confirm: true; db: Db; pack: Pack; outDir?: string }): unknown;
}
export type RecommendLoader = () => Promise<{ api: RecommendApi | null; reason?: string }>;

export function defaultRecommendLoader(): RecommendLoader {
  let cached: RecommendApi | null = null;
  return async () => {
    if (cached) return { api: cached };
    try {
      const spec = "../studies/recommend";
      const mod = (await import(/* @vite-ignore */ spec)) as Partial<RecommendApi>;
      if (typeof mod.createNextStudy !== "function") return { api: null, reason: "Recommandations indisponibles : createNextStudy absente de src/studies/recommend.ts." };
      cached = mod as RecommendApi;
      return { api: cached };
    } catch (err) {
      const msg = (err as Error).message;
      return { api: null, reason: /Cannot find module|ERR_MODULE_NOT_FOUND/i.test(msg) ? "Recommandations indisponibles : src/studies/recommend.ts n'existe pas encore." : `Recommandations indisponibles : ${msg}` };
    }
  };
}

export function recommendationsFile(dataDir: string, studyId: string): string {
  return join(dataDir, "recommendations", `${studyId}.json`);
}

export function readRecommendations(dataDir: string, studyId: string): Recommendations | null {
  const f = recommendationsFile(dataDir, studyId);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, "utf8")) as Recommendations;
  } catch {
    return null;
  }
}

export function registerRecommendRoutes(api: Hono, ctx: AppContext & { dataDir: string; recommend?: RecommendLoader }): void {
  const loader = ctx.recommend ?? defaultRecommendLoader();
  const jobKey = (id: string) => `recommend-${id.replace(/[^A-Za-z0-9_-]+/g, "_")}`;
  const job = (id: string) => {
    const info = ctx.launcher.info(jobKey(id));
    return info && { key: jobKey(id), pid: info.pid, alive: info.alive, startedAt: info.startedAt, log: ctx.launcher.tail(jobKey(id), 4000).text };
  };

  api.get("/studies/:id/recommendations", async (c) => {
    const lang = langOf(c);
    const s = findStudy(ctx.db, c.req.param("id"));
    const rec = readRecommendations(ctx.dataDir, s.id);
    const f = recommendationsFile(ctx.dataDir, s.id);
    const { api: a, reason } = await loader();
    // Cible proposée en clair, à côté de la cible actuelle du projet
    const project = getProject(ctx.db, s.projectId);
    const currentTarget = (project?.extra as ProjectExtra | undefined)?.target ?? null;
    const plainTargets = Object.fromEntries(
      (rec?.recommendations ?? [])
        .filter((r) => r.nextStudy?.projectPatch && typeof r.nextStudy.projectPatch.target === "object")
        .map((r) => {
          const t = r.nextStudy!.projectPatch.target as { eligibility?: string; modules?: string[]; n?: number };
          const after = plainCriteria(t.eligibility ?? null, undefined, lang);
          return [r.id, { before: plainCriteria(currentTarget?.eligibility ?? null, undefined, lang).criteria, after: after.criteria, afterRaw: after.raw }];
        }),
    );
    return c.json({
      plainTargets,
      recommendations: rec,
      generatedAt: rec?.generatedAt ?? (existsSync(f) ? statSync(f).mtime.toISOString() : null),
      job: job(s.id),
      canCreate: Boolean(a),
      ...(reason && { unavailable: messageIn(lang, reason) }),
    });
  });

  /** Lance `study:recommend` (environ une minute) ; `force` régénère malgré le cache. */
  api.post("/studies/:id/recommendations", async (c) => {
    const s = findStudy(ctx.db, c.req.param("id"));
    const { force } = (await c.req.json().catch(() => ({}))) as { force?: boolean };
    try {
      const info = ctx.launcher.startScript(jobKey(s.id), "study:recommend", ["--study", s.id, ...(force ? ["--force"] : [])]);
      return c.json({ key: jobKey(s.id), pid: info.pid, startedAt: info.startedAt }, 202);
    } catch (err) {
      if (err instanceof ScriptMissingError) return c.json({ error: "Recommandations indisponibles : le script study:recommend n'existe pas encore.", unavailable: true }, 503);
      throw err;
    }
  });

  /** Crée la variante du projet et l'étude suivante, sans la lancer. Confirmation obligatoire. */
  api.post("/studies/:id/recommendations/:recId/create-study", async (c) => {
    const s = findStudy(ctx.db, c.req.param("id"));
    const { confirm } = (await c.req.json().catch(() => ({}))) as { confirm?: boolean };
    if (confirm !== true) return c.json({ error: "Confirmation requise (confirm: true)." }, 400);
    const rec = readRecommendations(ctx.dataDir, s.id);
    const r = rec?.recommendations.find((x) => x.id === c.req.param("recId"));
    if (!r) return c.json({ error: `Recommandation introuvable : ${c.req.param("recId")}` }, 404);
    if (!r.nextStudy) return c.json({ error: "Cette recommandation ne propose pas d'étude suivante." }, 400);
    const { api: a, reason } = await loader();
    if (!a) return c.json({ error: reason ?? "Recommandations indisponibles.", unavailable: true }, 503);
    try {
      const out = (await a.createNextStudy(s.id, r.id, { confirm: true, db: ctx.db, pack: ctx.pack, outDir: join(ctx.dataDir, "recommendations") })) as { projectId?: string; projectFile?: string; studyId?: string };
      return c.json({ ...out, ...(out.projectFile && { projectFile: out.projectFile.replace(`${process.cwd()}/`, "") }) }, 201);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 409);
    }
  });
}
