import type { z } from "zod";

export class JsonExtractionError extends Error {
  override name = "JsonExtractionError";
}

/**
 * Extrait le premier objet ou tableau JSON d'un texte de LLM :
 * texte nu, bloc ```json```, ou JSON entouré de prose.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === "") throw new JsonExtractionError("Réponse vide");

  const direct = tryParse(trimmed);
  if (direct.ok) return direct.value;

  const fence = /```(?:json)?\s*\n?([\s\S]*?)```/i.exec(trimmed);
  if (fence?.[1]) {
    const fenced = tryParse(fence[1].trim());
    if (fenced.ok) return fenced.value;
  }

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch !== "{" && ch !== "[") continue;
    const end = findBalancedEnd(trimmed, i);
    if (end === -1) continue;
    const candidate = tryParse(trimmed.slice(i, end + 1));
    if (candidate.ok) return candidate.value;
  }

  throw new JsonExtractionError("Aucun JSON valide trouvé dans la réponse");
}

function tryParse(s: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {
    return { ok: false };
  }
}

/** Index du crochet fermant correspondant, en ignorant le contenu des chaînes. */
function findBalancedEnd(s: string, start: number): number {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") {
      if (stack.pop() !== ch) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

export type ParseOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

/** Extrait puis valide : renvoie une erreur lisible plutôt que de lever. */
export function parseWithSchema<S extends z.ZodType>(
  input: { text: string; structured?: unknown },
  schema: S,
): ParseOutcome<z.infer<S>> {
  let candidate: unknown;
  if (input.structured !== undefined) {
    candidate = input.structured;
  } else {
    try {
      candidate = extractJson(input.text);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
  const result = schema.safeParse(candidate);
  if (result.success) return { ok: true, data: result.data };
  const issues = result.error.issues
    .map((i) => `- ${i.path.length ? i.path.join(".") : "(racine)"} : ${i.message}`)
    .join("\n");
  return { ok: false, error: `Le JSON ne respecte pas le schéma :\n${issues}` };
}

/** Message de réparation renvoyé au modèle après une réponse invalide. */
export function buildRepairPrompt(error: string, jsonSchema: unknown): string {
  return [
    "Ta réponse précédente est invalide.",
    error,
    "Réponds de nouveau avec UNIQUEMENT un objet JSON valide qui respecte ce schéma, sans texte autour ni bloc de code :",
    JSON.stringify(jsonSchema),
  ].join("\n\n");
}
