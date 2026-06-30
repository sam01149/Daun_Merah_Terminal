setiap kali saya lakukan perintah padamu:
1. kerjakan perintaku tanpa ada satupun yang terlewat, termasuk detail kecil yang mungkin terlewatkan olehku
2. setelah selesai, lakukan evaluasi mandiri: cek bug, edge case, konsistensi UI, dan hal-hal yang seharusnya ada tapi belum ada — perbaiki tanpa menunggu instruksi
3. untuk keputusan kreatif (desain, struktur kode, UX), kamu bebas memilih pendekatan terbaik selama konsisten dengan stack yang sudah ada
4. uji fitur yang kamu sudah kerjakan, uji terus sampai benar benar berfungsi sesuai dengan ekspektasi, jika belum sesuai ekspektasi evaluasi kembali sampai benar benar berhasil 
5. update daun_merah.md dengan progress terbaru, lalu push ke GitHub

---

## Konvensi Animasi & UX (ditetapkan sesi 120)

Gunakan prinsip psikologi untuk semua animasi baru:

- **Reveal (elemen datang)**: `ease-out` atau `cubic-bezier(0.16, 1, 0.3, 1)` — cepat di awal, lambat mendekati posisi akhir. Durasi lebih panjang (~350–450ms).
- **Dismiss (elemen pergi)**: `ease-in` — mulai pelan, keluar cepat. Durasi lebih pendek (~180–220ms).
- **Elemen buka/tutup (drawer, panel)**: selalu asimetris — buka pakai ease-out, tutup pakai ease-in. Pisahkan di CSS base vs `.open` class.
- **Modal**: tambahkan entrance animation `scale(0.95) translateY(14px) → scale(1) translateY(0)` pada inner box. Karena modal pakai `display:none → display:flex`, animasi otomatis restart setiap dibuka.
- **Jangan gunakan `ease` polos** untuk animasi masuk/keluar elemen — kurva ease punya slow-start yang terasa "malas". Pilih `ease-out` untuk reveal, `ease-in` untuk dismiss.

---

## Status CB Research Feeds (diaudit sesi 120)

File: `api/feeds.js` → `CB_RESEARCH_SOURCES`

| Key | Status | Catatan |
|-----|--------|---------|
| FED, FOMC, FEDN | ✅ | Direct, stabil |
| ECB, ECBB | ✅ | Direct, stabil |
| BIS | ✅ | Direct (RSS 1.0/RDF) — **jangan pakai rss2json** |
| BOC | ✅ | Direct ke `/feed/` — bukan `/feed/speeches/` (URL mati) |
| BOE, BOEP | ✅ | Direct, ditambahkan sesi 120 (speeches + publications) |
| MTM, ING | ✅ | Direct, stabil |
| RBA, RBAM, RBAS | ⚠️ | Via rss2json — RBA blokir Vercel IP langsung; rss2json kadang 500 |
| BOJ | ❌ | Dihapus — RSS feeds tidak ada setelah redesign 2024 |
| RBNZ, SNB | ❌ | 403 dari semua jalur yang ditest |

Parser `parseCBRSSItems`: regex `<(?:item|entry)\b[^>]*>` — sudah support RSS 2.0, Atom, dan RDF/RSS 1.0 (BIS).
