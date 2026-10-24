import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { catalogResponse, moduleVersionResponse, searchResponse } from "../../src/hub/contract";
import { HubClient } from "../../src/hub/client";
import { openPglite, type HubDb } from "../db/client";
import { prefersHtml } from "../src/api-docs";
import { createHubApp } from "../src/app";
import { officialPublications } from "../scripts/seed-official";

// Documentation de l'API (/docs/api) et négociation HTML/JSON des GET publics /v1/* : un navigateur reçoit
// une page « ce n'est pas pour vous », les programmes (runner, curl, fetch) toujours le JSON inchangé.

const TOKEN = "a".repeat(48);
const BROWSER = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";
let db: HubDb;
let close: () => Promise<void>;
let app: ReturnType<typeof createHubApp>;
let mod: { ref: string; latest: string };

beforeAll(async () => {
  ({ db, close } = await openPglite());
  app = createHubApp({ db, adminToken: TOKEN, publicBaseUrl: "https://hub.example.org" });
  // Sous-ensemble des publications officielles (dépendances d'abord) : quelques modules et le socle sg.
  const pubs = officialPublications();
  const subset = [...pubs.filter((p) => p.kind === "module").slice(0, 3), ...pubs.filter((p) => p.kind === "pack" && p.body.slug === "sg" && p.body.extends === null)];
  for (const p of subset) {
    const r = await app.request(p.kind === "module" ? "/v1/admin/modules" : "/v1/admin/packs", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(p.body) });
    expect(r.status, p.label).toBe(201);
  }
  const cat = catalogResponse.parse(await (await app.request("/v1/catalog")).json());
  mod = cat.modules[0]!;
}, 180_000);

afterAll(async () => {
  await close();
});

describe("prefersHtml (en-tête Accept)", () => {
  it("navigateur → HTML ; JSON, */*, absent → JSON", () => {
    expect(prefersHtml(BROWSER)).toBe(true);
    expect(prefersHtml("text/html")).toBe(true);
    expect(prefersHtml(undefined)).toBe(false);
    expect(prefersHtml("*/*")).toBe(false);
    expect(prefersHtml("application/json")).toBe(false);
    expect(prefersHtml("application/json, text/html")).toBe(false);
    expect(prefersHtml("text/html;q=0.5, application/json")).toBe(false);
    expect(prefersHtml("text/html, application/json;q=0.5")).toBe(true);
    expect(prefersHtml("text/html;q=0")).toBe(false);
  });
});

describe("page /docs/api", () => {
  it("rail : le lien API mène à la documentation, page FR/EN sans script ni style en ligne", async () => {
    const home = await (await app.request("/?ui=fr")).text();
    expect(home).toContain('<a href="/docs/api">API</a>');
    expect(home).not.toMatch(/<nav class="main-nav"[^>]*>.*href="\/v1\/catalog".*<\/nav>/);

    const fr = await app.request("/docs/api?ui=fr");
    expect(fr.status).toBe(200);
    expect(fr.headers.get("content-type")).toContain("text/html");
    expect(fr.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await fr.text();
    expect(html).toContain('<html lang="fr">');
    expect(html).toContain('<a href="/docs/api" aria-current="page">API</a>');
    expect(html).not.toMatch(/<script|style=|<style/);
    for (const p of ["/v1/catalog", "/v1/modules/{ns}/{slug}", "/v1/modules/{ns}/{slug}/{version}", "/v1/packs/{ns}/{slug}/{version}", "/v1/search", "/v1/modules/{ns}/{slug}/{version}/reviews", "/v1/keys", "/v1/legal"]) {
      expect(html).toContain(`<code class="ep-path">${p.replace(/&/g, "&amp;")}</code>`);
    }
    for (const q of ["q", "socle", "lang", "prefer", "sort", "limit"]) expect(html).toContain(`<dt><code>${q}</code></dt>`);
    expect(html).toContain("personas hub login");
    expect(html).toContain("curl -s https://hub.example.org/v1/catalog");
    // Extrait réel du catalogue : premier module publié
    expect(html).toContain(`&quot;ref&quot;: &quot;${mod.ref}&quot;`);
    expect(html).toContain('href="/v1/catalog?format=json"');
    expect(html).toContain("Ed25519");

    const en = await (await app.request("/docs/api?ui=en")).text();
    expect(en).toContain('<html lang="en">');
    expect(en).toContain("Public endpoints (read)");
    expect(en).toContain("Verifying a signature");
  });

  it("/api redirige vers /docs/api ; les routes existantes restent en place", async () => {
    const r = await app.request("/api");
    expect(r.status).toBe(301);
    expect(r.headers.get("location")).toBe("/docs/api");
    expect((await app.request("/")).status).toBe(200);
    expect((await app.request(`/m/${mod.ref}`)).status).toBe(200);
    expect((await app.request("/terms")).status).toBe(200);
    expect((await app.request("/healthz")).status).toBe(200);
  });
});

describe("route JSON ouverte dans un navigateur", () => {
  it("navigateur → page HTML « ce n'est pas pour vous » avec aperçu, non mise en cache", async () => {
    const r = await app.request("/v1/catalog?ui=fr", { headers: { Accept: BROWSER } });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(r.headers.get("etag")).toBeNull();
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("vary")).toContain("Accept");
    expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await r.text();
    expect(html).toContain("Cette adresse est l&#39;API du Hub, destinée à l&#39;outil Personas, pas une page à lire.");
    expect(html).toContain('href="/docs/api"');
    expect(html).toContain('href="/v1/catalog?format=json"');
    expect(html).toMatch(/<dt>Modules<\/dt><dd>3<\/dd><dt>Socles pays<\/dt><dd>1<\/dd>/);
    expect(html).not.toMatch(/<script|style=|<style/);

    const en = await (await app.request("/v1/catalog", { headers: { Accept: BROWSER, "Accept-Language": "en-GB,en;q=0.9" } })).text();
    expect(en).toContain("This address is the Hub&#39;s API, meant for the Personas tool, not a page to read.");
    expect(en).toContain("View the raw JSON");
  });

  it("aperçu des autres routes, statut conservé (404 reste 404)", async () => {
    const v = await app.request(`/v1/modules/${mod.ref}/${mod.latest}`, { headers: { Accept: BROWSER } });
    expect(v.status).toBe(200);
    const vh = await v.text();
    expect(vh).toContain(`${mod.ref}@${mod.latest}`);
    expect(vh).toContain(`href="/m/${mod.ref}"`);
    const s = await (await app.request("/v1/search?q=prix&ui=en", { headers: { Accept: BROWSER } })).text();
    expect(s).toContain('href="/v1/search?q=prix&amp;format=json"');
    const nf = await app.request("/v1/modules/personas/inexistant", { headers: { Accept: BROWSER } });
    expect(nf.status).toBe(404);
    expect(nf.headers.get("content-type")).toContain("text/html");
    expect(await nf.text()).toContain("not_found");
  });

  it("?format=json force le JSON, avec ETag et CORS inchangés", async () => {
    const plain = await app.request("/v1/catalog");
    const r = await app.request("/v1/catalog?format=json", { headers: { Accept: BROWSER, Origin: "https://example.org" } });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/json");
    expect(r.headers.get("etag")).toBe(plain.headers.get("etag"));
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    expect(r.headers.get("cache-control")).toBe(plain.headers.get("cache-control"));
    expect(await r.text()).toBe(await plain.text());
  });

  it("curl (*/*), Accept: application/json, sans Accept : JSON inchangé", async () => {
    const ref = await app.request("/v1/catalog");
    const body = await ref.text();
    for (const headers of [{ Accept: "*/*", "User-Agent": "curl/8.7.1" }, { Accept: "application/json" }, { Accept: "application/json, text/html" }]) {
      const r = await app.request("/v1/catalog", { headers });
      expect(r.headers.get("content-type")).toContain("application/json");
      expect(r.headers.get("etag")).toBe(ref.headers.get("etag"));
      expect(r.headers.get("vary")).toBe(ref.headers.get("vary"));
      expect(await r.text()).toBe(body);
    }
    // 304 conditionnel intact
    const nm = await app.request("/v1/catalog", { headers: { Accept: "application/json", "If-None-Match": ref.headers.get("etag")! } });
    expect(nm.status).toBe(304);
    // Les écritures et l'administration ne sont jamais converties
    const w = await app.request("/v1/reports", { method: "POST", headers: { Accept: BROWSER, "Content-Type": "application/json" }, body: "{}" });
    expect(w.headers.get("content-type")).toContain("application/json");
  });

  it("client du runner : Accept: application/json, catalogue, version et recherche en JSON", async () => {
    const seen: string[] = [];
    const client = new HubClient({
      baseUrl: "https://hub.example.org",
      cacheDir: mkdtempSync(join(tmpdir(), "api-docs-")),
      fetch: (input, init) => {
        seen.push(new Headers(init?.headers).get("accept") ?? "");
        return Promise.resolve(app.request(String(input), init));
      },
    });
    const cat = await client.catalog();
    expect(cat.source).toBe("network");
    expect(cat.catalog?.modules.length).toBe(3);
    expect(moduleVersionResponse.safeParse(await client.moduleVersion(mod.ref, mod.latest)).success).toBe(true);
    expect(searchResponse.safeParse(await client.search("prix")).success).toBe(true);
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(seen.every((a) => a === "application/json")).toBe(true);
  });
});
