# Study protocol: concept and price, version 3

A study shows a product pitch and its price to each persona of a sample and asks what the persona **concretely does within the next 7 days**, why, and at which prices they would say yes. This document describes protocol version 3, the default for new studies. Version 2 is frozen and still selectable (`study:create --protocol 2`); a v2 study is always read as v2.

Code: `src/studies/protocols/concept-price.ts` (French), `src/studies/protocols/concept-price-en.ts` (English, a faithful translation with the same rules, schema and checks), `src/studies/payment.ts`, `src/studies/confidence.ts`, `src/studies/summary.ts`.

## 1. Principles

- **Behaviours, not opinions.** The persona picks the most committed action it really takes in the next 7 days, on an increasing scale.
- **Change only what tests justify.** Every rule below exists because removing it biased the results, or because it was measured to have no detectable effect and was kept for comparability.
- **Observed behaviour is not the only payment measure.** Synthetic personas almost never pay at the displayed price within the horizon. The observed payment share is still shown, and it is completed by a converted estimate with its uncertainty and a confidence index.
- **The protocol version is stored in the study.** A protocol change is a new version; existing studies keep theirs.

## 2. What the persona receives

**System prompt** (one per study, or one per role in a multi-role study):

- who it is simulating ("a real person who lives in <country>", not an assistant or a polite interviewee), and why candour matters: the project owner uses the simulation to rule out bad ideas, so a complacent answer costs them money;
- the **nine behaviour rules**:
  1. inertia by default: ignoring the offer is the normal answer;
  2. any action beyond ignoring rests on a concrete, current need the persona can name;
  3. constraints are real: the discretionary budget is what is left each month, every new subscription competes with existing ones, time and attention are limited;
  4. habits and alternatives exist, often free;
  5. approving of the idea is not acting;
  6. many people are simply not concerned, and saying so is useful;
  7. stay true to the profile; do not invent a need or an interest that would be implausible;
  8. do not invent personal facts absent from the profile (children, partner, employer, a business of one's own…);
  9. an objection only counts if it really weighs on the decision;
- the offer: pitch, displayed price, free offer, known competitors and alternatives;
- the expected JSON fields.

**User prompt** (one per persona): the persona card (drawn attributes, plus the lines of the modules used by the population), a constraints block (discretionary budget, existing subscriptions), the narrative if any, and a discovery situation (how the persona comes across the offer).

**Answer** (validated JSON, zod schema enforced by the engine):

| Field | Content |
|---|---|
| `needFrequency` (v3, first field) | how often the need the offer addresses comes up in the persona's life: `never`, `rarely` (less than once a year), `few_per_year`, `monthly`, `weekly`, `daily` |
| `spontaneousReaction` | immediate thought, one or two sentences |
| `relevance`, `relevanceReason` | `concerned`, `marginal` or `not_concerned`, and why |
| `currentSolution`, `alternatives` | what the persona does today, what it would use instead |
| `objections` | 0 to 4 real obstacles, most decisive first, each with a category (`price`, `no_need`, `already_covered`, `trust_privacy`, `effort_time`, `network_effect`, `other`) and a detail |
| `behavior`, `behaviorReason` | `ignore`, `save_for_later`, `visit_page`, `free_signup`, `free_active`, `pay_subscription`, `recommend` (or the project's own scale), and the need that justifies it |
| `wouldForward`, `forwardTo` | forwards the offer to a specific person within 7 days |
| `vanWestendorp` | four increasing price thresholds (too cheap, cheap, expensive, too expensive) |
| `gaborGranger` | yes or no at each price tier; a yes at one price implies a yes at lower prices |
| `budgetFit` | where the money comes from if the persona says yes to a price |
| `verbatim` | one or two sentences the persona would say to someone close |

A project can declare its own `protocol` block (behaviour scale, objection taxonomy, relevance wording); it must keep an increasing scale starting at inaction, one payment level, a "no need" category and a "not concerned" level. `project:suggest-protocol` proposes one from real objections; it is never applied automatically.

## 3. What v3 adds to v2

| # | Change | Why |
|---|---|---|
| 3.1 | **`needFrequency` question**, first field of the answer | It discriminates between products used often and products used rarely, without changing behaviour. It feeds a segment and a diagnostic (§ 6). |
| 3.2 | **A Gabor-Granger tier below the displayed price, always present** | The payment conversion (§ 4) relies on it: it is the tier that receives "yes" answers. If the project has no tier below the displayed price, `studyTiers(project, "3")` adds one at about 0.4 × the price (at least 1 unit below 10, a multiple of 5 above). The displayed price does not change. |
| 3.3 | **Neutral pitch required** | A promotional pitch makes trust objections largely disappear and anchors the prices personas accept. `createStudy` refuses a pitch whose lexical tone score is 25 or more, unless `--force`. |
| 3.4 | **New coherence check `need_frequency_mismatch`** | `needFrequency = never` with relevance "concerned", or with a behaviour at free sign-up or above. Repaired like the other checks. |

Nothing else changes in the prompt text: the nine rules, the 7-day horizon, the behaviour definitions, Van Westendorp and Gabor-Granger, the budget reminder, the checks and the repairs are those of v2. The French v2 and v3 prompts are frozen by snapshot tests.

## 4. Dual payment measure: M1, G, M2

| Measure | Definition | What it says |
|---|---|---|
| **M1, observed payment** | share of personas at the `payment` level or above within the 7-day horizon | almost always 0 with synthetic personas; never shown alone |
| **G, yes at the low tier** | share of "yes" at the low tier p_b (§ 3.2) in the reference group | the raw signal the conversion uses |
| **M2, estimated paying share** | calibrated conversion of G, with a 95 % interval and a confidence level | an order of magnitude, comparable between products once calibrated |

The reference group is the target group, or the whole study when it has a single group. p_b is the tier below the displayed price closest to 0.4 × the price (as a ratio).

### 4.1 Formula

With G the share of "yes" at p_b among n personas, and P the displayed price:

```
logit(M2) = a + b · logit(G') + c · log(P / p_b)        with G' = (n·G + 0.5) / (n + 1)   (smoothing for G = 0)
```

- **Parameters** live in `calibration/payment-v3.json`. The shipped file is version `payment-v3/0`, status `uncalibrated`: a = 0, b = 1, c = 0, so M2 ≈ G, with a wide default half-width of ±2.8 on the logit scale (a factor of about 16 on the odds).
- **Interval**: delta method on the logit scale (sampling uncertainty of G) combined with the calibration half-width.
- **Fitting** (`npm run calibration:fit [-- --write]`, `src/studies/calibration-fit.ts`): reads `calibration/truth.json`, a list of products, each with a completed v3 study and its real paying share in the population (paying share among users × usage). Least squares on the logit scale, c fixed at 0 below 5 products, leave-one-out over products and bootstrap over personas for the uncertainty. It refuses to fit below 3 products, or if b ≤ 0 (no increasing function links G to reality, so the conversion does not apply). It writes only with `--write`, and the version becomes `payment-v3/1`, and so on.

### 4.2 Confidence of M2

- **high**: the product is inside the calibrated domain (same price unit, price within the range of the series, need frequency within the range) and the leave-one-out error is below a factor of 2;
- **medium**: one condition is missing;
- **low**: outside the domain (price unit or frequency never calibrated, B2B, a payer distinct from the user), or the conversion is uncalibrated, or the study is v2. M2 is then shown as "uncalibrated" and only serves to compare variants with each other.

### 4.3 Display rule

**M1 is never shown alone.** One line per study, for example:

> Observed payment within 7 days: 0 %; yes at the low tier: x %; estimated paying share: y % [low ; high], uncalibrated, low confidence.

The dashboard, the console summary and the recommender follow the same rule.

## 5. Confidence index of absolute levels

Every study carries a confidence index (`src/studies/confidence.ts`) that accompanies every absolute level (trial, payment). One point per criterion:

| Criterion | Point when |
|---|---|
| Sample | n ≥ 100 in the reference group, or a repeated run exists (same project, same protocol, same version, completed) |
| Calibration | the M2 conversion is calibrated |
| Pitch | the pitch tone score is below the threshold (25) |

3 points: **high**; 2: **medium**; 0 or 1: **low**. The index comes with its caveats (for example the expected test-retest noise at this sample size, which scales as 1/√n), and with the texts "reliable" and "indicative" shown next to the results:

- **reliable**: objections, segments that respond or drop out, differences between variants tested on the same sample, the effect of the pitch's tone;
- **indicative**: absolute levels (trial, payment).

The CLI looks for repeated runs; the dashboard API does not yet, so it warns "no known repeated run" below n = 100.

## 6. Need frequency in the analysis

- **Automatic segment** `needFrequency` (added to behaviours and objections by segment).
- **Recurring-use indicator**: share at least `monthly`, to compare with a real-world figure when one exists.
- **Diagnostic**: when `never` + `rarely` reach 50 % or more for a product that is used occasionally but widely in reality, the summary says the base population does not represent that usage and that a **usage module** should be created. This is not a prompt correction.

## 7. Pitch tone

`src/studies/pitch-tone.ts`:

- `lexicalTone(text, locale)` scores a pitch from 0 (factual) to 100 (oversold) from French or English lexical markers in seven categories: superlatives, unverifiable promises, unsourced social proof, urgency, value judgements on the price, injunctions and emotional framing. `toneWarning` compares it with the threshold of 25.
- In v3, `createStudy` refuses a pitch at or above the threshold unless `force`; in v2 it only warns. The pitch is never neutralised silently.
- `project:neutralize-pitch` proposes a factual version, lists the flagged passages and missing information, and checks without a model that no number, unit, proper name or key term was lost or added (`checkFacts`). The proposal goes to `data/proposals/`; the user applies it (`pitch`, and `pitchOriginal` to keep the original).
- Each answer records `pitchTone: { score, threshold, neutralized }`, so the confidence index measures the pitch the personas actually saw.
- `examples/pitch-tone/` contains the same service pitched in a factual, a commercial and an oversold tone, to observe the effect: a promotional tone makes trust objections disappear and shifts accepted prices, which is why the tone effect is a reliable result and absolute levels under a promotional pitch are not.

## 8. Coherence checks and repair

After schema validation, `checkCoherence` flags contradictions, for example: Van Westendorp thresholds not ordered (`vw_not_ordered`), Gabor-Granger not monotonic (`gg_not_monotonic`), paying without a yes at any tier (`pay_without_gg`), a yes beyond the budget without justification (`budget_unjustified`), a minimum basket above the budget (`minimum_over_budget`), "not concerned" but engaged (`not_concerned_but_engaged`), `need_frequency_mismatch` (v3). `checkFacts` flags invented personal facts (`invented_partner`, `invented_child`, `invented_business`, `invented_job_status`…).

One repair prompt is sent, oriented **towards caution**. The repaired answer is kept only if it does not have more anomalies; the original is kept in `payload.originalAnswer`, and remaining anomalies are recorded.

## 9. Summary contract (`study:summary`, `GET /api/studies/:id/summary`)

Fields relevant to the protocol (TypeScript notation):

```ts
protocolVersion: "2" | "3"
payment: {
  group: string | null,
  observed: number,                // M1 (0-1)
  lowTierYes: { price: number, yes: number, n: number, share: number } | null,   // G; null without a tier below the price
  estimated: {                     // M2; null if lowTierYes is null
    value: number,
    ci: [number, number],          // 95 % interval
    confidence: "high" | "medium" | "low",
    confidenceReasons: string[],
    calibration: { status: "uncalibrated" | "calibrated", version: string, fittedOn: string[] }
  } | null
}
needFrequency?: {                  // v3 only
  group: string | null, n: number,
  counts: Record<NeedFrequency, number>, shares: Record<NeedFrequency, number>,
  recurringShare: number,          // at least monthly
  rareShare: number,               // never + rarely
  diagnostic: string | null        // usage module to create (§ 6)
}
confidence: {
  level: "high" | "medium" | "low", score: 0 | 1 | 2 | 3,
  sample: { group, n, ciHalfWidthPts, retestNoisePts, repeats: string[] | null, ok: boolean, warning: string | null },
  protocol: { version: string, calibrated: boolean, calibrationVersion: string },
  pitch: { score: number | null, threshold: number, neutralized: boolean | null, measuredOn: "responses" | "current_project", ok: boolean },
  caveats: string[], reliable: string[], indicative: string[]
}
```

The same `payment` (without `group`) and `needFrequency` appear in each analysis (`overall`, `groups[i].analysis`). v2 studies also get M1, G, M2 (uncalibrated) and the confidence index; need frequency exists only for v3 answers.

**Comparison** (`study:compare`): each entry carries `protocolVersion`, `payment`, `needFrequency` and `confidence`; deltas include `lowTierYes` (points, null if the low tier or the unit differ) and `paymentEstimated`. `protocolsDiffer: true` when the studies mix v2 and v3: absolute levels are then not comparable.

**Recommendations** (`study:recommend`): the recommender receives M1, G, M2 and the confidence index; it must never cite an absolute level without its status, and a "strong" recommendation that rests only on absolute levels is downgraded to "medium" when the index is low. The output carries an `absoluteLevels` block with the display line.

## 10. Validating a protocol change

- Judge any variant of the protocol **against a reference replay and on at least 2 runs**: the test-retest noise at small sample sizes is large.
- A change to a study prompt must keep the anti-sycophancy rules (real constraints, alternatives, inertia by default), pass the prompt snapshots in `test/studies/__fixtures__/` (update them only on purpose, and explain why in the pull request), and, for a new version, leave existing studies readable in their own version.
- Calibration is the only way to make absolute levels meaningful: replay products with a known outcome, successes as well as failures, record their real paying share in `calibration/truth.json`, then run `calibration:fit`. Results are model-specific: the shipped protocol was tuned with Claude Sonnet.
