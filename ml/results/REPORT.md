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

## Next options (not yet done)
- Feature pruning / importance analysis — some of the 22 features may be pure noise hurting more
  than helping; unlikely to fix the fundamental lack of signal, but worth a quick check.
- Reframe the target: "predict elevated volatility/regime" instead of price direction — volatility
  clustering is a real, well-documented phenomenon in crypto, unlike directional sign which is
  close to a random walk by construction. This is a more promising direction than tuning further.
- If pursuing this further, expand walk-forward folds (e.g. 10 instead of 4) for tighter confidence
  intervals on the one borderline-credible result (Random Forest, 4h/1-day).
