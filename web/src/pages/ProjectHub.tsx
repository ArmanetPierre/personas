import { useEffect, useState, type ReactNode } from "react";
import { PitchTonePanel, ToneGauge } from "./ProjectPitch";
import { MiniBars } from "../evidence-charts";
import { PaymentMeasureView } from "../payment";
import { Link, useLocation, useSearch } from "wouter";
import { api, useApi, useMeta, type ProjectDetail, type ProjectTargeting, type StudyListItem } from "../api";
import { JobPanel, useJob } from "../jobs";
import { dateFr, ErrorBox, int, Loading, money, num, pct, Status } from "../ui";
import { tr, useContentLocale, useDict } from "../i18n";
import { projectDict } from "../i18n/project";
import { ModuleStatus } from "./Modules";
import { moduleLink, NewStudyForm, StudiesTable } from "./Project";
import { labelOf, ProtocolTables, TargetPreviewPanel, TargetSuggestionPanel, type ProtocolResponse } from "./ProjectP1";

/**
 * Page Projet en divulgation progressive : une vue d'ensemble en cartes (chiffres clés, une phrase chacune),
 * et une sous-page par carte (qui on teste, l'offre, le questionnaire, les études). Le langage clair passe
 * d'abord ; les termes techniques (socle, module, filtre d'éligibilité…) sont en infobulle ou repliés.
 */

// ─── Données ──────────────────────────────────────────────────────────────────

interface Criterion {
  label: string;
  value: string;
  source: "socle" | "module";
  module?: string;
  variable: string;
}
interface GroupView {
  socle: string;
  socleLabel: string;
  /** Nom de la zone du socle (« de France métropolitaine », « en France », « de la population française »). */
  zone?: { of: string; in: string; population: string };
  modules: Array<{ id: string; label: string }>;
  criteria: Criterion[];
  rawCriteria: string[];
  expression: string | null;
  quotas: Record<string, Record<string, number>> | null;
  n: number | null;
  adults: number | null;
  eligibility: { rate: number; ci: [number, number]; draws: number; rare: boolean } | null;
  estimatedPeople: number | null;
  error: string | null;
}
export interface Overview {
  project: { id: string; name: string; pitch: string; updatedAt: string; sourceFile: string | null; locale?: "fr" | "en" };
  target: GroupView | null;
  control: GroupView | null;
  triage: { share: number; ci: [number, number]; alert: boolean; alertShare: number; seed: number; generatedAt: string } | null;
  protocol: { custom: boolean; productType: string | null; productTypeLabel: string | null; behaviors: number; objections: number; proposal: { generatedAt: string | null } | null };
  studies: { count: number; withResponses: number; running: number; lastAt: string | null };
  lastStudy: {
    id: string;
    name: string;
    status: string;
    createdAt: string;
    responses: number;
    total: number;
    n: number;
    interest: number;
    freeTrialOrMore: number;
    payers: number;
    payment?: import("../payment").Payment | null;
    confidence?: { level: "high" | "medium" | "low"; label: string; score: number } | null;
    protocolVersion?: string;
    notConcerned: number;
    price: string;
    topObjection: { label: string; share: number } | null;
    custom: boolean;
    recommendation?: { headline: string; top: { title: string; confidence: string } | null } | null;
  } | null;
}
interface ProjectData {
  project: ProjectDetail;
  studies: StudyListItem[];
  targeting?: ProjectTargeting;
}

const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const people = (x: number) =>
  x >= 1_000_000 ? tr(projectDict).fmt.millions(num(x / 1_000_000, { maximumFractionDigits: 1 }), x >= 2_000_000) : int(Math.round(x / 1000) * 1000);
const criterionText = (c: Criterion) => (c.value ? tr(projectDict).fmt.criterion(cap(c.label), c.value) : cap(c.label));

// ─── Cadre commun : en-tête, actions, onglets ─────────────────────────────────

type Tab = "apercu" | "cible" | "offre" | "protocole" | "etudes";
const tabs = (): Array<{ id: Tab; label: string; path: string }> => {
  const t = tr(projectDict).frame;
  return [
    { id: "apercu", label: t.tabOverview, path: "" },
    { id: "cible", label: t.tabTarget, path: "/cible" },
    { id: "offre", label: t.tabOffer, path: "/offre" },
    { id: "protocole", label: t.tabProtocol, path: "/protocole" },
    { id: "etudes", label: t.tabStudies, path: "/etudes" },
  ];
};

/** Action principale selon l'état du projet ; les autres actions restent accessibles, en retrait. */
function primaryAction(id: string, o: Overview | null, t: ProjectTargeting | undefined): { label: string; href: string; why: string } {
  const base = `/projets/${id}`;
  const blocking = t?.blocking ?? [];
  const d = tr(projectDict).frame;
  if (blocking.length) return { label: d.validateModules, href: moduleLink(blocking[0]!), why: d.validateModulesWhy };
  if (o?.protocol.proposal) return { label: d.reviewProposal, href: `${base}/protocole/revue`, why: d.reviewProposalWhy };
  if (o && o.studies.running > 0) return { label: d.followRunning, href: `${base}/etudes`, why: d.followRunningWhy };
  if (o?.target && !o.triage) return { label: d.checkTarget, href: `${base}/cible#apercu`, why: d.checkTargetWhy };
  return { label: d.launchStudy, href: `${base}/etudes?nouvelle=1`, why: "" };
}

export function ProjectFrame({ id, tab, children }: { id: string; tab: Tab; children: (d: { data: ProjectData; overview: Overview | null; reload: () => void }) => ReactNode }) {
  const proj = useApi<ProjectData>(`/projects/${encodeURIComponent(id)}`);
  const ov = useApi<Overview>(`/projects/${encodeURIComponent(id)}/overview`);
  const [pitchOpen, setPitchOpen] = useState(false);
  const [more, setMore] = useState(false);
  const tf = useDict(projectDict).frame;
  useContentLocale(proj.data?.project.locale ?? ov.data?.project.locale);
  if (proj.error) return <ErrorBox error={proj.error} />;
  if (!proj.data) return <Loading />;
  const p = proj.data.project;
  const base = `/projets/${encodeURIComponent(p.id)}`;
  const primary = primaryAction(p.id, ov.data, proj.data.targeting);
  const reload = () => {
    void proj.reload();
    void ov.reload();
  };
  const secondary = [
    ...(proj.data.targeting?.target ? [{ label: tf.previewTarget, href: `${base}/cible#apercu` }, { label: tf.suggestTarget, href: `${base}/cible#assistant` }] : []),
    { label: tf.suggestProtocol, href: `${base}/protocole#proposer` },
    { label: tf.newStudy, href: `${base}/etudes?nouvelle=1` },
    ...(proj.data.studies.length >= 2 ? [{ label: tf.compare, href: `/comparer?project=${encodeURIComponent(p.id)}` }] : []),
  ].filter((a) => a.href !== primary.href);
  return (
    <>
      <div className="crumbs">
        <Link href="/">{tf.crumbProjects}</Link>
        <span>/</span>
        {tab === "apercu" ? <span>{p.name}</span> : <Link href={base}>{p.name}</Link>}
      </div>
      <header className="proj-head">
        <div className="proj-title">
          <h1>{p.name}</h1>
          <p className={`pitch${pitchOpen ? " open" : ""}`}>{p.pitch}</p>
          <button className="linklike small" type="button" onClick={() => setPitchOpen(!pitchOpen)} aria-expanded={pitchOpen}>
            {pitchOpen ? tf.foldPitch : tf.readPitch}
          </button>
        </div>
        <div className="proj-actions" role="group" aria-label={tf.actionsAria}>
          <Link className="btn" href={primary.href}>
            {primary.label}
          </Link>
          <div className="more">
            <button className="btn ghost" type="button" aria-expanded={more} aria-haspopup="menu" onClick={() => setMore(!more)}>
              {tf.moreActions}
            </button>
            {more && (
              <div className="menu" role="menu">
                {secondary.map((a) => (
                  <Link key={a.href} href={a.href} role="menuitem" onClick={() => setMore(false)}>
                    {a.label}
                  </Link>
                ))}
              </div>
            )}
          </div>
          {primary.why && <p className="small ink2 why">{primary.why}</p>}
        </div>
      </header>
      <nav className="tabs" aria-label={tf.sectionsAria}>
        {tabs().map((t) => (
          <Link key={t.id} href={`${base}${t.path}`} aria-current={t.id === tab ? "page" : undefined}>
            {t.label}
          </Link>
        ))}
      </nav>
      {children({ data: proj.data, overview: ov.data, reload })}
    </>
  );
}

// ─── Vue d'ensemble ───────────────────────────────────────────────────────────

/** Part de la population retenue : une barre fine où la part sélectionnée reste visible même très petite. */
function ShareBar({ share }: { share: number }) {
  return (
    <div className="sharebar" role="img" aria-label={tr(projectDict).fmt.shareOfAdults(pct(share, share < 0.1 ? 1 : 0))}>
      <i style={{ width: `max(3px, ${Math.min(1, share) * 100}%)` }} />
    </div>
  );
}

export function ProjectOverviewPage({ id }: { id: string }) {
  const d = useDict(projectDict);
  const tv = d.overview;
  return (
    <ProjectFrame id={id} tab="apercu">
      {({ data, overview: o }) => {
        const base = `/projets/${encodeURIComponent(id)}`;
        const p = data.project;
        if (!o) return <Loading what={tv.loading} />;
        const t = o.target;
        const blocking = data.targeting?.blocking ?? [];
        return (
          <div className="cardgrid">
            {/* Qui on teste */}
            <Link href={`${base}/cible`} className="pcard wide">
              <span className="pcard-title">{tv.whoTitle}</span>
              {t ? (
                <>
                  <div className="pcard-figure">
                    {t.estimatedPeople !== null ? (
                      <>
                        <b>≈ {people(t.estimatedPeople)}</b> <span>{tv.people}</span>
                      </>
                    ) : (
                      <b>{t.criteria.length ? tv.filteredTarget : tv.wholePopulation}</b>
                    )}
                  </div>
                  {t.eligibility && t.adults && (
                    <>
                      <p className="small ink2">
                        {tv.adultsShare(pct(t.eligibility.rate, t.eligibility.rate < 0.1 ? 1 : 0), people(t.adults), t.zone?.of)}
                        {t.eligibility.rare && <span className="tag warn" style={{ marginLeft: 6 }}>{tv.rareTarget}</span>}
                      </p>
                      <ShareBar share={t.eligibility.rate} />
                    </>
                  )}
                  <p className="small ink2 one-line" title={[...t.criteria.map(criterionText), ...t.rawCriteria].join(d.fmt.listSep)}>
                    {t.criteria.length || t.rawCriteria.length ? [...t.criteria.map(criterionText), ...(t.rawCriteria.length ? [tv.advancedCriteria(t.rawCriteria.length)] : [])].join(" · ") : tv.noCriteria}
                  </p>
                  <div className="row" style={{ gap: 8 }}>
                    {o.triage ? (
                      <span className={`pill${o.triage.alert ? " warn" : ""}`} title={tv.triageTitle(o.triage.seed, dateFr(o.triage.generatedAt))}>
                        {tv.notConcerned(pct(o.triage.share))}
                      </span>
                    ) : (
                      <span className="pill muted">{tv.notChecked}</span>
                    )}
                    {blocking.length > 0 && <span className="pill warn">{tv.toValidate(blocking.length)}</span>}
                    {o.control && <span className="pill muted">{tv.plusControl}</span>}
                  </div>
                </>
              ) : (
                <p className="ink2">{tv.noTarget}</p>
              )}
            </Link>

            {/* L'offre */}
            <Link href={`${base}/offre`} className="pcard">
              <span className="pcard-title">{tv.offerTitle}</span>
              <div className="pcard-figure">
                <b>{p.referencePrice ?? p.price}</b>
              </div>
              <p className="small ink2">{p.pricing?.freemium || p.freeOffer ? tv.withFree : tv.withoutFree}</p>
              <p className="small muted">{tv.testedPrices(p.priceTiers.map((x) => money(x, p.currency)).join(", "))}</p>
              {p.pitchTone && (
                <div className="stack" style={{ gap: 4 }}>
                  <ToneGauge compact label={tv.pitchTone} score={p.pitchTone.score} threshold={p.pitchTone.threshold} />
                  {p.pitchTone.warn && <span className="pill warn">{tv.pitchTooSalesy}</span>}
                </div>
              )}
            </Link>

            {/* Dernière étude */}
            <Link href={o.lastStudy ? `/etudes/${o.lastStudy.id}` : `${base}/etudes`} className="pcard wide">
              <span className="pcard-title">{tv.lastStudyTitle}</span>
              {o.lastStudy ? (
                <>
                  <p className="pcard-sentence">
                    {o.lastStudy.payment?.estimated
                      ? tv.estimatedPaying(o.lastStudy.n, pct(o.lastStudy.payment.estimated.value, o.lastStudy.payment.estimated.value < 0.1 ? 1 : 0), o.lastStudy.price)
                      : tv.wouldPay(o.lastStudy.n, o.lastStudy.payers === 0 ? null : pct(o.lastStudy.payers), o.lastStudy.price)}{" "}
                    {o.lastStudy.confidence && (
                      <span className={`pill${o.lastStudy.confidence.level === "low" ? " warn" : o.lastStudy.confidence.level === "medium" ? " muted" : ""}`} style={{ fontSize: 12, verticalAlign: "middle" }}>
                        {tv.confidence(o.lastStudy.confidence.label)}
                      </span>
                    )}
                  </p>
                  <MiniBars
                    title={tv.reactions}
                    rows={[
                      { label: tv.interested, values: [o.lastStudy.interest] },
                      { label: tv.wouldTry, values: [o.lastStudy.freeTrialOrMore] },
                      ...(o.lastStudy.payment ? [] : [{ label: tv.wouldPayBar, values: [o.lastStudy.payers] }]),
                    ]}
                  />
                  {o.lastStudy.payment && <PaymentMeasureView compact p={o.lastStudy.payment} price={(x) => money(x, p.currency)} lowConfidence={o.lastStudy.confidence?.level === "low"} />}
                  {o.lastStudy.topObjection && (
                    <MiniBars title={tv.mainBarrier} scale="full" rows={[{ label: tv.topBarrier(o.lastStudy.topObjection.label.toLowerCase()), values: [o.lastStudy.topObjection.share] }]} series={[{ key: "f", label: "", color: "var(--ev-related)" }]} />
                  )}
                  {o.lastStudy.recommendation?.top && (
                    <p className="small rec-hint">
                      {tv.mainRec}
                      <b>{o.lastStudy.recommendation.top.title}</b> <span className="muted">{tv.recConfidence(o.lastStudy.recommendation.top.confidence)}</span>
                    </p>
                  )}
                  <p className="small muted">
                    {o.lastStudy.name}, {dateFr(o.lastStudy.createdAt)}
                    {o.lastStudy.responses < o.lastStudy.total && tv.responsesOf(o.lastStudy.responses, o.lastStudy.total)}
                  </p>
                </>
              ) : (
                <p className="ink2">{tv.noStudy}</p>
              )}
            </Link>

            {/* Le questionnaire */}
            <Link href={`${base}/protocole`} className="pcard">
              <span className="pcard-title">{tv.protocolTitle}</span>
              <div className="pcard-figure">
                <b>{o.protocol.custom ? tv.adapted : tv.standard}</b>
              </div>
              <p className="small ink2">
                {o.protocol.custom ? tv.customSummary(o.protocol.productTypeLabel, o.protocol.behaviors, o.protocol.objections) : tv.standardSummary}
              </p>
              {o.protocol.proposal && <span className="pill warn">{tv.proposalPending}</span>}
            </Link>

            {/* Études */}
            <Link href={`${base}/etudes`} className="pcard full">
              <span className="pcard-title">{tv.studiesTitle}</span>
              <div className="studies-strip">
                <div>
                  <div className="pcard-figure">
                    <b>{o.studies.count}</b> <span>{tv.studiesUnit(o.studies.count)}</span>
                  </div>
                  <p className="small ink2">
                    {o.studies.running ? tv.running(o.studies.running) : ""}
                    {tv.withResponses(o.studies.withResponses)}
                    {o.studies.withResponses >= 2 ? tv.comparable : ""}
                  </p>
                </div>
                {data.studies.length > 0 && (
                  <ul className="strip-list">
                    {data.studies.slice(0, 3).map((s) => (
                      <li key={s.id}>
                        <span className="ellipsis">{s.name}</span>
                        <Status status={s.status} />
                        <span className="small muted num nowrap">{dateFr(s.createdAt)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </Link>
          </div>
        );
      }}
    </ProjectFrame>
  );
}

// ─── Qui on teste ─────────────────────────────────────────────────────────────

function GroupDetail({ title, g, t, isControl }: { title: string; g: GroupView; t: ProjectTargeting | undefined; isControl?: boolean }) {
  const d = useDict(projectDict);
  const tt = d.target;
  return (
    <div className="panel stack">
      <h3>{title}</h3>
      <div className="kpis">
        <div>
          <b className="num">≈ {people(g.estimatedPeople ?? g.adults ?? 0)}</b>
          <span title={g.socleLabel}>{tt.peopleIn(g.zone?.in)}</span>
        </div>
        <div>
          <b className="num">{g.n ?? "—"}</b>
          <span>{tt.personasPerStudy}</span>
        </div>
      </div>
      {g.expression && g.eligibility && (
        <div title={tt.eligibilityTitle(pct(g.eligibility.rate, 2), pct(g.eligibility.ci[0], 2), pct(g.eligibility.ci[1], 2))}>
          <ShareBar share={g.eligibility.rate} />
          <p className="small ink2" style={{ margin: "4px 0 0" }}>
            {tt.matchShare(pct(g.eligibility.rate, g.eligibility.rate < 0.1 ? 1 : 0))}
          </p>
        </div>
      )}
      {g.criteria.length || g.rawCriteria.length ? (
        <details className="more">
          <summary className="small">
            <span className="one-line" style={{ flex: "1 1 0", minWidth: 0 }}>
              {[...g.criteria.map(criterionText), ...g.rawCriteria].join(" · ")}
            </span>
          </summary>
          <ul className="crit-list" style={{ marginTop: 8 }}>
            {g.criteria.map((c, i) => (
              <li key={i}>
                {criterionText(c)}{" "}
                <span className="tag" title={c.source === "module" ? tt.moduleTag(String(c.module)) : tt.socleTag}>
                  {c.source === "module" ? tt.addedTrait : tt.basePopulation}
                </span>
              </li>
            ))}
            {g.rawCriteria.map((r, i) => (
              <li key={`r${i}`}>
                <code className="expr">{r}</code>
              </li>
            ))}
          </ul>
        </details>
      ) : (
        <p className="small ink2">{isControl ? tt.controlDefault : tt.targetDefault}</p>
      )}
      {g.modules.length > 0 && (
        <div>
          <h4 className="subhead" title={tt.modulesTitle}>{tt.addedTraits}</h4>
          <ul className="crit-list">
            {g.modules.map((m) => {
              const st = t?.modules.find((x) => x.id === m.id);
              return (
                <li key={m.id} className="row" style={{ gap: 8 }}>
                  <Link href={moduleLink(st ?? { id: m.id, status: "validated" })}>{m.label}</Link>
                  <ModuleStatus status={st?.status ?? "validated"} />
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {g.quotas && (
        <div>
          <h4 className="subhead" title={tt.quotasTitle}>{tt.quotasHead}</h4>
          <p className="small">
            {Object.entries(g.quotas)
              .map(([dim, v]) => d.fmt.criterion(dim, Object.entries(v).map(([c, x]) => tt.quotaPart(c, Math.round(x * 100))).join(", ")))
              .join(d.fmt.listSep)}
          </p>
        </div>
      )}
      <details>
        <summary className="small ink2" style={{ cursor: "pointer" }}>{tt.technical}</summary>
        <dl className="facts small" style={{ marginTop: 8 }}>
          <dt>{tt.socle}</dt>
          <dd>{g.socle}</dd>
          <dt>{tt.modules}</dt>
          <dd>{g.modules.map((m) => m.id).join(", ") || tt.none}</dd>
          <dt>{tt.eligibilityFilter}</dt>
          <dd>{g.expression ? <code className="expr">{g.expression}</code> : tt.none}</dd>
          {g.eligibility && (
            <>
              <dt>{tt.draws}</dt>
              <dd className="num">{tt.drawsValue(int(g.eligibility.draws))}</dd>
            </>
          )}
        </dl>
      </details>
    </div>
  );
}

export function ProjectTargetPage({ id }: { id: string }) {
  useHashScroll();
  const tt = useDict(projectDict).target;
  return (
    <ProjectFrame id={id} tab="cible">
      {({ data, overview: o, reload }) => {
        const t = data.targeting;
        if (!o) return <Loading />;
        if (!o.target) return <div className="empty" style={{ marginTop: 24 }}>{tt.noTarget}</div>;
        const blocking = t?.blocking ?? [];
        return (
          <div className="stack" style={{ gap: 8 }}>
            <p className="lede" style={{ marginTop: 20 }}>
              <span title={o.control ? tt.controlExplain : undefined}>{tt.lede(o.target.zone?.population)}</span>
            </p>
            {blocking.length > 0 && (
              <div className="banner-block" role="status">
                <b>{tt.toValidate}</b>{" "}
                {blocking.map((m, i) => (
                  <span key={m.id}>
                    {i > 0 && ", "}
                    <Link href={moduleLink(m)}>{m.id}</Link>
                  </span>
                ))}
                .
              </div>
            )}
            <div className="grid-2" style={{ marginTop: 12 }}>
              <GroupDetail title={tt.theTarget} g={o.target} t={t} />
              {o.control ? <GroupDetail title={tt.theControl} g={o.control} t={t} isControl /> : <div className="panel ink2">{tt.noControl}</div>}
            </div>
            <section className="section" id="apercu">
              <div className="section-head">
                <h2>{tt.check}</h2>
              </div>
              <TargetPreviewPanel projectId={data.project.id} hasControl={Boolean(t?.control)} />
            </section>
            <section className="section" id="assistant">
              <div className="section-head">
                <h2>{tt.improve}</h2>
                <p className="small ink2">{tt.improveHint}</p>
              </div>
              <TargetSuggestionPanel projectId={data.project.id} onApplied={reload} />
            </section>
          </div>
        );
      }}
    </ProjectFrame>
  );
}

// ─── L'offre ──────────────────────────────────────────────────────────────────

export function ProjectOfferPage({ id }: { id: string }) {
  const meta = useMeta();
  const d = useDict(projectDict);
  const to = d.offer;
  return (
    <ProjectFrame id={id} tab="offre">
      {({ data }) => {
        const p = data.project;
        return (
          <div className="stack" style={{ gap: 16, marginTop: 20 }}>
            <div className="grid-2-1">
              <div className="panel stack">
                <h3>{to.whatPersonasSee}</h3>
                <p style={{ lineHeight: 1.6, maxWidth: "70ch" }}>{p.pitch}</p>
                {(p.freeOffer || p.pricing?.freemium) && (
                  <dl className="facts">
                    {(p.pricing?.freemium?.free ?? p.freeOffer) && (
                      <>
                        <dt>{to.free}</dt>
                        <dd>{p.pricing?.freemium?.free ?? p.freeOffer}</dd>
                      </>
                    )}
                    {p.pricing?.freemium?.paid && (
                      <>
                        <dt>{to.paid}</dt>
                        <dd>{p.pricing.freemium.paid}</dd>
                      </>
                    )}
                  </dl>
                )}
              </div>
              <div className="panel stack">
                <h3>{to.price}</h3>
                <p className="pcard-figure">
                  <b>{p.referencePrice ?? p.price}</b>
                </p>
                {p.pricing && p.pricing.offers.length > 1 && <p className="small ink2">{to.allPlans(p.price)}</p>}
                {p.pricing?.minimumOrder && (
                  <p className="small ink2">
                    {to.minimumOrder(money(p.pricing.minimumOrder.amount, p.currency))}
                    {p.pricing.minimumOrder.note ? ` (${p.pricing.minimumOrder.note})` : ""}
                  </p>
                )}
                <p className="small">
                  <span title={to.tiersTitle}>{to.testedPrices}</span>
                  {d.fmt.colon}
                  {p.priceTiers.map((t) => money(t, p.currency)).join(", ")}
                  {p.unitId !== "month" && <span className="muted">{to.perUnit(p.unit)}</span>}
                </p>
              </div>
            </div>
            <PitchTonePanel id={p.id} />
            <div className="grid-2">
              <div className="panel stack">
                <h3>{to.competitors}</h3>
                {p.competitors.length ? (
                  <ul className="crit-list">
                    {p.competitors.map((c) => (
                      <li key={c}>{c}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="ink2">{to.none}</p>
                )}
              </div>
              <div className="panel stack">
                <h3>{to.withoutOffer}</h3>
                {p.alternatives.length ? (
                  <ul className="crit-list">
                    {p.alternatives.map((c) => (
                      <li key={c}>{c}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="ink2">{to.noAlternatives}</p>
                )}
              </div>
            </div>
            {(p.targetAudience || p.businessModel) && (
              <div className="panel stack">
                <h3>{to.notes}</h3>
                <dl className="facts">
                  {p.targetAudience && (
                    <>
                      <dt>{to.forWhom}</dt>
                      <dd>{p.targetAudience}</dd>
                    </>
                  )}
                  {p.businessModel && (
                    <>
                      <dt>{to.businessModel}</dt>
                      <dd>{p.businessModel}</dd>
                    </>
                  )}
                </dl>
              </div>
            )}
            <details className="panel">
              <summary className="small ink2" style={{ cursor: "pointer" }}>{to.technical}</summary>
              <dl className="facts small" style={{ marginTop: 8 }}>
                <dt>{to.id}</dt>
                <dd className="num">{p.id}</dd>
                <dt>{to.sourceFile}</dt>
                <dd>{String((p.extra as { sourceFile?: string }).sourceFile ?? to.noSourceFile)}</dd>
                <dt>{to.currencyUnit}</dt>
                <dd>{to.currencyUnitValue(p.currency ?? "EUR", p.unit)}</dd>
                {p.currency && p.currency !== "EUR" && p.pricing && (
                  <>
                    <dt>{to.fx}</dt>
                    <dd className="num">
                      {to.fxValue(
                        p.currency,
                        num(p.pricing.fx?.eurPerUnit ?? meta?.currencies?.find((c) => c.id === p.currency)?.fx?.eurPerUnit ?? NaN, {}),
                        p.pricing.fx ? to.fxDate(p.pricing.fx.date) : to.fxTable,
                      )}
                    </dd>
                  </>
                )}
              </dl>
            </details>
          </div>
        );
      }}
    </ProjectFrame>
  );
}

// ─── Le questionnaire ─────────────────────────────────────────────────────────

export function ProjectProtocolPage({ id }: { id: string }) {
  useHashScroll();
  const proto = useApi<ProtocolResponse>(`/projects/${encodeURIComponent(id)}/protocol`);
  const { job, started } = useJob(`protocol-${id.replace(/[^A-Za-z0-9_-]+/g, "_")}`, proto.data?.job, () => void proto.reload());
  const [err, setErr] = useState<string | null>(null);
  const tp = useDict(projectDict).protocol;
  const propose = async () => {
    setErr(null);
    try {
      started(await api<{ key: string; pid: number; startedAt: string }>(`/projects/${id}/protocol/suggest`, { method: "POST" }));
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <ProjectFrame id={id} tab="protocole">
      {() => {
        const d = proto.data;
        if (proto.error) return <ErrorBox error={proto.error} />;
        if (!d) return <Loading />;
        return (
          <div className="stack" style={{ gap: 16, marginTop: 20 }}>
            <p className="lede">
              {tp.lede}{" "}
              <span className="muted small" title={tp.protocolTitle}>{tp.protocolWord}</span>
            </p>
            <div className="grid-2">
              <div className="panel stack">
                <h3>{tp.current}</h3>
                <p className="pcard-figure">
                  <b>{d.resolved.custom ? tp.adapted : tp.standard}</b>
                </p>
                <p className="small ink2">
                  {d.resolved.custom
                    ? tp.customText(labelOf(d.vocab.productTypes, d.resolved.productType))
                    : tp.standardText}
                </p>
              </div>
              <div className="panel stack" id="proposer">
                <h3>{tp.assistant}</h3>
                {d.proposal ? (
                  <>
                    <p>
                      {tp.pending(dateFr(d.proposal.generatedAt), Boolean(d.proposal.evidence), d.proposal.evidence?.respondents ?? "?")}
                    </p>
                    <div className="row">
                      <Link className="btn" href={`/projets/${id}/protocole/revue`}>
                        {tp.review}
                      </Link>
                      <button className="btn ghost small" type="button" onClick={propose} disabled={Boolean(job?.alive)}>
                        {tp.askNew}
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="ink2">{tp.explain}</p>
                    <div className="row">
                      <button className="btn" type="button" onClick={propose} disabled={Boolean(job?.alive)}>
                        {tp.propose}
                      </button>
                    </div>
                  </>
                )}
                {err && <div className="error-box">{err}</div>}
                <JobPanel job={job} label={tp.jobLabel} hint={tp.jobHint} />
              </div>
            </div>
            <section className="section">
              <div className="section-head">
                <h2>{tp.detail}</h2>
                <p className="small ink2">
                  {tp.detailBefore}
                  <span title={tp.levelsTitle}>{tp.commonLevel}</span>
                  {tp.detailAfter}
                </p>
              </div>
              <div className="panel">
                <ProtocolTables p={d.resolved} vocab={d.vocab} />
              </div>
            </section>
          </div>
        );
      }}
    </ProjectFrame>
  );
}

// ─── Études ───────────────────────────────────────────────────────────────────

export function ProjectStudiesPage({ id }: { id: string }) {
  const search = useSearch();
  const [open, setOpen] = useState(new URLSearchParams(search).get("nouvelle") === "1");
  useEffect(() => {
    if (new URLSearchParams(search).get("nouvelle") === "1") setOpen(true);
  }, [search]);
  const [, navigate] = useLocation();
  const ts = useDict(projectDict).studiesPage;
  return (
    <ProjectFrame id={id} tab="etudes">
      {({ data }) => {
        const blocking = data.targeting?.blocking ?? [];
        return (
          <div className="stack" style={{ gap: 12, marginTop: 20 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <p className="ink2">{ts.intro}</p>
              <div className="row">
                {data.studies.length >= 2 && (
                  <Link className="btn ghost small" href={`/comparer?project=${encodeURIComponent(id)}`}>
                    {ts.compare}
                  </Link>
                )}
                <button
                  className="btn"
                  type="button"
                  onClick={() => {
                    setOpen(!open);
                    if (open) navigate(`/projets/${id}/etudes`, { replace: true });
                  }}
                  aria-expanded={open}
                  disabled={blocking.length > 0}
                  title={blocking.length ? ts.blockedTitle : undefined}
                >
                  {open ? ts.close : ts.newStudy}
                </button>
              </div>
            </div>
            {blocking.length > 0 && (
              <div className="banner-block" role="status">
                <b>{ts.toValidate}</b>{" "}
                {blocking.map((m, i) => (
                  <span key={m.id}>
                    {i > 0 && ", "}
                    <Link href={moduleLink(m)}>{m.id}</Link>
                  </span>
                ))}
                .
              </div>
            )}
            {open && blocking.length === 0 && (
              <div className="panel">
                <NewStudyForm project={data.project} targeting={data.targeting ?? null} />
              </div>
            )}
            <StudiesTable studies={data.studies} />
            {data.studies.some((s) => s.status === "running") && (
              <p className="small ink2">
                <Status status="running" />
                {ts.runningNote}
              </p>
            )}
          </div>
        );
      }}
    </ProjectFrame>
  );
}

/** Après chargement, fait défiler jusqu'à l'ancre de l'URL (#apercu, #assistant, #proposer). */
function useHashScroll() {
  useEffect(() => {
    const h = window.location.hash.slice(1);
    if (!h) return;
    let tries = 0;
    const t = setInterval(() => {
      const el = document.getElementById(h);
      if (el || ++tries > 20) {
        clearInterval(t);
        el?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }, 150);
    return () => clearInterval(t);
  }, []);
}
