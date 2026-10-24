# Personas Hub

The Hub is the public library of Personas: persona modules and country packs, with immutable versions, a quality score recomputed by the server, full-text search and simple public pages. This directory is the service: public API and pages, publication with an administration token, and (phase 3) accounts, personal tokens, user publication, forks, stars, reviews, reports and moderation.

Licence: **AGPL-3.0** for this directory ([LICENSE](LICENSE)). The engine it imports from `src/` is Apache-2.0; modules and packs are CC BY 4.0.

## What it does

- **Read API** (anonymous, CORS open, rate limited), contract in [`src/hub/contract.ts`](../src/hub/contract.ts):
  - `GET /v1/catalog`: full index of modules and packs, with `ETag` / `If-None-Match` (304) and a short cache.
  - `GET /v1/modules/:ns/:slug`: module card with every version (archived ones included).
  - `GET /v1/modules/:ns/:slug/:version`: exact published YAML, its SHA-256, pinned `requires`, quality score, status, licence.
  - `GET /v1/packs/:ns/:slug/:version`: exact JSON files of a pack version, canonical SHA-256 (sorted names, `name\n` + content + `\n`), `extends`.
  - `GET /v1/search?q=&socle=&lang=&limit=`: PostgreSQL full-text search (`french` and `english` configurations) over label, description, attribute and value labels, segments; filter by base population and by content language (`lang=fr|en`, derived from the base populations of the module and the `locale` of their pack manifests); sorted by the ranking R (default, `sort=r`) or by Q (`sort=q`). Catalogue cards and search results carry an optional `locale`, packs an optional `generator` (additive fields). Optional `prefer=en|fr` on `/v1/search` and `/v1/catalog` (additive): modules whose base population is in that language come first, then the others, each group in the usual order (R or Q); nothing is filtered out, `lang=` stays the filter, and without `prefer` the order is unchanged.
- **Administration** (`Authorization: Bearer $HUB_ADMIN_TOKEN`, compared in constant time, never logged):
  - `POST /v1/admin/modules` `{namespace, yaml}` (256 KB max): the Hub re-validates the module with the engine (schema, semantic checks, pinned dependencies, eligibility helpers), runs the preview on 10,000 virtual personas, refuses it (422) on any validation error or `error` alert, computes Q, and stores the exact text. A version already published returns 409: versions are immutable (also enforced by a database trigger).
  - `POST /v1/admin/packs` `{namespace, slug, version, files, extends}` (5 MB max): JSON files only, manifest and tables validated by the generator's schema (inherited tables from `extends` included), modules of the manifest must be published first.
- **Pages** (server-rendered HTML, no JavaScript, light and dark modes, same design tokens and fonts as the local dashboard: `web/src/tokens.css` is shared, the stylesheet and fonts are served from `/assets/` under a strict CSP without inline styles): `/` (modules with search and language / base population filters as links, `?q=&lang=&socle=`; country packs) and `/m/:ns/:slug` (description, base populations, language, decomposed Q, main margins, attributes, preview alerts, versions, install command). Interface in French or English: `?ui=fr|en` (remembered in a cookie), otherwise `Accept-Language`; module content stays in its own language. The index puts modules (and country packs) in the interface language first, then the others, in the chosen sort; an explicit language filter takes precedence and the counts do not change.
- `GET /healthz` for the container health check.

Status of a version: `verified` for the official `personas` namespace, `unverified` otherwise, `yanked` for an archived module (hidden from the index and the search, still downloadable by its exact reference).

### Collaborative Hub (phase 3)

Routes in [`src/routes/`](src/routes/index.ts), additive schemas at the end of the contract. Authentication: `Authorization: Bearer <token>`, either a **Supabase Auth JWT** (web session; checked by JWKS or the HS256 secret, issuer, audience `authenticated` and expiry verified) or a **personal token** `pst_…` (32 random bytes, stored as a SHA-256 hash, scopes `read`, `modules:publish`, `packs:publish`, `moderation`, 90 days at most, revocable). Sign-ups are closed: there is no sign-up endpoint, the Hub accepts any valid Supabase user (invited by the administrator) and creates the account and a personal namespace on the first authenticated call.

- Account: `GET/PATCH/DELETE /v1/me` (namespace renamable once while empty; self-service deletion keeps published versions, attributed to "deleted author"), `GET/POST /v1/me/tokens`, `DELETE /v1/me/tokens/:id`.
- Device flow for `personas hub login`: `POST /v1/device/code` → `{device_code, user_code, verification_uri, interval}`; `POST /v1/device/lookup` and `/v1/device/approve` (web session, called by the `/device` page); `POST /v1/device/token` (polling: 202 pending or slow_down, 200 with the personal token, 410 denied or expired).
- Publication in one's own namespace: `POST /v1/modules`, `POST /v1/packs` (data only, existing generator), `POST /v1/modules/:ns/:slug/fork` (`forked_from` lineage). Same gate as administration plus the mandatory **security lint** (`src/modules/lint.ts`). New versions are visible right away as `unverified`.
- Stars `PUT/DELETE /v1/modules/:ns/:slug/star`, reviews `PUT/DELETE /v1/modules/:ns/:slug/:version/review`, `GET …/reviews`; ranking **R** = 0.45·Q/100 + 0.25·U + 0.15·E + 0.15·N (+0.05 verified), default sort of `/v1/search` (`sort=r|q`) and `/v1/catalog`.
- Reports `POST /v1/reports` (3 distinct reports flag a version, or hide a review); moderation `GET /v1/admin/review-queue`, `POST /v1/admin/moderation-events` (verify, flag, yank, remove, restore, with evidence), with `HUB_ADMIN_TOKEN` or the `moderation` scope. `flagged` versions leave the index; `removed` ones can no longer be downloaded (410).
- Opt-in telemetry `POST /v1/telemetry` (strict schema, no free text, rotating install id never linked to an account): daily aggregates per version (`usage_daily`), feeding U.
- Ed25519 signature of every version over `{ref, version, sha256, publishedAt}` (`signature` field), public key on `GET /v1/keys`; versions published before the key are signed at start-up.
- Terms and privacy policy (French and English markdown, [`legal/`](legal/)): `GET /v1/legal`, `GET /v1/legal/:doc?lang=fr|en`.

### Quality score Q (formula `q1`)

`Q = 100 × (0.35·S + 0.30·M + 0.20·A + 0.15·D)`, recomputed by the Hub on CPU, without any language model:

- **S, sourcing**: 1 per attribute citing sources without being an assumption, 0.5 when it cites sources but is marked `assumption`, 0 otherwise; weighted by the number of personas the attribute applies to; each table counts as an average attribute.
- **M, margin checks**: coverage (share of enum and set attributes targeted by `validation`) × success (share of declared margins, shares and plausibility checks passed on the virtual personas). 0 without any check.
- **A, preview alerts**: `1 − min(1, Σ weights / 5)`; weight 1 for a very rare value, a value never drawn, an attribute never present or a conditioning without effect; weight 2 for a declared target not reached or a work-related attribute given to people without a job.
- **D, documentation**: description over 80 characters, changelog, card lines, at least one segment.

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string. Everything lives in the dedicated schema `personas_hub` (migrations table included). |
| `HUB_ADMIN_TOKEN` | for publishing | Administration token, 32 characters or more (`openssl rand -hex 32`). Unset: publication is disabled (403). |
| `PUBLIC_BASE_URL` | recommended | Public address, used for canonical links, e.g. `https://persona.armanet.xyz`. |
| `PORT`, `HOST` | no | Default `8080`, `0.0.0.0`. |
| `TRUST_PROXY` | no | `1` behind a reverse proxy: the client IP for rate limiting is read from `CF-Connecting-IP` or `X-Forwarded-For`. |
| `HUB_RATE_READ`, `HUB_RATE_ADMIN` | no | Requests per minute and per IP (default 600 and 60). |
| `HUB_MIGRATE` | no | `0` to skip migrations at start-up (default: applied). |
| `SUPABASE_URL` | for accounts | Supabase base URL: issuer `<url>/auth/v1`, JWKS `<url>/auth/v1/.well-known/jwks.json`. Unset: only personal tokens are accepted (and none can be created). |
| `SUPABASE_JWT_SECRET` | no | HS256 secret of the Supabase project (legacy symmetric keys); otherwise JWKS. |
| `SUPABASE_JWKS_URL`, `SUPABASE_JWT_ISSUER`, `SUPABASE_JWT_AUDIENCE` | no | Overrides (audience default `authenticated`). |
| `HUB_ADMINS`, `HUB_MODERATORS` | no | Comma-separated e-mails or Supabase user ids given the `admin` (publishes under `personas`) or `moderator` role. |
| `HUB_SIGNING_KEY` | recommended | Ed25519 signing key: 32-byte seed in base64 (`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`) or PKCS#8. Unset: versions are not signed. |
| `HUB_RATE_WRITE` | no | Authenticated writes per minute and per user (default 30). |

## Database

PostgreSQL 15 or later. The Hub only touches the schema `personas_hub`, so it can share a database with other applications (for instance a self-hosted Supabase). Recommended: a dedicated role that owns this schema and nothing else, and do **not** add `personas_hub` to the schemas exposed by PostgREST.

```sql
create role personas_hub login password '…';
create schema personas_hub authorization personas_hub;
```

Migrations (generated by Drizzle Kit from [`db/schema.ts`](db/schema.ts), in [`db/migrations/`](db/migrations/)) run at start-up, or explicitly:

```sh
DATABASE_URL=… npm run hub:migrate
npm run hub:db:generate   # after a change to hub/db/schema.ts
```

Semantic search (pgvector, a small multilingual embedding model on CPU) is planned: the column and the model are not part of phase 2, so `pgvector` is not required yet.

### Backups

Published versions are immutable and pinned by users' studies: losing them breaks reproducibility. Dump the Hub schema every night, keep an encrypted off-site copy, and test a restore regularly.

```sh
pg_dump --schema=personas_hub --format=custom --file="hub-$(date +%F).dump" "$DATABASE_URL"
# restore into an empty database or schema
pg_restore --clean --if-exists --no-owner --dbname="$RESTORE_URL" hub-YYYY-MM-DD.dump
```

## Running

```sh
npm ci
DATABASE_URL=… HUB_ADMIN_TOKEN=… npm run hub:start      # or hub:dev (watch mode)
```

With Docker (build context: the repository root, since the Hub imports the engine):

```sh
cp hub/.env.example hub/.env      # fill in the values; never commit it
docker compose -f hub/docker-compose.yml up -d --build
curl -fsS http://127.0.0.1:8080/healthz
```

The compose file runs the Hub alone, read-only, bound to the loopback interface: put your TLS reverse proxy in front of it and set `TRUST_PROXY=1` (already set in the compose file).

### Seeding the official library

`hub/scripts/seed-official.ts` publishes under `personas/` the validated modules of `modules/` (not the drafts), the archived `entrepreneuriat-tech` module (status `yanked`), then the country packs `fr`, `fr-2026.2`, `fr-tech-founders`, `sg` and `sg-2026.2` with their `extends`. Already published versions are skipped, so it can be re-run.

```sh
npm run hub:seed -- --dry-run                                   # list what would be published
HUB_URL=https://… HUB_ADMIN_TOKEN=… npm run hub:seed
```

## Tests

`npm run hub:test` (also part of `npm test`) runs the service against an embedded PostgreSQL (PGlite): no Docker, no network. The suite seeds the official library, then checks the contract schemas, ETags, immutability (409 and database trigger), 401/403, 422 gates, Q values, search (language filter included), pages, filters, interface language and assets. `npm run hub:demo` serves the same seeded library locally (PGlite in memory, `PORT`, 8791 by default) to look at the pages.

## Limits (phase 2)

- One process: the rate limiter and the catalogue cache are in memory.
- No accounts: only the administration token can publish; namespaces are created on first publication.
- Pack versions are checked against the generator's schema; the margin validation on virtual personas (`validation` of a pack version) comes later.
- The `research.json` bonus of S is not applied (the publication request does not carry it).
