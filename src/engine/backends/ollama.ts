import { OLLAMA_MAX_CONCURRENCY } from "../../config";
import type { Availability, Backend, BackendRequest, BackendResponse, ProviderCapabilities } from "../types";

export interface OllamaOptions {
  /** URL du serveur Ollama (locale ou par tunnel SSH), par ex. http://localhost:11434. */
  baseUrl: string;
  model: string;
  numCtx: number;
  /** Plafonnée à OLLAMA_MAX_CONCURRENCY quoi qu'on demande. */
  concurrency: number;
  timeoutMs: number;
  fetch?: typeof fetch;
}

export const TUNNEL_HINT =
  "Vérifier que le serveur Ollama répond à OLLAMA_BASE_URL : lancer `ollama serve` en local, ou ouvrir un tunnel SSH vers votre hôte Ollama.";

/**
 * Backend Ollama via l'API native `/api/chat`.
 * Choisie plutôt que `/v1/chat/completions` parce qu'elle gère proprement `think: false`
 * et `format` (JSON Schema imposé au décodage), et accepte `num_ctx` dans `options`.
 */
export class OllamaBackend implements Backend {
  readonly name = "ollama" as const;
  readonly capabilities: ProviderCapabilities = { structured: "json-schema", webTools: false, logprobs: true };
  readonly model: string;
  readonly concurrency: number;
  private readonly fetch: typeof fetch;

  constructor(private readonly opts: OllamaOptions) {
    this.model = opts.model;
    this.concurrency = Math.max(1, Math.min(opts.concurrency, OLLAMA_MAX_CONCURRENCY));
    this.fetch = opts.fetch ?? fetch;
  }

  private url(path: string): string {
    return new URL(path, this.opts.baseUrl).toString();
  }

  async checkAvailability(): Promise<Availability> {
    let res: Response;
    try {
      res = await this.fetch(this.url("/api/tags"), { signal: AbortSignal.timeout(10_000) });
    } catch (err) {
      return {
        ok: false,
        detail: `Ollama injoignable sur ${this.opts.baseUrl} (${describeFetchError(err)})`,
        hint: TUNNEL_HINT,
      };
    }
    if (!res.ok) return { ok: false, detail: `GET /api/tags : HTTP ${res.status}` };
    const body = (await res.json()) as { models?: Array<{ name: string }> };
    const names = (body.models ?? []).map((m) => m.name);
    if (!names.includes(this.model)) {
      return {
        ok: false,
        detail: `Modèle ${this.model} absent du serveur (présents : ${names.join(", ") || "aucun"})`,
      };
    }
    return { ok: true, detail: `Ollama joignable, modèle ${this.model} présent` };
  }

  async generate(request: BackendRequest): Promise<BackendResponse> {
    const options: Record<string, number> = { num_ctx: this.opts.numCtx };
    if (request.temperature !== undefined) options.temperature = request.temperature;
    if (request.maxTokens !== undefined) options.num_predict = request.maxTokens;

    const body = {
      model: this.model,
      // Streaming : les en-têtes arrivent tout de suite. En non-streaming, une génération de plus de
      // 300 s (serveur à ~8 tok/s, requête en file derrière une autre) dépasse le délai d'en-têtes d'undici.
      stream: true,
      think: false,
      messages: [{ role: "system", content: request.system }, ...request.messages],
      ...(request.jsonSchema && { format: request.jsonSchema }),
      options,
    };

    let res: Response;
    try {
      res = await this.fetch(this.url("/api/chat"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (err) {
      throw new Error(`Appel Ollama échoué (${describeFetchError(err)}). ${TUNNEL_HINT}`);
    }
    if (!res.ok) {
      throw new Error(`POST /api/chat : HTTP ${res.status} ${await res.text()}`);
    }
    type Chunk = {
      model?: string;
      message?: { content?: string };
      prompt_eval_count?: number;
      eval_count?: number;
      error?: string;
    };
    // NDJSON (stream) ; un corps JSON unique est aussi accepté.
    const raw = await res.text();
    let content = "";
    let data: Chunk = {};
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const chunk = JSON.parse(line) as Chunk;
      if (chunk.error) throw new Error(`Ollama : ${chunk.error}`);
      content += chunk.message?.content ?? "";
      data = { ...data, ...chunk };
    }
    return {
      text: content,
      usage: {
        inputTokens: data.prompt_eval_count ?? 0,
        outputTokens: data.eval_count ?? 0,
        costUsd: 0,
      },
      model: data.model ?? this.model,
    };
  }
}

function describeFetchError(err: unknown): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string } };
  if (e.name === "TimeoutError") return "délai dépassé";
  return e.cause?.code ?? e.message ?? String(err);
}
