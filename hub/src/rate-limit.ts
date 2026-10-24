/**
 * Limitation de débit simple, en mémoire (un seul processus) : fenêtre fixe par clé (IP).
 * Suffisant pour la phase 2 ; derrière le reverse proxy, la clé est l'IP transmise (trustProxy).
 */
export class RateLimiter {
  private readonly hits = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  take(key: string): { ok: true } | { ok: false; retryAfterSec: number } {
    const t = this.now();
    if (this.hits.size > 50_000) this.sweep(t);
    const h = this.hits.get(key);
    if (!h || t - h.start >= this.windowMs) {
      this.hits.set(key, { start: t, count: 1 });
      return { ok: true };
    }
    if (h.count >= this.limit) return { ok: false, retryAfterSec: Math.max(1, Math.ceil((h.start + this.windowMs - t) / 1000)) };
    h.count++;
    return { ok: true };
  }

  private sweep(t: number) {
    for (const [k, h] of this.hits) if (t - h.start >= this.windowMs) this.hits.delete(k);
  }
}
