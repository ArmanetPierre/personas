import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { invalidateMeta } from "../api";
import { useDict } from "../i18n";
import { hostedDict } from "../i18n/hosted";
import { takeNext, usePlatform, useSession } from "../platform";
import { Loading } from "../ui";

/**
 * Connexion au service hébergé (/connexion). Supabase Auth par l'API REST (sans SDK) :
 *
 * 1. lien magique `POST {supabase}/auth/v1/otp` avec `create_user: false` (comptes sur invitation, comme le Hub),
 *    ou GitHub (`/auth/v1/authorize?provider=github`) si la configuration l'active ;
 * 2. retour sur /connexion avec le jeton d'accès dans le fragment de l'adresse, retiré aussitôt ;
 * 3. `POST /api/session` : le serveur vérifie le jeton et pose un cookie httpOnly. Le jeton Supabase n'est gardé
 *    nulle part dans le navigateur.
 */

type Notice = "expired" | "deleted" | "signedOut";
const NOTICES: Record<string, Notice> = { expire: "expired", supprime: "deleted", deconnecte: "signedOut" };

export function SignInPage() {
  const t = useDict(hostedDict).signIn;
  const tn = useDict(hostedDict).nav;
  const { config } = usePlatform();
  const session = useSession();
  const [, navigate] = useLocation();
  const search = useSearch();
  const notice = NOTICES[new URLSearchParams(search).get("raison") ?? ""];
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [completing, setCompleting] = useState(false);
  const started = useRef(false);

  // Retour de Supabase : jeton (ou erreur) dans le fragment, retiré de l'adresse avant tout
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const frag = new URLSearchParams(location.hash.slice(1));
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
    const token = frag.get("access_token");
    const fragError = frag.get("error_description") ?? frag.get("error");
    if (fragError) {
      setError(/signup|not allowed|not found/i.test(fragError) ? t.invite : /expired|invalid/i.test(fragError) ? t.expiredLink : t.generic);
      return;
    }
    if (!token) return;
    setCompleting(true);
    void (async () => {
      try {
        const r = await fetch("/api/session", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ accessToken: token }),
        });
        if (!r.ok) {
          const j = (await r.json().catch(() => ({}))) as { error?: unknown; reason?: unknown; code?: unknown };
          const why = `${typeof j.reason === "string" ? j.reason : ""} ${typeof j.error === "string" ? j.error : ""}`;
          if (j.code === "account_deleted") throw new Error(t.accountDeleted);
          throw new Error(r.status === 403 || /invit/i.test(why) ? t.invite : r.status === 401 ? t.expiredLink : t.generic);
        }
        invalidateMeta();
        await session.refresh();
        navigate(takeNext(), { replace: true });
      } catch (e) {
        setError(e instanceof TypeError ? t.network : (e as Error).message);
        setCompleting(false);
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Déjà connecté : rien à faire ici
  useEffect(() => {
    if (session.state.status === "signed" && !completing) navigate("/", { replace: true });
  }, [session.state.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const redirectTo = `${location.origin}/connexion`;

  const sendLink = async (e: FormEvent) => {
    e.preventDefault();
    if (!config || busy) return;
    const address = email.trim();
    setBusy(true);
    setError(null);
    setSentTo(null);
    try {
      const r = await fetch(`${config.supabaseUrl}/auth/v1/otp?redirect_to=${encodeURIComponent(redirectTo)}`, {
        method: "POST",
        headers: { apikey: config.supabaseAnonKey, "content-type": "application/json" },
        // create_user: false : comptes sur invitation, aucune inscription depuis l'application
        body: JSON.stringify({ email: address, create_user: false }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { msg?: string; error_description?: string; message?: string; error_code?: string };
        const detail = `${j.error_code ?? ""} ${j.msg ?? j.error_description ?? j.message ?? ""}`;
        throw new Error(/signup|not allowed|not found|otp_disabled/i.test(detail) ? t.invite : r.status === 429 ? t.rateLimited : t.sendLink);
      }
      setSentTo(address);
    } catch (err) {
      setError(err instanceof TypeError ? t.network : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const github = () => {
    if (!config) return;
    location.href = `${config.supabaseUrl}/auth/v1/authorize?provider=github&redirect_to=${encodeURIComponent(redirectTo)}`;
  };

  if (completing && !error) return <Loading what={t.completing} />;

  return (
    <div className="auth-card stack" style={{ gap: 18 }}>
      <h1 tabIndex={-1}>{t.title}</h1>
      <p className="lede">{t.lede}</p>
      {notice && !error && !sentTo && (
        <p className="note-box" role="status">
          {t[notice]}
        </p>
      )}
      {!config && <div className="error-box" role="alert">{t.noConfig}</div>}
      {config && (
        <div className="panel stack" style={{ gap: 14 }}>
          <form className="stack" style={{ gap: 12 }} onSubmit={sendLink} noValidate={false}>
            <label className="field">
              <span>{t.email}</span>
              <input
                type="email"
                required
                autoComplete="email"
                inputMode="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                aria-describedby={error ? "signin-error" : undefined}
                aria-invalid={error ? true : undefined}
              />
            </label>
            <div className="row">
              <button className="btn" type="submit" disabled={busy || !email.trim()} aria-busy={busy || undefined}>
                {busy ? t.sending : t.send}
              </button>
            </div>
          </form>
          {config.githubEnabled && (
            <>
              <p className="auth-or small muted" aria-hidden="true">
                <span>{t.or}</span>
              </p>
              <div className="row">
                <button className="btn ghost" type="button" onClick={github}>
                  <GithubIcon />
                  {t.github}
                </button>
              </div>
            </>
          )}
        </div>
      )}
      {/* Zone d'annonce présente dès le chargement : seul son contenu change */}
      <div role="status" aria-live="polite">
        {sentTo && <p className="note-box">{t.sent(sentTo)}</p>}
      </div>
      <div id="signin-error" role="alert">
        {error && <div className="error-box">{error}</div>}
      </div>
      <p className="small muted">
        {t.legal} <Link href="/conditions">{tn.terms}</Link> · <Link href="/confidentialite">{tn.privacy}</Link>
      </p>
    </div>
  );
}

const GithubIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false">
    <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38v-1.33c-2.23.48-2.7-1.07-2.7-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.05-.49.05-.49.8.06 1.23.83 1.23.83.72 1.22 1.87.87 2.33.66.07-.52.28-.87.5-1.07-1.78-.2-3.65-.89-3.65-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
  </svg>
);
