/**
 * Routes du tableau de bord servies par le service hébergé : LISTE BLANCHE. Une route absente est refusée
 * (une nouvelle route locale n'est jamais exposée par mégarde). Les fonctions locales connues répondent 403
 * avec `code: "hosted_disabled"` ; le reste, 404.
 */

type Method = "GET" | "POST" | "PUT" | "DELETE";

const ID = "[^/]+";
const route = (method: Method, pattern: string): { method: Method; re: RegExp } => ({ method, re: new RegExp(`^${pattern.replace(/:[a-zA-Z]+/g, ID)}$`) });

const ALLOWED = [
  route("GET", "/meta"),
  route("GET", "/projects"),
  route("POST", "/projects"),
  route("POST", "/projects/import"),
  route("GET", "/projects/:id"),
  route("GET", "/projects/:id/estimate"),
  route("GET", "/projects/:id/overview"),
  route("GET", "/projects/:id/pitch"),
  route("PUT", "/projects/:id/pitch"),
  route("POST", "/projects/:id/pitch/check"),
  route("POST", "/projects/:id/pitch/dismiss"),
  route("POST", "/projects/:id/pitch/neutralize"),
  route("GET", "/projects/:id/protocol"),
  route("POST", "/projects/:id/protocol/suggest"),
  route("GET", "/projects/:id/target-preview"),
  route("GET", "/projects/:id/target-suggestion"),
  route("POST", "/projects/:id/target-suggestion"),
  route("POST", "/projects/:id/blocks/:key/validate"),
  route("PUT", "/projects/:id/blocks/:key"),
  route("GET", "/studies"),
  route("POST", "/studies"),
  route("POST", "/studies/estimate"),
  route("GET", "/studies/:id"),
  route("GET", "/studies/:id/estimate"),
  route("GET", "/studies/:id/progress"),
  route("GET", "/studies/:id/log"),
  route("POST", "/studies/:id/run"),
  route("GET", "/studies/:id/summary"),
  route("GET", "/studies/:id/responses"),
  route("GET", "/studies/:id/responses/:personaId"),
  route("GET", "/studies/:id/recoded"),
  route("POST", "/studies/:id/recode"),
  route("GET", "/studies/:id/recommendations"),
  route("POST", "/studies/:id/recommendations"),
  route("POST", "/studies/:id/recommendations/:recId/create-study"),
  route("GET", "/compare"),
  route("GET", "/personas"),
  route("GET", "/personas/:id"),
  route("GET", "/jobs/:key"),
  route("GET", "/modules"),
  route("POST", "/modules/validate"),
  route("GET", "/modules/:id"),
  route("GET", "/modules/:id/preview"),
  route("GET", "/hub/catalog"),
  route("POST", "/hub/sync"),
  route("POST", "/hub/pull"),
];

/** Fonctions locales désactivées en mode hébergé (refus explicite). */
const DISABLED: RegExp[] = [
  /^\/setup(\/|$)/, // premier lancement : trousseau, claude-cli, Ollama (remplacé par /api/me/engine)
  /^\/modules\/propose$/, // assistant de modules (claude-cli, recherche web ; écrit dans la bibliothèque partagée)
  /^\/modules\/drafts(\/|$)/,
  /^\/projects\/[^/]+\/target-preview\/triage$/, // pré-tri Ollama
  /^\/hub\/account$/, // connexion au Hub par le trousseau
  /^\/hub\/publish(\/|$)/,
  /^\/hub\/telemetry$/,
];

export type RouteDecision = "allow" | "disabled" | "unknown";

/** Décision pour une route du tableau de bord (`path` sans le préfixe /api). */
export function routePolicy(method: string, path: string): RouteDecision {
  const p = path.length > 1 ? path.replace(/\/+$/, "") : path;
  if (DISABLED.some((re) => re.test(p))) return "disabled";
  if (p.split("/").some((s) => s === ".." || s === ".")) return "unknown";
  return ALLOWED.some((r) => r.method === method && r.re.test(p)) ? "allow" : "unknown";
}

const KNOWN_WORDS = new Set([
  "api", "meta", "projects", "studies", "personas", "modules", "hub", "jobs", "me", "engine", "session", "compare", "estimate", "run", "log", "progress",
  "summary", "responses", "recoded", "recode", "recommendations", "create-study", "pitch", "protocol", "suggest", "target-preview", "triage",
  "target-suggestion", "blocks", "validate", "check", "dismiss", "neutralize", "overview", "import", "preview", "catalog", "sync", "pull", "export",
  "drafts", "status", "revise", "accept", "yaml", "setup", "account", "publish", "telemetry", "target", "assets", "favicon.svg",
]);

/** Chemin journalisé sans identifiant ni contenu de projet : les segments inconnus deviennent « :id ». */
export function maskedPath(path: string): string {
  return path
    .split("?")[0]!
    .split("/")
    .map((s) => (s === "" || KNOWN_WORDS.has(s) ? s : ":id"))
    .join("/");
}
