import type { ReactNode } from "react";
import { Link } from "wouter";
import { useWidth } from "./charts";
import { getLocale, tr, useDict } from "./i18n";
import { chartsDict } from "./i18n/charts";
import { num as fmtNum } from "./ui";

/**
 * Graphiques déduits des preuves d'une recommandation. Chaque preuve porte un libellé, une valeur
 * en texte (« 14,5 % », « 2,25 € », « −0,5 pt ») et un chemin JSON ; la famille du chemin choisit le graphique :
 * points Van Westendorp → échelle de prix ; demande par palier → petites barres ; deltaPts → barres divergentes ;
 * parts (intérêt, payeurs, freins, segments) → barres horizontales ; V de Cramér → texte discret.
 */

export interface EvidenceItem {
  metric: string;
  value: unknown;
  source: string;
}

type Unit = "%" | "€" | "pt" | null;
interface Parsed {
  num: number;
  unit: Unit;
  suffix: string;
}

/** « 14,5 % » → 14,5 et %, « 2,25 €/mois » → 2,25 et €, « −13,5 pts » → −13,5 et pt. */
export function parseEvidenceValue(v: unknown): Parsed | null {
  if (typeof v === "number") return Number.isFinite(v) ? { num: v > 0 && v < 1 ? v * 100 : v, unit: v > 0 && v < 1 ? "%" : null, suffix: "" } : null;
  if (typeof v !== "string") return null;
  let s = v.replace(/\u00a0|\u202f/g, " ");
  // Anglais : « €2.25 », « 1,234.5 » (virgule = séparateur de milliers)
  let pre = "";
  if (getLocale() === "en") {
    s = s.replace(/(\d),(?=\d{3}\b)/g, "$1");
    const pm = s.match(/^\s*([+\-−–]?)\s*€\s*(?=\d)/);
    if (pm) {
      pre = "€";
      s = `${pm[1]}${s.slice(pm[0].length)}`;
    }
  }
  const m = s.match(/^\s*([+\-−–]?)\s*(\d[\d ]*(?:[.,]\d+)?)\s*(%|€|pts?\b)?\s*(.*)$/);
  if (!m) return null;
  const num = Number(m[2]!.replace(/ /g, "").replace(",", ".")) * (m[1] && m[1] !== "+" ? -1 : 1);
  if (!Number.isFinite(num)) return null;
  const u = m[3] ?? pre;
  const rest = (m[4] ?? "").trim();
  if (rest.length > 12) return null; // une phrase (verbatim) qui commence par un nombre
  return { num, unit: u === "%" ? "%" : u === "€" ? "€" : u.startsWith("pt") ? "pt" : null, suffix: rest };
}

type Family = "vw" | "best" | "demand" | "delta" | "cramer" | "share" | "text";
function family(e: EvidenceItem, p: Parsed | null): Family {
  const s = e.source;
  if (/cramersV/i.test(s)) return "cramer";
  if (!p) return "text";
  if (/deltaPts/.test(s) || (p.unit === "pt" && /écart|gap|difference/i.test(e.metric))) return "delta";
  if (/vanWestendorp\.(pmc|opp|ipp|pme)\b/.test(s) && p.unit === "€") return "vw";
  if (/gaborGranger\.bestPrice/.test(s) && p.unit === "€") return "best";
  if (/gaborGranger.*demand/.test(s) && p.unit === "%") return "demand";
  if (p.unit === "%") return "share";
  return "text";
}

/** Qui porte la valeur : la cible, la comparaison, une étude liée. La couleur suit cette identité. */
type Who = "target" | "control" | "related";
function who(source: string): Who {
  if (/^related\./.test(source)) return "related";
  if (/^groups\[1\]/.test(source)) return "control";
  return "target";
}
const WHO_COLOR: Record<Who, string> = { target: "var(--g-target)", control: "var(--g-control)", related: "var(--ev-related)" };
const whoLabel = (w: Who) => tr(chartsDict).evidence.who[w];

/** Nombre selon la langue (« 14,5 » / « 14.5 »). */
const fr = (n: number, d = 1) => fmtNum(n, { maximumFractionDigits: d });
const fmt = (p: Parsed) => {
  const u = tr(chartsDict).units;
  return p.unit === "%"
    ? u.percent(fr(p.num))
    : p.unit === "€"
      ? `${u.euro(fr(p.num, 2))}${p.suffix.startsWith("/") ? p.suffix : ""}`
      : p.unit === "pt"
        ? u.points(`${p.num > 0 ? "+" : p.num < 0 ? "−" : ""}${fr(Math.abs(p.num))}`, Math.abs(p.num) >= 2)
        : fr(p.num, 3);
};

/** Libellé court : « Demande à 2 € » → « à 2 € » quand le titre du panneau dit déjà « Demande ». */
const shortDemand = (metric: string) => metric.replace(/^(demande|demand)\s*/i, "").replace(/^\((.*)\)$/, "$1") || metric;

interface Row {
  e: EvidenceItem;
  p: Parsed;
  who: Who;
}

// ─── Barres horizontales (parts) ──────────────────────────────────────────────

function ShareBars({ rows, title, label = (r) => r.e.metric, baseline }: { rows: Row[]; title: string; label?: (r: Row) => string; baseline?: { value: number; label: string } | null }) {
  const max = Math.max(1, ...rows.map((r) => r.p.num), baseline?.value ?? 0);
  const top = max <= 40 ? Math.ceil(max / 10) * 10 : 100; // petite plage zoomée sur 0-40 %, sinon 0-100 %
  const t = useDict(chartsDict);
  const whos = [...new Set(rows.map((r) => r.who))];
  return (
    <figure className="evchart" role="group" aria-label={title}>
      <figcaption>{title}</figcaption>
      {whos.length > 1 && (
        <div className="legend small">
          {whos.map((w) => (
            <span key={w}>
              <i style={{ background: WHO_COLOR[w] }} />
              {whoLabel(w)}
            </span>
          ))}
        </div>
      )}
      <div className="evbars">
        {rows.map((r, i) => (
          <div className="evbar" key={i} title={r.e.source}>
            <span className="lbl">{label(r)}</span>
            <span className="track" aria-hidden="true">
              <i style={{ width: `${Math.max(0.6, (r.p.num / top) * 100)}%`, background: WHO_COLOR[r.who] }} />
              {baseline && <s style={{ left: `${(baseline.value / top) * 100}%` }} />}
            </span>
            <b className="num">{fmt(r.p)}</b>
            <span className="sr-only">
              {label(r)}
              {t.units.colon}
              {fmt(r.p)}
            </span>
          </div>
        ))}
      </div>
      <div className="evbar evaxis muted" aria-hidden="true">
        <span />
        <span className="ticks">
          <span>0</span>
          <span>{t.units.percent(String(top))}</span>
        </span>
        <span />
      </div>
      {baseline && (
        <p className="evbase small muted">
          <s /> {baseline.label}
          {t.units.colon}
          {t.units.percent(fr(baseline.value))}
        </p>
      )}
    </figure>
  );
}

// ─── Barres divergentes (écarts entre variantes) ──────────────────────────────

function DeltaBars({ rows }: { rows: Row[] }) {
  const t = useDict(chartsDict);
  const max = Math.max(5, ...rows.map((r) => Math.abs(r.p.num)));
  return (
    <figure className="evchart" role="group" aria-label={t.evidence.deltaAria}>
      <figcaption>{t.evidence.deltaTitle}</figcaption>
      <div className="evbars">
        {rows.map((r, i) => {
          const w = (Math.abs(r.p.num) / max) * 50;
          return (
            <div className="evbar" key={i} title={r.e.source}>
              <span className="lbl">{r.e.metric}</span>
              <span className="track diverging" aria-hidden="true">
                <i style={{ width: `${Math.max(0.6, w)}%`, left: r.p.num < 0 ? `${50 - w}%` : "50%", background: r.p.num < 0 ? "var(--div-neg)" : "var(--div-pos)", borderRadius: r.p.num < 0 ? "4px 0 0 4px" : "0 4px 4px 0" }} />
                <s style={{ left: "50%" }} />
              </span>
              <b className="num">{fmt(r.p)}</b>
              <span className="sr-only">
                {r.e.metric}
                {t.units.colon}
                {fmt(r.p)}
              </span>
            </div>
          );
        })}
      </div>
      <div className="evbar evaxis muted" aria-hidden="true">
        <span />
        <span className="ticks">
          <span>−{fr(max, 0)}</span>
          <span>0</span>
          <span>+{fr(max, 0)}</span>
        </span>
        <span />
      </div>
    </figure>
  );
}

// ─── Échelle de prix ──────────────────────────────────────────────────────────

const VW_KEY = (s: string) => s.match(/vanWestendorp\.(pmc|opp|ipp|pme)\b/)?.[1] ?? "";

export function PriceScale({
  points,
  shown,
  best,
  tiers = [],
  title: titleProp,
}: {
  points: Partial<Record<"pmc" | "opp" | "ipp" | "pme", number>>;
  shown?: number | null;
  best?: number | null;
  tiers?: number[];
  title?: string;
}) {
  const t = useDict(chartsDict);
  const title = titleProp ?? t.evidence.priceTitle;
  const eu = (v: number) => t.units.euro(fr(v, 2));
  const [box, W] = useWidth(320);
  const vals = [points.pmc, points.opp, points.ipp, points.pme, shown, best, ...tiers].filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (vals.length < 2) return null;
  const lo = 0;
  const hi = Math.max(...vals) * 1.12;
  const m = { l: 10, r: 14 };
  const x = (v: number) => m.l + ((v - lo) / (hi - lo)) * (W - m.l - m.r);
  const has = (v: number | undefined | null): v is number => typeof v === "number" && Number.isFinite(v);
  const sr = [
    has(points.pmc) && has(points.pme) ? t.evidence.sr.range(fr(points.pmc, 2), fr(points.pme, 2)) : null,
    has(points.opp) ? t.evidence.sr.opp(fr(points.opp, 2)) : null,
    has(points.ipp) ? t.evidence.sr.ipp(fr(points.ipp, 2)) : null,
    has(best) ? t.evidence.sr.best(fr(best, 2)) : null,
    has(shown) ? t.evidence.sr.shown(fr(shown, 2)) : null,
  ]
    .filter(Boolean)
    .join(", ");
  // Quatre lignes d'étiquettes sans collision : revenu max (haut), optimum, bornes de la plage, prix affiché (bas)
  const H = 100;
  const axisY = 48;
  const anchor = (px: number) => (px < 70 ? "start" : px > W - 70 ? "end" : "middle");
  return (
    <figure className="evchart" aria-label={title}>
      <figcaption>{title}</figcaption>
      <div ref={box}>
        <svg className="chart" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}${t.units.colon}${sr}`}>
          {has(points.pmc) && has(points.pme) && (
            <>
              <rect x={x(points.pmc)} y={axisY - 7} width={Math.max(2, x(points.pme) - x(points.pmc))} height={14} rx={4} fill="var(--ev-range)" />
              <text x={x(points.pmc)} y={axisY + 24} textAnchor="end" dx={4} className="axis-label" style={{ fontSize: 11 }}>
                {eu(points.pmc)}
              </text>
              <text x={x(points.pme)} y={axisY + 24} textAnchor="start" dx={-4} className="axis-label" style={{ fontSize: 11 }}>
                {eu(points.pme)}
              </text>
            </>
          )}
          <line x1={m.l} x2={W - m.r} y1={axisY} y2={axisY} stroke="var(--axis)" />
          {tiers.map((tp) => (
            <line key={tp} x1={x(tp)} x2={x(tp)} y1={axisY - 4} y2={axisY + 4} stroke="var(--muted)" />
          ))}
          {has(points.ipp) && <circle cx={x(points.ipp)} cy={axisY} r={3.5} fill="var(--panel)" stroke="var(--ink-2)" strokeWidth={1.5} />}
          {has(best) && (
            <g>
              <line x1={x(best)} x2={x(best)} y1={16} y2={axisY + 7} stroke="var(--ink-2)" strokeDasharray="3 2" />
              <text x={x(best)} y={11} textAnchor={anchor(x(best))} className="axis-label" style={{ fontSize: 11 }}>
                {t.evidence.bestLabel(eu(best))}
              </text>
            </g>
          )}
          {has(points.opp) && (
            <g>
              <path d={`M${x(points.opp)},${axisY - 7} l6,7 l-6,7 l-6,-7 Z`} fill="var(--g-target)" stroke="var(--panel)" strokeWidth={2} />
              <text x={x(points.opp)} y={axisY - 13} textAnchor={anchor(x(points.opp))} className="val" style={{ fontSize: 11 }}>
                {t.evidence.oppLabel(eu(points.opp))}
              </text>
            </g>
          )}
          {has(shown) && (
            <g>
              <path d={`M${x(shown)},${axisY + 8} l5,8 h-10 Z`} fill="var(--ink)" />
              <text x={x(shown)} y={H - 4} textAnchor={anchor(x(shown))} className="val" style={{ fontSize: 11 }}>
                {t.evidence.shownLabel(eu(shown))}
              </text>
            </g>
          )}
        </svg>
      </div>
      <p className="evkey small muted">
        {has(points.pmc) && has(points.pme) && (
          <span>
            <i className="range" /> {t.evidence.keyRange}
          </span>
        )}
        {has(points.opp) && (
          <span>
            <i className="opp" /> {t.evidence.keyOpp}
          </span>
        )}
        {has(shown) && (
          <span>
            <i className="shown" /> {t.evidence.keyShown}
          </span>
        )}
      </p>
    </figure>
  );
}

// ─── Assemblage ───────────────────────────────────────────────────────────────

/**
 * Graphiques d'une liste de preuves, puis les preuves en pastilles discrètes (chemin JSON en infobulle).
 * `shownPrice` : prix affiché de l'étude ; `interestBase` : intérêt moyen de la cible (repère des segments).
 */
export function EvidenceCharts({
  ev,
  shownPrice,
  interestBase,
  linkOf,
}: {
  ev: EvidenceItem[];
  shownPrice?: number | null;
  interestBase?: number | null;
  linkOf?: (e: EvidenceItem) => string | null;
}) {
  const t = useDict(chartsDict);
  const tq = t.evidence;
  if (!ev.length) return null;
  const all = ev.map((e) => {
    const p = parseEvidenceValue(e.value);
    return { e, p, f: family(e, p), who: who(e.source) };
  });
  const rows = (f: Family) => all.filter((a) => a.f === f && a.p).map((a) => ({ e: a.e, p: a.p!, who: a.who }));
  const vw = rows("vw").filter((r) => r.who !== "related" || rows("vw").every((x) => x.who === "related"));
  const best = rows("best")[0]?.p.num ?? null;
  const demand = rows("demand");
  const delta = rows("delta");
  const shares = rows("share");
  const isSegment = (r: Row) => /segments\[|drivers\.|factors\[/.test(r.e.source);
  const segs = shares.filter(isSegment);
  const plain = shares.filter((r) => !isSegment(r));
  const cramer = all.filter((a) => a.f === "cramer");
  const texts = all.filter((a) => a.f === "text" && typeof a.e.value === "string" && a.e.value.length > 20);
  const points = Object.fromEntries(vw.map((r) => [VW_KEY(r.e.source), r.p.num])) as Partial<Record<"pmc" | "opp" | "ipp" | "pme", number>>;
  const tierPrices = demand.map((r) => parseEvidenceValue(r.e.metric.replace(/^.*?(?:à|\bat)\s*/i, ""))?.num).filter((v): v is number => typeof v === "number" && v > 0);
  const shownHere = vw.every((r) => r.who === "target") ? shownPrice ?? null : null;
  const priceChart = vw.length >= 1 && vw.length + (best !== null ? 1 : 0) + (shownHere ? 1 : 0) >= 2;
  const charts: ReactNode[] = [];
  if (priceChart) charts.push(<PriceScale key="price" points={points} shown={shownHere} best={best} tiers={tierPrices} />);
  if (demand.length) charts.push(<ShareBars key="demand" rows={demand} title={t.evidence.demandTitle} label={(r) => shortDemand(r.e.metric)} />);
  if (plain.length) charts.push(<ShareBars key="shares" rows={plain} title={plain.every((r) => /objection|frein|barrier|recoded/i.test(`${r.e.source} ${r.e.metric}`)) ? t.evidence.objectionsTitle : t.evidence.sharesTitle} />);
  if (segs.length) charts.push(<ShareBars key="segs" rows={segs} title={t.evidence.segmentsTitle} baseline={interestBase != null && segs.every((r) => /intér|interest/i.test(r.e.metric)) ? { value: interestBase, label: t.evidence.targetAverage } : null} />);
  if (delta.length) charts.push(<DeltaBars key="delta" rows={delta} />);
  return (
    <div className="evidence-block">
      {charts.length > 0 && <div className="evcharts">{charts}</div>}
      {texts.map((t, i) => (
        <blockquote key={i} className="evquote" title={t.e.source}>
          {tq.quote(String(t.e.value))}<span className="muted small"> {t.e.metric}</span>
        </blockquote>
      ))}
      {cramer.length > 0 && (
        <p className="small muted">
          {t.evidence.cramerLead}{" "}
          {cramer.map((c, i) => (
            <span key={i} title={c.e.source}>
              {i > 0 && " ; "}
              {c.e.metric.replace(/^V de Cram[ée]r\s*/i, "").replace(/^Cram[ée]r'?s V\s*/i, "")} {t.evidence.cramer(String(c.e.value))}
            </span>
          ))}
        </p>
      )}
      <ul className="evidence small-pills" aria-label={t.evidence.evidenceAria}>
          {ev.map((e, i) => {
            const href = linkOf?.(e) ?? null;
            const body = (
              <>
                {e.metric}
                {t.units.colon}
                <b className="num">{typeof e.value === "string" ? e.value : JSON.stringify(e.value)}</b>
              </>
            );
            return (
              <li key={i} title={t.evidence.source(e.source)}>
                {href ? <Link href={href}>{body}</Link> : body}
              </li>
            );
          })}
      </ul>
    </div>
  );
}

// ─── Mini-barres pour les cartes de synthèse ─────────────────────────────────

/**
 * Barres horizontales compactes (parts de 0 à 1). Une ou plusieurs séries par ligne ; valeur écrite
 * à droite de chaque barre, texte complet pour les lecteurs d'écran.
 */
export function MiniBars({
  rows,
  series = [{ key: "v", label: "", color: "var(--g-target)" }],
  scale = "auto",
  title,
}: {
  rows: Array<{ label: string; values: Array<number | null> }>;
  series?: Array<{ key: string; label: string; color: string }>;
  scale?: "auto" | "full";
  title: string;
}) {
  const t = useDict(chartsDict);
  const max = Math.max(0.01, ...rows.flatMap((r) => r.values.map((v) => v ?? 0)));
  const top = scale === "full" || max > 0.4 ? 1 : Math.ceil(max * 10) / 10;
  const p = (v: number) => t.units.percent(fr(v * 100));
  return (
    <div className="minibars" role="group" aria-label={title} >
      {series.length > 1 && (
        <div className="legend small">
          {series.map((s) => (
            <span key={s.key}>
              <i style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
      <div className="evbars">
        {rows.map((r) => (
          <div className="evbar" key={r.label}>
            <span className="lbl">{r.label}</span>
            <span className="tracks" aria-hidden="true">
              {series.map((s, i) => {
                const v = r.values[i];
                return (
                  <span className="track" key={s.key}>
                    {v !== null && v !== undefined && <i style={{ width: `${Math.max(0.8, (v / top) * 100)}%`, background: s.color }} />}
                  </span>
                );
              })}
            </span>
            <span className="vals">
              {series.map((s, i) => {
                const v = r.values[i];
                return (
                  <b className="num" key={s.key}>
                    {v === null || v === undefined ? "—" : p(v)}
                  </b>
                );
              })}
            </span>
            <span className="sr-only">
              {r.label}
              {t.units.colon}
              {series.map((s, i) => `${s.label ? `${s.label} ` : ""}${r.values[i] == null ? t.evidence.noData : p(r.values[i]!)}`).join(", ")}
            </span>
          </div>
        ))}
      </div>
      <div className="evbar evaxis muted" aria-hidden="true">
        <span />
        <span className="ticks">
          <span>0</span>
          <span>{t.units.percent(fr(top * 100, 0))}</span>
        </span>
        <span />
      </div>
    </div>
  );
}
