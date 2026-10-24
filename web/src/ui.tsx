import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
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
