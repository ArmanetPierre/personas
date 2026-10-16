import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Engine } from "../../src/engine/engine";
import type { Backend, BackendRequest } from "../../src/engine/types";
import { previewTarget } from "../../src/population/preview";
import { checkVariant, suggestTarget, writeSuggestion, type TargetSuggestionData } from "../../src/population/suggest";
import { drawTarget, prepareTarget } from "../../src/population/target";
import { describeForPrompt } from "../../src/personas/describe";
import type { Persona } from "../../src/db/schema";
import {
  agreement,
  averageProbs,
  digitProbs,
  estimateNotConcerned,
  runTriage,
  TriageCache,
  type LogprobClient,
  type TriageItem,
} from "../../src/triage";

const tmp = mkdtempSync(join(tmpdir(), "personas-p1-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const lp = (p: number) => Math.log(p);

/**
 * Client simulé : « pas concerné·e » pour les ouvriers, « concerné·e » sinon, avec un biais de
 * position (le chiffre 1 reçoit un bonus) pour vérifier que la moyenne des deux ordres le corrige.
 */
function fakeClient(opts: { bias?: number } = {}) {
  let inFlight = 0;
  let maxInFlight = 0;
  let calls = 0;
  const client: LogprobClient = {
    model: "fake-qwen",
    concurrency: 8, // demandé : 8 ; plafonné à 2
    async firstToken(system, user) {
      calls++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      const direct = /\n1 : concerné·e/.test(system);
      const nc = /Situation : Ouvri/.test(user);
      const want = nc ? { concerned: 0.05, marginal: 0.15, not_concerned: 0.8 } : { concerned: 0.7, marginal: 0.25, not_concerned: 0.05 };
      const order = direct ? (["concerned", "marginal", "not_concerned"] as const) : (["not_concerned", "marginal", "concerned"] as const);
      const b = opts.bias ?? 0;
      const raw = order.map((l, i) => want[l] + (i === 0 ? b : 0));
      const s = raw.reduce((a, x) => a + x, 0) / 0.9; // 10 % de masse hors chiffres
      return {
        content: "1",
        top: [
          ...raw.map((x, i) => ({ token: i === 1 ? ` ${i + 1}` : String(i + 1), logprob: lp(x / s) })),
          { token: "Je", logprob: lp(0.1) },
        ],
      };
    },
  };
  return { client, stats: () => ({ calls, maxInFlight }) };
}

describe("pré-tri de pertinence (méthode A)", () => {
  it("renormalise sur les chiffres 1 à 3 et remet les étiquettes dans l'ordre", () => {
    const top = [
      { token: "1", logprob: lp(0.45) },
      { token: " 2", logprob: lp(0.27) },
      { token: "3", logprob: lp(0.18) },
      { token: "4", logprob: lp(0.05) },
      { token: "Je", logprob: lp(0.05) },
    ];
    const d = digitProbs(top, "direct");
    expect(d.mass).toBeCloseTo(0.9, 6);
    expect(d.probs.concerned).toBeCloseTo(0.5, 6);
    expect(d.probs.marginal).toBeCloseTo(0.3, 6);
    expect(d.probs.not_concerned).toBeCloseTo(0.2, 6);
    const r = digitProbs(top, "reverse");
    expect(r.probs.not_concerned).toBeCloseTo(0.5, 6);
    expect(r.probs.concerned).toBeCloseTo(0.2, 6);
    expect(digitProbs([{ token: "Je", logprob: 0 }], "direct").mass).toBe(0);
  });

  it("la moyenne des deux ordres annule un biais de position symétrique", () => {
    const a = averageProbs([
      { concerned: 0.6, marginal: 0.2, not_concerned: 0.2 },
      { concerned: 0.2, marginal: 0.2, not_concerned: 0.6 },
    ]);
    expect(a.concerned).toBeCloseTo(0.4);
    expect(a.not_concerned).toBeCloseTo(0.4);
  });

  it("deux appels par item, concurrence ≤ 2, cache et reprise", async () => {
    const cachePath = join(tmp, "cache.jsonl");
    const items: TriageItem[] = Array.from({ length: 6 }, (_, i) => ({
      id: `p${i}`,
      system: { direct: "sys\n1 : concerné·e : …", reverse: "sys\n1 : pas concerné·e : …" },
      user: `${i % 2 ? "Situation : Ouvrier" : "Situation : Cadre"} (${i})`,
    }));
    const f = fakeClient({ bias: 0.1 });
    const run = await runTriage(items, { client: f.client, cachePath });
    expect(run.calls).toBe(12);
    expect(f.stats().maxInFlight).toBeLessThanOrEqual(2);
    expect(run.results.map((r) => r.label)).toEqual(["concerned", "not_concerned", "concerned", "not_concerned", "concerned", "not_concerned"]);
    // Biais de position (+0,1 sur le chiffre 1) : chaque ordre est biaisé, la moyenne retrouve la cible à ±0,05
    const r1 = run.results[1]!;
    expect(r1.byOrder.reverse!.not_concerned).toBeGreaterThan(r1.byOrder.direct!.not_concerned);
    expect(Math.abs(r1.probs.not_concerned - 0.8)).toBeLessThan(0.05);
    expect(r1.mass).toBeCloseTo(0.9, 2);
    // Deuxième passage : tout vient du cache disque
    const again = fakeClient();
    const run2 = await runTriage(items, { client: again.client, cachePath });
    expect(run2.calls).toBe(0);
    expect(run2.cached).toBe(12);
    expect(again.stats().calls).toBe(0);
    // Reprise : une ligne tronquée (arrêt brutal) est refaite, les autres sont gardées
    const lines = readFileSync(cachePath, "utf8").trim().split("\n");
    expect(new TriageCache(cachePath).size).toBe(12);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(cachePath, lines.slice(0, 10).join("\n") + "\n" + lines[10]!.slice(0, 20));
    const resumed = await runTriage(items, { client: fakeClient().client, cachePath });
    expect(resumed.calls).toBe(2);
    expect(resumed.results).toHaveLength(6);
  });

  it("un modèle hors format est compté en échec, sans résultat", async () => {
    const client: LogprobClient = { model: "m", async firstToken() { return { content: "Je", top: [{ token: "Je", logprob: 0 }] }; } };
    const run = await runTriage([{ id: "x", system: { direct: "a", reverse: "b" }, user: "u" }], { client, cachePath: null });
    expect(run.results).toHaveLength(0);
    expect(run.failed[0]!.error).toMatch(/hors format/);
  });

  it("estimation de la part et accord avec une référence", () => {
    const mk = (id: string, nc: number) => ({ id, probs: { concerned: 1 - nc, marginal: 0, not_concerned: nc }, byOrder: {}, mass: 1, label: (nc >= 0.5 ? "not_concerned" : "concerned") as "concerned" | "not_concerned" });
    const results = [...Array.from({ length: 20 }, (_, i) => mk(`a${i}`, 0.9)), ...Array.from({ length: 80 }, (_, i) => mk(`b${i}`, 0.1))];
    const e = estimateNotConcerned(results, 0.5);
    // Moyenne des P(NC) : 0,2 × 0,9 + 0,8 × 0,1 = 0,26 ; 20 personas au-dessus du seuil
    expect(e.share).toBeCloseTo(0.26);
    expect(e.flagged).toBe(20);
    expect(e.ci[0]).toBeLessThan(0.26);
    expect(e.ci[1]).toBeGreaterThan(0.26);
    const a = agreement(results.map((r, i) => ({ ref: i < 15 || i >= 95 ? "not_concerned" : "concerned", result: r })), 0.5);
    expect(a.recallNc).toBeCloseTo(15 / 20);
    expect(a.falseNcRate).toBeCloseTo(5 / 80);
    expect(a.auc).toBeGreaterThan(0.5);
  });
});

describe("aperçu de cible", () => {
  const project = {
    id: "demo-p1",
    name: "Démo",
    pitch: "Une application de démonstration pour tester l'aperçu d'une cible avant lancement.",
    price: { amountEur: 5, period: "month" as const },
    target: { socle: "fr", modules: ["numerique"], eligibility: "activity_status == employed", n: 60 },
  };

  it("éligibilité, distributions, fiches restreintes aux modules, pré-tri et profils", async () => {
    const f = fakeClient();
    const p = await previewTarget(project, { triage: { client: f.client, cachePath: null }, sample: 4 });
    expect(p.n).toBe(60);
    expect(p.filter).toBe("activity_status == employed");
    expect(p.eligibility.rate).toBeGreaterThan(0.4);
    expect(p.eligibility.rate).toBeLessThan(0.8);
    const keys = p.distributions.map((d) => d.key);
    expect(keys).toEqual(expect.arrayContaining(["ageBand", "pcs", "activityStatus", "numerique.is_digital_worker"]));
    expect(p.distributions.find((d) => d.key === "activityStatus")!.inFilter).toBe(true);
    expect(p.cards).toHaveLength(4);
    expect(p.cards[0]!.card).not.toMatch(/Tonalité|Reste-à-vivre|Abonnements en cours/);
    // Pré-tri : les ouvriers sont « pas concernés » ; la part et le profil le retrouvent
    const t = p.triage!;
    const d = drawTarget(prepareTarget(project.target), 60, 42);
    const ouvriers = d.personas.filter((x) => x.pcs === "6").length;
    const mean = t.personas.reduce((a, x) => a + x.probs.not_concerned, 0) / 60;
    expect(t.share).toBeCloseTo(mean, 9);
    expect(t.flagged).toBe(ouvriers);
    expect(t.personas.filter((x) => x.flagged).length).toBe(ouvriers);
    expect(t.calls).toBe(120);
    expect(f.stats().maxInFlight).toBeLessThanOrEqual(2);
    expect(t.alert).toBe(t.share > 0.1);
    const top = t.profiles[0]!;
    expect(top.criteria.map((c) => `${c.key}=${c.value}`)).toContain("pcs=6");
    expect(top.rate).toBeGreaterThan(0.7);
    expect(top.lift).toBeGreaterThan(2);
  });

  it("les lignes de fiche conditionnées par le socle (ex. « employed ») s'affichent", () => {
    const t = prepareTarget({ socle: "fr", modules: ["productivite-reunions"], eligibility: "activity_status == employed" });
    const d = drawTarget(t, 3, 42);
    const card = describeForPrompt(d.pack, d.personas[0]! as unknown as Persona, { modules: ["productivite-reunions"] });
    expect(card).toMatch(/Réunions : /);
    expect(card).toMatch(/Employeur : /);
  });
});

describe("assistant de cible", () => {
  const project = {
    id: "demo-suggest",
    name: "Démo",
    pitch: "Un outil de suivi de projets pour freelances du numérique, payant au mois.",
    price: { amountEur: 9, period: "month" as const },
  };
  const proposal = (eligibility: string, modules = ["numerique"]): TargetSuggestionData => ({
    analysis: "Il faut être freelance du numérique.",
    usageConditions: [{ condition: "être freelance", attribute: "numerique.work_status", why: "outil pour freelances" }],
    variants: [
      { id: "coeur", label: "Cœur de cible", description: "Freelances du numérique", modules, eligibility, quotas: [], justification: [{ criterion: eligibility, why: "usage" }] },
      { id: "large", label: "Cible large", description: "Actifs du numérique", modules: ["numerique"], eligibility: "numerique.is_digital_worker", quotas: [], justification: [{ criterion: "numérique", why: "besoin" }] },
    ],
    missingModules: [{ id: "outils-projet", description: "Outils de gestion de projet utilisés", attributes: ["pm_tool"], why: "concurrence" }],
    notes: [],
  });

  function fakeEngine(replies: TargetSuggestionData[]) {
    const requests: BackendRequest[] = [];
    let i = 0;
    const backend: Backend = {
      name: "claude-cli",
      model: "fake",
      concurrency: 1,
      async checkAvailability() {
        return { ok: true, detail: "simulé" };
      },
      async generate(req) {
        requests.push(req);
        const r = replies[Math.min(i++, replies.length - 1)]!;
        return { text: JSON.stringify(r), model: "fake", usage: { inputTokens: 100, outputTokens: 50 } };
      },
    };
    return { engine: new Engine(backend, { maxRepairs: 0 }), requests };
  }

  it("refuse variable inconnue, code inconnu et filtre vide", () => {
    const v = proposal("x").variants[0]!;
    expect(checkVariant({ ...v, eligibility: "numerique.inexistant == 1" }).errors[0]).toMatch(/inconnue/);
    expect(checkVariant({ ...v, eligibility: "numerique.work_status == freelance" }).errors[0]).toMatch(/code\(s\) inconnu\(s\) freelance/);
    expect(checkVariant({ ...v, eligibility: "pcs == 9" }).errors[0]).toMatch(/pcs : code/);
    expect(checkVariant({ ...v, eligibility: "age < 20 and age > 70" }).errors[0]).toMatch(/aucune persona éligible/);
    expect(checkVariant({ ...v, eligibility: "numerique.work_status in [freelance_micro, freelance_company]" }).errors).toEqual([]);
  });

  it("répare un filtre invalide, prévisualise chaque variante et écrit la proposition sans l'appliquer", async () => {
    const { engine, requests } = fakeEngine([
      proposal("numerique.work_status == freelance"),
      proposal("numerique.work_status in [freelance_micro, freelance_company]"),
    ]);
    const s = await suggestTarget(project, { engine, n: 20 });
    expect(s.repairs).toBe(1);
    expect(requests).toHaveLength(2);
    expect(requests[0]!.webTools).toBeUndefined();
    expect(requests[0]!.messages[0]!.content).toMatch(/numerique\.work_status \[enum\]/);
    expect(requests[1]!.messages.at(-1)!.content).toMatch(/code\(s\) inconnu\(s\) freelance/);
    expect(s.variants.map((v) => v.errors)).toEqual([[], []]);
    const [coeur, large] = s.variants.map((v) => v.preview!);
    expect(coeur!.n).toBe(20);
    expect(coeur!.eligibility.rate).toBeLessThan(large!.eligibility.rate);
    expect(s.variants[0]!.target).toEqual({ socle: "fr", modules: ["numerique"], eligibility: "numerique.work_status in [freelance_micro, freelance_company]", n: 20 });
    const out = writeSuggestion(s, join(tmp, "demo.target-suggestion.yaml"));
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(out, "utf8")).toMatch(/rien n'est appliqué/);
  });

  it("une variante toujours invalide après les réparations est gardée avec ses erreurs, sans aperçu", async () => {
    const { engine } = fakeEngine([proposal("numerique.work_status == freelance")]);
    const s = await suggestTarget(project, { engine, n: 20, maxRepairs: 1 });
    expect(s.repairs).toBe(1);
    expect(s.variants[0]!.errors.length).toBeGreaterThan(0);
    expect(s.variants[0]!.preview).toBeUndefined();
    expect(s.variants[1]!.preview).toBeDefined();
  });
});
