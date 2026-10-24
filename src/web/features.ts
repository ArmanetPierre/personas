/**
 * Fonctions disponibles, exposées par `GET /api/meta` (`features`) : l'interface masque ce qui manque.
 *
 * - Local (dépôt, paquet installé) : tout, y compris l'écran de premier lancement, les moteurs locaux
 *   (claude-cli, Ollama), le pré-tri, l'assistant de modules et la connexion au Hub par le trousseau.
 * - Service hébergé (src/hosted/) : sans ces fonctions locales ; à la place le compte, la clé IA de
 *   l'utilisateur et l'export de ses données.
 */

export const FEATURES = [
  "projects",
  "studies",
  "personas",
  "compare",
  "estimate",
  "target.preview",
  "target.suggest",
  "protocol.suggest",
  "pitch.neutralize",
  "recode",
  "recommendations",
  "modules.library",
  "modules.preview",
  "hub.catalog",
  /** Projet de démonstration (local : /api/setup/demo ; hébergé : même route, servie par le compte). */
  "demo",
  // Local seulement
  "setup",
  "engine.local",
  "engine.profiles",
  "triage",
  "modules.assistant",
  "hub.account",
  "hub.publish",
  "telemetry",
  // Service hébergé seulement
  "account",
  "engine.key",
  "export",
] as const;

export type Feature = (typeof FEATURES)[number];

const HOSTED_ONLY: ReadonlySet<Feature> = new Set(["account", "engine.key", "export"]);
const LOCAL_ONLY: ReadonlySet<Feature> = new Set(["setup", "engine.local", "engine.profiles", "triage", "modules.assistant", "hub.account", "hub.publish", "telemetry"]);

export const LOCAL_FEATURES: readonly Feature[] = FEATURES.filter((f) => !HOSTED_ONLY.has(f));
export const HOSTED_FEATURES: readonly Feature[] = FEATURES.filter((f) => !LOCAL_ONLY.has(f));
