// Empreintes de tirage (identité) : socle sans module, socle + modules, pack historique.
import { createHash } from "node:crypto";
import { loadPack } from "../../src/personas/pack";
import { drawPersona } from "../../src/personas/sampler";
import { resolveModules } from "../../src/modules/registry";
const h = (x: unknown) => createHash("sha1").update(JSON.stringify(x)).digest("hex").slice(0, 16);
const v2 = loadPack("fr-2026.2");
const out: Record<string, string> = {};
for (const seed of [7, 42]) out[`fr-2026.2 s${seed} socle`] = h(Array.from({ length: 3000 }, (_, i) => drawPersona(v2, seed, i)));
for (const mods of [["equipement-ecosysteme", "productivite-reunions"], ["entrepreneuriat"], ["numerique"]]) {
  const r = resolveModules(mods, v2.socle);
  out[`fr-2026.2 s42 ${mods.join("+")}`] = h(Array.from({ length: 3000 }, (_, i) => drawPersona(v2, 42, i, { modules: r })));
}
out["fr-tech-founders s7"] = h(Array.from({ length: 300 }, (_, i) => drawPersona(loadPack("fr-tech-founders"), 7, i)));
out["fr-2026.1 s7"] = h(Array.from({ length: 1000 }, (_, i) => drawPersona(loadPack("fr"), 7, i)));
console.log(JSON.stringify(out, null, 1));
