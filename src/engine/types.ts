import type { z } from "zod";

/** `anthropic-api` est réservé : payant, jamais sans demande explicite de l'utilisateur. */
export type BackendName = "claude-cli" | "ollama" | "anthropic-api";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Tokens lus depuis le cache de prompt, si le backend le rapporte. */
  cacheReadTokens?: number;
  /** Tokens écrits dans le cache de prompt, si le backend le rapporte. */
  cacheWriteTokens?: number;
  /** Coût indicatif en USD rapporté par le backend (claude-cli), 0 pour un modèle local. */
  costUsd?: number;
}

/** Requête envoyée à un backend : une seule tentative, sans validation. */
export interface BackendRequest {
  system: string;
  messages: ChatMessage[];
  /** JSON Schema à imposer nativement, si le backend sait le faire. */
  jsonSchema?: Record<string, unknown>;
  temperature?: number;
  maxTokens?: number;
  /**
   * Mode recherche (claude-cli seulement) : outils web autorisés pour cette requête, parmi
   * WebSearch et WebFetch. Absent : aucun outil (mode normal).
   */
  webTools?: Array<"WebSearch" | "WebFetch">;
  /** Délai propre à la requête (une recherche web prend plus de temps). */
  timeoutMs?: number;
}

export interface BackendResponse {
  text: string;
  /** Objet déjà structuré par le backend (sortie structurée native), s'il existe. */
  structured?: unknown;
  usage: Usage;
  model: string;
}

export interface Availability {
  ok: boolean;
  detail: string;
  /** Conseil d'action à afficher à l'utilisateur si `ok` est faux. */
  hint?: string;
}

export interface Backend {
  readonly name: BackendName;
  readonly model: string;
  /** Nombre maximal d'appels simultanés vers ce backend. */
  readonly concurrency: number;
  checkAvailability(): Promise<Availability>;
  generate(request: BackendRequest): Promise<BackendResponse>;
}

export interface CompleteRequest<S extends z.ZodType | undefined = undefined> {
  system: string;
  messages: ChatMessage[];
  schema?: S;
  temperature?: number;
  maxTokens?: number;
}

export interface CompleteResult<T> {
  /** Objet validé par le schéma (absent si aucun schéma n'a été fourni). */
  data: T;
  /** Texte brut de la dernière tentative. */
  text: string;
  /** Usage cumulé sur toutes les tentatives (réparations comprises). */
  usage: Usage;
  durationMs: number;
  backend: BackendName;
  model: string;
  /** 1 si la première réponse était valide, plus en cas de réparation. */
  attempts: number;
}
