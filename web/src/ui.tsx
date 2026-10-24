import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation } from "wouter";
import { packInfos, type Meta } from "./api";
import { commonDict } from "./i18n/common";
import { getLocale, intlLocale, LOCALES, tr, useDict, useLocale, type Locale } from "./i18n";
import { hostedDict } from "./i18n/hosted";
import { usePlatform, useSession } from "./platform";

const isFr = () => getLocale() === "fr";

/** Nombre selon la langue (« 1 234,5 » / « 1,234.5 »). */
export const num = (x: number, opts: number | Intl.NumberFormatOptions = { maximumFractionDigits: 2 }) =>
  x.toLocaleString(intlLocale(), typeof opts === "number" ? { maximumFractionDigits: opts } : opts);

export const pct = (x: number | null | undefined, digits = 0) =>
  x === null || x === undefined || Number.isNaN(x)
    ? "—"
    : isFr()
      ? `${(x * 100).toLocaleString("fr-FR", { maximumFractionDigits: digits, minimumFractionDigits: digits })}\u202f%`
      : `${(x * 100).toLocaleString(intlLocale(), { maximumFractionDigits: digits, minimumFractionDigits: digits })}%`;

/** Montant au format Intl de la langue (anglais : « €9.99 », « SGD 150 », « US$5 »). */
/** Préfixes anglais des devises, alignés sur l'API (src/studies/price-model-en.ts) : « S$24 », « US$9.99 ». */
const EN_PREFIX: Record<string, string> = { USD: "US$", SGD: "S$", GBP: "£" };

function intlMoney(x: number, currency: string): string {
  const prefix = EN_PREFIX[currency];
  if (prefix) return `${prefix}${x.toLocaleString(intlLocale(), { minimumFractionDigits: Math.round(x * 100) % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
  try {
    return new Intl.NumberFormat(intlLocale(), { style: "currency", currency, minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(x);
  } catch {
    return `${x.toLocaleString(intlLocale(), { maximumFractionDigits: 2 })}\u00a0${currency}`;
  }
}

export const eur = (x: number | null | undefined) =>
  x === null || x === undefined ? "—" : isFr() ? `${x.toLocaleString("fr-FR", { maximumFractionDigits: 2 })}\u00a0€` : intlMoney(x, "EUR");

const CURRENCY_SYMBOLS: Record<string, string> = { EUR: "€", USD: "$", GBP: "£" };

/** Montant dans une devise, à la française : « 9,99 $ », « 150 SGD », « 5 € » ; en anglais : format Intl. */
export const money = (x: number | null | undefined, currency = "EUR") =>
  currency === "EUR"
    ? eur(x)
    : x === null || x === undefined
      ? "—"
      : isFr()
        ? `${x.toLocaleString("fr-FR", { maximumFractionDigits: 2 })}\u00a0${CURRENCY_SYMBOLS[currency] ?? currency}`
        : intlMoney(x, currency);

export const int = (x: number) => x.toLocaleString(intlLocale());

/** Date et heure courtes selon la langue (« 16 oct., 14:25 » / « 16 Oct, 14:25 »). */
export const dateFr = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString(intlLocale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";
export const dateTime = dateFr;

/** Libellés de statut en français (historique) ; préférer `statusLabel`. */
export const STATUS_LABELS: Record<string, string> = commonDict.fr.status;
export const statusLabel = (status: string) => tr(commonDict).status[status] ?? status;

export function Status({ status }: { status: string }) {
  return <span className={`status ${status}`}>{statusLabel(status)}</span>;
}

/** Libellé court d'un pack de personas. */
export function packShort(v: string): string {
  const p = packInfos.get(v);
  return p?.shortLabel ?? p?.label ?? v;
}

/** Ordre d'affichage des dimensions : celles des modules (rang de comparaison d'abord), puis celles du socle. */
export function dimensionOrder(meta: Meta | null, socle: string[]): string[] {
  const mods = (meta?.dimensions ?? []).filter((d) => d.module);
  const ranked = [...mods.filter((d) => d.compare !== undefined).sort((a, b) => a.compare! - b.compare!), ...mods.filter((d) => d.compare === undefined)];
  return [...ranked.map((d) => d.id), ...socle];
}

const NAV = [
  { href: "/", key: "projects", match: (p: string) => p === "/" || p.startsWith("/projets") || p.startsWith("/etudes") },
  { href: "/comparer", key: "compare", match: (p: string) => p.startsWith("/comparer") },
  { href: "/personas", key: "personas", match: (p: string) => p.startsWith("/personas") },
  { href: "/modules", key: "modules", match: (p: string) => p.startsWith("/modules") || p.startsWith("/brouillons") },
] as const;

type Theme = "auto" | "light" | "dark";
function readTheme(): Theme {
  try {
    const t = localStorage.getItem("personas-theme");
    return t === "light" || t === "dark" ? t : "auto";
  } catch {
    return "auto";
  }
}

function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "auto") delete root.dataset.theme;
    else root.dataset.theme = theme;
    try {
      if (theme === "auto") localStorage.removeItem("personas-theme");
      else localStorage.setItem("personas-theme", theme);
    } catch {
      // stockage indisponible : le choix vaut pour la session
    }
  }, [theme]);
  const t = useDict(commonDict).theme;
  return (
    <SegmentedControl
      size="sm"
      label={t.label}
      value={theme}
      onChange={setTheme}
      options={[
        { id: "auto", label: t.auto },
        { id: "light", label: t.light },
        { id: "dark", label: t.dark },
      ]}
    />
  );
}

/** Sélecteur de langue (le libellé de chaque option est dans sa propre langue). */
function LocaleSwitch() {
  const { locale, setLocale } = useLocale();
  return (
    <SegmentedControl<Locale>
      size="sm"
      label={locale === "fr" ? "Langue" : "Language"}
      value={locale}
      onChange={setLocale}
      options={LOCALES.map((l) => ({ id: l, label: l.toUpperCase(), lang: l, title: l === "fr" ? "Français" : "English" }))}
    />
  );
}

function Brand() {
  const t = useDict(commonDict);
  return (
    <Link href="/" className="brand" aria-label={t.brandHome}>
      <span className="brand-mark" aria-hidden="true">
        <i className="on" />
        <i />
        <i />
        <i />
        <i />
        <i />
      </span>
      <span className="brand-name">Personas</span>
    </Link>
  );
}

/** Service hébergé, sans session : marque, réglages d'affichage et page centrée (connexion, textes légaux). */
function BareLayout({ children }: { children: ReactNode }) {
  return (
    <div className="auth-shell">
      <header className="auth-head">
        <Brand />
        <div className="auth-switches">
          <ThemeSwitch />
          <LocaleSwitch />
        </div>
      </header>
      <main>
        <div className="page auth-page">{children}</div>
      </main>
    </div>
  );
}

/** Service hébergé : bandeau tant qu'aucune clé IA n'est enregistrée. */
function NoKeyBanner() {
  const t = useDict(hostedDict).banner;
  return (
    <div className="banner-block row key-banner" role="status" style={{ marginTop: 0, marginBottom: 24 }}>
      <span>{t.noKey}</span>
      <Link className="btn small" href="/compte/moteur">
        {t.add}
      </Link>
    </div>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const [loc] = useLocation();
  const t = useDict(commonDict);
  const th = useDict(hostedDict).nav;
  const { hosted } = usePlatform();
  const session = useSession();
  if (hosted && session.state.status !== "signed") return <BareLayout>{session.state.status === "loading" ? null : children}</BareLayout>;
  return (
    <div className="shell">
      <aside className="rail">
        <Brand />
        <nav aria-label={t.nav.main}>
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} aria-current={n.match(loc) ? "page" : undefined}>
              {t.nav[n.key]}
            </Link>
          ))}
        </nav>
        <div className={hosted ? "rail-foot hosted-foot" : "rail-foot"}>
          {hosted ? (
            <>
              <Link href="/compte" className="small" aria-current={loc === "/compte" ? "page" : undefined}>
                {th.account}
              </Link>
              <Link href="/compte/moteur" className="small" aria-current={loc === "/compte/moteur" ? "page" : undefined}>
                {th.engine}
              </Link>
              <button type="button" className="linklike small rail-signout" onClick={() => void session.signOut()}>
                {th.signOut}
              </button>
            </>
          ) : (
            <Link href="/configurer" className="small" aria-current={loc === "/configurer" ? "page" : undefined}>
              {t.nav.setup}
            </Link>
          )}
          <ThemeSwitch />
          <LocaleSwitch />
        </div>
      </aside>
      <main>
        <div className="page">
          {hosted && session.engine === null && loc !== "/compte/moteur" && <NoKeyBanner />}
          {children}
        </div>
      </main>
    </div>
  );
}

/**
 * Largeurs de colonnes communes d'un tableau `.table.fixed` : nombre (px), chaîne CSS, ou null pour la
 * colonne qui prend la place restante. Toutes les lignes (et tous les groupes) partagent ainsi la même grille.
 */
export function Cols({ widths }: { widths: Array<number | string | null> }) {
  return (
    <colgroup>
      {widths.map((w, i) => (
        <col key={i} style={w === null ? undefined : { width: typeof w === "number" ? `${w}px` : w }} />
      ))}
    </colgroup>
  );
}

export function Loading({ what }: { what?: string }) {
  const t = useDict(commonDict);
  return <p className="muted">{what ?? t.loading}…</p>;
}

export function ErrorBox({ error }: { error: Error | null | undefined }) {
  if (!error) return null;
  return <div className="error-box" role="alert">{error.message}</div>;
}

// ─── Infobulle ────────────────────────────────────────────────────────────────

export interface TipState {
  x: number;
  y: number;
  content: ReactNode;
}

/** Bord gauche de l'infobulle : à droite du pointeur, sans sortir de la fenêtre (8 px de marge, largeur max 300 px). */
function tipLeft(x: number) {
  const w = Math.min(300, window.innerWidth - 16);
  return Math.max(8, Math.min(x + 14, window.innerWidth - w - 8));
}

export function useTooltip() {
  const [tip, setTip] = useState<TipState | null>(null);
  const node = tip
    ? createPortal(
        <div className="tooltip" role="status" style={{ left: tipLeft(tip.x), top: tip.y + 14 }}>
          {tip.content}
        </div>,
        document.body,
      )
    : null;
  return {
    node,
    show: (e: { clientX: number; clientY: number }, content: ReactNode) => setTip({ x: e.clientX, y: e.clientY, content }),
    /** Pour le clavier : place l'infobulle sous l'élément ciblé. */
    showAt: (el: Element, content: ReactNode) => {
      const r = el.getBoundingClientRect();
      setTip({ x: r.left, y: r.bottom, content });
    },
    hide: () => setTip(null),
  };
}

/**
 * Clavier d'un groupe de boutons radio (role="radiogroup") : tabindex itinérant (seule l'option choisie
 * est tabbable), flèches, Home/End ; la flèche déplace le focus et sélectionne. Partagé par
 * `SegmentedControl` et les radiogroups qui n'en ont pas la forme.
 */
export function useRovingRadio(count: number, index: number, select: (i: number) => void) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const n = Math.max(1, count);
  const go = (i: number) => {
    buttons.current[i]?.focus();
    select(i);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    let next: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (i + 1) % n;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (i - 1 + n) % n;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    if (next === null) return;
    e.preventDefault();
    go(next);
  };
  /** Props d'un bouton radio du groupe. */
  return (i: number) => ({
    ref: (el: HTMLButtonElement | null) => {
      buttons.current[i] = el;
    },
    type: "button" as const,
    role: "radio" as const,
    "aria-checked": i === index,
    tabIndex: i === index ? 0 : -1,
    onClick: () => go(i),
    onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => onKeyDown(e, i),
  });
}

export interface SegOption<T extends string> {
  id: T;
  label: string;
  /** Libellé court affiché à la place de `label` sur petit écran (≤ 640 px). */
  shortLabel?: string;
  /** Langue du libellé (sélecteur de langue). */
  lang?: string;
  title?: string;
}

/**
 * Contrôle segmenté : radiogroup accessible (voir `useRovingRadio`), curseur qui glisse en CSS
 * (désactivé sous prefers-reduced-motion). `size="sm"` : variante compacte pleine largeur (barre latérale).
 * Inspiré de 21st.dev (ddoemonn).
 */
export function SegmentedControl<T extends string>({ value, options, onChange, label, size }: { value: T; options: Array<SegOption<T>>; onChange: (v: T) => void; label: string; size?: "sm" }) {
  const n = Math.max(1, options.length);
  const found = options.findIndex((o) => o.id === value);
  const index = found < 0 ? 0 : found;
  const radio = useRovingRadio(options.length, index, (i) => {
    const o = options[i];
    if (o && o.id !== value) onChange(o.id);
  });
  return (
    <div className={size === "sm" ? "segc sm" : "segc"} role="radiogroup" aria-label={label} style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}>
      <span className="segc-thumb" aria-hidden="true" style={{ width: `calc((100% - 6px) / ${n})`, transform: `translateX(${index * 100}%)` }} />
      {options.map((o, i) => (
        <button key={o.id} {...radio(i)} lang={o.lang} title={o.title}>
          {o.shortLabel ? (
            <>
              <span className="segc-long">{o.label}</span>
              <span className="segc-short">{o.shortLabel}</span>
            </>
          ) : (
            o.label
          )}
        </button>
      ))}
    </div>
  );
}

/** Icône par défaut de `EmptyState` : boîte vide, trait 1,5 comme le reste de l'app. */
const EmptyBoxIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d="M3 13h5l1.5 2.5h5L16 13h5" />
    <path d="M5.5 5h13L21 13v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5z" />
  </svg>
);

/** Icône de comparaison : deux colonnes de barres côte à côte. */
export const CompareIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <rect x="3.5" y="4" width="7" height="16" rx="1.5" />
    <rect x="13.5" y="4" width="7" height="16" rx="1.5" />
    <path d="M6 15v2M8 12v5M16 10v7M18 13v4" />
  </svg>
);

const svgProps = { width: 22, height: 22, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, focusable: false } as const;

/** Icône de projet : dossier. */
export const FolderIcon = () => (
  <svg {...svgProps}>
    <path d="M3.5 7.5V18a1 1 0 0 0 1 1h15a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1h-8L9.5 5.5h-5a1 1 0 0 0-1 1z" />
  </svg>
);

/** Icône de module : pièce de puzzle stylisée (bloc qu'on ajoute au socle). */
export const ModuleIcon = () => (
  <svg {...svgProps}>
    <rect x="4" y="4" width="7" height="7" rx="1.5" />
    <rect x="13" y="4" width="7" height="7" rx="1.5" />
    <rect x="4" y="13" width="7" height="7" rx="1.5" />
    <path d="M16.5 14v5M14 16.5h5" />
  </svg>
);

/** Icône d'étude : graphique en barres sur un axe. */
export const ChartIcon = () => (
  <svg {...svgProps}>
    <path d="M4 4v16h16" />
    <path d="M8 16v-4M12 16V8M16 16v-6" />
  </svg>
);

/** Icône de personas : deux silhouettes. */
export const PeopleIcon = () => (
  <svg {...svgProps}>
    <circle cx="9" cy="8.5" r="3" />
    <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
    <path d="M15.5 5.8a3 3 0 0 1 0 5.4M17.5 14.2A5.5 5.5 0 0 1 20.5 19" />
  </svg>
);

/** Icône de cible : cercles concentriques. */
export const TargetIcon = () => (
  <svg {...svgProps}>
    <circle cx="12" cy="12" r="8" />
    <circle cx="12" cy="12" r="4.5" />
    <circle cx="12" cy="12" r="1" />
  </svg>
);

/** État vide : surface atténuée, pastille d'icône, titre, description, action facultative. Inspiré de 21st.dev (uiable). */
export function EmptyState({ icon, title, description, action, style }: { icon?: ReactNode; title: ReactNode; description?: ReactNode; action?: ReactNode; style?: CSSProperties }) {
  return (
    <div className="empty-state" style={style}>
      <span className="empty-state-icon">{icon ?? <EmptyBoxIcon />}</span>
      <p className="empty-state-title">{title}</p>
      {description && <p className="empty-state-desc">{description}</p>}
      {action && <div className="empty-state-action">{action}</div>}
    </div>
  );
}

/* ─── Barre de filtres ─── */

export interface FilterValueDef {
  id: string;
  label: string;
  /** Effectif affiché en fin de ligne. */
  count?: number;
}

export interface FilterFieldDef {
  id: string;
  label: string;
  /** Intitulé du groupe dans la liste des champs (ex. module d'origine). */
  group?: string;
  values: FilterValueDef[];
}

export interface FilterToolbarProps {
  fields: FilterFieldDef[];
  /** Filtres actifs : identifiant du champ → identifiant de la valeur (une valeur par champ). */
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  /** Nom du groupe pour les lecteurs d'écran. */
  label: string;
  addLabel: string;
  clearAllLabel: string;
  searchPlaceholder: string;
  noMatch: string;
  backLabel: string;
  removeLabel: (field: string, value: string) => string;
  /** Libellé accessible d'une pastille (qui rouvre ses valeurs). Par défaut « champ séparateur valeur ». */
  editLabel?: (field: string, value: string) => string;
  /** Annonce polie du nombre de filtres actifs. */
  activeLabel?: (n: number) => string;
  /** Séparateur entre le champ et la valeur dans une pastille (ex. « : » en français). */
  separator?: string;
  formatCount?: (n: number) => string;
}

type FtbOption =
  | { kind: "field"; field: FilterFieldDef; group?: string }
  | { kind: "value"; field: FilterFieldDef; value: FilterValueDef; nested?: boolean };

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

const CloseIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true" focusable="false">
    <path d="M3 3l6 6M9 3l-6 6" />
  </svg>
);
const PlusIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true" focusable="false">
    <path d="M6 2v8M2 6h8" />
  </svg>
);
const ChevronIcon = ({ dir }: { dir: "left" | "right" }) => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d={dir === "left" ? "M7.5 2.5L4 6l3.5 3.5" : "M4.5 2.5L8 6l-3.5 3.5"} />
  </svg>
);
const CheckIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d="M2.5 6.5l2.3 2.3L9.5 3.5" />
  </svg>
);

/**
 * Barre de filtres : pastilles « champ : valeur » retirables, « Tout effacer », et menu « + Filtre » en deux
 * étapes (champ, puis valeur avec effectifs). Le champ de recherche du panneau est une combobox
 * (aria-activedescendant) : flèches, Entrée, Échap, Retour arrière sur recherche vide pour revenir aux champs.
 * Adapté du « Filter Toolbar » de 21st.dev (kuratlielia), sans motion ni lucide : animations CSS coupées
 * sous prefers-reduced-motion, une seule valeur par champ.
 */
export function FilterToolbar(props: FilterToolbarProps) {
  const { fields, value, onChange, label, addLabel, clearAllLabel, searchPlaceholder, noMatch, backLabel, removeLabel } = props;
  const sep = props.separator ?? ": ";
  const fmt = props.formatCount ?? ((n: number) => String(n));
  const uid = useId();
  const panelId = `${uid}-panel`;
  const listId = `${uid}-list`;
  const rootRef = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const chipRefs = useRef(new Map<string, HTMLButtonElement>());
  const opener = useRef<HTMLElement | null>(null);
  const pendingFocus = useRef<string | null>(null);
  // null : fermé ; "" : étape 1 (champs) ; sinon : étape 2, valeurs du champ
  const [step, setStep] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [panelLeft, setPanelLeft] = useState(0);
  const open = step !== null;

  const byId = new Map(fields.map((f) => [f.id, f]));
  const chips = Object.entries(value)
    .filter(([, v]) => v)
    .map(([fid, vid]) => {
      const field = byId.get(fid);
      return { fid, vid, fieldLabel: field?.label ?? fid, valueLabel: field?.values.find((v) => v.id === vid)?.label ?? vid };
    });

  // Options de l'étape courante (la recherche porte sur le champ ET sur ses valeurs)
  const q = fold(query.trim());
  const options: FtbOption[] = [];
  if (step === "") {
    for (const field of fields) {
      const fieldHit = !q || fold(field.label).includes(q);
      const valueHits = q && !fieldHit ? field.values.filter((v) => fold(v.label).includes(q)).slice(0, 6) : [];
      if (!fieldHit && valueHits.length === 0) continue;
      options.push({ kind: "field", field, group: field.group });
      for (const v of valueHits) options.push({ kind: "value", field, value: v, nested: true });
    }
  } else if (step) {
    const field = byId.get(step);
    for (const v of field?.values ?? []) if (!q || fold(v.label).includes(q)) options.push({ kind: "value", field: field!, value: v });
  }
  const current = Math.min(active, Math.max(0, options.length - 1));
  const optionId = (i: number) => `${uid}-opt-${i}`;

  const close = (restore = true) => {
    setStep(null);
    setQuery("");
    if (restore) (opener.current ?? addRef.current)?.focus();
  };
  const goStep = (s: string) => {
    setStep(s);
    setQuery("");
    // à l'étape 2, on se place sur la valeur déjà choisie s'il y en a une
    const field = byId.get(s);
    const idx = field ? field.values.findIndex((v) => v.id === value[s]) : -1;
    setActive(Math.max(0, idx));
  };
  const openAt = (s: string, from: HTMLElement | null) => {
    opener.current = from;
    goStep(s);
  };
  const choose = (o: FtbOption) => {
    if (o.kind === "field") return goStep(o.field.id);
    onChange({ ...value, [o.field.id]: o.value.id });
    close();
  };
  const remove = (fid: string) => {
    const i = chips.findIndex((c) => c.fid === fid);
    pendingFocus.current = chips[i + 1]?.fid ?? "__add";
    const next = { ...value };
    delete next[fid];
    onChange(next);
  };

  // Focus après retrait : pastille suivante, sinon « + Filtre »
  useEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    (target === "__add" ? addRef.current : chipRefs.current.get(target) ?? addRef.current)?.focus();
  });

  // Focus sur la recherche à l'ouverture et à chaque changement d'étape
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open, step]);

  // Clic extérieur
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  });

  // Panneau aligné sur son déclencheur, sans dépasser la barre
  useLayoutEffect(() => {
    if (!open) return;
    const root = rootRef.current;
    const panel = panelRef.current;
    const anchor = opener.current ?? addRef.current;
    if (!root || !panel || !anchor) return;
    const r = root.getBoundingClientRect();
    const left = anchor.getBoundingClientRect().left - r.left;
    setPanelLeft(Math.max(0, Math.min(left, r.width - panel.offsetWidth)));
  }, [open, step]);

  // Option active visible
  useEffect(() => {
    if (open) document.getElementById(optionId(current))?.scrollIntoView({ block: "nearest" });
  });

  const onInputKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const n = options.length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (n) setActive((current + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
    } else if (e.key === "Home" && !query) {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End" && !query) {
      e.preventDefault();
      setActive(Math.max(0, n - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const o = options[current];
      if (o) choose(o);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Backspace" && !query && step) {
      e.preventDefault();
      goStep("");
    }
  };

  const stepField = step ? byId.get(step) : undefined;
  let lastGroup: string | undefined;

  return (
    <div className="ftb" ref={rootRef} role="group" aria-label={label}>
      <ul className="ftb-chips">
        {chips.map((c) => (
          <li className="ftb-chip" key={c.fid}>
            <button
              type="button"
              className="ftb-chip-main"
              ref={(el) => {
                if (el) chipRefs.current.set(c.fid, el);
                else chipRefs.current.delete(c.fid);
              }}
              aria-haspopup="listbox"
              aria-expanded={step === c.fid}
              aria-controls={step === c.fid ? panelId : undefined}
              aria-label={props.editLabel ? props.editLabel(c.fieldLabel, c.valueLabel) : undefined}
              onClick={(e) => (step === c.fid ? close() : openAt(c.fid, e.currentTarget))}
            >
              <span className="ftb-chip-field">
                {c.fieldLabel}
                {sep}
              </span>
              <span className="ftb-chip-value">{c.valueLabel}</span>
            </button>
            <button type="button" className="ftb-chip-x" aria-label={removeLabel(c.fieldLabel, c.valueLabel)} onClick={() => remove(c.fid)}>
              <CloseIcon />
            </button>
          </li>
        ))}
        <li className="ftb-tools">
          <button
            type="button"
            ref={addRef}
            className="ftb-add"
            aria-haspopup="listbox"
            aria-expanded={step === ""}
            aria-controls={panelId}
            onClick={(e) => (step === "" ? close() : openAt("", e.currentTarget))}
          >
            <PlusIcon />
            {addLabel}
          </button>
          {chips.length > 0 && (
            <button
              type="button"
              className="ftb-clear"
              onClick={() => {
                onChange({});
                addRef.current?.focus();
              }}
            >
              {clearAllLabel}
            </button>
          )}
        </li>
      </ul>
      {props.activeLabel && (
        <span className="sr-only" aria-live="polite">
          {props.activeLabel(chips.length)}
        </span>
      )}
      {open && (
        <div className="ftb-panel" id={panelId} ref={panelRef} style={{ left: panelLeft }}>
          {stepField && (
            <div className="ftb-head">
              <button type="button" className="ftb-back" onClick={() => goStep("")}>
                <ChevronIcon dir="left" />
                <span className="sr-only">{backLabel}</span>
              </button>
              <span className="ftb-head-title">{stepField.label}</span>
            </div>
          )}
          <input
            ref={inputRef}
            className="ftb-search"
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={options.length ? optionId(current) : undefined}
            aria-label={stepField ? `${stepField.label}, ${searchPlaceholder}` : searchPlaceholder}
            placeholder={searchPlaceholder}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onInputKey}
          />
          <ul className="ftb-list" id={listId} role="listbox" aria-label={stepField?.label ?? addLabel}>
            {options.length === 0 && <li className="ftb-empty">{noMatch}</li>}
            {options.map((o, i) => {
              const head = step === "" && o.kind === "field" && o.group && o.group !== lastGroup ? o.group : null;
              if (o.kind === "field") lastGroup = o.group;
              const selected = o.kind === "value" && value[o.field.id] === o.value.id;
              const filtered = o.kind === "field" && Boolean(value[o.field.id]);
              return (
                <li key={o.kind === "field" ? `f:${o.field.id}` : `v:${o.field.id}:${o.value.id}`} role="presentation">
                  {head && (
                    <div className="ftb-group" role="presentation">
                      {head}
                    </div>
                  )}
                  <div
                    id={optionId(i)}
                    role="option"
                    aria-selected={i === current}
                    aria-checked={o.kind === "value" ? selected : undefined}
                    className={`ftb-opt${i === current ? " active" : ""}${o.kind === "value" && o.nested ? " nested" : ""}`}
                    onPointerMove={() => i !== current && setActive(i)}
                    onPointerDown={(e) => e.preventDefault()}
                    onClick={() => choose(o)}
                  >
                    {o.kind === "field" ? (
                      <>
                        <span className="ftb-opt-label">{o.field.label}</span>
                        {filtered && <span className="ftb-dot" aria-hidden="true" />}
                        <ChevronIcon dir="right" />
                      </>
                    ) : (
                      <>
                        <span className="ftb-check">{selected && <CheckIcon />}</span>
                        <span className="ftb-opt-label">{o.value.label}</span>
                        {o.value.count !== undefined && <span className="ftb-count">{fmt(o.value.count)}</span>}
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

/* ─── Curseur à deux poignées ─── */

export interface RangeSliderProps {
  min: number;
  max: number;
  step?: number;
  value: [number, number];
  onChange: (next: [number, number]) => void;
  /** Appelé au relâchement du pointeur avec la dernière valeur (au clavier, chaque pas passe par `onChange`). */
  onCommit?: (next: [number, number]) => void;
  label: string;
  formatValue?: (n: number) => string;
  thumbLabels: [string, string];
}

/**
 * Curseur à deux poignées : deux <input type="range"> superposés (clavier natif : flèches, PageUp/PageDown,
 * Home/End ; aria-valuetext via `formatValue`), poignées qui ne se croisent pas, piste remplie entre elles,
 * bulle de valeur au focus clavier et au glissement. Adapté du « Slider » de 21st.dev (wensity), sans Base UI.
 */
export function RangeSlider({ min, max, step = 1, value, onChange, onCommit, label, formatValue, thumbLabels }: RangeSliderProps) {
  const fmt = formatValue ?? ((n: number) => String(n));
  const labelId = useId();
  const [drag, setDrag] = useState<0 | 1 | null>(null);
  const latest = useRef(value);
  latest.current = value;
  const lo = Math.max(min, Math.min(value[0], max));
  const hi = Math.max(lo, Math.min(value[1], max));
  const span = max - min || 1;
  const pct = (n: number) => ((n - min) / span) * 100;
  const set = (i: 0 | 1, raw: number) => {
    const next: [number, number] = i === 0 ? [Math.min(raw, hi), hi] : [lo, Math.max(raw, lo)];
    if (next[0] !== lo || next[1] !== hi) onChange(next);
  };
  // Fin de glissement écoutée sur la fenêtre : le pointeur peut être relâché hors de la poignée
  useEffect(() => {
    if (drag === null) return;
    const end = () => {
      setDrag(null);
      onCommit?.(latest.current);
    };
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, [drag, onCommit]);
  // Centre d'une poignée de 18 px : la piste utile va de 9 px à (100 % - 9 px)
  const at = (n: number) => `calc(${pct(n)}% + ${9 - pct(n) * 0.18}px)`;
  // Poignées confondues en haut de la piste : la basse passe dessus pour rester attrapable
  const loOnTop = lo === hi && lo >= min + span / 2;

  const thumb = (i: 0 | 1) => {
    const v = i === 0 ? lo : hi;
    return (
      <div className={`rsl-thumb${drag === i ? " dragging" : ""}`} style={{ zIndex: i === 0 ? (loOnTop ? 3 : 2) : 2 }}>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={v}
          aria-label={thumbLabels[i]}
          aria-valuetext={fmt(v)}
          onChange={(e) => set(i, Number(e.target.value))}
          onPointerDown={() => setDrag(i)}
          onBlur={() => setDrag(null)}
        />
        <span className="rsl-bubble" aria-hidden="true" style={{ left: at(v) }}>
          {fmt(v)}
        </span>
      </div>
    );
  };

  return (
    <div className="rsl" role="group" aria-labelledby={labelId}>
      <div className="rsl-head">
        <span id={labelId} className="rsl-label">
          {label}
        </span>
        <span className="rsl-values num" aria-hidden="true">
          {fmt(lo)} – {fmt(hi)}
        </span>
      </div>
      <div className="rsl-control">
        <div className="rsl-track" aria-hidden="true">
          <div className="rsl-fill" style={{ left: at(lo), width: `calc(${at(hi)} - ${at(lo)})` }} />
        </div>
        {thumb(0)}
        {thumb(1)}
      </div>
    </div>
  );
}
