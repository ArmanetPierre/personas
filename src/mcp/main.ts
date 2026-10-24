import { dirname, resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { errorText, t } from "../cli/i18n";
import { createContext, ROOT } from "../web/context";
import { createMcpServer, TOOL_NAMES } from "./server";

/**
 * Serveur MCP local en stdio : `npm run mcp` (plus tard `personas mcp`). Même base, même launcher et
 * même .env que le tableau de bord (racine du dépôt), quel que soit le dossier de lancement.
 * stdout est réservé au protocole : les messages vont sur stderr.
 */

const ctx = createContext();
const dbPath = resolve(ROOT, ctx.config.DATABASE_PATH);
const server = createMcpServer({ ...ctx, dataDir: dirname(dbPath) });

const shutdown = async () => {
  try {
    await server.close();
  } finally {
    ctx.close();
    process.exit(0);
  }
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

try {
  const transport = new StdioServerTransport();
  transport.onclose = () => ctx.close();
  await server.connect(transport);
  console.error(t.mcp.ready(dbPath, TOOL_NAMES.length));
} catch (err) {
  console.error(t.mcp.fatal(errorText(err)));
  ctx.close();
  process.exit(1);
}
