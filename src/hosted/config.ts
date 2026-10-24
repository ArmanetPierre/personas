import { resolve } from "node:path";
import { z } from "zod";
import { parseMasterKey } from "./crypto";

/**
 * Configuration du service hébergé (variables d'environnement, voir hosted/.env.example). Aucune valeur secrète
 * n'a de défaut : sans HOSTED_MASTER_KEY, Supabase ni HOSTED_ALLOWED_ORIGINS, le serveur refuse de démarrer.
 */

const int = (fallback: number, max = 1_000_000) => z.coerce.number().int().positive().max(max).default(fallback);
const usd = (fallback: number) => z.coerce.number().positive().max(100_000).default(fallback);
const list = z
  .string()
  .default("")
  .transform((v) =>
    v
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  );
const bool = (fallback: boolean) =>
  z
    .enum(["true", "false", "1", "0", "yes", "no"])
    .optional()
    .transform((v) => (v === undefined ? fallback : ["true", "1", "yes"].includes(v)));

const schema = z.object({
  HOSTED_DATA_ROOT: z.string().min(1),
  HOSTED_MASTER_KEY: z.string().min(1),
  SUPABASE_URL: z.url().optional(),
  SUPABASE_JWT_SECRET: z.string().min(16).optional(),
  SUPABASE_JWKS_URL: z.url().optional(),
  SUPABASE_JWT_ISSUER: z.string().optional(),
  SUPABASE_JWT_AUDIENCE: z.string().default("authenticated"),
  /** Clé publique (anon) de Supabase, exposée au navigateur pour la connexion (ce n'est pas un secret). */
  SUPABASE_ANON_KEY: z.string().optional(),
  /** Connexion GitHub activée sur le Supabase (affichage du bouton sur la page de connexion). */
  HOSTED_GITHUB_ENABLED: bool(false),
  PORT: int(8081, 65_535),
  HOST: z.string().default("0.0.0.0"),
  /** Origines admises pour les requêtes modifiantes et l'ouverture de session (adresse publique du service, en https). Obligatoire. */
  HOSTED_ALLOWED_ORIGINS: list,
  /** Cookie `Secure` (désactivable seulement pour un essai en HTTP local). */
  HOSTED_COOKIE_SECURE: bool(true),
  /** Derrière un reverse proxy : adresse du client lue dans X-Forwarded-For (limitation de débit avant connexion). */
  TRUST_PROXY: bool(false),
  HOSTED_CONCURRENCY: int(4, 64),
  HOSTED_ACCOUNT_CONCURRENCY: int(1, 8),
  HOSTED_DEFAULT_PER_STUDY_USD: usd(5),
  HOSTED_DEFAULT_MONTHLY_USD: usd(20),
  HOSTED_MAX_MONTHLY_USD: usd(100),
  HOSTED_MAX_PROJECTS: int(50),
  HOSTED_MAX_STUDIES: int(200),
  HOSTED_MAX_BODY_BYTES: int(1_048_576, 50_000_000),
  /** Requêtes par minute et par compte (et par adresse avant connexion). */
  HOSTED_RATE_PER_MINUTE: int(300),
  /** Fermeture des bases inactives (ms). */
  HOSTED_IDLE_MS: int(10 * 60_000),
});

export interface HostedConfig {
  dataRoot: string;
  masterKey: Buffer;
  auth: { supabaseUrl?: string; jwtSecret?: string; jwksUrl?: string; issuer?: string; audience: string };
  /** Exposé par GET /api/meta pour la page de connexion. */
  publicAuth: { supabaseUrl: string | null; anonKey: string | null; githubEnabled: boolean };
  port: number;
  host: string;
  allowedOrigins: string[];
  cookieSecure: boolean;
  trustProxy: boolean;
  concurrency: number;
  accountConcurrency: number;
  defaultPerStudyUsd: number;
  defaultMonthlyUsd: number;
  maxMonthlyUsd: number;
  maxProjects: number;
  maxStudies: number;
  maxBodyBytes: number;
  ratePerMinute: number;
  idleMs: number;
}

export function loadHostedConfig(env: NodeJS.ProcessEnv = process.env): HostedConfig {
  const raw = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ""));
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    // Jamais la valeur d'une variable dans le message (clé maître, secret JWT)
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")} : ${i.message}`).join(" ; ");
    throw new Error(`Configuration du service hébergé invalide : ${issues}`);
  }
  const v = parsed.data;
  if (!v.SUPABASE_URL && !v.SUPABASE_JWKS_URL) throw new Error("Configuration du service hébergé invalide : SUPABASE_URL (ou SUPABASE_JWKS_URL et SUPABASE_JWT_ISSUER) requis.");
  if (!v.SUPABASE_URL && !v.SUPABASE_JWT_ISSUER) throw new Error("Configuration du service hébergé invalide : SUPABASE_JWT_ISSUER requis sans SUPABASE_URL.");
  // Origines admises : obligatoires (sans elles, le contrôle d'origine des écritures et de POST /api/session serait
  // inopérant). Chaque valeur est une origine exacte : schéma http(s), hôte, port facultatif, sans chemin.
  const origins = v.HOSTED_ALLOWED_ORIGINS.map((o) => o.replace(/\/+$/, ""));
  if (!origins.length) {
    throw new Error(
      "Configuration du service hébergé invalide : HOSTED_ALLOWED_ORIGINS requis (adresse publique du service, par ex. https://app.example.org ; plusieurs origines séparées par des virgules). Démarrage refusé.",
    );
  }
  const badOrigin = origins.find((o) => {
    try {
      const u = new URL(o);
      return !/^https?:$/.test(u.protocol) || u.origin !== o;
    } catch {
      return true;
    }
  });
  if (badOrigin !== undefined) throw new Error(`Configuration du service hébergé invalide : HOSTED_ALLOWED_ORIGINS contient « ${badOrigin} », qui n'est pas une origine (attendu : https://hôte[:port], sans chemin).`);
  return {
    dataRoot: resolve(v.HOSTED_DATA_ROOT),
    masterKey: parseMasterKey(v.HOSTED_MASTER_KEY),
    auth: {
      ...(v.SUPABASE_URL && { supabaseUrl: v.SUPABASE_URL }),
      ...(v.SUPABASE_JWT_SECRET && { jwtSecret: v.SUPABASE_JWT_SECRET }),
      ...(v.SUPABASE_JWKS_URL && { jwksUrl: v.SUPABASE_JWKS_URL }),
      ...(v.SUPABASE_JWT_ISSUER && { issuer: v.SUPABASE_JWT_ISSUER }),
      audience: v.SUPABASE_JWT_AUDIENCE,
    },
    publicAuth: { supabaseUrl: v.SUPABASE_URL?.replace(/\/+$/, "") ?? null, anonKey: v.SUPABASE_ANON_KEY ?? null, githubEnabled: v.HOSTED_GITHUB_ENABLED },
    port: v.PORT,
    host: v.HOST,
    allowedOrigins: origins,
    cookieSecure: v.HOSTED_COOKIE_SECURE,
    trustProxy: v.TRUST_PROXY,
    concurrency: v.HOSTED_CONCURRENCY,
    accountConcurrency: v.HOSTED_ACCOUNT_CONCURRENCY,
    defaultPerStudyUsd: Math.min(v.HOSTED_DEFAULT_PER_STUDY_USD, v.HOSTED_MAX_MONTHLY_USD),
    defaultMonthlyUsd: Math.min(v.HOSTED_DEFAULT_MONTHLY_USD, v.HOSTED_MAX_MONTHLY_USD),
    maxMonthlyUsd: v.HOSTED_MAX_MONTHLY_USD,
    maxProjects: v.HOSTED_MAX_PROJECTS,
    maxStudies: v.HOSTED_MAX_STUDIES,
    maxBodyBytes: v.HOSTED_MAX_BODY_BYTES,
    ratePerMinute: v.HOSTED_RATE_PER_MINUTE,
    idleMs: v.HOSTED_IDLE_MS,
  };
}
