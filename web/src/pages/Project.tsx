import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { api, ApiError, useApi, useMeta, type ProjectDetail, type ProjectTargeting, type StudyListItem } from "../api";
import { Cols, dateFr, Loading, packShort, Seg, Status } from "../ui";
import { useDict } from "../i18n";
import { projectDict } from "../i18n/project";

/**
 * Éléments de la page Projet réutilisés par les sous-pages (src/pages/ProjectHub.tsx) :
 * liste des études et formulaire « Nouvelle étude ».
 */

export const moduleLink = (m: { id: string; status: string; draftId?: string }) => (m.status !== "validated" && m.draftId ? `/brouillons/${m.draftId}` : `/modules/${m.id}`);

export function StudiesTable({ studies }: { studies: StudyListItem[] }) {
  const t = useDict(projectDict).studies;
  if (!studies.length) return <div className="empty">{t.empty}</div>;
  return (
          <div className="table-wrap">
      <table className="table fixed">
        <Cols widths={[null, 230, 150, 92, 128, 116]} />
        <thead>
          <tr>
            <th>{t.colStudy}</th>
            <th>{t.colSample}</th>
            <th>{t.colBackend}</th>
            <th className="r">{t.colResponses}</th>
            <th>{t.colStatus}</th>
            <th className="r">{t.colCreated}</th>
          </tr>
        </thead>
        <tbody>
          {studies.map((s) => (
            <tr key={s.id}>
              <td>
                <Link href={`/etudes/${s.id}`}>{s.name}</Link>
                <div className="small muted num">{s.id}</div>
              </td>
              <td className="small">
                {s.populations.length
                  ? s.populations.map((pop) => (
                      <div key={pop.group}>
                        {t.groupLine(pop.group === "control" ? t.control : t.target, pop.n)}
                      </div>
                    ))
                  : t.personas(s.sampleSize)}
                {s.sampleFromStudyId && <div className="muted">{t.sampleFrom(s.sampleFromStudyId)}</div>}
              </td>
              <td className="small">
                {s.backend}
                <div className="muted">{s.model}</div>
              </td>
              <td className="r num">
                {s.responses}/{s.sampleSize}
              </td>
              <td>
                <Status status={s.status} />
              </td>
              <td className="r small muted nowrap num">{dateFr(s.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function NewStudyForm({ project, targeting }: { project: ProjectDetail; targeting: ProjectTargeting | null }) {
  const meta = useMeta();
  const t = useDict(projectDict).newStudy;
  const tg = useDict(projectDict).studies;
  const allStudies = useApi<StudyListItem[]>("/studies");
  const [, navigate] = useLocation();
  const hasTarget = Boolean(targeting?.target);
  const [triageAlert, setTriageAlert] = useState<string | null>(null);
  const [mode, setMode] = useState<"project" | "new" | "same">(hasTarget ? "project" : "new");
  const [pt, setPt] = useState({ n: String(targeting?.target?.n ?? 50), controlN: String(targeting?.control?.n ?? 20), withControl: Boolean(targeting?.control) });
  const [f, setF] = useState({
    name: "",
    targetPack: "",
    n: "200",
    withControl: true,
    controlPack: "fr-2026.1",
    controlN: "50",
    seed: "7",
    backend: "claude-cli",
    model: "",
    quotas: "",
    controlQuotas: "",
    sameAs: "",
    sameGroup: "",
    sameN: "",
  });
  // Cible par défaut : la première population ciblée connue, sinon la première population
  useEffect(() => {
    if (!meta || f.targetPack) return;
    const def = meta.packs.find((p) => p.targeted) ?? meta.packs[0];
    if (def) setF((x) => ({ ...x, targetPack: def.packVersion }));
  }, [meta, f.targetPack]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Protocole v3 par défaut ; refus d'un pitch au ton commercial, avec option « forcer » confirmée
  const [protocol, setProtocol] = useState<"3" | "2">("3");
  const [pitchRefusal, setPitchRefusal] = useState<{ error: string; pitchTone: { score: number; threshold: number; markers: string[] } } | null>(null);
  const [forceOk, setForceOk] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const packs = meta?.packs ?? [];
  const backend = meta?.backends.find((b) => b.id === f.backend);
  const packN = (v: string) => packs.find((p) => p.packVersion === v)?.n;

  const parseQuotas = (s: string, label: string) => {
    if (!s.trim()) return undefined;
    try {
      return JSON.parse(s) as Record<string, Record<string, number>>;
    } catch {
      throw new Error(t.quotasInvalid(label));
    }
  };

  const submit = async (e: React.FormEvent, force = false, forceTone = false) => {
    e.preventDefault();
    setErr(null);
    // Garde-fou : un pré-tri en cache pour cette graine qui dépasse le seuil d'alerte est rappelé avant de créer
    if (mode === "project" && !force) {
      try {
        const t = await api<{ result: { triage?: { alert: boolean; message: string; share: number } } | null }>(`/projects/${project.id}/target-preview/triage?seed=${Number(f.seed)}`);
        if (t.result?.triage?.alert) {
          setTriageAlert(t.result.triage.message);
          return;
        }
      } catch {
        // pas de pré-tri lisible : pas de rappel
      }
    }
    setTriageAlert(null);
    setBusy(true);
    try {
      const common = {
        projectId: project.id,
        seed: Number(f.seed),
        backend: f.backend,
        ...(f.model.trim() && { model: f.model.trim() }),
        ...(f.name.trim() && { name: f.name.trim() }),
        protocolVersion: protocol,
        ...(forceTone && { force: true }),
      };
      const body =
        mode === "project"
          ? { ...common, useProjectTarget: true, n: Number(pt.n), withControl: pt.withControl, ...(pt.withControl && { controlN: Number(pt.controlN) }) }
          : mode === "same"
          ? {
              ...common,
              sameSampleAs: f.sameAs,
              ...(f.sameGroup && { sameSampleGroup: f.sameGroup }),
              ...(f.sameN && { n: Number(f.sameN) }),
            }
          : {
              ...common,
              target: { packVersion: f.targetPack, n: Number(f.n), ...(parseQuotas(f.quotas, t.quotasTarget) && { quotas: parseQuotas(f.quotas, t.quotasTarget) }) },
              ...(f.withControl && {
                control: { packVersion: f.controlPack, n: Number(f.controlN), ...(parseQuotas(f.controlQuotas, t.quotasControl) && { quotas: parseQuotas(f.controlQuotas, t.quotasControl) }) },
              }),
            };
      const res = await api<{ study: StudyListItem; shortfalls: string[]; notes?: string[] }>("/studies", { json: body });
      const q = res.shortfalls.length ? `?quotas=${encodeURIComponent(res.shortfalls.join("|"))}` : "";
      navigate(`/etudes/${res.study.id}${q}`);
    } catch (e2) {
      const body = e2 instanceof ApiError ? (e2.body as { code?: string; error: string; pitchTone?: { score: number; threshold: number; markers: string[] } } | null) : null;
      if (body?.code === "pitch_tone" && body.pitchTone) {
        setPitchRefusal({ error: body.error, pitchTone: body.pitchTone });
        setForceOk(false);
      } else setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const sources = allStudies.data ?? [];
  const src = sources.find((s) => s.id === f.sameAs);
  const effectiveN = mode === "project" ? Number(pt.n) || null : mode === "new" ? Number(f.n) || null : f.sameN ? Number(f.sameN) : null;

  return (
    <form onSubmit={submit} className="stack" style={{ gap: 18 }}>
      {project.pitchTone?.warn && !pitchRefusal && (
        <div className="banner-block stack" role="note" aria-label={t.toneAria} style={{ marginTop: 0 }}>
          <p>
            <b>{t.toneTitle}</b>
            {t.toneBody(project.pitchTone.score, project.pitchTone.threshold)}
            {protocol === "3" ? t.toneV3 : ""}
          </p>
          <p className="small">
            <Link href={`/projets/${encodeURIComponent(project.id)}/offre/pitch`}>{t.reviewPitch}</Link>
          </p>
        </div>
      )}
      <div className="row">
        <h2 style={{ marginRight: 12 }}>{t.title}</h2>
        <div className="seg" role="group" aria-label={t.sampleAria}>
          {hasTarget && (
            <button type="button" aria-pressed={mode === "project"} onClick={() => setMode("project")}>
              {t.modeProject}
            </button>
          )}
          <button type="button" aria-pressed={mode === "new"} onClick={() => setMode("new")}>
            {hasTarget ? t.modeManual : t.modeNew}
          </button>
          <button type="button" aria-pressed={mode === "same"} onClick={() => setMode("same")}>
            {t.modeSame}
          </button>
        </div>
      </div>
      <p className="small ink2" style={{ maxWidth: "72ch" }}>
        {t.frozen}
      </p>

      {mode === "project" && targeting?.target ? (
        <div className="grid-2">
          <fieldset>
            <legend>{t.projectTarget}</legend>
            <p className="small ink2" style={{ marginBottom: 10 }}>
              {t.socle}
              {targeting.target.socle}
              {targeting.target.modules.length ? ` + ${targeting.target.modules.join(", ")}` : ""}
              {targeting.target.eligibility && (
                <>
                  {t.filter}
                  <code className="expr">{targeting.target.eligibility}</code>
                </>
              )}
              {t.drawNote}
            </p>
            <label className="field" style={{ maxWidth: 180 }}>
              <span>{t.sizeN}</span>
              <input type="number" min={1} required value={pt.n} onChange={(e) => setPt({ ...pt, n: e.target.value })} />
            </label>
          </fieldset>
          <fieldset>
            <legend>
              <label className="check">
                <input type="checkbox" checked={pt.withControl} disabled={!targeting.control} onChange={(e) => setPt({ ...pt, withControl: e.target.checked })} />
                {t.projectControl}
              </label>
            </legend>
            {targeting.control ? (
              pt.withControl ? (
                <>
                  <p className="small ink2" style={{ marginBottom: 10 }}>
                    {t.socle}
                    {targeting.control.socle}
                    {targeting.control.modules.length ? ` + ${targeting.control.modules.join(", ")}` : ""}
                    {targeting.control.eligibility ? t.filterInline(targeting.control.eligibility) : t.noFilter}.
                  </p>
                  <label className="field" style={{ maxWidth: 180 }}>
                    <span>{t.sizeM}</span>
                    <input type="number" min={1} required value={pt.controlN} onChange={(e) => setPt({ ...pt, controlN: e.target.value })} />
                  </label>
                </>
              ) : (
                <p className="small muted">{t.noControlWhy}</p>
              )
            ) : (
              <p className="small muted">{t.noControlDeclared}</p>
            )}
          </fieldset>
        </div>
      ) : mode === "new" ? (
        <div className="grid-2">
          <fieldset>
            <legend>{t.targetPopulation}</legend>
            <div className="form-grid">
              <label className="field wide">
                <span>{t.pack}</span>
                <select value={f.targetPack} onChange={set("targetPack")}>
                  {packs.map((p) => (
                    <option key={p.packVersion} value={p.packVersion}>
                      {t.packOption(p.label, p.n)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>{t.sizeN}</span>
                <input type="number" min={1} max={packN(f.targetPack)} required value={f.n} onChange={set("n")} />
              </label>
              <details className="field wide">
                <summary className="small ink2" style={{ cursor: "pointer" }}>{t.quotasOptional}</summary>
                <textarea rows={3} value={f.quotas} onChange={set("quotas")} placeholder='{"ageBand":{"18-29":0.3,"30-44":0.7}}' style={{ marginTop: 6 }} />
                <small>{t.quotasHint((meta?.dimensions ?? []).map((d) => d.id).join(", "))}</small>
              </details>
            </div>
          </fieldset>
          <fieldset>
            <legend>
              <label className="check">
                <input type="checkbox" checked={f.withControl} onChange={(e) => setF({ ...f, withControl: e.target.checked })} />
                {t.controlGroup}
              </label>
            </legend>
            {f.withControl ? (
              <div className="form-grid">
                <label className="field wide">
                  <span>{t.pack}</span>
                  <select value={f.controlPack} onChange={set("controlPack")}>
                    {packs.map((p) => (
                      <option key={p.packVersion} value={p.packVersion}>
                        {t.packOption(p.label, p.n)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>{t.sizeM}</span>
                  <input type="number" min={1} max={packN(f.controlPack)} required value={f.controlN} onChange={set("controlN")} />
                </label>
                <details className="field wide">
                  <summary className="small ink2" style={{ cursor: "pointer" }}>{t.quotasOptional}</summary>
                  <textarea rows={3} value={f.controlQuotas} onChange={set("controlQuotas")} style={{ marginTop: 6 }} />
                </details>
              </div>
            ) : (
              <p className="small muted">{t.noControlWhy}</p>
            )}
          </fieldset>
        </div>
      ) : (
        <fieldset>
          <legend>{t.reuseSample}</legend>
          <div className="form-grid">
            <label className="field wide">
              <span>{t.sourceStudy}</span>
              <select required value={f.sameAs} onChange={set("sameAs")}>
                <option value="">{t.chooseStudy}</option>
                {sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {t.sourceOption(s.id, s.name, s.sampleSize)}
                  </option>
                ))}
              </select>
              <small>{t.sameHint}</small>
            </label>
            <label className="field">
              <span>{t.group}</span>
              <select value={f.sameGroup} onChange={set("sameGroup")}>
                <option value="">{t.allGroups}</option>
                {src?.populations.map((p) => (
                  <option key={p.group} value={p.group}>
                    {p.group === "control" ? tg.control : tg.target} ({p.n})
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{t.sizeFirst}</span>
              <input type="number" min={1} value={f.sameN} onChange={set("sameN")} placeholder={t.all} />
            </label>
          </div>
        </fieldset>
      )}

      <div className="form-grid" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
        <label className="field">
          <span>{t.backend}</span>
          <select value={f.backend} onChange={set("backend")}>
            {(meta?.backends ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t.model}</span>
          <input type="text" value={f.model} onChange={set("model")} placeholder={backend?.defaultModel ?? ""} />
        </label>
        <label className="field">
          <span>{t.seed}</span>
          <input type="number" required value={f.seed} onChange={set("seed")} />
        </label>
        <label className="field">
          <span>{t.name}</span>
          <input type="text" value={f.name} onChange={set("name")} placeholder={t.auto} />
        </label>
      </div>
      <div className="stack" style={{ gap: 6 }}>
        <Seg
          label={t.questionnaire}
          value={protocol}
          onChange={setProtocol}
          options={[
            { id: "3", label: t.v3 },
            { id: "2", label: t.v2 },
          ]}
        />
        <p className="small ink2" style={{ maxWidth: "80ch" }}>
          {protocol === "3"
            ? t.v3Hint
            : t.v2Hint}
        </p>
      </div>
      {effectiveN !== null && effectiveN < 100 && (
        <p className="note-box small">
          {t.smallSample(effectiveN)}
        </p>
      )}
      {f.backend === "ollama" && <p className="note-box small">{t.ollama}</p>}
      {pitchRefusal && (
        <div className="banner-block stack" role="alertdialog" aria-label={t.refusedAria}>
          <p>
            <b>{t.refused}</b> {pitchRefusal.error}
            {pitchRefusal.pitchTone.markers.length > 0 && <span className="ink2">{t.markers(pitchRefusal.pitchTone.markers.slice(0, 5))}</span>}
          </p>
          <p className="small">
            <Link href={`/projets/${encodeURIComponent(project.id)}/offre/pitch`}>{t.reviewPitchNeutral}</Link>
          </p>
          <label className="small" style={{ display: "flex", flexWrap: "nowrap", gap: 8, alignItems: "flex-start" }}>
            <input type="checkbox" checked={forceOk} onChange={(e) => setForceOk(e.target.checked)} />
            <span>
              {t.forceConsent}
            </span>
          </label>
          <div className="row">
            <button className="btn" type="button" disabled={busy || !forceOk} onClick={(e) => void submit(e as unknown as React.FormEvent, true, true)}>
              {t.force}
            </button>
            <button className="btn ghost" type="button" onClick={() => setPitchRefusal(null)}>
              {t.cancel}
            </button>
          </div>
        </div>
      )}
      {triageAlert && (
        <div className="banner-block stack" role="alertdialog" aria-label={t.triageAria}>
          <p>
            <b>{t.triageTitle}</b> {triageAlert}
          </p>
          <p className="small ink2">{t.triageHint}</p>
          <div className="row">
            <button className="btn" type="button" disabled={busy} onClick={(e) => void submit(e as unknown as React.FormEvent, true)}>
              {t.createAnyway}
            </button>
            <button className="btn ghost" type="button" onClick={() => setTriageAlert(null)}>
              {t.cancel}
            </button>
          </div>
        </div>
      )}
      {err && <div className="error-box">{err}</div>}
      <div className="row">
        <button className="btn" type="submit" disabled={busy}>
          {busy ? t.creating : t.submit}
        </button>
      </div>
    </form>
  );
}
