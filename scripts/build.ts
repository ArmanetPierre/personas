import { chmodSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { build, type Plugin } from "esbuild";

/**
 * Compilation de src/ en JavaScript (dist/), pour le paquet installé (`npm i -g`) : plus de tsx à l'exécution.
 *
 * Choix : esbuild fichier par fichier (un .js par .ts, même arborescence), pas de regroupement. tsc n'émet pas
 * d'extension dans les imports relatifs (les sources importent « ./app », que Node ESM ne résout pas) ; esbuild
 * réécrit chaque import relatif vers le fichier .js réel (`./app` → `./app.js`, `../engine` → `../engine/index.js`).
 * L'arborescence identique garde justes les chemins calculés depuis `import.meta.dirname` (packs/, modules/,
 * drizzle/, web/dist, docs/modules.md…). Les dépendances restent des imports de node_modules. Le typecheck reste
 * celui de tsc (npm run typecheck).
 *
 * Lancement : npm run build (build:web, puis ce script). `npm pack` le lance aussi (prepack).
 */

const ROOT = resolve(import.meta.dirname, "..");
const SRC = join(ROOT, "src");
const OUT = join(ROOT, "dist");
/** Non livrés : le serveur de développement (Vite, dépendance de développement). */
const SKIP = new Set(["web/dev.ts"]);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.ts$/.test(name) && !/\.d\.ts$/.test(name) && !SKIP.has(relative(SRC, p).replaceAll("\\", "/")) ? [p] : [];
  });
}

/** Fichier source d'un import relatif : x.ts, x/index.ts (ou un fichier non TypeScript, gardé tel quel). */
function resolveSource(fromDir: string, spec: string): { file: string; js: string } | null {
  const base = resolve(fromDir, spec);
  for (const [file, js] of [
    [`${base}.ts`, `${spec}.js`],
    [join(base, "index.ts"), `${spec.replace(/\/$/, "")}/index.js`],
  ] as const) {
    if (existsSync(file)) return { file, js };
  }
  if (/\.(js|mjs|json)$/.test(spec) && existsSync(base)) return { file: base, js: spec };
  return null;
}

const rewriteImports: Plugin = {
  name: "personas-rewrite-imports",
  setup(b) {
    b.onResolve({ filter: /.*/ }, (args) => {
      if (args.kind === "entry-point") return undefined;
      if (!args.path.startsWith(".")) return { path: args.path, external: true };
      const hit = resolveSource(args.resolveDir, args.path);
      if (!hit) return { errors: [{ text: `Import relatif introuvable : ${args.path} (depuis ${relative(ROOT, args.importer)})` }] };
      return { path: hit.js, external: true };
    });
  },
};

rmSync(OUT, { recursive: true, force: true });
const entryPoints = sources(SRC);
await build({
  entryPoints,
  outbase: SRC,
  outdir: OUT,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: false,
  logLevel: "warning",
  plugins: [rewriteImports],
});
const bin = join(OUT, "cli/main.js");
chmodSync(bin, 0o755);
console.log(`dist/ : ${entryPoints.length} fichiers compilés (${relative(ROOT, dirname(bin))}/main.js : binaire personas).`);
