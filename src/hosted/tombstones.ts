import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isSupabaseUserId } from "../auth/supabase-jwt";

/**
 * Comptes supprimés (« pierres tombales ») du service hébergé.
 *
 * Le cookie de session est le JWT de Supabase lui-même, et l'utilisateur Supabase n'est pas supprimé par
 * `DELETE /api/me` (le service n'a pas de clé d'administration Supabase). Sans cette liste, un jeton encore valide
 * (ancien cookie rejoué, client `Authorization: Bearer`) ou un nouveau lien magique recréerait aussitôt un compte vide.
 *
 * Règle (décision de l'opérateur, 2026-10-24) : le refus est DÉFINITIF, sans limite de durée. Chaque suppression
 * enregistre deux empreintes SHA-256 :
 * - celle de l'identifiant Supabase (`sub`, en minuscules) : même utilisateur Supabase, quel que soit le jeton ;
 * - celle de l'adresse e-mail (en minuscules, sans espaces) : couvre un nouvel utilisateur Supabase créé avec la
 *   même adresse (l'opérateur l'a supprimé puis réinvité, ou un autre mode de connexion).
 * Toute session dont le `sub` ou l'e-mail correspond est refusée (403 `account_deleted`, cookies effacés) et aucun
 * dossier n'est recréé. La liste ne contient aucune donnée en clair : empreintes et jour de suppression seulement
 * (les données du compte, elles, sont purgées entièrement).
 *
 * Réactivation : seulement par l'opérateur, sur demande écrite de l'utilisateur :
 * `personas hosted reactivate <e-mail>` (src/cli/hosted-reactivate.ts), qui retire l'entrée de cette adresse
 * (empreintes de l'adresse et du `sub` associé). Le serveur relit le fichier dès qu'il change : pas de redémarrage.
 *
 * Fichier : `<HOSTED_DATA_ROOT>/_system/deleted-accounts.json` (mode 600), écrit de façon atomique (fichier
 * temporaire puis renommage). Un fichier illisible fait refuser le démarrage : jamais de recréation silencieuse.
 * L'ancien format (version 1 : `sub` en clair et date, conservation de 8 jours) est converti au chargement : les
 * identifiants sont remplacés par leur empreinte, et les entrées deviennent définitives.
 */

export const TOMBSTONES_FILE = "deleted-accounts.json";

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const HEX64 = /^[0-9a-f]{64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Forme normalisée d'une adresse e-mail (comparaison insensible à la casse). */
export const normalizeEmail = (email: string): string => email.trim().toLowerCase();
/** Empreinte SHA-256 d'une adresse e-mail normalisée. */
export const emailFingerprint = (email: string): string => sha256(normalizeEmail(email));
/** Empreinte SHA-256 d'un identifiant Supabase (`sub`, en minuscules). */
export const subFingerprint = (sub: string): string => sha256(sub.trim().toLowerCase());

export interface TombstoneEntry {
  /** SHA-256 du `sub`. */
  sub: string;
  /** SHA-256 de l'e-mail, ou null si le jeton n'en portait pas. */
  email: string | null;
  /** Jour de la suppression (AAAA-MM-JJ, UTC). */
  deletedOn: string;
}

interface TombstoneFileV2 {
  version: 2;
  accounts: TombstoneEntry[];
}

/** Identité d'une session (src/auth/supabase-jwt.ts, SessionUser). */
export interface DeletedIdentity {
  id: string;
  email: string | null;
}

export interface TombstoneOptions {
  file: string;
  now?: () => number;
}

const invalid = () => new Error(`Liste des comptes supprimés invalide (${TOMBSTONES_FILE}) : démarrage refusé.`);

/** Lit et valide le fichier (les deux formats) ; `migrated` : ancien format converti, à réécrire. */
function readTombstoneFile(file: string): { entries: TombstoneEntry[]; migrated: boolean } {
  if (!existsSync(file)) return { entries: [], migrated: false };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`Liste des comptes supprimés illisible (${TOMBSTONES_FILE}) : démarrage refusé.`);
  }
  const r = raw as { version?: unknown; accounts?: unknown };
  if (r?.version === 1) {
    // Ancien format : { accounts: { <sub en clair>: { deletedAt } } }
    if (typeof r.accounts !== "object" || r.accounts === null || Array.isArray(r.accounts)) throw invalid();
    const entries: TombstoneEntry[] = [];
    for (const [id, v] of Object.entries(r.accounts as Record<string, { deletedAt?: unknown }>)) {
      const t = Date.parse(typeof v?.deletedAt === "string" ? v.deletedAt : "");
      if (!isSupabaseUserId(id) || !Number.isFinite(t)) throw invalid();
      entries.push({ sub: subFingerprint(id), email: null, deletedOn: new Date(t).toISOString().slice(0, 10) });
    }
    return { entries, migrated: true };
  }
  if (r?.version !== 2 || !Array.isArray(r.accounts)) throw invalid();
  const entries: TombstoneEntry[] = [];
  for (const e of r.accounts as Array<Partial<TombstoneEntry>>) {
    if (typeof e?.sub !== "string" || !HEX64.test(e.sub)) throw invalid();
    if (e.email !== null && (typeof e.email !== "string" || !HEX64.test(e.email))) throw invalid();
    if (typeof e.deletedOn !== "string" || !DAY.test(e.deletedOn)) throw invalid();
    entries.push({ sub: e.sub, email: e.email, deletedOn: e.deletedOn });
  }
  return { entries, migrated: false };
}

function writeTombstoneFile(file: string, entries: TombstoneEntry[]): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 2, accounts: entries } satisfies TombstoneFileV2, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    // système de fichiers sans droits POSIX
  }
}

/** Fichier de la liste dans le dossier des comptes (`HOSTED_DATA_ROOT`). */
export const tombstonesFileOf = (dataRoot: string): string => join(dataRoot, "_system", TOMBSTONES_FILE);

export class Tombstones {
  private entries: TombstoneEntry[] = [];
  private subs = new Set<string>();
  private emails = new Set<string>();
  /** Signature du fichier lu (date de modification et taille), pour relire après une réactivation. */
  private stamp = "";
  private readonly now: () => number;

  constructor(private readonly opts: TombstoneOptions) {
    this.now = opts.now ?? Date.now;
    const { entries, migrated } = readTombstoneFile(opts.file);
    this.set(entries);
    // Ancien format : plus aucun identifiant en clair sur le disque
    if (migrated) this.save();
    else this.stamp = this.stampOf();
  }

  private stampOf(): string {
    try {
      const s = statSync(this.opts.file);
      return `${s.mtimeMs}:${s.size}:${s.ino}`;
    } catch {
      return "";
    }
  }

  private set(entries: TombstoneEntry[]): void {
    this.entries = entries;
    this.subs = new Set(entries.map((e) => e.sub));
    this.emails = new Set(entries.flatMap((e) => (e.email ? [e.email] : [])));
  }

  /**
   * Relit le fichier s'il a changé (réactivation par l'opérateur pendant que le serveur tourne). Un fichier devenu
   * illisible garde la liste en mémoire : on ne réactive jamais un compte par erreur de lecture.
   */
  private refresh(): void {
    const stamp = this.stampOf();
    if (stamp === this.stamp) return;
    try {
      this.set(readTombstoneFile(this.opts.file).entries);
      this.stamp = stamp;
    } catch {
      // liste précédente conservée
    }
  }

  private save(): void {
    writeTombstoneFile(this.opts.file, this.entries);
    this.stamp = this.stampOf();
  }

  /** Enregistre la suppression d'un compte (avant la purge de son dossier). Définitif, sauf réactivation. */
  add(user: DeletedIdentity): void {
    this.refresh();
    const sub = subFingerprint(user.id);
    const email = user.email ? emailFingerprint(user.email) : null;
    if (this.entries.some((e) => e.sub === sub && e.email === email)) return;
    this.set([...this.entries, { sub, email, deletedOn: new Date(this.now()).toISOString().slice(0, 10) }]);
    this.save();
  }

  /** Vrai si l'identifiant Supabase ou l'adresse e-mail de la session appartient à un compte supprimé. */
  isDeleted(user: DeletedIdentity): boolean {
    this.refresh();
    if (this.subs.has(subFingerprint(user.id))) return true;
    return !!user.email && this.emails.has(emailFingerprint(user.email));
  }

  /** Nombre d'entrées (diagnostic, tests). */
  get size(): number {
    return this.entries.length;
  }
}

/**
 * Réactivation par l'opérateur : retire de la liste les entrées de cette adresse e-mail (ou de cet identifiant
 * Supabase), avec le `sub` associé. Renvoie le nombre d'entrées retirées ; le fichier n'est réécrit que si besoin.
 */
export function reactivateAccount(file: string, emailOrSub: string): number {
  const value = emailOrSub.trim();
  if (!value) throw new Error("Adresse e-mail (ou identifiant Supabase) requise.");
  const { entries } = readTombstoneFile(file);
  const byEmail = value.includes("@");
  if (!byEmail && !isSupabaseUserId(value)) throw new Error(`« ${value} » n'est ni une adresse e-mail ni un identifiant Supabase (UUID).`);
  const fp = byEmail ? emailFingerprint(value) : subFingerprint(value);
  const kept = entries.filter((e) => (byEmail ? e.email !== fp : e.sub !== fp));
  // Un même `sub` peut figurer avec une autre adresse (changement d'e-mail) : retiré aussi
  const subs = new Set(entries.filter((e) => !kept.includes(e)).map((e) => e.sub));
  const out = kept.filter((e) => !subs.has(e.sub));
  const removed = entries.length - out.length;
  if (removed) writeTombstoneFile(file, out);
  return removed;
}
