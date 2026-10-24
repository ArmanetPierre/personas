import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PACKAGE_ROOT } from "../config";
import { AlreadyRunningError, Launcher, scriptFile, type RunInfo } from "../web/launcher";
import { CHILD_FILES } from "./child";
import { QueueConflictError, type Job, type JobQueue } from "./queue";

/**
 * Lanceur d'un compte hébergé : même interface que le lanceur local (src/web/launcher.ts), donc mêmes routes,
 * mais chaque lancement passe par la file de travail (src/hosted/queue.ts) au lieu d'un processus détaché.
 * Seuls les scripts de `CHILD_FILES` sont admis : aucune route ne peut lancer une commande arbitraire.
 */

export class HostedDisabledError extends Error {
  override name = "HostedDisabledError";
}

/** Scripts npm admis (études et assistants qui passent par la clé de l'utilisateur). */
const ALLOWED_SCRIPTS = new Set(["study:recommend", "study:recode", "project:neutralize-pitch", "project:suggest-protocol"]);
const SAFE_KEY = /^[A-Za-z0-9_-]+$/;

export class HostedLauncher extends Launcher {
  constructor(
    private readonly userId: string,
    private readonly accountDir: string,
    private readonly queue: JobQueue,
  ) {
    super({ root: PACKAGE_ROOT, logDir: join(accountDir, "logs"), cwd: accountDir, spawnFn: () => { throw new HostedDisabledError("Lancement direct refusé en mode hébergé."); } });
  }

  private runInfo(job: Job): RunInfo & { alive: boolean } {
    return {
      studyId: job.key,
      pid: job.pid ?? 0,
      logPath: job.logFile,
      startedAt: job.startedAt ?? job.enqueuedAt,
      command: ["node", job.file, ...job.args.map((a) => a.replace(`${this.accountDir}/`, ""))],
      alive: true,
      queued: job.state === "queued",
      position: this.queue.position(job),
    };
  }

  override info(key: string): (RunInfo & { alive: boolean }) | null {
    const job = this.queue.find(this.userId, key);
    if (job) return this.runInfo(job);
    if (!SAFE_KEY.test(key)) return null;
    const f = join(this.accountDir, "logs", `${key}.run.json`);
    if (!existsSync(f)) return null;
    try {
      const r = JSON.parse(readFileSync(f, "utf8")) as { pid?: number; logFile?: string; startedAt?: string; command?: string[] };
      return { studyId: key, pid: r.pid ?? 0, logPath: r.logFile ?? "", startedAt: r.startedAt ?? "", command: (r.command ?? []).map((a) => a.replace(`${this.accountDir}/`, "")), alive: false };
    } catch {
      return null;
    }
  }

  override start(studyId: string): RunInfo {
    if (!SAFE_KEY.test(studyId)) throw new Error(`Identifiant d'étude invalide : ${studyId}`);
    return this.enqueue(studyId, "src/cli/study-run.ts", ["--study", studyId], "study");
  }

  override startScript(key: string, script: string, args: string[]): RunInfo {
    if (!ALLOWED_SCRIPTS.has(script)) throw new HostedDisabledError(`Fonction indisponible sur le service hébergé (${script}).`);
    const file = scriptFile(PACKAGE_ROOT, script);
    if (!file) throw new HostedDisabledError(`Script introuvable : ${script}`);
    return this.enqueue(key, file, args, "task");
  }

  override startFile(key: string, file: string, args: string[]): RunInfo {
    return this.enqueue(key, file, args, file === "src/cli/study-run.ts" ? "study" : "task");
  }

  private enqueue(key: string, file: string, args: string[], kind: "study" | "task"): RunInfo {
    if (!SAFE_KEY.test(key)) throw new Error(`Identifiant invalide : ${key}`);
    if (!CHILD_FILES.has(file)) throw new HostedDisabledError(`Fonction indisponible sur le service hébergé (${file}).`);
    try {
      return this.runInfo(this.queue.enqueue({ userId: this.userId, key, kind, file, args }));
    } catch (err) {
      if (err instanceof QueueConflictError) throw new AlreadyRunningError(this.runInfo(err.job));
      throw err;
    }
  }

  override tail(key: string, maxBytes = 12_000): { logPath: string | null; text: string } {
    let rel = this.info(key)?.logPath || null;
    const logDir = join(this.accountDir, "logs");
    if (!rel && existsSync(logDir) && SAFE_KEY.test(key)) {
      const logs = readdirSync(logDir).filter((f) => f.startsWith(`${key}-`) && f.endsWith(".log")).sort();
      rel = logs.length ? join("logs", logs.at(-1)!) : null;
    }
    if (!rel || rel.includes("..")) return { logPath: rel, text: "" };
    const abs = join(this.accountDir, rel);
    if (!existsSync(abs)) return { logPath: rel, text: "" };
    const text = readFileSync(abs, "utf8");
    return { logPath: rel, text: statSync(abs).size > maxBytes ? "…\n" + text.slice(-maxBytes) : text };
  }
}
