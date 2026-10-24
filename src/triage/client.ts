import { loadConfig, OLLAMA_MAX_CONCURRENCY } from "../config";
import { TUNNEL_HINT } from "../engine/backends/ollama";
import type { TopLogprob } from "./relevance";

/**
 * Client « un token et ses log-probabilités » pour le pré-tri. L'implémentation par défaut appelle
 * Ollama (`/api/chat`, `think: false`, `num_predict: 1`, `temperature: 0`, `top_logprobs: 20`).
 * Les tests passent un client simulé.
 */
export interface LogprobClient {
  /** Identifiant du modèle : il entre dans la clé du cache. */
  readonly model: string;
  /** Concurrence voulue ; plafonnée à OLLAMA_MAX_CONCURRENCY par l'appelant. */
  readonly concurrency?: number;
  firstToken(system: string, user: string): Promise<{ content: string; top: TopLogprob[]; promptTokens?: number; cachedTokens?: number }>;
}

export interface OllamaLogprobOptions {
  baseUrl?: string;
  model?: string;
  numCtx?: number;
  timeoutMs?: number;
  concurrency?: number;
  fetch?: typeof fetch;
}

export function ollamaLogprobClient(opts: OllamaLogprobOptions = {}): LogprobClient {
  const cfg = loadConfig();
  const baseUrl = opts.baseUrl ?? cfg.OLLAMA_BASE_URL;
  const model = opts.model ?? cfg.OLLAMA_MODEL;
  const numCtx = opts.numCtx ?? cfg.OLLAMA_NUM_CTX;
  const timeoutMs = opts.timeoutMs ?? cfg.OLLAMA_TIMEOUT_MS;
  const f = opts.fetch ?? fetch;
  return {
    model,
    concurrency: Math.min(opts.concurrency ?? cfg.OLLAMA_CONCURRENCY, OLLAMA_MAX_CONCURRENCY),
    async firstToken(system, user) {
      let res: Response;
      try {
        res = await f(new URL("/api/chat", baseUrl).toString(), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model,
            stream: false,
            think: false,
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
            logprobs: true,
            top_logprobs: 20,
            options: { num_predict: 1, temperature: 0, num_ctx: numCtx },
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw new Error(`Appel Ollama échoué (${(err as Error).message}). ${TUNNEL_HINT}`);
      }
      if (!res.ok) throw new Error(`POST /api/chat : HTTP ${res.status} ${await res.text()}`);
      const d = (await res.json()) as {
        error?: string;
        message?: { content?: string };
        logprobs?: Array<{ token: string; logprob: number; top_logprobs?: TopLogprob[] }>;
        prompt_eval_count?: number;
        prompt_eval_cached_count?: number;
      };
      if (d.error) throw new Error(`Ollama : ${d.error}`);
      const first = d.logprobs?.[0];
      if (!first) throw new Error("Ollama n'a pas renvoyé de log-probabilités (version trop ancienne ?)");
      return {
        content: d.message?.content ?? "",
        top: first.top_logprobs?.length ? first.top_logprobs : [{ token: first.token, logprob: first.logprob }],
        promptTokens: d.prompt_eval_count,
        cachedTokens: d.prompt_eval_cached_count,
      };
    },
  };
}
