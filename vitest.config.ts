import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "hub/test/**/*.test.ts"],
    environment: "node",
    // Délai par test : la suite complète tourne en parallèle, et les tests qui chargent la bibliothèque de
    // modules (plus de vingt YAML validés), tirent des milliers de personas ou démarrent PGlite dépassent
    // les 5 s par défaut sous charge sans être bloqués. Un vrai blocage échoue toujours.
    testTimeout: 30_000,
  },
});
