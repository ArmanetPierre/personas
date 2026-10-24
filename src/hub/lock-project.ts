import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { projects, type Project } from "../db/schema";
import type { LoadedModule } from "../modules/registry";
import { prepareTarget, resolveSoclePack, type TargetSpec } from "../population/target";
import type { ProjectExtra } from "../studies/project";
import { childSocle, prepareChild, projectRoles } from "../studies/roles";
import { LOCK_VERSION, moduleEntries, socleEntry, type ProjectLock } from "./lock";

/** Cibles d'un projet : `target`, `control`, et la cible de chaque rôle. */
export function projectTargets(p: Pick<Project, "extra">): Array<{ label: string; spec: TargetSpec }> {
  const extra = (p.extra ?? {}) as ProjectExtra;
  const out: Array<{ label: string; spec: TargetSpec }> = [];
  if (extra.target) out.push({ label: "target", spec: extra.target });
  if (extra.control) out.push({ label: "control", spec: extra.control });
  for (const r of projectRoles(p)) out.push({ label: r.id, spec: r.target as TargetSpec });
  return out;
}

/**
 * Lock d'un projet, calculé sur la résolution actuelle (bibliothèque locale puis cache du Hub, versions
 * explicites `ref@version` de la cible respectées). Sans réseau. Lève si une cible ne se résout pas ou si un
 * module est demandé en deux versions par deux cibles.
 */
export function buildProjectLock(p: Pick<Project, "extra">, opts: { library?: Map<string, LoadedModule>; now?: Date } = {}): ProjectLock {
  const lock: ProjectLock = { lockVersion: LOCK_VERSION, generatedAt: (opts.now ?? new Date()).toISOString(), socles: {}, modules: {} };
  const add = (entries: ProjectLock["modules"], label: string) => {
    for (const [ref, e] of Object.entries(entries)) {
      const was = lock.modules[ref];
      if (was && (was.version !== e.version || was.sha256 !== e.sha256)) throw new Error(`Lock : ${ref} demandé en ${was.version} et en ${e.version} (cible ${label})`);
      lock.modules[ref] = e;
    }
  };
  const targets = projectTargets(p);
  if (!targets.length) throw new Error("Le projet ne déclare aucune cible (target, control ou rôles) : rien à épingler.");
  for (const { label, spec } of targets) {
    const prepared = prepareTarget(spec, opts.library ? { library: opts.library } : {});
    const socle = spec.socle ?? "fr";
    const entry = socleEntry(prepared.pack);
    const was = lock.socles[socle];
    if (was && was.version !== entry.version) throw new Error(`Lock : socle ${socle} résolu en ${was.version} et en ${entry.version}`);
    lock.socles[socle] = entry;
    add(moduleEntries(prepared.modules), label);
  }
  for (const r of projectRoles(p)) {
    if (!r.child?.modules?.length) continue;
    const base = resolveSoclePack(r.target.socle ?? "fr").socle;
    add(moduleEntries(prepareChild(r.child, base, opts.library).modules), `${r.id} (enfant, ${childSocle(base)})`);
  }
  lock.modules = Object.fromEntries(Object.entries(lock.modules).sort(([a], [b]) => (a < b ? -1 : 1)));
  return lock;
}

/** Enregistre le lock dans `projects.extra.lock` (les études créées ensuite l'appliquent). */
export function storeProjectLock(db: Db, projectId: string, lock: ProjectLock): void {
  const row = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!row) throw new Error(`Projet introuvable : ${projectId}`);
  db.update(projects).set({ extra: { ...(row.extra as object), lock } }).where(eq(projects.id, projectId)).run();
}
