import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { api, ApiError, useApi, type DraftStatus, type ModulePreview, type ModuleResponse, type ModuleView, type ValidationIssue } from "../api";
import { dateFr, ErrorBox, Loading, num, pct } from "../ui";
import { tr, useDict } from "../i18n";
import { modulesDict } from "../i18n/modules";
import { AssistantBanner, draftStatusLabel, ModuleStatus, useAssistantFeature } from "./Modules";
import { FEATURES, usePlatform } from "../platform";
import { HubAccountPanel } from "./ModulesHub";

type Attr = ModuleView["attributes"][number];

/** Texte lisible d'une note, d'une étape d'historique ou d'un avancement, quel que soit son format. */
export function textOf(x: unknown): string {
  if (x === null || x === undefined) return "";
  if (typeof x === "string" || typeof x === "number" || typeof x === "boolean") return String(x);
  if (Array.isArray(x)) return x.map(textOf).filter(Boolean).join(" ; ");
  const o = x as Record<string, unknown>;
  for (const k of ["message", "text", "note", "summary", "instruction", "label", "step", "detail"]) if (typeof o[k] === "string" && o[k]) return o[k] as string;
  return Object.entries(o)
    .filter(([, v]) => typeof v === "string" || typeof v === "number")
    .map(([k, v]) => `${k}${tr(modulesDict).colon}${String(v)}`)
    .join(", ");
}

/** Avancement d'une proposition : nombre (0-1 ou %), texte, ou objet { step, total, message }. */
function progressOf(p: unknown): { share: number | null; text: string } {
  if (typeof p === "number") return { share: p > 1 ? p / 100 : p, text: "" };
  if (typeof p === "string") return { share: null, text: p };
  if (p && typeof p === "object") {
    const o = p as Record<string, unknown>;
    const done = Number(o.done ?? o.current ?? o.step);
    const total = Number(o.total ?? o.steps);
    const share = typeof o.share === "number" ? o.share : typeof o.percent === "number" ? o.percent / 100 : Number.isFinite(done) && Number.isFinite(total) && total > 0 ? done / total : null;
    const text = [typeof o.phase === "string" ? o.phase : "", typeof o.message === "string" ? o.message : typeof o.label === "string" ? o.label : ""].filter(Boolean).join(tr(modulesDict).colon);
    return { share, text: text || (Number.isFinite(done) && Number.isFinite(total) ? tr(modulesDict).page.stepOf(done, total) : textOf(o)) };
  }
  return { share: null, text: "" };
}

const issueText = (e: ValidationIssue | string) => (typeof e === "string" ? e : `${e.path ? `${e.path}${tr(modulesDict).colon}` : ""}${e.message}`);

function useElapsed(since: string | undefined, active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  if (!since) return "";
  const s = Math.max(0, Math.round((now - new Date(since).getTime()) / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
}

export function ModulePage({ id, draft = false }: { id: string; draft?: boolean }) {
  const t = useDict(modulesDict);
  const mod = useApi<ModuleResponse>(`/modules/${encodeURIComponent(id)}`);
  const status = useApi<DraftStatus>(draft ? `/modules/drafts/${encodeURIComponent(id)}/status` : null);
  const meta = status.data?.meta ?? mod.data?.module.meta ?? null;
  const working = Boolean(status.data?.job?.alive) || meta?.status === "proposing";
  const hasYaml = Boolean(mod.data?.module.yaml);
  const feature = useAssistantFeature();
  const { has } = usePlatform();
  const assistantOk = Boolean(mod.data?.assistant.available) && feature;
  const library = useApi<{ modules: Array<{ id: string; status: string }> }>(draft ? "/modules" : null);
  const preview = useApi<ModulePreview>(hasYaml && assistantOk && !working ? `/modules/${encodeURIComponent(id)}/preview?n=2000&sample=5` : null);
  const [, navigate] = useLocation();
  const wasWorking = useRef(false);
  const [yamlDirty, setYamlDirty] = useState(false);
  // Brouillon passé à « accepted » (validation aboutie) : module et bibliothèque relus
  const acceptedNow = meta?.status === "accepted";
  useEffect(() => {
    if (!acceptedNow) return;
    void mod.reload();
    void library.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acceptedNow]);

  // Suivi d'une tâche de l'assistant : état relu toutes les 3 s, module rechargé à la fin
  useEffect(() => {
    if (!draft || !working) return;
    const t = setInterval(() => void status.reload(), 3000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, working]);
  useEffect(() => {
    if (wasWorking.current && !working) {
      void mod.reload();
    }
    wasWorking.current = working;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [working]);
  // Le CLI a pu nommer le brouillon autrement : on suit le vrai identifiant
  useEffect(() => {
    if (draft && status.data && status.data.draftId !== id) navigate(`/brouillons/${status.data.draftId}`, { replace: true });
  }, [draft, status.data, id, navigate]);

  if (mod.error && !(draft && mod.error instanceof ApiError && mod.error.status === 404 && (status.data?.job || status.loading))) return <ErrorBox error={mod.error} />;
  if (!mod.data && !status.data) return <Loading />;
  const view = mod.data?.view ?? null;
  const m = mod.data?.module;
  const accepted = meta?.status === "accepted";

  return (
    <>
      <div className="crumbs">
        <Link href="/modules">Modules</Link>
        <span>/</span>
        <span>{draft ? t.page.draftCrumb(id) : id}</span>
      </div>
      <header className="module-head">
        <div>
          <div className="row small" style={{ gap: 12 }}>
            <ModuleStatus status={m?.status ?? (meta ? `draft:${meta.status}` : "draft:proposing")} />
            {view && (
              <span className="muted num">
                {view.id} v{view.version}
              </span>
            )}
          </div>
          <h1 style={{ marginTop: 8 }}>{view?.label ?? (typeof meta?.moduleId === "string" ? meta.moduleId : null) ?? id}</h1>
          {view?.description && <p className="lede" style={{ marginTop: 12 }}>{view.description}</p>}
          {draft && meta?.description && (
            <p className="small ink2" style={{ marginTop: 10, maxWidth: "72ch" }}>
              {t.page.request(meta.description)}
            </p>
          )}
        </div>
        <dl className="facts">
          {view && (
            <>
              <dt>{t.page.socles}</dt>
              <dd>{view.appliesTo.join(", ")}</dd>
              <dt>{t.page.requires}</dt>
              <dd>
                {view.requires.length
                  ? view.requires.map((r, i) => (
                      <span key={r}>
                        {i > 0 && ", "}
                        <Link href={`/modules/${r}`}>{r}</Link>
                      </span>
                    ))
                  : t.page.noModule}
              </dd>
              <dt>{t.page.attributes}</dt>
              <dd className="num">{view.attributes.length}</dd>
              <dt>{t.page.sources}</dt>
              <dd className="num">{view.sources.length}</dd>
            </>
          )}
          {meta?.projectId && (
            <>
              <dt>{t.page.project}</dt>
              <dd>
                <Link href={`/projets/${meta.projectId}`}>{meta.projectId}</Link>
              </dd>
            </>
          )}
          {meta?.socle && !view && (
            <>
              <dt>{t.page.socle}</dt>
              <dd>{meta.socle}</dd>
            </>
          )}
          {meta?.createdAt && (
            <>
              <dt>{t.page.created}</dt>
              <dd>{dateFr(meta.createdAt)}</dd>
            </>
          )}
          {meta?.updatedAt && (
            <>
              <dt>{t.page.updated}</dt>
              <dd>{dateFr(meta.updatedAt)}</dd>
            </>
          )}
        </dl>
      </header>
      {mod.data && !assistantOk && <AssistantBanner reason={mod.data.assistant.reason} />}

      {draft && <WorkPanel status={status.data} meta={meta} working={working} />}

      {draft && meta?.notes && meta.notes.length > 0 && (
        <section className="section" style={{ marginTop: 32 }}>
          <div className="section-head">
            <h2>{t.page.notesTitle}</h2>
          </div>
          <div className="panel">
            <Notes notes={meta.notes} />
          </div>
        </section>
      )}

      {m && hasYaml && m.validationErrors.length > 0 && (
        <section className="section" style={{ marginTop: 32 }}>
          <div className="section-head">
            <h2>{t.page.validationTitle}</h2>
            <p className="small ink2">{t.page.validationHint}</p>
          </div>
          <div className="alerts">
            {m.validationErrors.map((e, i) => (
              <div key={i} className="alert error">
                <span className="lvl">{t.page.error}</span>
                <span>{issueText(e)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {hasYaml && <PreviewSections preview={preview.data} error={preview.error} loading={preview.loading} assistantOk={assistantOk} draft={draft} />}

      {view && <ModuleBody view={view} />}

      {!draft && m?.status === "validated" && view && has(FEATURES.hubPublish) && <PublishSection moduleId={view.id} />}

      {draft && !accepted && hasYaml && <ReviseSection id={id} disabled={working || !assistantOk} onStarted={() => void status.reload()} />}

      {m && hasYaml && (draft && !accepted ? <YamlEditor id={id} yaml={m.yaml} disabled={working} onDirty={setYamlDirty} onSaved={() => { void mod.reload(); void preview.reload(); void status.reload(); }} /> : <YamlView yaml={m.yaml} />)}

      {draft && meta?.history && meta.history.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2>{t.page.historyTitle}</h2>
          </div>
          <div className="timeline">
            {meta.history.map((h, i) => {
              const o = (h && typeof h === "object" ? h : {}) as Record<string, unknown>;
              const at = (o.at ?? o.date ?? o.createdAt) as string | undefined;
              const rawKind = (o.kind ?? o.action ?? o.type) as string | undefined;
              const kind = rawKind && (t.page.historyKinds[rawKind] ?? rawKind);
              return (
                <div key={i}>
                  <span className="muted small">{at ? dateFr(at) : t.page.step(i + 1)}</span>
                  <span>
                    {kind && <b>{kind}{t.colon}</b>}
                    {textOf(h)}
                    {typeof o.diff === "string" && o.diff.trim() && (
                      <details style={{ marginTop: 4 }}>
                        <summary className="small ink2" style={{ cursor: "pointer" }}>{t.page.changes}</summary>
                        <pre className="yaml" style={{ marginTop: 6, maxHeight: 280 }}>{o.diff}</pre>
                      </details>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {draft && m && (
        <AcceptSection
          id={id}
          label={view?.label ?? id}
          moduleId={view?.id ?? null}
          exists={Boolean(view && library.data?.modules.some((x) => x.id === view.id && x.status === "validated"))}
          meta={meta}
          working={working}
          assistantOk={assistantOk}
          errors={[...m.validationErrors.map(issueText), ...(preview.data?.alerts ?? []).filter((a) => a.level === "error").map((a) => a.message)]}
          dirty={yamlDirty}
          job={status.data?.job ?? null}
          log={status.data?.log ?? ""}
          refresh={status.reload}
        />
      )}
    </>
  );
}

function Notes({ notes }: { notes: unknown[] }) {
  const t = useDict(modulesDict);
  const [all, setAll] = useState(false);
  const shown = all ? notes : notes.slice(0, 6);
  return (
    <>
      <ul className="notes">
        {shown.map((n, i) => (
          <li key={i}>{textOf(n)}</li>
        ))}
      </ul>
      {notes.length > 6 && (
        <button className="btn ghost small" type="button" style={{ marginTop: 10 }} onClick={() => setAll(!all)}>
          {all ? t.page.collapse : t.page.showNotes(notes.length)}
        </button>
      )}
    </>
  );
}

// ─── Tâche en cours (proposition, révision, validation) ───────────────────────

function WorkPanel({ status, meta, working }: { status: DraftStatus | null; meta: DraftStatus["meta"]; working: boolean }) {
  const t = useDict(modulesDict);
  const elapsed = useElapsed(status?.job?.startedAt ?? meta?.createdAt, working);
  const prog = progressOf(meta?.progress);
  if (!working && !status?.stalled && meta?.status !== "error") return null;
  return (
    <div className="panel" style={{ marginTop: 24, maxWidth: 760 }}>
      {working ? (
        <>
          <div className="working">
            <span className="dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span>
              <b>{t.work.working}</b>
              {elapsed && <span className="muted num">{t.work.since(elapsed)}</span>}
            </span>
          </div>
          {(prog.text || prog.share !== null) && (
            <p className="small ink2" style={{ marginTop: 10 }}>
              {prog.text}
              {prog.share !== null && <span className="num"> ({pct(prog.share)})</span>}
            </p>
          )}
          {prog.share !== null && (
            <div className="progress" aria-hidden="true">
              <i style={{ width: `${Math.min(100, prog.share * 100)}%` }} />
            </div>
          )}
          <p className="small muted" style={{ marginTop: 10 }}>
            {t.work.hint}
          </p>
        </>
      ) : (
        <div className="error-box">
          {meta?.status === "error" ? t.work.failed(meta.error) : t.work.stalled}
        </div>
      )}
      {status?.log && (
        <details style={{ marginTop: 10 }} open={!working}>
          <summary className="small ink2" style={{ cursor: "pointer" }}>{t.work.log}</summary>
          <pre className="log">{status.log}</pre>
        </details>
      )}
    </div>
  );
}

// ─── Aperçu : alertes, marges simulées, fiches exemples ──────────────────────

const LEVEL_RANK: Record<string, number> = { error: 0, warn: 1, warning: 1, info: 2 };

function PreviewSections({ preview, error, loading, assistantOk, draft }: { preview: ModulePreview | null; error: Error | null; loading: boolean; assistantOk: boolean; draft: boolean }) {
  const t = useDict(modulesDict);
  if (!assistantOk) return null;
  const alerts = [...(preview?.alerts ?? [])].sort((a, b) => (LEVEL_RANK[a.level] ?? 3) - (LEVEL_RANK[b.level] ?? 3));
  return (
    <>
      <section className="section" style={{ marginTop: 32 }}>
        <div className="section-head">
          <h2>{t.preview.alertsTitle}</h2>
          <p className="small ink2">{t.preview.alertsHint(num(preview?.n ?? 2000))}</p>
        </div>
        <ErrorBox error={error} />
        {loading && !preview && <Loading what={t.preview.drawing} />}
        {preview && (alerts.length ? (
          <div className="alerts">
            {alerts.map((a, i) => (
              <div key={i} className={`alert ${a.level === "warn" ? "warning" : a.level}`}>
                <span className="lvl">{t.preview.levels[a.level] ?? a.level}</span>
                <span>
                  {a.attribute && <code className="expr">{a.attribute}</code>} {a.message}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="ink2">{t.preview.noAlert}</p>
        ))}
      </section>
      {preview && preview.margins.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2>{t.preview.marginsTitle}</h2>
            <p className="small ink2">{t.preview.marginsHint}</p>
          </div>
          <div className="panel margins">
            {preview.margins.map((mg) => (
              <div className="margin" key={mg.attribute}>
                <h4>
                  {mg.label}
                  {typeof mg.applicable === "number" && preview.n ? <span className="muted small" style={{ fontWeight: 400 }}>{t.preview.applies(pct(mg.applicable / preview.n))}</span> : null}
                </h4>
                {mg.values.map((v) => (
                  <div className={`mbar${v.label.startsWith("(") ? " na" : ""}`} key={v.code} title={`${v.label}${t.colon}${pct(v.share, 1)}`}>
                    <span className="l">{v.label}</span>
                    <span className="t" aria-hidden="true">
                      <i style={{ width: `${Math.max(0, Math.min(1, v.share)) * 100}%` }} />
                    </span>
                    <span className="num small" style={{ textAlign: "right" }}>
                      {pct(v.share, v.share < 0.1 ? 1 : 0)}
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </section>
      )}
      {preview && Array.isArray(preview.eligibilityHelpers) && preview.eligibilityHelpers.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2>{t.preview.helpersTitle}</h2>
            <p className="small ink2">{t.preview.helpersHint}</p>
          </div>
          <div className="panel">
            <dl className="facts">
              {(preview.eligibilityHelpers as Array<{ name: string; expression: string; rate: number }>).map((h) => (
                <div key={h.name} style={{ display: "contents" }}>
                  <dt>
                    <b>{h.name}</b> <span className="num">{pct(h.rate, h.rate < 0.1 ? 1 : 0)}</span>
                  </dt>
                  <dd>
                    <code className="expr">{h.expression}</code>
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </section>
      )}
      {preview && preview.sampleCards.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2>{draft ? t.preview.cardsCount(preview.sampleCards.length) : t.preview.cardsTitle}</h2>
            <p className="small ink2">{t.preview.cardsHint}</p>
          </div>
          <div className="cards">
            {preview.sampleCards.map((c) => (
              <div className="panel" key={c.personaId}>
                <div className="small muted num" style={{ marginBottom: 6 }}>
                  {c.personaId}
                </div>
                <CardContent card={c.card} />
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function CardContent({ card }: { card: unknown }): ReactNode {
  if (typeof card === "string") return <p style={{ whiteSpace: "pre-line" }}>{card}</p>;
  if (Array.isArray(card)) {
    return (
      <ul className="notes" style={{ paddingLeft: 16 }}>
        {card.map((l, i) => (
          <li key={i}>{typeof l === "object" && l && "label" in l && "value" in l ? `${String((l as { label: unknown }).label)}${tr(modulesDict).colon}${String((l as { value: unknown }).value)}` : textOf(l)}</li>
        ))}
      </ul>
    );
  }
  if (card && typeof card === "object") {
    const o = card as Record<string, unknown>;
    for (const k of ["lines", "facts", "moduleLines", "card"]) if (Array.isArray(o[k]) || typeof o[k] === "string") return <CardContent card={o[k]} />;
    return (
      <dl className="facts" style={{ fontSize: 13 }}>
        {Object.entries(o).map(([k, v]) => (
          <div key={k} style={{ display: "contents" }}>
            <dt>{k}</dt>
            <dd>{textOf(v)}</dd>
          </div>
        ))}
      </dl>
    );
  }
  return null;
}

// ─── Contenu du module ────────────────────────────────────────────────────────

function SourceRefs({ keys, view }: { keys: string[]; view: ModuleView }) {
  const t = useDict(modulesDict);
  if (!keys.length) return null;
  return (
    <span className="src-ref">
      {t.body.sourcesLabel}{" "}
      {keys.map((k, i) => {
        const s = view.sources.find((x) => x.key === k);
        return (
          <span key={k}>
            {i > 0 && ", "}
            {s ? (
              <a href={s.url} target="_blank" rel="noreferrer" title={s.title}>
                {s.org} {s.year}
              </a>
            ) : (
              <span style={{ color: "var(--danger)" }}>{t.body.unknownSource(k)}</span>
            )}{" "}
            {s && (
              <a href={`#src-${k}`} className="muted" aria-label={t.body.sourceDetail(k)}>
                ↓
              </a>
            )}
          </span>
        );
      })}
    </span>
  );
}

function Provenance({ sources, assumption, justification, view }: { sources: string[]; assumption: boolean; justification: string | null; view: ModuleView }) {
  const t = useDict(modulesDict);
  if (!sources.length && !assumption) return <div className="alert error"><span className="lvl">{t.body.noSourceLvl}</span><span>{t.body.noSourceText}</span></div>;
  return (
    <details className="more prov">
      <summary className="small ink2">
        {sources.length ? t.body.sourceCount(sources.length) : t.body.noSourceLvl}
        {assumption && <span className="tag warn" style={{ marginLeft: 6 }}>{t.body.assumptionTag}</span>}
      </summary>
    <div className="stack" style={{ gap: 6, marginTop: 6 }}>
      <SourceRefs keys={sources} view={view} />
      {assumption && (
        <div className="hyp">
          <b>{t.body.assumption}</b>
          {justification ? `${t.colon}${justification}` : t.body.noJustification}
        </div>
      )}
    </div>
    </details>
  );
}

function AttributeBlock({ a, view }: { a: Attr; view: ModuleView }) {
  const t = useDict(modulesDict);
  return (
    <div className="attr">
      <div>
        <h3>{a.label}</h3>
        <div className="key">
          {a.key}, {t.body.types[a.type] ?? a.type}
          {a.unit ? ` (${a.unit})` : ""}
        </div>
        {a.description && <p className="small ink2" style={{ marginTop: 4 }}>{a.description}</p>}
        {a.values.length > 0 && (
          <div className="chips">
            {a.values.map((v) => (
              <span className="tag" key={v.code} title={v.code}>
                {v.label}
              </span>
            ))}
          </div>
        )}
        <p className="dep" style={{ marginTop: 8 }}>
          {a.dependsOn.length ? (
            <>
              {t.body.dependsOn}
              <b>{a.dependsOn.join(", ")}</b>
            </>
          ) : (
            t.body.independent
          )}
          <span className="muted"> ({a.distribution})</span>
        </p>
        {a.when && (
          <p className="dep">
            {t.body.onlyIf}
            <b>{a.when}</b>
          </p>
        )}
        {a.tables.length > 0 && <p className="dep">{t.body.tables}{a.tables.map((tk) => view.tables.find((x) => x.key === tk)?.label ?? tk).join(", ")}</p>}
      </div>
      <Provenance sources={a.sources} assumption={a.assumption} justification={a.justification} view={view} />
    </div>
  );
}

function ModuleBody({ view }: { view: ModuleView }) {
  const t = useDict(modulesDict);
  return (
    <>
      <section className="section">
        <div className="section-head">
          <h2>{t.body.attributesTitle}</h2>
          <p className="small ink2">{t.body.attributesHint}</p>
        </div>
        {view.unsourced.length > 0 && (
          <div className="alert error" style={{ marginBottom: 12 }}>
            <span className="lvl">{t.body.unsourced}</span>
            <span>{view.unsourced.join(", ")}</span>
          </div>
        )}
        <div className="panel">
          {view.attributes.map((a) => (
            <AttributeBlock key={a.key} a={a} view={view} />
          ))}
        </div>
      </section>

      {(view.conditions.length > 0 || view.tables.length > 0) && (
        <section className="section">
          <div className="section-head">
            <h2>{t.body.condTablesTitle}</h2>
          </div>
          <div className="grid-2">
            {view.conditions.length > 0 && (
              <div className="panel">
                <h3 style={{ marginBottom: 8 }}>{t.body.conditions}</h3>
                <dl className="facts">
                  {view.conditions.map((c) => (
                    <div key={c.name} style={{ display: "contents" }}>
                      <dt>
                        <code className="expr">{c.name}</code>
                      </dt>
                      <dd>{c.text}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}
            {view.tables.length > 0 && (
              <div className="panel">
                <h3 style={{ marginBottom: 8 }}>{t.body.refTables}</h3>
                {view.tables.map((tb) => (
                  <div key={tb.key} className="answer-block">
                    <p>
                      <b>{tb.label}</b> <span className="muted small">({tb.key}, {tb.size} {tb.kind})</span>
                    </p>
                    <div style={{ marginTop: 6 }}>
                      <Provenance sources={tb.sources} assumption={tb.assumption} justification={tb.justification} view={view} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      )}

      <section className="section">
        <details className="panel more">
          <summary>
            <b>{t.body.sourcesTitle}</b> <span className="small ink2">{t.body.sourcesCount(view.sources.length)}</span>
          </summary>
        <div className="sources-list" style={{ marginTop: 10 }}>
          {view.sources.length === 0 && <p className="ink2">{t.body.noSources}</p>}
          {view.sources.map((s) => (
            <div key={s.key} id={`src-${s.key}`}>
              <p>
                <a href={s.url} target="_blank" rel="noreferrer">
                  <b>{s.org}</b>, {s.title} ({s.year})
                </a>{" "}
                <span className="muted small num">{s.key}</span>
              </p>
              {s.detail && <p className="small ink2" style={{ marginTop: 4 }}>{s.detail}</p>}
              <p className="small muted" style={{ marginTop: 4 }}>
                {s.citedBy.length ? t.body.citedBy(s.citedBy.join(", ")) : t.body.citedNowhere}
              </p>
            </div>
          ))}
        </div>
        </details>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>{t.body.cardSegTitle}</h2>
        </div>
        <div className="grid-2">
          <div className="panel">
            <h3 style={{ marginBottom: 8 }}>{t.body.cardLines}</h3>
            {view.card.length ? (
              <ul className="notes">
                {view.card.map((c, i) => (
                  <li key={i}>
                    <code className="expr">{c.template}</code>
                    {c.when && <div className="small muted" style={{ marginTop: 2 }}>{t.body.cardIf(c.when)}</div>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="ink2">{t.body.noCardLine}</p>
            )}
          </div>
          <div className="panel">
            <h3 style={{ marginBottom: 8 }}>{t.body.segments}</h3>
            {view.segments.length ? (
              <dl className="facts">
                {view.segments.map((s) => (
                  <div key={s.id} style={{ display: "contents" }}>
                    <dt>{s.label}</dt>
                    <dd>
                      {s.attributeLabel} <span className="muted small num">({s.id})</span>
                    </dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="ink2">{t.body.noSegment}</p>
            )}
          </div>
        </div>
      </section>
    </>
  );
}

// ─── YAML ─────────────────────────────────────────────────────────────────────

function YamlView({ yaml }: { yaml: string }) {
  const t = useDict(modulesDict);
  return (
    <section className="section">
      <details>
        <summary style={{ cursor: "pointer" }}>
          <h2 style={{ display: "inline" }}>YAML</h2> <span className="small ink2">{t.yaml.readOnly}</span>
        </summary>
        <pre className="yaml" style={{ marginTop: 12 }}>
          {yaml}
        </pre>
      </details>
    </section>
  );
}

function YamlEditor({ id, yaml, disabled, onSaved, onDirty }: { id: string; yaml: string; disabled: boolean; onSaved: () => void; onDirty: (d: boolean) => void }) {
  const t = useDict(modulesDict);
  const [text, setText] = useState(yaml);
  const [errors, setErrors] = useState<ValidationIssue[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setText(yaml), [yaml]);
  const dirty = text !== yaml;
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  // Validation à la volée, une demi-seconde après la dernière frappe
  useEffect(() => {
    if (!dirty) {
      setErrors(null);
      return;
    }
    setChecking(true);
    const timer = setTimeout(async () => {
      try {
        const r = await api<{ ok: boolean; errors: ValidationIssue[] }>("/modules/validate", { json: { yaml: text } });
        setErrors(r.errors);
      } catch (e) {
        setErrors([{ path: "", message: (e as Error).message }]);
      } finally {
        setChecking(false);
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [text, dirty]);

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await api(`/modules/drafts/${encodeURIComponent(id)}/yaml`, { method: "PUT", json: { yaml: text } });
      setMsg({ ok: true, text: t.yaml.saved });
      onSaved();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="section">
      <div className="section-head">
        <h2>{t.yaml.draftTitle}</h2>
        <p className="small ink2">{t.yaml.hint}</p>
      </div>
      <div className="panel stack">
        <textarea className="yaml-edit" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} disabled={disabled} aria-label={t.yaml.aria} />
        <div className="row">
          <button className="btn" type="button" disabled={!dirty || busy || disabled || checking || (errors?.length ?? 0) > 0} onClick={save}>
            {busy ? t.yaml.saving : t.yaml.save}
          </button>
          {dirty && (
            <button className="btn ghost" type="button" onClick={() => setText(yaml)} disabled={busy}>
              {t.yaml.revert}
            </button>
          )}
          <span className="small ink2" aria-live="polite">
            {!dirty ? t.yaml.unchanged : checking ? t.yaml.checking : errors && errors.length === 0 ? t.yaml.valid : errors ? t.yaml.errors(errors.length) : ""}
          </span>
          {msg && <span className="small" style={{ color: msg.ok ? "var(--ok)" : "var(--danger)" }}>{msg.text}</span>}
        </div>
        {errors && errors.length > 0 && (
          <div className="alerts">
            {errors.map((e, i) => (
              <div key={i} className="alert error">
                <span className="lvl">{t.page.error}</span>
                <span>{issueText(e)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

// ─── Révision et validation ───────────────────────────────────────────────────

function ReviseSection({ id, disabled, onStarted }: { id: string; disabled: boolean; onStarted: () => void }) {
  const t = useDict(modulesDict);
  const [instruction, setInstruction] = useState("");
  const [research, setResearch] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await api(`/modules/drafts/${encodeURIComponent(id)}/revise`, { json: { instruction, research } });
      setInstruction("");
      onStarted();
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="section">
      <div className="section-head">
        <h2>{t.revise.title}</h2>
      </div>
      <form className="panel stack" onSubmit={submit}>
        <label className="field">
          <span>{t.revise.what}</span>
          <textarea rows={3} value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder={t.revise.placeholder} disabled={disabled} />
        </label>
        <label className="small">
          <input type="checkbox" checked={research} onChange={(e) => setResearch(e.target.checked)} disabled={disabled} />
          {t.revise.research}
        </label>
        {err && <div className="error-box">{err}</div>}
        <div className="row">
          <button className="btn" type="submit" disabled={disabled || busy || instruction.trim().length < 5}>
            {busy ? t.revise.sending : t.revise.submit}
          </button>
          {disabled && <span className="small muted">{t.revise.disabled}</span>}
        </div>
      </form>
    </section>
  );
}

const isAcceptJob = (job: DraftStatus["job"]) => Boolean(job?.command?.some((a) => a.includes("module-accept")));

/**
 * Validation d'un brouillon. Étapes : confirmation, envoi, « validation en cours » (suivi du processus
 * `module:accept` toutes les 1,5 s), puis « Module validé ». Un refus du serveur, ou un processus terminé sans
 * que le brouillon soit validé, laisse un message persistant avec sa raison.
 */
function AcceptSection({
  id,
  label,
  moduleId,
  exists,
  dirty,
  meta,
  working,
  assistantOk,
  errors,
  job,
  log,
  refresh,
}: {
  id: string;
  label: string;
  moduleId: string | null;
  exists: boolean;
  dirty: boolean;
  meta: DraftStatus["meta"];
  working: boolean;
  assistantOk: boolean;
  errors: string[];
  job: DraftStatus["job"];
  log: string;
  refresh: () => Promise<void>;
}) {
  const t = useDict(modulesDict);
  const [phase, setPhase] = useState<"idle" | "confirming" | "sending" | "running">("idle");
  const [err, setErr] = useState<{ text: string; list?: string[]; log?: string } | null>(null);
  const [replace, setReplace] = useState(false);
  /** Date de lancement de NOTRE tâche : un `run.json` plus ancien (tâche précédente) ne doit pas conclure. */
  const [launchedAt, setLaunchedAt] = useState<string | null>(null);
  const acceptRunning = phase === "sending" || phase === "running" || (Boolean(job?.alive) && isAcceptJob(job));

  // Suivi du processus de validation : on relit l'état jusqu'à la fin, puis on conclut
  useEffect(() => {
    if (phase !== "running") return;
    const timer = setInterval(() => void refresh(), 1500);
    return () => clearInterval(timer);
  }, [phase, refresh]);
  useEffect(() => {
    if (phase !== "running" || !job || job.alive || !isAcceptJob(job) || job.startedAt !== launchedAt) return;
    if (meta?.status === "accepted") {
      setPhase("idle");
      return;
    }
    // Processus terminé sans validation : on affiche la fin du journal
    setPhase("idle");
    setErr({ text: t.accept.failed, log: log.split("\n").filter(Boolean).slice(-8).join("\n") });
  }, [phase, job, meta?.status, log, launchedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  if (meta?.status === "accepted") {
    return (
      <section className="section">
        <div className="panel">
          <p>
            <b>{t.accept.validated}</b> {moduleId && <Link href={`/modules/${moduleId}`}>{t.accept.seeInLibrary}</Link>}
          </p>
        </div>
      </section>
    );
  }
  // Raisons réelles d'impossibilité ; la tâche de validation elle-même n'en est pas une
  const reasons = [
    ...(!assistantOk ? [t.accept.reasonNoAssistant] : []),
    ...(working && !acceptRunning ? [t.accept.reasonWorking] : []),
    ...(meta && meta.status !== "ready" && meta.status !== "proposing" ? [t.accept.reasonDraft(draftStatusLabel(meta.status)?.toLowerCase() ?? meta.status)] : []),
    ...(errors.length ? [t.accept.reasonErrors(errors.length)] : []),
    ...(dirty ? [t.accept.reasonDirty] : []),
    ...(exists && !replace ? [t.accept.reasonExists(moduleId)] : []),
  ];
  const accept = async () => {
    setErr(null);
    setPhase("sending");
    try {
      const r = await api<{ job: { startedAt: string } }>(`/modules/drafts/${encodeURIComponent(id)}/accept`, { json: { replace } });
      setLaunchedAt(r.job.startedAt);
      setPhase("running");
      await refresh();
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as { errors?: string[] }) : {};
      setPhase("idle");
      const msg = (e as Error).message;
      setErr({ text: t.accept.refusedPrefix.test(msg) ? msg : t.accept.refused(msg), ...(body.errors && { list: body.errors }) });
    }
  };
  return (
    <section className="section">
      <div className="section-head">
        <h2>{t.accept.title}</h2>
      </div>
      <div className="panel stack">
        <p className="ink2" style={{ maxWidth: "72ch" }}>
          {t.accept.intro(moduleId ?? "…")}
        </p>
        {exists && !acceptRunning && (
          <label className="check small">
            <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
            {t.accept.replace(moduleId)}
          </label>
        )}
        {acceptRunning ? (
          <div className="working" role="status">
            <span className="dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span>{phase === "sending" ? t.accept.launching : t.accept.running}</span>
          </div>
        ) : (
          <>
            {reasons.length > 0 && (
              <p className="small" style={{ color: "var(--danger)" }}>
                {t.accept.impossible(reasons.join(t.accept.reasonsSep))}
              </p>
            )}
            {phase !== "confirming" ? (
              <div className="row">
                <button className="btn" type="button" disabled={reasons.length > 0} onClick={() => setPhase("confirming")}>
                  {t.accept.button}
                </button>
              </div>
            ) : (
              <div className="banner-block stack" role="alertdialog" aria-label={t.accept.confirmAria}>
                <p>
                  {t.accept.confirmText(label, id, moduleId ?? "?")}
                </p>
                <div className="row">
                  <button className="btn" type="button" onClick={accept} disabled={reasons.length > 0}>
                    {t.accept.confirm}
                  </button>
                  <button className="btn ghost" type="button" onClick={() => setPhase("idle")}>
                    {t.accept.cancel}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
        {err && (
          <div className="error-box" role="alert">
            {err.text}
            {err.list && err.list.map((x, i) => <div key={i}>· {x}</div>)}
            {err.log && <pre className="log">{err.log}</pre>}
            <div style={{ marginTop: 8 }}>
              <button className="btn ghost small" type="button" onClick={() => setErr(null)}>
                {t.accept.close}
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

interface LintIssueView {
  code: string;
  path: string;
  message: string;
}

interface PublishPreview {
  moduleId: string;
  yaml: string;
  sha256: string;
  version: string | null;
  ref: string | null;
  namespace: string | null;
  tokenStored: boolean;
  validation: ValidationIssue[];
  lint: { errors: LintIssueView[]; warnings: LintIssueView[] };
  sensitive: string[];
  ok: boolean;
}

/**
 * « Publier sur le Hub » (module validé de la bibliothèque) : aperçu (lint de sécurité, référence visée, YAML exact
 * qui partira), confirmation, puis publication par l'API locale avec le jeton du trousseau. Rien d'autre que le
 * YAML n'est envoyé ; la connexion se fait dans un terminal (personas hub login).
 */
function PublishSection({ moduleId }: { moduleId: string }) {
  const t = useDict(modulesDict);
  const p = t.publish;
  const [phase, setPhase] = useState<"idle" | "loading" | "preview" | "confirming" | "sending" | "done">("idle");
  const [preview, setPreview] = useState<PublishPreview | null>(null);
  const [done, setDone] = useState<{ ref: string; version: string; status: string | null; signed: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const prepare = async () => {
    setErr(null);
    setDone(null);
    setPhase("loading");
    try {
      setPreview(await api<PublishPreview>("/hub/publish/preview", { json: { moduleId } }));
      setPhase("preview");
    } catch (e) {
      setErr((e as Error).message);
      setPhase("idle");
    }
  };
  const publish = async () => {
    if (!preview) return;
    setErr(null);
    setPhase("sending");
    try {
      const r = await api<{ published: { ref: string; version: string; status: string | null; signed: boolean } }>("/hub/publish", { json: { moduleId, sha256: preview.sha256 } });
      setDone(r.published);
      setPhase("done");
    } catch (e) {
      setErr((e as Error).message);
      setPhase("preview");
    }
  };
  const issue = (i: { path: string; message: string }) => (i.path ? `${i.path}${t.colon}${i.message}` : i.message);
  const blocked = !preview || !preview.ok || !preview.tokenStored;
  return (
    <section className="section">
      <div className="section-head">
        <h2>{p.title}</h2>
      </div>
      <div className="panel stack">
        <p className="ink2" style={{ maxWidth: "72ch" }}>{p.intro(preview?.namespace ?? null, moduleId)}</p>
        {phase === "idle" || phase === "loading" ? (
          <div className="row">
            <button className="btn ghost" type="button" disabled={phase === "loading"} onClick={prepare}>
              {phase === "loading" ? p.preparing : p.prepare}
            </button>
          </div>
        ) : null}
        {preview && phase !== "idle" && phase !== "loading" && (
          <>
            <HubAccountPanel />
            {preview.validation.length > 0 && (
              <div className="alerts">
                <p className="small" style={{ color: "var(--danger)" }}>{p.validationErrors(preview.validation.length)}</p>
                {preview.validation.map((e, i) => (
                  <div key={`v${i}`} className="alert error">
                    <span className="lvl">{t.page.error}</span>
                    <span>{issue(e)}</span>
                  </div>
                ))}
              </div>
            )}
            {preview.lint.errors.length > 0 ? (
              <div className="alerts">
                <p className="small" style={{ color: "var(--danger)" }}>{p.lintErrors(preview.lint.errors.length)}</p>
                {preview.lint.errors.map((e, i) => (
                  <div key={`e${i}`} className="alert error">
                    <span className="lvl">{e.code}</span>
                    <span>{issue(e)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="small">{p.lintOk}</p>
            )}
            {preview.lint.warnings.length > 0 && (
              <div className="alerts">
                <p className="small">{p.lintWarnings(preview.lint.warnings.length)}</p>
                {preview.lint.warnings.map((w, i) => (
                  <div key={`w${i}`} className="alert warning">
                    <span className="lvl">{w.code}</span>
                    <span>{issue(w)}</span>
                  </div>
                ))}
              </div>
            )}
            {preview.sensitive.length > 0 && <p className="small">{p.sensitive(preview.sensitive.join(", "))}</p>}
            <p className="small num">{preview.ref ? p.target(preview.ref, preview.version ?? "?", preview.sha256) : p.targetNoAccount(moduleId, preview.version ?? "?", preview.sha256)}</p>
            <details>
              <summary className="small ink2" style={{ cursor: "pointer" }}>{p.yaml}</summary>
              <pre className="yaml" style={{ marginTop: 6, maxHeight: 360 }}>{preview.yaml}</pre>
            </details>
            {!preview.tokenStored && <p className="small" style={{ color: "var(--danger)" }}>{p.needLogin}</p>}
            {phase === "preview" && (
              <div className="row">
                <button className="btn" type="button" disabled={blocked} onClick={() => setPhase("confirming")}>
                  {p.title}
                </button>
                <button className="btn ghost" type="button" onClick={prepare}>
                  {p.prepare}
                </button>
              </div>
            )}
            {(phase === "confirming" || phase === "sending") && (
              <div className="banner-block stack" role="alertdialog" aria-label={p.confirm}>
                <p>{p.confirmText(preview.ref ?? `${moduleId}@${preview.version ?? "?"}`)}</p>
                <div className="row">
                  <button className="btn" type="button" onClick={publish} disabled={phase === "sending" || blocked}>
                    {phase === "sending" ? p.sending : p.confirm}
                  </button>
                  <button className="btn ghost" type="button" disabled={phase === "sending"} onClick={() => setPhase("preview")}>
                    {p.cancel}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
        {done && (
          <div className="note-box small" role="status">
            {p.done(done.ref, done.version, t.hub.status[done.status ?? ""] ?? done.status ?? "")}
            {done.signed && <> {p.signed}</>}
          </div>
        )}
        {err && (
          <div className="error-box" role="alert">
            {err}
            <div style={{ marginTop: 8 }}>
              <button className="btn ghost small" type="button" onClick={() => setErr(null)}>
                {p.close}
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
