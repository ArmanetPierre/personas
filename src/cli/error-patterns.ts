/**
 * Traduction anglaise des messages levés ailleurs dans src/ (hub, moteur, population) et affichés tels quels
 * par la CLI : erreurs, avertissements, état hors ligne. Complète les motifs de l'API web (src/web/i18n.ts),
 * appliqués ensuite. Le français reste inchangé.
 */

type Replacement = string | ((match: string, ...groups: string[]) => string);

const PATTERNS: Array<[RegExp, Replacement]> = [
  [/Cache du Hub altéré : (.+?) \(sha256 (\S+) au lieu de (\S+)\)\. Supprimer (.+?) puis relancer (.+?)\.$/gm, "Hub cache tampered with: $1 (sha256 $2 instead of $3). Delete $4, then run $5 again."],
  [/Hub injoignable \(([^)]+)\) : (.+?)\. Hors ligne : les modules et packs déjà en cache restent utilisables\./g, "Hub unreachable ($1): $2. Offline: modules and packs already cached remain usable."],
  [/Pack (\S+) absent du catalogue du Hub( \(catalogue indisponible : (.+?)\))?\./g, (_m, ref, unavailable, cmd) => `Pack ${ref} is not in the Hub catalogue${unavailable ? ` (catalogue unavailable: ${cmd})` : ""}.`],
  [/Pas de bloc « ([^»]+) » dans le projet (\S+?)\./g, "No “$1” block in project $2."],
  [/Plafond de dépense non vérifiable \(profil ([^)]+)\) : prix du modèle (\S+) inconnu \(absent de pricing\/models\.json\), aucun appel n'est parti\. /g, "Spending cap cannot be checked (profile $1): the price of model $2 is unknown (not in pricing/models.json), no call was sent. "],
  [/Ajouter son prix au fichier \(ou PERSONAS_PRICING\), ou accepter le coût inconnu pour cette étude : (.+?) \(coût compté au prix du modèle le plus cher du fournisseur\)\./g, "Add its price to the file (or PERSONAS_PRICING), or accept the unknown cost for this study: $1 (cost counted at the price of the provider's most expensive model)."],
  [/Fichier de prix introuvable : (.+?)\. Il est livré avec Personas \(pricing\/models\.json\) : installation incomplète, réinstaller le paquet\. Sans lui, aucun coût ni plafond ne peut être calculé\./g, "Pricing file not found: $1. It ships with Personas (pricing/models.json): incomplete installation, reinstall the package. Without it, no cost or cap can be computed."],
  [/Fichier de prix introuvable : (.+?) \(PERSONAS_PRICING\)\. Corriger le chemin ou retirer la variable pour utiliser pricing\/models\.json\./g, "Pricing file not found: $1 (PERSONAS_PRICING). Fix the path or unset the variable to use pricing/models.json."],
  [/Table de référence introuvable : (.+?)\. Elle est livrée avec Personas \(pricing\/reference-usage\.json\) : installation incomplète, réinstaller le paquet\./g, "Reference table not found: $1. It ships with Personas (pricing/reference-usage.json): incomplete installation, reinstall the package."],
];

/** Message français connu → anglais (inchangé sinon). */
export function cliMessageEn(message: string): string {
  let out = message;
  for (const [re, to] of PATTERNS) out = typeof to === "string" ? out.replace(re, to) : out.replace(re, to);
  return out;
}
