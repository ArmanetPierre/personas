import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { parse as parseYaml } from "yaml";
import { packFilesSha256, sha256Text } from "../../src/hub/cache";
import type { CatalogResponse, ModuleVersionResponse } from "../../src/hub/contract";

/**
 * Faux Hub (serveur HTTP local, 127.0.0.1) qui sert des réponses conformes à src/hub/contract.ts. Enregistre
 * chaque requête reçue (méthode, URL, en-têtes, corps) pour vérifier qu'aucune donnée de projet n'en sort.
 */

export interface FakeModule {
  ref: string;
  yaml: string;
  status?: "published" | "unverified" | "verified" | "yanked";
  quality?: ModuleVersionResponse["quality"];
  requires?: ModuleVersionResponse["requires"];
  tags?: string[];
  /** Empreinte annoncée (défaut : la vraie) ; sert à simuler un contenu corrompu. */
  announcedSha?: string;
  /** Champs additifs de la réponse de version (phase 3 : signature, forkedFrom, publishedAt…). */
  extra?: Record<string, unknown>;
}

export type FakeSend = (status: number, json?: unknown, headers?: Record<string, string>) => void;
/** Route supplémentaire : renvoie vrai si elle a répondu. */
export type FakeHandler = (req: Recorded, parts: string[], send: FakeSend) => boolean;

export interface FakePack {
  ref: string;
  version: string;
  files: Record<string, string>;
  extends: string | null;
  announcedSha?: string;
}

export interface Recorded {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

export class FakeHub {
  modules: FakeModule[] = [];
  packs: FakePack[] = [];
  requests: Recorded[] = [];
  etag = '"v1"';
  /** Réponse publication (POST admin). */
  adminToken = "test-admin-token";
  /** Routes supplémentaires (phase 3), essayées avant les routes de base. */
  handlers: FakeHandler[] = [];
  #server: Server | null = null;
  url = "";

  catalog(): CatalogResponse {
    const byRef = new Map<string, FakeModule[]>();
    for (const m of this.modules) byRef.set(m.ref, [...(byRef.get(m.ref) ?? []), m]);
    return {
      apiVersion: "v1",
      generatedAt: "2026-10-16T00:00:00.000Z",
      modules: [...byRef].map(([ref, versions]) => {
        const defs = versions.map((v) => ({ v, def: parseYaml(v.yaml) as { version: string | number; label: string; description?: string; applies_to: string[]; attributes: Array<{ key: string; label: string }> } }));
        const latest = defs.at(-1)!;
        return {
          ref,
          label: latest.def.label,
          description: latest.def.description ?? "",
          appliesTo: latest.def.applies_to,
          tags: latest.v.tags ?? [],
          attributes: latest.def.attributes.map((a) => ({ key: a.key, label: a.label })),
          latest: String(latest.def.version),
          versions: defs.map(({ v, def }) => ({ version: String(def.version), sha256: sha256Text(v.yaml), publishedAt: "2026-10-16T00:00:00.000Z", status: v.status ?? "published", quality: v.quality ?? null })),
        };
      }),
      packs: [...new Set(this.packs.map((p) => p.ref))].map((ref) => {
        const versions = this.packs.filter((p) => p.ref === ref);
        const m = JSON.parse(versions.at(-1)!.files["pack.json"]!) as { label?: string; country: string; locale: string };
        return { ref, label: m.label ?? ref, country: m.country, locale: m.locale, latest: versions.at(-1)!.version, versions: versions.map((p) => ({ version: p.version, sha256: packFilesSha256(p.files), publishedAt: "2026-10-16T00:00:00.000Z", extends: p.extends })) };
      }),
    };
  }

  async start(): Promise<string> {
    this.#server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        this.requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
        const send = (status: number, json?: unknown, headers: Record<string, string> = {}) => {
          res.writeHead(status, { "content-type": "application/json", ...headers });
          res.end(json === undefined ? "" : JSON.stringify(json));
        };
        const notFound = () => send(404, { error: { code: "not_found", message: "introuvable" } });
        const u = new URL(req.url ?? "/", "http://x");
        const parts = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
        if (parts[0] !== "v1") return notFound();
        const rec = this.requests.at(-1)!;
        for (const h of this.handlers) if (h(rec, parts, send)) return;
        if (req.method === "GET" && parts[1] === "catalog") {
          if (req.headers["if-none-match"] === this.etag) return send(304, undefined, { etag: this.etag });
          return send(200, this.catalog(), { etag: this.etag });
        }
        if (req.method === "GET" && parts[1] === "modules" && parts.length === 5) {
          const ref = `${parts[2]}/${parts[3]}`;
          const m = this.modules.find((x) => x.ref === ref && String((parseYaml(x.yaml) as { version: unknown }).version) === parts[4]);
          if (!m) return notFound();
          return send(200, { ref, version: parts[4], sha256: m.announcedSha ?? sha256Text(m.yaml), yaml: m.yaml, requires: m.requires ?? [], quality: m.quality ?? null, publishedAt: "2026-10-16T00:00:00.000Z", status: m.status ?? "published", license: "CC-BY-4.0", ...m.extra });
        }
        if (req.method === "GET" && parts[1] === "packs" && parts.length === 5) {
          const ref = `${parts[2]}/${parts[3]}`;
          const p = this.packs.find((x) => x.ref === ref && x.version === parts[4]);
          if (!p) return notFound();
          return send(200, { ref, version: p.version, sha256: p.announcedSha ?? packFilesSha256(p.files), files: p.files, extends: p.extends, license: "CC-BY-4.0" });
        }
        if (req.method === "GET" && parts[1] === "search") return send(200, { query: u.searchParams.get("q") ?? "", results: [] });
        if (req.method === "POST" && parts[1] === "admin") {
          if (req.headers.authorization !== `Bearer ${this.adminToken}`) return send(401, { error: { code: "unauthorized", message: "jeton refusé" } });
          const b = JSON.parse(body) as { namespace: string; yaml: string };
          const def = parseYaml(b.yaml) as { id: string; version: unknown };
          return send(201, { ref: `${b.namespace}/${def.id}`, version: String(def.version), sha256: sha256Text(b.yaml), quality: null });
        }
        return notFound();
      });
    });
    await new Promise<void>((r) => this.#server!.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.#server!.address() as AddressInfo).port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    if (!this.#server) return;
    this.#server.closeAllConnections();
    await new Promise<void>((r) => this.#server!.close(() => r()));
    this.#server = null;
  }
}
