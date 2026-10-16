import { z } from "zod";
import { buildRepairPrompt, parseWithSchema } from "./json";
import { createLimiter, type Limiter } from "./limiter";
import type {
  Backend,
  BackendRequest,
  ChatMessage,
  CompleteResult,
  Usage,
} from "./types";

export class SchemaValidationError extends Error {
  override name = "SchemaValidationError";
  constructor(
    message: string,
    readonly lastText: string,
    readonly attempts: number,
  ) {
    super(message);
  }
}

export interface EngineOptions {
  /** Nombre de tentatives de réparation après une réponse invalide (défaut 2). */
  maxRepairs?: number;
  /** Limiteur partagé ; par défaut un limiteur à `backend.concurrency`. */
  limiter?: Limiter;
}

interface BaseRequest {
  system: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Mode recherche : outils web autorisés (claude-cli), voir BackendRequest. */
  webTools?: BackendRequest["webTools"];
  timeoutMs?: number;
}

/**
 * Point d'entrée unique de la couche moteur : concurrence par backend,
 * extraction et validation du JSON, réparations, usage cumulé.
 */
export class Engine {
  readonly limiter: Limiter;
  private readonly maxRepairs: number;

  constructor(
    readonly backend: Backend,
    options: EngineOptions = {},
  ) {
    this.limiter = options.limiter ?? createLimiter(backend.concurrency);
    this.maxRepairs = options.maxRepairs ?? 2;
  }

  complete<S extends z.ZodType>(
    request: BaseRequest & { schema: S },
  ): Promise<CompleteResult<z.infer<S>>>;
  complete(request: BaseRequest & { schema?: undefined }): Promise<CompleteResult<undefined>>;
  async complete(
    request: BaseRequest & { schema?: z.ZodType },
  ): Promise<CompleteResult<unknown>> {
    const started = performance.now();
    const { schema } = request;
    const jsonSchema = schema
      ? (z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>)
      : undefined;

    const messages: ChatMessage[] = [...request.messages];
    const usage: Usage = { inputTokens: 0, outputTokens: 0 };
    const maxAttempts = schema ? 1 + this.maxRepairs : 1;

    for (let attempt = 1; ; attempt++) {
      const backendRequest: BackendRequest = {
        system: request.system,
        messages,
        ...(jsonSchema && { jsonSchema }),
        ...(request.temperature !== undefined && { temperature: request.temperature }),
        ...(request.maxTokens !== undefined && { maxTokens: request.maxTokens }),
        ...(request.webTools?.length && { webTools: request.webTools }),
        ...(request.timeoutMs !== undefined && { timeoutMs: request.timeoutMs }),
      };
      const response = await this.limiter.run(() => this.backend.generate(backendRequest));
      addUsage(usage, response.usage);

      const base = {
        text: response.text,
        usage,
        backend: this.backend.name,
        model: response.model,
        attempts: attempt,
      };

      if (!schema) {
        return { ...base, data: undefined, durationMs: elapsed(started) };
      }

      const parsed = parseWithSchema(response, schema);
      if (parsed.ok) {
        return { ...base, data: parsed.data, durationMs: elapsed(started) };
      }
      if (attempt >= maxAttempts) {
        throw new SchemaValidationError(
          `Réponse invalide après ${attempt} tentative(s) : ${parsed.error}`,
          response.text,
          attempt,
        );
      }
      messages.push(
        { role: "assistant", content: response.text },
        { role: "user", content: buildRepairPrompt(parsed.error, jsonSchema) },
      );
    }
  }
}

function addUsage(total: Usage, add: Usage): void {
  total.inputTokens += add.inputTokens;
  total.outputTokens += add.outputTokens;
  for (const key of ["cacheReadTokens", "cacheWriteTokens", "costUsd"] as const) {
    const v = add[key];
    if (v !== undefined) total[key] = (total[key] ?? 0) + v;
  }
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}
