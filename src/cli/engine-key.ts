import { parseArgs } from "node:util";
import { loadConfig, loadDotEnv } from "../config";
import { createBackendFromProfile } from "../engine";
import { redactSecrets } from "../engine/backends/http";
import { findProfile, loadEngineConfig } from "../engine/profiles";
import { defaultSecretStore, KEYLESS_PROVIDERS, KeychainUnavailableError, resolveApiKey } from "../engine/secrets";
import { readSecret } from "./secret-input";
import { errorText, t } from "./i18n";

/**
 * Clés des profils dans le trousseau du système : set (entrée standard, saisie masquée), remove, test.
 * La clé n'est jamais affichée ni écrite ailleurs que dans le trousseau.
 */

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    profile: { type: "string", short: "p" },
    help: { type: "boolean", short: "h" },
  },
});

const [command] = positionals;
if (values.help || !command || !values.profile) {
  console.log(t.engineKey.usage);
  process.exit(values.help ? 0 : 2);
}

loadDotEnv();
const config = loadConfig();
const store = defaultSecretStore();

try {
  const profile = findProfile(values.profile, config, loadEngineConfig());
  if (KEYLESS_PROVIDERS.has(profile.provider)) {
    console.log(t.engineKey.noKey(profile.name, profile.provider));
    process.exit(0);
  }
  switch (command) {
    case "set": {
      const key = (await readSecret(t.engineKey.prompt(profile.name))).trim();
      if (!key) {
        console.error(t.engineKey.empty);
        process.exitCode = 1;
        break;
      }
      await store.set(profile.name, key);
      console.log(t.engineKey.saved(profile.name));
      break;
    }
    case "remove": {
      console.log(t.engineKey.removed(profile.name, await store.remove(profile.name)));
      break;
    }
    case "test": {
      const r = await resolveApiKey(profile, { store });
      console.log(t.engineKey.source(r.source, profile.keyEnv));
      if (r.warning) console.log(`→ ${errorText(r.warning)}`);
      // Point d'accès gratuit (catalogue ou fiche du modèle) : aucune génération, aucun token facturé
      const backend = createBackendFromProfile(profile, config, { secrets: store, warn: () => {} });
      const a = await backend.checkAvailability();
      console.log(t.engineCheck.availability(a.ok, errorText(redactSecrets(a.detail, [r.key]))));
      if (!a.ok && a.hint) console.log(`→ ${errorText(a.hint)}`);
      process.exitCode = a.ok ? 0 : 1;
      break;
    }
    default:
      console.error(t.engineProfile.unknownCommand(command));
      console.log(t.engineKey.usage);
      process.exitCode = 2;
  }
} catch (err) {
  console.error(err instanceof KeychainUnavailableError ? t.engineKey.keychainUnavailable(err.message) : errorText(redactSecrets(errorText(err))));
  process.exitCode = 1;
}
