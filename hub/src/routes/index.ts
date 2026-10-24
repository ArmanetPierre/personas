import { registerAccountRoutes } from "./account";
import type { CollabContext, HubApp } from "./common";
import { registerModerationRoutes } from "./moderation";
import { registerPublishRoutes } from "./publish";
import { registerSocialRoutes } from "./social";
import { registerTelemetryRoutes } from "./telemetry";

export type { CollabContext } from "./common";

/**
 * Routes du Hub collaboratif (phase 3). À enregistrer avant le « catch-all » /v1/* de app.ts :
 *
 *   GET    /v1/me                                   session ou jeton
 *   PATCH  /v1/me                                   session (nom affiché, namespace une fois)
 *   DELETE /v1/me                                   session (suppression de compte)
 *   GET    /v1/me/tokens                            session ou jeton
 *   POST   /v1/me/tokens                            session
 *   DELETE /v1/me/tokens/:id                        session ou jeton
 *   POST   /v1/device/code                          anonyme
 *   POST   /v1/device/lookup, /v1/device/approve    session
 *   POST   /v1/device/token                         anonyme (code d'appareil)
 *   POST   /v1/modules                              modules:publish
 *   POST   /v1/packs                                packs:publish
 *   POST   /v1/modules/:ns/:slug/fork               modules:publish
 *   PUT    /v1/modules/:ns/:slug/star, DELETE       read
 *   PUT    /v1/modules/:ns/:slug/:version/review, DELETE   read
 *   GET    /v1/modules/:ns/:slug/:version/reviews   anonyme
 *   POST   /v1/reports                              read
 *   GET    /v1/admin/review-queue                   moderation ou HUB_ADMIN_TOKEN
 *   POST   /v1/admin/moderation-events              moderation ou HUB_ADMIN_TOKEN
 *   POST   /v1/telemetry                            anonyme
 *   GET    /v1/keys, /v1/legal, /v1/legal/:doc      anonyme
 */
export function registerCollabRoutes(app: HubApp, ctx: CollabContext) {
  registerAccountRoutes(app, ctx);
  registerPublishRoutes(app, ctx);
  registerSocialRoutes(app, ctx);
  registerModerationRoutes(app, ctx);
  registerTelemetryRoutes(app, ctx);
}
