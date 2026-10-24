/**
 * Aides d'estimation du serveur MCP. Le coût réel (prix du modèle, moyennes mesurées) vient de
 * src/studies/cost.ts (docs/plateforme.md § 7.3) ; ce module garde les noms historiques.
 */
export { dryRun, estimateCost, estimateExistingStudy, estimateNewStudy, missingNarratives, type CostEstimate } from "../studies/cost";
