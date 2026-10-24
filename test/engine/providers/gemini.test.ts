import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { loadConfig } from "../../../src/config";
import { createBackendFromProfile, Engine, ProviderAuthError, ProviderError, ProviderRateLimitError } from "../../../src/engine";
import { SchemaAdaptError, toGeminiSchema } from "../../../src/engine/backends/schema-adapt";
import { memoryStore } from "../../../src/engine/secrets";
import { isUsageLimitError } from "../../../src/studies/run";
import { conceptPriceV3, FAKE_KEY, jsonSchemaOf, narratives, noSleep, research, startFakeServer, targetSuggestion, validV3Answer, type FakeServer } from "./fake-server";

let server: FakeServer;
beforeEach(async () => (server = await startFakeServer()));
afterEach(() => server.close());

const config = loadConfig({});
const backend = () =>
  createBackendFromProfile({ name: "mon-gemini", provider: "gemini", model: "gemini-test", baseUrl: `${server.url}/v1beta` }, config, {
    secrets: memoryStore({ "mon-gemini": FAKE_KEY }),
    sleep: noSleep,
    env: {},
  });

const reply = (text: string, usage = { promptTokenCount: 80, candidatesTokenCount: 20, thoughtsTokenCount: 5, cachedContentTokenCount: 10 }) => ({
  body: { modelVersion: "gemini-test-001", candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text }] } }], usageMetadata: usage },
});

describe("conversion du schéma de réponse Gemini", () => {
  it("concept-price v3 : types en capitales, nullable, énumérations, ordre des propriétés", () => {
    const s = toGeminiSchema(jsonSchemaOf(conceptPriceV3)) as any;
    expect(s.type).toBe("OBJECT");
    expect(s.propertyOrdering[0]).toBe("needFrequency");
    expect(s.properties.needFrequency).toEqual({ type: "STRING", enum: ["never", "rarely", "few_per_year", "monthly", "weekly", "daily"] });
    expect(s.properties.vanWestendorp.properties.tooCheapEur).toEqual({ type: "NUMBER", minimum: 0, nullable: true });
    expect(s.properties.alternatives).toEqual({ type: "ARRAY", items: { type: "STRING" }, maxItems: 5 });
    expect(JSON.stringify(s)).not.toMatch(/"\$schema"|additionalProperties|"anyOf"/);
  });

  it("récits, assistant de cible et de modules : convertibles (défauts retirés, facultatifs non requis)", () => {
    expect(toGeminiSchema(jsonSchemaOf(narratives))).toMatchObject({ type: "OBJECT", required: ["items"] });
    expect(JSON.stringify(toGeminiSchema(jsonSchemaOf(targetSuggestion)))).not.toContain("default");
    const r = toGeminiSchema(jsonSchemaOf(research)) as any;
    expect(r.properties.attributes.items.required).not.toContain("values");
    expect(r.properties.attributes.items.properties.figures.items.properties.source_key).toEqual({ type: "STRING", nullable: true });
  });

  it("dictionnaire libre : conversion refusée", () => {
    expect(() => toGeminiSchema(jsonSchemaOf(z.object({ r: z.record(z.string(), z.number()) })))).toThrow(SchemaAdaptError);
  });
});

describe("fournisseur gemini (generateContent, responseSchema)", () => {
  it("déclare ses capacités", () => {
    expect(backend().capabilities).toEqual({ structured: "json-schema-subset", webTools: false, logprobs: false });
  });

  it("construit la requête : clé en en-tête (jamais dans l'URL), schéma converti, rôles user/model", async () => {
    server.reply(reply("{}"), reply(JSON.stringify(validV3Answer)));
    const res = await new Engine(backend()).complete({ system: "SYS", messages: [{ role: "user", content: "Q" }], schema: conceptPriceV3, temperature: 0.4, maxTokens: 700 });
    const req = server.requests[0]!;
    expect(req.path).toBe("/v1beta/models/gemini-test:generateContent");
    expect(req.path).not.toContain(FAKE_KEY);
    expect(req.headers["x-goog-api-key"]).toBe(FAKE_KEY);
    expect(req.body).toEqual({
      systemInstruction: { parts: [{ text: "SYS" }] },
      contents: [{ role: "user", parts: [{ text: "Q" }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 700, responseMimeType: "application/json", responseSchema: toGeminiSchema(jsonSchemaOf(conceptPriceV3)) },
    });
    // Réparation : la réponse invalide revient avec le rôle « model »
    expect(res.attempts).toBe(2);
    expect(server.requests[1]!.body.contents.map((c: { role: string }) => c.role)).toEqual(["user", "model", "user"]);
    expect(res.data).toEqual(validV3Answer);
    expect(res.model).toBe("gemini-test-001");
    expect(res.usage).toEqual({ inputTokens: 160, outputTokens: 50, cacheReadTokens: 20 });
  });

  it("schéma non convertible : mode JSON seul, schéma dans la consigne", async () => {
    server.reply(reply('{"r":{"a":1}}'));
    const res = await new Engine(backend()).complete({ system: "SYS", messages: [{ role: "user", content: "Q" }], schema: z.object({ r: z.record(z.string(), z.number()) }) });
    const body = server.requests[0]!.body;
    expect(body.generationConfig).toEqual({ responseMimeType: "application/json" });
    expect(body.systemInstruction.parts[0].text).toContain("Réponds uniquement par un objet JSON");
    expect(res.data).toEqual({ r: { a: 1 } });
  });

  it("réponse bloquée : erreur explicite", async () => {
    server.reply({ body: { promptFeedback: { blockReason: "SAFETY" } } });
    await expect(backend().generate({ system: "S", messages: [{ role: "user", content: "Q" }] })).rejects.toThrow(/bloquée/);
  });

  it("401 / 429 / 503 : erreurs typées, clé masquée", async () => {
    server.replyOnly({ status: 403, body: { error: { code: 403, message: `API key not valid: ${FAKE_KEY}`, status: "PERMISSION_DENIED" } } });
    const auth = await backend().generate({ system: "S", messages: [{ role: "user", content: "Q" }] }).then(() => new Error("aucune erreur"), (e: unknown) => e as Error);
    expect(auth).toBeInstanceOf(ProviderAuthError);
    expect(auth.message).not.toContain(FAKE_KEY);

    server.replyOnly({ status: 429, body: { error: { code: 429, message: "Resource has been exhausted (e.g. check quota).", status: "RESOURCE_EXHAUSTED" } } });
    const limit = await backend().generate({ system: "S", messages: [{ role: "user", content: "Q" }] }).then(() => new Error("aucune erreur"), (e: unknown) => e as Error);
    expect(limit).toBeInstanceOf(ProviderRateLimitError);
    expect(isUsageLimitError(limit)).toBe(true);

    server.replyOnly({ status: 503, body: { error: { message: "The model is overloaded." } } }, reply("ok"));
    const ok = await backend().generate({ system: "S", messages: [{ role: "user", content: "Q" }] });
    expect(ok.text).toBe("ok");
    server.replyOnly({ status: 500, body: {} });
    await expect(backend().generate({ system: "S", messages: [{ role: "user", content: "Q" }] })).rejects.toBeInstanceOf(ProviderError);
  });

  it("disponibilité : GET de la fiche du modèle", async () => {
    server.reply({ body: { name: "models/gemini-test" } });
    expect((await backend().checkAvailability()).ok).toBe(true);
    expect(server.requests[0]!.path).toBe("/v1beta/models/gemini-test");
  });
});
