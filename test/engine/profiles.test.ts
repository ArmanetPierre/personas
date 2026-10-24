import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config";
import { createBackend, getEngine, getProfileEngine } from "../../src/engine";
import { ClaudeCliBackend } from "../../src/engine/backends/claude-cli";
import { OllamaBackend } from "../../src/engine/backends/ollama";
import {
  activeProfileName,
  builtinProfiles,
  emptyEngineConfig,
  engineConfigPath,
  loadEngineConfig,
  PlaintextSecretError,
  ProfileError,
  removeProfileFrom,
  resolveProfile,
  saveEngineConfig,
  setActiveProfile,
  upsertProfile,
} from "../../src/engine/profiles";
import { childEnv } from "../../src/web/launcher";

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "personas-profiles-"));
  path = join(dir, "config.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const env = { CLAUDE_CLI_MODEL: "opus", CLAUDE_CLI_CONCURRENCY: "3", OLLAMA_BASE_URL: "http://localhost:23456", OLLAMA_MODEL: "qwen-x" };
const config = loadConfig(env);
const privateOpts = (b: unknown) => (b as { opts: unknown }).opts;

describe("comportement par défaut inchangé (sans fichier de profils)", () => {
  it("createBackend('claude-cli') : mêmes options qu'avant les profils", () => {
    const b = createBackend("claude-cli", config);
    const before = new ClaudeCliBackend({ bin: config.CLAUDE_CLI_PATH, model: config.CLAUDE_CLI_MODEL, concurrency: config.CLAUDE_CLI_CONCURRENCY, timeoutMs: config.CLAUDE_CLI_TIMEOUT_MS });
    expect(b).toBeInstanceOf(ClaudeCliBackend);
    expect(privateOpts(b)).toEqual(privateOpts(before));
    expect(b.capabilities).toEqual({ structured: "json-schema", webTools: true, logprobs: false });
  });

  it("createBackend('ollama') : mêmes options qu'avant (URL, modèle, num_ctx, plafond 2)", () => {
    const b = createBackend("ollama", loadConfig({ ...env, OLLAMA_CONCURRENCY: "9" }));
    const c = loadConfig({ ...env, OLLAMA_CONCURRENCY: "9" });
    const before = new OllamaBackend({ baseUrl: c.OLLAMA_BASE_URL, model: c.OLLAMA_MODEL, numCtx: c.OLLAMA_NUM_CTX, concurrency: c.OLLAMA_CONCURRENCY, timeoutMs: c.OLLAMA_TIMEOUT_MS });
    expect(privateOpts(b)).toEqual(privateOpts(before));
    expect(b.concurrency).toBe(2);
  });

  it("profil actif par défaut : claude-cli ; le moteur partagé est celui de getEngine", () => {
    expect(activeProfileName({ env: {}, file: emptyEngineConfig() })).toBe("claude-cli");
    expect(resolveProfile(config, { env: {}, path })).toEqual(builtinProfiles(config)[0]);
    expect(getProfileEngine(config, { env: {}, path })).toBe(getEngine("claude-cli", config));
  });

  it("anthropic-api reste refusé ; un fournisseur à clé exige un profil", () => {
    expect(() => createBackend("anthropic-api", config)).toThrow(/remplacé par le fournisseur anthropic/);
    expect(() => createBackend("openai", config)).toThrow(/se configure par un profil/);
  });

  it("le launcher retire toujours ANTHROPIC_* de l'environnement des enfants", () => {
    const out = childEnv({ ANTHROPIC_API_KEY: "x", ANTHROPIC_BASE_URL: "y", PERSONAS_PROFILE: "p", PATH: "/bin" });
    expect(Object.keys(out).sort()).toEqual(["PATH", "PERSONAS_PROFILE"]);
  });
});

describe("fichier de profils", () => {
  it("chemin : PERSONAS_CONFIG, sinon dossier temporaire sous vitest, sinon ~/.personas/config.json", () => {
    expect(engineConfigPath({ PERSONAS_CONFIG: "/x/y.json" })).toBe("/x/y.json");
    expect(engineConfigPath({ VITEST: "true" }).startsWith(tmpdir())).toBe(true);
    expect(engineConfigPath({})).toBe(join(homedir(), ".personas", "config.json"));
    expect(engineConfigPath()).not.toBe(join(homedir(), ".personas", "config.json"));
  });

  it("ajout, activation, suppression ; fichier 0600 sans clé", () => {
    let f = upsertProfile(emptyEngineConfig(), { name: "mon-openai", provider: "openai", model: "gpt-test", keyEnv: "MY_OPENAI_KEY", limits: { perStudyUsd: 5 } });
    f = setActiveProfile(f, "mon-openai", config);
    saveEngineConfig(f, path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const back = loadEngineConfig(path);
    expect(back).toEqual({ version: 1, activeProfile: "mon-openai", profiles: [{ name: "mon-openai", provider: "openai", model: "gpt-test", keyEnv: "MY_OPENAI_KEY", limits: { perStudyUsd: 5 } }] });
    expect(resolveProfile(config, { env: {}, path }).name).toBe("mon-openai");
    // --profile, puis PERSONAS_PROFILE, l'emportent sur le fichier
    expect(resolveProfile(config, { env: { PERSONAS_PROFILE: "ollama" }, path }).provider).toBe("ollama");
    expect(resolveProfile(config, { flag: "claude-cli", env: { PERSONAS_PROFILE: "ollama" }, path }).provider).toBe("claude-cli");
    const removed = removeProfileFrom(back, "mon-openai");
    expect(removed).toEqual({ version: 1, profiles: [] });
    expect(setActiveProfile(f, "claude-cli", config)).not.toHaveProperty("activeProfile");
  });

  it("refuse une clé en clair, à toute profondeur", () => {
    writeFileSync(path, JSON.stringify({ version: 1, profiles: [{ name: "a", provider: "openai", model: "m", apiKey: "secret-value" }] }));
    expect(() => loadEngineConfig(path)).toThrow(PlaintextSecretError);
    try {
      loadEngineConfig(path);
    } catch (err) {
      expect((err as Error).message).not.toContain("secret-value");
    }
    expect(() => upsertProfile(emptyEngineConfig(), { name: "a", provider: "openai", model: "m", token: "t" } as never)).toThrow(ProfileError);
  });

  it("refuse les noms réservés, les doublons, les variables ANTHROPIC_* comme source de clé", () => {
    expect(() => upsertProfile(emptyEngineConfig(), { name: "claude-cli", provider: "anthropic", model: "m" })).toThrow(/réservé/);
    expect(() => upsertProfile(emptyEngineConfig(), { name: "a", provider: "anthropic", model: "m", keyEnv: "ANTHROPIC_API_KEY" })).toThrow(/ANTHROPIC_API_KEY refusée/);
    expect(() => upsertProfile(emptyEngineConfig(), { name: "a", provider: "openai-compatible", model: "m" })).toThrow(/URL de base/);
    writeFileSync(path, JSON.stringify({ version: 1, profiles: [{ name: "a", provider: "openai", model: "m" }, { name: "a", provider: "gemini", model: "m" }] }));
    expect(() => loadEngineConfig(path)).toThrow(/double/);
    expect(() => resolveProfile(config, { flag: "inconnu", env: {}, path: join(dir, "absent.json") })).toThrow(/Profil inconnu/);
  });

  it("profil claude-cli nommé (autre modèle) : options de l'environnement, modèle du profil", () => {
    const f = upsertProfile(emptyEngineConfig(), { name: "opus", provider: "claude-cli", model: "opus", concurrency: 1 });
    saveEngineConfig(f, path);
    const engine = getProfileEngine(config, { profile: "opus", env: {}, path });
    expect(engine.backend).toBeInstanceOf(ClaudeCliBackend);
    expect(privateOpts(engine.backend)).toEqual({ bin: "claude", model: "opus", concurrency: 1, timeoutMs: config.CLAUDE_CLI_TIMEOUT_MS });
    expect(JSON.parse(readFileSync(path, "utf8")).profiles[0]).not.toHaveProperty("key");
  });
});
