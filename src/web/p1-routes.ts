import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Hono } from "hono";
import { parse as parseYaml } from "yaml";
import { lineDiff } from "../modules/assistant/diff";
import { previewTarget } from "../population/preview";
import { suggestionDocument, suggestionPath, type TargetSuggestion } from "../population/suggest";
import { getProject, type ProjectExtra } from "../studies/project";
import { QUESTION_KEY } from "../studies/protocols/concept-price";
import {
  CANONICAL_LEVELS,
  CANONICAL_OBJECTIONS,
  CANONICAL_RELEVANCE,
  DEFAULT_BEHAVIORS,
  LEVEL_LABELS,
  PRODUCT_TYPES,
  resolveProtocol,
} from "../studies/protocols/protocol";
import { readTaxonomy, recodedDistribution, type Taxonomy } from "../studies/recode";
import { findStudy, studyResponses } from "../studies/store";
import type { AppContext } from "./app";
import { langOf, overlay } from "./i18n";
import { CANONICAL_OBJECTION_LABELS_EN, LEVEL_LABELS_EN, PRODUCT_TYPE_LABELS_EN, RELEVANCE_LABELS_EN, standardProtocolIn } from "./i18n-labels";
import { applyProjectBlock, blockYaml, BlockError, projectSourceFile, validateBlock, type ProjectBlock } from "./project-files";

/**
 * Routes du lot P1 : aperçu de cible (rapide, ou avec pré-tri Qwen en tâche détachée), assistant de cible,
 * protocole adaptable (proposition, revue, application), recodage des objections. Les tâches longues lancent
 * `src/web/jobs/*` ou les CLI du backend par le lanceur (environnement sans `ANTHROPIC_*`) ; leurs résultats
 * sont des fichiers JSON relus par l'API.
 */

export const PRODUCT_TYPE_LABELS: Record<string, string> = {
  app_install: "Application à installer",
  online_service: "Service en ligne",
  marketplace_network: "Réseau ou place de marché",
  physical_product: "Produit physique",
  subscription_content: "Abonnement à du contenu",
  b2b_tool: "Outil professionnel (B2B)",
};
const CANONICAL_OBJECTION_LABELS: Record<string, string> = {
  price: "Prix",
  no_need: "Pas de besoin",
  already_covered: "Déjà couvert",
  trust_privacy: "Confiance, vie privée",
  effort_time: "Effort ou temps",
  network_effect: "Effet réseau",
  other: "Autre",
};
const CANONICAL_RELEVANCE_LABELS: Record<string, string> = { concerned: "Concernée", marginal: "Marginalement concernée", not_concerned: "Pas concernée" };

const SAFE = /^[A-Za-z0-9_-]+$/;
const safeKey = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, "_");

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

const mtime = (p: string) => {
  try {
    return statSync(p).mtime.toISOString();
  } catch {
    return null;
  }
};

export function registerP1Routes(api: Hono, ctx: AppContext & { root: string; dataDir: string }): void {
  const { db, launcher } = ctx;
  const paths = {
    preview: (projectId: string, group: string, seed: number, n: number | null) =>
      join(ctx.dataDir, "previews", `${safeKey(projectId)}-${safeKey(group)}-s${seed}${n ? `-n${n}` : ""}-triage.json`),
    suggestion: (projectId: string) => join(ctx.dataDir, "suggestions", `${safeKey(projectId)}.target-suggestion.json`),
    protocol: (projectId: string) => join(ctx.dataDir, "proposals", `${safeKey(projectId)}-protocol.json`),
    taxonomy: (projectId: string) => join(ctx.dataDir, "proposals", `${safeKey(projectId)}-taxonomy.json`),
    backups: join(ctx.dataDir, "backups", "projects"),
  };
  const job = (key: string) => {
    const info = launcher.info(key);
    if (!info) return null;
    const tail = launcher.tail(key, 4000);
    return { key, pid: info.pid, alive: info.alive, startedAt: info.startedAt, log: tail.text };
  };
  const loadProject = (id: string) => {
    const p = getProject(db, id);
    if (!p) throw new Error(`Projet introuvable : ${id}`);
    return p;
  };
  const int = (x: string | undefined, def: number | null) => (x && Number.isFinite(Number(x)) ? Math.round(Number(x)) : def);

  api.get("/jobs/:key", (c) => {
    const key = c.req.param("key");
    if (!SAFE.test(key)) return c.json({ error: "Clé invalide." }, 400);
    return c.json(job(key) ?? { key, pid: null, alive: false, startedAt: null, log: "" });
  });

  // ── Aperçu de cible ──
  /** Aperçu rapide, sans pré-tri : tirage virtuel, distributions, fiches (quelques secondes). */
  api.get("/projects/:id/target-preview", async (c) => {
    const p = loadProject(c.req.param("id"));
    const group = c.req.query("group") || "target";
    const n = int(c.req.query("n"), null);
    const seed = int(c.req.query("seed"), 42)!;
    const sample = Math.min(Math.max(int(c.req.query("sample"), 10)!, 0), 20);
    try {
      const preview = await previewTarget(p, { group, seed, sample, ...(n && { n }) });
      return c.json(preview);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  /** Résultat du pré-tri en cache (fichier) et état de la tâche. */
  api.get("/projects/:id/target-preview/triage", (c) => {
    const p = loadProject(c.req.param("id"));
    const group = c.req.query("group") || "target";
    const seed = int(c.req.query("seed"), 42)!;
    const n = int(c.req.query("n"), null);
    const file = paths.preview(p.id, group, seed, n);
    const key = `preview-${safeKey(p.id)}-${safeKey(group)}-s${seed}${n ? `-n${n}` : ""}`;
    return c.json({ result: existsSync(file) ? readJson(file) : null, generatedAt: mtime(file), job: job(key) });
  });

  /** Lance l'aperçu avec pré-tri Qwen (plusieurs minutes ; les appels déjà faits sont en cache). */
  api.post("/projects/:id/target-preview/triage", async (c) => {
    const p = loadProject(c.req.param("id"));
    const body = (await c.req.json().catch(() => ({}))) as { group?: string; seed?: number; n?: number; sample?: number };
    const group = body.group || "target";
    const seed = Number.isInteger(body.seed) ? body.seed! : 42;
    const n = Number.isInteger(body.n) ? body.n! : null;
    const key = `preview-${safeKey(p.id)}-${safeKey(group)}-s${seed}${n ? `-n${n}` : ""}`;
    const out = paths.preview(p.id, group, seed, n);
    const info = launcher.startFile(key, "src/web/jobs/target-preview.ts", ["--project", p.id, "--group", group, "--seed", String(seed), "--sample", String(body.sample ?? 10), "--out", out, ...(n ? ["--n", String(n)] : [])]);
    return c.json({ key, pid: info.pid, startedAt: info.startedAt }, 202);
  });

  // ── Assistant de cible ──
  /** Dernière proposition : JSON complet de la tâche du tableau de bord, sinon fichier YAML de `target:suggest`. */
  api.get("/projects/:id/target-suggestion", (c) => {
    const p = loadProject(c.req.param("id"));
    const extra = p.extra as ProjectExtra;
    const jsonFile = paths.suggestion(p.id);
    const src = projectSourceFile(ctx.root, extra.sourceFile);
    const yamlFile = suggestionPath(src, p.id);
    const yamlAlt = resolve(ctx.dataDir, "suggestions", `${p.id}.target-suggestion.yaml`);
    let doc: Record<string, unknown> | null = null;
    let from: string | null = null;
    const jsonAt = mtime(jsonFile);
    const yamlPath = existsSync(yamlFile) ? yamlFile : existsSync(yamlAlt) ? yamlAlt : null;
    const yamlAt = yamlPath ? mtime(yamlPath) : null;
    if (jsonAt && (!yamlAt || jsonAt >= yamlAt)) {
      const s = readJson<TargetSuggestion>(jsonFile);
      if (s) {
        doc = suggestionDocument(s);
        from = jsonFile;
      }
    }
    if (!doc && yamlPath) {
      try {
        doc = parseYaml(readFileSync(yamlPath, "utf8")) as Record<string, unknown>;
        from = yamlPath;
      } catch {
        doc = null;
      }
    }
    return c.json({ suggestion: doc, file: from && from.replace(`${ctx.root}/`, ""), job: job(`suggest-${safeKey(p.id)}`), current: extra.target ?? null, currentYaml: blockYaml("target", extra.target ?? null) });
  });

  api.post("/projects/:id/target-suggestion", (c) => {
    const p = loadProject(c.req.param("id"));
    const key = `suggest-${safeKey(p.id)}`;
    const info = launcher.startFile(key, "src/web/jobs/target-suggest.ts", ["--project", p.id, "--out", paths.suggestion(p.id)]);
    return c.json({ key, pid: info.pid, startedAt: info.startedAt }, 202);
  });

  // ── Blocs du projet : validation, diff, application ──
  api.post("/projects/:id/blocks/:key/validate", async (c) => {
    const key = c.req.param("key") as ProjectBlock;
    if (key !== "target" && key !== "protocol") return c.json({ error: "Bloc inconnu." }, 400);
    const p = loadProject(c.req.param("id"));
    const { value } = (await c.req.json()) as { value?: unknown };
    const v = validateBlock(key, value);
    const current = (p.extra as Record<string, unknown>)[key] ?? null;
    const before = blockYaml(key, current);
    const after = blockYaml(key, v.ok ? v.value : value);
    return c.json({ ok: v.ok, errors: v.errors, before, after, diff: lineDiff(before, after, 3) });
  });

  /** Remplace le bloc `target` ou `protocol` du projet (fichier source si le projet en vient, sinon base). */
  api.put("/projects/:id/blocks/:key", async (c) => {
    const key = c.req.param("key") as ProjectBlock;
    if (key !== "target" && key !== "protocol") return c.json({ error: "Bloc inconnu." }, 400);
    const { value, confirm } = (await c.req.json()) as { value?: unknown; confirm?: boolean };
    if (confirm !== true) return c.json({ error: "Confirmation requise (confirm: true)." }, 400);
    try {
      const r = applyProjectBlock(db, c.req.param("id"), key, value, { root: ctx.root, backupDir: paths.backups });
      return c.json({ ...r, file: r.file?.replace(`${ctx.root}/`, ""), backup: r.backup.replace(`${ctx.root}/`, "") });
    } catch (err) {
      if (err instanceof BlockError) return c.json({ error: err.message, errors: err.errors }, 400);
      throw err;
    }
  });

  // ── Protocole ──
  api.get("/projects/:id/protocol", (c) => {
    const lang = langOf(c);
    const productTypeLabels = overlay(lang, PRODUCT_TYPE_LABELS, PRODUCT_TYPE_LABELS_EN);
    const levelLabels = overlay(lang, LEVEL_LABELS, LEVEL_LABELS_EN);
    const objectionLabels = overlay(lang, CANONICAL_OBJECTION_LABELS, CANONICAL_OBJECTION_LABELS_EN);
    const relevanceLabels = overlay(lang, CANONICAL_RELEVANCE_LABELS, RELEVANCE_LABELS_EN);
    const p = loadProject(c.req.param("id"));
    const raw = (p.extra as ProjectExtra).protocol ?? null;
    const resolved = standardProtocolIn(lang, resolveProtocol(p));
    const proposalFile = paths.protocol(p.id);
    const proposal = readJson<{ protocol?: unknown; rationale?: string; generatedAt?: string; model?: string; fixes?: string[]; evidence?: { studies?: string[]; respondents?: number; shares?: Record<string, number> } }>(proposalFile);
    return c.json({
      raw,
      resolved,
      proposal: proposal && {
        protocol: proposal.protocol ?? null,
        rationale: proposal.rationale ?? (proposal.protocol as { rationale?: string } | undefined)?.rationale ?? null,
        generatedAt: proposal.generatedAt ?? mtime(proposalFile),
        model: proposal.model ?? null,
        fixes: proposal.fixes ?? [],
        evidence: proposal.evidence ? { studies: proposal.evidence.studies ?? [], respondents: proposal.evidence.respondents ?? null, shares: proposal.evidence.shares ?? {} } : null,
        file: proposalFile.replace(`${ctx.root}/`, ""),
      },
      job: job(`protocol-${safeKey(p.id)}`),
      vocab: {
        productTypes: PRODUCT_TYPES.map((id) => ({ id, label: productTypeLabels[id] ?? id })),
        levels: CANONICAL_LEVELS.map((id) => ({ id, label: levelLabels[id] ?? id })),
        objections: CANONICAL_OBJECTIONS.map((id) => ({ id, label: objectionLabels[id] ?? id })),
        relevance: CANONICAL_RELEVANCE.map((id) => ({ id, label: relevanceLabels[id] ?? id })),
        defaultBehaviors: DEFAULT_BEHAVIORS,
      },
    });
  });

  api.post("/projects/:id/protocol/suggest", (c) => {
    const p = loadProject(c.req.param("id"));
    const key = `protocol-${safeKey(p.id)}`;
    const info = launcher.startScript(key, "project:suggest-protocol", ["--project", p.id, "--out", paths.protocol(p.id)]);
    return c.json({ key, pid: info.pid, startedAt: info.startedAt }, 202);
  });

  // ── Recodage des objections ──
  /** Taxonomie utilisable pour recoder une étude : protocole du projet, sinon la proposition en attente. */
  const taxonomyFor = (projectId: string): { key: string; source: "protocol" | "proposal"; file: string; taxonomy: Taxonomy } | null => {
    const p = getProject(db, projectId);
    if (!p) return null;
    const objections = (p.extra as ProjectExtra).protocol?.objections;
    if (objections?.length) {
      const file = paths.taxonomy(p.id);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ objections }, null, 2));
      return { key: p.id, source: "protocol", file, taxonomy: { key: p.id, objections } };
    }
    const proposal = paths.protocol(p.id);
    if (existsSync(proposal)) {
      try {
        return { key: p.id, source: "proposal", file: proposal, taxonomy: readTaxonomy(proposal, p.id) };
      } catch {
        return null;
      }
    }
    return null;
  };

  api.get("/studies/:id/recoded", (c) => {
    const s = findStudy(db, c.req.param("id"));
    const dir = join(ctx.dataDir, "summaries");
    const taxos = new Map<string, Taxonomy>();
    if (existsSync(dir)) {
      for (const f of readdirSync(dir)) {
        if (!f.startsWith(`${s.id}-recode-`) || !f.endsWith(".json")) continue;
        const t = readJson<{ taxonomy?: Taxonomy }>(join(dir, f))?.taxonomy;
        if (t?.key && Array.isArray(t.objections)) taxos.set(t.key, t);
      }
    }
    const rows = studyResponses(db, s.id, QUESTION_KEY);
    const groupOf = (personaId: string) => s.personaGroups?.[personaId] ?? "target";
    const groups = [...new Set(rows.map((r) => groupOf(r.personaId)))];
    const recodings = [...taxos.values()].map((t) => ({
      key: t.key,
      objections: t.objections,
      overall: recodedDistribution(rows, t),
      groups: Object.fromEntries(groups.map((g) => [g, recodedDistribution(rows.filter((r) => groupOf(r.personaId) === g), t)])),
    }));
    const available = taxonomyFor(s.projectId);
    return c.json({
      recodings: recodings.filter((r) => r.overall),
      available: available && { key: available.key, source: available.source, count: available.taxonomy.objections.length },
      job: job(`recode-${safeKey(s.id)}`),
    });
  });

  api.post("/studies/:id/recode", (c) => {
    const s = findStudy(db, c.req.param("id"));
    const t = taxonomyFor(s.projectId);
    if (!t) return c.json({ error: "Pas de taxonomie d'objections pour ce projet : ni bloc protocol, ni proposition de protocole." }, 400);
    const key = `recode-${safeKey(s.id)}`;
    const info = launcher.startScript(key, "study:recode", ["--study", s.id, "--taxonomy", t.file, "--key", t.key]);
    return c.json({ key, pid: info.pid, startedAt: info.startedAt, taxonomy: t.key, source: t.source }, 202);
  });
}
