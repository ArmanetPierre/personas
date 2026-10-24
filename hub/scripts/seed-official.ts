import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parse as parseYaml } from "yaml";
import { OFFICIAL_NAMESPACE } from "../../src/hub/contract";
import { generatorPackFiles } from "../src/pack-check";

/**
 * Amorçage du Hub : publie sous `personas/` les modules validés du dépôt (modules/<id>/module.yaml,
 * pas les brouillons), le module archivé entrepreneuriat-tech (statut yanked, Q nul si l'aperçu ne
 * tourne plus sur le socle courant), puis les packs pays (fr, fr-2026.2, fr-tech-founders, sg,
 * sg-2026.2, us = us-2026.1) avec leur `extends`, par l'API d'administration. Aucun module validé ne
 * vise encore `us` (les modules US sont dans modules/_drafts) : ils seront publiés d'office une fois validés.
 *
 *   HUB_URL=http://127.0.0.1:8080 HUB_ADMIN_TOKEN=… npm run hub:seed [-- --dry-run]
 *
 * Une version déjà publiée (409) est ignorée : le script peut être relancé.
 *
 * Le dossier d'un pack ne contient que le manifeste et les tables du générateur : l'empreinte locale
 * (src/personas/pack-source.ts, tous les .json du dossier) est alors celle que le Hub calcule. Un autre fichier
 * JSON (fichier de construction, comme le calage des salaires US, rangé dans docs/research/socle-us-data/) fait
 * échouer l'amorçage au lieu d'être écarté en silence : sinon un lock fait sur le pack local serait refusé par
 * une machine qui tire le pack du Hub.
 */

const ROOT = resolve(import.meta.dirname, "../..");
/** Fichiers comptés dans l'empreinte locale d'un pack (même règle que SAFE_PACK_FILE, src/hub/cache.ts). */
const SAFE_PACK_FILE = /^[a-z0-9][a-z0-9._-]*\.json$/;
export const OFFICIAL_PACKS = ["fr", "fr-2026.2", "fr-tech-founders", "sg", "sg-2026.2", "us"];
export const ARCHIVED_MODULES = ["entrepreneuriat-tech"];

export type Publication =
  | { kind: "module"; label: string; body: { namespace: string; yaml: string } }
  | { kind: "pack"; label: string; body: { namespace: string; slug: string; version: string; files: Record<string, string>; extends: string | null } };

/** Publications dans l'ordre : modules (dépendances d'abord), puis packs (bases d'abord). */
export function officialPublications(root = ROOT): Publication[] {
  const mods: Array<{ id: string; yaml: string; requires: string[] }> = [];
  const read = (file: string) => {
    const yaml = readFileSync(file, "utf8");
    const def = parseYaml(yaml) as { id: string; requires?: unknown[] };
    mods.push({ id: def.id, yaml, requires: (def.requires ?? []).map((r) => (typeof r === "string" ? r : String((r as { ref?: string }).ref ?? ""))).map((r) => r.replace(/^personas\//, "").replace(/@.*$/, "")) });
  };
  const dir = join(root, "modules");
  for (const d of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!d.isDirectory() || d.name.startsWith("_")) continue;
    const file = join(dir, d.name, "module.yaml");
    if (existsSync(file)) read(file);
  }
  for (const id of ARCHIVED_MODULES) read(join(dir, "_archive", id, "module.yaml"));

  const ordered: typeof mods = [];
  const visit = (id: string, path: string[]) => {
    if (ordered.some((m) => m.id === id)) return;
    if (path.includes(id)) throw new Error(`Dépendances circulaires : ${[...path, id].join(" → ")}`);
    const m = mods.find((x) => x.id === id);
    if (!m) throw new Error(`Module requis introuvable : ${id}`);
    for (const r of m.requires) visit(r, [...path, id]);
    ordered.push(m);
  };
  for (const m of mods) visit(m.id, []);

  const packsDir = join(root, "packs");
  const manifests = new Map(OFFICIAL_PACKS.map((p) => [p, JSON.parse(readFileSync(join(packsDir, p, "pack.json"), "utf8")) as { version: string; extends?: string; generator?: string }]));
  const packOrder: string[] = [];
  const visitPack = (p: string) => {
    if (packOrder.includes(p)) return;
    const m = manifests.get(p);
    if (!m) throw new Error(`Pack de base absent de la liste officielle : ${p}`);
    if (m.extends) visitPack(m.extends);
    packOrder.push(p);
  };
  OFFICIAL_PACKS.forEach(visitPack);

  return [
    ...ordered.map((m): Publication => ({ kind: "module", label: m.id, body: { namespace: OFFICIAL_NAMESPACE, yaml: m.yaml } })),
    ...packOrder.map((p): Publication => {
      const m = manifests.get(p)!;
      const files: Record<string, string> = {};
      const known = generatorPackFiles(m.generator);
      for (const f of readdirSync(join(packsDir, p)).sort()) {
        if (!SAFE_PACK_FILE.test(f)) continue;
        if (!known.has(f)) throw new Error(`Pack ${p} : ${f} n'est pas une table du générateur « ${m.generator ?? "fr"} ». Sortir les fichiers de construction du dossier du pack (l'empreinte locale différerait de celle du Hub).`);
        files[f] = readFileSync(join(packsDir, p, f), "utf8");
      }
      // Slug = dossier sans suffixe de version (fr-2026.2 → fr) ; extends = version du dossier de base
      const slug = p.replace(/-\d{4}\.\d+$/, "");
      return { kind: "pack", label: `${p} (${m.version})`, body: { namespace: OFFICIAL_NAMESPACE, slug, version: m.version, files, extends: m.extends ? manifests.get(m.extends)!.version : null } };
    }),
  ];
}

/** Publie chaque entrée ; `send` envoie la requête (fetch réel, ou app.request dans les tests). */
export async function seed(send: (path: string, body: unknown) => Promise<{ status: number; json: unknown }>, log = console.log): Promise<{ published: number; skipped: number }> {
  let published = 0;
  let skipped = 0;
  for (const p of officialPublications()) {
    const r = await send(p.kind === "module" ? "/v1/admin/modules" : "/v1/admin/packs", p.body);
    if (r.status === 201) {
      published++;
      const q = (r.json as { quality?: { q: number } | null }).quality;
      log(`publié   ${p.kind} ${p.label}${q ? ` (Q ${q.q})` : ""}`);
    } else if (r.status === 409) {
      skipped++;
      log(`ignoré   ${p.kind} ${p.label} (déjà publié)`);
    } else {
      throw new Error(`${p.kind} ${p.label} : HTTP ${r.status} ${JSON.stringify(r.json)}`);
    }
  }
  return { published, skipped };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { values } = parseArgs({ options: { "dry-run": { type: "boolean", default: false } } });
  if (values["dry-run"]) {
    for (const p of officialPublications()) console.log(`${p.kind.padEnd(6)} ${p.label}`);
    process.exit(0);
  }
  const base = (process.env.HUB_URL ?? "http://127.0.0.1:8080").replace(/\/$/, "");
  const token = process.env.HUB_ADMIN_TOKEN;
  if (!token) {
    console.error("HUB_ADMIN_TOKEN manquant.");
    process.exit(2);
  }
  const r = await seed(async (path, body) => {
    const res = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => null) };
  });
  console.log(`${r.published} publié(s), ${r.skipped} déjà présent(s).`);
}
