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
    notV3: (product: string, study: string, version: string) => `${product} : l'étude ${study} est en protocole v${version} ; la conversion s'ajuste sur des études v3.`,
    noLowTier: (product: string, study: string) => `${product} : aucun palier sous le prix affiché dans ${study}.`,
    point: (product: string, study: string, n: number, price: number, yes: number) => `- ${product} : ${study}, n = ${n}, oui à ${price} : ${yes}`,
    refused: (reason: string, version: string, status: string) => `Ajustement refusé : ${reason}\nParamètres inchangés (${version}, ${status}).`,
    ready: (next: string, json: string) => `\nAjustement ${next} prêt (non écrit) :\n${json}\nÉcrire : npm run calibration:fit -- --write`,
    written: (out: string, next: string) => `Écrit : ${out} (${next}, calibrée).`,
  },
  engineCheck: {
    usage: (backends: string) => `Usage : npm run engine:check [-- --backend <${backends}>]`,
    unknownBackend: (b: string, expected: string) => `Backend inconnu : ${b} (attendus : ${expected})`,
    header: (name: string, model: string, concurrency: number) => `\n=== ${name} (modèle ${model}, concurrence ${concurrency}) ===`,
    availability: (ok: boolean, detail: string) => `Disponibilité : ${ok ? "OK" : "ÉCHEC"} — ${detail}`,
    latency: (s: string) => `Latence : ${s} s`,
    model: (m: string) => `Modèle : ${m}`,
    tokens: (input: number, output: number, cacheRead: number | undefined, costUsd: number | undefined) =>
      `Tokens : ${input} en entrée, ${output} en sortie` +
      (cacheRead ? ` (dont ${cacheRead} lus en cache)` : "") +
      (costUsd ? ` — coût indicatif ${costUsd.toFixed(4)} $ (couvert par l'abonnement)` : ""),
    attempts: (n: number) => `Tentatives : ${n}`,
    result: "Résultat :",
    requestFailed: (msg: string) => `Requête : ÉCHEC — ${msg}`,
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
      "Protocole : --protocol 3 (défaut, pitch neutre exigé ; --force pour passer outre) ou --protocol 2 (protocole figé des études existantes).\n" +
      "Dimensions de quotas : ageBand, sex, pcs (1-6, none), livingStandard (Q1-Q5), techAdoption, townSize, activityStatus, region.",
    unknownProtocol: (p: string) => `Protocole inconnu : ${p} (--protocol 2 ou 3).`,
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
