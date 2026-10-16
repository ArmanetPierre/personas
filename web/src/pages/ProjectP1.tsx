import { useCallback, useEffect, useMemo, useState } from "react";
import { MiniBars } from "../evidence-charts";
import { Link } from "wouter";
import type { TargetPreview } from "../../../src/population/preview";
import { api, ApiError, useApi, type ProjectDetail } from "../api";
import { JobPanel, useJob, type JobState } from "../jobs";
import { useContentLocale, useDict } from "../i18n";
import { projectP1Dict } from "../i18n/projectP1";
import { Cols, dateFr, ErrorBox, int, Loading, num, pct } from "../ui";

/** Écrans du lot P1 sur la page Projet : aperçu de cible, assistant de cible, protocole d'étude. */

// ─── Aperçu de cible ──────────────────────────────────────────────────────────

interface TriageCache {
  result: TargetPreview | null;
  generatedAt: string | null;
  job: JobState | null;
}

export function TargetPreviewPanel({ projectId, hasControl }: { projectId: string; hasControl: boolean }) {
  const [group, setGroup] = useState("target");
  const [seed, setSeed] = useState("42");
  const [quick, setQuick] = useState<TargetPreview | null>(null);
  const [quickErr, setQuickErr] = useState<Error | null>(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<"quick" | "triage" | null>(null);
  const seedN = Number(seed) || 42;
  const cache = useApi<TriageCache>(mode === "triage" ? `/projects/${projectId}/target-preview/triage?group=${group}&seed=${seedN}` : null);
  const reload = useCallback(() => void cache.reload(), [cache]);
  const { job, started } = useJob(`preview-${projectId.replace(/[^A-Za-z0-9_-]+/g, "_")}-${group}-s${seedN}`, cache.data?.job, reload);
  const [startErr, setStartErr] = useState<string | null>(null);
  const t = useDict(projectP1Dict);

  const runQuick = async () => {
    setMode("quick");
    setLoading(true);
    setQuickErr(null);
    try {
      setQuick(await api<TargetPreview>(`/projects/${projectId}/target-preview?group=${group}&seed=${seedN}&sample=10`));
    } catch (e) {
      setQuickErr(e as Error);
    } finally {
      setLoading(false);
    }
  };
  const runTriage = async () => {
    setStartErr(null);
    try {
      const r = await api<{ key: string; pid: number; startedAt: string }>(`/projects/${projectId}/target-preview/triage`, { json: { group, seed: seedN } });
      started(r);
    } catch (e) {
      setStartErr((e as Error).message);
    }
  };

  const shown = mode === "triage" ? cache.data?.result ?? null : quick;
  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <div className="row" style={{ alignItems: "end" }}>
        <h3 style={{ marginRight: 8 }}>{t.preview.title}</h3>
        {hasControl && (
          <label className="field" style={{ width: 130 }}>
            <span>{t.preview.group}</span>
            <select value={group} onChange={(e) => setGroup(e.target.value)}>
              <option value="target">{t.preview.target}</option>
              <option value="control">{t.preview.control}</option>
            </select>
          </label>
        )}
        <label className="field" style={{ width: 110 }}>
          <span>{t.preview.seed}</span>
          <input type="number" value={seed} onChange={(e) => setSeed(e.target.value)} />
        </label>
        <button className="btn" type="button" onClick={runQuick} disabled={loading}>
          {loading ? t.preview.drawing : t.preview.quick}
        </button>
        <button className="btn ghost" type="button" onClick={() => setMode("triage")}>
          {t.preview.triage}
        </button>
      </div>
      <p
        className="small ink2"
        style={{ marginTop: 8 }}
        title={t.preview.help}
      >
        {t.preview.lede}
      </p>

      {mode === "triage" && (
        <div className="stack" style={{ marginTop: 12 }}>
          {cache.loading && !cache.data && <Loading />}
          {cache.data && (
            <div className="row">
              {cache.data.result ? (
                <span className="small ink2">{t.preview.cached(dateFr(cache.data.generatedAt), seedN)}</span>
              ) : (
                <span className="small ink2">{t.preview.noTriage(seedN)}</span>
              )}
              <button className="btn ghost small" type="button" onClick={runTriage} disabled={Boolean(job?.alive)}>
                {cache.data.result ? t.preview.rerun : t.preview.run}
              </button>
            </div>
          )}
          {startErr && <div className="error-box">{startErr}</div>}
          <JobPanel job={job} label={t.preview.jobLabel} hint={t.preview.jobHint} />
        </div>
      )}
      <ErrorBox error={quickErr} />
      {shown && <PreviewView p={shown} />}
    </div>
  );
}

export function PreviewView({ p }: { p: TargetPreview }) {
  const e = p.eligibility;
  const t = useDict(projectP1Dict);
  const v_ = t.view;
  return (
    <div className="stack" style={{ marginTop: 16, gap: 20 }}>
      <div className="kpis">
        <div title={v_.ciTitle(pct(e.ci[0], 2), pct(e.ci[1], 2), int(e.draws))}>
          <b className="num">{pct(e.rate, e.rate < 0.1 ? 2 : 1)}</b>
          <span>{v_.eligible(e.rare)}</span>
        </div>
        <div>
          <b className="num">{p.n}</b>
          <span>{v_.drawn}</span>
        </div>
      </div>
      {[...e.warnings, ...e.shortfalls].length > 0 && <p className="small banner-block" style={{ marginTop: 0 }}>{[...e.warnings, ...e.shortfalls].join(t.listSep)}</p>}
      <details className="more">
        <summary className="small ink2">{v_.techDetails}</summary>
        <dl className="facts" style={{ marginTop: 8 }}>
          <dt>{v_.population}</dt>
          <dd>
            {p.socle}
            {p.modules.length ? ` + ${p.modules.join(", ")}` : ""}
          </dd>
          <dt>{v_.filter}</dt>
          <dd>{p.filter ? <code className="expr">{p.filter}</code> : t.none}</dd>
          <dt>{v_.draws}</dt>
          <dd className="num">{v_.drawsLine(int(e.draws), e.eligible)}</dd>
        </dl>
      </details>
      {p.triage && <TriageView t={p.triage} />}
      <div>
        <h4 style={{ margin: "0 0 8px" }}>{v_.distributions(p.n)}</h4>
        <div className="margins">
          {p.distributions.map((d) => (
            <div className="margin" key={d.key}>
              <h4>
                {d.label} {d.inFilter && <span className="tag">{v_.filterTag}</span>}
                {d.multi && <span className="muted small" style={{ fontWeight: 400 }}>{v_.multi}</span>}
              </h4>
              {d.values.slice(0, 8).map((v) => (
                <div className={`mbar${v.value === "na" ? " na" : ""}`} key={v.value} title={v_.barTitle(v.label, pct(v.share, 1), v.count)}>
                  <span className="l">{v.label}</span>
                  <span className="t" aria-hidden="true">
                    <i style={{ width: `${Math.min(1, v.share) * 100}%` }} />
                  </span>
                  <span className="num small" style={{ textAlign: "right" }}>
                    {pct(v.share, v.share < 0.1 ? 1 : 0)}
                  </span>
                </div>
              ))}
              {d.values.length > 8 && <p className="small muted">{v_.more(d.values.length - 8)}</p>}
            </div>
          ))}
        </div>
      </div>
      {p.cards.length > 0 && (
        <details className="more">
          <summary>
            <b>{v_.cards(p.cards.length)}</b> <span className="small ink2">{v_.cardsSub}</span>
          </summary>
          <div className="cards" style={{ marginTop: 10 }}>
            {p.cards.map((c) => (
              <div className="panel" key={c.id}>
                <div className="small muted num" style={{ marginBottom: 6 }}>{c.id}</div>
                <p className="small" style={{ whiteSpace: "pre-line" }}>{c.card}</p>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

type Triage = NonNullable<TargetPreview["triage"]>;

/** Jauge de la part estimée de « pas concernées », avec son intervalle et le seuil d'alerte. */
export function NcGauge({ share, ci, alertShare }: { share: number; ci: [number, number]; alertShare: number }) {
  const max = Math.max(0.3, ci[1] * 1.25, alertShare * 2);
  const x = (v: number) => `${(Math.min(v, max) / max) * 100}%`;
  const t = useDict(projectP1Dict);
  return (
    <div className="gauge" role="img" aria-label={t.gauge.aria(pct(share), pct(ci[0]), pct(ci[1]), pct(alertShare))}>
      <div className="gauge-track">
        <span className="gauge-band" style={{ left: x(ci[0]), width: `calc(${x(ci[1])} - ${x(ci[0])})` }} />
        <span className="gauge-dot" style={{ left: x(share) }} />
        <span className="gauge-threshold" style={{ left: x(alertShare) }} />
      </div>
      <div className="gauge-axis small muted num">
        <span>{t.gauge.zero}</span>
        <span style={{ left: x(alertShare) }}>{t.gauge.threshold(pct(alertShare))}</span>
        <span style={{ right: 0 }}>{pct(max)}</span>
      </div>
    </div>
  );
}

function TriageView({ t }: { t: Triage }) {
  const d = useDict(projectP1Dict);
  const tt = d.triage;
  const crit = (pr: Triage["profiles"][number]) => pr.criteria.map((c) => `${c.label} = ${c.valueLabel}`).join(tt.and);
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className={t.alert ? "banner-block" : "panel"} style={{ marginTop: 0 }}>
        <div className="row" style={{ alignItems: "baseline", gap: 14 }}>
          <span>{tt.share}</span>
          <b style={{ fontFamily: "var(--font-display)", fontSize: 28 }}>{pct(t.share)}</b>
          <span className="small ink2 num">{tt.interval(pct(t.ci[0]), pct(t.ci[1]), t.n)}</span>
          {t.alert && <span className="tag warn">{tt.alert(pct(t.alertShare))}</span>}
        </div>
        <NcGauge share={t.share} ci={t.ci} alertShare={t.alertShare} />
        <p className="small ink2" style={{ marginTop: 8 }} title={tt.note(t.model, t.calls, t.cachedCalls, t.failed)}>
          {t.message}
        </p>
      </div>
      {t.profiles.length > 0 && (
        <div>
          <h4 style={{ margin: "0 0 6px" }}>{tt.who}</h4>
          <MiniBars
            title={tt.chartTitle}
            scale="full"
            series={[{ key: "p", label: "", color: "var(--g-control)" }]}
            rows={t.profiles.slice(0, 6).map((pr) => ({ label: `${crit(pr)} (n = ${pr.n}, × ${num(pr.lift, 1)})`, values: [pr.rate] }))}
          />
          <details className="more" style={{ marginTop: 6 }}>
            <summary className="small ink2">{tt.tableSummary}</summary>
          <div className="table-wrap">
              <table className="table fixed small">
                <Cols widths={[null, 70, 110, 80, 90]} />
                <thead>
                  <tr>
                    <th>{tt.thProfile}</th>
                    <th className="r">n</th>
                    <th className="r">{tt.thNc}</th>
                    <th className="r">{tt.thLift}</th>
                    <th className="r">{tt.thReview}</th>
                  </tr>
                </thead>
                <tbody>
                  {t.profiles.map((pr, i) => (
                    <tr key={i}>
                      <td>{crit(pr)}</td>
                      <td className="r num">{pr.n}</td>
                      <td className="r num">{pct(pr.rate)}</td>
                      <td className="r num">× {num(pr.lift, 1)}</td>
                      <td className="r num">{pr.inReview}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </div>
      )}
      {t.review.length > 0 && (
        <details>
          <summary style={{ cursor: "pointer" }}>
            <b>{tt.review(t.review.length)}</b> <span className="small ink2">{tt.reviewSub}</span>
          </summary>
          <div className="cards" style={{ marginTop: 10 }}>
            {t.review.map((r) => (
              <div className="panel" key={r.id}>
                <div className="row small" style={{ justifyContent: "space-between", marginBottom: 6 }}>
                  <span className="muted num">{r.id}</span>
                  <span className="tag">{tt.ncTag(pct(r.notConcerned))}</span>
                </div>
                <p className="small" style={{ whiteSpace: "pre-line" }}>{r.card}</p>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

/** Diff ligne à ligne (« - » retiré, « + » ajouté), puis l'avant et l'après complets à déplier. */
export function DiffView({ diff, before, after }: { diff?: string | undefined; before: string; after: string }) {
  const t = useDict(projectP1Dict).diff;
  return (
    <div className="stack" style={{ gap: 8 }}>
      {diff !== undefined && (
        <pre className="yaml diff" aria-label={t.aria}>
          {diff.trim()
            ? diff.split("\n").map((l, i) => (
                <span key={i} className={l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : undefined}>
                  {l}
                  {"\n"}
                </span>
              ))
            : t.none}
        </pre>
      )}
      <details>
        <summary className="small ink2" style={{ cursor: "pointer" }}>{t.full}</summary>
        <div className="grid-2" style={{ marginTop: 8 }}>
          <div>
            <p className="small ink2">{t.before}</p>
            <pre className="yaml">{before}</pre>
          </div>
          <div>
            <p className="small ink2">{t.after}</p>
            <pre className="yaml">{after}</pre>
          </div>
        </div>
      </details>
    </div>
  );
}

// ─── Assistant de cible ──────────────────────────────────────────────────────

interface SuggestionVariant {
  id: string;
  label: string;
  description?: string;
  target: Record<string, unknown> & { modules?: string[]; eligibility?: string; quotas?: Record<string, Record<string, number>>; n?: number };
  justification?: Array<{ criterion: string; why: string }>;
  quotasWhy?: string[];
  errors?: string[];
  preview?: {
    eligibilityPct: number;
    ciPct: number[];
    draws: number;
    rare: boolean;
    pcs?: Record<string, number>;
    outsideFilter?: Record<string, Record<string, number>>;
    triage?: { notConcernedPct: number; ciPct: number[]; alert: boolean; message: string };
  };
}
interface SuggestionDoc {
  generatedAt?: string;
  model?: string;
  analysis?: string;
  usageConditions?: Array<{ condition: string; attribute?: string | null; why: string }>;
  variants?: SuggestionVariant[];
  missingModules?: Array<{ id: string; description: string; attributes?: string[]; why: string }>;
  notes?: string[];
  usage?: Record<string, number>;
}

export function TargetSuggestionPanel({ projectId, onApplied }: { projectId: string; onApplied: () => void }) {
  const [open, setOpen] = useState(false);
  const data = useApi<{ suggestion: SuggestionDoc | null; file: string | null; job: JobState | null; currentYaml: string }>(open ? `/projects/${projectId}/target-suggestion` : null);
  const reload = useCallback(() => void data.reload(), [data]);
  const { job, started } = useJob(`suggest-${projectId.replace(/[^A-Za-z0-9_-]+/g, "_")}`, data.data?.job, reload);
  const [err, setErr] = useState<string | null>(null);
  const propose = async () => {
    setErr(null);
    try {
      started(await api<{ key: string; pid: number; startedAt: string }>(`/projects/${projectId}/target-suggestion`, { method: "POST" }));
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const s = data.data?.suggestion;
  const t = useDict(projectP1Dict);
  const ts = t.suggest;
  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <div className="row">
        <h3 style={{ marginRight: 8 }}>{ts.title}</h3>
        {!open ? (
          <button className="btn ghost" type="button" onClick={() => setOpen(true)}>
            {ts.see}
          </button>
        ) : (
          <button className="btn" type="button" onClick={propose} disabled={Boolean(job?.alive)}>
            {s ? ts.proposeNew : ts.propose}
          </button>
        )}
        <span className="small ink2">{ts.intro}</span>
      </div>
      {err && <div className="error-box" style={{ marginTop: 10 }}>{err}</div>}
      <JobPanel job={job} label={ts.jobLabel} hint={ts.jobHint} />
      {open && data.loading && !data.data && <Loading />}
      {open && data.data && !s && !job?.alive && <p className="ink2" style={{ marginTop: 10 }}>{ts.empty}</p>}
      {s && (
        <div className="stack" style={{ marginTop: 14, gap: 18 }}>
          <p className="small muted">
            {data.data?.file}{t.listSep}{s.model}, {dateFr(s.generatedAt)}
          </p>
          {s.analysis && <p style={{ maxWidth: "80ch" }}>{s.analysis}</p>}
          {s.usageConditions && s.usageConditions.length > 0 && (
            <div className="table-wrap">
              <table className="table fixed small">
                <Cols widths={[220, 260, null]} />
                <thead>
                  <tr>
                    <th>{ts.thCondition}</th>
                    <th>{ts.thAttribute}</th>
                    <th>{ts.thWhy}</th>
                  </tr>
                </thead>
                <tbody>
                  {s.usageConditions.map((u, i) => (
                    <tr key={i}>
                      <td>{u.condition}</td>
                      <td>{u.attribute ? <code className="expr">{u.attribute}</code> : <span className="muted">{t.none}</span>}</td>
                      <td className="ink2">{u.why}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {(s.variants ?? []).map((v) => (
            <VariantCard key={v.id} v={v} projectId={projectId} currentYaml={data.data!.currentYaml} onApplied={onApplied} />
          ))}
          {s.missingModules && s.missingModules.length > 0 && (
            <div>
              <h4 style={{ margin: "0 0 6px" }}>{ts.missing}</h4>
              <ul className="notes">
                {s.missingModules.map((m) => (
                  <li key={m.id}>
                    <b>{m.id}</b>{t.colon}{m.description} <span className="ink2">({m.why})</span>{" "}
                    <Link href={`/modules/nouveau?project=${projectId}`}>{ts.proposeModule}</Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {s.notes && s.notes.length > 0 && (
            <ul className="notes small ink2">
              {s.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function VariantCard({ v, projectId, currentYaml, onApplied }: { v: SuggestionVariant; projectId: string; currentYaml: string; onApplied: () => void }) {
  const [diff, setDiff] = useState<{ before: string; after: string; diff?: string; errors: Array<{ path: string; message: string }> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const p = v.preview;
  const t = useDict(projectP1Dict);
  const tv = t.variant;
  const prepare = async () => {
    setMsg(null);
    try {
      const r = await api<{ ok: boolean; errors: Array<{ path: string; message: string }>; before: string; after: string; diff: string }>(`/projects/${projectId}/blocks/target/validate`, { json: { value: v.target } });
      setDiff({ before: r.before, after: r.after, diff: r.diff, errors: r.errors });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  };
  const apply = async () => {
    setBusy(true);
    try {
      const r = await api<{ source: string; file?: string; backup: string }>(`/projects/${projectId}/blocks/target`, { method: "PUT", json: { value: v.target, confirm: true } });
      setMsg({ ok: true, text: t.replaced("target", r.source === "file", r.file, r.backup) });
      setDiff(null);
      onApplied();
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as { errors?: Array<{ path: string; message: string }> }) : {};
      setMsg({ ok: false, text: `${(e as Error).message}${body.errors ? ` ${t.errs(body.errors)}` : ""}` });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="variant">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
        <h4 style={{ margin: 0, fontSize: 16 }}>{v.label}</h4>
        <span className="small muted num">{v.id}</span>
      </div>
      {v.description && <p className="small ink2" style={{ marginTop: 4 }}>{v.description}</p>}
      <dl className="facts" style={{ marginTop: 10 }}>
        <dt>{tv.modules}</dt>
        <dd>{(v.target.modules ?? []).join(", ") || t.none}</dd>
        <dt>{t.view.filter}</dt>
        <dd>{v.target.eligibility ? <code className="expr">{v.target.eligibility}</code> : t.none}</dd>
        {v.target.quotas && (
          <>
            <dt>{tv.quotas}</dt>
            <dd className="small">
              {Object.entries(v.target.quotas)
                .map(([d, q]) => `${d}${t.colon}${Object.entries(q).map(([c, x]) => `${c} ${t.pctRaw(String(Math.round(x * 100)))}`).join(", ")}`)
                .join(t.listSep)}
            </dd>
          </>
        )}
        {p && (
          <>
            <dt>{tv.eligibility}</dt>
            <dd className="num">
              <b>{t.pctRaw(num(p.eligibilityPct, 3))}</b> [{p.ciPct.map((x) => num(x, 3)).join(t.listSep)}] {tv.overDraws(int(p.draws))}
              {p.rare && <span className="tag warn" style={{ marginLeft: 8 }}>{tv.rare}</span>}
            </dd>
            {p.pcs && (
              <>
                <dt>{tv.pcs}</dt>
                <dd className="small">{Object.entries(p.pcs).map(([k, x]) => `${k} ${t.pctRaw(num(x, 3))}`).join(", ")}</dd>
              </>
            )}
            {p.triage && (
              <>
                <dt>{tv.pretriage}</dt>
                <dd className="small">
                  {t.pctRaw(num(p.triage.notConcernedPct, 3))} {tv.notConcerned} {p.triage.alert && <span className="tag warn">{tv.alert}</span>}
                </dd>
              </>
            )}
          </>
        )}
      </dl>
      {p?.outsideFilter && (
        <p className="small ink2" style={{ marginTop: 6 }}>
          {tv.outside}{" "}
          {Object.entries(p.outsideFilter)
            .map(([k, vals]) => `${k} (${Object.entries(vals).map(([l, x]) => `${l} ${t.pctRaw(num(x, 3))}`).join(", ")})`)
            .join(t.listSep)}
        </p>
      )}
      {v.justification && v.justification.length > 0 && (
        <details style={{ marginTop: 8 }}>
          <summary className="small" style={{ cursor: "pointer" }}>{tv.justification(v.justification.length)}</summary>
          <ul className="notes small" style={{ marginTop: 6 }}>
            {v.justification.map((j, i) => (
              <li key={i}>
                <b>{j.criterion}</b>{t.colon}{j.why}
              </li>
            ))}
            {(v.quotasWhy ?? []).map((q, i) => (
              <li key={`q${i}`}>{q}</li>
            ))}
          </ul>
        </details>
      )}
      {v.errors && v.errors.length > 0 && <div className="error-box" style={{ marginTop: 8 }}>{tv.invalid(v.errors.join(t.listSep))}</div>}
      {!diff ? (
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn ghost small" type="button" onClick={prepare} disabled={Boolean(v.errors?.length)}>
            {tv.apply}
          </button>
        </div>
      ) : (
        <div className="banner-block stack" role="alertdialog" aria-label={tv.confirmAria} style={{ marginTop: 10 }}>
          <p>
            {tv.replaceA}
            <code>target</code>
            {tv.replaceB}
          </p>
          <DiffView diff={diff.diff} before={diff.before || currentYaml} after={diff.after} />
          {diff.errors.length > 0 && <div className="error-box">{t.errs(diff.errors)}</div>}
          <div className="row">
            <button className="btn" type="button" onClick={apply} disabled={busy || diff.errors.length > 0}>
              {busy ? t.applying : tv.replace}
            </button>
            <button className="btn ghost" type="button" onClick={() => setDiff(null)} disabled={busy}>
              {t.cancel}
            </button>
          </div>
        </div>
      )}
      {msg && <p className="small" style={{ marginTop: 8, color: msg.ok ? "var(--ok)" : "var(--danger)" }}>{msg.text}</p>}
    </div>
  );
}

// ─── Protocole d'étude ────────────────────────────────────────────────────────

export interface BehaviorDefV {
  code: string;
  label: string;
  description: string;
  level: string;
  short?: string;
}
export interface ObjectionDefV {
  code: string;
  label: string;
  description: string;
  canonical: string;
  short?: string;
}
export interface RelevanceDefV {
  code: string;
  label: string;
  description: string;
  canonical: string;
}
export interface ProtocolV {
  productType?: string;
  behaviors?: BehaviorDefV[];
  objections?: ObjectionDefV[];
  relevance?: RelevanceDefV[];
  rationale?: string;
}
export interface ProtocolResponse {
  raw: ProtocolV | null;
  resolved: { custom: boolean; productType?: string; behaviors: BehaviorDefV[]; objections: ObjectionDefV[]; relevance: RelevanceDefV[] };
  proposal: {
    protocol: ProtocolV | null;
    rationale: string | null;
    generatedAt: string | null;
    model: string | null;
    fixes: string[];
    evidence: { studies: string[]; respondents: number | null; shares: Record<string, number> } | null;
    file: string;
  } | null;
  job: JobState | null;
  vocab: {
    productTypes: Array<{ id: string; label: string }>;
    levels: Array<{ id: string; label: string }>;
    objections: Array<{ id: string; label: string }>;
    relevance: Array<{ id: string; label: string }>;
  };
}

export const labelOf = (list: Array<{ id: string; label: string }>, id: string | undefined) => list.find((x) => x.id === id)?.label ?? id ?? "—";

export function ProtocolTables({ p, vocab }: { p: ProtocolResponse["resolved"]; vocab: ProtocolResponse["vocab"] }) {
  const t = useDict(projectP1Dict).tables;
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div>
        <h4 style={{ margin: "0 0 6px" }}>{t.behaviors}</h4>
        <div className="table-wrap">
          <table className="table fixed small">
            <Cols widths={[200, 140, null]} />
            <thead>
              <tr>
                <th>{t.thBehavior}</th>
                <th title={t.canonicalLevel}>{t.commonLevel}</th>
                <th>{t.whatPersonaDoes}</th>
              </tr>
            </thead>
            <tbody>
              {p.behaviors.map((b) => (
                <tr key={b.code}>
                  <td>
                    <span className="cell-title">{b.label}</span>
                    <span className="cell-sub num">{b.code}</span>
                  </td>
                  <td>
                    <span className={`lvl lvl-${b.level}`}>{labelOf(vocab.levels, b.level)}</span>
                  </td>
                  <td className="ink2">{b.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="grid-2">
        <div>
          <h4 style={{ margin: "0 0 6px" }}>{t.objections}</h4>
          <div className="table-wrap">
            <table className="table fixed small">
              <Cols widths={[null, 150]} />
              <thead>
                <tr>
                  <th>{t.category}</th>
                  <th title={t.canonicalCategory}>{t.commonCategory}</th>
                </tr>
              </thead>
              <tbody>
                {p.objections.map((o) => (
                  <tr key={o.code}>
                    <td>
                      <span className="cell-title">{o.label}</span>
                      <span className="cell-sub">{o.description}</span>
                    </td>
                    <td className="ink2">{labelOf(vocab.objections, o.canonical)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div>
          <h4 style={{ margin: "0 0 6px" }}>{t.relevance}</h4>
          <div className="table-wrap">
            <table className="table fixed small">
              <Cols widths={[null, 150]} />
              <thead>
                <tr>
                  <th>{t.level}</th>
                  <th title={t.canonicalCategory}>{t.commonCategory}</th>
                </tr>
              </thead>
              <tbody>
                {p.relevance.map((r) => (
                  <tr key={r.code}>
                    <td>
                      <span className="cell-title">{r.label}</span>
                      <span className="cell-sub">{r.description}</span>
                    </td>
                    <td className="ink2">{labelOf(vocab.relevance, r.canonical)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ProtocolPanel({ projectId }: { projectId: string }) {
  const data = useApi<ProtocolResponse>(`/projects/${projectId}/protocol`);
  const reload = useCallback(() => void data.reload(), [data]);
  const { job, started } = useJob(`protocol-${projectId.replace(/[^A-Za-z0-9_-]+/g, "_")}`, data.data?.job, reload);
  const [err, setErr] = useState<string | null>(null);
  const [show, setShow] = useState(false);
  const t = useDict(projectP1Dict).panel;
  const propose = async () => {
    setErr(null);
    try {
      started(await api<{ key: string; pid: number; startedAt: string }>(`/projects/${projectId}/protocol/suggest`, { method: "POST" }));
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  if (data.error) return <ErrorBox error={data.error} />;
  if (!data.data) return <Loading />;
  const d = data.data;
  return (
    <div className="section">
      <div className="section-head">
        <h2>{t.title}</h2>
        <div className="row">
          {d.proposal && (
            <Link className="btn ghost small" href={`/projets/${projectId}/protocole/revue`}>
              {t.review}
            </Link>
          )}
          <button className="btn ghost small" type="button" onClick={propose} disabled={Boolean(job?.alive)}>
            {t.propose}
          </button>
        </div>
      </div>
      <div className="panel stack">
        {d.resolved.custom ? (
          <p>
            {t.customA}
            <b>{labelOf(d.vocab.productTypes, d.resolved.productType)}</b>
            {t.customB}
          </p>
        ) : (
          <p>
            <b>{t.standardA}</b>
            {t.standardB}
          </p>
        )}
        {d.proposal && (
          <p className="small ink2">
            {t.pending(dateFr(d.proposal.generatedAt), d.proposal.file)}
          </p>
        )}
        {err && <div className="error-box">{err}</div>}
        <JobPanel job={job} label={t.jobLabel} hint={t.jobHint} />
        <button className="btn ghost small" type="button" style={{ alignSelf: "start" }} onClick={() => setShow(!show)} aria-expanded={show}>
          {show ? t.hide : t.show}
        </button>
        {show && <ProtocolTables p={d.resolved} vocab={d.vocab} />}
      </div>
    </div>
  );
}

// ─── Revue d'une proposition de protocole ────────────────────────────────────

type Editable = { productType: string; behaviors: BehaviorDefV[]; objections: ObjectionDefV[]; relevance: RelevanceDefV[]; rationale?: string };

export function ProtocolReviewPage({ id }: { id: string }) {
  const data = useApi<ProtocolResponse>(`/projects/${id}/protocol`);
  // Le protocole n'expose pas la langue du projet : lue sur la fiche projet
  const proj = useApi<{ project: ProjectDetail }>(`/projects/${encodeURIComponent(id)}`);
  useContentLocale(proj.data?.project.locale);
  const t = useDict(projectP1Dict);
  const tr_ = t.review;
  const [p, setP] = useState<Editable | null>(null);
  const [check, setCheck] = useState<{ ok: boolean; errors: Array<{ path: string; message: string }>; before: string; after: string; diff?: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!data.data || p) return;
    const src = data.data.proposal?.protocol ?? data.data.raw;
    const r = data.data.resolved;
    setP({
      productType: src?.productType ?? r.productType ?? "online_service",
      behaviors: (src?.behaviors ?? r.behaviors).map((b) => ({ ...b })),
      objections: (src?.objections ?? r.objections).map((o) => ({ ...o })),
      relevance: (src?.relevance ?? r.relevance).map((x) => ({ ...x })),
      ...(src?.rationale && { rationale: src.rationale }),
    });
  }, [data.data, p]);

  const value = useMemo(() => (p ? clean(p) : null), [p]);
  // Validation du schéma pendant la saisie
  useEffect(() => {
    if (!value) return;
    const t = setTimeout(async () => {
      try {
        setCheck(await api(`/projects/${id}/blocks/protocol/validate`, { json: { value } }));
      } catch (e) {
        setCheck({ ok: false, errors: [{ path: "", message: (e as Error).message }], before: "", after: "" });
      }
    }, 400);
    return () => clearTimeout(t);
  }, [value, id]);

  if (data.error) return <ErrorBox error={data.error} />;
  if (!data.data || !p) return <Loading />;
  const d = data.data;
  const set = (patch: Partial<Editable>) => {
    setConfirming(false);
    setP({ ...p, ...patch });
  };
  const apply = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ source: string; file?: string; backup: string }>(`/projects/${id}/blocks/protocol`, { method: "PUT", json: { value, confirm: true } });
      setMsg({ ok: true, text: t.replaced("protocol", r.source === "file", r.file, r.backup) });
      setConfirming(false);
      void data.reload();
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as { errors?: Array<{ path: string; message: string }> }) : {};
      setMsg({ ok: false, text: `${(e as Error).message}${body.errors ? ` ${t.errs(body.errors)}` : ""}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="crumbs">
        <Link href="/">{tr_.projects}</Link>
        <span>/</span>
        <Link href={`/projets/${id}`}>{id}</Link>
        <span>/</span>
        <Link href={`/projets/${id}/protocole`}>{tr_.questionnaire}</Link>
        <span>/</span>
        <span>{tr_.crumb}</span>
      </div>
      <h1>{tr_.title}</h1>
      <p className="lede" style={{ marginTop: 10 }}>
        {d.proposal ? tr_.proposal(d.proposal.model ?? "?", dateFr(d.proposal.generatedAt)) : tr_.noProposal}
        {tr_.lede}
      </p>
      {(d.proposal?.rationale || p.rationale) && (
        <div className="panel" style={{ marginTop: 18 }}>
          <h3 style={{ marginBottom: 6 }}>{tr_.rationale}</h3>
          <p style={{ maxWidth: "80ch" }}>{d.proposal?.rationale ?? p.rationale}</p>
          {d.proposal?.evidence && (
            <p className="small ink2" style={{ marginTop: 8 }}>
              {tr_.evidence(
                d.proposal.evidence.respondents ?? "?",
                d.proposal.evidence.studies.join(", "),
                Object.entries(d.proposal.evidence.shares)
                  .map(([k, x]) => `${k} ${pct(x)}`)
                  .join(", "),
              )}
            </p>
          )}
          {d.proposal?.fixes && d.proposal.fixes.length > 0 && <p className="small muted">{tr_.fixes(d.proposal.fixes.join(t.listSep))}</p>}
        </div>
      )}

      <div className="panel stack" style={{ marginTop: 16 }}>
        <label className="field" style={{ maxWidth: 320 }}>
          <span>{tr_.productType}</span>
          <select value={p.productType} onChange={(e) => set({ productType: e.target.value })}>
            {d.vocab.productTypes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <EditList
        title={t.tables.behaviors}
        hint={tr_.behaviorsHint}
        rows={p.behaviors}
        onChange={(behaviors) => set({ behaviors })}
        make={() => ({ ...tr_.newBehavior, level: "interest" })}
        selectKey="level"
        selectLabel={tr_.level}
        options={d.vocab.levels}
      />
      <EditList
        title={t.tables.objections}
        hint={tr_.objectionsHint}
        rows={p.objections}
        onChange={(objections) => set({ objections })}
        make={() => ({ ...tr_.newObjection, canonical: "other" })}
        selectKey="canonical"
        selectLabel={tr_.canonical}
        options={d.vocab.objections}
      />
      <EditList
        title={t.tables.relevance}
        hint={tr_.relevanceHint}
        rows={p.relevance}
        onChange={(relevance) => set({ relevance })}
        make={() => ({ ...tr_.newLevel, canonical: "marginal" })}
        selectKey="canonical"
        selectLabel={tr_.canonical}
        options={d.vocab.relevance}
        noShort
      />

      <section className="section">
        <div className="section-head">
          <h2>{tr_.applyTitle}</h2>
          <span className="small ink2" aria-live="polite">{!check ? tr_.validating : check.ok ? tr_.valid : tr_.errors(check.errors.length)}</span>
        </div>
        <div className="panel stack">
          {check && check.errors.length > 0 && (
            <div className="alerts">
              {check.errors.map((e, i) => (
                <div className="alert error" key={i}>
                  <span className="lvl">{tr_.error}</span>
                  <span>
                    {e.path && <code className="expr">{e.path}</code>} {e.message}
                  </span>
                </div>
              ))}
            </div>
          )}
          <p className="ink2 small" style={{ maxWidth: "80ch" }}>
            {tr_.blockA}
            <code>protocol</code>
            {tr_.blockB}
          </p>
          {!confirming ? (
            <div className="row">
              <button className="btn" type="button" disabled={!check?.ok} onClick={() => setConfirming(true)}>
                {tr_.apply}
              </button>
            </div>
          ) : (
            <div className="banner-block stack" role="alertdialog" aria-label={tr_.confirmAria}>
              <p>{tr_.confirmQ(id)}</p>
              {check && <DiffView diff={check.diff} before={check.before} after={check.after} />}
              <div className="row">
                <button className="btn" type="button" onClick={apply} disabled={busy || !check?.ok}>
                  {busy ? t.applying : tr_.confirm}
                </button>
                <button className="btn ghost" type="button" onClick={() => setConfirming(false)} disabled={busy}>
                  {t.cancel}
                </button>
              </div>
            </div>
          )}
          {msg && <p className="small" style={{ color: msg.ok ? "var(--ok)" : "var(--danger)" }}>{msg.text}</p>}
        </div>
      </section>
    </>
  );
}

/** Retire les champs vides avant validation (short facultatif). */
function clean(p: Editable): Record<string, unknown> {
  const strip = <T extends { short?: string }>(x: T) => {
    const { short, ...rest } = x;
    return short && short.trim() ? { ...rest, short: short.trim() } : rest;
  };
  return {
    productType: p.productType,
    behaviors: p.behaviors.map(strip),
    objections: p.objections.map(strip),
    relevance: p.relevance,
    ...(p.rationale && { rationale: p.rationale }),
  };
}

function EditList<T extends { code: string; label: string; description: string; short?: string } & Record<string, unknown>>({
  title,
  hint,
  rows,
  onChange,
  make,
  selectKey,
  selectLabel,
  options,
  noShort,
}: {
  title: string;
  hint: string;
  rows: T[];
  onChange: (rows: T[]) => void;
  make: () => T;
  selectKey: string;
  selectLabel: string;
  options: Array<{ id: string; label: string }>;
  noShort?: boolean;
}) {
  const t = useDict(projectP1Dict).edit;
  const upd = (i: number, patch: Partial<T>) => onChange(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= rows.length) return;
    const next = [...rows];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };
  return (
    <section className="section">
      <div className="section-head">
        <h2>{title}</h2>
        <p className="small ink2">{hint}</p>
      </div>
      <div className="panel stack">
        {rows.map((r, i) => (
          <div className="edit-row" key={i}>
            <label className="field">
              <span>{t.code}</span>
              <input type="text" value={r.code} onChange={(e) => upd(i, { code: e.target.value } as Partial<T>)} />
            </label>
            <label className="field">
              <span>{t.label}</span>
              <input type="text" value={r.label} onChange={(e) => upd(i, { label: e.target.value } as Partial<T>)} />
            </label>
            <label className="field">
              <span>{selectLabel}</span>
              <select value={String(r[selectKey] ?? "")} onChange={(e) => upd(i, { [selectKey]: e.target.value } as Partial<T>)}>
                {options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            {!noShort && (
              <label className="field">
                <span>{t.short}</span>
                <input type="text" maxLength={10} value={r.short ?? ""} onChange={(e) => upd(i, { short: e.target.value } as Partial<T>)} />
              </label>
            )}
            <label className="field wide">
              <span>{t.description}</span>
              <input type="text" value={r.description} onChange={(e) => upd(i, { description: e.target.value } as Partial<T>)} />
            </label>
            <div className="edit-actions">
              <button className="btn ghost small" type="button" aria-label={t.up} onClick={() => move(i, -1)} disabled={i === 0}>
                ↑
              </button>
              <button className="btn ghost small" type="button" aria-label={t.down} onClick={() => move(i, 1)} disabled={i === rows.length - 1}>
                ↓
              </button>
              <button className="btn ghost small" type="button" onClick={() => onChange(rows.filter((_, k) => k !== i))}>
                {t.remove}
              </button>
            </div>
          </div>
        ))}
        <div className="row">
          <button className="btn ghost small" type="button" onClick={() => onChange([...rows, make()])}>
            {t.add}
          </button>
        </div>
      </div>
    </section>
  );
}
