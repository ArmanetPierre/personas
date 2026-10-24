# Modules thématiques — format et moteur

Un **module** ajoute à des personas d'un socle (pack pays) des attributs propres à un domaine : entrepreneuriat, sport, équipement Apple… C'est un **fichier YAML déclaratif**, `modules/<id>/module.yaml`, validé par zod au chargement (`src/modules/schema.ts`) puis par des contrôles sémantiques (`src/modules/registry.ts`). Le moteur générique (`src/modules/engine.ts`) le tire, rend ses lignes de fiche, expose ses segments au moteur d'étude et au tableau de bord, et le valide.

Aucun code n'est propre à un module : un nouveau domaine s'ajoute par un fichier. Le premier module converti est `entrepreneuriat-tech` (ex-`founders.ts`), activé par le pack `fr-tech-founders` ; il est archivé depuis le 2026-10-15 (`modules/_archive/entrepreneuriat-tech/module.yaml`).

## Activer un module

**Par la cible d'un projet (v2, recommandé)** : voir « Ciblage » plus bas. Les modules sont appliqués à un socle v2 (`fr-2026.2`), chacun dans son propre flux aléatoire `(graine, rang, module)`, après le socle complet. Ajouter ou retirer un module ne change donc ni le socle ni les autres modules. Un module v2 ne peut pas remplacer le socle (`socle_overrides` est réservé aux packs v1), et ses abonnements éventuels sont affichés sur la fiche sans être déduits du reste-à-vivre du socle.

**Par un pack (v1, historique)** : dans le `pack.json` d'un pack :

```json
{ "version": "fr-tech-founders-2026.1", "extends": "fr", "modules": ["entrepreneuriat-tech"], "targeted": true }
```

- `modules` : liste des modules activés. Leurs dépendances (`requires`) sont ajoutées automatiquement.
- `targeted: true` : population ciblée. La validation laisse alors de côté les marges générales d'activité, de PCS et de niveau de vie.
- Les attributs tirés sont stockés dans `extra.modules.<id>.<clé>` (codes, jamais de libellés). Les libellés viennent toujours du module.

## Structure d'un module

```yaml
id: entrepreneuriat-tech          # = nom du dossier
version: "2026.1"
label: Entrepreneuriat tech
short_label: Entreprendre         # préfixe d'affichage (personas:show)
applies_to: [fr]                  # socles compatibles (racine de la chaîne extends)
requires: []                      # autres modules, tirés avant (graphe acyclique)
sources:                          # bibliographie, citée par clé
  apec: {org: Apec, title: "…", year: 2025, url: https://…}
conditions:                       # conditions nommées, réutilisables
  freelance: {attr: status, in: [freelance_micro, freelance_company]}
  young_children: {attr: socle.children_under_12, gt: 0}
tables:                           # tables de référence (lookup)
  salary_median: {values: {dev: 3080, …}, sources: [apec]}
  age_factor: {bands: [{from: 25, to: 29, value: 0.82}, …], assumption: true, justification: "…"}
attributes: […]                   # ordre de déclaration = ordre de tirage
socle_overrides: {…}              # facultatif : remplace la situation professionnelle du socle
card: […]                         # lignes de fiche
segments: […]                     # dimensions d'analyse
validation: {margins: […], plausibility: […]}
```

**Provenance.** Chaque attribut et chaque table cite au moins une source (`sources: [clé]`), ou bien porte `assumption: true` avec une `justification`, comme dans les packs. Une table sans l'un ni l'autre est refusée.

### Attributs

Champs communs : `key` (snake_case), `label`, `type`, `phase`, `when`, `display`, provenance.

| type | Contenu |
|---|---|
| `enum` | `values: [{code, label}]`, avec un libellé simple ou accordé `{M, F}`. `distribution` : `weights` (nombres, ou expressions évaluées pour chaque persona : modèle multiplicatif âge × PCS × sexe…), ou `given` + `table`. `given` prend un attribut (`given: status`) ou plusieurs (`given: [socle.activity_status, socle.pcs]`, table imbriquée dans cet ordre, clé `default` possible à chaque niveau). `sampler: random` (générateur à graine) ou `quasi` (suite de Kronecker indexée par le rang : sur 300 personas, les marges collent aux cibles). |
| `set` | Multi-sélection : `items: [{code, label, card_label?, rate, subscription?}]`. Chaque option est tirée indépendamment avec son taux. `rate_cap` plafonne chaque taux, `max_items` retire au hasard l'excédent, `min_items` complète au prorata des taux s'il en manque. `subscription` décrit un abonnement : il pèse sur le reste-à-vivre dans un pack v1, et sur le socle v2 seulement si l'attribut porte `affects_budget` (voir plus bas). |
| `number` | `value` : une expression (voir plus bas). `unit` facultatif. |
| `boolean` | `rate` : probabilité d'être vrai (tirage de Bernoulli ; la marge attendue se calcule), ou `value` : une expression, vraie si non nulle. `labels: {yes, no}`. |

- **`phase`** : `work` = tiré avec la situation professionnelle, avant le ménage, avec accès à `socle.age`, `sex`, `region`, `town_size`. `profile` (par défaut) = tiré après l'équipement et les abonnements, avec accès en plus à `household_type`, `tenure`, `children_under_12`, `partner_status` (`none` / `employed` / `not_employed`), `living_standard_ratio` (niveau de vie / médiane), `living_standard`, `monthly_income`, `activity_status` et `pcs`. En v2, tout le socle est déjà tiré : la phase ne sert qu'à l'ordre entre attributs.
- **Ordre** : un attribut ne peut citer qu'un attribut déclaré avant lui, ou d'une phase antérieure. Le chargeur refuse toute autre référence. L'ordre de déclaration est donc l'ordre de consommation du générateur aléatoire, ce qui garantit un tirage reproductible.
- **`when`** : condition de présence. Si elle est fausse, l'attribut vaut `null` et ne consomme aucun tirage. Exemple : le taux journalier n'existe que pour les freelances.

### Conditions

`{attr: X, in: [...]}`, `{attr: X, eq: v}`, `{attr: X, lt: n}`, `{attr: X, gt: n}`, `{attr: X, present: true}`, `{all: [...]}`, `{any: [...]}`, `{not: …}`, ou le nom d'une condition déclarée dans `conditions`.

Les références d'attribut s'écrivent :
- `status` pour un attribut du module ;
- `autre-module.attr` pour un module requis ;
- `socle.age` pour une variable du socle.

### Expressions : les primitives de calcul nommées

C'est l'échappatoire encadrée pour les dérivations, comme le revenu d'un freelance. Ce sont des objets à une clé, évalués de gauche à droite :

| Primitive | Effet |
|---|---|
| `3.5`, `{attr: x}` | constante, valeur d'un attribut |
| `{lookup: table, by: attr}` | valeur d'une table de référence. Par code d'enum, ou par tranche (`bands`) d'une variable numérique ramenée dans les bornes. |
| `{pick: attr, values: {code: n}, default: n}` | table en ligne |
| `{mul: […]}`, `{add: […]}`, `{div: [a, b]}`, `{min: […]}`, `{max: […]}`, `{exp: e}` | arithmétique |
| `{round: e}`, `{round_to: 10, value: e}` | arrondis |
| `{normal: {}}`, `{lognormal: {median, sigma}}`, `{bernoulli: p}` | tirages aléatoires : loi normale, log-normale, 1 avec la probabilité p |
| `{if: cond, then, else}`, `{cases: [{when, value}, …, {else}]}` | branchements |

Le taux d'une option d'ensemble accepte aussi le raccourci `{base: 0.3, factors: {salaried: 1.5, freelance: 0.3}}` : le taux de base est multiplié par le facteur de chaque condition vraie, dans l'ordre.

### Effets sur le revenu et le budget (`socle_overrides`, `affects_budget`)

**Socle v2 (flux par module), depuis le 2026-10-15.** Un module peut :
- **remplacer le revenu personnel** du socle :

  ```yaml
  socle_overrides:
    monthly_income: {attr: monthly_income, when: freelance}   # attribut nombre ; `when` facultatif
  ```

- **déduire des abonnements du reste-à-vivre** : sur un attribut ensemble, `affects_budget: true` (ou `{when: cond}`, par exemple « payé de sa poche ») ; chaque option tirée qui porte `subscription: {name, category, monthly_eur}` s'ajoute aux abonnements de la persona. Un abonnement payé par l'employeur ne se déclare pas, ou se met sous condition.

Ordre de tirage : le socle est tiré seul, puis les modules (chacun dans son flux, sur le socle d'avant), puis, **seulement si un module déclare un effet pour cette persona**, un **recalcul déterministe** du budget (`src/personas/economics.ts`, aucun nouveau tirage) :
- recalculés : impôt sur le revenu, prestations (allocations, minima, prime d'activité, aide au logement), revenus du patrimoine (même taux), mensualité d'un crédit (plafond d'effort), revenu disponible, niveau de vie, dépenses courantes, abonnements, reste-à-vivre, sensibilité au prix (même part aléatoire) ;
- figés : ménage, logement, profil techno, équipement, scepticisme, tonalité ;
- trace dans `extra.economics` : `{modules, incomeBefore, budgetBefore, householdIncomeBefore, subscriptions}`.

Sans recalcul, le recalcul à vide retrouve les valeurs tirées à l'euro près (contrôle : `eval/identity/economics-noop.ts`). **Une persona sans module, ou dont les modules n'ont pas d'effet, garde exactement le tirage du socle** (test `test/modules/economics.test.ts`, empreinte de 3 000 personas).

**Packs v1 (pack ciblé, flux du socle).** Le module peut remplacer toute la situation professionnelle ; les attributs sont de phase `work` et la chaîne du socle s'applique ensuite :

```yaml
socle_overrides:
  activity_status: {from: status}      # chaque valeur de status porte socle: {activity_status, pcs}
  pcs: {from: status}
  monthly_income: {attr: monthly_income}
  occupation_label: "{occupation} — {status}"
```

Un seul module actif peut déclarer `socle_overrides`.

### Versions et identité des personas

- Chaque module a une `version` et un `changelog` (`[{version, date, changes: […]}]`, le plus récent d'abord). Une modification de module validé se fait **par une nouvelle version**.
- Une persona en base **n'est jamais réécrite** : elle garde son socle et les valeurs de ses modules (`persistDrawn` refuse un socle différent sous le même identifiant et ne remplace jamais les valeurs d'un module déjà présent).
- Identifiant d'une persona v2 : `fr-2026.2-s<graine>-<rang>` si tous ses modules sont **à la version du socle** (2026.2) **et sans effet budgétaire** ; sinon suffixe stable `-m<empreinte>`, calculé sur les « id@version » de ces modules (ex. `fr-2026.2-s42-0001-m15bfff`). Les études passées gardent donc leurs personas ; les nouvelles études tirent les nouvelles valeurs sous d'autres identifiants.
- Les récits se réemploient entre jumeaux seulement si le socle est identique (`ensureNarratives`) : une persona dont le revenu ou le budget a changé reçoit son propre récit.
- La fiche d'une persona ancienne se rend avec la définition courante du module (libellés, gabarits) ; les codes restent compatibles d'une version à l'autre.

### Modules archivés

Un module retiré passe dans `modules/_archive/<id>/` (`status: legacy`). Il reste chargé, pour relire les packs et les études historiques (fiches, segments des résumés), mais il est absent de la bibliothèque proposée (`listModules`, catalogues des assistants), des cibles (`prepareTarget` le refuse) et des facettes de la page Personas. `librarySegments()` marque ses segments `legacy: true`. Archivé : `entrepreneuriat-tech` (pack `fr-tech-founders-2026.1` et ses études).

### Fiche, segments, validation

- **`card`** : lignes de gabarit, insérées après « Situation » dans la fiche des récits et des études. `{attr}` est remplacé par le rendu de l'attribut :
  - libellé accordé au sexe ;
  - liste séparée par des virgules pour un ensemble (`card_label` des options) ;
  - montant si `display.format: eur`, pourcentage si `display.format: percent` (part entre 0 et 1).

  Le gabarit `display.template` (« environ {value} h par semaine ») et le texte `display.empty` (valeur nulle, vide ou absente) s'appliquent. Une ligne peut être conditionnelle : `{when: cond, template: "…"}`.
- **`segments`** : `{id, attribute, label, compare?}`. L'`id` est la dimension d'analyse, stable car utilisée par les quotas, `study:summary`, `study:compare` et le tableau de bord. `compare` donne le rang de la dimension dans les comparaisons de variantes.
- **`validation.margins`** : attributs enum dont la marge observée est comparée à la distribution théorique, déroulée sur les conditionnements internes au module (test du chi² et écart max, comme les dimensions du socle).
- **`validation.shares`** : part d'une sous-population (`among`) qui vérifie une condition (`share_of`), dans une fourchette sourcée (ex. « pros du numérique parmi les personnes en emploi : 4,6 % »).
- Les marges d'attributs conditionnés au socle se comparent à la **moyenne des distributions attendues** de chaque persona (poids évalués sur ses propres attributs) : c'est ce qui permet de valider un module sur la population générale.
- **`validation.plausibility`** : médiane d'une valeur (`socle.monthly_income` ou attribut numérique) par groupe, dans des fourchettes `median_in`, ou relative à une table de référence (`median_vs_table: {table, range: [0.75, 1.3]}`).

## Ce qui reste du code, et pourquoi

- **Le socle** (`src/personas/sampler.ts`) appelle le moteur à deux points fixes, sans rien savoir du domaine :
  - `phase work`, à la place du tirage d'activité si un module la remplace ;
  - `phase profile`, avant le calcul des dépenses.
- **Aucun `derive.ts`** : la dérivation la plus complexe du premier cas tient dans les primitives d'expression ci-dessus. C'est le revenu d'un freelance (TJM × jours facturés, plafond de la micro-entreprise, part nette) qui remplace le revenu du socle. On n'ouvrira un fichier de code par module que si un futur domaine demande une logique impossible à exprimer ainsi (une boucle, une optimisation). Il faudra alors le justifier ici, le garder minimal et lui donner une signature pure (valeurs en entrée, valeurs en sortie, générateur fourni).
- **Les surcharges de population** (âge × sexe, régions, agglomérations, ménage, équipement, latente techno) restent des tables du pack `fr-tech-founders`. Elles relèvent du ciblage conditionnel (phase 2 de l'architecture v2).

## Ciblage (phase 2a) : modules sur toute la population

Les modules v2 s'appliquent **à tout adulte** du socle, et la cible se déclare dans le projet :

```yaml
target:
  socle: fr                      # résolu par packs/socles.json (fr → fr-2026.2)
  modules: [numerique, entrepreneuriat]
  eligibility: "age >= 25 and age <= 45 and numerique.is_digital_worker and entrepreneuriat.stage != none"
  quotas: {sex: {F: 0.5, M: 0.5}}   # facultatif (dimensions des segments)
  n: 50
control: {socle: fr, n: 20}
```

- **Tirage conditionnel** (`src/population/target.ts`) : le générateur tire des personas virtuelles rang après rang (graine de l'étude), garde les éligibles jusqu'à n et mesure le **taux d'éligibilité** avec son intervalle de Wilson. Une borne (`max_draws`, 1 million par défaut) arrête une cible introuvable avec un message clair ; une cible sous 0,5 % est signalée comme rare (`rare_threshold`).
- **Filtre** (`src/population/eligibility.ts`) : phrase avec `and`, `or`, `not`, parenthèses, `==`, `!=`, `<`, `<=`, `>`, `>=`, `in [..]`, `not in [..]`. Une variable seule vaut vrai si elle est vraie et non vide. Variables : `age`, `sex`, `region`, `town_size`, `pcs`, `activity_status`, `household_type`, `household_size`, `monthly_income`, `household_income`, `budget`, `living_standard`, `tech_adoption`, `social_media`, `tenure`, `children`, et `module.attribut`. Une variable inconnue est refusée, avec la liste des variables disponibles.
- **Cache** : les personas retenues sont enregistrées avec des ids stables `fr-2026.2-s<graine>-<rang>` et la trace des modules appliqués (`extra.modules`, `extra.moduleVersions`). Une persona déjà en base est réutilisée, et on lui ajoute les modules qui lui manquent.
- **Récits à la demande** (`src/population/narratives.ts`, `ensureNarratives`) : seules les personas de l'échantillon sans récit en reçoivent un. On reprend d'abord le récit d'un « jumeau » du même socle (même graine, même rang, mêmes attributs, ex. `fr-2026.1`) ; sinon, le récit est écrit via `claude-cli` avec les contrôles anti-clichés. Le récit reste générique : la fiche envoyée au LLM n'a pas les lignes de module, qui s'ajoutent à la fiche d'étude.

## Assistant de création de modules (phase 5)

L'assistant propose, l'utilisateur valide. Code : `src/modules/assistant/` (fonctions exportées par `index.ts`, réutilisées par le tableau de bord).

- **Brouillons** : `modules/_drafts/<draftId>/module.yaml` + `meta.json` (`status` : `proposing`, `ready`, `error`, `accepted` ; `progress`, `notes`, `history` avec diff, `usage`, `steps`) + `research.json` (sources trouvées). Les dossiers en `_` sont ignorés par la bibliothèque. Un brouillon validé est copié vers `modules/<id>/module.yaml` (son `meta.json` passe à `accepted`).
- **Proposition** (`module:propose`), trois étapes reprenables :
  1. **recherche de sources** par Claude (`claude-cli`) en **mode recherche** : seuls `WebSearch` et `WebFetch` sont autorisés (option `webTools` du backend ; le mode normal reste sans aucun outil). Sortie JSON : sources (URL réellement consultées, `verified` si la page a été ouverte), chiffres trouvés, attributs proposés avec leurs conditionnements, notes ;
  2. **rédaction du YAML**, sans outils : le prompt contient ce document, le catalogue des variables du socle (avec leurs codes), les modules existants et un module exemple (`numerique`) ;
  3. **réparations** (3 tours au plus) : les erreurs de validation (zod, sémantique, dépendances, filtres prêts à l'emploi) et les **alertes bloquantes de l'aperçu** (ex. un OS d'ordinateur tiré chez des personas sans ordinateur) sont renvoyées au modèle.
  Sur une limite d'usage Max, le brouillon passe en `error` avec le message de reprise ; `--draft <id>` reprend à l'étape interrompue sans refaire la recherche.
- **Révision** (`module:revise`) : une instruction, une modification ciblée, revalidée et réparée ; l'historique garde le diff. Avec `--research` (case « chercher des sources » du tableau de bord), une **recherche ciblée** sur l'instruction précède la révision, dans le même mode recherche et avec les mêmes règles ; ses sources sont fusionnées dans `research.json` (dédoublonnées par URL). Après validation, la révision **recale les distributions sur les parts sourcées** déclarées en `validation.shares` : l'aperçu mesure les écarts, le modèle ajuste poids et coefficients (2 tours au plus), et une version n'est gardée que si elle est valide et ne fait pas pire.
- **Aperçu** (`module:preview`, `previewModule`) : tirage virtuel du socle v2 + du module (10 000 personas par défaut), marges par attribut, fiches exemples, taux des `eligibility_helpers`, et **alertes** : attribut sans source, plus de 50 % d'hypothèses, valeur jamais tirée, catégorie très rare (< 0,5 % des personas concernées), conditionnement sans effet (même distribution pour tous), marge ou cible déclarée (`validation.shares`) non atteinte, incohérence avec le socle (attribut d'ordinateur, de smartphone ou de tablette chez des personas sans cet équipement — niveau `error`, bloquant ; attribut professionnel chez des personas sans emploi).
- **Validation** (`module:accept`) : refusée si la validation échoue ou si l'aperçu a une alerte `error`.
- **Édition manuelle** : `saveDraftYaml(draftId, yaml)` (tableau de bord), refusée si le YAML est invalide.

| Commande | Effet |
|---|---|
| `npm run module:propose -- --description "<domaine>" [--id <module-id>] [--project <id\|fichier>] [--socle fr] [--draft <id>]` | Crée ou reprend un brouillon |
| `npm run module:revise -- --draft <id> --instruction "<texte>" [--research]` | Révision ciblée, avec recherche de sources en option |
| `npm run module:preview -- --draft <id> \| --module <id> [--n 10000] [--sample 5] [--json]` | Aperçu et alertes |
| `npm run module:accept -- --draft <id> [--replace]` | Valide vers la bibliothèque |

Variables du socle ajoutées pour les modules d'équipement : `socle.has_computer`, `has_smartphone`, `has_tablet`, `has_internet`, `tech_adoption`, `social_media` (et `has_computer`… dans le filtre d'éligibilité). Les modules peuvent déclarer des `eligibility_helpers` (filtres prêts à l'emploi, ex. `mac_user: "equipement-ecosysteme.computer_os == macos"`), vérifiés à la validation.

## Commandes

| Commande | Effet |
|---|---|
| `npm run personas:generate -- --pack fr-tech-founders --count 300 --seed 42` | Tire le socle et les modules du pack |
| `npm run personas:validate -- --pack fr-tech-founders` | Marges du socle et des modules, plausibilité |
| `npm run population:draw -- --target cible.yaml --n 300 [--seed 42] [--persist]` | Tire une cible sans LLM : taux d'éligibilité, intervalle, marges de l'échantillon |
| `npm run population:draw -- --project examples/meal-planner-v2.json --n 200 --drafts` | Même aperçu avec des modules encore en brouillon (lecture seule, sans `--persist`) ; les études n'acceptent que des modules validés |
| `npm run personas:validate -- --pack fr-2026.2 --modules numerique,entrepreneuriat --virtual 20000` | Valide les modules sur la population générale (personas virtuelles) |
| `npm run study:create -- --project examples/meal-planner-v2.json --seed 42 [--no-narrate]` | Étude à partir des blocs `target` et `control` du projet, récits manquants compris |
| `npm run personas:migrate-modules -- [--pack …] [--dry-run]` | Migration de données vers `extra.modules` (idempotente). Chaque persona est re-tirée et n'est réécrite que si tous ses attributs enregistrés sont identiques au nouveau tirage. |

Le chargeur affiche des erreurs lisibles, par exemple :

```
Module entrepreneuriat-tech (modules/…/module.yaml) invalide :
  - attribut « team » : « stage » n'est pas un attribut déclaré avant lui (l'ordre de déclaration est l'ordre de tirage)
  - table « net_share » : « salarie » n'est pas une valeur de status
```

## Socles d'autres pays (2026-10-16)

Un module déclare les socles auxquels il s'applique (`applies_to: [fr]`, `[sg]`). Les variables `socle.<var>` disponibles dépendent du pays : la France garde son catalogue (`SOCLE_VARS`, `SOCLE_CODES`) ; Singapour reprend les mêmes noms (avec `town_size` = planning area, `pcs` = grand groupe SSOC, montants en S$) et ajoute `residency_status`, `ethnicity`, `religion`, `home_language`, `education`, `dwelling` et `planning_area` (`SOCLE_VARS_SG`, `SOCLE_CODES_SG`, `SOCLE_VAR_DOCS_SG` dans `src/modules/registry.ts`). Les libellés et les lignes de fiche d'un module du socle Singapour sont en anglais, puisque les fiches et les prompts de ce socle le sont. Contrat complet : [architecture-v2.md § 16](architecture-v2.md).
