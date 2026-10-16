import { previewTarget } from "../../population/preview";
import { arg, loadProject, main, writeJson } from "./common";

/** Aperçu de cible AVEC pré-tri Qwen (plusieurs minutes, en cache) : écrit le résultat dans --out. */
await main(async () => {
  const project = loadProject(arg("project")!);
  const out = arg("out")!;
  const t0 = Date.now();
  console.log(`Aperçu avec pré-tri : projet ${project.id}, groupe ${arg("group") ?? "target"}, graine ${arg("seed")}, n ${arg("n") ?? "défaut"}`);
  const preview = await previewTarget(project, {
    group: arg("group") ?? "target",
    seed: Number(arg("seed") ?? 42),
    sample: Number(arg("sample") ?? 10),
    ...(arg("n") && { n: Number(arg("n")) }),
    triage: true,
    log: (m) => console.log(m),
  });
  writeJson(out, preview);
  console.log(`Terminé en ${Math.round((Date.now() - t0) / 1000)} s : ${out}`);
});
