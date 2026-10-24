# Personas

**Synthetic personas to stress-test an idea, a business model or a price before you spend money on real research.**

Personas draws realistic populations of synthetic people from public statistics, shows them a product pitch and a price, and records what each one would *actually do this week*, why, and what stops them. You get objections, segments that respond or don't, and comparisons between variants of the same offer.

> Personas is a **filter for bad ideas and an objection generator, not an oracle.**
> It does not predict your conversion rate and it does not replace talking to real customers. It helps you decide which ideas deserve those conversations, and what to ask.

- Local-first: your projects, pitches, studies and keys stay on your machine. SQLite file, local web dashboard, no server to run.
- Bring your own model: the `claude` CLI with your own subscription, or a local [Ollama](https://ollama.com) model.
- Statistically drawn people: attributes come from sourced tables (age, sex, region, income, household, housing, equipment, subscriptions, budget). The LLM only writes the short narrative, never the attributes.
- Two base populations today: **France** (French) and **Singapore** (English, all usual residents).

## What is reliable, what is indicative

LLMs are not customers. Their absolute numbers are biased in a known direction. Personas reports two kinds of results and labels them as such.

| Reliable (use it to decide) | Indicative (never read it alone) |
|---|---|
| **Objections** and friction points, with verbatims | **Absolute levels**: share that would try, share that would pay |
| **Segments** that respond or drop out (age, income, household, modules…) | The estimated paying share (M2) and its interval |
| **Differences between variants** tested on the *same sample* (price, offer, target) | |
| The **effect of the pitch's tone** (a sales pitch inflates trust and shifts prices) | |

Absolute levels are always shown with their correction and a **confidence index**, never on their own. In our calibration runs the model almost never pays at the displayed price within the observation window, so the observed payment share (M1) is close to zero for most products. Personas therefore also measures the share of "yes" at a low price tier (G) and converts it into an *estimated paying share* (M2) with an interval. That conversion ships **uncalibrated**: until it is fitted on products with a known outcome, M2 is displayed as "uncalibrated" and is only useful to compare variants with each other. See [docs/study-protocol.md](docs/study-protocol.md).

## Anti-sycophancy principles

The product is only useful if it is **credibly pessimistic**. These rules are built into the study protocol, not left to each project:

- **Real constraints.** Every persona has a monthly discretionary budget, existing subscriptions, limited time and alternatives (often free). The prompt reminds the persona of what is left at the end of the month.
- **Behaviours, not opinions.** The question is "what do you concretely do in the next 7 days?", not "do you like the idea?". Approving is not acting.
- **Inertia by default.** The normal answer is indifference. Engagement has to be justified by a concrete, current need.
- **Off-target people in the pool.** A control group shows who really responds, compared with the target.
- **Heterogeneity.** Attributes are drawn from statistics, not invented by the model.
- **Coherence checks.** Answers are validated against a schema and checked for contradictions (unordered price thresholds, paying without accepting any price tier, spending beyond the budget, invented spouse, children or business…). Incoherent answers get one repair, always towards caution.
- **Neutral pitch.** A sales pitch biases the test of the idea. The protocol refuses to start a study whose pitch scores as promotional, unless you explicitly force it. A neutralisation assistant proposes a factual version.
- **Calibration.** Replaying products with a known outcome is the only way to correct absolute levels. What the simulator cannot reproduce becomes a correction and a confidence index, displayed next to every absolute level.

Any change to a study prompt must preserve these constraints. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Quick start

### Requirements

- **Node.js 22 or later** and npm.
- One LLM engine:
  - **`claude` CLI** ([Claude Code](https://docs.anthropic.com/en/docs/claude-code)), logged in with **your own** Claude subscription. This is the default engine (`claude-cli`, model `sonnet`), and the one the protocol was calibrated on. Personas never calls the paid Anthropic API: the `anthropic-api` backend is a disabled placeholder, and `ANTHROPIC_*` variables are stripped from the environment of the `claude` subprocess.
  - **or Ollama**, running locally (default `http://localhost:11434`, model `qwen3:8b`). Concurrency towards Ollama is capped at 2 in code. Studies and narratives can run on Ollama; the assistants (recommendations, pitch neutralisation, module, target and protocol assistants) currently use the `claude` CLI only. The optional relevance pre-screen (`target:preview --triage`) uses Ollama only.

### Install as a command

Personas is a local web service: nothing runs on someone else's server. Install the `personas` command once, then open the dashboard in your browser.

> **Not published on npm yet.** Until it is, install from the repository (npm builds the package on the fly; replace `<owner>` with the account hosting the public repository):
> `npm i -g github:<owner>/personas`, or from a clone: `npm ci && npm pack`, then `npm i -g ./personas-<version>.tgz`.
> Once published, this will simply be `npm i -g personas`.

```sh
npm i -g github:<owner>/personas   # later: npm i -g personas
personas ui                        # opens the dashboard on a free port of 127.0.0.1 (Ctrl+C to stop)
personas --help                    # every command, in English or French
```

On first launch, when no engine is configured and the `claude` CLI is not found, the dashboard opens a setup screen (also reachable from **Configure the engine** in the sidebar):

1. **Engine**: your Claude subscription through the `claude` CLI (personal use only), an API key (Anthropic, OpenAI, Gemini, OpenRouter; each with a link to the provider's key page), or a local server (Ollama, vLLM).
2. **Key**: pasted once, tested on a free endpoint (model or catalogue lookup, no generation), then stored in the system keychain (macOS Keychain, Windows Credential Manager, Secret Service on Linux). It is never written to a file, logged or sent back to the page. The setup API only answers the dashboard on 127.0.0.1, with a session token generated when `personas ui` starts.
3. **Spending cap** per study (default $5), saved in the engine profile.
4. **Demo**: creates an example project (20 personas) that you then launch from the project page.

Every `npm run x:y` script of the repository is a sub-command: `personas study run <study-id>`, `personas project create --file my-project.yaml`, `personas engine profile add …`, `personas mcp`. `personas <group>` lists a group (`personas engine`), `personas <command> --help` shows its options.

**Where your data lives.** The installed command keeps its SQLite database, logs and copies of the demo projects in a per-user folder: `~/Library/Application Support/Personas` (macOS), `%APPDATA%\Personas` (Windows), `$XDG_DATA_HOME/personas` or `~/.local/share/personas` (Linux). Set `PERSONAS_DATA_DIR` to use another folder (or `DATABASE_PATH` for the database file alone). The database is created and migrated on first launch. Engine profiles are in `~/.personas/config.json` (never a key).

**Engine profiles and keys from the terminal.**

```sh
personas engine profile add --name openai --provider openai --model gpt-5-mini --per-study-usd 5 --use
personas engine key set --profile openai      # masked input, stored in the system keychain
personas engine key test --profile openai     # free endpoint, no generation
personas engine profile list
```

### Install from source (contributors)

```sh
git clone <this repository> personas
cd personas
npm ci
cp .env.example .env          # adjust the engine settings if needed
npm run db:migrate            # creates ./data/personas.db (commands also migrate on start)
npm run engine:check          # checks each engine with one small JSON request
```

In a clone, data stays in `./data` and the commands run from the TypeScript sources (`npm run study:run -- …`). `npm run build` compiles the package (`dist/` and `web/dist/`); `npm pack` does it too.

`npm run engine:check -- --backend claude-cli` or `-- --backend ollama` checks a single engine.

> **Language.** The command-line messages (usage, progress, errors, tables) are in English or French. Set `PERSONAS_LANG=en` or `PERSONAS_LANG=fr` (in your shell or in `.env`) to choose; otherwise the language follows your terminal locale (`LC_ALL`, then `LC_MESSAGES`, then `LANG`): a `fr*` locale gives French, anything else English. Some texts produced deeper in the engine (progress logs of the assistants, the text summaries of `study:summary`, `study:compare` and `study:drivers`, persona cards, margin reports, price labels) are still in French for now. The dashboard is bilingual (English and French), and everything a study on the Singapore population produces (narratives, prompts, answers, summaries) is in English.

### 1. Draw personas (no LLM call)

Commands below are run from the repository root.

Drawing is free and deterministic. Preview the target of an example project:

```sh
npm run population:draw -- --project examples/sg/recipe-app.yaml --n 200
```

You get the eligibility rate (with its Wilson interval) and the margins of the sample. To see what a persona card looks like, as the study will show it to the model:

```sh
npm run target:preview -- --project examples/sg/recipe-app.yaml --n 50 --sample 3
```

You can also draw a raw base population into the database: `npm run personas:generate -- --pack sg-2026.2 --count 200 --seed 42`, then `npm run personas:validate -- --pack sg-2026.2 --virtual 2000` to compare the margins with the source tables.

### 2. Create a project from an example

A project is a YAML or JSON file: pitch (what a user would see), price, competitors, alternatives, and optionally a target, a control group, roles or a custom behaviour scale.

```sh
npm run project:create -- --file examples/sg/recipe-app.yaml
```

### 3. Run a study

```sh
npm run study:create -- --project sg-recipe-app --seed 7      # uses the project's target (n = 60); writes missing narratives
npm run study:run -- --study <study-id>                       # one LLM call per persona, resumable
npm run study:summary -- --study <study-id>                   # behaviours, objections, segments, prices, M1/G/M2, confidence
npm run study:recommend -- --study <study-id>                 # findings and next-variant suggestions, each checked against the data
```

- With Ollama: `study:create -- --project sg-recipe-app --backend ollama --narrate-backend ollama`.
- A study writes each answer as it arrives. If it is interrupted (or you hit your subscription's usage limit), it is paused: run `study:run` again to resume.
- Start small (`--n 20`) to check the setup, then go to 100 or more: below n = 100 without a repeated run, the confidence index flags the sample as noisy.
- A pitch with a promotional tone is refused. Run `npm run project:neutralize-pitch -- --project sg-recipe-app` for a factual proposal (written to `data/proposals/`, never applied automatically), or pass `--force` to `study:create` if you really mean it.
- Compare two variants on the same sample: create the second study with `--same-sample-as <study-id>`, then `npm run study:compare -- --studies <id1>,<id2>`.

### 4. Open the dashboard

Installed command: `personas ui`. From a clone:

```sh
npm run dev:web               # http://localhost:5173 (listens on the loopback interface only)
```

Or build once and serve: `npm run build:web && npm run start:web`. Set `PERSONAS_WEB_PORT` to use another port. The dashboard lists projects, studies (progress, results by segment, verbatims, comparisons), personas and modules, and can create projects, start studies and run the assistants.

### 5. Use it from an agent (MCP)

`personas mcp` (installed) or `npm run mcp` (clone) starts a local [MCP](https://modelcontextprotocol.io) server over stdio, on the same database as the CLI and the dashboard. Keep `--silent`: npm otherwise prints a banner on stdout, which breaks the protocol.

```sh
# Claude Code, installed command
claude mcp add personas -- personas mcp
# Claude Code, from a clone
claude mcp add personas -- npm --prefix /path/to/personas run --silent mcp
```

```json
// Claude Desktop: claude_desktop_config.json
{ "mcpServers": { "personas": { "command": "npm", "args": ["--prefix", "/path/to/personas", "run", "--silent", "mcp"] } } }
```

- Read tools: `list_projects`, `get_project`, `preview_target` (no LLM pre-sort unless asked), `study_status`, `study_summary` (with the confidence index and the model), `compare_studies`, `list_modules`, `search_modules`.
- Tools that cost LLM calls or write: `create_project`, `suggest_target`, `create_study`, `run_study` (detached, returns at once), `recommend`. Each one first returns a preview with the planned calls (n responses + ~10 % repairs + one call per 10 missing narratives); it acts only when called again with `confirm: true`.
- Not exposed: accepting a module, applying a pitch neutralisation, deleting anything. The pitch-tone guard applies as in the CLI, with no `--force`.

## Examples

All examples are fictional products, written to exercise the formats.

| File | What it shows |
|---|---|
| `examples/sg/recipe-app.yaml` | Consumer app, Singapore population, monthly subscription in SGD |
| `examples/sg/fresh-catch-demo.yaml` | Physical product sold by weight, minimum basket, Singapore |
| `examples/sg/home-barbecue-chef.yaml` | Home service using the published Singapore modules, with a custom behaviour scale |
| `examples/sg/team-schedule.yaml` | B2B SaaS with two roles: the manager pays, team members use it |
| `examples/meal-planner.json`, `examples/meal-planner-v2.json` | Reference project on the French population (5 €/month); the v2 file adds a target, a module and a control group |
| `examples/variants/meal-planner-dietitian-booking.json` | Pay-per-use variant of the same project |
| `examples/pricing/*.yaml` | Price formats: per kg and per pack, monthly or yearly in USD, freemium, one-time purchase |
| `examples/team-schedule*.yaml`, `examples/kids-reading*.yaml` | Multi-role projects (payer and user, parent paying for a child), with and without modules |
| `examples/pitch-tone/*.json` | The same service pitched in a factual, a commercial and an oversold tone (French and English), to see the tone guard and its effect |

French-population examples are written in French, since the personas and the prompts of that population are French.

## Status

Early. Expect breaking changes.

- **Single-model calibration.** The protocol and its anti-sycophancy safeguards were tuned with Claude Sonnet through the `claude` CLI. Other models (including local Ollama models) run, but their bias has not been measured: treat their results as uncalibrated, and compare variants rather than levels. The engine and model are recorded on every study.
- **M2 is uncalibrated** (`calibration/payment-v3.json`, status `uncalibrated`) until it is fitted with `npm run calibration:fit` on a series of products with a known paying share.
- **Coming next:** multi-provider "bring your own key" (OpenAI-compatible servers, OpenRouter, Gemini, Anthropic) with a cost estimate and a spending cap before each run; publication on npm; a shared library of modules and country packs.
- Multi-role studies are implemented and tested with a simulated engine; they are less battle-tested than single-role studies.
- Usage simulation (driving a real app with personas) is out of scope for now.

## Documentation

- [docs/architecture.md](docs/architecture.md): how the code is organised (data model, persona generation, study pipeline, LLM agents, i18n).
- [docs/study-protocol.md](docs/study-protocol.md): the concept-and-price protocol v4 (v3 plus the module-attribute block; M1, G, M2, confidence index, pitch tone).
- [docs/modules.en.md](docs/modules.en.md): how to write and validate a thematic module.
- [docs/country-packs.md](docs/country-packs.md): the country-pack contract and how to add a country.
- [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

`docs/modules.md` is the French format reference that the module assistant reads in its prompt; `docs/modules.en.md` is the English guide for humans.

## Licence

- Code: [Apache License 2.0](LICENSE), except the Hub service.
- Hub service (`hub/`): [GNU AGPL 3.0](hub/LICENSE). If you run a modified Hub as a network service, you must offer its source to its users. The engine, CLI and dashboard it builds on stay Apache-2.0.
- Modules (`modules/`) and country packs (`packs/`): [CC BY 4.0](modules/LICENSE). Each table cites its sources.
- Personas you draw and study results you produce are yours.

See [NOTICE](NOTICE).
