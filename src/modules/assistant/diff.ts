/** Diff ligne à ligne (plus longue sous-séquence commune), format unifié simplifié : « - » retiré, « + » ajouté. */
export function lineDiff(before: string, after: string, context = 2): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;
  // Table LCS (taille raisonnable pour un module de quelques centaines de lignes)
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const ops: Array<{ t: " " | "-" | "+"; line: string }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: " ", line: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) ops.push({ t: "-", line: a[i++]! });
    else ops.push({ t: "+", line: b[j++]! });
  }
  while (i < n) ops.push({ t: "-", line: a[i++]! });
  while (j < m) ops.push({ t: "+", line: b[j++]! });
  // Garde les lignes modifiées et leur contexte
  const keep = new Set<number>();
  ops.forEach((o, k) => {
    if (o.t !== " ") for (let d = -context; d <= context; d++) keep.add(k + d);
  });
  const out: string[] = [];
  let last = -1;
  ops.forEach((o, k) => {
    if (!keep.has(k)) return;
    if (last !== -1 && k > last + 1) out.push("…");
    out.push(`${o.t} ${o.line}`);
    last = k;
  });
  return out.join("\n");
}
