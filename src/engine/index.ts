import type { AppConfig } from "../config";
import { AnthropicApiBackend } from "./backends/anthropic-api";
import { ClaudeCliBackend } from "./backends/claude-cli";
import { OllamaBackend } from "./backends/ollama";
import { Engine, type EngineOptions } from "./engine";
import type { Backend, BackendName } from "./types";

export * from "./types";
export { Engine, SchemaValidationError } from "./engine";
export { createLimiter } from "./limiter";
export { extractJson } from "./json";

export const BACKEND_NAMES: readonly BackendName[] = ["claude-cli", "ollama", "anthropic-api"];

export function createBackend(name: BackendName, config: AppConfig): Backend {
  switch (name) {
    case "claude-cli":
      return new ClaudeCliBackend({
        bin: config.CLAUDE_CLI_PATH,
        model: config.CLAUDE_CLI_MODEL,
        concurrency: config.CLAUDE_CLI_CONCURRENCY,
        timeoutMs: config.CLAUDE_CLI_TIMEOUT_MS,
      });
    case "ollama":
      return new OllamaBackend({
        baseUrl: config.OLLAMA_BASE_URL,
        model: config.OLLAMA_MODEL,
        numCtx: config.OLLAMA_NUM_CTX,
        concurrency: config.OLLAMA_CONCURRENCY,
        timeoutMs: config.OLLAMA_TIMEOUT_MS,
      });
    case "anthropic-api":
      return new AnthropicApiBackend();
  }
}

/**
 * Un moteur par backend, partagé dans le processus : la limite de concurrence
 * vaut pour tout le processus, pas pour chaque appelant.
 */
const engines = new Map<BackendName, Engine>();

export function getEngine(name: BackendName, config: AppConfig, options?: EngineOptions): Engine {
  let engine = engines.get(name);
  if (!engine) {
    engine = new Engine(createBackend(name, config), options);
    engines.set(name, engine);
  }
  return engine;
}
