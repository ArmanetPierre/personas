/** Intervalle de Wilson à 95 % d'une proportion k/n. */
export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (!n) return [0, 1];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  const r = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 10000) / 10000;
  return [r(c - h), r(c + h)];
}
