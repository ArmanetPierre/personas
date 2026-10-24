import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { api, ApiError, useApi, useMeta, type CostEstimate, type ProjectDetail, type ProjectTargeting, type StudyListItem } from "../api";
import { ChartIcon, Cols, dateFr, EmptyState, Loading, packShort, SegmentedControl, Status } from "../ui";
import { useDict } from "../i18n";
import { projectDict } from "../i18n/project";
import { hostedDict } from "../i18n/hosted";
import { usePlatform } from "../platform";

/**
 * Éléments de la page Projet réutilisés par les sous-pages (src/pages/ProjectHub.tsx) :
 * liste des études et formulaire « Nouvelle étude ».
 */

export const moduleLink = (m: { id: string; status: string; draftId?: string }) => (m.status !== "validated" && m.draftId ? `/brouillons/${m.draftId}` : `/modules/${m.id}`);

export function StudiesTable({ studies }: { studies: StudyListItem[] }) {
  const t = useDict(projectDict).studies;
  if (!studies.length) return <EmptyState icon={<ChartIcon />} title={t.emptyTitle} description={t.empty} />;
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

/** Valeur d'option d'un socle tiré à la demande (`socle:fr`), à distinguer d'un pack en base (`fr-2026.2`). */
const SOCLE_PREFIX = "socle:";
const populationRef = (v: string) => (v.startsWith(SOCLE_PREFIX) ? { socle: v.slice(SOCLE_PREFIX.length) } : { packVersion: v });

/** Moteurs propres à une installation locale, absents du service hébergé. */
const LOCAL_ONLY_PROVIDERS = ["claude-cli", "ollama"];

export function NewStudyForm({ project, targeting }: { project: ProjectDetail; targeting: ProjectTargeting | null }) {
  const meta = useMeta();
  const t = useDict(projectDict).newStudy;
  const tg = useDict(projectDict).studies;
  const th = useDict(hostedDict).study;
  const thb = useDict(hostedDict).banner;
  const { hosted } = usePlatform();
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
    controlPack: "",
    controlN: "50",
    seed: "7",
    profile: "",
    model: "",
    quotas: "",
    controlQuotas: "",
    sameAs: "",
    sameGroup: "",
    sameN: "",
  });
  // Populations proposées : les packs déjà tirés en base, puis les socles courants (packs/socles.json)
  // absents de la base, tirés à la demande à la création de l'étude (base neuve : les socles seuls)
  const popOptions = useMemo(() => {
    const inDb = new Set((meta?.packs ?? []).map((p) => p.packVersion));
    return [
      ...(meta?.packs ?? []).map((p) => ({ value: p.packVersion, label: t.packOption(p.label, p.n), n: p.n as number | undefined, targeted: p.targeted })),
      ...(meta?.socles ?? [])
        .filter((s) => !inDb.has(s.pack))
        .map((s) => ({ value: `${SOCLE_PREFIX}${s.id}`, label: t.socleOption(s.id, s.pack), n: undefined as number | undefined, targeted: false })),
    ];
  }, [meta, t]);
  // Cible par défaut : la première population ciblée connue, sinon la première population, sinon le premier socle ;
  // témoin par défaut : fr-2026.1 s'il est en base (comportement historique), sinon le socle fr, sinon la cible
  useEffect(() => {
    if (!meta || !popOptions.length) return;
    const has = (v: string) => popOptions.some((o) => o.value === v);
    setF((x) => ({
      ...x,
      targetPack: x.targetPack && has(x.targetPack) ? x.targetPack : (popOptions.find((o) => o.targeted) ?? popOptions[0]!).value,
      controlPack:
        x.controlPack && has(x.controlPack) ? x.controlPack : (["fr-2026.1", `${SOCLE_PREFIX}fr`].find(has) ?? popOptions[0]!.value),
    }));
  }, [meta, popOptions]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Protocole v4 par défaut ; refus d'un pitch au ton commercial (v4 et v3), avec option « forcer » confirmée
  const [protocol, setProtocol] = useState<"4" | "3" | "2">("4");
  const [pitchRefusal, setPitchRefusal] = useState<{ error: string; pitchTone: { score: number; threshold: number; markers: string[] } } | null>(null);
  const [forceOk, setForceOk] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  // Profils de moteur (sans profil configuré : claude-cli et ollama, réglés par l'environnement)
  const allProfiles = meta?.profiles ?? (meta?.backends ?? []).map((b) => ({ name: b.id, provider: b.id, model: b.defaultModel, builtin: true, active: b.id === "claude-cli", paid: false, pricing: "subscription" as const }));
  // Service hébergé : ni claude-cli ni ollama, seulement la clé IA de l'utilisateur
  const profiles = hosted ? allProfiles.filter((p) => !LOCAL_ONLY_PROVIDERS.includes(p.provider)) : allProfiles;
  useEffect(() => {
    if (!meta || f.profile) return;
    const def = profiles.find((p) => p.active) ?? profiles[0];
    if (def) setF((x) => ({ ...x, profile: def.name }));
  }, [meta, f.profile]);
  const selected = profiles.find((p) => p.name === f.profile);
  const [estimate, setEstimate] = useState<CostEstimate | null>(null);
  const [estimateErr, setEstimateErr] = useState<string | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [acceptUnknown, setAcceptUnknown] = useState(false);
  const packN = (v: string) => popOptions.find((o) => o.value === v)?.n;
  // Formulaire manuel sans population choisie : ni estimation ni création (message guidé)
  const missingPopulation = mode === "new" && (!f.targetPack || (f.withControl && !f.controlPack));

  const parseQuotas = (s: string, label: string) => {
    if (!s.trim()) return undefined;
    try {
      return JSON.parse(s) as Record<string, Record<string, number>>;
    } catch {
      throw new Error(t.quotasInvalid(label));
    }
  };

  const buildBody = (forceTone = false) => {
    const common = {
      projectId: project.id,
      seed: Number(f.seed),
      // Profil intégré : même requête qu'avant les profils (backend) ; autre profil : par son nom
      ...(selected?.builtin ? { backend: selected.name } : { profile: f.profile }),
      ...(f.model.trim() && { model: f.model.trim() }),
      ...(f.name.trim() && { name: f.name.trim() }),
      protocolVersion: protocol,
      ...(forceTone && { force: true }),
    };
    return mode === "project"
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
            target: { ...populationRef(f.targetPack), n: Number(f.n), ...(parseQuotas(f.quotas, t.quotasTarget) && { quotas: parseQuotas(f.quotas, t.quotasTarget) }) },
            ...(f.withControl && {
              control: { ...populationRef(f.controlPack), n: Number(f.controlN), ...(parseQuotas(f.controlQuotas, t.quotasControl) && { quotas: parseQuotas(f.controlQuotas, t.quotasControl) }) },
            }),
          };
  };

  // Estimation avant lancement : création simulée côté serveur (aucune écriture, aucun appel au modèle)
  const estimateKey = JSON.stringify([mode, f, pt, protocol]);
  useEffect(() => {
    if (missingPopulation) {
      setEstimate(null);
      setEstimateErr(null);
      return;
    }
    if (!f.profile || (mode === "same" && !f.sameAs)) return;
    let body: unknown;
    try {
      body = buildBody(true);
    } catch {
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      setEstimating(true);
      api<{ estimate: CostEstimate }>("/studies/estimate", { json: body })
        .then((r) => !cancelled && (setEstimate(r.estimate), setEstimateErr(null)))
        .catch((e2: Error) => !cancelled && (setEstimate(null), setEstimateErr(e2.message)))
        .finally(() => !cancelled && setEstimating(false));
    }, 600);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [estimateKey]);
  useEffect(() => setAcceptUnknown(false), [f.profile, f.model]);

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
      const body = { ...buildBody(forceTone), ...(acceptUnknown && { acceptUnknownCost: true }) };
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
            {protocol !== "2" ? t.toneV3 : ""}
          </p>
          <p className="small">
            <Link href={`/projets/${encodeURIComponent(project.id)}/offre/pitch`}>{t.reviewPitch}</Link>
          </p>
        </div>
      )}
      <div className="row">
        <h2 style={{ marginRight: 12 }}>{t.title}</h2>
        <SegmentedControl
          label={t.sampleAria}
          value={mode}
          onChange={setMode}
          options={[
            ...(hasTarget ? [{ id: "project" as const, label: t.modeProject }] : []),
            { id: "new" as const, label: hasTarget ? t.modeManual : t.modeNew },
            { id: "same" as const, label: t.modeSame },
          ]}
        />
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
      ) : mode === "new" && meta && !popOptions.length ? (
        <p className="note-box small" role="status">
          {t.noPopulation}
        </p>
      ) : mode === "new" ? (
        <div className="grid-2">
          <fieldset>
            <legend>{t.targetPopulation}</legend>
            <div className="form-grid">
              <label className="field wide">
                <span>{t.pack}</span>
                <select value={f.targetPack} onChange={set("targetPack")}>
                  {popOptions.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
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
                <textarea rows={3} value={f.quotas} onChange={set("quotas")} aria-label={t.quotasAria} placeholder='{"ageBand":{"18-29":0.3,"30-44":0.7}}' style={{ marginTop: 6 }} />
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
                    {popOptions.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
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
                  <textarea rows={3} value={f.controlQuotas} onChange={set("controlQuotas")} aria-label={t.controlQuotasAria} style={{ marginTop: 6 }} />
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

      <div className="form-grid cols-4">
        <label className="field">
          <span>{t.profile}</span>
          <select value={f.profile} onChange={set("profile")}>
            {profiles.map((p) => (
              <option key={p.name} value={p.name}>
                {t.profileOption(p.name, p.provider, p.model, p.active)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t.model}</span>
          <input type="text" value={f.model} onChange={set("model")} placeholder={selected?.model ?? ""} />
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
        <SegmentedControl
          label={t.questionnaire}
          value={protocol}
          onChange={setProtocol}
          options={[
            { id: "4", label: t.v4, shortLabel: t.v4Short },
            { id: "3", label: t.v3 },
            { id: "2", label: t.v2 },
          ]}
        />
        <p className="small ink2" style={{ maxWidth: "80ch" }}>
          {protocol === "4" ? t.v4Hint : protocol === "3" ? t.v3Hint : t.v2Hint}
        </p>
      </div>
      {effectiveN !== null && effectiveN < 100 && (
        <p className="note-box small">
          {t.smallSample(effectiveN)}
        </p>
      )}
      {selected?.provider === "ollama" && <p className="note-box small">{t.ollama}</p>}
      {hosted && meta && profiles.length === 0 && (
        <p className="note-box small">
          {th.noEngine} <Link href="/compte/moteur">{thb.add}</Link>
        </p>
      )}
      {missingPopulation && popOptions.length > 0 && <p className="small muted">{t.choosePopulation}</p>}
      <EstimateBox estimate={estimate} error={estimateErr} busy={estimating} accept={acceptUnknown} onAccept={setAcceptUnknown} />
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
        <button className="btn" type="submit" disabled={busy || missingPopulation || (hosted && profiles.length === 0) || (estimate?.requiresConfirmation === true && !acceptUnknown)}>
          {busy ? t.creating : t.submit}
        </button>
      </div>
    </form>
  );
}

const usdFmt = (x: number) => (x < 0.01 ? `${x.toFixed(4)} $` : x < 10 ? `${x.toFixed(2)} $` : `${Math.round(x)} $`);

/** Estimation avant lancement : appels, coût (fourchette ±30 %), durée, plafond ; coût inconnu → confirmation. */
function EstimateBox({ estimate, error, busy, accept, onAccept }: { estimate: CostEstimate | null; error: string | null; busy: boolean; accept: boolean; onAccept: (v: boolean) => void }) {
  const t = useDict(projectDict).newStudy;
  if (!estimate && !error && !busy) return null;
  return (
    <div className="note-box small stack" role="status" aria-live="polite" style={{ gap: 4 }}>
      <b>{t.estimateTitle}</b>
      {error && !estimate ? (
        <span className="muted">{t.estimateFailed(error)}</span>
      ) : !estimate ? (
        <span className="muted">{t.estimating}</span>
      ) : (
        <>
          <span>
            {t.estimateCalls(estimate.calls.total, estimate.calls.responses, estimate.calls.repairs, estimate.calls.narratives)} ; {t.estimateDuration(estimate.durationMinutes, estimate.concurrency)}
            {busy ? ` (${t.estimating})` : ""}
          </span>
          <span>
            {estimate.cost.kind === "local"
              ? t.costLocal
              : estimate.cost.kind === "unknown"
                ? t.costUnknown(estimate.model)
                : estimate.cost.kind === "subscription"
                  ? t.costSubscription(usdFmt(estimate.cost.low ?? 0), usdFmt(estimate.cost.high ?? 0))
                  : t.costPaid(usdFmt(estimate.cost.low ?? 0), usdFmt(estimate.cost.high ?? 0), estimate.provider)}
          </span>
          {estimate.limits.perStudyUsd !== undefined && <span>{t.cap(usdFmt(estimate.limits.perStudyUsd), estimate.exceedsStudyCap)}</span>}
          <span className="muted">{t.basis(estimate.basis)}</span>
          {estimate.requiresConfirmation && (
            <label className="small" style={{ display: "flex", flexWrap: "nowrap", gap: 8, alignItems: "flex-start" }}>
              <input type="checkbox" checked={accept} onChange={(e) => onAccept(e.target.checked)} />
              <span>{t.acceptUnknown}</span>
            </label>
          )}
        </>
      )}
    </div>
  );
}
