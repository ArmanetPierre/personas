/**
 * `study create` (src/cli/study-create.ts) : un refus (coût inconnu sans --accept-unknown-cost) n'enregistre rien,
 * pas même le projet lu depuis --project <fichier> ; une création acceptée enregistre projet et étude. Processus
 * réel, base et profils dans un dossier temporaire, cwd hors du dépôt (le .env du poste ne s'en mêle pas) ; aucun
 * appel de modèle (--no-narrate, refus avant toute exécution).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const tsx = resolve("node_modules/tsx/dist/cli.mjs");
let dir: string;
let env: NodeJS.ProcessEnv;

function cli(script: string, args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [tsx, resolve(script), ...args], { cwd: tmpdir(), env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { code: e.status, out: `${e.stdout}${e.stderr}` };
  }
}

const rows = (table: "projects" | "studies") => {
  const db = new Database(join(dir, "personas.db"), { readonly: true });
  try {
    return db.prepare(`select * from ${table} order by id`).all();
  } finally {
    db.close();
  }
};

const create = (project: string, ...extra: string[]) =>
  cli("src/cli/study-create.ts", ["--project", resolve("examples", project), "--profile", "t-unknown", "--n", "20", "--no-narrate", ...extra]);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "study-create-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ version: 1, profiles: [{ name: "t-unknown", provider: "openai", model: "modele-sans-prix-x" }] }));
  env = { PATH: process.env.PATH, HOME: dir, DATABASE_PATH: join(dir, "personas.db"), PERSONAS_DATA_DIR: dir, PERSONAS_CONFIG: join(dir, "config.json"), PERSONAS_LANG: "fr" };
  const gen = cli("src/cli/personas-generate.ts", ["--count", "200", "--pack", "fr"]);
  expect(gen.code, gen.out).toBe(0);
}, 120_000);
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("study create : refus sans écriture", () => {
  it("coût inconnu sans --accept-unknown-cost : code 2, aucun projet ni étude enregistrés", () => {
    const r = create("meal-planner.json");
    expect(r.code, r.out).toBe(2);
    expect(r.out).toMatch(/Coût inconnu pour le modèle modele-sans-prix-x/);
    expect(rows("projects")).toEqual([]);
    expect(rows("studies")).toEqual([]);
  }, 60_000);

  it("création acceptée : projet et étude enregistrés ; un refus ensuite laisse la table projects inchangée", () => {
    const ok = create("meal-planner.json", "--accept-unknown-cost");
    expect(ok.code, ok.out).toBe(0);
    const projects = rows("projects");
    expect(projects).toHaveLength(1);
    expect(rows("studies")).toHaveLength(1);
    // Autre fichier projet (nouveau projet), puis le même fichier (mise à jour) : refusés, rien ne change
    for (const file of ["meal-planner-v2.json", "meal-planner.json"]) {
      const r = create(file);
      expect(r.code, r.out).toBe(2);
      expect(rows("projects")).toEqual(projects);
      expect(rows("studies")).toHaveLength(1);
    }
  }, 120_000);
});
