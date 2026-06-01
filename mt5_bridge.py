"""
Daun Merah — MT5 Local Bridge
==============================
Jalankan script ini di PC yang sama dengan MT5:
    pip install MetaTrader5 flask flask-cors
    python mt5_bridge.py

MT5 akan otomatis terbuka jika belum berjalan.
Server berjalan di http://localhost:5000
"""

from flask import Flask, request, jsonify
from flask_cors import CORS
import MetaTrader5 as mt5
import datetime

app = Flask(__name__)
CORS(app)  # izinkan browser call dari localhost


def ensure_mt5():
    """Pastikan MT5 terhubung, launch otomatis jika belum."""
    if mt5.terminal_info() is not None:
        return True, None
    if not mt5.initialize():
        err = mt5.last_error()
        return False, f"MT5 gagal inisialisasi: {err}"
    return True, None


def symbol_name(pair: str) -> str:
    """EUR/USD → EURUSD, XAU/USD → XAUUSD"""
    return pair.replace('/', '').upper()


@app.route('/health', methods=['GET'])
def health():
    ok, err = ensure_mt5()
    if not ok:
        return jsonify({'status': 'error', 'error': err}), 503
    info = mt5.account_info()
    if info is None:
        return jsonify({'status': 'error', 'error': 'Tidak bisa ambil info akun'}), 503
    return jsonify({
        'status': 'ok',
        'login': info.login,
        'balance': round(info.balance, 2),
        'equity': round(info.equity, 2),
        'server': info.server,
        'currency': info.currency,
    })


@app.route('/order', methods=['POST'])
def place_order():
    data = request.get_json(force=True)

    ok, err = ensure_mt5()
    if not ok:
        return jsonify({'error': err}), 503

    pair      = data.get('symbol', '')
    direction = data.get('direction', 'long').lower()
    lots      = float(data.get('lots', 0.01))
    sl_price  = float(data.get('sl', 0) or 0)
    tp_price  = float(data.get('tp', 0) or 0)

    if not pair:
        return jsonify({'error': 'Symbol tidak boleh kosong'}), 400

    symbol = symbol_name(pair)

    # Pastikan symbol tersedia di Market Watch
    sym_info = mt5.symbol_info(symbol)
    if sym_info is None:
        return jsonify({'error': f'Symbol {symbol} tidak ditemukan di MT5'}), 400
    if not sym_info.visible:
        mt5.symbol_select(symbol, True)

    # Ambil harga terkini
    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        return jsonify({'error': f'Tidak bisa ambil harga {symbol}'}), 400

    if direction == 'long':
        order_type = mt5.ORDER_TYPE_BUY
        price      = tick.ask
    else:
        order_type = mt5.ORDER_TYPE_SELL
        price      = tick.bid

    request_obj = {
        'action':      mt5.TRADE_ACTION_DEAL,
        'symbol':      symbol,
        'volume':      lots,
        'type':        order_type,
        'price':       price,
        'sl':          sl_price if sl_price > 0 else 0.0,
        'tp':          tp_price if tp_price > 0 else 0.0,
        'deviation':   20,
        'magic':       20260601,
        'comment':     'DaunMerah',
        'type_time':   mt5.ORDER_TIME_GTC,
        'type_filling': mt5.ORDER_FILLING_IOC,
    }

    result = mt5.order_send(request_obj)

    if result is None:
        err = mt5.last_error()
        return jsonify({'error': f'order_send gagal: {err}'}), 500

    if result.retcode != mt5.TRADE_RETCODE_DONE:
        return jsonify({
            'error': f'Order ditolak: {result.comment} (retcode {result.retcode})'
        }), 400

    return jsonify({
        'ticket':     result.order,
        'fill_price': result.price,
        'fill_time':  datetime.datetime.now().isoformat(),
        'volume':     result.volume,
        'symbol':     symbol,
        'direction':  direction,
    })


@app.route('/positions', methods=['GET'])
def get_positions():
    """Ambil semua posisi terbuka — untuk cross-check dengan jurnal."""
    ok, err = ensure_mt5()
    if not ok:
        return jsonify({'error': err}), 503

    positions = mt5.positions_get()
    if positions is None:
        return jsonify({'positions': []})

    result = []
    for p in positions:
        result.append({
            'ticket':     p.ticket,
            'symbol':     p.symbol,
            'direction':  'long' if p.type == mt5.ORDER_TYPE_BUY else 'short',
            'volume':     p.volume,
            'open_price': p.price_open,
            'sl':         p.sl,
            'tp':         p.tp,
            'profit':     round(p.profit, 2),
            'open_time':  datetime.datetime.fromtimestamp(p.time).isoformat(),
            'comment':    p.comment,
            'magic':      p.magic,
        })

    return jsonify({'positions': result})


@app.route('/close', methods=['POST'])
def close_position():
    """Tutup posisi berdasarkan ticket."""
    data = request.get_json(force=True)
    ticket = int(data.get('ticket', 0))
    if not ticket:
        return jsonify({'error': 'ticket diperlukan'}), 400

    ok, err = ensure_mt5()
    if not ok:
        return jsonify({'error': err}), 503

    positions = mt5.positions_get(ticket=ticket)
    if not positions:
        return jsonify({'error': f'Posisi ticket {ticket} tidak ditemukan'}), 404

    pos = positions[0]
    symbol = pos.symbol
    volume = pos.volume

    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        return jsonify({'error': 'Tidak bisa ambil harga untuk close'}), 400

    if pos.type == mt5.ORDER_TYPE_BUY:
        close_type = mt5.ORDER_TYPE_SELL
        price = tick.bid
    else:
        close_type = mt5.ORDER_TYPE_BUY
        price = tick.ask

    request_obj = {
        'action':      mt5.TRADE_ACTION_DEAL,
        'symbol':      symbol,
        'volume':      volume,
        'type':        close_type,
        'position':    ticket,
        'price':       price,
        'deviation':   20,
        'magic':       20260601,
        'comment':     'DaunMerah-Close',
        'type_time':   mt5.ORDER_TIME_GTC,
        'type_filling': mt5.ORDER_FILLING_IOC,
    }

    result = mt5.order_send(request_obj)
    if result is None or result.retcode != mt5.TRADE_RETCODE_DONE:
        err_msg = result.comment if result else str(mt5.last_error())
        return jsonify({'error': f'Close gagal: {err_msg}'}), 400

    return jsonify({
        'closed':      True,
        'ticket':      ticket,
        'close_price': result.price,
        'close_time':  datetime.datetime.now().isoformat(),
    })


if __name__ == '__main__':
    print('=' * 50)
    print('  Daun Merah — MT5 Bridge')
    print('  http://localhost:5000')
    print('=' * 50)
    ok, err = ensure_mt5()
    if ok:
        info = mt5.account_info()
        print(f'  MT5 terhubung: {info.server}')
        print(f'  Login: {info.login} | Balance: {info.currency} {info.balance:,.2f}')
    else:
        print(f'  MT5 belum terbuka — akan diinisialisasi saat request pertama')
    print('=' * 50)
    app.run(port=5000, debug=False)
