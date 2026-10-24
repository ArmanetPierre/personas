/**
 * Sous-commandes du binaire `personas` (src/cli/main.ts), tirées des scripts npm de package.json :
 * le script `x:y` (« tsx src/…/fichier.ts ») devient `personas x y`, qui lance le même fichier avec les
 * mêmes options. Les alias `npm run x:y` restent valables dans le dépôt.
 */

export interface CliCommand {
  /** Mots de la sous-commande : `study:run` → ["study", "run"]. */
  words: string[];
  /** Nom du script npm. */
  script: string;
  /** Fichier source lancé (relatif à la racine du paquet), ex. `src/cli/study-run.ts`. */
  file: string;
}

/** Scripts non exposés : `start:web` est remplacé par `personas ui` (port libre, navigateur). */
export const HIDDEN_SCRIPTS: ReadonlySet<string> = new Set(["start:web"]);

/** Commandes intégrées au binaire (pas de script npm). */
export const BUILTIN_COMMANDS = ["ui"] as const;

/** Table des sous-commandes : chaque script « tsx <fichier.ts> » (sans autre argument), triée par nom. */
export function commandTable(scripts: Record<string, string> | undefined): CliCommand[] {
  const out: CliCommand[] = [];
  for (const [script, value] of Object.entries(scripts ?? {})) {
    if (HIDDEN_SCRIPTS.has(script)) continue;
    const m = value.trim().match(/^tsx\s+(src\/\S+\.ts)$/);
    if (!m) continue;
    const words = script.split(":").filter(Boolean);
    if (!words.length || words.some((w) => !/^[a-z0-9][a-z0-9-]*$/.test(w))) continue;
    out.push({ words, script, file: m[1]! });
  }
  return out.sort((a, b) => a.script.localeCompare(b.script));
}

/** Sous-commande la plus longue qui correspond au début de `argv` ; le reste est passé au script. */
export function resolveCommand(table: readonly CliCommand[], argv: readonly string[]): { command: CliCommand; args: string[] } | null {
  let best: CliCommand | null = null;
  for (const c of table) {
    if (c.words.length > argv.length) continue;
    if (c.words.every((w, i) => argv[i] === w) && (!best || c.words.length > best.words.length)) best = c;
  }
  return best ? { command: best, args: argv.slice(best.words.length) } : null;
}

/** Commandes d'un groupe (`personas engine` → engine check, engine key, engine profile). */
export function commandsInGroup(table: readonly CliCommand[], group: string): CliCommand[] {
  return table.filter((c) => c.words[0] === group && c.words.length > 1);
}

/**
 * Identifiant en tête accepté sans son option : `personas study run st-…` = `personas study run --study st-…`.
 * Les scripts gardent leurs options d'origine ; seule la forme courte est ajoutée ici.
 */
export const LEADING_ID_OPTION: Readonly<Record<string, string>> = {
  "study:run": "--study",
  "study:summary": "--study",
  "study:drivers": "--study",
  "study:recode": "--study",
  "project:neutralize-pitch": "--project",
  "project:suggest-protocol": "--project",
};

export function scriptArgs(script: string, args: readonly string[]): string[] {
  const opt = LEADING_ID_OPTION[script];
  const [head, ...rest] = args;
  return opt && head !== undefined && !head.startsWith("-") ? [opt, head, ...rest] : [...args];
}
