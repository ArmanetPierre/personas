import { generateKeyPairSync } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openPglite, type HubDb } from "../db/client";
import { modules, moduleVersions, type StoredPreview } from "../db/schema";
import { createHubApp } from "../src/app";
import { PREVIEW_FORMAT } from "../src/module-check";
import { refreshStalePreviews } from "../src/publish";
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
