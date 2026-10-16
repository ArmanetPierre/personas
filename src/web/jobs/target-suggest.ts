import { suggestionPath, suggestTarget, writeSuggestion } from "../../population/suggest";
import type { ProjectExtra } from "../../studies/project";
import { projectSourceFile } from "../project-files";
import { arg, loadProject, main, ROOT, writeJson } from "./common";

/** Assistant de cible (claude-cli) : proposition complète en JSON (--out) et fichier YAML habituel. */
await main(async () => {
  const project = loadProject(arg("project")!);
  const out = arg("out")!;
  const s = await suggestTarget(project, { n: Number(arg("n") ?? 200), seed: Number(arg("seed") ?? 42), log: (m) => console.log(m) });
  writeJson(out, s);
  const file = (project.extra as ProjectExtra).sourceFile;
  // À côté du fichier projet seulement s'il existe vraiment (un import par le tableau de bord n'a pas de fichier)
  const yaml = writeSuggestion(s, suggestionPath(projectSourceFile(ROOT, file), project.id));
  console.log(`Proposition : ${s.variants.length} variante(s), ${s.usage.calls} appel(s) ; ${out} ; ${yaml}`);
});
