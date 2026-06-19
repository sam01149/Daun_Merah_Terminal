# BTC Direction Model — Comparison Report

Three experiments, in order: (1) single chronological train/test split across 5 classification
algorithms, (2) walk-forward cross-validation to check whether (1)'s best result holds up, (3)
a regression experiment predicting return magnitude instead of direction.

A bug was found and fixed between drafting this report and finalizing it: the CME COT data carries
a ~3-day CFTC publish lag (report "as of" Tuesday, released the following Friday) that the
original feature-engineering forward-fill didn't account for — candles could see COT positioning
data ~3 days before it was actually public. Fixed in `scripts/feature-engineering.js` (`COT_PUBLISH_LAG_MS`).
All numbers below are post-fix.

## 1. Single split — classification (direction)

Chronological 80/20 split (test = most recent ~20%, no shuffling, no lookahead).

| Config | Model | Accuracy | F1 | ROC-AUC |
|---|---|---|---|---|
| 4h / 1-day horizon | baseline (majority) | 51.2% | 0.677 | — |
| 4h / 1-day horizon | baseline (momentum) | 49.3% | 0.501 | — |
| 4h / 1-day horizon | Logistic Regression | 51.6% | 0.588 | 0.525 |
| 4h / 1-day horizon | **Random Forest** | **53.3%** | 0.619 | **0.531** |
| 4h / 1-day horizon | Gradient Boosting | 52.1% | 0.586 | 0.519 |
| 4h / 1-day horizon | MLP | 51.0% | 0.654 | 0.489 |
| 4h / 1-day horizon | LSTM | 52.3% | 0.642 | 0.501 |
| 4h / 3-day horizon | baseline (majority) | 51.7% | 0.682 | — |
| 4h / 3-day horizon | baseline (momentum) | 49.3% | 0.505 | — |
| 4h / 3-day horizon | Logistic Regression | 52.2% | 0.650 | 0.492 |
| 4h / 3-day horizon | Random Forest | 52.7% | 0.645 | 0.524 |
| 4h / 3-day horizon | **Gradient Boosting** | **53.3%** | 0.666 | **0.542** |
| 4h / 3-day horizon | MLP | 50.7% | 0.648 | 0.500 |
| 4h / 3-day horizon | LSTM | 53.4% | 0.656 | 0.529 |
| 1d / 6-day horizon | baseline (majority) | 50.7% | 0.673 | — |
| 1d / 6-day horizon | baseline (momentum) | 47.5% | 0.476 | — |
| 1d / 6-day horizon | Logistic Regression | 51.9% | 0.657 | 0.469 |
| 1d / 6-day horizon | Random Forest | 50.3% | 0.590 | 0.511 |
| 1d / 6-day horizon | Gradient Boosting | 51.9% | 0.579 | 0.486 |
| 1d / 6-day horizon | MLP | 51.0% | 0.562 | 0.495 |
| 1d / 6-day horizon | LSTM | 49.5% | 0.578 | 0.492 |
| 1d / 18-day horizon | baseline (majority) | 49.2% | 0.660 | — |
| 1d / 18-day horizon | baseline (momentum) | 48.1% | 0.478 | — |
| 1d / 18-day horizon | Logistic Regression | 53.8% | 0.665 | 0.476 |
| 1d / 18-day horizon | **Random Forest** | **54.6%** | 0.554 | **0.548** |
| 1d / 18-day horizon | Gradient Boosting | 50.9% | 0.508 | 0.515 |
| 1d / 18-day horizon | MLP | 51.9% | 0.604 | 0.501 |
| 1d / 18-day horizon | LSTM | 52.3% | 0.631 | 0.505 |

(Full numbers in `model_comparison.json`.) Best single-split result: **Random Forest, 1d/18-day,
54.6% accuracy / 0.548 AUC.**

## 2. Walk-forward cross-validation — does the best result hold up?

4 chronological expanding-window folds per config (train on everything before the fold, test on
the fold). This is the test that actually matters — a single split can look good by chance.

| Config | Best model (by mean AUC) | Mean AUC ± std | Mean accuracy ± std |
|---|---|---|---|
| 4h / 1-day horizon | Random Forest | **0.532 ± 0.010** | 0.515 ± 0.021 |
| 4h / 3-day horizon | Logistic Regression | 0.515 ± 0.019 | 0.514 ± 0.015 |
| 1d / 6-day horizon | Random Forest | 0.521 ± 0.024 | 0.489 ± 0.035 |
| 1d / 18-day horizon | MLP | 0.526 ± 0.036 | 0.512 ± 0.057 |

(Full per-fold numbers in `cross_validation.json`.)

**Critical finding: the single-split "best" result does not replicate.** Random Forest on
1d/18-day looked best in experiment 1 (AUC 0.548), but under walk-forward CV its mean AUC across
4 folds is **0.481 ± 0.068** — below 0.50, i.e. worse than a coin flip on average, with a standard
deviation almost as large as the mean. That 0.548 was this model's performance on one specific,
favorable test window, not a real repeatable edge.

The only result that looks even modestly consistent across folds is **Random Forest on 4h /
1-day horizon: AUC 0.532 ± 0.010** — mean barely above 0.50, but with a notably small standard
deviation (it doesn't swing wildly fold to fold). That's the most credible result in this entire
project, and it's still a very weak edge.

## 3. Regression — predicting return magnitude instead of direction

Same split, same features, predicting `target_ret_6` / `target_ret_18` (continuous) instead of
the binarized direction. Metric: R² (0 = no better than predicting the mean, negative = worse).

| Config | Model | MAE | RMSE | R² |
|---|---|---|---|---|
| 4h / 1-day horizon | baseline (predict 0) | 0.0168 | 0.0234 | -0.0000 |
| 4h / 1-day horizon | **Random Forest** | 0.0169 | 0.0234 | **0.0015** |
| 4h / 1-day horizon | Linear Regression | 0.0172 | 0.0236 | -0.0131 |
| 4h / 1-day horizon | Gradient Boosting | 0.0211 | 0.0279 | -0.4224 |
| 4h / 1-day horizon | MLP | 0.0308 | 0.0396 | -1.8630 |
| 4h / 1-day horizon | LSTM | 0.0264 | 0.0350 | -1.2338 |
| 4h / 3-day horizon | baseline (predict 0) | 0.0295 | 0.0392 | -0.0001 |
| 4h / 3-day horizon | Random Forest | 0.0296 | 0.0394 | -0.0099 |
| (1d configs follow the same pattern — see `regression_comparison.json`) ||||

**Every single regression model except Random Forest has negative R²** — meaning they're
actively worse than just predicting "no change" or the historical average return. Random Forest
gets R² = 0.0015, statistically indistinguishable from zero. Predicting *how much* BTC will move
is harder than predicting *which direction* — there's no usable signal for magnitude at all in
this feature set.

## Honest bottom line

1. **There is no real directional edge.** The one result that survives cross-validation (Random
   Forest, 4h, 1-day horizon, AUC 0.532 ± 0.010) is barely above random and would not be tradeable
   on its own — it's a curiosity, not a signal.
2. **The previously-reported "best" result (55.6% / AUC 0.569, then 0.548 after the COT lag fix)
   was a fluke of a single test window**, not a robust finding — confirmed by walk-forward CV
   producing a mean AUC below 0.50 for that same config.
3. **Regression on return magnitude doesn't work at all** — every model except Random Forest is
   worse than the naive baseline, and even Random Forest is indistinguishable from it.
4. **LSTM (the deep learning option) never wins** across any of the three experiments. With this
   amount of data and this much noise, a sequence model has no advantage over tabular models — and
   sometimes does meaningfully worse (e.g. negative R² values far below other models in the
   regression experiment).
5. **The bottleneck is the data, not the algorithm.** Logistic Regression, Random Forest,
   Gradient Boosting, an MLP, and an LSTM all converge to roughly the same place (~0.50 AUC).
   That convergence across very different model families is itself evidence that there's no
   exploitable structure in this feature set for this task, not that we picked the wrong model.

**Recommendation:** do not ship this as a trading signal or even as a confident thesis-narrative
input. If a BTC "lean" indicator is still wanted for the digest, it should be framed explicitly
as low-confidence context (e.g. citing RSI/MACD/COT positioning narratively, the way the existing
XAU/forex thesis system already does) rather than a model-generated probability — the model adds
no proven value over just reading the indicators directly.

## Next options (superseded — see Part 2 below)

---

# Part 2 — Deeper diagnostics, data prep fixes, and the volatility-regime breakthrough

Everything below happened after the report above. Summary of what changed and why.

## 4. Data transformation fix: COT raw counts were non-stationary

`cot_open_interest` and `cot_net_noncomm` (used in Part 1's models) were **raw absolute counts**,
trending upward for years as the CME Bitcoin futures market grew (open interest went from ~1,700
contracts in 2018 to ~40,000+ by 2025). Feeding that into a model risks it learning "what year is
it" rather than real positioning signal — the same problem already avoided for raw close price.

**Fix:** replaced with `cot_open_interest_z` (rolling 52-report z-score) and `cot_net_pct` (net
positioning as % of open interest, self-normalizing). `cot_net_change_1w` redefined as the change
in `net_pct`, not raw contract counts. Re-ran everything — the best result (Random Forest, 4h/1-day)
barely moved (0.531→0.528 AUC under CV), good evidence it wasn't an artifact of the bug. EDA's
correlation ranking changed slightly (`cot_net_pct` correlation -0.098 vs the original raw -0.113)
but the contrarian direction and ranking held.

## 5. Feature diagnostics: multicollinearity confirmed, but pruning doesn't help

Found 13-18 feature pairs with |correlation| > 0.7, including `ret_1`/`log_ret_1` at 0.997-1.0
(literal duplicates). Tested whether a minimal feature set (just `cot_net_pct`, the single
strongest correlate found in EDA) beats the full 22-feature model:

- **Single 80/20 split:** `cot_net_pct` alone *beat* the full model (0.521 vs 0.502 AUC on 4h).
  Exciting at first glance.
- **Walk-forward CV (the test that actually matters):** `cot_net_pct` alone scored 0.502±0.017 on
  4h and 0.488±0.098 (highly unstable) on 1d — **no better than, or worse than, the full model**
  (0.528±0.018 / 0.490±0.039). The single-split "win" was another single-split fluke, same pattern
  as Part 1's main finding. Top-10-by-importance also didn't beat the full set under CV.

**Conclusion:** multicollinearity is real but tree-based models already handle it reasonably —
pruning isn't the fix. The bottleneck is signal-to-noise in the data/asset, not feature strategy.

## 6. COT contrarian positioning — the best lead found in Part 1, examined closer

At COT's native weekly resolution (427 reports, not the daily-duplicated version used in early
EDA), `net_pct` correlates with forward 1-2 month returns at -0.16 to -0.18 (crowded speculative
longs → weaker forward returns — classic contrarian pattern). Holds in 3 of 4 walk-forward folds;
**fails specifically during 2023-03→2024-10** (the ETF-rally bull run) — momentum beat
mean-reversion there. Real, economically sensible, but weak (R²~3%) and regime-dependent.

## 7. EDA stress-tests (prompted by external review) — volatility clustering confirmed strongly

ACF of `|return|` (not raw return) stays at **0.15-0.26 across all 40 lags tested**, vs ~0 for raw
returns — strong, persistent evidence of volatility clustering, unlike directional sign which is
close to a random walk. This motivated the experiment below.

A **permutation significance test** was also run on the Part 1 headline result (Random Forest,
4h/1-day, CV AUC 0.528): real AUC vs. a null distribution from 30 label-shuffles (mean 0.501,
std 0.005) — **0/30 shuffles reached the real AUC (p≈0)**. So that result, while a very weak edge
in practical terms, is *not* pure noise — useful context against the generic "could just be
multiple-testing luck" concern, addressed directly rather than left as a hand-wave.

A **rolling vs. expanding window** comparison (testing whether old 2018-era data pollutes recent
predictions) showed rolling window slightly better and more stable (0.533±0.014 vs 0.528±0.018) —
a real but modest effect, not a game-changer on its own.

## 8. Volatility-regime classification — by far the strongest result in this project

Motivated directly by #7. Target: will realized volatility over the next 6 periods be in the top
30% of its trailing 500-period range (adaptive threshold — same non-stationarity reasoning as the
COT fix in #4)? New features added: Parkinson volatility (high-low range estimator, more efficient
than close-to-close), realized vol at 6/20-period windows (the actual *level* of volatility — note
`volatility_z20` from Part 1 is a z-scored return, i.e. "how unusual is today's return", NOT a
volatility-level feature; that mislabeling is a known issue, left as-is, with these new features
added alongside it).

| Config | Best single-split | Walk-forward CV (best algo) | All-algorithm CV ranking |
|---|---|---|---|
| 4h, ~1-day horizon | RF 0.630 / GB 0.632 | **RF 0.633 ± 0.0035** | RF 0.633 > LR 0.627 > GB 0.587 > MLP 0.585 > LSTM 0.554 |
| 1d, ~6-period horizon | RF 0.672 | RF 0.597 ± 0.0504 | RF 0.597 > MLP 0.549 > LR 0.545 > GB 0.526 > LSTM 0.502 |

The 4h result is the strongest, most stable finding anywhere in this project — **CV std of just
0.0035** across 4 folds (individual folds: 0.630, 0.639, 0.634, 0.630 — remarkably consistent),
vs. 0.018 for the best direction-prediction result. Permutation test: real AUC 0.633 vs null mean
0.500±0.006, p≈0. Logistic Regression is a close, equally stable second (0.627±0.010) — notable
since it's far simpler/cheaper than Random Forest. **LSTM is the weakest algorithm again**, the
4th experiment in a row (direction classification, direction CV, regression, now this) where deep
learning adds no value over tabular models.

Caveats: base rate is imbalanced (~25-31% positive class), so F1 at the default 0.5 threshold is
sometimes poor (e.g. RF on 1d: F1=0.018, meaning it barely predicts the positive class at that
threshold) even though AUC (threshold-independent) is strong — would need threshold calibration
for practical use. The 1d config is also much less stable across folds (std 0.05) than 4h.

**This has been integrated into the official pipeline** (not just a standalone experiment):
`scripts/feature-engineering.js` now computes `realized_vol_6/20`, `parkinson_vol_mean_6`, and
`target_vol_regime_6` directly, using a new `rollingQuantile()` helper in `indicators.js`. Verified
the Node output reproduces the Python experiment's CV result exactly (0.6333±0.0035, identical row
count) before treating it as the production path.

## 9. External strategic review (Gemini) — evaluated, not taken at face value

Two rounds of advice from an external AI were independently re-tested rather than accepted as-is:
- Multiple-testing-bias concern → addressed empirically with the permutation test above (real
  result is significant, not just luck).
- Rolling vs. expanding window concern → tested, modest real improvement, not dramatic.
- Volatility-regime suggestion → strongly validated (this is now the headline result).
- A later suggestion to use vanilla Geometric Brownian Motion Monte Carlo for take-profit/stop-loss
  probability was **rejected**: GBM assumes constant volatility, which directly contradicts the
  volatility-clustering finding this project just spent effort proving; it also assumes Gaussian
  return shocks, contradicting the fat-tailed returns found in EDA (kurtosis 8.6-23); and it would
  lean on a historical-mean drift estimate that this whole project has shown is unreliable at
  these horizons. If pursued later, GARCH-based simulation (consistent with the vol-clustering
  finding) or historical-return bootstrap would be the honest alternative — not implemented yet.
- A "volume bars" suggestion was also deprioritized — its stated rationale (markets going quiet
  on weekends) doesn't apply to BTC, which trades 24/7.

## 10. DVOL (Deribit implied volatility) as a feature — tested, no real improvement

Motivated by the open question "can volatility-regime AUC be pushed toward 0.70-0.80?" DVOL is
the market's own forward-looking volatility expectation (from BTC options), a genuinely different
kind of information than the realized-vol features used in #8 — the strongest new-data candidate
available. Added `dvol_close` and `dvol_change_1` to the feature set and re-ran the *exact* same
rigor as #8 (walk-forward CV + permutation test, not a single split).

**Critical methodological point:** DVOL only has history since 2021-03-24, vs 2017-2018 for every
other source. Naively comparing "baseline AUC on full history" against "+DVOL AUC on its shorter
history" would confound the DVOL effect with the different (and, it turns out, harder) time
window. So the comparison below restricts *both* baseline and +DVOL to the identical DVOL-era row
subset — same rows, only the feature set differs.

| Config | Baseline (full history) | Baseline (DVOL-era subset) | +DVOL (DVOL-era subset) |
|---|---|---|---|
| 4h (RF, walk-forward CV) | 0.633 ± 0.0036 (n=15,784) | 0.6125 ± 0.0502 (n=11,473) | 0.6185 ± 0.0463 |
| 1d (RF, walk-forward CV) | 0.597 ± 0.0505 (n=2,627) | 0.5491 ± 0.1172 (n=1,907) | 0.5494 ± 0.1287 |

**Conclusion: DVOL does not produce a real improvement.** The apples-to-apples deltas (+0.006 on
4h, +0.0003 on 1d) are an order of magnitude smaller than the fold-to-fold std (0.046-0.13) —
indistinguishable from noise, not a signal. The bigger, more important finding is actually the
*baseline* drop when restricting to the DVOL-era window alone (0.633→0.6125 on 4h, before DVOL is
even added) — 2021-onward is a harder/noisier period for this task than the full 2017-2024 history
(fewer rows, fewer independent CV folds, and it spans BTC's most violent bear market). That window
effect, not DVOL's absence, is most of why the DVOL-era numbers look worse than the full-history
baseline. Implied volatility from options pricing, despite being conceptually the strongest
new-data candidate tried so far, adds nothing measurable once evaluated honestly.

`dvol_close`/`dvol_change_1` are left in the production feature pipeline (harmless, may have value
for other targets later) but should **not** be used to claim an improved volatility-regime model.
This closes the open question from `ml/STATUS.md` — answered empirically, not just qualitatively.

## Updated bottom line

Price-direction prediction: confirmed dead end (Part 1 stands). **Volatility-regime prediction is
real, strong by this project's standards, and now in the production feature pipeline** — Random
Forest on 4h candles, AUC 0.63 ± 0.004 across walk-forward folds, p≈0 vs a permutation null. This
remains the project's best result; DVOL was the most promising untried lead for pushing it higher
and, evaluated rigorously, did not work (#10). No further new-data candidate is currently
identified — future work would need either a fundamentally different target/horizon, or accepting
0.63 as the ceiling for this approach.
