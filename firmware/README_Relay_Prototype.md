# kWh-Ku — Integrasi Relay CH1 (Prototipe Tegangan Rendah)

Dokumen ini menjelaskan integrasi **kontrol manual dan otomatis CH1** pada firmware dan website kWh-Ku.

> **Batas keselamatan:** sketch ini hanya untuk beban DC/tegangan ekstra-rendah pada rangkaian uji terisolasi. Jangan hubungkan kontak relay PCB ke listrik PLN atau gunakan sebagai pemutus instalasi kamar. Untuk kendali instalasi listrik bangunan diperlukan perangkat pemutus/proteksi bersertifikat, pemilihan rating yang sesuai, enclosure, dan pemasangan oleh teknisi listrik kompeten.

## 1. Perubahan repository

File yang ditambahkan/diubah:
- \`Code.gs\`: endpoint konfigurasi relay, antrean perintah, polling dan konfirmasi ESP32.
- \`app.js\`, \`index.html\`, \`style.css\`: panel kontrol dan status relay pada Pengaturan Alarm.
- \`firmware/kWhKu_ESP32_Relay_Prototype.ino\`: sketch ESP32 untuk prototipe tegangan rendah.

Sheet tambahan dibuat otomatis saat fitur relay pertama kali dipakai:
- \`Konfigurasi_Relay\`: mode, enable, pilihan alarm pemicu, pemulihan otomatis, waktu stabil.
- \`Perintah_Relay\`: antrean perintah manual dari website.
- \`Log_Relay\`: riwayat konfigurasi, perintah, konfirmasi, dan status aktual.

Skema \`Data_Listrik\` tidak diubah. Data suhu/kelembapan tetap memakai \`Data_Suhu\`.

## 2. API yang digunakan

Website menggunakan pola API yang sudah ada:
- \`{fn:"getRelayStatus", args:[session, customerId]}\`
- \`{fn:"saveRelayConfig", args:[session, config, customerId]}\`
- \`{fn:"setRelayCommand", args:[session, "MANUAL", "ON|OFF", customerId]}\`

ESP32 memakai Device API Key:
- \`relayAction:"poll"\`: mengambil konfigurasi relay dan command PENDING.
- \`relayAction:"ack"\`: mengonfirmasi command dan status output yang diterapkan.
- \`relayAction:"status"\`: melaporkan perubahan status aktual.

Perintah manual kedaluwarsa setelah 120 detik bila belum diterima. Heartbeat status dikirim berkala setiap 30 detik; website menandai laporan lebih lama dari 90 detik sebagai `STALE`. Status perintah tidak dianggap sebagai status output GPIO sampai ESP32 mengonfirmasi. Website menampilkan output GPIO yang dilaporkan firmware, bukan umpan balik kontak COM/NO/NC secara elektrik.

## 3. Konfigurasi Google Apps Script

1. Salin perubahan \`Code.gs\` dari repository ke project Google Apps Script yang menjalankan API kWh-Ku.
2. Pastikan Script Properties sudah berisi \`SPREADSHEET_ID\` dan \`DEVICE_API_KEY\` yang sama dengan yang akan digunakan perangkat. Jangan menaruh API key di \`app.js\` atau HTML.
3. Deploy ulang project sebagai Web App menggunakan deployment/version baru, lalu pastikan \`config.js\` website masih mengarah ke URL deployment yang benar.
4. GitHub Pages tidak otomatis memperbarui project Google Apps Script kecuali integrasi deployment tersendiri memang sudah dibuat.

Sheet relay akan dibuat otomatis. Tidak perlu mengubah header \`Data_Listrik\`.

## 4. Konfigurasi firmware

Buka \`kWhKu_ESP32_Relay_Prototype.ino\`, isi bagian USER CONFIGURATION:
- Wi-Fi SSID dan password.
- URL Web App Apps Script.
- Device API Key (sama dengan Script Property).
- \`CUSTOMER_ID\` dan \`DEVICE_ID\` yang harus cocok dengan sheet \`Pelanggan\` (customerId dan meterId).

Jangan commit nilai Wi-Fi atau API key asli ke repository publik. Bila kredensial pernah terunggah, rotasi nilainya.

Library:
- PZEM004Tv30 by Jakub Mandula
- DHT sensor library by Adafruit
- LiquidCrystal_I2C
- ArduinoJson v6/v7
- ESP32 Arduino core

Pin:
| Perangkat | ESP32 |
|---|---:|
| PZEM TX | GPIO16 (RX2) |
| PZEM RX | GPIO17 (TX2) |
| DHT11 DATA | GPIO4 |
| LCD SDA | GPIO21 |
| LCD SCL | GPIO22 |
| Relay IN1 / CH1 | GPIO25 |
| Relay IN2 / CH2 | Tidak digunakan |

LCD address default \`0x27\`; ubah ke \`0x3F\` bila hasil I2C scanner menunjukkan alamat tersebut. Pastikan level tegangan pull-up I2C aman untuk ESP32.

## 5. Kunci aktuasi output dan logika kontrol

Di firmware tersedia konstanta `ENABLE_LOW_VOLTAGE_RELAY_TEST` yang default-nya `false`. Pada kondisi default, output GPIO25 ditahan pada keadaan OFF; permintaan ON maupun mode AUTO tidak menggerakkan koil. Sinkronisasi konfigurasi, perintah, heartbeat, dan status output tetap berjalan. Konstanta tersebut bukan opsi untuk mengaktifkan modul ketika terhubung ke instalasi PLN.



- Boot: GPIO25 dipaksa ke level OFF.
- Default firmware: aktuasi output dikunci; dashboard hanya menguji komunikasi, antrean perintah, dan pelaporan output.
- Kendali nonaktif: CH1 dipaksa OFF.
- Mode MANUAL: perintah ON/OFF dari website admin diproses melalui antrean dan dikonfirmasi ESP32.
- Mode AUTO: firmware mengevaluasi hanya alarm yang dipilih dalam panel relay. Tersedia pilihan tegangan rendah/tinggi, arus tinggi, daya tinggi, frekuensi rendah/tinggi, PF rendah, suhu tinggi, dan kelembapan rendah/tinggi.
- Ambang pemicu diambil dari Pengaturan Alarm, sedangkan pilihan alarm relay disimpan terpisah.
- Alarm terpilih aktif: output OFF.
- Kondisi semua alarm terpilih normal stabil selama waktu yang diatur: output ON bila pemulihan otomatis aktif.
- Sensor listrik tidak valid, sensor lingkungan yang sedang dipakai tidak valid, konfigurasi tidak diterima, atau relay dinonaktifkan: output OFF.
- Ketika Wi-Fi terputus, aturan AUTO tetap berjalan secara lokal dengan konfigurasi terakhir yang valid. Perintah manual baru tidak dapat diterima sampai koneksi kembali.

Waktu stabil dapat diatur 10–600 detik (default 60 detik). Saat restart, firmware memulai dari OFF dan dalam mode AUTO menunggu data sensor valid serta periode stabil sebelum mengaktifkan output.

## 6. Data PZEM dan logika keputusan

- ESP32 membaca PZEM setiap 2,5 detik dan mengevaluasi pemicu alarm yang dipilih secara lokal.
- Mode AUTO menetapkan keputusan OFF saat salah satu alarm yang dipilih aktif. Ketika semua pemicu normal terus-menerus selama waktu stabil yang diatur, keputusan menjadi ON bila pemulihan otomatis aktif.
- Mode MANUAL menerima permintaan ON/OFF dari Admin. Permintaan ON ditolak bila data sensor yang diperlukan tidak valid atau alarm relay terpilih sedang aktif; OFF selalu diprioritaskan.
- Snapshot PZEM (tegangan, arus, daya, energi, frekuensi, PF serta suhu/kelembapan bila valid) dikirim bersama heartbeat setiap 30 detik. Data pengukuran historis pada `Data_Listrik` tetap menggunakan interval upload 60 detik.
- Website menampilkan keputusan logis PZEM, snapshot sensor yang menyertainya, dan output GPIO25 secara terpisah. `ON` pada keputusan tidak berarti kontak relay sudah ON.
- Jika heartbeat lebih lama dari 90 detik, website menandai keputusan dan snapshot PZEM sebagai `STALE`.

## 7. Urutan pengujian yang disarankan

1. Pastikan relay CH1 belum terhubung ke beban AC/instalasi PLN.
2. Gunakan catu DC ekstra-rendah yang terisolasi dan beban uji kecil dengan pembatas arus/fuse yang sesuai.
3. Flash firmware dengan \`RELAY_ACTIVE_LOW=true\` sebagai asumsi awal untuk modul aktif-LOW. Verifikasi ON/OFF menggunakan pengujian DC; ubah konstanta hanya jika hasil pengukuran modul membuktikan polaritas berbeda.
4. Pastikan setelah boot CH1 OFF.
5. Deploy Apps Script versi terbaru dan pastikan ESP32 terhubung Wi-Fi serta konfigurasi relay tersinkron.
6. Uji mode MANUAL OFF lalu ON dari akun Admin; periksa bahwa status aktual berubah setelah konfirmasi ESP32.
7. Uji mode AUTO dengan memilih satu alarm pemicu, menggunakan ambang yang aman untuk pengujian, lalu periksa transisi OFF dan pemulihan setelah kondisi stabil.
8. Uji skenario sensor terputus dan Wi-Fi terputus. Sensor gagal harus membuat output OFF; Wi-Fi putus tidak boleh mematikan aturan lokal AUTO.
9. Periksa sheet \`Perintah_Relay\` dan \`Log_Relay\`, lalu pastikan riwayat listrik tetap masuk ke \`Data_Listrik\` seperti sebelumnya.

## 8. Batas hasil verifikasi

Kode sudah ditambahkan ke repository, tetapi belum dikompilasi dengan board ESP32 pengguna, belum diuji pada hardware, dan belum diuji terhadap deployment Apps Script/Google Sheets aktif. Lakukan uji kompilasi dan uji DC tegangan rendah terlebih dahulu. Jangan lanjutkan ke pengendalian beban AC kamar dengan modul relay PCB saat ini.
