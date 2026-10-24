# Pack États-Unis `us-2026.1`

Population : adultes de 18 à 79 ans qui vivent aux États-Unis (50 États et District de Columbia), quel que soit leur statut (citoyens de naissance, naturalisés, non-citoyens). Montants en **USD**. Langue des récits, des prompts d'étude et des réponses : **anglais**. Socle courant du pays : `packs/socles.json` associe `us` à ce pack (`target: { socle: us }`).

- Générateur : `generator: us` (`src/personas/countries/us/`), contrat de pack pays dans [docs/architecture-v2.md § 16](../../docs/architecture-v2.md).
- Sources, chiffres relevés et approximations assumées : [docs/research/socle-us.md](../../docs/research/socle-us.md).
- Construction :
  1. `python3 -I packs/us/fetch-acs.py` : relevé des tables de l'ACS 2024 et du recensement 2020 (API publique de data.census.gov, sans clé) dans `docs/research/socle-us-data/acs-2024.json` (à relancer seulement pour actualiser) ;
  2. `python3 -I packs/us/build-tables.py` : tables du pack (le calage des salaires est lu dans `docs/research/socle-us-data/earnings-calibration.json`, fichier de construction gardé hors du pack : seules les tables tirées comptent dans l'empreinte sha256 du pack, la même en local et sur le Hub) ;
  3. `python3 -I packs/us/build-names.py <dossier yob*.txt> <firstnames.csv> <Names_2010Census.csv>` : prénoms et noms (fichiers SSA, Tzioumis 2018 converti en CSV, recensement 2010 ; sources dans le script) ;
  4. `npx tsx packs/us/calibrate.ts` (deux fois) : bornes de niveau de vie recalées sur le générateur, contrôle des salaires (BLS) et du revenu des ménages (CPS ASEC).
- Toute modification de données change les tirages : incrémenter `version` dans `pack.json` (nouveau dossier `packs/us-2026.2` avec `extends: us`, comme Singapour) dès que des personas `us-2026.1` sont utilisées par une étude.
- Contrôle des marges : `npm run personas:validate -- --pack us --virtual 2000` ; tests `test/personas/us.test.ts`.

| Fichier | Contenu | Nature |
|---|---|---|
| `age-sex.json`, `regions.json` | Âge × sexe, régions du Census Bureau | ACS 2024, sourcés |
| `geography.json` | États : adultes, part rurale, loyers et coûts des propriétaires, Medicaid, impôt de l'État | ACS 2024, recensement 2020, KFF sourcés ; taux d'impôt de l'État en approximation |
| `race.json`, `nativity.json`, `language.json`, `education.json` | Race et origine hispanique par État et âge, nativité, langue à la maison, diplôme | ACS 2024 ; langue par race × nativité en hypothèse calée |
| `activity.json`, `occupation.json`, `earnings.json` | Activité, études, profession (SOC), statut de l'emploi, salaires, retraites | CPS 2025, salaires du T3 2026 ; profession par diplôme et retraites en hypothèse calée |
| `tax.json` | Impôt fédéral 2026, FICA, CTC, EITC, seuils de pauvreté, SNAP | IRS, HHS, USDA, sourcés |
| `household.json`, `housing.json`, `health.json`, `costs.json` | Ménage, logement, assurance santé, dépenses (voitures, prêts étudiants, garde d'enfants) | ACS 2024, KFF, CMS, BLS CE 2024, Fed SHED ; hypothèses documentées |
| `digital.json`, `subscriptions.json`, `psychographics.json`, `living-standard.json` | Numérique, abonnements ($), traits, niveau de vie | Pew sourcé en partie ; prix sourcés, détention en hypothèse ; psychographie du socle commun ; niveau de vie recalé |
| `first-names.json`, `surnames.json` | Prénoms par groupe, sexe et génération ; noms de famille par groupe et origine asiatique | SSA, Tzioumis 2018, recensement 2010, ACS B02015 |
