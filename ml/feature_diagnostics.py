"""
Deeper look at whether the weak model results trace back to data prep / feature strategy
issues, per the user's instinct. Checks: feature multicollinearity, what the trained Random
Forest actually relies on (feature_importances_), and whether a minimal COT-only model beats
the 22-feature kitchen sink.

Local experiment only. Usage: python ml/feature_diagnostics.py
"""
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import roc_auc_score

from train_models import FEATURE_COLS, chronological_split, load_clean

OUT_DIR = Path(__file__).resolve().parent / "eda_output"
OUT_DIR.mkdir(exist_ok=True)


def correlation_matrix(timeframe="4h", target_col="target_dir_6"):
    df = load_clean(timeframe, target_col)
    corr = df[FEATURE_COLS].corr()

    print(f"\n=== Feature correlation matrix ({timeframe}) ===")
    # Flag highly correlated pairs (|corr| > 0.7, excluding diagonal)
    pairs = []
    for i in range(len(corr.columns)):
        for j in range(i + 1, len(corr.columns)):
            c = corr.iloc[i, j]
            if abs(c) > 0.7:
                pairs.append((corr.columns[i], corr.columns[j], c))
    pairs.sort(key=lambda x: -abs(x[2]))
    print(f"Highly correlated pairs (|corr| > 0.7): {len(pairs)}")
    for a, b, c in pairs:
        print(f"  {a:22s} <-> {b:22s}  {c:+.3f}")

    fig, ax = plt.subplots(figsize=(11, 9))
    im = ax.imshow(corr, cmap="coolwarm", vmin=-1, vmax=1)
    ax.set_xticks(range(len(corr.columns)))
    ax.set_yticks(range(len(corr.columns)))
    ax.set_xticklabels(corr.columns, rotation=60, ha="right", fontsize=8)
    ax.set_yticklabels(corr.columns, fontsize=8)
    fig.colorbar(im)
    ax.set_title(f"Feature correlation matrix ({timeframe})")
    plt.tight_layout()
    out = OUT_DIR / f"feature_corr_{timeframe}.png"
    plt.savefig(out, dpi=110)
    plt.close()
    print(f"Saved {out}")
    return corr


def feature_importance(timeframe="4h", target_col="target_dir_6"):
    df = load_clean(timeframe, target_col)
    n = len(df)
    split = chronological_split(n, 0.2)
    X_train, y_train = df[FEATURE_COLS].iloc[:split], df[target_col].iloc[:split].astype(int)
    X_test, y_test = df[FEATURE_COLS].iloc[split:], df[target_col].iloc[split:].astype(int)

    rf = RandomForestClassifier(n_estimators=300, max_depth=6, min_samples_leaf=20, random_state=42, n_jobs=-1)
    rf.fit(X_train, y_train)
    importances = pd.Series(rf.feature_importances_, index=FEATURE_COLS).sort_values(ascending=False)

    print(f"\n=== Random Forest feature importance ({timeframe}/{target_col}) ===")
    print(importances.to_string())

    full_auc = roc_auc_score(y_test, rf.predict_proba(X_test)[:, 1])
    print(f"\nFull 22-feature model test AUC: {full_auc:.4f}")
    return importances, full_auc


def minimal_cot_model(timeframe="4h", target_col="target_dir_6"):
    df = load_clean(timeframe, target_col)
    n = len(df)
    split = chronological_split(n, 0.2)

    cot_cols = ["cot_open_interest_z", "cot_net_pct", "cot_noncomm_long_pct", "cot_net_change_1w"]
    configs = {
        "cot_only (4 features)": cot_cols,
        "cot_net_pct only (1 feature)": ["cot_net_pct"],
        "full_22_features": FEATURE_COLS,
    }

    print(f"\n=== Minimal vs kitchen-sink comparison ({timeframe}/{target_col}) ===")
    for name, cols in configs.items():
        X_train, y_train = df[cols].iloc[:split], df[target_col].iloc[:split].astype(int)
        X_test, y_test = df[cols].iloc[split:], df[target_col].iloc[split:].astype(int)
        rf = RandomForestClassifier(n_estimators=300, max_depth=6, min_samples_leaf=20, random_state=42, n_jobs=-1)
        rf.fit(X_train, y_train)
        auc = roc_auc_score(y_test, rf.predict_proba(X_test)[:, 1])
        print(f"  {name:30s} test AUC = {auc:.4f}")


def main():
    for timeframe, target in [("4h", "target_dir_6"), ("1d", "target_dir_18")]:
        correlation_matrix(timeframe, target)
        feature_importance(timeframe, target)
        minimal_cot_model(timeframe, target)


if __name__ == "__main__":
    main()
