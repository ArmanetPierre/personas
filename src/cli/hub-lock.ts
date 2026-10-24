import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, loadDotEnv } from "../config";
import { openDb } from "../db/client";
import { lockDiff, lockPathFor, readSidecarLock, writeLockFile, type ProjectLock } from "../hub/lock";
import { buildProjectLock, storeProjectLock } from "../hub/lock-project";
import { getProject, readProjectFile, slugify, type ProjectExtra } from "../studies/project";
import { errorText, t } from "./i18n";

/**
 * Lock d'un projet : versions exactes et sha256 du socle et des modules de ses cibles (target, control, rôles),
 * résolus sans réseau (bibliothèque locale puis cache du Hub). Écrit dans `projects.extra.lock` (si le projet
 * est en base) et dans le fichier voisin `<projet>.personas.lock` (si le projet vient d'un fichier). Les études
 * créées ensuite utilisent ces versions, y compris hors ligne. Jamais de mise à jour implicite.
 *
 *   personas hub lock <projet : id | fichier> [--check]
 */

const { values, positionals } = parseArgs({ allowPositionals: true, options: { check: { type: "boolean", default: false }, help: { type: "boolean", short: "h" } } });
const arg = positionals[0];
if (values.help || !arg) {
  console.log(t.hub.lockUsage);
  process.exit(values.help ? 0 : 2);
}
loadDotEnv();
const config = loadConfig();
try {
  const { sqlite, db } = openDb(config.DATABASE_PATH);
  try {
    let file: string | null = null;
    let id: string;
    let extra: ProjectExtra;
    let previous: ProjectLock | undefined;
    if (existsSync(arg)) {
      file = resolve(arg);
      const f = readProjectFile(file);
      id = f.id ?? slugify(f.name);
      extra = { ...(f.target && { target: f.target }), ...(f.control && { control: f.control }), ...(f.roles && { roles: f.roles }) };
      previous = readSidecarLock(file);
    } else {
      const row = getProject(db, arg);
      if (!row) throw new Error(t.hub.lockNoProject(arg));
      id = row.id;
      extra = row.extra as ProjectExtra;
      previous = extra.lock;
      if (extra.sourceFile) {
        const src = isAbsolute(extra.sourceFile) ? extra.sourceFile : resolve(extra.sourceFile);
        if (existsSync(src)) file = src;
      }
    }
    const lock = buildProjectLock({ extra: extra as Record<string, unknown> });
    const diff = lockDiff(previous, lock);
    for (const [s, e] of Object.entries(lock.socles)) console.log(t.hub.lockSocle(s, e.ref, e.version, e.sha256));
    for (const [ref, e] of Object.entries(lock.modules)) console.log(t.hub.lockEntry(ref, e.version, e.sha256, e.source));
    if (values.check) {
      if (diff.length) {
        console.log(t.hub.lockCheckDiff);
        for (const d of diff) console.log(`  ${d}`);
        process.exitCode = 1;
      } else console.log(t.hub.lockUnchanged);
    } else {
      if (diff.length && previous) {
        console.log(t.hub.lockChanges);
        for (const d of diff) console.log(`  ${d}`);
      } else if (previous) console.log(t.hub.lockUnchanged);
      if (file) console.log(t.hub.lockWritten(writeLockFile(lockPathFor(file), lock)));
      if (getProject(db, id)) {
        storeProjectLock(db, id, lock);
        console.log(t.hub.lockStored(id));
      }
    }
  } finally {
    sqlite.close();
  }
} catch (err) {
  console.error(t.common.error(errorText(err)));
  process.exitCode = 1;
}
