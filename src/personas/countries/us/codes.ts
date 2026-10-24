/**
 * Codes du socle États-Unis (sans dépendance : lus aussi par la bibliothèque de modules).
 */

/** Régions du Census Bureau (colonne `region` de la persona). */
export const US_REGIONS = ["NE", "MW", "S", "W"] as const;
export type UsRegion = (typeof US_REGIONS)[number];

/** Divisions du Census Bureau. */
export const US_DIVISIONS = ["new_england", "middle_atlantic", "east_north_central", "west_north_central", "south_atlantic", "east_south_central", "west_south_central", "mountain", "pacific"] as const;

/** États et district fédéral (codes postaux ; colonne `townSize` de la persona). */
export const US_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
  "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD",
  "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
] as const;

/** Zone urbaine ou rurale (définition du recensement 2020). */
export const URBANICITY = ["urban", "rural"] as const;

/** Race et origine hispanique (catégories OMB, regroupées) : Hispanic de toute race, puis non-Hispanic par race. */
export const RACES = ["white", "black", "hispanic", "asian", "other"] as const;
export type Race = (typeof RACES)[number];

export const NATIVITY = ["us_born", "naturalized", "noncitizen"] as const;
export type Nativity = (typeof NATIVITY)[number];

/** Langue parlée à la maison (groupes de l'ACS). */
export const US_HOME_LANGUAGES = ["english", "spanish", "other_indo_european", "asian_pacific", "other"] as const;

export const US_EDUCATION = ["below_hs", "high_school", "some_college", "associate", "bachelor", "graduate"] as const;
export type UsEducation = (typeof US_EDUCATION)[number];

/** Grands groupes de professions (SOC 2018 regroupés comme les tableaux du CPS ; colonne `pcs`). */
export const US_OCCUPATIONS = [
  "management",
  "business_finance",
  "computer_engineering_science",
  "education_legal_community_arts",
  "healthcare_practitioners",
  "service",
  "sales",
  "office_admin",
  "farming",
  "construction",
  "installation_repair",
  "production",
  "transportation",
] as const;
export type UsOccupation = (typeof US_OCCUPATIONS)[number];

/** Statut de l'emploi (class of worker). */
export const CLASS_OF_WORKER = ["private", "nonprofit", "government", "self_employed"] as const;
export type ClassOfWorker = (typeof CLASS_OF_WORKER)[number];

/** Type de logement (units in structure). */
export const US_DWELLINGS = ["single_family", "townhouse", "small_multifamily", "apartment", "mobile_home"] as const;
export type UsDwelling = (typeof US_DWELLINGS)[number];

/** Statut d'occupation : mêmes codes que la France (renter_social = logement social ou bon de logement HUD). */
export const US_TENURES = ["owner", "owner_mortgage", "renter_private", "renter_social", "free"] as const;
export type UsTenure = (typeof US_TENURES)[number];

/** Couverture santé principale. */
export const HEALTH_INSURANCE = ["employer", "marketplace", "medicaid", "medicare", "military", "uninsured"] as const;
export type HealthInsurance = (typeof HEALTH_INSURANCE)[number];
