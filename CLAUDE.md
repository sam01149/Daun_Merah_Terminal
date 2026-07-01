setiap kali saya berikan perintah padamu:

1. buat plan terlebih dahulu di daun_merah_plan.md sebelum eksekusi apapun. Plan ini harus detail dan menyeluruh karena akan diserahkan ke AI lain (Claude Sonnet 4.6/Gemini/ChatGPT/DeepSeek/dsb) untuk pengerjaan teknis tanpa akses ke sesi ini. Plan wajib memuat:
   - konteks & tujuan perintah (apa yang diminta, kenapa, hasil akhir yang diharapkan)
   - state saat ini vs state target
   - daftar file yang terlibat lengkap dengan path-nya, dan bagian spesifik mana yang berubah
   - langkah teknis berurutan, cukup rinci agar AI lain bisa eksekusi tanpa bertanya balik
   - edge case dan skenario gagal yang harus diantisipasi
   - kriteria selesai/berhasil yang terukur (bukan "sudah jalan" tapi kondisi spesifik apa yang harus terpenuhi)
   - batasan/constraint yang tidak boleh dilanggar (mengacu ke AGENTS.md dan daun_merah.md)
   - referensi ke pekerjaan/eksperimen sebelumnya di daun_merah.md yang relevan atau berisiko konflik
setelah kamu lakukan buat plannya, kamu konfirmasi ke saya agar saya dapat membaca plan tersebut
note: kalau saya interupsi kalau kamu lagi kerja, kamu tidak perlu ulang dari awal(tidak perlu ulang dari nomor 1)
2. kerjakan perintahku tanpa ada satupun yang terlewat, termasuk detail kecil yang mungkin terlewatkan olehku
3. setelah selesai, lakukan evaluasi mandiri: cek bug, edge case, konsistensi UI, dan hal-hal yang seharusnya ada tapi belum ada — perbaiki tanpa menunggu instruksi
4. untuk keputusan kreatif (desain, struktur kode, UX), kamu bebas memilih pendekatan terbaik selama konsisten dengan stack yang sudah ada
5. uji fitur yang kamu sudah kerjakan, uji terus sampai benar benar berfungsi sesuai dengan ekspektasi, jika belum sesuai ekspektasi evaluasi kembali sampai benar benar berhasil
6. update daun_merah.md dengan progress terbaru, hapus bagian pekerjaan yang sudah selesai dari daun_merah_plan.md, lalu push ke GitHub