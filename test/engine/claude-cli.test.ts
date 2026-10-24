import { describe, expect, it } from "vitest";
import {
  buildClaudeArgs,
  buildClaudeEnv,
  ClaudeCliError,
  parseClaudeOutput,
  serializeMessages,
} from "../../src/engine/backends/claude-cli";

describe("buildClaudeEnv", () => {
  const base = {
    PATH: "/usr/bin",
    HOME: "/home/test",
    ANTHROPIC_API_KEY: "fausse-cle-anthropic",
    ANTHROPIC_AUTH_TOKEN: "tok",
    ANTHROPIC_BASE_URL: "https://proxy.example",
    ANTHROPIC_MODEL: "x",
    CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_CODE_USE_VERTEX: "1",
    AWS_BEARER_TOKEN_BEDROCK: "b",
    CLAUDECODE: "1",
    CLAUDE_CODE_SESSION_ID: "parent",
    CLAUDE_CODE_OAUTH_TOKEN: "abonnement",
    CLAUDE_CONFIG_DIR: "/home/test/.claude",
  };

  it("supprime toutes les variables d'API Anthropic et des autres fournisseurs", () => {
    const env = buildClaudeEnv(base);
    for (const key of Object.keys(env)) {
      expect(key).not.toMatch(/^ANTHROPIC_/);
    }
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_VERTEX).toBeUndefined();
    expect(env.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
  });

  it("n'hérite pas de la session Claude Code parente mais garde le login de l'abonnement", () => {
    const env = buildClaudeEnv(base);
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("abonnement");
    expect(env.CLAUDE_CONFIG_DIR).toBe("/home/test/.claude");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/test");
  });

  it("ne modifie pas l'environnement d'origine", () => {
    const copy = { ...base };
    buildClaudeEnv(copy);
    expect(copy).toEqual(base);
  });

  it("transmet maxTokens par la variable dédiée", () => {
    expect(buildClaudeEnv(base, { maxTokens: 400 }).CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("400");
  });
});

describe("buildClaudeArgs", () => {
  it("isole la session : JSON, aucun outil, aucun réglage, aucun MCP", () => {
    const args = buildClaudeArgs({ model: "sonnet", system: "Tu es Léa." });
    expect(args[0]).toBe("-p");
    const after = (flag: string) => args[args.indexOf(flag) + 1];
    expect(after("--output-format")).toBe("json");
    expect(after("--model")).toBe("sonnet");
    expect(after("--system-prompt")).toBe("Tu es Léa.");
    expect(after("--tools")).toBe("");
    expect(after("--setting-sources")).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(JSON.parse(after("--mcp-config")!)).toEqual({ mcpServers: {} });
    expect(args).not.toContain("--json-schema");
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("passe le JSON Schema en sortie structurée native", () => {
    const schema = { type: "object", properties: { ok: { type: "boolean" } } };
    const args = buildClaudeArgs({ model: "haiku", system: "s", jsonSchema: schema });
    expect(JSON.parse(args[args.indexOf("--json-schema") + 1]!)).toEqual(schema);
  });
});

describe("serializeMessages", () => {
  it("passe un message unique tel quel", () => {
    expect(serializeMessages([{ role: "user", content: "Bonjour" }])).toBe("Bonjour");
  });

  it("met à plat un échange de réparation", () => {
    const s = serializeMessages([
      { role: "user", content: "Q" },
      { role: "assistant", content: "R" },
      { role: "user", content: "Corrige" },
    ]);
    expect(s).toContain("<assistant>\nR\n</assistant>");
    expect(s.indexOf("Corrige")).toBeGreaterThan(s.indexOf("R"));
  });
});

describe("parseClaudeOutput", () => {
  it("lit le texte, l'usage, le coût et le modèle", () => {
    const out = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: '{"ok":true}',
      total_cost_usd: 0.0123,
      usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 },
      modelUsage: { "claude-sonnet-x": {} },
    });
    const r = parseClaudeOutput(out, "sonnet");
    expect(r.text).toBe('{"ok":true}');
    expect(r.model).toBe("claude-sonnet-x");
    expect(r.usage).toEqual({
      inputTokens: 115,
      outputTokens: 20,
      cacheReadTokens: 100,
      cacheWriteTokens: 5,
      costUsd: 0.0123,
    });
  });

  it("récupère la sortie structurée native", () => {
    const out = JSON.stringify({ subtype: "success", result: "", structured_output: { ok: true } });
    expect(parseClaudeOutput(out, "sonnet").structured).toEqual({ ok: true });
  });

  it("signale une erreur de la CLI (ex. login absent)", () => {
    const out = JSON.stringify({ subtype: "success", is_error: true, result: "Invalid API key · Please run /login" });
    expect(() => parseClaudeOutput(out, "sonnet")).toThrow(ClaudeCliError);
    expect(() => parseClaudeOutput(out, "sonnet")).toThrow(/login/);
  });
});
