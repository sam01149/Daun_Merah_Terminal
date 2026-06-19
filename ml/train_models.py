"""
Trains and compares several algorithms (classic ML + deep learning) on the BTC feature
matrix, to find which one actually has predictive edge on held-out data.

Honesty rule (per project instructions): report real test-set accuracy, always compared
against naive baselines. If a model doesn't beat the baselines, say so plainly.

Usage: python ml/train_models.py
"""
import json
import warnings
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier, RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, f1_score, precision_score, recall_score, roc_auc_score
from sklearn.neural_network import MLPClassifier
from sklearn.preprocessing import StandardScaler

import torch
import torch.nn as nn
from torch.utils.data import DataLoader, TensorDataset

warnings.filterwarnings("ignore")
torch.manual_seed(42)
np.random.seed(42)

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data" / "btc"
RESULTS_DIR = Path(__file__).resolve().parent / "results"
RESULTS_DIR.mkdir(exist_ok=True)

# Excluded: timestamp/date/close (raw price level — non-stationary, would just encode "what year
# is it") and stablecoin_total_cap / btc_dominance_pct (coverage too low across full history per
# the feature-engineering phase notes — would force dropping most of the dataset).
FEATURE_COLS = [
    "ret_1", "ret_6", "ret_18", "log_ret_1", "volatility_z20", "rsi_14",
    "macd", "macd_signal", "macd_hist", "atr_14", "bb_pctb",
    "price_to_sma20", "sma20_gt_sma50", "ema12_gt_ema26",
    "volume_z20", "volume_change_pct",
    "cot_open_interest_z", "cot_net_pct", "cot_noncomm_long_pct", "cot_net_change_1w",
    "fear_greed", "hashrate",
]

SEQ_LEN = 24  # ~4 days of history on 4h candles, fed to the LSTM per prediction


def load_clean(timeframe, target_col):
    df = pd.read_csv(DATA_DIR / f"features_{timeframe}.csv")
    df = df.dropna(subset=FEATURE_COLS + [target_col]).reset_index(drop=True)
    return df


def chronological_split(n, test_frac=0.2):
    split_idx = int(n * (1 - test_frac))
    return split_idx


def metrics_dict(y_true, y_pred, y_proba=None):
    out = {
        "accuracy": accuracy_score(y_true, y_pred),
        "precision": precision_score(y_true, y_pred, zero_division=0),
        "recall": recall_score(y_true, y_pred, zero_division=0),
        "f1": f1_score(y_true, y_pred, zero_division=0),
    }
    if y_proba is not None and len(set(y_true)) > 1:
        out["roc_auc"] = roc_auc_score(y_true, y_proba)
    return {k: round(v, 4) for k, v in out.items()}


def run_baselines(y_train, y_test, ret1_test):
    majority_class = int(round(y_train.mean()))
    majority_pred = np.full(len(y_test), majority_class)

    # Naive momentum: predict "up" if the most recent realized return was positive.
    momentum_pred = (ret1_test > 0).astype(int).values

    return {
        "baseline_majority_class": metrics_dict(y_test, majority_pred),
        "baseline_momentum_persistence": metrics_dict(y_test, momentum_pred),
    }


def run_sklearn_models(X_train, y_train, X_test, y_test):
    scaler = StandardScaler().fit(X_train)
    X_train_s = scaler.transform(X_train)
    X_test_s = scaler.transform(X_test)

    results = {}

    log_reg = LogisticRegression(max_iter=1000, random_state=42)
    log_reg.fit(X_train_s, y_train)
    results["logistic_regression"] = metrics_dict(
        y_test, log_reg.predict(X_test_s), log_reg.predict_proba(X_test_s)[:, 1]
    )

    rf = RandomForestClassifier(n_estimators=300, max_depth=6, min_samples_leaf=20, random_state=42, n_jobs=-1)
    rf.fit(X_train, y_train)
    results["random_forest"] = metrics_dict(y_test, rf.predict(X_test), rf.predict_proba(X_test)[:, 1])

    gb = HistGradientBoostingClassifier(max_depth=4, learning_rate=0.05, max_iter=300, random_state=42)
    gb.fit(X_train, y_train)
    results["gradient_boosting"] = metrics_dict(y_test, gb.predict(X_test), gb.predict_proba(X_test)[:, 1])

    mlp = MLPClassifier(hidden_layer_sizes=(64, 32), max_iter=500, early_stopping=True, random_state=42)
    mlp.fit(X_train_s, y_train)
    results["mlp_neural_net"] = metrics_dict(y_test, mlp.predict(X_test_s), mlp.predict_proba(X_test_s)[:, 1])

    return results


class LSTMClassifier(nn.Module):
    def __init__(self, n_features, hidden_size=32):
        super().__init__()
        self.lstm = nn.LSTM(n_features, hidden_size, batch_first=True)
        self.fc = nn.Linear(hidden_size, 1)

    def forward(self, x):
        out, _ = self.lstm(x)
        last = out[:, -1, :]
        return self.fc(last).squeeze(-1)


def build_sequences(X_scaled, y, seq_len):
    n = len(X_scaled) - seq_len + 1
    seqs = np.stack([X_scaled[i:i + seq_len] for i in range(n)])
    labels = y[seq_len - 1:].reset_index(drop=True)
    return seqs.astype(np.float32), labels.values.astype(np.float32)


def run_lstm(df, target_col, split_idx, seq_len=SEQ_LEN):
    scaler = StandardScaler().fit(df.loc[:split_idx - 1, FEATURE_COLS])
    X_scaled = scaler.transform(df[FEATURE_COLS])
    seqs, labels = build_sequences(X_scaled, df[target_col], seq_len)

    # A sequence's label index in the original df is (seq_len - 1 + i); split on that.
    seq_split = max(split_idx - (seq_len - 1), 0)
    X_train, X_test = seqs[:seq_split], seqs[seq_split:]
    y_train, y_test = labels[:seq_split], labels[seq_split:]

    train_ds = TensorDataset(torch.from_numpy(X_train), torch.from_numpy(y_train))
    train_loader = DataLoader(train_ds, batch_size=64, shuffle=True)

    model = LSTMClassifier(n_features=len(FEATURE_COLS))
    optimizer = torch.optim.Adam(model.parameters(), lr=1e-3)
    loss_fn = nn.BCEWithLogitsLoss()

    model.train()
    for epoch in range(15):
        for xb, yb in train_loader:
            optimizer.zero_grad()
            logits = model(xb)
            loss = loss_fn(logits, yb)
            loss.backward()
            optimizer.step()

    model.eval()
    with torch.no_grad():
        test_logits = model(torch.from_numpy(X_test))
        test_proba = torch.sigmoid(test_logits).numpy()
        test_pred = (test_proba > 0.5).astype(int)

    return metrics_dict(y_test.astype(int), test_pred, test_proba)


def run_for_target(timeframe, target_col):
    df = load_clean(timeframe, target_col)
    n = len(df)
    split_idx = chronological_split(n, test_frac=0.2)

    X = df[FEATURE_COLS]
    y = df[target_col].astype(int)
    X_train, X_test = X.iloc[:split_idx], X.iloc[split_idx:]
    y_train, y_test = y.iloc[:split_idx], y.iloc[split_idx:]
    ret1_test = df["ret_1"].iloc[split_idx:]

    report = {
        "timeframe": timeframe,
        "target": target_col,
        "n_rows_total": n,
        "n_train": split_idx,
        "n_test": n - split_idx,
        "train_period": [df["date_iso"].iloc[0], df["date_iso"].iloc[split_idx - 1]],
        "test_period": [df["date_iso"].iloc[split_idx], df["date_iso"].iloc[-1]],
        "train_class_balance_up": round(y_train.mean(), 4),
        "test_class_balance_up": round(y_test.mean(), 4),
        "models": {},
    }

    report["models"].update(run_baselines(y_train, y_test, ret1_test))
    report["models"].update(run_sklearn_models(X_train, y_train, X_test, y_test))
    report["models"]["lstm"] = run_lstm(df, target_col, split_idx)

    return report


def print_report(report):
    print(f"\n=== {report['timeframe']} / {report['target']} ===")
    print(f"rows: {report['n_rows_total']} (train {report['n_train']}, test {report['n_test']})")
    print(f"train period: {report['train_period'][0]} -> {report['train_period'][1]}")
    print(f"test period:  {report['test_period'][0]} -> {report['test_period'][1]}")
    print(f"class balance (up%) - train: {report['train_class_balance_up']*100:.1f}%, test: {report['test_class_balance_up']*100:.1f}%")
    print(f"{'model':30s} {'acc':>7s} {'prec':>7s} {'rec':>7s} {'f1':>7s} {'auc':>7s}")
    for name, m in report["models"].items():
        print(f"{name:30s} {m['accuracy']:7.4f} {m['precision']:7.4f} {m['recall']:7.4f} {m['f1']:7.4f} {m.get('roc_auc', float('nan')):7.4f}")


def main():
    all_reports = []
    for timeframe in ["4h", "1d"]:
        for target_col in ["target_dir_6", "target_dir_18"]:
            report = run_for_target(timeframe, target_col)
            print_report(report)
            all_reports.append(report)

    out_path = RESULTS_DIR / "model_comparison.json"
    out_path.write_text(json.dumps(all_reports, indent=2))
    print(f"\nSaved: {out_path}")


if __name__ == "__main__":
    main()
