/**
 * Markdown restreint des textes légaux (web/src/legal/*.md) : `# titre`, `## intertitre`, paragraphes, listes `- `,
 * et un commentaire `<!-- version: AAAA-MM-JJ -->`. Le rendu (gras, code, liens) est fait par pages/Legal.tsx.
 */

export type LegalBlock = { type: "h2" | "p"; text: string } | { type: "ul"; items: string[] };

export function parseLegal(md: string): { version: string | null; title: string; blocks: LegalBlock[] } {
  const version = /<!--\s*version:\s*([\d-]+)\s*-->/.exec(md)?.[1] ?? null;
  const lines = md.replace(/<!--[\s\S]*?-->/g, "").split("\n");
  let title = "";
  const blocks: LegalBlock[] = [];
  let para: string[] = [];
  let list: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ type: "p", text: para.join(" ") });
    if (list.length) blocks.push({ type: "ul", items: list });
    para = [];
    list = [];
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) flush();
    else if (line.startsWith("# ")) {
      flush();
      title = line.slice(2);
    } else if (line.startsWith("## ")) {
      flush();
      blocks.push({ type: "h2", text: line.slice(3) });
    } else if (line.startsWith("- ")) {
      if (para.length) flush();
      list.push(line.slice(2));
    } else if (list.length && raw.startsWith("  ")) list[list.length - 1] += ` ${line}`;
    else {
      if (list.length) flush();
      para.push(line);
    }
  }
  flush();
  return { version, title, blocks };
}
