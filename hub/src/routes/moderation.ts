import { eq, inArray, ne, or } from "drizzle-orm";
import type { Context } from "hono";
import { z } from "zod";
import { moderationEventRequest } from "../../../src/hub/contract";
import { modules, moduleVersions, packs, packVersions, reports, reviews, users, type ReportTargetKind } from "../../db/schema";
import { TOKEN_PREFIX } from "../auth";
import { applyModeration, resolveTarget } from "../moderation";
import { PublishError } from "../module-check";
import { DELETED_AUTHOR, iso, parseBody, parseWith, smallBody, type CollabContext, type HubApp } from "./common";

/**
 * File de revue et événements de modération (§ 11.5), points d'accroche de l'agent de modération :
 *  - GET /v1/admin/review-queue : versions `unverified` ou `flagged`, et toute cible signalée (avis compris) ;
 *  - POST /v1/admin/moderation-events : verify, flag, yank, remove, restore, avec preuves.
 * Accès : jeton d'administration (HUB_ADMIN_TOKEN), ou jeton personnel / session portant la portée
 * `moderation` (rôles moderator et admin).
 */

const queueQuery = z.object({
  kind: z.enum(["module_version", "pack_version", "review"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** `1` : fichiers complets des packs (sinon noms et tailles). */
  files: z.enum(["0", "1"]).default("0"),
});

const author = (u: { displayName: string | null; deletedAt: Date | null; namespace: string } | null) => (u ? (u.deletedAt ? DELETED_AUTHOR : (u.displayName ?? u.namespace)) : null);

export function registerModerationRoutes(app: HubApp, ctx: CollabContext) {
  const { db, auth } = ctx;

  const moderator = async (c: Context): Promise<{ actor: "admin" | "moderator"; userId: string | null }> => {
    const bearer = auth.bearerOf(c);
    if (bearer && !bearer.startsWith(TOKEN_PREFIX) && ctx.adminToken && ctx.tokenMatches(bearer, ctx.adminToken)) return { actor: "admin", userId: null };
    const p = await auth.authenticate(c, { scopes: ["moderation"] });
    return { actor: p.user.role === "admin" ? "admin" : "moderator", userId: p.user.id };
  };

  app.get("/v1/admin/review-queue", async (c) => {
    await moderator(c);
    const q = parseWith(queueQuery, { kind: c.req.query("kind") || undefined, limit: c.req.query("limit") ?? undefined, files: c.req.query("files") ?? undefined });
    const open = await db.select().from(reports).where(ne(reports.state, "closed"));
    const reportsBy = new Map<string, typeof open>();
    for (const r of open) reportsBy.set(`${r.targetKind}:${r.targetId}`, [...(reportsBy.get(`${r.targetKind}:${r.targetId}`) ?? []), r]);
    const reportedIds = (kind: ReportTargetKind) => open.filter((r) => r.targetKind === kind).map((r) => r.targetId);
    const reportsOf = (kind: ReportTargetKind, id: string) => (reportsBy.get(`${kind}:${id}`) ?? []).map((r) => ({ id: r.id, reason: r.reason, body: r.body, state: r.state, createdAt: iso(r.createdAt)! }));
    const userCols = { displayName: users.displayName, deletedAt: users.deletedAt, namespace: users.namespace };
    const items: Array<Record<string, unknown> & { status: string; publishedAt: string; reports: unknown[] }> = [];

    if (!q.kind || q.kind === "module_version") {
      const ids = reportedIds("module_version");
      const rows = await db
        .select({ v: moduleVersions, ns: modules.namespace, slug: modules.slug, u: userCols })
        .from(moduleVersions)
        .innerJoin(modules, eq(modules.id, moduleVersions.moduleId))
        .leftJoin(users, eq(users.id, moduleVersions.publishedBy))
        .where(or(inArray(moduleVersions.status, ["unverified", "flagged"]), ids.length ? inArray(moduleVersions.id, ids) : undefined));
      for (const r of rows)
        items.push({ kind: "module_version", id: r.v.id, ref: `${r.ns}/${r.slug}`, version: r.v.version, status: r.v.status, publishedAt: iso(r.v.publishedAt)!, author: author(r.u), content: r.v.yaml, lint: r.v.lint ?? null, sensitive: r.v.sensitive, reports: reportsOf("module_version", r.v.id) });
    }
    if (!q.kind || q.kind === "pack_version") {
      const ids = reportedIds("pack_version");
      const rows = await db
        .select({ v: packVersions, ns: packs.namespace, slug: packs.slug, u: userCols })
        .from(packVersions)
        .innerJoin(packs, eq(packs.id, packVersions.packId))
        .leftJoin(users, eq(users.id, packVersions.publishedBy))
        .where(or(inArray(packVersions.status, ["unverified", "flagged"]), ids.length ? inArray(packVersions.id, ids) : undefined));
      for (const r of rows) {
        const content = q.files === "1" ? r.v.files : Object.fromEntries(Object.entries(r.v.files).map(([k, v]) => [k, { bytes: Buffer.byteLength(v, "utf8") }]));
        items.push({ kind: "pack_version", id: r.v.id, ref: `${r.ns}/${r.slug}`, version: r.v.version, status: r.v.status, publishedAt: iso(r.v.publishedAt)!, author: author(r.u), content, lint: null, sensitive: [], reports: reportsOf("pack_version", r.v.id) });
      }
    }
    if (!q.kind || q.kind === "review") {
      const ids = reportedIds("review");
      if (ids.length) {
        const rows = await db
          .select({ r: reviews, ns: modules.namespace, slug: modules.slug, version: moduleVersions.version, u: userCols })
          .from(reviews)
          .innerJoin(moduleVersions, eq(moduleVersions.id, reviews.versionId))
          .innerJoin(modules, eq(modules.id, moduleVersions.moduleId))
          .leftJoin(users, eq(users.id, reviews.userId))
          .where(inArray(reviews.id, ids));
        for (const r of rows)
          items.push({ kind: "review", id: r.r.id, ref: `${r.ns}/${r.slug}`, version: r.version, status: r.r.hidden ? "hidden" : "visible", publishedAt: iso(r.r.updatedAt)!, author: author(r.u), content: { rating: r.r.rating, body: r.r.body }, lint: null, sensitive: [], reports: reportsOf("review", r.r.id) });
      }
    }
    // Signalées d'abord, puis le plus de signalements, puis la plus ancienne
    const rank = (s: string) => (s === "flagged" || s === "hidden" ? 0 : 1);
    items.sort((a, b) => rank(a.status) - rank(b.status) || b.reports.length - a.reports.length || a.publishedAt.localeCompare(b.publishedAt));
    c.header("Cache-Control", "no-store");
    return c.json({ items: items.slice(0, q.limit) });
  });

  app.post("/v1/admin/moderation-events", smallBody, async (c) => {
    const who = await moderator(c);
    const body = await parseBody(c, moderationEventRequest);
    const target = await resolveTarget(db, body.target);
    if (target.status === "removed" && body.action !== "restore") throw new PublishError(409, "conflict", "Version retirée : seule l'action restore s'applique.");
    // L'agent de modération se déclare `agent` ; un modérateur ne peut pas se déclarer administrateur
    const actor = body.actor === "agent" ? "agent" : who.actor;
    const ev = await applyModeration(db, target, { action: body.action, actor, actorUserId: who.userId, evidence: body.evidence, note: body.note });
    ctx.invalidate();
    return c.json({ id: ev.id, targetKind: ev.targetKind, targetId: ev.targetId, action: body.action, fromStatus: ev.fromStatus, toStatus: ev.toStatus }, 201);
  });

  // Les autres routes /v1/admin/* restent celles de l'administration (jeton HUB_ADMIN_TOKEN).
}
