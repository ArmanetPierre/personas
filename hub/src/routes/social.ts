import { and, asc, eq, sql } from "drizzle-orm";
import { reportRequest, reviewRequest } from "../../../src/hub/contract";
import { modules, namespaces, reports, reviews, stars, users } from "../../db/schema";
import type { Principal } from "../auth";
import { PublishError } from "../module-check";
import { maybeAutoFlag, resolveTarget } from "../moderation";
import { findModule, findModuleVersion } from "../repo";
import { DELETED_AUTHOR, iso, parseBody, smallBody, takeWrite, type CollabContext, type HubApp } from "./common";

/**
 * Étoiles (PUT/DELETE /v1/modules/:ns/:slug/star), avis sur une version (un par utilisateur et par
 * version, modifiable), signalements (POST /v1/reports). L'auteur d'un module ne peut ni l'étoiler
 * ni l'évaluer (le classement R ne doit pas pouvoir être gonflé par soi-même).
 */

/** Texte libre d'un avis : caractères de contrôle retirés (les pages échappent le HTML). */
const cleanText = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();

async function ownerOf(ctx: CollabContext, ns: string): Promise<string | null> {
  const [n] = await ctx.db.select({ owner: namespaces.ownerUserId }).from(namespaces).where(eq(namespaces.slug, ns));
  return n?.owner ?? null;
}

async function assertNotAuthor(ctx: CollabContext, p: Principal, ns: string, what: string) {
  if ((await ownerOf(ctx, ns)) === p.user.id) throw new PublishError(403, "unauthorized", `On ne peut pas ${what} son propre module.`);
}

export function registerSocialRoutes(app: HubApp, ctx: CollabContext) {
  const { db, auth } = ctx;

  const visibleModule = async (ns: string, slug: string) => {
    const m = await findModule(db, ns, slug);
    if (!m || m.status === "hidden") throw new PublishError(404, "not_found", "Module introuvable.");
    return m;
  };

  app.put("/v1/modules/:ns/:slug/star", async (c) => {
    const p = await auth.authenticate(c, { scopes: ["read"] });
    takeWrite(ctx, p);
    const { ns, slug } = c.req.param();
    const m = await visibleModule(ns, slug);
    await assertNotAuthor(ctx, p, ns, "étoiler");
    const count = await db.transaction(async (tx) => {
      const ins = await tx.insert(stars).values({ userId: p.user.id, moduleId: m.id }).onConflictDoNothing().returning();
      if (ins.length) await tx.update(modules).set({ starCount: sql`${modules.starCount} + 1` }).where(eq(modules.id, m.id));
      const [r] = await tx.select({ n: modules.starCount }).from(modules).where(eq(modules.id, m.id));
      return r!.n;
    });
    ctx.invalidate();
    return c.json({ ref: `${ns}/${slug}`, starred: true, stars: count });
  });

  app.delete("/v1/modules/:ns/:slug/star", async (c) => {
    const p = await auth.authenticate(c, { scopes: ["read"] });
    takeWrite(ctx, p);
    const { ns, slug } = c.req.param();
    const m = await visibleModule(ns, slug);
    const count = await db.transaction(async (tx) => {
      const del = await tx.delete(stars).where(and(eq(stars.userId, p.user.id), eq(stars.moduleId, m.id))).returning();
      if (del.length) await tx.update(modules).set({ starCount: sql`greatest(${modules.starCount} - 1, 0)` }).where(eq(modules.id, m.id));
      const [r] = await tx.select({ n: modules.starCount }).from(modules).where(eq(modules.id, m.id));
      return r!.n;
    });
    ctx.invalidate();
    return c.json({ ref: `${ns}/${slug}`, starred: false, stars: count });
  });

  const reviewableVersion = async (ns: string, slug: string, version: string) => {
    await visibleModule(ns, slug);
    const f = await findModuleVersion(db, ns, slug, version);
    if (!f || f.version.status === "removed") throw new PublishError(404, "not_found", "Version introuvable.");
    return f;
  };

  const reviewItemOf = (r: typeof reviews.$inferSelect, version: string, author: { displayName: string | null; deletedAt: Date | null; namespace: string } | null) => ({
    id: r.id,
    version,
    rating: r.rating,
    body: r.body,
    author: !author || author.deletedAt ? DELETED_AUTHOR : (author.displayName ?? author.namespace),
    createdAt: iso(r.createdAt)!,
    updatedAt: iso(r.updatedAt)!,
  });

  app.put("/v1/modules/:ns/:slug/:version/review", smallBody, async (c) => {
    const p = await auth.authenticate(c, { scopes: ["read"] });
    takeWrite(ctx, p);
    const { ns, slug, version } = c.req.param();
    const body = await parseBody(c, reviewRequest);
    const f = await reviewableVersion(ns, slug, version);
    await assertNotAuthor(ctx, p, ns, "évaluer");
    const text = cleanText(body.body);
    const [row] = await db
      .insert(reviews)
      .values({ userId: p.user.id, versionId: f.version.id, rating: body.rating, body: text })
      .onConflictDoUpdate({ target: [reviews.userId, reviews.versionId], set: { rating: body.rating, body: text, updatedAt: new Date() } })
      .returning();
    ctx.invalidate();
    return c.json(reviewItemOf(row!, version, p.user));
  });

  app.delete("/v1/modules/:ns/:slug/:version/review", async (c) => {
    const p = await auth.authenticate(c, { scopes: ["read"] });
    const { ns, slug, version } = c.req.param();
    const f = await reviewableVersion(ns, slug, version);
    const del = await db.delete(reviews).where(and(eq(reviews.userId, p.user.id), eq(reviews.versionId, f.version.id))).returning();
    if (!del.length) throw new PublishError(404, "not_found", "Aucun avis à supprimer.");
    ctx.invalidate();
    return c.json({ deleted: true });
  });

  app.get("/v1/modules/:ns/:slug/:version/reviews", async (c) => {
    const { ns, slug, version } = c.req.param();
    const f = await reviewableVersion(ns, slug, version);
    const rows = await db
      .select({ r: reviews, u: { displayName: users.displayName, deletedAt: users.deletedAt, namespace: users.namespace } })
      .from(reviews)
      .innerJoin(users, eq(users.id, reviews.userId))
      .where(and(eq(reviews.versionId, f.version.id), eq(reviews.hidden, false)))
      .orderBy(asc(reviews.createdAt));
    const count = rows.length;
    const mean = count ? Math.round((rows.reduce((s, x) => s + x.r.rating, 0) / count) * 100) / 100 : null;
    c.header("Cache-Control", "public, max-age=30");
    return c.json({ ref: `${ns}/${slug}`, version, count, mean, reviews: rows.map((x) => reviewItemOf(x.r, version, x.u)) });
  });

  // ── Signalements ────────────────────────────────────────────────────────

  app.post("/v1/reports", smallBody, async (c) => {
    const p = await auth.authenticate(c, { scopes: ["read"] });
    takeWrite(ctx, p);
    const body = await parseBody(c, reportRequest);
    const target = await resolveTarget(db, body.target);
    const [row] = await db
      .insert(reports)
      .values({ reporterId: p.user.id, targetKind: target.kind, targetId: target.id, reason: body.reason, body: cleanText(body.body) })
      .onConflictDoNothing()
      .returning();
    const existing = row ?? (await db.select().from(reports).where(and(eq(reports.reporterId, p.user.id), eq(reports.targetKind, target.kind), eq(reports.targetId, target.id))))[0]!;
    const status = await maybeAutoFlag(db, target);
    if (status !== target.status) ctx.invalidate();
    const [n] = await db.select({ n: sql<number>`count(*)::int` }).from(reports).where(and(eq(reports.targetKind, target.kind), eq(reports.targetId, target.id)));
    return c.json({ id: existing.id, reports: n?.n ?? 0, status }, row ? 201 : 200);
  });
}
