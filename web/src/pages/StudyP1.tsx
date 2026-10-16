import { useCallback, useState } from "react";
import type { DriversResult } from "../../../src/studies/drivers";
import { api, useApi, type Meta, type SummaryResponse } from "../api";
import { groupColor, HBars } from "../charts";
import { JobPanel, useJob, type JobState } from "../jobs";
import { Cols, num, pct, Seg } from "../ui";
import { tr, useDict } from "../i18n";
import { studyDict } from "../i18n/study";

/** Sections du lot P1 sur la page Étude : facteurs d'engagement, objections recodées. */

// ─── Facteurs d'engagement ────────────────────────────────────────────────────

const fmtP = (x: number) => (x < 0.001 ? tr(studyDict).drivers.pBelow : num(x, 3));

export function DriversSection({ d, levelLabels }: { d: DriversResult; levelLabels?: Record<string, string> | undefined }) {
  const t = useDict(studyDict).drivers;
  const usable = d.outcomes.filter((o) => o.factors.length > 0);
  const [level, setLevel] = useState<string>(usable[0]?.level ?? d.outcomes[0]?.level ?? "interest");
  const [all, setAll] = useState(false);
  const o = d.outcomes.find((x) => x.level === level) ?? d.outcomes[0];
  if (!o) return null;
  const factors = all ? o.factors : o.factors.slice(0, 6);
  return (
    <section className="section" id="facteurs">
      <div className="section-head">
        <h2>{t.title}</h2>
        <Seg
          label={t.level}
          value={level}
          onChange={(l) => {
            setLevel(l);
            setAll(false);
          }}
          options={d.outcomes.map((x) => ({ id: x.level, label: `${levelLabels?.[x.level] ?? x.label.split(" (")[0]} (${x.positives})` }))}
        />
      </div>
      <p className="small ink2" style={{ marginBottom: 12, maxWidth: "85ch" }}>
        <span title={t.scope(d.group || null, d.n)}>{t.sub}</span>
      </p>
      <div className="panel">
        <p>{t.rate(o.label, o.positives, o.n, pct(o.rate))}</p>
        {o.note && <p className="note-box small" style={{ marginTop: 8 }}>{o.note}</p>}
        {o.factors.length === 0 && !o.note && <p className="ink2" style={{ marginTop: 8 }}>{t.noFactor}</p>}
        <div style={{ marginTop: 14 }}>
          {factors.map((f) => {
            const sig = f.q < 0.05;
            const max = Math.max(o.rate * 1.5, ...f.values.map((v) => v.ci[1]), 0.05) * 1.05;
            const x = (v: number) => `${(Math.min(v, max) / max) * 100}%`;
            return (
              <div className="driver" key={f.dimension}>
                <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
                  <h3 style={{ fontSize: 16 }}>
                    {f.label} <span className="muted small" style={{ fontWeight: 400 }}>({f.source === "module" ? t.module : t.socle})</span>
                  </h3>
                  <span className="small num ink2">
                    {t.stat(num(f.cramersV, 2), fmtP(f.q))}{" "}
                    <span className={`tag${sig ? "" : " warn"}`}>{sig ? t.significant : t.fragile}</span>
                  </span>
                </div>
                {f.sentence && <p style={{ marginTop: 4 }}>{f.sentence}</p>}
                <div className="ci-bars" role="table" aria-label={t.ratesAria(f.label)}>
                  {f.values.map((v) => (
                    <div key={v.code} style={{ display: "contents" }} role="row">
                      <span role="cell" className={v.small ? "muted" : undefined}>
                        {v.label} <span className="muted num">n = {v.n}</span>
                      </span>
                      <span className="ci-track" role="cell" aria-label={t.ciAria(pct(v.rate), pct(v.ci[0]), pct(v.ci[1]))}>
                        <span className="base" style={{ left: x(o.rate) }} title={t.overall(pct(o.rate))} />
                        <span className="ci" style={{ left: x(v.ci[0]), width: `calc(${x(v.ci[1])} - ${x(v.ci[0])})` }} />
                        <span className="pt" style={{ left: x(v.rate), background: v.small ? "var(--axis)" : "var(--g-target)" }} />
                      </span>
                      <span role="cell" className="num small" style={{ textAlign: "right" }}>
                        <b>{pct(v.rate)}</b> <span className="muted">{t.vs} {pct(v.restRate)}</span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        {o.factors.length > 6 && (
          <button className="btn ghost small" type="button" style={{ marginTop: 10 }} onClick={() => setAll(!all)}>
            {all ? t.collapse : t.showAll(o.factors.length)}
          </button>
        )}
        <p className="small muted" style={{ marginTop: 12 }}>
          {t.legend(pct(o.rate), d.minSegment)} {d.method}
        </p>
      </div>
    </section>
  );
}

// ─── Objections recodées ──────────────────────────────────────────────────────

interface RecodedDist {
  key: string;
  n: number;
  shares: Record<string, number>;
  counts: Record<string, number>;
  crosstab: Record<string, Record<string, number>>;
  canonical: Record<string, number>;
  examples: Record<string, string[]>;
}
export interface RecodedResponse {
  recodings: Array<{ key: string; objections: Array<{ code: string; label: string; description: string; canonical: string }>; overall: RecodedDist | null; groups: Record<string, RecodedDist | null> }>;
  available: { key: string; source: "protocol" | "proposal"; count: number } | null;
  job: JobState | null;
}

export function useRecoded(studyId: string) {
  const data = useApi<RecodedResponse>(`/studies/${studyId}/recoded`);
  const reload = useCallback(() => void data.reload(), [data]);
  const { job, started } = useJob(`recode-${studyId.replace(/[^A-Za-z0-9_-]+/g, "_")}`, data.data?.job, reload);
  return { data: data.data, job, started };
}

/** Bascule « catégories d'origine / recodées » et bouton de recodage, en tête de la section Objections. */
export function RecodeControls({ studyId, rec, view, setView }: { studyId: string; rec: ReturnType<typeof useRecoded>; view: string; setView: (v: string) => void }) {
  const t = useDict(studyDict).recode;
  const [err, setErr] = useState<string | null>(null);
  const d = rec.data;
  if (!d || (!d.recodings.length && !d.available)) return null;
  const launch = async () => {
    setErr(null);
    try {
      rec.started(await api<{ key: string; pid: number; startedAt: string }>(`/studies/${studyId}/recode`, { method: "POST" }));
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div className="stack" style={{ marginBottom: 14 }}>
      <div className="row">
        {d.recodings.length > 0 && (
          <Seg
            label={t.categories}
            value={view}
            onChange={setView}
            options={[{ id: "origin", label: t.origin }, ...d.recodings.map((r) => ({ id: r.key, label: t.recoded(r.key) }))]}
          />
        )}
        {d.available && (
          <button className="btn ghost small" type="button" onClick={launch} disabled={Boolean(rec.job?.alive)}>
            {t.button}
          </button>
        )}
        {d.available && (
          <span className="small muted">{t.available(d.available.count, d.available.source === "protocol")}</span>
        )}
      </div>
      {err && <div className="error-box">{err}</div>}
      <JobPanel job={rec.job} label={t.jobLabel} hint={t.jobHint} />
    </div>
  );
}

export function RecodedView({ rec, recKey, s, meta }: { rec: RecodedResponse; recKey: string; s: SummaryResponse; meta: Meta }) {
  const dict = useDict(studyDict);
  const t = dict.recode;
  const r = rec.recodings.find((x) => x.key === recKey);
  if (!r?.overall) return null;
  const groups = s.groups.length > 1 ? Object.entries(r.groups).filter((e): e is [string, RecodedDist] => !!e[1]) : [["all", r.overall] as [string, RecodedDist]];
  const first = groups[0]![1];
  const order = [...r.objections].sort((a, b) => (first.shares[b.code] ?? 0) - (first.shares[a.code] ?? 0));
  const gl = (g: string) => (g === "all" ? dict.group.sample : g === "control" ? dict.group.control : g === "target" ? dict.group.target : meta.groups[g] ?? g);
  const oldLabel = (c: string) => meta.objections.find((o) => o.id === c)?.label ?? c;
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="panel">
        <HBars
          series={groups.map(([g, dist]) => ({ key: g, label: `${gl(g)} (n = ${dist.n})`, color: groups.length > 1 ? groupColor(g) : "var(--g-target)" }))}
          items={order.map((o) => ({ key: o.code, label: o.label, values: groups.map(([, dist]) => dist.shares[o.code] ?? 0) }))}
        />
        <p className="small muted" style={{ marginTop: 10 }}>{t.note}</p>
      </div>
      <div className="panel">
        <h3 style={{ marginBottom: 6 }}>{t.originTitle}</h3>
        <div className="table-wrap">
          <table className="table fixed small">
            <Cols widths={[null, 100, 360]} />
            <thead>
              <tr>
                <th>{t.thNew}</th>
                <th className="r">{t.thMentions}</th>
                <th>{t.thOld}</th>
              </tr>
            </thead>
            <tbody>
              {order.map((o) => {
                const from = Object.entries(r.overall!.crosstab)
                  .map(([old, m]) => [old, m[o.code] ?? 0] as const)
                  .filter(([, k]) => k > 0)
                  .sort((a, b) => b[1] - a[1]);
                const total = from.reduce((a, [, k]) => a + k, 0);
                return (
                  <tr key={o.code}>
                    <td>
                      <details className="obj" style={{ border: 0, padding: 0 }}>
                        <summary>
                          <span>{o.label}</span>
                        </summary>
                        <p className="small ink2" style={{ margin: "4px 0 0 24px" }}>{o.description}</p>
                        <ul>
                          {(r.overall!.examples[o.code] ?? []).slice(0, 3).map((x, i) => (
                            <li key={i}>
                              <q>{x}</q>
                            </li>
                          ))}
                        </ul>
                      </details>
                    </td>
                    <td className="r num">{total}</td>
                    <td className="small ink2">{from.map(([old, k]) => `${oldLabel(old)} ${k}`).join(", ") || "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
