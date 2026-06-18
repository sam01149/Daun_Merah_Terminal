"""
Transparent data cleaning + integration step, separate from technical-indicator feature
engineering (that's scripts/feature-engineering.js, on the Node side). This script:

  1. Loads each of the 7 raw BTC CSVs in data/btc/
  2. Explicitly selects which columns from each source are worth keeping (documented below)
  3. Cleans each one (drop duplicate timestamps, drop invalid/out-of-range values)
  4. Merges everything onto the OHLCV timestamp grid with a point-in-time join
     (pandas.merge_asof, direction="backward" — "most recent value at or before this candle",
     same semantics as the forward-fill in feature-engineering.js, just declarative)
  5. Adds the forward-looking targets (return + direction at 6/18-period horizons)
  6. Writes data/btc/clean_4h.csv and clean_1d.csv, with a per-column coverage report

This does NOT compute RSI/MACD/etc — those live in scripts/feature-engineering.js. This is the
cleaning/integration layer underneath that.

Usage: python ml/preprocess.py
"""
from pathlib import Path

import numpy as np
import pandas as pd

DATA_DIR = Path(__file__).resolve().parent.parent / "data" / "btc"

# CFTC dates COT reports to the prior Tuesday but doesn't publish until the following Friday —
# without this shift, candles would "see" positioning data ~3 days before it was actually public.
COT_PUBLISH_LAG_MS = 3 * 86400 * 1000


def load_ohlcv(timeframe):
    df = pd.read_csv(DATA_DIR / f"ohlcv_{timeframe}.csv")
    before = len(df)
    df = df.drop_duplicates(subset="timestamp").sort_values("timestamp").reset_index(drop=True)
    invalid = (df[["open", "high", "low", "close"]] <= 0).any(axis=1) | (df["volume"] < 0)
    if invalid.any():
        print(f"  dropping {invalid.sum()} row(s): non-positive price or negative volume")
    df = df[~invalid].reset_index(drop=True)
    print(f"ohlcv_{timeframe}: {before} -> {len(df)} rows")
    return df[["timestamp", "date_iso", "open", "high", "low", "close", "volume"]]


def load_cot():
    # Kept: open_interest + the two main directional camps (non-commercial = speculators,
    # commercial = hedgers). Dropped: noncomm_spread (small, non-directional) and the
    # nonreportable_* columns (small traders below CFTC's reporting threshold — noisier,
    # less institutionally meaningful than the two main camps).
    df = pd.read_csv(DATA_DIR / "cot_bitcoin.csv")
    before = len(df)
    df = df.drop_duplicates(subset="timestamp").sort_values("timestamp").reset_index(drop=True)
    cols = ["timestamp", "open_interest", "noncomm_long", "noncomm_short", "comm_long", "comm_short"]
    df = df[cols]
    invalid = (df.drop(columns="timestamp") < 0).any(axis=1)
    if invalid.any():
        print(f"  dropping {invalid.sum()} row(s): negative position count")
    df = df[~invalid].reset_index(drop=True)
    df["timestamp"] = df["timestamp"] + COT_PUBLISH_LAG_MS
    print(f"cot_bitcoin: {before} -> {len(df)} rows (timestamps shifted +3d for publish lag)")
    return df


def load_fear_greed():
    # Kept: value (0-100 sentiment score). Dropped: classification — it's just a labeled bucket
    # of the same value (e.g. "Extreme Fear" for value<25), no extra information.
    df = pd.read_csv(DATA_DIR / "fear_greed.csv")
    before = len(df)
    df = df.drop_duplicates(subset="timestamp").sort_values("timestamp").reset_index(drop=True)
    df = df[["timestamp", "value"]].rename(columns={"value": "fear_greed"})
    invalid = (df["fear_greed"] < 0) | (df["fear_greed"] > 100)
    df = df[~invalid].reset_index(drop=True)
    print(f"fear_greed: {before} -> {len(df)} rows")
    return df


def load_hashrate():
    df = pd.read_csv(DATA_DIR / "hashrate.csv")
    before = len(df)
    df = df.drop_duplicates(subset="timestamp").sort_values("timestamp").reset_index(drop=True)
    df = df[["timestamp", "avg_hashrate"]]
    invalid = df["avg_hashrate"] <= 0
    df = df[~invalid].reset_index(drop=True)
    print(f"hashrate: {before} -> {len(df)} rows")
    return df


def load_stablecoin():
    # Kept: total only (usdt+usdc combined). Dropped: the individual usdt/usdc split — for a
    # "is liquidity entering crypto" signal, the combined total is what matters; the split
    # between the two issuers isn't a meaningfully different feature for this purpose.
    df = pd.read_csv(DATA_DIR / "stablecoin_supply.csv")
    before = len(df)
    df = df.drop_duplicates(subset="timestamp").sort_values("timestamp").reset_index(drop=True)
    df = df[["timestamp", "total_stablecoin_cap"]]
    invalid = df["total_stablecoin_cap"] <= 0
    df = df[~invalid].reset_index(drop=True)
    print(f"stablecoin_supply: {before} -> {len(df)} rows (note: only ~365d history — CoinGecko free-tier limit)")
    return df


def load_dominance():
    df = pd.read_csv(DATA_DIR / "btc_dominance.csv")
    before = len(df)
    df = df.drop_duplicates(subset="timestamp").sort_values("timestamp").reset_index(drop=True)
    df = df[["timestamp", "btc_dominance_pct"]]
    invalid = (df["btc_dominance_pct"] <= 0) | (df["btc_dominance_pct"] > 100)
    df = df[~invalid].reset_index(drop=True)
    print(f"btc_dominance: {before} -> {len(df)} rows (note: accumulates from now, no free historical source)")
    return df


def build_merged(timeframe):
    print(f"\n=== Building clean_{timeframe}.csv ===")
    ohlcv = load_ohlcv(timeframe)
    sources = {
        "cot": load_cot(),
        "fear_greed": load_fear_greed(),
        "hashrate": load_hashrate(),
        "stablecoin": load_stablecoin(),
        "dominance": load_dominance(),
    }

    merged = ohlcv.copy()
    for name, df in sources.items():
        merged = pd.merge_asof(merged, df, on="timestamp", direction="backward")

    merged["ret_1"] = merged["close"].pct_change()
    merged["target_ret_6"] = merged["close"].shift(-6) / merged["close"] - 1
    merged["target_ret_18"] = merged["close"].shift(-18) / merged["close"] - 1
    merged["target_dir_6"] = (merged["target_ret_6"] > 0).astype(float)
    merged["target_dir_18"] = (merged["target_ret_18"] > 0).astype(float)
    merged.loc[merged["target_ret_6"].isna(), "target_dir_6"] = np.nan
    merged.loc[merged["target_ret_18"].isna(), "target_dir_18"] = np.nan

    out_path = DATA_DIR / f"clean_{timeframe}.csv"
    merged.to_csv(out_path, index=False)
    print(f"Saved {out_path} — {len(merged)} rows, {len(merged.columns)} columns")

    print("Column coverage:")
    for col in merged.columns:
        pct = merged[col].notna().mean() * 100
        print(f"  {col:25s} {pct:5.1f}%")
    return merged


def main():
    for tf in ["4h", "1d"]:
        build_merged(tf)


if __name__ == "__main__":
    main()
