# Country packs

A **country pack** (a *socle*, or base population, in the code) describes the adult population of a country from public statistics: who lives there, with what income, household, housing, equipment, subscriptions and budget. Studies and modules draw their personas from it.

The rule that shapes the contract: **the generator is code, the tables are data, and every table has a source.**

- The **generator** (TypeScript, in `src/personas/`) is the chain of conditional draws that makes a coherent person (age and sex, then activity, then occupation, then income, then household…). It encodes how variables depend on each other in that country, and it is reviewed like code.
- The **tables** (JSON, in `packs/<version>/`) carry the numbers: distributions, rates, medians, prices. They are validated by a zod schema, cite their sources or are marked as documented assumptions, and are licensed CC BY 4.0 ([packs/LICENSE](../packs/LICENSE)).
- The LLM never writes an attribute. It only writes a short narrative from the drawn card.

Packs available today:

| Pack | Directory | Notes |
|---|---|---|
| `fr-2026.1` | `packs/fr` | France, v1 base (shared random stream) |
| `fr-2026.2` | `packs/fr-2026.2` (`extends: fr`) | Current France base: same tables, one random stream per module |
| `fr-tech-founders-2026.1` | `packs/fr-tech-founders` | Historical targeted pack (v1) |
| `sg-2026.1` | `packs/sg` | Singapore, all usual residents (citizens, PRs, pass holders, domestic workers, dependants, students) |
| `sg-2026.2` | `packs/sg-2026.2` (`extends: sg`) | Current Singapore base: names drawn by group × religion × sex × generation |

`packs/socles.json` maps a country key to its current pack: `{"fr": "fr-2026.2", "sg": "sg-2026.2"}`. A project's `target.socle: sg` resolves through it.

## 1. The contract

### 1.1 Manifest (`pack.json`)

Validated by `manifestSchema` in `src/personas/pack-common.ts`.

| Field | Role |
|---|---|
| `country`, `version`, `label`, `shortLabel`, `description` | identity; `version` is the pack's stable name (e.g. `sg-2026.2`) |
| `population`, `ageMin`, `ageMax`, `referenceYear` | who is covered. A base covers **all usual residents** in their real shares; visitors belong in a module. |
| `extends` | parent pack: a new version only carries the tables it changes |
| `rngStreams` | `"module"` for new packs: the base is drawn alone, then each module in its own stream |
| `modules`, `targeted` | historical v1 targeted packs only |
| **`generator`** | which generator draws the persona: `fr`, `sg`, or yours |
| **`locale`** | language of narratives, study prompts, answers and generated texts: `fr` or `en` |
| **`currency`** | currency of **all** the persona's amounts (income, budget, subscriptions): `EUR`, `SGD`… |

### 1.2 Common tables (same shape for every country)

Defined in `pack-common.ts`: `ageSex`, `regions`, `livingStandard` (annual deciles), `digital`, `subscriptions` (offers and monthly prices in the pack's currency), `psychographics` (diffusion-of-innovation category, latent technology affinity, price sensitivity, scepticism, narrative tones), `firstNames` (cohorts, with an optional `group` such as ethnicity or nationality and an optional `religions` list). They feed validation, segments (living-standard quintiles), the dashboard and the psychographic model, which is the same in every country.

### 1.3 Generator-specific tables

Declared by the generator's own schema:
- France (`packSchema`, `src/personas/pack.ts`): `townSize`, `urbanUnits`, `activity`, `pcs`, `earnings`, `taxBenefits`, `household`, `housing`, `costs`.
- Singapore (`sgPackSchema`, `src/personas/countries/sg/pack.ts`): `residency`, `ethnicity`, `religion`, `language`, `education`, `geography`, `activity`, `occupation`, `earnings`, `cpf`, `taxBenefits`, `household`, `housing`, `costs`.

### 1.4 Table format and provenance

Every table file has the same envelope (`table()` in `pack-common.ts`):

```json
{
  "id": "sg-age-sex",
  "title": "Adult population aged 18 to 79 by sex and age band",
  "assumption": false,
  "sources": [
    { "org": "DOS", "title": "General Household Survey 2025: …", "year": 2025, "url": "https://…", "detail": "optional" }
  ],
  "referenceYear": 2026,
  "notes": "optional",
  "data": { "…": "…" }
}
```

The loader enforces:
- a sourced table (`assumption: false`) must have at least one source **and** a `referenceYear`;
- an assumption (`assumption: true`) must have a `justification`, and may still list the sources it is derived from.

Sources are mandatory. A pull request that adds or changes a table without them will not be merged. Cite official statistics first (national statistics office, ministries, central bank, tax authority); use other sources only when nothing official exists, and say so in `detail` or `justification`. Build scripts that turn source files into tables (for example `packs/sg/build-tables.py`) belong next to the pack and must not read anything outside the repository or the cited public sources.

### 1.5 What a generator provides

The code switches on `pack.kind` (type `Pack = FrPack | SgPack`). A generator implements:

| Generic entry point | France | Singapore |
|---|---|---|
| base draw (`drawPersona`) | `sampler.ts` (`drawSocle`) | `countries/sg/sampler.ts` |
| budget recomputation after modules (`recomputeEconomics`) | `economics.ts` | `countries/sg/economics.ts` |
| narrative and study card (`describeForPrompt`, `formatPersona`) | `describe.ts` | `countries/sg/describe.ts` (English) |
| segment labels (`segmentLabel`) | `studies/segments.ts` | `sgSegmentLabel` |
| variables seen by modules (`socleVars`) and by the target filter (`eligibilityVars`) | `modules/apply.ts`, `population/target.ts` | `countries/sg/vars.ts` |
| variable catalogue for modules (`socleCatalog`) | `SOCLE_VARS`, `SOCLE_CODES` | `SOCLE_VARS_SG`, `SOCLE_CODES_SG` (`modules/registry.ts`) |
| margin validation (`computeMargins`) | `validate.ts` | `countries/sg/validate.ts` |
| narratives (instructions, prompt, checks) | `narrate.ts` (French) | `narrate.ts` (`locale: en`) |

Shared by all countries: identifiers (`<version>-s<seed>-<index>`, with a `-m<hash>` suffix for modules that touch the base), random streams (persona, then one stream per module), the database cache, modules, targeting, quotas, protocols, summary and comparison.

### 1.6 Persona conventions

The `personas` table columns keep their names; their meaning is the country's:
- `region`: region (France) or planning region (Singapore);
- `town_size`: urban-area size (France) or **planning area** (Singapore);
- `pcs`: French socio-professional category or SSOC major group (Singapore);
- `monthly_income_eur`, `monthly_discretionary_budget_eur`, `household_income_eur`, `subscriptions[].monthlyEur` and amounts in `extra`: **in the pack's currency**, despite the historical suffix;
- `extra` carries country-specific attributes (Singapore: `residency`, `pass`, `nationality`, `ethnicity`, `religion`, `homeLanguage`, `education`, `dwelling`, `cpfEmployeeEur`, `remittanceEur`, `nationalService`…), while common keys keep their meaning (`tenure`, `partner`, `childrenAges`, `livingStandardEur`, `narrativeTone`…).

### 1.7 Study audience

`studyAudience(study)` (`src/studies/locale.ts`) reads the manifest of the first population's pack: language, country, currency. The study engine picks the system prompt, card, constraints, discovery situation, repair, invented-fact checks, tone guard and pre-screen accordingly. An offer priced in another currency than the personas' gets an equivalence line in the personas' currency, and the minimum-basket check compares against the budget in that currency.

## 2. Adding a country

1. **Manifest and common tables.** Create `packs/<country>/pack.json` (`generator`, `locale`, `currency`, `rngStreams: "module"`, age bounds, `population`) and the common tables: `age-sex.json`, `regions.json`, `living-standard.json`, `digital.json`, `subscriptions.json`, `psychographics.json`, `first-names.json`. Each one sourced, or marked `assumption: true` with a justification.
2. **Generator.** Write it in `src/personas/countries/<country>/`, following `sg/`: `pack.ts` (zod schema of the specific tables), `sampler.ts` (draw chain), `economics.ts`, `describe.ts`, `vars.ts`, `validate.ts`, `codes.ts`. Wire the switch on `pack.kind` (`loadPack`, `drawCountrySocle`, recomputation, card, segments, `socleCatalog`). Draw with the persona's `Rng` only, never `Math.random`, and keep the order of draws stable: it is part of the pack's identity.
3. **Registration.** Add the country to `packs/socles.json` and to the geographic zone (`zoneOf` in `src/web/i18n.ts`). If the language is new, the study prompts, narrative instructions, fact checks, tone markers and dashboard dictionaries need a faithful translation: same rules, same schema, same checks (see [CONTRIBUTING.md](../CONTRIBUTING.md), anti-sycophancy).
4. **Validation.** `npm run personas:validate -- --pack <version> --virtual 2000` compares margins with the tables (age × sex, regions, activity, living standard and the country's own dimensions). Add dedicated tests (`test/personas/`) with a draw fingerprint, and run `npm run typecheck` and `npm test`. Check the narratives of a few personas for stereotypes before any study.
5. **Modules.** Modules declare `applies_to: [<country>]`; modules of another country are refused on yours. Document the `socle.*` variables and codes your generator exposes in the catalogue, so that the module assistant can use them.

## 3. Changing a published pack

A published pack is **immutable**: studies are pinned to it and personas in the database are never rewritten. Any change to the tables or the chain goes into a **new versioned directory**, `packs/<country>-<year>.<n>/` with `extends: <country>`, carrying only the changed tables and a changelog (as `fr-2026.2` and `sg-2026.2` do). Then point `packs/socles.json` to it. The previous version must stay loadable and reproduce exactly the same draws; prove it with a fingerprint test before and after (see `eval/identity/draw-hash.ts` for the method).

## 4. Sensitive attributes

Some attributes fall under special categories of data (ethnicity, religion, health, sexual orientation, political opinions, union membership). The Singapore base carries ethnicity and religion because they condition language, names, diet and housing in the real statistics. Even for synthetic people, such attributes can feed stereotypes: justify each one by what it conditions, keep the narrative checks against stereotypes active, and never use them to make a segment look more or less receptive than the data says.
