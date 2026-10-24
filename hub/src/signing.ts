import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { signedPayload, type VersionSignature } from "../../src/hub/contract";

/**
 * Signature Ed25519 des versions publiées (docs/plateforme.md § 2.4) : le Hub signe
 * `signedPayload({ref, version, sha256, publishedAt})` avec sa clé privée (HUB_SIGNING_KEY), et publie
 * la clé publique sur GET /v1/keys. Le runner détecte ainsi un cache altéré ou un miroir.
 *
 * Format de HUB_SIGNING_KEY : graine Ed25519 de 32 octets en base64 (ou base64url, ou hexadécimal),
 * ou clé PKCS#8 (PEM, ou DER en base64). Génération :
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 */

// En-tête DER PKCS#8 d'une clé Ed25519 nue (RFC 8410) : 302e020100300506032b657004220420 + graine.
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export interface Signer {
  kid: string;
  /** Clé publique brute (32 octets), base64. */
  publicKey: string;
  /** Même clé au format JWK (OKP, Ed25519, x en base64url). */
  jwk: { kty: "OKP"; crv: "Ed25519"; x: string; kid: string };
  sign(fields: { ref: string; version: string; sha256: string; publishedAt: string }): VersionSignature;
}

function privateKeyFrom(text: string): KeyObject {
  const t = text.trim();
  if (t.startsWith("-----BEGIN ")) return createPrivateKey({ key: t, format: "pem" });
  const raw = /^[0-9a-f]{64}$/i.test(t) ? Buffer.from(t, "hex") : Buffer.from(t.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (raw.length === 32) return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, raw]), format: "der", type: "pkcs8" });
  return createPrivateKey({ key: raw, format: "der", type: "pkcs8" });
}

/** Signataire à partir de HUB_SIGNING_KEY ; nul si la clé est absente (signature désactivée). */
export function loadSigner(keyText: string | undefined): Signer | null {
  if (!keyText?.trim()) return null;
  let priv: KeyObject;
  try {
    priv = privateKeyFrom(keyText);
  } catch (err) {
    throw new Error(`HUB_SIGNING_KEY illisible (graine Ed25519 de 32 octets en base64, ou PKCS#8) : ${(err as Error).message}`);
  }
  if (priv.asymmetricKeyType !== "ed25519") throw new Error(`HUB_SIGNING_KEY : clé ${priv.asymmetricKeyType} ; Ed25519 attendue.`);
  const pub = createPublicKey(priv);
  const x = (pub.export({ format: "jwk" }) as { x: string }).x;
  const rawPub = Buffer.from(x, "base64url");
  const kid = createHash("sha256").update(rawPub).digest("hex").slice(0, 16);
  return {
    kid,
    publicKey: rawPub.toString("base64"),
    jwk: { kty: "OKP", crv: "Ed25519", x, kid },
    sign: (fields) => ({ alg: "Ed25519", kid, value: sign(null, Buffer.from(signedPayload(fields), "utf8"), priv).toString("base64") }),
  };
}

/** Vérification (tests, outils) : clé publique brute en base64. */
export function verifyVersionSignature(publicKeyB64: string, fields: { ref: string; version: string; sha256: string; publishedAt: string }, signatureB64: string): boolean {
  const pub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(publicKeyB64, "base64").toString("base64url") }, format: "jwk" });
  return verify(null, Buffer.from(signedPayload(fields), "utf8"), pub, Buffer.from(signatureB64, "base64"));
}

/** Signature stockée → objet du contrat. */
export const signatureOf = (row: { signature: string | null; signatureKid: string | null }): VersionSignature | null =>
  row.signature && row.signatureKid ? { alg: "Ed25519", kid: row.signatureKid, value: row.signature } : null;
