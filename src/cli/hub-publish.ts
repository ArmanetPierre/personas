import { existsSync, statSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadDotEnv } from "../config";
import { resolveHubAdminToken } from "../hub/admin";
import { resolveHubToken } from "../hub/auth";
import { packDirFiles, packFilesSha256 } from "../hub/cache";
import { HubClient } from "../hub/client";
import { OFFICIAL_NAMESPACE } from "../hub/contract";
import { moduleFileOf, previewPublication } from "../hub/publish";
import { formatQuality } from "../hub/search";
import { errorText, lang, t } from "./i18n";

/**
 * Publication sur le Hub.
 * - **Utilisateur** (phase 3) : avec le jeton personnel de `personas hub login`, dans le namespace du compte
 *   (POST /v1/modules, /v1/packs). Seul le YAML du module (ou les tables du pack) est envoyé.
 * - **Administration** (`--admin`, ou `--namespace personas` avec un jeton d'administration) : modules et packs
 *   officiels (POST /v1/admin/…), jeton HUB_ADMIN_TOKEN ou trousseau (compte hub-admin).
 * Un module est validé et passé au lint de sécurité ici avant l'envoi (une erreur bloque) ; le Hub refait les deux.
 * Aucun jeton n'est jamais affiché.
 *
 *   personas hub publish numerique                       (id d'un module de modules/, ou chemin d'un YAML)
 *   personas hub publish packs/sg-2026.2 [--slug sg]
 *   personas hub publish modules/numerique/module.yaml --namespace personas --admin
 */

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    namespace: { type: "string" },
    slug: { type: "string" },
    admin: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
  },
});
const target = positionals[0];
if (values.help || !target) {
  console.log(t.hub.userPublishUsage);
  process.exit(values.help ? 0 : 2);
}
loadDotEnv();
try {
  const isPack = existsSync(target) && statSync(target).isDirectory();
  // Administration : demandée (--admin), ou namespace officiel avec un jeton d'administration disponible.
  const adminToken = values.admin || values.namespace === OFFICIAL_NAMESPACE ? await resolveHubAdminToken() : null;
  if (values.admin && !adminToken && !values["dry-run"]) {
    console.error(t.hub.noToken);
    process.exit(2);
  }
  const admin = !!adminToken;
  const namespace = values.namespace ?? (admin ? OFFICIAL_NAMESPACE : undefined);
  type Sent = { ref: string; version: string; sha256: string; quality: Parameters<typeof formatQuality>[0]; status?: string | undefined; signature?: { kid: string } | null | undefined };
  let send: (client: HubClient, token: string) => Promise<Sent>;
  if (isPack) {
    const files = packDirFiles(target);
    if (!files["pack.json"]) throw new Error(`${target} : pack.json absent.`);
    const manifest = JSON.parse(files["pack.json"]) as { country?: string; version: string; extends?: string };
    const slug = values.slug ?? manifest.country?.toLowerCase();
    if (!slug) throw new Error(`${target} : --slug requis (pack.json sans country).`);
    const sha = packFilesSha256(files);
    if (values["dry-run"]) {
      console.log(t.hub.dryRun(t.hub.kinds.pack!, `${namespace ?? "<compte>"}/${slug}`, manifest.version, sha));
      process.exit(0);
    }
    const req = { slug, version: manifest.version, files, extends: manifest.extends ?? null };
    send = admin ? (c, token) => c.publishPack({ namespace: namespace!, ...req }, token) : (c, token) => c.publishUserPack({ ...req, ...(namespace && { namespace }) }, token);
  } else {
    const p = previewPublication(moduleFileOf(target));
    if (p.validation.length) {
      console.error(t.hub.validationErrors(p.validation.length));
      for (const e of p.validation) console.error(t.hub.issue(e.path, e.message));
    }
    if (p.lint.errors.length) {
      console.error(t.hub.lintErrors(p.lint.errors.length));
      for (const e of p.lint.errors) console.error(t.hub.issue(e.path, `${e.message} [${e.code}]`));
    }
    if (p.lint.warnings.length) {
      console.log(t.hub.lintWarnings(p.lint.warnings.length));
      for (const w of p.lint.warnings) console.log(t.hub.issue(w.path, `${w.message} [${w.code}]`));
    }
    if (!p.ok || !p.def) process.exit(1);
    if (!p.lint.warnings.length) console.log(t.hub.lintOk);
    if (p.sensitive.length) console.log(t.hub.sensitiveDeclared(p.sensitive.join(", ")));
    if (values["dry-run"]) {
      console.log(t.hub.dryRun(t.hub.kinds.module!, `${namespace ?? "<compte>"}/${p.def.id}`, p.def.version, p.sha256));
      process.exit(0);
    }
    const yaml = p.yaml;
    send = admin ? (c, token) => c.publishModule({ namespace: namespace!, yaml }, token) : (c, token) => c.publishUserModule({ yaml, ...(namespace && { namespace }) }, token);
  }
  let token: string;
  if (admin) {
    console.log(t.hub.tokenSource(t.hub.tokenSources[adminToken.source]!));
    token = adminToken.token;
  } else {
    const personal = await resolveHubToken();
    if (!personal) {
      console.error(t.hub.notLoggedIn);
      process.exit(2);
    }
    token = personal.token;
  }
  const client = new HubClient();
  console.log(t.hub.hubUrl(client.baseUrl));
  const r = await send(client, token);
  console.log(r.status ? t.hub.publishedAs(r.ref, r.version, r.sha256, r.status) : t.hub.published(r.ref, r.version, r.sha256, formatQuality(r.quality, lang)));
  if (r.status) console.log(`  ${formatQuality(r.quality, lang)}`);
  if (r.signature) console.log(t.hub.publishedSigned(r.signature.kid));
} catch (err) {
  console.error(t.common.error(errorText(err)));
  if ((err as { status?: number }).status === 401) console.error(t.hub.tokenRejected);
  process.exitCode = 1;
}
