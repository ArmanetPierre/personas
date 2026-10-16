import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Engine } from "../../src/engine/engine";
import type { Backend, BackendRequest } from "../../src/engine/types";
import { buildClaudeArgs } from "../../src/engine/backends/claude-cli";
import {
  acceptDraft,
  getModule,
  lineDiff,
  listModules,
  previewModule,
  proposeModule,
  readMeta,
  reviseModule,
  saveDraftYaml,
  validateModuleYaml,
} from "../../src/modules/assistant";

const VALID = `
id: test-eco
version: "2026.2"
label: Écosystème (test)
applies_to: [fr]
sources:
  sc: {org: StatCounter, title: "Desktop OS market share France", year: 2025, url: "https://gs.statcounter.com/os-market-share/desktop/france"}
attributes:
  - key: computer_os
    label: Système de l'ordinateur principal
    type: enum
    when: {attr: socle.has_computer, eq: true}
    values:
      - {code: windows, label: Windows}
      - {code: macos, label: macOS}
      - {code: linux, label: Linux}
    distribution:
      weights:
        windows: 70
        macos: {mul: [18, {pick: socle.pcs, values: {"3": 1.8}, default: 1}]}
        linux: 3
    sources: [sc]
card:
  - when: {attr: computer_os, present: true}
    template: "Ordinateur : {computer_os}"
segments:
  - {id: ecoTestOs, attribute: computer_os, label: Système}
validation:
  margins: [{attribute: computer_os, title: Système}]
eligibility_helpers:
  mac_user: "test-eco.computer_os == macos"
`;
// Erreur volontaire : l'OS de l'ordinateur sans garde-fou « has_computer » et une source inconnue
const INVALID = VALID.replace("    when: {attr: socle.has_computer, eq: true}\n", "").replace("sources: [sc]", "sources: [inconnue]");

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "personas-modules-"));
  for (const m of ["numerique", "entrepreneuriat"]) cpSync(resolve("modules", m), join(dir, m), { recursive: true });
  process.env.PERSONAS_MODULES_DIR = dir;
});
afterAll(() => {
  delete process.env.PERSONAS_MODULES_DIR;
  rmSync(dir, { recursive: true, force: true });
});

function fake(replies: Array<(req: BackendRequest) => unknown>) {
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
      const r = replies[Math.min(i++, replies.length - 1)]!(req);
      if (r instanceof Error) throw r;
      return { text: JSON.stringify(r), model: "fake", usage: { inputTokens: 100, outputTokens: 50 } };
    },
  };
  return { engine: new Engine(backend, { maxRepairs: 0 }), requests };
}

const research = { summary: "s", sources: [{ key: "sc", org: "StatCounter", title: "t", year: 2025, url: "https://gs.statcounter.com", verified: true, findings: ["macOS 18 %"] }], attributes: [], notes: ["Pas de chiffre par PCS."] };

describe("mode recherche du backend claude-cli", () => {
  it("n'autorise que WebSearch et WebFetch, et rien en mode normal", () => {
    const after = (args: string[], f: string) => args[args.indexOf(f) + 1];
    expect(after(buildClaudeArgs({ model: "m", system: "s" }), "--tools")).toBe("");
    const web = buildClaudeArgs({ model: "m", system: "s", webTools: ["WebSearch", "WebFetch"] });
    expect(after(web, "--tools")).toBe("WebSearch,WebFetch");
    expect(after(web, "--allowedTools")).toBe("WebSearch,WebFetch");
    expect(() => buildClaudeArgs({ model: "m", system: "s", webTools: ["Bash"] })).toThrow(/seuls WebSearch et WebFetch/);
  });
});

describe("validation", () => {
  it("accepte un module valide et décrit les erreurs avec leur chemin", () => {
    expect(validateModuleYaml(VALID).ok).toBe(true);
    const bad = validateModuleYaml(INVALID);
    expect(bad.ok).toBe(false);
    expect(bad.errors.map((e) => e.message).join()).toMatch(/source « inconnue » absente/);
    expect(validateModuleYaml("id: [").errors[0]!.message).toMatch(/YAML illisible/);
    expect(validateModuleYaml(VALID.replace('"test-eco.computer_os == macos"', '"test-eco.os == macos"')).errors[0]!.path).toBe("eligibility_helpers.mac_user");
  });

  it("filtres prêts à l'emploi : variables du filtre propres au socle (Singapour)", () => {
    const sgYaml = VALID.replace("applies_to: [fr]", "applies_to: [sg]").replace('"test-eco.computer_os == macos"', '"test-eco.computer_os == macos and dwelling in [condo, landed] and religion != islam and nationality == western"');
    expect(validateModuleYaml(sgYaml, { socle: "sg" }).errors.filter((e) => e.path.startsWith("eligibility_helpers"))).toEqual([]);
    // une condition nommée inconnue dans validation.shares est une erreur de validation (et non une exception de l'aperçu)
    const badShare = VALID.replace(/validation:\n/, "validation:\n  shares: [{label: x, share_of: not_declared, range: [0, 1]}]\n");
    expect(validateModuleYaml(badShare).errors.map((e) => e.message).join()).toMatch(/condition « not_declared » non déclarée/);
    // le socle France n'a pas ces variables
    const frYaml = VALID.replace('"test-eco.computer_os == macos"', '"test-eco.computer_os == macos and dwelling in [condo]"');
    expect(validateModuleYaml(frYaml).errors.map((e) => e.path)).toContain("eligibility_helpers.mac_user");
  });
});

describe("proposition, réparation, révision, validation", () => {
  it("cherche les sources (mode recherche), rédige, répare, puis s'arrête prête à relire", async () => {
    const { engine, requests } = fake([
      () => research,
      () => ({ yaml: INVALID, notes: ["Part de Mac chez les cadres supposée."] }),
      () => ({ yaml: INVALID.replace("sources: [inconnue]", "sources: [sc]"), notes: [] }), // reste l'incohérence avec le socle
      () => ({ yaml: VALID, notes: ["Garde-fou ordinateur ajouté."] }),
    ]);
    const meta = await proposeModule(engine, { draftId: "test-eco-1", description: "OS de l'ordinateur", moduleId: "test-eco", socle: "fr" });
    expect(meta.status).toBe("ready");
    expect(requests[0]!.webTools).toEqual(["WebSearch", "WebFetch"]);
    expect(requests[1]!.webTools).toBeUndefined();
    // 2 tours de réparation : erreur de validation, puis alerte bloquante de l'aperçu (Mac sans ordinateur)
    expect(meta.steps?.repairRounds).toBe(2);
    expect(requests[3]!.messages.at(-1)!.content).toMatch(/personas sans un ordinateur/);
    expect(meta.notes.join()).toMatch(/Recherche : Pas de chiffre par PCS/);
    expect(meta.usage!.calls).toBe(4);
    expect(existsSync(join(dir, "_drafts", "test-eco-1", "research.json"))).toBe(true);
    expect(listModules().find((m) => m.draftId === "test-eco-1")).toMatchObject({ id: "test-eco", status: "draft:ready", attributeCount: 1, sourcedCount: 1 });
  });

  it("est reprenable après une limite d'usage, sans refaire la recherche", async () => {
    const quota = fake([() => research, () => new Error("claude a renvoyé une erreur : Claude AI usage limit reached")]);
    const m1 = await proposeModule(quota.engine, { draftId: "test-eco-2", description: "OS", moduleId: "test-eco", socle: "fr" });
    expect(m1.status).toBe("error");
    expect(m1.error).toMatch(/Limite d'usage atteinte : relancer plus tard avec --draft test-eco-2/);
    const resume = fake([() => ({ yaml: VALID, notes: [] })]);
    const m2 = await proposeModule(resume.engine, { draftId: "test-eco-2", description: "OS", socle: "fr" });
    expect(m2.status).toBe("ready");
    expect(resume.requests).toHaveLength(1); // recherche déjà faite
  });

  it("révise avec historique et diff, édite à la main avec validation, puis valide vers la bibliothèque", async () => {
    const revised = VALID.replace("linux: 3", "linux: 5");
    const { engine } = fake([() => ({ yaml: revised, summary: "Linux un peu plus fréquent.", notes: [] })]);
    const meta = await reviseModule(engine, "test-eco-1", "augmente un peu Linux");
    expect(meta.status).toBe("ready");
    const last = meta.history.at(-1)!;
    expect(last.kind).toBe("revise");
    expect(last.diff).toMatch(/- +linux: 3\n\+ +linux: 5/);
    expect(saveDraftYaml("test-eco-1", INVALID).ok).toBe(false);
    expect(saveDraftYaml("test-eco-1", revised.replace("linux: 5", "linux: 4")).ok).toBe(true);
    expect(readMeta("test-eco-1").history.at(-1)!.kind).toBe("edit");
    const r = acceptDraft("test-eco-1");
    expect(readFileSync(r.file, "utf8")).toMatch(/linux: 4/);
    expect(getModule("test-eco").status).toBe("validated");
    expect(readMeta("test-eco-1").status).toBe("accepted");
    expect(() => acceptDraft("test-eco-2")).toThrow(/existe déjà/);
  });
});

describe("révision avec recherche et recalage", () => {
  it("cherche, fusionne research.json, révise, puis recale sur les parts sourcées (vérifié par l'aperçu)", async () => {
    const withShare = VALID.replace(
      "validation:\n  margins: [{attribute: computer_os, title: Système}]",
      'validation:\n  margins: [{attribute: computer_os, title: Système}]\n  shares:\n    - {label: "Mac parmi les ordinateurs (Kantar)", among: {attr: computer_os, present: true}, share_of: {attr: computer_os, eq: macos}, range: [0.4, 0.5]}',
    );
    const calibrated = withShare.replace('macos: {mul: [18, {pick: socle.pcs, values: {"3": 1.8}, default: 1}]}', 'macos: {mul: [55, {pick: socle.pcs, values: {"3": 1.8}, default: 1}]}');
    const added = { summary: "parc", sources: [{ key: "kantar", org: "Kantar", title: "Parc", year: 2026, url: "https://example.org/kantar", verified: true, findings: ["Mac 45 % (fictif)"] }, { key: "sc", org: "StatCounter", title: "t", year: 2025, url: "https://gs.statcounter.com", verified: false, findings: ["18 %"] }], attributes: [], notes: ["Source de parc trouvée."] };
    const { engine, requests } = fake([
      () => research,
      () => ({ yaml: VALID, notes: [] }),
      () => added,
      () => ({ yaml: withShare, summary: "Part de Mac déclarée.", notes: [] }),
      () => ({ yaml: calibrated, summary: "macOS relevé.", notes: [] }),
    ]);
    await proposeModule(engine, { draftId: "test-eco-3", description: "OS", moduleId: "test-eco-bis", socle: "fr" });
    const meta = await reviseModule(engine, "test-eco-3", "recale la part de Mac sur une source de parc", { research: true });
    expect(meta.status).toBe("ready");
    expect(requests[2]!.webTools).toEqual(["WebSearch", "WebFetch"]);
    expect(requests[3]!.messages.at(-1)!.content).toMatch(/Recherche ciblée faite pour cette révision/);
    expect(requests[4]!.messages.at(-1)!.content).toMatch(/Mac parmi les ordinateurs \(Kantar\)/);
    const merged = JSON.parse(readFileSync(join(dir, "_drafts", "test-eco-3", "research.json"), "utf8"));
    expect(merged.sources.map((x: { key: string }) => x.key)).toEqual(["sc", "kantar"]); // même URL que « sc » fusionnée
    expect(merged.notes).toContain("Source de parc trouvée.");
    expect(meta.history.map((h) => h.kind)).toEqual(["propose", "revise", "repair"]);
    expect(getModule("test-eco-3").yaml).toMatch(/macos: \{mul: \[55/);
    expect(previewModule({ draftId: "test-eco-3" }, { n: 4000, sample: 0 }).alerts.map((x) => x.message).join()).not.toMatch(/Cible déclarée non atteinte/);
  });
});

describe("recherche ciblée vide", () => {
  it("relance une fois la recherche quand le modèle n'a renvoyé aucune source", async () => {
    const empty = { summary: "Voir premier appel.", sources: [], attributes: [], notes: [] };
    const found = { summary: "ok", sources: [{ key: "owl", org: "Owl Labs", title: "State of Remote Work", year: 2025, url: "https://example.org/owl", verified: true, findings: ["x"] }], attributes: [], notes: [] };
    const { engine, requests } = fake([() => research, () => ({ yaml: VALID, notes: [] }), () => empty, () => found, () => ({ yaml: VALID.replace("linux: 3", "linux: 4"), summary: "s", notes: [] })]);
    await proposeModule(engine, { draftId: "test-eco-4", description: "OS", moduleId: "test-eco-ter", socle: "fr" });
    const meta = await reviseModule(engine, "test-eco-4", "source les réunions", { research: true });
    expect(meta.status).toBe("ready");
    expect(requests[3]!.webTools).toEqual(["WebSearch", "WebFetch"]);
    expect(requests[3]!.messages.at(-1)!.content).toMatch(/Tu n'as renvoyé aucune source/);
    const merged = JSON.parse(readFileSync(join(dir, "_drafts", "test-eco-4", "research.json"), "utf8"));
    expect(merged.sources.map((x: { key: string }) => x.key)).toContain("owl");
  });
});

describe("aperçu et alertes", () => {
  it("marges, fiches, filtres prêts à l'emploi et alertes automatiques", () => {
    const ok = previewModule({ yaml: VALID }, { n: 4000, sample: 2 });
    expect(ok.margins[0]!.attribute).toBe("computer_os");
    expect(ok.margins[0]!.values.find((v) => v.code === "__absent")).toBeDefined();
    expect(ok.sampleCards).toHaveLength(2);
    expect(ok.eligibilityHelpers![0]!.rate).toBeGreaterThan(0.05);
    expect(ok.alerts.filter((a) => a.level === "error")).toEqual([]);

    const noEffect = VALID.replace('macos: {mul: [18, {pick: socle.pcs, values: {"3": 1.8}, default: 1}]}', 'macos: {mul: [18, {pick: socle.pcs, values: {"3": 1}, default: 1}]}');
    expect(previewModule({ yaml: noEffect }, { n: 3000, sample: 0 }).alerts.map((a) => a.message).join()).toMatch(/le conditionnement n'a pas d'effet/);
    const never = VALID.replace("linux: 3", "linux: 0");
    expect(previewModule({ yaml: never }, { n: 3000, sample: 0 }).alerts.map((a) => a.message).join()).toMatch(/« Linux » n'est jamais tirée/);
    const rare = VALID.replace("linux: 3", "linux: 0.2");
    expect(previewModule({ yaml: rare }, { n: 6000, sample: 0 }).alerts.map((a) => a.message).join()).toMatch(/« Linux » est très rare/);
    const unsourced = VALID.replace("    sources: [sc]\ncard", "    assumption: true\n    justification: test\ncard");
    const msgs = previewModule({ yaml: unsourced }, { n: 2000, sample: 0 }).alerts.map((a) => a.message).join();
    expect(msgs).toMatch(/n'a aucune source/);
    expect(msgs).toMatch(/1 attributs sur 1 reposent sur des hypothèses/);
    const target = VALID.replace("eligibility_helpers:", 'validation_placeholder:').replace("validation:\n  margins: [{attribute: computer_os, title: Système}]", 'validation:\n  margins: [{attribute: computer_os, title: Système}]\n  shares:\n    - {label: "Mac parmi les ordinateurs", among: {attr: computer_os, present: true}, share_of: {attr: computer_os, eq: macos}, range: [0.5, 0.6]}').replace(/validation_placeholder:[\s\S]*$/, "");
    expect(previewModule({ yaml: target }, { n: 3000, sample: 0 }).alerts.map((a) => a.message).join()).toMatch(/Cible déclarée non atteinte : Mac parmi les ordinateurs/);
    const incoherent = previewModule({ yaml: INVALID.replace("sources: [inconnue]", "sources: [sc]") }, { n: 3000, sample: 0 });
    expect(incoherent.alerts.find((a) => a.level === "error")!.message).toMatch(/personas sans un ordinateur/);
  });

  it("lineDiff", () => {
    expect(lineDiff("a\nb\nc", "a\nB\nc")).toBe("  a\n- b\n+ B\n  c");
  });
});
