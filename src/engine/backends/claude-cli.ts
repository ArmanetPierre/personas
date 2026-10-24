import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Availability,
  Backend,
  BackendRequest,
  BackendResponse,
  ChatMessage,
  ProviderCapabilities,
  Usage,
} from "../types";

export interface ClaudeCliOptions {
  /** Chemin de l'exécutable `claude`. */
  bin: string;
  /** Alias (`sonnet`, `opus`, `haiku`) ou nom complet du modèle. */
  model: string;
  concurrency: number;
  timeoutMs: number;
  /** Environnement de base (défaut : process.env), nettoyé avant le lancement. */
  baseEnv?: NodeJS.ProcessEnv;
}

/**
 * Variables qui feraient basculer la CLI sur l'API payante ou un autre fournisseur.
 * CRITIQUE : le sous-processus doit utiliser le login Claude Max, jamais une clé d'API.
 */
const API_VAR_PATTERNS: RegExp[] = [
  /^ANTHROPIC_/, // ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL, ...
  /^CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY)$/,
  /^AWS_BEARER_TOKEN_BEDROCK$/,
  /^CLAUDE_CODE_API_KEY/,
];

/** Variables d'une session Claude Code parente (hôte, socket, session) à ne pas hériter. */
const HOST_SESSION_PATTERNS: RegExp[] = [/^CLAUDECODE$/, /^CLAUDE_CODE_/, /^CLAUDE_AGENT_SDK_/];

/** Conservées malgré les motifs ci-dessus : elles désignent le login de l'abonnement. */
const KEEP = new Set(["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR"]);

export function buildClaudeEnv(
  baseEnv: NodeJS.ProcessEnv,
  opts: { maxTokens?: number } = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (API_VAR_PATTERNS.some((re) => re.test(key))) continue;
    if (!KEEP.has(key) && HOST_SESSION_PATTERNS.some((re) => re.test(key))) continue;
    env[key] = value;
  }
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  env.DISABLE_AUTOUPDATER = "1";
  if (opts.maxTokens !== undefined) {
    env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(opts.maxTokens);
  }
  return env;
}

/** Arguments de `claude -p`. Le prompt utilisateur passe par stdin. */
/** Seuls outils autorisés en mode recherche. */
export const RESEARCH_TOOLS = ["WebSearch", "WebFetch"] as const;

export function buildClaudeArgs(opts: {
  model: string;
  system: string;
  jsonSchema?: Record<string, unknown>;
  /** Mode recherche : WebSearch et/ou WebFetch, rien d'autre (ni Bash, ni fichiers). */
  webTools?: string[];
}): string[] {
  const web = opts.webTools ?? [];
  const bad = web.filter((t) => !(RESEARCH_TOOLS as readonly string[]).includes(t));
  if (bad.length) throw new Error(`Mode recherche : outils refusés (${bad.join(", ")}) ; seuls WebSearch et WebFetch sont permis.`);
  const args = [
    "-p",
    "--output-format",
    "json",
    "--model",
    opts.model,
    // Remplace le prompt système de Claude Code (pas d'instructions d'agent de code)
    "--system-prompt",
    opts.system,
    // Mode normal : aucun outil. Mode recherche : seulement les outils web, préautorisés.
    "--tools",
    web.length ? web.join(",") : "",
    ...(web.length ? ["--allowedTools", web.join(",")] : []),
    // Aucun réglage utilisateur, projet ou local (hooks, plugins, permissions)
    "--setting-sources",
    "",
    // Aucun serveur MCP
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
  ];
  if (opts.jsonSchema) {
    args.push("--json-schema", JSON.stringify(opts.jsonSchema));
  }
  return args;
}

/** `claude -p` ne prend qu'un prompt : un échange à plusieurs tours est mis à plat. */
export function serializeMessages(messages: ChatMessage[]): string {
  if (messages.length === 1 && messages[0]?.role === "user") return messages[0].content;
  return messages
    .map((m) => `<${m.role}>\n${m.content}\n</${m.role}>`)
    .join("\n\n")
    .concat("\n\nRéponds au dernier message <user>.");
}

interface ClaudeJsonOutput {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  modelUsage?: Record<string, unknown>;
}

export class ClaudeCliError extends Error {
  override name = "ClaudeCliError";
}

export function parseClaudeOutput(stdout: string, fallbackModel: string): BackendResponse {
  let out: ClaudeJsonOutput;
  try {
    out = JSON.parse(stdout.trim()) as ClaudeJsonOutput;
  } catch {
    throw new ClaudeCliError(`Sortie de claude illisible : ${stdout.slice(0, 300)}`);
  }
  if (out.is_error || (out.subtype && out.subtype !== "success")) {
    const msg = out.result ?? out.subtype ?? "erreur inconnue";
    const hint = /login|api key/i.test(msg)
      ? " → La CLI n'est pas connectée à l'abonnement : lancer `claude` dans un terminal puis /login (compte Max, pas de clé d'API)."
      : "";
    throw new ClaudeCliError(`claude a renvoyé une erreur : ${msg}${hint}`);
  }
  const u = out.usage ?? {};
  const usage: Usage = {
    inputTokens:
      (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    costUsd: out.total_cost_usd ?? 0,
  };
  const models = Object.keys(out.modelUsage ?? {});
  const text =
    out.result ?? (out.structured_output !== undefined ? JSON.stringify(out.structured_output) : "");
  return {
    text,
    ...(out.structured_output !== undefined && { structured: out.structured_output }),
    usage,
    model: models.length ? models.join("+") : fallbackModel,
  };
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(
  bin: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; cwd: string; stdin?: string; timeoutMs: number },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env: opts.env, cwd: opts.cwd, stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new ClaudeCliError(`claude n'a pas répondu en ${opts.timeoutMs} ms`));
    }, opts.timeoutMs);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(
        new ClaudeCliError(
          (err as NodeJS.ErrnoException).code === "ENOENT"
            ? `Exécutable introuvable : ${bin}`
            : err.message,
        ),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(opts.stdin ?? "");
  });
}

/** Backend `claude -p` : abonnement Claude de l'utilisateur, usage personnel uniquement. */
export class ClaudeCliBackend implements Backend {
  readonly name = "claude-cli" as const;
  readonly capabilities: ProviderCapabilities = { structured: "json-schema", webTools: true, logprobs: false };
  readonly model: string;
  readonly concurrency: number;

  constructor(private readonly opts: ClaudeCliOptions) {
    this.model = opts.model;
    this.concurrency = opts.concurrency;
  }

  private env(maxTokens?: number): NodeJS.ProcessEnv {
    return buildClaudeEnv(this.opts.baseEnv ?? process.env, maxTokens !== undefined ? { maxTokens } : {});
  }

  async checkAvailability(): Promise<Availability> {
    try {
      const r = await run(this.opts.bin, ["--version"], {
        env: this.env(),
        cwd: tmpdir(),
        timeoutMs: 15_000,
      });
      if (r.code !== 0) {
        return { ok: false, detail: `claude --version a échoué (${r.code}) : ${r.stderr.trim()}` };
      }
      return { ok: true, detail: `CLI ${r.stdout.trim()}` };
    } catch (err) {
      return {
        ok: false,
        detail: (err as Error).message,
        hint: "Installer Claude Code puis se connecter avec l'abonnement Max (`claude`, puis /login).",
      };
    }
  }

  async generate(request: BackendRequest): Promise<BackendResponse> {
    // cwd temporaire et vide : aucun CLAUDE.md de projet n'est chargé
    const cwd = await mkdtemp(join(tmpdir(), "personas-claude-"));
    try {
      const args = buildClaudeArgs({
        model: this.opts.model,
        system: request.system,
        ...(request.jsonSchema && { jsonSchema: request.jsonSchema }),
        ...(request.webTools?.length && { webTools: request.webTools }),
      });
      // La CLI n'expose pas la température : elle est ignorée ici.
      const r = await run(this.opts.bin, args, {
        env: this.env(request.maxTokens),
        cwd,
        stdin: serializeMessages(request.messages),
        timeoutMs: request.timeoutMs ?? this.opts.timeoutMs,
      });
      if (r.stdout.trim() === "") {
        throw new ClaudeCliError(`claude a quitté (${r.code}) sans sortie : ${r.stderr.trim()}`);
      }
      return parseClaudeOutput(r.stdout, this.opts.model);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
}
