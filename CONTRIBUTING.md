# Contributing to Personas

Thank you for considering a contribution. Personas is early-stage, so please open an issue to discuss anything larger than a small fix before you write the code.

## Ground rules

1. **Anti-sycophancy is not negotiable.** Personas is only useful if it is credibly pessimistic. Any change to a study prompt, a repair prompt, a narrative prompt, a coherence check or the way results are displayed must preserve:
   - real constraints: monthly discretionary budget, existing subscriptions, limited time, alternatives (often free);
   - behaviours over opinions, on a 7-day horizon;
   - inertia by default: indifference is the normal answer and engagement must be justified by a concrete, current need;
   - repairs that go towards caution, never towards enthusiasm;
   - the neutral-pitch guard;
   - absolute levels (trial, payment) never shown without their correction and confidence index.

   A pull request that makes personas more positive "because the results look too harsh" will be declined. If you think a rule is wrong, bring evidence: a replay against a reference, on at least 2 runs, on products with a known outcome (see [docs/study-protocol.md](docs/study-protocol.md) § 10).
2. **The LLM writes narratives, never attributes.** Persona attributes come from sourced tables and are drawn deterministically.
3. **Sources are mandatory for data.** Every table in a country pack and every attribute or table in a module cites its sources, or is marked `assumption: true` with a `justification`. No source, no merge.
4. **Identity is preserved.** Existing personas are never rewritten, and the prompts of past studies must not change. A change to drawn data goes into a new pack or module version.
5. **No secrets, no personal data.** Never commit `.env`, keys, tokens, real customer data or real study results.

## Development setup

Requirements: Node.js 22 or later.

```sh
npm ci
cp .env.example .env
npm run typecheck     # server and web/
npm test              # vitest
```

**Tests never call a real LLM.** They inject a simulated backend or client. Keep it that way: a test that needs a model is a bug. You do not need any subscription or API key to contribute code.

To try the dashboard on another port: `PERSONAS_WEB_PORT=5180 PERSONAS_API_PORT=5181 npm run dev:web`.

## What to check before opening a pull request

- `npm run typecheck` and `npm test` pass.
- **Prompt snapshots** (`test/studies/__fixtures__/`) are unchanged, unless changing a prompt is the point of your PR. In that case, regenerate them on purpose (`npx vitest run -u` updates file snapshots; fixtures compared by plain equality must be rewritten deliberately), explain in the PR description why each prompt changes and how the anti-sycophancy rules are preserved, and expect a careful review. French prompts are frozen: a French-population study must keep producing exactly the same prompts.
- **Identity proofs** for any change that touches drawing, packs, modules or economics: run the scripts in `eval/identity/` before and after your change and compare the outputs:

  ```sh
  npx tsx eval/identity/draw-hash.ts         # draw fingerprints (base, base + modules, historical pack)
  npx tsx eval/identity/economics-noop.ts    # budget recomputation with no change finds the drawn values
  npx tsx eval/identity/income-by-status.ts  # income and budget medians by status
  ```

  Paste the before/after result (identical, or the expected, explained difference) in the PR.
- Add or update tests for the behaviour you change.
- Code, identifiers, comments and documentation are in English. Prompts and generated texts follow the locale of the country pack (`fr` or `en`); a new locale needs a faithful translation of the existing prompts, with the same rules and checks.

## Contributing a module or a country pack

- Modules: follow [docs/modules.en.md](docs/modules.en.md) and its checklist. Run `npm run module:preview -- --module <id>`: no `error` alert, and explain the remaining warnings in the PR. A module describes situations drawn from statistics, never attitudes towards products, and must not override psychographics (scepticism, price sensitivity).
- Country packs: follow [docs/country-packs.md](docs/country-packs.md). The generator is code (reviewed like code), the tables are data (reviewed for sources). Include `npm run personas:validate -- --pack <version> --virtual 2000` output in the PR.
- Data contributions are licensed under CC BY 4.0 ([modules/LICENSE](modules/LICENSE), [packs/LICENSE](packs/LICENSE)). By contributing, you confirm you have the right to publish the figures you add: they should be facts or aggregates cited from their source, not copies of a publication.

## Developer Certificate of Origin (DCO)

All contributions are accepted under the [Developer Certificate of Origin 1.1](https://developercertificate.org/), without a CLA. Each commit must carry a `Signed-off-by` line with your real name and an address you can be reached at, certifying that you wrote the change or otherwise have the right to submit it under the project's licences:

```
Signed-off-by: Your Name <your email address>
```

Git adds it for you with `git commit -s`. To fix the last commit: `git commit --amend -s`; for a branch: `git rebase --signoff main`. Pull requests with unsigned commits cannot be merged.

Code contributions are licensed under the [Apache License 2.0](LICENSE).

## Pull requests

- One topic per PR; keep it small enough to review.
- Describe what changes, why, and how you checked it (tests, snapshots, identity proofs, preview output).
- Never include real study results, real pitches you are not allowed to share, keys or personal data in issues, PRs or fixtures. Use fictional examples, as in `examples/`.

## Reporting bugs and security issues

Bugs: open an issue with the command, the output and your Node version (no keys, no private pitches). Security issues: see [SECURITY.md](SECURITY.md); do not open a public issue.

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
