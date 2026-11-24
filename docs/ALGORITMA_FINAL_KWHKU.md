# Audit Sistem dan Algoritma Final kWh-Ku

Tanggal audit: 24 November 2026  
Repository: `denisrohmansyah-cloud/kWhku`  
Branch yang diaudit: `main`

## 1. Ruang lingkup dan batas perubahan

Audit dilakukan terhadap:
- `firmware/kWhKu_ESP32_Relay_Prototype.ino`
- `Code.gs`
- `app.js`
- `index.html`
- `style.css`
- `config.js`

Arsitektur yang dipertahankan: ESP32 + PZEM-004T + DHT11 + LCD + relay, Apps Script, Google Sheets, dashboard web, dan Telegram.

Batas perubahan:
1. Tidak mengubah perangkat keras, wiring, pin, atau rangkaian relay yang telah dipasang.
2. Tidak mengubah nama, urutan, atau struktur kolom Google Sheets yang sudah digunakan.
3. Tidak melakukan deployment Apps Script atau flashing firmware tanpa langkah verifikasi dan persetujuan terpisah.
4. Mempertahankan data mentah dengan presisi penuh; pemotongan desimal hanya untuk tampilan.
5. Tidak menyatakan sistem sebagai perangkat proteksi listrik tersertifikasi. Perangkat lunak tidak menggantikan proteksi listrik independen.

## 2. Ringkasan hasil audit

### Temuan prioritas tinggi

**A-01 — Dokumentasi firmware tidak konsisten dengan penggunaan aktual.**  
Header firmware menyebut relay sebagai prototipe beban DC tegangan ekstra-rendah dan melarang relay digunakan pada rangkaian listrik kamar. Konteks operasional proyek menyatakan relay telah dipasang untuk mengendalikan suplai listrik kamar. Ini harus diselaraskan pada dokumentasi dan prosedur verifikasi; audit perangkat lunak tidak dapat membuktikan keamanan instalasi fisik.

**A-02 — Penurunan counter energi PZEM hanya dicatat, belum dipulihkan dalam kalkulasi.**  
`doPost()` mencatat insiden ketika nilai energi turun. Namun `energyBetween_()` dan `dailyUsage_()` melewati interval ketika counter baru lebih kecil dari counter sebelumnya. Akibatnya, energi pada interval reset dapat hilang dari rekap. Baseline reset periode pelanggan yang sudah ada adalah mekanisme berbeda dan tidak otomatis mendeteksi reset counter PZEM.

**A-03 — Estimasi biaya harian memakai sampel 20 pembacaan, bukan jendela 24 jam.**  
`estimateDailyCost_()` mengambil pembacaan terbaru dan pembacaan sekitar 20 posisi sebelumnya, lalu mengekstrapolasi delta menjadi 24 jam. Dengan interval upload normal 60 detik, jendela ini kira-kira 20 menit, sehingga estimasi dapat sangat sensitif terhadap beban sesaat. Perhitungan ini perlu diganti dengan jendela waktu yang eksplisit dan fallback saat data belum cukup.

**A-04 — ACK perintah relay belum memvalidasi kesesuaian state.**  
Pada `relayDeviceApi_()`, ACK menandai perintah sebagai `ACKNOWLEDGED` berdasarkan command ID, tanpa memastikan state output yang dilaporkan sama dengan `desiredState`. Dashboard dapat menampilkan perintah terkonfirmasi meskipun state aktual tidak sesuai. ACK harus membedakan diterima, berhasil diterapkan, dan gagal/tidak sesuai.

**A-05 — Mode AUTO dengan pemulihan manual belum memiliki prosedur reset eksplisit.**  
Ketika `autoRecover=false`, `autoTripLatched` tetap terkunci setelah trip. Pada alur yang diperiksa belum ditemukan perintah reset latch yang terdefinisi. Mengubah opsi ke pemulihan otomatis dapat melepaskan latch setelah kondisi normal stabil, tetapi itu bukan reset manual yang eksplisit. Perlu ditetapkan alur reset yang terotorisasi dan tercatat.

### Temuan prioritas menengah

**A-06 — Ambang alarm Telegram dan relay tidak sepenuhnya identik.**  
Keduanya memakai parameter konfigurasi pelanggan, tetapi evaluasi pemulihan dan batas suhu berbeda. Contoh: relay memicu suhu saat `temperatureC > maxTemperatureC`, sedangkan Telegram menggunakan `>=`; aturan pemulihannya juga tidak seragam. Kebijakan trigger/recovery perlu disatukan sebagai satu spesifikasi, meskipun kanal notifikasi dan kendali tetap terpisah.

**A-07 — Status online perangkat dan freshness relay memiliki definisi berbeda.**  
Status dashboard memakai batas `MAX_AGE_MINUTES_ONLINE = 3` menit berdasarkan pembacaan listrik. Status relay memakai heartbeat maksimum 15 detik. Perbedaan ini boleh dipertahankan karena mengukur hal berbeda, tetapi label UI dan dokumentasi harus menyebutkannya secara jelas.

**A-08 — Sinkronisasi LCD dan upload pembacaan memiliki interval berbeda.**  
Upload pembacaan berjalan 60 detik, sedangkan snapshot dashboard LCD 30 detik. LCD dapat menampilkan snapshot yang belum berubah di antara dua upload. Ini bukan otomatis kesalahan, tetapi perlu label waktu/sumber yang jelas dan penanganan snapshot gagal yang eksplisit.

**A-09 — Data sensor suhu/kelembapan dan listrik memiliki validasi dan penyimpanan terpisah.**  
Firmware memvalidasi DHT11 dan PZEM. Apps Script menerima data suhu/kelembapan hanya bila keduanya lolos rentang, dan menyimpan di `Data_Suhu`. Algoritma harus mempertahankan validitas per kelompok sensor; kegagalan DHT11 tidak boleh menghapus pembacaan listrik yang valid.

**A-10 — Perintah manual dan AUTO sudah memiliki sebagian interlock lokal.**  
ESP32 memeriksa konfigurasi, mode, validitas sensor, dan alarm terpilih sebelum ON. Startup juga menginisialisasi output OFF. Ini harus dipertahankan. Validasi perintah perlu diperketat agar hanya state `ON` atau `OFF` yang diterima, dan setiap perubahan output dilaporkan dengan alasan yang konsisten.

## 3. Algoritma final yang ditetapkan

Urutan proses sistem:

1. **Inisialisasi perangkat**
   - Inisialisasi Serial, PZEM, DHT11, LCD, Wi-Fi, dan timer.
   - Terapkan kondisi awal relay OFF sebelum memproses perintah.
   - Tandai konfigurasi relay belum valid sampai konfigurasi server diterima.
   - Jangan mengaktifkan output hanya karena ESP32 baru menyala.

2. **Akuisisi sensor**
   - Baca parameter PZEM: tegangan, arus, daya, energi kumulatif, frekuensi, dan faktor daya.
   - Baca suhu dan kelembapan DHT11.
   - Catat waktu pembacaan dan status validitas masing-masing kelompok sensor.
   - Kegagalan satu kelompok sensor tidak membatalkan kelompok lain yang valid.

3. **Validasi dan normalisasi**
   - Pastikan nilai numerik finite, tidak negatif untuk parameter yang tidak boleh negatif, dan berada pada rentang yang ditetapkan.
   - Bedakan nilai tidak tersedia dari nilai nol.
   - Jangan mengganti data tidak valid dengan nol.
   - Data mentah yang valid dipertahankan tanpa pembulatan.

4. **Evaluasi kondisi keselamatan lokal**
   - Evaluasi hanya alarm yang dipilih pada konfigurasi kendali relay.
   - Jika data listrik tidak valid, relay tidak boleh diperintahkan ON.
   - Jika parameter DHT11 dipilih sebagai interlock dan data DHT11 tidak valid, relay tidak boleh diperintahkan ON.
   - Evaluasi ambang abnormal dan status latch sebelum memutuskan output.
   - Evaluasi lokal ESP32 tetap berjalan walaupun koneksi cloud terputus, menggunakan konfigurasi terakhir yang valid.

5. **Pemilihan mode kendali**
   - Jika kendali relay dinonaktifkan, output OFF.
   - Jika mode MANUAL: ON hanya bila ada permintaan ON yang valid, konfigurasi masih MANUAL dan aktif, data interlock valid, serta tidak ada alarm pemblokir. OFF selalu dapat diproses.
   - Jika mode AUTO: alarm aktif menyebabkan OFF dan mengunci trip. Setelah semua kondisi normal, jalankan timer stabilisasi. Output ON hanya setelah waktu stabil tercapai dan kebijakan pemulihan mengizinkan.
   - Perubahan mode selalu memulai keadaan aman OFF dan menghapus permintaan manual lama.

6. **Eksekusi output dan pencatatan keputusan**
   - Terapkan satu fungsi output relay sebagai satu-satunya jalur penulisan GPIO.
   - Simpan state output aktual, state keputusan, dan alasan keputusan.
   - Jangan menganggap perintah berhasil hanya karena masuk antrean server.
   - Laporkan status/heartbeat secara berkala dan setiap kali state atau alasan berubah.

7. **Komunikasi dan sinkronisasi cloud**
   - Wi-Fi dikelola non-blocking dengan batas waktu dan jeda retry.
   - Poll konfigurasi/perintah relay secara terpisah dari upload data sensor.
   - Perintah harus memiliki ID unik, status antrean, batas kedaluwarsa, dan hasil ACK yang memverifikasi state aktual.
   - Kegagalan cloud tidak boleh menyebabkan relay otomatis ON.
   - Saat cloud pulih, kirim status aktual terbaru; jangan mengeksekusi perintah yang kedaluwarsa.

8. **Pengiriman dan penyimpanan pembacaan**
   - Kirim pembacaan listrik dan DHT11 dengan identitas perangkat dan timestamp.
   - Server memvalidasi API key, pelanggan/perangkat aktif, timestamp, serta rentang nilai.
   - Simpan nilai mentah dengan presisi penuh; kolom tampilan tidak menjadi sumber perhitungan.
   - Simpan listrik dan suhu pada sheet yang telah ditetapkan, tanpa mengubah skema yang ada.

9. **Pengolahan energi dan biaya**
   - Urutkan pembacaan berdasarkan timestamp yang valid.
   - Hitung delta counter hanya pada pasangan pembacaan yang kronologis dan dapat dipercaya.
   - Tangani reset counter dengan baseline/segmen baru yang tercatat, bukan mengabaikan seluruh interval secara diam-diam.
   - Batasi kontribusi interval terhadap periode yang diminta dan distribusikan interval lintas tengah malam secara proporsional.
   - Tarif berasal dari data pelanggan; fallback hanya dipakai bila tarif pelanggan memang tidak tersedia.
   - Estimasi biaya harian harus memakai jendela waktu nyata yang didefinisikan, bukan jumlah baris tetap.

10. **Alarm dan notifikasi**
    - Gunakan spesifikasi ambang, hysteresis pemulihan, dan validitas sensor yang sama untuk seluruh kanal.
    - Master alarm Telegram mengatur notifikasi; flag interlock relay mengatur kendali output. Keduanya tetap memiliki fungsi berbeda.
    - Kelompokkan beberapa parameter abnormal menjadi satu pesan, kirim notifikasi pemulihan, dan batasi pengingat berulang.
    - Kegagalan Telegram tidak boleh menghambat penyimpanan data atau keputusan relay.

11. **Dashboard, LCD, dan status**
    - Dashboard menampilkan nilai mentah/hasil format tanpa mengubah sumber data.
    - Tampilkan status online cloud dan freshness relay sebagai indikator yang berbeda.
    - LCD menampilkan snapshot terakhir yang valid dan tidak menyamarkan snapshot lama sebagai data baru.
    - Perintah manual menampilkan status antrean, ACK, output aktual, dan alasan penolakan.

12. **Audit trail dan pemulihan**
    - Catat perubahan konfigurasi, perintah, ACK, trip, pemulihan, counter reset, data invalid, dan kegagalan komunikasi.
    - Hindari pencatatan berulang yang tidak perlu; gunakan perubahan state dan heartbeat.
    - Setelah restart, mulai dari OFF, ambil konfigurasi, validasi sensor, lalu jalankan kebijakan mode yang tersimpan.

## 4. Aturan keputusan relay

Urutan prioritas tertinggi ke terendah:

1. Output OFF saat startup atau konfigurasi belum valid.
2. Output OFF saat kendali relay dinonaktifkan atau mode tidak valid.
3. Output OFF saat sensor yang diwajibkan untuk interlock tidak valid/kedaluwarsa.
4. Output OFF saat alarm interlock aktif.
5. Dalam MANUAL, ikuti permintaan ON/OFF hanya setelah semua pemeriksaan di atas lolos.
6. Dalam AUTO, ON hanya setelah seluruh alarm normal selama waktu stabilisasi dan kebijakan recovery mengizinkan.
7. Jika komunikasi cloud hilang, pertahankan evaluasi lokal dengan konfigurasi valid terakhir; jangan menerima perintah baru dari cloud sampai koneksi pulih.

Catatan: OFF adalah keadaan aman yang dipilih firmware ketika keputusan tidak dapat dipastikan. Penilaian keselamatan instalasi fisik tetap berada di luar cakupan audit kode.

## 5. Urutan implementasi setelah Tahap 1

Implementasi dilakukan dalam unit kecil dan ditinjau per file:

1. **P0 — Kontrak data dan status:** samakan status perintah, ACK, output, freshness, dan alasan keputusan.
2. **P1 — Relay state machine:** validasi state perintah, reset latch yang eksplisit, interlock MANUAL/AUTO, dan fail-safe saat data tidak valid.
3. **P2 — Energi dan biaya:** segmentasi counter reset, baseline, jendela kalkulasi, dan estimasi harian.
4. **P3 — Alarm:** samakan ambang dan hysteresis lintas relay/Telegram, pertahankan master alarm terpisah dari flag interlock.
5. **P4 — Komunikasi:** retry, timeout, stale command, ACK, dan sinkronisasi status.
6. **P5 — Tampilan:** dashboard/LCD menampilkan timestamp, freshness, raw value, dan state yang benar.
7. **P6 — Pengujian regresi:** validasi API, kalkulasi, state machine, dan konsistensi file.

Setiap perubahan harus melewati pemeriksaan statis dan skenario uji. Pengujian hardware, flashing firmware, dan deployment Apps Script dicatat sebagai belum dilakukan sampai benar-benar dijalankan.

## 6. Skenario uji minimum

- Boot ESP32 dengan konfigurasi belum diterima: relay tetap OFF.
- Sensor PZEM invalid atau data interlock DHT invalid: permintaan ON ditolak.
- MANUAL ON/OFF, termasuk alarm muncul ketika relay sedang ON.
- AUTO trip, kondisi pulih, waktu stabilisasi, recovery otomatis, dan recovery manual.
- Mode berubah saat relay ON: output kembali OFF.
- Perintah duplikat, perintah kedaluwarsa, ACK state sesuai, dan ACK state tidak sesuai.
- Wi-Fi/cloud terputus dan pulih kembali.
- Counter energi normal, reset PZEM, reset periode pelanggan, data terlambat, dan timestamp tidak berurutan.
- Interval energi melewati tengah malam dan batas bulan.
- Sampel kurang dari jendela estimasi harian.
- Alarm aktif, beberapa alarm bersamaan, hysteresis pemulihan, reminder, dan Telegram gagal.
- DHT11 gagal sementara PZEM tetap valid.
- Dashboard dan LCD menampilkan status freshness dengan benar.

## 7. Status Tahap 1

Audit kode utama telah dilakukan pada branch `main`. Dokumen ini menjadi spesifikasi acuan implementasi. Temuan A-01 sampai A-10 harus ditangani sesuai prioritas, dengan perhatian khusus pada konsistensi dokumentasi relay, perhitungan energi setelah reset, validasi ACK, dan estimasi biaya harian.

Belum ada klaim bahwa firmware telah dikompilasi, perangkat fisik telah diuji, atau Apps Script telah dideploy.
