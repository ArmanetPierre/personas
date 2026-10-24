import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { loadConfig } from "../../../src/config";
import { createBackendFromProfile, Engine, ProviderAuthError, ProviderError, ProviderRateLimitError } from "../../../src/engine";
import { OPENAI_SCHEMA_NAME } from "../../../src/engine/backends/openai";
import { normalizeNulls, SchemaAdaptError, toOpenAiStrictSchema } from "../../../src/engine/backends/schema-adapt";
import { memoryStore } from "../../../src/engine/secrets";
import { isUsageLimitError } from "../../../src/studies/run";
import {
  conceptPriceV3,
  FAKE_KEY,
  jsonSchemaOf,
  noSleep,
  research,
  researchWithNulls,
  startFakeServer,
  targetSuggestion,
  validV3Answer,
  type FakeServer,
} from "./fake-server";

let server: FakeServer;
beforeEach(async () => (server = await startFakeServer()));
afterEach(() => server.close());

const config = loadConfig({});
const backend = () =>
  createBackendFromProfile({ name: "mon-openai", provider: "openai", model: "gpt-test", baseUrl: `${server.url}/v1` }, config, {
    secrets: memoryStore({ "mon-openai": FAKE_KEY }),
    sleep: noSleep,
    env: {},
  });

const completion = (content: string, usage: Record<string, unknown> = { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 64 } }) => ({
  body: { model: "gpt-test-2026", choices: [{ finish_reason: "stop", message: { role: "assistant", content } }], usage },
});

/** Vérifie récursivement les règles du mode strict. */
function assertStrict(node: unknown, path = "$"): void {
  if (Array.isArray(node)) return node.forEach((n, i) => assertStrict(n, `${path}[${i}]`));
  if (typeof node !== "object" || node === null) return;
  const o = node as Record<string, unknown>;
  for (const k of ["$schema", "default", "minLength", "maxLength", "propertyNames"]) expect(o, `${path} : ${k}`).not.toHaveProperty(k);
  if (o.type === "object" || o.properties) {
    expect(o.additionalProperties, `${path}.additionalProperties`).toBe(false);
    expect([...(o.required as string[])].sort(), `${path}.required`).toEqual(Object.keys(o.properties as object).sort());
  }
  for (const v of Object.values(o)) assertStrict(v, path);
}

describe("transformation du schéma pour le mode strict", () => {
  it("concept-price v3 : tout requis, additionalProperties false, sans minLength ni $schema", () => {
    const s = toOpenAiStrictSchema(jsonSchemaOf(conceptPriceV3));
    assertStrict(s);
    const vw = (s.properties as any).vanWestendorp.properties.tooCheapEur;
    expect(vw.anyOf).toEqual([{ type: "number", minimum: 0 }, { type: "null" }]);
  });

  it("assistant de cible : valeurs par défaut retirées", () => {
    const s = toOpenAiStrictSchema(jsonSchemaOf(targetSuggestion));
    assertStrict(s);
    expect(JSON.stringify(s)).not.toContain('"default"');
  });

  it("assistant de modules : champs facultatifs en union avec null, bornes entières vides retirées", () => {
    const s = toOpenAiStrictSchema(jsonSchemaOf(research)) as any;
    assertStrict(s);
    const attr = s.properties.attributes.items.properties;
    expect(attr.values).toEqual({ type: ["array", "null"], items: { type: "string" } });
    expect(attr.justification).toEqual({ type: ["string", "null"] });
    expect(s.properties.sources.items.properties.year).toEqual({ type: "integer" });
  });

  it("dictionnaire libre : la transformation échoue (repli JSON)", () => {
    expect(() => toOpenAiStrictSchema(jsonSchemaOf(z.object({ r: z.record(z.string(), z.number()) })))).toThrow(SchemaAdaptError);
  });

  it("normalise les null des facultatifs avant zod, garde ceux du schéma d'origine", () => {
    const js = jsonSchemaOf(research);
    const out = normalizeNulls(structuredClone(researchWithNulls), js) as any;
    expect(out.attributes[0]).not.toHaveProperty("values");
    expect(out.attributes[0]).not.toHaveProperty("justification");
    expect(out.attributes[0].figures[0].source_key).toBeNull();
    expect(research.safeParse(out).success).toBe(true);
    expect(research.safeParse(researchWithNulls).success).toBe(false);
  });
});

describe("fournisseur openai (Chat Completions, response_format json_schema strict)", () => {
  it("déclare ses capacités", () => {
    expect(backend().capabilities).toEqual({ structured: "json-schema", webTools: false, logprobs: true });
  });

  it("construit la requête : Bearer, json_schema strict transformé, max_completion_tokens", async () => {
    server.reply(completion(JSON.stringify(validV3Answer)));
    const res = await new Engine(backend()).complete({ system: "SYS", messages: [{ role: "user", content: "Q" }], schema: conceptPriceV3, temperature: 0.7, maxTokens: 900 });
    const req = server.requests[0]!;
    expect(req.path).toBe("/v1/chat/completions");
    expect(req.headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(req.body).toEqual({
      model: "gpt-test",
      messages: [{ role: "system", content: "SYS" }, { role: "user", content: "Q" }],
      temperature: 0.7,
      max_completion_tokens: 900,
      response_format: { type: "json_schema", json_schema: { name: OPENAI_SCHEMA_NAME, strict: true, schema: toOpenAiStrictSchema(jsonSchemaOf(conceptPriceV3)) } },
    });
    expect(res.data).toEqual(validV3Answer);
    expect(res.usage).toEqual({ inputTokens: 120, outputTokens: 30, cacheReadTokens: 64 });
    expect(res.model).toBe("gpt-test-2026");
    expect(res.backend).toBe("openai");
  });

  it("réponse avec null sur les facultatifs : normalisée, validée par zod du premier coup", async () => {
    server.reply(completion(JSON.stringify(researchWithNulls)));
    const res = await new Engine(backend()).complete({ system: "S", messages: [{ role: "user", content: "Q" }], schema: research });
    expect(res.attempts).toBe(1);
    expect(res.data.attributes[0]).not.toHaveProperty("values");
  });

  it("schéma non exprimable : repli sur le mode JSON, schéma donné dans la consigne", async () => {
    const schema = z.object({ counts: z.record(z.string(), z.number()) });
    server.reply(completion('{"counts":{"a":1}}'));
    const res = await new Engine(backend()).complete({ system: "SYS", messages: [{ role: "user", content: "Q" }], schema });
    const body = server.requests[0]!.body;
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[0].content).toContain("SYS\n\nRéponds uniquement par un objet JSON");
    expect(body.messages[0].content).toContain('"additionalProperties":{"type":"number"}');
    expect(res.data).toEqual({ counts: { a: 1 } });
  });

  it("réparation : JSON invalide puis valide", async () => {
    server.reply(completion('{"items": "pas un tableau"}'), completion('{"items":[{"id":"p1","narrative":"Récit."}]}'));
    const { narratives } = await import("./fake-server");
    const res = await new Engine(backend()).complete({ system: "S", messages: [{ role: "user", content: "Q" }], schema: narratives });
    expect(res.attempts).toBe(2);
    expect(server.requests[1]!.body.messages.at(-1).content).toContain("Ta réponse précédente est invalide.");
  });

  it("refus du modèle : erreur explicite", async () => {
    server.reply({ body: { choices: [{ message: { content: null, refusal: "I can't help with that." } }] } });
    await expect(backend().generate({ system: "S", messages: [{ role: "user", content: "Q" }] })).rejects.toThrow(/refusé de répondre/);
  });

  it("401 / 429 / 5xx : erreurs typées, clé jamais affichée", async () => {
    server.reply({ status: 401, body: { error: { message: `Incorrect API key provided: ${FAKE_KEY.slice(0, 6)}********cdef. You can find your API key at …`, type: "invalid_request_error" } } });
    const auth = await backend().generate({ system: "S", messages: [{ role: "user", content: "Q" }] }).then(() => new Error("aucune erreur"), (e: unknown) => e as Error);
    expect(auth).toBeInstanceOf(ProviderAuthError);
    expect(auth.message).not.toContain(FAKE_KEY.slice(0, 6));
    expect(auth.message).not.toContain("cdef");

    server.replyOnly({ status: 429, body: { error: { message: "You exceeded your current quota", type: "insufficient_quota" } } });
    const limit = await backend().generate({ system: "S", messages: [{ role: "user", content: "Q" }] }).then(() => new Error("aucune erreur"), (e: unknown) => e as Error);
    expect(limit).toBeInstanceOf(ProviderRateLimitError);
    expect(isUsageLimitError(limit)).toBe(true);

    server.replyOnly({ status: 502, body: "<html>bad gateway</html>" }, { status: 502, body: "x" }, { status: 502, body: "x" });
    const down = await backend().generate({ system: "S", messages: [{ role: "user", content: "Q" }] }).then(() => new Error("aucune erreur"), (e: unknown) => e as Error);
    expect(down).toBeInstanceOf(ProviderError);
    expect(down.message).toContain("HTTP 502");
  });

  it("disponibilité : GET /models/<modèle>", async () => {
    server.reply({ body: { id: "gpt-test", object: "model" } });
    expect((await backend().checkAvailability()).ok).toBe(true);
    expect(server.requests[0]!.path).toBe("/v1/models/gpt-test");
  });
});
