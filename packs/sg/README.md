# Pack Singapour `sg-2026.1`

> Socle courant : **`sg-2026.2`** (`packs/sg-2026.2`, `extends: sg`), qui ne change que les noms d'usage (conditionnés par la religion). Ce dossier reste `sg-2026.1`, reproductible à l'identique : ne pas modifier ses tables.

Population : adultes de 18 à 79 ans qui vivent habituellement à Singapour, **résidents et non-résidents** selon leurs parts réelles (citoyens, PR, Employment Pass, S Pass, Work Permit, employées de maison, dépendants, étudiants). Touristes exclus. Montants en **SGD**. Langue des récits, des prompts d'étude et des réponses : **anglais**.

- Générateur : `generator: sg` (`src/personas/countries/sg/`), contrat de pack pays dans [docs/architecture-v2.md § 16](../../docs/architecture-v2.md).
- Sources, chiffres relevés et approximations assumées : [docs/research/socle-sg.md](../../docs/research/socle-sg.md).
- Construction des tables : `python3 packs/sg/build-tables.py`, puis `npx tsx packs/sg/calibrate-living-standard.ts` (bornes de niveau de vie recalées sur le générateur). Toute modification de données change les tirages : incrémenter `version` dans `pack.json` dès que des personas `sg-2026.1` sont utilisées par une étude.
- Contrôle des marges : `npm run personas:validate -- --pack sg --virtual 2000`.

| Fichier | Contenu | Nature |
|---|---|---|
| `residency.json` | Statut de résidence × âge × sexe (Work Permit par secteur) | résidents sourcés (GHS 2025), non-résidents : parts sourcées (DOS), âge et sexe en hypothèse |
| `age-sex.json`, `regions.json` | Tables communes du contrat (sommes) | dérivées |
| `ethnicity.json`, `religion.json`, `language.json`, `education.json` | Ethnie, religion, langue à la maison, diplôme ; nationalités des non-résidents | résidents sourcés (GHS 2025), non-résidents en hypothèse |
| `geography.json` | Planning areas × type de logement ; logement des non-résidents ; dortoirs | résidents sourcés (C020125, M810381), non-résidents en hypothèse |
| `activity.json`, `occupation.json`, `earnings.json` | Activité (service national compris), profession SSOC, revenus | MOM 2025 et minimums des pass ; profession par diplôme et revenus WP/MDW en hypothèse calée |
| `cpf.json`, `tax-benefits.json` | CPF salarié, part CPF des prêts, impôt, transferts | barèmes officiels 2026 ; transferts répartis en hypothèse |
| `household.json`, `housing.json`, `costs.json` | Ménage, statut d'occupation, dépenses | construits à partir de la GHS 2025, du HES 2023 et des loyers HDB ; hypothèses documentées |
| `digital.json`, `subscriptions.json`, `psychographics.json`, `first-names.json`, `living-standard.json` | Numérique, abonnements (S$), traits, noms d'usage, niveau de vie | prix sourcés ; détention, traits et noms en hypothèse ; niveau de vie recalé |
