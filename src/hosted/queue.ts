import { spawn, type SpawnOptions } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { IS_COMPILED, PACKAGE_ROOT } from "../config";
import { compiledEntry } from "../web/launcher";

/**
 * File de travail du service hébergé : études et tâches longues (récits, recommandations, assistants).
 *
 * - Concurrence globale (`HOSTED_CONCURRENCY`, défaut 4) et par compte (`HOSTED_ACCOUNT_CONCURRENCY`, défaut 1).
 * - Ordre d'arrivée, en sautant un compte déjà à sa limite.
 * - État persistant (`<racine>/_system/queue.json`) : après un redémarrage, les tâches en cours repassent en file
 *   (une étude reprend là où elle s'est arrêtée : seules les réponses manquantes sont demandées).
 * - Processus enfant : `src/hosted/child.ts <fichier> <arguments>`, dossier courant = dossier du compte,
 *   environnement MINIMAL (aucune variable du serveur : ni ANTHROPIC_*, ni HOSTED_MASTER_KEY, ni secret Supabase),
 *   clé déchiffrée transmise sur l'entrée standard (jamais en argument ni en variable d'environnement).
 */

export type JobKind = "study" | "task";

export interface JobRequest {
  userId: string;
  /** Clé de la tâche dans le compte (id d'étude, `recommend-<id>`, …). */
  key: string;
  kind: JobKind;
  /** Fichier source lancé (relatif à la racine du paquet), ex. `src/cli/study-run.ts`. */
  file: string;
  args: string[];
}

export interface Job extends JobRequest {
  id: string;
  state: "queued" | "running";
  enqueuedAt: string;
  startedAt?: string;
  pid?: number;
  /** Journal, relatif au dossier du compte (`logs/<clé>-<date>.log`). */
  logFile: string;
}

export interface ChildHandle {
  pid?: number | undefined;
  stdin: NodeJS.WritableStream | null;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type HostedSpawnFn = (cmd: string, args: string[], opts: SpawnOptions) => ChildHandle;

export interface ChildSecret {
  profile: string;
  apiKey: string;
}

export interface QueueOptions {
  /** Fichier d'état (`<racine>/_system/queue.json`). */
  stateFile: string;
  concurrency: number;
  perAccount: number;
  accountDir(userId: string): string;
  /** Clé déchiffrée du compte au démarrage de la tâche (null : aucune clé configurée). */
  secretFor(userId: string): ChildSecret | null;
  /** Environnement du serveur : seules quelques variables sans secret en sont reprises (voir `minimalChildEnv`). */
  baseEnv?: NodeJS.ProcessEnv;
  spawnFn?: HostedSpawnFn;
  root?: string;
  compiled?: boolean;
  /** Fin d'une tâche (tests, journal du serveur sans contenu de projet). */
  onExit?(job: Job, code: number | null): void;
}

/** Variables du serveur reprises telles quelles dans l'enfant (aucune n'est secrète). */
const PASSTHROUGH = ["PATH", "TZ", "LANG", "LC_ALL", "NODE_ENV", "PERSONAS_LANG", "PERSONAS_HUB_URL"] as const;

/** Environnement de l'enfant : construit de zéro, jamais copié de celui du serveur. */
export function minimalChildEnv(accountDir: string, baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of PASSTHROUGH) if (baseEnv[k]) env[k] = baseEnv[k];
  return {
    ...env,
    HOME: accountDir,
    PERSONAS_MODE: "hosted",
    PERSONAS_DATA_DIR: accountDir,
    DATABASE_PATH: join(accountDir, "personas.db"),
    PERSONAS_CONFIG: join(accountDir, "engine.json"),
    PERSONAS_HUB_CACHE_DIR: join(accountDir, "hub-cache"),
    PERSONAS_HUB_SETTINGS: join(accountDir, "hub-settings.json"),
    PERSONAS_TRIAGE_CACHE: join(accountDir, "triage", "relevance.jsonl"),
  };
}

/** Arguments du Node courant pour l'entrée des enfants (src/hosted/child.ts), en chemins absolus. */
export function childEntry(root: string, compiled: boolean): string[] {
  const file = "src/hosted/child.ts";
  return compiled ? [resolve(root, compiledEntry(file))] : [resolve(root, "node_modules/tsx/dist/cli.mjs"), resolve(root, file)];
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

export class QueueConflictError extends Error {
  constructor(readonly job: Job) {
    super(job.kind === "study" ? `L'étude ${job.key} est déjà en file ou en cours.` : `La tâche ${job.key} est déjà en file ou en cours.`);
  }
}

export class JobQueue {
  private jobs: Job[] = [];
  private readonly children = new Map<string, ChildHandle>();
  private seq = 0;
  private closed = false;

  constructor(private readonly opts: QueueOptions) {
    this.load();
  }

  /** Relit l'état : les tâches « en cours » d'un processus précédent repassent en file (reprise). */
  private load(): void {
    if (!existsSync(this.opts.stateFile)) return;
    try {
      const raw = JSON.parse(readFileSync(this.opts.stateFile, "utf8")) as { jobs?: Job[] };
      this.jobs = (raw.jobs ?? []).map((j) => {
        const { pid: _pid, startedAt: _s, ...rest } = j;
        return { ...rest, state: "queued" as const };
      });
    } catch {
      this.jobs = [];
    }
    this.save();
  }

  private save(): void {
    mkdirSync(dirname(this.opts.stateFile), { recursive: true, mode: 0o700 });
    const tmp = `${this.opts.stateFile}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, jobs: this.jobs }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.opts.stateFile);
  }

  list(userId?: string): Job[] {
    return this.jobs.filter((j) => !userId || j.userId === userId).map((j) => ({ ...j, args: [...j.args] }));
  }

  find(userId: string, key: string): Job | undefined {
    return this.jobs.find((j) => j.userId === userId && j.key === key);
  }

  /** Rang dans la file d'attente (1 = la prochaine) ; 0 si la tâche tourne. */
  position(job: Job): number {
    if (job.state === "running") return 0;
    return this.jobs.filter((j) => j.state === "queued").findIndex((j) => j.id === job.id) + 1;
  }

  enqueue(req: JobRequest): Job {
    if (this.closed) throw new Error("File de travail fermée.");
    const existing = this.find(req.userId, req.key);
    if (existing) throw new QueueConflictError(existing);
    const job: Job = { ...req, args: [...req.args], id: `${Date.now().toString(36)}-${(this.seq++).toString(36)}`, state: "queued", enqueuedAt: new Date().toISOString(), logFile: join("logs", `${req.key}-${stamp()}.log`) };
    this.jobs.push(job);
    this.save();
    this.pump();
    return job;
  }

  /** Démarre autant de tâches que les limites le permettent. */
  pump(): void {
    if (this.closed) return;
    for (;;) {
      const running = this.jobs.filter((j) => j.state === "running");
      if (running.length >= this.opts.concurrency) return;
      const perUser = new Map<string, number>();
      for (const j of running) perUser.set(j.userId, (perUser.get(j.userId) ?? 0) + 1);
      const next = this.jobs.find((j) => j.state === "queued" && (perUser.get(j.userId) ?? 0) < this.opts.perAccount);
      if (!next) return;
      this.startJob(next);
    }
  }

  private finish(job: Job, code: number | null, note?: string): void {
    this.children.delete(job.id);
    this.jobs = this.jobs.filter((j) => j.id !== job.id);
    const dir = this.opts.accountDir(job.userId);
    if (note) this.appendLog(job, note);
    try {
      const runFile = join(dir, "logs", `${job.key}.run.json`);
      if (existsSync(dirname(runFile))) {
        const prev = existsSync(runFile) ? (JSON.parse(readFileSync(runFile, "utf8")) as Record<string, unknown>) : {};
        writeFileSync(runFile, JSON.stringify({ ...prev, endedAt: new Date().toISOString(), exitCode: code }, null, 2));
      }
    } catch {
      // compte supprimé entre-temps
    }
    if (!this.closed) this.save();
    this.opts.onExit?.(job, code);
    this.pump();
  }

  private appendLog(job: Job, text: string): void {
    try {
      const f = join(this.opts.accountDir(job.userId), job.logFile);
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, `${text}\n`, { flag: "a" });
    } catch {
      // compte supprimé
    }
  }

  private startJob(job: Job): void {
    const dir = this.opts.accountDir(job.userId);
    job.state = "running";
    job.startedAt = new Date().toISOString();
    let secret: ChildSecret | null;
    try {
      secret = this.opts.secretFor(job.userId);
    } catch (err) {
      this.save();
      return this.finish(job, null, `Échec : ${(err as Error).message}`);
    }
    if (!secret) {
      this.save();
      return this.finish(job, null, "Échec : aucune clé IA configurée pour ce compte (page « Ma clé IA »).");
    }
    const logPath = join(dir, job.logFile);
    mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
    const root = this.opts.root ?? PACKAGE_ROOT;
    // Chemins absolus : le dossier courant de l'enfant est celui du compte, pas la racine du paquet
    const argv = [...childEntry(root, this.opts.compiled ?? IS_COMPILED), job.file, ...job.args];
    const fd = openSync(logPath, "a");
    let child: ChildHandle;
    try {
      child = (this.opts.spawnFn ?? (spawn as unknown as HostedSpawnFn))(process.execPath, argv, {
        cwd: dir,
        env: minimalChildEnv(dir, this.opts.baseEnv),
        detached: false,
        stdio: ["pipe", fd, fd],
      });
    } catch (err) {
      closeSync(fd);
      this.save();
      return this.finish(job, null, `Échec du démarrage : ${(err as Error).message}`);
    }
    // l'enfant a sa copie du descripteur
    closeSync(fd);
    job.pid = child.pid ?? 0;
    this.children.set(job.id, child);
    writeFileSync(join(dir, "logs", `${job.key}.run.json`), JSON.stringify({ studyId: job.key, pid: job.pid, logFile: job.logFile, startedAt: job.startedAt, command: ["node", job.file, ...job.args] }, null, 2));
    child.once("exit", (code) => this.finish(job, code));
    // Canal privé : la clé passe par l'entrée standard, puis le flux est fermé
    child.stdin?.end(`${JSON.stringify({ v: 1, profile: secret.profile, apiKey: secret.apiKey })}\n`);
    this.save();
  }

  /** Retire les tâches d'un compte (en file : supprimées ; en cours : arrêtées). */
  cancelUser(userId: string): number {
    const mine = this.jobs.filter((j) => j.userId === userId);
    this.jobs = this.jobs.filter((j) => j.userId !== userId);
    for (const j of mine) {
      const c = this.children.get(j.id);
      if (c) {
        this.children.delete(j.id);
        c.kill("SIGTERM");
      }
    }
    this.save();
    this.pump();
    return mine.length;
  }

  /** Arrêt du serveur : les enfants sont arrêtés, l'état garde les tâches pour la reprise au redémarrage. */
  close(): void {
    this.closed = true;
    this.save();
    for (const c of this.children.values()) c.kill("SIGTERM");
    this.children.clear();
  }
}
