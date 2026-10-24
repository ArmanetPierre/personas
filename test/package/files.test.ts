import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { PACKAGE_ROOT } from "../../src/config";
import { MIGRATIONS_DIR } from "../../src/db/client";
import { PRICING_FILE } from "../../src/engine/pricing";
import { ARCHIVE_DIR, MODULES_DIR } from "../../src/modules/registry";
import { PACKS_DIR } from "../../src/personas/pack-common";
import { REFERENCE_FILE } from "../../src/studies/cost";
import { CALIBRATION_FILE } from "../../src/studies/payment";
import { DEMO_PROJECTS } from "../../src/web/setup-routes";

/**
 * Bug B1 des tests V1 : pricing/*.json manquait au paquet npm. Chaque fichier lu à l'exécution depuis la racine
 * du paquet (PACKAGE_ROOT, import.meta.dirname) doit figurer dans `npm pack` (champ `files` de package.json).
 * `--ignore-scripts` : pas de build (prepack) ; dist/ et web/dist/ sont vérifiés seulement s'ils existent.
 */

const rel = (p: string) => relative(PACKAGE_ROOT, p).replaceAll("\\", "/");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

function packedFiles(): Set<string> {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: PACKAGE_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const [pack] = JSON.parse(out) as Array<{ files: Array<{ path: string }> }>;
  return new Set(pack!.files.map((f) => f.path));
}

/** Chemins lus à l'exécution, relatifs à la racine du paquet. */
function runtimePaths(): string[] {
  const paths = [
    "package.json",
    rel(PRICING_FILE),
    rel(REFERENCE_FILE),
    rel(CALIBRATION_FILE),
    // Assistant de modules (src/modules/assistant/prompts.ts) : format et exemple
    "docs/modules.md",
    "modules/numerique/module.yaml",
    // Projets de démonstration de l'écran de premier lancement (web, hébergé)
    ...Object.values(DEMO_PROJECTS),
    // Migrations (src/db/client.ts) : tout le dossier, journal compris
    ...walk(MIGRATIONS_DIR).map(rel),
    // Socles (src/personas/pack-common.ts) : tous les JSON, socles.json compris
    ...walk(PACKS_DIR).filter((p) => p.endsWith(".json")).map(rel),
    // Bibliothèque de modules validés et archivés (src/modules/registry.ts) ; jamais les brouillons
    ...readdirSync(MODULES_DIR)
      .filter((d) => d !== "_drafts" && d !== ARCHIVE_DIR && existsSync(join(MODULES_DIR, d, "module.yaml")))
      .map((d) => `modules/${d}/module.yaml`),
    ...readdirSync(join(MODULES_DIR, ARCHIVE_DIR))
      .filter((d) => existsSync(join(MODULES_DIR, ARCHIVE_DIR, d, "module.yaml")))
      .map((d) => `modules/${ARCHIVE_DIR}/${d}/module.yaml`),
  ];
  // Code compilé et front : présents seulement après un build
  if (existsSync(join(PACKAGE_ROOT, "dist/cli/main.js"))) paths.push("dist/cli/main.js", "dist/config.js", "dist/engine/pricing.js");
  if (existsSync(join(PACKAGE_ROOT, "web/dist/index.html"))) paths.push("web/dist/index.html");
  return [...new Set(paths)];
}

describe("paquet npm : fichiers lus à l'exécution", () => {
  it("chaque chemin lu à l'exécution est dans npm pack", () => {
    const packed = packedFiles();
    const runtime = runtimePaths();
    expect(runtime).toContain("pricing/models.json");
    expect(runtime).toContain("pricing/reference-usage.json");
    const missing = runtime.filter((p) => !packed.has(p));
    expect(missing).toEqual([]);
  }, 30_000);

  it("rien de privé : ni data/, ni .env, ni brouillons, ni tests, ni docs/rex", () => {
    const leaked = [...packedFiles()].filter((p) => /^(data\/|\.env|modules\/_drafts\/|test\/|docs\/rex\/|docs\/tests-v1)/.test(p));
    expect(leaked).toEqual([]);
  }, 30_000);
});
