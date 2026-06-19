"""
Deeper look at the COT contrarian signal found in EDA: cot_net_noncomm had the strongest
(still weak) correlation with target_ret_6 (-0.11 on daily data).

Important nuance: that EDA correlation was computed on data/btc/clean_1d.csv, where each
weekly COT report is forward-filled across ~7 daily rows — so the "3228 rows" aren't 3228
independent observations of the COT/return relationship, they're ~427 independent COT reports
each repeated ~7 times with a different forward-return draw. This script re-does the analysis
at COT's *native* weekly resolution (427 reports) to see if the signal still holds, then checks
whether it survives an out-of-sample chronological split before treating it as real.

Local experiment only. Usage: python ml/cot_analysis.py
"""
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

DATA_DIR = Path(__file__).resolve().parent.parent / "data" / "btc"
OUT_DIR = Path(__file__).resolve().parent / "eda_output"
OUT_DIR.mkdir(exist_ok=True)

COT_PUBLISH_LAG_MS = 3 * 86400 * 1000
HORIZONS = {"1w": 5, "2w": 10, "~1m": 20, "~2m": 40}


def build_native_weekly():
    ohlcv = pd.read_csv(DATA_DIR / "ohlcv_1d.csv").sort_values("timestamp").reset_index(drop=True)
    ohlcv["idx"] = ohlcv.index

    cot = pd.read_csv(DATA_DIR / "cot_bitcoin.csv").sort_values("timestamp").reset_index(drop=True)
    cot["timestamp"] = cot["timestamp"] + COT_PUBLISH_LAG_MS
    cot["net_pct"] = (cot["noncomm_long"] - cot["noncomm_short"]) / cot["open_interest"]
    cot["long_pct"] = cot["noncomm_long"] / cot["open_interest"]

    merged = pd.merge_asof(cot, ohlcv[["timestamp", "close", "idx"]], on="timestamp", direction="backward")

    closes = ohlcv["close"].values
    for label, h in HORIZONS.items():
        merged[f"fwd_ret_{label}"] = merged["idx"].apply(
            lambda i, h=h: closes[i + h] / closes[i] - 1 if i + h < len(closes) else np.nan
        )
    return merged.dropna(subset=["close"]).reset_index(drop=True)


def correlation_table(df):
    print(f"\n=== Native weekly resolution: {len(df)} independent COT reports ===")
    print(f"{'horizon':10s} {'corr(net_pct)':>15s} {'corr(long_pct)':>16s}")
    for label in HORIZONS:
        col = f"fwd_ret_{label}"
        sub = df[["net_pct", "long_pct", col]].dropna()
        c1 = sub["net_pct"].corr(sub[col])
        c2 = sub["long_pct"].corr(sub[col])
        print(f"{label:10s} {c1:15.4f} {c2:16.4f}")


def quintile_analysis(df, horizon="~1m"):
    print(f"\n=== Quintile bucket analysis (forward return at {horizon}) ===")
    col = f"fwd_ret_{horizon}"
    sub = df[["net_pct", col]].dropna().copy()
    sub["quintile"] = pd.qcut(sub["net_pct"], 5, labels=["Q1 (most short)", "Q2", "Q3", "Q4", "Q5 (most long)"])
    table = sub.groupby("quintile")[col].agg(["mean", "count"])
    print(table.to_string())
    monotonic_down = table["mean"].is_monotonic_decreasing
    print(f"\nMonotonically decreasing Q1->Q5 (contrarian pattern)? {monotonic_down}")
    return table


def extreme_zscore_backtest(df, horizon="~1m", window=52, z_thresh=1.0):
    print(f"\n=== Extreme z-score backtest (window={window} reports, threshold=+/-{z_thresh}) ===")
    col = f"fwd_ret_{horizon}"
    df = df.copy()
    df["net_pct_z"] = (df["net_pct"] - df["net_pct"].rolling(window).mean()) / df["net_pct"].rolling(window).std()
    sub = df.dropna(subset=["net_pct_z", col])

    extreme_long = sub[sub["net_pct_z"] > z_thresh]
    extreme_short = sub[sub["net_pct_z"] < -z_thresh]
    neutral = sub[sub["net_pct_z"].abs() <= z_thresh]

    print(f"Extreme LONG positioning (z>{z_thresh}): n={len(extreme_long)}, mean fwd return = {extreme_long[col].mean():+.4f}")
    print(f"Extreme SHORT positioning (z<-{z_thresh}): n={len(extreme_short)}, mean fwd return = {extreme_short[col].mean():+.4f}")
    print(f"Neutral: n={len(neutral)}, mean fwd return = {neutral[col].mean():+.4f}")
    print(f"All reports: mean fwd return = {sub[col].mean():+.4f}")
    return sub


def out_of_sample_check(df, horizon="~1m", test_frac=0.2):
    print(f"\n=== Out-of-sample check (chronological 80/20 split, horizon={horizon}) ===")
    col = f"fwd_ret_{horizon}"
    sub = df[["timestamp", "net_pct", col]].dropna().reset_index(drop=True)
    split = int(len(sub) * (1 - test_frac))
    train, test = sub.iloc[:split], sub.iloc[split:]

    train_corr = train["net_pct"].corr(train[col])
    test_corr = test["net_pct"].corr(test[col])
    print(f"Train ({len(train)} reports) correlation: {train_corr:+.4f}")
    print(f"Test  ({len(test)} reports) correlation:  {test_corr:+.4f}")

    # Use train-set quintile boundaries, apply to test set
    q_bounds = train["net_pct"].quantile([0.2, 0.4, 0.6, 0.8]).values
    test = test.copy()
    test["bucket"] = pd.cut(test["net_pct"], bins=[-np.inf, *q_bounds, np.inf], labels=["Q1", "Q2", "Q3", "Q4", "Q5"])
    print("\nTest-set mean forward return by train-defined quintile:")
    print(test.groupby("bucket")[col].agg(["mean", "count"]).to_string())
    return train_corr, test_corr


def plot_scatter(df, horizon="~1m"):
    col = f"fwd_ret_{horizon}"
    sub = df[["net_pct", col]].dropna()
    fig, ax = plt.subplots(figsize=(8, 6))
    ax.scatter(sub["net_pct"], sub[col], alpha=0.4, s=15)
    z = np.polyfit(sub["net_pct"], sub[col], 1)
    xs = np.linspace(sub["net_pct"].min(), sub["net_pct"].max(), 50)
    ax.plot(xs, np.poly1d(z)(xs), color="red", lw=2, label=f"linear fit (slope={z[0]:.3f})")
    ax.axhline(0, color="grey", lw=0.5)
    ax.axvline(0, color="grey", lw=0.5)
    ax.set_xlabel("COT net positioning (% of open interest)")
    ax.set_ylabel(f"forward return ({horizon})")
    ax.set_title(f"COT net positioning vs forward return ({horizon}) — native weekly resolution, n={len(sub)}")
    ax.legend()
    out = OUT_DIR / f"cot_contrarian_scatter_{horizon}.png"
    plt.savefig(out, dpi=110)
    plt.close()
    print(f"\nSaved {out}")


def main():
    df = build_native_weekly()
    correlation_table(df)
    quintile_analysis(df, "~1m")
    extreme_zscore_backtest(df, "~1m")
    out_of_sample_check(df, "~1m")
    plot_scatter(df, "~1m")


if __name__ == "__main__":
    main()
