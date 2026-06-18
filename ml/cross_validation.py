"""
Walk-forward cross-validation: checks whether the single-split results in train_models.py
hold up across multiple time periods, or were a fluke of one particular test window.

Expanding-window scheme: split the (cleaned) dataset into N_FOLDS contiguous chronological
chunks. For each chunk after the first, train on everything before it, test on that chunk.
This never trains on future data relative to its own test fold.

Usage: python ml/cross_validation.py
"""
import json
import warnings
from pathlib import Path

import numpy as np
import pandas as pd
import torch
import torch.nn as nn
from torch.utils.data import DataLoader, TensorDataset

from train_models import (
    FEATURE_COLS, SEQ_LEN, LSTMClassifier, build_sequences,
    load_clean, metrics_dict, run_baselines, run_sklearn_models,
)

warnings.filterwarnings("ignore")
torch.manual_seed(42)
np.random.seed(42)

RESULTS_DIR = Path(__file__).resolve().parent / "results"
N_FOLDS = 5


def run_lstm_fold(df, target_col, train_end, test_start, test_end, seq_len=SEQ_LEN):
    from sklearn.preprocessing import StandardScaler

    scaler = StandardScaler().fit(df.loc[:train_end - 1, FEATURE_COLS])
    X_scaled = scaler.transform(df[FEATURE_COLS])
    seqs, labels = build_sequences(X_scaled, df[target_col], seq_len)
    # sequence i's label corresponds to original df index (seq_len - 1 + i)
    label_idx = np.arange(seq_len - 1, seq_len - 1 + len(labels))

    train_mask = label_idx < train_end
    test_mask = (label_idx >= test_start) & (label_idx < test_end)

    X_train, y_train = seqs[train_mask], labels[train_mask]
    X_test, y_test = seqs[test_mask], labels[test_mask]
    if len(X_test) == 0 or len(set(y_train)) < 2:
        return None

    train_ds = TensorDataset(torch.from_numpy(X_train), torch.from_numpy(y_train))
    train_loader = DataLoader(train_ds, batch_size=64, shuffle=True)

    model = LSTMClassifier(n_features=len(FEATURE_COLS))
    optimizer = torch.optim.Adam(model.parameters(), lr=1e-3)
    loss_fn = nn.BCEWithLogitsLoss()
    model.train()
    for _ in range(15):
        for xb, yb in train_loader:
            optimizer.zero_grad()
            loss = loss_fn(model(xb), yb)
            loss.backward()
            optimizer.step()

    model.eval()
    with torch.no_grad():
        proba = torch.sigmoid(model(torch.from_numpy(X_test))).numpy()
    pred = (proba > 0.5).astype(int)
    return metrics_dict(y_test.astype(int), pred, proba)


def run_cv_for_target(timeframe, target_col, n_folds=N_FOLDS):
    df = load_clean(timeframe, target_col)
    n = len(df)
    chunk = n // n_folds
    bounds = [i * chunk for i in range(n_folds)] + [n]

    fold_results = []
    for f in range(1, n_folds):
        train_end = bounds[f]
        test_start, test_end = bounds[f], bounds[f + 1]
        if test_end - test_start < 20:
            continue

        X_train, y_train = df[FEATURE_COLS].iloc[:train_end], df[target_col].iloc[:train_end].astype(int)
        X_test, y_test = df[FEATURE_COLS].iloc[test_start:test_end], df[target_col].iloc[test_start:test_end].astype(int)
        ret1_test = df["ret_1"].iloc[test_start:test_end]

        fold_metrics = {}
        fold_metrics.update(run_baselines(y_train, y_test, ret1_test))
        fold_metrics.update(run_sklearn_models(X_train, y_train, X_test, y_test))
        lstm_m = run_lstm_fold(df, target_col, train_end, test_start, test_end)
        if lstm_m:
            fold_metrics["lstm"] = lstm_m

        fold_results.append({
            "fold": f,
            "train_end_date": df["date_iso"].iloc[train_end - 1],
            "test_period": [df["date_iso"].iloc[test_start], df["date_iso"].iloc[test_end - 1]],
            "models": fold_metrics,
        })

    return fold_results


def summarize(fold_results):
    model_names = set()
    for fr in fold_results:
        model_names |= set(fr["models"].keys())

    summary = {}
    for name in model_names:
        aucs = [fr["models"][name].get("roc_auc") for fr in fold_results if name in fr["models"] and "roc_auc" in fr["models"][name]]
        accs = [fr["models"][name]["accuracy"] for fr in fold_results if name in fr["models"]]
        summary[name] = {
            "mean_accuracy": round(float(np.mean(accs)), 4) if accs else None,
            "std_accuracy": round(float(np.std(accs)), 4) if accs else None,
            "mean_auc": round(float(np.mean(aucs)), 4) if aucs else None,
            "std_auc": round(float(np.std(aucs)), 4) if aucs else None,
            "n_folds": len(accs),
        }
    return summary


def main():
    all_results = {}
    for timeframe in ["4h", "1d"]:
        for target_col in ["target_dir_6", "target_dir_18"]:
            key = f"{timeframe}_{target_col}"
            print(f"\n=== Walk-forward CV: {key} ===")
            fold_results = run_cv_for_target(timeframe, target_col)
            summary = summarize(fold_results)
            for name, s in sorted(summary.items(), key=lambda kv: -(kv[1]["mean_auc"] or 0)):
                auc_str = f"{s['mean_auc']:.4f} +/- {s['std_auc']:.4f}" if s["mean_auc"] is not None else "n/a"
                print(f"{name:30s} acc {s['mean_accuracy']:.4f} +/- {s['std_accuracy']:.4f}   auc {auc_str}  (n={s['n_folds']})")
            all_results[key] = {"folds": fold_results, "summary": summary}

    out_path = RESULTS_DIR / "cross_validation.json"
    out_path.write_text(json.dumps(all_results, indent=2))
    print(f"\nSaved: {out_path}")


if __name__ == "__main__":
    main()
