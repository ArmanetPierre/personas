import { runMode, type RunMode } from "./config";

/**
 * Commandes citées dans les messages (aide, erreurs, pauses) selon le mode d'exécution :
 * - dépôt : le script npm, comme historiquement (`npm run study:run -- --study <id>`) ;
 * - paquet installé (et hébergé) : le binaire (`personas study run --study <id>`), seul disponible hors du dépôt.
 * Le script `x:y` correspond à `personas x y` (src/cli/commands.ts) ; les options sont les mêmes.
 */

/** Commande d'un script npm (`study:run`) avec ses arguments, selon le mode. */
export function cliCommand(script: string, args = "", mode: RunMode = runMode()): string {
  const tail = args.trim();
  if (mode === "repo") return `npm run ${script}${tail ? ` -- ${tail}` : ""}`;
  return `personas ${script.split(":").join(" ")}${tail ? ` ${tail}` : ""}`;
}

/** `npm run x:y -- a` (ou `[-- a]`, ou sans argument) → `personas x y a` ; les scripts sans « : » restent tels quels sauf `mcp`. */
const NPM_RUN = /npm run ((?:[a-z0-9][a-z0-9-]*)(?::[a-z0-9][a-z0-9-]*)+|mcp)\b( \[-- | --(?= |$))?/g;

/** Réécrit les `npm run x:y` d'un texte en commandes `personas x y` hors du mode dépôt ; inchangé en mode dépôt. */
export function localizeCommands(text: string, mode: RunMode = runMode()): string {
  if (mode === "repo" || !text.includes("npm run ")) return text;
  return text.replace(NPM_RUN, (_m, script: string, sep: string | undefined) => `personas ${script.split(":").join(" ")}${sep === " [-- " ? " [" : ""}`);
}
