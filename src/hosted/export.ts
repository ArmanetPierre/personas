import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";
import { inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { personas, projects, responses, studies } from "../db/schema";

/**
 * Export des données d'un compte hébergé (GET /api/me/export) : archive tar.gz de JSON.
 *
 *   personas-export/manifest.json            date, compte, nombre d'objets
 *   personas-export/projects/<id>.json       projet (ligne de la base)
 *   personas-export/studies/<id>.json        étude, avec ses réponses
 *   personas-export/personas.json            personas des échantillons
 *   personas-export/files/…                  fichiers produits (recommandations, propositions, suggestions, résumés)
 *
 * Jamais la clé IA (même chiffrée), ni les journaux techniques.
 */

const FILE_DIRS = ["recommendations", "proposals", "suggestions", "summaries", "previews", "projects"] as const;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

const safeName = (s: string) => s.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 90) || "x";

/** En-tête ustar (512 octets) d'un fichier ordinaire. */
function tarHeader(name: string, size: number, mtime: Date): Buffer {
  const h = Buffer.alloc(512, 0);
  let prefix = "";
  let base = name;
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf("/", 154);
    prefix = name.slice(0, cut);
    base = name.slice(cut + 1);
  }
  const put = (s: string, off: number, len: number) => h.write(s.slice(0, len), off, len, "utf8");
  const oct = (n: number, len: number) => n.toString(8).padStart(len - 1, "0") + "\0";
  put(base, 0, 100);
  put(oct(0o644, 8), 100, 8);
  put(oct(0, 8), 108, 8);
  put(oct(0, 8), 116, 8);
  put(oct(size, 12), 124, 12);
  put(oct(Math.floor(mtime.getTime() / 1000), 12), 136, 12);
  h.fill(" ", 148, 156);
  put("0", 156, 1);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  put(prefix, 345, 155);
  let sum = 0;
  for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return h;
}

export function tarGz(entries: Array<{ name: string; data: Buffer; mtime?: Date }>): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    parts.push(tarHeader(e.name, e.data.length, e.mtime ?? new Date()), e.data);
    const pad = (512 - (e.data.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad, 0));
  }
  parts.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(parts));
}

const json = (v: unknown) => Buffer.from(`${JSON.stringify(v, null, 2)}\n`, "utf8");

function filesOf(dir: string, base: string, out: Array<{ name: string; data: Buffer; mtime: Date }>): void {
  if (!existsSync(dir)) return;
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isDirectory()) filesOf(p, base, out);
    else if (d.isFile() && /\.(json|ya?ml)$/i.test(d.name)) {
      const st = statSync(p);
      if (st.size > MAX_FILE_BYTES) continue;
      out.push({ name: `personas-export/files/${relative(base, p).split("\\").join("/")}`, data: readFileSync(p), mtime: st.mtime });
    }
  }
}

export function exportAccount(db: Db, accountDir: string, user: { id: string; email: string | null }): { archive: Buffer; counts: Record<string, number> } {
  const entries: Array<{ name: string; data: Buffer; mtime?: Date }> = [];
  const projectRows = db.select().from(projects).all();
  const studyRows = db.select().from(studies).all();
  for (const p of projectRows) entries.push({ name: `personas-export/projects/${safeName(p.id)}.json`, data: json(p) });
  const personaIds = new Set<string>();
  let responseCount = 0;
  for (const s of studyRows) {
    const rows = db.select().from(responses).where(inArray(responses.studyId, [s.id])).all();
    responseCount += rows.length;
    for (const id of s.personaIds) personaIds.add(id);
    entries.push({ name: `personas-export/studies/${safeName(s.id)}.json`, data: json({ study: s, responses: rows }) });
  }
  const ids = [...personaIds];
  const personaRows = [];
  for (let i = 0; i < ids.length; i += 500) personaRows.push(...db.select().from(personas).where(inArray(personas.id, ids.slice(i, i + 500))).all());
  entries.push({ name: "personas-export/personas.json", data: json(personaRows) });
  const files: Array<{ name: string; data: Buffer; mtime: Date }> = [];
  for (const d of FILE_DIRS) filesOf(join(accountDir, d), accountDir, files);
  entries.push(...files);
  const counts = { projects: projectRows.length, studies: studyRows.length, responses: responseCount, personas: personaRows.length, files: files.length };
  entries.unshift({ name: "personas-export/manifest.json", data: json({ format: "personas-export/1", exportedAt: new Date().toISOString(), account: { id: user.id, email: user.email }, counts }) });
  return { archive: tarGz(entries), counts };
}
