import { useState } from "react";
import type { ConfidenceIndex } from "../../src/studies/confidence";
import type { PaymentMeasure } from "../../src/studies/payment";
import type { NeedFrequencySummary } from "../../src/studies/summary";
import { MiniBars } from "./evidence-charts";
import { tr, useDict } from "./i18n";
import { chartsDict } from "./i18n/charts";
import { eur, pct } from "./ui";

/**
 * Protocole v3 : paiement en double mesure, indice de confiance, fréquence du besoin.
 * Règle : le paiement observé (M1) n'est jamais affiché seul. La part payante estimée (M2) est
 * montrée avec son intervalle et le statut de calibration ; M1 et le « oui » au prix bas (G) en repères.
 */

export type Confidence = ConfidenceIndex;
export type Payment = PaymentMeasure;

const pct1 = (x: number) => pct(x, x > 0 && x < 0.1 ? 1 : 0);

/** Phrase complète (texte pour tous, et pour les lecteurs d'écran). */
export function paymentLine(p: Payment, price: (n: number) => string = eur): string {
  const t = tr(chartsDict).payment.line;
  const parts = [
    p.estimated
      ? t.estimated(pct1(p.estimated.value), pct1(p.estimated.ci[0]), pct1(p.estimated.ci[1]), p.estimated.calibration.status === "calibrated" ? t.calibrated(p.estimated.calibration.version) : t.uncalibrated)
      : t.noEstimate,
    p.lowTierYes ? t.lowTier(price(p.lowTierYes.price), pct1(p.lowTierYes.share)) : null,
    t.observed(pct1(p.observed)),
  ];
  return parts.filter(Boolean).join(t.sep);
}

function CalibrationBadge({ p }: { p: Payment }) {
  const t = useDict(chartsDict).payment;
  if (!p.estimated) return null;
  const cal = p.estimated.calibration;
  return cal.status === "calibrated" ? (
    <span className="badge-cal ok" title={t.fittedOn(cal.fittedOn.join(", "))}>
      {t.calibrated(cal.version.replace(/^payment-/, ""))}
    </span>
  ) : (
    <span className="badge-cal" title={t.defaults(cal.version)}>
      {t.uncalibrated}
    </span>
  );
}

export const Indicative = ({ show }: { show: boolean }) => {
  const t = useDict(chartsDict).payment;
  return show ? (
    <span className="badge-ind" title={t.indicativeTitle}>
      {t.indicative}
    </span>
  ) : null;
};

/**
 * Barre de M2 (intervalle en bande), avec M1 et G en repères. `compact` : une ligne pour les cartes.
 */
export function PaymentMeasureView({ p, price = eur, lowConfidence, compact, title: titleProp }: { p: Payment; price?: (n: number) => string; lowConfidence?: boolean; compact?: boolean; title?: string }) {
  const t = useDict(chartsDict).payment;
  const title = titleProp ?? t.title;
  const est = p.estimated;
  const g = p.lowTierYes?.share ?? null;
  const vmax = Math.max(p.observed, g ?? 0, est?.ci[1] ?? 0, est?.value ?? 0, 0.05);
  const top = vmax > 0.5 ? 1 : Math.ceil(vmax * 10) / 10;
  const x = (v: number) => `${Math.min(100, (v / top) * 100)}%`;
  return (
    <div className={`paym${compact ? " compact" : ""}`} role="group" aria-label={t.aria(title, paymentLine(p, price))}>
      <div className="paym-head">
        <span className="paym-title">{est ? t.estimatedTitle : t.title}</span>
        {est && <b className="num paym-val">{pct1(est.value)}</b>}
        <CalibrationBadge p={p} />
        <Indicative show={Boolean(lowConfidence)} />
      </div>
      <div className="paym-track" aria-hidden="true">
        {est && <span className="band" style={{ left: x(est.ci[0]), width: `calc(${x(est.ci[1])} - ${x(est.ci[0])})` }} />}
        {est && <i className="bar" style={{ width: x(est.value) }} />}
        {g !== null && <span className="mk g" style={{ left: x(g) }} />}
        <span className="mk m1" style={{ left: x(p.observed) }} />
      </div>
      <div className="paym-axis small muted" aria-hidden="true">
        <span>0</span>
        <span>{pct(top)}</span>
      </div>
      <ul className="paym-legend small" aria-hidden="true">
        {est && (
          <li>
            <i className="lg-bar" />
            {t.legendEstimated} <b className="num">{pct1(est.value)}</b>
            <i className="lg-band" /> {t.between(pct1(est.ci[0]), pct1(est.ci[1]))}
          </li>
        )}
        {p.lowTierYes && (
          <li>
            <i className="lg-g" /> {t.yesAt(price(p.lowTierYes.price))} <b className="num">{pct1(p.lowTierYes.share)}</b>
          </li>
        )}
        <li>
          <i className="lg-m1" /> {t.paid7} <b className="num">{pct1(p.observed)}</b>
        </li>
      </ul>
      {!compact && (
        <p
          className="small muted"
          title={`${est ? t.noteEstimated : t.noteNoEstimate} ${t.noteKey}`}
        >
          {est ? t.shortEstimated : t.shortNoEstimate}
        </p>
      )}
    </div>
  );
}

// ─── Indice de confiance ──────────────────────────────────────────────────────

export function ConfidencePill({ c }: { c: Confidence }) {
  const t = useDict(chartsDict).confidence;
  return (
    <span className={`pill${c.level === "low" ? " warn" : c.level === "medium" ? " muted" : ""}`} title={t.pillTitle(c.score)}>
      {t.pill(c.label)}
    </span>
  );
}

/** Détail de l'indice : effectif et bruit, calibration, pitch, réserves, et la ligne « fiable / indicatif ». */
export function ConfidenceDetail({ c, open: initial = false }: { c: Confidence; open?: boolean }) {
  const t = useDict(chartsDict).confidence;
  const [open, setOpen] = useState(initial);
  const s = c.sample;
  return (
    <div className="conf-detail">
      <p className="small">
        <b>{t.reliable}</b> {c.reliable.join(", ")}. <b>{t.indicative}</b> {c.indicative.join(", ")}.
      </p>
      {s.warning && <p className="small conf-warn">{s.warning}</p>}
      <button className="linklike small" type="button" aria-expanded={open} onClick={(e) => (e.preventDefault(), setOpen(!open))}>
        {open ? t.hide : t.show(c.score)}
      </button>
      {open && (
        <ul className="conf-list small">
          <li className={s.ok ? "ok" : "ko"}>
            {t.sample(s.n, s.retestNoisePts)}
            {s.repeats === null ? t.repeatsUnknown : s.repeats.length ? t.repeats(s.repeats.join(", ")) : t.noRepeats}
          </li>
          <li className={c.protocol.calibrated ? "ok" : "ko"}>
            {t.conversion} {c.protocol.calibrated ? t.calibrated(String(c.protocol.calibrationVersion)) : t.uncalibrated}
            {t.questionnaire(c.protocol.version)}
          </li>
          <li className={c.pitch.ok ? "ok" : "ko"}>
            {t.pitch(String(c.pitch.score ?? "—"), c.pitch.threshold)}
            {c.pitch.measuredOn === "current_project" ? t.pitchCurrent : ""}
          </li>
          {c.caveats.map((x) => (
            <li key={x} className="note">
              {x}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── Fréquence du besoin ──────────────────────────────────────────────────────

const FREQ: Array<keyof NeedFrequencySummary["shares"] & keyof (typeof chartsDict)["fr"]["frequency"]["levels"]> = ["never", "rarely", "few_per_year", "monthly", "weekly", "daily"];

export function NeedFrequencyView({ f, lowConfidence }: { f: NeedFrequencySummary; lowConfidence?: boolean }) {
  const t = useDict(chartsDict).frequency;
  const rows = FREQ.filter((k) => k !== "daily" || (f.counts[k] ?? 0) > 0).map((k) => ({ label: t.levels[k], values: [f.shares[k] ?? 0] }));
  return (
    <div className="stack" style={{ gap: 8 }}>
      {f.diagnostic && (
        <div className="banner-block" role="note" style={{ marginTop: 0 }}>
          <b>{t.rare(pct(f.rareShare))}</b>
          <p className="small ink2" style={{ margin: "4px 0 0" }}>
            {t.rareHint}
          </p>
        </div>
      )}
      <MiniBars title={t.title} rows={rows} series={[{ key: "f", label: "", color: "var(--g-target)" }]} />
      <p className="small ink2">
        {t.monthlyOrMore} <b className="num">{pct(f.recurringShare)}</b>{t.sampleSize(f.n)} <Indicative show={Boolean(lowConfidence)} />
      </p>
    </div>
  );
}
