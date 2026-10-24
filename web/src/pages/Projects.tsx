import { useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { api, ApiError, useApi, useMeta, type ProjectDetail, type ProjectListItem } from "../api";
import { Cols, dateFr, EmptyState, ErrorBox, FolderIcon, Loading, Status } from "../ui";
import { tr, useDict } from "../i18n";
import { projectDict } from "../i18n/project";

export function ProjectsPage() {
  const { data, error, reload } = useApi<ProjectListItem[]>("/projects");
  const [mode, setMode] = useState<"none" | "form">("none");
  const [importError, setImportError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [, navigate] = useLocation();
  const t = useDict(projectDict).list;

  const onImport = async (file: File) => {
    setImportError(null);
    try {
      const content = await file.text();
      const p = await api<ProjectDetail>("/projects/import", { json: { content, filename: file.name } });
      await reload();
      navigate(`/projets/${p.id}`);
    } catch (e) {
      setImportError(formatIssues(e));
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <>
      <h1>{t.title}</h1>
      <p className="lede" style={{ marginTop: 10 }}>
        {t.lede}
      </p>
      <div className="row" style={{ marginTop: 22 }}>
        <button className="btn" type="button" onClick={() => setMode(mode === "form" ? "none" : "form")} aria-expanded={mode === "form"}>
          {mode === "form" ? t.closeForm : t.create}
        </button>
        <button className="btn ghost" type="button" onClick={() => fileRef.current?.click()}>
          {t.importFile}
        </button>
        <input ref={fileRef} type="file" accept=".json,.yaml,.yml,application/json" hidden onChange={(e) => e.target.files?.[0] && void onImport(e.target.files[0])} />
        <span className="small muted">{t.importHint}</span>
      </div>
      {importError && <div className="error-box" style={{ marginTop: 14 }}>{importError}</div>}
      {mode === "form" && (
        <div className="panel" style={{ marginTop: 18 }}>
          <ProjectForm
            onCreated={async (p) => {
              await reload();
              navigate(`/projets/${p.id}`);
            }}
          />
        </div>
      )}

      <div className="section" style={{ marginTop: 36 }}>
        <ErrorBox error={error} />
        {!data && !error && <Loading />}
        {data && data.length === 0 && (
          <EmptyState
            icon={<FolderIcon />}
            title={t.emptyTitle}
            description={t.empty}
            action={
              mode !== "form" && (
                <button className="btn" type="button" onClick={() => setMode("form")}>
                  {t.create}
                </button>
              )
            }
          />
        )}
        {data && data.length > 0 && (
          <div className="table-wrap">
            <table className="table fixed projects-table">
              <Cols widths={[null, 170, 72, 280]} />
              <thead>
                <tr>
                  <th>{t.colProject}</th>
                  <th>{t.colPrice}</th>
                  <th className="r">{t.colStudies}</th>
                  <th>{t.colLastStudy}</th>
                </tr>
              </thead>
              <tbody>
                {data.map((p) => (
                  <tr key={p.id} className="link" onClick={() => navigate(`/projets/${p.id}`)}>
                    <td style={{ maxWidth: 520 }}>
                      <Link href={`/projets/${p.id}`} onClick={(e) => e.stopPropagation()}>
                        <b className="cell-name">{p.name}</b>
                      </Link>
                      <span className="small muted num" style={{ marginLeft: 8 }}>{p.id}</span>
                      <div className="small ink2 clamp-2" style={{ marginTop: 3 }}>
                        {p.pitch}
                      </div>
                    </td>
                    <td className="num small">{p.price}</td>
                    <td className="r num">{p.studyCount}</td>
                    <td>
                      {p.lastStudy ? (
                        <div className="stack" style={{ gap: 2 }}>
                          <Link href={`/etudes/${p.lastStudy.id}`} onClick={(e) => e.stopPropagation()}>
                            {p.lastStudy.name}
                          </Link>
                          <span className="row small" style={{ gap: 10 }}>
                            <Status status={p.lastStudy.status} />
                            <span className="muted">{dateFr(p.lastStudy.createdAt)}</span>
                          </span>
                        </div>
                      ) : (
                        <span className="muted">{t.none}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

export function formatIssues(e: unknown): string {
  if (e instanceof ApiError) {
    const issues = (e.body as { issues?: Array<{ path: string; message: string }> }).issues;
    const d = tr(projectDict).issues;
    if (issues?.length) return `${e.message}\n${issues.map((i) => d.line(i.path || d.root, i.message)).join("\n")}`;
    return e.message;
  }
  return (e as Error).message;
}

const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);

function ProjectForm({ onCreated }: { onCreated: (p: ProjectDetail) => void }) {
  const meta = useMeta();
  const t = useDict(projectDict).form;
  const [f, setF] = useState({
    id: "",
    name: "",
    pitch: "",
    targetAudience: "",
    businessModel: "",
    amountEur: "5",
    period: "month",
    // Modèle de prix générique
    currency: "EUR",
    usageLabel: "",
    quantityUnit: "kg",
    expectedFrequency: "",
    altUnit: "",
    altAmount: "",
    minimumOrder: "",
    minimumNote: "",
    freemiumPaid: "",
    fxRate: "",
    fxDate: "",
    freeOffer: "",
    competitors: "",
    alternatives: "",
    priceTiers: "",
  });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const cur = f.currency === "EUR" ? "€" : f.currency;
  const units = meta?.priceUnits ?? [
    { id: "month", label: t.perMonth },
    { id: "year", label: t.perYear },
  ];

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    const tiers = f.priceTiers
      .split(/[;,\s]+/)
      .map((x) => Number(x.replace(",", ".")))
      .filter((x) => Number.isFinite(x) && x > 0);
    const num = (x: string) => Number(x.replace(",", "."));
    const altAmount = num(f.altAmount);
    const hasAlt = f.altUnit !== "" && altAmount > 0;
    // Forme historique si rien ne la dépasse (euros, mois ou an, une seule offre) : rétrocompatible
    const simple = f.currency === "EUR" && (f.period === "month" || f.period === "year") && !hasAlt && !f.minimumOrder.trim() && !f.freemiumPaid.trim();
    const offer = (id: string, unit: string, amount: number) => ({
      id,
      amount,
      unit,
      ...(unit === "usage" && { usageLabel: f.usageLabel.trim() || "usage" }),
      ...(unit === "quantity" && { quantity: { unit: f.quantityUnit.trim() || "kg" } }),
      ...(f.expectedFrequency.trim() && id === "principale" && unit !== "month" && unit !== "year" && { expectedFrequency: f.expectedFrequency.trim() }),
    });
    const price = simple
      ? { amountEur: num(f.amountEur), period: f.period }
      : {
          currency: f.currency,
          offers: [offer("principale", f.period, num(f.amountEur)), ...(hasAlt ? [offer("alternative", f.altUnit, altAmount)] : [])],
          reference: "principale",
          ...(tiers.length && { tiers }),
          ...(f.freeOffer.trim() && f.freemiumPaid.trim() && { freemium: { free: f.freeOffer.trim(), paid: f.freemiumPaid.trim() } }),
          ...(num(f.minimumOrder) > 0 && { minimumOrder: { amount: num(f.minimumOrder), ...(f.minimumNote.trim() && { note: f.minimumNote.trim() }) } }),
          ...(num(f.fxRate) > 0 && { fx: { eurPerUnit: num(f.fxRate), date: f.fxDate || new Date().toISOString().slice(0, 10) } }),
        };
    const body = {
      ...(f.id.trim() && { id: f.id.trim() }),
      name: f.name.trim(),
      pitch: f.pitch.trim(),
      ...(f.targetAudience.trim() && { targetAudience: f.targetAudience.trim() }),
      ...(f.businessModel.trim() && { businessModel: f.businessModel.trim() }),
      price,
      freeOffer: f.freeOffer.trim() || null,
      competitors: lines(f.competitors),
      alternatives: lines(f.alternatives),
      ...(simple && tiers.length && { priceTiers: tiers }),
    };
    setBusy(true);
    try {
      onCreated(await api<ProjectDetail>("/projects", { json: body }));
    } catch (e2) {
      setErr(formatIssues(e2));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="stack" style={{ gap: 18 }}>
      <h2>{t.title}</h2>
      <div className="form-grid">
        <label className="field">
          <span>{t.name}</span>
          <input type="text" required value={f.name} onChange={set("name")} />
        </label>
        <label className="field">
          <span>{t.id}</span>
          <input type="text" value={f.id} onChange={set("id")} placeholder={t.idPlaceholder} pattern="[a-z0-9][a-z0-9-]*" />
          <small>{t.idHint}</small>
        </label>
        <label className="field wide">
          <span>{t.pitch}</span>
          <textarea required minLength={20} rows={5} value={f.pitch} onChange={set("pitch")} />
          <small>{t.pitchHint}</small>
        </label>
        <label className="field">
          <span>{t.price(cur)}</span>
          <input type="number" required min="0.01" step="0.01" value={f.amountEur} onChange={set("amountEur")} />
        </label>
        <label className="field">
          <span>{t.priceUnit}</span>
          <select value={f.period} onChange={set("period")}>
            {units.map((u) => (
              <option key={u.id} value={u.id}>
                {u.label}
              </option>
            ))}
          </select>
          {f.period === "usage" && <input type="text" value={f.usageLabel} onChange={set("usageLabel")} aria-label={t.usageLabelAria} placeholder={t.usagePlaceholder} style={{ marginTop: 6 }} />}
          {f.period === "quantity" && <input type="text" value={f.quantityUnit} onChange={set("quantityUnit")} aria-label={t.quantityUnitAria} placeholder={t.quantityPlaceholder} style={{ marginTop: 6 }} />}
        </label>
        <label className="field">
          <span>{t.currency}</span>
          <select value={f.currency} onChange={set("currency")}>
            {(meta?.currencies ?? [{ id: "EUR" }]).map((c) => (
              <option key={c.id} value={c.id}>
                {c.id}
              </option>
            ))}
          </select>
          <small>{t.currencyHint}</small>
        </label>
        {f.currency !== "EUR" && (
          <label className="field">
            <span>{t.fxRate(f.currency)}</span>
            <input type="text" value={f.fxRate} onChange={set("fxRate")} placeholder={String(meta?.currencies?.find((c) => c.id === f.currency)?.fx?.eurPerUnit ?? "")} />
            <input type="date" value={f.fxDate} onChange={set("fxDate")} style={{ marginTop: 6 }} />
            <small>{t.fxHint}</small>
          </label>
        )}
        <label className="field">
          <span>{t.altOffer}</span>
          <select value={f.altUnit} onChange={set("altUnit")}>
            <option value="">{t.altNone}</option>
            {units.map((u) => (
              <option key={u.id} value={u.id}>
                {u.label}
              </option>
            ))}
          </select>
          {f.altUnit && <input type="number" min="0.01" step="0.01" value={f.altAmount} onChange={set("altAmount")} placeholder={t.altPricePlaceholder(cur)} style={{ marginTop: 6 }} />}
          <small>{t.altHint}</small>
        </label>
        {f.period !== "month" && f.period !== "year" && (
          <label className="field">
            <span>{t.frequency}</span>
            <input type="text" value={f.expectedFrequency} onChange={set("expectedFrequency")} placeholder={t.frequencyPlaceholder} />
          </label>
        )}
        <label className="field">
          <span>{t.minimumOrder(cur)}</span>
          <input type="number" min="0" step="0.01" value={f.minimumOrder} onChange={set("minimumOrder")} />
          {f.minimumOrder && <input type="text" value={f.minimumNote} onChange={set("minimumNote")} placeholder={t.minimumNotePlaceholder} style={{ marginTop: 6 }} />}
        </label>
        <label className="field wide">
          <span>{t.freeOffer}</span>
          <input type="text" value={f.freeOffer} onChange={set("freeOffer")} placeholder={t.freeOfferPlaceholder} />
        </label>
        <label className="field wide">
          <span>{t.freemiumPaid}</span>
          <input type="text" value={f.freemiumPaid} onChange={set("freemiumPaid")} placeholder={t.freemiumPaidPlaceholder} />
        </label>
        <label className="field">
          <span>{t.competitors}</span>
          <textarea rows={4} value={f.competitors} onChange={set("competitors")} />
          <small>{t.onePerLine}</small>
        </label>
        <label className="field">
          <span>{t.alternatives}</span>
          <textarea rows={4} value={f.alternatives} onChange={set("alternatives")} />
          <small>{t.alternativesHint}</small>
        </label>
        <label className="field">
          <span>{t.targetAudience}</span>
          <input type="text" value={f.targetAudience} onChange={set("targetAudience")} />
          <small>{t.targetAudienceHint}</small>
        </label>
        <label className="field">
          <span>{t.businessModel}</span>
          <input type="text" value={f.businessModel} onChange={set("businessModel")} />
          <small>{t.businessModelHint}</small>
        </label>
        <label className="field">
          <span>{t.tiers(cur)}</span>
          <input type="text" value={f.priceTiers} onChange={set("priceTiers")} placeholder="2, 5, 9" />
          <small>{t.tiersHint}</small>
        </label>
      </div>
      {err && <div className="error-box">{err}</div>}
      <div className="row">
        <button className="btn" type="submit" disabled={busy}>
          {busy ? t.creating : t.submit}
        </button>
      </div>
    </form>
  );
}
