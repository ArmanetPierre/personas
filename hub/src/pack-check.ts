import { packSchema } from "../../src/personas/pack";
import { manifestSchema, type PackManifest } from "../../src/personas/pack-common";
import { SG_FILES, sgPackSchema } from "../../src/personas/countries/sg/pack";
import { US_FILES, usPackSchema } from "../../src/personas/countries/us/pack";
import { PublishError, sha256 } from "./module-check";

/**
 * Contrôle d'une version de pack pays à publier (données seulement, docs/plateforme.md § 4.4) :
 * fichiers JSON lisibles, manifeste valide, tables validées par le schéma du générateur (après
 * reprise des tables du pack de base `extends`), modules du manifeste publiés.
 */

export const MAX_PACK_BYTES = 5 * 1024 * 1024;
export const PACK_FILE_RE = /^[a-z0-9][a-z0-9-]*\.json$/;

/** Empreinte canonique d'un pack : noms triés, "nom\n" + contenu + "\n" (contrat packVersionResponse). */
export function packSha256(files: Record<string, string>): string {
  return sha256(
    Object.keys(files)
      .sort()
      .map((name) => `${name}\n${files[name]}\n`)
      .join(""),
  );
}

const kebab = (k: string) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
/** Clé de table → nom de fichier, par générateur (`fr` : clés du schéma ; `sg` : SG_FILES ; `us` : US_FILES). */
const FR_FILES: Record<string, string> = Object.fromEntries(
  Object.keys(packSchema.shape)
    .filter((k) => k !== "manifest")
    .map((k) => [k, `${kebab(k)}.json`]),
);

/** Fichiers admis dans une version de pack pour un générateur : le manifeste et les tables de son schéma. */
export function generatorPackFiles(generator: string | undefined): Set<string> {
  const fileMap: Record<string, string> = generator === "sg" ? SG_FILES : generator === "us" ? US_FILES : FR_FILES;
  return new Set(["pack.json", ...Object.values(fileMap)]);
}

export interface PackCheckResult {
  manifest: PackManifest;
  sha256: string;
  bytes: number;
}

/**
 * `base` : fichiers de la chaîne `extends` déjà publiés (du plus proche au plus lointain), pour
 * reconstituer les tables héritées comme `loadPack`.
 */
export function checkPack(input: { version: string; files: Record<string, string>; extends: string | null; base: Array<Record<string, string>> }): PackCheckResult {
  const names = Object.keys(input.files);
  if (!names.includes("pack.json")) throw new PublishError(422, "invalid", "pack.json (manifeste) manquant.");
  const bad = names.filter((n) => !PACK_FILE_RE.test(n));
  if (bad.length) throw new PublishError(422, "invalid", `Noms de fichiers refusés (attendu : minuscules, tirets, .json) : ${bad.join(", ")}`);
  const bytes = names.reduce((s, n) => s + Buffer.byteLength(input.files[n]!, "utf8"), 0);
  if (bytes > MAX_PACK_BYTES) throw new PublishError(422, "invalid", `Pack trop gros : ${bytes} octets (max ${MAX_PACK_BYTES}).`);

  const parsed: Record<string, unknown> = {};
  for (const n of names) {
    try {
      parsed[n] = JSON.parse(input.files[n]!);
    } catch (err) {
      throw new PublishError(422, "invalid", `${n} : JSON illisible (${(err as Error).message})`);
    }
  }
  const m = manifestSchema.safeParse(parsed["pack.json"]);
  if (!m.success) throw new PublishError(422, "invalid", `pack.json invalide :\n${m.error.issues.map((i) => `- ${i.path.join(".")} : ${i.message}`).join("\n")}`);
  const manifest = m.data;
  if (manifest.version !== input.version) throw new PublishError(422, "invalid", `version « ${input.version} » différente de celle du manifeste (« ${manifest.version} »).`);
  if (!!manifest.extends !== !!input.extends) throw new PublishError(422, "invalid", "extends : le manifeste et la requête doivent tous deux déclarer (ou non) un pack de base.");

  const fileMap: Record<string, string> = manifest.generator === "sg" ? SG_FILES : manifest.generator === "us" ? US_FILES : FR_FILES;
  const known = generatorPackFiles(manifest.generator);
  const unknown = names.filter((n) => !known.has(n));
  if (unknown.length) throw new PublishError(422, "invalid", `Fichiers inconnus du générateur « ${manifest.generator} » : ${unknown.join(", ")}`);

  // Tables héritées d'abord (du plus lointain au plus proche), puis celles de cette version
  const raw: Record<string, unknown> = { manifest };
  for (const files of [...input.base].reverse()) {
    for (const [k, f] of Object.entries(fileMap)) if (files[f] !== undefined) raw[k] = JSON.parse(files[f]!);
  }
  for (const [k, f] of Object.entries(fileMap)) if (parsed[f] !== undefined) raw[k] = parsed[f];
  const schema = manifest.generator === "sg" ? sgPackSchema : manifest.generator === "us" ? usPackSchema : packSchema;
  const r = schema.safeParse(raw);
  if (!r.success) throw new PublishError(422, "invalid", `Pack ${input.version} invalide :\n${r.error.issues.slice(0, 20).map((i) => `- ${i.path.join(".")} : ${i.message}`).join("\n")}`);
  return { manifest, sha256: packSha256(input.files), bytes };
}
