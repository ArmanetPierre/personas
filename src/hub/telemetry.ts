import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import { PACKAGE_ROOT } from "../config";
import type { Study } from "../db/schema";
import { modelFamily } from "../studies/payment";
import { hubCacheDir, readCachedCatalog } from "./cache";
import { HubClient } from "./client";
import type { telemetryRequest } from "./contract";
import { hubSettingsPath, readHubSettings, updateHubSettings } from "./settings";

/**
 * Télémétrie opt-in (docs/plateforme.md § 11.2) : **désactivée par défaut**, activée par
 * `personas hub telemetry on` ou la case du tableau de bord.
 *
 * Ce qui part, à la fin d'une étude terminée, en tout et pour tout (schéma strict du contrat, `telemetryRequest`) :
 *   { installId, studies: [{ modules: ["ns/slug@version"…], socle, personas, protocol, engineVersion, modelFamily, day }] }
 * - `modules` : seulement les modules **du Hub** (version et sha256 identiques à ceux du catalogue en cache) ;
 *   un module local, jamais publié, n'est pas cité (son nom pourrait trahir un projet) ;
 * - `installId` : aléatoire, renouvelé chaque mois, jamais lié au compte (aucun jeton n'est envoyé) ;
 * - jamais : projet, pitch, offre, cible, filtre, réponse, récit, résumé, identifiant d'étude ou de persona.
 * Un envoi raté est gardé en file (200 au plus) et repart à la prochaine étude terminée ; couper la télémétrie vide la file.
 */

export type TelemetryStudy = z.infer<typeof telemetryRequest>["studies"][number];

const MAX_PENDING = 200;

/** Exemple exact de ce qui part (affiché à l'activation, CLI et tableau de bord). */
export const TELEMETRY_EXAMPLE = {
  installId: "Q2h4bXdkY2FzZWZ0eXV1ZWw",
  studies: [{ modules: ["numerique@2026.3", "alice/sport-connecte@2026.1"], socle: "fr", personas: 200, protocol: "concept-price", engineVersion: "1.0.0", modelFamily: "sonnet", day: "2026-10-19" }],
} as const;

function packageVersion(): string {
  try {
    return (JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as { version?: string }).version ?? "0";
  } catch {
    return "0";
  }
}

/** Identifiant d'installation du mois (renouvelé au changement de mois). */
function installIdFor(settingsPath: string | null, now: Date): string {
  const month = now.toISOString().slice(0, 7);
  const s = readHubSettings(settingsPath);
  if (s.telemetry.installId && s.telemetry.installMonth === month) return s.telemetry.installId;
  const id = randomBytes(18).toString("base64url");
  updateHubSettings((x) => ({ ...x, telemetry: { ...x.telemetry, installId: id, installMonth: month } }), settingsPath);
  return id;
}

interface LockedModules {
  [ref: string]: { version: string; sha256: string; source?: string };
}

/**
 * Agrégat d'une étude terminée (null si elle n'utilise aucun module du Hub et n'a pas de socle reconnu).
 * Ne lit que des champs structurés de l'étude : modules épinglés, socle, nombre de personas, protocole, modèle.
 */
export function studyTelemetry(study: Pick<Study, "populations" | "personaIds" | "protocol" | "backend" | "model" | "extra" | "completedAt">, catalog = readCachedCatalog(hubCacheDir())?.catalog ?? null): TelemetryStudy | null {
  const pops = (study.populations ?? []) as Array<{ packVersion?: string; eligibility?: { lock?: { modules?: LockedModules } } }>;
  const published = new Map<string, string>();
  for (const m of catalog?.modules ?? []) for (const v of m.versions) published.set(`${m.ref}@${v.version}`, v.sha256);
  const modules = new Set<string>();
  for (const pop of pops) {
    for (const [ref, e] of Object.entries(pop.eligibility?.lock?.modules ?? {})) {
      const qref = ref.includes("/") ? ref : `personas/${ref}`;
      if (published.get(`${qref}@${e.version}`) !== e.sha256) continue; // absent du Hub ou modifié localement
      modules.add(qref.startsWith("personas/") ? `${qref.slice(9)}@${e.version}` : `${qref}@${e.version}`);
    }
  }
  const socle = /^[a-z]+/.exec(pops[0]?.packVersion ?? "")?.[0];
  if (!socle) return null;
  const engine = (study.extra as { engine?: { reportedModel?: string; provider?: string } } | null)?.engine;
  const family = (modelFamily(engine?.provider ?? study.backend, engine?.reportedModel ?? study.model) ?? "unknown").toLowerCase().replace(/[^a-z0-9.-]/g, "-").slice(0, 60);
  const protocol = study.protocol.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40);
  const engineVersion = packageVersion().replace(/[^0-9A-Za-z.+-]/g, "").slice(0, 32) || "0";
  return {
    modules: [...modules].sort().slice(0, 50),
    socle,
    personas: Math.max(1, Math.min(100_000, study.personaIds.length)),
    protocol,
    engineVersion,
    modelFamily: family || "unknown",
    day: (study.completedAt ?? new Date().toISOString()).slice(0, 10),
  };
}

export interface TelemetryOptions {
  settingsPath?: string | null;
  client?: HubClient;
  now?: Date;
}

/**
 * Fin d'une étude : si la télémétrie est acceptée, envoie l'agrégat (et la file en attente). Ne lève jamais,
 * ne bloque pas plus de quelques secondes ; sans consentement, ne lit rien d'autre que le réglage.
 */
export async function reportStudyCompleted(study: Parameters<typeof studyTelemetry>[0], opts: TelemetryOptions = {}): Promise<"disabled" | "sent" | "queued" | "skipped"> {
  const settingsPath = opts.settingsPath === undefined ? hubSettingsPath() : opts.settingsPath;
  try {
    if (!readHubSettings(settingsPath).telemetry.enabled) return "disabled";
    const event = studyTelemetry(study);
    const pending = readHubSettings(settingsPath).telemetry.pending as TelemetryStudy[];
    const batch = [...pending, ...(event && event.modules.length ? [event] : [])].slice(-MAX_PENDING);
    if (!batch.length) return "skipped";
    const installId = installIdFor(settingsPath, opts.now ?? new Date());
    const client = opts.client ?? new HubClient({ timeoutMs: 5_000 });
    try {
      await client.telemetry({ installId, studies: batch });
      updateHubSettings((s) => ({ ...s, telemetry: { ...s.telemetry, pending: [] } }), settingsPath);
      return "sent";
    } catch {
      updateHubSettings((s) => ({ ...s, telemetry: { ...s.telemetry, pending: s.telemetry.enabled ? batch : [] } }), settingsPath);
      return "queued";
    }
  } catch {
    return "skipped";
  }
}
