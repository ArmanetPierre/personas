import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { wordDiff } from "./ProjectPitch";
import { ConfidenceDetail, ConfidencePill, PaymentMeasureView } from "../payment";
import { Link, useLocation, useSearch } from "wouter";
import { api, ApiError, useApi, useMetaState, type Analysis, type Meta, type ProjectDetail, type ResponseRowItem, type StudyState, type SummaryResponse } from "../api";
import { JobPanel, useJob, type JobState } from "../jobs";
import { ChartIcon, Cols, dateFr, EmptyState, ErrorBox, eur, int, Loading, money, num, pct, SegmentedControl, Status } from "../ui";
import { tr, useContentLocale, useDict } from "../i18n";
import { studyHubDict } from "../i18n/studyHub";
import {
  BehaviorsSection,
  CoherenceSection,
  EMPTY_FILTER,
  groupLabel,
  ObjectionsSection,
  PriceSection,
  RunPanel,
  SegmentsSection,
  VerbatimsSection,
  withScale,
  type VerbatimFilter,
} from "./Study";
import { DriversSection, useRecoded } from "./StudyP1";
import { EvidenceCharts, MiniBars, parseEvidenceValue, PriceScale } from "../evidence-charts";
import { groupColor } from "../charts";

/**
 * Page Étude en divulgation progressive : un verdict, des cartes (recommandations, réactions, qui accroche,
 * prix, freins, verbatims, fiabilité), puis une sous-page par thème. Les faits techniques (moteur, graine,
 * codes de population) sont dans « Technique ».
 */

// ─── Données communes ─────────────────────────────────────────────────────────

interface PlainCriterion {
  label: string;
  value: string;
  source: "socle" | "module";
}
interface PopulationPlain {
  group: string;
  n: number;
  packVersion: string;
  socleLabel: string | null;
  criteria: PlainCriterion[];
  rawCriteria: string[];
  modules: Array<{ id: string; label: string }>;
}
interface StudyData {
  study: StudyState;
  project: ProjectDetail | null;
  populationsPlain?: PopulationPlain[];
}

type Strength = "faible" | "moyenne" | "forte";
interface Evidence {
  metric: string;
  value: unknown;
  source: string;
}
interface Rec {
  id: string;
  kind: string;
  title: string;
  rationale: string;
  evidence: Evidence[];
  confidence: Strength;
  nextStudy?: {
    hypothesis: string;
    successCriterion: string;
    projectPatch: Record<string, unknown>;
    sample: string;
    n: number;
    control?: number | unknown;
    estimatedCalls?: number;
    estimatedMinutes?: number;
    /** Éligibilité mesurée du filtre proposé. */
    targetCheck?: { rate: number; draws: number };
  };
}
interface Recommendations {
  studyId: string;
  generatedAt: string;
  model?: string;
  headline: string;
  findings: Array<{ title: string; detail: string; evidence: Evidence[]; strength: Strength }>;
  recommendations: Rec[];
  caveats: string[];
  verification?: { evidenceChecked: number; evidenceValid: number; repaired: boolean; dropped: Array<{ where: string; reason: string }>; droppedNextStudies: Array<{ recommendation: string; reason: string }>; notes: string[] };
  relatedStudies?: string[];
  usage?: { calls: number; inputTokens: number; outputTokens: number };
}
interface PlainCrit {
  label: string;
  value: string;
}
interface RecResponse {
  plainTargets?: Record<string, { before: PlainCrit[]; after: PlainCrit[]; afterRaw: string[] }>;
  recommendations: Recommendations | null;
  generatedAt: string | null;
  job: JobState | null;
  canCreate: boolean;
  unavailable?: string;
}

const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const critText = (c: PlainCriterion) => (c.value ? tr(studyHubDict).labelValue(cap(c.label), c.value) : cap(c.label));

/** Correspondance des comportements historiques vers les paliers communs. */
const LEGACY_LEVELS: Record<string, string> = {
  ignore: "inaction",
  save_for_later: "inaction",
  visit_page: "interest",
  free_signup: "free_trial",
  free_active: "free_trial",
  pay_subscription: "payment",
  recommend: "recommendation",
};
export function engagement(a: Analysis, levels: Record<string, string> | null | undefined) {
  const lv = levels ?? LEGACY_LEVELS;
  let inaction = 0;
  for (const [code, share] of Object.entries(a.behaviors.overall.shares)) if ((lv[code] ?? "inaction") === "inaction") inaction += share;
  return { interest: 1 - inaction, trial: a.behaviors.freeSignupOrMore, payment: a.behaviors.payers };
}

type Tab = "apercu" | "recommandations" | "reactions" | "segments" | "prix" | "freins" | "verbatims" | "technique";
const TABS: Array<{ id: Tab; path: string }> = [
  { id: "apercu", path: "" },
  { id: "recommandations", path: "/recommandations" },
  { id: "reactions", path: "/reactions" },
  { id: "segments", path: "/segments" },
  { id: "prix", path: "/prix" },
  { id: "freins", path: "/freins" },
  { id: "verbatims", path: "/verbatims" },
  { id: "technique", path: "/technique" },
];
const GROUP_TABS: Tab[] = ["segments", "prix", "freins"];

interface Ctx {
  id: string;
  data: StudyData;
  state: StudyState;
  s: SummaryResponse | null;
  meta: Meta;
  current: Analysis | null;
  group: string;
  hasGroups: boolean;
  unit: string;
  rows: ResponseRowItem[] | null;
  setState: (s: StudyState) => void;
}

function StudyFrame({ id, tab, needRows, children }: { id: string; tab: Tab; needRows?: boolean; children: (c: Ctx) => ReactNode }) {
  const t = useDict(studyHubDict);
  const { meta: baseMeta, error: metaError } = useMetaState();
  const search = useSearch();
  const st = useApi<StudyData>(`/studies/${id}`);
  const [state, setState] = useState<StudyState | null>(null);
  const summary = useApi<SummaryResponse>(state && state.responses > 0 ? `/studies/${id}/summary` : null);
  const rows = useApi<ResponseRowItem[]>(needRows && state && state.responses > 0 ? `/studies/${id}/responses` : null);
  const [group, setGroup] = useState<string>(() => new URLSearchParams(search).get("groupe") ?? "target");
  const lastCount = useRef(0);
  useEffect(() => {
    if (st.data) setState(st.data.study);
  }, [st.data]);
  // Rafraîchissement : rapide pendant l'exécution (y compris lancée du terminal, récits compris), lent tant que l'étude n'est pas finie
  const narrWriting = Boolean(state?.narratives && state.narratives.done < state.narratives.total && state.narratives.lastAt && Date.now() - new Date(state.narratives.lastAt).getTime() < 180_000);
  const live = state && (state.displayStatus === "running" || state.run?.alive || narrWriting);
  const unfinished = state && state.status !== "completed" && state.responses < state.total;
  const period = live ? 3000 : unfinished ? 10000 : 0;
  useEffect(() => {
    if (!period) return;
    const t = setInterval(async () => {
      try {
        setState(await api<StudyState>(`/studies/${id}/progress`));
      } catch {
        // nouvel essai au tour suivant
      }
    }, period);
    return () => clearInterval(t);
  }, [period, id]);
  useEffect(() => {
    if (!state) return;
    if (lastCount.current && state.responses !== lastCount.current) {
      void summary.reload();
      if (needRows) void rows.reload();
    }
    lastCount.current = state.responses;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.responses]);
  const s = summary.data;
  useContentLocale(s?.locale ?? st.data?.project?.locale);
  const meta = withScale(baseMeta, s);
  const groups = s?.groups ?? [];
  const hasGroups = groups.length > 1;
  useEffect(() => {
    if (s && !hasGroups) setGroup("all");
  }, [s, hasGroups]);
  if (st.error) return <ErrorBox error={st.error} />;
  if (metaError && !meta) return <ErrorBox error={metaError} />;
  if (!st.data || !state || !meta) return <Loading />;
  const project = st.data.project;
  const current = !s ? null : group === "all" || !hasGroups ? s.overall : groups.find((x) => x.group === group)?.analysis ?? s.overall;
  const base = `/etudes/${id}`;
  const ctx: Ctx = { id, data: st.data, state, s: s ?? null, meta, current, group, hasGroups, unit: s?.unit ?? project?.unit ?? t.frame.defaultUnit, rows: rows.data, setState };
  return (
    <>
      <div className="crumbs">
        <Link href="/">{t.frame.projects}</Link>
        <span>/</span>
        {project ? <Link href={`/projets/${project.id}`}>{project.name}</Link> : <span>{state.projectId}</span>}
        <span>/</span>
        <Link href={`/projets/${state.projectId}/etudes`}>{t.frame.studies}</Link>
        <span>/</span>
        {tab === "apercu" ? <span>{state.name}</span> : <Link href={base}>{state.name}</Link>}
      </div>
      <StudyHero ctx={ctx} compact={tab !== "apercu"} />
      <nav className="tabs" aria-label={t.frame.sections}>
        {TABS.map((x) => (
          <Link key={x.id} href={`${base}${x.path}`} aria-current={x.id === tab ? "page" : undefined}>
            {t.frame.tabs[x.id]}
          </Link>
        ))}
      </nav>
      <ErrorBox error={summary.error} />
      {hasGroups && GROUP_TABS.includes(tab) && (
        <div className="row group-switch">
          <span className="small ink2">{t.frame.groupShownColon}</span>
          <SegmentedControl
            label={t.frame.groupShown}
            value={group}
            onChange={setGroup}
            options={[...groups.map((g) => ({ id: g.group, label: `${groupLabel(meta, g.group)} (${g.analysis.n})` })), { id: "all", label: t.frame.all }]}
          />
        </div>
      )}
      {!s && state.responses === 0 && tab !== "recommandations" && tab !== "technique" ? (
        <EmptyState style={{ marginTop: 24 }} icon={<ChartIcon />} title={t.frame.emptyTitle} description={t.frame.empty} />
      ) : (
        children(ctx)
      )}
    </>
  );
}

/** En-tête : statut, verdict, qui a été interrogé ; version compacte sur les sous-pages. */
function StudyHero({ ctx, compact }: { ctx: Ctx; compact: boolean }) {
  const t = useDict(studyHubDict);
  const h = t.hero;
  const { state, s, data } = ctx;
  const project = data.project;
  const target = s?.groups.find((g) => g.group === "target")?.analysis ?? s?.overall ?? null;
  const control = s?.groups.find((g) => g.group === "control")?.analysis ?? null;
  const price = project?.price ?? s?.project.price ?? "";
  const pay = target?.payment ?? null;
  const conf = s?.confidence ?? null;
  const done = state.responses >= state.total;
  const narr = state.narratives;
  const pops = data.populationsPlain ?? [];
  const tp = pops.find((p) => p.group === "target") ?? pops[0];
  const cp = pops.find((p) => p.group === "control");
  const one = target?.n === 1;
  const member = tp ? ctx.meta.packs.find((p) => p.packVersion === tp.packVersion)?.memberLabel : undefined;
  const who = tp?.criteria.length ? (one ? h.whoTargetOne : h.whoTargetMany) : member ? (one ? member.one : member.many) : one ? h.whoOne : h.whoMany;
  return (
    <header className={`study-hero${compact ? " compact" : ""}`}>
      <div className="row small" style={{ gap: 14 }}>
        <Status status={state.displayStatus} />
        <span className="num ink2">
          {int(state.responses)} / {int(state.total)} {h.responses}
        </span>
        {state.lastResponseAt && !done && <span className="muted">{h.lastAt(dateFr(state.lastResponseAt))}</span>}
        {narr && narr.done < narr.total && state.responses === 0 && (
          <span className="num ink2">
            {h.narrDone} {int(narr.done)} / {int(narr.total)}
          </span>
        )}
      </div>
      {narr && narr.done < narr.total && state.responses === 0 && (
        <div className="progress narr" role="progressbar" aria-label={h.narrAria} aria-valuenow={narr.done} aria-valuemin={0} aria-valuemax={narr.total} style={{ maxWidth: 420 }}>
          <i style={{ width: `${(narr.done / Math.max(1, narr.total)) * 100}%` }} />
        </div>
      )}
      {!done && (
        <div className="progress" aria-hidden="true" style={{ maxWidth: 420 }}>
          <i style={{ width: `${(state.responses / Math.max(1, state.total)) * 100}%` }} />
        </div>
      )}
      {target ? (
        <p className={compact ? "verdict-compact" : "verdict"}>
          {pay?.estimated ? (
            <>
              {h.estimated(int(target.n), who, pct(pay.estimated.value, pay.estimated.value < 0.1 ? 1 : 0), price)}
              {pay.lowTierYes && (
                <span className="ink2">
                  {" "}
                  ({h.lowTier(pct(pay.lowTierYes.share, 1), money(pay.lowTierYes.price, project?.currency))})
                </span>
              )}
              .
            </>
          ) : pay ? (
            h.observed(int(target.n), who, pct(pay.observed, 1), price)
          ) : (
            target.behaviors.payers === 0 ? h.payersNone(int(target.n), who, price) : h.payersSome(int(target.n), who, pct(target.behaviors.payers), one, price)
          )}{" "}
          {conf && (
            <a href="#fiabilite" className="pill-link" title={ctx.meta.methodNote}>
              <ConfidencePill c={conf} />
            </a>
          )}
        </p>
      ) : (
        <p className={compact ? "verdict-compact" : "verdict"}>{state.name}</p>
      )}
      {!compact && (
        <>
          {target && (
            <p className="verdict-sub">
              {h.tryFree(pct(target.behaviors.freeSignupOrMore))}{conf?.level === "low" ? h.indicative : ""}{h.notConcerned(pct(target.relevance.notConcernedShare))}
              {control && h.controlNotConcerned(control.n, pct(control.relevance.notConcernedShare))}.
            </p>
          )}
          <dl className="facts plain-facts">
            <dt>{h.whoAsked}</dt>
            <dd>
              {tp ? (
                <>
                  {state.groupSizes[tp.group] ?? tp.n}{" "}
                  {tp.criteria.length || tp.rawCriteria.length
                    ? h.targetPersonas
                    : ctx.meta.packs.find((p) => p.packVersion === tp.packVersion)?.memberLabel?.many ?? h.generalPersonas}
                  {cp && <span className="ink2">{h.forComparison(state.groupSizes[cp.group] ?? cp.n)}</span>}
                  {tp.criteria.length > 0 && (
                    <div className="ink2 one-line" title={tp.criteria.map(critText).join(" ; ")}>
                      {tp.criteria.map(critText).join(" · ")}
                    </div>
                  )}
                </>
              ) : (
                h.personasN(state.total)
              )}
            </dd>
            <dt>{h.priceTested}</dt>
            <dd className="num">
              {project?.referencePrice ?? price}
              {project?.pricing?.minimumOrder && <span className="ink2">{h.minOrder(money(project.pricing.minimumOrder.amount, project.currency))}</span>}
            </dd>
            <dt>{h.questionnaire}</dt>
            <dd>{s?.protocol ? h.tailored : h.standard}</dd>
            <dt>{h.date}</dt>
            <dd>
              {dateFr(state.createdAt)}
              {state.completedAt && <span className="ink2">{h.completedOn(dateFr(state.completedAt))}</span>}
            </dd>
          </dl>
        </>
      )}
      <RunPanel state={state} onState={ctx.setState} />
    </header>
  );
}

// ─── Vue d'ensemble ───────────────────────────────────────────────────────────


function useRecommendations(id: string) {
  const data = useApi<RecResponse>(`/studies/${id}/recommendations`);
  const reload = useCallback(() => void data.reload(), [data]);
  const { job, started } = useJob(`recommend-${id.replace(/[^A-Za-z0-9_-]+/g, "_")}`, data.data?.job, reload);
  const [err, setErr] = useState<string | null>(null);
  const generate = async (force = false) => {
    setErr(null);
    try {
      started(await api<{ key: string; pid: number; startedAt: string }>(`/studies/${id}/recommendations`, { json: { force } }));
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return { data: data.data, error: data.error, job, generate, err, reload };
}

const KIND_ICON: Record<string, string> = { prix: "€", cible: "◎", message: "✎", offre: "◆", questionnaire: "?", autre: "•" };

/** Paliers de prix proposés (bleus) face aux paliers actuels (gris), sur une petite échelle. */
function MiniTiers({ before, after, currency }: { before: number[]; after: number[]; currency?: string | undefined }) {
  const t = useDict(studyHubDict);
  const all = [...before, ...after];
  if (!after.length || !all.length) return null;
  const lo = Math.min(...all) * 0.75;
  const hi = Math.max(...all) * 1.08;
  const x = (v: number) => `${((v - lo) / (hi - lo)) * 100}%`;
  return (
    <div className="mini-tiers" role="img" aria-label={t.tiers.aria(before.map((x) => money(x, currency)).join(", ") || t.tiers.none, after.map((x) => money(x, currency)).join(", "))}>
      <div className="mt-line">
        {before.map((v) => (
          <i key={`b${v}`} className="was" style={{ left: x(v) }} title={t.tiers.today(money(v, currency))} />
        ))}
        {after.map((t) => (
          <i key={`a${t}`} className="new" style={{ left: x(t) }} />
        ))}
      </div>
      <div className="mt-labels" aria-hidden="true">
        {after.map((t) => (
          <span key={t} style={{ left: x(t) }}>
            {money(t, currency)}
          </span>
        ))}
      </div>
    </div>
  );
}

function RecommendationsCard({ id, project }: { id: string; project: ProjectDetail | null }) {
  const t = useDict(studyHubDict);
  const r = useRecommendations(id);
  const rec = r.data?.recommendations;
  const [more, setMore] = useState(false);
  const sentences = rec ? rec.headline.split(/(?<=[.!?])\s+/) : [];
  const lead = sentences[0] ?? "";
  const rest = sentences.slice(1).join(" ");
  return (
    <div className="pcard full rec-card">
      <Link href={`/etudes/${id}/recommandations`} className="pcard-title">
        {t.recCard.title}
      </Link>
      {rec ? (
        <>
          <p className="rec-lead">
            {lead}
            {rest && !more && (
              <>
                {" "}
                <button className="linklike small" type="button" onClick={() => setMore(true)}>
                  {t.recCard.readMore}
                </button>
              </>
            )}
            {more && rest && <span className="ink2"> {rest}</span>}
          </p>
          <ol className="rec-grid">
            {rec.recommendations.slice(0, 3).map((x, i) => {
              const tiers = x.kind === "prix" ? ((x.nextStudy?.projectPatch?.price as { tiers?: number[] } | undefined)?.tiers ?? (x.nextStudy?.projectPatch?.priceTiers as number[] | undefined) ?? null) : null;
              return (
                <li key={x.id}>
                  <Link href={`/etudes/${id}/recommandations#${x.id}`} className="rec-mini">
                    <span className="rec-kind">
                      <i aria-hidden="true">{KIND_ICON[x.kind] ?? "•"}</i>
                      {i + 1}. {t.kind[x.kind] ?? x.kind}
                    </span>
                    <span className="rec-title">{x.title}</span>
                    {tiers && <MiniTiers before={project?.priceTiers ?? []} after={tiers} currency={project?.currency} />}
                    <span className={`pill${x.confidence === "faible" ? " warn" : x.confidence === "moyenne" ? " muted" : ""} rec-conf`}>{t.strength[x.confidence] ?? x.confidence}</span>
                  </Link>
                </li>
              );
            })}
          </ol>
          <p className="small muted" style={{ margin: 0 }}>
            {t.recCard.generatedOn(dateFr(rec.generatedAt))}
            {rec.caveats.length ? (
              <>
                , <Link href={`/etudes/${id}/recommandations`}>{t.recCard.caveatsToRead(rec.caveats.length)}</Link>
              </>
            ) : (
              ""
            )}
            .
          </p>
        </>
      ) : (
        <div className="row" style={{ justifyContent: "space-between" }}>
          <p className="ink2" style={{ margin: 0 }} title={t.recCard.emptyTitle}>
            {t.recCard.empty}
          </p>
          <button className="btn" type="button" onClick={() => void r.generate()} disabled={Boolean(r.job?.alive)} title={t.recCard.aboutMinute}>
            {t.recCard.generate}
          </button>
          {r.data?.unavailable && <p className="small muted">{r.data.unavailable}</p>}
        </div>
      )}
      {r.err && <div className="error-box">{r.err}</div>}
      <JobPanel job={r.job} label={t.recCard.preparing} />
    </div>
  );
}

export function StudyOverviewPage({ id }: { id: string }) {
  return (
    <StudyFrame id={id} tab="apercu">
      {(c) => <Overview c={c} />}
    </StudyFrame>
  );
}

/** Prix affiché de l'étude, en nombre (« Offre Pro : 4 €/mois » → 4). */
function shownPriceOf(c: Ctx): number | null {
  const t = String(c.data.project?.referencePrice ?? c.data.project?.price ?? c.s?.project.price ?? "");
  return parseEvidenceValue(t.match(/\d[\d\s\u202f]*(?:[.,]\d+)?\s*€/)?.[0] ?? "")?.num ?? null;
}

function Overview({ c }: { c: Ctx }) {
  const t = useDict(studyHubDict);
  const o = t.overview;
  const { s, meta, id } = c;
  const rec = useRecoded(id);
  const recApi = useRecommendations(id);
  if (!s) return <Loading />;
  const base = `/etudes/${id}`;
  const list = s.groups.length > 1 ? s.groups.map((g) => ({ key: g.group, label: groupLabel(meta, g.group), a: g.analysis })) : [{ key: "all", label: o.sample, a: s.overall }];
  const target = s.groups.find((g) => g.group === "target")?.analysis ?? s.overall;
  const vw = target.vanWestendorp;
  const gg = target.gaborGranger;
  const best = gg.tiers.find((t) => t.price === gg.bestPrice);
  const outcome = s.drivers?.outcomes.find((o) => o.factors.some((f) => f.sentence)) ?? null;
  // Freins : recodés s'il existe un recodage, sinon catégories d'origine
  const recoding = rec.data?.recodings[0];
  const recodedDist = recoding ? recoding.groups.target ?? recoding.overall : null;
  const brakes = recodedDist
    ? recoding!.objections.map((o) => ({ label: o.label, share: recodedDist.shares[o.code] ?? 0 }))
    : meta.objections.map((o) => ({ label: o.label, share: target.objections.overall.shares[o.id as keyof typeof target.objections.overall.shares] ?? 0 }));
  brakes.sort((a, b) => b.share - a.share);
  const caveats = recApi.data?.recommendations?.caveats ?? [];
  const small = target.n < 30;
  return (
    <div className="cardgrid">
      <RecommendationsCard id={id} project={c.data.project} />

      <Link href={`${base}/reactions`} className="pcard wide">
        <span className="pcard-title">{o.reactions}</span>
        <MiniBars
          title={o.reactionsByGroup}
          series={list.map((g) => ({ key: g.key, label: list.length > 1 ? o.groupN(g.label, g.a.n) : "", color: groupColor(g.key === "all" ? "target" : g.key) }))}
          rows={(["interest", "trial"] as const).map((k) => ({
            label: { interest: o.interest, trial: o.trial }[k],
            values: list.map((g) => engagement(g.a, s.behaviorLevels)[k]),
          }))}
        />
        {target.payment ? (
          <PaymentMeasureView compact p={target.payment} price={(x) => money(x, c.data.project?.currency)} lowConfidence={s.confidence?.level === "low"} title={list.length > 1 ? o.paymentTarget : o.payment} />
        ) : (
          <MiniBars title={o.payment} rows={[{ label: o.wouldPay, values: list.map((g) => engagement(g.a, s.behaviorLevels).payment) }]} series={list.map((g) => ({ key: g.key, label: "", color: groupColor(g.key === "all" ? "target" : g.key) }))} />
        )}
        <p className="small ink2">{o.targetNotConcerned(pct(target.relevance.notConcernedShare))}</p>
      </Link>

      <Link href={`${base}/segments`} className="pcard">
        <span className="pcard-title">{o.whoResponds}</span>
        {outcome ? (
          <>
            <MiniBars
              title={o.byProfile(outcome.label)}
              series={[
                { key: "seg", label: o.thisProfile, color: "var(--g-target)" },
                { key: "rest", label: o.others, color: "var(--ev-related)" },
              ]}
              rows={outcome.factors
                .filter((f) => f.sentence)
                .slice(0, 2)
                .map((f) => {
                  const v = [...f.values].sort((x, y) => Number(x.small) - Number(y.small) || Math.abs(y.diffPts) - Math.abs(x.diffPts))[0]!;
                  return { label: t.labelValue(f.label, v.label), values: [v.rate, v.restRate] };
                })}
            />
            <p className="small muted" style={{ margin: 0 }}>
              {o.associations(outcome.label)}
            </p>
          </>
        ) : (
          <p className="ink2">{s.drivers ? o.tooFew : o.noDrivers}</p>
        )}
      </Link>

      <Link href={`${base}/prix`} className="pcard">
        <span className="pcard-title">{o.price}</span>
        {vw.n > 0 && vw.pmc !== null && vw.pme !== null ? (
          <>
            <div className="pcard-figure">
              <b>
                {o.range(eur(vw.pmc), eur(vw.pme))}
              </b>
            </div>
            <PriceScale title={o.priceScale} points={{ pmc: vw.pmc, pme: vw.pme, ...(vw.opp !== null && { opp: vw.opp }) }} shown={shownPriceOf(c)} best={best && best.revenuePer100 > 0 ? best.price : null} />
          </>
        ) : (
          <p className="ink2">{o.noRange}</p>
        )}
        <p className="small ink2">{o.neverPay(pct(vw.neverPayShare))}</p>
      </Link>

      <Link href={`${base}/freins`} className="pcard">
        <span className="pcard-title">{o.brakes}</span>
        <MiniBars title={o.topBrakes} rows={brakes.slice(0, 3).map((b) => ({ label: b.label, values: [b.share] }))} series={[{ key: "f", label: "", color: "var(--g-target)" }]} scale="full" />
        <p className="small muted">{recodedDist ? o.recoded(recoding!.key) : o.brakeShare}</p>
      </Link>

      <Link href={`${base}/verbatims`} className="pcard">
        <span className="pcard-title">{o.whatTheySay}</span>
        <div className="mini-quotes">
          {target.verbatims.slice(0, 3).map((v) => (
            <blockquote key={v.personaId}>
              {o.quote(v.text.length > 160 ? `${v.text.slice(0, 157)}…` : v.text)}<cite>{v.who.split(",").slice(0, 2).join(",")}</cite>
            </blockquote>
          ))}
        </div>
      </Link>

      <div className="pcard full" id="fiabilite">
        <span className="pcard-title">
          {o.reliability} {s.confidence && <ConfidencePill c={s.confidence} />}
        </span>
        <p className="positioning">{o.positioning}</p>
        {s.confidence && <ConfidenceDetail c={s.confidence} />}
        <details className="more">
          <summary className="small ink2">{o.details}</summary>
        <div style={{ maxWidth: 520 }}>
          <MiniBars
            title={o.quality}
            scale="full"
            rows={[
              { label: o.inconsistent, values: [s.overall.anomalies.rate] },
              { label: o.repaired, values: [s.overall.anomalies.repairedRate] },
              { label: o.narrativeRead, values: [s.overall.narrativeUsedShare] },
            ]}
            series={[{ key: "q", label: "", color: "var(--ev-related)" }]}
          />
        </div>
        <p className="small ink2">
          {o.cost(num(s.overall.usage.avgDurationMs / 1000, { maximumFractionDigits: 0 }), int(s.overall.usage.avgInputTokens + s.overall.usage.avgOutputTokens), int(s.overall.usage.totalInputTokens + s.overall.usage.totalOutputTokens))}
        </p>
        {(small || caveats.length > 0) && (
          <ul className="crit-list small">
            {small && !s.confidence && <li>{o.smallSample(target.n)}</li>}
            {caveats.slice(0, 2).map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
        )}
        </details>
        <p className="small muted">
          {o.signals} <Link href={`${base}/technique`}>{o.techDetails}</Link>
        </p>
      </div>
    </div>
  );
}

// ─── Sous-pages ───────────────────────────────────────────────────────────────

export function StudyReactionsPage({ id }: { id: string }) {
  return <StudyFrame id={id} tab="reactions">{(c) => c.s && <BehaviorsSection s={c.s} meta={c.meta} />}</StudyFrame>;
}

export function StudySegmentsPage({ id }: { id: string }) {
  const [, navigate] = useLocation();
  return (
    <StudyFrame id={id} tab="segments">
      {(c) =>
        c.s &&
        c.current && (
          <>
            {c.s.drivers && <DriversSection d={c.s.drivers} levelLabels={c.s.levelLabels} />}
            <SegmentsSection
              a={c.current}
              meta={c.meta}
              onCell={(dim, code, col, kind) => navigate(`/etudes/${id}/verbatims?${new URLSearchParams({ ...(c.hasGroups && c.group !== "all" && { groupe: c.group }), dim, code, [kind === "behavior" ? "reaction" : "frein"]: col })}`)}
            />
          </>
        )
      }
    </StudyFrame>
  );
}

export function StudyPricePage({ id }: { id: string }) {
  return (
    <StudyFrame id={id} tab="prix">
      {(c) => c.s && c.current && <PriceSection s={c.s} a={c.current} unit={c.unit} priceShown={c.data.project?.priceEur ?? null} meta={c.meta} groupName={c.hasGroups ? groupLabel(c.meta, c.group) : null} />}
    </StudyFrame>
  );
}

export function StudyBrakesPage({ id }: { id: string }) {
  const [, navigate] = useLocation();
  return (
    <StudyFrame id={id} tab="freins">
      {(c) =>
        c.s &&
        c.current && (
          <ObjectionsSection
            studyId={id}
            s={c.s}
            a={c.current}
            meta={c.meta}
            onMore={(cat) => navigate(`/etudes/${id}/verbatims?${new URLSearchParams({ ...(c.hasGroups && c.group !== "all" && { groupe: c.group }), frein: cat })}`)}
            groupName={c.hasGroups && c.group !== "all" ? groupLabel(c.meta, c.group) : null}
          />
        )
      }
    </StudyFrame>
  );
}

export function StudyVerbatimsPage({ id }: { id: string }) {
  const search = useSearch();
  const q = new URLSearchParams(search);
  const [filter, setFilter] = useState<VerbatimFilter>({
    ...EMPTY_FILTER,
    group: q.get("groupe") ?? "",
    behavior: q.get("reaction") ?? "",
    objection: q.get("frein") ?? "",
    dim: q.get("dim") ?? "",
    code: q.get("code") ?? "",
  });
  return (
    <StudyFrame id={id} tab="verbatims" needRows>
      {(c) => <VerbatimsSection studyId={id} rows={c.rows} meta={c.meta} filter={filter} setFilter={setFilter} hasGroups={c.hasGroups} />}
    </StudyFrame>
  );
}

export function StudyTechPage({ id }: { id: string }) {
  const t = useDict(studyHubDict);
  const tt = t.tech;
  return (
    <StudyFrame id={id} tab="technique">
      {(c) => {
        const st = c.state;
        return (
          <div className="stack" style={{ gap: 16, marginTop: 20 }}>
            <div className="panel">
              <h3 style={{ marginBottom: 10 }}>{tt.how}</h3>
              <dl className="facts">
                <dt>{tt.study}</dt>
                <dd>
                  {st.name} <span className="muted num">{st.id}</span>
                </dd>
                <dt>{tt.engine}</dt>
                <dd>
                  {st.backend}, {tt.model} {st.model}
                  {st.engine?.reportedModel && st.engine.reportedModel !== st.model && <span className="muted"> {tt.reportedModel(st.engine.reportedModel)}</span>}
                  {st.engine && !["claude-cli", "ollama"].includes(st.engine.profile) && <span className="muted">, {tt.profileLabel(st.engine.profile)}</span>}
                </dd>
                <dt>{tt.questionnaire}</dt>
                <dd>
                  {c.s?.protocol ? t.hero.tailored : t.hero.standard} <span className="muted">{tt.protocol(st.protocol, st.protocolVersion)}</span>
                </dd>
                <dt>{tt.seed}</dt>
                <dd className="num">{st.seed}</dd>
                {st.sampleFromStudyId && (
                  <>
                    <dt>{tt.samePersonas}</dt>
                    <dd>
                      <Link href={`/etudes/${st.sampleFromStudyId}`}>{st.sampleFromStudyId}</Link>
                    </dd>
                  </>
                )}
                <dt>{tt.created}</dt>
                <dd>{dateFr(st.createdAt)}</dd>
                {st.completedAt && (
                  <>
                    <dt>{tt.completed}</dt>
                    <dd>{dateFr(st.completedAt)}</dd>
                  </>
                )}
              </dl>
            </div>
            <div className="panel">
              <h3 style={{ marginBottom: 10 }}>{tt.populations}</h3>
              <div className="table-wrap">
                <table className="table fixed small">
                  <Cols widths={[110, 80, 120, 220, null]} />
                  <thead>
                    <tr>
                      <th>{tt.group}</th>
                      <th className="r">{tt.personas}</th>
                      <th>{tt.base}</th>
                      <th>{tt.modules}</th>
                      <th>{tt.selection}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {st.populations.map((p) => (
                      <tr key={p.group}>
                        <td>{groupLabel(c.meta, p.group)}</td>
                        <td className="r num">{st.groupSizes[p.group] ?? p.n}</td>
                        <td className="num">{p.eligibility?.socle ?? p.packVersion}</td>
                        <td className="num">{p.eligibility?.modules.join(", ") || tt.noneModules}</td>
                        <td>
                          {p.eligibility?.expression ? (
                            <>
                              <code className="expr">{p.eligibility.expression}</code>
                              <div className="muted">
                                {tt.eligibility(pct(p.eligibility.rate, 2), pct(p.eligibility.ci[0], 2), pct(p.eligibility.ci[1], 2), int(p.eligibility.draws), Boolean(p.eligibility.rare))}
                              </div>
                            </>
                          ) : (
                            <span className="muted">{tt.noFilter}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            {c.s && <CoherenceSection s={c.s} meta={c.meta} />}
          </div>
        );
      }}
    </StudyFrame>
  );
}

// ─── Recommandations ──────────────────────────────────────────────────────────

/** Sous-page qui porte une preuve, d'après sa source (« comportements », « prix », « freins »…). */
function evidenceLink(id: string, source: string): string | null {
  const s = source.toLowerCase();
  if (/prix|van|gabor|westendorp|tarif|price|tier|revenue/.test(s)) return `/etudes/${id}/prix`;
  if (/frein|objection|recod/.test(s)) return `/etudes/${id}/freins`;
  if (/facteur|driver|segment|accroche|factor|autodimension/.test(s)) return `/etudes/${id}/segments`;
  if (/verbatim|citation|quote/.test(s)) return `/etudes/${id}/verbatims`;
  if (/comportement|réaction|reaction|behavior|engagement|pertinen|relevance|forward|payers|freesignup|levels/.test(s)) return `/etudes/${id}/reactions`;
  return null;
}

/** Texte avant/après au mot près (mots retirés barrés, ajoutés surlignés). */
function TextDiff({ before, after }: { before: string; after: string }) {
  const t = useDict(studyHubDict);
  const d = wordDiff(before, after);
  return (
    <p className="pitch-text small" style={{ lineHeight: 1.6 }}>
      {d.tb.map((w, i) => (d.add.has(i) ? <ins key={`a${i}`}>{w.t}</ins> : <span key={`a${i}`}>{w.t}</span>))}
      {d.del.size > 0 && (
        <span className="muted">
          {" "}
          ({t.patch.removed}{" "}
          {[...d.del]
            .slice(0, 12)
            .map((i) => d.ta[i]!.t)
            .join(" ")}
          {d.del.size > 12 ? "…" : ""})
        </span>
      )}
    </p>
  );
}

function ChipsDiff({ before, after }: { before: string[]; after: string[] }) {
  const all = [...new Set([...before, ...after])];
  return (
    <ul className="fact-chips">
      {all.map((x) => (
        <li key={x} className={after.includes(x) && !before.includes(x) ? "ok" : !after.includes(x) ? "bad" : ""}>
          {after.includes(x) && !before.includes(x) ? "+ " : !after.includes(x) ? "− " : ""}
          {x}
        </li>
      ))}
    </ul>
  );
}

function PatchView({ patch, project, plainTarget }: { patch: Record<string, unknown>; project: ProjectDetail | null; plainTarget?: { before: PlainCrit[]; after: PlainCrit[]; afterRaw: string[] } | undefined }) {
  const t = useDict(studyHubDict);
  const current = (k: string): unknown => {
    if (!project) return undefined;
    const extra = project.extra as Record<string, unknown>;
    if (k === "price") return project.pricing ?? { amountEur: project.priceEur, period: project.pricePeriod };
    if (k in extra) return extra[k];
    return (project as unknown as Record<string, unknown>)[k];
  };
  const KEY_LABEL = t.patch.keys;
  type Offer = { label?: string; amount: number; unit?: string };
  type Price = { amountEur?: number; period?: string; offers?: Offer[]; currency?: string; tiers?: number[] };
  const offersOf = (v: unknown): Offer[] => {
    const o = v as Price | undefined;
    if (!o) return [];
    if (Array.isArray(o.offers)) return o.offers;
    return typeof o.amountEur === "number" ? [{ amount: o.amountEur, unit: o.period ?? "" }] : [];
  };
  const cur = project?.currency;
  const row = (k: string, v: unknown): ReactNode => {
    const before = current(k);
    if (k === "target") {
      return plainTarget ? (
        <div className="grid-2" style={{ gap: 12 }}>
          <ChipsDiff before={plainTarget.before.map((c) => (c.value ? t.labelValue(c.label, c.value) : c.label))} after={[...plainTarget.after.map((c) => (c.value ? t.labelValue(c.label, c.value) : c.label)), ...plainTarget.afterRaw]} />
        </div>
      ) : (
        <p className="small ink2">{t.patch.newTarget}</p>
      );
    }
    if (k === "price") {
      const ob = offersOf(before);
      const oa = offersOf(v);
      const tiersB = project?.priceTiers ?? [];
      const tiersA = (v as Price).tiers ?? [];
      return (
        <div className="stack" style={{ gap: 6 }}>
          {oa.map((o, i) => {
            const was = ob[i];
            return (
              <p key={i} className="small" style={{ margin: 0 }}>
                {o.label ? t.labelPrefix(o.label) : ""}
                {was && was.amount !== o.amount && <del className="muted">{money(was.amount, cur)}</del>} <b>{money(o.amount, cur)}</b>
              </p>
            );
          })}
          {tiersA.length > 0 && (
            <>
              <span className="small ink2">{t.patch.tiersTested(tiersA.map((x) => money(x, cur)).join(", "), tiersB.map((x) => money(x, cur)).join(", ") || t.tiers.none)}</span>
              <MiniTiers before={tiersB} after={tiersA} currency={cur} />
            </>
          )}
        </div>
      );
    }
    if (typeof v === "string") return <TextDiff before={typeof before === "string" ? before : ""} after={v} />;
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) return <ChipsDiff before={Array.isArray(before) ? (before as string[]) : []} after={v as string[]} />;
    return <pre className="yaml patch add">{JSON.stringify(v, null, 2)}</pre>;
  };
  return (
    <div className="stack" style={{ gap: 12 }}>
      {Object.entries(patch).map(([k, v]) => (
        <div key={k} className="patch-row">
          <span className="small ink2 patch-key">{KEY_LABEL[k] ?? k}</span>
          <div>{row(k, v)}</div>
        </div>
      ))}
      {"target" in patch && (
        <details className="more">
          <summary className="small ink2">{t.patch.targetBlock}</summary>
          <pre className="yaml patch add" style={{ marginTop: 6 }}>{JSON.stringify(patch.target, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}

function NextStudyBlock({ id, rec, canCreate, project, plainTarget }: { id: string; rec: Rec; canCreate: boolean; project: ProjectDetail | null; plainTarget?: { before: PlainCrit[]; after: PlainCrit[]; afterRaw: string[] } | undefined }) {
  const t = useDict(studyHubDict);
  const nx = t.next;
  const n = rec.nextStudy!;
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ studyId?: string; projectId?: string; projectFile?: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const create = async () => {
    setBusy(true);
    setErr(null);
    try {
      setDone(await api(`/studies/${id}/recommendations/${encodeURIComponent(rec.id)}/create-study`, { json: { confirm: true } }));
      setConfirming(false);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="next-study stack">
      <h4 className="subhead">{nx.title}</h4>
      <dl className="facts">
        <dt>{nx.hypothesis}</dt>
        <dd>{n.hypothesis}</dd>
        <dt>{nx.success}</dt>
        <dd>{n.successCriterion}</dd>
        <dt>{nx.sample}</dt>
        <dd>
          {nx.sampleText(n.n, t.sample[n.sample] ?? n.sample)}
          {n.control ? nx.withControl(typeof n.control === "number" ? n.control : null) : ""}
        </dd>
        {n.targetCheck && (
          <>
            <dt>{nx.targetSize}</dt>
            <dd className="num">
              {nx.targetSizeText(pct(n.targetCheck.rate, n.targetCheck.rate < 0.1 ? 2 : 1), int(n.targetCheck.draws))}
            </dd>
          </>
        )}
        <dt>{nx.cost}</dt>
        <dd className="num">
          {n.estimatedCalls !== undefined ? nx.calls(int(n.estimatedCalls)) : "?"}
          {n.estimatedMinutes !== undefined ? nx.minutes(int(n.estimatedMinutes)) : ""}
        </dd>
      </dl>
      <div>
        <p className="small ink2" style={{ marginBottom: 6 }}>{nx.changes}</p>
        <PatchView patch={n.projectPatch} project={project} plainTarget={plainTarget} />
      </div>
      {done ? (
        <p className="note-box small">
          {nx.created(done.projectId)}{" "}
          {done.studyId && <Link href={`/etudes/${done.studyId}`}>{nx.openToRun}</Link>}
        </p>
      ) : !confirming ? (
        <div className="row">
          <button className="btn" type="button" onClick={() => setConfirming(true)} disabled={!canCreate}>
            {nx.create}
          </button>
          {!canCreate && <span className="small muted">{nx.unavailable}</span>}
        </div>
      ) : (
        <div className="banner-block stack" role="alertdialog" aria-label={nx.confirmAria}>
          <p>{nx.confirmText(n.n, n.estimatedCalls ?? "?")}</p>
          <div className="row">
            <button className="btn" type="button" onClick={create} disabled={busy}>
              {busy ? nx.creating : nx.confirm}
            </button>
            <button className="btn ghost" type="button" onClick={() => setConfirming(false)} disabled={busy}>
              {nx.cancel}
            </button>
          </div>
        </div>
      )}
      {err && <div className="error-box">{err}</div>}
    </div>
  );
}

export function StudyRecommendationsPage({ id }: { id: string }) {
  const t = useDict(studyHubDict);
  const rp = t.recPage;
  const r = useRecommendations(id);
  return (
    <StudyFrame id={id} tab="recommandations">
      {(c) => {
        const d = r.data;
        if (!d && r.error) return <ErrorBox error={r.error} />;
        if (!d) return <Loading />;
        const rec = d.recommendations;
        const shownPrice = shownPriceOf(c);
        const tgt = c.s?.groups.find((g) => g.group === "target")?.analysis ?? c.s?.overall ?? null;
        const interestBase = tgt ? engagement(tgt, c.s?.behaviorLevels).interest * 100 : null;
        const charts = (ev: Evidence[]) => <EvidenceCharts ev={ev} shownPrice={shownPrice} interestBase={interestBase} linkOf={(e) => evidenceLink(id, `${e.source} ${e.metric}`)} />;
        return (
          <div className="stack" style={{ gap: 16, marginTop: 20 }}>
            {!rec ? (
              <div className="panel stack">
                <p>{rp.empty}</p>
                <div className="row">
                  <button className="btn" type="button" onClick={() => void r.generate()} disabled={Boolean(r.job?.alive)}>
                    {t.recCard.generate}
                  </button>
                  <span className="small muted">{rp.aboutMinute}</span>
                </div>
                {d.unavailable && <p className="small muted">{d.unavailable}</p>}
              </div>
            ) : (
              <>
                <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
                  <p className="pcard-sentence" style={{ maxWidth: "60ch" }}>{rec.headline}</p>
                  <button className="btn ghost small" type="button" onClick={() => void r.generate(true)} disabled={Boolean(r.job?.alive)}>
                    {rp.regenerate}
                  </button>
                </div>
                <p className="small muted">
                  {t.recCard.generatedOn(dateFr(rec.generatedAt))}
                  {rec.model ? ` (${rec.model})` : ""}.
                </p>
                {rec.verification && (
                  <p className="small ink2">
                    {rp.verified(rec.verification.evidenceValid, rec.verification.evidenceChecked)}
                    {rec.verification.dropped.length ? rp.droppedEvidence(rec.verification.dropped.length) : ""}
                    {rec.verification.droppedNextStudies.length ? rp.droppedStudies(rec.verification.droppedNextStudies.length) : ""}
                    {rec.relatedStudies?.length ? rp.related(rec.relatedStudies.join(", ")) : ""}.
                  </p>
                )}
                {c.s?.payment && (
                  <div className="panel stack">
                    <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
                      <h3>{rp.paymentLevel}</h3>
                      {c.s.confidence && <ConfidencePill c={c.s.confidence} />}
                    </div>
                    <PaymentMeasureView p={c.s.payment} price={(x) => money(x, c.data.project?.currency)} lowConfidence={c.s.confidence?.level === "low"} />
                    {c.s.confidence && (
                      <p className="small ink2">
                        <b>{rp.reliable}</b> {c.s.confidence.reliable.join(", ")}. <b>{rp.indicative}</b> {c.s.confidence.indicative.join(", ")}.
                      </p>
                    )}
                  </div>
                )}
                {rec.caveats.length > 0 && (
                  <div className="banner-block" role="note" style={{ marginTop: 0 }}>
                    <b>{rp.caveats}</b>
                    <ul className="notes small" style={{ marginTop: 6 }}>
                      {rec.caveats.map((x, i) => (
                        <li key={i}>{x}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <section className="section" style={{ marginTop: 16 }}>
                  <div className="section-head">
                    <h2>{rp.findings}</h2>
                  </div>
                  <div className="panel">
                    {rec.findings.map((f, i) => (
                      <div className="finding" key={i}>
                        <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
                          <h3>{f.title}</h3>
                          <span className={`pill${f.strength === "faible" ? " warn" : f.strength === "moyenne" ? " muted" : ""}`}>{t.evidenceStrength(f.strength)}</span>
                        </div>
                        <p style={{ marginTop: 4 }}>{f.detail}</p>
                        {charts(f.evidence)}
                      </div>
                    ))}
                  </div>
                </section>
                <section className="section">
                  <div className="section-head">
                    <h2>{rp.recommendations}</h2>
                    <p className="small ink2">{rp.ranked}</p>
                  </div>
                  <ol className="recs">
                    {rec.recommendations.map((x) => (
                      <li key={x.id} id={x.id} className="panel stack">
                        <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
                          <h3>{x.title}</h3>
                          <span className="row" style={{ gap: 6 }}>
                            <span className="tag">{t.kind[x.kind] ?? x.kind}</span>
                            <span className={`pill${x.confidence === "faible" ? " warn" : x.confidence === "moyenne" ? " muted" : ""}`}>{t.strength[x.confidence] ?? x.confidence}</span>
                          </span>
                        </div>
                        <p>{x.rationale}</p>
                        {charts(x.evidence)}
                        {x.nextStudy && <NextStudyBlock id={id} rec={x} canCreate={d.canCreate} project={c.data.project} plainTarget={d.plainTargets?.[x.id]} />}
                      </li>
                    ))}
                  </ol>
                </section>
              </>
            )}
            {r.err && <div className="error-box">{r.err}</div>}
            <JobPanel job={r.job} label={t.recCard.preparing} />
          </div>
        );
      }}
    </StudyFrame>
  );
}
