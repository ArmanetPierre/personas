## What and why

<!-- What does this change, and why? Link the issue if there is one. -->

## How it was checked

- [ ] `npm run typecheck` and `npm test` pass (tests never call a real LLM)
- [ ] Prompt snapshots in `test/studies/__fixtures__/` are unchanged, **or** each prompt change is explained below
- [ ] For changes to drawing, packs, modules or economics: `eval/identity/` outputs before and after are identical, or the difference is explained
- [ ] New or changed data (pack tables, module attributes) cite their sources or are marked `assumption: true` with a justification
- [ ] Every commit is signed off (`git commit -s`, DCO)

## Anti-sycophancy

<!-- If this touches a study prompt, a repair prompt, a coherence check or how results are displayed:
     explain how real constraints, inertia by default, repairs towards caution, the neutral-pitch guard
     and the "no absolute level without its confidence index" rule are preserved. Otherwise write "n/a". -->
