import { useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from "react";
import { useDict } from "./i18n";
import { chartsDict } from "./i18n/charts";
import { eur, money, pct, useTooltip } from "./ui";

/**
 * Graphiques en SVG et HTML faits main : barres fines (≤ 24 px), extrémités arrondies,
 * 2 px d'espace entre segments, grilles en filet, étiquettes directes sélectives, infobulle au survol
 * et au focus clavier. Les valeurs restent lisibles sans couleur (étiquettes, tableaux).
 */

// ─── Couleurs par rôle (variables CSS, voir styles.css) ───────────────────────

export const BEHAVIOR_TOKEN: Record<string, string> = {
  ignore: "ignore",
  save_for_later: "save",
  visit_page: "1",
  free_signup: "2",
  free_active: "3",
  pay_subscription: "4",
  recommend: "5",
};
/**
 * Échelle propre à un protocole : couleurs attribuées par niveau canonique (gris pour l'inaction,
 * rampe bleue pour l'engagement, dans l'ordre de l'échelle).
 */
export function setBehaviorScale(levels: Record<string, string> | null | undefined): void {
  if (!levels) return;
  const codes = Object.keys(levels);
  const inaction = codes.filter((c) => levels[c] === "inaction");
  inaction.forEach((c, i) => (BEHAVIOR_TOKEN[c] = i === 0 ? "ignore" : "save"));
  const engaged = codes.filter((c) => levels[c] !== "inaction");
  const byLevel: Record<string, string[]> = { interest: ["1"], free_trial: ["2", "3"], payment: ["4"], recommendation: ["5"] };
  engaged.forEach((c, i) => {
    if (engaged.length <= 5) BEHAVIOR_TOKEN[c] = String(1 + Math.round((i * 4) / Math.max(1, engaged.length - 1)));
    else {
      const opts = byLevel[levels[c]!] ?? ["1"];
      const k = engaged.slice(0, i).filter((x) => levels[x] === levels[c]).length;
      BEHAVIOR_TOKEN[c] = opts[Math.min(k, opts.length - 1)]!;
    }
  });
}

export const behaviorColor = (b: string) => `var(--b-${BEHAVIOR_TOKEN[b] ?? "ignore"})`;
export const behaviorText = (b: string) => `var(--bt-${BEHAVIOR_TOKEN[b] ?? "ignore"})`;
export const GROUP_COLOR: Record<string, string> = { target: "var(--g-target)", control: "var(--g-control)" };
export const groupColor = (g: string) => GROUP_COLOR[g] ?? "var(--ink-2)";

export interface Dist {
  n: number;
  counts: Record<string, number>;
  shares: Record<string, number>;
}

/** Largeur réelle du conteneur : les graphiques SVG se dessinent en pixels, sans mise à l'échelle du texte. */
export function useWidth(fallback: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(Math.max(260, Math.round(el.getBoundingClientRect().width)));
    const ro = new ResizeObserver(([e]) => e && setW(Math.max(260, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

// ─── Comportements : barres empilées à 100 % ──────────────────────────────────

export function BehaviorLegend({ behaviors }: { behaviors: Array<{ id: string; label: string }> }) {
  const t = useDict(chartsDict);
  return (
    <div className="legend" aria-label={t.charts.behaviorLegend}>
      {behaviors.map((b) => (
        <span key={b.id}>
          <i style={{ background: behaviorColor(b.id) }} />
          {b.label}
        </span>
      ))}
    </div>
  );
}

export function BehaviorStack({ rows, behaviors }: { rows: Array<{ key: string; label: ReactNode; sub?: ReactNode; dist: Dist }>; behaviors: Array<{ id: string; label: string }> }) {
  const t = useDict(chartsDict);
  const tt = useTooltip();
  return (
    <div>
      <BehaviorLegend behaviors={behaviors} />
      {rows.map((r) => {
        const parts = behaviors.filter((b) => (r.dist.counts[b.id] ?? 0) > 0);
        return (
          <div className="stackrow" key={r.key}>
            <div className="lbl">
              {r.label}
              {r.sub && <small>{r.sub}</small>}
            </div>
            <div className="stackbar" role="group" aria-label={typeof r.label === "string" ? r.label : r.key}>
              {parts.map((b) => {
                const share = r.dist.shares[b.id] ?? 0;
                const content = (
                  <>
                    <div className="tt-row">
                      <i className="tt-key" style={{ background: behaviorColor(b.id), height: 10, width: 10, borderRadius: 2 }} />
                      {b.label}
                    </div>
                    <div>
                      <b>{pct(share)}</b> {t.units.ofTotal(r.dist.counts[b.id] ?? 0, r.dist.n)}
                    </div>
                  </>
                );
                return (
                  <div
                    key={b.id}
                    tabIndex={0}
                    role="img"
                    aria-label={`${b.label}${t.units.colon}${pct(share)} ${t.units.ofTotal(r.dist.counts[b.id] ?? 0, r.dist.n)}`}
                    style={{ flex: `${share} 0 0`, background: behaviorColor(b.id) }}
                    onMouseMove={(e) => tt.show(e, content)}
                    onMouseLeave={tt.hide}
                    onFocus={(e) => tt.showAt(e.currentTarget, content)}
                    onBlur={tt.hide}
                  >
                    {share >= 0.07 && <span style={{ color: behaviorText(b.id) }}>{pct(share)}</span>}
                  </div>
                );
              })}
            </div>
            <div className="num small muted" style={{ textAlign: "right" }}>
              n = {r.dist.n}
            </div>
          </div>
        );
      })}
      {tt.node}
    </div>
  );
}

// ─── Barres horizontales groupées (entonnoir, objections) ─────────────────────

export interface HSeries {
  key: string;
  label: string;
  color: string;
}

export function HBars({
  series,
  items,
  max = 1,
  format = (v: number) => pct(v),
  onItemContent,
}: {
  series: HSeries[];
  items: Array<{ key: string; label: ReactNode; values: Array<number | null>; extra?: ReactNode }>;
  max?: number;
  format?: (v: number) => string;
  onItemContent?: (itemKey: string, seriesKey: string) => ReactNode;
}) {
  const t = useDict(chartsDict);
  const tt = useTooltip();
  const top = Math.max(max, ...items.flatMap((i) => i.values.map((v) => v ?? 0)), 1e-9);
  return (
    <div>
      {series.length > 1 && (
        <div className="legend">
          {series.map((s) => (
            <span key={s.key}>
              <i style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
      <div className="hbars">
        {items.map((it, idx) => (
          <div key={it.key} style={{ display: "contents" }}>
            {idx > 0 && <div className="sep" />}
            <div className="lbl">{it.label}</div>
            <div className="bars">
              {series.map((s, si) => {
                const v = it.values[si];
                if (v === null || v === undefined) return <div className="hbar small muted" key={s.key}>—</div>;
                const content = (
                  <>
                    <div className="tt-row">
                      <i className="tt-key" style={{ background: s.color, height: 10, width: 10, borderRadius: 2 }} />
                      {s.label}
                    </div>
                    <div>
                      <b>{format(v)}</b>
                    </div>
                    {onItemContent?.(it.key, s.key)}
                  </>
                );
                return (
                  <div
                    className="hbar"
                    key={s.key}
                    tabIndex={0}
                    role="img"
                    aria-label={`${s.label}${t.units.colon}${format(v)}`}
                    onMouseMove={(e) => tt.show(e, content)}
                    onMouseLeave={tt.hide}
                    onFocus={(e) => tt.showAt(e.currentTarget, content)}
                    onBlur={tt.hide}
                  >
                    <i style={{ width: `${(v / top) * 88}%`, background: s.color }} />
                    <b>{format(v)}</b>
                  </div>
                );
              })}
              {it.extra}
            </div>
          </div>
        ))}
      </div>
      {tt.node}
    </div>
  );
}

// ─── Heatmap segment × catégorie ──────────────────────────────────────────────

/** Classes de la heatmap : 0, puis 7 classes (< 5 %, 5-10, 10-20, 20-35, 35-50, 50-70, ≥ 70 %). */
const BIN_EDGES = [0.05, 0.1, 0.2, 0.35, 0.5, 0.7];
export const binOf = (v: number) => (v <= 0 ? 0 : 1 + BIN_EDGES.filter((e) => v >= e).length);

export interface HeatRow {
  code: string;
  label: string;
  n: number;
  small: boolean;
  value: Dist;
}

export function Heatmap({
  blocks,
  columns,
  onCell,
}: {
  blocks: Array<{ dim: string; label: string; rows: HeatRow[] }>;
  columns: Array<{ id: string; label: string; short?: string }>;
  onCell?: (dim: string, code: string, col: string) => void;
}) {
  const t = useDict(chartsDict);
  const tt = useTooltip();
  return (
    <div className="table-wrap">
      <div className="heat-scale" aria-hidden="true" style={{ marginBottom: 8 }}>
        {t.units.percent("0")}
        {[0, 1, 2, 3, 4, 5, 6, 7].map((b) => (
          <i key={b} className={`hb${b}`} />
        ))}
        {t.charts.heatScaleEnd}
      </div>
      <table className="heat">
        <thead>
          <tr>
            <th className="rowh" />
            <th className="r" style={{ textAlign: "right" }}>n</th>
            {columns.map((c) => (
              <th key={c.id} scope="col" title={c.label}>
                {c.short ?? c.label}
              </th>
            ))}
          </tr>
        </thead>
        {blocks.map((b) => (
          <tbody key={b.dim}>
            <tr>
              <th className="dimh" colSpan={columns.length + 2} scope="colgroup">
                {b.label}
              </th>
            </tr>
            {b.rows.map((r) => (
              <tr key={r.code} className={r.small ? "small" : undefined}>
                <th className="rowh" scope="row">
                  {r.label}
                </th>
                <td className="n">{r.n}</td>
                {columns.map((c) => {
                  const v = r.value.shares[c.id] ?? 0;
                  const k = r.value.counts[c.id] ?? 0;
                  const content = (
                    <>
                      <div>
                        {b.label}
                        {t.units.colon}
                        {r.label}
                      </div>
                      <div>
                        {c.label}
                        {t.units.colon}
                        <b>{pct(v)}</b> {t.units.ofTotal(k, r.n)}
                      </div>
                      {r.small && <div className="muted">{t.charts.heatSmall}</div>}
                    </>
                  );
                  const active = Boolean(onCell) && k > 0;
                  const open = () => active && onCell?.(b.dim, r.code, c.id);
                  return (
                    <td
                      key={c.id}
                      className={`hb${binOf(v)}${v === 0 ? " zero" : ""}`}
                      {...(active
                        ? {
                            tabIndex: 0,
                            role: "button",
                            "aria-label": `${b.label}${t.units.colon}${r.label}, ${c.label}${t.units.colon}${pct(v)} ${t.units.ofTotal(k, r.n)}`,
                            onFocus: (e: FocusEvent<HTMLElement>) => tt.showAt(e.currentTarget, content),
                            onBlur: tt.hide,
                            onKeyDown: (e: KeyboardEvent) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                open();
                              }
                            },
                          }
                        : {})}
                      style={active ? { cursor: "pointer" } : undefined}
                      onClick={open}
                      onMouseMove={(e) => tt.show(e, content)}
                      onMouseLeave={tt.hide}
                    >
                      {v === 0 ? "·" : Math.round(v * 100)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        ))}
      </table>
      {tt.node}
    </div>
  );
}

// ─── Van Westendorp ───────────────────────────────────────────────────────────

export interface VwPoint {
  price: number;
  tooCheap: number;
  cheap: number;
  expensive: number;
  tooExpensive: number;
}

const VW_KEYS: Array<{ key: keyof Omit<VwPoint, "price">; color: string }> = [
  { key: "tooCheap", color: "var(--vw-1)" },
  { key: "tooExpensive", color: "var(--vw-2)" },
  { key: "cheap", color: "var(--vw-3)" },
  { key: "expensive", color: "var(--vw-4)" },
];

export function VanWestendorpChart({
  curve,
  points,
  unit,
  priceShown,
  currency = "EUR",
}: {
  curve: VwPoint[];
  points: { pmc: number | null; opp: number | null; ipp: number | null; pme: number | null };
  unit: string;
  priceShown: number | null;
  /** Devise des prix (EUR par défaut). */
  currency?: string;
}) {
  const t = useDict(chartsDict);
  const VW_SERIES = VW_KEYS.map((s) => ({ ...s, label: t.charts.vw[s.key] }));
  const fmt = (v: number | null | undefined) => money(v, currency);
  const ref = useRef<SVGSVGElement>(null);
  const [box, W] = useWidth(720);
  const [hover, setHover] = useState<number | null>(null);
  const H = 340;
  const m = { l: 44, r: 112, t: 46, b: 40 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const prices = curve.map((p) => p.price);
  const lo = Math.max(Math.min(...prices), 0.5);
  const hi = Math.max(...prices, priceShown ?? 0);
  // Échelle logarithmique : les seuils se concentrent dans les petits prix
  const lx = (v: number) => Math.log(Math.max(v, lo));
  const x = (v: number) => m.l + ((lx(v) - lx(lo)) / (lx(hi) - lx(lo) || 1)) * pw;
  const y = (s: number) => m.t + (1 - s) * ph;
  const ticks = useMemo(() => {
    const cands = [0.5, 1, 2, 3, 5, 10, 15, 20, 30, 50, 100, 200, 500, 1000];
    return cands.filter((t) => t >= lo && t <= hi);
  }, [lo, hi]);
  const marks: Array<[string, number, string]> = [];
  for (const [label, v, desc] of [
    ["PMC", points.pmc, t.charts.vw.pmc],
    ["OPP", points.opp, t.charts.vw.opp],
    ["IPP", points.ipp, t.charts.vw.ipp],
    ["PME", points.pme, t.charts.vw.pme],
  ] as Array<[string, number | null, string]>) {
    if (v !== null) marks.push([label, v, desc]);
  }

  const path = (k: keyof Omit<VwPoint, "price">) => curve.map((p, i) => `${i ? "L" : "M"}${x(p.price).toFixed(1)},${y(p[k]).toFixed(1)}`).join("");

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const svg = ref.current;
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    let best = 0;
    curve.forEach((p, i) => {
      if (Math.abs(x(p.price) - px) < Math.abs(x(curve[best]!.price) - px)) best = i;
    });
    setHover(best);
  };

  // Étiquettes des points : décalées en hauteur quand deux points sont proches
  const placed: Array<{ label: string; v: number; desc: string; px: number; row: number }> = [];
  for (const [label, v, desc] of marks) {
    const px = x(v);
    const row = placed.some((p) => Math.abs(p.px - px) < 70 && p.row === 0) ? 1 : 0;
    placed.push({ label, v, desc, px, row });
  }

  // Étiquettes de fin de courbe, écartées si elles se chevauchent
  const ends = VW_SERIES.map((s) => ({ ...s, yv: y(curve.at(-1)?.[s.key] ?? 0) })).sort((a, b) => a.yv - b.yv);
  for (let i = 1; i < ends.length; i++) if (ends[i]!.yv - ends[i - 1]!.yv < 14) ends[i]!.yv = ends[i - 1]!.yv + 14;

  const hp = hover !== null ? curve[hover] : null;

  return (
    <div ref={box}>
      <div className="legend">
        {VW_SERIES.map((s) => (
          <span key={s.key}>
            <i className="line" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
        <span>
          <i style={{ background: "var(--band)", border: "1px solid var(--axis)" }} />
          {t.charts.vw.range}
        </span>
      </div>
      <svg
        ref={ref}
        className="chart"
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Van Westendorp${t.units.colon}${marks.map(([l, v]) => `${l} ${fmt(v)}`).join(", ")}`}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {points.pmc !== null && points.pme !== null && (
          <rect x={x(points.pmc)} y={m.t} width={Math.max(0, x(points.pme) - x(points.pmc))} height={ph} fill="var(--band)" />
        )}
        {[0, 0.25, 0.5, 0.75, 1].map((s) => (
          <g key={s}>
            <line x1={m.l} x2={m.l + pw} y1={y(s)} y2={y(s)} stroke={s === 0 ? "var(--axis)" : "var(--hairline)"} />
            <text x={m.l - 8} y={y(s) + 4} textAnchor="end" className="axis-label num">
              {t.units.percent(String(Math.round(s * 100)))}
            </text>
          </g>
        ))}
        {ticks.map((t) => (
          <text key={t} x={x(t)} y={m.t + ph + 18} textAnchor="middle" className="axis-label num">
            {fmt(t)}
          </text>
        ))}
        <text x={m.l + pw} y={m.t + ph + 34} textAnchor="end" className="axis-label">
          {t.charts.vw.axis(unit)}
        </text>
        {priceShown !== null && priceShown >= lo && priceShown <= hi && (
          <g>
            <line x1={x(priceShown)} x2={x(priceShown)} y1={m.t} y2={m.t + ph} stroke="var(--ink)" strokeWidth={1} />
            <text x={x(priceShown) + 4} y={m.t + ph - 6} className="val" style={{ fontSize: 11 }}>
              {t.charts.vw.shown(fmt(priceShown))}
            </text>
          </g>
        )}
        {placed.map((p) => (
          <g key={p.label}>
            <line x1={p.px} x2={p.px} y1={m.t - 4 - p.row * 18} y2={m.t + ph} stroke="var(--muted)" strokeWidth={1} opacity={0.6} />
            <text x={p.px} y={m.t - 8 - p.row * 18} textAnchor="middle" className="val" style={{ fontSize: 12 }}>
              {p.label} {fmt(p.v)}
            </text>
          </g>
        ))}
        {VW_SERIES.map((s) => (
          <path key={s.key} d={path(s.key)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        ))}
        {ends.map((s) => (
          <text key={s.key} x={m.l + pw + 8} y={s.yv + 4} style={{ fontSize: 12 }}>
            {s.label}
          </text>
        ))}
        {hp && (
          <g>
            <line x1={x(hp.price)} x2={x(hp.price)} y1={m.t} y2={m.t + ph} stroke="var(--ink-2)" strokeWidth={1} />
            {VW_SERIES.map((s) => (
              <circle key={s.key} cx={x(hp.price)} cy={y(hp[s.key])} r={4} fill={s.color} stroke="var(--panel)" strokeWidth={2} />
            ))}
          </g>
        )}
        <rect x={m.l} y={m.t} width={pw} height={ph} fill="transparent" />
      </svg>
      {hp && (
        <div className="small" aria-live="polite" style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 4 }}>
          <b className="num">{fmt(hp.price)}</b>
          {VW_SERIES.map((s) => (
            <span key={s.key} className="row" style={{ gap: 6 }}>
              <i style={{ width: 12, height: 2, background: s.color, display: "inline-block" }} />
              {s.label} <b className="num">{pct(hp[s.key])}</b>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Colonnes groupées (Gabor-Granger) ────────────────────────────────────────

export function Columns({
  categories,
  series,
  format,
  highlight,
  height = 200,
  title,
}: {
  categories: Array<{ key: string; label: string }>;
  series: Array<{ key: string; label: string; color: string; values: Array<number | null> }>;
  format: (v: number) => string;
  highlight?: string;
  height?: number;
  title: string;
}) {
  const t = useDict(chartsDict);
  const tt = useTooltip();
  const [box, W] = useWidth(360);
  const m = { l: 8, r: 8, t: 22, b: 40 };
  const ph = height - m.t - m.b;
  const pw = W - m.l - m.r;
  const max = Math.max(1e-9, ...series.flatMap((s) => s.values.map((v) => v ?? 0)));
  const band = pw / categories.length;
  const bw = Math.min(24, (band * 0.6) / series.length);
  const y = (v: number) => m.t + ph - (v / max) * ph;
  return (
    <div ref={box}>
      <svg className="chart" width={W} height={height} viewBox={`0 0 ${W} ${height}`} role="group" aria-label={title}>
        <line x1={m.l} x2={m.l + pw} y1={m.t + ph} y2={m.t + ph} stroke="var(--axis)" />
        {categories.map((c, ci) => {
          const cx = m.l + band * ci + band / 2;
          const groupW = bw * series.length + 2 * (series.length - 1);
          return (
            <g key={c.key}>
              {series.map((s, si) => {
                const v = s.values[ci];
                if (v === null || v === undefined) return null;
                const bx = cx - groupW / 2 + si * (bw + 2);
                const by = y(v);
                const h = m.t + ph - by;
                const r = Math.min(4, h);
                const d = h <= 0 ? "" : `M${bx},${m.t + ph} V${by + r} Q${bx},${by} ${bx + r},${by} H${bx + bw - r} Q${bx + bw},${by} ${bx + bw},${by + r} V${m.t + ph} Z`;
                const content = (
                  <>
                    <div className="tt-row">
                      <i className="tt-key" style={{ background: s.color, height: 10, width: 10, borderRadius: 2 }} />
                      {s.label}, {c.label}
                    </div>
                    <b>{format(v)}</b>
                  </>
                );
                return (
                  <g
                    key={s.key}
                    tabIndex={0}
                    role="img"
                    aria-label={`${s.label}, ${c.label}${t.units.colon}${format(v)}`}
                    onMouseMove={(e) => tt.show(e, content)}
                    onMouseLeave={tt.hide}
                    onFocus={(e) => tt.showAt(e.currentTarget, content)}
                    onBlur={tt.hide}
                  >
                    <rect x={bx - 3} y={m.t} width={bw + 6} height={ph} fill="transparent" />
                    {d && <path d={d} fill={s.color} />}
                    <text x={bx + bw / 2} y={by - 6} textAnchor="middle" className="val" style={{ fontSize: 11 }}>
                      {format(v)}
                    </text>
                  </g>
                );
              })}
              <text x={cx} y={m.t + ph + 18} textAnchor="middle" className="num" style={{ fontWeight: c.key === highlight ? 700 : 400, fill: c.key === highlight ? "var(--ink)" : undefined }}>
                {c.label}
              </text>
              {c.key === highlight && (
                <text x={cx} y={m.t + ph + 33} textAnchor="middle" className="axis-label" style={{ fontSize: 11 }}>
                  {t.charts.priceShown}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {tt.node}
    </div>
  );
}
