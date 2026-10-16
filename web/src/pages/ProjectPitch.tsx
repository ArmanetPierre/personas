import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "wouter";
import { api, useApi, type FactView, type PitchProposalView, type PitchState, type ToneCategory } from "../api";
import { JobPanel, useJob } from "../jobs";
import { tr, useContentLocale, useDict } from "../i18n";
import { projectPitchDict } from "../i18n/projectP1";
import { dateFr, ErrorBox, Loading } from "../ui";
import { ProjectFrame } from "./ProjectHub";

/**
 * Ton du pitch : jauge sur la page « L'offre », et écran de revue de la version neutre proposée
 * par l'assistant (project:neutralize-pitch). L'assistant propose, l'utilisateur valide.
 */

const enc = encodeURIComponent;
const jobKeyOf = (id: string) => `pitch-${id.replace(/[^A-Za-z0-9_-]+/g, "_")}`;

/** Ordre fixe des catégories : la couleur suit la catégorie (palette catégorielle validée). */
export const TONE_ORDER: ToneCategory[] = ["superlative", "unverifiable_promise", "social_proof", "urgency", "price_judgment", "injunction", "emotional"];
const toneLabel = (c: ToneCategory): string => tr(projectPitchDict).tone[c];
const catNo = (c: ToneCategory) => TONE_ORDER.indexOf(c) + 1;

// ─── Jauge de ton ─────────────────────────────────────────────────────────────

export function ToneGauge({ score, threshold, label, compact }: { score: number; threshold: number; label?: string; compact?: boolean }) {
  const over = score >= threshold;
  const t = useDict(projectPitchDict).gauge;
  const verdict = score < 10 ? t.factual : over ? t.over : t.fairly;
  return (
    <div className={`tone-gauge${compact ? " compact" : ""}`}>
      {label && <span className="tg-label">{label}</span>}
      <div className="tg-track" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={score} aria-label={t.aria(label ?? t.defaultLabel, score, threshold, verdict)}>
        <i className={over ? "over" : ""} style={{ width: `${Math.max(1, score)}%` }} />
        <s style={{ left: `${threshold}%` }} title={t.thrTitle(threshold)} />
      </div>
      <b className="num tg-val">
        {score}
        <span className="muted">/100</span>
      </b>
      {!compact && (
        <div className="tg-scale small muted" aria-hidden="true">
          <span>{t.scale0}</span>
          <span className="tg-thr" style={{ left: `${threshold}%` }}>
            {t.thr(threshold)}
          </span>
          <span>{t.scale100}</span>
        </div>
      )}
    </div>
  );
}

// ─── Bloc « Ton du pitch » de la page L'offre ─────────────────────────────────

export function PitchTonePanel({ id }: { id: string }) {
  const st = useApi<PitchState>(`/projects/${enc(id)}/pitch`);
  const { job, started } = useJob(jobKeyOf(id), st.data?.job, () => void st.reload());
  const [err, setErr] = useState<string | null>(null);
  const t = useDict(projectPitchDict).panel;
  const run = async () => {
    setErr(null);
    try {
      started(await api<{ key: string; pid: number; startedAt: string }>(`/projects/${enc(id)}/pitch/neutralize`, { method: "POST" }));
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const d = st.data;
  return (
    <div className="panel stack" id="ton">
      <h3>{t.title}</h3>
      {st.error ? (
        <ErrorBox error={st.error} />
      ) : !d ? (
        <Loading />
      ) : (
        <>
          <ToneGauge score={d.tone.score} threshold={d.tone.threshold} />
          <p className="small ink2">
            {d.tone.warn
              ? t.warn
              : t.ok}
            {d.pitchNeutralized && t.neutralized}
          </p>
          {d.tone.hits.length > 0 && (
            <p className="small muted">
              {t.markers([...new Set(d.tone.hits.map((h) => h.text))].slice(0, 6))}
            </p>
          )}
          <div className="row">
            {d.proposal && !d.proposal.stale ? (
              <Link className="btn" href={`/projets/${enc(id)}/offre/pitch`}>
                {t.reviewNeutral}
              </Link>
            ) : (
              <button className={`btn${d.tone.warn ? "" : " ghost"}`} type="button" onClick={() => void run()} disabled={Boolean(job?.alive)}>
                {t.check}
              </button>
            )}
            {d.proposal?.stale && <span className="small muted">{t.stale}</span>}
            {!d.proposal && <span className="small muted">{t.noProposal}</span>}
          </div>
          {err && <div className="error-box">{err}</div>}
          <JobPanel job={job} label={t.jobLabel} hint={t.jobHint} />
        </>
      )}
    </div>
  );
}

// ─── Diff au mot près ─────────────────────────────────────────────────────────

interface Tok {
  t: string;
  at: number;
  space: boolean;
}
function tokens(text: string): Tok[] {
  const out: Tok[] = [];
  for (const m of text.matchAll(/\s+|[\p{L}\p{N}'’-]+|[^\s\p{L}\p{N}]/gu)) out.push({ t: m[0], at: m.index ?? 0, space: /^\s+$/.test(m[0]) });
  return out;
}
const norm = (s: string) => s.toLowerCase().replace(/’/g, "'");

/** LCS sur les mots (hors espaces) : mots supprimés de `a`, mots ajoutés dans `b`. */
export function wordDiff(a: string, b: string): { ta: Tok[]; tb: Tok[]; del: Set<number>; add: Set<number> } {
  const ta = tokens(a);
  const tb = tokens(b);
  const ia = ta.map((x, i) => (x.space ? -1 : i)).filter((i) => i >= 0);
  const ib = tb.map((x, i) => (x.space ? -1 : i)).filter((i) => i >= 0);
  const n = ia.length;
  const m = ib.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i]![j] = norm(ta[ia[i]!]!.t) === norm(tb[ib[j]!]!.t) ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
  const del = new Set<number>();
  const add = new Set<number>();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (norm(ta[ia[i]!]!.t) === norm(tb[ib[j]!]!.t)) {
      i++;
      j++;
    } else if (L[i + 1]![j]! >= L[i]![j + 1]!) del.add(ia[i++]!);
    else add.add(ib[j++]!);
  }
  while (i < n) del.add(ia[i++]!);
  while (j < m) add.add(ib[j++]!);
  return { ta, tb, del, add };
}

/** Plages de l'original couvertes par les passages repérés (recherche exacte, puis sans casse). */
function passageRanges(original: string, passages: PitchProposalView["passages"]) {
  const ranges: Array<{ from: number; to: number; i: number }> = [];
  const low = original.toLowerCase();
  passages.forEach((p, i) => {
    const needle = p.text.trim().replace(/[.,;:!?…]+$/, "");
    if (!needle) return;
    let at = original.indexOf(needle);
    if (at < 0) at = low.indexOf(needle.toLowerCase());
    if (at < 0) return;
    const to = at + needle.length;
    if (ranges.some((r) => at < r.to && to > r.from)) return;
    ranges.push({ from: at, to, i });
  });
  return ranges;
}

/** Regroupe des jetons consécutifs de même style en un seul élément. */
function runs<K extends string>(toks: Tok[], keyOf: (t: Tok, i: number) => K): Array<{ key: K; text: string; first: number; count: number }> {
  const out: Array<{ key: K; text: string; first: number; count: number }> = [];
  toks.forEach((t, i) => {
    const k = keyOf(t, i);
    const last = out[out.length - 1];
    if (last && last.key === k) {
      last.text += t.t;
      last.count++;
    } else out.push({ key: k, text: t.t, first: i, count: 1 });
  });
  return out;
}

// ─── Écran de revue ───────────────────────────────────────────────────────────

export function ProjectPitchReviewPage({ id }: { id: string }) {
  const st = useApi<PitchState>(`/projects/${enc(id)}/pitch`);
  const { job, started } = useJob(jobKeyOf(id), st.data?.job, () => void st.reload());
  const td = useDict(projectPitchDict);
  return (
    <ProjectFrame id={id} tab="offre">
      {({ data, reload }) => {
        if (st.error) return <ErrorBox error={st.error} />;
        const d = st.data;
        if (!d) return <Loading />;
        return (
          <div className="stack" style={{ gap: 16, marginTop: 20 }}>
            <ContentLocale locale={data.project.locale} />
            <p className="small">
              <Link href={`/projets/${enc(id)}/offre`}>{td.page.back}</Link>
            </p>
            {!d.proposal ? (
              <div className="panel stack">
                <p>{td.page.noPending}</p>
                <ToneGauge score={d.tone.score} threshold={d.tone.threshold} label={td.page.currentPitch} />
                <div className="row">
                  <button
                    className="btn"
                    type="button"
                    disabled={Boolean(job?.alive)}
                    onClick={async () => started(await api<{ key: string; pid: number; startedAt: string }>(`/projects/${enc(id)}/pitch/neutralize`, { method: "POST" }))}
                  >
                    {td.panel.check}
                  </button>
                </div>
                <JobPanel job={job} label={td.panel.jobLabel} hint={td.panel.jobHint} />
              </div>
            ) : (
              <Review
                id={id}
                d={d}
                onDone={() => {
                  void st.reload();
                  reload();
                }}
              />
            )}
          </div>
        );
      }}
    </ProjectFrame>
  );
}

/** Langue du contenu du projet (le cadre fournit la fiche projet par sa fonction de rendu). */
function ContentLocale({ locale }: { locale: string | undefined }) {
  useContentLocale(locale);
  return null;
}

function Review({ id, d, onDone }: { id: string; d: PitchState; onDone: () => void }) {
  const pr = d.proposal!;
  const [text, setText] = useState(pr.neutral);
  const [editing, setEditing] = useState(false);
  const [check, setCheck] = useState<{ tone: { score: number }; factView: FactView } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ kind: "applied" | "dismissed"; file?: string; backup?: string; source?: string } | null>(null);
  const edited = text.trim() !== pr.neutral.trim();
  const t = useDict(projectPitchDict).review;

  // Contrôle sans modèle de la version éditée (score lexical, faits), après une courte pause de frappe
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!edited) {
      setCheck(null);
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        setCheck(await api(`/projects/${enc(id)}/pitch/check`, { method: "POST", json: { text } }));
      } catch {
        // le contrôle est indicatif
      }
    }, 450);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [text, edited, id]);

  const diff = useMemo(() => wordDiff(pr.original, text), [pr.original, text]);
  const ranges = useMemo(() => passageRanges(pr.original, pr.passages), [pr.original, pr.passages]);
  const counts = useMemo(() => {
    const c = new Map<ToneCategory, number>();
    for (const p of pr.passages) c.set(p.category, (c.get(p.category) ?? 0) + 1);
    return c;
  }, [pr.passages]);
  const fv = check?.factView ?? pr.factView;
  const afterLexical = check?.tone.score ?? pr.lexicalScore.after;

  const apply = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ source: string; file?: string; backup: string }>(`/projects/${enc(id)}/pitch`, { method: "PUT", json: { pitch: text, confirm: true } });
      setDone({ kind: "applied", ...r });
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };
  const keep = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api(`/projects/${enc(id)}/pitch/dismiss`, { method: "POST" });
      setDone({ kind: "dismissed" });
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (done)
    return (
      <div className="panel stack">
        {done.kind === "applied" ? (
          <>
            <p>
              <b>{t.replacedB}</b>
              {t.replacedRest}
            </p>
            <p className="small ink2">
              {done.source === "file" ? t.fileUpdated(done.file) : t.dbUpdated}
              {t.backup(done.backup)}
            </p>
          </>
        ) : (
          <p>{t.dismissed}</p>
        )}
        <p>
          <Link href={`/projets/${enc(id)}/offre`}>{t.backToOffer}</Link>
        </p>
      </div>
    );

  return (
    <>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
        <div>
          <h2 style={{ margin: 0 }}>{t.title}</h2>
          <p className="small muted">
            {t.proposedOn(dateFr(pr.generatedAt), pr.model, pr.passages.length)}
          </p>
        </div>
      </div>
      {pr.stale && (
        <div className="banner-block" role="note">
          {t.stale}
        </div>
      )}
      {pr.unchanged && <div className="note-box">{t.unchanged}</div>}

      {/* Scores avant / après */}
      <div className="panel stack">
        <h3>{t.toneTitle}</h3>
        <div className="tone-pair">
          <div>
            <p className="small ink2 tp-head">{t.lexical}</p>
            <ToneGauge compact label={t.original} score={pr.lexicalScore.before} threshold={d.tone.threshold} />
            <ToneGauge compact label={edited ? t.yourVersion : t.neutral} score={afterLexical} threshold={d.tone.threshold} />
          </div>
          <div>
            <p className="small ink2 tp-head">{t.assistantScore}</p>
            <ToneGauge compact label={t.original} score={pr.toneScore.before} threshold={d.tone.threshold} />
            <ToneGauge compact label={t.neutral} score={pr.toneScore.after} threshold={d.tone.threshold} />
          </div>
        </div>
        <p className="small muted">{t.scaleNote(d.tone.threshold)}</p>
      </div>

      {/* Côte à côte */}
      <div className="pitch-sbs">
        <div className="panel stack">
          <h3>{t.yourPitch}</h3>
          <p className="pitch-text" aria-label={t.pitchAria}>
            {runs(diff.ta, (t) => {
              const r = ranges.find((x) => t.at >= x.from && t.at < x.to);
              return r ? String(r.i) : "-";
            }).map((run, k) => {
              const p = run.key !== "-" ? pr.passages[Number(run.key)] : null;
              // Mots retirés barrés ; un espace entre deux mots retirés l'est aussi
              const delAt = (i: number) => {
                const t = diff.ta[i]!;
                if (!t.space) return diff.del.has(i);
                return diff.del.has(i - 1) && diff.del.has(i + 1);
              };
              const inner = runs(diff.ta.slice(run.first, run.first + run.count), (_t, j) => (delAt(run.first + j) ? "d" : "-")).map((x, j) => (x.key === "d" ? <del key={j}>{x.text}</del> : <span key={j}>{x.text}</span>));
              return p ? (
                <mark key={k} className={`tone-mark tc-${catNo(p.category)}`} title={t.markTitle(toneLabel(p.category), p.reason, p.replacement)} tabIndex={0}>
                  {inner}
                  <sup aria-hidden="true">{catNo(p.category)}</sup>
                  <span className="sr-only">
                    {" "}
                    {t.srReason(toneLabel(p.category), p.reason)}
                  </span>
                </mark>
              ) : (
                <span key={k}>{inner}</span>
              );
            })}
          </p>
          <ul className="tone-legend small" aria-label={t.legendAria}>
            {TONE_ORDER.filter((c) => counts.has(c)).map((c) => (
              <li key={c}>
                <i className={`tc-${catNo(c)}`} />
                <sup>{catNo(c)}</sup> {toneLabel(c)} <span className="muted num">× {counts.get(c)}</span>
              </li>
            ))}
            <li>
              <del>{t.word}</del> <span className="muted">{t.removed}</span>
            </li>
          </ul>
          <p className="small muted">{t.hover}</p>
        </div>
        <div className="panel stack">
          <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
            <h3>{edited ? t.editedVersion : t.neutralVersion}</h3>
            <button className="btn ghost small" type="button" onClick={() => setEditing(!editing)}>
              {editing ? t.showDiff : t.edit}
            </button>
          </div>
          {editing ? (
            <>
              <textarea className="pitch-edit" value={text} onChange={(e) => setText(e.target.value)} rows={10} aria-label={t.editAria} />
              {edited && (
                <button className="linklike small" type="button" onClick={() => setText(pr.neutral)}>
                  {t.backToProposal}
                </button>
              )}
            </>
          ) : (
            <p className="pitch-text" aria-label={t.neutralAria}>
              {runs(diff.tb, (t, i) => ((t.space ? diff.add.has(i - 1) && diff.add.has(i + 1) : diff.add.has(i)) ? "a" : "-")).map((run, k) => (run.key === "a" ? <ins key={k}>{run.text}</ins> : <span key={k}>{run.text}</span>))}
            </p>
          )}
          <p className="small muted">
            <ins>{t.word}</ins>
            {t.addedNote}
          </p>
        </div>
      </div>

      <div className="grid-2">
        {/* Contrôle des faits */}
        <div className="panel stack">
          <h3>
            {t.factCheck} {edited && <span className="small muted">{t.onYourVersion}</span>}
          </h3>
          <p className={`small ${fv.ok ? "" : "ink2"}`}>{fv.ok ? t.factsOk : t.factsBad}</p>
          <FactGroup label={t.numbers} kept={fv.numbersKept} missing={fv.numbersMissing} added={fv.numbersAdded} />
          <FactGroup label={t.names} kept={fv.namesKept} missing={fv.namesMissing} />
          <FactGroup label={t.facts} kept={fv.factsKept} missing={fv.factsMissing} block />
          {pr.factView.repaired && <p className="small muted">{t.repaired}</p>}
        </div>
        {/* Informations absentes */}
        <div className="panel stack">
          <h3>{t.missingTitle}</h3>
          {pr.missingInfo.length ? (
            <>
              <p className="small ink2">{t.missingIntro}</p>
              <ul className="crit-list">
                {pr.missingInfo.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </>
          ) : (
            <p className="ink2">{t.nothing}</p>
          )}
        </div>
      </div>

      {/* Décision */}
      <div className="panel stack">
        {confirming ? (
          <div className="banner-block stack" role="alertdialog" aria-label={t.confirmAria} style={{ marginTop: 0 }}>
            <p>
              {t.confirmA(edited)}
              <code>pitchOriginal</code>
              {t.confirmB}
            </p>
            <div className="row">
              <button className="btn" type="button" disabled={busy} onClick={() => void apply()}>
                {busy ? t.applying : t.confirm}
              </button>
              <button className="btn ghost" type="button" onClick={() => setConfirming(false)}>
                {t.cancel}
              </button>
            </div>
          </div>
        ) : (
          <div className="row">
            <button className="btn" type="button" disabled={busy || pr.unchanged || text.trim().length < 20} onClick={() => setConfirming(true)}>
              {t.apply(edited)}
            </button>
            <button className="btn ghost" type="button" disabled={busy} onClick={() => void keep()}>
              {t.keep}
            </button>
            {!fv.ok && <span className="small ink2">{t.factsChanged}</span>}
          </div>
        )}
        {err && <div className="error-box">{err}</div>}
      </div>
    </>
  );
}

function FactGroup({ label, kept, missing, added = [], block }: { label: string; kept: string[]; missing: string[]; added?: string[]; block?: boolean }) {
  const t = useDict(projectPitchDict).facts;
  if (!kept.length && !missing.length && !added.length) return null;
  return (
    <div className="fact-group">
      <span className="small ink2">{label}</span>
      <ul className={`fact-chips${block ? " block" : ""}`}>
        {kept.map((x) => (
          <li key={`k${x}`} className="ok">
            <span aria-hidden="true">✓</span> {x}
            <span className="sr-only">{t.kept}</span>
          </li>
        ))}
        {missing.map((x) => (
          <li key={`m${x}`} className="bad">
            <span aria-hidden="true">✗</span> {x} <span className="tag-mini">{t.missing}</span>
          </li>
        ))}
        {added.map((x) => (
          <li key={`a${x}`} className="bad">
            <span aria-hidden="true">+</span> {x} <span className="tag-mini">{t.added}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
