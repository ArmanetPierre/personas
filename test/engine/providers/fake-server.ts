import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { answerSchemaFor } from "../../../src/studies/protocols/concept-price";
import { narrativeBatchSchema } from "../../../src/personas/narrate";
import { targetSuggestionSchema } from "../../../src/population/suggest";
import { researchSchema } from "../../../src/modules/assistant/prompts";

/**
 * Faux serveur HTTP local pour les tests de contrat des fournisseurs : enregistre chaque requête et
 * renvoie les réponses programmées dans l'ordre (la dernière se répète). Aucun appel réseau sortant.
 */

export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: any;
  rawBody: string;
}

export interface FakeResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface FakeServer {
  url: string;
  requests: RecordedRequest[];
  /** Ajoute des réponses à la file. */
  reply(...responses: Array<FakeResponse | ((req: RecordedRequest) => FakeResponse)>): void;
  /** Remplace la file de réponses. */
  replyOnly(...responses: Array<FakeResponse | ((req: RecordedRequest) => FakeResponse)>): void;
  close(): Promise<void>;
}

export async function startFakeServer(): Promise<FakeServer> {
  const requests: RecordedRequest[] = [];
  const queue: Array<FakeResponse | ((req: RecordedRequest) => FakeResponse)> = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      let body: unknown;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      const rec: RecordedRequest = { method: req.method ?? "", path: req.url ?? "", headers: req.headers, body, rawBody: raw };
      requests.push(rec);
      const next = queue.length > 1 ? queue.shift()! : queue[0];
      const r = typeof next === "function" ? next(rec) : (next ?? { status: 500, body: { error: { message: "aucune réponse programmée" } } });
      res.writeHead(r.status ?? 200, { "content-type": "application/json", ...r.headers });
      res.end(typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    reply: (...r) => void queue.push(...r),
    replyOnly: (...r) => void queue.splice(0, queue.length, ...r),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export const noSleep = async () => {};

/** Clés factices : jamais de vraie clé dans les tests. */
export const FAKE_KEY = "test-provider-key-0123456789abcdef";

// ─── Schémas réels des protocoles ─────────────────────────────────────────────

export const TIERS = [3, 6, 9];
/** Répondant d'étude, protocole concept-price v3. */
export const conceptPriceV3 = answerSchemaFor(TIERS, undefined, "3");
/** Narrateur : lot de récits. */
export const narratives = narrativeBatchSchema;
/** Assistant de cible (valeurs par défaut). */
export const targetSuggestion = targetSuggestionSchema;
/** Assistant de modules : recherche (champs facultatifs). */
export const research = researchSchema;

export const jsonSchemaOf = (s: z.ZodType) => z.toJSONSchema(s, { target: "draft-7" }) as Record<string, unknown>;

/** Réponse v3 valide. */
export const validV3Answer = {
  needFrequency: "rarely",
  spontaneousReaction: "Encore une appli, je passe.",
  relevance: "not_concerned",
  relevanceReason: "Je n'ai pas ce besoin.",
  currentSolution: "Un carnet papier.",
  alternatives: ["carnet"],
  objections: [{ category: "no_need", detail: "Je n'en ai pas besoin." }],
  behavior: "ignore",
  behaviorReason: "Rien ne me manque.",
  wouldForward: false,
  forwardTo: "",
  vanWestendorp: { wouldNeverPay: true, tooCheapEur: null, cheapEur: null, expensiveEur: null, tooExpensiveEur: null },
  gaborGranger: { at_3_eur: false, at_6_eur: false, at_9_eur: false },
  budgetFit: "",
  verbatim: "Pas pour moi.",
};

/** Réponse de recherche : `values` et `justification` (facultatifs) rendus `null` par le mode strict. */
export const researchWithNulls = {
  summary: "Résumé.",
  sources: [],
  attributes: [
    {
      key: "a",
      label: "A",
      type: "boolean",
      values: null,
      conditioned_on: [],
      figures: [{ statement: "x", source_key: null }],
      assumption: true,
      justification: null,
    },
  ],
  notes: [],
};
