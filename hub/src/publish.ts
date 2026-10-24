import { and, eq, isNull } from "drizzle-orm";
import { OFFICIAL_NAMESPACE, type QualityScore, type VersionSignature } from "../../src/hub/contract";
import type { HubDb } from "../db/client";
import { moduleDeps, modules, moduleVersions, packs, packVersions, type VersionStatus } from "../db/schema";
import { lintForPublication, type LintIssue } from "./lint";
import { checkModuleForPublication, PublishError, readModuleHeader, searchTexts, sha256, type PublishedDep } from "./module-check";
import { checkPack } from "./pack-check";
import { ensureNamespace, findModule, findModuleVersion, findPack, findPackVersionByRef } from "./repo";
import type { Signer } from "./signing";

/**
 * Publication d'une version (module ou pack), commune à l'administration (HUB_ADMIN_TOKEN) et aux
 * utilisateurs : même porte de validation, même lint de sécurité, même calcul de Q, même signature.
 * Le contrôle des droits sur le namespace se fait avant, dans la route.
 */

export interface PublishDeps {
  db: HubDb;
  signer: Signer | null;
  /** Publications sérialisées : l'aperçu est synchrone et le contrôle 409 précède l'insertion. */
  serialized: <T>(fn: () => Promise<T>) => Promise<T>;
  invalidate: () => void;
}

export interface PublishedModule {
  ref: string;
  version: string;
  sha256: string;
  quality: QualityScore | null;
  status: VersionStatus;
  publishedAt: string;
  signature: VersionSignature | null;
  forkedFrom: { ref: string; version: string } | null;
  sensitive: string[];
  warnings: LintIssue[];
}

const isDuplicate = (err: unknown) => /duplicate key|unique/i.test(`${(err as Error).message} ${((err as { cause?: Error }).cause?.message) ?? ""}`);

/** `ns/slug@version` → version publiée (et lisible) ; sinon 422. */
async function resolveForkOrigin(db: HubDb, spec: string): Promise<{ versionId: string; ref: string; version: string }> {
  const m = /^([a-z0-9-]+)\/([a-z0-9][a-z0-9-]*)@(.+)$/.exec(spec.trim());
  if (!m) throw new PublishError(422, "invalid", `forked_from : « ${spec} » attendu sous la forme namespace/module@version.`);
  const found = await findModuleVersion(db, m[1]!, m[2]!, m[3]!);
  if (!found || found.version.status === "removed") throw new PublishError(422, "invalid", `forked_from : ${spec} introuvable sur le Hub.`);
  return { versionId: found.version.id, ref: `${m[1]}/${m[2]}`, version: found.version.version };
}

export async function publishModuleVersion(d: PublishDeps, input: { namespace: string; yaml: string; publishedBy: string | null }): Promise<PublishedModule> {
  const { db } = d;
  const { namespace, yaml } = input;
  const resolveDep = async (ref: string, version: string | null): Promise<PublishedDep | null> => {
    const [ns, slug] = ref.split("/") as [string, string];
    const found = await findModuleVersion(db, ns, slug ?? "", version);
    if (!found || found.version.status === "removed") return null;
    return { ref, version: found.version.version, yaml: found.version.yaml, requires: found.version.requires };
  };
  return d.serialized(async () => {
    const head = readModuleHeader(yaml);
    const ref = `${namespace}/${head.id}`;
    if (await findModuleVersion(db, namespace, head.id, head.version)) throw new PublishError(409, "conflict", `${ref}@${head.version} est déjà publié (versions immuables : publier une nouvelle version).`);
    // Lint de sécurité avant l'aperçu (peu coûteux) : un module piégé est refusé sans être tiré
    const lint = await lintForPublication(yaml);
    if (lint.errors.length) throw new PublishError(422, "invalid", `Lint de sécurité en échec, module refusé :\n${lint.errors.map((e) => `- ${e.path ? `${e.path} : ` : ""}${e.message}`).join("\n")}`);
    const fork = typeof head.raw.forked_from === "string" ? await resolveForkOrigin(db, head.raw.forked_from) : null;
    const checked = await checkModuleForPublication(yaml, resolveDep);
    const def = checked.def;
    const status: VersionStatus = checked.legacy ? "yanked" : namespace === OFFICIAL_NAMESPACE ? "verified" : "unverified";
    const tags = [...(namespace === OFFICIAL_NAMESPACE ? ["official"] : []), ...(checked.legacy ? ["legacy"] : []), ...(fork ? ["fork"] : []), ...(lint.sensitive.length ? ["sensitive"] : [])];
    const digest = sha256(yaml);
    const texts = searchTexts(def, ref);
    const raw = head.raw;
    const publishedAt = new Date().toISOString();
    const signature = d.signer?.sign({ ref, version: def.version, sha256: digest, publishedAt }) ?? null;
    try {
      await db.transaction(async (tx) => {
        const t = tx as unknown as HubDb;
        await ensureNamespace(t, namespace);
        const existing = await findModule(t, namespace, def.id);
        let moduleId = existing?.id;
        if (!moduleId) {
          const [row] = await t
            .insert(modules)
            .values({ namespace, slug: def.id, label: def.label, description: def.description ?? "", forkedFromVersionId: fork?.versionId ?? null })
            .returning({ id: modules.id });
          moduleId = row!.id;
        } else if (!checked.legacy) {
          await t.update(modules).set({ label: def.label, description: def.description ?? "" }).where(eq(modules.id, moduleId));
        }
        const [ver] = await t
          .insert(moduleVersions)
          .values({
            moduleId,
            version: def.version,
            yaml,
            sha256: digest,
            status,
            label: def.label,
            description: def.description ?? "",
            appliesTo: def.applies_to,
            tags,
            attributes: def.attributes.map((a) => ({ key: a.key, label: a.label })),
            requires: checked.requires,
            license: typeof raw.license === "string" ? raw.license : "CC-BY-4.0",
            engineMin: typeof raw.engine_min === "string" ? raw.engine_min : null,
            quality: checked.quality,
            preview: checked.preview,
            searchTitle: texts.title,
            searchBody: texts.body,
            publishedAt,
            publishedBy: input.publishedBy,
            signature: signature?.value ?? null,
            signatureKid: signature?.kid ?? null,
            lint: { engine: lint.engine, warnings: lint.warnings },
            sensitive: lint.sensitive,
          })
          .returning({ id: moduleVersions.id });
        if (checked.requires.length) await t.insert(moduleDeps).values(checked.requires.map((r) => ({ versionId: ver!.id, ref: r.ref, version: r.version, alias: r.as })));
      });
    } catch (err) {
      if (isDuplicate(err)) throw new PublishError(409, "conflict", `${ref}@${def.version} est déjà publié.`);
      throw err;
    }
    d.invalidate();
    return { ref, version: def.version, sha256: digest, quality: checked.quality, status, publishedAt, signature, forkedFrom: fork ? { ref: fork.ref, version: fork.version } : null, sensitive: lint.sensitive, warnings: lint.warnings };
  });
}

export interface PackPublishInput {
  namespace: string;
  slug: string;
  version: string;
  files: Record<string, string>;
  extends: string | null;
  publishedBy: string | null;
}

const slugRe = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Version de pack (données seulement, docs/plateforme.md § 4.4) : le générateur doit être fourni par
 * le moteur (manifeste validé), la chaîne `extends` est résolue dans le namespace, puis dans `personas/`.
 */
export async function publishPackVersion(d: PublishDeps, req: PackPublishInput) {
  const { db } = d;
  if (!slugRe.test(req.slug) || req.slug.length > 64) throw new PublishError(422, "invalid", "slug : minuscules, chiffres et tirets.");
  return d.serialized(async () => {
    const ref = `${req.namespace}/${req.slug}`;
    if (await findPackVersionByRef(db, req.namespace, req.version)) throw new PublishError(409, "conflict", `La version de pack ${req.version} est déjà publiée dans ${req.namespace}/ (versions immuables).`);
    const lookup = async (r: string) => (await findPackVersionByRef(db, req.namespace, r)) ?? (req.namespace !== OFFICIAL_NAMESPACE ? await findPackVersionByRef(db, OFFICIAL_NAMESPACE, r) : null);
    // Chaîne `extends` : versions déjà publiées, du plus proche au plus lointain
    const base: Array<Record<string, string>> = [];
    let next = req.extends;
    while (next) {
      if (base.length > 3) throw new PublishError(422, "invalid", "extends : chaîne d'héritage trop longue.");
      const found = await lookup(next);
      if (!found || found.version.status === "removed") throw new PublishError(422, "invalid", `extends : pack ${next} introuvable sur le Hub (le publier d'abord).`);
      base.push(found.version.files);
      next = found.version.extends;
    }
    const checked = checkPack({ version: req.version, files: req.files, extends: req.extends, base });
    const manifest = checked.manifest;
    for (const id of manifest.modules) {
      const ok = (await findModule(db, req.namespace, id)) ?? (await findModule(db, OFFICIAL_NAMESPACE, id));
      if (!ok) throw new PublishError(422, "invalid", `Le manifeste active le module « ${id} », absent du Hub (le publier d'abord).`);
    }
    const status: VersionStatus = req.namespace === OFFICIAL_NAMESPACE ? "verified" : "unverified";
    const publishedAt = new Date().toISOString();
    const signature = d.signer?.sign({ ref, version: req.version, sha256: checked.sha256, publishedAt }) ?? null;
    try {
      await db.transaction(async (tx) => {
        const t = tx as unknown as HubDb;
        await ensureNamespace(t, req.namespace);
        const existing = await findPack(t, req.namespace, req.slug);
        const meta = { label: manifest.label ?? manifest.version, country: manifest.country, locale: manifest.locale, generator: manifest.generator };
        let packId = existing?.id;
        if (!packId) {
          const [row] = await t.insert(packs).values({ namespace: req.namespace, slug: req.slug, ...meta }).returning({ id: packs.id });
          packId = row!.id;
        } else await t.update(packs).set(meta).where(eq(packs.id, packId));
        const dup = await t.select({ id: packVersions.id }).from(packVersions).where(and(eq(packVersions.packId, packId), eq(packVersions.version, req.version)));
        if (dup.length) throw new PublishError(409, "conflict", `${ref}@${req.version} est déjà publié.`);
        await t.insert(packVersions).values({
          packId,
          version: req.version,
          extends: req.extends,
          files: req.files,
          sha256: checked.sha256,
          manifest: JSON.parse(req.files["pack.json"]!) as Record<string, unknown>,
          status,
          publishedAt,
          publishedBy: req.publishedBy,
          signature: signature?.value ?? null,
          signatureKid: signature?.kid ?? null,
        });
      });
    } catch (err) {
      if (err instanceof PublishError) throw err;
      if (isDuplicate(err)) throw new PublishError(409, "conflict", `${ref}@${req.version} est déjà publié.`);
      throw err;
    }
    d.invalidate();
    return { ref, version: req.version, sha256: checked.sha256, quality: null, status, publishedAt, signature };
  });
}

/**
 * Signe les versions publiées avant la mise en place de la clé (ou d'une autre clé absente) : au
 * démarrage du serveur. Le contenu n'est pas modifié (seules les colonnes de signature le sont).
 */
export async function signMissingVersions(db: HubDb, signer: Signer): Promise<number> {
  let n = 0;
  const mods = await db
    .select({ id: moduleVersions.id, version: moduleVersions.version, sha256: moduleVersions.sha256, publishedAt: moduleVersions.publishedAt, ns: modules.namespace, slug: modules.slug })
    .from(moduleVersions)
    .innerJoin(modules, eq(modules.id, moduleVersions.moduleId))
    .where(isNull(moduleVersions.signature));
  for (const v of mods) {
    const s = signer.sign({ ref: `${v.ns}/${v.slug}`, version: v.version, sha256: v.sha256, publishedAt: new Date(v.publishedAt).toISOString() });
    await db.update(moduleVersions).set({ signature: s.value, signatureKid: s.kid }).where(eq(moduleVersions.id, v.id));
    n++;
  }
  const pks = await db
    .select({ id: packVersions.id, version: packVersions.version, sha256: packVersions.sha256, publishedAt: packVersions.publishedAt, ns: packs.namespace, slug: packs.slug })
    .from(packVersions)
    .innerJoin(packs, eq(packs.id, packVersions.packId))
    .where(isNull(packVersions.signature));
  for (const v of pks) {
    const s = signer.sign({ ref: `${v.ns}/${v.slug}`, version: v.version, sha256: v.sha256, publishedAt: new Date(v.publishedAt).toISOString() });
    await db.update(packVersions).set({ signature: s.value, signatureKid: s.kid }).where(eq(packVersions.id, v.id));
    n++;
  }
  return n;
}
