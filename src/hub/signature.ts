import { createPublicKey, verify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HubIntegrityError } from "./cache";
import type { HubClient } from "./client";
import { signedPayload, type VersionSignature } from "./contract";

/**
 * Vérification des signatures Ed25519 des versions (docs/plateforme.md § 13, phase 3) : le Hub signe
 * `signedPayload({ref, version, sha256, publishedAt})` et publie ses clés sur GET /v1/keys. Le runner garde les
 * clés en cache (`<cache>/keys.json`) et vérifie chaque version au téléchargement :
 * - signature présente, clé connue : vérifiée ; **invalide → refus** (rien n'est écrit dans le cache) ;
 * - signature absente : avertissement (version non signée) ;
 * - clé inconnue (Hub sans clé, hors ligne, rotation non publiée) : avertissement, signature non vérifiée.
 * Une clé déjà en cache n'est jamais remplacée par une autre sous le même `kid` (première clé vue retenue).
 */

interface KeysFile {
  hubUrl: string;
  fetchedAt: string;
  keys: Array<{ kid: string; publicKey: string }>;
}

const KEYS_FILE = "keys.json";

function readKeys(cacheDir: string | null, hubUrl: string): KeysFile | null {
  if (!cacheDir) return null;
  const f = join(cacheDir, KEYS_FILE);
  if (!existsSync(f)) return null;
  try {
    const k = JSON.parse(readFileSync(f, "utf8")) as KeysFile;
    return k.hubUrl === hubUrl ? k : null;
  } catch {
    return null;
  }
}

function writeKeys(cacheDir: string, k: KeysFile): void {
  mkdirSync(cacheDir, { recursive: true });
  const tmp = join(cacheDir, `${KEYS_FILE}.tmp-${process.pid}`);
  writeFileSync(tmp, `${JSON.stringify(k, null, 1)}\n`);
  renameSync(tmp, join(cacheDir, KEYS_FILE));
}

/** Clés connues en mémoire (processus), par URL du Hub : évite un GET /v1/keys par version. */
const memo = new Map<string, Map<string, string>>();
const refreshed = new Set<string>();

/** Clé publique (base64 brute, 32 octets) d'un `kid`, depuis le cache puis GET /v1/keys (une fois par processus). */
export async function hubPublicKey(client: HubClient, kid: string, cacheDir: string | null): Promise<string | null> {
  const known = memo.get(client.baseUrl) ?? new Map<string, string>();
  memo.set(client.baseUrl, known);
  if (!known.size) for (const k of readKeys(cacheDir, client.baseUrl)?.keys ?? []) known.set(k.kid, k.publicKey);
  if (known.has(kid)) return known.get(kid)!;
  if (refreshed.has(client.baseUrl)) return null;
  refreshed.add(client.baseUrl);
  try {
    const r = await client.keys();
    for (const k of r.keys) if (!known.has(k.kid)) known.set(k.kid, k.publicKey);
    if (cacheDir) writeKeys(cacheDir, { hubUrl: client.baseUrl, fetchedAt: new Date().toISOString(), keys: [...known].map(([k, publicKey]) => ({ kid: k, publicKey })) });
  } catch {
    // Hub sans clés ou injoignable : signature non vérifiable
  }
  return known.get(kid) ?? null;
}

/** Oublie les clés en mémoire (tests). */
export function resetKeyMemo(): void {
  memo.clear();
  refreshed.clear();
}

export function verifyEd25519(publicKeyB64: string, payload: string, signatureB64: string): boolean {
  try {
    const raw = Buffer.from(publicKeyB64, "base64");
    if (raw.length !== 32) return false;
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") }, format: "jwk" });
    return verify(null, Buffer.from(payload, "utf8"), key, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}

export type SignatureCheck = { status: "valid"; kid: string } | { status: "unsigned"; warning: string } | { status: "unverified"; warning: string };

/**
 * Vérifie la signature d'une version (module ou pack). Lève `HubIntegrityError` si elle est invalide ;
 * sinon renvoie le résultat (avertissement si non signée ou non vérifiable).
 */
export async function checkVersionSignature(
  client: HubClient,
  fields: { ref: string; version: string; sha256: string; publishedAt?: string | undefined; signature?: VersionSignature | null | undefined },
  cacheDir: string | null,
): Promise<SignatureCheck> {
  const key = `${fields.ref}@${fields.version}`;
  if (!fields.signature) return { status: "unsigned", warning: `${key} n'est pas signée par le Hub (intégrité vérifiée par sha256 seulement).` };
  if (fields.signature.alg !== "Ed25519") throw new HubIntegrityError(`Signature de ${key} refusée : algorithme ${fields.signature.alg} inconnu.`);
  if (!fields.publishedAt) return { status: "unverified", warning: `${key} : signature présente mais date de publication absente, non vérifiable.` };
  const pub = await hubPublicKey(client, fields.signature.kid, cacheDir);
  if (!pub) return { status: "unverified", warning: `${key} : clé de signature ${fields.signature.kid} inconnue (GET /v1/keys), signature non vérifiée.` };
  const payload = signedPayload({ ref: fields.ref, version: fields.version, sha256: fields.sha256, publishedAt: fields.publishedAt });
  if (!verifyEd25519(pub, payload, fields.signature.value)) {
    throw new HubIntegrityError(`Signature invalide pour ${key} (clé ${fields.signature.kid}) : contenu ou métadonnées modifiés après signature, refusé. Rien n'est écrit dans le cache.`);
  }
  return { status: "valid", kid: fields.signature.kid };
}
