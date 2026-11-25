# kWh-Ku — Kontrol Relay dan Monitoring melalui Telegram

Dokumen ini menjelaskan pemakaian bot Telegram setelah perubahan integrasi pada `Code.gs`.

## 1. Fitur bot

- Pengaitan akun Telegram ke akun pelanggan menggunakan kode sekali pakai dari dashboard.
- Pemantauan snapshot sensor terbaru dari heartbeat ESP32: tegangan, arus, daya, energi, frekuensi, faktor daya, suhu, dan kelembapan.
- Status relay CH1: output GPIO yang dilaporkan firmware, mode, status kendali, keputusan, alasan, perintah terakhir, dan usia heartbeat.
- Lima pembacaan terakhir dari `Data_Listrik`.
- Perintah relay MANUAL ON/OFF dan reset trip AUTO ketika pemulihan manual dipilih.
- Notifikasi alarm, pemulihan parameter, perangkat offline/online, dan konfirmasi hasil perintah dikirim ke chat Telegram pelanggan yang sudah ditautkan. `TELEGRAM_CHAT_IDS` tetap dapat dipakai sebagai penerima global/admin.

## 2. Konfigurasi Apps Script

Di **Project Settings → Script Properties**, pastikan:

- `SPREADSHEET_ID`
- `DEVICE_API_KEY`
- `ADMIN_PIN`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_BOT_USERNAME` (opsional; default bot username pada aplikasi adalah `kWhKuMonitoringBot`)
- `TELEGRAM_CHAT_IDS` (opsional; satu atau beberapa chat ID global dipisahkan koma)

Jangan menyimpan token bot, device API key, atau kredensial lain di repository publik.

## 3. Deploy dan webhook

1. Salin `Code.gs` terbaru ke project Google Apps Script yang digunakan oleh kWh-Ku.
2. Deploy sebagai Web App dengan **Execute as: Me** dan akses yang sesuai untuk menerima webhook Telegram.
3. Pastikan URL deployment yang sama masih dipakai oleh website dan ESP32.
4. Pilih fungsi `setupTelegramWebhook` di Apps Script Editor lalu jalankan sekali setelah deployment. Berikan izin UrlFetchApp jika diminta.
5. Pastikan eksekusi berhasil dan Telegram webhook mengarah ke URL Web App deployment terbaru.
6. Setelah setiap perubahan kode Apps Script, deploy versi baru. Perubahan di GitHub tidak otomatis mengubah project/deployment Apps Script.

Webhook memverifikasi secret query parameter, membatasi chat ke private chat, dan menolak update ID duplikat. Proses webhook diserialisasi dengan user lock; antrean relay menggunakan script lock agar tidak bertabrakan dengan permintaan relay dari website.

## 4. Menghubungkan akun pelanggan

1. Login ke dashboard kWh-Ku menggunakan akun pelanggan.
2. Buka bagian pengaitan Telegram dan buat kode pengaitan.
3. Buka bot Telegram `@kWhKuMonitoringBot`.
4. Kirim `/link KODE` (kode berlaku 10 menit dan hanya dapat digunakan sekali).
5. Kirim `/help` untuk melihat daftar perintah.

Satu akun pelanggan hanya dapat memiliki satu chat Telegram tertaut pada satu waktu. `/unlink` memutuskan tautan chat tersebut.

## 5. Perintah bot

| Perintah | Fungsi |
|---|---|
| `/start` | Memulai bot / petunjuk pengaitan |
| `/link KODE` | Mengaitkan chat ke akun pelanggan |
| `/help` | Daftar perintah |
| `/status` | Snapshot sensor terbaru dan status relay |
| `/relay` | Status relay dan snapshot terkait |
| `/history` | Lima pembacaan terakhir dari Data_Listrik |
| `/mode` | Mode dan status koneksi relay |
| `/on CONFIRM` | Meminta relay ON dalam mode MANUAL |
| `/off` | Meminta relay OFF; diprioritaskan terhadap antrean ON yang belum dikonfirmasi |
| `/reset CONFIRM` | Meminta reset trip AUTO dengan pemulihan manual |
| `/unlink` | Memutus tautan Telegram |

## 6. Aturan kendali dan batas keselamatan

### ON
- Memerlukan konfirmasi eksplisit `/on CONFIRM`.
- Hanya diterima saat relay aktif dan mode MANUAL.
- Snapshot heartbeat ESP32 harus berumur maksimal 15 detik.
- Hanya satu perintah yang boleh menunggu konfirmasi pada satu perangkat.
- Firmware tetap menjadi otoritas akhir: data sensor invalid atau alarm interlock aktif akan menolak ON dan mempertahankan output OFF.

### OFF
- `/off` tidak memerlukan konfirmasi tambahan.
- Dapat diminta dalam mode MANUAL maupun AUTO.
- Bila ada perintah ON/RESET yang masih PENDING, perintah itu ditandai SUPERSEDED dan OFF dimasukkan ke antrean terbaru. Jika ESP32 sudah sempat mengambil perintah sebelumnya, perubahan output tetap menunggu siklus polling/konfirmasi berikutnya; ini bukan pemutusan instan.

### RESET AUTO
- Memerlukan `/reset CONFIRM`.
- Hanya berlaku pada mode AUTO dengan pemulihan otomatis nonaktif.
- Snapshot ESP32 harus fresh dan output harus terkonfirmasi OFF.
- Firmware tetap memeriksa trip yang masih aktif, validitas sensor, dan waktu stabil. Server tidak memaksa output ON.

### Status dan alarm
- `/status` menampilkan sensor dari heartbeat relay, bukan hanya baris historis terakhir.
- Jika heartbeat lebih tua dari 15 detik, data sensor ditandai STALE/OFFLINE dan nilai sensor tidak ditampilkan sebagai data terbaru.
- Status output yang ditampilkan adalah status GPIO yang dilaporkan firmware, bukan verifikasi kontak relay secara elektrik.
- Notifikasi alarm dan pemulihan diarahkan ke chat pelanggan yang tertaut serta penerima global yang dikonfigurasi.

## 7. Urutan pengujian

Lakukan bertahap setelah deployment Apps Script:

1. Uji `/start`, `/help`, `/link KODE`, dan `/unlink`.
2. Uji `/status`, `/history`, dan `/mode`; cocokkan timestamp serta angka dengan dashboard.
3. Uji `/on` tanpa CONFIRM (harus meminta konfirmasi), lalu `/on CONFIRM` ketika mode MANUAL, relay enabled, dan heartbeat fresh.
4. Periksa `Perintah_Relay`, log relay, Serial Monitor, dan pesan konfirmasi Telegram.
5. Uji `/off`, termasuk ketika ada perintah ON yang belum terkonfirmasi.
6. Uji ON saat heartbeat stale dan saat interlock alarm aktif; keduanya harus ditolak atau diblokir firmware.
7. Uji `/reset CONFIRM` hanya pada konfigurasi AUTO + pemulihan manual setelah seluruh syarat firmware terpenuhi.
8. Uji notifikasi alarm, pemulihan, offline, dan online pada chat pelanggan tertaut.

Pengujian fisik aktuator harus mengikuti batas uji tegangan rendah yang terdokumentasi pada `firmware/README_Relay_Prototype.md`. Jangan menganggap pesan bot sebagai bukti kontak relay telah berpindah secara elektrik.
