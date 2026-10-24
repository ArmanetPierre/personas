import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openPglite, type HubDb } from "../db/client";
import { createHubApp } from "../src/app";
import { eligibilityText, firstSentence, headerNotes, parseModuleYaml, provenanceOf, splitShareLabel } from "../src/module-view";
import { officialPublications } from "../scripts/seed-official";

// Fiche module du Hub (/m/:ns/:slug) : résumé, chiffres clés tirés des données, usage (filtres, segments),
// attributs lisibles, sources et hypothèses, installation, replis en bas. Sans JavaScript ni style en ligne.

const TOKEN = "m".repeat(48);
let db: HubDb;
let close: () => Promise<void>;
let app: ReturnType<typeof createHubApp>;

const MODULES = ["jeux-video", "barbecue-reception"];

beforeAll(async () => {
  ({ db, close } = await openPglite());
  app = createHubApp({ db, adminToken: TOKEN, publicBaseUrl: "https://hub.example.org" });
  const pubs = officialPublications();
  const subset = [
    ...pubs.filter((p) => p.kind === "pack" && ["fr", "sg"].includes(String(p.body.slug)) && p.body.extends === null),
    ...pubs.filter((p) => p.kind === "module" && MODULES.some((m) => String(p.body.yaml ?? "").includes(`id: ${m}\n`))),
  ];
  for (const p of subset) {
    const r = await app.request(p.kind === "module" ? "/v1/admin/modules" : "/v1/admin/packs", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(p.body) });
    expect(r.status, p.label).toBe(201);
  }
}, 240_000);

afterAll(async () => {
  await close();
});

const page = async (path: string) => {
  const r = await app.request(path);
  return { r, html: await r.text() };
};
const visible = (html: string) => html.slice(0, html.indexOf('<section class="section folds"'));

describe("module-view : lecture du YAML publié", () => {
  it("première phrase, notes d'en-tête, libellé de part, provenance", () => {
    expect(firstSentence("Pratique du jeu (console, PC). Module générique. Fin.")).toBe("Pratique du jeu (console, PC).");
    expect(firstSentence("Une seule phrase sans point")).toBe("Une seule phrase sans point");
    expect(headerNotes("# Note 1\n#  Note 2\n\nid: x\n# pas une note")).toEqual(["Note 1", "Note 2"]);
    expect(splitShareLabel("Joueurs parmi les adultes (SELL : 70 %)")).toEqual({ title: "Joueurs parmi les adultes", note: "SELL : 70 %" });
    expect(provenanceOf({ sources: ["a"], assumption: false })).toBe("sourced");
    expect(provenanceOf({ sources: ["a"], assumption: true })).toBe("modeled");
    expect(provenanceOf({ sources: [], assumption: true })).toBe("assumption");
    expect(provenanceOf({ sources: [], assumption: false })).toBe("none");
  });

  it("filtre d'éligibilité en clair : libellés d'attributs et de valeurs, opérateurs en mots", () => {
    const yaml = `id: demo
version: "1"
label: Démo
applies_to: [fr]
attributes:
  - key: freq
    label: Fréquence de jeu
    type: enum
    assumption: true
    values: [{code: jamais, label: ne joue pas}, {code: quotidien, label: tous les jours}]
    distribution: {weights: {jamais: 1, quotidien: 1}}
`;
    const def = parseModuleYaml(yaml)!;
    expect(def).not.toBeNull();
    expect(eligibilityText("demo.freq != jamais", def, "fr")).toBe("Fréquence de jeu ≠ ne joue pas");
    expect(eligibilityText("age < 35 and demo.freq in [jamais, quotidien]", def, "fr")).toBe("Âge < 35 et Fréquence de jeu : ne joue pas ou tous les jours");
    expect(eligibilityText("age < 35 and demo.freq in [jamais, quotidien]", def, "en")).toBe("Age < 35 and Fréquence de jeu: ne joue pas or tous les jours");
    expect(parseModuleYaml("pas: [du yaml de module")).toBeNull();
  });
});

describe("/m/:ns/:slug : fiche module", () => {
  it("en haut : titre, résumé d'une phrase, pastilles, chiffres clés réels ; description complète repliée", async () => {
    const { r, html } = await page("/m/personas/jeux-video?ui=fr");
    expect(r.status).toBe(200);
    const head = html.slice(html.indexOf('<header class="mh">'), html.indexOf('<section class="mh-kf"'));
    expect(head).toContain('<p class="mh-summary" lang="fr">Pratique du jeu vidéo en France (console, PC, mobile, cloud) : fréquence et temps de jeu, supports, genres, mode de jeu principal, dépenses, abonnements de jeu et canaux d&#39;achat.</p>');
    expect(head).not.toContain("Module générique");
    for (const s of ["Socle fr · France", ">Français<", 'class="badge b-official"', "Version <span class=\"mono\">2026.2</span>"]) expect(head).toContain(s);
    // Chiffres clés : Q et ses 4 barres, 12 attributs et leur provenance, filtres, parts sourcées avec libellé
    const kf = html.slice(html.indexOf('<section class="mh-kf"'), html.indexOf('<section class="install-box"'));
    expect(kf).toMatch(/<span class="kf-big num">\d+<small>\/100<\/small><\/span><dl class="qbars"/);
    expect(kf.match(/<dt>(Sourçage|Marges|Alertes|Doc)<\/dt>/g)).toHaveLength(4);
    expect(kf).toContain('<span class="kf-big num">12</span>');
    expect(kf).toContain("11 modélisés d&#39;après des sources · 1 hypothèse sans source");
    expect(kf).toContain('<i class="modeled w-92"></i><i class="assumption w-8"></i>');
    expect(kf).toContain('<span class="kf-big num">10</span>');
    expect(kf).toContain("filtres prêts à l&#39;emploi · 4 segments d&#39;analyse");
    expect(kf).toContain('<b class="num">58–72 %</b> <span lang="fr">Joueurs parmi les adultes</span>');
    // Description entière repliée, sans JavaScript
    expect(html).toContain('<details class="mdesc"><summary>Description complète</summary><p lang="fr">Pratique du jeu vidéo en France');
    expect(html).toContain("Module générique, réutilisable par tout projet");
  });

  it("usage : filtres prêts à l'emploi en clair (phrase exacte à côté), segments d'analyse", async () => {
    const { html } = await page("/m/personas/jeux-video?ui=fr");
    expect(html).toContain("À quoi sert ce module");
    expect(html).toContain('<code class="use-expr">jeux-video.player_frequency == quotidien</code>');
    expect(html).toMatch(/Fréquence de jeu[^<]*≠/);
    expect(html).toMatch(/Âge &lt; 35 et Fréquence de jeu/);
    expect(html).toContain("Segments d&#39;analyse");
  });

  it("attributs lisibles (type, valeurs, marge principale, provenance), sources cliquables, hypothèses", async () => {
    const { html } = await page("/m/personas/jeux-video?ui=fr");
    expect(html).toContain('<ul class="attrs">');
    expect(html).toContain('<span class="tag">choix unique</span><code>player_frequency</code>');
    expect(html).toMatch(/<ul class="pills" lang="fr"><li>[^<]+<\/li>/);
    expect(html).toMatch(/<div class="attr-margin"><div class="mbar">/);
    expect(html).toContain('<a href="#src-sell_mediametrie_2025_cp"');
    expect(html).toContain('<li id="src-sell_mediametrie_2025_cp"><a href="https://www.sell.fr/');
    expect(html).toContain('rel="noopener noreferrer external"');
    expect(html).toContain('<h2 id="s-hypos">Hypothèses');
    expect(html).toMatch(/<details class="hypo-tables"><summary>\d+ tables de calibration<\/summary>/);
  });

  it("installation visible avant le détail, lien vers la doc de l'API ; versions, historique et détail du score repliés en bas", async () => {
    const { html } = await page("/m/personas/jeux-video?ui=en");
    const install = html.indexOf('<section class="install-box"');
    expect(install).toBeGreaterThan(0);
    expect(install).toBeLessThan(html.indexOf('id="s-attrs"'));
    expect(html).toContain('<pre class="cmd" aria-describedby="install-copy"><code>personas hub pull personas/jeux-video@2026.2</code></pre>');
    expect(html).toContain('<a href="/docs/api">API documentation</a>');
    expect(html).toContain('<a href="/v1/modules/personas/jeux-video/2026.2">Exact YAML</a>');
    const folds = html.slice(html.indexOf('<section class="section folds"'));
    for (const id of ["versions", "history", "quality"]) expect(folds).toContain(`<details class="fold" id="${id}">`);
    expect(folds).toContain("Change history");
    expect(folds).toContain('class="status verified"');
    // Rien de tout ça n'est ouvert par défaut ni répété en haut
    expect(folds).not.toMatch(/<details[^>]* open/);
    expect(visible(html)).not.toContain("Change history");
    expect(visible(html)).not.toContain("SHA-256");
  });

  it("module sensible (barbecue-reception, EN) : pastille, notes techniques du YAML en bas seulement, pas de JS ni de style en ligne", async () => {
    const { r, html } = await page("/m/personas/barbecue-reception?ui=en");
    expect(r.status).toBe(200);
    expect(html).toContain('<span class="badge b-sensitive"');
    expect(html).toContain("Base sg · Singapore");
    expect(html).toContain("What this module is for");
    expect(html).toContain('<details class="fold" id="notes"><summary><h2>Author&#39;s technical notes</h2>');
    const note = "Employées de maison (mdw)";
    expect(html).toContain(note);
    expect(visible(html)).not.toContain(note);
    expect(html).not.toMatch(/<script|style=/);
    expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
    // Classes de largeur seulement (w-0 à w-100), jamais de largeur en ligne
    for (const m of html.slice(html.indexOf("<main")).matchAll(/<i class="([^"]*)"><\/i>/g)) expect(m[1]).toMatch(/(^|\s)w-(\d|[1-9]\d|100)$/);
  });
});
