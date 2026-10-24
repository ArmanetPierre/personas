import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config";
import { createBackendFromProfile, ProviderError } from "../../src/engine";
import { redactSecrets } from "../../src/engine/backends/http";
import { defaultSecretStore, KeychainUnavailableError, memoryStore, resolveApiKey, type SecretStore } from "../../src/engine/secrets";
import { FAKE_KEY } from "./providers/fake-server";

const brokenStore: SecretStore = {
  kind: "keychain",
  get: async () => {
    throw new KeychainUnavailableError("Trousseau du système indisponible (pas de session)");
  },
  set: async () => {
    throw new KeychainUnavailableError("indisponible");
  },
  remove: async () => false,
};

describe("masquage des clés", () => {
  it("masque la clé du profil et les motifs de clés connus", () => {
    const out = redactSecrets(
      `clé ${FAKE_KEY} ; Bearer abcdefghijklmnop ; https://x/y?key=zzzzzzzzzz&a=1 ; ` +
        `x-api-key: qwertyuiop ; tronquée sk-abc********wxyz ; ${"sk-"}proj-ABCDEFGHIJKLMNOP ; AIza${"B".repeat(30)}`,
      [FAKE_KEY],
    );
    expect(out).not.toContain(FAKE_KEY);
    expect(out).not.toMatch(/abcdefghijklmnop|zzzzzzzzzz|qwertyuiop|wxyz|ABCDEFGHIJKLMNOP|BBBBBBBBBB/);
    expect(out).toContain("Bearer ***");
    expect(out).toContain("key=***&a=1");
  });

  it("aucune erreur de fournisseur ne contient la clé (réponse qui la renvoie, réseau coupé)", async () => {
    const echo = (async (_url: string, init: RequestInit) =>
      new Response(JSON.stringify({ error: { message: `bad key ${JSON.stringify(init.headers)}` } }), { status: 400 })) as unknown as typeof fetch;
    const down = (async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { message: `connect refused for ${FAKE_KEY}` } });
    }) as unknown as typeof fetch;
    for (const provider of ["anthropic", "openai", "openrouter", "gemini", "openai-compatible"] as const) {
      for (const f of [echo, down]) {
        const b = createBackendFromProfile({ name: "p", provider, model: "m", baseUrl: "http://127.0.0.1:1/v1" }, loadConfig({}), {
          secrets: memoryStore({ p: FAKE_KEY }),
          fetch: f,
          sleep: async () => {},
          env: {},
        });
        const err = await b.generate({ system: "S", messages: [{ role: "user", content: "Q" }] }).then(() => new Error("aucune erreur"), (e: unknown) => e as Error);
        expect(err, provider).toBeInstanceOf(ProviderError);
        expect(err.message, provider).not.toContain(FAKE_KEY);
        expect(String(err.stack), provider).not.toContain(FAKE_KEY);
        const a = await b.checkAvailability();
        expect(JSON.stringify(a), provider).not.toContain(FAKE_KEY);
      }
    }
  });
});

describe("résolution de la clé", () => {
  const profile = { name: "p", provider: "openai" as const, keyEnv: "MY_TEST_KEY" };

  it("trousseau d'abord", async () => {
    expect(await resolveApiKey(profile, { store: memoryStore({ p: "k1" }), env: { MY_TEST_KEY: "k2" } })).toEqual({ key: "k1", source: "keychain" });
  });

  it("repli sur la variable nommée, avec avertissement (sans la clé)", async () => {
    const r = await resolveApiKey(profile, { store: brokenStore, env: { MY_TEST_KEY: "k2" } });
    expect(r.key).toBe("k2");
    expect(r.source).toBe("env");
    expect(r.warning).toContain("MY_TEST_KEY");
    expect(r.warning).toContain("indisponible");
    expect(r.warning).not.toContain("k2");
  });

  it("ne lit jamais une variable non nommée, ni ANTHROPIC_*", async () => {
    const env = { ANTHROPIC_API_KEY: "interdite", OPENAI_API_KEY: "non-nommee" };
    expect((await resolveApiKey({ name: "p", provider: "openai" }, { store: memoryStore(), env })).key).toBeUndefined();
    expect((await resolveApiKey({ name: "p", provider: "anthropic", keyEnv: "ANTHROPIC_API_KEY" }, { store: memoryStore(), env })).key).toBeUndefined();
  });

  it("claude-cli et ollama : jamais de clé", async () => {
    expect(await resolveApiKey({ name: "claude-cli", provider: "claude-cli" }, { store: memoryStore({ "claude-cli": "x" }) })).toEqual({ key: undefined, source: "none" });
  });

  it("sous vitest, le magasin par défaut est en mémoire (le vrai trousseau n'est jamais touché)", () => {
    expect(defaultSecretStore().kind).toBe("memory");
    expect(defaultSecretStore({}).kind).toBe("keychain");
  });

  it("avertissement du repli émis une fois par backend, clé lue une seule fois", async () => {
    const warnings: string[] = [];
    let reads = 0;
    const counting: SecretStore = { ...brokenStore, get: async () => (reads++, brokenStore.get("p")) };
    const ok = (async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }))) as unknown as typeof fetch;
    const b = createBackendFromProfile({ name: "p", provider: "openai", model: "m", keyEnv: "MY_TEST_KEY" }, loadConfig({}), {
      secrets: counting,
      env: { MY_TEST_KEY: "k2" },
      fetch: ok,
      warn: (m) => warnings.push(m),
    });
    await b.generate({ system: "S", messages: [{ role: "user", content: "Q" }] });
    await b.generate({ system: "S", messages: [{ role: "user", content: "Q" }] });
    expect(reads).toBe(1);
    expect(warnings).toHaveLength(1);
  });
});
