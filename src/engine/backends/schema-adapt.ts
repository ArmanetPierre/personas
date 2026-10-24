/**
 * Adaptation du JSON Schema (draft-7, produit par `z.toJSONSchema` dans l'Engine) aux modes natifs
 * des fournisseurs (docs/plateforme.md § 7.2). Le schéma d'origine reste la référence : zod valide
 * toujours la réponse et la boucle de réparation de l'Engine reste le filet de sécurité.
 */

type Json = Record<string, unknown>;

export class SchemaAdaptError extends Error {
  override name = "SchemaAdaptError";
}

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** Bornes entières sans contenu que zod ajoute à `z.number().int()` (±2^53 - 1). */
const isSafeIntBound = (v: unknown) => v === Number.MAX_SAFE_INTEGER || v === Number.MIN_SAFE_INTEGER;

function resolveRef(root: Json, ref: string): Json {
  const m = /^#\/(definitions|\$defs)\/(.+)$/.exec(ref);
  const defs = m ? (root[m[1]!] as Json | undefined) : undefined;
  const target = m && defs ? defs[decodeURIComponent(m[2]!)] : undefined;
  if (!isObj(target)) throw new SchemaAdaptError(`Référence introuvable : ${ref}`);
  return target;
}

/** Schéma pour un outil Anthropic (`input_schema`) : sans `$schema` ni valeurs par défaut. */
export function toToolInputSchema(schema: Json): Json {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!isObj(node)) return node;
    const out: Json = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "$schema" || k === "default") continue;
      out[k] = k === "properties" || k === "definitions" || k === "$defs" ? mapValues(v, walk) : walk(v);
    }
    return out;
  };
  const out = walk(schema) as Json;
  if (out.type !== "object") throw new SchemaAdaptError("Le schéma d'un outil doit être un objet à la racine.");
  return out;
}

function mapValues(v: unknown, f: (x: unknown) => unknown): unknown {
  if (!isObj(v)) return v;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, f(x)]));
}

// ─── OpenAI : mode strict ────────────────────────────────────────────────────

/** Mots-clés acceptés par le mode strict d'OpenAI (Structured Outputs). Les autres sont retirés. */
const OPENAI_KEYS = new Set([
  "type", "properties", "required", "additionalProperties", "items", "enum", "const", "anyOf",
  "description", "$ref", "definitions", "$defs",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "minItems", "maxItems", "pattern", "format",
]);

/** Mots-clés de structure que le mode strict ne sait pas exprimer : la transformation échoue (repli JSON). */
const OPENAI_UNSUPPORTED = ["propertyNames", "patternProperties", "allOf", "oneOf", "not", "if", "then", "else", "dependencies", "contains"];

const allowsNull = (node: Json): boolean => {
  if (node.type === "null") return true;
  if (Array.isArray(node.type) && node.type.includes("null")) return true;
  if (Array.isArray(node.anyOf)) return node.anyOf.some((b) => isObj(b) && allowsNull(b));
  if (Array.isArray(node.enum)) return node.enum.includes(null);
  return false;
};

function makeNullable(node: Json): Json {
  if (allowsNull(node)) return node;
  if (typeof node.type === "string" && !node.anyOf && !node.enum && !node.$ref && node.const === undefined) {
    return { ...node, type: [node.type, "null"] };
  }
  const { description, ...rest } = node;
  return { anyOf: [rest, { type: "null" }], ...(description !== undefined && { description }) };
}

/**
 * Schéma pour `response_format: json_schema` en mode strict : toutes les propriétés requises, les
 * facultatives en union avec `null`, `additionalProperties: false`, sans `default` ni mot-clé non pris
 * en charge. Lève `SchemaAdaptError` si la forme n'est pas exprimable (dictionnaire libre, `oneOf`…).
 */
export function toOpenAiStrictSchema(schema: Json): Json {
  const walk = (node: unknown, path: string): unknown => {
    if (Array.isArray(node)) return node.map((n, i) => walk(n, `${path}[${i}]`));
    if (!isObj(node)) return node;
    for (const k of OPENAI_UNSUPPORTED) {
      if (k in node) throw new SchemaAdaptError(`Mot-clé « ${k} » non pris en charge par le mode strict (${path || "racine"})`);
    }
    const out: Json = {};
    for (const [k, v] of Object.entries(node)) {
      if (!OPENAI_KEYS.has(k)) continue;
      if ((k === "minimum" || k === "maximum") && isSafeIntBound(v)) continue;
      if (k === "properties" || k === "definitions" || k === "$defs") {
        out[k] = Object.fromEntries(Object.entries(v as Json).map(([pk, pv]) => [pk, walk(pv, `${path}.${pk}`)]));
      } else if (k === "additionalProperties") {
        if (v !== false && !(isObj(v) && Object.keys(v).length === 0 && node.properties)) {
          throw new SchemaAdaptError(`Dictionnaire libre (additionalProperties) non pris en charge par le mode strict (${path || "racine"})`);
        }
      } else {
        out[k] = walk(v, path);
      }
    }
    const isObject = node.type === "object" || (Array.isArray(node.type) && node.type.includes("object")) || isObj(node.properties);
    if (isObject) {
      const props = (out.properties as Json | undefined) ?? {};
      const required = new Set(Array.isArray(node.required) ? (node.required as string[]) : []);
      out.properties = Object.fromEntries(
        Object.entries(props).map(([pk, pv]) => [pk, required.has(pk) ? pv : makeNullable(pv as Json)]),
      );
      out.required = Object.keys(props);
      out.additionalProperties = false;
    }
    return out;
  };
  const out = walk(schema, "") as Json;
  if (out.type !== "object") throw new SchemaAdaptError("Le mode strict exige un objet à la racine.");
  return out;
}

/**
 * Normalisation des `null` avant zod : un champ facultatif rendu en union avec `null` par le mode strict
 * revient `null` quand le modèle l'omet ; on le retire si le schéma d'origine n'accepte pas `null`.
 */
export function normalizeNulls(value: unknown, schema: Json, root: Json = schema): unknown {
  let node = schema;
  if (typeof node.$ref === "string") node = resolveRef(root, node.$ref);
  if (Array.isArray(value)) {
    const items = node.items;
    return isObj(items) ? value.map((v) => normalizeNulls(v, items, root)) : value;
  }
  if (!isObj(value)) return value;
  if (Array.isArray(node.anyOf)) {
    const branch = node.anyOf.find((b) => isObj(b) && (b.type === "object" || isObj(b.properties) || typeof b.$ref === "string"));
    return isObj(branch) ? normalizeNulls(value, branch, root) : value;
  }
  const props = isObj(node.properties) ? node.properties : undefined;
  if (!props) return value;
  const required = new Set(Array.isArray(node.required) ? (node.required as string[]) : []);
  const out: Json = {};
  for (const [k, v] of Object.entries(value)) {
    const ps = props[k];
    if (v === null && !required.has(k) && isObj(ps) && !allowsNull(ps.$ref ? resolveRef(root, ps.$ref as string) : ps)) continue;
    out[k] = isObj(ps) ? normalizeNulls(v, ps, root) : v;
  }
  return out;
}

// ─── Gemini : schéma de réponse (sous-ensemble d'OpenAPI 3.0) ────────────────

const GEMINI_TYPES: Record<string, string> = {
  string: "STRING", number: "NUMBER", integer: "INTEGER", boolean: "BOOLEAN", array: "ARRAY", object: "OBJECT",
};

/**
 * Conversion vers `generationConfig.responseSchema` de Gemini : types en capitales, `nullable` au lieu
 * des unions avec `null`, `$ref` développées (pas de récursion), énumérations en chaînes, ordre des
 * propriétés conservé (`propertyOrdering`). Lève `SchemaAdaptError` sur une forme non exprimable.
 */
export function toGeminiSchema(schema: Json): Json {
  const walk = (input: unknown, path: string, seen: string[]): Json => {
    if (!isObj(input)) throw new SchemaAdaptError(`Schéma invalide (${path || "racine"})`);
    let node = input;
    if (typeof node.$ref === "string") {
      if (seen.includes(node.$ref)) throw new SchemaAdaptError(`Schéma récursif non pris en charge par Gemini (${node.$ref})`);
      seen = [...seen, node.$ref];
      node = { ...resolveRef(schema, node.$ref), ...(node.description !== undefined && { description: node.description }) };
    }
    for (const k of ["propertyNames", "patternProperties", "allOf", "oneOf", "not", "if"]) {
      if (k in node) throw new SchemaAdaptError(`Mot-clé « ${k} » non pris en charge par Gemini (${path || "racine"})`);
    }
    if (isObj(node.additionalProperties)) {
      throw new SchemaAdaptError(`Dictionnaire libre non pris en charge par Gemini (${path || "racine"})`);
    }
    const desc = typeof node.description === "string" ? { description: node.description } : {};

    // Unions : une branche + null → nullable ; sinon anyOf converti
    if (Array.isArray(node.anyOf)) {
      const branches = node.anyOf.filter(isObj);
      const nonNull = branches.filter((b) => b.type !== "null");
      const nullable = nonNull.length < branches.length;
      if (nonNull.length === 1) return { ...walk(nonNull[0], path, seen), ...(nullable && { nullable: true }), ...desc };
      return { anyOf: nonNull.map((b, i) => walk(b, `${path}|${i}`, seen)), ...(nullable && { nullable: true }), ...desc };
    }
    let type = node.type;
    let nullable = false;
    if (Array.isArray(type)) {
      const t = type.filter((x) => x !== "null");
      nullable = t.length < type.length;
      if (t.length !== 1) throw new SchemaAdaptError(`Type multiple non pris en charge par Gemini (${path || "racine"})`);
      type = t[0];
    }
    if (node.const !== undefined) return { type: "STRING", enum: [String(node.const)], ...desc };
    if (Array.isArray(node.enum)) {
      const values = node.enum.filter((v) => v !== null);
      if (values.some((v) => typeof v !== "string")) throw new SchemaAdaptError(`Énumération non textuelle non prise en charge par Gemini (${path || "racine"})`);
      return { type: "STRING", enum: values, ...((nullable || values.length < node.enum.length) && { nullable: true }), ...desc };
    }
    const gType = typeof type === "string" ? GEMINI_TYPES[type] : undefined;
    if (!gType) throw new SchemaAdaptError(`Type non pris en charge par Gemini : ${String(type)} (${path || "racine"})`);
    const out: Json = { type: gType, ...desc, ...(nullable && { nullable: true }) };
    if (gType === "OBJECT") {
      const props = isObj(node.properties) ? node.properties : {};
      out.properties = Object.fromEntries(Object.entries(props).map(([k, v]) => [k, walk(v, `${path}.${k}`, seen)]));
      out.required = Array.isArray(node.required) ? node.required : [];
      out.propertyOrdering = Object.keys(props);
    } else if (gType === "ARRAY") {
      if (!isObj(node.items)) throw new SchemaAdaptError(`Tableau sans « items » (${path || "racine"})`);
      out.items = walk(node.items, `${path}[]`, seen);
      for (const k of ["minItems", "maxItems"]) if (typeof node[k] === "number") out[k] = node[k];
    } else if (gType === "STRING") {
      for (const k of ["minLength", "maxLength", "pattern"]) if (node[k] !== undefined) out[k] = node[k];
      if (node.format === "date-time" || node.format === "enum") out.format = node.format;
    } else {
      for (const k of ["minimum", "maximum"]) if (typeof node[k] === "number" && !isSafeIntBound(node[k])) out[k] = node[k];
    }
    return out;
  };
  const out = walk(schema, "", []);
  if (out.type !== "OBJECT") throw new SchemaAdaptError("Gemini : objet attendu à la racine.");
  return out;
}
