import type { Availability, Backend, BackendResponse } from "../types";

/**
 * Emplacement réservé. L'API Anthropic est payante : ce backend ne sera écrit
 * que sur demande explicite (usage partagé ou produit ouvert).
 */
export class AnthropicApiBackend implements Backend {
  readonly name = "anthropic-api" as const;
  readonly model = "non configuré";
  readonly concurrency = 1;

  async checkAvailability(): Promise<Availability> {
    return { ok: false, detail: "Backend anthropic-api non implémenté (API payante, désactivée)." };
  }

  async generate(): Promise<BackendResponse> {
    throw new Error(
      "Backend anthropic-api non implémenté : désactivé tant que la prise en charge des clés API n'est pas livrée.",
    );
  }
}
