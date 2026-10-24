import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { Hono } from "hono";
import { loadConfig, withDataScope } from "../config";
import { isSupabaseUserId } from "../auth/supabase-jwt";
import { openDb, runMigrations, type Db } from "../db/client";
import { memoryStore } from "../engine/secrets";
import type { Pack } from "../personas/pack";
import { createApp, type AppContext } from "../web/app";
import { HOSTED_FEATURES } from "../web/features";
import type { AssistantLoader, AssistantApi } from "../web/modules";
import { defaultAssistantLoader } from "../web/modules";
import { HostedLauncher } from "./launcher";
import type { JobQueue } from "./queue";

/**
 * Comptes du service hébergé : un dossier par compte, `<HOSTED_DATA_ROOT>/<user-id>/` (base SQLite, journaux,
 * projets, cache du Hub, suggestions, recommandations, clé chiffrée…), créé et migré au premier accès.
 * Un contexte du tableau de bord (src/web/app.ts) par compte, gardé en mémoire tant qu'il sert ; les bases
 * inactives sont fermées (`sweep`).
 */

export interface Account {
  userId: string;
  dir: string;
  db: Db;
  ctx: AppContext;
  app: Hono;
  lastUsed: number;
  inflight: number;
  close(): void;
}

/** Dossier d'un compte : l'identifiant doit être un UUID (aucun chemin possible). */
export function accountDirOf(root: string, userId: string): string {
  if (!isSupabaseUserId(userId)) throw new Error("Identifiant de compte invalide.");
  const dir = resolve(root, userId.toLowerCase());
  if (!dir.startsWith(resolve(root) + sep)) throw new Error("Identifiant de compte invalide.");
  return dir;
}

/**
 * Assistant de modules en mode hébergé : lecture et validation de la bibliothèque partagée (modules validés),
 * jamais les brouillons (dossier partagé modules/_drafts) ni leur écriture.
 */
export function hostedAssistantLoader(base: AssistantLoader = defaultAssistantLoader()): AssistantLoader {
  const refuse = () => {
    throw new Error("Module introuvable.");
  };
  return async () => {
    const { api, reason } = await base();
    if (!api) return { api: null, ...(reason && { reason }) };
    const wrapped: AssistantApi = {
      listModules: async () => (await api.listModules()).filter((m) => m.status === "validated"),
      getModule: async (id) => {
        const m = await api.getModule(id);
        if (m.status.startsWith("draft")) refuse();
        return m;
      },
      validateModuleYaml: (yaml) => api.validateModuleYaml(yaml),
      previewModule: async (source, opts) => {
        if (!source.moduleId) refuse();
        return api.previewModule({ moduleId: source.moduleId! }, opts);
      },
      saveDraftYaml: () => refuse(),
    };
    return { api: wrapped };
  };
}

export interface PoolOptions {
  root: string;
  pack: Pack;
  queue: JobQueue;
  idleMs: number;
  /** Assistant de modules (tests). */
  assistant?: AssistantLoader;
}

export class AccountPool {
  private readonly accounts = new Map<string, Account>();
  private readonly assistant: AssistantLoader;

  constructor(private readonly opts: PoolOptions) {
    this.assistant = opts.assistant ?? hostedAssistantLoader();
  }

  dirOf(userId: string): string {
    return accountDirOf(this.opts.root, userId);
  }

  exists(userId: string): boolean {
    return existsSync(join(this.dirOf(userId), "personas.db"));
  }

  /** Compte ouvert (créé et migré au premier accès). */
  get(userId: string): Account {
    const id = userId.toLowerCase();
    const hit = this.accounts.get(id);
    if (hit) {
      hit.lastUsed = Date.now();
      return hit;
    }
    const dir = this.dirOf(id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const config = loadConfig({ ...process.env, DATABASE_PATH: join(dir, "personas.db") });
    const { sqlite, db } = openDb(config.DATABASE_PATH);
    runMigrations(db);
    const launcher = new HostedLauncher(id, dir, this.opts.queue);
    const ctx: AppContext = {
      db,
      pack: this.opts.pack,
      config,
      launcher,
      root: dir,
      dataDir: dir,
      assistant: this.assistant,
      sessionToken: randomBytes(32).toString("base64url"),
      // Le Hub en lecture : cache et réglages du compte, aucun trousseau (connexion au Hub et publication désactivées)
      hub: { cacheDir: join(dir, "hub-cache"), settingsPath: join(dir, "hub-settings.json"), store: memoryStore() },
      mode: "hosted",
      features: HOSTED_FEATURES,
    };
    const app = withDataScope({ dataDir: dir }, () => createApp(ctx));
    const account: Account = { userId: id, dir, db, ctx, app, lastUsed: Date.now(), inflight: 0, close: () => sqlite.close() };
    this.accounts.set(id, account);
    return account;
  }

  /** Ferme les comptes inactifs (aucune requête en cours, rien depuis `idleMs`). */
  sweep(now = Date.now()): number {
    let n = 0;
    for (const [id, a] of this.accounts) {
      if (a.inflight === 0 && now - a.lastUsed >= this.opts.idleMs) {
        a.close();
        this.accounts.delete(id);
        n++;
      }
    }
    return n;
  }

  openCount(): number {
    return this.accounts.size;
  }

  /** Ferme la base d'un compte (avant purge). */
  release(userId: string): void {
    const a = this.accounts.get(userId.toLowerCase());
    if (a) {
      a.close();
      this.accounts.delete(userId.toLowerCase());
    }
  }

  /** Suppression complète du dossier du compte. */
  purge(userId: string): void {
    this.release(userId);
    rmSync(this.dirOf(userId), { recursive: true, force: true });
  }

  close(): void {
    for (const a of this.accounts.values()) a.close();
    this.accounts.clear();
  }
}
