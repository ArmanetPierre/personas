import { and, eq, ne, sql } from "drizzle-orm";
import { OFFICIAL_NAMESPACE } from "../../src/hub/contract";
import type { HubDb } from "./../db/client";
import { moderationEvents, modules, moduleVersions, packs, packVersions, reports, reviews, type ReportTargetKind, type VersionStatus } from "../db/schema";
import { PublishError } from "./module-check";
import { findModuleVersion, findPackVersion } from "./repo";

/**
 * Points d'accroche de la modération (docs/plateforme.md § 11.5) : résolution des cibles,
 * changements de statut journalisés dans moderation_events, passage automatique en `flagged`
 * à 3 signalements distincts.
 */

export const AUTO_FLAG_REPORTS = 3;

export type TargetSpec = { kind: "module_version" | "pack_version"; ref: string; version: string } | { kind: ReportTargetKind; id: string };

export interface ResolvedTarget {
  kind: ReportTargetKind;
  id: string;
  /** Statut de version, ou `hidden` / `visible` pour un avis. */
  status: string;
  namespace: string | null;
  label: string;
}

const splitRef = (ref: string) => {
  const i = ref.indexOf("/");
  return [ref.slice(0, i), ref.slice(i + 1)] as const;
};

export async function resolveTarget(db: HubDb, t: TargetSpec): Promise<ResolvedTarget> {
  const notFound = () => new PublishError(404, "not_found", "Cible introuvable.");
  if (t.kind === "review") {
    if (!("id" in t)) throw notFound();
    const [r] = await db
      .select({ id: reviews.id, hidden: reviews.hidden, ns: modules.namespace, slug: modules.slug, version: moduleVersions.version })
      .from(reviews)
      .innerJoin(moduleVersions, eq(moduleVersions.id, reviews.versionId))
      .innerJoin(modules, eq(modules.id, moduleVersions.moduleId))
      .where(eq(reviews.id, t.id));
    if (!r) throw notFound();
    return { kind: "review", id: r.id, status: r.hidden ? "hidden" : "visible", namespace: r.ns, label: `avis sur ${r.ns}/${r.slug}@${r.version}` };
  }
  if ("id" in t) {
    if (t.kind === "module_version") {
      const [r] = await db.select({ id: moduleVersions.id, status: moduleVersions.status, ns: modules.namespace, slug: modules.slug, version: moduleVersions.version }).from(moduleVersions).innerJoin(modules, eq(modules.id, moduleVersions.moduleId)).where(eq(moduleVersions.id, t.id));
      if (!r) throw notFound();
      return { kind: t.kind, id: r.id, status: r.status, namespace: r.ns, label: `${r.ns}/${r.slug}@${r.version}` };
    }
    const [r] = await db.select({ id: packVersions.id, status: packVersions.status, ns: packs.namespace, slug: packs.slug, version: packVersions.version }).from(packVersions).innerJoin(packs, eq(packs.id, packVersions.packId)).where(eq(packVersions.id, t.id));
    if (!r) throw notFound();
    return { kind: t.kind, id: r.id, status: r.status, namespace: r.ns, label: `${r.ns}/${r.slug}@${r.version}` };
  }
  const [ns, slug] = splitRef(t.ref);
  if (t.kind === "module_version") {
    const f = await findModuleVersion(db, ns, slug, t.version);
    if (!f) throw notFound();
    return { kind: t.kind, id: f.version.id, status: f.version.status, namespace: ns, label: `${t.ref}@${t.version}` };
  }
  const f = await findPackVersion(db, ns, slug, t.version);
  if (!f) throw notFound();
  return { kind: t.kind, id: f.version.id, status: f.version.status, namespace: ns, label: `${t.ref}@${t.version}` };
}

export type ModerationActionName = "verify" | "flag" | "yank" | "remove" | "restore";

/** Statut visé par une action (versions) ; pour un avis : masqué (flag, yank, remove) ou visible. */
function nextStatus(target: ResolvedTarget, action: ModerationActionName): string {
  if (target.kind === "review") return action === "verify" || action === "restore" ? "visible" : "hidden";
  const map: Record<ModerationActionName, VersionStatus> = {
    verify: "verified",
    flag: "flagged",
    yank: "yanked",
    remove: "removed",
    restore: target.namespace === OFFICIAL_NAMESPACE ? "verified" : "unverified",
  };
  return map[action];
}

/** Applique une action de modération et la journalise (avec ses preuves). */
export async function applyModeration(
  db: HubDb,
  target: ResolvedTarget,
  input: { action: ModerationActionName; actor: string; actorUserId: string | null; evidence: Record<string, unknown>; note?: string | undefined },
) {
  const to = nextStatus(target, input.action);
  return db.transaction(async (tx) => {
    if (target.kind === "module_version") await tx.update(moduleVersions).set({ status: to as VersionStatus }).where(eq(moduleVersions.id, target.id));
    else if (target.kind === "pack_version") await tx.update(packVersions).set({ status: to as VersionStatus }).where(eq(packVersions.id, target.id));
    else await tx.update(reviews).set({ hidden: to === "hidden" }).where(eq(reviews.id, target.id));
    // Signalements : triés par un `flag`, clos par toute autre décision
    await tx
      .update(reports)
      .set({ state: input.action === "flag" ? "triaged" : "closed" })
      .where(and(eq(reports.targetKind, target.kind), eq(reports.targetId, target.id), ne(reports.state, "closed")));
    const [ev] = await tx
      .insert(moderationEvents)
      .values({ targetKind: target.kind, targetId: target.id, actor: input.actor, actorUserId: input.actorUserId, action: input.action, fromStatus: target.status, toStatus: to, evidence: input.evidence, note: input.note ?? null })
      .returning();
    return ev!;
  });
}

/** Signalements ouverts (ou triés) d'une cible, un par utilisateur. */
export async function openReportCount(db: HubDb, kind: ReportTargetKind, id: string): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(distinct ${reports.reporterId})::int` })
    .from(reports)
    .where(and(eq(reports.targetKind, kind), eq(reports.targetId, id), ne(reports.state, "closed")));
  return r?.n ?? 0;
}

/**
 * Trois signalements distincts : la version passe en `flagged` (l'avis est masqué) en attendant la
 * revue. Les modules officiels (`personas/`) ne sont pas retirés automatiquement : ils restent en file.
 */
export async function maybeAutoFlag(db: HubDb, target: ResolvedTarget): Promise<string> {
  const n = await openReportCount(db, target.kind, target.id);
  if (n < AUTO_FLAG_REPORTS) return target.status;
  if (target.kind === "review" ? target.status === "hidden" : !["unverified", "verified", "published"].includes(target.status)) return target.status;
  if (target.kind !== "review" && target.namespace === OFFICIAL_NAMESPACE) return target.status;
  const reasons = await db.select({ reason: reports.reason }).from(reports).where(and(eq(reports.targetKind, target.kind), eq(reports.targetId, target.id), ne(reports.state, "closed")));
  const ev = await applyModeration(db, target, { action: "flag", actor: "system", actorUserId: null, evidence: { rule: `${AUTO_FLAG_REPORTS} signalements distincts`, reports: n, reasons: reasons.map((r) => r.reason) } });
  return ev.toStatus ?? target.status;
}
