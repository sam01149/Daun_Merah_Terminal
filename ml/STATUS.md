# BTC Model Project — Status Snapshot (2026-06-19, updated)

Working notes for resuming this work. Not a polished report — see `ml/results/REPORT.md` for the
narrative writeup.

## TL;DR

- Price-direction prediction: **dead end**, confirmed multiple ways (single split, walk-forward
  CV, permutation test, regression). Do not revisit without genuinely new data/ideas.
- Volatility-regime classification: **the project's best result** — Random Forest, 4h candles,
  walk-forward CV AUC ~0.63, permutation-test significant (p≈0). Wired into the official Node
  feature pipeline (`target_vol_regime_6` column).
- DVOL (Deribit implied volatility), GARCH(1,1) conditional vol, fear_greed-extremity, and VIX
  (cross-asset macro risk) were all tested as candidate features to push AUC toward the user's
  0.70 target. **None worked** — all deltas were within fold-to-fold noise (VIX's delta was even
  permutation-tested directly: p=0.300, not significant). Root cause for GARCH specifically: its
  conditional vol correlates 0.956 with `realized_vol_20`, already a feature — it re-derives
  existing information rather than adding new information. Full writeup: `ml/results/REPORT.md`
  sections 10-12.
- Multicollinearity in the feature set (16-21 pairs at |corr|>0.7, similar to the direction task's
  known issue) was checked specifically for the vol-regime target and **mitigated**: pruned
  `ret_1`, `macd_signal`, `ema12_gt_ema26`, `cot_noncomm_long_pct`, `bb_pctb` from `FEATURE_COLS`
  and `realized_vol_6` from volatility-regime `extra_cols` (25→19 features). Verified via CV
  before committing — no AUC cost, slightly more stable for Logistic Regression. All dependent
  result files (`model_comparison.json`, `cross_validation.json`, `regression_comparison.json`)
  were regenerated with the pruned feature set to stay consistent with the code.
- Regressing the *continuous* `forward_vol` value (instead of classifying it against a threshold)
  was also tested (`ml/vol_regression.py`) — **fails, and is markedly less stable than
  classification of the same underlying signal.** Random Forest is the only model with a (barely)
  positive mean R² (4h: +0.030±0.049; 1d: -0.195±0.202, clearly negative). Linear Regression and
  Gradient Boosting are negative and unstable across folds; MLP diverges outright (R² in the
  thousands negative). Why: `forward_vol` is a std computed from only 6 returns — a noisy target
  by construction — and classification only needs the *rank* relative to a threshold to survive
  that noise, while regression needs the exact value. **The deployable artifact from this whole
  research line is the binary classifier, not a magnitude forecast.**

## What's pushed to GitHub (origin/main) right now

Check `git status`/`git log` for current truth — this file is a snapshot, not authoritative.

## Key numbers to remember (so you don't have to re-derive them)

| Result | Value |
|---|---|
| Best direction-prediction CV result (Random Forest, 4h/1-day) | AUC 0.528 ± 0.018 |
| Volatility-regime, 4h, RF, walk-forward CV (current, pruned features) | **AUC 0.6302 ± 0.0062** |
| Volatility-regime, 4h, RF, walk-forward CV (before pruning, for reference) | AUC 0.633 ± 0.0036 — statistically the same |
| Permutation null for that vol-regime result | mean ~0.500, std ~0.005, p≈0 |
| Volatility-regime + GARCH(1,1) conditional vol (4h, RF, CV) | 0.6333 ± 0.0031 — no real improvement |
| Volatility-regime + fear_greed extremity (4h, RF, CV) | 0.6322 ± 0.0105 — no real improvement |
| GARCH conditional vol correlation with realized_vol_20 (already a feature) | 0.956 — explains why it added nothing |
| Volatility-regime, DVOL-era subset, +DVOL feature (4h) | AUC 0.6185 ± 0.0463 (n=11,473) — not a real improvement |
| Volatility-regime + VIX (4h, RF, CV) | 0.6286 ± 0.0028 (vs 0.6270 without) — delta not significant, p=0.300 |
| COT contrarian correlation (native weekly, ~1-2mo horizon) | -0.16 to -0.18 |
| Rolling vs expanding CV window (direction, 4h/1-day) | 0.533±0.014 vs 0.528±0.018 |

## Open question — now answered, four times over

"Bisa nggak sampai 80% (atau 70%) AUC?" — tested four candidate routes: new external data (DVOL),
a more principled model of volatility persistence (GARCH), a sentiment-extremity feature
(fear_greed), and cross-asset macro risk (VIX, permutation-tested directly on its delta, p=0.300).
**None improved on ~0.63.** EDA explains why: the existing rolling-window vol features already
capture nearly all of the linearly-recoverable "vol memory" in BTC's own OHLCV history (GARCH's
0.956 correlation with an existing feature is the clearest evidence). 0.63 currently looks like a
real ceiling for this feature set/approach; reaching 0.70-0.80 would need a fundamentally
different target, horizon, or genuinely new data source (not a smarter derivation of data already
collected, and not a weakly-correlated cross-asset proxy either) — none identified yet.

## Rejected ideas (don't re-suggest without new justification)

- Vanilla GBM Monte Carlo for TP/SL probability — assumes constant volatility (contradicts the
  vol-clustering finding) and Gaussian shocks (contradicts fat-tailed returns in EDA).
- Volume bars — rationale (markets quiet on weekends) doesn't apply to BTC's 24/7 trading.
- ARIMA on raw returns — ACF/PACF empirically ~0 at all lags, nothing to fit.
- DVOL as a volatility-regime feature — tested rigorously, no real improvement.
- GARCH(1,1) conditional volatility as a feature — tested rigorously, no real improvement
  (redundant with `realized_vol_20`, corr 0.956). Could be revisited if a feature set ever drops
  the existing rolling-vol features entirely, but not as an addition to them.
- fear_greed extremity (`|value-50|`) — tested rigorously, no real improvement over raw fear_greed.
- Garman-Klass / Rogers-Satchell volatility estimators — correlate with the target almost
  identically to the Parkinson estimator already in use; not worth switching.
- VIX (CBOE volatility index, daily, forward-filled) as a cross-asset feature — tested rigorously,
  delta not significant under direct permutation test (p=0.300). Raw correlation with the target
  was non-trivial (+0.07 to +0.10) but didn't survive into a real CV improvement.
- Regression on volatility magnitude (instead of classification) — tested rigorously, fails and is
  less stable than classification (target is a noisy 6-sample std estimate). Don't re-propose as
  a way to get a continuous output unless the underlying target's sampling noise is addressed
  first (e.g. a longer or differently-estimated realized-vol target).
