import type { Context, Hono, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { z } from "zod";
import type { HubDb } from "../../db/client";
import type { Auth, Principal } from "../auth";
import type { LegalDocs } from "../legal";
import { PublishError } from "../module-check";
import type { PublishDeps } from "../publish";
import type { RateLimiter } from "../rate-limit";
import type { Signer } from "../signing";

/** Dépendances des routes du Hub collaboratif (phase 3), fournies par createHubApp. */
export interface CollabContext {
  db: HubDb;
  auth: Auth;
  signer: Signer | null;
  publish: PublishDeps;
  invalidate: () => void;
  publicBaseUrl: string;
  /** Jeton d'administration (HUB_ADMIN_TOKEN) : accepté aussi sur les routes de modération. */
  adminToken: string | undefined;
  tokenMatches: (given: string, expected: string) => boolean;
  /** Intervalle de sondage du flux d'appareil, en secondes (5 en production). */
  deviceIntervalSec: number;
  /** Écritures authentifiées, par utilisateur. */
  writeLimiter: RateLimiter;
  legal: LegalDocs;
}

export type HubApp = Hono;

export const errorBody = (code: string, message: string) => ({ error: { code, message } });

export async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new PublishError(422, "invalid", "Corps JSON illisible.");
  }
}

export function parseWith<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw new PublishError(422, "invalid", r.error.issues.map((i) => `${i.path.join(".") || "corps"} : ${i.message}`).join("; "));
  return r.data;
}

/** Corps JSON facultatif : vide → `{}`. */
export async function readJsonOrEmpty(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new PublishError(422, "invalid", "Corps JSON illisible.");
  }
}

export const parseBody = async <S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> => parseWith(schema, await readJson(c));

/** Quota d'écriture par utilisateur (publication, étoiles, avis, signalements). */
export function takeWrite(ctx: CollabContext, p: Principal): void {
  const r = ctx.writeLimiter.take(p.user.id);
  if (!r.ok) throw new PublishError(429, "rate_limited", `Trop d'écritures, réessayer dans ${r.retryAfterSec} s.`);
}

export const smallBody: MiddlewareHandler = bodyLimit({ maxSize: 32 * 1024, onError: (c) => c.json(errorBody("invalid", "Corps trop gros."), 413) });

export const iso = (t: string | Date | null) => (t === null ? null : new Date(t).toISOString());
export const DELETED_AUTHOR = "auteur supprimé";
