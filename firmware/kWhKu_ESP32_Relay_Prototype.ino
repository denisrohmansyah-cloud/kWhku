/*
 * kWh-Ku — ESP32 + PZEM004T v4 + DHT11 + LCD1602 + Relay CH1 (LOW-VOLTAGE PROTOTYPE)
 *
 * WARNING:
 * - Relay CH1 is for an isolated extra-low-voltage DC prototype load ONLY.
 * - Do not connect this relay PCB to the room mains circuit.
 * - This firmware is NOT a certified electrical protection controller.
 * - Keep independent fuse/overcurrent protection in the low-voltage test circuit.
 *
 * Required libraries:
 *   PZEM004Tv30 by Jakub Mandula
 *   DHT sensor library by Adafruit
 *   LiquidCrystal_I2C
 *   ArduinoJson (v6/v7)
 *   ESP32 Arduino core
 *
 * ESP32 DevKit V1 pin map:
 *   PZEM TX -> GPIO16 (ESP32 RX2)
 *   PZEM RX -> GPIO17 (ESP32 TX2)
 *   DHT11 DATA -> GPIO4
 *   LCD SDA -> GPIO21, SCL -> GPIO22
 *   Relay module IN1 -> GPIO25
 *   Relay IN2 unused
 *   No buzzer
 *
 * Configure the URL, device API key, customerId, meterId, and Wi-Fi credentials
 * before flashing. Store credentials privately; do not commit real secrets.
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>
#include <HardwareSerial.h>
#include <DHT.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <math.h>

// ---------------- USER CONFIGURATION ----------------
static const char* WIFI_SSID = "YOUR_WIFI_SSID";
static const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
static const char* APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxIegsiM_A3M4EtqOHTnHDCPv8pI4GR36mihZWrn5VL0qJaEr_94VPySe-LPxZzHgCzig/exec";
static const char* DEVICE_API_KEY = "YOUR_DEVICE_API_KEY";
static const char* CUSTOMER_ID = "PLG-001";
static const char* DEVICE_ID = "ESP32-001";

static const float DEFAULT_TARIFF_RP_PER_KWH = 605.0f; // Tarif pelanggan (Rp/kWh)
// Konsumsi energi selama periode tagihan, BUKAN energi kumulatif sejak PZEM dinyalakan.
// Perbarui nilai ini sesuai rekap periode tagihan dari dashboard/Google Sheets.
static const float BILLING_PERIOD_ENERGY_KWH = 12.0f;
static const bool RELAY_ACTIVE_LOW = true;             // Verify with LOW-VOLTAGE test
static const bool ENABLE_RELAY_OUTPUT = true; // Relay output is enabled; keep startup and fault handling fail-safe.
static const uint8_t RELAY_PIN = 25;
static const uint8_t DHT_PIN = 4;
static const uint8_t DHT_TYPE = DHT11;
static const uint8_t LCD_ADDRESS = 0x27;               // Change to 0x3F if scanner finds 0x3F

static const uint32_t SENSOR_INTERVAL_MS = 2500;
static const uint32_t READING_UPLOAD_INTERVAL_MS = 60000;
static const uint32_t RELAY_POLL_INTERVAL_MS = 1500;
static const uint32_t RELAY_HEARTBEAT_INTERVAL_MS = 4000;
static const uint32_t WIFI_RETRY_INTERVAL_MS = 15000;
static const uint32_t LCD_PAGE_INTERVAL_MS = 3000;
static const uint32_t HTTP_TIMEOUT_MS = 10000;

// ---------------- DEVICES ----------------
HardwareSerial PZEMSerial(2);
static const uint8_t PZEM_ADDRESS = 0xF8;
static const uint32_t PZEM_BAUD_RATE = 9600;
static const uint32_t PZEM_RESPONSE_TIMEOUT_MS = 500;

uint16_t pzemCRC16(const uint8_t* data, size_t length) {
  uint16_t crc = 0xFFFF;
  for (size_t i = 0; i < length; i++) {
    crc ^= data[i];
    for (uint8_t bit = 0; bit < 8; bit++)
      crc = (crc & 1) ? (crc >> 1) ^ 0xA001 : (crc >> 1);
  }
  return crc;
}

bool readPZEMModbus(float& voltage, float& current, float& power,
                    float& energy, float& frequency, float& powerFactor) {
  uint8_t request[8] = {PZEM_ADDRESS, 0x04, 0x00, 0x00, 0x00, 0x0A, 0, 0};
  const uint16_t crc = pzemCRC16(request, 6);
  request[6] = static_cast<uint8_t>(crc);
  request[7] = static_cast<uint8_t>(crc >> 8);

  while (PZEMSerial.available() > 0) PZEMSerial.read();
  PZEMSerial.write(request, sizeof(request));
  PZEMSerial.flush();

  uint8_t response[25];
  size_t received = 0;
  const uint32_t started = millis();
  while (received < sizeof(response) &&
         static_cast<uint32_t>(millis() - started) < PZEM_RESPONSE_TIMEOUT_MS) {
    while (PZEMSerial.available() > 0 && received < sizeof(response))
      response[received++] = static_cast<uint8_t>(PZEMSerial.read());
    if (received < sizeof(response)) yield();
  }

  if (received != sizeof(response) || response[0] != PZEM_ADDRESS ||
      response[1] != 0x04 || response[2] != 0x14) return false;

  const uint16_t receivedCrc = static_cast<uint16_t>(response[23]) |
    (static_cast<uint16_t>(response[24]) << 8);
  if (pzemCRC16(response, 23) != receivedCrc) return false;

  const uint16_t voltageRaw = (uint16_t(response[3]) << 8) | response[4];
  const uint32_t currentRaw = (uint32_t(response[8]) << 24) |
    (uint32_t(response[7]) << 16) | (uint32_t(response[5]) << 8) | response[6];
  const uint32_t powerRaw = (uint32_t(response[12]) << 24) |
    (uint32_t(response[11]) << 16) | (uint32_t(response[9]) << 8) | response[10];
  const uint32_t energyRaw = (uint32_t(response[16]) << 24) |
    (uint32_t(response[15]) << 16) | (uint32_t(response[13]) << 8) | response[14];
  const uint16_t frequencyRaw = (uint16_t(response[17]) << 8) | response[18];
  const uint16_t pfRaw = (uint16_t(response[19]) << 8) | response[20];

  voltage = voltageRaw / 10.0f;
  current = currentRaw / 1000.0f;
  power = powerRaw / 10.0f;
  energy = energyRaw / 1000.0f;
  frequency = frequencyRaw / 10.0f;
  powerFactor = pfRaw / 100.0f;

  return isFiniteValue(voltage) && isFiniteValue(current) &&
    isFiniteValue(power) && isFiniteValue(energy) &&
    isFiniteValue(frequency) && isFiniteValue(powerFactor) &&
    voltage >= 0 && current >= 0 && power >= 0 && energy >= 0 &&
    frequency >= 0 && powerFactor >= 0 && powerFactor <= 1;
}
DHT dht(DHT_PIN, DHT_TYPE);
LiquidCrystal_I2C lcd(LCD_ADDRESS, 16, 2);

// ---------------- SENSOR STATE ----------------
float voltageV = NAN;
float currentA = NAN;
float powerW = NAN;
float energyKwh = NAN;
float frequencyHz = NAN;
float powerFactor = NAN;
float temperatureC = NAN;
float humidityPct = NAN;

bool electricalDataValid = false;
bool temperatureDataValid = false;
uint32_t lastSensorReadMs = 0;
uint32_t lastReadingUploadMs = 0;
uint32_t lastRelayPollMs = 0;
uint32_t lastRelayStatusReportMs = 0;
uint32_t lastWifiAttemptMs = 0;
uint32_t lastLcdPageMs = 0;
uint32_t lastDashboardSyncMs = 0;
uint8_t lcdPage = 0;
static const uint32_t DASHBOARD_SYNC_INTERVAL_MS = 30000;

// Snapshot dari endpoint dashboard yang sama dengan web.
bool dashboardDataValid = false;
bool dashboardOnline = false;
bool dashboardTemperatureValid = false;
float dashboardVoltageV = NAN, dashboardCurrentA = NAN, dashboardPowerW = NAN;
float dashboardPowerFactor = NAN, dashboardFrequencyHz = NAN;
float dashboardEnergyMonthKwh = NAN, dashboardCostMonthRp = NAN;
float dashboardTariffRpPerKwh = NAN, dashboardTemperatureC = NAN, dashboardHumidityPct = NAN;

// ---------------- RELAY CONFIG FROM SERVER ----------------
struct RelayConfig {
  bool enabled = false;
  String mode = "MANUAL"; // MANUAL or AUTO
  bool alarmVoltageMinEnabled = false;
  bool alarmVoltageMaxEnabled = false;
  bool alarmCurrentMaxEnabled = false;
  bool alarmPowerMaxEnabled = false;
  bool alarmFrequencyMinEnabled = false;
  bool alarmFrequencyMaxEnabled = false;
  bool alarmPowerFactorMinEnabled = false;
  bool alarmTemperatureMaxEnabled = false;
  bool alarmHumidityMinEnabled = false;
  bool alarmHumidityMaxEnabled = false;
  float minVoltageV = 198.0f;
  float maxVoltageV = 231.0f;
  float maxCurrentA = 4.0f;
  float maxPowerW = 800.0f;
  float minFrequencyHz = 49.5f;
  float maxFrequencyHz = 50.5f;
  float minPowerFactor = 0.85f;
  float maxTemperatureC = 30.0f;
  float minHumidityPct = 40.0f;
  float maxHumidityPct = 70.0f;
  bool autoRecover = true;
  uint16_t recoverStableSeconds = 60;
};

RelayConfig relayConfig;
bool relayConfigValid = false;
bool relayActualOn = false;
String relayDecisionState = "UNKNOWN";
String relayDecisionReason = "MENUNGGU_DATA_PZEM";
String manualRequestedState = "OFF";
bool autoTripLatched = true; // Safe startup: AUTO must complete stable period before ON
uint16_t relayAlarmLatchMask = 0;
uint32_t normalSinceMs = 0;
String relayReason = "BOOT_SAFE_OFF";
String lastProcessedCommandId = "";
String lastProcessedCommandDetail = "";
bool relayStatusNeedsReport = true;

// ---------------- UTILITIES ----------------
bool isFiniteValue(float value) {
  return !isnan(value) && !isinf(value);
}

String boolText(bool value) {
  return value ? "ON" : "OFF";
}

void setRelayOutput(bool on, const String& reason) {
  // Output is permitted only when the firmware feature, server configuration,
  // and current control decision all allow it. Startup and invalid states remain OFF.
  if (!ENABLE_RELAY_OUTPUT || !relayConfigValid || !relayConfig.enabled) on = false;

  const String effectiveReason = !ENABLE_RELAY_OUTPUT
    ? "RELAY_OUTPUT_DISABLED_IN_FIRMWARE"
    : (!relayConfigValid ? "RELAY_CONFIG_NOT_VALID" :
       (!relayConfig.enabled ? "RELAY_CONTROL_DISABLED" : reason));
  const bool changed = (relayActualOn != on) || (relayReason != effectiveReason);
  relayActualOn = on;
  relayReason = effectiveReason;

  const uint8_t onLevel = RELAY_ACTIVE_LOW ? LOW : HIGH;
  const uint8_t offLevel = RELAY_ACTIVE_LOW ? HIGH : LOW;
  digitalWrite(RELAY_PIN, on ? onLevel : offLevel);

  if (changed) {
    relayStatusNeedsReport = true;
    Serial.printf("[RELAY] %s | %s\n", boolText(relayActualOn).c_str(), relayReason.c_str());
  }
}

void safeRelayStartup() {
  // Preload OFF level before setting the GPIO as an output to reduce boot glitches.
  const uint8_t offLevel = RELAY_ACTIVE_LOW ? HIGH : LOW;
  digitalWrite(RELAY_PIN, offLevel);
  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, offLevel);
  relayActualOn = false;
  relayReason = "BOOT_SAFE_OFF";
  relayStatusNeedsReport = true;
}

bool wifiConnectionInProgress = false;
uint32_t wifiConnectStartedMs = 0;
static const uint32_t WIFI_CONNECT_TIMEOUT_MS = 20000;

void connectWiFiNonBlocking() {
  const uint32_t now = millis();
  if (WiFi.status() == WL_CONNECTED) {
    wifiConnectionInProgress = false;
    return;
  }

  // Jangan panggil WiFi.begin() berulang ketika ESP32 masih mengasosiasikan AP.
  if (wifiConnectionInProgress) {
    if (now - wifiConnectStartedMs < WIFI_CONNECT_TIMEOUT_MS) return;

    Serial.println("[WiFi] Timeout koneksi; menyiapkan percobaan ulang.");
    WiFi.disconnect(false, false);
    wifiConnectionInProgress = false;
    lastWifiAttemptMs = now;
    return;
  }

  if (now - lastWifiAttemptMs < WIFI_RETRY_INTERVAL_MS) return;

  lastWifiAttemptMs = now;
  wifiConnectStartedMs = now;
  wifiConnectionInProgress = true;
  Serial.println("[WiFi] Memulai koneksi ulang...");
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

bool postJson(const String& payload, String& response) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[HTTP] Dilewati: Wi-Fi belum terhubung.");
    return false;
  }
  if (String(DEVICE_API_KEY).startsWith("YOUR_") ||
      String(DEVICE_API_KEY).startsWith("REPLACE_")) {
    Serial.println("[HTTP] DEVICE_API_KEY belum diisi. Samakan dengan Script Property DEVICE_API_KEY.");
    return false;
  }
  if (String(APPS_SCRIPT_URL).indexOf("YOUR_DEPLOYMENT_ID") >= 0) {
    Serial.println("[HTTP] APPS_SCRIPT_URL masih placeholder.");
    return false;
  }

  // Apps Script menerima POST di /exec lalu mengalihkan hasil ContentService
  // ke script.googleusercontent.com. Pada redirect 302, endpoint hasil harus
  // diambil dengan GET, bukan POST ulang. Setiap hop memakai TLS client baru.
  String currentUrl = String(APPS_SCRIPT_URL);
  bool sendPost = true;
  const char* redirectHeaders[] = {"Location"};

  for (uint8_t hop = 0; hop < 5; hop++) {
    WiFiClientSecure secureClient;
    secureClient.setInsecure();
    secureClient.setTimeout(HTTP_TIMEOUT_MS);

    HTTPClient http;
    http.setConnectTimeout(HTTP_TIMEOUT_MS);
    http.setTimeout(HTTP_TIMEOUT_MS);
    http.setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS);
    http.setReuse(false);
    http.collectHeaders(redirectHeaders, 1);

    if (!http.begin(secureClient, currentUrl)) {
      Serial.println("[HTTP] Gagal membuka URL hop " + String(hop) + ".");
      return false;
    }

    http.addHeader("Connection", "close");
    int statusCode;
    if (sendPost) {
      http.addHeader("Content-Type", "application/json");
      statusCode = http.POST(payload);
      Serial.println("[HTTP] POST ke endpoint Apps Script.");
    } else {
      statusCode = http.GET();
      Serial.println("[HTTP] GET ke URL hasil redirect.");
    }

    String location = http.header("Location");
    if (statusCode > 0) {
      response = http.getString();
      Serial.printf("[HTTP] Hop %u respons: %d\n", hop + 1, statusCode);
    } else {
      Serial.printf("[HTTP] Hop %u gagal (%d): %s\n",
        hop + 1, statusCode, http.errorToString(statusCode).c_str());
      http.end();
      return false;
    }
    http.end();

    if (statusCode == 301 || statusCode == 302 || statusCode == 303 ||
        statusCode == 307 || statusCode == 308) {
      if (!location.length()) {
        Serial.println("[HTTP] Redirect tanpa header Location.");
        return false;
      }
      if (location.indexOf("script.google.com/macros/s/") >= 0 &&
          location.endsWith("/exec")) {
        Serial.println("[HTTP] Redirect kembali ke /exec terdeteksi; hentikan loop.");
        return false;
      }
      Serial.println("[HTTP] Mengikuti redirect hop " + String(hop + 1));
      currentUrl = location;
      sendPost = false; // Hasil ContentService diambil dengan GET.
      continue;
    }

    if (statusCode < 200 || statusCode >= 300) {
      if (response.length()) {
        String preview = response.substring(0, 220);
        preview.replace("\n", " ");
        preview.replace("\r", " ");
        Serial.println("[HTTP] Body awal: " + preview);
      }
      return false;
    }

    if (response.length()) {
      DynamicJsonDocument responseDoc(2048);
      if (deserializeJson(responseDoc, response) == DeserializationError::Ok &&
          responseDoc.containsKey("ok") && !(responseDoc["ok"] | false)) {
        Serial.println("[HTTP] API menolak permintaan: " +
          String((const char*)(responseDoc["message"] | "unknown error")));
        return false;
      }
    }
    return true;
  }

  Serial.println("[HTTP] Batas redirect 5 hop terlampaui.");
  return false;
}

bool fetchDashboardSnapshot() {
  if (WiFi.status() != WL_CONNECTED) return false;

  DynamicJsonDocument request(384);
  request["fn"] = "getLcdDashboard";
  request["apiKey"] = DEVICE_API_KEY;
  request["customerId"] = CUSTOMER_ID;
  request["deviceId"] = DEVICE_ID;

  String payload, response;
  serializeJson(request, payload);
  if (!postJson(payload, response)) {
    Serial.println("[LCD-DASHBOARD] Sinkronisasi gagal; memakai snapshot terakhir.");
    return false;
  }

  DynamicJsonDocument reply(3072);
  const DeserializationError err = deserializeJson(reply, response);
  if (err || !(reply["ok"] | false)) {
    Serial.println("[LCD-DASHBOARD] Respons dashboard tidak valid.");
    if (!err) Serial.println("[LCD-DASHBOARD] " + String((const char*)(reply["message"] | "unknown error")));
    return false;
  }

  JsonObjectConst latest = reply["latest"].as<JsonObjectConst>();
  if (latest.isNull()) {
    Serial.println("[LCD-DASHBOARD] Belum ada pembacaan pada dashboard.");
    dashboardDataValid = false;
    return false;
  }

  dashboardVoltageV = latest["voltageV"] | NAN;
  dashboardCurrentA = latest["currentA"] | NAN;
  dashboardPowerW = latest["powerW"] | NAN;
  dashboardPowerFactor = latest["powerFactor"] | NAN;
  dashboardFrequencyHz = latest["frequencyHz"] | NAN;
  dashboardEnergyMonthKwh = reply["energyMonthKwh"] | 0.0f;
  dashboardCostMonthRp = reply["costMonthRp"] | 0.0f;
  dashboardTariffRpPerKwh = reply["tariffRpPerKwh"] | 0.0f;
  dashboardOnline = reply["online"] | false;

  JsonObjectConst temp = reply["temperature"].as<JsonObjectConst>();
  dashboardTemperatureValid = !temp.isNull();
  if (dashboardTemperatureValid) {
    dashboardTemperatureC = temp["temperatureC"] | NAN;
    dashboardHumidityPct = temp["humidityPct"] | NAN;
  }

  dashboardDataValid = isFiniteValue(dashboardVoltageV) &&
    isFiniteValue(dashboardCurrentA) && isFiniteValue(dashboardPowerW) &&
    isFiniteValue(dashboardPowerFactor) && isFiniteValue(dashboardFrequencyHz) &&
    isFiniteValue(dashboardEnergyMonthKwh) && isFiniteValue(dashboardCostMonthRp);
  if (dashboardDataValid) {
    Serial.printf("[LCD-DASHBOARD] Sync OK Ebulan=%.3f kWh Biaya=%.0f Tarif=%.0f Online=%s\n",
      dashboardEnergyMonthKwh, dashboardCostMonthRp, dashboardTariffRpPerKwh,
      dashboardOnline ? "YES" : "NO");
  }
  return dashboardDataValid;
}

String makeDeviceBaseJson(const char* action) {
  DynamicJsonDocument doc(512);
  doc["apiKey"] = DEVICE_API_KEY;
  doc["customerId"] = CUSTOMER_ID;
  doc["deviceId"] = DEVICE_ID;
  if (action && strlen(action)) doc["relayAction"] = action;
  String payload;
  serializeJson(doc, payload);
  return payload;
}

// ---------------- SENSOR ACQUISITION ----------------
void readSensors() {
  float v = NAN, a = NAN, w = NAN, e = NAN, hz = NAN, pf = NAN;
  electricalDataValid = readPZEMModbus(v, a, w, e, hz, pf);

  voltageV = electricalDataValid ? v : NAN;
  currentA = electricalDataValid ? a : NAN;
  powerW = electricalDataValid ? w : NAN;
  energyKwh = electricalDataValid ? e : NAN;
  frequencyHz = electricalDataValid ? hz : NAN;
  powerFactor = electricalDataValid ? pf : NAN;

  if (!electricalDataValid)
    Serial.println("[PZEM] Respons tidak valid/timeout/CRC gagal; data listrik invalid.");

  const float t = dht.readTemperature();
  const float h = dht.readHumidity();
  temperatureC = t;
  humidityPct = h;
  temperatureDataValid = isFiniteValue(t) && isFiniteValue(h) &&
    t >= 0 && t <= 50 && h >= 0 && h <= 100;

  Serial.printf("[SENSOR] valid=%s V=%.2f A=%.3f W=%.2f kWh=%.3f Hz=%.2f PF=%.2f T=%.1f H=%.1f\n",
    electricalDataValid ? "YES" : "NO", voltageV, currentA, powerW,
    energyKwh, frequencyHz, powerFactor, temperatureC, humidityPct);
}

// ---------------- RELAY STATUS REPORTING ----------------
void reportRelayStatusIfNeeded() {
  if (WiFi.status() != WL_CONNECTED) return;
  const bool heartbeatDue = (millis() - lastRelayStatusReportMs) >= RELAY_HEARTBEAT_INTERVAL_MS;
  if (!relayStatusNeedsReport && !heartbeatDue) return;
  DynamicJsonDocument doc(768);
  doc["apiKey"] = DEVICE_API_KEY;
  doc["customerId"] = CUSTOMER_ID;
  doc["deviceId"] = DEVICE_ID;
  doc["relayAction"] = "status";
  doc["outputState"] = relayActualOn ? "ON" : "OFF";
  doc["detail"] = relayReason;
  doc["decisionState"] = relayDecisionState;
  doc["decisionReason"] = relayDecisionReason;
  if (electricalDataValid) {
    doc["voltageV"] = voltageV; doc["currentA"] = currentA;
    doc["powerW"] = powerW; doc["energyKwh"] = energyKwh;
    doc["frequencyHz"] = frequencyHz; doc["powerFactor"] = powerFactor;
  }
  if (temperatureDataValid) {
    doc["temperatureC"] = temperatureC; doc["humidityPct"] = humidityPct;
  }
  String payload, response;
  serializeJson(doc, payload);
  if (postJson(payload, response)) { relayStatusNeedsReport = false; lastRelayStatusReportMs = millis(); }
}

void acknowledgeRelayCommand(const String& commandId, const String& detail) {
  DynamicJsonDocument doc(768);
  doc["apiKey"] = DEVICE_API_KEY;
  doc["customerId"] = CUSTOMER_ID;
  doc["deviceId"] = DEVICE_ID;
  doc["relayAction"] = "ack";
  doc["commandId"] = commandId;
  doc["outputState"] = relayActualOn ? "ON" : "OFF";
  doc["detail"] = detail;
  doc["decisionState"] = relayDecisionState;
  doc["decisionReason"] = relayDecisionReason;
  if (electricalDataValid) {
    doc["voltageV"] = voltageV; doc["currentA"] = currentA;
    doc["powerW"] = powerW; doc["energyKwh"] = energyKwh;
    doc["frequencyHz"] = frequencyHz; doc["powerFactor"] = powerFactor;
  }
  if (temperatureDataValid) {
    doc["temperatureC"] = temperatureC; doc["humidityPct"] = humidityPct;
  }
  String payload, response;
  serializeJson(doc, payload);
  postJson(payload, response);
}

// ---------------- SERVER CONFIGURATION / COMMAND POLLING ----------------
void applyRelayConfig(JsonObjectConst cfg) {
  RelayConfig next;
  next.enabled = cfg["enabled"] | false;
  next.mode = String((const char*)(cfg["mode"] | "MANUAL"));
  next.alarmVoltageMinEnabled = cfg["alarmVoltageMinEnabled"] | false;
  next.alarmVoltageMaxEnabled = cfg["alarmVoltageMaxEnabled"] | false;
  next.alarmCurrentMaxEnabled = cfg["alarmCurrentMaxEnabled"] | false;
  next.alarmPowerMaxEnabled = cfg["alarmPowerMaxEnabled"] | false;
  next.alarmFrequencyMinEnabled = cfg["alarmFrequencyMinEnabled"] | false;
  next.alarmFrequencyMaxEnabled = cfg["alarmFrequencyMaxEnabled"] | false;
  next.alarmPowerFactorMinEnabled = cfg["alarmPowerFactorMinEnabled"] | false;
  next.alarmTemperatureMaxEnabled = cfg["alarmTemperatureMaxEnabled"] | false;
  next.alarmHumidityMinEnabled = cfg["alarmHumidityMinEnabled"] | false;
  next.alarmHumidityMaxEnabled = cfg["alarmHumidityMaxEnabled"] | false;
  next.minVoltageV = cfg["minVoltageV"] | 198.0f;
  next.maxVoltageV = cfg["maxVoltageV"] | 231.0f;
  next.maxCurrentA = cfg["maxCurrentA"] | 4.0f;
  next.maxPowerW = cfg["maxPowerW"] | 800.0f;
  next.minFrequencyHz = cfg["minFrequencyHz"] | 49.5f;
  next.maxFrequencyHz = cfg["maxFrequencyHz"] | 50.5f;
  next.minPowerFactor = cfg["minPowerFactor"] | 0.85f;
  next.maxTemperatureC = cfg["maxTemperatureC"] | 30.0f;
  next.minHumidityPct = cfg["minHumidityPct"] | 40.0f;
  next.maxHumidityPct = cfg["maxHumidityPct"] | 70.0f;
  next.autoRecover = cfg["autoRecover"] | true;
  next.recoverStableSeconds = cfg["recoverStableSeconds"] | 60;

  const bool configChanged = relayConfigValid && (
    next.enabled != relayConfig.enabled || next.mode != relayConfig.mode ||
    next.alarmVoltageMinEnabled != relayConfig.alarmVoltageMinEnabled ||
    next.alarmVoltageMaxEnabled != relayConfig.alarmVoltageMaxEnabled ||
    next.alarmCurrentMaxEnabled != relayConfig.alarmCurrentMaxEnabled ||
    next.alarmPowerMaxEnabled != relayConfig.alarmPowerMaxEnabled ||
    next.alarmFrequencyMinEnabled != relayConfig.alarmFrequencyMinEnabled ||
    next.alarmFrequencyMaxEnabled != relayConfig.alarmFrequencyMaxEnabled ||
    next.alarmPowerFactorMinEnabled != relayConfig.alarmPowerFactorMinEnabled ||
    next.alarmTemperatureMaxEnabled != relayConfig.alarmTemperatureMaxEnabled ||
    next.alarmHumidityMinEnabled != relayConfig.alarmHumidityMinEnabled ||
    next.alarmHumidityMaxEnabled != relayConfig.alarmHumidityMaxEnabled ||
    next.minVoltageV != relayConfig.minVoltageV || next.maxVoltageV != relayConfig.maxVoltageV ||
    next.maxCurrentA != relayConfig.maxCurrentA || next.maxPowerW != relayConfig.maxPowerW ||
    next.minFrequencyHz != relayConfig.minFrequencyHz || next.maxFrequencyHz != relayConfig.maxFrequencyHz ||
    next.minPowerFactor != relayConfig.minPowerFactor || next.maxTemperatureC != relayConfig.maxTemperatureC ||
    next.minHumidityPct != relayConfig.minHumidityPct || next.maxHumidityPct != relayConfig.maxHumidityPct ||
    next.autoRecover != relayConfig.autoRecover ||
    next.recoverStableSeconds != relayConfig.recoverStableSeconds
  );
  relayConfig = next;
  relayConfigValid = true;

  if (!relayConfig.enabled) {
    autoTripLatched = true;
    normalSinceMs = 0;
    manualRequestedState = "OFF";
    setRelayDecision("OFF", "RELAY_CONTROL_DISABLED");
    setRelayOutput(false, "RELAY_DISABLED");
  } else if (relayConfig.mode != "MANUAL" && relayConfig.mode != "AUTO") {
    autoTripLatched = true;
    normalSinceMs = 0;
    manualRequestedState = "OFF";
    setRelayDecision("UNKNOWN", "INVALID_RELAY_MODE");
    setRelayOutput(false, "INVALID_RELAY_MODE");
  } else if (configChanged) {
    // Any interlock/configuration change invalidates the previous ON permission and stability timer.
    autoTripLatched = true;
    normalSinceMs = 0;
    manualRequestedState = "OFF";
    setRelayDecision("OFF", "MODE_CHANGED_SAFE_OFF");
    setRelayOutput(false, "MODE_CHANGED_SAFE_OFF");
  }

  Serial.printf("[RELAY CONFIG] enabled=%s mode=%s currentTrip=%s tempTrip=%s stable=%us\n",
    boolText(relayConfig.enabled).c_str(), relayConfig.mode.c_str(),
    boolText(relayConfig.alarmCurrentMaxEnabled).c_str(),
    boolText(relayConfig.alarmTemperatureMaxEnabled).c_str(),
    relayConfig.recoverStableSeconds);
}

void processManualCommand(JsonObjectConst command) {
  if (command.isNull()) return;
  const String id = String((const char*)(command["commandId"] | ""));
  const String mode = String((const char*)(command["mode"] | ""));
  const String desired = String((const char*)(command["desiredState"] | ""));
  if (!id.length()) return;

  // Retry acknowledgements when the first HTTP response was lost.
  if (id == lastProcessedCommandId) {
    acknowledgeRelayCommand(id, lastProcessedCommandDetail);
    return;
  }
  lastProcessedCommandId = id;

  if (mode == "AUTO_RESET") {
    String resetAlarmReason;
    const bool resetBlocked = evaluateSelectedRelayAlarms(resetAlarmReason);
    const uint32_t stableMs = (uint32_t)relayConfig.recoverStableSeconds * 1000UL;
    const bool stable = normalSinceMs != 0 && (millis() - normalSinceMs) >= stableMs;
    if (!relayConfigValid || !relayConfig.enabled || relayConfig.mode != "AUTO" ||
        relayConfig.autoRecover || resetBlocked || !stable || !autoTripLatched) {
      lastProcessedCommandDetail = "RESET ditolak: mode AUTO, pemulihan manual, sensor normal, dan waktu stabil wajib terpenuhi. " + resetAlarmReason;
      setRelayDecision("OFF", "AUTO_MANUAL_RESET_REJECTED");
      setRelayOutput(false, "AUTO_MANUAL_RESET_REJECTED");
    } else {
      autoTripLatched = false;
      setRelayDecision("ON", "AUTO_MANUAL_RESET_ACCEPTED");
      setRelayOutput(true, "AUTO_MANUAL_RESET_ACCEPTED");
      lastProcessedCommandDetail = "RESET diterima setelah kondisi normal stabil.";
    }
    acknowledgeRelayCommand(id, lastProcessedCommandDetail);
    return;
  }

  if (desired != "ON" && desired != "OFF") {
    manualRequestedState = "OFF";
    setRelayDecision("OFF", "INVALID_MANUAL_COMMAND_STATE");
    setRelayOutput(false, "INVALID_MANUAL_COMMAND_STATE");
    lastProcessedCommandDetail = "Ditolak: state perintah harus ON atau OFF.";
    acknowledgeRelayCommand(id, lastProcessedCommandDetail);
    return;
  }

  if (desired == "OFF") {
    manualRequestedState = "OFF";
    setRelayDecision("OFF", "WEBSITE_MANUAL_OFF_REQUEST");
    setRelayOutput(false, "WEBSITE_MANUAL_OFF");
    lastProcessedCommandDetail = "OFF diminta dari website; " + relayDecisionReason;
    acknowledgeRelayCommand(id, lastProcessedCommandDetail);
    return;
  }

  if (!relayConfigValid || !relayConfig.enabled || relayConfig.mode != "MANUAL" || mode != "MANUAL") {
    manualRequestedState = "OFF";
    setRelayDecision("OFF", "MANUAL_COMMAND_REJECTED");
    setRelayOutput(false, "MANUAL_COMMAND_REJECTED_SAFE_OFF");
    lastProcessedCommandDetail = "Ditolak: konfigurasi tidak aktif atau mode bukan MANUAL.";
    acknowledgeRelayCommand(id, lastProcessedCommandDetail);
    return;
  }

  manualRequestedState = "ON";
  String alarmReason;
  if (evaluateSelectedRelayAlarms(alarmReason)) {
    manualRequestedState = "OFF"; // Require a fresh manual ON after an alarm clears.
    setRelayDecision("OFF", "MANUAL_ON_BLOCKED:" + alarmReason);
    setRelayOutput(false, "MANUAL_ON_BLOCKED");
    lastProcessedCommandDetail = "ON ditolak oleh interlock data PZEM: " + alarmReason;
    acknowledgeRelayCommand(id, lastProcessedCommandDetail);
    return;
  }

  setRelayDecision("ON", "MANUAL_ON_ALLOWED_BY_LATEST_PZEM");
  setRelayOutput(true, "WEBSITE_MANUAL_ON");
  lastProcessedCommandDetail = "ON diminta dari website; " + relayDecisionReason;
  if (!ENABLE_RELAY_OUTPUT) {
    lastProcessedCommandDetail += "; output dinonaktifkan melalui konfigurasi firmware.";
  }
  acknowledgeRelayCommand(id, lastProcessedCommandDetail);
}

void pollRelayServer() {
  if (WiFi.status() != WL_CONNECTED) return;
  DynamicJsonDocument request(512);
  request["apiKey"] = DEVICE_API_KEY;
  request["customerId"] = CUSTOMER_ID;
  request["deviceId"] = DEVICE_ID;
  request["relayAction"] = "poll";

  String payload, response;
  serializeJson(request, payload);
  if (!postJson(payload, response)) return;

  DynamicJsonDocument reply(4096);
  const DeserializationError err = deserializeJson(reply, response);
  if (err || !(reply["ok"] | false)) {
    Serial.println("[RELAY] Respons polling tidak valid.");
    return;
  }

  if (reply["relayConfig"].is<JsonObjectConst>()) {
    applyRelayConfig(reply["relayConfig"].as<JsonObjectConst>());
  }

  if (reply["command"].is<JsonObjectConst>()) {
    processManualCommand(reply["command"].as<JsonObjectConst>());
  }
  reportRelayStatusIfNeeded();
}

// ---------------- LOCAL AUTOMATIC ALARM CONTROL ----------------
bool evaluateSelectedRelayAlarms(String &reason) {
  reason = "";
  const bool dhtSelected = relayConfig.alarmTemperatureMaxEnabled ||
    relayConfig.alarmHumidityMinEnabled || relayConfig.alarmHumidityMaxEnabled;
  if (!electricalDataValid || (dhtSelected && !temperatureDataValid)) {
    reason = "SENSOR_INVALID";
    return true;
  }

  // Per-parameter hysteresis is aligned with the Telegram recovery rules.
  struct AlarmRule { uint16_t bit; bool enabled; bool abnormal; bool recovered; const char* label; };
  AlarmRule rules[] = {
    {1u<<0, relayConfig.alarmVoltageMinEnabled, voltageV < relayConfig.minVoltageV, voltageV >= relayConfig.minVoltageV + 2.0f, "VOLTAGE_LOW"},
    {1u<<1, relayConfig.alarmVoltageMaxEnabled, voltageV > relayConfig.maxVoltageV, voltageV <= relayConfig.maxVoltageV - 2.0f, "VOLTAGE_HIGH"},
    {1u<<2, relayConfig.alarmCurrentMaxEnabled, currentA > relayConfig.maxCurrentA, currentA <= relayConfig.maxCurrentA * 0.95f, "CURRENT_HIGH"},
    {1u<<3, relayConfig.alarmPowerMaxEnabled, powerW > relayConfig.maxPowerW, powerW <= relayConfig.maxPowerW * 0.95f, "POWER_HIGH"},
    {1u<<4, relayConfig.alarmFrequencyMinEnabled, frequencyHz < relayConfig.minFrequencyHz, frequencyHz >= relayConfig.minFrequencyHz + 0.1f, "FREQUENCY_LOW"},
    {1u<<5, relayConfig.alarmFrequencyMaxEnabled, frequencyHz > relayConfig.maxFrequencyHz, frequencyHz <= relayConfig.maxFrequencyHz - 0.1f, "FREQUENCY_HIGH"},
    {1u<<6, relayConfig.alarmPowerFactorMinEnabled, powerFactor < relayConfig.minPowerFactor, powerFactor >= relayConfig.minPowerFactor + 0.03f, "POWER_FACTOR_LOW"},
    {1u<<7, relayConfig.alarmTemperatureMaxEnabled, temperatureC > relayConfig.maxTemperatureC, temperatureC <= relayConfig.maxTemperatureC - 1.0f, "TEMPERATURE_HIGH"},
    {1u<<8, relayConfig.alarmHumidityMinEnabled, humidityPct < relayConfig.minHumidityPct, humidityPct >= relayConfig.minHumidityPct + 2.0f, "HUMIDITY_LOW"},
    {1u<<9, relayConfig.alarmHumidityMaxEnabled, humidityPct > relayConfig.maxHumidityPct, humidityPct <= relayConfig.maxHumidityPct - 2.0f, "HUMIDITY_HIGH"}
  };
  for (const AlarmRule &rule : rules) {
    if (!rule.enabled) { relayAlarmLatchMask &= ~rule.bit; continue; }
    if (rule.abnormal) relayAlarmLatchMask |= rule.bit;
    else if (rule.recovered) relayAlarmLatchMask &= ~rule.bit;
    if (relayAlarmLatchMask & rule.bit) {
      if (reason.length()) reason += "+";
      reason += rule.label;
    }
  }
  return reason.length() > 0;
}

void setRelayDecision(const String& state, const String& reason) {
  if (relayDecisionState != state || relayDecisionReason != reason) {
    relayDecisionState = state;
    relayDecisionReason = reason;
    relayStatusNeedsReport = true;
    Serial.printf("[RELAY DECISION] %s | %s\n", state.c_str(), reason.c_str());
  }
}

void evaluateAutomaticRelay() {
  if (!relayConfigValid) {
    setRelayDecision("UNKNOWN", "RELAY_CONFIG_NOT_RECEIVED");
    setRelayOutput(false, "RELAY_CONFIG_NOT_RECEIVED");
    return;
  }
  if (!relayConfig.enabled) {
    setRelayDecision("OFF", "RELAY_CONTROL_DISABLED");
    setRelayOutput(false, "RELAY_DISABLED");
    return;
  }

  String alarmReason;
  const bool blockingAlarm = evaluateSelectedRelayAlarms(alarmReason);

  if (relayConfig.mode == "MANUAL") {
    if (manualRequestedState != "ON") {
      setRelayDecision("OFF", "MANUAL_OFF_REQUESTED");
      setRelayOutput(false, "MANUAL_OFF_REQUESTED");
      return;
    }
    if (blockingAlarm) {
      manualRequestedState = "OFF"; // Do not automatically re-energize after a manual-mode trip.
      setRelayDecision("OFF", "MANUAL_ON_BLOCKED:" + alarmReason);
      setRelayOutput(false, "MANUAL_ON_BLOCKED");
      return;
    }
    setRelayDecision("ON", "MANUAL_ON_ALLOWED_BY_LATEST_PZEM");
    setRelayOutput(true, "MANUAL_ON_REQUESTED");
    return;
  }

  if (relayConfig.mode != "AUTO") {
    setRelayDecision("UNKNOWN", "INVALID_RELAY_MODE");
    setRelayOutput(false, "INVALID_RELAY_MODE");
    return;
  }

  if (blockingAlarm) {
    autoTripLatched = true;
    normalSinceMs = 0;
    setRelayDecision("OFF", "AUTO_ALARM:" + alarmReason);
    setRelayOutput(false, "AUTO_ALARM");
    return;
  }

  if (normalSinceMs == 0) normalSinceMs = millis();
  const uint32_t stableMs = (uint32_t)relayConfig.recoverStableSeconds * 1000UL;
  const bool stable = (millis() - normalSinceMs) >= stableMs;

  if (autoTripLatched) {
    if (!relayConfig.autoRecover) {
      setRelayDecision("OFF", "AUTO_NORMAL_MANUAL_RESET_REQUIRED");
      setRelayOutput(false, "AUTO_MANUAL_RESET_REQUIRED");
      return;
    }
    if (!stable) {
      setRelayDecision("WAIT", "AUTO_WAITING_FOR_STABLE_NORMAL_DATA");
      setRelayOutput(false, "AUTO_WAITING_STABLE");
      return;
    }
    autoTripLatched = false;
  }

  setRelayDecision("ON", "AUTO_NORMAL_STABLE");
  setRelayOutput(true, "AUTO_NORMAL_STABLE");
}

// ---------------- CLOUD READING UPLOAD ----------------
void uploadReading() {
  if (WiFi.status() != WL_CONNECTED || !electricalDataValid) return;
  DynamicJsonDocument doc(1024);
  doc["apiKey"] = DEVICE_API_KEY;
  doc["customerId"] = CUSTOMER_ID;
  doc["deviceId"] = DEVICE_ID;
  doc["timestamp"] = ""; // Server timestamp is used if this field is empty.
  doc["voltageV"] = voltageV;
  doc["currentA"] = currentA;
  doc["powerW"] = powerW;
  doc["energyKwh"] = energyKwh;
  doc["frequencyHz"] = frequencyHz;
  doc["powerFactor"] = powerFactor;
  if (temperatureDataValid) {
    doc["temperatureC"] = temperatureC;
    doc["humidityPct"] = humidityPct;
  }
  doc["source"] = "ESP32-kWhKu-RelayPrototype";

  String payload, response;
  serializeJson(doc, payload);
  if (postJson(payload, response)) {
    Serial.println("[CLOUD] Pembacaan berhasil dikirim.");
  } else {
    Serial.println("[CLOUD] Pengiriman pembacaan gagal.");
  }
}

// ---------------- LCD ----------------
void printLcdLine(uint8_t row, const String& value) {
  lcd.setCursor(0, row);
  String line = value.substring(0, 16);
  lcd.print(line);
  for (uint8_t i = line.length(); i < 16; i++) lcd.print(' ');
}

String lcdStatusText() {
  if (!electricalDataValid) return "Sensor Error";
  const bool dhtSelected = relayConfig.alarmTemperatureMaxEnabled ||
    relayConfig.alarmHumidityMinEnabled || relayConfig.alarmHumidityMaxEnabled;
  if (dhtSelected && !temperatureDataValid) return "Sensor Error";
  String alarmReason;
  return evaluateSelectedRelayAlarms(alarmReason) ? "ALARM" : "Normal";
}

void updateLcd() {
  lcd.clear();
  if (!dashboardDataValid) {
    printLcdLine(0, "Dashboard sync...");
    printLcdLine(1, WiFi.status() == WL_CONNECTED ? "Menunggu data" : "Wi-Fi Offline");
    return;
  }

  switch (lcdPage) {
    case 0:
      printLcdLine(0, "V:" + String(dashboardVoltageV, 1) + " A:" + String(dashboardCurrentA, 2));
      printLcdLine(1, "P:" + String(dashboardPowerW, 1) + " PF:" + String(dashboardPowerFactor, 2));
      break;

    case 1:
      printLcdLine(0, "Energi:" + String(dashboardEnergyMonthKwh, 2) + "kWh");
      printLcdLine(1, "Biaya:Rp" + String((unsigned long)(dashboardCostMonthRp + 0.5f)));
      break;

    case 2:
      if (dashboardTemperatureValid) {
        printLcdLine(0, "Suhu:" + String(dashboardTemperatureC, 1) + " C");
        printLcdLine(1, "Kelembapan:" + String(dashboardHumidityPct, 0) + "%");
      } else {
        printLcdLine(0, "Suhu: --");
        printLcdLine(1, "Kelembapan: --");
      }
      break;

    case 3:
      printLcdLine(0, WiFi.status() == WL_CONNECTED ? "Wi-Fi: Online" : "Wi-Fi: Offline");
      printLcdLine(1, String("Dashboard:") + (dashboardOnline ? "Online" : "Offline"));
      break;

    case 4:
      printLcdLine(0, "Mode: " + relayConfig.mode);
      printLcdLine(1, "Relay: " + String(relayActualOn ? "ON" : "OFF"));
      break;

    default:
      printLcdLine(0, "Tarif Rp/kWh");
      printLcdLine(1, String((unsigned long)(dashboardTariffRpPerKwh + 0.5f)));
      break;
  }
  lcdPage = (lcdPage + 1) % 6;
}

// ---------------- SETUP / LOOP ----------------
void setup() {
  Serial.begin(115200);
  delay(150);
  safeRelayStartup();

  PZEMSerial.begin(PZEM_BAUD_RATE, SERIAL_8N1, 16, 17);
  dht.begin();
  Wire.begin(21, 22);
  lcd.init();
  lcd.backlight();
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("kWh-Ku Prototype");
  lcd.setCursor(0, 1);
  lcd.print("Relay SAFE OFF");

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  wifiConnectionInProgress = true;
  wifiConnectStartedMs = millis();
  lastWifiAttemptMs = wifiConnectStartedMs;
  lastSensorReadMs = millis() - SENSOR_INTERVAL_MS;
  lastReadingUploadMs = millis();
  lastRelayPollMs = millis() - RELAY_POLL_INTERVAL_MS;
  lastLcdPageMs = millis();
}

void loop() {
  const uint32_t now = millis();

  connectWiFiNonBlocking();

  if (now - lastSensorReadMs >= SENSOR_INTERVAL_MS) {
    lastSensorReadMs = now;
    readSensors();

    // Bad sensor values always force the prototype output OFF.
    if (!electricalDataValid ||
        (relayConfigValid && (relayConfig.alarmTemperatureMaxEnabled || relayConfig.alarmHumidityMinEnabled || relayConfig.alarmHumidityMaxEnabled) && !temperatureDataValid)) {
      if (relayActualOn) setRelayOutput(false, "SENSOR_INVALID_SAFE_OFF");
    }
    evaluateAutomaticRelay();
  }

  if (WiFi.status() == WL_CONNECTED && now - lastRelayPollMs >= RELAY_POLL_INTERVAL_MS) {
    lastRelayPollMs = now;
    pollRelayServer();
  }

  if (WiFi.status() == WL_CONNECTED &&
      (lastDashboardSyncMs == 0 || now - lastDashboardSyncMs >= DASHBOARD_SYNC_INTERVAL_MS)) {
    lastDashboardSyncMs = now;
    fetchDashboardSnapshot();
  }

  if (now - lastReadingUploadMs >= READING_UPLOAD_INTERVAL_MS) {
    lastReadingUploadMs = now;
    uploadReading();
  }

  reportRelayStatusIfNeeded();

  if (now - lastLcdPageMs >= LCD_PAGE_INTERVAL_MS) {
    lastLcdPageMs = now;
    updateLcd();
  }

  delay(10);
}
