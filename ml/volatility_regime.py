"""
Volatility-regime classification experiment, motivated by the strong ACF evidence of volatility
clustering found in EDA (|return| autocorrelation stays 0.15-0.25 across lags 1-40, vs ~0 for
raw returns). Tests whether "will volatility be elevated N periods ahead" is more learnable than
price direction, using the exact same rigor as the direction experiments (chronological split,
walk-forward CV, permutation significance test) — no claims accepted without that.

Usage: python ml/volatility_regime.py
"""
import warnings
from pathlib import Path

import numpy as np
import pandas as pd
import torch
from sklearn.ensemble import GradientBoostingClassifier, RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.neural_network import MLPClassifier
from sklearn.preprocessing import StandardScaler

from train_models import FEATURE_COLS, LSTMClassifier, build_sequences, chronological_split
from torch import nn
from torch.utils.data import DataLoader, TensorDataset

warnings.filterwarnings("ignore")
np.random.seed(42)

DATA_DIR = Path(__file__).resolve().parent.parent / "data" / "btc"
HORIZON = 6  # same horizon as target_dir_6, for a fair comparison
ROLL_QUANTILE_WINDOW = 500
QUANTILE_THRESHOLD = 0.70


def build_dataset(timeframe, use_dvol=False):
    feat = pd.read_csv(DATA_DIR / f"features_{timeframe}.csv")
    ohlcv = pd.read_csv(DATA_DIR / f"ohlcv_{timeframe}.csv")[["timestamp", "high", "low"]]
    df = feat.merge(ohlcv, on="timestamp", how="left").sort_values("timestamp").reset_index(drop=True)

    # Parkinson volatility per bar (uses high-low range — more efficient than close-to-close).
    df["parkinson_vol"] = np.sqrt((1 / (4 * np.log(2))) * (np.log(df["high"] / df["low"]) ** 2))

    # Realized volatility features (the LEVEL of vol, not the z-scored "return surprise" that
    # volatility_z20 actually measures — that mislabeling is a separate known issue, left as-is
    # here since this experiment adds genuine level features alongside it).
    df["realized_vol_6"] = df["log_ret_1"].rolling(6).std()
    df["realized_vol_20"] = df["log_ret_1"].rolling(20).std()
    df["parkinson_vol_mean_6"] = df["parkinson_vol"].rolling(6).mean()

    # Forward-looking realized volatility over the same horizon as target_dir_6, for direct
    # comparison. shift(-HORIZON) so each row holds the vol of the NEXT `horizon` periods only
    # (no overlap with the historical window used to compute current-bar features).
    forward_vol = df["log_ret_1"].rolling(HORIZON).std().shift(-HORIZON)

    # Rolling quantile threshold — adapts to the market's evolving baseline volatility level
    # instead of a fixed cutoff (BTC's vol level in 2018 isn't comparable to 2024's).
    rolling_threshold = forward_vol.rolling(ROLL_QUANTILE_WINDOW, min_periods=100).quantile(QUANTILE_THRESHOLD)
    df["target_vol_regime"] = (forward_vol > rolling_threshold).astype(float)
    df.loc[forward_vol.isna() | rolling_threshold.isna(), "target_vol_regime"] = np.nan

    extra_cols = ["realized_vol_6", "realized_vol_20", "parkinson_vol_mean_6"]
    if use_dvol:
        extra_cols += ["dvol_close", "dvol_change_1"]
    cols = FEATURE_COLS + extra_cols
    df = df.dropna(subset=cols + ["target_vol_regime"]).reset_index(drop=True)
    return df, cols


def metrics(y_true, y_pred, y_proba):
    from sklearn.metrics import accuracy_score, f1_score
    return {
        "accuracy": round(accuracy_score(y_true, y_pred), 4),
        "f1": round(f1_score(y_true, y_pred, zero_division=0), 4),
        "roc_auc": round(roc_auc_score(y_true, y_proba), 4) if len(set(y_true)) > 1 else None,
    }


def single_split_eval(df, cols):
    n = len(df)
    split = chronological_split(n, 0.2)
    X, y = df[cols], df["target_vol_regime"].astype(int)
    X_train, X_test = X.iloc[:split], X.iloc[split:]
    y_train, y_test = y.iloc[:split], y.iloc[split:]

    print(f"\nrows: {n} (train {split}, test {n-split})  |  base rate (target=1): "
          f"train={y_train.mean():.3f} test={y_test.mean():.3f}")

    scaler = StandardScaler().fit(X_train)
    Xtr_s, Xte_s = scaler.transform(X_train), scaler.transform(X_test)

    results = {}
    lr = LogisticRegression(max_iter=1000).fit(Xtr_s, y_train)
    results["logistic_regression"] = metrics(y_test, lr.predict(Xte_s), lr.predict_proba(Xte_s)[:, 1])

    rf = RandomForestClassifier(n_estimators=300, max_depth=6, min_samples_leaf=20, random_state=42, n_jobs=-1).fit(X_train, y_train)
    results["random_forest"] = metrics(y_test, rf.predict(X_test), rf.predict_proba(X_test)[:, 1])

    gb = GradientBoostingClassifier(max_depth=4, learning_rate=0.05, n_estimators=300, random_state=42).fit(X_train, y_train)
    results["gradient_boosting"] = metrics(y_test, gb.predict(X_test), gb.predict_proba(X_test)[:, 1])

    mlp = MLPClassifier(hidden_layer_sizes=(64, 32), max_iter=500, early_stopping=True, random_state=42).fit(Xtr_s, y_train)
    results["mlp"] = metrics(y_test, mlp.predict(Xte_s), mlp.predict_proba(Xte_s)[:, 1])

    majority = int(round(y_train.mean()))
    results["baseline_majority"] = metrics(y_test, np.full(len(y_test), majority), np.full(len(y_test), y_train.mean()))

    print(f"{'model':22s} {'acc':>8s} {'f1':>8s} {'auc':>8s}")
    for name, m in results.items():
        print(f"{name:22s} {m['accuracy']:8.4f} {m['f1']:8.4f} {m['roc_auc'] if m['roc_auc'] else float('nan'):8.4f}")
    return results


def lstm_fold_auc(df, cols, train_end, test_start, test_end, seq_len=24, epochs=15):
    scaler = StandardScaler().fit(df.loc[:train_end - 1, cols])
    X_scaled = scaler.transform(df[cols])
    seqs, labels = build_sequences(X_scaled, df["target_vol_regime"], seq_len)
    label_idx = np.arange(seq_len - 1, seq_len - 1 + len(labels))

    train_mask = label_idx < train_end
    test_mask = (label_idx >= test_start) & (label_idx < test_end)
    X_train, y_train = seqs[train_mask], labels[train_mask]
    X_test, y_test = seqs[test_mask], labels[test_mask]
    if len(X_test) == 0 or len(set(y_train)) < 2:
        return None

    train_ds = TensorDataset(torch.from_numpy(X_train), torch.from_numpy(y_train))
    loader = DataLoader(train_ds, batch_size=64, shuffle=True)
    model = LSTMClassifier(n_features=len(cols))
    optimizer = torch.optim.Adam(model.parameters(), lr=1e-3)
    loss_fn = nn.BCEWithLogitsLoss()
    model.train()
    for _ in range(epochs):
        for xb, yb in loader:
            optimizer.zero_grad()
            loss = loss_fn(model(xb), yb)
            loss.backward()
            optimizer.step()
    model.eval()
    with torch.no_grad():
        proba = torch.sigmoid(model(torch.from_numpy(X_test))).numpy()
    return roc_auc_score(y_test.astype(int), proba)


def walk_forward_cv_all_models(df, cols, n_folds=5):
    n = len(df)
    chunk = n // n_folds
    bounds = [i * chunk for i in range(n_folds)] + [n]
    results = {name: [] for name in ["logistic_regression", "random_forest", "gradient_boosting", "mlp", "lstm"]}

    print(f"\nWalk-forward CV — all algorithms, {n_folds-1} folds:")
    for f in range(1, n_folds):
        Xtr, ytr = df[cols].iloc[:bounds[f]], df["target_vol_regime"].iloc[:bounds[f]].astype(int)
        Xte, yte = df[cols].iloc[bounds[f]:bounds[f+1]], df["target_vol_regime"].iloc[bounds[f]:bounds[f+1]].astype(int)
        if len(set(ytr)) < 2:
            continue

        scaler = StandardScaler().fit(Xtr)
        Xtr_s, Xte_s = scaler.transform(Xtr), scaler.transform(Xte)

        lr = LogisticRegression(max_iter=1000).fit(Xtr_s, ytr)
        results["logistic_regression"].append(roc_auc_score(yte, lr.predict_proba(Xte_s)[:, 1]))

        rf = RandomForestClassifier(n_estimators=300, max_depth=6, min_samples_leaf=20, random_state=42, n_jobs=-1).fit(Xtr, ytr)
        results["random_forest"].append(roc_auc_score(yte, rf.predict_proba(Xte)[:, 1]))

        gb = GradientBoostingClassifier(max_depth=4, learning_rate=0.05, n_estimators=300, random_state=42).fit(Xtr, ytr)
        results["gradient_boosting"].append(roc_auc_score(yte, gb.predict_proba(Xte)[:, 1]))

        mlp = MLPClassifier(hidden_layer_sizes=(64, 32), max_iter=500, early_stopping=True, random_state=42).fit(Xtr_s, ytr)
        results["mlp"].append(roc_auc_score(yte, mlp.predict_proba(Xte_s)[:, 1]))

        lstm_auc = lstm_fold_auc(df, cols, bounds[f], bounds[f], bounds[f + 1])
        if lstm_auc is not None:
            results["lstm"].append(lstm_auc)

        print(f"  fold {f}: LR={results['logistic_regression'][-1]:.4f}  RF={results['random_forest'][-1]:.4f}  "
              f"GB={results['gradient_boosting'][-1]:.4f}  MLP={results['mlp'][-1]:.4f}  "
              f"LSTM={results['lstm'][-1] if results['lstm'] else float('nan'):.4f}")

    print(f"\n{'model':22s} {'mean AUC':>10s} {'std':>8s}")
    for name, aucs in results.items():
        if aucs:
            print(f"{name:22s} {np.mean(aucs):10.4f} {np.std(aucs):8.4f}")
    return results


def permutation_test(df, cols, n_perm=30, n_folds=5):
    n = len(df)
    chunk = n // n_folds
    bounds = [i * chunk for i in range(n_folds)] + [n]

    def cv_auc(y):
        aucs = []
        for f in range(1, n_folds):
            Xtr, ytr = df[cols].iloc[:bounds[f]], y.iloc[:bounds[f]]
            Xte, yte = df[cols].iloc[bounds[f]:bounds[f+1]], y.iloc[bounds[f]:bounds[f+1]]
            if len(set(ytr)) < 2:
                continue
            rf = RandomForestClassifier(n_estimators=300, max_depth=6, min_samples_leaf=20, random_state=42, n_jobs=-1).fit(Xtr, ytr)
            aucs.append(roc_auc_score(yte, rf.predict_proba(Xte)[:, 1]))
        return np.mean(aucs)

    y_real = df["target_vol_regime"].astype(int)
    real_auc = cv_auc(y_real)

    perm_aucs = []
    for p in range(n_perm):
        rng = np.random.RandomState(p)
        y_shuf = pd.Series(rng.permutation(y_real.values))
        perm_aucs.append(cv_auc(y_shuf))
    perm_aucs = np.array(perm_aucs)

    pval = (perm_aucs >= real_auc).mean()
    print(f"\nPermutation test: real AUC={real_auc:.4f}, null mean={perm_aucs.mean():.4f}, "
          f"null std={perm_aucs.std():.4f}, p-value={pval:.3f}")
    return real_auc, perm_aucs, pval


def main():
    for timeframe in ["4h", "1d"]:
        print(f"\n{'='*70}\nVolatility regime — {timeframe}, horizon={HORIZON} periods, "
              f"target = forward vol > rolling {int(QUANTILE_THRESHOLD*100)}th pct\n{'='*70}")

        print(f"\n--- baseline (no DVOL), full history ---")
        df, cols = build_dataset(timeframe, use_dvol=False)
        single_split_eval(df, cols)
        walk_forward_cv_all_models(df, cols)
        permutation_test(df, cols)

        # DVOL only goes back to 2021-03-24 (vs 2017-18 for the rest), so dropna() on a DVOL
        # column shrinks the dataset a lot. Compare baseline vs +DVOL on the SAME (DVOL-era) row
        # subset, not baseline-on-full-history vs +DVOL-on-shrunk-history — otherwise an AUC delta
        # could just reflect the different/shorter time window rather than DVOL's actual signal.
        df_dvol, cols_dvol = build_dataset(timeframe, use_dvol=True)
        print(f"\n--- baseline rows: {len(df)}, +DVOL rows: {len(df_dvol)} "
              f"({len(df_dvol)/len(df)*100:.1f}% of baseline) ---")

        df_baseline_dvolera = df[df["timestamp"].isin(df_dvol["timestamp"])].reset_index(drop=True)
        print(f"\n--- baseline (no DVOL), restricted to DVOL-era rows ({len(df_baseline_dvolera)}) ---")
        single_split_eval(df_baseline_dvolera, cols)
        walk_forward_cv_all_models(df_baseline_dvolera, cols)
        permutation_test(df_baseline_dvolera, cols)

        print(f"\n--- +DVOL, DVOL-era rows ({len(df_dvol)}) ---")
        single_split_eval(df_dvol, cols_dvol)
        walk_forward_cv_all_models(df_dvol, cols_dvol)
        permutation_test(df_dvol, cols_dvol)


if __name__ == "__main__":
    main()
