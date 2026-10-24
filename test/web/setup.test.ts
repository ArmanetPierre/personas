import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { loadConfig } from "../../src/config";
import { openDb, runMigrations } from "../../src/db/client";
import { loadEngineConfig } from "../../src/engine/profiles";
import { memoryStore } from "../../src/engine/secrets";
import { getProject } from "../../src/studies/project";
import { createApp } from "../../src/web/app";
import { Launcher } from "../../src/web/launcher";
import { demoCopy, isLoopbackAddress, SESSION_HEADER } from "../../src/web/setup-routes";
import { pack } from "../studies/fixtures";

/**
 * Écran de premier lancement : routes /api/setup/* sur un faux trousseau en mémoire et un faux serveur de
 * fournisseur (aucun appel réel). Refus hors boucle locale et sans jeton.
 */

const GOOD_KEY = "test-key-0123456789abcdef";
const dir = mkdtempSync(join(tmpdir(), "personas-setup-"));
const configPath = join(dir, "config.json");
const store = memoryStore();
const { db, sqlite } = openDb(":memory:");
runMigrations(db);

// Faux serveur Anthropic : la fiche du modèle répond 200 avec la bonne clé, 401 sinon
const seen: Array<{ url: string; key: string | undefined }> = [];
let fake: Server;
let fakeOrigin = "";
beforeAll(async () => {
  fake = createServer((req, res) => {
    const key = req.headers["x-api-key"] as string | undefined;
    seen.push({ url: req.url ?? "", key });
    res.setHeader("content-type", "application/json");
    if (req.method !== "GET" || !req.url?.startsWith("/v1/models/")) return void res.writeHead(404).end("{}");
    if (key !== GOOD_KEY) return void res.writeHead(401).end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
    res.writeHead(200).end(JSON.stringify({ id: decodeURIComponent(req.url.slice("/v1/models/".length)), type: "model" }));
  });
  await new Promise<void>((ok) => fake.listen(0, "127.0.0.1", ok));
  fakeOrigin = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
});
afterAll(() => {
  fake.close();
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

/** fetch du test de clé : l'API Anthropic est redirigée vers le faux serveur local. */
const fakeFetch: typeof fetch = (input, init) => fetch(String(input).replace("https://api.anthropic.com", fakeOrigin), init);

const TOKEN = "jeton-de-test";
let claudeDetected = false;
const app = createApp({
  db,
  pack,
  config: loadConfig({}),
  launcher: new Launcher({ root: process.cwd(), logDir: join(dir, "logs") }),
  dataDir: join(dir, "data"),
  sessionToken: TOKEN,
  setup: { store, configPath, fetch: fakeFetch, detectClaude: async () => (claudeDetected ? { detected: true, version: "2.0.0 (Claude Code)" } : { detected: false }) },
});

const LOCAL = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };
const call = async (method: string, path: string, opts: { json?: unknown; token?: string | null; remote?: string; host?: string; headers?: Record<string, string> } = {}) => {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.token !== null) headers[SESSION_HEADER] = opts.token ?? TOKEN;
  if (opts.json !== undefined) headers["content-type"] = "application/json";
  const res = await app.request(
    `http://${opts.host ?? "127.0.0.1:4321"}/api/setup${path}`,
    { method, headers, ...(opts.json !== undefined && { body: JSON.stringify(opts.json) }) },
    opts.remote ? { incoming: { socket: { remoteAddress: opts.remote } } } : LOCAL,
  );
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) as any, text };
};

describe("garde de l'API de configuration", () => {
  it("adresse de boucle locale", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("203.0.113.7")).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });

  it("donne le jeton de session à la boucle locale seulement", async () => {
    const ok = await call("GET", "/session", { token: null });
    expect(ok.status).toBe(200);
    expect(ok.body.token).toBe(TOKEN);
    expect((await call("GET", "/session", { token: null, remote: "203.0.113.7" })).status).toBe(403);
  });

  it("refuse hors boucle locale, même avec le jeton", async () => {
    const r = await call("POST", "/engine", { remote: "198.51.100.4", json: { kind: "api", provider: "anthropic", model: "m", key: GOOD_KEY } });
    expect(r.status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it("refuse un autre nom d'hôte (rebinding DNS) et une requête inter-sites", async () => {
    expect((await call("GET", "/status", { host: "evil.example:4321" })).status).toBe(403);
    expect((await call("GET", "/status", { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
    expect((await call("GET", "/status", { host: "localhost:4321" })).status).toBe(200);
  });

  it("refuse sans jeton ou avec un mauvais jeton", async () => {
    expect((await call("GET", "/status", { token: null })).status).toBe(401);
    const r = await call("POST", "/engine", { token: "faux", json: { kind: "api", provider: "anthropic", model: "m", key: GOOD_KEY } });
    expect(r.status).toBe(401);
    expect(seen).toHaveLength(0);
    expect(await store.get("anthropic")).toBeUndefined();
  });
});

describe("premier lancement", () => {
  it("demande la configuration sans profil ni CLI claude", async () => {
    const r = await call("GET", "/status");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ needsOnboarding: true, configured: false, activeProfile: "claude-cli", defaultPerStudyUsd: 5, claudeCli: { detected: false } });
  });

  it("une clé refusée par le fournisseur n'est ni rangée ni renvoyée", async () => {
    const bad = "test-key-mauvaise-9876";
    const r = await call("POST", "/engine", { json: { kind: "api", provider: "anthropic", model: "claude-test", key: bad } });
    expect(r.status).toBe(400);
    expect(r.body.ok).toBe(false);
    expect(r.text).not.toContain(bad);
    expect(await store.get("anthropic")).toBeUndefined();
    expect(loadEngineConfig(configPath).profiles).toHaveLength(0);
    expect(seen.at(-1)).toEqual({ url: "/v1/models/claude-test", key: bad });
  });

  it("teste la clé sur la fiche du modèle (gratuit), la range dans le trousseau et active le profil", async () => {
    const r = await call("POST", "/engine", { json: { kind: "api", provider: "anthropic", model: "claude-test", key: ` ${GOOD_KEY} ` } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, profile: "anthropic", provider: "anthropic", billed: true });
    expect(r.text).not.toContain(GOOD_KEY);
    expect(seen.at(-1)).toEqual({ url: "/v1/models/claude-test", key: GOOD_KEY });
    expect(seen.every((s) => s.url.startsWith("/v1/models/"))).toBe(true); // aucune génération
    expect(await store.get("anthropic")).toBe(GOOD_KEY);
    const file = loadEngineConfig(configPath);
    expect(file.activeProfile).toBe("anthropic");
    expect(file.profiles).toEqual([{ name: "anthropic", provider: "anthropic", model: "claude-test" }]);
    expect(readFileSync(configPath, "utf8")).not.toContain(GOOD_KEY);
    const s = await call("GET", "/status");
    expect(s.body).toMatchObject({ configured: true, needsOnboarding: false, activeProfile: "anthropic" });
    expect(s.text).not.toContain(GOOD_KEY);
  });

  it("enregistre le plafond par étude dans le profil", async () => {
    const r = await call("POST", "/limits", { json: { profile: "anthropic", perStudyUsd: 5 } });
    expect(r.status).toBe(200);
    expect(loadEngineConfig(configPath).profiles[0]?.limits).toEqual({ perStudyUsd: 5 });
    expect((await call("POST", "/limits", { json: { profile: "anthropic", perStudyUsd: -1 } })).status).toBe(400);
    expect((await call("POST", "/limits", { json: { profile: "claude-cli", perStudyUsd: 5 } })).status).toBe(400);
    // Un nouveau test de clé garde le plafond
    await call("POST", "/engine", { json: { kind: "api", provider: "anthropic", model: "claude-test-2", key: GOOD_KEY } });
    expect(loadEngineConfig(configPath).profiles[0]).toMatchObject({ model: "claude-test-2", limits: { perStudyUsd: 5 } });
  });

  it("abonnement Claude : exige la CLI détectée et l'accord d'usage personnel", async () => {
    expect((await call("POST", "/engine", { json: { kind: "claude-cli" } })).status).toBe(400);
    expect((await call("POST", "/engine", { json: { kind: "claude-cli", acknowledgePersonalUse: true } })).status).toBe(400);
    claudeDetected = true;
    const r = await call("POST", "/engine", { json: { kind: "claude-cli", acknowledgePersonalUse: true } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ profile: "claude-cli", billed: false });
    expect(loadEngineConfig(configPath).activeProfile).toBeUndefined();
  });

  it("refuse une demande mal formée (champ inconnu, clé vide)", async () => {
    expect((await call("POST", "/engine", { json: { kind: "api", provider: "anthropic", model: "m", key: "" } })).status).toBe(400);
    expect((await call("POST", "/engine", { json: { kind: "api", provider: "anthropic", model: "m", key: GOOD_KEY, baseUrl: "http://x" } })).status).toBe(400);
  });

  it("crée le projet de démonstration (copie à 20 personas dans le dossier de données) et le réutilise", async () => {
    const en = await call("POST", "/demo", { json: { lang: "en" } });
    expect(en.status).toBe(200);
    expect(en.body).toMatchObject({ projectId: "sg-recipe-app", created: true, n: 20 });
    const p = getProject(db, "sg-recipe-app")!;
    expect((p.extra as { sourceFile?: string }).sourceFile).toBe(join(dir, "data", "projects", "recipe-app.yaml"));
    expect(parseYaml(readFileSync(join(dir, "data", "projects", "recipe-app.yaml"), "utf8")).target.n).toBe(20);
    expect((await call("POST", "/demo", { json: { lang: "en" } })).body).toMatchObject({ projectId: "sg-recipe-app", created: false });
    const fr = await call("POST", "/demo", { json: { lang: "fr" } });
    expect(fr.body).toMatchObject({ projectId: "meal-planner", created: true });
  });
});

describe("copie de démonstration", () => {
  it("garde le projet et ramène la cible à 20 personas", () => {
    const fr = JSON.parse(demoCopy(join(process.cwd(), "examples/meal-planner.json")));
    expect(fr.target).toEqual({ socle: "fr", eligibility: "age >= 25 and age <= 50", n: 20 });
    expect(fr.pitch).toContain("Menu Malin");
  });
});
