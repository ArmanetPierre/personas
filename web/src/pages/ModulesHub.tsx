import { useState } from "react";
import { api, useApi } from "../api";
import { Cols, dateFr, EmptyState, ErrorBox, Loading, ModuleIcon } from "../ui";
import { useDict } from "../i18n";
import { modulesDict } from "../i18n/modules";

/** Module du catalogue du Hub, tel que renvoyé par GET /api/hub/catalog. */
export interface HubCatalogModule {
  ref: string;
  label: string;
  description: string;
  appliesTo: string[];
  latest: string;
  status: string;
  quality: { q: number; sourcing: number; margins: number; alerts: number; docs: number } | null;
  attributeCount: number;
  localVersion: string | null;
  localSource: string | null;
  cached: boolean;
  /** Champs sociaux (phase 3) : null ou vides si le Hub ne les expose pas (affichage conditionnel). */
  reviewStatus?: string | null;
  badges?: string[];
  stars?: number | null;
  reviews?: { count: number; mean: number | null } | null;
  forkedFrom?: string | null;
}

/** État du compte du Hub (GET /api/hub/account) : le jeton n'est jamais renvoyé. */
export interface HubAccountView {
  hubUrl: string | null;
  connected: boolean;
  tokenStored: boolean;
  rejected: boolean;
  offline?: string;
  me: { namespace: string; displayName: string | null; role: string; scopes: string[] } | null;
  lastKnown?: { namespace: string; displayName: string | null } | null;
  telemetry: boolean;
  telemetryExample: unknown;
  loginCommand: string;
}

/** Badges d'un module du catalogue : statut de revue, sensible, fork (si le Hub les expose). */
export function HubBadges({ m }: { m: HubCatalogModule }) {
  const t = useDict(modulesDict).hub;
  const list = [...new Set([...(m.badges ?? []), ...(m.reviewStatus === "flagged" ? ["flagged"] : [])])];
  if (!list.length) return null;
  return (
    <span className="row" style={{ gap: 6, flexWrap: "wrap", marginTop: 4 }}>
      {list.map((b) => (
        <span key={b} className={`tag${b === "sensitive" || b === "flagged" || b === "unverified" ? " warn" : ""}`} title={t.badgeHints[b] ?? b}>
          {t.badges[b] ?? b}
        </span>
      ))}
    </span>
  );
}

/** Compte du Hub (connecté ou non, commande de connexion) et case de télémétrie opt-in. */
export function HubAccountPanel() {
  const t = useDict(modulesDict).hub;
  const { data, reload } = useApi<HubAccountView>("/hub/account");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!data) return null;
  const toggle = async (enabled: boolean) => {
    setSaving(true);
    setErr(null);
    try {
      await api("/hub/telemetry", { json: { enabled } });
      await reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const login = <code className="num">{data.loginCommand}</code>;
  return (
    <div className="panel stack" style={{ marginBottom: 16 }}>
      <div>
        <b>{t.account.title}</b>
        {data.hubUrl && <span className="small muted"> · {data.hubUrl}</span>}
      </div>
      {data.connected && data.me ? (
        <span className="pill">{t.account.connected(data.me.displayName ?? data.me.namespace, data.me.namespace)}</span>
      ) : data.offline ? (
        <span className="pill warn">{t.account.offline(data.offline, data.lastKnown?.namespace ?? null)}</span>
      ) : (
        <p className="small">
          {data.rejected ? t.account.rejected : t.account.disconnected} {login}
        </p>
      )}
      <p className="small muted">{t.account.tokenNote}</p>
      <label className="check small">
        <input type="checkbox" checked={data.telemetry} disabled={saving} onChange={(e) => void toggle(e.target.checked)} />
        {saving ? t.telemetry.saving : t.telemetry.label}
      </label>
      <p className="small ink2" style={{ maxWidth: "80ch" }}>{t.telemetry.hint}</p>
      <details>
        <summary className="small ink2" style={{ cursor: "pointer" }}>{t.telemetry.example}</summary>
        <pre className="yaml" style={{ marginTop: 6 }}>{JSON.stringify(data.telemetryExample, null, 1)}</pre>
      </details>
      {err && <div className="error-box">{err}</div>}
    </div>
  );
}

export interface HubCatalogView {
  available: boolean;
  fetchedAt: string | null;
  hubUrl: string | null;
  modules: HubCatalogModule[];
  offline?: string;
}

/** Section « Catalogue du Hub » de la page Modules : source Hub, Q décomposé, téléchargement dans le cache. */
export function HubCatalogSection() {
  const t = useDict(modulesDict).hub;
  const { data, error, reload } = useApi<HubCatalogView>("/hub/catalog");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const run = async (key: string, f: () => Promise<string | null>) => {
    setBusy(key);
    setErr(null);
    setMsg(null);
    try {
      setMsg(await f());
      await reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const sync = () => run("sync", async () => {
    const r = await api<HubCatalogView>("/hub/sync", { json: {} });
    return r.offline ? t.offline(r.offline) : null;
  });
  const pull = (m: HubCatalogModule) => run(m.ref, async () => {
    await api("/hub/pull", { json: { ref: m.ref, version: m.latest } });
    return t.pulled(`${m.ref}@${m.latest}`);
  });
  const q = (m: HubCatalogModule) => (m.quality ? t.quality(Math.round(m.quality.q), t.decimal(m.quality.sourcing), t.decimal(m.quality.margins), t.decimal(m.quality.alerts), t.decimal(m.quality.docs)) : t.noQuality);

  return (
    <div className="section">
      <div className="section-head">
        <h2>{t.title}</h2>
        <p className="small ink2">{t.hint}</p>
      </div>
      <HubAccountPanel />
      <div className="row" style={{ marginBottom: 12, gap: 12 }}>
        <button className="btn" type="button" disabled={busy !== null} onClick={sync}>
          {busy === "sync" ? t.syncing : t.sync}
        </button>
        {data?.fetchedAt && <span className="small muted">{t.fetched(dateFr(data.fetchedAt), data.hubUrl ?? "")}</span>}
      </div>
      {msg && <p className="note-box small">{msg}</p>}
      {err && <div className="error-box">{err}</div>}
      <ErrorBox error={error} />
      {!data && !error && <Loading />}
      {data && !data.available && <EmptyState icon={<ModuleIcon />} title={t.noneTitle} description={t.none} />}
      {data && data.available && (
        <div className="table-wrap">
          <table className="table fixed">
            <Cols widths={[null, 150, 70, 260, 170]} />
            <thead>
              <tr>
                <th>{t.cols.module}</th>
                <th>{t.cols.source}</th>
                <th>{t.cols.socles}</th>
                <th>{t.cols.quality}</th>
                <th>{t.cols.action}</th>
              </tr>
            </thead>
            <tbody>
              {data.modules.map((m) => (
                <tr key={m.ref}>
                  <td>
                    <b className="cell-name">{m.label}</b>
                    <div className="small muted num">
                      {m.ref}@{m.latest}
                      {m.status !== "published" ? ` · ${t.status[m.status] ?? m.status}` : ""}
                    </div>
                    <HubBadges m={m} />
                    {m.forkedFrom && <div className="small muted">{t.forkOf(m.forkedFrom)}</div>}
                    <div className="small ink2 clamp-2" style={{ marginTop: 2 }}>{m.description}</div>
                  </td>
                  <td className="small">
                    {t.source}
                    {m.localVersion && <div className="muted">{t.local(m.localVersion)}</div>}
                  </td>
                  <td className="small">{m.appliesTo.join(", ")}</td>
                  <td className="small">
                    {q(m)}
                    {(m.stars != null || m.reviews) && (
                      <div className="muted" style={{ marginTop: 2 }}>
                        {m.stars != null && <span title={t.starsHint}>{t.stars(m.stars)}</span>}
                        {m.stars != null && m.reviews && " · "}
                        {m.reviews && (m.reviews.count > 0 && m.reviews.mean != null ? t.reviews(t.decimal(m.reviews.mean), m.reviews.count) : t.noReviews)}
                      </div>
                    )}
                  </td>
                  <td>
                    {m.cached ? (
                      <span className="status completed">{t.cached}</span>
                    ) : (
                      <button className="btn ghost" type="button" disabled={busy !== null} onClick={() => pull(m)}>
                        {busy === m.ref ? t.pulling : t.pull}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
