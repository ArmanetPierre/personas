import type { CatalogModule, CatalogResponse, QualityScore } from "../../src/hub/contract";
import type { moduleDeps, moduleVersions } from "../db/schema";
import { DICTS, endonym, formatters, type HubDict, type UiLang } from "./i18n";
import type { ModuleRanking, RankedHit } from "./ranking";
import type { SocleLocales } from "./repo";
import type { ModuleDef } from "../../src/modules/schema";
import { attributeValues, eligibilityText, firstSentence, headerNotes, MODULE_PAGE, parseModuleYaml, PROVENANCES, provenanceOf, splitShareLabel } from "./module-view";

/**
 * Pages publiques du Hub : HTML rendu côté serveur, page sœur du tableau de bord (mêmes jetons,
 * polices, rail, cartes et barres ; feuille servie par le Hub, aucun style en ligne ni JavaScript).
 * Interface en français ou en anglais ; le contenu des modules reste dans sa langue.
 */

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

/** Classe de largeur d'une barre (w-0 à w-100, voir assets.ts). */
const w = (share: number) => `w-${Math.round(Math.max(0, Math.min(1, share)) * 100)}`;

export interface PageCtx {
  ui: UiLang;
  /** Adresse de la page courante dans l'autre langue d'interface (lien ?ui=). */
  uiHref: (lang: UiLang) => string;
  cssHref: string;
  faviconHref: string;
  baseUrl?: string | undefined;
}

/** Icônes des états vides : SVG 22 px, trait 1,5, comme `EmptyState` du tableau de bord. */
const EMPTY_ICONS = {
  box: '<path d="M3 13h5l1.5 2.5h5L16 13h5"/><path d="M5.5 5h13L21 13v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5z"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.4-4.4"/><path d="M8.5 11h5"/>',
  chart: '<path d="M4 4v16h16"/><path d="M8 16v-3M12 16V9M16 16v-5"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
} as const;
export type EmptyIcon = keyof typeof EMPTY_ICONS;

/**
 * État vide (même markup et mêmes classes que `EmptyState` de web/src/ui.tsx) : pastille d'icône,
 * titre, description facultative, action facultative (lien déjà existant, jamais une nouvelle fonction).
 */
export function emptyState(o: { icon?: EmptyIcon; title: string; description?: string; action?: { href: string; label: string } }): string {
  const svg = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${EMPTY_ICONS[o.icon ?? "box"]}</svg>`;
  return `<div class="empty-state"><span class="empty-state-icon">${svg}</span><p class="empty-state-title">${esc(o.title)}</p>${o.description ? `<p class="empty-state-desc">${esc(o.description)}</p>` : ""}${o.action ? `<div class="empty-state-action"><a class="btn ghost" href="${esc(o.action.href)}">${esc(o.action.label)}</a></div>` : ""}</div>`;
}

type Fmt = ReturnType<typeof formatters>;
const ctxOf = (c: PageCtx) => ({ t: DICTS[c.ui], f: formatters(c.ui) });

export function layout(c: PageCtx, page: { title: string; body: string; current?: "modules" | "packs" | "api"; path?: string; description?: string; script?: string }): string {
  const { t } = ctxOf(c);
  const base = c.baseUrl?.replace(/\/$/, "");
  const canonical = base && page.path !== undefined ? `<link rel="canonical" href="${esc(base + page.path)}">` : "";
  const navLink = (href: string, label: string, key: "modules" | "packs" | "api") => `<a href="${esc(href)}"${page.current === key ? ' aria-current="page"' : ""}>${esc(label)}</a>`;
  const uiLink = (l: UiLang) => `<a href="${esc(c.uiHref(l))}" hreflang="${l}" lang="${l}"${l === c.ui ? ' aria-current="true"' : ""}>${l.toUpperCase()}<span class="sr-only"> (${esc(endonym(l))})</span></a>`;
  return `<!doctype html>
<html lang="${t.htmlLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(page.title)}</title>
${page.description ? `<meta name="description" content="${esc(page.description.slice(0, 300))}">` : ""}
${canonical}
<link rel="icon" href="${esc(c.faviconHref)}" type="image/svg+xml">
<link rel="preload" href="/assets/fonts/public-sans-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/assets/fonts/bricolage-grotesque-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${esc(c.cssHref)}">
${page.script ? `<script src="${esc(page.script)}" defer></script>` : ""}
</head>
<body>
<a class="skip" href="#main">${esc(t.skip)}</a>
<div class="shell">
<header class="rail">
<a class="brand" href="/" aria-label="${esc(t.brandHome)}"><span class="brand-mark" aria-hidden="true"><i class="on"></i><i></i><i></i><i></i><i></i><i></i></span><span class="brand-name">Personas</span><span class="brand-sub">${esc(t.hub)}</span></a>
<nav class="main-nav" aria-label="${esc(t.nav.label)}">${navLink("/", t.nav.modules, "modules")}${navLink("/?view=packs#packs", t.nav.packs, "packs")}${navLink("/docs/api", t.nav.api, "api")}</nav>
<div class="rail-foot">
<p>${esc(t.tagline)}</p>
<nav class="ui-switch" aria-label="${esc(t.uiSwitch)}">${uiLink("fr")}${uiLink("en")}</nav>
</div>
</header>
<main id="main" tabindex="-1">
<div class="page">
${page.body}
</div>
</main>
<footer class="page-foot"><p>${esc(t.footer)}</p><p><a href="/terms">${esc(t.legal.terms)}</a> · <a href="/privacy">${esc(t.legal.privacy)}</a> · API${esc(t.colon)}<a href="/v1/catalog"><code>/v1/catalog</code></a> · <a href="/v1/search?q="><code>/v1/search</code></a></p></footer>
</div>
</body>
</html>`;
}

function qBars(q: QualityScore, t: HubDict, f: Fmt, size: "sm" | "lg" = "sm"): string {
  const parts: Array<[string, number]> = [
    [t.q.sourcing, q.sourcing],
    [t.q.margins, q.margins],
    [t.q.alerts, q.alerts],
    [t.q.docs, q.docs],
  ];
  return `<dl class="qbars${size === "lg" ? " lg" : ""}" aria-label="${esc(t.q.parts)}">${parts
    .map(([label, v]) => `<dt>${esc(label)}</dt><dd><span class="t" aria-hidden="true"><i class="${w(v)}"></i></span><span class="v">${f.dec2(v)}</span></dd>`)
    .join("")}</dl>`;
}

const qBig = (q: QualityScore | null | undefined, t: HubDict) =>
  q ? `<div class="qbig"><b>${q.q.toFixed(0)}</b><span>Q ${esc(t.q.of100)}</span></div>` : `<div class="qbig none"><b>–</b><span>${esc(t.card.noQ)}</span></div>`;

/** Badges d'un module (classement R) et statut de sa dernière version (signalée, retirée). */
function badgesHtml(badges: readonly string[], status: string | undefined, t: HubDict): string {
  const list = [...badges];
  if (status && ["flagged", "removed", "yanked"].includes(status) && !list.includes(status)) list.push(status);
  return list
    .map((b) => `<span class="badge b-${esc(b)}"${t.badgeHints[b] ? ` title="${esc(t.badgeHints[b])}"` : ""}>${esc(t.badges[b] ?? b)}</span>`)
    .join("");
}

/** Étoiles et note moyenne (avis), en chiffres. */
function socialHtml(r: ModuleRanking | undefined, t: HubDict, f: Fmt): string {
  if (!r) return "";
  const rating = r.reviews.count && r.reviews.mean !== null ? t.social.rating(f.dec1(r.reviews.mean), r.reviews.count) : t.social.noRating;
  return `<span class="social"><span class="stars" title="${esc(t.social.stars(r.stars))}"><span aria-hidden="true">★</span> <span class="sr-only">${esc(t.social.stars(r.stars))}</span><span aria-hidden="true">${r.stars}</span></span><span class="rating">${esc(rating)}</span></span>`;
}

/** Libellé d'un socle : pays de son pack (« France », « Singapour »), sinon son code. */
function socleName(socle: string, packs: CatalogResponse["packs"], f: Fmt): string {
  const p = packs.find((x) => x.ref.endsWith(`/${socle}`)) ?? packs.find((x) => x.generator === socle);
  return p ? f.region(p.country) : socle;
}

const latestQuality = (card: CatalogModule | undefined) => card?.versions.find((v) => v.version === card.latest)?.quality ?? null;

export interface IndexInput {
  /**
   * Résultats de la recherche texte seule, triés (R puis Q, ou Q), modules dans la langue de l'interface
   * d'abord (rankedSearch, `prefer`) ; filtres appliqués ici, pour compter chaque option.
   */
  hits: RankedHit[];
  sort: "r" | "q";
  q: string;
  lang: string | undefined;
  socle: string | undefined;
  catalog: CatalogResponse;
  locales: SocleLocales;
  /** Vue demandée par le rail (« Socles pays » : ?view=packs) ; même page, entrée du rail courante. */
  view?: "packs" | undefined;
}

export function renderIndex(c: PageCtx, input: IndexInput): string {
  const { t, f } = ctxOf(c);
  const { q, lang, socle, catalog, locales, sort } = input;
  const cards = new Map(catalog.modules.map((m) => [m.ref, m]));
  const langsOf = (h: RankedHit) => [...new Set(h.appliesTo.map((s) => locales.get(s)).filter((x): x is string => !!x))];
  const keep = (h: RankedHit, l: string | undefined, s: string | undefined) => (!l || langsOf(h).includes(l)) && (!s || h.appliesTo.includes(s));
  const hits = input.hits.filter((h) => keep(h, lang, socle));

  const href = (p: { q?: string; lang?: string | undefined; socle?: string | undefined; sort?: "r" | "q" }) => {
    const sp = new URLSearchParams();
    if (p.q) sp.set("q", p.q);
    if (p.lang) sp.set("lang", p.lang);
    if (p.socle) sp.set("socle", p.socle);
    if (p.sort === "q") sp.set("sort", "q");
    const s = sp.toString();
    return s ? `/?${s}` : "/";
  };

  const langs = [...new Set([...catalog.packs.map((p) => p.locale), ...locales.values()])].sort();
  const socles = [...new Set(catalog.modules.flatMap((m) => m.appliesTo))].sort();
  const chip = (label: string, target: string, current: boolean, n: number | null, attrs = "") =>
    `<li><a class="chip${n === 0 && !current ? " off" : ""}" href="${esc(target)}"${current ? ' aria-current="true"' : ""}${attrs}>${label}${n === null ? "" : ` <span class="n">${n}</span>`}</a></li>`;
  const langChips = [
    chip(esc(t.index.allLangs), href({ q, socle, sort }), !lang, input.hits.filter((h) => keep(h, undefined, socle)).length),
    ...langs.map((l) => chip(esc(endonym(l)), href({ q, lang: l, socle, sort }), lang === l, input.hits.filter((h) => keep(h, l, socle)).length, ` lang="${esc(l)}" hreflang="${esc(l)}"`)),
  ].join("");
  const socleChips = [
    chip(esc(t.index.allSocles), href({ q, lang, sort }), !socle, input.hits.filter((h) => keep(h, lang, undefined)).length),
    ...socles.map((s) => chip(`${esc(socleName(s, catalog.packs, f))} <code class="n">${esc(s)}</code>`, href({ q, lang, socle: s, sort }), socle === s, input.hits.filter((h) => keep(h, lang, s)).length)),
  ].join("");

  const moduleCard = (h: RankedHit) => {
    const card = cards.get(h.ref);
    const quality = latestQuality(card);
    const ls = langsOf(h);
    const badges = badgesHtml(h.ranking?.badges ?? [], h.ranking?.status, t);
    return `<li class="mcard">
<div><h3><a href="/m/${esc(h.ref)}">${esc(h.label)}</a></h3><p class="ref mono">${esc(h.ref)}@${esc(h.latest)}</p></div>
${badges || h.ranking ? `<p class="badges">${badges}${socialHtml(h.ranking, t, f)}</p>` : ""}
<p class="desc">${esc(h.description)}</p>
<p class="meta">${h.appliesTo.map((s) => `<span class="tag" title="${esc(socleName(s, catalog.packs, f))}">${esc(s)}</span>`).join("")}${ls.map((l) => `<span class="tag lang" lang="${esc(l)}">${esc(endonym(l))}</span>`).join("")}${card ? `<span class="tag plain">${esc(t.card.attributes(card.attributes.length))}</span>` : ""}</p>
<div class="mcard-q">${qBig(quality, t)}${quality ? qBars(quality, t, f) : `<span class="small muted">${esc(t.q.none)}</span>`}</div>
</li>`;
  };

  // Packs : ceux dans la langue de l'interface d'abord (partition stable), comme les modules.
  const packs = [...catalog.packs.filter((p) => p.locale === c.ui), ...catalog.packs.filter((p) => p.locale !== c.ui)].filter((p) => (!lang || p.locale === lang) && (!socle || p.ref.endsWith(`/${socle}`) || p.generator === socle));
  const packCard = (p: CatalogResponse["packs"][number]) => {
    const latest = p.versions.at(-1);
    return `<li class="mcard">
<div><h3>${esc(p.label)}</h3><p class="ref mono">${esc(p.ref)}@${esc(p.latest)}</p></div>
<dl class="facts"><dt>${esc(t.card.country)}</dt><dd>${esc(f.region(p.country))}</dd><dt>${esc(t.card.language)}</dt><dd lang="${esc(p.locale)}">${esc(endonym(p.locale))}</dd><dt>${esc(t.card.latest)}</dt><dd><code>${esc(p.latest)}</code>${latest?.extends ? ` <span class="muted">· ${esc(t.card.extends(latest.extends))}</span>` : ""}${latest ? ` <span class="muted">· ${esc(f.date(latest.publishedAt))}</span>` : ""}</dd></dl>
<p class="meta">${p.generator ? `<span class="tag">${esc(p.generator)}</span>` : ""}<span class="tag lang" lang="${esc(p.locale)}">${esc(endonym(p.locale))}</span><span class="tag plain">${esc(t.card.versions(p.versions.length))}</span></p>
</li>`;
  };

  const filtered = Boolean(q || lang || socle || sort === "q");
  // Mise en avant visible seulement quand elle ordonne quelque chose : sans filtre de langue, et avec
  // des modules dans la langue de l'interface et d'autres.
  const inUi = hits.filter((h) => langsOf(h).includes(c.ui)).length;
  const mixed = !lang && inUi > 0 && inUi < hits.length;
  const body = `<div class="head-row">
<div><h1>${esc(t.index.title)}</h1><p class="lede">${esc(t.index.lede)}</p></div>
<dl class="kpis"><div><dt>${esc(t.index.kpiModules)}</dt><dd class="num">${catalog.modules.length}</dd></div><div><dt>${esc(t.index.kpiPacks)}</dt><dd class="num">${catalog.packs.length}</dd></div><div><dt>${esc(t.index.kpiLangs)}</dt><dd class="num">${langs.length}</dd></div></dl>
</div>
<form class="search" method="get" action="/" role="search">
<label class="sr-only" for="q">${esc(t.index.searchLabel)}</label>
<input id="q" type="search" name="q" value="${esc(q)}" placeholder="${esc(t.index.searchPlaceholder)}" maxlength="200" autocomplete="off">
${lang ? `<input type="hidden" name="lang" value="${esc(lang)}">` : ""}${socle ? `<input type="hidden" name="socle" value="${esc(socle)}">` : ""}${sort === "q" ? `<input type="hidden" name="sort" value="q">` : ""}
<button class="btn" type="submit">${esc(t.index.searchButton)}</button>
</form>
<div class="filters" role="group" aria-label="${esc(t.index.filters)}">
<div class="fgroup" role="group" aria-labelledby="f-lang"><span class="flabel" id="f-lang">${esc(t.index.lang)}</span><ul class="chips">${langChips}</ul></div>
<div class="fgroup" role="group" aria-labelledby="f-sort"><span class="flabel" id="f-sort">${esc(t.sort.label)}</span><ul class="chips">${chip(esc(t.sort.r), href({ q, lang, socle }), sort === "r", null, ` title="${esc(t.social.rHint)}"`)}${chip(esc(t.sort.q), href({ q, lang, socle, sort: "q" }), sort === "q", null)}</ul></div>
<div class="fgroup" role="group" aria-labelledby="f-socle"><span class="flabel" id="f-socle">${esc(t.index.socle)}</span><ul class="chips">${socleChips}</ul></div>
${filtered ? `<a class="reset" href="/">${esc(t.index.reset)}</a>` : ""}
</div>
<h2 class="sr-only">${esc(t.index.modulesTitle)}</h2>
<p class="result-line" role="status"><b>${esc(t.index.count(hits.length))}</b>${hits.length > 1 ? ` · ${esc(sort === "q" ? t.sort.sortedQ : t.sort.sortedR)}${mixed ? ` · ${esc(t.sort.preferred)}` : ""}` : ""}</p>
${hits.length ? `<ul class="cards">${hits.map(moduleCard).join("\n")}</ul>` : (catalog.modules.length ? emptyState({ icon: "search", title: t.index.noneTitle, description: t.index.none(q), ...(filtered ? { action: { href: "/", label: t.index.reset } } : {}) }) : emptyState({ title: t.index.catalogEmptyTitle, description: t.index.catalogEmpty }))}
<section class="section" id="packs" aria-labelledby="packs-title">
<div class="section-head"><h2 id="packs-title">${esc(t.index.packsTitle)}</h2><p class="small ink2">${esc(t.index.packsHint)}</p></div>
${packs.length ? `<ul class="cards pcards">${packs.map(packCard).join("\n")}</ul>` : (catalog.packs.length ? emptyState({ icon: "search", title: t.index.packsNoneTitle, description: t.index.packsNone, ...(filtered ? { action: { href: "/", label: t.index.reset } } : {}) }) : emptyState({ title: t.index.packsNoneTitle, description: t.index.packsEmpty }))}
</section>`;
  return layout(c, { title: q ? `${c.ui === "fr" ? `« ${q} »` : `“${q}”`} · Personas Hub` : "Personas Hub", body, current: input.view === "packs" ? "packs" : "modules", path: "/", description: t.tagline });
}

export interface ModuleInput {
  card: CatalogModule;
  latest: typeof moduleVersions.$inferSelect;
  deps: Array<typeof moduleDeps.$inferSelect>;
  packs: CatalogResponse["packs"];
  locales: SocleLocales;
  /** Classement R, étoiles, avis, badges (phase 3). */
  ranking?: ModuleRanking | undefined;
  /** Champs additifs de la dernière version : auteur, filiation, signature, attributs sensibles. */
  extras?: { author: string | null; authorDeleted?: boolean; forkedFrom: { ref: string; version: string } | null; signature: { kid: string } | null; sensitive: string[]; badges: string[] } | undefined;
}

export function renderModule(c: PageCtx, input: ModuleInput): string {
  const { t, f } = ctxOf(c);
  const p = MODULE_PAGE[c.ui];
  const { card, latest } = input;
  const qs = latest.quality;
  const def = parseModuleYaml(latest.yaml);
  const langs = [...new Set(card.appliesTo.map((s) => input.locales.get(s)).filter((x): x is string => !!x))];
  const contentLang = langs[0];
  const inLang = contentLang ? ` lang="${esc(contentLang)}"` : "";
  const pull = `personas hub pull ${card.ref}@${card.latest}`;
  const yamlHref = `/v1/modules/${card.ref}/${encodeURIComponent(card.latest)}`;
  const r = input.ranking;
  const ex = input.extras;
  const preview = latest.preview;
  const pctRange = (lo: number, hi: number) => {
    const n = (x: number) => Math.round(x * 100).toLocaleString(t.htmlLang);
    return `${lo === hi ? n(lo) : `${n(lo)}–${n(hi)}`}${c.ui === "fr" ? " %" : "%"}`;
  };
  const pct0 = (x: number) => `${Math.round(x * 100)}${c.ui === "fr" ? " %" : "%"}`;

  // ── En-tête : titre, résumé, pastilles, filiation ──
  const description = (def?.description ?? card.description).replace(/\s+/g, " ").trim();
  const summary = firstSentence(description);
  const forkedFrom = r?.forkedFrom ?? ex?.forkedFrom ?? null;
  const badgeRow = badgesHtml(r?.badges ?? ex?.badges ?? [], latest.status, t);
  const pills = [
    badgeRow,
    ...card.appliesTo.map((s) => `<span class="tag">${esc(t.index.socle)} ${esc(s)} · ${esc(socleName(s, input.packs, f))}</span>`),
    ...langs.map((l) => `<span class="tag lang" lang="${esc(l)}">${esc(endonym(l))}</span>`),
    `<span class="tag">${esc(p.version)} <span class="mono">${esc(card.latest)}</span></span>`,
    badgeRow ? "" : `<span class="tag"><span class="status ${esc(latest.status)}">${esc(t.status[latest.status] ?? latest.status)}</span></span>`,
  ].join("");
  const deps = input.deps.length ? `<p class="deps">${esc(t.module.requires)}${esc(t.colon)}${input.deps.map((d) => `<a href="/m/${esc(d.ref)}"><code>${esc(d.ref)}@${esc(d.version)}</code></a>`).join(", ")}</p>` : "";
  const lineage = [
    forkedFrom ? `<p class="deps">${esc(t.social.forkOf)} <a href="/m/${esc(forkedFrom.ref)}"><code>${esc(forkedFrom.ref)}@${esc(forkedFrom.version)}</code></a></p>` : "",
    ex?.author ? `<p class="deps">${esc(t.social.author)}${esc(t.colon)}${esc(ex.authorDeleted ? t.social.deletedAuthor : ex.author)}</p>` : "",
  ].join("");
  const rankLine = r ? `<div class="rank mh-rank"><span class="rank-r" title="${esc(t.social.rHint)}">${esc(t.social.r)} <b class="num">${f.dec2(r.r)}</b></span>${socialHtml(r, t, f)}</div>` : "";

  // ── Chiffres clés (données réelles : Q, attributs, parts sourcées, filtres) ──
  const attrs = def?.attributes ?? [];
  const prov = attrs.map(provenanceOf);
  const nAttrs = def ? attrs.length : card.attributes.length;
  const counts = PROVENANCES.map((k) => [k, prov.filter((x) => x === k).length] as const).filter(([, n]) => n > 0);
  const provText = counts.map(([k, n]) => p.prov[k]!(n)).join(" · ");
  const split = nAttrs && def
    ? `<span class="kf-split" role="img" aria-label="${esc(`${p.provenanceSplit}${t.colon}${provText}`)}">${counts.map(([k, n]) => `<i class="${k} ${w(n / nAttrs)}"></i>`).join("")}</span><span class="kf-sub">${esc(provText)}</span>`
    : "";
  const shares = def?.validation.shares ?? [];
  const helpers = Object.entries(def?.eligibility_helpers ?? {});
  const segments = def?.segments ?? [];
  const kfQ = `<div class="kf kf-q"><dt>${esc(t.q.title)}</dt><dd>${qs ? `<div class="kf-qrow"><span class="kf-big num">${qs.q.toFixed(0)}<small>/100</small></span>${qBars(qs, t, f)}</div>` : `<span class="kf-big muted">–</span><span class="kf-sub">${esc(latest.status === "yanked" ? t.q.noneYanked : t.q.none)}</span>`}</dd></div>`;
  const kfAttrs = `<div class="kf"><dt>${esc(t.module.attributes)}</dt><dd><span class="kf-big num">${nAttrs}</span>${split}</dd></div>`;
  const kfShares = `<div class="kf kf-shares"><dt>${esc(p.shares)}</dt><dd>${
    shares.length
      ? `<ul class="kf-list">${shares
          .slice(0, 3)
          .map((s) => `<li><b class="num">${esc(pctRange(s.range[0], s.range[1]))}</b> <span${inLang}>${esc(splitShareLabel(s.label).title)}</span></li>`)
          .join("")}</ul><span class="kf-sub">${esc(preview ? t.q.checks(preview.checks.passed, preview.checks.total) : p.sharesHint)}${shares.length > 3 ? ` · ${esc(p.more(shares.length - 3))}` : ""}</span>`
      : `<span class="kf-sub">${esc(p.noShares)}</span>`
  }</dd></div>`;
  const kfFilters = `<div class="kf"><dt>${esc(p.helpers)}</dt><dd><span class="kf-big num">${helpers.length}</span><span class="kf-sub">${esc(p.filters(helpers.length))} · ${esc(p.segmentsCount(segments.length))}</span></dd></div>`;
  const keyFigures = `<section class="mh-kf" aria-labelledby="s-kf"><h2 id="s-kf" class="sr-only">${esc(p.keyFigures)}</h2><dl class="kfs">${kfQ}${kfAttrs}${def ? kfFilters + kfShares : ""}</dl></section>`;

  // ── Installation ──
  const install = `<section class="install-box" aria-labelledby="s-install"><div><h2 id="s-install">${esc(p.install)}</h2><p class="small ink2">${esc(t.module.installHint)}</p></div>
<pre class="cmd" aria-describedby="install-copy"><code>${esc(pull)}</code></pre>
<p class="small muted"><span id="install-copy">${esc(p.installCopy)}</span> ${esc(t.module.useHint(card.ref))}</p>
<p class="install-links small"><a href="${esc(yamlHref)}">${esc(t.module.yaml)}</a><a href="/docs/api">${esc(p.apiDoc)}</a></p></section>`;

  const fullDesc = description.length > summary.length ? `<details class="mdesc"><summary>${esc(p.fullDescription)}</summary><p${inLang}>${esc(description)}</p></details>` : "";

  // ── À quoi sert ce module : filtres prêts à l'emploi, segments ──
  const rates = new Map((preview?.eligibilityHelpers ?? []).map((h) => [h.name, h.rate]));
  const helperList = helpers.length
    ? `<ul class="uselist">${helpers
        .map(([name, expr]) => {
          const rate = rates.get(name);
          return `<li><div class="use-top"><span${inLang}>${esc(def ? eligibilityText(expr, def, c.ui) : expr)}</span>${rate === undefined ? "" : `<span class="use-share num">${esc(p.helperShare(pct0(rate)))}</span>`}</div><code class="use-expr">${esc(expr)}</code></li>`;
        })
        .join("")}</ul>`
    : `<p class="small ink2">${esc(p.noHelpers)}</p>`;
  const segmentList = segments.length
    ? `<ul class="uselist">${segments.map((s) => `<li><div class="use-top"><span${inLang}>${esc(s.label)}</span></div><span class="small muted"${inLang}>${esc(attrs.find((a) => a.key === s.attribute)?.label ?? s.attribute)} <code>${esc(s.attribute)}</code></span></li>`).join("")}</ul>`
    : `<p class="small ink2">${esc(p.noSegments)}</p>`;
  const purpose = def
    ? `<section class="section" aria-labelledby="s-purpose"><div class="section-head"><h2 id="s-purpose">${esc(p.purpose)}</h2></div><div class="use-grid">
<div class="panel"><h3>${esc(p.helpers)} <span class="muted num">${helpers.length}</span></h3><p class="small ink2 use-hint">${esc(p.helpersHint)}</p>${helperList}</div>
<div class="panel"><h3>${esc(p.segments)} <span class="muted num">${segments.length}</span></h3><p class="small ink2 use-hint">${esc(p.segmentsHint)}</p>${segmentList}</div>
</div></section>`
    : "";

  // ── Attributs : libellé, type, valeurs, marge principale, provenance ──
  const sensitive = new Set(ex?.sensitive ?? []);
  const marginOf = new Map((preview?.margins ?? []).map((m) => [m.attribute, m]));
  const sourceIds = Object.keys(def?.sources ?? {});
  const srcLink = (k: string) => {
    const i = sourceIds.indexOf(k);
    return i < 0 ? `<code>${esc(k)}</code>` : `<a href="#src-${esc(k)}" title="${esc(def!.sources[k]!.org)}">[${i + 1}]</a>`;
  };
  const marginBars = (key: string) => {
    const m = marginOf.get(key);
    if (!m) return "";
    const absent = m.values.find((v) => v.code === "__absent");
    const top = m.values.filter((v) => v.code !== "__absent").sort((a, b) => b.share - a.share).slice(0, 3);
    return `<div class="attr-margin">${top
      .map((v) => {
        const share = v.share;
        // Tranches numériques de l'aperçu (« 8 à 22 ») : tiret, lisible dans les deux langues
        const label = m.type === "number" ? v.label.replace(/^(-?[\d.,]+) à (-?[\d.,]+)/, "$1–$2") : v.label;
        return `<div class="mbar"><span class="l" title="${esc(label)}"${inLang}>${esc(label)}</span><span class="t" aria-hidden="true"><i class="${w(share)}"></i></span><span class="v">${f.pct(share)}</span></div>`;
      })
      .join("")}${absent && absent.share > 0 ? `<p class="small muted">${esc(p.concerns(pct0(1 - absent.share)))}</p>` : ""}</div>`;
  };
  const attrItem = (a: ModuleDef["attributes"][number], i: number) => {
    const values = attributeValues(a, c.ui);
    const shown = values.slice(0, 10);
    const pv = prov[i]!;
    const provHtml =
      pv === "sourced"
        ? `${esc(p.sourcesOf)} ${a.sources.map(srcLink).join(" ")}`
        : pv === "modeled"
          ? `<span class="prov-mod">${esc(p.modeled)}</span> · ${esc(p.sourcesOf)} ${a.sources.map(srcLink).join(" ")}`
          : pv === "assumption"
            ? `<span class="prov-hyp">${esc(p.assumption)}</span>`
            : `<span class="prov-none">${esc(p.noSource)}</span>`;
    return `<li class="attr">
<div class="attr-head"><h3${inLang}>${esc(a.label)}</h3>${sensitive.has(a.key) || a.sensitive ? ` <span class="badge b-sensitive">${esc(t.social.sensitiveAttr)}</span>` : ""}</div>
<p class="attr-meta small"><span class="tag">${esc(p.type[a.type] ?? a.type)}${a.type === "number" && a.unit ? ` · ${esc(a.unit)}` : ""}</span><code>${esc(a.key)}</code><span class="attr-prov">${provHtml}</span></p>
${a.description ? `<p class="small ink2"${inLang}>${esc(a.description)}</p>` : ""}
${shown.length ? `<ul class="pills"${inLang}>${shown.map((v) => `<li>${esc(v)}</li>`).join("")}${values.length > shown.length ? `<li class="more">${esc(p.more(values.length - shown.length))}</li>` : ""}</ul>` : ""}
${marginBars(a.key)}
</li>`;
  };
  const attributes = def
    ? `<ul class="attrs">${attrs.map(attrItem).join("\n")}</ul>`
    : `<p class="small ink2">${esc(p.noParse)}</p><ul class="attr-list">${card.attributes.map((a) => `<li><span>${esc(a.label)}${sensitive.has(a.key) ? ` <span class="badge b-sensitive">${esc(t.social.sensitiveAttr)}</span>` : ""}</span><code>${esc(a.key)}</code></li>`).join("")}</ul>`;
  const attrSection = `<section class="section" aria-labelledby="s-attrs"><div class="section-head"><h2 id="s-attrs">${esc(t.module.attributes)} <span class="muted num">${nAttrs}</span></h2>${preview ? `<p class="small ink2">${esc(t.module.margins)}${esc(t.colon)}${esc(t.module.marginsHint(preview.socle))}</p>` : ""}</div>${attributes}${preview?.margins.length ? "" : emptyState({ icon: "chart", title: t.module.noPreviewTitle, description: t.module.noPreview })}</section>`;

  // ── Sources et hypothèses ──
  const sources = sourceIds.length
    ? `<ol class="sources"${inLang}>${sourceIds
        .map((k) => {
          const s = def!.sources[k]!;
          return `<li id="src-${esc(k)}"><a href="${esc(s.url)}" rel="noopener noreferrer external">${esc(s.org)} — ${esc(s.title)}</a> <span class="muted num">(${s.year})</span>${s.detail ? `<p class="small ink2">${esc(s.detail)}</p>` : ""}</li>`;
        })
        .join("")}</ol>`
    : "";
  const hypoItem = (h: { label: string; j: string | undefined }) => `<li><b>${esc(h.label)}</b>${h.j ? `<span class="ink2">${esc(h.j)}</span>` : ""}</li>`;
  const hypoAttrs = attrs.filter((a) => a.assumption).map((a) => ({ label: a.label, j: a.justification }));
  const hypoTables = Object.entries(def?.tables ?? {})
    .filter(([, tb]) => tb.assumption)
    .map(([k, tb]) => ({ label: tb.label ?? k, j: tb.justification }));
  const nHypo = hypoAttrs.length + hypoTables.length;
  const hypoList = nHypo
    ? `${hypoAttrs.length ? `<ul class="hypos"${inLang}>${hypoAttrs.map(hypoItem).join("")}</ul>` : ""}${hypoTables.length ? `<details class="hypo-tables"><summary>${esc(p.tables(hypoTables.length))}</summary><ul class="hypos"${inLang}>${hypoTables.map(hypoItem).join("")}</ul></details>` : ""}`
    : `<p class="small ink2">${esc(p.noAssumption)}</p>`;
  const sourcesSection = def
    ? `<section class="section" aria-labelledby="s-sources"><div class="section-head"><h2 id="s-sources">${esc(p.sources)} <span class="muted num">${sourceIds.length}</span></h2></div>${sources || `<p class="small ink2">–</p>`}</section>
<section class="section" aria-labelledby="s-hypos"><div class="section-head"><h2 id="s-hypos">${esc(p.assumptions)} <span class="muted num">${nHypo}</span></h2><p class="small ink2">${esc(p.assumptionsHint)}</p></div>${hypoList}</section>`
    : "";

  // ── En bas, replié : versions, historique, notes, détail du score ──
  const versions = `<div class="table-wrap"><table class="table"><thead><tr><th scope="col">${esc(t.module.colVersion)}</th><th scope="col">${esc(t.module.colDate)}</th><th scope="col">${esc(t.module.colStatus)}</th><th scope="col" class="r">${esc(t.module.colQ)}</th><th scope="col">${esc(t.module.colSha)}</th></tr></thead><tbody>${[...card.versions]
    .reverse()
    .map(
      (v) =>
        `<tr><td><a href="/v1/modules/${esc(card.ref)}/${encodeURIComponent(v.version)}"><code>${esc(v.version)}</code></a></td><td class="num">${esc(f.date(v.publishedAt))}</td><td><span class="status ${esc(v.status)}">${esc(t.status[v.status] ?? v.status)}</span></td><td class="r">${v.quality ? v.quality.q.toFixed(0) : "–"}</td><td><code class="muted">${esc(v.sha256.slice(0, 12))}…</code></td></tr>`,
    )
    .join("")}</tbody></table></div>${ex?.signature ? `<p class="deps">${esc(t.social.signed(ex.signature.kid))}</p>` : ""}<p class="small muted">${esc(t.module.license)} ${esc(latest.license)}${card.tags.length ? ` · ${card.tags.map((tag) => `<span class="tag">${esc(tag)}</span>`).join(" ")}` : ""}</p>`;
  const changelog = def?.changelog.length
    ? `<ol class="changelog"${inLang}>${def.changelog.map((e) => `<li><p><code>${esc(e.version)}</code> <span class="muted num">${esc(e.date)}</span></p><ul>${e.changes.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></li>`).join("")}</ol>`
    : "";
  const notes = headerNotes(latest.yaml);
  const alertItem = (a: { level: string; message: string }) => `<li class="alert ${esc(a.level)}"><span class="lvl">${esc(t.module.alertLevel[a.level] ?? a.level)}</span><span>${esc(a.message)}</span></li>`;
  const allAlerts = preview?.alerts ?? [];
  const major = allAlerts.filter((a) => a.level !== "info");
  const infos = allAlerts.filter((a) => a.level === "info");
  const alerts = allAlerts.length
    ? `${major.length ? `<ul class="alerts">${major.map(alertItem).join("")}</ul>` : ""}${infos.length ? `<details class="more-alerts"><summary>${esc(t.module.moreAlerts(infos.length))}</summary><ul class="alerts">${infos.map(alertItem).join("")}</ul></details>` : ""}`
    : `<p class="small ink2">${esc(t.module.noAlert)}</p>`;
  const qDetail = `${qs ? `${qBars(qs, t, f, "lg")}<p class="note small muted">${esc(t.q.weights)} ${esc(t.q.recomputed(f.int(preview?.n ?? 10_000)))}</p>` : ""}<h3 class="fold-h3">${esc(t.module.alerts)}</h3>${alerts}`;
  const fold = (id: string, title: string, inner: string, extra = "") => `<details class="fold" id="${id}"><summary><h2>${esc(title)}</h2>${extra}</summary><div class="fold-body">${inner}</div></details>`;
  const bottom = `<section class="section folds" aria-label="${esc(p.more_)}">
${fold("versions", t.module.versions, versions, `<span class="muted small num">${card.versions.length}</span>`)}
${changelog ? fold("history", p.history, changelog, `<span class="muted small num">${def!.changelog.length}</span>`) : ""}
${fold("quality", p.quality, qDetail, major.length ? `<span class="muted small num">${major.length}</span>` : "")}
${notes.length ? fold("notes", p.notes, `<p class="small muted">${esc(p.notesHint)}</p><div class="notes"${inLang}>${notes.map((n) => `<p>${esc(n)}</p>`).join("")}</div>`) : ""}
</section>`;

  const body = `<nav class="crumbs" aria-label="${esc(t.breadcrumb)}"><a href="/">${esc(t.module.back)}</a><span aria-hidden="true">›</span><span aria-current="page">${esc(card.label)}</span></nav>
<header class="mh">
<h1${inLang}>${esc(card.label)}</h1>
<p class="mh-summary"${inLang}>${esc(summary)}</p>
<p class="badges mh-pills">${pills}</p>
<p class="ref mono">${esc(card.ref)}@${esc(card.latest)}</p>
${rankLine}${deps}${lineage}
</header>
${keyFigures}
${install}
${fullDesc}
${purpose}
${attrSection}
${sourcesSection}
${bottom}`;
  return layout(c, { title: `${card.label} · Personas Hub`, body, current: "modules", path: `/m/${card.ref}`, description: card.description });
}

export function renderNotFound(c: PageCtx): string {
  const { t } = ctxOf(c);
  return layout(c, {
    title: `${t.notFound.title} · Personas Hub`,
    body: `<div class="notfound"><p class="code" aria-hidden="true">404</p><h1>${esc(t.notFound.title)}</h1><p>${esc(t.notFound.text)}</p><a class="btn" href="/">${esc(t.notFound.back)}</a></div>`,
  });
}

/** Page 500 des chemins publics (hors /v1/, qui garde sa réponse JSON). */
export function renderServerError(c: PageCtx): string {
  const { t } = ctxOf(c);
  return layout(c, {
    title: `${t.serverError.title} · Personas Hub`,
    body: `<div class="notfound"><p class="code" aria-hidden="true">500</p><h1>${esc(t.serverError.title)}</h1><p>${esc(t.serverError.text)}</p><a class="btn" href="/">${esc(t.notFound.back)}</a></div>`,
  });
}

// ── Textes légaux (markdown de hub/legal/, servi aussi par GET /v1/legal/:doc) ──

/** Markdown restreint des textes légaux : titres, paragraphes, listes, gras, code, liens sûrs. Tout est échappé. */
export function legalMarkdownToHtml(md: string): string {
  const inline = (s: string) =>
    esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\[([^\]]+)\]\(((?:https:\/\/|\/(?!\/)|mailto:)[^)\s]+)\)/g, '<a href="$2">$1</a>')
      .replace(/(^|[\s(])([\w.+-]+@[\w-]+(?:\.[\w-]+)+)(?=[\s).,;]|$)/g, '$1<a href="mailto:$2">$2</a>');
  const out: string[] = [];
  let para: string[] = [];
  let list: string[] = [];
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
    if (list.length) out.push(`<ul>${list.map((li) => `<li>${inline(li)}</li>`).join("")}</ul>`);
    para = [];
    list = [];
  };
  for (const raw of md.replace(/<!--[\s\S]*?-->/g, "").split("\n")) {
    const line = raw.trimEnd();
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      // Le h1 de la page est le titre du document (retiré avant l'appel) : ## → h2, ### → h3 ; un # restant reste h2.
      const level = Math.max(2, h[1]!.length);
      out.push(`<h${level}>${inline(h[2]!)}</h${level}>`);
    } else if (/^\s*[-*]\s+/.test(line)) {
      if (para.length) flush();
      list.push(line.replace(/^\s*[-*]\s+/, ""));
    } else if (!line.trim()) flush();
    else if (list.length && /^\s+/.test(raw)) list[list.length - 1] += ` ${line.trim()}`;
    else {
      if (list.length) flush();
      para.push(line.trim());
    }
  }
  flush();
  return out.join("\n");
}

export function renderLegal(c: PageCtx, input: { doc: "terms" | "privacy"; lang: "fr" | "en"; version: string; markdown: string }): string {
  const { t } = ctxOf(c);
  const title = /^#\s+(.+)$/m.exec(input.markdown)?.[1] ?? t.legal[input.doc];
  const body = legalMarkdownToHtml(input.markdown.replace(/^#\s+.+$/m, ""));
  const other = input.lang === "fr" ? "en" : "fr";
  const page = `<article class="legal" lang="${input.lang}">
<nav class="crumbs" aria-label="${esc(t.breadcrumb)}" lang="${t.htmlLang}"><a href="/">${esc(t.legal.home)}</a><span aria-hidden="true">›</span><span aria-current="page">${esc(t.legal[input.doc])}</span></nav>
<h1>${esc(title)}</h1>
<p class="small muted" lang="${t.htmlLang}">${esc(t.legal.version(input.version))} · <a href="/${input.doc}?ui=${other}" hreflang="${other}">${esc(endonym(other))}</a> · <a href="/v1/legal/${input.doc}?lang=${input.lang}">Markdown</a></p>
<div class="prose">${body}</div>
</article>`;
  return layout(c, { title: `${t.legal[input.doc]} · Personas Hub`, body: page, path: `/${input.doc}` });
}

// ── Page /device : validation de `personas hub login` (seule page avec JavaScript) ──

export interface DeviceInput {
  code: string;
  /** Supabase Auth (URL publique et clé anonyme publique) ; absent : connexion indisponible. */
  supabase: { url: string; anonKey: string | undefined } | null;
  /** Adresse de retour après connexion (PUBLIC_BASE_URL/device). */
  redirect: string;
  scriptHref: string;
}

export function renderDevice(c: PageCtx, input: DeviceInput): string {
  const { t } = ctxOf(c);
  const d = t.device;
  const code = input.code.toUpperCase().replace(/[^A-Z-]/g, "").slice(0, 16);
  const codeField = `<label class="field" for="user-code"><span>${esc(d.code)}</span><input id="user-code" name="code" type="text" value="${esc(code)}" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" maxlength="16" placeholder="BCDF-GHJK" required aria-describedby="user-code-hint"><small id="user-code-hint">${esc(d.codeHint)}</small></label>`;
  if (!input.supabase) {
    return layout(c, {
      title: `${d.title} · Personas Hub`,
      body: `<div class="device"><h1>${esc(d.title)}</h1><p class="lede">${esc(d.lede)}</p>${emptyState({ icon: "lock", title: d.unavailableTitle, description: d.unavailable })}</div>`,
      path: "/device",
    });
  }
  const s = input.supabase;
  // Libellés d'attente et messages d'erreur traduits, lus par device.js (aucun texte en dur dans le script).
  const messages = { ...d.errors, invite: d.invite, checking: d.checking, approving: d.approving, denying: d.denying, sending: d.sending, signInFirst: d.signInFirst };
  const body = `<div class="device" id="device" data-supabase-url="${esc(s.url)}" data-anon-key="${esc(s.anonKey ?? "")}" data-redirect="${esc(input.redirect)}" data-ui="${c.ui}" data-messages="${esc(JSON.stringify(messages))}">
<h1 id="device-title" tabindex="-1">${esc(d.title)}</h1>
<p class="lede">${esc(d.lede)}</p>
<noscript><div class="notice">${esc(d.noscript)}</div></noscript>
<div class="panel device-panel">
<form id="code-form" class="stack" method="get" action="/device">${codeField}<div class="row"><button id="check" class="btn" type="submit">${esc(d.check)}</button></div></form>
<section id="signin" class="stack" hidden aria-labelledby="signin-title">
<h2 id="signin-title" tabindex="-1">${esc(d.signIn)}</h2>
${s.anonKey ? `<form id="email-form" class="row-form"><label class="sr-only" for="email">${esc(d.email)}</label><input id="email" type="email" autocomplete="email" required placeholder="${esc(d.email)}"><button class="btn" type="submit">${esc(d.sendLink)}</button></form>` : ""}
<button id="github" class="btn ghost" type="button">${esc(d.github)}</button>
<p id="link-sent" class="notice" hidden role="status">${esc(d.linkSent)}</p>
</section>
<section id="session" class="stack" hidden>
<p class="small ink2"><span id="who">${esc(d.signedIn)}</span> <button id="signout" class="linklike" type="button">${esc(d.signOut)}</button></p>
<div id="request" hidden>
<h2>${esc(d.request)}</h2>
<dl class="facts"><dt>${esc(d.client)}</dt><dd id="r-client"></dd><dt>${esc(d.scopes)}</dt><dd id="r-scopes"></dd><dt>${esc(d.expires)}</dt><dd id="r-expires"></dd></dl>
<div class="row"><button id="approve" class="btn" type="button">${esc(d.approve)}</button><button id="deny" class="btn ghost" type="button">${esc(d.deny)}</button></div>
</div>
</section>
<p id="done-ok" class="notice ok" hidden role="status" tabindex="-1">${esc(d.approved)}</p>
<p id="done-no" class="notice" hidden role="status" tabindex="-1">${esc(d.denied)}</p>
<p id="error" class="error-box" role="alert" aria-atomic="true" data-prefix="${esc(d.errorPrefix)}"></p>
</div>
</div>`;
  return layout(c, { title: `${d.title} · Personas Hub`, body, path: "/device", script: input.scriptHref });
}
