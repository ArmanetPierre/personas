/**
 * Assistant de création de modules (phase 5) : l'assistant propose, l'utilisateur valide.
 * Fonctions exportées pour la CLI (`module:*`) et le tableau de bord (lectures rapides).
 */
export {
  acceptDraft,
  createDraft,
  draftExists,
  draftsDir,
  getModule,
  libraryWithDrafts,
  listModules,
  readMeta,
  saveDraftYaml,
  validateModuleYaml,
  type DraftHistoryEntry,
  type DraftMeta,
  type DraftStatus,
  type ModuleSummary,
  type ValidationIssue,
} from "./drafts";
export { previewModule, type PreviewAlert, type PreviewMargin, type PreviewResult } from "./preview";
export { proposeModule, reviseModule, MAX_REPAIRS } from "./propose";
export { lineDiff } from "./diff";
