/**
 * Langue de l'interface des pages publiques du Hub (français, anglais). Le contenu des modules et des
 * packs (libellés, descriptions) reste dans sa langue d'origine.
 */

export type UiLang = "fr" | "en";
export const UI_LANGS: readonly UiLang[] = ["fr", "en"];
export const UI_COOKIE = "hub_ui";

export const isUiLang = (x: unknown): x is UiLang => x === "fr" || x === "en";

/** Langue préférée d'après Accept-Language (poids q), français ou anglais ; anglais par défaut. */
export function uiFromAcceptLanguage(header: string | undefined): UiLang {
  if (!header) return "en";
  const prefs = header
    .split(",")
    .map((part, i) => {
      const [tag = "", ...params] = part.trim().split(";");
      const q = params.map((p) => /^\s*q=([0-9.]+)\s*$/.exec(p)?.[1]).find((v) => v !== undefined);
      return { lang: tag.trim().toLowerCase().split("-")[0] ?? "", q: q === undefined ? 1 : Number(q), i };
    })
    .filter((p) => p.q > 0 && Number.isFinite(p.q))
    .sort((a, b) => b.q - a.q || a.i - b.i);
  return prefs.map((p) => p.lang).find(isUiLang) ?? "en";
}

const intlOf = (ui: UiLang) => (ui === "fr" ? "fr-FR" : "en-GB");

export function formatters(ui: UiLang) {
  const loc = intlOf(ui);
  const regions = new Intl.DisplayNames([loc], { type: "region" });
  const languages = new Intl.DisplayNames([loc], { type: "language" });
  return {
    int: (x: number) => x.toLocaleString(loc),
    dec2: (x: number) => x.toLocaleString(loc, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    dec1: (x: number) => x.toLocaleString(loc, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
    pct: (x: number) => `${(x * 100).toLocaleString(loc, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}${ui === "fr" ? " %" : "%"}`,
    date: (iso: string) => new Date(iso).toLocaleDateString(loc, { day: "numeric", month: "short", year: "numeric" }),
    region: (code: string) => {
      try {
        return regions.of(code.toUpperCase()) ?? code;
      } catch {
        return code;
      }
    },
    language: (code: string) => {
      try {
        const name = languages.of(code) ?? code;
        return name.charAt(0).toLocaleUpperCase(loc) + name.slice(1);
      } catch {
        return code;
      }
    },
  };
}

/** Nom d'une langue dans cette langue même (« Français », « English ») : libellé des filtres. */
export function endonym(code: string): string {
  try {
    const name = new Intl.DisplayNames([code], { type: "language" }).of(code) ?? code;
    return name.charAt(0).toLocaleUpperCase(code) + name.slice(1);
  } catch {
    return code;
  }
}

const fr = {
  htmlLang: "fr",
  skip: "Aller au contenu",
  brandHome: "Personas Hub, accueil",
  hub: "Hub",
  nav: { label: "Navigation principale", modules: "Modules", packs: "Socles pays", api: "API" },
  uiSwitch: "Langue de l'interface",
  /** Séparateur avant un deux-points (espace insécable en français). */
  colon: "\u00a0: ",
  breadcrumb: "Fil d'Ariane",
  tagline: "Bibliothèque ouverte de modules de personas et de socles pays pour le simulateur Personas.",
  footer: "Modules et packs sous licence CC BY 4.0 sauf mention contraire. Chaque table cite ses sources ou est signalée comme hypothèse.",
  index: {
    title: "Modules",
    lede: "Des attributs tirés statistiquement, sourcés, vérifiés par le Hub sur 10 000 personas virtuelles.",
    kpiModules: "modules",
    kpiPacks: "socles pays",
    kpiLangs: "langues",
    searchLabel: "Rechercher un module",
    searchPlaceholder: "Rechercher (français ou anglais)",
    searchButton: "Rechercher",
    filters: "Filtres",
    modulesTitle: "Modules",
    lang: "Langue",
    allLangs: "Toutes",
    socle: "Socle",
    allSocles: "Tous",
    reset: "Effacer les filtres",
    count: (n: number) => (n === 0 ? "Aucun module" : n === 1 ? "1 module" : `${n} modules`),
    none: (q: string) => (q ? `Aucun module ne correspond à « ${q} » avec ces filtres.` : "Aucun module ne correspond à ces filtres."),
    packsTitle: "Socles pays",
    packsHint: "Les tables de population sur lesquelles les modules se greffent.",
    packsNone: "Aucun socle ne correspond à ces filtres.",
    noneTitle: "Aucun résultat",
    catalogEmptyTitle: "Catalogue vide",
    catalogEmpty: "Aucun module n'est encore publié sur ce Hub.",
    packsNoneTitle: "Aucun socle",
    packsEmpty: "Aucun socle n'est encore publié sur ce Hub.",
  },
  card: {
    attributes: (n: number) => (n === 1 ? "1 attribut" : `${n} attributs`),
    noQ: "Q non calculé",
    versions: (n: number) => (n === 1 ? "1 version" : `${n} versions`),
    extends: (v: string) => `étend ${v}`,
    latest: "Dernière version",
    country: "Pays",
    language: "Langue",
  },
  q: {
    title: "Score de qualité",
    of100: "sur 100",
    sourcing: "Sourçage",
    margins: "Marges",
    alerts: "Alertes",
    docs: "Doc",
    parts: "Décomposition du score Q",
    weights: "Pondération : sourçage 35 %, marges 30 %, alertes 20 %, documentation 15 %.",
    checks: (p: number, t: number) => `${p} contrôle${p > 1 ? "s" : ""} de marge sur ${t} réussi${p > 1 ? "s" : ""}`,
    recomputed: (n: string) => `Recalculé par le Hub sur ${n} personas virtuelles, sans modèle de langue.`,
    none: "Score non calculé.",
    noneYanked: "Score non calculé : module archivé, conservé pour les études passées.",
  },
  module: {
    back: "Modules",
    install: "Installer",
    installHint: "Dans le dossier d'un projet Personas :",
    useHint: (ref: string) => `Puis ajouter ${ref} à target.modules.`,
    yaml: "YAML exact",
    license: "Licence",
    status: "Statut",
    socles: "Socles",
    language: "Langue",
    requires: "Requiert",
    attributes: "Attributs",
    attrLabel: "Attribut",
    attrKey: "Clé",
    margins: "Marges principales",
    marginsHint: (socle: string) => `Tirage virtuel sur le socle ${socle}.`,
    notApplicable: "(non concerné)",
    noPreview: "Aucun aperçu disponible.",
    noPreviewTitle: "Pas d'aperçu",
    alerts: "Alertes de l'aperçu",
    noAlert: "Aucune alerte.",
    moreAlerts: (n: number) => (n === 1 ? "1 information" : `${n} informations`),
    versions: "Versions",
    colVersion: "Version",
    colDate: "Publiée le",
    colStatus: "Statut",
    colQ: "Q",
    colSha: "SHA-256",
    alertLevel: { error: "Erreur", warn: "Attention", warning: "Attention", info: "Info" } as Record<string, string>,
  },
  status: { published: "publiée", verified: "vérifiée", unverified: "non vérifiée", yanked: "retirée de l'index", flagged: "signalée", removed: "supprimée" } as Record<string, string>,
  badges: { official: "officiel", verified: "vérifié", unverified: "non vérifié", sensitive: "sensible", fork: "fork", flagged: "signalé", removed: "supprimé", yanked: "retiré" } as Record<string, string>,
  badgeHints: {
    official: "Module officiel du namespace personas",
    verified: "Version revue par la modération",
    unverified: "Publiée, pas encore revue : à relire avant usage",
    sensitive: "Déclare des attributs sensibles (RGPD, art. 9)",
    fork: "Dérivé d'un autre module",
    flagged: "Signalée, en attente de revue",
  } as Record<string, string>,
  social: {
    stars: (n: number) => (n === 1 ? "1 étoile" : `${n} étoiles`),
    rating: (mean: string, n: number) => `${mean}/5 · ${n} avis`,
    noRating: "pas encore d'avis",
    r: "Classement R",
    rHint: "R combine la qualité (45 %), l'usage (25 %), les étoiles (15 %) et les avis (15 %), +5 % si vérifié.",
    forkOf: "Fork de",
    author: "Auteur",
    deletedAuthor: "auteur supprimé",
    signed: (kid: string) => `Signée (clé ${kid})`,
    sensitiveAttr: "sensible",
  },
  sort: { label: "Tri", r: "Classement R", q: "Score Q", sortedR: "triés par classement R, puis Q", sortedQ: "triés par score Q", preferred: "modules en français d'abord" },
  legal: { terms: "Conditions d'utilisation", privacy: "Confidentialité", version: (v: string) => `Version du ${v}`, home: "Accueil" },
  device: {
    title: "Connecter le terminal",
    lede: "Validez la connexion demandée par personas hub login. Les comptes sont sur invitation : aucune inscription ici.",
    code: "Code affiché par le terminal",
    codeHint: "8 lettres, par exemple BCDF-GHJK.",
    signIn: "Se connecter",
    email: "Adresse e-mail du compte",
    sendLink: "Recevoir un lien de connexion",
    github: "Continuer avec GitHub",
    linkSent: "Lien envoyé : ouvrez l'e-mail sur cet appareil, vous reviendrez ici.",
    signedIn: "Connecté.",
    signOut: "Se déconnecter",
    check: "Vérifier le code",
    request: "Demande",
    client: "Application",
    scopes: "Droits demandés",
    expires: "Expire",
    approve: "Autoriser",
    deny: "Refuser",
    approved: "Connexion autorisée. Vous pouvez revenir au terminal.",
    denied: "Connexion refusée. Le terminal en sera informé.",
    unavailable: "La connexion par navigateur n'est pas configurée sur ce Hub.",
    unavailableTitle: "Connexion indisponible",
    noscript: "Cette page a besoin de JavaScript pour la connexion (Supabase Auth). Le reste du Hub fonctionne sans.",
    errorPrefix: "Erreur :",
    invite: "Compte inconnu : les comptes sont créés sur invitation.",
    checking: "Vérification…",
    approving: "Autorisation…",
    denying: "Refus…",
    sending: "Envoi…",
    signInFirst: "Connectez-vous d'abord : le code sera vérifié ensuite.",
    errors: {
      emptyCode: "Saisissez le code affiché par le terminal.",
      unknownCode: "Code inconnu : vérifiez le code affiché par le terminal.",
      expired: "Ce code a expiré : relancez personas hub login.",
      consumed: "Ce code a déjà été utilisé : relancez personas hub login.",
      denied: "Cette connexion a déjà été refusée.",
      approved: "Cette connexion a déjà été autorisée.",
      alreadyDecided: "Ce code a déjà été traité.",
      session: "Session expirée : reconnectez-vous.",
      forbidden: "Ce compte ne peut pas valider de connexion.",
      rateLimited: "Trop de requêtes : réessayez dans un instant.",
      network: "Le Hub est injoignable : vérifiez la connexion.",
      generic: "Le Hub a rencontré une erreur. Réessayez dans un instant.",
      sendLink: "L'envoi du lien a échoué. Réessayez dans un instant.",
    },
  },
  notFound: { title: "Page introuvable", text: "Cette page n'existe pas, ou ce module n'est plus publié.", back: "Retour aux modules" },
  serverError: { title: "Erreur interne", text: "Le Hub a rencontré une erreur. Réessayez dans un instant ; si elle persiste, signalez-la." },
};

type Dict = typeof fr;

const en: Dict = {
  htmlLang: "en",
  skip: "Skip to content",
  brandHome: "Personas Hub, home",
  hub: "Hub",
  nav: { label: "Main navigation", modules: "Modules", packs: "Country packs", api: "API" },
  uiSwitch: "Interface language",
  colon: ": ",
  breadcrumb: "Breadcrumb",
  tagline: "Open library of persona modules and country packs for the Personas simulator.",
  footer: "Modules and packs are licensed CC BY 4.0 unless stated otherwise. Each table cites its sources or is marked as an assumption.",
  index: {
    title: "Modules",
    lede: "Statistically drawn, sourced attributes, checked by the Hub on 10,000 virtual personas.",
    kpiModules: "modules",
    kpiPacks: "country packs",
    kpiLangs: "languages",
    searchLabel: "Search modules",
    searchPlaceholder: "Search (French or English)",
    searchButton: "Search",
    filters: "Filters",
    modulesTitle: "Modules",
    lang: "Language",
    allLangs: "All",
    socle: "Base",
    allSocles: "All",
    reset: "Clear filters",
    count: (n: number) => (n === 0 ? "No module" : n === 1 ? "1 module" : `${n} modules`),
    none: (q: string) => (q ? `No module matches “${q}” with these filters.` : "No module matches these filters."),
    packsTitle: "Country packs",
    packsHint: "The population tables that modules build on.",
    packsNone: "No pack matches these filters.",
    noneTitle: "No results",
    catalogEmptyTitle: "Empty catalog",
    catalogEmpty: "No module has been published on this Hub yet.",
    packsNoneTitle: "No pack",
    packsEmpty: "No pack has been published on this Hub yet.",
  },
  card: {
    attributes: (n: number) => (n === 1 ? "1 attribute" : `${n} attributes`),
    noQ: "Q not computed",
    versions: (n: number) => (n === 1 ? "1 version" : `${n} versions`),
    extends: (v: string) => `extends ${v}`,
    latest: "Latest version",
    country: "Country",
    language: "Language",
  },
  q: {
    title: "Quality score",
    of100: "out of 100",
    sourcing: "Sourcing",
    margins: "Margins",
    alerts: "Alerts",
    docs: "Docs",
    parts: "Breakdown of the Q score",
    weights: "Weights: sourcing 35%, margins 30%, alerts 20%, documentation 15%.",
    checks: (p: number, t: number) => `${p} of ${t} margin checks passed`,
    recomputed: (n: string) => `Recomputed by the Hub on ${n} virtual personas, without any language model.`,
    none: "Score not computed.",
    noneYanked: "Score not computed: archived module, kept for past studies.",
  },
  module: {
    back: "Modules",
    install: "Install",
    installHint: "In a Personas project folder:",
    useHint: (ref: string) => `Then add ${ref} to target.modules.`,
    yaml: "Exact YAML",
    license: "Licence",
    status: "Status",
    socles: "Bases",
    language: "Language",
    requires: "Requires",
    attributes: "Attributes",
    attrLabel: "Attribute",
    attrKey: "Key",
    margins: "Main margins",
    marginsHint: (socle: string) => `Virtual draw on the ${socle} base.`,
    notApplicable: "(not applicable)",
    noPreview: "No preview available.",
    noPreviewTitle: "No preview",
    alerts: "Preview alerts",
    noAlert: "No alert.",
    moreAlerts: (n: number) => (n === 1 ? "1 note" : `${n} notes`),
    versions: "Versions",
    colVersion: "Version",
    colDate: "Published",
    colStatus: "Status",
    colQ: "Q",
    colSha: "SHA-256",
    alertLevel: { error: "Error", warn: "Warning", warning: "Warning", info: "Info" },
  },
  status: { published: "published", verified: "verified", unverified: "unverified", yanked: "yanked", flagged: "flagged", removed: "removed" },
  badges: { official: "official", verified: "verified", unverified: "unverified", sensitive: "sensitive", fork: "fork", flagged: "flagged", removed: "removed", yanked: "yanked" },
  badgeHints: {
    official: "Official module of the personas namespace",
    verified: "Version reviewed by moderation",
    unverified: "Published, not reviewed yet: read it before use",
    sensitive: "Declares sensitive attributes (GDPR, art. 9)",
    fork: "Derived from another module",
    flagged: "Reported, awaiting review",
  },
  social: {
    stars: (n: number) => (n === 1 ? "1 star" : `${n} stars`),
    rating: (mean: string, n: number) => `${mean}/5 · ${n} review${n === 1 ? "" : "s"}`,
    noRating: "no review yet",
    r: "Rank R",
    rHint: "R combines quality (45%), usage (25%), stars (15%) and reviews (15%), +5% when verified.",
    forkOf: "Fork of",
    author: "Author",
    deletedAuthor: "deleted author",
    signed: (kid: string) => `Signed (key ${kid})`,
    sensitiveAttr: "sensitive",
  },
  sort: { label: "Sort", r: "Rank R", q: "Q score", sortedR: "sorted by rank R, then Q", sortedQ: "sorted by quality score Q", preferred: "English modules first" },
  legal: { terms: "Terms of use", privacy: "Privacy", version: (v: string) => `Version of ${v}`, home: "Home" },
  device: {
    title: "Connect the terminal",
    lede: "Approve the sign-in requested by personas hub login. Accounts are invite-only: no sign-up here.",
    code: "Code shown by the terminal",
    codeHint: "8 letters, for example BCDF-GHJK.",
    signIn: "Sign in",
    email: "Account e-mail address",
    sendLink: "Send me a sign-in link",
    github: "Continue with GitHub",
    linkSent: "Link sent: open the e-mail on this device, you will come back here.",
    signedIn: "Signed in.",
    signOut: "Sign out",
    check: "Check the code",
    request: "Request",
    client: "Application",
    scopes: "Requested rights",
    expires: "Expires",
    approve: "Approve",
    deny: "Deny",
    approved: "Sign-in approved. You can go back to the terminal.",
    denied: "Sign-in denied. The terminal will be told.",
    unavailable: "Browser sign-in is not configured on this Hub.",
    unavailableTitle: "Sign-in unavailable",
    noscript: "This page needs JavaScript to sign in (Supabase Auth). The rest of the Hub works without it.",
    errorPrefix: "Error:",
    invite: "Unknown account: accounts are created by invitation.",
    checking: "Checking…",
    approving: "Approving…",
    denying: "Denying…",
    sending: "Sending…",
    signInFirst: "Sign in first: the code will be checked next.",
    errors: {
      emptyCode: "Enter the code shown by the terminal.",
      unknownCode: "Unknown code: check the code shown by the terminal.",
      expired: "This code has expired: run personas hub login again.",
      consumed: "This code has already been used: run personas hub login again.",
      denied: "This sign-in has already been denied.",
      approved: "This sign-in has already been approved.",
      alreadyDecided: "This code has already been handled.",
      session: "Session expired: please sign in again.",
      forbidden: "This account cannot approve a sign-in.",
      rateLimited: "Too many requests: try again in a moment.",
      network: "The Hub cannot be reached: check your connection.",
      generic: "The Hub ran into an error. Try again in a moment.",
      sendLink: "Sending the link failed. Try again in a moment.",
    },
  },
  notFound: { title: "Page not found", text: "This page does not exist, or this module is no longer published.", back: "Back to the modules" },
  serverError: { title: "Internal error", text: "The Hub ran into an error. Try again in a moment; if it persists, please report it." },
};

export const DICTS: Record<UiLang, Dict> = { fr, en };
export type HubDict = Dict;
