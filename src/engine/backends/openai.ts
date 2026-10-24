import type { Availability, Backend, BackendRequest, BackendResponse, ProviderCapabilities } from "../types";
import type { HttpBackendOptions } from "./anthropic";
import { callJson, ProviderError, ProviderKeyMissingError, redactSecrets, withJsonInstruction } from "./http";
import { normalizeNulls, SchemaAdaptError, toOpenAiStrictSchema } from "./schema-adapt";

export type OpenAiFamilyKind = "openai" | "openrouter" | "openai-compatible";

export interface OpenAiFamilyOptions extends HttpBackendOptions {
  kind: OpenAiFamilyKind;
  /** Plafond dur de concurrence (par ex. un serveur Ollama joint par son API /v1). */
  maxConcurrency?: number;
}

export const OPENAI_BASE_URL = "https://api.openai.com/v1";
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
/** Nom du schéma dans `response_format.json_schema` (exigé par l'API). */
export const OPENAI_SCHEMA_NAME = "response";

type RuntimeMode = "json-schema" | "json-mode" | "none";

interface ChatCompletion {
  model?: string;
  choices?: Array<{ finish_reason?: string; message?: { content?: string | null; refusal?: string | null } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    /** OpenRouter, avec `usage: { include: true }` : coût réel en crédits (USD). */
    cost?: number;
  };
}

/**
 * Fournisseurs à l'API Chat Completions : `openai`, `openrouter` (API compatible, paramètres relayés au
 * modèle sous-jacent) et `openai-compatible` (vLLM, LM Studio, Ollama /v1… : URL de base du profil).
 *
 * Sortie structurée : `response_format: json_schema` en mode strict, avec un schéma transformé
 * (toutes les propriétés requises, facultatives en union avec `null`, `additionalProperties: false`,
 * sans `default`) et les `null` normalisés avant zod. Repli sur le mode JSON si la transformation
 * échoue ou si le serveur refuse le paramètre (le repli est alors retenu pour la suite).
 */
export class OpenAiBackend implements Backend {
  readonly name: OpenAiFamilyKind;
  readonly model: string;
  readonly concurrency: number;
  private readonly baseUrl: string;
  private mode: RuntimeMode = "json-schema";

  constructor(private readonly opts: OpenAiFamilyOptions) {
    this.name = opts.kind;
    this.model = opts.model;
    const wanted = Math.max(1, opts.concurrency);
    this.concurrency = opts.maxConcurrency ? Math.min(wanted, opts.maxConcurrency) : wanted;
    const def = opts.kind === "openai" ? OPENAI_BASE_URL : opts.kind === "openrouter" ? OPENROUTER_BASE_URL : undefined;
    const base = opts.baseUrl ?? def;
    if (!base) throw new Error(`Profil ${opts.profile} (openai-compatible) : URL de base requise (baseUrl), par ex. http://localhost:8000/v1`);
    this.baseUrl = base.replace(/\/+$/, "");
  }

  get capabilities(): ProviderCapabilities {
    return {
      structured: this.mode,
      webTools: false,
      // Chat Completions d'OpenAI expose `logprobs` ; les autres serveurs ne sont pas détectés
      logprobs: this.name === "openai",
    };
  }

  private async auth(): Promise<{ headers: Record<string, string>; key: string | undefined }> {
    const key = await this.opts.apiKey();
    if (!key && this.name !== "openai-compatible") {
      throw new ProviderKeyMissingError(
        `Aucune clé pour le profil ${this.opts.profile} (${this.name}) : npm run engine:key -- set --profile ${this.opts.profile}`,
        this.name,
      );
    }
    const headers: Record<string, string> = key ? { authorization: `Bearer ${key}` } : {};
    if (this.name === "openrouter") headers["x-title"] = "Personas";
    return { headers, key };
  }

  /** Corps de la requête Chat Completions pour un mode donné (exporté pour les tests de contrat). */
  buildBody(request: BackendRequest, mode: RuntimeMode = this.mode): { body: Record<string, unknown>; strict: boolean } {
    let system = request.system;
    let responseFormat: Record<string, unknown> | undefined;
    let strict = false;
    if (request.jsonSchema) {
      let effective = mode;
      if (effective === "json-schema") {
        try {
          responseFormat = {
            type: "json_schema",
            json_schema: { name: OPENAI_SCHEMA_NAME, strict: true, schema: toOpenAiStrictSchema(request.jsonSchema) },
          };
          strict = true;
        } catch (err) {
          if (!(err instanceof SchemaAdaptError)) throw err;
          effective = "json-mode";
        }
      }
      if (effective !== "json-schema") {
        // Le mode JSON exige le mot « JSON » dans les messages ; le schéma y est donné en clair
        system = withJsonInstruction(system, request.jsonSchema);
        if (effective === "json-mode") responseFormat = { type: "json_object" };
      }
    }
    const maxKey = this.name === "openai" ? "max_completion_tokens" : "max_tokens";
    const body: Record<string, unknown> = {
      model: this.model,
      messages: [{ role: "system", content: system }, ...request.messages.map((m) => ({ role: m.role, content: m.content }))],
      ...(request.temperature !== undefined && { temperature: request.temperature }),
      ...(request.maxTokens !== undefined && { [maxKey]: request.maxTokens }),
      ...(responseFormat && { response_format: responseFormat }),
    };
    if (this.name === "openrouter") {
      body.usage = { include: true };
      // Ne router que vers un hébergeur qui respecte les paramètres demandés (response_format)
      if (responseFormat) body.provider = { require_parameters: true };
    }
    return { body, strict };
  }

  async checkAvailability(): Promise<Availability> {
    let auth: Awaited<ReturnType<OpenAiBackend["auth"]>>;
    try {
      auth = await this.auth();
    } catch (err) {
      return { ok: false, detail: (err as Error).message, hint: `npm run engine:key -- set --profile ${this.opts.profile}` };
    }
    const call = (path: string) =>
      callJson<{ data?: Array<{ id?: string; supported_parameters?: string[] }> }>({
        provider: this.name,
        profile: this.opts.profile,
        url: `${this.baseUrl}${path}`,
        headers: auth.headers,
        timeoutMs: 15_000,
        maxRetries: 0,
        secrets: [auth.key],
        ...(this.opts.fetch && { fetch: this.opts.fetch }),
      });
    try {
      if (this.name === "openai") {
        await call(`/models/${encodeURIComponent(this.model)}`);
        return { ok: true, detail: `API OpenAI joignable, clé acceptée, modèle ${this.model} disponible` };
      }
      const list = await call("/models");
      const entry = (list.data ?? []).find((m) => m.id === this.model);
      if (!entry) {
        const ids = (list.data ?? []).map((m) => m.id).filter(Boolean);
        return { ok: false, detail: `Modèle ${this.model} absent du catalogue de ${this.baseUrl} (${ids.slice(0, 10).join(", ") || "aucun"}${ids.length > 10 ? ", …" : ""})` };
      }
      if (this.name === "openrouter") {
        // Capacité lue dans le catalogue : structured_outputs → json_schema, sinon response_format → mode JSON
        const params = entry.supported_parameters ?? [];
        this.mode = params.includes("structured_outputs") ? "json-schema" : params.includes("response_format") ? "json-mode" : "none";
        await call("/key"); // valide la clé (le catalogue est public)
        return { ok: true, detail: `OpenRouter joignable, clé acceptée, modèle ${this.model} (sortie structurée : ${this.mode})` };
      }
      return { ok: true, detail: `Serveur ${this.baseUrl} joignable, modèle ${this.model} présent` };
    } catch (err) {
      return { ok: false, detail: redactSecrets((err as Error).message, [auth.key]) };
    }
  }

  async generate(request: BackendRequest): Promise<BackendResponse> {
    const auth = await this.auth();
    const send = (body: Record<string, unknown>) =>
      callJson<ChatCompletion>({
        provider: this.name,
        profile: this.opts.profile,
        url: `${this.baseUrl}/chat/completions`,
        headers: auth.headers,
        body,
        timeoutMs: request.timeoutMs ?? this.opts.timeoutMs,
        secrets: [auth.key],
        ...(this.opts.maxRetries !== undefined && { maxRetries: this.opts.maxRetries }),
        ...(this.opts.fetch && { fetch: this.opts.fetch }),
        ...(this.opts.sleep && { sleep: this.opts.sleep }),
      });

    let { body, strict } = this.buildBody(request);
    let res: ChatCompletion;
    try {
      res = await send(body);
    } catch (err) {
      // Serveur qui refuse json_schema (400) : repli sur le mode JSON, retenu pour les appels suivants
      if (!(strict && err instanceof ProviderError && err.status === 400 && /response_format|json_schema|structured|strict/i.test(err.message))) throw err;
      this.mode = "json-mode";
      ({ body, strict } = this.buildBody(request, "json-mode"));
      res = await send(body);
    }
    return parseChatCompletion(res, this.name, this.model, strict ? request.jsonSchema : undefined);
  }
}

/** Lit une réponse Chat Completions ; `strictSchema` : schéma d'origine, pour normaliser les `null`. */
export function parseChatCompletion(
  res: ChatCompletion,
  kind: OpenAiFamilyKind,
  fallbackModel: string,
  strictSchema?: Record<string, unknown>,
): BackendResponse {
  const msg = res.choices?.[0]?.message;
  if (msg?.refusal) throw new ProviderError(`${kind} : le modèle a refusé de répondre (${msg.refusal.slice(0, 200)})`, kind);
  const text = msg?.content ?? "";
  let structured: unknown;
  if (strictSchema && text.trim()) {
    try {
      structured = normalizeNulls(JSON.parse(text), strictSchema);
    } catch {
      structured = undefined; // texte tronqué ou invalide : l'Engine extrait et répare
    }
  }
  const u = res.usage ?? {};
  return {
    text,
    ...(structured !== undefined && { structured }),
    usage: {
      inputTokens: u.prompt_tokens ?? 0,
      outputTokens: u.completion_tokens ?? 0,
      ...(u.prompt_tokens_details?.cached_tokens !== undefined && { cacheReadTokens: u.prompt_tokens_details.cached_tokens }),
      ...(u.cost !== undefined && { costUsd: u.cost }),
    },
    model: res.model ?? fallbackModel,
  };
}
