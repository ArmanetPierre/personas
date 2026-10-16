import { describe, expect, it } from "vitest";
import { OllamaBackend } from "../../src/engine/backends/ollama";

function backendWith(fetchImpl: typeof fetch, concurrency = 2) {
  return new OllamaBackend({
    baseUrl: "http://localhost:11434",
    model: "qwen3:8b",
    numCtx: 32768,
    concurrency,
    timeoutMs: 1000,
    fetch: fetchImpl,
  });
}

describe("OllamaBackend", () => {
  it("plafonne la concurrence à 2", () => {
    expect(backendWith(fetch, 8).concurrency).toBe(2);
    expect(backendWith(fetch, 1).concurrency).toBe(1);
  });

  it("envoie think:false, format et num_ctx à /api/chat", async () => {
    let captured: { url: string; body: Record<string, unknown> } | undefined;
    const fake = (async (url: string, init: RequestInit) => {
      captured = { url, body: JSON.parse(init.body as string) };
      return new Response(
        JSON.stringify({ model: "qwen3:8b", message: { content: '{"ok":true}' }, prompt_eval_count: 50, eval_count: 7 }),
      );
    }) as unknown as typeof fetch;
    const schema = { type: "object" };
    const r = await backendWith(fake).generate({
      system: "sys",
      messages: [{ role: "user", content: "q" }],
      jsonSchema: schema,
      temperature: 0.5,
      maxTokens: 100,
    });
    expect(captured?.url).toBe("http://localhost:11434/api/chat");
    expect(captured?.body).toMatchObject({
      stream: true,
      think: false,
      format: schema,
      options: { num_ctx: 32768, temperature: 0.5, num_predict: 100 },
    });
    expect((captured?.body.messages as unknown[])[0]).toEqual({ role: "system", content: "sys" });
    expect(r.usage).toEqual({ inputTokens: 50, outputTokens: 7, costUsd: 0 });
  });

  it("assemble une réponse en streaming (NDJSON)", async () => {
    const lines = [
      { model: "m", message: { content: '{"ok":' }, done: false },
      { model: "m", message: { content: "true}" }, done: false },
      { model: "m", message: { content: "" }, done: true, prompt_eval_count: 12, eval_count: 3 },
    ];
    const fake = (async () => new Response(lines.map((l) => JSON.stringify(l)).join("\n") + "\n")) as unknown as typeof fetch;
    const r = await backendWith(fake).generate({ system: "s", messages: [{ role: "user", content: "q" }] });
    expect(r.text).toBe('{"ok":true}');
    expect(r.usage).toEqual({ inputTokens: 12, outputTokens: 3, costUsd: 0 });
  });

  it("indique la commande du tunnel quand le serveur est injoignable", async () => {
    const refused = (async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    }) as unknown as typeof fetch;
    const a = await backendWith(refused).checkAvailability();
    expect(a.ok).toBe(false);
    expect(a.detail).toContain("ECONNREFUSED");
    expect(a.hint).toContain("ollama serve");
  });
});
