import { useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { api, useApi, useMeta, type ModuleSummary, type ModulesResponse, type ProjectListItem } from "../api";
import { Cols, dateFr, EmptyState, ErrorBox, Loading, ModuleIcon } from "../ui";
import { tr, useDict } from "../i18n";
import { modulesDict } from "../i18n/modules";
import { hostedDict } from "../i18n/hosted";
import { FEATURES, usePlatform } from "../platform";
import { HubCatalogSection } from "./ModulesHub";

/** Libellé du statut d'un brouillon (au rendu, dans la langue courante). */
export const draftStatusLabel = (st: string): string | undefined => tr(modulesDict).draftStatus[st];

/** Statut lisible d'un module : `validated` ou `draft:<statut>`. */
export function ModuleStatus({ status }: { status: string }) {
  const t = useDict(modulesDict);
  if (status === "validated") return <span className="status completed">{t.status.validated}</span>;
  if (status === "missing") return <span className="status failed">{t.status.missing}</span>;
  const st = status.replace(/^draft:/, "");
  const cls = st === "proposing" ? "running" : st === "error" ? "failed" : st === "accepted" ? "completed" : "paused";
  return <span className={`status ${cls}`}>{t.draftStatus[st] ?? st}</span>;
}

export const moduleHref = (m: Pick<ModuleSummary, "id" | "status" | "draftId">) =>
  m.status === "validated" || !m.draftId ? `/modules/${encodeURIComponent(m.id)}` : `/brouillons/${encodeURIComponent(m.draftId)}`;

/** Service hébergé : l'assistant de modules figure-t-il dans les fonctions disponibles ? (toujours vrai en local) */
export function useAssistantFeature(): boolean {
  return usePlatform().has(FEATURES.moduleAssistant);
}

export function AssistantBanner({ reason }: { reason?: string | undefined }) {
  const t = useDict(modulesDict);
  const th = useDict(hostedDict).unavailable;
  const feature = useAssistantFeature();
  // Hébergé, sans l'assistant : la raison tient en une ligne (pas de mention de modules/ ni de la CLI)
  if (!feature)
    return (
      <p className="note-box small" role="note" style={{ marginTop: 16, maxWidth: "80ch" }}>
        {th.assistant}
      </p>
    );
  return (
    <p className="note-box small" style={{ marginTop: 16, maxWidth: "80ch" }}>
      {reason ?? t.assistant.unavailable}
      {t.assistant.banner}
    </p>
  );
}

export function ModulesPage() {
  const t = useDict(modulesDict);
  const { data, error } = useApi<ModulesResponse>("/modules");
  const [, navigate] = useLocation();
  const feature = useAssistantFeature();
  const { has } = usePlatform();
  const list = data?.modules ?? [];
  const drafts = list.filter((m) => m.status !== "validated");
  const validated = list.filter((m) => m.status === "validated");

  const table = (rows: ModuleSummary[]) => (
    <div className="table-wrap">
      <table className="table fixed modules-table">
        <Cols widths={[null, 130, 70, 130, 84, 170, 116]} />
        <thead>
          <tr>
            <th>{t.list.cols.module}</th>
            <th>{t.list.cols.status}</th>
            <th>{t.list.cols.socles}</th>
            <th>{t.list.cols.requires}</th>
            <th className="r">{t.list.cols.attributes}</th>
            <th>{t.list.cols.provenance}</th>
            <th className="r">{t.list.cols.updated}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => (
            <tr key={`${m.id}-${m.draftId ?? ""}`} className="link" onClick={() => navigate(moduleHref(m))}>
              <td>
                <Link href={moduleHref(m)} onClick={(e) => e.stopPropagation()}>
                  <b className="cell-name">{m.version ? m.label : m.id}</b>
                </Link>
                <div className="small muted num">
                  {m.version ? `${m.id} v${m.version}` : t.list.noYaml}
                  {m.draftId && m.draftId !== m.id ? t.list.draftSuffix(m.draftId) : ""}
                </div>
                {!m.version && <div className="small ink2 clamp-2" style={{ marginTop: 2 }}>{m.label}</div>}
              </td>
              <td>
                <ModuleStatus status={m.status} />
              </td>
              <td className="small">{m.appliesTo.join(", ") || "—"}</td>
              <td className="small">{m.requires.length ? m.requires.join(", ") : <span className="muted">{t.list.none}</span>}</td>
              <td className="r num">{m.version ? m.attributeCount : "—"}</td>
              <td className="small">{m.version ? <ProvenanceMeter m={m} /> : <span className="muted">—</span>}</td>
              <td className="r small muted nowrap num">{dateFr(m.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <>
      <h1>{t.list.title}</h1>
      <p className="lede" style={{ marginTop: 10 }}>
        {t.list.lede}
      </p>
      {feature && (
        <div className="row" style={{ marginTop: 22 }}>
          <Link className="btn" href="/modules/nouveau">
            {t.list.newModule}
          </Link>
        </div>
      )}
      {(!feature || (data && !data.assistant.available)) && <AssistantBanner reason={data?.assistant.reason} />}
      <ErrorBox error={error} />
      {!data && !error && <Loading />}
      {data && (
        <>
          {/* Hébergé sans assistant : pas de section Brouillons vide (on ne peut pas en créer) */}
          {(feature || drafts.length > 0) && (
          <div className="section" style={{ marginTop: 36 }}>
            <div className="section-head">
              <h2>{t.list.draftsTitle}</h2>
              <p className="small ink2">{t.list.draftsHint}</p>
            </div>
            {drafts.length ? (
              table(drafts)
            ) : (
              <EmptyState
                icon={<ModuleIcon />}
                title={t.list.draftsEmptyTitle}
                description={t.list.draftsEmpty}
                action={
                  feature ? (
                    <Link className="btn ghost" href="/modules/nouveau">
                      {t.list.newModule}
                    </Link>
                  ) : undefined
                }
              />
            )}
          </div>
          )}
          <div className="section" style={feature || drafts.length > 0 ? undefined : { marginTop: 36 }}>
            <div className="section-head">
              <h2>{t.list.libraryTitle}</h2>
              <p className="small ink2">{t.list.libraryHint}</p>
            </div>
            {validated.length ? table(validated) : <EmptyState icon={<ModuleIcon />} title={t.list.libraryEmptyTitle} description={t.list.libraryEmpty} />}
          </div>
          {has(FEATURES.hubCatalog) && <HubCatalogSection />}
        </>
      )}
    </>
  );
}

/** Part des attributs sourcés et part reposant sur une hypothèse (un attribut peut cumuler les deux). */
function ProvenanceMeter({ m }: { m: ModuleSummary }) {
  const t = useDict(modulesDict);
  const n = Math.max(1, m.attributeCount);
  return (
    <div style={{ minWidth: 120 }}>
      <div className="prov-meter" aria-hidden="true">
        <i style={{ width: `${(m.sourcedCount / n) * 100}%` }} />
      </div>
      <span className="ink2">
        {t.list.provenance(m.sourcedCount, m.attributeCount, m.assumptionCount)}
      </span>
    </div>
  );
}

export function NewModulePage() {
  const t = useDict(modulesDict);
  const meta = useMeta();
  const search = useSearch();
  const projects = useApi<ProjectListItem[]>("/projects");
  const status = useApi<ModulesResponse>("/modules");
  const feature = useAssistantFeature();
  const [, navigate] = useLocation();
  const [f, setF] = useState({ description: "", projectId: new URLSearchParams(search).get("project") ?? "", socle: "fr" });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const project = projects.data?.find((p) => p.id === f.projectId);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const r = await api<{ draftId: string }>("/modules/propose", { json: { description: f.description, socle: f.socle, ...(f.projectId && { projectId: f.projectId }) } });
      navigate(`/brouillons/${r.draftId}`);
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="crumbs">
        <Link href="/modules">Modules</Link>
        <span>/</span>
        <span>{t.create.title}</span>
      </div>
      <h1>{t.create.title}</h1>
      <p className="lede" style={{ marginTop: 10 }}>
        {t.create.lede}
      </p>
      {(!feature || (status.data && !status.data.assistant.available)) && <AssistantBanner reason={status.data?.assistant.reason} />}
      <form className="panel stack" style={{ marginTop: 22, gap: 18, maxWidth: 820 }} onSubmit={submit}>
        <label className="field">
          <span>{t.create.domain}</span>
          <textarea
            required
            minLength={10}
            rows={5}
            value={f.description}
            onChange={(e) => setF({ ...f, description: e.target.value })}
            placeholder={t.create.domainPlaceholder}
          />
          <small>{t.create.domainHint}</small>
        </label>
        <div className="form-grid">
          <label className="field">
            <span>{t.create.project}</span>
            <select value={f.projectId} onChange={(e) => setF({ ...f, projectId: e.target.value })}>
              <option value="">{t.create.noProject}</option>
              {(projects.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.id})
                </option>
              ))}
            </select>
            <small>{t.create.projectHint}</small>
          </label>
          <label className="field">
            <span>{t.create.socle}</span>
            <select value={f.socle} onChange={(e) => setF({ ...f, socle: e.target.value })}>
              {(meta?.socles ?? [{ id: "fr", pack: "fr" }]).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.id === "fr" ? "France" : s.id} ({s.pack})
                </option>
              ))}
            </select>
          </label>
        </div>
        {project && (
          <p className="small ink2" style={{ maxWidth: "72ch" }}>
            {t.create.pitchSent}
            {project.pitch.slice(0, 220)}
            {project.pitch.length > 220 ? "…" : ""}
          </p>
        )}
        {err && <div className="error-box">{err}</div>}
        <div className="row">
          <button className="btn" type="submit" disabled={busy || !feature || f.description.trim().length < 10}>
            {busy ? t.create.sending : t.create.submit}
          </button>
          <span className="small ink2">{t.create.duration}</span>
        </div>
      </form>
    </>
  );
}
