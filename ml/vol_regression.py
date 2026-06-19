"""
Regression on the volatility-regime target's underlying CONTINUOUS value (forward_vol — realized
volatility over the next HORIZON periods), distinct from both prior regression work:
- train_regression.py regresses *return magnitude* (target_ret_6/18), a different target entirely.
- volatility_regime.py only ever classifies the binarized version (top 30% or not).

Predicting the actual magnitude (not just high/low) would be more useful in practice (e.g. scaling
stop-loss/position size continuously instead of a binary flag) if it works — but it might not:
regression is a harder problem than classification at the same threshold, and this project has
already found return-magnitude regression to fail completely (negative R² everywhere). Testing
with the same rigor (walk-forward CV, comparison against naive baselines) rather than assuming
either outcome.

Usage: python ml/vol_regression.py
"""
import warnings

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingRegressor, RandomForestRegressor
from sklearn.linear_model import LinearRegression
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.neural_network import MLPRegressor
from sklearn.preprocessing import StandardScaler

from volatility_regime import build_dataset

warnings.filterwarnings("ignore")
np.random.seed(42)


def build_regression_dataset(timeframe):
    df, cols = build_dataset(timeframe, use_dvol=False)
    # build_dataset's own dropna already restricted to cols + target_vol_regime; forward_vol
    # rides along but may still be NaN near the series end (last HORIZON rows) — drop those too.
    df = df.dropna(subset=["forward_vol"]).reset_index(drop=True)
    return df, cols


def reg_metrics(y_true, y_pred):
    return {
        "mae": round(mean_absolute_error(y_true, y_pred), 6),
        "rmse": round(np.sqrt(mean_squared_error(y_true, y_pred)), 6),
        "r2": round(r2_score(y_true, y_pred), 4),
    }


def single_split_eval(df, cols, timeframe):
    n = len(df)
    split = int(n * 0.8)
    X, y = df[cols], df["forward_vol"]
    X_train, X_test = X.iloc[:split], X.iloc[split:]
    y_train, y_test = y.iloc[:split], y.iloc[split:]

    print(f"\n=== {timeframe}: single split (n={n}, train={split}, test={n-split}) ===")
    print(f"forward_vol — train mean={y_train.mean():.5f} std={y_train.std():.5f}, "
          f"test mean={y_test.mean():.5f} std={y_test.std():.5f}")

    scaler = StandardScaler().fit(X_train)
    Xtr_s, Xte_s = scaler.transform(X_train), scaler.transform(X_test)

    results = {}
    results["baseline_predict_train_mean"] = reg_metrics(y_test, np.full(len(y_test), y_train.mean()))
    # Persistence baseline: "tomorrow's vol = today's realized_vol_20" — the simplest possible
    # forecast, and the one a GARCH/EWMA-style naive approach effectively reduces to.
    results["baseline_persistence_vol20"] = reg_metrics(y_test, X_test["realized_vol_20"].values)

    lin = LinearRegression().fit(Xtr_s, y_train)
    results["linear_regression"] = reg_metrics(y_test, lin.predict(Xte_s))

    rf = RandomForestRegressor(n_estimators=300, max_depth=6, min_samples_leaf=20, random_state=42, n_jobs=-1).fit(X_train, y_train)
    results["random_forest"] = reg_metrics(y_test, rf.predict(X_test))

    gb = GradientBoostingRegressor(max_depth=4, learning_rate=0.05, n_estimators=300, random_state=42).fit(X_train, y_train)
    results["gradient_boosting"] = reg_metrics(y_test, gb.predict(X_test))

    mlp = MLPRegressor(hidden_layer_sizes=(64, 32), max_iter=500, early_stopping=True, random_state=42).fit(Xtr_s, y_train)
    results["mlp"] = reg_metrics(y_test, mlp.predict(Xte_s))

    print(f"{'model':28s} {'mae':>10s} {'rmse':>10s} {'r2':>8s}")
    for name, m in results.items():
        print(f"{name:28s} {m['mae']:10.6f} {m['rmse']:10.6f} {m['r2']:8.4f}")
    return results


def walk_forward_cv(df, cols, timeframe, n_folds=5):
    n = len(df)
    chunk = n // n_folds
    bounds = [i * chunk for i in range(n_folds)] + [n]
    results = {name: [] for name in ["linear_regression", "random_forest", "gradient_boosting", "mlp", "baseline_persistence_vol20"]}

    print(f"\n=== {timeframe}: walk-forward CV, {n_folds-1} folds ===")
    for f in range(1, n_folds):
        Xtr, ytr = df[cols].iloc[:bounds[f]], df["forward_vol"].iloc[:bounds[f]]
        Xte, yte = df[cols].iloc[bounds[f]:bounds[f+1]], df["forward_vol"].iloc[bounds[f]:bounds[f+1]]

        scaler = StandardScaler().fit(Xtr)
        Xtr_s, Xte_s = scaler.transform(Xtr), scaler.transform(Xte)

        results["baseline_persistence_vol20"].append(r2_score(yte, Xte["realized_vol_20"].values))

        lin = LinearRegression().fit(Xtr_s, ytr)
        results["linear_regression"].append(r2_score(yte, lin.predict(Xte_s)))

        rf = RandomForestRegressor(n_estimators=300, max_depth=6, min_samples_leaf=20, random_state=42, n_jobs=-1).fit(Xtr, ytr)
        results["random_forest"].append(r2_score(yte, rf.predict(Xte)))

        gb = GradientBoostingRegressor(max_depth=4, learning_rate=0.05, n_estimators=300, random_state=42).fit(Xtr, ytr)
        results["gradient_boosting"].append(r2_score(yte, gb.predict(Xte)))

        mlp = MLPRegressor(hidden_layer_sizes=(64, 32), max_iter=500, early_stopping=True, random_state=42).fit(Xtr_s, ytr)
        results["mlp"].append(r2_score(yte, mlp.predict(Xte_s)))

        print(f"  fold {f}: persistence={results['baseline_persistence_vol20'][-1]:+.4f}  "
              f"LR={results['linear_regression'][-1]:+.4f}  RF={results['random_forest'][-1]:+.4f}  "
              f"GB={results['gradient_boosting'][-1]:+.4f}  MLP={results['mlp'][-1]:+.4f}")

    print(f"\n{'model':28s} {'mean R2':>10s} {'std':>8s}")
    for name, r2s in results.items():
        print(f"{name:28s} {np.mean(r2s):10.4f} {np.std(r2s):8.4f}")
    return results


def main():
    for timeframe in ["4h", "1d"]:
        print(f"\n{'='*70}\nVolatility magnitude regression (forward_vol) — {timeframe}\n{'='*70}")
        df, cols = build_regression_dataset(timeframe)
        single_split_eval(df, cols, timeframe)
        walk_forward_cv(df, cols, timeframe)


if __name__ == "__main__":
    main()
