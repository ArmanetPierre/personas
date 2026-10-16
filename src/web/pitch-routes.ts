import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import type { PitchProposal } from "../studies/pitch-neutralize";
import { checkFacts, lexicalTone, namesOf, numbersOf, TONE_CATEGORIES, TONE_CATEGORY_LABELS, TONE_WARNING_THRESHOLD } from "../studies/pitch-tone";
import { getProject, type ProjectExtra } from "../studies/project";
import type { AppContext } from "./app";
import { ScriptMissingError } from "./launcher";
import { applyPitch, BlockError } from "./project-files";
import { labelIn, langOf } from "./i18n";
import { TONE_CATEGORY_LABELS_EN } from "./i18n-labels";

/**
 * Neutralisation du pitch (backend : src/studies/pitch-neutralize.ts, CLI project:neutralize-pitch).
 * L'assistant propose (data/proposals/<projet>-pitch.json), l'utilisateur relit, édite, applique ou garde son pitch.
 * Une proposition appliquée ou écartée est rangée dans data/proposals/archive/ (horodatée).
 */

const safeKey = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, "_");
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

/** Contrôle des faits, avec ce qui est conservé (pour l'afficher en vert) en plus de ce qui manque. */
export function factView(original: string, neutral: string, facts: Array<{ fact: string; keyTerms: string[] }>) {
  const fc = checkFacts(original, neutral, facts);
  return {
    ...fc,
    numbersKept: numbersOf(original).filter((x) => !fc.numbersMissing.includes(x)),
    namesKept: namesOf(original).filter((x) => !fc.namesMissing.includes(x)),
    factsKept: facts.map((f) => f.fact).filter((f) => !fc.factsMissing.includes(f)),
  };
}

export function registerPitchRoutes(api: Hono, ctx: AppContext & { root: string; dataDir: string }): void {
  const { db, launcher } = ctx;
  const proposalFile = (id: string) => join(ctx.dataDir, "proposals", `${safeKey(id)}-pitch.json`);
  const backups = join(ctx.dataDir, "backups", "projects");
  const jobKey = (id: string) => `pitch-${safeKey(id)}`;
  const readProposal = (id: string): PitchProposal | null => {
    const f = proposalFile(id);
    if (!existsSync(f)) return null;
    try {
      return JSON.parse(readFileSync(f, "utf8")) as PitchProposal;
    } catch {
      return null;
    }
  };
  const archive = (id: string, why: "applied" | "dismissed") => {
    const f = proposalFile(id);
    if (!existsSync(f)) return null;
    const dir = join(ctx.dataDir, "proposals", "archive");
    mkdirSync(dir, { recursive: true });
    const to = join(dir, `${safeKey(id)}-pitch-${why}-${stamp()}.json`);
    renameSync(f, to);
    return to.replace(`${ctx.root}/`, "");
  };
  const loadProject = (id: string) => {
    const p = getProject(db, id);
    if (!p) throw new Error(`Projet introuvable : ${id}`);
    return p;
  };
  const job = (id: string) => {
    const info = launcher.info(jobKey(id));
    return info && { key: jobKey(id), pid: info.pid, alive: info.alive, startedAt: info.startedAt, log: launcher.tail(jobKey(id), 4000).text };
  };

  /** Pitch actuel, son score de ton, l'original conservé et la proposition en attente. */
  api.get("/projects/:id/pitch", (c) => {
    const p = loadProject(c.req.param("id"));
    const extra = p.extra as ProjectExtra;
    const tone = lexicalTone(p.pitch);
    const proposal = readProposal(p.id);
    return c.json({
      pitch: p.pitch,
      pitchOriginal: extra.pitchOriginal ?? null,
      pitchNeutralized: extra.pitchNeutralized === true,
      tone: { score: tone.score, hits: tone.hits, words: tone.words, threshold: TONE_WARNING_THRESHOLD, warn: tone.score >= TONE_WARNING_THRESHOLD },
      categories: TONE_CATEGORIES.map((id) => ({ id, label: labelIn(langOf(c), TONE_CATEGORY_LABELS_EN, id, TONE_CATEGORY_LABELS[id]) })),
      // Une proposition faite sur un autre texte que le pitch actuel est périmée (le pitch a changé depuis)
      proposal: proposal && {
        ...proposal,
        factView: factView(proposal.original, proposal.neutral, proposal.facts ?? []),
        stale: proposal.original.trim() !== p.pitch.trim(),
        file: proposalFile(p.id).replace(`${ctx.root}/`, ""),
      },
      job: job(p.id),
    });
  });

  /** Lance project:neutralize-pitch (claude-cli, environ une minute). */
  api.post("/projects/:id/pitch/neutralize", (c) => {
    const p = loadProject(c.req.param("id"));
    try {
      const info = launcher.startScript(jobKey(p.id), "project:neutralize-pitch", ["--project", p.id, "--out", proposalFile(p.id)]);
      return c.json({ key: jobKey(p.id), pid: info.pid, startedAt: info.startedAt }, 202);
    } catch (err) {
      if (err instanceof ScriptMissingError) return c.json({ error: "Le script project:neutralize-pitch n'existe pas.", unavailable: true }, 503);
      throw err;
    }
  });

  /** Contrôle d'une version éditée, sans modèle : score lexical et conservation des faits de l'original. */
  api.post("/projects/:id/pitch/check", async (c) => {
    const p = loadProject(c.req.param("id"));
    const { text } = (await c.req.json().catch(() => ({}))) as { text?: string };
    if (typeof text !== "string" || !text.trim()) return c.json({ error: "Texte requis." }, 400);
    const proposal = readProposal(p.id);
    const original = proposal?.original ?? p.pitch;
    const tone = lexicalTone(text);
    return c.json({ tone: { score: tone.score, hits: tone.hits, threshold: TONE_WARNING_THRESHOLD }, factView: factView(original, text, proposal?.facts ?? []) });
  });

  /** Applique la version neutre (ou éditée) : `pitch` remplacé, `pitchOriginal` conservé, sauvegarde. */
  api.put("/projects/:id/pitch", async (c) => {
    const id = c.req.param("id");
    const { pitch, confirm } = (await c.req.json().catch(() => ({}))) as { pitch?: string; confirm?: boolean };
    if (confirm !== true) return c.json({ error: "Confirmation requise (confirm: true)." }, 400);
    if (typeof pitch !== "string") return c.json({ error: "Pitch requis." }, 400);
    try {
      const r = applyPitch(db, id, pitch, { root: ctx.root, backupDir: backups });
      const archived = archive(id, "applied");
      return c.json({ ...r, file: r.file?.replace(`${ctx.root}/`, ""), backup: r.backup.replace(`${ctx.root}/`, ""), archived });
    } catch (err) {
      if (err instanceof BlockError) return c.json({ error: err.message, errors: err.errors }, 400);
      throw err;
    }
  });

  /** « Garder mon pitch » : la proposition est archivée, le projet n'est pas modifié. */
  api.post("/projects/:id/pitch/dismiss", (c) => {
    const p = loadProject(c.req.param("id"));
    const archived = archive(p.id, "dismissed");
    if (!archived) return c.json({ error: "Aucune proposition en attente." }, 404);
    return c.json({ archived });
  });
}
