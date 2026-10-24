import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import { api, ApiError, invalidateMeta, loadMeta, setUnauthorizedHandler, type Meta } from "./api";
import { parseEngine, parseMe, PUBLIC_PATHS, type EngineView, type Me } from "./session-data";

export { parseEngine, PUBLIC_PATHS, type EngineView, type Me };

/**
 * Mode d'exécution de l'interface, lu une fois au démarrage dans `GET /api/meta` :
 *
 * - **local** (dépôt, paquet installé) : `mode` absent ou `"local"` ; toutes les fonctions sont considérées
 *   disponibles (la liste `features` n'est pas consultée), rien ne change.
 * - **hosted** (service web, phase 4) : `mode: "hosted"`, `features` (fonctions disponibles) et configuration
 *   publique de connexion (Supabase). Toute page hors connexion et pages légales demande une session ;
 *   un 401 de l'API renvoie vers /connexion.
 */

export type Mode = "local" | "hosted";

/** Fonctions qui peuvent manquer en hébergé (valeurs de `features` dans /api/meta, src/web/features.ts). */
export const FEATURES = {
  /** Assistant de création de modules (proposer, réviser, prévisualiser, valider). */
  moduleAssistant: "modules.assistant",
  /** Projet de démonstration (POST /api/setup/demo). */
  demo: "demo",
  /** Catalogue du Hub (lecture, cache). */
  hubCatalog: "hub.catalog",
  /** Publication d'un module sur le Hub. */
  hubPublish: "hub.publish",
  /** Recodage des objections a posteriori. */
  recode: "recode",
} as const;
export type Feature = (typeof FEATURES)[keyof typeof FEATURES];

export interface HostedConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  githubEnabled: boolean;
}

interface PlatformCtx {
  mode: Mode;
  hosted: boolean;
  /** En local : toujours vrai. En hébergé : la fonction figure dans `features`. */
  has: (f: Feature) => boolean;
  config: HostedConfig | null;
}

const LOCAL: PlatformCtx = { mode: "local", hosted: false, has: () => true, config: null };
const Ctx = createContext<PlatformCtx>(LOCAL);
let currentMode: Mode = "local";
/** Mode courant hors composant. */
export const isHosted = () => currentMode === "hosted";

function fromMeta(m: Partial<Meta> | null, forceHosted = false): PlatformCtx {
  if (!forceHosted && m?.mode !== "hosted") return LOCAL;
  const features = new Set(m?.features ?? []);
  const config = m?.supabaseUrl && m.supabaseAnonKey ? { supabaseUrl: m.supabaseUrl.replace(/\/+$/, ""), supabaseAnonKey: m.supabaseAnonKey, githubEnabled: m.githubEnabled === true } : null;
  return { mode: "hosted", hosted: true, has: (f) => features.has(f), config };
}

/**
 * Lit le mode avant d'afficher l'application. En local, la requête est celle des métadonnées (mise en cache et
 * reprise par `useMeta`) : aucune requête de plus. Échec : mode local (les pages affichent leurs propres erreurs),
 * sauf un 401, qui n'existe qu'en hébergé.
 */
export function PlatformProvider({ children }: { children: ReactNode }) {
  const [value, setValue] = useState<PlatformCtx | null>(null);
  useEffect(() => {
    loadMeta().then(
      (m) => setValue(fromMeta(m)),
      (e: unknown) => {
        invalidateMeta();
        const body = e instanceof ApiError ? (e.body as Partial<Meta>) : null;
        setValue(e instanceof ApiError && e.status === 401 ? fromMeta(body, true) : LOCAL);
      },
    );
  }, []);
  if (!value) return null;
  currentMode = value.mode;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const usePlatform = () => useContext(Ctx);

// ─── Session (hébergé) ────────────────────────────────────────────────────────

/** Raison du retour à la connexion (paramètre `raison` de /connexion). */
export type SignedOutReason = "expire" | "supprime" | "deconnecte";
type SessionState = { status: "loading" } | { status: "anon"; reason?: SignedOutReason } | { status: "signed"; me: Me };

interface SessionCtx {
  state: SessionState;
  /** Clé IA : undefined tant qu'elle n'est pas lue. */
  engine: EngineView | null | undefined;
  /** Échec de lecture de la clé IA (autre qu'une absence de clé). */
  engineError: Error | null;
  refresh: () => Promise<void>;
  refreshEngine: () => Promise<void>;
  signOut: () => Promise<void>;
  /** Session terminée côté serveur (compte supprimé) : retour à la connexion avec un message. */
  ended: (reason: SignedOutReason) => void;
}

const SCtx = createContext<SessionCtx>({ state: { status: "anon" }, engine: null, engineError: null, refresh: async () => {}, refreshEngine: async () => {}, signOut: async () => {}, ended: () => {} });

const NEXT_KEY = "personas-next";

/** Page à rouvrir après la connexion (chemin interne seulement, gardé le temps de l'aller-retour). */
export function rememberNext(path: string) {
  if (!path.startsWith("/") || path.startsWith("//") || PUBLIC_PATHS.includes(path)) return;
  try {
    sessionStorage.setItem(NEXT_KEY, path);
  } catch {
    // stockage indisponible : retour à l'accueil
  }
}
export function takeNext(): string {
  try {
    const v = sessionStorage.getItem(NEXT_KEY);
    sessionStorage.removeItem(NEXT_KEY);
    if (v && v.startsWith("/") && !v.startsWith("//")) return v;
  } catch {
    // rien
  }
  return "/";
}

/** Session du service hébergé (cookie httpOnly posé par POST /api/session). En local : inerte. */
export function SessionProvider({ children }: { children: ReactNode }) {
  const { hosted } = usePlatform();
  const [state, setState] = useState<SessionState>(hosted ? { status: "loading" } : { status: "anon" });
  const [engine, setEngine] = useState<EngineView | null | undefined>(undefined);
  const [engineError, setEngineError] = useState<Error | null>(null);
  const [loc, navigate] = useLocation();
  const locRef = useRef(loc);
  locRef.current = loc;

  const refreshEngine = useCallback(async () => {
    try {
      setEngine(parseEngine(await api<unknown>("/me/engine")));
      setEngineError(null);
    } catch (e) {
      // 404 : aucune clé enregistrée ; autre erreur : on n'affiche pas le bandeau à tort
      const none = e instanceof ApiError && e.status === 404;
      setEngine(none ? null : undefined);
      setEngineError(none ? null : (e as Error));
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const me = parseMe(await api<unknown>("/me"));
      setState(me ? { status: "signed", me } : { status: "anon" });
      if (me) void refreshEngine();
    } catch {
      setState({ status: "anon" });
    }
  }, [refreshEngine]);

  const ended = useCallback(
    (reason: SignedOutReason) => {
      invalidateMeta();
      setEngine(undefined);
      setState({ status: "anon", reason });
      navigate(`/connexion?raison=${reason}`, { replace: true });
    },
    [navigate],
  );

  const signOut = useCallback(async () => {
    await fetch("/api/session", { method: "DELETE" }).catch(() => {});
    ended("deconnecte");
  }, [ended]);

  useEffect(() => {
    if (!hosted) return;
    void refresh();
    // Session expirée pendant la navigation : retour à la connexion, en gardant la page en cours
    setUnauthorizedHandler((path) => {
      if (path === "/me" || path === "/meta") return;
      setState((s) => (s.status === "signed" ? { status: "anon", reason: "expire" } : s));
    });
    return () => setUnauthorizedHandler(null);
  }, [hosted, refresh]);

  // Garde : sans session, toute page non publique mène à /connexion
  useEffect(() => {
    if (!hosted || state.status !== "anon") return;
    if (PUBLIC_PATHS.includes(loc)) return;
    rememberNext(locRef.current);
    const reason = state.status === "anon" ? state.reason : undefined;
    navigate(reason === "expire" ? "/connexion?raison=expire" : "/connexion", { replace: true });
  }, [hosted, state, loc, navigate]);

  const value = useMemo(() => ({ state, engine, engineError, refresh, refreshEngine, signOut, ended }), [state, engine, engineError, refresh, refreshEngine, signOut, ended]);
  return <SCtx.Provider value={value}>{children}</SCtx.Provider>;
}

export const useSession = () => useContext(SCtx);
