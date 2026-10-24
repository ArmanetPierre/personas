import { parseArgs } from "node:util";
import { z } from "zod";
import { loadConfig, loadDotEnv } from "../config";
import { BACKEND_NAMES, getEngine, getProfileEngine, type Engine, type ProviderKind } from "../engine";
import { errorText, t } from "./i18n";

/**
 * Vérifie chaque backend : disponibilité, puis UNE petite requête JSON validée.
 * Sans option : claude-cli et ollama (inchangé). `--profile <nom>` : le profil de moteur demandé ; pour un
 * fournisseur à clé, la requête est réelle et facturée : elle ne part que si l'utilisateur lance la commande.
 */

const { values } = parseArgs({
  options: {
    backend: { type: "string", short: "b" },
    profile: { type: "string", short: "p" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(t.engineCheck.usage(BACKEND_NAMES.join("|")));
  process.exit(0);
}

const DEFAULT_BACKENDS: string[] = ["claude-cli", "ollama"];
let targets: string[] = DEFAULT_BACKENDS;
if (values.backend) {
  if (!BACKEND_NAMES.includes(values.backend)) {
    console.error(t.engineCheck.unknownBackend(values.backend, BACKEND_NAMES.join(", ")));
    process.exit(2);
  }
  targets = [values.backend];
}

const reactionSchema = z.object({
  persona: z.string().min(1).describe("Qui répond, en une phrase"),
  wouldPay: z.boolean().describe("Paierait-elle cet abonnement cette semaine ?"),
  reason: z.string().min(1).describe("Raison concrète, en une ou deux phrases"),
});

const system = [
  "Tu incarnes une personne réelle, pas un assistant.",
  "Ton budget est limité, tu as déjà des abonnements et des alternatives gratuites existent.",
  "Par défaut tu es indifférent : une adhésion doit se justifier par un besoin concret.",
  "Réponds uniquement par un objet JSON conforme au schéma demandé.",
].join(" ");

const prompt =
  "Tu es une étudiante de 19 ans à Lyon, boursière, 180 € de reste-à-vivre par mois. " +
  "On te propose une app d'organisation des révisions à 5 €/mois. " +
  'Réponds en JSON : {"persona": string, "wouldPay": boolean, "reason": string}.';

loadDotEnv();
const config = loadConfig();
let failures = 0;

const PAID: ReadonlySet<string> = new Set(["anthropic", "openai", "openrouter", "gemini"]);

for (const name of values.profile ? [values.profile] : targets) {
  let engine: Engine;
  try {
    engine = values.profile ? getProfileEngine(config, { profile: values.profile }) : getEngine(name as ProviderKind, config);
  } catch (err) {
    failures++;
    console.log(t.engineCheck.engineFailed(errorText(err)));
    continue;
  }
  const { backend } = engine;
  console.log(
    values.profile
      ? t.engineCheck.profileHeader(name, backend.name, backend.model, backend.concurrency)
      : t.engineCheck.header(name, backend.model, backend.concurrency),
  );

  const availability = await backend.checkAvailability();
  console.log(t.engineCheck.availability(availability.ok, errorText(availability.detail)));
  if (!availability.ok) {
    if (availability.hint) console.log(`→ ${errorText(availability.hint)}`);
    failures++;
    continue;
  }

  if (PAID.has(backend.name)) console.log(t.engineCheck.paidNotice(backend.name));
  try {
    const res = await engine.complete({
      system,
      messages: [{ role: "user", content: prompt }],
      schema: reactionSchema,
      temperature: 0.7,
      maxTokens: 400,
    });
    const u = res.usage;
    console.log(t.engineCheck.latency((res.durationMs / 1000).toFixed(1)));
    console.log(t.engineCheck.model(res.model));
    console.log(t.engineCheck.tokens(u.inputTokens, u.outputTokens, u.cacheReadTokens, u.costUsd, backend.name === "claude-cli" ? "subscription" : "provider"));
    console.log(t.engineCheck.attempts(res.attempts));
    console.log(t.engineCheck.result, JSON.stringify(res.data, null, 2));
  } catch (err) {
    failures++;
    console.log(t.engineCheck.requestFailed(errorText(err)));
  }
}

process.exitCode = failures > 0 ? 1 : 0;
