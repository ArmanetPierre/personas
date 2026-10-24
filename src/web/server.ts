import { WEB_PORT } from "./context";
import { MissingBuildError, startDashboard } from "./serve";

/** `npm run start:web` : l'API et le build du front (web/dist) sur un seul port (PERSONAS_WEB_PORT, 5173 par défaut). */

try {
  const d = await startDashboard({ port: WEB_PORT });
  console.log(`Personas — tableau de bord : http://localhost:${d.port}`);
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => (d.close(), process.exit(0)));
} catch (err) {
  console.error(err instanceof MissingBuildError ? err.message : (err as Error).message);
  process.exit(1);
}
