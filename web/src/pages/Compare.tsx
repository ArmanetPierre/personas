import { useMemo, type ReactNode } from "react";
import { PaymentMeasureView } from "../payment";
import { Link, useLocation, useSearch } from "wouter";
import { useApi, useMeta, type Comparison, type ProjectListItem, type StudyListItem } from "../api";
import { BehaviorStack, HBars } from "../charts";
import { tr, useDict } from "../i18n";
import { compareDict } from "../i18n/compare";
import { Cols, dateFr, ErrorBox, eur, Loading, money, num, pct, Seg, Status } from "../ui";
import { cap } from "./Study";

type Entry = Comparison["entries"][number];
type Delta = Comparison["deltas"][number];

function DeltaTag({ d, unit }: { d: number | null | undefined; unit?: string }) {
  const t = useDict(compareDict);
  if (d === null || d === undefined) return null;
  if (d === 0) return <span className="delta">=</span>;
  return (
    <span className={`delta ${d > 0 ? "up" : "down"}`}>
      {d > 0 ? "+" : "−"}
      {num(Math.abs(d), 1)} {unit ?? t.pt}
    </span>
  );
}

export function ComparePage() {
  const meta = useMeta();
  const t = useDict(compareDict).page;
  const search = useSearch();
  const [, navigate] = useLocation();
  const params = new URLSearchParams(search);
  const ids = (params.get("ids") ?? "").split(",").filter(Boolean);
  const group = params.get("group") ?? "target";
  const projectFilter = params.get("project") ?? "";
  const normalize = params.get("normalize") === "monthly-eur";
  const studies = useApi<StudyListItem[]>("/studies");
  const projects = useApi<ProjectListItem[]>("/projects");
  const cmp = useApi<Comparison>(ids.length >= 2 ? `/compare?ids=${ids.join(",")}${group !== "all" ? `&group=${group}` : ""}${normalize ? "&normalize=monthly-eur" : ""}` : null);

  const go = (next: { ids?: string[]; group?: string; project?: string; normalize?: boolean }) => {
    const p = new URLSearchParams();
    const i = next.ids ?? ids;
    if (i.length) p.set("ids", i.join(","));
    p.set("group", next.group ?? group);
    const pr = next.project ?? projectFilter;
    if (pr) p.set("project", pr);
    if (next.normalize ?? normalize) p.set("normalize", "monthly-eur");
    navigate(`/comparer?${p.toString()}`, { replace: true });
  };
  const toggle = (id: string) => go({ ids: ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id] });
  const makeRef = (id: string) => go({ ids: [id, ...ids.filter((x) => x !== id)] });

  const byProject = useMemo(() => {
    const m = new Map<string, StudyListItem[]>();
    for (const s of studies.data ?? []) if (s.responses > 0 && (!projectFilter || s.projectId === projectFilter)) m.set(s.projectId, [...(m.get(s.projectId) ?? []), s]);
    return m;
  }, [studies.data, projectFilter]);
  const projectName = (id: string) => projects.data?.find((p) => p.id === id)?.name ?? id;

  return (
    <>
      <h1>{t.title}</h1>
      <p className="lede" style={{ marginTop: 10 }}>
        <span title={t.ledeTitle}>{t.lede}</span>
      </p>

      <div className="panel" style={{ marginTop: 22 }}>
        <div className="row" style={{ marginBottom: 12 }}>
          <label className="field" style={{ width: 280 }}>
            <span>{t.project}</span>
            <select value={projectFilter} onChange={(e) => go({ project: e.target.value })}>
              <option value="">{t.allProjects}</option>
              {(projects.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.price})
                </option>
              ))}
            </select>
          </label>
          <span className="spacer" />
          <div className="field">
            <span>{t.group}</span>
            <Seg label={t.group} value={group} onChange={(g) => go({ group: g })} options={[{ id: "target", label: t.groupTarget }, { id: "control", label: t.groupControl }, { id: "all", label: t.groupAll }]} />
          </div>
          <label className="row small" style={{ gap: 6 }} title={t.normalizeTitle}>
            <input type="checkbox" checked={normalize} onChange={(e) => go({ normalize: e.target.checked })} />
            {t.normalize}
          </label>
        </div>
        {!studies.data && <Loading />}
        {byProject.size > 0 && (
          <div className="table-wrap" style={{ marginTop: 6 }}>
            <table className="table fixed small">
              <Cols widths={[36, null, 92, 104, 128, 124]} />
              <thead>
                <tr>
                  <th aria-label={t.colCompare} />
                  <th>{t.colStudy}</th>
                  <th className="r">{t.colResponses}</th>
                  <th>{t.colBackend}</th>
                  <th>{t.colStatus}</th>
                  <th className="r">{t.colCreated}</th>
                </tr>
              </thead>
              {[...byProject.entries()].map(([pid, list]) => (
                <tbody key={pid}>
                  <tr className="group-row">
                    <th colSpan={6} scope="colgroup">
                      {projectName(pid)}
                    </th>
                  </tr>
                  {list.map((s) => {
                    const rank = ids.indexOf(s.id);
                    return (
                      <tr key={s.id}>
                        <td>
                          <input type="checkbox" aria-label={t.compareStudy(s.name)} checked={rank !== -1} onChange={() => toggle(s.id)} />
                        </td>
                        <td>
                          <span className="cell-title">{s.name}</span>
                          <span className="cell-sub">
                            <span className="num">{s.id}</span>
                            {rank === 0 && <span className="tag">{t.reference}</span>}
                            {rank > 0 && (
                              <button type="button" className="btn ghost small" style={{ padding: "1px 8px" }} onClick={() => makeRef(s.id)}>
                                {t.makeReference}
                              </button>
                            )}
                          </span>
                        </td>
                        <td className="r num">
                          {s.responses}/{s.sampleSize}
                        </td>
                        <td className="ellipsis" title={s.model}>{s.backend}</td>
                        <td>
                          <Status status={s.status} />
                        </td>
                        <td className="r muted nowrap num">{dateFr(s.createdAt)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              ))}
            </table>
          </div>
        )}
      </div>

      {ids.length < 2 && <div className="empty" style={{ marginTop: 24 }}>{t.empty}</div>}
      <ErrorBox error={cmp.error} />
      {ids.length >= 2 && !cmp.data && !cmp.error && <Loading what={t.computing} />}
      {cmp.data && meta && <ComparisonView c={cmp.data} behaviors={compareBehaviors(meta.behaviors, cmp.data)} objections={meta.objections} dims={meta.dimensions} />}
    </>
  );
}

/** Libellés communs des comportements : ceux du type de prix s'il est le même pour toutes les études, sinon neutres. */
function compareBehaviors(behaviors: Array<{ id: string; label: string }>, c: Comparison) {
  return behaviors.map((b) => {
    const labels = new Set(c.entries.map((e) => e.behaviorLabels?.[b.id as keyof NonNullable<typeof e.behaviorLabels>] ?? b.label));
    const label = labels.size === 1 ? [...labels][0]! : b.id === "pay_subscription" ? tr(compareDict).payAtPrice : b.label;
    return { ...b, label };
  });
}

/** Couleur par étude, dans l'ordre fixe de la palette catégorielle validée. */
const STUDY_COLORS = ["var(--tc-1)", "var(--tc-2)", "var(--tc-3)", "var(--tc-4)", "var(--tc-5)", "var(--tc-6)", "var(--tc-7)"];

function ComparisonView({ c, behaviors, objections, dims }: { c: Comparison; behaviors: Array<{ id: string; label: string }>; objections: Array<{ id: string; label: string }>; dims: Array<{ id: string; label: string }> }) {
  const t = useDict(compareDict).view;
  const entries = c.entries;
  const delta = (id: string) => c.deltas.find((d) => d.studyId === id);
  const tiers = [...new Set(entries.flatMap((e) => e.gaborGranger.map((t) => t.price)))].sort((a, b) => a - b);
  const currencies = [...new Set(entries.map((e) => e.currency ?? "EUR"))];
  const tierLabel = (x: number) => (currencies.length === 1 ? money(x, currencies[0]) : t.tierOtherCurrency(num(x, {})));
  const norm = (id: string) => c.normalization?.entries.find((x) => x.studyId === id);
  // Trois freins principaux de la référence, comparés étude par étude
  const topObjections = objections
    .filter((o) => (entries[0]?.objections[o.id] ?? 0) > 0)
    .sort((a, b) => (entries[0]!.objections[b.id] ?? 0) - (entries[0]!.objections[a.id] ?? 0))
    .slice(0, 3);

  const Row = ({ label, cell }: { label: ReactNode; cell: (e: Entry, d: Delta | undefined, i: number) => ReactNode }) => (
    <tr>
      <td className="metric">{label}</td>
      {entries.map((e, i) => (
        <td key={e.studyId} className="r num nowrap">
          {cell(e, delta(e.studyId), i)}
        </td>
      ))}
    </tr>
  );
  const Group = ({ label }: { label: string }) => (
    <tr className="group">
      <td colSpan={entries.length + 1}>{label}</td>
    </tr>
  );
  const share = (v: number, d: number | null | undefined, i: number) => (
    <>
      {pct(v)}
      {i > 0 && <DeltaTag d={d} />}
    </>
  );

  return (
    <div className="section" style={{ marginTop: 32 }}>
      {c.normalization && <div className="note-box small" style={{ marginBottom: 16 }}>{c.normalization.warning}</div>}
      {(c.unitsDiffer || c.sizesDiffer) && (
        <div className="note-box small" style={{ marginBottom: 16 }}>
          {c.unitsDiffer && <div>{t.unitsDiffer}</div>}
          {c.sizesDiffer && <div>{t.sizesDiffer}</div>}
        </div>
      )}
      {c.protocolsDiffer && (
        <div className="banner-block small" role="note" style={{ marginBottom: 16 }}>
          <b>{t.protocolsTitle}</b> {t.protocolsBody}
        </div>
      )}
      {c.scalesDiffer && <CanonicalLevels c={c} />}
      <div className="panel" style={{ marginBottom: 16 }}>
        <h2 style={{ marginBottom: 14 }}>{t.essentials}</h2>
        <HBars
          series={entries.map((e, i) => ({ key: e.studyId, label: `${e.studyName.length > 34 ? e.studyId : e.studyName}${i === 0 ? t.refSuffix : ""}`, color: STUDY_COLORS[i % STUDY_COLORS.length]! }))}
          items={[
            { key: "trial", label: t.trial, values: entries.map((e) => e.freeSignupOrMore) },
            ...(entries.some((e) => e.payment?.estimated)
              ? [{ key: "m2", label: t.estimatedPaying, values: entries.map((e) => e.payment?.estimated?.value ?? null) }]
              : [{ key: "pay", label: t.pay7, values: entries.map((e) => e.payers) }]),
            { key: "never", label: t.neverPay, values: entries.map((e) => e.vanWestendorp.neverPayShare) },
            ...topObjections.map((o) => ({ key: `o-${o.id}`, label: t.brake(o.label), values: entries.map((e) => e.objections[o.id] ?? null) })),
          ]}
          onItemContent={(item, study) => {
            if (item !== "m2") return null;
            const e = entries.find((x) => x.studyId === study);
            return e?.payment?.estimated ? (
              <div className="small">
                {t.interval(pct(e.payment.estimated.ci[0], 1), pct(e.payment.estimated.ci[1], 0), e.payment.estimated.calibration.status === "calibrated")}
              </div>
            ) : null;
          }}
        />
        <p className="small muted" style={{ marginTop: 8 }}>{t.essentialsNote}</p>
      </div>
      {entries.some((e) => e.payment) && (
        <div className="panel" style={{ marginBottom: 16 }}>
          <h2 style={{ marginBottom: 14 }}>{t.paymentByStudy}</h2>
          <div className="cmp-pay">
            {entries.map((e, i) =>
              e.payment ? (
                <div key={e.studyId} className="stack" style={{ gap: 4 }}>
                  <span className="small">
                    <b>{e.studyName.length > 40 ? e.studyId : e.studyName}</b> <span className="muted">{i === 0 ? t.refParen : ""} v{e.protocolVersion ?? "2"}</span>
                  </span>
                  <PaymentMeasureView compact p={e.payment} price={(x) => money(x, e.currency)} lowConfidence={e.confidence?.level === "low"} />
                </div>
              ) : null,
            )}
          </div>
        </div>
      )}
      <details className="panel more" style={{ marginBottom: 16 }}>
        <summary>
          <b>{t.fullTable}</b> <span className="small ink2">{t.fullTableSub}</span>
        </summary>
      <div className="panel">
        <h2 style={{ marginBottom: 14 }}>{t.behaviors7}</h2>
        <BehaviorStack
          behaviors={behaviors}
          rows={entries.map((e, i) => ({
            key: e.studyId,
            label: e.studyName.length > 30 ? `${e.studyId}` : e.studyName,
            sub: `${e.price}${i === 0 ? t.refComma : ""}`,
            dist: { n: e.n, shares: e.behaviors, counts: Object.fromEntries(Object.entries(e.behaviors).map(([k, v]) => [k, Math.round(v * e.n)])) },
          }))}
        />
      </div>
      <div className="panel table-wrap">
        <table className="table cmp">
          <thead>
            <tr>
              <th />
              {entries.map((e, i) => (
                <th key={e.studyId} className="r study">
                  <Link href={`/etudes/${e.studyId}`}>{e.studyName}</Link>
                  <div className="muted small" style={{ fontWeight: 400 }}>
                    {e.projectName}, {e.price}
                    {i === 0 ? t.refSuffix : ""}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <Row label={t.n} cell={(e) => e.n} />
            <Group label={t.behaviors} />
            <Row label={t.notConcerned} cell={(e, d, i) => share(e.notConcerned, d?.notConcerned, i)} />
            {behaviors.map((b) => (
              <Row key={b.id} label={b.label} cell={(e, d, i) => share(e.behaviors[b.id as keyof Entry["behaviors"]] ?? 0, d?.behaviors[b.id as keyof Delta["behaviors"]], i)} />
            ))}
            <Row label={<b>{t.freeSignup}</b>} cell={(e, d, i) => share(e.freeSignupOrMore, d?.freeSignupOrMore, i)} />
            {entries.some((e) => e.payment) ? (
              <>
                <Row
                  label={<b>{t.estimatedPaying}</b>}
                  cell={(e, d, i) =>
                    e.payment?.estimated ? (
                      <>
                        {pct(e.payment.estimated.value, 1)}
                        {i > 0 && <DeltaTag d={d?.paymentEstimated} />}
                        <div className="muted small">
                          {t.ci(pct(e.payment.estimated.ci[0], 1), pct(e.payment.estimated.ci[1], 0), e.payment.estimated.calibration.status === "calibrated")}
                        </div>
                      </>
                    ) : (
                      "—"
                    )
                  }
                />
                <Row
                  label={t.lowTierYes}
                  cell={(e, d, i) =>
                    e.payment?.lowTierYes ? (
                      <>
                        {pct(e.payment.lowTierYes.share, 1)} <span className="muted small">{t.atPrice(money(e.payment.lowTierYes.price, e.currency))}</span>
                        {i > 0 && <DeltaTag d={d?.lowTierYes} />}
                      </>
                    ) : (
                      "—"
                    )
                  }
                />
                <Row label={t.paid7} cell={(e, d, i) => share(e.payment?.observed ?? e.payers, d?.payers, i)} />
                <Row
                  label={t.confidence}
                  cell={(e) => (e.confidence ? <span className={`pill${e.confidence.level === "low" ? " warn" : e.confidence.level === "medium" ? " muted" : ""}`}>{e.confidence.label}</span> : "—")}
                />
              </>
            ) : (
              <Row label={<b>{t.wouldPay}</b>} cell={(e, d, i) => share(e.payers, d?.payers, i)} />
            )}
            <Row label={t.forward} cell={(e, d, i) => (e.forward === null ? "—" : share(e.forward, d?.forward, i))} />
            <Group label={t.price} />
            <Row label={t.neverPayOne} cell={(e, d, i) => share(e.vanWestendorp.neverPayShare, d?.vwNeverPay, i)} />
            {(["pmc", "opp", "ipp", "pme"] as const).map((k) => (
              <Row key={k} label={`Van Westendorp ${k.toUpperCase()}`} cell={(e) => `${money(e.vanWestendorp[k], e.currency)}${e.vanWestendorp[k] !== null ? `/${e.priceUnit}` : ""}`} />
            ))}
            {tiers.map((tierPrice) => (
              <Row
                key={tierPrice}
                label={t.ggYes(tierLabel(tierPrice))}
                cell={(e, d, i) => {
                  const tier = e.gaborGranger.find((x) => x.price === tierPrice);
                  if (!tier) return "—";
                  return (
                    <>
                      {pct(tier.demand)}
                      {i > 0 && <DeltaTag d={d?.gaborGranger.find((x) => x.price === tierPrice)?.demand} />}
                      <div className="small muted">{t.per100(money(tier.revenuePer100, e.currency))}</div>
                      {c.normalization && (
                        <div className="small muted">
                          {(() => {
                            const n = norm(e.studyId)?.gaborGranger.find((x) => x.price === tierPrice)?.monthlyEur;
                            return n === null || n === undefined ? t.notNormalizable : t.perMonth(eur(n));
                          })()}
                        </div>
                      )}
                    </>
                  );
                }}
              />
            ))}
            {c.normalization && (
              <>
                <Row label={t.oppMonthly} cell={(e) => (norm(e.studyId)?.factor === null ? t.notNormalizable : eur(norm(e.studyId)?.vanWestendorp.opp ?? null))} />
                <Row label={t.ippMonthly} cell={(e) => (norm(e.studyId)?.factor === null ? t.notNormalizable : eur(norm(e.studyId)?.vanWestendorp.ipp ?? null))} />
              </>
            )}
            <Group label={t.objections} />
            {objections.map((o) => (
              <Row key={o.id} label={o.label} cell={(e, d, i) => share(e.objections[o.id as keyof Entry["objections"]] ?? 0, d?.objections[o.id as keyof Delta["objections"]], i)} />
            ))}
            <Row label={t.objectionsPerRespondent} cell={(e) => num(e.objectionsPerRespondent, {})} />
            <Row label={t.anomalies} cell={(e) => pct(e.anomalies)} />
            {Object.keys(entries[0]?.segments ?? {}).map((dim) => (
              <SegmentRows key={dim} dim={dim} label={dims.find((x) => x.id === dim)?.label ?? dim} entries={entries} delta={delta} />
            ))}
          </tbody>
        </table>
      </div>
      </details>
    </div>
  );
}

function SegmentRows({ dim, label, entries, delta }: { dim: string; label: string; entries: Entry[]; delta: (id: string) => Delta | undefined }) {
  const t = useDict(compareDict).view;
  const ref = entries[0]!.segments[dim] ?? [];
  return (
    <>
      <tr className="group">
        <td colSpan={entries.length + 1}>{t.segmentGroup(label)}</td>
      </tr>
      {ref.map((sg) => (
        <tr key={sg.code}>
          <td className="metric">
            {cap(sg.label)} <span className="muted small">n = {sg.n}</span>
          </td>
          {entries.map((e, i) => {
            const s = e.segments[dim]?.find((x) => x.code === sg.code);
            const d = delta(e.studyId)?.segments[dim]?.find((x) => x.code === sg.code);
            return (
              <td key={e.studyId} className="r num nowrap">
                {s ? pct(s.freeSignupOrMore) : "—"}
                {i > 0 && <DeltaTag d={d?.freeSignupOrMore} />}
              </td>
            );
          })}
        </tr>
      ))}
    </>
  );
}

const LEVELS = ["inaction", "interest", "free_trial", "payment", "recommendation"] as const;
const CANON_OBJ = ["price", "no_need", "already_covered", "trust_privacy", "effort_time", "network_effect", "other"] as const;

/** Échelles de comportements ou taxonomies différentes : comparaison par niveaux et catégories canoniques. */
function CanonicalLevels({ c }: { c: Comparison }) {
  const t = useDict(compareDict).canonical;
  const entries = c.entries;
  const delta = (id: string) => c.deltas.find((d) => d.studyId === id);
  const cell = (v: number | undefined, d: number | undefined, i: number) =>
    v === undefined ? (
      <span className="muted">—</span>
    ) : (
      <>
        {pct(v)}
        {i > 0 && <DeltaTag d={d} />}
      </>
    );
  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <h2 style={{ marginBottom: 6 }}>{t.title}</h2>
      <p className="note-box small" style={{ marginBottom: 12 }}>
        {t.note}
      </p>
      <div className="table-wrap">
        <table className="table fixed cmp">
          <Cols widths={[220, ...entries.map(() => null)]} />
          <thead>
            <tr>
              <th />
              {entries.map((e) => (
                <th key={e.studyId} className="r">
                  {e.studyName}
                  <div className="muted small" style={{ fontWeight: 400 }}>{e.protocol?.custom ? t.projectScale : t.legacyScale}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {LEVELS.map((k) => (
              <tr key={k}>
                <td className="metric">{t.levels[k]}</td>
                {entries.map((e, i) => (
                  <td key={e.studyId} className="r num nowrap">
                    {cell(e.levels?.[k as keyof NonNullable<typeof e.levels>], delta(e.studyId)?.levels?.[k as keyof NonNullable<typeof e.levels>], i)}
                  </td>
                ))}
              </tr>
            ))}
            <tr className="group">
              <td colSpan={entries.length + 1}>{t.objectionsGroup}</td>
            </tr>
            {CANON_OBJ.map((k) => (
              <tr key={k}>
                <td className="metric">{t.objections[k]}</td>
                {entries.map((e, i) => (
                  <td key={e.studyId} className="r num nowrap">
                    {cell(e.objectionsCanonical?.[k as keyof NonNullable<typeof e.objectionsCanonical>], delta(e.studyId)?.objectionsCanonical?.[k as keyof NonNullable<typeof e.objectionsCanonical>], i)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
