# Daun Merah — Plan Handoff (Sisa Backlog Opsional)

> **Status (2026-06-30, Session 126):** Seluruh tugas Blok D (A2.3 Fase 2, B2 4.0c, B3 COR-G, QUAL-11, QUAL-17) **sudah selesai dikerjakan** di session ini. Lihat "Changelog Session 126" di `daun_merah.md` untuk detailnya.
>
> **Status (2026-07-01, Session 134):** Section **G — Session Strip di REGIME bar** **sudah selesai dikerjakan** (semua item Definition of Done G8 terverifikasi). Lihat "Changelog Session 134" di `daun_merah.md` untuk detailnya. Sisanya (F, E) tetap **sisa backlog opsional** — bukan prioritas, diabaikan kecuali diminta user.

---

# G. UI — SESSION STRIP DI REGIME BAR  ✅ SELESAI (Session 134)

> **Konteks:** Sisi kanan REGIME bar (strip horizontal di bawah header) sekarang kosong ~60% — cuma `REGIME: NEUTRAL · VIX · MOVE · HY` nempel di kiri. Isi ruang itu dengan **indikator sesi FX** yang glanceable, self-updating pelan, non-duplikat, dan low-noise. Ini keputusan final user (dipilih dari 4 opsi; menang telak vs DXY gauge karena logikanya sudah ada & tidak rawan tick-noise).

## G0. Prinsip (jangan dilanggar)
- **Single source of truth.** Boundary sesi HARUS identik dengan yang dipakai checklist di `ckUpdateClock()` (sekarang hardcode di ~`index.html:8482-8486`). Idealnya refactor keduanya baca dari satu helper `getFxSession()` (lihat G3) supaya header & checklist tidak pernah beda.
- **Low-noise.** Update cukup tiap 30 dtk (bukan tiap detik). Sesi cuma ganti beberapa kali sehari — jangan bikin elemen berkedip.
- **Supplementary, bukan prioritas layout.** `regime-main` + `regime-meta` tetap prioritas. Strip sesi adalah tambahan → dia yang pertama disembunyikan di layar sempit, bukan sebaliknya. Jangan sampai meng-clip teks regime.
- **Reuse warna existing:** `--yellow` (London/Overlap), `#60a5fa` (NY), `--muted` (Tokyo/Closed). Sudah dipakai di `.ck-sess-*` (`index.html:1665-1667`).

## G1. Model sesi (UTC) — WAJIB sama dengan checklist
Partisi non-overlap penuh 24 jam (pakai `getUTCHours`, ikut konvensi app yang sudah ada; DST diabaikan — konsisten dgn checklist saat ini, jangan diubah):

| Sesi | Rentang UTC | Sifat | Warna aktif |
|---|---|---|---|
| TOKYO | 00:00–08:00 | hindari entry | `--muted` |
| LONDON | 08:00–13:00 | prime | `--yellow` |
| OVERLAP (London+NY) | 13:00–16:00 | likuiditas tertinggi | `--yellow` |
| NEW YORK | 16:00–21:00 | bagus | `#60a5fa` |
| CLOSED | 21:00–24:00 | low volume | `--muted` |

## G2. HTML — tambah di `.regime-row`
Di `index.html` ~`2236`, setelah `<span class="regime-meta" id="regimeMeta">`, tambahkan:
```html
<span class="regime-sessions" id="regimeSessions"></span>
```
Diisi oleh JS (G4). Catatan: `.regime-banner` punya `onclick="toggleRegimeDetail()"`, jadi klik di strip ini akan ikut toggle detail regime — itu **acceptable**, tidak perlu `stopPropagation`.

## G3. Helper bersama (single source of truth)
Tambahkan fungsi baru (mis. tepat sebelum `ckUpdateClock`, ~`8474`):
```js
function getFxSession(now = new Date()) {
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  const SESS = [
    { key:'tokyo',   label:'TOKYO',   cls:'s-tokyo',   start:0,       end:8*60,  ckLabel:'Tokyo Session — hindari entry',    ckCls:'ck-sess-other'   },
    { key:'london',  label:'LONDON',  cls:'s-london',  start:8*60,    end:13*60, ckLabel:'London Session',                    ckCls:'ck-sess-london'  },
    { key:'overlap', label:'OVERLAP', cls:'s-overlap', start:13*60,   end:16*60, ckLabel:'London + New York (Overlap)',       ckCls:'ck-sess-overlap' },
    { key:'ny',      label:'NY',      cls:'s-ny',      start:16*60,   end:21*60, ckLabel:'New York Session',                  ckCls:'ck-sess-ny'      },
    { key:'closed',  label:'CLOSED',  cls:'s-closed',  start:21*60,   end:24*60, ckLabel:'Market closed / low volume',        ckCls:'ck-sess-other'   },
  ];
  const idx = SESS.findIndex(s => mins >= s.start && mins < s.end);
  const cur = SESS[idx < 0 ? SESS.length - 1 : idx];
  const next = SESS[(SESS.indexOf(cur) + 1) % SESS.length];
  let msToNext = (cur.end * 60 - (mins * 60 + now.getUTCSeconds())) * 1000 - now.getUTCMilliseconds();
  if (msToNext < 0) msToNext += 24 * 3600 * 1000; // wrap CLOSED → TOKYO
  return { list: SESS, cur, next, msToNext };
}
```

## G4. Renderer + ticker global (independen dari tab)
Checklist clock cuma jalan saat tab CHECKLIST kebuka (`ckClockInterval` di-set di `initChecklist`, ~`8859`). Strip regime harus update apa pun tab aktifnya → ticker sendiri.
```js
function renderRegimeSessions() {
  const el = document.getElementById('regimeSessions');
  if (!el) return;
  const { list, cur, next, msToNext } = getFxSession();
  const chips = list
    .map(s => `<span class="regime-sess-chip${s === cur ? ' active ' + s.cls : ''}">${s.label}</span>`)
    .join('<span class="regime-sess-sep">›</span>');
  const mins = Math.max(0, Math.round(msToNext / 60000));
  const cd = mins >= 60 ? `${Math.floor(mins/60)}j ${mins%60}m` : `${mins}m`;
  el.innerHTML = chips + `<span class="regime-sess-next">→ ${next.label} in ${cd}</span>`;
}
```
Pasang di block `window.addEventListener('load', …)` (~`7292-7297`), bareng interval global lain:
```js
renderRegimeSessions();
setInterval(renderRegimeSessions, 30 * 1000);
```

## G5. Refactor checklist supaya reuse (REKOMENDASI kuat, jaga konsistensi)
Ganti if/else hardcode di `ckUpdateClock` (`8482-8486`) jadi baca helper:
```js
const { cur } = getFxSession(now);
ss.textContent = cur.ckLabel;
ss.className = 'ck-sess ' + cur.ckCls;
```
Verifikasi output identik dengan versi lama (label & warna). Ini menghapus duplikasi boundary.

## G6. CSS (dekat `.regime-*`, ~`1734-1746`)
```css
.regime-sessions { margin-left: auto; display: flex; align-items: center; gap: 6px;
  font-size: 9px; letter-spacing: .06em; white-space: nowrap; overflow: hidden; flex-shrink: 0; }
.regime-sess-chip { color: var(--muted); opacity: .45; text-transform: uppercase;
  transition: color .25s, opacity .25s; }
.regime-sess-chip.active { opacity: 1; font-weight: 800; }
.regime-sess-chip.active.s-tokyo,
.regime-sess-chip.active.s-closed  { color: var(--text-mid); }
.regime-sess-chip.active.s-london,
.regime-sess-chip.active.s-overlap { color: var(--yellow); }
.regime-sess-chip.active.s-ny      { color: #60a5fa; }
.regime-sess-sep  { opacity: .3; }
.regime-sess-next { color: var(--text-mid); opacity: .85; margin-left: 4px; }
/* Mobile: buang progression, sisakan sesi aktif + countdown saja (atau sembunyikan) */
@media (max-width: 820px) {
  .regime-sess-chip:not(.active), .regime-sess-sep { display: none; }
}
```
`regime-row` sudah `overflow:hidden` + `regime-meta` ellipsis → strip yang `flex-shrink:0` + `margin-left:auto` aman di desktop lebar; di mobile media query mengecilkannya.

## G7. Edge cases yang harus dicek
- **Kontras di semua regime bg.** Banner ganti warna sesuai regime (`risk-on #0f2a14`, `risk-off #2a0f0f`, `elevated #251e08`, `neutral #141413`). Pastikan chip aktif Tokyo/Closed (`--text-mid`) tetap kebaca di atas bg merah/hijau; kalau kurang, naikkan sedikit ke warna lebih terang. Yellow & blue aman.
- **Boundary rollover.** Uji `msToNext` pas jam 20:59→21:00 (NY→Closed) dan 23:59→00:00 (Closed→Tokyo wrap). Countdown tidak boleh negatif / tidak boleh "0m" nyangkut.
- **Layar sempit** tidak meng-clip `regime-main`/`regime-meta`.

## G8. Definition of Done
1. Strip sesi tampil rata kanan di REGIME bar, sesi aktif ter-highlight sesuai jam UTC saat ini.
2. Countdown "→ <next> in Xj Ym" turun tiap ≤30 dtk dan roll benar di batas sesi.
3. Label sesi di tab CHECKLIST tetap identik (single source of truth terbukti — ubah salah satu boundary, keduanya ikut).
4. Mobile: strip menyusut tanpa mengganggu teks regime.
5. Cek di ≥2 regime berbeda (paksa `regimeBanner` ke `risk-off`) → chip tetap legible.
6. Update `daun_merah.md` (changelog session) + push ke GitHub (sesuai CLAUDE.md).

**Test cepat tanpa nunggu jam:** di console jalankan `getFxSession(new Date(Date.UTC(2026,0,1,H,M)))` untuk tiap H batas (07,08,12,13,15,16,20,21,23) dan pastikan `cur`/`next`/`msToNext` benar.

---

# F. INFRASTRUKTUR

- **[INFRA-1] cron-job.org sebagai backup OHLCV sync**
  - **Masalah:** Vercel cron hourly (`30 * * * *`) tidak diizinkan di Hobby plan → dihapus session 130. Kalau GitHub Actions gagal 2-3 run berturut, data OHLCV bisa stale 2+ jam (penyebab "⚠ 2.8 jam lalu" di session 128).
  - **Solusi:** Daftarkan akun di [cron-job.org](https://cron-job.org) (gratis), buat job yang hit `https://financial-feed-app.vercel.app/api/admin?action=ohlcv_sync` tiap 30 menit. Request datang dari luar Vercel → tidak kena batasan Hobby plan.
  - **Cara setup:** Buat akun → New cronjob → URL endpoint → schedule `*/30 * * * *` → Save. Tidak perlu perubahan kode.

---

# E. SISA BACKLOG OPSIONAL

- **[QUAL-2]** FRASA TERLARANG mungkin terlalu agresif (konektor normal ikut dilarang) → prosa bisa kaku. **Pantau dulu via `quality_flags` dari C8, jangan ubah tanpa keluhan nyata.**
- **[C5 DRAFT]** Bagian teks prompt di C5 (headline mentah ke thesisPrompt) masih berstatus **DRAFT, menunggu review user** sebelum dianggap final. Kode sudah di-push, tapi kualitas output perlu divalidasi live.
- **[C8 Tahap 2 — OPSIONAL]** Kalau `phraseHits.length` sering melewati ambang via log produksi, pertimbangkan satu AI call kecil "tulis ulang kalimat ini tanpa frasa berikut". Tunggu bukti severity nyata dari `provider_log` dulu.
