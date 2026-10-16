import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parse as parseYaml } from "yaml";
import { loadConfig, loadDotEnv } from "../config";
import { openDb, runMigrations } from "../db/client";
import { libraryWithDrafts } from "../modules/assistant";
import { drawTarget, persistDrawn, prepareTarget } from "../population/target";
import { getProject, type ProjectExtra } from "../studies/project";
import { errorText, numberLocale, t } from "./i18n";

/**
 * Tire une population ciblée (socle + modules + filtre d'éligibilité), sans LLM : taux d'éligibilité,
 * intervalle, nombre de tirages, aperçu des marges. --persist met les personas en cache en base.
 */

const { values } = parseArgs({
  options: {
    target: { type: "string" },
    project: { type: "string" },
    group: { type: "string", default: "target" },
    n: { type: "string" },
    seed: { type: "string", default: "42" },
    persist: { type: "boolean", default: false },
    drafts: { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help || (!values.target && !values.project)) {
  console.log(t.populationDraw.usage);
  process.exit(values.help ? 0 : 2);
}

loadDotEnv();
const config = loadConfig();
const { sqlite, db } = openDb(config.DATABASE_PATH);
try {
  runMigrations(db);
  const read = (f: string) => {
    const t = readFileSync(f, "utf8");
    return /\.ya?ml$/i.test(f) ? parseYaml(t) : JSON.parse(t);
  };
  let spec: unknown;
  if (values.target) spec = read(values.target);
  else {
    const src = values.project!;
    const file = existsSync(src) ? (read(src) as Record<string, unknown>) : null;
    const extra = file ?? (getProject(db, src)?.extra as ProjectExtra | undefined);
    spec = (extra as Record<string, unknown> | undefined)?.[values.group!];
    if (!spec) throw new Error(t.populationDraw.noGroup(values.group!, src));
  }
  // --drafts : brouillons de modules autorisés, en lecture seule (aperçu) ; jamais avec --persist
  if (values.drafts && values.persist) throw new Error(t.populationDraw.draftsNoPersist);
  const withDrafts = values.drafts ? libraryWithDrafts() : null;
  if (withDrafts) console.log(t.populationDraw.draftsAllowed(withDrafts.drafts.join(", ")));
  const prepared = prepareTarget(spec, withDrafts ? { library: withDrafts.library } : {});
  const n = Number(values.n ?? prepared.spec.n ?? NaN);
  if (!Number.isInteger(n) || n < 1) throw new Error(t.populationDraw.nRequired);
  const t0 = performance.now();
  const d = drawTarget(prepared, n, Number(values.seed));
  const pct = (x: number) => `${(x * 100).toFixed(2)}${t.common.pct}`;
  console.log(t.populationDraw.socle(d.pack.manifest.version, prepared.modules.ordered.map((m) => `${m.def.id}@${m.def.version}`).join(", ")));
  console.log(t.common.filter(prepared.filter?.source));
  console.log(t.populationDraw.retained(d.personas.length, d.draws.toLocaleString(numberLocale), Math.round(performance.now() - t0)));
  if (prepared.filter) console.log(t.populationDraw.rate(pct(d.rate), pct(d.ci[0]), pct(d.ci[1]), d.eligible));
  for (const w of d.warnings) console.log(`⚠ ${w}`);
  for (const s of d.shortfalls) console.log(t.populationDraw.quota(s));
  const dist = (f: (p: (typeof d.personas)[number]) => unknown) => {
    const c = new Map<string, number>();
    for (const p of d.personas) c.set(String(f(p)), (c.get(String(f(p))) ?? 0) + 1);
    return [...c].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${Math.round((v / d.personas.length) * 100)}${t.common.pct}`).join(", ");
  };
  console.log(t.populationDraw.age(dist((p) => (p.age < 30 ? "<30" : p.age < 40 ? "30-39" : p.age < 50 ? "40-49" : "50+"))));
  console.log(t.populationDraw.sexRegion(dist((p) => p.sex), dist((p) => p.region)));
  console.log(t.populationDraw.pcsActivity(dist((p) => p.pcs ?? "none"), dist((p) => p.activityStatus)));
  for (const m of prepared.modules.ordered) {
    for (const s of m.def.segments) {
      const a = m.attrs.get(s.attribute)!;
      console.log(t.populationDraw.segment(s.label, dist((p) => p.extra.modules?.[m.def.id]?.[a.key] ?? "—")));
    }
  }
  if (values.persist) {
    const r = persistDrawn(db, d.personas);
    console.log(t.populationDraw.cache(r.inserted, r.updated, r.reused));
  }
} catch (err) {
  console.error(errorText(err));
  process.exitCode = 1;
} finally {
  sqlite.close();
}
