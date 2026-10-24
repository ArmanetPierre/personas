/**
 * Codes du socle Singapour (sans dépendance : lus aussi par la bibliothèque de modules).
 */

/** Statuts de résidence : citoyens, résidents permanents, étrangers résidents par type de pass. */
export const RESIDENCY = ["citizen", "pr", "ep", "spass", "wp", "mdw", "dependant", "student"] as const;
export type Residency = (typeof RESIDENCY)[number];
export const RESIDENT_STATUSES: readonly Residency[] = ["citizen", "pr"];

export const ETHNICITIES = ["chinese", "malay", "indian", "others"] as const;
export type Ethnicity = (typeof ETHNICITIES)[number];

export const RELIGIONS = ["buddhism", "taoism", "christianity", "islam", "hinduism", "sikhism", "other", "none"] as const;
export const HOME_LANGUAGES = ["english", "mandarin", "chinese_dialects", "malay", "tamil", "other_indian", "other"] as const;
export const EDUCATION_LEVELS = ["below_secondary", "secondary", "post_secondary", "diploma", "degree"] as const;
export type Education = (typeof EDUCATION_LEVELS)[number];

/** Types de logement (SingStat) ; `dormitory` : dortoirs de travailleurs étrangers. */
export const DWELLINGS = ["hdb_1_2", "hdb_3", "hdb_4", "hdb_5_exec", "condo", "landed", "dormitory", "other"] as const;
export type Dwelling = (typeof DWELLINGS)[number];
export const RESIDENT_DWELLINGS = ["hdb_1_2", "hdb_3", "hdb_4", "hdb_5_exec", "condo", "landed", "other"] as const;

/** Statut d'occupation : mêmes codes que la France (renter_social = location publique HDB). */
export const SG_TENURES = ["owner", "owner_mortgage", "renter_private", "renter_social", "free"] as const;
export type SgTenure = (typeof SG_TENURES)[number];

/** Nationalités vues par les modules : `singapore` pour les citoyens, nationalité tirée pour les non-résidents (null pour les PR, non tirée). */
export const SG_NATIONALITIES = ["singapore", "india", "china", "malaysia", "bangladesh", "myanmar", "philippines", "indonesia", "other_asia", "vietnam", "east_asia", "western", "other"] as const;

/** SSOC 2020, grands groupes. */
export const SSOC_CODES = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;
export type SsocCode = (typeof SSOC_CODES)[number];

