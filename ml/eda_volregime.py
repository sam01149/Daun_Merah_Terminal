"""
EDA specifically for the volatility-regime target (target_vol_regime_6), which has never been
profiled on its own — every existing EDA/diagnostics script (eda.py, feature_diagnostics.py) was
written for the price-direction target, before volatility-regime became the project's lead
result. Re-checking data prep here, on the user's request, before reaching for new external data
(GARCH/VIX) — looking for cheaper wins first: feature importance, temporal stability, alternative
volatility estimators, and whether the rolling-window choices (6/20-period) are actually the best
available from data already in hand.

Usage: python ml/eda_volregime.py
"""
import warnings
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import roc_auc_score
from statsmodels.tsa.stattools import acf

from train_models import FEATURE_COLS, chronological_split
from volatility_regime import build_dataset, HORIZON, ROLL_QUANTILE_WINDOW, QUANTILE_THRESHOLD

warnings.filterwarnings("ignore")
np.random.seed(42)
OUT_DIR = Path(__file__).resolve().parent / "eda_output"
OUT_DIR.mkdir(exist_ok=True)


def temporal_distribution(df, timeframe):
    df = df.copy()
    df["date"] = pd.to_datetime(df["date_iso"])
    df["year"] = df["date"].dt.year
    by_year = df.groupby("year")["target_vol_regime"].agg(["mean", "count"])
    print(f"\n=== Temporal distribution of target_vol_regime=1, by year ({timeframe}) ===")
    print(by_year.to_string())
    print("(base rate should hover near 0.30 by construction — big year-to-year swings mean CV")
    print(" folds straddling those years will see very different positive rates, which is the")
    print(" likely source of the high fold-to-fold std seen in 1d walk-forward CV.)")


def feature_importance(df, cols, timeframe):
    n = len(df)
    split = chronological_split(n, 0.2)
    X_train, y_train = df[cols].iloc[:split], df["target_vol_regime"].iloc[:split].astype(int)
    X_test, y_test = df[cols].iloc[split:], df["target_vol_regime"].iloc[split:].astype(int)

    rf = RandomForestClassifier(n_estimators=300, max_depth=6, min_samples_leaf=20, random_state=42, n_jobs=-1)
    rf.fit(X_train, y_train)
    importances = pd.Series(rf.feature_importances_, index=cols).sort_values(ascending=False)

    print(f"\n=== Random Forest feature importance for target_vol_regime ({timeframe}) ===")
    print(importances.to_string())
    full_auc = roc_auc_score(y_test, rf.predict_proba(X_test)[:, 1])
    print(f"Full feature set single-split test AUC: {full_auc:.4f}")
    return importances


def minimal_vs_full(df, cols, timeframe):
    n = len(df)
    split = chronological_split(n, 0.2)
    configs = {
        "realized_vol_20 only (1 feature)": ["realized_vol_20"],
        "vol-level only (3 features: realized_vol_6/20, parkinson_vol_mean_6)":
            ["realized_vol_6", "realized_vol_20", "parkinson_vol_mean_6"],
        "full feature set": cols,
    }
    print(f"\n=== Minimal vol-only vs kitchen-sink ({timeframe}) ===")
    for name, c in configs.items():
        X_train, y_train = df[c].iloc[:split], df["target_vol_regime"].iloc[:split].astype(int)
        X_test, y_test = df[c].iloc[split:], df["target_vol_regime"].iloc[split:].astype(int)
        rf = RandomForestClassifier(n_estimators=300, max_depth=6, min_samples_leaf=20, random_state=42, n_jobs=-1)
        rf.fit(X_train, y_train)
        auc = roc_auc_score(y_test, rf.predict_proba(X_test)[:, 1])
        print(f"  {name:55s} test AUC = {auc:.4f}")


def vol_memory_acf(df, timeframe, max_lag=60):
    series = df["realized_vol_6"].dropna()
    vals = acf(series, nlags=max_lag, fft=True)
    print(f"\n=== ACF of realized_vol_6 itself (not |return|) ({timeframe}) ===")
    print(f"  lag 1:  {vals[1]:.3f}   lag 6:  {vals[6]:.3f}   lag 20: {vals[20]:.3f}   "
          f"lag {max_lag}: {vals[max_lag]:.3f}")
    plt.figure(figsize=(8, 4))
    plt.bar(range(len(vals)), vals)
    plt.title(f"ACF of realized_vol_6 ({timeframe}) — how far back does 'vol memory' extend")
    plt.xlabel("lag")
    plt.tight_layout()
    out = OUT_DIR / f"vol_memory_acf_{timeframe}.png"
    plt.savefig(out, dpi=110)
    plt.close()
    print(f"  Saved {out}")
    return vals


def alt_vol_estimators(df, timeframe):
    """Garman-Klass and Rogers-Satchell are more statistically efficient OHLC-based volatility
    estimators than the close-to-close std / Parkinson estimator already in use — cheap to add
    (no new data source, just a different formula on data already collected) if they correlate
    with the target better than what's there now."""
    data_dir = Path(__file__).resolve().parent.parent / "data" / "btc"
    ohlcv_open = pd.read_csv(data_dir / f"ohlcv_{timeframe}.csv")[["timestamp", "open"]]
    df = df.merge(ohlcv_open, on="timestamp", how="left")
    o, h, l, c = df["open"], df["high"], df["low"], df["close"]
    gk = np.sqrt(0.5 * np.log(h / l) ** 2 - (2 * np.log(2) - 1) * np.log(c / o) ** 2)
    rs = np.sqrt(
        np.log(h / c) * np.log(h / o) + np.log(l / c) * np.log(l / o)
    )
    df = df.copy()
    df["gk_vol"] = gk.rolling(6).mean()
    df["rs_vol"] = rs.rolling(6).mean()

    print(f"\n=== Alternative OHLC volatility estimators vs target_vol_regime ({timeframe}) ===")
    for col in ["realized_vol_6", "parkinson_vol_mean_6", "gk_vol", "rs_vol"]:
        valid = df[[col, "target_vol_regime"]].dropna()
        corr = valid[col].corr(valid["target_vol_regime"])
        print(f"  {col:25s} Pearson corr with target = {corr:+.4f}")
    return df


def lookback_window_sweep(df, timeframe):
    """Is 6/20-period realized vol actually the best lookback, or would a longer/shorter window
    correlate more strongly with the forward-vol target? Cheap to check before assuming GARCH is
    needed — a longer EWMA of realized vol is a simpler way to capture more persistence."""
    print(f"\n=== Realized-vol lookback window sweep vs target_vol_regime ({timeframe}) ===")
    logret = df["log_ret_1"].fillna(0)
    for window in [3, 6, 12, 20, 50, 100, 200]:
        vol = logret.rolling(window).std()
        valid = pd.DataFrame({"vol": vol, "target": df["target_vol_regime"]}).dropna()
        corr = valid["vol"].corr(valid["target"])
        print(f"  window={window:4d}  Pearson corr = {corr:+.4f}")


def main():
    for timeframe in ["4h", "1d"]:
        print(f"\n{'='*70}\nVolatility-regime EDA — {timeframe}\n{'='*70}")
        df, cols = build_dataset(timeframe, use_dvol=False)
        temporal_distribution(df, timeframe)
        feature_importance(df, cols, timeframe)
        minimal_vs_full(df, cols, timeframe)
        vol_memory_acf(df, timeframe)
        alt_vol_estimators(df, timeframe)
        lookback_window_sweep(df, timeframe)


if __name__ == "__main__":
    main()
