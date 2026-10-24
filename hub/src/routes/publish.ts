import { bodyLimit } from "hono/body-limit";
import { parseDocument } from "yaml";
import { forkRequest, OFFICIAL_NAMESPACE, userPublishModuleRequest, userPublishPackRequest } from "../../../src/hub/contract";
import type { Principal } from "../auth";
import { PublishError } from "../module-check";
import { MAX_PACK_BYTES } from "../pack-check";
import { publishModuleVersion, publishPackVersion } from "../publish";
import { findModuleVersion } from "../repo";
import { errorBody, parseBody, parseWith, readJsonOrEmpty, takeWrite, type CollabContext, type HubApp } from "./common";

/**
 * Publication par les utilisateurs (portées modules:publish, packs:publish), dans LEUR namespace
 * seulement ; `personas` est réservé au rôle admin. Même porte que l'administration (validation,
 * lint de sécurité, aperçu, Q, signature). Statut initial `unverified` : la version est visible tout de
 * suite avec le badge « non vérifié » et entre dans la file de revue (§ 11.5, choix retenu).
 */

const MODULE_BODY_LIMIT = 256 * 1024 * 2 + 4096;
const PACK_BODY_LIMIT = MAX_PACK_BYTES * 2 + 4096;

/** Namespace de publication : celui de l'appelant ; `personas` pour un administrateur. */
export function publishNamespace(p: Principal, requested: string | undefined): string {
  const ns = requested ?? p.user.namespace;
  if (ns === p.user.namespace) return ns;
  if (ns === OFFICIAL_NAMESPACE) {
    if (p.user.role === "admin") return ns;
    throw new PublishError(403, "unauthorized", "Le namespace « personas » est réservé aux modules officiels (administrateur).");
  }
  throw new PublishError(403, "unauthorized", `Publication refusée dans « ${ns} » : on ne publie que dans son namespace (${p.user.namespace}).`);
}

export function registerPublishRoutes(app: HubApp, ctx: CollabContext) {
  const { auth } = ctx;

  app.post(
    "/v1/modules",
    bodyLimit({ maxSize: MODULE_BODY_LIMIT, onError: (c) => c.json(errorBody("invalid", "Module trop gros (256 Ko au plus)."), 413) }),
    async (c) => {
      const p = await auth.authenticate(c, { scopes: ["modules:publish"] });
      takeWrite(ctx, p);
      const body = await parseBody(c, userPublishModuleRequest);
      const namespace = publishNamespace(p, body.namespace);
      const out = await publishModuleVersion(ctx.publish, { namespace, yaml: body.yaml, publishedBy: p.user.id });
      return c.json(out, 201);
    },
  );

  app.post(
    "/v1/packs",
    bodyLimit({ maxSize: PACK_BODY_LIMIT, onError: (c) => c.json(errorBody("invalid", "Pack trop gros (5 Mo au plus)."), 413) }),
    async (c) => {
      const p = await auth.authenticate(c, { scopes: ["packs:publish"] });
      takeWrite(ctx, p);
      const body = await parseBody(c, userPublishPackRequest);
      const namespace = publishNamespace(p, body.namespace);
      const out = await publishPackVersion(ctx.publish, { namespace, slug: body.slug, version: body.version, files: body.files, extends: body.extends, publishedBy: p.user.id });
      return c.json(out, 201);
    },
  );

  /**
   * Fork : copie de la dernière version listée (ou `version`) dans le namespace de l'appelant. Le YAML
   * reçoit `forked_from: ns/slug@version` (attribution CC-BY) et, si demandé, un nouvel `id`.
   */
  app.post("/v1/modules/:ns/:slug/fork", async (c) => {
    const p = await auth.authenticate(c, { scopes: ["modules:publish"] });
    takeWrite(ctx, p);
    const body = parseWith(forkRequest, await readJsonOrEmpty(c));
    const ns = c.req.param("ns");
    const slug = c.req.param("slug");
    const src = await findModuleVersion(ctx.db, ns, slug, body.version ?? null);
    if (!src || src.module.status === "hidden" || src.version.status === "removed") throw new PublishError(404, "not_found", "Version introuvable.");
    if (src.version.status === "flagged") throw new PublishError(422, "invalid", "Version signalée, en attente de revue : fork impossible pour l'instant.");
    const target = body.slug ?? slug;
    if (ns === p.user.namespace && target === slug) throw new PublishError(409, "conflict", "Le module est déjà dans votre namespace : publier une nouvelle version plutôt qu'un fork.");
    const doc = parseDocument(src.version.yaml);
    doc.set("id", target);
    doc.set("forked_from", `${ns}/${slug}@${src.version.version}`);
    const out = await publishModuleVersion(ctx.publish, { namespace: p.user.namespace, yaml: doc.toString(), publishedBy: p.user.id });
    return c.json(out, 201);
  });
}
