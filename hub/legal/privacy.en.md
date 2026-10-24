<!-- version: 2026-10-19 -->
# Personas Hub privacy policy

## What the Hub keeps

- **Account**: e-mail address, display name, GitHub id and login if you sign in with GitHub, role, creation and last sign-in dates. No password: authentication goes through Supabase Auth (magic link or GitHub).
- **Personal tokens**: name, token prefix, hash (never the token itself), scopes, expiry and last-use dates.
- **Public content**: modules, packs, reviews, stars and reports, attributed to your account.
- **Telemetry, only if you accepted it in Personas**: for each completed study, the references of the modules used, the number of personas and a few short technical fields. The Hub only keeps a daily aggregate per version (distinct installs, studies, personas). The install identifier rotates, is never linked to your account, and its hash is erased after 30 days.
- **Technical logs**: request method, path, status and duration, without body or token.

## What the Hub never receives

Your projects, pitches, offers, targets, studies, answers, narratives and API keys stay on your machine. The Hub does not see them.

## Account deletion

You can delete your account yourself (`DELETE /v1/me`). The Hub then erases your e-mail, display name and GitHub identifiers, revokes your tokens, and removes your stars and reviews. **Your published versions are kept and attributed to "deleted author"**, because studies are pinned to them and must remain reproducible; your namespace stays reserved. To also delete the sign-in account (Supabase), write to the address below.

## Processing and hosting

The Hub and its authentication (self-hosted Supabase) run on a server of the operator. No data is sold or shared for advertising.

## Your rights

Access, rectification, erasure, objection: write to pierre.armanet.pa@gmail.com.
