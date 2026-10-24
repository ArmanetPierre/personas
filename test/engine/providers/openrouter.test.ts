import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../../src/config";
import { createBackendFromProfile, Engine, ProviderAuthError, ProviderRateLimitError } from "../../../src/engine";
import { toOpenAiStrictSchema } from "../../../src/engine/backends/schema-adapt";
import { memoryStore } from "../../../src/engine/secrets";
import { isUsageLimitError } from "../../../src/studies/run";
import { conceptPriceV3, FAKE_KEY, jsonSchemaOf, noSleep, startFakeServer, validV3Answer, type FakeServer } from "./fake-server";

let server: FakeServer;
beforeEach(async () => (server = await startFakeServer()));
afterEach(() => server.close());

const config = loadConfig({});
const backend = () =>
  createBackendFromProfile({ name: "mon-or", provider: "openrouter", model: "vendor/model-test", baseUrl: `${server.url}/api/v1` }, config, {
    secrets: memoryStore({ "mon-or": FAKE_KEY }),
    sleep: noSleep,
    env: {},
  });

const completion = (content: string) => ({
  body: { model: "vendor/model-test", choices: [{ message: { content } }], usage: { prompt_tokens: 50, completion_tokens: 10, cost: 0.00042 } },
});

describe("fournisseur openrouter (API compatible OpenAI, response_format relayé)", () => {
  it("construit la requête : Bearer, x-title, require_parameters, usage.include, max_tokens", async () => {
    server.reply(completion(JSON.stringify(validV3Answer)));
    const res = await new Engine(backend()).complete({ system: "SYS", messages: [{ role: "user", content: "Q" }], schema: conceptPriceV3, maxTokens: 500 });
    const req = server.requests[0]!;
    expect(req.path).toBe("/api/v1/chat/completions");
    expect(req.headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(req.headers["x-title"]).toBe("Personas");
    expect(req.body).toMatchObject({
      model: "vendor/model-test",
      max_tokens: 500,
      usage: { include: true },
      provider: { require_parameters: true },
      response_format: { type: "json_schema", json_schema: { strict: true, schema: toOpenAiStrictSchema(jsonSchemaOf(conceptPriceV3)) } },
    });
    expect(req.body).not.toHaveProperty("max_completion_tokens");
    expect(res.data).toEqual(validV3Answer);
    expect(res.usage).toEqual({ inputTokens: 50, outputTokens: 10, costUsd: 0.00042 });
    expect(res.backend).toBe("openrouter");
  });

  it("capacité lue dans le catalogue : modèle sans structured_outputs → mode JSON", async () => {
    server.reply(
      { body: { data: [{ id: "vendor/model-test", supported_parameters: ["temperature", "response_format"] }] } },
      { body: { data: { label: "clé" } } },
      completion(JSON.stringify(validV3Answer)),
    );
    const b = backend();
    const a = await b.checkAvailability();
    expect(a.ok).toBe(true);
    expect(server.requests.map((r) => r.path)).toEqual(["/api/v1/models", "/api/v1/key"]);
    expect(b.capabilities?.structured).toBe("json-mode");
    const res = await new Engine(b).complete({ system: "SYS", messages: [{ role: "user", content: "Q" }], schema: conceptPriceV3 });
    const body = server.requests[2]!.body;
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[0].content).toContain("Réponds uniquement par un objet JSON");
    expect(res.data).toEqual(validV3Answer);
  });

  it("modèle absent du catalogue : indisponible", async () => {
    server.reply({ body: { data: [{ id: "autre/modele" }] } });
    const a = await backend().checkAvailability();
    expect(a.ok).toBe(false);
    expect(a.detail).toContain("absent du catalogue");
  });

  it("401 et 429 : erreurs typées, clé masquée", async () => {
    server.replyOnly({ status: 401, body: { error: { message: `No auth credentials found for Bearer ${FAKE_KEY}`, code: 401 } } });
    const auth = await backend().generate({ system: "S", messages: [{ role: "user", content: "Q" }] }).then(() => new Error("aucune erreur"), (e: unknown) => e as Error);
    expect(auth).toBeInstanceOf(ProviderAuthError);
    expect(auth.message).not.toContain(FAKE_KEY);
    server.replyOnly({ status: 429, body: { error: { message: "Rate limit exceeded: free-models-per-day", code: 429 } } });
    const limit = await backend().generate({ system: "S", messages: [{ role: "user", content: "Q" }] }).then(() => new Error("aucune erreur"), (e: unknown) => e as Error);
    expect(limit).toBeInstanceOf(ProviderRateLimitError);
    expect(isUsageLimitError(limit)).toBe(true);
  });
});
