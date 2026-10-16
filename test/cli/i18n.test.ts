import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CLI_MESSAGES, detectCliLang, errorText } from "../../src/cli/i18n";

/** Sorties console de la CLI : choix de la langue, dictionnaire anglais complet, français inchangé. */

const fr = CLI_MESSAGES.fr;
const en = CLI_MESSAGES.en;

describe("langue de la CLI", () => {
  it("PERSONAS_LANG l'emporte sur la locale", () => {
    expect(detectCliLang({ PERSONAS_LANG: "en", LANG: "fr_FR.UTF-8" })).toBe("en");
    expect(detectCliLang({ PERSONAS_LANG: "fr", LANG: "en_US.UTF-8" })).toBe("fr");
    expect(detectCliLang({ PERSONAS_LANG: " FR ", LC_ALL: "en_GB.UTF-8" })).toBe("fr");
  });

  it("PERSONAS_LANG de .env sert si l'environnement ne le fixe pas", () => {
    expect(detectCliLang({ LANG: "en_US.UTF-8" }, "fr")).toBe("fr");
    expect(detectCliLang({ PERSONAS_LANG: "en" }, "fr")).toBe("en");
  });

  it("valeur inconnue de PERSONAS_LANG : repli sur la locale", () => {
    expect(detectCliLang({ PERSONAS_LANG: "de", LANG: "fr_FR.UTF-8" })).toBe("fr");
    expect(detectCliLang({ PERSONAS_LANG: "", LANG: "en_US.UTF-8" })).toBe("en");
  });

  it("locale : LC_ALL, puis LC_MESSAGES, puis LANG ; fr* → fr, sinon en", () => {
    expect(detectCliLang({ LANG: "fr_FR.UTF-8" })).toBe("fr");
    expect(detectCliLang({ LANG: "fr_CA" })).toBe("fr");
    expect(detectCliLang({ LANG: "en_US.UTF-8" })).toBe("en");
    expect(detectCliLang({ LANG: "de_DE.UTF-8" })).toBe("en");
    expect(detectCliLang({ LC_ALL: "en_US.UTF-8", LANG: "fr_FR.UTF-8" })).toBe("en");
    expect(detectCliLang({ LC_MESSAGES: "fr_FR.UTF-8", LANG: "en_US.UTF-8" })).toBe("fr");
    expect(detectCliLang({ LC_ALL: "", LC_MESSAGES: "", LANG: "fr_FR.UTF-8" })).toBe("fr");
    expect(detectCliLang({ LANG: "C" })).toBe("en");
    expect(detectCliLang({})).toBe("en");
  });
});

describe("dictionnaires", () => {
  it("l'anglais a les mêmes clés et les mêmes types que le français", () => {
    const shape = (o: Record<string, unknown>): unknown =>
      Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v && typeof v === "object" ? shape(v as Record<string, unknown>) : typeof v]));
    expect(shape(en)).toEqual(shape(fr));
  });

  it("français identique à l'historique", () => {
    expect(fr.studyRun.usage).toBe("Usage : npm run study:run -- --study <id> [--concurrency N]");
    expect(fr.studyRun.complete("st-1")).toBe("\nÉtude complète. Résumé : npm run study:summary -- --study st-1");
    expect(fr.common.projectNotFound("x")).toBe("Projet introuvable : x");
    expect(fr.personasNarrate.missingLine("p1", [])).toBe("- p1 : échec");
    expect(fr.studyRun.tokens(10, 0, 5, "1.0", undefined)).toBe("Tokens : 10 en entrée (dont 0 en cache), 5 en sortie ; 1.0 s par réponse (concurrence comprise).");
  });

  it("quelques messages en anglais", () => {
    expect(en.studyRun.usage).toBe("Usage: npm run study:run -- --study <id> [--concurrency N]");
    expect(en.studyRun.complete("st-1")).toBe("\nStudy complete. Summary: npm run study:summary -- --study st-1");
    expect(en.common.projectNotFound("x")).toBe("Project not found: x");
    expect(en.personasGenerate.badArgs).toBe("--count must be an integer ≥ 1 and --seed an integer.");
    expect(en.populationDraw.rate("1.89%", "1.23%", "2.90%", 20)).toBe("Eligibility rate: 1.89% [95% CI 1.23%; 2.90%] (20 eligible)");
    expect(en.common.pct).toBe("%");
    expect(fr.common.pct).toBe(" %");
  });

  it("erreurs levées par src/ : traduites en anglais si le motif est connu, inchangées en français", () => {
    expect(errorText(new Error("Étude introuvable : st-x"), "en")).toBe("Study not found: st-x");
    expect(errorText(new Error("Étude introuvable : st-x"), "fr")).toBe("Étude introuvable : st-x");
  });
});

describe("processus CLI", () => {
  const tsx = resolve("node_modules/tsx/dist/cli.mjs");
  const help = (env: NodeJS.ProcessEnv) =>
    execFileSync(process.execPath, [tsx, resolve("src/cli/study-summary.ts"), "--help"], {
      // cwd hors du dépôt : le .env du poste (et son éventuel PERSONAS_LANG) ne s'en mêle pas
      cwd: tmpdir(),
      env: { PATH: process.env.PATH, ...env },
      encoding: "utf8",
    });

  it("--help suit PERSONAS_LANG et LANG", () => {
    expect(help({ PERSONAS_LANG: "fr" })).toBe("Usage : npm run study:summary -- --study <id> [--json] [--out fichier.json]\n");
    expect(help({ LANG: "fr_FR.UTF-8", PERSONAS_LANG: "" })).toBe("Usage : npm run study:summary -- --study <id> [--json] [--out fichier.json]\n");
    expect(help({ LANG: "en_US.UTF-8", PERSONAS_LANG: "" })).toBe("Usage: npm run study:summary -- --study <id> [--json] [--out file.json]\n");
  }, 30_000);
});
