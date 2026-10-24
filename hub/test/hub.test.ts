import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  catalogModule,
  catalogResponse,
  hubError,
  moduleVersionResponse,
  packVersionResponse,
  publishResponse,
  rankedSearchResponse,
  searchResponse,
} from "../../src/hub/contract";
import { openPglite, type HubDb } from "../db/client";
import { createHubApp, tokenMatches } from "../src/app";
import { sha256 } from "../src/module-check";
import { packSha256 } from "../src/pack-check";
import { packSha256 as localPackSha256 } from "../../src/personas/pack-source";
import { uiFromAcceptLanguage } from "../src/i18n";
import { legalMarkdownToHtml } from "../src/pages";
import { RateLimiter } from "../src/rate-limit";
import { officialPublications, seed } from "../scripts/seed-official";

// Postgres embarqué (PGlite), aucun Docker ni serveur distant. Les publications rejouent l'aperçu
// sur 10 000 personas virtuelles : compter quelques secondes pour l'amorçage complet.

const ROOT = resolve(import.meta.dirname, "../..");
const TOKEN = "t".repeat(48);
let db: HubDb;
let close: () => Promise<void>;
let app: ReturnType<typeof createHubApp>;

const admin = (path: string, body: unknown, token: string | null = TOKEN) =>
  app.request(path, { method: "POST", headers: { "Content-Type": "application/json", ...(token !== null && { Authorization: `Bearer ${token}` }) }, body: JSON.stringify(body) });
const getJson = async (path: string, init?: RequestInit) => {
  const r = await app.request(path, init);
  return { status: r.status, headers: r.headers, json: (await r.json()) as unknown };
};
const moduleYaml = (id: string) => readFileSync(resolve(ROOT, "modules", id, "module.yaml"), "utf8");

beforeAll(async () => {
  ({ db, close } = await openPglite());
  app = createHubApp({ db, adminToken: TOKEN, publicBaseUrl: "https://hub.example.org" });
  await seed(
    async (path, body) => {
      const r = await admin(path, body);
      return { status: r.status, json: await r.json() };
    },
    () => {},
  );
}, 180_000);

afterAll(async () => {
  await close();
});

describe("contrat de lecture", () => {
  it("GET /v1/catalog suit le schéma du contrat et liste les modules et packs officiels", async () => {
    const r = await getJson("/v1/catalog");
    expect(r.status).toBe(200);
    const cat = catalogResponse.parse(r.json);
    const refs = cat.modules.map((m) => m.ref);
    expect(refs).toEqual(expect.arrayContaining(["personas/numerique", "personas/entrepreneuriat", "personas/barbecue-reception", "personas/productivite-reunions"]));
    // Module archivé (yanked) : absent de l'index, téléchargeable par sa référence exacte
    expect(refs).not.toContain("personas/entrepreneuriat-tech");
    const fr = cat.packs.find((p) => p.ref === "personas/fr")!;
    expect(fr.versions.map((v) => [v.version, v.extends])).toEqual([
      ["fr-2026.1", null],
      ["fr-2026.2", "fr-2026.1"],
    ]);
    expect(cat.packs.map((p) => p.ref).sort()).toEqual(["personas/fr", "personas/fr-tech-founders", "personas/sg", "personas/us"]);
    // Socle US : tables du générateur us seulement (le fichier de calage de build-tables.py n'est pas publié)
    const us = packVersionResponse.parse((await getJson("/v1/packs/personas/us/us-2026.1")).json);
    expect(us.extends).toBeNull();
    expect(Object.keys(us.files)).toContain("earnings.json");
    expect(Object.keys(us.files)).not.toContain("earnings-calibration.json");
    // Empreinte du Hub = empreinte locale (lock fait sur le pack du dépôt valable pour une machine qui le tire du Hub)
    for (const [ref, version] of [["personas/us", "us-2026.1"], ["personas/fr", "fr-2026.1"], ["personas/fr", "fr-2026.2"], ["personas/sg", "sg-2026.1"], ["personas/sg", "sg-2026.2"], ["personas/fr-tech-founders", "fr-tech-founders-2026.1"]] as const) {
      const v = packVersionResponse.parse((await getJson(`/v1/packs/${ref}/${version}`)).json);
      expect(v.sha256, `${ref}@${version}`).toBe(localPackSha256(version));
    }
  });

  it("GET /v1/modules/:ns/:slug et /:version renvoient le YAML exact et son empreinte", async () => {
    const card = catalogModule.parse((await getJson("/v1/modules/personas/entrepreneuriat")).json);
    expect(card.appliesTo).toEqual(["fr"]);
    const r = await getJson(`/v1/modules/personas/entrepreneuriat/${card.latest}`);
    const v = moduleVersionResponse.parse(r.json);
    const yaml = moduleYaml("entrepreneuriat");
    expect(v.yaml).toBe(yaml);
    expect(v.sha256).toBe(sha256(yaml));
    expect(v.requires).toEqual([{ ref: "personas/numerique", version: "2026.3", as: "numerique" }]);
    expect(v.license).toBe("CC-BY-4.0");
    expect(v.status).toBe("verified");
  });

  it("le module archivé reste téléchargeable avec le statut yanked", async () => {
    const v = moduleVersionResponse.parse((await getJson("/v1/modules/personas/entrepreneuriat-tech/2026.1")).json);
    expect(v.status).toBe("yanked");
    expect(v.yaml).toBe(readFileSync(resolve(ROOT, "modules/_archive/entrepreneuriat-tech/module.yaml"), "utf8"));
  });

  it("GET /v1/packs/:ns/:slug/:version : fichiers exacts, empreinte canonique, extends", async () => {
    const v = packVersionResponse.parse((await getJson("/v1/packs/personas/sg/sg-2026.2")).json);
    expect(v.extends).toBe("sg-2026.1");
    expect(Object.keys(v.files).sort()).toEqual(["first-names.json", "pack.json"]);
    expect(v.files["pack.json"]).toBe(readFileSync(resolve(ROOT, "packs/sg-2026.2/pack.json"), "utf8"));
    expect(v.sha256).toBe(packSha256(v.files));
    const fr = packVersionResponse.parse((await getJson("/v1/packs/personas/fr/fr-2026.1")).json);
    expect(Object.keys(fr.files)).toContain("age-sex.json");
    expect(Object.keys(fr.files)).not.toContain("README.md");
  });

  it("404 au format d'erreur du contrat", async () => {
    for (const path of ["/v1/modules/personas/inconnu", "/v1/modules/personas/numerique/1999.1", "/v1/packs/personas/fr/fr-1999.1", "/v1/nope"]) {
      const r = await getJson(path);
      expect(r.status, path).toBe(404);
      expect(hubError.parse(r.json).error.code).toBe("not_found");
    }
  });

  it("CORS ouvert en lecture", async () => {
    const r = await app.request("/v1/catalog", { headers: { Origin: "https://example.org" } });
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("ETag du catalogue", () => {
  it("304 sur If-None-Match, nouvel ETag après une publication", async () => {
    const first = await app.request("/v1/catalog");
    const etag = first.headers.get("etag")!;
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(first.headers.get("cache-control")).toContain("max-age");
    const again = await app.request("/v1/catalog", { headers: { "If-None-Match": etag } });
    expect(again.status).toBe(304);
    const weak = await app.request("/v1/catalog", { headers: { "If-None-Match": `W/${etag}` } });
    expect(weak.status).toBe(304);

    // Nouvelle version d'un module : l'index change
    const yaml = moduleYaml("numerique").replace(/^version: "2026\.3"$/m, 'version: "2099.1"');
    const pub = await admin("/v1/admin/modules", { namespace: "personas", yaml });
    expect(pub.status).toBe(201);
    const after = await app.request("/v1/catalog", { headers: { "If-None-Match": etag } });
    expect(after.status).toBe(200);
    expect(after.headers.get("etag")).not.toBe(etag);
    const cat = catalogResponse.parse(await after.json());
    const num = cat.modules.find((m) => m.ref === "personas/numerique")!;
    expect(num.latest).toBe("2099.1");
    expect(num.versions.map((v) => v.version)).toEqual(["2026.3", "2099.1"]);
  });
});

describe("publication d'administration", () => {
  it("401 sans jeton, 403 avec un mauvais jeton ou si l'administration est désactivée", async () => {
    const body = { namespace: "personas", yaml: moduleYaml("numerique") };
    const none = await admin("/v1/admin/modules", body, null);
    expect(none.status).toBe(401);
    expect(hubError.parse(await none.json()).error.code).toBe("unauthorized");
    expect((await admin("/v1/admin/modules", body, "faux")).status).toBe(403);
    expect((await admin("/v1/admin/packs", body, `${TOKEN}x`)).status).toBe(403);
    const disabled = createHubApp({ db });
    const r = await disabled.request("/v1/admin/modules", { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect(r.status).toBe(403);
  });

  it("comparaison du jeton en temps constant, sensible à la longueur", () => {
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(tokenMatches(TOKEN.slice(1), TOKEN)).toBe(false);
    expect(tokenMatches("", TOKEN)).toBe(false);
  });

  it("409 : une version publiée est immuable (même texte ou texte modifié)", async () => {
    const yaml = moduleYaml("barbecue-reception");
    const same = await admin("/v1/admin/modules", { namespace: "personas", yaml });
    expect(same.status).toBe(409);
    expect(hubError.parse(await same.json()).error.code).toBe("conflict");
    const changed = await admin("/v1/admin/modules", { namespace: "personas", yaml: yaml.replace(/^label: .*$/m, "label: Autre libellé") });
    expect(changed.status).toBe(409);
    const v = moduleVersionResponse.parse((await getJson("/v1/modules/personas/barbecue-reception/2026.3")).json);
    expect(v.yaml).toBe(yaml);
    const pack = officialPublications().find((p) => p.kind === "pack" && p.body.version === "sg-2026.2")!;
    expect((await admin("/v1/admin/packs", pack.body)).status).toBe(409);
  });

  it("la base refuse toute modification du contenu d'une version (déclencheur)", async () => {
    const cause = (p: Promise<unknown>) => p.then(() => "ok", (e: Error & { cause?: Error }) => `${e.message} ${e.cause?.message ?? ""}`);
    expect(await cause(db.execute(sql`update personas_hub.module_versions set yaml = 'x' where version = '2026.2'`))).toMatch(/immutable/);
    expect(await cause(db.execute(sql`update personas_hub.pack_versions set sha256 = 'x' where version = 'fr-2026.1'`))).toMatch(/immutable/);
    // Le statut, lui, peut évoluer (modération)
    await db.execute(sql`update personas_hub.module_versions set status = status where version = '2026.2'`);
  });

  it("422 : YAML illisible, schéma invalide, dépendance absente, taille", async () => {
    const cases: Array<[string, string]> = [
      ["illisible", "id: [oops"],
      ["schéma", 'id: vide\nversion: "1"\nlabel: Vide\napplies_to: [fr]\nattributes: []\n'],
      ["dépendance", moduleYaml("entrepreneuriat").replace("requires: [numerique]", "requires: [inexistant]").replace(/^version: .*$/m, 'version: "2099.9"')],
      ["taille", `# ${"x".repeat(257 * 1024)}\n${moduleYaml("numerique")}`],
    ];
    for (const [what, yaml] of cases) {
      const r = await admin("/v1/admin/modules", { namespace: "personas", yaml });
      expect(r.status, what).toBe(422);
      expect(hubError.parse(await r.json()).error.code, what).toBe("invalid");
    }
  });

  it("422 : alerte d'erreur de l'aperçu (porte d'entrée)", async () => {
    const yaml = [
      "id: sac-ordinateur",
      'version: "2026.1"',
      "label: Sac pour ordinateur portable",
      "applies_to: [fr]",
      "attributes:",
      "  - key: laptop_bag",
      "    label: Possède un sac pour ordinateur portable",
      "    type: boolean",
      "    rate: 0.5",
      "    assumption: true",
      "    justification: test",
      "",
    ].join("\n");
    const r = await admin("/v1/admin/modules", { namespace: "alice", yaml });
    expect(r.status).toBe(422);
    expect(hubError.parse(await r.json()).error.message).toMatch(/Aperçu en erreur/);
    // Corrigé (présence conditionnée à l'équipement) : publié, non vérifié hors namespace officiel
    const fixed = yaml.replace("    type: boolean", "    type: boolean\n    when: {attr: socle.has_computer, eq: true}");
    const ok = await admin("/v1/admin/modules", { namespace: "alice", yaml: fixed });
    expect(ok.status).toBe(201);
    const pub = publishResponse.parse(await ok.json());
    expect(pub.ref).toBe("alice/sac-ordinateur");
    expect(pub.sha256).toBe(sha256(fixed));
    const v = moduleVersionResponse.parse((await getJson("/v1/modules/alice/sac-ordinateur/2026.1")).json);
    expect(v.status).toBe("unverified");
    // Sans source ni validation : Q bas
    expect(v.quality!.sourcing).toBe(0);
    expect(v.quality!.margins).toBe(0);
    expect(v.quality!.q).toBeLessThan(40);
  });

  it("422 sur les packs : extends inconnu, version incohérente, fichier inconnu, module absent", async () => {
    const base = officialPublications().find((p) => p.kind === "pack" && p.body.version === "fr-2026.2")!.body as { namespace: string; slug: string; version: string; files: Record<string, string>; extends: string | null };
    const variants: Array<[string, typeof base]> = [
      ["extends", { ...base, version: "fr-2099.1", files: { "pack.json": base.files["pack.json"]!.replace('"fr-2026.2"', '"fr-2099.1"') }, extends: "fr-1999.1" }],
      ["version", { ...base, version: "fr-2099.2" }],
      ["fichier", { ...base, version: "fr-2099.3", files: { ...base.files, "pack.json": base.files["pack.json"]!.replace('"fr-2026.2"', '"fr-2099.3"'), "evil.json": "{}" } }],
      ["module", { ...base, version: "fr-2099.4", files: { "pack.json": base.files["pack.json"]!.replace('"fr-2026.2"', '"fr-2099.4"').replace('"rngStreams"', '"modules": ["fantome"],\n "rngStreams"') } }],
    ];
    for (const [what, body] of variants) {
      const r = await admin("/v1/admin/packs", body);
      expect(r.status, what).toBe(422);
      expect(hubError.parse(await r.json()).error.code, what).toBe("invalid");
    }
  });
});

describe("score de qualité Q (formule q1)", () => {
  it("valeurs plausibles et décomposées pour deux modules réels", async () => {
    for (const id of ["numerique", "barbecue-reception"]) {
      const card = catalogModule.parse((await getJson(`/v1/modules/personas/${id}`)).json);
      const q = card.versions[0]!.quality!;
      expect(q.formula).toBe("q1");
      for (const k of ["sourcing", "margins", "alerts", "docs"] as const) {
        expect(q[k]).toBeGreaterThanOrEqual(0);
        expect(q[k]).toBeLessThanOrEqual(1);
      }
      const recomputed = 100 * (0.35 * q.sourcing + 0.3 * q.margins + 0.2 * q.alerts + 0.15 * q.docs);
      expect(Math.abs(recomputed - q.q)).toBeLessThan(0.2);
      expect(q.q).toBeGreaterThan(40);
      expect(q.q).toBeLessThan(95);
      expect(q.docs).toBe(1); // description, changelog, card et segments renseignés
    }
  });

  it("Q nul pour le module archivé dont l'aperçu ne tourne plus sur le socle courant", async () => {
    const v = moduleVersionResponse.parse((await getJson("/v1/modules/personas/entrepreneuriat-tech/2026.1")).json);
    expect(v.quality).toBeNull();
  });
});

describe("recherche plein texte", () => {
  it("français et anglais, contrat respecté", async () => {
    const fr = searchResponse.parse((await getJson(`/v1/search?q=${encodeURIComponent("réunions visio")}`)).json);
    expect(fr.results[0]?.ref).toBe("personas/productivite-reunions");
    const en = searchResponse.parse((await getJson("/v1/search?q=barbecue")).json);
    expect(en.results.map((r) => r.ref)).toContain("personas/barbecue-reception");
    expect(en.results.every((r) => r.score > 0)).toBe(true);
  });

  it("filtre de socle, tri par Q, module retiré exclu", async () => {
    const sg = searchResponse.parse((await getJson("/v1/search?socle=sg")).json);
    expect(sg.results.length).toBeGreaterThanOrEqual(3);
    expect(sg.results.every((r) => r.appliesTo.includes("sg"))).toBe(true);
    const all = searchResponse.parse((await getJson("/v1/search?limit=100")).json);
    const qs = all.results.map((r) => r.q ?? -1);
    expect(qs).toEqual([...qs].sort((a, b) => b - a));
    expect(all.results.map((r) => r.ref)).not.toContain("personas/entrepreneuriat-tech");
    expect((await getJson("/v1/search?limit=1000")).status).toBe(422);
  });
});

describe("filtre de langue de l'API (ajout additif au contrat)", () => {
  it("catalogue : langue des modules dérivée des manifestes de packs, générateur des packs", async () => {
    const cat = catalogResponse.parse((await getJson("/v1/catalog")).json);
    const byRef = new Map(cat.modules.map((m) => [m.ref, m]));
    expect(byRef.get("personas/numerique")?.locale).toBe("fr");
    expect(byRef.get("personas/barbecue-reception")?.locale).toBe("en");
    expect(cat.packs.find((p) => p.ref === "personas/sg")).toMatchObject({ locale: "en", generator: "sg" });
    expect(cat.packs.find((p) => p.ref === "personas/fr-tech-founders")).toMatchObject({ locale: "fr", generator: "fr" });
    // Les champs ajoutés restent facultatifs : une carte sans `locale` est toujours valide
    const { locale: _l, ...old } = byRef.get("personas/numerique")!;
    expect(catalogModule.safeParse(old).success).toBe(true);
  });

  it("GET /v1/search?lang= filtre par langue du contenu, combinable avec q et socle", async () => {
    const en = searchResponse.parse((await getJson("/v1/search?lang=en&limit=100")).json);
    expect(en.results.length).toBeGreaterThanOrEqual(3);
    expect(en.results.every((r) => r.locale === "en")).toBe(true);
    expect(en.results.map((r) => r.ref)).toContain("personas/barbecue-reception");
    const fr = searchResponse.parse((await getJson("/v1/search?lang=fr&limit=100")).json);
    expect(fr.results.map((r) => r.ref)).toContain("personas/numerique");
    expect(fr.results.every((r) => r.locale === "fr")).toBe(true);
    expect(en.results.length + fr.results.length).toBe(searchResponse.parse((await getJson("/v1/search?limit=100")).json).results.length);
    const both = searchResponse.parse((await getJson("/v1/search?q=barbecue&lang=en&socle=sg")).json);
    expect(both.results.map((r) => r.ref)).toContain("personas/barbecue-reception");
    expect(searchResponse.parse((await getJson("/v1/search?q=barbecue&lang=fr")).json).results).toEqual([]);
    expect(searchResponse.parse((await getJson("/v1/search?lang=de")).json).results).toEqual([]);
    expect((await getJson("/v1/search?lang=FR1")).status).toBe(422);
  });
});

describe("mise en avant de la langue (prefer=, ajout additif)", () => {
  // Langue du contenu, dérivée du manifeste du socle (sg, us : anglais) : indépendant de la liste de modules
  const isEn = (r: { locale?: string }) => r.locale === "en";
  /** Vrai si tous les modules de la langue voulue précèdent les autres. */
  const grouped = (rs: Array<{ locale?: string }>, first: (r: { locale?: string }) => boolean) => {
    const i = rs.findIndex((r) => !first(r));
    return i === -1 || rs.slice(i).every((r) => !first(r));
  };

  it("/v1/search?prefer= : même ensemble, langue demandée d'abord, ordre R ou Q conservé dans chaque groupe", async () => {
    for (const sort of ["r", "q"] as const) {
      const base = rankedSearchResponse.parse((await getJson(`/v1/search?limit=100&sort=${sort}`)).json);
      expect(base.prefer).toBeUndefined();
      expect(grouped(base.results, isEn)).toBe(false); // l'ordre par défaut mélange les langues
      for (const prefer of ["en", "fr"] as const) {
        const want = prefer === "en" ? isEn : (r: { locale?: string }) => !isEn(r);
        const p = rankedSearchResponse.parse((await getJson(`/v1/search?limit=100&sort=${sort}&prefer=${prefer}`)).json);
        expect(p.prefer).toBe(prefer);
        expect(p.results.map((r) => r.ref).sort()).toEqual(base.results.map((r) => r.ref).sort());
        expect(grouped(p.results, want)).toBe(true);
        const sub = (rs: typeof base.results, keep: boolean) => rs.filter((r) => want(r) === keep).map((r) => r.ref);
        expect(sub(p.results, true)).toEqual(sub(base.results, true));
        expect(sub(p.results, false)).toEqual(sub(base.results, false));
      }
    }
    // Mise en avant avant la troncature : avec limit, on obtient les meilleurs modules de la langue voulue
    const top = rankedSearchResponse.parse((await getJson("/v1/search?limit=2&prefer=en")).json);
    expect(top.results.every(isEn)).toBe(true);
    // Le filtre explicite garde la priorité : prefer ne réintroduit rien
    const frOnly = rankedSearchResponse.parse((await getJson("/v1/search?lang=fr&prefer=en&limit=100")).json);
    expect(frOnly.results.every((r) => r.locale === "fr")).toBe(true);
    expect((await getJson("/v1/search?prefer=de")).status).toBe(422);
  });

  it("/v1/catalog?prefer= : mêmes cartes, langue demandée d'abord, ETag propre ; sans prefer, inchangé", async () => {
    const base = await getJson("/v1/catalog");
    const cat = catalogResponse.parse(base.json);
    expect(grouped(cat.modules, isEn)).toBe(false);
    const en = await getJson("/v1/catalog?prefer=en");
    const enCat = catalogResponse.parse(en.json);
    expect(grouped(enCat.modules, isEn)).toBe(true);
    expect(enCat.modules.map((m) => m.ref).sort()).toEqual(cat.modules.map((m) => m.ref).sort());
    expect(enCat.modules.filter(isEn).map((m) => m.ref)).toEqual(cat.modules.filter(isEn).map((m) => m.ref));
    expect(enCat.packs).toEqual(cat.packs);
    expect(en.headers.get("etag")).not.toBe(base.headers.get("etag"));
    expect((await app.request("/v1/catalog?prefer=en", { headers: { "If-None-Match": en.headers.get("etag")! } })).status).toBe(304);
    expect(grouped(catalogResponse.parse((await getJson("/v1/catalog?prefer=fr")).json).modules, (m) => !isEn(m))).toBe(true);
    expect((await getJson("/v1/catalog?prefer=xx")).status).toBe(422);
  });

  it("pages : langue de l'interface d'abord, rien n'est filtré, compteurs inchangés ; ?lang= garde la priorité", async () => {
    const html = async (path: string) => (await app.request(path)).text();
    const refsOf = (h: string) => [...h.matchAll(/<li class="mcard">\s*<div><h3><a href="\/m\/([^"]+)"/g)].map((m) => m[1]!);
    const countOf = (h: string) => /<p class="result-line" role="status"><b>([^<]+)<\/b>/.exec(h)![1];
    const chipsOf = (h: string) => h.slice(h.indexOf('class="filters"'), h.indexOf('class="result-line"'));
    const cat = catalogResponse.parse((await getJson("/v1/catalog")).json);
    const enRefs = new Set(cat.modules.filter(isEn).map((m) => m.ref));
    const en = await html("/?ui=en");
    const fr = await html("/?ui=fr");
    const enList = refsOf(en);
    const frList = refsOf(fr);
    expect(enList.length).toBe(cat.modules.length);
    expect([...enList].sort()).toEqual([...frList].sort());
    const firstOther = (list: string[], mine: (r: string) => boolean) => list.findIndex((r) => !mine(r));
    expect(enList.slice(0, firstOther(enList, (r) => enRefs.has(r))).length).toBe(enRefs.size);
    expect(frList.slice(0, firstOther(frList, (r) => !enRefs.has(r))).length).toBe(cat.modules.length - enRefs.size);
    expect(en).toContain("English modules first");
    expect(fr).toContain("modules en français d&#39;abord");
    // Compteurs et chips identiques d'une langue d'interface à l'autre (seul l'ordre change)
    expect(countOf(en)).toMatch(/\d+/);
    expect(chipsOf(en).match(/<span class="n">\d+<\/span>/g)).toEqual(chipsOf(fr).match(/<span class="n">\d+<\/span>/g));
    // Tri Q : chaque groupe reste trié par Q
    const enQ = refsOf(await html("/?ui=en&sort=q"));
    expect(enQ.slice(0, enRefs.size).every((r) => enRefs.has(r))).toBe(true);
    // Packs : socle anglais d'abord en anglais, français d'abord en français
    const packRefs = (h: string) => [...h.slice(h.indexOf('id="packs"')).matchAll(/<p class="ref mono">(personas\/[a-z0-9-]+)@/g)].map((m) => m[1]!);
    expect(packRefs(en)[0]).toBe("personas/sg");
    expect(packRefs(fr)[0]).not.toBe("personas/sg");
    // Filtre explicite : seule la langue demandée, sans mention de mise en avant
    const frOnly = await html("/?ui=en&lang=fr");
    expect(refsOf(frOnly).some((r) => enRefs.has(r))).toBe(false);
    expect(frOnly).not.toContain("English modules first");
  });
});

describe("pages publiques", () => {
  const page = async (path: string, headers: Record<string, string> = {}) => {
    const r = await app.request(path, { headers });
    return { r, html: await r.text() };
  };

  it("/ liste les modules et recherche, sans injection HTML, sans script ni style en ligne", async () => {
    const { r, html } = await page("/", { "Accept-Language": "en-US,en;q=0.9" });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("Métiers du numérique");
    expect(html).toMatch(/<link rel="stylesheet" href="\/assets\/hub\.css\?v=[0-9a-f]{16}">/);
    expect(html).not.toMatch(/<script|style=|<style/);
    const csp = r.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
    const s = (await page(`/?q=${encodeURIComponent("<script>alert(1)</script>")}`)).html;
    expect(s).not.toContain("<script>alert(1)</script>");
    expect(s).toContain("&lt;script&gt;");
  });

  it("feuille de style (jetons du tableau de bord), polices et icône servies par le Hub", async () => {
    const html = (await page("/")).html;
    const href = /href="(\/assets\/hub\.css\?v=[0-9a-f]+)"/.exec(html)![1]!;
    const css = await app.request(href);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(css.headers.get("cache-control")).toContain("immutable");
    const text = await css.text();
    const tokens = readFileSync(resolve(ROOT, "web/src/tokens.css"), "utf8");
    expect(text).toContain(tokens);
    for (const s of ["--g-target", "prefers-color-scheme: dark", "Bricolage Grotesque Variable", ".w-50{width:50%}", ".mcard"]) expect(text).toContain(s);
    const font = await app.request("/assets/fonts/public-sans-latin-wght-normal.woff2");
    expect(font.status).toBe(200);
    expect(font.headers.get("content-type")).toBe("font/woff2");
    expect((await app.request("/assets/favicon.svg")).headers.get("content-type")).toBe("image/svg+xml");
    expect((await app.request("/assets/../package.json")).status).toBe(404);
    expect((await app.request("/assets/fonts/inconnue.woff2")).status).toBe(404);
  });

  it("langue de l'interface : Accept-Language, puis ?ui= mémorisé par cookie ; le contenu ne change pas", async () => {
    const fr = await page("/", { "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8" });
    expect(fr.html).toContain('<html lang="fr">');
    expect(fr.html).toContain("Rechercher");
    expect(fr.html).toContain("Barbecue and hosting at home");
    expect(fr.r.headers.get("vary")).toContain("Accept-Language");
    expect(fr.r.headers.get("content-language")).toBe("fr");
    const en = await page("/?ui=en", { "Accept-Language": "fr" });
    expect(en.html).toContain('<html lang="en">');
    expect(en.html).toContain("Search");
    expect(en.html).toContain("Métiers du numérique");
    const cookie = en.r.headers.get("set-cookie")!;
    expect(cookie).toMatch(/hub_ui=en/);
    expect(cookie).toMatch(/HttpOnly/i);
    const again = await page("/m/personas/numerique", { "Accept-Language": "fr", Cookie: "hub_ui=en" });
    expect(again.html).toContain('<html lang="en">');
    expect(again.html).toContain("Quality score");
    // Sélecteur : liens vers la même page dans l'autre langue, filtres conservés
    const sw = (await page("/?lang=fr&socle=fr", { Cookie: "hub_ui=fr" })).html;
    expect(sw).toContain('href="/?lang=fr&amp;socle=fr&amp;ui=en"');
    expect(sw).toMatch(/hreflang="fr" lang="fr" aria-current="true">FR/);
    expect((await page("/?ui=de", { "Accept-Language": "de-DE" })).html).toContain('<html lang="en">');
  });

  it("filtres de langue et de socle : chips accessibles, état dans l'URL, combinables avec la recherche", async () => {
    const all = (await page("/?ui=en")).html;
    expect(all).toMatch(/<a class="chip" href="\/" aria-current="true">All <span class="n">\d+<\/span>/);
    expect(all).toContain('href="/?lang=fr" lang="fr" hreflang="fr">Français');
    expect(all).toContain('href="/?lang=en" lang="en" hreflang="en">English');

    const en = (await page("/?lang=en&ui=en")).html;
    expect(en).toContain('href="/m/personas/barbecue-reception"');
    expect(en).not.toContain('href="/m/personas/numerique"');
    expect(en).toMatch(/href="\/\?lang=en" aria-current="true"[^>]*>English/);
    // Packs filtrés eux aussi : seul le socle anglais (sg)
    const packs = en.slice(en.indexOf('id="packs"'));
    expect(packs).toContain("personas/sg@");
    expect(packs).not.toContain("personas/fr@");

    const fr = (await page("/?lang=fr&ui=fr")).html;
    expect(fr).toContain('href="/m/personas/numerique"');
    expect(fr).not.toContain('href="/m/personas/barbecue-reception"');
    expect(fr.slice(fr.indexOf('id="packs"'))).toContain("personas/fr-tech-founders@");

    const sg = (await page("/?socle=sg&ui=en")).html;
    expect(sg).toContain('href="/m/personas/barbecue-reception"');
    expect(sg).not.toContain('href="/m/personas/entrepreneuriat"');
    expect(sg).toContain('<input type="hidden" name="socle" value="sg">');

    const none = (await page("/?q=barbecue&lang=fr&ui=en")).html;
    expect(none).toContain("No module matches “barbecue” with these filters.");
    expect(none).toContain('href="/?q=barbecue&amp;lang=en"');
    expect(none).not.toContain('class="empty"');
    // Valeurs invalides ignorées
    expect((await page("/?lang=%3Cx%3E&socle=..%2F")).r.status).toBe(200);
  });

  it("recherche sans résultat : état vide (pastille, titre, description échappée, lien Effacer les filtres) en FR et EN", async () => {
    const block = (html: string) => {
      const m = html.match(/<div class="empty-state">[\s\S]*?<\/p>(?:<p class="empty-state-desc">[\s\S]*?<\/p>)?(?:<div class="empty-state-action">[\s\S]*?<\/div>)?<\/div>/);
      expect(m, "état vide absent").not.toBeNull();
      return m![0];
    };
    const en = block((await page("/?q=zzzz%3Cb%3E&ui=en")).html);
    expect(en).toMatch(/<span class="empty-state-icon"><svg [^>]*aria-hidden="true"/);
    expect(en).toContain('<p class="empty-state-title">No results</p>');
    expect(en).toContain('<p class="empty-state-desc">No module matches “zzzz&lt;b&gt;” with these filters.</p>');
    expect(en).toContain('<div class="empty-state-action"><a class="btn ghost" href="/">Clear filters</a></div>');
    expect(en).not.toContain("<b>");
    const fr = block((await page("/?q=zzzz&ui=fr")).html);
    expect(fr).toContain('<p class="empty-state-title">Aucun résultat</p>');
    expect(fr).toContain('<p class="empty-state-desc">Aucun module ne correspond à « zzzz » avec ces filtres.</p>');
    expect(fr).toContain('<a class="btn ghost" href="/">Effacer les filtres</a>');
  });

  it("structure : landmarks (pied de page hors de main), h2 de la liste, filtres en groupes, rail courant", async () => {
    const fr = (await page("/?ui=fr")).html;
    // Pied de page : landmark contentinfo, frère de main
    expect(fr).toMatch(/<\/main>\s*<footer class="page-foot">/);
    expect(fr.slice(fr.indexOf("<main"), fr.indexOf("</main>"))).not.toContain("<footer");
    expect(fr).toContain("API\u00a0: <a href=\"/v1/catalog\">");
    // Titres : h1, puis un h2 avant les h3 des cartes
    const h1 = fr.indexOf("<h1>"), h2 = fr.indexOf('<h2 class="sr-only">Modules</h2>'), h3 = fr.indexOf("<h3>");
    expect(h1).toBeGreaterThan(-1);
    expect(h2).toBeGreaterThan(h1);
    expect(h3).toBeGreaterThan(h2);
    // Seules nav : rail et sélecteur de langue ; filtres en groupes étiquetés
    expect([...fr.matchAll(/<nav class="([^"]+)"/g)].map((m) => m[1])).toEqual(["main-nav", "ui-switch"]);
    expect(fr).toContain('<div class="fgroup" role="group" aria-labelledby="f-lang">');
    // Rail : « Modules » courant par défaut, « Socles pays » avec ?view=packs
    expect(fr).toMatch(/<a href="\/" aria-current="page">Modules<\/a><a href="\/\?view=packs#packs">Socles pays<\/a>/);
    const packs = (await page("/?view=packs&ui=fr")).html;
    expect(packs).toMatch(/<a href="\/">Modules<\/a><a href="\/\?view=packs#packs" aria-current="page">Socles pays<\/a>/);
    expect(packs).toContain('id="packs"');
    const en = (await page("/?ui=en")).html;
    expect(en).toContain('API: <a href="/v1/catalog">');
  });

  it("/m/:ns/:slug : fiche, Q décomposé en barres, marges, versions, commande d'installation", async () => {
    const { r, html } = await page("/m/personas/barbecue-reception?ui=en");
    expect(r.status).toBe(200);
    for (const s of [
      "Barbecue and hosting at home",
      "Quality score",
      "Sourcing",
      "Main margins",
      "2026.3",
      "Base sg · Singapore",
      ">English<",
      "personas hub pull personas/barbecue-reception@2026.3",
      'class="status verified"',
      "Licence CC-BY-4.0",
      'rel="canonical" href="https://hub.example.org/m/personas/barbecue-reception"',
    ])
      expect(html).toContain(s);
    expect(html).toMatch(/<span class="t" aria-hidden="true"><i class="w-\d+"><\/i><\/span>/);
    expect(html).not.toMatch(/<script|style=/);
    const frPage = (await page("/m/personas/barbecue-reception?ui=fr")).html;
    expect(frPage).toContain("Score de qualité");
    expect(frPage).toContain("Sourçage");
    expect(frPage).toContain('<nav class="crumbs" aria-label="Fil d&#39;Ariane">');
    expect(html).toContain('<nav class="crumbs" aria-label="Breadcrumb">');
    expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  it("404 : page propre dans la langue de l'interface, JSON sous /v1", async () => {
    const m = await page("/m/personas/inconnu", { "Accept-Language": "fr" });
    expect(m.r.status).toBe(404);
    expect(m.html).toContain("Page introuvable");
    expect(m.html).toContain('href="/"');
    const other = await page("/nulle/part?ui=en");
    expect(other.r.status).toBe(404);
    expect(other.html).toContain("Page not found");
    expect((await getJson("/v1/nulle-part")).json).toMatchObject({ error: { code: "not_found" } });
  });

  it("/device sans Supabase configuré : page propre, sans script, CSP inchangée", async () => {
    const { r, html } = await page("/device?ui=en");
    expect(r.status).toBe(200);
    expect(html).toContain("Browser sign-in is not configured on this Hub.");
    expect(html).not.toMatch(/<script/);
    expect(r.headers.get("content-security-policy")).not.toContain("script-src");
  });

  it("/terms et /privacy rendus (markdown échappé), 200 en français et en anglais", async () => {
    for (const [path, s] of [
      ["/terms?ui=fr", "Conditions d&#39;utilisation"],
      ["/terms?ui=en", "Terms"],
      ["/privacy?ui=fr", "Confidentialité"],
      ["/privacy?ui=en", "privacy policy"],
    ] as const) {
      const { r, html } = await page(path);
      expect(r.status, path).toBe(200);
      expect(html).toContain(s);
      expect(html).not.toMatch(/<script|style=/);
    }
    expect(legalMarkdownToHtml("# T\n\n- **a** <b>x</b> [l](javascript:alert(1))\n")).toBe("<h2>T</h2>\n<ul><li><strong>a</strong> &lt;b&gt;x&lt;/b&gt; [l](javascript:alert(1))</li></ul>");
    // Hiérarchie : le h1 est le titre de la page ; ## → h2, ### → h3 (pas d'aplatissement en h3)
    expect(legalMarkdownToHtml("## Comptes\n\ntexte\n\n### Détail\n")).toBe("<h2>Comptes</h2>\n<p>texte</p>\n<h3>Détail</h3>");
    // Liens : /chemin, https:// et mailto: seulement ; //hote (relatif au protocole) refusé
    expect(legalMarkdownToHtml("[a](/terms) [b](https://x.org) [c](mailto:contact@example.org)")).toBe('<p><a href="/terms">a</a> <a href="https://x.org">b</a> <a href="mailto:contact@example.org">c</a></p>');
    expect(legalMarkdownToHtml("[x](//evil.example/p)")).toBe("<p>[x](//evil.example/p)</p>");
    expect(legalMarkdownToHtml("[x](http://evil.example)")).not.toContain("<a ");
    const terms = await page("/terms?ui=fr");
    expect(terms.html).toMatch(/<h2>Comptes<\/h2>/);
    // Fil d'Ariane traduit : Accueil › document
    expect(terms.html).toContain('<nav class="crumbs" aria-label="Fil d&#39;Ariane" lang="fr"><a href="/">Accueil</a>');
    expect((await page("/privacy?ui=en")).html).toContain('<nav class="crumbs" aria-label="Breadcrumb" lang="en"><a href="/">Home</a>');
    expect(terms.html).not.toMatch(/<h3>Comptes<\/h3>/);
  });

  it("erreur interne : page HTML traduite hors /v1/, JSON stable sous /v1/", async () => {
    // Base injoignable : toute requête SQL échoue, sur les pages comme sur l'API.
    const broken = new Proxy({} as typeof db, {
      get: () => {
        throw new Error("panne simulée");
      },
    });
    const boom = createHubApp({ db: broken, publicBaseUrl: "https://hub.example.org" });
    {
      const fr = await boom.request("/?ui=fr");
      expect(fr.status).toBe(500);
      expect(fr.headers.get("content-type")).toContain("text/html");
      const html = await fr.text();
      expect(html).toContain('<html lang="fr"');
      expect(html).toContain("<h1>Erreur interne</h1>");
      expect(html).not.toContain("panne simulée");
      const en = await boom.request("/?ui=en");
      expect(await en.text()).toContain("<h1>Internal error</h1>");
      const api = await boom.request("/v1/catalog");
      expect(api.status).toBe(500);
      expect(await api.json()).toEqual({ error: { code: "internal", message: "Erreur interne." } });
    }
  });

  it("Accept-Language : poids q respectés, anglais par défaut", () => {
    expect(uiFromAcceptLanguage(undefined)).toBe("en");
    expect(uiFromAcceptLanguage("fr-CA")).toBe("fr");
    expect(uiFromAcceptLanguage("de-DE,fr;q=0.5,en;q=0.7")).toBe("en");
    expect(uiFromAcceptLanguage("en;q=0,fr;q=0.2")).toBe("fr");
    expect(uiFromAcceptLanguage("es, de")).toBe("en");
  });
});

describe("limitation de débit", () => {
  it("429 au-delà du quota de lecture", async () => {
    const limited = createHubApp({ db, rateLimit: { readPerMinute: 2, adminPerMinute: 1 } });
    expect((await limited.request("/v1/search")).status).toBe(200);
    expect((await limited.request("/v1/search")).status).toBe(200);
    const r = await limited.request("/v1/search");
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBeTruthy();
    expect(hubError.parse(await r.json()).error.code).toBe("rate_limited");
  });

  it("fenêtre fixe par clé", () => {
    let t = 0;
    const l = new RateLimiter(1, 1000, () => t);
    expect(l.take("a").ok).toBe(true);
    expect(l.take("a").ok).toBe(false);
    expect(l.take("b").ok).toBe(true);
    t = 1000;
    expect(l.take("a").ok).toBe(true);
  });
});
