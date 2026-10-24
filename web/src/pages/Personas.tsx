import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { useApi, useMeta, type PersonaPage } from "../api";
import { useDict } from "../i18n";
import { personasDict } from "../i18n/personas";
import { Cols, EmptyState, ErrorBox, int, Loading, packShort, PeopleIcon } from "../ui";
import { cap } from "./Study";

const SOCLE_FACETS = ["ageBand", "activityStatus", "pcs", "livingStandard", "techAdoption", "townSize"];

export function PersonasPage() {
  const meta = useMeta();
  const d = useDict(personasDict);
  const t = d.list;
  const [, navigate] = useLocation();
  const [f, setF] = useState({ pack: "", ageMin: "", ageMax: "", q: "", narrative: "" });
  const [seg, setSeg] = useState<Record<string, string>>({});
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQ(f.q), 250);
    return () => clearTimeout(timer);
  }, [f.q]);
  useEffect(() => setPage(1), [f.pack, f.ageMin, f.ageMax, q, f.narrative, seg]);

  const params = new URLSearchParams({ page: String(page), pageSize: "25" });
  if (f.pack) params.set("pack", f.pack);
  if (f.ageMin) params.set("ageMin", f.ageMin);
  if (f.ageMax) params.set("ageMax", f.ageMax);
  if (q) params.set("q", q);
  if (f.narrative) params.set("narrative", f.narrative);
  for (const [d, c] of Object.entries(seg)) if (c) params.set(`seg.${d}`, c);
  const { data, error } = useApi<PersonaPage>(`/personas?${params.toString()}`);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const dimLabel = (d: string) => meta?.dimensions.find((x) => x.id === d)?.label ?? data?.dimensionLabels[d] ?? d;
  // Facettes : dimensions des modules (ordre de la bibliothèque), puis celles du socle
  const facetOrder = [...(meta?.dimensions ?? []).filter((d) => d.module).map((d) => d.id), ...SOCLE_FACETS];
  const facets = data ? facetOrder.filter((d) => data.facets[d]?.length) : [];

  return (
    <>
      <h1>{t.title}</h1>
      <p className="lede" style={{ marginTop: 10 }}>
        {t.lede}
      </p>
      <div className="filters" style={{ marginTop: 22 }}>
        <label className="field" style={{ width: 240 }}>
          <span>{t.population}</span>
          <select value={f.pack} onChange={set("pack")}>
            <option value="">{t.allPacks}</option>
            {(meta?.packs ?? []).map((p) => (
              <option key={p.packVersion} value={p.packVersion}>
                {p.label} ({p.n})
              </option>
            ))}
          </select>
        </label>
        <label className="field" style={{ width: 90 }}>
          <span>{t.ageMin}</span>
          <input type="number" min={18} max={99} value={f.ageMin} onChange={set("ageMin")} />
        </label>
        <label className="field" style={{ width: 90 }}>
          <span>{t.ageMax}</span>
          <input type="number" min={18} max={99} value={f.ageMax} onChange={set("ageMax")} />
        </label>
        <label className="field" style={{ width: 150 }}>
          <span>{t.narrative}</span>
          <select value={f.narrative} onChange={set("narrative")}>
            <option value="">{t.anyNarrative}</option>
            <option value="with">{t.withNarrative}</option>
            <option value="without">{t.withoutNarrative}</option>
          </select>
        </label>
        <label className="field grow">
          <span>{t.search}</span>
          <input type="search" value={f.q} onChange={set("q")} placeholder={t.searchPlaceholder} />
        </label>
      </div>
      {facets.length > 0 && (
        <div className="filters">
          {facets.map((d) => (
            <label className="field" key={d}>
              <span>{dimLabel(d)}</span>
              <select value={seg[d] ?? ""} onChange={(e) => setSeg({ ...seg, [d]: e.target.value })}>
                <option value="">{t.allSegments}</option>
                {data!.facets[d]!.map((v) => (
                  <option key={v.code} value={v.code}>
                    {cap(v.label)} ({v.n})
                  </option>
                ))}
              </select>
            </label>
          ))}
          {Object.values(seg).some(Boolean) && (
            <button type="button" className="btn ghost small" onClick={() => setSeg({})}>
              {t.clearSegments}
            </button>
          )}
        </div>
      )}
      <ErrorBox error={error} />
      {!data && !error && <Loading />}
      {data && (
        <>
          <p className="small ink2" style={{ margin: "6px 0 10px" }}>
            {t.count(int(data.total))}
          </p>
          {data.total === 0 ? (
            <EmptyState
              icon={<PeopleIcon />}
              title={t.emptyTitle}
              description={t.empty}
              action={
                Object.values(seg).some(Boolean) && (
                  <button type="button" className="btn ghost small" onClick={() => setSeg({})}>
                    {t.clearSegments}
                  </button>
                )
              }
            />
          ) : (
            <>
              <div className="panel table-wrap" style={{ padding: "6px 12px" }}>
                <table className="table fixed">
                  <Cols widths={[150, null, 170, 210, 110, 64]} />
                  <thead>
                    <tr>
                      <th>{t.colPersona}</th>
                      <th>{t.colSituation}</th>
                      <th>{t.colPopulation}</th>
                      <th>{t.colProject}</th>
                      <th className="r">{t.colBudget}</th>
                      <th>{t.colNarrative}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((p) => (
                      <tr key={p.id} className="link" onClick={() => navigate(`/personas/${encodeURIComponent(p.id)}`)}>
                        <td className="nowrap">
                          <Link href={`/personas/${encodeURIComponent(p.id)}`} onClick={(e) => e.stopPropagation()}>
                            <b>{p.firstName ?? "?"}</b>
                          </Link>
                          , {d.age(p.age)}
                        </td>
                        <td className="small">{p.occupation}</td>
                        <td className="small ink2">{packShort(p.packVersion)}</td>
                        <td className="small ink2">{p.segments.projectStage ? cap(p.segments.projectStage.label) : "—"}</td>
                        <td className="r num">{d.eur(int(p.monthlyDiscretionaryBudgetEur))}</td>
                        <td className="small">{p.hasNarrative ? t.yes : <span className="muted">{t.no}</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="row" style={{ marginTop: 14 }}>
                <button className="btn ghost small" type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                  {t.prevPage}
                </button>
                <span className="small num ink2">
                  {t.pageOf(page, pages)}
                </span>
                <button className="btn ghost small" type="button" disabled={page >= pages} onClick={() => setPage(page + 1)}>
                  {t.nextPage}
                </button>
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}
