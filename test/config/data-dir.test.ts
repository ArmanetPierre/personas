import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { defaultDatabasePath, loadConfig, mergeDotEnv, runMode, userDataDir } from "../../src/config";
import { compiledEntry, Launcher, nodeArgs, scriptFile, type SpawnFn } from "../../src/web/launcher";

/** Dossier de données : ./data dans le dépôt, dossier de l'utilisateur pour le paquet installé. */

const tmp = mkdtempSync(join(tmpdir(), "personas-datadir-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("mode d'exécution", () => {
  it("dépôt : sources TypeScript, ou code compilé avec un dossier .git", () => {
    const repo = join(tmp, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const pkgDir = join(tmp, "installed");
    mkdirSync(pkgDir, { recursive: true });
    expect(runMode({}, { compiled: false, root: pkgDir })).toBe("repo");
    expect(runMode({}, { compiled: true, root: repo })).toBe("repo");
    expect(runMode({}, { compiled: true, root: pkgDir })).toBe("installed");
    expect(runMode({ PERSONAS_MODE: "installed" }, { compiled: false })).toBe("installed");
    expect(runMode({ PERSONAS_MODE: "repo" }, { compiled: true, root: pkgDir })).toBe("repo");
    // Les tests tournent depuis les sources du dépôt
    expect(runMode({})).toBe("repo");
  });
});

describe("dossier de données par utilisateur", () => {
  const home = "/home/alice";
  it("selon le système", () => {
    expect(userDataDir({}, "darwin", "/home/alice")).toBe("/home/alice/Library/Application Support/Personas");
    expect(userDataDir({ APPDATA: "C:\\Users\\alice\\AppData\\Roaming" }, "win32", "C:\\Users\\alice")).toBe(join("C:\\Users\\alice\\AppData\\Roaming", "Personas"));
    expect(userDataDir({}, "win32", "C:\\Users\\alice")).toBe(join("C:\\Users\\alice", "AppData", "Roaming", "Personas"));
    expect(userDataDir({ XDG_DATA_HOME: "/xdg" }, "linux", home)).toBe("/xdg/personas");
    expect(userDataDir({}, "linux", home)).toBe("/home/alice/.local/share/personas");
  });

  it("PERSONAS_DATA_DIR l'emporte", () => {
    expect(userDataDir({ PERSONAS_DATA_DIR: "/tmp/p" }, "darwin", home)).toBe("/tmp/p");
    expect(userDataDir({ PERSONAS_DATA_DIR: "rel/dir" }, "linux", home)).toBe(resolve("rel/dir"));
  });

  it("base par défaut : ./data dans le dépôt (inchangé), dossier de l'utilisateur une fois installé", () => {
    expect(defaultDatabasePath({}, "repo")).toBe("./data/personas.db");
    expect(loadConfig({}).DATABASE_PATH).toBe("./data/personas.db");
    expect(defaultDatabasePath({ PERSONAS_DATA_DIR: "/tmp/p" }, "repo")).toBe("/tmp/p/personas.db");
    expect(defaultDatabasePath({ PERSONAS_DATA_DIR: "/tmp/p" }, "installed")).toBe("/tmp/p/personas.db");
    expect(defaultDatabasePath({}, "installed")).toBe(join(userDataDir({}), "personas.db"));
    expect(loadConfig({}, { mode: "installed" }).DATABASE_PATH).toBe(join(userDataDir({}), "personas.db"));
    // DATABASE_PATH explicite : toujours respecté
    expect(loadConfig({ DATABASE_PATH: "/x/y.db" }, { mode: "installed" }).DATABASE_PATH).toBe("/x/y.db");
  });
});

describe("précédence de la base : environnement du processus avant .env (tests V1, C14 B2)", () => {
  const dotEnv = { DATABASE_PATH: "./data/personas.db", PERSONAS_LANG: "fr" };
  const merged = (env: NodeJS.ProcessEnv) => {
    const e = { ...env };
    mergeDotEnv(e, dotEnv);
    return e;
  };

  it("sans variable : la base du .env (comportement par défaut inchangé)", () => {
    expect(loadConfig(merged({})).DATABASE_PATH).toBe("./data/personas.db");
    expect(loadConfig(merged({}), { mode: "repo" }).DATABASE_PATH).toBe("./data/personas.db");
  });

  it("PERSONAS_DATA_DIR du processus l'emporte sur DATABASE_PATH du .env", () => {
    const e = merged({ PERSONAS_DATA_DIR: "/tmp/p" });
    expect(e.DATABASE_PATH).toBeUndefined(); // les enfants héritent du dossier seul
    expect(e.PERSONAS_LANG).toBe("fr"); // les autres variables du .env restent chargées
    expect(loadConfig(e, { mode: "repo" }).DATABASE_PATH).toBe("/tmp/p/personas.db");
  });

  it("DATABASE_PATH du processus l'emporte sur tout", () => {
    expect(loadConfig(merged({ DATABASE_PATH: "/x/y.db" })).DATABASE_PATH).toBe("/x/y.db");
    expect(loadConfig(merged({ DATABASE_PATH: "/x/y.db", PERSONAS_DATA_DIR: "/tmp/p" })).DATABASE_PATH).toBe("/x/y.db");
  });

  it("PERSONAS_DATA_DIR du .env : DATABASE_PATH du .env reste prioritaire, sinon le dossier", () => {
    const both = {};
    mergeDotEnv(both, { DATABASE_PATH: "./data/personas.db", PERSONAS_DATA_DIR: "/tmp/q" });
    expect(loadConfig(both, { mode: "repo" }).DATABASE_PATH).toBe("./data/personas.db");
    const dirOnly = {};
    mergeDotEnv(dirOnly, { PERSONAS_DATA_DIR: "/tmp/q" });
    expect(loadConfig(dirOnly, { mode: "repo" }).DATABASE_PATH).toBe("/tmp/q/personas.db");
  });

  it("n'écrase jamais une variable déjà définie", () => {
    const e: NodeJS.ProcessEnv = { PERSONAS_LANG: "en" };
    expect(mergeDotEnv(e, dotEnv)).toEqual(["DATABASE_PATH"]);
    expect(e.PERSONAS_LANG).toBe("en");
  });
});

describe("lanceur : entrée compilée ou tsx", () => {
  it("dépôt : tsx sur le fichier source ; paquet : l'entrée compilée, sans tsx", () => {
    expect(nodeArgs("/r", "src/cli/study-run.ts", false)).toEqual(["/r/node_modules/tsx/dist/cli.mjs", "src/cli/study-run.ts"]);
    expect(nodeArgs("/r", "src/cli/study-run.ts", true)).toEqual(["/r/dist/cli/study-run.js"]);
    expect(compiledEntry("src/web/jobs/target-suggest.ts")).toBe("dist/web/jobs/target-suggest.js");
  });

  it("compilé : lance node dist/…/x.js dans le dossier demandé, sans ANTHROPIC_*", () => {
    const calls: Array<{ cmd: string; args: string[]; cwd: string | undefined; env: NodeJS.ProcessEnv }> = [];
    const spawnFn: SpawnFn = (cmd, args, opts) => (calls.push({ cmd, args, cwd: opts.cwd as string | undefined, env: opts.env ?? {} }), { pid: 999_999_999, unref() {} });
    const l = new Launcher({ root: "/pkg", logDir: join(tmp, "logs"), spawnFn, compiled: true, cwd: join(tmp, "data"), env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "x" } });
    l.start("st-abc");
    expect(calls[0]).toMatchObject({ cmd: process.execPath, args: ["/pkg/dist/cli/study-run.js", "--study", "st-abc"], cwd: join(tmp, "data") });
    expect(calls[0]!.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("scriptFile vérifie l'entrée compilée quand le code est compilé", () => {
    expect(scriptFile(process.cwd(), "study:run", false)).toBe("src/cli/study-run.ts");
    expect(scriptFile(tmp, "study:run", true)).toBeNull();
  });
});
