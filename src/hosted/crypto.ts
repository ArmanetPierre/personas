import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Chiffrement des clés IA des comptes (service hébergé) : AES-256-GCM, clé maître `HOSTED_MASTER_KEY`
 * (32 octets, en base64 ou en hexadécimal, variable d'environnement du serveur seulement), IV aléatoire de
 * 12 octets par chiffrement, données associées (AAD) = identifiant du compte + fournisseur : un enregistrement
 * copié dans un autre compte, ou relu pour un autre fournisseur, ne se déchiffre pas.
 */

export interface SealedSecret {
  v: 1;
  alg: "aes-256-gcm";
  iv: string;
  tag: string;
  ct: string;
}

export class SecretDecryptError extends Error {
  override name = "SecretDecryptError";
}

/** Clé maître : 32 octets en base64 (44 caractères) ou en hexadécimal (64 caractères). */
export function parseMasterKey(text: string): Buffer {
  const t = text.trim();
  const key = /^[0-9a-f]{64}$/i.test(t) ? Buffer.from(t, "hex") : /^[A-Za-z0-9+/_-]{43}=?$/.test(t) ? Buffer.from(t.replace(/-/g, "+").replace(/_/g, "/"), "base64") : null;
  if (!key || key.length !== 32) throw new Error("HOSTED_MASTER_KEY invalide : 32 octets attendus, en base64 ou en hexadécimal (openssl rand -base64 32).");
  return key;
}

const aadOf = (userId: string, provider: string) => Buffer.from(`personas-hosted\0${userId}\0${provider}`, "utf8");

export function sealSecret(masterKey: Buffer, userId: string, provider: string, secret: string): SealedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
  cipher.setAAD(aadOf(userId, provider));
  const ct = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return { v: 1, alg: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ct: ct.toString("base64") };
}

export function openSecret(masterKey: Buffer, userId: string, provider: string, sealed: SealedSecret): string {
  try {
    const decipher = createDecipheriv("aes-256-gcm", masterKey, Buffer.from(sealed.iv, "base64"));
    decipher.setAAD(aadOf(userId, provider));
    decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(sealed.ct, "base64")), decipher.final()]).toString("utf8");
  } catch {
    // Jamais de détail (ni la clé, ni le texte chiffré)
    throw new SecretDecryptError("Clé IA illisible (clé maître changée ou enregistrement altéré) : la saisir à nouveau.");
  }
}
