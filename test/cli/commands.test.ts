import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commandsInGroup, commandTable, resolveCommand, scriptArgs } from "../../src/cli/commands";
import { en } from "../../src/cli/messages.en";
import { fr } from "../../src/cli/messages.fr";
import { compiledEntry } from "../../src/web/launcher";

/** Sous-commandes du binaire `personas` : correspondance automatique script `x:y` → `personas x y`. */

const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { scripts: Record<string, string>; bin: Record<string, string>; files: string[] };
const table = commandTable(pkg.scripts);

describe("table des sous-commandes", () => {
  it("chaque script « tsx src/… » devient une sous-commande, sauf start:web (remplacé par personas ui)", () => {
    const scripts = Object.entries(pkg.scripts).filter(([k, v]) => /^tsx\s+src\/\S+\.ts$/.test(v) && k !== "start:web").map(([k]) => k);
    expect(table.map((c) => c.script).sort()).toEqual(scripts.sort());
    expect(table.length).toBeGreaterThanOrEqual(30);
    expect(table.find((c) => c.script === "start:web")).toBeUndefined();
    expect(table.find((c) => c.script === "dev:web")).toBeUndefined(); // tsx watch
    expect(table.find((c) => c.script === "test")).toBeUndefined();
  });

  it("les fichiers lancés existent, et le binaire pointe sur l'entrée compilée", () => {
    for (const c of table) expect(existsSync(join(process.cwd(), c.file)), c.file).toBe(true);
    expect(pkg.bin.personas).toBe(compiledEntry("src/cli/main.ts"));
    expect(compiledEntry("src/web/jobs/target-preview.ts")).toBe("dist/web/jobs/target-preview.js");
  });

  it("chaque sous-commande a une description en français et en anglais", () => {
    for (const c of table) {
      expect(fr.personasCli.descriptions[c.script], c.script).toBeTruthy();
      expect(en.personasCli.descriptions[c.script], c.script).toBeTruthy();
    }
  });

  it("résout la sous-commande la plus longue et passe le reste au script", () => {
    expect(resolveCommand(table, ["study", "run", "st-abc", "--concurrency", "2"])).toMatchObject({ command: { script: "study:run", file: "src/cli/study-run.ts" }, args: ["st-abc", "--concurrency", "2"] });
    expect(resolveCommand(table, ["project", "create", "--file", "x.yaml"])).toMatchObject({ command: { script: "project:create" }, args: ["--file", "x.yaml"] });
    expect(resolveCommand(table, ["engine", "profile", "add", "--name", "a"])).toMatchObject({ command: { script: "engine:profile" }, args: ["add", "--name", "a"] });
    expect(resolveCommand(table, ["project", "suggest-protocol", "p1"])?.command.script).toBe("project:suggest-protocol");
    expect(resolveCommand(table, ["mcp"])).toMatchObject({ command: { script: "mcp", file: "src/mcp/main.ts" }, args: [] });
    expect(resolveCommand(table, ["study"])).toBeNull();
    expect(resolveCommand(table, ["inconnu", "x"])).toBeNull();
    expect(commandsInGroup(table, "engine").map((c) => c.script)).toEqual(["engine:check", "engine:key", "engine:profile"]);
  });

  it("accepte l'identifiant en tête sans son option", () => {
    expect(scriptArgs("study:run", ["st-abc", "--concurrency", "2"])).toEqual(["--study", "st-abc", "--concurrency", "2"]);
    expect(scriptArgs("study:run", ["--study", "st-abc"])).toEqual(["--study", "st-abc"]);
    expect(scriptArgs("study:run", [])).toEqual([]);
    expect(scriptArgs("project:create", ["x"])).toEqual(["x"]);
  });

  it("table construite sur des scripts quelconques", () => {
    const t = commandTable({ "a:b-c": "tsx src/cli/a.ts", "x:y": "tsx src/cli/x.ts --flag", "dev:web": "tsx watch src/web/dev.ts", "Up:x": "tsx src/cli/u.ts" });
    expect(t).toEqual([{ words: ["a", "b-c"], script: "a:b-c", file: "src/cli/a.ts" }]);
  });
});

describe("contenu du paquet", () => {
  it("files : seulement ce qui sert à l'exécution, rien de privé", () => {
    expect(pkg.files).toEqual(expect.arrayContaining(["dist/", "web/dist/", "drizzle/", "docs/modules.md", "calibration/payment-v3.json", "examples/sg/recipe-app.yaml"]));
    expect(pkg.files.some((f) => /src\/|test\/|_drafts|truth\.json|docs\/rex|data\//.test(f))).toBe(false);
    // Exemples : seulement les projets de démonstration (génériques, publiés)
    expect(pkg.files.filter((f) => f.startsWith("examples/")).sort()).toEqual(["examples/meal-planner-numerique.json", "examples/meal-planner.json", "examples/sg/recipe-app.yaml"]);
    for (const f of pkg.files.filter((x) => !x.includes("*") && !x.startsWith("dist") && !x.startsWith("web/dist"))) expect(existsSync(join(process.cwd(), f)), f).toBe(true);
  });
});
