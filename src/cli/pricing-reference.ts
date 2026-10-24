import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { loadConfig, loadDotEnv } from "../config";
import { openDb, runMigrations } from "../db/client";
import { personas, responses } from "../db/schema";
import { loadPack } from "../personas/pack";
import { buildNarrativePrompt, narrativeSystemFor } from "../personas/narrate";
import { packResolver } from "../studies/packs";
import { measuredMeans, NARRATIVE_BATCH, REFERENCE_FILE, type ReferenceUsage } from "../studies/cost";
import { CHARS_PER_TOKEN } from "../engine/budget";
import { errorText } from "./i18n";

/**
 * Table de référence des moyennes de tokens (pricing/reference-usage.json), livrée avec le moteur pour
 * estimer le coût d'une étude sans historique local. Mesurée sur la base locale ; n'écrit AUCUN
 * identifiant d'étude, de projet ou de persona : seulement des moyennes par protocole, socle et fournisseur.
 */

const { values } = parseArgs({ options: { out: { type: "string", default: REFERENCE_FILE }, help: { type: "boolean", short: "h" } } });
if (values.help) {
  console.log("Usage : npm run pricing:reference [-- --out pricing/reference-usage.json]\nMesure les moyennes de tokens de la base locale (sans identifiant d'étude).");
  process.exit(0);
}

loadDotEnv();
const config = loadConfig();
const { sqlite, db } = openDb(config.DATABASE_PATH);
try {
  runMigrations(db);
  const protocols = measuredMeans(db, { min: 20 });
  // Caractères par token mesurés sur les sorties (JSON en français) : convertit les récits en tokens
  const [ratio] = db
    .select({ chars: sql<number>`sum(length(${responses.rawText}))`, tokens: sql<number>`sum(${responses.outputTokens})` })
    .from(responses)
    .where(sql`${responses.backend} = 'claude-cli' and ${responses.attempts} = 1 and ${responses.rawText} is not null`)
    .all();
  // Sortie : tokens facturés (réflexion comprise) par caractère de texte visible, mesuré ; entrée : hypothèse
  // d'environ 3 caractères par token (français, tokenizer récent), faute de longueur de prompt en base
  const charsPerToken = ratio && ratio.tokens ? Math.round((ratio.chars / ratio.tokens) * 100) / 100 : 3;
  const inputCharsPerToken = CHARS_PER_TOKEN;
  // Lots de récits : prompt (système + fiches) et récits écrits, convertis en tokens
  const pack = loadPack("fr");
  const packOf = packResolver(pack);
  const written = db.select().from(personas).where(isNotNull(personas.narrative)).all().sort((a, b) => a.packVersion.localeCompare(b.packVersion) || (a.drawIndex ?? 0) - (b.drawIndex ?? 0));
  let batches = 0;
  let inChars = 0;
  let outChars = 0;
  for (let i = 0; i + NARRATIVE_BATCH <= written.length && batches < 200; i += NARRATIVE_BATCH) {
    const batch = written.slice(i, i + NARRATIVE_BATCH);
    if (new Set(batch.map((p) => p.packVersion)).size > 1) continue;
    const pk = packOf(batch[0]!);
    inChars += narrativeSystemFor(pk).length + buildNarrativePrompt(pk, batch).length;
    // Réponse JSON : récits + clés et identifiants (~60 caractères par persona)
    outChars += batch.reduce((s, p) => s + (p.narrative?.length ?? 0) + 60, 0);
    batches++;
  }
  const reference: ReferenceUsage = {
    version: 1,
    generatedAt: new Date().toISOString().slice(0, 10),
    note:
      "Moyennes mesurées sur la base locale du mainteneur (réponses, récits), sans aucun identifiant d'étude. " +
      "claude-cli : l'entrée compte aussi ~3 k tokens propres à la CLI (lus en cache), l'estimation est donc prudente pour les autres fournisseurs. " +
      "Régénérer : npm run pricing:reference.",
    charsPerToken,
    protocols,
    narratives: {
      batchSize: NARRATIVE_BATCH,
      batches,
      inputPerBatch: batches ? Math.round(inChars / batches / inputCharsPerToken) : 6000,
      outputPerBatch: batches ? Math.round(outChars / batches / charsPerToken) : 4500,
      method: `longueur des prompts et des récits de ${batches} lots : entrée à ${inputCharsPerToken} caractères par token (hypothèse), sortie à ${charsPerToken} caractère(s) de texte par token facturé (mesuré sur les sorties claude-cli, réflexion comprise)`,
    },
  };
  // Garde-fou : aucun identifiant ne doit sortir
  const text = JSON.stringify(reference, null, 2) + "\n";
  if (/\bst-[0-9a-f]{6}\b/.test(text)) throw new Error("Identifiant d'étude dans la table de référence : écriture refusée.");
  z.object({ protocols: z.array(z.object({ responses: z.number() })) }).parse(reference);
  writeFileSync(values.out!, text);
  console.log(`Table de référence écrite : ${values.out} (${protocols.length} groupe(s) de réponses, ${batches} lot(s) de récits, ${charsPerToken} caractères par token).`);
} catch (err) {
  console.error(errorText(err));
  process.exitCode = 1;
} finally {
  sqlite.close();
}
