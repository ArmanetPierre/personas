#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { IS_COMPILED, loadConfig, PACKAGE_ROOT, runMode } from "../config";
import { localizeCommands } from "../hints";
import { engineConfigPath } from "../engine/profiles";
import { compiledEntry } from "../web/launcher";
import { commandsInGroup, commandTable, resolveCommand, scriptArgs, type CliCommand } from "./commands";
import { t } from "./i18n";

/**
 * Binaire `personas` (champ bin de package.json) : `personas study run …` lance le fichier du script npm
 * `study:run` avec les arguments restants (fichiers src/cli/*.ts réutilisés tels quels, compilés dans dist/
 * pour le paquet installé). `personas ui` ouvre le tableau de bord ; `personas --help` liste les commandes.
 */

const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as { version?: string; scripts?: Record<string, string> };
const table = commandTable(pkg.scripts);

// Hors du dépôt, les scripts npm n'existent pas : les commandes citées dans les sorties deviennent `personas x y`
if (runMode() !== "repo") {
  for (const k of ["log", "error", "warn", "info"] as const) {
    const original = console[k].bind(console);
    console[k] = (...args: unknown[]) => original(...args.map((a) => (typeof a === "string" ? localizeCommands(a) : a)));
  }
}
const argv = process.argv.slice(2);
const first = argv[0];

const row = (name: string, desc: string) => `  ${name.padEnd(28)} ${desc}`.trimEnd();
const describe = (c: CliCommand) => row(c.words.join(" "), t.personasCli.descriptions[c.script] ?? "");

function help(): string {
  const config = loadConfig();
  return [
    t.personasCli.intro,
    "",
    t.personasCli.usage,
    "",
    t.personasCli.dashboard,
    row("ui", t.personasCli.uiDescription),
    "",
    t.personasCli.commands,
    ...table.map(describe),
    "",
    t.personasCli.paths(dirname(config.DATABASE_PATH), engineConfigPath()),
  ].join("\n");
}

async function ui(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { port: { type: "string" }, "no-open": { type: "boolean", default: false }, help: { type: "boolean", short: "h" } } });
  if (values.help) return void console.log(t.personasCli.uiUsage);
  const port = values.port === undefined ? 0 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(t.personasCli.uiBadPort(String(values.port)));
    process.exit(2);
  }
  const { startDashboard } = await import("../web/serve");
  const d = await startDashboard({ port });
  console.log(t.personasCli.uiReady(d.url));
  console.log(t.personasCli.uiData(dirname(loadConfig().DATABASE_PATH)));
  if (!values["no-open"]) openBrowser(d.url);
  const stop = () => {
    d.close();
    console.log(t.personasCli.uiStopped);
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

/** Ouvre l'URL dans le navigateur par défaut (sans shell ; un échec n'arrête pas le serveur). */
function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", '""', url]] : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true, windowsVerbatimArguments: process.platform === "win32" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // pas de navigateur : l'URL est affichée
  }
}

if (!first || first === "--help" || first === "-h" || first === "help") {
  console.log(help());
} else if (first === "--version" || first === "-v") {
  console.log(pkg.version ?? "");
} else if (first === "ui") {
  await ui(argv.slice(1));
} else {
  const hit = resolveCommand(table, argv);
  if (hit) {
    const entry = join(PACKAGE_ROOT, IS_COMPILED ? compiledEntry(hit.command.file) : hit.command.file);
    // Le script lit ses options dans process.argv, comme lancé par npm run
    process.argv = [process.argv[0]!, entry, ...scriptArgs(hit.command.script, hit.args)];
    try {
      await import(pathToFileURL(entry).href);
    } catch (err) {
      // Option inconnue ou mal formée (parseArgs) : message d'usage, code 2, pas de pile Node
      const code = (err as { code?: unknown } | null)?.code;
      if (typeof code !== "string" || !code.startsWith("ERR_PARSE_ARGS_")) throw err;
      const words = `personas ${hit.command.words.join(" ")}`;
      const option = code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" ? /'([^']+)'/.exec((err as Error).message)?.[1] : undefined;
      console.error(option ? t.personasCli.unknownOption(option, words) : t.personasCli.badArguments((err as Error).message, words));
      process.exitCode = 2;
    }
  } else {
    const group = commandsInGroup(table, first);
    if (group.length && (argv.length === 1 || argv[1] === "--help" || argv[1] === "-h")) {
      console.log([t.personasCli.group(first), ...group.map(describe)].join("\n"));
    } else {
      console.error(t.personasCli.unknown(argv.join(" ")));
      process.exitCode = 2;
    }
  }
}
