import type { Availability, Backend, BackendRequest, BackendResponse, ProviderCapabilities } from "../types";
import { callJson, ProviderError, ProviderKeyMissingError, redactSecrets, withJsonInstruction } from "./http";
import { SchemaAdaptError, toToolInputSchema } from "./schema-adapt";

/** Options communes des fournisseurs HTTP (src/engine/index.ts les construit depuis un profil). */
export interface HttpBackendOptions {
  /** Nom du profil de moteur (messages d'erreur, entrée du trousseau). */
  profile: string;
  model: string;
  /** URL de base de l'API ; défaut propre au fournisseur. */
  baseUrl?: string;
  concurrency: number;
  timeoutMs: number;
  /** Réessais bornés sur 5xx et délai dépassé (défaut 2). */
  maxRetries?: number;
  /** Clé de l'utilisateur, lue à la demande (trousseau, puis variable d'environnement nommée). */
  apiKey: () => Promise<string | undefined>;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
export const ANTHROPIC_VERSION = "2023-06-01";
/** Nom de l'outil unique imposé : sa saisie est la réponse structurée. */
export const ANTHROPIC_TOOL_NAME = "respond";
const DEFAULT_MAX_TOKENS = 8_192;

interface MessagesResponse {
  model?: string;
  stop_reason?: string;
  content?: Array<{ type: string; text?: string; name?: string; input?: unknown }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

/**
 * Fournisseur `anthropic` : Messages API avec la clé de l'utilisateur (jamais une variable `ANTHROPIC_*`
 * de l'environnement : la clé vient du trousseau, voir src/engine/secrets.ts).
 * Sortie structurée : un outil unique forcé (`tool_choice`) dont l'`input_schema` est le schéma.
 */
export class AnthropicBackend implements Backend {
  readonly name = "anthropic" as const;
  readonly capabilities: ProviderCapabilities = { structured: "tool-call", webTools: false, logprobs: false };
  readonly model: string;
  readonly concurrency: number;
  private readonly baseUrl: string;

  constructor(private readonly opts: HttpBackendOptions) {
    this.model = opts.model;
    this.concurrency = Math.max(1, opts.concurrency);
    this.baseUrl = (opts.baseUrl ?? ANTHROPIC_BASE_URL).replace(/\/+$/, "");
  }

  private async headers(): Promise<{ headers: Record<string, string>; key: string }> {
    const key = await this.opts.apiKey();
    if (!key) {
      throw new ProviderKeyMissingError(
        `Aucune clé pour le profil ${this.opts.profile} (anthropic) : npm run engine:key -- set --profile ${this.opts.profile}`,
        "anthropic",
      );
    }
    return { key, headers: { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION } };
  }

  /** Corps de la requête Messages (exporté pour les tests de contrat). */
  buildBody(request: BackendRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      system: request.system,
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      ...(request.temperature !== undefined && { temperature: request.temperature }),
    };
    if (request.jsonSchema) {
      body.tools = [
        {
          name: ANTHROPIC_TOOL_NAME,
          description: "Donne la réponse finale, structurée selon le schéma.",
          input_schema: toToolInputSchema(request.jsonSchema),
        },
      ];
      body.tool_choice = { type: "tool", name: ANTHROPIC_TOOL_NAME };
    }
    return body;
  }

  async checkAvailability(): Promise<Availability> {
    try {
      const { headers, key } = await this.headers();
      try {
        await callJson({
          provider: "anthropic",
          profile: this.opts.profile,
          url: `${this.baseUrl}/v1/models/${encodeURIComponent(this.model)}`,
          headers,
          timeoutMs: 15_000,
          maxRetries: 0,
          secrets: [key],
          ...(this.opts.fetch && { fetch: this.opts.fetch }),
        });
      } catch (err) {
        return { ok: false, detail: redactSecrets((err as Error).message, [key]) };
      }
      return { ok: true, detail: `API Anthropic joignable, clé acceptée, modèle ${this.model} connu` };
    } catch (err) {
      return { ok: false, detail: (err as Error).message, hint: `npm run engine:key -- set --profile ${this.opts.profile}` };
    }
  }

  async generate(request: BackendRequest): Promise<BackendResponse> {
    const { headers, key } = await this.headers();
    let body: Record<string, unknown>;
    try {
      body = this.buildBody(request);
    } catch (err) {
      if (!(err instanceof SchemaAdaptError) || !request.jsonSchema) throw err;
      // Schéma non exprimable en outil : consigne JSON dans le système, la réparation fait le reste
      const { jsonSchema, ...rest } = request;
      body = this.buildBody({ ...rest, system: withJsonInstruction(request.system, jsonSchema) });
    }
    const res = await callJson<MessagesResponse>({
      provider: "anthropic",
      profile: this.opts.profile,
      url: `${this.baseUrl}/v1/messages`,
      headers,
      body,
      timeoutMs: request.timeoutMs ?? this.opts.timeoutMs,
      secrets: [key],
      ...(this.opts.maxRetries !== undefined && { maxRetries: this.opts.maxRetries }),
      ...(this.opts.fetch && { fetch: this.opts.fetch }),
      ...(this.opts.sleep && { sleep: this.opts.sleep }),
    });
    return parseAnthropicResponse(res, this.model, !!request.jsonSchema);
  }
}

export function parseAnthropicResponse(res: MessagesResponse, fallbackModel: string, expectTool: boolean): BackendResponse {
  const blocks = res.content ?? [];
  const tool = blocks.find((b) => b.type === "tool_use" && b.name === ANTHROPIC_TOOL_NAME);
  const text = blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
  if (res.stop_reason === "refusal") throw new ProviderError("anthropic : le modèle a refusé de répondre (stop_reason: refusal).", "anthropic");
  const u = res.usage ?? {};
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  return {
    text: tool ? JSON.stringify(tool.input) : text,
    ...(tool && expectTool && { structured: tool.input }),
    usage: {
      // Comme claude-cli : l'entrée compte aussi les tokens lus et écrits en cache
      inputTokens: (u.input_tokens ?? 0) + cacheRead + cacheWrite,
      outputTokens: u.output_tokens ?? 0,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
    },
    model: res.model ?? fallbackModel,
  };
}
