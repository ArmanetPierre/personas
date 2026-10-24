/**
 * Messages console de la CLI en français : la référence (et le type) des dictionnaires de src/cli/i18n.ts.
 * Ces textes doivent rester identiques à l'historique, octet pour octet (scripts et habitudes en dépendent).
 * Pas de prompt LLM ici : seulement ce que la CLI affiche.
 */

type NarrativesRun = { alreadyDone: number; reused: number; written: number; calls: number; usage: { inputTokens: number; outputTokens: number }; durationMs: number };
const narrativesHead = (r: NarrativesRun) =>
  `Récits : ${r.alreadyDone} déjà écrits, ${r.reused} repris de jumeaux, ${r.written} écrits (${r.calls} appel(s), ` +
  `${r.usage.inputTokens} tokens en entrée, ${r.usage.outputTokens} en sortie, ${(r.durationMs / 1000).toFixed(0)} s)`;

export const fr = {
  common: {
    /** Suffixe d'un pourcentage : « 12 % » en français, « 12% » en anglais. */
    pct: " %",
    /** Virgule décimale (« 1,5 ») ou point (« 1.5 ») là où la sortie l'adapte. */
    decimalComma: true,
    projectNotFound: (id: string) => `Projet introuvable : ${id}`,
    projectNotFoundAnywhere: (id: string) => `Projet introuvable : ${id} (ni fichier ni id en base).`,
    noResponses: (id: string) => `Aucune réponse pour l'étude ${id}.`,
    json: (path: string) => `JSON : ${path}`,
    callsTokens: (calls: number, input: number, output: number) => `Appels : ${calls} ; tokens ${input} en entrée, ${output} en sortie.`,
    filter: (source: string | undefined) => `Filtre : ${source ?? "(aucun : population générale)"}`,
    draftStatus: (id: string, status: string, progress: string) => `Brouillon ${id} : ${status} — ${progress}`,
    error: (e: string) => `Erreur : ${e}`,
    none: "aucun",
  },
  calibrationFit: {
    usage:
      "Usage : npm run calibration:fit -- [--truth calibration/truth.json] [--write] [--out calibration/payment-v3.json]\n" +
      "  Renseigner studyId (étude v3 terminée) et realPayShare pour chaque produit de truth.json, puis relancer.\n" +
      "  Sans --write : affiche l'ajustement sans rien écrire.",
    fileNotFound: (f: string) => `Fichier introuvable : ${f}`,
    skipped: (product: string, noStudy: boolean) => `- ${product} : ignoré (${noStudy ? "pas d'étude" : "pas de réel"})`,
    notV3: (product: string, study: string, version: string) => `${product} : l'étude ${study} est en protocole v${version} ; la conversion s'ajuste sur des études v3 ou v4 (même mesure).`,
    noLowTier: (product: string, study: string) => `${product} : aucun palier sous le prix affiché dans ${study}.`,
    point: (product: string, study: string, n: number, price: number, yes: number) => `- ${product} : ${study}, n = ${n}, oui à ${price} : ${yes}`,
    refused: (reason: string, version: string, status: string) => `Ajustement refusé : ${reason}\nParamètres inchangés (${version}, ${status}).`,
    ready: (next: string, json: string) => `\nAjustement ${next} prêt (non écrit) :\n${json}\nÉcrire : npm run calibration:fit -- --write`,
    written: (out: string, next: string) => `Écrit : ${out} (${next}, calibrée).`,
  },
  engineCheck: {
    usage: (backends: string) => `Usage : npm run engine:check [-- --backend <${backends}> | --profile <profil>]`,
    unknownBackend: (b: string, expected: string) => `Backend inconnu : ${b} (attendus : ${expected})`,
    header: (name: string, model: string, concurrency: number) => `\n=== ${name} (modèle ${model}, concurrence ${concurrency}) ===`,
    availability: (ok: boolean, detail: string) => `Disponibilité : ${ok ? "OK" : "ÉCHEC"} — ${detail}`,
    latency: (s: string) => `Latence : ${s} s`,
    model: (m: string) => `Modèle : ${m}`,
    tokens: (input: number, output: number, cacheRead: number | undefined, costUsd: number | undefined, billing: "subscription" | "provider" = "subscription") =>
      `Tokens : ${input} en entrée, ${output} en sortie` +
      (cacheRead ? ` (dont ${cacheRead} lus en cache)` : "") +
      (costUsd ? ` — coût indicatif ${costUsd.toFixed(4)} $ (${billing === "subscription" ? "couvert par l'abonnement" : "facturé par le fournisseur"})` : ""),
    attempts: (n: number) => `Tentatives : ${n}`,
    result: "Résultat :",
    requestFailed: (msg: string) => `Requête : ÉCHEC — ${msg}`,
    profileHeader: (profile: string, provider: string, model: string, concurrency: number) =>
      `\n=== ${profile} — ${provider} (modèle ${model}, concurrence ${concurrency}) ===`,
    paidNotice: (provider: string) => `Requête réelle vers ${provider} avec votre clé : quelques centaines de tokens facturés sur votre compte.`,
    engineFailed: (msg: string) => `Moteur : ÉCHEC — ${msg}`,
  },
  engineProfile: {
    usage:
      "Usage : npm run engine:profile -- <commande>\n" +
      "  list                                   profils (intégrés et ~/.personas/config.json), * = actif\n" +
      "  add --name <nom> --provider <fournisseur> --model <modèle> [--base-url <url>] [--concurrency <n>]\n" +
      "      [--timeout-ms <ms>] [--key-env <VARIABLE>] [--per-study-usd <n>] [--per-day-usd <n>] [--per-month-usd <n>] [--use]\n" +
      "  use <nom>                              profil actif par défaut (PERSONAS_PROFILE ou --profile l'emportent)\n" +
      "  limit <nom> [--per-study-usd <n>] [--per-day-usd <n>] [--per-month-usd <n>] [--clear]\n" +
      "                                         plafonds de dépense (défaut : 5 $ par étude pour un fournisseur payant)\n" +
      "  remove <nom>\n" +
      "Fournisseurs : claude-cli, anthropic, openai, openrouter, gemini, openai-compatible, ollama.\n" +
      "La clé ne va jamais dans ce fichier : npm run engine:key -- set --profile <nom>.",
    file: (path: string) => `Fichier : ${path}`,
    row: (active: boolean, name: string, provider: string, model: string, extra: string) =>
      `${active ? "*" : " "} ${name} — ${provider}, modèle ${model}${extra ? ` (${extra})` : ""}`,
    builtin: "intégré, réglé par l'environnement",
    concurrency: (n: number) => `concurrence ${n}`,
    keyEnv: (name: string) => `clé : trousseau, sinon ${name}`,
    limits: (s: string) => `plafonds ${s}`,
    limitsSet: (name: string, s: string) => `Plafonds du profil ${name} : ${s}. Une étude en pause sur plafond reprend avec npm run study:run -- --study <id>.`,
    limitsBuiltin: (name: string) => `Le profil intégré ${name} n'a pas de plafond (abonnement ou modèle local).`,
    activeFrom: (name: string, source: string) => `Profil actif : ${name} (${source})`,
    sourceFlag: "option --profile",
    sourceEnv: "variable PERSONAS_PROFILE",
    sourceFile: "fichier de profils",
    sourceDefault: "défaut",
    added: (name: string) => `Profil ${name} enregistré.`,
    keyHint: (name: string) => `Ranger la clé dans le trousseau : npm run engine:key -- set --profile ${name}`,
    used: (name: string) => `Profil actif : ${name}.`,
    removed: (name: string) => `Profil ${name} supprimé. Sa clé reste dans le trousseau : npm run engine:key -- remove --profile ${name}`,
    missing: (what: string) => `Option manquante : ${what}`,
    unknownCommand: (c: string) => `Commande inconnue : ${c}`,
  },
  engineKey: {
    usage:
      "Usage : npm run engine:key -- <set|remove|test> --profile <nom>\n" +
      "  set     lit la clé sur l'entrée standard (saisie masquée) et la range dans le trousseau (personas/<nom>)\n" +
      "  remove  retire la clé du trousseau\n" +
      "  test    vérifie la clé auprès du fournisseur (point d'accès gratuit, aucune génération)",
    prompt: (profile: string) => `Clé du profil ${profile} (saisie masquée, Entrée pour valider) : `,
    empty: "Clé vide : rien n'est enregistré.",
    saved: (profile: string) => `Clé du profil ${profile} rangée dans le trousseau du système (personas/${profile}).`,
    removed: (profile: string, found: boolean) => (found ? `Clé du profil ${profile} retirée du trousseau.` : `Aucune clé dans le trousseau pour ${profile}.`),
    noKey: (profile: string, provider: string) => `Le profil ${profile} (${provider}) n'utilise pas de clé.`,
    keychainUnavailable: (msg: string) =>
      `${msg}\nStockage en clair refusé. Sans trousseau : nommer une variable dans le profil (engine:profile -- add … --key-env NOM) et l'exporter dans l'environnement.`,
    source: (s: "keychain" | "env" | "none", env: string | undefined) =>
      s === "keychain" ? "Clé : trousseau du système" : s === "env" ? `Clé : variable ${env ?? "?"}` : "Clé : aucune",
  },
  mcp: {
    ready: (db: string, tools: number) => `Serveur MCP Personas prêt (stdio) : ${tools} outils, base ${db}.`,
    fatal: (e: string) => `Serveur MCP arrêté sur une erreur : ${e}`,
  },
  migrate: {
    applied: (path: string) => `Migrations appliquées sur ${path}`,
    tables: (list: string) => `Tables : ${list}`,
  },
  moduleAccept: {
    usage: "Usage : npm run module:accept -- --draft <draftId> [--replace]",
    accepted: (id: string, file: string) => `Module ${id} validé : ${file}`,
  },
  modulePreview: {
    usage: "Usage : npm run module:preview -- --draft <draftId> | --module <id> [--n 10000] [--sample 5] [--json]",
    header: (id: string, socle: string, n: number) => `# Aperçu ${id} sur ${socle}, ${n} personas virtuelles`,
    margin: (label: string, attribute: string, type: string, applicable: number) => `\n${label} (${attribute}, ${type}, concerne ${applicable})`,
    helpers: "\nFiltres prêts à l'emploi :",
    helper: (name: string, rate: string, expression: string) => `  ${name} : ${rate} % — ${expression}`,
    alerts: "\nAlertes :",
  },
  modulePropose: {
    usage:
      'Usage : npm run module:propose -- --description "<domaine>" [--id <module-id>] [--project <id|fichier>] [--socle fr] [--draft <draftId>] [--no-research]\n' +
      "  --draft : reprend (ou nomme) un brouillon ; l'état est suivi dans modules/_drafts/<draftId>/meta.json.",
    usageLine: (calls: number, input: number, output: number, s: string) => `Appels : ${calls} ; tokens : ${input} en entrée, ${output} en sortie ; ${s} s`,
  },
  moduleRevise: {
    usage:
      'Usage : npm run module:revise -- --draft <draftId> --instruction "<modification>" [--research]\n  --research : recherche web ciblée (WebSearch, WebFetch seulement), fusionnée dans research.json, avant la révision.',
    total: (calls: number, input: number, output: number) => `Cumul du brouillon : ${calls} appel(s), ${input} tokens en entrée, ${output} en sortie.`,
  },
  personasGenerate: {
    usage: "Usage : npm run personas:generate -- [--count 1000] [--seed 42] [--pack fr] [--reset]",
    badArgs: "--count doit être un entier ≥ 1 et --seed un entier.",
    reset: (removed: number, version: string, seed: number) => `--reset : ${removed} persona(s) supprimée(s) (pack ${version}, graine ${seed}).`,
    alreadyDone: (existing: number, version: string, seed: number) => `Déjà fait : ${existing} personas présentes pour le pack ${version} et la graine ${seed}. Rien à faire.`,
    tooMany: (existing: number, version: string, seed: number, count: number) =>
      `La base contient déjà ${existing} personas pour le pack ${version} et la graine ${seed} (plus que --count ${count}). ` +
      "Relancer avec --reset pour repartir de zéro.",
    done: (n: number, start: number, version: string, seed: number, ms: number, total: number) =>
      `${n} personas tirées et insérées${start ? ` (complément des ${start} existantes)` : ""} — ` +
      `pack ${version}, graine ${seed}, ${ms} ms. Total pour ce tirage : ${total}.`,
    next: "Étapes suivantes : npm run personas:validate, puis npm run personas:narrate -- --limit N",
    failed: (msg: string) => `Échec : ${msg}`,
  },
  personasMigrateModules: {
    usage: "Usage : npm run personas:migrate-modules -- [--pack fr-tech-founders] [--dry-run]",
    noModules: (version: string) => `Le pack ${version} n'active aucun module : rien à migrer.`,
    result: (version: string, total: number, migrated: number, dryRun: boolean, already: number, mismatches: number) =>
      `${version} : ${total} personas ; ${migrated} ${dryRun ? "à migrer" : "migrées"}, ${already} déjà au format modules, ${mismatches} écart(s).`,
  },
  personasNarrate: {
    usage:
      "Usage : npm run personas:narrate -- [--pack fr] [--limit N] [--batch-size 10] [--backend claude-cli]\n" +
      "        npm run personas:narrate -- --regenerate --before 2026-10-13T08:00:00Z [--limit N]\n" +
      "  --regenerate : réécrit aussi les récits datés d'avant --before (narrative_at, ISO 8601 UTC).\n" +
      "  L'ancien récit reste en place jusqu'à ce que le nouveau soit validé ; relancer avec le même --before reprend.",
    backendRefused: (b: string) => `Backend refusé : ${b} (claude-cli ou ollama).`,
    regenerateNeedsBefore: "--regenerate exige --before <date ISO> (ex. 2026-10-13T08:00:00Z) pour rester reprenable.",
    allDone: "Toutes les personas ont déjà un récit.",
    start: (n: number, batchSize: number, backend: string, model: string, concurrency: number) =>
      `${n} récit(s) à écrire, lots de ${batchSize}, backend ${backend} (${model}), concurrence ${concurrency}.`,
    summary: (written: number, total: number, s: string, batches: number, failedBatches: number, rejected: number) =>
      `\n${written}/${total} récits écrits en ${s} s, ${batches} appel(s)` +
      (failedBatches ? `, ${failedBatches} appel(s) en échec` : "") +
      (rejected ? `, ${rejected} récit(s) redemandé(s)` : "") +
      ".",
    tokens: (input: number, cacheRead: number, output: number, costUsd: number | undefined) =>
      `Tokens : ${input} en entrée (dont ${cacheRead} lus en cache), ${output} en sortie` +
      (costUsd ? ` ; coût indicatif ${costUsd.toFixed(3)} $ (couvert par l'abonnement)` : "") +
      ".",
    average: (s: string, tokens: number) => `Moyenne : ${s} s et ${tokens} tokens de sortie par récit (concurrence comprise).`,
    wholeBase: (n: number) => `\nBase entière (${n} récits) : `,
    aborted: (reason: string) => `\nArrêt sur limite d'usage : ${reason}`,
    stillMissing: (n: number) => `\n${n} persona(s) sans récit après une reprise (seront retentées au prochain lancement) :`,
    missingLine: (id: string, issues: string[]) => `- ${id} : ${issues.join(" ; ") || "échec"}`,
    more: (n: number) => `… et ${n} autres.`,
  },
  personasShow: {
    usage:
      "Usage : npm run personas:show -- --sample 5 [--all] [--salt N] [--pack fr-tech-founders]   (par défaut, seulement des personas avec récit)\n" +
      "        npm run personas:show -- --id fr-2026.1-s42-0001 [--id …]",
    notFound: (id: string) => `Persona introuvable : ${id}`,
    emptyBase: "Base vide.",
    noNarrative: "Aucune persona avec récit (ajouter --all, ou lancer personas:narrate).",
    sample: (salt: number) => `(échantillon --salt ${salt})`,
  },
  personasValidate: {
    usage:
      "Usage : npm run personas:validate -- [--pack fr] [--seed 42]\n" +
      "        npm run personas:validate -- --pack fr-2026.2 --modules numerique,entrepreneuriat --virtual 20000 [--seed 42]\n" +
      "  --virtual N : valide N personas virtuelles tirées à la volée (socle v2 + modules), sans passer par la base.",
    none: (version: string) => `Aucune persona pour le pack ${version}. Lancer d'abord npm run personas:generate.`,
    header: (version: string, modules: string, n: number, virtual: boolean) =>
      `# Validation des marges — pack ${version}${modules ? ` + ${modules}` : ""}, ${n} personas${virtual ? " virtuelles" : ""}`,
    /** Rapport des marges et de la plausibilité (src/cli/validate-report.ts). Les libellés des dimensions viennent du pack. */
    report: {
      kind: { drawn: "tirée", modelled: "modélisée", info: "info" },
      /** En-têtes des colonnes : observé, attendu, écart (alignés sur 7, 7 et 8 caractères). */
      columns: { observed: "base", expected: "cible", deviation: "écart" },
      dimensionSummary: (maxDev: string, chi2: string, df: number, p: string, verdict: string) => `→ écart max ${maxDev} pt ; chi² ${chi2} (ddl ${df}, p = ${p}) ; ${verdict}`,
      indicative: "indicatif",
      ok: "OK",
      fail: "ÉCHEC",
      overallTitle: "\n## Indicateur global",
      maxAbsDev: (dev: string, title: string) => `Écart absolu max : ${dev} pt (${title})`,
      minPValue: (p: string, title: string) => `Plus petite p-value du chi² (dimensions tirées) : ${p} (${title})`,
      thresholds: (minP: number, tolerance: string, n: number, maxModelled: number) =>
        `Seuils : dimensions tirées p ≥ ${minP} et écart ≤ ${tolerance} pt (n=${n}) ; dimensions modélisées écart ≤ ${maxModelled} pt`,
      resultFail: (titles: string) => `RÉSULTAT : ÉCHEC (${titles})`,
      resultOk: "RÉSULTAT : OK",
      plausibilityTitle: "\n## Plausibilité",
    },
  },
  populationDraw: {
    usage:
      "Usage : npm run population:draw -- --target cible.yaml [--n 300] [--seed 42] [--persist]\n" +
      "        npm run population:draw -- --project <id | fichier projet> [--group target|control] [--n 300] [--drafts]\n" +
      "  --drafts : autorise les brouillons de modules (modules/_drafts), en lecture seule, pour l'aperçu d'une cible.\n" +
      'Cible (YAML/JSON) : { socle: fr, modules: [numerique, entrepreneuriat], eligibility: "age >= 25 and …", quotas: {…} }',
    noGroup: (group: string, src: string) => `Pas de bloc « ${group} » dans le projet ${src}.`,
    draftsNoPersist: "--drafts est réservé à l'aperçu : pas de --persist avec des modules non validés.",
    draftsAllowed: (list: string) => `Brouillons autorisés (lecture seule) : ${list || "aucun"}`,
    nRequired: "Effectif requis : --n ou `n` dans la cible.",
    socle: (version: string, modules: string) => `Socle ${version} ; modules : ${modules || "aucun"}`,
    retained: (n: number, draws: string, ms: number) => `${n} personas retenues sur ${draws} tirages virtuels (${ms} ms)`,
    rate: (rate: string, lo: string, hi: string, eligible: number) => `Taux d'éligibilité : ${rate} [IC 95 % ${lo} ; ${hi}] (${eligible} éligibles)`,
    quota: (s: string) => `⚠ quota : ${s}`,
    age: (d: string) => `Âge : ${d}`,
    sexRegion: (sex: string, region: string) => `Sexe : ${sex} ; région : ${region}`,
    pcsActivity: (pcs: string, activity: string) => `PCS : ${pcs} ; activité : ${activity}`,
    segment: (label: string, d: string) => `${label} : ${d}`,
    cache: (inserted: number, updated: number, reused: number) => `Cache : ${inserted} ajoutées, ${updated} complétées, ${reused} déjà présentes.`,
  },
  projectCreate: {
    usage: "Usage : npm run project:create -- --file examples/meal-planner.json [--update]",
    saved: (updated: boolean, id: string) => `Projet ${updated ? "enregistré" : "créé"} : ${id}`,
    tiers: (list: string) => `  Paliers Gabor-Granger : ${list}`,
  },
  projectList: {
    none: "Aucun projet. Créer : npm run project:create -- --file <fichier>",
    row: (id: string, name: string, price: string, created: string) => `${id}  ${name}  ${price}  (créé ${created})`,
  },
  projectNeutralizePitch: {
    usage: "Usage : npm run project:neutralize-pitch -- --project <id|fichier.json|yaml> [--out proposition.json]",
    header: (id: string, toneBefore: number, toneAfter: number, lexBefore: number, lexAfter: number) =>
      `Projet ${id} — ton ${toneBefore} → ${toneAfter}/100 (score lexical ${lexBefore} → ${lexAfter})`,
    unchanged: "Pitch déjà factuel : aucune modification proposée.",
    passages: (n: number) => `\nPassages repérés (${n}) :`,
    passage: (category: string, text: string, replacement: string | null, reason: string) =>
      `  [${category}] « ${text} » → ${replacement ? `« ${replacement} »` : "(supprimé)"}\n      ${reason}`,
    originalNeutral: (original: string, neutral: string) => `\nOriginal :\n  ${original}\n\nVersion neutre proposée :\n  ${neutral}`,
    facts: (ok: boolean, repaired: boolean, numbersMissing: string, numbersAdded: string, namesMissing: string, factsMissing: string) =>
      `\nConservation des faits : ${ok ? "OK" : "ÉCARTS"}${repaired ? " (après une réparation)" : ""}` +
      (ok ? "" : ` — nombres manquants ${numbersMissing}, ajoutés ${numbersAdded}, noms manquants ${namesMissing}, faits manquants ${factsMissing}`),
    missingInfo: (lines: string) => `Informations manquantes à l'original (à compléter par le porteur, non inventées) :\n${lines}`,
    proposal: (out: string) => `\nProposition (non appliquée) : ${out}`,
  },
  projectSuggestProtocol: {
    usage: "Usage : npm run project:suggest-protocol -- --project <id|fichier.json|yaml> [--out proposition.json]",
    header: (id: string, name: string) => `Projet ${id} — ${name}`,
    evidence: (n: number, studies: string) => `Objections de ${n} réponses (${studies}).`,
    noEvidence: "Aucune étude existante : proposition à partir du pitch seul.",
    productType: (type: string | undefined) => `\nType de produit : ${type}`,
    behaviors: "Comportements :",
    objections: "Objections :",
    relevance: "Pertinence :",
    rationale: (r: string) => `\nJustification : ${r}`,
    fixes: (list: string[]) => `Corrections automatiques : ${list.join(" ; ")}`,
    proposal: (out: string, yaml: string) => `\nProposition (non appliquée) : ${out}\nBloc à copier dans le fichier projet : ${yaml}`,
    tokens: (input: number, output: number) => `Tokens : ${input} en entrée, ${output} en sortie.`,
  },
  studyCompare: {
    usage: "Usage : npm run study:compare -- --studies st-ref,st-v1,st-v2 [--group target] [--normalize monthly-eur] [--json] [--out fichier.json]",
    unknownNormalize: (v: string) => `Normalisation inconnue : ${v} (monthly-eur)`,
  },
  studyCreate: {
    usage:
      "Usage : npm run study:create -- --project <id> --n 200 [--seed 7] [--backend claude-cli|ollama] [--model <m>]\n" +
      "          [--quotas '{\"ageBand\":{\"18-29\":0.25,\"30-44\":0.25,\"45-59\":0.25,\"60-79\":0.25}}']\n" +
      "        npm run study:create -- --project <id> --population fr-tech-founders-2026.1 --n 200 \\\n" +
      "          --control-population fr-2026.1 --control-n 50 [--control-quotas '<json>'] --seed 7\n" +
      "        npm run study:create -- --project <id> --same-sample-as <étude> [--same-sample-group target] [--n 10] --backend ollama\n" +
      "        npm run study:create -- --project examples/projet.json [--n 50] [--control-n 20] [--seed 42] [--no-narrate]\n" +
      "          (fichier ou id d'un projet qui déclare `target` / `control` : ciblage conditionnel, personas tirées à la demande,\n" +
      "           récits manquants écrits via claude-cli sauf --no-narrate)\n" +
      "Projet multi-rôles (bloc `roles`) : un groupe par rôle, chacun avec sa cible ; effectifs par rôle : --role-n coach=20,member=40\n" +
      "Protocole : --protocol 4 (défaut : v3 et lignes de module dans un bloc délimité ; pitch neutre exigé, --force pour passer outre), --protocol 3 ou --protocol 2 (protocoles figés des études existantes).\n" +
      "Dimensions de quotas : ageBand, sex, pcs (1-6, none), livingStandard (Q1-Q5), techAdoption, townSize, activityStatus, region.\n" +
      "Moteur : --profile <nom> (sinon PERSONAS_PROFILE, le profil actif, puis claude-cli) ; --backend claude-cli|ollama garde son sens historique.\n" +
      "L'estimation du coût est affichée avant la création ; modèle sans prix connu : --accept-unknown-cost.",
    unknownProtocol: (p: string) => `Protocole inconnu : ${p} (--protocol 2, 3 ou 4).`,
    backendRefused: (b: string) => `Backend refusé : ${b} (claude-cli ou ollama ; jamais l'API payante).`,
    loaded: (id: string, file: string) => `Projet ${id} chargé depuis ${file}.`,
    nRequired: "Taille d'échantillon requise (--n), ou un projet avec un bloc `target`.",
    sizesRequired: "Effectifs requis : --n pour la cible, --control-n pour le témoin.",
    created: (id: string, name: string) => `Étude créée : ${id} — ${name}`,
    population: (group: string, n: number, packVersion: string, quotas: boolean) => `  ${group} : ${n} personas de ${packVersion}${quotas ? " (quotas)" : ""}`,
    protocol: (protocol: string, version: string) => `  Protocole ${protocol} v${version}`,
    sample: (size: number, seed: number, backend: string, model: string, from: string | null) =>
      `  ${size} personas, graine ${seed}, ${backend} / ${model}` + (from ? `, échantillon repris de ${from}` : ""),
    shortfalls: (list: string[]) => `  ⚠ Quotas non remplis :\n  - ${list.join("\n  - ")}`,
    narrateBackendRefused: (b: string) => `Backend de récit refusé : ${b}`,
    unknownCost: (model: string) => `Coût inconnu pour le modèle ${model} (absent de pricing/models.json) : confirmer avec --accept-unknown-cost, ou ajouter son prix au fichier.`,
    unknownCostAccepted: "Coût inconnu accepté pour cette étude : le plafond comptera chaque appel au prix du modèle le plus cher du fournisseur (pricing/models.json).",
    engine: (profile: string, provider: string, model: string) => `  Moteur : profil ${profile} (${provider} / ${model})`,
    narratives: (r: NarrativesRun & { missing: unknown[]; aborted?: string | null | undefined }) =>
      narrativesHead(r) +
      (r.missing.length ? ` ; ${r.missing.length} manquant(s), relancer pour reprendre` : "") +
      (r.aborted ? ` ; arrêt sur limite d'usage : ${r.aborted}` : "") +
      ".",
    launch: (id: string) => `Lancer : npm run study:run -- --study ${id}`,
  },
  studyDrivers: {
    usage: "Usage : npm run study:drivers -- --study <id> [--top 10] [--json] [--out fichier.json]",
    header: (id: string, name: string, group: string | null | undefined, n: number) =>
      `Facteurs d'engagement — étude ${id} (${name})${group ? `, groupe « ${group} »` : ""}, n = ${n}`,
  },
  studyList: {
    none: "Aucune étude.",
    sampleOf: (id: string) => `  (échantillon de ${id})`,
  },
  studyRecode: {
    usage: "Usage : npm run study:recode -- --study <id> --taxonomy <proposition.json|yaml> [--key nom] [--group target] [--batch-size 40]",
    header: (id: string, key: string, n: number) => `Étude ${id} — taxonomie « ${key} » (${n} catégories)`,
    run: (objections: number, responses: number, calls: number, input: number, output: number) =>
      `${objections} objection(s) de ${responses} réponse(s) à reclasser ; ${calls} appel(s), ${input} tokens en entrée, ${output} en sortie.`,
    usageLimit: (s: string) => `⏸ Limite d'usage : ${s}\nReprendre plus tard avec la même commande.`,
    noneRecoded: "Aucune réponse recodée.",
    title: (group: string | null, n: number) => `\nObjections reclassées${group ? ` (groupe « ${group} »)` : ""}, n = ${n} (part des répondants qui citent la catégorie)`,
    example: (ex: string) => `      « ${ex} »`,
    oldCategories: (list: string) => `\nAnciennes catégories : ${list}`,
    whence: "D'où viennent les nouvelles catégories (nombre d'objections) :",
  },
  studyRecommend: {
    usage:
      "Usage : npm run study:recommend -- --study <id> [--force]\n" +
      "        npm run study:recommend -- --study <id> --create <recId> --confirm   (crée la variante et l'étude, sans la lancer)",
    needConfirm: "Ajouter --confirm : la variante du projet et l'étude seront créées (l'étude n'est pas lancée).",
    projectCreated: (id: string, file: string | null | undefined) => `Projet créé : ${id}${file ? ` (${file})` : ""}`,
    studyCreated: (id: string) => `Étude créée, non lancée : ${id}\nLancer : npm run study:run -- --study ${id}`,
    findings: "Constats",
    recommendations: "\nRecommandations",
    caveats: "\nPrudence",
    evidence: (metric: string, value: string, source: string) => `      · ${metric} : ${value}  [${source}]`,
    recommendation: (i: number, kind: string, title: string, confidence: string, id: string) => `  ${i}. [${kind}] ${title} (confiance ${confidence}) — id ${id}`,
    nextStudy: (sample: string, n: number, control: number | null | undefined, calls: number, minutes: number, eligibility: string | null) =>
      `     → Étude suivante (${sample}, n = ${n}${control ? ` + ${control} témoins` : ""}, ≈ ${calls} appels, ≈ ${minutes} min${eligibility !== null ? `, éligibilité ${eligibility} %` : ""})`,
    nextStudyDetail: (hypothesis: string, success: string, patch: string) => `       Hypothèse : ${hypothesis}\n       Succès si : ${success}\n       Patch : ${patch}`,
    create: (studyId: string, recId: string) => `       Créer : npm run study:recommend -- --study ${studyId} --create ${recId} --confirm`,
    verification: (valid: number, checked: number, repaired: boolean, dropped: number, droppedNext: number) =>
      `\nVérification : ${valid}/${checked} preuves valides${repaired ? " après une réparation" : ""} ; ${dropped} supprimée(s) ; ${droppedNext} étude(s) suivante(s) écartée(s).`,
    dropped: (where: string, source: string, value: string, reason: string) => `  - supprimée : ${where} [${source}] « ${value} » : ${reason}`,
    droppedNext: (recommendation: string, reason: string) => `  - écartée : ${recommendation} : ${reason}`,
  },
  studyRun: {
    usage: "Usage : npm run study:run -- --study <id> [--concurrency N]",
    usageMore: "  [--profile <nom>] [--no-narrate] [--accept-unknown-cost] ; moteur : le profil enregistré dans l'étude (--profile pour un autre profil du même fournisseur).",
    profile: (name: string) => `Profil ${name}`,
    budget: (s: string) => `\n⏸ Plafond de dépense atteint : ${s}`,
    unknownCostBlocked: (s: string) => `\n⏸ ${s}`,
    budgetResume: (id: string) => `Les réponses déjà obtenues sont enregistrées. Relever le plafond (npm run engine:profile -- limit <profil> --per-study-usd <n>), puis reprendre :\n  npm run study:run -- --study ${id}`,
    narrativesBudget: (reason: string, id: string) => `Plafond de dépense atteint pendant les récits : ${reason}\nRelever le plafond puis reprendre : npm run study:run -- --study ${id}`,
    estimate: (lines: string[]) => lines.map((l) => `  ${l}`).join("\n"),
    backendRefused: (b: string) => `Backend refusé : ${b}`,
    unavailable: (backend: string, detail: string, hint: string | undefined) => `${backend} indisponible : ${detail}${hint ? `\n→ ${hint}` : ""}`,
    header: (id: string, name: string) => `Étude ${id} — ${name}`,
    engine: (backend: string, model: string, concurrency: number) => `${backend} / ${model}, concurrence ${concurrency}`,
    narratives: (r: NarrativesRun & { missing: unknown[] }) => narrativesHead(r) + (r.missing.length ? ` ; ${r.missing.length} sans récit (fiche seule)` : "") + ".",
    narrativesAborted: (reason: string, id: string) => `Limite d'usage pendant les récits : ${reason}\nRelancer plus tard : npm run study:run -- --study ${id}`,
    written: (written: number, s: string, already: number, total: number) => `\n${written} réponse(s) écrite(s) en ${s} s (${already} déjà faites, ${total} au total).`,
    tokens: (input: number, cacheRead: number, output: number, perResponse: string, costUsd: number | undefined) =>
      `Tokens : ${input} en entrée (dont ${cacheRead} en cache), ${output} en sortie ; ` +
      `${perResponse} s par réponse (concurrence comprise)` +
      (costUsd ? ` ; coût indicatif ${costUsd.toFixed(3)} $ (couvert par l'abonnement)` : "") +
      ".",
    quota: (s: string) => `\n⏸ Quota atteint : ${s}`,
    quotaResume: (id: string) => `Les réponses déjà obtenues sont enregistrées. Reprendre après la réinitialisation du quota :\n  npm run study:run -- --study ${id}`,
    aborted: (reason: string, id: string) => `\n✖ Étude arrêtée : ${reason}\nCorriger la cause puis relancer : npm run study:run -- --study ${id}`,
    failed: (n: number, id: string) => `\n${n} échec(s) ; relancer pour les reprendre : npm run study:run -- --study ${id}`,
    complete: (id: string) => `\nÉtude complète. Résumé : npm run study:summary -- --study ${id}`,
  },
  studyEstimate: {
    usage:
      "Usage : npm run study:estimate -- --project <id | fichier> [--n 200] [mêmes options de population que study:create] [--profile <nom>] [--json]\n" +
      "        npm run study:estimate -- --study <id> [--profile <nom>] [--json]   (reste d'une étude existante)\n" +
      "Estimation avant lancement : appels, tokens, coût (fourchette ±30 %) et durée ; aucune écriture, aucun appel au modèle.",
  },
  studySummary: {
    usage: "Usage : npm run study:summary -- --study <id> [--json] [--out fichier.json]",
    noResponses: (id: string) => `Aucune réponse pour l'étude ${id} : lancer study:run.`,
  },
  targetPreview: {
    usage:
      "Usage : npm run target:preview -- --project <id | fichier> [--group target|control] [--n 200] [--sample 10] [--seed 42]\n" +
      "                                 [--triage] [--threshold 0.5] [--alert 0.1] [--drafts] [--json]\n" +
      "  --triage : pré-tri de pertinence par le Qwen local (2 appels par persona, concurrence 2, en cache).\n" +
      "  --drafts : autorise les brouillons de modules (lecture seule).",
    header: (group: string, name: string) => `\n# Aperçu de la cible « ${group} » du projet ${name}`,
    socle: (socle: string, modules: string, seed: number) => `Socle ${socle} ; modules : ${modules || "aucun"} ; graine ${seed}`,
    draws: (n: number, draws: string) => `${n} personas sur ${draws} tirages virtuels`,
    rate: (rate: string, lo: string, hi: string) => `Taux d'éligibilité : ${rate} [IC 95 % ${lo} ; ${hi}]`,
    quota: (s: string) => `quota : ${s}`,
    distributions: "\n## Distributions de l'échantillon",
    distribution: (label: string, inFilter: boolean, multi: boolean, values: string, more: boolean) =>
      `- ${label}${inFilter ? " [filtre]" : ""}${multi ? " (plusieurs possibles)" : ""} : ${values}${more ? ", …" : ""}`,
    cards: (n: number) => `\n## ${n} fiches, telles que le protocole les verra`,
    triage: (model: string) => `\n## Pré-tri de pertinence (${model})`,
    alert: "⚠ ALERTE : ",
    argmax: (concerned: number, marginal: number, notConcerned: number, flagged: number, threshold: number) =>
      `Étiquette la plus probable : concernée ${concerned}, marginale ${marginal}, pas concernée ${notConcerned} ; ` +
      `${flagged} personas avec P(pas concernée) ≥ ${threshold} (à relire)`,
    profiles: "Profils typiques des « pas concernées » :",
    criterion: (label: string, value: string) => `${label} = ${value}`,
    criteriaJoin: " et ",
    profile: (criteria: string, n: number, rate: string, lift: string, inReview: number, examples: string) =>
      `- ${criteria} : ${n} personas, ≈ ${rate} pas concernées (× ${lift}), ${inReview} dans les fiches à relire ; ex. ${examples}`,
    review: (n: number) => `Fiches à relire (${n}, les plus probablement pas concernées) :`,
    /** Lignes extraites de la fiche (contenu, non traduit). */
    reviewLine: (id: string, p: string, lines: string[]) => `- ${id} (P = ${p}) : ${lines.join(" ; ")}`,
    calls: (calls: number, cached: number, s: string, failed: number) => `Appels Qwen : ${calls} (+ ${cached} en cache), ${s} s${failed ? ` ; ${failed} personas en échec` : ""}`,
    duration: (s: string) => `\nDurée totale : ${s} s`,
  },
  hub: {
    searchUsage:
      "Usage : personas hub search <texte> [--socle fr] [--limit 20] [--remote] [--json]\n" +
      "  Recherche locale (BM25) dans la bibliothèque et le catalogue du Hub en cache ; rien n'est envoyé au Hub.\n" +
      "  --remote : recherche sur le Hub (le texte tapé est envoyé, jamais un projet).",
    pullUsage: "Usage : personas hub pull <namespace/module>[@version] [--pack]\n  Télécharge dans le cache local (sha256 vérifié) ; sans version : la dernière du catalogue.",
    syncUsage: "Usage : personas hub sync [--json]\n  Met à jour le catalogue du Hub en cache (ETag). Hors ligne : garde le dernier catalogue.",
    publishUsage:
      "Usage : personas hub publish <module.yaml | dossier de pack> --namespace personas [--slug <pays>] [--dry-run]\n" +
      "  Administration : jeton HUB_ADMIN_TOKEN (environnement) ou trousseau (compte hub-admin), jamais affiché.",
    lockUsage:
      "Usage : personas hub lock <projet : id | fichier> [--check]\n" +
      "  Épingle socle et modules (versions exactes, sha256) dans projects.extra.lock et <projet>.personas.lock.\n" +
      "  --check : compare sans rien écrire.",
    hubUrl: (url: string) => `Hub : ${url}`,
    catalogNetwork: (modules: number, packs: number, at: string) => `Catalogue téléchargé : ${modules} module(s), ${packs} pack(s) (${at}).`,
    catalogNotModified: (at: string) => `Catalogue à jour (ETag inchangé, ${at}).`,
    catalogCache: (at: string) => `Hors ligne : dernier catalogue en cache (${at}).`,
    catalogNone: "Aucun catalogue : Hub injoignable et rien en cache.",
    offline: (msg: string) => `⚠ ${msg}`,
    noResults: (q: string) => `Aucun module pour « ${q} ».`,
    result: (ref: string, version: string, source: string, label: string, quality: string, socles: string) => `- ${ref}@${version} [${source}] ${label}\n  ${quality} ; socles : ${socles}`,
    sources: { local: "local", cache: "cache", hub: "Hub (à télécharger)" } as Record<string, string>,
    pulled: (kind: string, ref: string, version: string, sha: string) => `Téléchargé : ${kind} ${ref}@${version} (sha256 ${sha.slice(0, 12)}…)`,
    alreadyCached: (kind: string, ref: string, version: string) => `Déjà en cache : ${kind} ${ref}@${version} (vérifié)`,
    bundled: (kind: string, ref: string, version: string) => `Livré avec Personas : ${kind} ${ref}@${version} (packs/ du paquet, prioritaire) ; rien à télécharger ni à mettre en cache.`,
    kinds: { module: "module", pack: "pack" } as Record<string, string>,
    warning: (w: string) => `⚠ ${w}`,
    cacheDir: (dir: string) => `Cache : ${dir}`,
    noToken: "Jeton d'administration absent : définir HUB_ADMIN_TOKEN ou le ranger dans le trousseau (compte hub-admin).",
    tokenSource: (source: string) => `Jeton d'administration : ${source} (non affiché).`,
    tokenSources: { env: "variable HUB_ADMIN_TOKEN", keychain: "trousseau" } as Record<string, string>,
    dryRun: (kind: string, ref: string, version: string, sha: string) => `Contrôle seul (--dry-run) : ${kind} ${ref}@${version}, sha256 ${sha.slice(0, 12)}…, rien n'est envoyé.`,
    published: (ref: string, version: string, sha: string, quality: string) => `Publié : ${ref}@${version} (sha256 ${sha.slice(0, 12)}…) ; ${quality}`,
    lockWritten: (where: string) => `Lock écrit : ${where}`,
    lockStored: (id: string) => `Lock enregistré dans le projet ${id} (projects.extra.lock).`,
    lockUnchanged: "Lock inchangé.",
    lockChanges: "Changements :",
    lockEntry: (ref: string, version: string, sha: string, source: string) => `  ${ref}@${version}  sha256 ${sha.slice(0, 12)}…  (${source})`,
    lockSocle: (socle: string, ref: string, version: string, sha: string) => `  socle ${socle} : ${ref}@${version}  sha256 ${sha.slice(0, 12)}…`,
    lockCheckDiff: "Le lock enregistré diffère de la résolution actuelle (rien n'est écrit) :",
    lockNoProject: (p: string) => `Projet introuvable : ${p} (ni fichier ni id en base).`,
    // Phase 3 : compte, publication par l'utilisateur, fork, étoiles, avis, signalements, télémétrie
    loginUsage: "Usage : personas hub login\n  Connexion par flux d'appareil : un code s'affiche, la validation se fait dans le navigateur ; le jeton personnel est rangé dans le trousseau (compte hub-token), jamais affiché.",
    logoutUsage: "Usage : personas hub logout\n  Retire le jeton personnel du trousseau.",
    whoamiUsage: "Usage : personas hub whoami [--json]\n  Compte connecté (GET /v1/me).",
    loginOpen: (uri: string) => `Ouvrir ${uri} dans le navigateur et se connecter au Hub,`,
    loginCode: (code: string) => `puis saisir le code : ${code}`,
    loginDirect: (uri: string) => `(lien direct : ${uri})`,
    loginWaiting: (min: number) => `En attente de la validation (le code expire dans ${min} min ; Ctrl+C pour annuler)…`,
    loginDone: (ns: string, name: string, store: string, expires: string) => `Connecté : ${name} (namespace ${ns}). Jeton rangé dans le ${store} (non affiché), valable jusqu'au ${expires}.`,
    loginStores: { keychain: "trousseau du système", memory: "magasin en mémoire (test)" } as Record<string, string>,
    loginFailed: (msg: string) => `Connexion impossible : ${msg}`,
    logoutDone: "Déconnecté : jeton retiré du trousseau.",
    logoutNone: "Aucun jeton dans le trousseau (rien à retirer).",
    logoutEnv: "PERSONAS_HUB_TOKEN est défini dans l'environnement : le retirer aussi.",
    notLoggedIn: "Pas connecté au Hub : lancer personas hub login (ou définir PERSONAS_HUB_TOKEN).",
    tokenRejected: "Jeton refusé par le Hub (expiré ou révoqué) : relancer personas hub login.",
    whoami: (name: string, ns: string, role: string, scopes: string, via: string) => `${name} — namespace ${ns}, rôle ${role}\n  portées : ${scopes} ; jeton : ${via} (non affiché)`,
    whoamiOffline: (msg: string, ns: string) => `⚠ ${msg}\n  Dernier compte connu : namespace ${ns}.`,
    personalTokenSources: { env: "variable PERSONAS_HUB_TOKEN", keychain: "trousseau" } as Record<string, string>,
    userPublishUsage:
      "Usage : personas hub publish <module : id | module.yaml> [--namespace <ns>] [--dry-run]\n" +
      "        personas hub publish <dossier de pack> [--slug <pays>] [--dry-run]\n" +
      "  Publie dans le namespace du compte connecté (personas hub login) ; seul le YAML du module est envoyé.\n" +
      "  Lint de sécurité local avant l'envoi : une erreur bloque.\n" +
      "  Administration (modules officiels, namespace personas) : --admin, jeton HUB_ADMIN_TOKEN ou trousseau (compte hub-admin).",
    lintErrors: (n: number) => `Lint de sécurité : ${n} erreur(s), rien n'est envoyé :`,
    lintWarnings: (n: number) => `Lint de sécurité : ${n} avertissement(s) :`,
    lintOk: "Lint de sécurité : aucune alerte.",
    validationErrors: (n: number) => `Validation : ${n} erreur(s), rien n'est envoyé :`,
    issue: (path: string, msg: string) => `  - ${path ? `${path} : ` : ""}${msg}`,
    sensitiveDeclared: (keys: string) => `Attributs sensibles déclarés (badge « sensible ») : ${keys}`,
    publishedAs: (ref: string, version: string, sha: string, status: string) => `Publié : ${ref}@${version} (sha256 ${sha.slice(0, 12)}…), statut ${status}.`,
    publishedSigned: (kid: string) => `Version signée par le Hub (clé ${kid}).`,
    forkUsage: "Usage : personas hub fork <namespace/module>[@version] [--as <id>]\n  Fork dans le namespace du compte (filiation enregistrée), téléchargé dans le cache, puis copie éditable dans modules/<id>.",
    forked: (ref: string, version: string, from: string) => `Fork créé sur le Hub : ${ref}@${version} (depuis ${from}).`,
    forkLocal: (file: string, id: string) => `Copie éditable : ${file}\n  La modifier (version, libellés…), puis personas hub publish ${id}.`,
    starUsage: "Usage : personas hub star <namespace/module>\n       personas hub unstar <namespace/module>",
    starred: (ref: string, n: number) => `★ ${ref} : étoile ajoutée (${n} au total).`,
    unstarred: (ref: string, n: number) => `${ref} : étoile retirée (${n} au total).`,
    reviewUsage: "Usage : personas hub review <namespace/module@version> --rating 1-5 [--text « avis »]\n  Avis public sur une version (1000 caractères au plus).",
    reviewed: (ref: string, version: string, rating: number) => `Avis enregistré : ${ref}@${version}, ${rating}/5.`,
    reportUsage:
      "Usage : personas hub report <namespace/module>[@version] --reason <malicious|injection|sensitive|rights|other> [--text « détail »]\n" +
      "  Signale une version à la modération du Hub (sans version : la dernière du catalogue).",
    reported: (ref: string, version: string, n: number, status: string) => `Signalement enregistré : ${ref}@${version} (${n} signalement(s), statut ${status}).`,
    badRating: (v: string) => `Note invalide : ${v} (entier de 1 à 5).`,
    badReason: (v: string) => `Motif invalide : ${v} (malicious, injection, sensitive, rights ou other).`,
    needVersion: (ref: string) => `Version requise : ${ref}@<version>.`,
    telemetryUsage:
      "Usage : personas hub telemetry on|off|status [--json]\n" +
      "  Télémétrie opt-in, désactivée par défaut : à la fin d'une étude, seuls des agrégats partent (modules du Hub@version,\n" +
      "  socle, nombre de personas, protocole, version du moteur, famille de modèle), avec un identifiant d'installation renouvelé\n" +
      "  chaque mois. Jamais de projet, pitch, cible, réponse ni identifiant d'étude.",
    telemetryOn: "Télémétrie activée. Exemple de ce qui part à la fin d'une étude :",
    telemetryOff: "Télémétrie désactivée (file d'attente vidée) : rien n'est envoyé.",
    telemetryStatus: (on: boolean, pending: number) => `Télémétrie : ${on ? "activée" : "désactivée"}${on && pending ? ` (${pending} agrégat(s) en attente d'envoi)` : ""}.`,
  },
  targetSuggest: {
    usage:
      "Usage : npm run target:suggest -- --project <id | fichier> [--triage] [--no-preview] [--n 200] [--seed 42] [--out fichier.yaml] [--json]\n" +
      "  Écrit la proposition dans <projet>.target-suggestion.yaml (ou data/suggestions/<id>.target-suggestion.yaml).",
    header: (name: string, model: string) => `\n# Proposition de cible pour ${name} (${model})`,
    usageConditions: "\nConditions d'usage :",
    condition: (condition: string, attribute: string, why: string) => `- ${condition} → ${attribute || "(aucun attribut)"} : ${why}`,
    variants: "\nVariantes :",
    modulesFilter: (modules: string, filter: string | undefined) => `Modules : ${modules || "aucun"}\nFiltre : ${filter}`,
    quotas: (json: string) => `Quotas : ${json}`,
    justification: (criterion: string, why: string) => `  · ${criterion} : ${why}`,
    errors: (list: string[]) => `⚠ ${list.join(" ; ")}`,
    eligibility: (rate: string, lo: string, hi: string, draws: string) => `Éligibilité : ${rate} [IC 95 % ${lo} ; ${hi}] (${draws} tirages)`,
    triage: (message: string) => `Pré-tri : ${message}`,
    missingModules: "\nModules manquants :",
    missingModule: (id: string, description: string, attributes: string[], why: string) => `- ${id} : ${description}\n  attributs : ${attributes.join(" ; ")}\n  pourquoi : ${why}`,
    note: (n: string) => `Note : ${n}`,
    claude: (calls: number, repairs: number, s: string) => `\nClaude : ${calls} appel(s), ${repairs} réparation(s) ; durée ${s} s`,
    written: (path: string) => `Proposition écrite dans ${path} (rien n'est appliqué au projet).`,
  },
  personasCli: {
    intro: "Personas — simulateur de personas synthétiques : un filtre à mauvaises idées, pas un oracle.",
    usage: "Usage : personas <commande> [options]\n  personas <commande> --help : options d'une commande.",
    dashboard: "Tableau de bord",
    commands: "Commandes",
    uiDescription: "ouvre le tableau de bord dans le navigateur (port libre de 127.0.0.1, Ctrl+C pour arrêter)",
    uiUsage: "Usage : personas ui [--port N] [--no-open]\n  --port N   port d'écoute sur 127.0.0.1 (défaut : un port libre)\n  --no-open  ne pas ouvrir le navigateur",
    paths: (dataDir: string, config: string) => `Données : ${dataDir}\nProfils de moteur : ${config}`,
    unknown: (cmd: string) => `Commande inconnue : ${cmd}. Voir personas --help.`,
    unknownOption: (option: string, cmd: string) => `Option inconnue : ${option}. Options de la commande : ${cmd} --help.`,
    badArguments: (detail: string, cmd: string) => `Arguments invalides (${detail}). Options de la commande : ${cmd} --help.`,
    group: (group: string) => `Commandes « ${group} » :`,
    uiReady: (url: string) => `Personas — tableau de bord : ${url}  (Ctrl+C pour arrêter)`,
    uiData: (dataDir: string) => `Données : ${dataDir}`,
    uiStopped: "Tableau de bord arrêté.",
    uiBadPort: (v: string) => `Port invalide : ${v} (entier de 0 à 65535 ; 0 = port libre).`,
    descriptions: {
      "calibration:fit": "ajuste la conversion « oui au palier bas » → part payante sur des produits au résultat connu",
      "db:migrate": "crée ou met à jour la base SQLite",
      "engine:check": "vérifie les moteurs (une petite requête JSON)",
      "engine:key": "range, teste ou retire la clé d'un profil dans le trousseau",
      "engine:profile": "liste, ajoute, active ou retire un profil de moteur",
      mcp: "serveur MCP local (stdio)",
      "module:accept": "valide un brouillon de module",
      "module:preview": "aperçu d'un module sur un tirage",
      "module:propose": "propose un module avec l'assistant",
      "module:revise": "révise un brouillon de module",
      "personas:generate": "tire des personas (sans appel au LLM)",
      "personas:migrate-modules": "met à jour les modules des personas en base",
      "personas:narrate": "écrit les récits des personas",
      "personas:show": "affiche une persona",
      "personas:validate": "contrôle les marges d'un tirage",
      "population:draw": "tire la cible d'un projet (sans appel au LLM)",
      "project:create": "crée ou met à jour un projet depuis un fichier YAML ou JSON",
      "project:list": "liste les projets",
      "project:neutralize-pitch": "propose une version factuelle du pitch",
      "project:suggest-protocol": "propose un protocole adapté au projet",
      "study:compare": "compare des études",
      "study:create": "crée une étude",
      "study:drivers": "facteurs qui expliquent les réponses",
      "study:list": "liste les études",
      "study:recode": "reclasse les objections dans une autre taxonomie",
      "study:recommend": "recommande l'étude suivante",
      "study:run": "lance une étude",
      "study:estimate": "estime le coût d'une étude avant lancement (appels, tokens, coût, durée)",
      "pricing:reference": "mesure la table de référence des tokens (sans identifiant d'étude)",
      "study:summary": "résumé d'une étude",
      "target:preview": "aperçu de la cible d'un projet",
      "target:suggest": "suggère une cible pour un projet",
      "hub:fork": "forke un module du Hub dans son namespace et en écrit une copie éditable dans modules/",
      "hub:login": "connexion au Hub (flux d'appareil) ; jeton personnel rangé dans le trousseau",
      "hub:logout": "retire le jeton personnel du Hub du trousseau",
      "hub:report": "signale une version de module à la modération du Hub",
      "hub:review": "publie un avis (note de 1 à 5) sur une version de module",
      "hub:star": "ajoute une étoile à un module du Hub",
      "hub:telemetry": "active, coupe ou affiche la télémétrie opt-in (désactivée par défaut)",
      "hosted:reactivate": "réactive une adresse e-mail supprimée du service hébergé (administration)",
      "hosted:start": "démarre le service web hébergé (comptes Supabase, clé IA de chaque utilisateur, une base par compte)",
      "hub:unstar": "retire son étoile d'un module du Hub",
      "hub:whoami": "affiche le compte du Hub connecté",
      "hub:lock": "épingle les versions exactes (sha256) du socle et des modules d'un projet (personas.lock)",
      "hub:publish": "publie un module (namespace du compte, lint de sécurité) ou un pack sur le Hub ; --admin : modules officiels",
      "hub:pull": "télécharge un module ou un pack du Hub dans le cache local (sha256 vérifié)",
      "hub:search": "cherche un module en local (bibliothèque et catalogue du Hub), --remote sur le Hub",
      "hub:sync": "met à jour le catalogue du Hub en cache (ETag ; hors ligne : dernier catalogue)",
      "triage:validate": "évalue le pré-tri de pertinence",
    } as Record<string, string>,
  },
  hostedReactivate: {
    usage:
      "Usage : personas hosted reactivate <e-mail | identifiant Supabase> [--data-root <dossier>]\n" +
      "Retire un compte supprimé de la liste des comptes refusés du service hébergé (<HOSTED_DATA_ROOT>/_system/deleted-accounts.json).\n" +
      "Dossier des comptes : --data-root, sinon HOSTED_DATA_ROOT. Le serveur relit la liste sans redémarrage.",
    missing: "Adresse e-mail (ou identifiant Supabase) requise.",
    noDataRoot: "Dossier des comptes inconnu : --data-root ou HOSTED_DATA_ROOT requis.",
    done: (n: number) => `${n} entrée(s) retirée(s) : cette adresse peut de nouveau se connecter (compte vide).`,
    none: "Aucune entrée pour cette adresse : rien à réactiver.",
  },
  triageValidate: {
    usage: "Usage : npm run triage:validate -- --studies a,b [--portrait] [--limit N] [--out fichier.json]",
    references: (n: number, studies: string, portrait: boolean) => `${n} réponses de référence (${studies}) ; fiche ${portrait ? "et portrait" : "seule"}.`,
    calls: (calls: number, cached: number, s: string, failed: number) => `Appels : ${calls} (+ ${cached} en cache), ${s} s ; échecs : ${failed}`,
    failure: (id: string, error: string) => `  échec ${id} : ${error}`,
    thresholds: "\nSeuil τ sur P(pas concerné) — ensemble :",
    thresholdsHeader: "τ     rappel NC  précision  faux NC  part réf.  part est.",
    agreement: (exact: string, qwk: string, mean: string) => `\nAccord exact ${exact}, kappa quadratique ${qwk} ; moyenne P(NC) ${mean}`,
    confusion: "Confusion (lignes : Claude ; colonnes : Qwen) :",
    byGroup: "\nPar étude et groupe : part de « pas concernés » (Claude / moyenne des P(NC) Qwen), AUC, puis au seuil 0,3 :",
    group: (key: string, n: string, ref: string, est: string, auc: string, recall: string, falseNc: string, exact: string, qwk: string) =>
      `  ${key} n=${n}  réf. ${ref}  est. ${est}  ` + `AUC ${auc}  rappel ${recall}  faux NC ${falseNc}  exact ${exact}  qwk ${qwk}`,
    detail: (out: string) => `\nDétail : ${out}`,
  },
};

export type CliMessages = typeof fr;
