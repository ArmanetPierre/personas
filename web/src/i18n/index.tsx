import { createContext, Fragment, useContext, useEffect, useState, type ReactNode } from "react";
import { useLocation } from "wouter";

/**
 * Langue de l'interface (fr par défaut, en pour Singapour).
 *
 * - Chaque zone de l'interface déclare son dictionnaire avec `defineDict(fr, en)` : une clé absente
 *   (ou en trop) en anglais est une erreur de typecheck.
 * - Les composants lisent leur dictionnaire avec `useDict(dict)` ; le code hors composant avec `tr(dict)`.
 * - Le choix explicite est mémorisé (localStorage). Sans choix explicite, une page dont le contenu est en
 *   anglais (socle en locale en) peut demander l'anglais avec `useContentLocale(locale)`.
 * - Changer de langue remonte les pages (`LocaleKeyed`) : données relues avec ?lang=, formats recalculés.
 */

export type Locale = "fr" | "en";
export const LOCALES: readonly Locale[] = ["fr", "en"];
export const DEFAULT_LOCALE: Locale = "fr";
const STORAGE_KEY = "personas-lang";

let current: Locale = DEFAULT_LOCALE;
/** Langue courante (lecture hors composant : formats, appels d'API). */
export const getLocale = (): Locale => current;
/** Locale Intl de la langue : fr-FR, en-GB (dates jour-mois, devises sans ambiguïté : « SGD 150 », « US$9.99 »). */
export const intlLocale = (l: Locale = current): string => (l === "fr" ? "fr-FR" : "en-GB");

export const isLocale = (x: unknown): x is Locale => x === "fr" || x === "en";

function readStored(): Locale | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return isLocale(v) ? v : null;
  } catch {
    return null;
  }
}

function store(l: Locale | null) {
  try {
    if (l) localStorage.setItem(STORAGE_KEY, l);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // stockage indisponible : le choix vaut pour la session
  }
}

interface LocaleCtx {
  locale: Locale;
  /** Choix explicite de l'utilisateur (null : langue par défaut ou suggérée par le contenu). */
  explicit: Locale | null;
  setLocale: (l: Locale) => void;
  setHint: (path: string, l: Locale) => void;
}

const Ctx = createContext<LocaleCtx>({ locale: DEFAULT_LOCALE, explicit: null, setLocale: () => {}, setHint: () => {} });

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [explicit, setExplicit] = useState<Locale | null>(readStored);
  const [hint, setHintState] = useState<{ path: string; locale: Locale } | null>(null);
  const [loc] = useLocation();
  const locale = explicit ?? (hint && hint.path === loc ? hint.locale : DEFAULT_LOCALE);
  current = locale;
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  const value: LocaleCtx = {
    locale,
    explicit,
    setLocale: (l) => {
      setExplicit(l);
      store(l);
    },
    setHint: (path, l) => setHintState((prev) => (prev?.path === path && prev.locale === l ? prev : { path, locale: l })),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useLocale = () => useContext(Ctx);

/** Remonte les pages au changement de langue (données relues, formats recalculés). */
export function LocaleKeyed({ children }: { children: ReactNode }) {
  const { locale } = useLocale();
  return <Fragment key={locale}>{children}</Fragment>;
}

/**
 * Langue du contenu affiché (socle d'un projet ou d'une étude, champ `locale` de l'API).
 * Sans choix explicite de l'utilisateur, la page s'affiche dans cette langue.
 */
export function useContentLocale(l: string | null | undefined) {
  const { setHint } = useLocale();
  const [loc] = useLocation();
  useEffect(() => {
    if (isLocale(l)) setHint(loc, l);
  }, [l, loc]); // eslint-disable-line react-hooks/exhaustive-deps
}

// ─── Dictionnaires typés ──────────────────────────────────────────────────────

export type Dict<T> = Record<Locale, T>;

/** Déclare un dictionnaire : l'anglais doit avoir exactement la forme du français (sinon : erreur de typecheck). */
export function defineDict<T extends object>(fr: T, en: NoInfer<T>): Dict<T> {
  return { fr, en };
}

/** Dictionnaire de la langue courante, dans un composant. */
export function useDict<T>(d: Dict<T>): T {
  return d[useLocale().locale];
}

/** Dictionnaire de la langue courante, hors composant (au rendu). */
export function tr<T>(d: Dict<T>): T {
  return d[current];
}

// ─── Sélecteur ────────────────────────────────────────────────────────────────

export function LocaleSwitch() {
  const { locale, setLocale } = useLocale();
  const label = locale === "fr" ? "Langue" : "Language";
  return (
    <div className="theme-switch lang-switch" role="group" aria-label={label}>
      {LOCALES.map((l) => (
        <button key={l} type="button" lang={l} aria-pressed={locale === l} onClick={() => setLocale(l)} title={l === "fr" ? "Français" : "English"}>
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
