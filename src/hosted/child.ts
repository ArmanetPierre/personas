import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { IS_COMPILED, PACKAGE_ROOT, runMode } from "../config";
import { installHostedSecret } from "../engine/secrets";
import { compiledEntry } from "../web/launcher";

/**
 * Entrée des processus enfants du service hébergé (src/hosted/queue.ts) :
 *   node src/hosted/child.ts <fichier admis> <arguments…>
 * 1. lit sur l'entrée standard la clé déchiffrée du compte (`{"v":1,"profile":"user","apiKey":"…"}`), la range
 *    dans le magasin en mémoire du processus (jamais dans l'environnement ni sur la ligne de commande) ;
 * 2. lance le script demandé, s'il est dans la liste des tâches admises, avec ses arguments.
 */

/** Scripts lancés par la file : études, récits et assistants qui passent par le fournisseur de l'utilisateur. */
export const CHILD_FILES: ReadonlySet<string> = new Set([
  "src/cli/study-run.ts",
  "src/cli/study-recommend.ts",
  "src/cli/study-recode.ts",
  "src/cli/project-neutralize-pitch.ts",
  "src/cli/project-suggest-protocol.ts",
  "src/cli/personas-narrate.ts",
  "src/web/jobs/target-suggest.ts",
]);

export interface ChildPayload {
  profile: string;
  apiKey: string;
}

/** Charge utile de l'entrée standard (64 Kio au plus, délai de 10 s). */
export async function readPayload(stream: NodeJS.ReadableStream, opts: { maxBytes?: number; timeoutMs?: number } = {}): Promise<ChildPayload> {
  const max = opts.maxBytes ?? 65_536;
  const text = await new Promise<string>((ok, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => fail(new Error("Clé non reçue sur l'entrée standard.")), opts.timeoutMs ?? 10_000);
    stream.on("data", (c: Buffer | string) => {
      const b = typeof c === "string" ? Buffer.from(c) : c;
      size += b.length;
      if (size > max) {
        clearTimeout(timer);
        fail(new Error("Entrée standard trop longue."));
        return;
      }
      chunks.push(b);
    });
    stream.on("end", () => {
      clearTimeout(timer);
      ok(Buffer.concat(chunks).toString("utf8"));
    });
    stream.on("error", (e) => {
      clearTimeout(timer);
      fail(e);
    });
  });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("Charge utile illisible sur l'entrée standard.");
  }
  const p = raw as { v?: unknown; profile?: unknown; apiKey?: unknown };
  if (p.v !== 1 || typeof p.profile !== "string" || !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(p.profile) || typeof p.apiKey !== "string" || !p.apiKey) {
    throw new Error("Charge utile invalide sur l'entrée standard.");
  }
  return { profile: p.profile, apiKey: p.apiKey };
}

async function main(): Promise<void> {
  if (runMode() !== "hosted") throw new Error("src/hosted/child.ts ne tourne qu'en mode hébergé (PERSONAS_MODE=hosted).");
  const [file, ...args] = process.argv.slice(2);
  if (!file || !CHILD_FILES.has(file)) throw new Error(`Tâche refusée : ${file ?? "(aucune)"}`);
  const payload = await readPayload(process.stdin);
  installHostedSecret(payload.profile, payload.apiKey);
  const entry = resolve(PACKAGE_ROOT, IS_COMPILED ? compiledEntry(file) : file);
  // Le script lit ses options dans process.argv, comme lancé directement
  process.argv = [process.argv[0]!, entry, ...args];
  await import(pathToFileURL(entry).href);
}

// Lancé comme programme (pas importé par les tests)
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((err) => {
    console.error(`Échec : ${(err as Error).message}`);
    process.exitCode = 1;
  });
}
