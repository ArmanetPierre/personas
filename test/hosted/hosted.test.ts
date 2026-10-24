import { createHash, randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { gunzipSync } from "node:zlib";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config";
import { createBackendFromProfile } from "../../src/engine";
import { HostedProviderError } from "../../src/engine/profiles";
import { createHostedServer, type HostedServer } from "../../src/hosted/app";
import { readPayload } from "../../src/hosted/child";
import { loadHostedConfig, type HostedConfig } from "../../src/hosted/config";
import { openSecret, sealSecret } from "../../src/hosted/crypto";
import { decryptEngineKey, KEY_FILE } from "../../src/hosted/engine-key";
import { JobQueue, type ChildHandle, type HostedSpawnFn } from "../../src/hosted/queue";
import { routePolicy } from "../../src/hosted/policy";
import { MAX_TOKEN_LIFETIME_S } from "../../src/hosted/session";
import { emailFingerprint, reactivateAccount, subFingerprint, TOMBSTONES_FILE } from "../../src/hosted/tombstones";
import type { SpawnOptions } from "node:child_process";

/**
 * Service hébergé (src/hosted/) : authentification (JWT signés en local, JWKS de test), isolation des comptes,
 * refus des moteurs locaux, chiffrement de la clé, file de travail, suppression et export du compte.
 * Moteur simulé, aucun appel LLM, aucun serveur distant (fetch du test de clé simulé, enfants simulés).
 */

process.env.PERSONAS_MODE = "hosted";
const SUPABASE = "https://supabase.example.test";
/** Adresse de test (assemblée : le contrôle de l'export refuse les adresses littérales). */
const mail = (local: string, domain = "example.test") => `${local}@${domain}`;
const GOOD_KEY = "key-TESTSECRET-abcdefghijklmnop-9876";
const OTHER_KEY = "key-OTHERSECRET-zyxwvutsrqponm-5432";
const SERVER_ENV_SECRET = "server-master-key-in-env";

// ── Faux enfants : arguments, environnement et entrée standard enregistrés ──
interface FakeChild extends ChildHandle {
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdinText: string;
  killed: boolean;
  exit(code: number): void;
}
const children: FakeChild[] = [];
let pid = 50_000;
const spawnFn: HostedSpawnFn = (_cmd: string, args: string[], opts: SpawnOptions) => {
  const ev = new EventEmitter();
  let text = "";
  const stdin = new Writable({
    write(chunk, _enc, cb) {
      text += String(chunk);
      cb();
    },
  });
  const child: FakeChild = {
    pid: pid++,
    args,
    env: opts.env ?? {},
    cwd: String(opts.cwd),
    get stdinText() {
      return text;
    },
    killed: false,
    stdin,
    once: (event, listener) => ev.once(event, listener),
    kill() {
      child.killed = true;
      setImmediate(() => ev.emit("exit", null, "SIGTERM"));
      return true;
    },
    exit(code) {
      ev.emit("exit", code, null);
    },
  };
  children.push(child);
  return child;
};

/** Faux fournisseur : la fiche du modèle répond 200 pour la bonne clé, 401 sinon. */
const fakeFetch: typeof fetch = async (input, init) => {
  const headers = new Headers(init?.headers);
  const key = headers.get("x-api-key") ?? headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!String(input).includes("/v1/models/")) return new Response("{}", { status: 404 });
  if (key === GOOD_KEY || key === OTHER_KEY) return Response.json({ id: "claude-haiku-4-5", type: "model" });
  return Response.json({ error: { type: "authentication_error", message: `invalid x-api-key ${key}` } }, { status: 401 });
};

let privateKey: CryptoKey;
let foreignKey: CryptoKey;
let jwks: { keys: Array<Record<string, unknown>> };
const root = mkdtempSync(join(tmpdir(), "personas-hosted-"));
const logs: string[] = [];
const masterKey = randomBytes(32).toString("base64");

function hostedConfig(over: Record<string, string> = {}, dir = root): HostedConfig {
  return loadHostedConfig({ HOSTED_DATA_ROOT: dir, HOSTED_MASTER_KEY: masterKey, SUPABASE_URL: SUPABASE, HOSTED_ALLOWED_ORIGINS: "https://app.example.test", HOSTED_CONCURRENCY: "2", HOSTED_ACCOUNT_CONCURRENCY: "1", ...over });
}

async function token(sub: string, over: { exp?: number; role?: string; anonymous?: boolean; key?: CryptoKey; iss?: string; email?: string | null } = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const email = over.email === undefined ? `${sub.slice(0, 4)}@example.test` : over.email;
  return new SignJWT({ ...(email !== null && { email }), role: over.role ?? "authenticated", ...(over.anonymous && { is_anonymous: true }) })
    .setProtectedHeader({ alg: "ES256", kid: "test-key" })
    .setSubject(sub)
    .setIssuer(over.iss ?? `${SUPABASE}/auth/v1`)
    .setAudience("authenticated")
    .setIssuedAt(now - 10)
    .setExpirationTime(over.exp ?? now + 3600)
    .sign(over.key ?? privateKey);
}

let server: HostedServer;
const A = randomUUID();
const B = randomUUID();
let tokA = "";
let tokB = "";

type Res = { status: number; body: any; headers: Headers };
async function call(method: string, path: string, opts: { token?: string; json?: unknown; raw?: { body: string; type?: string }; headers?: Record<string, string>; srv?: HostedServer } = {}): Promise<Res> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.json !== undefined) headers["content-type"] ??= "application/json";
  if (opts.raw?.type) headers["content-type"] = opts.raw.type;
  const withBody = opts.json !== undefined && method !== "GET";
  const payload = opts.raw ? opts.raw.body : withBody ? JSON.stringify(opts.json) : undefined;
  const res = await (opts.srv ?? server).app.request(path, { method, headers, ...(payload !== undefined && { body: payload }) });
  const type = res.headers.get("content-type") ?? "";
  const body = type.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, body, headers: res.headers };
}

const mealPlanner = () => ({ ...JSON.parse(readFileSync("examples/meal-planner.json", "utf8")), target: { socle: "fr", eligibility: "age >= 25 and age <= 50", n: 5 } });

/** Tous les fichiers d'un dossier (y compris la base SQLite), pour y chercher une clé en clair. */
function allBytes(dir: string): Buffer {
  const out: Buffer[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (statSync(p).isFile()) out.push(readFileSync(p));
    }
  };
  if (existsSync(dir)) walk(dir);
  return Buffer.concat(out);
}

beforeAll(async () => {
  const kp = await generateKeyPair("ES256", { extractable: true });
  privateKey = kp.privateKey;
  foreignKey = (await generateKeyPair("ES256")).privateKey;
  jwks = { keys: [{ ...(await exportJWK(kp.publicKey)), kid: "test-key", alg: "ES256", use: "sig" }] };
  server = createHostedServer({ config: hostedConfig(), jwks: jwks as never, fetch: fakeFetch, spawnFn, log: (l) => logs.push(l), env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "anthropic-leak-value", HOSTED_MASTER_KEY: SERVER_ENV_SECRET, SUPABASE_JWT_SECRET: "x".repeat(32) }, webDist: null });
  tokA = await token(A);
  tokB = await token(B);
});

afterAll(() => {
  server.close();
  rmSync(root, { recursive: true, force: true });
});

describe("authentification", () => {
  it("refuse toute route sans session, avec un jeton d'une autre clé, expiré, anonyme ou d'un autre émetteur", async () => {
    expect((await call("GET", "/api/projects")).status).toBe(401);
    expect((await call("GET", "/api/projects", { token: "pas-un-jwt" })).status).toBe(401);
    expect((await call("GET", "/api/projects", { token: await token(A, { key: foreignKey }) })).status).toBe(401);
    expect((await call("GET", "/api/projects", { token: await token(A, { exp: Math.floor(Date.now() / 1000) - 120 }) })).status).toBe(401);
    expect((await call("GET", "/api/projects", { token: await token(A, { anonymous: true }) })).status).toBe(401);
    expect((await call("GET", "/api/projects", { token: await token(A, { role: "anon" }) })).status).toBe(401);
    expect((await call("GET", "/api/projects", { token: await token(A, { iss: "https://ailleurs.test/auth/v1" }) })).status).toBe(401);
    expect((await call("GET", "/api/me", { token: await token("pas-un-uuid") })).status).toBe(401);
    // Durée de vie bornée au plafond de Supabase (une semaine)
    const now = Math.floor(Date.now() / 1000);
    expect((await call("GET", "/api/projects", { token: await token(A, { exp: now - 10 + MAX_TOKEN_LIFETIME_S + 3600 }) })).status).toBe(401);
    expect((await call("POST", "/api/session", { json: { accessToken: await token(A, { exp: now - 10 + MAX_TOKEN_LIFETIME_S + 3600 }) } })).status).toBe(401);
    expect((await call("GET", "/api/projects", { token: await token(A, { exp: now - 10 + MAX_TOKEN_LIFETIME_S }) })).status).toBe(200);
    const ok = await call("GET", "/api/projects", { token: tokA });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual([]);
  });

  it("méta publique avant connexion, complète après (mode hosted, fonctions locales absentes)", async () => {
    const pub = await call("GET", "/api/meta");
    expect(pub.status).toBe(200);
    expect(pub.body).toMatchObject({ mode: "hosted", authenticated: false, supabaseUrl: SUPABASE, supabaseAnonKey: null, githubEnabled: false });
    expect(pub.body.features).toEqual(expect.arrayContaining(["account", "engine.key", "export", "studies"]));
    expect(pub.body.behaviors).toBeUndefined();
    const full = await call("GET", "/api/meta", { token: tokA });
    expect(full.body).toMatchObject({ mode: "hosted", authenticated: true, backends: [] });
    expect(full.body.behaviors.length).toBeGreaterThan(0);
    for (const f of ["setup", "engine.local", "triage", "modules.assistant", "hub.publish", "telemetry"]) expect(full.body.features).not.toContain(f);
    expect(full.body.profiles.map((p: { name: string }) => p.name)).not.toContain("claude-cli");
  });

  it("session par cookie httpOnly : CSRF exigé pour les requêtes modifiantes", async () => {
    const s = await call("POST", "/api/session", { token: tokA, json: {} });
    expect(s.status).toBe(200);
    const cookies = s.headers.getSetCookie();
    const session = cookies.find((c) => c.startsWith("__Host-personas_session="))!;
    const csrf = cookies.find((c) => c.startsWith("__Host-personas_csrf="))!;
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/Secure/i);
    expect(session).toMatch(/SameSite=Lax/i);
    expect(csrf).not.toMatch(/HttpOnly/i);
    const jar = [session, csrf].map((c) => c.split(";")[0]).join("; ");
    expect(s.body.csrfToken).toBe(csrf.split(";")[0]!.split("=")[1]);
    // Lecture par cookie seul
    const me = await call("GET", "/api/me", { headers: { cookie: jar } });
    expect(me.body.user.id).toBe(A);
    expect(me.body.email).toBe(`${A.slice(0, 4)}@example.test`);
    expect(typeof me.body.createdAt).toBe("string");
    // Jeton dans le corps ({ accessToken }) ; compte non invité (anonyme) : 403
    expect((await call("POST", "/api/session", { json: { accessToken: tokA } })).status).toBe(200);
    expect((await call("POST", "/api/session", { json: { accessToken: await token(A, { anonymous: true }) } })).status).toBe(403);
    expect((await call("POST", "/api/session", { json: { accessToken: "x".repeat(40) } })).status).toBe(401);
    // Écriture par cookie : sans jeton CSRF, refusée ; inter-sites, refusée ; avec, acceptée
    const engine = { provider: "anthropic", model: "claude-haiku-4-5", apiKey: GOOD_KEY };
    expect((await call("POST", "/api/me/engine", { headers: { cookie: jar }, json: engine })).status).toBe(403);
    expect((await call("POST", "/api/me/engine", { headers: { cookie: jar, "x-csrf-token": "faux" }, json: engine })).status).toBe(403);
    expect((await call("POST", "/api/me/engine", { headers: { cookie: jar, "x-csrf-token": s.body.csrfToken, "sec-fetch-site": "cross-site" }, json: engine })).status).toBe(403);
    expect((await call("POST", "/api/me/engine", { headers: { cookie: jar, "x-csrf-token": s.body.csrfToken }, json: engine })).status).toBe(200);
    // Aucun endpoint d'inscription ; la déconnexion efface les cookies
    expect((await call("POST", "/api/signup", { json: {} })).status).toBe(401);
    const out = await call("DELETE", "/api/session", { headers: { cookie: jar } });
    expect(out.headers.getSetCookie().join(";")).toMatch(/__Host-personas_session=;/);
  });
});

describe("ouverture et fermeture de session (origine, type de contenu)", () => {
  const ORIGIN = "https://app.example.test";
  let srv: HostedServer;
  const dir = mkdtempSync(join(tmpdir(), "personas-hosted-sess-"));
  beforeAll(() => {
    srv = createHostedServer({ config: hostedConfig({ HOSTED_ALLOWED_ORIGINS: `${ORIGIN}/` }, dir), jwks: jwks as never, fetch: fakeFetch, spawnFn, log: () => {}, webDist: null });
  });
  afterAll(() => {
    srv.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const noSession = (r: Res) => expect(r.headers.getSetCookie().join(";")).not.toMatch(/__Host-personas_session=[^;]/);

  it("POST /api/session : origine étrangère ou inter-sites → 403, sans cookie", async () => {
    for (const headers of [{ origin: "https://evil.example" }, { origin: "https://app.example.test.evil.example" }, { "sec-fetch-site": "cross-site" }] as Record<string, string>[]) {
      const r = await call("POST", "/api/session", { srv, json: { accessToken: tokA }, headers });
      expect(r.status, JSON.stringify(headers)).toBe(403);
      expect(r.body.code).toBe("csrf");
      noSession(r);
    }
  });

  it("POST /api/session : corps text/plain, formulaire ou sans type → 415, sans cookie", async () => {
    for (const type of ["text/plain", "text/plain;charset=UTF-8", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"]) {
      const r = await call("POST", "/api/session", { srv, raw: { body: JSON.stringify({ accessToken: tokA }), type }, headers: { origin: ORIGIN } });
      expect(r.status, type).toBe(415);
      expect(r.body.code).toBe("unsupported_media_type");
      noSession(r);
    }
    // Jeton dans l'en-tête, sans corps ni type : refusé aussi (règle unique : JSON obligatoire)
    const bare = await call("POST", "/api/session", { srv, token: tokA });
    expect(bare.status).toBe(415);
    noSession(bare);
  });

  it("POST /api/session : cas nominal (origine admise, JSON) ; sans Origin, même règle que les autres écritures", async () => {
    const ok = await call("POST", "/api/session", { srv, json: { accessToken: tokA }, headers: { origin: ORIGIN, "content-type": "application/json; charset=utf-8" } });
    expect(ok.status).toBe(200);
    expect(ok.headers.getSetCookie().some((c) => c.startsWith("__Host-personas_session="))).toBe(true);
    // Sans Origin (client non navigateur ; un navigateur envoie toujours Origin sur un POST) : accepté, comme les
    // autres requêtes modifiantes
    expect((await call("POST", "/api/session", { srv, json: { accessToken: tokA } })).status).toBe(200);
    expect((await call("POST", "/api/session", { srv, token: tokA, json: {} })).status).toBe(200);
  });

  it("DELETE /api/session : origine étrangère → 403 ; admise ou absente → cookies effacés", async () => {
    const bad = await call("DELETE", "/api/session", { srv, headers: { origin: "https://evil.example" } });
    expect(bad.status).toBe(403);
    expect(bad.headers.getSetCookie()).toEqual([]);
    expect((await call("DELETE", "/api/session", { srv, headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
    for (const headers of [{ origin: ORIGIN }, {}] as Record<string, string>[]) {
      const out = await call("DELETE", "/api/session", { srv, headers });
      expect(out.status).toBe(200);
      expect(out.headers.getSetCookie().join(";")).toMatch(/__Host-personas_session=;.*Max-Age=0/);
    }
  });
});

describe("clé IA de l'utilisateur", () => {
  it("teste, chiffre et range la clé ; jamais en clair (base, fichiers, réponses, journaux)", async () => {
    const bad = await call("POST", "/api/me/engine", { token: tokB, json: { provider: "anthropic", model: "claude-haiku-4-5", apiKey: "key-MAUVAISE-0000000000" } });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).not.toContain("MAUVAISE");
    const none = await call("GET", "/api/me/engine", { token: tokB });
    expect(none.status).toBe(404);
    expect(none.body.engine).toBeNull();

    const r = await call("POST", "/api/me/engine", { token: tokA, json: { provider: "anthropic", model: "claude-haiku-4-5", apiKey: GOOD_KEY, limits: { perStudyUsd: 3, perMonthUsd: 15 } } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, provider: "anthropic", model: "claude-haiku-4-5", last4: "9876", limits: { perStudyUsd: 3, perMonthUsd: 15 } });
    const g = await call("GET", "/api/me/engine", { token: tokA });
    expect(g.body).toMatchObject({ configured: true, provider: "anthropic", last4: "9876", engine: { provider: "anthropic", model: "claude-haiku-4-5", last4: "9876" } });
    for (const res of [r, g, await call("GET", "/api/me", { token: tokA })]) expect(JSON.stringify(res.body)).not.toContain(GOOD_KEY);

    const dirA = server.pool.dirOf(A);
    const sealed = JSON.parse(readFileSync(join(dirA, KEY_FILE), "utf8"));
    expect(sealed.sealed).toMatchObject({ alg: "aes-256-gcm" });
    expect((statSync(join(dirA, KEY_FILE)).mode & 0o777).toString(8)).toBe("600");
    expect(allBytes(root).includes(Buffer.from(GOOD_KEY))).toBe(false);
    expect(logs.join("\n")).not.toContain(GOOD_KEY);
    expect(decryptEngineKey(dirA, A, Buffer.from(masterKey, "base64"))?.apiKey).toBe(GOOD_KEY);
    // AAD : un enregistrement ne se déchiffre ni pour un autre compte, ni pour un autre fournisseur
    expect(() => openSecret(Buffer.from(masterKey, "base64"), B, "anthropic", sealed.sealed)).toThrow(/illisible/);
    expect(() => openSecret(Buffer.from(masterKey, "base64"), A, "openai", sealed.sealed)).toThrow(/illisible/);
    const s2 = sealSecret(Buffer.from(masterKey, "base64"), A, "anthropic", GOOD_KEY);
    expect(s2.iv).not.toBe(sealed.sealed.iv);
  });

  it("plafonds : défaut 5 $/étude et 20 $/mois, plafond global du service", async () => {
    const tooHigh = await call("POST", "/api/me/engine", { token: tokB, json: { provider: "anthropic", model: "claude-haiku-4-5", apiKey: OTHER_KEY, limits: { perMonthUsd: 5000 } } });
    expect(tooHigh.status).toBe(400);
    expect(tooHigh.body.code).toBe("limit_too_high");
    const ok = await call("POST", "/api/me/engine", { token: tokB, json: { provider: "anthropic", model: "claude-haiku-4-5", apiKey: OTHER_KEY } });
    expect(ok.body.limits).toEqual({ perStudyUsd: 5, perMonthUsd: 20 });
    // Changer les plafonds sans ressaisir la clé (même fournisseur)
    const lim = await call("POST", "/api/me/engine", { token: tokB, json: { provider: "anthropic", model: "claude-haiku-4-5", perMonthUsd: 30 } });
    expect(lim.body.engine.limits).toEqual({ perStudyUsd: 5, perMonthUsd: 30 });
    const engineFile = JSON.parse(readFileSync(join(server.pool.dirOf(B), "engine.json"), "utf8"));
    expect(engineFile.profiles[0]).toMatchObject({ name: "user", provider: "anthropic", limits: { perStudyUsd: 5, perMonthUsd: 30 } });
    expect(JSON.stringify(engineFile)).not.toContain(OTHER_KEY);
  });
});

describe("moteurs et fonctions locales refusés", () => {
  it("claude-cli et ollama : refus à la création d'étude et au niveau du moteur", async () => {
    await call("POST", "/api/projects", { token: tokA, json: mealPlanner() });
    for (const body of [{ backend: "claude-cli" }, { backend: "ollama" }, { profile: "claude-cli" }, { profile: "ollama" }]) {
      const r = await call("POST", "/api/studies", { token: tokA, json: { projectId: "meal-planner", useProjectTarget: true, n: 5, ...body } });
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.error).toMatch(/refusé/);
      // Jamais le nom du moteur local refusé (A a une clé : refus du moteur demandé, pas « aucune clé »)
      expect(r.body.error).not.toMatch(/claude-cli|ollama/);
      expect(r.body.code).toBe("provider_refused");
    }
    const cfg = loadConfig({});
    expect(() => createBackendFromProfile({ name: "claude-cli", provider: "claude-cli", model: "sonnet" }, cfg)).toThrow(HostedProviderError);
    expect(() => createBackendFromProfile({ name: "ollama", provider: "ollama", model: "qwen" }, cfg)).toThrow(HostedProviderError);
    expect(() => createBackendFromProfile({ name: "x", provider: "openai-compatible", model: "m", baseUrl: "http://169.254.169.254/v1" }, cfg)).toThrow(HostedProviderError);
    expect(() => createBackendFromProfile({ name: "x", provider: "openai", model: "m", baseUrl: "http://evil.test/v1" }, cfg)).toThrow(HostedProviderError);
  });

  it("routes locales désactivées (configuration, trousseau, assistant de modules, pré-tri) ; inconnues : 404", async () => {
    for (const [m, p] of [
      ["GET", "/api/setup/status"],
      ["POST", "/api/setup/engine"],
      ["POST", "/api/modules/propose"],
      ["GET", "/api/modules/drafts/x/status"],
      ["PUT", "/api/modules/drafts/x/yaml"],
      ["POST", "/api/projects/meal-planner/target-preview/triage"],
      ["GET", "/api/hub/account"],
      ["POST", "/api/hub/publish"],
      ["POST", "/api/hub/telemetry"],
    ] as const) {
      const r = await call(m, p, { token: tokA, json: {} });
      expect(r.status, p).toBe(403);
      expect(r.body.code).toBe("hosted_disabled");
    }
    expect((await call("GET", "/api/n-existe-pas", { token: tokA })).status).toBe(404);
    expect(routePolicy("GET", "/projects/../setup/status")).not.toBe("allow");
    // Le lanceur du compte refuse tout script hors liste (aucune commande arbitraire)
    const acct = server.pool.get(A);
    expect(() => acct.ctx.launcher.startScript("x", "module:propose", [])).toThrow(/indisponible/);
    expect(() => acct.ctx.launcher.startFile("x", "src/web/jobs/target-preview.ts", [])).toThrow(/indisponible/);
    expect(() => acct.ctx.launcher.startFile("x", "/bin/sh", ["-c", "id"])).toThrow(/indisponible/);
  });
});

describe("isolation entre comptes", () => {
  let studyA = "";
  let personaA = "";

  it("le compte A crée un projet et une étude ; B ne voit rien, et ses tentatives croisées répondent 404", async () => {
    const s = await call("POST", "/api/studies", { token: tokA, json: { projectId: "meal-planner", useProjectTarget: true, n: 5 } });
    expect(s.status, JSON.stringify(s.body)).toBe(201);
    studyA = s.body.study.id;
    const detail = await call("GET", `/api/studies/${studyA}`, { token: tokA });
    personaA = (await call("GET", `/api/personas?pageSize=1`, { token: tokA })).body.items?.[0]?.id ?? (await call("GET", `/api/studies/${studyA}/responses`, { token: tokA })).body?.[0]?.personaId;
    expect(detail.status).toBe(200);

    expect((await call("GET", "/api/projects", { token: tokB })).body).toEqual([]);
    expect((await call("GET", "/api/studies", { token: tokB })).body).toEqual([]);
    for (const p of [
      "/api/projects/meal-planner",
      "/api/projects/meal-planner/overview",
      "/api/projects/meal-planner/pitch",
      "/api/projects/meal-planner/protocol",
      `/api/studies/${studyA}`,
      `/api/studies/${studyA}/progress`,
      `/api/studies/${studyA}/summary`,
      `/api/studies/${studyA}/responses`,
      `/api/studies/${studyA}/log`,
      `/api/studies/${studyA}/estimate`,
      `/api/studies/${studyA}/recommendations`,
      `/api/compare?ids=${studyA},${studyA}`,
    ]) {
      expect((await call("GET", p, { token: tokB })).status, p).toBe(404);
    }
    if (personaA) expect((await call("GET", `/api/personas/${personaA}`, { token: tokB })).status).toBe(404);
    expect((await call("POST", `/api/studies/${studyA}/run`, { token: tokB, json: {} })).status).toBe(404);
    expect((await call("POST", `/api/studies/${studyA}/recommendations`, { token: tokB, json: {} })).status).toBe(404);
    expect((await call("PUT", "/api/projects/meal-planner/pitch", { token: tokB, json: { pitch: "x".repeat(40), confirm: true } })).status).toBe(404);
    expect((await call("GET", `/api/jobs/${studyA}`, { token: tokB })).body.pid).toBeNull();
    // B peut avoir un projet de même id, distinct de celui de A
    const mine = await call("POST", "/api/projects", { token: tokB, json: { ...mealPlanner(), name: "Projet de B" } });
    expect(mine.status).toBe(201);
    expect((await call("GET", "/api/projects/meal-planner", { token: tokA })).body.project.name).not.toBe("Projet de B");
    // Dossiers et bases séparés
    expect(server.pool.dirOf(A)).not.toBe(server.pool.dirOf(B));
    expect(existsSync(join(server.pool.dirOf(A), "personas.db"))).toBe(true);
    expect(existsSync(join(server.pool.dirOf(B), "personas.db"))).toBe(true);
  });

  it("lancement d'une étude : file de travail, clé par l'entrée standard, environnement minimal", async () => {
    const before = children.length;
    const r = await call("POST", `/api/studies/${studyA}/run`, { token: tokA, json: {} });
    expect(r.status).toBe(202);
    expect(children.length).toBe(before + 1);
    const child = children.at(-1)!;
    expect(child.args.some((a) => a.endsWith("/src/hosted/child.ts") && a.startsWith("/"))).toBe(true);
    expect(child.args.slice(-3)).toEqual(["src/cli/study-run.ts", "--study", studyA]);
    expect(child.cwd).toBe(server.pool.dirOf(A));
    expect(JSON.parse(child.stdinText)).toEqual({ v: 1, profile: "user", apiKey: GOOD_KEY });
    expect(child.args.join(" ")).not.toContain(GOOD_KEY);
    expect(JSON.stringify(child.env)).not.toContain(GOOD_KEY);
    expect(JSON.stringify(child.env)).not.toContain(SERVER_ENV_SECRET);
    expect(Object.keys(child.env).filter((k) => /^ANTHROPIC_|^HOSTED_|^SUPABASE_/.test(k))).toEqual([]);
    expect(child.env).toMatchObject({ PERSONAS_MODE: "hosted", PERSONAS_DATA_DIR: server.pool.dirOf(A), PATH: "/usr/bin" });
    // Double lancement refusé ; l'état est visible dans l'API existante
    expect((await call("POST", `/api/studies/${studyA}/run`, { token: tokA, json: {} })).status).toBe(409);
    const prog = await call("GET", `/api/studies/${studyA}/progress`, { token: tokA });
    expect(prog.body.run).toMatchObject({ alive: true, queued: false });
    expect(prog.body.run.logPath).toMatch(/^logs\//);
    expect((await call("GET", "/api/me", { token: tokA })).body.jobs).toEqual([expect.objectContaining({ key: studyA, kind: "study", state: "running" })]);
    child.exit(0);
    await new Promise((r) => setImmediate(r));
    expect((await call("GET", `/api/studies/${studyA}/progress`, { token: tokA })).body.run).toMatchObject({ alive: false });
  });

  it("journaux du serveur sans contenu de projet ni identifiant", () => {
    const text = logs.join("\n");
    expect(text).toContain("POST /api/projects 201");
    expect(text).not.toContain("meal-planner");
    expect(text).not.toContain(studyA);
    expect(text).not.toContain(A);
  });

  it("export : archive tar.gz des projets et études en JSON, sans la clé", async () => {
    const r = await call("GET", "/api/me/export", { token: tokA });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/gzip");
    const tar = gunzipSync(r.body as Buffer);
    const names: string[] = [];
    for (let off = 0; off + 512 <= tar.length; ) {
      const name = tar.subarray(off, off + 100).toString("utf8").replace(/\0.*$/s, "");
      if (!name) break;
      const size = parseInt(tar.subarray(off + 124, off + 136).toString("utf8").replace(/\0.*$/s, "").trim(), 8);
      names.push(name);
      if (name.endsWith("manifest.json")) expect(JSON.parse(tar.subarray(off + 512, off + 512 + size).toString("utf8"))).toMatchObject({ format: "personas-export/1", counts: { projects: 1, studies: 1 } });
      off += 512 + Math.ceil(size / 512) * 512;
    }
    expect(names).toEqual(expect.arrayContaining(["personas-export/manifest.json", "personas-export/projects/meal-planner.json", `personas-export/studies/${studyA}.json`, "personas-export/personas.json"]));
    expect(tar.includes(Buffer.from(GOOD_KEY))).toBe(false);
    expect(tar.toString("utf8")).not.toContain("aes-256-gcm");
  });
});

describe("file de travail", () => {
  const qdir = mkdtempSync(join(tmpdir(), "personas-queue-"));
  const users = [randomUUID(), randomUUID(), randomUUID()];
  const started: FakeChild[] = [];
  const mk = () =>
    new JobQueue({
      stateFile: join(qdir, "_system", "queue.json"),
      concurrency: 2,
      perAccount: 1,
      accountDir: (u) => join(qdir, u),
      secretFor: () => ({ profile: "user", apiKey: "k-123456789" }),
      baseEnv: {},
      spawnFn: (cmd, args, opts) => {
        const c = spawnFn(cmd, args, opts) as FakeChild;
        started.push(c);
        return c;
      },
    });
  afterEach(() => void 0);
  afterAll(() => rmSync(qdir, { recursive: true, force: true }));

  it("concurrence globale et par compte, puis reprise après redémarrage", async () => {
    const q = mk();
    q.enqueue({ userId: users[0]!, key: "s1", kind: "study", file: "src/cli/study-run.ts", args: ["--study", "s1"] });
    q.enqueue({ userId: users[0]!, key: "s2", kind: "study", file: "src/cli/study-run.ts", args: ["--study", "s2"] });
    q.enqueue({ userId: users[1]!, key: "s3", kind: "study", file: "src/cli/study-run.ts", args: ["--study", "s3"] });
    q.enqueue({ userId: users[2]!, key: "s4", kind: "study", file: "src/cli/study-run.ts", args: ["--study", "s4"] });
    const running = () => q.list().filter((j) => j.state === "running").map((j) => j.key);
    // 2 au plus en tout, 1 par compte : s1 (compte 0) et s3 (compte 1) ; s2 attend s1, s4 attend une place
    expect(running()).toEqual(["s1", "s3"]);
    expect(q.position(q.find(users[0]!, "s2")!)).toBe(1);
    expect(() => q.enqueue({ userId: users[0]!, key: "s2", kind: "study", file: "src/cli/study-run.ts", args: [] })).toThrow(/déjà/);
    started[0]!.exit(0);
    expect(running().sort()).toEqual(["s2", "s3"]);
    // Redémarrage : les tâches en cours et en file sont relues, repassent en file, puis repartent
    q.close();
    const q2 = mk();
    expect(q2.list().map((j) => [j.key, j.state])).toEqual([
      ["s2", "queued"],
      ["s3", "queued"],
      ["s4", "queued"],
    ]);
    q2.pump();
    expect(q2.list().filter((j) => j.state === "running").map((j) => j.key)).toEqual(["s2", "s3"]);
    // Suppression d'un compte : ses tâches sont retirées et arrêtées
    const victim = started.at(-2)!;
    expect(q2.cancelUser(users[0]!)).toBe(1);
    expect(victim.killed).toBe(true);
    expect(q2.list().map((j) => j.key)).toEqual(["s3", "s4"]);
    q2.close();
  });

  it("l'enfant lit la clé sur l'entrée standard (charge utile validée)", async () => {
    expect(await readPayload(Readable.from([`{"v":1,"profile":"user","apiKey":"abc-123"}\n`]))).toEqual({ profile: "user", apiKey: "abc-123" });
    await expect(readPayload(Readable.from(["pas du json"]))).rejects.toThrow(/illisible/);
    await expect(readPayload(Readable.from([`{"v":1,"profile":"../x","apiKey":"a"}`]))).rejects.toThrow(/invalide/);
    await expect(readPayload(Readable.from(["x".repeat(100)]), { maxBytes: 10 })).rejects.toThrow(/trop longue/);
  });
});

describe("limites et suppression du compte", () => {
  it("taille des requêtes, quotas de projets, débit par compte", async () => {
    const dir = mkdtempSync(join(tmpdir(), "personas-hosted-lim-"));
    const srv = createHostedServer({ config: hostedConfig({ HOSTED_MAX_PROJECTS: "1", HOSTED_MAX_BODY_BYTES: "20000", HOSTED_RATE_PER_MINUTE: "8" }, dir), jwks: jwks as never, fetch: fakeFetch, spawnFn, log: () => {}, webDist: null });
    try {
      const t = await token(randomUUID());
      expect((await call("POST", "/api/projects", { srv, token: t, json: { ...mealPlanner(), pitch: "x".repeat(30_000) } })).status).toBe(413);
      expect((await call("POST", "/api/projects", { srv, token: t, json: mealPlanner() })).status).toBe(201);
      const second = await call("POST", "/api/projects", { srv, token: t, json: { ...mealPlanner(), id: "autre" } });
      expect(second.status).toBe(403);
      expect(second.body.code).toBe("quota_projects");
      let last = 200;
      for (let i = 0; i < 10; i++) last = (await call("GET", "/api/projects", { srv, token: t })).status;
      expect(last).toBe(429);
    } finally {
      srv.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("DELETE /api/me : confirmation exigée, puis purge complète du dossier et de la file", async () => {
    const dirB = server.pool.dirOf(B);
    expect(existsSync(dirB)).toBe(true);
    // Une tâche en cours pour B, arrêtée par la suppression
    const sB = await call("POST", "/api/studies", { token: tokB, json: { projectId: "meal-planner", useProjectTarget: true, n: 5 } });
    expect(sB.status).toBe(201);
    expect((await call("POST", `/api/studies/${sB.body.study.id}/run`, { token: tokB, json: {} })).status).toBe(202);
    const child = children.at(-1)!;
    // Cookie de session de B, gardé pour le rejouer après la suppression
    const s = await call("POST", "/api/session", { token: tokB, json: {} });
    const jar = s.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const refused = await call("DELETE", "/api/me", { token: tokB, json: {} });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe("confirm_required");
    const del = await call("DELETE", "/api/me", { headers: { cookie: jar, "x-csrf-token": s.body.csrfToken }, json: { confirm: true } });
    expect(del.status).toBe(200);
    expect(del.body).toMatchObject({ deleted: true, cancelledJobs: 1 });
    // Cookies effacés par la réponse
    const cleared = del.headers.getSetCookie();
    expect(cleared.find((c) => c.startsWith("__Host-personas_session="))).toMatch(/Max-Age=0/);
    expect(cleared.find((c) => c.startsWith("__Host-personas_csrf="))).toMatch(/Max-Age=0/);
    expect(child.killed).toBe(true);
    expect(existsSync(dirB)).toBe(false);
    expect(server.queue.list(B)).toEqual([]);
    // Le compte A n'est pas touché
    expect((await call("GET", "/api/projects", { token: tokA })).body).toHaveLength(1);
    // B : l'ancien cookie (JWT encore valide), le jeton Bearer ou une nouvelle session sont refusés, sans recréer de dossier
    const replay = await call("GET", "/api/me", { headers: { cookie: jar } });
    expect(replay.status).toBe(403);
    expect(replay.body).toMatchObject({ code: "account_deleted", error: expect.stringMatching(/Compte supprimé/) });
    expect(replay.headers.getSetCookie().find((c) => c.startsWith("__Host-personas_session="))).toMatch(/Max-Age=0/);
    for (const [m, p] of [["GET", "/api/me"], ["GET", "/api/projects"], ["GET", "/api/me/engine"], ["POST", "/api/projects"]] as const) {
      const r = await call(m, p, { token: tokB, ...(m === "POST" && { json: mealPlanner() }) });
      expect(r.status, `${m} ${p}`).toBe(403);
      expect(r.body.code).toBe("account_deleted");
    }
    const again = await call("POST", "/api/session", { token: await token(B), json: {} });
    expect(again.status).toBe(403);
    expect(again.body.code).toBe("account_deleted");
    expect(again.headers.getSetCookie().join(";")).not.toMatch(/__Host-personas_session=[^;]/);
    // Méta : comme sans session (le front reste en mode hébergé)
    expect((await call("GET", "/api/meta", { headers: { cookie: jar } })).body).toMatchObject({ mode: "hosted", authenticated: false });
    expect(existsSync(dirB)).toBe(false);
    // Nouvel utilisateur Supabase avec la même adresse (autre `sub`) : refusé aussi, sans dossier
    const twin = randomUUID();
    const sameEmail = await call("GET", "/api/me", { token: await token(twin, { email: `${B.slice(0, 4).toUpperCase()}@Example.test` }) });
    expect(sameEmail.status).toBe(403);
    expect(sameEmail.body.code).toBe("account_deleted");
    expect(existsSync(server.pool.dirOf(twin))).toBe(false);
    expect((await call("POST", "/api/session", { token: await token(twin, { email: `${B.slice(0, 4)}@example.test` }), json: {} })).body.code).toBe("account_deleted");
    // Liste des comptes supprimés : empreintes SHA-256 du `sub` et de l'e-mail, jour de suppression ; rien en clair
    const file = join(root, "_system", TOMBSTONES_FILE);
    const text = readFileSync(file, "utf8");
    const tomb = JSON.parse(text);
    expect(tomb.version).toBe(2);
    expect(tomb.accounts).toEqual([{ sub: subFingerprint(B), email: emailFingerprint(`${B.slice(0, 4)}@example.test`), deletedOn: new Date().toISOString().slice(0, 10) }]);
    expect(subFingerprint(B)).toBe(createHash("sha256").update(B).digest("hex"));
    expect(emailFingerprint(` ${mail("X", "Example.TEST")} `)).toBe(createHash("sha256").update(mail("x")).digest("hex"));
    expect(text).not.toContain(B);
    expect(text).not.toContain("@");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("liste des comptes supprimés : définitive (ancien format converti), réactivation par l'opérateur sans redémarrage", async () => {
    const dir = mkdtempSync(join(tmpdir(), "personas-hosted-tomb-"));
    const old = randomUUID();
    const gone = randomUUID();
    const day = 24 * 3600 * 1000;
    const sys = join(dir, "_system");
    const file = join(sys, TOMBSTONES_FILE);
    mkdirSync(sys, { recursive: true });
    // Ancien format (sub en clair, conservation de 8 jours) : converti en empreintes, et l'entrée reste définitive
    writeFileSync(file, JSON.stringify({ version: 1, accounts: { [old]: { deletedAt: new Date(Date.now() - 30 * day).toISOString() } } }));
    const srv = createHostedServer({ config: hostedConfig({}, dir), jwks: jwks as never, fetch: fakeFetch, spawnFn, log: () => {}, webDist: null });
    try {
      const migrated = readFileSync(file, "utf8");
      expect(migrated).not.toContain(old);
      expect(JSON.parse(migrated)).toEqual({ version: 2, accounts: [{ sub: subFingerprint(old), email: null, deletedOn: new Date(Date.now() - 30 * day).toISOString().slice(0, 10) }] });
      expect(statSync(file).mode & 0o777).toBe(0o600);
      const r = await call("GET", "/api/me", { srv, token: await token(old) });
      expect(r.status).toBe(403);
      expect(r.body.code).toBe("account_deleted");
      expect(existsSync(srv.pool.dirOf(old))).toBe(false);
      // Suppression d'un compte, puis réactivation de son adresse (commande d'administration) pendant que le serveur tourne
      const email = mail("Gone.User");
      const tok = await token(gone, { email });
      expect((await call("POST", "/api/projects", { srv, token: tok, json: mealPlanner() })).status).toBe(201);
      expect((await call("DELETE", "/api/me", { srv, token: tok, json: { confirm: true } })).status).toBe(200);
      expect((await call("GET", "/api/me", { srv, token: tok })).status).toBe(403);
      expect(reactivateAccount(file, mail("nobody"))).toBe(0);
      expect(() => reactivateAccount(file, "pas-une-adresse")).toThrow(/ni une adresse/);
      expect(reactivateAccount(file, ` ${mail("gone.user", "EXAMPLE.test")} `)).toBe(1);
      // Même sub et nouvelle connexion : compte vide ; l'ancien compte (sans e-mail) reste refusé
      const back = await call("GET", "/api/me", { srv, token: tok });
      expect(back.status).toBe(200);
      expect(back.body.quotas.projects).toBe(0);
      expect((await call("GET", "/api/me", { srv, token: await token(old) })).status).toBe(403);
      // Réactivation par identifiant Supabase (compte sans e-mail connu)
      expect(reactivateAccount(file, old.toUpperCase())).toBe(1);
      expect((await call("GET", "/api/me", { srv, token: await token(old) })).status).toBe(200);
      expect(JSON.parse(readFileSync(file, "utf8")).accounts).toEqual([]);
    } finally {
      srv.close();
    }
    // Fichier illisible : démarrage refusé (jamais de recréation silencieuse)
    writeFileSync(file, "{ pas du json");
    expect(() => createHostedServer({ config: hostedConfig({}, dir), jwks: jwks as never, fetch: fakeFetch, spawnFn, log: () => {}, webDist: null })).toThrow(/illisible/);
    writeFileSync(file, JSON.stringify({ version: 2, accounts: [{ sub: "en-clair", email: null, deletedOn: "2026-10-24" }] }));
    expect(() => createHostedServer({ config: hostedConfig({}, dir), jwks: jwks as never, fetch: fakeFetch, spawnFn, log: () => {}, webDist: null })).toThrow(/invalide/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("configuration : HOSTED_ALLOWED_ORIGINS obligatoire, origines exactes", () => {
    const base = { HOSTED_DATA_ROOT: root, HOSTED_MASTER_KEY: masterKey, SUPABASE_URL: SUPABASE };
    expect(() => loadHostedConfig(base)).toThrow(/HOSTED_ALLOWED_ORIGINS requis/);
    expect(() => loadHostedConfig({ ...base, HOSTED_ALLOWED_ORIGINS: " , " })).toThrow(/HOSTED_ALLOWED_ORIGINS requis/);
    expect(() => loadHostedConfig({ ...base, HOSTED_ALLOWED_ORIGINS: "https://app.example.org/chemin" })).toThrow(/n'est pas une origine/);
    expect(() => loadHostedConfig({ ...base, HOSTED_ALLOWED_ORIGINS: "app.example.org" })).toThrow(/n'est pas une origine/);
    expect(() => loadHostedConfig({ ...base, HOSTED_ALLOWED_ORIGINS: "ftp://app.example.org" })).toThrow(/n'est pas une origine/);
    // Jamais la clé maître dans le message
    try {
      loadHostedConfig(base);
    } catch (err) {
      expect((err as Error).message).not.toContain(masterKey);
    }
    expect(loadHostedConfig({ ...base, HOSTED_ALLOWED_ORIGINS: "https://app.example.org/, http://127.0.0.1:8098" }).allowedOrigins).toEqual(["https://app.example.org", "http://127.0.0.1:8098"]);
  });

  it("projet de démonstration (même contrat que le premier lancement local) : clé IA exigée ; erreurs sans commande npm ni moteur local", async () => {
    const t = await token(randomUUID());
    expect((await call("GET", "/api/me/engine", { token: t })).status).toBe(404);
    const sess = await call("GET", "/api/setup/session", { token: t });
    expect(sess.status).toBe(200);
    // Sans clé : refus explicite, rien n'est créé
    const noKey = await call("POST", "/api/setup/demo", { token: t, json: { lang: "fr" } });
    expect(noKey.status).toBe(409);
    expect(noKey.body).toEqual({ code: "key_required", error: "Aucune clé IA enregistrée : ajoutez-en une dans « Ma clé IA »." });
    const noKeyEn = await call("POST", "/api/setup/demo", { token: t, json: { lang: "en" } });
    expect(noKeyEn.status).toBe(409);
    expect(noKeyEn.body.error).toMatch(/No AI key saved.*My AI key/);
    expect((await call("GET", "/api/projects", { token: t })).body).toEqual([]);
    expect((await call("GET", "/api/me", { token: t })).body.quotas.projects).toBe(0);
    // Sans clé, création d'étude et estimation : « aucune clé IA », jamais « claude-cli refusé », ni commande
    expect((await call("POST", "/api/projects", { token: t, json: mealPlanner() })).status).toBe(201);
    const study = await call("POST", "/api/studies", { token: t, json: { projectId: "meal-planner", useProjectTarget: true, n: 5 } });
    expect(study.status).toBe(400);
    expect(study.body).toMatchObject({ code: "key_required", error: "Aucune clé IA enregistrée : ajoutez-en une dans « Ma clé IA »." });
    const studyEn = await call("POST", "/api/studies?lang=en", { token: t, json: { projectId: "meal-planner", useProjectTarget: true, n: 5 } });
    expect(studyEn.body.error).toBe("No AI key saved: add one in “My AI key”.");
    for (const q of ["", "?profile=inconnu"]) {
      const est = await call("GET", `/api/projects/meal-planner/estimate${q}`, { token: t });
      expect(est.status).toBe(400);
      expect(est.body.error).not.toMatch(/npm run|--profile|claude-cli/);
    }
    // Avec une clé : projet de démonstration créé, une seule fois
    const t2 = await token(randomUUID());
    expect((await call("POST", "/api/me/engine", { token: t2, json: { provider: "anthropic", model: "claude-haiku-4-5", apiKey: GOOD_KEY } })).status).toBe(200);
    const demo = await call("POST", "/api/setup/demo", { token: t2, json: { lang: "fr" } });
    expect(demo.status).toBe(200);
    expect(demo.body).toMatchObject({ ok: true, projectId: "meal-planner", created: true, n: 20 });
    expect((await call("POST", "/api/setup/demo", { token: t2, json: { lang: "fr" } })).body.created).toBe(false);
  });
});

describe("en-têtes de sécurité (CSP, HSTS)", () => {
  const THEME = `\n      try { const t = localStorage.getItem("personas-theme"); if (t) document.documentElement.dataset.theme = t; } catch {}\n    `;
  const dist = mkdtempSync(join(tmpdir(), "personas-hosted-dist-"));
  writeFileSync(join(dist, "index.html"), `<!doctype html><html><head><script>${THEME}</script><script type="module" src="/assets/index.js"></script></head><body><div id="root"></div></body></html>`);
  const hash = `'sha256-${createHash("sha256").update(THEME, "utf8").digest("base64")}'`;
  const make = (over: Record<string, string> = {}) => createHostedServer({ config: hostedConfig(over, join(root, `csp-${randomUUID()}`)), jwks: jwks as never, fetch: fakeFetch, spawnFn, log: () => {}, webDist: dist });
  afterAll(() => rmSync(dist, { recursive: true, force: true }));

  it("pages du front : CSP stricte, script en ligne autorisé par son empreinte, Supabase en connect-src", async () => {
    const srv = make();
    try {
      for (const path of ["/", "/connexion", "/projets/x"]) {
        const r = await call("GET", path, { srv });
        expect(r.status).toBe(200);
        const csp = r.headers.get("content-security-policy") ?? "";
        expect(csp).toContain("default-src 'self'");
        expect(csp).toContain(`script-src 'self' ${hash}`);
        expect(csp).toContain("style-src 'self';");
        expect(csp).toContain("img-src 'self' data:");
        expect(csp).toContain("font-src 'self'");
        expect(csp).toContain(`connect-src 'self' ${SUPABASE}`);
        expect(csp).toContain("frame-ancestors 'none'");
        expect(csp).toContain("base-uri 'none'");
        expect(csp).toContain("form-action 'self'");
        expect(csp).not.toMatch(/unsafe-(inline|eval)/);
      }
      // API : CSP de base aussi (sans empreinte)
      const api = await call("GET", "/api/meta", { srv });
      expect(api.headers.get("content-security-policy")).toContain("script-src 'self';");
    } finally {
      srv.close();
    }
  });

  it("HSTS : seulement en HTTPS ; X-Forwarded-Proto cru derrière TRUST_PROXY seulement", async () => {
    const proxied = make({ TRUST_PROXY: "1" });
    const direct = make();
    try {
      expect((await call("GET", "/connexion", { srv: proxied, headers: { "x-forwarded-proto": "https" } })).headers.get("strict-transport-security")).toBe("max-age=31536000");
      expect((await call("GET", "/api/meta", { srv: proxied, headers: { "x-forwarded-proto": "https" } })).headers.get("strict-transport-security")).toBe("max-age=31536000");
      expect((await call("GET", "/connexion", { srv: proxied, headers: { "x-forwarded-proto": "http" } })).headers.get("strict-transport-security")).toBeNull();
      expect((await call("GET", "/connexion", { srv: proxied })).headers.get("strict-transport-security")).toBeNull();
      expect((await call("GET", "/connexion", { srv: direct, headers: { "x-forwarded-proto": "https" } })).headers.get("strict-transport-security")).toBeNull();
      const res = await direct.app.request("https://app.example.test/connexion");
      expect(res.headers.get("strict-transport-security")).toBe("max-age=31536000");
    } finally {
      proxied.close();
      direct.close();
    }
  });
});
