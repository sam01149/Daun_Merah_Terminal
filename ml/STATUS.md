# BTC Model Project — Status Snapshot (2026-06-19, updated)

Working notes for resuming this work. Not a polished report — see `ml/results/REPORT.md` for the
narrative writeup.

## TL;DR

- Price-direction prediction: **dead end**, confirmed multiple ways (single split, walk-forward
  CV, permutation test, regression). Do not revisit without genuinely new data/ideas.
- Volatility-regime classification: **the project's best result** — Random Forest, 4h candles,
  walk-forward CV AUC 0.633 ± 0.0036, permutation-test significant (p≈0). Wired into the official
  Node feature pipeline (`target_vol_regime_6` column).
- DVOL (Deribit implied volatility) feature: **finished and tested — does not help.** Integration
  is complete (`dvol_close`, `dvol_change_1` columns in the feature pipeline), and the rigorous
  walk-forward CV + permutation-test comparison (same-rows baseline vs +DVOL) shows the AUC delta
  (+0.006 on 4h, +0.0003 on 1d) is far smaller than fold-to-fold noise (std 0.046-0.13). Full
  writeup: `ml/results/REPORT.md` section 10. This answers the open "can we push AUC toward 0.70-
  0.80" question empirically — no further new-data candidate currently identified.

## What's pushed to GitHub (origin/main) right now

Check `git status`/`git log` for current truth — this file is a snapshot, not authoritative.

## Key numbers to remember (so you don't have to re-derive them)

| Result | Value |
|---|---|
| Best direction-prediction CV result (Random Forest, 4h/1-day) | AUC 0.528 ± 0.018 |
| Best volatility-regime CV result (Random Forest, 4h, full history, no DVOL) | **AUC 0.633 ± 0.0036** |
| Permutation null for that vol-regime result | mean 0.500, std 0.006, p≈0 |
| Volatility-regime, DVOL-era subset only, no DVOL feature (4h) | AUC 0.6125 ± 0.0502 (n=11,473) |
| Volatility-regime, DVOL-era subset, +DVOL feature (4h) | AUC 0.6185 ± 0.0463 (n=11,473) — not a real improvement |
| COT contrarian correlation (native weekly, ~1-2mo horizon) | -0.16 to -0.18 |
| Rolling vs expanding CV window (direction, 4h/1-day) | 0.533±0.014 vs 0.528±0.018 |

## Open question — now answered

"Bisa nggak sampai 80% (AUC)?" — DVOL was the strongest candidate for new information to test this
against (forward-looking implied vol vs the backward-looking realized-vol features already used).
Tested rigorously (walk-forward CV + permutation test, same-rows comparison to avoid confounding
with DVOL's shorter 2021+ history): **no measurable improvement.** 0.63 currently looks like the
ceiling for this feature set/approach; reaching 0.70-0.80 would need a fundamentally different
target, horizon, or data source — not yet identified.

## Rejected ideas (don't re-suggest without new justification)

- Vanilla GBM Monte Carlo for TP/SL probability — assumes constant volatility (contradicts the
  vol-clustering finding) and Gaussian shocks (contradicts fat-tailed returns in EDA).
- Volume bars — rationale (markets quiet on weekends) doesn't apply to BTC's 24/7 trading.
- ARIMA on raw returns — ACF/PACF empirically ~0 at all lags, nothing to fit.
- DVOL as a volatility-regime feature — tested rigorously, no real improvement (see above). Could
  still be revisited for a *different* target (e.g. predicting DVOL itself, or option-market-vs-
  realized-vol spread) but not for this target without new justification.
