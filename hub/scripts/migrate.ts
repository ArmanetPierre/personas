import { openPostgres } from "../db/client";

/** Applique les migrations du Hub (schéma personas_hub) sur DATABASE_URL. */
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL manquant.");
  process.exit(2);
}
const { close } = await openPostgres(url, { migrate: true, max: 1 });
await close();
console.log("Migrations du Hub appliquées (schéma personas_hub).");
