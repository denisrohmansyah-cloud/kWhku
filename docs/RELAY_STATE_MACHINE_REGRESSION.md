# Regression Test Report — kWh-Ku Relay State Machine

Branch: `improve/algorithm-phase-1`  
Tanggal: 24 November 2026

## Implemented behavior

- MANUAL ON remains blocked by invalid sensor data or any selected interlock alarm.
- A MANUAL trip clears the previous ON request; a new ON request is required after the condition has recovered through its hysteresis band.
- AUTO trip remains latched.
- AUTO with automatic recovery waits until every selected alarm has recovered and the configured stable interval has elapsed.
- AUTO with manual recovery remains OFF until an explicit reset command is accepted by ESP32.
- Manual AUTO reset is available only when the saved configuration is AUTO + manual recovery, the device is fresh, the trip is latched, all selected measurements are valid/normal, and the stable interval has elapsed.
- Any change to relay enable/mode, selected alarm flags, thresholds, or recovery policy forces OFF and restarts the stability interval.
- Relay interlock flags are synchronized both ways with the corresponding Telegram alarm flags when either settings page is saved. The Telegram master switch remains independent and does not disable local relay interlocks.
- Telegram and relay use the same abnormal and recovery comparisons, including temperature trigger `>` max and recovery `<= max - 1 °C`.

## Regression checks executed

| Test | Result |
|---|---|
| Apps Script `Code.gs` JavaScript syntax via parser | PASS |
| Dashboard `app.js` JavaScript syntax via parser | PASS |
| Firmware source brace balance | PASS |
| Alarm latch: trigger below threshold, remain latched inside hysteresis band, clear at recovery threshold | PASS |
| Manual reset rejected while any alarm is abnormal | PASS |
| Manual reset rejected before stable interval | PASS |
| Manual reset rejected when automatic recovery is enabled | PASS |
| Manual reset accepted only for AUTO/manual-recovery/tripped/stable/normal state | PASS |
| Relay ACK matching requested state | PASS |
| Relay ACK mismatch rejected and marked FAILED | PASS |
| Static source checks for server/UI/firmware reset handshake | PASS |
| Static source checks for bidirectional alarm-flag synchronization | PASS |
| Static source check for Telegram temperature trigger parity | PASS |

## Not executed / requires target environment

- Firmware compile with the exact ESP32 Arduino core and installed library versions.
- Upload/flash to the actual ESP32.
- Physical relay test and verification of real output state.
- Live Google Apps Script execution against the production spreadsheet.
- Live Telegram delivery and recovery notification.
- End-to-end dashboard-to-ESP32 AUTO reset test.

## Safety and rollout notes

- Changes remain on the feature branch; `main` is not modified by this work.
- Do not deploy Apps Script or flash firmware until the firmware is compiled and the reset/interlock scenarios are reviewed.
- Do not merge based only on static checks. Confirm reset rejection and accepted reset with the physical ESP32 while observing actual output and logs.
- The firmware starts OFF and re-enters OFF whenever a relay safety configuration changes.
