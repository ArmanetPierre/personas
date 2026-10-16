import { z } from "zod";

/** Plafond dur de concurrence pour Ollama : le serveur peut être partagé avec d'autres services. */
export const OLLAMA_MAX_CONCURRENCY = 2;

let envLoaded = false;

/** Charge `.env` s'il existe (sans écraser les variables déjà définies). */
export function loadDotEnv(path = ".env"): void {
  if (envLoaded) return;
  envLoaded = true;
  try {
    process.loadEnvFile(path);
  } catch {
    // Pas de .env : on garde les valeurs par défaut.
  }
}

const intFromEnv = (fallback: number) =>
  z.coerce.number().int().positive().default(fallback);

const configSchema = z.object({
  DATABASE_PATH: z.string().min(1).default("./data/personas.db"),
  CLAUDE_CLI_PATH: z.string().min(1).default("claude"),
  CLAUDE_CLI_MODEL: z.string().min(1).default("sonnet"),
  CLAUDE_CLI_CONCURRENCY: intFromEnv(2),
  CLAUDE_CLI_TIMEOUT_MS: intFromEnv(300_000),
  OLLAMA_BASE_URL: z.url().default("http://localhost:11434"),
  OLLAMA_MODEL: z.string().min(1).default("qwen3:8b"),
  OLLAMA_NUM_CTX: intFromEnv(32_768),
  OLLAMA_CONCURRENCY: intFromEnv(OLLAMA_MAX_CONCURRENCY),
  OLLAMA_TIMEOUT_MS: intFromEnv(600_000),
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const raw = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v !== ""),
  );
  return configSchema.parse(raw);
}
