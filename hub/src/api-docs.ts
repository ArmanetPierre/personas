import type { CatalogResponse } from "../../src/hub/contract";
import type { UiLang } from "./i18n";
import { esc, layout, type PageCtx } from "./pages";

/**
 * Documentation de l'API publique du Hub (/docs/api) et page d'avertissement servie quand un humain
 * ouvre une route JSON de /v1/* dans un navigateur (négociation sur l'en-tête Accept, voir
 * `prefersHtml`). HTML rendu côté serveur, sans script ni style en ligne, interface FR/EN.
 * Les clients programmatiques (runner, curl, fetch) reçoivent toujours le JSON inchangé.
 */

// ── Négociation ──────────────────────────────────────────────────────────

/**
 * Vrai si l'en-tête Accept demande du HTML en priorité (navigateur) sans demander explicitement JSON
 * avec au moins le même poids. `*\/*` seul (curl, fetch) ou `application/json` (runner) : faux.
 */
export function prefersHtml(accept: string | undefined): boolean {
  if (!accept) return false;
  let html = 0;
  let json = -1;
  for (const part of accept.split(",")) {
    const [type = "", ...params] = part.trim().toLowerCase().split(";");
    const qs = params.map((p) => /^\s*q=([0-9.]+)\s*$/.exec(p)?.[1]).find((v) => v !== undefined);
    const q = qs === undefined ? 1 : Number(qs);
    if (!Number.isFinite(q)) continue;
    const t = type.trim();
    if (t === "text/html" || t === "application/xhtml+xml") html = Math.max(html, q);
    else if (t === "application/json" || t.endsWith("+json")) json = Math.max(json, q);
  }
  return html > 0 && html > json;
}

// ── Textes ───────────────────────────────────────────────────────────────

type Bi = Record<UiLang, string>;
const tr = (ui: UiLang, s: Bi) => s[ui];

const T = {
  title: { fr: "API du Hub", en: "Hub API" },
  crumb: { fr: "Modules", en: "Modules" },
  lede: {
    fr: "L'API publique du Hub sert le catalogue des modules et des socles pays au format JSON. Elle est d'abord faite pour l'outil local Personas : personas hub sync, personas hub search et personas hub pull l'interrogent pour vous. Vous n'avez pas besoin de la lire pour utiliser le Hub.",
    en: "The Hub's public API serves the catalogue of modules and country packs as JSON. It is built first for the local Personas tool: personas hub sync, personas hub search and personas hub pull query it for you. You do not need to read it to use the Hub.",
  },
  toc: { fr: "Sur cette page", en: "On this page" },
  sUse: { fr: "À quoi sert l'API", en: "What the API is for" },
  use: [
    {
      fr: "personas hub sync télécharge le catalogue (GET /v1/catalog) et le garde en cache ; il ne le retélécharge que s'il a changé (ETag).",
      en: "personas hub sync downloads the catalogue (GET /v1/catalog) and keeps it in a cache; it downloads it again only when it changed (ETag).",
    },
    { fr: "personas hub search interroge la recherche (GET /v1/search).", en: "personas hub search queries the search (GET /v1/search)." },
    {
      fr: "personas hub pull récupère le texte exact d'une version (GET /v1/modules/…/version), vérifie son empreinte SHA-256 et sa signature, puis l'installe.",
      en: "personas hub pull fetches the exact text of a version (GET /v1/modules/…/version), checks its SHA-256 digest and signature, then installs it.",
    },
  ],
  useNote: {
    fr: "Les lectures sont publiques et anonymes, en JSON (UTF-8), avec CORS ouvert en lecture et une limite de requêtes par minute et par adresse IP (réponse 429 avec Retry-After au-delà). Les erreurs ont toujours la forme { \"error\": { \"code\", \"message\" } }.",
    en: "Reads are public and anonymous, as JSON (UTF-8), with CORS open for reads and a per-minute, per-IP request limit (429 with Retry-After beyond it). Errors always have the shape { \"error\": { \"code\", \"message\" } }.",
  },
  sRead: { fr: "Points d'accès publics (lecture)", en: "Public endpoints (read)" },
  readHint: { fr: "Tous en GET, sans authentification.", en: "All GET, no authentication." },
  params: { fr: "Paramètres", en: "Parameters" },
  noParams: { fr: "Aucun paramètre.", en: "No parameters." },
  raw: { fr: "JSON brut", en: "Raw JSON" },
  sWrite: { fr: "Écriture", en: "Writing" },
  write: {
    fr: "Publier un module ou un pack, forker un module, mettre une étoile, laisser un avis ou signaler un contenu demandent un compte et un jeton personnel. Le plus simple est de passer par l'outil : personas hub login ouvre une page de connexion et enregistre le jeton, puis personas hub publish, fork, star, review et report l'utilisent. Le jeton s'envoie dans l'en-tête Authorization: Bearer ; il ne doit jamais être partagé ni écrit dans un dépôt.",
    en: "Publishing a module or a pack, forking a module, starring, reviewing or reporting content require an account and a personal token. The simplest way is through the tool: personas hub login opens a sign-in page and stores the token, then personas hub publish, fork, star, review and report use it. The token goes in the Authorization: Bearer header; never share it or commit it to a repository.",
  },
  sExample: { fr: "Exemple", en: "Example" },
  exampleHint: { fr: "Demander le catalogue, puis le redemander seulement s'il a changé :", en: "Request the catalogue, then request it again only if it changed:" },
  excerpt: { fr: "Extrait réel de la réponse (tableaux raccourcis) :", en: "Real excerpt of the response (arrays shortened):" },
  fields: [
    { k: "apiVersion", fr: "version du contrat ; tout ajout est rétrocompatible, un changement cassant passerait par /v2.", en: "contract version; additions are backward compatible, a breaking change would go to /v2." },
    { k: "generatedAt", fr: "date de construction du catalogue (ISO 8601).", en: "when the catalogue was built (ISO 8601)." },
    { k: "modules[].ref", fr: "référence namespace/slug ; latest est la dernière version.", en: "namespace/slug reference; latest is the newest version." },
    { k: "modules[].appliesTo", fr: "socles pays sur lesquels le module se greffe (fr, sg, us…).", en: "country packs the module plugs into (fr, sg, us…)." },
    { k: "versions[].sha256", fr: "empreinte du texte YAML exact publié, vérifiée par personas hub pull.", en: "digest of the exact published YAML text, checked by personas hub pull." },
    { k: "versions[].quality", fr: "score de qualité Q (sur 100) et ses quatre composantes (0 à 1).", en: "quality score Q (out of 100) and its four components (0 to 1)." },
    { k: "ranking", fr: "classement R, étoiles, avis et badges (champ ajouté, facultatif).", en: "R ranking, stars, reviews and badges (added field, optional)." },
    { k: "packs[]", fr: "socles pays : pays, langue, versions et version étendue.", en: "country packs: country, language, versions and the version they extend." },
  ],
  sSig: { fr: "Vérifier une signature", en: "Verifying a signature" },
  sigLede: {
    fr: "Chaque version publiée est signée par le Hub (Ed25519). personas hub pull le vérifie pour vous ; pour le refaire à la main :",
    en: "Every published version is signed by the Hub (Ed25519). personas hub pull checks it for you; to do it by hand:",
  },
  sig: [
    { fr: "Lire la clé publique du Hub sur GET /v1/keys (champ publicKey, 32 octets en base64, repérée par son kid).", en: "Read the Hub's public key from GET /v1/keys (publicKey, 32 bytes in base64, identified by its kid)." },
    { fr: "Lire la version (GET /v1/modules/{ns}/{slug}/{version}) : champs ref, version, sha256, publishedAt et signature { alg, kid, value }.", en: "Read the version (GET /v1/modules/{ns}/{slug}/{version}): fields ref, version, sha256, publishedAt and signature { alg, kid, value }." },
    { fr: "Vérifier que le SHA-256 du champ yaml (texte exact, UTF-8) est égal à sha256.", en: "Check that the SHA-256 of the yaml field (exact text, UTF-8) equals sha256." },
    { fr: "Reconstruire le texte signé : le JSON compact ci-dessous, clés dans cet ordre, valeurs telles que renvoyées par l'API.", en: "Rebuild the signed text: the compact JSON below, keys in this order, values exactly as returned by the API." },
    { fr: "Vérifier la signature Ed25519 (value, en base64) de ce texte avec la clé du même kid.", en: "Verify the Ed25519 signature (value, base64) of that text with the key of the same kid." },
  ],
  sigNote: { fr: "Les packs suivent le même principe (sha256 : empreinte canonique de leurs fichiers).", en: "Packs follow the same principle (sha256: canonical digest of their files)." },
  sRaw: { fr: "Liens vers le JSON brut", en: "Links to the raw JSON" },
  rawHint: { fr: "Le paramètre format=json force le JSON quand l'adresse est ouverte dans un navigateur.", en: "The format=json parameter forces JSON when the address is opened in a browser." },
} as const;

interface Endpoint {
  path: string;
  desc: Bi;
  params?: Array<[string, Bi]>;
}

const ENDPOINTS: Endpoint[] = [
  {
    path: "/v1/catalog",
    desc: { fr: "Catalogue complet : tous les modules (avec leurs versions et leur score Q) et tous les socles pays. Réponse avec ETag : renvoyer If-None-Match pour obtenir 304 s'il n'a pas changé.", en: "Full catalogue: every module (with its versions and Q score) and every country pack. ETag response: send If-None-Match to get 304 when unchanged." },
    params: [["prefer", { fr: "fr ou en : modules dans cette langue d'abord (rien n'est filtré).", en: "fr or en: modules in that language first (nothing is filtered)." }]],
  },
  {
    path: "/v1/modules/{ns}/{slug}",
    desc: { fr: "Fiche d'un module : libellé, description, socles, attributs, versions et classement.", en: "A module's card: label, description, packs, attributes, versions and ranking." },
  },
  {
    path: "/v1/modules/{ns}/{slug}/{version}",
    desc: { fr: "Une version immuable d'un module : texte YAML exact, empreinte, dépendances, score Q, licence, signature. 410 si la modération l'a retirée.", en: "An immutable module version: exact YAML text, digest, dependencies, Q score, licence, signature. 410 if moderation removed it." },
  },
  {
    path: "/v1/packs/{ns}/{slug}/{version}",
    desc: { fr: "Une version d'un socle pays : ses fichiers de tables (JSON), son empreinte, la version qu'il étend, sa signature.", en: "A country pack version: its table files (JSON), digest, the version it extends, its signature." },
  },
  {
    path: "/v1/search",
    desc: { fr: "Recherche de modules, classés.", en: "Module search, ranked." },
    params: [
      ["q", { fr: "texte recherché (200 caractères au plus), français ou anglais.", en: "search text (200 characters at most), French or English." }],
      ["socle", { fr: "ne garder que les modules d'un socle (fr, sg, us…).", en: "keep only modules of one country pack (fr, sg, us…)." }],
      ["lang", { fr: "ne garder que les modules d'une langue (fr, en…).", en: "keep only modules in one language (fr, en…)." }],
      ["prefer", { fr: "fr ou en : cette langue d'abord, sans filtrer.", en: "fr or en: that language first, without filtering." }],
      ["sort", { fr: "r (classement R, par défaut) ou q (score de qualité).", en: "r (R ranking, default) or q (quality score)." }],
      ["limit", { fr: "nombre de résultats, de 1 à 100 (20 par défaut).", en: "number of results, 1 to 100 (20 by default)." }],
    ],
  },
  {
    path: "/v1/modules/{ns}/{slug}/{version}/reviews",
    desc: { fr: "Avis publics sur une version : nombre, note moyenne et liste.", en: "Public reviews of a version: count, mean rating and list." },
  },
  {
    path: "/v1/keys",
    desc: { fr: "Clés publiques de signature du Hub (Ed25519) et description du texte signé.", en: "The Hub's public signing keys (Ed25519) and a description of the signed text." },
  },
  {
    path: "/v1/legal",
    desc: { fr: "Liste des textes légaux (conditions, confidentialité) avec leur version.", en: "List of legal texts (terms, privacy) with their version." },
  },
  {
    path: "/v1/legal/{doc}",
    desc: { fr: "Un texte légal en Markdown (doc : terms ou privacy).", en: "A legal text in Markdown (doc: terms or privacy)." },
    params: [["lang", { fr: "fr (par défaut) ou en.", en: "fr (default) or en." }]],
  },
];

const anchor = (path: string) => `ep-${path.replace(/[{}]/g, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")}`;

/** JSON indenté, valeurs courtes sur une ligne (sauf celles qui portent une marque « … »). */
function pretty(v: unknown, indent = ""): string {
  const compact = JSON.stringify(v);
  if (v === null || typeof v !== "object" || (compact.length <= 64 && !compact.includes("__MORE"))) return compact;
  const inner = indent + "  ";
  if (Array.isArray(v)) return `[\n${v.map((x) => inner + pretty(x, inner)).join(",\n")}\n${indent}]`;
  return `{\n${Object.entries(v).map(([k, x]) => `${inner}${JSON.stringify(k)}: ${pretty(x, inner)}`).join(",\n")}\n${indent}}`;
}

/** Extrait réel du catalogue : premier module et premier pack, tableaux raccourcis (commentaires « … »). */
function catalogExcerpt(cat: CatalogResponse, ui: UiLang): string {
  const more = (n: number) => (n > 0 ? `__MORE_${n}__` : null);
  const m = cat.modules[0] as (CatalogResponse["modules"][number] & { ranking?: { r: number; stars: number; badges: string[] } }) | undefined;
  const p = cat.packs[0];
  const latestV = m ? (m.versions.find((v) => v.version === m.latest) ?? m.versions.at(-1)) : undefined;
  const mod = m
    ? {
        ref: m.ref,
        label: m.label,
        appliesTo: m.appliesTo,
        ...(m.locale && { locale: m.locale }),
        attributes: [...m.attributes.slice(0, 1), more(m.attributes.length - 1)].filter((x) => x !== null),
        latest: m.latest,
        versions: [latestV, more(m.versions.length - 1)].filter((x) => x !== null && x !== undefined),
        ...(m.ranking && { ranking: { r: m.ranking.r, stars: m.ranking.stars, badges: m.ranking.badges, ...{ __MORE_FIELDS__: true } } }),
      }
    : null;
  const pack = p ? { ref: p.ref, label: p.label, country: p.country, locale: p.locale, latest: p.latest, versions: [p.versions.at(-1), more(p.versions.length - 1)].filter((x) => x !== null && x !== undefined) } : null;
  const excerpt = {
    apiVersion: cat.apiVersion,
    generatedAt: cat.generatedAt,
    modules: [mod, more(cat.modules.length - 1)].filter((x) => x !== null),
    packs: [pack, more(cat.packs.length - 1)].filter((x) => x !== null),
  };
  const others = (n: string) => (ui === "fr" ? `// … ${n} de plus` : `// … ${n} more`);
  return pretty(excerpt)
    .replace(/"__MORE_(\d+)__"/g, (_s, n: string) => others(n))
    .replace(/"__MORE_FIELDS__": true/g, ui === "fr" ? "// … autres champs" : "// … other fields");
}

export interface ApiDocsInput {
  catalog: CatalogResponse;
  /** Adresse publique du Hub (PUBLIC_BASE_URL ou origine de la requête), pour l'exemple curl. */
  origin: string;
}

/** Texte échappé, commandes et en-têtes en `code` (personas hub …, GET /v1/…, Authorization: Bearer…). */
const rich = (s: string) =>
  esc(s)
    .replace(/personas hub [a-z]+/g, "<code>$&</code>")
    .replace(/GET \/v1\/[^\s),;:]*/g, "<code>$&</code>")
    .replace(/Authorization: Bearer|If-None-Match|Retry-After|format=json/g, "<code>$&</code>");

export function renderApiDocs(c: PageCtx, input: ApiDocsInput): string {
  const ui = c.ui;
  const t = (s: Bi) => rich(tr(ui, s));
  const cat = input.catalog;
  const m = cat.modules[0];
  const p = cat.packs[0];
  const toc: Array<[string, Bi]> = [
    ["use", T.sUse],
    ["read", T.sRead],
    ["write", T.sWrite],
    ["example", T.sExample],
    ["signature", T.sSig],
    ["raw", T.sRaw],
  ];

  const endpoint = (e: Endpoint) => `<li class="ep" id="${anchor(e.path)}">
<p class="ep-head"><span class="method">GET</span><code class="ep-path">${esc(e.path)}</code></p>
<p class="ep-desc">${t(e.desc)}</p>
${e.params?.length ? `<dl class="ep-params" aria-label="${t(T.params)}">${e.params.map(([k, d]) => `<dt><code>${esc(k)}</code></dt><dd>${t(d)}</dd>`).join("")}</dl>` : ""}
</li>`;

  const raw: Array<[string, string]> = [
    ["/v1/catalog", "/v1/catalog?format=json"],
    ...(m ? ([[`/v1/modules/${m.ref}`, `/v1/modules/${m.ref}?format=json`], [`/v1/modules/${m.ref}/${m.latest}`, `/v1/modules/${m.ref}/${encodeURIComponent(m.latest)}?format=json`], [`/v1/modules/${m.ref}/${m.latest}/reviews`, `/v1/modules/${m.ref}/${encodeURIComponent(m.latest)}/reviews?format=json`]] as Array<[string, string]>) : []),
    ...(p ? ([[`/v1/packs/${p.ref}/${p.latest}`, `/v1/packs/${p.ref}/${encodeURIComponent(p.latest)}?format=json`]] as Array<[string, string]>) : []),
    ["/v1/search?q=budget&sort=q", "/v1/search?q=budget&sort=q&format=json"],
    ["/v1/keys", "/v1/keys?format=json"],
    ["/v1/legal", "/v1/legal?format=json"],
  ];

  const base = input.origin.replace(/\/+$/, "");
  const curl = `curl -s ${base}/v1/catalog -H 'Accept: application/json' -D headers.txt -o catalog.json
# ${ui === "fr" ? "plus tard : 304 Not Modified si rien n'a changé" : "later: 304 Not Modified if nothing changed"}
curl -s ${base}/v1/catalog -H 'If-None-Match: "<ETag>"' -o catalog.json -w '%{http_code}\\n'`;

  const body = `<nav class="crumbs" aria-label="${esc(ui === "fr" ? "Fil d'Ariane" : "Breadcrumb")}"><a href="/">${t(T.crumb)}</a><span aria-hidden="true">›</span><span aria-current="page">${t(T.title)}</span></nav>
<article class="apidoc">
<h1>${t(T.title)}</h1>
<p class="lede">${t(T.lede)}</p>
<div class="toc" role="group" aria-labelledby="toc-title"><p class="flabel" id="toc-title">${t(T.toc)}</p><ul>${toc.map(([id, l]) => `<li><a href="#${id}">${t(l)}</a></li>`).join("")}</ul></div>

<section class="section" id="use" aria-labelledby="use-title"><h2 id="use-title">${t(T.sUse)}</h2>
<ul class="plain-list">${T.use.map((u) => `<li>${t(u)}</li>`).join("")}</ul>
<p class="small ink2 note-p">${t(T.useNote)}</p>
</section>

<section class="section" id="read" aria-labelledby="read-title"><div class="section-head"><h2 id="read-title">${t(T.sRead)}</h2><p class="small ink2">${t(T.readHint)}</p></div>
<ul class="endpoints">${ENDPOINTS.map(endpoint).join("\n")}</ul>
</section>

<section class="section" id="write" aria-labelledby="write-title"><h2 id="write-title">${t(T.sWrite)}</h2>
<p class="prose-p">${t(T.write)}</p>
</section>

<section class="section" id="example" aria-labelledby="example-title"><h2 id="example-title">${t(T.sExample)}</h2>
<p class="prose-p">${t(T.exampleHint)}</p>
<pre class="code"><code>${esc(curl)}</code></pre>
<p class="prose-p">${t(T.excerpt)}</p>
<pre class="code"><code>${esc(catalogExcerpt(cat, ui))}</code></pre>
<dl class="ep-params fields">${T.fields.map((f) => `<dt><code>${esc(f.k)}</code></dt><dd>${esc(f[ui])}</dd>`).join("")}</dl>
</section>

<section class="section" id="signature" aria-labelledby="sig-title"><h2 id="sig-title">${t(T.sSig)}</h2>
<p class="prose-p">${t(T.sigLede)}</p>
<ol class="plain-list">${T.sig.map((s) => `<li>${t(s)}</li>`).join("")}</ol>
<pre class="code"><code>${esc('{"ref":"personas/…","version":"…","sha256":"…","publishedAt":"2026-…Z"}')}</code></pre>
<p class="small ink2 note-p">${t(T.sigNote)}</p>
</section>

<section class="section" id="raw" aria-labelledby="raw-title"><div class="section-head"><h2 id="raw-title">${t(T.sRaw)}</h2><p class="small ink2">${t(T.rawHint)}</p></div>
<ul class="raw-links">${raw.map(([label, href]) => `<li><a href="${esc(href)}"><code>${esc(label)}</code></a></li>`).join("")}</ul>
</section>
</article>`;
  return layout(c, { title: `${tr(ui, T.title)} · Personas Hub`, body, current: "api", path: "/docs/api", description: tr(ui, T.lede) });
}

// ── Page « ce n'est pas pour vous » (route JSON ouverte dans un navigateur) ──

const N = {
  title: { fr: "API du Hub", en: "Hub API" },
  lede: {
    fr: "Cette adresse est l'API du Hub, destinée à l'outil Personas, pas une page à lire.",
    en: "This address is the Hub's API, meant for the Personas tool, not a page to read.",
  },
  hint: {
    fr: "Votre navigateur a demandé une page : voici un aperçu lisible. Les programmes (l'outil Personas, curl) reçoivent le JSON.",
    en: "Your browser asked for a page: here is a readable preview. Programs (the Personas tool, curl) receive the JSON.",
  },
  preview: { fr: "Aperçu", en: "Preview" },
  docs: { fr: "Documentation de l'API", en: "API documentation" },
  raw: { fr: "Voir le JSON brut", en: "View the raw JSON" },
  page: { fr: "Ouvrir la page lisible", en: "Open the readable page" },
  status: { fr: "Statut HTTP", en: "HTTP status" },
  address: { fr: "Adresse", en: "Address" },
  error: { fr: "Erreur", en: "Error" },
  modules: { fr: "Modules", en: "Modules" },
  packs: { fr: "Socles pays", en: "Country packs" },
  generatedAt: { fr: "Construit le", en: "Built on" },
  module: { fr: "Module", en: "Module" },
  pack: { fr: "Socle pays", en: "Country pack" },
  latest: { fr: "Dernière version", en: "Latest version" },
  versions: { fr: "Versions", en: "Versions" },
  version: { fr: "Version", en: "Version" },
  versionStatus: { fr: "État", en: "Status" },
  sha: { fr: "SHA-256", en: "SHA-256" },
  yaml: { fr: "Texte YAML", en: "YAML text" },
  lines: { fr: "lignes", en: "lines" },
  files: { fr: "Fichiers", en: "Files" },
  signed: { fr: "Signature", en: "Signature" },
  yes: { fr: "oui", en: "yes" },
  no: { fr: "non", en: "no" },
  query: { fr: "Recherche", en: "Query" },
  results: { fr: "Résultats", en: "Results" },
  first: { fr: "Premiers résultats", en: "Top results" },
  reviews: { fr: "Avis", en: "Reviews" },
  mean: { fr: "Note moyenne", en: "Mean rating" },
  keys: { fr: "Clés de signature", en: "Signing keys" },
  docsList: { fr: "Documents", en: "Documents" },
  fields: { fr: "Champs", en: "Fields" },
} as const;

export interface ApiNoticeInput {
  status: number;
  /** Chemin demandé (sans requête). */
  path: string;
  /** Adresse du JSON brut (?format=json). */
  rawHref: string;
  /** Corps JSON de la réponse, s'il a pu être lu. */
  data: unknown;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const str = (x: unknown) => (typeof x === "string" ? x : typeof x === "number" ? String(x) : "");

/** Aperçu (libellé, valeur HTML déjà échappée) et éventuelle page lisible équivalente. */
function previewOf(ui: UiLang, path: string, d: unknown): { facts: Array<[string, string]>; page?: string } {
  const t = (s: Bi) => tr(ui, s);
  const code = (s: string) => `<code>${esc(s)}</code>`;
  if (!isObj(d)) return { facts: [] };
  if (isObj(d.error)) return { facts: [[t(N.error), `${code(str(d.error.code))} ${esc(str(d.error.message))}`]] };
  const seg = path.split("/").filter(Boolean); // v1, …
  if (Array.isArray(d.modules) && Array.isArray(d.packs)) {
    return { facts: [[t(N.modules), esc(d.modules.length)], [t(N.packs), esc(d.packs.length)], [t(N.generatedAt), code(str(d.generatedAt))]], page: "/" };
  }
  if (seg[1] === "search" && Array.isArray(d.results)) {
    const first = d.results.slice(0, 5).filter(isObj).map((r) => `<a href="/m/${esc(str(r.ref))}">${esc(str(r.label))}</a>`);
    return {
      facts: [[t(N.query), d.query ? code(str(d.query)) : "–"], [t(N.results), esc(d.results.length)], ...(first.length ? ([[t(N.first), first.join(", ")]] as Array<[string, string]>) : [])],
      page: `/?q=${encodeURIComponent(str(d.query))}`,
    };
  }
  if (Array.isArray(d.reviews)) {
    return { facts: [[t(N.module), code(`${str(d.ref)}@${str(d.version)}`)], [t(N.reviews), esc(str(d.count))], [t(N.mean), d.mean === null ? "–" : esc(str(d.mean))]], page: `/m/${str(d.ref)}` };
  }
  if (Array.isArray(d.keys)) {
    const kids = d.keys.filter(isObj).map((k) => code(`${str(k.alg)} ${str(k.kid)}`));
    return { facts: [[t(N.keys), kids.length ? kids.join(", ") : "0"]] };
  }
  if (Array.isArray(d.docs)) {
    return { facts: [[t(N.docsList), d.docs.filter(isObj).map((x) => code(`${str(x.doc)}.${str(x.lang)} ${str(x.version)}`)).join(", ")]], page: "/terms" };
  }
  if (typeof d.markdown === "string" && typeof d.doc === "string") {
    return { facts: [[t(N.docsList), code(`${d.doc}.${str(d.lang)}`)], [t(N.version), esc(str(d.version))]], page: `/${d.doc === "privacy" ? "privacy" : "terms"}?ui=${d.lang === "en" ? "en" : "fr"}` };
  }
  if (typeof d.yaml === "string") {
    return {
      facts: [
        [t(N.module), code(`${str(d.ref)}@${str(d.version)}`)],
        [t(N.versionStatus), esc(str(d.status))],
        [t(N.sha), code(str(d.sha256))],
        [t(N.yaml), `${esc(d.yaml.split("\n").length)} ${esc(t(N.lines))}`],
        [t(N.signed), esc(d.signature ? t(N.yes) : t(N.no))],
      ],
      page: `/m/${str(d.ref)}`,
    };
  }
  if (isObj(d.files)) {
    return {
      facts: [[t(N.pack), code(`${str(d.ref)}@${str(d.version)}`)], [t(N.files), esc(Object.keys(d.files).length)], [t(N.sha), code(str(d.sha256))], [t(N.signed), esc(d.signature ? t(N.yes) : t(N.no))]],
      page: "/?view=packs#packs",
    };
  }
  if (typeof d.ref === "string" && Array.isArray(d.versions)) {
    return { facts: [[t(N.module), `${esc(str(d.label))} ${code(d.ref)}`], [t(N.latest), code(str(d.latest))], [t(N.versions), esc(d.versions.length)]], page: `/m/${d.ref}` };
  }
  return { facts: [[t(N.fields), Object.keys(d).slice(0, 12).map(code).join(", ")]] };
}

export function renderApiNotice(c: PageCtx, input: ApiNoticeInput): string {
  const ui = c.ui;
  const t = (s: Bi) => esc(tr(ui, s));
  const pv = previewOf(ui, input.path, input.data);
  const facts: Array<[string, string]> = [[tr(ui, N.address), `<code>${esc(input.path)}</code>`], [tr(ui, N.status), esc(input.status)], ...pv.facts];
  const body = `<div class="api-notice">
<p class="code" aria-hidden="true">{ }</p>
<h1>${t(N.title)}</h1>
<p class="lede">${t(N.lede)}</p>
<p class="small ink2">${t(N.hint)}</p>
<div class="panel api-preview"><h2>${t(N.preview)}</h2><dl class="facts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl></div>
<div class="row actions"><a class="btn" href="/docs/api">${t(N.docs)}</a><a class="btn ghost" href="${esc(input.rawHref)}">${t(N.raw)}</a>${pv.page ? `<a class="btn ghost" href="${esc(pv.page)}">${t(N.page)}</a>` : ""}</div>
</div>`;
  return layout(c, { title: `${tr(ui, N.title)} · ${input.path} · Personas Hub`, body, current: "api" });
}
