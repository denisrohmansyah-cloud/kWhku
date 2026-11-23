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
#include <PZEM004Tv30.h>
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
static const bool ENABLE_LOW_VOLTAGE_RELAY_TEST = false; // Default locked: do not actuate a mains-connected relay
static const uint8_t RELAY_PIN = 25;
static const uint8_t DHT_PIN = 4;
static const uint8_t DHT_TYPE = DHT11;
static const uint8_t LCD_ADDRESS = 0x27;               // Change to 0x3F if scanner finds 0x3F

static const uint32_t SENSOR_INTERVAL_MS = 2500;
static const uint32_t READING_UPLOAD_INTERVAL_MS = 60000;
static const uint32_t RELAY_POLL_INTERVAL_MS = 5000;
static const uint32_t RELAY_HEARTBEAT_INTERVAL_MS = 5000;
static const uint32_t WIFI_RETRY_INTERVAL_MS = 15000;
static const uint32_t LCD_PAGE_INTERVAL_MS = 3000;
static const uint32_t HTTP_TIMEOUT_MS = 10000;

// ---------------- DEVICES ----------------
HardwareSerial PZEMSerial(2);
PZEM004Tv30 pzem(PZEMSerial, 16, 17);
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
uint8_t lcdPage = 0;

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
  // Output actuation is locked by default. Enable only for isolated extra-low-voltage bench testing.
  if (!ENABLE_LOW_VOLTAGE_RELAY_TEST) {
    on = false;
  }
  // Any invalid configuration or disabled relay always forces output OFF.
  if (!relayConfigValid || !relayConfig.enabled) on = false;

  const String effectiveReason = !ENABLE_LOW_VOLTAGE_RELAY_TEST
    ? "ACTUATION_LOCKED_LOW_VOLTAGE_TEST_ONLY"
    : reason;
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

  WiFiClientSecure secureClient;
  // Google Apps Script memakai HTTPS dan redirect ke host Google lain.
  // setInsecure dipakai agar koneksi tidak gagal karena CA bundle belum dipasang.
  // Gunakan hanya pada jaringan tepercaya; validasi sertifikat dapat ditambahkan kemudian.
  secureClient.setInsecure();
  secureClient.setTimeout(HTTP_TIMEOUT_MS);

  HTTPClient http;
  http.setConnectTimeout(HTTP_TIMEOUT_MS);
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.setFollowRedirects(HTTPC_FORCE_FOLLOW_REDIRECTS);
  http.setReuse(false);

  if (!http.begin(secureClient, APPS_SCRIPT_URL)) {
    Serial.println("[HTTP] Gagal membuka URL Apps Script. Periksa URL dan TLS.");
    return false;
  }

  http.addHeader("Content-Type", "application/json");
  http.addHeader("Connection", "close");
  const int statusCode = http.POST(payload);
  if (statusCode > 0) {
    response = http.getString();
    Serial.printf("[HTTP] Respons server: %d\n", statusCode);
  } else {
    Serial.printf("[HTTP] POST gagal (%d): %s\n",
      statusCode, http.errorToString(statusCode).c_str());
  }
  http.end();

  if (statusCode < 200 || statusCode >= 300) {
    if (response.length()) {
      String preview = response.substring(0, 180);
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
  const float v = pzem.voltage();
  const float a = pzem.current();
  const float w = pzem.power();
  const float e = pzem.energy();
  const float hz = pzem.frequency();
  const float pf = pzem.pf();

  voltageV = v;
  currentA = a;
  powerW = w;
  energyKwh = e;
  frequencyHz = hz;
  powerFactor = pf;

  electricalDataValid =
    isFiniteValue(v) && isFiniteValue(a) && isFiniteValue(w) &&
    isFiniteValue(e) && isFiniteValue(hz) && isFiniteValue(pf) &&
    v >= 0 && a >= 0 && w >= 0 && e >= 0 &&
    hz >= 0 && pf >= 0 && pf <= 1;

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

  const bool modeChanged = relayConfigValid && next.mode != relayConfig.mode;
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
  } else if (modeChanged) {
    // A mode transition never carries the previous ON state across modes.
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
  if (!ENABLE_LOW_VOLTAGE_RELAY_TEST) {
    lastProcessedCommandDetail += "; output fisik dikunci untuk pengujian komunikasi.";
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
    return true; // Treat missing measurements as a blocking condition.
  }

  auto addReason = [&](const char* label) {
    if (reason.length()) reason += "+";
    reason += label;
  };
  if (relayConfig.alarmVoltageMinEnabled && voltageV < relayConfig.minVoltageV) addReason("VOLTAGE_LOW");
  if (relayConfig.alarmVoltageMaxEnabled && voltageV > relayConfig.maxVoltageV) addReason("VOLTAGE_HIGH");
  if (relayConfig.alarmCurrentMaxEnabled && currentA > relayConfig.maxCurrentA) addReason("CURRENT_HIGH");
  if (relayConfig.alarmPowerMaxEnabled && powerW > relayConfig.maxPowerW) addReason("POWER_HIGH");
  if (relayConfig.alarmFrequencyMinEnabled && frequencyHz < relayConfig.minFrequencyHz) addReason("FREQUENCY_LOW");
  if (relayConfig.alarmFrequencyMaxEnabled && frequencyHz > relayConfig.maxFrequencyHz) addReason("FREQUENCY_HIGH");
  if (relayConfig.alarmPowerFactorMinEnabled && powerFactor < relayConfig.minPowerFactor) addReason("POWER_FACTOR_LOW");
  if (relayConfig.alarmTemperatureMaxEnabled && temperatureC > relayConfig.maxTemperatureC) addReason("TEMPERATURE_HIGH");
  if (relayConfig.alarmHumidityMinEnabled && humidityPct < relayConfig.minHumidityPct) addReason("HUMIDITY_LOW");
  if (relayConfig.alarmHumidityMaxEnabled && humidityPct > relayConfig.maxHumidityPct) addReason("HUMIDITY_HIGH");
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
  switch (lcdPage) {
    case 0:
      printLcdLine(0, electricalDataValid
        ? "V:" + String(voltageV, 2) + " A:" + String(currentA, 2)
        : "V:-- A:--");
      printLcdLine(1, electricalDataValid
        ? "P:" + String(powerW, 1) + "W PF:" + String(powerFactor, 2)
        : "P:-- PF:--");
      break;

    case 1:
      printLcdLine(0, electricalDataValid
        ? "Freq:" + String(frequencyHz, 2) + "Hz"
        : "Freq:--");
      printLcdLine(1, electricalDataValid
        ? "E:" + String(energyKwh, 3) + " kWh"
        : "E:-- kWh");
      break;

    case 2: {
      // Menggunakan konsumsi energi untuk periode tagihan, bukan counter kumulatif PZEM.
      const float costRp = BILLING_PERIOD_ENERGY_KWH * DEFAULT_TARIFF_RP_PER_KWH;
      printLcdLine(0, "Energi:" + String(BILLING_PERIOD_ENERGY_KWH, 2) + "kWh");
      printLcdLine(1, "Biaya:Rp" + String((unsigned long)(costRp + 0.5f)));
      break;
    }

    case 3:
      printLcdLine(0, temperatureDataValid
        ? "Suhu:" + String(temperatureC, 2) + " C"
        : "Suhu: --");
      printLcdLine(1, temperatureDataValid
        ? "Kelembapan:" + String(humidityPct, 2) + "%"
        : "Kelembapan: --");
      break;

    case 4:
      printLcdLine(0, WiFi.status() == WL_CONNECTED
        ? "Wi-Fi: Online" : "Wi-Fi: Offline");
      printLcdLine(1, "Status: " + lcdStatusText());
      break;

    default:
      printLcdLine(0, "Mode: " + relayConfig.mode);
      printLcdLine(1, "Relay: " + String(relayActualOn ? "ON" : "OFF"));
      break;
  }
  lcdPage = (lcdPage + 1) % 6;
}

// ---------------- SETUP / LOOP ----------------
void setup() {
  Serial.begin(115200);
  delay(150);
  safeRelayStartup();

  PZEMSerial.begin(9600, SERIAL_8N1, 16, 17);
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
