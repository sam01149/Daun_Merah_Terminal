"""
Two cheap feature ideas motivated directly by eda_volregime.py findings, tested BEFORE reaching
for new external data sources (GARCH/VIX were the original plan, but EDA suggested these first):

1. GARCH(1,1) conditional volatility — eda_volregime.py found realized_vol_6's own ACF decays
   slowly (lag6=0.43, lag20=0.35, lag60=0.21 on 4h), i.e. more "vol memory" than the fixed 6/20
   windows already in use capture. GARCH(1,1) explicitly estimates the persistence (alpha+beta)
   instead of using an arbitrary fixed window — a more principled way to use that memory.
2. fear_greed extremity (|value-50|) — fear_greed ranked in the top-5 most important features for
   target_vol_regime in BOTH timeframes (eda_volregime.py), but only the raw value was ever used.
   Extreme sentiment in EITHER direction (panic or euphoria) plausibly precedes vol expansion,
   which a signed value can't capture — extremity might be a sharper version of the same signal.

No-lookahead discipline: GARCH parameters are estimated from each CV fold's TRAINING data only,
then the fitted (frozen) parameters are used to filter conditional volatility through the full
series — conditional vol at time t still only depends on returns up to t, so this is a legitimate
out-of-sample feature, not refit on data the fold hasn't seen yet.

Usage: python ml/vol_regime_garch.py
"""
import warnings

import numpy as np
import pandas as pd
from arch import arch_model
from sklearn.ensemble import RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.preprocessing import StandardScaler

from volatility_regime import build_dataset

warnings.filterwarnings("ignore")
np.random.seed(42)


def add_fear_greed_extremity(df):
    df = df.copy()
    df["fear_greed_extreme"] = (df["fear_greed"] - 50).abs()
    return df


def garch_conditional_vol(log_ret, train_end):
    """Fit GARCH(1,1) on log_ret[:train_end] only, then filter the FIXED parameters through the
    entire series to get a conditional-vol path with no lookahead into the fold's test period."""
    scaled = log_ret.fillna(0) * 100  # arch numerically prefers returns scaled to ~percent
    train_returns = scaled.iloc[:train_end]
    model_train = arch_model(train_returns, vol="Garch", p=1, q=1, dist="normal", rescale=False)
    res_train = model_train.fit(disp="off", show_warning=False)

    model_full = arch_model(scaled, vol="Garch", p=1, q=1, dist="normal", rescale=False)
    res_full = model_full.fix(res_train.params)
    return res_full.conditional_volatility.values


def walk_forward_cv_with_features(df, base_cols, extra_cols, n_folds=5, label=""):
    n = len(df)
    chunk = n // n_folds
    bounds = [i * chunk for i in range(n_folds)] + [n]
    results = {"logistic_regression": [], "random_forest": []}

    print(f"\n--- {label} ---")
    for f in range(1, n_folds):
        cols = base_cols + extra_cols
        df_fold = df.copy()
        if "garch_vol" in extra_cols:
            df_fold["garch_vol"] = garch_conditional_vol(df_fold["log_ret_1"], bounds[f])

        fold_df = df_fold.dropna(subset=cols + ["target_vol_regime"]).reset_index(drop=True)
        # Recompute fold boundaries on the post-dropna frame proportionally — garch_vol has no
        # NaNs (GARCH fits the whole series), so dropna here only affects rows already dropped
        # upstream; bounds stay valid as long as we index the ALREADY-aligned df, not fold_df.
        Xtr, ytr = df_fold[cols].iloc[:bounds[f]], df_fold["target_vol_regime"].iloc[:bounds[f]]
        Xte, yte = df_fold[cols].iloc[bounds[f]:bounds[f+1]], df_fold["target_vol_regime"].iloc[bounds[f]:bounds[f+1]]
        mask_tr = Xtr.notna().all(axis=1) & ytr.notna()
        mask_te = Xte.notna().all(axis=1) & yte.notna()
        Xtr, ytr = Xtr[mask_tr], ytr[mask_tr].astype(int)
        Xte, yte = Xte[mask_te], yte[mask_te].astype(int)
        if len(set(ytr)) < 2 or len(Xte) == 0:
            continue

        scaler = StandardScaler().fit(Xtr)
        Xtr_s, Xte_s = scaler.transform(Xtr), scaler.transform(Xte)

        lr = LogisticRegression(max_iter=1000).fit(Xtr_s, ytr)
        results["logistic_regression"].append(roc_auc_score(yte, lr.predict_proba(Xte_s)[:, 1]))

        rf = RandomForestClassifier(n_estimators=300, max_depth=6, min_samples_leaf=20, random_state=42, n_jobs=-1).fit(Xtr, ytr)
        results["random_forest"].append(roc_auc_score(yte, rf.predict_proba(Xte)[:, 1]))

        print(f"  fold {f}: LR={results['logistic_regression'][-1]:.4f}  RF={results['random_forest'][-1]:.4f}  (n_test={len(Xte)})")

    for name, aucs in results.items():
        if aucs:
            print(f"  {name:22s} mean={np.mean(aucs):.4f}  std={np.std(aucs):.4f}")
    return results


def main():
    for timeframe in ["4h", "1d"]:
        print(f"\n{'='*70}\n{timeframe} — baseline vs +fear_greed_extreme vs +GARCH vs +both\n{'='*70}")
        df, base_cols = build_dataset(timeframe, use_dvol=False)
        df = add_fear_greed_extremity(df)

        walk_forward_cv_with_features(df, base_cols, [], label="baseline (no new features)")
        walk_forward_cv_with_features(df, base_cols, ["fear_greed_extreme"], label="+fear_greed_extreme")
        walk_forward_cv_with_features(df, base_cols, ["garch_vol"], label="+GARCH(1,1) conditional vol")
        walk_forward_cv_with_features(df, base_cols, ["fear_greed_extreme", "garch_vol"], label="+both")


if __name__ == "__main__":
    main()
