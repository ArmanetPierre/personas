import { cliMessageEn } from "./error-patterns";
import type { CliMessages } from "./messages.fr";

/**
 * Messages console de la CLI en anglais. Typé par la référence française : une clé manquante,
 * en trop ou d'une autre signature est une erreur de typecheck.
 */

type NarrativesRun = { alreadyDone: number; reused: number; written: number; calls: number; usage: { inputTokens: number; outputTokens: number }; durationMs: number };
const narrativesHead = (r: NarrativesRun) =>
  `Narratives: ${r.alreadyDone} already written, ${r.reused} reused from twins, ${r.written} written (${r.calls} call(s), ` +
  `${r.usage.inputTokens} input tokens, ${r.usage.outputTokens} output, ${(r.durationMs / 1000).toFixed(0)} s)`;

export const en: CliMessages = {
  common: {
    pct: "%",
    decimalComma: false,
    projectNotFound: (id) => `Project not found: ${id}`,
    projectNotFoundAnywhere: (id) => `Project not found: ${id} (neither a file nor an id in the database).`,
    noResponses: (id) => `No responses for study ${id}.`,
    json: (path) => `JSON: ${path}`,
    callsTokens: (calls, input, output) => `Calls: ${calls}; tokens ${input} input, ${output} output.`,
    filter: (source) => `Filter: ${source ?? "(none: general population)"}`,
    draftStatus: (id, status, progress) => `Draft ${id}: ${status} — ${progress}`,
    error: (e) => `Error: ${e}`,
    none: "none",
  },
  calibrationFit: {
    usage:
      "Usage: npm run calibration:fit -- [--truth calibration/truth.json] [--write] [--out calibration/payment-v3.json]\n" +
      "  Fill in studyId (a finished v3 study) and realPayShare for each product in truth.json, then run again.\n" +
      "  Without --write: shows the fit without writing anything.",
    fileNotFound: (f) => `File not found: ${f}`,
    skipped: (product, noStudy) => `- ${product}: skipped (${noStudy ? "no study" : "no real value"})`,
    notV3: (product, study, version) => `${product}: study ${study} uses protocol v${version}; the conversion is fitted on v3 or v4 studies (same measure).`,
    noLowTier: (product, study) => `${product}: no tier below the displayed price in ${study}.`,
    point: (product, study, n, price, yes) => `- ${product}: ${study}, n = ${n}, yes at ${price}: ${yes}`,
    refused: (reason, version, status) => `Fit refused: ${reason}\nParameters unchanged (${version}, ${status}).`,
    ready: (next, json) => `\nFit ${next} ready (not written):\n${json}\nWrite it: npm run calibration:fit -- --write`,
    written: (out, next) => `Written: ${out} (${next}, calibrated).`,
  },
  engineCheck: {
    usage: (backends) => `Usage: npm run engine:check [-- --backend <${backends}> | --profile <profile>]`,
    unknownBackend: (b, expected) => `Unknown backend: ${b} (expected: ${expected})`,
    header: (name, model, concurrency) => `\n=== ${name} (model ${model}, concurrency ${concurrency}) ===`,
    availability: (ok, detail) => `Availability: ${ok ? "OK" : "FAILED"} — ${detail}`,
    latency: (s) => `Latency: ${s} s`,
    model: (m) => `Model: ${m}`,
    tokens: (input, output, cacheRead, costUsd, billing = "subscription") =>
      `Tokens: ${input} input, ${output} output` +
      (cacheRead ? ` (${cacheRead} of them read from cache)` : "") +
      (costUsd ? ` — indicative cost $${costUsd.toFixed(4)} (${billing === "subscription" ? "covered by the subscription" : "billed by the provider"})` : ""),
    attempts: (n) => `Attempts: ${n}`,
    result: "Result:",
    requestFailed: (msg) => `Request: FAILED — ${msg}`,
    profileHeader: (profile, provider, model, concurrency) => `\n=== ${profile} — ${provider} (model ${model}, concurrency ${concurrency}) ===`,
    paidNotice: (provider) => `Real request to ${provider} with your key: a few hundred tokens billed to your account.`,
    engineFailed: (msg) => `Engine: FAILED — ${msg}`,
  },
  engineProfile: {
    usage:
      "Usage: npm run engine:profile -- <command>\n" +
      "  list                                   profiles (built-in and ~/.personas/config.json), * = active\n" +
      "  add --name <name> --provider <provider> --model <model> [--base-url <url>] [--concurrency <n>]\n" +
      "      [--timeout-ms <ms>] [--key-env <VARIABLE>] [--per-study-usd <n>] [--per-day-usd <n>] [--per-month-usd <n>] [--use]\n" +
      "  use <name>                             default active profile (PERSONAS_PROFILE or --profile take precedence)\n" +
      "  limit <name> [--per-study-usd <n>] [--per-day-usd <n>] [--per-month-usd <n>] [--clear]\n" +
      "                                         spending caps (default: $5 per study for a paid provider)\n" +
      "  remove <name>\n" +
      "Providers: claude-cli, anthropic, openai, openrouter, gemini, openai-compatible, ollama.\n" +
      "The key never goes into this file: npm run engine:key -- set --profile <name>.",
    file: (path) => `File: ${path}`,
    row: (active, name, provider, model, extra) => `${active ? "*" : " "} ${name} — ${provider}, model ${model}${extra ? ` (${extra})` : ""}`,
    builtin: "built-in, set by the environment",
    concurrency: (n) => `concurrency ${n}`,
    keyEnv: (name) => `key: keychain, else ${name}`,
    limits: (s) => `caps ${s}`,
    limitsSet: (name, s) => `Caps of profile ${name}: ${s}. A study paused on a cap resumes with npm run study:run -- --study <id>.`,
    limitsBuiltin: (name) => `The built-in profile ${name} has no cap (subscription or local model).`,
    activeFrom: (name, source) => `Active profile: ${name} (${source})`,
    sourceFlag: "--profile option",
    sourceEnv: "PERSONAS_PROFILE variable",
    sourceFile: "profiles file",
    sourceDefault: "default",
    added: (name) => `Profile ${name} saved.`,
    keyHint: (name) => `Store the key in the keychain: npm run engine:key -- set --profile ${name}`,
    used: (name) => `Active profile: ${name}.`,
    removed: (name) => `Profile ${name} removed. Its key stays in the keychain: npm run engine:key -- remove --profile ${name}`,
    missing: (what) => `Missing option: ${what}`,
    unknownCommand: (c) => `Unknown command: ${c}`,
  },
  engineKey: {
    usage:
      "Usage: npm run engine:key -- <set|remove|test> --profile <name>\n" +
      "  set     reads the key from standard input (hidden) and stores it in the keychain (personas/<name>)\n" +
      "  remove  removes the key from the keychain\n" +
      "  test    checks the key with the provider (free endpoint, no generation)",
    prompt: (profile) => `Key for profile ${profile} (hidden input, press Enter to confirm): `,
    empty: "Empty key: nothing saved.",
    saved: (profile) => `Key for profile ${profile} stored in the system keychain (personas/${profile}).`,
    removed: (profile, found) => (found ? `Key for profile ${profile} removed from the keychain.` : `No key in the keychain for ${profile}.`),
    noKey: (profile, provider) => `Profile ${profile} (${provider}) does not use a key.`,
    keychainUnavailable: (msg) =>
      `${msg}\nPlain-text storage refused. Without a keychain: name a variable in the profile (engine:profile -- add … --key-env NAME) and export it in the environment.`,
    source: (s, env) => (s === "keychain" ? "Key: system keychain" : s === "env" ? `Key: variable ${env ?? "?"}` : "Key: none"),
  },
  mcp: {
    ready: (db, tools) => `Personas MCP server ready (stdio): ${tools} tools, database ${db}.`,
    fatal: (e) => `MCP server stopped on an error: ${e}`,
  },
  migrate: {
    applied: (path) => `Migrations applied to ${path}`,
    tables: (list) => `Tables: ${list}`,
  },
  moduleAccept: {
    usage: "Usage: npm run module:accept -- --draft <draftId> [--replace]",
    accepted: (id, file) => `Module ${id} validated: ${file}`,
  },
  modulePreview: {
    usage: "Usage: npm run module:preview -- --draft <draftId> | --module <id> [--n 10000] [--sample 5] [--json]",
    header: (id, socle, n) => `# Preview of ${id} on ${socle}, ${n} virtual personas`,
    margin: (label, attribute, type, applicable) => `\n${label} (${attribute}, ${type}, applies to ${applicable})`,
    helpers: "\nReady-made filters:",
    helper: (name, rate, expression) => `  ${name}: ${rate}% — ${expression}`,
    alerts: "\nAlerts:",
  },
  modulePropose: {
    usage:
      'Usage: npm run module:propose -- --description "<domain>" [--id <module-id>] [--project <id|file>] [--socle fr] [--draft <draftId>] [--no-research]\n' +
      "  --draft: resumes (or names) a draft; its state is tracked in modules/_drafts/<draftId>/meta.json.",
    usageLine: (calls, input, output, s) => `Calls: ${calls}; tokens: ${input} input, ${output} output; ${s} s`,
  },
  moduleRevise: {
    usage:
      'Usage: npm run module:revise -- --draft <draftId> --instruction "<change>" [--research]\n  --research: targeted web search (WebSearch, WebFetch only), merged into research.json, before the revision.',
    total: (calls, input, output) => `Draft total: ${calls} call(s), ${input} input tokens, ${output} output.`,
  },
  personasGenerate: {
    usage: "Usage: npm run personas:generate -- [--count 1000] [--seed 42] [--pack fr] [--reset]",
    badArgs: "--count must be an integer ≥ 1 and --seed an integer.",
    reset: (removed, version, seed) => `--reset: ${removed} persona(s) deleted (pack ${version}, seed ${seed}).`,
    alreadyDone: (existing, version, seed) => `Already done: ${existing} personas present for pack ${version} and seed ${seed}. Nothing to do.`,
    tooMany: (existing, version, seed, count) =>
      `The database already holds ${existing} personas for pack ${version} and seed ${seed} (more than --count ${count}). ` +
      "Run again with --reset to start from scratch.",
    done: (n, start, version, seed, ms, total) =>
      `${n} personas drawn and inserted${start ? ` (on top of the ${start} existing ones)` : ""} — ` +
      `pack ${version}, seed ${seed}, ${ms} ms. Total for this draw: ${total}.`,
    next: "Next steps: npm run personas:validate, then npm run personas:narrate -- --limit N",
    failed: (msg) => `Failed: ${msg}`,
  },
  personasMigrateModules: {
    usage: "Usage: npm run personas:migrate-modules -- [--pack fr-tech-founders] [--dry-run]",
    noModules: (version) => `Pack ${version} enables no module: nothing to migrate.`,
    result: (version, total, migrated, dryRun, already, mismatches) =>
      `${version}: ${total} personas; ${migrated} ${dryRun ? "to migrate" : "migrated"}, ${already} already in module format, ${mismatches} mismatch(es).`,
  },
  personasNarrate: {
    usage:
      "Usage: npm run personas:narrate -- [--pack fr] [--limit N] [--batch-size 10] [--backend claude-cli]\n" +
      "       npm run personas:narrate -- --regenerate --before 2026-10-13T08:00:00Z [--limit N]\n" +
      "  --regenerate: also rewrites narratives dated before --before (narrative_at, ISO 8601 UTC).\n" +
      "  The old narrative stays in place until the new one is validated; running again with the same --before resumes.",
    backendRefused: (b) => `Backend refused: ${b} (claude-cli or ollama).`,
    regenerateNeedsBefore: "--regenerate requires --before <ISO date> (e.g. 2026-10-13T08:00:00Z) to stay resumable.",
    allDone: "All personas already have a narrative.",
    start: (n, batchSize, backend, model, concurrency) => `${n} narrative(s) to write, batches of ${batchSize}, backend ${backend} (${model}), concurrency ${concurrency}.`,
    summary: (written, total, s, batches, failedBatches, rejected) =>
      `\n${written}/${total} narratives written in ${s} s, ${batches} call(s)` +
      (failedBatches ? `, ${failedBatches} failed call(s)` : "") +
      (rejected ? `, ${rejected} narrative(s) requested again` : "") +
      ".",
    tokens: (input, cacheRead, output, costUsd) =>
      `Tokens: ${input} input (${cacheRead} of them read from cache), ${output} output` +
      (costUsd ? `; indicative cost $${costUsd.toFixed(3)} (covered by the subscription)` : "") +
      ".",
    average: (s, tokens) => `Average: ${s} s and ${tokens} output tokens per narrative (concurrency included).`,
    wholeBase: (n) => `\nWhole database (${n} narratives): `,
    aborted: (reason) => `\nStopped on usage limit: ${reason}`,
    stillMissing: (n) => `\n${n} persona(s) without a narrative after one retry (will be retried on the next run):`,
    missingLine: (id, issues) => `- ${id}: ${issues.join("; ") || "failed"}`,
    more: (n) => `… and ${n} more.`,
  },
  personasShow: {
    usage:
      "Usage: npm run personas:show -- --sample 5 [--all] [--salt N] [--pack fr-tech-founders]   (by default, only personas with a narrative)\n" +
      "       npm run personas:show -- --id fr-2026.1-s42-0001 [--id …]",
    notFound: (id) => `Persona not found: ${id}`,
    emptyBase: "Empty database.",
    noNarrative: "No persona with a narrative (add --all, or run personas:narrate).",
    sample: (salt) => `(sample --salt ${salt})`,
  },
  personasValidate: {
    usage:
      "Usage: npm run personas:validate -- [--pack fr] [--seed 42]\n" +
      "       npm run personas:validate -- --pack fr-2026.2 --modules numerique,entrepreneuriat --virtual 20000 [--seed 42]\n" +
      "  --virtual N: validates N virtual personas drawn on the fly (v2 base + modules), without the database.",
    none: (version) => `No persona for pack ${version}. Run npm run personas:generate first.`,
    header: (version, modules, n, virtual) => `# Margin validation — pack ${version}${modules ? ` + ${modules}` : ""}, ${n}${virtual ? " virtual" : ""} personas`,
    report: {
      kind: { drawn: "drawn", modelled: "modelled", info: "info" },
      columns: { observed: "sample", expected: "target", deviation: "gap" },
      dimensionSummary: (maxDev, chi2, df, p, verdict) => `→ max gap ${maxDev} pt; chi² ${chi2} (df ${df}, p = ${p}); ${verdict}`,
      indicative: "indicative",
      ok: "OK",
      fail: "FAIL",
      overallTitle: "\n## Overall indicator",
      maxAbsDev: (dev, title) => `Max absolute gap: ${dev} pt (${title})`,
      minPValue: (p, title) => `Smallest chi² p-value (drawn dimensions): ${p} (${title})`,
      thresholds: (minP, tolerance, n, maxModelled) => `Thresholds: drawn dimensions p ≥ ${minP} and gap ≤ ${tolerance} pt (n=${n}); modelled dimensions gap ≤ ${maxModelled} pt`,
      resultFail: (titles) => `RESULT: FAIL (${titles})`,
      resultOk: "RESULT: OK",
      plausibilityTitle: "\n## Plausibility",
    },
  },
  populationDraw: {
    usage:
      "Usage: npm run population:draw -- --target target.yaml [--n 300] [--seed 42] [--persist]\n" +
      "       npm run population:draw -- --project <id | project file> [--group target|control] [--n 300] [--drafts]\n" +
      "  --drafts: allows module drafts (modules/_drafts), read-only, to preview a target.\n" +
      'Target (YAML/JSON): { socle: fr, modules: [numerique, entrepreneuriat], eligibility: "age >= 25 and …", quotas: {…} }',
    noGroup: (group, src) => `No “${group}” block in project ${src}.`,
    draftsNoPersist: "--drafts is for previews only: no --persist with unvalidated modules.",
    draftsAllowed: (list) => `Drafts allowed (read-only): ${list || "none"}`,
    nRequired: "Sample size required: --n or `n` in the target.",
    socle: (version, modules) => `Base ${version}; modules: ${modules || "none"}`,
    retained: (n, draws, ms) => `${n} personas kept out of ${draws} virtual draws (${ms} ms)`,
    rate: (rate, lo, hi, eligible) => `Eligibility rate: ${rate} [95% CI ${lo}; ${hi}] (${eligible} eligible)`,
    quota: (s) => `⚠ quota: ${s}`,
    age: (d) => `Age: ${d}`,
    sexRegion: (sex, region) => `Sex: ${sex}; region: ${region}`,
    pcsActivity: (pcs, activity) => `PCS: ${pcs}; activity: ${activity}`,
    segment: (label, d) => `${label}: ${d}`,
    cache: (inserted, updated, reused) => `Cache: ${inserted} added, ${updated} completed, ${reused} already present.`,
  },
  projectCreate: {
    usage: "Usage: npm run project:create -- --file examples/meal-planner.json [--update]",
    saved: (updated, id) => `Project ${updated ? "saved" : "created"}: ${id}`,
    tiers: (list) => `  Gabor-Granger tiers: ${list}`,
  },
  projectList: {
    none: "No project. Create one: npm run project:create -- --file <file>",
    row: (id, name, price, created) => `${id}  ${name}  ${price}  (created ${created})`,
  },
  projectNeutralizePitch: {
    usage: "Usage: npm run project:neutralize-pitch -- --project <id|file.json|yaml> [--out proposal.json]",
    header: (id, toneBefore, toneAfter, lexBefore, lexAfter) => `Project ${id} — tone ${toneBefore} → ${toneAfter}/100 (lexical score ${lexBefore} → ${lexAfter})`,
    unchanged: "Pitch already factual: no change proposed.",
    passages: (n) => `\nPassages found (${n}):`,
    passage: (category, text, replacement, reason) => `  [${category}] “${text}” → ${replacement ? `“${replacement}”` : "(removed)"}\n      ${reason}`,
    originalNeutral: (original, neutral) => `\nOriginal:\n  ${original}\n\nProposed neutral version:\n  ${neutral}`,
    facts: (ok, repaired, numbersMissing, numbersAdded, namesMissing, factsMissing) =>
      `\nFacts preserved: ${ok ? "OK" : "GAPS"}${repaired ? " (after one repair)" : ""}` +
      (ok ? "" : ` — missing numbers ${numbersMissing}, added ${numbersAdded}, missing names ${namesMissing}, missing facts ${factsMissing}`),
    missingInfo: (lines) => `Information missing from the original (for the founder to add, not invented):\n${lines}`,
    proposal: (out) => `\nProposal (not applied): ${out}`,
  },
  projectSuggestProtocol: {
    usage: "Usage: npm run project:suggest-protocol -- --project <id|file.json|yaml> [--out proposal.json]",
    header: (id, name) => `Project ${id} — ${name}`,
    evidence: (n, studies) => `Objections from ${n} responses (${studies}).`,
    noEvidence: "No existing study: proposal based on the pitch alone.",
    productType: (type) => `\nProduct type: ${type}`,
    behaviors: "Behaviours:",
    objections: "Objections:",
    relevance: "Relevance:",
    rationale: (r) => `\nRationale: ${r}`,
    fixes: (list) => `Automatic fixes: ${list.join("; ")}`,
    proposal: (out, yaml) => `\nProposal (not applied): ${out}\nBlock to copy into the project file: ${yaml}`,
    tokens: (input, output) => `Tokens: ${input} input, ${output} output.`,
  },
  studyCompare: {
    usage: "Usage: npm run study:compare -- --studies st-ref,st-v1,st-v2 [--group target] [--normalize monthly-eur] [--json] [--out file.json]",
    unknownNormalize: (v) => `Unknown normalisation: ${v} (monthly-eur)`,
  },
  studyCreate: {
    usage:
      "Usage: npm run study:create -- --project <id> --n 200 [--seed 7] [--backend claude-cli|ollama] [--model <m>]\n" +
      "         [--quotas '{\"ageBand\":{\"18-29\":0.25,\"30-44\":0.25,\"45-59\":0.25,\"60-79\":0.25}}']\n" +
      "       npm run study:create -- --project <id> --population fr-tech-founders-2026.1 --n 200 \\\n" +
      "         --control-population fr-2026.1 --control-n 50 [--control-quotas '<json>'] --seed 7\n" +
      "       npm run study:create -- --project <id> --same-sample-as <study> [--same-sample-group target] [--n 10] --backend ollama\n" +
      "       npm run study:create -- --project examples/project.json [--n 50] [--control-n 20] [--seed 42] [--no-narrate]\n" +
      "         (file or id of a project that declares `target` / `control`: conditional targeting, personas drawn on demand,\n" +
      "          missing narratives written via claude-cli unless --no-narrate)\n" +
      "Multi-role project (`roles` block): one group per role, each with its target; sizes per role: --role-n coach=20,member=40\n" +
      "Protocol: --protocol 4 (default: v3 plus module lines in a delimited block; neutral pitch required, --force to override), --protocol 3 or --protocol 2 (frozen protocols of existing studies).\n" +
      "Quota dimensions: ageBand, sex, pcs (1-6, none), livingStandard (Q1-Q5), techAdoption, townSize, activityStatus, region.\n" +
      "Engine: --profile <name> (else PERSONAS_PROFILE, the active profile, then claude-cli); --backend claude-cli|ollama keeps its historical meaning.\n" +
      "The cost estimate is shown before creation; model without a known price: --accept-unknown-cost.",
    unknownProtocol: (p) => `Unknown protocol: ${p} (--protocol 2, 3 or 4).`,
    backendRefused: (b) => `Backend refused: ${b} (claude-cli or ollama; never the paid API).`,
    loaded: (id, file) => `Project ${id} loaded from ${file}.`,
    nRequired: "Sample size required (--n), or a project with a `target` block.",
    sizesRequired: "Sample sizes required: --n for the target, --control-n for the control group.",
    created: (id, name) => `Study created: ${id} — ${name}`,
    population: (group, n, packVersion, quotas) => `  ${group}: ${n} personas from ${packVersion}${quotas ? " (quotas)" : ""}`,
    protocol: (protocol, version) => `  Protocol ${protocol} v${version}`,
    sample: (size, seed, backend, model, from) => `  ${size} personas, seed ${seed}, ${backend} / ${model}` + (from ? `, sample reused from ${from}` : ""),
    shortfalls: (list) => `  ⚠ Quotas not met:\n  - ${list.join("\n  - ")}`,
    narrateBackendRefused: (b) => `Narrative backend refused: ${b}`,
    unknownCost: (model) => `Unknown cost for model ${model} (not in pricing/models.json): confirm with --accept-unknown-cost, or add its price to the file.`,
    unknownCostAccepted: "Unknown cost accepted for this study: the cap will count each call at the price of the provider's most expensive model (pricing/models.json).",
    engine: (profile, provider, model) => `  Engine: profile ${profile} (${provider} / ${model})`,
    narratives: (r) =>
      narrativesHead(r) +
      (r.missing.length ? `; ${r.missing.length} missing, run again to resume` : "") +
      (r.aborted ? `; stopped on usage limit: ${r.aborted}` : "") +
      ".",
    launch: (id) => `Run: npm run study:run -- --study ${id}`,
  },
  studyDrivers: {
    usage: "Usage: npm run study:drivers -- --study <id> [--top 10] [--json] [--out file.json]",
    header: (id, name, group, n) => `Engagement drivers — study ${id} (${name})${group ? `, group “${group}”` : ""}, n = ${n}`,
  },
  studyList: {
    none: "No study.",
    sampleOf: (id) => `  (sample from ${id})`,
  },
  studyRecode: {
    usage: "Usage: npm run study:recode -- --study <id> --taxonomy <proposal.json|yaml> [--key name] [--group target] [--batch-size 40]",
    header: (id, key, n) => `Study ${id} — taxonomy “${key}” (${n} categories)`,
    run: (objections, responses, calls, input, output) =>
      `${objections} objection(s) from ${responses} response(s) to reclassify; ${calls} call(s), ${input} input tokens, ${output} output.`,
    usageLimit: (s) => `⏸ Usage limit: ${s}\nResume later with the same command.`,
    noneRecoded: "No recoded response.",
    title: (group, n) => `\nReclassified objections${group ? ` (group “${group}”)` : ""}, n = ${n} (share of respondents citing the category)`,
    example: (ex) => `      “${ex}”`,
    oldCategories: (list) => `\nPrevious categories: ${list}`,
    whence: "Where the new categories come from (number of objections):",
  },
  studyRecommend: {
    usage:
      "Usage: npm run study:recommend -- --study <id> [--force]\n" +
      "       npm run study:recommend -- --study <id> --create <recId> --confirm   (creates the variant and the study, without running it)",
    needConfirm: "Add --confirm: the project variant and the study will be created (the study is not run).",
    projectCreated: (id, file) => `Project created: ${id}${file ? ` (${file})` : ""}`,
    studyCreated: (id) => `Study created, not run: ${id}\nRun: npm run study:run -- --study ${id}`,
    findings: "Findings",
    recommendations: "\nRecommendations",
    caveats: "\nCaveats",
    evidence: (metric, value, source) => `      · ${metric}: ${value}  [${source}]`,
    recommendation: (i, kind, title, confidence, id) => `  ${i}. [${kind}] ${title} (confidence ${confidence}) — id ${id}`,
    nextStudy: (sample, n, control, calls, minutes, eligibility) =>
      `     → Next study (${sample}, n = ${n}${control ? ` + ${control} controls` : ""}, ≈ ${calls} calls, ≈ ${minutes} min${eligibility !== null ? `, eligibility ${eligibility}%` : ""})`,
    nextStudyDetail: (hypothesis, success, patch) => `       Hypothesis: ${hypothesis}\n       Success if: ${success}\n       Patch: ${patch}`,
    create: (studyId, recId) => `       Create: npm run study:recommend -- --study ${studyId} --create ${recId} --confirm`,
    verification: (valid, checked, repaired, dropped, droppedNext) =>
      `\nVerification: ${valid}/${checked} valid pieces of evidence${repaired ? " after one repair" : ""}; ${dropped} removed; ${droppedNext} next stud${droppedNext === 1 ? "y" : "ies"} discarded.`,
    dropped: (where, source, value, reason) => `  - removed: ${where} [${source}] “${value}”: ${reason}`,
    droppedNext: (recommendation, reason) => `  - discarded: ${recommendation}: ${reason}`,
  },
  studyRun: {
    usage: "Usage: npm run study:run -- --study <id> [--concurrency N]",
    usageMore: "  [--profile <name>] [--no-narrate] [--accept-unknown-cost]; engine: the profile recorded in the study (--profile for another profile of the same provider).",
    profile: (name) => `Profile ${name}`,
    budget: (s) => `\n⏸ Spending cap reached: ${s}`,
    unknownCostBlocked: (s) => `\n⏸ ${s}`,
    budgetResume: (id) => `Responses already obtained are saved. Raise the cap (npm run engine:profile -- limit <profile> --per-study-usd <n>), then resume:\n  npm run study:run -- --study ${id}`,
    narrativesBudget: (reason, id) => `Spending cap reached during narratives: ${reason}\nRaise the cap, then resume: npm run study:run -- --study ${id}`,
    estimate: (lines) => lines.map((l) => `  ${l}`).join("\n"),
    backendRefused: (b) => `Backend refused: ${b}`,
    unavailable: (backend, detail, hint) => `${backend} unavailable: ${detail}${hint ? `\n→ ${hint}` : ""}`,
    header: (id, name) => `Study ${id} — ${name}`,
    engine: (backend, model, concurrency) => `${backend} / ${model}, concurrency ${concurrency}`,
    narratives: (r) => narrativesHead(r) + (r.missing.length ? `; ${r.missing.length} without a narrative (profile card only)` : "") + ".",
    narrativesAborted: (reason, id) => `Usage limit reached while writing narratives: ${reason}\nRun again later: npm run study:run -- --study ${id}`,
    written: (written, s, already, total) => `\n${written} response(s) written in ${s} s (${already} already done, ${total} in total).`,
    tokens: (input, cacheRead, output, perResponse, costUsd) =>
      `Tokens: ${input} input (${cacheRead} of them from cache), ${output} output; ` +
      `${perResponse} s per response (concurrency included)` +
      (costUsd ? `; indicative cost $${costUsd.toFixed(3)} (covered by the subscription)` : "") +
      ".",
    quota: (s) => `\n⏸ Quota reached: ${s}`,
    quotaResume: (id) => `Responses obtained so far are saved. Resume after the quota resets:\n  npm run study:run -- --study ${id}`,
    aborted: (reason, id) => `\n✖ Study stopped: ${reason}\nFix the cause, then run again: npm run study:run -- --study ${id}`,
    failed: (n, id) => `\n${n} failure(s); run again to retry them: npm run study:run -- --study ${id}`,
    complete: (id) => `\nStudy complete. Summary: npm run study:summary -- --study ${id}`,
  },
  studyEstimate: {
    usage:
      "Usage: npm run study:estimate -- --project <id | file> [--n 200] [same population options as study:create] [--profile <name>] [--json]\n" +
      "       npm run study:estimate -- --study <id> [--profile <name>] [--json]   (remainder of an existing study)\n" +
      "Estimate before launch: calls, tokens, cost (±30 % range) and duration; no write, no model call.",
  },
  studySummary: {
    usage: "Usage: npm run study:summary -- --study <id> [--json] [--out file.json]",
    noResponses: (id) => `No responses for study ${id}: run study:run.`,
  },
  targetPreview: {
    usage:
      "Usage: npm run target:preview -- --project <id | file> [--group target|control] [--n 200] [--sample 10] [--seed 42]\n" +
      "                                [--triage] [--threshold 0.5] [--alert 0.1] [--drafts] [--json]\n" +
      "  --triage: relevance pre-screen by the local Qwen (2 calls per persona, concurrency 2, cached).\n" +
      "  --drafts: allows module drafts (read-only).",
    header: (group, name) => `\n# Preview of target “${group}” of project ${name}`,
    socle: (socle, modules, seed) => `Base ${socle}; modules: ${modules || "none"}; seed ${seed}`,
    draws: (n, draws) => `${n} personas out of ${draws} virtual draws`,
    rate: (rate, lo, hi) => `Eligibility rate: ${rate} [95% CI ${lo}; ${hi}]`,
    quota: (s) => `quota: ${s}`,
    distributions: "\n## Sample distributions",
    distribution: (label, inFilter, multi, values, more) => `- ${label}${inFilter ? " [filter]" : ""}${multi ? " (multiple allowed)" : ""}: ${values}${more ? ", …" : ""}`,
    cards: (n) => `\n## ${n} profile cards, as the protocol will see them`,
    triage: (model) => `\n## Relevance pre-screen (${model})`,
    alert: "⚠ ALERT: ",
    argmax: (concerned, marginal, notConcerned, flagged, threshold) =>
      `Most likely label: concerned ${concerned}, marginal ${marginal}, not concerned ${notConcerned}; ` +
      `${flagged} personas with P(not concerned) ≥ ${threshold} (to review)`,
    profiles: "Typical profiles of the “not concerned”:",
    criterion: (label, value) => `${label} = ${value}`,
    criteriaJoin: " and ",
    profile: (criteria, n, rate, lift, inReview, examples) =>
      `- ${criteria}: ${n} personas, ≈ ${rate} not concerned (× ${lift}), ${inReview} among the cards to review; e.g. ${examples}`,
    review: (n) => `Cards to review (${n}, the most likely not concerned):`,
    reviewLine: (id, p, lines) => `- ${id} (P = ${p}): ${lines.join("; ")}`,
    calls: (calls, cached, s, failed) => `Qwen calls: ${calls} (+ ${cached} cached), ${s} s${failed ? `; ${failed} personas failed` : ""}`,
    duration: (s) => `\nTotal time: ${s} s`,
  },
  hub: {
    searchUsage:
      "Usage: personas hub search <text> [--socle fr] [--limit 20] [--remote] [--json]\n" +
      "  Local search (BM25) in the library and the cached Hub catalogue; nothing is sent to the Hub.\n" +
      "  --remote: search on the Hub (the typed text is sent, never a project).",
    pullUsage: "Usage: personas hub pull <namespace/module>[@version] [--pack]\n  Downloads into the local cache (sha256 checked); without a version: the latest in the catalogue.",
    syncUsage: "Usage: personas hub sync [--json]\n  Refreshes the cached Hub catalogue (ETag). Offline: keeps the last catalogue.",
    publishUsage:
      "Usage: personas hub publish <module.yaml | pack folder> --namespace personas [--slug <country>] [--dry-run]\n" +
      "  Admin: HUB_ADMIN_TOKEN token (environment) or keychain (hub-admin account), never printed.",
    lockUsage:
      "Usage: personas hub lock <project: id | file> [--check]\n" +
      "  Pins the base and modules (exact versions, sha256) in projects.extra.lock and <project>.personas.lock.\n" +
      "  --check: compare without writing anything.",
    hubUrl: (url: string) => `Hub: ${url}`,
    catalogNetwork: (modules: number, packs: number, at: string) => `Catalogue downloaded: ${modules} module(s), ${packs} pack(s) (${at}).`,
    catalogNotModified: (at: string) => `Catalogue up to date (ETag unchanged, ${at}).`,
    catalogCache: (at: string) => `Offline: last cached catalogue (${at}).`,
    catalogNone: "No catalogue: Hub unreachable and nothing cached.",
    offline: (msg: string) => `⚠ ${cliMessageEn(msg)}`,
    noResults: (q: string) => `No module for “${q}”.`,
    result: (ref: string, version: string, source: string, label: string, quality: string, socles: string) => `- ${ref}@${version} [${source}] ${label}\n  ${quality}; bases: ${socles}`,
    sources: { local: "local", cache: "cache", hub: "Hub (to download)" } as Record<string, string>,
    pulled: (kind: string, ref: string, version: string, sha: string) => `Downloaded: ${kind} ${ref}@${version} (sha256 ${sha.slice(0, 12)}…)`,
    alreadyCached: (kind: string, ref: string, version: string) => `Already cached: ${kind} ${ref}@${version} (checked)`,
    bundled: (kind: string, ref: string, version: string) => `Shipped with Personas: ${kind} ${ref}@${version} (packs/ in the package, takes precedence); nothing to download or cache.`,
    kinds: { module: "module", pack: "pack" } as Record<string, string>,
    warning: (w: string) => `⚠ ${cliMessageEn(w)}`,
    cacheDir: (dir: string) => `Cache: ${dir}`,
    noToken: "No admin token: set HUB_ADMIN_TOKEN or store it in the keychain (hub-admin account).",
    tokenSource: (source: string) => `Admin token: ${source} (not printed).`,
    tokenSources: { env: "HUB_ADMIN_TOKEN variable", keychain: "keychain" } as Record<string, string>,
    dryRun: (kind: string, ref: string, version: string, sha: string) => `Check only (--dry-run): ${kind} ${ref}@${version}, sha256 ${sha.slice(0, 12)}…, nothing is sent.`,
    published: (ref: string, version: string, sha: string, quality: string) => `Published: ${ref}@${version} (sha256 ${sha.slice(0, 12)}…); ${quality}`,
    lockWritten: (where: string) => `Lock written: ${where}`,
    lockStored: (id: string) => `Lock stored in project ${id} (projects.extra.lock).`,
    lockUnchanged: "Lock unchanged.",
    lockChanges: "Changes:",
    lockEntry: (ref: string, version: string, sha: string, source: string) => `  ${ref}@${version}  sha256 ${sha.slice(0, 12)}…  (${source})`,
    lockSocle: (socle: string, ref: string, version: string, sha: string) => `  base ${socle}: ${ref}@${version}  sha256 ${sha.slice(0, 12)}…`,
    lockCheckDiff: "The stored lock differs from the current resolution (nothing written):",
    lockNoProject: (p: string) => `Project not found: ${p} (neither a file nor an id in the database).`,
    // Phase 3: account, user publication, fork, stars, reviews, reports, telemetry
    loginUsage: "Usage: personas hub login\n  Device-flow sign-in: a code is shown, you confirm it in the browser; the personal token is stored in the keychain (hub-token account), never printed.",
    logoutUsage: "Usage: personas hub logout\n  Removes the personal token from the keychain.",
    whoamiUsage: "Usage: personas hub whoami [--json]\n  Signed-in account (GET /v1/me).",
    loginOpen: (uri: string) => `Open ${uri} in your browser and sign in to the Hub,`,
    loginCode: (code: string) => `then enter the code: ${code}`,
    loginDirect: (uri: string) => `(direct link: ${uri})`,
    loginWaiting: (min: number) => `Waiting for confirmation (the code expires in ${min} min; Ctrl+C to cancel)…`,
    loginDone: (ns: string, name: string, store: string, expires: string) => `Signed in: ${name} (namespace ${ns}). Token stored in the ${store} (not printed), valid until ${expires}.`,
    loginStores: { keychain: "system keychain", memory: "in-memory store (test)" } as Record<string, string>,
    loginFailed: (msg: string) => `Sign-in failed: ${msg}`,
    logoutDone: "Signed out: token removed from the keychain.",
    logoutNone: "No token in the keychain (nothing to remove).",
    logoutEnv: "PERSONAS_HUB_TOKEN is set in the environment: remove it too.",
    notLoggedIn: "Not signed in to the Hub: run personas hub login (or set PERSONAS_HUB_TOKEN).",
    tokenRejected: "Token rejected by the Hub (expired or revoked): run personas hub login again.",
    whoami: (name: string, ns: string, role: string, scopes: string, via: string) => `${name} — namespace ${ns}, role ${role}\n  scopes: ${scopes}; token: ${via} (not printed)`,
    whoamiOffline: (msg: string, ns: string) => `⚠ ${cliMessageEn(msg)}\n  Last known account: namespace ${ns}.`,
    personalTokenSources: { env: "PERSONAS_HUB_TOKEN variable", keychain: "keychain" } as Record<string, string>,
    userPublishUsage:
      "Usage: personas hub publish <module: id | module.yaml> [--namespace <ns>] [--dry-run]\n" +
      "       personas hub publish <pack folder> [--slug <country>] [--dry-run]\n" +
      "  Publishes into the signed-in account's namespace (personas hub login); only the module YAML is sent.\n" +
      "  Local security lint before sending: an error blocks.\n" +
      "  Admin (official modules, personas namespace): --admin, HUB_ADMIN_TOKEN token or keychain (hub-admin account).",
    lintErrors: (n: number) => `Security lint: ${n} error(s), nothing is sent:`,
    lintWarnings: (n: number) => `Security lint: ${n} warning(s):`,
    lintOk: "Security lint: no alert.",
    validationErrors: (n: number) => `Validation: ${n} error(s), nothing is sent:`,
    issue: (path: string, msg: string) => `  - ${path ? `${path}: ` : ""}${msg}`,
    sensitiveDeclared: (keys: string) => `Declared sensitive attributes ("sensitive" badge): ${keys}`,
    publishedAs: (ref: string, version: string, sha: string, status: string) => `Published: ${ref}@${version} (sha256 ${sha.slice(0, 12)}…), status ${status}.`,
    publishedSigned: (kid: string) => `Version signed by the Hub (key ${kid}).`,
    forkUsage: "Usage: personas hub fork <namespace/module>[@version] [--as <id>]\n  Forks into the account's namespace (lineage recorded), downloads it into the cache, then writes an editable copy to modules/<id>.",
    forked: (ref: string, version: string, from: string) => `Fork created on the Hub: ${ref}@${version} (from ${from}).`,
    forkLocal: (file: string, id: string) => `Editable copy: ${file}\n  Edit it (version, labels…), then personas hub publish ${id}.`,
    starUsage: "Usage: personas hub star <namespace/module>\n       personas hub unstar <namespace/module>",
    starred: (ref: string, n: number) => `★ ${ref}: star added (${n} in total).`,
    unstarred: (ref: string, n: number) => `${ref}: star removed (${n} in total).`,
    reviewUsage: "Usage: personas hub review <namespace/module@version> --rating 1-5 [--text \"review\"]\n  Public review of a version (1000 characters at most).",
    reviewed: (ref: string, version: string, rating: number) => `Review saved: ${ref}@${version}, ${rating}/5.`,
    reportUsage:
      "Usage: personas hub report <namespace/module>[@version] --reason <malicious|injection|sensitive|rights|other> [--text \"details\"]\n" +
      "  Reports a version to the Hub moderation (no version: the latest in the catalogue).",
    reported: (ref: string, version: string, n: number, status: string) => `Report saved: ${ref}@${version} (${n} report(s), status ${status}).`,
    badRating: (v: string) => `Invalid rating: ${v} (integer from 1 to 5).`,
    badReason: (v: string) => `Invalid reason: ${v} (malicious, injection, sensitive, rights or other).`,
    needVersion: (ref: string) => `Version required: ${ref}@<version>.`,
    telemetryUsage:
      "Usage: personas hub telemetry on|off|status [--json]\n" +
      "  Opt-in telemetry, off by default: when a study ends, only aggregates are sent (Hub modules@version, base,\n" +
      "  number of personas, protocol, engine version, model family), with an installation id renewed every month.\n" +
      "  Never a project, pitch, target, answer or study id.",
    telemetryOn: "Telemetry on. Example of what is sent when a study ends:",
    telemetryOff: "Telemetry off (queue emptied): nothing is sent.",
    telemetryStatus: (on: boolean, pending: number) => `Telemetry: ${on ? "on" : "off"}${on && pending ? ` (${pending} aggregate(s) waiting to be sent)` : ""}.`,
  },
  targetSuggest: {
    usage:
      "Usage: npm run target:suggest -- --project <id | file> [--triage] [--no-preview] [--n 200] [--seed 42] [--out file.yaml] [--json]\n" +
      "  Writes the proposal to <project>.target-suggestion.yaml (or data/suggestions/<id>.target-suggestion.yaml).",
    header: (name, model) => `\n# Target proposal for ${name} (${model})`,
    usageConditions: "\nUsage conditions:",
    condition: (condition, attribute, why) => `- ${condition} → ${attribute || "(no attribute)"}: ${why}`,
    variants: "\nVariants:",
    modulesFilter: (modules, filter) => `Modules: ${modules || "none"}\nFilter: ${filter}`,
    quotas: (json) => `Quotas: ${json}`,
    justification: (criterion, why) => `  · ${criterion}: ${why}`,
    errors: (list) => `⚠ ${list.join("; ")}`,
    eligibility: (rate, lo, hi, draws) => `Eligibility: ${rate} [95% CI ${lo}; ${hi}] (${draws} draws)`,
    triage: (message) => `Pre-screen: ${message}`,
    missingModules: "\nMissing modules:",
    missingModule: (id, description, attributes, why) => `- ${id}: ${description}\n  attributes: ${attributes.join("; ")}\n  why: ${why}`,
    note: (n) => `Note: ${n}`,
    claude: (calls, repairs, s) => `\nClaude: ${calls} call(s), ${repairs} repair(s); duration ${s} s`,
    written: (path) => `Proposal written to ${path} (nothing is applied to the project).`,
  },
  personasCli: {
    intro: "Personas — synthetic personas simulator: a filter for bad ideas, not an oracle.",
    usage: "Usage: personas <command> [options]\n  personas <command> --help: options of a command.",
    dashboard: "Dashboard",
    commands: "Commands",
    uiDescription: "opens the dashboard in your browser (free port on 127.0.0.1, Ctrl+C to stop)",
    uiUsage: "Usage: personas ui [--port N] [--no-open]\n  --port N   port to listen on 127.0.0.1 (default: a free port)\n  --no-open  do not open the browser",
    paths: (dataDir, config) => `Data: ${dataDir}\nEngine profiles: ${config}`,
    unknown: (cmd) => `Unknown command: ${cmd}. See personas --help.`,
    unknownOption: (option, cmd) => `Unknown option: ${option}. Command options: ${cmd} --help.`,
    badArguments: (detail, cmd) => `Invalid arguments (${detail}). Command options: ${cmd} --help.`,
    group: (group) => `"${group}" commands:`,
    uiReady: (url) => `Personas — dashboard: ${url}  (Ctrl+C to stop)`,
    uiData: (dataDir) => `Data: ${dataDir}`,
    uiStopped: "Dashboard stopped.",
    uiBadPort: (v) => `Invalid port: ${v} (integer from 0 to 65535; 0 = free port).`,
    descriptions: {
      "calibration:fit": "fits the low-tier \"yes\" → paying share conversion on products with a known outcome",
      "db:migrate": "creates or updates the SQLite database",
      "engine:check": "checks the engines (one small JSON request)",
      "engine:key": "stores, tests or removes a profile's key in the keychain",
      "engine:profile": "lists, adds, activates or removes an engine profile",
      mcp: "local MCP server (stdio)",
      "module:accept": "accepts a module draft",
      "module:preview": "previews a module on a draw",
      "module:propose": "proposes a module with the assistant",
      "module:revise": "revises a module draft",
      "personas:generate": "draws personas (no LLM call)",
      "personas:migrate-modules": "updates the modules of stored personas",
      "personas:narrate": "writes the personas' narratives",
      "personas:show": "shows a persona",
      "personas:validate": "checks the margins of a draw",
      "population:draw": "draws a project's target (no LLM call)",
      "project:create": "creates or updates a project from a YAML or JSON file",
      "project:list": "lists projects",
      "project:neutralize-pitch": "proposes a factual version of the pitch",
      "project:suggest-protocol": "proposes a protocol suited to the project",
      "study:compare": "compares studies",
      "study:create": "creates a study",
      "study:drivers": "drivers that explain the answers",
      "study:list": "lists studies",
      "study:recode": "recodes objections into another taxonomy",
      "study:recommend": "recommends the next study",
      "study:run": "runs a study",
      "study:estimate": "estimates the cost of a study before launch (calls, tokens, cost, duration)",
      "pricing:reference": "measures the reference token table (no study identifier)",
      "study:summary": "summary of a study",
      "target:preview": "previews a project's target",
      "target:suggest": "suggests a target for a project",
      "hub:fork": "forks a Hub module into your namespace and writes an editable copy to modules/",
      "hub:login": "signs in to the Hub (device flow); personal token stored in the keychain",
      "hub:logout": "removes the personal Hub token from the keychain",
      "hub:report": "reports a module version to the Hub moderation",
      "hub:review": "posts a review (rating 1 to 5) of a module version",
      "hub:star": "stars a Hub module",
      "hub:telemetry": "turns opt-in telemetry on or off, or shows it (off by default)",
      "hosted:reactivate": "reactivates a deleted email address on the hosted service (administration)",
      "hosted:start": "starts the hosted web service (Supabase accounts, each user's own AI key, one database per account)",
      "hub:unstar": "removes your star from a Hub module",
      "hub:whoami": "shows the signed-in Hub account",
      "hub:lock": "pins the exact versions (sha256) of a project's base and modules (personas.lock)",
      "hub:publish": "publishes a module (account namespace, security lint) or a pack to the Hub; --admin: official modules",
      "hub:pull": "downloads a module or a pack from the Hub into the local cache (sha256 checked)",
      "hub:search": "searches modules locally (library and Hub catalogue), --remote on the Hub",
      "hub:sync": "refreshes the cached Hub catalogue (ETag; offline: last catalogue)",
      "triage:validate": "evaluates the relevance pre-screen",
    },
  },
  hostedReactivate: {
    usage:
      "Usage: personas hosted reactivate <email | Supabase user id> [--data-root <dir>]\n" +
      "Removes a deleted account from the hosted service's refused-accounts list (<HOSTED_DATA_ROOT>/_system/deleted-accounts.json).\n" +
      "Accounts directory: --data-root, otherwise HOSTED_DATA_ROOT. The server rereads the list without a restart.",
    missing: "Email address (or Supabase user id) required.",
    noDataRoot: "Unknown accounts directory: --data-root or HOSTED_DATA_ROOT required.",
    done: (n) => `${n} entry(ies) removed: this address can sign in again (empty account).`,
    none: "No entry for this address: nothing to reactivate.",
  },
  triageValidate: {
    usage: "Usage: npm run triage:validate -- --studies a,b [--portrait] [--limit N] [--out file.json]",
    references: (n, studies, portrait) => `${n} reference responses (${studies}); profile card ${portrait ? "and portrait" : "only"}.`,
    calls: (calls, cached, s, failed) => `Calls: ${calls} (+ ${cached} cached), ${s} s; failures: ${failed}`,
    failure: (id, error) => `  failed ${id}: ${error}`,
    thresholds: "\nThreshold τ on P(not concerned) — overall:",
    thresholdsHeader: "τ     NC recall  precision  FP rate  ref share  est share",
    agreement: (exact, qwk, mean) => `\nExact agreement ${exact}, quadratic kappa ${qwk}; mean P(NC) ${mean}`,
    confusion: "Confusion (rows: Claude; columns: Qwen):",
    byGroup: "\nBy study and group: share of “not concerned” (Claude / mean of Qwen P(NC)), AUC, then at threshold 0.3:",
    group: (key, n, ref, est, auc, recall, falseNc, exact, qwk) =>
      `  ${key} n=${n}  ref ${ref}  est ${est}  ` + `AUC ${auc}  recall ${recall}  FP rate ${falseNc}  exact ${exact}  qwk ${qwk}`,
    detail: (out) => `\nDetail: ${out}`,
  },
};
