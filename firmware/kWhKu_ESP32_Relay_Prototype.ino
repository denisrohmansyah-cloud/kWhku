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
static const char* APPS_SCRIPT_URL = "https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec";
static const char* DEVICE_API_KEY = "YOUR_DEVICE_API_KEY";
static const char* CUSTOMER_ID = "PLG-001";
static const char* DEVICE_ID = "ESP32-001";

static const float DEFAULT_TARIFF_RP_PER_KWH = 605.0f; // Display/reference only
static const bool RELAY_ACTIVE_LOW = true;             // Verify with LOW-VOLTAGE test
static const bool ENABLE_LOW_VOLTAGE_RELAY_TEST = false; // Default locked: do not actuate a mains-connected relay
static const uint8_t RELAY_PIN = 25;
static const uint8_t DHT_PIN = 4;
static const uint8_t DHT_TYPE = DHT11;
static const uint8_t LCD_ADDRESS = 0x27;               // Change to 0x3F if scanner finds 0x3F

static const uint32_t SENSOR_INTERVAL_MS = 2500;
static const uint32_t READING_UPLOAD_INTERVAL_MS = 60000;
static const uint32_t RELAY_POLL_INTERVAL_MS = 5000;
static const uint32_t RELAY_HEARTBEAT_INTERVAL_MS = 30000;
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

void connectWiFiNonBlocking() {
  if (WiFi.status() == WL_CONNECTED) return;
  const uint32_t now = millis();
  if (now - lastWifiAttemptMs < WIFI_RETRY_INTERVAL_MS) return;
  lastWifiAttemptMs = now;
  Serial.println("[WiFi] Mencoba koneksi...");
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

bool postJson(const String& payload, String& response) {
  if (WiFi.status() != WL_CONNECTED) return false;
  HTTPClient http;
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);

  if (!http.begin(APPS_SCRIPT_URL)) {
    Serial.println("[HTTP] URL tidak dapat dibuka.");
    return false;
  }

  http.addHeader("Content-Type", "application/json");
  const int statusCode = http.POST(payload);
  if (statusCode > 0) response = http.getString();
  else Serial.printf("[HTTP] POST gagal: %s\n", http.errorToString(statusCode).c_str());
  http.end();
  if (statusCode < 200 || statusCode >= 300) return false;
  if (response.length()) {
    DynamicJsonDocument responseDoc(2048);
    if (deserializeJson(responseDoc, response) == DeserializationError::Ok &&
        responseDoc.containsKey("ok") && !(responseDoc["ok"] | false)) return false;
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

  if (!relayConfig.enabled || (relayConfig.mode != "MANUAL" && relayConfig.mode != "AUTO")) {
    autoTripLatched = true;
    normalSinceMs = 0;
    setRelayOutput(false, "RELAY_DISABLED_OR_INVALID_MODE");
  } else if (modeChanged) {
    // A mode transition never carries the previous ON state across modes.
    autoTripLatched = true;
    normalSinceMs = 0;
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

  if (!ENABLE_LOW_VOLTAGE_RELAY_TEST) {
    setRelayOutput(false, "ACTUATION_LOCKED_LOW_VOLTAGE_TEST_ONLY");
    lastProcessedCommandDetail = "Output relay dikunci pada firmware; sinkronisasi status tetap aktif.";
    acknowledgeRelayCommand(id, lastProcessedCommandDetail);
    return;
  }

  if (desired == "OFF") {
    setRelayOutput(false, "WEBSITE_MANUAL_OFF");
    lastProcessedCommandDetail = relayReason;
    acknowledgeRelayCommand(id, lastProcessedCommandDetail);
    return;
  }

  if (!relayConfigValid || !relayConfig.enabled || relayConfig.mode != "MANUAL" || mode != "MANUAL") {
    setRelayOutput(false, "MANUAL_COMMAND_REJECTED_SAFE_OFF");
    lastProcessedCommandDetail = "Ditolak: relay tidak aktif atau mode bukan MANUAL.";
    acknowledgeRelayCommand(id, lastProcessedCommandDetail);
    return;
  }

  const bool dhtSelected = relayConfig.alarmTemperatureMaxEnabled ||
    relayConfig.alarmHumidityMinEnabled || relayConfig.alarmHumidityMaxEnabled;
  if (desired != "ON" || !electricalDataValid || (dhtSelected && !temperatureDataValid)) {
    setRelayOutput(false, "SENSOR_INVALID_OR_INVALID_COMMAND_SAFE_OFF");
    lastProcessedCommandDetail = "Ditolak: perintah tidak valid atau data sensor tidak valid.";
    acknowledgeRelayCommand(id, lastProcessedCommandDetail);
    return;
  }

  setRelayOutput(true, "WEBSITE_MANUAL_ON");
  lastProcessedCommandDetail = relayReason;
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
void evaluateAutomaticRelay() {
  if (!ENABLE_LOW_VOLTAGE_RELAY_TEST) {
    setRelayOutput(false, "ACTUATION_LOCKED_LOW_VOLTAGE_TEST_ONLY");
    return;
  }
  if (!relayConfigValid || !relayConfig.enabled) {
    setRelayOutput(false, "RELAY_DISABLED");
    return;
  }
  if (relayConfig.mode != "AUTO") return;

  const bool dhtSelected = relayConfig.alarmTemperatureMaxEnabled ||
    relayConfig.alarmHumidityMinEnabled || relayConfig.alarmHumidityMaxEnabled;
  if (!electricalDataValid || (dhtSelected && !temperatureDataValid)) {
    autoTripLatched = true;
    normalSinceMs = 0;
    setRelayOutput(false, "SENSOR_INVALID_SAFE_OFF");
    return;
  }

  bool alarmActive = false;
  String reason = "";
  auto addReason = [&](const char* label) {
    if (reason.length()) reason += "+";
    reason += label;
    alarmActive = true;
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

  if (alarmActive) {
    autoTripLatched = true;
    normalSinceMs = 0;
    setRelayOutput(false, reason);
    return;
  }

  // The full selected alarm set must remain normal continuously before recovery.
  if (normalSinceMs == 0) normalSinceMs = millis();
  const uint32_t stableMs = (uint32_t)relayConfig.recoverStableSeconds * 1000UL;
  const bool stable = (millis() - normalSinceMs) >= stableMs;

  if (autoTripLatched) {
    if (relayConfig.autoRecover && stable) {
      setRelayOutput(true, "AUTO_RECOVERY_AFTER_STABLE");
      autoTripLatched = false;
    }
  } else if (!relayActualOn && stable) {
    setRelayOutput(true, "AUTO_NORMAL_STABLE");
  }
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
void updateLcd() {
  lcd.clear();
  if (lcdPage == 0) {
    lcd.setCursor(0, 0);
    lcd.print("V:");
    if (electricalDataValid) lcd.print(voltageV, 1); else lcd.print("--");
    lcd.print(" A:");
    if (electricalDataValid) lcd.print(currentA, 2); else lcd.print("--");
    lcd.setCursor(0, 1);
    lcd.print("P:");
    if (electricalDataValid) lcd.print(powerW, 1); else lcd.print("--");
    lcd.print(" W");
  } else if (lcdPage == 1) {
    lcd.setCursor(0, 0);
    lcd.print("Energy:");
    if (electricalDataValid) lcd.print(energyKwh, 3); else lcd.print("--");
    lcd.print("kWh");
    lcd.setCursor(0, 1);
    lcd.print("PF:");
    if (electricalDataValid) lcd.print(powerFactor, 2); else lcd.print("--");
    lcd.print(" F:");
    if (electricalDataValid) lcd.print(frequencyHz, 1); else lcd.print("--");
  } else {
    lcd.setCursor(0, 0);
    lcd.print("T:");
    if (temperatureDataValid) lcd.print(temperatureC, 1); else lcd.print("--");
    lcd.print("C H:");
    if (temperatureDataValid) lcd.print(humidityPct, 0); else lcd.print("--");
    lcd.print("%");
    lcd.setCursor(0, 1);
    lcd.print(relayConfig.mode);
    lcd.print(" R:");
    lcd.print(relayActualOn ? "ON" : "OFF");
    lcd.print(WiFi.status() == WL_CONNECTED ? " WiFi+" : " WiFi-");
  }
  lcdPage = (lcdPage + 1) % 3;
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
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  lastWifiAttemptMs = millis();
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
