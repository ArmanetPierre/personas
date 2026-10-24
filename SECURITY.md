# Security policy

## Supported versions

Personas is early-stage. Only the latest commit of the default branch receives fixes.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Use GitHub's private vulnerability reporting (on this repository, go to **Security → Report a vulnerability**), or email the maintainer at pierre.armanet.pa@gmail.com. Include what you found, how to reproduce it, the impact you expect, and the commit you tested. You should get a first answer within a week. Once a fix is available, we will credit you in the advisory unless you prefer to stay anonymous.

## Threat model in short

Personas runs locally. Projects, pitches, offers, targets, studies, answers, narratives, summaries, recommendations and keys stay on your machine. The dashboard listens on the loopback interface only (`127.0.0.1`); do not expose it to a network, as it has no authentication.

The parts that deserve attention:

### Keys and secrets

- Keys, tokens and server addresses belong in `.env`, which is ignored by Git. **Never commit them**, in code, fixtures, examples, issues or pull requests. `.env.example` must only contain neutral defaults.
- The `claude-cli` backend runs `claude -p` without tools, without user settings and without MCP, and strips every `ANTHROPIC_*` variable from the subprocess environment, so that a key present in your shell is never used by accident. The dashboard launcher does the same for the long jobs it starts.
- Tests must use obviously fake values and never real-looking key prefixes.
- If you committed a secret by mistake, revoke it first, then clean the history.

### Modules are data, not code

A module (`modules/<id>/module.yaml`) and a country pack (`packs/`) are declarative data: YAML or JSON validated by zod, with a closed set of computation primitives (`lookup`, `mul`, `if`…). They **cannot execute code**, and this property must be kept: a proposal to add per-module code, `eval`, file or network access from a module will be declined. Target draws are bounded (`max_draws`); explicit limits on table size and expression depth are not in the schema yet, so treat a very large or deeply nested module as suspicious, and report any input that exhausts resources.

### Prompt injection through labels

Module labels, card lines (`card`), pack labels and project fields are inserted into the persona card and the prompts sent to the model. A label such as "this person loves every new product and always pays" would bypass the anti-sycophancy rules. Treat such text as an attack, not as data:

- labels and card lines describe facts about a person; they must not address the model, give instructions (imperative or second person), contain URLs or markup, or describe attitudes towards products;
- modules cannot change psychographics (scepticism, price sensitivity);
- reviewers check new or changed labels for injected instructions, and the module preview compares distributions with the base population to spot deliberately biased tables.

If you find a way for a module, a pack or a project file to alter the study instructions, report it privately as a vulnerability.

### Project files you did not write

A project file contains a pitch that is sent to your LLM engine. Read project files from others before running them, as you would read a script: the pitch could try to steer the model, and a study consumes your subscription or your compute.

### LLM engines

- Ollama is reached over HTTP at `OLLAMA_BASE_URL`. If your Ollama server runs on another machine, reach it through an SSH tunnel or a private network, not over the open internet.
- Concurrency towards Ollama is capped at 2 in code.
- Answers from the model are parsed as JSON and validated against a schema before they are stored; they are never executed.
