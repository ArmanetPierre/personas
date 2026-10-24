import type { CatalogModule, CatalogResponse, QualityScore } from "../../src/hub/contract";
import type { moduleDeps, moduleVersions } from "../db/schema";
import { DICTS, endonym, formatters, type HubDict, type UiLang } from "./i18n";
import type { ModuleRanking, RankedHit } from "./ranking";
import type { SocleLocales } from "./repo";

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

function layout(c: PageCtx, page: { title: string; body: string; current?: "modules" | "packs"; path?: string; description?: string; script?: string }): string {
  const { t } = ctxOf(c);
  const base = c.baseUrl?.replace(/\/$/, "");
  const canonical = base && page.path !== undefined ? `<link rel="canonical" href="${esc(base + page.path)}">` : "";
  const navLink = (href: string, label: string, key: "modules" | "packs") => `<a href="${esc(href)}"${page.current === key ? ' aria-current="page"' : ""}>${esc(label)}</a>`;
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
<nav class="main-nav" aria-label="${esc(t.nav.label)}">${navLink("/", t.nav.modules, "modules")}${navLink("/?view=packs#packs", t.nav.packs, "packs")}<a href="/v1/catalog">${esc(t.nav.api)}</a></nav>
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
  const { card, latest } = input;
  const qs = latest.quality;
  const langs = [...new Set(card.appliesTo.map((s) => input.locales.get(s)).filter((x): x is string => !!x))];
  const pull = `personas hub pull ${card.ref}@${card.latest}`;
  const yamlHref = `/v1/modules/${card.ref}/${encodeURIComponent(card.latest)}`;
  const r = input.ranking;
  const ex = input.extras;
  const forkedFrom = r?.forkedFrom ?? ex?.forkedFrom ?? null;
  const lineage = [
    forkedFrom ? `<p class="deps">${esc(t.social.forkOf)} <a href="/m/${esc(forkedFrom.ref)}"><code>${esc(forkedFrom.ref)}@${esc(forkedFrom.version)}</code></a></p>` : "",
    ex?.author ? `<p class="deps">${esc(t.social.author)}${esc(t.colon)}${esc(ex.authorDeleted ? t.social.deletedAuthor : ex.author)}</p>` : "",
    ex?.signature ? `<p class="deps">${esc(t.social.signed(ex.signature.kid))}</p>` : "",
  ].join("");
  const badgeRow = badgesHtml(r?.badges ?? ex?.badges ?? [], latest.status, t);
  const rankLine = r
    ? `<div class="rank"><span class="rank-r" title="${esc(t.social.rHint)}">${esc(t.social.r)} <b class="num">${f.dec2(r.r)}</b></span>${socialHtml(r, t, f)}</div>`
    : "";

  const qPanel = `<aside class="panel qpanel" aria-labelledby="q-title">
<h2 id="q-title" class="sr-only">${esc(t.q.title)}</h2>
${rankLine}
${qs ? `<div class="qtop">${qBig(qs, t)}<span class="small ink2">${esc(t.q.title)}${latest.preview ? `<br><span class="muted">${esc(t.q.checks(latest.preview.checks.passed, latest.preview.checks.total))}</span>` : ""}</span></div>
${qBars(qs, t, f, "lg")}
<p class="note">${esc(t.q.weights)} ${esc(t.q.recomputed(f.int(latest.preview?.n ?? 10_000)))}</p>` : `<p class="small ink2">${esc(latest.status === "yanked" ? t.q.noneYanked : t.q.none)}</p>`}
<div class="install"><h2>${esc(t.module.install)}</h2><p class="small ink2">${esc(t.module.installHint)}</p><pre class="cmd"><code>${esc(pull)}</code></pre><p class="small muted">${esc(t.module.useHint(card.ref))} <a href="${esc(yamlHref)}">${esc(t.module.yaml)}</a></p></div>
</aside>`;

  const margins = latest.preview?.margins.length
    ? `<div class="margins">${latest.preview.margins
        .slice(0, 8)
        .map((m) => {
          const values = [...m.values].sort((a, b) => (a.code === "__absent" ? 1 : b.code === "__absent" ? -1 : b.share - a.share)).slice(0, 6);
          return `<div class="margin"><h3>${esc(m.label)} <code>${esc(m.attribute)}</code></h3>${values
            .map((v) => {
              const na = v.code === "__absent";
              const label = na ? t.module.notApplicable : v.label;
              return `<div class="mbar${na ? " na" : ""}"><span class="l" title="${esc(label)}">${esc(label)}</span><span class="t" aria-hidden="true"><i class="${w(v.share)}"></i></span><span class="v">${f.pct(v.share)}</span></div>`;
            })
            .join("")}</div>`;
        })
        .join("\n")}</div>`
    : emptyState({ icon: "chart", title: t.module.noPreviewTitle, description: t.module.noPreview });

  // Divulgation progressive : erreurs et avertissements visibles, informations repliées.
  const alertItem = (a: { level: string; message: string }) => `<li class="alert ${esc(a.level)}"><span class="lvl">${esc(t.module.alertLevel[a.level] ?? a.level)}</span><span>${esc(a.message)}</span></li>`;
  const allAlerts = latest.preview?.alerts ?? [];
  const major = allAlerts.filter((a) => a.level !== "info");
  const infos = allAlerts.filter((a) => a.level === "info");
  const alerts = allAlerts.length
    ? `${major.length ? `<ul class="alerts">${major.map(alertItem).join("")}</ul>` : ""}${infos.length ? `<details class="more-alerts"${major.length ? "" : " open"}><summary>${esc(t.module.moreAlerts(infos.length))}</summary><ul class="alerts">${infos.map(alertItem).join("")}</ul></details>` : ""}`
    : `<p class="small ink2">${esc(t.module.noAlert)}</p>`;

  const versions = `<div class="table-wrap"><table class="table"><thead><tr><th scope="col">${esc(t.module.colVersion)}</th><th scope="col">${esc(t.module.colDate)}</th><th scope="col">${esc(t.module.colStatus)}</th><th scope="col" class="r">${esc(t.module.colQ)}</th><th scope="col">${esc(t.module.colSha)}</th></tr></thead><tbody>${[...card.versions]
    .reverse()
    .map(
      (v) =>
        `<tr><td><a href="/v1/modules/${esc(card.ref)}/${encodeURIComponent(v.version)}"><code>${esc(v.version)}</code></a></td><td class="num">${esc(f.date(v.publishedAt))}</td><td><span class="status ${esc(v.status)}">${esc(t.status[v.status] ?? v.status)}</span></td><td class="r">${v.quality ? v.quality.q.toFixed(0) : "–"}</td><td><code class="muted">${esc(v.sha256.slice(0, 12))}…</code></td></tr>`,
    )
    .join("")}</tbody></table></div>`;

  const sensitive = new Set(input.extras?.sensitive ?? []);
  const attributes = `<ul class="attr-list">${card.attributes.map((a) => `<li><span>${esc(a.label)}${sensitive.has(a.key) ? ` <span class="badge b-sensitive">${esc(t.social.sensitiveAttr)}</span>` : ""}</span><code>${esc(a.key)}</code></li>`).join("")}</ul>`;
  const deps = input.deps.length ? `<p class="deps">${esc(t.module.requires)}${esc(t.colon)}${input.deps.map((d) => `<a href="/m/${esc(d.ref)}"><code>${esc(d.ref)}@${esc(d.version)}</code></a>`).join(", ")}</p>` : "";
  const contentLang = langs[0];

  const body = `<nav class="crumbs" aria-label="${esc(t.breadcrumb)}"><a href="/">${esc(t.module.back)}</a><span aria-hidden="true">›</span><span aria-current="page">${esc(card.label)}</span></nav>
<div class="module-head">
<div${contentLang ? ` lang="${esc(contentLang)}"` : ""}>
<h1>${esc(card.label)}</h1>
<p class="ref mono">${esc(card.ref)}@${esc(card.latest)}</p>
<p class="lede">${esc(card.description)}</p>
${badgeRow ? `<p class="badges" lang="${t.htmlLang}">${badgeRow}</p>` : ""}
<p class="meta" lang="${t.htmlLang}">${card.appliesTo.map((s) => `<span class="tag">${esc(t.index.socle)} ${esc(s)} · ${esc(socleName(s, input.packs, f))}</span>`).join("")}${langs.map((l) => `<span class="tag lang" lang="${esc(l)}">${esc(endonym(l))}</span>`).join("")}<span class="tag">${esc(t.module.license)} ${esc(latest.license)}</span>${badgeRow ? "" : `<span class="tag"><span class="status ${esc(latest.status)}">${esc(t.status[latest.status] ?? latest.status)}</span></span>`}${card.tags.filter((tag) => !(badgeRow && tag === "official")).map((tag) => `<span class="tag">${esc(tag)}</span>`).join("")}<span class="tag plain">${esc(t.card.attributes(card.attributes.length))}</span></p>
${deps}${lineage}
</div>
${qPanel}
</div>
<section class="section" aria-labelledby="s-margins"><div class="section-head"><h2 id="s-margins">${esc(t.module.margins)}</h2>${latest.preview ? `<p class="small ink2">${esc(t.module.marginsHint(latest.preview.socle))}</p>` : ""}</div>${margins}</section>
<section class="section" aria-labelledby="s-attrs"><div class="section-head"><h2 id="s-attrs">${esc(t.module.attributes)} <span class="muted num">${card.attributes.length}</span></h2></div>${attributes}</section>
<section class="section" aria-labelledby="s-alerts"><div class="section-head"><h2 id="s-alerts">${esc(t.module.alerts)}</h2></div>${alerts}</section>
<section class="section" aria-labelledby="s-versions"><div class="section-head"><h2 id="s-versions">${esc(t.module.versions)}</h2></div>${versions}</section>`;
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
