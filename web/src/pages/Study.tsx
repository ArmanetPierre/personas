import { useEffect, useMemo, useRef, useState } from "react";
import { PriceScale } from "../evidence-charts";
import { Indicative, NeedFrequencyView, PaymentMeasureView } from "../payment";
import { Link, useSearch } from "wouter";
import { api, useApi, useMeta, type Analysis, type Meta, type ProjectDetail, type ResponseRowItem, type StudyState, type SummaryResponse } from "../api";
import { BehaviorStack, Columns, groupColor, HBars, Heatmap, setBehaviorScale, VanWestendorpChart, type HeatRow } from "../charts";
import { DriversSection, RecodeControls, RecodedView, useRecoded } from "./StudyP1";
import { dateFr, dimensionOrder, EmptyState, ErrorBox, eur, int, Loading, money, num, packShort, pct, SegmentedControl, Status } from "../ui";
import { tr, useDict } from "../i18n";
import { studyDict } from "../i18n/study";
import { hostedDict } from "../i18n/hosted";
import { usePlatform } from "../platform";

export const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** Libellés courts (français) ; à l'affichage : `useDict(studyDict).behaviorShort`. */
export const BEHAVIOR_SHORT: Record<string, string> = studyDict.fr.behaviorShort;
export const OBJECTION_SHORT: Record<string, string> = studyDict.fr.objectionShort;

/** Ordre d'affichage des dimensions : attributs propres à la cible d'abord. */
const SOCLE_DIM_ORDER = ["ageBand", "pcs", "livingStandard", "techAdoption", "townSize", "activityStatus", "region", "sex"];

export interface VerbatimFilter {
  group: string;
  behavior: string;
  objection: string;
  dim: string;
  code: string;
  q: string;
}
export const EMPTY_FILTER: VerbatimFilter = { group: "", behavior: "", objection: "", dim: "", code: "", q: "" };

export const groupLabel = (meta: Meta | null, g: string) => (g === "control" ? tr(studyDict).group.control : g === "target" ? tr(studyDict).group.target : meta?.groups[g] ?? g);

/** Libellés des comportements adaptés au type de prix de l'étude (« Achèterait », « Commanderait »…). */
export function withBehaviorLabels(meta: Meta | null, labels: Record<string, string> | undefined): Meta | null {
  if (!meta || !labels) return meta;
  return { ...meta, behaviors: meta.behaviors.map((b) => ({ ...b, label: labels[b.id] ?? b.label })) };
}

/** Échelle de l'étude : protocole propre (comportements, objections) s'il existe, sinon libellés historiques. */
export function withScale(meta: Meta | null, s: SummaryResponse | null | undefined): Meta | null {
  if (!meta) return meta;
  if (!s?.protocol || !s.scale) return withBehaviorLabels(meta, s?.project.behaviorLabels);
  setBehaviorScale(s.behaviorLevels);
  return {
    ...meta,
    behaviors: s.scale.behaviors.map((b) => ({ id: b.code, label: b.label, short: b.short })),
    objections: s.scale.objections.map((o) => ({ id: o.code, label: o.label, short: o.short })),
  };
}

export function RunPanel({ state, onState }: { state: StudyState; onState: (s: StudyState) => void }) {
  const t = useDict(studyDict).run;
  const th = useDict(hostedDict).study;
  const { hosted } = usePlatform();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const running = state.displayStatus === "running" || state.run?.alive;
  const log = useApi<{ logPath: string | null; text: string }>(state.run || running ? `/studies/${state.id}/log` : null);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void log.reload(), 4000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);
  useEffect(() => {
    if (!running && state.run) void log.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  if (state.responses >= state.total && !running) return null;
  const launch = async () => {
    setErr(null);
    setBusy(true);
    try {
      const r = await api<{ state: StudyState }>(`/studies/${state.id}/run`, { method: "POST" });
      onState({ ...r.state, displayStatus: "running" });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const missing = state.total - state.responses;
  return (
    <div className="panel" style={{ marginTop: 24, maxWidth: 640 }}>
      {running ? (
        <p>{t.running(state.backend, state.run && <span className="muted small">{t.pid(state.run.pid)}</span>)}</p>
      ) : (
        <div className="row">
          <button className="btn" type="button" onClick={launch} disabled={busy}>
            {busy ? t.launching : state.responses ? t.resume(missing) : t.launch(missing)}
          </button>
          <span className="small ink2">
            {hosted ? th.hint : state.backend === "claude-cli" ? t.claudeHint : t.ollamaHint}
          </span>
        </div>
      )}
      {state.error && !running && <p className="small" style={{ marginTop: 10, color: "var(--danger)" }}>{state.error}</p>}
      {state.displayStatus === "interrupted" && <p className="small" style={{ marginTop: 10 }}>{t.interrupted}</p>}
      {err && <div className="error-box" style={{ marginTop: 10 }}>{err}</div>}
      {log.data?.text && (
        <details open={Boolean(running)} style={{ marginTop: 12 }}>
          <summary className="small ink2" style={{ cursor: "pointer" }}>{t.log} {log.data.logPath && <span className="muted">({log.data.logPath.split("/").slice(-2).join("/")})</span>}</summary>
          <pre className="log">{log.data.text}</pre>
        </details>
      )}
    </div>
  );
}

// ─── Cible vs témoin ──────────────────────────────────────────────────────────

const atLeast = (a: Analysis, ids: string[]) => ids.reduce((acc, b) => acc + (a.behaviors.overall.shares[b as keyof typeof a.behaviors.overall.shares] ?? 0), 0);

export function BehaviorsSection({ s, meta }: { s: SummaryResponse; meta: Meta }) {
  const d = useDict(studyDict);
  const t = d.behaviors;
  const list = s.groups.length > 1 ? s.groups.map((g) => ({ key: g.group, label: groupLabel(meta, g.group), a: g.analysis, packs: g.packVersions })) : [{ key: "all", label: d.group.sample, a: s.overall, packs: [] as string[] }];
  const low = s.confidence?.level === "low";
  const cur = s.project.currency ?? "EUR";
  const nf = list.find((g) => g.a.needFrequency)?.a.needFrequency;
  // Au moins « regarde » : niveaux canoniques ≥ intérêt pour une échelle propre, sinon à partir de « visit_page »
  const lv = s.behaviorLevels;
  const fromVisit = lv ? meta.behaviors.filter((b) => lv[b.id] && lv[b.id] !== "inaction").map((b) => b.id) : meta.behaviors.slice(meta.behaviors.findIndex((b) => b.id === "visit_page")).map((b) => b.id);
  return (
    <section className="section" id="comportements">
      <div className="section-head">
        <h2>{s.groups.length > 1 ? t.titleGroups : t.titleSingle}</h2>
        <p className="small ink2">{t.sub}</p>
      </div>
      <div className="panel">
        <BehaviorStack behaviors={meta.behaviors} rows={list.map((g) => ({ key: g.key, label: g.label, dist: g.a.behaviors.overall }))} />
      </div>
      <div className="panel">
        <h3 style={{ marginBottom: 14 }}>
          {t.funnel} <Indicative show={low} />
        </h3>
        <HBars
          series={list.map((g) => ({ key: g.key, label: `${g.label} (n = ${g.a.n})`, color: list.length > 1 ? groupColor(g.key) : "var(--g-target)" }))}
          items={[
            { key: "relevant", label: t.relevant, values: list.map((g) => 1 - g.a.relevance.notConcernedShare) },
            { key: "visit", label: t.visit, values: list.map((g) => atLeast(g.a, fromVisit)) },
            { key: "signup", label: t.signup, values: list.map((g) => g.a.behaviors.freeSignupOrMore) },
            { key: "forward", label: t.forward, values: list.map((g) => (g.a.forward.n ? g.a.forward.share : null)) },
          ]}
        />
        {list.some((g) => g.a.forward.examples.length) && (
          <details className="obj" style={{ marginTop: 12 }}>
            <summary>
              <span>{t.forwardTo}</span>
            </summary>
            <ul>
              {list.flatMap((g) =>
                g.a.forward.examples.map((f) => (
                  <li key={g.key + f.personaId}>{t.forwardItem(f.to, f.who)}</li>
                )),
              )}
            </ul>
          </details>
        )}
      </div>
      {list.some((g) => g.a.payment) && (
        <div className="panel stack">
          <h3>{t.payment}</h3>
          <div className="grid-2">
            {list
              .filter((g) => g.a.payment)
              .map((g) => (
                <div key={g.key} className="stack" style={{ gap: 6 }}>
                  {list.length > 1 && <span className="small ink2">{g.label}</span>}
                  <PaymentMeasureView p={g.a.payment!} price={(x) => money(x, cur)} lowConfidence={low} />
                </div>
              ))}
          </div>
        </div>
      )}
      {nf && (
        <div className="panel stack">
          <h3>{t.needFrequency}</h3>
          <NeedFrequencyView f={nf} lowConfidence={low} />
        </div>
      )}
    </section>
  );
}

// ─── Segments ─────────────────────────────────────────────────────────────────

export function SegmentsSection({ a, meta, onCell }: { a: Analysis; meta: Meta; onCell: (dim: string, code: string, col: string, kind: "behavior" | "objection") => void }) {
  const d = useDict(studyDict);
  const t = d.segments;
  const [kind, setKind] = useState<"behavior" | "objection">("behavior");
  const source = kind === "behavior" ? a.behaviors.bySegment : a.objections.bySegment;
  // Segments automatiques (attributs des modules de la cible, variables clés du socle) : libellé et provenance
  const auto = new Map((a.autoDimensions ?? []).map((x) => [x.id, x]));
  const dimLabel = (d: string) => {
    const ad = auto.get(d);
    if (ad) return ad.source === "response" ? t.autoResponse(ad.label) : ad.source === "module" ? t.autoModule(ad.label, ad.module ?? undefined) : t.autoSocle(ad.label);
    return meta.dimensions.find((x) => x.id === d)?.label ?? d;
  };
  const DIM_ORDER = dimensionOrder(meta, SOCLE_DIM_ORDER);
  const blocks = Object.keys(source)
    // La fréquence du besoin (v3) d'abord : c'est le segment le plus lié à l'intérêt
    .sort((x, y) => (x === "needFrequency" ? -1 : DIM_ORDER.indexOf(x) + 1 || 99) - (y === "needFrequency" ? -1 : DIM_ORDER.indexOf(y) + 1 || 99))
    .map((dim) => ({ dim, label: dimLabel(dim), rows: (source[dim] ?? []).map((r) => ({ ...r, label: cap(r.label) })) as HeatRow[] }));
  const columns = kind === "behavior" ? meta.behaviors.map((b) => ({ id: b.id, label: b.label, short: b.short ?? d.behaviorShort[b.id] ?? b.label })) : meta.objections.map((o) => ({ id: o.id, label: o.label, short: o.short ?? d.objectionShort[o.id] ?? o.label }));
  return (
    <section className="section" id="segments">
      <div className="section-head">
        <h2>{t.title}</h2>
        <SegmentedControl label={t.measure} value={kind} onChange={setKind} options={[{ id: "behavior", label: t.behaviors }, { id: "objection", label: t.objections }]} />
      </div>
      <p className="small ink2" style={{ marginBottom: 14, maxWidth: "80ch" }}>
        <span title={t.cellTitle(kind === "behavior", meta.smallSegment)}>{t.hint}</span>
      </p>
      <div className="panel">
        <Heatmap blocks={blocks} columns={columns} onCell={(d, c, col) => onCell(d, c, col, kind)} />
      </div>
    </section>
  );
}

// ─── Prix ─────────────────────────────────────────────────────────────────────

export function PriceSection({ s, a, unit, priceShown, meta, groupName }: { s: SummaryResponse; a: Analysis; unit: string; priceShown: number | null; meta: Meta; groupName: string | null }) {
  const d = useDict(studyDict);
  const t = d.price;
  const vw = a.vanWestendorp;
  const cur = s.project.currency ?? "EUR";
  const m = (x: number | null | undefined) => money(x, cur);
  const equiv = s.project.revenueEquivalent;
  const list = s.groups.length > 1 ? s.groups.map((g) => ({ key: g.group, label: groupLabel(meta, g.group), a: g.analysis })) : [{ key: "all", label: d.group.sample, a: s.overall }];
  const tiers = [...new Set(list.flatMap((g) => g.a.gaborGranger.tiers.map((t) => t.price)))].sort((x, y) => x - y);
  const cats = tiers.map((t) => ({ key: String(t), label: m(t) }));
  const val = (g: (typeof list)[number], t: number, f: "demand" | "revenuePer100") => g.a.gaborGranger.tiers.find((x) => x.price === t)?.[f] ?? null;
  const colorOf = (k: string) => (list.length > 1 ? groupColor(k) : "var(--g-target)");
  const best = a.gaborGranger.bestPrice !== null ? a.gaborGranger.tiers.find((t) => t.price === a.gaborGranger.bestPrice && t.revenuePer100 > 0) ?? null : null;
  return (
    <section className="section" id="prix" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* En tête : chiffres clés et échelle de prix, sans jargon */}
      <div className="panel stack">
        <div className="kpis">
          <div>
            <b className="num">{vw.pmc !== null && vw.pme !== null ? `${m(vw.pmc)} – ${m(vw.pme)}` : "—"}</b>
            <span>{t.acceptable}{groupName ? ` (${groupName.toLowerCase()})` : ""}</span>
          </div>
          <div>
            <b className="num">{m(vw.opp)}</b>
            <span>{t.ideal}</span>
          </div>
          <div>
            <b className="num">{best ? m(best.price) : "—"}</b>
            <span>{t.best}</span>
          </div>
          <div>
            <b className="num">{pct(vw.neverPayShare)}</b>
            <span>{t.neverPay}</span>
          </div>
        </div>
        {vw.n > 0 && vw.pmc !== null && vw.pme !== null ? (
          <PriceScale
            title={t.scaleTitle}
            points={{ pmc: vw.pmc, pme: vw.pme, ...(vw.opp !== null && { opp: vw.opp }), ...(vw.ipp !== null && { ipp: vw.ipp }) }}
            shown={priceShown}
            best={best?.price ?? null}
            tiers={tiers}
          />
        ) : (
          <p className="ink2">{t.tooFew}</p>
        )}
        {vw.n > 0 && vw.n < meta.smallSegment && <p className="small muted">{t.fewMarks(meta.smallSegment)}</p>}
      </div>
      <div className="panel">
        <h3 title={t.ggTooltip}>{t.ggTitle}</h3>
        {list.length > 1 && (
          <div className="legend" style={{ marginTop: 10 }}>
            {list.map((g) => (
              <span key={g.key}>
                <i style={{ background: colorOf(g.key) }} />
                {g.label}
              </span>
            ))}
          </div>
        )}
        <Columns
          title={t.demandChart}
          height={150}
          categories={cats}
          highlight={priceShown !== null ? String(priceShown) : undefined}
          format={(v) => pct(v)}
          series={list.map((g) => ({ key: g.key, label: g.label, color: colorOf(g.key), values: tiers.map((t) => val(g, t, "demand")) }))}
        />
      </div>
      <details className="panel more">
        <summary>
          <b>{t.more}</b> <span className="small ink2">{t.moreSub}</span>
        </summary>
        <div className="stack" style={{ marginTop: 14, gap: 18 }}>
          <p className="small ink2">
            {t.respondents(vw.n, vw.neverPay, unit)}
            {cur !== "EUR" && t.inCurrency(cur)}
            {s.project.pricing && s.project.pricing.offers.length > 1 && t.referenceOffer(s.project.referencePrice)}.
          </p>
        {vw.n > 0 ? (
            <div className="grid-2-1" style={{ gap: 28 }}>
              <VanWestendorpChart curve={vw.curve} points={vw} unit={unit} priceShown={priceShown} currency={cur} />
              <div>
                <dl className="facts" style={{ gridTemplateColumns: "auto auto 1fr" }}>
                  {(
                    [
                      ["PMC", vw.pmc, t.pmc],
                      ["OPP", vw.opp, t.opp],
                      ["IPP", vw.ipp, t.ipp],
                      ["PME", vw.pme, t.pme],
                    ] as const
                  ).map(([k, v, d]) => (
                    <div key={k} style={{ display: "contents" }}>
                      <dt style={{ color: "var(--ink)", fontWeight: 600 }}>{k}</dt>
                      <dd className="num" style={{ fontWeight: 600 }}>{m(v)}</dd>
                      <dd className="small ink2">{d}</dd>
                    </div>
                  ))}
                </dl>
                {vw.n < meta.smallSegment && <p className="note-box small" style={{ marginTop: 12 }}>{t.fewPoints(meta.smallSegment)}</p>}
                <details style={{ marginTop: 14 }}>
                  <summary className="small ink2" style={{ cursor: "pointer" }}>{t.seeTable}</summary>
                  <div className="table-wrap" style={{ maxHeight: 280, overflow: "auto" }}>
                    <table className="table num small">
                      <thead>
                        <tr>
                          <th>{t.thPrice}</th>
                          <th className="r">{t.thTooCheap}</th>
                          <th className="r">{t.thCheap}</th>
                          <th className="r">{t.thExpensive}</th>
                          <th className="r">{t.thTooExpensive}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {vw.curve.map((p) => (
                          <tr key={p.price}>
                            <td>{m(p.price)}</td>
                            <td className="r">{pct(p.tooCheap)}</td>
                            <td className="r">{pct(p.cheap)}</td>
                            <td className="r">{pct(p.expensive)}</td>
                            <td className="r">{pct(p.tooExpensive)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              </div>
            </div>
          ) : (
            <p className="ink2">{t.noCurves}</p>
          )}
            <div>
            <h3 style={{ marginBottom: 6 }}>{t.revenueTitle(unit)}</h3>
            <Columns
              title={t.revenueChart}
              categories={cats}
              highlight={priceShown !== null ? String(priceShown) : undefined}
              format={(v) => m(v)}
              series={list.map((g) => ({ key: g.key, label: g.label, color: colorOf(g.key), values: tiers.map((t) => val(g, t, "revenuePer100")) }))}
            />
            {equiv && list.some((g) => g.a.gaborGranger.bestPrice !== null) && (
              <p className="small ink2" style={{ marginTop: 6 }}>
                {equiv === "year" ? t.equivYear : t.equivMonth}
                {t.equivTail}{" "}
                {list
                  .map((g) => {
                    const b = g.a.gaborGranger.tiers.find((t) => t.price === g.a.gaborGranger.bestPrice);
                    return `${g.label} ${b ? m(equiv === "year" ? Math.round(b.revenuePer100 * 12) : Math.round(b.revenuePer100 / 12)) : "—"}`;
                  })
                  .join(t.listSep)}
                .
              </p>
            )}
          </div>
        </div>
      </details>
    </section>
  );
}

// ─── Objections ───────────────────────────────────────────────────────────────

export function ObjectionsSection({ studyId, s, a, meta, onMore, groupName }: { studyId: string; s: SummaryResponse; a: Analysis; meta: Meta; onMore: (c: string) => void; groupName: string | null }) {
  const rec = useRecoded(studyId);
  const d = useDict(studyDict);
  const t = d.objections;
  const [view, setView] = useState("origin");
  const list = s.groups.length > 1 ? s.groups.map((g) => ({ key: g.group, label: groupLabel(meta, g.group), a: g.analysis })) : [{ key: "all", label: d.group.sample, a: s.overall }];
  const order = [...meta.objections].sort((x, y) => (list[0]!.a.objections.overall.shares[y.id as keyof Analysis["objections"]["overall"]["shares"]] ?? 0) - (list[0]!.a.objections.overall.shares[x.id as keyof Analysis["objections"]["overall"]["shares"]] ?? 0));
  const share = (an: Analysis, c: string) => an.objections.overall.shares[c as keyof Analysis["objections"]["overall"]["shares"]] ?? 0;
  return (
    <section className="section" id="objections">
      <div className="section-head">
        <h2>{t.title}</h2>
        <p className="small ink2" title={`${list.map((g) => t.perRespondent(g.label.toLowerCase(), num(g.a.objections.perRespondent, {}))).join(", ")}.`}>
          {t.sub}
        </p>
      </div>
      <RecodeControls studyId={studyId} rec={rec} view={view} setView={setView} />
      {view !== "origin" && rec.data ? (
        <RecodedView rec={rec.data} recKey={view} s={s} meta={meta} />
      ) : (
      <div className="grid-2">
        <div className="panel">
          <HBars
            series={list.map((g) => ({ key: g.key, label: `${g.label} (n = ${g.a.n})`, color: list.length > 1 ? groupColor(g.key) : "var(--g-target)" }))}
            items={order.map((o) => ({ key: o.id, label: o.label, values: list.map((g) => share(g.a, o.id)) }))}
          />
        </div>
        <div className="panel">
          <h3 style={{ marginBottom: 6 }}>{t.examples}{groupName ? ` — ${groupName}` : ""}</h3>
          {order.map((o) => {
            const ex = a.objections.examples[o.id as keyof Analysis["objections"]["examples"]] ?? [];
            const k = a.objections.overall.counts[o.id as keyof Analysis["objections"]["overall"]["counts"]] ?? 0;
            if (!k) return null;
            return (
              <details className="obj" key={o.id}>
                <summary>
                  <span>{o.label}</span>
                  <span className="small muted num">{t.count(k, pct(share(a, o.id)))}</span>
                </summary>
                <ul>
                  {ex.map((e) => (
                    <li key={e.personaId}>
                      <q>{e.detail}</q> — {e.who}
                    </li>
                  ))}
                </ul>
                <button className="btn ghost small" type="button" style={{ marginLeft: 24 }} onClick={() => onMore(o.id)}>
                  {t.seeAll(k)}
                </button>
              </details>
            );
          })}
        </div>
      </div>
      )}
    </section>
  );
}

// ─── Verbatims ────────────────────────────────────────────────────────────────

export function VerbatimsSection({
  studyId,
  rows,
  meta,
  filter,
  setFilter,
  hasGroups,
}: {
  studyId: string;
  rows: ResponseRowItem[] | null;
  meta: Meta;
  filter: VerbatimFilter;
  setFilter: (f: VerbatimFilter) => void;
  hasGroups: boolean;
}) {
  const t = useDict(studyDict).verbatims;
  const g = useDict(studyDict).group;
  const [limit, setLimit] = useState(30);
  useEffect(() => setLimit(30), [filter]);
  const dims = useMemo(() => {
    const m = new Map<string, Map<string, string>>();
    for (const r of rows ?? []) for (const [d, v] of Object.entries(r.segments)) (m.get(d) ?? m.set(d, new Map()).get(d)!).set(v.code, v.label);
    return m;
  }, [rows]);
  const list = useMemo(() => {
    const q = filter.q.trim().toLowerCase();
    return (rows ?? []).filter(
      (r) =>
        (!filter.group || r.group === filter.group) &&
        (!filter.behavior || r.behavior === filter.behavior) &&
        (!filter.objection || r.objections.some((o) => o.category === filter.objection)) &&
        (!filter.dim || !filter.code || r.segments[filter.dim]?.code === filter.code) &&
        (!q || `${r.verbatim} ${r.reaction} ${r.who} ${r.occupation} ${r.objections.map((o) => o.detail).join(" ")}`.toLowerCase().includes(q)),
    );
  }, [rows, filter]);
  const set = (k: keyof VerbatimFilter) => (e: { target: { value: string } }) => setFilter({ ...filter, [k]: e.target.value, ...(k === "dim" && { code: "" }) });
  const dimLabel = (d: string) => meta.dimensions.find((x) => x.id === d)?.label ?? d;
  const behaviorLabel = (b: string | null) => meta.behaviors.find((x) => x.id === b)?.label ?? b ?? "—";

  return (
    <section className="section" id="verbatims">
      <div className="section-head">
        <h2>{t.title}</h2>
        <p className="small ink2">{rows ? t.count(list.length, rows.length) : t.loading}</p>
      </div>
      <div className="filters">
        {hasGroups && (
          <label className="field" style={{ width: 130 }}>
            <span>{t.group}</span>
            <select value={filter.group} onChange={set("group")}>
              <option value="">{t.allM}</option>
              <option value="target">{g.target}</option>
              <option value="control">{g.control}</option>
            </select>
          </label>
        )}
        <label className="field">
          <span>{t.behavior}</span>
          <select value={filter.behavior} onChange={set("behavior")}>
            <option value="">{t.allM}</option>
            {meta.behaviors.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t.objection}</span>
          <select value={filter.objection} onChange={set("objection")}>
            <option value="">{t.allF}</option>
            {meta.objections.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t.segment}</span>
          <select value={filter.dim} onChange={set("dim")}>
            <option value="">{t.none}</option>
            {[...dims.keys()]
              .sort((x, y) => (dimensionOrder(meta, SOCLE_DIM_ORDER).indexOf(x) + 1 || 99) - (dimensionOrder(meta, SOCLE_DIM_ORDER).indexOf(y) + 1 || 99))
              .map((d) => (
                <option key={d} value={d}>
                  {dimLabel(d)}
                </option>
              ))}
          </select>
        </label>
        {filter.dim && (
          <label className="field">
            <span>{dimLabel(filter.dim)}</span>
            <select value={filter.code} onChange={set("code")}>
              <option value="">{t.allValues}</option>
              {[...(dims.get(filter.dim)?.entries() ?? [])].map(([code, label]) => (
                <option key={code} value={code}>
                  {cap(label)}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field grow">
          <span>{t.search}</span>
          <input type="search" value={filter.q} onChange={set("q")} placeholder={t.placeholder} />
        </label>
        {JSON.stringify(filter) !== JSON.stringify(EMPTY_FILTER) && (
          <button className="btn ghost small" type="button" onClick={() => setFilter(EMPTY_FILTER)}>
            {t.clear}
          </button>
        )}
      </div>
      <div className="quotes">
        {list.slice(0, limit).map((r) => (
          <Link key={r.personaId} href={`/etudes/${studyId}/reponses/${encodeURIComponent(r.personaId)}`} className="quote">
            <blockquote>{r.verbatim}</blockquote>
            <div className="meta">
              <span>
                <b>{r.who}</b>
              </span>
              <span className="muted">{r.occupation}</span>
              <span className="row" style={{ gap: 6 }}>
                {hasGroups && <span className="tag">{groupLabel(meta, r.group)}</span>}
                <span className="tag">{behaviorLabel(r.behavior)}</span>
                {r.anomalies.length > 0 && <span className="tag warn">{t.anomaly}</span>}
              </span>
            </div>
          </Link>
        ))}
        {rows && list.length === 0 && <EmptyState title={t.emptyTitle} description={t.empty} />}
      </div>
      {list.length > limit && (
        <button className="btn ghost" type="button" style={{ marginTop: 14 }} onClick={() => setLimit(limit + 50)}>
          {t.more(list.length - limit)}
        </button>
      )}
    </section>
  );
}

// ─── Cohérence et coût ────────────────────────────────────────────────────────

export function CoherenceSection({ s, meta }: { s: SummaryResponse; meta: Meta }) {
  const a = s.overall;
  const codes = [...new Set([...Object.keys(a.anomalies.initialByCode), ...Object.keys(a.anomalies.byCode)])];
  const u = a.usage;
  const t = useDict(studyDict).coherence;
  return (
    <section className="section" id="coherence">
      <div className="section-head">
        <h2>{t.title}</h2>
      </div>
      <div className="grid-2">
        <div className="panel">
          <p>{t.summary(pct(a.anomalies.repairedRate), pct(a.anomalies.rate), pct(a.narrativeUsedShare))}</p>
          {codes.length > 0 && (
            <div className="table-wrap" style={{ marginTop: 12 }}>
              <table className="table small">
                <thead>
                  <tr>
                    <th>{t.check}</th>
                    <th className="r">{t.before}</th>
                    <th className="r">{t.after}</th>
                  </tr>
                </thead>
                <tbody>
                  {codes.map((c) => (
                    <tr key={c}>
                      <td>{meta.checks[c] ?? c}</td>
                      <td className="r num">{a.anomalies.initialByCode[c] ?? 0}</td>
                      <td className="r num">{a.anomalies.byCode[c] ?? 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="panel">
          <dl className="facts">
            <dt>{t.perResponse}</dt>
            <dd className="num">{t.seconds(num(u.avgDurationMs / 1000, 1))}</dd>
            <dt>{t.inputTokens}</dt>
            <dd className="num">{t.avgInput(int(u.avgInputTokens), int(u.avgCacheReadTokens))}</dd>
            <dt>{t.outputTokens}</dt>
            <dd className="num">{t.avgOutput(int(u.avgOutputTokens))}</dd>
            <dt>{t.total}</dt>
            <dd className="num">{t.totals(int(u.totalInputTokens), int(u.totalOutputTokens))}</dd>
            {u.totalCostUsd > 0 && (
              <>
                <dt>{t.cost}</dt>
                <dd className="num">{t.costValue(num(u.totalCostUsd, {}))}</dd>
              </>
            )}
          </dl>
        </div>
      </div>
    </section>
  );
}
