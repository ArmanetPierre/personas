import { useEffect, useState, type FormEvent } from "react";
import { useLocation } from "wouter";
import { ApiError, withLang } from "../api";
import { useDict, useLocale } from "../i18n";
import { commonDict } from "../i18n/common";
import { onboardingDict } from "../i18n/onboarding";
import { ErrorBox, Loading, SegmentedControl } from "../ui";

/**
 * Écran de premier lancement : 1) moteur, 2) clé (testée puis rangée dans le trousseau), 3) plafond de dépense,
 * 4) projet de démonstration. Routes : /api/setup/* (src/web/setup-routes.ts), jeton de session en en-tête.
 * La clé ne part qu'en POST vers l'API locale et n'est jamais relue : le champ est vidé après l'envoi.
 */

interface SetupStatus {
  claudeCli: { detected: boolean; version?: string };
  activeProfile: string;
  configured: boolean;
  needsOnboarding: boolean;
  profiles: Array<{ name: string; provider: string; model: string; baseUrl?: string; perStudyUsd: number | null }>;
  defaultPerStudyUsd: number;
  dataDir: string;
}

interface EngineResult {
  ok: boolean;
  profile: string;
  provider: string;
  billed: boolean;
  detail: string;
}

export type ApiProvider = "anthropic" | "openai" | "gemini" | "openrouter";
export const API_PROVIDERS: ApiProvider[] = ["anthropic", "openai", "gemini", "openrouter"];
/** Pages de création de clé, et modèle proposé par défaut (modifiable). */
export const PROVIDER_INFO: Record<ApiProvider, { keyUrl: string; model: string }> = {
  anthropic: { keyUrl: "https://console.anthropic.com/settings/keys", model: "claude-sonnet-4-5" },
  openai: { keyUrl: "https://platform.openai.com/api-keys", model: "gpt-5-mini" },
  gemini: { keyUrl: "https://aistudio.google.com/app/apikey", model: "gemini-2.5-flash" },
  openrouter: { keyUrl: "https://openrouter.ai/keys", model: "anthropic/claude-sonnet-4.5" },
};
const LOCAL_DEFAULTS = { ollama: { baseUrl: "http://localhost:11434", model: "qwen3:8b" }, vllm: { baseUrl: "http://localhost:8000/v1", model: "" } } as const;

const SESSION_HEADER = "x-personas-session";
let sessionToken: Promise<string> | null = null;

/** Jeton de session du serveur local (lu une fois par chargement de page). */
function session(): Promise<string> {
  sessionToken ??= fetch("/api/setup/session")
    .then(async (r) => {
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${r.status}`);
      return ((await r.json()) as { token: string }).token;
    })
    .catch((e: unknown) => {
      sessionToken = null;
      throw e;
    });
  return sessionToken;
}

export async function setupApi<T>(path: string, json?: unknown): Promise<T> {
  const token = await session();
  const res = await fetch(withLang(`/api/setup${path}`), {
    method: json === undefined ? "GET" : "POST",
    headers: { [SESSION_HEADER]: token, ...(json !== undefined && { "content-type": "application/json" }) },
    ...(json !== undefined && { body: JSON.stringify(json) }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    if (res.status === 401) sessionToken = null;
    const msg = [body.error, body.detail].filter((x) => typeof x === "string" && x).join(" ");
    throw new ApiError(msg || `HTTP ${res.status}`, res.status, body);
  }
  return body as T;
}

const SEEN_KEY = "personas-onboarding-checked";

/**
 * Au premier affichage de l'accueil : ouvre l'écran de configuration si aucun profil n'est configuré et que la
 * CLI claude n'est pas détectée (une fois par session du navigateur).
 */
export function OnboardingGate() {
  const [loc, navigate] = useLocation();
  useEffect(() => {
    if (loc !== "/") return;
    try {
      if (sessionStorage.getItem(SEEN_KEY)) return;
      sessionStorage.setItem(SEEN_KEY, "1");
    } catch {
      // stockage indisponible : vérification à chaque accueil
    }
    setupApi<SetupStatus>("/status").then(
      (s) => s.needsOnboarding && navigate("/configurer"),
      () => {},
    );
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

type Step = 1 | 2 | 3 | 4;
type Choice = "claude" | "api" | "local";

export function OnboardingPage() {
  const t = useDict(onboardingDict);
  const tc = useDict(commonDict);
  const { locale } = useLocale();
  const [, navigate] = useLocation();
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<Step>(1);
  const [choice, setChoice] = useState<Choice>("api");
  const [ack, setAck] = useState(false);
  const [provider, setProvider] = useState<ApiProvider>("anthropic");
  const [model, setModel] = useState(PROVIDER_INFO.anthropic.model);
  const [key, setKey] = useState("");
  const [server, setServer] = useState<"ollama" | "vllm">("ollama");
  const [baseUrl, setBaseUrl] = useState<string>(LOCAL_DEFAULTS.ollama.baseUrl);
  const [localModel, setLocalModel] = useState<string>(LOCAL_DEFAULTS.ollama.model);
  const [localKey, setLocalKey] = useState("");
  const [result, setResult] = useState<EngineResult | null>(null);
  const [cap, setCap] = useState("5");

  useEffect(() => {
    setupApi<SetupStatus>("/status").then(
      (s) => {
        setStatus(s);
        setCap(String(s.defaultPerStudyUsd));
        if (s.claudeCli.detected) setChoice("claude");
      },
      (e: Error) => setError(e),
    );
  }, []);

  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await f();
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  };

  const submitEngine = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const body =
        choice === "claude"
          ? { kind: "claude-cli", acknowledgePersonalUse: true }
          : choice === "api"
            ? { kind: "api", provider, model: model.trim(), key: key.trim() }
            : { kind: "local", server, baseUrl: baseUrl.trim(), model: localModel.trim(), ...(localKey.trim() && { key: localKey.trim() }) };
      try {
        const r = await setupApi<EngineResult>("/engine", body);
        setResult(r);
        setStep(r.billed ? 3 : 4);
      } finally {
        // La clé n'est gardée nulle part dans la page, succès ou échec
        setKey("");
        setLocalKey("");
      }
    });
  };

  const submitCap = (e: FormEvent) => {
    e.preventDefault();
    if (!result) return;
    void run(async () => {
      await setupApi("/limits", { profile: result.profile, perStudyUsd: Number(cap) });
      setStep(4);
    });
  };

  const createDemo = () =>
    void run(async () => {
      const r = await setupApi<{ projectId: string }>("/demo", { lang: locale });
      navigate(`/projets/${r.projectId}`);
    });

  if (!status && !error) return <Loading what={t.loading} />;

  const stepName = t.steps[step - 1] ?? "";
  return (
    <>
      <h1>{t.title}</h1>
      <p className="lede" style={{ marginTop: 10 }}>{t.lede}</p>
      {status && <p className="small muted" style={{ marginTop: 8 }}>{t.current(status.activeProfile)}</p>}
      <ol className="chips" aria-label={t.stepLabel(step, 4, stepName)} style={{ marginTop: 18, listStyle: "none", padding: 0, display: "flex", gap: 8, flexWrap: "wrap" }}>
        {t.steps.map((s, i) => (
          <li key={s} className={i + 1 <= step ? "pill" : "pill muted"} aria-current={i + 1 === step ? "step" : undefined} style={{ fontWeight: i + 1 === step ? 700 : 400 }}>
            {i + 1}. {s}
          </li>
        ))}
      </ol>
      <div style={{ marginTop: 14 }}>
        <ErrorBox error={error} />
      </div>

      {status && step <= 2 && (
        <form className="panel stack" style={{ marginTop: 18, gap: 16 }} onSubmit={submitEngine}>
          <SegmentedControl
            label={t.steps[0] ?? t.title}
            value={choice}
            onChange={(c) => (setChoice(c), setStep(1))}
            options={(["claude", "api", "local"] as const).map((c) => ({ id: c, label: c === "claude" ? t.choose.claude : c === "api" ? t.choose.api : t.choose.local }))}
          />

          {choice === "claude" && (
            <>
              <p>{status.claudeCli.detected ? t.choose.claudeDetected(status.claudeCli.version ?? "") : t.choose.claudeMissing}</p>
              <div className="note-box">{t.choose.claudeNote}</div>
              <label className="check">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> {t.choose.claudeAck}
              </label>
              <div className="row">
                <button className="btn" type="submit" disabled={busy || !ack || !status.claudeCli.detected}>
                  {busy ? `${t.testing}…` : t.choose.claudeUse}
                </button>
              </div>
            </>
          )}

          {choice === "api" && (
            <>
              <p className="small muted">{t.choose.apiNote}</p>
              <div className="form-grid">
                <label className="field">
                  <span>{t.provider}</span>
                  <select
                    value={provider}
                    onChange={(e) => {
                      const p = e.target.value as ApiProvider;
                      setProvider(p);
                      setModel(PROVIDER_INFO[p].model);
                    }}
                  >
                    {API_PROVIDERS.map((p) => (
                      <option key={p} value={p}>
                        {t.providers[p]}
                      </option>
                    ))}
                  </select>
                  <small>
                    <a href={PROVIDER_INFO[provider].keyUrl} target="_blank" rel="noopener noreferrer">
                      {t.createKey(t.providers[provider] ?? provider)}
                    </a>
                  </small>
                </label>
                <label className="field">
                  <span>{t.model}</span>
                  <input type="text" required value={model} onChange={(e) => setModel(e.target.value)} spellCheck={false} />
                  <small>{t.modelHint}</small>
                </label>
                <label className="field wide">
                  <span>{t.key}</span>
                  <input
                    type="password"
                    required
                    minLength={8}
                    value={key}
                    onChange={(e) => (setKey(e.target.value), step === 1 && setStep(2))}
                    autoComplete="off"
                    spellCheck={false}
                    name="personas-api-key"
                  />
                  <small>{t.keyHint}</small>
                </label>
              </div>
              <div className="row">
                <button className="btn" type="submit" disabled={busy || key.trim().length < 8 || !model.trim()}>
                  {busy ? `${t.testing}…` : t.test}
                </button>
              </div>
            </>
          )}

          {choice === "local" && (
            <>
              <p className="small muted">{t.choose.localNote}</p>
              <div className="form-grid">
                <label className="field">
                  <span>{t.server}</span>
                  <select
                    value={server}
                    onChange={(e) => {
                      const s = e.target.value as "ollama" | "vllm";
                      setServer(s);
                      setBaseUrl(LOCAL_DEFAULTS[s].baseUrl);
                      setLocalModel(LOCAL_DEFAULTS[s].model);
                    }}
                  >
                    {(["ollama", "vllm"] as const).map((s) => (
                      <option key={s} value={s}>
                        {t.servers[s]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>{t.baseUrl}</span>
                  <input type="url" required value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} spellCheck={false} />
                </label>
                <label className="field">
                  <span>{t.model}</span>
                  <input type="text" required value={localModel} onChange={(e) => setLocalModel(e.target.value)} spellCheck={false} />
                </label>
                {server === "vllm" && (
                  <label className="field">
                    <span>{t.localKey}</span>
                    <input type="password" value={localKey} onChange={(e) => setLocalKey(e.target.value)} autoComplete="off" spellCheck={false} />
                  </label>
                )}
              </div>
              <div className="row">
                <button className="btn" type="submit" disabled={busy || !baseUrl.trim() || !localModel.trim()}>
                  {busy ? `${t.testing}…` : t.connect}
                </button>
              </div>
            </>
          )}
        </form>
      )}

      {result && step >= 3 && <p className="small" style={{ marginTop: 18 }}>{t.ok(result.detail || result.profile)}</p>}

      {step === 3 && result && (
        <form className="panel stack" style={{ marginTop: 18, gap: 14 }} onSubmit={submitCap}>
          <h2>{t.cap.title}</h2>
          <p className="small muted">{t.cap.lede}</p>
          <label className="field" style={{ maxWidth: 260 }}>
            <span>{t.cap.label}</span>
            <input type="number" required min="0.5" step="0.5" value={cap} onChange={(e) => setCap(e.target.value)} />
          </label>
          <div className="row">
            <button className="btn" type="submit" disabled={busy || !(Number(cap) > 0)}>
              {t.cap.save}
            </button>
            <button className="btn ghost" type="button" onClick={() => setStep(1)}>
              {t.back}
            </button>
          </div>
        </form>
      )}

      {step === 4 && (
        <div className="panel stack" style={{ marginTop: 18, gap: 14 }}>
          <h2>{t.demo.title}</h2>
          {result && !result.billed && <p className="small muted">{t.cap.notBilled}</p>}
          <p>{t.demo.lede(20)}</p>
          <div className="row">
            <button className="btn" type="button" disabled={busy} onClick={createDemo}>
              {busy ? `${tc.loading}…` : t.demo.create}
            </button>
            <button className="btn ghost" type="button" onClick={() => navigate("/")}>
              {t.demo.skip}
            </button>
          </div>
        </div>
      )}

      {step < 4 && (
        <p style={{ marginTop: 22 }}>
          <button className="linklike" type="button" onClick={() => navigate("/")}>
            {t.skip}
          </button>
        </p>
      )}
    </>
  );
}
