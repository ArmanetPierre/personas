import { createHash } from "node:crypto";
import { lt, sql } from "drizzle-orm";
import { OFFICIAL_NAMESPACE, telemetryRequest } from "../../../src/hub/contract";
import { usageDaily, usageInstalls } from "../../db/schema";
import { findModuleVersion } from "../repo";
import { parseBody, smallBody, type CollabContext, type HubApp } from "./common";

/**
 * Télémétrie opt-in (docs/plateforme.md § 11.2) : POST /v1/telemetry, anonyme. Le Hub ne garde que
 * l'agrégat quotidien par version (`usage_daily` : installations distinctes, études, personas) ;
 * l'empreinte de l'identifiant d'installation tournant sert au dédoublonnage du jour et est purgée
 * après 30 jours. Aucun en-tête d'authentification n'est lu : la télémétrie n'est jamais liée au compte.
 * Socle, protocole, version du moteur et famille de modèle sont validés (formats courts, sans texte
 * libre) mais pas conservés pour l'instant.
 */

const RETENTION_DAYS = 30;
const MAX_LAG_DAYS = 14;

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

export function registerTelemetryRoutes(app: HubApp, ctx: CollabContext) {
  const { db } = ctx;

  app.post("/v1/telemetry", smallBody, async (c) => {
    const body = await parseBody(c, telemetryRequest);
    const installHash = createHash("sha256").update(`personas-install:${body.installId}`).digest("hex");
    const versionIds = new Map<string, string | null>();
    const resolve = async (spec: string) => {
      if (!versionIds.has(spec)) {
        const [refPart, version] = spec.split("@") as [string, string];
        const [ns, slug] = refPart.includes("/") ? (refPart.split("/") as [string, string]) : [OFFICIAL_NAMESPACE, refPart];
        const f = await findModuleVersion(db, ns, slug, version);
        versionIds.set(spec, f && f.version.status !== "removed" ? f.version.id : null);
      }
      return versionIds.get(spec)!;
    };
    let accepted = 0;
    let ignored = 0;
    const minDay = daysAgo(MAX_LAG_DAYS);
    for (const s of body.studies) {
      const day = s.day && s.day >= minDay && s.day <= today() ? s.day : today();
      const ids = [...new Set((await Promise.all(s.modules.map(resolve))).filter((x): x is string => !!x))];
      ignored += s.modules.length - ids.length;
      if (!ids.length) continue;
      accepted++;
      for (const versionId of ids) {
        const fresh = await db.insert(usageInstalls).values({ versionId, day, installHash }).onConflictDoNothing().returning();
        const inst = fresh.length ? 1 : 0;
        await db
          .insert(usageDaily)
          .values({ versionId, day, installs: inst, studies: 1, personas: s.personas })
          .onConflictDoUpdate({
            target: [usageDaily.versionId, usageDaily.day],
            set: { installs: sql`${usageDaily.installs} + ${inst}`, studies: sql`${usageDaily.studies} + 1`, personas: sql`${usageDaily.personas} + ${s.personas}` },
          });
      }
    }
    await db.delete(usageInstalls).where(lt(usageInstalls.day, daysAgo(RETENTION_DAYS)));
    if (accepted) ctx.invalidate();
    return c.json({ accepted, ignored }, 202);
  });
}
