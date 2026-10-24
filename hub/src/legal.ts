import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

/**
 * Conditions d'utilisation et politique de confidentialité (hub/legal/<doc>.<lang>.md), exposées en
 * markdown par GET /v1/legal ; les pages HTML qui les affichent relèvent du lot UI.
 * Version : ligne `<!-- version: AAAA-MM-JJ -->` en tête de fichier (sinon empreinte du texte).
 */

export const LEGAL_DIR = resolve(import.meta.dirname, "../legal");
export const LEGAL_DOCS = ["terms", "privacy"] as const;
export const LEGAL_LANGS = ["fr", "en"] as const;
export type LegalDoc = (typeof LEGAL_DOCS)[number];
export type LegalLang = (typeof LEGAL_LANGS)[number];

export type LegalDocs = Map<`${LegalDoc}.${LegalLang}`, { version: string; markdown: string }>;

export function loadLegal(dir = LEGAL_DIR): LegalDocs {
  const out: LegalDocs = new Map();
  for (const doc of LEGAL_DOCS) {
    for (const lang of LEGAL_LANGS) {
      const file = join(dir, `${doc}.${lang}.md`);
      if (!existsSync(file)) continue;
      const markdown = readFileSync(file, "utf8");
      const version = /<!--\s*version:\s*([0-9A-Za-z.-]+)\s*-->/.exec(markdown)?.[1] ?? createHash("sha256").update(markdown).digest("hex").slice(0, 12);
      out.set(`${doc}.${lang}`, { version, markdown });
    }
  }
  return out;
}
