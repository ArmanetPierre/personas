import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { loadConfig } from "../config";

/**
 * Réglages locaux du Hub (`hub-settings.json`, à côté de la base, dans le dossier de données) :
 * - `telemetry` : télémétrie opt-in, **désactivée par défaut** (docs/plateforme.md § 11.2), identifiant
 *   d'installation tournant (renouvelé chaque mois) et file d'envoi en attente ;
 * - `account` : compte connecté par `personas hub login` (namespace, nom affiché, expiration), pour l'affichage.
 *   Le jeton lui-même n'est jamais écrit ici : il vit dans le trousseau (src/hub/auth.ts).
 *
 * `PERSONAS_HUB_SETTINGS` (chemin du fichier) l'impose. Sous vitest, sans cette variable : aucun fichier (réglages
 * par défaut, télémétrie coupée), pour qu'aucun test ne lise ni n'écrive les réglages réels.
 */

export const hubSettingsSchema = z.object({
  telemetry: z
    .object({
      enabled: z.boolean().default(false),
      /** Identifiant d'installation (aléatoire), jamais lié au compte ; renouvelé chaque mois. */
      installId: z.string().optional(),
      /** Mois de l'identifiant (AAAA-MM). */
      installMonth: z.string().optional(),
      /** Agrégats non envoyés (Hub injoignable), renvoyés à la prochaine étude terminée. */
      pending: z.array(z.record(z.string(), z.unknown())).default([]),
      changedAt: z.string().optional(),
    })
    .default({ enabled: false, pending: [] }),
  account: z
    .object({
      hubUrl: z.string(),
      namespace: z.string(),
      displayName: z.string().nullable(),
      scopes: z.array(z.string()).default([]),
      expiresAt: z.string().nullable(),
      loggedInAt: z.string(),
    })
    .nullable()
    .default(null),
});
export type HubSettings = z.infer<typeof hubSettingsSchema>;

export function hubSettingsPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const forced = env.PERSONAS_HUB_SETTINGS?.trim();
  if (forced) return resolve(forced);
  if (env.VITEST) return null;
  return join(dirname(resolve(loadConfig(env).DATABASE_PATH)), "hub-settings.json");
}

const defaults = (): HubSettings => hubSettingsSchema.parse({});

/** Réglages (défauts si le fichier est absent ou illisible : télémétrie coupée). */
export function readHubSettings(path: string | null = hubSettingsPath()): HubSettings {
  if (!path || !existsSync(path)) return defaults();
  try {
    return hubSettingsSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return defaults();
  }
}

/** Met à jour les réglages (écriture atomique). Sans fichier (tests), ne fait rien et renvoie la valeur calculée. */
export function updateHubSettings(patch: (s: HubSettings) => HubSettings, path: string | null = hubSettingsPath()): HubSettings {
  const next = hubSettingsSchema.parse(patch(readHubSettings(path)));
  if (!path) return next;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 1)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  return next;
}

export function telemetryEnabled(path: string | null = hubSettingsPath()): boolean {
  return readHubSettings(path).telemetry.enabled;
}

export function setTelemetry(enabled: boolean, path: string | null = hubSettingsPath()): HubSettings {
  // Couper la télémétrie vide aussi la file d'attente : rien ne part après un refus.
  return updateHubSettings((s) => ({ ...s, telemetry: { ...s.telemetry, enabled, changedAt: new Date().toISOString(), ...(!enabled && { pending: [] }) } }), path);
}
