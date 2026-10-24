import { describe, expect, it } from "vitest";
import { basisLine, estimateCost, formatEstimate, measureVersionOf, type ReferenceUsage } from "../../src/studies/cost";

const row = (version: string, responses: number, inputPerCall: number, socle = "fr") => ({
  protocol: "concept-price",
  version,
  socle,
  provider: "claude-cli",
  responses,
  callsPerResponse: 1.02,
  inputPerCall,
  outputPerCall: 1200,
  cacheReadPerCall: 7000,
  msPerResponse: 8000,
});

// v2 a plus de réponses que v3 : l'ancien départage par le nombre de réponses choisissait v2 pour une étude v4
const reference: ReferenceUsage = {
  version: 1,
  generatedAt: "2026-10-24",
  note: "test",
  charsPerToken: 1.2,
  protocols: [row("2", 3703, 8800), row("3", 920, 9100), row("3", 90, 7800, "sg")],
  narratives: { batchSize: 10, batches: 10, inputPerBatch: 6000, outputPerBatch: 4500, method: "test" },
};

const profile = { name: "claude-cli", provider: "claude-cli" as const, model: "sonnet" };
const base = { profile, socle: "fr", responses: 20, missingNarratives: 0, reference };

describe("base de l'estimation : v4 rattachée aux mesures v3", () => {
  it("v4 → même protocole de réponse que v3", () => {
    expect(measureVersionOf("4")).toBe("3");
    expect(measureVersionOf("3")).toBe("3");
    expect(measureVersionOf("2")).toBe("2");
  });

  it("une étude v4 s'appuie sur la ligne v3, pas sur la ligne v2 plus fournie", () => {
    const e = estimateCost({ ...base, protocolVersion: "4" });
    expect(e.basis).toMatchObject({ source: "reference", version: "3", forVersion: "4", socle: "fr", responses: 920 });
    expect(e.tokens.input).toBe(Math.round(21 * 9100));
  });

  it("v3 et v2 gardent leur propre ligne", () => {
    expect(estimateCost({ ...base, protocolVersion: "3" }).basis.version).toBe("3");
    expect(estimateCost({ ...base, protocolVersion: "2" }).basis.version).toBe("2");
  });

  it("socle sg en v4 : la ligne v3 sg", () => {
    expect(estimateCost({ ...base, socle: "sg", protocolVersion: "4" }).basis).toMatchObject({ version: "3", socle: "sg" });
  });

  it("même phrase dans la CLI (formatEstimate) et pour le tableau de bord (basisLine)", () => {
    const e = estimateCost({ ...base, protocolVersion: "4" });
    expect(basisLine(e.basis)).toBe("Base : table de référence (protocole v3, appliqué à la v4, fr, claude-cli).");
    expect(basisLine(e.basis, true)).toBe("Basis: reference table (protocol v3, applied to v4, fr, claude-cli).");
    expect(formatEstimate(e).at(-1)).toContain(basisLine(e.basis));
    expect(basisLine(estimateCost({ ...base, protocolVersion: "3" }).basis)).toBe("Base : table de référence (protocole v3, fr, claude-cli).");
  });
});
