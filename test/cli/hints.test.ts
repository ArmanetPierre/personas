import { describe, expect, it } from "vitest";
import { cliCommand, localizeCommands } from "../../src/hints";
import { CLI_MESSAGES } from "../../src/cli/i18n";
import { cliMessageEn } from "../../src/cli/error-patterns";
import { BudgetExceededError, UnknownCostBlockedError } from "../../src/engine/budget";

/** Bugs B3 et B7 des tests V1 : commandes citées selon le mode (dépôt : npm run ; installé : personas). */

describe("commandes citées selon le mode", () => {
  it("cliCommand : npm run en mode dépôt, personas x y ailleurs", () => {
    expect(cliCommand("study:run", "--study st-1", "repo")).toBe("npm run study:run -- --study st-1");
    expect(cliCommand("study:run", "--study st-1", "installed")).toBe("personas study run --study st-1");
    expect(cliCommand("engine:check", "", "installed")).toBe("personas engine check");
    expect(cliCommand("engine:check", "", "repo")).toBe("npm run engine:check");
  });

  it("localizeCommands : inchangé en mode dépôt ; réécrit les formes de l'aide en mode installé", () => {
    const usage = "Usage : npm run study:create -- --project <id> --n 200 [--seed 7]";
    expect(localizeCommands(usage, "repo")).toBe(usage);
    expect(localizeCommands(usage, "installed")).toBe("Usage : personas study create --project <id> --n 200 [--seed 7]");
    expect(localizeCommands("Usage : npm run engine:check [-- --backend <b> | --profile <p>]", "installed")).toBe("Usage : personas engine check [--backend <b> | --profile <p>]");
    expect(localizeCommands("puis npm run personas:validate, then npm run personas:narrate -- --limit 5", "installed")).toBe(
      "puis personas personas validate, then personas personas narrate --limit 5",
    );
    expect(localizeCommands("npm run mcp", "installed")).toBe("personas mcp");
    // Scripts sans sous-commande personas (build, test) : laissés tels quels
    expect(localizeCommands("npm run build", "installed")).toBe("npm run build");
  });

  it("aucun message de la CLI ne garde « npm run x:y » une fois réécrit pour le paquet installé", () => {
    const texts: string[] = [];
    const visit = (v: unknown): void => {
      if (typeof v === "string") texts.push(v);
      else if (typeof v === "function") {
        try {
          const r = (v as (...a: unknown[]) => unknown)("<a>", "<b>", "<c>", "<d>");
          if (typeof r === "string") texts.push(r);
        } catch {
          // signature non textuelle : ignorée
        }
      } else if (v && typeof v === "object") for (const x of Object.values(v)) visit(x);
    };
    visit(CLI_MESSAGES);
    const left = texts.map((s) => localizeCommands(s, "installed")).filter((s) => /npm run [a-z-]+:/.test(s));
    expect(left).toEqual([]);
  });

  it("messages du plafond : commande du mode, montants lisibles (B11)", () => {
    const m = new BudgetExceededError("study", 0.0002, 0, 0.028, "t-cap").message;
    expect(m).toMatch(/0\.00 \$ engagés \+ 0\.028 \$ prévus > 0\.0002 \$/);
    expect(new UnknownCostBlockedError("m", "p", "st-1").message).toMatch(/--study st-1 --accept-unknown-cost/);
  });
});

describe("messages levés ailleurs, traduits pour la CLI anglaise (B7)", () => {
  it("hub, cible, plafond non vérifiable", () => {
    expect(cliMessageEn("Hub injoignable (http://127.0.0.1:9) : fetch failed. Hors ligne : les modules et packs déjà en cache restent utilisables.")).toBe(
      "Hub unreachable (http://127.0.0.1:9): fetch failed. Offline: modules and packs already cached remain usable.",
    );
    expect(cliMessageEn("Pas de bloc « target » dans le projet demo.")).toBe("No “target” block in project demo.");
    expect(cliMessageEn("Cache du Hub altéré : a/b@1 (sha256 abc… au lieu de def…). Supprimer /x/y puis relancer personas hub pull.")).toBe(
      "Hub cache tampered with: a/b@1 (sha256 abc… instead of def…). Delete /x/y, then run personas hub pull again.",
    );
    expect(cliMessageEn(new UnknownCostBlockedError("m", "p", "st-1").message)).not.toMatch(/[àéè]/);
  });
});
