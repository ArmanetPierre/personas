import { describe, expect, it } from "vitest";
import type { Persona } from "../../src/db/schema";
import { checkFacts } from "../../src/studies/protocols/facts";
import { answer, makePersonas } from "./fixtures";

const base = makePersonas(1)[0]!;
function persona(over: Partial<Persona> & { extra?: Record<string, unknown> }): Persona {
  return { ...base, narrative: null, ...over, extra: { ...(base.extra as object), ...(over.extra ?? {}) } } as Persona;
}
const say = (verbatim: string) => answer({ verbatim });
const codes = (a: unknown, p: Persona) => checkFacts(a, p).map((i) => i.code);

describe("faits inventés", () => {
  const noKids = persona({ extra: { childrenAges: [], partner: null }, activityStatus: "employed", pcs: "5", occupation: "Employée" });

  it("signale un enfant absent de la fiche et du récit", () => {
    expect(codes(say("Avec mon fils à la maison, pas le temps."), noKids)).toEqual(["invented_child"]);
    expect(codes(say("Mes enfants passent avant tout."), noKids)).toEqual(["invented_child"]);
    expect(codes(say("Pas le temps, avec le boulot."), noKids)).toEqual([]);
  });

  it("signale le mauvais sexe d'un enfant unique décrit dans le récit", () => {
    const p = persona({ extra: { childrenAges: [5] }, narrative: "Céline attend sa fille de cinq ans devant l'école." });
    expect(codes(say("Entre mon fils et le boulot, non."), p)).toEqual(["child_gender_mismatch"]);
    expect(codes(say("Entre ma fille et le boulot, non."), p)).toEqual([]);
    expect(codes(say("Entre mon enfant et le boulot, non."), p)).toEqual([]);
  });

  it("accepte un enfant de sexe non précisé quand la fiche en compte", () => {
    const p = persona({ extra: { childrenAges: [5, 8] } });
    expect(codes(say("Mon fils et ma fille me prennent tout mon temps."), p)).toEqual([]);
  });

  it("signale un conjoint absent ou du mauvais sexe", () => {
    expect(codes(say("J'en parlerai à mon mari."), noKids)).toEqual(["invented_partner"]);
    const withWife = persona({ extra: { partner: { age: 40, sex: "F", status: "employed", pcs: "4", incomeEur: 2000 } } });
    expect(codes(say("J'en parlerai à mon mari."), withWife)).toEqual(["invented_partner"]);
    expect(codes(say("J'en parlerai à ma femme."), withWife)).toEqual([]);
  });

  it("signale une entreprise à soi chez un salarié, pas chez un indépendant", () => {
    expect(codes(say("J'ai déjà monté ma boîte, j'ai assez de mal avec."), noKids)).toEqual(["invented_business"]);
    expect(codes(say("Je suis à mon compte depuis dix ans."), noKids)).toEqual(["invented_business"]);
    const artisan = persona({ pcs: "2", occupation: "Artisane" });
    expect(codes(say("Je suis à mon compte depuis dix ans."), artisan)).toEqual([]);
    // Statut imposé par un module : il figure dans le libellé de situation
    const freelance = persona({ pcs: "3", occupation: "Développeur·se / ingénieur·e logiciel — freelance en micro-entreprise" });
    expect(codes(say("Je suis freelance, ça peut m'intéresser."), freelance)).toEqual([]);
    const salariedFounderPack = persona({ pcs: "3", occupation: "Développeur·se / ingénieur·e logiciel — salarié cadre", extra: { modules: { "entrepreneuriat-tech": { status: "salaried_cadre", stage: "idea" } } } });
    expect(codes(say("Je suis à mon compte depuis dix ans."), salariedFounderPack)).toEqual(["invented_business"]);
    // « ma boîte » au sens d'employeur n'est pas signalé
    expect(codes(say("Ma boîte ne me laisse pas le temps."), noKids)).toEqual([]);
  });

  it("signale un statut d'emploi contraire à la fiche", () => {
    const retired = persona({ activityStatus: "retired", narrative: "Jocelyne jardine." });
    expect(codes(say("Mes collègues me trouveraient ridicule."), retired)).toEqual(["invented_job_status"]);
    expect(codes(say("Mes anciens collègues, peut-être."), retired)).toEqual([]);
    expect(codes(say("Je suis à la retraite, laissez-moi tranquille."), noKids)).toEqual(["invented_job_status"]);
    expect(codes(say("Je suis à la retraite, laissez-moi tranquille."), retired)).toEqual([]);
  });

  it("lit tous les champs texte de la réponse", () => {
    const a = answer({ objections: [{ category: "effort_time", detail: "Mon fils me prend tout mon temps." }] });
    expect(codes(a, noKids)).toEqual(["invented_child"]);
  });
});
