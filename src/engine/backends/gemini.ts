import type { Availability, Backend, BackendRequest, BackendResponse, ProviderCapabilities } from "../types";
import type { HttpBackendOptions } from "./anthropic";
import { callJson, ProviderError, ProviderKeyMissingError, redactSecrets, withJsonInstruction } from "./http";
import { SchemaAdaptError, toGeminiSchema } from "./schema-adapt";

export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

interface GenerateContentResponse {
  modelVersion?: string;
  promptFeedback?: { blockReason?: string };
  candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
    thoughtsTokenCount?: number;
  };
}

/**
 * Fournisseur `gemini` : API Generative Language (`generateContent`), clé dans l'en-tête
 * `x-goog-api-key` (jamais dans l'URL). Sortie structurée : `responseSchema` converti depuis le JSON
 * Schema (sous-ensemble d'OpenAPI) ; repli sur le mode JSON (`responseMimeType` seul, schéma dans la
 * consigne) si la conversion échoue.
 */
export class GeminiBackend implements Backend {
  readonly name = "gemini" as const;
  readonly capabilities: ProviderCapabilities = { structured: "json-schema-subset", webTools: false, logprobs: false };
  readonly model: string;
  readonly concurrency: number;
  private readonly baseUrl: string;

  constructor(private readonly opts: HttpBackendOptions) {
    this.model = opts.model;
    this.concurrency = Math.max(1, opts.concurrency);
    this.baseUrl = (opts.baseUrl ?? GEMINI_BASE_URL).replace(/\/+$/, "");
  }

  private async auth(): Promise<{ headers: Record<string, string>; key: string }> {
    const key = await this.opts.apiKey();
    if (!key) {
      throw new ProviderKeyMissingError(
        `Aucune clé pour le profil ${this.opts.profile} (gemini) : npm run engine:key -- set --profile ${this.opts.profile}`,
        "gemini",
      );
    }
    return { key, headers: { "x-goog-api-key": key } };
  }

  private modelPath(): string {
    const m = this.model.startsWith("models/") ? this.model : `models/${this.model}`;
    return m.split("/").map(encodeURIComponent).join("/");
  }

  /** Corps de `generateContent` (exporté pour les tests de contrat). */
  buildBody(request: BackendRequest): Record<string, unknown> {
    let system = request.system;
    const generationConfig: Record<string, unknown> = {
      ...(request.temperature !== undefined && { temperature: request.temperature }),
      ...(request.maxTokens !== undefined && { maxOutputTokens: request.maxTokens }),
    };
    if (request.jsonSchema) {
      generationConfig.responseMimeType = "application/json";
      try {
        generationConfig.responseSchema = toGeminiSchema(request.jsonSchema);
      } catch (err) {
        if (!(err instanceof SchemaAdaptError)) throw err;
        system = withJsonInstruction(system, request.jsonSchema);
      }
    }
    return {
      systemInstruction: { parts: [{ text: system }] },
      contents: request.messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
      generationConfig,
    };
  }

  async checkAvailability(): Promise<Availability> {
    let auth: Awaited<ReturnType<GeminiBackend["auth"]>>;
    try {
      auth = await this.auth();
    } catch (err) {
      return { ok: false, detail: (err as Error).message, hint: `npm run engine:key -- set --profile ${this.opts.profile}` };
    }
    try {
      await callJson({
        provider: "gemini",
        profile: this.opts.profile,
        url: `${this.baseUrl}/${this.modelPath()}`,
        headers: auth.headers,
        timeoutMs: 15_000,
        maxRetries: 0,
        secrets: [auth.key],
        ...(this.opts.fetch && { fetch: this.opts.fetch }),
      });
      return { ok: true, detail: `API Gemini joignable, clé acceptée, modèle ${this.model} disponible` };
    } catch (err) {
      return { ok: false, detail: redactSecrets((err as Error).message, [auth.key]) };
    }
  }

  async generate(request: BackendRequest): Promise<BackendResponse> {
    const auth = await this.auth();
    const res = await callJson<GenerateContentResponse>({
      provider: "gemini",
      profile: this.opts.profile,
      url: `${this.baseUrl}/${this.modelPath()}:generateContent`,
      headers: auth.headers,
      body: this.buildBody(request),
      timeoutMs: request.timeoutMs ?? this.opts.timeoutMs,
      secrets: [auth.key],
      ...(this.opts.maxRetries !== undefined && { maxRetries: this.opts.maxRetries }),
      ...(this.opts.fetch && { fetch: this.opts.fetch }),
      ...(this.opts.sleep && { sleep: this.opts.sleep }),
    });
    return parseGeminiResponse(res, this.model);
  }
}

export function parseGeminiResponse(res: GenerateContentResponse, fallbackModel: string): BackendResponse {
  if (res.promptFeedback?.blockReason) {
    throw new ProviderError(`gemini : requête bloquée (${res.promptFeedback.blockReason})`, "gemini");
  }
  const cand = res.candidates?.[0];
  if (!cand) throw new ProviderError("gemini : réponse sans candidat", "gemini");
  if (cand.finishReason && /SAFETY|BLOCKLIST|PROHIBITED|RECITATION/.test(cand.finishReason)) {
    throw new ProviderError(`gemini : réponse bloquée (${cand.finishReason})`, "gemini");
  }
  const text = (cand.content?.parts ?? [])
    .filter((p) => !p.thought)
    .map((p) => p.text ?? "")
    .join("");
  const u = res.usageMetadata ?? {};
  return {
    text,
    usage: {
      inputTokens: u.promptTokenCount ?? 0,
      // Les tokens de réflexion sont facturés comme de la sortie
      outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
      ...(u.cachedContentTokenCount !== undefined && { cacheReadTokens: u.cachedContentTokenCount }),
    },
    model: res.modelVersion ?? fallbackModel,
  };
}
