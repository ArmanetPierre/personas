import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, OLLAMA_MAX_CONCURRENCY } from "../../../src/config";
import { createBackendFromProfile, Engine } from "../../../src/engine";
import { memoryStore } from "../../../src/engine/secrets";
import { conceptPriceV3, FAKE_KEY, narratives, noSleep, startFakeServer, validV3Answer, type FakeServer } from "./fake-server";

let server: FakeServer;
beforeEach(async () => (server = await startFakeServer()));
afterEach(() => server.close());

const config = loadConfig({});
const backend = (opts: { key?: string; concurrency?: number; baseUrl?: string } = {}) =>
  createBackendFromProfile(
    { name: "local", provider: "openai-compatible", model: "qwen-local", baseUrl: opts.baseUrl ?? `${server.url}/v1`, ...(opts.concurrency && { concurrency: opts.concurrency }) },
    config,
    { secrets: memoryStore(opts.key ? { local: opts.key } : {}), sleep: noSleep, env: {} },
  );

const completion = (content: string) => ({ body: { model: "qwen-local", choices: [{ message: { content } }], usage: { prompt_tokens: 40, completion_tokens: 12 } } });

describe("fournisseur openai-compatible (vLLM, LM Studio, Ollama /v1)", () => {
  it("sans clé : aucun en-tête Authorization ; json_schema strict, max_tokens", async () => {
    server.reply(completion(JSON.stringify(validV3Answer)));
    const res = await new Engine(backend()).complete({ system: "S", messages: [{ role: "user", content: "Q" }], schema: conceptPriceV3, maxTokens: 300 });
    const req = server.requests[0]!;
    expect(req.path).toBe("/v1/chat/completions");
    expect(req.headers.authorization).toBeUndefined();
    expect(req.body.response_format.type).toBe("json_schema");
    expect(req.body.max_tokens).toBe(300);
    expect(res.data).toEqual(validV3Answer);
    expect(res.backend).toBe("openai-compatible");
  });

  it("avec une clé facultative : Bearer", async () => {
    server.reply(completion("ok"));
    await backend({ key: FAKE_KEY }).generate({ system: "S", messages: [{ role: "user", content: "Q" }] });
    expect(server.requests[0]!.headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
  });

  it("serveur qui refuse json_schema (400) : repli sur le mode JSON, retenu pour la suite", async () => {
    server.reply(
      { status: 400, body: { error: { message: "response_format type json_schema is not supported" } } },
      completion('{"items":[{"id":"p1","narrative":"R."}]}'),
      completion('{"items":[{"id":"p2","narrative":"R."}]}'),
    );
    const b = backend();
    const engine = new Engine(b);
    const r1 = await engine.complete({ system: "S", messages: [{ role: "user", content: "Q" }], schema: narratives });
    expect(r1.data.items[0]!.id).toBe("p1");
    expect(server.requests.map((r) => r.body.response_format.type)).toEqual(["json_schema", "json_object"]);
    expect(b.capabilities?.structured).toBe("json-mode");
    await engine.complete({ system: "S", messages: [{ role: "user", content: "Q" }], schema: narratives });
    expect(server.requests[2]!.body.response_format.type).toBe("json_object");
  });

  it("disponibilité : modèle présent dans /models", async () => {
    server.replyOnly({ body: { object: "list", data: [{ id: "qwen-local" }, { id: "autre" }] } });
    expect(await backend().checkAvailability()).toMatchObject({ ok: true });
    server.replyOnly({ body: { data: [{ id: "autre" }] } });
    expect(await backend().checkAvailability()).toMatchObject({ ok: false });
  });

  it("serveur injoignable : erreur réseau après réessais bornés", async () => {
    const b = backend({ baseUrl: "http://127.0.0.1:9/v1", key: FAKE_KEY });
    const err = await b.generate({ system: "S", messages: [{ role: "user", content: "Q" }] }).then(() => new Error("aucune erreur"), (e: unknown) => e as Error);
    expect(err.message).toMatch(/échoué .* après 3 tentative/);
    expect(err.message).not.toContain(FAKE_KEY);
  });

  it("URL de base exigée", () => {
    expect(() => createBackendFromProfile({ name: "x", provider: "openai-compatible", model: "m" }, config)).toThrow(/URL de base requise/);
  });

  it("serveur Ollama joint par /v1 : plafond de concurrence d'Ollama", () => {
    expect(backend({ baseUrl: "http://localhost:11434/v1", concurrency: 8 }).concurrency).toBe(OLLAMA_MAX_CONCURRENCY);
    const viaTunnel = loadConfig({ OLLAMA_BASE_URL: "http://localhost:23456" });
    const b = createBackendFromProfile({ name: "t", provider: "openai-compatible", model: "m", baseUrl: "http://localhost:23456/v1", concurrency: 6 }, viaTunnel);
    expect(b.concurrency).toBe(OLLAMA_MAX_CONCURRENCY);
    expect(backend({ concurrency: 6 }).concurrency).toBe(6);
  });
});
