/**
 * Rapport de `personas validate` (src/cli/validate-report.ts) : sortie française identique, octet pour octet,
 * à formatReports / formatPlausibility (src/personas/validate.ts) ; sortie anglaise sans les mots français de la
 * mise en page (les titres de dimensions et libellés de modalités viennent du pack et restent tels quels).
 */
import { describe, expect, it } from "vitest";
import { en } from "../../src/cli/messages.en";
import { fr } from "../../src/cli/messages.fr";
import { formatValidationPlausibility, formatValidationReports } from "../../src/cli/validate-report";
import { resolveModules } from "../../src/modules/registry";
import { loadPack } from "../../src/personas/pack";
import { drawPersonas } from "../../src/personas/sampler";
import { computeMargins, formatPlausibility, formatReports, plausibilityChecks, type DimensionReport } from "../../src/personas/validate";

function rowsOf(packKey: string, modules: string[] | null, n: number) {
  const base = loadPack(packKey);
  const pack = modules ? { ...base, modules: resolveModules(modules, base.socle) } : base;
  const rows = drawPersonas(pack, 42, n).map((p) => ({ ...p, activityStatus: p.activityStatus ?? null, pcs: p.pcs ?? null }));
  return { pack, rows };
}

const FRENCH_LAYOUT = [/\bcible\b/, /écart/, /\[tirée\]/, /\[modélisée\]/, /Indicateur global/, /Écart absolu max/, /Seuils/, /RÉSULTAT/, /ÉCHEC/, /indicatif/, /ddl/, /Plausibilité/, /dimensions tirées/];

describe("personas validate : rapport traduit", () => {
  for (const [packKey, modules] of [["fr-2026.2", ["numerique", "entrepreneuriat"]], ["sg-2026.2", null], ["us-2026.1", null]] as const) {
    it(`${packKey} : français identique à formatReports / formatPlausibility ; anglais sans mise en page française`, () => {
      const { pack, rows } = rowsOf(packKey, modules ? [...modules] : null, 400);
      const reports = computeMargins(pack, rows);
      const plaus = plausibilityChecks(pack, rows);
      expect(formatValidationReports(reports, fr.personasValidate.report)).toBe(formatReports(reports));
      expect(formatValidationPlausibility(plaus, fr.personasValidate.report)).toBe(formatPlausibility(plaus));
      const english = [formatValidationReports(reports, en.personasValidate.report), formatValidationPlausibility(plaus, en.personasValidate.report)].join("\n");
      // Les titres de dimensions et libellés (du pack) sont retirés avant de chercher des mots français de mise en page
      const layoutOnly = english
        .split("\n")
        .map((line) => {
          let l = line;
          for (const r of reports) l = l.replaceAll(r.title, "").replace(/^.{34} /, (head) => (r.cells.some((c) => head.startsWith(c.label.slice(0, 34))) ? "" : head));
          for (const c of plaus) l = l.replace(c.label, "");
          return l;
        })
        .join("\n");
      for (const re of FRENCH_LAYOUT) expect(layoutOnly, String(re)).not.toMatch(re);
      expect(english).toMatch(/## Overall indicator/);
      expect(english).toMatch(/RESULT: (OK|FAIL)/);
    });
  }

  it("échec et dimension indicative : mêmes textes en français, traduits en anglais", () => {
    const { pack, rows } = rowsOf("fr-2026.2", null, 300);
    const reports: DimensionReport[] = computeMargins(pack, rows).map((r, i) => (i === 0 ? { ...r, pass: false } : r));
    expect(formatValidationReports(reports, fr.personasValidate.report)).toBe(formatReports(reports));
    const english = formatValidationReports(reports, en.personasValidate.report);
    expect(english).toContain(`RESULT: FAIL (${reports[0]!.title}`);
    expect(english).toMatch(/; FAIL$/m);
    if (reports.some((r) => r.kind === "info")) expect(english).toMatch(/\[info\].*\n[\s\S]*; indicative$/m);
  });
});
