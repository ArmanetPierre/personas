/**
 * Filtre d'éligibilité d'une cible, écrit comme une phrase :
 *   age >= 25 and age <= 45 and numerique.is_digital_worker and entrepreneuriat.stage != none
 *
 * Grammaire : expr := and ("or" and)* ; and := not ("and" not)* ; not := "not" not | primaire ;
 * primaire := "(" expr ")" | variable [opérateur valeur] ; opérateurs : == (ou =), !=, <, <=, >, >=,
 * in [a, b], not in [a, b]. Une variable seule vaut vrai si elle est vraie, non nulle et non vide.
 * Les valeurs sont des nombres, des chaînes entre guillemets ou des codes nus (none, cadre…).
 */

export type Vars = Record<string, unknown>;

/** Arbre d'une phrase d'éligibilité (lecture en clair : src/web/modules.ts). */
export type EligibilityNode =
  | { kind: "or" | "and"; items: Node[] }
  | { kind: "not"; item: Node }
  | { kind: "truthy"; name: string }
  | { kind: "cmp"; name: string; op: "==" | "!=" | "<" | "<=" | ">" | ">="; value: string | number | boolean }
  | { kind: "in"; name: string; values: Array<string | number | boolean>; negate: boolean };

export class EligibilityError extends Error {
  override name = "EligibilityError";
}

type Node = EligibilityNode;

interface Token {
  t: "id" | "num" | "str" | "op" | "(" | ")" | "[" | "]" | ",";
  v: string;
}

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  const re = /\s*(?:(\d+(?:\.\d+)?)|("[^"]*"|'[^']*')|(==|!=|<=|>=|<|>|=)|([()[\],])|([A-Za-z_][A-Za-z0-9_.\/-]*))/y; // « / » : module tiers (alice/sport.attr)
  let i = 0;
  while (i < src.length) {
    if (/^\s*$/.test(src.slice(i))) break;
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) throw new EligibilityError(`Filtre d'éligibilité : caractère inattendu à la position ${i} : « ${src.slice(i, i + 12)} »`);
    i = re.lastIndex;
    if (m[1]) out.push({ t: "num", v: m[1] });
    else if (m[2]) out.push({ t: "str", v: m[2].slice(1, -1) });
    else if (m[3]) out.push({ t: "op", v: m[3] === "=" ? "==" : m[3] });
    else if (m[4]) out.push({ t: m[4] as Token["t"], v: m[4] });
    else if (m[5]) out.push({ t: "id", v: m[5] });
  }
  return out;
}

export interface CompiledEligibility {
  source: string;
  /** Variables citées (pour vérifier qu'elles existent). */
  variables: string[];
  /** Valeurs comparées par variable (==, !=, in, not in ; pas les seuils numériques), pour vérifier les codes. */
  literals: Record<string, Array<string | number | boolean>>;
  test: (vars: Vars) => boolean;
  /** Arbre analysé (affichage en clair). */
  ast: EligibilityNode;
}

export function compileEligibility(source: string, known?: Set<string>): CompiledEligibility {
  const toks = tokenize(source);
  let pos = 0;
  const vars = new Set<string>();
  const peek = () => toks[pos];
  const isKw = (w: string) => peek()?.t === "id" && peek()!.v.toLowerCase() === w;
  const expect = (t: Token["t"], v?: string) => {
    const tok = toks[pos];
    if (!tok || tok.t !== t || (v && tok.v !== v)) throw new EligibilityError(`Filtre d'éligibilité : « ${v ?? t} » attendu${tok ? ` au lieu de « ${tok.v} »` : " en fin de phrase"}`);
    pos++;
    return tok;
  };
  const value = (): string | number | boolean => {
    const tok = toks[pos++];
    if (!tok) throw new EligibilityError("Filtre d'éligibilité : valeur attendue en fin de phrase");
    if (tok.t === "num") return Number(tok.v);
    if (tok.t === "str") return tok.v;
    if (tok.t === "id") return tok.v === "true" ? true : tok.v === "false" ? false : tok.v;
    throw new EligibilityError(`Filtre d'éligibilité : valeur attendue au lieu de « ${tok.v} »`);
  };
  const list = () => {
    expect("[");
    const vs: Array<string | number | boolean> = [];
    while (peek() && peek()!.t !== "]") {
      vs.push(value());
      if (peek()?.t === ",") pos++;
    }
    expect("]");
    return vs;
  };
  const primary = (): Node => {
    if (peek()?.t === "(") {
      pos++;
      const e = orExpr();
      expect(")");
      return e;
    }
    const name = expect("id").v;
    if (["and", "or", "not", "in"].includes(name.toLowerCase())) throw new EligibilityError(`Filtre d'éligibilité : variable attendue au lieu de « ${name} »`);
    vars.add(name);
    if (peek()?.t === "op") {
      const op = toks[pos++]!.v as "==" | "!=" | "<" | "<=" | ">" | ">=";
      return { kind: "cmp", name, op, value: value() };
    }
    if (isKw("in")) {
      pos++;
      return { kind: "in", name, values: list(), negate: false };
    }
    if (isKw("not") && toks[pos + 1]?.t === "id" && toks[pos + 1]!.v.toLowerCase() === "in") {
      pos += 2;
      return { kind: "in", name, values: list(), negate: true };
    }
    return { kind: "truthy", name };
  };
  const notExpr = (): Node => {
    if (isKw("not")) {
      pos++;
      return { kind: "not", item: notExpr() };
    }
    return primary();
  };
  const andExpr = (): Node => {
    const items = [notExpr()];
    while (isKw("and")) {
      pos++;
      items.push(notExpr());
    }
    return items.length === 1 ? items[0]! : { kind: "and", items };
  };
  const orExpr = (): Node => {
    const items = [andExpr()];
    while (isKw("or")) {
      pos++;
      items.push(andExpr());
    }
    return items.length === 1 ? items[0]! : { kind: "or", items };
  };
  const ast = orExpr();
  if (pos < toks.length) throw new EligibilityError(`Filtre d'éligibilité : « ${toks[pos]!.v} » inattendu`);
  if (known) {
    const unknown = [...vars].filter((v) => !known.has(v));
    if (unknown.length) {
      throw new EligibilityError(`Filtre d'éligibilité : variable(s) inconnue(s) : ${unknown.join(", ")}. Disponibles : ${[...known].sort().join(", ")}`);
    }
  }
  const same = (a: unknown, b: unknown) => a === b || (a !== null && a !== undefined && String(a) === String(b));
  const evalNode = (n: Node, v: Vars): boolean => {
    switch (n.kind) {
      case "or":
        return n.items.some((x) => evalNode(x, v));
      case "and":
        return n.items.every((x) => evalNode(x, v));
      case "not":
        return !evalNode(n.item, v);
      case "truthy": {
        const x = v[n.name];
        return !(x === undefined || x === null || x === false || x === 0 || x === "" || x === "none" || (Array.isArray(x) && !x.length));
      }
      case "in": {
        const x = v[n.name];
        const hit = Array.isArray(x) ? x.some((e) => n.values.some((w) => same(e, w))) : n.values.some((w) => same(x, w));
        return n.negate ? !hit : hit;
      }
      case "cmp": {
        const x = v[n.name];
        switch (n.op) {
          case "==":
            return same(x, n.value);
          case "!=":
            return !same(x, n.value);
          default: {
            if (x === null || x === undefined) return false;
            const a = Number(x);
            const b = Number(n.value);
            return n.op === "<" ? a < b : n.op === "<=" ? a <= b : n.op === ">" ? a > b : a >= b;
          }
        }
      }
    }
  };
  const literals: Record<string, Array<string | number | boolean>> = {};
  const collect = (n: Node): void => {
    if (n.kind === "or" || n.kind === "and") n.items.forEach(collect);
    else if (n.kind === "not") collect(n.item);
    else if (n.kind === "in") (literals[n.name] ??= []).push(...n.values);
    else if (n.kind === "cmp" && (n.op === "==" || n.op === "!=")) (literals[n.name] ??= []).push(n.value);
  };
  collect(ast);
  return { source, variables: [...vars], literals, test: (v) => evalNode(ast, v), ast };
}
