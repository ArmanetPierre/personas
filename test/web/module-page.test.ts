import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config";
import { openDb } from "../../src/db/client";
import { createApp } from "../../src/web/app";
import { Launcher } from "../../src/web/launcher";
import { socleInfo } from "../../src/web/module-routes";
import { eligibilityText, fallbackValidate, moduleView, splitShareLabel } from "../../src/web/modules";
import { pack } from "../studies/fixtures";

/** Page d'un module : lecture en clair des filtres, parts sourcées, socles et brouillon d'origine (champs additifs de l'API). */

const REPO_MODULES = join(import.meta.dirname, "../../modules");
const def = fallbackValidate(readFileSync(join(REPO_MODULES, "jeux-video/module.yaml"), "utf8")).def!;

describe("Vue lisible d'un module", () => {
  it("lit les filtres prêts à l'emploi en clair (libellés d'attributs et de valeurs)", () => {
    expect(eligibilityText("jeux-video.player_frequency in [regulier_hebdomadaire, quotidien]", def)).toMatch(/^Fréquence de jeu vidéo : .+ ou .+$/);
    expect(eligibilityText("age < 35 and jeux-video.pc_gaming", def)).toBe("Âge < 35 et Joue sur ordinateur");
    expect(eligibilityText("jeux-video.player_frequency == jamais", def, "en")).not.toContain("jeux-video.");
    expect(eligibilityText("((", def)).toBeNull();
  });

  it("sépare le libellé d'une part sourcée de sa note de source", () => {
    expect(splitShareLabel("Femmes parmi les joueurs (SELL : 49 %)")).toEqual({ title: "Femmes parmi les joueurs", note: "SELL : 49 %" });
    expect(splitShareLabel("Part sans note")).toEqual({ title: "Part sans note", note: null });
  });

  it("expose filtres, parts sourcées et décomptes sans rien inventer", () => {
    const v = moduleView(def);
    expect(v.eligibilityHelpers.map((h) => h.name)).toEqual(Object.keys(def.eligibility_helpers));
    expect(v.eligibilityHelpers.every((h) => h.text && !h.text.includes("jeux-video."))).toBe(true);
    expect(v.validationShares[0]).toMatchObject({ title: "Joueurs parmi les adultes", range: def.validation.shares[0]!.range });
    expect(v.sourcedCount).toBe(def.attributes.filter((a) => a.sources.length > 0).length);
    expect(v.assumptionCount).toBe(def.attributes.filter((a) => a.assumption).length);
    expect(v.changelog[0]?.version).toBe(def.version);
  });
});

describe("API : socles et brouillon d'origine", () => {
  const tmp = mkdtempSync(join(tmpdir(), "personas-module-page-"));
  const modulesDir = join(tmp, "modules");
  cpSync(join(REPO_MODULES, "jeux-video"), join(modulesDir, "jeux-video"), { recursive: true });
  const draftDir = join(modulesDir, "_drafts", "jeux-video-0001");
  mkdirSync(draftDir, { recursive: true });
  writeFileSync(
    join(draftDir, "meta.json"),
    JSON.stringify({ id: "jeux-video-0001", status: "accepted", moduleId: "jeux-video", description: "Jeux vidéo en France", socle: "fr", updatedAt: "2026-10-22T10:00:00Z", history: [{ kind: "propose", summary: "Proposition initiale" }] }),
  );
  const { db, sqlite } = openDb(":memory:");
  const launcher = new Launcher({ root: tmp, logDir: join(tmp, "logs"), env: { PATH: "/usr/bin" } });
  const app = createApp({ db, pack, config: loadConfig({}), launcher, modulesDir, assistant: async () => ({ api: null, reason: "Assistant indisponible." }) });
  afterAll(() => {
    sqlite.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("socle : pays, langue et libellé lus dans le pack courant (dossier versionné ou dossier du pays)", () => {
    expect(socleInfo("fr")).toMatchObject({ country: "FR", locale: "fr" });
    expect(socleInfo("us")).toMatchObject({ country: "US", locale: "en" });
  });

  it("module validé : socles et demande d'origine, traduite en anglais", async () => {
    const r = await app.request("/api/modules/jeux-video");
    const body = (await r.json()) as { socles: Array<{ id: string; locale: string }>; origin: { id: string; description: string } | null };
    expect(body.socles).toEqual([expect.objectContaining({ id: "fr", locale: "fr" })]);
    expect(body.origin).toMatchObject({ id: "jeux-video-0001", description: "Jeux vidéo en France" });
    const en = (await (await app.request("/api/modules/jeux-video?lang=en")).json()) as { origin: { history: Array<{ summary: string }> } };
    expect(en.origin.history[0]!.summary).toBe("Initial proposal");
  });
});
