import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseLegal } from "../../web/src/legal/parse";
import { parseEngine, PUBLIC_PATHS } from "../../web/src/session-data";

/** Front du service hébergé (phase 4, lot B) : lecture de la clé IA, pages publiques, textes légaux. */

describe("parseEngine", () => {
  it("lit la forme du serveur (plafonds dans limits) et l'objet nu", () => {
    const summary = { provider: "openai", model: "gpt-5-mini", last4: "wxyz", limits: { perStudyUsd: 5, perMonthUsd: 20 }, updatedAt: "2026-10-22T10:00:00Z" };
    expect(parseEngine({ engine: summary })).toEqual({ provider: "openai", model: "gpt-5-mini", last4: "wxyz", perStudyUsd: 5, perMonthUsd: 20, updatedAt: "2026-10-22T10:00:00Z" });
    expect(parseEngine({ provider: "gemini", model: "m", keyLast4: "123456", perStudyUsd: 2 })).toMatchObject({ last4: "3456", perStudyUsd: 2, perMonthUsd: null });
  });
  it("aucune clé : null", () => {
    expect(parseEngine({ engine: null })).toBeNull();
    expect(parseEngine({})).toBeNull();
    expect(parseEngine(null)).toBeNull();
  });
  it("ne renvoie jamais une clé en clair, même si le serveur en envoyait une", () => {
    const e = parseEngine({ provider: "anthropic", model: "m", last4: "abcd", apiKey: "plain-secret-value-abcd" });
    expect(JSON.stringify(e)).not.toContain("plain-secret");
  });
});

describe("pages publiques", () => {
  it("connexion et textes légaux seulement", () => {
    expect([...PUBLIC_PATHS].sort()).toEqual(["/conditions", "/confidentialite", "/connexion"]);
  });
});

describe("textes légaux hébergés", () => {
  const read = (f: string) => readFileSync(`web/src/legal/${f}`, "utf8");
  for (const doc of ["privacy", "terms"]) {
    it(`${doc} : FR et EN ont la même structure, une version et le contact`, () => {
      const fr = parseLegal(read(`${doc}.fr.md`));
      const en = parseLegal(read(`${doc}.en.md`));
      expect(fr.version).toBe(en.version);
      expect(fr.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(fr.title).not.toBe("");
      expect(fr.blocks.map((b) => b.type)).toEqual(en.blocks.map((b) => b.type));
      for (const f of ["fr", "en"]) expect(read(`${doc}.${f}.md`)).toContain("pierre.armanet.pa@gmail.com");
    });
  }
  it("la confidentialité dit le stockage serveur, le chiffrement de la clé, le fournisseur destinataire, l'absence de cookie de suivi", () => {
    const fr = read("privacy.fr.md");
    expect(fr).toMatch(/stockés sur le serveur/);
    expect(fr).toMatch(/chiffrée sur le serveur/);
    expect(fr).toMatch(/devient destinataire/);
    expect(fr).toMatch(/Pas de cookie de suivi/);
    const en = read("privacy.en.md");
    expect(en).toMatch(/becomes a recipient/);
    expect(en).toMatch(/No tracking cookie/);
  });
});
