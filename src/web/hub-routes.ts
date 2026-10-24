import type { Hono } from "hono";
import { z } from "zod";
import type { SecretStore } from "../engine/secrets";
import { accountStatus, resolveHubToken } from "../hub/auth";
import { hubCacheDir, readCachedCatalog } from "../hub/cache";
import { HubClient, HubError } from "../hub/client";
import { moduleFileOf, previewPublication } from "../hub/publish";
import { pullModule } from "../hub/pull";
import { hubSettingsPath, readHubSettings, setTelemetry } from "../hub/settings";
import { TELEMETRY_EXAMPLE } from "../hub/telemetry";
import { isLegacy, moduleAt, moduleLibrary } from "../modules/registry";
import { canonicalRef } from "../modules/refs";
import { langOf, messageIn } from "./i18n";

/**
 * Catalogue du Hub dans le tableau de bord (page Modules) : lecture du catalogue en cache (sans réseau),
 * mise à jour (`hub sync`) et téléchargement d'un module dans le cache (`hub pull`). Rien du projet n'est envoyé.
 *
 * Phase 3 : état de connexion (`personas hub login` se lance dans un terminal : le jeton ne transite jamais par le
 * navigateur), télémétrie opt-in (case à cocher), et publication d'un module validé de la bibliothèque locale :
 * aperçu (YAML exact, lint de sécurité, référence visée), puis envoi confirmé, lié à l'empreinte de l'aperçu.
 * Seul le YAML du module part ; jamais un projet, un brouillon ni research.json.
 */

export interface HubRouteDeps {
  /** Client du Hub (défaut : PERSONAS_HUB_URL ou l'adresse publique). */
  client?: () => HubClient;
  /** Dossier du cache (défaut : hub-cache du dossier de données). */
  cacheDir?: string | null;
  /** Trousseau (défaut : celui du système ; en mémoire sous vitest). */
  store?: SecretStore;
  /** Réglages du Hub (défaut : hub-settings.json du dossier de données). */
  settingsPath?: string | null;
}

const pullBody = z.object({ ref: z.string().min(3).max(120), version: z.string().min(1).max(32).optional() });
const moduleIdBody = z.object({ moduleId: z.string().regex(/^[a-z][a-z0-9-]*$/) });
const publishBody = moduleIdBody.extend({ sha256: z.string().regex(/^[0-9a-f]{64}$/) });
const telemetryBody = z.object({ enabled: z.boolean() });

export function registerHubRoutes(api: Hono, deps: HubRouteDeps = {}): void {
  const cacheDir = () => (deps.cacheDir === undefined ? hubCacheDir() : deps.cacheDir);
  const client = () => (deps.client ? deps.client() : new HubClient({ cacheDir: cacheDir() }));
  const settingsPath = () => (deps.settingsPath === undefined ? hubSettingsPath() : deps.settingsPath);
  const store = deps.store ? { store: deps.store } : {};

  const view = () => {
    const cached = readCachedCatalog(cacheDir());
    const lib = moduleLibrary();
    const modules = (cached?.catalog.modules ?? []).map((m) => {
      const ref = canonicalRef(m.ref);
      const local = lib.get(ref);
      const latest = m.versions.find((v) => v.version === m.latest);
      const r = m.ranking;
      return {
        ref: m.ref,
        label: m.label,
        description: m.description,
        appliesTo: m.appliesTo,
        tags: m.tags,
        latest: m.latest,
        status: latest?.status ?? "published",
        quality: latest?.quality ?? null,
        attributeCount: m.attributes.length,
        /** Version de la bibliothèque locale (dépôt) ou du cache, si elle existe. */
        localVersion: local?.def.version ?? null,
        localSource: local?.source ?? null,
        cached: !!moduleAt(ref, m.latest, lib),
        /** Champs sociaux (phase 3), si le Hub les expose : null sinon (affichage conditionnel). */
        reviewStatus: r?.status ?? latest?.status ?? null,
        badges: r?.badges ?? [],
        stars: r?.stars ?? null,
        reviews: r ? r.reviews : null,
        forkedFrom: r?.forkedFrom ? `${r.forkedFrom.ref}@${r.forkedFrom.version}` : null,
        usage90: r?.usage90 ?? null,
      };
    });
    return { available: !!cached, fetchedAt: cached?.meta.fetchedAt ?? null, hubUrl: cached?.meta.hubUrl ?? null, modules, packs: cached?.catalog.packs.length ?? 0 };
  };

  api.get("/hub/catalog", (c) => c.json(view()));

  /** État de connexion au Hub et télémétrie (le jeton n'est jamais renvoyé). */
  api.get("/hub/account", async (c) => {
    const settings = readHubSettings(settingsPath());
    let status;
    try {
      status = await accountStatus(client(), { ...store, settingsPath: settingsPath() });
    } catch (err) {
      return c.json({ hubUrl: null, connected: false, tokenStored: false, rejected: false, offline: messageIn(langOf(c), (err as Error).message), me: null, telemetry: settings.telemetry.enabled, telemetryExample: TELEMETRY_EXAMPLE, loginCommand: "personas hub login" });
    }
    return c.json({
      hubUrl: status.hubUrl,
      connected: !!status.me,
      tokenStored: status.tokenStored,
      rejected: status.rejected,
      ...(status.offline && { offline: messageIn(langOf(c), status.offline) }),
      me: status.me && { namespace: status.me.namespace, displayName: status.me.displayName, role: status.me.role, scopes: status.me.scopes },
      lastKnown: status.lastKnown && { namespace: status.lastKnown.namespace, displayName: status.lastKnown.displayName },
      telemetry: settings.telemetry.enabled,
      telemetryExample: TELEMETRY_EXAMPLE,
      loginCommand: "personas hub login",
    });
  });

  api.post("/hub/telemetry", async (c) => {
    const parsed = telemetryBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Requête invalide : { enabled: boolean }" }, 400);
    const s = setTelemetry(parsed.data.enabled, settingsPath());
    return c.json({ telemetry: s.telemetry.enabled });
  });

  /** Module validé de la bibliothèque locale (pas un brouillon, pas un module du cache). */
  const localModuleFile = (id: string): string => {
    const m = moduleLibrary(undefined, { fresh: true }).get(id);
    if (!m || m.source !== "local" || isLegacy(m)) throw new Error(`Module introuvable dans la bibliothèque locale : ${id}`);
    return moduleFileOf(m.file);
  };

  /** Aperçu de la publication : YAML exact qui sera envoyé, lint, validation, référence visée. Rien n'est envoyé. */
  api.post("/hub/publish/preview", async (c) => {
    const parsed = moduleIdBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Requête invalide : { moduleId }" }, 400);
    try {
      const p = previewPublication(localModuleFile(parsed.data.moduleId));
      const tok = await resolveHubToken(store);
      const last = readHubSettings(settingsPath()).account;
      return c.json({
        moduleId: parsed.data.moduleId,
        yaml: p.yaml,
        sha256: p.sha256,
        version: p.def?.version ?? null,
        ref: last && p.def ? `${last.namespace}/${p.def.id}` : null,
        namespace: last?.namespace ?? null,
        tokenStored: !!tok,
        validation: p.validation,
        lint: p.lint,
        sensitive: p.sensitive,
        ok: p.ok,
      });
    } catch (err) {
      return c.json({ error: messageIn(langOf(c), (err as Error).message) }, 404);
    }
  });

  /** Publication confirmée : le YAML doit être celui de l'aperçu (même sha256), lint et validation rejoués. */
  api.post("/hub/publish", async (c) => {
    const parsed = publishBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Requête invalide : { moduleId, sha256 }" }, 400);
    let p;
    try {
      p = previewPublication(localModuleFile(parsed.data.moduleId));
    } catch (err) {
      return c.json({ error: messageIn(langOf(c), (err as Error).message) }, 404);
    }
    if (p.sha256 !== parsed.data.sha256) return c.json({ error: messageIn(langOf(c), "Le module a changé depuis l'aperçu : relancer l'aperçu avant de publier.") }, 409);
    if (!p.ok) return c.json({ error: messageIn(langOf(c), "Lint de sécurité ou validation en échec : rien n'est envoyé."), lint: p.lint, validation: p.validation }, 422);
    const tok = await resolveHubToken(store);
    if (!tok) return c.json({ error: messageIn(langOf(c), "Pas connecté au Hub : lancer personas hub login dans un terminal."), loginCommand: "personas hub login" }, 401);
    try {
      const r = await client().publishUserModule({ yaml: p.yaml }, tok.token);
      return c.json({ published: { ref: r.ref, version: r.version, sha256: r.sha256, status: r.status ?? null, quality: r.quality, signed: !!r.signature, warnings: r.warnings ?? [] } });
    } catch (err) {
      const status = err instanceof HubError && err.status === 401 ? 401 : err instanceof HubError && err.status < 500 ? 422 : 502;
      return c.json({ error: messageIn(langOf(c), (err as Error).message), ...(status === 401 && { loginCommand: "personas hub login" }) }, status);
    }
  });

  api.post("/hub/sync", async (c) => {
    try {
      const r = await client().catalog();
      return c.json({ ...view(), source: r.source, ...(r.offline && { offline: messageIn(langOf(c), r.offline) }) });
    } catch (err) {
      return c.json({ error: messageIn(langOf(c), (err as Error).message) }, 502);
    }
  });

  api.post("/hub/pull", async (c) => {
    const parsed = pullBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Requête invalide : { ref, version? }" }, 400);
    try {
      const spec = parsed.data.version ? `${parsed.data.ref}@${parsed.data.version}` : parsed.data.ref;
      const catalog = readCachedCatalog(cacheDir())?.catalog;
      const results = await pullModule(client(), spec, { cacheDir: cacheDir(), ...(catalog && { catalog }) });
      moduleLibrary(undefined, { fresh: true });
      return c.json({ pulled: results });
    } catch (err) {
      return c.json({ error: messageIn(langOf(c), (err as Error).message) }, 502);
    }
  });
}
