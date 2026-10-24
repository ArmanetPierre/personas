import { spawn, type SpawnOptions } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { IS_COMPILED } from "../config";

/**
 * Lancement d'une étude en tâche de fond : `study:run` dans un processus enfant détaché,
 * journal dans `data/logs/`. L'avancement se lit en base (nombre de réponses), pas dans le processus.
 *
 * Deux façons de lancer un fichier `src/…/x.ts` :
 * - dans le dépôt (sources TypeScript) : le Node courant avec tsx (`node_modules/tsx/dist/cli.mjs src/…/x.ts`) ;
 * - depuis le paquet compilé (`npm i -g`) : le Node courant (process.execPath) sur l'entrée compilée
 *   `dist/…/x.js`, sans tsx.
 */

/** Variables jamais transmises à l'enfant : aucune clé ni configuration d'API Anthropic. */
const STRIPPED_ENV: RegExp[] = [/^ANTHROPIC_/, /^CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY)$/, /^CLAUDE_CODE_API_KEY/];

export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || STRIPPED_ENV.some((re) => re.test(k))) continue;
    out[k] = v;
  }
  return out;
}

export interface RunInfo {
  studyId: string;
  pid: number;
  logPath: string;
  startedAt: string;
  command: string[];
  /** Service hébergé : tâche en file d'attente (pas encore démarrée), et son rang (1 = la prochaine). */
  queued?: boolean;
  position?: number;
}

export type SpawnFn = (cmd: string, args: string[], opts: SpawnOptions) => { pid?: number | undefined; unref(): void };

export interface LauncherOptions {
  /** Racine du projet (cwd de l'enfant). */
  root: string;
  /** Dossier des journaux (défaut : `<dossier de la base>/logs`). */
  logDir: string;
  spawnFn?: SpawnFn;
  env?: NodeJS.ProcessEnv;
  /** Lancer les entrées compilées (dist/…/x.js) au lieu des sources par tsx. Défaut : selon le code courant. */
  compiled?: boolean;
  /** Dossier courant de l'enfant (défaut : `root`). Le paquet installé y met le dossier de données. */
  cwd?: string;
}

/** Entrée compilée d'un fichier source : `src/cli/x.ts` → `dist/cli/x.js`. */
export function compiledEntry(file: string): string {
  return file.replace(/^src\//, "dist/").replace(/\.tsx?$/, ".js");
}

/** Arguments du Node courant pour lancer `file` (chemin relatif à la racine, `src/…/x.ts`). */
export function nodeArgs(root: string, file: string, compiled: boolean = IS_COMPILED): string[] {
  return compiled ? [resolve(root, compiledEntry(file))] : [resolve(root, "node_modules/tsx/dist/cli.mjs"), file];
}

export class Launcher {
  constructor(private readonly opts: LauncherOptions) {}

  private infoPath(studyId: string): string {
    return join(this.opts.logDir, `${studyId}.run.json`);
  }

  /** Dernier lancement connu d'une étude (survit au redémarrage du serveur). */
  info(studyId: string): (RunInfo & { alive: boolean }) | null {
    const p = this.infoPath(studyId);
    if (!existsSync(p)) return null;
    try {
      const info = JSON.parse(readFileSync(p, "utf8")) as RunInfo;
      return { ...info, alive: isAlive(info.pid) };
    } catch {
      return null;
    }
  }

  /** Démarre `study:run` ; refuse si un processus de cette étude tourne encore. */
  start(studyId: string): RunInfo {
    if (!/^[A-Za-z0-9_-]+$/.test(studyId)) throw new Error(`Identifiant d'étude invalide : ${studyId}`);
    return this.startFile(studyId, "src/cli/study-run.ts", ["--study", studyId]);
  }

  /**
   * Démarre un script npm du projet (ex. `module:propose`) en processus détaché. Le fichier lancé est lu
   * dans `package.json` (« tsx src/cli/xxx.ts ») : on évite npm, qui ajouterait un processus et ses variables.
   */
  startScript(key: string, script: string, args: string[]): RunInfo {
    const file = scriptFile(this.opts.root, script, this.opts.compiled ?? IS_COMPILED);
    if (!file) throw new ScriptMissingError(script);
    return this.startFile(key, file, args);
  }

  /** Démarre un fichier TypeScript du dépôt (tâche du tableau de bord, ex. src/web/jobs/…) en processus détaché. */
  startFile(key: string, file: string, args: string[]): RunInfo {
    if (!/^[A-Za-z0-9_-]+$/.test(key)) throw new Error(`Identifiant invalide : ${key}`);
    const current = this.info(key);
    if (current?.alive) throw new AlreadyRunningError(current);
    mkdirSync(this.opts.logDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const logPath = join(this.opts.logDir, `${key}-${stamp}.log`);
    const argv = [...nodeArgs(this.opts.root, file, this.opts.compiled ?? IS_COMPILED), ...args];
    const fd = openSync(logPath, "a");
    let pid: number | undefined;
    try {
      const child = (this.opts.spawnFn ?? spawn)(process.execPath, argv, {
        cwd: this.opts.cwd ?? this.opts.root,
        env: childEnv(this.opts.env ?? process.env),
        detached: true,
        stdio: ["ignore", fd, fd],
      });
      pid = child.pid;
      child.unref();
    } finally {
      closeSync(fd);
    }
    if (!pid) throw new Error("Le processus n'a pas démarré.");
    const info: RunInfo = { studyId: key, pid, logPath, startedAt: new Date().toISOString(), command: ["node", ...argv.map((a) => a.replace(this.opts.root + "/", ""))] };
    writeFileSync(this.infoPath(key), JSON.stringify(info, null, 2));
    return info;
  }

  /** Fin du journal du dernier lancement (ou du plus récent trouvé). */
  tail(studyId: string, maxBytes = 12_000): { logPath: string | null; text: string } {
    let logPath = this.info(studyId)?.logPath ?? null;
    if (!logPath && existsSync(this.opts.logDir)) {
      const logs = readdirSync(this.opts.logDir).filter((f) => f.startsWith(`${studyId}-`) && f.endsWith(".log")).sort();
      logPath = logs.length ? join(this.opts.logDir, logs.at(-1)!) : null;
    }
    if (!logPath || !existsSync(logPath)) return { logPath, text: "" };
    const size = statSync(logPath).size;
    const text = readFileSync(logPath, "utf8");
    return { logPath, text: size > maxBytes ? "…\n" + text.slice(-maxBytes) : text };
  }
}

export class AlreadyRunningError extends Error {
  constructor(readonly info: RunInfo) {
    super(info.studyId.startsWith("module-") ? `Une tâche de l'assistant tourne déjà sur ce brouillon (processus ${info.pid}).` : `L'étude ${info.studyId} tourne déjà (processus ${info.pid}).`);
  }
}

export class ScriptMissingError extends Error {
  constructor(readonly script: string) {
    super(`Assistant indisponible : le script npm « ${script} » n'existe pas encore dans package.json.`);
  }
}

/**
 * Fichier TypeScript lancé par un script npm « tsx src/cli/xxx.ts », ou null. Compilé : le fichier source n'est
 * pas livré, on vérifie l'entrée `dist/cli/xxx.js`.
 */
export function scriptFile(root: string, script: string, compiled: boolean = IS_COMPILED): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    const m = pkg.scripts?.[script]?.match(/^tsx\s+(\S+\.ts)\b/);
    return m && existsSync(join(root, compiled ? compiledEntry(m[1]!) : m[1]!)) ? m[1]! : null;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
