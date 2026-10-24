import { parseArgs } from "node:util";
import { loadConfig, loadDotEnv } from "../config";
import {
  activeProfileName,
  engineConfigPath,
  isBuiltinProfile,
  listProfiles,
  loadEngineConfig,
  PROVIDER_KINDS,
  removeProfileFrom,
  saveEngineConfig,
  setActiveProfile,
  upsertProfile,
  type EngineProfile,
} from "../engine/profiles";
import { profileBudget } from "../engine/select";
import { errorText, t } from "./i18n";

/** Profils de moteur : list, add, use, remove (fichier ~/.personas/config.json, jamais de clé). */

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: "string" },
    provider: { type: "string" },
    model: { type: "string" },
    "base-url": { type: "string" },
    concurrency: { type: "string" },
    "timeout-ms": { type: "string" },
    "key-env": { type: "string" },
    "per-study-usd": { type: "string" },
    "per-day-usd": { type: "string" },
    "per-month-usd": { type: "string" },
    use: { type: "boolean", default: false },
    clear: { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
  },
});

const [command, arg] = positionals;
if (values.help || !command) {
  console.log(t.engineProfile.usage);
  process.exit(values.help ? 0 : 2);
}

loadDotEnv();
const config = loadConfig();
const path = engineConfigPath();
const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));

try {
  const file = loadEngineConfig(path);
  switch (command) {
    case "list": {
      console.log(t.engineProfile.file(path));
      const fromEnv = process.env.PERSONAS_PROFILE?.trim();
      const active = activeProfileName({ file });
      const source = fromEnv ? t.engineProfile.sourceEnv : file.activeProfile ? t.engineProfile.sourceFile : t.engineProfile.sourceDefault;
      for (const p of listProfiles(config, file)) {
        const extra = [
          isBuiltinProfile(p.name) ? t.engineProfile.builtin : "",
          p.baseUrl ?? "",
          p.concurrency !== undefined ? t.engineProfile.concurrency(p.concurrency) : "",
          p.keyEnv ? t.engineProfile.keyEnv(p.keyEnv) : "",
          p.limits ? t.engineProfile.limits(JSON.stringify(p.limits)) : "",
        ].filter(Boolean);
        console.log(t.engineProfile.row(p.name === active, p.name, p.provider, p.model, extra.join(", ")));
      }
      console.log(t.engineProfile.activeFrom(active, source));
      break;
    }
    case "add": {
      for (const k of ["name", "provider", "model"] as const) {
        if (!values[k]) throw new Error(t.engineProfile.missing(`--${k}`));
      }
      const limits = {
        ...(values["per-study-usd"] && { perStudyUsd: num(values["per-study-usd"]) }),
        ...(values["per-day-usd"] && { perDayUsd: num(values["per-day-usd"]) }),
        ...(values["per-month-usd"] && { perMonthUsd: num(values["per-month-usd"]) }),
      };
      const profile = {
        name: values.name!,
        provider: values.provider as (typeof PROVIDER_KINDS)[number],
        model: values.model!,
        ...(values["base-url"] && { baseUrl: values["base-url"] }),
        ...(values.concurrency && { concurrency: num(values.concurrency) }),
        ...(values["timeout-ms"] && { timeoutMs: num(values["timeout-ms"]) }),
        ...(values["key-env"] && { keyEnv: values["key-env"] }),
        ...(Object.keys(limits).length && { limits }),
      } as EngineProfile;
      let next = upsertProfile(file, profile);
      if (values.use) next = setActiveProfile(next, profile.name, config);
      saveEngineConfig(next, path);
      console.log(t.engineProfile.added(profile.name));
      if (values.use) console.log(t.engineProfile.used(profile.name));
      if (profile.provider !== "claude-cli" && profile.provider !== "ollama") console.log(t.engineProfile.keyHint(profile.name));
      break;
    }
    case "limit": {
      // Plafonds de dépense d'un profil du fichier : relevés, une étude en pause sur plafond reprend avec study:run
      const name = arg ?? values.name;
      if (!name) throw new Error(t.engineProfile.missing("<profil>"));
      if (isBuiltinProfile(name)) {
        console.log(t.engineProfile.limitsBuiltin(name));
        break;
      }
      const current = file.profiles.find((p) => p.name === name);
      if (!current) throw new Error(`Profil inconnu : ${name}`);
      const limits = {
        ...(values.clear ? {} : (current.limits ?? {})),
        ...(values["per-study-usd"] && { perStudyUsd: num(values["per-study-usd"]) }),
        ...(values["per-day-usd"] && { perDayUsd: num(values["per-day-usd"]) }),
        ...(values["per-month-usd"] && { perMonthUsd: num(values["per-month-usd"]) }),
      };
      const { limits: _old, ...rest } = current;
      const next = { ...rest, ...(Object.keys(limits).length && { limits }) } as EngineProfile;
      saveEngineConfig(upsertProfile(file, next), path);
      const eff = profileBudget(next).limits;
      console.log(t.engineProfile.limitsSet(name, JSON.stringify(eff)));
      break;
    }
    case "use": {
      const name = arg ?? values.name;
      if (!name) throw new Error(t.engineProfile.missing("<profil>"));
      saveEngineConfig(setActiveProfile(file, name, config), path);
      console.log(t.engineProfile.used(name));
      break;
    }
    case "remove": {
      const name = arg ?? values.name;
      if (!name) throw new Error(t.engineProfile.missing("<profil>"));
      saveEngineConfig(removeProfileFrom(file, name), path);
      console.log(t.engineProfile.removed(name));
      break;
    }
    default:
      console.error(t.engineProfile.unknownCommand(command));
      console.log(t.engineProfile.usage);
      process.exitCode = 2;
  }
} catch (err) {
  console.error(errorText(err));
  process.exitCode = 1;
}
