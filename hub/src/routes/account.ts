import { randomBytes, randomInt } from "node:crypto";
import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import {
  createTokenRequest,
  DEFAULT_TOKEN_SCOPES,
  deviceApproveRequest,
  deviceCodeRequest,
  deviceLookupRequest,
  deviceTokenRequest,
  legalDocName,
  legalLang,
  updateMeRequest,
  type HubScope,
} from "../../../src/hub/contract";
import type { HubDb } from "../../db/client";
import { apiTokens, deviceCodes, modules, namespaces, reviews, stars, users } from "../../db/schema";
import { allowedScopes, hashSecret, isReservedNamespace, newPersonalToken, type Principal, type User } from "../auth";
import { PublishError } from "../module-check";
import { iso, parseBody, parseWith, readJsonOrEmpty, smallBody, takeWrite, type CollabContext, type HubApp } from "./common";

/**
 * Compte (GET/PATCH/DELETE /v1/me), jetons personnels (/v1/me/tokens), flux d'appareil de
 * `personas hub login` (/v1/device/*), clés de signature (/v1/keys) et textes légaux (/v1/legal).
 */

const DAY = 86_400_000;
const DEVICE_TTL_SEC = 15 * 60;
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ"; // sans voyelles ni caractères ambigus

const meOf = (p: Principal, changeable: boolean) => ({
  id: p.user.id,
  email: p.user.email,
  displayName: p.user.displayName,
  githubLogin: p.user.githubLogin,
  role: p.user.role,
  namespace: p.user.namespace,
  namespaceChangeable: changeable,
  createdAt: iso(p.user.createdAt)!,
  via: p.via,
  scopes: [...p.scopes],
});

const tokenInfoOf = (t: typeof apiTokens.$inferSelect) => ({
  id: t.id,
  name: t.name,
  prefix: t.prefix,
  scopes: t.scopes,
  createdAt: iso(t.createdAt)!,
  expiresAt: iso(t.expiresAt)!,
  lastUsedAt: iso(t.lastUsedAt),
  revokedAt: iso(t.revokedAt),
});

/** Crée un jeton personnel ; portées limitées à celles du rôle. */
export async function issueToken(db: HubDb, user: User, input: { name: string; scopes: HubScope[]; expiresInDays: number }) {
  const allowed = new Set(allowedScopes(user.role));
  const refused = input.scopes.filter((s) => !allowed.has(s));
  if (refused.length) throw new PublishError(403, "unauthorized", `Portée non autorisée pour ce compte : ${refused.join(", ")}.`);
  const live = await db.select({ n: sql<number>`count(*)::int` }).from(apiTokens).where(and(eq(apiTokens.userId, user.id), isNull(apiTokens.revokedAt)));
  if ((live[0]?.n ?? 0) >= 50) throw new PublishError(422, "invalid", "50 jetons actifs au plus : en révoquer d'abord.");
  const t = newPersonalToken();
  const [row] = await db
    .insert(apiTokens)
    .values({ userId: user.id, name: input.name, prefix: t.prefix, hash: t.hash, scopes: [...new Set(input.scopes)], expiresAt: new Date(Date.now() + input.expiresInDays * DAY) })
    .returning();
  return { ...tokenInfoOf(row!), token: t.token };
}

const normalizeUserCode = (s: string) => s.toUpperCase().replace(/[^A-Z]/g, "");
const formatUserCode = (s: string) => `${s.slice(0, 4)}-${s.slice(4)}`;
const newUserCode = () => Array.from({ length: 8 }, () => USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)]).join("");

function deviceState(d: typeof deviceCodes.$inferSelect): "pending" | "approved" | "denied" | "consumed" | "expired" {
  if (d.consumedAt) return "consumed";
  if (d.deniedAt) return "denied";
  if (new Date(d.expiresAt).getTime() <= Date.now()) return "expired";
  return d.approvedAt ? "approved" : "pending";
}

export function registerAccountRoutes(app: HubApp, ctx: CollabContext) {
  const { db, auth } = ctx;

  // ── Compte ──────────────────────────────────────────────────────────────

  app.get("/v1/me", async (c) => {
    const p = await auth.authenticate(c);
    const changeable = !p.user.namespaceChanged && (await auth.namespaceIsEmpty(p.user.namespace));
    c.header("Cache-Control", "no-store");
    return c.json(meOf(p, changeable));
  });

  app.patch("/v1/me", smallBody, async (c) => {
    const p = await auth.authenticate(c, { jwtOnly: true });
    takeWrite(ctx, p);
    const body = await parseBody(c, updateMeRequest);
    let user = p.user;
    if (body.displayName !== undefined) [user] = (await db.update(users).set({ displayName: body.displayName }).where(eq(users.id, user.id)).returning()) as [User];
    if (body.namespace !== undefined && body.namespace !== user.namespace) {
      const next = body.namespace;
      if (user.namespaceChanged) throw new PublishError(409, "conflict", "Le namespace ne peut être changé qu'une fois.");
      if (isReservedNamespace(next)) throw new PublishError(403, "unauthorized", `Le namespace « ${next} » est réservé.`);
      if (!(await auth.namespaceIsEmpty(user.namespace))) throw new PublishError(409, "conflict", "Namespace déjà utilisé par des publications : il ne peut plus changer (des études y sont épinglées).");
      const old = user.namespace;
      try {
        user = await db.transaction(async (tx) => {
          const [taken] = await tx.select({ slug: namespaces.slug }).from(namespaces).where(eq(namespaces.slug, next));
          if (taken) throw new PublishError(409, "conflict", `Le namespace « ${next} » est déjà pris.`);
          await tx.insert(namespaces).values({ slug: next, ownerUserId: user.id, verified: false });
          const [u] = await tx.update(users).set({ namespace: next, namespaceChanged: true }).where(eq(users.id, user.id)).returning();
          await tx.delete(namespaces).where(and(eq(namespaces.slug, old), eq(namespaces.ownerUserId, user.id)));
          return u!;
        });
      } catch (err) {
        if (err instanceof PublishError) throw err;
        throw new PublishError(409, "conflict", `Le namespace « ${next} » est déjà pris.`);
      }
    }
    const changeable = !user.namespaceChanged && (await auth.namespaceIsEmpty(user.namespace));
    return c.json(meOf({ ...p, user }, changeable));
  });

  /**
   * Suppression de compte en libre-service (session web seulement) : e-mail, nom et GitHub effacés,
   * jetons révoqués, étoiles et avis retirés. Les versions publiées restent (des études y sont
   * épinglées), attribuées à « auteur supprimé » ; le namespace reste réservé.
   */
  app.delete("/v1/me", async (c) => {
    const p = await auth.authenticate(c, { jwtOnly: true });
    const id = p.user.id;
    await db.transaction(async (tx) => {
      const mine = await tx.select({ moduleId: stars.moduleId }).from(stars).where(eq(stars.userId, id));
      for (const s of mine) await tx.update(modules).set({ starCount: sql`greatest(${modules.starCount} - 1, 0)` }).where(eq(modules.id, s.moduleId));
      await tx.delete(stars).where(eq(stars.userId, id));
      await tx.delete(reviews).where(eq(reviews.userId, id));
      await tx.update(apiTokens).set({ revokedAt: new Date() }).where(and(eq(apiTokens.userId, id), isNull(apiTokens.revokedAt)));
      await tx.update(deviceCodes).set({ deniedAt: new Date() }).where(and(eq(deviceCodes.approvedBy, id), isNull(deviceCodes.consumedAt)));
      await tx.update(users).set({ email: null, displayName: null, githubId: null, githubLogin: null, deletedAt: new Date() }).where(eq(users.id, id));
    });
    ctx.invalidate();
    return c.json({ deleted: true, namespace: p.user.namespace, note: "Versions publiées conservées, attribuées à « auteur supprimé »." });
  });

  // ── Jetons personnels ───────────────────────────────────────────────────

  app.get("/v1/me/tokens", async (c) => {
    const p = await auth.authenticate(c);
    const rows = await db.select().from(apiTokens).where(eq(apiTokens.userId, p.user.id)).orderBy(desc(apiTokens.createdAt));
    c.header("Cache-Control", "no-store");
    return c.json({ tokens: rows.map(tokenInfoOf) });
  });

  app.post("/v1/me/tokens", smallBody, async (c) => {
    const p = await auth.authenticate(c, { jwtOnly: true });
    takeWrite(ctx, p);
    const body = await parseBody(c, createTokenRequest);
    return c.json(await issueToken(db, p.user, body), 201);
  });

  app.delete("/v1/me/tokens/:id", async (c) => {
    const p = await auth.authenticate(c);
    const id = c.req.param("id");
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new PublishError(404, "not_found", "Jeton introuvable.");
    const [row] = await db
      .update(apiTokens)
      .set({ revokedAt: sql`coalesce(${apiTokens.revokedAt}, now())` })
      .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, p.user.id)))
      .returning();
    if (!row) throw new PublishError(404, "not_found", "Jeton introuvable.");
    return c.json(tokenInfoOf(row));
  });

  // ── Flux d'appareil (personas hub login) ────────────────────────────────

  app.post("/v1/device/code", smallBody, async (c) => {
    const body = { data: parseWith(deviceCodeRequest, await readJsonOrEmpty(c)) };
    await db.delete(deviceCodes).where(lt(deviceCodes.expiresAt, new Date(Date.now() - DAY)));
    const deviceCode = randomBytes(32).toString("base64url");
    const interval = ctx.deviceIntervalSec;
    for (let attempt = 0; attempt < 5; attempt++) {
      const userCode = newUserCode();
      try {
        await db.insert(deviceCodes).values({
          deviceCodeHash: hashSecret(deviceCode),
          userCode,
          clientName: body.data.clientName ?? "personas CLI",
          scopes: body.data.scopes ?? DEFAULT_TOKEN_SCOPES,
          intervalSec: interval,
          expiresAt: new Date(Date.now() + DEVICE_TTL_SEC * 1000),
        });
        const uri = `${ctx.publicBaseUrl.replace(/\/+$/, "")}/device`;
        return c.json({ device_code: deviceCode, user_code: formatUserCode(userCode), verification_uri: uri, verification_uri_complete: `${uri}?code=${formatUserCode(userCode)}`, expires_in: DEVICE_TTL_SEC, interval }, 201);
      } catch {
        // code utilisateur déjà attribué : nouveau tirage
      }
    }
    throw new Error("device code: allocation impossible");
  });

  const findByUserCode = async (code: string) => {
    const [d] = await db.select().from(deviceCodes).where(eq(deviceCodes.userCode, normalizeUserCode(code)));
    if (!d) throw new PublishError(404, "not_found", "Code inconnu : vérifier le code affiché par le terminal.", "unknown_code");
    return d;
  };
  const deviceInfo = (d: typeof deviceCodes.$inferSelect) => ({ clientName: d.clientName, scopes: d.scopes, expiresAt: iso(d.expiresAt)!, state: deviceState(d) });

  /** Informations d'un code (page de validation authentifiée), avant approbation. */
  app.post("/v1/device/lookup", smallBody, async (c) => {
    await auth.authenticate(c, { jwtOnly: true });
    const body = await parseBody(c, deviceLookupRequest);
    return c.json(deviceInfo(await findByUserCode(body.user_code)));
  });

  /** Approbation (ou refus) par la page web authentifiée (session Supabase). */
  app.post("/v1/device/approve", smallBody, async (c) => {
    const p = await auth.authenticate(c, { jwtOnly: true });
    takeWrite(ctx, p);
    const body = await parseBody(c, deviceApproveRequest);
    const d = await findByUserCode(body.user_code);
    const state = deviceState(d);
    if (state !== "pending") throw new PublishError(410, "invalid", `Ce code n'est plus valable (${state}).`, state);
    const allowed = new Set(allowedScopes(p.user.role));
    const [row] = await db
      .update(deviceCodes)
      .set(body.approve ? { approvedBy: p.user.id, approvedAt: new Date(), scopes: d.scopes.filter((s) => allowed.has(s)) } : { deniedAt: new Date() })
      .where(and(eq(deviceCodes.id, d.id), isNull(deviceCodes.approvedAt), isNull(deviceCodes.deniedAt)))
      .returning();
    if (!row) throw new PublishError(409, "conflict", "Code déjà traité.", "already_decided");
    return c.json(deviceInfo(row));
  });

  /** Sondage par la CLI : 202 tant que l'utilisateur n'a pas validé, 200 avec le jeton personnel. */
  app.post("/v1/device/token", smallBody, async (c) => {
    const body = await parseBody(c, deviceTokenRequest);
    const [d] = await db.select().from(deviceCodes).where(eq(deviceCodes.deviceCodeHash, hashSecret(body.device_code)));
    if (!d) throw new PublishError(404, "not_found", "Code d'appareil inconnu.");
    const state = deviceState(d);
    if (state === "denied") return c.json({ status: "access_denied", message: "Connexion refusée dans le navigateur." }, 410);
    if (state === "expired" || state === "consumed") return c.json({ status: "expired_token", message: state === "consumed" ? "Code déjà utilisé." : "Code expiré : relancer personas hub login." }, 410);
    if (state === "pending") {
      const last = d.lastPolledAt ? new Date(d.lastPolledAt).getTime() : 0;
      await db.update(deviceCodes).set({ lastPolledAt: new Date() }).where(eq(deviceCodes.id, d.id));
      const tooFast = d.intervalSec > 0 && Date.now() - last < d.intervalSec * 1000;
      return c.json({ status: tooFast ? "slow_down" : "authorization_pending", interval: tooFast ? d.intervalSec + 5 : d.intervalSec }, 202);
    }
    // Approuvé : un seul jeton par code (mise à jour conditionnelle)
    const [claimed] = await db.update(deviceCodes).set({ consumedAt: new Date() }).where(and(eq(deviceCodes.id, d.id), isNull(deviceCodes.consumedAt))).returning();
    if (!claimed) return c.json({ status: "expired_token", message: "Code déjà utilisé." }, 410);
    const [user] = await db.select().from(users).where(eq(users.id, d.approvedBy!));
    if (!user || user.deletedAt) return c.json({ status: "access_denied", message: "Compte indisponible." }, 410);
    const t = await issueToken(db, user, { name: d.clientName, scopes: d.scopes.length ? d.scopes : DEFAULT_TOKEN_SCOPES, expiresInDays: 90 });
    await db.update(deviceCodes).set({ tokenId: t.id }).where(eq(deviceCodes.id, d.id));
    c.header("Cache-Control", "no-store");
    return c.json({ status: "approved", token: t.token, tokenType: "bearer", id: t.id, prefix: t.prefix, scopes: t.scopes, expiresAt: t.expiresAt });
  });

  // ── Clés de signature, textes légaux ────────────────────────────────────

  app.get("/v1/keys", (c) => {
    c.header("Cache-Control", "public, max-age=3600");
    const s = ctx.signer;
    return c.json({
      keys: s ? [{ kid: s.kid, alg: "Ed25519", publicKey: s.publicKey, jwk: s.jwk }] : [],
      payload: 'Ed25519 sur le JSON compact {"ref","version","sha256","publishedAt"} (clés dans cet ordre, publishedAt ISO renvoyé par l\'API) ; signature en base64.',
    });
  });

  app.get("/v1/legal", (c) => {
    c.header("Cache-Control", "public, max-age=3600");
    return c.json({ docs: [...ctx.legal].map(([key, v]) => { const [doc, lang] = key.split("."); return { doc, lang, version: v.version, path: `/v1/legal/${doc}?lang=${lang}` }; }) });
  });

  app.get("/v1/legal/:doc", (c) => {
    const doc = legalDocName.safeParse(c.req.param("doc"));
    const lang = legalLang.safeParse(c.req.query("lang") ?? "fr");
    if (!doc.success || !lang.success) throw new PublishError(404, "not_found", "Document introuvable (terms, privacy ; lang=fr|en).");
    const v = ctx.legal.get(`${doc.data}.${lang.data}`);
    if (!v) throw new PublishError(404, "not_found", "Document introuvable.");
    c.header("Cache-Control", "public, max-age=3600");
    return c.json({ doc: doc.data, lang: lang.data, version: v.version, markdown: v.markdown });
  });
}
