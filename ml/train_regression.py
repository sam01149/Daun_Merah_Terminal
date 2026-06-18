"""
Regression experiment: predict the *magnitude* of future return (target_ret_6 / target_ret_18)
rather than just direction. Same honesty rule as train_models.py — report real test-set
error against naive baselines, no polishing.

Usage: python ml/train_regression.py
"""
import json
import warnings
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
from sklearn.ensemble import HistGradientBoostingRegressor, RandomForestRegressor
from sklearn.linear_model import LinearRegression
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.neural_network import MLPRegressor
from sklearn.preprocessing import StandardScaler
from torch.utils.data import DataLoader, TensorDataset

from train_models import FEATURE_COLS, SEQ_LEN, chronological_split, load_clean

warnings.filterwarnings("ignore")
torch.manual_seed(42)
np.random.seed(42)

RESULTS_DIR = Path(__file__).resolve().parent / "results"


def reg_metrics(y_true, y_pred):
    return {
        "mae": round(float(mean_absolute_error(y_true, y_pred)), 6),
        "rmse": round(float(np.sqrt(mean_squared_error(y_true, y_pred))), 6),
        "r2": round(float(r2_score(y_true, y_pred)), 4),
    }


def run_baselines(y_train, y_test):
    zero_pred = np.zeros(len(y_test))
    mean_pred = np.full(len(y_test), y_train.mean())
    return {
        "baseline_predict_zero": reg_metrics(y_test, zero_pred),
        "baseline_predict_train_mean": reg_metrics(y_test, mean_pred),
    }


def run_sklearn_models(X_train, y_train, X_test, y_test):
    scaler = StandardScaler().fit(X_train)
    X_train_s, X_test_s = scaler.transform(X_train), scaler.transform(X_test)

    results = {}

    lin = LinearRegression()
    lin.fit(X_train_s, y_train)
    results["linear_regression"] = reg_metrics(y_test, lin.predict(X_test_s))

    rf = RandomForestRegressor(n_estimators=300, max_depth=6, min_samples_leaf=20, random_state=42, n_jobs=-1)
    rf.fit(X_train, y_train)
    results["random_forest"] = reg_metrics(y_test, rf.predict(X_test))

    gb = HistGradientBoostingRegressor(max_depth=4, learning_rate=0.05, max_iter=300, random_state=42)
    gb.fit(X_train, y_train)
    results["gradient_boosting"] = reg_metrics(y_test, gb.predict(X_test))

    mlp = MLPRegressor(hidden_layer_sizes=(64, 32), max_iter=500, early_stopping=True, random_state=42)
    mlp.fit(X_train_s, y_train)
    results["mlp_neural_net"] = reg_metrics(y_test, mlp.predict(X_test_s))

    return results


class LSTMRegressor(nn.Module):
    def __init__(self, n_features, hidden_size=32):
        super().__init__()
        self.lstm = nn.LSTM(n_features, hidden_size, batch_first=True)
        self.fc = nn.Linear(hidden_size, 1)

    def forward(self, x):
        out, _ = self.lstm(x)
        return self.fc(out[:, -1, :]).squeeze(-1)


def build_sequences(X_scaled, y, seq_len):
    n = len(X_scaled) - seq_len + 1
    seqs = np.stack([X_scaled[i:i + seq_len] for i in range(n)])
    labels = y[seq_len - 1:].reset_index(drop=True)
    return seqs.astype(np.float32), labels.values.astype(np.float32)


def run_lstm(df, target_col, split_idx, seq_len=SEQ_LEN):
    scaler = StandardScaler().fit(df.loc[:split_idx - 1, FEATURE_COLS])
    X_scaled = scaler.transform(df[FEATURE_COLS])
    seqs, labels = build_sequences(X_scaled, df[target_col], seq_len)

    seq_split = max(split_idx - (seq_len - 1), 0)
    X_train, X_test = seqs[:seq_split], seqs[seq_split:]
    y_train, y_test = labels[:seq_split], labels[seq_split:]

    train_ds = TensorDataset(torch.from_numpy(X_train), torch.from_numpy(y_train))
    train_loader = DataLoader(train_ds, batch_size=64, shuffle=True)

    model = LSTMRegressor(n_features=len(FEATURE_COLS))
    optimizer = torch.optim.Adam(model.parameters(), lr=1e-3)
    loss_fn = nn.MSELoss()

    model.train()
    for _ in range(15):
        for xb, yb in train_loader:
            optimizer.zero_grad()
            loss = loss_fn(model(xb), yb)
            loss.backward()
            optimizer.step()

    model.eval()
    with torch.no_grad():
        pred = model(torch.from_numpy(X_test)).numpy()

    return reg_metrics(y_test, pred)


def run_for_target(timeframe, target_col):
    df = load_clean(timeframe, target_col)
    n = len(df)
    split_idx = chronological_split(n, test_frac=0.2)

    X = df[FEATURE_COLS]
    y = df[target_col]
    X_train, X_test = X.iloc[:split_idx], X.iloc[split_idx:]
    y_train, y_test = y.iloc[:split_idx], y.iloc[split_idx:]

    report = {
        "timeframe": timeframe,
        "target": target_col,
        "n_train": split_idx,
        "n_test": n - split_idx,
        "test_period": [df["date_iso"].iloc[split_idx], df["date_iso"].iloc[-1]],
        "train_return_std": round(float(y_train.std()), 6),
        "test_return_std": round(float(y_test.std()), 6),
        "models": {},
    }
    report["models"].update(run_baselines(y_train, y_test))
    report["models"].update(run_sklearn_models(X_train, y_train, X_test, y_test))
    report["models"]["lstm"] = run_lstm(df, target_col, split_idx)
    return report


def print_report(report):
    print(f"\n=== {report['timeframe']} / {report['target']} (regression) ===")
    print(f"test period: {report['test_period'][0]} -> {report['test_period'][1]}")
    print(f"return std — train: {report['train_return_std']:.4f}, test: {report['test_return_std']:.4f}")
    print(f"{'model':30s} {'MAE':>9s} {'RMSE':>9s} {'R2':>8s}")
    for name, m in report["models"].items():
        print(f"{name:30s} {m['mae']:9.4f} {m['rmse']:9.4f} {m['r2']:8.4f}")


def main():
    all_reports = []
    for timeframe in ["4h", "1d"]:
        for target_col in ["target_ret_6", "target_ret_18"]:
            report = run_for_target(timeframe, target_col)
            print_report(report)
            all_reports.append(report)

    out_path = RESULTS_DIR / "regression_comparison.json"
    out_path.write_text(json.dumps(all_reports, indent=2))
    print(f"\nSaved: {out_path}")


if __name__ == "__main__":
    main()
