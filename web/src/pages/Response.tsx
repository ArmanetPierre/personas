import { Link } from "wouter";
import { useApi, useMetaState, type ResponseDetail } from "../api";
import { dateFr, ErrorBox, eur, int, Loading, money, num } from "../ui";
import { useContentLocale, useDict } from "../i18n";
import { studyDict } from "../i18n/study";
import { withBehaviorLabels } from "./Study";
import { PersonaCardView } from "./PersonaCard";
import { groupLabel } from "./Study";

interface Answer {
  spontaneousReaction?: string;
  relevance?: string;
  relevanceReason?: string;
  currentSolution?: string;
  alternatives?: string[];
  objections?: Array<{ category: string; detail: string }>;
  behavior?: string;
  behaviorReason?: string;
  wouldForward?: boolean;
  forwardTo?: string;
  vanWestendorp?: { wouldNeverPay: boolean; tooCheapEur: number | null; cheapEur: number | null; expensiveEur: number | null; tooExpensiveEur: number | null };
  gaborGranger?: Record<string, boolean>;
  budgetFit?: string;
  verbatim?: string;
}

/** « at_4_99_eur » → 4,99 */
const tierPrice = (k: string) => Number(k.replace(/^at_/, "").replace(/_eur$/, "").replace("_", "."));

export function ResponsePage({ studyId, personaId }: { studyId: string; personaId: string }) {
  const t = useDict(studyDict).response;
  const { meta: baseMeta, error: metaError } = useMetaState();
  const { data, error } = useApi<ResponseDetail>(`/studies/${studyId}/responses/${encodeURIComponent(personaId)}`);
  useContentLocale(data?.project?.locale);
  const meta = withBehaviorLabels(baseMeta, data?.project?.behaviorLabels);
  if (error) return <ErrorBox error={error} />;
  if (metaError && !meta) return <ErrorBox error={metaError} />;
  if (!data || !meta) return <Loading />;
  const r = data.response;
  const payload = r.payload as { answer?: Answer; encounter?: string; initialAnomalies?: string[]; originalAnswer?: Answer; priceShown?: number; tiers?: number[] };
  const a = payload.answer ?? {};
  const label = (list: Array<{ id: string; label: string }>, id?: string) => list.find((x) => x.id === id)?.label ?? id ?? "—";
  const unit = data.project?.unit ?? t.defaultUnit;
  const m = (x: number | null | undefined) => money(x, data.project?.currency ?? "EUR");
  const vw = a.vanWestendorp;

  return (
    <>
      <div className="crumbs">
        <Link href="/">{t.projects}</Link>
        <span>/</span>
        {data.project && <Link href={`/projets/${data.project.id}`}>{data.project.name}</Link>}
        <span>/</span>
        <Link href={`/etudes/${studyId}/verbatims`}>{data.study.id}</Link>
        <span>/</span>
        <span>
          {data.persona.firstName ?? "?"}, {t.age(data.persona.age)}
        </span>
      </div>
      <div className="grid-2" style={{ gap: 24, alignItems: "start" }}>
        <div className="panel">
          <PersonaCardView p={data.persona} />
        </div>
        <div className="panel">
          <div className="answer-block">
            <div className="row small" style={{ gap: 8, marginBottom: 10 }}>
              <span className="tag">{groupLabel(meta, data.group)}</span>
              <span className="tag">{meta.encounters[payload.encounter ?? ""] ?? payload.encounter ?? t.unknownEncounter}</span>
              {r.repaired && <span className="tag warn">{t.repaired}</span>}
            </div>
            <blockquote style={{ margin: 0, fontFamily: "var(--font-display)", fontSize: 22, lineHeight: 1.3, fontWeight: 480 }}>{t.quote(a.verbatim)}</blockquote>
          </div>
          <div className="answer-block">
            <h3>{t.reactionTitle}</h3>
            <div className="kv">
              <div>{t.spontaneous}</div>
              <div>{a.spontaneousReaction}</div>
              <div>{t.relevance}</div>
              <div>
                <b>{label(meta.relevance, a.relevance)}</b> : {a.relevanceReason}
              </div>
              <div>{t.currentSolution}</div>
              <div>{a.currentSolution}</div>
              <div>{t.alternatives}</div>
              <div>{a.alternatives?.length ? a.alternatives.join(", ") : "—"}</div>
            </div>
          </div>
          <div className="answer-block">
            <h3>{t.behaviorTitle}</h3>
            <div className="kv">
              <div>{t.wouldDo}</div>
              <div>
                <b>{label(meta.behaviors, a.behavior)}</b> : {a.behaviorReason}
              </div>
              <div>{t.wouldForward}</div>
              <div>{a.wouldForward ? t.forwardYes(a.forwardTo) : t.no}</div>
            </div>
          </div>
          <div className="answer-block">
            <h3>{t.objections}</h3>
            {a.objections?.length ? (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {a.objections.map((o, i) => (
                  <li key={i}>
                    <b>{label(meta.objections, o.category)}</b> : {o.detail}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="ink2">{t.noObjection}</p>
            )}
          </div>
          <div className="answer-block">
            <h3>{t.price}</h3>
            <div className="kv">
              <div>Van Westendorp</div>
              <div className="num">
                {!vw ? "—" : vw.wouldNeverPay ? t.neverPay : t.vw(m(vw.tooCheapEur), m(vw.cheapEur), m(vw.expensiveEur), m(vw.tooExpensiveEur))}
              </div>
              <div>Gabor-Granger</div>
              <div className="num">
                {Object.entries(a.gaborGranger ?? {})
                  .sort(([x], [y]) => tierPrice(x) - tierPrice(y))
                  .map(([k, v]) => t.tier(m(tierPrice(k)), v))
                  .join(t.tierSep)}
                <span className="muted">{t.perUnit(unit)}</span>
              </div>
              <div>{t.budget}</div>
              <div>{a.budgetFit || "—"}</div>
            </div>
          </div>
          <div className="answer-block">
            <h3>{t.coherence}</h3>
            <div className="kv">
              <div>{t.beforeRepair}</div>
              <div>{payload.initialAnomalies?.length ? payload.initialAnomalies.map((c) => meta.checks[c] ?? c).join(t.checkSep) : t.noAnomaly}</div>
              <div>{t.remaining}</div>
              <div>{r.anomalies.length ? r.anomalies.map((c) => meta.checks[c] ?? c).join(t.checkSep) : t.none}</div>
            </div>
            {payload.originalAnswer && (
              <details style={{ marginTop: 10 }}>
                <summary className="small ink2" style={{ cursor: "pointer" }}>{t.original}</summary>
                <pre className="json">{JSON.stringify(payload.originalAnswer, null, 2)}</pre>
              </details>
            )}
          </div>
          <div className="answer-block">
            <h3>{t.engine}</h3>
            <div className="kv num">
              <div>{t.backend}</div>
              <div>
                {r.backend}, {r.model}
              </div>
              <div>{t.tokens}</div>
              <div>{t.tokensValue(int(r.inputTokens), int(r.cacheReadTokens), int(r.outputTokens))}</div>
              <div>{t.duration}</div>
              <div>{t.durationValue(num(r.durationMs / 1000, 1), r.attempts)}</div>
              <div>{t.narrative}</div>
              <div>{r.narrativeUsed ? t.yes : t.no}</div>
              <div>{t.writtenAt}</div>
              <div>{dateFr(r.createdAt)}</div>
            </div>
            <details style={{ marginTop: 10 }}>
              <summary className="small ink2" style={{ cursor: "pointer" }}>{t.fullJson}</summary>
              <pre className="json">{JSON.stringify(r.payload, null, 2)}</pre>
            </details>
          </div>
        </div>
      </div>
    </>
  );
}
