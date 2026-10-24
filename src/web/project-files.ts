import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { parse as parseYaml, parseDocument, stringify as toYaml } from "yaml";
import type { Db } from "../db/client";
import { projects } from "../db/schema";
import { targetSpecSchema } from "../population/target";
import { runMode } from "../config";
import { createProject, getProject, projectFileSchema, type ProjectExtra } from "../studies/project";
import { projectProtocolSchema } from "../studies/protocols/protocol";

/**
 * Remplacement d'un bloc du projet (`target` ou `protocol`) depuis le tableau de bord.
 *
 * Source de vérité : le FICHIER projet quand le projet en vient (`extra.sourceFile`, ex. examples/<projet>.yaml).
 * `study:create --project <fichier>` relit ce fichier et met la base à jour : modifier seulement la base serait
 * écrasé au prochain usage. On réécrit donc le fichier (YAML : commentaires et mise en forme du reste conservés),
 * on sauvegarde l'ancienne version, puis on resynchronise la base depuis le fichier. Sans fichier, on met à jour
 * la base seulement (ancien bloc sauvegardé en JSON).
 */

export type ProjectBlock = "target" | "protocol";

export interface ApplyResult {
  source: "file" | "db";
  file?: string;
  backup: string;
  previous: unknown;
  next: unknown;
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

export function validateBlock(key: ProjectBlock, value: unknown): { ok: boolean; errors: Array<{ path: string; message: string }>; value?: unknown } {
  const schema = key === "target" ? targetSpecSchema : projectProtocolSchema;
  const r = schema.safeParse(value);
  if (r.success) return { ok: true, errors: [], value: r.data };
  return { ok: false, errors: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) };
}

/**
 * Fichier source d'un projet, résolu depuis la racine du dépôt ; null s'il n'existe pas. Service hébergé : toujours
 * null (les projets n'existent qu'en base ; un nom de fichier envoyé par un utilisateur n'est jamais lu ni écrit).
 */
export function projectSourceFile(root: string, sourceFile: string | undefined): string | null {
  if (!sourceFile || runMode() === "hosted") return null;
  const abs = isAbsolute(sourceFile) ? sourceFile : resolve(root, sourceFile);
  return existsSync(abs) && /\.(ya?ml|json)$/i.test(abs) ? abs : null;
}

export function applyProjectBlock(db: Db, projectId: string, key: ProjectBlock, value: unknown, opts: { root: string; backupDir: string }): ApplyResult {
  const row = getProject(db, projectId);
  if (!row) throw new Error(`Projet introuvable : ${projectId}`);
  const v = validateBlock(key, value);
  if (!v.ok) throw new BlockError(`Bloc ${key} invalide.`, v.errors);
  const extra = row.extra as ProjectExtra & Record<string, unknown>;
  const previous = extra[key] ?? null;
  mkdirSync(opts.backupDir, { recursive: true });
  const file = projectSourceFile(opts.root, extra.sourceFile);

  if (file) {
    const text = readFileSync(file, "utf8");
    const yaml = /\.ya?ml$/i.test(file);
    let next: string;
    if (yaml) {
      const doc = parseDocument(text);
      doc.set(key, doc.createNode(value));
      next = doc.toString({ lineWidth: 110 });
    } else {
      const obj = JSON.parse(text) as Record<string, unknown>;
      obj[key] = value;
      next = `${JSON.stringify(obj, null, 2)}\n`;
    }
    // Le fichier modifié doit rester un projet valide
    const parsed = projectFileSchema.safeParse(yaml ? parseYaml(next) : JSON.parse(next));
    if (!parsed.success) throw new BlockError("Le fichier projet modifié serait invalide : rien n'a été écrit.", parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
    if ((parsed.data.id ?? projectId) !== projectId) throw new Error(`Le fichier ${file} décrit le projet ${parsed.data.id}, pas ${projectId}.`);
    const backup = join(opts.backupDir, `${projectId}-${key}-${stamp()}${extname(file)}`);
    copyFileSync(file, backup);
    writeFileSync(file, next);
    createProject(db, parsed.data, { sourceFile: extra.sourceFile!, update: true });
    return { source: "file", file, backup, previous, next: v.value };
  }

  const backup = join(opts.backupDir, `${projectId}-${key}-${stamp()}.json`);
  writeFileSync(backup, JSON.stringify({ project: projectId, key, previous, replacedAt: new Date().toISOString() }, null, 2));
  db.update(projects).set({ extra: { ...extra, [key]: v.value } }).where(eq(projects.id, projectId)).run();
  return { source: "db", backup, previous, next: v.value };
}

export class BlockError extends Error {
  constructor(
    message: string,
    readonly errors: Array<{ path: string; message: string }>,
  ) {
    super(message);
  }
}

/** Rendu YAML d'un bloc, pour le diff affiché avant d'appliquer. */
export function blockYaml(key: ProjectBlock, value: unknown): string {
  return value === null || value === undefined ? `# pas de bloc ${key}\n` : toYaml({ [key]: value }, { lineWidth: 110 });
}

export const backupName = (p: string) => basename(p);

// ─── Pitch neutralisé ─────────────────────────────────────────────────────────

export interface PitchApplyResult {
  source: "file" | "db";
  file?: string;
  backup: string;
  previous: string;
  pitch: string;
  pitchOriginal: string;
}

/**
 * Remplace le pitch testé par une version neutre (ou éditée), avec la même source de vérité que les blocs :
 * fichier projet s'il existe (sauvegarde, réécriture, `createProject --update`), sinon la base.
 * `pitchOriginal` garde le texte d'origine du porteur : s'il existe déjà (seconde neutralisation), il n'est pas écrasé.
 */
export function applyPitch(db: Db, projectId: string, pitch: string, opts: { root: string; backupDir: string }): PitchApplyResult {
  const row = getProject(db, projectId);
  if (!row) throw new Error(`Projet introuvable : ${projectId}`);
  const text = pitch.trim();
  if (text.length < 20) throw new BlockError("Pitch trop court (20 caractères au moins).", [{ path: "pitch", message: "trop court" }]);
  const extra = row.extra as ProjectExtra & Record<string, unknown>;
  const previous = row.pitch;
  const pitchOriginal = (typeof extra.pitchOriginal === "string" && extra.pitchOriginal) || previous;
  mkdirSync(opts.backupDir, { recursive: true });
  const file = projectSourceFile(opts.root, extra.sourceFile);

  if (file) {
    const raw = readFileSync(file, "utf8");
    const yaml = /\.ya?ml$/i.test(file);
    let next: string;
    if (yaml) {
      const doc = parseDocument(raw);
      doc.set("pitch", text);
      doc.set("pitchOriginal", pitchOriginal);
      doc.set("pitchNeutralized", true);
      next = doc.toString({ lineWidth: 110 });
    } else {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      Object.assign(obj, { pitch: text, pitchOriginal, pitchNeutralized: true });
      next = `${JSON.stringify(obj, null, 2)}\n`;
    }
    const parsed = projectFileSchema.safeParse(yaml ? parseYaml(next) : JSON.parse(next));
    if (!parsed.success) throw new BlockError("Le fichier projet modifié serait invalide : rien n'a été écrit.", parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
    if ((parsed.data.id ?? projectId) !== projectId) throw new Error(`Le fichier ${file} décrit le projet ${parsed.data.id}, pas ${projectId}.`);
    const backup = join(opts.backupDir, `${projectId}-pitch-${stamp()}${extname(file)}`);
    copyFileSync(file, backup);
    writeFileSync(file, next);
    createProject(db, parsed.data, { sourceFile: extra.sourceFile!, update: true });
    return { source: "file", file, backup, previous, pitch: text, pitchOriginal };
  }

  const backup = join(opts.backupDir, `${projectId}-pitch-${stamp()}.json`);
  writeFileSync(backup, JSON.stringify({ project: projectId, key: "pitch", previous, extra: { pitchOriginal: extra.pitchOriginal ?? null, pitchNeutralized: extra.pitchNeutralized ?? null }, replacedAt: new Date().toISOString() }, null, 2));
  db.update(projects).set({ pitch: text, extra: { ...extra, pitchOriginal, pitchNeutralized: true } }).where(eq(projects.id, projectId)).run();
  return { source: "db", backup, previous, pitch: text, pitchOriginal };
}
