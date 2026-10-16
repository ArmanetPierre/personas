import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Engine, SchemaValidationError } from "../../src/engine/engine";
import type { Backend, BackendRequest, BackendResponse } from "../../src/engine/types";

/** Backend simulé : renvoie les réponses prévues dans l'ordre et garde les requêtes. */
function fakeBackend(replies: Array<Partial<BackendResponse>>, concurrency = 2) {
  const requests: BackendRequest[] = [];
  let i = 0;
  const backend: Backend = {
    name: "ollama",
    model: "fake-model",
    concurrency,
    async checkAvailability() {
      return { ok: true, detail: "simulé" };
    },
    async generate(req) {
      requests.push(structuredClone(req));
      const r = replies[Math.min(i++, replies.length - 1)] ?? {};
      return { text: "", model: "fake-model", usage: { inputTokens: 10, outputTokens: 5 }, ...r };
    },
  };
  return { backend, requests };
}

const schema = z.object({ persona: z.string(), wouldPay: z.boolean(), reason: z.string() });
const valid = '{"persona":"Léa, 19 ans","wouldPay":false,"reason":"Budget serré"}';
const base = { system: "sys", messages: [{ role: "user" as const, content: "question" }] };

describe("Engine.complete", () => {
  it("valide une réponse correcte du premier coup et transmet le JSON Schema", async () => {
    const { backend, requests } = fakeBackend([{ text: valid }]);
    const res = await new Engine(backend).complete({ ...base, schema });
    expect(res.data).toEqual({ persona: "Léa, 19 ans", wouldPay: false, reason: "Budget serré" });
    expect(res.attempts).toBe(1);
    expect(res.backend).toBe("ollama");
    expect(requests[0]?.jsonSchema).toMatchObject({ type: "object", required: ["persona", "wouldPay", "reason"] });
  });

  it("répare une réponse invalide en renvoyant l'erreur au modèle", async () => {
    const { backend, requests } = fakeBackend([
      { text: "Je pense qu'elle ne paierait pas." },
      { text: '{"persona":"Léa","wouldPay":"non","reason":"x"}' },
      { text: "```json\n" + valid + "\n```" },
    ]);
    const res = await new Engine(backend).complete({ ...base, schema });
    expect(res.attempts).toBe(3);
    expect(res.data.wouldPay).toBe(false);
    expect(res.usage).toEqual({ inputTokens: 30, outputTokens: 15 });
    const last = requests[2]!.messages;
    expect(last).toHaveLength(5);
    expect(last[1]).toEqual({ role: "assistant", content: "Je pense qu'elle ne paierait pas." });
    expect(last[2]?.role).toBe("user");
    expect(last[4]?.content).toContain("wouldPay");
  });

  it("abandonne après maxRepairs réparations", async () => {
    const { backend, requests } = fakeBackend([{ text: "pas de json" }]);
    const err = await new Engine(backend, { maxRepairs: 1 })
      .complete({ ...base, schema })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SchemaValidationError);
    expect((err as SchemaValidationError).attempts).toBe(2);
    expect(requests).toHaveLength(2);
  });

  it("accepte la sortie structurée native sans réparation", async () => {
    const { backend } = fakeBackend([
      { text: "", structured: { persona: "Léa", wouldPay: true, reason: "utile" } },
    ]);
    const res = await new Engine(backend).complete({ ...base, schema });
    expect(res.data.wouldPay).toBe(true);
  });

  it("renvoie le texte brut sans schéma", async () => {
    const { backend, requests } = fakeBackend([{ text: "bonjour" }]);
    const res = await new Engine(backend).complete(base);
    expect(res.text).toBe("bonjour");
    expect(res.data).toBeUndefined();
    expect(requests[0]?.jsonSchema).toBeUndefined();
  });

  it("respecte la concurrence du backend", async () => {
    let active = 0;
    let peak = 0;
    const backend: Backend = {
      name: "claude-cli",
      model: "m",
      concurrency: 2,
      async checkAvailability() {
        return { ok: true, detail: "" };
      },
      async generate() {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        return { text: "ok", model: "m", usage: { inputTokens: 0, outputTokens: 0 } };
      },
    };
    const engine = new Engine(backend);
    await Promise.all(Array.from({ length: 6 }, () => engine.complete(base)));
    expect(peak).toBe(2);
  });
});
