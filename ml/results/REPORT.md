# BTC Direction Model — Comparison Report

Trained 5 algorithms (Logistic Regression, Random Forest, Gradient Boosting, MLP, LSTM) plus
2 naive baselines, across 4 configs (timeframe × horizon), evaluated on a **chronological**
80/20 train/test split (test set is always the most recent ~20% of history — no shuffling,
no lookahead).

## Results

| Config | Model | Accuracy | Precision | Recall | F1 | ROC-AUC |
|---|---|---|---|---|---|---|
| 4h / 1-day horizon | baseline (majority) | 51.1% | 0.511 | 1.000 | 0.677 | — |
| 4h / 1-day horizon | baseline (momentum) | 49.3% | 0.504 | 0.498 | 0.501 | — |
| 4h / 1-day horizon | Logistic Regression | 52.3% | 0.539 | 0.466 | 0.500 | 0.530 |
| 4h / 1-day horizon | **Random Forest** | **52.6%** | 0.527 | 0.714 | 0.606 | **0.531** |
| 4h / 1-day horizon | Gradient Boosting | 51.7% | 0.529 | 0.512 | 0.520 | 0.516 |
| 4h / 1-day horizon | MLP | 50.3% | 0.509 | 0.798 | 0.622 | 0.509 |
| 4h / 1-day horizon | LSTM | 49.6% | 0.505 | 0.746 | 0.602 | 0.505 |
| 4h / 3-day horizon | baseline (majority) | 51.8% | 0.518 | 1.000 | 0.682 | — |
| 4h / 3-day horizon | baseline (momentum) | 49.4% | 0.511 | 0.500 | 0.505 | — |
| 4h / 3-day horizon | Logistic Regression | 52.3% | 0.524 | 0.847 | 0.648 | 0.500 |
| 4h / 3-day horizon | **Random Forest** | **53.3%** | 0.536 | 0.720 | 0.614 | **0.546** |
| 4h / 3-day horizon | Gradient Boosting | 52.5% | 0.529 | 0.761 | 0.624 | 0.542 |
| 4h / 3-day horizon | MLP | 50.1% | 0.512 | 0.794 | 0.622 | 0.492 |
| 4h / 3-day horizon | LSTM | 51.4% | 0.518 | 0.880 | 0.652 | 0.494 |
| 1d / 6-day horizon | baseline (majority) | 50.7% | 0.507 | 1.000 | 0.673 | — |
| 1d / 6-day horizon | baseline (momentum) | 47.5% | 0.481 | 0.470 | 0.476 | — |
| 1d / 6-day horizon | Logistic Regression | 51.0% | 0.509 | 0.894 | 0.649 | 0.467 |
| 1d / 6-day horizon | Random Forest | 48.0% | 0.489 | 0.613 | 0.544 | 0.502 |
| 1d / 6-day horizon | Gradient Boosting | 50.8% | 0.515 | 0.500 | 0.508 | 0.503 |
| 1d / 6-day horizon | MLP | 50.7% | 0.508 | 0.851 | 0.636 | 0.475 |
| 1d / 6-day horizon | LSTM | 48.8% | 0.496 | 0.593 | 0.540 | 0.501 |
| 1d / 18-day horizon | baseline (majority) | 49.3% | 0.493 | 1.000 | 0.661 | — |
| 1d / 18-day horizon | baseline (momentum) | 48.2% | 0.475 | 0.485 | 0.480 | — |
| 1d / 18-day horizon | Logistic Regression | 52.9% | 0.512 | 0.939 | 0.663 | 0.493 |
| 1d / 18-day horizon | **Random Forest** | **55.6%** | 0.546 | 0.587 | 0.566 | **0.569** |
| 1d / 18-day horizon | Gradient Boosting | 48.8% | 0.479 | 0.437 | 0.457 | 0.498 |
| 1d / 18-day horizon | MLP | 51.7% | 0.507 | 0.751 | 0.605 | 0.509 |
| 1d / 18-day horizon | LSTM | 48.2% | 0.482 | 0.689 | 0.567 | 0.480 |

(Full numbers in `model_comparison.json`.)

## Honest conclusion

**Random Forest is the most consistent winner** — best or tied-best ROC-AUC in 3 of 4 configs,
and the single best result overall: **55.6% accuracy / 0.569 AUC on the 1-day candles, 18-day
horizon** (the closest to a genuine swing-trade setup).

But calibrate that number correctly:
- **ROC-AUC of 0.50 = pure coin flip. 0.57 is a very weak edge** — for comparison, a "good"
  trading model in liquid markets is often considered to start around 0.55-0.60 AUC, so this
  result sits right at the bottom of what's even potentially useful, not comfortably inside it.
- Accuracy gains over the naive majority-class baseline are small everywhere: **+1.5 points**
  on the 4h/1-day config, **+5.9 points** at best (1d/18-day, Random Forest). Most of that gap
  is recoverable noise, not a reliably repeatable edge — it needs out-of-sample validation
  across more periods before trusting it at all.
- **LSTM did not outperform the simpler models** despite being the "deep learning" option.
  This is a common, honest finding in financial ML on data this size and this noisy: tabular
  technical+macro features capture what structure exists, and a sequence model doesn't have
  enough signal-to-noise ratio in this dataset to extract more from the raw temporal ordering.
- High recall on several models (MLP, LSTM, Logistic Regression — often 0.75-0.94) is **not**
  a sign of skill here. It's an artifact of the ~51-54% class imbalance toward "up" days
  pushing the default 0.5 decision threshold to over-predict the majority class. ROC-AUC
  (threshold-independent) is the metric that actually matters, and it stays close to 0.50
  across the board.

**Bottom line:** this confirms the calibrated expectation set before building this — there is
no strong directional edge in this feature set. The best config (Random Forest, 1d/18-day) is
borderline usable as a *very soft* probabilistic lean for thesis narrative ("slightly favors
up, weak confidence"), not as a standalone trading signal. Don't size positions off this.

## Next options (not yet done)
- Re-validate the Random Forest/1d/18-day result with walk-forward cross-validation (multiple
  train/test splits across history) instead of a single split, to check it isn't a fluke of
  this particular test window.
- Feature pruning / importance analysis — some of the 22 features are likely just noise that
  hurts more than helps; a smaller, curated set might do better than throwing everything in.
- If the goal shifts from "predict direction" to "flag elevated volatility/regime," that may
  be a more learnable target than directional sign, which is close to a random walk by nature.
