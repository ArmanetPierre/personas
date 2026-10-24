import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation } from "wouter";
import { api, invalidateMeta } from "../api";
import { intlLocale, useDict, useLocale } from "../i18n";
import { commonDict } from "../i18n/common";
import { hostedDict } from "../i18n/hosted";
import { FEATURES, usePlatform, useSession, type EngineView } from "../platform";
import { ErrorBox, Loading } from "../ui";
import { API_PROVIDERS, PROVIDER_INFO, setupApi, type ApiProvider } from "./Onboarding";

/**
 * Pages du compte (service hébergé) : /compte (adresse, export, suppression) et /compte/moteur (clé IA).
 * Routes : GET/DELETE /api/me, GET /api/me/export, GET/POST/DELETE /api/me/engine.
 */

const isApiProvider = (p: string): p is ApiProvider => (API_PROVIDERS as string[]).includes(p);

function useProviderName() {
  const t = useDict(hostedDict).engine;
  return (p: string) => t.providers[p] ?? p;
}

export function AccountPage() {
  const t = useDict(hostedDict).account;
  const tn = useDict(hostedDict).nav;
  const session = useSession();
  const providerName = useProviderName();
  const [step, setStep] = useState<"idle" | "confirm">("idle");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  if (session.state.status !== "signed") return <Loading />;
  const me = session.state.me;
  const engine = session.engine;
  const matches = typed.trim().toLowerCase() === me.email.toLowerCase();

  const remove = async (e: FormEvent) => {
    e.preventDefault();
    if (!matches || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api("/me", { method: "DELETE" });
      session.ended("supprime");
    } catch (err) {
      setError(err as Error);
      setBusy(false);
    }
  };

  return (
    <>
      <h1>{t.title}</h1>
      <p className="lede" style={{ marginTop: 10 }}>{t.lede}</p>

      <div className="panel" style={{ marginTop: 22, maxWidth: 720 }}>
        <dl className="facts">
          <dt>{t.email}</dt>
          <dd>{me.email}</dd>
          {me.createdAt && (
            <>
              <dt>{t.since}</dt>
              <dd>{new Date(me.createdAt).toLocaleDateString(intlLocale(), { day: "numeric", month: "long", year: "numeric" })}</dd>
            </>
          )}
          <dt>{t.engine}</dt>
          <dd>
            {engine ? t.engineValue(providerName(engine.provider), engine.last4) : engine === null ? t.noEngine : "—"} · <Link href="/compte/moteur">{t.manage}</Link>
          </dd>
        </dl>
        <div className="row" style={{ marginTop: 16 }}>
          <button className="btn ghost small" type="button" onClick={() => void session.signOut()}>
            {t.signOut}
          </button>
        </div>
      </div>

      <section className="section" aria-labelledby="export-title" style={{ marginTop: 40 }}>
        <div className="section-head">
          <h2 id="export-title">{t.exportTitle}</h2>
        </div>
        <div className="panel stack" style={{ maxWidth: 720 }}>
          <p className="ink2">{t.exportText}</p>
          <div className="row">
            <a className="btn ghost" href="/api/me/export" download>
              {t.exportBtn}
            </a>
          </div>
        </div>
      </section>

      <section className="section" aria-labelledby="delete-title" style={{ marginTop: 40 }}>
        <div className="section-head">
          <h2 id="delete-title">{t.deleteTitle}</h2>
        </div>
        <div className="panel stack danger-zone" style={{ maxWidth: 720 }}>
          <p>{t.deleteLede}</p>
          <ul className="consequences">
            {t.consequences.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          {step === "idle" ? (
            <div className="row">
              <button className="btn danger" type="button" onClick={() => setStep("confirm")}>
                {t.deleteStart}
              </button>
            </div>
          ) : (
            <form className="stack" style={{ gap: 12 }} onSubmit={remove}>
              <label className="field" style={{ maxWidth: 420 }}>
                <span>{t.confirmLabel(me.email)}</span>
                <input
                  type="email"
                  autoComplete="off"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  autoFocus
                  aria-invalid={typed.trim() && !matches ? true : undefined}
                  aria-describedby={typed.trim() && !matches ? "confirm-mismatch" : undefined}
                />
                {typed.trim() && !matches && <small id="confirm-mismatch">{t.confirmMismatch}</small>}
              </label>
              <div className="row">
                <button className="btn danger" type="submit" disabled={!matches || busy} aria-busy={busy || undefined}>
                  {busy ? t.deleting : t.deleteFinal}
                </button>
                <button className="btn ghost" type="button" onClick={() => (setStep("idle"), setTyped(""))}>
                  {t.cancel}
                </button>
              </div>
            </form>
          )}
          <ErrorBox error={error} />
        </div>
      </section>

      <p className="small muted" style={{ marginTop: 32 }}>
        {t.legalTitle} <Link href="/confidentialite">{tn.privacy}</Link> · <Link href="/conditions">{tn.terms}</Link>
      </p>
    </>
  );
}

// ─── Ma clé IA ────────────────────────────────────────────────────────────────

/** Plafonds proposés (le serveur applique ses propres bornes). */
const DEFAULT_PER_STUDY = 5;
const DEFAULT_PER_MONTH = 20;

export function EngineSettingsPage() {
  const t = useDict(hostedDict).engine;
  const ta = useDict(hostedDict).account;
  const tc = useDict(commonDict);
  const { locale } = useLocale();
  const { has } = usePlatform();
  const session = useSession();
  const [, navigate] = useLocation();
  const providerName = useProviderName();
  const engine = session.engine;
  const [provider, setProvider] = useState<ApiProvider>("anthropic");
  const [model, setModel] = useState(PROVIDER_INFO.anthropic.model);
  const [key, setKey] = useState("");
  const [perStudy, setPerStudy] = useState(String(DEFAULT_PER_STUDY));
  const [perMonth, setPerMonth] = useState(String(DEFAULT_PER_MONTH));
  const [busy, setBusy] = useState<null | "save" | "remove" | "demo">(null);
  const [error, setError] = useState<Error | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [firstKey, setFirstKey] = useState(false);

  // Formulaire prérempli avec la clé enregistrée (fournisseur, modèle, plafonds ; jamais la clé)
  const fill = (e: EngineView | null) => {
    if (!e) return;
    if (isApiProvider(e.provider)) setProvider(e.provider);
    if (e.model) setModel(e.model);
    if (e.perStudyUsd !== null) setPerStudy(String(e.perStudyUsd));
    if (e.perMonthUsd !== null) setPerMonth(String(e.perMonthUsd));
  };
  useEffect(() => fill(engine ?? null), [engine === undefined]); // eslint-disable-line react-hooks/exhaustive-deps

  if (session.state.status !== "signed") return <Loading />;
  if (engine === undefined) return session.engineError ? <ErrorBox error={session.engineError} /> : <Loading />;

  const sameProvider = Boolean(engine && engine.provider === provider);
  const keyRequired = !sameProvider;
  const capsValid = Number(perStudy) > 0 && Number(perMonth) > 0;
  const canSave = !busy && model.trim() !== "" && capsValid && (keyRequired ? key.trim().length >= 8 : key.trim() === "" || key.trim().length >= 8);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    const sendsKey = key.trim() !== "";
    setBusy("save");
    setError(null);
    setDone(null);
    try {
      await api("/me/engine", {
        json: {
          provider,
          model: model.trim(),
          ...(sendsKey && { apiKey: key.trim() }),
          perStudyUsd: Number(perStudy),
          perMonthUsd: Number(perMonth),
        },
      });
      const wasEmpty = !engine;
      invalidateMeta();
      await session.refreshEngine();
      setDone(sendsKey ? t.saved : t.savedCaps);
      if (wasEmpty) setFirstKey(true);
    } catch (err) {
      setError(err as Error);
    } finally {
      // La clé n'est gardée nulle part dans la page, succès ou échec
      setKey("");
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy("remove");
    setError(null);
    setDone(null);
    try {
      await api("/me/engine", { method: "DELETE" });
      invalidateMeta();
      await session.refreshEngine();
      setConfirmRemove(false);
      setFirstKey(false);
      setDone(t.removed);
      setProvider("anthropic");
      setModel(PROVIDER_INFO.anthropic.model);
      setPerStudy(String(DEFAULT_PER_STUDY));
      setPerMonth(String(DEFAULT_PER_MONTH));
    } catch (err) {
      setError(err as Error);
    } finally {
      setBusy(null);
    }
  };

  const createDemo = async () => {
    setBusy("demo");
    setError(null);
    try {
      const r = await setupApi<{ projectId: string }>("/demo", { lang: locale });
      navigate(`/projets/${r.projectId}`);
    } catch (err) {
      setError(err as Error);
      setBusy(null);
    }
  };

  return (
    <>
      <div className="crumbs">
        <Link href="/compte">{ta.title}</Link>
        <span>/</span>
        <span>{t.title}</span>
      </div>
      <h1>{t.title}</h1>
      <p className="lede" style={{ marginTop: 10 }}>{t.lede}</p>

      <div className="panel" style={{ marginTop: 22, maxWidth: 820 }}>
        <dl className="facts">
          <dt>{t.current}</dt>
          <dd>{engine ? t.currentValue(providerName(engine.provider), engine.model, engine.last4) : <span className="muted">{t.none}</span>}</dd>
        </dl>
      </div>

      <form className="panel stack engine-form" style={{ marginTop: 16, gap: 16, maxWidth: 820 }} onSubmit={save}>
        <div className="form-grid">
          <label className="field">
            <span>{t.provider}</span>
            <select
              value={provider}
              onChange={(e) => {
                const p = e.target.value as ApiProvider;
                setProvider(p);
                setModel(engine && engine.provider === p && engine.model ? engine.model : PROVIDER_INFO[p].model);
              }}
            >
              {API_PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {providerName(p)}
                </option>
              ))}
            </select>
            <small>
              <a href={PROVIDER_INFO[provider].keyUrl} target="_blank" rel="noopener noreferrer">
                {t.createKey(providerName(provider))}
              </a>
            </small>
          </label>
          <label className="field">
            <span>{t.model}</span>
            <input type="text" required value={model} onChange={(e) => setModel(e.target.value)} spellCheck={false} autoComplete="off" />
            <small>{t.modelHint}</small>
          </label>
          <label className="field wide">
            <span>{t.key}</span>
            <input
              type="password"
              required={keyRequired}
              minLength={8}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              name="personas-api-key"
              aria-describedby="key-hint"
            />
            <small id="key-hint">
              {t.keyHint}
              {sameProvider && <> {t.keyKeep}</>}
            </small>
          </label>
          <label className="field">
            <span>{t.perStudy}</span>
            <input type="number" required min="0.5" step="0.5" inputMode="decimal" value={perStudy} onChange={(e) => setPerStudy(e.target.value)} />
          </label>
          <label className="field">
            <span>{t.perMonth}</span>
            <input type="number" required min="1" step="1" inputMode="decimal" value={perMonth} onChange={(e) => setPerMonth(e.target.value)} aria-describedby="caps-hint" />
          </label>
          <p id="caps-hint" className="small muted wide">{t.capsHint}</p>
        </div>
        <div className="row">
          <button className="btn" type="submit" disabled={!canSave} aria-busy={busy === "save" || undefined}>
            {busy === "save" ? (key.trim() ? t.testing : t.saving) : sameProvider && !key.trim() ? t.saveCaps : t.save}
          </button>
          {engine && !confirmRemove && (
            <button className="btn ghost" type="button" disabled={Boolean(busy)} onClick={() => setConfirmRemove(true)}>
              {t.remove}
            </button>
          )}
        </div>
        {confirmRemove && (
          <div className="banner-block stack" role="alertdialog" aria-label={t.removeFinal} style={{ marginTop: 0 }}>
            <p>{t.removeConfirm}</p>
            <div className="row">
              <button className="btn danger" type="button" disabled={Boolean(busy)} onClick={() => void remove()}>
                {t.removeFinal}
              </button>
              <button className="btn ghost" type="button" onClick={() => setConfirmRemove(false)}>
                {t.cancel}
              </button>
            </div>
          </div>
        )}
        <div role="status" aria-live="polite">
          {done && <p className="small ok-text">{done}</p>}
        </div>
        <ErrorBox error={error} />
      </form>

      {firstKey && engine && (
        <div className="panel stack" style={{ marginTop: 16, gap: 14, maxWidth: 820 }}>
          {has(FEATURES.demo) && (
            <>
              <h2>{t.demoTitle}</h2>
              <p>{t.demoLede}</p>
            </>
          )}
          <div className="row">
            {has(FEATURES.demo) && (
              <button className="btn" type="button" disabled={Boolean(busy)} onClick={() => void createDemo()}>
                {busy === "demo" ? `${tc.loading}…` : t.demoCreate}
              </button>
            )}
            <Link className={has(FEATURES.demo) ? "btn ghost" : "btn"} href="/">
              {t.demoSkip}
            </Link>
          </div>
        </div>
      )}
    </>
  );
}
