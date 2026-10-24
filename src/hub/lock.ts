import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { parse as parseYaml, stringify as toYaml } from "yaml";
import { z } from "zod";
import type { ModulePins, ResolvedModules } from "../modules/registry";
import { canonicalRef, qualifiedRef } from "../modules/refs";
import { findPack, packSha256 } from "../personas/pack-source";
import type { Pack } from "../personas/pack";
import { sha256Hex } from "./contract";

/**
 * Lock d'un projet (docs/plateforme.md § 4.5) : versions exactes et sha256 du socle et des modules qu'il
 * utilise, pour qu'une étude soit rejouable à l'identique, y compris hors ligne à partir du cache du Hub.
 *
 * Où il vit (choix) : dans la base (`projects.extra.lock`, source de vérité du runner et des études) et, quand
 * le projet vient d'un fichier, dans un fichier voisin `<projet>.personas.lock` (YAML), relu par
 * `project:create`. Pas de bloc dans le fichier projet lui-même : on ne réécrit jamais un fichier rédigé à la
 * main (commentaires, ordre, format JSON ou YAML), et le lock se versionne et se relit à part, comme un
 * package-lock. Rien n'est jamais mis à jour implicitement : seul `personas hub lock` (ré)écrit un lock.
 */

export const LOCK_VERSION = 1;

const source = z.enum(["local", "hub-cache"]);

export const lockSchema = z
  .object({
    lockVersion: z.literal(LOCK_VERSION),
    generatedAt: z.string(),
    /** Socle de chaque cible, par nom de socle du projet (`fr`, `sg`). */
    socles: z.record(z.string(), z.object({ ref: z.string(), version: z.string(), sha256: sha256Hex, source }).strict()).default({}),
    /** Modules, par référence qualifiée (`personas/numerique`, `alice/sport-connecte`). */
    modules: z.record(z.string(), z.object({ version: z.string(), sha256: sha256Hex, source }).strict()).default({}),
  })
  .strict();
export type ProjectLock = z.infer<typeof lockSchema>;
export type LockedModule = ProjectLock["modules"][string];
export type LockedSocle = ProjectLock["socles"][string];

/** Versions imposées par le lock aux références canoniques (`numerique`, `alice/sport`). */
export function lockPins(lock: ProjectLock | undefined | null): ModulePins | undefined {
  if (!lock) return undefined;
  return new Map(Object.entries(lock.modules).map(([ref, e]) => [canonicalRef(ref), { version: e.version, sha256: e.sha256 }]));
}

/** Entrée de lock d'un socle chargé (ref qualifiée, version, sha256 de ses fichiers). */
export function socleEntry(pack: Pack): LockedSocle {
  const version = pack.manifest.version;
  const hit = findPack(version);
  const sha256 = packSha256(version);
  if (!hit || !sha256) throw new Error(`Pack ${version} introuvable : impossible de l'épingler`);
  return { ref: hit.ref ?? `personas/${pack.socle}`, version, sha256, source: hit.source };
}

/** Entrées de lock des modules résolus (dépendances comprises). */
export function moduleEntries(resolved: ResolvedModules): ProjectLock["modules"] {
  const out: ProjectLock["modules"] = {};
  for (const m of resolved.ordered) {
    if (!m.sha256) throw new Error(`Module ${m.def.id} sans empreinte (module en mémoire ou brouillon) : impossible de l'épingler`);
    out[qualifiedRef(m.def.id)] = { version: m.def.version, sha256: m.sha256, source: m.source ?? "local" };
  }
  return out;
}

/** Fichier lock voisin d'un fichier projet : `examples/projet.yaml` → `examples/projet.personas.lock`. */
export function lockPathFor(projectFile: string): string {
  return join(dirname(projectFile), `${basename(projectFile, extname(projectFile))}.personas.lock`);
}

export function readLockFile(path: string): ProjectLock {
  return lockSchema.parse(parseYaml(readFileSync(path, "utf8")));
}

/** Lock du fichier voisin d'un fichier projet, s'il existe. */
export function readSidecarLock(projectFile: string): ProjectLock | undefined {
  const path = lockPathFor(projectFile);
  return existsSync(path) ? readLockFile(path) : undefined;
}

export function writeLockFile(path: string, lock: ProjectLock): string {
  writeFileSync(
    path,
    "# personas.lock : versions exactes et sha256 du socle et des modules du projet (personas hub lock).\n" +
      "# Écrit par la commande, à versionner avec le projet ; jamais mis à jour implicitement.\n" +
      toYaml(lock, { lineWidth: 0 }),
  );
  return path;
}

/** Différences entre deux locks (affichage) : « personas/numerique 2026.3 → 2026.4 », ajouts, retraits. */
export function lockDiff(before: ProjectLock | undefined, after: ProjectLock): string[] {
  const out: string[] = [];
  const b = before?.modules ?? {};
  for (const [ref, e] of Object.entries(after.modules)) {
    const was = b[ref];
    if (!was) out.push(`+ ${ref}@${e.version}`);
    else if (was.version !== e.version || was.sha256 !== e.sha256) out.push(`~ ${ref} ${was.version} → ${e.version}`);
  }
  for (const ref of Object.keys(b)) if (!after.modules[ref]) out.push(`- ${ref}@${b[ref]!.version}`);
  for (const [s, e] of Object.entries(after.socles)) {
    const was = before?.socles[s];
    if (!was) out.push(`+ socle ${s} : ${e.ref}@${e.version}`);
    else if (was.version !== e.version || was.sha256 !== e.sha256) out.push(`~ socle ${s} : ${was.version} → ${e.version}`);
  }
  return out;
}
