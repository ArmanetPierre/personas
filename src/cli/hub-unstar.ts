import { starCommand } from "./hub-common";

/** Retire son étoile d'un module du Hub : personas hub unstar <namespace/module>. */
await starCommand(true);
