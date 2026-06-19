"""
Exploratory Data Analysis on the cleaned BTC dataset (data/btc/clean_1d.csv / clean_4h.csv,
output of ml/preprocess.py). Local experiment only — saves plots + a text summary under
ml/eda_output/, not meant to be pushed yet.

Usage: python ml/eda.py
"""
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from scipy import stats
from statsmodels.graphics.tsaplots import plot_acf, plot_pacf
from statsmodels.tsa.stattools import adfuller

DATA_DIR = Path(__file__).resolve().parent.parent / "data" / "btc"
OUT_DIR = Path(__file__).resolve().parent / "eda_output"
OUT_DIR.mkdir(exist_ok=True)

FEATURE_LIKE_COLS = ["close", "volume", "open_interest", "noncomm_long", "noncomm_short",
                     "comm_long", "comm_short", "fear_greed", "avg_hashrate",
                     "total_stablecoin_cap", "btc_dominance_pct", "ret_1"]

summary_lines = []


def log(line=""):
    print(line)
    summary_lines.append(line)


def load(timeframe):
    df = pd.read_csv(DATA_DIR / f"clean_{timeframe}.csv")
    df["date_iso"] = pd.to_datetime(df["date_iso"])
    # Raw (long - short) trends upward over the years as the futures market has grown — that's
    # a non-stationary confound, same issue fixed in feature-engineering.js. Use net positioning
    # as a % of open interest instead (self-normalizing, doesn't carry the market-growth trend).
    df["cot_net_noncomm"] = (df["noncomm_long"] - df["noncomm_short"]) / df["open_interest"]
    return df


def section(title):
    log(f"\n{'='*70}\n{title}\n{'='*70}")


def basic_overview(df, timeframe):
    section(f"1. OVERVIEW — {timeframe}")
    log(f"Rows: {len(df)}  |  Date range: {df['date_iso'].min().date()} -> {df['date_iso'].max().date()}")
    log(f"Columns: {list(df.columns)}")
    log("\nMissing value %:")
    for col in df.columns:
        pct = df[col].isna().mean() * 100
        if pct > 0:
            log(f"  {col:25s} {pct:5.1f}% missing")


def descriptive_stats(df, timeframe):
    section(f"2. DESCRIPTIVE STATISTICS — {timeframe}")
    cols = [c for c in FEATURE_LIKE_COLS if c in df.columns]
    desc = df[cols].describe().T
    desc["skew"] = df[cols].skew()
    desc["kurtosis"] = df[cols].kurtosis()
    log(desc.to_string())
    return desc


def distribution_plots(df, timeframe):
    section(f"3. DISTRIBUTIONS — {timeframe}")
    fig, axes = plt.subplots(2, 2, figsize=(12, 9))

    ret = df["ret_1"].dropna()
    axes[0, 0].hist(ret, bins=100, color="steelblue")
    axes[0, 0].set_title(f"ret_1 distribution (skew={ret.skew():.2f}, kurt={ret.kurtosis():.2f})")
    axes[0, 0].axvline(0, color="red", lw=1)

    tret6 = df["target_ret_6"].dropna()
    axes[0, 1].hist(tret6, bins=100, color="darkorange")
    axes[0, 1].set_title(f"target_ret_6 distribution (skew={tret6.skew():.2f}, kurt={tret6.kurtosis():.2f})")
    axes[0, 1].axvline(0, color="red", lw=1)

    stats.probplot(ret, dist="norm", plot=axes[1, 0])
    axes[1, 0].set_title("ret_1 Q-Q plot vs normal (fat tails if curved at ends)")

    dir_counts = df["target_dir_6"].dropna().value_counts().sort_index()
    axes[1, 1].bar(["down (0)", "up (1)"], dir_counts.values, color=["crimson", "seagreen"])
    axes[1, 1].set_title(f"target_dir_6 class balance (up={dir_counts.get(1,0)/dir_counts.sum()*100:.1f}%)")

    plt.tight_layout()
    out = OUT_DIR / f"distributions_{timeframe}.png"
    plt.savefig(out, dpi=110)
    plt.close()
    log(f"Saved {out}")

    log(f"ret_1: skew={ret.skew():.3f}, kurtosis={ret.kurtosis():.3f} "
        f"({'fat-tailed / leptokurtic' if ret.kurtosis() > 1 else 'roughly normal tails'} vs normal=0)")


def time_series_plots(df, timeframe):
    section(f"4. TIME SERIES — {timeframe}")
    fig, axes = plt.subplots(4, 1, figsize=(13, 13), sharex=True)

    axes[0].plot(df["date_iso"], df["close"], color="black", lw=0.8)
    axes[0].set_yscale("log")
    axes[0].set_title("BTC close (log scale)")

    axes[1].plot(df["date_iso"], df["cot_net_noncomm"], color="purple", lw=0.8)
    axes[1].axhline(0, color="grey", lw=0.5)
    axes[1].set_title("COT net non-commercial positioning (% of open interest)")

    axes[2].plot(df["date_iso"], df["fear_greed"], color="darkgreen", lw=0.8)
    axes[2].axhline(50, color="grey", lw=0.5)
    axes[2].set_title("Fear & Greed Index")

    rolling_vol = df["ret_1"].rolling(20).std()
    axes[3].plot(df["date_iso"], rolling_vol, color="firebrick", lw=0.8)
    axes[3].set_title("Rolling 20-period volatility of ret_1 (volatility clustering check)")

    plt.tight_layout()
    out = OUT_DIR / f"timeseries_{timeframe}.png"
    plt.savefig(out, dpi=110)
    plt.close()
    log(f"Saved {out}")


def correlation_analysis(df, timeframe):
    section(f"5. CORRELATION WITH TARGET — {timeframe}")
    cols = ["ret_1", "cot_net_noncomm", "fear_greed", "avg_hashrate", "volume"]
    cols = [c for c in cols if c in df.columns]
    sub = df[cols + ["target_ret_6"]].dropna()
    corr = sub.corr()["target_ret_6"].drop("target_ret_6").sort_values(key=abs, ascending=False)
    log("Pearson correlation of each feature with target_ret_6 (forward 6-period return):")
    log(corr.to_string())

    fig, ax = plt.subplots(figsize=(7, 5))
    full_corr = sub.corr()
    im = ax.imshow(full_corr, cmap="coolwarm", vmin=-1, vmax=1)
    ax.set_xticks(range(len(full_corr.columns)))
    ax.set_yticks(range(len(full_corr.columns)))
    ax.set_xticklabels(full_corr.columns, rotation=45, ha="right")
    ax.set_yticklabels(full_corr.columns)
    for i in range(len(full_corr)):
        for j in range(len(full_corr)):
            ax.text(j, i, f"{full_corr.iloc[i, j]:.2f}", ha="center", va="center", fontsize=8)
    fig.colorbar(im)
    ax.set_title("Correlation matrix")
    plt.tight_layout()
    out = OUT_DIR / f"correlation_{timeframe}.png"
    plt.savefig(out, dpi=110)
    plt.close()
    log(f"Saved {out}")

    max_abs_corr = corr.abs().max()
    log(f"\nStrongest |correlation| with target_ret_6: {max_abs_corr:.4f} ({corr.abs().idxmax()})")
    log("(For reference: anything below ~0.05-0.1 is essentially noise for a single feature.)")


def stationarity_and_autocorrelation(df, timeframe):
    section(f"6. STATIONARITY (ADF TEST) & AUTOCORRELATION — {timeframe}")

    close_adf = adfuller(df["close"].dropna())
    ret_adf = adfuller(df["ret_1"].dropna())
    log(f"ADF test on close price:  statistic={close_adf[0]:.3f}, p-value={close_adf[1]:.4f} "
        f"-> {'stationary' if close_adf[1] < 0.05 else 'NON-stationary (expected for raw price)'}")
    log(f"ADF test on ret_1 (returns): statistic={ret_adf[0]:.3f}, p-value={ret_adf[1]:.4f} "
        f"-> {'stationary' if ret_adf[1] < 0.05 else 'non-stationary'}")

    fig, axes = plt.subplots(2, 1, figsize=(10, 7))
    plot_acf(df["ret_1"].dropna(), lags=40, ax=axes[0])
    axes[0].set_title("ACF of ret_1 — autocorrelation at each lag (relevant to ARIMA's AR terms)")
    plot_pacf(df["ret_1"].dropna(), lags=40, ax=axes[1])
    axes[1].set_title("PACF of ret_1")
    plt.tight_layout()
    out = OUT_DIR / f"acf_pacf_{timeframe}.png"
    plt.savefig(out, dpi=110)
    plt.close()
    log(f"Saved {out}")

    ret = df["ret_1"].dropna()
    lag1_autocorr = ret.autocorr(lag=1)
    log(f"\nLag-1 autocorrelation of returns: {lag1_autocorr:.4f} "
        f"({'essentially zero — consistent with near-random-walk, ARIMA would find little to fit' if abs(lag1_autocorr) < 0.05 else 'non-trivial — worth testing ARIMA'})")


def main():
    for timeframe in ["1d", "4h"]:
        df = load(timeframe)
        basic_overview(df, timeframe)
        descriptive_stats(df, timeframe)
        distribution_plots(df, timeframe)
        time_series_plots(df, timeframe)
        correlation_analysis(df, timeframe)
        stationarity_and_autocorrelation(df, timeframe)

    summary_path = OUT_DIR / "EDA_SUMMARY.txt"
    summary_path.write_text("\n".join(summary_lines), encoding="utf-8")
    print(f"\n\nFull text summary saved to {summary_path}")


if __name__ == "__main__":
    main()
