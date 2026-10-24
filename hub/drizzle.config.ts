import { defineConfig } from "drizzle-kit";

// Migrations du Hub (Postgres, schéma dédié personas_hub). Génération : npm run hub:db:generate.
export default defineConfig({
  dialect: "postgresql",
  schema: "./hub/db/schema.ts",
  out: "./hub/db/migrations",
  schemaFilter: ["personas_hub"],
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://localhost/personas_hub_dev" },
});
