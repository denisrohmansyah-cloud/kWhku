#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <PZEM004Tv30.h>
#include <math.h>

const char* WIFI_SSID = "NAMA_WIFI";
const char* WIFI_PASSWORD = "PASSWORD_WIFI";
const char* API_URL = "https://script.google.com/macros/s/AKfycbxIegsiM_A3M4EtqOHTnHDCPv8pI4GR36mihZWrn5VL0qJaEr_94VPySe-LPxZzHgCzig/exec";
const char* DEVICE_API_KEY = "GANTI_DENGAN_DEVICE_API_KEY";
const char* CUSTOMER_ID = "PLG-001";
const char* DEVICE_ID = "ESP32-001";

constexpr int PZEM_RX_PIN = 16;
constexpr int PZEM_TX_PIN = 17;
PZEM004Tv30 pzem(Serial2, PZEM_RX_PIN, PZEM_TX_PIN);

constexpr unsigned long SEND_INTERVAL_MS = 60000;
constexpr unsigned long WIFI_RETRY_MS = 10000;
unsigned long lastSendMs = 0;
unsigned long lastWiFiRetryMs = 0;

bool validMeasurement(float v) {
  return isfinite(v) && !isnan(v) && v >= 0;
}

void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Menghubungkan Wi-Fi");
  unsigned long started = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - started < 20000) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("Wi-Fi berhasil terhubung.");
    Serial.print("IP ESP32: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("Wi-Fi belum terhubung; akan dicoba kembali.");
  }
}

bool readPZEM(float &voltage, float &current, float &power,
              float &energy, float &frequency, float &powerFactor) {
  voltage = pzem.voltage();
  if (!validMeasurement(voltage)) return false;
  current = pzem.current();
  power = pzem.power();
  energy = pzem.energy();
  frequency = pzem.frequency();
  powerFactor = pzem.pf();
  return validMeasurement(current) && validMeasurement(power) &&
         validMeasurement(energy) && validMeasurement(frequency) &&
         validMeasurement(powerFactor);
}

bool sendToAppsScript(float voltage, float current, float power,
                      float energy, float frequency, float powerFactor) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Pengiriman batal: Wi-Fi tidak terhubung.");
    return false;
  }
  if (String(DEVICE_API_KEY).length() == 0 ||
      String(DEVICE_API_KEY) == "GANTI_DENGAN_DEVICE_API_KEY") {
    Serial.println("ERROR: isi DEVICE_API_KEY terlebih dahulu.");
    return false;
  }

  WiFiClientSecure client;
  // Hanya untuk pengujian awal; produksi sebaiknya memverifikasi sertifikat TLS.
  client.setInsecure();
  HTTPClient http;
  http.setConnectTimeout(15000);
  http.setTimeout(20000);
  http.setFollowRedirects(HTTPC_FORCE_FOLLOW_REDIRECTS);

  if (!http.begin(client, API_URL)) {
    Serial.println("ERROR: gagal memulai HTTPS.");
    return false;
  }
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Accept", "application/json");

  // Field disamakan dengan doPost(e) di Code.gs.
  String payload = "{";
  payload += "\"apiKey\":\"" + String(DEVICE_API_KEY) + "\",";
  payload += "\"deviceId\":\"" + String(DEVICE_ID) + "\",";
  payload += "\"customerId\":\"" + String(CUSTOMER_ID) + "\",";
  payload += "\"voltageV\":" + String(voltage, 2) + ",";
  payload += "\"currentA\":" + String(current, 3) + ",";
  payload += "\"powerW\":" + String(power, 2) + ",";
  payload += "\"energyKwh\":" + String(energy, 3) + ",";
  payload += "\"frequencyHz\":" + String(frequency, 2) + ",";
  payload += "\"powerFactor\":" + String(powerFactor, 2) + ",";
  payload += "\"source\":\"ESP32\"";
  payload += "}";

  Serial.println("Mengirim data ke Google Apps Script...");
  int httpCode = http.POST(payload);
  String response = http.getString();
  Serial.print("HTTP status: ");
  Serial.println(httpCode);
  Serial.println("Respons server:");
  Serial.println(response);
  http.end();

  if (httpCode >= 200 && httpCode < 300 &&
      response.indexOf("\"ok\":true") >= 0) {
    Serial.println("BERHASIL: server mengonfirmasi data tersimpan.");
    return true;
  }
  Serial.println("GAGAL: periksa respons server di atas.");
  return false;
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println();
  Serial.println("==================================");
  Serial.println("       kWh-Ku ESP32");
  Serial.println("       PZEM-004T V4.0");
  Serial.println("==================================");
  Serial.println("PZEM RX ESP32: GPIO16");
  Serial.println("PZEM TX ESP32: GPIO17");
  connectWiFi();
  lastSendMs = millis() - SEND_INTERVAL_MS;
  Serial.println("Inisialisasi selesai.");
}

void loop() {
  const unsigned long now = millis();
  if (WiFi.status() != WL_CONNECTED &&
      now - lastWiFiRetryMs >= WIFI_RETRY_MS) {
    lastWiFiRetryMs = now;
    connectWiFi();
  }
  if (now - lastSendMs < SEND_INTERVAL_MS) {
    delay(20);
    return;
  }
  lastSendMs = now;

  float voltage = NAN, current = NAN, power = NAN;
  float energy = NAN, frequency = NAN, powerFactor = NAN;
  Serial.println();
  Serial.println("========== DATA PZEM ==========");

  if (!readPZEM(voltage, current, power, energy, frequency, powerFactor)) {
    Serial.println("GAGAL membaca PZEM. Data tidak dikirim.");
    Serial.println("Periksa UART, kabel, level logika, dan library sensor.");
    return;
  }
  Serial.printf("Tegangan    : %.2f V\n", voltage);
  Serial.printf("Arus        : %.2f A\n", current);
  Serial.printf("Daya        : %.2f W\n", power);
  Serial.printf("Energi      : %.3f kWh\n", energy);
  Serial.printf("Frekuensi   : %.2f Hz\n", frequency);
  Serial.printf("Faktor daya : %.2f\n", powerFactor);
  sendToAppsScript(voltage, current, power, energy, frequency, powerFactor);
  Serial.println("===============================");
}
