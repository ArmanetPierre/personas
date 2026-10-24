<!-- version: 2026-10-24 -->
# Privacy of Personas online

Personas online is the hosted version of the Personas simulator: you use it in the browser, with nothing to install. Unlike the local application, **your projects are stored on the operator's server**. This page explains what is kept, where, and who receives it.

## What the service keeps

- **Account**: e-mail address, sign-in identifier, GitHub id and username if you sign in with GitHub, creation and last sign-in dates. No password: you sign in with a link sent by e-mail or with GitHub (Supabase Auth).
- **Your content**: projects, pitches, offers, targets, studies, persona responses and narratives, modules and settings. They are stored on the operator's server, **in a separate database for each account**. No other user can access them.
- **Your AI key**: **encrypted on the server**, used only for your studies. It is never shown again: only its last 4 characters are displayed. The provider, the model and your spending caps are kept with it.
- **Technical logs**: method, path, status and duration of requests, without their content or your key, for a limited time, for security and troubleshooting.

Your content and your key are kept as long as your account exists, and erased when you delete it. Your e-mail address and sign-in identifier remain recorded in the sign-in service (Supabase Auth) after the deletion, until the operator erases them. After the deletion, the server keeps only the fingerprint (SHA-256) of the account identifier and of its e-mail address, with the day of the deletion, with no time limit, to refuse any new sign-in: a deleted address can no longer be used on this service; write to the operator to reactivate it.

## Your AI provider receives your study data

When you run a study, the server calls **the AI provider you chose** (Anthropic, OpenAI, Google Gemini or OpenRouter) with your key. It sends what the study needs: the pitch, the offer and its price, the target description, the persona profiles and the questions.

**That provider becomes a recipient of this data.** It processes it under its own terms and privacy policy, which apply to your account with it. Do not put anything in a project that you do not want to entrust to it, in particular no personal data about other people.

## What the service does not do

- No tracking cookie, no advertising, no audience measurement. A single session cookie, required to stay signed in.
- The interface theme and language are kept in your browser, not on the server.
- No data is sold or shared for commercial purposes.

## Hosting and service providers

The service and its authentication (Supabase) run on a server of the operator. The sign-in link is sent by an e-mail delivery provider, which only receives your address. The AI providers are the ones you choose (see above).

## Self-service export and deletion

- **Export**: in "My account", "Download the export" gives you a file with your projects, studies, responses and settings (without the AI key).
- **Delete**: in "My account", "Delete my account" immediately erases your content and your AI key, and closes your session; any sign-in to this account, or with the same address, is then refused with no time limit. A deleted address can no longer be used on this service; write to the operator (pierre.armanet.pa@gmail.com) to reactivate it, or to have your address erased from the sign-in service too. Server backups are continuously renewed: a copy may remain there for a few days before it disappears.
- **AI key**: in "My AI key", you can replace or delete it at any time.

## Your rights

Access, rectification, erasure, portability, objection: use the export and deletion above, or write to pierre.armanet.pa@gmail.com. You may also lodge a complaint with your data protection authority.
