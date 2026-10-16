import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation } from "wouter";
import { packInfos, type Meta } from "./api";
import { commonDict } from "./i18n/common";
import { getLocale, intlLocale, LocaleSwitch, tr, useDict } from "./i18n";

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
  const opt = (th: Theme, l: string) => (
    <button type="button" aria-pressed={theme === th} onClick={() => setTheme(th)}>
      {l}
    </button>
  );
  return (
    <div className="theme-switch" role="group" aria-label={t.label}>
      {opt("auto", t.auto)}
      {opt("light", t.light)}
      {opt("dark", t.dark)}
    </div>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const [loc] = useLocation();
  const t = useDict(commonDict);
  return (
    <div className="shell">
      <aside className="rail">
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
        <nav aria-label={t.nav.main}>
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} aria-current={n.match(loc) ? "page" : undefined}>
              {t.nav[n.key]}
            </Link>
          ))}
        </nav>
        <div className="rail-foot">
          <ThemeSwitch />
          <LocaleSwitch />
        </div>
      </aside>
      <main>
        <div className="page">{children}</div>
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

export function useTooltip() {
  const [tip, setTip] = useState<TipState | null>(null);
  const node = tip
    ? createPortal(
        <div className="tooltip" role="status" style={{ left: Math.min(tip.x + 14, window.innerWidth - 310), top: tip.y + 14 }}>
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

export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: Array<{ id: T; label: string }>; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" aria-pressed={value === o.id} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
