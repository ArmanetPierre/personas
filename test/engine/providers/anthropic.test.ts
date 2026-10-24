import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../../src/config";
import { createBackendFromProfile, Engine, ProviderAuthError, ProviderError, ProviderKeyMissingError, ProviderRateLimitError } from "../../../src/engine";
import { ANTHROPIC_TOOL_NAME, ANTHROPIC_VERSION } from "../../../src/engine/backends/anthropic";
import { memoryStore } from "../../../src/engine/secrets";
import { isUsageLimitError } from "../../../src/studies/run";
import { conceptPriceV3, FAKE_KEY, jsonSchemaOf, narratives, noSleep, startFakeServer, validV3Answer, type FakeServer } from "./fake-server";

let server: FakeServer;
beforeEach(async () => (server = await startFakeServer()));
afterEach(() => server.close());

const config = loadConfig({});
const backend = (key: string | undefined = FAKE_KEY) =>
  createBackendFromProfile({ name: "mon-anthropic", provider: "anthropic", model: "claude-test", baseUrl: server.url, concurrency: 3 }, config, {
    secrets: memoryStore(key ? { "mon-anthropic": key } : {}),
    sleep: noSleep,
    env: {},
  });

const toolReply = (input: unknown, usage = { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 }) => ({
  body: { model: "claude-test-20260101", stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: ANTHROPIC_TOOL_NAME, input }], usage },
});

describe("fournisseur anthropic (Messages API, outil unique forcé)", () => {
  it("déclare ses capacités", () => {
    expect(backend().capabilities).toEqual({ structured: "tool-call", webTools: false, logprobs: false });
    expect(backend().concurrency).toBe(3);
  });

  it("construit la requête : en-têtes, outil forcé dont input_schema = schéma concept-price v3", async () => {
    server.reply(toolReply(validV3Answer));
    const engine = new Engine(backend());
    const res = await engine.complete({ system: "SYS", messages: [{ role: "user", content: "Q" }], schema: conceptPriceV3, temperature: 0.7, maxTokens: 1500 });
    const req = server.requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/v1/messages");
    expect(req.headers["x-api-key"]).toBe(FAKE_KEY);
    expect(req.headers["anthropic-version"]).toBe(ANTHROPIC_VERSION);
    expect(req.headers.authorization).toBeUndefined();
    const { $schema: _s, ...expected } = jsonSchemaOf(conceptPriceV3);
    expect(req.body).toEqual({
      model: "claude-test",
      max_tokens: 1500,
      system: "SYS",
      temperature: 0.7,
      messages: [{ role: "user", content: "Q" }],
      tools: [{ name: ANTHROPIC_TOOL_NAME, description: expect.any(String), input_schema: expected }],
      tool_choice: { type: "tool", name: ANTHROPIC_TOOL_NAME },
    });
    expect(res.data).toEqual(validV3Answer);
    expect(res.backend).toBe("anthropic");
    expect(res.model).toBe("claude-test-20260101");
    expect(res.usage).toEqual({ inputTokens: 125, outputTokens: 40, cacheReadTokens: 20, cacheWriteTokens: 5 });
  });

  it("sans schéma : texte seul, pas d'outil, max_tokens par défaut", async () => {
    server.reply({ body: { content: [{ type: "text", text: "Bonjour" }], usage: { input_tokens: 3, output_tokens: 1 } } });
    const res = await new Engine(backend()).complete({ system: "S", messages: [{ role: "user", content: "Q" }] });
    expect(res.text).toBe("Bonjour");
    expect(server.requests[0]!.body.tools).toBeUndefined();
    expect(server.requests[0]!.body.max_tokens).toBe(8192);
  });

  it("répare une réponse invalide (récits) : second tour avec la consigne de réparation", async () => {
    server.reply(toolReply({ items: [] }), toolReply({ items: [{ id: "p1", narrative: "Récit." }] }));
    const res = await new Engine(backend()).complete({ system: "S", messages: [{ role: "user", content: "Q" }], schema: narratives });
    expect(res.attempts).toBe(2);
    expect(res.data.items[0]!.id).toBe("p1");
    const second = server.requests[1]!.body;
    expect(second.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(second.messages[1].content).toBe('{"items":[]}');
    expect(second.messages[2].content).toContain("Ta réponse précédente est invalide.");
    expect(res.usage.inputTokens).toBe(250);
  });

  it("401 : erreur de clé typée, clé masquée même si le serveur la renvoie", async () => {
    server.reply({ status: 401, body: { type: "error", error: { type: "authentication_error", message: `invalid x-api-key: ${FAKE_KEY}` } } });
    const err = await backend().generate({ system: "S", messages: [{ role: "user", content: "Q" }] }).then(() => new Error("aucune erreur"), (e: unknown) => e as Error);
    expect(err).toBeInstanceOf(ProviderAuthError);
    expect(err.message).toContain("HTTP 401");
    expect(err.message).toContain("engine:key -- set --profile mon-anthropic");
    expect(err.message).not.toContain(FAKE_KEY);
    expect(String(err.stack)).not.toContain(FAKE_KEY);
  });

  it("429 : limite de débit typée, traitée comme la limite d'usage Max (étude en pause)", async () => {
    server.reply({ status: 429, headers: { "retry-after": "30" }, body: { error: { type: "rate_limit_error", message: "Number of requests exceeded" } } });
    const err = await backend().generate({ system: "S", messages: [{ role: "user", content: "Q" }] }).then(() => new Error("aucune erreur"), (e: unknown) => e as Error);
    expect(err).toBeInstanceOf(ProviderRateLimitError);
    expect((err as ProviderRateLimitError).retryAfterSeconds).toBe(30);
    expect(isUsageLimitError(err)).toBe(true);
    expect(server.requests).toHaveLength(1); // pas de réessai
  });

  it("5xx : réessais bornés, puis succès", async () => {
    server.reply({ status: 529, body: { error: { type: "overloaded_error", message: "Overloaded" } } }, { status: 500, body: {} }, toolReply(validV3Answer));
    const res = await backend().generate({ system: "S", messages: [{ role: "user", content: "Q" }], jsonSchema: jsonSchemaOf(conceptPriceV3) });
    expect(server.requests).toHaveLength(3);
    expect(res.structured).toEqual(validV3Answer);
  });

  it("5xx persistante : échec après 3 tentatives", async () => {
    server.reply({ status: 503, body: { error: { message: "unavailable" } } });
    const err = await backend().generate({ system: "S", messages: [{ role: "user", content: "Q" }] }).then(() => new Error("aucune erreur"), (e: unknown) => e as Error);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toMatch(/HTTP 503 .* après 3 tentative/);
    expect(server.requests).toHaveLength(3);
  });

  it("sans clé : erreur explicite, aucun appel", async () => {
    const err = await backend("").generate({ system: "S", messages: [{ role: "user", content: "Q" }] }).then(() => new Error("aucune erreur"), (e: unknown) => e as Error);
    expect(err).toBeInstanceOf(ProviderKeyMissingError);
    expect(server.requests).toHaveLength(0);
  });

  it("disponibilité : fiche du modèle (point d'accès gratuit), aucune génération", async () => {
    server.reply({ body: { id: "claude-test", type: "model" } });
    const a = await backend().checkAvailability();
    expect(a.ok).toBe(true);
    expect(server.requests[0]!.method).toBe("GET");
    expect(server.requests[0]!.path).toBe("/v1/models/claude-test");
  });
});
