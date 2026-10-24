import { drawnTolerance, THRESHOLDS, type DimensionReport, type PlausibilityCheck } from "../personas/validate";
import type { CliMessages } from "./messages.fr";

/**
 * Rapport texte de `personas validate`, dans la langue de la CLI : même mise en page que formatReports et
 * formatPlausibility (src/personas/validate.ts), dont la sortie française est reproduite octet pour octet
 * (test/cli/validate-report.test.ts le vérifie). Les titres de dimensions et les libellés de modalités et de
 * contrôles viennent du pack ou du validateur : ils ne sont pas traduits ici.
 */

type ReportMessages = CliMessages["personasValidate"]["report"];

export function formatValidationReports(reports: DimensionReport[], m: ReportMessages): string {
  const out: string[] = [];
  const pct = (x: number) => `${(x * 100).toFixed(1).padStart(5)} %`;
  for (const r of reports) {
    out.push(`\n## ${r.title}  [${m.kind[r.kind]}]  n=${r.n}`);
    out.push(`${"".padEnd(34)} ${m.columns.observed.padStart(7)} ${m.columns.expected.padStart(7)} ${m.columns.deviation.padStart(8)}`);
    for (const c of r.cells) {
      out.push(
        `${c.label.slice(0, 34).padEnd(34)} ${pct(c.observedShare)} ${pct(c.expectedShare)} ${(c.deviationPts >= 0 ? "+" : "") + c.deviationPts.toFixed(1).padStart(5)} pt`,
      );
    }
    const p = r.pValue < 0.0001 ? r.pValue.toExponential(1) : r.pValue.toFixed(4);
    out.push(m.dimensionSummary(r.maxAbsDevPts.toFixed(1), r.chi2.toFixed(1), r.df, p, r.kind === "info" ? m.indicative : r.pass ? m.ok : m.fail));
  }
  const scored = reports.filter((r) => r.kind !== "info");
  const worst = scored.reduce((a, b) => (b.maxAbsDevPts > a.maxAbsDevPts ? b : a));
  const minP = scored.filter((r) => r.kind === "drawn").reduce((a, b) => (b.pValue < a.pValue ? b : a));
  const failed = scored.filter((r) => !r.pass);
  out.push(m.overallTitle);
  out.push(m.maxAbsDev(worst.maxAbsDevPts.toFixed(1), worst.title));
  out.push(m.minPValue(minP.pValue.toFixed(4), minP.title));
  out.push(m.thresholds(THRESHOLDS.minPValue, drawnTolerance(worst.n).toFixed(1), worst.n, THRESHOLDS.maxAbsDevModelled));
  out.push(failed.length ? m.resultFail(failed.map((f) => f.title).join(", ")) : m.resultOk);
  return out.join("\n");
}

export function formatValidationPlausibility(checks: PlausibilityCheck[], m: ReportMessages): string {
  if (!checks.length) return "";
  return [
    m.plausibilityTitle,
    ...checks.map((c) => {
      const f = (x: number) => (c.percent ? `${(x * 100).toFixed(1)} %` : String(Math.round(x)));
      return `${c.label.padEnd(60)} ${f(c.value).padStart(8)}  [${f(c.min)} ; ${f(c.max)}]  ${c.pass ? m.ok : m.fail}`;
    }),
  ].join("\n");
}
