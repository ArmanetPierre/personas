import { generateKeyPairSync } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openPglite, type HubDb } from "../db/client";
import { modules, moduleVersions, type StoredPreview } from "../db/schema";
import { createHubApp } from "../src/app";
import { PREVIEW_FORMAT } from "../src/module-check";
import { errorSummary, refreshStalePreviews } from "../src/publish";
import { loadSigner } from "../src/signing";
import { officialPublications } from "../scripts/seed-official";

// Recalcul au démarrage des aperçus d'un format ancien : seule la colonne d'aperçu change (et Q s'il manquait),
// le contenu publié (YAML, sha256, signature) jamais ; idempotent ; la fiche affiche la part de chaque filtre.

const TOKEN = "p".repeat(48);
let db: HubDb;
let close: () => Promise<void>;
let app: ReturnType<typeof createHubApp>;

beforeAll(async () => {
  ({ db, close } = await openPglite());
  const ed = generateKeyPairSync("ed25519");
  const signer = loadSigner((ed.privateKey.export({ format: "der", type: "pkcs8" }) as Buffer).toString("base64"))!;
  app = createHubApp({ db, adminToken: TOKEN, publicBaseUrl: "https://hub.example.org", signer });
  const pubs = officialPublications();
  const subset = [
    ...pubs.filter((p) => p.kind === "pack" && String(p.body.slug) === "fr" && p.body.extends === null),
    ...pubs.filter((p) => p.kind === "module" && String(p.body.yaml ?? "").includes("id: jeux-video\n")),
  ];
  for (const p of subset) {
    const r = await app.request(p.kind === "module" ? "/v1/admin/modules" : "/v1/admin/packs", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(p.body) });
    expect(r.status, p.label).toBe(201);
  }
}, 240_000);

afterAll(async () => {
  await close();
});

const row = async () => {
  const [m] = await db.select().from(modules).where(eq(modules.slug, "jeux-video"));
  const [v] = await db.select().from(moduleVersions).where(eq(moduleVersions.moduleId, m!.id));
  return v!;
};

describe("aperçu : format courant à la publication", () => {
  it("parts des filtres prêts à l'emploi stockées, avec le numéro de format", async () => {
    const v = await row();
    expect(v.preview?.previewFormat).toBe(PREVIEW_FORMAT);
    const helpers = v.preview?.eligibilityHelpers ?? [];
    expect(helpers.map((h) => h.name)).toContain("player");
    for (const h of helpers) {
      expect(h.rate).toBeGreaterThan(0);
      expect(h.rate).toBeLessThanOrEqual(1);
      expect(h.label.length).toBeGreaterThan(0);
    }
    // Rien à recalculer juste après une publication
    expect((await refreshStalePreviews(db)).stale).toBe(0);
  });
});

describe("refreshStalePreviews (démarrage du Hub)", () => {
  it("ancien aperçu → recalculé ; YAML, sha256, signature et Q inchangés ; second passage sans recalcul ; fiche avec les parts", async () => {
    const before = await row();
    const fresh = before.preview!;
    // Aperçu au format 1 (sans parts des filtres ni numéro de format) et Q volontairement différent du calcul
    const { previewFormat: _f, eligibilityHelpers: _h, ...old } = fresh;
    const oldQuality = { ...before.quality!, q: 12.3 };
    await db.update(moduleVersions).set({ preview: old as StoredPreview, quality: oldQuality }).where(eq(moduleVersions.id, before.id));
    const stalePage = await (await app.request("/m/personas/jeux-video?ui=fr")).text();
    expect(stalePage).not.toContain('class="use-share num"');

    const logs: Array<Record<string, unknown>> = [];
    const res = await refreshStalePreviews(db, { log: (l) => logs.push(l) });
    expect(res).toMatchObject({ refreshed: 1, failed: 0, stale: 1 });
    expect(logs.at(-1)).toMatchObject({ msg: "previews refreshed", refreshed: 1 });

    const after = await row();
    expect(after.yaml).toBe(before.yaml);
    expect(after.sha256).toBe(before.sha256);
    expect(after.signature).toBe(before.signature);
    expect(after.signature).not.toBeNull();
    expect(after.signatureKid).toBe(before.signatureKid);
    expect(after.publishedAt).toBe(before.publishedAt);
    expect(after.quality).toEqual(oldQuality);
    expect(after.preview).toEqual(fresh);

    // Idempotent : un second démarrage ne recalcule rien
    expect(await refreshStalePreviews(db)).toMatchObject({ refreshed: 0, stale: 0 });

    const html = await (await app.request("/m/personas/jeux-video?ui=fr")).text();
    const player = fresh.eligibilityHelpers!.find((h) => h.name === "player")!;
    expect(html).toMatch(new RegExp(`<span class="use-share num">${Math.round(player.rate * 100)}\\s%\\sdes personas</span>`));
    expect(html.match(/class="use-share num"/g)?.length).toBe(fresh.eligibilityHelpers!.length);
  }, 120_000);

  it("aperçu absent → recalculé, Q absent → rempli ; échec sur une version → journal, on continue", async () => {
    const before = await row();
    await db.update(moduleVersions).set({ preview: null, quality: null }).where(eq(moduleVersions.id, before.id));
    const res = await refreshStalePreviews(db);
    expect(res).toMatchObject({ refreshed: 1, failed: 0 });
    const after = await row();
    expect(after.preview?.previewFormat).toBe(PREVIEW_FORMAT);
    expect(after.quality?.q).toBeGreaterThan(0);
    expect(after.sha256).toBe(before.sha256);

    // Le contenu reste protégé par le déclencheur d'immutabilité
    await expect(db.update(moduleVersions).set({ yaml: `${before.yaml}\n` }).where(eq(moduleVersions.id, before.id))).rejects.toThrow();

    // Version illisible publiée avant (insérée directement) : échec journalisé, la suivante est recalculée
    const [casse] = await db.insert(modules).values({ namespace: "personas", slug: "casse", label: "Cassé" }).returning({ id: modules.id });
    await db.insert(moduleVersions).values({ moduleId: casse!.id, version: "1", yaml: "id: casse\nversion: \"1\"\n", sha256: "x", status: "verified", label: "Cassé", appliesTo: ["fr"], attributes: [], requires: [], searchTitle: "casse", searchBody: "", publishedAt: "2000-01-01T00:00:00.000Z" });
    await db.update(moduleVersions).set({ preview: null }).where(eq(moduleVersions.id, before.id));
    const logs: Array<Record<string, unknown>> = [];
    expect(await refreshStalePreviews(db, { log: (l) => logs.push(l) })).toMatchObject({ refreshed: 1, failed: 1, stale: 2 });
    expect(logs[0]).toMatchObject({ msg: "preview refresh failed", ref: "personas/casse", version: "1" });
    expect((await row()).preview?.previewFormat).toBe(PREVIEW_FORMAT);
  }, 120_000);
});

describe("refreshStalePreviews : refus déterministe et erreur transitoire", () => {
  // Ancienne version publiée avant le lint des attributs sensibles : le moteur courant la refuse
  const sensitiveVersion = async () => {
    const base = await row();
    const { previewFormat: _f, eligibilityHelpers: _h, ...old } = base.preview!;
    const yaml = base.yaml.replace("label: Fréquence de jeu vidéo\n", "label: Fréquence de jeu vidéo pendant le ramadan\n");
    expect(yaml).not.toBe(base.yaml);
    const [m] = await db.insert(modules).values({ namespace: "personas", slug: "ancien-sensible", label: "Ancien sensible" }).returning({ id: modules.id });
    await db.insert(moduleVersions).values({ moduleId: m!.id, version: "2026.1", yaml, sha256: "sha-ancien", status: "verified", label: "Ancien sensible", appliesTo: ["fr"], attributes: [], requires: [], searchTitle: "ancien", searchBody: "", publishedAt: "2001-01-01T00:00:00.000Z", preview: old as StoredPreview, quality: base.quality, signature: "sig-ancienne", signatureKid: "kid-ancien" });
    const get = async () => (await db.select().from(moduleVersions).where(eq(moduleVersions.moduleId, m!.id)))[0]!;
    return { old: old as StoredPreview, get };
  };

  it("échec au lint → marqué « skipped » avec la raison complète, ancien aperçu et contenu inchangés ; plus retenté", async () => {
    const { old, get } = await sensitiveVersion();
    const before = await get();
    const logs: Array<Record<string, unknown>> = [];
    const res = await refreshStalePreviews(db, { log: (l) => logs.push(l) });
    // personas/casse (sans aperçu, du test précédent) reste à retenter : rien à marquer
    expect(res).toMatchObject({ refreshed: 0, failed: 2, skipped: 1, stale: 2 });
    const line = logs.find((l) => l.ref === "personas/ancien-sensible")!;
    expect(line).toMatchObject({ msg: "preview refresh failed", kind: "deterministic", action: "skipped" });
    expect(String(line.error)).toMatch(/^Validation en échec, module refusé : - \S/);
    expect(String(line.error)).toContain("sensitive");
    expect(logs.find((l) => l.ref === "personas/casse")).toMatchObject({ action: "retry" });

    const after = await get();
    const { refresh, ...kept } = after.preview!;
    expect(kept).toEqual(old);
    expect(refresh).toMatchObject({ format: PREVIEW_FORMAT, status: "skipped" });
    expect(refresh!.reason).toMatch(/^Validation en échec, module refusé :\n- /);
    expect(refresh!.reason).toContain("sensitive_justification");
    expect(Number.isNaN(Date.parse(refresh!.at))).toBe(false);
    for (const k of ["yaml", "sha256", "signature", "signatureKid", "publishedAt", "quality", "status"] as const) expect(after[k]).toEqual(before[k]);

    // Second démarrage : la version marquée n'est plus à recalculer
    const logs2: Array<Record<string, unknown>> = [];
    expect(await refreshStalePreviews(db, { log: (l) => logs2.push(l) })).toMatchObject({ stale: 1, skipped: 0 });
    expect(logs2.some((l) => l.ref === "personas/ancien-sensible")).toBe(false);
    expect((await get()).preview).toEqual(after.preview);
  }, 120_000);

  it("erreur transitoire (base) → rien d'écrit, retentée au démarrage suivant", async () => {
    const v = await row();
    const { previewFormat: _f, eligibilityHelpers: _h, ...old } = v.preview!;
    await db.update(moduleVersions).set({ preview: old as StoredPreview }).where(eq(moduleVersions.id, v.id));
    // Base qui lit, mais dont les écritures échouent (connexion perdue)
    const flaky = new Proxy(db, {
      get: (target, prop, recv) =>
        prop === "update"
          ? () => {
              throw new Error("Connection terminated unexpectedly");
            }
          : Reflect.get(target, prop, recv),
    });
    const logs: Array<Record<string, unknown>> = [];
    const res = await refreshStalePreviews(flaky, { log: (l) => logs.push(l) });
    expect(res).toMatchObject({ refreshed: 0, skipped: 0 });
    expect(logs.find((l) => l.ref === "personas/jeux-video")).toMatchObject({ kind: "transient", action: "retry", error: "Connection terminated unexpectedly" });
    expect((await row()).preview).toEqual(old);

    // Démarrage suivant (base revenue) : recalculée
    const res2 = await refreshStalePreviews(db);
    expect(res2.refreshed).toBe(1);
    expect((await row()).preview?.previewFormat).toBe(PREVIEW_FORMAT);
    expect((await row()).preview?.refresh).toBeUndefined();
  }, 120_000);

  it("errorSummary : en-tête et premières erreurs sur une ligne, chacune tronquée", () => {
    expect(errorSummary(`T :\n- ${"x".repeat(500)}`).length).toBeLessThan(320);
    expect(errorSummary("Validation en échec, module refusé :\n- a : x\n- b : y")).toBe("Validation en échec, module refusé : - a : x - b : y");
    expect(errorSummary(["Titre :", ...Array.from({ length: 8 }, (_, i) => `- e${i}`)].join("\n"), 5)).toBe("Titre : - e0 - e1 - e2 - e3 - e4 (+ 3 autres)");
  });
});
