import { describe, expect, it } from "vitest";
import { z } from "zod";
import { extractJson, JsonExtractionError, parseWithSchema } from "../../src/engine/json";

describe("extractJson", () => {
  it("lit un JSON nu", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("lit un bloc ```json```", () => {
    expect(extractJson('Voici :\n```json\n{"a": [1, 2]}\n```\nVoilà.')).toEqual({ a: [1, 2] });
  });

  it("trouve un objet entouré de prose, accolades dans les chaînes comprises", () => {
    const text = 'Bien sûr ! {"reason": "trop cher {vraiment}", "ok": false} Bonne journée.';
    expect(extractJson(text)).toEqual({ reason: "trop cher {vraiment}", ok: false });
  });

  it("ignore un faux départ avant le vrai JSON", () => {
    expect(extractJson('Note {pas du json} puis {"x": true}')).toEqual({ x: true });
  });

  it("lève sur une réponse sans JSON", () => {
    expect(() => extractJson("Je ne sais pas.")).toThrow(JsonExtractionError);
    expect(() => extractJson("   ")).toThrow(JsonExtractionError);
  });
});

describe("parseWithSchema", () => {
  const schema = z.object({ wouldPay: z.boolean() });

  it("préfère la sortie structurée native du backend", () => {
    const r = parseWithSchema({ text: "ignoré", structured: { wouldPay: true } }, schema);
    expect(r).toEqual({ ok: true, data: { wouldPay: true } });
  });

  it("explique les champs invalides", () => {
    const r = parseWithSchema({ text: '{"wouldPay": "oui"}' }, schema);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("wouldPay");
  });
});
