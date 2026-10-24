import { describe, expect, it } from "vitest";
import { createLimiter } from "../../src/engine/limiter";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("createLimiter", () => {
  it("ne dépasse jamais la concurrence maximale", async () => {
    const limiter = createLimiter(2);
    let active = 0;
    let peak = 0;
    const results = await Promise.all(
      Array.from({ length: 7 }, (_, i) =>
        limiter.run(async () => {
          active++;
          peak = Math.max(peak, active);
          await tick(5 + (i % 3) * 3);
          active--;
          return i;
        }),
      ),
    );
    expect(peak).toBe(2);
    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(limiter.active).toBe(0);
    expect(limiter.pending).toBe(0);
  });

  it("libère la place après une erreur (synchrone ou asynchrone)", async () => {
    const limiter = createLimiter(1);
    await expect(limiter.run(async () => Promise.reject(new Error("boum")))).rejects.toThrow("boum");
    await expect(
      limiter.run(() => {
        throw new Error("sync");
      }),
    ).rejects.toThrow("sync");
    await expect(limiter.run(async () => "ok")).resolves.toBe("ok");
  });

  it("traite la file dans l'ordre d'arrivée", async () => {
    const limiter = createLimiter(1);
    const order: number[] = [];
    await Promise.all([1, 2, 3].map((n) => limiter.run(async () => void order.push(n))));
    expect(order).toEqual([1, 2, 3]);
  });

  it("refuse une concurrence invalide", () => {
    expect(() => createLimiter(0)).toThrow();
    expect(() => createLimiter(1.5)).toThrow();
  });
});
