import type { PersonaCard as Card } from "../api";
import { useDict } from "../i18n";
import { personasDict } from "../i18n/personas";
import { int, num } from "../ui";

const ADOPTION = ["laggard", "late_majority", "early_majority", "early_adopter", "innovator"];

/** Jauge 0-1 avec ses deux extrémités nommées. */
function Gauge01({ label, value, low, high, steps }: { label: string; value: number; low: string; high: string; steps?: number }) {
  const t = useDict(personasDict).card;
  return (
    <div className="pgauge" role="meter" aria-valuemin={0} aria-valuemax={1} aria-valuenow={value} aria-label={t.gaugeAria(label, num(value, 2))}>
      <span className="pg-label">{label}</span>
      <span className="pg-track" aria-hidden="true">
        {steps ? Array.from({ length: steps }, (_, i) => <s key={i} style={{ left: `${(i / (steps - 1)) * 100}%` }} />) : null}
        <i style={{ left: `${value * 100}%` }} />
      </span>
      <span className="pg-ends small muted" aria-hidden="true">
        <span>{low}</span>
        <span>{high}</span>
      </span>
    </div>
  );
}

/** Bloc visuel : revenu et reste-à-vivre, abonnements, profil d'adoption, sensibilité au prix, scepticisme. */
function PersonaVisual({ p }: { p: Card }) {
  const subs = p.subscriptions.reduce((a, x) => a + (x.monthlyEur ?? 0), 0);
  const inc = Math.max(1, p.monthlyIncomeEur);
  const ad = p.techAdoption ? ADOPTION.indexOf(p.techAdoption) : -1;
  const d = useDict(personasDict);
  const t = d.card;
  return (
    <div className="persona-visual">
      <div className="pv-budget">
        <div className="kpis">
          <div>
            <b className="num">{d.eur(int(p.monthlyIncomeEur))}</b>
            <span>{t.income}</span>
          </div>
          <div>
            <b className="num">{d.eur(int(p.monthlyDiscretionaryBudgetEur))}</b>
            <span>{t.discretionary}</span>
          </div>
          {subs > 0 && (
            <div>
              <b className="num">{d.eur(int(subs))}</b>
              <span>{t.subscriptions}</span>
            </div>
          )}
        </div>
        <div className="pv-bar" role="img" aria-label={t.barAria(int(p.monthlyDiscretionaryBudgetEur), int(p.monthlyIncomeEur), subs ? int(subs) : null)}>
          <i className="rav" style={{ width: `${Math.min(100, (p.monthlyDiscretionaryBudgetEur / inc) * 100)}%` }}>
            {subs > 0 && <i className="subs" style={{ width: `${Math.min(100, (subs / Math.max(1, p.monthlyDiscretionaryBudgetEur)) * 100)}%` }} />}
          </i>
        </div>
        <p className="small muted" style={{ margin: 0 }}>
          {t.barNote(Math.round((p.monthlyDiscretionaryBudgetEur / inc) * 100), subs > 0)}
        </p>
      </div>
      <div className="pv-gauges">
        {ad >= 0 && <Gauge01 label={t.adoptionGauge(t.adoption[p.techAdoption!]!)} value={ad / 4} low={t.adoptionLow} high={t.adoptionHigh} steps={5} />}
        <Gauge01 label={t.priceSensitivity} value={p.priceSensitivity} low={t.low} high={t.high} />
        <Gauge01 label={t.skepticism} value={p.skepticism} low={t.trusting} high={t.wary} />
      </div>
    </div>
  );
}

/** Fiche d'une persona : la même fiche factuelle que celle envoyée au LLM (describe.ts), puis son récit. */
export function PersonaCardView({ p }: { p: Card }) {
  const d = useDict(personasDict);
  const t = d.card;
  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="persona-head">
        <h2>
          {p.firstName ?? "?"}, {d.age(p.age)}
        </h2>
        <span className="ink2">{p.occupation}</span>
      </div>
      <PersonaVisual p={p} />
      {p.narrative ? (
        <div>
          <p className="narrative">{p.narrative}</p>
          <p className="small muted" style={{ marginTop: 6 }} title={t.narrativeTitle}>
            {t.narrativeBy(p.narrativeBackend ?? "", p.narrativeModel ?? "")}
          </p>
        </div>
      ) : (
        <p className="ink2">{t.noNarrative}</p>
      )}
      <details className="more">
        <summary className="small ink2">{t.fullCard}</summary>
      <dl className="facts-list" style={{ marginTop: 8 }}>
        {p.facts.map((f, i) => (
          <div key={i} style={{ display: "contents" }}>
            <dt>{f.label}</dt>
            <dd>{f.value}</dd>
          </div>
        ))}
      </dl>
      </details>
      <p className="small muted num">
        {t.footer(p.id, p.packVersion, String(p.seed ?? "?"))}
      </p>
    </div>
  );
}
